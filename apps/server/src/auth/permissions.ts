/**
 * ★ **单一权限判定入口**（`docs/RBAC.md` §4）。
 *
 * 路由**只许调它**，不许自己写 `if (user.role === ...)` —— 否则同一个规则会在 N 处漂移。
 *
 * 判定顺序（**固定，不许改序**）：
 * ```text
 * 1. 无会话                 → 401 E_UNAUTHENTICATED
 * 2. 账号被禁用             → 403 E_ACCOUNT_DISABLED
 * 3. admin                 → 放行
 * 4. 资源 owner             → 放行（**"发布"除外** —— §4 明写）
 * 5. 课程成员               → 按 course_members.role 判
 * 6. visibility=public 且 review_status=published → 只读放行
 * 7. 否则                   → 403 E_FORBIDDEN
 * ```
 *
 * ⚠️ 判定返回里带 `reason` 是**给人看的**，但**不包含**资源细节（避免通过 403 文案探测他人数据）。
 * ⚠️ 可见性不通过时路由层统一给 **404**（不泄露"资源是否存在"）—— 见 `notFound` 用法。
 */

import type { Action, AuthUser, Decision, Resource } from './types.ts';
import { hasRole, isAdmin } from './types.ts';

/** 需要"教师及以上"的动作（RBAC §1 能力表）。 */
const TEACHER_ACTIONS: ReadonlySet<Action> = new Set(['upload', 'extract', 'review', 'publish', 'manage_courses', 'audit_read']);

function deny(code: Decision['code'], status: number, reason: string): Decision {
  return { ok: false, code, status, reason };
}

const ALLOW: Decision = { ok: true };

/**
 * 权限判定。**纯函数**（同样的输入永远同样的输出，可单测到穷尽）。
 *
 * @param user 当前用户；`null` = 无会话
 */
export function can(user: AuthUser | null, action: Action, resource: Resource): Decision {
  // ── 1. 无会话 ────────────────────────────────────────────────────
  if (!user) {
    return deny('E_UNAUTHENTICATED', 401, '未登录：请先 POST /api/v1/auth/login');
  }
  // ── 2. 账号禁用 ──────────────────────────────────────────────────
  if (user.status === 'disabled') {
    return deny('E_ACCOUNT_DISABLED', 403, '账号已被禁用，请联系管理员');
  }
  // ── 3. admin ────────────────────────────────────────────────────
  if (isAdmin(user)) return ALLOW;

  const teacherish = hasRole(user, 'teacher');

  // ── 全局资源（不针对具体文档）─────────────────────────────────────
  if (resource.kind === 'global') {
    if (action === 'manage_users') {
      return deny('E_FORBIDDEN', 403, '需要管理员权限');
    }
    if (TEACHER_ACTIONS.has(action)) {
      return teacherish ? ALLOW : deny('E_FORBIDDEN', 403, `该操作需要教师权限（${action}）`);
    }
    // chat / 其它：登录即可
    return ALLOW;
  }

  if (resource.kind === 'user') {
    // 只能读/改自己的用户资料；管理他人需 admin（已在第 3 步放过）
    if (resource.userId !== user.id) {
      return deny('E_FORBIDDEN', 403, '只能操作自己的账号');
    }
    return ALLOW;
  }

  if (resource.kind === 'note') {
    // 笔记/会话是**私有资源**：只有本人（admin 已在第 3 步放过 —— 但路由层不会把别人的 note 交给 admin 视图）
    if (resource.ownerId !== user.id) {
      return deny('E_FORBIDDEN', 403, '只能访问自己的笔记');
    }
    return ALLOW;
  }

  if (resource.kind === 'course') {
    const isOwner = Boolean(resource.ownerId && resource.ownerId === user.id);
    const memberRole = memberRoleOf(user, resource.courseId);
    if (action === 'manage_courses') return teacherish || isOwner || memberRole === 'teacher' ? ALLOW : deny('E_FORBIDDEN', 403, '需要教师权限');
    if (isOwner || memberRole) return ALLOW;
    return deny('E_FORBIDDEN', 403, '不是该课程成员');
  }

  // ── 文档资源 ────────────────────────────────────────────────────
  const doc = resource;
  const isOwner = Boolean(doc.ownerId && doc.ownerId === user.id);
  const memberRole = doc.courseId ? memberRoleOf(user, doc.courseId) : null;
  const published = doc.reviewStatus === 'published';

  // ── 4. owner（"发布"除外）────────────────────────────────────────
  if (isOwner && action !== 'publish') return ALLOW;
  // 发布：§4 说 owner "除发布外全权" → owner 身份本身**不够**，还要有教师角色。
  // 这是"教师上传自己的资料 → 审核 → 发布"的常规路径（该文档通常还没挂课程，
  // 所以不能只靠 course_members 判定）。
  if (isOwner && action === 'publish') {
    return teacherish
      ? ALLOW
      : deny('E_FORBIDDEN', 403, '发布需要教师权限（仅"本人上传"不足以发布给学生）');
  }

  // ── 5. 课程成员 ─────────────────────────────────────────────────
  if (memberRole === 'teacher') {
    // 任课教师对自己课程的文档：读/审核/发布/抽取全权
    return ALLOW;
  }
  if (memberRole === 'student') {
    // 学生：**只能读已发布**（§2 硬约束）
    if (action === 'read' && published) return ALLOW;
    return deny(
      'E_FORBIDDEN',
      403,
      published ? '学生只能读取已发布内容' : '该内容尚未发布（review_status=draft），学生不可见',
    );
  }

  // ── 6. public + published → 只读 ─────────────────────────────────
  if (action === 'read' && published && doc.visibility === 'public') return ALLOW;

  // 非读动作到这里一律拒绝（上传/抽取/审核/发布都不是"任何登录用户"能做的）
  if (TEACHER_ACTIONS.has(action)) {
    return deny('E_FORBIDDEN', 403, `该操作需要教师权限（${action}）`);
  }

  // ── 7. 否则 ─────────────────────────────────────────────────────
  return deny(
    'E_FORBIDDEN',
    403,
    published ? '无权访问该资源' : '该内容尚未发布（review_status=draft），仅教师可见',
  );
}

/** 便捷：判定失败时把 Decision 变成可读原因（路由给 403 用）。 */
export function reasonOf(d: Decision): string {
  return d.reason ?? '无权访问该资源';
}

function memberRoleOf(user: AuthUser, courseId: string): 'teacher' | 'student' | null {
  if (user.teacherCourseIds.includes(courseId)) return 'teacher';
  if (user.studentCourseIds.includes(courseId)) return 'student';
  return null;
}

/**
 * 响应/诊断用的"为何可见"说明（**只描述规则，不泄露他人数据**）。
 * 供 `/auth/me` 与调试使用。
 */
export function explain(user: AuthUser | null): string {
  if (!user) return '未登录';
  if (isAdmin(user)) return 'admin：可见全部';
  const parts: string[] = [];
  if (hasRole(user, 'teacher')) parts.push('teacher：可见本人上传 + 任课课程的（含 draft）');
  if (hasRole(user, 'student')) parts.push('student：仅可见已发布（public/course 内）');
  return parts.join(' | ') || '无角色：仅可见 public+published';
}
