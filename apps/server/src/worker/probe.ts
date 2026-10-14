/**
 * Python worker 能力探测（`/capabilities` 的 `worker` 段）。
 *
 * 契约 §7.5 的同源教训（pi 那边已踩过）：**"命令在" ≠ "能用"**。
 * 只看文件存在会给**假绿**，所以这里做**真执行**：
 *   1. `python --version`               → 解释器真的能跑吗
 *   2. `python -c "import worker.cli"`   → worker 模块真的能 import 吗（cwd = course-kb 根）
 *
 * 结果缓存 300s（与 PROVIDERS §0 R2 的"真探测"要求一致：探测要真，但不能每个请求都起进程）。
 */

import { spawn } from 'node:child_process';

export interface ProbeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
  elapsedMs: number;
}

export interface WorkerCapability {
  available: boolean;
  bin: string;
  module: string;
  pythonVersion: string | null;
  moduleImportable: boolean;
  reason: string;
  checkedAt: number;
  cached: boolean;
  probes: { python: ProbeResult; module: ProbeResult };
}

function runOnce(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: '', code: null, error: String(err), elapsedMs: Date.now() - started });
      return;
    }
    const done = (r: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      done({ ok: false, stdout, stderr, code: null, error: `探测超时（${timeoutMs}ms）`, elapsedMs: Date.now() - started });
    }, timeoutMs);
    (child.stdout as NodeJS.ReadableStream).on('data', (c: Buffer) => {
      stdout = (stdout + c.toString('utf8')).slice(-4096);
    });
    (child.stderr as NodeJS.ReadableStream).on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-4096);
    });
    child.on('error', (err) => {
      done({ ok: false, stdout, stderr, code: null, error: String(err), elapsedMs: Date.now() - started });
    });
    child.on('close', (code) => {
      done({ ok: code === 0, stdout, stderr, code, elapsedMs: Date.now() - started });
    });
  });
}

let cache: { at: number; value: WorkerCapability } | null = null;

export interface ProbeWorkerOptions {
  pythonBin?: string;
  module?: string;
  cwd: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  force?: boolean;
}

/**
 * 真探测 worker 可用性。**不抛**：探测失败本身就是"不可用 + 可读 reason"。
 *
 * `available` 仅当 **解释器可跑 + 模块可 import** 才为 true。
 * 模块还没交付时（T-WORKER 在写 `worker/cli.py`）会如实报 false + 具体原因，**不假装可用**。
 */
export async function probeWorker(opts: ProbeWorkerOptions): Promise<WorkerCapability> {
  const bin = opts.pythonBin ?? 'python';
  const module = opts.module ?? 'worker.cli';
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const ttl = opts.cacheTtlMs ?? 300_000;

  if (!opts.force && cache && Date.now() - cache.at < ttl) {
    return { ...cache.value, cached: true };
  }

  const py = await runOnce(bin, ['--version'], opts.cwd, timeoutMs);
  const pyVersion = (py.stdout || py.stderr).trim().split('\n')[0] || null;

  let modProbe: ProbeResult = {
    ok: false,
    stdout: '',
    stderr: '',
    code: null,
    error: '跳过（解释器不可用）',
    elapsedMs: 0,
  };
  if (py.ok) {
    // cwd = course-kb 根 → `import worker.cli` 能证明「模块在 + 依赖能 import」
    modProbe = await runOnce(
      bin,
      ['-c', `import importlib,sys; importlib.import_module(${JSON.stringify(module)}); print("ok")`],
      opts.cwd,
      timeoutMs,
    );
  }

  const moduleImportable = modProbe.ok && modProbe.stdout.includes('ok');
  let reason = '';
  if (!py.ok) {
    reason = `Python 解释器不可用：${bin} ${py.error ?? `exit ${py.code}`}${py.stderr ? `（${py.stderr.trim().slice(0, 200)}）` : ''}`;
  } else if (!moduleImportable) {
    const detail = (modProbe.stderr || modProbe.stdout).trim().split('\n').slice(-3).join(' / ').slice(0, 300);
    reason = `worker 模块 ${module} 无法 import（${detail || modProbe.error || `exit ${modProbe.code}`}）—— 媒体/文档解析不可用`;
  }

  const value: WorkerCapability = {
    available: Boolean(py.ok && moduleImportable),
    bin,
    module,
    pythonVersion: pyVersion,
    moduleImportable,
    reason,
    checkedAt: Date.now(),
    cached: false,
    probes: { python: py, module: modProbe },
  };
  cache = { at: Date.now(), value };
  return value;
}

/** 测试用：清缓存。 */
export function clearWorkerProbeCache(): void {
  cache = null;
}
