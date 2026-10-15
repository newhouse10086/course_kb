/**
 * ★★ 看门狗 + 文档状态自愈（修复用户实测撞到的"队列被死任务堵死"）。
 *
 * ## 真实现象（用户撞到过，Lead 手动救过）
 * ```
 * 关机/重启后，任务卡在 `running` **永远不动** → **队列被堵住，后面的任务全排不上**
 * （Lead 手动把两条 `extracting → ready` 才恢复）
 * ```
 * ## 真因
 * 任务**没有心跳、没有超时**：进程重启后，旧任务**无人接管、也无人判死**。
 *
 * ## 本模块做什么（两件事，都**如实记录**，不静默改状态）
 * 1. `sweepStale()`：`running` 且**最后心跳**超过阈值的任务 → 判失败（写**可读 reason**）+ 记日志
 * 2. `healDocuments()`：`documents.status='extracting'` **且没有任何 running 任务** → 改回 `ready`
 *
 * ## ⚠️ 三条边界（每条都有测试盯着）
 * - **慢 ≠ 死**：OCR 434 页 ~40 分钟。判据用"**最后心跳**"，且阈值（默认 30 分钟）
 *   必须大于单步最长耗时；运行期由 `queue` 定时续命（见 `TaskQueue` 的心跳定时器）。
 * - **反例（防误杀）**：心跳**新鲜**的 running 任务**绝不许**被判死。
 * - **自愈不许"看到 extracting 就改"**：必须先确认它**真的没有在跑的任务**，
 *   否则会把正在跑的判死（那比不改更糟 —— 用户会以为好了，其实任务还在写数据）。
 */

import type { Repo } from '../store/repo.ts';
import type { TaskRow } from '../store/repo.ts';

/** 默认判死阈值：30 分钟（**必须大于单步最长耗时**；OCR 434 页 ~40 分钟的场景靠心跳续命） */
export const DEFAULT_STALE_MS = 30 * 60 * 1000;

export interface WatchdogLogger {
  info?: (obj: Record<string, unknown>, msg: string) => void;
  warn?: (obj: Record<string, unknown>, msg: string) => void;
}

export interface WatchdogOptions {
  repo: Repo;
  /** 判死阈值（ms）。`COURSE_KB_TASK_STALE_MS` 覆盖；默认 30 分钟 */
  staleMs?: number;
  logger?: WatchdogLogger | null;
  /** 便于测试注入时间 */
  now?: () => number;
  /** 文档自愈的"目标状态"（默认 `ready`，与契约一致） */
  healedDocStatus?: string;
}

export interface StaleSweepResult {
  /** 被判死的任务 id */
  killed: string[];
  /** 心跳新鲜、**故意不动**的任务 id（反例防误杀，结果里列出来便于断言/排障） */
  alive: string[];
  cutoff: number;
}

export interface DocHealResult {
  /** 被改回 `ready` 的文档 id */
  healed: string[];
  /** 状态是 `extracting` 但**确实有 running 任务** → 不动（不许误判） */
  keptRunning: string[];
}

export interface Watchdog {
  /** 判死超时的 running 任务，并**释放队列** */
  sweepStale: () => StaleSweepResult;
  /** 孤儿 `extracting` 文档自愈 */
  healDocuments: () => DocHealResult;
  /** 启动时一次做完两件事（返回两个结果，便于测试与日志） */
  runStartup: () => { stale: StaleSweepResult; docs: DocHealResult };
  staleMs: number;
}

/** 人类可读的时长（日志/错误文案里用；"2h 5m"这种） */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
}

export function createTaskWatchdog(opts: WatchdogOptions): Watchdog {
  const now = opts.now ?? ((): number => Date.now());
  const staleMs = Math.max(1, Math.trunc(opts.staleMs ?? DEFAULT_STALE_MS));
  const log = opts.logger ?? null;
  const healedStatus = opts.healedDocStatus ?? 'ready';

  const sweepStale = (): StaleSweepResult => {
    const cutoff = now() - staleMs;
    const candidates = opts.repo.staleRunningTasks(cutoff);
    const killed: string[] = [];
    // ★ 只为"真的被判死"的 id 记账；同时把"存活"的列出来（便于反例断言与排障）
    const staleIds = new Set(candidates.map((t) => t.id));
    const alive = opts.repo
      .runningTaskRows()
      .filter((t) => !staleIds.has(t.id))
      .map((t) => t.id);

    for (const task of candidates) {
      const lastBeat = task.heartbeat_at ?? task.created_at;
      const over = now() - lastBeat;
      // ★ 可读 reason（不许静默改状态）：说清"谁、多久没心跳、阈值多少、可能原因"
      const reason =
        `任务超时（进程重启或 worker 无响应）：最后心跳 ${new Date(lastBeat).toLocaleString('zh-CN')}` +
        `，已 ${formatDuration(over)} 无更新（判死阈值 ${formatDuration(staleMs)}）` +
        `${task.heartbeat_at === null ? '；该任务没有心跳记录（早于 v8 的旧任务）' : ''}`;
      opts.repo.updateTask(task.id, { status: 'failed', error: reason, progress: 0, stage: '已超时判失败' });
      killed.push(task.id);
      log?.warn?.(
        {
          event: 'task-watchdog',
          task_id: task.id,
          doc_id: task.doc_id,
          kind: task.kind,
          last_heartbeat_at: lastBeat,
          stale_ms: over,
          threshold_ms: staleMs,
          reason,
        },
        'stale task marked failed (watchdog)',
      );
    }
    if (candidates.length === 0) {
      log?.info?.(
        { event: 'task-watchdog', killed: 0, alive: alive.length, threshold_ms: staleMs },
        'no stale task found',
      );
    }
    return { killed, alive, cutoff };
  };

  const healDocuments = (): DocHealResult => {
    // ★ 判据是"**真的没有 running 任务**"，不是"状态是 extracting" —— 见文件头注释
    const runningDocIds = new Set(
      opts.repo
        .runningTaskRows()
        .map((t) => t.doc_id)
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    );
    const docs = opts.repo.documentsByStatus('extracting');
    const healed: string[] = [];
    const keptRunning: string[] = [];
    for (const doc of docs) {
      if (runningDocIds.has(doc.id)) {
        keptRunning.push(doc.id); // 真的在跑 → 一个都不许动
        continue;
      }
      opts.repo.updateDocument(doc.id, { status: healedStatus });
      healed.push(doc.id);
      log?.warn?.(
        {
          event: 'doc-self-heal',
          doc_id: doc.id,
          from: 'extracting',
          to: healedStatus,
          reason: '启动自愈：该文档没有任何 running 任务（进程重启后残留的 extracting 状态）',
        },
        'orphan extracting document healed to ready',
      );
    }
    if (docs.length === 0) {
      log?.info?.({ event: 'doc-self-heal', healed: 0, kept: 0 }, 'no orphan extracting document');
    }
    return { healed, keptRunning };
  };

  return {
    sweepStale,
    healDocuments,
    runStartup(): { stale: StaleSweepResult; docs: DocHealResult } {
      // 顺序有意义：**先判死任务**，再自愈文档 ——
      // 否则"刚被判死的任务"所属文档会因为仍有 running 行而被跳过（白等一轮）。
      const stale = sweepStale();
      const docs = healDocuments();
      return { stale, docs };
    },
    staleMs,
  };
}

/** 从任务行取"最后心跳"（诊断/测试用；无心跳回落到创建时间，与 SQL 判据保持一致）。 */
export function lastHeartbeatOf(task: TaskRow): number {
  return task.heartbeat_at ?? task.created_at;
}
