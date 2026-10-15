/**
 * 数据访问层（SQLite）。**响应体字段逐字对齐契约 §2 / §5**。
 *
 * 命名约定（易错，特此写明）：
 * - 数据库列 `units.ord` ↔ **响应字段 `order`**（契约 §2.2 是 `"order": 12`）
 * - 数据库列 `cards.span_*` ↔ **响应字段 `evidence_span`**（契约 §2.3）
 * - 数据库列 `edges.evidence_text` ↔ **响应字段 `evidence`**；`src_id/dst_id` ↔ **`src`/`dst`**（契约 §5.2）
 * - 数据库列 `documents.meta_json` ↔ **响应字段 `meta`**
 *
 * 所有 `*_json` 列在读取时 `JSON.parse`，解析失败**不抛**（返回默认值），
 * 因为一条坏 JSON 不该让整个列表接口 500 —— 但会记为 `null` 让调用方看得见。
 */

import { Db } from './db.ts';
import { nameKey, newCardId, newDocId, newEdgeId, newEntityId, newTaskId, newUnitId } from './ids.ts';
import { RbacRepo } from './rbac-repo.ts';
import { CollectionsRepo } from './collections-repo.ts';
import { docScopeSql } from './scope.ts';
import type { DocScope } from './scope.ts';
import type { Span, SpanKind } from './types.ts';

/** 全可见（**仅供系统内部/迁移/测试**；路由一律用调用方自己的 scope）。 */
export const ADMIN_SCOPE: DocScope = {
  isAdmin: true,
  userId: null,
  teacherCourseIds: [],
  studentCourseIds: [],
};

// ═══════════════════════════════════════════════════════════════════════
// 行 → API 形状
// ═══════════════════════════════════════════════════════════════════════

export interface DocumentRow {
  id: string;
  title: string;
  kind: string;
  source_path: string;
  size_bytes: number;
  page_count: number;
  lang: string;
  status: string;
  meta_json: string;
  created_at: number;
  updated_at: number;
  // RBAC（docs/RBAC.md §3）：v2 迁移新增的 4 列
  owner_id: string | null;
  visibility: string; // private | course | public
  review_status: string; // draft | reviewed | published
  course_id: string | null;
  /** ★ v4 迁移新增：视频目录归属（可空 —— 不属于任何目录的视频仍可用） */
  collection_id: string | null;
}

export interface DocumentApi {
  id: string;
  title: string;
  kind: string;
  source_path: string;
  size_bytes: number;
  page_count: number;
  lang: string;
  status: string;
  meta: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  counts: { units: number; cards: number; entities: number; edges: number; xrefs: number };
  // RBAC：UI 要显示"草稿/待审/已发布"徽章与归属
  owner_id: string | null;
  visibility: string;
  review_status: string;
  course_id: string | null;
}

export interface UnitRow {
  id: string;
  doc_id: string;
  ord: number;
  title: string;
  level: number;
  parent_id: string | null;
  span_kind: string;
  span_start: number;
  span_end: number;
  text: string;
  text_len: number;
}

export interface UnitApi {
  id: string;
  doc_id: string;
  order: number;
  title: string;
  level: number;
  parent_id: string | null;
  span: Span;
  text: string;
  text_len: number;
}

export interface CardRow {
  id: string;
  doc_id: string;
  unit_id: string;
  name: string;
  kind: string;
  one_line: string;
  purpose: string;
  usage_mode: string;
  operational_role: string;
  lifecycle: string;
  example: string | null;
  example_explained: string | null;
  prerequisites_json: string;
  cautions_json: string;
  evidence_quote: string;
  span_kind: string;
  span_start: number;
  span_end: number;
  confidence: number;
  name_key: string;
}

export interface CardApi {
  id: string;
  doc_id: string;
  unit_id: string;
  name: string;
  kind: string;
  one_line: string;
  purpose: string;
  usage_mode: string;
  operational_role: string;
  lifecycle: string;
  example: string | null;
  example_explained: string | null;
  prerequisites: string[];
  cautions: string[];
  evidence_quote: string;
  evidence_span: Span;
  confidence: number;
}

export interface TaskRow {
  id: string;
  doc_id: string | null;
  kind: string;
  status: string;
  progress: number;
  stage: string;
  detail_json: string;
  error: string | null;
  created_at: number;
  finished_at: number | null;
  // RBAC §5：LLM 并发=1 是全局的 → 必须能按优先级调度并区分师生
  priority: number;
  user_id: string | null;
  /**
   * ★ v8 心跳（看门狗判死依据）；`null` = v8 之前写的行 → 判据回落到 `created_at`
   * （见 `staleRunningTasks` 的 `COALESCE`）。
   */
  heartbeat_at: number | null;
}

export interface TaskApi {
  id: string;
  doc_id: string | null;
  kind: string;
  status: string;
  progress: number;
  stage: string;
  detail: Record<string, unknown>;
  error: string | null;
  created_at: number;
  finished_at: number | null;
  priority: number;
  user_id: string | null;
}

export interface XrefApi {
  from_card_id: string;
  to_card_id: string;
  rel: string;
  weight: number;
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    const v = JSON.parse(text) as unknown;
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function documentToApi(row: DocumentRow, counts: DocumentApi['counts']): DocumentApi {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    source_path: row.source_path,
    size_bytes: row.size_bytes,
    page_count: row.page_count,
    lang: row.lang,
    status: row.status,
    meta: parseJson<Record<string, unknown>>(row.meta_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    counts,
    owner_id: row.owner_id ?? null,
    visibility: row.visibility ?? 'private',
    review_status: row.review_status ?? 'draft',
    course_id: row.course_id ?? null,
  };
}

export function unitToApi(row: UnitRow): UnitApi {
  const text = row.text ?? '';
  return {
    id: row.id,
    doc_id: row.doc_id,
    order: row.ord,
    title: row.title,
    level: row.level,
    parent_id: row.parent_id,
    span: { kind: row.span_kind as SpanKind, start: row.span_start, end: row.span_end },
    text,
    // 契约 §2.2 的 text_len：以库中值为准，缺失时按文本长度兜底
    text_len: row.text_len || text.length,
  };
}

export function cardToApi(row: CardRow): CardApi {
  return {
    id: row.id,
    doc_id: row.doc_id,
    unit_id: row.unit_id,
    name: row.name,
    kind: row.kind,
    one_line: row.one_line ?? '',
    purpose: row.purpose ?? '',
    usage_mode: row.usage_mode ?? 'unknown',
    operational_role: row.operational_role ?? 'unknown',
    lifecycle: row.lifecycle ?? 'unknown',
    example: row.example ?? null,
    example_explained: row.example_explained ?? null,
    prerequisites: parseJson<string[]>(row.prerequisites_json, []),
    cautions: parseJson<string[]>(row.cautions_json, []),
    evidence_quote: row.evidence_quote ?? '',
    evidence_span: {
      kind: (row.span_kind || 'page') as SpanKind,
      start: row.span_start ?? 0,
      end: row.span_end ?? 0,
    },
    confidence: row.confidence ?? 0,
  };
}

export function taskToApi(row: TaskRow): TaskApi {
  return {
    id: row.id,
    doc_id: row.doc_id,
    kind: row.kind,
    status: row.status,
    progress: row.progress ?? 0,
    stage: row.stage ?? '',
    detail: parseJson<Record<string, unknown>>(row.detail_json, {}),
    error: row.error ?? null,
    created_at: row.created_at,
    finished_at: row.finished_at ?? null,
    priority: row.priority ?? 0,
    user_id: row.user_id ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 写入用的 draft 类型（由 worker 结果 / 上传流程产出）
// ═══════════════════════════════════════════════════════════════════════

export interface UnitDraft {
  id?: string;
  ord: number;
  title: string;
  level: number;
  /** 用 ord 表达父子（契约 §4 `UnitDraft.parent_ord`），入库时映射为 id。 */
  parent_ord?: number | null;
  parent_id?: string | null;
  span: Span;
  text: string;
}

export interface CardDraft {
  id?: string;
  unit_id: string;
  name: string;
  kind: string;
  one_line?: string;
  purpose?: string;
  usage_mode?: string;
  operational_role?: string;
  lifecycle?: string;
  example?: string | null;
  example_explained?: string | null;
  prerequisites?: string[];
  cautions?: string[];
  evidence_quote?: string;
  evidence_span?: Span;
  confidence?: number;
}

export interface EntityDraft {
  name: string;
  name_zh?: string;
  layer?: string;
  type: string;
  unit_ids?: string[];
}

export interface EdgeDraft {
  src: string;
  dst: string;
  etype: string;
  evidence_text?: string;
  span?: Span;
  confidence?: number;
  flagged?: boolean;
}

export interface Counts {
  units: number;
  cards: number;
  entities: number;
  edges: number;
  xrefs: number;
}

// ═══════════════════════════════════════════════════════════════════════
// Repo
// ═══════════════════════════════════════════════════════════════════════

export class Repo {
  readonly db: Db;
  /** RBAC 相关表（users/roles/courses/sessions/notes/conversations/audit_log）。 */
  readonly rbac: RbacRepo;
  /** ★ 视频目录（`collections`）—— 独立实体；可见性复用 `docScopeSql`（不引入第二套 RBAC 方言） */
  readonly collections: CollectionsRepo;

  constructor(db: Db) {
    this.db = db;
    this.rbac = new RbacRepo(db);
    this.collections = new CollectionsRepo(db);
  }

  // ── documents ──────────────────────────────────────────────────────

  insertDocument(input: {
    id?: string;
    title: string;
    kind: string;
    source_path: string;
    size_bytes?: number;
    page_count?: number;
    lang?: string;
    status?: string;
    meta?: Record<string, unknown>;
    /** RBAC：上传者；抽取产物默认 `draft`（docs/RBAC.md §2） */
    ownerId?: string | null;
    visibility?: 'private' | 'course' | 'public';
    reviewStatus?: 'draft' | 'reviewed' | 'published';
    courseId?: string | null;
    /**
     * ★ **视频目录归属**（`collections.id`，可空）。
     * ⚠️ 路由必须**先校验可见性 + 管理权**再传进来（见 `routes/collections.ts` 的 `resolveCollectionForUpload`）——
     * 否则就是把"目录"当成了一个可以随便写的外键（越权把视频塞进别人的目录）。
     */
    collectionId?: string | null;
  }): string {
    const id = input.id ?? newDocId();
    const now = Date.now();
    this.db.run(
      `INSERT INTO documents(id,title,kind,source_path,size_bytes,page_count,lang,status,meta_json,created_at,updated_at,
        owner_id,visibility,review_status,course_id,collection_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.title,
      input.kind,
      input.source_path,
      input.size_bytes ?? 0,
      input.page_count ?? 0,
      input.lang ?? '',
      input.status ?? 'uploading',
      JSON.stringify(input.meta ?? {}),
      now,
      now,
      input.ownerId ?? null,
      input.visibility ?? 'private',
      // ★ 新上传一律 draft：模型/人工产物**默认不可见**给学生（RBAC §2）
      input.reviewStatus ?? 'draft',
      input.courseId ?? null,
      input.collectionId ?? null,
    );
    return id;
  }

  /**
   * **系统内部**读取（绕过可见性）—— 任务处理器 / 权限判定内部用。
   * ⚠️ **HTTP 路由不许用它**：路由请用 `getDocumentScopedRow(id, scope)`，
   * 否则会绕过 RBAC §2/§6 的"学生只能看 published"约束。
   */
  getDocumentRow(id: string): DocumentRow | undefined {
    return this.db.get<DocumentRow>('SELECT * FROM documents WHERE id = ?', id);
  }

  /** **系统内部**读取（绕过可见性）。路由请用 `getDocumentScoped`。 */
  getDocument(id: string): DocumentApi | undefined {
    const row = this.getDocumentRow(id);
    if (!row) return undefined;
    return documentToApi(row, this.counts(id));
  }

  // ── 按 scope 读取（★ 路由唯一的合法入口）────────────────────────────

  /** 在 scope 内查单条（SQL 里就带可见性条件 → 不是"先取后判"）。 */
  getDocumentScopedRow(id: string, scope: DocScope): DocumentRow | undefined {
    const frag = docScopeSql(scope);
    return this.db.get<DocumentRow>(`SELECT * FROM documents WHERE id = ? AND ${frag.sql}`, id, ...frag.params);
  }

  getDocumentScoped(id: string, scope: DocScope): DocumentApi | undefined {
    const row = this.getDocumentScopedRow(id, scope);
    if (!row) return undefined;
    return documentToApi(row, this.counts(id));
  }

  /**
   * **系统内部**列表（绕过可见性）。路由请用 `listDocumentsScoped`。
   */
  listDocuments(
    opts: { offset?: number; limit?: number; kind?: string; status?: string } = {},
  ): { total: number; documents: DocumentApi[] } {
    return this.listDocumentsScoped(ADMIN_SCOPE, opts);
  }

  /**
   * 按 scope 列表。
   *
   * ⚠️ 注意参数顺序是 `(scope, opts)`：**scope 是必填的**
   * （没有默认值 → 调用方不可能"忘记传范围"）。
   */
  listDocumentsScoped(
    scope: DocScope,
    opts: { offset?: number; limit?: number; kind?: string; status?: string; reviewStatus?: string } = {},
  ): { total: number; documents: DocumentApi[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    // ★ 可见性条件（§2/§6）：students/public 分支内含 review_status='published'
    const frag = docScopeSql(scope);
    where.push(frag.sql);
    params.push(...frag.params);
    if (opts.kind) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.reviewStatus) {
      where.push('review_status = ?');
      params.push(opts.reviewStatus);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = Number(this.db.scalar<number>(`SELECT COUNT(*) FROM documents ${clause}`, ...params) ?? 0);
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
    const limit = Math.max(1, Math.trunc(opts.limit ?? 50));
    const rows = this.db.all<DocumentRow>(
      `SELECT * FROM documents ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    return { total, documents: rows.map((r) => documentToApi(r, this.counts(r.id))) };
  }

  updateDocument(
    id: string,
    patch: {
      title?: string;
      kind?: string;
      page_count?: number;
      lang?: string;
      status?: string;
      meta?: Record<string, unknown>;
    },
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.kind !== undefined) {
      sets.push('kind = ?');
      params.push(patch.kind);
    }
    if (patch.page_count !== undefined) {
      sets.push('page_count = ?');
      params.push(patch.page_count);
    }
    if (patch.lang !== undefined) {
      sets.push('lang = ?');
      params.push(patch.lang);
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.meta !== undefined) {
      sets.push('meta_json = ?');
      params.push(JSON.stringify(patch.meta));
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(Date.now(), id);
    this.db.run(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`, ...params);
  }

  /** 合并式更新 meta（抽取中途写 section_summaries 等，避免覆盖已有键）。 */
  mergeDocumentMeta(id: string, patch: Record<string, unknown>): void {
    const row = this.getDocumentRow(id);
    if (!row) return;
    const meta = parseJson<Record<string, unknown>>(row.meta_json, {});
    this.updateDocument(id, { meta: { ...meta, ...patch } });
  }

  /**
   * 审核/发布状态机（`docs/RBAC.md` §2）：`draft → reviewed → published`。
   *
   * 状态流转**由权限层保证**（`can(user,'review'|'publish', doc)`）；
   * 这里只做数据写入 + 记录审核人与时间（可追溯）。
   */
  setReviewStatus(id: string, status: 'draft' | 'reviewed' | 'published', byUserId: string | null): boolean {
    const row = this.getDocumentRow(id);
    if (!row) return false;
    const meta = parseJson<Record<string, unknown>>(row.meta_json, {});
    const reviewLog = Array.isArray(meta.review_log) ? (meta.review_log as unknown[]) : [];
    reviewLog.push({ from: row.review_status, to: status, by: byUserId, at: Date.now() });
    return this.db.tx(() => {
      this.db.run('UPDATE documents SET review_status = ?, meta_json = ?, updated_at = ? WHERE id = ?',
        status,
        JSON.stringify({ ...meta, review_log: reviewLog }),
        Date.now(),
        id,
      );
      return true;
    });
  }

  /** 课程归属 / 可见性（教师给自己的资料挂课程、设 public 等）。 */
  setDocumentScope(
    id: string,
    patch: { courseId?: string | null; visibility?: 'private' | 'course' | 'public' },
  ): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.courseId !== undefined) {
      sets.push('course_id = ?');
      params.push(patch.courseId);
    }
    if (patch.visibility !== undefined) {
      sets.push('visibility = ?');
      params.push(patch.visibility);
    }
    if (sets.length === 0) return false;
    sets.push('updated_at = ?');
    params.push(Date.now(), id);
    return this.db.run(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`, ...params).changes > 0;
  }

  /** 删除文档（FK ON DELETE CASCADE 清 units/cards/edges/xrefs/tasks/video；检索索引要显式清）。 */
  deleteDocument(id: string): boolean {
    const exists = this.getDocumentRow(id);
    if (!exists) return false;
    return this.db.tx(() => {
      this.db.ftsDeleteDoc(id);
      this.db.run('DELETE FROM documents WHERE id = ?', id);
      return true;
    });
  }

  counts(docId: string): Counts {
    return {
      units: Number(this.db.scalar<number>('SELECT COUNT(*) FROM units WHERE doc_id = ?', docId) ?? 0),
      cards: Number(this.db.scalar<number>('SELECT COUNT(*) FROM cards WHERE doc_id = ?', docId) ?? 0),
      entities: Number(this.db.scalar<number>('SELECT COUNT(*) FROM entities WHERE doc_id = ?', docId) ?? 0),
      edges: Number(this.db.scalar<number>('SELECT COUNT(*) FROM edges WHERE doc_id = ?', docId) ?? 0),
      xrefs: Number(
        this.db.scalar<number>(
          'SELECT COUNT(*) FROM xrefs WHERE from_card_id IN (SELECT id FROM cards WHERE doc_id = ?)',
          docId,
        ) ?? 0,
      ),
    };
  }

  globalCounts(): Counts {
    return {
      units: Number(this.db.scalar<number>('SELECT COUNT(*) FROM units') ?? 0),
      cards: Number(this.db.scalar<number>('SELECT COUNT(*) FROM cards') ?? 0),
      entities: Number(this.db.scalar<number>('SELECT COUNT(*) FROM entities') ?? 0),
      edges: Number(this.db.scalar<number>('SELECT COUNT(*) FROM edges') ?? 0),
      xrefs: Number(this.db.scalar<number>('SELECT COUNT(*) FROM xrefs') ?? 0),
    };
  }

  countDocuments(): number {
    return Number(this.db.scalar<number>('SELECT COUNT(*) FROM documents') ?? 0);
  }

  // ── units ──────────────────────────────────────────────────────────

  /**
   * 全量替换某文档的 units（解析结果整体覆盖，幂等可重跑）。
   *
   * `parent_ord` → `parent_id` 映射在这里做（契约 §4：draft 用 ord 表达父子，入库映射为 id）。
   * 先按 ord 建好 id，再回填 parent_id，避免顺序依赖。
   *
   * ## ★★ 为什么不是"先全量 DELETE 再 INSERT"（机制 2 修复，Lead 授权 2026-10-15）
   *
   * 原实现的第一行是 `DELETE FROM units WHERE doc_id = ?`。而
   * `cards.unit_id REFERENCES units(id) **ON DELETE CASCADE**` —— 于是**每次解析都会清空该文档的全部卡片**，
   * 包括 **reparse 成功** 的情况（实测：重跑前 cards=1 → 重跑后 cards=0，单元 id 全变）。
   * 更关键的是：**级联发生在 DELETE 那一刻** —— 三步实验证明
   * ```
   * ① 建好：cards = 1
   * ② DELETE FROM units 之后：cards = 0   ← 级联已发生
   * ③ 用**同一个 id** 重新 INSERT 之后：cards = 0   ← 救不回来
   * ```
   * ⟹ **稳定 id 单独不够**：必须让"仍在的单元"**不被删除**。
   *
   * ## 两条边界（Lead 明确要求）
   * 1. ★ **`drafts` 为空 → 一个都不删**：解析产不出单元 = **失败**，
   *    **失败不清库**（与 extract 侧"零卡片+有失败 → 不覆盖旧产物"同一原则）。
   *    否则 `stale = 现有全部` → 删光 → 卡片级联删光（本 bug 的另一条触发路径）。
   * 2. 单元**正文变了 → id 会变**（调用方 `planUnitIds` 只在结构+正文相同时复用旧 id）
   *    → 旧 id 不在 keep 里 → 删除 → **它的卡片级联删掉**：**这是对的**
   *    （正文变了，旧卡片的 `evidence_quote` 已经对不上原文，必须重抽）。
   */
  replaceUnits(docId: string, drafts: UnitDraft[]): string[] {
    return this.db.tx(() => {
      const ids = drafts.map((d) => d.id ?? newUnitId());
      // ★ 解析产不出单元 = 失败 → **不清库**（否则 stale=全部 → 卡片级联删光）
      if (drafts.length === 0) {
        return [];
      }
      // ★ 只删"本次不再存在"的单元（保留仍在的 → 其卡片不被级联删除）
      const keep = new Set(ids);
      const stale = this.allUnitRows(docId)
        .map((u) => u.id)
        .filter((id) => !keep.has(id));
      if (stale.length > 0) {
        this.db.run(
          `DELETE FROM units WHERE doc_id = ? AND id IN (${stale.map(() => '?').join(',')})`,
          docId,
          ...stale,
        );
      }
      const ordToId = new Map<number, string>();
      drafts.forEach((d, i) => ordToId.set(d.ord, ids[i] as string));

      const stmt = this.db.stmt(
        `INSERT INTO units(id,doc_id,ord,title,level,parent_id,span_kind,span_start,span_end,text,text_len)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           ord=excluded.ord, title=excluded.title, level=excluded.level,
           parent_id=excluded.parent_id, span_kind=excluded.span_kind,
           span_start=excluded.span_start, span_end=excluded.span_end,
           text=excluded.text, text_len=excluded.text_len`,
      );
      drafts.forEach((d, i) => {
        const text = d.text ?? '';
        const parentId =
          d.parent_id ?? (d.parent_ord === null || d.parent_ord === undefined ? null : ordToId.get(d.parent_ord) ?? null);
        stmt.run(
          ids[i],
          docId,
          d.ord,
          d.title ?? '',
          d.level ?? 1,
          parentId,
          d.span.kind,
          d.span.start,
          d.span.end,
          text,
          text.length,
        );
      });
      return ids;
    });
  }

  getUnit(id: string): UnitApi | undefined {
    const row = this.db.get<UnitRow>('SELECT * FROM units WHERE id = ?', id);
    return row ? unitToApi(row) : undefined;
  }

  getUnitRow(id: string): UnitRow | undefined {
    return this.db.get<UnitRow>('SELECT * FROM units WHERE id = ?', id);
  }

  allUnitRows(docId: string): UnitRow[] {
    return this.db.all<UnitRow>('SELECT * FROM units WHERE doc_id = ? ORDER BY ord ASC, id ASC', docId);
  }

  listUnits(docId: string, opts: { offset?: number; limit?: number } = {}): { total: number; units: UnitApi[] } {
    const total = Number(this.db.scalar<number>('SELECT COUNT(*) FROM units WHERE doc_id = ?', docId) ?? 0);
    const rows = this.db.all<UnitRow>(
      'SELECT * FROM units WHERE doc_id = ? ORDER BY ord ASC, id ASC LIMIT ? OFFSET ?',
      docId,
      Math.max(1, Math.trunc(opts.limit ?? 500)),
      Math.max(0, Math.trunc(opts.offset ?? 0)),
    );
    return { total, units: rows.map(unitToApi) };
  }

  // ── cards ──────────────────────────────────────────────────────────

  /** 全量替换某文档的 cards（抽取结果整体覆盖）。 */
  replaceCards(docId: string, drafts: CardDraft[]): string[] {
    return this.db.tx(() => {
      this.db.run('DELETE FROM cards WHERE doc_id = ?', docId);
      return this.insertCardsNoTx(docId, drafts);
    });
  }

  private insertCardsNoTx(docId: string, drafts: CardDraft[]): string[] {
    const stmt = this.db.stmt(
      `INSERT INTO cards(id,doc_id,unit_id,name,kind,one_line,purpose,usage_mode,operational_role,
        lifecycle,example,example_explained,prerequisites_json,cautions_json,evidence_quote,
        span_kind,span_start,span_end,confidence,name_key)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const ids: string[] = [];
    for (const c of drafts) {
      const id = c.id ?? newCardId();
      ids.push(id);
      const span = c.evidence_span;
      stmt.run(
        id,
        docId,
        c.unit_id,
        c.name,
        c.kind,
        c.one_line ?? '',
        c.purpose ?? '',
        c.usage_mode ?? 'unknown',
        c.operational_role ?? 'unknown',
        c.lifecycle ?? 'unknown',
        c.example ?? null,
        c.example_explained ?? null,
        JSON.stringify(c.prerequisites ?? []),
        JSON.stringify(c.cautions ?? []),
        c.evidence_quote ?? '',
        span?.kind ?? '',
        span?.start ?? 0,
        span?.end ?? 0,
        c.confidence ?? 0,
        nameKey(c.name),
      );
    }
    return ids;
  }

  getCardRow(id: string): CardRow | undefined {
    return this.db.get<CardRow>('SELECT * FROM cards WHERE id = ?', id);
  }

  getCard(id: string): CardApi | undefined {
    const row = this.getCardRow(id);
    return row ? cardToApi(row) : undefined;
  }

  allCardRows(docId: string): CardRow[] {
    return this.db.all<CardRow>(
      'SELECT * FROM cards WHERE doc_id = ? ORDER BY unit_id ASC, id ASC',
      docId,
    );
  }

  listCards(docId: string, opts: { offset?: number; limit?: number } = {}): { total: number; cards: CardApi[] } {
    const total = Number(this.db.scalar<number>('SELECT COUNT(*) FROM cards WHERE doc_id = ?', docId) ?? 0);
    const rows = this.db.all<CardRow>(
      'SELECT * FROM cards WHERE doc_id = ? ORDER BY unit_id ASC, id ASC LIMIT ? OFFSET ?',
      docId,
      Math.max(1, Math.trunc(opts.limit ?? 200)),
      Math.max(0, Math.trunc(opts.offset ?? 0)),
    );
    return { total, cards: rows.map(cardToApi) };
  }

  /** 契约 §5.2 `/outline` 的 `n_cards` 用：按 unit 统计卡片数。 */
  cardCountsByUnit(docId: string): Map<string, number> {
    const rows = this.db.all<{ unit_id: string; c: number }>(
      'SELECT unit_id, COUNT(*) AS c FROM cards WHERE doc_id = ? GROUP BY unit_id',
      docId,
    );
    return new Map(rows.map((r) => [r.unit_id, Number(r.c)]));
  }

  // ── entities / edges ───────────────────────────────────────────────

  /**
   * 全量替换图谱。
   *
   * **同名实体跨单元归并**（契约 §2.4：实体是文档级的），用 `name_key` 归并；
   * 边按 `UNIQUE(doc_id,src_id,dst_id,etype)` 去重（契约 §3 DDL 就是为此设计的）。
   */
  replaceGraph(
    docId: string,
    entities: EntityDraft[],
    edges: EdgeDraft[],
  ): { entities: Map<string, string>; edges: number } {
    return this.db.tx(() => {
      this.db.run('DELETE FROM edges WHERE doc_id = ?', docId);
      this.db.run('DELETE FROM entities WHERE doc_id = ?', docId);

      const byKey = new Map<string, { id: string; draft: EntityDraft }>();
      const insEnt = this.db.stmt(
        'INSERT INTO entities(id,doc_id,name,name_zh,layer,type,degree,name_key) VALUES(?,?,?,?,?,?,?,?)',
      );
      for (const e of entities) {
        const key = nameKey(e.name);
        const existing = byKey.get(key);
        if (existing) {
          // 归并：补空字段，保留更完整的名字
          if (!existing.draft.name_zh && e.name_zh) existing.draft.name_zh = e.name_zh;
          if (!existing.draft.layer && e.layer) existing.draft.layer = e.layer;
          if (existing.draft.unit_ids && e.unit_ids) {
            existing.draft.unit_ids = [...new Set([...existing.draft.unit_ids, ...e.unit_ids])];
          }
          continue;
        }
        const id = newEntityId();
        byKey.set(key, { id, draft: { ...e, unit_ids: e.unit_ids ? [...e.unit_ids] : [] } });
        insEnt.run(id, docId, e.name, e.name_zh ?? '', e.layer ?? '', e.type, 0, key);
      }

      const insEdge = this.db.stmt(
        `INSERT OR IGNORE INTO edges(id,doc_id,src_id,dst_id,etype,evidence_text,span_kind,span_start,span_end,confidence,flagged)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const degree = new Map<string, number>();
      let n = 0;
      for (const ed of edges) {
        const src = byKey.get(nameKey(ed.src));
        const dst = byKey.get(nameKey(ed.dst));
        // 自引用边丢弃（契约 §2.5 教训 7 的同源处理：自引用不是关系）
        if (!src || !dst || src.id === dst.id) continue;
        const res = insEdge.run(
          newEdgeId(),
          docId,
          src.id,
          dst.id,
          ed.etype,
          ed.evidence_text ?? '',
          ed.span?.kind ?? '',
          ed.span?.start ?? 0,
          ed.span?.end ?? 0,
          ed.confidence ?? 0,
          ed.flagged ? 1 : 0,
        );
        if (res.changes > 0) {
          n += 1;
          degree.set(src.id, (degree.get(src.id) ?? 0) + 1);
          degree.set(dst.id, (degree.get(dst.id) ?? 0) + 1);
        }
      }
      const updDegree = this.db.stmt('UPDATE entities SET degree = ? WHERE id = ?');
      for (const [id, d] of degree) updDegree.run(d, id);

      return { entities: new Map([...byKey].map(([k, v]) => [k, v.id])), edges: n };
    });
  }

  getGraph(docId: string): {
    nodes: {
      id: string;
      name: string;
      name_zh: string;
      type: string;
      layer: string;
      degree: number;
      unit_ids: string[];
    }[];
    edges: {
      id: string;
      src: string;
      dst: string;
      etype: string;
      evidence: string;
      span: Span;
      confidence: number;
      flagged: boolean;
    }[];
  } {
    const entRows = this.db.all<{
      id: string;
      name: string;
      name_zh: string;
      layer: string;
      type: string;
      degree: number;
      name_key: string;
    }>('SELECT * FROM entities WHERE doc_id = ? ORDER BY name ASC', docId);

    const edgeRows = this.db.all<{
      id: string;
      src_id: string;
      dst_id: string;
      etype: string;
      evidence_text: string;
      span_kind: string;
      span_start: number;
      span_end: number;
      confidence: number;
      flagged: number;
    }>('SELECT * FROM edges WHERE doc_id = ? ORDER BY id ASC', docId);

    // unit_ids 的**推导**（不是编造）：实体名 → 同名卡片所在 unit；再并入边的 span 落在哪些 unit
    const unitByCardKey = new Map<string, Set<string>>();
    for (const r of this.db.all<{ name_key: string; unit_id: string }>(
      'SELECT DISTINCT name_key, unit_id FROM cards WHERE doc_id = ?',
      docId,
    )) {
      const set = unitByCardKey.get(r.name_key) ?? new Set<string>();
      set.add(r.unit_id);
      unitByCardKey.set(r.name_key, set);
    }
    const units = this.allUnitRows(docId);
    const spanToUnits = (kind: string, start: number, end: number): string[] => {
      if (!kind) return [];
      const out: string[] = [];
      for (const u of units) {
        if (u.span_kind !== kind) continue;
        if (start <= u.span_end && end >= u.span_start) out.push(u.id);
      }
      return out;
    };

    const entById = new Map(entRows.map((r) => [r.id, r]));
    const unitIds = new Map<string, Set<string>>();
    for (const r of entRows) {
      const set = new Set<string>(unitByCardKey.get(r.name_key) ?? []);
      unitIds.set(r.id, set);
    }
    for (const e of edgeRows) {
      const touched = spanToUnits(e.span_kind, e.span_start, e.span_end);
      for (const eid of [e.src_id, e.dst_id]) {
        const set = unitIds.get(eid);
        if (set) for (const u of touched) set.add(u);
      }
    }

    return {
      nodes: entRows.map((r) => ({
        id: r.id,
        name: r.name,
        name_zh: r.name_zh ?? '',
        type: r.type,
        layer: r.layer ?? '',
        degree: r.degree ?? 0,
        unit_ids: [...(unitIds.get(r.id) ?? new Set<string>())].slice(0, 20),
      })),
      edges: edgeRows
        .filter((e) => entById.has(e.src_id) && entById.has(e.dst_id))
        .map((e) => ({
          id: e.id,
          src: e.src_id,
          dst: e.dst_id,
          etype: e.etype,
          evidence: e.evidence_text ?? '',
          span: { kind: (e.span_kind || 'page') as SpanKind, start: e.span_start ?? 0, end: e.span_end ?? 0 },
          confidence: e.confidence ?? 0,
          flagged: Boolean(e.flagged),
        })),
    };
  }

  // ── xrefs ──────────────────────────────────────────────────────────

  replaceXrefs(docId: string, xrefs: XrefApi[]): number {
    return this.db.tx(() => {
      this.db.run(
        'DELETE FROM xrefs WHERE from_card_id IN (SELECT id FROM cards WHERE doc_id = ?)',
        docId,
      );
      const stmt = this.db.stmt(
        'INSERT OR IGNORE INTO xrefs(from_card_id,to_card_id,rel,weight) VALUES(?,?,?,?)',
      );
      let n = 0;
      for (const x of xrefs) {
        // 自引用不入库（契约 §2.5：`all(x.from_card_id != x.to_card_id)`）
        if (x.from_card_id === x.to_card_id) continue;
        const res = stmt.run(x.from_card_id, x.to_card_id, x.rel, x.weight ?? 1);
        if (res.changes > 0) n += 1;
      }
      return n;
    });
  }

  listXrefs(docId: string): XrefApi[] {
    return this.db.all<XrefApi>(
      `SELECT x.from_card_id, x.to_card_id, x.rel, x.weight FROM xrefs x
       JOIN cards c ON c.id = x.from_card_id WHERE c.doc_id = ? ORDER BY x.rel, x.from_card_id`,
      docId,
    );
  }

  cardXrefs(cardId: string): { id: string; name: string; rel: string; weight: number }[] {
    return this.db.all<{ id: string; name: string; rel: string; weight: number }>(
      `SELECT x.to_card_id AS id, c.name AS name, x.rel AS rel, x.weight AS weight
       FROM xrefs x JOIN cards c ON c.id = x.to_card_id
       WHERE x.from_card_id = ? ORDER BY x.rel, c.name`,
      cardId,
    );
  }

  cardBacklinks(cardId: string): { id: string; name: string; rel: string; weight: number }[] {
    return this.db.all<{ id: string; name: string; rel: string; weight: number }>(
      `SELECT x.from_card_id AS id, c.name AS name, x.rel AS rel, x.weight AS weight
       FROM xrefs x JOIN cards c ON c.id = x.from_card_id
       WHERE x.to_card_id = ? ORDER BY x.rel, c.name`,
      cardId,
    );
  }

  // ── tasks ──────────────────────────────────────────────────────────

  insertTask(input: {
    id?: string;
    docId?: string | null;
    kind: string;
    status?: string;
    stage?: string;
    detail?: Record<string, unknown>;
    /** RBAC §5：0 = 教师/系统，1 = 学生（数字越小越先） */
    priority?: number;
    userId?: string | null;
  }): string {
    const id = input.id ?? newTaskId();
    this.db.run(
      `INSERT INTO tasks(id,doc_id,kind,status,progress,stage,detail_json,error,created_at,finished_at,priority,user_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.docId ?? null,
      input.kind,
      input.status ?? 'queued',
      0,
      input.stage ?? '',
      JSON.stringify(input.detail ?? {}),
      null,
      Date.now(),
      null,
      Number.isFinite(input.priority) ? Number(input.priority) : 0,
      input.userId ?? null,
    );
    return id;
  }

  /** 某用户当前"未结束"的任务数（RBAC §5 配额判定用：queued + running）。 */
  countActiveTasksFor(userId: string): number {
    return Number(
      this.db.scalar<number>(
        "SELECT COUNT(*) FROM tasks WHERE user_id = ? AND status IN ('queued','running')",
        userId,
      ) ?? 0,
    );
  }

  /** 队列启动恢复用：按优先级（升序）+ 创建时间取待跑任务。 */
  pendingTasksByPriority(limit = 500): TaskRow[] {
    return this.db.all<TaskRow>(
      `SELECT * FROM tasks WHERE status = 'queued'
       ORDER BY priority ASC, created_at ASC LIMIT ?`,
      limit,
    );
  }

  getTaskRow(id: string): TaskRow | undefined {
    return this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
  }

  getTask(id: string): TaskApi | undefined {
    const row = this.getTaskRow(id);
    return row ? taskToApi(row) : undefined;
  }

  listTasks(opts: { docId?: string; status?: string; limit?: number } = {}): TaskApi[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.docId) {
      where.push('doc_id = ?');
      params.push(opts.docId);
    }
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db.all<TaskRow>(
      `SELECT * FROM tasks ${clause} ORDER BY created_at DESC LIMIT ?`,
      ...params,
      Math.max(1, Math.trunc(opts.limit ?? 50)),
    );
    return rows.map(taskToApi);
  }

  /**
   * ★ 心跳（看门狗用，v8）：**只写 `heartbeat_at`**，不碰 `status/progress`。
   *
   * 为什么不复用 `updateTask({status:'running'})`：那会顺带改 `progress`/`stage`，
   * 与真正在写进度的调用竞争 —— 心跳是"**我还活着**"的信号，语义要单一。
   */
  touchTaskHeartbeat(id: string, at = Date.now()): void {
    this.db.run('UPDATE tasks SET heartbeat_at = ? WHERE id = ?', at, id);
  }

  /**
   * ★ 看门狗：找出"**看起来在跑、其实已经死了**"的任务（v8）。
   *
   * 判据 = `status='running'` **且** `COALESCE(heartbeat_at, created_at) < cutoff`。
   *
   * ⚠️ 两条都是**故意**的：
   * - 用 `COALESCE(heartbeat_at, created_at)`：老库的 running 行没有心跳（v8 之前写的），
   *   若只认 `heartbeat_at` → **僵尸任务永远判不死**（正是要修的 bug）。
   * - `cutoff` 由调用方按 `COURSE_KB_TASK_STALE_MS` 算，**必须大于单步最长耗时**：
   *   OCR 434 页 ~40 分钟，**慢 ≠ 死**（判死阈值 30 分钟 + 运行期心跳续命）。
   */
  staleRunningTasks(cutoff: number): TaskRow[] {
    return this.db.all<TaskRow>(
      `SELECT * FROM tasks
        WHERE status = 'running'
          AND COALESCE(heartbeat_at, created_at) < ?
        ORDER BY COALESCE(heartbeat_at, created_at) ASC`,
      cutoff,
    );
  }

  /** 所有 `running` 任务（判"某文档是否真的还有任务在跑"用，**不许**用 `extracting` 状态反推）。 */
  runningTaskRows(): TaskRow[] {
    return this.db.all<TaskRow>("SELECT * FROM tasks WHERE status = 'running'");
  }

  /**
   * ★ 按状态列文档 id（看门狗自愈用，v8）。
   *
   * 只回 `id/status` —— 自愈只需要这两个字段，**不必要地读全表**（含 meta_json 大字段）会白白变慢。
   */
  documentsByStatus(status: string): { id: string; status: string }[] {
    return this.db.all<{ id: string; status: string }>(
      'SELECT id, status FROM documents WHERE status = ? ORDER BY created_at ASC',
      status,
    );
  }

  updateTask(
    id: string,
    patch: {
      status?: string;
      progress?: number;
      stage?: string;
      detail?: Record<string, unknown>;
      error?: string | null;
      /** ★ v8 心跳（看门狗）；一般用 `touchTaskHeartbeat` */
      heartbeatAt?: number;
    },
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.heartbeatAt !== undefined) {
      sets.push('heartbeat_at = ?');
      params.push(Math.trunc(patch.heartbeatAt));
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.progress !== undefined) {
      sets.push('progress = ?');
      params.push(Math.max(0, Math.min(1, patch.progress)));
    }
    if (patch.stage !== undefined) {
      sets.push('stage = ?');
      params.push(patch.stage);
    }
    if (patch.detail !== undefined) {
      sets.push('detail_json = ?');
      params.push(JSON.stringify(patch.detail));
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      params.push(patch.error);
    }
    if (sets.length === 0) return;
    if (patch.status === 'done' || patch.status === 'failed' || patch.status === 'cancelled') {
      sets.push('finished_at = ?');
      params.push(Date.now());
    }
    params.push(id);
    this.db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...params);
  }

  // ── video artifacts（契约 §2.7）─────────────────────────────────────

  getVideoArtifact(docId: string): Record<string, unknown> | undefined {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM video_artifacts WHERE doc_id = ?', docId);
    if (!row) return undefined;
    return {
      id: `vid_${String(row.doc_id).replace(/^doc_/, '')}`,
      doc_id: row.doc_id,
      duration_ms: row.duration_ms ?? 0,
      asr_model: row.asr_model ?? '',
      asr_lang: row.asr_lang ?? '',
      segments: parseJson<unknown[]>(row.segments_json as string, []),
      subtitles: { srt: row.subtitle_srt ?? '', vtt: row.subtitle_vtt ?? '' },
      transcript: parseJson<unknown[]>(row.transcript_json as string, []),
      mindmap: { format: row.mindmap_format ?? '', content: row.mindmap_content ?? '' },
      slides: parseJson<unknown[]>(row.slides_json as string, []),
    };
  }

  upsertVideoArtifact(docId: string, data: Record<string, unknown>): void {
    const subtitles = (data.subtitles ?? {}) as Record<string, unknown>;
    const mindmap = (data.mindmap ?? {}) as Record<string, unknown>;
    this.db.run(
      `INSERT INTO video_artifacts(doc_id,duration_ms,asr_model,asr_lang,segments_json,subtitle_srt,
        subtitle_vtt,transcript_json,mindmap_format,mindmap_content,slides_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(doc_id) DO UPDATE SET
         duration_ms=excluded.duration_ms, asr_model=excluded.asr_model, asr_lang=excluded.asr_lang,
         segments_json=excluded.segments_json, subtitle_srt=excluded.subtitle_srt,
         subtitle_vtt=excluded.subtitle_vtt, transcript_json=excluded.transcript_json,
         mindmap_format=excluded.mindmap_format, mindmap_content=excluded.mindmap_content,
         slides_json=excluded.slides_json`,
      docId,
      data.duration_ms ?? 0,
      data.asr_model ?? '',
      data.asr_lang ?? '',
      JSON.stringify(data.segments ?? []),
      (subtitles.srt as string) ?? '',
      (subtitles.vtt as string) ?? '',
      JSON.stringify(data.transcript ?? []),
      (mindmap.format as string) ?? '',
      (mindmap.content as string) ?? '',
      JSON.stringify(data.slides ?? []),
    );
  }
}
