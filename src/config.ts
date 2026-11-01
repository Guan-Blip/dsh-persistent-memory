/**
 * 配置合并与校验。
 *
 * 只负责「值合不合法」；路径是否在 C 盘由 utils/paths.ts 的
 * resolveMemoryPaths 判定（这样所有入口共用一把尺子）。
 */

import { ConfigError } from './errors.js';
import {
  DEDUPE_SIMILARITY_THRESHOLD,
  DEDUPE_WINDOW_MS,
  DEFAULT_MEMORY_ROOT,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  MAX_WEIGHT,
  type ArchiveConfig,
  type BackupConfig,
  type DedupeConfig,
  type EmbeddingConfig,
  type LifecycleConfig,
  type LlmConfig,
  type MemoryLogger,
  type MemoryPluginConfig,
  type RetrievalConfig,
} from './types.js';

export interface ConfigOverrides {
  memoryDbPath?: string;
  archive?: Partial<ArchiveConfig>;
  backup?: Partial<BackupConfig>;
  embedding?: Partial<EmbeddingConfig>;
  retrieval?: Partial<RetrievalConfig>;
  dedupe?: Partial<DedupeConfig>;
  lifecycle?: Partial<LifecycleConfig>;
  llm?: Partial<LlmConfig>;
  logger?: MemoryLogger;
}

/**
 * 默认值取向：
 *  - 检索预算 1200 token：个人助手注入记忆的保守值，0.6 秒左右读完；
 *  - embedding 默认关闭：没装 onnxruntime 时不能拖垮插件，关键词检索先可用；
 *  - llm 只做提取与复习，不参与检索（本地 0 token）。
 */
export const DEFAULT_CONFIG: MemoryPluginConfig = Object.freeze({
  memoryDbPath: DEFAULT_MEMORY_ROOT,
  archive: Object.freeze({ enabled: true, root: null }),
  // 快照统一放在 <memoryDbPath>\backups\backup-<时间戳>，只保留最近 3 份。
  backup: Object.freeze({ retention: 3 }),
  embedding: Object.freeze({
    enabled: false,
    model: EMBEDDING_MODEL,
    dim: EMBEDDING_DIM,
    cacheDir: null,
  }),
  retrieval: Object.freeze({
    topK: 8,
    minScore: 0.05,
    expandHops: 1,
    expandFactor: 0.55,
    maxExpanded: 6,
    budgetTokens: 1200,
  }),
  dedupe: Object.freeze({
    windowMs: DEDUPE_WINDOW_MS,
    similarityThreshold: DEDUPE_SIMILARITY_THRESHOLD,
    includeSealed: true,
  }),
  lifecycle: Object.freeze({
    coldAfterDays: 90,
    purgeAfterDays: 365,
    coldRetentionThreshold: 0.6,
    sweepIntervalHours: 6,
  }),
  llm: Object.freeze({
    provider: 'deepseek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    temperature: 0.2,
    timeoutMs: 30_000,
    maxRetries: 2,
  }),
});

export function loadConfig(overrides: ConfigOverrides = {}): MemoryPluginConfig {
  const config: MemoryPluginConfig = {
    memoryDbPath: (overrides.memoryDbPath ?? DEFAULT_CONFIG.memoryDbPath).trim(),
    archive: { ...DEFAULT_CONFIG.archive, ...(overrides.archive ?? {}) },
    backup: { ...DEFAULT_CONFIG.backup, ...(overrides.backup ?? {}) },
    embedding: { ...DEFAULT_CONFIG.embedding, ...(overrides.embedding ?? {}) },
    retrieval: { ...DEFAULT_CONFIG.retrieval, ...(overrides.retrieval ?? {}) },
    dedupe: { ...DEFAULT_CONFIG.dedupe, ...(overrides.dedupe ?? {}) },
    lifecycle: { ...DEFAULT_CONFIG.lifecycle, ...(overrides.lifecycle ?? {}) },
    llm: { ...DEFAULT_CONFIG.llm, ...(overrides.llm ?? {}) },
  };

  if (overrides.logger) {
    config.logger = overrides.logger;
  }

  validateConfig(config);
  return config;
}

export function validateConfig(config: MemoryPluginConfig): void {
  if (!config.memoryDbPath) {
    throw new ConfigError('memoryDbPath 不能为空。', {
      hint: `默认值应为 ${DEFAULT_MEMORY_ROOT}。`,
    });
  }

  if (config.archive.root !== null && !config.archive.root.trim()) {
    throw new ConfigError('archive.root 只能是 null 或非空路径。');
  }

  assertRange('backup.retention', config.backup.retention, 1, 50, ' 份');

  assertRange('embedding.dim', config.embedding.dim, 1, 4096);
  if (config.embedding.enabled && config.embedding.model === EMBEDDING_MODEL && config.embedding.dim !== EMBEDDING_DIM) {
    throw new ConfigError(
      `模型 ${EMBEDDING_MODEL} 固定为 ${EMBEDDING_DIM} 维，当前 embedding.dim=${config.embedding.dim}。`,
    );
  }

  assertRange('retrieval.topK', config.retrieval.topK, 1, 50);
  assertRange('retrieval.minScore', config.retrieval.minScore, 0, 1);
  assertRange('retrieval.expandFactor', config.retrieval.expandFactor, 0, 1);
  assertRange('retrieval.maxExpanded', config.retrieval.maxExpanded, 0, 50);
  assertRange('retrieval.budgetTokens', config.retrieval.budgetTokens, 100, 20_000);

  if (config.retrieval.expandHops !== 0 && config.retrieval.expandHops !== 1) {
    throw new ConfigError('retrieval.expandHops 只能是 0 或 1（图③只做一轮扩散）。');
  }

  assertRange('dedupe.windowMs', config.dedupe.windowMs, 60_000, 7 * 24 * 3_600_000, ' 毫秒');
  assertRange('dedupe.similarityThreshold', config.dedupe.similarityThreshold, 0.5, 1);

  assertRange('lifecycle.coldAfterDays', config.lifecycle.coldAfterDays, 1, 3_650, ' 天');
  assertRange('lifecycle.purgeAfterDays', config.lifecycle.purgeAfterDays, 1, 3_650, ' 天');
  if (config.lifecycle.purgeAfterDays <= config.lifecycle.coldAfterDays) {
    throw new ConfigError('lifecycle.purgeAfterDays 必须大于 coldAfterDays：先冷存，才可能清理。');
  }
  assertRange('lifecycle.coldRetentionThreshold', config.lifecycle.coldRetentionThreshold, 0, MAX_WEIGHT);
  assertRange('lifecycle.sweepIntervalHours', config.lifecycle.sweepIntervalHours, 1, 168, ' 小时');

  assertRange('llm.temperature', config.llm.temperature, 0, 2);
  assertRange('llm.timeoutMs', config.llm.timeoutMs, 1_000, 300_000, ' 毫秒');
  assertRange('llm.maxRetries', config.llm.maxRetries, 0, 5);
  if (!config.llm.apiKeyEnv.trim()) {
    throw new ConfigError('llm.apiKeyEnv 不能为空：密钥只从环境变量读取。');
  }
  if (config.llm.baseUrl !== null && !/^https?:\/\//i.test(config.llm.baseUrl)) {
    throw new ConfigError(`llm.baseUrl 必须以 http(s):// 开头，当前 ${config.llm.baseUrl}。`);
  }
  if (!['deepseek', 'openai-compatible', 'mock'].includes(config.llm.provider)) {
    throw new ConfigError(`未知的 llm.provider：${String(config.llm.provider)}`);
  }
}

function assertRange(
  name: string,
  value: number,
  min: number,
  max: number,
  unit = '',
): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(
      `${name} 必须在 ${min}-${max}${unit} 之间，当前为 ${String(value)}。`,
    );
  }
}
