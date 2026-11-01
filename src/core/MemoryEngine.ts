/**
 * MemoryEngine · 三条链路的编排者（仓储层收口版）。
 *
 *   ① saveMemory     对话 → 校验 → 6 小时防重 → SQLite + Markdown 双写
 *   ③ recall         候选 → 打分 → 一轮扩散 → 预算装配
 *   ⑤ sweepLifecycle 活跃 → 冷存 → 墓碑 + 物理删除
 *
 * 事务纪律：
 *   - 所有写操作走 BEGIN IMMEDIATE（先拿写锁，检查-写入原子完成，避免并发双写）；
 *   - 读操作走 deferred 事务，一致快照且不阻塞别的进程写入；
 *   - 事务回调内部只有同步调用（better-sqlite3 + 同步 fs），绝无 await 跨越事务。
 *
 * SQL 已全部收口到 adapters/storage/MemoryRepository，本类只保留领域决策
 * （防重裁决、打分、预算、生命周期状态迁移）。
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import {
  MarkdownArchive,
  NullArchive,
  purgeArchiveMarkdown,
  type MemoryArchive,
} from '../adapters/archive/MarkdownArchive.js';
import { MemoryRepository } from '../adapters/storage/MemoryRepository.js';
import { loadConfig, type ConfigOverrides } from '../config.js';
import { InvalidMemoryError, SystemDriveError } from '../errors.js';
import {
  HALF_LIFE_DAYS,
  MAX_WEIGHT,
  clampIntensity,
  isScope,
  type DedupeVerdict,
  type Iso8601,
  type LifecycleTransition,
  type MemoryDraft,
  type MemoryLogger,
  type MemoryPluginConfig,
  type MemoryRecord,
  type RecallQuery,
  type RecallResult,
  type Scope,
  type ScoredMemory,
} from '../types.js';
import {
  ensureMemoryDirectories,
  printSystemDriveAlert,
  resolveMemoryPaths,
  type MemoryPaths,
} from '../utils/paths.js';
import { DAY_MS, inactiveDays, retainedWeight, shouldGoCold } from './decay.js';
import { evaluateDuplicate, hashContent } from './dedupe.js';
import { initializeSchema, type SqliteDatabase } from './schema.js';
import {
  estimateTokens,
  memoryDigest,
  scoreMemory,
  tokenize,
} from './scoring.js';

export interface Clock {
  now(): Date;
}

const SYSTEM_CLOCK: Clock = { now: () => new Date() };

const SILENT_LOGGER: MemoryLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const requireFromHere = createRequire(import.meta.url);

function openSqliteDatabase(file: string): SqliteDatabase {
  // 延迟到真正需要时才加载原生模块：测试注入 db 时完全不碰 better-sqlite3。
  const Constructor = requireFromHere('better-sqlite3') as new (filename: string) => SqliteDatabase;
  return new Constructor(file);
}

/** 向量适配器的最小契约；bge-small-zh 适配器在后续步骤实现。 */
export interface TextEmbedder {
  readonly model: string;
  readonly dim: number;
  embed(text: string): Promise<Float32Array>;
}

export interface MemoryEngineOptions {
  config?: MemoryPluginConfig;
  overrides?: ConfigOverrides;
  clock?: Clock;
  logger?: MemoryLogger;
  db?: SqliteDatabase;
  openDatabase?: (file: string) => SqliteDatabase;
  archive?: MemoryArchive;
  embedder?: TextEmbedder | null;
}

export interface SaveMemoryResult {
  saved: boolean;
  record: MemoryRecord | null;
  dedupe: DedupeVerdict;
}

export interface SweepReport {
  now: Iso8601;
  scanned: number;
  markedCold: LifecycleTransition[];
  purged: LifecycleTransition[];
}

export interface ReviewResult {
  memoryId: string;
  weightBefore: number;
  weightAfter: number;
}

export interface MergeReport {
  groups: number;
  merged: number;
}

export class MemoryEngine {
  readonly config: MemoryPluginConfig;
  readonly paths: MemoryPaths;
  readonly clock: Clock;

  private readonly db: SqliteDatabase;
  private readonly repo: MemoryRepository;
  private readonly archive: MemoryArchive;
  private readonly logger: MemoryLogger;
  private readonly embedder: TextEmbedder | null;
  private readonly ownsDb: boolean;
  private closed = false;

  constructor(options: MemoryEngineOptions = {}) {
    this.config = options.config ?? loadConfig(options.overrides ?? {});
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.logger = options.logger ?? this.config.logger ?? SILENT_LOGGER;
    this.embedder = options.embedder ?? null;

    // ① 初始化校验：路径是第一个闸门，任何 DB 操作之前就必须通过
    try {
      this.paths = resolveMemoryPaths(this.config.memoryDbPath, this.config.archive.root);
    } catch (error) {
      if (error instanceof SystemDriveError) {
        printSystemDriveAlert(error);
      }
      throw error;
    }

    ensureMemoryDirectories(this.paths);

    const ownsDb = options.db === undefined;
    this.ownsDb = ownsDb;
    this.db = options.db ?? (options.openDatabase ?? openSqliteDatabase)(this.paths.dbFile);

    try {
      initializeSchema(this.db, { now: this.nowIso() });
      this.repo = new MemoryRepository(this.db);
      this.archive =
        options.archive ??
        (this.config.archive.enabled ? new MarkdownArchive(this.paths) : new NullArchive());
    } catch (error) {
      if (ownsDb) {
        try {
          this.db.close();
        } catch {
          // 关闭失败不掩盖初始化错误
        }
      }
      throw error;
    }

    this.logger.info('记忆引擎已就绪', {
      dbFile: this.paths.dbFile,
      archiveRoot: this.paths.archiveRoot,
    });
  }

  /* ══════════════════════════ ① 写进去 ══════════════════════════ */

  /**
   * 写入一条记忆。
   *
   * 防重查询、INSERT、标签写入、Markdown 档案追加全部在同一个
   * BEGIN IMMEDIATE 事务内；任一步抛错都会回滚数据库，档案由 MarkdownArchive
   * 自行回滚已写入的片段。
   */
  async saveMemory(draft: MemoryDraft): Promise<SaveMemoryResult> {
    const now = this.nowIso();
    const record = this.prepareRecord(draft, now);

    return this.immediate(() => {
      const dedupe = this.findDuplicate(record, now);

      if (dedupe.duplicate) {
        this.logger.info('6 小时防重命中，跳过写入', {
          existingId: dedupe.existingId,
          reason: dedupe.reason,
          similarity: dedupe.similarity,
        });
        return { saved: false, record: null, dedupe };
      }

      this.repo.insertMemory(record);
      this.repo.insertTags(record.id, record.tags);
      this.archive.appendMemory(record);

      this.logger.info('记忆已写入', {
        id: record.id,
        scope: record.scope,
        kind: record.kind,
        intensity: record.layers.intensity,
      });

      return { saved: true, record, dedupe };
    });
  }

  private prepareRecord(draft: MemoryDraft, now: Iso8601): MemoryRecord {
    const rawText = draft.rawText.trim();
    if (rawText.length === 0) {
      throw new InvalidMemoryError('rawText 不能为空：原文是连续感的根，必须保存。');
    }

    if (draft.scope === 'self' && draft.scopeRef !== null) {
      throw new InvalidMemoryError('scope=self 不允许提供 scopeRef。');
    }

    const scopeRef = draft.scope === 'self' ? null : (draft.scopeRef ?? '').trim();
    if (draft.scope !== 'self' && scopeRef === '') {
      throw new InvalidMemoryError(`${draft.scope} 必须提供非空 scopeRef（uid / slug）。`);
    }

    const fact = draft.layers.fact.trim();
    if (fact.length === 0) {
      throw new InvalidMemoryError('五层第 1 层 fact 不能为空。');
    }

    return {
      id: randomUUID(),
      scope: draft.scope,
      scopeRef,
      kind: draft.kind,
      rawText,
      layers: {
        fact,
        feltThen: nullable(draft.layers.feltThen),
        intensity: clampIntensity(draft.layers.intensity),
        thoughtThen: nullable(draft.layers.thoughtThen),
        reframe: nullable(draft.layers.reframe),
        recalledLater: nullable(draft.layers.recalledLater),
      },
      summary: nullable(draft.summary ?? null),
      tags: normalizeTags(draft.tags ?? []),
      weight: clampWeight(draft.weight),
      halfLifeDays: HALF_LIFE_DAYS[draft.kind],
      state: 'active',
      stateReason: null,
      isValid: true,
      recallCount: 0,
      reviewCount: 0,
      contentHash: hashContent(rawText),
      source: {
        conversationId: draft.source.conversationId,
        sessionId: draft.source.sessionId,
        turnId: draft.source.turnId,
        speaker: draft.source.speaker,
      },
      occurredAt: normalizeIso(draft.occurredAt, now),
      createdAt: now,
      updatedAt: now,
      lastRecalledAt: null,
      lastReviewedAt: null,
      sealedAt: null,
      coldAt: null,
      archivedAt: null,
    };
  }

  private findDuplicate(record: MemoryRecord, now: Iso8601): DedupeVerdict {
    const windowStart = new Date(
      Date.parse(now) - this.config.dedupe.windowMs,
    ).toISOString();

    const candidates = this.repo.findDedupeCandidates(
      record.scope,
      record.scopeRef,
      windowStart,
      this.config.dedupe.includeSealed,
    );
    const tombstoneId = this.repo.findTombstoneSince(record.contentHash, windowStart);

    return evaluateDuplicate({
      rawText: record.rawText,
      contentHash: record.contentHash,
      candidates,
      tombstoneId,
      threshold: this.config.dedupe.similarityThreshold,
    });
  }

  /* ══════════════════════════ ③ 用起来 ══════════════════════════ */

  /**
   * 注入成功后由 injector 调用：被想起次数 +1，并刷新半衰期起点。
   * 刻意不放进 recall()：检索结果可能被预算丢弃或上游取消，不能平白续命。
   */
  async markRecalled(memoryIds: readonly string[], nowInput?: Iso8601): Promise<number> {
    const ids = [...new Set(memoryIds)];
    if (ids.length === 0) return 0;

    const now = nowInput ?? this.nowIso();
    return this.immediate(() => this.repo.markRecalled(ids, now));
  }

  /**
   * 检索并装配。items 已按预算整块装入（放不下整条跳过，不截断）。
   */
  async recall(query: RecallQuery): Promise<RecallResult> {
    const startedAt = Date.now();
    const now = query.now ?? this.nowIso();
    const text = (query.text ?? '').trim();

    if (!isScope(query.scope)) {
      throw new InvalidMemoryError(`非法 scope：${String(query.scope)}`);
    }

    const scopeRef = query.scope === 'self' ? null : (query.scopeRef ?? '').trim();
    if (query.scope !== 'self' && scopeRef === '') {
      throw new InvalidMemoryError(`${query.scope} 检索必须提供 scopeRef。`);
    }

    const queryTokens = new Set(tokenize(text));
    const embedder = this.embedder;
    const queryVector =
      embedder !== null && text.length > 0 ? await embedder.embed(text) : null;

    const candidates = this.read(() =>
      this.repo.findCandidates(query.scope, scopeRef, query.includeSealed === true),
    );

    const vectors =
      queryVector !== null && embedder !== null
        ? this.read(() =>
            this.repo.loadVectors(
              candidates.map((memory) => memory.id),
              embedder.model,
            ),
          )
        : new Map<string, Float32Array>();

    const minScore =
      query.minScore === undefined
        ? this.config.retrieval.minScore
        : Math.max(0, Math.min(1, query.minScore));
    const scored: ScoredMemory[] = [];

    for (const memory of candidates) {
      const item = scoreMemory({
        memory,
        queryText: text,
        queryTokens,
        now,
        queryVector,
        memoryVector: vectors.get(memory.id) ?? null,
      });

      if (item.semantic <= 0 || item.score < minScore) continue;
      scored.push(item);
    }

    scored.sort((left, right) => right.score - left.score);

    const topK = clampInt(query.topK ?? this.config.retrieval.topK, 1, 50);
    const top = scored.slice(0, topK);
    const expanded = this.expand(top, query.scope, scopeRef, queryTokens, text, now);
    // tag 版一轮扩散：高权重命中后，顺标签捞出 1-2 条旧事补齐「潜意识」。
    const tagExpanded = this.expandByTag(top, query.scope, scopeRef, now, minScore);
    const merged = this.mergeScored([...top, ...expanded, ...tagExpanded]).sort(
      (left, right) => right.score - left.score,
    );

    const budget = clampInt(
      query.budgetTokens ?? this.config.retrieval.budgetTokens,
      50,
      50_000,
    );

    let estimatedTokens = 0;
    let skippedForBudget = 0;
    const items: ScoredMemory[] = [];

    for (const item of merged) {
      const cost = estimateTokens(memoryDigest(item.memory)) + 8;
      if (estimatedTokens + cost > budget) {
        skippedForBudget += 1;
        continue;
      }
      items.push(item);
      estimatedTokens += cost;
    }

    return {
      query: text,
      scope: query.scope,
      scopeRef,
      items,
      candidates: candidates.length,
      elapsedMs: Date.now() - startedAt,
      estimatedTokens,
      skippedForBudget,
    };
  }

  /**
   * 图③「一轮扩散」：顺着互链把相关旧事带出来。
   * 传播分 = 父项分数 × 边强度 × expandFactor，只扩散一层。
   */
  private expand(
    top: readonly ScoredMemory[],
    scope: Scope,
    scopeRef: string | null,
    queryTokens: ReadonlySet<string>,
    queryText: string,
    now: Iso8601,
  ): ScoredMemory[] {
    const { expandHops, expandFactor, maxExpanded } = this.config.retrieval;
    if (expandHops === 0 || maxExpanded === 0 || top.length === 0) return [];

    const parentById = new Map(top.map((item) => [item.memory.id, item]));
    const sourceIds = [...parentById.keys()];
    const placeholders = sourceIds.map(() => '?').join(', ');

    const links = this.read(
      () =>
        this.db
          .prepare(
            `SELECT from_id, to_id, strength FROM memory_links
              WHERE from_id IN (${placeholders})
              ORDER BY strength DESC
              LIMIT 40`,
          )
          .all(...sourceIds) as Array<{
          from_id: string;
          to_id: string;
          strength: number;
        }>,
    );

    const linkByTarget = new Map<string, { fromId: string; strength: number }>();
    for (const link of links) {
      if (parentById.has(link.to_id)) continue;
      if (!linkByTarget.has(link.to_id)) {
        linkByTarget.set(link.to_id, { fromId: link.from_id, strength: link.strength });
      }
    }

    const targets = [...linkByTarget.keys()];
    if (targets.length === 0) return [];

    const targetRecords = this.read(() => this.repo.findByIds(targets));
    const expanded: ScoredMemory[] = [];

    for (const memory of targetRecords) {
      if (!this.isVisible(memory, scope, scopeRef)) continue;

      const link = linkByTarget.get(memory.id);
      if (!link) continue;

      const parent = parentById.get(link.fromId);
      if (!parent) continue;

      const own = scoreMemory({
        memory,
        queryText,
        queryTokens,
        now,
        queryVector: null,
        memoryVector: null,
      });

      const propagated = parent.score * link.strength * expandFactor;
      const score = Math.max(own.score, propagated);
      if (score < this.config.retrieval.minScore) continue;

      expanded.push({
        memory,
        score,
        semantic: Math.max(own.semantic, Math.min(1, parent.semantic * link.strength)),
        decayedWeight: own.decayedWeight,
        emotion: own.emotion,
        matchedBy: 'link',
        hops: 1,
      });
    }

    expanded.sort((left, right) => right.score - left.score);
    return expanded.slice(0, maxExpanded);
  }

  /**
   * 图③「一轮扩散」的 tag 版。
   *
   * 互链（memory_links）平时很稀疏，光靠它「一轮扩散」基本不会触发。
   * 这里补一条更稳的路径：命中高权重记忆后，用它身上的标签顺藤摸瓜
   * 捞出最多 2 条旧事，传播分 = 父项分数 × expandFactor。
   */
  private expandByTag(
    top: readonly ScoredMemory[],
    scope: Scope,
    scopeRef: string | null,
    now: Iso8601,
    minScore: number,
  ): ScoredMemory[] {
    const { expandHops, expandFactor, maxExpanded } = this.config.retrieval;
    const best = top[0];
    if (expandHops === 0 || maxExpanded === 0 || best === undefined) return [];

    // 只在「命中的是高权重记忆」时扩散，避免打个招呼就带出一堆旧账。
    if (best.score < 1) return [];

    const limit = Math.min(2, maxExpanded);
    const seen = new Set(top.map((item) => item.memory.id));
    const result: ScoredMemory[] = [];

    for (const parent of top) {
      if (result.length >= limit) break;

      for (const tag of parent.memory.tags) {
        if (result.length >= limit) break;

        const rows = this.read(() => this.repo.findByTag(tag, scope, scopeRef, 3));

        for (const memory of rows) {
          if (result.length >= limit) break;
          if (seen.has(memory.id)) continue;
          if (!this.isVisible(memory, scope, scopeRef)) continue;

          seen.add(memory.id);

          const own = scoreMemory({
            memory,
            queryText: '',
            queryTokens: new Set<string>(),
            now,
            queryVector: null,
            memoryVector: null,
          });

          const score = Math.max(own.score, parent.score * expandFactor);
          if (score < minScore) continue;

          result.push({
            memory,
            score,
            semantic: Math.max(own.semantic, 0.5),
            decayedWeight: own.decayedWeight,
            emotion: own.emotion,
            matchedBy: 'tag',
            hops: 1,
          });
        }
      }
    }

    result.sort((left, right) => right.score - left.score);
    return result;
  }

  private isVisible(memory: MemoryRecord, scope: Scope, scopeRef: string | null): boolean {
    if (memory.scope === 'self') return true;
    return memory.scope === scope && (memory.scopeRef ?? '') === (scopeRef ?? '');
  }

  private mergeScored(items: readonly ScoredMemory[]): ScoredMemory[] {
    const byId = new Map<string, ScoredMemory>();
    for (const item of items) {
      const existing = byId.get(item.memory.id);
      if (!existing || item.score > existing.score) {
        byId.set(item.memory.id, item);
      }
    }
    return [...byId.values()];
  }

  /* ══════════════════════════ ⑤ 允许忘 ══════════════════════════ */

  /**
   * 物理清空：先清 Markdown 明文，再删库。
   *
   * 顺序很重要——档案删除失败时数据库还完整，用户至少能看到「清空失败」；
   * 反过来就会出现「库里没了、md 里还能看到明文」的假删除隐私事故。
   *
   * 档案只清带 `apm:id=` 标记的插件内容，绝不批量删除用户自建 .md。
   */
  purgeAllData(): { deletedRows: number; purgedArchiveFiles: number } {
    const purgedArchiveFiles = purgeArchiveMarkdown(this.paths.archiveRoot);
    const deletedRows = this.repo.countAll();
    this.repo.clearAllMemoryData();
    return { deletedRows, purgedArchiveFiles };
  }

  /**
   * 生命周期扫描：活跃 → 冷存 → 物理删除（写墓碑）。
   * 全部在一个 BEGIN IMMEDIATE 事务内完成。
   */
  async sweepLifecycle(nowInput?: Iso8601): Promise<SweepReport> {
    const now = nowInput ?? this.nowIso();

    return this.immediate(() => {
      const active = this.repo.findActive();
      const markedCold: LifecycleTransition[] = [];

      for (const memory of active) {
        if (!shouldGoCold(memory, now, this.config.lifecycle)) continue;

        const weight = retainedWeight(memory, now);
        const idle = inactiveDays(memory, now);
        const reason =
          `冷存：${idle.toFixed(0)} 天未被想起，` +
          `衰减权重 ${weight.toFixed(2)} < ${this.config.lifecycle.coldRetentionThreshold}`;

        this.repo.markCold(memory.id, now, reason);
        markedCold.push({ memoryId: memory.id, from: 'active', to: 'cold', reason, at: now });
      }

      const cutoff = new Date(
        Date.parse(now) - this.config.lifecycle.purgeAfterDays * DAY_MS,
      ).toISOString();

      const cold = this.repo.findColdBefore(cutoff);
      const purged: LifecycleTransition[] = [];

      for (const memory of cold) {
        const ageDays = Math.max(
          0,
          Math.floor((Date.parse(now) - Date.parse(memory.createdAt)) / DAY_MS),
        );

        this.repo.insertTombstone({
          id: memory.id,
          contentHash: memory.contentHash,
          scope: memory.scope,
          scopeRef: memory.scopeRef,
          kind: memory.kind,
          deletedAt: now,
          reason: 'lifecycle_purge',
          ageDays,
        });
        this.archive.removeMemory(memory);
        this.repo.deleteMemory(memory.id);

        purged.push({
          memoryId: memory.id,
          from: 'cold',
          to: 'deleted',
          reason: `冷存满 ${this.config.lifecycle.purgeAfterDays} 天，物理删除`,
          at: now,
        });
      }

      this.logger.info('生命周期扫描完成', {
        scanned: active.length,
        markedCold: markedCold.length,
        purged: purged.length,
      });

      return { now, scanned: active.length, markedCold, purged };
    });
  }

  /* ══════════════════════════ ④ 自己维护 ══════════════════════════ */

  /**
   * 图④「00:00 复习 3 条」的默认实现：数字核对 ×1.6。
   * 「用自己的话复述」交给上层 LLM 回调；这里只负责权重与账本，保证可复算。
   */
  async reviewMemories(limit = 3, nowInput?: Iso8601): Promise<ReviewResult[]> {
    const now = nowInput ?? this.nowIso();

    return this.immediate(() => {
      const candidates = this.repo.findReviewCandidates(clampInt(limit, 1, 10));
      const reviews: ReviewResult[] = [];

      for (const memory of candidates) {
        const weightBefore = memory.weight;
        const weightAfter = Math.min(MAX_WEIGHT, weightBefore * 1.6);

        this.repo.applyReview(memory.id, now, weightAfter);
        this.repo.insertReviewLog({
          memoryId: memory.id,
          reviewedAt: now,
          method: 'number_check',
          weightBefore,
          weightAfter,
          note: 'nightly review ×1.6',
        });

        reviews.push({ memoryId: memory.id, weightBefore, weightAfter });
      }

      return reviews;
    });
  }

  /**
   * 图④「23:00 合并重复」的保守实现：只合并 content_hash 完全相同的活跃记忆
   * （同 scope / 同 scope_ref），保留最早一条，标签并集后删除其余。
   * 语义改写级合并需要 LLM，交给维护任务的注入回调。
   */
  async mergeExactDuplicates(limit = 20): Promise<MergeReport> {
    const now = this.nowIso();

    return this.immediate(() => {
      const groups = this.repo.findDuplicateGroups(clampInt(limit, 1, 100));
      let merged = 0;

      for (const group of groups) {
        const records = this.repo.findDuplicatesByHash(
          group.scope,
          group.scopeRef,
          group.contentHash,
        );
        if (records.length < 2) continue;

        const survivor = records[0];
        if (!survivor) continue;

        const mergedIds: string[] = [];
        for (const duplicate of records.slice(1)) {
          this.repo.insertTags(survivor.id, duplicate.tags);
          this.repo.deleteMemory(duplicate.id);
          mergedIds.push(duplicate.id);
          merged += 1;
        }

        if (mergedIds.length > 0) {
          this.repo.insertMergeLog({
            survivorId: survivor.id,
            mergedIds,
            createdAt: now,
            note: 'exact content_hash merge',
          });
        }
      }

      return { groups: groups.length, merged };
    });
  }

  /* ══════════════════════════ 基础设施 ══════════════════════════ */

  getMemory(id: string): MemoryRecord | null {
    return this.read(() => this.repo.getMemory(id));
  }

  /** 供 WorldContextBuilder / CLI 等只读消费，写入仍必须走引擎方法。 */
  get repository(): MemoryRepository {
    return this.repo;
  }

  /** 各生命状态的条数，CLI / doctor 用。 */
  stats(): Record<string, number> {
    return this.read(() => this.repo.countByState());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDb) this.db.close();
  }

  private nowIso(): Iso8601 {
    return this.clock.now().toISOString();
  }

  /** 写事务：BEGIN IMMEDIATE，先拿写锁再检查，避免并发下双写同一条。 */
  private immediate<T>(work: () => T): T {
    const transaction = this.db.transaction(work);
    return transaction.immediate();
  }

  /** 读事务：deferred 快照，不阻塞别的进程写入。 */
  private read<T>(work: () => T): T {
    const transaction = this.db.transaction(work);
    return transaction.deferred();
  }
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

function nullable(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeIso(value: string | undefined, fallback: Iso8601): Iso8601 {
  if (value === undefined) return fallback;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

function clampWeight(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.min(MAX_WEIGHT, Math.max(0.05, value));
}

function normalizeTags(tags: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const tag of tags) {
    const normalized = tag.trim().replace(/^#+/, '').trim();
    if (normalized.length === 0 || normalized.length > 32) continue;
    unique.add(normalized);
    if (unique.size >= 8) break;
  }
  return [...unique];
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
