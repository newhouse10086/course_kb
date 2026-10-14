/**
 * 认证与授权的公共类型（`docs/RBAC.md` §1 / §4）。
 */

/** RBAC §1 的角色（`user_roles.role` 的封闭集合）。 */
export const ROLES = ['admin', 'teacher', 'student'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(v: string): v is Role {
  return (ROLES as readonly string[]).includes(v);
}

/** 请求上下文里的"当前用户"（**不含密码哈希**，能安全进日志/响应）。 */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  roles: Role[];
  /** 以 teacher 身份加入的课程 */
  teacherCourseIds: string[];
  /** 以 student 身份加入的课程 */
  studentCourseIds: string[];
  status: 'active' | 'disabled';
}

/** 用户是否拥有某角色。 */
export function hasRole(user: AuthUser | null, role: Role): boolean {
  return Boolean(user?.roles.includes(role));
}

export function isAdmin(user: AuthUser | null): boolean {
  return hasRole(user, 'admin');
}

/** RBAC §5：任务的并发配额（学生 1 / 教师 2 / 管理员不限）。 */
export function taskQuota(user: AuthUser | null): number {
  if (!user) return 0;
  if (hasRole(user, 'admin')) return Number.POSITIVE_INFINITY;
  if (hasRole(user, 'teacher')) return 2;
  return 1;
}

/** RBAC §5：任务优先级（**数字越小越先**；0 = 教师/系统，1 = 学生）。 */
export function taskPriority(user: AuthUser | null): number {
  if (!user) return 0; // 系统任务（如启动恢复）最高
  if (hasRole(user, 'admin') || hasRole(user, 'teacher')) return 0;
  return 1;
}

/** 动作（RBAC §4 的判定入口收这种字符串，路由不许自己写 if）。 */
export type Action =
  | 'read'
  | 'upload'
  | 'extract'
  | 'review'
  | 'publish'
  | 'manage_users'
  | 'manage_courses'
  | 'chat'
  | 'note'
  | 'audit_read';

/** 资源描述（路由把领域对象投影成这个朴素结构，权限层不认识 repo）。 */
export type Resource =
  | {
      kind: 'document';
      ownerId: string | null;
      visibility: string;
      reviewStatus: string;
      courseId: string | null;
    }
  | { kind: 'course'; ownerId: string | null; courseId: string }
  | { kind: 'user'; userId: string }
  | { kind: 'global' };

export type DecisionCode = 'E_UNAUTHENTICATED' | 'E_ACCOUNT_DISABLED' | 'E_FORBIDDEN' | 'E_QUOTA';

export interface Decision {
  ok: boolean;
  reason?: string;
  code?: DecisionCode;
  /** 建议的 HTTP 状态码：401 / 403 / 429 */
  status?: number;
}
