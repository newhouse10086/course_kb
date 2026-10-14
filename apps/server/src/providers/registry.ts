/**
 * Provider 注册表 + **降级链** + 策略选择 + 能力上报
 *
 * 规格：[`docs/PROVIDERS.md`](../../../docs/PROVIDERS.md) §4.2 / §7 / §9
 *
 * ## 核心约定
 *  - **降级链每一跳都真探测**（`healthCheck`），不能只看配置（铁律 R2）
 *  - 降级发生时报 `degraded_from` + `reason`（可观测）
 *  - 全链失败 → 抛 `ProviderError`，**绝不返回假数据**（铁律 R3）
 */

import type { ProviderConfigEntry, ProviderKind, Policy } from './types.ts';
import { PROVIDER_KINDS, ProviderError, type Provider, type ProviderInfo, type HealthResult } from './types.ts';

/** 健康探测结果缓存时长（避免每次请求都打一次探测） */
export const HEALTH_TTL_MS = 300_000; // 300s，与 docs/PROVIDERS.md §7 一致

interface HealthCacheEntry {
  result: HealthResult;
  at: number;
}

export interface SelectOptions {
  /** 策略；不传则用配置里的 `policy[kind]` */
  policy?: Policy;
  /** `policy='explicit'` 时指定 id */
  explicitId?: string;
  /** 只考虑这些 id（白名单） */
  only?: string[];
}

/** 一次调用中，某个 provider 失败的原因 */
export interface AttemptFailure {
  id: string;
  reason: string;
}

export interface ChainResult<T> {
  value: T;
  usedProvider: string;
  /** 从哪个 provider 降级过来的（没降级则为 undefined） */
  degradedFrom?: string;
  degradedReason?: string;
  /** 完整尝试记录（含成功的最后一跳），便于排障与上报 */
  attempts: AttemptFailure[];
}

/**
 * 降级链执行器。
 *
 * ⚠️ **顺序即语义**：链上每一跳都会先 `healthCheck()`（带缓存），
 * 失败则记录原因并继续下一跳。
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderKind, Provider[]>();
  private readonly policy: Partial<Record<ProviderKind, Policy>>;
  private readonly health = new Map<string, HealthCacheEntry>();
  /** 探测时用：避免同一 provider 并发探测多次 */
  private readonly inflight = new Map<string, Promise<HealthResult>>();

  constructor(opts: { policy?: Partial<Record<ProviderKind, Policy>> } = {}) {
    this.policy = opts.policy ?? {};
    for (const k of PROVIDER_KINDS) this.providers.set(k, []);
  }

  // ─────────────────────────────────────────────
  // 注册
  // ─────────────────────────────────────────────

  register(p: Provider): void {
    const list = this.providers.get(p.info.kind);
    if (!list) throw new ProviderError('E_PROVIDER', `未知 kind: ${p.info.kind}`);
    if (list.some((x) => x.info.id === p.info.id)) {
      throw new ProviderError('E_PROVIDER', `provider id 重复: ${p.info.id}`);
    }
    list.push(p);
  }

  get(kind: ProviderKind, id: string): Provider | undefined {
    return this.providers.get(kind)?.find((p) => p.info.id === id);
  }

  list(kind: ProviderKind): Provider[] {
    return [...(this.providers.get(kind) ?? [])];
  }

  policyOf(kind: ProviderKind): Policy {
    return this.policy[kind] ?? 'local-first';
  }

  // ─────────────────────────────────────────────
  // 健康探测（带 TTL 缓存 + 去重）
  // ─────────────────────────────────────────────

  async check(p: Provider, opts: { force?: boolean } = {}): Promise<HealthResult> {
    const id = p.info.id;
    const now = Date.now();
    if (!opts.force) {
      const hit = this.health.get(id);
      if (hit && now - hit.at < HEALTH_TTL_MS) return hit.result;
    }
    const running = this.inflight.get(id);
    if (running) return running;

    const task = (async (): Promise<HealthResult> => {
      const t0 = Date.now();
      let result: HealthResult;
      try {
        result = await p.healthCheck();
      } catch (e) {
        // 探测本身抛错 = 不可用（不能让它冒泡打断整条链）
        result = { ok: false, reason: `探测异常：${(e as Error).message}` };
      }
      result.latencyMs ??= Date.now() - t0;
      this.health.set(id, { result, at: Date.now() });
      this.inflight.delete(id);
      return result;
    })();
    this.inflight.set(id, task);
    return task;
  }

  /** 清空探测缓存（配置热更新 / 用户点"重试"时用） */
  invalidate(id?: string): void {
    if (id) this.health.delete(id);
    else this.health.clear();
  }

  // ─────────────────────────────────────────────
  // 能力过滤 —— ⚠️ 降级时**不能只看"能连上"**，还要看"能力够不够"
  // ─────────────────────────────────────────────

  /**
   * 判断 provider 是否满足本次请求的能力要求。
   *
   * 例：本次 `requireWordTimestamps=true`，但某云端 provider 只有段级时间戳
   * → **跳过它继续下一跳**，而不是产出没有字级时间戳的残缺结果。
   */
  satisfies(p: Provider, require?: Record<string, unknown>): { ok: boolean; reason?: string } {
    if (!require) return { ok: true };
    const caps = p.info.capabilities ?? {};
    for (const [k, v] of Object.entries(require)) {
      if (v === undefined || v === null || v === false) continue;
      if (caps[k] !== v) {
        return { ok: false, reason: `不满足能力要求 ${k}=${String(v)}（实际 ${String(caps[k])}）` };
      }
    }
    return { ok: true };
  }

  // ─────────────────────────────────────────────
  // 降级链
  // ─────────────────────────────────────────────

  /**
   * 生成**有序降级链**（只按策略排序，不做探测）。探测在 `run()` 里逐跳进行。
   *
   * `local-first` / `cloud-first` / `cost` / `quality` / `explicit` 语义见 docs/PROVIDERS.md §4.2。
   */
  chain(kind: ProviderKind, opts: SelectOptions = {}): Provider[] {
    let list = this.list(kind);
    if (opts.only?.length) {
      const allow = new Set(opts.only);
      list = list.filter((p) => allow.has(p.info.id));
    }
    const policy = opts.policy ?? this.policyOf(kind);

    if (policy === 'explicit') {
      if (!opts.explicitId) {
        throw new ProviderError('E_NO_PROVIDER', `policy='explicit' 但未提供 explicitId`);
      }
      const one = list.filter((p) => p.info.id === opts.explicitId);
      if (!one.length) {
        throw new ProviderError('E_NO_PROVIDER', `未找到指定 provider: ${opts.explicitId}`);
      }
      return one;
    }

    const rank = (p: Provider): [number, number, number] => {
      const info = p.info;
      const price = info.pricing?.amount ?? Number.POSITIVE_INFINITY;
      switch (policy) {
        case 'local-first':
          // 本地优先；同 runtime 内尊重顺序
          return [info.runtime === 'local' ? 0 : 1, price, 0];
        case 'cloud-first':
          return [info.runtime === 'cloud' ? 0 : 1, price, 0];
        case 'cost':
          // 最便宜优先；免费(0)排最前
          return [price, info.runtime === 'local' ? 0 : 1, 0];
        case 'quality':
          // 质量优先：无法自动量化，用**注册顺序**表达（后注册=更优）
          return [0, 0, -list.indexOf(p)];
        default:
          return [0, price, 0];
      }
    };

    return [...list].sort((a, b) => {
      const [a0, a1, a2] = rank(a);
      const [b0, b1, b2] = rank(b);
      if (a0 !== b0) return a0 - b0;
      if (a1 !== b1) return a1 - b1;
      return a2 - b2;
    });
  }

  /**
   * 沿降级链执行，直到某一跳成功。
   *
   * @param require 能力要求（见 `satisfies`）
   * @param fn      实际调用；收到的 `usedProvider` 就是本次成功的那一跳
   *
   * ⚠️ **全链失败会抛 `ProviderError`** —— 调用方**不得**吞掉后返回假数据。
   */
  async run<T>(
    kind: ProviderKind,
    opts: SelectOptions & {
      require?: Record<string, unknown>;
      /** 跳过健康探测（仅用于测试；生产不要用，会给假绿） */
      skipHealthCheck?: boolean;
      /** 每跳失败时的回调（用于日志） */
      onAttempt?: (id: string, ok: boolean, reason?: string) => void;
    },
    fn: (p: Provider, meta: { degradedFrom?: string; degradedReason?: string }) => Promise<T>,
  ): Promise<ChainResult<T>> {
    const chain = this.chain(kind, opts);
    if (!chain.length) {
      throw new ProviderError(
        'E_NO_PROVIDER',
        `kind=${kind} 没有任何已注册的 provider`,
        `没有可用的${kind}能力，请在 config/providers.yaml 配置`,
      );
    }

    const attempts: AttemptFailure[] = [];
    let skippedByCapability = 0;

    for (const p of chain) {
      const info = p.info;

      // ① 凭据缺失 → 不必探测，直接记原因跳过
      if (!info.configured) {
        const reason = info.reason ?? '凭据未配置';
        attempts.push({ id: info.id, reason: `未配置：${reason}` });
        opts.onAttempt?.(info.id, false, reason);
        continue;
      }

      // ② 能力不满足 → 跳过（**不能产出残缺数据**）
      const cap = this.satisfies(p, opts.require);
      if (!cap.ok) {
        attempts.push({ id: info.id, reason: `能力不足：${cap.reason}` });
        opts.onAttempt?.(info.id, false, cap.reason);
        skippedByCapability++;
        continue;
      }

      // ③ 真探测（铁律 R2）
      if (!opts.skipHealthCheck) {
        const h = await this.check(p);
        if (!h.ok) {
          const reason = h.reason ?? '健康探测失败';
          attempts.push({ id: info.id, reason });
          opts.onAttempt?.(info.id, false, reason);
          continue;
        }
      }

      // ④ 真正调用
      const firstFailure = attempts[0];
      const degradedFrom = firstFailure?.id;
      const degradedReason = firstFailure
        ? `${firstFailure.reason}${attempts.length > 1 ? ` 等 ${attempts.length} 个原因` : ''}`
        : undefined;
      try {
        const value = await fn(p, { degradedFrom, degradedReason });
        opts.onAttempt?.(info.id, true);
        return { value, usedProvider: info.id, degradedFrom, degradedReason, attempts };
      } catch (e) {
        const reason = e instanceof ProviderError ? `${e.code}: ${e.message}` : (e as Error).message;
        attempts.push({ id: info.id, reason: `调用失败：${reason}` });
        opts.onAttempt?.(info.id, false, reason);
        // 该 provider 刚失败 → 让它下次重新探测
        this.invalidate(info.id);
        continue;
      }
    }

    const detail = attempts.map((a) => `${a.id} → ${a.reason}`).join('；');
    const hint = skippedByCapability === attempts.length
      ? `有 ${attempts.length} 个 provider，但都不满足本次能力要求（${JSON.stringify(opts.require ?? {})}）`
      : `已尝试 ${attempts.length} 个 provider 全部失败，请检查凭据/额度/网络`;
    throw new ProviderError(
      attempts.some((a) => a.reason.includes('未配置')) ? 'E_NOT_CONFIGURED' : 'E_UNAVAILABLE',
      `${kind} 降级链全部失败：${detail}`,
      hint,
      detail,
    );
  }

  // ─────────────────────────────────────────────
  // 能力上报（/api/v1/capabilities 的 providers 段）
  // ─────────────────────────────────────────────

  /**
   * 逐 provider 上报，**如实反映 `configured` 与 `available`**。
   *
   * ⚠️ **不回显任何凭据**，只报 `configured` 与缺哪个环境变量。
   *
   * @param deep true = 真探测（慢，但准）；false = 只报配置态 + 已有缓存
   */
  async capabilities(opts: { deep?: boolean; kinds?: ProviderKind[] } = {}): Promise<{
    providers: Record<string, ProviderInfo[]>;
    policy: Record<string, Policy>;
  }> {
    const kinds = opts.kinds ?? [...PROVIDER_KINDS];
    const providers: Record<string, ProviderInfo[]> = {};
    const policy: Record<string, Policy> = {};

    for (const kind of kinds) {
      const list = this.list(kind);
      policy[kind] = this.policyOf(kind);
      providers[kind] = await Promise.all(
        list.map(async (p): Promise<ProviderInfo> => {
          const info: ProviderInfo = { ...p.info };
          if (!info.configured) {
            info.available = false;
            return info; // 未配置 → 不探测（省时间，且原因已明确）
          }
          if (opts.deep) {
            const h = await this.check(p, { force: true });
            info.available = h.ok;
            info.reason = h.ok ? undefined : (h.reason ?? '健康探测失败');
          } else {
            const cached = this.health.get(info.id);
            info.available = cached?.result.ok ?? false;
            info.reason = cached?.result.ok === false
              ? cached.result.reason
              : cached
                ? undefined
                : '尚未探测（调用 /api/v1/capabilities?deep=1 触发真探测）';
          }
          return info;
        }),
      );
    }
    return { providers, policy };
  }
}

// ─────────────────────────────────────────────────────────────
// 从配置构建注册表（工厂）
// ─────────────────────────────────────────────────────────────

/** 各 provider `type` → 构造函数。实现按需注册，未实现的 type 会被如实跳过并给出 reason。 */
export type ProviderFactory = (entry: ProviderConfigEntry) => Provider | null;

export interface BuildOptions {
  /** 由 T-BACKEND 的 `config.ts::loadProviderConfig()` 产出 */
  config: { policy: Partial<Record<ProviderKind, Policy>>; providers: Partial<Record<ProviderKind, ProviderConfigEntry[]>> };
  factories: Partial<Record<string, ProviderFactory>>;
  /** 未注册 type 的告警回调 */
  onSkip?: (entry: ProviderConfigEntry, reason: string) => void;
}

/** 从配置组装注册表；未知 `type` 不抛错（配置里有将来才实现的 provider 是正常的） */
export function buildRegistry(opts: BuildOptions): ProviderRegistry {
  const reg = new ProviderRegistry({ policy: opts.config.policy });
  for (const kind of PROVIDER_KINDS) {
    for (const entry of opts.config.providers[kind] ?? []) {
      if (entry.enabled === false) continue;
      const factory = opts.factories[entry.type];
      if (!factory) {
        opts.onSkip?.(entry, `未实现的 provider type: ${entry.type}`);
        continue;
      }
      const p = factory(entry);
      if (!p) {
        opts.onSkip?.(entry, `factory 返回 null: ${entry.type}`);
        continue;
      }
      reg.register(p);
    }
  }
  return reg;
}
