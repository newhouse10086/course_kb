/**
 * 检索层的可见性范围（`docs/RBAC.md` §6：**隔离必须在 SQL 层**）。
 *
 * ## 为什么必须有这个文件
 * 检索层是**新增的读取路径**。如果它只调 `repo.getDocumentRow()`（**绕过可见性**的
 * 系统内部接口），就等于开了一个"通过检索把私有文档内容喂给别的用户"的后门。
 * 所以本模块做两件事，且**只有一处实现**：
 * 1. `scopeForUser(userId)` —— 把 `userId` 解析成 `DocScope`（查角色与课程成员）
 * 2. `visibleDocIds(repo, scope)` —— 该 scope 能看到哪些 `doc_id`（**SQL 层过滤**）
 *
 * ⚠️ `docs/RBAC.md` §6 的原话是"不能只在路由层"——检索层等价于第二个路由层，
 * 因此同样必须走 `docScopeSql()`，**不许"先取回来再过滤"**
 * （那会把不可见文档的内容先读进内存，且一旦忘记过滤就静默泄露）。
 */

import type { Repo } from '../store/repo.ts';
import { docScopeSql } from '../store/scope.ts';
import type { DocScope } from '../store/scope.ts';

/** 匿名/未登录：只能看 `public` + `published`（与 `docScopeSql` 的 public 分支一致）。 */
export function scopeForUser(repo: Repo, userId: string | null | undefined): DocScope {
  if (!userId) {
    return { isAdmin: false, userId: null, teacherCourseIds: [], studentCourseIds: [] };
  }
  const roles = repo.rbac.rolesOf(userId);
  const courses = repo.rbac.coursesOf(userId);
  return {
    isAdmin: roles.includes('admin'),
    userId,
    teacherCourseIds: courses.teacher,
    studentCourseIds: courses.student,
  };
}

/**
 * 该 scope 可见的 `doc_id` 集合 —— **SQL 层过滤**（不是取回来再过滤）。
 *
 * `docId` 给定时返回单元素数组或**空数组**（不可见 → 空，调用方据此返回空结果，
 * 而不是"文档不存在"的错误 —— 不泄露存在性，与路由 404 策略一致）。
 */
export function visibleDocIds(
  repo: Repo,
  scope: DocScope,
  docId?: string | null,
): { ids: string[]; sql: string; params: unknown[] } {
  const frag = docScopeSql(scope);
  if (docId) {
    const row = repo.getDocumentScopedRow(docId, scope);
    return { ids: row ? [row.id] : [], sql: frag.sql, params: frag.params };
  }
  const rows = repo.db.all<{ id: string }>(
    `SELECT id FROM documents WHERE ${frag.sql}`,
    ...frag.params,
  );
  return { ids: rows.map((r) => r.id), sql: frag.sql, params: frag.params };
}

/** 该 scope 是否能看到某文档（**纯判定**，用于已拿到 doc_id 的场合）。 */
export function canSeeDoc(repo: Repo, scope: DocScope, docId: string): boolean {
  return repo.getDocumentScopedRow(docId, scope) !== undefined;
}
