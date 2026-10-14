/* ==========================================================================
   wiki.js —— 知识库浏览页（index.html）主逻辑
   --------------------------------------------------------------------------
   交付要求（task-7）：
     · 左侧可展开层次树（/outline；无内容节点显示 – 徽章）
     · 右侧 概括区（intro/why/学习目标/要点）+ 子节 + 知识卡片（五要素）
     · 交叉引用：正文内链 + 引用区（类型化/正文提到/还出现在）+ 反链
     · 卡片底部原文跳转（PDF → #page=N；Video → currentTime）
     · ★ Wiki 页内嵌图谱：当前单元的局部子图（节点可点击跳转）—— 用户核心要求
   坑 9：boot() 必须在 DOMContentLoaded 或脚本末尾调用（早期提前调用 → undefined 报错）。
   ========================================================================== */

import { Api, loadAllCards, loadAllXrefs, loadCaps, renderCapChips, applyGate } from './api.js';
import {
  esc, qs, qsa, params, nameKey, fmtSpan, fmtMs, debounce, writeJsonScript, showFatal,
  testBarrier, testBarrierDone,
} from './util.js';
import {
  ForceGraph, localSubgraph, cardNeighborhood, legendHTML, typeColor, etypeColor, etypeZh,
  typeZh, layerColor, LAYER_ZH, ETYPE_ZH, TYPE_ZH, colorOf, ETYPE_COLORS,
} from './graph-core.js';
import { buildXrefIndex, buildNameIndex, linkify, xrefHTML, bindGoto, REL_ZH } from './xref.js';

const P = params();
const T_LOAD0 = (typeof performance !== 'undefined' ? performance.now() : 0);
testBarrier();      // 仅当 ?barrier= 出现时生效（无头测试同步用）

const S = {
  caps: null,
  docs: [],
  docId: null,
  doc: null,
  outline: null,
  units: new Map(),
  cards: [],
  cardsById: new Map(),
  nameIndex: null,
  xrefs: { out: new Map(), in: new Map() },
  graph: null,                  // 契约 /graph 原始响应
  unitId: null,
  cardId: null,
  subGraph: null,
  miniGraphs: new Map(),
  treeFilter: '',
};

/* ---------------- 契约字段归一化 ---------------- */

function cardSpan(c) {
  if (c.evidence_span) return c.evidence_span;
  if (c.span_kind || c.span_start || c.span_end) {
    return { kind: c.span_kind || '', start: Number(c.span_start || 0), end: Number(c.span_end || c.span_start || 0) };
  }
  if (c.source && c.source.page) return { kind: 'page', start: c.source.page, end: c.source.page };
  return null;
}
const cardUnitId = (c) => c.unit_id || c.unit || '';

/* ---------------- 渲染：树 ---------------- */

function outlineNode(id) { return S.outline && S.outline.nodes ? S.outline.nodes[id] : null; }

function nodeBadges(n) {
  const cards = Number(n.n_cards || 0);
  const units = Number(n.n_units || 0);
  if (cards > 0) return `<span class="badge-cards">${cards} 卡片</span>`;
  // 验收：无内容的节点显示 – 徽章（而且 intro 说明仍然要有）
  return `<span class="badge-empty" title="本节暂无知识点${units ? `（含 ${units} 个子节点）` : ''}">–</span>`;
}

function treeRowHTML(n, id) {
  const span = n.span ? `<span class="tpg">${esc(fmtSpan(n.span))}</span>` : '';
  const title = n.title || id;
  return `<div class="trow" data-unit="${esc(id)}" title="${esc(title)}">`
    + `<span class="tw">${(n.children && n.children.length) ? '▸' : ''}</span>`
    + `<span class="tt">${esc(title)}</span>${nodeBadges(n)}${span}</div>`;
}

function renderTree() {
  const mount = qs('#tree');
  const roots = (S.outline && S.outline.roots) || [];
  mount.innerHTML = roots.map((r) => {
    const n = outlineNode(r);
    if (!n) return '';
    const leaf = !(n.children && n.children.length);
    return `<ul><li class="${leaf ? 'leaf' : ''}" data-id="${esc(r)}">`
      + treeRowHTML(n, r)
      + `<div class="tree-children"></div></li></ul>`;
  }).join('') || '<div class="loading">目录为空</div>';
  mount.dataset.rendered = '1';
}

/** 展开某节点（懒加载子层）：一次只建一层 DOM，2458 节点也不卡。 */
function expandNode(li) {
  const box = li.querySelector(':scope > .tree-children');
  if (!box) return;
  if (box.dataset.loaded === '1') { box.classList.add('open'); return; }
  const id = li.dataset.id;
  const n = outlineNode(id);
  const kids = (n && n.children) || [];
  box.innerHTML = kids.map((c) => {
    const cn = outlineNode(c);
    if (!cn) return '';
    const leaf = !(cn.children && cn.children.length);
    return `<ul><li class="${leaf ? 'leaf' : ''}" data-id="${esc(c)}">`
      + treeRowHTML(cn, c)
      + `<div class="tree-children"></div></li></ul>`;
  }).join('');
  box.dataset.loaded = '1';
  box.classList.add('open');
  const tw = li.querySelector(':scope > .trow .tw');
  if (tw) tw.textContent = '▾';
}

function collapseNode(li) {
  const box = li.querySelector(':scope > .tree-children');
  if (box) box.classList.remove('open');
  const tw = li.querySelector(':scope > .trow .tw');
  if (tw && box && box.dataset.loaded === '1') tw.textContent = '▸';
}

function selectTreeRow(unitId) {
  qsa('#tree .trow').forEach((r) => r.classList.toggle('active', r.dataset.unit === unitId));
}

/** 展开到指定节点（把祖先链一路打开）。 */
function revealTreePath(unitId) {
  const chain = breadcrumb(unitId);
  let cur = qs(`#tree li[data-id="${cssEsc(unitId)}"]`);
  for (const anc of chain.slice(0, -1)) {
    const li = qs(`#tree li[data-id="${cssEsc(anc)}"]`);
    if (li) expandNode(li);
  }
  cur = qs(`#tree li[data-id="${cssEsc(unitId)}"]`);
  if (cur) {
    const host = cur.closest('#tree');
    if (host) host.scrollTop = Math.max(0, cur.offsetTop - 120);
  }
}

function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

/** 面包屑：从根到该节点的标题链（父指针来自 buildParentMap，不依赖 outline.parent_id）。 */
function breadcrumb(unitId) {
  const chain = [];
  let id = unitId;
  let guard = 0;
  while (id && guard++ < 40) {
    chain.unshift(id);
    id = S._parentMap ? S._parentMap.get(id) : null;
  }
  return chain;
}

/** outline 可能不返回 parent_id（契约只给了 children）→ 自建父指针。 */
function buildParentMap() {
  const m = new Map();
  const nodes = (S.outline && S.outline.nodes) || {};
  for (const [id, n] of Object.entries(nodes)) {
    for (const c of (n.children || [])) m.set(c, id);
    if (n.parent_id) m.set(id, n.parent_id);
  }
  S._parentMap = m;
  return m;
}

/* ---------------- 渲染：概括区 ---------------- */

function sectionHeaderHTML(n, unitId) {
  const objectives = n.objectives || n.learning_objectives || [];
  const takeaways = n.key_takeaways || [];
  const role = n.section_role;
  let h = `<div class="panel" id="sec-head" data-unit="${esc(unitId)}">`;
  h += crumbHTML(unitId);
  h += `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">`
    + `<span class="pill">L${esc(String(n.level != null ? n.level : '?'))}</span>`
    + (role ? `<span class="pill blue">${esc(roleZh(role))}</span>` : '')
    + (n.span ? `<span class="pill">${esc(fmtSpan(n.span))}</span>` : '')
    + `<span class="pill">知识点 ${Number(n.n_cards || 0)}</span>`
    + `<span class="pill">子节点 ${Number(n.n_units || (n.children || []).length)}</span>`
    + `</div>`;
  h += `<h1 class="sec-title" data-unit-title="${esc(unitId)}">${esc(n.title || unitId)}</h1>`;
  const intro = n.intro || n.section_summary || '';
  h += `<div class="defrow"><div class="deflabel">本节讲什么</div><div class="deftext" data-sec-intro="1">`
    + (intro ? linkify(intro, { index: S.nameIndex }) : '<span class="faint">（后端未提供 intro —— F3 要求所有层级都有；请检查 /outline 的 intro 字段）</span>')
    + '</div></div>';
  const why = n.why || n.why_important || '';
  if (why) {
    h += `<div class="defrow"><div class="deflabel">为什么重要</div><div class="deftext">${linkify(why, { index: S.nameIndex })}</div></div>`;
  }
  if (objectives.length) {
    h += `<div class="defrow"><div class="deflabel">学习目标</div><div class="deftext"><ul style="margin:0;padding-left:18px">`
      + objectives.map((o) => `<li>${esc(o)}</li>`).join('') + '</ul></div></div>';
  }
  if (takeaways.length) {
    h += `<div class="defrow"><div class="deflabel">要点</div><div class="deftext"><ul style="margin:0;padding-left:18px">`
      + takeaways.map((o) => `<li>${esc(o)}</li>`).join('') + '</ul></div></div>';
  }
  h += '</div>';
  return h;
}

function roleZh(r) {
  return {
    concept_intro: '概念介绍', how_to: '操作指南', reference: '参考手册', troubleshooting: '排错',
    best_practice: '最佳实践', internals: '内部原理', comparison: '对比', unknown: '未知',
  }[r] || r;
}

function crumbHTML(unitId) {
  const chain = breadcrumb(unitId);
  if (!chain.length) return '';
  return '<div class="crumbbar">' + chain.map((id, i) => {
    const n = outlineNode(id);
    const t = n ? (n.title || id) : id;
    return i === chain.length - 1
      ? `<b>${esc(t)}</b>`
      : `<a href="#unit=${esc(id)}" data-unit-link="${esc(id)}" style="text-decoration:none">${esc(t)}</a>`;
  }).join(' › ') + '</div>';
}

/* ---------------- 渲染：卡片（五要素） ---------------- */

function cardHTML(c) {
  const unit = S.units.get(cardUnitId(c));
  const span = cardSpan(c);
  const conf = Number(c.confidence || 0);
  const cls = conf >= 0.8 ? '' : (conf >= 0.5 ? 'low' : 'vlow');
  const selfKey = nameKey(c.name);
  const idx = { index: S.nameIndex, selfId: c.id, selfKey };
  let h = `<div class="kcard" id="card-${esc(c.id)}" data-card="${esc(c.id)}" data-unit="${esc(cardUnitId(c))}">`;
  h += '<div class="khead"><span class="kname">' + esc(c.name) + '</span><span class="kchips">'
    + (c.kind ? `<span class="pill purple">${esc(kindZh(c.kind))}</span>` : '')
    + (c.usage_mode ? `<span class="pill orange">${esc(usageZh(c.usage_mode))}</span>` : '')
    + (c.operational_role ? `<span class="pill">${esc(roleUsageZh(c.operational_role))}</span>` : '')
    + '</span></div>';
  if (c.one_line) h += `<div class="defrow"><div class="deflabel">是什么</div><div class="deftext">${linkify(c.one_line, idx)}</div></div>`;
  if (c.purpose) h += `<div class="defrow"><div class="deflabel">能做什么</div><div class="deftext">${linkify(c.purpose, idx)}</div></div>`;
  if (c.example) {
    h += `<div class="defrow"><div class="deflabel">示例</div><div class="deftext"><pre>${esc(c.example)}</pre>`
      + (c.example_explained ? `<div class="small muted" style="margin-top:4px"><b>说明：</b>${linkify(c.example_explained, idx)}</div>` : '')
      + '</div></div>';
  }
  const prereq = c.prerequisites || [];
  const cautions = c.cautions || [];
  if (prereq.length) h += `<div class="req"><b>前提：</b>${prereq.map((x) => linkify(x, idx)).join('；')}</div>`;
  if (cautions.length) h += `<div class="warn"><b>⚠ 注意：</b>${cautions.map((x) => linkify(x, idx)).join('；')}</div>`;
  if (c.lifecycle && c.lifecycle !== 'unknown') h += `<div class="req"><b>生效方式：</b>${esc(lifecycleZh(c.lifecycle))}</div>`;

  h += xrefHTML(c, S.xrefs, S.cardsById, { limit: 60 });

  h += '<div class="kfoot">' + sourceLinkHTML(c, span) + '<span class="right"></span>'
    + `<button class="mini-toggle" data-mini="${esc(c.id)}" type="button">关系图</button>`
    + `<span class="conf ${cls}">置信度 ${conf.toFixed(2)} <i><b style="width:${(conf * 100).toFixed(0)}%"></b></i></span>`
    + (unit ? `<span class="faint" title="所属单元">${esc(unit.title || '')}</span>` : '')
    + '</div>';
  h += `<div class="mini-graph hidden" data-mini-host="${esc(c.id)}"></div>`;
  h += '</div>';
  return h;
}

/** 原文跳转（C8：页码/时间戳必须可回溯原文）。 */
export function sourceLinkHTML(c, span) {
  const sp = span || cardSpan(c);
  const docId = S.docId;
  if (!sp || !sp.kind) {
    return '<span class="flink" aria-disabled="true" title="该卡片没有可回溯的 span">原文位置缺失</span>';
  }
  if (sp.kind === 'time') {
    return `<a class="flink" href="video.html?doc=${encodeURIComponent(docId)}&t=${sp.start}" `
      + `target="_blank" rel="noopener" data-source-kind="time" data-source-value="${sp.start}" `
      + `title="在视频课堂中跳到该时间点">🎬 视频 ${esc(fmtMs(sp.start))}</a>`;
  }
  const label = sp.kind === 'page' ? `📖 原文 ${fmtSpan(sp)}`
    : sp.kind === 'slide' ? `📄 ${fmtSpan(sp)}` : `📃 ${fmtSpan(sp)}`;
  return `<a class="flink" href="${esc(Api.fileUrl(docId, sp.kind === 'page' ? sp.start : ''))}" `
    + `target="_blank" rel="noopener" data-source-kind="${esc(sp.kind)}" data-source-value="${esc(String(sp.start))}" `
    + `title="在原始文件中定位（PDF 用 #page=N）">${esc(label)}</a>`;
}

function kindZh(k) {
  return {
    sql_statement: 'SQL 语句', sql_clause: 'SQL 子句', function: '函数', operator: '运算符',
    data_type: '数据类型', system_variable: '系统变量', status_variable: '状态变量',
    command_line_option: '命令行选项', client_program: '客户端程序', server_program: '服务端程序',
    utility_program: '工具程序', storage_engine: '存储引擎', plugin: '插件', component: '组件',
    log_sink: '日志接收器', log_filter: '日志过滤器', table: '表', schema_object: '模式对象',
    concept: '概念', mechanism: '机制', file: '文件', protocol: '协议', other: '其他',
  }[k] || k;
}
function usageZh(u) {
  return { user_invoked: '用户主动调用', server_automatic: '服务器自动', both: '两者皆可', internal: '内部使用', unknown: '未知' }[u] || u;
}
function roleUsageZh(r) {
  return {
    feature: '功能', maintenance: '维护', performance: '性能', security: '安全', diagnostics: '诊断',
    replication: '复制', storage: '存储', configuration: '配置', unknown: '未知',
  }[r] || r;
}
function lifecycleZh(l) {
  return {
    install_then_use: '先安装后使用', set_runtime: '运行时设置（重启失效）', set_persistent: '持久化设置',
    option_file: '配置文件', builtin: '内置', unknown: '未知',
  }[l] || l;
}

/* ---------------- 渲染：内嵌图谱（用户核心要求） ---------------- */

let subGraphEngine = null;

function subGraphPanelHTML() {
  return `<div class="graph-panel" id="subgraph-panel" data-kind="wiki-embedded">
    <div class="gp-head">
      <b>本单元知识图谱（内嵌局部子图）</b>
      <span class="small muted" id="sg-counts">—</span>
      <span class="right"></span>
      <button id="sg-relayout" type="button">重新布局</button>
      <button id="sg-fit" type="button">适应画布</button>
      <a class="nav-link" id="sg-open-full" href="graph.html" target="_blank" rel="noopener">在完整图谱中打开 ↗</a>
      <button id="sg-toggle" type="button">折叠</button>
    </div>
    <div class="gp-body" id="sg-body">
      <div class="gp-canvas-wrap"><canvas id="sg-canvas" height="360"></canvas></div>
      <div class="gp-side">
        <div class="small muted">节点（点击跳转到对应卡片；灰色 = 暂无卡片）</div>
        <div class="node-chips" id="sg-nodes"></div>
        <div class="small muted" style="margin-top:10px">边（etype · 证据）</div>
        <div id="sg-edges" class="small"></div>
      </div>
    </div>
    <div class="gp-legend" id="sg-legend"></div>
  </div>`;
}

/** 实体 → 卡片：按 name_key / name_zh 两种口径找（契约 §3 的 name_key 规范化）。 */
function nodeToCard(n) {
  if (!S.nameIndex) return null;
  const keys = [nameKey(n.name), nameKey(n.name_zh)].filter(Boolean);
  for (const k of keys) {
    const id = S.nameIndex.byKey.get(k);
    if (id) return S.cardsById.get(id) || null;
  }
  return null;
}

async function renderSubGraph(unitId) {
  const panel = qs('#subgraph-panel');
  if (!panel) return;
  if (!S.graph) {
    try {
      S.graph = await Api.graph(S.docId);
    } catch (e) {
      qs('#sg-counts').textContent = `图谱数据不可用：${e.message}`;
      return;
    }
  }
  const unit = outlineNode(unitId) || {};
  const unitIds = [unitId];
  // 兄弟/子节点也纳入种子：父级章节要看得到整章的知识点
  (unit.children || []).slice(0, 40).forEach((c) => unitIds.push(c));
  const focusCard = S.cardId ? S.cardsById.get(S.cardId) : null;
  const focusId = focusCard ? entityIdForCard(focusCard) : null;
  // 兜底种子：/graph 万一没给 unit_ids（契约 §5.2 的节点字段），用本单元卡片名反查实体
  const fallbackSeeds = S.cards.filter((c) => cardUnitId(c) === unitId)
    .map((c) => entityIdForCard(c)).filter(Boolean);
  const sub = localSubgraph(S.graph, { unitIds, seedIds: fallbackSeeds, focusId, hops: 1, maxNodes: 160 });
  S.subGraph = sub;

  const hasCards = sub.nodes.some((n) => nodeToCard(n));
  qs('#sg-counts').textContent = `${sub.nodes.length} 节点 / ${sub.edges.length} 边`
    + (sub.seed_count ? `（单元内种子 ${sub.seed_count} + 一跳邻居）` : '')
    + (hasCards ? `，可跳转卡片 ${sub.nodes.filter((n) => nodeToCard(n)).length}` : '');
  const cvs = qs('#sg-canvas');
  if (subGraphEngine) { subGraphEngine.destroy(); subGraphEngine = null; }
  if (sub.nodes.length) {
    subGraphEngine = new ForceGraph(cvs, {
      height: 360, labels: 'auto', labelMinDegree: 1, maxLabels: 60, maxTicks: 260, ticksPerFrame: 2,
      onNodeClick: (n) => {
        const card = nodeToCard(n);
        if (card) gotoCard(card.id);
        else selectSubNode(n.id);
      },
    });
    subGraphEngine.setData(sub.nodes, sub.edges);
    subGraphEngine.start();
    subGraphEngine.zoomToFit();
  } else {
    const ctx = cvs.getContext('2d');
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    qs('#sg-counts').textContent = hasCards
      ? '本节暂无图谱实体（该单元还没有抽取到实体）'
      : '本节暂无图谱实体（该单元还没有抽取到实体）';
  }
  renderSubNodeList(sub);
  renderSubEdgeList(sub);
  qs('#sg-open-full').href = `graph.html?doc=${encodeURIComponent(S.docId)}&unit=${encodeURIComponent(unitId)}`
    + (focusId ? `&focus=${encodeURIComponent(focusId)}` : '');
  qs('#sg-legend').innerHTML = legendHTML(legendItemsFor(sub));
  panel.dataset.nodes = String(sub.nodes.length);
  panel.dataset.edges = String(sub.edges.length);
  panel.dataset.seedUnits = String(sub.seed_count || 0);
  panel.dataset.seedSource = String(sub.seed_source || 'none');
  panel.dataset.flagged = String(sub.edges.filter((e) => e.flagged).length);
}

function legendItemsFor(sub) {
  const types = new Set(sub.nodes.map((n) => n.type).filter(Boolean));
  const etypes = new Set(sub.edges.map((e) => e.etype).filter(Boolean));
  const items = [];
  for (const t of types) items.push({ kind: 'dot', color: typeColor(t), label: typeZh(t) });
  for (const e of etypes) items.push({ kind: 'line', color: etypeColor(e), label: etypeZh(e) });
  if (sub.edges.some((e) => e.flagged)) {
    items.push({ kind: 'line', color: '#ffffff', dashed: true, label: 'flagged（因果可疑，虚线标记不删除）' });
  }
  return items;
}

function renderSubNodeList(sub) {
  const box = qs('#sg-nodes');
  if (!box) return;
  box.innerHTML = sub.nodes.slice().sort((a, b) => b.degree - a.degree).map((n) => {
    const card = nodeToCard(n);
    const label = n.name_zh || n.name;
    const color = typeColor(n.type);
    if (card) {
      return `<a class="node-chip" href="#card-${esc(card.id)}" data-node-id="${esc(n.id)}" `
        + `data-goto-card="${esc(card.id)}" title="${esc(n.name)} · ${esc(cardUnitTitle(card))}">`
        + `<i style="background:${esc(color)}"></i>${esc(label)}<span class="faint"> ${n.degree}</span></a>`;
    }
    return `<span class="node-chip" data-node-id="${esc(n.id)}" data-no-card="1" `
      + `title="${esc(n.name)}（本图谱无同名知识卡片）"><i style="background:${esc(color)}"></i>${esc(label)}<span class="faint"> ${n.degree}</span></span>`;
  }).join('') || '<span class="faint small">（无节点）</span>';
}

function renderSubEdgeList(sub) {
  const box = qs('#sg-edges');
  if (!box) return;
  const nm = new Map(sub.nodes.map((n) => [n.id, n.name_zh || n.name]));
  box.innerHTML = sub.edges.slice(0, 40).map((e) => {
    const flag = e.flagged ? ' <span class="pill bad" style="font-size:9px">flagged</span>' : '';
    return `<div class="edge-row" data-etype="${esc(e.etype)}">`
      + `<span class="etype" style="border-color:${esc(etypeColor(e.etype))}">${esc(etypeZh(e.etype))}</span>`
      + `<span>${esc(nm.get(e.src) || e.src)} →</span><span>${esc(nm.get(e.dst) || e.dst)}</span>${flag}`
      + (e.evidence ? `<div class="evidence" style="flex-basis:100%">${esc(e.evidence.slice(0, 160))}</div>` : '')
      + '</div>';
  }).join('') || '<span class="faint small">（无边）</span>';
}

function cardUnitTitle(c) {
  const u = S.units.get(cardUnitId(c));
  return u ? (u.title || '') : '';
}

function entityIdForCard(c) {
  if (!S.graph) return null;
  const k = nameKey(c.name);
  const hit = (S.graph.nodes || []).find((n) => nameKey(n.name) === k || nameKey(n.name_zh) === k);
  return hit ? String(hit.id) : null;
}

function selectSubNode(id) {
  qsa('#sg-nodes .node-chip').forEach((el) => el.classList.toggle('hl', el.dataset.nodeId === id));
  if (subGraphEngine) { subGraphEngine.select(id); }
}

/* ---------------- 迷你关系图（卡片级） ---------------- */

function toggleMiniGraph(cardId, host) {
  const open = !host.classList.contains('hidden');
  if (open) { host.classList.add('hidden'); return; }
  host.classList.remove('hidden');
  if (host.dataset.rendered === '1') return;
  const sub = cardNeighborhood(cardId, S.xrefs, S.cardsById, 26);
  const cv = document.createElement('canvas');
  cv.height = 220;
  host.appendChild(cv);
  const info = document.createElement('div');
  info.className = 'small muted';
  info.textContent = `关系图：${sub.nodes.length} 节点 / ${sub.edges.length} 边`
    + (sub.edges.some((e) => e.etype === 'typed') ? '（含类型化关系）' : '');
  host.appendChild(info);
  const fg = new ForceGraph(cv, {
    height: 220, labels: 'all', maxLabels: 30, maxTicks: 200,
    colorBy: 'type', onNodeClick: (n) => { if (n.id !== cardId) gotoCard(n.id); },
  });
  fg.setData(sub.nodes, sub.edges);
  fg.start();
  fg.zoomToFit();
  host.dataset.rendered = '1';
  host.dataset.nodes = String(sub.nodes.length);
  S.miniGraphs.set(cardId, fg);
}

/* ---------------- 卡片区渲染 ---------------- */

function renderCards(unitId) {
  const cards = S.cards.filter((c) => cardUnitId(c) === unitId);
  if (!cards.length) {
    return `<div class="panel"><h3 style="margin-top:0">知识点</h3>
      <div class="note info">本节暂无知识卡片。按 F3 要求，**无知识点的节点也必须给出 intro**（§5.2 的 <code>intro</code> 字段）——
      上方概括区的内容即来自该字段，不是留白。</div></div>`;
  }
  const sortKey = (c) => {
    const sp = cardSpan(c);
    return sp ? Number(sp.start || 0) : 0;
  };
  cards.sort((a, b) => sortKey(a) - sortKey(b) || String(a.name).localeCompare(String(b.name)));
  return `<div class="panel" id="cards-panel" data-unit="${esc(unitId)}" data-card-count="${cards.length}">
    <h3 style="margin-top:0">知识点卡片（${cards.length}）</h3>
    <div class="small muted" style="margin-bottom:8px">五要素：是什么 / 能做什么 / 示例（+说明）/ 前提 / 注意。括号内为引用与反链。</div>
    ${cards.map(cardHTML).join('')}
  </div>`;
}

function renderChildren(unitId) {
  const n = outlineNode(unitId);
  const kids = (n && n.children) || [];
  if (!kids.length) return '';
  return `<div class="panel"><h3 style="margin-top:0">子节（${kids.length}）</h3><div id="children-list">`
    + kids.map((c) => {
      const cn = outlineNode(c);
      if (!cn) return '';
      return `<div class="gnode-row" data-unit-link="${esc(c)}" style="cursor:pointer">`
        + `<span class="pill">L${esc(String(cn.level || ''))}</span>`
        + `<span style="flex:1">${esc(cn.title || c)}</span>`
        + nodeBadges(cn)
        + (cn.span ? `<span class="faint mono tiny">${esc(fmtSpan(cn.span))}</span>` : '')
        + '</div>';
    }).join('') + '</div></div>';
}

/* ---------------- 主渲染 ---------------- */

async function openUnit(unitId, opts) {
  const o = opts || {};
  const n = outlineNode(unitId);
  if (!n) {
    qs('#view').innerHTML = `<div class="panel"><div class="note bad">单元 ${esc(unitId)} 不在 /outline 中</div></div>`;
    return;
  }
  S.unitId = unitId;
  if (o.card) S.cardId = o.card;
  ensureUnitsIndex();
  qs('#view').innerHTML = sectionHeaderHTML(n, unitId)
    + subGraphPanelHTML()
    + renderChildren(unitId)
    + renderCards(unitId)
    + '<div class="panel" id="selftest-panel"></div>';
  bindViewEvents();
  selectTreeRow(unitId);
  revealTreePath(unitId);
  await renderSubGraph(unitId);
  if (S.cardId) highlightCard(S.cardId);
  const hash = `#doc=${encodeURIComponent(S.docId)}&unit=${encodeURIComponent(unitId)}`
    + (S.cardId ? `&card=${encodeURIComponent(S.cardId)}` : '');
  if (o.push !== false) history.replaceState(null, '', hash);
  window.scrollTo({ top: 0, behavior: o.smooth ? 'smooth' : 'auto' });
}

function ensureUnitsIndex() {
  if (S.units.size && S._unitsDoc === S.docId) return;
  S.units = new Map();
  const nodes = (S.outline && S.outline.nodes) || {};
  for (const [id, n] of Object.entries(nodes)) {
    S.units.set(id, { id, title: n.title, level: n.level, span: n.span, parent_id: S._parentMap ? S._parentMap.get(id) : null });
  }
  S._unitsDoc = S.docId;
}

function highlightCard(cardId) {
  const el = qs(`#view .kcard[data-card="${cssEsc(cardId)}"]`);
  qsa('#view .kcard.hl').forEach((x) => x.classList.remove('hl'));
  if (!el) return false;
  el.classList.add('hl');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => el.classList.remove('hl'), 4000);
  return true;
}

/** 跳到某张卡片：先切到它所在的单元，再高亮。 */
async function gotoCard(cardId) {
  const c = S.cardsById.get(cardId);
  if (!c) {
    qs('#view').insertAdjacentHTML('afterbegin', `<div class="note warn">找不到卡片 ${esc(cardId)}</div>`);
    return false;
  }
  const uid = cardUnitId(c);
  S.cardId = cardId;
  if (uid && uid !== S.unitId) {
    await openUnit(uid, { card: cardId, push: true });
    return true;
  }
  return highlightCard(cardId);
}

/** #view 上的委托监听只绑一次 —— 早期每轮 openUnit 都 bind 一次，
 *  多次跳转后同一个点击会触发 N 次（迷你关系图被连点两次又收起来了，实测踩过）。 */
let viewBound = false;

function bindViewEvents() {
  const view = qs('#view');
  if (!viewBound) {
    viewBound = true;
    // 交叉引用 / 正文内链：事件委托（与 wiki_v2 同做法，避免逐卡片绑定）
    bindGoto(view, (id) => { gotoCard(id); });
    view.addEventListener('click', (ev) => {
      const ul = ev.target.closest ? ev.target.closest('[data-unit-link]') : null;
      if (ul) { ev.preventDefault(); openUnit(ul.getAttribute('data-unit-link')); return; }
      const mt = ev.target.closest ? ev.target.closest('.mini-toggle') : null;
      if (mt) {
        const id = mt.getAttribute('data-mini');
        const host = qs(`#view [data-mini-host="${cssEsc(id)}"]`);
        if (host) toggleMiniGraph(id, host);
      }
    });
  }
  // 下面这些按钮每轮渲染都会重建 → 每次重新绑定
  const fit = qs('#sg-fit');
  if (fit) fit.addEventListener('click', () => subGraphEngine && subGraphEngine.zoomToFit());
  const re = qs('#sg-relayout');
  if (re) re.addEventListener('click', () => {
    if (!subGraphEngine) return;
    subGraphEngine.relayout(); subGraphEngine.start();
  });
  const tg = qs('#sg-toggle');
  if (tg) tg.addEventListener('click', () => {
    const body = qs('#sg-body');
    const legend = qs('#sg-legend');
    const hidden = body.classList.toggle('hidden');
    legend.classList.toggle('hidden', hidden);
    tg.textContent = hidden ? '展开' : '折叠';
    if (!hidden && subGraphEngine) { subGraphEngine.resize(); subGraphEngine.zoomToFit(); }
  });
}

/* ---------------- 树交互 ---------------- */

function bindTree() {
  const mount = qs('#tree');
  mount.addEventListener('click', (ev) => {
    const row = ev.target.closest('.trow');
    if (!row) return;
    const li = row.parentElement;
    if (ev.target.classList.contains('tw') && li.querySelector(':scope > .tree-children')) {
      const box = li.querySelector(':scope > .tree-children');
      if (box.classList.contains('open')) collapseNode(li); else expandNode(li);
      return;
    }
    const id = row.dataset.unit;
    if (!id) return;
    if (li.querySelector(':scope > .tree-children')) expandNode(li);
    openUnit(id);
  });
  qs('#tree-expand').addEventListener('click', () => {
    qsa('#tree li').forEach((li) => { if (li.querySelector(':scope > .tree-children') && li.offsetTop < 4000) expandNode(li); });
  });
  qs('#tree-collapse').addEventListener('click', () => qsa('#tree li').forEach(collapseNode));
  const f = qs('#tree-filter');
  f.addEventListener('input', debounce(() => {
    S.treeFilter = f.value.trim().toLowerCase();
    if (!S.treeFilter) { renderTree(); return; }
    renderFlatMatches(S.treeFilter);
  }, 200));
}

/** 过滤：扁平列出匹配节点（含祖先路径），避免在 2458 节点树里挖。 */
function renderFlatMatches(q) {
  const nodes = (S.outline && S.outline.nodes) || {};
  const hits = [];
  for (const [id, n] of Object.entries(nodes)) {
    if ((n.title || '').toLowerCase().includes(q)) hits.push([id, n]);
    if (hits.length >= 300) break;
  }
  qs('#tree').innerHTML = hits.length
    ? `<div class="small muted" style="padding:4px 6px">匹配 ${hits.length} 个节点</div>`
      + hits.map(([id, n]) => treeRowHTML(n, id)).join('')
    : '<div class="loading">无匹配节点</div>';
}

/* ---------------- 检索 ---------------- */

async function doSearch(q) {
  const box = qs('#search-results');
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = '<div class="loading">检索中…</div>';
  try {
    const r = await Api.search(q, { doc_id: S.docId, limit: 20 });
    const hits = r.hits || [];
    box.innerHTML = `<div class="panel" style="margin:0 0 14px"><div style="display:flex;gap:8px;align-items:center">`
      + `<b>检索「${esc(q)}」</b><span class="pill">${Number(r.total != null ? r.total : hits.length)} 命中</span>`
      + `<button class="right" id="search-close" type="button">关闭</button></div>`
      + (hits.length ? hits.map((h) => {
        const kind = h.kind === 'card' ? '卡片' : '单元';
        return `<div class="hit" data-hit-kind="${esc(h.kind)}" data-hit-ref="${esc(h.ref_id)}">`
          + `<div><span class="pill ${h.kind === 'card' ? 'blue' : ''}">${kind}</span> <b>${esc(h.title || '')}</b>`
          + `<span class="faint mono tiny right"> score ${esc(String(h.score != null ? h.score : ''))}</span></div>`
          + `<div class="snip">${esc(h.snippet || '')}</div></div>`;
      }).join('') : '<div class="faint small" style="padding:8px">没有命中（中文检索走 bigram，见 F8）</div>')
      + '</div>';
    qs('#search-close').addEventListener('click', () => box.classList.add('hidden'));
    box.addEventListener('click', (ev) => {
      const hit = ev.target.closest('.hit');
      if (!hit) return;
      const ref = hit.dataset.hitRef;
      if (hit.dataset.hitKind === 'card') gotoCard(ref);
      else openUnit(ref);
    });
  } catch (e) {
    box.innerHTML = `<div class="note bad">检索失败：${esc(e.message)}</div>`;
  }
}

/* ---------------- 启动 ---------------- */

async function loadDocument(docId) {
  S.docId = docId;
  S.outline = await Api.outline(docId);
  buildParentMap();
  ensureUnitsIndex();
  const cardsRes = await loadAllCards(docId);
  S.cards = cardsRes.items.map((c) => Object.assign({}, c));
  S.cardsById = new Map(S.cards.map((c) => [c.id, c]));
  S.nameIndex = buildNameIndex(S.cards);
  try {
    const xs = await loadAllXrefs(docId);
    S.xrefs = buildXrefIndex(xs, S.cardsById);
  } catch (e) {
    S.xrefs = { out: new Map(), in: new Map() };
  }
  S.graph = null;
  S.miniGraphs.clear();
  if (subGraphEngine) { subGraphEngine.destroy(); subGraphEngine = null; }
  updateHeaderStats(cardsRes.total);
  renderTree();
}

function updateHeaderStats(total) {
  const n = qs('#doc-stats');
  if (!n) return;
  const nc = Number(total != null ? total : S.cards.length);
  n.textContent = `${S.doc.title || S.docId} · ${Object.keys((S.outline && S.outline.nodes) || {}).length} 单元 · ${nc} 卡片`;
}

async function boot() {
  try {
    const caps = await loadCaps();
    S.caps = caps.summary;
    renderCapChips(qs('#caps'), caps.summary);
    if (!caps.ok) {
      qs('#offline').classList.remove('hidden');
      qs('#offline').innerHTML = `<b>后端不可用</b> · ${esc(caps.error ? caps.error.message : '')}`
        + `<div class="small">${esc(caps.error && caps.error.hint || '启动 server.main:app 后刷新')}</div>`;
    }
    // 能力门控：pi 不可用 → 禁用 AI 助教入口并说明原因（F7 降级路径 C）
    const chat = qs('#nav-chat');
    applyGate(chat, caps.summary.pi.ok, caps.summary.pi.reason);
    if (!caps.summary.pi.ok) { chat.setAttribute('aria-disabled', 'true'); chat.dataset.disabledNav = '1'; }
    chat.addEventListener('click', (ev) => { if (chat.dataset.disabledNav) ev.preventDefault(); });

    const docsRes = await Api.documents({ limit: 100 });
    S.docs = docsRes.items || docsRes.documents || [];
    if (!S.docs.length) {
      qs('#view').innerHTML = '<div class="panel"><div class="note info">还没有文档。先 POST /api/v1/documents 上传（PDF/PPTX/DOCX/文本/视频），'
        + '解析与抽取完成后再回到本页。</div></div>';
      return;
    }
    const sel = qs('#doc-select');
    sel.innerHTML = S.docs.map((d) => `<option value="${esc(d.id)}">${esc(d.title)}（${esc(d.kind)}）</option>`).join('');
    const wantDoc = P.get('doc');
    const chosen = S.docs.find((d) => d.id === wantDoc)
      || S.docs.find((d) => d.kind !== 'video' && d.status === 'ready')
      || S.docs[0];
    sel.value = chosen.id;
    S.doc = chosen;
    sel.addEventListener('change', async () => {
      S.doc = S.docs.find((d) => d.id === sel.value) || S.docs[0];
      S.cardId = null; S.unitId = null;
      await loadDocument(S.doc.id);
      const roots = (S.outline && S.outline.roots) || [];
      if (roots.length) await openUnit(roots[0]);
    });
    await loadDocument(chosen.id);

    bindTree();
    qs('#search-form').addEventListener('submit', (ev) => { ev.preventDefault(); doSearch(qs('#search-input').value.trim()); });
    qs('#search-input').addEventListener('input', debounce(() => {
      const v = qs('#search-input').value.trim();
      if (v.length >= 2) doSearch(v); else qs('#search-results').classList.add('hidden');
    }, 350));

    const roots = (S.outline && S.outline.roots) || [];
    const wantUnit = P.get('unit');
    const unitId = (wantUnit && outlineNode(wantUnit)) ? wantUnit : roots[0];
    if (unitId) await openUnit(unitId, { card: P.get('card') || null });

    if (P.get('q')) { qs('#search-input').value = P.get('q'); doSearch(P.get('q')); }

    // 无头验证入口（headless Chrome 用 --dump-dom 只能看 DOM，看不到 canvas）
    if (P.get('selftest') === '1') await runSelftest();
    writeJsonScript('boot-report', {
      ok: true, doc: S.docId, unit: S.unitId, cards: S.cards.length,
      caps_asr: S.caps.asr.ok, caps_pi: S.caps.pi.ok,
      xrefs: Array.from(S.xrefs.out.values()).reduce((a, b) => a + b.length, 0),
      units: Object.keys((S.outline && S.outline.nodes) || {}).length,
      load_ms: Math.round(performance.now() - T_LOAD0),
    });
  } catch (e) {
    showFatal(e.message || String(e), e.detail || (e.stack || ''));
    writeJsonScript('boot-report', { ok: false, error: e.message, code: e.code || '' });
  } finally {
    await testBarrierDone();
  }
}

/* ---------------- 自检（headless Chrome 断言用） ---------------- */

async function runSelftest() {
  const R = { checks: {}, ok: true };
  const rec = (k, v) => { R.checks[k] = v; };
  await new Promise((r) => setTimeout(r, 700));    // 等力导向图收敛一点，便于统计

  rec('caps_loaded', !!S.caps);
  rec('docs', S.docs.length);
  rec('tree_rows', qsa('#tree .trow').length);
  rec('empty_badges', qsa('#tree .badge-empty').length);
  rec('card_badges', qsa('#tree .badge-cards').length);
  qs('#tree-expand').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 200));
  rec('tree_rows_expanded', qsa('#tree .trow').length);
  rec('empty_badges_expanded', qsa('#tree .badge-empty').length);
  rec('section_unit', S.unitId);
  rec('section_title', (qs('.sec-title') || {}).textContent || '');
  rec('cards_rendered', qsa('#view .kcard').length);
  rec('inner_links', qsa('#view a.inner').length);
  rec('xref_groups', qsa('#view .xref-h[data-rel]').length);
  rec('backlink_groups', qsa('#view .xref-h[data-rel="backlinks"]').length);
  rec('source_links', qsa('#view .kfoot [data-source-kind]').length);
  const srcA = qs('#view .kfoot a.flink[data-source-kind]');
  rec('source_href_sample', srcA ? srcA.getAttribute('href') : '');
  rec('flagged_note', !!qs('#sg-legend .legend-line.dashed'));
  rec('seed_source', (qs('#subgraph-panel') || { dataset: {} }).dataset.seedSource || '');
  rec('subgraph_nodes', Number((qs('#subgraph-panel') || {}).dataset ? qs('#subgraph-panel').dataset.nodes : 0));
  rec('subgraph_edges', Number((qs('#subgraph-panel') || {}).dataset ? qs('#subgraph-panel').dataset.edges : 0));
  rec('subgraph_chips', qsa('#sg-nodes .node-chip').length);
  rec('subgraph_clickable_chips', qsa('#sg-nodes .node-chip[data-goto-card]').length);
  const sg = subGraphEngine ? subGraphEngine.stats() : null;
  rec('subgraph_engine', sg);

  // ① 内嵌图谱节点点击 → 跳到该卡片（走的是真实 click 事件）
  const chip = qs('#sg-nodes .node-chip[data-goto-card]');
  if (chip) {
    const target = chip.getAttribute('data-goto-card');
    const beforeUnit = S.unitId;
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 500));
    const hl = qs(`#view .kcard.hl[data-card="${cssEsc(target)}"]`);
    rec('subgraph_click', {
      target, unit_before: beforeUnit, unit_after: S.unitId,
      unit_changed: beforeUnit !== S.unitId,
      highlighted: !!hl,
    });
    rec('subgraph_click_ok', !!(hl || qs(`#view .kcard[data-card="${cssEsc(target)}"]`)));
  } else {
    rec('subgraph_click', { skipped: 'no clickable chip' });
    rec('subgraph_click_ok', false);
  }

  // ②a 跨节引用跳转：找一个「目标卡片在别的单元」的引用锚点，真实点击
  const crossAnchor = qsa('#view a.xr[data-goto-card]').find((a) => {
    const c = S.cardsById.get(a.dataset.gotoCard);
    return c && cardUnitId(c) !== S.unitId;
  });
  if (crossAnchor) {
    const target = crossAnchor.getAttribute('data-goto-card');
    const tcard = S.cardsById.get(target);
    const beforeUnit = S.unitId;
    crossAnchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 500));
    const hl = qs(`#view .kcard.hl[data-card="${cssEsc(target)}"]`);
    rec('xref_cross_unit_click', {
      target, target_unit: tcard ? cardUnitId(tcard) : null, unit_before: beforeUnit, unit_after: S.unitId,
      unit_changed: beforeUnit !== S.unitId, highlighted: !!hl,
    });
    rec('xref_cross_unit_ok', beforeUnit !== S.unitId && !!hl);
  } else {
    rec('xref_cross_unit_click', { skipped: 'no cross-unit anchor in view' });
    rec('xref_cross_unit_ok', false);
  }

  // ②b 交叉引用跳转（内嵌图谱点击后可能已换节 → 若无引用锚点先回到有引用的那节）
  let xref = qs('#view a.xr[data-goto-card]');
  if (!xref) {
    const unitWithXref = S.cards.find((c) => (S.xrefs.out.get(c.id) || []).length
      && qsa('#tree .trow').some((r) => r.dataset.unit === cardUnitId(c)));
    if (unitWithXref) {
      await openUnit(cardUnitId(unitWithXref), { push: false });
      await new Promise((r) => setTimeout(r, 300));
      xref = qs('#view a.xr[data-goto-card]');
    }
  }
  if (xref) {
    const target = xref.getAttribute('data-goto-card');
    const tcard = S.cardsById.get(target);
    const beforeUnit = S.unitId;
    xref.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 500));
    const hl = qs(`#view .kcard.hl[data-card="${cssEsc(target)}"]`);
    rec('xref_click', {
      target, target_unit: tcard ? cardUnitId(tcard) : null,
      unit_before: beforeUnit, unit_after: S.unitId,
      cross_unit: !!(tcard && cardUnitId(tcard) !== beforeUnit),
      highlighted: !!hl,
    });
    rec('xref_click_ok', !!hl);
  } else {
    rec('xref_click', { skipped: 'no xref anchor' });
    rec('xref_click_ok', false);
  }

  // ③ 检索
  try {
    const q = (S.cards[0] && S.cards[0].name ? String(S.cards[0].name).slice(0, 4) : '索引');
    const r = await Api.search(q, { doc_id: S.docId, limit: 10 });
    rec('search_q', q);
    rec('search_hits', (r.hits || []).length);
    rec('search_ok', (r.hits || []).length > 0);
  } catch (e) { rec('search_ok', false); rec('search_error', e.message); }

  // ④ 能力门控状态
  rec('chat_gate_disabled', qs('#nav-chat').getAttribute('aria-disabled') === 'true'
    || qs('#nav-chat').classList.contains('disabled'));
  rec('chat_gate_reason', qs('#nav-chat').dataset.gateReason || '');

  // ⑤ 卡片级迷你关系图（F5：卡片内迷你关系图）
  const mt = qs('#view .mini-toggle');
  if (mt) {
    mt.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 400));
    const host = qs(`#view [data-mini-host="${cssEsc(mt.getAttribute('data-mini'))}"]`);
    rec('mini_graph', {
      shown: !!host && !host.classList.contains('hidden'),
      canvas: !!host && !!host.querySelector('canvas'),
      nodes: host ? Number(host.dataset.nodes || 0) : 0,
    });
    rec('mini_graph_ok', !!host && !host.classList.contains('hidden') && !!host.querySelector('canvas'));
  } else {
    rec('mini_graph', { skipped: 'no mini toggle' });
    rec('mini_graph_ok', false);
  }

  // ⑥ C8 原文跳转：视频时间戳必须给出 video.currentTime 跳转
  const timeLink = sourceLinkHTML({ id: 'x', name: 'x' }, { kind: 'time', start: 754000, end: 760000 });
  rec('time_source_href', timeLink.replace(/&amp;/g, '&'));
  rec('time_source_ok', /video\.html\?doc=.*&t=754000/.test(timeLink.replace(/&amp;/g, '&')));
  const noneLink = sourceLinkHTML({ id: 'y', name: 'y' }, null);
  rec('missing_span_honest', /原文位置缺失/.test(noneLink));

  const flat = [
    R.checks.tree_rows > 0,
    R.checks.tree_rows_expanded >= R.checks.tree_rows,
    R.checks.empty_badges_expanded > 0,
    R.checks.cards_rendered > 0,
    R.checks.subgraph_nodes > 0,
    R.checks.subgraph_engine && R.checks.subgraph_engine.drawn_nodes > 0,
    R.checks.subgraph_click_ok === true,
    R.checks.xref_cross_unit_ok === true,
    R.checks.xref_click_ok === true,
    R.checks.mini_graph_ok === true,
    R.checks.time_source_ok === true,
    R.checks.search_ok === true,
  ];
  R.ok = flat.every(Boolean);
  R.failed = flat.filter((x) => !x).length;
  const p = qs('#selftest-panel');
  if (p) p.innerHTML = `<h3 style="margin-top:0">自检（?selftest=1）</h3><pre>${esc(JSON.stringify(R.checks, null, 2))}</pre>`;
  writeJsonScript('selftest-report', R);
  return R;
}

/* 坑 9：boot 的调用时机 —— DOMContentLoaded 或脚本末尾。
   早期写法是在 <head> 里直接 boot()，DOM 还不存在 → "Cannot read properties of undefined"。 */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
