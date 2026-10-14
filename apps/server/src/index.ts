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

import { loadConfig, ensureDirs, redact } from './config.ts';
import type { ServerConfig } from './config.ts';
import { Db } from './store/db.ts';
import { Repo } from './store/repo.ts';
import { loadSchemaEnums } from './store/schema-enums.ts';
import type { SchemaEnums } from './store/schema-enums.ts';
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
      chatFactory = streamMod.mod.createChatConnection;
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

  // ── RBAC：首个管理员引导（**仅当库里零用户**；不硬编码口令）──────────
  let bootstrapState: 'initialized' | 'not_initialized' | 'just_created' = repo.rbac.countUsers() > 0
    ? 'initialized'
    : 'not_initialized';
  try {
    const boot = await bootstrapAdmin(repo, cfg);
    if (boot?.created) {
      bootstrapState = 'just_created';
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
