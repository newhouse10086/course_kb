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

/** 会真的调模型的任务 kind（模型热切换必须等它们跑完 / 或中止它们）。 */
export const LLM_KINDS: ReadonlySet<string> = new Set(['extract', 'rollup', 'translate', 'mindmap']);

/**
 * ★ 自动抽取的单元数阈值（**可配，且断言真的被读** —— 坑 24：别做死旋钮）。
 *
 * 默认 **100**：并发=1 下 100 次 LLM 调用 ≈ 10–20 分钟，**已是"后台任务"量级**；
 * 300 次 ≈ 30–60 分钟 —— 太久，**不能无声发生**。超阈值 → 标 `needs_confirm` 交给用户决定。
 *
 * ⚠️ 非法值（0/负数/NaN）**回落默认**，不静默变 0（0 会让"任何文档都不自动抽取"，看起来像没这功能）。
 */
export function autoExtractMaxUnits(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.COURSE_KB_AUTO_EXTRACT_MAX_UNITS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 100;
}

/**
 * ★ 抽取时长估算（**区间**，不是假精确）。
 *
 * 依据实测：单次结构化抽取在本机约 **20s（顺利）～120s（撞超时/负载高）**
 * → 用这两个端点做区间，报给用户的是"要等多久"的**量级**（这正是用户感受到的痛）。
 */
export function estimateExtractMinutes(units: number): [number, number] {
  const perCallLoSec = 20;
  const perCallHiSec = 120;
  return [Math.max(1, Math.round((units * perCallLoSec) / 60)), Math.max(1, Math.round((units * perCallHiSec) / 60))];
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
  /** `pauseAdmissions()` 的开关：true 时**不领新任务**（在跑的跑完为止）。 */
  private paused = false;
  /** 准入被暂停的时刻（`null` = 未暂停）；供"超时自动恢复"判断暂停了多久。 */
  private pausedSince: number | null = null;

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
  // ⚠️ 这里曾有 `maybeAutoExtract`（parse 成功后自动入队 extract）—— **已删除**。
  // 原因：`parse` handler **自身就会抽取**（`handlers.ts` ④ 步）⟹ 队列再链一次 = **双倍花费**
  //       （Lead 真上传实测：只有 parse 任务却产出了卡片）。
  // 闸门现在在**权威路径**上：`handlers.ts::decideAutoExtract`（纯函数，7 条断言）。
  // ★ **不要在这里重新加自动链** —— 那会造出**第二条抽取路径**（双倍花费 + 两套真相）。
  //   唯一合法的手动入口是 `POST /api/v1/documents/:id/extract`（`routes/documents.ts`）。

  enqueue(input: {
    docId?: string | null;
    kind: string;
    params?: Record<string, unknown>;
    taskId?: string;
    priority?: number;
    userId?: string | null;
  }): string {    if (this.stopped) throw new ApiError('E_BUSY', '任务队列已停止', { hint: '服务正在关闭' });
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

  /**
   * 暂停"领取新任务"（**drain 语义**：在跑的任务继续跑完，pending 停在队列里不动）。
   *
   * 用途：模型热切换的 `mode:"drain"` —— 停准入 → 等当前 LLM 单元跑完 → 切模型 → resume。
   * 与 `shutdown` 的区别：**不中止任何任务**，也不停服务。
   *
   * 幂等：重复调用**不刷新** `admissionsPausedAt()`（保留"第一次被暂停"的时间 ——
   * 否则"超时自动恢复"会一直以为刚暂停，永远等不到超时 → 队列永久停摆）。
   */
  pauseAdmissions(): void {
    if (!this.paused) this.pausedSince = Date.now();
    this.paused = true;
  }

  /** 恢复准入（并立刻调度 pending 里的任务）。 */
  resumeAdmissions(): void {
    this.paused = false;
    this.pausedSince = null;
    this.pump();
  }

  get admissionsPaused(): boolean {
    return this.paused;
  }

  /** 与 `admissionsPaused` getter 等价的**方法**名（Lead 裁定的调用形状；两者都留，避免猜）。 */
  isAdmissionsPaused(): boolean {
    return this.paused;
  }

  /**
   * 准入是**什么时候**被暂停的（`null` = 当前未暂停）。
   *
   * 为什么要有：调用方（如模型热切换的"drain 超时自动恢复"）只能看到"现在是否暂停"，
   * 看不到"暂停了多久" → 若暂停由**别的代码路径**触发，它的超时兜底就不会触发，
   * 队列可能**永久停摆**（全班提交不了任务，只能重启服务）。
   */
  admissionsPausedAt(): number | null {
    return this.pausedSince;
  }

  /** 已暂停多久（ms）；未暂停 → `null`。 */
  admissionsPausedForMs(now = Date.now()): number | null {
    return this.pausedSince === null ? null : Math.max(0, now - this.pausedSince);
  }

  /**
   * 运行中任务的概要 —— 外部（模型热切换）**不必自己猜 kind 语义**。
   * `isLlm` 按 kind 归类：这些任务会真的调模型，热切换必须等它们（或中止它们）。
   */
  runningSummary(): {
    taskId: string;
    kind: string;
    userId: string | null;
    docId: string | null;
    isLlm: boolean;
  }[] {
    return [...this.active.keys()].map((taskId) => {
      const row = this.repo.getTaskRow(taskId);
      const kind = String(row?.kind ?? '');
      return {
        taskId,
        kind,
        userId: row?.user_id ?? null,
        docId: row?.doc_id ?? null,
        isLlm: LLM_KINDS.has(kind),
      };
    });
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
    // drain 期间：不领新任务（在跑的继续）
    if (this.paused) return;
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
    /** ★ parse 是否成功结束（决定要不要自动链式抽取；在 `finally` 里用，故声明在外层） */
    let parsedOk = false;

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

    /**
     * ★★ **任务终态必须回写文档状态**（用户直接撞到的 bug）。
     *
     * ## 缺陷（真库证据）
     * `doc_473f915e315f` / `doc_055d06be9a5d` / `doc_45d7826c5c4c` 的 `tasks.status='failed'`，
     * 但 `documents.status` **至今仍是 `extracting`** ⟹ 界面**不显示失败、不显示原因**，
     * 用户以为"还在跑"（"显示是可用的，请问抽取的结果在哪"）。
     * 这正是我们一路在守的那条：**"看起来成功"比崩溃危险**。
     *
     * ## 为什么放在队列层（而不是各 handler 里）
     * 失败路径有三条出口（无处理器 / 抛异常 / 取消），**每个 handler 各自记得回写**是不可靠的
     * （抽取 handler 就漏了）。队列是**唯一**知道"任务终态 + docId"的地方 ⟹ 一处回写，全体受益。
     *
     * ## 状态映射（如实，不美化）
     * - `failed` → `documents.status='failed'` + 可读 reason 进 meta（`task_failed_error`）
     * - `cancelled` → 同样标 `failed`（**未完成就是未完成**），reason 写明"已取消"
     */
    const writebackDoc = (finalStatus: 'failed' | 'cancelled', reason: string): void => {
      if (!item.docId) return;
      try {
        this.repo.updateDocument(item.docId, { status: 'failed' });
        this.repo.mergeDocumentMeta(item.docId, {
          task_failed_kind: item.kind,
          task_failed_status: finalStatus,
          task_failed_error: reason,
          task_failed_at: Date.now(),
        });
      } catch {
        // 回写失败**不许**把队列搞挂（但也不静默：进日志/总线）
        this.bus.publish(taskId, 'log', {
          task_id: taskId,
          level: 'warn',
          msg: `文档状态回写失败（documents.status 可能仍停留在进行中）：doc=${item.docId}`,
        });
      }
    };

    if (!handler) {
      const msg = `没有注册 kind=${item.kind} 的处理器（可用：${Object.keys(this.handlers).sort().join(', ') || '(空)'}）`;
      this.repo.updateTask(taskId, { status: 'failed', error: msg, stage: '失败' });
      writebackDoc('failed', msg);
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
        parsedOk = true; // ★ 自动链式放到 finally 之后（那时配额槽已释放，否则会被 E_QUOTA 挡住）
      }
    } catch (err) {
      if (ac.signal.aborted) {
        this.finishAs(taskId, 'cancelled', '已取消', startedAt, extraDetail);
        writebackDoc('cancelled', '任务已取消（未完成）');
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
        // ★ 回写文档状态（否则 documents.status 永远停在 extracting/parsing —— 用户看到的"假进行中"）
        writebackDoc('failed', msg);
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
      /**
       * ⚠️ **队列级自动链式已移除**（Lead 真上传实测暴露的概念冲突）：
       * `parse` handler 的 ④ 步**本身就会抽取**（`handlers.ts:440-455`）→ 队列再链一次 = **双倍花费**。
       *
       * ⟹ **唯一权威路径 = `parse` ④**，闸门（`text_gate` / 单元数阈值 / `needs_confirm`）也在那里
       *   （`decideAutoExtract`，纯函数 → 可穷举断言）。队列只负责"任务终态 → 回写文档状态"。
       *
       * ★ 教训（写进提交信息）：**"多一条自动链"看起来是补功能，实际是造出第二条抽取路径** ——
       *   两条路径都能抽 = **双倍花费 + 两套真相**（这次靠 `extract_status` 幂等闸门才没双跑）。
       */
      void parsedOk;
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
