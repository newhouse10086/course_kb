/**
 * **模型热切换**状态机（`docs/SETTINGS_AND_SANDBOX.md` §2）。
 *
 * ```
 * [空闲]             ── now   ──> 立即生效
 * [LLM 任务运行中]   ── now   ──> 409 E_MODEL_BUSY（拒绝直接热切，**不许假装成功**）
 *                    ── drain ──> 停准入 → 等当前单元跑完 → 切 → 恢复准入
 *                    ── abort ──> 存断点 → 终止 → 切 → **从断点续推**
 * ```
 *
 * ## 五条硬约束（每条都有测试）
 * 1. **有界等待**：`drain` 最长等 `drainTimeoutMs`（默认 60s）。超时**绝不静默继续** ——
 *    返回 `state:'timeout'` + 还剩哪些任务，且**准入保持暂停**（等人处理）。
 *    ⚠️ 没有这条，`drain` 会在"新任务不断进来"时**永远等不到空闲** → 热切换挂死。
 * 2. **探测-回滚**：切换后对**新模型真探测**；不通 → 回滚旧模型（内存 + 文件）→ 502 `E_MODEL_PROBE`。
 * 3. **忙判据要宽**：宁可误判"忙"，**不可误判"闲"**（误判闲 = 热切换毁掉正在跑的批）。
 * 4. **abort 顺序**：`cancel` → **等真的到终态** → 切模型 → 用**同一个** `checkpoint_file` + `resume:true`
 *    续推。（backend-api 实测：Node 侧此前**没转发** `checkpoint_file`/`resume`，
 *    `resume:true` 会被静默忽略 → 从头重跑 = **重复计费**；现已修好，我必须传对。）
 * 5. **准入必恢复**：正常/失败路径一定 `resume()`；**只有 drain 超时**这一种情况保持暂停。
 *    忘了恢复 = 全站任务不再被领取，比切换失败严重得多。
 */

import path from 'node:path';

import type { ServerConfig } from '../config.ts';
import { ApiError } from '../store/errors.ts';
import type { Repo, TaskApi } from '../store/repo.ts';
import type { ModelCatalog, ModelProbe } from './models.ts';
import type { SettingsStore } from './store.ts';

export const SWITCH_MODES = ['now', 'drain', 'abort'] as const;
export type SwitchMode = (typeof SWITCH_MODES)[number];

/** 默认"会调用 LLM 的任务 kind"。**可配置**（未来加 `say`/`title` 之类不能漏）。 */
export const DEFAULT_LLM_TASK_KINDS: readonly string[] = ['extract', 'rollup', 'translate', 'mindmap'];

/** `drain` 默认最长等待（ms）。 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;

/**
 * 准入被暂停后**自动恢复**的默认时限（ms，10 分钟）。
 *
 * 为什么必须有它（Lead 裁定，比"加个恢复接口"更重要）：`drain` 超时会**保持准入暂停**
 * 等人处理；如果只提供手动恢复入口，**人一旦忘了，队列就永久停摆** ——
 * 全班再也提交不了任务，而 UI 上没有任何提示。所以"暂停"必须是**有期限**的。
 * 可用 `COURSE_KB_ADMISSIONS_AUTO_RESUME_MS` 或构造参数覆盖；`0` = 关闭自动恢复。
 */
export const DEFAULT_AUTO_RESUME_MS = 600_000;

/** 自动恢复守卫的巡检周期上限（ms）：默认 10 分钟时限 → 30s 巡一次，最迟晚 30s 恢复。 */
const GUARD_MAX_PERIOD_MS = 30_000;

/** 准入闸门的当前状态（`GET /settings/llm` 与 resume 响应都用它）。 */
export interface AdmissionState {
  /** 队列是否正在拒绝领取新任务 */
  paused: boolean;
  /** 已暂停多久（ms）；未暂停为 0 */
  pausedForMs: number;
  /** 进入暂停的时刻（ms）；未暂停为 null */
  pausedSince: number | null;
  /** 暂停原因（人话） */
  reason: string;
  /** 当时还剩哪些 LLM 任务（暂停时快照） */
  stillRunning: { id: string; kind: string }[];
  /** 距离自动恢复还有多久（ms）；`null` = 未启用自动恢复 */
  autoResumeInMs: number | null
}

/** 等"在跑任务结束"的轮询间隔（ms）。 */
const POLL_MS = 25;

/** `TaskQueue` 里我用到的最小面（结构化声明：不 import `tasks/**`，那是 backend-api 的写域）。 */
export interface QueueLike {
  cancel(taskId: string): boolean;
  running(): string[];
  readonly pendingCount: number;
  enqueue?(input: {
    docId?: string | null;
    kind: string;
    params?: Record<string, unknown>;
    userId?: string | null;
    priority?: number;
  }): string;
  pauseAdmissions?(): void;
  resumeAdmissions?(): void;
  /** getter 形式 */
  admissionsPaused?: boolean;
  /** **方法**形式（Lead 裁定的调用形状；`TaskQueue` 两者都留，避免调用方猜） */
  isAdmissionsPaused?(): boolean;
  /**
   * ★ 暂停**时刻**（ms）；`null` = 当前未暂停。由 backend-api 提供，**幂等**：
   * 重复 `pauseAdmissions()` **不刷新**该时刻（否则"超时自动恢复"永远等不到超时 → 永久停摆）。
   * 有了它，我们才能覆盖**所有**暂停路径（不只我们自己因 drain 超时暂停的那次）。
   */
  admissionsPausedAt?(): number | null;
  admissionsPausedForMs?(now?: number): number | null;
  /** backend-api 新增：直接告诉你哪些是 LLM 任务（比我自己解析 kind 准） */
  runningSummary?(): { taskId: string; kind: string; userId: string | null; docId: string | null; isLlm: boolean }[];
}

export interface AdmissionGate {
  pause(): void;
  resume(): void;
  paused(): boolean;
}

export interface RunningLlmTask {
  id: string;
  kind: string;
  docId: string | null;
  stage: string;
  progress: number;
}

export interface BusyReport {
  busy: boolean;
  runningLlm: RunningLlmTask[];
  runningAll: number;
  pending: number;
  /** 判定用的 kind 白名单（回显，便于排查"为什么它算忙"） */
  llmKinds: string[];
  /** 判定来源：`queue.runningSummary()` 还是 `repo.listTasks()`（如实标注，便于排障） */
  source: 'queue.runningSummary' | 'repo.listTasks';
}

export interface SwitchRequest {
  model: string;
  mode: SwitchMode;
  userId?: string | null;
  username?: string | null;
  /** 覆盖等待上限（测试用） */
  drainTimeoutMs?: number;
  /**
   * ★ **强制重新探测**（默认 false = TTL 内复用缓存）。
   *
   * 为什么默认不强制：`probe()` 是**真发一次计费请求**。原先切换/幂等切换都无条件
   * `force:true` → 每次切换必然多花一次调用（哪怕 1 秒前刚探过）。
   * 需要"立刻确认它现在真的可用"时才传 true（调用方**显式**为这次付费）。
   */
  forceProbe?: boolean;
}

export interface ResumePlan {
  taskId: string;
  kind: string;
  docId: string | null;
  params: Record<string, unknown>;
  userId: string | null;
  priority: number;
  checkpointFile: string;
  hadCheckpoint: boolean;
}

export interface SwitchResult {
  ok: true;
  mode: SwitchMode;
  activeModel: string;
  switchedFrom: string;
  switchedAt: number;
  probe: ModelProbe;
  waitedMs: number;
  /** `'switched'` | `'timeout'`（超时 = **没切**，如实说明） */
  state: 'switched' | 'timeout';
  drained: number;
  aborted: string[];
  resumed: { taskId: string; newTaskId: string; kind: string; checkpointFile: string; hadCheckpoint: boolean }[];
  /** 准入是否真的被暂停过（无 gate 时为 false —— **如实上报**，不假装） */
  admissionPaused: boolean;
  /** 仅 timeout：还剩哪些任务 */
  stillRunning: { id: string; kind: string }[];
  /** 准入闸门状态快照（含"距离自动恢复还有多久"）—— `state:'timeout'` 时尤其要看它 */
  admissions?: AdmissionState;
  /**
   * ★ **模型真相源对照**（防"看起来切换成功"）。
   *
   * 现状有两个"当前模型"：
   * - `settings.llm.active`（运行期，**本接口改这个**）
   * - `config/providers.yaml` 的 `model: ${LLM_MODEL}`（部署期，provider/pi 层实际用的）
   *
   * 只有**读 settings 的消费方**才会跟随热切换。若两者不一致而某些调用方仍读
   * providers.yaml（实测：pi 的 `ready` 帧报的是旧模型），那"切换成功"就是**局部真相** ——
   * 所以这里**结构化地如实报出来**，让 UI/排障一眼看到，而不是让人自己去猜。
   */
  modelSources?: {
    settingsActive: string;
    providerConfigured: string;
    /** 两个真相源是否一致（false = 有消费方可能仍用旧模型） */
    consistent: boolean;
  };
  rolledBack: boolean;
  notes: string[];
}

export interface SwitcherOptions {
  cfg: ServerConfig;
  store: SettingsStore;
  repo: Repo;
  catalog: ModelCatalog;
  queue?: QueueLike | null;
  /** 不传则用 `queueGate(queue)` 自动适配；queue 也没有 → null（并如实上报） */
  admissionGate?: AdmissionGate | null;
  llmKinds?: readonly string[];
  drainTimeoutMs?: number;
  /**
   * 准入暂停后自动恢复的时限（ms）。默认取 `COURSE_KB_ADMISSIONS_AUTO_RESUME_MS`
   * 或 `DEFAULT_AUTO_RESUME_MS`（10 分钟）；`0` = 关闭（不推荐：人会忘 → 永久停摆）。
   */
  autoResumeMs?: number;
  audit?: (e: { userId: string | null; action: string; target?: string; detail?: Record<string, unknown> }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, level?: 'info' | 'warn') => void;
}

/** 把 `TaskQueue` 的准入 API 适配成 `AdmissionGate`；没有该 API 返回 null。 */
export function queueGate(q: unknown): AdmissionGate | null {
  const cand = q as Partial<QueueLike> | null | undefined;
  if (!cand || typeof cand.pauseAdmissions !== 'function' || typeof cand.resumeAdmissions !== 'function') {
    return null;
  }
  return {
    pause: () => cand.pauseAdmissions?.(),
    resume: () => cand.resumeAdmissions?.(),
    // 两种形状都支持：getter 优先，其次方法（`TaskQueue` 目前两种都有）
    paused: () =>
      typeof cand.isAdmissionsPaused === 'function' ? cand.isAdmissionsPaused() : cand.admissionsPaused === true,
  };
}

export class ModelSwitcher {
  private readonly o: SwitcherOptions;
  /** 切换互斥：两人同时点切换会互相回滚 → 串行化 */
  private chain: Promise<unknown> = Promise.resolve();
  private last: { from: string; to: string; at: number } | null = null;
  /** 正在进行中的切换数（自动恢复要避开它：切到一半恢复准入会破坏 drain 语义） */
  private inFlightSwitches = 0;
  /** 因 drain 超时而**保持暂停**的状态；非 null 表示"准入被我们关着" */
  private paused: { since: number; reason: string; stillRunning: { id: string; kind: string }[] } | null = null;
  private guardTimer: NodeJS.Timeout | null = null;

  constructor(opts: SwitcherOptions) {
    this.o = opts;
    // ★ **一开始就起守卫**（不是"等我们暂停时才起"）：
    //   `queue.pauseAdmissions()` 是公开 API，别人也可能暂停 —— 若守卫只在我们自己
    //   drain 超时时才武装，那种暂停就**永远没人恢复**（实测：加了这条测试立刻抓到）。
    //   安全网必须在"谁都还没看"的时候就已经张着。
    this.ensureGuard();
  }

  private autoResumeMs(): number {
    if (this.o.autoResumeMs !== undefined) return this.o.autoResumeMs;
    const raw = process.env.COURSE_KB_ADMISSIONS_AUTO_RESUME_MS;
    const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_AUTO_RESUME_MS;
  }

  /**
   * 准入闸门当前状态（UI 与 resume 响应用）。
   *
   * ⚠️ 暂停时刻**优先取队列的 `admissionsPausedAt()`**（权威，覆盖**所有**暂停路径），
   * 我们自己的 `this.paused` 只是"我们还记着原因/stillRunning"的补充。
   * 否则：别人直接 `pauseAdmissions()` 时我们会以为"没暂停"或"刚开始暂停"。
   */
  admissionState(): AdmissionState {
    const now = this.now();
    const gate = this.gate();
    const pausedNow = gate ? gate.paused() : this.paused !== null;
    if (!pausedNow) {
      return {
        paused: false, pausedForMs: 0, pausedSince: null, reason: '', stillRunning: [], autoResumeInMs: null,
      };
    }
    const fromQueue = this.o.queue?.admissionsPausedAt?.() ?? null;
    const pausedSince = fromQueue ?? this.paused?.since ?? null;
    const pausedForMs = pausedSince === null ? 0 : Math.max(0, now - pausedSince);
    const auto = this.autoResumeMs();
    return {
      paused: true,
      pausedForMs,
      pausedSince,
      reason:
        this.paused?.reason ??
        (fromQueue !== null ? '准入被暂停（非本切换器发起；已按队列的暂停时刻计时）' : ''),
      stillRunning: this.paused?.stillRunning ?? [],
      autoResumeInMs: auto > 0 ? Math.max(0, auto - pausedForMs) : null,
    };
  }

  /**
   * 恢复准入（**手动入口**与**自动兜底**共用）。
   *
   * @param opts.by `'manual'`（管理员点了恢复）或 `'auto'`（超时兜底）—— 审计里要分清
   * @returns 恢复动作前后的真实状态（幂等：本来就是开的也如实说）
   */
  resumeAdmissions(
    opts: { by: 'manual' | 'auto'; userId?: string | null; username?: string | null } = { by: 'manual' },
  ): { ok: true; resumed: boolean; note: string; state: AdmissionState; pending: number } {
    const gate = this.gate();
    const wasPaused = this.paused !== null || (gate ? gate.paused() : false);
    const pausedForMs = this.paused ? this.now() - this.paused.since : 0;
    const stillRunning = this.paused?.stillRunning ?? [];

    this.clearAutoResumeTimer();
    this.paused = null;
    if (gate) gate.resume();

    if (!wasPaused) {
      return {
        ok: true,
        resumed: false,
        note: '准入本来就是开的（未暂停），无需恢复',
        state: this.admissionState(),
        pending: this.o.queue?.pendingCount ?? 0,
      };
    }
    const by = opts.by === 'auto' ? 'auto' : 'manual';
    this.recordAudit({
      userId: opts.userId ?? null,
      action: by === 'auto' ? 'admissions_auto_resume' : 'admissions_resume',
      target: 'settings.llm.admissions',
      detail: {
        by,
        pausedForMs,
        ...(opts.username ? { operator: opts.username } : {}),
        stillRunning: stillRunning.map((t) => `${t.id}:${t.kind}`),
        ...(by === 'auto' ? { why: '暂停超过自动恢复时限且当时没有进行中的切换' } : {}),
      },
    });
    this.o.log?.(
      `准入已恢复（${by === 'auto' ? '自动兜底' : '管理员手动'}，已暂停 ${Math.round(pausedForMs / 1000)}s）`,
      'warn',
    );
    return {
      ok: true,
      resumed: true,
      note:
        by === 'auto'
          ? `准入已由**自动兜底**恢复（暂停 ${Math.round(pausedForMs / 1000)}s，超过时限）；若仍需切换请重试`
          : '准入已恢复；可以重新提交任务',
      state: this.admissionState(),
      pending: this.o.queue?.pendingCount ?? 0,
    };
  }

  /** 暂停准入 + 记状态 + 起自动恢复守卫（只有 drain 超时走这里）。 */
  private markPaused(reason: string, stillRunning: { id: string; kind: string }[]): void {
    this.paused = { since: this.now(), reason, stillRunning };
    this.ensureGuard();
  }

  /**
   * 自动恢复**守卫**（幂等：只挂一个定时器）。
   *
   * ⚠️ 为什么用**周期检查**而不是"暂停时挂一次性定时器"：
   * 一次性定时器只能覆盖**我们自己**造成的暂停；而 `queue.pauseAdmissions()` 是一条**公开 API**，
   * 别人（或别的代码路径）也能暂停。周期检查 + `queue.admissionsPausedAt()`（backend-api 提供的
   * **权威暂停时刻**，且重复 pause 不刷新）→ 覆盖**所有**暂停路径。
   * 这条比"加个手动恢复接口"更重要：**人会忘，忘了就是全班提交不了任务**。
   */
  private ensureGuard(): void {
    if (this.guardTimer) return;
    const auto = this.autoResumeMs();
    if (auto <= 0) {
      this.o.log?.('准入自动恢复被关闭（autoResumeMs=0）→ 暂停会一直保持到人工恢复', 'warn');
      return;
    }
    // 默认 10 分钟时限 → 30s 巡一次（最迟晚 30s 恢复，可接受）；测试里给 80ms 则 80ms 巡一次
    const period = Math.max(30, Math.min(auto, GUARD_MAX_PERIOD_MS));
    this.guardTimer = setInterval(() => this.maybeAutoResume(), period);
    // 定时器不该决定进程寿命（同 watcher 的教训：它是后台兜底，不是业务句柄）
    this.guardTimer.unref?.();
  }

  /** 到点就恢复（有切换在进行则推迟到下一轮）。 */
  private maybeAutoResume(): void {
    const gate = this.gate();
    if (!gate || !gate.paused()) return;
    if (this.inFlightSwitches > 0) {
      this.o.log?.('准入自动恢复推迟：有切换正在进行', 'warn');
      return;
    }
    const st = this.admissionState();
    const auto = this.autoResumeMs();
    if (st.pausedForMs < auto) return;
    this.o.log?.(
      `准入已暂停 ${Math.round(st.pausedForMs / 1000)}s（超过时限 ${Math.round(auto / 1000)}s）→ 自动恢复`,
      'warn',
    );
    this.resumeAdmissions({ by: 'auto' });
  }

  private clearAutoResumeTimer(): void {
    if (this.guardTimer) {
      clearInterval(this.guardTimer);
      this.guardTimer = null;
    }
  }

  /** 关闭（释放守卫定时器；测试与关服要调）。 */
  close(): void {
    this.clearAutoResumeTimer();
    this.paused = null;
  }

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.o.sleep ? this.o.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  private llmKinds(): string[] {
    return [...(this.o.llmKinds ?? DEFAULT_LLM_TASK_KINDS)];
  }

  private gate(): AdmissionGate | null {
    if (this.o.admissionGate !== undefined) return this.o.admissionGate;
    return queueGate(this.o.queue);
  }

  lastSwitchInfo(): { from: string; to: string; at: number } | null {
    return this.last;
  }

  // ───────────────────────────────────────────────────────────────────
  // 忙判定（**宽**：宁可误判忙）
  // ───────────────────────────────────────────────────────────────────
  busy(): BusyReport {
    const kinds = new Set(this.llmKinds());
    const running = this.o.repo.listTasks({ status: 'running' });
    const q = this.o.queue ?? null;

    let runningLlm: RunningLlmTask[];
    let source: BusyReport['source'];
    if (q && typeof q.runningSummary === 'function') {
      source = 'queue.runningSummary';
      const summary = q.runningSummary();
      runningLlm = summary
        // ★ 宽判据 = 队列说是 LLM **或** 命中我的 kind 白名单（两边取并集，谁宽听谁的）
        .filter((r) => r.isLlm || kinds.has(r.kind))
        .map((r) => {
          const row = running.find((t) => t.id === r.taskId);
          return {
            id: r.taskId,
            kind: r.kind,
            docId: r.docId,
            stage: row?.stage ?? '',
            progress: row?.progress ?? 0,
          };
        });
    } else {
      source = 'repo.listTasks';
      runningLlm = running
        .filter((t) => kinds.has(t.kind))
        .map((t) => ({ id: t.id, kind: t.kind, docId: t.doc_id, stage: t.stage, progress: t.progress }));
    }

    // 队列里还压着 LLM 任务 → 也算忙（它们随时会开跑，切了会被当旧模型处理）
    const queuedLlm = this.o.repo.listTasks({ status: 'queued' }).filter((t) => kinds.has(t.kind));

    return {
      busy: runningLlm.length > 0 || queuedLlm.length > 0,
      runningLlm,
      runningAll: running.length,
      pending: q?.pendingCount ?? 0,
      llmKinds: this.llmKinds(),
      source,
    };
  }

  /** 当前在跑的 LLM 任务（`rev` = 用哪套判定取；drain 轮询用）。 */
  private runningLlmKinds(): string[] {
    return this.busy().runningLlm.map((t) => t.id);
  }

  // ───────────────────────────────────────────────────────────────────
  // 主入口（串行）
  // ───────────────────────────────────────────────────────────────────
  switch(req: SwitchRequest): Promise<SwitchResult> {
    const run = this.chain.then(
      () => this.wrap(req),
      () => this.wrap(req),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** 计"正在进行的切换"（自动恢复必须避开它）。 */
  private async wrap(req: SwitchRequest): Promise<SwitchResult> {
    this.inFlightSwitches += 1;
    try {
      return await this.doSwitch(req);
    } finally {
      this.inFlightSwitches -= 1;
    }
  }

  private async doSwitch(req: SwitchRequest): Promise<SwitchResult> {
    const model = (req.model ?? '').trim();
    if (!model) {
      throw new ApiError('E_BADREQUEST', 'model 不能为空', {
        hint: '传一个模型 id，如 {"model":"glm-5.3","mode":"drain"}',
      });
    }
    if (!(SWITCH_MODES as readonly string[]).includes(req.mode)) {
      throw new ApiError('E_BADREQUEST', `mode 必须是 ${SWITCH_MODES.join(' | ')} 之一`, {
        detail: `收到 mode=${JSON.stringify(req.mode)}`,
      });
    }

    const before = this.o.store.get();
    const from = before.llm.active;
    const notes: string[] = [];
    const t0 = this.now();

    // ── 幂等：切到当前模型 → 不切，但**仍探测一次**（"确认它还能用"是合理诉求）──
    if (model === from) {
      /**
       * ★ **不再无条件 `force: true`**（成本修复）：TTL 内的缓存可直接复用 ——
       * 否则"切到自己"这种幂等操作每次都会**真发一次计费请求**。
       * 想强制刷新 → 传 `forceProbe: true`（显式付费，调用方知情）。
       */
      const probe = await this.o.catalog.probe(model, { force: req.forceProbe === true });
      if (!probe.available) {
        this.auditEvent(req, from, model, 'failed', probe.reason);
        throw new ApiError('E_MODEL_PROBE', `当前模型 ${model} 探测失败：${probe.reason}`, {
          detail: `probe=${probe.probe} latencyMs=${probe.latencyMs} reason=${probe.reason}`,
          hint: '模型没变，但探测不通 —— 检查 provider 凭据 / 网络 / 额度',
        });
      }
      return {
        ok: true, mode: req.mode, activeModel: model, switchedFrom: from, switchedAt: this.now(),
        probe, waitedMs: 0, state: 'switched', drained: 0, aborted: [], resumed: [],
        admissionPaused: false, stillRunning: [], rolledBack: false,
        notes: ['目标模型与当前一致 → 未做切换（只做了探测确认）'],
      };
    }

    const gate = this.gate();
    let admissionPaused = false;
    let keepPaused = false; // ★ 只有 drain 超时才置 true
    const aborted: string[] = [];
    const resumed: SwitchResult['resumed'] = [];
    const resumePlans: ResumePlan[] = [];
    let drained = 0;

    // ── drain/abort 先停准入（否则"等空闲"永远等不到）──
    if (req.mode !== 'now') {
      if (gate) {
        gate.pause();
        admissionPaused = true;
        notes.push('已停止领取新任务（在跑的继续跑完；pending 停在队列里）');
      } else {
        notes.push(
          '⚠️ 未暂停新任务准入（队列没有 pauseAdmissions/resumeAdmissions）—— 等待期间新任务可能进来，' +
            'drain 可能因此超时；这是**如实上报**，不是静默忽略',
        );
      }
    }

    try {
      // ── mode: now ──
      if (req.mode === 'now') {
        const b = this.busy();
        if (b.busy) {
          this.auditEvent(req, from, model, 'failed', 'E_MODEL_BUSY');
          throw new ApiError('E_MODEL_BUSY', `有 ${b.runningLlm.length} 个 LLM 任务在运行中，拒绝直接热切`, {
            detail:
              `running=${b.runningLlm.map((t) => `${t.id}:${t.kind}`).join(',') || '无'}` +
              ` runningAll=${b.runningAll} pending=${b.pending}`,
            hint: '用 mode:"drain"（等当前单元跑完再切，推荐）或 mode:"abort"（存断点→终止→切换→从断点续推）',
          });
        }
      }

      // ── mode: drain（有界等待）──
      if (req.mode === 'drain') {
        const timeoutMs = req.drainTimeoutMs ?? this.o.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
        const r = await this.waitIdle(timeoutMs);
        drained = r.finished;
        if (!r.idle) {
          keepPaused = admissionPaused; // ★ 超时保持暂停，等人处理
          const still = r.still.map((t) => ({ id: t.id, kind: t.kind }));
          notes.push(
            `drain 在 ${timeoutMs}ms 内没等到空闲 → **未切换**；剩 ${still.length} 个 LLM 任务（${still
              .map((s) => `${s.id}:${s.kind}`)
              .join(',')}）` +
              (keepPaused
                ? `；准入**保持暂停**（可用 POST /api/v1/settings/llm/switch/resume 恢复；` +
                  `${Math.round(this.autoResumeMs() / 1000)}s 后也会**自动恢复**，避免队列永久停摆）`
                : ''),
          );
          this.auditEvent(req, from, model, 'failed', `drain 超时（剩 ${still.length} 个 LLM 任务）`);
          // ★ 保持暂停 + 挂**自动恢复兜底**（人一旦忘了，队列会永久停摆 —— Lead 裁定）
          if (admissionPaused) {
            this.markPaused(
              `drain 模式下等待空闲超时（${timeoutMs}ms），仍有 ${still.length} 个 LLM 任务在跑`,
              still,
            );
          }
          return {
            ok: true, mode: req.mode, activeModel: from, switchedFrom: from, switchedAt: this.now(),
            probe: {
              available: false, latencyMs: 0, reason: '未执行（drain 超时）', probe: 'skipped',
              checkedAt: this.now(), judgedBy: 'provider.healthCheck',
            },
            waitedMs: this.now() - t0, state: 'timeout', drained, aborted: [], resumed: [],
            admissionPaused, stillRunning: still, rolledBack: false,
            admissions: this.admissionState(),
            notes,
          };
        }
        notes.push(`等当前 LLM 单元跑完（${this.now() - t0}ms）`);
      }

      // ── mode: abort（取消 → 等终态 → 切 → 续推）──
      if (req.mode === 'abort') {
        for (const t of this.busy().runningLlm) {
          const plan = this.resumePlan(t.id);
          if (!plan) {
            notes.push(`任务 ${t.id} 找不到入队参数 → **无法自动续推**（会终止它，需人工重跑）`);
          }
          const cancelled = this.o.queue?.cancel(t.id) ?? false;
          if (cancelled) aborted.push(t.id);
          else notes.push(`任务 ${t.id} 取消失败（可能刚好跑完，无需续推）`);
          if (plan) {
            // ★ 必须等它**真的到终态**再续推：worker 是原子替换断点文件，
            //   但同文件并发写会互相覆盖（backend-api 实测提醒）→ 立刻入队会丢断点。
            const gone = await this.waitTerminal(t.id, 10_000);
            if (!gone) {
              notes.push(`任务 ${t.id} 在 10s 内没进入终态 → 已**放弃**它的续推（避免与旧进程抢同一个断点文件）`);
              continue;
            }
            resumePlans.push(plan);
          }
        }
        notes.push(`已终止 ${aborted.length} 个 LLM 任务（断点由任务自身落盘；续推会带同一个 checkpoint_file）`);
      }

      // ── 应用新模型（内存 + 文件）──
      const next = { ...before, llm: { ...before.llm, active: model } };
      this.o.store.apply(next, { persist: true, warnings: [], ignored: [] });

      // ── 真探测新模型；不通 → 回滚 + 502 ──
      // ★ 成本修复：TTL 内的缓存可复用（`force` 只在显式 `forceProbe` 时给）——
      //   原来无条件 `force:true` 让"切换"必然多花一次调用（哪怕刚探过）。
      const probe = await this.o.catalog.probe(model, { force: req.forceProbe === true });
      this.o.catalog.invalidate();
      if (!probe.available) {
        this.o.store.apply({ ...next, llm: { ...next.llm, active: from } }, { persist: true, warnings: [], ignored: [] });
        this.auditEvent(req, from, model, 'failed', probe.reason);
        throw new ApiError('E_MODEL_PROBE', `新模型 ${model} 探测失败，已**回滚**到 ${from}：${probe.reason}`, {
          detail: `probe=${probe.probe} latencyMs=${probe.latencyMs} reason=${probe.reason}`,
          hint: '确认模型名/额度/网络后重试；GET /api/v1/models?deep=1 可看每个模型的真探测结果',
        });
      }

      // ── abort 的续推（用同一个 checkpoint_file + resume:true）──
      for (const plan of resumePlans) {
        const newId = this.requeue(plan);
        if (newId) {
          resumed.push({
            taskId: plan.taskId, newTaskId: newId, kind: plan.kind,
            checkpointFile: plan.checkpointFile, hadCheckpoint: plan.hadCheckpoint,
          });
        } else {
          notes.push(`任务 ${plan.taskId} 续推入队失败（队列不可用或无 enqueue）`);
        }
      }
      if (resumed.length > 0) {
        notes.push(`已从断点续推 ${resumed.length} 个任务（resume:true + 同一 checkpoint_file → 跳过已完成单元，不重复计费）`);
      }

      this.last = { from, to: model, at: this.now() };
      this.auditEvent(req, from, model, 'ok', '');
      this.o.log?.(`模型热切换 ${from} → ${model}（mode=${req.mode}, ${this.now() - t0}ms）`);

      // ★ 如实报"两个真相源"是否一致（见 `modelSources` 的注释）
      const providerConfigured = this.o.cfg.llm?.model ?? '';
      const consistent = providerConfigured === '' || providerConfigured === model;
      if (!consistent) {
        notes.push(
          `⚠️ settings.llm.active 已切到 ${model}，但 **provider 层配置的 model 仍是 ${providerConfigured}**` +
            `（config/providers.yaml 的 \`model: \${LLM_MODEL}\`）→ 只有**读 settings 的消费方**会用新模型；` +
            `未接入的调用方（实测：pi 的 ready 帧）仍报旧模型。这是**如实上报**，不是切换失败。`,
        );
      }

      return {
        ok: true, mode: req.mode, activeModel: model, switchedFrom: from, switchedAt: this.now(),
        probe, waitedMs: this.now() - t0, state: 'switched', drained, aborted, resumed,
        admissionPaused, stillRunning: [], rolledBack: false,
        admissions: this.admissionState(),
        modelSources: { settingsActive: model, providerConfigured, consistent },
        notes,
      };
    } finally {
      // ★ 准入恢复：正常与失败路径都恢复；**只有 drain 超时**保持暂停（那条路已挂自动恢复兜底）
      if (gate && admissionPaused && !keepPaused) {
        gate.resume();
        this.clearAutoResumeTimer();
        this.paused = null;
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // 辅助
  // ───────────────────────────────────────────────────────────────────

  /** 等 LLM 任务跑空（**有界**）。 */
  private async waitIdle(timeoutMs: number): Promise<{ idle: boolean; still: RunningLlmTask[]; finished: number }> {
    const deadline = this.now() + timeoutMs;
    const initial = this.busy().runningLlm.length;
    for (;;) {
      const still = this.busy().runningLlm;
      if (still.length === 0) return { idle: true, still: [], finished: initial };
      if (this.now() >= deadline) return { idle: false, still, finished: Math.max(0, initial - still.length) };
      await this.sleep(POLL_MS);
    }
  }

  /** 等某任务进入**终态**（不只"不在 running"）。有界；返回是否已终态。 */
  private async waitTerminal(taskId: string, timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const row: TaskApi | undefined = this.o.repo.getTask(taskId);
      if (!row) return true;
      if (row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') return true;
      if (this.now() >= deadline) return false;
      await this.sleep(POLL_MS);
    }
  }

  /**
   * 构造续推计划：**同一个 `checkpoint_file`**（否则 worker 的"跳过已完成单元"失效）。
   *
   * `checkpoint_file` 优先沿用原参数；原来没有就按 `cfg.checkpointsDir/<taskId>.json` 生成 ——
   * 与 backend-core 的断点约定一致（`worker/README.md` §7）。
   */
  resumePlan(taskId: string): ResumePlan | null {
    const row = this.o.repo.getTask(taskId);
    if (!row) return null;
    const params = { ...((row.detail?.params ?? {}) as Record<string, unknown>) };
    const existing = typeof params.checkpoint_file === 'string' && params.checkpoint_file.length > 0;
    const checkpointFile = existing
      ? (params.checkpoint_file as string)
      : path.join(this.o.cfg.checkpointsDir, `${taskId}.json`);
    return {
      taskId,
      kind: row.kind,
      docId: row.doc_id,
      params: { ...params, checkpoint_file: checkpointFile, resume: true },
      userId: row.user_id,
      priority: row.priority,
      checkpointFile,
      hadCheckpoint: existing,
    };
  }

  private requeue(plan: ResumePlan): string | null {
    const q = this.o.queue;
    if (!q || typeof q.enqueue !== 'function') return null;
    try {
      return q.enqueue({
        docId: plan.docId,
        kind: plan.kind,
        params: plan.params,
        userId: plan.userId,
        priority: plan.priority,
      });
    } catch (e) {
      this.o.log?.(`续推入队失败：${(e as Error).message}`, 'warn');
      return null;
    }
  }

  private auditEvent(req: SwitchRequest, from: string, to: string, result: 'ok' | 'failed', reason: string): void {
    this.recordAudit({
      userId: req.userId ?? null,
      action: 'model_switch',
      target: to,
      detail: {
        from, to, mode: req.mode, result,
        ...(req.username ? { by: req.username } : {}),
        ...(reason ? { reason } : {}),
      },
    });
  }

  /**
   * 写审计。
   *
   * ★ 没注入 `audit` 时**默认写 `repo.rbac.audit`** —— 审计是硬要求
   * （"audit_log 记 model_switch 含 from/to/who"），不能因为"调用方忘了传回调"
   * 就**静默不落盘**（实测踩到：测试里自建 switcher 没传 audit，切换成功但 audit_log 里 0 条）。
   */
  private recordAudit(e: { userId: string | null; action: string; target?: string; detail?: Record<string, unknown> }): void {
    try {
      const write =
        this.o.audit ??
        ((ev: { userId: string | null; action: string; target?: string; detail?: Record<string, unknown> }) => {
          this.o.repo.rbac.audit(ev);
        });
      write(e);
    } catch (err) {
      // 审计失败不能影响切换结果，但必须吵一声
      this.o.log?.(`审计写入失败（${e.action}）：${(err as Error).message}`, 'warn');
    }
  }
}
