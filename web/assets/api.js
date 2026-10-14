/* ==========================================================================
   api.js —— REST 客户端（契约 docs/API_PROTOCOL.md §5，字段唯一权威）
   --------------------------------------------------------------------------
   坑 8：file:// 下 fetch 被 CORS 拦 → 本 UI 一律走 **同源 HTTP**（相对路径 /api/v1）。
        （早先的写法是 fetch 绝对地址 + 内联数据兜底，等于两套口径；现统一同源。）
   ========================================================================== */

import { esc, qs } from './util.js';

/** 接口前缀：默认同源 /api/v1；?api=... 可指向别的后端（联调/测试用）。 */
export const API_BASE = (new URLSearchParams(location.search).get('api') || '/api/v1').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(code, msg, status, detail, hint) {
    super(msg || code || '请求失败');
    this.code = code || 'E_UNKNOWN';
    this.status = status || 0;
    this.detail = detail || '';
    this.hint = hint || '';
  }
}

function qstr(params) {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? '?' + s : '';
}

export async function req(path, params, init) {
  const url = API_BASE + path + qstr(params);
  let res;
  try {
    res = await fetch(url, Object.assign({ headers: { Accept: 'application/json' } }, init));
  } catch (e) {
    // 后端没起来：给出可操作的说明，而不是 "Failed to fetch"
    throw new ApiError('E_NETWORK', `无法连接后端 ${url}`, 0,
      String(e && e.message || e), '请先启动 server.main:app（默认 127.0.0.1:8787）');
  }
  const text = await res.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch (e) { body = { raw: text }; } }
  if (!res.ok) {
    const err = (body && body.error) || {};
    throw new ApiError(err.code || 'E_HTTP' + res.status, err.msg || `HTTP ${res.status}`,
      res.status, err.detail || '', err.hint || '');
  }
  return body;
}

/** 契约 §5.1 健康与能力。UI 必须据此渲染（§9：不许假设功能一定在）。 */
export const Api = {
  capabilities: () => req('/capabilities'),
  health: () => req('/health'),

  documents: (p) => req('/documents', p),
  document: (id) => req(`/documents/${encodeURIComponent(id)}`),
  outline: (id) => req(`/documents/${encodeURIComponent(id)}/outline`),
  units: (id, p) => req(`/documents/${encodeURIComponent(id)}/units`, p),
  cards: (id, p) => req(`/documents/${encodeURIComponent(id)}/cards`, p),
  graph: (id, p) => req(`/documents/${encodeURIComponent(id)}/graph`, p),
  xrefs: (id, p) => req(`/documents/${encodeURIComponent(id)}/xrefs`, p),

  card: (id) => req(`/cards/${encodeURIComponent(id)}`),
  cardXrefs: (id) => req(`/cards/${encodeURIComponent(id)}/xrefs`),
  cardBacklinks: (id) => req(`/cards/${encodeURIComponent(id)}/backlinks`),

  search: (q, p) => req('/search', Object.assign({ q }, p)),
  suggest: (q) => req('/search/suggest', { q }),

  video: (id) => req(`/documents/${encodeURIComponent(id)}/video`),
  videoTranscript: (id) => req(`/documents/${encodeURIComponent(id)}/video/transcript`),
  videoMindmap: (id) => req(`/documents/${encodeURIComponent(id)}/video/mindmap`),
  videoSlides: (id) => req(`/documents/${encodeURIComponent(id)}/video/slides`),
  videoReparse: (id, body) => req(`/documents/${encodeURIComponent(id)}/video/reparse`, null,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
  task: (id) => req(`/tasks/${encodeURIComponent(id)}`),

  /** 契约 §5.7 原始文件（PDF 用 #page=N 跳页）。 */
  fileUrl: (docId, page) => API_BASE + `/documents/${encodeURIComponent(docId)}/file`
    + (page ? `#page=${page}` : ''),
  streamUrl: (docId) => API_BASE + `/documents/${encodeURIComponent(docId)}/stream`,
  subtitleUrl: (docId, fmt) => API_BASE + `/documents/${encodeURIComponent(docId)}/video/subtitle?fmt=${fmt || 'vtt'}`,
  taskEventsUrl: (taskId) => API_BASE + `/tasks/${encodeURIComponent(taskId)}/events`,
};

/**
 * 分页拉全量卡片：/cards 响应含 total（§1.1 分页约定）。
 * 用 500/页把 total 拉完 —— 卡片是交叉引用与内嵌图谱的索引基础，必须全。
 */
export async function loadAllCards(docId, onProgress) {
  const first = await Api.cards(docId, { offset: 0, limit: 500 });
  const total = Number(first.total != null ? first.total : (first.items || first.cards || []).length);
  const items = (first.items || first.cards || []).slice();
  while (items.length < total) {
    const page = await Api.cards(docId, { offset: items.length, limit: 500 });
    const chunk = page.items || page.cards || [];
    if (!chunk.length) break;               // 防御：服务端 total 与实际不一致时不死循环
    items.push(...chunk);
    if (onProgress) onProgress(items.length, total);
  }
  return { items, total };
}

/** 拉全量交叉引用（一次请求换掉 N 次 /cards/{id} 详情，卡片区渲染更快）。 */
export async function loadAllXrefs(docId) {
  const r = await Api.xrefs(docId, { limit: 5000 });
  return r.items || r.xrefs || [];
}

/* ==========================================================================
   能力渲染（§5.1 + 坑 10）：不可用 → 禁用入口 + 说明原因，绝不假装可用
   ========================================================================== */

/** 把 capabilities 归一化成 UI 关心的布尔 + 原因文本。 */
export function capsSummary(caps) {
  const c = caps || {};
  const asr = c.asr || {};
  const pi = c.pi || {};
  const llm = c.llm || {};
  const ff = c.ffmpeg || {};
  return {
    raw: c,
    asr: {
      ok: asr.available === true,
      reason: asr.available === true
        ? `${asr.engine || 'ASR'} · ${(asr.models || []).join('/') || '默认模型'} · ${asr.device || 'cpu'}`
        : (asr.reason || 'ASR 引擎不可用（未安装 faster-whisper 或模型文件缺失）'),
    },
    pi: {
      ok: pi.available === true,
      reason: pi.available === true
        ? `pi ${pi.version || ''} (${pi.mode || 'rpc'})`
        : (pi.reason || 'pi 未构建且未全局安装（AGENTS.md §6 降级路径 C）'),
    },
    llm: {
      ok: llm.configured === true,
      reason: llm.configured === true
        ? `${llm.model || 'LLM'} 已配置`
        : (llm.reason || '未配置 LLM API 凭据，抽取/摘要不可用'),
    },
    ffmpeg: {
      ok: ff.available === true,
      reason: ff.available === true ? `ffmpeg ${ff.version || ''}`
        : (ff.reason || 'ffmpeg 不可用，抽音频/抽帧停摆'),
    },
    adapters: c.adapters || [],
  };
}

/** 顶栏能力芯片；不可用的芯片 title 里带原因（要求：禁用并说明原因）。 */
export function renderCapChips(container, summary) {
  if (!container) return;
  const rows = [
    ['ASR 字幕', summary.asr], ['pi 助教', summary.pi],
    ['LLM 抽取', summary.llm], ['ffmpeg', summary.ffmpeg],
  ];
  container.innerHTML = rows.map(([name, st]) => {
    const cls = st.ok ? 'ok' : 'off';
    const txt = st.ok ? '可用' : '不可用';
    return `<span class="cap-chip ${cls}" data-cap="${esc(name)}" data-available="${st.ok ? 'true' : 'false'}"`
      + ` title="${esc(name)}：${esc(st.reason)}"><i></i>${esc(name)} ${txt}</span>`;
  }).join('')
    + `<span class="cap-chip" title="已注册适配器">适配器 ${esc((summary.adapters || []).join('/') || '—')}</span>`;
}

/**
 * 能力门控：ok=false 时禁用元素 + 在旁插入说明（data-gate-reason 供测试断言）。
 * 返回说明节点。
 */
export function applyGate(el, ok, reason) {
  if (!el) return null;
  el.dataset.gateReason = ok ? '' : (reason || '不可用');
  if (ok) {
    el.removeAttribute('disabled');
    el.removeAttribute('aria-disabled');
    el.classList.remove('disabled');
    el.title = '';
  } else {
    el.setAttribute('disabled', 'disabled');
    el.setAttribute('aria-disabled', 'true');
    el.classList.add('disabled');
    el.title = reason || '不可用';
  }
  let note = el.parentElement ? el.parentElement.querySelector('.gate-note[data-for="' + el.id + '"]') : null;
  if (!ok) {
    if (!note && el.parentElement) {
      note = document.createElement('div');
      note.className = 'gate-note small';
      note.dataset.for = el.id;
      el.parentElement.insertBefore(note, el.nextSibling);
    }
    if (note) note.textContent = `不可用：${reason || '能力未就绪'}`;
  } else if (note) {
    note.remove();
  }
  return note;
}

/** 首页加载能力；失败不阻塞（但会显示离线横幅）。 */
export async function loadCaps() {
  try {
    const caps = await Api.capabilities();
    return { ok: true, summary: capsSummary(caps) };
  } catch (e) {
    return {
      ok: false,
      summary: capsSummary({}),
      error: e,
    };
  }
}
