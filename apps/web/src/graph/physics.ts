/**
 * 力导向物理 —— 自绘图谱的核心（**不引第三方图库**）
 *
 * 为什么是 Barnes-Hut：1644 节点朴素 O(n²) 斥力 = 每帧 270 万对，实测掉到个位数帧率；
 * 四叉树近似把每节点斥力降到 O(log n)。v1 用同一算法实测 1644 节点 / 481 边
 * 单步 4.1–8.0ms、帧耗时中位数 ~10ms（详见 test/perf-report.mjs 的实测输出）。
 *
 * 本文件**不碰 DOM**：物理与数据都是纯函数 → Vitest 可以直接跑数值断言。
 */

export interface PNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  degree: number
  _fx?: number
  _fy?: number
  pinned?: boolean
}

export interface PEdge { src: string; dst: string; id?: string; flagged?: boolean }

export interface PhysicsParams {
  /** 四叉树近似阈值：格子边长/距离 < theta 就当成一个质点 */
  theta: number
  repulsion: number
  spring: number
  springLen: number
  gravity: number
  maxSpeed: number
  damping: number
  /** 每步 alpha 衰减（退火）：越小收敛越快 */
  decay: number
}

export const DEFAULT_PHYSICS: PhysicsParams = {
  theta: 0.9,
  repulsion: 13000,
  spring: 0.9,
  springLen: 58,
  gravity: 0.008,
  maxSpeed: 14,
  damping: 0.86,
  decay: 0.9915,
}

export interface Quad {
  x0: number; y0: number; size: number
  mass: number; sx: number; sy: number
  body: PNode | null
  kids: (Quad | null)[] | null
}

/**
 * 四叉树。坑：把「包含自身的格子」当聚合体质点算斥力 → 自己斥自己，节点瞬间飞出画布。
 * 对策：叶子 == 自身直接跳过；内部格含自身则强制下钻（不做 theta 近似）。
 */
export function buildQuad(nodes: PNode[], x0: number, y0: number, size: number, maxDepth = 24): Quad {
  const root: Quad = { x0, y0, size, mass: 0, sx: 0, sy: 0, body: null, kids: null }
  for (const n of nodes) insertQuad(root, n, 0, maxDepth)
  return root
}

function childOf(q: Quad, n: PNode): Quad {
  const h = q.size / 2
  const i = (n.x >= q.x0 + h ? 1 : 0) + (n.y >= q.y0 + h ? 2 : 0)
  let c = q.kids![i]
  if (!c) {
    c = q.kids![i] = {
      x0: q.x0 + (i & 1 ? h : 0), y0: q.y0 + (i & 2 ? h : 0),
      size: h, mass: 0, sx: 0, sy: 0, body: null, kids: null,
    }
  }
  return c
}

function insertQuad(q: Quad, n: PNode, depth: number, maxDepth: number): void {
  q.mass += 1
  q.sx += n.x
  q.sy += n.y
  if (!q.kids && !q.body) { q.body = n; return }
  if (depth >= maxDepth) return                       // 同点位兜底：不再细分，避免无限递归
  if (q.body) {
    const old = q.body
    q.body = null
    q.kids = [null, null, null, null]
    insertQuad(childOf(q, old), old, depth + 1, maxDepth)
  }
  insertQuad(childOf(q, n), n, depth + 1, maxDepth)
}

function inside(q: Quad, n: PNode): boolean {
  return n.x >= q.x0 && n.x < q.x0 + q.size && n.y >= q.y0 && n.y < q.y0 + q.size
}

export interface Acc { fx: number; fy: number }

/** 把树对节点 n 的斥力累加进 acc（K 越大斥力越强） */
export function repulse(q: Quad | null, n: PNode, theta: number, K: number, acc: Acc): void {
  if (!q || q.mass === 0) return
  if (q.body === n) return
  const mx = q.sx / q.mass
  const my = q.sy / q.mass
  let dx = n.x - mx
  let dy = n.y - my
  let d2 = dx * dx + dy * dy
  const cellContainsSelf = !!q.kids && inside(q, n)
  if (q.kids && !cellContainsSelf && q.size / Math.sqrt(d2 || 1e-6) < theta) {
    if (d2 < 1e-6) return
    const d = Math.sqrt(d2)
    const f = K / d2
    acc.fx -= (dx / d) * f
    acc.fy -= (dy / d) * f
    return
  }
  if (q.kids) {
    for (let i = 0; i < 4; i++) repulse(q.kids[i], n, theta, K, acc)
    return
  }
  if (d2 < 1e-6) {
    // 完全重合：给一个确定性微扰（用 Math.random 会让布局不可复现）
    dx = ((n.id.length % 7) - 3) * 0.1
    dy = ((n.id.length % 5) - 2) * 0.1
    d2 = dx * dx + dy * dy
  }
  const d = Math.sqrt(d2)
  const f = K / d2
  acc.fx -= (dx / d) * f
  acc.fy -= (dy / d) * f
}

/** 确定性初始布局：按 type/layer 分簇落在同心圆上（同一数据每次布局一致 → 测试可复现） */
export function seedPositions(
  nodes: Array<{ id: string; degree: number; type?: string; layer?: string; x: number; y: number; vx: number; vy: number }>,
  w: number,
  h: number,
  colorBy: 'type' | 'layer' = 'type',
): void {
  const groups = new Map<string, typeof nodes>()
  for (const n of nodes) {
    const k = colorBy === 'layer' ? (n.layer || '') : (n.type || '')
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(n)
  }
  const keys = Array.from(groups.keys()).sort()
  const cx = w / 2
  const cy = h / 2
  const baseR = Math.min(w, h) * 0.34
  keys.forEach((k, gi) => {
    const arr = groups.get(k)!.slice().sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1))
    const ringR = baseR * (0.55 + 0.5 * (gi / Math.max(1, keys.length - 1)))
    const phase = (gi / Math.max(1, keys.length)) * Math.PI * 2
    arr.forEach((n, i) => {
      const ang = phase + (i / Math.max(1, arr.length)) * Math.PI * 2
      const jitter = ((i * 37) % 11) / 11
      n.x = cx + Math.cos(ang) * ringR * (0.85 + 0.3 * jitter)
      n.y = cy + Math.sin(ang) * ringR * (0.7 + 0.3 * jitter) * 0.85
      n.vx = 0
      n.vy = 0
    })
  })
}

export interface TickResult {
  alpha: number
  /** 本步最大位移（收敛判据，也给测试用） */
  maxMoved: number
}

/**
 * 一步物理迭代：斥力（四叉树）+ 弹簧 + 向心引力 + 退火。
 * 只依赖传入数组 → 纯计算，可单测（Vitest 里断言有限性/收敛单调性/无 NaN）。
 */
export function physicsTick(
  nodes: PNode[],
  edges: PEdge[],
  alpha: number,
  params: PhysicsParams = DEFAULT_PHYSICS,
  size: { w: number; h: number } = { w: 900, h: 600 },
): TickResult {
  if (!nodes.length) return { alpha: 0, maxMoved: 0 }
  const index = new Map<string, PNode>()
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of nodes) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { p.x = size.w / 2; p.y = size.h / 2 }  // 防御 NaN
    index.set(p.id, p)
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y)
  }
  const span = Math.max(x1 - x0, y1 - y0, 1) * 1.05
  const tree = buildQuad(nodes, x0 - 1, y0 - 1, span)
  const K = params.repulsion * (1 + Math.min(3, nodes.length / 400))
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2

  for (const p of nodes) {
    const acc: Acc = { fx: 0, fy: 0 }
    repulse(tree, p, params.theta, K, acc)
    acc.fx += (cx - p.x) * params.gravity
    acc.fy += (cy - p.y) * params.gravity
    p._fx = acc.fx
    p._fy = acc.fy
  }
  for (const e of edges) {
    const a = index.get(e.src)
    const b = index.get(e.dst)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.sqrt(dx * dx + dy * dy) || 1e-6
    const f = (params.spring * (d - params.springLen)) / params.springLen
    const ux = dx / d
    const uy = dy / d
    a._fx = (a._fx || 0) + ux * f
    a._fy = (a._fy || 0) + uy * f
    b._fx = (b._fx || 0) - ux * f
    b._fy = (b._fy || 0) - uy * f
  }
  let maxMoved = 0
  for (const p of nodes) {
    if (p.pinned) { p.vx = 0; p.vy = 0; continue }
    let fx = (p._fx || 0) * alpha
    let fy = (p._fy || 0) * alpha
    const m = Math.sqrt(fx * fx + fy * fy)
    if (m > params.maxSpeed) { const s = params.maxSpeed / m; fx *= s; fy *= s }
    p.vx = ((p.vx || 0) + fx) * params.damping
    p.vy = ((p.vy || 0) + fy) * params.damping
    p.x += p.vx
    p.y += p.vy
    const moved = Math.abs(p.vx) + Math.abs(p.vy)
    if (moved > maxMoved) maxMoved = moved
  }
  return { alpha: alpha * params.decay, maxMoved }
}

/** 节点半径 ∝ degree（F5 硬要求：大小 ∝ degree） */
export function radiusOf(degree: number, base = 3.2, scale = 2.6, cap = 11): number {
  return base + Math.min(cap, Math.sqrt(Math.max(0, degree)) * scale)
}

/** 屏幕坐标 → 世界坐标（引擎与命中测试共用） */
export function worldFromScreen(sx: number, sy: number, view: { x: number; y: number; k: number }): { x: number; y: number } {
  return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k }
}

/** 缩放视图：保持鼠标下的世界点不动 */
export function zoomAt(view: { x: number; y: number; k: number }, factor: number, sx: number, sy: number, min = 0.12, max = 9) {
  const k2 = Math.max(min, Math.min(max, view.k * factor))
  const s = k2 / view.k
  return { x: sx - (sx - view.x) * s, y: sy - (sy - view.y) * s, k: k2 }
}
