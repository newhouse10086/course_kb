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
import {
  buildTitleMessages,
  cleanGeneratedTitle,
  pickNamingInput,
  titleFromModelData,
  TITLE_GEN_MAX_TOKENS,
  TITLE_MAX_CHARS,
  TITLE_SCHEMA,
} from './conversation-title.ts';

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
        throw new ApiError('E_BADREQUEST', '用户名需 3–32 位，只含字母/数字/._-');
      }
      const problem = passwordProblem(password);
      if (problem) throw new ApiError('E_BADREQUEST', problem);
      const bad = roles.filter((r) => !isRole(r));
      if (bad.length > 0) throw new ApiError('E_BADREQUEST', `非法角色：${bad.join(',')}`, { detail: '允许 admin|teacher|student' });
      if (roles.length === 0) throw new ApiError('E_BADREQUEST', '至少指定一个角色');
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
        if (bad.length > 0) throw new ApiError('E_BADREQUEST', `非法角色：${bad.join(',')}`);
        if (roles.length === 0) throw new ApiError('E_BADREQUEST', '角色不能为空');
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
        if (problem) throw new ApiError('E_BADREQUEST', problem);
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
      if (!name) throw new ApiError('E_BADREQUEST', '缺少课程名 name');
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
        throw new ApiError('E_BADREQUEST', 'role 必须是 teacher 或 student');
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
      if (!text) throw new ApiError('E_BADREQUEST', '笔记内容 body 不能为空');
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

  /**
   * ★ **重命名**（契约 `docs/SESSION_NAMING.md` §3.1）。
   *
   * ```
   * ① 归属 fail-closed：条件写在 SQL 的 `user_id = ?` 里；**不可见 → 404（不泄露存在性）**
   *    （与 reparse 端点同策略：别人的会话一律 404，不是 403）
   * ② trim 后 1..80；全空白 / 超长 → **400**（**不静默截断**）
   * ③ 设定后 `title_source='user'` ⟹ ★ **AI 永远不许再覆盖**（铁律）
   * ④ 幂等：重复设同一 title → 200
   * ```
   */
  app.patch('/api/v1/conversations/:id', async (req, reply) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.title !== 'string') {
        throw new ApiError('E_BADREQUEST', 'title 必须是字符串', { hint: 'Body: { "title": "…" }' });
      }
      const title = body.title.trim();
      if (title === '') {
        throw new ApiError('E_BADREQUEST', '会话名不能为空白', { hint: '至少 1 个非空白字符' });
      }
      if (Array.from(title).length > TITLE_MAX_CHARS) {
        throw new ApiError('E_BADREQUEST', `会话名过长（上限 ${TITLE_MAX_CHARS} 字）`, {
          detail: `实际 ${Array.from(title).length}`,
          hint: '服务端**不静默截断**：请自行缩短',
        });
      }
      const updated = repo.rbac.setConversationTitle(user.id, id, title);
      if (!updated) throw notFound('会话', id); // ★ 不存在 / 不属于你 → **一律 404**
      return reply.send({ conversation: updated });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * ★★ **AI 生成会话名**（契约 §3.2）。
   *
   * ```
   * ① title_source==='user' → **409 E_TITLE_USER_SET**（★ 不静默跳过 ——
   *    用户点了"生成"却什么都没发生会被当成 bug）
   * ② 输入 = 首条**用户提问** + 首条助手回答（各截断 ~500 字符）；
   *    没有任何消息 → **400（不编名字）**
   * ③ 清洗：取首行 · 去首尾引号 · 去结尾标点 · 截 20 字 · **空 → 保留原名 + 如实警告**
   * ④ `max_tokens` 极小（32）—— 命名成本必须极低
   * ⑤ **失败 → 保留原名**（不阻塞聊天、不写占位、不假装成功）
   * ⑥ 走同一个 `LLM_QUEUE`（并发=1）⟹ 长抽取在跑时会排队；本接口**同步**返回（命名很快）
   * ⑦ ★ **输入与 UI 同源**：历史来自注入的 `sessionHistory`（= `entriesToHistory`），
   *    不另写一套读法（Lead 硬要求："只许一份实现"）
   * ```
   */
  app.post('/api/v1/conversations/:id/title/generate', async (req, reply) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as { id: string };
      const conv = repo.rbac.getConversation(user.id, id);
      if (!conv) throw notFound('会话', id); // ★ 不可见 → 404

      // ① ★ 铁律：用户手动命名的会话，AI **永远不许覆盖**（409，不静默）
      if (conv.title_source === 'user') {
        throw new ApiError('E_TITLE_USER_SET', '该会话名由你手动设定，未被 AI 覆盖', {
          hint: '若要改名请用 PATCH /api/v1/conversations/:id（或先改成别的名字）',
          detail: `title=${conv.title} title_source=${conv.title_source}`,
        });
      }

      // ② 取**同源**历史
      if (!deps.sessionHistory) {
        throw new ApiError('E_INTERNAL', '会话历史不可用（sessionHistory 未接入）', {
          hint: '命名需要与 UI 同源的历史；未接入时**不编名字**',
        });
      }
      const history = deps.sessionHistory(id);
      const input = history ? pickNamingInput(history.messages) : null;
      if (!input) {
        throw new ApiError('E_BADREQUEST', '这个会话还没有消息，先聊一句再生成名字', {
          hint: '命名输入 = 首条用户提问 + 首条助手回答',
        });
      }

      // ③ 调模型（极小 max_tokens；失败 → 保留原名，如实上报）
      let rawTitle = '';
      let usedProvider = '';
      const warnings: { code: string; msg: string; detail?: Record<string, unknown> }[] = [];
      try {
        const res = await deps.providers!.completeJson<Record<string, unknown>>({
          messages: buildTitleMessages(input),
          schema: TITLE_SCHEMA,
          maxTokens: TITLE_GEN_MAX_TOKENS,
          temperature: 0,
          // ★ **交互车道**：用户在等这个名字 —— 长抽取在跑时**插到它前面**（Lead 裁定）
          priority: 'interactive',
        });
        rawTitle = titleFromModelData(res.data);
        usedProvider = res.usedProvider ?? '';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push({
          code: 'W_TITLE_GEN_FAILED',
          msg: `命名失败 → **保留原名**（未写占位、未假装成功）：${msg}`,
          detail: { reason: msg.slice(0, 300) },
        });
        return reply.send({ conversation: conv, generated: false, warnings });
      }

      // ④ 清洗（空 → 保留原名 + 如实警告）
      const cleaned = cleanGeneratedTitle(rawTitle);
      warnings.push(...cleaned.warnings);
      if (cleaned.title === '') {
        return reply.send({ conversation: conv, generated: false, warnings });
      }

      // ⑤ 写入（SQL 层原子守卫：若这期间用户手动改了名 → 不覆盖）
      const out = repo.rbac.setConversationTitleAi(user.id, id, cleaned.title);
      if (!out.applied) {
        throw new ApiError('E_TITLE_USER_SET', '该会话名由你手动设定，未被 AI 覆盖', {
          hint: '（在你点"生成"的同一瞬间被设为手动名 → 守卫拒绝覆盖）',
          detail: `title=${out.row?.title ?? conv.title}`,
        });
      }
      return reply.send({
        conversation: out.row,
        generated: true,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(usedProvider ? { used_provider: usedProvider } : {}),
      });
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
