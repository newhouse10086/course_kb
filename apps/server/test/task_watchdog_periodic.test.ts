/**
 * ★★ 运行期周期扫描（**用户症状的主修复**）：`running` 任务卡住 → 队列被堵死。
 *
 * ## 为什么必须有这一层（实测才看清的交互）
 * `queue.recover()`（契约 C4，在 `buildApp` 里）会把**上个进程遗留的 `running` 重新排成 `queued`**
 * ⟹ **启动扫描扫不到它们**（真机实测 `killed:0`，而且它们被真的重跑了）。
 * 用户撞到的"卡在 running 永远不动、后面全排不上"发生在**运行期**：
 * worker 死了/无响应 → 没人判死 → **一条 running 行永久占住并发=1 的唯一槽位**。
 *
 * ⟹ 本文件验证 `startPeriodicSweep`：**小间隔**下真的会把超时任务判死并**释放队列**。
 *    （用小间隔而不是读代码"觉得对" —— 周期行为必须被真的观察一次。）
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
import { createTaskWatchdog, startPeriodicSweep } from '../src/tasks/watchdog.ts';
import type { TaskHandler } from '../src/tasks/queue.ts';

function setup(): { db: Db; repo: Repo; dir: string; bus: TaskEventBus } {
  const dir = mkdtempSync(join(tmpdir(), 'kb-wd-periodic-'));
  const db = Db.open(join(dir, 't.sqlite3'));
  db.migrate();
  return { db, repo: new Repo(db), dir, bus: new TaskEventBus() };
}

test('★★ 运行期：周期扫描把"心跳超时的 running"判死 → **队列真的放行**', async () => {
  const { db, repo, dir, bus } = setup();
  const STALE = 200; // 200ms 判死阈值（测试专用）
  let handled = 0;
  const quick: TaskHandler = async (ctx) => {
    handled += 1;
    ctx.progress(1, '完成');
    return { ok: true };
  };
  const queue = new TaskQueue({ repo, bus, handlers: { quick }, concurrency: 1, staleMs: STALE });
  const watchdog = createTaskWatchdog({ repo, staleMs: STALE });
  const sweeps: { killed: string[] }[] = [];
  const sweeper = startPeriodicSweep({
    watchdog,
    staleMs: STALE,
    intervalMsOverride: 50, // 50ms 巡一次 —— 让"周期"这件事在测试里真的被观察到
    onSwept: (r) => sweeps.push({ killed: r.killed }),
  });
  try {
    // ① 造一个"运行期卡死"的任务：running + 心跳停在很久以前（进程没重启，但它已经死了）
    const zombie = repo.insertTask({ kind: 'quick', status: 'running' });
    repo.touchTaskHeartbeat(zombie, Date.now() - 60_000);
    // ② 后面排一个**真的能跑**的任务（它现在被僵尸占着唯一并发槽 → 排不上）
    queue.enqueue({ kind: 'quick', params: {} });

    // ③ 等周期扫描动手：僵尸必须被判死，且后面的任务必须**真的跑起来**
    const started = Date.now();
    while (Date.now() - started < 8_000 && (handled === 0 || repo.getTaskRow(zombie)!.status !== 'failed')) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const zombieRow = repo.getTaskRow(zombie)!;
    assert.equal(zombieRow.status, 'failed', '★ 周期扫描必须把卡死任务判失败（否则队列被永久堵住）');
    assert.match(String(zombieRow.error), /任务超时/, '必须带可读 reason');
    assert.equal(handled, 1, '★★ 判死之后队列必须**真的放行**（后面的任务真的被执行）');
    // ⚠️ "周期"这件事要**单独等出来**：上面一满足条件就退出（第一次巡检就够了），
    //    所以这里再等 150ms（=3 个巡检间隔）才断言"真的在反复跑"。我第一版没等就断言 ≥2 → 假红。
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(sweeper.sweeps() >= 2, `周期扫描必须真的在反复跑（实际 ${sweeper.sweeps()} 次）`);
    assert.ok(sweeps.length >= 1, '处置时必须有回调（用于写日志）');
  } finally {
    sweeper.stop();
    await queue.shutdown(2_000);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 运行期周期扫描**不误杀**：心跳新鲜的任务在多次巡检后仍活着', async () => {
  const { db, repo, dir } = setup();
  const STALE = 200;
  const watchdog = createTaskWatchdog({ repo, staleMs: STALE });
  const sweeper = startPeriodicSweep({ watchdog, staleMs: STALE, intervalMsOverride: 40 });
  try {
    const live = repo.insertTask({ kind: 'parse', status: 'running' });
    // 持续续命（模拟"在跑就更新"的长任务）
    const keeper = setInterval(() => repo.touchTaskHeartbeat(live), 50);
    keeper.unref?.();
    await new Promise((r) => setTimeout(r, 600));
    clearInterval(keeper);
    assert.equal(repo.getTaskRow(live)!.status, 'running', '★ 有心跳的慢任务不许被周期扫描误杀');
    assert.ok(sweeper.sweeps() >= 3, `巡检应跑了多次（实际 ${sweeper.sweeps()}）`);
  } finally {
    sweeper.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
