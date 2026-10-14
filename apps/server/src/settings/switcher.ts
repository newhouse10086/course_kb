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

  constructor(opts: SwitcherOptions) {
    this.o = opts;
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
      () => this.doSwitch(req),
      () => this.doSwitch(req),
    );
    this.chain = run.catch(() => undefined);
    return run;
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
      const probe = await this.o.catalog.probe(model, { force: true });
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
              .join(',')}）` + (keepPaused ? '；准入**保持暂停**（恢复请调 resumeAdmissions 或重试切换）' : ''),
          );
          this.auditEvent(req, from, model, 'failed', `drain 超时（剩 ${still.length} 个 LLM 任务）`);
          return {
            ok: true, mode: req.mode, activeModel: from, switchedFrom: from, switchedAt: this.now(),
            probe: { available: false, latencyMs: 0, reason: '未执行（drain 超时）', probe: 'skipped', checkedAt: this.now() },
            waitedMs: this.now() - t0, state: 'timeout', drained, aborted: [], resumed: [],
            admissionPaused, stillRunning: still, rolledBack: false, notes,
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
      const probe = await this.o.catalog.probe(model, { force: true });
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

      return {
        ok: true, mode: req.mode, activeModel: model, switchedFrom: from, switchedAt: this.now(),
        probe, waitedMs: this.now() - t0, state: 'switched', drained, aborted, resumed,
        admissionPaused, stillRunning: [], rolledBack: false, notes,
      };
    } finally {
      // ★ 准入恢复：正常与失败路径都恢复；**只有 drain 超时**保持暂停
      if (gate && admissionPaused && !keepPaused) gate.resume();
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
    try {
      // ★ 没注入 `audit` 时**默认写 `repo.rbac.audit`** ——
      //   审计是硬要求（"audit_log 记 model_switch 含 from/to/who"），
      //   不能因为"调用方忘了传回调"就**静默不落盘**（实测踩到：测试里自建 switcher 没传 audit，
      //   切换成功但 audit_log 里 0 条）。
      const write =
        this.o.audit ??
        ((e: { userId: string | null; action: string; target?: string; detail?: Record<string, unknown> }) => {
          this.o.repo.rbac.audit(e);
        });
      write({
        userId: req.userId ?? null,
        action: 'model_switch',
        target: to,
        detail: {
          from, to, mode: req.mode, result,
          ...(req.username ? { by: req.username } : {}),
          ...(reason ? { reason } : {}),
        },
      });
    } catch (e) {
      this.o.log?.(`审计写入失败：${(e as Error).message}`, 'warn');
    }
  }
}
