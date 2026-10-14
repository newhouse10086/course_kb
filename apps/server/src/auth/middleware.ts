/**
 * 认证中间件（`docs/RBAC.md` §4 第 1 步 + §7）。
 *
 * ## 设计要点
 * 1. **一个全局 `onRequest` 钩子**解析会话并挂 `req.user`（可空）
 * 2. **一个全局 401 闸门**：不在白名单的 `/api/v1/**` 一律要求登录 ——
 *    这样"新加的路由忘了鉴权"不可能发生（默认拒绝，而不是默认放行）。
 *    类比例子：契约里"能力不可用要如实降级"是同一种思路 —— **默认安全**。
 * 3. 更细的授权（owner / 课程成员 / draft vs published）走 `can()`，
 *    由**路由**在拿到资源后调用（权限层不认识 repo）。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ServerConfig } from '../config.ts';
import { ApiError } from '../store/errors.ts';
import type { Repo } from '../store/repo.ts';
import type { DocScope } from '../store/scope.ts';
import { hashToken, readCookie } from './session.ts';
import type { AuthUser, Resource, Role } from './types.ts';
import { isRole } from './types.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** 当前用户；`null` = 未登录（白名单路由允许为 null） */
    user: AuthUser | null;
  }
}

/**
 * 免鉴权路径（**只有这些**）。
 * - `/health`、`/capabilities`、`/schema`：UI 引导页要能读（capabilities 里带 `auth` 段告诉前端要不要登录页）
 * - `/auth/login`：登录本身
 * ⚠️ `/auth/logout`、`/auth/me`、`/auth/password` **都要登录**。
 */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/api/v1/health',
  '/api/v1/capabilities',
  '/api/v1/schema',
  '/api/v1/auth/login',
]);

export function isPublicPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return PUBLIC_PATHS.has(path);
}

/** 由会话 cookie 解析当前用户（`null` = 无会话/会话过期/账号被删）。 */
export function resolveUserFromCookie(repo: Repo, cookieHeader: string | undefined): AuthUser | null {
  const token = readCookie(cookieHeader);
  if (!token) return null;
  const session = repo.rbac.findSession(hashToken(token));
  if (!session) return null;
  if (session.expires_at <= Date.now()) {
    repo.rbac.deleteSession(session.id); // 顺手清理过期会话
    return null;
  }
  const row = repo.rbac.getUserRow(session.user_id);
  if (!row) {
    repo.rbac.deleteSession(session.id);
    return null;
  }
  return toAuthUser(repo, row.id, row.username, row.display_name, row.status);
}

export function toAuthUser(
  repo: Repo,
  id: string,
  username: string,
  displayName: string,
  status: string,
): AuthUser {
  const roles = repo.rbac.rolesOf(id).filter(isRole) as Role[];
  const courses = repo.rbac.coursesOf(id);
  return {
    id,
    username,
    displayName,
    roles,
    teacherCourseIds: courses.teacher,
    studentCourseIds: courses.student,
    status: status === 'disabled' ? 'disabled' : 'active',
  };
}

/** 取当前用户，没有就 401（路由里第一行调用）。 */
export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) {
    throw new ApiError('E_UNAUTHENTICATED', '未登录：请先 POST /api/v1/auth/login', {
      hint: '带着登录返回的 ckb_session cookie 再请求',
    });
  }
  return req.user;
}

/** 当前用户 → 文档可见性范围（RBAC §2/§4 的 SQL 依据）。 */
export function scopeFor(user: AuthUser | null): DocScope {
  if (!user) {
    // 未登录：什么都看不到（除非文档 public+published —— 但匿名请求在 401 闸门就被拦了）
    return { isAdmin: false, userId: null, teacherCourseIds: [], studentCourseIds: [] };
  }
  return {
    isAdmin: user.roles.includes('admin'),
    userId: user.id,
    teacherCourseIds: user.teacherCourseIds,
    studentCourseIds: user.studentCourseIds,
  };
}

/** 文档行 → 权限层认识的资源描述（路由不要自己拼，避免字段漏掉）。 */
export function documentResource(row: {
  owner_id?: string | null;
  visibility?: string;
  review_status?: string;
  course_id?: string | null;
}): Resource {
  return {
    kind: 'document',
    ownerId: row.owner_id ?? null,
    visibility: row.visibility ?? 'private',
    reviewStatus: row.review_status ?? 'draft',
    courseId: row.course_id ?? null,
  };
}

/** 全局资源（上传/登录后允许的动作等）。 */
export const GLOBAL: Resource = { kind: 'global' };

export interface AuthInstallDeps {
  repo: Repo;
  cfg: ServerConfig;
}

/**
 * 安装鉴权：全局钩子。
 *
 * ⚠️ 用 `onRequest`（最早）而不是 `preHandler`：**未登录在读完 body/文件之前就该被拒**，
 * 否则上传接口会先把几十 MB 落盘再返回 401（浪费 + 可被用来打满磁盘）。
 */
export function installAuth(app: FastifyInstance, deps: AuthInstallDeps): void {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
    req.user = resolveUserFromCookie(deps.repo, req.headers.cookie);
    if (isPublicPath(req.url)) return;
    const path = req.url.split('?')[0] ?? req.url;
    if (!path.startsWith('/api/')) return; // 非 API（静态资源等）不在本层
    if (!req.user) {
      throw new ApiError('E_UNAUTHENTICATED', '未登录：该接口需要登录', {
        detail: `${req.method} ${path}`,
        hint: 'POST /api/v1/auth/login（返回的 ckb_session 是 httpOnly cookie，浏览器会自动带上）',
      });
    }
    if (req.user.status === 'disabled') {
      throw new ApiError('E_ACCOUNT_DISABLED', '账号已被禁用，请联系管理员', { detail: path });
    }
  });
}
