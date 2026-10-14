<script setup lang="ts">
/**
 * Docs —— 文档管理（上传 / 列表 / 进度 / 打开）
 *   · 上传走 POST /api/v1/documents（multipart），XHR 给上传进度
 *   · 解析/抽取是后台任务 → 用 TaskStream 订阅进度（SSE 主 + 轮询兜底）
 *   · 长任务必须能"看到进度"，而不是转圈等（C4 断点在服务端，前端负责可见）
 *   · 删除走 DELETE（级联）
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api/client'
import { TaskStream } from '../api/sse'
import { useDocuments } from '../composables/useCorpus'
import { fmtBytes, fmtMs } from '../utils/text'
import { testBarrier, testBarrierDone, writeReport } from '../utils/report'
import type { DocumentInfo } from '../api/types'

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
          <tr><th>标题</th><th>类型</th><th>状态</th><th>大小</th><th>页数</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="d in rows" :key="d.id" :data-doc="d.id" :data-kind="d.kind" :data-status="d.status">
            <td><b>{{ d.title }}</b><div class="faint tiny mono">{{ d.id }}</div></td>
            <td><span class="pill" :class="{ blue: d.kind === 'video' }">{{ d.kind }}</span></td>
            <td><span class="pill" :class="d.status === 'ready' ? 'ok' : d.status === 'failed' ? 'bad' : 'orange'">{{ d.status }}</span></td>
            <td class="mono small">{{ fmtBytes(d.size_bytes) }}</td>
            <td class="mono small">{{ d.page_count || '—' }}</td>
            <td class="ops">
              <button type="button" :data-open-wiki="d.id" @click="openDoc(d, 'wiki')">知识库</button>
              <button type="button" :data-open-graph="d.id" @click="openDoc(d, 'graph')">图谱</button>
              <button v-if="d.kind === 'video'" type="button" :data-open-video="d.id" @click="openDoc(d, 'video')">视频</button>
              <button type="button" :data-delete="d.id" @click="remove(d)">删除</button>
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






