/**
 * 图③ 打分：score = 语义 × 衰减权重 × 情绪系数。
 *
 * 语义分两条路，谁高用谁：
 *   - 关键词路：中文 bigram + 英文词，覆盖率 0.7 + 短语命中 0.3 + 标签加成；
 *   - 向量路：bge-small-zh-v1.5 的余弦相似度（装了 embedding 适配器才走）。
 * 没有向量模型时关键词路保证插件可用，不会因为 ONNX 缺失而失忆。
 *
 * 所有函数无副作用；排序与预算在引擎里做。
 */

import {
  MEMORY_KIND_LABEL,
  emotionCoefficient,
  type Iso8601,
  type MatchSource,
  type MemoryRecord,
  type ScoredMemory,
} from '../types.js';
import { retainedWeight } from './decay.js';

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const LATIN_WORD = /[a-z0-9][a-z0-9_+#.-]*/g;
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g;

/** NFKC + 小写 + 空白折叠；检索、去重、指纹共用同一套归一。 */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 中文按 bigram 切（「项目延期」→ 项目/目延/延期），
 * 英文/数字按词切；单字成词时保留单字。
 */
export function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  const tokens = new Set<string>();

  for (const match of normalized.matchAll(LATIN_WORD)) {
    if (match[0].length >= 2) tokens.add(match[0]);
  }

  for (const match of normalized.matchAll(CJK_RUN)) {
    const run = match[0];
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      tokens.add(run.slice(i, i + 2));
    }
  }

  return [...tokens];
}

/** 一条记忆可被检索的全部文本。原文永远在内，摘要只是额外信号。 */
export function memoryText(memory: MemoryRecord): string {
  return [
    memory.layers.fact,
    memory.layers.feltThen,
    memory.layers.thoughtThen,
    memory.layers.reframe,
    memory.layers.recalledLater,
    memory.rawText,
    memory.summary,
    memory.tags.map((tag) => `#${tag}`).join(' '),
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
}

/** 给预算估算与未来 PromptFormatter 用的单行摘要。 */
export function memoryDigest(memory: MemoryRecord): string {
  const pieces = [`[${MEMORY_KIND_LABEL[memory.kind]}]`, memory.layers.fact];
  if (memory.layers.feltThen) pieces.push(`当时：${memory.layers.feltThen}`);
  if (memory.layers.reframe) pieces.push(`后来：${memory.layers.reframe}`);
  return pieces.join(' ');
}

export interface ScoreMemoryInput {
  memory: MemoryRecord;
  queryText: string;
  queryTokens: ReadonlySet<string>;
  now: Iso8601;
  queryVector: Float32Array | null;
  memoryVector: Float32Array | null;
}

/**
 * 单条打分。语义为 0 表示与查询无关，引擎会直接丢弃，不进入预算竞争。
 */
export function scoreMemory(input: ScoreMemoryInput): ScoredMemory {
  const { memory, queryText, queryTokens, now, queryVector, memoryVector } = input;

  const text = memoryText(memory);
  const memoryTokens = new Set(tokenize(text));

  let hits = 0;
  for (const token of queryTokens) {
    if (memoryTokens.has(token)) hits += 1;
  }
  const coverage = queryTokens.size === 0 ? 0 : hits / queryTokens.size;

  const normalizedQuery = normalizeText(queryText);
  const phraseHit =
    normalizedQuery.length >= 2 && normalizeText(text).includes(normalizedQuery) ? 0.3 : 0;

  let tagHits = 0;
  for (const tag of memory.tags) {
    const normalizedTag = normalizeText(tag);
    if (normalizedTag.length > 0 && normalizedQuery.includes(normalizedTag)) tagHits += 1;
  }
  const tagBonus = Math.min(0.2, tagHits * 0.1);

  let semantic = Math.min(1, coverage * 0.7 + phraseHit + tagBonus);
  let matchedBy: MatchSource = 'keyword';

  if (queryVector !== null && memoryVector !== null) {
    const vectorScore = Math.max(0, cosineSimilarity(queryVector, memoryVector));
    if (vectorScore > semantic) {
      semantic = Math.min(1, vectorScore);
      matchedBy = 'embedding';
    }
  }

  const decayedWeight = retainedWeight(memory, now);
  const emotion = emotionCoefficient(memory.layers.intensity);
  const score = semantic * decayedWeight * emotion;

  return {
    memory,
    score,
    semantic,
    decayedWeight,
    emotion,
    matchedBy,
    hops: 0,
  };
}

/** 余弦相似度，范围 -1..1；维度不一致按 0（模型换过就重建索引，不硬算）。 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** SQLite BLOB → Float32Array；用 DataView 规避对齐问题。 */
export function decodeVector(blob: Uint8Array, dim: number): Float32Array {
  const copy = new Uint8Array(blob);
  const available = Math.floor(copy.byteLength / 4);
  const length = Math.max(0, Math.min(dim, available));
  const out = new Float32Array(length);
  const view = new DataView(copy.buffer, copy.byteOffset, length * 4);

  for (let i = 0; i < length; i += 1) {
    out[i] = view.getFloat32(i * 4, true);
  }

  return out;
}

/**
 * 粗略 token 估算：中文按 1 token/字，其他按 0.3，向上取整。
 * 只用于预算控制，不追求 tokenizer 精确值。
 */
export function estimateTokens(text: string): number {
  let units = 0;
  for (const char of text) {
    units += CJK.test(char) ? 1 : 0.3;
  }
  return Math.ceil(units);
}
