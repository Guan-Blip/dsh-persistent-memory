/**
 * ai-persistent-memory · 公共出口
 *
 * 宿主只从这里 import；内部模块路径（core/ adapters/ ...）视为实现细节。
 */

export { MemoryEngine } from './core/MemoryEngine.js';
export type {
  Clock,
  MemoryEngineOptions,
  MergeReport,
  ReviewResult,
  SaveMemoryResult,
  SweepReport,
  TextEmbedder,
} from './core/MemoryEngine.js';

export { MemoryExtractor } from './extractor/MemoryExtractor.js';
export type {
  ExtractionRequest,
  ExtractionResult,
  MemoryExtractorOptions,
} from './extractor/MemoryExtractor.js';

export { MANUAL_TAG, PromptFormatter } from './injector/PromptFormatter.js';
export type { FormatInput, PromptFormatterOptions } from './injector/PromptFormatter.js';

export { WorldContextBuilder } from './injector/WorldContextBuilder.js';
export type { WorldContextRequest } from './injector/WorldContextBuilder.js';

export { MemoryRepository } from './adapters/storage/MemoryRepository.js';
export type {
  DedupeRow,
  DuplicateGroup,
  MaintenanceRunInsert,
  MaintenanceStatus,
  MergeLogInsert,
  ReviewLogInsert,
  TombstoneInsert,
} from './adapters/storage/MemoryRepository.js';

export { MarkdownArchive, NullArchive } from './adapters/archive/MarkdownArchive.js';
export type { MemoryArchive } from './adapters/archive/MarkdownArchive.js';

export { DeepSeekClient, StaticLlmClient } from './adapters/llm/LlmClient.js';
export type { LlmChatOptions, LlmClient, LlmMessage } from './adapters/llm/LlmClient.js';

export { DshAdapter } from './adapters/agent/DshAdapter.js';

/**
 * DSH 插件入口（Cordis 范式）。loader 会把本模块当成插件对象读取
 * name / inject / apply，所以插件面必须从公共出口暴露：
 * package.json 的 main 指向 lib/index.js，插件面与引擎面在同一个产物里。
 */
export { apply, inject, name } from './adapters/agent/DshAdapter.js';
/** 设置面板走的 HTTP 路由 + 清空/开关/维护实现。 */
export {
  CLEAR_ROUTE,
  DEFAULT_SETTINGS,
  HARD_BUDGET_TOKENS,
  HISTORY_LIMIT,
  LAST_MAINTENANCE_KEY,
  MAINTENANCE_INTERVAL_MS,
  MAINTENANCE_ROUTE,
  MEMORIZE_ROUTE,
  NUKE_FLOOR,
  NUKE_ROUTE,
  SETTINGS_ROUTE,
  STATS_ROUTE,
  backupRootOf,
  clearAllMemory,
  isGreeting,
  isLowValueUtterance,
  minScoreFromSensitivity,
  nukeAllMemory,
  parseSettingsPatch,
  readJsonBody,
  readLastMaintenance,
  readSettings,
  runMaintenance,
  writeSettings,
} from './adapters/agent/DshAdapter.js';
export type {
  ClearResult,
  DshAdapterOptions,
  DshHttpRequest,
  DshHttpResponse,
  DshMessage,
  DshPluginConfig,
  DshPluginContext,
  DshPreparedTurn,
  DshTurnContext,
  DshTurnResult,
  DshWebServer,
  MaintenanceReport,
  MemoryDatabaseDriver,
  MemorySettings,
  MemoryStatsPayload,
  MemoryWriteMode,
  NukeResult,
} from './adapters/agent/DshAdapter.js';

export { hasNodeSqlite, openNodeSqliteDatabase } from './adapters/storage/NodeSqliteAdapter.js';

/** 安全护栏（结构隔离）：人设/额外背景的固定外壳 + 结构转义 + 历史裁剪。 */
export {
  PERSONA_MAX_CHARS,
  escapeStructure,
  trimHistory,
  wrapExtraMemory,
  wrapPersona,
} from './core/guard.js';

/** 选盘与路径工具（面板 / CLI 共用）。 */
export {
  assertNotSystemPath,
  detectAvailableDrives,
  pickMemoryRoot,
  resolveMemoryPaths,
} from './utils/paths.js';
export type { MemoryPaths, MemoryRootChoice } from './utils/paths.js';

export { Scheduler, lastScheduledAt } from './maintenance/Scheduler.js';
export type {
  JobRun,
  MaintenanceContext,
  MaintenanceHandler,
  MaintenanceJobName,
  MaintenanceOutcome,
  MaintenanceSchedule,
  SchedulerOptions,
} from './maintenance/Scheduler.js';

export {
  DEFAULT_CONFIG,
  loadConfig,
  validateConfig,
} from './config.js';
export type { ConfigOverrides } from './config.js';

export {
  EXPECTED_TABLES,
  SCHEMA_VERSION,
  applyPragmas,
  initializeSchema,
  listAppTables,
  readSchemaVersion,
} from './core/schema.js';
export type { InitSchemaOptions, PragmaReport, PragmaSettings, SchemaInfo } from './core/schema.js';

export { MemoryError, SystemDriveError } from './errors.js';
export type { MemoryErrorCode, MemoryErrorOptions } from './errors.js';

export * from './types.js';
