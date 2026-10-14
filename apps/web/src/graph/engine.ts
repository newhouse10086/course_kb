/**
 * Canvas 图谱引擎（自绘，**零第三方图库**）
 *
 * 分层：
 *   physics.ts  → 纯计算（四叉树斥力 / 弹簧 / 退火），可单测
 *   engine.ts   → 本文件：视口变换、绘制、命中测试、交互、性能统计
 * 组件 GraphCanvas.vue / EmbeddedGraph.vue 只负责把数据喂进来 + 接收事件。
 */
import { currentTheme, palette, type Palette } from './palette'
import {
  DEFAULT_PHYSICS, physicsTick, radiusOf, seedPositions, worldFromScreen, zoomAt,
  type PEdge, type PNode, type PhysicsParams,
} from './physics'
import type { GEdge, GNode } from './subgraph'

export interface EngineNode extends PNode, GNode { r: number }
// ⚠️ 不继承 PEdge：两者对 `flagged` 的可选性不同，同时 extends 会报 TS2320
export interface EngineEdge extends GEdge { }

export interface EngineOptions {
  height?: number
  interactive?: boolean
  labels?: 'auto' | 'all' | 'none'
  colorBy?: 'type' | 'layer'
  maxTicks?: number
  ticksPerFrame?: number
  labelMinDegree?: number
  maxLabels?: number
  physics?: Partial<PhysicsParams>
  onNodeClick?: (n: EngineNode) => void
  onEdgeClick?: (e: EngineEdge) => void
  onBackground?: () => void
  onSettled?: (s: EngineStats) => void
}

export interface EngineStats {
  nodes: number
  edges: number
  visible_nodes: number
  visible_edges: number
  flagged_edges: number
  drawn_nodes: number
  ticks: number
  frames: number
  elapsed_ms: number
  fps: number
  frame_ms: number
  frame_ms_p50: number | null
  frame_ms_p95: number | null
  frame_ms_max: number | null
  frame_samples: number
  alpha: number
  settled: boolean
}

export class GraphEngine {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D | null
  opts: Required<Pick<EngineOptions, 'height' | 'interactive' | 'labels' | 'colorBy' | 'maxTicks' | 'ticksPerFrame' | 'labelMinDegree' | 'maxLabels'>> & EngineOptions
  physics: PhysicsParams
  nodes: EngineNode[] = []
  edges: EngineEdge[] = []
  visibleNodes: EngineNode[] = []
  visibleEdges: EngineEdge[] = []
  view = { x: 0, y: 0, k: 1 }
  alpha = 1
  ticks = 0
  frames = 0
  elapsedMs = 0
  lastFps = 0
  selected: string | null = null
  selectedEdge: string | null = null
  hover: EngineNode | null = null
  /** flagged 只看模式（只影响可见性，**不删数据**） */
  flaggedOnly = false
  etypeFilter: Set<string> | null = null
  layerFilter: Set<string> | null = null
  minDegree = 0

  private frameTimes: number[] = []
  private _frameMs = 0
  private raf = 0
  private running = false
  /** 主题调色板缓存（`<html data-theme>` 变了就换一套） */
  private _pal: { theme: 'light' | 'dark'; p: Palette } | null = null

  /** 画布配色：纸感 + 单一强调色（暗色换深墨底），**不写死深色底** */
  pal(): Palette {
    const theme = currentTheme()
    if (!this._pal || this._pal.theme !== theme) this._pal = { theme, p: palette(theme) }
    return this._pal.p
  }
  private startedAt = 0
  private idx = new Map<string, EngineNode>()
  private size = { w: 900, h: 520, dpr: 1 }
  private drag: null | { kind: 'node' | 'pan'; id?: string; ox: number; oy: number; vx?: number; vy?: number } = null
  private moved = 0
  private fpsMark = { t: 0, n: 0 }

  constructor(canvas: HTMLCanvasElement, options: EngineOptions = {}) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.opts = {
      height: 420, interactive: true, labels: 'auto', colorBy: 'type',
      maxTicks: 420, ticksPerFrame: 2, labelMinDegree: 3, maxLabels: 160,
      ...options,
    }
    this.physics = { ...DEFAULT_PHYSICS, ...(options.physics || {}) }
    this.bindEvents()
    this.resize()
  }

  /* ---------------- 数据 ---------------- */

  setData(nodes: GNode[], edges: GEdge[]): this {
    this.nodes = nodes.map((n) => ({
      ...n, x: 0, y: 0, vx: 0, vy: 0, vx_deg: undefined as never, r: radiusOf(n.degree),
    })) as EngineNode[]
    this.edges = edges as EngineEdge[]
    this.idx = new Map(this.nodes.map((n) => [n.id, n]))
    this.nodes.forEach((n) => { n.r = radiusOf(n.degree) })
    this.selected = null
    this.selectedEdge = null
    this.relayout()
    return this
  }

  setFilter(f: {
    etypes?: string[] | null; layers?: string[] | null; flaggedOnly?: boolean
    minDegree?: number; colorBy?: 'type' | 'layer'; labels?: 'auto' | 'all' | 'none'
  }): void {
    if ('etypes' in f) this.etypeFilter = f.etypes ? new Set(f.etypes) : null
    if ('layers' in f) this.layerFilter = f.layers ? new Set(f.layers) : null
    if ('flaggedOnly' in f) this.flaggedOnly = !!f.flaggedOnly
    if ('minDegree' in f) this.minDegree = Number(f.minDegree || 0)
    if ('colorBy' in f && f.colorBy) this.opts.colorBy = f.colorBy
    if ('labels' in f && f.labels) this.opts.labels = f.labels
    this.applyVisibility()
    this.draw()
  }

  applyVisibility(): number {
    this.visibleEdges = this.edges.filter((e) =>
      (!this.etypeFilter || this.etypeFilter.has(e.etype)) && (!this.flaggedOnly || e.flagged))
    const used = new Set<string>()
    for (const e of this.visibleEdges) { used.add(e.src); used.add(e.dst) }
    const explicit = !!this.etypeFilter || this.flaggedOnly
    this.visibleNodes = this.nodes.filter((n) => {
      if (this.minDegree && n.degree < this.minDegree) return false
      if (this.layerFilter && !this.layerFilter.has(n.layer)) return false
      if (explicit && !used.has(n.id)) return false
      return true
    })
    const vis = new Set(this.visibleNodes.map((n) => n.id))
    this.visibleEdges = this.visibleEdges.filter((e) => vis.has(e.src) && vis.has(e.dst))
    return this.visibleNodes.length
  }

  relayout(): this {
    const c = this.resize()
    seedPositions(this.nodes as any, c.w, c.h, this.opts.colorBy)
    this.alpha = 1
    this.ticks = 0
    this.frames = 0
    this.frameTimes = []
    this.elapsedMs = 0
    this.view = { x: 0, y: 0, k: 1 }
    this.applyVisibility()
    this.draw()
    return this
  }

  /* ---------------- 循环 ---------------- */

  start(): this {
    if (this.running) return this
    this.running = true
    this.startedAt = performance.now()
    this.fpsMark = { t: this.startedAt, n: 0 }
    const loop = () => {
      if (!this.running) return
      const t0 = performance.now()
      if (this.alpha > 0.02 && this.ticks < this.opts.maxTicks) {
        for (let i = 0; i < this.opts.ticksPerFrame; i++) {
          const r = physicsTick(this.visibleNodes, this.visibleEdges, this.alpha, this.physics, this.size)
          this.alpha = r.alpha
          this.ticks++
        }
      }
      this.draw()
      this.frames++
      const now = performance.now()
      this.elapsedMs = now - this.startedAt
      this._frameMs = now - t0
      this.frameTimes.push(this._frameMs)          // 丢前 5 帧（JIT/首帧不具代表性）
      if (this.frameTimes.length > 900) this.frameTimes.shift()
      this.fpsMark.n++
      if (now - this.fpsMark.t >= 500) {
        this.lastFps = (this.fpsMark.n * 1000) / (now - this.fpsMark.t)
        this.fpsMark = { t: now, n: 0 }
      }
      if (this.alpha <= 0.02 || this.ticks >= this.opts.maxTicks) {
        this.running = false
        this.draw()
        this.opts.onSettled?.(this.stats())
        return
      }
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
    return this
  }

  stop(): this {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    return this
  }

  get isRunning() { return this.running }

  /** 同步跑 n 次物理迭代并计时：无头环境 rAF 会被节流，这个数字才是可比的性能指标 */
  benchTicks(n = 10): { n: number; total_ms: number; per_tick_ms: number } {
    const t0 = performance.now()
    for (let i = 0; i < n; i++) physicsTick(this.visibleNodes, this.visibleEdges, 1, this.physics, this.size)
    const ms = performance.now() - t0
    return { n, total_ms: Math.round(ms * 100) / 100, per_tick_ms: Math.round((ms / n) * 1000) / 1000 }
  }

  /* ---------------- 绘制 ---------------- */

  draw(): void {
    const ctx = this.ctx
    if (!ctx) return
    const { w, h, dpr } = this.size
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const pal = this.pal()
    ctx.fillStyle = pal.bg
    ctx.fillRect(0, 0, w, h)
    ctx.save()
    ctx.translate(this.view.x, this.view.y)
    ctx.scale(this.view.k, this.view.k)

    const hover = this.hover
    const nbr = hover ? new Set(this.neighborsOf(hover.id)) : null
    const k = this.view.k

    for (const e of this.visibleEdges) {
      const a = this.idx.get(e.src)
      const b = this.idx.get(e.dst)
      if (!a || !b) continue
      const hot = !!hover && (e.src === hover.id || e.dst === hover.id)
      const sel = this.selectedEdge === e.id
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.strokeStyle = hot || sel ? pal.select : pal.edge[e.etype] || pal.ink
      ctx.lineWidth = (sel ? 2.6 : hot ? 2 : 1.2) / Math.max(0.6, Math.min(1.4, k))
      ctx.setLineDash(e.flagged ? [6, 4] : [])          // ★ flagged = 虚线（只标记不删除）
      ctx.globalAlpha = hover && !hot ? 0.28 : 0.78
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.setLineDash([])
    }
    for (const n of this.visibleNodes) {
      const dim = !!hover && n.id !== hover.id && !(nbr && nbr.has(n.id))
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
      ctx.fillStyle = (this.opts.colorBy === 'layer' ? pal.layer[n.layer] : pal.type[n.type]) || pal.ink
      ctx.globalAlpha = dim ? 0.35 : 1
      ctx.fill()
      ctx.lineWidth = (n.id === this.selected ? 2.5 : 1.2) / Math.max(0.5, Math.min(1.5, k))
      ctx.strokeStyle = n.id === this.selected ? pal.select : pal.nodeStroke
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    if (this.opts.labels !== 'none') {
      const all = this.opts.labels === 'all'
      const cand = this.visibleNodes
        .filter((n) => all || n.id === this.selected || (nbr && nbr.has(n.id))
          || n.degree >= this.opts.labelMinDegree || n.r >= 7)
        .sort((a, b) => b.degree - a.degree)
        .slice(0, this.opts.maxLabels)
      ctx.font = '11px "Segoe UI","Microsoft YaHei",sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      for (const n of cand) {
        const label = n.name_zh || n.name || n.id
        const txt = label.length > 20 ? `${label.slice(0, 19)}…` : label
        const tw = ctx.measureText(txt).width
        ctx.fillStyle = pal.labelBg
        ctx.fillRect(n.x - tw / 2 - 2, n.y + n.r + 2, tw + 4, 13)
        ctx.fillStyle = n.id === this.selected ? pal.select : pal.label
        ctx.fillText(txt, n.x, n.y + n.r + 3)
      }
    }
    ctx.restore()
  }

  neighborsOf(id: string): string[] {
    const out: string[] = []
    for (const e of this.edges) {
      if (e.src === id) out.push(e.dst)
      else if (e.dst === id) out.push(e.src)
    }
    return out
  }

  /* ---------------- 交互 ---------------- */

  private bindEvents(): void {
    if (!this.opts.interactive) return
    const cv = this.canvas
    cv.style.cursor = 'grab'
    cv.addEventListener('pointerdown', (ev) => {
      cv.setPointerCapture(ev.pointerId)
      const n = this.pick(ev.offsetX, ev.offsetY)
      this.moved = 0
      this.drag = n
        ? { kind: 'node', id: n.id, ox: ev.offsetX, oy: ev.offsetY }
        : { kind: 'pan', ox: ev.offsetX, oy: ev.offsetY, vx: this.view.x, vy: this.view.y }
      cv.style.cursor = 'grabbing'
    })
    cv.addEventListener('pointermove', (ev) => {
      if (this.drag) {
        const dx = ev.offsetX - this.drag.ox
        const dy = ev.offsetY - this.drag.oy
        this.moved += Math.abs(dx) + Math.abs(dy)
        if (this.drag.kind === 'pan') {
          this.view.x = (this.drag.vx || 0) + dx
          this.view.y = (this.drag.vy || 0) + dy
        } else {
          const p = this.idx.get(this.drag.id!)
          if (p) {
            p.x += dx / this.view.k
            p.y += dy / this.view.k
            p.vx = 0; p.vy = 0; p.pinned = true
          }
          this.drag.ox = ev.offsetX
          this.drag.oy = ev.offsetY
          this.moved = 99
        }
        this.draw()
        return
      }
      const n = this.pick(ev.offsetX, ev.offsetY)
      if ((n?.id || null) !== (this.hover?.id || null)) {
        this.hover = n
        cv.style.cursor = n ? 'pointer' : 'grab'
        this.draw()
      }
    })
    const end = (ev: PointerEvent) => {
      if (!this.drag) return
      const wasPan = this.drag.kind === 'pan'
      const moved = this.moved
      this.drag = null
      cv.style.cursor = 'grab'
      if (moved < 4) {
        const n = this.pick(ev.offsetX, ev.offsetY)
        if (n) {
          this.select(n.id)
          this.opts.onNodeClick?.(n)
        } else if (wasPan) {
          const e = this.pickEdge(ev.offsetX, ev.offsetY)
          if (e) { this.selectedEdge = e.id; this.draw(); this.opts.onEdgeClick?.(e) }
          else { this.selected = null; this.selectedEdge = null; this.draw(); this.opts.onBackground?.() }
        }
      }
    }
    cv.addEventListener('pointerup', end)
    cv.addEventListener('pointercancel', () => { this.drag = null })
    cv.addEventListener('wheel', (ev) => {
      ev.preventDefault()
      this.view = zoomAt(this.view, Math.pow(1.0015, -ev.deltaY), ev.offsetX, ev.offsetY)
      this.draw()
    }, { passive: false })
    cv.addEventListener('dblclick', () => this.zoomToFit())
  }

  pick(sx: number, sy: number): EngineNode | null {
    const { x: wx, y: wy } = worldFromScreen(sx, sy, this.view)
    let best: EngineNode | null = null
    let bd = Infinity
    for (const n of this.visibleNodes) {
      const r = n.r + 6 / this.view.k
      const dx = n.x - wx
      const dy = n.y - wy
      const d2 = dx * dx + dy * dy
      if (d2 <= r * r && d2 < bd) { bd = d2; best = n }
    }
    return best
  }

  pickEdge(sx: number, sy: number): EngineEdge | null {
    const { x: wx, y: wy } = worldFromScreen(sx, sy, this.view)
    let best: EngineEdge | null = null
    let bd = 8 / this.view.k
    for (const e of this.visibleEdges) {
      const a = this.idx.get(e.src)
      const b = this.idx.get(e.dst)
      if (!a || !b) continue
      const vx = b.x - a.x
      const vy = b.y - a.y
      const len2 = vx * vx + vy * vy || 1e-6
      const t = Math.max(0, Math.min(1, ((wx - a.x) * vx + (wy - a.y) * vy) / len2))
      const d = Math.hypot(wx - (a.x + t * vx), wy - (a.y + t * vy))
      if (d < bd) { bd = d; best = e }
    }
    return best
  }

  select(id: string | null): void {
    this.selected = id
    this.selectedEdge = null
    this.draw()
  }

  selectEdge(id: string | null): void {
    this.selectedEdge = id
    this.draw()
  }

  byId(id: string): EngineNode | undefined { return this.idx.get(id) }

  zoomToFit(padding = 24): this {
    const ns = this.visibleNodes
    const { w, h } = this.size
    if (!ns.length) { this.view = { x: 0, y: 0, k: 1 }; this.draw(); return this }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const n of ns) {
      const r = n.r + 14
      x0 = Math.min(x0, n.x - r); y0 = Math.min(y0, n.y - r)
      x1 = Math.max(x1, n.x + r); y1 = Math.max(y1, n.y + r)
    }
    const k = Math.max(0.12, Math.min(3, Math.min((w - padding * 2) / (x1 - x0 || 1), (h - padding * 2) / (y1 - y0 || 1))))
    this.view = {
      k,
      x: w / 2 - ((x0 + x1) / 2) * k,
      y: h / 2 - ((y0 + y1) / 2) * k,
    }
    this.draw()
    return this
  }

  /** 把某节点挪到视口中心（点搜索结果的"定位"用） */
  centerOn(id: string): this {
    const n = this.idx.get(id)
    if (!n) return this
    this.view.x = this.size.w / 2 - n.x * this.view.k
    this.view.y = this.size.h / 2 - n.y * this.view.k
    this.draw()
    return this
  }

  resize(): { w: number; h: number; dpr: number } {
    const parent = this.canvas.parentElement
    const cssW = Math.max(320, parent?.clientWidth || 900)
    const cssH = Math.max(this.opts.height, parent?.clientHeight || this.opts.height)
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
    this.canvas.style.width = `${cssW}px`
    this.canvas.style.height = `${cssH}px`
    this.canvas.width = Math.round(cssW * dpr)
    this.canvas.height = Math.round(cssH * dpr)
    this.size = { w: cssW, h: cssH, dpr }
    return this.size
  }

  stats(): EngineStats {
    const ft = this.frameTimes.slice(5).sort((a, b) => a - b)
    const pct = (p: number) => (ft.length ? Math.round(ft[Math.min(ft.length - 1, Math.floor(ft.length * p))] * 100) / 100 : null)
    return {
      nodes: this.nodes.length,
      edges: this.edges.length,
      visible_nodes: this.visibleNodes.length,
      visible_edges: this.visibleEdges.length,
      flagged_edges: this.edges.filter((e) => e.flagged).length,
      drawn_nodes: this.visibleNodes.length,
      ticks: this.ticks,
      frames: this.frames,
      elapsed_ms: Math.round(this.elapsedMs),
      fps: Math.round(this.lastFps * 10) / 10,
      frame_ms: Math.round(this._frameMs * 10) / 10,
      frame_ms_p50: pct(0.5),
      frame_ms_p95: pct(0.95),
      frame_ms_max: ft.length ? Math.round(ft[ft.length - 1] * 100) / 100 : null,
      frame_samples: ft.length,
      alpha: Math.round(this.alpha * 1000) / 1000,
      settled: this.alpha <= 0.02 || this.ticks >= this.opts.maxTicks,
    }
  }

  destroy(): void {
    this.stop()
    const clone = this.canvas.cloneNode(true)
    this.canvas.replaceWith(clone)      // 摘掉所有监听
  }

  /** 主题切换后重绘（`pal()` 按 `<html data-theme>` 取色） */
  repaint(): void {
    this.draw()
  }
}




