/**
 * REST 客户端 —— 契约 docs/API_PROTOCOL.md §5（字段唯一权威）
 *
 * 设计要点：
 * · **同源相对路径 `/api/v1`**：dev 下由 Vite proxy 转发到 127.0.0.1:8787；
 *   生产由后端同源托管 dist/。前端永远不发绝对地址（v1 的 file:// CORS 教训在 v2 直接消失）。
 * · `?api=<url>` 可覆盖基址：仅用于联调 / 无头测试（mock server 场景）。
 * · 错误统一成 ApiError（携带契约 §8 的 code/hint），UI 直接渲染而不是抛 "Failed to fetch"。
 */
import type {
  BusyInfo, Card, CardDetail, DocumentInfo, GraphData, LoginResponse, MeResponse, ModelsResponse, Outline, Paged, SandboxDataset,
  SandboxEngine, SandboxHistoryEntry, SandboxResult, SandboxSchema, SandboxSession, SandboxTable, SearchResult,
  SettingsPayload, Span, SwitchResult,
  TaskInfo, Unit, UploadAccepted, VideoArtifact, VideoSlide, TranscriptChapter, Xref,
} from './types'

export const API_BASE: string = (() => {
  if (typeof location === 'undefined') return '/api/v1'
  // 参数可能在 ?query 也可能在 hash query（hash 路由）→ 两处都看
  const search = new URLSearchParams(location.search)
  const h = location.hash || ''
  const i = h.indexOf('?')
  const hashParams = i >= 0 ? new URLSearchParams(h.slice(i + 1)) : null
  const q = search.get('api') || hashParams?.get('api')
  return (q || '/api/v1').replace(/\/$/, '')
})()

/** 未认证回调：由 App 注入（把 401 变成"跳登录页"，而不是把错误糊在页面上） */
let onUnauthenticated: ((detail: string) => void) | null = null
export function setUnauthenticatedHandler(fn: ((detail: string) => void) | null) { onUnauthenticated = fn }

export class ApiError extends Error {
  code: string
  status: number
  detail: string
  hint: string
  /** 机器可读的附加信息（如 409 里的运行中任务进度、502 回滚后的 activeModel） */
  data: any
  constructor(code: string, msg: string, status = 0, detail = '', hint = '', data: any = null) {
    super(msg || code || '请求失败')
    this.name = 'ApiError'
    this.code = code || 'E_UNKNOWN'
    this.status = status
    this.detail = detail
    this.hint = hint
    this.data = data
  }
}

type Params = Record<string, string | number | boolean | undefined | null>

export function qs(params?: Params): string {
  if (!params) return ''
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    usp.set(k, String(v))
  }
  const s = usp.toString()
  return s ? `?${s}` : ''
}

export async function req<T>(path: string, params?: Params, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}${qs(params)}`
  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, ...(init || {}) })
  } catch (e) {
    // 后端没起来：给出可操作说明，而不是 "Failed to fetch"
    throw new ApiError('E_NETWORK', `无法连接后端 ${url}`, 0, String((e as Error)?.message || e),
      '请先启动后端（apps/server: npm run dev，默认 127.0.0.1:8787）')
  }
  const text = await res.text()
  let body: any = null
  if (text) {
    try { body = JSON.parse(text) } catch { body = { raw: text } }
  }
  if (!res.ok) {
    const err = body?.error || {}
    // 401/未认证：交给上层跳登录（真后端 auth.required=true，实测未登录返回 E_UNAUTHENTICATED）
    if (res.status === 401 || err.code === 'E_UNAUTHENTICATED') {
      onUnauthenticated?.(String(err.hint || err.msg || ''))
    }
    throw new ApiError(err.code || `E_HTTP${res.status}`, err.msg || `HTTP ${res.status}`,
      res.status, typeof err.detail === 'string' ? err.detail : '', typeof err.hint === 'string' ? err.hint : '',
      err.data ?? null)
  }
  return body as T
}

/** 列表响应的数组：后端键名可能是 items / documents / cards / units / xrefs（都兼容） */
export function listOf<T>(page: Paged<T> | T[] | null | undefined, ...keys: string[]): T[] {
  if (!page) return []
  if (Array.isArray(page)) return page as T[]
  if (Array.isArray(page.items)) return page.items as T[]
  for (const k of keys) {
    const v = (page as any)[k]
    if (Array.isArray(v)) return v as T[]
  }
  return []
}

export const api = {
  health: () => req<{ ok: boolean; version?: string }>('/health'),

  /** §5.1 能力接口（诚实接口）：UI 必须按 available 渲染 */
  capabilities: () => req<Record<string, unknown>>('/capabilities'),

  // ---- §5.2 文档 ----
  documents: (p?: Params) => req<Paged<DocumentInfo>>('/documents', p),
  document: (id: string) => req<DocumentInfo>(`/documents/${encodeURIComponent(id)}`),
  outline: (id: string) => req<Outline>(`/documents/${encodeURIComponent(id)}/outline`),
  units: (id: string, p?: Params) => req<Paged<Unit>>(`/documents/${encodeURIComponent(id)}/units`, p),
  cards: (id: string, p?: Params) => req<Paged<Card>>(`/documents/${encodeURIComponent(id)}/cards`, p),
  graph: (id: string, p?: Params) => req<GraphData>(`/documents/${encodeURIComponent(id)}/graph`, p),
  xrefs: (id: string, p?: Params) => req<Paged<Xref>>(`/documents/${encodeURIComponent(id)}/xrefs`, p),
  deleteDocument: (id: string) =>
    req<{ ok?: boolean }>(`/documents/${encodeURIComponent(id)}`, undefined, { method: 'DELETE' }),

  /** 上传（§5.2 POST /documents）：用 XHR 以便给出上传进度 */
  uploadDocument(file: File, onProgress?: (frac: number) => void): Promise<UploadAccepted> {
    return new Promise((resolve, reject) => {
      const form = new FormData()
      form.append('file', file)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${API_BASE}/documents`)
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total)
      }
      xhr.onload = () => {
        let body: any = null
        try { body = JSON.parse(xhr.responseText) } catch { body = null }
        if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body as UploadAccepted)
        else {
          const err = body?.error || {}
          reject(new ApiError(err.code || `E_HTTP${xhr.status}`, err.msg || `上传失败 HTTP ${xhr.status}`,
            xhr.status, err.detail || '', err.hint || ''))
        }
      }
      xhr.onerror = () => reject(new ApiError('E_NETWORK', '上传连接失败', 0, '', '确认后端已启动'))
      xhr.send(form)
    })
  },

  // ---- §5.3 卡片与交叉引用 ----
  card: (id: string) => req<CardDetail>(`/cards/${encodeURIComponent(id)}`),
  cardXrefs: (id: string) => req<Paged<any>>(`/cards/${encodeURIComponent(id)}/xrefs`),
  cardBacklinks: (id: string) => req<Paged<any>>(`/cards/${encodeURIComponent(id)}/backlinks`),

  // ---- §5.4 检索 ----
  search: (q: string, p?: Params) => req<SearchResult>('/search', { q, ...(p || {}) }),
  suggest: (q: string) => req<{ q?: string; items?: string[]; suggestions?: string[] }>('/search/suggest', { q }),

  // ---- §5.5 视频 ----
  video: (id: string) => req<VideoArtifact>(`/documents/${encodeURIComponent(id)}/video`),
  videoTranscript: (id: string) =>
    req<Paged<TranscriptChapter>>(`/documents/${encodeURIComponent(id)}/video/transcript`),
  videoMindmap: (id: string) =>
    req<{ format?: string; content?: string }>(`/documents/${encodeURIComponent(id)}/video/mindmap`),
  videoSlides: (id: string) => req<Paged<VideoSlide>>(`/documents/${encodeURIComponent(id)}/video/slides`),
  reparseVideo: (id: string, body?: Record<string, unknown>) =>
    req<{ task_id?: string; id?: string; status?: string }>(
      `/documents/${encodeURIComponent(id)}/video/reparse`, undefined,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),

  // ---- §5.6 任务 ----
  task: (id: string) => req<TaskInfo>(`/tasks/${encodeURIComponent(id)}`),
  cancelTask: (id: string) =>
    req<{ ok?: boolean }>(`/tasks/${encodeURIComponent(id)}/cancel`, undefined, { method: 'POST' }),

  // ---- 身份（RBAC §3：前端只用来决定入口可见性，权限判定永远在服务端） ----
  /**
   * 真实响应（实测）：
   *   POST /auth/login {username,password} → {user:{id,username,display_name,roles,status}, courses:{teacher,student}, expires_in_s}
   *                                         + **httpOnly cookie `ckb_session`**（浏览器自动带）
   *   GET  /auth/me  → {user:{...}, courses, can:"admin：可见全部"}
   * ⚠️ 注意：**roles 在 user 里**（不是顶层），也没有 permissions[] —— 只有一句 `can` 文案。
   *    我第一版按 `{roles, permissions}` 读 → 对着真后端设置入口永远不显示（实测差异）。
   */
  me: () => req<MeResponse>('/auth/me'),
  login: (username: string, password: string) =>
    req<LoginResponse>('/auth/login', undefined, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
  logout: () => req<{ ok?: boolean }>('/auth/logout', undefined, { method: 'POST' }),

  // ---- 任务列表（真后端有；设置页用它判断"有没有在跑的 LLM 任务"） ----
  tasks: () => req<{ tasks?: TaskInfo[]; items?: TaskInfo[] }>('/tasks'),

  // ---- 模型列表与设置（docs/SETTINGS_AND_SANDBOX.md §1/§2） ----
  /** `GET /models?deep=1`：真探测（**不加 deep 时真后端也可能带 latencyMs**，见 README §3A） */
  models: (deep = false) => req<ModelsResponse>(`/models${deep ? '?deep=1' : ''}`),
  /**
   * `GET /settings` 真响应是 `{settings:{...}, meta:{source,path,revision,mtimeMs}}`；
   * 我 mock 用的是**扁平** `{source, llm:{...}}`。这里统一成"扁平 + meta 保留"，
   * 让页面只写一种读法（并在 README §3A 记下差异）。
   */
  settings: async () => {
    const r = await req<{ settings?: SettingsPayload; meta?: { source?: string; path?: string; revision?: number; mtimeMs?: number } } & SettingsPayload>('/settings')
    const flat: SettingsPayload = { ...(r.settings || r) }
    if (r.meta?.source) flat.source = r.meta.source
    ;(flat as any).meta = r.meta ?? null
    return flat
  },
  putSettings: (body: unknown) =>
    req<{ ok?: boolean; settings?: SettingsPayload; ignored?: Array<{ field: string; requested: unknown; applied: unknown; reason: string }> }>(
      '/settings', undefined, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  /** 切换相关的只读视图（真后端有 `switchedFrom/switchedAt/busy`；`/models` 里没有） */
  settingsLlm: () => req<{ activeModel: string; fallbacks?: string[]; concurrency?: number; switchedFrom?: string | null; switchedAt?: number | null; busy?: BusyInfo }>('/settings/llm'),
  /** 模型热切换：mode=now 仅空闲可用；drain 等当前单元；abort 存断点后终止并续推 */
  switchModel: (model: string, mode: 'now' | 'drain' | 'abort') =>
    req<SwitchResult>('/settings/llm/switch', undefined, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, mode }),
    }),

  // ---- 学生虚拟数据库沙箱（SETTINGS §3） ----
  /** 真响应：`{default:'sc', datasets:[{id,label,description,tables,teachingPoints,dialectNotes}]}` */
  sandboxDatasets: () => req<{ default?: string; datasets: SandboxDataset[] }>('/sandbox/datasets'),
  sandboxSession: (dataset: string, sessionId?: string) =>
    req<SandboxSession>('/sandbox/session', undefined, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { dataset, sessionId } : { dataset }),
    }),
  /** 执行 SQL：**失败也返回 200 + ok:false + error**（SQL 报错要显示给学生看，不是网络错误） */
  sandboxExecute: (sessionId: string, sql: string, opts?: { maxRows?: number; timeoutMs?: number }) =>
    req<SandboxResult>('/sandbox/execute', undefined, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, sql, ...(opts || {}) }),
    }),
  /** 真响应：`{sessionId, reset:true, engine, schema}`（**没有 tables 顶层字段**） */
  sandboxReset: (dataset: string, sessionId?: string) =>
    req<{ sessionId?: string; reset?: boolean; engine?: string; schema?: SandboxSchema; ok?: boolean; dataset?: string }>(
      '/sandbox/reset', undefined, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionId ? { dataset, sessionId } : { dataset }),
      }),
  sandboxSchema: (sessionId: string) => req<SandboxSchema & { sessionId?: string }>(`/sandbox/schema${qs({ sessionId })}`),
  sandboxHistory: (sessionId: string) => req<{ sessionId?: string; entries: SandboxHistoryEntry[] }>(`/sandbox/history${qs({ sessionId })}`),
  sandboxEngines: () => req<{ engines?: SandboxEngine[]; defaultEngine?: string }>('/sandbox/engines'),

  // ---- URL 构造（§5.7 / §5.5） ----
  fileUrl: (docId: string, page?: number) =>
    `${API_BASE}/documents/${encodeURIComponent(docId)}/file${page ? `#page=${page}` : ''}`,
  streamUrl: (docId: string) => `${API_BASE}/documents/${encodeURIComponent(docId)}/stream`,
  subtitleUrl: (docId: string, fmt: 'srt' | 'vtt' = 'vtt') =>
    `${API_BASE}/documents/${encodeURIComponent(docId)}/video/subtitle?fmt=${fmt}`,
  /** §3 沙箱答疑（POST + SSE：先问后引 + 引用知识库卡片） */
  sandboxAskUrl: () => `${API_BASE}/sandbox/ask`,
  /** §6 SSE 进度流地址 */
  taskEventsUrl: (taskId: string) => `${API_BASE}/tasks/${encodeURIComponent(taskId)}/events`,
  /** §7.2 对话 WebSocket（同源派生，测试可用 ?ws= 覆盖；参数在 hash query 里也能读到） */
  chatWsUrl: (sessionId: string) => {
    if (typeof location === 'undefined') return `ws://127.0.0.1:8787/api/v1/chat/${sessionId}`
    const h = location.hash || ''
    const i = h.indexOf('?')
    const hashParams = i >= 0 ? new URLSearchParams(h.slice(i + 1)) : null
    const override = new URLSearchParams(location.search).get('ws') || hashParams?.get('ws')
    if (override) return `${override.replace(/\/$/, '')}/${sessionId}`
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}/api/v1/chat/${sessionId}`
  },
}

/** 分页拉全量卡片（卡片是交叉引用与内嵌图谱的索引基础，必须全） */
export async function loadAllCards(docId: string, onProgress?: (n: number, total: number) => void): Promise<Card[]> {
  const first = await api.cards(docId, { offset: 0, limit: 500 })
  const items = listOf<Card>(first, 'cards')
  const total = Number(first?.total ?? items.length)
  let guard = 0
  while (items.length < total && guard++ < 60) {
    const page = await api.cards(docId, { offset: items.length, limit: 500 })
    const chunk = listOf<Card>(page, 'cards')
    if (!chunk.length) break        // 防御：total 与实际不一致时不死循环
    items.push(...chunk)
    onProgress?.(items.length, total)
  }
  return items
}

/** 一次拉全量交叉引用（省掉 N 次 /cards/{id} 详情请求） */
export async function loadAllXrefs(docId: string): Promise<Xref[]> {
  const page = await api.xrefs(docId, { limit: 5000 })
  return listOf<Xref>(page, 'xrefs')
}

/** 卡片 span 归一化：契约 §2.3 给 evidence_span，SQLite 里是扁平列，两种都要能吃 */
export function cardSpan(c: Card | null | undefined): Span | null {
  if (!c) return null
  if (c.evidence_span) return c.evidence_span
  if (c.span_kind || c.span_start || c.span_end) {
    return {
      kind: (c.span_kind || '') as Span['kind'],
      start: Number(c.span_start || 0),
      end: Number(c.span_end ?? c.span_start ?? 0),
    }
  }
  return null
}








