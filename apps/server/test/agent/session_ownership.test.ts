/**
 * 🔴 跨用户读取防护：**会话归属登记**（agent 层兜底）。
 *
 * ## 漏洞（已核实，今天就可利用 —— 不需要等下 `history` 帧）
 * 会话 key 是**客户端自选的 URL 片段**，**不含用户信息**，服务端此前**没有任何归属校验**：
 * ```
 * routes/chat.ts:133   const { sessionId } = req.params   ← 客户端自选，原样使用
 * routes/chat.ts:260   createChatConnection({ sessionId, … })  ← 只做 401 + agent 角色判定
 * agent 层 grep owner|claim|归属 → 0 处
 * sandbox/ask.ts:1197  getOrCreate(askSessionKey(sessionId))   ← 连身份都不带
 * 真实文件名：2026-10-14T13-29-05-709Z_probe-real-run.jsonl   ← key 段任意
 * ```
 * ⟹ 任何已登录用户只要知道/猜到别人的 key，就能续上别人的上下文：
 * **聊天** = 让模型复述别人的对话；**答疑** = 拿到别人的 SQL 与报错（**作业内容**，更敏感）。
 *
 * ## 本文件钉住的 4 条（lead 批准）
 * 1. 已登记 + 同用户 → **放行**（★ 不能把正常流程关死）
 * 2. 已登记 + 不同用户 → **拒**
 * 3. 已登记 + 无身份 → **拒**（不能靠"不给身份"绕过）
 * 4. 未登记 + **有历史文件** → **拒**（★ 最关键：老会话文件都在，不拒等于没修）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSessionManager, SessionOwnershipError } from '../../src/agent/session.ts';
import { FakePiSession } from './helpers/fakes.ts';
import type { SdkLoadResult } from '../../src/agent/sdk.ts';

function fakeSdk(): SdkLoadResult {
  return {
    available: true,
    createAgentSession: (async () => ({ session: new FakePiSession({ sessionFile: null, persistence: 'ephemeral' }) as never })) as never,
    SessionManager: {
      create: () => ({ getEntries: () => [], getSessionId: () => 'pi-1', getSessionFile: () => undefined }),
      inMemory: () => ({ getEntries: () => [], getSessionId: () => 'pi-1', getSessionFile: () => undefined }),
      open: () => ({ getEntries: () => [], getSessionId: () => 'pi-1', getSessionFile: () => undefined }),
    } as never,
    version: '1.2.0',
    loadMs: 1,
    specifier: 'fake',
  };
}

/** 建一个"有历史文件但没有归属登记"的老会话（漏洞场景） */
function makeLegacySessionFile(dir: string, key: string): string {
  const file = join(dir, `2026-01-01T00-00-00-000Z_${key}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'session', id: 'pi-legacy', timestamp: 1 })}\n` +
      `${JSON.stringify({ type: 'message', timestamp: 2, message: { role: 'user', content: [{ type: 'text', text: '别人的作业内容' }] } })}\n`,
    'utf8',
  );
  return file;
}

function newManager(dir: string | null): AgentSessionManager {
  return new AgentSessionManager({
    sessionDir: dir,
    persist: dir !== null,
    sdkLoader: async () => fakeSdk(),
  });
}

test('★ ① 同用户重连必须**继续成功**（不能把正常流程关死）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'own-'));
  try {
    const m = newManager(dir);
    const first = await m.getOrCreate('s-1', { userId: 'u_A' });
    assert.ok(first);
    m.closeAll();
    // 同一用户重连（新管理器 = 模拟重启，验证持久化后仍放行）
    const m2 = newManager(dir);
    const again = await m2.getOrCreate('s-1', { userId: 'u_A' });
    assert.ok(again, '同一用户必须仍能进入自己的会话');
    m2.closeAll();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ ② 不同用户 → **拒**（跨用户读取）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'own-'));
  try {
    const m = newManager(dir);
    await m.getOrCreate('s-2', { userId: 'u_A' });
    await assert.rejects(
      () => m.getOrCreate('s-2', { userId: 'u_B' }),
      (err: unknown) => err instanceof SessionOwnershipError && /不符|归属/.test((err as Error).message),
      'B 不许进入 A 的会话',
    );
    m.closeAll();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ ②\u2019 **已建好的活会话**也不能绕过（复用路径上同样校验）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'own-'));
  try {
    const m = newManager(dir);
    await m.getOrCreate('s-2b', { userId: 'u_A' }); // 会话已在内存里
    await assert.rejects(() => m.getOrCreate('s-2b', { userId: 'u_B' }), SessionOwnershipError);
    // 原实现把归属检查放在"复用已有会话"之后 → 这里会直接返回 A 的活会话（等于没防）
    m.closeAll();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ ③ 无身份访问**已登记**会话 → 拒（不能靠"不给身份"绕过）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'own-'));
  try {
    const m = newManager(dir);
    await m.getOrCreate('s-3', { userId: 'u_A' });
    await assert.rejects(() => m.getOrCreate('s-3'), (err: unknown) => {
      assert.ok(err instanceof SessionOwnershipError);
      assert.match((err as Error).message, /没有提供身份/);
      return true;
    });
    m.closeAll();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★★ ④ 有历史文件但**无归属登记** → 拒（老会话都在，不拒 = 没修）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'own-'));
  try {
    const legacy = makeLegacySessionFile(dir, 'probe-real-run');
    assert.ok(existsSync(legacy));
    const m = newManager(dir);
    await assert.rejects(
      () => m.getOrCreate('probe-real-run', { userId: 'u_B' }),
      (err: unknown) => err instanceof SessionOwnershipError && /没有归属登记/.test((err as Error).message),
      '★ 任何用户都不许直接打开"有历史但没登记"的会话（这正是漏洞的利用方式）',
    );
    m.closeAll();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ ④\u2019 老会话要沿用必须**显式** allowUnclaimed（迁移开关，并认领给当前用户）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'own-'));
  try {
    makeLegacySessionFile(dir, 'legacy-1');
    const m = newManager(dir);
    const s = await m.getOrCreate('legacy-1', { userId: 'u_A', allowUnclaimed: true });
    assert.ok(s, '显式认领后可用');
    m.closeAll();
    // 认领已持久化：此后 B 拿不到
    const m2 = newManager(dir);
    await assert.rejects(() => m2.getOrCreate('legacy-1', { userId: 'u_B' }), SessionOwnershipError);
    m2.closeAll();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 登记持久化：`_owners.json` 落盘且重启后仍生效', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'own-'));
  try {
    const m = newManager(dir);
    await m.getOrCreate('s-persist', { userId: 'u_A' });
    m.closeAll();
    const file = join(dir, '_owners.json');
    assert.ok(existsSync(file), '必须落盘（否则重启后登记丢失 = 防线失效）');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { owners: Record<string, string> };
    assert.equal(parsed.owners['s-persist'], 'u_A');
    const m2 = newManager(dir);
    await assert.rejects(() => m2.getOrCreate('s-persist', { userId: 'u_B' }), SessionOwnershipError);
    m2.closeAll();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 登记文件损坏 → 按未登记处理，**有历史的仍被拒**（不会因此放开）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'own-'));
  try {
    makeLegacySessionFile(dir, 'broken-1');
    writeFileSync(join(dir, '_owners.json'), '{ 这不是 JSON', 'utf8');
    const diags: string[] = [];
    const m = new AgentSessionManager({
      sessionDir: dir,
      sdkLoader: async () => fakeSdk(),
      onDiagnostic: (x) => diags.push(x),
    });
    await assert.rejects(() => m.getOrCreate('broken-1', { userId: 'u_B' }), SessionOwnershipError);
    assert.ok(diags.some((d) => d.includes('归属登记文件读取失败')), `应有可读诊断：${diags.join(' | ')}`);
    m.closeAll();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ 答疑路径同族：`ask-<沙箱id>` 换个人/匿名都拿不到（学生作业内容）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'own-'));
  try {
    const m = newManager(dir);
    // 学生 A 首问（ask.ts 现在会把学生身份传进来）
    await m.getOrCreate('ask-sb-1', { userId: 'u_studentA' });
    await assert.rejects(() => m.getOrCreate('ask-sb-1', { userId: 'u_studentB' }), SessionOwnershipError);
    await assert.rejects(() => m.getOrCreate('ask-sb-1'), SessionOwnershipError);
    m.closeAll();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 无身份 + 无历史（旧调用路径）仍放行 —— 不打断既有集成', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'own-'));
  try {
    const m = newManager(dir);
    const s = await m.getOrCreate('anon-new');
    assert.ok(s, '没身份又没历史时不拦（首次带身份访问时会认领）');
    // 之后带身份访问：因未登记且无历史 → 认领
    const s2 = await m.getOrCreate('anon-new', { userId: 'u_A' });
    assert.ok(s2);
    m.closeAll();
    const m2 = newManager(dir);
    await assert.rejects(() => m2.getOrCreate('anon-new', { userId: 'u_B' }), SessionOwnershipError);
    m2.closeAll();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 不持久化（sessionDir=null）时登记仅内存生效，机制仍在', async () => {
  const m = newManager(null);
  await m.getOrCreate('mem-1', { userId: 'u_A' });
  await assert.rejects(() => m.getOrCreate('mem-1', { userId: 'u_B' }), SessionOwnershipError);
  m.closeAll();
});
