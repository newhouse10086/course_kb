/**
 * 契约类型 —— 字段唯一权威：docs/API_PROTOCOL.md §2（数据模型）/ §5（REST）
 * 写域：apps/web/**（T-FRONTEND）
 *
 * 说明：这里只写前端**确实会读**的字段；未用到的服务端字段用索引签名兜住，
 * 避免契约增删字段时前端整体报错（契约 §9：新增枚举值是兼容，前端未知值降级显示）。
 */

export type DocKind = 'pdf' | 'pptx' | 'docx' | 'video' | 'epub' | 'web' | 'text'
export type DocStatus = 'uploading' | 'parsing' | 'extracting' | 'ready' | 'failed'
export type SpanKind = 'page' | 'slide' | 'time' | 'char'
export type XrefRel = 'typed' | 'mention' | 'also_in' | 'same_unit'

export interface Span {
  kind: SpanKind
  start: number
  end: number
}

export interface DocumentInfo {
  id: string
  title: string
  kind: DocKind | string
  source_path?: string
  size_bytes?: number
  page_count?: number
  lang?: string
  status: DocStatus | string
  meta?: Record<string, unknown>
  created_at?: number
  updated_at?: number
}

/** §2.2 Unit */
export interface Unit {
  id: string
  doc_id: string
  order?: number
  title: string
  level?: number
  parent_id?: string | null
  span?: Span
  text?: string
  text_len?: number
}

/** §5.2 /outline 的节点（含 F3 要求的所有层级 intro/why） */
export interface OutlineNode {
  id: string
  title: string
  level: number
  span?: Span
  children: string[]
  n_cards: number
  n_units: number
  intro?: string
  why?: string
  /** 扩展字段（F3）：学习目标 / 要点 / 体裁 —— 后端给了就渲染 */
  objectives?: string[]
  learning_objectives?: string[]
  key_takeaways?: string[]
  section_role?: string
  intro_source?: string
}

export interface Outline {
  document_id: string
  roots: string[]
  nodes: Record<string, OutlineNode>
}

/** §2.3 知识卡片（22 种 kind 见 contracts/schema/knowledge_card.json） */
export interface Card {
  id: string
  doc_id?: string
  unit_id?: string
  name: string
  kind?: string
  one_line?: string
  purpose?: string
  usage_mode?: string
  operational_role?: string
  lifecycle?: string
  example?: string | null
  example_explained?: string | null
  prerequisites?: string[]
  cautions?: string[]
  evidence_quote?: string
  evidence_span?: Span
  /** SQLite 里是扁平列，REST 可能给扁平字段（两种都要能吃） */
  span_kind?: SpanKind | string
  span_start?: number
  span_end?: number
  confidence?: number
  name_key?: string
}

/** §2.4 图谱 */
export interface GraphNode {
  id: string
  name: string
  name_zh?: string
  type?: string
  layer?: string
  degree?: number
  unit_ids?: string[]
  [k: string]: unknown
}

export interface GraphEdge {
  id?: string
  src: string
  dst: string
  etype: string
  evidence?: string
  span?: Span | null
  confidence?: number
  /** 因果可疑：**只标记不删除**（契约 §2.4），前端画虚线 */
  flagged?: boolean | number
  [k: string]: unknown
}

export interface GraphData {
  document_id?: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats?: { nodes?: number; edges?: number; types?: number; verify_rate?: number }
}

/** §2.5 交叉引用 */
export interface Xref {
  from_card_id: string
  to_card_id: string
  rel: XrefRel | string
  weight?: number
}

export interface CardDetail {
  card: Card
  unit?: { id: string; title: string }
  source?: { kind?: string; file?: string; page?: number; url?: string }
  xrefs?: Array<{ id: string; name?: string; rel?: string }>
  backlinks?: Array<{ id: string; name?: string; rel?: string }>
}

/** §2.6 任务 */
export interface TaskInfo {
  id: string
  doc_id?: string
  kind?: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | string
  progress?: number
  stage?: string
  detail?: Record<string, unknown>
  error?: string | null
  code?: string
  created_at?: number
  finished_at?: number | null
}

export interface UploadAccepted {
  document_id: string
  task_id?: string
  status?: string
  events_url?: string
}

/** §2.7 视频产物 */
export interface VideoSegment {
  i: number
  start: number
  end: number
  text: string
  confidence?: number
}

export interface TranscriptChapter {
  title: string
  start: number
  end: number
  text?: string
  summary?: string
}

export interface VideoSlide {
  index: number
  at_ms: number
  image?: string
  ocr_text?: string
  title?: string
}

export interface VideoArtifact {
  id?: string
  doc_id?: string
  duration_ms?: number
  asr_model?: string
  asr_lang?: string
  segments?: VideoSegment[]
  subtitles?: { srt?: string; vtt?: string }
  transcript?: TranscriptChapter[]
  mindmap?: { format?: string; content?: string }
  slides?: VideoSlide[]
  summary?: string
  overall_summary?: string
  transcript_summary?: string
  [k: string]: unknown
}

/** §5.4 检索 */
export interface SearchHit {
  kind: 'card' | 'unit' | string
  ref_id: string
  title?: string
  snippet?: string
  score?: number
  doc_id?: string
}

export interface SearchResult {
  q: string
  total: number
  hits: SearchHit[]
}

/** 分页响应：契约 §1.1 只规定含 total；列表键名后端可能是 items/xxx（两种都兼容） */
export interface Paged<T> {
  total?: number
  offset?: number
  limit?: number
  items?: T[]
  [k: string]: unknown
}

/** §6 SSE 事件名 */
export type TaskEventName = 'progress' | 'log' | 'artifact' | 'done' | 'failed'

export interface TaskProgressEvent {
  task_id: string
  progress?: number
  stage?: string
  done?: number
  total?: number
}

/* ==========================================================================
   模型设置与沙箱（docs/SETTINGS_AND_SANDBOX.md）
   ========================================================================== */

export interface ModelInfo {
  id: string
  label: string
  provider?: string
  /** 真探测结果（不是"配置了就算可用"） */
  available: boolean
  latencyMs: number | null
  probe?: string
  contextWindow?: number
  reason?: string
}

export interface ModelsResponse {
  models: ModelInfo[]
  activeModel: string
  switchedFrom?: string | null
  switchedAt?: number | null
  /** ★ 系统约束：固定 1，前端**只读展示** */
  concurrency: number
  concurrencyLocked?: boolean
  probe?: { at: number; cached: boolean }
}

export interface SettingsPayload {
  version: number
  /** 'file' = 读到了 settings.json；'default' = 文件缺失用了内置默认（如实上报） */
  source: 'file' | 'default' | string
  llm: {
    active: string
    fallbacks: string[]
    temperature: number
    /** 必须含推理预算（推理模型：max_tokens 太小会静默拿到空 content） */
    maxTokens: number
    structured: { jsonSchemaStrict: boolean }
    concurrency: number
    concurrencyLocked?: boolean
    concurrencyNote?: string
  }
  asr?: Record<string, unknown>
  tts?: Record<string, unknown>
  translate?: Record<string, unknown>
  sandbox?: SandboxState
  quota?: Record<string, { concurrentLlmTasks: number; dailyLlmCalls: number }>
  hotReload?: { watch: boolean; debounceMs: number }
  switchedFrom?: string | null
  switchedAt?: number | null
}

export interface SwitchResult {
  ok?: boolean
  mode?: 'now' | 'drain' | 'abort'
  from?: string
  to?: string
  checkpoint?: { done: number; total: number; taskId?: string }
  resume?: { state: 'idle' | 'resuming' | string; from_checkpoint?: number; total?: number }
  probe?: { model: string; ok: boolean; latencyMs?: number | null; at?: number }
  activeModel?: string
  switchedFrom?: string | null
  switchedAt?: number | null
}

export interface SandboxEngine {
  id: string
  label: string
  available: boolean
  /** 真后端给的是方言族：sqlite / mysql / postgres（不是 "SQLite 3.x" 这种版本串） */
  dialect?: string
  runtime?: string
  reason?: string
  /** 不可用时指向部署文档章节（用户要求：不能只说"不可用"）；真后端把指向写在 reason 里 */
  doc?: string
  /** 真后端上报的**能力矩阵**（诚实渲染：SQLite 没有存储过程就写没有） */
  capabilities?: {
    crud?: boolean
    ddl?: boolean
    transactions?: boolean
    procedures?: boolean
    maxRowsDefault?: number
    [k: string]: unknown
  }
  target?: Record<string, unknown>
}

export interface SandboxLimits { maxRows: number; timeoutMs: number; maxDbBytes?: number; [k: string]: unknown }

/** `GET /capabilities` 的 sandbox 段（真后端已实现） */
export interface SandboxState {
  available?: boolean
  enabled?: boolean
  engine?: string
  defaultEngine?: string
  engineCount?: number
  engines: SandboxEngine[]
  limits: SandboxLimits
  allowWrites?: boolean
  resetPolicy?: string
  [k: string]: unknown
}

/** 真后端 schema 列：`{name,type,pk,notnull,fk,default}` */
export interface SandboxColumn { name: string; type?: string; pk?: boolean; notnull?: boolean; fk?: string | null; default?: unknown }

export interface SandboxTable { name: string; columns: Array<SandboxColumn | string>; rowCount?: number; rows?: number }

export interface SandboxSchema { dialect?: string; tables: SandboxTable[]; [k: string]: unknown }

export interface SandboxDataset {
  id: string
  label: string
  /** 真后端字段名（我第一版写成 note/schema/seed，全是猜的） */
  description?: string
  note?: string
  tables?: string[]
  /** ★ 每个数据集自带教学点与方言差异（真后端有；页面应优先用它，而不是前端硬编码） */
  teachingPoints?: string[]
  dialectNotes?: Array<{ sqlite?: string; mysql?: string; note?: string; [k: string]: unknown }>
  schema?: string
  seed?: string
}

export interface SandboxSession {
  sessionId: string
  dataset: string
  datasetLabel?: string
  engine: string
  /** 真后端把方言放在 `schema.dialect` */
  dialect?: string
  schema?: SandboxSchema | string
  created?: boolean
  dbBytes?: number | null
  capabilities?: Record<string, unknown> | null
  tables?: SandboxTable[]
  limits: SandboxLimits
  dialectNotes?: Array<{ sqlite?: string; mysql?: string; note?: string }>
}

/** 真后端错误对象（带分类器结论：who/who_label/localReading） */
export interface SandboxError {
  code: string
  raw?: string
  /** ⚠️ 真后端字段是 `message`（我 mock 用的是 `msg`） */
  message?: string
  msg?: string
  hint?: string
  localReading?: string
  localMatched?: boolean
  who?: string
  who_label?: string
  who_source?: string
}

export interface SandboxResult {
  sessionId?: string
  ok?: boolean
  columns: string[]
  rows: Array<Array<string | number | null>>
  rowCount: number
  /** ★ 截断必须明示（maxRows）；真后端只给 truncated 布尔，不给 maxRows 回显 */
  truncated: boolean
  maxRows?: number
  elapsedMs?: number | null
  statementKind?: string | null
  engine?: string
  dialect?: string
  affected?: number | null
  dbBytes?: number | null
  hints?: string[]
  /** 学生 SQL 报错时仍是 **HTTP 200** + ok:false + error（契约如此） */
  error?: SandboxError
  killedBy?: string
  hardKilled?: boolean
  tables?: SandboxTable[]
  schema?: SandboxSchema
}

export interface SandboxHistoryEntry {
  at: number
  sql: string
  ok: boolean
  error?: string | null
  rowCount?: number
  elapsedMs?: number
  kind?: string
}


/* ==========================================================================
   身份 / 认证（RBAC.md；真实响应形状以**实测**为准，见 README「mock 与真实的差异」）
   ========================================================================== */

export interface AuthUser {
  id: string
  username: string
  display_name?: string
  /** ⚠️ 真后端把 roles 放在 user 里（不是顶层），也没有 permissions[] */
  roles?: string[]
  status?: string
}

export interface MeResponse {
  user?: AuthUser
  /** 顶层 roles：部分实现会给（mock 用）；真后端没有 → 读 user.roles */
  roles?: string[]
  permissions?: string[]
  authRequired?: boolean
  courses?: { teacher?: string[]; student?: string[] }
  /** 真后端给的一句人话（如 "admin：可见全部"），不是权限枚举 */
  can?: string
}

export interface LoginResponse {
  user?: AuthUser
  courses?: { teacher?: string[]; student?: string[] }
  expires_in_s?: number
  error?: { code: string; msg: string; hint?: string }
}

/** 真后端 `/models.busy` 与 `/settings/llm.busy`：队列忙状态（比前端猜"有没有任务"准） */
export interface BusyInfo {
  busy: boolean
  runningLlm?: string[]
  runningAll?: number
  pending?: number
  llmKinds?: string[]
  source?: string
}
