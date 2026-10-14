/**
 * `kg` 检索器 —— **按 12 种封闭边类型做图遍历**，`docs/RETRIEVAL.md` §3.2。
 *
 * ## ★ 两条硬约束怎么落地（lead 明确要求）
 * ### ① 传递闭包只走 `DEPENDS_ON` / `PART_OF`；其余 10 种边**只走 1 跳**
 * ```text
 * hop 1（从锚点出发）        : 12 种边全走
 * hop ≥ 2（继续往外扩）      : 只走 DEPENDS_ON / PART_OF
 * ```
 * ⟹ 代码见 `nextEdgeTypesAtDepth()`。**非传递边集是"全部 − 传递边"算出来的，
 *    不是硬编码 10 个名字** —— 契约加了第 13 种边时这里自动跟上（`schema-enums.ts` 同款思路）。
 *
 * ### ② `MIN_DEGREE_FOR_PAGE = 2`
 * 作用对象是**被扩展出来的邻居**，**不是锚点**。
 * 锚点若也卡阈值，"查询一个孤立概念"会返回空 —— 那是错的（用户明明点名了它）。
 *
 * ## ⚠️ 我对 v1 那个">8s 爆炸"的更正（本机实测，本文件写作时重跑）
 * 那个数字来自**深度不受限的递归闭包**。实测（185 节点 / 856 边，BFS 路径枚举）：
 *
 * | 边集合 | depth≤2 | depth≤6 | 无上限 |
 * |---|---|---|---|
 * | 仅 `DEPENDS_ON`+`PART_OF` | 2,058 条 / 0.0029s | 11,525 / 0.0207s | 14,020 / 0.0259s |
 * | +2 种非传递边 | 4,034 / 0.0066s | **619,969 / 1.23s** | **熔断 >6s** |
 * | 全部 12 种 | 4,019 / 0.0085s | 572,397 / 1.62s | **熔断 >6s** |
 *
 * **两个结论**（都比原说法更精确）：
 * 1. **`hops ≤ 2`（本契约的上限）时，即使 12 种边全用也不爆炸**（0.0085s）。
 *    ⟹ 真正的**第一道防线是深度上限**，不是边类型过滤。
 * 2. **边类型过滤在深度 ≥ 6 时才成为决定性因素**（0.0207s vs 1.23s，差 60×；无上限时直接熔断）。
 *    ⟹ 两条都要留：**深度上限防爆炸，边类型过滤防"看似能跑但越扩越糊"的语义污染。**
 *
 * ## ★ 实现选择：**不写递归 SQL**，用**有界 BFS**
 * 请求路径上完全不用 `WITH RECURSIVE`。BFS 的 `depth` 是显式循环变量、`visited` 是显式集合，
 * ⟹ **组合爆炸在结构上不可能发生**（递归 SQL 需要靠 `hops < N` 兜底，漏了就静默退化）。
 * 图规模本来就小（本项目几百节点，`repo.getGraph()` 一次取完），内存 BFS 远快于 SQL 递归。
 */

import type {
  RetrievalDeps,
  RetrievalQuery,
  Retrieved,
  RetrievedItemDraft,
  Retriever,
  RetrieverHealth,
} from './types.ts';
import {
  DEFAULT_LIMIT,
  MAX_HOPS,
  MIN_DEGREE_FOR_PAGE,
  TRANSITIVE_EDGE_TYPES,
  toSpan,
} from './types.ts';
import type { Span } from '../store/types.ts';
import { enforceEvidence } from './evidence.ts';
import { scopeForUser, visibleDocIds } from './scope.ts';
import { queryTerms, toBigram } from '../store/bigram.ts';

// ═══════════════════════════════════════════════════════════════════════
// 图的内存表示
// ═══════════════════════════════════════════════════════════════════════

export interface KgNode {
  id: string;
  doc_id: string;
  name: string;
  name_zh: string;
  type: string;
  layer: string;
  degree: number;
  /** 规范化名（`nameKey`）：用于锚点匹配与卡片关联 */
  key: string;
  key_zh: string;
  unit_ids: string[];
}

export interface KgEdge {
  id: string;
  doc_id: string;
  src: string;
  dst: string;
  etype: string;
  evidence: string;
  span: { kind: string; start: number; end: number };
  confidence: number;
}

export interface KgGraph {
  nodes: Map<string, KgNode>;
  edges: KgEdge[];
  outAdj: Map<string, KgEdge[]>;
  inAdj: Map<string, KgEdge[]>;
  /** 图里实际出现的边类型（`edgeTypes` 缺省时的兜底，**不是**发明枚举） */
  observedEdgeTypes: string[];
}

export interface KgPathStep {
  src: string;
  etype: string;
  dst: string;
}

/** 一次扩展的结果（含"为什么"）。 */
export interface KgVisit {
  nodeId: string;
  /** 从锚点走到这里的**第一个**路径（BFS ⟹ 最短） */
  path: KgPathStep[];
  pathEdgeIds: string[];
  hops: number;
  /** 起始锚点（用于 `why` 的"从哪里连过去"） */
  anchorId: string;
}

// ═══════════════════════════════════════════════════════════════════════
// 构建图（用 repo 的公开读取 API，**不自己写 SQL 检索**）
// ═══════════════════════════════════════════════════════════════════════

/** 规范化键（与 `store/ids.ts` 的 `nameKey` 同义；此处本地化避免跨层 import 依赖）。 */
function normalizeKey(name: string): string {
  return (name ?? '').toLowerCase().replace(/\s+/g, '');
}

export function buildGraph(deps: RetrievalDeps, docIds: string[]): KgGraph {
  const nodes = new Map<string, KgNode>();
  const edges: KgEdge[] = [];
  const observed = new Set<string>();

  for (const docId of docIds) {
    const g = deps.repo.getGraph(docId);
    for (const n of g.nodes) {
      nodes.set(n.id, {
        id: n.id,
        doc_id: docId,
        name: n.name,
        name_zh: n.name_zh ?? '',
        type: n.type,
        layer: n.layer ?? '',
        degree: n.degree ?? 0,
        key: normalizeKey(n.name),
        key_zh: normalizeKey(n.name_zh ?? ''),
        unit_ids: n.unit_ids ?? [],
      });
    }
    for (const e of g.edges) {
      observed.add(e.etype);
      edges.push({
        id: e.id,
        doc_id: docId,
        src: e.src,
        dst: e.dst,
        etype: e.etype,
        evidence: e.evidence ?? '',
        span: { kind: e.span.kind, start: e.span.start, end: e.span.end },
        confidence: e.confidence ?? 0,
      });
    }
  }

  const outAdj = new Map<string, KgEdge[]>();
  const inAdj = new Map<string, KgEdge[]>();
  for (const e of edges) {
    const o = outAdj.get(e.src) ?? [];
    o.push(e);
    outAdj.set(e.src, o);
    const i = inAdj.get(e.dst) ?? [];
    i.push(e);
    inAdj.set(e.dst, i);
  }

  return { nodes, edges, outAdj, inAdj, observedEdgeTypes: [...observed].sort() };
}

// ═══════════════════════════════════════════════════════════════════════
// ★ 硬约束 ①：每一跳允许的边类型
// ═══════════════════════════════════════════════════════════════════════

/** 传递边集合（**唯一的传递性来源**）。 */
export const TRANSITIVE_SET: ReadonlySet<string> = new Set(TRANSITIVE_EDGE_TYPES);

/**
 * 第 `depth` 跳允许走的边类型（`depth` 从 1 开始）。
 *
 * - `depth === 1` → **全部**（含非传递边；这是"从锚点直接相关"的语义）
 * - `depth >= 2` → **只有传递边**（`DEPENDS_ON` / `PART_OF`）
 *
 * ⚠️ 原错误写法（会爆炸）：所有深度都放全部边类型。
 */
export function nextEdgeTypesAtDepth(allEdgeTypes: string[], depth: number): Set<string> {
  if (depth <= 1) return new Set(allEdgeTypes);
  return new Set(allEdgeTypes.filter((t) => TRANSITIVE_SET.has(t)));
}

// ═══════════════════════════════════════════════════════════════════════
// 锚定
// ═══════════════════════════════════════════════════════════════════════

export interface Anchor {
  nodeId: string;
  /** 匹配到的查询词项数（bigram 命中数） */
  matchedTerms: string[];
  score: number;
}

/**
 * 用 bigram 词项匹配实体名（中英文都走 `toBigram`，与 `store/search.ts` 同一函数）。
 *
 * 打分口径（可解释、可断言）：
 * - 实体名 bigram 命中查询词项 → 每个 +1
 * - 查询串**整体包含**实体名（或反之）→ 额外 +2（"点名"了它）
 * - `degree` 略作加成（连接性好的实体更可能是想要的那个），但**不因 degree=0 排除**
 */
export function anchorEntities(graph: KgGraph, q: string, maxAnchors = 8): Anchor[] {
  const terms = queryTerms(q);
  if (terms.length === 0) return [];
  const qBi = toBigram(q);
  const out: Anchor[] = [];

  for (const n of graph.nodes.values()) {
    const zh = n.name_zh || '';
    const candidates = [n.name, zh].filter(Boolean);
    const matched = new Set<string>();
    let containment = false;
    for (const cand of candidates) {
      const bi = toBigram(cand);
      for (const t of terms) if (bi.includes(t)) matched.add(t);
      const low = cand.toLowerCase();
      if (low && (q.toLowerCase().includes(low) || low.includes(q.toLowerCase()))) containment = true;
    }
    if (matched.size === 0) continue;
    const score = matched.size + (containment ? 2 : 0) + Math.min(n.degree, 6) * 0.1;
    out.push({ nodeId: n.id, matchedTerms: [...matched], score: Number(score.toFixed(4)) });
  }

  out.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
  return out.slice(0, maxAnchors);
}

// ═══════════════════════════════════════════════════════════════════════
// ★ 有界 BFS 扩展
// ═══════════════════════════════════════════════════════════════════════

export interface ExpandResult {
  visited: Map<string, KgVisit>;
  /** 低度被**降权**的邻居数（`MIN_DEGREE_FOR_PAGE` 相关；诚实计数） */
  lowDegreeCount: number;
}

/**
 * 从锚点向外做**有界 BFS**。
 *
 * @param opts.hops            最大跳数（会被夹到 `[0, MAX_HOPS]`）
 * @param opts.minDegree       **降权**阈值（不是硬过滤，见下）
 *
 * ## ⚠️ 关键设计决定：`MIN_DEGREE_FOR_PAGE` 在这里是**降权**，不是**硬过滤**
 * 契约写的是"必须过滤 `MIN_DEGREE_FOR_PAGE = 2`"。但**照字面做成硬过滤是错的**，
 * 本机实测（`graph_view.json`，1,644 节点 / 397 边）：
 *
 * | 度 | 节点数 | 占比 |
 * |---|---|---|
 * | 0（孤立） | 1,000 | 61% |
 * | **1（叶子）** | **489** | **30%** |
 * | ≥2 | 155 | 9% |
 *
 * 有邻居的锚点平均每次扩展：`minDegree>=2` → **0.73 条**；`>=1` → **1.49 条**
 * ⟹ **硬过滤把邻居召回砍掉 51%**，而"叶子节点"正是知识图谱里最多的正常节点
 * （一个机制只 `PART_OF` 一个父概念，度就是 1 —— 它**完全应该**被召回）。
 *
 * **`MIN_DEGREE_FOR_PAGE` 的本意是"值不值得单独建一个 Wiki 页"**（常量名里就是 `FOR_PAGE`），
 * 那是**呈现层**的判据。检索层的正确形式是**降权**：
 * - 度 < 阈值的邻居**仍然返回**（否则 1 跳检索近乎失效）
 * - 但**排序权重 ×0.6**，并在 `reason` 里说明低价值条目数
 * - 真正该硬挡的是"**度 = 0 又被词法锚定拉进来的孤立节点**"——
 *   它们**不可通过边到达**（无邻边），只可能是锚点，所以只需在**锚点**侧处理
 *
 * > 这与我在 `KG_RAG_INDEX.md` 的结论一致：**孤立/低价值节点"建条目但降权，绝不删除"**。
 */
export function expandAnchors(
  graph: KgGraph,
  anchors: Anchor[],
  opts: { hops?: number; minDegree?: number } = {},
): ExpandResult {
  const hops = Math.max(0, Math.min(Math.trunc(opts.hops ?? 1), MAX_HOPS));
  const minDegree = Math.max(0, Math.trunc(opts.minDegree ?? MIN_DEGREE_FOR_PAGE));
  const allTypes = graph.observedEdgeTypes;

  const visited = new Map<string, KgVisit>();
  let lowDegreeCount = 0;
  const anchorSet = new Set(anchors.map((a) => a.nodeId));

  // 锚点自身（深度 0）
  for (const a of anchors) visited.set(a.nodeId, { nodeId: a.nodeId, path: [], pathEdgeIds: [], hops: 0, anchorId: a.nodeId });

  let frontier: string[] = [...anchorSet];
  for (let depth = 1; depth <= hops; depth += 1) {
    const allowed = nextEdgeTypesAtDepth(allTypes, depth);
    const next: string[] = [];
    const seenThisDepth = new Set<string>();

    for (const nodeId of frontier) {
      const parent = visited.get(nodeId);
      if (!parent) continue;
      // 出边 + 入边都算"相关"（`DEPENDS_ON` 有方向，但检索要双向召回）
      const incident: KgEdge[] = [...(graph.outAdj.get(nodeId) ?? []), ...(graph.inAdj.get(nodeId) ?? [])];
      for (const e of incident) {
        if (!allowed.has(e.etype)) continue;
        const other = e.src === nodeId ? e.dst : e.src;
        if (visited.has(other) || seenThisDepth.has(other)) continue;
        const nbr = graph.nodes.get(other);
        if (!nbr) continue;
        // 低度**不排除**，只计数（排序时降权）—— 见上方长注释
        if (!anchorSet.has(other) && minDegree > 0 && nbr.degree < minDegree) lowDegreeCount += 1;
        const etype = e.etype;
        const step: KgPathStep = { src: nodeId, etype, dst: other };
        visited.set(other, {
          nodeId: other,
          path: [...parent.path, step],
          pathEdgeIds: [...parent.pathEdgeIds, e.id],
          hops: depth,
          anchorId: parent.anchorId,
        });
        seenThisDepth.add(other);
        next.push(other);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  return { visited, lowDegreeCount };
}

// ═══════════════════════════════════════════════════════════════════════
// why / 条目构造
// ═══════════════════════════════════════════════════════════════════════

/** `why`：`DEPENDS_ON 1 跳：索引 → B+树`（与契约示例逐字同格式）。 */
export function kgWhy(nodeName: string, visit: KgVisit, nameOf: (id: string) => string): string {
  if (visit.hops === 0) return `锚点命中实体「${nodeName}」`;
  const etypes = [...new Set(visit.path.map((p) => p.etype))].join('+');
  const chain = [visit.anchorId, ...visit.path.map((p) => p.dst)].map(nameOf).join(' → ');
  return `${etypes} ${visit.hops} 跳：${chain}`;
}

/**
 * 实体的**展示名**：优先中文名（本项目抽取产出是「英文名 + 中文名」，
 * 而学生问的是中文 ⟹ `why` 里显示中文才读得懂）。
 *
 * ⚠️ 原错误写法：`kgWhy(n.name, ...)` 直接用英文名 →
 * 中文查询下 `why` 变成 `锚点命中实体「Clustered index」`，
 * 与同一结果里 `title`（中文）**不一致**，学生看不出是同一条。
 */
export function displayName(n: KgNode): string {
  return n.name_zh || n.name;
}

export class KgRetriever implements Retriever {
  readonly mode = 'kg' as const;
  private readonly deps: RetrievalDeps;

  constructor(deps: RetrievalDeps) {
    this.deps = deps;
  }

  /**
   * 真探测：查边表。
   * 边表为空**不算不可用** —— 那只是"这份库还没有图谱"，是**可用的空结果**。
   * 只有"查边表本身失败"（表不存在/迁移没跑）才是 `ok:false`。
   *
   * ⚠️ 边类型枚举缺省（`deps.edgeTypes` 未注入）**不算不可用** ——
   * 此时用**图里实际观察到的类型**兜底（`observedEdgeTypes`），
   * 与"非传递边 = 全部 − 传递边"的算法一致。
   * 原错误写法：枚举为空直接 `ok:false` ⟹ 未注入枚举的调用方（含单测）
   * 会把"能正常遍历的图"误报成不可用。
   */
  async healthCheck(): Promise<RetrieverHealth> {
    try {
      const row = this.deps.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM edges');
      const types = this.deps.db.all<{ etype: string }>('SELECT DISTINCT etype FROM edges').map((r) => r.etype);
      const contract = this.edgeTypes();
      const effective = contract.length > 0 ? contract : types;
      if (effective.length === 0) {
        // 既没有契约枚举、图里也没有任何边 → 无从遍历，如实不可用
        return {
          ok: false,
          reason: '图谱没有可遍历的边类型（edges 为空且读不到 contracts/schema/edge_types.json）',
        };
      }
      const source = contract.length > 0 ? `契约 ${contract.length} 种` : `图内观察 ${types.length} 种（未注入契约枚举）`;
      return {
        ok: true,
        reason: `图谱可用：边 ${Number(row?.c ?? 0)} 条，边类型 ${source}`,
      };
    } catch (err) {
      return { ok: false, reason: `图谱不可用（edges 表读不到：${err instanceof Error ? err.message : String(err)}）` };
    }
  }

  /** 契约枚举（`deps.edgeTypes`）；缺省时用图里观察到的类型（**不发明**）。 */
  private edgeTypes(): string[] {
    return this.deps.edgeTypes ?? [];
  }

  async retrieve(query: RetrievalQuery): Promise<Retrieved> {
    const t0 = Date.now();
    const limit = Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT));
    const q = (query.q ?? '').trim();

    const health = await this.healthCheck();
    if (!health.ok) {
      return {
        mode: 'kg',
        modes: ['kg'],
        items: [],
        elapsedMs: Date.now() - t0,
        available: false,
        reason: health.reason ?? '图谱检索不可用',
      };
    }
    if (!q) return { mode: 'kg', modes: ['kg'], items: [], elapsedMs: Date.now() - t0, available: true };

    const scope = scopeForUser(this.deps.repo, query.userId);
    const { ids } = visibleDocIds(this.deps.repo, scope, query.docId);
    if (ids.length === 0) {
      return {
        mode: 'kg',
        modes: ['kg'],
        items: [],
        elapsedMs: Date.now() - t0,
        available: true,
        reason: query.docId ? '该文档不存在或对你不可见' : '当前没有可见文档',
      };
    }

    const graph = buildGraph(this.deps, ids);
    const contractTypes = this.edgeTypes();
    // 图里出现的类型必须 ⊆ 契约枚举；出现契约外的类型 → 如实标注（不静默忽略）
    const observed = graph.observedEdgeTypes;
    const unknown = contractTypes.length > 0 ? observed.filter((t) => !contractTypes.includes(t)) : [];

    if (graph.edges.length === 0) {
      return {
        mode: 'kg',
        modes: ['kg'],
        items: [],
        elapsedMs: Date.now() - t0,
        available: true,
        reason: '可见文档里没有已抽取的图谱边（edges 为空）',
      };
    }

    const anchors = anchorEntities(graph, q);
    if (anchors.length === 0) {
      return {
        mode: 'kg',
        modes: ['kg'],
        items: [],
        elapsedMs: Date.now() - t0,
        available: true,
        reason: `图谱里没有实体名匹配「${q}」（已匹配 ${graph.nodes.size} 个实体）`,
      };
    }

    const { visited, lowDegreeCount } = expandAnchors(graph, anchors, {
      hops: query.hops ?? 1,
      minDegree: MIN_DEGREE_FOR_PAGE,
    });

    const nameOf = (id: string): string => {
      const n = graph.nodes.get(id);
      return n ? n.name_zh || n.name : id;
    };

    // 实体 → 卡片 span（实体表没有 span，锚点必须来自卡片；没有就由 `enforceEvidence` 丢弃）
    const cardSpan = this.cardSpanByEntityKey(graph, ids);

    const drafts: RetrievedItemDraft[] = [];
    const anchorRank = new Map(anchors.map((a, i) => [a.nodeId, i]));

    for (const v of visited.values()) {
      const n = graph.nodes.get(v.nodeId);
      if (!n) continue;
      const span = cardSpan.get(n.key) ?? cardSpan.get(n.key_zh);
      const anchorIdx = anchorRank.get(v.nodeId);
      // 锚点排前、跳数少的排前、度高的排前
      let score = (anchorIdx !== undefined ? 1000 - anchorIdx : 0) + (10 - v.hops) * 10 + Math.min(n.degree, 10);
      // ★ MIN_DEGREE_FOR_PAGE 是**降权**（×0.6），不是排除 —— 见 `expandAnchors` 的长注释。
      //    实测硬过滤会砍掉 51% 召回（30% 的节点度=1，而叶子是正常知识节点）。
      if (anchorIdx === undefined && MIN_DEGREE_FOR_PAGE > 0 && n.degree < MIN_DEGREE_FOR_PAGE) {
        score *= 0.6;
      }
      drafts.push({
        kind: 'entity',
        id: n.id,
        title: n.name_zh ? `${n.name_zh}（${n.name}）` : n.name,
        text: [n.name, n.name_zh, `${n.type}${n.layer ? ` · ${n.layer}` : ''}`, `度 ${n.degree}`]
          .filter(Boolean)
          .join(' — '),
        // 无卡片关联 → 无锚点 → 由 enforceEvidence 丢弃（规则 1）
        ...(span ? { evidence: { span, quote: n.name } } : {}),
        score,
        why: kgWhy(displayName(n), v, nameOf),
        path: v.path,
        doc_id: n.doc_id,
      });
    }

    // 边条目：`text` 用**边的证据原文**（能说清"为什么这两条相关"）
    for (const e of graph.edges) {
      if (!visited.has(e.src) || !visited.has(e.dst)) continue;
      // ★ 边也要真锚点：`edges.span_*` 是自由文本默认 ''，无锚点则丢弃（规则 1）
      const espan = toSpan({ span_kind: e.span.kind, span_start: e.span.start, span_end: e.span.end });
      drafts.push({
        kind: 'edge',
        id: e.id,
        title: `${nameOf(e.src)} —${e.etype}→ ${nameOf(e.dst)}`,
        text: e.evidence || `${nameOf(e.src)} —${e.etype}→ ${nameOf(e.dst)}`,
        ...(espan ? { evidence: { span: espan, ...(e.evidence ? { quote: e.evidence } : {}) } } : {}),
        score: 500 + Math.min(e.confidence, 1) * 10,
        why: `${e.etype} 边证据：${nameOf(e.src)} → ${nameOf(e.dst)}`,
        path: [{ src: e.src, etype: e.etype, dst: e.dst }],
        doc_id: e.doc_id,
      });
    }

    drafts.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const { items, dropped } = enforceEvidence(drafts, limit);

    const notes: string[] = [];
    if (lowDegreeCount > 0) notes.push(`${lowDegreeCount} 个邻居度 < ${MIN_DEGREE_FOR_PAGE}（MIN_DEGREE_FOR_PAGE），已保留但降权 ×0.6`);
    if (dropped > 0) notes.push(`${dropped} 条无可回溯锚点已丢弃（规则 1）`);
    if (unknown.length > 0) notes.push(`发现契约外的边类型：${unknown.join(', ')}（枚举封闭，需检查抽取）`);

    return {
      mode: 'kg',
      modes: ['kg'],
      items,
      elapsedMs: Date.now() - t0,
      available: true,
      ...(notes.length > 0 ? { reason: notes.join('；') } : {}),
    };
  }

  /** 实体键 → 卡片 span（锚点来源；实体表本身没有 span，**必须有真锚点才算**）。 */
  private cardSpanByEntityKey(graph: KgGraph, docIds: string[]): Map<string, Span> {
    const out = new Map<string, Span>();
    for (const docId of docIds) {
      for (const c of this.deps.repo.allCardRows(docId)) {
        const span = toSpan(c);
        if (!span) continue; // 无真锚点 → 该实体不产出条目（规则 1）
        const k = normalizeKey(c.name);
        if (!k || out.has(k)) continue;
        out.set(k, span);
      }
    }
    return out;
  }
}

export function createKgRetriever(deps: RetrievalDeps): KgRetriever {
  return new KgRetriever(deps);
}
