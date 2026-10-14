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

export type ChatClientMessage =
  | { type: 'prompt'; message: string; steer?: boolean }
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
  private stateHandlers: Array<(s: ChatState, info?: string) => void> = []
  private queue: ChatClientMessage[] = []

  constructor(sessionId: string, url?: string) {
    this.sessionId = sessionId
    this.url = url || api.chatWsUrl(sessionId)
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
      this.emitState('closed', `连接关闭（code=${ev.code}）`)
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

  prompt(message: string, steer = false) { this.send({ type: 'prompt', message, steer }) }
  steer(message: string) { this.send({ type: 'steer', message }) }
  abort() { this.send({ type: 'abort' }) }
  setModel(model: string) { this.send({ type: 'set_model', model }) }
  newSession() { this.send({ type: 'new_session' }) }

  close() {
    try { this.ws?.close() } catch { /* ignore */ }
    this.state = 'closed'
  }
}
