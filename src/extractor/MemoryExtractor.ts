/**
 * MemoryExtractor · 图①「写进去」的第一步。
 *
 *   对话 → 内置 System Prompt → LLM JSON mode → 容错解析 → 校验/归一化 → MemoryDraft[]
 *
 * 设计原则：
 *   - 提取器不写库、不去重、不判断 scope：它只产出候选，由引擎做 6 小时防重与落盘；
 *   - 任何模型/网络/JSON 问题都不向上抛，返回 degraded=true + 空结果，绝不让
 *     记忆系统把整轮对话搞崩；
 *   - scope 强制取当前会话所在的线（分线由系统定，不让模型猜）。
 */

import type { LlmClient } from '../adapters/llm/LlmClient.js';
import { hashContent } from '../core/dedupe.js';
import type { Clock } from '../core/MemoryEngine.js';
import {
  clampIntensity,
  isMemoryKind,
  type DialogueTurn,
  type Iso8601,
  type MemoryDraft,
  type MemoryKind,
  type MemoryLogger,
  type Scope,
  type Speaker,
} from '../types.js';
import { parseLooseJson } from './parse.js';
import { buildExtractionMessages } from './prompts.js';

export interface ExtractionRequest {
  turns: readonly DialogueTurn[];
  scope: Scope;
  scopeRef: string | null;
  conversationId: string;
  sessionId: string;
  turnId: string;
  speaker?: Speaker;
  occurredAt?: Iso8601;
}

export interface ExtractionResult {
  drafts: MemoryDraft[];
  /** true = 模型/解析失败后降级，drafts 为空。 */
  degraded: boolean;
  issues: string[];
  rawResponse: string | null;
}

export interface MemoryExtractorOptions {
  llm: LlmClient;
  logger?: MemoryLogger;
  clock?: Clock;
  temperature?: number;
  maxMemories?: number;
}

const SILENT_LOGGER: MemoryLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const SYSTEM_CLOCK: Clock = { now: () => new Date() };

export class MemoryExtractor {
  private readonly llm: LlmClient;
  private readonly logger: MemoryLogger;
  private readonly clock: Clock;
  private readonly temperature: number;
  private readonly maxMemories: number;

  constructor(options: MemoryExtractorOptions) {
    this.llm = options.llm;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.temperature = options.temperature ?? 0.1;
    this.maxMemories = options.maxMemories ?? 5;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const now = normalizeIso(request.occurredAt) ?? this.clock.now().toISOString();

    if (request.scope !== 'self' && !(request.scopeRef ?? '').trim()) {
      return {
        drafts: [],
        degraded: true,
        issues: [`${request.scope} 提取必须提供 scopeRef`],
        rawResponse: null,
      };
    }

    if (request.turns.length === 0) {
      return { drafts: [], degraded: false, issues: ['没有对话内容'], rawResponse: null };
    }

    let rawResponse: string | null = null;

    try {
      rawResponse = await this.llm.chat(
        buildExtractionMessages({
          turns: request.turns,
          scope: request.scope,
          scopeRef: request.scopeRef,
          now,
        }),
        { responseFormat: 'json', temperature: this.temperature },
      );

      const parsed = parseLooseJson(rawResponse);
      if (!parsed.ok) {
        this.logger.warn('记忆提取 JSON 解析失败，降级为空结果', { reason: parsed.reason });
        return { drafts: [], degraded: true, issues: [parsed.reason], rawResponse };
      }

      const normalized = this.normalizeOutput(parsed.value, request, now);
      if (normalized.drafts.length === 0) {
        this.logger.debug('本轮没有值得记住的内容', { issues: normalized.issues });
      }

      return {
        drafts: normalized.drafts,
        degraded: false,
        issues: normalized.issues,
        rawResponse,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('记忆提取失败，降级为空结果', { error: message });
      return { drafts: [], degraded: true, issues: [message], rawResponse };
    }
  }

  private normalizeOutput(
    value: unknown,
    request: ExtractionRequest,
    now: Iso8601,
  ): { drafts: MemoryDraft[]; issues: string[] } {
    const issues: string[] = [];
    const items = extractItems(value);

    if (items === null) {
      return { drafts: [], issues: ['响应不是数组，也没有 memories 数组'] };
    }

    const drafts: MemoryDraft[] = [];
    const seen = new Set<string>();

    for (const item of items) {
      if (drafts.length >= this.maxMemories) break;

      if (!isRecord(item)) {
        issues.push('跳过非对象记忆项');
        continue;
      }

      if (readBoolean(item.remember ?? item.shouldRemember, true) === false) continue;

      const layers = isRecord(item.layers) ? item.layers : item;
      const fact = readText(layers.fact ?? item.fact);
      let rawText = readText(item.rawText ?? item.raw_text ?? fact);

      if (fact === '' && rawText === '') {
        issues.push('跳过缺少 fact / rawText 的记忆项');
        continue;
      }

      if (rawText === '') rawText = fact;
      const normalizedFact = fact === '' ? clip(rawText, 80) : fact;
      if (rawText.length < 2) continue;

      const contentHash = hashContent(rawText);
      if (seen.has(contentHash)) {
        issues.push('批次内重复，已去重');
        continue;
      }
      seen.add(contentHash);

      const kind = isMemoryKind(item.kind) ? item.kind : inferKind(normalizedFact);
      const intensity = clampIntensity(layers.intensity ?? item.intensity);
      const tags = readTags(item.tags);
      const weight = readNumber(item.weight);
      const summary = readText(item.summary);

      drafts.push({
        scope: request.scope,
        scopeRef: request.scope === 'self' ? null : (request.scopeRef ?? '').trim(),
        kind,
        rawText,
        layers: {
          fact: normalizedFact,
          feltThen: readNullableText(layers.feltThen),
          intensity,
          thoughtThen: readNullableText(layers.thoughtThen),
          reframe: readNullableText(layers.reframe),
          recalledLater: readNullableText(layers.recalledLater),
        },
        tags,
        summary: summary === '' ? null : summary,
        weight: weight === null ? 1 : weight,
        occurredAt: normalizeIso(readText(item.occurredAt)) ?? now,
        source: {
          conversationId: request.conversationId,
          sessionId: request.sessionId,
          turnId: request.turnId,
          speaker: request.speaker ?? 'user',
        },
      });
    }

    return { drafts, issues };
  }
}

/* ─────────────────────────── 归一化辅助 ─────────────────────────── */

function extractItems(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.memories)) return value.memories;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

function readNullableText(value: unknown): string | null {
  const text = readText(value);
  return text === '' ? null : text;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function readTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const tags = new Set<string>();
  for (const tag of value) {
    if (typeof tag !== 'string') continue;
    const normalized = tag.trim().replace(/^#+/, '').trim();
    if (normalized === '' || normalized.length > 32) continue;
    tags.add(normalized);
    if (tags.size >= 8) break;
  }
  return [...tags];
}

function normalizeIso(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function inferKind(text: string): MemoryKind {
  if (/(觉得|认为|讨厌|喜欢|受不了|更愿意|比较喜欢)/.test(text)) return 'opinion';
  if (/(看到|发现|注意到|好像|似乎|感觉)/.test(text)) return 'observation';
  if (/(是|叫|住在|生日|岁|每天|总是|习惯)/.test(text)) return 'fact';
  return 'event';
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit);
}
