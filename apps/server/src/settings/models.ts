/**
 * `/api/v1/models` 的数据层：**模型清单 + 逐个真探测**。
 *
 * 规格：[`docs/SETTINGS_AND_SANDBOX.md`](../../../../docs/SETTINGS_AND_SANDBOX.md) §2
 * 「每个模型显示 `available` + 延迟（**真探测结果**）」。
 *
 * ## 为什么不能只报 provider 的 `healthCheck()`
 * registry 的 `healthCheck()` 探的是**该 provider 在 providers.yaml 里配的那个 model**。
 * 而热切换要切的是**任意模型名** —— 用 provider 级探测的绿灯去给另一个模型背书，
 * 就是本项目反复踩的**假绿**（"配置了就算可用"）。所以这里对**每个候选模型**
 * 真发一次最小请求（`POST {baseUrl}/chat/completions`，`max_tokens=8`）。
 *
 * ## 候选模型从哪来（不硬编码厂商模型名）
 * 1. `settings.llm.active` + `settings.llm.fallbacks`（用户明确要用的）
 * 2. `providers.yaml` 里配的 `model`（部署期声明）
 * 3. `GET {baseUrl}/models` **真发现**（标准 OpenAI 兼容端点）；失败则如实上报 `discovery.ok=false`
 *
 * 探测结果按 TTL 缓存（默认 60s），`?deep=1` 强制重探。
 */

import type { ServerConfig } from '../config.ts';
import { redact } from '../config.ts';

/**
 * 打码：把**裸密钥**从文本里去掉。
 *
 * ⚠️ `config.ts::redact(text, env)` 只对**键名像凭据**的条目生效
 * （`/(KEY|TOKEN|SECRET|PASSWORD|…)/i`，且值长度 ≥ 8）—— 直接传 `[apiKey]` 数组
 * 会 `TS2345`（签名要的是 Record）。这里用一个含 `KEY` 的键名把裸密钥也覆盖掉。
 */
function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return redact(text, { LLM_API_KEY: secret });
}

export interface ModelProbe {
  available: boolean;
  latencyMs: number;
  reason: string;
  /** 探测方式（排障用；**不含凭据**） */
  probe: string;
  checkedAt: number;
}

export interface ModelEntry {
  /** 模型 id（如 `deepseek-v4.1-flash`） */
  id: string;
  providerId: string;
  runtime: 'cloud' | 'local';
  configured: boolean;
  available: boolean;
  latencyMs: number;
  reason: string;
  /** 是否当前生效（`settings.llm.active`） */
  active: boolean;
  /** 是否在 `settings.llm.fallbacks` 里 */
  fallback: boolean;
  /** 该候选的来源（可多个）：`settings.active` / `settings.fallbacks` / `provider` / `endpoint` */
  sources: string[];
  /** 探测缓存命中（true = 用的缓存，不是这次真发的请求） */
  cached: boolean;
}

export interface ModelsResult {
  models: ModelEntry[];
  activeModel: string;
  /** 当前生效模型是否**真探测通过**（false 时 UI 要显式警告，别让坏模型静默生效） */
  activeAvailable: boolean;
  probedAt: number;
  /** 端点模型发现（`GET /models`）的结果 —— 失败也如实上报，不影响其它字段 */
  discovery: { ok: boolean; reason: string; count: number };
  /** 凭据是否齐备（≠ 可用；铁律 R1） */
  configured: boolean;
  reason: string;
}

export interface ModelCatalogOptions {
  cfg: ServerConfig;
  /** 缓存 TTL（ms），默认 60_000 */
  ttlMs?: number;
  /** 单次探测超时（ms），默认 10_000 */
  timeoutMs?: number;
  /** 注入 fetch（测试用假端点，不打真网络） */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** 探测/发现时用的最小请求参数（与 provider 层 `PROBE_MAX_TOKENS=8` 一致） */
const PROBE_MAX_TOKENS = 8;

export class ModelCatalog {
  private readonly opts: ModelCatalogOptions;
  private readonly cache = new Map<string, ModelProbe>();
  private discoveryCache: { at: number; ok: boolean; reason: string; models: string[] } | null = null;

  constructor(opts: ModelCatalogOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private ttl(): number {
    return this.opts.ttlMs ?? 60_000;
  }

  private get creds(): { baseUrl: string; apiKey: string; model: string; providerId: string; configured: boolean } | null {
    const c = this.opts.cfg.llm;
    if (!c) return null;
    return {
      baseUrl: c.baseUrl,
      apiKey: c.apiKey,
      model: c.model,
      providerId: c.providerId,
      configured: Boolean(c.baseUrl && c.apiKey && c.model),
    };
  }

  /** 清缓存（切换模型后必须调：否则会拿着旧模型的绿灯）。 */
  invalidate(): void {
    this.cache.clear();
  }

  // ───────────────────────────────────────────────────────────────────
  // 真探测：一个模型
  // ───────────────────────────────────────────────────────────────────
  async probe(model: string, opts: { force?: boolean } = {}): Promise<ModelProbe> {
    const creds = this.creds;
    const now = this.now();
    if (!opts.force) {
      const hit = this.cache.get(model);
      if (hit && now - hit.checkedAt < this.ttl()) return hit;
    }
    if (!creds || !creds.baseUrl || !creds.apiKey) {
      const reason = creds
        ? '凭据未配置：缺少 base_url / api_key（检查 config/providers.yaml 与 .env）'
        : '没有启用中的 LLM provider（config/providers.yaml 里 llm 段为空？）';
      const miss: ModelProbe = { available: false, latencyMs: 0, reason, probe: 'config', checkedAt: now };
      this.cache.set(model, miss);
      return miss;
    }

    const doFetch = this.opts.fetchImpl ?? fetch;
    const timeoutMs = this.opts.timeoutMs ?? 10_000;
    const url = `${creds.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const t0 = this.now();
    const probeDesc = `POST ${url} (model=${model}, max_tokens=${PROBE_MAX_TOKENS})`;
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${creds.apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: PROBE_MAX_TOKENS,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latencyMs = this.now() - t0;
      if (res.ok) {
        const value: ModelProbe = { available: true, latencyMs, reason: '', probe: probeDesc, checkedAt: this.now() };
        this.cache.set(model, value);
        return value;
      }
      // ⚠️ 失败要把**上游原文**给出来（否则"就是不通"没法排查）；但要过 redact 去掉密钥
      let snippet = '';
      try {
        snippet = (await res.text()).slice(0, 200);
      } catch {
        /* 读不到 body 就算了 */
      }
      const reason = `${explainHttp(res.status)}${snippet ? `｜上游：${redactSecret(snippet, creds.apiKey)}` : ''}`;
      const value: ModelProbe = { available: false, latencyMs, reason, probe: probeDesc, checkedAt: this.now() };
      this.cache.set(model, value);
      return value;
    } catch (e) {
      const latencyMs = this.now() - t0;
      const msg = e instanceof Error ? e.message : String(e);
      const aborted = /abort|timeout/i.test(msg);
      const reason = aborted
        ? `探测超时（>${timeoutMs}ms）—— 端点在超时内没回；可能是网络/代理问题`
        : `请求失败：${redactSecret(msg, creds.apiKey)}`;
      const value: ModelProbe = { available: false, latencyMs, reason, probe: probeDesc, checkedAt: this.now() };
      this.cache.set(model, value);
      return value;
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // 真发现：端点上有哪些模型
  // ───────────────────────────────────────────────────────────────────
  async discoverModels(opts: { force?: boolean } = {}): Promise<{ ok: boolean; reason: string; models: string[] }> {
    const now = this.now();
    if (!opts.force && this.discoveryCache && now - this.discoveryCache.at < this.ttl()) {
      return { ok: this.discoveryCache.ok, reason: this.discoveryCache.reason, models: this.discoveryCache.models };
    }
    const creds = this.creds;
    const miss = (reason: string): { ok: false; reason: string; models: string[] } => {
      this.discoveryCache = { at: now, ok: false, reason, models: [] };
      return { ok: false, reason, models: [] };
    };
    if (!creds || !creds.baseUrl || !creds.apiKey) return miss('凭据不可用，无法发现模型列表');

    const doFetch = this.opts.fetchImpl ?? fetch;
    const url = `${creds.baseUrl.replace(/\/+$/, '')}/models`;
    try {
      const res = await doFetch(url, {
        headers: { authorization: `Bearer ${creds.apiKey}` },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      if (!res.ok) return miss(`GET ${url} → HTTP ${res.status}（该端点可能不支持 /models，属正常情况）`);
      const body = (await res.json()) as { data?: unknown };
      const ids = Array.isArray(body.data)
        ? body.data
            .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
            .filter((x): x is string => typeof x === 'string' && x.length > 0)
        : [];
      this.discoveryCache = { at: now, ok: true, reason: '', models: ids };
      return { ok: true, reason: '', models: ids };
    } catch (e) {
      return miss(`GET ${url} 失败：${redactSecret(e instanceof Error ? e.message : String(e), creds.apiKey)}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // 汇总清单（`/models`）
  // ───────────────────────────────────────────────────────────────────
  async list(input: { active: string; fallbacks: string[]; deep?: boolean }): Promise<ModelsResult> {
    const creds = this.creds;
    const sources = new Map<string, Set<string>>();
    const add = (id: string, src: string): void => {
      const set = sources.get(id) ?? new Set<string>();
      set.add(src);
      sources.set(id, set);
    };
    if (input.active) add(input.active, 'settings.active');
    for (const f of input.fallbacks) add(f, 'settings.fallbacks');
    if (creds?.model) add(creds.model, 'provider');

    const discovery = await this.discoverModels({ force: input.deep === true });
    for (const id of discovery.models) add(id, 'endpoint');

    const deep = input.deep === true;
    const models: ModelEntry[] = [];
    for (const [id, srcSet] of sources) {
      const hit = this.cache.get(id);
      const cached = Boolean(hit && !deep && this.now() - hit.checkedAt < this.ttl());
      const p = await this.probe(id, { force: deep });
      models.push({
        id,
        providerId: creds?.providerId ?? '',
        runtime: 'cloud',
        configured: Boolean(creds?.configured),
        available: p.available,
        latencyMs: p.latencyMs,
        reason: p.reason,
        active: id === input.active,
        fallback: input.fallbacks.includes(id),
        sources: [...srcSet],
        cached,
      });
    }

    // 排序：当前生效 → fallback → 可用优先 → 延迟小优先（UI 直读，避免前端再排一次）
    const rank = (m: ModelEntry): number => (m.active ? 0 : m.fallback ? 1 : 2);
    models.sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      if (a.available !== b.available) return a.available ? -1 : 1;
      return a.latencyMs - b.latencyMs;
    });

    const activeEntry = models.find((m) => m.active);
    return {
      models,
      activeModel: input.active,
      activeAvailable: activeEntry ? activeEntry.available : false,
      probedAt: this.now(),
      discovery: { ok: discovery.ok, reason: discovery.reason, count: discovery.models.length },
      configured: Boolean(creds?.configured),
      reason: creds?.configured ? '' : (creds ? 'LLM 凭据不完整（缺 base_url / api_key / model）' : '没有启用中的 LLM provider'),
    };
  }
}

/** HTTP 状态 → 人话（分清"密钥错""模型错""欠费""限流"，别一律"请求失败"）。 */
export function explainHttp(status: number): string {
  switch (status) {
    case 400:
      return 'HTTP 400：请求被拒（模型名可能不合法）';
    case 401:
      return 'HTTP 401：凭据无效（api_key 过期/写错？）';
    case 402:
      return 'HTTP 402：余额不足/欠费（这正是本项目实测过的 `insufficient_balance`）';
    case 403:
      return 'HTTP 403：无权限访问该模型（账号未开通？）';
    case 404:
      return 'HTTP 404：模型不存在或 base_url 不对（检查模型名）';
    case 429:
      return 'HTTP 429：限流（请求太快/配额用尽）';
    default:
      return status >= 500 ? `HTTP ${status}：上游服务错误` : `HTTP ${status}：请求失败`;
  }
}
