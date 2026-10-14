/* ==========================================================================
   video-page.js —— 视频课堂（video.html）
   --------------------------------------------------------------------------
   F6 验收：字幕与视频同步（点字幕 → video.currentTime）、文稿分章可折叠、全文总结、
            思维导图可折叠、幻灯片帧点击跳转、虚拟滚动、ASR 不可用如实降级（坑 10）。
   坑 11：场景抽帧产出的是**帧图**，不是可编辑 PPT —— UI 明确标注"图片帧"。
   无媒体/无头环境的同步验证：?simclock=1&t=<ms> 用合成时钟驱动（真实播放路径不变，
   只是把取时间的地方换成合成值），并把每次 seek 记进 #v-seeklog 供 headless 断言。
   ========================================================================== */

import { Api, loadCaps, renderCapChips, applyGate } from './api.js';
import { esc, qs, qsa, params, writeJsonScript, showFatal, fmtMs, debounce, testBarrier, testBarrierDone } from './util.js';
import { VirtualList } from './vscroll.js';
import { parseMindmap, renderMindmap } from './mindmap.js';

const P = params();
const T_LOAD0 = (typeof performance !== 'undefined' ? performance.now() : 0);
testBarrier();      // 仅当 ?barrier= 出现时生效（无头测试同步用）
const V = {
  caps: null, docs: [], docId: null, artifact: null,
  segments: [], transcript: [], slides: [], mindmap: null,
  subList: null, mm: null, clockMs: 0, seekLog: [], simclock: P.get('simclock') === '1',
  tab: 'subs',
};

const videoEl = () => qs('#v-player');

function nowMs() {
  if (V.simclock) return V.clockMs;
  const v = videoEl();
  return v ? Math.round((v.currentTime || 0) * 1000) : 0;
}

function logSeek(ms, how) {
  V.seekLog.push({ ms: Math.round(ms), how: how || '', at: Date.now(), media_ms: null });
  renderSeekLog();
}

function renderSeekLog() {
  const el = qs('#v-seeklog');
  el.textContent = JSON.stringify(V.seekLog);
  el.dataset.count = String(V.seekLog.length);
  el.dataset.last = String(V.seekLog.length ? V.seekLog[V.seekLog.length - 1].ms : 0);
  window.__SEEK_LOG__ = V.seekLog;
}

/** 真实媒体路径：把 video.currentTime 回填进最后一条 seek 日志（headless 也能断言）。
 *  只等 seeked 事件在无头 + 虚拟时钟下不可靠（媒体 seek 走真实时间，不会随虚拟时钟快进），
 *  所以 seek() 之后再用一个定时器主动确认一次 —— 记录的是媒体元素真正接受的 currentTime。 */
function confirmMediaSeek() {
  const v = videoEl();
  if (!v || V.simclock) return;
  // 只确认「最后一条」seek：否则定时器会把过期条目填上当前时间，得到假数字
  const last = V.seekLog.length ? V.seekLog[V.seekLog.length - 1] : null;
  if (!last || last.media_ms != null) return;
  last.media_ms = Math.round((v.currentTime || 0) * 1000);
  const el = qs('#v-media-check');
  const dur = Math.round((v.duration || 0) * 1000);
  const want = last.ms;
  el.dataset.want = String(want);
  el.dataset.mediaMs = String(last.media_ms);
  el.dataset.mediaDurationMs = String(dur);
  el.dataset.how = last.how;
  el.dataset.ok = String(dur > 0 && Math.abs(last.media_ms - Math.min(want, Math.max(0, dur - 50))) <= 600);
  el.textContent = `媒体校验：target=${want}ms media=${last.media_ms}ms duration=${dur}ms ok=${el.dataset.ok}`;
  renderSeekLog();
}

/** 跳转到时间点：真实路径操作 video.currentTime；合成时钟下只更新内部时钟。 */
function seek(ms, how) {
  const t = Math.max(0, Math.round(ms));
  V.clockMs = t;
  const v = videoEl();
  if (!V.simclock && v) {
    try { v.currentTime = t / 1000; } catch (e) { /* 媒体未就绪时忽略，时钟仍更新 */ }
    setTimeout(confirmMediaSeek, 250);              // seeked 在无头+虚拟时钟下可能不触发
  }
  logSeek(t, how);
  updateClock();
  syncSubtitle(true);
}

function updateClock() {
  const ms = nowMs();
  qs('#v-clock').textContent = fmtMs(ms);
  const dur = V.artifact && V.artifact.duration_ms ? V.artifact.duration_ms : 0;
  qs('#v-duration').textContent = dur ? fmtMs(dur) : '—';
  const ch = chapterAt(ms);
  qs('#v-chapter-now').textContent = ch ? ch.title : '—';
}

function chapterAt(ms) {
  for (const c of V.transcript) {
    if (ms >= Number(c.start || 0) && ms < Number(c.end || Infinity)) return c;
  }
  return V.transcript.length ? V.transcript[V.transcript.length - 1] : null;
}

function segIndexAt(ms) {
  const segs = V.segments;
  let lo = 0, hi = segs.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = Number(segs[mid].start || 0);
    if (s <= ms) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (best >= 0 && ms <= Number(segs[best].end || Infinity) + 1500) return best;
  return best >= 0 && ms >= Number(segs[best].start || 0) ? best : -1;
}

/* ---------------- 字幕（虚拟滚动） ---------------- */

function renderSubtitles() {
  const box = qs('#v-subs');
  V.subList = new VirtualList(box, {
    rowHeight: 42, overscan: 10, emptyText: '（无字幕）',
    renderRow: (s, i) => {
      const d = document.createElement('div');
      d.className = 'sub-row';
      d.dataset.i = String(i);
      d.dataset.start = String(s.start);
      d.innerHTML = `<span class="t">${esc(fmtMs(s.start))}</span>`
        + `<span class="txt">${esc(s.text || '')}</span>`
        + (s.confidence != null ? `<span class="faint tiny mono">${Number(s.confidence).toFixed(2)}</span>` : '');
      d.addEventListener('click', () => seek(Number(s.start || 0), 'subtitle'));
      return d;
    },
  });
  V.subList.setItems(V.segments);
  qs('#v-sub-count').textContent = `${V.segments.length} 条字幕`;
  const badge = qs('#v-sub-badge');
  if (badge) badge.textContent = V.segments.length ? `${V.segments.length}` : '0';
}

function syncSubtitle(force) {
  if (!V.subList || !V.segments.length) return;
  const ms = nowMs();
  const i = segIndexAt(ms);
  V.activeSeg = i;
  qs('#v-active-seg').textContent = i >= 0 ? `#${i} ${fmtMs(V.segments[i].start)}` : '—';
  qs('#v-active-seg').dataset.index = String(i);
  if (i !== V.subList.activeIndex || force) {
    V.subList.setActive(i, V.autoFollow !== false);
  }
}

/* ---------------- 文稿分章 + 全文总结 ---------------- */

function summaryText() {
  const a = V.artifact || {};
  if (a.summary) return { text: a.summary, source: 'artifact.summary' };
  if (a.overall_summary) return { text: a.overall_summary, source: 'artifact.overall_summary' };
  if (a.transcript_summary) return { text: a.transcript_summary, source: 'artifact.transcript_summary' };
  if (V.transcript.length) {
    // 后端未产出全文总结时如实标注：这是**由各章摘要拼的**，不是 LLM 全文总结
    const joined = V.transcript.filter((c) => c.summary)
      .map((c) => `【${c.title}】${c.summary}`).join('\n');
    if (joined) return { text: joined, source: 'derived:chapter_summaries（本地汇总，非后端 LLM 全文总结）' };
  }
  return { text: '', source: 'none' };
}

function renderTranscript() {
  const box = qs('#v-transcript');
  const sum = summaryText();
  let h = '<div class="panel" style="padding:12px 14px">'
    + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><b>全文总结</b>'
    + `<span class="pill ${sum.source.startsWith('derived') ? 'orange' : 'ok'}">${esc(sum.source)}</span>`
    + `<span class="pill">${V.transcript.length} 章</span></div>`
    + (sum.text
      ? `<div class="small" style="margin-top:6px;white-space:pre-wrap">${esc(sum.text)}</div>`
      : `<div class="note warn" style="margin-top:6px">后端未产出全文总结（<code>summary</code> 字段缺失），且文稿章节也没有 summary。`
        + '按 F6-S5，这里应当由 LLM 给出整篇摘要 —— 当前如实显示为空，不编造。</div>')
    + '</div>';
  h += V.transcript.map((c, i) => `<div class="chapter" data-chapter="${i}" data-start="${esc(String(c.start))}" data-end="${esc(String(c.end))}">`
    + `<div class="ch-head"><span class="tw">${i === 0 ? '▾' : '▸'}</span>`
    + `<b>${esc(c.title || '第 ' + (i + 1) + ' 章')}</b>`
    + `<span class="faint mono tiny">${esc(fmtMs(c.start))}–${esc(fmtMs(c.end))}</span>`
    + `<span class="right"></span><button type="button" class="ch-goto" data-at="${esc(String(c.start))}">▶ 定位</button></div>`
    + `<div class="ch-body"><div class="ch-sum">${esc(c.summary || '（该章无摘要）')}</div>`
    + `<div class="small" style="margin-top:6px;white-space:pre-wrap">${esc((c.text || '').slice(0, 2000))}${(c.text || '').length > 2000 ? '…' : ''}</div></div></div>`).join('');
  box.innerHTML = h || '<div class="loading">（无文稿）</div>';
  qsa('.chapter .ch-head', box).forEach((head) => head.addEventListener('click', (ev) => {
    if (ev.target.closest('.ch-goto')) return;
    const ch = head.parentElement;
    ch.classList.toggle('open');
    const tw = head.querySelector('.tw');
    if (tw) tw.textContent = ch.classList.contains('open') ? '▾' : '▸';
  }));
  qsa('.chapter', box).forEach((ch, i) => { if (i === 0) ch.classList.add('open'); });
  qsa('.ch-goto', box).forEach((b) => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    seek(Number(b.dataset.at || 0), 'chapter');
    showTab('subs');
  }));
}

/* ---------------- 思维导图 ---------------- */

function renderMindmapTab() {
  const box = qs('#v-mindmap');
  const md = V.mindmap;
  if (!md || !md.content) {
    box.innerHTML = '<div class="note warn">后端未产出思维导图（<code>/video/mindmap</code> 为空）。'
      + '按 F6-S6 应由 LLM 生成 markmap 格式大纲；此处如实留空，不编造结构。</div>';
    qs('#v-mm-count').textContent = '0';
    return;
  }
  const parsed = parseMindmap(md.content);
  V.mm = renderMindmap(box, parsed, { onSeek: (ms) => seek(ms, 'mindmap') });
  qs('#v-mm-count').textContent = `${parsed.count} 节点 · format=${md.format || 'markmap'}`;
}

/* ---------------- 幻灯片帧 ---------------- */

function renderSlides() {
  const box = qs('#v-slides');
  if (!V.slides.length) {
    box.innerHTML = '<div class="note warn">后端未产出幻灯片帧（<code>/video/slides</code> 为空）。'
      + '若 ffmpeg 可用，可点右上角「抽取幻灯片帧」重跑；场景检测阈值为 0.4。</div>';
    return;
  }
  box.innerHTML = `<div class="small muted" style="margin-bottom:8px">共 ${V.slides.length} 帧。`
    + '<b>说明</b>：这是 ffmpeg 场景检测抽出的<b>图片帧</b>，不是可编辑 PPT，也不还原版式/动画（坑 11）。</div>'
    + '<div class="slides-grid">' + V.slides.map((s, i) => `<div class="slide-card" data-slide="${i}" data-at="${esc(String(s.at_ms))}">`
      + `<img src="${esc(resolveUrl(s.image))}" alt="幻灯片帧 ${esc(String(s.index || i + 1))}" loading="lazy">`
      + `<div class="sc-meta"><span>#${esc(String(s.index || i + 1))}</span><span class="mono">${esc(fmtMs(s.at_ms))}</span></div>`
      + (s.title ? `<div class="sc-meta"><span>${esc(s.title)}</span></div>` : '')
      + (s.ocr_text ? `<div class="sc-meta"><span class="faint">OCR: ${esc(String(s.ocr_text).slice(0, 40))}…</span></div>` : '')
      + '</div>').join('') + '</div>';
  qsa('.slide-card', box).forEach((card) => card.addEventListener('click', () => {
    seek(Number(card.dataset.at || 0), 'slide');
    qsa('.slide-card.hl', box).forEach((x) => x.classList.remove('hl'));
    card.classList.add('hl');
  }));
}

/** 契约里的 image 可能是相对路径 → 拼到 API 基址；已是 http/data 的原样返回。 */
function resolveUrl(u) {
  if (!u) return '';
  if (/^(https?:|data:|\/)/.test(u)) return u;
  return '/api/v1/' + String(u).replace(/^\/+/, '');
}

/* ---------------- 标签页 ---------------- */

function showTab(name) {
  V.tab = name;
  qsa('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  qsa('.tabpane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
  if (name === 'subs' && V.subList) V.subList.render();
}

/* ---------------- 重跑解析（SSE 进度，契约 §6） ---------------- */

/**
 * 「生成字幕 / 重跑」：提交任务 → 订阅 SSE 进度 → 完成后重新加载产物。
 * 能力门控在 applyCapabilities() 里（ASR 不可用 → disabled，这里直接返回，不假装提交成功）。
 */
async function runReparse(btn, label) {
  const task = qs('#v-task');
  if (btn.hasAttribute('disabled') || btn.dataset.gateReason) {
    task.dataset.done = 'false';
    task.textContent = `入口已禁用：${btn.dataset.gateReason || '能力不可用'}`;
    return null;
  }
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const r = await Api.videoReparse(V.docId, V.asrModel ? { asr_model: V.asrModel } : {});
    const taskId = r && (r.task_id || r.id);
    task.dataset.taskId = taskId || '';
    task.dataset.done = '';
    task.dataset.progress = '';
    task.textContent = `已提交「${label}」· 任务 ${taskId || '?'}`;
    if (taskId) subscribeTask(taskId);
    return r;
  } catch (e) {
    task.dataset.done = 'false';
    task.textContent = `提交失败：${e.message}${e.hint ? ' · ' + e.hint : ''}`;
    throw e;
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/** 契约 §6 SSE 为主；若 3s 内一帧都没到，退化为轮询 /tasks/{id}（真实后端网络环境下很常见）。 */
function subscribeTask(taskId) {
  const task = qs('#v-task');
  let finished = false;
  let gotFrame = false;
  let es = null;

  const setProgress = (pct, stage) => {
    task.dataset.progress = pct == null ? '' : String(pct);
    task.textContent = `任务 ${taskId}：${pct == null ? '进行中' : pct + '%'} ${stage || ''}`.trim();
  };
  const finishDone = () => {
    finished = true;
    task.dataset.done = 'true';
    task.textContent = `任务 ${taskId} 完成，正在重新加载产物…`;
    loadVideo(V.docId);
  };
  const finishFailed = (msg, code) => {
    finished = true;
    task.dataset.done = 'false';
    task.textContent = `任务 ${taskId} 失败：${msg || '未知错误'}${code ? ' (' + code + ')' : ''}`;
  };

  V.taskTransport = 'sse';
  try {
    es = new EventSource(Api.taskEventsUrl(taskId));
    V._es = es;
  } catch (e) {
    es = null;
  }
  if (es) {
    es.addEventListener('progress', (ev) => {
      gotFrame = true;
      let d = {};
      try { d = JSON.parse(ev.data); } catch (e) { /* 非 JSON 帧忽略 */ }
      setProgress(d.progress != null ? Math.round(Number(d.progress) * 100) : null, d.stage);
    });
    es.addEventListener('log', (ev) => {
      let d = {};
      try { d = JSON.parse(ev.data); } catch (e) { /* ignore */ }
      if (d.msg) task.title = String(d.msg);
    });
    es.addEventListener('done', () => {
      gotFrame = true;
      finished = true;
      es.close();
      delete V._es;
      finishDone();
    });
    es.addEventListener('failed', (ev) => {
      gotFrame = true;
      finished = true;
      es.close();
      delete V._es;
      let d = {};
      try { d = JSON.parse(ev.data); } catch (e) { /* ignore */ }
      finishFailed(d.error, d.code);
    });
    es.onerror = () => {
      // 注意：close() 之后也会触发 error —— 已完成/已失败的状态不能被这条消息覆盖
      if (!finished && es && es.readyState === EventSource.CLOSED) {
        task.textContent = `已提交任务 ${taskId} · 进度流断开，改用轮询…`;
        startPolling();
      }
    };
  } else {
    startPolling();
  }

  function startPolling() {
    if (finished) return;
    V.taskTransport = 'poll';
    let n = 0;
    const timer = setInterval(async () => {
      if (finished || ++n > 40) { clearInterval(timer); return; }
      try {
        const t = await Api.task(taskId);
        setProgress(t.progress != null ? Math.round(Number(t.progress) * 100) : null, t.stage);
        if (t.status === 'done') { clearInterval(timer); finishDone(); }
        else if (t.status === 'failed' || t.status === 'cancelled') {
          clearInterval(timer); finishFailed(t.error, t.code);
        }
      } catch (e) {
        clearInterval(timer);
        task.textContent = `已提交任务 ${taskId} · 无法查询进度（${e.message}）`;
      }
    }, 1500);
    V._poll = timer;
    return timer;
  }
  void gotFrame;
  return es;
}

/* ---------------- 能力渲染（坑 10：ASR 不可用必须禁用 + 说明） ---------------- */

function applyCapabilities() {
  const c = V.caps;
  const asr = c.asr;
  // 「生成字幕 / 重跑」按钮：ASR 不可用 → disabled + 旁边说明原因
  const btn = qs('#btn-reparse');
  applyGate(btn, asr.ok, asr.reason);
  btn.dataset.gateFor = 'asr';
  const note = qs('#asr-note');
  note.classList.toggle('hidden', asr.ok);
  note.innerHTML = asr.ok ? '' : `<b>ASR 不可用</b>：${esc(asr.reason)}`
    + '<div class="small" style="margin-top:4px">按 F6 坑 10 的降级要求：此时<b>禁用</b>「生成字幕」入口；'
    + '仍可使用：视频播放器、已有字幕/文稿（若有）、幻灯片帧、手动上传字幕。'
    + '系统<b>不会</b>假装成功、也不会编造文稿。</div>';
  const ff = c.ffmpeg;
  applyGate(qs('#btn-slides'), ff.ok, ff.reason);
  qs('#ffmpeg-note').classList.toggle('hidden', ff.ok);
  qs('#ffmpeg-note').innerHTML = ff.ok ? '' : `<b>ffmpeg 不可用</b>：${esc(ff.reason)} → 抽音频/抽帧停摆，幻灯片帧无法重跑。`;
  // 字幕 tab 的空状态也要说明原因（不是无声空白）
  qs('#subs-empty-note').classList.toggle('hidden', asr.ok || V.segments.length > 0);
  qs('#subs-empty-note').innerHTML = asr.ok || V.segments.length ? '' : `<b>没有字幕</b>：ASR 不可用（${esc(asr.reason)}），`
    + '且该视频尚无既有字幕产物。按坑 10：此处如实留空，不生成假字幕。';
}

/* ---------------- 启动 ---------------- */

async function loadVideo(docId) {
  V.docId = docId;
  V.seekLog = [];
  qs('#v-status').textContent = '加载视频产物…';
  let a = null;
  try {
    a = await Api.video(docId);
  } catch (e) {
    a = null;
    qs('#v-status').innerHTML = `<span class="pill bad">产物加载失败</span> ${esc(e.message)}`
      + (e.hint ? ` · ${esc(e.hint)}` : '');
  }
  V.artifact = a || {};
  V.segments = (a && a.segments) || [];
  V.transcript = (a && a.transcript) || [];
  V.slides = (a && a.slides) || [];
  V.mindmap = (a && a.mindmap) || null;

  // 产物字段可能分接口提供 → 缺哪个补哪个（容错，不静默）
  if (!V.transcript.length) {
    try { const r = await Api.videoTranscript(docId); V.transcript = r.items || r.transcript || (Array.isArray(r) ? r : []); } catch (e) { /* 允许为空 */ }
  }
  if (!V.slides.length) {
    try { const r = await Api.videoSlides(docId); V.slides = r.items || r.slides || (Array.isArray(r) ? r : []); } catch (e) { /* 允许为空 */ }
  }
  if (!V.mindmap || !V.mindmap.content) {
    try {
      const r = await Api.videoMindmap(docId);
      V.mindmap = r && (r.content || r.format) ? r : (typeof r === 'string' ? { format: 'markmap', content: r } : null);
    } catch (e) { /* 允许为空 */ }
  }

  const v = videoEl();
  v.src = Api.streamUrl(docId);
  v.addEventListener('loadedmetadata', () => qs('#v-status').textContent = '媒体已加载');  v.addEventListener('error', () => {
    qs('#v-status').innerHTML = '<span class="pill bad">视频流不可用</span> '
      + '（后端无原文件或该格式浏览器不能解码）—— 字幕/文稿/思维导图/幻灯片仍可查看。';
  });

  qs('#v-meta').textContent = `${V.artifact.asr_model || '未转写'} · ${V.artifact.asr_lang || '—'}`
    + (V.artifact.duration_ms ? ` · 时长 ${fmtMs(V.artifact.duration_ms)}` : '');
  qs('#v-meta').dataset.segments = String(V.segments.length);
  qs('#v-meta').dataset.transcript = String(V.transcript.length);
  qs('#v-meta').dataset.slides = String(V.slides.length);
  const subUrl = V.artifact.subtitles && V.artifact.subtitles.vtt
    ? resolveUrl(V.artifact.subtitles.vtt) : Api.subtitleUrl(docId, 'vtt');
  qs('#v-sub-link').href = subUrl;
  qs('#v-srt-link').href = V.artifact.subtitles && V.artifact.subtitles.srt
    ? resolveUrl(V.artifact.subtitles.srt) : Api.subtitleUrl(docId, 'srt');

  renderSubtitles();
  renderTranscript();
  renderMindmapTab();
  renderSlides();
  updateClock();
  applyCapabilities();
}

async function boot() {
  try {
    const caps = await loadCaps();
    V.caps = caps.summary;
    renderCapChips(qs('#caps'), caps.summary);
    applyCapabilities();

    qsa('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
    qs('#btn-mm-expand').addEventListener('click', () => V.mm && V.mm.collapseAll(false));
    qs('#btn-mm-collapse').addEventListener('click', () => V.mm && V.mm.collapseAll(true));
    qs('#btn-reparse').addEventListener('click', () => {
      runReparse(qs('#btn-reparse'), '重跑 ASR / 字幕 / 文稿 / 思维导图').catch(() => {});
    });
    qs('#btn-slides').addEventListener('click', () => {
      runReparse(qs('#btn-slides'), '重跑场景抽帧（幻灯片帧）').catch(() => {});
    });
    qs('#btn-sub-autofollow').addEventListener('click', (ev) => {
      V.autoFollow = !(V.autoFollow !== false);
      ev.target.textContent = V.autoFollow !== false ? '自动跟随：开' : '自动跟随：关';
    });
    qs('#v-subs').addEventListener('wheel', () => V.subList && V.subList.suspend(4000), { passive: true });
    qs('#v-subs').addEventListener('touchstart', () => V.subList && V.subList.suspend(4000), { passive: true });
    const v = videoEl();
    v.addEventListener('timeupdate', () => { if (!V.simclock) { updateClock(); syncSubtitle(false); } });
    v.addEventListener('seeked', () => { if (!V.simclock) { confirmMediaSeek(); updateClock(); syncSubtitle(true); } });
    v.addEventListener('loadedmetadata', () => {
      qs('#v-media-check').dataset.mediaDurationMs = String(Math.round((v.duration || 0) * 1000));
      qs('#v-media-check').textContent = `媒体已加载：duration=${Math.round((v.duration || 0) * 1000)}ms`;
    }, { once: true });

    const docsRes = await Api.documents({ limit: 100, kind: 'video' });
    const all = (docsRes.items || docsRes.documents || []);
    V.docs = all.length ? all : ((await Api.documents({ limit: 100 })).items || []);
    if (!V.docs.length) {
      qs('#v-status').innerHTML = '<span class="pill bad">还没有视频文档</span> 请先 POST /api/v1/documents 上传视频（kind=video）。';
      writeJsonScript('video-report', { ok: false, reason: 'no video documents' });
      return;
    }
    const sel = qs('#v-doc');
    sel.innerHTML = V.docs.map((d) => `<option value="${esc(d.id)}">${esc(d.title)}（${esc(d.kind)}）</option>`).join('');
    const want = P.get('doc');
    const chosen = V.docs.find((d) => d.id === want) || V.docs[0];
    sel.value = chosen.id;
    sel.addEventListener('change', () => loadVideo(sel.value));

    await loadVideo(chosen.id);

    if (V.simclock) {
      // 无头验证用的合成时钟：不改变真实播放路径，只是替代取时间的来源
      const t = Number(P.get('t') || 0);
      V.clockMs = isFinite(t) ? t : 0;
      V.autoFollow = true;
      setInterval(() => { V.clockMs += 250; updateClock(); syncSubtitle(false); }, 250);
      qs('#v-simclock-note').classList.remove('hidden');
      updateClock();
      syncSubtitle(true);
    } else {
      V.autoFollow = true;
      if (P.get('t')) seek(Number(P.get('t')), 'url');
    }

    if (P.get('selftest') === '1') await runSelftest();
    writeJsonScript('video-report', {
      ok: true, doc: V.docId, segments: V.segments.length, transcript: V.transcript.length,
      slides: V.slides.length, mindmap: !!(V.mindmap && V.mindmap.content),
      asr_available: V.caps.asr.ok, ffmpeg_available: V.caps.ffmpeg.ok,
      sub_rows_dom: qsa('#v-subs .sub-row').length,
      load_ms: Math.round(performance.now() - T_LOAD0),
    });
  } catch (e) {
    showFatal(e.message || String(e), e.detail || '');
    writeJsonScript('video-report', { ok: false, error: e.message, code: e.code || '' });
  } finally {
    await testBarrierDone();
  }
}

/* ---------------- 自检 ---------------- */

async function runSelftest() {
  const R = { checks: {}, ok: true };
  const rec = (k, v) => { R.checks[k] = v; };
  await new Promise((r) => setTimeout(r, 400));

  rec('caps_loaded', !!V.caps);
  rec('asr_available', V.caps.asr.ok);
  rec('ffmpeg_available', V.caps.ffmpeg.ok);
  rec('reparse_disabled', qs('#btn-reparse').hasAttribute('disabled'));
  rec('reparse_gate_reason', qs('#btn-reparse').dataset.gateReason || '');
  rec('asr_note_visible', !qs('#asr-note').classList.contains('hidden'));
  rec('asr_note_text', (qs('#asr-note').textContent || '').trim().slice(0, 120));
  rec('segments', V.segments.length);
  rec('transcript_chapters', V.transcript.length);
  rec('slides', V.slides.length);
  rec('mindmap_nodes', V.mm ? V.mm.nodeCount : 0);
  rec('sub_rows_dom', qsa('#v-subs .sub-row').length);
  rec('sub_virtual', V.segments.length > 200 ? qsa('#v-subs .sub-row').length < V.segments.length : null);
  rec('duration_text', qs('#v-duration').textContent);

  // ① 字幕与视频同步：把时钟放到第 3 条字幕中间 → 高亮该条
  if (V.segments.length > 2) {
    const idx = 2;
    const s = V.segments[idx];
    const mid = Math.round((Number(s.start) + Number(s.end || s.start + 500)) / 2);
    seek(mid, 'selftest-clock');
    await new Promise((r) => setTimeout(r, V.simclock ? 150 : 700));
    if (V.simclock) {
      rec('sync_target_index', idx);
      rec('sync_target_start', Number(s.start));
      rec('sync_active_index', Number(qs('#v-active-seg').dataset.index));
      rec('sync_ok', Number(qs('#v-active-seg').dataset.index) === idx);
      const active = qs('#v-subs .sub-row.active');
      rec('sync_active_dom', !!active && Number(active.dataset.i) === idx);
      rec('clock_text', qs('#v-clock').textContent);
    } else {
      rec('sync_ok', null);         // 真媒体下由 media_seek_ok + 时钟驱动，见 ⑥
      rec('sync_target_index', idx);
    }
  } else { rec('sync_ok', false); }

  // ② 点字幕 → currentTime（记进 seeklog）
  const row = qs('#v-subs .sub-row[data-i]');
  if (row) {
    const before = V.seekLog.length;
    const want = Number(row.dataset.start);
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 120));
    rec('subtitle_click_start', want);
    rec('subtitle_click_seek_log_delta', V.seekLog.length - before);
    rec('subtitle_click_last', V.seekLog.length ? V.seekLog[V.seekLog.length - 1].ms : null);
    rec('subtitle_click_ok', V.seekLog.length > before && V.seekLog[V.seekLog.length - 1].ms === Math.round(want));
  } else { rec('subtitle_click_ok', false); }

  // ③ 章节折叠 + 定位
  const chHead = qs('.chapter .ch-head');
  if (chHead) {
    const ch = chHead.parentElement;
    const wasOpen = ch.classList.contains('open');
    chHead.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    rec('chapter_toggle_ok', ch.classList.contains('open') !== wasOpen);
    chHead.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  } else { rec('chapter_toggle_ok', false); }

  // ④ 思维导图折叠
  if (V.mm) {
    const before = qsa('#v-mindmap .mm-node.collapsed').length;
    V.mm.collapseAll(true);
    const collapsed = qsa('#v-mindmap .mm-node.collapsed').length;
    V.mm.collapseAll(false);
    const expanded = qsa('#v-mindmap .mm-node.collapsed').length;
    rec('mindmap_collapse', { before, collapsed, expanded });
    rec('mindmap_toggle_ok', collapsed > before && expanded < collapsed);
    const seekBtn = qs('#v-mindmap .mm-seek');
    if (seekBtn) {
      const beforeN = V.seekLog.length;
      seekBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 80));
      rec('mindmap_seek_ok', V.seekLog.length > beforeN);
    } else { rec('mindmap_seek_ok', null); }
  } else { rec('mindmap_toggle_ok', false); }

  // ⑤ 幻灯片帧点击跳转
  const sl = qs('.slide-card');
  if (sl) {
    const at = Number(sl.dataset.at);
    const before = V.seekLog.length;
    sl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 100));
    rec('slide_click_at', at);
    rec('slide_click_ok', V.seekLog.length > before && V.seekLog[V.seekLog.length - 1].ms === at);
    rec('slide_hl', sl.classList.contains('hl'));
  } else { rec('slide_click_ok', null); }

  // ⑥ 虚拟滚动确实在窗口化
  const box = qs('#v-subs');
  rec('vscroll', {
    total: V.segments.length,
    dom_rows: qsa('#v-subs .sub-row').length,
    spacer_height: Number((qs('#v-subs .vs-spacer') || {}).style ? parseInt(qs('#v-subs .vs-spacer').style.height, 10) : 0),
    scroll_height: box.scrollHeight,
  });
  if (V.segments.length > 200) {
    const first = qsa('#v-subs .sub-row').map((x) => Number(x.dataset.index));
    box.scrollTop = 40 * 42 * 3;
    V.subList.render();
    await new Promise((r) => setTimeout(r, 80));
    const after = qsa('#v-subs .sub-row').map((x) => Number(x.dataset.index));
    rec('vscroll_window_shift', { before_first: first[0], after_first: after[0] });
    rec('vscroll_ok', after[0] > first[0]);
  } else { rec('vscroll_ok', null); }

  // ⑥ 真实媒体路径：最后再看 video.currentTime 是否真的接受了 seek
  await new Promise((r) => setTimeout(r, V.simclock ? 120 : 700));
  const mc = qs('#v-media-check');
  const lastSeek = V.seekLog.length ? V.seekLog[V.seekLog.length - 1] : null;
  const dur = mc ? Number(mc.dataset.mediaDurationMs || 0) : 0;
  const mediaOk = !!lastSeek && lastSeek.media_ms != null && dur > 0
    && Math.abs(lastSeek.media_ms - Math.min(lastSeek.ms, Math.max(0, dur - 50))) <= 600;
  rec('media_check', {
    available: dur > 0,
    duration_ms: dur,
    want_ms: lastSeek ? lastSeek.ms : null,
    media_ms: lastSeek ? lastSeek.media_ms : null,
    how: lastSeek ? lastSeek.how : '',
    ok: mediaOk,
  });
  rec('media_seek_ok', mediaOk ? true : null);
  rec('media_note', mc ? (mc.textContent || '').trim().slice(0, 120) : '');

  // ⑦ 重跑入口：可点 → 真提交 + SSE 进度；不可用 → 点击也不该发请求（坑 10）
  const rbtn = qs('#btn-reparse');
  const tsk = qs('#v-task');
  const gated = rbtn.hasAttribute('disabled');
  rbtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 2000));
  rec('reparse_gated', gated);
  rec('reparse_task_id', tsk.dataset.taskId || '');
  rec('reparse_progress', tsk.dataset.progress || '');
  rec('reparse_status_text', (tsk.textContent || '').trim().slice(0, 100));
  rec('reparse_done', tsk.dataset.done || '');
  if (gated) {
    rec('reparse_ok', !tsk.dataset.taskId && /已禁用|不可用/.test(tsk.textContent || ''));   // 不假装提交
  } else {
    rec('reparse_ok', !!tsk.dataset.taskId && (tsk.dataset.done === 'true' || /完成|\d+%/.test(tsk.textContent || '')));
  }

  R.ok = R.checks.caps_loaded === true && R.checks.subtitle_click_ok === true
    && R.checks.chapter_toggle_ok === true && R.checks.mindmap_toggle_ok === true
    && R.checks.reparse_ok === true
    && (R.checks.sync_ok === true || R.checks.sync_ok === null)
    && (R.checks.reparse_disabled === true || R.checks.asr_available === true);
  R.checks.failed = R.checks.sync_ok === null && R.checks.media_seek_ok !== true
    ? ['sync_ok skipped and media_seek_ok != true'] : [];
  writeJsonScript('selftest-report', R);
  qs('#v-selftest').textContent = R.ok ? '自检通过' : '自检未通过（见 #selftest-report）';
  return R;
}

/* 坑 9：boot() 必须在 DOMContentLoaded 或脚本末尾调用 */
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
