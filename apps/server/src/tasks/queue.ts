/**
 * 任务队列（契约 §2.6 / C1 / C4）。
 *
 * - **并发 = 1**（用户硬要求，契约 C1）：`concurrency` 默认 1，队列串行执行
 * - **长任务断点**（契约 C4）：任务落盘在 `tasks` 表；`recover()` 把重启前
 *   `running` 的任务**重新入队**（而不是丢掉），`done/failed/cancelled` 不动
 * - **诚实结束**：未知 kind / 处理器抛错 / 取消，分别落成 `failed` / `failed` / `cancelled`，
 *   并推对应 SSE 帧；**绝不静默成功**
 */

import { ApiError } from '../store/errors.ts';
import type { Repo } from '../store/repo.ts';
import { TaskEventBus } from './bus.ts';

export interface TaskHandlerContext {
  taskId: string;
  docId: string | null;
  kind: string;
  params: Record<string, unknown>;
  signal: AbortSignal;
  /**
   * RBAC §5：任务发起者（系统任务为 null）。审计与配额都用它。
   * ⚠️ **声明为可选**是为了不破坏其他 handler 的单测 mock（队列总是会填上它）。
   */
  userId?: string | null;
  /** 上报进度（写库 + 推 SSE）。`detail` 里的 done/total 会进 SSE 帧。 */
  progress(frac: number, stage: string, detail?: Record<string, unknown>): void;
  log(msg: string, level?: 'debug' | 'info' | 'warn' | 'error'): void;
  /** 产出物通知（契约 §6 的 `artifact` 事件）。 */
  artifact(kind: string, url: string): void;
}

/** 返回值写进 `tasks.detail`（与解析统计合并）。 */
export type TaskHandler = (ctx: TaskHandlerContext) => Promise<Record<string, unknown>>;

export interface TaskQueueOptions {
  repo: Repo;
  bus: TaskEventBus;
  handlers: Record<string, TaskHandler>;
  concurrency?: number;
  /**
   * RBAC §5：每用户并发配额（学生 1 / 教师 2 / 管理员不限）。
   * 由 `index.ts` 注入（它知道怎么按 userId 查角色）；默认 1（最保守）。
   */
  resolveQuota?: (userId: string) => number;
}

interface QueueItem {
  taskId: string;
  docId: string | null;
  kind: string;
  params: Record<string, unknown>;
  /** RBAC §5：越小越先（0 = 教师/系统，1 = 学生） */
  priority: number;
  userId: string | null;
  /** 同级 FIFO 的稳定序（不用系统时钟，避免同毫秒乱序） */
  seq: number;
}

export class TaskQueue {
  private readonly repo: Repo;
  private readonly bus: TaskEventBus;
  private readonly handlers: Record<string, TaskHandler>;
  private readonly concurrency: number;
  private readonly resolveQuota: (userId: string) => number;
  private readonly pending: QueueItem[] = [];
  private readonly active = new Map<string, AbortController>();
  /** 每个用户"在跑"的任务数（配额判定用；不含 pending，pending 从数组现算） */
  private readonly activeByUser = new Map<string, number>();
  private seq = 0;
  private stopped = false;

  constructor(opts: TaskQueueOptions) {
    this.repo = opts.repo;
    this.bus = opts.bus;
    this.handlers = opts.handlers;
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.resolveQuota = opts.resolveQuota ?? (() => 1);
  }

  /**
   * 入队：落盘 `queued` + 推初始帧 + 调度。返回 taskId。
   *
   * RBAC §5：`priority`（0 教师/系统 > 1 学生）与 `userId` 决定**调度顺序**与**配额**。
   * 超配额 → 抛 `E_QUOTA`（429），**不静默排队到天荒地老**。
   */
  enqueue(input: {
    docId?: string | null;
    kind: string;
    params?: Record<string, unknown>;
    taskId?: string;
    priority?: number;
    userId?: string | null;
  }): string {
    if (this.stopped) throw new ApiError('E_BUSY', '任务队列已停止', { hint: '服务正在关闭' });
    const userId = input.userId ?? null;
    const priority = Number.isFinite(input.priority) ? Number(input.priority) : 0;

    // ★ 配额：在**入队前**判，而不是让它排着
    if (userId) {
      const quota = this.resolveQuota(userId);
      if (Number.isFinite(quota)) {
        const used = this.activeCountFor(userId) + this.pendingCountFor(userId);
        if (used >= quota) {
          throw new ApiError('E_QUOTA', `并发任务已达配额（${used}/${quota}）`, {
            detail: `user_id=${userId} quota=${quota}`,
            hint: '等当前任务结束再试；教师/管理员配额更高（LLM 并发=1 是全局限制，队列必须优先保障教学任务）',
          });
        }
      }
    }

    const taskId = this.repo.insertTask({
      ...(input.taskId ? { id: input.taskId } : {}),
      docId: input.docId ?? null,
      kind: input.kind,
      status: 'queued',
      detail: { params: input.params ?? {} },
      priority,
      userId,
    });
    this.bus.publish(taskId, 'progress', {
      task_id: taskId,
      progress: 0,
      stage: '排队中',
      kind: input.kind,
      priority,
    });
    this.seq += 1;
    this.pending.push({
      taskId,
      docId: input.docId ?? null,
      kind: input.kind,
      params: input.params ?? {},
      priority,
      userId,
      seq: this.seq,
    });
    this.sortPending();
    this.pump();
    return taskId;
  }

  /** 优先级升序；同级按入队序（FIFO）。 */
  private sortPending(): void {
    this.pending.sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.seq - b.seq));
  }

  private activeCountFor(userId: string): number {
    return this.activeByUser.get(userId) ?? 0;
  }

  private pendingCountFor(userId: string): number {
    return this.pending.filter((p) => p.userId === userId).length;
  }

  /** 诊断用：某用户当前占用的配额。 */
  quotaUsage(userId: string): { active: number; pending: number; used: number; quota: number } {
    const active = this.activeCountFor(userId);
    const pending = this.pendingCountFor(userId);
    return { active, pending, used: active + pending, quota: this.resolveQuota(userId) };
  }

  /** 待跑任务概要（**按真实调度顺序**；测试断言"学生任务不饿死教师任务"用）。 */
  pendingSummary(): { taskId: string; kind: string; priority: number; userId: string | null }[] {
    this.sortPending();
    return this.pending.map((p) => ({ taskId: p.taskId, kind: p.kind, priority: p.priority, userId: p.userId }));
  }

  /** 取消：queued → 直接置 cancelled；running → abort（由 runner 收尾成 cancelled）。 */
  cancel(taskId: string): boolean {
    const row = this.repo.getTaskRow(taskId);
    if (!row) return false;
    const status = String(row.status);
    if (status === 'done' || status === 'failed' || status === 'cancelled') return false;

    const idx = this.pending.findIndex((p) => p.taskId === taskId);
    if (idx >= 0) {
      this.pending.splice(idx, 1);
      this.repo.updateTask(taskId, { status: 'cancelled', stage: '已取消', progress: 0 });
      this.bus.publish(taskId, 'done', { task_id: taskId, status: 'cancelled', elapsed_ms: 0 });
      this.bus.finish(taskId);
      return true;
    }

    const ac = this.active.get(taskId);
    if (ac) {
      ac.abort();
      return true;
    }
    // 状态是 running 但不在本进程（重启前遗留）→ 直接置取消
    this.repo.updateTask(taskId, { status: 'cancelled', stage: '已取消（进程重启前遗留）' });
    this.bus.publish(taskId, 'done', { task_id: taskId, status: 'cancelled', elapsed_ms: 0 });
    this.bus.finish(taskId);
    return true;
  }

  /**
   * 重启恢复（契约 C4 断点）：`running` → 重新入队；`queued` → 继续排队。
   * 返回被恢复的 taskId 列表（如实上报恢复了几条）。
   *
   * RBAC §5：**保留 priority / user_id** —— 否则重启后学生的历史任务会插到教师前面。
   */
  recover(): string[] {
    const recovered: string[] = [];
    for (const t of this.repo.listTasks({ status: 'running', limit: 500 })) {
      const detail = { ...t.detail, recovered: true, recovered_at: Date.now() };
      this.repo.updateTask(t.id, { status: 'queued', stage: '重启后恢复', detail });
      this.pushRecovered(t.id, t.doc_id, t.kind, t.detail?.params as Record<string, unknown>, t.priority, t.user_id);
      recovered.push(t.id);
    }
    for (const t of this.repo.listTasks({ status: 'queued', limit: 500 })) {
      if (recovered.includes(t.id)) continue;
      if (this.pending.some((p) => p.taskId === t.id)) continue;
      this.pushRecovered(t.id, t.doc_id, t.kind, t.detail?.params as Record<string, unknown>, t.priority, t.user_id);
      recovered.push(t.id);
    }
    this.sortPending();
    this.pump();
    return recovered;
  }

  private pushRecovered(
    taskId: string,
    docId: string | null,
    kind: string,
    params: Record<string, unknown> | undefined,
    priority: number | undefined,
    userId: string | null | undefined,
  ): void {
    this.seq += 1;
    this.pending.push({
      taskId,
      docId,
      kind,
      params: params ?? {},
      priority: Number.isFinite(priority) ? Number(priority) : 0,
      userId: userId ?? null,
      seq: this.seq,
    });
  }

  status(taskId: string): string | undefined {
    return this.repo.getTaskRow(taskId)?.status;
  }

  running(): string[] {
    return [...this.active.keys()];
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  isIdle(): boolean {
    return this.active.size === 0 && this.pending.length === 0;
  }

  /** 等队列跑空（测试/优雅关停用）。 */
  async drained(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.isIdle()) {
      if (Date.now() > deadline) {
        throw new Error(`队列在 ${timeoutMs}ms 内未跑空：active=${this.running().join(',')} pending=${this.pending.length}`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  stop(): void {
    this.stopped = true;
    for (const ac of this.active.values()) ac.abort();
    this.pending.length = 0;
  }

  /**
   * 优雅关停：`stop()` 之后**等在跑的任务收尾**再返回。
   *
   * ⚠️ 为什么必须等：任务收尾会写 `tasks` 行（状态/progress）。若不等就 `db.close()`，
   * 收尾写入撞上已关闭的连接 → 抛「database connection is not open」，
   * 而且是**异步**抛出（unhandledRejection），会污染**别的**测试/请求的结论。
   */
  async shutdown(timeoutMs = 5000): Promise<{ timedOut: boolean; stillActive: string[] }> {
    this.stop();
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return { timedOut: this.active.size > 0, stillActive: [...this.active.keys()] };
  }

  // ── 内部 ───────────────────────────────────────────────────────────

  private pump(): void {
    while (!this.stopped && this.active.size < this.concurrency && this.pending.length > 0) {
      this.sortPending(); // 每次取之前重排：新入队的高优先级任务能"插队"
      const item = this.pending.shift() as QueueItem;
      void this.execute(item);
    }
  }

  /** 释放一个任务的占用（active 计数 + 用户配额计数），然后继续调度。 */
  private release(taskId: string, userId: string | null): void {
    this.active.delete(taskId);
    if (userId) {
      const n = (this.activeByUser.get(userId) ?? 1) - 1;
      if (n <= 0) this.activeByUser.delete(userId);
      else this.activeByUser.set(userId, n);
    }
    this.pump();
  }

  /** 释放一个任务的占用（active 计数 + 用户配额计数），然后继续调度。 */
  private async execute(item: QueueItem): Promise<void> {
    const { taskId } = item;
    // 入队后可能已被取消（pending 里被摘掉的不会走到这里；双保险）
    const row = this.repo.getTaskRow(taskId);
    if (!row || row.status === 'cancelled') return;

    const ac = new AbortController();
    this.active.set(taskId, ac);
    if (item.userId) this.activeByUser.set(item.userId, (this.activeByUser.get(item.userId) ?? 0) + 1);
    const startedAt = Date.now();

    const handler = this.handlers[item.kind];
    const params = { ...item.params, ...((row.detail_json ? safeParse(row.detail_json).params : {}) ?? {}) };
    let lastProgress = 0;
    let extraDetail: Record<string, unknown> = {};

    const ctx: TaskHandlerContext = {
      taskId,
      docId: item.docId,
      kind: item.kind,
      params,
      signal: ac.signal,
      userId: item.userId,
      progress: (frac, stage, detail) => {
        const f = Math.max(0, Math.min(1, frac));
        lastProgress = f;
        if (detail) extraDetail = { ...extraDetail, ...detail };
        this.repo.updateTask(taskId, { progress: f, stage, status: 'running' });
        const frame: Record<string, unknown> = { task_id: taskId, progress: f, stage };
        if (detail && typeof detail.done === 'number') frame.done = detail.done;
        if (detail && typeof detail.total === 'number') frame.total = detail.total;
        this.bus.publish(taskId, 'progress', frame);
        void detail;
      },
      log: (msg, level = 'info') => {
        this.bus.publish(taskId, 'log', { task_id: taskId, level, msg });
      },
      artifact: (kind, url) => {
        this.bus.publish(taskId, 'artifact', { task_id: taskId, kind, url });
      },
    };

    this.repo.updateTask(taskId, { status: 'running', stage: '启动中' });

    if (!handler) {
      const msg = `没有注册 kind=${item.kind} 的处理器（可用：${Object.keys(this.handlers).sort().join(', ') || '(空)'}）`;
      this.repo.updateTask(taskId, { status: 'failed', error: msg, stage: '失败' });
      this.bus.publish(taskId, 'failed', { task_id: taskId, error: msg, code: 'E_INTERNAL' });
      this.bus.finish(taskId);
      this.release(taskId, item.userId);
      return;
    }

    try {
      const detail = await handler(ctx);
      if (ac.signal.aborted) {
        this.finishAs(taskId, 'cancelled', '已取消', startedAt, extraDetail);
      } else {
        const merged = { ...extraDetail, ...detail };
        this.repo.updateTask(taskId, { status: 'done', progress: 1, stage: '完成', detail: merged, error: null });
        this.bus.publish(taskId, 'progress', { task_id: taskId, progress: 1, stage: '完成' });
        this.bus.publish(taskId, 'done', {
          task_id: taskId,
          status: 'done',
          elapsed_ms: Date.now() - startedAt,
        });
        this.bus.finish(taskId);
      }
    } catch (err) {
      if (ac.signal.aborted) {
        this.finishAs(taskId, 'cancelled', '已取消', startedAt, extraDetail);
      } else {
        const isApi = err instanceof ApiError;
        const code = isApi ? err.code : 'E_INTERNAL';
        const msg = err instanceof Error ? err.message : String(err);
        const detail = isApi && err.detail ? err.detail : undefined;
        this.repo.updateTask(taskId, {
          status: 'failed',
          error: msg,
          stage: '失败',
          progress: lastProgress,
          detail: { ...extraDetail, ...(detail ? { error_detail: detail } : {}) },
        });
        this.bus.publish(taskId, 'failed', {
          task_id: taskId,
          error: msg,
          code,
          ...(detail ? { detail } : {}),
        });
        this.bus.finish(taskId);
      }
    } finally {
      this.release(taskId, item.userId);
    }
  }

  private finishAs(
    taskId: string,
    status: 'cancelled',
    stage: string,
    startedAt: number,
    extraDetail: Record<string, unknown>,
  ): void {
    this.repo.updateTask(taskId, { status, stage, detail: extraDetail });
    // 契约 §6：结束用 done 帧 + status 字段如实标注（cancelled 也是"结束了"）
    this.bus.publish(taskId, 'done', {
      task_id: taskId,
      status,
      elapsed_ms: Date.now() - startedAt,
    });
    this.bus.finish(taskId);
  }
}

function safeParse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
