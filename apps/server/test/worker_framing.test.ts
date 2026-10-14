/**
 * worker 调用器：**切帧**（坑 12）+ 协议 + 超时/取消 + 僵尸回收。
 *
 * 用**真进程**（不是 mock）：测试运行时生成一个输出 JSONL 的假 worker 脚本，
 * 因为 `worker/cli.py` 由 T-WORKER 并行开发中，调用器不能等它（任务书要求"别等，自己造"）。
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';

import { JsonlFramer, parseJsonl } from '../src/worker/framing.ts';
import { ARGV_PAYLOAD_LIMIT_BYTES, buildWorkerArgs, WorkerClient } from '../src/worker/client.ts';
import type { WorkerEvent } from '../src/worker/protocol.ts';

// ═══════════════════════════════════════════════════════════════════════
// 假 worker（运行时生成到临时目录；不落进源码写域）
// ═══════════════════════════════════════════════════════════════════════

const FAKE_WORKER_SOURCE = String.raw`# -*- coding: utf-8 -*-
"""假 worker：只为验证 Node 侧调用器的协议/切帧/超时/取消，不涉及真实解析。

★ 关键：某些帧里含 **裸 U+2028 / U+2029**（ensure_ascii=False 写出的原始字节），
   这正是坑 12 的复现输入 —— 用 readline 读会错切帧。
"""
import json, sys, time

def emit(payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n"
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()

def main():
    argv = sys.argv[1:]
    job = argv[argv.index("--job") + 1] if "--job" in argv else "parse"
    raw_in = argv[argv.index("--in") + 1] if "--in" in argv else "{}"
    try:
        stdin_raw = sys.stdin.read()
    except Exception:
        stdin_raw = ""
    try:
        params = json.loads(raw_in)
    except Exception:
        params = {"_argv_parse_failed": raw_in[:80]}
    try:
        stdin_params = json.loads(stdin_raw.strip() or "{}")
    except Exception:
        stdin_params = {"_stdin_parse_failed": stdin_raw[:80]}

    if job == "parse":
        emit({"type": "log", "level": "info", "msg": "start " + str(params.get("doc_id"))})
        emit({"type": "progress", "stage": "parse", "frac": 0.25, "detail": {"page": 40}})
        emit({"type": "unit", "data": {"id": "unt_0001", "title": "第一章"}})
        # ★ 裸 U+2028 / U+2029：JSON 里合法，readline 会当成换行
        emit({"type": "log", "level": "warn",
              "msg": "行分隔符\u2028与段分隔符\u2029都在字符串里"})
        emit({"type": "progress", "stage": "extract", "frac": 1.0})
        emit({"type": "result", "data": {
            "echo_job": job, "echo_argv": params, "echo_stdin": stdin_params,
            "units": 3, "cards": 7, "marker": "完成\u2028尾"}})
    elif job == "slow":
        emit({"type": "progress", "stage": "asr", "frac": 0.1})
        time.sleep(120)
        emit({"type": "result", "data": {"never": True}})
    elif job == "fail":
        emit({"type": "progress", "stage": "parse", "frac": 0.5})
        emit({"type": "error", "code": "E_PARSE", "msg": "PDF 损坏", "detail": "bad xref"})
        sys.exit(4)
    elif job == "crash":
        sys.stderr.write("Traceback: boom\n")
        sys.exit(7)
    elif job == "badjson":
        sys.stdout.buffer.write(b"this is not json\n")
        sys.stdout.buffer.write(b"{\"type\":\"mystery\"}\n")
        sys.stdout.flush()
        sys.exit(0)
    elif job == "stderr-protocol":
        # stderr 上写"合法 JSONL" —— 调用器必须把它当日志，不能当协议
        sys.stderr.write(json.dumps({"type": "result", "data": {"from_stderr": True}}) + "\n")
        sys.stderr.flush()
        emit({"type": "result", "data": {"from_stdout": True}})
    elif job == "noresult":
        emit({"type": "progress", "stage": "x", "frac": 0.5})
    else:
        emit({"type": "error", "code": "E_FORMAT", "msg": "unknown job " + job})

if __name__ == "__main__":
    main()
`;

let tmpDir = '';
let fakeWorker = '';

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckb-fake-worker-'));
  fakeWorker = path.join(tmpDir, 'fake_worker.py');
  fs.writeFileSync(fakeWorker, FAKE_WORKER_SOURCE, 'utf8');
});

after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发占用，忽略 */
  }
});

function pythonBin(): string {
  const probe = spawnSync('python', ['--version'], { encoding: 'utf8' });
  assert.equal(probe.status, 0, `本机 python 必须可用（AGENTS.md §4 环境事实）：${probe.stderr}`);
  return 'python';
}

/** 用假 worker 脚本替换 `-m worker.cli`（注入 launcher，不 mock 行为：仍然真起进程）。 */
function clientFor(cwd: string, extra: { timeoutMs?: number; killGraceMs?: number; reapMs?: number } = {}): WorkerClient {
  return new WorkerClient({
    cwd,
    launcher: (job, paramsJson) => ({
      bin: pythonBin(),
      args: [fakeWorker, '--job', job, '--in', paramsJson],
      cwd,
    }),
    ...extra,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// ① 分帧：字节级 `\n`，U+2028/2029 不许当分隔符
// ═══════════════════════════════════════════════════════════════════════

test('JsonlFramer：按字节 \\n 切，含 U+2028/U+2029 的单帧不被切碎', () => {
  const frame = '{"msg":"a\u2028b\u2029c","n":1}';
  const bytes = Buffer.from(`${frame}\n{"n":2}\n`, 'utf8');

  const framer = new JsonlFramer();
  const lines = framer.push(bytes);
  assert.equal(lines.length, 2, '两行就是两帧，不能被 U+2028/2029 切成 3+ 帧');
  assert.equal(lines[0], frame, 'U+2028/U+2029 必须原样保留在帧内');
  assert.deepEqual(JSON.parse(lines[0] as string), { msg: 'a\u2028b\u2029c', n: 1 });
  assert.deepEqual(JSON.parse(lines[1] as string), { n: 2 });
  assert.equal(framer.pendingBytes, 0);
});

test('★ 坑 12 对照：同样字节，readline 切出 3 帧（错），字节级 \\n 切出 2 帧（对）', async () => {
  const bytes = Buffer.from('{"msg":"x\u2028y"}\n{"b":2}\n', 'utf8');

  // 对照实现：Node readline（**错误做法**，仅用于证明它真的会错切）
  const rlLines: string[] = [];
  const rl = readline.createInterface({ input: Readable.from([bytes]), crlfDelay: Infinity });
  for await (const line of rl) rlLines.push(line);

  const ours = new JsonlFramer().push(bytes);

  assert.equal(rlLines.length, 3, `readline 应错切成 3 帧（实测），实际 ${rlLines.length}`);
  assert.equal(ours.length, 2, `字节级 \\n 应切出 2 帧，实际 ${ours.length}`);

  // readline 的第 1 帧根本不是合法 JSON → 真实 worker 里就是"丢帧/解析失败"
  assert.throws(() => JSON.parse(rlLines[0] as string), 'readline 首帧必然是坏 JSON');
  for (const l of ours) assert.doesNotThrow(() => JSON.parse(l), '我们的每一帧都必须是合法 JSON');
});

test('JsonlFramer：跨 chunk 任意切分都不丢帧、不切坏多字节字符', () => {
  const payload = '{"msg":"中文\u2028分隔","n":42}\n{"msg":"第二帧"}\n';
  const bytes = Buffer.from(payload, 'utf8');

  // 逐字节喂（最恶劣的切分：每个多字节字符都被拆开）
  const oneByOne = new JsonlFramer();
  const collected: string[] = [];
  for (const b of bytes) collected.push(...oneByOne.push(Buffer.from([b])));
  assert.equal(collected.length, 2);
  assert.deepEqual(JSON.parse(collected[0] as string), { msg: '中文\u2028分隔', n: 42 });
  assert.deepEqual(JSON.parse(collected[1] as string), { msg: '第二帧' });

  // 与整体喂的结果一致
  const whole = new JsonlFramer().push(bytes);
  assert.deepEqual(collected, whole);
});

test('JsonlFramer：CRLF 兼容 + 结尾无换行的残留帧由 flush 取出', () => {
  const f = new JsonlFramer();
  const lines = f.push(Buffer.from('{"a":1}\r\n{"b":2}', 'utf8'));
  assert.deepEqual(lines, ['{"a":1}'], 'CRLF 要去掉 \\r；未结束的不算完整帧');
  assert.equal(f.pendingBytes, 7);
  assert.deepEqual(f.flush(), ['{"b":2}']);
  assert.equal(f.pendingBytes, 0);
});

test('JsonlFramer：坏行不静默丢弃（回调上报，供 E_WORKER_PROTOCOL 归因）', () => {
  const bad: string[] = [];
  const out = parseJsonl('{"ok":1}\nnot-json\n{"ok":2}\n', new JsonlFramer(), (line) => bad.push(line));
  assert.equal(out.length, 2);
  assert.deepEqual(bad, ['not-json']);
});

// ═══════════════════════════════════════════════════════════════════════
// ② 真进程：协议字段逐字断言
// ═══════════════════════════════════════════════════════════════════════

test('真进程：progress/log/unit/result 逐字断言，含 U+2028 的帧完整到达', async () => {
  const client = clientFor(tmpDir);
  const events: WorkerEvent[] = [];
  const params = { doc_id: 'doc_abc123', path: 'D:\\temp临时脚本\\手册.pdf' };
  const r = await client.run('parse', params, { onEvent: (e) => events.push(e) });

  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.exitCode, 0);
  assert.equal(r.cancelled, false);
  assert.equal(r.timedOut, false);
  assert.equal(r.badFrames, 0, '假 worker 的输出全是合法 JSONL');

  // 协议事件类型序列（体系结构 §3.1）
  assert.deepEqual(
    events.map((e) => e.type),
    ['log', 'progress', 'unit', 'log', 'progress', 'result'],
  );

  const p1 = events[1];
  assert.equal(p1?.type, 'progress');
  if (p1?.type === 'progress') {
    assert.equal(p1.stage, 'parse');
    assert.equal(p1.frac, 0.25);
    assert.deepEqual(p1.detail, { page: 40 });
  }

  const logSep = events[3];
  assert.equal(logSep?.type, 'log');
  if (logSep?.type === 'log') {
    assert.equal(logSep.msg.includes('\u2028'), true, 'U+2028 必须原样到达（没被当换行吃掉）');
    assert.equal(logSep.msg.includes('\u2029'), true, 'U+2029 必须原样到达');
  }

  // unit 增量产出
  assert.equal(r.units.length, 1);
  assert.deepEqual(r.units[0], { id: 'unt_0001', title: '第一章' });

  // 最后一次 progress
  assert.deepEqual(r.lastProgress, { stage: 'extract', frac: 1.0 });
  assert.equal(r.progressCount, 2);
  assert.equal(r.logs.length, 2);

  // result 逐字断言（含参数回环：argv 与 stdin 两条路都验）
  assert.equal(r.result?.echo_job, 'parse');
  assert.deepEqual(r.result?.echo_argv, params);
  assert.deepEqual(r.result?.echo_stdin, params, 'stdin 的 JSON 也要被 worker 读到');
  assert.equal(r.result?.units, 3);
  assert.equal(r.result?.cards, 7);
  assert.equal(r.result?.marker, '完成\u2028尾');
});

test('stderr 是**日志**不是协议（P3 / §3.1）：stderr 上的合法 JSONL 不许变成事件', async () => {
  const stderrLines: string[] = [];
  const client = clientFor(tmpDir);
  const r = await client.run('stderr-protocol', {}, { onStderr: (l) => stderrLines.push(l) });

  assert.equal(r.ok, true);
  assert.equal(r.result?.from_stdout, true);
  assert.equal(r.result?.from_stderr, undefined, 'stderr 的内容绝不能进 result');
  assert.equal(r.units.length, 0);
  assert.equal(r.logs.length, 0);
  assert.equal(stderrLines.length, 1);
  assert.equal(stderrLines[0]?.includes('from_stderr'), true);
});

test('worker 自报 error 帧：code/msg/detail 原样透传（不包成 E_WORKER_EXIT）', async () => {
  const client = clientFor(tmpDir);
  const r = await client.run('fail', {});
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 4);
  assert.deepEqual(r.error, { code: 'E_PARSE', msg: 'PDF 损坏', detail: 'bad xref' });
  assert.equal(r.lastProgress?.frac, 0.5, '失败前的进度要保留（断点续跑要用）');
});

test('非零退出且无 error 帧 → E_WORKER_EXIT + stderr 摘要', async () => {
  const client = clientFor(tmpDir);
  const r = await client.run('crash', {});
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 7);
  assert.equal(r.error?.code, 'E_WORKER_EXIT');
  assert.match(r.error?.msg ?? '', /exit code 7/);
  assert.match(r.stderrTail, /boom/, 'stderr 尾部要带进 detail 便于排查');
});

test('坏 JSONL → E_WORKER_PROTOCOL，并留下坏帧样本', async () => {
  const client = clientFor(tmpDir);
  const r = await client.run('badjson', {});
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'E_WORKER_PROTOCOL');
  assert.equal(r.badFrames, 2, '一行非 JSON + 一行未知 type，都要计入');
  assert.equal(r.badFrameSamples[0], 'this is not json');
});

test('退出码 0 但没有 result 帧 → 如实报协议不完整（不假装成功）', async () => {
  const client = clientFor(tmpDir);
  const r = await client.run('noresult', {});
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'E_WORKER_PROTOCOL');
  assert.match(r.error?.msg ?? '', /没有输出 result 帧/);
});

// ═══════════════════════════════════════════════════════════════════════
// ③ 超时 / 取消 / 僵尸回收
// ═══════════════════════════════════════════════════════════════════════

test('超时 → E_WORKER_TIMEOUT，且子进程真的被杀掉（不是放着不管）', async () => {
  const client = clientFor(tmpDir, { timeoutMs: 1200, killGraceMs: 200, reapMs: 1500 });
  const r = await client.run('slow', {});
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.error?.code, 'E_WORKER_TIMEOUT');
  assert.ok(r.elapsedMs < 30_000, `超时应立即终止，实际 ${r.elapsedMs}ms`);
  assert.equal(r.exitCode !== 0 || r.exitSignal !== null, true, '进程应被杀，不是正常退出');
  assert.equal(client.activeCount, 0, '调用器不应残留活动进程');

  // 真的没了：pid 已不存在
  if (r.pid) {
    const check = spawnSync('tasklist', ['/FI', `PID eq ${r.pid}`], { encoding: 'utf8' });
    if (check.status === 0) {
      assert.equal(check.stdout.includes(String(r.pid)), false, `PID ${r.pid} 仍存活 → 僵尸进程`);
    }
  }
});

test('AbortSignal 取消 → cancelled=true，进程被回收，不算"失败"但绝不 ok', async () => {
  const client = clientFor(tmpDir, { timeoutMs: 60_000, killGraceMs: 200, reapMs: 1500 });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 600);
  const r = await client.run('slow', {}, { signal: ac.signal });
  assert.equal(r.cancelled, true);
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, false);
  assert.equal(client.activeCount, 0);
});

// ═══════════════════════════════════════════════════════════════════════
// ④ 启动失败要说人话（E_WORKER_UNAVAILABLE）
// ═══════════════════════════════════════════════════════════════════════

test('解释器不存在 → E_WORKER_UNAVAILABLE + 可读原因（不抛异常）', async () => {
  const client = new WorkerClient({
    cwd: tmpDir,
    launcher: (_job, _json) => ({ bin: 'definitely-not-python-9x', args: ['--job', 'parse'], cwd: tmpDir }),
    timeoutMs: 5000,
  });
  const r = await client.run('parse', {});
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'E_WORKER_UNAVAILABLE');
  assert.match(r.error?.msg ?? '', /无法启动 worker|启动失败/);
});

test('调用前已 abort → 不启动进程，如实返回 cancelled', async () => {
  const client = clientFor(tmpDir);
  const ac = new AbortController();
  ac.abort();
  const r = await client.run('parse', {}, { signal: ac.signal });
  assert.equal(r.cancelled, true);
  assert.equal(r.ok, false);
  assert.equal(r.pid, null);
});

// ═══════════════════════════════════════════════════════════════════════
// ⑤ 大参数：走 argv + stdin 双通道都不出问题
// ═══════════════════════════════════════════════════════════════════════

test('大参数（含中文/引号/换行）经 argv+stdin 原样到达', async () => {
  const client = clientFor(tmpDir);
  const params = { doc_id: 'doc_big', note: '引号"与\\反斜杠\n换行\u2028分隔', n: 12345 };
  const r = await client.run('parse', params);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.result?.echo_argv, params);
  assert.deepEqual(r.result?.echo_stdin, params);
});

test('execFileSync 兜底：假 worker 脚本本身可独立运行（证明不是被调用器伪造的输出）', () => {
  const out = execFileSync(pythonBin(), [fakeWorker, '--job', 'parse', '--in', '{"doc_id":"x"}'], {
    encoding: 'utf8',
    input: '{"doc_id":"x"}',
  });
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 6);
  assert.equal((JSON.parse(lines[5] as string) as { type: string }).type, 'result');
});

// ═══════════════════════════════════════════════════════════════════════
// ⑥ 大 payload：argv 有 ~32 KB 上限 → 必须自动改走 stdin
//    （wiki-architect 在 2523 units 的 refman 上实测 ENAMETOOLONG 暴露）
// ═══════════════════════════════════════════════════════════════════════

test('buildWorkerArgs：小 payload 走 argv，**大 payload 只走 stdin**（不在 argv 里塞 JSON）', () => {
  const small = buildWorkerArgs({ workerModule: 'worker.cli', job: 'parse', paramsJson: '{"a":1}' });
  assert.deepEqual(small, ['-m', 'worker.cli', '--job', 'parse', '--in', '{"a":1}']);

  // 40 KB ≈ 实测会 ENAMETOOLONG 的量级
  const bigJson = JSON.stringify({ units: 'x'.repeat(40 * 1024) });
  assert.ok(Buffer.byteLength(bigJson, 'utf8') > 40_000);
  const big = buildWorkerArgs({ workerModule: 'worker.cli', job: 'extract.plan', paramsJson: bigJson });
  assert.deepEqual(big, ['-m', 'worker.cli', '--job', 'extract.plan', '--in', '-'], '大 payload 必须只传 --in -');
  assert.ok(
    big.every((a) => a.length < 100),
    'argv 里**不许**出现大 JSON',
  );
  const argvBytes = big.reduce((n, a) => n + Buffer.byteLength(a, 'utf8') + 1, 0);
  assert.ok(argvBytes < ARGV_PAYLOAD_LIMIT_BYTES + 200, `argv 必须远小于上限，实际 ${argvBytes}`);

  // 边界：刚好在阈值内 → 仍走 argv（不要"总是走 stdin"，那样小 job 也多一次不确定性）
  const edge = 'x'.repeat(ARGV_PAYLOAD_LIMIT_BYTES - 20);
  assert.equal(buildWorkerArgs({ workerModule: 'worker.cli', job: 'x', paramsJson: edge }).at(-1), edge);
  const over = 'x'.repeat(ARGV_PAYLOAD_LIMIT_BYTES + 20);
  assert.equal(buildWorkerArgs({ workerModule: 'worker.cli', job: 'x', paramsJson: over }).at(-1), '-');
});

test('★ 真 CLI 大 payload（40 KB）：`--in -` 走 stdin 后参数原样到达（证明修法有效）', async () => {
  // 用**真** worker/cli.py（course-kb 根为 cwd）+ 真实 stdin 通道
  const root = path.resolve(import.meta.dirname, '..', '..', '..');
  const client = new WorkerClient({ pythonBin: pythonBin(), workerModule: 'worker.cli', cwd: root, timeoutMs: 60_000 });
  const q = `索引${'优化'.repeat(20 * 1024)}`; // ≈ 40 KB 的中文查询串
  const payload = { q };
  assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') > 32 * 1024, 'payload 必须超过 Windows argv 上限才有意义');

  const r = await client.run('search', payload);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  // 真 CLI 回显：terms 是 bigram 词项（首项必为「索引」）
  assert.equal((r.result?.q as string).length, q.length, 'q 必须**原样**到达（长度一致）');
  assert.deepEqual((r.result?.terms as string[])[0], '索引');
  assert.match(String(r.result?.match_expr), /^"索引" AND "引优"/);
});

test('对照：同样的 40 KB payload 若塞进 argv → spawn 直接失败（证明为什么必须走 stdin）', () => {
  const root = path.resolve(import.meta.dirname, '..', '..', '..');
  const bigJson = JSON.stringify({ q: '索引'.repeat(20 * 1024) });
  const res = spawnSync(pythonBin(), ['-m', 'worker.cli', '--job', 'search', '--in', bigJson], {
    cwd: root,
    input: bigJson,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  // Windows: ENAMETOOLONG；其他平台可能成功 —— 两种都如实断言，不假装
  if (process.platform === 'win32') {
    assert.notEqual(res.error, undefined, 'Windows 上 40KB argv 必须报错（ENAMETOOLONG）');
    assert.match(String(res.error?.message ?? ''), /ENAMETOOLONG|too long/i);
  } else {
    assert.equal(res.status, 0, `非 Windows 上 argv 可能可用（本机 ${process.platform}）`);
  }
});
