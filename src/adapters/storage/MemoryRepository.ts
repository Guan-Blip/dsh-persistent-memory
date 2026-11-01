/**
 * 仓储层：所有 SQL 只在这里出现，MemoryEngine 只负责编排。
 *
 * 约定：
 *   - 本类不自己开事务；调用方（引擎）通过 BEGIN IMMEDIATE / deferred 决定边界；
 *   - 读方法返回领域对象（MemoryRecord），自动补齐 tags；
 *   - scope 可见性规则：self 向所有线共享；mask / project 只见自己这条线。
 */

import type {
  Iso8601,
  LifecycleState,
  MemoryKind,
  MemoryRecord,
  Scope,
  Speaker,
  TombstoneReason,
} from '../../types.js';
import type { SqliteDatabase } from '../../core/schema.js';

interface MemoryRow {
  id: string;
  scope: string;
  scope_ref: string | null;
  kind: string;
  fact: string;
  felt_then: string | null;
  intensity: number;
  thought_then: string | null;
  reframe: string | null;
  recalled_later: string | null;
  raw_text: string;
  summary: string | null;
  weight: number;
  half_life_days: number;
  state: string;
  state_reason: string | null;
  is_valid: number;
  recall_count: number;
  review_count: number;
  content_hash: string;
  conversation_id: string;
  session_id: string;
  turn_id: string;
  speaker: string;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  last_recalled_at: string | null;
  last_reviewed_at: string | null;
  sealed_at: string | null;
  cold_at: string | null;
  archived_at: string | null;
}

export interface DedupeRow {
  id: string;
  rawText: string;
  contentHash: string;
}

export interface TombstoneInsert {
  id: string;
  contentHash: string;
  scope: Scope;
  scopeRef: string | null;
  kind: MemoryKind;
  deletedAt: Iso8601;
  reason: TombstoneReason;
  ageDays: number;
}

export interface ReviewLogInsert {
  memoryId: string;
  reviewedAt: Iso8601;
  method: 'nightly_recall' | 'number_check' | 'manual';
  weightBefore: number;
  weightAfter: number;
  note: string | null;
}

export interface MergeLogInsert {
  survivorId: string;
  mergedIds: readonly string[];
  createdAt: Iso8601;
  note: string | null;
}

export interface DuplicateGroup {
  contentHash: string;
  scope: Scope;
  scopeRef: string | null;
}

export interface MaintenanceRunInsert {
  id: string;
  job: string;
  scheduledFor: Iso8601;
  startedAt: Iso8601;
}

export type MaintenanceStatus = 'running' | 'succeeded' | 'failed' | 'skipped';

const INSERT_MEMORY_SQL = `
INSERT INTO memories (
  id, scope, scope_ref, kind,
  fact, felt_then, intensity, thought_then, reframe, recalled_later,
  raw_text, summary, weight, half_life_days,
  state, state_reason, is_valid, recall_count, review_count,
  content_hash, conversation_id, session_id, turn_id, speaker,
  occurred_at, created_at, updated_at,
  last_recalled_at, last_reviewed_at, sealed_at, cold_at, archived_at
) VALUES (
  ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?,
  ?, ?, ?, ?, ?
)`;

export class MemoryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /* ─────────────────────────── 写入 ─────────────────────────── */

  insertMemory(record: MemoryRecord): void {
    this.db
      .prepare(INSERT_MEMORY_SQL)
      .run(
        record.id,
        record.scope,
        record.scopeRef,
        record.kind,
        record.layers.fact,
        record.layers.feltThen,
        record.layers.intensity,
        record.layers.thoughtThen,
        record.layers.reframe,
        record.layers.recalledLater,
        record.rawText,
        record.summary,
        record.weight,
        record.halfLifeDays,
        record.state,
        record.stateReason,
        record.isValid ? 1 : 0,
        record.recallCount,
        record.reviewCount,
        record.contentHash,
        record.source.conversationId,
        record.source.sessionId,
        record.source.turnId,
        record.source.speaker,
        record.occurredAt,
        record.createdAt,
        record.updatedAt,
        record.lastRecalledAt,
        record.lastReviewedAt,
        record.sealedAt,
        record.coldAt,
        record.archivedAt,
      );
  }

  insertTags(memoryId: string, tags: readonly string[]): void {
    if (tags.length === 0) return;

    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)`,
    );
    for (const tag of tags) {
      statement.run(memoryId, tag);
    }
  }

  insertTombstone(tombstone: TombstoneInsert): void {
    this.db
      .prepare(
        `INSERT INTO memory_tombstones
           (id, content_hash, scope, scope_ref, kind, deleted_at, reason, age_days)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tombstone.id,
        tombstone.contentHash,
        tombstone.scope,
        tombstone.scopeRef,
        tombstone.kind,
        tombstone.deletedAt,
        tombstone.reason,
        tombstone.ageDays,
      );
  }

  markCold(memoryId: string, now: Iso8601, reason: string): void {
    this.db
      .prepare(
        `UPDATE memories
            SET state = 'cold', cold_at = ?, state_reason = ?, updated_at = ?
          WHERE id = ? AND state = 'active'`,
      )
      .run(now, reason, now, memoryId);
  }

  /* ─────────────────────────── 复习 / 合并 / 任务账本 ─────────────────────────── */

  findReviewCandidates(limit: number): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
          WHERE state = 'active' AND is_valid = 1
          ORDER BY RANDOM()
          LIMIT ?`,
      )
      .all(limit) as MemoryRow[];

    return this.hydrate(rows);
  }

  applyReview(memoryId: string, now: Iso8601, weightAfter: number): void {
    this.db
      .prepare(
        `UPDATE memories
            SET weight = ?,
                review_count = review_count + 1,
                last_reviewed_at = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(weightAfter, now, now, memoryId);
  }

  insertReviewLog(entry: ReviewLogInsert): void {
    this.db
      .prepare(
        `INSERT INTO review_log
           (memory_id, reviewed_at, method, weight_before, weight_after, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.memoryId,
        entry.reviewedAt,
        entry.method,
        entry.weightBefore,
        entry.weightAfter,
        entry.note,
      );
  }

  findDuplicateGroups(limit: number): DuplicateGroup[] {
    const rows = this.db
      .prepare(
        `SELECT content_hash, scope, ifnull(scope_ref, '') AS scope_ref_key
           FROM memories
          WHERE state = 'active'
          GROUP BY content_hash, scope, ifnull(scope_ref, '')
         HAVING count(*) > 1
          LIMIT ?`,
      )
      .all(limit) as Array<{ content_hash: string; scope: string; scope_ref_key: string }>;

    return rows.map((row) => ({
      contentHash: row.content_hash,
      scope: row.scope as Scope,
      scopeRef: row.scope_ref_key === '' ? null : row.scope_ref_key,
    }));
  }

  findDuplicatesByHash(
    scope: Scope,
    scopeRef: string | null,
    contentHash: string,
    limit = 10,
  ): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
          WHERE state = 'active'
            AND scope = ?
            AND ifnull(scope_ref, '') = ifnull(?, '')
            AND content_hash = ?
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .all(scope, scopeRef, contentHash, limit) as MemoryRow[];

    return this.hydrate(rows);
  }

  insertMergeLog(entry: MergeLogInsert): void {
    this.db
      .prepare(
        `INSERT INTO merge_log (survivor_id, merged_ids_json, created_at, note)
         VALUES (?, ?, ?, ?)`,
      )
      .run(entry.survivorId, JSON.stringify(entry.mergedIds), entry.createdAt, entry.note);
  }

  /** 幂等占位：UNIQUE(job, scheduled_for) 冲突时返回 false（该档期已经跑过）。 */
  beginMaintenanceRun(run: MaintenanceRunInsert): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO maintenance_runs
           (id, job, scheduled_for, started_at, status)
         VALUES (?, ?, ?, ?, 'running')`,
      )
      .run(run.id, run.job, run.scheduledFor, run.startedAt);

    return result.changes > 0;
  }

  finishMaintenanceRun(
    id: string,
    status: MaintenanceStatus,
    finishedAt: Iso8601,
    statsJson: string | null,
    error: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE maintenance_runs
            SET status = ?, finished_at = ?, stats_json = ?, error = ?
          WHERE id = ?`,
      )
      .run(status, finishedAt, statsJson, error, id);
  }

  markRecalled(memoryIds: readonly string[], now: Iso8601): number {
    if (memoryIds.length === 0) return 0;

    const statement = this.db.prepare(
      `UPDATE memories
          SET recall_count = recall_count + 1,
              last_recalled_at = ?,
              updated_at = ?
        WHERE id = ?`,
    );

    let updated = 0;
    for (const id of memoryIds) {
      updated += statement.run(now, now, id).changes;
    }
    return updated;
  }

  deleteMemory(memoryId: string): void {
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(memoryId);
  }

  /** 记忆总数（含所有状态）。 */
  countAll(): number {
    const row = this.db.prepare('SELECT count(*) AS c FROM memories').get() as
      | { c?: number | bigint }
      | undefined;
    return Number(row?.c ?? 0);
  }

  /**
   * 物理清空全部记忆数据（保留 meta 里的设置与 schema 版本）。
   *
   * 顺序：先删关联表（tags / embeddings / links），再删主表，
   * 最后清日志类表，避免留下指向已删记忆的脏数据。
   */
  clearAllMemoryData(): void {
    const run = this.db.transaction(() => {
      for (const table of [
        'memory_tags',
        'memory_embeddings',
        'memory_links',
        'memories',
        'memory_tombstones',
        'review_log',
        'merge_log',
        'injection_log',
        'maintenance_runs',
      ]) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
    });
    run();
  }

  /* ─────────────────────────── 读取 ─────────────────────────── */

  getMemory(id: string): MemoryRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM memories WHERE id = ?`)
      .get(id) as MemoryRow | undefined;
    if (!row) return null;

    return this.mapRow(row, this.loadTags([id]).get(id) ?? []);
  }

  findDedupeCandidates(
    scope: Scope,
    scopeRef: string | null,
    sinceIso: Iso8601,
    includeSealed: boolean,
    limit = 20,
  ): DedupeRow[] {
    const stateCondition = includeSealed
      ? "state IN ('active', 'sealed')"
      : "state = 'active'";

    const rows = this.db
      .prepare(
        `SELECT id, raw_text, content_hash
           FROM memories
          WHERE scope = ?
            AND ifnull(scope_ref, '') = ifnull(?, '')
            AND created_at >= ?
            AND ${stateCondition}
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(scope, scopeRef, sinceIso, limit) as Array<{
      id: string;
      raw_text: string;
      content_hash: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      rawText: row.raw_text,
      contentHash: row.content_hash,
    }));
  }

  findTombstoneSince(contentHash: string, sinceIso: Iso8601): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM memory_tombstones
          WHERE content_hash = ? AND deleted_at >= ?
          LIMIT 1`,
      )
      .get(contentHash, sinceIso) as { id: string } | undefined;

    return row?.id ?? null;
  }

  /** 检索候选：状态过滤 + scope 可见性 + 最近更新排序。 */
  findCandidates(
    scope: Scope,
    scopeRef: string | null,
    includeSealed: boolean,
    limit = 500,
  ): MemoryRecord[] {
    const stateClause = includeSealed
      ? "(state = 'active' OR state = 'sealed')"
      : "state = 'active'";
    const visible = this.visibleClause(scope, scopeRef);

    const rows = this.db
      .prepare(
        `SELECT * FROM memories
          WHERE ${stateClause} AND ${visible.sql}
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(...visible.params, limit) as MemoryRow[];

    return this.hydrate(rows);
  }

  findByIds(ids: readonly string[]): MemoryRecord[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
          WHERE id IN (${placeholders}) AND state = 'active'`,
      )
      .all(...ids) as MemoryRow[];

    return this.hydrate(rows);
  }

  /** 生命周期扫描用：全部活跃且有效的记忆（不分线）。 */
  findActive(): MemoryRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE state = 'active' AND is_valid = 1`)
      .all() as MemoryRow[];

    return this.hydrate(rows);
  }

  findColdBefore(cutoffIso: Iso8601): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
          WHERE state = 'cold' AND cold_at IS NOT NULL AND cold_at <= ?`,
      )
      .all(cutoffIso) as MemoryRow[];

    return this.hydrate(rows);
  }

  findOccurredBetween(
    startIso: Iso8601,
    endIso: Iso8601,
    scope: Scope,
    scopeRef: string | null,
    limit = 5,
  ): MemoryRecord[] {
    const visible = this.visibleClause(scope, scopeRef);
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
          WHERE state = 'active'
            AND occurred_at >= ? AND occurred_at < ?
            AND ${visible.sql}
          ORDER BY occurred_at DESC
          LIMIT ?`,
      )
      .all(startIso, endIso, ...visible.params, limit) as MemoryRow[];

    return this.hydrate(rows);
  }

  findSessionRecent(
    sessionId: string,
    scope: Scope,
    scopeRef: string | null,
    limit = 3,
  ): MemoryRecord[] {
    const visible = this.visibleClause(scope, scopeRef);
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
          WHERE state = 'active' AND session_id = ? AND ${visible.sql}
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(sessionId, ...visible.params, limit) as MemoryRow[];

    return this.hydrate(rows);
  }

  findEmotionalSince(
    sinceIso: Iso8601,
    minIntensity: number,
    scope: Scope,
    scopeRef: string | null,
    limit = 1,
  ): MemoryRecord[] {
    const visible = this.visibleClause(scope, scopeRef);
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
          WHERE state = 'active'
            AND intensity >= ? AND created_at >= ?
            AND ${visible.sql}
          ORDER BY intensity DESC, created_at DESC
          LIMIT ?`,
      )
      .all(minIntensity, sinceIso, ...visible.params, limit) as MemoryRow[];

    return this.hydrate(rows);
  }

  findByTag(
    tag: string,
    scope: Scope,
    scopeRef: string | null,
    limit = 3,
  ): MemoryRecord[] {
    const visible = this.visibleClause(scope, scopeRef);
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories m
           JOIN memory_tags t ON t.memory_id = m.id
          WHERE t.tag = ? AND m.state = 'active' AND ${visible.sql}
          ORDER BY m.occurred_at DESC
          LIMIT ?`,
      )
      .all(tag, ...visible.params, limit) as MemoryRow[];

    return this.hydrate(rows);
  }

  loadVectors(ids: readonly string[], model: string): Map<string, Float32Array> {
    const result = new Map<string, Float32Array>();
    if (ids.length === 0) return result;

    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT memory_id, vector FROM memory_embeddings
          WHERE model = ? AND memory_id IN (${placeholders})`,
      )
      .all(model, ...ids) as Array<{ memory_id: string; vector: Uint8Array }>;

    for (const row of rows) {
      result.set(row.memory_id, decodeVector(row.vector));
    }

    return result;
  }

  countByState(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT state, count(*) AS total FROM memories GROUP BY state`)
      .all() as Array<{ state: string; total: number }>;

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.state] = row.total;
    }
    return result;
  }

  /* ─────────────────────────── 内部 ─────────────────────────── */

  private visibleClause(
    scope: Scope,
    scopeRef: string | null,
  ): { sql: string; params: string[] } {
    if (scope === 'self') {
      return { sql: "scope = 'self'", params: [] };
    }
    return {
      sql: "(scope = 'self' OR (scope = ? AND scope_ref = ?))",
      params: [scope, scopeRef ?? ''],
    };
  }

  private hydrate(rows: readonly MemoryRow[]): MemoryRecord[] {
    if (rows.length === 0) return [];

    const tags = this.loadTags(rows.map((row) => row.id));
    return rows.map((row) => this.mapRow(row, tags.get(row.id) ?? []));
  }

  private loadTags(ids: readonly string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    if (ids.length === 0) return result;

    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT memory_id, tag FROM memory_tags
          WHERE memory_id IN (${placeholders})
          ORDER BY tag`,
      )
      .all(...ids) as Array<{ memory_id: string; tag: string }>;

    for (const row of rows) {
      const existing = result.get(row.memory_id);
      if (existing) {
        existing.push(row.tag);
      } else {
        result.set(row.memory_id, [row.tag]);
      }
    }

    return result;
  }

  private mapRow(row: MemoryRow, tags: string[]): MemoryRecord {
    return {
      id: row.id,
      scope: row.scope as Scope,
      scopeRef: row.scope_ref,
      kind: row.kind as MemoryKind,
      rawText: row.raw_text,
      layers: {
        fact: row.fact,
        feltThen: row.felt_then,
        intensity: row.intensity,
        thoughtThen: row.thought_then,
        reframe: row.reframe,
        recalledLater: row.recalled_later,
      },
      summary: row.summary,
      tags,
      weight: row.weight,
      halfLifeDays: row.half_life_days,
      state: row.state as LifecycleState,
      stateReason: row.state_reason,
      isValid: row.is_valid === 1,
      recallCount: row.recall_count,
      reviewCount: row.review_count,
      contentHash: row.content_hash,
      source: {
        conversationId: row.conversation_id,
        sessionId: row.session_id,
        turnId: row.turn_id,
        speaker: row.speaker as Speaker,
      },
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRecalledAt: row.last_recalled_at,
      lastReviewedAt: row.last_reviewed_at,
      sealedAt: row.sealed_at,
      coldAt: row.cold_at,
      archivedAt: row.archived_at,
    };
  }
}

function decodeVector(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob);
  const length = Math.floor(copy.byteLength / 4);
  const out = new Float32Array(length);
  const view = new DataView(copy.buffer, copy.byteOffset, length * 4);
  for (let i = 0; i < length; i += 1) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}
