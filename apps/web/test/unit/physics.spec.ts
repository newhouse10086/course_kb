import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PHYSICS, buildQuad, physicsTick, radiusOf, repulse, seedPositions,
  worldFromScreen, zoomAt, type PEdge, type PNode,
} from '../../src/graph/physics'

const node = (id: string, x = 0, y = 0, degree = 1): PNode => ({ id, x, y, vx: 0, vy: 0, degree })

describe('physics / radiusOf（节点大小 ∝ degree，验收要求单调）', () => {
  it('随 degree 单调不减，且有上界', () => {
    const r = [0, 1, 2, 5, 12, 40, 500].map((d) => radiusOf(d))
    for (let i = 1; i < r.length; i++) expect(r[i]!).toBeGreaterThanOrEqual(r[i - 1]!)
    expect(radiusOf(0)).toBeCloseTo(3.2, 5)
    expect(radiusOf(1e6)).toBeLessThanOrEqual(3.2 + 11 + 1e-9)   // cap=11
  })
})

describe('physics / buildQuad + repulse', () => {
  it('四叉树统计节点质量，repulse 产生有限斥力', () => {
    const nodes = [node('a', -50, -50), node('b', 50, 50), node('c', 0, 0), node('d', 10, 10)]
    const q = buildQuad(nodes, -200, -200, 400)
    expect(q.mass).toBe(4)                                    // Quad 的字段是 mass（不是 count）
    const acc = { fx: 0, fy: 0 }
    repulse(q, node('z', 300, 300), 0.9, 1000, acc)
    expect(acc.fx !== 0 || acc.fy !== 0).toBe(true)
    expect(Number.isFinite(acc.fx) && Number.isFinite(acc.fy)).toBe(true)
  })

  it('完全重合的点不产生 NaN（退化输入必须有兜底）', () => {
    const q = buildQuad([node('a'), node('b'), node('c')], -100, -100, 200)
    const acc = { fx: 0, fy: 0 }
    repulse(q, node('d', 0, 0), 0.9, 500, acc)
    expect(Number.isFinite(acc.fx) && Number.isFinite(acc.fy)).toBe(true)
  })

  it('空树 / null 安全', () => {
    const acc = { fx: 0, fy: 0 }
    repulse(null, node('a'), 0.9, 500, acc)
    repulse(buildQuad([], 0, 0, 100), node('a'), 0.9, 500, acc)
    expect(acc.fx).toBe(0)
  })
})

describe('physics / seedPositions 确定性（布局可复现 → 测试与截图能对比）', () => {
  const mk = () => [node('a', 0, 0, 5), node('b', 0, 0, 3), node('c', 0, 0, 1), node('d', 0, 0, 1)]

  it('同一输入两次布局完全一致，且不产生 NaN', () => {
    const n1 = mk()
    const n2 = mk()
    seedPositions(n1, 900, 600, 'type')
    seedPositions(n2, 900, 600, 'type')
    expect(n1.map((n) => [Math.round(n.x), Math.round(n.y)]))
      .toEqual(n2.map((n) => [Math.round(n.x), Math.round(n.y)]))
    for (const n of n1) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true)
  })

  it('落到画布范围内', () => {
    const ns = mk()
    seedPositions(ns, 900, 600, 'type')
    for (const n of ns) {
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.x).toBeLessThanOrEqual(900)
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.y).toBeLessThanOrEqual(600)
    }
  })
})

describe('physics / physicsTick(nodes, edges, alpha, params?, size?)', () => {
  it('相连节点被弹簧拉近', () => {
    const nodes = [node('a', -200, 0), node('b', 200, 0)]
    const edges: PEdge[] = [{ src: 'a', dst: 'b', flagged: false }]
    const d0 = Math.abs(nodes[0]!.x - nodes[1]!.x)
    const first = physicsTick(nodes, edges, 1)
    for (let i = 0; i < 60; i++) physicsTick(nodes, edges, 0.6)
    const d1 = Math.abs(nodes[0]!.x - nodes[1]!.x)
    expect(first.alpha).toBeGreaterThan(0)
    expect(Number.isFinite(first.maxMoved)).toBe(true)
    expect(d1).toBeLessThan(d0)
    expect(Number.isFinite(nodes[0]!.x) && Number.isFinite(nodes[0]!.y)).toBe(true)
  })

  it('pinned 的节点纹丝不动（拖拽固定用 pinned，不是 fix）', () => {
    const nodes = [node('a', 10, 10), node('b', 300, 300)]
    nodes[0]!.pinned = true
    for (let i = 0; i < 10; i++) physicsTick(nodes, [{ src: 'a', dst: 'b' }], 1)
    expect(nodes[0]!.x).toBe(10)
    expect(nodes[0]!.y).toBe(10)
  })

  it('空图直接返回 0，不炸', () => {
    expect(physicsTick([], [], 1).maxMoved).toBe(0)
  })

  it('NaN 坐标会被拉回画布中心（防御脏数据）', () => {
    const nodes = [node('a', NaN, NaN), node('b', 100, 100)]
    physicsTick(nodes, [{ src: 'a', dst: 'b' }], 1, DEFAULT_PHYSICS, { w: 800, h: 600 })
    expect(Number.isFinite(nodes[0]!.x)).toBe(true)
    expect(Number.isFinite(nodes[0]!.y)).toBe(true)
  })
})

describe('physics / 视图变换', () => {
  it('worldFromScreen 与 zoomAt 互逆（以鼠标点为锚，滚轮缩放不漂移）', () => {
    const view = { x: 30, y: -12, k: 1.5 }
    const world = worldFromScreen(400, 250, view)
    const zoomed = zoomAt(view, 2.0, 400, 250)
    const worldAfter = worldFromScreen(400, 250, zoomed)
    expect(worldAfter.x).toBeCloseTo(world.x, 6)
    expect(worldAfter.y).toBeCloseTo(world.y, 6)
    expect(zoomed.k).toBeGreaterThan(view.k)
  })

  it('缩放被限制在 [min, max]', () => {
    let v = { x: 0, y: 0, k: 1 }
    for (let i = 0; i < 40; i++) v = zoomAt(v, 2, 0, 0)
    expect(v.k).toBeLessThanOrEqual(9)
    for (let i = 0; i < 80; i++) v = zoomAt(v, 0.5, 0, 0)
    expect(v.k).toBeGreaterThanOrEqual(0.12)
  })
})

