/**
 * 统一错误类型：所有对外抛出的错误都带稳定 code，方便 Agent 适配层判断
 * （例如 SystemDriveError 应该在安装时就提示用户改盘，而不是静默降级）。
 */

export type MemoryErrorCode =
  | 'SYSTEM_DRIVE'
  | 'CONFIG'
  | 'STORAGE_INIT'
  | 'SCHEMA_VERSION'
  | 'INVALID_MEMORY'
  | 'DEDUPE_CONFLICT'
  | 'LLM_ERROR'
  | 'EMBEDDING_ERROR'
  | 'BUDGET_OVERFLOW';

export interface MemoryErrorOptions {
  cause?: unknown;
  hint?: string;
}

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;

  /** 给用户看的一句话建议，例如「换到 D 盘」。 */
  readonly hint: string | undefined;

  constructor(code: MemoryErrorCode, message: string, options: MemoryErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.hint = options.hint;
  }
}

/**
 * 硬约束 1：记忆库禁止落在系统盘。
 * 构造函数只接收路径，错误信息与修复建议在这里一次写好，调用方无需重复解释。
 */
export class SystemDriveError extends MemoryError {
  readonly path: string;

  constructor(path: string) {
    super(
      'SYSTEM_DRIVE',
      `拒绝把记忆库放在系统盘或 AppData：${path}`,
      {
        hint:
          '系统盘重装/重置会直接抹掉记忆。请把 memoryDbPath 指向非 C: 盘，' +
          '例如 D:\\AI_Memory（目录会自动创建）。',
      },
    );
    this.path = path;
  }
}

/** 配置项越界或组合非法（不是路径问题，路径问题用 SystemDriveError）。 */
export class ConfigError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super('CONFIG', message, options);
  }
}

/** 建库失败：WAL 不可用、外键关不掉、目录不可写等。 */
export class StorageInitError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super('STORAGE_INIT', message, options);
  }
}

/** 代码比数据库旧：用户升级回退版本时，宁可拒绝启动也不要写坏数据。 */
export class SchemaVersionError extends MemoryError {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(
      'SCHEMA_VERSION',
      `数据库 schema 版本为 v${found}，当前代码只支持到 v${supported}。`,
      {
        hint:
          '请升级 ai-persistent-memory 到匹配版本；不要用旧版本打开新库，' +
          '否则可能写坏记忆。若确认要回退，请先备份 memory.db。',
      },
    );
    this.found = found;
    this.supported = supported;
  }
}

/** 写入载荷不合法（scope/scopeRef 组合、空原文、强度越界等）。 */
export class InvalidMemoryError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super('INVALID_MEMORY', message, options);
  }
}

/** 6 小时防重命中；引擎默认吞掉并返回既有 id，需要显式处理时才会抛出。 */
export class DedupeConflictError extends MemoryError {
  readonly existingId: string;

  constructor(existingId: string, similarity: number | null) {
    super(
      'DEDUPE_CONFLICT',
      `6 小时防重命中，已存在记忆 ${existingId}` +
        (similarity === null ? '' : `（相似度 ${similarity.toFixed(3)}）`),
    );
    this.existingId = existingId;
  }
}

/** 模型调用失败（超时 / 非 JSON / 拒绝服务）。 */
export class LlmError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super('LLM_ERROR', message, options);
  }
}

/** 本地向量化失败；引擎会降级为关键词检索而不是整体不可用。 */
export class EmbeddingError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super('EMBEDDING_ERROR', message, options);
  }
}
