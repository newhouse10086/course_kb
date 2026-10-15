/**
 * `/api/v1/sandbox/*` HTTP 层测试（`docs/SETTINGS_AND_SANDBOX.md` §3 + `worker/README.md` §10）。
 *
 * ⚠️ 本文件跑的是**真 worker 进程 + 真 SQLite**（不是 mock）：沙箱的全部价值就在"真执行"，
 * mock 掉等于什么都没验证。
 *
 * 覆盖的核心语义：
 * 1. **学生 SQL 写错 → HTTP 200 + `ok:false` + `error.code`**（**不是 500**）—— 最易做错的一条
 * 2. **跨用户隔离**：拿别人的 sessionId 执行 → 403（负例）
 * 3. **规则拒绝**（`ATTACH`/多语句）→ 200 + `error.who='rules'`（"不是你的 SQL 写错了"）
 * 4. **长查询不阻塞服务**：真跑 `WITH RECURSIVE` 死循环 → 被杀 + `/health` 仍 200
 * 5. 未登录 → 401（RBAC 闸门覆盖到沙箱）
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import { buildApp } from '../src/index.ts';
import type { BuiltApp } from '../src/index.ts';
import {
  isCrossCallTxControl,
  ownerOfSession,
  readCrossCallTx,
  sanitizeIdPart,
  sandboxSseFrame,
  sessionIdFor,
  shouldGuardCrossCallTx,
} from '../src/routes/sandbox.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const ADMIN_PASS = 'sandbox-admin-pass1';
let tmpRoot = '';
let counter = 0;

/** 真 worker：用真 `worker/cli.py`（不是假脚本）——沙箱必须真跑。 */
async function makeApp(): Promise<BuiltApp> {
  counter += 1;
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DATA_DIR: path.join(tmpRoot, `d${counter}`),
      COURSE_KB_DB: path.join(tmpRoot, `sandbox-${counter}.sqlite3`),
      COURSE_KB_BOOTSTRAP_ADMIN: `admin:${ADMIN_PASS}`,
      // 沙箱库落在临时目录，别污染仓库 data/sandbox
      COURSE_KB_SANDBOX_ROOT: path.join(tmpRoot, 'sandbox'),
    } as Record<string, string>,
  });
  return buildApp({
    cfg,
    extractor: {
      name: 'noop',
      async available() {
        return { ok: false, reason: '沙箱测试不抽取' };
      },
      async extractDocument() {
        throw new Error('不应被调用');
      },
    },
  });
}

interface Live {
  built: BuiltApp;
  base: string;
}

async function listen(built: BuiltApp): Promise<Live> {
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('无法取到监听地址');
  return { built, base: `http://127.0.0.1:${addr.port}` };
}

async function login(live: Live, username: string, password: string): Promise<string> {
  const res = await fetch(`${live.base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) throw new Error(`登录失败(${res.status})：${await res.text()}`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
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
    body = { _raw: text.slice(0, 400) };
  }
  return { status: res.status, body };
}

async function createUser(live: Live, adminCookie: string, username: string, roles: string[]): Promise<void> {  const r = await req(live, 'POST', '/api/v1/users', {
    cookie: adminCookie,
    body: { username, password: 'pass-12345', roles },
  });
  assert.equal(r.status, 201, `建号 ${username} 失败：${JSON.stringify(r.body)}`);
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ckb-sandbox-'));
});
after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows 偶发占用 */
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ① 会话 id 的推导与归属（纯函数，先钉住路径隔离的语义）
// ═══════════════════════════════════════════════════════════════════════

test('会话 id：服务端推导 + 可逆解析归属；危险字符被清洗', () => {
  const sid = sessionIdFor('usr_abc123', 'sc');
  assert.match(sid, /^s_[A-Za-z0-9_-]+_sc$/);
  assert.equal(ownerOfSession(sid), 'usr_abc123', '必须能解析回原 userId');
  // 中文/连字符 userId 也要能往返
  const sid2 = sessionIdFor('usr_中文-1', 'employees');
  assert.equal(ownerOfSession(sid2), 'usr_中文-1');
  assert.equal(ownerOfSession(sessionIdFor('a', 'orders')), 'a');
  // 不是我们的格式 → 不猜
  assert.equal(ownerOfSession('../../etc/passwd'), null);
  assert.equal(ownerOfSession('s_'), null);
  assert.equal(ownerOfSession('evil'), null);
  // 危险字符清洗（路径穿越/Windows 保留字符）
  assert.equal(sanitizeIdPart('../../x'), 'x');
  assert.equal(sanitizeIdPart('a/b\\c:d*e'), 'abcde');
  assert.equal(sanitizeIdPart('正常名字'), '正常名字');
});

test('★ /sandbox/ask 的 SSE 帧：含 U+2028/U+2029 的学生 SQL/报错仍是**单行** JSON（坑 17）', () => {
  // 学生 SQL 与 SQLite 报错是任意文本 → 必须走 safeJsonStringify，否则一帧裂成两帧、静默丢事件
  const nasty = {
    question: '这段为什么报错？\u2028第二行\u2029第三行',
    error: 'near "\u2028": syntax error',
    sql: "SELECT '\u2029' FROM t",
  };
  const frame = sandboxSseFrame('frame', nasty);
  // ① 整帧只有 **一个** `\n\n` 结束符（没有被裂开）
  assert.equal(frame.endsWith('\n\n'), true);
  assert.equal(frame.slice(0, -2).includes('\n\n'), false, '帧体里不许出现帧分隔符');
  // ② data: 之后到帧尾只有**一行**
  const dataLine = frame.split('\n')[1] ?? '';
  assert.match(dataLine, /^data: /);
  const json = dataLine.slice('data: '.length);
  assert.equal(json.includes('\u2028'), false, 'U+2028 必须被转义');
  assert.equal(json.includes('\u2029'), false, 'U+2029 必须被转义');
  assert.match(json, /\\u2028/);
  assert.match(json, /\\u2029/);
  // ③ 解析回来必须与原文**逐字相同**（转义不是丢数据）
  assert.deepEqual(JSON.parse(json), nasty);
  // ④ 对照：直接 JSON.stringify 会打穿单行保证（证明这个测试真的在测东西）
  const naive = `event: frame\ndata: ${JSON.stringify(nasty)}\n\n`;
  assert.equal(naive.slice(0, -2).includes('\n\n'), false);
  assert.equal(naive.split('\n').length > 2, true, '朴素写法会产生多行 → 读取器会错切');
});

// ═══════════════════════════════════════════════════════════════════════
// ② 未登录 → 401（沙箱不能被匿名调用）
// ═══════════════════════════════════════════════════════════════════════
test('★ 未登录访问 /sandbox/* → 401（不是 500、不是空数据）', async () => {
  const live = await listen(await makeApp());
  try {
    for (const [method, url] of [
      ['POST', '/api/v1/sandbox/session'],
      ['POST', '/api/v1/sandbox/execute'],
      ['POST', '/api/v1/sandbox/reset'],
      ['POST', '/api/v1/sandbox/ask'],
      ['GET', '/api/v1/sandbox/datasets'],
      ['GET', '/api/v1/sandbox/schema'],
      ['GET', '/api/v1/sandbox/engines'],
      ['GET', '/api/v1/sandbox/history'],
      ['GET', '/api/v1/sandbox/logs'],
    ] as const) {
      const r = await req(live, method, url);
      assert.equal(r.status, 401, `${method} ${url} 应 401，实际 ${r.status}`);
      assert.equal(
        ((r.body.error as Record<string, string>) ?? {}).code,
        'E_UNAUTHENTICATED',
      );
    }
  } finally {
    await live.built.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ③ 建会话 + 真跑 SQL（真 worker + 真 SQLite）
// ═══════════════════════════════════════════════════════════════════════

test('★ 建会话 → 真跑 SQL → 结果/列/行数具体值断言（真 worker 真 SQLite）', async () => {
  const live = await listen(await makeApp());
  try {
    const admin = await login(live, 'admin', ADMIN_PASS);
    await createUser(live, admin, 'stu-a', ['student']);
    const stu = await login(live, 'stu-a', 'pass-12345');

    // 数据集列表（真探测）
    const ds = await req(live, 'GET', '/api/v1/sandbox/datasets', { cookie: stu });
    assert.equal(ds.status, 200, JSON.stringify(ds.body));
    const ids = (ds.body.datasets as { id: string }[]).map((d) => d.id);
    assert.ok(ids.includes('sc'), `数据集应含 sc，实际 ${ids.join(',')}`);
    assert.ok(ids.includes('employees'));
    assert.ok(ids.includes('orders'));

    // 建会话
    const sess = await req(live, 'POST', '/api/v1/sandbox/session', { cookie: stu, body: { dataset: 'sc' } });
    assert.equal(sess.status, 200, JSON.stringify(sess.body));
    const sessionId = String(sess.body.sessionId);
    assert.match(sessionId, /^s_/);
    assert.equal(ownerOfSession(sessionId), live.built.deps.repo.rbac.getUserRowByName('stu-a')?.id);
    assert.equal(sess.body.engine, 'sqlite');
    const schema = sess.body.schema as { tables: { name: string; rows: number }[] };
    assert.deepEqual(
      schema.tables.map((t) => t.name).sort(),
      ['courses', 'enrollments', 'students'],
      'sc 数据集应是 students/courses/enrollments',
    );
    const studentsRows = schema.tables.find((t) => t.name === 'students')?.rows;
    assert.ok(typeof studentsRows === 'number' && studentsRows > 0, 'schema 必须报 students 行数');

    // 真跑 SQL
    const q1 = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, sql: 'SELECT sname, grade FROM enrollments e JOIN students s ON s.sid = e.sid ORDER BY sname LIMIT 3' },
    });
    assert.equal(q1.status, 200, JSON.stringify(q1.body));
    assert.equal(q1.body.ok, true, JSON.stringify(q1.body.error ?? q1.body).slice(0, 600));
    assert.deepEqual(q1.body.columns, ['sname', 'grade']);
    assert.equal(q1.body.rowCount, 3);
    assert.equal((q1.body.rows as unknown[][]).length, 3);
    // 真数据集 + 真 SQLite 排序：`ORDER BY sname` 首行是「周八」（SQLite 对中文按码点排，不是拼音）
    assert.equal((q1.body.rows as unknown[][])[0]?.[0], '周八');
    for (const row of q1.body.rows as unknown[][]) {
      assert.equal(typeof row[0], 'string');
      assert.ok(typeof row[1] === 'number' || row[1] === null, 'grade 是 REAL 或 NULL（数据集含 NULL 成绩）');
    }
    assert.equal(q1.body.statementKind, 'SELECT');
    assert.equal(q1.body.engine, 'sqlite');
    assert.equal(q1.body.error, undefined, '成功时不许有 error 字段');

    // 聚合（真算）—— 与 schema 报的行数**自洽**（不写死魔法数字，数据集改了也不会假红）
    const q2 = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, sql: 'SELECT COUNT(*) AS n FROM students' },
    });
    assert.deepEqual(q2.body.rows, [[studentsRows]], 'COUNT(*) 必须等于 schema 报的 students 行数');

    // 写操作（学生要能建表插数据）+ 事务
    const w = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, sql: 'CREATE TABLE my_t(id INTEGER PRIMARY KEY, note TEXT)' },
    });
    assert.equal(w.status, 200);
    assert.equal(w.body.ok, true, JSON.stringify(w.body));
    const ins = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, sql: "INSERT INTO my_t(id, note) VALUES (1, '我的实验表')" },
    });
    assert.equal(ins.body.ok, true, JSON.stringify(ins.body));
    // 跨请求持久化（同一库文件）
    const sel = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, sql: 'SELECT note FROM my_t WHERE id = 1' },
    });
    assert.deepEqual(sel.body.rows, [['我的实验表']]);

    // schema 反映新表（与执行同源）
    const sch = await req(live, 'GET', `/api/v1/sandbox/schema?sessionId=${sessionId}`, { cookie: stu });
    assert.equal(sch.status, 200);
    assert.ok((sch.body.tables as { name: string }[]).some((t) => t.name === 'my_t'));

    // 历史（隔离：worker 侧核对 request_user_id）
    const hist = await req(live, 'GET', `/api/v1/sandbox/history?sessionId=${sessionId}`, { cookie: stu });
    assert.equal(hist.status, 200, JSON.stringify(hist.body).slice(0, 200));
    assert.ok((hist.body.entries as unknown[]).length >= 3, '历史应记录刚才几条');

    // reset → 真重置（先 DROP 所有用户表再重建数据集）
    const reset = await req(live, 'POST', '/api/v1/sandbox/reset', { cookie: stu, body: { sessionId } });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.reset, true);
    const after = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='my_t'" },
    });
    assert.deepEqual(after.body.rows, [], 'reset 后自建表必须消失');
  } finally {
    await live.built.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ④ ★ 学生 SQL 错误 → 200 + ok:false（**不是 500**）
// ═══════════════════════════════════════════════════════════════════════

test('★ 学生 SQL 写错 → HTTP 200 + ok:false + 引擎原文 + who=student（不是 500）', async () => {
  const live = await listen(await makeApp());
  try {
    const admin = await login(live, 'admin', ADMIN_PASS);
    await createUser(live, admin, 'stu-err', ['student']);
    const stu = await login(live, 'stu-err', 'pass-12345');
    const sess = await req(live, 'POST', '/api/v1/sandbox/session', { cookie: stu, body: {} });
    const sessionId = String(sess.body.sessionId);

    // ① 语法错
    const r1 = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, sql: 'SELEC * FROM students' },
    });
    assert.equal(r1.status, 200, '★ 学生写错 SQL 必须 200（请求成功、SQL 失败），不能是 500');
    assert.equal(r1.body.ok, false);
    const e1 = r1.body.error as Record<string, unknown>;
    assert.equal(e1.code, 'E_SQL_SYNTAX');
    assert.match(String(e1.message), /near "SELEC": syntax error/, '引擎原文必须一字不改');
    assert.equal(e1.who, 'student', '语法错是学生的锅');
    assert.equal(e1.who_source, 'classifier');
    assert.ok(String(e1.hint).length > 0, '必须有可读 hint');
    assert.ok(String(e1.localReading).length > 0, '本地解读（模型不可用也能降级）');

    // ② 对象不存在（表名写错）—— 学生最常遇到
    const r2 = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, sql: 'SELECT * FROM student' },
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.ok, false);
    assert.equal((r2.body.error as Record<string, unknown>).who, 'student');
    assert.match(String((r2.body.error as Record<string, unknown>).message), /no such table/);

    // ③ 运行时错（约束冲突）
    const r3 = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, sql: 'INSERT INTO courses(cid, cname, credits) VALUES (1, NULL, 3)' },
    });
    assert.equal(r3.status, 200);
    assert.equal(r3.body.ok, false, JSON.stringify(r3.body));
    assert.equal((r3.body.error as Record<string, unknown>).who, 'student');

    // ④ 规则拒绝：多语句 / ATTACH / load_extension → 200 且 who='rules'（**不是学生的 SQL 写错**）
    for (const [sql, code] of [
      ['SELECT 1; SELECT 2', 'E_SQL_MULTI'],
      ["ATTACH DATABASE 'other.db' AS other", 'E_SQL_FORBIDDEN'],
      ["SELECT load_extension('x')", 'E_SQL_FORBIDDEN'],
    ] as const) {
      const r = await req(live, 'POST', '/api/v1/sandbox/execute', { cookie: stu, body: { sessionId, sql } });
      assert.equal(r.status, 200, `${sql} 应 200`);
      assert.equal(r.body.ok, false, `${sql} 应 ok:false`);
      const e = r.body.error as Record<string, unknown>;
      assert.equal(e.code, code, `${sql} 错误码`);
      assert.equal(e.who, 'rules', `${sql} 的责任方应是"沙箱规则"而不是"学生写错 SQL"`);
      assert.equal((r.body.rows as unknown[]).length, 0);
    }

    // ⑤ 服务仍然健康（报错不该把服务搞坏）
    assert.equal((await req(live, 'GET', '/api/v1/health')).status, 200);
  } finally {
    await live.built.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ⑤ ★ 跨用户隔离（负例）
// ═══════════════════════════════════════════════════════════════════════

test('★ 拿别人的 sessionId 执行/读 schema → 403（每个学生独立库）', async () => {
  const live = await listen(await makeApp());
  try {
    const admin = await login(live, 'admin', ADMIN_PASS);
    await createUser(live, admin, 'stu-x', ['student']);
    await createUser(live, admin, 'stu-y', ['student']);
    const x = await login(live, 'stu-x', 'pass-12345');
    const y = await login(live, 'stu-y', 'pass-12345');

    const sessX = await req(live, 'POST', '/api/v1/sandbox/session', { cookie: x, body: {} });
    const sidX = String(sessX.body.sessionId);
    // x 建一张带私密数据的表（**两条语句分两次发**：默认单语句闸，`;` 拼接会被 E_SQL_MULTI 拒）
    const mk = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: x,
      body: { sessionId: sidX, sql: 'CREATE TABLE secret(v TEXT)' },
    });
    assert.equal(mk.body.ok, true, JSON.stringify(mk.body));
    const put = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: x,
      body: { sessionId: sidX, sql: "INSERT INTO secret(v) VALUES ('x 的私密数据')" },
    });
    assert.equal(put.body.ok, true, JSON.stringify(put.body));

    // ★ y 拿 x 的 sessionId → 403（不是 200、不是 404 空数据）
    for (const [method, url, body] of [
      ['POST', '/api/v1/sandbox/execute', { sessionId: sidX, sql: 'SELECT * FROM secret' }],
      ['POST', '/api/v1/sandbox/reset', { sessionId: sidX }],
      ['POST', '/api/v1/sandbox/session', { sessionId: sidX }],
    ] as const) {
      const r = await req(live, method, url, { cookie: y, body });
      assert.equal(r.status, 403, `${method} ${url} 跨用户应 403，实际 ${r.status}`);
      assert.equal(((r.body.error as Record<string, string>) ?? {}).code, 'E_FORBIDDEN');
    }
    for (const url of [
      `/api/v1/sandbox/schema?sessionId=${sidX}`,
      `/api/v1/sandbox/history?sessionId=${sidX}`,
      `/api/v1/sandbox/logs?sessionId=${sidX}`,
    ]) {
      const r = await req(live, 'GET', url, { cookie: y });
      assert.equal(r.status, 403, `GET ${url} 跨用户应 403，实际 ${r.status}`);
    }

    // y 自己的会话里**看不到** x 的表（真隔离，不只是入口拦）
    const sessY = await req(live, 'POST', '/api/v1/sandbox/session', { cookie: y, body: {} });
    const sidY = String(sessY.body.sessionId);
    assert.notEqual(sidY, sidX, '两人必须拿到不同的 sessionId');
    const yTables = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: y,
      body: { sessionId: sidY, sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='secret'" },
    });
    assert.deepEqual(yTables.body.rows, [], 'y 的库里不该有 x 的表');
    // 而且 x 的数据还在（y 没有把别人的库搞坏）
    const xStill = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: x,
      body: { sessionId: sidX, sql: 'SELECT v FROM secret' },
    });
    assert.deepEqual(xStill.body.rows, [['x 的私密数据']]);
  } finally {
    await live.built.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ⑥ ★ 长查询不阻塞服务（真跑递归死循环，被杀 + /health 仍 200）
// ═══════════════════════════════════════════════════════════════════════

test('★ 真跑 WITH RECURSIVE 死循环 → 超时被杀；**服务不阻塞**（/health 仍 200）', async () => {
  const live = await listen(await makeApp());
  try {
    const admin = await login(live, 'admin', ADMIN_PASS);
    await createUser(live, admin, 'stu-slow', ['student']);
    const stu = await login(live, 'stu-slow', 'pass-12345');
    const sess = await req(live, 'POST', '/api/v1/sandbox/session', { cookie: stu, body: {} });
    const sessionId = String(sess.body.sessionId);

    const t0 = Date.now();
    // 同时并发打 /health：若执行在 Node 主线程跑，health 会被卡住
    const healthProbe = (async () => {
      const res: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        const s = Date.now();
        const r = await req(live, 'GET', '/api/v1/health');
        res.push(r.status);
        assert.ok(Date.now() - s < 2000, `health 第 ${i + 1} 次耗时 ${Date.now() - s}ms（被长查询阻塞了？）`);
        await new Promise((r2) => setTimeout(r2, 40));
      }
      return res;
    })();

    const slow = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: {
        sessionId,
        sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT COUNT(*) FROM c',
        timeoutMs: 800,
      },
    });
    const elapsed = Date.now() - t0;
    const healthStatuses = await healthProbe;

    assert.equal(healthStatuses.every((s) => s === 200), true, '长查询期间 /health 必须仍 200');
    assert.equal(slow.status, 200, `超时也应 200（是"这条 SQL 失败"）：${JSON.stringify(slow.body).slice(0, 200)}`);
    assert.equal(slow.body.ok, false);
    const e = slow.body.error as Record<string, unknown>;
    assert.equal(e.code, 'E_SQL_TIMEOUT');
    assert.equal(e.who, 'student_logic', '★ 超时是"查询逻辑"问题，不是语法错（话术不同）');
    assert.ok(['progress', 'process'].includes(String(slow.body.killedBy)), `killedBy=${slow.body.killedBy}`);
    // ★ hardKilled 与 killedBy 必须自洽（backend-core 的断言在我们这层也要成立）
    if (slow.body.killedBy === 'progress') assert.equal(slow.body.hardKilled, false);
    if (slow.body.killedBy === 'process') assert.equal(slow.body.hardKilled, true);
    assert.ok(String(e.hint).length > 0);
    assert.ok(elapsed < 30_000, `应在超时后尽快返回，实际 ${elapsed}ms`);

    // 超时后还能继续用（不是把会话搞死）
    const after = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, sql: 'SELECT 1 AS ok' },
    });
    assert.equal(after.body.ok, true, '超时后同一会话仍可执行');
    // 历史里能看到被杀的记录（学生与答疑都能复盘"为什么被停"）
    const hist = await req(live, 'GET', `/api/v1/sandbox/history?sessionId=${sessionId}&limit=5`, { cookie: stu });
    assert.ok(
      (hist.body.entries as Record<string, unknown>[]).some((h) => String(h.error ?? '').includes('E_SQL_TIMEOUT')),
      '历史必须记录超时条目',
    );
  } finally {
    await live.built.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ⑦ ★ 事务语义（critical 发现 → 纵深防御闸 + 单次调用可用）
// ═══════════════════════════════════════════════════════════════════════

test('闸的判定逻辑（纯函数）：worker 说支持 → 自动放开；说不支持/探测不到 → 保持拦截（fail-safe）', () => {
  // worker 明确支持跨调用事务 → 闸自动放开（将来接会话级事务时零改动）
  assert.equal(shouldGuardCrossCallTx(true, true), false);
  // worker 说不支持 → 拦截
  assert.equal(shouldGuardCrossCallTx(true, false), true);
  // 探测不到（worker 挂了/形状不认识）→ **保持拦截**（宁可多说一句，也不说谎）
  assert.equal(shouldGuardCrossCallTx(true, null), true);
  // 总开关关闭 → 一律不拦
  assert.equal(shouldGuardCrossCallTx(false, false), false);

  // 结构化能力报告的解析（新形状 + 旧布尔形状兼容）
  assert.equal(
    readCrossCallTx({ engines: [{ id: 'sqlite', capabilities: { transactions: { same_call: true, cross_call: false } } }] }),
    false,
  );
  assert.equal(
    readCrossCallTx({ engines: [{ id: 'sqlite', capabilities: { transactions: { cross_call: true } } }] }),
    true,
  );
  assert.equal(readCrossCallTx({ engines: [{ id: 'sqlite', capabilities: { transactions: true } }] }), true);
  assert.equal(readCrossCallTx({ engines: [{ id: 'sqlite', capabilities: {} }] }), null);
  assert.equal(readCrossCallTx({ engines: [] }), null);
  assert.equal(readCrossCallTx(null), null);

  // 词法判定：只认"整条语句就是事务控制"，批次（multi）与普通 SQL 都不算
  for (const sql of ['BEGIN', 'begin transaction', 'COMMIT', 'ROLLBACK', 'SAVEPOINT sp1', 'RELEASE sp1', ' COMMIT ; ']) {
    assert.equal(isCrossCallTxControl(sql), true, `${sql} 应判定为事务控制语句`);
  }
  for (const sql of [
    'BEGIN; INSERT INTO t VALUES (1); ROLLBACK;', // 批次 → 不拦（交给 multi）
    'SELECT * FROM tx',
    'INSERT INTO tx VALUES (1)',
    'CREATE TABLE tx(id INT)',
  ]) {
    assert.equal(isCrossCallTxControl(sql), false, `${sql} 不应被判定为事务控制语句`);
  }
});

test('★ 跨调用事务：单发 BEGIN/COMMIT/ROLLBACK → **如实拒绝**（不再返回假的 ok:true）', async () => {  const live = await listen(await makeApp());
  try {
    const admin = await login(live, 'admin', ADMIN_PASS);
    await createUser(live, admin, 'stu-tx', ['student']);
    const stu = await login(live, 'stu-tx', 'pass-12345');
    const sess = await req(live, 'POST', '/api/v1/sandbox/session', { cookie: stu, body: {} });
    const sessionId = String(sess.body.sessionId);
    await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, sql: 'CREATE TABLE tx(id INTEGER PRIMARY KEY, v TEXT)' },
    });
    await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, sql: "INSERT INTO tx VALUES (1,'base')" },
    });

    // ① 单发事务控制语句 → 200 + ok:false + 说明"是沙箱能力限制，不是你 SQL 写错"
    for (const sql of ['BEGIN', 'BEGIN TRANSACTION', 'COMMIT', 'ROLLBACK', 'SAVEPOINT sp1', 'RELEASE sp1']) {
      const r = await req(live, 'POST', '/api/v1/sandbox/execute', { cookie: stu, body: { sessionId, sql } });
      assert.equal(r.status, 200, `${sql} 应 200（是"这条语句不被支持"，不是请求错）`);
      assert.equal(r.body.ok, false, `★ ${sql} 不许返回 ok:true（旧行为是假的成功）`);
      const e = r.body.error as Record<string, unknown>;
      assert.equal(e.code, 'E_SQL_UNSUPPORTED', `${sql} 错误码`);
      assert.equal(e.who, 'rules', `${sql} 责任方 = 沙箱能力限制（不是学生写错）`);
      assert.match(String(e.hint), /multi/, `${sql} 必须指出可用路径（multi:true）`);
      assert.match(String(e.hint), /独立进程/, `${sql} hint 必须解释"为什么"（安全前提），不是"能力缺失"`);
      assert.equal(e.defense_in_depth, true, '标明这是纵深防御（worker 侧也已拒绝）');
      assert.equal(e.interim, false, '★ 口径：不再是"过渡期"（worker 已同样拒绝）—— 显式 false，不是缺字段');
    }

    // ② 数据没有被"假回滚"骗到（我们根本没执行任何写）
    const after = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, sql: 'SELECT COUNT(*) FROM tx' },
    });
    assert.deepEqual(after.body.rows, [[1]]);

    // ③ ★ 真正可用的路径：单次调用 + multi:true（同进程同连接）→ 回滚**真的生效**
    const rb = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, multi: true, sql: "BEGIN; INSERT INTO tx VALUES (2,'rollback_me'); ROLLBACK;" },
    });
    assert.equal(rb.status, 200);
    assert.equal(rb.body.ok, true, JSON.stringify(rb.body.error ?? rb.body).slice(0, 300));
    const afterRb = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, sql: 'SELECT COUNT(*) FROM tx' },
    });
    assert.deepEqual(afterRb.body.rows, [[1]], '★ multi 事务里的 ROLLBACK 必须真的回滚（行数不变）');

    // ④ 同一路径的 COMMIT 也要真的提交
    const cm = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, multi: true, sql: "BEGIN; INSERT INTO tx VALUES (3,'commit_me'); COMMIT;" },
    });
    assert.equal(cm.body.ok, true, JSON.stringify(cm.body.error ?? cm.body).slice(0, 300));
    const afterCm = await req(live, 'POST', '/api/v1/sandbox/execute', {
      cookie: stu,
      body: { sessionId, sql: 'SELECT COUNT(*) FROM tx' },
    });
    assert.deepEqual(afterCm.body.rows, [[2]], '★ multi 事务里的 COMMIT 必须真的提交（行数 +1）');
  } finally {
    await live.built.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ⑧ 调用方错误 / 引擎能力
// ═══════════════════════════════════════════════════════════════════════

test('缺 sql / 缺 sessionId → 400；引擎能力段如实报（sqlite 可用，MySQL/openGauss 不可用带 reason）', async () => {
  const live = await listen(await makeApp());
  try {
    const admin = await login(live, 'admin', ADMIN_PASS);
    await createUser(live, admin, 'stu-bad', ['student']);
    const stu = await login(live, 'stu-bad', 'pass-12345');

    const noSql = await req(live, 'POST', '/api/v1/sandbox/execute', { cookie: stu, body: { sql: '   ' } });
    assert.equal(noSql.status, 400);
    assert.equal(((noSql.body.error as Record<string, string>) ?? {}).code, 'E_BADREQUEST');

    // 省略 sessionId → 用服务端推导的默认会话（可用）
    const auto = await req(live, 'POST', '/api/v1/sandbox/execute', { cookie: stu, body: { sql: 'SELECT 1' } });
    assert.equal(auto.status, 200);
    assert.equal(auto.body.ok, true);
    assert.match(String(auto.body.sessionId), /^s_/);

    const engines = await req(live, 'GET', '/api/v1/sandbox/engines', { cookie: stu });
    assert.equal(engines.status, 200);
    assert.equal(engines.body.defaultEngine, 'sqlite');
    const list = engines.body.engines as { id: string; available: boolean; reason?: string }[];
    const sqlite = list.find((e) => e.id === 'sqlite');
    assert.equal(sqlite?.available, true, 'SQLite 是嵌入式引擎，必须永远可用');
    for (const e of list.filter((x) => !x.available)) {
      assert.ok(String(e.reason ?? '').length > 0, `${e.id} 不可用必须给可读 reason`);
    }
    assert.ok(list.some((e) => e.id === 'mysql' && !e.available), 'MySQL 未部署 → 必须如实不可用');
  } finally {
    await live.built.close();
  }
});

test('/capabilities 的 sandbox 段：真探测（engine 可用 + 逐引擎原因）', async () => {
  const live = await listen(await makeApp());
  try {
    const caps = await req(live, 'GET', '/api/v1/capabilities?deep=0');
    assert.equal(caps.status, 200);
    const seg = caps.body.sandbox as Record<string, unknown>;
    assert.ok(seg, '必须有 sandbox 段');
    assert.equal(seg.defaultEngine, 'sqlite');
    assert.equal(seg.available, true, JSON.stringify(seg).slice(0, 200));
    assert.ok((seg.engines as unknown[]).length >= 4, '应逐引擎上报（sqlite/mysql/postgres/opengauss）');
    // ★ 临时诚实标注（Lead 裁定）：不许让 /capabilities 宣称"支持事务"而不说清是**同次执行内**
    assert.equal(seg.transactions_cross_call, false, '必须如实标注"跨调用事务不支持"');
    assert.match(String(seg.transactions_note), /独立进程/);
    assert.match(String(seg.transactions_note), /multi:true/);

    // ★ 对话模式自述（Lead 裁定）：前端据此渲染模式选择器，**不按 roles 推断**
    const cm = caps.body.chat_modes as Record<string, unknown>;
    assert.ok(cm, '必须有 chat_modes 段');
    assert.deepEqual(cm.modes, ['chat', 'agent'], '必须如实列出两种模式');
    assert.equal(cm.default, 'chat', '默认必须是 chat（无工具）');
    assert.deepEqual(cm.tools, { chat: [], agent: ['kb_search', 'kb_get'] }, '各模式的工具必须如实列出');
    assert.deepEqual(
      (cm.allowed_roles as Record<string, string[]>).agent,
      ['admin', 'teacher', 'student'],
      '★ agent 允许的角色必须含 student（Lead 裁定：答疑的主体是学生，只读工具风险画像不同）',
    );
    const kbSeg = cm.kb as Record<string, unknown>;
    assert.equal(kbSeg.available, true, '只读知识库查询必须已接入（否则 agent 模式会降级）');
    assert.equal(kbSeg.readonly, true, '★ 必须如实标"只读"');
    assert.equal(kbSeg.scoped_by, 'userId', '★ 必须说明按 userId 过滤可见性');
  } finally {
    await live.built.close();
  }
});
