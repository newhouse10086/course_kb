/**
 * `settings` 模块出口（`docs/SETTINGS_AND_SANDBOX.md` §1 + §2）。
 *
 * ## backend-api 怎么接（一行）
 * ```ts
 * const store = watchSettings({ root: cfg.root });          // 加载 + 热重载（文件非法时抛错 → 你决定是否拒启）
 * const catalog = new ModelCatalog({ cfg });
 * createSettingsRoutes({ cfg, store, catalog, repo, queue, providers })(app);
 * // 沙箱限额（routes/sandbox.ts 用）：
 * app-deps 里 sandboxLimits: () => sandboxLimitsOf(store.get())
 * ```
 *
 * ⚠️ 与 `types.ts` 的关系：`types.ts` 由 backend-api 先建（Lead 裁定**零改动复用**），
 * 本模块保留它的导出名与语义（`Settings` / `defaultSettings` / `clampConcurrency` / `HARD_LLM_CONCURRENCY`）。
 */

import type { Settings } from './types.ts';

export type {
  Settings,
  LlmSettings,
  AsrSettings,
  TtsSettings,
  TranslateSettings,
  SandboxSettings,
  SandboxLimits,
  SandboxEngineId,
  QuotaSettings,
  QuotaEntry,
  HotReloadSettings,
  GlossaryMode,
  ResetPolicy,
  ClampNote,
} from './types.ts';
export {
  defaultSettings,
  clampConcurrency,
  HARD_LLM_CONCURRENCY,
  GLOSSARY_MODES,
  SANDBOX_ENGINES,
  RESET_POLICIES,
} from './types.ts';

export { SETTINGS_ERROR_CODES, type SettingsErrorCode } from './error-codes.ts';

export {
  MIN_SANE_MAX_TOKENS,
  SETTINGS_REL_PATH,
  SETTINGS_SCHEMA_REL_PATH,
  resolveSettingsPath,
  resolveSchemaPath,
} from './paths.ts';

export { SettingsError, validateSettings, redactSettings, type ValidateResult } from './validate.ts';

export {
  loadSettings,
  writeSettingsFile,
  type LoadResult,
  type LoadOptions,
  type SettingsSource,
  type SettingsSnapshot,
} from './loader.ts';

export { SettingsStore, watchSettings, type SettingsView, type SettingsStoreOptions } from './store.ts';

export {
  ModelCatalog,
  explainHttp,
  type ModelEntry,
  type ModelProbe,
  type ModelsResult,
  type ModelCatalogOptions,
} from './models.ts';

export {
  ModelSwitcher,
  queueGate,
  SWITCH_MODES,
  DEFAULT_LLM_TASK_KINDS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  type SwitchMode,
  type SwitchRequest,
  type SwitchResult,
  type BusyReport,
  type AdmissionGate,
  type QueueLike,
  type ResumePlan,
  type RunningLlmTask,
} from './switcher.ts';

/**
 * 沙箱限额视图（`app-deps.ts::sandboxLimits` 用）。
 *
 * 形状与 `docs/SETTINGS_AND_SANDBOX.md` §1 的 `sandbox` 段一致，
 * 平铺成路由层好用的字段（不用再嵌套取值）。
 *
 * 命名说明：`types.ts::SandboxLimits` 是**嵌套**的 `sandbox.limits`；
 * 这里是**平铺**的只读视图，故叫 `...View`，避免两个同名类型打架。
 */
export interface SandboxLimitsView {
  enabled: boolean;
  engine: string;
  maxRows: number;
  timeoutMs: number;
  maxDbBytes: number;
  allowWrites: boolean;
  resetPolicy: string;
}

/** 从一份设置里取沙箱限额（**唯一取值入口**，避免各处自己钻 `settings.sandbox.limits`）。 */
export function sandboxLimitsOf(s: Settings): SandboxLimitsView {
  return {
    enabled: s.sandbox.enabled,
    engine: s.sandbox.engine,
    maxRows: s.sandbox.limits.maxRows,
    timeoutMs: s.sandbox.limits.timeoutMs,
    maxDbBytes: s.sandbox.limits.maxDbBytes,
    allowWrites: s.sandbox.allowWrites,
    resetPolicy: s.sandbox.resetPolicy,
  };
}

/** LLM 生效模型等"能力上报"数据（`/capabilities` 段落的**数据函数**，注册由 backend-api 做）。 */
export interface SettingsCapabilities {
  activeModel: string;
  fallbacks: string[];
  /** 上一次切换的来源（没切过为 null） */
  switchedFrom: string | null;
  switchedAt: number | null;
  /** 设置来源：`file`（运维改的）或 `default`（文件缺失，内置默认） */
  settingsSource: string;
  settingsRevision: number;
  /** 热重载是否在跑（false = 环境不支持监听，**如实上报**） */
  hotReload: boolean;
  /** 最近一次热重载失败原因（非 null 时 UI 要提示"你改的配置没生效"） */
  lastReloadError: string | null;
  /** 被忽略的配置（如 concurrency 被钳制），如实回显 */
  ignored: { path: string; requested: unknown; applied: number; reason: string }[];
  concurrency: number;
}
