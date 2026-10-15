/**
 * ★★ 看门狗（v8）：**死任务堵队列** 的修复 + 文档状态自愈。
 *
 * ## 真实现象（用户撞到，Lead 手动救过）
 * ```
 * 关机/重启后任务卡在 running 永远不动 → **队列被堵住，后面的任务全排不上**
 * ```
 * ## 判据（lead 指定，逐条都断言）
 * ① 心跳过期的 running 任务 → 启动扫描后**判失败**（带**可读 reason**）+ **队列放行**
 * ② **反例**：心跳**新鲜**的 running 任务 → **不许**被判死（防误杀；OCR 434 页 ~40 分钟，慢 ≠ 死）
 * ③ 文档自愈：`extracting` 且**没有任何 running 任务** → 改回 `ready`
 * ④ **反例**：`extracting` 但**确实有 running 任务** → **一个都不许动**（否则把在跑的判死）
 * ⑤ 真启动（坑 30）：v8 迁移在**已存在的老库**上跑得起来（`heartbeat_at` 补列 + 索引）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { createTaskWatchdog, formatDuration, DEFAULT_STALE_MS } from '../src/tasks/watchdog.ts';

const MIN = 60 * 1000;

/**
 * 判死阈值（**可注入** —— 红证要用它把阈值调成 0）。
 *
 * ★ 为什么留这个旋钮：lead 要求的红证之一是"把判死阈值设成 0 → **反例（心跳新鲜不许判死）必红**"。
 *   阈值写死在测试里 = 没法注入；读环境变量 = 红证能在**同一份测试**上跑，不用改代码
 *   （也就不会顺手"改宽断言"）。
 */
const rawStale = process.env.KB_TEST_WD_STALE_MS;
/**
 * ⚠️ 判"有没有设置"必须用**存在性**，不能用 `> 0` ——
 * 我第一版写的是 `Number(env) > 0 ? … : 30*MIN`，于是 `KB_TEST_WD_STALE_MS=0` 被当成"没设置"
 * → **红证 B 假绿**（阈值根本没变成 0，反例当然不会红）。这正是坑 22（`空`/`0` ≠ `缺失`）的实例：
 * 红证的价值就在这里 —— **假绿会被红证自己抓出来**。
 */
const STALE =
  rawStale !== undefined && rawStale !== '' && Number.isFinite(Number(rawStale))
    ? Math.max(0, Number(rawStale))
    : 30 * MIN;

function freshRepo(): { db: Db; repo: Repo; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kb-watchdog-'));
  const db = Db.open(join(dir, 't.sqlite3'));
  db.migrate();
  db.migrate(); // ★ 幂等：第二次 migrate 不许抛（v8 的 ADD COLUMN 只能跑一次）
  return { db, repo: new Repo(db), dir };
}

/** 造一个文档（看门狗自愈要按 documents.status 找） */
function seedDoc(repo: Repo, title: string, status: string): string {
  const id = repo.insertDocument({ title, kind: 'pdf', source_path: 'mem://seed.pdf' });
  repo.updateDocument(id, { status });
  return id;
}

test('★ 判据①：心跳过期的 running 任务 → **判失败 + 可读 reason + 队列放行**', () => {
  const { db, repo, dir } = freshRepo();
  try {
    const staleId = repo.insertTask({ kind: 'extract', status: 'running' });
    // 心跳停在 2 小时前（> 30 分钟阈值）
    repo.touchTaskHeartbeat(staleId, Date.now() - 120 * MIN);
    // 队列里还压着一个等待的任务（验证"判死后队列能前进"）
    const queuedId = repo.insertTask({ kind: 'extract', status: 'queued' });

    const wd = createTaskWatchdog({ repo, staleMs: STALE });
    const result = wd.sweepStale();

    assert.deepEqual(result.killed, [staleId], '过期任务必须被判死');
    const row = repo.getTaskRow(staleId)!;
    assert.equal(row.status, 'failed', '状态必须是 failed（不是静默改）');
    assert.match(String(row.error), /任务超时/, '必须有**可读 reason**');
    assert.match(String(row.error), /超时|无更新/, '必须说清"多久没更新"');
    // ★ 队列放行：那个 queued 任务不再被 running 堵住 → 它是当前唯一"未结束但可跑"的任务
    assert.equal(repo.getTaskRow(queuedId)!.status, 'queued');
    assert.equal(repo.runningTaskRows().length, 0, '★ 判死后**不应再有 running**（队列得以放行）');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ 判据②（反例，防误杀）：心跳**新鲜**的 running 任务 → **绝不许**被判死', () => {
  const { db, repo, dir } = freshRepo();
  try {
    // 一个"跑了 3 小时但一直在心跳"的长任务（OCR 434 页那种）
    const longId = repo.insertTask({ kind: 'parse', status: 'running' });
    repo.touchTaskHeartbeat(longId, Date.now() - 10 * 1000); // 10 秒前刚心跳

    const wd = createTaskWatchdog({ repo, staleMs: STALE });
    const result = wd.sweepStale();

    assert.deepEqual(result.killed, [], '★★ 心跳新鲜的任务**一个都不许**判死（慢 ≠ 死）');
    assert.ok(result.alive.includes(longId), '新鲜任务应出现在 alive 列表（便于排障）');
    assert.equal(repo.getTaskRow(longId)!.status, 'running', '状态必须保持 running');
    assert.equal(repo.getTaskRow(longId)!.error, null, '不许写 error');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 判据②补充：**没有心跳记录**（v8 之前的旧行）→ 用 created_at 判；刚创建的**不许**误杀', () => {
  const { db, repo, dir } = freshRepo();
  try {
    // 刚创建、还没有心跳（模拟 v8 之前写入的 running 行 / 或刚启动还没心跳）
    const justStarted = repo.insertTask({ kind: 'parse', status: 'running' });
    const wd = createTaskWatchdog({ repo, staleMs: STALE });
    assert.deepEqual(wd.sweepStale().killed, [], '刚创建的任务不许被判死');
    assert.equal(repo.getTaskRow(justStarted)!.heartbeat_at ?? null, null, '它确实还没有心跳（判据回落到 created_at）');

    // 但"很久以前创建、且从来没心跳"的僵尸必须判死（否则老库的僵尸永远清不掉）
    const zombieId = repo.insertTask({ kind: 'parse', status: 'running' });
    db.run('UPDATE tasks SET created_at = ? WHERE id = ?', Date.now() - 3 * 60 * MIN, zombieId);
    const killed = wd.sweepStale().killed;
    assert.ok(killed.includes(zombieId), '★ 没有心跳的老僵尸必须能判死（COALESCE 回落 created_at）');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 判据③：孤儿 `extracting` 文档（无任何 running 任务）→ 自愈回 ready + 记日志', () => {
  const { db, repo, dir } = freshRepo();
  try {
    const docId = seedDoc(repo, '孤儿文档', 'extracting');
    const logs: string[] = [];
    const wd = createTaskWatchdog({
      repo,
      staleMs: STALE,
      logger: { warn: (o) => logs.push(JSON.stringify(o)) },
    });
    const res = wd.healDocuments();
    assert.deepEqual(res.healed, [docId], '没有 running 任务的 extracting 文档必须自愈');
    assert.equal(repo.getDocumentRow(docId)!.status, 'ready', '应改回 ready');
    assert.ok(logs.some((l) => l.includes('doc-self-heal')), '★ 必须如实记日志（不许静默改状态）');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ 判据④（反例，防误杀）：`extracting` 但**确实有 running 任务** → 一个都不许动', () => {
  const { db, repo, dir } = freshRepo();
  try {
    const docId = seedDoc(repo, '正在跑的文档', 'extracting');
    const runningId = repo.insertTask({ kind: 'parse', docId, status: 'running' });
    repo.touchTaskHeartbeat(runningId); // 心跳新鲜

    const wd = createTaskWatchdog({ repo, staleMs: STALE });
    const res = wd.healDocuments();

    assert.deepEqual(res.healed, [], '★★ 有 running 任务的文档**绝不许**自愈（会把在跑的判死）');
    assert.ok(res.keptRunning.includes(docId), '应记入 keptRunning');
    assert.equal(repo.getDocumentRow(docId)!.status, 'extracting', '状态必须保持不变');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ runStartup：**先判死任务、再自愈文档**（顺序有意义）', () => {
  const { db, repo, dir } = freshRepo();
  try {
    const docId = seedDoc(repo, '卡住的文件', 'extracting');
    const staleTask = repo.insertTask({ kind: 'parse', docId, status: 'running' });
    repo.touchTaskHeartbeat(staleTask, Date.now() - 90 * MIN); // 已死

    const wd = createTaskWatchdog({ repo, staleMs: STALE });
    const r = wd.runStartup();

    assert.deepEqual(r.stale.killed, [staleTask], '死任务先被判死');
    // ★ 顺序的意义：若先自愈，这条文档会因为"还有 running 行"被跳过 → 白等一轮
    assert.deepEqual(r.docs.healed, [docId], '★ 判死之后，它的文档也能在**同一次扫描**里被自愈');
    assert.equal(repo.getDocumentRow(docId)!.status, 'ready');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 判死阈值默认 30 分钟（大于 OCR 434 页 ~40 分钟的单步？靠心跳续命，不靠阈值大）', () => {
  assert.equal(DEFAULT_STALE_MS, 30 * MIN);
  // formatDuration 是错误文案的一部分 —— 必须可读
  assert.equal(formatDuration(90 * 1000), '1m30s');
  assert.equal(formatDuration(2 * 60 * MIN), '2h');
});
