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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChatSocket, type ChatServerEvent } from '../api/chat'
import { useCaps } from '../composables/useCaps'
import { esc } from '../utils/text'
import { queryFlag, testBarrier, testBarrierDone, writeReport } from '../utils/report'

interface ToolCall { id: string; tool: string; args?: unknown; partial?: string; ok?: boolean; duration_ms?: number; done: boolean; result_text?: string }
interface Msg { role: 'user' | 'assistant' | 'system'; text: string; thinking: string; tools: ToolCall[]; error?: { code?: string; msg?: string } }

/**
 * ★ 本组件是**共用的对话组件**（Lead 要求：整页与全局小助手**不写两套**）：
 *   · `/chat` 整页 → `<Chat />`（默认 variant="page"，带自检 / 报告 / 同步屏障）
 *   · 全局小助手抽屉 → `<Chat embedded :context="ctx" />`
 *     `embedded` 时**跳过页面级副作用**（report / barrier / selftest），只做对话。
 */
const props = withDefaults(defineProps<{
  embedded?: boolean
  /** 页面上下文（**只传 id**；由 useAssistantContext 提供） */
  context?: Record<string, string | number>
  /** 抽屉标题（如"小助手 · 知识库"） */
  title?: string
}>(), { embedded: false, context: () => ({}), title: 'pi AI 助教' })

const { caps, error: capsError } = useCaps()
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

/* ─────────────────────────────────────────────────────────────────────────
 * 检索模式徽标（契约 §4 / docs/RETRIEVAL.md §2；字段名已与 pi-bridge 逐条对齐）
 *   ① 本次用了哪种检索（none/wiki/kg/rag）+ 命中几条 + 耗时
 *   ② available=false → "未使用知识库" + 可读原因
 *   ③ why（字符串数组）可展开；sources 给标题 + 跳转
 *   ④ ★ none（没查库）与 empty（查了 0 命中）**判色/文案都不同** —— 用户能一眼看出
 *   ⑤ tool 调用是**同轮独立帧**（retrieval → tool_* → text_delta → settled）→ 按轮归组展示
 * ───────────────────────────────────────────────────────────────────────── */
export type RetrievalStatus = 'none' | 'ok' | 'empty' | 'unavailable' | 'error'
export interface RetrievalSource { kind?: string; ref_id?: string; title?: string; score?: number }
export interface RetrievalState {
  mode: 'none' | 'wiki' | 'kg' | 'rag' | string
  /** ★ 权威判据（pi-bridge 契约）：不要用 available/hits 猜 */
  status: RetrievalStatus
  available: boolean
  hits: number
  elapsedMs: number | null
  why: string[]
  reason: string
  sources: RetrievalSource[]
}

/**
 * ⚠️ pi-bridge 实测：模型会把**原始 tool 调用标记**写进正文（`<｜｜DSML｜｜invoke name="bash">`），
 *    因为 chat/答疑会话的 `tools: []` → 工具调用退化成文本。后端**不过滤**（怕误伤正常文本）→
 *    前端兜底：折叠成可读提示，别把标记当 Markdown 渲染成乱码。
 */
const TOOL_MARKER = /<\uFF5C[^>]*\uFF5C[^>]*>|<\uFF5C[\s\S]{0,80}?\uFF5C>/g
function foldToolMarkers(text: string): { text: string; folded: number } {
  let folded = 0
  const out = String(text || '').replace(/<\uFF5C[^>]{0,200}>/g, () => { folded++; return '' })
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), folded }
}
const retrieval = ref<RetrievalState | null>(null)
/** 本轮会话**实际可用**的工具（`ready.tools` 真值）与其来源标签（pi-bridge 三态） */
const sessionTools = ref<string[]>([])
/**
 * ★ chat / agent 模式（用户需求）—— 与 `retrieval` **正交**：
 *   · mode=chat  → 快，只用检索摘要（`ready.tools = []`）
 *   · mode=agent → 能调用 `kb_search`/`kb_get` **读知识库原文**，慢一些（**仍无** bash/read 主机工具）
 * ⚠️ pi-bridge 契约：模式回显字段是 **`ready.agent_mode`**（`ready.mode` 是执行模式，恒 'sdk'）；
 *    切换模式 = **新上下文**（后端会重发一帧 ready）。
 */
const chatMode = ref<'chat' | 'agent'>('chat')
/** 后端**实际**给的模式（不信自己选的） */
const backendMode = ref('')
const modeNote = ref('')
/**
 * ★ `/capabilities.chat_modes` —— **服务端权威清单**（backend-api 实测）：
 *   `{modes, default, tools:{chat:[],agent:['kb_search','kb_get']}, allowed_roles:{agent:['admin','teacher']}, kb:{available,readonly,scoped_by}, note}`
 * ⚠️ **不按 `user.roles` 推断**（这轮已经因为"按预期形状读"吃过亏）—— 只读这个字段。
 */
const chatModes = computed(() => ((caps.value?.raw as any)?.chat_modes || {}) as {
  modes?: string[]; default?: string
  tools?: Record<string, string[]>
  allowed_roles?: Record<string, string[]>
  kb?: { available?: boolean; readonly?: boolean; scoped_by?: string }
  note?: string
})
/** 我当前的角色（用来判断某模式是否被允许 —— 角色清单仍来自服务端字段） */
const myRoles = computed<string[]>(() => {
  const raw = (caps.value?.raw as any) || {}
  return raw.user?.roles || raw.roles || []
})
/** 某模式是否被服务端允许（allowed_roles 缺省 = 不限制） */
function modeAllowed(m: 'chat' | 'agent'): boolean {
  const allowed = chatModes.value.allowed_roles?.[m]
  if (!allowed || !allowed.length) return true
  if (!myRoles.value.length) return true          // 角色未上报 → 不擅自禁用（让后端拒）
  return myRoles.value.some((r) => allowed.includes(r))
}
const agentAllowed = computed(() => modeAllowed('agent'))
const agentBlockReason = computed(() => agentAllowed.value ? ''
  : `你的角色（${myRoles.value.join(', ') || '未上报'}）不在 agent 允许清单（${(chatModes.value.allowed_roles?.agent || []).join('/')}）—— 只读 chat`)
/** 知识库为空：agent 必然 0 命中 → 如实提示"先上传并抽取"（别让它看起来像检索坏了） */
const kbEmpty = computed(() => !!((caps.value?.raw as any)?.retrieval?.summary?.empty_kb))
const kbEmptyHint = computed(() => String(((caps.value?.raw as any)?.retrieval?.summary?.hint) || '知识库当前为空（未抽取）→ 先上传资料并跑抽取，否则任何检索都必然 0 命中'))

/** 检索选择（与 mode 正交的第二个控件；缺省 none = 不检索） */
const retrievalChoice = ref<'none' | 'wiki' | 'kg' | 'rag'>('none')
/**
 * 页面上下文（Lead 2026-10-15 裁定）：**只传 id**，服务端解析成真实标题/正文。
 * 本组件由页面通过 props 注入（整页对话传空；小助手传当前页上下文）。
 */
const pageContext = ref<Record<string, string | number>>({ ...props.context })
// 上下文变化（页面切换 / 小助手打开时）→ 下一轮带上
watch(() => props.context, (v) => { pageContext.value = { ...(v || {}) } }, { deep: true })

/** 服务端**实际用了**哪些上下文（第 11 种帧 `context`）—— 显示"正在参考：…" */
const contextResolved = ref<{ doc_title?: string; unit_title?: string }>({})
const contextDropped = ref<Array<{ field: string; value?: string; reason?: string }>>([])
const contextUsed = ref<Record<string, unknown>>({})
/**
 * ★ 坑 21（扩展）：`context` 帧的 `used/resolved` 是**自述**，必须有"真的用上了"的**证据**。
 *   证据来源（可核验）：本轮 `retrieval.sources`（真检索命中）或 kb 工具帧（真读了卡片）。
 */
const contextEvidence = computed(() => {
  const hits = retrieval.value?.hits || 0
  const kbTools = roundTools.value.filter((x) => x.tool === 'kb_search' || x.tool === 'kb_get')
  return { hits, kbTools: kbTools.length, has: hits > 0 || kbTools.length > 0 }
})
const contextClaim = computed(() => !!(contextResolved.value.doc_title || contextResolved.value.unit_title))
/** 声明了参考、但本轮**没有任何证据** → 如实提示（不许让用户以为"它看过我这一节"） */
const contextUnverified = computed(() => contextClaim.value && !contextEvidence.value.has)
const toolsSource = ref('')
const TOOLS_SOURCE_LABEL: Record<string, string> = {
  'disabled-by-role': '按角色/缺省关闭（无工具 —— **这是正确的安全状态**）',
  explicit: '显式白名单',
  // pi-bridge 新增：agent 模式的工具来源（只读知识库工具）
  'kb-readonly': '知识库**只读**工具（kb_search / kb_get）',
  'dangerous-opt-in': '⚠️ 有人在服务端显式开启了危险工具',
}
const toolsSourceLabel = computed(() => TOOLS_SOURCE_LABEL[toolsSource.value] || (toolsSource.value || '未上报'))
/** capabilities.pi.toolsWarning：非 null = 会话工具回落到 pi 默认全集（**能执行命令的信号**） */
const toolsWarningFromFrame = ref('')
/** 优先用帧里的 `ready.tools_warning`（最权威、最及时）；其次 caps.pi.toolsWarning */
const toolsWarning = computed(() => toolsWarningFromFrame.value || String(((caps.value?.raw as any)?.pi?.toolsWarning) || ''))
const whyOpen = ref(false)
/** 同轮的工具调用（retrieval → settled 之间） */
const roundTools = ref<Array<{ id: string; tool: string; args?: unknown; done: boolean; ok?: boolean }>>([])

const STATUS_FALLBACK: Record<string, RetrievalStatus> = {}
/** 兼容：有 status 就用 status；没有就按 available/hits 推（老后端/别的实现） */
function deriveStatus(raw: any, mode: string, available: boolean, hits: number): RetrievalStatus {
  const s = String(raw?.status || '')
  if (['none', 'ok', 'empty', 'unavailable', 'error'].includes(s)) return s as RetrievalStatus
  if (!available) return 'unavailable'
  if (mode === 'none') return 'none'
  return hits > 0 ? 'ok' : 'empty'
}

function normalizeRetrieval(e: any): RetrievalState {
  const r = e?.retrieval && typeof e.retrieval === 'object' ? e.retrieval : e
  const mode = String(r?.mode || 'none')
  const available = r?.available !== false
  const sources: RetrievalSource[] = Array.isArray(r?.sources) ? r.sources : (Array.isArray(r?.items) ? r.items : [])
  const hits = Number.isFinite(Number(r?.hits)) ? Number(r.hits) : sources.length
  const status = deriveStatus(r, mode, available, hits)
  const whyRaw = r?.why
  const why = Array.isArray(whyRaw) ? whyRaw.map((x: unknown) => String(x)) : (whyRaw ? [String(whyRaw)] : [])
  return {
    mode, status, available, hits,
    elapsedMs: Number.isFinite(Number(r?.elapsedMs)) ? Number(r.elapsedMs) : null,
    why, reason: String(r?.reason || ''), sources,
  }
}

const MODE_LABEL: Record<string, string> = {
  none: 'none（不检索）', wiki: 'wiki（词法/bigram）', kg: 'kg（图谱遍历）', rag: 'rag（向量）',
}
const retrievalLabel = computed(() => {
  const r = retrieval.value
  if (!r) return ''
  const mode = MODE_LABEL[r.mode] || r.mode
  switch (r.status) {
    case 'none': return `${mode}：本次没查库`
    case 'empty': return `${mode}：查了但 0 命中`
    case 'unavailable': return `${mode}：不可用，未使用知识库`
    case 'error': return `${mode}：检索出错`
    default: return `${mode}：命中 ${r.hits} 条`
  }
})
const retrievalTime = computed(() => (retrieval.value?.elapsedMs != null ? `${(retrieval.value.elapsedMs / 1000).toFixed(1)}s` : ''))

const piOk = computed(() => !!caps.value?.isAvailable('pi'))
const piReason = computed(() => caps.value?.reasonFor('pi') || 'pi 能力未上报')
const modelOk = computed(() => !!caps.value?.isAvailable('llm'))
const modelReason = computed(() => caps.value?.reasonFor('llm') || 'LLM 能力未上报')
/**
 * caps 是否还在探测（真后端首次可达 19.4s；之后 15s 缓存内毫秒级）
 * ★ Lead 裁定：**慢的能力探测不该阻塞可用功能** → 探测中允许发消息，失败再如实报错
 */
const capsPending = computed(() => !caps.value && !capsError.value)
/** 门控：只有 caps **已到达且确实不可用**时才禁用（探测中不禁用） */
const gated = computed(() => !capsPending.value && (!piOk.value || !modelOk.value || !piModelStatus.value.modelAvailable))
const canSend = computed(() => !gated.value && state.value === 'open' && !busy.value && input.value.trim().length > 0)

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
      // ★ pi-bridge：**判断工具有没有一律用 `ready.tools`（真值）**，`tools_source` 只是来源标签
      //   三态：disabled-by-role（学生/教师，tools 必为 []）/ admin-full（管理员默认全集）/ explicit（显式白名单）
      sessionTools.value = Array.isArray((e as any).tools) ? (e as any).tools.map((x: unknown) => String(x)) : []
      toolsSource.value = String((e as any).tools_source || '')
      // ★ pi-bridge 新增 `ready.tools_warning`（只在危险工具被显式开启时出现）：
      //   **不用匹配枚举值，直接看有没有** —— 有就显示成醒目横幅（等价于"能把服务器 shell 交给浏览器用户"）
      const w = String((e as any).tools_warning || '')
      if (w) toolsWarningFromFrame.value = w
      // ★ 模式回显：`agent_mode`（不是 `mode`）——把自己选的与后端给的**分开显示**
      backendMode.value = String((e as any).agent_mode || '')
      modeNote.value = ''
      if (backendMode.value && backendMode.value !== chatMode.value) {
        modeNote.value = `你选的是 ${chatMode.value}，后端实际按 ${backendMode.value} 执行`
      } else if (chatMode.value === 'agent' && !sessionTools.value.includes('kb_search')) {
        // 知识库未接入 / 角色限制：**如实说"没有可用工具"**，不假装 agent 生效
        modeNote.value = `你选了 agent，但后端本会话没有给知识库工具${toolsWarning.value ? `：${toolsWarning.value}` : ''}`
      }
      break
    case 'text_delta':
      updateLast((m) => { m.text += String((e as any).delta || '') })
      break
    case 'thinking_delta':
      updateLast((m) => { m.thinking += String((e as any).delta || '') })
      break
    case 'tool_start': {
      /**
       * ★ **按 call id 分组**（backend-api/Lead 2026-10-15）：
       *   同一次工具调用可能被重复发 `tool_start`（帧层重复）→ **同 id 不重复显示**；
       *   id 不同 = 模型真的调了两次 → **如实显示两次**（去重会变成谎报）。
       *   这样不依赖"重复发 vs 真调两次"的结论，天然正确。
       */
      const tid = String((e as any).id)
      updateLast((m) => {
        const exist = m.tools.find((x) => x.id === tid)
        if (exist) { exist.args = (e as any).args ?? exist.args; return }
        m.tools.push({ id: tid, tool: String((e as any).tool), args: (e as any).args, done: false })
      })
      roundTools.value = roundTools.value.some((x) => x.id === tid)
        ? roundTools.value
        : [...roundTools.value, { id: tid, tool: String((e as any).tool), args: (e as any).args, done: false }]
      break
    }
    case 'tool_update':
      updateLast((m) => {
        const t = m.tools.find((x) => x.id === (e as any).id)
        if (t) t.partial = String((e as any).partial || '')
      })
      break
    case 'tool_end':
      updateLast((m) => {
        const t = m.tools.find((x) => x.id === (e as any).id)
        if (t) {
          t.done = true; t.ok = (e as any).ok !== false; t.duration_ms = (e as any).duration_ms
          // pi-bridge：`tool_end.result_text` 是工具返回文本（他会**截断**，正文不整篇下发）
          if ((e as any).result_text != null) t.result_text = String((e as any).result_text).slice(0, 400)
        }
      })
      roundTools.value = roundTools.value.map((x) => (x.id === String((e as any).id)
        ? { ...x, done: true, ok: (e as any).ok !== false } : x))
      break
    /**
     * ★ 检索模式帧（契约 §4 / docs/RETRIEVAL.md §2）—— 用户裁决的一部分：
     *   "让 UI 能展示这次用的是哪种检索、命中了什么"。
     *   形状按 `Retrieved`：`{mode, items[], elapsedMs, available, reason?}`；
     *   帧可能把整块放在 `retrieval` 字段里（我两种都吃，等 pi-bridge 确认后收敛成一种）。
     */
    /**
     * ★ 第 11 种帧 `context`（Lead 裁定）：服务端实际用了哪些上下文。
     *   与 retrieval 正交（retrieval:'none' 时 context 仍在）；`resolved` 是**服务端解析出的真实标题**。
     *   `dropped` 非空必须**如实显示**（不许静默）——否则用户会以为"它看到了我这一节"。
     */
    case 'context':
      contextResolved.value = ((e as any).resolved || {}) as any
      contextDropped.value = Array.isArray((e as any).dropped) ? (e as any).dropped : []
      contextUsed.value = ((e as any).used || {}) as any
      break
    case 'retrieval':
      // 每轮恰好一帧（pi-bridge 保证）→ 开新的一轮，工具帧归到这一轮
      retrieval.value = normalizeRetrieval(e)
      roundTools.value = []
      whyOpen.value = false
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
  socket?.prompt(text, false, {
    mode: chatMode.value,
    retrieval: retrievalChoice.value,
    // 只传 id（服务端解析；不可信输入不进提示词）
    context: Object.keys(pageContext.value).length ? (pageContext.value as any) : undefined,
  })
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
/**
 * 切模式（chat ⇄ agent）：pi-bridge 契约是**切换 = 切上下文**（两个独立会话），后端会重发 `ready`。
 * 这里**如实提示"上下文会重新开始"**，不假装无缝。
 */
function setMode(m: 'chat' | 'agent') {
  if (m === chatMode.value) return
  if (!modeAllowed(m)) { modeNote.value = agentBlockReason.value; return }
  chatMode.value = m
  backendMode.value = ''
  // ★ backend-api 实测：**模式是连接级参数**（pi 把 mode 编进会话 key，工具集建会话时确定）
  //   → 切模式必须**重连**；会丢上下文，这是有意取舍（UI 要如实说）
  modeNote.value = (m === 'agent'
    ? '已切到 agent：可调用知识库工具读原文（kb_search/kb_get）。'
    : '已切回 chat：只用检索摘要（更快）。')
    + '**模式是会话级的 → 已重新连接，上下文重新开始。**'
  reconnect()
}

/** 用当前模式重连（保留 chatSessionId；上下文按后端语义重新开始） */
function reconnect() {
  try { socket?.close() } catch { /* ignore */ }
  msgs.value = []
  retrieval.value = null
  roundTools.value = []
  contextResolved.value = {}
  contextDropped.value = []
  state.value = 'connecting'
  startSocket()
}

function newSession() {
  socket?.newSession()
  msgs.value = []
  msgs.value.push({ role: 'system', text: '已请求新建会话', thinking: '', tools: [] })
}

onMounted(async () => {
  // 抽屉里的实例**不做页面级副作用**（不写 report、不同步屏障、不跑自检）
  if (props.embedded) {
    const { reload } = useCaps()
    void reload()
    startSocket()
    return
  }
  testBarrier()
  /**
   * ★ Lead 裁定（2026-10-15）：**慢的能力探测不该阻塞可用功能**。
   *   · 进对话页只判鉴权（401 由 client 的 handler 统一跳登录）→ **立刻连 WS**
   *   · caps 还在探测 → 显示"能力探测中（真探测较慢）"并**允许先试**；
   *     徽标/正文都来自后端帧，**不依赖 caps**
   *   · caps 到达后若确实不可用 → 仍然如实禁用 + 显示原因（契约 §7 不能放弃）
   *   ⚠️ 第一版是"先 await caps 再判断"：真后端 caps 19.4s → 页面卡在 connecting，
   *      看起来像 WS 坏了（实测踩到）。
   */
  const { reload } = useCaps()
  void reload()                       // 后台预热（命中 15s 缓存后后续毫秒级）
  startSocket()
  writeReport('chat-report', {
    ok: true, gated: false, caps_pending: capsPending.value, session: sessionId, url: socket?.url || '',
    mode: chatMode.value, pi_available: piOk.value, model_available: modelOk.value,
  })
  // caps 到达后**重写报告**（连 WS 不等 caps，但报告必须反映"能力到达后的真值"）
  watch(caps, () => {
    if (!socket) return
    writeReport('chat-report', {
      ok: true, gated: gated.value, caps_pending: capsPending.value, session: sessionId, url: socket?.url || '', mode: chatMode.value,
      pi_available: piOk.value, model_available: modelOk.value,
      pi_reason: piReason.value, model_reason: modelReason.value || piModelNote.value,
    })
  })
  if (queryFlag('selftest')) await runSelftest(gated.value)
  await testBarrierDone()
})

/** 建连（模式走 URL 查询参数） */
function startSocket() {
  socket = new ChatSocket(sessionId, undefined, chatMode.value)
  socket.onState((s, info) => { state.value = s; if (info) stateNote.value = info })
  socket.on('*', onEvent)
}

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
        <span class="small" :class="toolsSource === 'dangerous-opt-in' ? 'tools-danger' : 'faint'"
              data-testid="session-tools" :data-tools="sessionTools.join(',')" :data-source="toolsSource">
          工具：{{ sessionTools.length ? sessionTools.join(', ') : '无' }}
          <span v-if="toolsSource">（{{ toolsSourceLabel }}）</span>
        </span>
        <!-- ★ dangerous-opt-in = 异常状态，用最刺眼的样式（不是"管理员正常状态"） -->
        <span v-if="toolsSource === 'dangerous-opt-in'" class="pill bad" data-testid="tools-danger">
          ⚠️ 本会话已开启主机工具（{{ sessionTools.join(', ') || '见 tools' }}）
        </span>
        <span class="right" />
        <button type="button" data-testid="chat-newsession" @click="newSession">新会话</button>
      </div>

      <!-- ★ 两个**正交**控件（Lead 要求别混成一个下拉）：
           ① 模式：能不能读原文（chat 只用摘要 / agent 可调 kb_search+kb_get）
           ② 检索：查不查、怎么查（none/wiki/kg/rag） -->
      <div class="mode-row" data-testid="mode-row">
        <div class="seg" data-testid="mode-select" :data-mode="chatMode">
          <button type="button" :class="{ on: chatMode === 'chat' }" data-testid="mode-chat" @click="setMode('chat')">chat</button>
          <button type="button" :class="{ on: chatMode === 'agent' }" data-testid="mode-agent"
                  :disabled="!agentAllowed" :title="agentAllowed ? '' : agentBlockReason"
                  @click="setMode('agent')">agent</button>
        </div>
        <span class="small faint" data-testid="mode-explain">
          chat：快，只用检索摘要 ｜ agent：能翻知识库原文（kb_search/kb_get），慢一些
        </span>
        <label class="small" data-testid="retrieval-select-label">检索
          <select v-model="retrievalChoice" data-testid="retrieval-select">
            <option value="none">none（不检索）</option>
            <option value="wiki">wiki（词法/bigram）</option>
            <option value="kg">kg（图谱遍历）</option>
            <option value="rag">rag（向量）</option>
          </select>
        </label>
        <!-- 后端实际给的模式（不信自己选的） -->
        <span class="pill" :class="backendMode === chatMode ? 'ok' : 'warn'" data-testid="backend-mode"
              :data-backend-mode="backendMode">
          后端：{{ backendMode || '未上报' }}
        </span>
      </div>
      <div v-if="modeNote" class="note warn" style="margin-top: 6px" data-testid="mode-note">{{ modeNote }}</div>
      <div v-if="!agentAllowed" class="small faint" style="margin-top: 4px" data-testid="agent-blocked">{{ agentBlockReason }}</div>
      <!-- ★ 知识库为空：agent 必然 0 命中 → 如实提示"先上传并抽取"，别让它看起来像检索坏了 -->
      <div v-if="kbEmpty" class="note warn" style="margin-top: 6px" data-testid="kb-empty">
        <b>知识库为空</b>：{{ kbEmptyHint }}
      </div>

      <!-- ★ 正在参考什么（服务端解析出的**真实标题**，不是客户端传来的 id） -->
      <div v-if="contextResolved.doc_title || contextResolved.unit_title || contextDropped.length"
           class="small ctx-bar" data-testid="context-used"
           :data-doc="contextResolved.doc_title || ''" :data-unit="contextResolved.unit_title || ''">
        <b>服务端声明参考：</b>
        <span>{{ contextResolved.doc_title || '（未解析到文档）' }}</span>
        <span v-if="contextResolved.unit_title"> › {{ contextResolved.unit_title }}</span>
        <!-- ★ 自述字段必须有证据（坑 21）：有检索/工具证据才算"真的用上了" -->
        <span v-if="contextEvidence.has" class="pill ok" data-testid="context-evidence">
          有证据：检索命中 {{ contextEvidence.hits }} 条{{ contextEvidence.kbTools ? ` / kb 工具 ${contextEvidence.kbTools} 次` : '' }}
        </span>
        <span v-else class="pill warn" data-testid="context-unverified">
          未验证：本轮没有检索/工具证据（声明与实际可能不一致，以回答为准）
        </span>
        <span v-if="contextDropped.length" class="bad-text" data-testid="context-dropped">
          ｜已忽略：{{ contextDropped.map((d) => `${d.field}（${d.reason || '未找到或无权访问'}）`).join('、') }}
        </span>
      </div>
      <!-- ★ 工具回落警告：非 null 表示会话工具回落到 pi 默认全集（**能执行命令**） -->
      <div v-if="toolsWarning" class="note bad" style="margin-top: 8px" data-testid="tools-warning">
        <b>⚠️ 本会话已开启主机工具</b>：{{ toolsWarning }}
        <div class="small" style="margin-top: 4px">这意味着会话可能拿到 pi 的默认工具集（含命令执行）—— 请让后端确认策略，前端不自行拦截。</div>
      </div>
      <!-- 探测中：如实说"还在探测"，但**允许先试**（不阻塞可用功能） -->
      <div v-if="capsPending" class="note warn" style="margin-top: 8px" data-testid="caps-pending">
        <b>能力探测中（真探测较慢）</b>：现在就可以发消息 —— 若后端确实不可用，会在这一轮如实报错；
        检索模式徽标来自后端帧，不依赖能力接口。
      </div>
      <div v-else-if="!piOk || !modelOk || !piModelStatus.modelAvailable" class="note bad" style="margin-top: 8px" data-testid="chat-gate">
        <b>对话入口已禁用</b>
        <ul style="margin: 4px 0 0; padding-left: 18px">
          <li v-if="!piOk">pi 不可用：{{ piReason }}</li>
          <li v-if="!modelOk">模型不可用：{{ modelReason }}</li>
        </ul>
        <div class="small" style="margin-top: 4px">按 PROVIDERS §7：能力不可用时禁用入口并显示原因，不允许点了才报错。</div>
      </div>

      <!-- ★ 检索模式徽标：本次用了哪种检索 / 命中几条 / 耗时；none 与"查了没命中"必须一眼可分 -->
      <div
        v-if="retrieval"
        class="retr-bar"
        data-testid="retrieval-badge"
        :data-mode="retrieval.mode"
        :data-status="retrieval.status"
        :data-searched="retrieval.status !== 'none' && retrieval.available ? '1' : '0'"
        :data-available="retrieval.available ? '1' : '0'"
        :data-hits="retrieval.hits"
      >
        <span class="retr-badge" :data-status="retrieval.status">{{ retrievalLabel }}</span>
        <span v-if="retrievalTime" class="small faint">耗时 {{ retrievalTime }}</span>
        <span v-if="(retrieval.status === 'unavailable' || retrieval.status === 'error') && retrieval.reason"
              class="small" data-testid="retrieval-reason">原因：{{ retrieval.reason }}</span>
        <span v-else-if="retrieval.status === 'none'" class="small faint" data-testid="retrieval-none-note">
          （没查知识库 → 与「查了但没命中」不是一回事）
        </span>
        <span v-else-if="retrieval.status === 'empty'" class="small" data-testid="retrieval-empty-note">
          （查了、可用，但没命中 → 不是「没查库」）
        </span>
        <!-- 同轮工具调用：wiki 那次真的去查了 sqlite —— 不显示用户就不知道它做了额外工作 -->
        <span v-for="t in roundTools" :key="t.id" class="pill" :class="{ ok: t.done && t.ok !== false, bad: t.done && t.ok === false }"
              data-testid="retrieval-tool" :data-tool="t.tool">
          tool: {{ t.tool }}{{ t.done ? (t.ok === false ? ' ✗' : ' ✓') : ' …' }}
        </span>
        <button v-if="retrieval.why.length || retrieval.sources.length" type="button" class="small"
                data-testid="retrieval-why-toggle" @click="whyOpen = !whyOpen">
          {{ whyOpen ? '收起依据 ▾' : `看依据（${retrieval.sources.length || retrieval.why.length}） ▸` }}
        </button>
        <div v-if="whyOpen" class="retr-why" data-testid="retrieval-why">
          <div v-for="(w, i) in retrieval.why" :key="`w${i}`" class="small" data-testid="retrieval-why-line">· {{ w }}</div>
          <div v-for="(s, i) in retrieval.sources" :key="`s${i}`" class="retr-item">
            <span class="pill" :class="{ blue: s.kind === 'card' }">{{ s.kind || 'unit' }}</span>
            <b>{{ s.title || s.ref_id }}</b>
            <span v-if="s.score != null" class="faint mono tiny">score {{ s.score }}</span>
            <span v-if="s.ref_id" class="faint mono tiny">{{ s.ref_id }}</span>
          </div>
          <div v-if="!retrieval.sources.length" class="small faint">（后端只给了 why，没给 sources —— 正文不下发是设计如此）</div>
        </div>
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
          <div v-if="m.text" class="text" :data-testid="m.role === 'assistant' ? 'assistant-text' : ''">{{ foldToolMarkers(m.text).text }}</div>
          <!-- ⚠️ 模型把原始 tool 标记写进正文（pi-bridge 实测：tools:[] 时工具调用退化成文本）→ 折叠并如实告知 -->
          <div v-if="m.role === 'assistant' && foldToolMarkers(m.text).folded > 0" class="small faint"
               data-testid="tool-marker-folded" :data-count="foldToolMarkers(m.text).folded">
            （已折叠 {{ foldToolMarkers(m.text).folded }} 处模型输出的原始工具调用标记 —— 本轮会话未启用工具，后端未过滤，前端按原样告知）
          </div>
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
        :disabled="gated"
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
.mode-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.seg { display: inline-flex; border: var(--hair) solid var(--rule-strong); border-radius: var(--r-sm); overflow: hidden; }
.seg button { border: 0; background: transparent; padding: 2px 10px; font-size: 12px; cursor: pointer; color: var(--ink-2); }
.seg button.on { background: var(--accent); color: #fff; font-weight: 600; }
.ctx-bar { margin-top: 6px; padding-top: 5px; border-top: var(--hair) dotted var(--rule); }
.bad-text { color: var(--warn); }

.tools-danger { color: var(--bad); font-weight: 700; }

/* 检索徽标：四种模式颜色不同；none（没查库）=灰虚线，empty（查了没命中）=橙，hit=绿，unavailable=灰 */
.retr-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px;
  padding-top: 7px; border-top: var(--hair) dashed var(--rule); }
.retr-badge { display: inline-block; padding: 1px 8px; font-size: 12px; font-weight: 600;
  border: var(--hair) solid currentColor; border-radius: var(--r-sm); }
/* ★ 判色以 status 为准（pi-bridge 契约）：none 灰虚线 / ok 绿 / empty 橙 / unavailable+error 红 */
.retr-badge[data-status="none"] { color: var(--muted); border-style: dashed; background: transparent; }
.retr-badge[data-status="empty"] { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.retr-badge[data-status="ok"] { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.retr-badge[data-status="unavailable"], .retr-badge[data-status="error"] { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); }
.retr-why { flex-basis: 100%; margin-top: 5px; border-left: 3px solid var(--rule-strong); padding-left: 8px; }
.retr-item { padding: 3px 0; border-bottom: var(--hair) dotted var(--rule); }

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






