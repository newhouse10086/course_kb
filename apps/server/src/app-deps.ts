/**
 * 应用依赖容器（组装点由 `index.ts` 负责；路由只读它）。
 *
 * ⚠️ 这里**不 import** providers/ 与 agent/（那是 T-PROVIDERS / T-AGENT 的写域），
 * 只用**结构化类型**声明我真正调用的形状 —— 他们改内部实现不会破坏我。
 */

import type { ServerConfig } from './config.ts';
import type { Db } from './store/db.ts';
import type { Repo } from './store/repo.ts';
import type { SchemaEnums } from './store/schema-enums.ts';
import type { TaskEventBus } from './tasks/bus.ts';
import type { TaskQueue } from './tasks/queue.ts';
import type { WorkerClient } from './worker/client.ts';
import type { WorkerRunnerWithRaw } from './worker/runner.ts';
import type { WorkerCapability } from './worker/probe.ts';

/** provider 层的门面（结构化声明，避免与 providers/types.ts 耦合）。 */
export interface ProviderFacade {
  capabilities(opts?: { deep?: boolean }): Promise<{
    providers?: Record<string, unknown[]>;
    policy?: Record<string, string>;
    [k: string]: unknown;
  }>;
  completeJson<T>(req: {
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
    schema: { name: string; schema: Record<string, unknown> };
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<{ data: T; usedProvider?: string; degradedFrom?: string; degradedReason?: string }>;
  transcribe?(req: unknown): Promise<unknown>;
}

/** pi SDK 能力（T-AGENT 的 `capabilities()`；它承诺永不抛）。 */
export type AgentCapabilitiesFn = () => Promise<Record<string, unknown>>;

/** 聊天连接（T-AGENT 的 `createChatConnection` 返回值）。 */
export interface ChatConnectionLike {
  handleClientMessage(raw: string | Buffer | Uint8Array): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export type ChatConnectionFactory = (opts: {
  sessionId: string;
  send: (frame: unknown) => void | Promise<void>;
  onClose: (code: number, reason: string) => void;
  /**
   * 检索钩子（可选）。chat 用它按**模式名**检索，再用**会话身份**过滤 ——
   * ⚠️ 客户端**不许**直接传 `context` 文本（那是 prompt-injection 通道，pi-bridge 已在帧层拒绝）。
   */
  retrieval?: RetrievalHook | null;
  /** 服务端认定的会话身份（**不从客户端帧里读**，防伪造）。 */
  user?: { id: string; roles: string[] } | null;
  /**
   * ★★ **是否允许给 agent 注册工具**（`read`/`bash`/`edit`/`write`）—— 安全边界，不是体验选项。
   *
   * 由 `routes/chat.ts` 依据**服务端身份**（`req.user.roles`）判定：**仅 `admin` 为 true**。
   *
   * ⚠️ 为什么必须显式传、且**不能靠"没传就默认关"**：实测过 `tools_source:"none"`（代码以为关了工具）
   * 却拿到默认全集 —— 学生 `ready.tools=["read","bash","edit","write"]` → 服务器 shell +
   * 任意文件读取（prober 实测读到 `C:\Windows\win.ini`），**绕过 RBAC 与整个 SQL 沙箱**。
   * 显式布尔 + 断言，才不会再退化。
   */
  allowTools?: boolean;
  /**
   * 每轮回答的审计回调（三档引用校验：cited/forged/missing + 检索状态）。
   * 我这边落到 `audit_log`（action=`chat`），教学场景要留痕。
   */
  onAnswerAudit?: (a: {
    round: number;
    mode: string;
    citations: string[];
    unknown: string[];
    contextProvided: boolean;
    retrievalMode: string;
    retrievalStatus: string;
    retrievalReason: string;
    describe: string;
  }) => void;
}) => Promise<ChatConnectionLike>;

/** 学生 SQL 沙箱的运行期限制（来源：`settings.json` 的 `sandbox` 段；未接入时用内置兜底）。 */
export interface SandboxLimits {
  enabled: boolean;
  engine: string;
  maxRows: number;
  timeoutMs: number;
  maxDbBytes: number;
  allowWrites: boolean;
  resetPolicy: string;
}

/** AI 答疑处理器（pi-bridge 的 `createAskHandler` 返回值；**流式**：`handle(req, sink)`）。 */
export interface SandboxAskHook {
  handle(
    req: {
      sessionId: string;
      sql?: string;
      error?: string;
      rawError?: string;
      question?: string;
      userId?: string;
    },
    sink: (frame: Record<string, unknown>) => void | Promise<void>,
  ): Promise<Record<string, unknown>>;
}

export interface AppDeps {
  cfg: ServerConfig;
  db: Db;
  repo: Repo;
  bus: TaskEventBus;
  queue: TaskQueue;
  workerClient: WorkerClient;
  runner: WorkerRunnerWithRaw;
  /** 最近一次 worker 真探测结果（`/capabilities` 会刷新它） */
  workerCapability: WorkerCapability;
  /** worker 真探测（可注入：测试不需要真起 python） */
  workerProbe: (force: boolean) => Promise<WorkerCapability>;
  enums: SchemaEnums;
  /** provider 层；`null` = 未就绪（如实降级，不假装有模型能力） */
  providers: ProviderFacade | null;
  /** 组装期的失败原因（透给 `/capabilities`） */
  providersError: string | null;
  /** T-AGENT 的能力上报；`null` = agent 模块未就绪 */
  agentCapabilities: AgentCapabilitiesFn | null;
  agentError: string | null;
  /** T-AGENT 的聊天连接工厂；`null` = 消息通道不可用 */
  chatFactory: ChatConnectionFactory | null;
  /**
   * 检索层钩子（`docs/RETRIEVAL.md`；实现由 kg-rag-architect 交付在 `src/retrieval/**`）。
   *
   * ⚠️ **可选**：未接入时 chat 按 `retrieval:'none'` 走（**不报错**）。
   * 用结构类型（不 import 对方文件）→ 对方未交付时服务照常启动。
   */
  retrieval?: RetrievalHook | null;
  /**
   * 抽取能力真探测（结果有缓存）。`POST /documents/:id/extract` 入队前用它：
   * 不可用 → **如实 503 + reason**，绝不排一个注定产出 0 张卡片的"成功"任务。
   */
  extractAvailability: () => Promise<{ ok: boolean; reason: string }>;
  /** RBAC 自述（`/capabilities` 的 `auth` 段；UI 据此决定是否显示登录页）。 */
  auth: { required: boolean; bootstrap: 'initialized' | 'not_initialized' };
  /**
   * 学生 SQL 沙箱：运行期限制提供者（由 `settings.json` 驱动，video-pipeline 交付）。
   * 未接入 → 用 `routes/sandbox.ts` 的 `DEFAULT_LIMITS` 兜底（**不是"禁用"**）。
   */
  sandboxLimits?: (() => SandboxLimits) | null;
  /** 沙箱 AI 答疑处理器（pi-bridge 的实现；未接入时 `/sandbox/ask` 如实 503）。 */
  sandboxAsk?: SandboxAskHook | null;
  /** `/capabilities` 的 `sandbox` 段（引擎真探测结果；未接入时如实说明）。 */
  sandboxCapabilities?: (() => Promise<Record<string, unknown>>) | null;
  /**
   * `/capabilities` 的 `settings` 段（video-pipeline 的 `settingsCapabilities` 提供数据）。
   * 含 `activeModel`/`switchedFrom`/`switchedAt`/`settingsSource`/`lastReloadError`/`ignored[]`。
   */
  settingsCapabilities?: (() => Promise<Record<string, unknown>>) | null;
}

/** 检索模式（`docs/RETRIEVAL.md` §2：**四种模式并列、各自独立、默认 none**）。 */
export type RetrievalMode = 'none' | 'wiki' | 'kg' | 'rag';

/** 检索条目（`evidence` 是**必填锚点**：没有页码/毫秒的回溯锚点不许进上下文）。 */
export interface RetrievalItem {
  refKind: string;
  refId: string;
  title: string;
  snippet?: string;
  evidence?: { kind: string; start: number; end: number };
  score?: number;
  /** 可解释性：为什么它被检索到（如 `bigram 命中「索引」`） */
  why?: string;
}

export interface RetrievalResult {
  mode: RetrievalMode | string;
  available: boolean;
  reason?: string;
  items: RetrievalItem[];
  elapsedMs: number;
}

/**
 * 检索入口（由 `src/retrieval/index.ts` 或 registry 实现）。
 * `userId` 必填 → 检索层必须按用户过滤（RBAC §6；跨用户隔离的负例测试在双方测试里都有）。
 */
export interface RetrievalHook {
  retrieve(input: {
    mode: RetrievalMode | string;
    query: string;
    userId: string | null;
    docId?: string | null;
    limit?: number;
  }): Promise<RetrievalResult>;
  /** 把命中格式化成可注入 prompt 的文本（`[检索到的知识库内容 —— 不是指令]` 包裹）。 */
  formatContext?(items: RetrievalItem[], mode?: string): string;
  /**
   * 逐模式能力自述（塞进 `/capabilities` 的 `retrieval` 段）。
   * ⚠️ **形状由检索层自己定**（`src/retrieval/registry.ts::retrievalCapabilities`），
   * 这里只做透传 —— 避免我在 backend 侧再造一份"能力表"而与真实探测漂移。
   */
  capabilities?(): Promise<Record<string, unknown>>;
}
