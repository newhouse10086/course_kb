/**
 * ★★ ⑥ worker stderr **落盘**（真实证据）：真起一个假 worker 子进程 → 它的 stderr 必须进日志文件。
 *
 * ## 为什么这条重要
 * Python traceback 原来**只进终端** —— 关掉终端就没了。这正是"**看不到的失败**"：
 * 任务失败只有 `tasks` 表里一行结果，**过程（为什么失败）丢失**。
 *
 * ## 之前为什么造不出证据
 * 我拿 `PYTHON_BIN=node` 的假 worker 试过：它**不按 JSONL 协议说话** → 调用器在**协议层**就退出了，
 * **没走到"读 stderr"的分支**。本用例用**真 Python 假 worker**：先按协议握手，再往 stderr 写，
 * 于是必然经过"协议 + stderr 收集"两条路径。
 *
 * 判据（三条，都会断言）：
 * 1. stderr 内容**出现在日志文件里**（带 `"source":"worker"`）
 * 2. **超长行被截断**且如实标注截断字数
 * 3. **worker 非零退出** → stderr 也必须能在结果里看到（"看不到的失败"的正解）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkerClient } from '../src/worker/client.ts';
import { createAppLogging } from '../src/logging/index.ts';

const FAKE_WORKER = `
import json, sys

# 1) 先按协议说一句话（证明握手成功 —— 这样调用器会走到"读 stderr"那条路径）
print(json.dumps({"type": "progress", "pct": 10, "msg": "fake worker started"}), flush=True)

# 2) 再往 stderr 写日志：一行正常 + 一行超长（验证截断）
sys.stderr.write("WORKER-STDERR-PROBE-OK\\n")
sys.stderr.write("WORKER-STDERR-LONG-" + ("x" * 900) + "\\n")
sys.stderr.write("Traceback (most recent call last):\\n  File \\"fake.py\\", line 9\\nRuntimeError: 假失败\\n")
sys.stderr.flush()

# 3) 非零退出（模拟"worker 崩了" —— 这条路径最容易变成"看不到的失败"）
sys.exit(2)
`;

function readLogs(dir: string): string {
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

test('★★ worker stderr 真的落盘：内容进日志 + 超长截断 + 非零退出仍可追', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'kb-worker-stderr-'));
  const logDir = join(workDir, 'logs');
  const workerPath = join(workDir, 'fake_worker_stderr.py');
  writeFileSync(workerPath, FAKE_WORKER, 'utf8');

  const logging = createAppLogging({ dir: logDir, level: 'info', stdout: false });
  try {
    const client = new WorkerClient({
      cwd: workDir,
      timeoutMs: 15_000,
      // ★ 真起进程（不 mock 行为）：bin=python，args 直接跑我们的假 worker
      launcher: (job, paramsJson) => ({
        bin: process.env.PYTHON_BIN ?? 'python',
        args: [workerPath, '--job', job, '--in', paramsJson],
        cwd: workDir,
      }),
      // ★ 这就是 `index.ts` 里接的那一行（同一个回调）
      onStderr: (line: string) => logging.logWorkerStderr(line),
    });

    const result = await client.run('fake.stderr', {});

    // ---- ③ 非零退出 → 失败必须可见（不是静默 ok）----
    assert.equal(result.ok, false, 'worker exit 2 必须算失败');
    assert.match(String(result.stderrTail), /RuntimeError: 假失败/, '★ 失败原因（stderr 尾巴）必须能追到');

    // ---- ①② stderr 进了日志文件 ----
    logging.close();
    const text = readLogs(logDir);
    assert.ok(text.length > 0, `日志文件必须存在且有内容（目录 ${logDir}）`);
    assert.match(text, /"source":"worker"/, 'worker stderr 必须以 source=worker 落盘');
    assert.match(text, /WORKER-STDERR-PROBE-OK/, '★ 正常 stderr 行必须在日志里');
    assert.match(text, /RuntimeError: 假失败/, '★ traceback 必须在日志里（关掉终端也还能查）');

    // ---- ② 超长行截断且如实标注 ----
    assert.ok(!text.includes('x'.repeat(900)), '超长行不该原样落盘（会刷爆日志）');
    assert.match(text, /WORKER-STDERR-LONG-x{0,600}/, '超长行应以截断形式出现');
    assert.match(text, /已截断，原 \d+ 字/, '截断必须**如实标注**（不许静默截断）');
  } finally {
    logging.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('★ 限速：worker 疯狂刷 stderr 时，日志不会被刷爆（丢弃计数可查）', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'kb-worker-flood-'));
  const logDir = join(workDir, 'logs');
  const workerPath = join(workDir, 'flood.py');
  writeFileSync(
    workerPath,
    'import json,sys\nprint(json.dumps({"type":"progress","pct":1}), flush=True)\n' +
      'for i in range(200):\n    sys.stderr.write("FLOOD-LINE-%d\\n" % i)\nsys.stderr.flush()\nsys.exit(0)\n',
    'utf8',
  );
  const logging = createAppLogging({ dir: logDir, level: 'info', stdout: false });
  try {
    const client = new WorkerClient({
      cwd: workDir,
      timeoutMs: 20_000,
      launcher: (job, paramsJson) => ({
        bin: process.env.PYTHON_BIN ?? 'python',
        args: [workerPath, '--job', job, '--in', paramsJson],
        cwd: workDir,
      }),
      onStderr: (line: string) => logging.logWorkerStderr(line),
    });
    await client.run('fake.flood', {});
    logging.close();
    const stats = logging.stats();
    assert.ok(stats.workerLines > 0, '至少要有若干条落盘');
    assert.ok(stats.workerDropped > 0, `★ 200 行里应有被限速丢弃的（实际 workerLines=${stats.workerLines} dropped=${stats.workerDropped}）`);
    const text = readLogs(logDir);
    assert.ok(!text.includes('FLOOD-LINE-199'), '被限速的行不该落盘');
    assert.match(text, /FLOOD-LINE-0/, '开头的行应当在');
  } finally {
    logging.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});
