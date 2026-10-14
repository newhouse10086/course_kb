/**
 * 认证路由（`docs/RBAC.md` §7）。
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | POST | `/api/v1/auth/login` | `{username,password}` → `Set-Cookie`（httpOnly） |
 * | POST | `/api/v1/auth/logout` | 清 cookie + 删会话行 |
 * | GET | `/api/v1/auth/me` | 当前用户 + 角色 + 课程 |
 * | POST | `/api/v1/auth/password` | 改自己的口令（要验旧口令，改后失效其它会话） |
 *
 * 安全要点（逐条落实）：
 * - 登录失败**统一文案**，不区分"用户不存在/口令错"（避免用户名枚举）
 * - **失败限流**（按 username+IP），超限 429 + `retry_after_s`
 * - 库里只存 **sha256(token)**；cookie 为 **httpOnly + SameSite=Lax**（生产加 Secure）
 * - 口令/令牌**不落日志**（`redactAuthText`）
 */

import type { FastifyInstance } from 'fastify';

import type { AppDeps } from '../app-deps.ts';
import { ApiError } from '../store/errors.ts';
import { hashPassword, passwordProblem, verifyPassword } from '../auth/password.ts';
import {
  buildClearCookie,
  buildSessionCookie,
  hashToken,
  LoginRateLimiter,
  newSessionToken,
  readCookie,
  redactAuthText,
  SESSION_COOKIE,
} from '../auth/session.ts';
import { requireUser, toAuthUser } from '../auth/middleware.ts';
import { explain } from '../auth/permissions.ts';

/** 登录失败统一文案（**不泄露是用户名还是口令错**）。 */
const LOGIN_FAILED = '用户名或口令不正确';

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { repo, cfg } = deps;
  const limiter = new LoginRateLimiter({
    maxFailures: cfg.auth.maxLoginFailures,
    windowMs: cfg.auth.loginWindowMs,
  });

  app.post('/api/v1/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const ip = req.ip ?? 'unknown';

    if (!username || !password) {
      throw new ApiError('E_NOFILE', '缺少 username 或 password', {
        detail: 'body 形如 {"username":"teacher1","password":"..."}',
      });
    }

    // ① 限流（先查，避免拿数据库/argon2 做"撞库加速器"）
    const gate = limiter.check(username, ip);
    if (!gate.allowed) {
      reply.header('retry-after', String(gate.retryAfterS));
      throw new ApiError('E_RATELIMIT', `登录失败次数过多，请 ${gate.retryAfterS} 秒后再试`, {
        detail: `failures=${gate.failures}`,
        hint: '本机工具同样限流：防的是撞库，不是防你',
      });
    }

    const row = repo.rbac.getUserRowByName(username);
    // ② 用户不存在也**照样跑一次哈希校验**（消除时序差异，避免用户名枚举）
    const hash = row?.password_hash ?? '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ok = await verifyPassword(hash, password);

    if (!row || !ok) {
      const f = limiter.fail(username, ip);
      if (f.failures >= cfg.auth.maxLoginFailures) reply.header('retry-after', String(f.retryAfterS || 1));
      // 日志里只记用户名与失败次数（**绝不记口令**）
      process.stderr.write(`[auth] 登录失败 user=${username} ip=${ip} failures=${f.failures}\n`);
      repo.rbac.audit({ userId: row?.id ?? null, action: 'login_failed', target: username, detail: { ip, failures: f.failures } });
      throw new ApiError('E_UNAUTHENTICATED', LOGIN_FAILED, { hint: '确认用户名与口令；连续失败会临时限流' });
    }

    if (row.status === 'disabled') {
      // 禁用账号：即便口令正确也拒绝，但**文案与"口令错"不同**（这是账号状态问题，不是凭据问题）
      repo.rbac.audit({ userId: row.id, action: 'login_disabled', target: username, detail: { ip } });
      throw new ApiError('E_ACCOUNT_DISABLED', '账号已被禁用，请联系管理员');
    }

    // ③ 建会话
    limiter.reset(username, ip);
    repo.rbac.purgeExpiredSessions();
    const token = newSessionToken();
    const ttlMs = cfg.auth.sessionTtlMs;
    repo.rbac.createSession({
      tokenHash: hashToken(token),
      userId: row.id,
      expiresAt: Date.now() + ttlMs,
      userAgent: req.headers['user-agent'] ?? '',
    });
    reply.header('set-cookie', buildSessionCookie(token, { ttlMs, secure: cfg.auth.cookieSecure }));
    repo.rbac.audit({ userId: row.id, action: 'login', target: username, detail: { ip } });

    const user = toAuthUser(repo, row.id, row.username, row.display_name, row.status);
    process.stderr.write(`[auth] 登录成功 user=${redactAuthText(username)} roles=${user.roles.join(',')}\n`);
    return reply.send({
      user: {
        id: user.id,
        username: user.username,
        display_name: user.displayName,
        roles: user.roles,
        status: user.status,
      },
      courses: { teacher: user.teacherCourseIds, student: user.studentCourseIds },
      expires_in_s: Math.floor(ttlMs / 1000),
    });
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const token = readCookie(req.headers.cookie);
    if (token) repo.rbac.deleteSession(hashToken(token));
    if (req.user) repo.rbac.audit({ userId: req.user.id, action: 'logout' });
    reply.header('set-cookie', buildClearCookie({ ttlMs: 0, secure: cfg.auth.cookieSecure }));
    return reply.send({ logged_out: true, had_session: Boolean(token) });
  });

  app.get('/api/v1/auth/me', async (req, reply) => {
    const user = requireUser(req);
    // 重新从库里读一次（改角色/禁用后立刻生效，不等会话过期）
    const fresh = repo.rbac.getUserRow(user.id);
    if (!fresh) throw new ApiError('E_UNAUTHENTICATED', '账号已不存在');
    return reply.send({
      user: {
        id: fresh.id,
        username: fresh.username,
        display_name: fresh.display_name,
        roles: repo.rbac.rolesOf(fresh.id),
        status: fresh.status,
      },
      courses: { teacher: user.teacherCourseIds, student: user.studentCourseIds },
      can: explain(user),
    });
  });

  app.post('/api/v1/auth/password', async (req, reply) => {
    const user = requireUser(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = typeof body.current_password === 'string' ? body.current_password : '';
    const next = typeof body.new_password === 'string' ? body.new_password : '';
    const row = repo.rbac.getUserRow(user.id);
    if (!row) throw new ApiError('E_UNAUTHENTICATED', '账号已不存在');

    if (!(await verifyPassword(row.password_hash, current))) {
      repo.rbac.audit({ userId: user.id, action: 'password_change_failed' });
      throw new ApiError('E_UNAUTHENTICATED', '当前口令不正确');
    }
    const problem = passwordProblem(next);
    if (problem) throw new ApiError('E_FORMAT', problem, { hint: '换一个更长的口令' });

    repo.rbac.setPassword(user.id, await hashPassword(next));
    // 改口令 → **失效所有旧会话**（含本会话），再发一个新会话；这是安全默认
    repo.rbac.deleteUserSessions(user.id);
    const token = newSessionToken();
    repo.rbac.createSession({
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: Date.now() + cfg.auth.sessionTtlMs,
      userAgent: req.headers['user-agent'] ?? '',
    });
    reply.header('set-cookie', buildSessionCookie(token, { ttlMs: cfg.auth.sessionTtlMs, secure: cfg.auth.cookieSecure }));
    repo.rbac.audit({ userId: user.id, action: 'password_change' });
    return reply.send({ changed: true, sessions_invalidated: true, cookie: SESSION_COOKIE });
  });
}
