/**
 * 配置加载（`src/config.ts`）—— T-BACKEND 独占。
 *
 * 契约依据：
 *  - `docs/ARCHITECTURE_V2.md` §4.3 `config/providers.yaml`（凭据走 `${ENV}` 占位）
 *  - `docs/PROVIDERS.md` §8 凭据管理：**凭据只从环境变量读**、`/capabilities` 不回显、日志走 `redact()`
 *
 * ⚠️ 三条铁律（PROVIDERS §0）在配置层的落点：
 *  - R1 `configured` ≠ `available`：本文件只负责 **configured**（凭据齐备）；
 *    `available` 必须由 provider 的 `healthCheck()` 真探测得出，**不在配置层假装**。
 *  - 因此 `missingEnv.length === 0` ⟺ `configured === true`，语义单一、可被测试断言。
 *
 * ⚠️ 安全：`ProviderConfigEntry.options` **含明文凭据**。禁止写日志、禁止进 `/capabilities`、
 *    禁止序列化外发；日志一律先过 `redact()`。
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { parse as parseYaml } from 'yaml';

// ═══════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════

export const PROVIDER_KINDS = ['llm', 'asr', 'tts', 'translate', 'ocr', 'embedding'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const POLICIES = ['local-first', 'cloud-first', 'cost', 'quality', 'explicit'] as const;
export type Policy = (typeof POLICIES)[number];

/** 未配置 policy 时的默认值（与 ARCHITECTURE_V2 §4.3 示例一致）。 */
const DEFAULT_POLICY: Record<ProviderKind, Policy> = {
  /**
   * ⚠️ LLM 的默认**不能**是 `explicit`：registry 在 `policy='explicit'` 时必须拿到
   * `explicitId`，而 provider 门面的 `completeJson(req)` 不带 id →
   * 实测会抛 `policy='explicit' 但未提供 explicitId`，抽取**静默产出 0 张卡片**。
   * `quality` 在"只有一个 LLM provider"时按注册顺序选中它，语义也说得通（质量优先）。
   * 想固定某个模型，请在 `config/providers.yaml` 里改成 `explicit` 并让调用方传 id。
   */
  llm: 'quality',
  asr: 'local-first',
  tts: 'cloud-first',
  translate: 'cloud-first',
  ocr: 'local-first',
  embedding: 'local-first',
};

export interface ProviderConfigEntry {
  id: string;
  kind: ProviderKind;
  /** 实现类型，如 `openai_compatible` / `local_worker` / `aliyun_nls`（见 PROVIDERS §2.1）。 */
  type: string;
  priority: number;
  enabled: boolean;
  /**
   * ⚠️ **含明文凭据**（`${ENV}` 已解析为真实值）。禁止写日志 / 下发前端 / 进 capabilities。
   * 键名与 yaml 一致（`base_url` / `api_key` / `model` …），另见 `llmCredentials()` 的规范化读取。
   */
  options: Record<string, unknown>;
  /** 声明了 `${X}` 但环境变量缺失的变量名（去重保序）→ `configured = missingEnv.length === 0`。 */
  missingEnv: string[];
  /** yaml 字段名 → 环境变量名（供 reason 里如实报「缺哪个变量」）。 */
  envRefs: Record<string, string>;
}

export interface ProviderConfig {
  policy: Record<ProviderKind, Policy>;
  providers: Record<ProviderKind, ProviderConfigEntry[]>;
  /** 实际读到的配置文件路径；null = 文件不存在（此时 providers 全空）。 */
  sourcePath: string | null;
  /** 非致命问题（未知 kind、重复 id、非法 policy 等），如实上报不隐藏。 */
  warnings: string[];
}

/** T-AGENT / T-PROVIDERS 需要的 LLM 凭据（`base_url`/`api_key`/`model` 的规范化视图）。 */
export interface LlmCredentials {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 该条 provider 是否凭据齐备（≠ 可用）。 */
  configured: boolean;
  missingEnv: string[];
}

/** RBAC 认证配置（docs/RBAC.md §7）。 */
export interface AuthConfig {
  /** 会话有效期（默认 7 天） */
  sessionTtlMs: number;
  /** 生产 HTTPS 才开；本机 HTTP 开了浏览器不回传 cookie（登录不上） */
  cookieSecure: boolean;
  /** 登录失败限流：窗口内最多几次 */
  maxLoginFailures: number;
  loginWindowMs: number;
  /**
   * `COURSE_KB_BOOTSTRAP_ADMIN=用户名:初始口令`
   * ⚠️ **仅当库里一个用户都没有时生效**（避免重复启动时把口令重置成环境变量里的值）。
   */
  bootstrapAdmin: { username: string; password: string } | null;
}

export interface ServerConfig {
  root: string;
  host: string;
  port: number;
  dataDir: string;
  uploadsDir: string;
  artifactsDir: string;
  tmpDir: string;
  checkpointsDir: string;
  dbPath: string;
  maxUploadBytes: number;
  /** Python 解释器（worker 调用器用），`PYTHON_BIN` 可覆盖。 */
  pythonBin: string;
  /** `python -m <workerModule>` 的模块名。 */
  workerModule: string;
  workerTimeoutMs: number;
  /** SSE keepalive 间隔（契约 §6：15s）。 */
  sseKeepaliveMs: number;
  /** 任务队列并发（契约 C1：LLM 并发=1；worker 串行执行）。 */
  taskConcurrency: number;
  /**
   * ★ 运行日志落盘（用户明确要求；缺口：原来 `index.ts` 里 `logger: false`，日志只进终端）。
   *
   * - `dir`：日志目录（`COURSE_KB_LOG_DIR`，默认 `<root>/data/logs`）
   * - `level`：级别（`COURSE_KB_LOG_LEVEL`，默认 `info`；非法值回落 info 并告警）
   * - 轮转：按天命名 + 单文件上限 + 保留天数
   */
  logging: {
    dir: string;
    level: string;
    maxBytes: number;
    retentionDays: number;
  };
  /** RBAC：认证与登录限流（docs/RBAC.md §7） */
  auth: AuthConfig;
  llm: LlmCredentials | null;
  providers: ProviderConfig;
  env: Record<string, string>;
}

// ═══════════════════════════════════════════════════════════════════════
// 基础工具
// ═══════════════════════════════════════════════════════════════════════

/** 极简 `.env` 解析（不引依赖）：`KEY=VALUE`、`#` 注释、可选单双引号；已有环境变量优先（不被覆盖）。 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * 找 course-kb 根目录：优先 `COURSE_KB_ROOT`，否则从 `from` 向上找带 `docs/API_PROTOCOL.md` 的目录。
 * 用**契约文件**做锚点（而不是 `.env`，它可能缺失），保证任何子目录启动都能定位。
 */
export function findRoot(from?: string, env: Record<string, string> = process.env as Record<string, string>): string {
  if (env.COURSE_KB_ROOT && fs.existsSync(env.COURSE_KB_ROOT)) return path.resolve(env.COURSE_KB_ROOT);
  let dir = path.resolve(from ?? path.dirname(url.fileURLToPath(import.meta.url)));
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'docs', 'API_PROTOCOL.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(from ?? process.cwd());
}

const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

interface ResolveResult {
  value: unknown;
  missing: string[];
  refs: Record<string, string>;
}

/**
 * 递归解析 `${ENV}` 占位符。
 * - `${X}` 且 X 缺失 → **不抛错**，值置为 `''` 并把 X 记进 `missing`（→ `configured:false` + 可读 reason）
 * - 未含 `${}` 的字面量按原样返回（本地模型路径、数字等）
 */
export function resolveEnvRefs(node: unknown, env: Record<string, string | undefined>): ResolveResult {
  const missing: string[] = [];
  const refs: Record<string, string> = {};

  const walk = (n: unknown, field: string): unknown => {
    if (typeof n === 'string') {
      // 整串就是一个占位符 → 保留非字符串原始类型不做转换（值仍是字符串）
      const single = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(n);
      if (single) {
        const name = single[1] as string;
        refs[field] = name;
        const v = env[name];
        if (v === undefined || v === '') {
          if (!missing.includes(name)) missing.push(name);
          return '';
        }
        return v;
      }
      const replaced = n.replace(ENV_REF_RE, (m, name: string) => {
        refs[field] = name;
        const v = env[name];
        if (v === undefined || v === '') {
          if (!missing.includes(name)) missing.push(name);
          return '';
        }
        return v;
      });
      return replaced;
    }
    if (Array.isArray(n)) return n.map((x: unknown) => walk(x, field));
    if (n && typeof n === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) out[k] = walk(v, k);
      return out;
    }
    return n;
  };

  return { value: walk(node, ''), missing, refs };
}

/**
 * 日志脱敏：把所有「长度 ≥ 8 的环境变量值」替换为 `<redacted:NAME>`。
 * 凭据一律不得落日志（PROVIDERS §8）。
 */
export function redact(text: string, env: Record<string, string | undefined> = process.env): string {
  if (!text) return text;
  let out = text;
  for (const [k, v] of Object.entries(env)) {
    if (!v || v.length < 8) continue;
    if (!/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_SK\b|AK\b)/i.test(k)) continue;
    out = out.split(v).join(`<redacted:${k}>`);
  }
  return out;
}

/** 判断某环境变量是否被声明过（用于 `configured` 归因，不回显值）。 */
function envPresent(env: Record<string, string | undefined>, name: string): boolean {
  const v = env[name];
  return v !== undefined && v !== '';
}

// ═══════════════════════════════════════════════════════════════════════
// provider 配置
// ═══════════════════════════════════════════════════════════════════════

export interface LoadProviderOptions {
  env?: Record<string, string | undefined>;
  /** course-kb 根目录；默认自动探测。 */
  root?: string;
  /** 覆盖配置文件路径（绝对路径）；默认 `<root>/config/providers.yaml`。 */
  file?: string;
}

/**
 * 读取 `config/providers.yaml` → 规范化 `ProviderConfig`。
 *
 * **签名已与 Lead / T-PROVIDERS 约定，勿改**（改了要通知 lead 与 wiki-architect）。
 *
 * 行为约定：
 * 1. 文件不存在 → `sourcePath: null`、各 kind 空数组 + warning，**不抛错**（M0 空壳也要能起）
 * 2. yaml 语法错误 → `warnings` 里如实记，返回空配置（服务不因此挂掉）
 * 3. `configured` 由 `missingEnv.length === 0` 推出 —— **只代表凭据齐备，不代表可用**（R1）
 * 4. 未知 `type` 不在这里拒绝（provider 注册表才有权判定），只在必要时给 warning
 */
export function loadProviderConfig(opts: LoadProviderOptions = {}): ProviderConfig {
  const env = (opts.env ?? process.env) as Record<string, string | undefined>;
  const root = opts.root ?? findRoot(undefined, env as Record<string, string>);
  const file = opts.file ?? path.join(root, 'config', 'providers.yaml');

  // 显式初始化（不用 Object.fromEntries + 断言：断言会掩盖"漏了一个 kind"）
  const providers: Record<ProviderKind, ProviderConfigEntry[]> = {
    llm: [],
    asr: [],
    tts: [],
    translate: [],
    ocr: [],
    embedding: [],
  };
  const policy: Record<ProviderKind, Policy> = { ...DEFAULT_POLICY };
  const warnings: string[] = [];

  let rawText: string;
  try {
    rawText = fs.readFileSync(file, 'utf8');
  } catch {
    warnings.push(`provider 配置文件不存在：${file}（providers 将全部上报 configured:false）`);
    return { policy, providers, sourcePath: null, warnings };
  }

  let doc: unknown;
  try {
    doc = parseYaml(rawText);
  } catch (err) {
    warnings.push(`provider 配置文件解析失败：${redact(String(err), env)}`);
    return { policy, providers, sourcePath: file, warnings };
  }

  const obj = (doc ?? {}) as Record<string, unknown>;

  // ── policy ──
  const rawPolicy = (obj.policy ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(rawPolicy)) {
    if (!(PROVIDER_KINDS as readonly string[]).includes(k)) {
      warnings.push(`policy 里有未知 kind：${k}`);
      continue;
    }
    if (typeof v !== 'string' || !(POLICIES as readonly string[]).includes(v)) {
      warnings.push(`policy.${k} 非法：${JSON.stringify(v)}（允许 ${POLICIES.join('|')}）`);
      continue;
    }
    policy[k as ProviderKind] = v as Policy;
  }

  // ── providers ──
  const rawProviders = (obj.providers ?? {}) as Record<string, unknown>;
  for (const [kind, list] of Object.entries(rawProviders)) {
    if (!(PROVIDER_KINDS as readonly string[]).includes(kind)) {
      warnings.push(`providers 里有未知 kind：${kind}（已忽略）`);
      continue;
    }
    if (!Array.isArray(list)) {
      warnings.push(`providers.${kind} 不是列表（已忽略）`);
      continue;
    }
    const seen = new Set<string>();
    list.forEach((item, idx) => {
      if (!item || typeof item !== 'object') {
        warnings.push(`providers.${kind}[${idx}] 不是对象（已忽略）`);
        return;
      }
      const entryRaw = item as Record<string, unknown>;
      const id = typeof entryRaw.id === 'string' && entryRaw.id ? entryRaw.id : '';
      if (!id) {
        warnings.push(`providers.${kind}[${idx}] 缺 id（已忽略）`);
        return;
      }
      if (seen.has(id)) {
        warnings.push(`providers.${kind} 里 id 重复：${id}（后者忽略）`);
        return;
      }
      seen.add(id);

      const { value, missing, refs } = resolveEnvRefs(entryRaw, env);
      const resolved = value as Record<string, unknown>;
      const type = typeof resolved.type === 'string' ? resolved.type : '';
      if (!type) warnings.push(`provider ${kind}/${id} 缺 type`);

      // 未用 `${}` 但按约定需要的隐式凭据：以 `*_env` 形式声明（可读 reason 用）
      const priorityRaw = resolved.priority;
      const priority = typeof priorityRaw === 'number' ? priorityRaw : Number(priorityRaw) || 0;
      const enabled = resolved.enabled === undefined ? true : resolved.enabled !== false;

      providers[kind as ProviderKind].push({
        id,
        kind: kind as ProviderKind,
        type,
        priority,
        enabled,
        options: resolved,
        missingEnv: missing,
        envRefs: refs,
      });
    });
    providers[kind as ProviderKind].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  return { policy, providers, sourcePath: file, warnings };
}

/** 取某 kind 下第一个「启用」的 provider（按 priority 升序，已排序）。 */
export function firstOfKind(cfg: ProviderConfig, kind: ProviderKind): ProviderConfigEntry | undefined {
  return cfg.providers[kind]?.find((p) => p.enabled);
}

/** 按 id 取 provider。 */
export function getProvider(cfg: ProviderConfig, kind: ProviderKind, id: string): ProviderConfigEntry | undefined {
  return cfg.providers[kind]?.find((p) => p.id === id);
}

/**
 * 规范化读取 LLM 凭据（`base_url` / `api_key` / `model`），供 T-AGENT 的模型真探测与 T-PROVIDERS 复用。
 *
 * 为什么提供它：yaml 里字段名是 snake_case（契约 §4.3），而调用方（pi SDK / OpenAI 客户端）
 * 需要 camelCase；把映射放在**配置层**统一做，避免每个调用方各猜一份。
 *
 * 返回 `null` = 没有启用中的 LLM provider（调用方须**如实降级**，不许假装可用）。
 */
export function llmCredentials(cfg: ProviderConfig): LlmCredentials | null {
  const entry = firstOfKind(cfg, 'llm');
  if (!entry) return null;
  const o = entry.options;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v) return v;
      if (typeof v === 'number') return String(v);
    }
    return '';
  };
  return {
    providerId: entry.id,
    baseUrl: pick('base_url', 'baseUrl'),
    apiKey: pick('api_key', 'apiKey'),
    model: pick('model'),
    configured: entry.missingEnv.length === 0,
    missingEnv: [...entry.missingEnv],
  };
}

/** 环境变量是否齐备（供 reason 文案：`缺少 AMR_KEY`）。 */
export function missingEnvReason(entry: ProviderConfigEntry): string | null {
  if (entry.missingEnv.length === 0) return null;
  return `缺少环境变量 ${entry.missingEnv.join(' / ')}（在 config/providers.yaml 里用 \${NAME} 占位，值放 .env）`;
}

// ═══════════════════════════════════════════════════════════════════════
// 服务配置
// ═══════════════════════════════════════════════════════════════════════

function envInt(env: Record<string, string | undefined>, name: string, dflt: number): number {
  const raw = env[name];
  if (!raw) return dflt;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * 加载服务配置：`.env`（不覆盖已存在的真实环境变量）→ `providers.yaml`。
 *
 * 注意：`.env` 只补**未设置**的变量 —— 用户显式 `set AMR_KEY=...` 时应优先，
 * 避免测试/CI 被文件里旧值污染。
 *
 * ⚠️ 原错误写法：函数签名收了 `opts.env` 却**从未使用**（只读 `process.env`），
 * 于是测试传 `COURSE_KB_DB=<临时库>` 根本无效，**测试会写进开发用的真库**
 * （表现为断言里的 documents 计数莫名累积）。现已按 `opts.env` 优先合并。
 */
export function loadConfig(opts: { root?: string; env?: Record<string, string | undefined> } = {}): ServerConfig {
  const root = opts.root ?? findRoot();
  // opts.env 优先（测试/嵌入方显式指定），否则用进程环境
  const baseEnv: Record<string, string | undefined> = {
    ...(process.env as Record<string, string | undefined>),
    ...(opts.env ?? {}),
  };

  const dotEnvPath = path.join(root, '.env');
  const fromFile = fs.existsSync(dotEnvPath) ? parseDotEnv(fs.readFileSync(dotEnvPath, 'utf8')) : {};
  // 文件值只补空缺：显式环境变量（含 opts.env）优先
  const env: Record<string, string | undefined> = { ...fromFile, ...baseEnv };

  const dataDir = path.resolve(root, env.COURSE_KB_DATA_DIR || path.join('data'));
  const providers = loadProviderConfig({ root, env });

  return {
    root,
    host: env.COURSE_KB_HOST || '127.0.0.1',
    port: envInt(env, 'COURSE_KB_PORT', 8787),
    dataDir,
    uploadsDir: path.join(dataDir, 'uploads'),
    artifactsDir: path.join(dataDir, 'artifacts'),
    tmpDir: path.join(dataDir, 'tmp'),
    checkpointsDir: path.join(dataDir, 'checkpoints'),
    dbPath: env.COURSE_KB_DB || path.join(dataDir, 'course_kb.sqlite3'),
    maxUploadBytes: envInt(env, 'COURSE_KB_MAX_UPLOAD', 512 * 1024 * 1024),
    pythonBin: env.PYTHON_BIN || 'python',
    workerModule: env.WORKER_MODULE || 'worker.cli',
    workerTimeoutMs: envInt(env, 'WORKER_TIMEOUT_MS', 4 * 60 * 60 * 1000),
    sseKeepaliveMs: envInt(env, 'SSE_KEEPALIVE_MS', 15_000),
    taskConcurrency: envInt(env, 'TASK_CONCURRENCY', 1),
    // ★ 日志：**env 必须真的被读**（坑 24：别做死旋钮）—— 判据是"设了 debug 就真有 debug 行"
    logging: {
      dir: env.COURSE_KB_LOG_DIR ? path.resolve(env.COURSE_KB_LOG_DIR) : path.join(dataDir, 'logs'),
      level: (env.COURSE_KB_LOG_LEVEL || 'info').trim().toLowerCase(),
      maxBytes: envInt(env, 'COURSE_KB_LOG_MAX_BYTES', 50 * 1024 * 1024),
      retentionDays: envInt(env, 'COURSE_KB_LOG_RETENTION_DAYS', 14),
    },
    auth: {
      sessionTtlMs: envInt(env, 'SESSION_TTL_MS', 7 * 24 * 60 * 60 * 1000),
      // 默认 false：本机 HTTP 下开 Secure 会让 cookie 发不出去（表现为"登录成功但立刻又是未登录"）
      cookieSecure: env.COOKIE_SECURE === '1' || env.COOKIE_SECURE === 'true',
      maxLoginFailures: envInt(env, 'LOGIN_MAX_FAILURES', 5),
      loginWindowMs: envInt(env, 'LOGIN_WINDOW_MS', 15 * 60 * 1000),
      bootstrapAdmin: parseBootstrapAdmin(env.COURSE_KB_BOOTSTRAP_ADMIN),
    },
    llm: llmCredentials(providers),
    providers,
    env: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>,
  };
}

/** 物化结果（`models.json` + `auth.json` 已写盘 → pi 能用**项目配置的模型与凭据**）。 */
export interface PiModelsMaterialization {
  /** pi 的 agent 目录（传给 `AgentSessionManager({ agentDir })` → 它会用 `<dir>/auth.json` 与 `<dir>/models.json`） */
  agentDir: string;
  /** pi 格式的 `models.json` 路径 */
  modelsPath: string;
  /** `provider/model` 引用（pi 的 `getModel(provider, model)` 用） */
  modelRef: string;
  providerId: string;
  modelId: string;
  /** 本次是否真的写了盘（内容没变就不写，避免无谓 IO / 触发监听风暴） */
  wrote: boolean;
}

/**
 * 从 `providers.yaml` + `.env` 物化一个 **pi 格式的 `models.json`**。
 *
 * ## 为什么必须做（pi-bridge 实测 + polysemy-prober 的 critical 验收）
 * `createAgentSession` 不传模型时，pi 用它**自己的全局默认**
 * （`~/.pi/agent/settings.json`，实测是 `opencode-go/glm-5.2`，key 已 401）→
 * 学生发问后 **180s 零帧**（模型根本没被喂给 pi）。而项目配置是 `amr/deepseek-v4.1-flash`。
 * pi 的 `ModelRuntime.create({})` 在默认目录下**可见 provider 数 = 0** → 必然回落；
 * 只有给一个 `modelsPath` 指向项目自己的 `models.json`，`getModel('amr', …)` 才能命中。
 *
 * ## 为什么写在 `data/` 而不是 `config/`
 * `models.json` 必须内嵌 **apiKey**（pi 的形状如此）。所以：
 * - 写到 `cfg.dataDir/pi-agent/`（`data/` 已被 `.gitignore` 覆盖，不会误提交）
 * - 权限尽力设 `0600`（Windows 上是 no-op，但语义正确）
 * - **绝不写进 `config/**` 或 `.env`**，也不回显 key（日志只说路径与 provider/model）
 */
export function materializePiModels(cfg: ServerConfig): PiModelsMaterialization | null {
  const llm = cfg.llm;
  if (!llm || !llm.configured || !llm.apiKey || !llm.baseUrl || !llm.model) return null;
  const dir = path.join(cfg.dataDir, 'pi-agent');
  const modelsPath = path.join(dir, 'models.json');
  const authPath = path.join(dir, 'auth.json');
  const modelsPayload = {
    // pi 的形状（实测可用）：providers.<id>.{baseUrl, api, apiKey, models[]}
    providers: {
      [llm.providerId]: {
        baseUrl: llm.baseUrl,
        api: 'openai-completions',
        apiKey: llm.apiKey,
        models: [{ id: llm.model }],
      },
    },
  };
  /**
   * ★ `auth.json` —— **pi 的凭据来源，与 `models.json` 是两件事**。
   *
   * 实测（`data/tmp/probe_auth_shape.mjs` 四种候选形状对照）：
   * ```
   * 只有 models.json（含 apiKey），无 auth.json → ❌ "No API key found for amr"（8ms 就报错）
   * auth.json = {"<id>":{"type":"api_key","key":"…"}}        → ❌ 形状不对：**静默挂死**（25s 无帧，即 E_PI_TIMEOUT）
   * auth.json = {"<id>":{"type":"api_key","apiKey":"…"}}     → ❌ "No API key found for amr"
   * auth.json = {"<id>":"<key>"}                            → ⚠️ 不报错但零内容
   * auth.json = {"providers":{"<id>":{"type":"api_key","key":"…"}}} → ✅ 正常回答（70 个 delta）
   * ```
   * 即"180s 零帧"的静默挂死，正是**形状不对的 auth.json**（不是缺 key 那种快速报错）——
   * 所以这里必须写对形状，否则症状是"什么都不发生"，极难查。
   */
  const authPayload = {
    providers: { [llm.providerId]: { type: 'api_key', key: llm.apiKey } },
  };
  let wrote = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, payload] of [
      [modelsPath, modelsPayload],
      [authPath, authPayload],
    ] as const) {
      const text = `${JSON.stringify(payload, null, 2)}\n`;
      const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (prev !== text) {
        fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
        wrote = true;
      }
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* Windows 上通常是 no-op */
      }
    }
  } catch (err) {
    // 物化失败 → 如实返回 null（agent 会回落 pi 全局并在 ready 帧给出 warning），不假装成功
    process.stderr.write(
      `[agent] pi 凭据/模型目录物化失败（${err instanceof Error ? err.message : String(err)}）→ 将回落 pi 全局默认\n`,
    );
    return null;
  }
  return {
    agentDir: dir,
    modelsPath,
    modelRef: `${llm.providerId}/${llm.model}`,
    providerId: llm.providerId,
    modelId: llm.model,
    wrote,
  };
}

/** 解析 `COURSE_KB_BOOTSTRAP_ADMIN=用户名:初始口令`（**不回显口令**）。 */export function parseBootstrapAdmin(raw: string | undefined): { username: string; password: string } | null {
  if (!raw) return null;
  // 只按**第一个**冒号切：口令里允许有冒号
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const username = raw.slice(0, idx).trim();
  const password = raw.slice(idx + 1);
  if (!username || !password) return null;
  return { username, password };
}

/** 目录就位（data/uploads/artifacts/tmp/checkpoints）。 */
export function ensureDirs(cfg: ServerConfig): void {  for (const d of [cfg.dataDir, cfg.uploadsDir, cfg.artifactsDir, cfg.tmpDir, cfg.checkpointsDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** 测试辅助：某变量是否真实存在（不暴露值）。 */
export { envPresent };
