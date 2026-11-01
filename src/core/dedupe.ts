/**
 * 图①「6 小时防重：同一件事不重复记」。
 *
 * 三层判定，短路返回：
 *   1. 墓碑：6 小时内刚被清理过的同一段内容，不允许立刻复活；
 *   2. 指纹：归一化后 sha256 完全相同；
 *   3. 相似度：字符 bigram Dice 系数 ≥ 阈值（默认 0.92，挡“换了个标点/语气词”）。
 *
 * 相似度不做语义改写判定——那需要模型，代价高且不稳定；真正改写过的内容
 * 交给 23:00 的合并任务处理。防重的目标是“别把同一句车轱辘话记两遍”。
 */

import { createHash } from 'node:crypto';

import type { DedupeVerdict } from '../types.js';
import { normalizeText } from './scoring.js';

/** 去掉空白、标点、符号后的规范文本；用于指纹与相似度。 */
export function canonicalText(raw: string): string {
  return normalizeText(raw).replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function hashContent(raw: string): string {
  return createHash('sha256').update(canonicalText(raw), 'utf8').digest('hex');
}

/** 字符 bigram Dice 系数，0-1；长度 1 时退化为字符集合。 */
export function textSimilarity(a: string, b: string): number {
  const left = canonicalText(a);
  const right = canonicalText(b);

  if (!left || !right) return 0;
  if (left === right) return 1;

  const leftGrams = shingles(left);
  const rightGrams = shingles(right);

  let intersection = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) intersection += 1;
  }

  const total = leftGrams.size + rightGrams.size;
  return total === 0 ? 0 : (2 * intersection) / total;
}

function shingles(text: string): Set<string> {
  const grams = new Set<string>();
  if (text.length === 1) {
    grams.add(text);
    return grams;
  }
  for (let i = 0; i < text.length - 1; i += 1) {
    grams.add(text.slice(i, i + 2));
  }
  return grams;
}

export interface DuplicateCandidate {
  id: string;
  rawText: string;
  contentHash: string;
}

export interface DuplicateInput {
  rawText: string;
  contentHash: string;
  candidates: readonly DuplicateCandidate[];
  /** 6 小时内被物理删除的同指纹记忆 id；没有则为 null。 */
  tombstoneId: string | null;
  threshold: number;
}

export function evaluateDuplicate(input: DuplicateInput): DedupeVerdict {
  if (input.tombstoneId !== null) {
    return {
      duplicate: true,
      reason: 'tombstone',
      existingId: input.tombstoneId,
      similarity: null,
    };
  }

  for (const candidate of input.candidates) {
    if (candidate.contentHash === input.contentHash) {
      return {
        duplicate: true,
        reason: 'hash',
        existingId: candidate.id,
        similarity: 1,
      };
    }
  }

  let bestId: string | null = null;
  let bestSimilarity = 0;

  for (const candidate of input.candidates) {
    const similarity = textSimilarity(input.rawText, candidate.rawText);
    if (similarity >= input.threshold && similarity > bestSimilarity) {
      bestId = candidate.id;
      bestSimilarity = similarity;
    }
  }

  if (bestId !== null) {
    return {
      duplicate: true,
      reason: 'similarity',
      existingId: bestId,
      similarity: bestSimilarity,
    };
  }

  return { duplicate: false, reason: 'none', existingId: null, similarity: null };
}
