import { describe, expect, it } from 'vitest'
import { buildXrefIndex, cardNeighborhood, localSubgraph, normalizeGraph } from '../../src/graph/subgraph'
import type { GraphEdge, GraphNode } from '../../src/api/types'

const N = (id: string, name: string, type = 'concept', unit_ids: string[] = []): GraphNode =>
  ({ id, name, name_zh: '', type, layer: 'L1', degree: 1, unit_ids } as GraphNode)
const E = (id: string, src: string, dst: string, etype = 'DEPENDS_ON', flagged = false): GraphEdge =>
  ({ id, src, dst, etype, evidence: `e-${id}`, confidence: 0.9, flagged } as unknown as GraphEdge)

describe('subgraph / normalizeGraph（脏数据兜底）', () => {
  it('丢掉悬空边，补默认字段', () => {
    const g = normalizeGraph(
      [N('a', 'Index'), N('b', 'B+Tree'), N('c', 'InnoDB', 'product')],
      [E('e1', 'a', 'b'), E('e2', 'b', 'c'), E('e3', 'ghost', 'a')],
    )
    expect(g.nodes.length).toBe(3)
    expect(g.edges.length).toBe(2)                    // e3 的 ghost 不存在 → 丢掉
    expect(g.nodes[0]!.name_zh).toBe('')
    expect(g.edges[0]!.etype).toBe('DEPENDS_ON')
    expect(g.edges[0]!.flagged).toBe(false)
  })

  it('undefined 不炸', () => {
    expect(normalizeGraph(undefined, undefined)).toEqual({ nodes: [], edges: [] })
  })
})

describe('subgraph / localSubgraph 种子来源（内嵌图谱的关键）', () => {
  const g = normalizeGraph(
    [N('a', 'Index', 'concept', ['u1']), N('b', 'B+Tree', 'concept', ['u1']), N('c', 'InnoDB', 'product', ['u2']), N('e', 'Unrelated')],
    [E('e1', 'a', 'b'), E('e2', 'b', 'c')],
  )

  it('unit_ids 命中 → seed_source=unit_ids，含一跳邻居', () => {
    const s = localSubgraph(g, { unitIds: ['u1'] })
    expect(s.seed_source).toBe('unit_ids')
    expect(s.seed_count).toBe(2)                       // a、b 是该单元的实体
    const ids = s.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['a', 'b', 'c'])               // c 作为 b 的一跳邻居被带进来（这是设计）
  })

  it('没有 unit_ids 时**不瞎猜**：种子数为 0', () => {
    const s = localSubgraph(g, {})
    expect(s.seed_source).toBe('none')
    expect(s.nodes.length).toBe(0)
    expect(s.edges.length).toBe(0)
  })

  it('unit_ids 缺失 → 用 seedIds（前端按卡片名反查到的实体）兜底，seed_source=card_names', () => {
    const s = localSubgraph(g, { unitIds: [], seedIds: ['a', 'b'] })
    expect(s.seed_source).toBe('card_names')
    expect(s.seed_count).toBe(2)
    const ids = s.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['a', 'b', 'c'])
  })

  it('两者都有 → seed_source=unit_ids+card_names', () => {
    const s = localSubgraph(g, { unitIds: ['u1'], seedIds: ['c'] })
    expect(s.seed_source).toBe('unit_ids+card_names')
    expect(s.seed_count).toBe(3)
  })

  it('focus 单独给时 seed_source=focus；与单元种子共存时来源仍标注单元（focus 只加节点）', () => {
    const only = localSubgraph(g, { focusId: 'c' })
    expect(only.seed_source).toBe('focus')
    expect(only.seed_count).toBe(1)
    expect(only.nodes.map((n) => n.id)).toContain('c')

    const withUnits = localSubgraph(g, { unitIds: ['u1'], focusId: 'c' })
    expect(withUnits.seed_source).toBe('unit_ids')      // 来源标注要如实反映种子出处
    expect(withUnits.nodes.map((n) => n.id)).toContain('c')
  })

  it('子图里的边两端都在子图内（不留悬空边）', () => {
    const s = localSubgraph(g, { unitIds: ['u1'] })
    const ids = new Set(s.nodes.map((n) => n.id))
    for (const e of s.edges) {
      expect(ids.has(e.src)).toBe(true)
      expect(ids.has(e.dst)).toBe(true)
    }
  })

  it('maxNodes 生效（画布不炸）', () => {
    const many = normalizeGraph(
      Array.from({ length: 40 }, (_, i) => N(`n${i}`, `N${i}`, 'concept', ['u1'])),
      [],
    )
    const s = localSubgraph(many, { unitIds: ['u1'], maxNodes: 12 })
    expect(s.nodes.length).toBeLessThanOrEqual(12)
  })
})

describe('subgraph / buildXrefIndex + cardNeighborhood', () => {
  const cards = new Map<string, any>([
    ['c1', { id: 'c1', name: 'Index', kind: 'concept', unit_id: 'u1' }],
    ['c2', { id: 'c2', name: 'B+Tree', kind: 'concept', unit_id: 'u2' }],
    ['c3', { id: 'c3', name: 'Index', kind: 'concept', unit_id: 'u1' }],
  ])
  const xrefs = [
    { from_card_id: 'c1', to_card_id: 'c2', rel: 'mention', weight: 1 },
    { from_card_id: 'c2', to_card_id: 'c1', rel: 'also_in', weight: 1 },
    { from_card_id: 'c3', to_card_id: 'c1', rel: 'same_unit', weight: 1 },
    { from_card_id: 'c1', to_card_id: 'c1', rel: 'mention', weight: 1 },     // 自环必须丢
    { from_card_id: 'c1', to_card_id: 'ghost', rel: 'mention', weight: 1 },  // 悬空必须丢
  ]

  it('按出/入分组，丢掉自环与悬空引用（并如实计数）', () => {
    const idx = buildXrefIndex(xrefs as any, cards)
    expect(idx.out.get('c1')!.map((x) => x.id)).toEqual(['c2'])
    expect(idx.in.get('c1')!.map((x) => x.id).sort()).toEqual(['c2', 'c3'])
    expect(idx.out.get('c2')![0]!.rel).toBe('also_in')
    expect(idx.dropped).toBe(1)                       // 自环在更前面就被跳过，不计入 dropped
  })

  it('每条引用都带可显示的名字（不是裸 id）', () => {
    const idx = buildXrefIndex(xrefs as any, cards)
    expect(idx.out.get('c1')![0]!.name).toBe('B+Tree')
  })

  it('cardNeighborhood 取该卡片的一跳邻居（并过滤未知卡片）', () => {
    const idx = buildXrefIndex(xrefs as any, cards)
    const nb = cardNeighborhood('c1', idx, cards)
    expect(nb.nodes.map((n) => n.id).sort()).toEqual(['c1', 'c2', 'c3'])
    expect(nb.edges.length).toBeGreaterThan(0)
  })

  it('空 xrefs 安全', () => {
    const idx = buildXrefIndex(undefined, cards)
    expect(idx.out.size).toBe(0)
    expect(idx.dropped).toBe(0)
  })
})



