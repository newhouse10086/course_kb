/**
 * pi SDK 加载层（v2 架构 §5：**进程内** SDK，不再有 RPC 子进程/JSONL/切帧）。
 *
 * 设计要点（每一条都有理由）：
 *
 * 1. **动态 `import()`，不是静态 import**。
 *    v1 的三档降级的教训在 v2 变成一条更简单的规则：**SDK 装不上时服务必须还能起来**，
 *    并且要**如实**报 `available:false` + 可读 `reason`（架构 §4 的 R1/R2/R3 铁律）。
 *    静态 import 会让 `server/src/index.ts` 直接崩在模块加载阶段，连 `/health` 都没了。
 *    → 运行期用动态 import；**类型**用 `import type`（`verbatimModuleSyntax` 下会被完全擦除，
 *      所以即使包没装也能通过编译/运行，只是运行时报不可用）。
 *
 * 2. **加载结果缓存**（含失败的缓存）。首次加载实测约 **4.1s**（pi 会拉模型目录等），
 *    不缓存的话每次 `/capabilities` 都要 4 秒。失败也缓存，避免每次请求都重试一遍。
 *
 * 3. **版本如实取**：SDK 导出 `VERSION`；取不到就是 `null`，**不编造**。
 */

import type {
  AgentSession,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  DefaultResourceLoader as DefaultResourceLoaderType,
  SessionManager as SessionManagerType,
} from '@earendil-works/pi-coding-agent';

/** 包名（可注入，便于测试与将来换 specifier）。 */
export const DEFAULT_SDK_SPECIFIER = '@earendil-works/pi-coding-agent';

/** 加载成功时的 SDK 句柄（只暴露我们真正用到的东西）。 */
export interface LoadedSdk {
  createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
  SessionManager: typeof SessionManagerType;
  /** SDK 自报版本（`VERSION` 导出）；取不到为 null */
  version: string | null;
  /** 动态 import 实测耗时（ms） */
  loadMs: number;
  specifier: string;
  /**
   * 资源加载器构造器（用于**替换/追加系统提示词**：教学答疑场景要自己的系统提示词，
   * 而不是 pi 默认的 coding-agent 提示词）。旧版本 SDK 可能没有 → 可选。
   */
  DefaultResourceLoader?: typeof DefaultResourceLoaderType;
  /** 取 pi 的全局配置目录（`~/.pi/agent`）。构造 DefaultResourceLoader 需要它。 */
  getAgentDir?: () => string;
  /**
   * 模型运行时（`ModelRuntime.create()` + `getModel(provider, modelId)`）。
   *
   * ★ 用途：**显式给会话指定模型**。`createAgentSession({model})` 要的是 `Model` **对象**
   * 而不是字符串；拿不到就只能回落到 **pi 自己的全局默认**（`~/.pi/agent/settings.json`）——
   * 那会和项目 `settings.json` 的 `llm.active` **不一致**
   * （真出过：`ready` 报 `glm-5.2`，而 `/settings` 与 `/capabilities` 都说 `deepseek-v4.1-flash`，
   * 且那个全局 provider 的 key 已 401 → 学生提问**静默无响应**）。
   */
  ModelRuntime?: {
    create(options?: unknown): Promise<{ getModel(providerId: string, modelId: string): unknown }>;
  };
}

export interface SdkLoadFailure {
  available: false;
  specifier: string;
  reason: string;
  detail: string;
  loadMs: number;
}

export type SdkLoadResult = ({ available: true } & LoadedSdk) | SdkLoadFailure;

/** 可注入的 import 实现（单测用它模拟"包没装"/"加载即崩"，不依赖真实 SDK）。 */
export type SdkImporter = (specifier: string) => Promise<unknown>;

export interface LoadSdkOptions {
  specifier?: string;
  importer?: SdkImporter;
  /** true = 忽略缓存强制重新加载 */
  force?: boolean;
}

const defaultImporter: SdkImporter = (specifier) => import(specifier);

/** 缓存：一次加载结果（成功或失败）全局复用。 */
let cached: SdkLoadResult | null = null;
let inflight: Promise<SdkLoadResult> | null = null;

/** 把 import 失败翻译成人能看懂的原因（区分"没装"与"装了但崩"）。 */
function describeLoadError(err: unknown, specifier: string): { reason: string; detail: string } {
  const code =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
      ? String((err as { code: string }).code)
      : '';
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'ERR_MODULE_NOT_FOUND' || /cannot find (package|module)/i.test(message)) {
    return {
      reason: `pi SDK 未安装：${specifier} 无法解析（在 apps/server 下执行 npm install）`,
      detail: `${code || 'ERR_MODULE_NOT_FOUND'}: ${message}`,
    };
  }
  if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || code === 'ERR_UNSUPPORTED_DIR_IMPORT') {
    return {
      reason: `pi SDK 的导出入口不可用（${specifier}）：${code}`,
      detail: message,
    };
  }
  return {
    reason: `pi SDK 加载失败：${message}`,
    detail: `${code || (err instanceof Error ? err.name : 'unknown')}: ${message}`,
  };
}

/** 从加载到的模块里取出我们需要的成员；缺任何一个都视为不可用（不半可用）。 */
function extractSdk(mod: unknown, specifier: string, loadMs: number): SdkLoadResult {
  const m = mod as Record<string, unknown> | null;
  const createAgentSession = m?.createAgentSession;
  const SessionManager = m?.SessionManager;
  if (typeof createAgentSession !== 'function') {
    return {
      available: false,
      specifier,
      reason: `pi SDK 缺少 createAgentSession 导出（版本不兼容？${specifier}）`,
      detail: 'typeof createAgentSession !== "function"',
      loadMs,
    };
  }
  if (typeof SessionManager !== 'function' && typeof SessionManager !== 'object') {
    return {
      available: false,
      specifier,
      reason: `pi SDK 缺少 SessionManager 导出（版本不兼容？${specifier}）`,
      detail: 'typeof SessionManager !== "function" | "object"',
      loadMs,
    };
  }
  const version = typeof m?.VERSION === 'string' ? (m.VERSION as string) : null;
  // 可选能力：不参与 available 判定（旧版本没有也能用，只是换不了系统提示词）
  const DefaultResourceLoader =
    typeof m?.DefaultResourceLoader === 'function'
      ? (m.DefaultResourceLoader as LoadedSdk['DefaultResourceLoader'])
      : undefined;
  const getAgentDir = typeof m?.getAgentDir === 'function' ? (m.getAgentDir as () => string) : undefined;
  const ModelRuntime =
    typeof m?.ModelRuntime === 'function' || typeof m?.ModelRuntime === 'object'
      ? (m.ModelRuntime as LoadedSdk['ModelRuntime'])
      : undefined;
  return {
    available: true,
    createAgentSession: createAgentSession as LoadedSdk['createAgentSession'],
    SessionManager: SessionManager as LoadedSdk['SessionManager'],
    version,
    loadMs,
    specifier,
    ...(DefaultResourceLoader ? { DefaultResourceLoader } : {}),
    ...(getAgentDir ? { getAgentDir } : {}),
    ...(ModelRuntime ? { ModelRuntime } : {}),
  };
}

/**
 * 加载 pi SDK（**永不抛**）。结果（含失败）会被缓存。
 *
 * @example
 * const sdk = await loadSdk();
 * if (!sdk.available) return { available: false, reason: sdk.reason };
 */
export async function loadSdk(options: LoadSdkOptions = {}): Promise<SdkLoadResult> {
  const specifier = options.specifier ?? DEFAULT_SDK_SPECIFIER;
  const importer = options.importer ?? defaultImporter;
  const cacheable = options.importer === undefined && specifier === DEFAULT_SDK_SPECIFIER;

  if (cacheable && !options.force) {
    if (cached) return cached;
    if (inflight) return inflight;
  }

  const run = async (): Promise<SdkLoadResult> => {
    const started = Date.now();
    try {
      const mod = await importer(specifier);
      const result = extractSdk(mod, specifier, Date.now() - started);
      if (cacheable) cached = result;
      return result;
    } catch (err) {
      const { reason, detail } = describeLoadError(err, specifier);
      const result: SdkLoadResult = {
        available: false,
        specifier,
        reason,
        detail,
        loadMs: Date.now() - started,
      };
      // 失败也缓存：避免每次 /capabilities 都重试 4 秒
      if (cacheable) cached = result;
      return result;
    }
  };

  if (!cacheable) return run();

  inflight = run();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * 预热 SDK（可选）：在服务启动时调用，把首次 4s 的加载成本挪到启动阶段。
 * **永不抛**，返回是否可用。
 */
export async function warmupSdk(options: LoadSdkOptions = {}): Promise<boolean> {
  const sdk = await loadSdk(options);
  return sdk.available;
}

/** 清缓存（测试用；也用于"装完 SDK 不重启服务"的场景）。 */
export function clearSdkCache(): void {
  cached = null;
  inflight = null;
}

/** 当前缓存的加载结果（不触发加载）。 */
export function peekSdkCache(): SdkLoadResult | null {
  return cached;
}

/** 便捷类型：会话对象（供 session.ts / 测试用）。 */
export type PiAgentSession = AgentSession;
