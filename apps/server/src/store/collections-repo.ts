/**
 * ★ **视频目录**（`collections`）—— 独立实体，不是 `documents` 的一列。
 *
 * ## 为什么独立表（Lead 征询过的裁定）
 * 1. **目录是实体**：重命名/排序/独立发布/将来权限 —— 一列**很快不够用**。
 * 2. ★ **目录必须能独立于视频发布**（学生"选某个文件夹"→ 文件夹本身有可见性）。
 * 3. ★★ **复用既有可见性**：本表与 `documents` **同构**（`owner_id`/`visibility`/`review_status`/`course_id`）
 *    → `docScopeSql(scope)` **逐字复用**（`store/scope.ts`），**不引入第二套 RBAC 方言**。
 *    这直接兑现"新接口不许成为绕过 RBAC 的后门"。
 *
 * ⚠️ 若按"`documents` 加一列"实现，学生可见性只能靠猜字符串/另写一套判断 —— 那是两套权限的起点。
 */
import type { Db } from './db.ts';
import { newId } from './ids.ts';
import type { DocumentRow } from './repo.ts';
import { docScopeSql, type DocScope } from './scope.ts';

export interface CollectionRow {
  id: string;
  name: string;
  description: string;
  owner_id: string | null;
  visibility: string;
  review_status: string;
  course_id: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

/** 对外的目录对象（前端直接绑）。 */
export interface CollectionApi {
  id: string;
  name: string;
  description: string;
  owner_id: string | null;
  visibility: string;
  review_status: string;
  /** ★ 派生布尔（= `review_status === 'published'`），前端不必自己推 */
  published: boolean;
  video_count: number;
  /** ★ **服务端权威**：admin 或 owner（前端不许自己推权限） */
  can_manage: boolean;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

/** 谁能管理该目录：**admin 或 owner**（服务端判定，绝不读客户端帧）。 */
export function canManageCollection(row: Pick<CollectionRow, 'owner_id'>, scope: DocScope): boolean {
  if (scope.isAdmin) return true;
  return Boolean(scope.userId && row.owner_id === scope.userId);
}

export class CollectionsRepo {
  private readonly db: Db;

  // ⚠️ 坑 T1：Node strip-only TS **不支持参数属性**（`constructor(private db: Db)` 会直接崩）
  constructor(db: Db) {
    this.db = db;
  }

  create(input: {
    id?: string;
    name: string;
    description?: string;
    ownerId: string;
    visibility?: 'private' | 'course' | 'public';
    reviewStatus?: 'draft' | 'reviewed' | 'published';
    courseId?: string | null;
    sortOrder?: number;
  }): string {
    const id = input.id ?? newId('col');
    const now = Date.now();
    this.db.run(
      `INSERT INTO collections(id,name,description,owner_id,visibility,review_status,course_id,sort_order,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.name,
      input.description ?? '',
      input.ownerId,
      input.visibility ?? 'private',
      // ★ 新建目录默认 draft（与上传的文档一致：**默认对学生不可见**，要显式发布）
      input.reviewStatus ?? 'draft',
      input.courseId ?? null,
      input.sortOrder ?? 0,
      now,
      now,
    );
    return id;
  }

  /** **系统内部**读取（绕过可见性）。⚠️ 路由请用 `getScopedRow`。 */
  getRow(id: string): CollectionRow | undefined {
    return this.db.get<CollectionRow>('SELECT * FROM collections WHERE id = ?', id);
  }

  /** ★ **路由唯一的合法入口**：不可见 ⇒ 视为不存在（与文档一致，不泄露"存在但你看不到"）。 */
  getScopedRow(id: string, scope: DocScope): CollectionRow | undefined {
    const frag = docScopeSql(scope);
    return this.db.get<CollectionRow>(`SELECT * FROM collections WHERE id = ? AND ${frag.sql}`, id, ...frag.params);
  }

  countVideos(collectionId: string): number {
    const row = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM documents WHERE collection_id = ?', collectionId);
    return row?.n ?? 0;
  }

  private toApi(row: CollectionRow, scope: DocScope): CollectionApi {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      owner_id: row.owner_id,
      visibility: row.visibility,
      review_status: row.review_status,
      published: row.review_status === 'published',
      video_count: this.countVideos(row.id),
      can_manage: canManageCollection(row, scope),
      sort_order: row.sort_order,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  getScoped(id: string, scope: DocScope): CollectionApi | undefined {
    const row = this.getScopedRow(id, scope);
    return row ? this.toApi(row, scope) : undefined;
  }

  /**
   * 列表（**按 scope 过滤**）。
   *
   * 学生只会看到 `published` 且（`public` 或属于其课程）的目录 —— 规则来自 `docScopeSql`，
   * 与文档**同一份实现**（这是"不给新接口开后门"的关键）。
   */
  listScoped(scope: DocScope, opts: { limit?: number; offset?: number } = {}): CollectionApi[] {
    const frag = docScopeSql(scope);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const rows = this.db.all<CollectionRow>(
      `SELECT * FROM collections WHERE ${frag.sql} ORDER BY sort_order ASC, updated_at DESC LIMIT ? OFFSET ?`,
      ...frag.params,
      limit,
      offset,
    );
    return rows.map((r) => this.toApi(r, scope));
  }

  /** 更新（**只允许改白名单字段**；越权字段由路由先判 `canManageCollection`）。 */
  update(id: string, patch: {
    name?: string;
    description?: string;
    visibility?: 'private' | 'course' | 'public';
    reviewStatus?: 'draft' | 'reviewed' | 'published';
    sortOrder?: number;
  }): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.description !== undefined) {
      sets.push('description = ?');
      params.push(patch.description);
    }
    if (patch.visibility !== undefined) {
      sets.push('visibility = ?');
      params.push(patch.visibility);
    }
    if (patch.reviewStatus !== undefined) {
      sets.push('review_status = ?');
      params.push(patch.reviewStatus);
    }
    if (patch.sortOrder !== undefined) {
      sets.push('sort_order = ?');
      params.push(patch.sortOrder);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(Date.now(), id);
    this.db.run(`UPDATE collections SET ${sets.join(', ')} WHERE id = ?`, ...params);
  }

  /** 删除目录。**不删视频**（视频回到"未分类"）—— 由路由决定是否允许。 */
  delete(id: string): void {
    this.db.run('UPDATE documents SET collection_id = NULL WHERE collection_id = ?', id);
    this.db.run('DELETE FROM collections WHERE id = ?', id);
  }

  /** 目录下的视频（**按 scope 过滤** —— 学生看不到未发布的视频）。 */
  listVideosScoped(collectionId: string, scope: DocScope, kind = 'video'): DocumentRow[] {
    const frag = docScopeSql(scope);
    return this.db.all<DocumentRow>(
      `SELECT * FROM documents WHERE collection_id = ? AND kind = ? AND ${frag.sql} ORDER BY created_at DESC`,
      collectionId,
      kind,
      ...frag.params,
    );
  }
}
