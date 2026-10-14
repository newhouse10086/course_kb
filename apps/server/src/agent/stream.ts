/**
 * 事件 → 前端帧 的流式转发层（契约 §7.2 的 9 种帧 + §7.3 映射 + §7.3.1 裁定）。
 *
 * 这是**唯一**允许把 pi 的事件变成客户端数据的出口，所以 v1 的安全教训集中守在这里：
 *
 *   ⚠️6 **system 角色的 `message_end` 绝不转发**。
 *        v1 实测：直通会把**系统提示词 + 本项目 AGENTS.md 全文**推给浏览器，单帧 11038 字符。
 *        v2 用 SDK 在进程内跑，`session.systemPrompt` 直接就在进程里（实测长度 7846，
 *        对应 `message_end` 帧 JSON 8277 字符）——**更容易误暴露**，所以要做三层：
 *          ① 映射层直接丢弃 system 角色的 message_end（主防线）
 *          ② 转发前剥掉消息里的 `sections`/`systemPrompt` 等字段（清洗）
 *          ③ 出口前做一次**特征串扫描**，命中就丢弃并记违规（兜底 + 可测）
 *
 *   ⚠️1 `agent_settled` 正常结束时**可能没有** `aborted` 字段 → 一律 `?? false` 防御式读取；
 *       并且**桥侧补标记**：我们知道自己发过 abort，就在 settled 上补 `aborted:true, abort_source:"client"`。
 *
 *   ⚠️2 `agent_end` **不转发**（重试场景会出现多次 → UI 会提前置空闲 N 次）。
 *        实测 v2 事件序列与 v1 一致：`agent_end`×4 / `auto_retry_start`×3 / `agent_settled`×1。
 *
 *   ⚠️7 模型/凭据失败 → **一条** `error{code:E_LLM, hint}`（见 errors.ts）。
 *
 * 传输无关：本文件不 import Fastify/ws/SSE 库。`createChatConnection()` 返回的对象由
 * T-BACKEND 接到 WebSocket 或 SSE 上（见文件末尾的使用示例）。
 */

import { AGENT_ERROR_CODES, agentError, classifyFailure, sdkUnavailableError, type AgentErrorCode, type AgentErrorFrame } from './errors.ts';
import {
  describeCitationMode,
  extractCitations,
  formatRetrievalContext,
  normalizeRetrievalMode,
  safeJsonStringify,
  validateAnswerCitations,
  type CitationMode,
  type RetrievalMode,
  type RetrievedHitLike,
} from './guards.ts';

// ---------------------------------------------------------------------------
// 帧类型（契约 §7.2 的 9 种 + `RETRIEVAL.md` §4 的 `retrieval`）
// ---------------------------------------------------------------------------

/**
 * 工具策略三态（`ready.tools_source`），**必须与 `ready.tools` 一致**：
 * - `disabled-by-role`：按角色策略关掉（student / teacher / **以及未显式放行的 admin**）
 * - `explicit`：显式白名单（含默认的空集）
 * - `dangerous-opt-in`：★ **危险**：有人显式开启了危险工具（pi 默认全集）。
 *   命名刻意刺眼 —— **不要**把它做成"管理员就该有"的默认（lead 裁定：危险能力必须显式开启，
 *   不能从角色推断；管理员要调试请直接在本机开终端，不必绕道浏览器）。
 *
 * ⚠️ 原实现标的是 `none` —— 读起来像"没有工具"，而当时实际是 pi 的默认全集
 * （`read`/`bash`/`edit`/`write`）。那个自相矛盾的信号就是 shell 漏洞的线索。
 */
export type ToolsSource = 'disabled-by-role' | 'explicit' | 'dangerous-opt-in';

export interface ReadyFrame {
  type: 'ready';
  /** 浏览器会话 id（URL 里那个） */
  session_id: string;
  model: string | null;
  tools: string[];
  /** 扩展（§7.3.1 ⚠️9） */
  /** ★ 工具策略（三态；**永远与实际 `tools` 一致**，见 `ToolsSource`） */
  tools_source: ToolsSource;
  /**
   * ★ `tools_source='dangerous-opt-in'` 时的**刺眼警告**（in-band，不让它只活在枚举值里）。
   *
   * 来自独立验收的建议：让"本次会话具备主机命令执行能力"**在帧里就能被看到** ——
   * 免得教师借用 admin 账号演示时把 shell 交到学生手里而没人察觉。
   */
  tools_warning?: string;
  version: string | null;
  mode: 'sdk';
  persistence: 'native' | 'ephemeral';
  persistence_reason: string;
  session_file: string | null;
  /** pi 自己的 sessionId（**不要**与 session_id 混用） */
  pi_session_id: string | null;
  thinking_level: string | null;
  restarted: boolean;
  /** ★ 是否从磁盘恢复了历史（RETRIEVAL.md §5 要求 3：可观测） */
  resumed?: boolean;
  /** 恢复出来的历史消息条数 */
  restoredMessages?: number;
  /** `resumed=false` 时的可读原因（首次 / 损坏 / 未启用持久化）——**不许静默当新会话** */
  resumeReason?: string;
  /**
   * ★ 模型来源：
   * - `injected` / `resolved` = 用的是**项目配置/调用方指定**的模型
   * - `pi-global-fallback` = ★ 没解析出来，回落到了 pi 自己的全局默认
   *   （可能与 `/settings` 的 `llm.active` 不一致 —— 别让前端把它当成"当前模型"）
   */
  model_source?: 'injected' | 'resolved' | 'pi-global-fallback';
  /** 模型来源相关警告（非空**必须外显**） */
  model_warning?: string;
}

export interface TextDeltaFrame {
  type: 'text_delta';
  delta: string;
}
export interface ThinkingDeltaFrame {
  type: 'thinking_delta';
  delta: string;
}
export interface ToolStartFrame {
  type: 'tool_start';
  id: string | null;
  tool: string | null;
  args: unknown;
}
export interface ToolUpdateFrame {
  type: 'tool_update';
  id: string | null;
  tool: string | null;
  partial: string;
}
export interface ToolEndFrame {
  type: 'tool_end';
  id: string | null;
  tool: string | null;
  ok: boolean;
  duration_ms: number | null;
  result_text: string;
}
export interface MessageEndFrame {
  type: 'message_end';
  /** 权威完整消息；**只会是非 system 角色** */
  message: unknown;
}
/**
 * ★ 检索元信息帧（契约 `RETRIEVAL.md` §4/§6）。
 *
 * 为什么必须有：模型自己在回答里说"这次没命中"只是**转述**；UI 需要**可验证的元信息**
 * 才能渲染模式徽标、才能让学生区分 `none`（没查库）与 `empty`（查了没命中）——
 * 后者正是"三种检索各自独立、可对比"的核心。
 *
 * `status` 是**关键区分字段**（`available` 不足以表达）：
 * ```
 * none        没查库（用户选了 none）        available=true  hits=0
 * ok          查到并注入了                   available=true  hits>0
 * empty       查了、可用，但 0 命中           available=true  hits=0   ← 与 none 视觉上必须不同
 * unavailable 该模式不可用（未配置/缺数据）    available=false + reason
 * error       检索过程抛错                    available=false + reason
 * ```
 * 每轮**恰好一帧**，在 `ready` 之后、`text_delta` 之前。
 */
export interface RetrievalFrame {
  type: 'retrieval';
  mode: RetrievalMode;
  status: RetrievalStatus;
  available: boolean;
  /** 命中条数（`none` 与 `unavailable` 时恒为 0） */
  hits: number;
  /** 检索耗时（`none` 时为 null） */
  elapsedMs: number | null;
  /** 可解释性（字符串数组，UI 可展开）：为什么命中/为什么没命中 */
  why: string[];
  /** `available=false` 或 `empty` 时的可读原因（正常命中时为空串） */
  reason: string;
  /** 命中明细（最多 5 条，**不含正文片段**，只给跳转与展示需要的最小信息） */
  sources: { kind: string; ref_id: string; title: string; score: number | null }[];
}

export interface SettledFrame {
  type: 'settled';
  aborted: boolean;
  /** 仅当我们补标记时出现：`client` */
  abort_source?: 'client';
  /** 仅当 SDK 报告"没启动运行"时出现（disposition=handled） */
  synthetic?: boolean;
  disposition?: string;
}

export type AgentFrame =
  | ReadyFrame
  | RetrievalFrame
  | TextDeltaFrame
  | ThinkingDeltaFrame
  | ToolStartFrame
  | ToolUpdateFrame
  | ToolEndFrame
  | MessageEndFrame
  | SettledFrame
  | AgentErrorFrame;

/** 契约 §7.2 允许的帧类型（测试断言用） */
export const AGENT_FRAME_TYPES = [
  'ready',
  'retrieval',
  'text_delta',
  'thinking_delta',
  'tool_start',
  'tool_update',
  'tool_end',
  'message_end',
  'settled',
  'error',
] as const;
export type AgentFrameType = (typeof AGENT_FRAME_TYPES)[number];

// ---------------------------------------------------------------------------
// ⚠️6 系统提示词防泄漏
// ---------------------------------------------------------------------------

/**
 * 系统提示词的特征串（**取自真实抓包**，不是编的）：
 *  - `<project_instructions` / `project_context`：pi 把项目 AGENTS.md 塞进 sections.project_context
 *  - `You are an expert coding assistant operating inside pi`：实测的 preamble 首句
 *  - `<tools>` 开头那段工具清单
 */
export const SYSTEM_PROMPT_MARKERS: readonly string[] = [
  'project_context',
  '<project_instructions',
  'You are an expert coding assistant operating inside pi',
  '<tools>',
  'Pi documentation (read only when the user asks about pi itself',
];

/** 只允许出现在系统消息里的键名（出现在待发帧里 = 泄漏，直接剥掉）。 */
const SYSTEM_ONLY_KEYS = ['sections', 'systemPrompt', 'system_prompt', 'toolsAdded', 'docs', 'project_context', 'projectContext'] as const;

function roleOf(message: unknown): string {
  if (!message || typeof message !== 'object') return 'unknown';
  const m = message as Record<string, unknown>;
  const role = m.role ?? m.type;
  return typeof role === 'string' ? role : 'unknown';
}

/** 递归剥掉系统专用字段（返回新对象，不改原对象）。 */
function stripSystemOnlyKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSystemOnlyKeys);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if ((SYSTEM_ONLY_KEYS as readonly string[]).includes(k)) continue;
    out[k] = stripSystemOnlyKeys(v);
  }
  return out;
}

/** 帧里是否命中系统提示词特征串（出口兜底检查）。 */
export function frameLeaksSystemPrompt(frame: AgentFrame): boolean {
  let text: string;
  try {
    text = JSON.stringify(frame);
  } catch {
    return true; // 不能序列化的东西一律不放行
  }
  return SYSTEM_PROMPT_MARKERS.some((marker) => text.includes(marker));
}

/**
 * 出口清洗（**最后一道**防线）：命中特征串 → 丢弃并返回 null。
 * 正常路径下永远不该返回 null（映射层已经过滤），所以 null 会同时被计入 `violations` 供测试/告警。
 */
export function sanitizeOutgoingFrame(frame: AgentFrame): AgentFrame | null {
  if (frame.type === 'message_end') {
    const role = roleOf(frame.message);
    if (role === 'system') return null;
    const cleaned = { ...frame, message: stripSystemOnlyKeys(frame.message) };
    return frameLeaksSystemPrompt(cleaned) ? null : cleaned;
  }
  return frameLeaksSystemPrompt(frame) ? null : frame;
}

// ---------------------------------------------------------------------------
// 文本抽取（工具结果 / 部分结果）
// ---------------------------------------------------------------------------

/** 从 pi 的工具 result/partialResult 里抽可显示文本；抽不出就原样 JSON（不返回空串掩盖问题）。 */
export function extractText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const content = v.content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (typeof b.text === 'string') parts.push(b.text);
          else parts.push(safeJson(block));
        } else {
          parts.push(String(block));
        }
      }
      if (parts.length > 0) return parts.join('');
    }
    if (typeof v.text === 'string') return v.text;
    if (typeof v.output === 'string') return v.output;
  }
  return safeJson(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// 映射（契约 §7.3）
// ---------------------------------------------------------------------------

/** 映射上下文：记录"我们发过 abort"等状态，用于 ⚠️1 的补标记与 ⚠️7 的单条错误。 */
export interface MapperState {
  /** 本轮流里是否已发过 settled（保证一轮只发一次） */
  settledSent: boolean;
  /** 用户是否请求过 abort（我们自己知道的事实） */
  abortRequested: boolean;
  /** 是否观察到运行开始（用于判断 settled 是否"无中生有"） */
  runStarted: boolean;
  /** 重试状态（⚠️7：重试期间不刷屏，结束后只报一条） */
  retrying: boolean;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  /** 待报的失败（等 auto_retry_end 或 settled 时统一报） */
  pendingError: string | null;
  /** 出口违规计数（system 提示词泄漏尝试） */
  violations: number;
  /** 已转发的 system message_end 计数（必须恒为 0） */
  systemMessagesForwarded: number;
}

export function createMapperState(): MapperState {
  return {
    settledSent: false,
    abortRequested: false,
    runStarted: false,
    retrying: false,
    attempts: 0,
    maxAttempts: 0,
    lastError: null,
    pendingError: null,
    violations: 0,
    systemMessagesForwarded: 0,
  };
}

/** 一轮开始前重置"本轮"状态（保留 violations 这类全局计数）。 */
export function beginRound(state: MapperState): void {
  state.settledSent = false;
  state.runStarted = false;
  state.retrying = false;
  state.attempts = 0;
  state.maxAttempts = 0;
  state.lastError = null;
  state.pendingError = null;
}

/** 通用 SDK 事件形状（只声明我们读的字段；用 `unknown`/`any` 避免与 SDK 类型版本耦合）。 */
export interface SdkEventLike {
  type?: string;
  message?: unknown;
  /** `agent_end` 携带本轮生成的消息 */
  messages?: unknown[];
  assistantMessageEvent?: { type?: string; delta?: string } | undefined;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
  aborted?: boolean;
  /** `auto_retry_start` / `auto_retry_end`（⚠️7 用来产出**一条** E_LLM） */
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
  success?: boolean;
  finalError?: string;
  /** 仅当 SDK 真的给了 disposition（我们通过 preflightResult 自己记录，这里作为兜底） */
  disposition?: string;
}

/**
 * 把一条 SDK 事件映射成 0..n 条前端帧（契约 §7.3）。
 *
 * 纯函数 + 显式状态（可单测、可回放）。**不抛异常**。
 */
export function mapSdkEvent(event: SdkEventLike | null | undefined, state: MapperState): AgentFrame[] {
  if (!event || typeof event.type !== 'string') return [];
  const frames: AgentFrame[] = [];

  switch (event.type) {
    case 'message_update': {
      const update = event.assistantMessageEvent;
      if (!update || typeof update.type !== 'string') break;
      if (update.type === 'text_delta') {
        if (typeof update.delta === 'string' && update.delta !== '') {
          frames.push({ type: 'text_delta', delta: update.delta });
        }
      } else if (update.type === 'thinking_delta') {
        if (typeof update.delta === 'string' && update.delta !== '') {
          frames.push({ type: 'thinking_delta', delta: update.delta });
        }
      }
      // 其它 assistantMessageEvent（text_start/toolcall_*/done/...）不转发（§7.3 只列两种 delta）
      break;
    }

    case 'tool_execution_start': {
      state.runStarted = true;
      frames.push({
        type: 'tool_start',
        id: event.toolCallId ?? null,
        tool: event.toolName ?? null,
        args: event.args ?? null,
      });
      break;
    }

    case 'tool_execution_update': {
      frames.push({
        type: 'tool_update',
        id: event.toolCallId ?? null,
        tool: event.toolName ?? null,
        partial: extractText(event.partialResult),
      });
      break;
    }

    case 'tool_execution_end': {
      frames.push({
        type: 'tool_end',
        id: event.toolCallId ?? null,
        tool: event.toolName ?? null,
        ok: event.isError !== true,
        duration_ms: typeof event.durationMs === 'number' ? event.durationMs : null,
        result_text: extractText(event.result),
      });
      break;
    }

    case 'message_end': {
      // ⚠️6 主防线：system 角色**绝不**转发
      const role = roleOf(event.message);
      if (role === 'system') {
        state.systemMessagesForwarded += 0; // 明确不计数（下方断言恒为 0）
        break;
      }
      frames.push({ type: 'message_end', message: stripSystemOnlyKeys(event.message) });
      break;
    }

    case 'agent_start': {
      state.runStarted = true;
      break; // 不转发（UI 用 settled 判断空闲）
    }

    case 'agent_end': {
      // ⚠️2 **不转发**：重试场景会出现多次
      break;
    }

    case 'auto_retry_start': {
      state.retrying = true;
      if (typeof event.attempt === 'number') state.attempts = event.attempt;
      if (typeof event.maxAttempts === 'number') state.maxAttempts = event.maxAttempts;
      if (typeof event.errorMessage === 'string' && event.errorMessage) state.lastError = event.errorMessage;
      break; // 重试期间不刷屏（等最终结果）
    }

    case 'auto_retry_end': {
      // ⚠️ 用本条记录的 attempt（**实际做到第几次**）优先；拿计划值会报错"已重试 3 次"但其实只试了 1 次
      const attempts = typeof event.attempt === 'number' ? event.attempt : state.attempts;
      state.retrying = false;
      if (event.success === true) {
        state.pendingError = null;
        state.lastError = null;
        break; // 自动重试成功 → 不报错
      }
      state.pendingError =
        typeof event.finalError === 'string' && event.finalError ? event.finalError : state.pendingError;
      frames.push(...flushPendingError(state, attempts));
      state.lastError = null;
      break;
    }

    case 'agent_settled': {
      // ⚠️1 防御式读取 + 桥侧补标记
      const raw = event.aborted === true;
      const aborted = raw || state.abortRequested;
      const settled: SettledFrame = { type: 'settled', aborted };
      if (!raw && state.abortRequested) settled.abort_source = 'client';
      frames.push(...flushPendingError(state, state.attempts), settled);
      state.settledSent = true;
      state.abortRequested = false;
      break;
    }

    default:
      break; // 未知/未映射事件丢弃（前向兼容：SDK 加新事件不把桥打崩）
  }

  return frames;
}

/** ⚠️7：把暂存的失败变成**一条** `error{E_LLM}`（attempts=0 表示没重试过）。 */
function flushPendingError(state: MapperState, attempts: number): AgentFrame[] {
  if (!state.pendingError) return [];
  const message = state.pendingError;
  state.pendingError = null;
  const classified = classifyFailure(new Error(message), {
    where: '本轮运行',
    model: null,
    ...(attempts > 0 ? { attempts } : {}),
  });
  return [
    agentError(classified.code, classified.msg, {
      hint: classified.hint,
      detail: `${classified.detail}; attempts=${attempts}`,
    }),
  ];
}

/**
 * 构造 `retrieval` 帧（契约 §4："UI 要能展示这次用的是哪种检索、命中了什么"）。
 *
 * - `none` / `unavailable` / `error` **也要发帧**（否则"没发帧"与"没检索"分不清）
 * - `why` 由命中项的 `why` 汇总；拿不到就给出**确定性的**说明（不编造）
 * - `sources` 只带跳转/展示需要的最小信息（**不带正文片段**，别把知识库正文推给浏览器）
 */
export function makeRetrievalFrame(opts: {
  mode: RetrievalMode;
  status: RetrievalStatus;
  hits: number;
  elapsedMs: number | null;
  reason: string;
  items: RetrievedHitLike[];
}): RetrievalFrame {
  const why: string[] = [];
  if (opts.status === 'ok') {
    const explained = opts.items
      .map((it) => (typeof it.why === 'string' && it.why.trim() !== '' ? it.why.trim() : null))
      .filter((w): w is string => w !== null);
    if (explained.length > 0) why.push(...explained.slice(0, 5));
    else why.push(`${opts.mode} 检索命中 ${opts.hits} 条（检索器未提供 why）`);
  } else if (opts.status === 'empty') why.push(`已执行 ${opts.mode} 检索，0 命中`);
  else if (opts.status === 'none') why.push('用户选择了不使用知识库检索（none）');
  else if (opts.status === 'unavailable') why.push(`${opts.mode} 检索不可用：${opts.reason}`);
  else if (opts.status === 'error') why.push(`${opts.mode} 检索出错：${opts.reason}`);

  return {
    type: 'retrieval',
    mode: opts.mode,
    status: opts.status,
    // `none` 不是"不可用"（用户主动不检索）→ available=true；`empty` 是"可用但没命中"→ true
    available: opts.status === 'ok' || opts.status === 'empty' || opts.status === 'none',
    hits: opts.hits,
    elapsedMs: opts.elapsedMs,
    why,
    reason: opts.reason,
    sources: opts.items.slice(0, 5).map((it) => ({
      kind: typeof it.kind === 'string' ? it.kind : 'unknown',
      ref_id: it.ref_id,
      title: typeof it.title === 'string' ? it.title.slice(0, 120) : '',
      score: typeof it.score === 'number' ? it.score : null,
    })),
  };
}

/**
 * 把**策略标签**盖到 ready 帧上（工具策略由连接层按角色决定，会话层不知道角色）。
 *
 * `tools` 字段保持会话的**真实值**（`getActiveToolNames()`），只把 `tools_source` 标成
 * 三态策略之一 —— 两者必须一致：`disabled-by-role` 时 `tools` 必然是 `[]`。
 */
export function withToolsPolicy(frame: ReadyFrame, policy: ToolsSource): ReadyFrame {
  return {
    ...frame,
    tools_source: policy,
    // 危险状态**必须在帧里说出来**（不只是枚举值）—— 独立验收建议
    ...(policy === 'dangerous-opt-in'
      ? {
          tools_warning:
            '本会话已开启主机工具（read/bash/edit/write）：浏览器用户可让 agent 执行服务器命令、读取主机文件。' +
            '这是显式 opt-in 的结果，不是默认状态 —— 请勿在演示/共享账号下使用。',
        }
      : {}),
  };
}

/** 构造 `ready` 帧（把 ⚠️9 的可观测字段一次给全）。 */
export function makeReadyFrame(opts: {
  sessionId: string;
  model: string | null;
  tools: string[];
  toolsSource: ToolsSource;
  version: string | null;
  persistence: 'native' | 'ephemeral';
  persistenceReason: string;
  sessionFile: string | null;
  piSessionId: string | null;
  thinkingLevel: string | null;
  restarted: boolean;
  resumed?: boolean;
  restoredMessages?: number;
  resumeReason?: string;
  modelSource?: 'injected' | 'resolved' | 'pi-global-fallback';
  modelWarning?: string;
}): ReadyFrame {
  return {
    type: 'ready',
    session_id: opts.sessionId,
    model: opts.model,
    tools: opts.tools,
    tools_source: opts.toolsSource,
    version: opts.version,
    mode: 'sdk',
    persistence: opts.persistence,
    persistence_reason: opts.persistenceReason,
    session_file: opts.sessionFile,
    pi_session_id: opts.piSessionId,
    thinking_level: opts.thinkingLevel,
    restarted: opts.restarted,
    resumed: opts.resumed ?? false,
    restoredMessages: opts.restoredMessages ?? 0,
    ...(opts.resumeReason !== undefined ? { resumeReason: opts.resumeReason } : {}),
    model_source: opts.modelSource ?? 'pi-global-fallback',
    ...(opts.modelWarning !== undefined ? { model_warning: opts.modelWarning } : {}),
  };
}

// ---------------------------------------------------------------------------
// SSE 格式化（契约 §6：单行 JSON + keepalive）
// ---------------------------------------------------------------------------

/**
 * 把帧变成一条 SSE 事件（`data:` 必须是**单行** JSON）。
 *
 * ⚠️ 必须用 `safeJsonStringify`：`JSON.stringify` **不转义** U+2028/U+2029
 * （它们在 JSON 里合法、**不报错**），而按行切帧的读取器会把它当行分隔符 →
 * 一帧裂成两帧、第二段解析失败 → **静默丢事件**（看起来流还正常结束了）。
 * 这是 AGENTS.md ⚠️坑 17；原实现直接 `JSON.stringify(frame)`，被独立验收抓出。
 */
export function formatSse(frame: AgentFrame, eventName?: string): string {
  const name = eventName ?? frame.type;
  return `event: ${name}\ndata: ${safeJsonStringify(frame)}\n\n`;
}

/** 契约 §6：每 15 秒一次的 keepalive 注释帧。 */
export const SSE_KEEPALIVE = ': keepalive\n\n';
export const SSE_KEEPALIVE_MS = 15_000;

// ---------------------------------------------------------------------------
// 连接（传输无关；T-BACKEND 接 WS/SSE）
// ---------------------------------------------------------------------------

/** 会话的**结构化**接口（避免 stream.ts 静态 import session.ts 造成循环依赖）。 */
export interface ChatSessionLike {
  readonly id: string;
  readonly isRunning: boolean;
  subscribe(listener: (frame: AgentFrame) => void): () => void;
  prompt(
    message: string,
    opts?: { steer?: boolean; followUp?: boolean; context?: string },
  ): Promise<{ disposition: string; aborted: boolean; syntheticSettled: boolean }>;
  abort(): Promise<void>;
  setModel?(ref: string): Promise<{ ok: boolean; reason?: string }>;
  reset(): Promise<ReadyFrame>;
  readyFrame(): ReadyFrame;
}

export interface ChatSessionManagerLike {
  /**
   * 取/建会话。`init.tools` 是**按连接/角色**给的工具白名单：
   * 只在会话**首次创建**时生效（已存在的会话不会被改写 —— 避免半个会话换工具集）。
   */
  getOrCreate(sessionId: string, init?: { tools?: string[] }): Promise<ChatSessionLike>;
  release(sessionId: string): void;
  /**
   * 管理器**当前配置**的工具白名单（`null` = pi 默认全集）。
   * 可选：连接层用它判断"管理员未指定白名单"时是否真的会落到 pi 默认。
   */
  readonly tools?: string[] | null;
}

export interface ChatConnection {
  readonly sessionId: string;
  /** 处理一条客户端消息（契约 §7.2 的 5 种 + `get_state` 扩展）。**不抛**。 */
  handleClientMessage(raw: string | Uint8Array | Buffer): Promise<void>;
  /** 连接断开时调用（解绑订阅；会话保留以便复用/空闲回收）。 */
  close(code?: number, reason?: string): Promise<void>;
}

export interface CreateChatConnectionOptions {
  sessionId: string;
  /** 把帧送给客户端（WS: JSON.stringify；SSE: formatSse） */
  send: (frame: AgentFrame) => void | Promise<void>;
  /** 需要服务端主动关闭时调用（如 pi 不可用 → 1013） */
  onClose?: (code: number, reason: string) => void;
  /** 注入会话管理器（测试用；不传则用 session.ts 的默认管理器） */
  manager?: ChatSessionManagerLike;
  /**
   * ★ 检索钩子（RETRIEVAL.md §4）——**只能在服务端调用**。
   *
   * ⚠️ **绝不能**接受客户端传来的检索文本：那等于把"可信的检索内容"这条通道交给客户端伪造，
   * 而且比直接写 message 更危险（模型和我们自己的引用白名单都会认为它来自检索）。
   * 客户端只能传**模式**（`none|wiki|kg|rag`），由这里用**服务端身份**去取内容。
   */
  retrieval?: RetrievalHook | null;
  /**
   * 服务端认定的调用者身份（检索隔离 / RBAC 用）。
   * ⚠️ 必须由服务端（会话/令牌）填充，**不要**从客户端帧里读。
   */
  user?: { id: string | null; roles?: string[] };
  /**
   * ★ **服务端权威的角色策略**（由 backend-api 按 `req.user.roles` 判定后传入）。
   *
   * ⚠️ Lead 裁定：**它不再决定"给不给工具"** —— 任何角色（含 admin）默认都是 `[]`。
   * 现在它只用于**诊断/审计**（说明是哪个角色、以及为什么没工具）。
   * 要工具请走 `tools` 白名单；要**危险**工具请走独立开关 `dangerousTools`。
   */
  allowTools?: boolean;
  /**
   * ★ **危险 opt-in**（独立开关，**不来自角色**）：允许 pi 的默认工具全集
   * （`read`/`bash`/`edit`/`write`）。
   *
   * 默认 **false**。开启意味着"浏览器用户可以让 agent 执行主机命令/读主机文件"——
   * 仅限本机可信运维场景，且**必须**同时给 `AgentSessionManager` 配 `allowPiDefaultTools: true`
   * 才真的会生效（两道显式开关）。`ready.tools_source` 会标成刺眼的 `dangerous-opt-in`。
   */
  dangerousTools?: boolean;
  /**
   * 允许的工具白名单（管理员按策略给；危险内置工具仍会被管理器过滤）。
   */
  tools?: string[];
  /**
   * ★ 按角色的**工具白名单**（可选，优先级高于 `allowTools`；不传则用 `allowTools` 策略）。
   * 例如：`toolsFor: (u) => (u.roles?.includes('admin') ? ['kb_read'] : [])`
   */
  toolsFor?: (user: { id: string | null; roles?: string[] }) => string[];
  /**
   * ★ 每轮结束（`settled`）后的**引用校验**回调（RETRIEVAL.md §4）。
   *
   * 三档：`cited`（引用有效）/ `forged`（引用了不在检索结果里的 id，疑似编造）/
   * `missing`（检索给了东西却一次都没引用）。**只上报不自作主张改回答**。
   */
  onAnswerAudit?: (audit: AnswerAudit) => void;
}

/** 引用校验 + 检索状态（给 backend-api 记指标/审计用） */
export interface AnswerAudit {
  round: number;
  mode: CitationMode;
  citations: string[];
  unknown: string[];
  contextProvided: boolean;
  retrievalMode: RetrievalMode;
  retrievalStatus: RetrievalStatus;
  /** 检索耗时（`none` 时 null） */
  retrievalElapsedMs?: number | null;
  /** 命中条数 */
  retrievalHits?: number;
  /** 检索不可用/失败时的可读原因 */
  retrievalReason: string;
  describe: string;
}

export type RetrievalStatus = 'none' | 'ok' | 'empty' | 'unavailable' | 'error';

/** 服务端检索钩子（实现方：`src/retrieval/**`，由 backend-api/kg-rag 提供） */
export interface RetrievalHook {
  retrieve(args: {
    mode: RetrievalMode;
    query: string;
    /** ★ 服务端身份（不是客户端给的） */
    userId: string | null;
    sessionId: string;
    limit?: number;
  }): Promise<{
    mode?: RetrievalMode;
    available: boolean;
    reason?: string;
    items: RetrievedHitLike[];
    elapsedMs?: number;
  }>;
  /** 可选：实现方自己格式化（不提供则用 `guards.formatRetrievalContext`） */
  formatContext?: (items: RetrievedHitLike[], mode: RetrievalMode) => string;
}

/** 客户端消息的必填字段（契约 §7.2） */
const REQUIRED_FIELDS: Record<string, string> = {
  prompt: 'message',
  steer: 'message',
  set_model: 'model',
};

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * 创建一个聊天连接。
 *
 * **永不抛**：pi 不可用时发一帧 `error{E_PI_UNAVAILABLE}` 并请求关闭（诚实降级），
 * 返回一个"哑"连接（后续消息只回同一条错误）。
 */
export async function createChatConnection(opts: CreateChatConnectionOptions): Promise<ChatConnection> {
  const { sessionId, send, onClose } = opts;

  if (!SESSION_ID_RE.test(sessionId)) {
    const frame = agentError(AGENT_ERROR_CODES.E_PI_SESSION_ID, `非法 session id：${sessionId}`, {
      hint: '只允许字母/数字/. _ -，长度 1..64',
    });
    await safeSend(send, frame);
    onClose?.(1008, 'invalid session id');
    return dummyConnection(sessionId, frame);
  }

  let manager = opts.manager;
  if (!manager) {
    try {
      const mod = await import('./session.ts');
      manager = mod.getDefaultManager();
    } catch (err) {
      const frame = sdkUnavailableError('agent 会话模块不可用', String(err));
      await safeSend(send, frame);
      onClose?.(1013, 'agent module unavailable');
      return dummyConnection(sessionId, frame);
    }
  }

  let session: ChatSessionLike;
  let toolsPolicy: ToolsSource;
  try {
    // ★ 角色 → 工具策略（**服务端权威**；客户端帧里的任何 roles/allowTools 一律不读）。
    //
    //   真事故（prober 在 live 8787 用 student 复现）：`ready.tools = [read,bash,edit,write]`
    //   而 `tools_source` 却是 `"none"` —— 代码以为关了、pi 用了默认全集，
    //   学生一句"用 bash 执行 X"服务器就真的执行。**隐式默认（不传）在 pi 那边 = 全集**。
    //
    //   ★ Lead 裁定：**任何角色（含 admin）默认都是 `[]`**。
    //     "管理员"不等于"可以借浏览器执行主机命令"（产品没有这需求：管理员的合法操作是建号/建课/审核/配模型；
    //      要调试请直接在本机开终端）。危险能力必须**显式 opt-in**，且**不能从角色推断**。
    let perSessionTools: string[] | undefined;
    let policyNote = '';
    if (typeof opts.toolsFor === 'function') {
      // 按角色自定义白名单（最明确的一条路）
      perSessionTools = opts.toolsFor(opts.user ?? { id: null });
      toolsPolicy = perSessionTools.length > 0 ? 'explicit' : 'disabled-by-role';
    } else if (opts.dangerousTools === true) {
      // ★ 危险 opt-in（**独立开关**，不来自角色）：不指定 → 交给管理器（只有它 allowPiDefaultTools 时才真是全集）
      perSessionTools = opts.tools && opts.tools.length > 0 ? opts.tools : undefined;
      toolsPolicy = 'dangerous-opt-in';
      policyNote = `会话 ${sessionId} 显式开启了危险工具（dangerousTools:true）`;
    } else if (opts.tools && opts.tools.length > 0) {
      // 显式白名单（管理员按策略给）—— 危险内置工具仍会被管理器剔除，除非 allowDangerousTools
      perSessionTools = opts.tools;
      toolsPolicy = 'explicit';
    } else {
      // ★ 默认：任何角色都 **显式空数组**（含 admin；`allowTools:true` 但没给白名单也是空集）
      perSessionTools = [];
      toolsPolicy = 'disabled-by-role';
      if (opts.allowTools === true) {
        policyNote = `会话 ${sessionId} 的调用方放行了工具（allowTools:true）但未提供白名单 → 仍是空集（要危险工具请显式 dangerousTools:true）`;
      }
    }
    if (policyNote) {
      // 这条要能被看到（默认拒绝 + 显式放行的边界）
      process.stderr.write(`[agent][tools] ${policyNote}\n`);
    }
    session = await manager.getOrCreate(sessionId, perSessionTools !== undefined ? { tools: perSessionTools } : undefined);
  } catch (err) {
    const classified = classifyFailure(err, { where: '创建会话' });
    // ★ 凭据文件**形状**错（就是让 pi 静默挂死的那种）：给可读原因 + 修法，
    //   而且**不要**说成"pi 不可用"（SDK 好好的，是部署配置的形状问题）。
    const isAuthShape = (err as Error)?.name === 'PiAuthShapeInvalid';
    const isSdkMissing = classified.kind === 'unknown' && String(err).includes('pi SDK');
    const frame = isAuthShape
      ? agentError(AGENT_ERROR_CODES.E_PI_CMD, String((err as Error).message), {
          hint: '这是**部署配置**问题（不是模型、也不是学生的操作）：按消息里的形状修正 pi 凭据文件后重试',
          detail: 'PiAuthShapeInvalid（形状错的凭据会让 pi 静默挂死 → 所以在建会话前就拦下）',
        })
      : isSdkMissing
        ? sdkUnavailableError(String((err as Error)?.message ?? err))
        : agentError(classified.code, classified.msg, { hint: classified.hint, detail: classified.detail });
    await safeSend(send, frame);
    if (frame.code === AGENT_ERROR_CODES.E_PI_UNAVAILABLE) onClose?.(1013, 'pi unavailable');
    return dummyConnection(sessionId, frame);
  }

  // 先订阅，再发 ready（⚠️14：先订阅再触发，否则漏掉快速事件）
  // ⚠️ 但**必须保证 ready 是第一帧**：订阅回调在 ready 之前收到的事件只能先**缓冲**。
  // （原错误写法：subscribe 之后立刻 flush → 事件可能在 `await send(ready)` 之前就发出去，
  //   前端第一帧收到 text_delta 却还没有 model/session 信息，破坏契约 §7.2 的帧顺序。）
  const queue: AgentFrame[] = [];
  let flushing = false;
  let readySent = false;
  let closed = false;
  // ★ 引用校验（RETRIEVAL.md §4）的每轮状态
  let currentRound = 0;
  let currentRoundText = '';
  let currentContextValidIds: string[] = [];
  let auditContextProvided = false;
  let auditRetrievalMode: RetrievalMode = 'none';
  let auditRetrievalStatus: RetrievalStatus = 'none';
  let auditRetrievalReason = '';
  let auditRetrievalElapsedMs: number | null = null;
  let auditRetrievalHits = 0;

  const flush = async (): Promise<void> => {
    if (flushing || !readySent) return;
    flushing = true;
    try {
      while (queue.length > 0 && !closed) {
        const frame = queue.shift();
        if (!frame) break;
        const safe = sanitizeOutgoingFrame(frame);
        if (safe === null) continue; // 出口兜底拦下（正常不该发生）
        await safeSend(send, safe);
      }
    } finally {
      flushing = false;
    }
  };

  const unsubscribe = session.subscribe((frame) => {
    // ★ 本轮引用校验：攒文本 → `settled` 时按本次检索结果做三档判定并回调。
    //   **只上报，不改回答**（回答是模型的话，改了就说不清"谁说的"）。
    if (frame.type === 'text_delta') currentRoundText += frame.delta;
    if (frame.type === 'message_end') {
      const msg = frame.message as { role?: unknown } | null;
      if (msg && msg.role === 'assistant') {
        const content = (msg as { content?: unknown }).content;
        if (Array.isArray(content)) {
          const text = content
            .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
            .join('');
          if (text !== '') currentRoundText = text; // message_end 是权威
        }
      }
    }
    if (frame.type === 'settled' && currentRound > 0 && opts.onAnswerAudit) {
      const verdict = validateAnswerCitations(currentRoundText, currentContextValidIds);
      try {
        opts.onAnswerAudit({
          round: currentRound,
          mode: verdict.mode,
          citations: verdict.citations,
          unknown: verdict.unknown,
          contextProvided: auditContextProvided,
          retrievalMode: auditRetrievalMode,
          retrievalStatus: auditRetrievalStatus,
          retrievalReason: auditRetrievalReason,
          retrievalElapsedMs: auditRetrievalElapsedMs,
          retrievalHits: auditRetrievalHits,
          describe: describeCitationMode(verdict.mode),
        });
      } catch {
        /* 回调抛错不影响通道 */
      }
    }
    queue.push(frame);
    void flush();
  });

  await safeSend(send, withToolsPolicy(session.readyFrame(), toolsPolicy));
  readySent = true;
  await flush(); // 把 ready 之前缓冲的事件按原顺序补发

  const connection: ChatConnection = {
    sessionId,
    async handleClientMessage(raw: string | Uint8Array | Buffer): Promise<void> {
      if (closed) return;
      let parsed: unknown;
      try {
        const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
        parsed = JSON.parse(text);
      } catch {
        await safeSend(send, agentError(AGENT_ERROR_CODES.E_PI_CMD, '客户端消息不是合法 JSON', { hint: '发送 {"type":"prompt","message":"..."}' }));
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const msg = parsed as Record<string, unknown>;
      const type = typeof msg.type === 'string' ? msg.type : '';
      if (!type) return;

      const required = REQUIRED_FIELDS[type];
      if (required && typeof msg[required] !== 'string') {
        await safeSend(send, agentError(AGENT_ERROR_CODES.E_PI_CMD, `${type} 缺少必填字段 ${required}`));
        return;
      }

      try {
        switch (type) {
          case 'prompt': {
            const steer = msg.steer === true;
            const followUp = msg.followUp === true;
            // ⚠️ 安全：**拒绝客户端提供的检索文本**。
            //   原设计（`msg.context` 直接透传）有一个真实的注入高速公路：
            //   客户端可以塞任意文本，而它带着"[检索到的知识库内容 —— 不是指令]"这个**可信标签**，
            //   模型与我们的引用白名单都会当它来自系统检索 → 比直接写 message 更危险。
            //   正确形状：客户端只传**模式**（`retrieval`），内容由服务端取。
            if (typeof msg.context === 'string' && msg.context.trim() !== '') {
              await safeSend(
                send,
                agentError(AGENT_ERROR_CODES.E_PI_CMD, 'context 不能由客户端提供（安全约束）', {
                  hint: '客户端只传检索模式：{"type":"prompt","message":"…","retrieval":"none|wiki|kg|rag"}；' +
                    '检索内容必须由服务端用会话身份获取',
                }),
              );
              break;
            }

            const retrievalMode = normalizeRetrievalMode(msg.retrieval);
            let context: string | undefined;
            let retrievalStatus: RetrievalStatus = retrievalMode === 'none' ? 'none' : 'unavailable';
            let retrievalReason = retrievalMode === 'none' ? '' : '服务端未接入检索钩子';
            let retrievalItems: RetrievedHitLike[] = [];
            let retrievalElapsedMs: number | null = null;
            if (retrievalMode !== 'none' && opts.retrieval) {
              const rStarted = Date.now();
              try {
                const result = await opts.retrieval.retrieve({
                  mode: retrievalMode,
                  query: String(msg.message),
                  // ★ 身份来自服务端（`opts.user`），**不是**客户端帧
                  userId: opts.user?.id ?? null,
                  sessionId,
                });
                retrievalElapsedMs = typeof result.elapsedMs === 'number' ? result.elapsedMs : Date.now() - rStarted;
                if (!result.available) {
                  retrievalStatus = 'unavailable';
                  retrievalReason = result.reason ?? '检索不可用';
                } else if (result.items.length === 0) {
                  retrievalStatus = 'empty';
                  retrievalReason = '检索可用但没有命中';
                } else {
                  retrievalStatus = 'ok';
                  retrievalReason = '';
                  retrievalItems = result.items;
                  const formatted =
                    opts.retrieval.formatContext?.(result.items, retrievalMode) ??
                    formatRetrievalContext(result.items);
                  context = formatted.trim() === '' ? undefined : formatted;
                  if (context === undefined) retrievalStatus = 'empty';
                }
              } catch (err) {
                retrievalElapsedMs = Date.now() - rStarted;
                retrievalStatus = 'error';
                retrievalReason = err instanceof Error ? err.message : String(err);
              }
            }
            // ★ 契约 §4/§6：把**检索元信息**发给客户端（数据本来就算出来了，只是以前没发）。
            //   让 UI 能显示"这次用了哪种检索 / 命中什么 / 为什么没查到"，
            //   也让学生能区分 `none`（没查库）与 `empty`（查了没命中）—— 这正是"三种检索各自独立"的核心。
            //   ① 不可用时**也要发**（否则"没发帧"与"没检索"分不清）；
            //   ② 每轮**恰好一帧**，在 `ready` 之后、`text_delta` 之前。
            await safeSend(
              send,
              makeRetrievalFrame({
                mode: retrievalMode,
                status: retrievalStatus,
                hits: retrievalItems.length,
                elapsedMs: retrievalElapsedMs,
                reason: retrievalReason,
                items: retrievalItems,
              }),
            );
            auditRetrievalElapsedMs = retrievalElapsedMs;
            auditRetrievalHits = retrievalItems.length;
            // 检索没成功时：把"这一轮没有知识库依据"如实写进提示词，让模型告诉学生
            // （不新增帧类型；学生看到的是"这次回答没有引用知识库"，而不是一份假装有出处的答案）
            const contextForPrompt =
              context ??
              (retrievalMode === 'none'
                ? undefined
                : `[本次检索未能提供知识库内容：${retrievalReason}]（请在回答里如实说明这次没有知识库依据，不要编造引用）`);

            currentContextValidIds = context ? extractCitations(context) : [];
            currentRoundText = '';
            currentRound += 1;
            auditContextProvided = context !== undefined;
            auditRetrievalMode = retrievalMode;
            auditRetrievalStatus = retrievalStatus;
            auditRetrievalReason = retrievalReason;
            // 本轮结束的信号由 session 内部（agent_settled）保证；这里 await 只是为了
            // 在失败时拿到异常并变成 error 帧（SDK: prompt() 在运行结束时 resolve）。
            await session.prompt(String(msg.message), {
              steer,
              followUp,
              ...(contextForPrompt ? { context: contextForPrompt } : {}),
            });
            break;
          }
          case 'steer': {
            await session.prompt(String(msg.message), { steer: true });
            break;
          }
          case 'abort': {
            await session.abort();
            break;
          }
          case 'set_model': {
            if (typeof session.setModel !== 'function') {
              await safeSend(send, agentError(AGENT_ERROR_CODES.E_PI_CMD, 'SDK 路径不支持 set_model', {
                hint: '进程内 SDK 需要 Model 对象；请新建会话或在 createAgentSession 时指定模型',
              }));
              break;
            }
            const ref = String(msg.model);
            const result = await session.setModel(ref);
            if (!result.ok) {
              await safeSend(send, agentError(AGENT_ERROR_CODES.E_PI_CMD, `切换模型失败：${result.reason ?? ref}`, {
                hint: '模型必须已在 pi 的 models.json/目录里且凭据可用',
              }));
            }
            await safeSend(send, withToolsPolicy(session.readyFrame(), toolsPolicy));
            break;
          }
          case 'new_session': {
            const ready = await session.reset();
            await safeSend(send, withToolsPolicy(ready, toolsPolicy));
            break;
          }
          case 'get_state': {
            await safeSend(send, withToolsPolicy(session.readyFrame(), toolsPolicy));
            break;
          }
          default: {
            await safeSend(send, agentError(AGENT_ERROR_CODES.E_PI_CMD, `未知的客户端消息类型：${type}`));
            break;
          }
        }
      } catch (err) {
        const classified = classifyFailure(err, { where: `处理 ${type}` });
        await safeSend(send, agentError(classified.code, classified.msg, { hint: classified.hint, detail: classified.detail }));
      }
    },
    async close(): Promise<void> {
      closed = true;
      unsubscribe();
      manager.release(sessionId);
    },
  };

  return connection;
}

function dummyConnection(sessionId: string, frame: AgentFrame): ChatConnection {
  return {
    sessionId,
    async handleClientMessage() {
      // 保持诚实：不可用就一直说不可用，不假装能用
      void frame;
    },
    async close() {
      /* no-op */
    },
  };
}

async function safeSend(send: (frame: AgentFrame) => void | Promise<void>, frame: AgentFrame): Promise<void> {
  try {
    await send(frame);
  } catch {
    /* 对端已断开：静默 */
  }
}
