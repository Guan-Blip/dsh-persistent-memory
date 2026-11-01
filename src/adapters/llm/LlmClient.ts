/**
 * LLM 适配层：提取器只需要「给我一段 JSON 文本」。
 *
 * DeepSeekClient 是唯一带网络的实现：超时、指数退避重试、JSON mode。
 * 测试用 StaticLlmClient，宿主也可以换成任意兼容 chat/completions 的服务。
 */

import { LlmError } from '../../errors.js';
import type { LlmConfig } from '../../types.js';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChatOptions {
  /** json = 要求服务端返回 JSON object（DeepSeek 支持 response_format）。 */
  responseFormat?: 'json' | 'text';
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmClient {
  chat(messages: readonly LlmMessage[], options?: LlmChatOptions): Promise<string>;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

export class DeepSeekClient implements LlmClient {
  private readonly apiKey: string;

  constructor(
    private readonly config: LlmConfig,
    apiKey?: string,
  ) {
    this.apiKey = apiKey ?? process.env[config.apiKeyEnv] ?? '';
  }

  async chat(messages: readonly LlmMessage[], options: LlmChatOptions = {}): Promise<string> {
    if (!this.apiKey) {
      throw new LlmError(`缺少 API Key：环境变量 ${this.config.apiKeyEnv} 为空。`, {
        hint: '请设置环境变量，或把 llm.apiKeyEnv 指向已有的变量名。',
      });
    }

    const url = `${(this.config.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      temperature: options.temperature ?? this.config.temperature,
      stream: false,
    };
    if (options.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }
    if (options.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      const timeout = AbortSignal.timeout(this.config.timeoutMs);
      const signal = options.signal
        ? AbortSignal.any([timeout, options.signal])
        : timeout;

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });

        if (!response.ok) {
          const detail = (await response.text()).slice(0, 300);
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < this.config.maxRetries) {
            lastError = new LlmError(`DeepSeek ${response.status}: ${detail}`);
            await sleep(300 * 2 ** attempt);
            continue;
          }
          throw new LlmError(`DeepSeek 请求失败（${response.status}）：${detail}`);
        }

        const payload = (await response.json()) as ChatCompletionResponse;
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim().length === 0) {
          throw new LlmError('DeepSeek 返回了空内容。');
        }
        return content;
      } catch (error) {
        if (options.signal?.aborted) {
          throw new LlmError('提取请求被上游取消。', { cause: error });
        }
        if (error instanceof LlmError) throw error;

        lastError = error;
        if (attempt < this.config.maxRetries) {
          await sleep(300 * 2 ** attempt);
          continue;
        }
      }
    }

    throw new LlmError('DeepSeek 请求重试后仍失败。', {
      cause: lastError,
      hint: '检查网络、API Key 与 baseUrl；离线时提取器会优雅降级为空结果。',
    });
  }
}

/** 测试/演示用：固定返回一段文本，或固定抛错。 */
export class StaticLlmClient implements LlmClient {
  private calls = 0;

  constructor(
    private readonly response: string,
    private readonly error: Error | null = null,
  ) {}

  get callCount(): number {
    return this.calls;
  }

  async chat(): Promise<string> {
    this.calls += 1;
    if (this.error !== null) throw this.error;
    return this.response;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
