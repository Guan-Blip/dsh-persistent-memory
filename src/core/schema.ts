/**
 * ai-persistent-memory · SQLite schema（v1）
 *
 * 设计要点：
 *  1. 所有表 STRICT：写错类型直接报错，避免脏数据悄悄落库。
 *  2. 时间列统一 ISO-8601 UTC 字符串，字典序即时间序，JS 里算年龄不依赖 SQLite 时区。
 *  3. WAL + busy_timeout + BEGIN IMMEDIATE 是硬要求，PRAGMA 在 applyPragmas 中显式设置。
 *  4. 原文（raw_text）与摘要（summary）分离：摘要只排序，永不覆盖原文（原则一）。
 *  5. 物理删除时只留墓碑（content_hash，无正文），兼顾 6 小时防重审计与隐私。
 *  6. 不在 v1 引入 FTS5：个人库量级（约几百条）下 LIKE + 向量已足够，
 *     语料变大后再以 migration v2 增加 trigram FTS，避免一开始就背分词器包袱。
 */

import type Database from 'better-sqlite3';

import { SchemaVersionError, StorageInitError } from '../errors.js';
import type { Iso8601 } from '../types.js';

export type SqliteDatabase = Database.Database;

/** 当前代码支持的 schema 版本；升级结构时 +1 并在 MIGRATIONS 里追加。 */
export const SCHEMA_VERSION = 1;

/** 默认忙等 5 秒：多进程（宿主 + 定时任务）同时写时不至于立刻 SQLITE_BUSY。 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/* ══════════════════════════════════════════════════════════════════
 * DDL
 * ══════════════════════════════════════════════════════════════════ */

export const SCHEMA_DDL = String.raw`
-- ────────────────────────────────────────────────────────────────
-- meta：schema 版本、初始化时间等库级元信息（人读 + 迁移辅助）
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT NOT NULL PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- memories：① 五层字段 + ② 检索属性 + ⑤ 生命周期状态
-- 一条记忆 = 一段原文 + 五层心事 + 可衰减的权重
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memories (
  id               TEXT NOT NULL PRIMARY KEY,

  -- ⑥ 分线不分人
  scope            TEXT NOT NULL CHECK (scope IN ('self', 'mask', 'project')),
  scope_ref        TEXT,

  -- ⑤ 半衰期类别
  kind             TEXT NOT NULL CHECK (kind IN ('fact', 'opinion', 'observation', 'event')),

  -- ① 五层：1. 事实（发生了什么）
  fact             TEXT NOT NULL CHECK (length(trim(fact)) > 0),
  -- ① 五层：2. 当时感觉 + 情绪强度 0-10
  felt_then        TEXT,
  intensity        REAL NOT NULL DEFAULT 0 CHECK (intensity >= 0 AND intensity <= 10),
  -- ① 五层：3. 当时在想（哪根情绪线被碰到了）
  thought_then     TEXT,
  -- ① 五层：4. 后来再想（现在怎么看）
  reframe          TEXT,
  -- ① 五层：5. 回忆补（后来才想起来的）
  recalled_later   TEXT,

  -- 原则一：原文不压缩。人读档案与「连续感」都依赖它。
  raw_text         TEXT NOT NULL CHECK (length(trim(raw_text)) > 0),
  -- 机器摘要：只参与排序，可空，永不覆盖 raw_text。
  summary          TEXT,

  -- ③ 打分：权重（基础值）× 半衰期衰减 × 情绪系数
  weight           REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 3.0),
  half_life_days   INTEGER NOT NULL CHECK (half_life_days IN (30, 45, 60, 90)),

  -- ⑤ 五级生命周期：active 活跃 / sealed 封存 / cold 冷存 / archived 归档（永不物理删除）
  state            TEXT NOT NULL DEFAULT 'active'
                     CHECK (state IN ('active', 'sealed', 'cold', 'archived')),
  state_reason     TEXT,
  -- 封存：出现矛盾 → 旧条失效但不删（图⑤）
  is_valid         INTEGER NOT NULL DEFAULT 1 CHECK (is_valid IN (0, 1)),

  recall_count     INTEGER NOT NULL DEFAULT 0 CHECK (recall_count >= 0),
  review_count     INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),

  -- 6 小时防重与合并去重使用的内容指纹（归一化原文的 sha256）
  content_hash     TEXT NOT NULL,

  -- 溯源：哪一轮对话、谁说、事件何时发生
  conversation_id  TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  turn_id          TEXT NOT NULL,
  speaker          TEXT NOT NULL CHECK (speaker IN ('user', 'assistant', 'system')),

  occurred_at      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_recalled_at TEXT,
  last_reviewed_at TEXT,
  sealed_at        TEXT,
  cold_at          TEXT,
  archived_at      TEXT,

  -- self 不允许带线标识；mask / project 必须带非空线标识
  CHECK (
    (scope = 'self' AND scope_ref IS NULL)
    OR (scope IN ('mask', 'project') AND scope_ref IS NOT NULL AND length(trim(scope_ref)) > 0)
  )
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- memory_tags：标签表（图②「同标签互链」靠它，而不是 JSON 字段）
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL CHECK (length(trim(tag)) > 0),
  PRIMARY KEY (memory_id, tag)
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- memory_links：语义近邻 + 同标签 + 手动连线（图③「一轮扩散」的边）
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_links (
  from_id    TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('semantic', 'tag', 'manual')),
  strength   REAL NOT NULL DEFAULT 1.0 CHECK (strength >= 0 AND strength <= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, kind),
  CHECK (from_id <> to_id)
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- memory_embeddings：bge-small-zh-v1.5 的 512 维 Float32 BLOB
-- 与 memories 分表：模型可换、可重建，不影响业务字段
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL CHECK (dim > 0),
  vector     BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, model)
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- memory_tombstones：物理删除后的墓碑，只留指纹，不留正文
-- 用途：防止「刚清理完又被同一段话写回来」，以及审计清理行为
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_tombstones (
  id           TEXT NOT NULL PRIMARY KEY,
  content_hash TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('self', 'mask', 'project')),
  scope_ref    TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('fact', 'opinion', 'observation', 'event')),
  deleted_at   TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN ('lifecycle_purge', 'manual_forget', 'manual_purge')),
  age_days     INTEGER NOT NULL CHECK (age_days >= 0)
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- review_log：图④ 复习记录（00:00 三条复述、数字核对 ×1.6）
-- 故意不建外键：记忆被物理删除后，复习历史仍要保留
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS review_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id     TEXT NOT NULL,
  reviewed_at   TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('nightly_recall', 'number_check', 'manual')),
  weight_before REAL NOT NULL,
  weight_after  REAL NOT NULL,
  note          TEXT
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- merge_log：图④ 23:00 合并重复、旧事实归档的账本
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS merge_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  survivor_id     TEXT NOT NULL,
  merged_ids_json TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  note            TEXT
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- maintenance_runs：定时任务账本
-- UNIQUE(job, scheduled_for) 同时提供幂等与「睡眠错过补跑」能力
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maintenance_runs (
  id            TEXT NOT NULL PRIMARY KEY,
  job           TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  stats_json    TEXT,
  error         TEXT,
  UNIQUE (job, scheduled_for)
) STRICT;

-- ────────────────────────────────────────────────────────────────
-- injection_log：每轮注入了哪些记忆、估算 token（调预算与复盘用）
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS injection_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  turn_id         TEXT NOT NULL,
  memory_ids_json TEXT NOT NULL,
  token_estimate  INTEGER NOT NULL CHECK (token_estimate >= 0),
  created_at      TEXT NOT NULL
) STRICT;

-- ─────────────────────────── 索引 ───────────────────────────
-- 检索入口：scope + 生命状态
CREATE INDEX IF NOT EXISTS ix_memories_scope
  ON memories(scope, scope_ref, state);
-- 6 小时防重：按指纹取最近窗口
CREATE INDEX IF NOT EXISTS ix_memories_hash
  ON memories(content_hash, created_at);
-- 冷存扫描：90 天没被想起
CREATE INDEX IF NOT EXISTS ix_memories_state_recalled
  ON memories(state, last_recalled_at);
-- 通用时间序（日记 / 周记 / 星图）
CREATE INDEX IF NOT EXISTS ix_memories_state_created
  ON memories(state, created_at);
CREATE INDEX IF NOT EXISTS ix_memories_occurred
  ON memories(occurred_at);
-- 类别统计与半衰期调参
CREATE INDEX IF NOT EXISTS ix_memories_kind_state
  ON memories(kind, state);
-- 清理扫描只关心冷存行
CREATE INDEX IF NOT EXISTS ix_memories_cold
  ON memories(cold_at) WHERE state = 'cold';
-- 同标签互链
CREATE INDEX IF NOT EXISTS ix_memory_tags_tag
  ON memory_tags(tag, memory_id);
-- 反向遍历链接（被谁指向）
CREATE INDEX IF NOT EXISTS ix_memory_links_to
  ON memory_links(to_id, kind);
CREATE INDEX IF NOT EXISTS ix_review_log_memory
  ON review_log(memory_id, reviewed_at);
CREATE INDEX IF NOT EXISTS ix_injection_log_session
  ON injection_log(session_id, created_at);
`;

/** 初始化后必须存在的表；少一张就说明库被改坏，宁可拒绝启动。 */
export const EXPECTED_TABLES: readonly string[] = Object.freeze([
  'meta',
  'memories',
  'memory_tags',
  'memory_links',
  'memory_embeddings',
  'memory_tombstones',
  'review_log',
  'merge_log',
  'maintenance_runs',
  'injection_log',
]);

/* ══════════════════════════════════════════════════════════════════
 * PRAGMA
 * ══════════════════════════════════════════════════════════════════ */

export interface PragmaSettings {
  /** 忙等毫秒数，默认 5000；低于 1000 会被抬到 1000。 */
  busyTimeoutMs?: number;
  /** WAL 下 NORMAL 足够安全（断电最多丢最后一笔，不会损坏库）。 */
  synchronous?: 'NORMAL' | 'FULL';
  /** 页缓存，单位 KiB（负数形式传给 SQLite），默认 16 MiB。 */
  cacheSizeKib?: number;
}

export interface PragmaReport {
  journalMode: string;
  busyTimeoutMs: number;
  synchronous: number;
  foreignKeys: boolean;
}

/**
 * 每个连接都必须执行：WAL、busy_timeout、foreign_keys 都是「连接级」设置，
 * 不是建库时写进去的属性。
 */
export function applyPragmas(
  db: SqliteDatabase,
  settings: PragmaSettings = {},
): PragmaReport {
  const busyTimeoutMs = Math.max(
    1_000,
    Math.trunc(settings.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS),
  );

  // 先设忙等：并发写时让 SQLite 自己重试，而不是立刻抛 SQLITE_BUSY
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);

  const journalMode = String(db.pragma('journal_mode = WAL', { simple: true })).toLowerCase();
  if (journalMode !== 'wal') {
    throw new StorageInitError(
      `记忆库无法启用 WAL（实际 journal_mode="${journalMode}"）。`,
      {
        hint:
          '并发安全依赖 WAL。请把 memoryDbPath 指向本地 NTFS 盘（例如 D:\\AI_Memory），' +
          '不要使用网络盘、FAT32 或只读挂载。',
      },
    );
  }

  db.pragma(`synchronous = ${settings.synchronous ?? 'NORMAL'}`);
  // 级联删除与引用完整性依赖它；这是连接级开关，每次连接都要打开
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma(`cache_size = -${Math.max(2_000, settings.cacheSizeKib ?? 16_384)}`);
  // 每 1000 页自动 checkpoint，避免 -wal 文件无限增长
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('journal_size_limit = 67108864');

  const foreignKeys = Number(db.pragma('foreign_keys', { simple: true })) === 1;
  if (!foreignKeys) {
    throw new StorageInitError('foreign_keys 无法开启，级联删除与引用完整性不可用。');
  }

  return {
    journalMode,
    busyTimeoutMs: Number(db.pragma('busy_timeout', { simple: true })),
    synchronous: Number(db.pragma('synchronous', { simple: true })),
    foreignKeys,
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 初始化 / 迁移
 * ══════════════════════════════════════════════════════════════════ */

export interface InitSchemaOptions extends PragmaSettings {
  /** 注入时间便于测试；缺省取系统 UTC 时间。 */
  now?: Iso8601;
  logger?: { warn(message: string): void };
}

export interface SchemaInfo {
  version: number;
  /** true = 本次新建；false = 打开既有库。 */
  fresh: boolean;
  pragmas: PragmaReport;
  tables: string[];
}

/** v1 的表结构已在 SCHEMA_DDL 中建好；v2 起在此追加增量 SQL。 */
interface Migration {
  readonly version: number;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  // 示例（v2）：
  // { version: 2, sql: `ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;` },
];

export function initializeSchema(
  db: SqliteDatabase,
  options: InitSchemaOptions = {},
): SchemaInfo {
  const pragmas = applyPragmas(db, options);
  const existing = readSchemaVersion(db);

  // 旧代码打开新库：拒绝启动，避免写坏数据
  if (existing > SCHEMA_VERSION) {
    throw new SchemaVersionError(existing, SCHEMA_VERSION);
  }

  const fresh = existing === 0;

  if (fresh) {
    runImmediate(db, () => db.exec(SCHEMA_DDL));
  }

  for (const migration of MIGRATIONS) {
    if (migration.version > existing && migration.version <= SCHEMA_VERSION) {
      runImmediate(db, () => db.exec(migration.sql));
    }
  }

  const tables = listAppTables(db);
  const missing = EXPECTED_TABLES.filter((table) => !tables.includes(table));
  if (missing.length > 0) {
    throw new StorageInitError(
      `记忆库缺少必需的表：${missing.join(', ')}（user_version=${existing}）。`,
      {
        hint:
          '数据库可能被手工改动或磁盘写坏。请先备份 memory.db，' +
          '再重命名后重新初始化，或运行 doctor 检查。',
      },
    );
  }

  const now = options.now ?? new Date().toISOString();
  runImmediate(db, () => {
    const upsertMeta = db.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const insertMeta = db.prepare(
      `INSERT OR IGNORE INTO meta (key, value, updated_at) VALUES (?, ?, ?)`,
    );

    upsertMeta.run('schema_version', String(SCHEMA_VERSION), now);
    upsertMeta.run('last_opened_at', now, now);
    insertMeta.run('bootstrapped_at', now, now);

    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });

  if (readSchemaVersion(db) !== SCHEMA_VERSION) {
    throw new StorageInitError('schema 版本写入失败，数据库可能处于只读状态。');
  }

  return { version: SCHEMA_VERSION, fresh, pragmas, tables };
}

/** 读取 PRAGMA user_version；0 表示尚未初始化。 */
export function readSchemaVersion(db: SqliteDatabase): number {
  const raw = Number(db.pragma('user_version', { simple: true }));
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
}

/** 列出业务表（排除 SQLite 内部表）。 */
export function listAppTables(db: SqliteDatabase): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/** BEGIN IMMEDIATE：多进程下先拿写锁，把「检查-写入」做成一个原子步骤。 */
function runImmediate(db: SqliteDatabase, work: () => void): void {
  const transaction = db.transaction(work);
  transaction.immediate();
}
