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
  Card, CardDetail, DocumentInfo, GraphData, Outline, Paged, SearchResult, Span,
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

export class ApiError extends Error {
  code: string
  status: number
  detail: string
  hint: string
  constructor(code: string, msg: string, status = 0, detail = '', hint = '') {
    super(msg || code || '请求失败')
    this.name = 'ApiError'
    this.code = code || 'E_UNKNOWN'
    this.status = status
    this.detail = detail
    this.hint = hint
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
    throw new ApiError(err.code || `E_HTTP${res.status}`, err.msg || `HTTP ${res.status}`,
      res.status, err.detail || '', err.hint || '')
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

  // ---- URL 构造（§5.7 / §5.5） ----
  fileUrl: (docId: string, page?: number) =>
    `${API_BASE}/documents/${encodeURIComponent(docId)}/file${page ? `#page=${page}` : ''}`,
  streamUrl: (docId: string) => `${API_BASE}/documents/${encodeURIComponent(docId)}/stream`,
  subtitleUrl: (docId: string, fmt: 'srt' | 'vtt' = 'vtt') =>
    `${API_BASE}/documents/${encodeURIComponent(docId)}/video/subtitle?fmt=${fmt}`,
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
