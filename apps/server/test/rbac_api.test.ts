/**
 * RBAC 测试（`docs/RBAC.md` §9 验收）—— **负例是重点**。
 *
 * 覆盖 Lead 点名的四条：
 * 1. **未登录 → 401**（不是 500、不是空数据）
 * 2. **学生访问 draft → 404**（不是返回空列表冒充成功）
 * 3. **A 用户读不到 B 用户的笔记**（跨用户隔离，repo 层 SQL）
 * 4. **学生任务不能饿死教师任务**（优先级调度 + 配额 429）
 *
 * 另外覆盖"最容易糊弄过去"的两处：
 * - `docScopeSql()`（SQL 版）与 `docVisible()`（纯函数版）**结果必须一致**（矩阵对照）
 * - 教师发布后学生**立刻**可见（状态机真的生效，而不是只改了个字段）
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import { buildApp } from '../src/index.ts';
import type { BuiltApp } from '../src/index.ts';
import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { ApiError } from '../src/store/errors.ts';
import { TaskQueue } from '../src/tasks/queue.ts';
import { TaskEventBus } from '../src/tasks/bus.ts';
import { docScopeSql, docVisible } from '../src/store/scope.ts';
import type { DocScope } from '../src/store/scope.ts';
import { can, explain } from '../src/auth/permissions.ts';
import { hashPassword, verifyPassword, isArgon2idHash, passwordProblem } from '../src/auth/password.ts';
import {
  buildClearCookie,
  buildSessionCookie,
  hashToken,
  LoginRateLimiter,
  newSessionToken,
  readCookie,
  redactAuthText,
} from '../src/auth/session.ts';
import type { AuthUser, Resource } from '../src/auth/types.ts';
import { taskPriority, taskQuota } from '../src/auth/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const ADMIN_PASS = 'rbac-admin-pass-1';
let tmpRoot = '';
let counter = 0;

// ═══════════════════════════════════════════════════════════════════════
// HTTP 脚手架（真 listen + 真 fetch + 真 cookie）
// ═══════════════════════════════════════════════════════════════════════

interface Live {
  built: BuiltApp;
  base: string;
}

async function makeApp(
  opts: { extractAvailable?: boolean; extractImpl?: () => Promise<Record<string, unknown>> } = {},
): Promise<BuiltApp> {
  counter += 1;
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DATA_DIR: path.join(tmpRoot, `d${counter}`),
      COURSE_KB_DB: path.join(tmpRoot, `rbac-${counter}.sqlite3`),
      COURSE_KB_BOOTSTRAP_ADMIN: `admin:${ADMIN_PASS}`,
      LOGIN_MAX_FAILURES: '3',
      LOGIN_WINDOW_MS: '60000',
    } as Record<string, string>,
  });
  return buildApp({
    cfg,
    extractor: {
      name: 'noop',
      async available() {
        return opts.extractAvailable ? { ok: true, reason: '' } : { ok: false, reason: 'rbac 测试不抽取' };
      },
      async extractDocument() {
        if (opts.extractImpl) return opts.extractImpl() as never;
        throw new Error('不应被调用');
      },
    },
    workerProbe: async () => ({
      available: false,
      bin: 'python',
      module: 'worker.cli',
      pythonVersion: null,
      moduleImportable: false,
      reason: 'rbac 测试未启用 worker',
      checkedAt: Date.now(),
      cached: false,
      probes: {
        python: { ok: false, stdout: '', stderr: '', code: null, elapsedMs: 0 },
        module: { ok: false, stdout: '', stderr: '', code: null, elapsedMs: 0 },
      },
    }),
  });
}

async function listen(built: BuiltApp): Promise<Live> {
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('无法取到监听地址');
  return { built, base: `http://127.0.0.1:${addr.port}` };
}

/** 登录并返回 cookie 串（`ckb_session=...`）。 */
async function login(
  live: Live,
  username: string,
  password: string,
): Promise<{ cookie: string; status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${live.base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return { cookie, status: res.status, body };
}

async function req(
  live: Live,
  method: string,
  url: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${live.base}${url}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { _raw: text };
  }
  return { status: res.status, body };
}

const errCode = (body: Record<string, unknown>): string =>
  ((body.error as Record<string, string>) ?? {}).code ?? '';
const errMsg = (body: Record<string, unknown>): string =>
  ((body.error as Record<string, string>) ?? {}).msg ?? '';
const errHint = (body: Record<string, unknown>): string =>
  ((body.error as Record<string, string>) ?? {}).hint ?? '';

/** 建账号（admin 身份）。返回 201 断言，避免"建号失败但后面报 401"这种误导性失败。 */
async function createUser(
  live: Live,
  adminCookie: string,
  username: string,
  roles: string[],
  password = 'pass-12345',
): Promise<void> {
  const r = await req(live, 'POST', '/api/v1/users', {
    cookie: adminCookie,
    body: { username, password, roles },
  });
  assert.equal(r.status, 201, `建号 ${username} 失败：${JSON.stringify(r.body)}`);
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ckb-rbac-'));
});
after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows 偶发占用 */
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ① 口令 / 会话 / 限流 原语
// ═══════════════════════════════════════════════════════════════════════

test('argon2id：哈希前缀、正误口令、弱口令拒绝', async () => {
  const h = await hashPassword('correct horse battery');
  assert.equal(isArgon2idHash(h), true);
  assert.equal(h.split('$')[1], 'argon2id');
  assert.equal(await verifyPassword(h, 'correct horse battery'), true);
  assert.equal(await verifyPassword(h, 'wrong'), false);
  // 同一个口令两次哈希不同（随机 salt）
  assert.notEqual(await hashPassword('same-pw-12345'), await hashPassword('same-pw-12345'));
  // 坏哈希串不能抛（否则登录接口 500 → 把"凭据错"泄露成"服务器错"）
  assert.equal(await verifyPassword('not-a-hash', 'x'), false);
  assert.equal(await verifyPassword('', 'x'), false);
  assert.equal(passwordProblem('short'), '口令至少 8 位');
  assert.equal(passwordProblem('longenough1'), null);
});

test('会话：cookie 属性 httpOnly/Lax；库存哈希；明文 token 不落库', () => {
  const token = newSessionToken();
  assert.ok(token.length >= 32);
  const hashed = hashToken(token);
  assert.equal(hashed.length, 64, 'sha256 hex');
  assert.notEqual(hashed, token, '库里存的必须是哈希，不是明文 token');

  const cookie = buildSessionCookie(token, { ttlMs: 3_600_000, secure: false });
  assert.match(cookie, /^ckb_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=3600/);
  assert.ok(!cookie.includes('Secure'), '本机 HTTP 下不能带 Secure（否则浏览器不回传 → 登录不上）');
  assert.match(buildSessionCookie(token, { ttlMs: 1000, secure: true }), /Secure/);
  assert.match(buildClearCookie({ ttlMs: 0, secure: false }), /Max-Age=0/);

  // Cookie 解析
  assert.equal(readCookie(`a=1; ckb_session=${token}; b=2`), token);
  assert.equal(readCookie('a=1'), null);
  assert.equal(readCookie(undefined), null);

  // 日志脱敏（JSON 形态与手写日志行形态都要覆盖）
  const red = redactAuthText(`cookie: ckb_session=${token} password="hunter2" {"token":"abc123"}`);
  assert.ok(!red.includes(token), 'token 不许落日志');
  assert.ok(!red.includes('hunter2'), '口令不许落日志（password="x" 形态）');
  assert.ok(!red.includes('abc123'), 'token 不许落日志（JSON 形态）');
  assert.match(red, /<redacted>/);
});

test('登录限流：窗口内超限 → allowed=false + 可重试秒数', () => {
  const limiter = new LoginRateLimiter({ maxFailures: 3, windowMs: 60_000 });
  const t0 = 1_000_000;
  assert.equal(limiter.check('bob', '1.1.1.1', t0).allowed, true);
  limiter.fail('bob', '1.1.1.1', t0);
  limiter.fail('bob', '1.1.1.1', t0);
  assert.equal(limiter.check('bob', '1.1.1.1', t0).allowed, true, '第 3 次之前仍可试');
  limiter.fail('bob', '1.1.1.1', t0);
  const after3 = limiter.check('bob', '1.1.1.1', t0);
  assert.equal(after3.allowed, false);
  assert.equal(after3.failures, 3);
  assert.equal(after3.retryAfterS, 60);
  // 另一个用户不受影响（key 含 username）
  assert.equal(limiter.check('alice', '1.1.1.1', t0).allowed, true);
  // 窗口过期后恢复
  assert.equal(limiter.check('bob', '1.1.1.1', t0 + 60_001).allowed, true);
  limiter.reset('bob', '1.1.1.1');
  assert.equal(limiter.check('bob', '1.1.1.1', t0).failures, 0);
});

// ═══════════════════════════════════════════════════════════════════════
// ② 权限判定（§4 固定顺序）
// ═══════════════════════════════════════════════════════════════════════

function user(partial: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'usr_a',
    username: 'a',
    displayName: 'A',
    roles: ['student'],
    teacherCourseIds: [],
    studentCourseIds: [],
    status: 'active',
    ...partial,
  };
}

const draftDoc: Resource = {
  kind: 'document',
  ownerId: 'usr_t',
  visibility: 'private',
  reviewStatus: 'draft',
  courseId: null,
};
const pubDoc: Resource = {
  kind: 'document',
  ownerId: 'usr_t',
  visibility: 'public',
  reviewStatus: 'published',
  courseId: null,
};

test('can()：§4 七步顺序逐条（无会话 → 401；禁用 → 403；admin 放行；owner…）', () => {
  // 1. 无会话
  const anon = can(null, 'read', pubDoc);
  assert.equal(anon.ok, false);
  assert.equal(anon.code, 'E_UNAUTHENTICATED');
  assert.equal(anon.status, 401);

  // 2. 禁用（即便 admin 也拒绝）
  const disabled = can(user({ roles: ['admin'], status: 'disabled' }), 'read', pubDoc);
  assert.equal(disabled.code, 'E_ACCOUNT_DISABLED');
  assert.equal(disabled.status, 403);

  // 3. admin 全放行
  assert.equal(can(user({ roles: ['admin'] }), 'read', draftDoc).ok, true);
  assert.equal(can(user({ roles: ['admin'] }), 'publish', draftDoc).ok, true);

  // 4. owner 放行（**但"发布"例外**）
  const ownerStudent = user({ id: 'usr_own', roles: ['student'] });
  const ownDraft: Resource = {
    kind: 'document',
    ownerId: 'usr_own',
    visibility: 'private',
    reviewStatus: 'draft',
    courseId: null,
  };
  assert.equal(can(ownerStudent, 'read', ownDraft).ok, true, 'owner 能读自己的 draft');
  const publishByOwner = can(ownerStudent, 'publish', ownDraft);
  assert.equal(publishByOwner.ok, false, '§4：owner 除"发布"外全权 → 学生 owner 不能发布');
  assert.equal(publishByOwner.status, 403);
  // 教师 owner（未挂课程）可以发布自己的资料 —— 常规教学路径
  const ownerTeacher = user({ id: 'usr_own', roles: ['teacher'] });
  assert.equal(can(ownerTeacher, 'publish', ownDraft).ok, true, '教师 owner 可发布自己的资料');
  assert.equal(can(ownerTeacher, 'review', ownDraft).ok, true);

  // 5. 课程成员
  const courseDoc: Resource = {
    kind: 'document',
    ownerId: 'usr_t',
    visibility: 'course',
    reviewStatus: 'draft',
    courseId: 'crs_1',
  };
  const student = user({ id: 'usr_s', studentCourseIds: ['crs_1'] });
  const teacher = user({ id: 'usr_t2', roles: ['teacher'], teacherCourseIds: ['crs_1'] });
  assert.equal(can(teacher, 'read', courseDoc).ok, true, '任课教师可读 draft（要能审）');
  assert.equal(can(teacher, 'publish', courseDoc).ok, true, '任课教师可发布本课程内容');
  const sDraft = can(student, 'read', courseDoc);
  assert.equal(sDraft.ok, false, '学生读 draft 课程文档 → 拒绝');
  assert.match(String(sDraft.reason), /尚未发布/);
  // 学生读已发布课程文档 → 放行
  const coursePub: Resource = { ...courseDoc, reviewStatus: 'published' } as Resource;
  assert.equal(can(student, 'read', coursePub).ok, true);

  // 6. public + published → 只读放行（任何已登录用户）
  assert.equal(can(user({ id: 'usr_x' }), 'read', pubDoc).ok, true);
  const writePub = can(user({ id: 'usr_x' }), 'review', pubDoc);
  assert.equal(writePub.ok, false);
  // public 但未发布 → 拒绝
  const publicDraft: Resource = {
    kind: 'document',
    ownerId: 'usr_t',
    visibility: 'public',
    reviewStatus: 'draft',
    courseId: null,
  };
  const pd = can(user({ id: 'usr_x' }), 'read', publicDraft);
  assert.equal(pd.ok, false);
  assert.match(String(pd.reason), /尚未发布/);

  // 7. 全局动作
  assert.equal(can(user({ roles: ['student'] }), 'upload', { kind: 'global' }).ok, false, '学生不能上传');
  assert.equal(can(user({ roles: ['teacher'] }), 'upload', { kind: 'global' }).ok, true);
  assert.equal(
    can(user({ roles: ['teacher'] }), 'manage_users', { kind: 'global' }).ok,
    false,
    '管理用户要 admin',
  );
  assert.equal(can(user({ roles: ['admin'] }), 'manage_users', { kind: 'global' }).ok, true);
  // 学生可以问 AI / 做笔记
  assert.equal(can(user(), 'chat', { kind: 'global' }).ok, true);
  assert.equal(can(user({ id: 'usr_a' }), 'note', { kind: 'note', ownerId: 'usr_a' }).ok, true);
  assert.equal(
    can(user({ id: 'usr_a' }), 'note', { kind: 'note', ownerId: 'usr_b' }).ok,
    false,
    '笔记只能自己的',
  );

  assert.match(explain(user({ roles: ['teacher'] })), /teacher/);
  assert.equal(explain(null), '未登录');
});

test('任务优先级与配额（§5）：教师 0 / 学生 1；学生 1 / 教师 2 / 管理员不限', () => {
  assert.equal(taskPriority(user({ roles: ['teacher'] })), 0);
  assert.equal(taskPriority(user({ roles: ['admin'] })), 0);
  assert.equal(taskPriority(user()), 1);
  assert.equal(taskPriority(null), 0, '系统任务最高优先');
  assert.equal(taskQuota(user()), 1);
  assert.equal(taskQuota(user({ roles: ['teacher'] })), 2);
  assert.equal(taskQuota(null), 0);
  assert.equal(Number.isFinite(taskQuota(user({ roles: ['admin'] }))), false, '管理员不限（Infinity）');
});

// ═══════════════════════════════════════════════════════════════════════
// ③ ★ 可见性：SQL 版 == 纯函数版（防"只改一边 → 静默越权"）
// ═══════════════════════════════════════════════════════════════════════

test('★ docScopeSql 与 docVisible 结果完全一致（矩阵对照，含课程/公开/草稿组合）', () => {
  const db = Db.open(':memory:');
  try {
    const repo = new Repo(db);
    // 先建**真实**用户/课程：外键是开着的，假 id 会 SQLITE_CONSTRAINT_FOREIGNKEY
    for (const id of ['usr_me', 'usr_other', 'usr_teach', 'usr_s2', 'usr_admin']) {
      repo.rbac.createUser({ id, username: id, passwordHash: 'x', roles: ['student'] });
    }
    repo.rbac.createCourse({ id: 'crs_t', name: 'T', ownerId: 'usr_teach' });
    repo.rbac.createCourse({ id: 'crs_s', name: 'S', ownerId: 'usr_teach' });

    // 9 种文档 × 5 种 scope = 45 组，逐一比对 SQL 与纯函数
    const docs = [
      { owner: null, vis: 'private', rev: 'draft', course: null },
      { owner: 'usr_me', vis: 'private', rev: 'draft', course: null },
      { owner: 'usr_other', vis: 'private', rev: 'published', course: null },
      { owner: 'usr_other', vis: 'public', rev: 'published', course: null },
      { owner: 'usr_other', vis: 'public', rev: 'draft', course: null },
      { owner: 'usr_other', vis: 'course', rev: 'published', course: 'crs_t' },
      { owner: 'usr_other', vis: 'course', rev: 'draft', course: 'crs_t' },
      { owner: 'usr_other', vis: 'course', rev: 'published', course: 'crs_s' },
      { owner: 'usr_other', vis: 'course', rev: 'draft', course: 'crs_s' },
    ];
    for (const d of docs) {
      repo.insertDocument({
        title: 't',
        kind: 'text',
        source_path: 'p',
        ownerId: d.owner,
        visibility: d.vis as 'private' | 'course' | 'public',
        reviewStatus: d.rev as 'draft' | 'reviewed' | 'published',
        courseId: d.course,
      });
    }
    const scopes: DocScope[] = [
      { isAdmin: false, userId: null, teacherCourseIds: [], studentCourseIds: [] },
      { isAdmin: true, userId: 'usr_admin', teacherCourseIds: [], studentCourseIds: [] },
      { isAdmin: false, userId: 'usr_me', teacherCourseIds: [], studentCourseIds: ['crs_s'] },
      { isAdmin: false, userId: 'usr_teach', teacherCourseIds: ['crs_t'], studentCourseIds: [] },
      { isAdmin: false, userId: 'usr_me', teacherCourseIds: ['crs_t'], studentCourseIds: ['crs_s'] },
    ];
    const all = repo.listDocuments({ limit: 100 }).documents;
    assert.equal(all.length, docs.length, '夹具必须全部落库');
    let compared = 0;
    for (const scope of scopes) {
      const viaSql = new Set(repo.listDocumentsScoped(scope, { limit: 100 }).documents.map((d) => d.id));
      for (const doc of all) {
        const row = repo.getDocumentRow(doc.id);
        const viaFn = row ? docVisible(scope, row) : false;
        const viaOne = Boolean(repo.getDocumentScopedRow(doc.id, scope));
        assert.equal(viaOne, viaFn, `单条 SQL 与纯函数不一致：doc=${doc.id}`);
        assert.equal(
          viaSql.has(doc.id),
          viaFn,
          `列表 SQL 与纯函数不一致：doc=${doc.id} scope=${JSON.stringify(scope)}`,
        );
        compared += 1;
      }
    }
    assert.equal(compared, docs.length * scopes.length, '矩阵必须比完 9×5=45 组');

    // 硬约束在 SQL 里真的生效：学生列表里不许出现非 published
    const studentScope: DocScope = {
      isAdmin: false,
      userId: 'usr_s2',
      teacherCourseIds: [],
      studentCourseIds: ['crs_s'],
    };
    const visible = repo.listDocumentsScoped(studentScope, { limit: 100 }).documents;
    assert.equal(visible.filter((d) => d.review_status !== 'published').length, 0, '学生列表不许出现非 published');
    // 教师 scope 能看到 crs_t 的 draft（要能审）
    const teachScope: DocScope = {
      isAdmin: false,
      userId: 'usr_teach',
      teacherCourseIds: ['crs_t'],
      studentCourseIds: [],
    };
    assert.ok(
      repo
        .listDocumentsScoped(teachScope, { limit: 100 })
        .documents.some((d) => d.course_id === 'crs_t' && d.review_status === 'draft'),
      '任课教师必须能看到本课程 draft',
    );
  } finally {
    db.close();
  }
});

test('迁移 v2：8 张新表 + documents/tasks 新列都在，且迁移可重复执行（幂等）', () => {
  const db = Db.open(':memory:');
  try {
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .map((r) => r.name);
    for (const t of [
      'users',
      'user_roles',
      'courses',
      'course_members',
      'sessions',
      'notes',
      'conversations',
      'audit_log',
    ]) {
      assert.ok(tables.includes(t), `缺表 ${t}`);
    }
    const docCols = db.all<{ name: string }>('PRAGMA table_info(documents)').map((r) => r.name);
    for (const c of ['owner_id', 'visibility', 'review_status', 'course_id']) {
      assert.ok(docCols.includes(c), `documents 缺列 ${c}`);
    }
    const taskCols = db.all<{ name: string }>('PRAGMA table_info(tasks)').map((r) => r.name);
    for (const c of ['priority', 'user_id']) assert.ok(taskCols.includes(c), `tasks 缺列 ${c}`);
    // 幂等：再跑一次 migrate 不许抛（裸 ALTER 会 duplicate column；我们读 table_info 判缺）
    assert.equal(db.migrate() >= 2, true);
    assert.equal(db.foreignKeysEnabled(), true, '外键必须开着（级联删除依赖它）');
  } finally {
    db.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ④ ★ 负例：HTTP 层
// ═══════════════════════════════════════════════════════════════════════

test('★ 未登录 → 401（不是 500、不是空数据）；白名单三类接口仍可读', async () => {
  const live = await listen(await makeApp());
  try {
    for (const [method, url] of [
      ['GET', '/api/v1/documents'],
      ['GET', '/api/v1/documents/doc_x'],
      ['GET', '/api/v1/documents/doc_x/outline'],
      ['GET', '/api/v1/documents/doc_x/cards'],
      ['GET', '/api/v1/cards/crd_x'],
      ['GET', '/api/v1/search?q=%E7%B4%A2%E5%BC%95'],
      ['GET', '/api/v1/tasks'],
      ['GET', '/api/v1/tasks/tsk_x'],
      ['GET', '/api/v1/users'],
      ['GET', '/api/v1/courses'],
      ['GET', '/api/v1/notes'],
      ['POST', '/api/v1/notes'],
      ['GET', '/api/v1/audit'],
      ['GET', '/api/v1/auth/me'],
      ['POST', '/api/v1/auth/logout'],
      ['POST', '/api/v1/documents'],
      ['POST', '/api/v1/documents/doc_x/extract'],
      ['POST', '/api/v1/documents/doc_x/review'],
    ] as const) {
      const r = await req(live, method, url);
      assert.equal(r.status, 401, `${method} ${url} 应 401，实际 ${r.status}`);
      assert.equal(errCode(r.body), 'E_UNAUTHENTICATED', `${method} ${url} 错误码`);
      // **不是空数据冒充成功**：必须有 error 体
      assert.ok(r.body.error, `${method} ${url} 必须有 error 对象`);
    }
    // 白名单：health / capabilities / schema / login 不需要登录
    assert.equal((await req(live, 'GET', '/api/v1/health')).status, 200);
    const caps = await req(live, 'GET', '/api/v1/capabilities?deep=0');
    assert.equal(caps.status, 200);
    assert.equal((await req(live, 'GET', '/api/v1/schema')).status, 200);
    assert.equal(
      (await req(live, 'GET', '/api/v1/auth/login')).status,
      404,
      'login 是 POST（GET 未注册 → 404，但**不被 401 闸门拦**）',
    );
    // capabilities 的 auth 段（UI 据此决定显示登录页）
    const auth = caps.body.auth as Record<string, unknown>;
    assert.equal(auth.required, true);
    assert.equal(auth.bootstrap, 'initialized', 'bootstrap admin 已建 → initialized');
  } finally {
    await live.built.close();
  }
});

test('★ 学生访问 draft 文档 → 404（不是空列表冒充成功）；教师发布后学生可见', async () => {
  const live = await listen(await makeApp());
  try {
    const admin = await login(live, 'admin', ADMIN_PASS);
    assert.equal(admin.status, 200);
    assert.match(admin.cookie, /^ckb_session=/);
    assert.equal((admin.body.user as Record<string, unknown>).username, 'admin');

    await createUser(live, admin.cookie, 'teacher1', ['teacher']);
    await createUser(live, admin.cookie, 'student1', ['student']);
    await createUser(live, admin.cookie, 'stu2', ['student']);
    const teacher = await login(live, 'teacher1', 'pass-12345');
    const student = await login(live, 'student1', 'pass-12345');
    assert.equal(teacher.status, 200, JSON.stringify(teacher.body));
    assert.equal(student.status, 200, JSON.stringify(student.body));
    assert.deepEqual((student.body.user as Record<string, unknown>).roles, ['student']);

    // 教师上传 → draft 文档
    const form = new FormData();
    form.append('file', new Blob(['# 第一章\n聚簇索引。'], { type: 'text/markdown' }), 'lesson.md');
    const upRes = await fetch(`${live.base}/api/v1/documents`, {
      method: 'POST',
      headers: { cookie: teacher.cookie },
      body: form,
    });
    assert.equal(upRes.status, 202, await upRes.clone().text());
    const up = (await upRes.json()) as Record<string, unknown>;
    const docId = String(up.document_id);
    assert.equal(up.review_status, 'draft', '上传产物必须是 draft');

    // 教师能看到自己的 draft
    const tSee = await req(live, 'GET', `/api/v1/documents/${docId}`, { cookie: teacher.cookie });
    assert.equal(tSee.status, 200, JSON.stringify(tSee.body));
    assert.equal(tSee.body.review_status, 'draft');

    // ★ 学生看不到 draft：**404**（不是 200 + 空数据）
    for (const url of [
      `/api/v1/documents/${docId}`,
      `/api/v1/documents/${docId}/outline`,
      `/api/v1/documents/${docId}/units`,
      `/api/v1/documents/${docId}/cards`,
      `/api/v1/documents/${docId}/graph`,
      `/api/v1/documents/${docId}/xrefs`,
    ]) {
      const r = await req(live, 'GET', url, { cookie: student.cookie });
      assert.equal(r.status, 404, `学生访问 draft 的 ${url} 应 404，实际 ${r.status}`);
      assert.equal(errCode(r.body), 'E_NOTFOUND');
    }
    // 学生的**列表**里也不出现它（列表是过滤语义，不是报错）+ 如实告知被过滤过
    const list = await req(live, 'GET', '/api/v1/documents', { cookie: student.cookie });
    assert.equal(list.status, 200);
    assert.equal(
      (list.body.documents as { id: string }[]).some((d) => d.id === docId),
      false,
      '学生列表不许出现 draft',
    );
    assert.equal((list.body as { total?: number }).total, 0);
    assert.equal((list.body.scope as Record<string, unknown>).filtered_by_review, true);

    // 学生看不见的文档 → 连 review 都是 404（不泄露存在性）
    const studentReview = await req(live, 'POST', `/api/v1/documents/${docId}/review`, {
      cookie: student.cookie,
      body: { status: 'published' },
    });
    assert.equal(studentReview.status, 404, '学生看不见的文档 → 404');

    // 教师审核 → reviewed；再发布 → published
    const reviewed = await req(live, 'POST', `/api/v1/documents/${docId}/review`, {
      cookie: teacher.cookie,
      body: { status: 'reviewed' },
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    assert.equal(reviewed.body.review_status, 'reviewed');
    assert.equal(reviewed.body.changed, true);
    assert.equal(reviewed.body.previous, 'draft');
    // 幂等：再设 reviewed → changed:false
    const again = await req(live, 'POST', `/api/v1/documents/${docId}/review`, {
      cookie: teacher.cookie,
      body: { status: 'reviewed' },
    });
    assert.equal(again.body.changed, false);

    // reviewed 学生仍看不到（中间态不给学生）
    assert.equal(
      (await req(live, 'GET', `/api/v1/documents/${docId}`, { cookie: student.cookie })).status,
      404,
    );

    // ★ 发布前必须真的"能给学生看到"：private + 无课程 → 如实拒绝（不假装发布成功）
    const bogusPublish = await req(live, 'POST', `/api/v1/documents/${docId}/review`, {
      cookie: teacher.cookie,
      body: { status: 'published' },
    });
    assert.equal(bogusPublish.status, 422, JSON.stringify(bogusPublish.body));
    assert.equal(errCode(bogusPublish.body), 'E_PARSE');
    assert.match(errMsg(bogusPublish.body), /学生仍然看不到/);
    assert.match(errHint(bogusPublish.body), /visibility/);
    // 状态**没有**被改成 published（拒绝就是拒绝，不留半成品）
    assert.equal(
      (await req(live, 'GET', `/api/v1/documents/${docId}`, { cookie: teacher.cookie })).body
        .review_status,
      'reviewed',
    );

    // 带 visibility=public 发布 → 成功，且响应如实回报最终可见范围
    const published = await req(live, 'POST', `/api/v1/documents/${docId}/review`, {
      cookie: teacher.cookie,
      body: { status: 'published', visibility: 'public' },
    });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.review_status, 'published');
    assert.equal(published.body.visibility, 'public');

    // ★ 发布后学生**立刻**可见
    const sSee = await req(live, 'GET', `/api/v1/documents/${docId}`, { cookie: student.cookie });
    assert.equal(sSee.status, 200, JSON.stringify(sSee.body));
    assert.equal(sSee.body.review_status, 'published');
    const sList = await req(live, 'GET', '/api/v1/documents', { cookie: student.cookie });
    assert.equal((sList.body as { total: number }).total, 1, '发布后学生列表应有 1 条');

    // 非法状态 → 400
    const bad = await req(live, 'POST', `/api/v1/documents/${docId}/review`, {
      cookie: teacher.cookie,
      body: { status: 'archived' },
    });
    assert.equal(bad.status, 400);
    assert.equal(errCode(bad.body), 'E_BADREQUEST');

    // 审计留痕：upload / review / publish 都在
    const audit = await req(live, 'GET', '/api/v1/audit?limit=50', { cookie: admin.cookie });
    assert.equal(audit.status, 200);
    const actions = (audit.body.entries as { action: string }[]).map((e) => e.action);
    assert.ok(actions.includes('review'), 'audit 应有 review');
    assert.ok(actions.includes('publish'), 'audit 应有 publish');
    assert.ok(actions.includes('upload'), 'audit 应有 upload');
  } finally {
    await live.built.close();
  }
});

test('★ A 用户读不到 B 用户的笔记（404），列表互不可见；隔离在 SQL 层', async () => {
  const live = await listen(await makeApp());
  try {
    const admin = await login(live, 'admin', ADMIN_PASS);
    await createUser(live, admin.cookie, 'alice', ['student']);
    await createUser(live, admin.cookie, 'bob', ['student']);
    const alice = await login(live, 'alice', 'pass-12345');
    const bob = await login(live, 'bob', 'pass-12345');

    // alice 建笔记
    const created = await req(live, 'POST', '/api/v1/notes', {
      cookie: alice.cookie,
      body: { body: 'alice 的私密笔记', doc_id: 'doc_1' },
    });
    assert.equal(created.status, 201);
    const noteId = String((created.body.note as Record<string, unknown>).id);
    assert.match(noteId, /^not_/);

    // alice 自己读得到
    assert.equal(
      (await req(live, 'GET', `/api/v1/notes/${noteId}`, { cookie: alice.cookie })).status,
      200,
    );
    assert.equal((await req(live, 'GET', '/api/v1/notes', { cookie: alice.cookie })).body.total, 1);

    // ★ bob 读 alice 的笔记 → 404（不泄露存在性）
    const stolen = await req(live, 'GET', `/api/v1/notes/${noteId}`, { cookie: bob.cookie });
    assert.equal(stolen.status, 404, `bob 不应读到 alice 的笔记，实际 ${stolen.status}`);
    assert.equal(errCode(stolen.body), 'E_NOTFOUND');
    // bob 的列表为空（SQL 层就带 user_id）
    const bobList = await req(live, 'GET', '/api/v1/notes', { cookie: bob.cookie });
    assert.equal(bobList.body.total, 0);
    assert.deepEqual(bobList.body.notes, []);
    // bob 也删不掉 alice 的
    assert.equal(
      (await req(live, 'DELETE', `/api/v1/notes/${noteId}`, { cookie: bob.cookie })).status,
      404,
    );
    // alice 的仍健在
    assert.equal(
      (await req(live, 'GET', `/api/v1/notes/${noteId}`, { cookie: alice.cookie })).status,
      200,
    );

    // 隔离是**库层**事实，不只是接口层
    assert.equal(live.built.deps.repo.rbac.countNotesAllUsers(), 1);
    const aliceId = String((alice.body.user as Record<string, unknown>).id);
    const bobId = String((bob.body.user as Record<string, unknown>).id);
    assert.equal(live.built.deps.repo.rbac.listNotes(aliceId).total, 1);
    assert.equal(live.built.deps.repo.rbac.listNotes(bobId).total, 0, 'repo 层按 userId 过滤');

    // 会话（conversations）同样隔离
    const conv = await req(live, 'POST', '/api/v1/conversations', {
      cookie: alice.cookie,
      body: { title: 'a 的会话' },
    });
    assert.equal(conv.status, 201);
    const convId = String((conv.body.conversation as Record<string, unknown>).id);
    assert.equal(
      (await req(live, 'GET', `/api/v1/conversations/${convId}`, { cookie: bob.cookie })).status,
      404,
    );
    assert.equal(
      (await req(live, 'GET', '/api/v1/conversations', { cookie: bob.cookie })).body.total,
      0,
    );
  } finally {
    await live.built.close();
  }
});

test('★ 学生任务不饿死教师任务：优先级插队 + 每用户配额（确定性单测）', async () => {
  // 用一个"卡住"的 handler 占住唯一并发位，之后入队的任务全停在 pending → 顺序完全确定
  const db = Db.open(':memory:');
  const repo = new Repo(db);
  // 外键开着 → 任务里的 user_id 必须指向真实用户
  repo.rbac.createUser({ id: 'usr_student', username: 'usr_student', passwordHash: 'x', roles: ['student'] });
  repo.rbac.createUser({ id: 'usr_teacher', username: 'usr_teacher', passwordHash: 'x', roles: ['teacher'] });
  const bus = new TaskEventBus();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const ran: string[] = [];
  const queue = new TaskQueue({
    repo,
    bus,
    concurrency: 1,
    handlers: {
      block: async () => {
        await gate;
        return {};
      },
      quick: async (ctx) => {
        ran.push(String(ctx.userId));
        return {};
      },
    },
    // 学生 1 / 教师 2（与 taskQuota 一致；这里内联以便断言确定值）
    resolveQuota: (userId) => (userId === 'usr_teacher' ? 2 : 1),
  });

  try {
    // ① 系统任务先占住唯一并发位（userId=null → 不受配额限制）
    queue.enqueue({ kind: 'block' });
    assert.equal(queue.running().length, 1, 'block 任务应立刻开始跑');

    // ② 先入学生（priority 1），再入教师（priority 0）
    const s1 = queue.enqueue({ kind: 'quick', userId: 'usr_student', priority: 1 });
    const t1 = queue.enqueue({ kind: 'quick', userId: 'usr_teacher', priority: 0 });
    // ★ 教师必须插到学生前面（学生先来，但优先级低）
    assert.deepEqual(
      queue.pendingSummary().map((p) => p.taskId),
      [t1, s1],
      '优先级 0 的教师任务必须排在优先级 1 的学生任务之前',
    );
    assert.deepEqual(
      queue.pendingSummary().map((p) => p.priority),
      [0, 1],
    );

    // ③ 学生配额 1：已占 1 → 再来一个必须 **E_QUOTA**（429），不许静默排队
    let quotaErr: ApiError | null = null;
    try {
      queue.enqueue({ kind: 'quick', userId: 'usr_student', priority: 1 });
    } catch (err) {
      quotaErr = err as ApiError;
    }
    assert.ok(quotaErr, '学生超配额必须抛错');
    assert.equal(quotaErr?.code, 'E_QUOTA');
    assert.equal(quotaErr?.httpStatus, 429);
    assert.match(String(quotaErr?.hint), /配额|并发/);
    assert.deepEqual(queue.quotaUsage('usr_student'), { active: 0, pending: 1, used: 1, quota: 1 });

    // ④ 教师配额 2：还能再入一个（教师不会被学生挤掉）
    const t2 = queue.enqueue({ kind: 'quick', userId: 'usr_teacher', priority: 0 });
    assert.match(t2, /^tsk_/);
    assert.deepEqual(queue.quotaUsage('usr_teacher'), { active: 0, pending: 2, used: 2, quota: 2 });

    // ⑤ 放行阻塞任务 → 队列按顺序跑完（两个教师任务先，学生任务最后）
    release();
    await queue.drained(20_000);
    assert.deepEqual(ran, ['usr_teacher', 'usr_teacher', 'usr_student'], '执行顺序必须教师优先');
  } finally {
    await queue.shutdown(5_000);
    db.close();
  }
});

test('★ 学生超配额在 HTTP 层也是 429 E_QUOTA（带可读 hint，不是 500）', async () => {
  // 抽取器"可用但会卡住" → 第一个任务真的占住学生的配额，才能验证第二个被 429 挡住
  let releaseExtract!: () => void;
  const gate = new Promise<void>((r) => {
    releaseExtract = r;
  });
  const live = await listen(
    await makeApp({
      extractAvailable: true,
      extractImpl: async () => {
        await gate;
        return { ok: true, error_count: 0, cards: [], entities: [], edges: [], sections: [], stats: {} };
      },
    }),
  );
  try {
    const admin = await login(live, 'admin', ADMIN_PASS);
    await createUser(live, admin.cookie, 'quota-s', ['student']);
    const student = await login(live, 'quota-s', 'pass-12345');
    assert.equal(student.status, 200, JSON.stringify(student.body));
    const studentId = String((student.body.user as Record<string, unknown>).id);

    // 造一篇"学生自己的"有 units 的文档（owner 是他 → 可见；否则会先撞 404）
    const docId = live.built.deps.repo.insertDocument({
      title: 'x',
      kind: 'text',
      source_path: 'p',
      ownerId: studentId,
    });
    live.built.deps.repo.replaceUnits(docId, [
      { ord: 1, title: 'u', level: 1, span: { kind: 'page', start: 1, end: 1 }, text: 't' },
    ]);

    // 第一个抽取任务进入 running 并卡住 → 学生配额（=1）被占满
    const first = await req(live, 'POST', `/api/v1/documents/${docId}/extract`, {
      cookie: student.cookie,
    });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    const deadline = Date.now() + 5000;
    while (live.built.deps.queue.quotaUsage(studentId).active < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(live.built.deps.queue.quotaUsage(studentId).used, 1, '第一个任务必须真的占住配额');

    // ★ 第二个 → 429 E_QUOTA（不是静默排队、不是 500）
    const second = await req(live, 'POST', `/api/v1/documents/${docId}/extract`, {
      cookie: student.cookie,
    });
    assert.equal(
      second.status,
      429,
      `学生超配额应 429，实际 ${second.status}：${JSON.stringify(second.body)}`,
    );
    assert.equal(errCode(second.body), 'E_QUOTA');
    assert.equal(errHint(second.body).length > 0, true, '429 必须带可读 hint');

    // 教师（配额 2）**同一时刻**仍能入队 —— 学生占满自己的配额不影响教师
    await createUser(live, admin.cookie, 'quota-t', ['teacher']);
    const teacher = await login(live, 'quota-t', 'pass-12345');
    const teacherDoc = live.built.deps.repo.insertDocument({
      title: 'y',
      kind: 'text',
      source_path: 'p',
      ownerId: String((teacher.body.user as Record<string, unknown>).id),
    });
    live.built.deps.repo.replaceUnits(teacherDoc, [
      { ord: 1, title: 'u', level: 1, span: { kind: 'page', start: 1, end: 1 }, text: 't' },
    ]);
    const teacherExtract = await req(live, 'POST', `/api/v1/documents/${teacherDoc}/extract`, {
      cookie: teacher.cookie,
    });
    assert.equal(teacherExtract.status, 202, JSON.stringify(teacherExtract.body));

    releaseExtract();
    await live.built.deps.queue.drained(20_000);
  } finally {
    releaseExtract();
    await live.built.close();
  }
});

test('账号禁用：立刻踢下线 + /me 401；错误口令 401 且文案不区分"用户不存在"', async () => {
  const live = await listen(await makeApp());
  try {
    const admin = await login(live, 'admin', ADMIN_PASS);
    await createUser(live, admin.cookie, 'victim', ['student']);
    const v = await login(live, 'victim', 'pass-12345');
    assert.equal(v.status, 200);
    assert.equal((await req(live, 'GET', '/api/v1/auth/me', { cookie: v.cookie })).status, 200);

    const victimId = String((v.body.user as Record<string, unknown>).id);
    const off = await req(live, 'PATCH', `/api/v1/users/${victimId}`, {
      cookie: admin.cookie,
      body: { status: 'disabled' },
    });
    assert.equal(off.status, 200);
    assert.equal((off.body.user as Record<string, unknown>).status, 'disabled');
    // 会话被删 → 旧 cookie 立刻 401
    assert.equal(
      (await req(live, 'GET', '/api/v1/auth/me', { cookie: v.cookie })).status,
      401,
      '禁用后必须踢下线',
    );
    // 再用旧口令登录 → 403 E_ACCOUNT_DISABLED（账号状态问题，与口令错区分）
    const reLogin = await login(live, 'victim', 'pass-12345');
    assert.equal(reLogin.status, 403);
    assert.equal(errCode(reLogin.body), 'E_ACCOUNT_DISABLED');

    // 不存在的用户 与 错口令 → **同一个 401 文案**（不给用户名枚举）
    const noUser = await login(live, 'nobody-here', 'whatever-12345');
    const badPw = await login(live, 'admin', 'wrong-password-1');
    assert.equal(noUser.status, 401);
    assert.equal(badPw.status, 401);
    assert.equal(errMsg(noUser.body), errMsg(badPw.body), '两种失败的文案必须一致');
    assert.equal(errMsg(noUser.body), '用户名或口令不正确');
  } finally {
    await live.built.close();
  }
});

test('登录失败限流：连续失败 → 429 + retry-after；超限后连正确口令也拒', async () => {
  const live = await listen(await makeApp());
  try {
    // LOGIN_MAX_FAILURES=3（见 makeApp）
    for (let i = 1; i <= 3; i += 1) {
      const r = await login(live, 'admin', 'definitely-wrong');
      assert.equal(r.status, 401, `第 ${i} 次失败应是 401`);
    }
    const blocked = await login(live, 'admin', 'definitely-wrong');
    assert.equal(blocked.status, 429, `超限应 429，实际 ${blocked.status}`);
    assert.equal(errCode(blocked.body), 'E_RATELIMIT');
    // 即便口令**正确**，限流窗口内也被拒（先查计数，避免拿 argon2 当撞库加速器）
    assert.equal((await login(live, 'admin', ADMIN_PASS)).status, 429);
  } finally {
    await live.built.close();
  }
});

test('改口令：验旧口令；改后旧会话失效；新 cookie 可用', async () => {
  const live = await listen(await makeApp());
  try {
    const admin = await login(live, 'admin', ADMIN_PASS);
    await createUser(live, admin.cookie, 'pwm', ['student'], 'old-pass-12345');
    const first = await login(live, 'pwm', 'old-pass-12345');
    assert.equal(first.status, 200);

    // 旧口令错 → 401
    const bad = await req(live, 'POST', '/api/v1/auth/password', {
      cookie: first.cookie,
      body: { current_password: 'not-the-old-one', new_password: 'new-pass-12345' },
    });
    assert.equal(bad.status, 401);

    // 正确 → 200 + 新 cookie
    const ok = await fetch(`${live.base}/api/v1/auth/password`, {
      method: 'POST',
      headers: { cookie: first.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ current_password: 'old-pass-12345', new_password: 'new-pass-12345' }),
    });
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as Record<string, unknown>;
    assert.equal(okBody.changed, true);
    assert.equal(okBody.sessions_invalidated, true);
    const newCookie = (ok.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    assert.match(newCookie, /^ckb_session=/);

    // 旧 cookie 失效，新 cookie 可用
    assert.equal(
      (await req(live, 'GET', '/api/v1/auth/me', { cookie: first.cookie })).status,
      401,
      '旧会话必须失效',
    );
    assert.equal((await req(live, 'GET', '/api/v1/auth/me', { cookie: newCookie })).status, 200);
    // 新口令可登录，旧口令不可
    assert.equal((await login(live, 'pwm', 'new-pass-12345')).status, 200);
    assert.equal((await login(live, 'pwm', 'old-pass-12345')).status, 401);
  } finally {
    await live.built.close();
  }
});

test('users/courses/members：admin 建号、教师建课加成员、学生只能读自己课程', async () => {
  const live = await listen(await makeApp());
  try {
    const admin = await login(live, 'admin', ADMIN_PASS);
    await createUser(live, admin.cookie, 'stu9', ['student']);
    const stu9 = await login(live, 'stu9', 'pass-12345');
    assert.equal(stu9.status, 200);

    // 学生建号被拒（403，不是 401 —— 已登录但无权）
    const forbidden = await req(live, 'POST', '/api/v1/users', {
      cookie: stu9.cookie,
      body: { username: 'hacker', password: 'pass-12345', roles: ['admin'] },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(errCode(forbidden.body), 'E_FORBIDDEN');

    // 非法角色 / 重复用户名 / 弱口令
    for (const [body, expected] of [
      [{ username: 'bad1', password: 'pass-12345', roles: ['root'] }, 400],
      [{ username: 'stu9', password: 'pass-12345', roles: ['student'] }, 409],
      [{ username: 'weak', password: 'short', roles: ['student'] }, 400],
      [{ username: 'ab', password: 'pass-12345', roles: ['student'] }, 400],
    ] as const) {
      const r = await req(live, 'POST', '/api/v1/users', { cookie: admin.cookie, body });
      assert.equal(r.status, expected, `建号 ${JSON.stringify(body)} 应 ${expected}`);
    }

    // 教师建课 → 自动成为 teacher 成员
    await createUser(live, admin.cookie, 'tea9', ['teacher']);
    const tea9 = await login(live, 'tea9', 'pass-12345');
    assert.equal(tea9.status, 200, JSON.stringify(tea9.body));
    const tea9id = String((tea9.body.user as Record<string, unknown>).id);
    const course = await req(live, 'POST', '/api/v1/courses', {
      cookie: tea9.cookie,
      body: { name: '数据库原理', term: '2026春' },
    });
    assert.equal(course.status, 201, JSON.stringify(course.body));
    const courseId = String((course.body.course as Record<string, unknown>).id);
    assert.match(courseId, /^crs_/);
    const members = await req(live, 'GET', `/api/v1/courses/${courseId}/members`, {
      cookie: tea9.cookie,
    });
    assert.equal(members.body.total, 1, 'owner 自动成为 teacher 成员');
    assert.equal((members.body.members as { user_id: string; role: string }[])[0]?.user_id, tea9id);

    // 加学生进来
    const added = await req(live, 'POST', `/api/v1/courses/${courseId}/members`, {
      cookie: tea9.cookie,
      body: { username: 'stu9', role: 'student' },
    });
    assert.equal(added.status, 201);
    assert.equal((added.body.members as unknown[]).length, 2);
    // 非法 role
    assert.equal(
      (await req(live, 'POST', `/api/v1/courses/${courseId}/members`, {
        cookie: tea9.cookie,
        body: { username: 'stu9', role: 'admin' },
      })).status,
      400,
    );
    // 不存在的用户
    assert.equal(
      (await req(live, 'POST', `/api/v1/courses/${courseId}/members`, {
        cookie: tea9.cookie,
        body: { username: 'ghost-user', role: 'student' },
      })).status,
      404,
    );

    // 学生登录后 /me 与 /courses 只看到自己加入的
    const me = await req(live, 'GET', '/api/v1/auth/me', { cookie: stu9.cookie });
    assert.deepEqual((me.body.courses as Record<string, string[]>).student, [courseId]);
    const list = await req(live, 'GET', '/api/v1/courses', { cookie: stu9.cookie });
    assert.equal(list.body.total, 1);
    assert.equal((list.body.courses as { id: string; my_role: string }[])[0]?.my_role, 'student');

    // 学生不能加成员（403）
    const cannot = await req(live, 'POST', `/api/v1/courses/${courseId}/members`, {
      cookie: stu9.cookie,
      body: { username: 'stu9', role: 'teacher' },
    });
    assert.equal(cannot.status, 403);

    // 教师能移除成员；移除后学生看不到该课程
    const stu9id = String((stu9.body.user as Record<string, unknown>).id);
    const removed = await req(live, 'DELETE', `/api/v1/courses/${courseId}/members/${stu9id}`, {
      cookie: tea9.cookie,
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, true);
    const listAfter = await req(live, 'GET', '/api/v1/courses', { cookie: stu9.cookie });
    assert.equal(listAfter.body.total, 0);
  } finally {
    await live.built.close();
  }
});
