/* ==========================================================================
   util.js —— 无依赖小工具（原生 ES module）
   写域：T3 web/assets
   ========================================================================== */

/** HTML 转义。所有拼 HTML 的地方都必须过这一层。 */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 正则字面量转义（linkify 里拼名字用）。 */
export function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function qs(sel, root) { return (root || document).querySelector(sel); }
export function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

/** 取 URL 参数（query string 优先，其次 hash 里的 ?k=v）。 */
export function params() {
  const p = new URLSearchParams(location.search);
  const h = location.hash || '';
  const i = h.indexOf('?');
  if (i >= 0) {
    const hp = new URLSearchParams(h.slice(i + 1));
    for (const [k, v] of hp) if (!p.has(k)) p.set(k, v);
  }
  return p;
}

/**
 * 契约 §3：name_key = 规范化名（小写 + 去空格）。
 * 客户端用它把图谱实体名与卡片名对上（同一种规范化，避免两套口径）。
 */
export function nameKey(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 毫秒 → mm:ss / hh:mm:ss（字幕、视频时间轴用）。 */
export function fmtMs(ms) {
  const t = Math.max(0, Math.round(Number(ms) || 0));
  const s = Math.floor(t / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

/** 契约 §2.2 的 span → 人类可读位置（同时给原文跳转用）。 */
export function fmtSpan(span) {
  if (!span) return '';
  const k = span.kind;
  if (k === 'page') return span.start === span.end ? `p${span.start}` : `p${span.start}–${span.end}`;
  if (k === 'slide') return span.start === span.end ? `幻灯片 ${span.start}` : `幻灯片 ${span.start}–${span.end}`;
  if (k === 'time') return `${fmtMs(span.start)}–${fmtMs(span.end)}`;
  if (k === 'char') return `字符 ${span.start}–${span.end}`;
  return `${k} ${span.start}–${span.end}`;
}

export function debounce(fn, ms) {
  let h = 0;
  return function (...args) {
    clearTimeout(h);
    h = setTimeout(() => fn.apply(this, args), ms || 200);
  };
}

/** 分组：Map<key, T[]>。 */
export function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) {
    const k = fn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

/**
 * 把一份 JSON 结果写进 <script type="application/json">。
 * 用途：headless Chrome 用 --dump-dom 只能看 DOM 文本，canvas 上的图看不出来，
 * 所以把渲染统计/自检结果以 JSON 落进 DOM，测试断言这里的具体值。
 */
export function writeJsonScript(id, obj) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('script');
    el.type = 'application/json';
    el.id = id;
    el.className = 'report-json';
    document.body.appendChild(el);
  }
  el.textContent = JSON.stringify(obj);
  return el;
}

export function readJsonScript(id) {
  const el = document.getElementById(id);
  if (!el || !el.textContent.trim()) return null;
  try { return JSON.parse(el.textContent); } catch (e) { return null; }
}

/** 并发受限的 map（卡片详情批量拉取用；契约 C1 的"并发=1"是 LLM 侧约束，前端只做轻量限流）。 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 页面级错误提示（后端没起来时不留白页）。 */
export function showFatal(msg, detail) {
  const box = document.createElement('div');
  box.className = 'error-banner';
  box.id = 'fatal-banner';
  box.innerHTML = `<b>初始化失败</b><div style="margin-top:4px">${esc(msg)}</div>`
    + (detail ? `<div class="small mono" style="margin-top:6px;white-space:pre-wrap">${esc(detail)}</div>` : '')
    + '<div class="small" style="margin-top:6px">检查后端：<code>python -m uvicorn server.main:app --port 8787</code>，'
    + '再刷新本页。本页数据全部来自 <code>/api/v1</code>（同源），不经 file:// 打开（坑 8）。</div>';
  document.body.insertBefore(box, document.body.firstChild);
}

/** 画布尺寸（含 devicePixelRatio 适配）——图谱与视频页共用。 */
export function fitCanvas(canvas, minHeight) {
  const wrap = canvas.parentElement;
  const cssW = Math.max(320, wrap.clientWidth || 800);
  const cssH = Math.max(minHeight || 320, wrap.clientHeight || minHeight || 420);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: cssW, h: cssH, dpr };
}

/* ==========================================================================
   无头测试同步屏障（仅测试用，生产不传 ?barrier= 时完全无副作用）
   --------------------------------------------------------------------------
   为什么需要：headless Chrome 的 --dump-dom 在 **load 事件**时取 DOM，而页面数据是
   load 之后异步拉的 → 只能靠 --virtual-time-budget 延后 dump。但虚拟时钟下
   performance.now() 在同步执行期间不前进（实测 bench.per_tick_ms 恒为 0），
   性能数字就变成假的。
   做法：模块里注入一个**挂起的 <img>** 请求（服务端扣住不答），load 事件因此被推迟；
   页面把活干完后调 done() 通知服务端放行 → dump 时拿到的是真实时间下渲染完的 DOM。
   ========================================================================== */

let _barrierUrl = null;

export function testBarrier() {
  const b = params().get('barrier');
  if (!b) return null;
  _barrierUrl = b;
  const img = document.createElement('img');
  img.id = 'test-barrier';
  img.alt = '';
  img.style.display = 'none';
  img.src = b + (b.includes('?') ? '&' : '?') + 't=' + Date.now();
  document.body.appendChild(img);
  return b;
}

export async function testBarrierDone() {
  if (!_barrierUrl) return;
  const url = _barrierUrl.replace(/\/hold\b/, '/release');
  try { await fetch(url, { cache: 'no-store' }); } catch (e) { /* 夹具不可用时忽略 */ }
  _barrierUrl = null;
}
