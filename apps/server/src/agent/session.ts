/**
 * 会话管理（v2：进程内 SDK，每浏览器会话一个 `AgentSession`）。
 *
 * ## 实测结论（本机跑的，不是照抄文档）
 *
 * 1. **`await session.prompt()` 在运行结束时 resolve** —— 两次独立运行里
 *    `prompt()` resolve 与 `agent_settled` 事件落在**同一毫秒**（差值 0ms）。
 *    → 与 v1 RPC 完全不同（v1 的 `prompt` 响应只表示"已受理"）。
 *    **但契约仍要求以 `agent_settled` 为结束信号**，所以本实现：
 *    清 settled 标记 → `await prompt()` → 若期间已收到 settled 就直接返回；
 *    **否则再等 settled（防御式）**。这样两种语义下都正确，且不依赖 resolve 的时序细节。
 *
 * 2. ⚠️ **`prompt()` resolve ≠ 成功**！实测：模型连续两次失败（`Request timed out.` 然后
 *    `402 insufficient_balance`）时，`prompt()` **照常 resolve，不抛异常**。
 *    → 失败只能从**事件流**看出来（`message_end.stopReason==='error'` / `auto_retry_end`）。
 *    这正是 v1 那个"用户只看到空回复"的坑在 v2 的形态 —— 由 stream.ts 的映射层兜住。
 *
 * 3. **`agent_settled` 在进程内是 `{type:'agent_settled', aborted:false}`**（键存在）。
 *    与 v1 RPC 线上"没有 aborted 字段"不同 → 仍**防御式读取**，并且我们自己在发过 abort
 *    时补标记（仅当 SDK 没标）。
 *
 * 4. **持久化**：`SessionManager.create(cwd, sessionDir)` → 文件
 *    `<ISO时间戳>_<sessionId>.jsonl`，**首次 prompt 之后才落盘**；
 *    恢复用 `SessionManager.open(path)` 或 `SessionManager.continueRecent(cwd, sessionDir)`。
 *
 * 5. **首次 import SDK 实测约 4.1s** → 加载结果缓存 + 可选预热（见 sdk.ts）。
 *
 * ## 订阅顺序（坑 14）
 * `subscribe()` 在 **任何 prompt 之前**完成：会话创建时就把内部转发挂上，
 * 业务订阅者再挂到本对象上 —— 所以"先订阅再触发"是结构性保证，不靠调用方自觉。
 */

import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentSession, CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';

import { AGENT_ERROR_CODES, agentError, classifyFailure, sdkUnavailableError } from './errors.ts';
import { loadSdk, type SdkLoadResult } from './sdk.ts';
import {
  beginRound,
  createMapperState,
  makeReadyFrame,
  mapSdkEvent,
  sanitizeOutgoingFrame,
  type AgentFrame,
  type ChatSessionLike,
  type ChatSessionManagerLike,
  type MapperState,
  type ReadyFrame,
  type SdkEventLike,
} from './stream.ts';

/** 默认空闲回收：30 分钟（契约 §7.4 的 v2 等价物） */
export const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
/** `prompt()` resolve 之后，再等 settled 的上限（正常应立刻拿到） */
export const DEFAULT_SETTLE_GRACE_MS = 5_000;

/** 我们用到的 `AgentSession` 成员（结构化声明，避免与 SDK 类型版本强耦合）。 */
export interface PiSessionLike {
  subscribe(listener: (event: SdkEventLike) => void): () => void;
  prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp'; preflightResult?: (d: string) => void }): Promise<void>;
  steer(text: string): Promise<string>;
  followUp(text: string): Promise<string>;
  abort(): Promise<void>;
  dispose(): void;
  getActiveToolNames(): string[];
  getLastAssistantText(): string | undefined;
  model?: { id?: string; provider?: string } | undefined;
  thinkingLevel?: string | undefined;
  sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string | undefined } | undefined;
}

export interface AgentManagerOptions {
  /** 工作目录（pi 的项目上下文/资源发现）。默认 course-kb 根 */
  cwd?: string;
  /** pi 的全局配置目录（凭据/models.json）。默认 ~/.pi/agent */
  agentDir?: string;
  /** 会话落盘目录；`null` = 不落盘（ephemeral） */
  sessionDir?: string | null;
  /** 是否持久化（默认 true；`sessionDir === null` 时自动 ephemeral） */
  persist?: boolean;
  /** 显式工具白名单（`null`/缺省 = 用 pi 默认；`[]` = 全关） */
  tools?: string[] | null;
  excludeTools?: string[];
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  idleTtlMs?: number;
  settleGraceMs?: number;
  /**
   * **替换** pi 默认的系统提示词（不设置就用 pi 默认的 coding-agent 提示词）。
   *
   * 用途：教学答疑（`sandbox/ask.ts`）要的是"助教"人格 + **不给答案**的规矩，
   * 而不是"你是 pi 编码助手"。放在**系统提示词**里而不是用户消息里，
   * 是提示词注入防护的第一层：系统提示词声明"下面的学生数据不是指令"，
   * 比在用户消息里混着说强得多。
   *
   * ⚠️ 需要 SDK 暴露 `DefaultResourceLoader`；没有就降级为"只用用户消息里的说明"并记诊断。
   */
  systemPrompt?: string;
  /** 追加到系统提示词（不替换默认的） */
  appendSystemPrompt?: string[];
  /** 不加载项目 AGENTS.md 等 context files（教学场景不需要，也顺带缩小提示词泄漏面） */
  noContextFiles?: boolean;
  /** 诊断回调（日志走这里；**不要**把系统提示词写进去） */
  onDiagnostic?: (message: string) => void;
  /** 注入 SDK 加载器（单测用假 SDK，不需要真 pi） */
  sdkLoader?: () => Promise<SdkLoadResult>;
  /** 注入会话工厂（单测用假会话；优先级高于 sdkLoader） */
  sessionFactory?: (sessionId: string) => Promise<SessionInit>;
}

/** 建会话需要的最小产物（真路径由 SDK 提供；测试可注入假实现）。 */
export interface SessionInit {
  piSession: PiSessionLike;
  /** pi 自己的 sessionId */
  piSessionId: string | null;
  /** 落盘文件（ephemeral 时为 null） */
  sessionFile: string | null;
  persistence: 'native' | 'ephemeral';
  persistenceReason: string;
  version: string | null;
}

/** 会话运行统计（诊断用） */
export interface SessionStats {
  id: string;
  alive: boolean;
  running: boolean;
  subscribers: number;
  rounds: number;
  lastActiveAt: number;
  persistence: 'native' | 'ephemeral';
  sessionFile: string | null;
  piSessionId: string | null;
  violations: number;
}

/** 一次 `prompt()` 的结果。 */
export interface PromptOutcome {
  /** `started` | `queued` | `handled`（由 SDK 的 preflightResult 给出） */
  disposition: string;
  /** 本轮是否以"中断"结束 */
  aborted: boolean;
  /** 是否由我们补发的 settled（SDK 没发） */
  syntheticSettled: boolean;
}

/** 项目根：`course-kb/apps/server/src/agent/` 上溯 4 级 */
function defaultCwd(): string {
  const fromEnv = process.env.COURSE_KB_ROOT;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv;
  try {
    return fileURLToPath(new URL('../../../../', import.meta.url));
  } catch {
    return process.cwd();
  }
}

/** 浏览器会话 id 校验（同时防止把 id 拼进文件路径） */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export function isValidSessionId(sessionId: string): boolean {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId);
}

/** 一个被管理的 pi 会话。 */
export class ManagedAgentSession implements ChatSessionLike {
  readonly id: string;
  private piSession: PiSessionLike;
  private readonly manager: AgentSessionManager;
  private readonly state: MapperState = createMapperState();
  private readonly listeners = new Set<(frame: AgentFrame) => void>();
  private unsubscribePi: () => void;
  private _running = false;
  private _disposed = false;
  private _rounds = 0;
  private _lastActiveAt = Date.now();
  private _piSessionId: string | null;
  private _persistence: 'native' | 'ephemeral';
  private _persistenceReason: string;
  private _version: string | null;
  private _restarted = false;
  /** 本轮 settled 是否已收到 */
  private settledSeen = false;
  /** 本轮是否以"中断"结束（由 settled 帧固化，供 prompt() 返回值用） */
  private _lastSettledAborted = false;
  private settleWaiters = new Set<() => void>();

  constructor(id: string, manager: AgentSessionManager, init: SessionInit) {
    this.id = id;
    this.manager = manager;
    this.piSession = init.piSession;
    this._piSessionId = init.piSessionId;
    this._persistence = init.persistence;
    this._persistenceReason = init.persistenceReason;
    this._version = init.version;
    // ★ 先订阅（坑 14）：在任何人拿到这个对象、发第一条 prompt 之前就挂好
    this.unsubscribePi = this.piSession.subscribe((event) => this.onPiEvent(event));
  }

  // ------------------------------------------------------------------
  private onPiEvent(event: SdkEventLike): void {
    this.touch();
    let frames: AgentFrame[];
    try {
      frames = mapSdkEvent(event, this.state);
    } catch (err) {
      this.diag(`事件映射异常（已忽略该事件）：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const frame of frames) {
      const safe = sanitizeOutgoingFrame(frame);
      if (safe === null) {
        this.state.violations += 1;
        this.diag(`出口拦截：一帧命中系统提示词特征串，已丢弃（type=${frame.type}）`);
        continue;
      }
      if (safe.type === 'settled') {
        this._running = false;
        this.settledSeen = true;
        // 记下本轮的 ended-by-abort 事实（state.abortRequested 会被映射层清掉，所以在这里固化）
        this._lastSettledAborted = safe.aborted === true;
        for (const waiter of this.settleWaiters) waiter();
        this.settleWaiters.clear();
      }
      this.emit(safe);
    }
  }

  private emit(frame: AgentFrame): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(frame);
      } catch (err) {
        this.diag(`订阅者抛异常（已隔离）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private diag(message: string): void {
    this.manager.diagnostic(message);
  }

  private touch(): void {
    this._lastActiveAt = Date.now();
  }

  /** 供管理器在连接断开时更新时间戳（空闲回收从"断开"起算）。 */
  touchNow(): void {
    this.touch();
  }

  // ------------------------------------------------------------------
  subscribe(listener: (frame: AgentFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get isRunning(): boolean {
    return this._running;
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  get stats(): SessionStats {
    return {
      id: this.id,
      alive: !this._disposed,
      running: this._running,
      subscribers: this.listeners.size,
      rounds: this._rounds,
      lastActiveAt: this._lastActiveAt,
      persistence: this._persistence,
      sessionFile: this.currentSessionFile(),
      piSessionId: this._piSessionId,
      violations: this.state.violations,
    };
  }

  currentSessionFile(): string | null {
    try {
      const file = this.piSession.sessionManager?.getSessionFile?.();
      return typeof file === 'string' ? file : null;
    } catch {
      return null;
    }
  }

  /** 构造 `ready` 帧（每次都读实时状态，避免报陈旧信息）。 */
  readyFrame(): ReadyFrame {
    const tools = this.activeTools();
    return makeReadyFrame({
      sessionId: this.id,
      model: this.modelId(),
      tools,
      toolsSource: this.manager.toolsSource,
      version: this._version,
      persistence: this._persistence,
      persistenceReason: this._persistenceReason,
      sessionFile: this.currentSessionFile(),
      piSessionId: this._piSessionId,
      thinkingLevel: this.piSession.thinkingLevel ?? null,
      restarted: this._restarted,
    });
  }

  private modelId(): string | null {
    const id = this.piSession.model?.id;
    return typeof id === 'string' ? id : null;
  }

  private activeTools(): string[] {
    try {
      const tools = this.piSession.getActiveToolNames();
      return Array.isArray(tools) ? tools.filter((t): t is string => typeof t === 'string') : [];
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------
  /**
   * 发一条消息。
   *
   * - 空闲：走 `prompt()`，然后**等 `agent_settled`**（不假设 resolve 就等于结束）
   * - 运行中：`steer` / `followUp` 二选一；都没给就**如实报错**（不猜用户意图）
   */
  async prompt(message: string, opts: { steer?: boolean; followUp?: boolean } = {}): Promise<PromptOutcome> {
    if (this._disposed) throw new Error('会话已释放（E_AGENT_DISPOSED）');
    this.touch();

    if (this._running) {
      if (opts.steer) {
        const disposition = await this.piSession.steer(message);
        return { disposition, aborted: false, syntheticSettled: false };
      }
      if (opts.followUp) {
        const disposition = await this.piSession.followUp(message);
        return { disposition, aborted: false, syntheticSettled: false };
      }
      throw new Error('运行中：请用 steer:true（插话）或 followUp:true（排队），否则 SDK 会拒绝');
    }

    beginRound(this.state);
    this.settledSeen = false;
    this._running = true;
    this._rounds += 1;

    let disposition = 'started';
    try {
      await this.piSession.prompt(message, {
        // SDK 用它告诉我们"这条 prompt 是被受理成 run，还是被 extension 处理掉了"
        preflightResult: (d) => {
          if (typeof d === 'string' && d !== '') disposition = d;
        },
      });
    } catch (err) {
      this._running = false;
      // prompt() **拒绝**（未受理）：转成分类后的 error 帧，并把本轮视为结束
      const classified = classifyFailure(err, { where: '发送 prompt', model: this.modelId() });
      this.emit(agentError(classified.code, classified.msg, { hint: classified.hint, detail: classified.detail }));
      this.emit({ type: 'settled', aborted: false, synthetic: true, disposition: 'rejected' });
      throw err;
    }

    // `disposition === 'handled'` = 没有启动运行 → 不会有 agent_settled（v1 同款处理）
    if (disposition === 'handled') {
      this._running = false;
      this.emit({ type: 'settled', aborted: false, synthetic: true, disposition });
      return { disposition, aborted: false, syntheticSettled: true };
    }

    // resolve 时通常 settled 已到；防御式再等一小段（实测差 0ms，但语义不保证）
    if (!this.settledSeen) {
      await this.waitForSettled(this.manager.settleGraceMs);
    }
    if (!this.settledSeen) {
      // 极少数情况：resolve 了但没 settled → 如实报超时 + 补一个 settled，别让 UI 永久卡住
      this._running = false;
      const classified = classifyFailure(new Error('运行已结束但未收到 agent_settled'), {
        where: '等待结束信号',
        model: this.modelId(),
      });
      this.emit(agentError(AGENT_ERROR_CODES.E_PI_TIMEOUT, classified.msg, { hint: classified.hint, detail: classified.detail }));
      this.emit({ type: 'settled', aborted: false, synthetic: true, disposition });
      return { disposition, aborted: false, syntheticSettled: true };
    }
    return { disposition, aborted: this._lastSettledAborted, syntheticSettled: false };
  }

  private waitForSettled(timeoutMs: number): Promise<void> {
    if (this.settledSeen) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.settleWaiters.delete(done);
        resolve();
      }, timeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.settleWaiters.add(done);
    });
  }

  /** 中断当前运行。**先记账**再调 SDK，避免 settled 抢先到达而漏标记。 */
  async abort(): Promise<void> {
    if (this._disposed) return;
    this.state.abortRequested = true;
    try {
      await this.piSession.abort();
    } catch (err) {
      const classified = classifyFailure(err, { where: 'abort', model: this.modelId() });
      this.emit(agentError(classified.code, classified.msg, { hint: classified.hint, detail: classified.detail }));
    }
  }

  /**
   * 重建 pi 会话（`new_session`）。
   * SDK 的 `AgentSessionRuntime` 是在替换会话时重建服务的官方路径；这里等价地
   * dispose + 新建，**订阅面不变**（业务订阅者挂在 ManagedAgentSession 上）。
   */
  async reset(): Promise<ReadyFrame> {
    if (this._disposed) throw new Error('会话已释放（E_AGENT_DISPOSED）');
    const init = await this.manager.createInit(this.id);
    const old = this.piSession;
    const oldUnsub = this.unsubscribePi;
    this.piSession = init.piSession;
    this._piSessionId = init.piSessionId;
    this._persistence = init.persistence;
    this._persistenceReason = init.persistenceReason;
    this._version = init.version ?? this._version;
    this._restarted = true;
    this.unsubscribePi = this.piSession.subscribe((event) => this.onPiEvent(event));
    try {
      oldUnsub();
    } catch {
      /* ignore */
    }
    try {
      old.dispose();
    } catch {
      /* ignore */
    }
    this._running = false;
    this.settledSeen = false;
    beginRound(this.state);
    this.touch();
    return this.readyFrame();
  }

  /** 释放会话（幂等）。 */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._running = false;
    try {
      this.unsubscribePi();
    } catch {
      /* ignore */
    }
    try {
      this.piSession.dispose();
    } catch (err) {
      this.diag(`dispose 抛异常（已忽略）：${err instanceof Error ? err.message : String(err)}`);
    }
    this.listeners.clear();
    for (const waiter of this.settleWaiters) waiter();
    this.settleWaiters.clear();
  }

  get disposed(): boolean {
    return this._disposed;
  }
}

/** 会话管理器：一浏览器会话一个 pi 会话 + 空闲回收 + 诚实降级。 */
export class AgentSessionManager implements ChatSessionManagerLike {
  readonly cwd: string;
  readonly agentDir: string | undefined;
  readonly sessionDir: string | null;
  readonly toolsSource: 'explicit' | 'none';
  readonly idleTtlMs: number;
  readonly settleGraceMs: number;

  private readonly sessions = new Map<string, ManagedAgentSession>();
  private readonly opts: AgentManagerOptions;
  private readonly tools: string[] | null;
  private readonly excludeTools: string[] | undefined;
  private readonly onDiagnostic: (message: string) => void;
  private reaper: NodeJS.Timeout | null = null;

  constructor(opts: AgentManagerOptions = {}) {
    this.opts = opts;
    this.cwd = opts.cwd ?? defaultCwd();
    this.agentDir = opts.agentDir;
    this.tools = opts.tools ?? null;
    this.excludeTools = opts.excludeTools;
    this.toolsSource = this.tools !== null ? 'explicit' : 'none';
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.settleGraceMs = opts.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;
    this.onDiagnostic = opts.onDiagnostic ?? (() => {});
    const persist = opts.persist !== false;
    this.sessionDir = opts.sessionDir === undefined ? (persist ? join(this.cwd, 'data', 'chat') : null) : opts.sessionDir;
  }

  diagnostic(message: string): void {
    try {
      this.onDiagnostic(message);
    } catch {
      /* 诊断回调自己抛异常也不能影响主流程 */
    }
  }

  /** SDK 是否可用（**不**创建会话；供 capabilities 复用缓存）。 */
  async sdkAvailable(): Promise<SdkLoadResult> {
    if (this.opts.sdkLoader) return this.opts.sdkLoader();
    return loadSdk();
  }

  /** 造一个 SDK 会话（真路径）。测试可注入 `sessionFactory` 完全绕过。 */
  async createInit(sessionId: string): Promise<SessionInit> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`非法 session id：${sessionId}`);
    }
    if (this.opts.sessionFactory) return this.opts.sessionFactory(sessionId);

    const sdk = await this.sdkAvailable();
    if (!sdk.available) {
      throw sdkUnavailable(sdk.reason);
    }

    const persistence: 'native' | 'ephemeral' = this.sessionDir ? 'native' : 'ephemeral';
    let persistenceReason: string;
    let sessionManager: unknown;
    if (this.sessionDir) {
      try {
        await mkdir(this.sessionDir, { recursive: true });
      } catch (err) {
        this.diagnostic(`会话目录不可写，回落 inMemory：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const SessionManagerCtor = sdk.SessionManager as unknown as {
      create(cwd: string, sessionDir?: string): unknown;
      inMemory(cwd?: string): unknown;
    };
    if (this.sessionDir) {
      sessionManager = SessionManagerCtor.create(this.cwd, this.sessionDir);
      persistenceReason = `pi 原生 session：${this.sessionDir}（首次 prompt 后落盘，恢复用 SessionManager.open/continueRecent）`;
    } else {
      sessionManager = SessionManagerCtor.inMemory(this.cwd);
      persistenceReason = '未启用持久化（sessionDir=null 或 persist=false）→ 用 SessionManager.inMemory()，本轮不落盘';
    }

    const options: CreateAgentSessionOptions = {
      cwd: this.cwd,
      sessionManager: sessionManager as CreateAgentSessionOptions['sessionManager'],
    };
    if (this.agentDir) options.agentDir = this.agentDir;
    if (this.tools !== null) options.tools = this.tools;
    if (this.excludeTools) options.excludeTools = this.excludeTools;
    if (this.opts.thinkingLevel) options.thinkingLevel = this.opts.thinkingLevel;

    // 自定义系统提示词（教学答疑场景）：需要 DefaultResourceLoader；
    // 拿不到就**如实降级**（只用用户消息里的说明），并记诊断 —— 不假装设置成功。
    const wantsCustomPrompt =
      typeof this.opts.systemPrompt === 'string' ||
      (this.opts.appendSystemPrompt?.length ?? 0) > 0 ||
      this.opts.noContextFiles === true;
    if (wantsCustomPrompt) {
      const Loader = sdk.DefaultResourceLoader;
      const agentDir = this.agentDir ?? sdk.getAgentDir?.();
      if (typeof Loader === 'function' && agentDir) {
        try {
          const loader = new Loader({
            cwd: this.cwd,
            agentDir,
            ...(typeof this.opts.systemPrompt === 'string' ? { systemPrompt: this.opts.systemPrompt } : {}),
            ...(this.opts.appendSystemPrompt?.length ? { appendSystemPrompt: this.opts.appendSystemPrompt } : {}),
            // 教学答疑不需要扩展/skill/模板/主题；关掉既快又少一类注入面
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            ...(this.opts.noContextFiles === true ? { noContextFiles: true } : {}),
          });
          await loader.reload();
          options.resourceLoader = loader as CreateAgentSessionOptions['resourceLoader'];
        } catch (err) {
          this.diagnostic(
            `自定义系统提示词设置失败（降级为默认提示词 + 用户消息说明）：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        this.diagnostic(
          `SDK 未提供 DefaultResourceLoader/getAgentDir，无法替换系统提示词（降级为默认提示词 + 用户消息说明）`,
        );
      }
    }

    let created: { session: AgentSession; modelFallbackMessage?: string };
    try {
      created = await sdk.createAgentSession(options);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const wrapped = new Error(`创建 pi 会话失败：${reason}`);
      wrapped.name = 'PiSessionCreateFailed';
      throw wrapped;
    }
    if (created.modelFallbackMessage) {
      this.diagnostic(`注意：SDK 报告模型回落：${created.modelFallbackMessage}`);
    }

    const piSession = created.session as unknown as PiSessionLike;
    let piSessionId: string | null = null;
    let sessionFile: string | null = null;
    try {
      const sm = piSession.sessionManager;
      piSessionId = typeof sm?.getSessionId === 'function' ? sm.getSessionId() : null;
      const file = typeof sm?.getSessionFile === 'function' ? sm.getSessionFile() : undefined;
      sessionFile = typeof file === 'string' ? file : null;
    } catch {
      /* 结构不同就当拿不到（不编造） */
    }
    return {
      piSession,
      piSessionId,
      sessionFile,
      persistence,
      persistenceReason,
      version: sdk.version,
    };
  }

  /** 取会话（同 id 复用；已 dispose 则重建）。 */
  async getOrCreate(sessionId: string): Promise<ManagedAgentSession> {
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.disposed) {
      return existing;
    }
    const init = await this.createInit(sessionId);
    const session = new ManagedAgentSession(sessionId, this, init);
    this.sessions.set(sessionId, session);
    return session;
  }

  /** 连接断开：只更新时间戳（**不销毁** —— 进程内上下文保留，重连可复用；销毁交给空闲回收）。 */
  release(sessionId: string): void {
    this.sessions.get(sessionId)?.touchNow();
  }

  get(sessionId: string): ManagedAgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** 空闲回收（返回被回收的 id）。有活跃订阅者或正在运行的**不回收**。 */
  reapIdle(now: number = Date.now()): string[] {
    const victims: string[] = [];
    for (const [id, session] of this.sessions) {
      const stats = session.stats;
      if (stats.subscribers > 0 || stats.running) continue;
      if (now - stats.lastActiveAt >= this.idleTtlMs) victims.push(id);
    }
    for (const id of victims) this.close(id);
    return victims;
  }

  close(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.dispose();
    this.sessions.delete(sessionId);
    return true;
  }

  closeAll(): number {
    const ids = [...this.sessions.keys()];
    for (const id of ids) this.close(id);
    return ids.length;
  }

  /** 启动空闲回收定时器（`unref()` 过，不会拖住进程退出）。 */
  startReaper(intervalMs = 60_000): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      try {
        this.reapIdle();
      } catch (err) {
        this.diagnostic(`空闲回收异常：${err instanceof Error ? err.message : String(err)}`);
      }
    }, intervalMs);
    this.reaper.unref?.();
  }

  stopReaper(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
  }

  stats(): {
    sessions: number;
    running: number;
    cwd: string;
    sessionDir: string | null;
    detail: SessionStats[];
  } {
    const detail = [...this.sessions.values()].map((s) => s.stats);
    return {
      sessions: detail.length,
      running: detail.filter((d) => d.running).length,
      cwd: this.cwd,
      sessionDir: this.sessionDir,
      detail,
    };
  }

  /** 帮助函数：给能力探测用（是否存在会话文件 = 持久化是否真的生效） */
  sessionFileExists(sessionId: string): boolean {
    const file = this.sessions.get(sessionId)?.currentSessionFile();
    return typeof file === 'string' ? existsSync(file) : false;
  }
}

// ---------------------------------------------------------------------------
// 默认管理器（懒创建；测试可替换）
// ---------------------------------------------------------------------------

let defaultManager: AgentSessionManager | null = null;

export function getDefaultManager(): AgentSessionManager {
  if (!defaultManager) defaultManager = new AgentSessionManager();
  return defaultManager;
}

export function configureDefaultManager(manager: AgentSessionManager | null): void {
  if (defaultManager && defaultManager !== manager) {
    try {
      defaultManager.stopReaper();
    } catch {
      /* ignore */
    }
  }
  defaultManager = manager;
}

/** pi 不可用时给调用方的统一错误（`name` 便于分类）。 */
export function sdkUnavailable(message: string): Error {
  const err = new Error(sdkUnavailableError(message).msg);
  err.name = 'PiSdkUnavailable';
  return err;
}

export { AGENT_ERROR_CODES };
