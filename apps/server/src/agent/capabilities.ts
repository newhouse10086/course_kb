/**
 * 能力探测（契约 §5.1 + §7.3.1「available 的语义边界」+ PROVIDERS.md R1/R2/R3）。
 *
 * ## ★ 两层，绝不混为一谈
 *
 * ```
 * 第 1 层 pi.available    = 「pi SDK 在进程内可用吗」     → 动态 import 成功即 true
 * 第 2 层 pi.model.available = 「模型**真的**能用吗」      → 真发一次最小请求
 * ```
 *
 * v1 的实测教训：`pi.available=true` 但模型返回 **403（无订阅）** ——
 * 如果把它合并成一个字段，要么**撒谎**（报 false 说桥坏了），要么**误导**
 * （报 true 让用户以为能用，点下去才报错）。
 *
 * ## 探测方式（真探测，不是"配置了就可用"）
 *
 * - SDK 层：`await import(specifier)` —— 实测首次约 **4.1s**，故结果缓存。
 * - 模型层：向该 OpenAI 兼容端点 POST 一次 `max_tokens:1` 的请求（实测耗时 ~1.6s）。
 *   **本机真实输出**（task-10 报告里引用了原文）：
 *   ```
 *   status=402 body={"error":{"code":"insufficient_balance","details":{
 *     "coding_plan_exhausted":true,"reset_at":"2026-10-14T15:44:45Z"}, ...}}
 *   ```
 *   → `available:false, reason:"模型额度已耗尽…", resetAt:"2026-10-14T15:44:45Z"`。
 *
 * ⚠️ 我们**不**用"发一条 prompt 让 pi 跑一轮"来探测模型：实测那样会触发 3 次自动重试，
 * 单次探测 **14~25 秒**，且会把失败写进会话历史。直接打端点更快、更干净、不污染会话。
 *
 * ## 凭据来源（三种，按序）
 *
 * 1. `opts.llm`（显式注入 —— 测试与 T-BACKEND 都走这条最稳）
 * 2. 动态 import `../config.ts` 的 `loadConfig()`（T-BACKEND 的配置层，若已就绪）
 * 3. 环境变量兜底（`AMR_BASE` / `AMR_KEY` / `LLM_MODEL`）
 *
 * **apiKey 绝不进返回值、绝不进 reason、绝不进日志**（reason 过 `scrubSecrets`）。
 */

import { scrubSecrets } from './errors.ts';
import { loadSdk, type SdkLoadResult } from './sdk.ts';
import type { AgentSessionManager } from './session.ts';

/** 缓存时长：与 PROVIDERS.md §R2 一致（300s） */
export const CAPABILITIES_TTL_MS = 300_000;
/** 模型探测超时（真实端点实测 <2s；给足余量） */
export const DEFAULT_MODEL_PROBE_TIMEOUT_MS = 15_000;

export interface LlmCredentialsLike {
  providerId?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  configured?: boolean;
  missingEnv?: string[];
}

export interface AgentModelCapability {
  /** 凭据是否齐备（R1：有凭据 ≠ 能用） */
  configured: boolean;
  /** **真探测**结果 */
  available: boolean;
  model: string | null;
  provider: string | null;
  /** 只暴露 host（便于排查，不含路径/查询） */
  endpointHost: string | null;
  reason: string;
  latencyMs: number | null;
  /** `live` = 真发过请求；`not-run` = 缺凭据/未启用；`failed` = 探测本身出错 */
  probe: 'live' | 'not-run' | 'failed';
  missingEnv: string[];
  httpStatus: number | null;
  /**
   * 探测响应的形状（**"HTTP 200" 不等于"模型可用"**）：
   * - `choices`  = 合法 chat completion
   * - `error`    = 返回体里有 error
   * - `unknown`  = 既没有 choices 也没有 error（网关/门户页/HTML）
   */
  bodyShape: 'choices' | 'error' | 'unknown' | null;
  /** `choices[0].finish_reason`（有就给） */
  finishReason: string | null;
  /**
   * `choices[0].message.content` 是否为空。
   * ⚠️ 推理模型在小 `max_tokens` 下**必然为空**（预算被 reasoning 吃光）——
   * 契约 §0：这种情况**不许当成功**，所以这里如实标出，并由 `warning` 说明边界。
   */
  contentEmpty: boolean | null;
  /** 探测得到的**警告**（如"只拿到 reasoning，没拿到 content"）；不影响 available 判定，但要让人看见 */
  warning: string | null;
  /** 从 402 响应里解析出的额度重置时间（有则更有用） */
  resetAt: string | null;
}

export interface AgentCapabilities {
  /** 第 1 层：pi SDK 可用（**不受模型探测影响**） */
  available: boolean;
  version: string | null;
  mode: 'sdk';
  /** `available=false` 时非空 */
  reason: string;
  specifier: string;
  loadMs: number | null;
  /** 第 2 层 */
  model: AgentModelCapability;
  /** 工具来源：显式白名单 vs 未指定（pi 1.0.2 的 get_state 无 tools，v2 同理不编造） */
  tools: string[];
  toolsSource: 'explicit' | 'none';
  /** SDK 可用但模型不可用 → degraded=true（UI 可据此禁用输入并说明原因） */
  degraded: boolean;
  sessions: ReturnType<AgentSessionManager['stats']> | null;
  cwd: string | null;
  sessionDir: string | null;
  checkedAt: number;
  /** 本次结果是否来自缓存 */
  cached: boolean;
}

export interface AgentCapabilitiesOptions {
  /** 强制重新探测（绕过缓存） */
  force?: boolean;
  /** 只探 SDK 层，跳过模型真探测（很快；用于 /health 之类的高频路径） */
  sdkOnly?: boolean;
  /** 注入会话管理器（拿 cwd/sessionDir/tools 与会话统计） */
  manager?: AgentSessionManager;
  /** 注入 LLM 凭据 */
  llm?: LlmCredentialsLike | null;
  /** 注入模型探测器（测试/复用 T-PROVIDERS 的 healthCheck 时用） */
  modelProbe?: (creds: LlmCredentialsLike) => Promise<AgentModelCapability>;
  /** 注入 SDK 加载器 */
  sdkLoader?: () => Promise<SdkLoadResult>;
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 注入脱敏函数（T-BACKEND 可传 providers 层的 redact） */
  redact?: (text: string) => string;
}

let cache: { at: number; value: AgentCapabilities } | null = null;

/** 清缓存（测试用；也用于"刚改了配置想立刻重探"）。 */
export function clearCapabilitiesCache(): void {
  cache = null;
}

function emptyModelCapability(reason: string, probe: AgentModelCapability['probe'] = 'not-run'): AgentModelCapability {
  return {
    configured: false,
    available: false,
    model: null,
    provider: null,
    endpointHost: null,
    reason,
    latencyMs: null,
    probe,
    missingEnv: [],
    httpStatus: null,
    resetAt: null,
    bodyShape: null,
    finishReason: null,
    contentEmpty: null,
    warning: null,
  };
}

/**
 * 判读探测响应体（**HTTP 200 ≠ 模型可用**）。
 *
 * 三种形状：合法 `choices` / 带 `error` / 都不是（网关、门户页、HTML）。
 * 有 `choices[0]` 时再看 `content` 是否为空 —— 推理模型在小预算下必然为空，
 * 契约 §0 要求这种情况**不许当成功**，所以要能被识别出来。
 */
function describeProbeBody(body: unknown): {
  bodyShape: 'choices' | 'error' | 'unknown';
  finishReason: string | null;
  contentEmpty: boolean | null;
} {
  if (!body || typeof body !== 'object') return { bodyShape: 'unknown', finishReason: null, contentEmpty: null };
  const o = body as { choices?: unknown; error?: unknown };
  if (Array.isArray(o.choices) && o.choices.length > 0) {
    const first = o.choices[0] as { finish_reason?: unknown; message?: { content?: unknown } } | null;
    const finishReason = typeof first?.finish_reason === 'string' ? first.finish_reason : null;
    const content = first?.message?.content;
    // content 可能是 null / '' / 数组（多模态）——只要"真空"才算空
    const contentEmpty = content === null || content === undefined || content === '' ? true : false;
    return { bodyShape: 'choices', finishReason, contentEmpty };
  }
  if (o.error !== undefined) return { bodyShape: 'error', finishReason: null, contentEmpty: null };
  return { bodyShape: 'unknown', finishReason: null, contentEmpty: null };
}

/** 从环境变量兜底取凭据（与 T-BACKEND 的 providers.yaml 同名变量）。 */
function credsFromEnv(env: NodeJS.ProcessEnv = process.env): LlmCredentialsLike {
  const baseUrl = env.AMR_BASE;
  const apiKey = env.AMR_KEY;
  const model = env.LLM_MODEL;
  const missingEnv: string[] = [];
  if (!baseUrl) missingEnv.push('AMR_BASE');
  if (!apiKey) missingEnv.push('AMR_KEY');
  if (!model) missingEnv.push('LLM_MODEL');
  return {
    providerId: 'amr',
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    configured: missingEnv.length === 0,
    missingEnv,
  };
}

/** 动态尝试 T-BACKEND 的配置层（存在就用；不存在就退到环境变量）。 */
async function credsFromProjectConfig(): Promise<LlmCredentialsLike | null> {
  try {
    const mod = (await import('../config.ts')) as Record<string, unknown>;
    const loadConfig = mod.loadConfig;
    if (typeof loadConfig === 'function') {
      const cfg = (loadConfig as () => Record<string, unknown>)();
      const llm = cfg?.llm as LlmCredentialsLike | null | undefined;
      if (llm && typeof llm === 'object') return llm;
    }
    const llmCredentials = mod.llmCredentials;
    if (typeof llmCredentials === 'function') {
      const llm = (llmCredentials as (c?: unknown) => LlmCredentialsLike | null)();
      if (llm && typeof llm === 'object') return llm;
    }
  } catch {
    /* config.ts 还没就绪或形状不同 → 交给环境变量兜底（不报错，不猜） */
  }
  return null;
}

function hostOf(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

/** 从 402/429 之类响应体里挖出 reset 时间（有则对用户很有用）。 */
function extractResetAt(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const seen = new Set<unknown>();
  const stack: unknown[] = [body];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
      if (typeof v === 'string' && /reset/i.test(k) && v.length < 64) return v;
      if (typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

/** 默认模型探测器：真发一次最小请求（OpenAI 兼容 `/chat/completions`）。 */
export async function probeLlmEndpoint(
  creds: LlmCredentialsLike,
  opts: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    redact?: (t: string) => string;
    /**
     * 探测请求的输出预算。
     *
     * ⚠️ 默认 1：**故意便宜**。它能证明"凭据/额度/端点通"，但**不能**证明"能产出内容" ——
     * 本项目端点是**推理模型**（实测：`max_tokens=100` 时 `content` 仍为空、全被 reasoning 吃光，
     * 要到 ~500 才稳定出内容）。所以：
     *  - 返回里会如实带上 `contentEmpty` / `finishReason` / `bodyShape`，并给 warning
     *  - 想要"真的产出内容"的结论，请显式提高这个值（成本与时延都会上升）
     */
    probeMaxTokens?: number;
  } = {},
): Promise<AgentModelCapability> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MODEL_PROBE_TIMEOUT_MS;
  const probeMaxTokens = opts.probeMaxTokens ?? 1;
  const redact = opts.redact ?? ((t: string) => scrubSecrets(t, [creds.apiKey]));
  const base = emptyModelCapability('未探测');
  base.model = creds.model ?? null;
  base.provider = creds.providerId ?? null;
  base.endpointHost = hostOf(creds.baseUrl);
  base.missingEnv = creds.missingEnv ?? [];
  base.configured = creds.configured ?? Boolean(creds.baseUrl && creds.apiKey && creds.model);

  if (!base.configured) {
    base.probe = 'not-run';
    base.reason =
      base.missingEnv.length > 0
        ? `缺少环境变量：${base.missingEnv.join(' / ')}`
        : '未配置可用的 LLM provider（config/providers.yaml 的 providers.llm 为空 或 缺 base_url/api_key/model）';
    return base;
  }

  const url = `${String(creds.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const started = Date.now();
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${creds.apiKey ?? ''}`,
      },
      body: JSON.stringify({
        model: creds.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: probeMaxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    base.latencyMs = latencyMs;
    base.httpStatus = res.status;
    base.probe = 'live';

    if (res.ok) {
      // ★ 不能只看 HTTP 200：
      //   ① 网关/门户页可能返回 200 但不是 chat completion（**假绿**）；
      //   ② 本项目端点是推理模型，小 `max_tokens` 会把预算全用在 reasoning 上 →
      //      `content` 为空。契约 §0 明确「content 空但 reasoning_content 非空 → 不许当成功」，
      //      所以这里如实标出响应形状，并在只拿到 reasoning 时给 warning（不假装"内容正常"）。
      const shape = describeProbeBody(body);
      base.bodyShape = shape.bodyShape;
      base.finishReason = shape.finishReason;
      base.contentEmpty = shape.contentEmpty;
      if (shape.bodyShape !== 'choices') {
        base.available = false;
        base.reason = redact(
          `端点返回 HTTP ${res.status} 但**不是合法的 chat completion**（未找到 choices；可能是网关/门户/错误页）—— 凭据与端点尚未验证`,
        );
        return base;
      }
      base.available = true;
      base.reason = '';
      if (shape.contentEmpty) {
        base.warning = `探测请求 max_tokens=${probeMaxTokens}，响应里 content 为空（finish_reason=${shape.finishReason ?? '未知'}）——` +
          `本端点疑似**推理模型**：输出预算先被 reasoning 占用。此结果只证明**凭据/额度/端点可用**，不代表能产出内容；` +
          `要验证内容产出请提高 probeMaxTokens（实测该模型需 ~500）`;
      }
      return base;
    }
    base.available = false;
    const resetAt = extractResetAt(body);
    if (resetAt) base.resetAt = resetAt;
    // 用统一分类器产出可读 reason（含"额度/订阅/凭据/限流"的区分）
    const { classifyFailure } = await import('./errors.ts');
    const classified = classifyFailure(new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`), {
      where: '模型探测',
      model: base.model,
    });
    base.reason = redact(`${classified.hint}${resetAt ? `（额度重置时间：${resetAt}）` : ''}`);
    return base;
  } catch (err) {
    base.latencyMs = Date.now() - started;
    base.probe = 'failed';
    base.available = false;
    const { classifyFailure } = await import('./errors.ts');
    const classified = classifyFailure(err, { where: '模型探测', model: base.model });
    base.reason = redact(classified.hint);
    return base;
  }
}

/**
 * 两层能力探测（**永不抛**；任何内部异常都变成 `available:false` + `reason`）。
 */
export async function capabilities(opts: AgentCapabilitiesOptions = {}): Promise<AgentCapabilities> {
  const now = Date.now();
  if (!opts.force && cache && now - cache.at < CAPABILITIES_TTL_MS) {
    const cachedValue: AgentCapabilities = { ...cache.value, cached: true };
    if (!opts.sdkOnly || cachedValue.model.probe !== 'not-run') return cachedValue;
  }

  const manager = opts.manager;
  const specifier = '@earendil-works/pi-coding-agent';

  // ---- 第 1 层：SDK ----
  let sdk: SdkLoadResult;
  try {
    sdk = opts.sdkLoader ? await opts.sdkLoader() : await loadSdk();
  } catch (err) {
    sdk = {
      available: false,
      specifier,
      reason: `SDK 探测异常：${err instanceof Error ? err.message : String(err)}`,
      detail: '',
      loadMs: 0,
    };
  }

  // ---- 第 2 层：模型 ----
  let model: AgentModelCapability;
  if (opts.sdkOnly) {
    model = emptyModelCapability('未探测（sdkOnly）', 'not-run');
  } else if (opts.modelProbe) {
    const creds = opts.llm ?? (await credsFromProjectConfig()) ?? credsFromEnv();
    try {
      model = await opts.modelProbe(creds);
    } catch (err) {
      model = emptyModelCapability(`模型探测器抛异常：${err instanceof Error ? err.message : String(err)}`, 'failed');
    }
  } else {
    const creds = opts.llm ?? (await credsFromProjectConfig()) ?? credsFromEnv();
    const probeOpts: { fetchImpl?: typeof fetch; timeoutMs?: number; redact?: (t: string) => string } = {};
    if (opts.fetchImpl) probeOpts.fetchImpl = opts.fetchImpl;
    if (opts.timeoutMs !== undefined) probeOpts.timeoutMs = opts.timeoutMs;
    if (opts.redact) probeOpts.redact = opts.redact;
    model = await probeLlmEndpoint(creds, probeOpts);
  }

  let sessions: ReturnType<AgentSessionManager['stats']> | null = null;
  let cwd: string | null = null;
  let sessionDir: string | null = null;
  let tools: string[] = [];
  let toolsSource: 'explicit' | 'none' = 'none';
  if (manager) {
    try {
      sessions = manager.stats();
      cwd = manager.cwd;
      sessionDir = manager.sessionDir;
      toolsSource = manager.toolsSource;
      tools = manager.toolsSource === 'explicit' ? [] : [];
    } catch {
      /* 统计失败不影响能力上报 */
    }
  }

  const value: AgentCapabilities = {
    available: sdk.available,
    version: sdk.available ? sdk.version : null,
    mode: 'sdk',
    reason: sdk.available ? '' : sdk.reason,
    specifier,
    loadMs: typeof sdk.loadMs === 'number' ? sdk.loadMs : null,
    model,
    tools,
    toolsSource,
    degraded: sdk.available && !model.available,
    sessions,
    cwd,
    sessionDir,
    checkedAt: now,
    cached: false,
  };

  cache = { at: now, value };
  return value;
}
