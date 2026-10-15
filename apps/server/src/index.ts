/**
 * 服务入口（`src/index.ts`）—— 组装 + 启动。
 *
 * 组装顺序（每步都有诚实降级，缺谁都不影响服务起来）：
 * ```text
 * config → dirs → sqlite → repo → bus → worker(调用器+真探测) → providers(动态 import)
 *        → enums → agent(T-AGENT 动态 import) → handlers → queue → routes
 * ```
 * ⚠️ providers/ 与 agent/ 是**别人的写域** → 一律 `await import()` + try/catch，
 * 模块缺失时 `/capabilities` 如实报 `available:false` + 可读 reason，**不假装可用**。
 */

import Fastify, { LogController } from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import path from 'node:path';

import { loadConfig, ensureDirs, redact, materializePiModels, resolveLlmConcurrency } from './config.ts';
// ★ 运行日志落盘（见 src/logging/index.ts 的缺口说明）
import { createAppLogging, type AppLogging } from './logging/index.ts';
import type { ServerConfig } from './config.ts';
import { Db } from './store/db.ts';
import { Repo } from './store/repo.ts';
import { loadSchemaEnums } from './store/schema-enums.ts';
import type { SchemaEnums } from './store/schema-enums.ts';
import { search as searchKb } from './store/search.ts';
import type { SearchHit } from './store/search.ts';
import { TaskEventBus } from './tasks/bus.ts';
import { TaskQueue } from './tasks/queue.ts';
import { createHandlers, createAvailabilityResolver } from './tasks/handlers.ts';
import { createTaskWatchdog } from './tasks/watchdog.ts';
import type { ExtractAvailability } from './tasks/handlers.ts';
import { createWorkerExtractor } from './tasks/extract.ts';
import type { CompleteJsonFn } from './tasks/extract.ts';
import type { TaskHandler } from './tasks/queue.ts';
import type { Extractor } from './tasks/extract.ts';
import { WorkerClient } from './worker/client.ts';
import { createWorkerRunner } from './worker/runner.ts';
import type { WorkerRunnerWithRaw } from './worker/runner.ts';
import { probeWorker } from './worker/probe.ts';
import { registerCapabilityRoutes, SERVER_VERSION } from './routes/capabilities.ts';
import { LLM_QUEUE } from './providers/llm/openai_compatible.ts';
import { registerCollectionRoutes } from './routes/collections.ts';
import { registerDocumentRoutes } from './routes/documents.ts';
import { registerCardRoutes } from './routes/cards.ts';
import { registerSearchRoutes } from './routes/search.ts';
import { registerTaskRoutes } from './routes/tasks.ts';
import { registerChatRoute } from './routes/chat.ts';
import { registerSandboxRoutes, DEFAULT_LIMITS, ownerOfSession, readCrossCallTx } from './routes/sandbox.ts';
import { createKbQuery } from './store/kb-query.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerRbacRoutes } from './routes/rbac.ts';
import { installAuth } from './auth/middleware.ts';
import { bootstrapAdmin } from './auth/create-admin.ts';
import { isRole, taskQuota } from './auth/types.ts';
import { NOT_FOUND_JSON } from './routes/util.ts';
import type { AgentCapabilitiesFn, AppDeps, ChatConnectionFactory, ProviderFacade } from './app-deps.ts';
import { ApiError } from './store/errors.ts';

export { SERVER_VERSION };

export interface BuildOptions {
  cfg?: ServerConfig;
  /** 覆盖抽取器（测试注入确定性 stub；生产用 worker plan/convert + provider LLM） */
  extractor?: Extractor | null;
  /** 覆盖 worker 启动方式（测试用假 worker 脚本） */
  workerLauncher?: ConstructorParameters<typeof WorkerClient>[0]['launcher'];
  /** 覆盖 worker 探测（测试里不想起 python 时用） */
  workerProbe?: () => Promise<AppDeps['workerCapability']>;
  /**
   * 覆盖聊天连接工厂。
   * - `undefined`（默认）→ 动态 import `src/agent/stream.ts`，按可用性决定
   * - `null` → **显式不注册** WS 路由（用于验证"agent 缺失时入口不可用"）
   * - 函数 → 注入（测试降级/正常路径）
   */
  chatFactory?: ChatConnectionFactory | null;
  /** 覆盖 agent 能力上报（同上，测试用） */
  agentCapabilities?: AgentCapabilitiesFn | null;
  /**
   * 覆盖日志：undefined = 按配置落盘；
ull = **完全关掉**（测试里不想写文件时用）；AppLogging = 注入。
   */
  logging?: AppLogging | null;
  /**
   * 启动后台预热 LLM 可用性探测（默认 true，仅 main() 生效）。
   * 测试里 uildApp 不会预热 —— 预热会给全局探测计数多记一次（见 vailabilityWarmUp 的注释）。
   */
  availabilityWarmUp?: boolean;
}

/** 结果容器：测试要拿到 db/repo/queue 做断言，所以不只返回 fastify 实例。 */
export interface BuiltApp {
  app: FastifyInstance;
  deps: AppDeps;
  /** ★ 日志句柄（
ull = 本次未启用落盘） */
  logging: AppLogging | null;
  /** ★ 启动后台预热 LLM 可用性探测（坑 32；只应由 main() 调用） */
  availabilityWarmUp: () => void;
  /** ★ 只读：当前可用性三态（诊断用；detecting 也必须如实可见） */
  peekAvailability: () => Promise<ExtractAvailability>;
  /**
   * ★★ v8 看门狗：判死超时任务 + 自愈孤儿 `extracting` 文档。
   * **只应由 `main()` 在 `listen()` 之后调用**（pit 34：`buildApp` 里不放启动副作用）。
   */
  taskWatchdog: () => {
    stale: { killed: string[]; alive: string[] };
    docs: { healed: string[]; keptRunning: string[] };
  };
  /** 看门狗判死阈值（ms）—— 诊断/测试断言用，与 queue 的心跳周期**同源** */
  taskStaleMs: number;
  close(): Promise<void>;
}

async function tryImport<T>(specifier: string): Promise<{ mod: T | null; error: string | null }> {
  try {
    const mod = (await import(specifier)) as T;
    return { mod, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 模块"不存在"是预期内的降级；其他错误也如实报出来
    return { mod: null, error: redact(msg.split('\n')[0] ?? msg) };
  }
}

export async function buildApp(opts: BuildOptions = {}): Promise<BuiltApp> {
  const cfg = opts.cfg ?? loadConfig();
  ensureDirs(cfg);

  // ── 日志（★ 落盘；用户明确要求）────────────────────────────────────
  // 原状：`logger: false` → 请求/异常/worker stderr **只进终端，关掉终端就没了**；
  //      落盘的只有"结果"（audit_log / tasks / chat jsonl / sandbox 审计），**过程全丢**。
  // ★ 必须在 worker/agent 之前创建：worker 的 stderr 也要落盘（onStderr 钩子）。
  const logging: AppLogging | null =
    opts.logging === null
      ? null
      : (opts.logging ??
        createAppLogging({
          dir: cfg.logging.dir,
          level: cfg.logging.level,
          maxBytes: cfg.logging.maxBytes,
          retentionDays: cfg.logging.retentionDays,
        }));

  const db = Db.open(cfg.dbPath);
  const repo = new Repo(db);
  const bus = new TaskEventBus();

  // ── worker ───────────────────────────────────────────────────────
  const workerClient = new WorkerClient({
    pythonBin: cfg.pythonBin,
    workerModule: cfg.workerModule,
    cwd: cfg.root,
    timeoutMs: cfg.workerTimeoutMs,
    ...(opts.workerLauncher ? { launcher: opts.workerLauncher } : {}),
    // ★ worker stderr 也要落盘（原来只在终端）；内部限速 + 截断，避免刷爆日志
    ...(logging ? { onStderr: (line: string) => logging.logWorkerStderr(line) } : {}),
  });
  const runner: WorkerRunnerWithRaw = createWorkerRunner(workerClient);
  const runWorkerProbe = async (force: boolean): Promise<AppDeps['workerCapability']> =>
    opts.workerProbe
      ? opts.workerProbe()
      : probeWorker({ pythonBin: cfg.pythonBin, module: cfg.workerModule, cwd: cfg.root, force });
  const workerCapability = await runWorkerProbe(false);

  // ── 封闭枚举（C3：来自 schema/*.json，不内置兜底）─────────────────
  const enums: SchemaEnums = loadSchemaEnums(cfg.root);

  // ── 系统设置（video-pipeline 交付；**必须在 providers 之前加载**）──────────
  // 为什么提前：provider 层的 `modelOverride` 要读 `settings.llm.active` —— 那是"热切换"的
  // **唯一真相源**（否则出现"界面显示新模型、实际请求还在用 providers.yaml 的旧模型"）。
  // 分工：`settings.json` 运行期可改（热重载）· `providers.yaml` 部署期 · `.env` 只放凭据。
  // ⚠️ **非法配置 → 拒绝启动 + 可读原因**：`watchSettings` 抛错时**必须**抛出去，
  //    绝不"静默用默认值"跑起来 —— 那会让运维以为自己的改动生效了。
  const settingsMod = await tryImport<{
    watchSettings?: (opts: { root: string }) => { get: () => unknown };
    sandboxLimitsOf?: (s: unknown) => Record<string, unknown>;
  }>('./settings/index.ts');
  let settingsStore: { get: () => unknown } | null = null;
  if (typeof settingsMod.mod?.watchSettings === 'function') {
    try {
      settingsStore = settingsMod.mod.watchSettings({ root: cfg.root });
      process.stderr.write('[settings] settings.json 已加载并开启热重载\n');
    } catch (err) {
      throw new Error(
        `settings.json 配置非法，拒绝启动：${redact(err instanceof Error ? err.message : String(err))}`,
      );
    }
  } else {
    process.stderr.write('[settings] 未接入（watchSettings 不可用）→ 模型选择走 providers.yaml/.env\n');
  }

  /**
   * 热切换的唯一真相源：`settings.llm.active`。
   * - 返回 `undefined`（设置层未接入 / 字段缺失）→ provider 层**沿用 providers.yaml**（不改变既有行为）
   * - 取值抛错 → 也返回 `undefined`（provider 层承诺不因此中断组装）
   */
  const activeModelOverride = (): string | undefined => {
    try {
      const s = settingsStore?.get() as { llm?: { active?: unknown } } | undefined;
      const active = s?.llm?.active;
      return typeof active === 'string' && active.trim() !== '' ? active.trim() : undefined;
    } catch {
      return undefined;
    }
  };

  // ── providers（T-PROVIDERS 的写域，动态 import）────────────────────
  let providers: ProviderFacade | null = null;
  let providersError: string | null = null;
  const providerMod = await tryImport<{
    createProviderLayer: (o: {
      config: unknown;
      runWorker: unknown;
      onSkip?: (entry: unknown, reason: string) => void;
      /** ★ 热切换接点（Lead 铺好）：非空 → 覆盖 LLM provider 的 model；空/抛错 → 沿用配置 */
      modelOverride?: () => string | undefined;
    }) => ProviderFacade;
  }>('./providers/index.ts');
  if (providerMod.mod?.createProviderLayer) {
    try {
      providers = providerMod.mod.createProviderLayer({
        config: cfg.providers,
        runWorker: runner,
        // ★ 热切换接点：**唯一真相源** = `settings.llm.active`（Lead 已在 providers 侧实现覆盖）
        modelOverride: activeModelOverride,
        onSkip: (entry, reason) => {
          const id = (entry as { id?: string } | undefined)?.id ?? '?';
          process.stderr.write(`[providers] 跳过 ${id}：${redact(reason)}\n`);
        },
      });
    } catch (err) {
      providersError = `provider 层组装失败：${redact(err instanceof Error ? err.message : String(err))}`;
    }
  } else {
    providersError = providerMod.error ?? 'providers/index.ts 未导出 createProviderLayer';
  }

  // ── 抽取器（可注入；生产用 **A1**：worker 出提示词/schema，Node 只调模型）──
  let extractor: Extractor | null = opts.extractor ?? null;
  if (opts.extractor === undefined && providers) {
    extractor = createWorkerExtractor({
      runner,
      completeJson: (req) => providers!.completeJson(req),
      sourceName: '课程资料',
      // 契约 §5.1 已验证常量
      maxPages: 8,
      // 真探测（R2）：provider 的 capabilities(deep:true) 会真发一次最小请求
      probe: async () => {
        try {
          const caps = (await providers!.capabilities({ deep: true })) as {
            providers?: Record<string, { available?: boolean; reason?: string }[]>;
          };
          const llm = caps.providers?.llm ?? [];
          const usable = llm.find((p) => p.available === true);
          if (usable) return { ok: true };
          const first = llm[0];
          return {
            ok: false,
            reason: first?.reason ?? (cfg.llm?.configured ? 'LLM 真探测未通过' : '未配置 LLM 凭据'),
          };
        } catch (err) {
          return { ok: false, reason: `LLM 探测失败：${redact(err instanceof Error ? err.message : String(err))}` };
        }
      },
    });
  }
  if (extractor === null && !providers) {
    providersError = providersError ?? 'provider 层不可用 → 抽取功能禁用（units 仍可解析）';
  }

  // ★★ 抽取器可用性：**三态 + 启动后台预热**（坑 32）
  //
  // 原错误写法（本文件历史版本）：`resolveExtractorAvailability()` **惰性 await** 真探测 ——
  //   `extractor.available()` → `providers.capabilities({deep:true})` = **一次真 LLM 请求**，
  //   **实测 67,986ms**：任务 719ms 就 `running`，但第一次 `completeJson` 在 68 秒后
  //   → 用户看到"运行中"却没有任何解释，**以为卡死**（这正是"看不到的失败"的体验版）。
  //
  // 现在：① 启动即 `warmUp()`（后台，不阻塞任何请求）② `current()` **立即返回**，绝不 await 进行中的探测
  //   ③ 探测中如实返回 `detecting:true`（既不放行假装可用、也不错误拒绝）④ 结果只探一次并缓存
  //   ⑤ 探测失败 → **如实降级**（`ok:false + reason`），绝不因为"预热过了"就报可用。
  // ⚠️ 保持 `async` 签名（消费者 `await` 它）—— 但**它现在立即 resolve**（不 await 探测），
  //    所以"首个抽取不再等 68 秒"。
  const resolveExtractorAvailability = async (): Promise<ExtractAvailability> => {
    if (!extractor) {
      return { ok: false, reason: providersError ?? '未初始化抽取器' };
    }
    return availabilityResolver.current();
  };
  const availabilityResolver = createAvailabilityResolver({
    // 硬性不可用（配置层就断了）：不浪费真探测
    hardUnavailable: () => {
      if (!extractor) return { ok: false, reason: providersError ?? '未初始化抽取器' };
      if (!enums.edgeTypes.length || !enums.cardKinds.length) {
        return {
          ok: false,
          reason: `封闭枚举未加载（${enums.warnings.join('；') || 'schema/ 缺失'}）→ 抽取会产出非法枚举，故禁用`,
        };
      }
      if (!cfg.llm) return { ok: false, reason: '未配置 LLM 凭据（data/llm.json 或环境变量）' };
      return null;
    },
    probe: async () => {
      if (!extractor) return { ok: false, reason: providersError ?? '未初始化抽取器' };
      const a = await extractor.available();
      return { ok: a.ok, reason: a.reason || '' };
    },
    onResolved: (result) => {
      // ★ 结果落盘（运维/用户都能查"到底检测出什么"）；不阻塞、不抛
      try {
        const line = { event: 'llm-availability', state: result.ok ? 'ready' : 'unavailable', reason: result.reason };
        if (result.ok) logging?.info(line, 'LLM availability resolved');
        else logging?.warn(line, 'LLM availability resolved');
      } catch {
        /* 日志失败不影响业务 */
      }
    },
  });

  // ★ 启动就探（后台）—— 这样第一个抽取任务通常已经拿到结果，最差也只是如实显示"检测中"
  // ★★ 预热**不在这里做**（挪到 `main()`，见 `availabilityWarmUp`）——
  //   ⚠️ 全量测试实测：在 `buildApp` 里预热会给**进程内全局探测计数**多记一次，
  //   导致"路由自述 `probe_calls`"与"真实探测次数"对不上（**自述 7 vs 真实 6**，坑 21 同源断言红）。
  //   ⟹ 预热本身是对的，**位置**错了：必须等"服务真的起来了"再探。
  //   这样 `buildApp`（测试/嵌入式用法）行为完全不变，而生产 `main()` 启动即预热。
  const availabilityWarmUp = (): void => {
    if (opts.availabilityWarmUp === false) return;
    availabilityResolver.warmUp();
    logging?.info({ event: 'llm-availability', state: 'detecting' }, 'LLM availability probe started (background)');
  };

  // ── agent（T-AGENT 的写域，动态 import；测试可用 BuildOptions 覆盖）──
  let agentCapabilities: AgentCapabilitiesFn | null = null;
  let chatFactory: ChatConnectionFactory | null = null;
  let agentError: string | null = null;

  if (opts.agentCapabilities !== undefined) {
    agentCapabilities = opts.agentCapabilities;
    if (opts.agentCapabilities === null) agentError = agentError ?? 'agent 能力上报被显式禁用（测试注入）';
  } else {
    const capsMod = await tryImport<{ capabilities?: AgentCapabilitiesFn }>('./agent/capabilities.ts');
    if (capsMod.mod?.capabilities) agentCapabilities = capsMod.mod.capabilities;
    else agentError = capsMod.error ?? 'agent/capabilities.ts 未导出 capabilities()';
  }

  /**
   * ★ **只读知识库查询**（agent 模式的 `kb_search`/`kb_get` 用它）。
   *
   * 为什么在这里构造而不是让 agent 层自己查库：
   * 可见性过滤必须复用 RBAC 的 `docScopeSql()` —— **agent 工具不能成为绕过 RBAC 的后门**
   * （否则学生用 `kb_get('crd_xxx')` 就能读别人/未发布的草稿）。
   * 模块里只有 SELECT，没有写/删/执行 SQL 的入口（工具的能力边界 = 该模块的导出）。
   *
   * ⚠️ **必须早于 agent 会话管理器构造**：`kb` 要注入 `AgentSessionManager`
   * （`kb_search`/`kb_get` 的注册在那一层）。我第一版只把它放在**每次连接**的选项里 →
   * 实测 `ready.tools=[]` + `tools_source=kb-readonly`：**代码以为开了 kb 工具，实际没注册**
   * （模型回"当前会话没有这两个工具"）—— 正是"看起来成功"那类坑。
   */
  const kb: AppDeps['kb'] = createKbQuery({ db, repo });
  process.stderr.write('[kb] 只读知识库查询已接入（kb_search/kb_get；按 userId 过滤可见性）\n');

  /**
   * 物化后的 pi 会话管理器（`agentDir` = `data/pi-agent/`）。
   *
   * ⚠️ **chat 与 /sandbox/ask 各自一个**（不是共用）—— 因为 `systemPrompt` 是**管理器级**的
   * （`getOrCreate` 不接受按会话的 systemPrompt），而两个入口需要**不同**的提示词。
   * 共用会让后装配的覆盖前一个（坑 24 的"看起来配了其实没生效"）。
   * 但它们**共用同一份 `agentDir`/`model`** —— 否则答疑会走 pi 全局默认模型 + 失效 key → 403。
   */
  let agentManager: unknown = null;
  /** 会话层模块（chat 与 ask 都要用 → **必须在分支外**声明，否则块作用域取不到） */
  const sessionMod = await tryImport<{
    AgentSessionManager?: new (opts: Record<string, unknown>) => unknown;
  }>('./agent/session.ts');
  /** 提示词模块（渲染契约；见下方"模块存在却无调用方"的注释） */
  const promptsMod = await tryImport<{
    CHAT_ASSISTANT_SYSTEM_PROMPT?: string;
    VIDEO_ASSISTANT_SYSTEM_PROMPT?: string;
    withRenderContract?: (base: string) => string;
  }>('./agent/prompts.ts');

  if (opts.chatFactory !== undefined) {
    chatFactory = opts.chatFactory;
    if (opts.chatFactory === null) agentError = agentError ?? '聊天通道被显式禁用（测试注入）';
  } else {
    const streamMod = await tryImport<{ createChatConnection?: ChatConnectionFactory }>('./agent/stream.ts');
    if (streamMod.mod?.createChatConnection) {
      const createConn = streamMod.mod.createChatConnection;
      /**
       * ★ 模型绑定（critical：不接这一步 = 学生发问后 **180s 零帧**）
       *
       * pi 的 `createAgentSession` 不传模型时会用它**自己的全局默认**
       * （`~/.pi/agent/settings.json`，实测 `opencode-go/glm-5.2`，key 已 401），
       * 而项目配置是 `amr/deepseek-v4.1-flash` → 模型根本没被喂给 pi。
       * 我这边负责**物化一个 pi 格式的 `models.json`**（写在 `data/pi-agent/`，.gitignore 覆盖、不回显 key），
       * 再把它交给 pi-bridge 的 `AgentSessionManager({ modelsPath, model })`。
       */
      const sessionMod = await tryImport<{
        AgentSessionManager?: new (opts: Record<string, unknown>) => unknown;
      }>('./agent/session.ts');
      /**
       * ★ **渲染契约系统提示词**（坑 24 的又一实例：模块存在、却**没有任何调用方**）。
       *
       * `agent/prompts.ts` 早就导出了 `CHAT_ASSISTANT_SYSTEM_PROMPT`（内含 `RENDER_CONTRACT`：
       * 公式用 `$...$` 而非 `\(...\)`、代码块带语言、导图/引用格式…），
       * 但 **chat 会话从没传过 `systemPrompt`** → 模型跑的是 pi 默认的 coding 提示词 →
       * 前端做的 KaTeX/高亮/导图渲染**没有内容可渲**（渲染层白做）。
       *
       * 判据：**"提示词存在"和"提示词生效"是两件事** —— 断言必须打在"真的进了发给 SDK 的请求"上。
       */
      const chatSystemPrompt = promptsMod.mod?.CHAT_ASSISTANT_SYSTEM_PROMPT;
      const videoSystemPrompt = promptsMod.mod?.VIDEO_ASSISTANT_SYSTEM_PROMPT;
      const piModels = materializePiModels(cfg);
      if (piModels && typeof sessionMod.mod?.AgentSessionManager === 'function') {
        try {
          /**
           * ★ **两个入口两套提示词**（`systemPrompt` 是**管理器级**的 —— `getOrCreate` 不接受按会话的
           * systemPrompt，见 `session.ts:1163`）→ 所以建**两个管理器**，由路由按 `?assistant=` 选：
           * - `chat`（默认）：`CHAT_ASSISTANT_SYSTEM_PROMPT`（通用助教）
           * - `video`：`VIDEO_ASSISTANT_SYSTEM_PROMPT`（按视频文稿回答；含「▶ 时间」跳转语义）
           * 两者都**内含渲染契约**（`prompts.ts` 已把 `RENDER_CONTRACT` 嵌进去）。
           */
          const baseOpts = {
            // ★ 必须给 `agentDir`（而不是只给 `modelsPath`）：pi 的**凭据**读的是 `<agentDir>/auth.json`，
            //   与 `models.json`（模型目录）是两件事。只给 modelsPath 会得到
            //   "No API key found for <provider>"；而 auth.json 形状不对时更糟 —— **静默挂死**（180s 零帧）。
            agentDir: piModels.agentDir,
            model: piModels.modelRef,
            // ★ 只读知识库工具（`kb_search`/`kb_get`）—— **必须在建管理器时注入**，
            //   否则 `ready.tools` 会是 `[]`（代码以为开了、实际没注册）
            kb,
          };
          const manager = new sessionMod.mod.AgentSessionManager({
            ...baseOpts,
            // ★ 渲染契约（`agent/prompts.ts`；未接入时**如实降级**为"没有系统提示词"，不假装有）
            ...(typeof chatSystemPrompt === 'string' && chatSystemPrompt !== '' ? { systemPrompt: chatSystemPrompt } : {}),
          });
          const videoManager =
            typeof videoSystemPrompt === 'string' && videoSystemPrompt !== ''
              ? new sessionMod.mod.AgentSessionManager({ ...baseOpts, systemPrompt: videoSystemPrompt })
              : manager; // 视频提示词缺失 → **沿用 chat**（如实降级，不假装有专用提示词）
          agentManager = manager;
          // ★ 按连接选管理器：`?assistant=video` → 视频提示词；其它 → chat
          chatFactory = (connOpts) =>
            createConn({
              ...connOpts,
              manager: (connOpts as { assistant?: unknown }).assistant === 'video' ? videoManager : manager,
            } as never);
          process.stderr.write(
            `[agent] 模型与凭据已绑定项目配置：${piModels.modelRef}` +
              `（agentDir → ${path.relative(cfg.root, piModels.agentDir)}，apiKey 只写 data/，不回显）` +
              `｜系统提示词：chat=${typeof chatSystemPrompt === 'string' ? '✓' : '✗'} video=${videoManager !== manager ? '✓' : '复用 chat'}\n`,
          );
        } catch (err) {
          chatFactory = createConn;
          process.stderr.write(
            `[agent] 模型绑定失败（${redact(err instanceof Error ? err.message : String(err))}）→ ` +
              'pi 会回落它自己的全局默认模型（ready 帧会带 model_warning）\n',
          );
        }
      } else {
        chatFactory = createConn;
        process.stderr.write(
          piModels
            ? '[agent] 未能构造会话管理器（AgentSessionManager 不可用）→ pi 回落全局默认\n'
            : '[agent] 无可用 LLM 凭据 → 无法物化 models.json → pi 回落全局默认（chat 可能 401/无响应）\n',
        );
      }
    } else if (!agentError) {
      agentError = streamMod.error ?? 'agent/stream.ts 未导出 createChatConnection';
    }
  }

  // ── 队列 + 处理器 ─────────────────────────────────────────────────
  /** LLM 调用的窄接口（凭据不下发子进程；A1 下 TS 只负责调模型） */
  const completeJson: CompleteJsonFn | null = providers
    ? (req) => providers!.completeJson(req)
    : null;

  const handlers = createHandlers({
    repo,
    db,
    cfg,
    runner,
    extractor,
    completeJson,
    enums,
    resolveExtractorAvailability,
    /**
     * ★ **把"解析后是否自动抽取"接上开关**（原先 `autoExtractOnParse` **声明了却没人传** ——
     * 与 `timeoutMs`/`maxTokens` 同族的**死旋钮**，坑 24：`autoExtract` 恒为 true）。
     *
     * `COURSE_KB_AUTO_EXTRACT=0` → 只解析不抽取（**零 LLM 花费**）；
     * 缺省（或任何其它值）→ 自动抽取（用户诉求"上传了要能看到东西"）。
     * 用途：① 运维/测试要"只解析"时不必改代码；② 让测试能**零额度**跑通 reparse/parse 链路。
     */
    autoExtractOnParse: cfg.env.COURSE_KB_AUTO_EXTRACT !== '0',
  });

  // ── 额外任务处理器（其他 teammate 的工厂，**动态接入**）──────────────
  // 为什么用动态 import：这些文件由别的 teammate 交付，缺失时**不能**让服务起不来，
  // 要如实降级为"队列里没有该处理器"（用户能看到明确错误，而不是崩服务）。
  const rollupMod = await tryImport<{ createRollupHandler?: (d: unknown) => TaskHandler }>('./tasks/rollup.ts');
  const translateMod = await tryImport<{ createTranslateHandler?: (d: unknown) => TaskHandler }>('./tasks/translate.ts');
  const extraDeps = {
    repo,
    db,
    cfg,
    runner,
    completeJson,
    availability: resolveExtractorAvailability,
  };
  const extraHandlers: Record<string, TaskHandler> = {};
  for (const [name, mod, factoryName] of [
    ['rollup', rollupMod.mod, 'createRollupHandler'],
    ['translate', translateMod.mod, 'createTranslateHandler'],
  ] as const) {
    const factory = (mod as Record<string, unknown> | null)?.[factoryName] as
      | ((d: unknown) => TaskHandler)
      | undefined;
    if (typeof factory !== 'function') {
      process.stderr.write(`[tasks] ${name} 处理器未接入（${factoryName} 不可用）→ 队列会如实报"没有处理器"\n`);
      continue;
    }
    try {
      extraHandlers[name] = factory(extraDeps);
    } catch (err) {
      process.stderr.write(
        `[tasks] ${name} 处理器组装失败：${redact(err instanceof Error ? err.message : String(err))}\n`,
      );
    }
  }
  Object.assign(handlers, extraHandlers);

  // ── 检索层（`src/retrieval/**`，kg-rag-architect 交付）─────────────────
  // 动态接入：未交付/导入失败 → deps.retrieval=null → chat 按 `retrieval:'none'` 走、不报错
  // （与 providers/agent 同一策略："缺谁都能起"）。
  const retrievalMod = await tryImport<{
    createRetrievalFacade?: (opts: { db: Db; repo: Repo; edgeTypes?: string[] }) => NonNullable<AppDeps['retrieval']>;
  }>('./retrieval/index.ts');
  /**
   * ★ **只读知识库查询**（agent 模式的 `kb_search`/`kb_get` 用它；**构造在上面**，因为要注入会话管理器）。
   * 这里只做接线说明，不再重复构造（避免两处真相）。
   */

  let retrieval: AppDeps['retrieval'] = null;
  if (typeof retrievalMod.mod?.createRetrievalFacade === 'function') {
    try {
      retrieval = retrievalMod.mod.createRetrievalFacade({
        db,
        repo,
        // 边类型来自 contracts/schema（封闭枚举）→ kg 的"传递闭包只走 DEPENDS_ON/PART_OF"据此判定
        ...(enums.edgeTypes?.length ? { edgeTypes: enums.edgeTypes } : {}),
      });
      process.stderr.write('[retrieval] 检索层已接入（wiki/kg/rag 三模式各自独立探测）\n');
    } catch (err) {
      process.stderr.write(
        `[retrieval] 组装失败 → 按未接入处理（chat 走 none）：${redact(err instanceof Error ? err.message : String(err))}\n`,
      );
      retrieval = null;
    }
  } else {
    process.stderr.write('[retrieval] 未接入（createRetrievalFacade 不可用）→ chat 按 none 走\n');
  }

  // ── 学生 SQL 沙箱：AI 答疑处理器（pi-bridge 的 `createAskHandler`）─────────
  // 动态接入 → 未就绪时 `/sandbox/ask` 如实 503（不假装能答疑）。
  const askMod = await tryImport<{
    createAskHandler?: (deps: Record<string, unknown>) => AppDeps['sandboxAsk'];
    ASK_SYSTEM_PROMPT?: string;
  }>('./sandbox/ask.ts');
  /**
   * ★ **答疑专用管理器**（与 chat 管理器分开）—— 因为 `systemPrompt` 是**管理器级**的
   * （`AgentSessionManager` 的 `getOrCreate` 不接受按会话的 systemPrompt，见 session.ts:1163）。
   *
   * 两个入口需要**不同**的系统提示词：
   * - chat / 视频助手：`CHAT_ASSISTANT_SYSTEM_PROMPT`（含渲染契约）
   * - 沙箱答疑：`withRenderContract(ASK_SYSTEM_PROMPT)`（SQL 纠错语境）+ `tools: []` + 不读项目 AGENTS.md
   *
   * ⚠️ 共用同一个管理器会让**后装配的那个**覆盖另一个 —— 这正是坑 24 的"看起来配了其实没生效"。
   */
  let askManager: unknown = null;
  if (typeof askMod.mod?.ASK_SYSTEM_PROMPT === 'string' && typeof sessionMod.mod?.AgentSessionManager === 'function') {
    const piModelsForAsk = materializePiModels(cfg);
    if (piModelsForAsk) {
      try {
        const withContract = promptsMod.mod?.withRenderContract;
        const base = askMod.mod.ASK_SYSTEM_PROMPT;
        const askPrompt = typeof withContract === 'function' ? withContract(base) : base;
        const m = new sessionMod.mod.AgentSessionManager({
          agentDir: piModelsForAsk.agentDir,
          model: piModelsForAsk.modelRef,
          systemPrompt: askPrompt,
          tools: [], // 教学答疑不需要任何文件/命令工具（安全 + 快）—— 与 ask.ts 自建时一致
          noContextFiles: true, // 不把项目 AGENTS.md 塞进系统提示词
          sessionDir: path.join(cfg.root, 'data', 'chat', 'ask'),
          onDiagnostic: () => {
            /* 由 ask.ts 的 handler 层转发；这里静默避免噪音（与 ask.ts 自建时一致） */
          },
        });
        (m as { startReaper?: () => void }).startReaper?.();
        askManager = m;
        process.stderr.write('[agent] 答疑管理器已装配（ASK 系统提示词 + 渲染契约 + tools:[]）\n');
      } catch (err) {
        process.stderr.write(
          `[agent] 答疑管理器装配失败（${redact(err instanceof Error ? err.message : String(err))}）→ 由 ask.ts 自建\n`,
        );
      }
    }
  }
  let sandboxAsk: AppDeps['sandboxAsk'] = null;
  if (typeof askMod.mod?.createAskHandler === 'function') {
    try {
      /** 会话 id → 所有者（可逆编码，见 `routes/sandbox.ts::ownerOfSession`）。 */
      const ownerOf = (sid: string): string | null => ownerOfSession(sid);
      /** 沙箱库根目录（必须与 `routes/sandbox.ts` 一致，否则答疑读到的是另一个库！）。 */
      const sandboxRoot = path.join(cfg.dataDir, 'sandbox');
      const workerCall = async (job: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const r = await runner.raw({ job, input: { ...input, root: sandboxRoot }, timeoutMs: 30_000 });
        return r.ok && r.result ? r.result : {};
      };
      sandboxAsk = askMod.mod.createAskHandler({
        /**
         * ★ 答疑必须用**同一个**物化会话管理器（`data/pi-agent/`）。
         *
         * 不传的后果（web-ui 实测到的 `E_LLM 403`）：`ask.ts` 会用它模块内的默认管理器 →
         * pi 的**全局默认模型**（`~/.pi/agent`，key 已失效）→ 上游 401/403，
         * 而 `/capabilities` 里 `providers.llm=amr(available=True)` 仍然正常（那是 providers 层，另一条路径）。
         */
        // ⚠️ 必须传**答疑专用**管理器（见下方 `askManager`）：`ask.ts` 的 `deps.manager` **优先于**它自建的
        //    （`ask.ts:1196`），我早前把 chat 管理器传进来 → **覆盖了答疑自己的系统提示词与 tools:[]**
        //    （ask 的渲染契约因此失效）。这里改传 askManager，两边的提示词各归其位。
        manager: askManager ?? undefined,
        // schema 与最近执行都走 **worker job**（与 /sandbox/schema、/sandbox/history 同源 → 不会有两套真相）
        getSchema: async (sessionId: string) => {
          const owner = ownerOf(sessionId);
          if (!owner) return null;
          const out = await workerCall('sandbox.schema', { user_id: owner, session_id: sessionId });
          return Object.keys(out).length > 0 ? (out as never) : null;
        },
        getRecentExecutions: async (sessionId: string, limit: number) => {
          const owner = ownerOf(sessionId);
          if (!owner) return [] as never;
          const out = await workerCall('sandbox.history', {
            user_id: owner,
            session_id: sessionId,
            limit,
            request_user_id: owner,
          });
          return ((out.entries as unknown[]) ?? []) as never;
        },
        resolveUserId: (sessionId: string) => ownerOf(sessionId),
        // 知识库检索：复用 `store/search.ts`（bigram/坑 15、16 已处理），映射成 ask 要的形状
        search: async (q: string, opts?: { limit?: number }) => {
          const res = searchKb(db, repo, q, { limit: opts?.limit ?? 5 });
          return res.hits.map((h: SearchHit) => ({
            kind: h.kind,
            ref_id: h.ref_id,
            title: h.title,
            snippet: (h as { snippet?: string }).snippet ?? '',
            ...(typeof h.score === 'number' ? { score: h.score } : {}),
            ...(h.doc_id ? { doc_id: h.doc_id } : {}),
          })) as never;
        },
        onDiagnostic: (m: string) => process.stderr.write(`[sandbox.ask] ${redact(m)}\n`),
        audit: (event: Record<string, unknown>) => {
          try {
            repo.rbac.audit({
              userId: (event.userId as string | null) ?? null,
              action: 'log_read',
              target: String(event.sessionId ?? ''),
              detail: event,
            });
          } catch {
            /* 审计失败不影响答疑 */
          }
        },
      });
      process.stderr.write('[sandbox] AI 答疑已接入\n');
    } catch (err) {
      process.stderr.write(
        `[sandbox] 答疑组装失败 → /sandbox/ask 会如实 503：${redact(err instanceof Error ? err.message : String(err))}\n`,
      );
      sandboxAsk = null;
    }
  } else {
    process.stderr.write('[sandbox] 答疑未接入（createAskHandler 不可用）→ /sandbox/ask 如实 503\n');
  }

  // ── 系统设置：路由注册用的模块引用（**加载已在 providers 之前完成**，见上方注释）──
  const settingsRoutesMod = await tryImport<{
    createSettingsRoutes?: (deps: Record<string, unknown>) => (app: FastifyInstance) => Promise<void> | void;
    settingsCapabilities?: (store: unknown, switcher?: unknown) => Record<string, unknown>;
  }>('./routes/settings.ts');

  /** `/capabilities` 的 settings 段数据（video-pipeline 提供；未接入时返回 null）。 */
  const settingsCapabilitiesFn =
    settingsStore && typeof settingsRoutesMod.mod?.settingsCapabilities === 'function'
      ? (): Promise<Record<string, unknown>> =>
          Promise.resolve(
            settingsRoutesMod.mod!.settingsCapabilities!(settingsStore, null) as Record<string, unknown>,
          )
      : null;

  // ── RBAC：首个管理员引导（**仅当库里零用户**；不硬编码口令）──────────
  // 注：`/capabilities` 的 `auth.bootstrap` 按契约只报 **initialized | not_initialized**
  //     （"刚创建"只是启动瞬间的内部状态，不进对外契约）。
  let bootstrapState: 'initialized' | 'not_initialized' = repo.rbac.countUsers() > 0
    ? 'initialized'
    : 'not_initialized';
  /**
   * ★ **"设了变量但解析不了"必须拒绝启动**（不许静默退化成"没设"）。
   *
   * ## 为什么（真机排查过一次）
   * `web-ui` 在全新库上设了 `COURSE_KB_BOOTSTRAP_ADMIN=admin:Admin2026lab` 却看到
   * `[auth] 尚无任何用户` → 一度以为是"启动路径不读这个变量"。
   * 我实测复现：**变量真的到达进程时，启动路径会正常创建管理员并打印创建日志**
   * （`/capabilities.auth.bootstrap = initialized` + 用该口令登录 200）→ 契约成立。
   * 那次失败是**环境问题**（变量没进进程 / 看的是旧进程日志 —— 坑 26）。
   *
   * 但这次排查暴露了一个**真实的静默面**：变量存在却**格式不对**（如漏了冒号）时，
   * `parseBootstrapAdmin` 返回 null → 与"根本没设"走同一条日志 → **运维会以为变量没生效**。
   * ⟹ 现在：**设了但解析不了 → 直接抛错拒绝启动**（同"弱口令拒绝启动"的原则）。
   */
  const bootstrapRaw = cfg.env.COURSE_KB_BOOTSTRAP_ADMIN;
  const bootstrapVarPresent = typeof bootstrapRaw === 'string' && bootstrapRaw.trim() !== '';
  if (bootstrapVarPresent && !cfg.auth.bootstrapAdmin) {
    throw new Error(
      'RBAC 引导失败：COURSE_KB_BOOTSTRAP_ADMIN 已设置但格式不合法（应为「用户名:口令」，且用户名非空）—— ' +
        '拒绝带着"以为设了却没生效"的状态启动',
    );
  }
  // ★ 让"变量到底有没有进进程"在日志里**一眼可见**（口令永不回显）
  if (bootstrapVarPresent) {
    process.stderr.write(
      `[auth] COURSE_KB_BOOTSTRAP_ADMIN 已设置（用户名 ${cfg.auth.bootstrapAdmin!.username}；仅当库里零用户时生效）\n`,
    );
  } else {
    process.stderr.write('[auth] 未设置 COURSE_KB_BOOTSTRAP_ADMIN（全新库需 `npm run create-admin` 或设置该变量）\n');
  }
  try {
    const boot = await bootstrapAdmin(repo, cfg.auth);
    if (boot?.created) {
      bootstrapState = 'initialized';
      process.stderr.write(`[auth] 已按 COURSE_KB_BOOTSTRAP_ADMIN 创建首个管理员：${boot.username}\n`);
    } else if (boot?.skippedReason) {
      process.stderr.write(`[auth] bootstrap 跳过：${boot.skippedReason}\n`);
    } else if (bootstrapState === 'not_initialized') {
      process.stderr.write(
        '[auth] 尚无任何用户：请用 COURSE_KB_BOOTSTRAP_ADMIN=用户名:口令 或 `npm run create-admin` 创建管理员（否则所有受保护接口都会 401）\n',
      );
    }
  } catch (err) {
    // 弱口令等配置错误 → **拒绝启动**（不要带着假安全跑起来）
    throw new Error(`RBAC 引导失败：${redact(err instanceof Error ? err.message : String(err))}`);
  }

  /**
   * ★★ v8 看门狗判死阈值（ms）。**一处算出、两处注入**（queue 的心跳周期 + watchdog 的判死线）
   * —— 两处不一致会造出"一边续命一边判死"的自相矛盾（最难查的那类）。
   *
   * 默认 30 分钟：**必须大于单步最长耗时**（OCR 434 页 ~40 分钟的步骤靠运行期心跳续命，
   * 不是靠"阈值大"）。`COURSE_KB_TASK_STALE_MS` 可覆盖（配置读法不进 config.ts：那条写域不在我手上）。
   */
  const taskStaleMs = Math.max(
    1_000,
    Number(cfg.env.COURSE_KB_TASK_STALE_MS ?? '') > 0 ? Number(cfg.env.COURSE_KB_TASK_STALE_MS) : 30 * 60 * 1000,
  );

  const queue = new TaskQueue({
    repo,
    bus,
    handlers,
    concurrency: cfg.taskConcurrency,
    // ★ 心跳周期 = min(30s, staleMs/3)，与看门狗同源
    staleMs: taskStaleMs,
    // RBAC §5：配额按角色（学生 1 / 教师 2 / 管理员不限）
    resolveQuota: (userId) => {
      const roles = repo.rbac.rolesOf(userId);
      const user = { id: userId, username: '', displayName: '', roles: roles.filter(isRole) as never[], teacherCourseIds: [], studentCourseIds: [], status: 'active' as const };
      return taskQuota(user);
    },
  });

  /**
   * ★★ 看门狗（v8）：判死超时 running 任务 + 自愈孤儿 `extracting` 文档。
   *
   * 为什么**不在 `buildApp` 里跑**（pit 34 的教训）：`buildApp` 是测试/嵌入式入口，
   * 在里面做"启动副作用"会改变所有嵌入用法的可观测状态（我刚在预热上踩过一次）。
   * ⟹ 暴露到 `BuiltApp.taskWatchdog`，由 `main()` 在 **listen() 之后** 调一次。
   */
  const watchdog = createTaskWatchdog({ repo, staleMs: taskStaleMs, logger: logging });

  /**
   * ★★ **LLM 并发接线**（用户要求"并发固定可改"；零件由 `backend-api` 提供：
   * `LlmSemaphore` + `resolveLlmConcurrency`，此处只**接线**，不改它的实现）。
   *
   * ```
   * ① 默认 = 1（用户最初的硬要求："并发跑推理不太合适"）—— 不配就与改动前**行为一致**
   * ② 配 3 → 真的同时跑 3 个（`setLimit` 作用于进程内唯一队列 `LLM_QUEUE`）
   * ③ ★ 非法值（0 / 负数 / 非数字 / 超上限）→ **拒绝启动**并给出可读 reason
   *    —— **绝不静默截断**：运维设了 99 却按 4 跑，他会以为"调大有效但不够快"（"看起来成功"最危险）
   * ④ 生效方式 = **重启**（进程内单例；改配置不热生效）—— `/capabilities` 读的是**真值**
   * ```
   */
  const llmConc = resolveLlmConcurrency(cfg.env);
  if (llmConc.rejected) {
    // ★ 启动期拒绝：此时 Fastify 还没建，直接抛（`main()` 会打印并退出）
    throw new Error(
      `LLM 并发配置非法，拒绝启动：${llmConc.rejected}`,
    );
  }
  // ← 注入：删掉接线（回到默认 1）
  process.stderr.write(
    `[llm] 并发 = ${LLM_QUEUE.concurrency}（默认 1；上限 ${llmConc.max}；` +
      `${llmConc.requested === null ? '未显式配置' : `显式配置 ${llmConc.requested}`}；改配置需重启）\n`,
  );

  const deps: AppDeps = {
    cfg,
    db,
    repo,
    bus,
    queue,
    workerClient,
    runner,
    workerCapability,
    workerProbe: runWorkerProbe,
    enums,
    providers,
    providersError,
    extractAvailability: resolveExtractorAvailability,
    agentCapabilities,
    agentError,
    chatFactory,
    /**
     * ★ **同源历史访问口**（会话命名用，契约 `docs/SESSION_NAMING.md` §3.2②）。
     *
     * 命名要"首条用户提问 + 首条助手回答"，而聊天消息**不落库** —— 真相源是 pi 会话条目。
     * Lead 硬要求**只许一条读法**：这里直接复用会话管理器的 `history()`
     * （它内部就是 `agent/history.ts::entriesToHistory`，与 UI 的 `history` 帧**同一份实现**），
     * **不另写**一套从磁盘读转录的代码（否则会出现"UI 显示的和命名用的不一样"）。
     *
     * ⚠️ 管理器未接入（pi 不可用）→ 返回 `null` → 命名接口**如实报错**，**绝不编名字**（坑 10）。
     */
    sessionHistory: (sessionId: string) => {
      const m = agentManager as { get?: (id: string) => { history?: () => unknown } | undefined } | null;
      const sess = typeof m?.get === 'function' ? m.get(sessionId) : undefined;
      const h = typeof sess?.history === 'function' ? sess.history() : null;
      return (h as ReturnType<NonNullable<AppDeps['sessionHistory']>>) ?? null;
    },
    retrieval,
    // ★ 只读知识库查询（agent 模式的 kb_search/kb_get；已按 userId 过滤可见性）
    kb,
    sandboxAsk,
    // 沙箱限制：**实时**取自 settings.json（热重载改了立刻生效）；未接入 → DEFAULT_LIMITS 兜底
    sandboxLimits: () => {
      const s = settingsStore?.get();
      const fn = settingsMod.mod?.sandboxLimitsOf;
      if (s !== undefined && typeof fn === 'function') {
        try {
          return fn(s) as never;
        } catch (err) {
          process.stderr.write(`[settings] sandboxLimitsOf 取值失败 → 用内置兜底：${redact(String(err))}\n`);
        }
      }
      return DEFAULT_LIMITS;
    },
    settingsCapabilities: settingsCapabilitiesFn,
    sandboxCapabilities: async () => {
      const r = await runner.raw({ job: 'sandbox.engines', input: {}, timeoutMs: 30_000 });
      if (!r.ok || !r.result) {
        return {
          available: false,
          reason: `沙箱引擎探测失败：${r.error?.msg ?? r.error?.code ?? '未知原因'}`,
          defaultEngine: null,
          engines: [],
        };
      }
      const out = r.result as { defaultEngine?: string; engines?: unknown[] };
      const engines = Array.isArray(out.engines) ? out.engines : [];
      const sqlite = engines.find((e) => (e as { id?: string }).id === 'sqlite') as
        | { available?: boolean; reason?: string }
        | undefined;
      return {
        available: sqlite?.available !== false,
        ...(sqlite?.available === false ? { reason: sqlite.reason ?? 'sqlite 引擎不可用' } : {}),
        defaultEngine: out.defaultEngine ?? 'sqlite',
        engineCount: engines.length,
        engines,
        limits: DEFAULT_LIMITS,
        // ★ 跨调用事务能力：**从 worker 的能力报告派生**（不写死），避免"两处真相"漂移。
        //   worker 的 `capabilities.transactions` 是结构化对象 `{same_call, cross_call, batch_param, note}`
        //   （backend-core 已锁字段名并加断言防退回裸 bool）→ 这里如实透传：
        //   `cross_call:false` 时给出可读说明（这是"硬超时能强杀 + 学生间天然隔离"两条安全属性的
        //   前提，**不是功能残缺**；事务实验用 `multi:true` 单次执行，已实测回滚行数不变 / 提交 +1）。
        //   ⚠️ 若 worker 将来真接会话级事务（`cross_call:true`），这里**零改动自动变 true**。
        transactions_cross_call: readCrossCallTx(out) === true,
        ...(readCrossCallTx(out) === true
          ? {}
          : {
              transactions_note:
                '跨调用事务不支持：每次 execute 独立进程（硬超时强杀 + 学生间隔离的安全前提，有意设计）。事务实验请用 multi:true 单次执行。',
            }),
      };
    },
    auth: { required: true, bootstrap: bootstrapState },
  };

  // ── Fastify ──────────────────────────────────────────────────────
  // ★ 必须**关掉 Fastify 自带的请求日志** —— 两条理由都真机实测过（不是偏好）：
  //   ① **它会泄漏**：Fastify 默认把整个 `raw`（IncomingMessage）序列化进日志 →
  //      一次 146 字节的请求变成 **5.7KB 一行**，而且**查询串里的 token 原样落盘**
  //      （实测：带 `?token=sk-FAKE-…` + `Authorization` 的请求，假密钥在日志里出现 **2 次**）。
  //      我们自己的 `onResponse` 钩子只记 `path`（**不含查询串**）+ 白名单字段 → 不泄漏。
  //   ② 否则**每请求两行**（它的 + 我们的），且它那行几 KB，轮转会被它拖着跑。
  //
  // ⚠️ 非废弃的关法是 **`logController` + `LogController` 实例**。
  //    传**普通对象**会让 `npm start` 直接 `FastifyError: must be an instance of LogController`
  //    （曾因此把用户后端搞断 → 教训：`as never` 按下去的类型错必须用**真启动**验证）。
  // ⚠️ `logController` 不在 `FastifyServerOptions` 类型里（只存在于运行期/文档）→
  //    用**显式的交叉类型**声明选项（不是 `as never`：其余字段仍受类型检查），
  //    并由 `test/logging_http.test.ts` 的**真启动**（buildApp + listen）兜底。
  const fastifyOptions: FastifyServerOptions & { logController?: unknown } = {
    ...(logging
      ? {
          logger: logging.fastifyOptions,
          // `logController` 不在 `FastifyServerOptions` 类型里（只存在于运行期/文档）→ 受控窄化，
          // 由 `test/logging_http.test.ts` 的**真启动**（buildApp + listen）兜底。
          logController: new LogController({ disableRequestLogging: true }),
        }
      : { logger: false }),
    bodyLimit: Math.max(cfg.maxUploadBytes, 64 * 1024 * 1024),
    // 中文/空格路径无关；这里只是让 404 也走我们的 JSON 形状
    ajv: { customOptions: { coerceTypes: true } },
  };
  const app = Fastify(fastifyOptions);

  // ★ 进程级告警（含 fastify 等依赖的 deprecation）**也落盘** —— 原来只打 stderr，关掉终端就没了
  if (logging) {
    process.on('warning', (w) => {
      logging!.warn({ source: 'process.warning', name: w.name, detail: w.message }, 'process warning');
    });
    process.on('uncaughtException', (err) => {
      logging!.error({ err, source: 'uncaughtException' }, 'uncaught exception');
    });
    process.on('unhandledRejection', (reason) => {
      logging!.error(
        { reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : String(reason), source: 'unhandledRejection' },
        'unhandled rejection',
      );
    });
  }

  await app.register(multipart, {
    limits: { fileSize: cfg.maxUploadBytes, files: 1, fields: 20 },
  });

  if (chatFactory) {
    await app.register(websocket);
  }

  app.setNotFoundHandler((_req, reply) => reply.code(404).send(NOT_FOUND_JSON));

  // ★ 请求日志（自己打：要带**用户 id**，而 Fastify 默认的请求日志只有 req/res）
  //   字段：方法 / 路径（**查询串已清洗敏感值**）/ 状态码 / 耗时 ms / 用户 id（有则记，无则 null）
  if (logging) {
    app.addHook('onResponse', (req, reply, done) => {
      const user = (req as { user?: { id?: string } }).user;
      const line = {
        method: req.method,
        path: req.url.split('?')[0] ?? req.url,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime * 100) / 100,
        userId: user?.id ?? null,
      };
      try {
        if (reply.statusCode >= 500) req.log.error(line, 'request failed');
        else if (reply.statusCode >= 400) req.log.warn(line, 'request');
        else req.log.info(line, 'request');
      } catch {
        /* 日志失败不影响请求 */
      }
      done();
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    // ★ 异常**带堆栈**落盘（用户最缺的就是这个：原来只有 500 响应，没有过程）
    if (logging) {
      try {
        _req.log.error({ err, path: _req.url.split('?')[0] ?? _req.url, method: _req.method }, 'unhandled error');
      } catch {
        /* 日志失败不影响响应 */
      }
    }
    if (err instanceof ApiError) return reply.code(err.httpStatus).send(err.toBody());
    // Fastify 的参数校验错误（我们主要用 zod/手写校验，这里兜底）
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status === 413) {
      return reply.code(413).send({
        error: { code: 'E_TOOBIG', msg: '上传体积超限', hint: '用 COURSE_KB_MAX_UPLOAD 调整上限' },
      });
    }
    return reply.code(status).send({
      error: {
        code: status === 400 ? 'E_NOFILE' : 'E_INTERNAL',
        msg: redact(err instanceof Error ? err.message : String(err)),
      },
    });
  });

  registerCapabilityRoutes(app, deps);
  // ★ RBAC：鉴权钩子必须在**路由注册前**装好（onRequest 对所有路由生效）
  installAuth(app, { repo, cfg });
  registerAuthRoutes(app, deps);
  registerRbacRoutes(app, deps);
  registerSandboxRoutes(app, deps);

  // ── 注册 video-pipeline 的 `/settings/*` + `/models`（未交付/失败则跳过，不影响其余功能）──
  if (settingsStore && typeof settingsRoutesMod.mod?.createSettingsRoutes === 'function') {
    try {
      await settingsRoutesMod.mod.createSettingsRoutes({
        cfg,
        store: settingsStore,
        repo,
        queue,
        providers,
      })(app);
      process.stderr.write('[settings] /settings/* 与 /models 已注册\n');
    } catch (err) {
      process.stderr.write(
        `[settings] 路由注册失败（其余功能不受影响）：${redact(err instanceof Error ? err.message : String(err))}\n`,
      );
    }
  }
  registerCollectionRoutes(app, deps);
  registerDocumentRoutes(app, deps);
  registerCardRoutes(app, deps);
  registerSearchRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerChatRoute(app, deps);

  // 重启恢复（契约 C4）：把 running 的旧任务重新排队
  const recovered = queue.recover();
  if (recovered.length > 0) {
    process.stderr.write(`[tasks] 重启恢复 ${recovered.length} 个任务：${recovered.join(', ')}\n`);
  }

  return {
    app,
    deps,
    logging,
    availabilityWarmUp: () => {
      availabilityWarmUp();
    },
    peekAvailability: () => availabilityResolver.current(),
    taskWatchdog: () => {
      const r = watchdog.runStartup();
      logging?.info(
        {
          event: 'task-watchdog',
          killed: r.stale.killed.length,
          alive: r.stale.alive.length,
          docs_healed: r.docs.healed.length,
          docs_kept_running: r.docs.keptRunning.length,
          stale_ms: taskStaleMs,
        },
        'startup watchdog sweep done',
      );
      return r;
    },
    taskStaleMs,
    async close() {
      // 顺序很重要：先中止在跑的 worker，再**等任务收尾写完 tasks 行**，最后关 DB。
      // 原错误写法：stop() 后立刻 db.close() → 任务收尾写入撞上已关闭连接，
      // 抛「database connection is not open」且是异步抛（会污染其他测试/请求的结论）。
      queue.stop();
      workerClient.cancelAll('server closing');
      const drained = await queue.shutdown(8000);
      if (drained.timedOut) {
        process.stderr.write(`[tasks] 关停超时，仍有活动任务：${drained.stillActive.join(', ')}\n`);
      }
      try {
        await app.close();
      } catch {
        /* 忽略 */
      }
      db.close();
      // ★ 关日志（同步写，close 只是接口一致性）
      logging?.close();
    },
  };
}

/** CLI 入口：`node src/index.ts` / `npm run dev`。 */
export async function main(): Promise<void> {
  const cfg = loadConfig();
  const built = await buildApp({ cfg });
  const { app, deps } = built;

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`\n[server] 收到 ${signal}，正在优雅关闭…\n`);
    await built.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // ★ 启动信息**落盘**（运维第一件要知道的事：日志文件在哪）
  if (built.logging) {
    // ★ debug 级也写一条：这样 `COURSE_KB_LOG_LEVEL=debug` 在**真机上可观测**
    //   （否则"级别可配"只是个说法 —— 坑 24 的死旋钮判据：设了极小值/更细级别要能看到变化）
    built.logging.debug(
      { event: 'log-config', dir: built.logging.dir, file: built.logging.file, level: built.logging.level, retentionDays: cfg.logging.retentionDays, maxBytes: cfg.logging.maxBytes },
      'logging configured',
    );
    built.logging.writeLine(
      {
        event: 'startup',
        version: SERVER_VERSION,
        host: cfg.host,
        port: cfg.port,
        root: cfg.root,
        db: cfg.dbPath,
        logFile: built.logging.file,
        logLevel: built.logging.level,
        node: process.version,
      },
      'server starting',
    );
  }

  await app.listen({ host: cfg.host, port: cfg.port });

  // ★★ 坑 32：**服务起来之后**再后台预热 LLM 可用性探测（不阻塞任何请求）。
  //   这样第一个抽取任务通常已拿到结果；最差也只是如实显示"检测中"（不再白等 68 秒）。
  built.availabilityWarmUp();

  // ★★ v8 看门狗：**启动先扫一遍**（用户实测：关机重启后 running 任务永远不动 → 队列被堵死）。
  //   ① 判死"心跳超时"的 running 任务并释放队列 ② 自愈"没有任何 running 任务"的 extracting 文档。
  //   ⚠️ 两件事都**如实记日志**（不许静默改状态）；判据见 `tasks/watchdog.ts` 头部注释。
  try {
    const swept = built.taskWatchdog();
    if (swept.stale.killed.length > 0 || swept.docs.healed.length > 0) {
      process.stdout.write(
        `[watchdog] 判死超时任务 ${swept.stale.killed.length} 个（心跳新鲜保留 ${swept.stale.alive.length} 个）；` +
          `自愈 extracting 文档 ${swept.docs.healed.length} 个（真在跑的保留 ${swept.docs.keptRunning.length} 个）\n`,
      );
    }
  } catch (err) {
    // 看门狗失败**不能**让服务起不来（它是自愈，不是主链路），但必须如实报
    process.stderr.write(`[watchdog] 启动扫描失败：${err instanceof Error ? err.message : String(err)}\n`);
  }
  const base = `http://${cfg.host}:${cfg.port}`;
  process.stdout.write(
    [
      `course-kb server v${SERVER_VERSION}`,
      `  health       ${base}/api/v1/health`,
      `  capabilities ${base}/api/v1/capabilities`,
      `  docs         ${base}/api/v1/documents`,
      `  root         ${cfg.root}`,
      `  db           ${cfg.dbPath}`,
      `  logs         ${
        built.logging ? `${built.logging.dir}（文件 ${built.logging.file}，级别 ${built.logging.level}）` : '未启用'
      }`,
      `  worker       ${deps.workerCapability.available ? '可用' : `不可用（${deps.workerCapability.reason}）`}`,
      `  providers    ${deps.providers ? '已组装' : `不可用（${deps.providersError ?? 'unknown'}）`}`,
      `  agent(pi)    ${deps.agentCapabilities ? '已组装' : `不可用（${deps.agentError ?? 'unknown'}）`}`,
      '',
    ].join('\n'),
  );
}

// 直接执行时才 listen（被 import 时不启动，便于测试）
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain || process.env.COURSE_KB_AUTOSTART === '1') {
  main().catch((err) => {
    process.stderr.write(`[server] 启动失败：${redact(err instanceof Error ? err.stack ?? err.message : String(err))}\n`);
    process.exit(1);
  });
}
