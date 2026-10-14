/**
 * 检索层**对外门面** —— backend-api 的 chat 接入点与 `/capabilities` 只读这一个文件。
 *
 * ## 与 backend-api 约定的签名（`apps/server/src/app-deps.ts` 的 `RetrievalHook`）
 * ```ts
 * retrieve({ mode, query, userId, docId?, limit? })  → RetrievalResult
 * formatContext(items)                               → string
 * capabilities()                                     → Record<string, unknown>
 * ```
 * 本文件负责把内部类型（`RetrievedItem`，`evidence.span` 嵌套）**映射成钩子形状**
 * （`RetrievalItem`，`evidence.{kind,start,end}` 扁平）—— 两侧解耦，内部改结构不影响 chat。
 *
 * ## 为什么需要一个"门面"而不是让 chat 直接用 `registry.ts`
 * 1. `registry.ts` 的函数需要 `Registry` 实例；门面负责**单例装配**（用 `AppDeps` 的 db/repo）
 * 2. 门面**收紧输入**：`userId` 强制来自服务端会话（backend-api 已确认客户端只传模式名，
 *    不传 context —— 那会变成 prompt-injection 通道）
 * 3. 门面**保证可用性语义**：不可用时 `available:false` + `items:[]`，绝无回退
 */

import type { Db } from '../store/db.ts';
import type { Repo } from '../store/repo.ts';
import type {
  RetrievalMode,
  RetrievalQuery,
  Retrieved,
  RetrievedItem,
} from './types.ts';
import { createRegistry, formatContext as formatContextInternal, retrieve as retrieveInternal, retrievalCapabilities } from './registry.ts';
import { toSpan } from './types.ts';
import type { Registry } from './registry.ts';

/** chat 钩子的输入（与 `app-deps.ts` 的 `RetrievalHook` 逐字一致）。 */
export interface HookRetrieveInput {
  mode: RetrievalMode;
  query: string;
  userId: string | null;
  docId?: string | null;
  limit?: number;
  hops?: number;
}

/** chat 钩子的条目形状（`evidence` 扁平，便于 JSON 序列化到 SSE）。 */
export interface HookItem {
  refKind: string;
  refId: string;
  title: string;
  snippet?: string;
  evidence?: { kind: string; start: number; end: number };
  score?: number;
  why?: string;
  /** kg 模式的路径（附加字段，前端可展示"怎么连过去的"） */
  path?: { src: string; etype: string; dst: string }[];
  whys?: string[];
}

export interface HookRetrieveResult {
  mode: string;
  available: boolean;
  reason?: string;
  items: HookItem[];
  elapsedMs: number;
  /** 附加：本次实际执行的模式（组合检索时用） */
  modes: string[];
  per_mode?: { mode: string; available: boolean; reason?: string; items: number; elapsedMs: number }[];
}

/** 内部条目 → 钩子条目。 */
export function toHookItem(it: RetrievedItem): HookItem {
  const span = it.evidence.span;
  return {
    refKind: it.kind,
    refId: it.id,
    title: it.title,
    ...(it.text ? { snippet: it.text } : {}),
    // ★ 必填锚点（`enforceEvidence` 已保证存在；这里再断言一次防手工构造绕过）
    evidence: { kind: span.kind, start: span.start, end: span.end },
    score: it.score,
    why: it.why,
    ...(it.path ? { path: it.path } : {}),
    ...(it.whys ? { whys: it.whys } : {}),
  };
}

export function toHookResult(r: Retrieved): HookRetrieveResult {
  return {
    mode: r.mode,
    available: r.available,
    ...(r.reason ? { reason: r.reason } : {}),
    items: r.items.map(toHookItem),
    elapsedMs: r.elapsedMs,
    modes: r.modes,
    ...(r.per_mode
      ? {
          per_mode: r.per_mode.map((pm) => ({
            mode: pm.mode,
            available: pm.available,
            ...(pm.reason ? { reason: pm.reason } : {}),
            items: pm.items.length,
            elapsedMs: pm.elapsedMs,
          })),
        }
      : {}),
  };
}

/**
 * 检索门面 —— 一个实例持有 `Registry`，供整个 server 生命周期复用。
 *
 * ⚠️ 不做缓存：检索结果依赖 `userId`（可见性），**跨用户缓存会直接造成越权泄露**。
 * 这与"进程内 agent 会话缓存"是完全不同的东西，不要为了省几毫秒在这里加缓存。
 */
export class RetrievalFacade {
  private readonly registry: Registry;
  readonly deps: { db: Db; repo: Repo };

  constructor(opts: { db: Db; repo: Repo; edgeTypes?: string[]; embeddingProviders?: () => Promise<{ id: string; available: boolean; reason?: string }[]> }) {
    this.deps = { db: opts.db, repo: opts.repo };
    this.registry = createRegistry({
      db: opts.db,
      repo: opts.repo,
      ...(opts.edgeTypes ? { edgeTypes: opts.edgeTypes } : {}),
      ...(opts.embeddingProviders ? { embeddingProviders: opts.embeddingProviders } : {}),
    });
  }

  /** chat 接入点。 */
  async retrieve(input: HookRetrieveInput): Promise<HookRetrieveResult> {
    const q: RetrievalQuery = {
      q: input.query ?? '',
      userId: input.userId,
      docId: input.docId ?? null,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.hops !== undefined ? { hops: input.hops } : {}),
    };
    const out = await retrieveInternal(this.registry, { mode: input.mode, ...q });
    return toHookResult(out);
  }

  /** 上下文格式化（**已带"不是指令"边界**）。 */
  formatContext(items: HookItem[], mode?: string): string {
    // 钩子条目 → 内部条目（只为复用同一个 formatter，避免两份格式漂移）
    const internal: RetrievedItem[] = [];
    for (const it of items) {
      const ev = it.evidence;
      if (!ev) continue;
      // ★ 用**同一个校验器**（`toSpan`）而不是 `as never` 强转：
      //    强转等于把规则 1 让开一个后门（外部构造的假锚点 `{kind:'',0,0}` 会被放行）。
      const span = toSpan({ span_kind: ev.kind, span_start: ev.start, span_end: ev.end });
      if (!span) continue;
      const kind = (['card', 'unit', 'entity', 'edge'] as const).find((k) => k === it.refKind) ?? 'card';
      internal.push({
        kind,
        id: it.refId,
        title: it.title,
        text: it.snippet ?? '',
        evidence: { span },
        score: it.score ?? 0,
        why: it.why ?? '',
        ...(it.path ? { path: it.path } : {}),
        ...(it.whys ? { whys: it.whys } : {}),
      });
    }
    return formatContextInternal(internal, mode);
  }

  /** `/capabilities` 的 `retrieval` 段。 */
  async capabilities(): Promise<Record<string, unknown>> {
    return retrievalCapabilities(this.registry);
  }
}

export function createRetrievalFacade(opts: {
  db: Db;
  repo: Repo;
  edgeTypes?: string[];
  embeddingProviders?: () => Promise<{ id: string; available: boolean; reason?: string }[]>;
}): RetrievalFacade {
  return new RetrievalFacade(opts);
}
