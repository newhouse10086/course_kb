/**
 * 检索层契约类型（`docs/RETRIEVAL.md` §2）—— 四种模式**并列、各自独立**，默认 `none`。
 *
 * ## 设计要点（三条不可动摇的规则）
 * 1. **`RetrievedItem.evidence` 在输出侧是必填的** —— 没有可回溯锚点（页码/毫秒）的条目
 *    **不许进上下文**。内部草稿用 `RetrievedItemDraft`（可选），由 `registry.ts`
 *    的 `enforceEvidence()` 统一收口：**丢掉的条目要计数**（不许静默丢）。
 * 2. **模式不可用不许回退冒充** —— `rag` 不可用时 `available:false` + `reason` + `items:[]`，
 *    **绝不**改走 wiki 的数据（那会让用户以为查过向量库）。
 * 3. **跨用户隔离在 SQL 层**（`docs/RBAC.md` §6）—— 见 `scope.ts`，不是"取回来再过滤"。
 *
 * ⚠️ AGENTS.md 坑 T2：Node strip-only TS **不支持 `enum`** —— 一律 union + `as const` 数组。
 */

import type { Span, SpanKind } from '../store/types.ts';
import { isSpanKind } from '../store/types.ts';

// ═══════════════════════════════════════════════════════════════════════
// 模式
// ═══════════════════════════════════════════════════════════════════════

export const RETRIEVAL_MODES = ['none', 'wiki', 'kg', 'rag'] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];
/** 显式组合（`['wiki','kg']`）；默认 `'none'`。 */
export type RetrievalModeSpec = RetrievalMode | RetrievalMode[];

/** 契约 §1：**默认 `none`** —— 保证"不做检索也能用"，且不让用户以为每个回答都查过库。 */
export const DEFAULT_RETRIEVAL_MODE: RetrievalMode = 'none';
export const DEFAULT_LIMIT = 8;
/** kg：从命中节点向外走几跳（默认 1，**最大 2**）。 */
export const MAX_HOPS = 2;

/**
 * ★ 已验证常量（AGENTS.md §5：不要重新发明）。
 * v1 实测：**64% 实体零边**；不设阈值会把一堆孤立节点拉进上下文。
 * 语义：**扩展（邻居）候选**必须 `degree >= 2`；**锚点**（查询精确命中的实体）不受此限，
 * 否则"查询一个孤立概念"会返回空 —— 那是错的。
 */
export const MIN_DEGREE_FOR_PAGE = 2;

/**
 * ★ 传递闭包**只允许**这两种边（`KG_WIKI_CORE` §5 实测硬约束）。
 * 其余边**只走 1 跳**。见 `kg.ts` 的 `expandAnchors()`。
 */
export const TRANSITIVE_EDGE_TYPES = ['DEPENDS_ON', 'PART_OF'] as const;
export type TransitiveEdgeType = (typeof TRANSITIVE_EDGE_TYPES)[number];

export function isRetrievalMode(v: unknown): v is RetrievalMode {
  return typeof v === 'string' && (RETRIEVAL_MODES as readonly string[]).includes(v);
}

/**
 * 规范化模式表达式。
 *
 * ⚠️ 必须**显式拒绝**未知模式，而不是静默当 `none` ——
 * 静默降级会让"我选了 kg 但拿到的是没检索的答案"这种 bug 无法被发现。
 * 非法值由调用方转成 `available:false` + `reason`（见 `registry.ts`）。
 */
export function normalizeModeSpec(spec: unknown): { modes: RetrievalMode[]; invalid: string[] } {
  const raw: unknown[] = Array.isArray(spec) ? spec : [spec];
  const modes: RetrievalMode[] = [];
  const invalid: string[] = [];
  for (const item of raw) {
    if (item === undefined || item === null || item === '') continue;
    if (isRetrievalMode(item)) {
      if (!modes.includes(item)) modes.push(item);
    } else {
      invalid.push(String(item));
    }
  }
  if (modes.length === 0 && invalid.length === 0) modes.push(DEFAULT_RETRIEVAL_MODE);
  return { modes, invalid };
}

// ═══════════════════════════════════════════════════════════════════════
// 查询 / 结果
// ═══════════════════════════════════════════════════════════════════════

export interface RetrievalQuery {
  q: string;
  /** 限定文档（`null`/缺省 = 全部可见文档） */
  docId?: string | null;
  /** ★ 跨用户隔离依据（RBAC §6）；`null` = 匿名（只能看 public+published） */
  userId?: string | null;
  limit?: number;
  /** kg 用；默认 1，**最大 `MAX_HOPS`** */
  hops?: number;
}

/** 可回溯锚点：`page`/`slide` 是 1-based 编号，`time` 是毫秒，`char` 是字符偏移。 */
export interface EvidenceRef {
  span: Span;
  /** 原文逐字摘录（**必须是原文，不许模型改写**） */
  quote?: string;
}

export type RetrievedKind = 'card' | 'unit' | 'entity' | 'edge';

/** 输出条目 —— `evidence` **必填**（规则 1）。 */
export interface RetrievedItem {
  kind: RetrievedKind;
  id: string;
  title: string;
  /** 给 LLM 的上下文正文（原文摘录） */
  text: string;
  evidence: EvidenceRef;
  score: number;
  /** ★ 可解释性：学生要能看懂检索逻辑（四种模式对比本身是教学内容） */
  why: string;
  /** 组合检索时汇集各模式的 `why`（`why` 为它的 `' ｜ '` 连接） */
  whys?: string[];
  /** kg 模式：完整路径（便于展示"怎么连过去的"） */
  path?: { src: string; etype: string; dst: string }[];
  doc_id?: string;
}

/** 内部草稿：`evidence` 可选，交由 `enforceEvidence()` 收口。 */
export type RetrievedItemDraft = Omit<RetrievedItem, 'evidence'> & { evidence?: EvidenceRef };

export interface RetrievedPerMode {
  mode: RetrievalMode;
  available: boolean;
  reason?: string;
  items: RetrievedItem[];
  elapsedMs: number;
  /** 被 `enforceEvidence()` 丢弃的无锚点条目数（诚实计数，不静默） */
  dropped_no_evidence: number;
}

export interface Retrieved {
  /** 单模式时为该模式；显式组合时为 `'multi'`。 */
  mode: RetrievalMode | 'multi';
  /** 本次实际执行的模式（顺序即请求顺序） */
  modes: RetrievalMode[];
  items: RetrievedItem[];
  elapsedMs: number;
  /**
   * 是否**至少有一个**请求的模式真跑成功。
   * ⚠️ 单模式不可用时必须 `false` + `items:[]`（规则 2：不许回退冒充）。
   */
  available: boolean;
  reason?: string;
  per_mode?: RetrievedPerMode[];
}

// ═══════════════════════════════════════════════════════════════════════
// Retriever 接口 / 依赖
// ═══════════════════════════════════════════════════════════════════════

export interface RetrieverHealth {
  ok: boolean;
  reason?: string;
}

export interface Retriever {
  readonly mode: RetrievalMode;
  /** 真探测：wiki 查一次空串；kg 查边表；rag 查 provider/表是否就绪。 */
  healthCheck(): Promise<RetrieverHealth>;
  retrieve(q: RetrievalQuery): Promise<Retrieved>;
}

/** rag 的 embedding provider 探测结果（由调用方注入，避免检索层耦合 providers/）。 */
export interface EmbeddingProviderProbe {
  id: string;
  available: boolean;
  reason?: string;
}

export interface RetrievalDeps {
  /** 直接复用 store 层（**不重写 SQL 检索** —— bigram/脏索引已在那里处理，坑 15/16）。 */
  db: import('../store/db.ts').Db;
  repo: import('../store/repo.ts').Repo;
  /**
   * 封闭枚举的边类型（来自 `contracts/schema/edge_types.json`）。
   * 缺省时 kg 从图里实际出现的类型推断；**非传递边 = 全部 − 传递边**（不硬编码 10 个）。
   */
  edgeTypes?: string[];
  /** rag 用；缺省 = 没有 embedding provider（如实 `available:false`）。 */
  embeddingProviders?: () => Promise<EmbeddingProviderProbe[]>;
}

/**
 * `RetrievedItem.evidence` 的守卫（`enforceEvidence` 用）。
 *
 * ⚠️ 判据必须**分 span 类型**，否则会误杀合法锚点：
 * - `page`/`slide` 是 **1-based** → `start >= 1`（DB 默认值 `span_kind=''`+`0/0` 即"没锚点"）
 * - `char` 是**字符偏移** → `start === 0`（文档开头的那张卡片）**完全合法**，
 *   原错误写法 `start >= 1` 会把它误判成"无锚点"并静默丢弃。
 * - `time` 是毫秒 → `start >= 0`（视频第 0ms 的字幕合法）
 */
export function hasEvidence(item: RetrievedItemDraft): item is RetrievedItem {
  const ev = item.evidence;
  if (!ev || !ev.span) return false;
  return isValidSpan(ev.span);
}

/** 锚点有效性（**唯一的判据实现**，`hasEvidence` 与 `toSpan` 共用）。 */
export function isValidSpan(span: { kind: unknown; start: unknown; end: unknown }): boolean {
  const { kind, start, end } = span;
  // 先窄化 kind（`isSpanKind` 只接受 string）
  if (typeof kind !== 'string' || !isSpanKind(kind)) return false;
  if (typeof start !== 'number' || typeof end !== 'number') return false;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (end < start) return false;
  if ((kind === 'page' || kind === 'slide') && start < 1) return false;
  return start >= 0;
}

/**
 * DB 的行 → 合法 `Span`。
 *
 * ⚠️ **不要用 `as const` 强转**：DB 里 `span_kind` 是自由文本（默认 `''`），
 * 强转只是把类型检查骗过去，运行期仍可能出现 `{kind:'',start:0,end:0}` 这种**假锚点**
 * —— 而假锚点会让规则 1（`evidence` 必填）失效：**它"有 evidence 字段"但没有任何可回溯信息**。
 * 返回 `null` 表示"这一行没有真锚点"，调用方据此丢弃。
 */
export function toSpan(row: { span_kind?: unknown; span_start?: unknown; span_end?: unknown }): Span | null {
  const cand = { kind: row.span_kind, start: row.span_start, end: row.span_end };
  if (!isValidSpan(cand)) return null;
  return { kind: cand.kind as SpanKind, start: cand.start as number, end: cand.end as number };
}
