/**
 * DeepSeek Harness 薄适配层。
 *
 * 只做三件事：
 *   1. 把 DSH 的一轮上下文（userText / history / sessionId / scope）翻译成引擎输入；
 *   2. 把 PromptFormatter 的结果交回给宿主，由宿主决定塞进 messages 的位置；
 *   3. 模型成功后 markRecalled，并在轮次结束后异步提取 + 落盘。
 *
 * 刻意不 import 任何 DSH 运行时包：DSH 侧只需要在 hook 里调用 prepare / inject / complete。
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { MemoryEngine } from '../../core/MemoryEngine.js';
import { escapeStructure, trimHistory } from '../../core/guard.js';
import { EXPECTED_TABLES, type SqliteDatabase } from '../../core/schema.js';
import { InvalidMemoryError } from '../../errors.js';
import { MemoryExtractor, type ExtractionResult } from '../../extractor/MemoryExtractor.js';
import { PromptFormatter, MANUAL_TAG } from '../../injector/PromptFormatter.js';
import { WorldContextBuilder } from '../../injector/WorldContextBuilder.js';
import { Scheduler } from '../../maintenance/Scheduler.js';
import {
  DEFAULT_MEMORY_ROOT,
  type DialogueTurn,
  type InjectionPayload,
  type Iso8601,
  type MemoryRecord,
  type Scope,
} from '../../types.js';
import { assertNotSystemPath, detectAvailableDrives, pickMemoryRoot } from '../../utils/paths.js';
import { DeepSeekClient } from '../llm/LlmClient.js';
import { hasNodeSqlite, openNodeSqliteDatabase } from '../storage/NodeSqliteAdapter.js';

export interface DshMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** DSH 每轮 hook 能拿到的字段；history 是本轮之前的消息，不含当前 userText。 */
export interface DshTurnContext {
  sessionId: string;
  conversationId: string;
  turnId: string;
  userText: string;
  history?: readonly DshMessage[];
  scope?: Scope;
  scopeRef?: string | null;
  now?: Iso8601;
}

export interface DshPreparedTurn {
  turnId: string;
  scope: Scope;
  scopeRef: string | null;
  payload: InjectionPayload;
  /** null 表示预算内没有可注入内容，宿主不要塞空 system。 */
  systemPrompt: string | null;
  memoryIds: string[];
}

export interface DshTurnResult {
  /** 实际 markRecalled 的条数。 */
  recalled: number;
  saved: MemoryRecord[];
  duplicates: number;
  extraction: ExtractionResult | null;
}

export interface DshAdapterOptions {
  engine: MemoryEngine;
  extractor?: MemoryExtractor | null;
  formatter?: PromptFormatter;
  worldBuilder?: WorldContextBuilder;
  /** 默认 true：轮次结束后自动提取并写库。 */
  autoExtract?: boolean;
}

export class DshAdapter {
  private readonly engine: MemoryEngine;
  private readonly extractor: MemoryExtractor | null;
  private readonly formatter: PromptFormatter;
  private readonly worldBuilder: WorldContextBuilder;
  private readonly autoExtract: boolean;

  constructor(options: DshAdapterOptions) {
    this.engine = options.engine;
    this.extractor = options.extractor ?? null;
    this.formatter = options.formatter ?? new PromptFormatter();
    this.worldBuilder =
      options.worldBuilder ??
      new WorldContextBuilder(options.engine.repository, options.engine.clock);
    this.autoExtract = options.autoExtract ?? true;
  }

  /** 模型调用前：召回 + 五节世界资料 + 组装。此时还没有「想起来」。 */
  async prepare(ctx: DshTurnContext): Promise<DshPreparedTurn> {
    const { scope, scopeRef } = normalizeContext(ctx);
    const now = ctx.now ?? this.engine.clock.now().toISOString();

    const recalled = await this.engine.recall({
      text: ctx.userText,
      scope,
      scopeRef,
      sessionId: ctx.sessionId,
      now,
    });

    const payload = this.formatter.format({ memories: recalled.items });

    return {
      turnId: ctx.turnId,
      scope,
      scopeRef,
      payload,
      systemPrompt: payload.text.length > 0 ? payload.text : null,
      memoryIds: payload.memories.map((item) => item.memory.id),
    };
  }

  /** 把注入块放进 messages 头部；已有 system 的宿主可以改成合并而不是新增。 */
  inject(messages: readonly DshMessage[], prepared: DshPreparedTurn): DshMessage[] {
    if (prepared.systemPrompt === null) return [...messages];
    return [{ role: 'system', content: prepared.systemPrompt }, ...messages];
  }

  /**
   * 模型返回后调用。
   *
   * success=false（超时/取消/报错）时绝不 markRecalled：记忆没有真正参与推理，
   * 不能给它续命。提取默认仍然执行，避免这一轮的内容彻底丢失。
   */
  async complete(
    ctx: DshTurnContext,
    prepared: DshPreparedTurn,
    reply: string,
    options: { success?: boolean; extract?: boolean } = {},
  ): Promise<DshTurnResult> {
    const { scope, scopeRef } = normalizeContext(ctx);
    const now = ctx.now ?? this.engine.clock.now().toISOString();
    const success = options.success ?? true;

    let recalled = 0;
    if (success && prepared.memoryIds.length > 0) {
      recalled = await this.engine.markRecalled(prepared.memoryIds, now);
    }

    const result: DshTurnResult = {
      recalled,
      saved: [],
      duplicates: 0,
      extraction: null,
    };

    if (
      options.extract === false ||
      !this.autoExtract ||
      this.extractor === null ||
      reply.trim().length === 0
    ) {
      return result;
    }

    const turns: DialogueTurn[] = [
      ...(ctx.history ?? []).map((message) => ({
        role: message.role,
        content: message.content,
      })),
      { role: 'user', content: ctx.userText },
      { role: 'assistant', content: reply },
    ];

    const extraction = await this.extractor.extract({
      turns,
      scope,
      scopeRef,
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      occurredAt: now,
    });

    result.extraction = extraction;

    for (const draft of extraction.drafts) {
      const saved = await this.engine.saveMemory(draft);
      if (saved.saved && saved.record !== null) {
        result.saved.push(saved.record);
      } else {
        result.duplicates += 1;
      }
    }

    return result;
  }
}

function normalizeContext(ctx: DshTurnContext): {
  scope: Scope;
  scopeRef: string | null;
} {
  const scope = ctx.scope ?? 'self';
  const scopeRef = scope === 'self' ? null : (ctx.scopeRef ?? '').trim();

  if (scope !== 'self' && scopeRef === '') {
    throw new InvalidMemoryError(`${scope} 线必须提供 scopeRef（uid / slug）。`);
  }

  return {
    scope,
    scopeRef: scopeRef === '' ? null : scopeRef,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * DSH 插件入口（Cordis apply 范式）
 *
 * 上面是「引擎 ↔ 宿主」的可复用适配类；这里是 DSH 侧的薄壳：
 *   - 模型调用前（agent/pre-step）召回，经 systemPrompt.section 注入；
 *   - 模型成功返回（session/event: assistant/message）markRecalled；
 *   - 一轮结束（session/event: turn/end）异步提取 + saveMemory。
 *
 * 刻意不 import 任何 @deepseek-ai/* 包：ctx 用结构化类型描述，这样本包
 * 既能被 DSH 加载，也能在纯 Node 里被 require/测试，不会把宿主版本焊死。
 * ══════════════════════════════════════════════════════════════════════════ */

/** Cordis 插件名（loader 日志用）。 */
export const name = 'ai-persistent-memory';

/**
 * 依赖声明：等 systemPrompt 服务就绪再激活。
 * 工具（memory_recall 等）不在这里注册——本包只做「自动召回 + 自动落盘」，
 * 工具面由单独的 tools 插件提供，避免同名工具重复注册。
 */
export const inject = ['systemPrompt'];

/** 数据库驱动。auto = 优先 node:sqlite，失败回落 better-sqlite3。 */
export type MemoryDatabaseDriver = 'auto' | 'node-sqlite' | 'better-sqlite3';

/** patches/bundle.yaml 里 config 的字段。 */
export interface DshPluginConfig {
  /** 记忆库目录（只能是非系统盘）。默认 D:\AI_Memory。 */
  memoryDbPath?: string;
  driver?: MemoryDatabaseDriver;
  topK?: number;
  budgetTokens?: number;
  /** 轮次结束后用 LLM 抽取五层结构记忆；需要 DEEPSEEK_API_KEY。 */
  extract?: boolean;
  /** 没有 API Key 时退化为整轮原文落盘。 */
  rawFallback?: boolean;
  /** 常驻进程内启动遗忘调度器。 */
  maintenance?: boolean;
  scope?: Scope;
  scopeRef?: string | null;
}

/** Cordis systemPrompt 段落。 */
interface DshPromptSection {
  name: string;
  order?: number;
  text: (assembly: unknown) => string;
}

/** 只声明用得到的 Cordis Context 成员，避免依赖具体版本。 */
export interface DshPluginContext {
  effect(setup: () => () => void, label?: string): unknown;
  on(
    event: string,
    listener: (...args: any[]) => any,
    options?: { global?: boolean; prepend?: boolean },
  ): unknown;
  inject(dependencies: readonly string[], callback: (ctx: DshPluginContext) => void): unknown;
  systemPrompt: { section(section: DshPromptSection): () => void };
  /** @deepseek-ai/dsh-host-webserver；没有 Web 宿主的 profile 里不存在。 */
  webServer?: DshWebServer;
}

/** HTTP 路由表：`kind` 决定精确匹配还是前缀匹配。 */
export interface DshWebServer {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: DshHttpRequest, res: DshHttpResponse) => unknown;
  }): () => void;
}

export interface DshHttpRequest {
  method?: string;
  url?: string;
  /** node IncomingMessage 的事件接口（读 POST body 用）。 */
  on?(event: 'data' | 'end' | 'error', listener: (chunk?: any) => void): void;
}

export interface DshHttpResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

/** 设置面板消费的接口。 */
export const STATS_ROUTE = '/api/ai-persistent-memory/stats';
export const CLEAR_ROUTE = '/api/ai-persistent-memory/clear';
export const NUKE_ROUTE = '/api/ai-persistent-memory/nuke';
export const SETTINGS_ROUTE = '/api/ai-persistent-memory/settings';
export const MEMORIZE_ROUTE = '/api/ai-persistent-memory/memorize';
export const MAINTENANCE_ROUTE = '/api/ai-persistent-memory/maintenance';

/** 定时维护的记账键与周期。 */
export const LAST_MAINTENANCE_KEY = 'plugin.last_maintenance';
export const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function clampSensitivity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.sensitivity;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 敏感度 → 召回门槛：100 - 敏感度（百分比）。 */
export function minScoreFromSensitivity(sensitivity: number): number {
  return Math.max(0, Math.min(1, (100 - clampSensitivity(sensitivity)) / 100));
}

/** 纯寒暄：打招呼时不该硬塞记忆。 */
const GREETINGS = [
  '你好', '您好', '在吗', '在不在', '早', '早上好', '早安', '晚上好', '晚安',
  '谢谢', '多谢', '辛苦', '哈哈', '嗨', 'hi', 'hello', 'hey', 'yo', 'thanks', 'thx', 'ok', '好的',
];

export function isGreeting(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
  if (normalized.length === 0) return true;
  if (normalized.length > 8) return false;
  return GREETINGS.some((word) => normalized === word || normalized.startsWith(word));
}

/** 提问/反问标记：这些句子是在索要信息，不是陈述事实。 */
const QUESTION_PATTERN = /\?|？|吗|呢|什么|怎么|为什么|为啥|哪[个里儿]|多少|几点|是不是|能不能|可不可以|好不好|行不行|对不对/;

/** 纯语气词 / 表情 / 客套。 */
const FILLER_PATTERN = /^(哈+|嗯+|哦+|呃+|好+|好的?|行|收到|懂了|明白|ok|okay|谢谢|多谢|辛苦了?|厉害|牛|赞|笑死|太棒了|晚安|早安)([\s!！。,.，~～]+)?$/i;

/**
 * 本地语义兜底（无 LLM 时的原文落盘闸门）。
 *
 * 只挡三类垃圾：提问、寒暄/语气词、过短无信息量。
 * 真正细粒度的语义判断交给 MemoryExtractor 的 prompt（有 Key 时走大模型）。
 */
export function isLowValueUtterance(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (isGreeting(trimmed)) return true;
  if (QUESTION_PATTERN.test(trimmed)) return true;
  if (FILLER_PATTERN.test(trimmed)) return true;
  // 去掉标点后不足 8 个字符：基本没有可复用信息
  const dense = trimmed.replace(/[\s\p{P}\p{S}]+/gu, '');
  return dense.length < 8;
}

/** 记忆写入模式：auto=自动抽取，manual=只在显式要求时写，off=完全不写。 */
export type MemoryWriteMode = 'auto' | 'manual' | 'off';

/** 运行时开关；持久化在 SQLite 的 `meta` 表里。 */
export interface MemorySettings {
  /** 开关1：自动召回并注入记忆。关闭后 AI 完全不读记忆。 */
  autoInject: boolean;
  /** 开关2：轮次结束后自动提取并写入新记忆。关闭后只查不记。 */
  autoExtract: boolean;
  /** 开关3：强制把注入预算压到 800 token。 */
  hardBudget: boolean;
  /** 开关4：上下文滑动窗口，只保留最近若干条历史，防 Context 溢出。 */
  slidingWindow: boolean;
  /** 写入模式；非 auto 时后台不再抽取，直接省 Token。 */
  writeMode: MemoryWriteMode;
  /** 用户自定义人设（会被包进固定安全外壳后注入）。 */
  persona: string;
  /** 记忆敏感度 0-100；minScore = (100 - sensitivity) / 100。 */
  sensitivity: number;
  /** 高兼容注入：厚重外壳换成直白事实块，适配第三方弱模型。默认关闭。 */
  compat: boolean;
  /** 清空时保留几份快照（1-50，默认 3）；快照放在 <memoryDbPath>\backups。 */
  backupRetention: number;
  /** 面板选择的存储位置（空串 = 用插件配置/自动选盘）。改完需重启生效。 */
  memoryRoot: string;
}

export const DEFAULT_SETTINGS: MemorySettings = Object.freeze({
  autoInject: true,
  autoExtract: true,
  hardBudget: false,
  slidingWindow: false,
  writeMode: 'auto' as MemoryWriteMode,
  persona: '',
  sensitivity: 50,
  compat: false,
  backupRetention: 3,
  memoryRoot: '',
});

/** 开关3 打开时的硬上限。 */
export const HARD_BUDGET_TOKENS = 800;

/** 滑动窗口保留的消息条数（约 5 轮问答）。 */
export const HISTORY_LIMIT = 10;

/** meta 表的键名（与 schema_version 等系统键并列，互不冲突）。 */
const SETTING_KEYS: Record<keyof MemorySettings, string> = {
  autoInject: 'plugin.auto_inject',
  autoExtract: 'plugin.auto_extract',
  hardBudget: 'plugin.hard_budget',
  slidingWindow: 'plugin.sliding_window',
  writeMode: 'plugin.write_mode',
  persona: 'plugin.persona',
  sensitivity: 'plugin.sensitivity',
  compat: 'plugin.compat',
  backupRetention: 'plugin.backup_retention',
  memoryRoot: 'plugin.memory_root',
};

interface PendingTurn {
  userText: string;
  block: string;
  ids: string[];
}

interface TurnBuffer {
  userText: string;
  assistantText: string;
}

/**
 * DSH 插件入口。由 loader 在 bundle patch 的 insert 行匹配后调用。
 *
 * 初始化失败（例如记忆库路径落在 C 盘）时：打印明确错误并让插件保持未激活，
 * 不抛给宿主——DSH 本身照常可用，但绝不会静默换到别的路径。
 */
export async function apply(ctx: DshPluginContext, config: DshPluginConfig = {}): Promise<void> {
  let engine: MemoryEngine;

  try {
    engine = createEngine(config);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[ai-persistent-memory] 插件未激活：记忆库初始化失败。${detail}`);
    return;
  }

  ctx.effect(() => () => engine.close(), 'ai-persistent-memory: close database');

  const budgetTokens = config.budgetTokens ?? 1200;
  const scope = config.scope ?? 'self';
  const scopeRef = scope === 'self' ? null : (config.scopeRef ?? '').trim();

  const formatter = new PromptFormatter({ budgetTokens });
  const extractor = resolveExtractor(engine, config);

  const driver = config.driver ?? 'auto';

  /** 三个开关的运行时镜像；真相在 SQLite meta 表里，改完立即生效。 */
  let settings: MemorySettings = DEFAULT_SETTINGS;
  try {
    settings = readSettings(engine, driver);
  } catch (error) {
    warn('读取运行时开关失败，先用默认值', error);
  }

  /**
   * 面板里改过「存储位置」：以 meta 里的 plugin.memory_root 为准。
   * 这里才切换引擎——因为设置本身就存在数据库里，必须先打开当前库才能读到它。
   */
  const preferredRoot = settings.memoryRoot.trim();
  if (preferredRoot.length > 0 && path.resolve(preferredRoot) !== path.resolve(engine.paths.root)) {
    try {
      const next = createEngine({ ...config, memoryDbPath: preferredRoot });
      engine.close();
      engine = next;
      settings = readSettings(engine, driver);
      console.info(`[ai-persistent-memory] 已切换到面板设置的存储位置：${engine.paths.root}`);
    } catch (error) {
      warn(`切换存储位置失败，继续使用 ${engine.paths.root}`, error);
    }
  }

  /** 开关3：预算硬顶。 */
  const effectiveBudget = (): number =>
    settings.hardBudget ? Math.min(budgetTokens, HARD_BUDGET_TOKENS) : budgetTokens;

  /** agentId -> 本轮召回结果（systemPrompt 段落是同步读的，先算好放这里） */
  const pending = new Map<string, PendingTurn>();
  /** sessionId -> 本轮原文，攒够 user + assistant 后一次性抽取 */
  const turns = new Map<string, TurnBuffer>();

  ctx.inject(['systemPrompt'], (sctx) => {
    sctx.effect(
      () =>
        sctx.systemPrompt.section({
          name: 'ai-persistent-memory',
          /**
           * 权重最高的合法做法：systemPrompt.section 没有 priority 字段，
           * 排序只认 order（升序，见 dsh-system-prompt 的 comparePromptSections）。
           *
           * order 表：HARNESS_IDENTITY=-1000、DEPLOYMENT_PERSONA_PREFIX=0、
           * PLAN_POLICY=500、TOOL_*=1000+。取 10 = 紧跟人设、早于一切计划与
           * 工具说明，既不抢 harness 身份，又比任何工具文档更靠前生效。
           */
          order: 10,
          text: (assembly) => {
            // assembly 的 agent/scope 在 assembly.scope 上；个别版本也可能直接挂在
            // assembly 自身，两种都试一遍，别让 id 落到兜底值导致召回结果永远注不进去。
            const scopeHolder = (assembly as { scope?: unknown } | undefined)?.scope;
            const entry = pending.get(agentIdOf(scopeHolder ?? assembly));
            if (entry === undefined || entry.block.length === 0) return '';
            return entry.block;
          },
        }),
      'ai-persistent-memory: prompt section',
    );
  });

  // ① 模型调用前：召回（不阻塞、失败不影响本轮对话）
  ctx.on('agent/pre-step', async (payload: any, next: () => Promise<unknown>) => {
    try {
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      const last = messages[messages.length - 1];
      const userText = messageText(last);

      // 开关1：关闭后彻底不读记忆（不召回、不注入），当普通聊天用。
      if (!settings.autoInject) {
        pending.delete(agentIdOf(payload?.agent));
      } else if (userText.length > 0) {
        const id = agentIdOf(payload?.agent);
        const cached = pending.get(id);

        // 工具循环里最后一条用户消息不变，复用上一轮的召回结果
        if (cached === undefined || cached.userText !== userText) {
          const recalled = await engine.recall({
            text: userText,
            scope,
            scopeRef,
            sessionId: id,
            topK: config.topK ?? 8,
            // 敏感度滑块：100 - 敏感度 = minScore。
            minScore: minScoreFromSensitivity(settings.sensitivity),
          });

          // 开关3：hardBudget 打开时把预算压到 800。
          // 人设走固定安全外壳（wrapPersona），永远不能改写指令层。
          // 记忆脱敏：打招呼 + 没匹配到高权重记忆 → 一条都不注入。
          const best = recalled.items[0]?.score ?? 0;
          const block =
            recalled.items.length === 0 || (isGreeting(userText) && best < 0.7)
              ? ''
              : formatter.format({
                  memories: recalled.items,
                  budgetTokens: effectiveBudget(),
                  compat: settings.compat,
                  ...(settings.persona.length > 0 ? { persona: settings.persona } : {}),
                }).text;

          pending.set(id, {
            userText,
            block,
            ids: block.length > 0 ? recalled.items.map((item) => item.memory.id) : [],
          });
        }
      }
    } catch (error) {
      warn('召回失败', error);
    }

    const decision = await next();

    /**
     * 开关4：上下文滑动窗口。
     *
     * 只在 pre-step 的 waterfall 里改「本轮进入模型的消息」，不碰会话日志
     * （日志仍是唯一事实来源，fork/resume 不受影响）。更早的历史交给记忆块
     * 以「想起来」的形式补回来。
     */
    if (settings.slidingWindow && decision !== null && typeof decision === 'object') {
      const incoming = (decision as { messages?: unknown }).messages;
      if (Array.isArray(incoming)) {
        return {
          ...(decision as Record<string, unknown>),
          messages: trimHistory(incoming as Array<{ role?: unknown }>, HISTORY_LIMIT),
        };
      }
    }

    return decision;
  });

  // ② 轮次内的事件：成功返回 → 续命；一轮结束 → 异步落盘
  ctx.on('session/event', (session: any, event: any) => {
    const type = event?.type;
    const id = sessionIdOf(session, event);

    if (type === 'user/message') {
      turns.set(id, { userText: messageText(event?.message ?? event), assistantText: '' });
      return;
    }

    if (type === 'assistant/message') {
      const text = messageText(event?.message ?? event);
      const buffer = turns.get(id);
      if (buffer !== undefined) buffer.assistantText = text;

      // 模型确实返回了，这些记忆才算「被想起来」
      const entry = pending.get(id);
      if (entry !== undefined && entry.ids.length > 0) {
        void engine.markRecalled(entry.ids).catch((error: unknown) => warn('markRecalled 失败', error));
      }
      return;
    }

    if (type === 'turn/end') {
      const buffer = turns.get(id);
      turns.delete(id);
      const entry = pending.get(id);
      pending.delete(id);

      if (buffer === undefined) return;

      // 会话日志是唯一事实来源：优先用 session/event 里的本轮原文，
      // pre-step 的 pending 只是「召回缓存」，它的 userText 可能来自更早的一步。
      const turnText = buffer.userText.length > 0 ? buffer.userText : (entry?.userText ?? '');

      // 异步：绝不阻塞或拖慢宿主收尾
      void persistTurn(engine, extractor, config, settings, {
        sessionId: id,
        userText: turnText,
        assistantText: buffer.assistantText,
        scope,
        scopeRef,
      });
    }
  });

  if (config.maintenance !== false) {
    const scheduler = new Scheduler({ engine });
    ctx.effect(
      () => {
        scheduler.start();
        return () => scheduler.stop();
      },
      'ai-persistent-memory: maintenance scheduler',
    );

    /**
     * 定时维护（启动触发版，图④）：
     * 读 meta 里的上次维护时间，超过 24h 才在后台补跑一次。
     * 用 void 发起、不 await——绝不阻塞用户的第一轮对话。
     */
    void runMaintenance(engine, driver, { force: false })
      .then((report) => {
        if (report.ran) {
          console.info(
            `[ai-persistent-memory] 启动维护完成：扫描 ${report.swept}，清理 ${report.purged}，合并 ${report.merged}`,
          );
        }
      })
      .catch((error: unknown) => warn('启动维护失败', error));
  }

  // ③ Web 宿主：给设置页面板提供 stats / settings / clear 三个接口。
  //    没有 webServer（例如纯 headless profile）时面板用不到，插件其余功能照常。
  ctx.inject(['webServer'], (wctx) => {
    const server = wctx.webServer;
    if (server === undefined) return;

    wctx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: STATS_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' });
              return;
            }
            try {
              sendJson(res, 200, statsPayload(engine, settings));
            } catch (error) {
              sendJson(res, 500, { ok: false, error: errorText(error) });
            }
          },
        }),
      'ai-persistent-memory: stats route',
    );

    wctx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: SETTINGS_ROUTE,
          handler: async (req, res) => {
            if (req.method === 'GET' || req.method === 'HEAD') {
              sendJson(res, 200, { ok: true, settings });
              return;
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' });
              return;
            }

            try {
              const body = await readJsonBody(req);
              const patch = parseSettingsPatch(body);
              if (Object.keys(patch).length === 0) {
                sendJson(res, 400, { ok: false, error: '没有可更新的开关' });
                return;
              }
              const next = writeSettings(engine, driver, patch);
              // 立即生效：下一轮的 pre-step / turn-end 就读新值
              settings = next;
              sendJson(res, 200, { ok: true, settings });
            } catch (error) {
              sendJson(res, 400, { ok: false, error: errorText(error) });
            }
          },
        }),
      'ai-persistent-memory: settings route',
    );

    // 手动记忆：写库前转义结构字符，注入时单独包「额外背景记忆」外壳。
    wctx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: MEMORIZE_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' });
              return;
            }

            try {
              const body = await readJsonBody(req);
              const source = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
              const text = typeof source.text === 'string' ? source.text.trim() : '';

              if (text.length === 0) {
                sendJson(res, 400, { ok: false, error: '内容不能为空' });
                return;
              }
              if (text.length > 2000) {
                sendJson(res, 400, { ok: false, error: '内容过长（上限 2000 字）' });
                return;
              }

              const tags = Array.isArray(source.tags)
                ? source.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8)
                : [];

              const now = engine.clock.now().toISOString();
              const result = await engine.saveMemory({
                scope,
                scopeRef,
                kind: 'fact',
                rawText: text,
                layers: {
                  fact: escapeStructure(text.slice(0, 200)),
                  feltThen: null,
                  intensity: 5,
                  thoughtThen: null,
                  reframe: null,
                  recalledLater: null,
                },
                tags: [...tags, MANUAL_TAG],
                source: {
                  conversationId: 'manual',
                  sessionId: 'manual',
                  turnId: `manual-${now}`,
                  speaker: 'user',
                },
              });

              sendJson(res, 200, {
                ok: true,
                saved: result.saved,
                id: result.record === null ? null : result.record.id,
              });
            } catch (error) {
              sendJson(res, 500, { ok: false, error: errorText(error) });
            }
          },
        }),
      'ai-persistent-memory: memorize route',
    );

    // 手动触发维护（也给「上次维护超 24h」的自动补跑提供了可测入口）。
    wctx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: MAINTENANCE_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' });
              return;
            }
            try {
              const report = await runMaintenance(engine, driver, { force: true });
              sendJson(res, 200, { ok: true, ...report });
            } catch (error) {
              sendJson(res, 500, { ok: false, error: errorText(error) });
            }
          },
        }),
      'ai-persistent-memory: maintenance route',
    );

    wctx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: CLEAR_ROUTE,
          handler: async (req, res) => {
            // 只接受 POST：GET 预取/误点都不该清库。
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' });
              return;
            }

            // 服务端也校验强确认口令（前端已弹输入框；这里防的是直接打接口）。
            let body: unknown = null;
            try {
              body = await readJsonBody(req);
            } catch {
              body = null;
            }
            const confirm =
              typeof body === 'object' && body !== null
                ? String((body as { confirm?: unknown }).confirm ?? '')
                : '';
            if (confirm.trim().toUpperCase() !== 'YES') {
              sendJson(res, 400, { ok: false, error: '需要输入 YES 确认' });
              return;
            }

            try {
              const result = clearAllMemory(engine, driver, {
                retention: settings.backupRetention,
              });
              sendJson(res, 200, { ok: true, ...result });
            } catch (error) {
              sendJson(res, 500, { ok: false, error: errorText(error) });
            }
          },
        }),
      'ai-persistent-memory: clear route',
    );

    // 彻底重置：清库 + 连同所有 .backup-* 历史备份一起删。口令 + 路径双重校验。
    wctx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: NUKE_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' });
              return;
            }

            let body: unknown = null;
            try {
              body = await readJsonBody(req);
            } catch {
              body = null;
            }
            const confirm =
              typeof body === 'object' && body !== null
                ? String((body as { confirm?: unknown }).confirm ?? '')
                : '';
            // 这里要求大写 YES（比 clear 更严）
            if (confirm !== 'YES') {
              sendJson(res, 400, { ok: false, error: '需要输入大写 YES 确认' });
              return;
            }

            try {
              const result = nukeAllMemory(engine, driver);
              sendJson(res, 200, { ok: true, ...result });
            } catch (error) {
              sendJson(res, 500, { ok: false, error: errorText(error) });
            }
          },
        }),
      'ai-persistent-memory: nuke route',
    );
  });
}

/* ─────────────────────────── 插件内部实现 ─────────────────────────── */

/**
 * 按驱动创建引擎。
 *
 * 驱动顺序不是审美问题：DSH 桌面端的宿主是 Electron，NODE_MODULE_VERSION
 * 与系统 Node 不同，better-sqlite3 的预编译二进制会加载失败，因此默认走
 * 进程内置的 node:sqlite；只有在明确要求或 node:sqlite 不可用时才用原生模块。
 */
function createEngine(config: DshPluginConfig): MemoryEngine {
  // 选盘：用户配置优先；没配或盘不存在时自动落到可写的非 C 盘。
  const choice = pickMemoryRoot(config.memoryDbPath ?? DEFAULT_MEMORY_ROOT);
  if (choice.note) {
    console.warn(`[ai-persistent-memory] ${choice.note}`);
  }

  const memoryDbPath = choice.root.trim();
  const driver = config.driver ?? 'auto';

  const overrides = {
    memoryDbPath,
    retrieval: {
      ...(config.topK === undefined ? {} : { topK: config.topK }),
      ...(config.budgetTokens === undefined ? {} : { budgetTokens: config.budgetTokens }),
    },
  };

  const openDatabase = resolveOpenDatabase(driver);

  const options = {
    overrides,
    ...(openDatabase === null ? {} : { openDatabase }),
  };

  return new MemoryEngine(options);
}

/** 返回打开数据库的函数；null = 交给引擎内置（better-sqlite3）。 */
function resolveOpenDatabase(
  driver: MemoryDatabaseDriver,
): ((file: string) => ReturnType<typeof openNodeSqliteDatabase>) | null {
  if (driver === 'node-sqlite') return openNodeSqliteDatabase;
  if (driver === 'better-sqlite3') return null;

  // auto
  return hasNodeSqlite() ? openNodeSqliteDatabase : null;
}

/** 没有 API Key 就不建提取器：宁可退化成原文落盘，也不要每轮抛网络错。 */
function resolveExtractor(engine: MemoryEngine, config: DshPluginConfig): MemoryExtractor | null {
  if (config.extract === false) return null;

  const envName = engine.config.llm.apiKeyEnv;
  const apiKey = envName.length > 0 ? process.env[envName] : undefined;
  if (apiKey === undefined || apiKey.length === 0) return null;

  return new MemoryExtractor({ llm: new DeepSeekClient(engine.config.llm, apiKey) });
}

interface PersistInput {
  sessionId: string;
  userText: string;
  assistantText: string;
  scope: Scope;
  scopeRef: string | null;
}

/**
 * 一轮结束后落盘。
 *
 * 有提取器：走五层结构抽取（事实/当时感觉/当时在想/后来再想/回忆词）。
 * 没有提取器且允许 rawFallback：整轮原文存成一条 event 记忆，仍然过 6 小时防重。
 */
async function persistTurn(
  engine: MemoryEngine,
  extractor: MemoryExtractor | null,
  config: DshPluginConfig,
  settings: MemorySettings,
  input: PersistInput,
): Promise<void> {
  // 开关2 + 写入模式：非 auto 一律跳过后台提取，直接省 Token。
  if (!settings.autoExtract || settings.writeMode !== 'auto') return;

  const { sessionId, userText, assistantText, scope, scopeRef } = input;
  const now = engine.clock.now().toISOString();
  const turnId = `turn-${now}`;

  const dialogue: DialogueTurn[] = [
    ...(userText.length > 0 ? [{ role: 'user' as const, content: userText }] : []),
    ...(assistantText.length > 0 ? [{ role: 'assistant' as const, content: assistantText }] : []),
  ];

  if (dialogue.length === 0) return;

  if (extractor !== null) {
    try {
      const extraction = await extractor.extract({
        turns: dialogue,
        scope,
        scopeRef,
        conversationId: sessionId,
        sessionId,
        turnId,
        occurredAt: now,
      });

      for (const draft of extraction.drafts) {
        // 结构隔离：写库前把 fact 里的括号类字符转义（rawText 保持原文）。
        await engine.saveMemory({
          ...draft,
          layers: { ...draft.layers, fact: escapeStructure(draft.layers.fact) },
        });
      }
      return;
    } catch (error) {
      warn('结构抽取失败，回落到原文落盘', error);
    }
  }

  if (config.rawFallback === false) return;
  if (userText.trim().length === 0) return;

  // 本地语义兜底：没有 LLM 时也不能把提问/寒暄/语气词写进库。
  if (isLowValueUtterance(userText)) return;

  const rawText = [
    userText.length > 0 ? `用户：${userText}` : '',
    assistantText.length > 0 ? `助手：${assistantText}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  try {
    await engine.saveMemory({
      scope,
      scopeRef,
      kind: 'event',
      rawText,
      layers: {
        // 结构隔离：写库前转义括号类字符（rawText 仍是原文，不改写）。
        fact: escapeStructure(userText.slice(0, 200)),
        feltThen: null,
        intensity: 3,
        thoughtThen: null,
        reframe: null,
        recalledLater: null,
      },
      tags: [],
      source: {
        conversationId: sessionId,
        sessionId,
        turnId,
        speaker: 'user',
      },
    });
  } catch (error) {
    warn('原文落盘失败', error);
  }
}

/* ─────────────────────────── 兼容宿主的形状 ─────────────────────────── */

/** 从 agent / assembly.scope 上取稳定 id。 */
function agentIdOf(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return 'dsh-session';
}

/** 从 Session 对象上取 id；取不到就用 agent 兜底。 */
function sessionIdOf(session: unknown, event: unknown): string {
  if (typeof session === 'object' && session !== null) {
    const record = session as { id?: unknown; sessionId?: unknown };
    const id = record.id ?? record.sessionId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  const fallback = agentIdOf((event as { agent?: unknown } | undefined)?.agent);
  return fallback;
}

/**
 * 从消息里抽纯文本。
 *
 * DSH 的 content 可能是 string，也可能是 block 数组（text / reasoning / tool 调用），
 * 这里只取可见文本，其余忽略——抽不到就返回空串，绝不让宿主崩。
 */
function messageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (typeof message !== 'object' || message === null) return '';

  const record = message as { content?: unknown; text?: unknown };
  const content = record.content;

  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (typeof block !== 'object' || block === null) return '';

        const part = block as { text?: unknown; content?: unknown; type?: unknown };
        // 白名单：只收可见文本块，reasoning / thinking / tool-call 一律不进记忆。
        if (typeof part.type === 'string' && part.type !== 'text') return '';
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
        return '';
      })
      .filter((text) => text.length > 0)
      .join('\n');
  }

  if (typeof record.text === 'string') return record.text;
  return '';
}

function warn(what: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[ai-persistent-memory] ${what}：${detail}`);
}

/* ─────────────────────────── HTTP 接口实现 ─────────────────────────── */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 统一 JSON 响应；写响应本身失败时不能再抛（否则宿主会 400）。 */
function sendJson(res: DshHttpResponse, status: number, payload: unknown): void {
  try {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
  } catch {
    try {
      res.statusCode = 500;
      res.end('{"ok":false}');
    } catch {
      // 连接已经断了，忽略
    }
  }
}

export interface MemoryStatsPayload {
  ok: true;
  total: number;
  byState: Record<string, number>;
  dbPath: string;
  archiveRoot: string;
  dbBytes: number;
  /** 快照目录：<memoryDbPath>\backups */
  backupsDir: string;
  /** 当前实际使用的记忆根目录（可能是自动选盘的结果）。 */
  memoryRoot: string;
  /** 可用的非 C 盘盘符，供面板做“选盘”。 */
  availableDrives: string[];
  /** 三个运行时开关，前端一次拉取即可渲染。 */
  settings: MemorySettings;
}

function statsPayload(engine: MemoryEngine, settings: MemorySettings): MemoryStatsPayload {
  const byState = engine.stats();
  const total = Object.values(byState).reduce((sum, count) => sum + count, 0);

  let dbBytes = 0;
  try {
    dbBytes = fs.statSync(engine.paths.dbFile).size;
  } catch {
    dbBytes = 0;
  }

  return {
    ok: true,
    total,
    byState,
    dbPath: engine.paths.dbFile,
    archiveRoot: engine.paths.archiveRoot,
    backupsDir: backupRootOf(engine.paths.root),
    memoryRoot: engine.paths.root,
    availableDrives: detectAvailableDrives(),
    dbBytes,
    settings,
  };
}

/* ── 运行时开关：持久化在 meta 表 ── */

/** 读全部开关；缺省值 = 默认值，未被写过的键不会报错。 */
export function readSettings(engine: MemoryEngine, driver: MemoryDatabaseDriver): MemorySettings {
  const db = openRawDatabase(engine, driver);
  try {
    const read = (key: string): string | undefined => {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
        | { value?: unknown }
        | undefined;
      return row === undefined ? undefined : String(row.value);
    };

    const bool = (key: string, fallback: boolean): boolean => {
      const raw = read(key);
      if (raw === undefined) return fallback;
      return raw === '1' || raw === 'true';
    };

    const rawMode = read(SETTING_KEYS.writeMode);
    const writeMode: MemoryWriteMode =
      rawMode === 'auto' || rawMode === 'manual' || rawMode === 'off'
        ? rawMode
        : DEFAULT_SETTINGS.writeMode;

    const rawSensitivity = read(SETTING_KEYS.sensitivity);
    const sensitivity =
      rawSensitivity === undefined
        ? DEFAULT_SETTINGS.sensitivity
        : clampSensitivity(Number(rawSensitivity));

    return {
      autoInject: bool(SETTING_KEYS.autoInject, DEFAULT_SETTINGS.autoInject),
      autoExtract: bool(SETTING_KEYS.autoExtract, DEFAULT_SETTINGS.autoExtract),
      hardBudget: bool(SETTING_KEYS.hardBudget, DEFAULT_SETTINGS.hardBudget),
      slidingWindow: bool(SETTING_KEYS.slidingWindow, DEFAULT_SETTINGS.slidingWindow),
      writeMode,
      persona: read(SETTING_KEYS.persona) ?? DEFAULT_SETTINGS.persona,
      sensitivity,
      compat: bool(SETTING_KEYS.compat, DEFAULT_SETTINGS.compat),
      backupRetention: clampRetention(
        Number(read(SETTING_KEYS.backupRetention) ?? DEFAULT_SETTINGS.backupRetention),
      ),
      memoryRoot: read(SETTING_KEYS.memoryRoot) ?? DEFAULT_SETTINGS.memoryRoot,
    };
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

/** 写开关（局部更新），返回写后的完整值。 */
export function writeSettings(
  engine: MemoryEngine,
  driver: MemoryDatabaseDriver,
  patch: Partial<MemorySettings>,
): MemorySettings {
  const db = openRawDatabase(engine, driver);
  const now = engine.clock.now().toISOString();

  try {
    const upsert = db.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );

    const entries: Array<[string, string]> = [];
    const booleanKeys = ['autoInject', 'autoExtract', 'hardBudget', 'slidingWindow', 'compat'] as const;
    for (const name of booleanKeys) {
      const value = patch[name];
      if (value !== undefined) entries.push([SETTING_KEYS[name], value ? '1' : '0']);
    }
    if (patch.writeMode !== undefined) entries.push([SETTING_KEYS.writeMode, patch.writeMode]);
    if (patch.persona !== undefined) entries.push([SETTING_KEYS.persona, patch.persona]);
    if (patch.sensitivity !== undefined) {
      entries.push([SETTING_KEYS.sensitivity, String(clampSensitivity(patch.sensitivity))]);
    }
    if (patch.backupRetention !== undefined) {
      entries.push([SETTING_KEYS.backupRetention, String(clampRetention(patch.backupRetention))]);
    }
    if (patch.memoryRoot !== undefined) {
      const normalized = patch.memoryRoot.trim();
      // 只接受非 C 盘的绝对路径，其它一律拒绝（安全红线不因面板而松动）。
      if (normalized.length > 0) {
        if (!/^[A-Za-z]:[\\/]/.test(normalized)) {
          throw new Error('存储位置必须是绝对路径，例如 E:\\AI_Memory');
        }
        if (/^C:/i.test(normalized) || /(^|[\\/])appdata([\\/]|$)/i.test(normalized)) {
          throw new Error('不能把记忆存在系统盘或 AppData，请换一个盘');
        }
      }
      entries.push([SETTING_KEYS.memoryRoot, normalized]);
    }

    const run = db.transaction(() => {
      for (const [key, value] of entries) {
        upsert.run(key, value, now);
      }
    });
    run();
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }

  return readSettings(engine, driver);
}

/** 只接受已知字段，其它一律丢弃（避免把脏数据写进 meta）。 */
export function parseSettingsPatch(body: unknown): Partial<MemorySettings> {
  if (typeof body !== 'object' || body === null) return {};

  const source = body as Record<string, unknown>;
  const patch: Partial<MemorySettings> = {};

  for (const name of ['autoInject', 'autoExtract', 'hardBudget', 'slidingWindow', 'compat'] as const) {
    const value = source[name];
    if (typeof value === 'boolean') patch[name] = value;
  }

  const mode = source.writeMode;
  if (mode === 'auto' || mode === 'manual' || mode === 'off') {
    patch.writeMode = mode;
  }

  // 人设存原文（不在这里转义）——转义发生在注入时，库里保留用户原本写的东西。
  if (typeof source.persona === 'string') {
    patch.persona = source.persona.slice(0, 2000);
  }

  if (typeof source.sensitivity === 'number' && Number.isFinite(source.sensitivity)) {
    patch.sensitivity = clampSensitivity(source.sensitivity);
  }

  if (typeof source.backupRetention === 'number' && Number.isFinite(source.backupRetention)) {
    patch.backupRetention = clampRetention(source.backupRetention);
  }

  if (typeof source.memoryRoot === 'string') {
    patch.memoryRoot = source.memoryRoot.slice(0, 260);
  }

  return patch;
}

/* ── 定时维护（图④，启动触发版） ── */

export interface MaintenanceReport {
  ran: boolean;
  lastMaintenanceAt: string | null;
  swept: number;
  markedCold: number;
  purged: number;
  merged: number;
  digestId: string | null;
}

/** 读上次维护时间；没有记录返回 null（视为「从未维护过」）。 */
export function readLastMaintenance(
  engine: MemoryEngine,
  driver: MemoryDatabaseDriver,
): string | null {
  const db = openRawDatabase(engine, driver);
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(LAST_MAINTENANCE_KEY) as
      | { value?: unknown }
      | undefined;
    return row === undefined ? null : String(row.value);
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

function writeLastMaintenance(
  engine: MemoryEngine,
  driver: MemoryDatabaseDriver,
  iso: string,
): void {
  const db = openRawDatabase(engine, driver);
  try {
    db.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(LAST_MAINTENANCE_KEY, iso, iso);
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

/**
 * 维护一次：生命周期扫描 → 精确去重合并 → 写一条每日流水 → 记账。
 *
 * `force: false` 时只在距上次超过 24h 才执行（启动补跑走这条路径）。
 * 全流程 async，调用方用 `void` 发起即可，不会阻塞对话。
 */
export async function runMaintenance(
  engine: MemoryEngine,
  driver: MemoryDatabaseDriver,
  options: { force?: boolean } = {},
): Promise<MaintenanceReport> {
  const nowIso = engine.clock.now().toISOString();
  const last = readLastMaintenance(engine, driver);
  const lastMs = last === null ? Number.NaN : Date.parse(last);
  const due = !Number.isFinite(lastMs) || Date.now() - lastMs >= MAINTENANCE_INTERVAL_MS;

  if (options.force !== true && !due) {
    return {
      ran: false,
      lastMaintenanceAt: last,
      swept: 0,
      markedCold: 0,
      purged: 0,
      merged: 0,
      digestId: null,
    };
  }

  // 1) 生命周期：活跃 → 冷存，冷存超期 → 墓碑 + 物理清理
  const sweep = await engine.sweepLifecycle();

  // 2) 低权重过期记忆的去重合并
  const merge = await engine.mergeExactDuplicates(20);

  // 3) 每日流水：一条简短的 event 记忆（受 6h 防重约束）
  const stats = engine.stats();
  const total = Object.values(stats).reduce((sum, count) => sum + count, 0);
  const day = nowIso.slice(0, 10);
  let digestId: string | null = null;

  try {
    const digest = await engine.saveMemory({
      scope: 'self',
      scopeRef: null,
      kind: 'event',
      rawText: `每日流水 ${day}：共 ${total} 条印象；本次扫描 ${sweep.scanned} 条，转冷 ${sweep.markedCold.length} 条，清理 ${sweep.purged.length} 条，合并 ${merge.merged} 组。`,
      layers: {
        fact: `每日流水 ${day}：${total} 条印象，合并 ${merge.merged} 组`,
        feltThen: null,
        intensity: 2,
        thoughtThen: null,
        reframe: null,
        recalledLater: null,
      },
      tags: ['每日流水', '维护'],
      source: {
        conversationId: 'maintenance',
        sessionId: 'maintenance',
        turnId: `maintenance-${nowIso}`,
        speaker: 'user',
      },
    });
    digestId = digest.record === null ? null : digest.record.id;
  } catch (error) {
    warn('写每日流水失败', error);
  }

  writeLastMaintenance(engine, driver, nowIso);

  return {
    ran: true,
    lastMaintenanceAt: nowIso,
    swept: sweep.scanned,
    markedCold: sweep.markedCold.length,
    purged: sweep.purged.length,
    merged: merge.merged,
    digestId,
  };
}

/** 读 POST body（上限 64KB），解析成 JSON；失败抛错交给 400。 */
export function readJsonBody(req: DshHttpRequest, limitBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (typeof req.on !== 'function') {
      resolve(null);
      return;
    }

    let size = 0;
    const chunks: string[] = [];
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    req.on('data', (chunk?: any) => {
      if (settled) return;
      const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
      size += text.length;
      if (size > limitBytes) {
        finish(() => reject(new Error('请求体过大')));
        return;
      }
      chunks.push(text);
    });

    req.on('end', () => {
      finish(() => {
        const raw = chunks.join('').trim();
        if (raw.length === 0) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('请求体不是合法 JSON'));
        }
      });
    });

    req.on('error', () => {
      finish(() => reject(new Error('读取请求体失败')));
    });
  });
}

export interface ClearResult {
  backupPath: string;
  deletedRows: number;
  deletedFiles: number;
  /** 因保留策略被清掉的旧快照。 */
  prunedBackups: string[];
}

/** 快照根目录：<memoryDbPath>\backups */
export function backupRootOf(root: string): string {
  return path.join(path.resolve(root), 'backups');
}

/** 清空时生成新快照、按保留策略裁剪，再清表 + 删 Markdown。 */
export function clearAllMemory(
  engine: MemoryEngine,
  driver: MemoryDatabaseDriver,
  options: { retention?: number } = {},
): ClearResult {
  const root = engine.paths.root;
  const backupsRoot = backupRootOf(root);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupsRoot, `backup-${stamp}`);

  assertNotSystemPath(backupPath);

  if (fs.existsSync(backupPath)) {
    throw new Error(`快照目录已存在：${backupPath}`);
  }

  const db = openRawDatabase(engine, driver);

  try {
    // 先 checkpoint，把 WAL 合并进主库，快照出来的 .db 才是完整的。
    try {
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
    } catch {
      // 没有 WAL 或宿主不允许时忽略
    }

    fs.mkdirSync(backupsRoot, { recursive: true });

    /**
     * 快照必须落在 <root>\backups 里，而它本身就在 root 内部——
     * 直接 cpSync(root, backupPath) 会被 Node 判定为「复制到自己的子目录」。
     * 所以逐个子项复制，并跳过 .models 与 backups 自身。
     */
    const exclude = new Set(['.models', 'backups']);
    fs.mkdirSync(backupPath, { recursive: true });
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (exclude.has(entry.name)) continue;
      fs.cpSync(path.join(root, entry.name), path.join(backupPath, entry.name), {
        recursive: true,
        force: true,
      });
    }
  } finally {
    try {
      db.close();
    } catch {
      // 关闭失败不影响清空结果
    }
  }

  // 真物理删除：先清 Markdown 明文，再删库（顺序见 MemoryEngine.purgeAllData）。
  const wiped = wipeMemoryData(engine, driver);
  const retention = clampRetention(options.retention ?? engine.config.backup.retention);
  const prunedBackups = pruneBackups(backupsRoot, retention, backupPath);

  return {
    backupPath,
    deletedRows: wiped.deletedRows,
    deletedFiles: wiped.deletedFiles,
    prunedBackups,
  };
}

function clampRetention(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(50, Math.round(value)));
}

/**
 * 只保留最近 `retention` 份快照。
 *
 * 防呆：
 *   - 刚生成的那份（keepPath）永远不删；
 *   - 只认 backupsRoot 直下一层的 `backup-*` 目录；
 *   - 每个候选路径都复核「在 backupsRoot 之内」，越界一律跳过。
 */
function pruneBackups(backupsRoot: string, retention: number, keepPath: string): string[] {
  const base = path.resolve(backupsRoot);
  const keep = path.resolve(keepPath);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('backup-'))
    .map((entry) => path.resolve(path.join(base, entry.name)))
    .filter((full) => path.dirname(full) === base)
    .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0)); // 新的在前

  const keepSet = new Set<string>([keep.toLowerCase()]);
  // 先按时间保留前 retention 份（其中必然包含刚生成的这份）
  for (const full of candidates.slice(0, retention)) keepSet.add(full.toLowerCase());

  const removed: string[] = [];
  for (const full of candidates) {
    if (keepSet.has(full.toLowerCase())) continue;
    if (full === keep) continue; // 双保险
    if (!full.toLowerCase().startsWith(base.toLowerCase() + path.sep)) continue; // 越界防御
    fs.rmSync(full, { recursive: true, force: true });
    removed.push(full);
  }

  return removed;
}

export interface NukeResult {
  deletedRows: number;
  deletedFiles: number;
  /** 被递归删除的历史快照（绝对路径）。 */
  removedBackups: string[];
}

/** 允许被 `nuke` 触碰的硬底线：所有删除目标必须落在这个前缀之下。 */
export const NUKE_FLOOR = 'D:\\AI_Memory';

/**
 * 彻底重置：清空数据 + 递归删除所有历史快照。
 *
 * 三道护栏，任一不满足就整单拒绝：
 *   1. 记忆库根目录必须以 `D:\AI_Memory` 开头；
 *   2. 内部快照只删 `<root>\backups\backup-*` 这一层；
 *   3. 旧版遗留的兄弟目录 `<root>.backup-*` 仍然兼容清理（逐项复核前缀）。
 */
export function nukeAllMemory(engine: MemoryEngine, driver: MemoryDatabaseDriver): NukeResult {
  const root = path.resolve(engine.paths.root);
  const floor = NUKE_FLOOR.toLowerCase();

  if (!root.toLowerCase().startsWith(floor)) {
    throw new Error(`拒绝执行：记忆库根目录不在 ${NUKE_FLOOR} 之下（${root}）。`);
  }

  const removedBackups = [
    ...deleteInternalBackups(root),
    ...deleteLegacyBackupDirs(root),
  ];
  const wiped = wipeMemoryData(engine, driver);

  return { ...wiped, removedBackups };
}

/** 删 `<root>\backups\backup-*`（新布局）。 */
function deleteInternalBackups(root: string): string[] {
  const backupsRoot = path.resolve(backupRootOf(root));
  const base = backupsRoot.toLowerCase();
  const floor = NUKE_FLOOR.toLowerCase();
  // 与 nukeAllMemory 保持同一把尺子：以 D:\AI_Memory 开头即可
  // （这样隔离测试目录 D:\AI_Memory_xxx 也能正常清理自己的备份）。
  if (!base.startsWith(floor)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(backupsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('backup-')) continue;
    const full = path.resolve(path.join(backupsRoot, entry.name));
    if (path.dirname(full).toLowerCase() !== base) continue;
    fs.rmSync(full, { recursive: true, force: true });
    removed.push(full);
  }

  return removed;
}

/** 删旧版遗留在根目录的 `<root>.backup-*` 兄弟目录。 */
function deleteLegacyBackupDirs(root: string): string[] {
  const parent = path.dirname(root);
  const prefix = `${path.basename(root)}.backup-`;
  const expected = `${root}.backup-`.toLowerCase();
  const floor = NUKE_FLOOR.toLowerCase();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }

  const removed: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;

    const full = path.resolve(path.join(parent, entry.name));
    const lowered = full.toLowerCase();

    // 双重复核：必须同时是「本库的备份」和「硬底线之下的路径」。
    if (!lowered.startsWith(expected) || !lowered.startsWith(floor)) continue;
    // 防止 backup-xxx 里再嵌路径（理论上不会，防御性写法）
    if (path.dirname(lowered) !== parent.toLowerCase()) continue;

    fs.rmSync(full, { recursive: true, force: true });
    removed.push(full);
  }

  return removed;
}

/**
 * 真物理清空：Markdown 明文 + SQLite 行 + WAL/自由页残留。
 * `clear` 和 `nuke` 共用；引擎负责「先档案后数据库」的顺序。
 */
function wipeMemoryData(
  engine: MemoryEngine,
  driver: MemoryDatabaseDriver,
): { deletedRows: number; deletedFiles: number } {
  const result = engine.purgeAllData();

  // 删完再 checkpoint + VACUUM：把 WAL 与自由页里的残留明文一起抹掉。
  const db = openRawDatabase(engine, driver);
  try {
    try {
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
    } catch {
      // 忽略
    }
    try {
      db.prepare('VACUUM').run();
    } catch {
      // 有并发读事务时 VACUUM 可能失败，不影响逻辑删除
    }
  } finally {
    try {
      db.close();
    } catch {
      // 忽略
    }
  }

  return { deletedRows: result.deletedRows, deletedFiles: result.purgedArchiveFiles };
}

/** 与引擎同一套驱动策略拿到一个独立连接（清表用）。 */
function openRawDatabase(engine: MemoryEngine, driver: MemoryDatabaseDriver): SqliteDatabase {
  const opener = resolveOpenDatabase(driver);
  if (opener !== null) return opener(engine.paths.dbFile);

  const requireFromHere = createRequire(import.meta.url);
  const Constructor = requireFromHere('better-sqlite3') as new (file: string) => SqliteDatabase;
  return new Constructor(engine.paths.dbFile);
}
