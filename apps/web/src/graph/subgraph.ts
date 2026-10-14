/**
 * 图谱数据归一化与**子图抽取**（纯函数，Vitest 直接测）
 *
 * 这里是「Wiki 页内嵌图谱」（用户核心要求）的数据来源：
 *   · localSubgraph  —— 当前单元的实体 + N 跳邻居（单元内种子来自 node.unit_ids，
 *                       若后端没给 unit_ids 就用"卡片名反查实体"兜底，见 seedIds）
 *   · cardNeighborhood —— 卡片级迷你关系图（typed / mention / also_in / same_unit）
 */
import type { Card, GraphEdge, GraphNode, Xref } from '../api/types'
import { inferLayer } from './palette'

export interface GNode {
  id: string
  name: string
  name_zh: string
  type: string
  layer: string
  degree: number
  unit_ids: string[]
}

export interface GEdge {
  id: string
  src: string
  dst: string
  etype: string
  evidence: string
  span: { kind: string; start: number; end: number } | null
  confidence: number
  /** 因果可疑：只标记不删除（契约 §2.4）→ 画虚线 */
  flagged: boolean
}

export interface SubGraph {
  nodes: GNode[]
  edges: GEdge[]
  seed_count: number
  seed_source: 'unit_ids' | 'card_names' | 'unit_ids+card_names' | 'focus' | 'none'
}

/** 契约 §5.2 /graph 响应 → 引擎数据。边的端点是 **src/dst**（写成 from/to 会整图无边） */
export function normalizeGraph(nodes: GraphNode[] | undefined, edges: GraphEdge[] | undefined): { nodes: GNode[]; edges: GEdge[] } {
  const ns: GNode[] = (nodes || []).map((n) => ({
    id: String(n.id),
    name: n.name || String(n.id),
    name_zh: n.name_zh || '',
    type: n.type || '',
    layer: n.layer || inferLayer(n.type),
    degree: Number(n.degree || 0),
    unit_ids: (n.unit_ids || (n as any).units || []).map(String),
  }))
  const ids = new Set(ns.map((n) => n.id))
  const deg = new Map<string, number>()
  const es: GEdge[] = []
  for (const e of (edges || [])) {
    const src = String((e as any).src ?? (e as any).from)
    const dst = String((e as any).dst ?? (e as any).to)
    if (!ids.has(src) || !ids.has(dst) || src === dst) continue      // 悬空边不画（也不改数据）
    deg.set(src, (deg.get(src) || 0) + 1)
    deg.set(dst, (deg.get(dst) || 0) + 1)
    es.push({
      id: String(e.id ?? `${src}->${dst}:${e.etype}`),
      src, dst,
      etype: e.etype || '',
      evidence: e.evidence || (e as any).evidence_text || '',
      span: (e.span ?? null) as GEdge['span'],
      confidence: Number(e.confidence || 0),
      flagged: e.flagged === true || (e.flagged as unknown) === 1,
    })
  }
  for (const n of ns) if (!n.degree) n.degree = deg.get(n.id) || 0
  return { nodes: ns, edges: es }
}

export interface LocalSubgraphOptions {
  unitIds?: string[]
  /** 兜底种子：按卡片名反查到的实体 id（后端没给 unit_ids 时仍能用） */
  seedIds?: string[]
  focusId?: string | null
  hops?: number
  maxNodes?: number
}

export function localSubgraph(
  graph: { nodes: GNode[] | GraphNode[]; edges: GEdge[] | GraphEdge[] },
  options: LocalSubgraphOptions = {},
): SubGraph {
  const opts = { hops: 1, maxNodes: 160, ...options }
  const norm = normalizeGraph(graph.nodes as GraphNode[], graph.edges as GraphEdge[])
  const byId = new Map(norm.nodes.map((n) => [n.id, n]))
  const unitSet = new Set((opts.unitIds || []).map(String))

  const seeds = new Set<string>()
  for (const n of norm.nodes) if (n.unit_ids.some((u) => unitSet.has(u))) seeds.add(n.id)
  const unitSeedCount = seeds.size
  for (const id of (opts.seedIds || [])) if (byId.has(String(id))) seeds.add(String(id))
  const cardSeedCount = seeds.size - unitSeedCount
  if (opts.focusId && byId.has(String(opts.focusId))) seeds.add(String(opts.focusId))

  const seed_source: SubGraph['seed_source'] =
    unitSeedCount && cardSeedCount ? 'unit_ids+card_names'
      : unitSeedCount ? 'unit_ids'
        : cardSeedCount ? 'card_names'
          : seeds.size ? 'focus' : 'none'

  const adj = new Map<string, string[]>()
  for (const e of norm.edges) {
    if (!adj.has(e.src)) adj.set(e.src, [])
    if (!adj.has(e.dst)) adj.set(e.dst, [])
    adj.get(e.src)!.push(e.dst)
    adj.get(e.dst)!.push(e.src)
  }
  const keep = new Set(seeds)
  let frontier = Array.from(seeds)
  for (let h = 0; h < opts.hops; h++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const nb of (adj.get(id) || [])) {
        if (!keep.has(nb)) { keep.add(nb); next.push(nb) }
      }
    }
    frontier = next
  }
  let kept = Array.from(keep)
  if (kept.length > opts.maxNodes) {
    kept.sort((a, b) => {
      const sa = seeds.has(a) ? 1 : 0
      const sb = seeds.has(b) ? 1 : 0
      if (sa !== sb) return sb - sa
      return (byId.get(b)?.degree || 0) - (byId.get(a)?.degree || 0)
    })
    kept = kept.slice(0, opts.maxNodes)
  }
  const keptSet = new Set(kept)
  // 子图内重算 degree：否则节点半径反映的是全局 degree，看不出子图里的主次
  const deg = new Map<string, number>()
  const outEdges = norm.edges.filter((e) => {
    if (!keptSet.has(e.src) || !keptSet.has(e.dst)) return false
    deg.set(e.src, (deg.get(e.src) || 0) + 1)
    deg.set(e.dst, (deg.get(e.dst) || 0) + 1)
    return true
  })
  const outNodes = kept.map((id) => byId.get(id)).filter(Boolean).map((n) => ({
    ...n!, degree: deg.get(n!.id) || 0,
  }))
  return { nodes: outNodes, edges: outEdges, seed_count: seeds.size, seed_source }
}

export interface XrefIndex {
  out: Map<string, Array<{ id: string; rel: string; weight: number; name: string }>>
  in: Map<string, Array<{ id: string; rel: string; weight: number; name: string }>>
  /** 被丢掉的悬空/自引用条数（如实统计，别静默） */
  dropped: number
}

/** 由 /documents/{id}/xrefs 一次拉全，建出/入链索引（省掉 N 次卡片详情请求） */
export function buildXrefIndex(xrefs: Xref[] | undefined, cardsById: Map<string, Card>): XrefIndex {
  const out = new Map<string, Array<{ id: string; rel: string; weight: number; name: string }>>()
  const inn = new Map<string, Array<{ id: string; rel: string; weight: number; name: string }>>()
  const nameOf = (id: string) => cardsById.get(id)?.name || id
  let dropped = 0
  for (const x of (xrefs || [])) {
    const from = (x as any).from_card_id || (x as any).from
    const to = (x as any).to_card_id || (x as any).to
    if (!from || !to || from === to) continue                    // 字面自引用直接丢
    // 目标卡片没拉到（分页失败 / 悬空引用）→ 丢掉。
    // 否则 UI 会渲染出一个点了没反应的"幽灵 chip"（显示的是裸 id，用户以为功能坏了）。
    if (!cardsById.has(from) || !cardsById.has(to)) { dropped++; continue }
    const rel = x.rel || 'mention'
    const w = Number(x.weight || 1)
    if (!out.has(from)) out.set(from, [])
    if (!inn.has(to)) inn.set(to, [])
    out.get(from)!.push({ id: to, rel, weight: w, name: nameOf(to) })
    inn.get(to)!.push({ id: from, rel, weight: w, name: nameOf(from) })
  }
  return { out, in: inn, dropped }
}

/** 卡片级迷你关系图：卡片 + 一跳引用 */
export function cardNeighborhood(
  cardId: string,
  xref: XrefIndex,
  cardsById: Map<string, Card>,
  maxNodes = 26,
): SubGraph {
  const out = xref.out.get(cardId) || []
  const back = xref.in.get(cardId) || []
  const seen = new Map<string, { id: string; rel: string; dir: 'out' | 'in' }>()
  for (const x of out) if (x.id !== cardId && !seen.has(x.id)) seen.set(x.id, { id: x.id, rel: x.rel, dir: 'out' })
  for (const x of back) if (x.id !== cardId && !seen.has(x.id)) seen.set(x.id, { id: x.id, rel: x.rel, dir: 'in' })
  const picked = Array.from(seen.values()).slice(0, maxNodes).filter((p) => cardsById.has(p.id))

  const self = cardsById.get(cardId)
  const nodes: GNode[] = []
  if (self) {
    nodes.push({ id: self.id, name: self.name, name_zh: '', type: 'self', layer: '', degree: picked.length, unit_ids: [] })
  }
  for (const p of picked) {
    const c = cardsById.get(p.id)!
    nodes.push({ id: c.id, name: c.name, name_zh: '', type: p.rel, layer: '', degree: 1, unit_ids: [] })
  }
  const edges: GEdge[] = picked.map((p, i) => ({
    id: `x${i}`,
    src: p.dir === 'out' ? cardId : p.id,
    dst: p.dir === 'out' ? p.id : cardId,
    etype: p.rel,
    evidence: '',
    span: null,
    confidence: 0,
    flagged: false,
  }))
  return { nodes, edges, seed_count: nodes.length ? 1 : 0, seed_source: nodes.length ? 'focus' : 'none' }
}
