/**
 * 事件总线 + 任务队列（契约 §6 / C1 / C4）—— 单元级断言，全部用真 SQLite。
 *
 * 覆盖：
 * - bus：单调 id、`fromId` 续推（重放 + 实时，不重不漏）、keepalive、有界缓冲、finish 关流
 * - queue：未知 kind 如实失败、并发=1、取消 → `cancelled`（不是 failed）、重启恢复、`drained`
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { KEEPALIVE_EVENT, TaskEventBus, formatSseFrame } from '../src/tasks/bus.ts';
import { TaskQueue } from '../src/tasks/queue.ts';
import type { TaskHandler } from '../src/tasks/queue.ts';
import { ApiError } from '../src/store/errors.ts';

function setup(handlers: Record<string, TaskHandler>, concurrency = 1): { db: Db; repo: Repo; bus: TaskEventBus; queue: TaskQueue } {
  const db = Db.open(':memory:');
  const repo = new Repo(db);
  const bus = new TaskEventBus();
  const queue = new TaskQueue({ repo, bus, handlers, concurrency });
  return { db, repo, bus, queue };
}

// ═══════════════════════════════════════════════════════════════════════
// bus
// ═══════════════════════════════════════════════════════════════════════

test('bus：publish 分配单调 id 并缓冲；fromId 续推不重不漏', () => {
  const bus = new TaskEventBus();
  const f1 = bus.publish('t1', 'progress', { progress: 0.1 });
  const f2 = bus.publish('t1', 'progress', { progress: 0.5 });
  const f3 = bus.publish('t1', 'log', { msg: 'hi' });
  assert.deepEqual([f1.id, f2.id, f3.id], [1, 2, 3]);
  assert.deepEqual(bus.buffered('t1').map((f) => f.id), [1, 2, 3]);
  assert.equal(bus.lastEventId('t1'), 3);

  // 从头重放
  const seenAll: number[] = [];
  const unsubAll = bus.subscribe('t1', { fromId: null, onFrame: (f) => seenAll.push(f.id) });
  assert.deepEqual(seenAll, [1, 2, 3]);
  unsubAll();

  // 从 1 续推：历史只剩 2、3，然后实时帧 4
  const seen: number[] = [];
  const unsub = bus.subscribe('t1', { fromId: 1, onFrame: (f) => seen.push(f.id) });
  assert.deepEqual(seen, [2, 3], '只重放 id > fromId 的帧');
  bus.publish('t1', 'progress', { progress: 1 });
  assert.deepEqual(seen, [2, 3, 4], '重放后接实时帧，不重不漏');
  assert.equal(bus.subscriberCount('t1'), 1);
  unsub();
  assert.equal(bus.subscriberCount('t1'), 0);
  bus.publish('t1', 'progress', { progress: 1 });
  assert.deepEqual(seen, [2, 3, 4], '退订后不再收到');
});

test('bus：有界缓冲丢最旧、id 仍单调；finish 触发 onClose 且不再推送', () => {
  const bus = new TaskEventBus({ maxBufferedPerTask: 3 });
  for (let i = 0; i < 5; i += 1) bus.publish('t2', 'progress', { i });
  assert.deepEqual(bus.buffered('t2').map((f) => f.id), [3, 4, 5], '只保留最新 3 帧');
  assert.equal(bus.lastEventId('t2'), 5, 'id 必须单调，不受丢弃影响');

  let closed = 0;
  const seen: number[] = [];
  const unsub = bus.subscribe('t2', {
    fromId: null,
    onFrame: (f) => seen.push(f.id),
    onClose: () => {
      closed += 1;
    },
  });
  assert.deepEqual(seen, [3, 4, 5]);
  bus.finish('t2');
  assert.equal(closed, 1, 'finish 必须通知关闭一次');
  assert.equal(bus.isFinished('t2'), true);
  bus.publish('t2', 'progress', { after: true });
  assert.deepEqual(seen, [3, 4, 5], '终结后不再推送（只入缓冲）');
  assert.equal(bus.buffered('t2').at(-1)?.data.after, true);
  unsub();
});

test('bus：已终结的任务重新订阅 → 重放历史后立即 onClose（不挂死流）', () => {
  const bus = new TaskEventBus();
  bus.publish('t3', 'progress', { progress: 1 });
  bus.publish('t3', 'done', { status: 'done' });
  bus.finish('t3');
  const seen: string[] = [];
  let closed = false;
  bus.subscribe('t3', { onFrame: (f) => seen.push(f.event), onClose: () => (closed = true) });
  assert.deepEqual(seen, ['progress', 'done']);
  assert.equal(closed, true);
});

test('bus：keepalive 用独立的伪事件名，不占用事件 id', async () => {
  const bus = new TaskEventBus({ defaultKeepaliveMs: 20 });
  bus.publish('t4', 'progress', { progress: 0.1 });
  const events: string[] = [];
  const unsub = bus.subscribe('t4', { keepaliveMs: 20, onFrame: (f) => events.push(f.event) });
  await new Promise((r) => setTimeout(r, 60));
  unsub();
  assert.equal(events[0], 'progress');
  assert.ok(events.filter((e) => e === KEEPALIVE_EVENT).length >= 1, '必须发 keepalive');
  assert.equal(bus.lastEventId('t4'), 1, 'keepalive 不许推进事件 id');
  // 渲染成注释帧（契约 §6：`: keepalive`）
  assert.equal(formatSseFrame({ id: 1, event: KEEPALIVE_EVENT, data: {} }), ': keepalive\n\n');

  // SSE 渲染：单行 JSON + id/event/data 三段
  const rendered = formatSseFrame({ id: 7, event: 'progress', data: { task_id: 't', progress: 0.5, msg: 'a\nb\u2028c' } });
  // ⚠️ 正则里**不能**用 `.`（它不匹配 U+2028/2029 —— 这正是坑 12 的同一根源），用 [\s\S]
  assert.match(rendered, /^id: 7\nevent: progress\ndata: \{[\s\S]*\}\n\n$/);
  assert.equal(rendered.split('\n').length, 5, 'id / event / data / 空行 → 四段（split 后 5 项）');
  const dataLine = rendered.split('\n')[2] as string;
  assert.ok(!dataLine.slice(6).includes('\n'), 'data 必须是单行 JSON');
  assert.deepEqual(JSON.parse(dataLine.slice(6)), { task_id: 't', progress: 0.5, msg: 'a\nb\u2028c' });
  assert.ok(dataLine.includes('\\u2028'), 'U+2028 必须被 JSON 转义（单行保证）');
});

// ═══════════════════════════════════════════════════════════════════════
// queue
// ═══════════════════════════════════════════════════════════════════════

test('queue：成功路径 —— 任务 done、progress=1、detail=返回值、SSE 帧序正确', async () => {
  const s = setup({
    ok: async (ctx) => {
      ctx.progress(0.5, '半程', { done: 1, total: 2 });
      ctx.log('一条日志');
      return { answer: 42 };
    },
  });
  try {
    const frames: { event: string; data: Record<string, unknown> }[] = [];
    let closed = false;
    const taskId = s.queue.enqueue({ kind: 'ok' });
    s.bus.subscribe(taskId, {
      onFrame: (f) => {
        if (f.event !== KEEPALIVE_EVENT) frames.push({ event: f.event, data: f.data });
      },
      onClose: () => (closed = true),
    });
    await s.queue.drained(5000);

    const task = s.repo.getTask(taskId);
    assert.equal(task?.status, 'done');
    assert.equal(task?.progress, 1);
    assert.equal(task?.stage, '完成');
    // `ctx.progress(frac, stage, detail)` 的 detail 会**并入**任务 detail（便于前端显示 done/total），
    // handler 的返回值优先级更高（覆盖同名键）
    assert.deepEqual(task?.detail, { done: 1, total: 2, answer: 42 });
    assert.equal(task?.finished_at !== null, true, '完成必须写 finished_at');
    assert.equal(closed, true, '任务结束必须关流（契约 §6）');
    assert.deepEqual(frames.map((f) => f.event), ['progress', 'progress', 'log', 'progress', 'done']);
    assert.deepEqual(frames[0]?.data, { task_id: taskId, progress: 0, stage: '排队中', kind: 'ok' });
    assert.deepEqual(frames[1]?.data, { task_id: taskId, progress: 0.5, stage: '半程', done: 1, total: 2 });
    assert.deepEqual(frames[2]?.data, { task_id: taskId, level: 'info', msg: '一条日志' });
    assert.equal(frames[4]?.data.status, 'done');
    assert.equal(typeof frames[4]?.data.elapsed_ms, 'number');
  } finally {
    s.db.close();
  }
});

test('queue：未知 kind → failed + 可读 error（不静默成功）', async () => {
  const s = setup({});
  try {
    const taskId = s.queue.enqueue({ kind: 'not-registered' });
    await s.queue.drained(5000);
    const task = s.repo.getTask(taskId);
    assert.equal(task?.status, 'failed');
    assert.match(String(task?.error), /没有注册 kind=not-registered 的处理器/);
    assert.equal(task?.progress, 0, '失败不许把进度写成 1');
  } finally {
    s.db.close();
  }
});

test('queue：ApiError → failed 且保留契约 code；普通 Error → E_INTERNAL', async () => {
  const s = setup({
    api: async () => {
      throw new ApiError('E_ASR_LOAD', '模型加载失败', { detail: 'OOM', hint: '换 tiny' });
    },
    boom: async () => {
      throw new Error('普通异常');
    },
  });
  try {
    const frames: Record<string, unknown>[] = [];
    const t1 = s.queue.enqueue({ kind: 'api' });
    s.bus.subscribe(t1, { onFrame: (f) => frames.push(f.data) });
    await s.queue.drained(5000);
    const failed = frames.find((f) => f.code === 'E_ASR_LOAD') as Record<string, unknown>;
    assert.equal(failed.error, '模型加载失败');
    assert.equal(failed.detail, 'OOM');
    assert.equal(s.repo.getTask(t1)?.error, '模型加载失败');

    const t2 = s.queue.enqueue({ kind: 'boom' });
    await s.queue.drained(5000);
    assert.equal(s.repo.getTask(t2)?.status, 'failed');
    assert.equal(s.repo.getTask(t2)?.error, '普通异常');
  } finally {
    s.db.close();
  }
});

test('queue：并发=1（两个任务不许重叠执行）', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const s = setup(
    {
      slow: async (ctx) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        ctx.progress(0.1, '跑');
        await new Promise((r) => setTimeout(r, 30));
        concurrent -= 1;
        return { ok: true };
      },
    },
    1,
  );
  try {
    s.queue.enqueue({ kind: 'slow' });
    s.queue.enqueue({ kind: 'slow' });
    s.queue.enqueue({ kind: 'slow' });
    await s.queue.drained(5000);
    assert.equal(maxConcurrent, 1, '契约 C1：并发必须为 1');
    assert.equal(s.repo.listTasks({ status: 'done' }).length, 3);
  } finally {
    s.db.close();
  }
});

test('queue：取消运行中的任务 → cancelled（不是 failed），且 handler 收到 abort', async () => {
  let sawAbort = false;
  const s = setup({
    long: async (ctx) => {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5000);
        ctx.signal.addEventListener('abort', () => {
          sawAbort = true;
          clearTimeout(t);
          resolve();
        });
      });
      return { finished: true };
    },
  });
  try {
    const taskId = s.queue.enqueue({ kind: 'long' });
    // 等它真的跑起来
    for (let i = 0; i < 100 && s.queue.status(taskId) !== 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(s.queue.status(taskId), 'running');
    assert.equal(s.queue.cancel(taskId), true);
    await s.queue.drained(5000);
    assert.equal(sawAbort, true, '取消必须通过 AbortSignal 传到 handler');
    const task = s.repo.getTask(taskId);
    assert.equal(task?.status, 'cancelled');
    assert.equal(task?.error, null, '取消不是失败，error 保持为空');
    assert.equal(task?.finished_at !== null, true);
  } finally {
    s.db.close();
  }
});

test('queue：取消排队中的任务 → 直接 cancelled 且不执行 handler', async () => {
  let ran = 0;
  const s = setup(
    {
      blocker: async () => {
        await new Promise((r) => setTimeout(r, 40));
        return {};
      },
      never: async () => {
        ran += 1;
        return {};
      },
    },
    1,
  );
  try {
    s.queue.enqueue({ kind: 'blocker' });
    const queued = s.queue.enqueue({ kind: 'never' });
    assert.equal(s.queue.cancel(queued), true);
    await s.queue.drained(5000);
    assert.equal(ran, 0, '排队中被取消的任务不许执行');
    assert.equal(s.repo.getTask(queued)?.status, 'cancelled');
  } finally {
    s.db.close();
  }
});

test('queue：recover() 只恢复 running/queued，不动终态任务（契约 C4 断点）', async () => {
  const s = setup({
    ok: async () => ({ done: true }),
  });
  try {
    // 造三条历史任务：running（重启前没跑完）、done、failed
    const running = s.repo.insertTask({ kind: 'ok', status: 'running', detail: { params: { x: 1 } } });
    const done = s.repo.insertTask({ kind: 'ok', status: 'done' });
    const failed = s.repo.insertTask({ kind: 'ok', status: 'failed' });
    const recovered = s.queue.recover();
    assert.deepEqual(recovered, [running, done, failed].filter((id) => id === running), '只恢复 running 的那条');
    await s.queue.drained(5000);

    assert.equal(s.repo.getTask(running)?.status, 'done', '恢复后真的跑完了');
    assert.equal(s.repo.getTask(done)?.status, 'done');
    assert.equal(s.repo.getTask(failed)?.status, 'failed', '终态任务不许被复活');
    assert.equal((s.repo.getTask(running)?.detail as Record<string, unknown>).recovered ?? true, true);
  } finally {
    s.db.close();
  }
});

test('queue：shutdown() 会中止在跑任务并等它收尾（避免关库后异步写崩）', async () => {
  const s = setup({
    long: async (ctx) => {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5000);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        });
      });
      return {};
    },
  });
  try {
    const taskId = s.queue.enqueue({ kind: 'long' });
    for (let i = 0; i < 100 && s.queue.status(taskId) !== 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const out = await s.queue.shutdown(3000);
    assert.equal(out.timedOut, false, '必须等到任务收尾');
    assert.deepEqual(out.stillActive, []);
    assert.equal(s.queue.isIdle(), true);
    // 收尾写入已落库（若没等就关库，这里会读到 running）
    assert.equal(s.repo.getTask(taskId)?.status, 'cancelled');
  } finally {
    s.db.close();
  }
});
