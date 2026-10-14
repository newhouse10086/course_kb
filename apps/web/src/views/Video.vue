<script setup lang="ts">
/**
 * Video —— 视频课堂（F6）
 *   · 播放器 + **字幕同步**（点字幕跳 currentTime；timeupdate 驱动高亮）
 *   · 文稿分章（可折叠）+ 全文总结（后端没给就如实说明，不编造）
 *   · 思维导图（markmap → 可折叠树；带时间锚的行可跳到视频）
 *   · 幻灯片帧（**图片帧**，点击跳转；OCR 不可用时仍显示帧图并标注，不隐藏整块）
 *   · **虚拟滚动**（3 000 条字幕只渲染可视窗口）
 *   · 能力门控：ASR/TTS/OCR 各自独立，不可用 → 禁用入口 + 显示 reason
 *
 * v1 两个真问题的修法（Lead 要求不许用放宽断言掩盖）：
 *   ① `media_check.ok` 在合成时钟下**本来就是 N/A** → 标 `skipped`，不冒充"通过"；
 *      真实媒体路径下必须断言 `video.currentTime ≈ 目标时间`。
 *   ② 重跑入口不是摆设 → 真提交 + TaskStream（SSE 主 + 轮询兜底），transport 如实上报。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api, listOf } from '../api/client'
import { TaskStream, type TaskTransport } from '../api/sse'
import { useCaps } from '../composables/useCaps'
import { useDocuments } from '../composables/useCorpus'
import MindMap from '../components/MindMap.vue'
import VirtualList from '../components/VirtualList.vue'
import { fmtMs } from '../utils/text'
import { queryFlag, queryValue, testBarrier, testBarrierDone, writeReport } from '../utils/report'
import type { TranscriptChapter, VideoArtifact, VideoSegment, VideoSlide } from '../api/types'

const route = useRoute()
const { caps } = useCaps()
const docsApi = useDocuments()

const docId = ref<string | null>(null)
const artifact = ref<VideoArtifact | null>(null)
const segments = ref<VideoSegment[]>([])
const transcript = ref<TranscriptChapter[]>([])
const slides = ref<VideoSlide[]>([])
const mindmap = ref<{ format?: string; content?: string } | null>(null)
const clockMs = ref(0)
const durationMs = ref(0)
const activeIndex = ref(-1)
const autoFollow = ref(true)
const openChapters = ref<Set<number>>(new Set([0]))
const activeSlide = ref<number | null>(null)
const mediaReady = ref(false)
const mediaNote = ref('媒体：等待加载')
const mediaCheck = ref<{ want_ms: number | null; media_ms: number | null; duration_ms: number; how: string; ok: boolean | null }>({
  want_ms: null, media_ms: null, duration_ms: 0, how: '', ok: null,
})
const taskState = ref<{ id: string; progress: number | null; text: string; done: string; transport: TaskTransport | '' }>({
  id: '', progress: null, text: '', done: '', transport: '',
})
const fatal = ref('')
const seekLog = ref<Array<{ ms: number; how: string; media_ms: number | null }>>([])
const player = ref<HTMLVideoElement | null>(null)
const listRef = ref<InstanceType<typeof VirtualList> | null>(null)
const mmRef = ref<InstanceType<typeof MindMap> | null>(null)

const simclock = queryFlag('simclock')
const asrOk = computed(() => !!caps.value?.isAvailable('asr'))
const asrReason = computed(() => caps.value?.reasonFor('asr') || 'ASR 能力未上报')
const ocrOk = computed(() => !!caps.value?.isAvailable('ocr'))
const ocrReason = computed(() => caps.value?.reasonFor('ocr') || 'OCR 能力未上报')
const ttsOk = computed(() => !!caps.value?.isAvailable('tts'))
const ffmpegOk = computed(() => !!caps.value?.isAvailable('ffmpeg'))
const ffmpegReason = computed(() => caps.value?.reasonFor('ffmpeg') || 'ffmpeg 能力未上报')
const ttsReason = computed(() => caps.value?.reasonFor('tts') || 'TTS 能力未上报')
const chapterCount = computed(() => transcript.value.length)

const summary = computed(() => {
  const a = artifact.value || {}
  if (a.summary) return { text: a.summary, source: 'artifact.summary' }
  if (a.overall_summary) return { text: a.overall_summary, source: 'artifact.overall_summary' }
  if (a.transcript_summary) return { text: a.transcript_summary, source: 'artifact.transcript_summary' }
  const joined = transcript.value.filter((c) => c.summary).map((c) => `【${c.title}】${c.summary}`).join('\n')
  if (joined) return { text: joined, source: 'derived:chapter_summaries（本地汇总，非后端 LLM 全文总结）' }
  return { text: '', source: 'none' }
})

const currentChapter = computed(() => {
  const ms = clockMs.value
  return transcript.value.find((c) => ms >= Number(c.start || 0) && ms < Number(c.end || Infinity)) || null
})

function nowMs(): number {
  if (simclock) return clockMs.value
  const v = player.value
  return v ? Math.round((v.currentTime || 0) * 1000) : 0
}

function logSeek(ms: number, how: string) {
  seekLog.value = [...seekLog.value, { ms: Math.round(ms), how, media_ms: null }]
  writeReport('v-seeklog', seekLog.value)
}

/** 真实的跳转：设置 video.currentTime；合成时钟下只改内部时钟（真实播放路径不变） */
function seek(ms: number, how: string) {
  const t = Math.max(0, Math.round(ms))
  clockMs.value = t
  if (!simclock && player.value) {
    try { player.value.currentTime = t / 1000 } catch { /* 媒体未就绪 */ }
    setTimeout(() => confirmMediaSeek(), 250)
  }
  logSeek(t, how)
  syncSubtitle(true)
}

/** 媒体真的接受了这次 seek 吗？（无头下 seeked 事件不保证触发，主动确认一次） */
function confirmMediaSeek() {
  if (simclock || !player.value) return
  const last = seekLog.value[seekLog.value.length - 1]
  if (!last || last.media_ms != null) return
  const got = Math.round((player.value.currentTime || 0) * 1000)
  const next = [...seekLog.value]
  next[next.length - 1] = { ...last, media_ms: got }
  seekLog.value = next
  const dur = Math.round((player.value.duration || 0) * 1000)
  mediaCheck.value = {
    want_ms: last.ms, media_ms: got, duration_ms: dur, how: last.how,
    ok: dur > 0 && Math.abs(got - Math.min(last.ms, Math.max(0, dur - 50))) <= 600,
  }
  mediaNote.value = `媒体校验：target=${last.ms}ms media=${got}ms duration=${dur}ms ok=${mediaCheck.value.ok}`
  writeReport('v-seeklog', next)
}

function segIndexAt(ms: number): number {
  const segs = segments.value
  let lo = 0, hi = segs.length - 1, best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (Number(segs[mid].start || 0) <= ms) { best = mid; lo = mid + 1 } else hi = mid - 1
  }
  return best
}

function syncSubtitle(force: boolean) {
  if (!segments.value.length) return
  const i = segIndexAt(nowMs())
  activeIndex.value = i
  if (force || autoFollow.value) void nextTick(() => listRef.value?.scrollToIndex(i, true))
}

function onRowClick(index: number) {
  const s = segments.value[index]
  if (s) seek(Number(s.start || 0), 'subtitle')
}

function toggleChapter(i: number) {
  const s = new Set(openChapters.value)
  if (s.has(i)) s.delete(i); else s.add(i)
  openChapters.value = s
}

function onSlideClick(s: VideoSlide) {
  seek(Number(s.at_ms || 0), 'slide')
  activeSlide.value = s.index
}

async function loadVideo(id: string) {
  docId.value = id
  seekLog.value = []
  writeReport('v-seeklog', [])
  artifact.value = null
  fatal.value = ''
  try {
    artifact.value = await api.video(id)
  } catch (e) {
    artifact.value = {}
    fatal.value = (e as Error).message
  }
  const a = artifact.value || {}
  segments.value = (a.segments || []).map((s, i) => ({ ...s, i: s.i ?? i }))
  transcript.value = a.transcript || []
  slides.value = a.slides || []
  mindmap.value = a.mindmap || null
  durationMs.value = Number(a.duration_ms || 0)

  // 产物可能在分接口里（缺哪个补哪个，不静默）
  if (!transcript.value.length) {
    try { transcript.value = listOf<TranscriptChapter>(await api.videoTranscript(id), 'items', 'transcript', 'chapters') } catch { /* 允许为空 */ }
  }
  if (!slides.value.length) {
    try { slides.value = listOf<VideoSlide>(await api.videoSlides(id), 'items', 'slides') } catch { /* 允许为空 */ }
  }
  if (!mindmap.value?.content) {
    try {
      const r = await api.videoMindmap(id)
      if (r && (r.content || r.format)) mindmap.value = { format: r.format || 'markmap', content: r.content || '' }
    } catch { /* 允许为空 */ }
  }
  const v = player.value
  if (v) v.src = api.streamUrl(id)
  writeReport('video-report', {
    ok: true, doc: id, load_ms: Math.round(performance.now()), segments: segments.value.length, transcript: transcript.value.length, chapters: transcript.value.length,
    slides: slides.value.length, mindmap: !!mindmap.value?.content,
    asr_available: asrOk.value, ocr_available: ocrOk.value,
    duration_ms: durationMs.value,
    summary_source: summary.value.source,
  })
}

/* ---------------- 重跑（能力门控 + SSE 主 / 轮询兜底） ---------------- */

async function runReparse(kind: 'asr' | 'slides') {
  const gated = kind === 'asr' ? !asrOk.value : false
  if (gated) {
    taskState.value = { id: '', progress: null, text: `入口已禁用：${asrReason.value}`, done: 'false', transport: '' }
    return null
  }
  try {
    const r = await api.reparseVideo(docId.value!, {})
    const taskId = r.task_id || r.id || ''
    taskState.value = { id: taskId, progress: null, text: `已提交任务 ${taskId}`, done: '', transport: '' }
    if (!taskId) return r
    const stream = new TaskStream(taskId, { sseTimeoutMs: 3000, pollIntervalMs: 1500 })
    stream.start({
      onProgress: (e) => {
        taskState.value = {
          ...taskState.value,
          progress: e.progress != null ? Math.round(Number(e.progress) * 100) : null,
          text: `任务 ${taskId}：${e.progress != null ? Math.round(Number(e.progress) * 100) + '%' : '进行中'} ${e.stage || ''}`,
          transport: stream.transport,
        }
      },
      onTransport: (transport, note) => {
        taskState.value = { ...taskState.value, transport, text: `任务 ${taskId}：${note}` }
      },
      onDone: async () => {
        taskState.value = { ...taskState.value, done: 'true', text: `任务 ${taskId} 完成，正在重新加载产物…`, transport: stream.transport }
        await loadVideo(docId.value!)
      },
      onFailed: (e) => {
        taskState.value = { ...taskState.value, done: 'false', text: `任务 ${taskId} 失败：${e.error || '未知错误'}`, transport: stream.transport }
      },
    })
    tasks.push(stream)
    return r
  } catch (e) {
    taskState.value = { id: '', progress: null, text: `提交失败：${(e as Error).message}`, done: 'false', transport: '' }
    return null
  }
}
const tasks: TaskStream[] = []

/* ---------------- 启动 ---------------- */

async function boot() {
  testBarrier()
  try {
    const list = await docsApi.load()
    const withVideo = list.filter((d) => d.kind === 'video')
    const chosen = withVideo[0] || list.find((d) => d.id === route.query.doc) || list[0]
    if (!chosen) {
      fatal.value = '还没有文档：先到「文档」页上传视频（kind=video）'
      writeReport('video-report', { ok: false, reason: 'no documents' })
      return
    }
    const wantDoc = String(route.query.doc || '')
    const target = withVideo.find((d) => d.id === wantDoc) || chosen
    await nextTick()
    await loadVideo(target.id)

    const v = player.value
    if (v) {
      v.addEventListener('loadedmetadata', () => {
        mediaReady.value = true
        const dur = Math.round((v.duration || 0) * 1000)
        mediaCheck.value = { ...mediaCheck.value, duration_ms: dur }
        mediaNote.value = `媒体已加载：duration=${dur}ms`
      })
      v.addEventListener('timeupdate', () => { if (!simclock) { clockMs.value = nowMs(); syncSubtitle(false) } })
      v.addEventListener('seeked', () => { if (!simclock) confirmMediaSeek() })
    }

    if (simclock) {
      clockMs.value = Number(queryValue('t') || 0)
      setInterval(() => { clockMs.value += 250; syncSubtitle(false) }, 250)
      syncSubtitle(true)
    } else if (queryValue('t')) {
      seek(Number(queryValue('t')), 'url')
    }
    if (queryFlag('selftest')) await runSelftest()
  } catch (e) {
    fatal.value = (e as Error).message
    writeReport('video-report', { ok: false, error: (e as Error).message })
  } finally {
    await testBarrierDone()
  }
}

onBeforeUnmount(() => tasks.forEach((t) => t.stop()))
onMounted(boot)
// 换文档不重挂载（见 App.vue 的 RouterView key 说明）→ 自己监听 query.doc 重新加载
watch(() => route.query.doc, (v, old) => { if (v && v !== old) void boot() })

/* ---------------- 自检 ---------------- */

async function runSelftest() {
  const checks: Record<string, unknown> = {}
  const failed: string[] = []
  const rec = (k: string, v: unknown) => { checks[k] = v }
  const need = (k: string, cond: boolean) => { if (!cond) failed.push(k) }
  await new Promise((r) => setTimeout(r, 500))

  rec('caps_loaded', !!caps.value)
  rec('asr_available', asrOk.value)
  rec('asr_reason', asrReason.value)
  rec('ocr_available', ocrOk.value)
  rec('segments', segments.value.length)
  rec('chapters', transcript.value.length)
  rec('slides', slides.value.length)
  rec('mindmap_nodes', Number((mmRef.value as any)?.nodeCount ?? 0))
  rec('empty_states', {
    subs: !!document.querySelector('[data-testid="subs-empty"]'),
    transcript: !!document.querySelector('[data-testid="transcript-empty"]'),
    mindmap: !!document.querySelector('[data-testid="mindmap-empty"]'),
    slides: !!document.querySelector('[data-testid="slides-empty"]'),
  })
  need('asr_gate', !!document.querySelector('[data-testid="btn-reparse"]'))
  const reparseBtn = document.querySelector('[data-testid="btn-reparse"]') as HTMLButtonElement
  const slidesBtn = document.querySelector('[data-testid="btn-slides"]') as HTMLButtonElement
  rec('reparse_disabled', reparseBtn?.disabled ?? null)
  rec('reparse_gate_reason', reparseBtn?.dataset.gateReason || '')
  rec('slides_disabled', slidesBtn?.disabled ?? null)
  need('asr_gate_disabled', asrOk.value ? reparseBtn?.disabled === false : reparseBtn?.disabled === true)

  // ① 字幕同步：时钟放到第 3 条中间 → 高亮必须是它
  if (segments.value.length > 2) {
    const idx = 2
    const s = segments.value[idx]
    const mid = Math.round((Number(s.start) + Number(s.end || Number(s.start) + 500)) / 2)
    seek(mid, 'selftest-clock')
    await new Promise((r) => setTimeout(r, simclock ? 200 : 700))
    rec('sync_target_index', idx)
    rec('sync_target_start', Number(s.start))
    if (simclock) {
      activeIndex.value = segIndexAt(nowMs())
      syncSubtitle(true)
      await nextTick()
      const activeRow = document.querySelector('[data-testid="vscroll"] .vscroll-row.active')
      rec('sync_active_index', activeIndex.value)
      rec('sync_active_dom', !!activeRow && Number(activeRow.getAttribute('data-index')) === idx)
      need('sync', activeIndex.value === idx && !!activeRow)
    } else {
      rec('sync_active_index', null)      // 真媒体下由 media_check 证明（见 ⑤）
      rec('sync_active_dom', null)
    }
  } else { rec('sync', 'skipped(no segments)'); rec('sync_ok', null) }

  // ② 点字幕 → seek（真实点击）
  const row = document.querySelector('[data-testid="vscroll"] .vscroll-row') as HTMLElement | null
  if (row) {
    const before = seekLog.value.length
    const want = Number(row.getAttribute('data-start'))
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 150))
    const last = seekLog.value[seekLog.value.length - 1]
    rec('subtitle_click', { want, log_delta: seekLog.value.length - before, last_ms: last?.ms ?? null })
    need('subtitle_click', seekLog.value.length > before && last?.ms === Math.round(want))
  } else { rec('subtitle_click', 'skipped(no segments)') }

  // ③ 章节折叠
  const head = document.querySelector('[data-testid="chapter"] .ch-head') as HTMLElement | null
  if (head) {
    const chapter = head.closest('.chapter')!
    const was = chapter.classList.contains('open')
    head.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await nextTick()
    rec('chapter_toggle', { was, now: chapter.classList.contains('open') })
    need('chapter_toggle', chapter.classList.contains('open') !== was)
    head.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  } else if (transcript.value.length) { failed.push('chapter_toggle') } else { rec('chapter_toggle', { skipped: 'no chapters' }) }

  // ④ 思维导图折叠（**没有导图数据时是 N/A，不是失败** —— 降级场景必须进来）
  const mmNodes = Number((mmRef.value as any)?.nodeCount ?? 0)
  if (mmRef.value && mmNodes > 0) {
    // 真实交互：点章节前的折叠三角，DOM 上必须真的加上/去掉 collapsed
    // （不比较 collapseAll 前后的计数：初始"默认折叠到第 3 层"会折叠 14 个、collapseAll 只折叠 8 个**有子节点**的，
    //   计数变小并不代表功能坏了 —— 这是第一版断言写错的地方）
    const l1 = document.querySelector('[data-testid="mindmap"] .mm-node.mm-l1') as HTMLElement | null
    const toggle = l1?.querySelector('.mm-toggle') as HTMLElement | null
    if (l1 && toggle) {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await nextTick()
      const collapsedNow = l1.classList.contains('collapsed')
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await nextTick()
      const expandedNow = !l1.classList.contains('collapsed')
      rec('mindmap_collapse', { after_click_collapsed: collapsedNow, after_second_click_expanded: expandedNow })
      need('mindmap_toggle', collapsedNow === true && expandedNow === true)
    } else {
      rec('mindmap_collapse', { skipped: 'no l1 toggle' })
      failed.push('mindmap_toggle')
    }
    const seekBtn = document.querySelector('[data-testid="mindmap"] .mm-seek') as HTMLElement | null
    if (seekBtn) {
      const n0 = seekLog.value.length
      seekBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 120))
      rec('mindmap_seek', seekLog.value.length > n0)
      need('mindmap_seek', seekLog.value.length > n0)
    }
  } else if (mindmap.value?.content) {
    failed.push('mindmap_toggle')
  } else {
    rec('mindmap_collapse', 'skipped(no mindmap)')
    rec('mindmap_toggle', 'skipped(no mindmap)')
  }

  // ⑤ 幻灯片帧点击跳转 + OCR 降级口径
  const slide = document.querySelector('.slide-card') as HTMLElement | null
  if (slide) {
    const at = Number(slide.getAttribute('data-at'))
    const n0 = seekLog.value.length
    slide.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 120))
    rec('slide_click', { at, ok: seekLog.value.length > n0 && seekLog.value[seekLog.value.length - 1].ms === at, hl: slide.classList.contains('hl') })
    need('slide_click', seekLog.value.length > n0 && seekLog.value[seekLog.value.length - 1].ms === at)
    rec('slides_frames_label', document.body.textContent?.includes('图片帧') ?? false)
    rec('ocr_available_flag', ocrOk.value)
    rec('ocr_reason', ocrReason.value)
    need('slides_frames_label', document.body.textContent?.includes('图片帧') === true)
  } else if (slides.value.length) { failed.push('slide_click') } else { rec('slide_click', { skipped: 'no slides' }) }

  // ⑥ 虚拟滚动：DOM 行数必须远小于总条数
  const vs = document.querySelector('[data-testid="vscroll"]') as HTMLElement | null
  rec('vscroll', {
    total: Number(vs?.dataset.total || 0),
    dom_rows: Number(vs?.dataset.domRows || 0),
    row_height: Number(vs?.dataset.rowHeight || 0),
    spacer: (vs?.querySelector('.vscroll-spacer') as HTMLElement)?.style.height || '',
  })
  if (segments.value.length > 200) need('vscroll', Number(checks.vscroll && (checks.vscroll as any).dom_rows) < 200)

  // ⑦ 真实媒体路径：video.currentTime 真的接受了 seek
  await new Promise((r) => setTimeout(r, simclock ? 150 : 700))
  confirmMediaSeek()
  rec('media_check', { ...mediaCheck.value, mode: simclock ? 'simclock' : 'real-media', note: mediaNote.value })
  if (simclock) {
    // 合成时钟下没有媒体 seek —— 这是 N/A，不是"通过"，也不是"失败"
    rec('media_seek', 'skipped(simclock)')
  } else {
    rec('media_seek', mediaCheck.value.ok === true ? 'ok' : 'failed')
    need('media_seek', mediaCheck.value.ok === true)
  }
  rec('media_ready', mediaReady.value)

  // ⑧ 重跑入口：真提交 + 进度（SSE 主，轮询兜底）
  const gated = reparseBtn?.disabled === true
  reparseBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise((r) => setTimeout(r, 2200))
  rec('reparse', { gated, ...taskState.value })
  if (gated) {
    need('reparse', !taskState.value.id && /已禁用|不可用/.test(taskState.value.text))
  } else {
    need('reparse', !!taskState.value.id && (taskState.value.done === 'true' || (taskState.value.progress ?? 0) > 0))
    need('reparse_progress', taskState.value.progress === 42)
  }

  // ⑨ 能力横幅必须列出不可用项的原因
  rec('caps_banner_gates', Array.from(document.querySelectorAll('[data-testid="caps-bar"] .gate-note')).map((e) => e.textContent?.trim().slice(0, 80)))

  const report = { ok: failed.length === 0, checks, failed }
  writeReport('selftest-report', report)
  const box = document.getElementById('selftest-panel')
  if (box) box.textContent = report.ok ? '自检通过' : `自检未通过：${failed.join(', ')}`
  return report
}
</script>

<template>
  <div class="v-layout">
    <div class="v-left">
      <div class="v-player-wrap">
        <video ref="player" data-testid="player" controls preload="metadata" />
      </div>
      <div class="v-under">
        <span class="mono" data-testid="clock">{{ fmtMs(clockMs) }}</span>
        <span class="faint">/</span>
        <span class="mono faint">{{ durationMs ? fmtMs(durationMs) : '—' }}</span>
        <span class="pill" data-testid="current-chapter">{{ currentChapter?.title || '—' }}</span>
        <span class="small faint">当前字幕 <b class="mono" data-testid="active-seg">{{ activeIndex >= 0 ? activeIndex : "—" }}</b></span>
        <span class="right" />
        <button type="button" @click="autoFollow = !autoFollow">自动跟随：{{ autoFollow ? '开' : '关' }}</button>
      </div>

      <!-- 重跑入口：能力门控（ASR 不可用 → disabled + 原因；点击也不会提交） -->
      <div class="v-toolbar">
        <button
          type="button"
          data-testid="btn-reparse"
          :disabled="!asrOk"
          :data-gate-kind="asrOk ? '' : 'asr'"
          :data-gate-reason="asrOk ? '' : asrReason"
          :title="asrOk ? `重跑转写：${caps?.primary('asr')?.label || 'ASR'}` : `不可用：${asrReason}`"
          @click="runReparse('asr')"
        >生成字幕 / 重跑</button>
        <button
          type="button"
          data-testid="btn-slides"
          :disabled="!ffmpegOk"
          :data-gate-kind="ffmpegOk ? '' : 'ffmpeg'"
          :data-gate-reason="ffmpegOk ? '' : ffmpegReason"
          :title="ffmpegOk ? '用 ffmpeg 场景检测重跑抽帧' : `不可用：${ffmpegReason}`"
          @click="runReparse('slides')"
        >抽取幻灯片帧</button>
        <span v-if="taskState.id || taskState.text" class="small mono" data-testid="task-info"
              :data-task-id="taskState.id" :data-done="taskState.done" :data-progress="taskState.progress ?? ''"
              :data-transport="taskState.transport">{{ taskState.text }}</span>
        <span class="right" />
        <a class="flink" :href="api.subtitleUrl(docId || '', 'vtt')" target="_blank" rel="noopener">VTT</a>
        <a class="flink" :href="api.subtitleUrl(docId || '', 'srt')" target="_blank" rel="noopener">SRT</a>
        <span class="pill" :class="ttsOk ? 'ok' : ''" :title="ttsOk ? 'TTS 可用' : `TTS 不可用：${ttsReason}`">
          朗读 {{ ttsOk ? '可用' : '不可用' }}
        </span>
      </div>
      <!-- 门控说明：不可用时必须有可见文案（不是只在 title 里） -->
      <div v-if="!asrOk" class="gate-note" data-testid="reparse-gate">不可用：{{ asrReason }}</div>
      <div v-if="!ffmpegOk" class="gate-note" data-testid="slides-gate">不可用：{{ ffmpegReason }}</div>

      <div class="small mono faint" data-testid="media-check">{{ mediaNote }}</div>

      <!-- 能力说明（ASR / OCR / TTS 各自独立） -->
      <div v-if="!asrOk" class="note bad" data-testid="asr-note">
        <b>ASR 不可用</b>：{{ asrReason }}
        <div class="small" style="margin-top: 4px">
          此时<b>禁用</b>「生成字幕 / 重跑」入口（FUNCTIONAL_SPEC 坑 10）；仍可使用：播放器、已有字幕与文稿（若有）、
          幻灯片帧、手动上传字幕。系统<b>不会</b>假装成功，也不会编造文稿。
        </div>
      </div>
      <div v-else class="note ok small" data-testid="asr-note">
        ASR 可用：{{ caps?.primary('asr')?.label }}<span v-if="caps?.primary('asr')?.runtime">（{{ caps?.primary('asr')?.runtime === 'local' ? '本地' : '云端' }}）</span>
      </div>

      <div class="note warn" data-testid="ocr-note">
        <template v-if="ocrOk"><b>OCR 可用</b>：{{ caps?.primary('ocr')?.label }} → 帧图会附带识别文字。</template>
        <template v-else>
          <b>OCR 未启用（正常降级）</b>：{{ ocrReason }}
          <div class="small" style="margin-top: 4px">
            幻灯片区仍会显示<b>图片帧 + 时间点</b>（点击可跳到视频）。视频里"抽出的 PPT"**是图片帧，不是可编辑 PPT**，
            不还原版式/动画（PROVIDERS §6）。
          </div>
        </template>
      </div>

      <div v-if="fatal" class="note bad" data-testid="fatal">{{ fatal }}</div>
    </div>

    <div class="v-right">
      <div class="tabs">
        <button class="tab active" type="button" data-tab="subs">字幕 <span class="faint mono tiny">{{ segments.length }}</span></button>
      </div>
      <div class="panel" style="padding: 12px">
        <div class="small muted" style="margin-bottom: 6px">
          点任意一条跳到该时间点；<b>虚拟滚动</b>（只渲染可视窗口的行）· 总量 {{ segments.length }} 条
        </div>
        <div v-if="!segments.length" class="note warn" data-testid="subs-empty">
          <b>没有字幕</b>：{{ asrOk ? '该视频还没有转写产物（可点上方「生成字幕 / 重跑」）' : `ASR 不可用（${asrReason}），且没有既有字幕产物。按坑 10：此处如实留空，不生成假字幕。` }}
        </div>
        <VirtualList
          v-else
          ref="listRef"
          :items="segments"
          :row-height="42"
          :active-index="activeIndex"
          :auto-follow="autoFollow"
          @row-click="onRowClick"
          @user-scroll="autoFollow = false"
        >
          <template #default="{ item, index }">
            <span class="mono tiny faint" style="flex: 0 0 74px">{{ fmtMs((item as VideoSegment).start) }}</span>
            <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ (item as VideoSegment).text }}</span>
            <span class="faint tiny mono">{{ index }}</span>
          </template>
        </VirtualList>
      </div>

      <div class="panel" style="padding: 12px" data-testid="transcript">
        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
          <b>全文总结</b>
          <span class="pill" :class="summary.source.startsWith('derived') ? 'orange' : summary.source === 'none' ? 'bad' : 'ok'">{{ summary.source }}</span>
          <span class="pill">{{ chapterCount }} 章</span>
        </div>
        <div v-if="summary.text" class="small" style="margin-top: 6px; white-space: pre-wrap">{{ summary.text }}</div>
        <div v-else class="note warn" style="margin-top: 6px" data-testid="transcript-empty">
          后端未产出全文总结（<code>summary</code> 字段缺失），且文稿章节也没有 summary。按 F6-S5 这里应由 LLM 给出整篇摘要 ——
          当前如实显示为空，不编造。
        </div>

        <div v-for="(c, i) in transcript" :key="i" class="chapter" :class="{ open: openChapters.has(i) }" :data-chapter="i" :data-start="c.start" data-testid="chapter">
          <div class="ch-head" @click="toggleChapter(i)">
            <span>{{ openChapters.has(i) ? '▾' : '▸' }}</span>
            <b>{{ c.title }}</b>
            <span class="faint mono tiny">{{ fmtMs(c.start) }}–{{ fmtMs(c.end) }}</span>
            <span class="right" />
            <button type="button" class="ch-goto" :data-at="c.start" @click.stop="seek(Number(c.start), 'chapter')">▶ 定位</button>
          </div>
          <div class="ch-body">
            <div class="small muted">{{ c.summary || '（该章无摘要）' }}</div>
            <div v-if="c.text" class="small" style="margin-top: 6px; white-space: pre-wrap">{{ c.text.slice(0, 2000) }}</div>
          </div>
        </div>
        <div v-if="!transcript.length" class="note warn" data-testid="transcript-empty">
          后端未产出文稿（<code>/video/transcript</code> 为空）。
        </div>
      </div>

      <div class="panel" style="padding: 12px">
        <MindMap ref="mmRef" :markdown="mindmap?.content || ''" @seek="(ms) => seek(ms, 'mindmap')" />
        <div v-if="!mindmap?.content" data-testid="mindmap-empty" />
      </div>

      <div class="panel" style="padding: 12px" data-testid="slides">
        <div v-if="!slides.length" class="note warn" data-testid="slides-empty">
          后端未产出幻灯片帧（<code>/video/slides</code> 为空）。若 ffmpeg 可用可重跑场景抽帧（阈值 0.4）。
        </div>
        <template v-else>
          <div class="small muted" style="margin-bottom: 8px">
            共 {{ slides.length }} 帧。<b>说明</b>：这是场景检测抽出的<b>图片帧</b>，不是可编辑 PPT，也不还原版式/动画（坑 11）。
            <template v-if="!ocrOk">当前 <b>无 OCR</b>：只显示帧图 + 时间点。</template>
          </div>
          <div class="slides-grid">
            <div
              v-for="s in slides"
              :key="s.index"
              class="slide-card"
              :class="{ hl: activeSlide === s.index }"
              :data-slide="s.index"
              :data-at="s.at_ms"
              @click="onSlideClick(s)"
            >
              <img v-if="s.image" :src="s.image" :alt="`幻灯片帧 ${s.index}`" loading="lazy" />
              <div class="sc-meta"><span>#{{ s.index }}</span><span class="mono">{{ fmtMs(s.at_ms) }}</span></div>
              <div v-if="s.title" class="sc-meta"><span>{{ s.title }}</span></div>
              <div v-if="ocrOk && s.ocr_text" class="sc-meta"><span class="faint">OCR：{{ s.ocr_text.slice(0, 40) }}…</span></div>
              <div v-else-if="!ocrOk" class="sc-meta"><span class="faint">（图片帧，无 OCR 文本）</span></div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <div id="selftest-panel" class="small faint" />
  </div>
</template>

<style scoped>
.v-layout { display: flex; gap: 18px; padding: 14px 22px 40px; align-items: flex-start; }
.v-left { flex: 1 1 58%; min-width: 0; position: sticky; top: calc(var(--topbar-h) + 12px); }
.v-right { flex: 1 1 42%; min-width: 0; }
/* 播放器像"胶片窗"：纸白边框 + 细线，不用大圆角 */
.v-player-wrap { background: var(--canvas-bg); border: var(--hair) solid var(--rule); border-bottom: none; overflow: hidden; }
.v-player-wrap video { display: block; width: 100%; max-height: 52vh; background: #0b0b0d; }
.v-under { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 6px 12px;
  background: var(--panel); border: var(--hair) solid var(--rule); }
.v-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 7px 12px;
  background: var(--paper-2); border: var(--hair) solid var(--rule); border-top: none; }
</style>












