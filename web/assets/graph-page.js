/* ==========================================================================
   graph-page.js —— 独立图谱页（graph.html）逻辑
   --------------------------------------------------------------------------
   F5 验收：
     · 自绘 SVG/Canvas 力导向（不引第三方图库）→ 复用 graph-core.js 的 ForceGraph
     · 拖拽 / 缩放 / 按 etype 筛选（12 色）/ 点击看证据
     · flagged 边虚线（因果可疑，只标记不删除）
     · 节点大小 ∝ degree
     · 渲染 ≥1000 节点不卡 → 性能数字落进 #perf-report（headless 可断言）
   ========================================================================== */

import { Api, loadCaps, renderCapChips, applyGate } from './api.js';
import { esc, qs, qsa, params, writeJsonScript, showFatal, fmtSpan, testBarrier, testBarrierDone } from './util.js';
import {
  ForceGraph, legendHTML, etypeColor, etypeZh, typeColor, typeZh, layerColor,
  ETYPE_COLORS, ETYPE_ZH, LAYER_COLORS, LAYER_ZH, colorOf,
} from './graph-core.js';

const P = params();
testBarrier();      // 仅当 ?barrier= 出现时生效（无头测试同步用）
const G = { docId: null, docs: [], data: null, fg: null, focus: null, caps: null };

function optList(map, zhMap) {
  return Object.keys(map).map((k) => `<option value="${esc(k)}">${esc(zhMap[k] || k)}</option>`).join('');
}

function etypeFiltersHTML(counts) {
  const keys = Object.keys(ETYPE_COLORS);
  return keys.map((k) => {
    const n = counts[k] || 0;
    const flaggedN = counts[k + ':flagged'] || 0;
    return `<label class="etype-check" data-etype="${esc(k)}" title="${esc(etypeZh(k))}">`
      + `<input type="checkbox" checked data-etype-box="${esc(k)}">`
      + `<i style="border-top-color:${esc(etypeColor(k))}"></i>`
      + `${esc(k)} <span class="cnt">${n}${flaggedN ? ` (flagged ${flaggedN})` : ''}</span></label>`;
  }).join('');
}

function collectEtypeCounts(edges) {
  const c = {};
  for (const e of edges || []) {
    c[e.etype] = (c[e.etype] || 0) + 1;
    if (e.flagged) c[e.etype + ':flagged'] = (c[e.etype + ':flagged'] || 0) + 1;
  }
  return c;
}

function currentNode() {
  return G.focus ? G.fg.byId(G.focus) : null;
}

function renderDetail(id) {
  const box = qs('#g-detail');
  const fg = G.fg;
  if (!id || !fg) { box.innerHTML = '<div class="detail-empty">点击画布中的节点（或右侧列表）查看它的边与证据。</div>'; return; }
  const n = fg.byId(id);
  if (!n) { box.innerHTML = '<div class="detail-empty">节点不存在</div>'; return; }
  const outs = fg.edges.filter((e) => e.src === id);
  const ins = fg.edges.filter((e) => e.dst === id);
  const nm = (x) => { const t = fg.byId(x); return t ? (t.name_zh || t.name) : x; };
  const rowHTML = (e, dir) => {
    const other = dir === 'out' ? e.dst : e.src;
    return `<div class="edge-row" data-edge-id="${esc(e.id)}" data-etype="${esc(e.etype)}">`
      + `<span class="etype" style="border-color:${esc(etypeColor(e.etype))}">${esc(etypeZh(e.etype))}</span>`
      + `<span>${dir === 'out' ? '→' : '←'} ${esc(nm(other))}</span>`
      + (e.flagged ? '<span class="pill bad" style="font-size:9px">flagged</span>' : '')
      + (e.confidence ? `<span class="faint mono tiny right">${e.confidence.toFixed(2)}</span>` : '')
      + (e.evidence ? `<div class="evidence" style="flex-basis:100%">${esc(e.evidence)}</div>` : '')
      + '</div>';
  };
  const unit = (n.unit_ids || [])[0];
  box.innerHTML = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">`
    + `<i class="legend-dot" style="background:${esc(typeColor(n.type))}"></i>`
    + `<b style="font-size:16px">${esc(n.name_zh || n.name)}</b>`
    + `<span class="pill">${esc(typeZh(n.type))}</span>`
    + `<span class="pill">${esc(LAYER_ZH[n.layer] || n.layer || '未分层')}</span></div>`
    + `<div class="faint mono small">${esc(n.name)}</div>`
    + `<dl class="kv"><dt>degree</dt><dd class="mono">${n.degree}</dd>`
    + `<dt>入边 / 出边</dt><dd class="mono">${ins.length} / ${outs.length}</dd>`
    + `<dt>单元</dt><dd class="mono small">${esc((n.unit_ids || []).join(', ') || '—')}</dd></dl>`
    + (unit ? `<a class="flink" href="index.html?unit=${encodeURIComponent(unit)}#unit=${encodeURIComponent(unit)}">📚 在知识库中打开该单元</a>` : '')
    + `<div class="small muted" style="margin:12px 0 4px">出边（${outs.length}）</div>`
    + (outs.map((e) => rowHTML(e, 'out')).join('') || '<span class="faint small">（无）</span>')
    + `<div class="small muted" style="margin:12px 0 4px">入边（${ins.length}）</div>`
    + (ins.map((e) => rowHTML(e, 'in')).join('') || '<span class="faint small">（无）</span>');
  box.dataset.nodeId = id;
  box.dataset.nodeName = n.name;
  // 边行点击 → 高亮该边，显示证据与原文跳转
  qsa('.edge-row', box).forEach((row) => row.addEventListener('click', () => {
    const e = fg.edges.find((x) => x.id === row.dataset.edgeId);
    if (!e) return;
    fg.selectEdge(e.id);
    const ev = qs('#g-evidence');
    ev.classList.remove('hidden');
    ev.innerHTML = `<b>${esc(etypeZh(e.etype))}</b> <span class="mono small">${esc(e.etype)}</span>`
      + (e.flagged ? ' <span class="pill bad">flagged（因果可疑，虚线标记）</span>' : '')
      + `<div class="evidence">${esc(e.evidence || '（无证据文本）')}</div>`
      + `<div class="small faint">置信度 ${esc(String(e.confidence || 0))}`
      + (e.span ? ` · 位置 ${esc(fmtSpan(e.span))}` : '')
      + (e.span && e.span.kind === 'page' && G.docId
        ? ` · <a class="flink" href="${esc(Api.fileUrl(G.docId, e.span.start))}" target="_blank" rel="noopener">📖 原文 ${esc(fmtSpan(e.span))}</a>` : '')
      + (e.span && e.span.kind === 'time' && G.docId
        ? ` · <a class="flink" href="video.html?doc=${encodeURIComponent(G.docId)}&t=${e.span.start}" target="_blank" rel="noopener">🎬 视频 ${esc(fmtSpan(e.span))}</a>` : '')
      + '</div>';
  }));
}

function renderTopList(list) {
  const box = qs('#g-top');
  box.innerHTML = list.slice(0, 60).map((n) => `<div class="gnode-row" data-node-id="${esc(n.id)}">`
    + `<i class="legend-dot" style="background:${esc(typeColor(n.type))}"></i>`
    + `<span style="flex:1">${esc(n.name_zh || n.name)}</span>`
    + `<span class="faint mono tiny">deg ${n.degree}</span></div>`).join('') || '<div class="faint small">（无）</div>';
  qsa('.gnode-row', box).forEach((row) => row.addEventListener('click', () => focusNode(row.dataset.nodeId)));
}

function focusNode(id) {
  G.focus = id;
  const fg = G.fg;
  if (!fg) return;
  fg.select(id);
  const n = fg.byId(id);
  if (n) {
    // 把节点挪到视口中心（保持缩放）
    fg.view.x = fg._size.w / 2 - n.x * fg.view.k;
    fg.view.y = fg._size.h / 2 - n.y * fg.view.k;
    fg.draw();
  }
  renderDetail(id);
  qs('#g-detail').scrollTop = 0;
}

function applyFilters() {
  const on = qsa('#etype-filters input[data-etype-box]:checked').map((x) => x.dataset.etypeBox);
  const all = Object.keys(ETYPE_COLORS);
  const fg = G.fg;
  if (!fg) return;
  fg.setFilter({
    etypes: on.length === all.length ? null : on,
    layers: qs('#g-layer').value ? [qs('#g-layer').value] : null,
    minDegree: Number(qs('#g-mindeg').value || 0),
    flaggedOnly: qs('#g-flagged').checked,
    colorBy: qs('#g-colorby').value === 'layer' ? 'layer' : 'type',
    labels: qs('#g-labels').value,
  });
  const st = fg.stats();
  qs('#g-stats').textContent = `节点 ${st.nodes}（可见 ${st.visible_nodes}）· 边 ${st.edges}（可见 ${st.visible_edges}）`
    + ` · flagged ${st.flagged_edges} · 选中 etype ${on.length}/${all.length}`;
  qs('#g-stats').dataset.visibleNodes = String(st.visible_nodes);
  qs('#g-stats').dataset.visibleEdges = String(st.visible_edges);
  qs('#g-stats').dataset.flagged = String(st.flagged_edges);
  renderTopList(fg.visibleNodes.slice().sort((a, b) => b.degree - a.degree));
}

function writePerf(extra) {
  const fg = G.fg;
  if (!fg) return;
  const st = fg.stats();
  let bench = null;
  try { bench = fg.benchTicks(10); } catch (e) { bench = { error: String(e && e.message) }; }
  const report = Object.assign({}, st, {
    bench,
    avg_frame_ms: st.frames ? Math.round((st.elapsed_ms / st.frames) * 100) / 100 : null,
    doc: G.docId,
    rendered_at: new Date().toISOString(),
  }, extra || {});
  window.__PERF__ = report;
  writeJsonScript('perf-report', report);
  qs('#g-perf').textContent = `布局：${st.ticks} ticks / ${st.frames} 帧 / ${st.elapsed_ms} ms`
    + ` · ${report.avg_frame_ms} ms/帧 · 物理 ${bench && bench.per_tick_ms} ms/tick`;
  return report;
}

async function boot() {
  try {
    const caps = await loadCaps();
    G.caps = caps.summary;
    renderCapChips(qs('#caps'), caps.summary);
    if (!caps.summary.llm.ok) {
      qs('#caps').insertAdjacentHTML('afterend',
        `<div class="note warn" style="margin:10px 20px 0" id="llm-note">知识图谱由 LLM 抽取（F2）。当前 <code>/capabilities.llm.configured=false</code>：`
        + `${esc(caps.summary.llm.reason)}。已有图谱仍可浏览，但「重新抽取」不可用。</div>`);
    }
    const docsRes = await Api.documents({ limit: 100 });
    G.docs = docsRes.items || docsRes.documents || [];
    if (!G.docs.length) {
      qs('#g-canvas-wrap').innerHTML = '<div class="loading" style="color:#c9d3e0">还没有文档：先上传并完成抽取</div>';
      writeJsonScript('perf-report', { error: 'no documents' });
      return;
    }
    const sel = qs('#g-doc');
    sel.innerHTML = G.docs.map((d) => `<option value="${esc(d.id)}">${esc(d.title)}（${esc(d.kind)}）</option>`).join('');
    const want = P.get('doc');
    const chosen = G.docs.find((d) => d.id === want) || G.docs.find((d) => d.kind !== 'video' && d.status === 'ready') || G.docs[0];
    sel.value = chosen.id;
    sel.addEventListener('change', () => loadGraph(sel.value));

    qs('#etype-filters').addEventListener('change', applyFilters);
    qs('#g-layer').addEventListener('change', applyFilters);
    qs('#g-mindeg').addEventListener('input', applyFilters);
    qs('#g-flagged').addEventListener('change', applyFilters);
    qs('#g-colorby').addEventListener('change', applyFilters);
    qs('#g-labels').addEventListener('change', applyFilters);
    qs('#g-relayout').addEventListener('click', () => {
      if (!G.fg) return;
      G.fg.relayout(); G.fg.start();
      qs('#g-settle').textContent = '布局中…';
    });
    qs('#g-fit').addEventListener('click', () => G.fg && G.fg.zoomToFit());
    qs('#g-nodefilter').addEventListener('input', () => {
      const q = qs('#g-nodefilter').value.trim().toLowerCase();
      if (!G.fg) return;
      const list = G.fg.nodes.filter((n) => !q
        || (n.name || '').toLowerCase().includes(q) || (n.name_zh || '').toLowerCase().includes(q) || n.id.toLowerCase().includes(q));
      qs('#g-search-results').classList.remove('hidden');
      qs('#g-search-results').innerHTML = (list.slice(0, 50).map((n) => `<div class="gnode-row" data-node-id="${esc(n.id)}">`
        + `<i class="legend-dot" style="background:${esc(typeColor(n.type))}"></i>`
        + `<span style="flex:1">${esc(n.name_zh || n.name)}</span><span class="faint mono tiny">deg ${n.degree}</span></div>`).join('')
        || '<div class="faint small" style="padding:6px">无匹配节点</div>')
        + `<div class="faint tiny" style="padding:4px 6px">匹配 ${list.length} / ${G.fg.nodes.length}</div>`;
      qsa('#g-search-results .gnode-row').forEach((row) => row.addEventListener('click', () => focusNode(row.dataset.nodeId)));
    });

    await loadGraph(chosen.id);
    if (P.get('focus')) focusNode(P.get('focus'));
    if (P.get('selftest') === '1') await runSelftest();
  } catch (e) {
    showFatal(e.message || String(e), e.detail || '');
    writeJsonScript('perf-report', { error: e.message, code: e.code || '' });
  } finally {
    await testBarrierDone();
  }
}

async function loadGraph(docId) {
  G.docId = docId;
  qs('#g-settle').textContent = '加载图谱…';
  const g = await Api.graph(docId);
  G.data = g;
  const counts = collectEtypeCounts(g.edges);
  qs('#etype-filters').innerHTML = etypeFiltersHTML(counts);
  qs('#g-layer').innerHTML = '<option value="">全部层</option>' + optList(LAYER_COLORS, LAYER_ZH);
  const stats = g.stats || {};
  qs('#g-meta').textContent = `${(g.nodes || []).length} 节点 / ${(g.edges || []).length} 边`
    + (stats.verify_rate != null ? ` · 证据校验 ${(stats.verify_rate * 100).toFixed(1)}%` : '');
  qs('#g-meta').dataset.nodes = String((g.nodes || []).length);
  qs('#g-meta').dataset.edges = String((g.edges || []).length);

  const cvs = qs('#g-canvas');
  if (G.fg) G.fg.destroy();
  const t0 = performance.now();
  G.fg = new ForceGraph(cvs, {
    height: Math.max(420, qs('#g-canvas-wrap').clientHeight || 560),
    labels: 'auto', maxLabels: 140, labelMinDegree: 3, maxTicks: 420, ticksPerFrame: 2,
    onNodeClick: (n) => focusNode(n.id),
    onEdgeClick: (e) => {
      const ev = qs('#g-evidence');
      ev.classList.remove('hidden');
      ev.innerHTML = `<b>${esc(etypeZh(e.etype))}</b><div class="evidence">${esc(e.evidence || '（无证据文本）')}</div>`;
    },
    onBackground: () => renderDetail(null),
    onSettled: (st) => {
      qs('#g-settle').textContent = `布局完成：${st.ticks} ticks / ${st.elapsed_ms} ms`;
      writePerf({ settle_ms: Math.round(performance.now() - t0) });
    },
  });
  G.fg.setData(g.nodes || [], g.edges || []);
  G.fg.applyVisibility();
  G.fg.start();
  G.fg.zoomToFit();
  applyFilters();
  renderDetail(G.focus);
  qs('#g-legend').innerHTML = legendHTML(
    Object.keys(ETYPE_COLORS).map((k) => ({ kind: 'line', color: etypeColor(k), label: `${k} ${etypeZh(k)}` }))
      .concat([{ kind: 'line', color: '#ffffff', dashed: true, label: 'flagged 边（虚线）' }])
      .concat(Object.keys(TYPE_COLORS2()).map((t) => ({ kind: 'dot', color: typeColor(t), label: typeZh(t) }))));
  qs('#g-legend').dataset.flaggedLegend = '1';
  // 首帧统计（settle 之前也能给出数字，settle 后再覆盖一次）
  setTimeout(() => writePerf({ phase: 'first' }), 900);
}

// 图例只需要用到的类型（避免 12 个类型全列）
function TYPE_COLORS2() {
  const seen = new Set((G.data && G.data.nodes || []).map((n) => n.type).filter(Boolean));
  const m = {};
  for (const t of seen) m[t] = 1;
  return m;
}

/* ---------------- 自检 ---------------- */

/** 等布局收敛（自检要在真实稳态下取性能数字，不能拿首帧当结论）。 */
async function waitSettle(maxMs) {
  const t0 = performance.now();
  while (G.fg && G.fg.alpha > 0.02 && G.fg.ticks < G.fg.opts.maxTicks
    && performance.now() - t0 < (maxMs || 20000)) {
    await new Promise((r) => setTimeout(r, 120));
  }
  return Math.round(performance.now() - t0);
}

async function runSelftest() {
  const R = { checks: {}, ok: true };
  const rec = (k, v) => { R.checks[k] = v; };
  const settleWait = await waitSettle(20000);
  const fg = G.fg;
  const st = fg.stats();
  rec('settle_wait_ms', settleWait);
  rec('settled', st.settled);
  rec('caps_loaded', !!G.caps);
  rec('nodes', st.nodes);
  rec('edges', st.edges);
  rec('flagged_edges', st.flagged_edges);
  rec('etype_checkboxes', qsa('#etype-filters input[data-etype-box]').length);
  rec('legend_dashed_flagged', !!qs('#g-legend .legend-line.dashed'));
  rec('node_size_by_degree', fg.nodes.length ? fg.radiusOf(fg.nodes.slice().sort((a, b) => b.degree - a.degree)[0])
    : 0);
  rec('radius_monotonic', (() => {
    const a = fg.nodes.slice().sort((x, y) => x.degree - y.degree);
    if (a.length < 2) return false;
    return fg.radiusOf(a[a.length - 1]) > fg.radiusOf(a[0]);
  })());

  // 筛选：只留一个 etype → 可见边应当等于该类型边数
  const firstEtype = Object.keys(ETYPE_COLORS).find((k) => collectEtypeCounts(G.data.edges)[k] > 0);
  if (firstEtype) {
    const expect = collectEtypeCounts(G.data.edges)[firstEtype];
    qsa('#etype-filters input[data-etype-box]').forEach((b) => { b.checked = b.dataset.etypeBox === firstEtype; });
    applyFilters();
    await new Promise((r) => setTimeout(r, 120));
    rec('filter_etype', firstEtype);
    rec('filter_visible_edges', fg.visibleEdges.length);
    rec('filter_expect_edges', expect);
    rec('filter_ok', fg.visibleEdges.length === expect && expect > 0 && fg.visibleEdges.every((e) => e.etype === firstEtype));
    qsa('#etype-filters input[data-etype-box]').forEach((b) => { b.checked = true; });
    applyFilters();
  } else {
    rec('filter_ok', false);
  }

  // flagged 过滤
  qs('#g-flagged').checked = true;
  applyFilters();
  await new Promise((r) => setTimeout(r, 100));
  rec('flagged_only_visible_edges', fg.visibleEdges.length);
  rec('flagged_only_ok', fg.visibleEdges.every((e) => e.flagged) && fg.visibleEdges.length === st.flagged_edges);
  qs('#g-flagged').checked = false;
  applyFilters();

  // 点击节点（真实 click 事件 → canvas 命中测试的等价路径用 focusNode 走 DOM 列表）
  const row = qs('#g-top .gnode-row');
  if (row) {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 120));
    rec('node_click_id', qs('#g-detail').dataset.nodeId || '');
    rec('node_click_name', qs('#g-detail').dataset.nodeName || '');
    rec('node_click_ok', !!qs('#g-detail').dataset.nodeId);
  } else { rec('node_click_ok', false); }

  // 点击一条边 → 证据面板 + 原文跳转（C8 证据链）
  const erow = qs('#g-detail .edge-row');
  if (erow) {
    erow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));
    const ev = qs('#g-evidence');
    const html = ev.innerHTML;
    rec('edge_evidence_ok', !ev.classList.contains('hidden') && html.length > 20);
    rec('edge_evidence_has_span_link', /file#page=\d+/.test(html) || /video\.html\?doc=.*&t=\d+/.test(html));
    rec('edge_evidence_type', erow.dataset.etype || '');
  } else { rec('edge_evidence_ok', false); }

  const perf = writePerf({ phase: 'selftest', settle_wait_ms: settleWait });  rec('perf', { nodes: perf.nodes, edges: perf.edges, ticks: perf.ticks, frames: perf.frames,
    elapsed_ms: perf.elapsed_ms, avg_frame_ms: perf.avg_frame_ms, tick_ms: perf.bench && perf.bench.per_tick_ms,
    frame_ms_p50: perf.frame_ms_p50, frame_ms_p95: perf.frame_ms_p95, frame_ms_max: perf.frame_ms_max });
  rec('perf_ok', !!(perf.nodes >= 1000 && perf.bench && perf.bench.per_tick_ms < 25
    && perf.frame_ms_p50 != null && perf.frame_ms_p50 < 25));

  R.ok = R.checks.nodes >= 1 && R.checks.filter_ok === true && R.checks.flagged_only_ok === true
    && R.checks.node_click_ok === true && R.checks.edge_evidence_ok === true && R.checks.perf_ok === true;
  writeJsonScript('selftest-report', R);
  qs('#g-selftest').textContent = R.ok ? '自检通过' : '自检未通过，见 #selftest-report';
  return R;
}

/* 坑 9：boot() 只能在 DOMContentLoaded 或脚本末尾调用 */
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
