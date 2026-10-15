/**
 * `settings.json` 的**类型与默认值**（`docs/SETTINGS_AND_SANDBOX.md` §1）。
 *
 * **分工**（三者不许混）：
 * - `config/settings.json`  → **运行期可改**（模型选择、策略、配额、沙箱开关）· 教师/运维改 · **热重载**
 * - `config/providers.yaml` → 部署期（provider 清单与凭据引用）
 * - `.env`                  → **只放凭据**（永不进 settings.json）
 *
 * ⚠️ 不引 zod（项目已删依赖）：手写校验在 `validate.ts`，**错误信息必须可读**且指出**具体路径**。
 *
 * 本文件原为 `backend-api` 起的最小 stub；按 Lead 最终划定，`src/settings/**` 由
 * `video-pipeline` 拥有 —— 这里按规格 §1 补齐了 `asr/tts/translate/quota/hotReload`
 * 的**具名类型**，并**保留** `HARD_LLM_CONCURRENCY = 1` 与 `clampConcurrency()` 的语义与命名。
 */

// ═══════════════════════════════════════════════════════════════════════
// 子类型
// ═══════════════════════════════════════════════════════════════════════

export interface LlmSettings {
  /** ★ 当前生效模型（热切换改这个） */
  active: string;
  fallbacks: string[];
  temperature: number;
  /** ★ 必须含推理预算：该端点 8 字回复用 54 个 reasoning token（§0） */
  maxTokens: number;
  structured: { jsonSchemaStrict: boolean };
  /**
   * ★ 用户硬要求：**永远 1**（见 `clampConcurrency`）。
   * 类型上留 `number` 而不是字面量 `1`，是为了能"读到 8 再如实上报被钳制"。
   */
  concurrency: number;
}

export interface AsrSettings {
  active: string | null;
  /** 本地 faster-whisper 的模型名（tiny/base/…） */
  model: string;
  fallbacks: string[];
}

export interface TtsSettings {
  active: string | null;
}

/** 术语表注入方式（`docs/PROVIDERS.md` 翻译管线）。 */
export const GLOSSARY_MODES = ['inject', 'none'] as const;
export type GlossaryMode = (typeof GLOSSARY_MODES)[number];

export interface TranslateSettings {
  active: string | null;
  glossaryMode: GlossaryMode;
  /** 标识符（表名/字段名/SQL 关键字）不翻译 */
  keepIdentifiers: boolean;
}

/** 沙箱引擎 id（封闭集合：与 `docs/LAB_DB_DEPLOY.md` §2 的 `EngineInfo.id` 一致）。 */
export const SANDBOX_ENGINES = ['sqlite', 'postgres', 'mysql', 'opengauss'] as const;
export type SandboxEngineId = (typeof SANDBOX_ENGINES)[number];

export const RESET_POLICIES = ['per_session', 'never', 'always'] as const;
export type ResetPolicy = (typeof RESET_POLICIES)[number];

export interface SandboxLimits {
  /** 单次查询最多返回行数（默认 200） */
  maxRows: number;
  /** 单条语句超时（ms）—— 死循环查询必须被硬超时杀掉 */
  timeoutMs: number;
  /** 单个学生库体积上限（字节） */
  maxDbBytes: number;
}

export interface SandboxSettings {
  enabled: boolean;
  engine: SandboxEngineId;
  limits: SandboxLimits;
  /** ★ 允许增删查改（实验需要）；false 时路由层应拒绝写语句 */
  allowWrites: boolean;
  resetPolicy: ResetPolicy;
}

export interface QuotaEntry {
  concurrentLlmTasks: number;
  dailyLlmCalls: number;
}

export interface QuotaSettings {
  student: QuotaEntry;
  teacher: QuotaEntry;
}

export interface HotReloadSettings {
  /** 改文件后**不重启**即生效 */
  watch: boolean;
  debounceMs: number;
}

export interface Settings {
  version: number;
  llm: LlmSettings;
  asr: AsrSettings;
  tts: TtsSettings;
  translate: TranslateSettings;
  sandbox: SandboxSettings;
  quota: QuotaSettings;
  hotReload: HotReloadSettings;
}

// ═══════════════════════════════════════════════════════════════════════
// 默认值（文件缺失时用；**必须如实上报 source="default"**）
// ═══════════════════════════════════════════════════════════════════════

export function defaultSettings(): Settings {
  return {
    version: 1,
    llm: {
      active: 'deepseek-v4.1-flash',
      fallbacks: ['glm-5.3', 'kimi-k3'],
      temperature: 0,
      maxTokens: 16_384,
      structured: { jsonSchemaStrict: true },
      concurrency: HARD_LLM_CONCURRENCY,
    },
    asr: { active: 'local-fw', model: 'tiny', fallbacks: ['aliyun-asr'] },
    tts: { active: null },
    translate: { active: 'llm-mt', glossaryMode: 'inject', keepIdentifiers: true },
    sandbox: {
      enabled: true,
      engine: 'sqlite',
      limits: { maxRows: 200, timeoutMs: 3000, maxDbBytes: 20 * 1024 * 1024 },
      allowWrites: true,
      resetPolicy: 'per_session',
    },
    quota: {
      student: { concurrentLlmTasks: 1, dailyLlmCalls: 200 },
      teacher: { concurrentLlmTasks: 2, dailyLlmCalls: 2000 },
    },
    hotReload: { watch: true, debounceMs: 500 },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ★ 并发硬上限
// ═══════════════════════════════════════════════════════════════════════

/** ★ 并发硬上限（用户明确要求"并发跑推理不合适"）——**任何配置都调不高**。 */
export const HARD_LLM_CONCURRENCY = 1;

export interface ClampNote {
  path: string;
  requested: unknown;
  applied: number;
  reason: string;
}

/**
 * ★ `concurrency` 钳制：**配置只能调低或等于 1，不能调高**。
 *
 * 为什么在代码层忽略而不是"启动报错"：这是**用户硬要求**（并发=1 是全局约束），
 * 若因为运维在文件里写了 8 就拒绝启动，反而让系统因为"一个不该生效的字段"停机 ——
 * **忽略它并如实上报**才是对的（`clamped[]` 会说明"你写的 8 没生效，实际是 1"）。
 *
 * ⚠️ 会**原地修改**传入对象（保持 backend-api 原语义，调用方传新对象即可）；
 * 返回值里的 `clamped` 必须被**回显到 API 响应**（`ignored[]`），否则就是"静默忽略"。
 */
export function clampConcurrency(settings: Settings): { settings: Settings; clamped: ClampNote[] } {
  const clamped: ClampNote[] = [];
  const want = settings.llm.concurrency;
  if (!Number.isFinite(want) || want > HARD_LLM_CONCURRENCY) {
    settings.llm.concurrency = HARD_LLM_CONCURRENCY;
    clamped.push({
      path: 'llm.concurrency',
      requested: want,
      applied: HARD_LLM_CONCURRENCY,
      reason: '用户硬要求：LLM 并发恒为 1（配置无法调高）',
    });
  }
  // 配额也不许超过全局并发上限的合理倍数（学生并发 LLM 任务 ≤1）
  if (settings.quota.student.concurrentLlmTasks > HARD_LLM_CONCURRENCY) {
    clamped.push({
      path: 'quota.student.concurrentLlmTasks',
      requested: settings.quota.student.concurrentLlmTasks,
      applied: HARD_LLM_CONCURRENCY,
      reason: '学生并发 LLM 任务不得超过全局并发 1',
    });
    settings.quota.student.concurrentLlmTasks = HARD_LLM_CONCURRENCY;
  }
  if (settings.llm.concurrency < 1) {
    settings.llm.concurrency = 1;
    clamped.push({ path: 'llm.concurrency', requested: want, applied: 1, reason: '并发至少为 1' });
  }
  return { settings, clamped };
}
