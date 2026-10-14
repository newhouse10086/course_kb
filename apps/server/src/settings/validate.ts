/**
 * `settings.json` 的**校验 + 钳制**（`docs/SETTINGS_AND_SANDBOX.md` §1）。
 *
 * 三条原则：
 * 1. **严格**：类型不对 / 未知键 → **报错并指出具体路径**，不静默用默认值。
 * 2. **钳制不报错**：`llm.concurrency` 被调高是"不该生效的字段"，按需求**忽略并如实上报**
 *    （见 `types.ts::clampConcurrency`）。
 * 3. **凭据零容忍**：settings.json **绝不放凭据**（`.env` 专属）→ 凭据样子的键/值一律拒绝。
 *
 * ⚠️ 本文件**不读文件**（纯函数，便于穷尽单测）；读文件在 `loader.ts`。
 */

import {
  clampConcurrency,
  defaultSettings,
  GLOSSARY_MODES,
  RESET_POLICIES,
  SANDBOX_ENGINES,
  type ClampNote,
  type Settings,
} from './types.ts';
import { MIN_SANE_MAX_TOKENS } from './paths.ts';

/** 校验失败。`issues` 是**逐条可读**的问题列表（含路径），不是一句"配置非法"。 */
export class SettingsError extends Error {
  readonly issues: string[];
  readonly path: string;

  constructor(issues: string[], path = '') {
    const head = issues.slice(0, 8).join('；');
    super(`settings 校验失败（${issues.length} 处）：${head}`);
    this.name = 'SettingsError';
    this.issues = issues;
    this.path = path;
  }

  /** 契约 §8 的响应体（`E_BADREQUEST` 400）。 */
  toBody(): { error: { code: string; msg: string; detail: string; hint: string } } {
    return {
      error: {
        code: 'E_BADREQUEST',
        msg: `配置不合法（${this.issues.length} 处），已拒绝且**未应用任何改动**`,
        detail: this.issues.join('\n'),
        hint: '按 detail 里的路径修 config/settings.json；可用 config/settings.schema.json 做编辑器提示',
      },
    };
  }
}

export interface ValidateResult {
  /** 校验 + 钳制后的**全新对象**（不改输入） */
  settings: Settings;
  /** 非致命问题（钳制说明 / 建议性告警）—— 如实上报，不隐藏 */
  warnings: string[];
  /**
   * ★ 被**显式忽略**的配置（结构化的 `ClampNote[]`，不是一句话）。
   *
   * 需求原话是"忽略调高 + 加测试"，但**忽略必须可见**：`PUT` 响应里回显 `ignored[]`，
   * 让改配置的人立刻看到"我写的 8 没生效，实际是 1"，而不是以为自己成功了。
   */
  ignored: ClampNote[];
}

// ═══════════════════════════════════════════════════════════════════════
// 小工具：带路径的类型断言（错误信息一律带**完整路径**）
// ═══════════════════════════════════════════════════════════════════════

/**
 * 凭据样子的**键名**：命中即拒绝（`.env` 专属）。
 *
 * ⚠️ 这里踩过一个真坑：`/(...|token|...)/` 会把合法的 **`maxTokens`** 也判成凭据
 * （实测直接把默认配置判非法 → 服务起不来）。所以：
 * 1. 先过**豁免名单**（合法但有"敏感词"的字段）
 * 2. 再按"敏感词"匹配
 */
const CREDENTIAL_KEY_ALLOW = new Set([
  'maxtokens', // ★ 推理预算，合法
  'maxcontexttokens',
  'maxoutputtokens',
  'tokensperminute',
]);
const CREDENTIAL_KEY_RE =
  /(api[_-]?key|apikey|access[_-]?key|private[_-]?key|sk[_-]?key|secret|password|passwd|pwd|credential|token)/i;

/** 该键名是否属于"凭据"（豁免名单优先）。 */
export function isCredentialKey(key: string): boolean {
  if (CREDENTIAL_KEY_ALLOW.has(key.toLowerCase())) return false;
  return CREDENTIAL_KEY_RE.test(key);
}

/** 部署期字段（不是凭据，但不属于"运行期设置"）→ 只警告 */
const DEPLOYMENT_KEY_RE = /(base[_-]?url|endpoint|api[_-]?base|host|port)/i;
/** 值看起来像密钥（OpenAI 风格 `sk-...`） */
const SECRET_VALUE_RE = /(^|\s)sk-[A-Za-z0-9_-]{8,}/;

const ROOT_KEYS = new Set([
  '$schema', 'version', 'llm', 'asr', 'tts', 'translate', 'sandbox', 'quota', 'hotReload',
]);
const LLM_KEYS = new Set(['active', 'fallbacks', 'temperature', 'maxTokens', 'structured', 'concurrency']);
const ASR_KEYS = new Set(['active', 'model', 'fallbacks']);
const TTS_KEYS = new Set(['active']);
const TRANSLATE_KEYS = new Set(['active', 'glossaryMode', 'keepIdentifiers']);
const SANDBOX_KEYS = new Set(['enabled', 'engine', 'limits', 'allowWrites', 'resetPolicy']);
const LIMIT_KEYS = new Set(['maxRows', 'timeoutMs', 'maxDbBytes']);
const QUOTA_KEYS = new Set(['student', 'teacher']);
const QUOTA_ENTRY_KEYS = new Set(['concurrentLlmTasks', 'dailyLlmCalls']);
const HOT_RELOAD_KEYS = new Set(['watch', 'debounceMs']);
const STRUCTURED_KEYS = new Set(['jsonSchemaStrict']);

class Ctx {
  readonly issues: string[] = [];
  readonly warnings: string[] = [];

  err(path: string, msg: string): undefined {
    this.issues.push(`${path}: ${msg}`);
    return undefined;
  }

  warn(path: string, msg: string): void {
    this.warnings.push(`${path}: ${msg}`);
  }

  /** 未知键 → 报错（并给出允许的键，省得人去翻 schema） */
  checkKeys(path: string, obj: Record<string, unknown>, allowed: Set<string>): void {
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) {
        this.err(
          `${path}.${k}`,
          `未知字段（允许：${[...allowed].join(', ')}）—— 拼写错误或该字段属于 providers.yaml/.env`
        );
        continue;
      }
      this.guardCredentialKey(`${path}.${k}`, k);
    }
  }

  /** 凭据样子的**键名** → 报错；部署期字段 → 警告（两种情况都会提示该写在哪） */
  private guardCredentialKey(path: string, key: string): void {
    if (isCredentialKey(key)) {
      this.err(
        path,
        'settings.json **禁止放凭据**（密钥/口令只放 .env；provider 与凭据引用放 config/providers.yaml）'
      );
    } else if (DEPLOYMENT_KEY_RE.test(key)) {
      this.warn(path, '该字段属于**部署期**配置，建议放 config/providers.yaml（settings.json 只管运行期选择/策略/配额/开关）');
    }
  }

  /** 值看起来像密钥 → 报错 */
  guardSecretValue(path: string, v: string): void {
    if (SECRET_VALUE_RE.test(v)) {
      this.err(path, '值看起来是密钥（sk-…）—— 凭据只放 .env，settings.json 会被下发/备份/看板读取');
    }
  }

  asObject(path: string, v: unknown): Record<string, unknown> | undefined {
    if (v === undefined) return undefined;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return this.err(path, `应为对象，实际 ${describe(v)}`);
    }
    return v as Record<string, unknown>;
  }

  str(path: string, v: unknown, dflt: string, nonEmpty = true): string {
    if (v === undefined) return dflt;
    if (typeof v !== 'string') return this.err(path, `应为字符串，实际 ${describe(v)}`) ?? dflt;
    if (nonEmpty && v.trim() === '') {
      this.err(path, '不能为空字符串');
      return dflt;
    }
    this.guardSecretValue(path, v);
    return v;
  }

  strOrNull(path: string, v: unknown, dflt: string | null): string | null {
    if (v === undefined) return dflt;
    if (v === null) return null;
    if (typeof v !== 'string') return this.err(path, `应为字符串或 null，实际 ${describe(v)}`) ?? dflt;
    if (v.trim() === '') {
      this.err(path, '不能为空字符串（想表示"未启用"请写 null）');
      return dflt;
    }
    this.guardSecretValue(path, v);
    return v;
  }

  bool(path: string, v: unknown, dflt: boolean): boolean {
    if (v === undefined) return dflt;
    if (typeof v !== 'boolean') return this.err(path, `应为布尔，实际 ${describe(v)}`) ?? dflt;
    return v;
  }

  num(path: string, v: unknown, dflt: number, opts: { min?: number; max?: number } = {}): number {
    if (v === undefined) return dflt;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return this.err(path, `应为有限数字，实际 ${describe(v)}`) ?? dflt;
    }
    if (opts.min !== undefined && v < opts.min) {
      this.err(path, `不能小于 ${opts.min}，实际 ${v}`);
      return dflt;
    }
    if (opts.max !== undefined && v > opts.max) {
      this.err(path, `不能大于 ${opts.max}，实际 ${v}`);
      return dflt;
    }
    return v;
  }

  int(path: string, v: unknown, dflt: number, opts: { min?: number; max?: number } = {}): number {
    if (v === undefined) return dflt;
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      return this.err(path, `应为整数，实际 ${describe(v)}`) ?? dflt;
    }
    return this.num(path, v, dflt, opts);
  }

  enumOf<T extends string>(path: string, v: unknown, allowed: readonly T[], dflt: T): T {
    if (v === undefined) return dflt;
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      this.err(path, `应为 ${allowed.join(' | ')} 之一，实际 ${describe(v)}`);
      return dflt;
    }
    return v as T;
  }

  strArray(path: string, v: unknown, dflt: string[]): string[] {
    if (v === undefined) return dflt;
    if (!Array.isArray(v)) {
      this.err(path, `应为字符串数组，实际 ${describe(v)}`);
      return dflt;
    }
    const out: string[] = [];
    v.forEach((item, i) => {
      if (typeof item !== 'string' || item.trim() === '') {
        this.err(`${path}[${i}]`, `应为非空字符串，实际 ${describe(item)}`);
        return;
      }
      this.guardSecretValue(`${path}[${i}]`, item);
      out.push(item);
    });
    return out;
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'string') return `string(${JSON.stringify(v.length > 24 ? `${v.slice(0, 24)}…` : v)})`;
  if (typeof v === 'object') return 'object';
  return `${typeof v}(${String(v)})`;
}

// ═══════════════════════════════════════════════════════════════════════
// 主校验
// ═══════════════════════════════════════════════════════════════════════

/**
 * 校验原始 JSON → 规范化 `Settings`。
 *
 * @param raw 解析后的 JSON（不是文本）
 * @throws SettingsError 有任何**致命**问题（类型错/未知键/凭据）
 */
export function validateSettings(raw: unknown, opts: { path?: string } = {}): ValidateResult {
  const c = new Ctx();
  const d = defaultSettings();

  const root = c.asObject('$', raw);
  if (!root) throw new SettingsError(c.issues, opts.path);

  c.checkKeys('$', root, ROOT_KEYS);

  if (root.$schema !== undefined && typeof root.$schema !== 'string') {
    c.err('$.$schema', `应为字符串，实际 ${describe(root.$schema)}`);
  }

  const version = c.int('$.version', root.version, d.version, { min: 1 });
  if (root.version !== undefined && version !== 1) {
    c.warn('$.version', `当前实现只认 version=1，读到 ${version}（未知版本字段会被忽略，不会崩）`);
  }

  // ── llm ──
  const llmRaw = c.asObject('$.llm', root.llm) ?? {};
  c.checkKeys('$.llm', llmRaw, LLM_KEYS);
  const structuredRaw = c.asObject('$.llm.structured', llmRaw.structured) ?? {};
  c.checkKeys('$.llm.structured', structuredRaw, STRUCTURED_KEYS);

  const llm: Settings['llm'] = {
    active: c.str('$.llm.active', llmRaw.active, d.llm.active),
    fallbacks: c.strArray('$.llm.fallbacks', llmRaw.fallbacks, d.llm.fallbacks),
    temperature: c.num('$.llm.temperature', llmRaw.temperature, d.llm.temperature, { min: 0, max: 2 }),
    maxTokens: c.int('$.llm.maxTokens', llmRaw.maxTokens, d.llm.maxTokens, { min: 1 }),
    structured: {
      jsonSchemaStrict: c.bool(
        '$.llm.structured.jsonSchemaStrict',
        structuredRaw.jsonSchemaStrict,
        d.llm.structured.jsonSchemaStrict,
      ),
    },
    // ⚠️ 类型上允许任意数字（否则没法"读到 8 再如实上报被钳制"），钳制在下面
    concurrency: c.num('$.llm.concurrency', llmRaw.concurrency, d.llm.concurrency, { min: 0 }),
  };

  // ── 建议性告警（能启动但会静默产坏数据的配置，必须吵）──
  if (llm.maxTokens < MIN_SANE_MAX_TOKENS) {
    c.warn(
      '$.llm.maxTokens',
      `${llm.maxTokens} 偏小：该端点是**推理模型**，推理 token 计入输出预算` +
        `（实测 8 字回复用 54 个 reasoning token）→ 预算被推理吃光时会**静默拿到空 content**；建议 ≥ ${MIN_SANE_MAX_TOKENS}`,
    );
  }
  if (llm.structured.jsonSchemaStrict === false) {
    c.warn(
      '$.llm.structured.jsonSchemaStrict',
      'false 会退化成 json_object 模式 —— 它**不强制 enum/字段**（坑 4 实测：模型输出 "etype":"常用实现"）；结构化抽取建议保持 true',
    );
  }

  // ── asr / tts / translate ──
  const asrRaw = c.asObject('$.asr', root.asr) ?? {};
  c.checkKeys('$.asr', asrRaw, ASR_KEYS);
  const asr: Settings['asr'] = {
    active: c.strOrNull('$.asr.active', asrRaw.active, d.asr.active),
    model: c.str('$.asr.model', asrRaw.model, d.asr.model),
    fallbacks: c.strArray('$.asr.fallbacks', asrRaw.fallbacks, d.asr.fallbacks),
  };

  const ttsRaw = c.asObject('$.tts', root.tts) ?? {};
  c.checkKeys('$.tts', ttsRaw, TTS_KEYS);
  const tts: Settings['tts'] = { active: c.strOrNull('$.tts.active', ttsRaw.active, d.tts.active) };

  const trRaw = c.asObject('$.translate', root.translate) ?? {};
  c.checkKeys('$.translate', trRaw, TRANSLATE_KEYS);
  const translate: Settings['translate'] = {
    active: c.strOrNull('$.translate.active', trRaw.active, d.translate.active),
    glossaryMode: c.enumOf('$.translate.glossaryMode', trRaw.glossaryMode, GLOSSARY_MODES, d.translate.glossaryMode as 'inject' | 'none'),
    keepIdentifiers: c.bool('$.translate.keepIdentifiers', trRaw.keepIdentifiers, d.translate.keepIdentifiers),
  };

  // ── sandbox ──
  const sbRaw = c.asObject('$.sandbox', root.sandbox) ?? {};
  c.checkKeys('$.sandbox', sbRaw, SANDBOX_KEYS);
  const limitsRaw = c.asObject('$.sandbox.limits', sbRaw.limits) ?? {};
  c.checkKeys('$.sandbox.limits', limitsRaw, LIMIT_KEYS);
  const sandbox: Settings['sandbox'] = {
    enabled: c.bool('$.sandbox.enabled', sbRaw.enabled, d.sandbox.enabled),
    engine: c.enumOf('$.sandbox.engine', sbRaw.engine, SANDBOX_ENGINES, d.sandbox.engine as 'sqlite'),
    limits: {
      maxRows: c.int('$.sandbox.limits.maxRows', limitsRaw.maxRows, d.sandbox.limits.maxRows, { min: 1, max: 10000 }),
      timeoutMs: c.int('$.sandbox.limits.timeoutMs', limitsRaw.timeoutMs, d.sandbox.limits.timeoutMs, { min: 100, max: 60000 }),
      maxDbBytes: c.int('$.sandbox.limits.maxDbBytes', limitsRaw.maxDbBytes, d.sandbox.limits.maxDbBytes, { min: 1024 }),
    },
    allowWrites: c.bool('$.sandbox.allowWrites', sbRaw.allowWrites, d.sandbox.allowWrites),
    resetPolicy: c.enumOf('$.sandbox.resetPolicy', sbRaw.resetPolicy, RESET_POLICIES, d.sandbox.resetPolicy as 'per_session'),
  };

  // ── quota ──
  const qRaw = c.asObject('$.quota', root.quota) ?? {};
  c.checkKeys('$.quota', qRaw, QUOTA_KEYS);
  const quotaOf = (name: 'student' | 'teacher'): Settings['quota']['student'] => {
    const sub = c.asObject(`$.quota.${name}`, qRaw[name]) ?? {};
    c.checkKeys(`$.quota.${name}`, sub, QUOTA_ENTRY_KEYS);
    return {
      concurrentLlmTasks: c.int(`$.quota.${name}.concurrentLlmTasks`, sub.concurrentLlmTasks, d.quota[name].concurrentLlmTasks, { min: 1 }),
      dailyLlmCalls: c.int(`$.quota.${name}.dailyLlmCalls`, sub.dailyLlmCalls, d.quota[name].dailyLlmCalls, { min: 0 }),
    };
  };
  const quota: Settings['quota'] = { student: quotaOf('student'), teacher: quotaOf('teacher') };

  // ── hotReload ──
  const hrRaw = c.asObject('$.hotReload', root.hotReload) ?? {};
  c.checkKeys('$.hotReload', hrRaw, HOT_RELOAD_KEYS);
  const hotReload: Settings['hotReload'] = {
    watch: c.bool('$.hotReload.watch', hrRaw.watch, d.hotReload.watch),
    debounceMs: c.int('$.hotReload.debounceMs', hrRaw.debounceMs, d.hotReload.debounceMs, { min: 50, max: 5000 }),
  };

  if (c.issues.length > 0) throw new SettingsError(c.issues, opts.path);

  const candidate: Settings = { version, llm, asr, tts, translate, sandbox, quota, hotReload };
  // ⚠️ `$schema` **不进** `Settings` 类型（它只是给编辑器看的提示；backend-api 的 `Settings`
  //    里没有这个字段，塞进去会 `TS2339`）。校验时允许它出现，但不回填到类型对象里。

  // ★ 钳制（并发=1 的用户硬要求；**忽略调高但如实上报**）
  const { settings: clampedResult, clamped } = clampConcurrency(candidate);
  for (const note of clamped) {
    c.warnings.push(`${note.path}: 请求 ${String(note.requested)} → 实际 ${note.applied}（${note.reason}）`);
  }

  return { settings: clampedResult, warnings: c.warnings, ignored: clamped };
}

/** 脱敏：凭据样子的键一律替换成遮罩（防御性 —— 正常路径进不来）。 */
export function redactSettings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactSettings(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // ⚠️ 用 `isCredentialKey`（带豁免名单）而不是裸正则：
      //    否则 `maxTokens` 会被打成 `<redacted>`，前端看到的配额就是假的。
      if (isCredentialKey(k)) out[k] = '<redacted>';
      else out[k] = redactSettings(v);
    }
    return out;
  }
  if (typeof value === 'string' && SECRET_VALUE_RE.test(value)) return '<redacted>';
  return value;
}
