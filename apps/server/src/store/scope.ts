/**
 * 文档可见性范围（`docs/RBAC.md` §2 / §4 / §6）。
 *
 * ## 为什么单独一个模块
 * RBAC §6 要求「**隔离必须在 SQL 层**，不能只在路由层」。
 * 所以可见性规则必须**只有一处实现**，同时被：
 * 1. `docScopeSql()` —— 拼进 repo 的 SQL（列表/单条读取）
 * 2. `docVisible()`  —— 纯函数，供单测与"已经拿到行"时的判定
 * 二者**必须一致** —— `test/rbac_scope.test.ts` 用一张矩阵断言"SQL 结果 == 纯函数结果"，
 * 防止有人只改了一边（那会变成静默越权/静默丢数据）。
 *
 * ## 规则（RBAC §4 的顺序 + §2 的草稿约束）
 * ```text
 * 1. admin                                  → 可见
 * 2. owner（本人上传的，任何审核状态）        → 可见
 * 3. 本人是"教师"身份的课程成员                → 可见（含 draft：教师要能审）
 * 4. 本人是"学生"身份的课程成员 且 published   → 可见
 * 5. visibility=public 且 published          → 可见
 * 6. 否则                                     → 不可见（路由层给 404，不泄露是否存在）
 * ```
 * ⚠️ 第 4/5 条里的 `review_status='published'` 是**硬条件**，直接写在 SQL 里，
 *    不依赖调用方"记得加"——这正是 §2/§6 的要求。
 */

import type { DocumentRow } from './repo.ts';

export interface DocScope {
  isAdmin: boolean;
  userId: string | null;
  /** 本人以 **teacher** 身份加入的课程 id */
  teacherCourseIds: string[];
  /** 本人以 **student** 身份加入的课程 id */
  studentCourseIds: string[];
}

export function emptyScope(): DocScope {
  return { isAdmin: false, userId: null, teacherCourseIds: [], studentCourseIds: [] };
}

/** 纯函数版：这一行对该 scope 是否可见。 */
export function docVisible(scope: DocScope, row: Pick<DocumentRow, 'owner_id' | 'visibility' | 'review_status' | 'course_id'>): boolean {
  if (scope.isAdmin) return true;
  if (scope.userId && row.owner_id === scope.userId) return true;

  const published = row.review_status === 'published';
  const courseId = row.course_id ?? '';
  if (courseId && scope.teacherCourseIds.includes(courseId)) return true;
  if (published && courseId && scope.studentCourseIds.includes(courseId)) return true;
  if (published && row.visibility === 'public') return true;
  return false;
}

/**
 * SQL 版：返回可直接拼进 `WHERE` 的片段 + 参数。
 *
 * 注意占位符顺序：`?` 与返回的 `params` **一一对应**，调用方必须先拼本片段再拼自己的条件。
 * 空课程列表会**整条分支省略**（避免 `IN ()` 语法错误，也避免误放行）。
 */
export function docScopeSql(scope: DocScope): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];

  if (scope.isAdmin) {
    parts.push('1 = 1');
  } else {
    if (scope.userId) {
      parts.push('owner_id = ?');
      params.push(scope.userId);
    }
    if (scope.teacherCourseIds.length > 0) {
      parts.push(`course_id IN (${scope.teacherCourseIds.map(() => '?').join(',')})`);
      params.push(...scope.teacherCourseIds);
    }
    if (scope.studentCourseIds.length > 0) {
      // ★ students 分支**硬编码** published
      parts.push(`(course_id IN (${scope.studentCourseIds.map(() => '?').join(',')}) AND review_status = 'published')`);
      params.push(...scope.studentCourseIds);
    }
    // ★ public 分支同样硬编码 published
    parts.push("(visibility = 'public' AND review_status = 'published')");
    if (parts.length === 0) parts.push('0 = 1');
  }

  return { sql: `(${parts.join(' OR ')})`, params };
}

/** 便于路由/响应里如实告知"为什么看不到"。 */
export function scopeLabel(scope: DocScope): string {
  if (scope.isAdmin) return 'admin';
  if (scope.teacherCourseIds.length > 0) return 'teacher';
  if (scope.studentCourseIds.length > 0) return 'student';
  return 'user';
}
