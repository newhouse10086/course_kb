/**
 * LLM Provider —— OpenAI 兼容端点
 *
 * 覆盖：AMR（本项目现有凭据）、以及任何 OpenAI 兼容服务（换 base_url 即可）。
 *
 * ## ⚠️ 本项目对 LLM 的三条硬要求
 *  1. **并发 = 1**（用户明确要求）→ 见 {@link SerialQueue}
 *  2. **结构化输出必须 `json_schema` + `strict:true`**（坑 4：
 *     `json_object` 模式**不强制 enum**，实测模型输出过 `"etype":"常用实现"`）
 *  3. **凭据不落日志** → 所有出站错误信息经 `redact`
 */

import type {
  HealthResult, LlmJsonSchemaRequest, LlmJsonSchemaResult,
  Provider, ProviderConfigEntry, ProviderInfo,
} from '../types.ts';
import { ProviderError } from '../types.ts';

// ─────────────────────────────────────────────────────────────
// 并发 = 1 的串行队列
// ─────────────────────────────────────────────────────────────

/**
 * **全局串行队列**（并发 = 1）。
 *
 * 用户硬要求：「并发跑推理不太合适」。所有 LLM 调用都过这里。
 * 之所以做成模块级单例：即使注册了多个 LLM provider，总量仍是 1 并发。
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  get pending(): number {
    return this.depth;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.depth++;
    const next = this.tail.then(task, task).finally(() => {
      this.depth--;
    });
    // 让链继续，即使本次失败
    this.tail = next.catch(() => undefined);
    return next as Promise<T>;
  }
}

/** 进程内唯一队列（并发 = 1 的落点） */
export const LLM_QUEUE = new SerialQueue();

// ─────────────────────────────────────────────────────────────
// 凭据脱敏
// ─────────────────────────────────────────────────────────────

/**
 * 把消息里出现的凭据替换成 `***`。
 *
 * ⚠️ 出站错误信息（尤其是上游返回的原文）**可能回显 key**，落日志前必须过这里。
 */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('***');
  }
  // 兜底：常见 key 形态
  return out.replace(/\b(sk-[A-Za-z0-9_\-]{6,})/g, '***');
}

// ─────────────────────────────────────────────────────────────
// Provider 实现
// ─────────────────────────────────────────────────────────────

export interface OpenAiCompatibleOptions {
  id?: string;
  label?: string;
  vendor?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 配置来源（用于 reason 里说明去改哪里） */
  configPath?: string;
  /** 其它可选参数（如 timeoutMs） */
  extra?: Record<string, unknown>;
}

/** 探测用的最小请求 token 数 */
const PROBE_MAX_TOKENS = 8;

export class OpenAiCompatibleLlm implements Provider {
  readonly info: ProviderInfo;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly secrets: string[];

  constructor(o: OpenAiCompatibleOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.apiKey = o.apiKey;
    this.model = o.model;
    this.secrets = [o.apiKey];
    this.info = {
      id: o.id ?? 'openai-compatible',
      kind: 'llm',
      label: o.label ?? `OpenAI 兼容（${o.model}）`,
      vendor: o.vendor ?? 'OpenAI 兼容',
      runtime: 'cloud',
      // ⚠️ 铁律 R1：configured 只看凭据齐备，available 由真探测决定
      configured: Boolean(o.baseUrl && o.apiKey && o.model),
      available: false,
      reason: undefined,
      capabilities: {
        structuredOutput: true,       // json_schema + strict
        jsonSchemaStrict: true,
        streaming: true,
        maxContextTokens: o.extra?.maxContextTokens ?? 128_000,
      },
      pricing: undefined,             // 由具体部署决定，不猜
      limits: { concurrency: 1 },     // ★ 并发 = 1
    };
  }

  // ─────────────────────────────────────────────
  // 健康探测（真发一次最小请求）
  // ─────────────────────────────────────────────

  async healthCheck(signal?: AbortSignal): Promise<HealthResult> {
    if (!this.info.configured) {
      return { ok: false, reason: '凭据未配置（缺少 base_url / api_key / model）', probe: 'config' };
    }
    const t0 = Date.now();
    try {
      const r = await this.post(
        {
          model: this.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: PROBE_MAX_TOKENS,
          temperature: 0,
        },
        signal,
      );
      return {
        ok: true,
        latencyMs: Date.now() - t0,
        probe: `POST ${this.baseUrl}/chat/completions (max_tokens=${PROBE_MAX_TOKENS})`,
      };
    } catch (e) {
      return {
        ok: false,
        reason: this.explain(e),
        latencyMs: Date.now() - t0,
        probe: `POST ${this.baseUrl}/chat/completions`,
      };
    }
  }

  // ─────────────────────────────────────────────
  // 结构化输出（★ json_schema + strict）
  // ─────────────────────────────────────────────

  /**
   * 按 JSON Schema 取结构化输出。
   *
   * ⚠️ **不要退回 `json_object`**：实测它**不强制 enum**，
   * 模型会输出 `"etype":"常用实现"` 这种枚举外的值，下游闭集校验才报错，很难查。
   */
  async completeJson<T>(req: LlmJsonSchemaRequest): Promise<LlmJsonSchemaResult<T>> {
    if (!this.info.configured) {
      throw new ProviderError('E_NOT_CONFIGURED', `${this.info.id} 凭据未配置`, '请在 .env 配置 API 凭据');
    }

    // ★ 并发 = 1
    return LLM_QUEUE.run(async () => {
      const body = {
        model: this.model,
        messages: req.messages,
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens ?? 4096,
        response_format: {
          type: 'json_schema' as const,
          json_schema: {
            name: req.schema.name,
            strict: true,                    // ★ 关键
            schema: req.schema.schema,
          },
        },
      };
      const resp = (await this.post(body, req.signal)) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const raw = resp.choices?.[0]?.message?.content ?? '';
      if (!raw) {
        throw new ProviderError('E_LLM', `${this.info.id} 返回空内容`, '模型无输出，可能是上下文过长或触发审查');
      }
      let data: T;
      try {
        data = JSON.parse(raw) as T;
      } catch (e) {
        throw new ProviderError(
          'E_LLM',
          `${this.info.id} 返回非 JSON`,
          '模型未遵守 json_schema（罕见，可重试）',
          raw.slice(0, 500),
        );
      }
      return {
        data,
        raw,
        usedProvider: this.info.id,
        usage: resp.usage
          ? { promptTokens: resp.usage.prompt_tokens ?? 0, completionTokens: resp.usage.completion_tokens ?? 0 }
          : undefined,
      };
    });
  }

  // ─────────────────────────────────────────────
  // HTTP
  // ─────────────────────────────────────────────

  private async post(body: unknown, signal?: AbortSignal): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), 120_000);
    const onAbort = () => ctrl.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await r.text();
      if (!r.ok) {
        // ⚠️ 上游错误原文可能回显 key → 先脱敏再抛出
        const safe = redact(text.slice(0, 600), this.secrets);
        throw new ProviderError(
          'E_LLM',
          `HTTP ${r.status}: ${safe}`,
          this.hintFor(r.status),
          `provider=${this.info.id} model=${this.model}`,
        );
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new ProviderError('E_PROVIDER', `${this.info.id} 返回非 JSON 响应`, undefined, text.slice(0, 300));
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if ((e as Error).name === 'AbortError') {
        throw new ProviderError('E_TIMEOUT', `${this.info.id} 请求超时或被取消`);
      }
      throw new ProviderError('E_PROVIDER', `${this.info.id} 网络错误：${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 把 HTTP 状态翻译成**用户能看懂**的原因 */
  private hintFor(status: number): string {
    switch (status) {
      case 401:
        return '凭据无效或已过期，请检查 API key';
      case 402:
        return '额度不足/欠费（本项目实测遇到过 Coding Plan 配额耗尽，响应头会带 reset_at）';
      case 403:
        return '无权访问该模型（可能未订阅，或地区/账号限制）';
      case 404:
        return '模型不存在或 base_url 不对，请检查 model 与 base_url';
      case 429:
        return '触发限流，稍后重试（本项目并发=1，通常不该出现）';
      case 500:
      case 502:
      case 503:
        return '上游服务异常，可重试';
      default:
        return `上游返回 ${status}`;
    }
  }

  private explain(e: unknown): string {
    if (e instanceof ProviderError) {
      return e.hint ? `${e.hint}（${e.message}）` : e.message;
    }
    return (e as Error).message;
  }
}

// ─────────────────────────────────────────────────────────────
// 工厂
// ─────────────────────────────────────────────────────────────

/**
 * 从配置项构造。type: `openai_compatible`
 *
 * 配置示例见 `config/providers.example.yaml`。
 */
export function createOpenAiCompatible(entry: ProviderConfigEntry): Provider | null {
  const o = entry.options as Record<string, unknown>;
  const baseUrl = String(o.base_url ?? o.baseUrl ?? '');
  const apiKey = String(o.api_key ?? o.apiKey ?? '');
  const model = String(o.model ?? '');
  if (!baseUrl || !model) return null;

  const missing = entry.missingEnv ?? [];
  const p = new OpenAiCompatibleLlm({
    id: entry.id,
    label: String(o.label ?? `OpenAI 兼容（${model}）`),
    vendor: String(o.vendor ?? 'OpenAI 兼容'),
    baseUrl,
    apiKey,
    model,
    extra: o,
  });

  // ⚠️ 铁律 R1：凭据缺失 → configured=false + **可读 reason 指出缺哪个变量**
  if (missing.length) {
    p.info.configured = false;
    p.info.reason = `缺少环境变量 ${missing.join(' / ')}（在 course-kb/.env 配置）`;
  }
  return p;
}
