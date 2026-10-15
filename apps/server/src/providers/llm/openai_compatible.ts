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

/**
 * ★ 幂等 strictify：递归补 `required`（= 全部属性）+ `additionalProperties:false`。
 *
 * 为什么需要：`strict: true` **必须配一份"真 strict 的 schema"**才有意义 ——
 * 只有 `strict:true` 而 schema 缺 `required`/`additionalProperties:false` 时，
 * **`strict:true` 只是一句没有兑现的承诺**（坑 21 家族：自述与生效不同源）。
 *
 * ⚠️ **幂等**：已经 strict 的 schema 再跑一遍结果不变（`required` 取并集、`additionalProperties` 已是 false）。
 * ⚠️ 不改语义：只加"约束"字段，不动 `type`/`properties`/`enum`/`items` 的内容。
 */
export function strictifySchema(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v);
    const isObject = out.type === 'object' || (out.properties !== undefined && out.type === undefined);
    if (isObject && out.properties && typeof out.properties === 'object') {
      const props = out.properties as Record<string, unknown>;
      const keys = Object.keys(props);
      const existing = Array.isArray(out.required) ? (out.required as unknown[]).map(String) : [];
      const merged = [...existing];
      for (const k of keys) if (!merged.includes(k)) merged.push(k);
      out.required = merged;
      out.additionalProperties = false;
    }
    return out;
  };
  return walk(schema) as Record<string, unknown>;
}

/**
 * 这个错误是不是"端点不支持/拒绝严格 schema"（**只有这种情况才回落**）？
 *
 * 现场证据（本轮实测，同一端点）：
 * ```
 * 裸 schema + strict:true      → 200（strict 被忽略，模型可省略键）
 * 真 strict schema（required + additionalProperties:false） → 400
 *   {"error":{"type":"invalid_request_error","code":400,
 *     "message":"Upstream request failed: [invalid_request_error]
 *                 This response_format type is unavailable now"}}
 * ```
 * ★ 若直接 strictify 而不回落 → **每一次抽取都会 400（全量打挂）**。
 * ⚠️ **只对 400 + 结构化输出相关文案回落**：401/402/429/超时**不回落**（那些是配置/额度问题，回落只会浪费额度）。
 */
export function isStrictSchemaRejected(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/HTTP\s*400/.test(msg)) return false;
  return /response_format|json_schema|strict|unavailable|invalid_request_error/i.test(msg);
}

/**
 * 未验证时的如实说明（★ 不许无条件声称支持结构化输出 —— 坑 10/24）。
 * 实测：该端点对"裸 schema + strict:true"返回 200 但**不强制**，对真 strict schema 返回 400。
 */
export const STRUCTURED_UNVERIFIED_REASON =
  '尚未验证：该端点实测**可能忽略 strict**（裸 schema 200 但不强制）或**对严格 schema 返回 400**；' +
  'provider 会先试 strict、被拒则回落裸 schema，并把实测结果写回本字段';

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

/**
 * 探测用的 token 预算。
 *
 * ⚠️ **不能取小值**（原为 8，是个真 bug）：
 * 本项目的端点是**推理模型**（实测一个 8 字回复用掉 54 个 reasoning token），
 * 而**推理 token 计入 `max_tokens` 预算** ⟹ `max_tokens=8` 时 token 会被 reasoning
 * 全部吃光、`content` 为空 → 探测报"可用"但拿不到任何内容（**假绿**）。
 *
 * 取 512：足够容纳一次 "ping" 的推理开销（实测 ~54 tokens），
 * 又不至于在探测时烧掉太多额度。与 worker 侧契约一致（探测 ≥500，结构化 ≥2000）。
 *
 * ★ **导出**（`backend-api` 建议，采纳）：
 * `settings/models.ts` 等处也要做 LLM 探测。若各自定义常量必然漂移 —— 实测就发生过：
 * 本文件已改为 512，而 `settings/models.ts` 仍写 8，于是 `/models` 把 8 个模型里 7 个
 * 报成 `available:true`（**假绿**）；更致命的是**热切换的回滚判断失效**
 * （切到"能连通但产不出内容"的模型 → 探测报绿 → 不回滚 → 抽取静默 0 卡片）。
 * ⟹ **所有 LLM 探测都必须 import 本常量，不许就地自定义**；
 *    更根本的做法是直接复用本类的 `healthCheck()`（已含空 content 判定）。
 */
export const PROBE_MAX_TOKENS = 512;

/**
 * ★ **单请求超时**（原为**硬编码** `120_000` —— 坑 24「死旋钮」）。
 *
 * ## 为什么必须可配（实测证据）
 * 真跑抽取时 5 次调用耗时 `[120009, 125886, 127592, 127590, 130213]` —— **全部贴着 120s 上限**：
 * 这是**撞天花板**（超时），不是"模型慢"（慢模型会给出**分散**的耗时）。
 * 而本项目的端点是**推理模型**（推理 token 计入 `max_tokens`），长单元的结构化输出天然更慢 →
 * **运维必须能调大**，否则慢模型上抽取**必然失败**且无从调整。
 *
 * ## 优先级（`extra` > env > 默认）
 * 1. `OpenAiCompatibleOptions.extra.timeoutMs` —— 契约里**已承诺**（原实现从不读 → 死旋钮）
 * 2. 环境变量 `LLM_TIMEOUT_MS`
 * 3. 本默认值
 *
 * ⚠️ 原错误写法：`setTimeout(() => ctrl.abort(...), 120_000)`（字面量，无任何读取）。
 * **"能配"和"真的会生效"是两件事** —— 断言必须打在**请求行为**上（给极小值→立刻超时）。
 */
export const DEFAULT_LLM_TIMEOUT_MS = 120_000;

/** ★ 超时重试的**总预算**（防止 `120s × N` 让任务耗时翻倍）。env：`LLM_RETRY_BUDGET_MS`。 */
export const DEFAULT_LLM_RETRY_BUDGET_MS = 240_000;

/** 解析单请求超时（`extra` > env > 默认；非法/非正值一律忽略，**不静默变 0**）。 */
export function resolveLlmTimeoutMs(extra?: Record<string, unknown>): number {
  const fromExtra = extra?.timeoutMs;
  if (typeof fromExtra === 'number' && Number.isFinite(fromExtra) && fromExtra > 0) return fromExtra;
  const fromEnv = Number(process.env.LLM_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_LLM_TIMEOUT_MS;
}

/** 解析重试总预算（`extra.retryBudgetMs` > env `LLM_RETRY_BUDGET_MS` > 默认）。 */
export function resolveLlmRetryBudgetMs(extra?: Record<string, unknown>): number {
  const fromExtra = extra?.retryBudgetMs;
  if (typeof fromExtra === 'number' && Number.isFinite(fromExtra) && fromExtra > 0) return fromExtra;
  const fromEnv = Number(process.env.LLM_RETRY_BUDGET_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_LLM_RETRY_BUDGET_MS;
}

export class OpenAiCompatibleLlm implements Provider {
  readonly info: ProviderInfo;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly secrets: string[];
  /** ★ 单请求超时（已解析；`extra` > env > 默认） */
  private readonly timeoutMs: number;
  /** ★ 超时重试总预算 */
  private readonly retryBudgetMs: number;
  /** ★ 结构化输出**实测**模式（unknown = 还没调过）—— 供 `capabilities` 同源上报 */
  private structuredMode: 'unknown' | 'strict' | 'lenient' = 'unknown';
  private structuredReason = '';

  constructor(o: OpenAiCompatibleOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.apiKey = o.apiKey;
    this.model = o.model;
    this.secrets = [o.apiKey];
    this.timeoutMs = resolveLlmTimeoutMs(o.extra);
    this.retryBudgetMs = resolveLlmRetryBudgetMs(o.extra);
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
        /**
         * ★★ **不许无条件 true**（坑 10 + 坑 24：能力不可用假装可用 / 声明 ≠ 生效）。
         *
         * 实测（同一端点，时间相邻的 3 次调用）：
         *   · 裸 schema + `strict:true` → **200**（strict 被忽略）
         *   · 真 strict schema        → **400** `This response_format type is unavailable now`
         * ⟹ 初始值必须是 **false（未验证）**，之后由**真实调用结果**更新
         *   （见 `setStructuredMode`）——**同源**，不是猜的。
         */
        structuredOutput: false,
        jsonSchemaStrict: false,
        structuredOutputReason: STRUCTURED_UNVERIFIED_REASON,
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
    const probeLabel = `POST ${this.baseUrl}/chat/completions (max_tokens=${PROBE_MAX_TOKENS})`;
    try {
      const resp = (await this.post(
        {
          model: this.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: PROBE_MAX_TOKENS,
          temperature: 0,
        },
        signal,
      )) as {
        choices?: {
          message?: { content?: string; reasoning_content?: string };
          finish_reason?: string;
        }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      };

      // ─────────────────────────────────────────────────────────────
      // ★ 修复「假绿」（由 polysemy-prober 实测发现，backend-core 同源确认）
      //
      // 原实现：只要 HTTP 200 就报 `ok: true` —— **完全不看 content**。
      // 本项目的端点是**推理模型**（实测：一个 8 字回复用掉 54 个 reasoning token），
      // 推理 token **计入 max_tokens 预算** ⟹ 探测若用小 max_tokens，
      // token 会被 reasoning 全部吃光 → `content` 为空、`finish_reason` 可能是 `stop`，
      // 于是探测**报 available=true 但实际一个 token 内容都拿不到**。
      //
      // 危害：这是本项目最忌讳的「**看起来成功**」——
      //   能力被报成可用 → 用户触发抽取 → 拿到空内容 → 以为"这篇没有知识点"。
      //
      // 修法（与 worker 侧 `E_LLM_EMPTY_CONTENT` 契约对齐，见 worker/README §5）：
      //   1. 探测预算提到 PROBE_MAX_TOKENS（≥500，容纳推理 token）
      //   2. **空 content 不算成功** —— 如实报 ok:false + 可读原因 + 诊断字段
      // ─────────────────────────────────────────────────────────────
      const msg = resp.choices?.[0]?.message;
      const content = (msg?.content ?? '').trim();
      const reasoningChars = (msg?.reasoning_content ?? '').length;
      const finishReason = resp.choices?.[0]?.finish_reason;
      const completionTokens = resp.usage?.completion_tokens;

      if (content === '') {
        const bits: string[] = [];
        if (finishReason) bits.push(`finish_reason=${finishReason}`);
        if (typeof completionTokens === 'number') bits.push(`completion_tokens=${completionTokens}`);
        if (reasoningChars > 0) bits.push(`reasoning_content=${reasoningChars} 字符`);
        return {
          ok: false,
          latencyMs: Date.now() - t0,
          probe: probeLabel,
          reason:
            `E_LLM_EMPTY_CONTENT：HTTP 200 但 content 为空（${bits.join('，') || '无诊断信息'}）` +
            `。这多半是**推理 token 吃光了输出预算**（推理 token 计入 max_tokens）→ ` +
            `请提高 max_tokens（结构化输出建议 ≥2000），或换非推理模型。` +
            `注意：此状态**不可当作模型可用**。`,
        };
      }

      return { ok: true, latencyMs: Date.now() - t0, probe: probeLabel };
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
      /**
       * ★ **超时重试一次**（坑 24 的配套修复）。
       *
       * ## 为什么只重试 `E_TIMEOUT`
       * 结构化输出（`json_schema` + `strict`）是**幂等**的：同样的 messages 再问一次不会产生副作用
       * （不像"下单/写库"那类操作）→ 重试安全。其它错误（`E_LLM` 4xx/5xx、非 JSON）**不重试**：
       * 那多半是配置/额度/模型问题，重试只会浪费时间与额度。
       *
       * ## 为什么必须有**总预算**
       * 否则"重试一次"会让单次任务实际耗时变成 `120s × 2` —— 用户看到的是任务卡住更久。
       * 规则：`已用 + 单次超时 <= retryBudgetMs` 才允许重试，且**第二次的超时收窄到剩余预算**。
       */
      /**
       * ★★ **降级链**（Lead 裁定：不 strictify、也不等网关修好）：
       * ```
       * ① 先试**严格 schema**（strictify 后的）→ 200 就用，记 `structured_output_mode='strict'`
       * ② 400 / "This response_format type is unavailable now" → **自动回落裸 schema**
       *    （= 线上一直在用的形状），记 `'lenient'` + **原始 reason**
       * ③ 两次都失败 → 如实报错，**两个 reason 都带上**
       * ```
       * ⚠️ 回落**只在同一 `LLM_QUEUE.run` 槽内**（并发仍=1，不会多占槽/死锁）。
       * ⚠️ **多一次调用要如实计入**（400 那次也是真调用，别藏）。
       */
      const strictSchema = strictifySchema(req.schema.schema);
      const strictBody = {
        ...body,
        response_format: {
          type: 'json_schema' as const,
          json_schema: { name: req.schema.name, strict: true, schema: strictSchema },
        },
      };
      let resp: {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      let strictRejectReason = '';
      try {
        resp = (await this.postJson(strictBody, req.signal)) as typeof resp;
        this.setStructuredMode('strict');
      } catch (e) {
        if (!isStrictSchemaRejected(e)) throw e; // 401/402/429/超时 → 不回落
        strictRejectReason = e instanceof Error ? e.message : String(e);
        // ★ 回落：**原始 schema**（不 strictify）——端点至少能 200
        try {
          resp = (await this.postJson(body, req.signal)) as typeof resp;
        } catch (e2) {
          /**
           * ★ **两种模式都失败 → 两个 reason 都带上**（Lead 要求）。
           * 现场教训：只报一句"amr 返回非 JSON"时，**根本不知道是哪种模式、为什么失败**
           * （是端点拒绝 schema？是额度？是模型？）——排查只能靠猜。
           */
          const lenientReason = e2 instanceof Error ? e2.message : String(e2);
          throw new ProviderError(
            'E_LLM',
            `结构化输出两种模式都失败：strict→${strictRejectReason}；lenient→${lenientReason}`,
            '严格 schema 被拒后裸 schema 也没成功 —— 可能是配置/额度/模型问题（不是 schema 形状问题）',
            `provider=${this.info.id} model=${this.model}`,
          );
        }
        this.setStructuredMode('lenient', strictRejectReason);
      }
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
        // ★ 供上游写进 meta：这一份产物是用哪种模式拿到的（strict / lenient）
        structuredOutputMode: this.structuredMode === 'unknown' ? undefined : this.structuredMode,
        usage: resp.usage
          ? { promptTokens: resp.usage.prompt_tokens ?? 0, completionTokens: resp.usage.completion_tokens ?? 0 }
          : undefined,
      };
    });
  }

  // ─────────────────────────────────────────────
  // HTTP
  // ─────────────────────────────────────────────

  /**
   * 发一次请求（**保留原有超时重试语义**：只对 `E_TIMEOUT` 重试一次，且受总预算约束）。
   * 从 `completeJson` 里抽出 —— 因为降级链需要发**两次**不同 body 的请求。
   */
  private async postJson(body: unknown, signal?: AbortSignal): Promise<unknown> {
    const startedAt = Date.now();
    try {
      return await this.post(body, signal);
    } catch (e) {
      const isTimeout = e instanceof ProviderError && e.code === 'E_TIMEOUT';
      const elapsed = Date.now() - startedAt;
      const remaining = this.retryBudgetMs - elapsed;
      if (!isTimeout || remaining < this.timeoutMs) throw e;
      return await this.post(body, signal, remaining);
    }
  }

  /** ★ 把**实测**结果写进 `capabilities`（同源上报；坑 21）。 */
  private setStructuredMode(mode: 'strict' | 'lenient', rejectReason = ''): void {
    this.structuredMode = mode;
    this.structuredReason = rejectReason;
    this.info.capabilities.structuredOutput = mode === 'strict';
    this.info.capabilities.jsonSchemaStrict = mode === 'strict';
    this.info.capabilities.structuredOutputReason =
      mode === 'strict'
        ? '严格模式**已验证可用**（端点接受 required + additionalProperties:false 的 schema）'
        : `端点**拒绝/忽略**严格 schema → 已回落裸 schema（strict 不被强制，键可能被模型省略）：${rejectReason.slice(0, 200)}`;
  }

  private async post(body: unknown, signal?: AbortSignal, timeoutOverrideMs?: number): Promise<unknown> {
    const ctrl = new AbortController();
    // ★ 不再硬编码：`extra.timeoutMs` > `LLM_TIMEOUT_MS` > 默认（见 `resolveLlmTimeoutMs`）。
    //   重试时可用 `timeoutOverrideMs` 收窄到"剩余预算"，避免单次重试又跑满 120s。
    const timeoutMs = timeoutOverrideMs && timeoutOverrideMs > 0 ? timeoutOverrideMs : this.timeoutMs;
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
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
