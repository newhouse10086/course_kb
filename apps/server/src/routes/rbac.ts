/**
 * RBAC 相关路由（`docs/RBAC.md` §8）。
 *
 * | 方法 | 路径 | 权限 |
 * |---|---|---|
 * | GET/POST | `/api/v1/users` | admin |
 * | GET/POST | `/api/v1/courses` | teacher/admin |
 * | GET/POST/DELETE | `/api/v1/courses/:id/members` | teacher/admin（课程 owner 或任课） |
 * | POST | `/api/v1/documents/:id/review` | teacher（owner / 课程教师） |
 * | GET/POST/DELETE | `/api/v1/notes` | **本人 only**（repo 签名强制 userId） |
 * | GET | `/api/v1/audit` | admin/teacher |
 *
 * ⚠️ 所有授权判定都走 `can()`（**单一入口**），本文件不写第二套 `if (role === ...)`。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AppDeps } from '../app-deps.ts';
import { ApiError, notFound } from '../store/errors.ts';
import { passwordProblem, hashPassword } from '../auth/password.ts';
import { can, reasonOf } from '../auth/permissions.ts';
import { requireUser, scopeFor, GLOBAL } from '../auth/middleware.ts';
import { isRole, type Action, type Resource } from '../auth/types.ts';
import { intParam, pageParams, sendError, strParam } from './util.ts';

/** 判定 → 抛 403（`reason` 是给人看的，但**不含资源细节**）。 */
function ensure(req: FastifyRequest, action: Action, resource: Resource, deps: AppDeps): void {
  const d = can(req.user, action, resource);
  if (!d.ok) {
    if (d.code === 'E_UNAUTHENTICATED') {
      throw new ApiError('E_UNAUTHENTICATED', reasonOf(d), { hint: '先登录' });
    }
    if (d.code === 'E_ACCOUNT_DISABLED') throw new ApiError('E_ACCOUNT_DISABLED', reasonOf(d));
    void deps;
    throw new ApiError('E_FORBIDDEN', reasonOf(d), { detail: `action=${action}` });
  }
}

export function registerRbacRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { repo } = deps;

  // ═══════════════════════════════════════════════════════════════════
  // users（admin only）
  // ═══════════════════════════════════════════════════════════════════
  app.get('/api/v1/users', async (req, reply) => {
    try {
      ensure(req, 'manage_users', GLOBAL, deps);
      const q = (req.query ?? {}) as Record<string, unknown>;
      const { offset, limit } = pageParams(q);
      const out = repo.rbac.listUsers({ offset, limit, ...(strParam(q.q) ? { q: strParam(q.q) as string } : {}) });
      return reply.send({ total: out.total, users: out.users, offset, limit });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/v1/users', async (req, reply) => {
    try {
      ensure(req, 'manage_users', GLOBAL, deps);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const roles = Array.isArray(body.roles) ? body.roles.filter((r) => typeof r === 'string') : [];
      if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
        throw new ApiError('E_FORMAT', '用户名需 3–32 位，只含字母/数字/._-');
      }
      const problem = passwordProblem(password);
      if (problem) throw new ApiError('E_FORMAT', problem);
      const bad = roles.filter((r) => !isRole(r));
      if (bad.length > 0) throw new ApiError('E_FORMAT', `非法角色：${bad.join(',')}`, { detail: '允许 admin|teacher|student' });
      if (roles.length === 0) throw new ApiError('E_FORMAT', '至少指定一个角色');
      if (repo.rbac.getUserRowByName(username)) {
        throw new ApiError('E_CONFLICT', `用户名已存在：${username}`);
      }
      const id = repo.rbac.createUser({
        username,
        displayName: typeof body.display_name === 'string' ? body.display_name : '',
        passwordHash: await hashPassword(password),
        roles,
      });
      repo.rbac.audit({ userId: req.user?.id ?? null, action: 'user_create', target: id, detail: { username, roles } });
      return reply.code(201).send({ user: repo.rbac.getPublicUser(id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** 改角色 / 启停账号（admin）。 */
  app.patch('/api/v1/users/:id', async (req, reply) => {
    try {
      ensure(req, 'manage_users', GLOBAL, deps);
      const { id } = req.params as { id: string };
      const row = repo.rbac.getUserRow(id);
      if (!row) throw notFound('用户', id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (Array.isArray(body.roles)) {
        const roles = body.roles.filter((r) => typeof r === 'string');
        const bad = roles.filter((r) => !isRole(r));
        if (bad.length > 0) throw new ApiError('E_FORMAT', `非法角色：${bad.join(',')}`);
        if (roles.length === 0) throw new ApiError('E_FORMAT', '角色不能为空');
        repo.rbac.setRoles(id, roles as string[]);
        repo.rbac.audit({ userId: req.user?.id ?? null, action: 'user_roles', target: id, detail: { roles } });
      }
      if (body.status === 'active' || body.status === 'disabled') {
        repo.rbac.setUserStatus(id, body.status);
        if (body.status === 'disabled') repo.rbac.deleteUserSessions(id); // 禁用即踢下线
        repo.rbac.audit({ userId: req.user?.id ?? null, action: 'user_status', target: id, detail: { status: body.status } });
      }
      if (typeof body.password === 'string' && body.password) {
        const problem = passwordProblem(body.password);
        if (problem) throw new ApiError('E_FORMAT', problem);
        repo.rbac.setPassword(id, await hashPassword(body.password));
        repo.rbac.deleteUserSessions(id);
        repo.rbac.audit({ userId: req.user?.id ?? null, action: 'user_password_reset', target: id });
      }
      return reply.send({ user: repo.rbac.getPublicUser(id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // courses / members
  // ═══════════════════════════════════════════════════════════════════
  app.get('/api/v1/courses', async (req, reply) => {
    try {
      ensure(req, 'read', GLOBAL, deps);
      const user = requireUser(req);
      const q = (req.query ?? {}) as Record<string, unknown>;
      const { offset, limit } = pageParams(q);
      const out = repo.rbac.listCoursesFor(user.id, { isAdmin: user.roles.includes('admin'), offset, limit });
      return reply.send({
        total: out.total,
        courses: out.courses.map((c) => ({
          ...c,
          my_role: repo.rbac.memberRole(c.id, user.id) ?? (c.owner_id === user.id ? 'teacher' : null),
        })),
        offset,
        limit,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/v1/courses', async (req, reply) => {
    try {
      ensure(req, 'manage_courses', GLOBAL, deps);
      const user = requireUser(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) throw new ApiError('E_FORMAT', '缺少课程名 name');
      const id = repo.rbac.createCourse({
        name,
        term: typeof body.term === 'string' ? body.term : '',
        ownerId: user.id,
      });
      repo.rbac.audit({ userId: user.id, action: 'course_create', target: id, detail: { name } });
      return reply.code(201).send({ course: repo.rbac.getCourse(id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/v1/courses/:id/members', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const course = repo.rbac.getCourse(id);
      if (!course) throw notFound('课程', id);
      ensure(req, 'read', { kind: 'course', ownerId: course.owner_id, courseId: id }, deps);
      return reply.send({ course_id: id, members: repo.rbac.membersOf(id), total: repo.rbac.membersOf(id).length });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/v1/courses/:id/members', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const course = repo.rbac.getCourse(id);
      if (!course) throw notFound('课程', id);
      ensure(req, 'manage_courses', { kind: 'course', ownerId: course.owner_id, courseId: id }, deps);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const role = typeof body.role === 'string' ? body.role : '';
      if (role !== 'teacher' && role !== 'student') {
        throw new ApiError('E_FORMAT', 'role 必须是 teacher 或 student');
      }
      const target = repo.rbac.getUserRowByName(username);
      if (!target) throw notFound('用户', username);
      repo.rbac.addMember(id, target.id, role);
      repo.rbac.audit({ userId: req.user?.id ?? null, action: 'member_add', target: id, detail: { username, role } });
      return reply.code(201).send({ course_id: id, members: repo.rbac.membersOf(id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/v1/courses/:id/members/:userId', async (req, reply) => {
    try {
      const { id, userId } = req.params as { id: string; userId: string };
      const course = repo.rbac.getCourse(id);
      if (!course) throw notFound('课程', id);
      ensure(req, 'manage_courses', { kind: 'course', ownerId: course.owner_id, courseId: id }, deps);
      const removed = repo.rbac.removeMember(id, userId);
      repo.rbac.audit({ userId: req.user?.id ?? null, action: 'member_remove', target: id, detail: { userId } });
      return reply.send({ removed, course_id: id, members: repo.rbac.membersOf(id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // notes（★ 全部走 repo 的 userId 强制签名）
  // ═══════════════════════════════════════════════════════════════════
  app.get('/api/v1/notes', async (req, reply) => {
    try {
      const user = requireUser(req);
      const q = (req.query ?? {}) as Record<string, unknown>;
      const { offset, limit } = pageParams(q, 100);
      // ★ repo 签名强制 userId → 不可能查到别人的
      const out = repo.rbac.listNotes(user.id, {
        offset,
        limit,
        ...(strParam(q.doc_id) ? { docId: strParam(q.doc_id) as string } : {}),
        ...(strParam(q.card_id) ? { cardId: strParam(q.card_id) as string } : {}),
      });
      return reply.send({ total: out.total, notes: out.notes, offset, limit });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/v1/notes', async (req, reply) => {
    try {
      const user = requireUser(req);
      ensure(req, 'note', { kind: 'note', ownerId: user.id }, deps);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = typeof body.body === 'string' ? body.body.trim() : '';
      if (!text) throw new ApiError('E_FORMAT', '笔记内容 body 不能为空');
      const id = repo.rbac.createNote(user.id, {
        body: text,
        ...(strParam(body.card_id) ? { cardId: strParam(body.card_id) as string } : {}),
        ...(strParam(body.unit_id) ? { unitId: strParam(body.unit_id) as string } : {}),
        ...(strParam(body.doc_id) ? { docId: strParam(body.doc_id) as string } : {}),
      });
      repo.rbac.audit({ userId: user.id, action: 'note_create', target: id });
      return reply.code(201).send({ note: repo.rbac.getNote(user.id, id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** 读单条：**别人的笔记 → 404**（不泄露存在性；也是 RBAC §6 的负例验收点）。 */
  app.get('/api/v1/notes/:id', async (req, reply) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as { id: string };
      const note = repo.rbac.getNote(user.id, id);
      if (!note) throw notFound('笔记', id);
      return reply.send({ note });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/v1/notes/:id', async (req, reply) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as { id: string };
      const ok = repo.rbac.deleteNote(user.id, id);
      if (!ok) throw notFound('笔记', id);
      repo.rbac.audit({ userId: user.id, action: 'note_delete', target: id });
      return reply.send({ deleted: true, id });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // conversations（同样按 user 隔离；供 T-AGENT 的聊天会话落库）
  app.get('/api/v1/conversations', async (req, reply) => {
    try {
      const user = requireUser(req);
      const { offset, limit } = pageParams((req.query ?? {}) as Record<string, unknown>, 50);
      const out = repo.rbac.listConversations(user.id, { offset, limit });
      return reply.send({ total: out.total, conversations: out.conversations, offset, limit });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/v1/conversations', async (req, reply) => {
    try {
      const user = requireUser(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = repo.rbac.createConversation(user.id, {
        ...(strParam(body.doc_id) ? { docId: strParam(body.doc_id) as string } : {}),
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
      });
      return reply.code(201).send({ conversation: repo.rbac.getConversation(user.id, id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/v1/conversations/:id', async (req, reply) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as { id: string };
      const conv = repo.rbac.getConversation(user.id, id);
      if (!conv) throw notFound('会话', id);
      return reply.send({ conversation: conv });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // audit（admin/teacher）
  // ═══════════════════════════════════════════════════════════════════
  app.get('/api/v1/audit', async (req, reply) => {
    try {
      ensure(req, 'audit_read', GLOBAL, deps);
      const q = (req.query ?? {}) as Record<string, unknown>;
      const { offset, limit } = pageParams(q, 100);
      const out = repo.rbac.listAudit({
        offset,
        limit,
        ...(strParam(q.user_id) ? { userId: strParam(q.user_id) as string } : {}),
        ...(strParam(q.action) ? { action: strParam(q.action) as string } : {}),
      });
      return reply.send({
        total: out.total,
        entries: out.entries.map((e) => ({ ...e, detail: JSON.parse(e.detail_json || '{}') as unknown })),
        offset,
        limit,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** 诊断：当前用户实际可见的文档数（UI"我能看到什么"用；也便于负例测试断言）。 */
  app.get('/api/v1/auth/visible-documents', async (req, reply) => {
    try {
      const user = requireUser(req);
      const q = (req.query ?? {}) as Record<string, unknown>;
      const { offset, limit } = pageParams(q);
      const out = repo.listDocumentsScoped(scopeFor(user), { offset, limit });
      return reply.send({
        total: out.total,
        documents: out.documents.map((d) => ({
          id: d.id,
          title: d.title,
          review_status: d.review_status,
          visibility: d.visibility,
          owner_id: d.owner_id,
        })),
        scope: {
          is_admin: user.roles.includes('admin'),
          teacher_courses: user.teacherCourseIds.length,
          student_courses: user.studentCourseIds.length,
        },
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** 未使用的占位避免 lint 抱怨（intParam 在上面的 pageParams 里用到） */
  void intParam;
}
