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
}) => Promise<ChatConnectionLike>;

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
  /** RBAC 自述（`/capabilities` 的 `auth` 段；UI 据此决定是否显示登录页）。 */
  auth: { required: boolean; bootstrap: 'initialized' | 'not_initialized' | 'just_created' };
  /**
   * 抽取能力真探测（结果有缓存）。`POST /documents/:id/extract` 入队前用它：
   * 不可用 → **如实 503 + reason**，绝不排一个注定产出 0 张卡片的"成功"任务。
   */
  extractAvailability: () => Promise<{ ok: boolean; reason: string }>;
}
