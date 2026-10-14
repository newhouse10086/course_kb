<script setup lang="ts">
/**
 * Chat —— pi AI 助教（契约 §7.2 WebSocket；PROVIDERS §7 能力门控）
 *
 * 硬要求：
 *   · **流式逐字**（text_delta 累积渲染，不是一次性出完）
 *   · **工具调用可见**（tool_start/tool_update/tool_end：工具名 + 参数 + 耗时 + 成败）
 *   · **可中断**（停止按钮 → abort）
 *   · `settled` 才算一轮结束（不是 prompt 的响应）—— 契约 §7.3.1 ⚠️1
 *   · 失败**显式呈现**（error 事件 → 红条），绝不留"空回复"
 *   · pi / 模型任一不可用 → 禁用输入并写明 reason（不允许点了才报错）
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChatSocket, type ChatServerEvent } from '../api/chat'
import { useCaps } from '../composables/useCaps'
import { esc } from '../utils/text'
import { queryFlag, testBarrier, testBarrierDone, writeReport } from '../utils/report'

interface ToolCall { id: string; tool: string; args?: unknown; partial?: string; ok?: boolean; duration_ms?: number; done: boolean }
interface Msg { role: 'user' | 'assistant' | 'system'; text: string; thinking: string; tools: ToolCall[]; error?: { code?: string; msg?: string } }

const { caps } = useCaps()
const sessionId = `web-${Math.random().toString(36).slice(2, 10)}`
const input = ref('')
const msgs = ref<Msg[]>([])
const state = ref<'connecting' | 'open' | 'closed'>('connecting')
const stateNote = ref('')
const model = ref('')
const busy = ref(false)
const settledCount = ref(0)
const eventCount = ref(0)
let socket: ChatSocket | null = null

const piOk = computed(() => !!caps.value?.isAvailable('pi'))
const piReason = computed(() => caps.value?.reasonFor('pi') || 'pi 能力未上报')
const modelOk = computed(() => !!caps.value?.isAvailable('llm'))
const modelReason = computed(() => caps.value?.reasonFor('llm') || 'LLM 能力未上报')
const canSend = computed(() => piOk.value && modelOk.value && state.value === 'open' && !busy.value && input.value.trim().length > 0)

/**
 * pi 的两层能力（backend T-AGENT 的约定）：
 *   pi.available       —— SDK 可用（false → 整块禁用）
 *   pi.model.available —— **模型真探测**结果（SDK 可用但模型 403/402 → 允许进页面但禁用输入并显示原因）
 * 这里把第二层的 reason / resetAt 也显式呈现（否则用户只会看到"发不出去"）。
 */
const piModelStatus = computed(() => {
  const raw = (caps.value?.raw || {}) as any
  const pi = raw.pi || {}
  const m = pi.model || {}
  return {
    sdkAvailable: pi.available !== false,
    modelAvailable: m.available !== false,
    reason: String(m.reason || ''),
    resetAt: m.resetAt ? String(m.resetAt) : '',
    model: String(m.model || ''),
    degraded: !!pi.degraded,
  }
})
const piModelNote = computed(() => {
  const s = piModelStatus.value
  if (!s.reason) return ''
  return s.resetAt ? `${s.reason}（额度约在 ${s.resetAt} 重置）` : s.reason
})

function newAssistant(): Msg {
  const m: Msg = { role: 'assistant', text: '', thinking: '', tools: [] }
  msgs.value = [...msgs.value, m]
  return msgs.value[msgs.value.length - 1]
}
function updateLast(fn: (m: Msg) => void) {
  const arr = [...msgs.value]
  const last = arr[arr.length - 1]
  if (!last || last.role !== 'assistant') return
  fn(last)
  msgs.value = arr
}

function onEvent(e: ChatServerEvent) {
  eventCount.value++
  switch (e.type) {
    case 'ready':
      model.value = String((e as any).model || model.value)
      break
    case 'text_delta':
      updateLast((m) => { m.text += String((e as any).delta || '') })
      break
    case 'thinking_delta':
      updateLast((m) => { m.thinking += String((e as any).delta || '') })
      break
    case 'tool_start':
      updateLast((m) => m.tools.push({ id: String((e as any).id), tool: String((e as any).tool), args: (e as any).args, done: false }))
      break
    case 'tool_update':
      updateLast((m) => {
        const t = m.tools.find((x) => x.id === (e as any).id)
        if (t) t.partial = String((e as any).partial || '')
      })
      break
    case 'tool_end':
      updateLast((m) => {
        const t = m.tools.find((x) => x.id === (e as any).id)
        if (t) { t.done = true; t.ok = (e as any).ok !== false; t.duration_ms = (e as any).duration_ms }
      })
      break
    case 'error':
      updateLast((m) => { m.error = { code: (e as any).code, msg: (e as any).msg } })
      busy.value = false
      break
    case 'settled':
      // ★ 一轮结束的唯一信号（§7.3.1）
      busy.value = false
      settledCount.value++
      updateLast((m) => {
        if ((e as any).aborted) m.text += m.text ? '\n（已中断）' : '（已中断）'
        if (!m.text && !m.tools.length && !m.error) m.error = { code: 'E_EMPTY', msg: '本轮没有产生任何文本或工具调用（后端 error 事件缺失？）' }
      })
      break
    default:
      break
  }
}

function send() {
  if (!canSend.value) return
  const text = input.value.trim()
  input.value = ''
  msgs.value = [...msgs.value, { role: 'user', text, thinking: '', tools: [] }]
  newAssistant()
  busy.value = true
  socket?.prompt(text)
}
function steer() {
  if (!input.value.trim() || !busy.value) return
  socket?.steer(input.value.trim())
  msgs.value = [...msgs.value, { role: 'system', text: `插话：${input.value.trim()}`, thinking: '', tools: [] }]
  input.value = ''
}
function abort() {
  socket?.abort()
  msgs.value = [...msgs.value, { role: 'system', text: '已发送中断请求（等 settled 才认为结束）', thinking: '', tools: [] }]
}
function newSession() {
  socket?.newSession()
  msgs.value = []
  msgs.value.push({ role: 'system', text: '已请求新建会话', thinking: '', tools: [] })
}

onMounted(async () => {
  testBarrier()
  // ⚠️ 必须**先等能力接口返回**再判断门控：caps 是异步拉的，
  //    第一版在 onMounted 里直接读 piOk/modelOk → 能力还没到就误判成"不可用"，
  //    于是自检走了 gated 分支（页面看起来正常，但 ws/流式断言全空）。
  const { reload } = useCaps()
  if (!caps.value) await reload()
  if (!piOk.value || !modelOk.value || !piModelStatus.value.modelAvailable) {
    // 能力不可用：不建连、不假装能用（PROVIDERS §7 + T-AGENT 的两层能力约定）
    writeReport('chat-report', {
      ok: false, gated: true, session: sessionId,
      pi_available: piOk.value, pi_reason: piReason.value,
      model_available: modelOk.value, model_reason: modelReason.value || piModelNote.value,
    })
    if (queryFlag('selftest')) await runSelftest(true)
    await testBarrierDone()
    return
  }
  socket = new ChatSocket(sessionId)
  socket.onState((s, info) => { state.value = s; if (info) stateNote.value = info })
  socket.on('*', onEvent)
  writeReport('chat-report', {
    ok: true, gated: false, session: sessionId, url: socket.url,
    pi_available: true, model_available: true,
  })
  if (queryFlag('selftest')) await runSelftest(false)
  await testBarrierDone()
})

onBeforeUnmount(() => socket?.close())

/* ---------------- 自检：走真实 WebSocket（mock server 流式回放） ---------------- */

async function runSelftest(gated: boolean) {
  const checks: Record<string, unknown> = {}
  const failed: string[] = []
  const rec = (k: string, v: unknown) => { checks[k] = v }
  const need = (k: string, cond: boolean) => { if (!cond) failed.push(k) }

  if (gated) {
    const box = document.querySelector('[data-testid="chat-input"]') as HTMLTextAreaElement
    const btn = document.querySelector('[data-testid="chat-send"]') as HTMLButtonElement
    rec('gated', true)
    rec('input_disabled', box?.disabled ?? null)
    rec('send_disabled', btn?.disabled ?? null)
    rec('gate_reason', document.querySelector('[data-testid="chat-gate"]')?.textContent?.trim().slice(0, 120) || '')
    need('gated', box?.disabled === true && (checks.gate_reason as string).length > 0)
    const report = { ok: failed.length === 0, checks, failed }
    writeReport('selftest-report', report)
    return report
  }

  // 等 WS ready
  const t0 = Date.now()
  while (state.value !== 'open' && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100))
  rec('ws_state', state.value)
  rec('ws_url', socket?.url || '')
  need('ws_state', state.value === 'open')

  const box = document.querySelector('[data-testid="chat-input"]') as HTMLTextAreaElement
  ;(box as any).value = '解释一下聚簇索引'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 50))
  const btn = document.querySelector('[data-testid="chat-send"]') as HTMLButtonElement
  btn?.click()
  await new Promise((r) => setTimeout(r, 2500))

  const text = document.querySelector('[data-testid="assistant-text"]')?.textContent || ''
  rec('streamed_text', text)
  rec('text_ok', text.includes('聚簇索引') && text.length > 8)
  need('streamed_text', !!checks.text_ok)
  rec('thinking_shown', !!document.querySelector('[data-testid="thinking"]'))
  rec('tool_cards', document.querySelectorAll('[data-testid="tool-call"]').length)
  rec('tool_names', Array.from(document.querySelectorAll('[data-testid="tool-call"] .tool-name')).map((e) => e.textContent))
  need('tool_cards', Number(checks.tool_cards) > 0)
  rec('settled_count', settledCount.value)
  need('settled', settledCount.value > 0)
  rec('busy_after_settled', busy.value)
  need('busy_after_settled', busy.value === false)
  rec('events_seen', eventCount.value)
  rec('model', model.value)

  // 中断路径：发一条 → 立刻 abort → 期望收到 settled(aborted)
  const before = settledCount.value
  ;(box as any).value = '再讲一遍'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 30))
  btn?.click()
  await new Promise((r) => setTimeout(r, 200))
  const abortBtn = document.querySelector('[data-testid="chat-abort"]') as HTMLButtonElement
  abortBtn?.click()
  await new Promise((r) => setTimeout(r, 2000))
  rec('abort_settled_delta', settledCount.value - before)
  rec('abort_seen', (socket?.log || []).some((e) => e.type === 'settled' && (e as any).aborted === true))
  need('abort', settledCount.value > before)

  const report = { ok: failed.length === 0, checks, failed }
  writeReport('selftest-report', report)
  return report
}

const _esc = esc
void _esc
</script>

<template>
  <div class="chat-layout">
    <div class="panel chat-head">
      <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
        <b>pi AI 助教</b>
        <span class="pill" :class="state === 'open' ? 'ok' : 'bad'" data-testid="ws-state">{{ state }}</span>
        <span v-if="model" class="pill blue">{{ model }}</span>
        <span v-if="stateNote" class="small faint" data-testid="ws-note">{{ stateNote }}</span>
        <span class="right" />
        <button type="button" data-testid="chat-newsession" @click="newSession">新会话</button>
      </div>
      <div v-if="!piOk || !modelOk" class="note bad" style="margin-top: 8px" data-testid="chat-gate">
        <b>对话入口已禁用</b>
        <ul style="margin: 4px 0 0; padding-left: 18px">
          <li v-if="!piOk">pi 不可用：{{ piReason }}</li>
          <li v-if="!modelOk">模型不可用：{{ modelReason }}</li>
        </ul>
        <div class="small" style="margin-top: 4px">按 PROVIDERS §7：能力不可用时禁用入口并显示原因，不允许点了才报错。</div>
      </div>
    </div>

    <div class="chat-log panel" data-testid="chat-log">
      <div v-for="(m, i) in msgs" :key="i" class="msg" :class="m.role">
        <div class="role">{{ m.role === 'user' ? '我' : m.role === 'assistant' ? 'pi' : '系统' }}</div>
        <div class="body">
          <div v-if="m.thinking" class="thinking small faint" data-testid="thinking">
            <details><summary>思考过程</summary><pre>{{ m.thinking }}</pre></details>
          </div>
          <div v-for="t in m.tools" :key="t.id" class="tool" :data-tool="t.tool" data-testid="tool-call">
            <span class="tool-name">{{ t.tool }}</span>
            <span class="faint tiny mono">{{ JSON.stringify(t.args || {}).slice(0, 120) }}</span>
            <span v-if="!t.done" class="pill">运行中…</span>
            <span v-else class="pill" :class="t.ok ? 'ok' : 'bad'">{{ t.ok ? '成功' : '失败' }} {{ t.duration_ms ?? '—' }}ms</span>
            <div v-if="t.partial" class="evidence">{{ t.partial.slice(0, 160) }}</div>
          </div>
          <div v-if="m.text" class="text" :data-testid="m.role === 'assistant' ? 'assistant-text' : ''">{{ m.text }}</div>
          <div v-if="m.error" class="note bad" :data-error-code="m.error.code" data-testid="chat-error">
            <b>错误</b> <span class="mono">{{ m.error.code }}</span>：{{ m.error.msg }}
          </div>
        </div>
      </div>
      <div v-if="!msgs.length" class="faint small">还没有对话。问点什么，比如"聚簇索引和二级索引的区别"。</div>
    </div>

    <div class="chat-input panel">
      <textarea
        ref="box"
        v-model="input"
        data-testid="chat-input"
        :disabled="!piOk || !modelOk"
        rows="3"
        placeholder="问知识点 / 让 pi 读某节原文（Enter 发送，Shift+Enter 换行）"
        @keydown.enter.exact.prevent="send"
      />
      <div class="row">
        <button type="button" class="primary" data-testid="chat-send" :disabled="!canSend" @click="send">发送</button>
        <button type="button" data-testid="chat-steer" :disabled="!busy" @click="steer">插话（steer）</button>
        <button type="button" data-testid="chat-abort" :disabled="!busy" @click="abort">停止（abort）</button>
        <span class="small faint">busy={{ busy }} · settled={{ settledCount }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 对话 = 誊抄稿（transcript）：mono 角色栏 + 细线分隔 + 工具调用当"旁注" */
.chat-layout { display: flex; flex-direction: column; gap: 12px; padding: 14px 22px 40px; max-width: 1020px; margin: 0 auto; }
.chat-log { min-height: 300px; max-height: 56vh; overflow: auto; border: var(--hair) solid var(--rule); border-top: 2px solid var(--rule-strong); border-radius: var(--r-sm); background: var(--panel); padding: 4px 14px; }
.msg { display: flex; gap: 12px; padding: 8px 0; border-bottom: var(--hair) solid var(--rule); }
.msg:last-child { border-bottom: none; }
.msg .role {
  flex: 0 0 52px; text-align: right;
  font-family: var(--font-mono); font-size: var(--fs-meta); letter-spacing: .06em;
  color: var(--muted); padding-top: 3px; text-transform: uppercase;
}
.msg.assistant .role { color: var(--accent); }
.msg .body { flex: 1; min-width: 0; }
.msg.user .body .text { font-weight: 600; }
.msg .text { white-space: pre-wrap; }
.tool {
  border: var(--hair) solid var(--rule);
  border-left: 3px solid var(--ink-2);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  background: var(--paper-2);
  padding: 3px 8px; margin: 4px 0; font-size: 12px;
  display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
}
.tool-name { font-family: var(--font-mono); font-weight: 700; color: var(--ink); }
.chat-input textarea { width: 100%; font-family: var(--font-body); font-size: 13.5px; border: var(--hair) solid var(--rule-strong); border-radius: var(--r-sm); padding: 8px; background: var(--panel); color: var(--ink); }
.chat-input .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
.thinking { border-left: 3px solid var(--rule-strong); padding-left: 8px; margin: 4px 0; }
.thinking pre { white-space: pre-wrap; margin: 4px 0 0; background: transparent; border: none; padding: 0; color: var(--ink-2); }
</style>




