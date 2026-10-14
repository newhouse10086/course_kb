/**
 * 测试替身（**不依赖真 pi**）：用可控的假 pi 会话驱动 session/stream 的全部逻辑。
 *
 * 真实 SDK 路径由 `integration.test.ts` 覆盖；这里保证协议语义可以在毫秒级、确定性地验证。
 */

import type { PiSessionLike, SessionInit } from '../../../src/agent/session.ts';
import type { SdkEventLike } from '../../../src/agent/stream.ts';

/** 计划在某个时刻投递的事件 */
export interface ScheduledEvent {
  ms: number;
  event: SdkEventLike;
}

export interface FakeSessionOptions {
  piSessionId?: string | null;
  sessionFile?: string | null;
  persistence?: 'native' | 'ephemeral';
  persistenceReason?: string;
  version?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
  activeTools?: string[];
}

/** 可控的假 `AgentSession`。 */
export class FakePiSession implements PiSessionLike {
  /** `prompt()` 之前（同步）投递的事件 */
  emitBeforeResolve: SdkEventLike[] = [];
  /** `prompt()` resolve **之后**按延迟投递的事件（用来验证"resolve 不等于 settled"） */
  emitAfterResolve: ScheduledEvent[] = [];
  /** `preflightResult` 给出的 disposition */
  disposition = 'started';
  /** 非 null → `prompt()` 抛出该错误 */
  rejectWith: unknown = null;

  promptCalls: { text: string; options?: Record<string, unknown> }[] = [];
  steerCalls: string[] = [];
  followUpCalls: string[] = [];
  abortCalls = 0;
  disposed = false;
  lastAssistantText: string | undefined = undefined;

  model: { id?: string; provider?: string } | undefined;
  thinkingLevel: string | undefined;
  sessionManager: { getSessionId?: () => string; getSessionFile?: () => string | undefined } | undefined;

  private listeners = new Set<(event: SdkEventLike) => void>();
  private timers: NodeJS.Timeout[] = [];

  constructor(opts: FakeSessionOptions = {}) {
    const piSessionId = opts.piSessionId === undefined ? 'fake-pi-session' : opts.piSessionId;
    const sessionFile = opts.sessionFile === undefined ? null : opts.sessionFile;
    this.model = opts.modelId === null ? undefined : { id: opts.modelId ?? 'fake-model', provider: 'fake-provider' };
    this.thinkingLevel = opts.thinkingLevel === undefined ? 'medium' : (opts.thinkingLevel ?? undefined);
    this.activeTools = opts.activeTools ?? [];
    this.sessionManager = {
      getSessionId: () => piSessionId ?? '',
      getSessionFile: () => sessionFile ?? undefined,
    };
  }

  private activeTools: string[];

  subscribe(listener: (event: SdkEventLike) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 直接投递一条事件给订阅者（测试主动触发用）。 */
  deliver(event: SdkEventLike): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
    this.promptCalls.push({ text, ...(options ? { options } : {}) });
    const preflight = options?.preflightResult;
    if (typeof preflight === 'function') (preflight as (d: string) => void)(this.disposition);
    for (const event of this.emitBeforeResolve) this.deliver(event);
    if (this.rejectWith !== null) throw this.rejectWith;
    for (const scheduled of this.emitAfterResolve) {
      const timer = setTimeout(() => this.deliver(scheduled.event), scheduled.ms);
      timer.unref?.();
      this.timers.push(timer);
    }
  }

  async steer(text: string): Promise<string> {
    this.steerCalls.push(text);
    return 'queued';
  }

  async followUp(text: string): Promise<string> {
    this.followUpCalls.push(text);
    return 'queued';
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.listeners.clear();
  }

  getActiveToolNames(): string[] {
    return [...this.activeTools];
  }

  getLastAssistantText(): string | undefined {
    return this.lastAssistantText;
  }
}

/** 用假会话造一个 `SessionInit`。 */
export function fakeInit(piSession: FakePiSession, opts: FakeSessionOptions = {}): SessionInit {
  return {
    piSession,
    piSessionId: opts.piSessionId === undefined ? 'fake-pi-session' : opts.piSessionId,
    sessionFile: opts.sessionFile === undefined ? null : opts.sessionFile,
    persistence: opts.persistence ?? 'ephemeral',
    persistenceReason: opts.persistenceReason ?? '测试用：inMemory',
    version: opts.version === undefined ? '1.2.0-fake' : opts.version,
  };
}

// ---------------------------------------------------------------------------
// 常用事件构造器（字段名与 SDK 实测一致）
// ---------------------------------------------------------------------------

export const textDelta = (delta: string): SdkEventLike => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta },
});

export const thinkingDelta = (delta: string): SdkEventLike => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'thinking_delta', delta },
});

export const toolStart = (id: string, tool: string, args: unknown): SdkEventLike => ({
  type: 'tool_execution_start',
  toolCallId: id,
  toolName: tool,
  args,
});

export const toolEnd = (id: string, tool: string, opts: { isError?: boolean; durationMs?: number; text?: string } = {}): SdkEventLike => ({
  type: 'tool_execution_end',
  toolCallId: id,
  toolName: tool,
  isError: opts.isError ?? false,
  ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
  result: { content: [{ type: 'text', text: opts.text ?? 'ok' }] },
});

export const messageEnd = (role: string, extra: Record<string, unknown> = {}): SdkEventLike => ({
  type: 'message_end',
  message: { role, content: [{ type: 'text', text: `${role} text` }], ...extra },
});

/** 真实形状的 system 消息（v1/v2 实测：真提示词在 sections 里，content 是空串）。 */
export const systemMessageEnd = (): SdkEventLike => ({
  type: 'message_end',
  message: {
    role: 'system',
    content: '',
    sections: {
      preamble: 'You are an expert coding assistant operating inside pi, a coding agent harness.',
      tools: '<tools>\n- read: Read file contents\n- bash: Execute bash commands\n</tools>',
      project_context:
        '<project_context>\n<project_instructions path="D:\\x\\course-kb\\AGENTS.md">\n# AGENTS.md\n</project_instructions>\n</project_context>',
    },
    toolsAdded: [{ name: 'read' }, { name: 'bash' }],
  },
});

export const agentSettled = (aborted?: boolean): SdkEventLike =>
  aborted === undefined ? { type: 'agent_settled' } : { type: 'agent_settled', aborted };

export const agentStart = (): SdkEventLike => ({ type: 'agent_start' });
export const agentEnd = (): SdkEventLike => ({ type: 'agent_end', messages: [] });

export const autoRetryStart = (attempt: number, maxAttempts: number, errorMessage: string): SdkEventLike => ({
  type: 'auto_retry_start',
  attempt,
  maxAttempts,
  delayMs: 1000,
  errorMessage,
});

export const autoRetryEnd = (success: boolean, attempt: number, finalError?: string): SdkEventLike => ({
  type: 'auto_retry_end',
  success,
  attempt,
  ...(finalError !== undefined ? { finalError } : {}),
});

/** 等待条件成立（测试里避免固定 sleep） */
export async function waitFor(predicate: () => boolean, timeoutMs = 3000, stepMs = 5): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}
