/* ==========================================================================
   graph-core.js —— 自绘力导向图（**不引入任何第三方图库**）
   --------------------------------------------------------------------------
   技术选择（FUNCTIONAL_SPEC F5）：
     · 弹簧-电荷模型 + Barnes-Hut 四叉树近似（O(n log n)，1644 节点可跑）
       —— 朴素 O(n²) 斥力在 1644 节点下每帧 270 万对，实测掉到个位数帧率。
     · 渲染走 Canvas 2D（SVG 在 >1000 节点 + 文本标签时明显卡）
     · flagged 边画虚线（只标记不删除，见契约 §2.4）
     · 节点半径 ∝ degree
   参考实现：数据库课程智能体调研/product/prototype/refman_graph.html（自绘 SVG 版），
   本文件改为 Canvas + 真实力导向（参考页用的是确定性圆环布局）。
   ========================================================================== */

import { esc, fitCanvas } from './util.js';

/* ---------------- 封闭枚举配色（schema/edge_types.json 的 12 种边） ---------------- */
export const ETYPE_COLORS = {
  DEPENDS_ON: '#9aa4b2',
  PART_OF: '#6c7a8c',
  REALIZES: '#7c4dbe',
  IMPLEMENTS: '#1f9d6b',
  CONTRASTS_WITH: '#d97a1f',
  INSTANCE_OF: '#d9534f',
  SCHEMA_PATTERN: '#2f5fd0',
  USED_IN_ROLE: '#12a2a8',
  GOVERNED_BY: '#b47d13',
  HISTORICAL_ORIGIN: '#a855b8',
  COMMON_MISCONCEPTION: '#e0565b',
  ASSESSED_BY: '#5b6b7c',
};
export const ETYPE_ZH = {
  DEPENDS_ON: '前置依赖', PART_OF: '组成归属', REALIZES: '实现原理', IMPLEMENTS: '具体实现',
  CONTRASTS_WITH: '对比辨析', INSTANCE_OF: '业务实例', SCHEMA_PATTERN: '表设计模式',
  USED_IN_ROLE: '岗位用途', GOVERNED_BY: '合规约束', HISTORICAL_ORIGIN: '历史来由',
  COMMON_MISCONCEPTION: '常见误解', ASSESSED_BY: '考核方式',
};
export const TYPE_COLORS = {
  concept: '#2f5fd0', mechanism: '#12a2a8', product: '#1f9d6b', feature: '#4f9d3a',
  business: '#d97a1f', table: '#b47d13', role: '#7c4dbe', regulation: '#a855b8',
  problem: '#d9534f', misconception: '#e0565b', assessment: '#5b6b7c', station: '#8b929c',
};
export const TYPE_ZH = {
  concept: '概念', mechanism: '机制', product: '产品', feature: '特性', business: '业务场景',
  table: '表设计', role: '岗位', regulation: '法规', problem: '问题', misconception: '常见误解',
  assessment: '考核', station: '生命周期站点',
};
export const LAYER_COLORS = { L0: '#7c4dbe', L1: '#2f5fd0', L2: '#1f9d6b', L3: '#d97a1f', '': '#8b929c' };
export const LAYER_ZH = { L0: 'L0 思想层', L1: 'L1 机制层', L2: 'L2 实现层', L3: 'L3 领域层', '': '未分层' };

/** 颜色查找必须有兜底 —— 缺键会导致 undefined 打进 style，整块渲染失效（上游踩过）。 */
export function colorOf(map, key, fallback) { return map[key] || fallback || '#8b929c'; }
export const etypeColor = (e) => colorOf(ETYPE_COLORS, e);
export const typeColor = (t) => colorOf(TYPE_COLORS, t);
export const layerColor = (l) => colorOf(LAYER_COLORS, l);
export const etypeZh = (e) => ETYPE_ZH[e] || e;
export const typeZh = (t) => TYPE_ZH[t] || t;

/* ---------------- 数据归一化 ---------------- */

/** 投票决定节点分层（图谱接口的 node.layer 可能缺省，用 type 推） */
function inferLayer(n) {
  if (n.layer) return n.layer;
  const t = String(n.type || '');
  if (t === 'product' || t === 'feature' || t === 'table') return 'L2';
  if (t === 'business' || t === 'role') return 'L3';
  if (t === 'concept' || t === 'mechanism' || t === 'problem' || t === 'misconception' || t === 'station') return 'L1';
  if (t === 'regulation') return 'L0';
  return '';
}

/**
 * 契约 §5.2 的 /graph 响应 → 引擎内部数据。
 * nodes: [{id,name,name_zh,type,layer,degree,unit_ids}]
 * edges: [{id,src,dst,etype,evidence,span,confidence,flagged}]
 * 注意边引用的是 **src/dst**（契约如此），早期实现里写成 from/to 会整图无边。
 */
export function normalizeGraph(nodes, edges) {
  const ns = (nodes || []).map((n) => ({
    id: String(n.id),
    name: n.name || String(n.id),
    name_zh: n.name_zh || '',
    type: n.type || '',
    layer: inferLayer(n),
    degree: Number(n.degree || 0),
    unit_ids: n.unit_ids || n.units || [],
    raw: n,
  }));
  const ids = new Set(ns.map((n) => n.id));
  const deg = new Map();
  const es = [];
  for (const e of (edges || [])) {
    const src = String(e.src != null ? e.src : e.from);
    const dst = String(e.dst != null ? e.dst : e.to);
    if (!ids.has(src) || !ids.has(dst) || src === dst) continue;   // 悬空边不画（也不删数据）
    deg.set(src, (deg.get(src) || 0) + 1);
    deg.set(dst, (deg.get(dst) || 0) + 1);
    es.push({
      id: String(e.id != null ? e.id : `${src}->${dst}:${e.etype}`),
      src, dst,
      etype: e.etype || '',
      evidence: e.evidence || e.evidence_text || '',
      span: e.span || (e.span_kind ? { kind: e.span_kind, start: e.span_start, end: e.span_end } : null),
      confidence: Number(e.confidence || 0),
      flagged: e.flagged === true || e.flagged === 1,
      raw: e,
    });
  }
  for (const n of ns) if (!n.degree) n.degree = deg.get(n.id) || 0;
  return { nodes: ns, edges: es };
}

/* ---------------- Barnes-Hut 四叉树 ---------------- */
/* 说明：quad 节点同时承担「聚合体」与「格子」两种角色。
   坑：把包含自身的格子当成聚合体算斥力 → 自己斥自己，节点瞬间飞出画布；
   对策：叶子 == 自身直接跳过，内部格含自身则强制下钻（不做 theta 近似）。 */
function buildQuad(nodes, x0, y0, size) {
  const root = { x0, y0, size, mass: 0, sx: 0, sy: 0, body: null, kids: null };
  const maxDepth = 24;
  for (const n of nodes) insertQuad(root, n, 0, maxDepth);
  return root;
}
function insertQuad(q, n, depth, maxDepth) {
  q.mass += 1;
  q.sx += n.x; q.sy += n.y;
  if (!q.kids && !q.body) { q.body = n; return; }
  if (depth >= maxDepth) return;                    // 同点位兜底：不再细分，避免无限递归
  if (q.body) {                                     // 叶子已有 body → 细分并下推
    const old = q.body;
    q.body = null;
    q.kids = [null, null, null, null];
    insertQuad(childOf(q, old), old, depth + 1, maxDepth);
  }
  insertQuad(childOf(q, n), n, depth + 1, maxDepth);
}
function childOf(q, n) {
  const h = q.size / 2;
  const i = (n.x >= q.x0 + h ? 1 : 0) + (n.y >= q.y0 + h ? 2 : 0);
  let c = q.kids[i];
  if (!c) {
    c = q.kids[i] = {
      x0: q.x0 + (i & 1 ? h : 0), y0: q.y0 + (i & 2 ? h : 0),
      size: h, mass: 0, sx: 0, sy: 0, body: null, kids: null,
    };
  }
  return c;
}
function inside(q, n) {
  return n.x >= q.x0 && n.x < q.x0 + q.size && n.y >= q.y0 && n.y < q.y0 + q.size;
}
function repulse(q, n, theta, K, acc) {
  if (!q || q.mass === 0) return;
  if (q.body === n) return;
  const mx = q.sx / q.mass, my = q.sy / q.mass;
  let dx = n.x - mx, dy = n.y - my;
  let d2 = dx * dx + dy * dy;
  const cellContainsSelf = q.kids && inside(q, n);
  if (q.kids && !cellContainsSelf && (q.size / Math.sqrt(d2 || 1e-6)) < theta) {
    if (d2 < 1e-6) return;
    const d = Math.sqrt(d2);
    const f = K / d2;
    acc.fx -= (dx / d) * f; acc.fy -= (dy / d) * f;
    return;
  }
  if (q.kids) {
    for (let i = 0; i < 4; i++) repulse(q.kids[i], n, theta, K, acc);
    return;
  }
  if (d2 < 1e-6) { dx = (Math.random() - 0.5) * 0.5; dy = (Math.random() - 0.5) * 0.5; d2 = dx * dx + dy * dy; }
  const d = Math.sqrt(d2);
  const f = K / d2;
  acc.fx -= (dx / d) * f; acc.fy -= (dy / d) * f;
}

/* ---------------- 确定性初始布局 ----------------
   按 layer/type 分簇落在同心圆上：比纯随机收敛快，且同一份数据每次布局一致
   （测试里可重复）。 */
function seedPositions(ns, w, h, colorBy) {
  const groups = new Map();
  for (const n of ns) {
    const k = colorBy === 'layer' ? (n.layer || '') : (n.type || '');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }
  const keys = Array.from(groups.keys()).sort();
  const cx = w / 2, cy = h / 2;
  const baseR = Math.min(w, h) * 0.34;
  keys.forEach((k, gi) => {
    const arr = groups.get(k).sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1));
    const ringR = baseR * (0.55 + 0.5 * (gi / Math.max(1, keys.length - 1)));
    const phase = (gi / Math.max(1, keys.length)) * Math.PI * 2;
    arr.forEach((n, i) => {
      const ang = phase + (i / Math.max(1, arr.length)) * Math.PI * 2;
      const jitter = ((i * 37) % 11) / 11;   // 确定性抖动，避免完美圆
      n.x = cx + Math.cos(ang) * ringR * (0.85 + 0.3 * jitter);
      n.y = cy + Math.sin(ang) * ringR * (0.7 + 0.3 * jitter) * 0.85;
      n.vx = 0; n.vy = 0;
    });
  });
}

/* ---------------- 引擎 ---------------- */
export class ForceGraph {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts {height, interactive, labels:'auto'|'all'|'none', colorBy:'type'|'layer',
   *                       onNodeClick(node), onEdgeClick(edge), onBackground(), maxTicks, ticksPerFrame}
   */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = Object.assign({
      height: 420, interactive: true, labels: 'auto', colorBy: 'type',
      maxTicks: 420, ticksPerFrame: 2, theta: 0.9, repulsion: 13000,
      spring: 0.9, springLen: 58, gravity: 0.008, maxSpeed: 14, damping: 0.86,
      labelMinDegree: 3, maxLabels: 160, onNodeClick: null, onEdgeClick: null, onBackground: null,
    }, opts || {});
    this.nodes = [];
    this.edges = [];
    this.adj = new Map();
    this.view = { x: 0, y: 0, k: 1 };
    this.alpha = 1;
    this.ticks = 0;
    this.frames = 0;
    this.frameTimes = [];
    this.startedAt = 0;
    this.elapsedMs = 0;
    this.lastFps = 0;
    this._fpsMark = { t: 0, n: 0 };
    this._raf = 0;
    this._running = false;
    this.selected = null;
    this.hover = null;
    this.flaggedOnly = false;
    this.minDegree = 0;
    this.etypeFilter = null;        // null = 全开；否则 Set
    this.visibleNodes = [];
    this.visibleEdges = [];
    this._bindEvents();
    this.resize();
  }

  /** 契约数据 → 引擎。nodes/edges 均为 /graph 原样对象（内部做 normalize）。 */
  setData(nodes, edges) {
    const g = normalizeGraph(nodes, edges);
    this.nodes = g.nodes;
    this.edges = g.edges;
    // 索引必须在这里建好：tick() 每帧都要按 id 取端点，
    // 早期写成"用到时再懒建"，物理循环第一帧就撞上 undefined。
    this._idx = new Map(this.nodes.map((n) => [n.id, n]));
    this.adj = new Map();
    for (const n of this.nodes) this.adj.set(n.id, []);
    for (const e of this.edges) {
      if (this.adj.has(e.src)) this.adj.get(e.src).push(e);
      if (this.adj.has(e.dst)) this.adj.get(e.dst).push(e);
    }
    this.selected = null;
    this.relayout();
    return this;
  }

  radiusOf(n) { return 3.2 + Math.min(11, Math.sqrt(Math.max(0, n.degree)) * 2.6); }
  colorOfNode(n) { return this.opts.colorBy === 'layer' ? layerColor(n.layer) : typeColor(n.type); }
  labelOf(n) { return n.name_zh || n.name || n.id; }

  setFilter(f) {
    const o = f || {};
    if ('etypes' in o) this.etypeFilter = o.etypes ? new Set(o.etypes) : null;
    if ('layers' in o) this.layerFilter = o.layers ? new Set(o.layers) : null;
    if ('flaggedOnly' in o) this.flaggedOnly = !!o.flaggedOnly;
    if ('minDegree' in o) this.minDegree = Number(o.minDegree || 0);
    if ('colorBy' in o) this.opts.colorBy = o.colorBy;
    if ('labels' in o) this.opts.labels = o.labels;
    this.applyVisibility();
    this.draw();
  }

  applyVisibility() {
    const eOk = (e) => (!this.etypeFilter || this.etypeFilter.has(e.etype)) && (!this.flaggedOnly || e.flagged);
    this.visibleEdges = this.edges.filter(eOk);
    const used = new Set();
    for (const e of this.visibleEdges) { used.add(e.src); used.add(e.dst); }
    const explicitFilter = this.etypeFilter || this.flaggedOnly;
    this.visibleNodes = this.nodes.filter((n) => {
      if (this.minDegree && n.degree < this.minDegree) return false;
      if (this.layerFilter && !this.layerFilter.has(n.layer)) return false;
      if (explicitFilter && !used.has(n.id)) return false;
      return true;
    });
    this._visibleIds = new Set(this.visibleNodes.map((n) => n.id));
    // 边也要按节点可见性收敛，否则统计数字与画面对不上
    this.visibleEdges = this.visibleEdges.filter((e) => this._visibleIds.has(e.src) && this._visibleIds.has(e.dst));
    return this.visibleNodes.length;
  }

  relayout() {
    const c = fitCanvas(this.canvas, this.opts.height);
    this._size = c;
    seedPositions(this.nodes, c.w, c.h, this.opts.colorBy);
    this.alpha = 1;
    this.ticks = 0;
    this.frames = 0;
    this.frameTimes = [];
    this.elapsedMs = 0;
    this.view = { x: 0, y: 0, k: 1 };
    this.applyVisibility();
    return this;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.startedAt = performance.now();
    this._fpsMark = { t: this.startedAt, n: 0 };
    const loop = () => {
      if (!this._running) return;
      const t0 = performance.now();
      if (this.alpha > 0.02 && this.ticks < this.opts.maxTicks) {
        for (let i = 0; i < this.opts.ticksPerFrame; i++) this.tick();
      }
      this.draw();
      this.frames++;
      const now = performance.now();
      this.elapsedMs = now - this.startedAt;
      this._fpsMark.n++;
      if (now - this._fpsMark.t >= 500) {
        this.lastFps = (this._fpsMark.n * 1000) / (now - this._fpsMark.t);
        this._fpsMark = { t: now, n: 0 };
      }
      this._frameMs = now - t0;
      // 记录每帧耗时（丢掉前 5 帧：JIT/首帧布局不具代表性），供真实性能断言用
      this.frameTimes.push(this._frameMs);
      if (this.frameTimes.length > 900) this.frameTimes.shift();
      if (this.alpha <= 0.02 || this.ticks >= this.opts.maxTicks) {
        this._running = false;
        this.draw();
        if (typeof this.opts.onSettled === 'function') this.opts.onSettled(this.stats());
        return;
      }
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
    return this;
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    return this;
  }

  /** 一步物理迭代（Barnes-Hut 斥力 + 弹簧 + 向心引力 + 退火）。 */
  tick() {
    const ns = this.visibleNodes;
    const n = ns.length;
    if (n === 0) { this.alpha = 0; return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of ns) {
      if (!isFinite(p.x) || !isFinite(p.y)) { p.x = (this._size.w || 600) / 2; p.y = (this._size.h || 400) / 2; }
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const size = Math.max(x1 - x0, y1 - y0, 1) * 1.05;
    const tree = buildQuad(ns, x0 - 1, y0 - 1, size);
    const K = this.opts.repulsion * (1 + Math.min(3, n / 400));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    for (const p of ns) {
      const acc = { fx: 0, fy: 0 };
      repulse(tree, p, this.opts.theta, K, acc);
      // 向心引力：防止孤立子图被斥力推到画布外
      acc.fx += (cx - p.x) * this.opts.gravity;
      acc.fy += (cy - p.y) * this.opts.gravity;
      p._fx = acc.fx; p._fy = acc.fy;
    }
    // 弹簧（只在可见边两端且两点都可见时）
    const L = this.opts.springLen;
    for (const e of this.visibleEdges) {
      const a = this._idx.get(e.src), b = this._idx.get(e.dst);
      if (!a || !b || !this._visibleIds.has(a.id) || !this._visibleIds.has(b.id)) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      let d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const f = this.opts.spring * (d - L) / L;
      const ux = dx / d, uy = dy / d;
      a._fx += ux * f; a._fy += uy * f;
      b._fx -= ux * f; b._fy -= uy * f;
    }
    const damp = this.opts.damping;
    for (const p of ns) {
      let fx = (p._fx || 0) * this.alpha, fy = (p._fy || 0) * this.alpha;
      const m = Math.sqrt(fx * fx + fy * fy);
      if (m > this.opts.maxSpeed) { const s = this.opts.maxSpeed / m; fx *= s; fy *= s; }
      p.vx = ((p.vx || 0) + fx) * damp;
      p.vy = ((p.vy || 0) + fy) * damp;
      p.x += p.vx; p.y += p.vy;
    }
    this.alpha *= 0.9915;
    this.ticks++;
    void n;
  }

  /* ---------- 绘制 ---------- */
  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = this._size ? this._size.w : 600, h = this._size ? this._size.h : 420;
    ctx.save();
    ctx.setTransform(this._size ? this._size.dpr : 1, 0, 0, this._size ? this._size.dpr : 1, 0, 0);
    ctx.fillStyle = '#11151d';
    ctx.fillRect(0, 0, w, h);
    ctx.translate(this.view.x, this.view.y);
    ctx.scale(this.view.k, this.view.k);

    const hover = this.hover;
    const nbr = hover ? new Set(this.neighborsOf(hover.id)) : null;
    const k = this.view.k;

    // 边
    for (const e of this.visibleEdges) {
      const a = this._idx.get(e.src), b = this._idx.get(e.dst);
      if (!a || !b || !this._visibleIds.has(a.id) || !this._visibleIds.has(b.id)) continue;
      const hot = hover && (e.src === hover.id || e.dst === hover.id);
      const sel = this.selectedEdge === e.id;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = hot || sel ? '#ffffff' : etypeColor(e.etype);
      ctx.lineWidth = (sel ? 2.6 : hot ? 2 : 1.2) / Math.max(0.6, Math.min(1.4, k));
      // flagged = 因果可疑 → 虚线（视觉可辨，且不删除）
      ctx.setLineDash(e.flagged ? [6, 4] : []);
      ctx.globalAlpha = hover && !hot ? 0.28 : 0.78;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    }
    // 节点
    for (const n of this.visibleNodes) {
      const r = this.radiusOf(n);
      const dim = hover && n.id !== hover.id && !(nbr && nbr.has(n.id));
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = this.colorOfNode(n);
      ctx.globalAlpha = dim ? 0.35 : 1;
      ctx.fill();
      ctx.lineWidth = 1.2 / Math.max(0.5, Math.min(1.5, k));
      ctx.strokeStyle = n.id === this.selected ? '#ffd980' : '#0f1218';
      if (n.id === this.selected) ctx.lineWidth = 2.5 / Math.max(0.5, Math.min(1.5, k));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // 标签（canvas 文本很贵 → 只画重要的，且限制总量）
    const showAll = this.opts.labels === 'all';
    if (this.opts.labels !== 'none') {
      const cand = this.visibleNodes
        .filter((n) => showAll || n.id === this.selected ||
          (nbr && nbr.has(n.id)) || n.degree >= this.opts.labelMinDegree || this.radiusOf(n) >= 7)
        .sort((a, b) => b.degree - a.degree)
        .slice(0, this.opts.maxLabels);
      ctx.font = '11px "Segoe UI","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const n of cand) {
        const t = this.labelOf(n);
        const txt = t.length > 20 ? t.slice(0, 19) + '…' : t;
        const r = this.radiusOf(n);
        ctx.fillStyle = 'rgba(17,21,29,.72)';
        const tw = ctx.measureText(txt).width;
        ctx.fillRect(n.x - tw / 2 - 2, n.y + r + 2, tw + 4, 13);
        ctx.fillStyle = n.id === this.selected ? '#ffd980' : '#d7dee8';
        ctx.fillText(txt, n.x, n.y + r + 3);
      }
    }
    ctx.restore();
  }

  neighborsOf(id) {
    const out = [];
    for (const e of this.edges) {
      if (e.src === id) out.push(e.dst);
      else if (e.dst === id) out.push(e.src);
    }
    return out;
  }

  /* ---------- 交互 ---------- */
  _bindEvents() {
    if (!this.opts.interactive || !this.canvas) return;
    const cv = this.canvas;
    this._drag = null;
    this._moved = 0;
    cv.style.cursor = 'grab';
    cv.addEventListener('pointerdown', (ev) => {
      cv.setPointerCapture(ev.pointerId);
      const n = this.pick(ev.offsetX, ev.offsetY);
      this._moved = 0;
      this._drag = n
        ? { kind: 'node', id: n.id, ox: ev.offsetX, oy: ev.offsetY }
        : { kind: 'pan', ox: ev.offsetX, oy: ev.offsetY, vx: this.view.x, vy: this.view.y };
      cv.style.cursor = n ? 'grabbing' : 'grabbing';
    });
    cv.addEventListener('pointermove', (ev) => {
      if (this._drag) {
        const dx = ev.offsetX - this._drag.ox, dy = ev.offsetY - this._drag.oy;
        this._moved += Math.abs(dx) + Math.abs(dy);
        if (this._drag.kind === 'pan') {
          this.view.x = this._drag.vx + dx;
          this.view.y = this._drag.vy + dy;
        } else {
          const p = this.byId(this._drag.id);
          if (p) {
            p.x += dx / this.view.k; p.y += dy / this.view.k;
            p.vx = 0; p.vy = 0; p.pinned = true;   // 拖过即固定（力导向图常规行为）
          }
          this._drag.ox = ev.offsetX; this._drag.oy = ev.offsetY; this._moved = 99;
        }
        this.draw();
        return;
      }
      const n = this.pick(ev.offsetX, ev.offsetY);
      const id = n ? n.id : null;
      if (id !== (this.hover && this.hover.id)) {
        this.hover = n;
        cv.style.cursor = n ? 'pointer' : 'grab';
        this.draw();
      }
    });
    const endDrag = (ev) => {
      if (!this._drag) return;
      const wasPan = this._drag.kind === 'pan';
      const moved = this._moved;
      this._drag = null;
      cv.style.cursor = 'grab';
      if (moved < 4) {
        const n = this.pick(ev.offsetX, ev.offsetY);
        if (n) {
          this.select(n.id);
          if (this.opts.onNodeClick) this.opts.onNodeClick(n);
        } else if (wasPan) {
          const e = this.pickEdge(ev.offsetX, ev.offsetY);
          if (e) {
            this.selectedEdge = e.id;
            this.draw();
            if (this.opts.onEdgeClick) this.opts.onEdgeClick(e);
          } else {
            this.selected = null;
            this.selectedEdge = null;
            this.draw();
            if (this.opts.onBackground) this.opts.onBackground();
          }
        }
      }
    };
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', () => { this._drag = null; });
    cv.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const f = Math.pow(1.0015, -ev.deltaY);
      const k2 = Math.max(0.12, Math.min(9, this.view.k * f));
      const s = k2 / this.view.k;
      this.view.x = ev.offsetX - (ev.offsetX - this.view.x) * s;
      this.view.y = ev.offsetY - (ev.offsetY - this.view.y) * s;
      this.view.k = k2;
      this.draw();
    }, { passive: false });
    cv.addEventListener('dblclick', () => this.zoomToFit());
  }

  byId(id) { return this._idx ? this._idx.get(id) : undefined; }

  /** 屏幕坐标 → 节点（可见节点里取最近且在半径内）。 */
  pick(sx, sy) {
    const wx = (sx - this.view.x) / this.view.k;
    const wy = (sy - this.view.y) / this.view.k;
    let best = null, bd = Infinity;
    for (const n of this.visibleNodes) {
      const r = this.radiusOf(n) + 6 / this.view.k;
      const dx = n.x - wx, dy = n.y - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r && d2 < bd) { bd = d2; best = n; }
    }
    return best;
  }

  /** 屏幕坐标 → 边（点到线段距离 < 6px）。 */
  pickEdge(sx, sy) {
    const wx = (sx - this.view.x) / this.view.k;
    const wy = (sy - this.view.y) / this.view.k;
    let best = null, bd = 8 / this.view.k;
    for (const e of this.visibleEdges) {
      const a = this.byId(e.src), b = this.byId(e.dst);
      if (!a || !b) continue;
      const vx = b.x - a.x, vy = b.y - a.y;
      const len2 = vx * vx + vy * vy || 1e-6;
      let t = ((wx - a.x) * vx + (wy - a.y) * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * vx, py = a.y + t * vy;
      const d = Math.hypot(wx - px, wy - py);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  select(id) {
    this.selected = id;
    this.selectedEdge = null;
    this.draw();
    return this;
  }

  selectEdge(id) { this.selectedEdge = id; this.draw(); return this; }

  zoomToFit(padding) {
    const ns = this.visibleNodes;
    const w = this._size.w, h = this._size.h;
    if (!ns.length) { this.view = { x: 0, y: 0, k: 1 }; this.draw(); return this; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of ns) {
      const r = this.radiusOf(n) + 14;
      x0 = Math.min(x0, n.x - r); y0 = Math.min(y0, n.y - r);
      x1 = Math.max(x1, n.x + r); y1 = Math.max(y1, n.y + r);
    }
    const pad = padding || 24;
    const k = Math.max(0.12, Math.min(3, Math.min((w - pad * 2) / (x1 - x0 || 1), (h - pad * 2) / (y1 - y0 || 1))));
    this.view.k = k;
    this.view.x = w / 2 - ((x0 + x1) / 2) * k;
    this.view.y = h / 2 - ((y0 + y1) / 2) * k;
    this.draw();
    return this;
  }

  resize() {
    const c = fitCanvas(this.canvas, this.opts.height);
    this._size = c;
    if (!this.nodes.length) return this;
    // 已布局过的图：按比例缩放视图，避免 resize 后图跑到画布外
    this.zoomToFit();
    return this;
  }

  stats() {
    const ft = (this.frameTimes || []).slice(5).sort((a, b) => a - b);
    const pct = (p) => (ft.length ? Math.round(ft[Math.min(ft.length - 1, Math.floor(ft.length * p))] * 100) / 100 : null);
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
      frame_ms: Math.round((this._frameMs || 0) * 10) / 10,
      frame_ms_p50: pct(0.5),
      frame_ms_p95: pct(0.95),
      frame_ms_max: ft.length ? Math.round(ft[ft.length - 1] * 100) / 100 : null,
      frame_samples: ft.length,
      alpha: Math.round(this.alpha * 1000) / 1000,
      settled: this.alpha <= 0.02 || this.ticks >= this.opts.maxTicks,
    };
  }

  /**
   * 同步跑 n 次物理迭代并计时 —— 无头环境里 rAF 会被节流，帧率读数不可靠；
   * 这个基准直接量「一步物理迭代多少毫秒」，是可比、可断言的性能数字。
   */
  benchTicks(n) {
    const k = n || 10;
    const t0 = performance.now();
    for (let i = 0; i < k; i++) this.tick();
    const ms = performance.now() - t0;
    return { n: k, total_ms: Math.round(ms * 100) / 100, per_tick_ms: Math.round((ms / k) * 1000) / 1000 };
  }

  destroy() {
    this.stop();
    this.canvas.replaceWith(this.canvas.cloneNode(true));   // 摘掉所有监听
  }
}

/* ---------------- 子图抽取（Wiki 页内嵌图谱用） ---------------- */

/**
 * 当前单元的局部子图：单元内实体 + N 跳邻居。
 * @param {{nodes:Array,edges:Array}} graph normalizeGraph 之前的原始数组
 * @param {{unitIds?:string[], seedIds?:string[], focusId?:string, hops?:number, maxNodes?:number}} o
 *   seedIds 是「按卡片名反查到的实体 id」兜底：T1 的 /graph 万一没给 unit_ids，
 *   Wiki 内嵌子图仍然要能用（见 wiki.js renderSubGraph 的 seed_source）。
 */
export function localSubgraph(graph, o) {
  const opts = Object.assign({ unitIds: [], seedIds: [], focusId: null, hops: 1, maxNodes: 140 }, o || {});
  const ns = (graph.nodes || []).map((n) => ({
    id: String(n.id), name: n.name || String(n.id), name_zh: n.name_zh || '',
    type: n.type || '', layer: n.layer || '', degree: Number(n.degree || 0),
    unit_ids: (n.unit_ids || n.units || []).map(String), raw: n,
  }));
  const byId = new Map(ns.map((n) => [n.id, n]));
  const es = (graph.edges || []).map((e) => Object.assign({}, e, {
    src: String(e.src != null ? e.src : e.from), dst: String(e.dst != null ? e.dst : e.to),
  })).filter((e) => byId.has(e.src) && byId.has(e.dst));
  const unitSet = new Set((opts.unitIds || []).map(String));

  const seeds = new Set();
  for (const n of ns) if (n.unit_ids.some((u) => unitSet.has(u))) seeds.add(n.id);
  const unitSeedCount = seeds.size;
  for (const id of (opts.seedIds || [])) if (byId.has(String(id))) seeds.add(String(id));
  if (opts.focusId && byId.has(String(opts.focusId))) seeds.add(String(opts.focusId));
  const seedSource = unitSeedCount && seeds.size > unitSeedCount ? 'unit_ids+card_names'
    : unitSeedCount ? 'unit_ids' : seeds.size ? 'card_names' : 'none';

  const adj = new Map();
  for (const e of es) {
    if (!adj.has(e.src)) adj.set(e.src, []);
    if (!adj.has(e.dst)) adj.set(e.dst, []);
    adj.get(e.src).push(e.dst);
    adj.get(e.dst).push(e.src);
  }
  const keep = new Set(seeds);
  let frontier = Array.from(seeds);
  for (let h = 0; h < opts.hops; h++) {
    const next = [];
    for (const id of frontier) {
      for (const nb of (adj.get(id) || [])) {
        if (!keep.has(nb)) { keep.add(nb); next.push(nb); }
      }
    }
    frontier = next;
  }
  // 超限时按 degree 截断（保留种子优先）
  let kept = Array.from(keep);
  if (kept.length > opts.maxNodes) {
    kept.sort((a, b) => {
      const sa = seeds.has(a) ? 1 : 0, sb = seeds.has(b) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return (byId.get(b).degree || 0) - (byId.get(a).degree || 0);
    });
    kept = kept.slice(0, opts.maxNodes);
  }
  const keptSet = new Set(kept);
  const outNodes = kept.map((id) => byId.get(id)).filter(Boolean)
    .map((n) => ({ id: n.id, name: n.name, name_zh: n.name_zh, type: n.type, layer: n.layer,
      degree: n.degree, unit_ids: n.unit_ids }));
  // 度数按子图重算：否则节点半径反映的是全局 degree，子在图里看不出主次
  const deg = new Map();
  const outEdges = es.filter((e) => keptSet.has(e.src) && keptSet.has(e.dst)).map((e) => {
    deg.set(e.src, (deg.get(e.src) || 0) + 1);
    deg.set(e.dst, (deg.get(e.dst) || 0) + 1);
    return e;
  });
  for (const n of outNodes) n.degree = deg.get(n.id) || 0;
  return { nodes: outNodes, edges: outEdges, seed_count: seeds.size, seed_source: seedSource };
}

/** 卡片级迷你关系图：卡片 + 一跳引用（typed/mention/also_in/same_unit）。 */
export function cardNeighborhood(cardId, xrefIndex, cardsById, maxNodes) {
  const max = maxNodes || 26;
  const out = (xrefIndex.out.get(cardId) || []);
  const back = (xrefIndex.in.get(cardId) || []);
  const seen = new Map();
  for (const x of out.concat(back)) {
    if (x.id === cardId) continue;
    if (!seen.has(x.id)) seen.set(x.id, { id: x.id, rel: x.rel, dir: out.some((o) => o.id === x.id) ? 'out' : 'in' });
  }
  const pick = Array.from(seen.values()).slice(0, max);
  const self = cardsById.get(cardId);
  const nodes = [];
  if (self) nodes.push({ id: self.id, name: self.name, name_zh: '', type: 'self', degree: pick.length });
  for (const p of pick) {
    const c = cardsById.get(p.id);
    if (!c) continue;
    nodes.push({ id: c.id, name: c.name, name_zh: '', type: p.rel, degree: 1 });
  }
  const edges = pick.filter((p) => cardsById.get(p.id)).map((p, i) => (p.dir === 'out'
    ? { id: 'x' + i, src: cardId, dst: p.id, etype: p.rel, flagged: false, evidence: '' }
    : { id: 'x' + i, src: p.id, dst: cardId, etype: p.rel, flagged: false, evidence: '' }));
  return { nodes, edges };
}

/** 图例 HTML（图谱面板与独立图谱页共用）。 */
export function legendHTML(items) {
  return items.map((it) => {
    if (it.kind === 'line') {
      return `<span class="legend-item"><i class="legend-line${it.dashed ? ' dashed' : ''}" style="border-top-color:${esc(it.color)}"></i>${esc(it.label)}</span>`;
    }
    return `<span class="legend-item"><i class="legend-dot" style="background:${esc(it.color)}"></i>${esc(it.label)}</span>`;
  }).join('');
}
