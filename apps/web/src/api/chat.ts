/**
 * 对话通道 —— 契约 §7.2（WebSocket `ws://<host>/api/v1/chat/{session_id}`）
 *
 * 前端只做三件事：发命令、收事件、把事件如实呈现（含工具调用与错误）。
 * ⚠️ 契约 §7.3.1 的裁定必须在 UI 侧兑现：
 *   · `settled` 才是**一轮结束的唯一信号**（不是 prompt 的响应）
 *   · `error`（如 E_LLM / E_PI_EXIT）要**显式显示**，不允许"空回复"
 *   · system 角色的 message_end 服务端不转发（前端不应期待拿到系统提示词）
 */
import { api } from './client'

/** 页面上下文（**只传 id**；服务端解析 → 不可信输入不进提示词） */
export interface PromptContext {
  doc_id?: string
  unit_id?: string
  /** 沙箱会话 id（Lab 页；服务端按 userId 校验归属） */
  session_id?: string
  page?: number
}

export type ChatClientMessage =
  | { type: 'prompt'; message: string; steer?: boolean; mode?: 'chat' | 'agent'; retrieval?: 'none' | 'wiki' | 'kg' | 'rag' }
  | { type: 'steer'; message: string }
  | { type: 'abort' }
  | { type: 'set_model'; model: string }
  | { type: 'new_session' }

export type ChatServerEvent =
  | { type: 'ready'; session_id?: string; model?: string; tools?: string[] }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; id: string; tool: string; args?: unknown }
  | { type: 'tool_update'; id: string; partial?: string }
  | { type: 'tool_end'; id: string; ok?: boolean; duration_ms?: number }
  | { type: 'message_end'; message?: unknown; role?: string }
  /**
   * ★ 第 11 种帧（Lead 2026-10-15 裁定）：服务端**实际用了哪些上下文**。
   *   与 `retrieval` **正交**（`retrieval:'none'` 时 context 依然存在），所以单开一帧。
   *   `resolved` 是服务端用知识库解析出的**真实标题**（客户端传的 id 不可信）；
   *   `dropped` 非空 → 前端**必须如实显示**（"未找到你当前章节，已忽略"），不许静默。
   */
  | { type: 'context'; used?: PromptContext; resolved?: { doc_title?: string; unit_title?: string; unit_span?: unknown }; dropped?: Array<{ field: string; value?: string; reason?: string }>; note?: string }
  | { type: 'settled'; aborted?: boolean; abort_source?: string }
  | { type: 'error'; code?: string; msg?: string; hint?: string }
  | { type: string; [k: string]: unknown }

export type ChatState = 'connecting' | 'open' | 'closed'

export class ChatSocket {
  readonly sessionId: string
  readonly url: string
  state: ChatState = 'connecting'
  /** 收到的事件按到达顺序留档（无头测试与排错都用它，不是猜） */
  readonly log: ChatServerEvent[] = []
  private ws: WebSocket | null = null
  private handlers = new Map<string, Array<(e: ChatServerEvent) => void>>()
  /** 最近一次关闭码（1013/1008 等，供 UI 分档处理） */
  lastCloseCode = 0

  private stateHandlers: Array<(s: ChatState, info?: string) => void> = []
  private queue: ChatClientMessage[] = []

  constructor(sessionId: string, url?: string, mode?: 'chat' | 'agent') {
    this.sessionId = sessionId
    // 模式是**连接级**参数（`?mode=`）；不传 = 后端缺省 chat
    this.url = url || api.chatWsUrl(sessionId, mode)
    try {
      this.ws = new WebSocket(this.url)
    } catch (e) {
      this.state = 'closed'
      queueMicrotask(() => this.emitState('closed', `WebSocket 创建失败：${(e as Error).message}`))
      return
    }
    this.ws.onopen = () => {
      this.state = 'open'
      this.emitState('open')
      const q = this.queue.splice(0)
      q.forEach((m) => this.send(m))
    }
    this.ws.onmessage = (ev) => {
      let data: ChatServerEvent
      try { data = JSON.parse(String(ev.data)) } catch { return }
      this.log.push(data)
      if (data.type === 'error') console.warn('[chat] 服务端 error 事件:', data)
      this.emit(data.type, data)
      this.emit('*', data)
    }
    this.ws.onerror = () => this.emitState('closed', 'WebSocket 错误（后端未启动或路径不对）')
    this.ws.onclose = (ev) => {
      this.state = 'closed'
      /**
       * ★ 关闭码要**透出去**（v1 `web/chat.html:353-366` 的处理，v2 漏了）：
       *   · 1013 = pi 不可用 → 重连没意义（后端主动关，避免留在坏会话）
       *   · 1008 = 会话 id 非法 → 重连也是同样结果
       *   其它 → 才值得退避重连。不透出 code 的话前端只能一律当"断线"（会无限重连刷屏）。
       */
      this.lastCloseCode = ev.code
      this.emitState('closed', `连接关闭（code=${ev.code}${ev.reason ? ` · ${ev.reason}` : ''}）`)
    }
  }

  on(type: string, fn: (e: ChatServerEvent) => void): () => void {
    const arr = this.handlers.get(type) || []
    arr.push(fn)
    this.handlers.set(type, arr)
    return () => {
      const cur = this.handlers.get(type) || []
      this.handlers.set(type, cur.filter((f) => f !== fn))
    }
  }

  onState(fn: (s: ChatState, info?: string) => void): () => void {
    this.stateHandlers.push(fn)
    return () => { this.stateHandlers = this.stateHandlers.filter((f) => f !== fn) }
  }

  private emit(type: string, e: ChatServerEvent) {
    (this.handlers.get(type) || []).forEach((f) => f(e))
  }

  private emitState(s: ChatState, info?: string) {
    this.stateHandlers.forEach((f) => f(s, info))
  }

  send(msg: ChatClientMessage) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queue.push(msg)                       // 未连上先排队，连上后按序发出（坑 14：先订阅再发）
      return
    }
    this.ws.send(JSON.stringify(msg))
  }

  /**
   * 发一轮提示。
   * ⚠️ 字段是 **`message`**（不是 `text`）；`mode`/`retrieval` 都是**可选**（pi-bridge 契约）：
   *   · `mode:'chat'|'agent'` 缺省 = chat（agent 才能调用 kb_search/kb_get 读原文）
   *   · `retrieval:'none'|'wiki'|'kg'|'rag'` 缺省 = none
   * 两者**正交**：`retrieval` 决定"查不查、怎么查"，`mode` 决定"能不能读原文"。
   */
  prompt(message: string, steer = false, opts?: {
    mode?: 'chat' | 'agent'
    retrieval?: 'none' | 'wiki' | 'kg' | 'rag'
    /** 页面上下文（Lead 2026-10-15 裁定）：**只接受 id**，服务端负责解析成真实标题/正文 */
    context?: PromptContext
  }) {
    this.send({
      type: 'prompt', message, steer,
      ...(opts?.mode ? { mode: opts.mode } : {}),
      ...(opts?.retrieval ? { retrieval: opts.retrieval } : {}),
      ...(opts?.context && Object.keys(opts.context).length ? { context: opts.context } : {}),
    })
  }
  steer(message: string) { this.send({ type: 'steer', message }) }
  abort() { this.send({ type: 'abort' }) }
  setModel(model: string) { this.send({ type: 'set_model', model }) }
  newSession() { this.send({ type: 'new_session' }) }

  close() {
    try { this.ws?.close() } catch { /* ignore */ }
    this.state = 'closed'
  }
}
