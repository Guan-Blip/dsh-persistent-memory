/**
 * 图③「[世界资料] 五节」的数据装配。
 *
 * 这一层只做「从仓储里捞当轮需要的上下文」，不拼提示词：
 *   今天       → 当前本地日期 + 星期
 *   心情       → 最近 7 天强度 ≥ 6 的最高一条
 *   今天发生   → occurred_at 落在本地今天的事件
 *   未完成     → 标签「未完成 / 待办」的记忆
 *   最近聊过   → 本会话最近 3 条
 *
 * 全部走 scope 可见性：本体共享，面具/项目只见自己那条线。
 */

import type { Clock } from '../core/MemoryEngine.js';
import type { MemoryRepository } from '../adapters/storage/MemoryRepository.js';
import type { Iso8601, Scope, WorldContext } from '../types.js';

export interface WorldContextRequest {
  scope: Scope;
  scopeRef: string | null;
  sessionId: string;
  now?: Iso8601;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;
const OPEN_LOOP_TAGS = ['未完成', '待办'] as const;

export class WorldContextBuilder {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly clock: Clock,
  ) {}

  build(request: WorldContextRequest): WorldContext {
    const now = request.now ?? this.clock.now().toISOString();
    const date = new Date(now);
    const start = startOfLocalDay(date);
    const end = new Date(start.getTime() + 86_400_000);

    const moodMemory = this.repo.findEmotionalSince(
      new Date(date.getTime() - 7 * 86_400_000).toISOString(),
      6,
      request.scope,
      request.scopeRef,
      1,
    )[0];

    const mood =
      moodMemory === undefined
        ? null
        : `${moodMemory.layers.feltThen ?? moodMemory.layers.fact}（${moodMemory.layers.intensity.toFixed(1)}/10）`;

    const todayEvents = this.repo
      .findOccurredBetween(
        start.toISOString(),
        end.toISOString(),
        request.scope,
        request.scopeRef,
        5,
      )
      .map((memory) => memory.layers.fact);

    const openLoops: string[] = [];
    const seen = new Set<string>();
    for (const tag of OPEN_LOOP_TAGS) {
      for (const memory of this.repo.findByTag(tag, request.scope, request.scopeRef, 3)) {
        if (seen.has(memory.id)) continue;
        seen.add(memory.id);
        openLoops.push(memory.layers.fact);
        if (openLoops.length >= 3) break;
      }
      if (openLoops.length >= 3) break;
    }

    const recent = this.repo
      .findSessionRecent(request.sessionId, request.scope, request.scopeRef, 3)
      .map((memory) => memory.layers.fact);

    return {
      now,
      today: `${localDate(date)} ${WEEKDAYS[date.getDay()] ?? ''}`.trim(),
      mood,
      todayEvents,
      openLoops,
      recent,
    };
  }
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function localDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
