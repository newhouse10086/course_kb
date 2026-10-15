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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api/client'
import { ChatSocket, type ChatServerEvent } from '../api/chat'
import { useCaps } from '../composables/useCaps'
import { esc } from '../utils/text'
import RichText from '../components/RichText.vue'
import { queryFlag, testBarrier, testBarrierDone, writeReport } from '../utils/report'

interface ToolCall { id: string; tool: string; args?: unknown; partial?: string; ok?: boolean; duration_ms?: number; done: boolean; result_text?: string }
interface Msg { role: 'user' | 'assistant' | 'system'; text: string; thinking: string; tools: ToolCall[]; error?: { code?: string; msg?: string }; ts?: number }

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
  /**
   * 助手入口（backend-api 2026-10-15 接线）：决定**系统提示词**
   *   · `chat`（缺省）→ 通用对话助手提示词
   *   · `video` → 视频助手提示词（**含渲染契约**：公式 `$…$`、代码块标语言并闭合、导图层级、不许编造公式）
   * ⚠️ 是**连接级**参数 → 变化时必须重连（会丢上下文，与 `?mode=` 同一取舍）。
   */
  assistant?: 'chat' | 'video'
}>(), { embedded: false, context: () => ({}), title: 'pi AI 助教', assistant: 'chat' })

const route = useRoute()
const router = useRouter()
const { caps, error: capsError } = useCaps()
/**
 * ⚠️ 原错误写法：`web-${Math.random().toString(36).slice(2, 10)}`
 *   `Math.random()` **不是密码学安全**（PRNG 状态可推断）+ 只有 ~41bit →
 *   服务端 `sessionId` 来自 URL 且**曾经没有归属校验** → id 可猜 = 抬高"连上别人的会话读历史"的可利用性。
 * ★ 修法：`crypto.randomUUID()`（CSPRNG；localhost 属安全上下文）。
 * ★ 但**这不是漏洞的防线** —— 唯一防线是服务端的**归属校验**（backend-api 在做）。
 *   服务端 `SESSION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/` → `web-<uuid>` 合法。
 */
/**
 * 当前会话 id。
 * ★ 流程按服务端 hint：**先 `POST /conversations` 登记 → 用服务端签发的 id 连接**；
 *   登记失败 → **如实显示原因** + 退回本地 CSPRNG id（不静默假装登记成功）。
 */
/**
 * ★ 会话 id 的来源优先级（这是"切走再回来消息还在"的关键）：
 *   ① URL `?session=cnv_…`（可分享/可刷新/前进后退）
 *   ② **localStorage**（用户点导航回 `/chat` 时 URL 上**没有** session —— 只靠 URL 会又新建一个）
 *   ③ 都没有 → 才 `POST /conversations` 新建
 * ⚠️ **unmount 时绝不清 localStorage**（清了就等于每次回来都是新会话）。
 */
/**
 * ★ 持久化键**按实例分**（polysemy-prober 真后端复验抓出的 bug）：
 *   抽屉（小助手）与整页 `/chat` 是**两个独立会话**，共用一个 key 会导致：
 *     · 抽屉与整页共享同一段历史（互相能看见）
 *     · 抽屉点「新会话」会**改掉主页面的会话**（反之亦然）
 *   ⚠️ 原来的写法是单个 `ckb.chat.session` + 两者都读 `route.query.session` → 抽屉直接复用了页面会话。
 */
const SESSION_KEY = props.embedded ? 'ckb.assistant.session' : 'ckb.chat.session'
function readStoredSession(): string {
  try { return String(localStorage.getItem(SESSION_KEY) || '') } catch { return '' }
}
/** ⚠️ `route.query.session` **只作用于整页实例** —— 抽屉不该从页面 URL 认领会话 */
const chatSessionId = ref(String((props.embedded ? '' : route.query.session) || readStoredSession() || ''))
/**
 * 把会话 id 写回 URL（`?session=cnv_…`）——**这是"切走再回来消息还在"的关键**：
 * 组件 unmount 会丢掉内存状态，但 URL 不会丢；重挂载时用它**重连同一个会话**，
 * 后端随后发 `history` 帧把消息铺回来（刷新/前进后退/分享链接同样有效）。
 * ⚠️ 用 `replace` 而不是 `push`：不把每次切会话都塞进浏览器历史。
 */
function persistSessionId(id: string, toUrl = true) {
  // ★ 两条都写：URL 便于分享/刷新；localStorage 保证"点导航回来"也复用同一个会话
  try { localStorage.setItem(SESSION_KEY, id) } catch { /* 隐私模式等：不致命 */ }
  if (!toUrl) return
  const q = { ...route.query, session: id }
  void router.replace({ query: q })
}

/** 会话登记状态（`server` = 服务端签发；`local` = 本地兜底，附原因） */
const sessionOrigin = ref<'server' | 'local' | 'pending'>('pending')
const sessionOriginNote = ref('')
/**
 * ★ 会话不可用（登记失败 + 后端要求先登记，或归属被拒）→ **禁用输入**。
 *   理由（polysemy-prober 建议）：本地兜底 id 在方案 A 下**必然连不上**，
 *   不该让用户先点一次注定失败的操作（"登记失败 → 本地新建 → 连不上"两步）。
 */
const sessionBlocked = ref('')
/** ★ 第 12 种帧 `history`：历史内容（pi-bridge：连接恢复时紧跟 ready 发一帧） */
const historyTruncated = ref(false)
const historyCount = ref(0)
/** `ready.reason`（清空判据的依据；也是排障线索） */
const readyReason = ref('')
const input = ref('')
/**
 * ★ 会话显示名兜底（契约 `docs/SESSION_NAMING.md` §4.3）：
 *   库里 title 全是默认值 '新问答' → 列表一排一样，用户找不到。
 *   → **无名字时显示"首条用户提问的前 20 字"**（**本地派生、零成本、不写库**）。
 *   ⚠️ 这是**显示层派生**，不是 title 的值 —— 断言要分清"DOM 显示"与"接口 title"。
 */
const FIRST_Q_KEY = 'ckb.chat.firstq'
const DEFAULT_TITLES = ['新问答', '新会话', '未命名']
function readFirstQ(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(FIRST_Q_KEY) || '{}') as Record<string, string> } catch { return {} }
}
const firstQ = ref<Record<string, string>>(readFirstQ())
function rememberFirstQ(sid: string, text: string) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!sid || !clean || firstQ.value[sid]) return
  firstQ.value = { ...firstQ.value, [sid]: clean }
  try { localStorage.setItem(FIRST_Q_KEY, JSON.stringify(firstQ.value)) } catch { /* 隐私模式：不致命 */ }
}
/** 显示名：有真名用真名；默认名 → 首条提问前 20 字（超长加省略号）；都没有 → 明确标注未命名 */
function sessionLabel(s: { id: string; title?: string }): string {
  const t = String(s.title || '').trim()
  if (t && !DEFAULT_TITLES.includes(t)) return t
  const q = String(firstQ.value[s.id] || '').replace(/\s+/g, ' ').trim()
  if (!q) return '（未命名会话）'
  return q.length > 20 ? `${q.slice(0, 20)}…` : q
}
/** 名字来源（可核验：`server` = 服务端 title；`derived` = 本地派生显示） */
function sessionLabelSource(s: { id: string; title?: string }): 'server' | 'derived' {
  const t = String(s.title || '').trim()
  return t && !DEFAULT_TITLES.includes(t) ? 'server' : 'derived'
}

/** 左侧**平铺**会话列表（后端权威；后端没实现时如实说"暂不可用"） */
const sessions = ref<Array<{ id: string; title?: string; updated_at?: number; message_count?: number }>>([])
const sessionsNote = ref('')
const sessionsLoading = ref(false)
/** 输入区左侧的"上下文指示"（可点掉）—— 用户要能一眼看出"它知道我在看什么" */
const ctxChipDismissed = ref(false)
const logEl = ref<HTMLElement | null>(null)
const boxEl = ref<HTMLTextAreaElement | null>(null)
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
/** 工具名 → 人话（用户要看得懂"它在翻知识库"，不是看 `kb_search`） */
function toolLabel(tool: string): string {
  const m: Record<string, string> = {
    kb_search: '检索知识库', kb_get: '读知识库原文',
    read: '读文件', bash: '执行命令', edit: '改文件', write: '写文件',
  }
  return m[tool] || tool
}

/** 上下文 chip 文案（本地：我这一页在看什么；服务端 resolved 到达后由 context-used 显示权威标题） */
const ctxLabel = computed(() => {
  const d = String((pageContext.value as any).doc_id || '')
  const u = String((pageContext.value as any).unit_id || '')
  const s = String((pageContext.value as any).session_id || '')
  const parts = [d ? `文档 ${d}` : '', u ? `章节 ${u}` : '', s ? `沙箱会话 ${s.slice(0, 16)}…` : ''].filter(Boolean)
  return parts.join(' · ')
})

/** 时间显示（会话列表） */
function fmtWhen(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? `今天 ${hh}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}`
}

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
/** ① 关闭码分档用：是否还要自动重连（1013/1008 → false） */
const canReconnect = ref(true)
const reconnectCount = ref(0)
const closeCode = ref(0)
/** ④ 会话是否落盘（ready.persistence）—— 不落盘要**事前**说清"刷新就没了" */
const persistence = ref('')
const persistenceReason = ref('')
/** pi-bridge 新字段（诚实降级类）：模型来源 / 会话恢复 / 自动重启 */
const modelSource = ref('')
const modelWarning = ref('')
const resumed = ref<boolean | null>(null)
const restoredMessages = ref<number | null>(null)
const resumeReason = ref('')
const restarted = ref(false)
/** agent 模式但 kb 工具装不上时，后端给的原因原文（`kb_tools_warning`） */
const kbToolsWarning = ref('')
/** 瞬时提示（后端回显差异等，会被下一帧 ready 更新） */
const modeNote = ref('')
/**
 * ★ **持久**提示：切模式/切入口 = 新上下文（对话会被清空）。
 *   原写法只在点击那一刻写 `modeNote`，而重连后的 `ready` 会把它清掉 ——
 *   正好在用户看到"对话没了"的那一刻**没有任何解释**（实测踩到）。
 */
const modeSwitchNotice = ref('')
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
/**
 * 整页 `/chat?doc=…&unit=…` 也带上下文（**只取 id**）：
 *   · 抽屉里的实例用 props.context（由页面写入）
 *   · 整页实例没有 props → 从 URL 取，同样只传 id
 */
if (!props.embedded) {
  const r = useRoute()
  const sync = () => {
    const d = String(r.query.doc || '')
    const u = String(r.query.unit || '')
    pageContext.value = { ...(d ? { doc_id: d } : {}), ...(u ? { unit_id: u } : {}) }
  }
  watch(() => [r.query.doc, r.query.unit], sync, { immediate: true })
}

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
const gated = computed(() => !!sessionBlocked.value
  || (!capsPending.value && (!piOk.value || !modelOk.value || !piModelStatus.value.modelAvailable)))
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
      // ④ 落盘状态（v1 chat.html:382-386 的诚实提示；v2 有字段但界面没用）
      persistence.value = String((e as any).persistence || '')
      persistenceReason.value = String((e as any).persistence_reason || '')
      // ★ pi-bridge 新字段：模型来源（回落时要能解释"为什么模型不对"）
      modelSource.value = String((e as any).model_source || '')
      modelWarning.value = String((e as any).model_warning || '')
      // ★ 刷新后历史是否恢复（false + reason 要**如实说**，别让用户以为"对话凭空没了"）
      resumed.value = typeof (e as any).resumed === 'boolean' ? (e as any).resumed : null
      restoredMessages.value = Number.isFinite((e as any).restoredMessages) ? Number((e as any).restoredMessages) : null
      resumeReason.value = String((e as any).resumeReason || '')
      restarted.value = (e as any).restarted === true
      /**
       * ★ 只在**真正的"新会话"**清空消息（pi-bridge：`ready` 有 5 个时点：
       *   连接 / new_session / 切 mode / set_model / get_state）。
       *   只有 `new_session` 会带 `restarted:true`；`get_state`（页面聚焦/重连复查）
       *   与 `set_model` 的 ready **绝不能清空** —— 否则表现就是"聊了几轮，切一下后台回来只剩最新一条"（用户实测反馈）。
       */
      /**
       * ★ `ready.reason`（pi-bridge 契约，替代"猜 restarted"）：
       *   `connect` / `set_model` / `get_state` → **绝不清空**（`get_state` 是页面聚焦/重连复查，
       *   清它就是用户看到的"聊了几轮只剩最新一条"）；`new_session` / `mode_change` → 清。
       *   ⚠️ 无 `reason` 的旧后端 → 退回 `restarted === true` 判据（保持兼容）。
       */
      const reason = String((e as any).reason || '')
      readyReason.value = reason
      const shouldClear = reason
        ? (reason === 'new_session' || reason === 'mode_change')
        : (e as any).restarted === true
      if (shouldClear && !props.embedded) {
        msgs.value = []
        modeSwitchNotice.value = ''
      }
      // ★ kb 工具装不上（`tools_source='kb-unavailable'`）：用**后端给的原因原文**
      kbToolsWarning.value = String((e as any).kb_tools_warning || '')
      const w = String((e as any).tools_warning || '')
      if (w) toolsWarningFromFrame.value = w
      // ★ 模式回显：`agent_mode`（不是 `mode`）——把自己选的与后端给的**分开显示**
      backendMode.value = String((e as any).agent_mode || '')
      modeNote.value = ''
      if (backendMode.value && backendMode.value !== chatMode.value) {
        modeNote.value = `你选的是 ${chatMode.value}，后端实际按 ${backendMode.value} 执行`
      } else if (chatMode.value === 'agent' && !sessionTools.value.includes('kb_search')) {
        // 知识库未接入 / 角色限制：**如实说"没有可用工具"**（优先用后端给的 `kb_tools_warning` 原文）
        const why = kbToolsWarning.value || toolsWarning.value
        modeNote.value = `你选了 agent，但后端本会话没有给知识库工具（tools_source=${toolsSource.value || '未上报'}）${why ? `：${why}` : ''}`
      }
      break
    /**
     * ② `message_end` 是**权威**（契约）：用它的完整文本**替换** delta 拼接结果。
     *    只用 delta 拼接时，模型中途失败会留下**半截文本且没有任何解释**。
     *    空回复 + stopReason='error' → 给一行占位说明（v1 chat.html:408-424 的做法）。
     */
    case 'message_end': {
      const msg = (e as any).message
      const role = String((e as any).role || msg?.role || '')
      if (role !== 'assistant') break
      const parts = Array.isArray(msg?.content) ? msg.content : []
      const full = parts.filter((x: any) => x?.type === 'text').map((x: any) => String(x.text || '')).join('')
      const stopReason = String(msg?.stopReason || (e as any).stopReason || '')
      updateLast((m) => {
        if (full) m.text = full
        if (!full && !m.tools.length && !m.error) {
          m.error = { code: 'E_EMPTY', msg: stopReason === 'error'
            ? '（本轮没有产出内容，失败原因见下方错误提示）'
            : '（本轮没有产出内容）' }
        }
      })
      break
    }
    /**
     * ★ 第 12 种帧 `history`（pi-bridge 2026-10-15）：连接建立且**会话从磁盘恢复**时，
     *   紧跟 `ready` 发一帧 → **用它铺消息列表**（assistant 文本已是权威全文，不再拼接）。
     *   内容安全：只含 user/assistant 的**文本块**（系统提示词已被出口自检剥离）。
     *   `truncated: true` → 只保留最近部分，**如实标注**（别让人以为历史就这么短）。
     */
    case 'history': {
      const list = Array.isArray((e as any).messages) ? (e as any).messages : []
      historyTruncated.value = (e as any).truncated === true
      historyCount.value = list.length
      const restored = list
        .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
        .map((m: any) => ({
          role: m.role as 'user' | 'assistant',
          text: String(m.text),
          thinking: '',
          tools: [] as ToolCall[],
          ts: Number(m.ts) || 0,
        }))
      /**
       * ★ 不要覆盖**已经发生的**内容：
       *   `history` 紧跟 `ready` 到达；若用户已经发了一轮（或本地已有消息），
       *   直接 `msgs = history` 会把新内容抹掉（实测：富文本用例读到的是历史那条，断言全红）。
       *   → 空列表时才用它铺；否则**只追加缺失的**（按 role+text 去重）。
       */
      if (!msgs.value.length) {
        msgs.value = restored
      } else {
        const seen = new Set(msgs.value.map((m: Msg) => `${m.role}\u0000${m.text}`))
        const add = restored.filter((m: Msg) => !seen.has(`${m.role}\u0000${m.text}`))
        if (add.length) msgs.value = [...add, ...msgs.value]
      }
      void nextTick(scrollToBottom)
      break
    }
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
    case 'error': {
      const code = String((e as any).code || '')
      // `detail` 一并显示（排障用；pi-bridge 的 error 帧字段清单）
      updateLast((m) => { m.error = { code, msg: [(e as any).msg, (e as any).detail].filter(Boolean).join(' —— ') } })
      // ③ 结束运行态（否则错误后按钮**一直停在"运行中"**，用户只能刷新）
      busy.value = false
      /**
       * ★ 会话归属校验失败（IDOR 修复后的 fail-closed）：
       *   `E_FORBIDDEN` = "会话不存在**或**无权访问" —— 服务端**故意不区分**（安全要求），
       *   前端也**不许**区分。引导用户重新开始（旧会话没有归属行 → 修好后一律失效）。
       *   **不自动重连**（重连同一个 id 必然同样被拒）。
       */
      if (code === 'E_FORBIDDEN') {
        canReconnect.value = false
        sessionBlocked.value = `会话不可用（${(e as any).msg || '会话不存在或无权访问'}）`
        stateNote.value = `会话不可用（${(e as any).msg || '会话不存在或无权访问'}）—— 旧会话在安全修复后需要重新开始`
        sessionOriginNote.value = '这个会话连不上：修复前的旧会话没有归属记录，需要**新建会话**重新开始（这是有意的 fail-closed，不是网络问题）。'
        return
      }
      if (code === 'E_PI_UNAVAILABLE' || code === 'E_PI_EXIT') {
        stateNote.value = `连接异常：${code}${(e as any).msg ? ` —— ${(e as any).msg}` : ''}`
        canReconnect.value = false
      }
      break
    }
    case 'settled':
      // ★ 一轮结束的唯一信号（§7.3.1）
      busy.value = false
      settledCount.value++
      // ★ `synthetic`/`disposition`：**"本轮没真正启动"不能当正常结束**（如实标注）
      const synthetic = (e as any).synthetic === true
      const disposition = String((e as any).disposition || '')
      const abortSource = String((e as any).abort_source || '')
      if (synthetic || disposition) {
        stateNote.value = `本轮未真正启动运行（synthetic=${synthetic}${disposition ? ` · disposition=${disposition}` : ''}）`
      }
      if (abortSource) stateNote.value = `已中断（abort_source=${abortSource}）`
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
  // ★ 记住"本会话的首条用户提问"（本地派生显示名用；**不写库**）
  if (!msgs.value.some((m) => m.role === 'user')) rememberFirstQ(chatSessionId.value, input.value.trim())
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
  const msg = (m === 'agent'
    ? '已切到 agent：可调用知识库工具读原文（kb_search/kb_get）。'
    : '已切回 chat：只用检索摘要（更快）。')
    + '**模式是会话级的 → 已重新连接，上下文重新开始。**'
  modeNote.value = msg
  modeSwitchNotice.value = msg      // 持久：重连后仍然告诉用户"为什么对话清空了"
  reconnect()
}

/** 用当前模式重连（保留 chatSessionId；上下文按后端语义重新开始） */
function reconnect(clearMessages = true) {
  try { socket?.close() } catch { /* ignore */ }
  if (clearMessages) msgs.value = []      // 切模式/切入口才清；断线重连保留
  else msgs.value = [...msgs.value, { role: 'system', text: '连接已恢复（本地已保留前面的对话）', thinking: '', tools: [] }]
  retrieval.value = null
  roundTools.value = []
  contextResolved.value = {}
  contextDropped.value = []
  state.value = 'connecting'
  startSocket()
}

/**
 * 拉会话列表（**后端权威**）。404/未实现 → 如实显示"暂不可用"，**不在前端存第二套**（Lead 明确要求）。
 */
/**
 * 登记会话（服务端 hint 的第一步）。**对 IDOR 方案 A/B 都成立**：
 *   · 成功 → 用服务端签发的 id（方案 A 下这是唯一能连上的路径）
 *   · 失败 → 如实显示原因 + 本地 id 兜底（当前行为；方案 A 下会连不上，但**用户能看到真因**）
 */
async function ensureSession(persistToUrl = true) {
  // ★ 已经有会话 id（URL 或本地带来的）→ **绝不新建**（这正是"切走再回来变新会话"的根因）
  if (chatSessionId.value) {
    sessionOrigin.value = chatSessionId.value.startsWith('cnv_') ? 'server' : 'local'
    sessionOriginNote.value = ''
    return
  }
  try {
    const c = await api.createConversation({ title: '新问答' })
    chatSessionId.value = c.id
    sessionOrigin.value = 'server'
    sessionOriginNote.value = ''
    persistSessionId(c.id, persistToUrl)   // ★ 写回 URL + 本地（重挂载/刷新都靠它）
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string }
    sessionOrigin.value = 'local'
    sessionOriginNote.value = (err.status === 404 || err.code === 'E_NOTFOUND')
      ? '后端没有会话登记接口（POST /conversations）→ 暂用本地 id；若后端要求"先登记再连接"，这个会话将连不上'
      : `会话登记失败（${err.message || e}）→ 暂用本地 id`
    /**
     * ★ Lead 判据：**登记失败 → 输入区禁用 + 可读提示**，不要"先给一个注定失败的会话"。
     *   （我第一版只在收到 `E_FORBIDDEN`/1008 后才禁用 —— 后端若没有闸门就永远等不到那一刻，
     *    用户会先白走一步。）
     */
    sessionBlocked.value = `会话登记失败：${sessionOriginNote.value}`
    // 兜底也用 URL 持久化（同一个 id 至少能被复用；后端有闸门时它会如实拒绝）
    if (chatSessionId.value) persistSessionId(chatSessionId.value)
  }
}

/** 重试登记（登记成功后清掉 blocked 并重连） */
async function retrySession() {
  sessionBlocked.value = ''
  canReconnect.value = true
  await ensureSession()
  if (sessionOrigin.value === 'server') {
    startSocket()
    void loadSessions()
  } else {
    sessionBlocked.value = '仍然登记失败：' + (sessionOriginNote.value || '后端 /conversations 不可用')
  }
}

async function loadSessions() {
  sessionsLoading.value = true
  try {
    // ★ 真实接口是 `GET /conversations`（Lead 实测：`/chat/sessions` 不存在 → 404）→ **它优先**
    let list: Array<{ id: string; title?: string; updated_at?: number; message_count?: number }> = []
    try {
      const r = await api.conversations()
      list = r.sessions
    } catch (e) {
      const err = e as { status?: number; code?: string }
      if (err.status === 404 || err.code === 'E_NOTFOUND') {
        const r2 = await api.chatSessions()   // 将来若加了别名也能用
        list = r2.sessions || []
      } else throw e
    }
    sessions.value = list
    sessionsNote.value = sessions.value.length ? '' : '还没有历史会话（问一轮就会出现在这里）'
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string }
    sessionsNote.value = (err.status === 404 || err.code === 'E_NOTFOUND')
      ? '会话列表暂不可用（后端接口尚未实现）—— 不做本地假历史，免得你换设备后对不上'
      : `会话列表读取失败：${err.message || e}`
    sessions.value = []
  } finally {
    sessionsLoading.value = false
  }
}

/** 切会话 = 用新 sessionId 重连（pi-bridge：会话 id 是连接级的；切会话后历史内容看不到，只有计数） */
function switchSession(id: string) {
  if (id === chatSessionId.value) return
  chatSessionId.value = id
  persistSessionId(id, !props.embedded)
  msgs.value = []
  retrieval.value = null
  roundTools.value = []
  contextResolved.value = {}
  contextDropped.value = []
  state.value = 'connecting'
  startSocket()
  void loadSessions()
}

/** 消息变化 / 流式中 → 自动滚到底（用户："可滚动，新消息自动滚到底"） */
function scrollToBottom() {
  const el = logEl.value
  if (el) el.scrollTop = el.scrollHeight
}

/** 输入框随内容自增高（不是"光秃秃的固定三行"） */
function autoGrow() {
  const el = boxEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`
}

async function newSession() {
  // ★ 新建 = **再登记一个会话**（服务端签发新 id）→ 切过去（不是本地随便造一个 id）
  socket?.newSession()
  try {
    const c = await api.createConversation({ title: '新问答' })
    sessionOrigin.value = 'server'
    sessionOriginNote.value = ''
    switchSession(c.id)      // switchSession 内部会写 URL
    return
  } catch (e) {
    sessionOrigin.value = 'local'
    sessionOriginNote.value = `新建会话时登记失败（${(e as Error).message}）→ 已本地新建`
  }
  msgs.value = []
  modeSwitchNotice.value = ''
  msgs.value.push({ role: 'system', text: '已请求新建会话', thinking: '', tools: [] })
}

onMounted(async () => {
  // 抽屉里的实例**不做页面级副作用**（不写 report、不同步屏障、不跑自检）
  if (props.embedded) {
    const { reload } = useCaps()
    void reload()
    /**
     * ★ 抽屉（小助手）**也要登记会话**：方案 A 下服务端只接受已登记且属于你的 id，
     *   否则小助手在真后端上根本连不上（只在 mock 里看起来正常）。
     *   但**不写 URL**（抽屉不该改页面 URL）。
     */
    void (async () => { await ensureSession(false); startSocket() })()
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
  // ★ 会话列表走**后端权威**（Lead：别在前端存第二套真相源）；后端未实现时如实显示"暂不可用"
  if (!props.embedded) {
    /**
     * ★ 顺序很重要：**先登记拿服务端 id → 再建唯一一条连接**。
     * ⚠️ 原写法在 onMounted 里先 `startSocket()`，登记完又补一次 → **两条连接**，
     *    第二轮帧发给被丢弃的旧 socket（表现为"回答不完整"，实测踩到）。
     */
    void (async () => {
      await ensureSession()
      startSocket()
      void loadSessions()
    })()
  }
  writeReport('chat-report', {
    ok: true, gated: false, caps_pending: capsPending.value, session: chatSessionId.value, url: socket?.url || '',
    mode: chatMode.value, pi_available: piOk.value, model_available: modelOk.value,
  })
  // caps 到达后**重写报告**（连 WS 不等 caps，但报告必须反映"能力到达后的真值"）
  watch(caps, () => {
    if (!socket) return
    writeReport('chat-report', {
      ok: true, gated: gated.value, caps_pending: capsPending.value, session: chatSessionId.value, url: socket?.url || '', mode: chatMode.value,
      pi_available: piOk.value, model_available: modelOk.value,
      pi_reason: piReason.value, model_reason: modelReason.value || piModelNote.value,
    })
  })
  if (queryFlag('selftest')) await runSelftest(gated.value)
  await testBarrierDone()
})

/** 建连（模式走 URL 查询参数） */
function startSocket() {
  socket = new ChatSocket(chatSessionId.value, undefined, chatMode.value, props.assistant)
  socket.onState((s, info) => {
    state.value = s
    if (info) stateNote.value = info
    /**
     * ★ 连上就把**上一次的**关闭提示清掉 —— 否则"连接关闭（code=1008…）"会一直挂在页面上，
     *   让用户以为**当前**连接有问题（实测：用服务端签发的 id 连上后，仍显示上一次的 1008）。
     */
    if (s === 'open') {
      closeCode.value = 0
      if (/连接关闭|断线/.test(stateNote.value)) stateNote.value = ''
    }
    if (s === 'closed') onClosed()
  })
  socket.on('*', onEvent)
}

/**
 * ① 关闭码分档（v1 `web/chat.html:353-366`）：
 *   1013 = pi 不可用 / 1008 = 会话 id 非法 → **不再重连**（重连必然同样失败，只会刷屏）
 *   其它 → 指数退避 500ms×2^n（封顶 8s，最多 6 次）
 * ⚠️ 原错误写法：一律当"断线"处理 → 非法 session id 时无限重连、用户看不到真因。
 */
function onClosed() {
  const code = socket?.lastCloseCode || 0
  closeCode.value = code
  // 登记失败 + 1008 关闭 → 后端要求"先登记"，本地兜底 id 必然连不上 → 明确禁用（别让用户白试）
  if (code === 1008 && sessionOrigin.value === 'local') {
    sessionBlocked.value = '会话登记失败，而后端要求"先登记再连接" → 当前无法对话。请检查后端 /conversations 接口是否可用，然后点「新建会话」重试。'
    canReconnect.value = false
    return
  }
  if (code === 1013) {
    canReconnect.value = false
    stateNote.value = 'pi 不可用（后端主动关闭 1013）—— 不自动重连；请先看能力横幅里的原因'
    return
  }
  if (code === 1008) {
    canReconnect.value = false
    stateNote.value = '会话 id 非法（1008）—— 不自动重连；点「新会话」重新开始'
    return
  }
  if (!canReconnect.value || props.embedded) return
  if (reconnectCount.value >= 6) {
    stateNote.value = `${stateNote.value}｜已重连 6 次仍失败，停止自动重连`
    return
  }
  reconnectCount.value++
  const delay = Math.min(500 * 2 ** (reconnectCount.value - 1), 8000)
  stateNote.value = `断线，${delay}ms 后第 ${reconnectCount.value}/6 次重连…`
  // ⚠️ 断线自动重连**不清空消息**（第一版调用 reconnect() 会清 —— 用户看到"只剩最新一条"的另一个来源）
  setTimeout(() => { if (canReconnect.value) reconnect(false) }, delay)
}

// ★ 消息变化 / 流式中 → 自动滚到底（用户："新消息自动滚到底"）
watch(msgs, () => { void nextTick(scrollToBottom) }, { deep: true })
watch(busy, (b) => { if (b) void nextTick(scrollToBottom) })
// 输入框自增高
watch(input, () => { void nextTick(autoGrow) })

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
  <div class="chat-layout" :class="{ embedded: props.embedded }">
    <!-- ═══ 左：会话列表（**平铺**，不做工作区分组 —— 用户："学生只有一个基本的问答"） ═══ -->
    <aside class="chat-side" data-testid="session-list" :data-count="sessions.length">
      <div class="side-head">
        <b>问答</b>
        <span class="right" />
        <button type="button" class="small" data-testid="chat-newsession" @click="newSession">新会话</button>
      </div>
      <div v-if="sessionsLoading" class="small faint side-note">读取会话列表…</div>
      <div v-else-if="sessionsNote" class="small faint side-note" data-testid="session-list-unavailable">{{ sessionsNote }}</div>
      <ul class="side-list">
        <li v-for="s in sessions" :key="s.id">
          <button type="button" class="side-item" :class="{ on: s.id === chatSessionId }"
                  data-testid="session-item" :data-id="s.id" @click="switchSession(s.id)">
            <span class="t" data-testid="session-title" :data-title-source="sessionLabelSource(s)"
                  :data-api-title="s.title || ''">{{ sessionLabel(s) }}</span>
            <span class="small faint">
              {{ fmtWhen(s.updated_at) }}<template v-if="s.message_count"> · {{ s.message_count }} 条</template>
            </span>
          </button>
        </li>
      </ul>
      <div class="small faint mono side-note" data-testid="current-session">当前：{{ chatSessionId.slice(0, 20) }}…</div>
      <!-- ★ 会话登记来源：服务端签发 / 本地兜底（失败时**如实说原因**，不假装登记成功） -->
      <div class="small faint side-note" data-testid="session-origin" :data-origin="sessionOrigin"
           :title="sessionOriginNote">{{ sessionOrigin === 'server' ? '会话由服务端登记' : sessionOrigin === 'local' ? '会话为本地 id（见提示）' : '登记中…' }}</div>
      <div v-if="sessionOriginNote" class="note warn side-note" data-testid="session-origin-note">{{ sessionOriginNote }}</div>
    </aside>

    <!-- ═══ 中：消息流 + 输入区 ═══ -->
    <section class="chat-main">
      <div class="panel chat-head">
        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
          <b>{{ props.title }}</b>
          <span class="pill" :class="state === 'open' ? 'ok' : 'bad'" data-testid="ws-state">{{ state }}</span>
          <span v-if="model" class="pill blue">{{ model }}</span>
          <span class="pill" :class="props.assistant === 'video' ? 'orange' : ''" data-testid="assistant-entry"
                :data-entry="props.assistant">{{ props.assistant === 'video' ? '视频助手提示词' : '通用助手提示词' }}</span>
          <span v-if="stateNote" class="small faint" data-testid="ws-note">{{ stateNote }}</span>
          <span v-if="closeCode" class="small faint mono" data-testid="ws-close-code">code={{ closeCode }}</span>
          <span class="small" :class="toolsSource === 'dangerous-opt-in' ? 'tools-danger' : 'faint'"
                data-testid="session-tools" :data-tools="sessionTools.join(',')" :data-source="toolsSource">
            工具：{{ sessionTools.length ? sessionTools.join(', ') : '无' }}
            <span v-if="toolsSource">（{{ toolsSourceLabel }}）</span>
          </span>
          <span v-if="toolsSource === 'dangerous-opt-in'" class="pill bad" data-testid="tools-danger">
            ⚠️ 本会话已开启主机工具（{{ sessionTools.join(', ') || '见 tools' }}）
          </span>
          <span class="right" />
          <button type="button" class="small" data-testid="mode-reset" title="重连（保留会话 id）" @click="reconnect(false)">重连</button>
        </div>

        <div v-if="modeNote" class="note warn" style="margin-top: 6px" data-testid="mode-note">{{ modeNote }}</div>
        <div v-if="modeSwitchNotice" class="small faint" style="margin-top: 4px" data-testid="mode-switch-notice">
          {{ modeSwitchNotice }}
        </div>
        <div v-if="modelWarning || (modelSource && modelSource !== 'explicit')" class="small faint" style="margin-top: 4px"
             data-testid="model-source" :data-model-source="modelSource">
          模型来源：{{ modelSource || '未上报' }}{{ modelWarning ? ` —— ${modelWarning}` : '' }}
        </div>
        <div v-if="historyCount" class="small faint" style="margin-top: 4px" data-testid="history-note"
             :data-history-count="historyCount" :data-truncated="historyTruncated ? '1' : '0'">
          已从服务端恢复 {{ historyCount }} 条历史消息{{ historyTruncated ? '（**只保留最近部分**，更早的已截断）' : '' }}。
        </div>
        <div v-if="resumed === false" class="small faint" style="margin-top: 4px" data-testid="resume-note">
          本会话**没有恢复历史**（resumed=false{{ resumeReason ? ` · ${resumeReason}` : '' }}）—— 刷新后对话会重新开始。
        </div>
        <div v-else-if="resumed === true" class="small faint" style="margin-top: 4px" data-testid="resume-note">
          已恢复历史消息 {{ restoredMessages ?? '?' }} 条（**内容不在本会话里** —— 只有计数，前端不编造）。
        </div>
        <div v-if="restarted" class="note warn" style="margin-top: 4px" data-testid="restarted">
          pi 进程曾自动重启 —— 连接已恢复，但**上一轮可能被截断**。
        </div>
        <div v-if="kbToolsWarning" class="note warn" style="margin-top: 4px" data-testid="kb-tools-warning">
          知识库工具不可用：{{ kbToolsWarning }}
        </div>
        <div v-if="persistence && persistence !== 'native'" class="small faint" style="margin-top: 4px"
             data-testid="persistence-note" :data-persistence="persistence">
          本轮对话**不落盘**（persistence={{ persistence }}{{ persistenceReason ? ` · ${persistenceReason}` : '' }}）—— 刷新页面后这段对话不会保留。
        </div>
        <div v-if="!agentAllowed" class="small faint" style="margin-top: 4px" data-testid="agent-blocked">{{ agentBlockReason }}</div>
        <div v-if="kbEmpty" class="note warn" style="margin-top: 6px" data-testid="kb-empty">
          <b>知识库为空</b>：{{ kbEmptyHint }}
        </div>

        <!-- ★ 上下文条：服务端解析出的**真实标题**；没有就说"未使用页面上下文"（不假装 —— 坑 21） -->
        <div v-if="contextResolved.doc_title || contextResolved.unit_title || contextDropped.length"
             class="small ctx-bar" data-testid="context-used"
             :data-doc="contextResolved.doc_title || ''" :data-unit="contextResolved.unit_title || ''">
          <b>服务端声明参考：</b>
          <span>{{ contextResolved.doc_title || '（未解析到文档）' }}</span>
          <span v-if="contextResolved.unit_title"> › {{ contextResolved.unit_title }}</span>
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
        <div v-else class="small faint" style="margin-top: 6px" data-testid="context-none">
          未使用页面上下文（本页没有可带的文档/章节/沙箱会话）
        </div>

        <div v-if="toolsWarning" class="note bad" style="margin-top: 8px" data-testid="tools-warning">
          <b>⚠️ 本会话已开启主机工具</b>：{{ toolsWarning }}
          <div class="small" style="margin-top: 4px">这意味着会话可能拿到 pi 的默认工具集（含命令执行）—— 请让后端确认策略，前端不自行拦截。</div>
        </div>
        <!-- ★ 会话不可用：禁用输入 + 明确出路（不重连、不假装能用） -->
      <div v-if="sessionBlocked" class="note bad" style="margin-top: 8px" data-testid="session-blocked">
        <b>无法对话</b>：{{ sessionBlocked }}
        <div class="small" style="margin-top: 4px">
          这不是网络问题 —— 安全修复后，会话必须由服务端登记（`POST /conversations`）。
        </div>
        <div class="row" style="margin-top: 6px">
          <button type="button" class="small" data-testid="session-retry" @click="retrySession()">重试登记</button>
          <button type="button" class="small" data-testid="session-new" @click="newSession()">新建会话</button>
        </div>
      </div>
      <div v-if="capsPending" class="note warn" style="margin-top: 8px" data-testid="caps-pending">
          <b>能力探测中（真探测较慢）</b>：现在就可以发消息 —— 若后端确实不可用，会在这一轮如实报错。
        </div>
        <div v-else-if="!piOk || !modelOk || !piModelStatus.modelAvailable" class="note bad" style="margin-top: 8px" data-testid="chat-gate">
          <b>对话入口已禁用</b>
          <ul style="margin: 4px 0 0; padding-left: 18px">
            <li v-if="!piOk">pi 不可用：{{ piReason }}</li>
            <li v-if="!modelOk">模型不可用：{{ modelReason }}</li>
          </ul>
          <div class="small" style="margin-top: 4px">按 PROVIDERS §7：能力不可用时禁用入口并显示原因，不允许点了才报错。</div>
        </div>

        <!-- ★ 检索模式徽标（本轮用了哪种检索 / 命中几条 / 耗时） -->
        <div v-if="retrieval" class="retr-bar" data-testid="retrieval-badge"
             :data-mode="retrieval.mode" :data-status="retrieval.status"
             :data-searched="retrieval.status !== 'none' && retrieval.available ? '1' : '0'"
             :data-available="retrieval.available ? '1' : '0'" :data-hits="retrieval.hits">
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
          <span v-for="t in roundTools" :key="t.id" class="pill"
                :class="{ ok: t.done && t.ok !== false, bad: t.done && t.ok === false }"
                data-testid="retrieval-tool" :data-tool="t.tool">
            {{ toolLabel(t.tool) }}{{ t.done ? (t.ok === false ? ' ✗' : ' ✓') : ' …' }}
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

      <!-- ═══ 消息流：用户/AI **视觉分明**（头像 + 气泡），可滚动，新消息自动到底 ═══ -->
      <div ref="logEl" class="chat-log" data-testid="chat-log" :data-count="msgs.length">
        <div v-for="(m, i) in msgs" :key="i" class="msg" :class="m.role" :data-role="m.role">
          <div class="avatar" aria-hidden="true">{{ m.role === 'user' ? '我' : m.role === 'assistant' ? 'pi' : '·' }}</div>
          <div class="body">
            <div v-if="m.thinking" class="thinking small faint" data-testid="thinking">
              <details><summary>思考过程</summary><pre>{{ m.thinking }}</pre></details>
            </div>
            <!-- ★ 工具调用 = **可折叠的一步**（DSH 的体验感很大程度来自这个） -->
            <details v-for="t in m.tools" :key="t.id" class="tool-step" :data-tool="t.tool"
                     data-testid="tool-call" :open="!t.done">
              <summary>
                <span class="tool-name">{{ toolLabel(t.tool) }}</span>
                <span v-if="!t.done" class="pill">运行中…</span>
                <span v-else class="pill" :class="t.ok ? 'ok' : 'bad'">{{ t.ok ? '完成' : '失败' }}</span>
                <span v-if="t.duration_ms != null" class="faint tiny mono">{{ t.duration_ms }}ms</span>
                <span v-if="t.args" class="faint tiny mono tool-args">{{ JSON.stringify(t.args).slice(0, 80) }}</span>
              </summary>
              <div class="tool-detail">
                <div v-if="t.args" class="tiny mono">参数：{{ JSON.stringify(t.args).slice(0, 300) }}</div>
                <div v-if="t.partial" class="evidence">{{ t.partial.slice(0, 200) }}</div>
                <div v-if="t.result_text" class="evidence">{{ t.result_text.slice(0, 200) }}</div>
              </div>
            </details>
            <div v-if="m.text" class="text" :data-testid="m.role === 'assistant' ? 'assistant-text' : ''">
              <RichText :text="foldToolMarkers(m.text).text" :stats="queryFlag('selftest')" />
            </div>
            <!-- ★ 流式光标：正在生成时的可见反馈（打字机效果由 text_delta 天然提供） -->
            <span v-if="busy && m.role === 'assistant' && i === msgs.length - 1" class="cursor"
                  data-testid="stream-cursor">▍</span>
            <div v-if="m.role === 'assistant' && foldToolMarkers(m.text).folded > 0" class="small faint"
                 data-testid="tool-marker-folded" :data-count="foldToolMarkers(m.text).folded">
              （已折叠 {{ foldToolMarkers(m.text).folded }} 处模型输出的原始工具调用标记 —— 本轮会话未启用工具，后端未过滤，前端按原样告知）
            </div>
            <div v-if="m.error" class="note bad" :data-error-code="m.error.code" data-testid="chat-error">
              <b>错误</b> <span class="mono">{{ m.error.code }}</span>：{{ m.error.msg }}
            </div>
          </div>
        </div>
        <div v-if="!msgs.length" class="empty-hint faint small" data-testid="chat-empty">
          还没有对话。问点什么，比如"聚簇索引和二级索引的区别" ——
          这一页会带上你**正在看的页面**作为上下文（文档 / 章节 / 沙箱会话）。
        </div>
      </div>

      <!-- ═══ 输入区（不是"光秃秃一个文本框"）：上下文指示 + 控件 + 发送/停止 ═══ -->
      <div class="chat-input">
        <div class="ctx-row">
          <span v-if="ctxLabel && !ctxChipDismissed" class="chip" data-testid="input-context"
                :data-keys="Object.keys(pageContext).join(',')">
            正在参考：{{ ctxLabel }}
            <button type="button" class="chip-x" data-testid="input-context-clear" title="本次不带上下文"
                    @click="ctxChipDismissed = true">✕</button>
          </span>
          <span v-else class="small faint" data-testid="input-context-none">
            未使用页面上下文{{ ctxChipDismissed ? '（你已点掉）' : '' }}
          </span>
        </div>
        <textarea
          ref="boxEl"
          v-model="input"
          data-testid="chat-input"
          :disabled="gated"
          rows="1"
          placeholder="问知识点 / 让 pi 读某节原文（Enter 发送，Shift+Enter 换行）"
          @input="autoGrow"
          @keydown.enter.exact.prevent="send"
        />
        <div class="row">
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
          <span class="pill" :class="backendMode === chatMode ? 'ok' : 'warn'" data-testid="backend-mode"
                :data-backend-mode="backendMode">后端：{{ backendMode || '未上报' }}</span>
          <span class="right" />
          <span class="small faint" data-testid="busy-state">busy={{ busy }} · settled={{ settledCount }}</span>
          <button type="button" data-testid="chat-steer" :disabled="!busy" @click="steer">插话</button>
          <!-- ★ busy 时按钮变"停止"（DSH 的体验：正在生成时给的是停止，不是再发一条） -->
          <button v-if="busy" type="button" class="bad" data-testid="chat-abort" @click="abort">停止</button>
          <button v-else type="button" class="primary" data-testid="chat-send" :disabled="!canSend" @click="send">发送</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ═══ 布局：左会话列表 ｜ 中消息流 + 输入区（DSH 式布局，**配色仍用我们的纸白+朱红**） ═══ */
.chat-layout { display: grid; grid-template-columns: 208px minmax(0, 1fr); gap: 12px;
  padding: 14px 22px 40px; max-width: 1180px; margin: 0 auto; align-items: start; }
.chat-layout.embedded { grid-template-columns: minmax(0, 1fr); padding: 0; max-width: none; }
.chat-layout.embedded .chat-side { display: none; }
.chat-side { border: var(--hair) solid var(--rule); border-top: 2px solid var(--rule-strong);
  background: var(--panel); padding: 8px; position: sticky; top: 12px; max-height: 70vh; overflow: auto; }
.side-head { display: flex; align-items: center; gap: 6px; padding-bottom: 6px; border-bottom: var(--hair) solid var(--rule); }
.side-note { padding: 6px 2px; }
.side-list { list-style: none; margin: 6px 0 0; padding: 0; }
.side-item { display: block; width: 100%; text-align: left; border: 0; background: transparent;
  padding: 6px 6px; cursor: pointer; border-left: 3px solid transparent; color: var(--ink); }
.side-item:hover { background: var(--paper-2); }
.side-item.on { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.side-item .t { display: block; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }

.mode-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.seg { display: inline-flex; border: var(--hair) solid var(--rule-strong); border-radius: var(--r-sm); overflow: hidden; }
.seg button { border: 0; background: transparent; padding: 2px 10px; font-size: 12px; cursor: pointer; color: var(--ink-2); }
.seg button.on { background: var(--accent); color: #fff; font-weight: 600; }
.ctx-bar { margin-top: 6px; padding-top: 5px; border-top: var(--hair) dotted var(--rule); }
.bad-text { color: var(--warn); }
.tools-danger { color: var(--bad); font-weight: 700; }

/* 检索徽标：status 判色（none 灰虚线 / ok 绿 / empty 橙 / unavailable+error 红） */
.retr-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px;
  padding-top: 7px; border-top: var(--hair) dashed var(--rule); }
.retr-badge { display: inline-block; padding: 1px 8px; font-size: 12px; font-weight: 600;
  border: var(--hair) solid currentColor; border-radius: var(--r-sm); }
.retr-badge[data-status="none"] { color: var(--muted); border-style: dashed; background: transparent; }
.retr-badge[data-status="empty"] { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.retr-badge[data-status="ok"] { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.retr-badge[data-status="unavailable"], .retr-badge[data-status="error"] { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); }
.retr-why { flex-basis: 100%; margin-top: 5px; border-left: 3px solid var(--rule-strong); padding-left: 8px; }
.retr-item { padding: 3px 0; border-bottom: var(--hair) dotted var(--rule); }

/* ═══ 消息流：**用户与 AI 视觉分明**（用户右对齐浅底，AI 左对齐整宽） ═══ */
.chat-log { min-height: 320px; max-height: 62vh; overflow: auto; border: var(--hair) solid var(--rule);
  border-top: 2px solid var(--rule-strong); background: var(--paper); padding: 10px 12px; scroll-behavior: smooth; }
.msg { display: flex; gap: 10px; margin: 10px 0; }
.msg .avatar { flex: 0 0 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; border: var(--hair) solid var(--rule-strong); background: var(--paper-2); color: var(--ink-2); }
.msg .body { min-width: 0; flex: 1; }
.msg .text { white-space: normal; }
/* AI：左对齐、整宽、纸白卡片 */
.msg.assistant .body { background: var(--panel); border: var(--hair) solid var(--rule); padding: 8px 10px; }
.msg.assistant .avatar { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
/* 用户：右对齐、朱红浅底、短 */
.msg.user { flex-direction: row-reverse; }
.msg.user .body { flex: 0 1 auto; max-width: 76%; background: color-mix(in srgb, var(--accent) 9%, var(--paper));
  border: var(--hair) solid color-mix(in srgb, var(--accent) 35%, var(--rule)); padding: 7px 10px; font-weight: 600; }
.msg.system .body { color: var(--ink-3); font-size: 12.5px; }
.empty-hint { padding: 18px 4px; text-align: center; }
/* 流式光标 */
.cursor { display: inline-block; color: var(--accent); animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }

/* 工具调用 = 可折叠的一步 */
.tool-step { border: var(--hair) solid var(--rule); border-left: 3px solid var(--ink-2);
  background: var(--paper-2); margin: 5px 0; font-size: 12px; }
.tool-step > summary { cursor: pointer; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 4px 8px; }
.tool-step[open] > summary { border-bottom: var(--hair) dotted var(--rule); }
.tool-name { font-family: var(--font-mono); font-weight: 700; color: var(--ink); }
.tool-args { overflow: hidden; text-overflow: ellipsis; max-width: 320px; white-space: nowrap; }
.tool-detail { padding: 5px 8px; }
.evidence { color: var(--ink-2); }

/* ═══ 输入区：上下文 chip + 控件 + 发送/停止 ═══ */
.chat-input { border: var(--hair) solid var(--rule); border-top: 2px solid var(--rule-strong); background: var(--panel); padding: 8px 10px; }
.ctx-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
.chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 1px 8px;
  border: var(--hair) solid color-mix(in srgb, var(--accent) 40%, var(--rule)); background: color-mix(in srgb, var(--accent) 7%, transparent); }
.chip-x { border: 0; background: transparent; cursor: pointer; color: var(--ink-2); font-size: 12px; }
.chat-input textarea { width: 100%; font-family: var(--font-body); font-size: 13.5px; line-height: 1.6;
  border: var(--hair) solid var(--rule-strong); padding: 8px; background: var(--panel); color: var(--ink);
  resize: none; overflow-y: auto; min-height: 38px; max-height: 200px; }
.chat-input .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
.thinking { border-left: 3px solid var(--rule-strong); padding-left: 8px; margin: 4px 0; }
.thinking pre { white-space: pre-wrap; margin: 4px 0 0; background: transparent; border: none; padding: 0; color: var(--ink-2); }
</style>
