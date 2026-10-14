/**
 * ★ `auth.json` 形状前置校验（backend-api 的四形状对照实验逼出来的）。
 *
 * 为什么值钱：形状错时 pi **不报错也不作答** —— 学生看到"就绪"然后永远转圈。
 * 实测（他们花了 4 次对照才定位）：
 * ```
 * {"amr":{"type":"api_key","key":"…"}}                  → ❌ 静默挂死（25s 零帧 → E_PI_TIMEOUT）
 * {"amr":{"type":"api_key","apiKey":"…"}}               → ❌ No API key found for amr
 * {"amr":"<key>"}                                        → ⚠️ 不报错但零内容
 * {"providers":{"amr":{"type":"api_key","key":"…"}}}    → ✅ 唯一可用
 * ```
 * 这里把"静默失败"变成"**建会话前就快速报错**"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSessionManager, checkAuthShape } from '../../src/agent/session.ts';

function dirWith(auth: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'authshape-'));
  if (auth !== null) writeFileSync(join(dir, 'auth.json'), auth, 'utf8');
  return dir;
}

test('★ 唯一可用形状（providers 包裹 + type/key）→ 通过', () => {
  const dir = dirWith(JSON.stringify({ providers: { amr: { type: 'api_key', key: 'sk-secret-value' } } }));
  try {
    const r = checkAuthShape(dir);
    assert.equal(r.ok, true, r.problem ?? '');
    assert.equal(r.problem, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ 缺少 providers 层（会静默挂死的形状）→ 拒绝，且理由可读', () => {
  const dir = dirWith(JSON.stringify({ amr: { type: 'api_key', key: 'sk-secret-value' } }));
  try {
    const r = checkAuthShape(dir);
    assert.equal(r.ok, false);
    assert.match(r.problem!, /缺少 `providers` 层/);
    assert.match(r.problem!, /静默挂死/, '要点明后果（否则别人不知道为什么要改）');
    assert.match(r.problem!, /需要这一形状/);
    assert.match(r.problem!, /amr/, '要说清发现的是哪个键');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 值是字符串（不报错但零内容）→ 拒绝', () => {
  const dir = dirWith(JSON.stringify({ providers: { amr: 'sk-secret-value' } }));
  try {
    const r = checkAuthShape(dir);
    assert.equal(r.ok, false);
    assert.match(r.problem!, /是字符串/);
    assert.match(r.problem!, /不产生任何内容/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 写成 apiKey 而不是 key → 拒绝，并指出"apiKey 不算"', () => {
  const dir = dirWith(JSON.stringify({ providers: { amr: { type: 'api_key', apiKey: 'sk-secret-value' } } }));
  try {
    const r = checkAuthShape(dir);
    assert.equal(r.ok, false);
    assert.match(r.problem!, /缺少 `key`/);
    assert.match(r.problem!, /apiKey.*不算|写成 `apiKey`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 缺 type → 拒绝', () => {
  const dir = dirWith(JSON.stringify({ providers: { amr: { key: 'sk-secret-value' } } }));
  try {
    assert.match(checkAuthShape(dir).problem!, /缺少 `type`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ JSON 坏了 / 顶层是数组 → 拒绝并说明', () => {
  const bad = dirWith('{ not json');
  const arr = dirWith('[1,2,3]');
  try {
    assert.match(checkAuthShape(bad).problem!, /不是合法 JSON/);
    assert.match(checkAuthShape(arr).problem!, /顶层必须是对象/);
  } finally {
    rmSync(bad, { recursive: true, force: true });
    rmSync(arr, { recursive: true, force: true });
  }
});

test('★ 不误伤：没有 auth.json / 空对象 / 没有 agentDir → 放行（可能走 env 凭据）', () => {
  const none = dirWith(null);
  const empty = dirWith('{}');
  try {
    assert.equal(checkAuthShape(none).ok, true);
    assert.match(checkAuthShape(none).note!, /未发现 auth.json|交给 pi/);
    assert.equal(checkAuthShape(empty).ok, true, '空对象只是没写凭据，不该拦');
    assert.equal(checkAuthShape(undefined).ok, true, '没有 agentDir 就交给 pi');
  } finally {
    rmSync(none, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test('★★ 报错信息里**不含 key 值**（脱敏）', () => {
  const secret = 'sk-super-secret-abcdef123456';
  const shapes = [
    JSON.stringify({ amr: { type: 'api_key', key: secret } }),
    JSON.stringify({ providers: { amr: secret } }),
    JSON.stringify({ providers: { amr: { type: 'api_key', apiKey: secret } } }),
  ];
  try {
    for (const shape of shapes) {
      const dir = dirWith(shape);
      try {
        const r = checkAuthShape(dir);
        assert.equal(r.ok, false);
        assert.ok(!r.problem!.includes(secret), '★ 报错信息泄漏了 key');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    /* 已清理 */
  }
});

test('★★ 真集成：坏 auth.json → getOrCreate **立刻**抛可读错误（绝不挂到超时才报）', async () => {
  const dir = dirWith(JSON.stringify({ amr: { type: 'api_key', key: 'sk-x-1234567890' } }));
  const manager = new AgentSessionManager({ agentDir: dir, sessionDir: null, persist: false, tools: [] });
  const started = Date.now();
  try {
    await assert.rejects(
      () => manager.getOrCreate('bad-auth-1'),
      (err: Error) => {
        assert.equal(err.name, 'PiAuthShapeInvalid');
        assert.match(err.message, /缺少 `providers` 层/);
        assert.match(err.message, /静默挂死/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 5000, `必须快速失败，实际 ${Date.now() - started}ms`);
  } finally {
    manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 正确形状 → 能正常建会话（不误伤真路径）', async () => {
  const dir = dirWith(JSON.stringify({ providers: { amr: { type: 'api_key', key: 'sk-x-1234567890' } } }));
  // 用假会话工厂：只验证"形状校验放行 + 能建会话"，不依赖真 SDK
  const manager = new AgentSessionManager({
    agentDir: dir,
    sessionDir: null,
    persist: false,
    tools: [],
    sessionFactory: async () => {
      const { FakePiSession, fakeInit } = await import('./helpers/fakes.ts');
      return fakeInit(new FakePiSession({ sessionFile: null, persistence: 'ephemeral' }));
    },
  });
  try {
    const session = await manager.getOrCreate('ok-auth-1');
    assert.equal(session.readyFrame().session_id, 'ok-auth-1');
  } finally {
    manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ 走 chat 通道：坏 auth.json → 一帧可读的 E_PI_CMD（**不是**"pi 不可用"）', async () => {
  const dir = dirWith(JSON.stringify({ amr: { type: 'api_key', key: 'sk-x-1234567890' } }));
  const manager = new AgentSessionManager({ agentDir: dir, sessionDir: null, persist: false, tools: [] });
  const frames: { type: string; code?: string; msg?: string; hint?: string }[] = [];
  let closedWith: string | null = null;
  const { createChatConnection } = await import('../../src/agent/stream.ts');
  try {
    const conn = await createChatConnection({
      sessionId: 'auth-bad-1',
      send: (f) => {
        frames.push(f as never);
      },
      onClose: (_code, reason) => {
        closedWith = reason;
      },
      manager,
    });
    const err = frames.find((f) => f.type === 'error');
    assert.ok(err, '必须给一帧错误');
    assert.equal(err.code, 'E_PI_CMD', '配置形状问题不是 E_PI_UNAVAILABLE');
    assert.match(String(err.msg), /缺少 `providers` 层/);
    assert.match(String(err.hint), /部署配置/);
    assert.equal(closedWith, null, '不该按"pi 不可用"关流（会误导前端禁用入口）');
    await conn.close();
  } finally {
    manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
