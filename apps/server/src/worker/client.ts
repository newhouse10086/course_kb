/**
 * Python worker 调用器（`docs/ARCHITECTURE_V2.md` §3）。
 *
 * 职责边界：**Node 是编排者，Python 是计算器**。调用器只做四件事——
 *   1. `spawn("python", ["-m","worker.cli","--job",...])`（**不要 shell:true**：项目路径含空格+中文）
 *   2. 持续读 stdout，**按字节 `\n` 分帧**（坑 12，见 `framing.ts`；绝不用 readline）
 *   3. stderr 当**日志**，不当协议（§3.1）
 *   4. 超时 / 取消 / 僵尸进程回收
 *
 * 契约 §3.1：
 * ```text
 * stdin:  一个 JSON（任务参数）
 * stdout: 一行一个 JSON（进度/结果），严格 JSONL
 * stderr: 日志（非协议）
 * ```
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { JsonlFramer } from './framing.ts';
import { asWorkerEvent } from './protocol.ts';
import type { WorkerEvent, WorkerLogEvent } from './protocol.ts';

// ═══════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════

export interface WorkerLaunch {
  bin: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

/** 启动方式可注入 —— 生产用 `python -m worker.cli`，测试可换成假 worker 脚本。 */
export type Launcher = (job: string, paramsJson: string) => WorkerLaunch;

export interface WorkerRunOptions {
  /** 取消（HTTP `POST /tasks/{id}/cancel` 会用到）。 */
  signal?: AbortSignal;
  /** 覆盖客户端默认超时。 */
  timeoutMs?: number;
  /** 事件实时回调（进度/日志/增量 unit）—— 先订阅再发请求（坑 14）。 */
  onEvent?: (e: WorkerEvent) => void;
  /** stderr 行回调（**非协议**，仅日志）。 */
  onStderr?: (line: string) => void;
  /** 额外环境变量（如 HF_ENDPOINT 镜像）。 */
  env?: Record<string, string>;
}

export interface WorkerRunResult {
  ok: boolean;
  job: string;
  /** `{"type":"result","data":…}` 里的 data。 */
  result: Record<string, unknown> | null;
  error: { code: string; msg: string; detail?: string } | null;
  /** 增量 unit 事件（大文档流式入库）。 */
  units: Record<string, unknown>[];
  /** 最后一次 progress（进度可回溯）。 */
  lastProgress: { stage: string; frac: number; detail?: Record<string, unknown> } | null;
  progressCount: number;
  logs: WorkerLogEvent[];
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stderrTail: string;
  elapsedMs: number;
  cancelled: boolean;
  timedOut: boolean;
  /** 坏帧计数 + 首条原始内容（如实上报 `E_WORKER_PROTOCOL`，不静默吞）。 */
  badFrames: number;
  badFrameSamples: string[];
  pid: number | null;
  /** 超时/取消后子进程是否在宽限期内真的退出了。false = 可能残留（已尽力强杀）。 */
  reaped: boolean;
}

export interface WorkerClientOptions {
  pythonBin?: string;
  workerModule?: string;
  cwd: string;
  timeoutMs?: number;
  /** 宽限：SIGTERM 后等多久强杀（POSIX）；Windows 直接 taskkill /T /F。 */
  killGraceMs?: number;
  /** 强制等子进程退出的上限。 */
  reapMs?: number;
  launcher?: Launcher;
  onStderr?: (line: string) => void;
}

const STDERR_TAIL_BYTES = 4096;

// ═══════════════════════════════════════════════════════════════════════
// 默认启动方式
// ═══════════════════════════════════════════════════════════════════════

/**
 * argv 里**内联 JSON** 的长度上限（字节）。
 *
 * ⚠️ **Windows 命令行约 32 KB 上限**（实测：20 KB ok / 40 KB → `spawnSync error ENAMETOOLONG`）。
 * 超过这个值就必须把 payload 只走 **stdin**，否则 `spawn` 直接失败。
 *
 * 为什么阈值取 8 KB（而不是贴着 32 KB）：路径含中文、Node 到 CreateProcess 的编码放大、
 * 以及不同 Windows 版本差异都会吃掉余量 —— **宁可在小 payload 上多走一次 stdin，也不要偶发 ENAMETOOLONG**。
 * （原写法：无条件把整个 JSON 塞进 argv → 大文档（refman 2523 单元 ≈ 278 KB）必然启动失败。
 *   由 wiki-architect 在 2523 units 的 refman 上实测暴露，见 `--in -` 的修法。）
 */
export const ARGV_PAYLOAD_LIMIT_BYTES = 8 * 1024;

/**
 * 构造 worker 的 argv。**大 payload 只走 stdin**（argv 里放 `--in -`，worker 侧读 stdin）。
 *
 * `worker/cli.py` 已实测支持：`--in <file|JSON>`、`--in -`（读 stdin）、**缺省也读 stdin**。
 * 我们显式写 `--in -` 而不是省略：语义清楚，且不依赖"缺省行为"这种隐式约定。
 */
export function buildWorkerArgs(opts: { workerModule: string; job: string; paramsJson: string }): string[] {
  const head = ['-m', opts.workerModule, '--job', opts.job];
  const bytes = Buffer.byteLength(opts.paramsJson, 'utf8');
  if (bytes <= ARGV_PAYLOAD_LIMIT_BYTES) return [...head, '--in', opts.paramsJson];
  return [...head, '--in', '-'];
}

/**
 * 默认 `python -m worker.cli --job <job> --in <json>`（大 payload 自动改走 stdin）。
 *
 * ⚠️ Windows 上 `spawn("python", argv, {shell:false})` 是**正确**做法：
 * 本机项目路径含**空格 + 中文**（`D:\temp临时脚本\...`），`shell:true` 需要引号转义且有注入面
 * （契约 §7.5 Windows 实测同源教训）。
 */
export function defaultLauncher(opts: { pythonBin: string; workerModule: string; cwd: string; env?: Record<string, string> }): Launcher {
  return (job, paramsJson) => ({
    bin: opts.pythonBin,
    args: buildWorkerArgs({ workerModule: opts.workerModule, job, paramsJson }),
    cwd: opts.cwd,
    ...(opts.env ? { env: opts.env } : {}),
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 客户端
// ═══════════════════════════════════════════════════════════════════════

export class WorkerClient {
  private readonly launcher: Launcher;
  private readonly timeoutMs: number;
  private readonly killGraceMs: number;
  private readonly reapMs: number;
  private readonly onStderrDefault: ((line: string) => void) | undefined;

  /** 正在运行的子进程（用于 `cancelAll` / 进程退出兜底清理）。 */
  private readonly live = new Set<ChildProcessWithoutNullStreams>();

  constructor(opts: WorkerClientOptions) {
    this.launcher =
      opts.launcher ??
      defaultLauncher({
        pythonBin: opts.pythonBin ?? 'python',
        workerModule: opts.workerModule ?? 'worker.cli',
        cwd: opts.cwd,
      });
    this.timeoutMs = opts.timeoutMs ?? 4 * 60 * 60 * 1000;
    this.killGraceMs = opts.killGraceMs ?? 3000;
    this.reapMs = opts.reapMs ?? 5000;
    this.onStderrDefault = opts.onStderr;
  }

  get activeCount(): number {
    return this.live.size;
  }

  /** 强杀所有在跑的 worker（进程退出/测试收尾用，防僵尸）。 */
  cancelAll(reason = 'client shutting down'): void {
    for (const child of this.live) killTree(child, reason);
  }

  /**
   * 跑一个 worker job。**永不抛**（除编程错误外）：所有失败都变成 `ok:false` + 可读 `error`，
   * 便于上层如实降级（契约 §0 R3：全链失败要如实报错，绝不假装成功）。
   */
  async run(job: string, params: Record<string, unknown>, opts: WorkerRunOptions = {}): Promise<WorkerRunResult> {
    const started = Date.now();
    const paramsJson = JSON.stringify(params ?? {});
    const launch = this.launcher(job, paramsJson);

    const result: WorkerRunResult = {
      ok: false,
      job,
      result: null,
      error: null,
      units: [],
      lastProgress: null,
      progressCount: 0,
      logs: [],
      exitCode: null,
      exitSignal: null,
      stderrTail: '',
      elapsedMs: 0,
      cancelled: false,
      timedOut: false,
      badFrames: 0,
      badFrameSamples: [],
      pid: null,
      reaped: true,
    };

    // 已取消/超时的外部信号（先订阅再发请求，坑 14）
    if (opts.signal?.aborted) {
      result.cancelled = true;
      result.error = { code: 'E_WORKER', msg: 'worker 未启动：调用前已取消' };
      result.elapsedMs = Date.now() - started;
      return result;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.bin, launch.args, {
        cwd: launch.cwd,
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...launch.env, ...opts.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      result.error = {
        code: 'E_WORKER_UNAVAILABLE',
        msg: `无法启动 worker：${launch.bin} ${launch.args.slice(0, 2).join(' ')}`,
        detail: String(err),
      };
      result.elapsedMs = Date.now() - started;
      return result;
    }

    result.pid = child.pid ?? null;
    this.live.add(child);

    const framer = new JsonlFramer();
    let stderrTail = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    let timer: NodeJS.Timeout | undefined = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      killTree(child, `timeout ${timeoutMs}ms`);
    }, timeoutMs) : undefined;

    const onAbort = (): void => {
      cancelled = true;
      killTree(child, 'client cancel');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (err) {
        // 坏帧不静默丢弃：计数 + 留样本，最终如实上报 E_WORKER_PROTOCOL
        result.badFrames += 1;
        if (result.badFrameSamples.length < 3) result.badFrameSamples.push(line.slice(0, 200));
        void err;
        return;
      }
      const ev = asWorkerEvent(parsed);
      if (!ev) {
        result.badFrames += 1;
        if (result.badFrameSamples.length < 3) result.badFrameSamples.push(line.slice(0, 200));
        return;
      }
      switch (ev.type) {
        case 'progress':
          result.progressCount += 1;
          result.lastProgress = { stage: ev.stage, frac: ev.frac, ...(ev.detail ? { detail: ev.detail } : {}) };
          break;
        case 'log':
          result.logs.push(ev);
          break;
        case 'unit':
          result.units.push(ev.data);
          break;
        case 'result':
          result.result = ev.data;
          break;
        case 'error':
          result.error = { code: ev.code, msg: ev.msg, ...(ev.detail !== undefined ? { detail: ev.detail } : {}) };
          break;
      }
      try {
        opts.onEvent?.(ev);
      } catch {
        /* 回调异常不能影响协议读取 */
      }
    };

    // ★ 持续读 stdout（P2：不读会因背压卡死子进程）——立即挂监听，不等 spawn 完成
    child.stdout.on('data', (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = framer.push(chunk);
      } catch (err) {
        result.badFrames += 1;
        if (result.badFrameSamples.length < 3) result.badFrameSamples.push(String(err).slice(0, 200));
        killTree(child, 'frame too large');
        return;
      }
      for (const l of lines) handleLine(l);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
      const sink = opts.onStderr ?? this.onStderrDefault;
      if (sink) {
        for (const l of text.split('\n')) if (l.trim()) sink(l);
      }
    });

    // stdin 可能被提前关闭（worker 早退）→ EPIPE 不该炸掉整个调用
    child.stdin.on('error', () => { /* EPIPE: worker 已退出 */ });
    child.stdin.write(`${paramsJson}\n`);
    child.stdin.end();

    const exit = await new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((resolve) => {
      child.once('error', (err) => {
        if (!result.error) {
          result.error = { code: 'E_WORKER_UNAVAILABLE', msg: `worker 进程启动失败`, detail: String(err) };
        }
        resolve({ code: null, sig: null });
      });
      child.once('close', (code, sig) => resolve({ code, sig }));
      // 强杀兜底：宽限期后还没退 → 再杀一次（僵尸进程回收）
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (!settled && child.exitCode === null) killTree(child, 'hard reap');
        }, timeoutMs + this.killGraceMs + this.reapMs).unref?.();
      }
    });
    settled = true;

    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    opts.signal?.removeEventListener('abort', onAbort);
    this.live.delete(child);

    // 流结束：处理无换行结尾的残留帧
    for (const l of framer.flush()) handleLine(l);

    result.exitCode = exit.code;
    result.exitSignal = exit.sig;
    result.stderrTail = stderrTail;
    result.elapsedMs = Date.now() - started;
    result.timedOut = timedOut;
    result.cancelled = cancelled;

    // ── 结论判定（顺序即优先级：取消 > 超时 > worker 自报错误 > 退出码 > 成功）──
    if (cancelled) {
      result.ok = false;
      if (!result.error) result.error = { code: 'E_WORKER', msg: '任务已取消' };
    } else if (timedOut) {
      result.ok = false;
      result.error = {
        code: 'E_WORKER_TIMEOUT',
        msg: `worker 超时（${timeoutMs}ms）已终止`,
        detail: stderrTail.slice(-500),
      };
    } else if (result.error) {
      result.ok = false; // worker 通过协议自报的错误，原样保留 code/msg
    } else if (exit.code !== 0) {
      result.ok = false;
      result.error = {
        code: 'E_WORKER_EXIT',
        msg: `worker 异常退出（exit code ${exit.code ?? 'null'}${exit.sig ? `, signal ${exit.sig}` : ''}）`,
        detail: stderrTail.slice(-500) || '(stderr 为空)',
      };
    } else if (result.badFrames > 0 && result.result === null) {
      result.ok = false;
      result.error = {
        code: 'E_WORKER_PROTOCOL',
        msg: `worker 输出不是合法 JSONL（坏帧 ${result.badFrames} 条）`,
        detail: result.badFrameSamples.join(' | '),
      };
    } else if (result.result === null) {
      result.ok = false;
      result.error = {
        code: 'E_WORKER_PROTOCOL',
        msg: 'worker 退出码为 0，但没有输出 result 帧',
        detail: '契约 §3.1 要求以 {"type":"result","data":…} 收尾',
      };
    } else {
      result.ok = true;
    }
    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 杀进程（含进程树 —— worker 可能拉起 ffmpeg）
// ═══════════════════════════════════════════════════════════════════════

export function killTree(child: ChildProcessWithoutNullStreams, reason: string): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  void reason;
  if (process.platform === 'win32') {
    // Windows 没有进程组信号；taskkill /T 连子孙一起杀（worker 会拉 ffmpeg）
    try {
      const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        shell: false,
      });
      tk.on('error', () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
      });
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
}
