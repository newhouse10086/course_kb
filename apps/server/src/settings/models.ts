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
import type { ProviderConfigEntry, Provider } from '../providers/types.ts';
import { createOpenAiCompatible } from '../providers/llm/openai_compatible.ts';
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
  /**
   * 判定依据说明。
   *
   * ⚠️ 这里**没有** `diagnostics` 结构化字段（曾加过又删）：探测已改为复用 provider 层的
   * `healthCheck()`，而它把 `finish_reason` / `completion_tokens` / `reasoning_content` 字符数
   * **写进 `reason` 文案**（`E_LLM_EMPTY_CONTENT：HTTP 200 但 content 为空（finish_reason=length，
   * reasoning_content=31 字符）…`）。再解析回来属于"第二份实现"，会漂 —— 前端直接显示 `reason`。
   */
  judgedBy: 'provider.healthCheck';
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
  /**
   * 探测方式（如 `POST …/chat/completions (model=x, max_tokens=512)`）。
   * 暴露它是为了让 UI/排障能看出**用的是什么预算与路径**（预算是被踩过的坑）。
   */
  probe: string;
  /** 判定来源：始终是 provider 层的 `healthCheck()`（单一实现，不许漂） */
  judgedBy: 'provider.healthCheck';
}

export interface ModelsResult {
  models: ModelEntry[];
  activeModel: string;
  /** 当前生效模型是否**真探测通过**（false 时 UI 要显式警告，别让坏模型静默生效） */
  activeAvailable: boolean;
  probedAt: number;
  /** 端点模型发现（`GET /models`）的结果 —— 失败也如实上报，不影响其它字段 */
  discovery: { ok: boolean; reason: string; count: number };
  /**
   * ★ **本次真发出去的探测调用**（模型 id 列表）—— 让"看列表"的**代价可见**。
   *
   * 背景（真实成本缺陷）：原先 `list()` 会对**所有候选**（active + fallbacks + 端点发现的全部模型）
   * 逐个 `probe()` —— 而 `probe()` 是**真发一次 `chat/completions`**（计费！）。
   * 用户点一下"模型列表"就会花掉 8+ 次 LLM 调用；实测某平台 kimi-k3 被调 **263 次**，
   * 归因正是这条路径（会话文件里 kimi = 0，说明调用全来自探测）。
   *
   * 现在默认**只探 `active`**；`?deep=1` 才全探。**`probeCalls` 必须等于 `probed.length`**
   * （自述与生效同源 —— 坑 21：不许自述与真实调用不符）。
   */
  probed: string[];
  /** 本次真发出去的探测调用**次数**（= `probed.length`；缓存命中不算） */
  probeCalls: number;
  /** 因成本隔离而**未探测**的模型 id（默认路径下 = fallbacks + 端点发现的其它模型） */
  skippedProbe: string[];
  /** 缓存 TTL（ms）—— 让调用方知道"多久内再问不会再花钱" */
  ttlMs: number;
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
  /**
   * **只有 `/models` 发现列表**用它的注入点（探测不用它 —— 探测走 provider 层）。
   * 测试里也可以直接替换 `globalThis.fetch` 来驱动真 provider 探测路径。
   */
  fetchImpl?: typeof fetch;
  /**
   * provider 构造注入点（默认 `createOpenAiCompatible`）。
   * 测试用它可以给出脚本化的 `healthCheck` 结果，而不打网络。
   */
  makeProvider?: (entry: ProviderConfigEntry, model: string) => Provider | null;
  now?: () => number;
}

/**
 * 探测预算说明（**本模块不再自定义常量**）。
 *
 * 探测已改为复用 `providers/llm/openai_compatible.ts::healthCheck()`，预算由那里唯一拥有
 * （`PROBE_MAX_TOKENS = 512`）。这里留一段说明是因为**曾经的 bug 值得记住**：
 * 本文件原来自己写了一份 `PROBE_MAX_TOKENS = 8` 且只判 HTTP 200 —— 推理模型下
 * 8 个 token 会被 reasoning 吃光、`content` 为空，却报 `available:true`（**假绿**），
 * 导致热切换的"探测不通就回滚"失效 → 抽取静默产出 0 卡片。
 * 教训：**同一个判据只许有一份实现**。`test/settings_models_probe.test.ts` 里有断言
 * 保证 provider 层的预算是 ≥512。
 */

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
    /**
     * ★ TTL 由 60s 提到 **5 分钟**（真实成本缺陷修复的一部分）。
     *
     * 理由：`probe()` 是**真发一次计费请求**。60s 的缓存意味着"UI 每分钟轮询一次 =
     * 每分钟烧一次调用"（配合原先"全候选都探"更是 ×8）。5 分钟内重复问同一个模型
     * **零调用**；要立刻刷新走 `?deep=1`（**显式付费**，代价在响应里可见）。
     */
    return this.opts.ttlMs ?? 300_000;
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

  // ── provider 取用 ────────────────────────────────────────────────────
  /** 启用中的第一条 LLM provider 配置项（`providers.yaml` 的 `llm` 段）。 */
  private llmEntry(): ProviderConfigEntry | null {
    const list = this.opts.cfg.providers?.providers?.llm ?? [];
    const preferred = this.opts.cfg.llm?.providerId;
    const byId = preferred ? list.find((e) => e.id === preferred) : undefined;
    return byId ?? list[0] ?? null;
  }

  /** 该项的密钥（**只用于日志打码，绝不外发**）。 */
  private secretOf(entry: ProviderConfigEntry | null): string {
    const o = (entry?.options ?? {}) as Record<string, unknown>;
    return String(o.api_key ?? o.apiKey ?? '');
  }

  /**
   * 为**任意模型名**构造一个临时 provider（同一端点/凭据，只换 `model`）。
   *
   * 这样"探测"这件事的实现只有 provider 层一份：预算、空 content 判定、reason 文案、
   * 状态码解释全部复用，`/models` 与 `/capabilities` 不会给出互相矛盾的结论。
   */
  private makeProvider(entry: ProviderConfigEntry, model: string): Provider | null {
    if (this.opts.makeProvider) return this.opts.makeProvider(entry, model);
    return createOpenAiCompatible({
      ...entry,
      options: { ...entry.options, model },
      missingEnv: entry.missingEnv ?? [],
      envRefs: entry.envRefs ?? {},
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // 真探测：一个模型
  //
  // ★ **复用 provider 层的 `healthCheck()`**，不自己写第二份探测。
  //
  //   为什么（实测教训）：本文件原先自己发 `POST /chat/completions` 且**只判 HTTP 200**
  //   → 推理模型下预算被 reasoning 吃光、`content` 为空也报 `available:true`（**假绿**），
  //   后果是热切换"探测不通就回滚"失效 → 抽取静默产出 0 卡片。
  //   provider 层早已修好（预算 512 + 空 content 不算成功 + 诊断信息），
  //   所以这里**构造一个临时 provider（只换 model）并调它的 healthCheck**：
  //   判据、预算、reason 文案全部与 `/capabilities` 一致，不会漂。
  // ───────────────────────────────────────────────────────────────────
  async probe(model: string, opts: { force?: boolean } = {}): Promise<ModelProbe> {
    const now = this.now();
    if (!opts.force) {
      const hit = this.cache.get(model);
      if (hit && now - hit.checkedAt < this.ttl()) return hit;
    }
    const entry = this.llmEntry();
    if (!entry) {
      const reason = this.opts.cfg.llm
        ? 'LLM 凭据不完整（缺 base_url / api_key / model）→ 检查 config/providers.yaml 与 .env'
        : '没有启用中的 LLM provider（config/providers.yaml 里 llm 段为空？）';
      const miss: ModelProbe = {
        available: false,
        latencyMs: 0,
        reason,
        probe: 'config',
        checkedAt: now,
        judgedBy: 'provider.healthCheck',
      };
      this.cache.set(model, miss);
      return miss;
    }

    const timeoutMs = this.opts.timeoutMs ?? 10_000;
    const provider = this.makeProvider(entry, model);
    if (!provider) {
      const miss: ModelProbe = {
        available: false,
        latencyMs: 0,
        reason:
          `provider 构造失败（entry=${entry.id}）—— 检查 config/providers.yaml 的 base_url / api_key` +
          `（缺失环境变量：${(entry.missingEnv ?? []).join(', ') || '无'}）`,
        probe: 'config',
        checkedAt: now,
        judgedBy: 'provider.healthCheck',
      };
      this.cache.set(model, miss);
      return miss;
    }

    const t0 = this.now();
    let ok = false;
    let reason = '';
    let probeLabel = `healthCheck(model=${model})`;
    let latencyMs = 0;
    try {
      const health = await provider.healthCheck(AbortSignal.timeout(timeoutMs));
      ok = health.ok === true;
      reason = health.reason ?? '';
      if (health.probe) probeLabel = health.probe;
      latencyMs = health.latencyMs ?? this.now() - t0;
    } catch (e) {
      // provider 承诺 healthCheck 不抛；真抛了也不能让 /models 整体 500（如实转成不可用）
      reason = `探测抛异常：${redactSecret((e as Error).message, this.secretOf(entry))}`;
      latencyMs = this.now() - t0;
      probeLabel = 'healthCheck(threw)';
    }

    const value: ModelProbe = {
      available: ok,
      latencyMs,
      // ★ 失败必须带**可读原因**（provider 的 reason 已含 finish_reason / reasoning 字符数等诊断）；
      //   这里再兜一层脱敏，确保任何情况下密钥不会经由 /models 泄露。
      reason: ok ? '' : redactSecret(reason || '探测失败（provider 未给原因）', this.secretOf(entry)),
      probe: probeLabel,
      checkedAt: this.now(),
      judgedBy: 'provider.healthCheck',
    };
    this.cache.set(model, value);
    return value;
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

    /**
     * ★★ **探测的成本隔离**（真实缺陷修复，见 `ModelsResult.probed` 的注释）。
     *
     * - 默认：**只探 `active`** —— 一个"看看有哪些模型"的只读请求**只花 1 次调用**
     * - `?deep=1`：全探（候选数 = 调用数），**并且响应里如实标注花了多少**
     *
     * `fallbacks` 与端点发现的其它模型**只做"配置存在性"上报，不做真探测**：
     * 兜底模型平时**不该产生任何调用**（真正降级时才由降级链自己去探）。
     */
    const deep = input.deep === true;
    const toProbe = deep ? new Set(sources.keys()) : new Set(input.active ? [input.active] : []);
    const probed: string[] = [];
    const skippedProbe: string[] = [];
    const models: ModelEntry[] = [];
    for (const [id, srcSet] of sources) {
      const hit = this.cache.get(id);
      const cached = Boolean(hit && !deep && this.now() - hit.checkedAt < this.ttl());
      if (!toProbe.has(id)) {
        // ★ **未探测**：如实标注（不是"不可用"，也不是"可用"）—— 坑 10/22：不许假装
        skippedProbe.push(id);
        models.push({
          id,
          providerId: creds?.providerId ?? '',
          runtime: 'cloud',
          configured: Boolean(creds?.configured),
          available: false,
          latencyMs: 0,
          reason: '未探测（默认只探当前生效模型；要看全部请用 ?deep=1 —— 每个模型都会真发一次计费请求）',
          active: id === input.active,
          fallback: input.fallbacks.includes(id),
          sources: [...srcSet],
          cached: false,
          probe: 'skipped',
          judgedBy: 'provider.healthCheck',
        });
        continue;
      }
      const p = await this.probe(id, { force: deep });
      // ★ 只有**缓存未命中**才算真调用（`probeCalls` 与 `probed` 同源，不许自述不符）
      if (!cached) probed.push(id);
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
        probe: p.probe,
        judgedBy: p.judgedBy,
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
      // ★ 成本可见：探了谁、花了多少次、跳过了谁、缓存多久（`probeCalls` 与 `probed` 同源）
      probed,
      probeCalls: probed.length,
      skippedProbe,
      ttlMs: this.ttl(),
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
