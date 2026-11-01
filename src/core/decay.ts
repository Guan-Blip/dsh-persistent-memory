/**
 * 半衰期衰减（图⑤「权重按半衰期衰减，FRS 形式」）。
 *
 * 采用等价的半衰期写法：R(t) = 0.5 ^ (t / halfLife)，t 为「距上次被加强的天数」。
 * 加强点 = max(写入时间, 最近被想起时间, 最近复习时间)——回忆会刷新遗忘计时，
 * 这符合「被想起次数」参与记忆强度的直觉；复习另外通过 ×1.6 抬基础权重。
 *
 * 纯函数、时间全部由调用方注入，90/60/45/30 与 90/365 的边界可以在测试里精确断言。
 */

import type { Iso8601, LifecycleConfig, MemoryRecord } from '../types.js';

export const DAY_MS = 86_400_000;

export interface DecayState {
  weight: number;
  halfLifeDays: number;
  createdAt: Iso8601;
  lastRecalledAt: Iso8601 | null;
  lastReviewedAt: Iso8601 | null;
}

export interface LifecycleView extends DecayState {
  state: MemoryRecord['state'];
  isValid: boolean;
}

/** 两个 ISO 时间相差多少天；解析失败按 0 处理，绝不产生 NaN 传染排序。 */
export function daysBetween(fromIso: Iso8601, toIso: Iso8601): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return (to - from) / DAY_MS;
}

/** 衰减起点：写入 / 想起 / 复习三者的最晚时刻。 */
export function decayAnchor(memory: Pick<DecayState, 'createdAt' | 'lastRecalledAt' | 'lastReviewedAt'>): Iso8601 {
  let anchor = memory.createdAt;
  let anchorMs = Date.parse(anchor);

  for (const candidate of [memory.lastRecalledAt, memory.lastReviewedAt]) {
    if (candidate === null) continue;
    const ms = Date.parse(candidate);
    if (Number.isFinite(ms) && ms > anchorMs) {
      anchorMs = ms;
      anchor = candidate;
    }
  }

  return anchor;
}

/** 留存率 0-1：0 天 = 1，恰好一个半衰期 = 0.5。 */
export function retention(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(ageDays) || !Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    return 0;
  }
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** 当前有效权重 = 基础权重 × 半衰期留存率。 */
export function retainedWeight(memory: DecayState, nowIso: Iso8601): number {
  const age = Math.max(0, daysBetween(decayAnchor(memory), nowIso));
  return memory.weight * retention(age, memory.halfLifeDays);
}

/** 距上次被加强（想起/复习/写入）多少天；「90 天没用」用它。 */
export function inactiveDays(
  memory: Pick<DecayState, 'createdAt' | 'lastRecalledAt' | 'lastReviewedAt'>,
  nowIso: Iso8601,
): number {
  return Math.max(0, daysBetween(decayAnchor(memory), nowIso));
}

/**
 * 图⑤「冷存：很淡且 90 天没用」。
 * 两个条件必须同时满足：inactiveDays >= coldAfterDays，且有效权重低于阈值。
 * 封存（sealed）与归档（archived）不参与冷存。
 */
export function shouldGoCold(
  memory: LifecycleView,
  nowIso: Iso8601,
  config: Pick<LifecycleConfig, 'coldAfterDays' | 'coldRetentionThreshold'>,
): boolean {
  if (memory.state !== 'active' || !memory.isValid) return false;
  if (inactiveDays(memory, nowIso) < config.coldAfterDays) return false;
  return retainedWeight(memory, nowIso) < config.coldRetentionThreshold;
}

/** 图⑤「清理：冷存满 365 天」；归档状态不调用本函数。 */
export function purgeDue(
  coldAt: Iso8601 | null,
  nowIso: Iso8601,
  purgeAfterDays: number,
): boolean {
  if (coldAt === null) return false;
  return daysBetween(coldAt, nowIso) >= purgeAfterDays;
}
