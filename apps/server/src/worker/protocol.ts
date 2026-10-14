/**
 * Python worker 的 JSONL 协议类型（`docs/ARCHITECTURE_V2.md` §3.1）。
 *
 * ```text
 * Node:  spawn("python", ["-m","worker.cli","--job","parse","--in","<json>"], ...)
 *        stdin:  一个 JSON（任务参数）
 *        stdout: 一行一个 JSON（进度/结果），**严格 JSONL**
 *        stderr: 日志（非协议）
 * ```
 */

export type WorkerEventType = 'progress' | 'log' | 'unit' | 'result' | 'error';

export interface WorkerProgressEvent {
  type: 'progress';
  stage: string;
  frac: number;
  detail?: Record<string, unknown>;
}

export interface WorkerLogEvent {
  type: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
}

/** 增量产出（可选，用于大文档流式入库）。 */
export interface WorkerUnitEvent {
  type: 'unit';
  data: Record<string, unknown>;
}

export interface WorkerResultEvent {
  type: 'result';
  data: Record<string, unknown>;
}

export interface WorkerErrorEvent {
  type: 'error';
  code: string;
  msg: string;
  detail?: string;
}

export type WorkerEvent =
  | WorkerProgressEvent
  | WorkerLogEvent
  | WorkerUnitEvent
  | WorkerResultEvent
  | WorkerErrorEvent;

const KNOWN_TYPES: ReadonlySet<string> = new Set(['progress', 'log', 'unit', 'result', 'error']);

/** 事件类型守卫：坏帧（缺 type / 未知 type）返回 null，由调用方如实上报。 */
export function asWorkerEvent(value: unknown): WorkerEvent | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const t = obj.type;
  if (typeof t !== 'string' || !KNOWN_TYPES.has(t)) return null;
  switch (t) {
    case 'progress': {
      if (typeof obj.stage !== 'string') return null;
      const frac = typeof obj.frac === 'number' ? obj.frac : Number(obj.frac);
      if (!Number.isFinite(frac)) return null;
      const ev: WorkerProgressEvent = { type: 'progress', stage: obj.stage, frac };
      if (obj.detail && typeof obj.detail === 'object') {
        ev.detail = obj.detail as Record<string, unknown>;
      }
      return ev;
    }
    case 'log': {
      if (typeof obj.msg !== 'string') return null;
      const lvl = obj.level;
      const level: WorkerLogEvent['level'] =
        lvl === 'debug' || lvl === 'info' || lvl === 'warn' || lvl === 'error' ? lvl : 'info';
      return { type: 'log', level, msg: obj.msg };
    }
    case 'unit': {
      if (!obj.data || typeof obj.data !== 'object') return null;
      return { type: 'unit', data: obj.data as Record<string, unknown> };
    }
    case 'result': {
      if (!obj.data || typeof obj.data !== 'object') return null;
      return { type: 'result', data: obj.data as Record<string, unknown> };
    }
    case 'error': {
      const code = typeof obj.code === 'string' && obj.code ? obj.code : 'E_WORKER';
      const msg = typeof obj.msg === 'string' ? obj.msg : '(worker 未提供 msg)';
      const ev: WorkerErrorEvent = { type: 'error', code, msg };
      if (typeof obj.detail === 'string') ev.detail = obj.detail;
      return ev;
    }
    default:
      return null;
  }
}

/** worker 的 job 名（与契约 §2.6 `Task.kind` 同集合，另加 video 相关）。 */
export const WORKER_JOBS = [
  'parse',
  'extract',
  'rollup',
  'translate',
  'asr',
  'slides',
  'mindmap',
  'index',
  'video',
] as const;
export type WorkerJob = (typeof WORKER_JOBS)[number];
