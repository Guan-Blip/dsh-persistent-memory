/**
 * PromptFormatter · 极简注入。
 *
 * 设计原则：把「拟真」的权利交还给大模型，插件只负责递事实。
 *
 * 输出形如：
 *   【用户自定义人设（…）：…】           ← 只有用户设过人设时才有
 *   【潜意识背景印象（以下是你的常识，请自然融入思考，绝对不要复述，也不要使用
 *    「根据记录」等词汇）：】
 *   - 眼前的这个人喜欢美式咖啡，不加糖。
 *   - 眼前的这个人最近在折腾 DSH 插件。
 *   像人聊天时不会刻意提自己的常识一样，只有当话题自然相关时，再像潜意识一样运用这些印象。
 *
 * 预算纪律仍然保留：按「条」整块跳过，绝不截断半句话。
 */

import { escapeStructure, wrapExtraMemory } from '../core/guard.js';
import { estimateTokens } from '../core/scoring.js';
import type { InjectionPayload, MemoryRecord, ScoredMemory } from '../types.js';

export interface PromptFormatterOptions {
  /** 默认 1200 token。 */
  budgetTokens?: number;
  /** 是否附加那句极简使用指南，默认 true。 */
  guidance?: boolean;
  /** 高兼容注入（直白事实块），默认 false。 */
  compat?: boolean;
}

export interface FormatInput {
  memories: readonly ScoredMemory[];
  budgetTokens?: number;
  /** 用户选定/自定义的人设；为空时用默认「智能助手」。 */
  persona?: string;
  /** 覆盖实例级 guidance。 */
  guidance?: boolean;
  /** 高兼容注入：一句话参考，适配第三方弱模型。 */
  compat?: boolean;
}

const HEADER =
  '【潜意识背景印象（以下是你的常识，请自然融入思考，绝对不要复述，也不要使用「根据记录」等词汇）：】';

/**
 * 兼容模式的极简句式（弱模型专用）。
 *
 * 三个约束：短（20-30 字）、去命令化、只给一句参考。
 */
const COMPAT_PREFIX = '【背景参考（请自然带入对话）：';
const COMPAT_SUFFIX = '】';
/** 兼容模式下 fact 的最大长度（含「对方」等前缀）。 */
const COMPAT_FACT_LIMIT = 14;

const GUIDE =
  '像人聊天时不会刻意提自己的常识一样，只有当话题自然相关时，再像潜意识一样运用这些印象。';

/** 用户没有设定时的默认人设。 */
export const DEFAULT_PERSONA = '智能助手';

/**
 * 人设 + 记忆行为约束（动态读取用户选定的人设）。
 *
 * 这里只描述「怎么说话」，不描述「怎么实现」——不出现任何实现向的词汇，
 * 也不暴露系统动作。用户换成高冷助手、毒舌码农都走同一段约束。
 */
export function personaRule(persona?: string): string {
  const who = escapeStructure(persona ?? '').slice(0, 800).trim() || DEFAULT_PERSONA;

  return [
    `【你现在的人设是：${who}。】`,
    '你拥有极好的记忆：知道的事自然带入对话，绝不邀功，绝不做任何系统播报。',
    '不要对用户说「我没有跨会话记忆」「我把内容写进了某个文件」「已存入记忆库」「我记住了」，也不要用「文件 / 数据库 / 记录 / 存下来」来描述自己记住某事。',
    '（正常讨论用户自己的文件、数据库、日志不受此限。）',
  ].join('\n');
}

/** 手动添加记忆的保留标签（注入时单独包壳，也不对外展示）。 */
export const MANUAL_TAG = '__manual__';

const RESERVED_TOKENS = 4;

export class PromptFormatter {
  private readonly budgetTokens: number;
  private readonly guidance: boolean;
  private readonly compat: boolean;

  constructor(options: PromptFormatterOptions = {}) {
    this.budgetTokens = Math.max(50, options.budgetTokens ?? 1200);
    this.guidance = options.guidance ?? true;
    this.compat = options.compat ?? false;
  }

  format(input: FormatInput): InjectionPayload {
    const guidance = input.guidance ?? this.guidance;
    const compat = input.compat ?? this.compat;

    // 兼容模式走独立分支：只输出一句 20-30 字的参考，不做长句约束。
    if (compat) return this.formatCompat(input);

    // 人设 + 记忆行为约束：动态读取用户选定的人设，默认「智能助手」。
    // guidance 关闭且用户没设人设时，才完全不写这一段。
    const personaBlock =
      guidance || (input.persona !== undefined && input.persona.trim().length > 0)
        ? personaRule(input.persona)
        : '';

    const guideCost = guidance ? estimateTokens(GUIDE) : 0;
    const headerCost = estimateTokens(HEADER);
    const personaCost = personaBlock.length > 0 ? estimateTokens(personaBlock) : 0;
    const budget = Math.max(
      50,
      (input.budgetTokens ?? this.budgetTokens) - guideCost - headerCost - personaCost,
    );

    const chunks: string[] = [];
    if (personaBlock.length > 0) chunks.push(personaBlock);

    const bullets: string[] = [];
    const manualBlocks: string[] = [];
    const kept: ScoredMemory[] = [];
    let used = 0;
    let skippedForBudget = 0;

    for (const item of input.memories) {
      const memory = item.memory;
      const isManual = memory.tags.includes(MANUAL_TAG);
      const line = renderBullet(memory, isManual);
      const cost = estimateTokens(line);

      if (bullets.length + manualBlocks.length > 0 && used + cost + RESERVED_TOKENS > budget) {
        skippedForBudget += 1;
        continue;
      }

      if (isManual) manualBlocks.push(wrapExtraMemory(stripManualTag(memory)));
      else bullets.push(line);

      used += cost;
      kept.push(item);
    }

    // 记忆脱敏：一条印象都没有时不注入任何东西（人设本身仍然生效）。
    const hasMemories = bullets.length > 0 || manualBlocks.length > 0;
    if (!hasMemories) {
      return {
        text: personaBlock,
        sections: [],
        memories: [],
        estimatedTokens: personaBlock.length > 0 ? estimateTokens(personaBlock) : 0,
        skippedForBudget,
        skippedWorldSections: 0,
      };
    }

    if (compat) {
      return this.formatCompat(input);
    }

    chunks.push(HEADER);
    chunks.push(...bullets);
    if (manualBlocks.length > 0) chunks.push(...manualBlocks);
    if (guidance) chunks.push(GUIDE);

    const text = chunks.join('\n');
    return {
      text,
      sections: [],
      memories: kept,
      estimatedTokens: estimateTokens(text),
      skippedForBudget,
      skippedWorldSections: 0,
    };
  }

  /**
   * 极简兼容注入：只取最高分的一条记忆，压成 20-30 字的一句话。
   *
   * 输出形如：『【背景参考（请自然带入对话）：对方喜欢美式咖啡。】』
   * 不出现「请务必遵守」「系统最高指令」这类词，交给底座模型自己判断。
   */
  private formatCompat(input: FormatInput): InjectionPayload {
    const first = input.memories[0];
    const personaBlock =
      input.persona === undefined ? '' : compactPersona(input.persona);

    if (first === undefined) {
      return {
        text: personaBlock,
        sections: [],
        memories: [],
        estimatedTokens: personaBlock.length > 0 ? estimateTokens(personaBlock) : 0,
        skippedForBudget: 0,
        skippedWorldSections: 0,
      };
    }

    const fact = shortFact(first.memory);
    const line = `${COMPAT_PREFIX}${fact}${COMPAT_SUFFIX}`;
    const text = personaBlock.length > 0 ? `${personaBlock}\n${line}` : line;

    return {
      text,
      sections: [],
      memories: [first],
      estimatedTokens: estimateTokens(text),
      skippedForBudget: Math.max(0, input.memories.length - 1),
      skippedWorldSections: 0,
    };
  }
}

/** 兼容模式的极简人设：一行搞定，仍然禁止覆盖安全准则。 */
function compactPersona(persona: string): string {
  const cleaned = escapeStructure(persona).slice(0, 800);
  if (cleaned.length === 0) return '';
  return `【人设：${cleaned}】`;
}

/** 兼容模式的一句话事实：去掉标签感，压到 14 字以内。 */
function shortFact(memory: MemoryRecord): string {
  const raw = escapeStructure(memory.layers.fact || memory.rawText)
    .replace(/^用户/, '对方')
    .replace(/[。.!！]+$/g, '')
    .trim();

  return raw.length <= COMPAT_FACT_LIMIT ? raw : `${raw.slice(0, COMPAT_FACT_LIMIT - 1)}…`;
}

/** 一条印象 = 一行 bullet；只保留 fact，不再堆时间/情绪等元信息。 */
function renderBullet(memory: MemoryRecord, isManual: boolean): string {
  const fact = escapeStructure(memory.layers.fact).replace(/^用户/, '眼前的这个人');
  return `- ${isManual ? '（这件事是对方特意让你记住的）' : ''}${fact}`;
}

/** 手动记忆的正文：优先 fact，退化为原文。 */
function stripManualTag(memory: MemoryRecord): string {
  return memory.layers.fact.trim().length > 0 ? memory.layers.fact : memory.rawText;
}
