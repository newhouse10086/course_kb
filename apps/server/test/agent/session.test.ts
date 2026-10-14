/**
 * `session.ts` 单测：会话生命周期 + 结束信号 + 中断记账 + 空闲回收 + ready 帧。
 *
 * 全部用**假 pi 会话**驱动（`sessionFactory` 注入），毫秒级、确定性。
 * 真实 SDK 路径见 `integration.test.ts`。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentSessionManager,
  DEFAULT_IDLE_TTL_MS,
  isValidSessionId,
  type SessionInit,
} from '../../src/agent/session.ts';
import type { AgentFrame } from '../../src/agent/stream.ts';
import {
  FakePiSession,
  agentStart,
  agentSettled,
  autoRetryEnd,
  autoRetryStart,
  fakeInit,
  messageEnd,
  systemMessageEnd,
  textDelta,
  waitFor,
} from './helpers/fakes.ts';

function makeManager(opts: {
  sessions?: FakePiSession[];
  managerOpts?: Partial<ConstructorParameters<typeof AgentSessionManager>[0]>;
} = {}) {
  const created: FakePiSession[] = [];
  const manager = new AgentSessionManager({
    cwd: process.cwd(),
    sessionDir: null,
    persist: false,
    ...opts.managerOpts,
    sessionFactory: async (sessionId: string): Promise<SessionInit> => {
      const fake = new FakePiSession({ sessionFile: null, persistence: 'ephemeral' });
      created.push(fake);
      void sessionId;
      return fakeInit(fake);
    },
  });
  return { manager, created };
}

function framesOf(session: { subscribe: (fn: (f: AgentFrame) => void) => () => void }): AgentFrame[] {
  const frames: AgentFrame[] = [];
  session.subscribe((f) => frames.push(f));
  return frames;
}

// ===========================================================================
// 会话 id 校验
// ===========================================================================

test('isValidSessionId：合法/非法边界', () => {
  assert.equal(isValidSessionId('web-abc_1.2'), true);
  assert.equal(isValidSessionId('a'), true);
  assert.equal(isValidSessionId('x'.repeat(64)), true);
  assert.equal(isValidSessionId('x'.repeat(65)), false);
  assert.equal(isValidSessionId(''), false);
  assert.equal(isValidSessionId('../etc/passwd'), false);
  assert.equal(isValidSessionId('a/b'), false);
  assert.equal(isValidSessionId('会话'), false);
  assert.equal(isValidSessionId('a b'), false);
});

test('非法 session id 直接拒绝（不建会话）', async () => {
  const { manager, created } = makeManager();
  await assert.rejects(() => manager.getOrCreate('../evil'), /非法 session id/);
  assert.equal(created.length, 0);
});

// ===========================================================================
// ★ 结束信号：不假设 prompt() resolve 就是结束
// ===========================================================================

test('★ prompt() resolve 时已收到 settled → 直接结束，不额外等待', async () => {
  const { manager, created } = makeManager();
  const session = await manager.getOrCreate('s1');
  const fake = created[0]!;
  const frames = framesOf(session);

  fake.emitBeforeResolve = [agentStart(), textDelta('聚簇'), agentSettled(false)];
  const started = Date.now();
  const outcome = await session.prompt('问题');
  const elapsed = Date.now() - started;

  assert.equal(outcome.disposition, 'started');
  assert.equal(outcome.syntheticSettled, false);
  assert.ok(elapsed < 1000, `不该白等：${elapsed}ms`);
  assert.deepEqual(
    frames.map((f) => f.type),
    ['text_delta', 'settled'],
  );
  assert.equal(frames[1]?.type === 'settled' && frames[1].aborted, false);
});

test('★ prompt() resolve 早于 settled → 仍然等 settled（防御式，不靠 resolve 语义）', async () => {
  const { manager, created } = makeManager();
  const session = await manager.getOrCreate('s2');
  const fake = created[0]!;
  const frames = framesOf(session);

  // resolve 之后 120ms 才发 settled —— 模拟"resolve 不代表结束"
  fake.emitBeforeResolve = [agentStart(), textDelta('半')];
  fake.emitAfterResolve = [{ ms: 120, event: agentSettled(false) }];

  const outcome = await session.prompt('问题');
  assert.equal(outcome.syntheticSettled, false, '等到真 settled 就不该补');
  assert.deepEqual(
    frames.map((f) => f.type),
    ['text_delta', 'settled'],
  );
  assert.equal(frames.at(-1)?.type === 'settled' && (frames.at(-1) as { synthetic?: boolean }).synthetic, undefined);
});

test('★ settled 始终不来 → 如实报 E_PI_TIMEOUT 并补 settled（不让 UI 永久卡住）', async () => {
  const { manager, created } = makeManager({ managerOpts: { settleGraceMs: 80 } });
  const session = await manager.getOrCreate('s3');
  const fake = created[0]!;
  const frames = framesOf(session);

  fake.emitBeforeResolve = [agentStart()];
  fake.emitAfterResolve = []; // 永远不 settled
  const outcome = await session.prompt('问题');

  assert.equal(outcome.syntheticSettled, true);
  const types = frames.map((f) => f.type);
  assert.deepEqual(types, ['error', 'settled']);
  const err = frames[0];
  assert.equal(err?.type === 'error' && err.code, 'E_PI_TIMEOUT');
  assert.match(String(err?.type === 'error' ? err.hint : ''), /^pi SDK 正常，/);
  assert.equal(frames[1]?.type === 'settled' && (frames[1] as { synthetic?: boolean }).synthetic, true);
  assert.equal(session.isRunning, false);
});

test('disposition=handled → 没有运行，补 settled 并标记 synthetic（照 v1 的结论）', async () => {
  const { manager, created } = makeManager();
  const session = await manager.getOrCreate('s4');
  const fake = created[0]!;
  const frames = framesOf(session);

  fake.disposition = 'handled';
  const outcome = await session.prompt('/some-command');

  assert.equal(outcome.disposition, 'handled');
  assert.equal(outcome.syntheticSettled, true);
  assert.deepEqual(frames.map((f) => f.type), ['settled']);
  assert.equal(frames[0]?.type === 'settled' && (frames[0] as { disposition?: string }).disposition, 'handled');
});

test('prompt() 被拒绝（未受理）→ error 帧 + 补 settled + 抛出（调用方能感知）', async () => {
  const { manager, created } = makeManager();
  const session = await manager.getOrCreate('s5');
  const fake = created[0]!;
  fake.rejectWith = new Error('no model selected');
  const frames = framesOf(session);

  await assert.rejects(() => session.prompt('问题'), /no model selected/);
  const types = frames.map((f) => f.type);
  assert.deepEqual(types, ['error', 'settled']);
  const err = frames[0];
  assert.equal(err?.type === 'error' && err.code, 'E_LLM');
  assert.match(String(err?.type === 'error' ? err.hint : ''), /配置/);
  assert.equal(session.isRunning, false, '被拒绝后必须回到空闲');
});

test('★ 运行中的第二次 prompt 不给 steer/followUp → **拒绝而不是猜**', async () => {
  const { manager, created } = makeManager();
  const session = await manager.getOrCreate('s6');
  const fake = created[0]!;
  // 让第一次 prompt 一直挂着（resolve 后再等 300ms 才 settled）
  fake.emitAfterResolve = [{ ms: 300, event: agentSettled(false) }];
  const first = session.prompt('第一问');
  assert.ok(await waitFor(() => session.isRunning));

  await assert.rejects(() => session.prompt('第二问'), /steer|followUp/);
  assert.equal(fake.promptCalls.length, 1, '不该把第二条也当 prompt 发出去');

  const steered = await session.prompt('插话', { steer: true });
  assert.equal(steered.disposition, 'queued');
  assert.deepEqual(fake.steerCalls, ['插话']);

  const followed = await session.prompt('追加', { followUp: true });
  assert.equal(followed.disposition, 'queued');
  assert.deepEqual(fake.followUpCalls, ['追加']);

  await first;
});

// ===========================================================================
// ★ 中断记账（⚠️1）
// ===========================================================================

test('★ abort 之后 SDK 没标 aborted → 桥补 aborted:true + abort_source:"client"', async () => {
  const { manager, created } = makeManager();
  const session = await manager.getOrCreate('s7');
  const fake = created[0]!;
  const frames = framesOf(session);

  fake.emitAfterResolve = [{ ms: 60, event: agentSettled(false) }]; // SDK 说 false
  const running = session.prompt('写长文');
  await waitFor(() => session.isRunning);
  await session.abort();
  assert.equal(fake.abortCalls, 1);
  await running;

  const settled = frames.find((f) => f.type === 'settled');
  assert.ok(settled && settled.type === 'settled');
  assert.equal(settled.aborted, true);
  assert.equal(settled.abort_source, 'client');
});

test('SDK 自己标了 aborted:true → 不抢功（不加 abort_source）', async () => {
  const { manager, created } = makeManager();
  const session = await manager.getOrCreate('s8');
  const fake = created[0]!;
  const frames = framesOf(session);
  fake.emitBeforeResolve = [agentSettled(true)];
  await session.prompt('x');
  const settled = frames.find((f) => f.type === 'settled');
  assert.equal(settled?.type === 'settled' && settled.aborted, true);
  assert.equal(settled?.type === 'settled' && settled.abort_source, undefined);
});

test('没 abort 就不许标"已中断"（下一轮不被上一轮污染）', async () => {
  const { manager, created } = makeManager();
  const session = await manager.getOrCreate('s9');
  const fake = created[0]!;
  fake.emitAfterResolve = [{ ms: 40, event: agentSettled(false) }];
  const first = session.prompt('第一轮');
  await waitFor(() => session.isRunning);
  await session.abort();
  await first;

  // 第二轮：正常结束
  const frames = framesOf(session);
  fake.emitAfterResolve = [];
  fake.emitBeforeResolve = [agentSettled(false)];
  const outcome = await session.prompt('第二轮');
  assert.equal(outcome.aborted, false);
  const settled = frames.find((f) => f.type === 'settled');
  assert.equal(settled?.type === 'settled' && settled.aborted, false);
  assert.equal(settled?.type === 'settled' && settled.abort_source, undefined);
});

// ===========================================================================
// ⚠️7 失败可见（端到端：假会话 → 帧）
// ===========================================================================

test('★ 真实失败序列（403 + 3 次重试）经会话后 → 恰好一条 E_LLM + 一条 settled', async () => {
  const { manager, created } = makeManager();
  const session = await manager.getOrCreate('s10');
  const fake = created[0]!;
  const frames = framesOf(session);

  fake.emitBeforeResolve = [
    agentStart(),
    messageEnd('assistant', {
      stopReason: 'error',
      errorMessage: '403: An active OpenCode Go subscription is required to use Go models.',
    }),
    autoRetryStart(1, 3, '403: An active OpenCode Go subscription is required to use Go models.'),
    autoRetryEnd(false, 3, '403: An active OpenCode Go subscription is required to use Go models.'),
    agentSettled(),
  ];
  await session.prompt('问题');

  const errors = frames.filter((f) => f.type === 'error');
  assert.equal(errors.length, 1);
  const err = errors[0];
  assert.equal(err?.type === 'error' && err.code, 'E_LLM');
  assert.match(String(err?.type === 'error' ? err.hint : ''), /^pi SDK 正常，/);
  assert.equal(frames.filter((f) => f.type === 'settled').length, 1);
});

test('★ 系统提示词的 message_end 不会到达订阅者（会话层）', async () => {
  const { manager, created } = makeManager();
  const session = await manager.getOrCreate('s11');
  const fake = created[0]!;
  const frames = framesOf(session);

  fake.emitBeforeResolve = [systemMessageEnd(), textDelta('答案'), agentSettled()];
  await session.prompt('问题');

  const wire = JSON.stringify(frames);
  assert.ok(!wire.includes('project_instructions'), 'AGENTS.md 全文泄漏');
  assert.ok(!wire.includes('You are an expert coding assistant'), '系统提示词泄漏');
  assert.deepEqual(frames.map((f) => f.type), ['text_delta', 'settled']);
});

// ===========================================================================
// 订阅顺序（坑 14）
// ===========================================================================

test('★ 订阅在任何 prompt 之前就绪：第一条 prompt 的第一个事件也不会丢', async () => {
  const { manager, created } = makeManager();
  const session = await manager.getOrCreate('s12');
  const fake = created[0]!;
  assert.equal(fake.subscriberCount, 1, '创建时就必须已订阅 pi 会话');

  const frames = framesOf(session);
  fake.emitBeforeResolve = [textDelta('第一个增量'), agentSettled()];
  await session.prompt('问题');
  assert.equal(frames[0]?.type, 'text_delta');
});

test('多个订阅者都能收到（WS + 诊断）', async () => {
  const { manager, created } = makeManager();
  const session = await manager.getOrCreate('s13');
  const fake = created[0]!;
  const a: AgentFrame[] = [];
  const b: AgentFrame[] = [];
  session.subscribe((f) => a.push(f));
  session.subscribe((f) => b.push(f));
  fake.emitBeforeResolve = [textDelta('x'), agentSettled()];
  await session.prompt('q');
  assert.equal(a.length, 2);
  assert.equal(b.length, 2);

  // 退订后不再收到
  const c: AgentFrame[] = [];
  const off = session.subscribe((f) => c.push(f));
  off();
  fake.emitBeforeResolve = [agentSettled()];
  await session.prompt('q2');
  assert.equal(c.length, 0);
});

test('订阅者抛异常被隔离，不影响其它订阅者', async () => {
  const { manager, created } = makeManager();
  const session = await manager.getOrCreate('s14');
  const fake = created[0]!;
  const good: AgentFrame[] = [];
  session.subscribe(() => {
    throw new Error('订阅者坏了');
  });
  session.subscribe((f) => good.push(f));
  fake.emitBeforeResolve = [agentSettled()];
  await session.prompt('q');
  assert.equal(good.length, 1);
});

// ===========================================================================
// ready 帧 / 持久化可观测 / new_session
// ===========================================================================

test('ready 帧：两层字段齐、session_id 与 pi_session_id 分开、不含系统提示词', async () => {
  const { manager } = makeManager();
  const session = await manager.getOrCreate('s15');
  const ready = session.readyFrame();
  assert.equal(ready.type, 'ready');
  assert.equal(ready.session_id, 's15');
  assert.equal(ready.pi_session_id, 'fake-pi-session');
  assert.equal(ready.model, 'fake-model');
  assert.equal(ready.mode, 'sdk');
  assert.equal(ready.persistence, 'ephemeral');
  assert.match(ready.persistence_reason, /未启用持久化|inMemory/);
  assert.equal(ready.session_file, null);
  assert.equal(ready.tools_source, 'none');
  assert.equal(ready.version, '1.2.0-fake');
  assert.ok(!JSON.stringify(ready).includes('expert coding assistant'));
});

test('持久化可观测：native 时 ready 带 session_file 与原因', async () => {
  const manager = new AgentSessionManager({
    cwd: process.cwd(),
    sessionDir: '/tmp/fake-chat',
    sessionFactory: async () =>
      fakeInit(new FakePiSession({ sessionFile: '/tmp/fake-chat/2026-10-14T15-00-00-000Z_s16.jsonl' }), {
        sessionFile: '/tmp/fake-chat/2026-10-14T15-00-00-000Z_s16.jsonl',
        persistence: 'native',
        persistenceReason: 'pi 原生 session：/tmp/fake-chat',
      }),
  });
  const session = await manager.getOrCreate('s16');
  const ready = session.readyFrame();
  assert.equal(ready.persistence, 'native');
  assert.match(String(ready.session_file), /\.jsonl$/);
  assert.match(ready.persistence_reason, /pi 原生 session/);
});

test('new_session 重建会话：ready 标 restarted、订阅面不变、旧会话被 dispose', async () => {
  const { manager, created } = makeManager();
  const session = await manager.getOrCreate('s17');
  const frames = framesOf(session);
  const oldFake = created[0]!;

  const ready = await session.reset();
  assert.equal(ready.restarted, true);
  assert.equal(created.length, 2);
  assert.equal(oldFake.disposed, true);
  assert.equal(oldFake.subscriberCount, 0, '旧会话要退订');

  // 订阅面保留：新会话的事件仍能到同一个订阅者
  // （原错误：只设置了 `emitBeforeResolve`，却从没调用 prompt() → 事件根本没被投递，
  //   是测试自己漏了触发，不是实现的问题。）
  created[1]!.deliver(textDelta('新会话'));
  assert.ok(await waitFor(() => frames.some((f) => f.type === 'text_delta')), '重建后订阅面必须仍然有效');
  created[1]!.deliver({ type: 'agent_settled' });
  assert.ok(await waitFor(() => frames.some((f) => f.type === 'settled')));
});

// ===========================================================================
// 空闲回收 / 释放
// ===========================================================================

test('★ 空闲回收：超过 TTL 且无订阅者、未运行 → 回收；否则保留', async () => {
  const { manager, created } = makeManager({ managerOpts: { idleTtlMs: 1000 } });
  const idle = await manager.getOrCreate('idle-1');
  await manager.getOrCreate('busy-1');
  const busySubscribed = manager.get('busy-1')!;
  busySubscribed.subscribe(() => {}); // 有订阅者（页面开着）

  // 伪造时间：把 idle-1 的 lastActiveAt 推早
  const stats = idle.stats;
  assert.ok(stats.lastActiveAt > 0);
  const farFuture = Date.now() + 5000;
  const reaped = manager.reapIdle(farFuture);
  assert.ok(reaped.includes('idle-1'));
  assert.ok(!reaped.includes('busy-1'), '有订阅者的不许回收');
  assert.equal(manager.get('idle-1'), undefined);
  assert.equal(created[0]!.disposed, true, '回收要真的 dispose');
  assert.equal(manager.get('busy-1'), busySubscribed);
});

test('release 只更新时间戳、不销毁会话（重连可复用）', async () => {
  const { manager, created } = makeManager();
  const session = await manager.getOrCreate('s18');
  manager.release('s18');
  assert.equal(manager.get('s18'), session);
  assert.equal(created.length, 1);
});

test('getOrCreate 同 id 复用、不同 id 各一个（一浏览器会话一会话）', async () => {
  const { manager, created } = makeManager();
  const a1 = await manager.getOrCreate('a');
  const a2 = await manager.getOrCreate('a');
  const b = await manager.getOrCreate('b');
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.equal(created.length, 2);
  assert.equal(manager.stats().sessions, 2);
});

test('已 dispose 的会话会被重建（而不是返回死对象）', async () => {
  const { manager, created } = makeManager();
  const first = await manager.getOrCreate('s19');
  first.dispose();
  const second = await manager.getOrCreate('s19');
  assert.notEqual(first, second);
  assert.equal(created.length, 2);
});

test('close/closeAll 幂等且返回计数', async () => {
  const { manager, created } = makeManager();
  await manager.getOrCreate('x1');
  await manager.getOrCreate('x2');
  assert.equal(manager.close('x1'), true);
  assert.equal(manager.close('x1'), false);
  assert.equal(manager.closeAll(), 1);
  assert.equal(manager.stats().sessions, 0);
  assert.ok(created.every((f) => f.disposed));
});

test('stats 暴露可观测信息（persistence/session_file/rounds/violations）', async () => {
  const { manager, created } = makeManager();
  const session = await manager.getOrCreate('s20');
  created[0]!.emitBeforeResolve = [agentSettled()];
  await session.prompt('q');
  const stats = session.stats;
  assert.equal(stats.id, 's20');
  assert.equal(stats.alive, true);
  assert.equal(stats.rounds, 1);
  assert.equal(stats.persistence, 'ephemeral');
  assert.equal(stats.violations, 0);
  assert.ok(stats.lastActiveAt > 0);
});

test('DEFAULT_IDLE_TTL_MS = 30 分钟（契约要求）', () => {
  assert.equal(DEFAULT_IDLE_TTL_MS, 30 * 60 * 1000);
});
