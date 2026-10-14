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

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import path from 'node:path';

import { loadConfig, ensureDirs, redact, materializePiModels } from './config.ts';
import type { ServerConfig } from './config.ts';
import { Db } from './store/db.ts';
import { Repo } from './store/repo.ts';
import { loadSchemaEnums } from './store/schema-enums.ts';
import type { SchemaEnums } from './store/schema-enums.ts';
import { search as searchKb } from './store/search.ts';
import type { SearchHit } from './store/search.ts';
import { TaskEventBus } from './tasks/bus.ts';
import { TaskQueue } from './tasks/queue.ts';
import { createHandlers } from './tasks/handlers.ts';
import { createWorkerExtractor } from './tasks/extract.ts';
import type { CompleteJsonFn } from './tasks/extract.ts';
import type { TaskHandler } from './tasks/queue.ts';
import type { Extractor } from './tasks/extract.ts';
import { WorkerClient } from './worker/client.ts';
import { createWorkerRunner } from './worker/runner.ts';
import type { WorkerRunnerWithRaw } from './worker/runner.ts';
import { probeWorker } from './worker/probe.ts';
import { registerCapabilityRoutes, SERVER_VERSION } from './routes/capabilities.ts';
import { registerDocumentRoutes } from './routes/documents.ts';
import { registerCardRoutes } from './routes/cards.ts';
import { registerSearchRoutes } from './routes/search.ts';
import { registerTaskRoutes } from './routes/tasks.ts';
import { registerChatRoute } from './routes/chat.ts';
import { registerSandboxRoutes, DEFAULT_LIMITS, ownerOfSession, readCrossCallTx } from './routes/sandbox.ts';
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
}

/** 结果容器：测试要拿到 db/repo/queue 做断言，所以不只返回 fastify 实例。 */
export interface BuiltApp {
  app: FastifyInstance;
  deps: AppDeps;
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
  });
  const runner: WorkerRunnerWithRaw = createWorkerRunner(workerClient);
  const runWorkerProbe = async (force: boolean): Promise<AppDeps['workerCapability']> =>
    opts.workerProbe
      ? opts.workerProbe()
      : probeWorker({ pythonBin: cfg.pythonBin, module: cfg.workerModule, cwd: cfg.root, force });
  const workerCapability = await runWorkerProbe(false);

  // ── 封闭枚举（C3：来自 schema/*.json，不内置兜底）─────────────────
  const enums: SchemaEnums = loadSchemaEnums(cfg.root);

  // ── providers（T-PROVIDERS 的写域，动态 import）────────────────────
  let providers: ProviderFacade | null = null;
  let providersError: string | null = null;
  const providerMod = await tryImport<{
    createProviderLayer: (o: {
      config: unknown;
      runWorker: unknown;
      onSkip?: (entry: unknown, reason: string) => void;
    }) => ProviderFacade;
  }>('./providers/index.ts');
  if (providerMod.mod?.createProviderLayer) {
    try {
      providers = providerMod.mod.createProviderLayer({
        config: cfg.providers,
        runWorker: runner,
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

  // 抽取器可用性**惰性**解析一次并缓存（避免每个任务都真探测一次）
  let availabilityCache: { ok: boolean; reason: string } | null = null;
  const resolveExtractorAvailability = async (): Promise<{ ok: boolean; reason: string }> => {
    if (availabilityCache) return availabilityCache;
    if (!extractor) {
      availabilityCache = { ok: false, reason: providersError ?? '未初始化抽取器' };
      return availabilityCache;
    }
    if (!enums.edgeTypes.length || !enums.cardKinds.length) {
      availabilityCache = {
        ok: false,
        reason: `封闭枚举未加载（${enums.warnings.join('；') || 'schema/ 缺失'}）→ 抽取会产出非法枚举，故禁用`,
      };
      return availabilityCache;
    }
    const a = await extractor.available();
    availabilityCache = { ok: a.ok, reason: a.reason || '' };
    return availabilityCache;
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
      const piModels = materializePiModels(cfg);
      if (piModels && typeof sessionMod.mod?.AgentSessionManager === 'function') {
        try {
          const manager = new sessionMod.mod.AgentSessionManager({
            modelsPath: piModels.modelsPath,
            model: piModels.modelRef,
          });
          chatFactory = (connOpts) => createConn({ ...connOpts, manager } as never);
          process.stderr.write(
            `[agent] 模型已绑定项目配置：${piModels.modelRef}` +
              `（models.json → ${path.relative(cfg.root, piModels.modelsPath)}，apiKey 只写 data/，不回显）\n`,
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
  }>('./sandbox/ask.ts');
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

  // ── 系统设置 + 模型热切换（video-pipeline 交付；动态接入）────────────────
  // 分工：`settings.json` 运行期可改（热重载）· `providers.yaml` 部署期 · `.env` 只放凭据。
  // ⚠️ **非法配置 → 拒绝启动 + 可读原因**（spec §1）：`watchSettings` 抛 SettingsError 时
  //    这里**必须把它抛出去**，绝不"静默用默认值"跑起来 —— 那会让运维以为自己的改动生效了。
  const settingsMod = await tryImport<{
    watchSettings?: (opts: { root: string }) => { get: () => unknown };
    sandboxLimitsOf?: (s: unknown) => Record<string, unknown>;
  }>('./settings/index.ts');
  const settingsRoutesMod = await tryImport<{
    createSettingsRoutes?: (deps: Record<string, unknown>) => (app: FastifyInstance) => Promise<void> | void;
    settingsCapabilities?: (store: unknown, switcher?: unknown) => Record<string, unknown>;
  }>('./routes/settings.ts');

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
    process.stderr.write('[settings] 未接入（watchSettings 不可用）→ /settings/* 不注册\n');
  }

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

  const queue = new TaskQueue({
    repo,
    bus,
    handlers,
    concurrency: cfg.taskConcurrency,
    // RBAC §5：配额按角色（学生 1 / 教师 2 / 管理员不限）
    resolveQuota: (userId) => {
      const roles = repo.rbac.rolesOf(userId);
      const user = { id: userId, username: '', displayName: '', roles: roles.filter(isRole) as never[], teacherCourseIds: [], studentCourseIds: [], status: 'active' as const };
      return taskQuota(user);
    },
  });

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
    retrieval,
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
  const app = Fastify({
    logger: false,
    bodyLimit: Math.max(cfg.maxUploadBytes, 64 * 1024 * 1024),
    // 中文/空格路径无关；这里只是让 404 也走我们的 JSON 形状
    ajv: { customOptions: { coerceTypes: true } },
  });

  await app.register(multipart, {
    limits: { fileSize: cfg.maxUploadBytes, files: 1, fields: 20 },
  });

  if (chatFactory) {
    await app.register(websocket);
  }

  app.setNotFoundHandler((_req, reply) => reply.code(404).send(NOT_FOUND_JSON));
  app.setErrorHandler((err, _req, reply) => {
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

  await app.listen({ host: cfg.host, port: cfg.port });
  const base = `http://${cfg.host}:${cfg.port}`;
  process.stdout.write(
    [
      `course-kb server v${SERVER_VERSION}`,
      `  health       ${base}/api/v1/health`,
      `  capabilities ${base}/api/v1/capabilities`,
      `  docs         ${base}/api/v1/documents`,
      `  root         ${cfg.root}`,
      `  db           ${cfg.dbPath}`,
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
