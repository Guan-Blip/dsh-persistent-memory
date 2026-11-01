/**
 * ai-persistent-memory · 领域类型（唯一事实来源）
 *
 * 对应 PRD《她的记忆系统·整套逻辑》：
 *   ① 写进去   → FiveLayers / MemoryDraft / ExtractionOutput
 *   ② 存成两份 → MemoryRecord（字段与 core/schema.ts 的 SQLite 列一一对应）
 *   ③ 用起来   → RecallQuery / ScoredMemory / InjectionPayload
 *   ⑤ 允许忘   → LifecycleState / 半衰期常量
 *   ⑥ 分线不分人 → Scope / scopeKey
 *
 * 约束：本文件只有类型、常量与无副作用纯函数；不 import 任何运行时依赖。
 * 时间统一用 ISO-8601 UTC（2026-01-01T00:00:00.000Z），字符串字典序即时间序。
 */

export type Iso8601 = string;

/* ────────────────────────────── 枚举 ────────────────────────────── */

/** ⑥ 分线不分人：本体 / 面具 / 项目线。SQL CHECK 与本数组保持一致。 */
export const SCOPES = ['self', 'mask', 'project'] as const;
export type Scope = (typeof SCOPES)[number];

/** 半衰期类别：事实 / 看法 / 观察 / 事件（图⑤）。 */
export const MEMORY_KINDS = ['fact', 'opinion', 'observation', 'event'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** 五级生命周期（图⑤）：活跃 / 封存 / 冷存 / 归档；「清理」是删除动作，不是状态。 */
export const LIFECYCLE_STATES = ['active', 'sealed', 'cold', 'archived'] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** 互链类型（图②：语义近邻 + 同标签；manual 留给「复习时连起来」）。 */
export const LINK_KINDS = ['semantic', 'tag', 'manual'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export type Speaker = 'user' | 'assistant' | 'system';

/** 提取器输入的一轮对话；at 可选，用于「回忆补」判断时间。 */
export interface DialogueTurn {
  role: Speaker;
  content: string;
  at?: Iso8601;
}

/** 这条记忆是被什么召回的：关键词 / 向量 / 标签 / 一轮扩散。 */
export type MatchSource = 'keyword' | 'embedding' | 'tag' | 'link';

/** 物理删除时写入的操作来源。 */
export type TombstoneReason = 'lifecycle_purge' | 'manual_forget' | 'manual_purge';

/* ────────────────────────────── 常量 ────────────────────────────── */

/** 图⑤：事实 90 天 / 看法 60 天 / 观察 45 天 / 事件 30 天。 */
export const HALF_LIFE_DAYS: Readonly<Record<MemoryKind, number>> = Object.freeze({
  fact: 90,
  opinion: 60,
  observation: 45,
  event: 30,
});

/** 冷存：很淡且 90 天没有被想起 → 退出检索（图⑤）。 */
export const COLD_AFTER_DAYS = 90;

/** 清理：冷存满 365 天 → 物理删除；归档（archived）永不删除（图⑤）。 */
export const PURGE_AFTER_DAYS = 365;

/**
 * 衰减后的有效权重低于这个值才算「很淡」（图⑤「很淡且 90 天没用」）。
 * 注意是绝对权重而不是比例：复习过（×1.6）的重要记忆权重高，不会因为
 * 时间长就变冷；同时 90 天没用这条硬条件仍然要满足。
 */
export const COLD_RETENTION_THRESHOLD = 0.6;

/** 图①：同一件事 6 小时内不重复记。 */
export const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** 近似重复判定：归一化文本的余弦相似度阈值（向量不可用时退化为指纹比对）。 */
export const DEDUPE_SIMILARITY_THRESHOLD = 0.92;

export const MAX_INTENSITY = 10;

/** 基础权重上限：复习（数字核对 ×1.6）与反复想起都会加强，但不能无限膨胀。 */
export const MAX_WEIGHT = 3;

export const EMBEDDING_MODEL = 'bge-small-zh-v1.5';
export const EMBEDDING_DIM = 512;

/** 人读档案 / 提示词共用的中文标签，避免各处各写一套。 */
export const MEMORY_KIND_LABEL: Readonly<Record<MemoryKind, string>> = Object.freeze({
  fact: '事实',
  opinion: '看法',
  observation: '观察',
  event: '事件',
});

export const SCOPE_LABEL: Readonly<Record<Scope, string>> = Object.freeze({
  self: '本体',
  mask: '面具',
  project: '项目',
});

/** 图②：bge-small-zh 512 维，本地 ONNX，零 token。 */
export const DEFAULT_MEMORY_ROOT = 'D:\\AI_Memory';

/* ────────────────────────── 无副作用纯函数 ────────────────────────── */

/** 情绪强度收敛到 0-10；脏输入（NaN / 越界 / 字符串）一律归零。 */
export function clampIntensity(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(MAX_INTENSITY, Math.max(0, num));
}

/**
 * 图③ 的情绪系数：强度 0 → 1.0，强度 10 → 3.0。
 * 只有这一份实现，scoring.ts 与注入预算都复用它，避免公式漂移。
 */
export function emotionCoefficient(intensity: number): number {
  return 1 + clampIntensity(intensity) / 5;
}

/** scope + scopeRef 的稳定字符串键，用于防重、目录命名与缓存键。 */
export function scopeKey(scope: Scope, scopeRef: string | null): string {
  if (scope === 'self') return 'self';
  return `${scope}:${(scopeRef ?? '').trim()}`;
}

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && (SCOPES as readonly string[]).includes(value);
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(value);
}

/* ─────────────────────────── ① 写进去 ─────────────────────────── */

/**
 * 图① 的五层结构。注意 fact 是「提炼后的一句话」，rawText 才是永不改写的原文；
 * 两者都存，原则一（原文不压缩）靠 rawText 落地。
 */
export interface FiveLayers {
  /** 第 1 层：事实（发生了什么）。 */
  fact: string;
  /** 第 2 层：当时感觉（可空，但强度必须有）。 */
  feltThen: string | null;
  /** 第 2 层：情绪强度 0-10。 */
  intensity: number;
  /** 第 3 层：当时在想（哪根情绪线被碰到了）。 */
  thoughtThen: string | null;
  /** 第 4 层：后来再想（现在怎么看）。 */
  reframe: string | null;
  /** 第 5 层：回忆补（后来才想起来的）。 */
  recalledLater: string | null;
}

export interface MemorySource {
  conversationId: string;
  sessionId: string;
  turnId: string;
  speaker: Speaker;
}

/** 引擎写入的最小载荷；id / 时间戳 / 衰减参数由引擎补齐。 */
export interface MemoryDraft {
  scope: Scope;
  /** self 必须为 null；mask / project 必须是稳定的线标识（uid / slug）。 */
  scopeRef: string | null;
  kind: MemoryKind;
  /** 原文，必须原样保存。 */
  rawText: string;
  layers: FiveLayers;
  tags?: readonly string[];
  /** 只给机器排序用的摘要，可为空，永不覆盖 rawText。 */
  summary?: string | null;
  /** 初始基础权重，缺省 1.0，引擎会收敛到 (0, MAX_WEIGHT]。 */
  weight?: number;
  /** 事件实际发生时间，缺省取 source 所在轮次的时间。 */
  occurredAt?: Iso8601;
  source: MemorySource;
}

/** 图④ 复习 / 图③ 想起后的权重调整建议。 */
export interface WeightAdjustment {
  memoryId: string;
  delta: number;
  reason: 'recalled' | 'review_number_check' | 'merged' | 'manual';
}

/* ─────────────────────────── ② 存成两份 ─────────────────────────── */

/**
 * SQLite 中的一条记忆（camelCase 视图）。
 * 列名映射见 core/schema.ts；Markdown 档案是同一份内容的另一投影。
 */
export interface MemoryRecord {
  id: string;
  scope: Scope;
  scopeRef: string | null;
  kind: MemoryKind;
  /** 原文，原则一：不压缩、不改写。 */
  rawText: string;
  /** 五层结构。 */
  layers: FiveLayers;
  /** 机器摘要，只参与排序。 */
  summary: string | null;
  tags: string[];
  /** 基础权重（不含半衰期衰减），复习与想起会加强。 */
  weight: number;
  /** 半衰期天数，由 kind 推导（30 / 45 / 60 / 90）。 */
  halfLifeDays: number;
  state: LifecycleState;
  stateReason: string | null;
  /** 图⑤「封存：出现矛盾 → 旧条失效，不删」。 */
  isValid: boolean;
  recallCount: number;
  reviewCount: number;
  /** 归一化原文的指纹，6 小时防重与去重合并都用它。 */
  contentHash: string;
  source: MemorySource;
  occurredAt: Iso8601;
  createdAt: Iso8601;
  updatedAt: Iso8601;
  lastRecalledAt: Iso8601 | null;
  lastReviewedAt: Iso8601 | null;
  sealedAt: Iso8601 | null;
  coldAt: Iso8601 | null;
  archivedAt: Iso8601 | null;
}

export interface MemoryLink {
  fromId: string;
  toId: string;
  kind: LinkKind;
  /** 0-1，用于图③「一轮扩散」时的衰减。 */
  strength: number;
  createdAt: Iso8601;
}

export interface MemoryEmbedding {
  memoryId: string;
  model: string;
  dim: number;
  /** Float32Array 的 BLOB 形式；读取后按 dim 还原。 */
  vector: Uint8Array;
  createdAt: Iso8601;
}

/** 物理删除后留下的墓碑：只有指纹，没有内容，兼顾防重审计与隐私。 */
export interface Tombstone {
  id: string;
  contentHash: string;
  scope: Scope;
  scopeRef: string | null;
  kind: MemoryKind;
  deletedAt: Iso8601;
  reason: TombstoneReason;
  ageDays: number;
}

/* ─────────────────────────── ③ 用起来 ─────────────────────────── */

export interface RecallQuery {
  /** 用户这一轮的消息原文。 */
  text: string;
  scope: Scope;
  scopeRef?: string | null;
  sessionId?: string;
  /** 可注入假时间，测试生命周期与衰减。 */
  now?: Iso8601;
  topK?: number;
  /** 0-1 的相关性门槛；省略则用配置里的 retrieval.minScore（由「记忆敏感度」换算）。 */
  minScore?: number;
  /** 默认只召活跃；封存/冷存不参与注入。 */
  includeSealed?: boolean;
  /** 注入预算，超出后整条丢弃而不是截断。 */
  budgetTokens?: number;
}

export interface ScoredMemory {
  memory: MemoryRecord;
  /** score = 语义(或关键词) × 衰减权重 × 情绪系数。 */
  score: number;
  /** 归一化到 0-1 的相关性。 */
  semantic: number;
  /** weight × 半衰期衰减。 */
  decayedWeight: number;
  /** 1.0 - 3.0。 */
  emotion: number;
  matchedBy: MatchSource;
  /** 0 = 直接命中；1 = 图③「一轮扩散」带出来的旧事。 */
  hops: number;
}

export interface RecallResult {
  query: string;
  scope: Scope;
  scopeRef: string | null;
  items: ScoredMemory[];
  /** 参与打分的候选条数，用于调参与观测。 */
  candidates: number;
  elapsedMs: number;
  /** 按预算整块装入后的估算 token。 */
  estimatedTokens: number;
  /** 图③「整块跳过」：预算装不下的条数。 */
  skippedForBudget: number;
}

/** 图③「[世界资料] 固定五节」。 */
export type WorldSectionKey = 'today' | 'mood' | 'events' | 'openLoops' | 'recent';

export interface WorldSection {
  key: WorldSectionKey;
  title: string;
  lines: string[];
}

/** 图③「[世界资料] 固定五节」的数据；由 WorldContextBuilder 从仓储层组装。 */
export interface WorldContext {
  now: Iso8601;
  /** 例：2026-10-30 周五。 */
  today: string;
  /** 最近的情绪状态（带强度），没有则 null。 */
  mood: string | null;
  todayEvents: string[];
  openLoops: string[];
  /** 最近聊过，只取本会话。 */
  recent: string[];
}

/** 最终拼给模型的注入块，text 形如 `[系统记忆：...]`。 */
export interface InjectionPayload {
  text: string;
  sections: WorldSection[];
  memories: ScoredMemory[];
  estimatedTokens: number;
  /** 因预算被整块跳过的条数（图③「整块跳过」）。 */
  skippedForBudget: number;
  /** 因预算被整块跳过的世界资料节数。 */
  skippedWorldSections: number;
}

/* ───────────────────────── ④ 维护 / ⑤ 生命周期 ───────────────────────── */

export interface DedupeVerdict {
  duplicate: boolean;
  reason: 'hash' | 'similarity' | 'tombstone' | 'none';
  existingId: string | null;
  similarity: number | null;
}

export interface LifecycleTransition {
  memoryId: string;
  from: LifecycleState;
  to: LifecycleState | 'deleted';
  reason: string;
  at: Iso8601;
}

/* ───────────────────────── 提取器契约 ───────────────────────── */

/** 模型返回的单条候选；shouldRemember=false 时仅用于观测「为什么没记」。 */
export interface ExtractedMemory {
  shouldRemember: boolean;
  skipReason: string | null;
  kind: MemoryKind;
  scope: Scope;
  scopeRef: string | null;
  layers: FiveLayers;
  rawText: string;
  summary: string | null;
  tags: string[];
  weight: number | null;
  occurredAt: Iso8601 | null;
}

export interface ExtractionOutput {
  memories: ExtractedMemory[];
}

/* ───────────────────────── 配置契约 ───────────────────────── */

export interface ArchiveConfig {
  enabled: boolean;
  /** null = 跟随 memoryDbPath（同一盘同一根目录）。 */
  root: string | null;
}

/** 清空记忆时生成的快照策略（快照放在 <memoryDbPath>\backups\backup-<时间戳>）。 */
export interface BackupConfig {
  /** 最多保留几份快照（1-50）；超出的按时间戳从旧到新删除，刚生成的那份永不删。 */
  retention: number;
}

export interface EmbeddingConfig {
  enabled: boolean;
  model: string;
  dim: number;
  /** ONNX 模型缓存目录；null = <memoryDbPath>\.models。 */
  cacheDir: string | null;
}

export interface RetrievalConfig {
  topK: number;
  minScore: number;
  /** 图③「一轮扩散」：0 关闭，1 只扩散一层（默认）。 */
  expandHops: 0 | 1;
  expandFactor: number;
  maxExpanded: number;
  budgetTokens: number;
}

export interface DedupeConfig {
  windowMs: number;
  similarityThreshold: number;
  /** 封存的旧条是否也参与防重（默认参与，避免「那件事」反复复活）。 */
  includeSealed: boolean;
}

export interface LifecycleConfig {
  coldAfterDays: number;
  purgeAfterDays: number;
  coldRetentionThreshold: number;
  /** 生命周期扫描周期，默认 6 小时（零点复习时顺带扫一次）。 */
  sweepIntervalHours: number;
}

export interface LlmConfig {
  provider: 'deepseek' | 'openai-compatible' | 'mock';
  model: string;
  baseUrl: string | null;
  /** 从哪个环境变量读 key，避免把密钥写进配置文件。 */
  apiKeyEnv: string;
  temperature: number;
  timeoutMs: number;
  maxRetries: number;
}

export interface MemoryPluginConfig {
  /** 硬约束 1：默认 D:\AI_Memory；C: 开头在配置校验阶段抛 SystemDriveError。 */
  memoryDbPath: string;
  archive: ArchiveConfig;
  backup: BackupConfig;
  embedding: EmbeddingConfig;
  retrieval: RetrievalConfig;
  dedupe: DedupeConfig;
  lifecycle: LifecycleConfig;
  llm: LlmConfig;
  logger?: MemoryLogger;
}

export interface MemoryLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
