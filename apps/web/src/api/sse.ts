/**
 * 任务进度流 —— 契约 §6（SSE）+ §5.6（任务查询）
 *
 * ⚠️ v1 踩过的两个真问题，这里正面修掉（Lead 明确要求不许用放宽断言掩盖）：
 *
 * 1) **SSE 收到了却当作断流**
 *    v1 的 `es.onerror` 里只判断 `readyState === CLOSED` 就覆盖状态 —— 而 `es.close()`
 *    之后也会触发 error，于是「任务完成」被随后的 error 覆盖成"进度流已断开"。
 *    这里用 `finished` 标志：一旦 done/failed 就**永不**再被 error 改写。
 *
 * 2) **SSE 在真实环境可能一直不通**（代理/网关/框架差异），只报一句"断开"就等于入口没用
 *    → 必须有**轮询兜底**：`sseTimeoutMs` 内零帧、或 error 且未结束 → 切换到 GET /tasks/{id}
 *    轮询，并把 `transport` 如实暴露给 UI（'sse' | 'poll'），不谎报。
 */
import { api } from './client'
import type { TaskInfo, TaskProgressEvent } from './types'

/* ==========================================================================
   POST + SSE（EventSource 只能 GET → 用 fetch 流自己解析 `event:` / `data:` 帧）
   用于沙箱答疑：POST 里带 SQL / 报错 / 问题，服务端流式回 hint 与引用。
   ========================================================================== */
export interface PostSseHandlers {
  onEvent: (event: string, data: any) => void
  onError?: (msg: string) => void
  onClose?: () => void
}

export async function postSse(url: string, body: unknown, h: PostSseHandlers, signal?: AbortSignal): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body || {}),
      signal,
    })
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}${res.ok ? '（无流）' : ''}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // 帧以空行分隔（契约 §6：data 是单行 JSON）
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        let event = 'message'
        const dataLines: string[] = []
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
          // `:` 开头是 keepalive 注释，忽略
        }
        if (!dataLines.length) continue
        let parsed: any = dataLines.join('\n')
        try { parsed = JSON.parse(parsed) } catch { /* 非 JSON 就原样给出去 */ }
        h.onEvent(event, parsed)
      }
    }
    h.onClose?.()
  } catch (e) {
    if ((e as Error).name === 'AbortError') return
    h.onError?.((e as Error).message)
  }
}

export type TaskTransport = 'sse' | 'poll'

export interface TaskStreamHandlers {
  onProgress?: (e: TaskProgressEvent) => void
  onLog?: (e: { task_id?: string; level?: string; msg?: string }) => void
  onArtifact?: (e: { kind?: string; url?: string }) => void
  onDone?: (e: { task_id?: string; status?: string; elapsed_ms?: number }) => void
  onFailed?: (e: { task_id?: string; error?: string; code?: string }) => void
  /** 传输层问题（已自动兜底/或彻底失败），reason 是给用户看的 */
  onTransport?: (transport: TaskTransport, note: string) => void
}

export interface TaskStreamOptions {
  /** SSE 多久没收到任何帧就转轮询（默认 3000ms） */
  sseTimeoutMs?: number
  pollIntervalMs?: number
  maxPolls?: number
}

export class TaskStream {
  readonly taskId: string
  transport: TaskTransport = 'sse'
  finished = false
  frames = 0
  private es: EventSource | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private opts: Required<TaskStreamOptions>
  private handlers: TaskStreamHandlers = {}

  constructor(taskId: string, opts: TaskStreamOptions = {}) {
    this.taskId = taskId
    this.opts = {
      sseTimeoutMs: opts.sseTimeoutMs ?? 3000,
      pollIntervalMs: opts.pollIntervalMs ?? 1500,
      maxPolls: opts.maxPolls ?? 60,
    }
  }

  start(handlers: TaskStreamHandlers): this {
    this.handlers = handlers
    if (typeof EventSource === 'undefined') {
      this.toPolling('当前环境不支持 EventSource，改用轮询')
      return this
    }
    let es: EventSource
    try {
      es = new EventSource(api.taskEventsUrl(this.taskId))
    } catch (e) {
      this.toPolling(`进度流创建失败（${(e as Error).message}），改用轮询`)
      return this
    }
    this.es = es
    for (const name of ['progress', 'log', 'artifact', 'done', 'failed'] as const) {
      es.addEventListener(name, (ev) => {
        this.frames++
        let data: any = {}
        try { data = JSON.parse((ev as MessageEvent).data) } catch { /* 非 JSON 帧忽略 */ }
        if (name === 'progress') this.handlers.onProgress?.(data)
        if (name === 'log') this.handlers.onLog?.(data)
        if (name === 'artifact') this.handlers.onArtifact?.(data)
        if (name === 'done') { this.finish(); this.handlers.onDone?.(data) }
        if (name === 'failed') { this.finish(); this.handlers.onFailed?.(data) }
      })
    }
    es.onopen = () => {
      this.frames++
      this.clearSseTimer()
    }
    es.onerror = () => {
      // close() 之后同样会进这里 —— 已结束的状态绝不能被改写（v1 的 bug 就在这里）
      if (this.finished) return
      if (this.es && this.es.readyState === EventSource.CLOSED) {
        this.toPolling('进度流被服务端/网关断开，改用轮询')
      }
    }
    // SSE 静默超时 → 轮询兜底（有些网关会把 SSE 缓冲到结束）
    this.timer = setTimeout(() => {
      if (!this.finished && this.frames === 0) this.toPolling(`进度流 ${this.opts.sseTimeoutMs}ms 无数据，改用轮询`)
    }, this.opts.sseTimeoutMs)
    return this
  }

  private clearSseTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  private closeSse() {
    this.clearSseTimer()
    try { this.es?.close() } catch { /* ignore */ }
    this.es = null
  }

  private finish() {
    this.finished = true
    this.closeSse()
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
  }

  /** 切到轮询：如实记录 transport，并立刻查一次（不浪费一个轮询周期） */
  private toPolling(note: string) {
    if (this.finished || this.transport === 'poll') return
    this.transport = 'poll'
    this.closeSse()
    this.handlers.onTransport?.('poll', note)
    this.poll(0)
  }

  private poll(n: number) {
    if (this.finished) return
    if (n > this.opts.maxPolls) {
      this.handlers.onTransport?.('poll', `轮询 ${this.opts.maxPolls} 次仍未结束，已停止跟踪（任务可能仍在跑）`)
      return
    }
    this.pollTimer = setTimeout(async () => {
      if (this.finished) return
      try {
        const t: TaskInfo = await api.task(this.taskId)
        this.frames++
        this.handlers.onProgress?.({
          task_id: t.id, progress: t.progress, stage: t.stage,
        })
        if (t.status === 'done') { this.finish(); this.handlers.onDone?.({ task_id: t.id, status: 'done' }) }
        else if (t.status === 'failed' || t.status === 'cancelled') {
          this.finish()
          this.handlers.onFailed?.({ task_id: t.id, error: t.error || t.status, code: t.code })
        } else {
          this.poll(n + 1)
        }
      } catch (e) {
        this.finish()
        this.handlers.onFailed?.({ task_id: this.taskId, error: (e as Error).message, code: 'E_POLL' })
      }
    }, n === 0 ? 0 : this.opts.pollIntervalMs)
  }

  stop() {
    this.finished = true
    this.closeSse()
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
  }
}
