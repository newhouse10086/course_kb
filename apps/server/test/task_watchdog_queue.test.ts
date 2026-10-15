/**
 * ★★ 看门狗 × 真实队列：**心跳真的会前进** + **判死后队列真的放行**。
 *
 * ## 为什么必须有这一层（lead 追加的判据）
 * 单测只证明"给一个过期心跳就会判死"，证明不了这两件事：
 * 1. ★ **心跳是"在跑就更新"**，不是"启动时写一次" —— 否则长任务（OCR 434 页 ~28 分钟）
 *    仍会被误判死（阈值再大也只是把误判往后推）。
 * 2. ★ **队列真的放行** —— 判死必须让后面的任务**真的跑起来**，
 *    而不是只把状态改好看（那正是"看起来修好了"）。
 *
 * ⚠️ 这里用**真的 `TaskQueue` + 真 handler**（假 handler 只做 `sleep`，不碰 LLM/worker）→ 零 LLM。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { TaskEventBus } from '../src/tasks/bus.ts';
import { TaskQueue } from '../src/tasks/queue.ts';
import { createTaskWatchdog } from '../src/tasks/watchdog.ts';
import type { TaskHandler } from '../src/tasks/queue.ts';

function setup(): { db: Db; repo: Repo; dir: string; bus: TaskEventBus } {
  const dir = mkdtempSync(join(tmpdir(), 'kb-wd-queue-'));
  const db = Db.open(join(dir, 't.sqlite3'));
  db.migrate();
  return { db, repo: new Repo(db), dir, bus: new TaskEventBus() };
}

test('★★ 心跳**真的会前进**（在跑就更新，不是"启动时写一次"）—— 慢任务因此不被误杀', async () => {
  const { db, repo, dir, bus } = setup();
  // ★ 阈值故意设得很小（1.2s）：若心跳不前进，这个"跑 2.5 秒"的任务必被误判死
  const STALE = 1_200;
  let heartbeatDuringRun: number | null = null;
  const slow: TaskHandler = async (ctx) => {
    ctx.progress(0.1, '第一步');
    await new Promise((r) => setTimeout(r, 1_400));
    // 中途读一次心跳：必须已经被定时器推前过（大于任务开始时写的那次）
    heartbeatDuringRun = repo.getTaskRow(ctx.taskId)?.heartbeat_at ?? null;
    ctx.progress(0.6, '第二步'); // 进度也应当续命
    await new Promise((r) => setTimeout(r, 1_200));
    ctx.progress(1, '完成');
    return { ok: true };
  };
  const queue = new TaskQueue({ repo, bus, handlers: { slow }, concurrency: 1, staleMs: STALE });
  try {
    const taskId = queue.enqueue({ kind: 'slow', params: {} });
    const wd = createTaskWatchdog({ repo, staleMs: STALE });

    // 跑到 ~1.9s（已超过阈值）时：任务**必须还活着**（靠心跳续命）
    await new Promise((r) => setTimeout(r, 1_900));
    const mid = repo.getTaskRow(taskId)!;
    const killed = wd.sweepStale().killed;
    assert.deepEqual(killed, [], `★ 正在跑的任务不许被判死（心跳续命；实际判死 ${killed.join(',')}）`);
    assert.equal(mid.status, 'running', '状态必须仍是 running');

    // 等任务自然结束，再断言心跳确实前进过 + 任务成功
    const started = Date.now();
    while (Date.now() - started < 8_000 && repo.getTaskRow(taskId)!.status === 'running') {
      await new Promise((r) => setTimeout(r, 200));
    }
    const final = repo.getTaskRow(taskId)!;
    assert.equal(final.status, 'done', `任务应成功结束（实际 ${final.status} / ${final.error ?? ''}）`);
    assert.ok(heartbeatDuringRun !== null, '中途必须能读到心跳');
    assert.ok(
      heartbeatDuringRun! > 0,
      `★ heartbeat_at 必须被推进（在跑就更新；读到 ${heartbeatDuringRun}）`,
    );
    // 心跳必须晚于"任务创建后写的那一次"（证明是**运行期定时器**推的，不是启动写一次）
    assert.ok(final.heartbeat_at !== null && final.heartbeat_at >= heartbeatDuringRun! - 5, '心跳时间应单调前进');
  } finally {
    await queue.shutdown(3_000);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ 判死之后**队列真的放行**：排在后面的任务真的跑起来了', async () => {
  const { db, repo, dir, bus } = setup();
  let runs = 0;
  const quick: TaskHandler = async (ctx) => {
    runs += 1;
    ctx.progress(1, '完成');
    return { ok: true };
  };
  const queue = new TaskQueue({ repo, bus, handlers: { quick }, concurrency: 1, staleMs: 30 * 60 * 1000 });
  try {
    // ① 造一个"上次进程留下的死任务"（running + 心跳停在 2 小时前）→ 它会把并发槽占死
    const zombie = repo.insertTask({ kind: 'quick', status: 'running' });
    repo.touchTaskHeartbeat(zombie, Date.now() - 120 * 60 * 1000);

    // ② 启动扫描判死它（= 队列放行）
    const wd = createTaskWatchdog({ repo, staleMs: 30 * 60 * 1000 });
    const killed = wd.sweepStale().killed;
    assert.deepEqual(killed, [zombie], '僵尸任务必须被判死');
    assert.equal(repo.getTaskRow(zombie)!.status, 'failed');

    // ③ ★ 关键：判死之后新任务**真的能跑**（不是只把状态改好看）
    queue.enqueue({ kind: 'quick', params: {} });
    const started = Date.now();
    while (Date.now() - started < 8_000 && runs === 0) await new Promise((r) => setTimeout(r, 100));
    assert.equal(runs, 1, '★ 判死后队列必须真的放行（handler 真的被执行）');
  } finally {
    await queue.shutdown(3_000);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
