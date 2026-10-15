<script setup lang="ts">
/**
 * Docs —— 文档管理（上传 / 列表 / 进度 / 打开）
 *   · 上传走 POST /api/v1/documents（multipart），XHR 给上传进度
 *   · 解析/抽取是后台任务 → 用 TaskStream 订阅进度（SSE 主 + 轮询兜底）
 *   · 长任务必须能"看到进度"，而不是转圈等（C4 断点在服务端，前端负责可见）
 *   · 删除走 DELETE（级联）
 */
import { setAssistantContext } from '../composables/useAssistantContext'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api/client'
import { TaskStream } from '../api/sse'
import { useDocuments } from '../composables/useCorpus'
import { fmtBytes, fmtMs } from '../utils/text'
import { testBarrier, testBarrierDone, writeReport } from '../utils/report'
import type { DocumentInfo } from '../api/types'

const route = useRoute()
const router = useRouter()
const docsApi = useDocuments()
const busy = ref(false)
const uploadFrac = ref(0)
const note = ref('')
const noteKind = ref<'info' | 'warn' | 'bad' | 'ok'>('info')
const taskInfo = ref<{ id: string; text: string; progress: number | null; done: string } | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const dragOver = ref(false)
const streams: TaskStream[] = []

/** 未登录（401）与"没有文档"要分开说 —— 真后端 auth.required=true 时前者才是常态 */
const authError = computed(() => {
  const e = String(docsApi.error.value || '')
  return /E_UNAUTHENTICATED|未登录|401/.test(e) ? `未登录（401）：${e}` : ''
})

const rows = computed(() =>
  docsApi.docs.value.slice().sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0)))

async function doUpload(file: File) {
  busy.value = true
  uploadFrac.value = 0
  note.value = `正在上传 ${file.name}（${fmtBytes(file.size)}）…`
  noteKind.value = 'info'
  try {
    const r = await api.uploadDocument(file, (f) => { uploadFrac.value = f })
    note.value = `已上传：document_id=${r.document_id}` + (r.task_id ? `，task_id=${r.task_id}` : '')
    noteKind.value = 'ok'
    if (r.task_id) watchTask(r.task_id)
    await docsApi.load()
    writeReport('docs-report', { ok: true, uploaded: r.document_id, task: r.task_id || null })
  } catch (e) {
    note.value = `上传失败：${(e as Error).message}`
    noteKind.value = 'bad'
    writeReport('docs-report', { ok: false, error: (e as Error).message })
  } finally {
    busy.value = false
  }
}

function watchTask(taskId: string) {
  taskInfo.value = { id: taskId, text: `任务 ${taskId} 已提交`, progress: null, done: '' }
  const s = new TaskStream(taskId, { sseTimeoutMs: 2500, pollIntervalMs: 1200 })
  s.start({
    onProgress: (e) => {
      if (!taskInfo.value) return
      taskInfo.value = {
        ...taskInfo.value,
        progress: e.progress != null ? Math.round(Number(e.progress) * 100) : null,
        text: `${e.stage || '处理中'} ${e.progress != null ? Math.round(Number(e.progress) * 100) + '%' : ''}`,
      }
    },
    onTransport: (t, n) => { if (taskInfo.value) taskInfo.value = { ...taskInfo.value, text: n } ; void t },
    onDone: async () => {
      if (taskInfo.value) taskInfo.value = { ...taskInfo.value, done: 'true', text: '任务完成' }
      await docsApi.load()
    },
    onFailed: (e) => {
      if (taskInfo.value) taskInfo.value = { ...taskInfo.value, done: 'false', text: `任务失败：${e.error || '未知'}` }
    },
  })
  streams.push(s)
}

function onFile(ev: Event) {
  const f = (ev.target as HTMLInputElement).files?.[0]
  if (f) void doUpload(f)
}
function onDrop(ev: DragEvent) {
  ev.preventDefault()
  dragOver.value = false
  const f = ev.dataTransfer?.files?.[0]
  if (f) void doUpload(f)
}

/**
 * ★ 抽取状态（Lead 裁定）：把"阶段"与"产出"分开显示 ——
 *   `documents.status` = ready/failed/extracting（阶段）
 *   `meta.extract_status` = done/partial/**done_empty**（产出）
 * ★★ `done_empty` 是"跑完了但**零卡片**"，**绝不能显示成"成功"**。
 */
interface ExtractInfo {
  status: string
  label: string
  tone: 'ok' | 'warn' | 'bad' | 'faint'
  needsConfirm: boolean
  estimate: string
  progress: string
  failedReason: string
  note: string
}
function extractInfo(d: DocumentInfo): ExtractInfo {
  const m = (d.meta || {}) as Record<string, unknown>
  const raw = String(m.extract_status || '')
  const est = (m.extract_estimate || {}) as Record<string, unknown>
  const prog = (m.extract_progress || {}) as Record<string, unknown>
  const calls = Number(est.llm_calls)
  const dur = String(est.duration_human || '')
  const done = Number(prog.done)
  const total = Number(prog.total)
  const failed = String(m.task_failed_error || '')
  const needsConfirm = m.needs_confirm === true
  // 代价文案：**次数 + 时长都要有**（用户真正感受到的痛是"要等几小时"）
  const estimate = [
    Number.isFinite(calls) && calls > 0 ? `预计 ${calls} 次调用` : '',
    dur ? `约 ${dur}` : '',
  ].filter(Boolean).join(' / ') || '（后端未给估算 —— 不编数字）'
  const progress = (Number.isFinite(done) && Number.isFinite(total) && total > 0) ? `已抽取 ${done}/${total} 单元` : ''
  if (raw === 'done_empty') {
    return { status: raw, label: '已抽取但**零卡片**', tone: 'warn', needsConfirm, estimate, progress, failedReason: failed,
      note: '抽取跑完了，但**没有产出任何卡片**（不是成功）—— 检查正文是否为空 / 抽取提示词是否匹配该文档类型。' }
  }
  const table: Record<string, { label: string; tone: ExtractInfo['tone'] }> = {
    done: { label: '已抽取', tone: 'ok' },
    partial: { label: '部分抽取', tone: 'warn' },
  }
  if (table[raw]) return { status: raw, label: table[raw].label, tone: table[raw].tone, needsConfirm, estimate, progress, failedReason: failed, note: '' }
  if (!raw) {
    return { status: '', label: '未抽取', tone: 'faint', needsConfirm, estimate, progress, failedReason: failed,
      note: m.extract_status === undefined ? '（后端尚未提供 meta.extract_status —— 如实说明，不假装有状态）' : '' }
  }
  return { status: raw, label: raw, tone: 'faint', needsConfirm, estimate, progress, failedReason: failed, note: '' }
}

const extractBusy = ref('')

/**
 * ★ **可用性三态**（`pi-bridge` 清单，Lead 转）：`ready` / `detecting` / `unavailable(reason)`。
 *   ① `detecting` → **"正在检测模型可用性（首次约 1 分钟）"**
 *      ★★ **不许显示成"可用"或"不可用"** —— 探测未完成时那两种说法**都不成立**。
 *   ② `unavailable` → 显示 **reason 原文** + **禁用入口**（不画"能点但会失败"的按钮）
 *   ③ `ready` → 正常入口
 *   字段来自**文档 meta**（`extract_availability` / `extract_availability_reason`）与 `extract_note`；
 *   `/capabilities.availability` 属 backend-api 写域 —— 那边加了这里再切过去。
 */
function availOf(d: DocumentInfo): { kind: 'ready' | 'detecting' | 'unavailable'; text: string } {
  const m = (d.meta || {}) as Record<string, unknown>
  const raw = String(m.extract_availability || '')
  const reason = String(m.extract_availability_reason || '')
  // ⚠️ 文案里**不要出现"可用/不可用"这两个词** —— 否则断言"不许说成可用或不可用"无法成立，
  //    而且用户也会被绕进去（我第一版写了"不代表可用或不可用"，断言立刻红 —— 这是对的）
  if (raw === 'detecting') return { kind: 'detecting', text: '正在检测模型可用性（首次约 1 分钟）—— 探测完成前不下结论' }
  if (raw === 'unavailable') return { kind: 'unavailable', text: `模型不可用：${reason || '（后端未给原因 —— 不编）'}` }
  return { kind: 'ready', text: '' }
}

/**
 * ★★ 重新解析：**已开放**（2026-10-16，Lead 真数据验证通过）。
 *   历史（保留记录）：曾因后端 `repo.replaceUnits` 全量 DELETE + FK 级联删卡而**暂时禁用**；
 *   backend-core 改成"只删消失的单元"后，真数据验证：`units=4 · cards=5 · extract_status=partial` ✅
 *   → 现在按正常入口开放（**代价仍先展示再执行**：页数 → 时长区间 + OCR 本地不耗额度）。
 */
const REPARSE_ENABLED = true

/** 每份文档的重新解析状态（进度/错误；与视频页 taskState 同模式） */
const reparseState = ref<Record<string, { text: string; progress: number | null; done: string; transport: string }>>({})
/**
 * ★ **服务端给的代价**（`est_minutes` 区间 + `cost_note`）——**独立持久元素**：
 *   提交后立刻有 progress 帧，若把代价写进同一个元素会被**冲掉**（用户看不到"要等多久"）。
 *   ⚠️ 我第一版就是这样，断言只能抓到一瞬（150ms）→ 假失败；这也是"取瞬时状态"的坑。
 */
const reparseServerCost = ref<Record<string, string>>({})

/** 点击前的**代价预估**：`needs_ocr` 由后端判定，但页数已知 → 我们能给区间（不编数字） */
function reparseEstimate(d: DocumentInfo): string {
  const pages = Number(d.page_count || 0)
  if (!pages) return '（页数未知 → 无法预估时长；是否走 OCR 由后端判定）'
  // OCR 走本地：**不消耗 LLM 额度但占 CPU**（实测约 9–12 秒/页）
  const lo = Math.round((pages * 9) / 60)
  const hi = Math.round((pages * 12) / 60)
  return `若需 OCR：约 ${lo}–${hi} 分钟（${pages} 页 × 9–12 秒/页；OCR 走本地，**不消耗 LLM 额度但占 CPU**）`
}

async function reparseDoc(d: DocumentInfo) {
  // ★ 兜底门控：即使将来再次临时关闭入口，这里也**绝不发请求**（断言会检查"点击 → 调用数不变"）
  if (!REPARSE_ENABLED) {
    reparseState.value = { ...reparseState.value, [d.id]: { text: '入口当前已关闭（后端修复中）', progress: null, done: 'false', transport: 'none' } }
    return
  }
  const id = d.id
  reparseState.value = { ...reparseState.value, [id]: { text: '已提交重新解析…', progress: null, done: '', transport: '' } }
  try {
    const r = await api.reparseDocument(id)
    const range = Array.isArray(r.est_minutes) && r.est_minutes.length === 2
      ? `${r.est_minutes[0]}–${r.est_minutes[1]} 分钟` : ''
    // ★ 代价写进**独立元素**（整个任务期间都在，不会被进度帧冲掉）
    reparseServerCost.value = {
      ...reparseServerCost.value,
      [id]: [
        r.needs_ocr ? '需 OCR' : '无需 OCR',
        range ? `预计 ${range}` : '（服务端未给时长区间 —— 不编数字）',
        r.cost_note || '',
      ].filter(Boolean).join(' · '),
    }
    reparseState.value = {
      ...reparseState.value,
      [id]: { text: `已入队（${r.task_id || '无 task_id'}），任务进行中…`, progress: null, done: '', transport: '' },
    }
    const taskId = String(r.task_id || '')
    if (!taskId) return
    const stream = new TaskStream(taskId, { sseTimeoutMs: 3000, pollIntervalMs: 1500 })
    stream.start({
      onProgress: (e) => {
        reparseState.value = {
          ...reparseState.value,
          [id]: {
            text: `任务 ${taskId}：${e.progress != null ? `${Math.round(Number(e.progress) * 100)}%` : '进行中'}${e.stage ? ` · ${e.stage}` : ''}`,
            progress: e.progress != null ? Math.round(Number(e.progress) * 100) : null,
            done: '', transport: stream.transport,
          },
        }
      },
      onDone: () => {
        reparseState.value = { ...reparseState.value, [id]: { text: `任务 ${taskId} 完成，正在刷新列表…`, progress: 100, done: 'true', transport: stream.transport } }
        void docsApi.load()
      },
      onFailed: (e) => {
        reparseState.value = { ...reparseState.value, [id]: { text: `任务 ${taskId} 失败：${e.error || '未知原因'}`, progress: null, done: 'true', transport: stream.transport } }
      },
    })
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string }
    // ★ 409 = 正在运行（未重复入队）；403/404 也如实显示 —— 不许静默
    const why = err.status === 409 || err.code === 'E_BUSY'
      ? '正在运行，未重复入队（409 E_BUSY）'
      : err.status === 403 ? '无权操作该文档（403）'
        : err.status === 404 ? '文档不存在（404）'
          : `重新解析失败：${err.message || e}`
    reparseState.value = { ...reparseState.value, [id]: { text: why, progress: null, done: 'true', transport: '' } }
  }
}
async function startExtract(d: DocumentInfo) {
  extractBusy.value = d.id
  try {
    const r = await api.extractDocument(d.id)
    note.value = r.queued === false
      ? `未入队：${r.reason || '后端闸门拒绝（原因未给）'}`
      : `已提交抽取任务${r.taskId ? `（${r.taskId}）` : ''} —— 抽取会消耗 LLM 额度，进度见列表。`
    noteKind.value = r.queued === false ? 'warn' : 'ok'
    await docsApi.load()
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string }
    note.value = (err.status === 404 || err.code === 'E_NOTFOUND')
      ? '抽取接口尚未实现（POST /documents/:id/extract）—— 如实说明，不假装已入队'
      : `抽取失败：${err.message || e}`
    noteKind.value = 'bad'
  } finally {
    extractBusy.value = ''
  }
}

async function remove(d: DocumentInfo) {
  if (!confirm(`删除《${d.title}》？会级联删除该文档的单元/卡片/图谱（不可撤销）。`)) return
  try {
    await api.deleteDocument(d.id)
    note.value = `已删除 ${d.id}`
    noteKind.value = 'ok'
    await docsApi.load()
  } catch (e) {
    note.value = `删除失败：${(e as Error).message}`
    noteKind.value = 'bad'
  }
}

function openDoc(d: DocumentInfo, view: 'wiki' | 'graph' | 'video') {
  void router.push({ path: `/${view}`, query: { doc: d.id } })
}

// ★ 小助手上下文：当前选中的 doc
watch(() => route.query.doc, (d: unknown) => {
  setAssistantContext(d ? { doc_id: String(d) } : {}, d ? '当前文档' : '')
}, { immediate: true })

onMounted(async () => {
  testBarrier()
  await docsApi.load()
  await nextTick()   // (report = DOM ready signal)
  writeReport('docs-report', { ok: true, count: docsApi.docs.value.length, ids: docsApi.docs.value.map((d) => d.id) })
  await testBarrierDone()
})
</script>

<template>
  <div class="docs-layout">
    <div
      class="panel drop"
      :class="{ over: dragOver }"
      data-testid="dropzone"
      @dragover.prevent="dragOver = true"
      @dragleave="dragOver = false"
      @drop="onDrop"
    >
      <h3 style="margin-top: 0">上传文档</h3>
      <div class="small muted">
        PDF / PPTX / DOCX / TXT / 视频（mp4/mkv/mov/webm…）。上传后服务端会解析成 units，再抽取知识卡片与图谱。
      </div>
      <div class="row">
        <input ref="fileInput" type="file" data-testid="file-input" @change="onFile" />
        <button type="button" class="primary" :disabled="busy" data-testid="pick" @click="fileInput?.click()">选择文件</button>
        <span v-if="busy" class="small muted">上传中 {{ Math.round(uploadFrac * 100) }}%</span>
      </div>
      <div v-if="busy" class="bar"><i :style="{ width: Math.round(uploadFrac * 100) + '%' }" /></div>
      <div v-if="note" class="note" :class="noteKind" data-testid="upload-note">{{ note }}</div>
      <div v-if="taskInfo" class="note info" data-testid="task-info" :data-task-id="taskInfo.id" :data-done="taskInfo.done" :data-progress="taskInfo.progress ?? ''">
        <b>任务进度</b>：{{ taskInfo.text }}
      </div>
    </div>

    <div class="panel">
      <div style="display: flex; align-items: center; gap: 10px">
        <h3 style="margin: 0">文档列表（{{ rows.length }}）</h3>
        <button class="right" type="button" @click="docsApi.load()">刷新</button>
      </div>
      <div v-if="docsApi.error.value" class="note bad">{{ docsApi.error.value }}</div>
      <table class="table" data-testid="doc-table">
        <thead>
          <tr><th>标题</th><th>类型</th><th>状态</th><th>抽取</th><th>大小</th><th>页数</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="d in rows" :key="d.id" :data-doc="d.id" :data-kind="d.kind" :data-status="d.status">
            <td><b>{{ d.title }}</b><div class="faint tiny mono">{{ d.id }}</div></td>
            <td><span class="pill" :class="{ blue: d.kind === 'video' }">{{ d.kind }}</span></td>
            <td><span class="pill" :class="d.status === 'ready' ? 'ok' : d.status === 'failed' ? 'bad' : 'orange'">{{ d.status }}</span></td>
            <!-- ★ 抽取状态**按文档**显示（Lead 裁定：done_empty 不是成功；needs_confirm 报次数+时长） -->
            <td class="extract-cell" data-testid="extract-cell" :data-doc-extract="d.id">
              <span class="pill" :class="extractInfo(d).tone" data-testid="extract-status"
                    :data-status="extractInfo(d).status">{{ extractInfo(d).label }}</span>
              <div class="faint tiny" data-testid="extract-estimate">{{ extractInfo(d).estimate }}</div>
              <div v-if="extractInfo(d).progress" class="faint tiny" data-testid="extract-progress">
                {{ extractInfo(d).progress }}
              </div>
              <!-- ★ 三态：detecting 如实说"正在检测"；unavailable 显示原因 + **禁用入口** -->
              <div v-if="availOf(d).kind !== 'ready'" class="tiny" :class="availOf(d).kind === 'unavailable' ? 'warn-text' : 'faint'"
                   data-testid="extract-availability" :data-availability="availOf(d).kind"
                   :data-doc-avail="d.id">{{ availOf(d).text }}</div>
              <!-- 任务侧提示位：`extract_note`（detecting 时含"已等待 Ns"）**逐字显示** -->
              <div v-if="(d.meta || {}).extract_note" class="tiny faint" data-testid="extract-note-live"
                   :data-doc-note="d.id">{{ (d.meta || {}).extract_note }}</div>
              <button v-if="extractInfo(d).needsConfirm" type="button" class="small primary"
                      data-testid="extract-start" :data-extract-doc="d.id"
                      :disabled="extractBusy === d.id || availOf(d).kind === 'unavailable'"
                      :data-gate-reason="availOf(d).kind === 'unavailable' ? availOf(d).text : ''"
                      @click="startExtract(d)">开始抽取</button>
              <div v-if="extractInfo(d).failedReason" class="warn-text tiny" data-testid="extract-failed">
                失败：{{ extractInfo(d).failedReason }}
              </div>
              <div v-if="extractInfo(d).note" class="warn-text tiny" data-testid="extract-note">{{ extractInfo(d).note }}</div>
            </td>
            <td class="mono small">{{ fmtBytes(d.size_bytes) }}</td>
            <td class="mono small">{{ d.page_count || '—' }}</td>
            <td class="ops">
              <button type="button" :data-open-wiki="d.id" @click="openDoc(d, 'wiki')">知识库</button>
              <button type="button" :data-open-graph="d.id" @click="openDoc(d, 'graph')">图谱</button>
              <button v-if="d.kind === 'video'" type="button" :data-open-video="d.id" @click="openDoc(d, 'video')">视频</button>
              <button type="button" :data-delete="d.id" @click="remove(d)">删除</button>
              <!-- ★ 重新解析（Lead：后端有端点但前端没入口；**暂时禁用**并写明理由） -->
              <button type="button" :data-reparse="d.id" data-testid="btn-reparse"
                      :disabled="!REPARSE_ENABLED"
                      :data-reparse-enabled="REPARSE_ENABLED ? '1' : '0'"
                      @click="reparseDoc(d)">重新解析</button>
              <!-- ★ 代价可见（先展示再执行）：页数 → 区间；OCR 本地、不耗额度但占 CPU -->
              <div class="faint tiny" data-testid="reparse_estimate" :data-doc-est="d.id">{{ reparseEstimate(d) }}</div>
              <div v-if="reparseServerCost[d.id]" class="faint tiny" data-testid="reparse_server_cost"
                   :data-doc-cost="d.id">{{ reparseServerCost[d.id] }}</div>
              <div v-if="reparseState[d.id]" class="tiny" data-testid="reparse_state" :data-doc-state="d.id"
                   :data-progress="reparseState[d.id].progress ?? ''" :data-done="reparseState[d.id].done">
                {{ reparseState[d.id].text }}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <!-- ⚠️ 401（未登录）与"真的没有文档"是两回事：不能都说"还没有文档"（对着真后端实测踩到）
           模板里 ref 自动解包 → 写 `authError` 而不是 `authError.value` -->
      <div v-if="!rows.length && authError" class="note bad" data-testid="docs-unauthenticated">
        {{ authError }}
        <RouterLink :to="{ path: '/login', query: { next: '/docs' } }" style="margin-left: 6px">去登录 →</RouterLink>
      </div>
      <div v-else-if="!rows.length && !docsApi.loading.value" class="note info" data-testid="docs-empty">
        还没有文档。上传一份 PDF 或视频，服务端会跑解析 + 抽取；长任务有断点，可以中断后再续。
      </div>
      <div class="small faint" style="margin-top: 8px">
        提示：示例数据可用 <code>../数据库课程智能体调研/data/refman_extract/graph_view.json</code>（真实 1644 节点 / 481 边）验证图谱性能。
      </div>
    </div>
  </div>
</template>

<style scoped>
.docs-layout { padding: 14px 20px; max-width: 1100px; margin: 0 auto; }
.drop { border-style: dashed; }
.drop.over { border-color: var(--accent); background: var(--accent-soft); }
.row { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
.bar { height: 6px; background: #eceef1; border-radius: 3px; margin-top: 8px; overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--accent); transition: width .2s; }
.table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
.table th, .table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--rule); vertical-align: top; }
.ops { display: flex; gap: 4px; flex-wrap: wrap; }
</style>






