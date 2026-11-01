/**
 * 图④「自己维护」的调度框架。
 *
 * 四个默认档期（本地时间）：
 *   00:00  复习 3 条 + 生命周期扫描
 *   23:00  合并精确重复
 *   23:50  自动补事实（默认跳过，等待注入 LLM 处理器）
 *   周日 22:30  写《这周》（默认跳过，等待注入 LLM 处理器）
 *
 * 可靠性：
 *   - 每 30 秒 tick 一次，计算「最近一次应该跑但没跑」的档期；
 *   - maintenance_runs 的 UNIQUE(job, scheduled_for) 保证同一档期只跑一次；
 *   - 睡眠/关机错过的档期，下次启动补跑最近一次（默认回看 2 天）。
 */

import { randomUUID } from 'node:crypto';

import { DAY_MS } from '../core/decay.js';
import type { MemoryEngine } from '../core/MemoryEngine.js';
import type { Iso8601, MemoryLogger } from '../types.js';

export type MaintenanceJobName =
  | 'nightly_review'
  | 'consolidate'
  | 'daily_digest'
  | 'weekly_story';

export interface MaintenanceSchedule {
  hour: number;
  minute: number;
  /** 0=周日 … 6=周六；省略表示每天。 */
  weekday?: number;
}

export interface MaintenanceContext {
  engine: MemoryEngine;
  now: Iso8601;
  scheduledFor: Iso8601;
}

export interface MaintenanceOutcome {
  status: 'succeeded' | 'skipped';
  stats?: Record<string, unknown>;
  note?: string;
}

export type MaintenanceHandler = (
  context: MaintenanceContext,
) => Promise<MaintenanceOutcome>;

export interface JobRun {
  job: MaintenanceJobName;
  scheduledFor: Iso8601;
  status: 'succeeded' | 'failed' | 'skipped';
  note?: string;
}

export interface SchedulerOptions {
  engine: MemoryEngine;
  /** 覆盖任意档期；不覆盖则用默认实现。 */
  handlers?: Partial<Record<MaintenanceJobName, MaintenanceHandler>>;
  tickMs?: number;
  /** 启动补跑回看天数，默认 2。 */
  catchUpDays?: number;
  logger?: MemoryLogger;
}

interface JobDefinition {
  name: MaintenanceJobName;
  schedule: MaintenanceSchedule;
  handler: MaintenanceHandler;
}

const DEFAULT_SCHEDULES: Record<MaintenanceJobName, MaintenanceSchedule> = {
  nightly_review: { hour: 0, minute: 0 },
  consolidate: { hour: 23, minute: 0 },
  daily_digest: { hour: 23, minute: 50 },
  weekly_story: { hour: 22, minute: 30, weekday: 0 },
};

const SILENT_LOGGER: MemoryLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class Scheduler {
  private readonly engine: MemoryEngine;
  private readonly logger: MemoryLogger;
  private readonly tickMs: number;
  private readonly catchUpDays: number;
  private readonly jobs: JobDefinition[];

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: SchedulerOptions) {
    this.engine = options.engine;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.tickMs = Math.max(1_000, options.tickMs ?? 30_000);
    this.catchUpDays = Math.max(1, options.catchUpDays ?? 2);
    this.jobs = createJobs(options.engine, options.handlers ?? {});
  }

  /** 立即补跑一次，再按 tick 周期检查；unref 不阻止进程退出。 */
  start(): void {
    if (this.timer !== null) return;

    void this.runDue();
    this.timer = setInterval(() => {
      void this.runDue();
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 跑「最近一个已到点」的档期。同一 scheduled_for 只会成功占位一次，
   * 因此重复调用、多进程同时调用都不会重复执行。
   */
  async runDue(nowInput?: Date): Promise<JobRun[]> {
    if (this.running) return [];
    this.running = true;

    const now = nowInput ?? new Date();
    const runs: JobRun[] = [];

    try {
      for (const job of this.jobs) {
        const scheduled = lastScheduledAt(now, job.schedule);
        if (now.getTime() - scheduled.getTime() > this.catchUpDays * DAY_MS) continue;

        const scheduledFor = scheduled.toISOString();
        const runId = randomUUID();
        const startedAt = this.engine.clock.now().toISOString();

        const begun = this.engine.repository.beginMaintenanceRun({
          id: runId,
          job: job.name,
          scheduledFor,
          startedAt,
        });
        if (!begun) continue; // 该档期已经跑过

        try {
          const outcome = await job.handler({
            engine: this.engine,
            now: startedAt,
            scheduledFor,
          });

          this.engine.repository.finishMaintenanceRun(
            runId,
            outcome.status,
            this.engine.clock.now().toISOString(),
            outcome.stats === undefined ? null : JSON.stringify(outcome.stats),
            outcome.note ?? null,
          );

          runs.push({
            job: job.name,
            scheduledFor,
            status: outcome.status,
            ...(outcome.note === undefined ? {} : { note: outcome.note }),
          });
          this.logger.debug(`维护任务 ${job.name} 完成`, {
            scheduledFor,
            status: outcome.status,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.engine.repository.finishMaintenanceRun(
            runId,
            'failed',
            this.engine.clock.now().toISOString(),
            null,
            message,
          );
          this.logger.error(`维护任务 ${job.name} 失败`, { error: message });
          runs.push({ job: job.name, scheduledFor, status: 'failed', note: message });
        }
      }

      return runs;
    } finally {
      this.running = false;
    }
  }
}

function createJobs(
  engine: MemoryEngine,
  overrides: Partial<Record<MaintenanceJobName, MaintenanceHandler>>,
): JobDefinition[] {
  const defaults: Record<MaintenanceJobName, MaintenanceHandler> = {
    nightly_review: async ({ now }) => {
      const sweep = await engine.sweepLifecycle(now);
      const reviews = await engine.reviewMemories(3, now);

      return {
        status: 'succeeded',
        stats: {
          scanned: sweep.scanned,
          markedCold: sweep.markedCold.length,
          purged: sweep.purged.length,
          reviewed: reviews.length,
        },
      };
    },

    consolidate: async () => {
      const merge = await engine.mergeExactDuplicates();
      return { status: 'succeeded', stats: { ...merge } };
    },

    daily_digest: async () => ({
      status: 'skipped',
      note: '未注入日报生成器：23:50 自动补事实需要宿主提供 LLM 处理器',
    }),

    weekly_story: async () => ({
      status: 'skipped',
      note: '未注入周记生成器：周日 22:30 写《这周》需要宿主提供 LLM 处理器',
    }),
  };

  return (Object.keys(DEFAULT_SCHEDULES) as MaintenanceJobName[]).map((name) => ({
    name,
    schedule: DEFAULT_SCHEDULES[name],
    handler: overrides[name] ?? defaults[name],
  }));
}

/** 本地时间下，最近一次 <= now 的档期。 */
export function lastScheduledAt(now: Date, schedule: MaintenanceSchedule): Date {
  const candidate = new Date(now);
  candidate.setHours(schedule.hour, schedule.minute, 0, 0);

  if (schedule.weekday === undefined) {
    if (candidate.getTime() > now.getTime()) {
      candidate.setDate(candidate.getDate() - 1);
    }
    return candidate;
  }

  const dayDiff = (candidate.getDay() - schedule.weekday + 7) % 7;
  candidate.setDate(candidate.getDate() - dayDiff);
  if (candidate.getTime() > now.getTime()) {
    candidate.setDate(candidate.getDate() - 7);
  }
  return candidate;
}
