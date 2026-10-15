/**
 * ★★ **聊天会话 IDOR 守卫**（安全回归测试）。
 *
 * ## 缺陷（修复前）
 * WS 握手只校验"已登录"，**没有校验"这个 sessionId 属于你"**；pi 转录在共享目录
 * `data/chat/` 按 `<ISO>_<sessionId>.jsonl` 找 ⟹ **A 知道/猜到 B 的 sessionId 就能读 B 的历史、
 * 以 B 的身份继续对话**（B 的知识库可见性、笔记都会生效）。
 *
 * ## 判据（Lead 指定 + 独立验收 `polysemy-prober` 补两条）
 * 1. A 连 B 的 id → **拒绝**
 * 2. ★ **"别人的 id"与"不存在的 id"对外必须**不可区分**（同一 code + 同一 msg）**
 *    —— 原实现"无行就认领"使"不存在的 id → ready"，成了**存在性预言机**（已撤掉）
 * 3. ★ **抢注不可能**：攻击者连**未登记**的 id 必须失败（不能"先到先得"把别人锁在外面）
 * 4. 已登记且属于我 → 放行；未登记 → 拒绝（前端须先 `POST /api/v1/conversations`）
 * 5. 归属行是**唯一真相源**（直接改库 → 判定立刻变，不是缓存结论）
 * 6. ★ **真 WS 端到端**（不是单测 —— 这类洞只有真路径能抓到），且**零 LLM 调用**
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { buildApp } from '../src/index.ts';
import { loadConfig } from '../src/config.ts';
import { SESSION_DENIED_REASON, checkSessionOwner } from '../src/store/chat-session-owner.ts';

/** `ws` 没有类型声明（不装 @types/ws）→ 用 `createRequire` 拿 `any`，只声明用到的形状。 */
interface WsClientLike {
  on(event: 'message', cb: (d: Buffer) => void): void;
  on(event: 'close', cb: (code: number) => void): void;
  on(event: 'error', cb: (e: unknown) => void): void;
  close(): void;
}
const wsRequire = createRequire(import.meta.url);
function wsClient(url: string, headers: Record<string, string>): WsClientLike {
  const Ctor = (wsRequire('ws') as { WebSocket: new (u: string, o: { headers: Record<string, string> }) => WsClientLike }).WebSocket;
  return new Ctor(url, { headers });
}

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
let tmp = '';
let built: Awaited<ReturnType<typeof buildApp>> | null = null;
let aId = '';
let bId = '';
let bobCookie = '';

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idor-'));
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DB: path.join(tmp, 't.sqlite3'),
      COURSE_KB_DATA_DIR: path.join(tmp, 'data'),
      COURSE_KB_SETTINGS_FILE: path.join(tmp, 'settings.json'),
      COURSE_KB_BOOTSTRAP_ADMIN: 'admin:idor-pass-0001',
    } as Record<string, string>,
  });
  built = await buildApp({ cfg });
  const rbac = built.deps.repo.rbac;
  const { hashPassword } = await import('../src/auth/password.ts');
  aId = rbac.createUser({ username: 'alice', displayName: 'Alice', passwordHash: 'x', roles: ['student'] });
  bId = rbac.createUser({
    username: 'bob',
    displayName: 'Bob',
    passwordHash: await hashPassword('bob-pass-0001'),
    roles: ['student'],
  });

  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('取不到端口');
  const login = await fetch(`http://127.0.0.1:${addr.port}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: 'bob-pass-0001' }),
  });
  bobCookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.ok(bobCookie, `bob 必须能登录（实际 HTTP ${login.status}）`);
});

after(async () => {
  try {
    if (built) await built.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows 偶发占用 */
  }
});

const check = (sessionId: string, userId: string) =>
  checkSessionOwner({ repo: built!.deps.repo, root: ROOT, sessionId, userId });
const register = (sessionId: string, userId: string) =>
  built!.deps.repo.rbac.claimConversation({ id: sessionId, userId });

test('★ 未登记的 id → **拒绝**（不存在与别人的**同一句话** —— 无存在性预言机）', () => {
  const unknown = check('never-registered', aId);
  assert.equal(unknown.ok, false, '★ 未登记必须拒绝（原实现会"认领"→ 存在性预言机 + 抢注）');
  assert.equal((unknown as { reason: string }).reason, SESSION_DENIED_REASON);
});

test('★ 已登记且属于我 → 放行；登记后**立刻**生效（归属行是唯一真相源）', () => {
  register('alice-sess', aId);
  assert.deepEqual(check('alice-sess', aId), { ok: true, created: false }, '登记后 alice 应放行');
  // ★ 直接改库 → 判定立刻跟着变（不是缓存出来的结论）
  built!.deps.repo.db.run('UPDATE conversations SET user_id = ? WHERE id = ?', bId, 'alice-sess');
  assert.equal(check('alice-sess', aId).ok, false, '★ 归属改成 bob 后 alice 必须被拒');
  assert.equal(check('alice-sess', bId).ok, true, 'bob 现在是 owner');
  built!.deps.repo.db.run('UPDATE conversations SET user_id = ? WHERE id = ?', aId, 'alice-sess');
});

test('★★ 跨用户：B 连 A 的会话 → 拒绝，且理由与"未登记"**逐字相同**', () => {
  const stolen = check('alice-sess', bId);
  const unknown = check('totally-unknown-id', bId);
  assert.equal(stolen.ok, false, '★ 跨用户必须被拒（这就是 IDOR 的正面）');
  assert.equal(
    (stolen as { reason: string }).reason,
    (unknown as { reason: string }).reason,
    '★ "别人的会话"与"不存在的会话"必须给出**完全相同**的理由',
  );
  assert.equal((stolen as { reason: string }).reason, SESSION_DENIED_REASON);
});

test('★ 抢注不可能：攻击者连未登记 id 失败（不能"先到先得"锁住别人）', () => {
  const attacker = check('victim-will-use-this', bId);
  assert.equal(attacker.ok, false, '★ 未登记 id 对任何人都不放行 → 抢注路径不存在');
  register('victim-will-use-this', aId);
  assert.equal(check('victim-will-use-this', aId).ok, true, '合法用户登记后可用');
  assert.equal(check('victim-will-use-this', bId).ok, false, '攻击者仍被拒（受害者没被锁在外面）');
});

/** 真 WS：返回 `{code, msg, raw}` —— 用于断言两类 id 的**可观测结果不可区分**。 */
async function handshake(sessionId: string, cookie: string): Promise<{ code: number | null; msg: string; raw: string }> {
  const addr = built!.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('取不到端口');
  const frames: string[] = [];
  const ws = wsClient(`ws://127.0.0.1:${addr.port}/api/v1/chat/${sessionId}`, { cookie });
  const r = await new Promise<{ code: number | null }>((resolve) => {
    ws.on('message', (d: Buffer) => frames.push(String(d)));
    ws.on('close', (code: number) => resolve({ code }));
    ws.on('error', () => resolve({ code: null }));
    setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({ code: null });
    }, 2500);
  });
  const first = frames.find((f) => f.includes('"error"')) ?? frames[0] ?? '';
  let msg = '';
  try {
    msg = String((JSON.parse(first) as { msg?: string }).msg ?? '');
  } catch {
    /* 非 JSON（如 ready 帧）→ msg 留空 */
  }
  return { code: r.code, msg, raw: first.slice(0, 140) };
}

test('★★ 真 WS：跨用户连接被拒（1008 + 统一理由），零 LLM 调用', async () => {
  const r = await handshake('alice-sess', bobCookie);
  assert.equal(r.msg, SESSION_DENIED_REASON, `★ 真路径也必须给统一理由，实际 raw=${r.raw}`);
  assert.equal(r.code, 1008, `★ 必须以 1008 关闭，实际 ${r.code}`);
});

test('★★ 真 WS：**"别人的 id"与"不存在的 id"可观测结果必须不可区分**（判据 2）', async () => {
  const others = await handshake('alice-sess', bobCookie);
  const unknown = await handshake('no-such-session-xyz', bobCookie);
  assert.deepEqual(
    [others.code, others.msg],
    [unknown.code, unknown.msg],
    `★ 两类 id 必须不可区分（别人的 code=${others.code} msg=${others.msg} / 不存在的 code=${unknown.code} msg=${unknown.msg}）`,
  );
  assert.equal(others.msg, SESSION_DENIED_REASON);
});

test('★ 真 WS：**已登记且属于我** → 放行（证明不是"一律拒绝"）', async () => {
  register('bob-sess', bId);
  const r = await handshake('bob-sess', bobCookie);
  assert.notEqual(r.msg, SESSION_DENIED_REASON, `★ 自己的会话不许被拒（否则是"一律拒绝"而非归属校验）：${r.raw}`);
});
