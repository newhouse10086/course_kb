/**
 * `WorkerRunner` —— provider 层（T-PROVIDERS）调用 Python worker 的**窄接口**。
 *
 * Lead 约定的签名（Provider 层只 `接收` 它，不 import 我的实现，避免耦合）：
 * ```ts
 * type WorkerRunner = (job: {
 *   job: string;                                  // 'asr' | 'parse' | …
 *   input: Record<string, unknown>;
 *   onEvent?: (e: Record<string, unknown>) => void;
 *   signal?: AbortSignal;
 * }) => Promise<Record<string, unknown>>;
 * ```
 *
 * 语义（**诚实降级**的落点，PROVIDERS §0 R1/R3）：
 * - `input.op === 'probe'`（健康探测）**永不抛**：worker 缺失/超时/报错一律返回
 *   `{ ok:false, reason:"可读原因" }`；成功则返回 worker 的 `result.data`。
 *   → 探测是"提问"，不该用异常表达"不可用"。
 * - 其他调用失败 → **抛 `ApiError`**（带契约 §8 的 code），让降级链把这一跳当"失败"处理。
 *   想改成不抛就用 `createWorkerRunner(client, { throwOnError: false })`。
 */

import { ApiError } from '../store/errors.ts';
import type { ErrorCode } from '../store/errors.ts';
import { WorkerClient } from './client.ts';
import type { WorkerRunResult } from './client.ts';
import type { WorkerEvent } from './protocol.ts';
import { redact } from '../config.ts';

export interface WorkerRunnerJob {
  job: string;
  input: Record<string, unknown>;
  onEvent?: (e: Record<string, unknown>) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type WorkerRunner = (job: WorkerRunnerJob) => Promise<Record<string, unknown>>;

export interface WorkerRunnerWithRaw extends WorkerRunner {
  /** 需要看 `exitCode`/`logs`/`stderrTail` 时用（诊断面板/测试）。 */
  raw(job: WorkerRunnerJob): Promise<WorkerRunResult>;
}

export interface WorkerRunnerOptions {
  /** 默认 true。false 时失败也不抛，返回 `{ok:false, code, reason}`。 */
  throwOnError?: boolean;
  /** 事件里 `msg`/`detail` 的脱敏开关（默认开：worker stderr 可能带路径/凭据）。 */
  redactEvents?: boolean;
  env?: Record<string, string>;
}

/** 把 worker 事件转成 provider 层好消费的朴素对象。 */
export function eventToRecord(e: WorkerEvent): Record<string, unknown> {
  switch (e.type) {
    case 'progress':
      return { type: 'progress', stage: e.stage, frac: e.frac, ...(e.detail ? { detail: e.detail } : {}) };
    case 'log':
      return { type: 'log', level: e.level, msg: e.msg };
    case 'unit':
      return { type: 'unit', data: e.data };
    case 'result':
      return { type: 'result', data: e.data };
    case 'error':
      return { type: 'error', code: e.code, msg: e.msg, ...(e.detail !== undefined ? { detail: e.detail } : {}) };
    default:
      return { type: 'unknown' };
  }
}

/** worker 的 error code 若已是契约码就透传，否则归到 `E_WORKER`。 */
function toContractCode(code: string): ErrorCode {
  const known: ErrorCode[] = [
    'E_NOFILE',
    'E_FORMAT',
    'E_TOOBIG',
    'E_NOTFOUND',
    'E_PARSE',
    'E_LLM',
    'E_LLM_SCHEMA',
    'E_ASR_LOAD',
    'E_FFMPEG',
    'E_BUSY',
    'E_WORKER',
    'E_WORKER_PROTOCOL',
    'E_WORKER_TIMEOUT',
    'E_WORKER_EXIT',
    'E_WORKER_UNAVAILABLE',
  ];
  return (known as string[]).includes(code) ? (code as ErrorCode) : 'E_WORKER';
}

function failureRecord(r: WorkerRunResult): Record<string, unknown> {
  const code = r.error?.code ?? 'E_WORKER';
  return {
    ok: false,
    code,
    reason: r.error?.msg ?? 'worker 调用失败',
    ...(r.error?.detail ? { detail: r.error.detail } : {}),
    ...(r.timedOut ? { timedOut: true } : {}),
    ...(r.cancelled ? { cancelled: true } : {}),
  };
}

export function createWorkerRunner(client: WorkerClient, opts: WorkerRunnerOptions = {}): WorkerRunnerWithRaw {
  const throwOnError = opts.throwOnError ?? true;
  const doRedact = opts.redactEvents ?? true;

  const raw = async (job: WorkerRunnerJob): Promise<WorkerRunResult> =>
    client.run(job.job, job.input, {
      ...(job.signal ? { signal: job.signal } : {}),
      ...(job.timeoutMs ? { timeoutMs: job.timeoutMs } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      onEvent: (e) => {
        if (!job.onEvent) return;
        const rec = eventToRecord(e);
        if (doRedact) {
          if (typeof rec.msg === 'string') rec.msg = redact(rec.msg);
          if (typeof rec.detail === 'string') rec.detail = redact(rec.detail);
        }
        job.onEvent(rec);
      },
    });

  const runner = (async (job: WorkerRunnerJob): Promise<Record<string, unknown>> => {
    const isProbe = job.input?.op === 'probe';
    const r = await raw(job);

    if (r.ok && r.result) return r.result;

    // 探测：永不抛 —— 返回可读不可用原因（provider 会把 reason 透给 /capabilities）
    if (isProbe) return failureRecord(r);

    if (!throwOnError) return failureRecord(r);

    const code = toContractCode(r.error?.code ?? 'E_WORKER');
    throw new ApiError(code, redact(r.error?.msg ?? `worker job ${job.job} 失败`), {
      ...(r.error?.detail ? { detail: redact(r.error.detail) } : {}),
      hint: r.timedOut
        ? '任务超时已被终止；可改用更小的模型或缩短输入后重试'
        : r.cancelled
          ? '任务已被取消'
          : 'worker 负责媒体/文档解析；详情见 detail（stderr 摘要）',
    });
  }) as WorkerRunnerWithRaw;

  runner.raw = raw;
  return runner;
}
