/**
 * Provider 层统一类型 —— ASR / TTS / 翻译 / LLM / OCR / Embedding
 *
 * 设计规格：[`docs/PROVIDERS.md`](../../../docs/PROVIDERS.md)
 *
 * ## 三条铁律（做错就是方向错）
 *  - **R1** `configured`（有凭据）与 `available`（真能用）**必须分开报**
 *  - **R2** 降级链**每一跳都真探测**（`healthCheck`），只看配置会给**假绿**
 *  - **R3** 全链失败 → **如实报错 + 可读 `reason`，绝不假装成功**
 *
 * ⚠️ **背景**：用户明确要求「模型相关的部分大概率调用大厂 API」，
 * 所以所有能力都做成可插拔：本地 / 云端一键切换，配置驱动。
 */

// ─────────────────────────────────────────────────────────────
// 基础枚举
// ─────────────────────────────────────────────────────────────

export type ProviderKind = 'llm' | 'asr' | 'tts' | 'translate' | 'ocr' | 'embedding';

export const PROVIDER_KINDS: readonly ProviderKind[] = [
  'llm', 'asr', 'tts', 'translate', 'ocr', 'embedding',
] as const;

/** 选择策略：决定降级链的顺序 */
export type Policy = 'local-first' | 'cloud-first' | 'cost' | 'quality' | 'explicit';

export type Runtime = 'local' | 'cloud';

// ─────────────────────────────────────────────────────────────
// ProviderInfo —— ⚠️ `configured` 与 `available` 分开是铁律 R1
// ─────────────────────────────────────────────────────────────

export interface Pricing {
  unit: string;          // 'hour' | '1k_chars' | '1k_tokens' | 'call'
  amount: number;
  currency: string;      // 'CNY' | 'USD'
  note?: string;
}

export interface Limits {
  maxSizeBytes?: number;
  maxDurationSec?: number;
  maxCharsPerRequest?: number;
  rpm?: number;
  concurrency?: number;
}

export interface ProviderInfo {
  id: string;
  kind: ProviderKind;
  /** 中文显示名（给 UI 用） */
  label: string;
  /** '阿里云' | '本地' | 'OpenAI' | '腾讯云' … */
  vendor: string;
  runtime: Runtime;
  /**
   * **凭据是否齐备**。只看配置，不做网络探测。
   * 依据：`ProviderConfigEntry.missingEnv.length === 0`
   */
  configured: boolean;
  /**
   * ★ **真探测结果**（`healthCheck()` 通过）。与 `configured` **独立**。
   * 典型场景：`configured=true, available=false`（欠费 / 被墙 / 模型下线）。
   */
  available: boolean;
  /**
   * 不可用时**必须**给可读原因。要求：说清「缺什么 / 为什么 / 怎么办」。
   * 例：`缺少 ALIYUN_AK / ALIYUN_SK（在 .env 配置）`
   */
  reason?: string;
  /** 能力声明。**不支持就不要写 true**（别硬凑）。 */
  capabilities: Record<string, unknown>;
  pricing?: Pricing;
  limits?: Limits;
}

// ─────────────────────────────────────────────────────────────
// 健康探测
// ─────────────────────────────────────────────────────────────

export interface HealthResult {
  ok: boolean;
  reason?: string;
  /** 耗时（毫秒），便于诊断"慢但能用" */
  latencyMs?: number;
  /** 探测方式说明（写日志/排障用） */
  probe?: string;
}

export interface Provider {
  readonly info: ProviderInfo;
  /** ★ 必须**真发一次最小请求**，不能只看配置（铁律 R2） */
  healthCheck(signal?: AbortSignal): Promise<HealthResult>;
}

// ─────────────────────────────────────────────────────────────
// 各 kind 的请求 / 响应
// ─────────────────────────────────────────────────────────────

/** 统一的时间轴单位是**毫秒**（全项目一致，见契约 §2.2） */
export interface AsrWord {
  w: string;
  startMs: number;
  endMs: number;
}

export interface AsrSegment {
  i: number;
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
  /** 字级时间戳。**不是所有 provider 都有** → 用它之前先查 capabilities */
  words?: AsrWord[];
}

export interface AsrRequest {
  /** 音频文件路径（本地）或 URL（云端） */
  audioPath: string;
  /** 16k mono PCM WAV 的时长，用于成本估算与进度 */
  durationMs?: number;
  language?: string;
  /** 是否**需要**字级时间戳。为 true 时，没有该能力的 provider 会被跳过（而非降级产出残缺数据） */
  requireWordTimestamps?: boolean;
  signal?: AbortSignal;
}

export interface AsrResult {
  segments: AsrSegment[];
  language: string;
  durationMs: number;
  /** 实际使用的 provider id */
  usedProvider: string;
  /** 若发生过降级，这里是从哪个开始的 */
  degradedFrom?: string;
  degradedReason?: string;
}

export interface TtsRequest {
  text: string;
  /** 统一音色名；各 provider 内部映射到自己的参数名 */
  voice?: string;
  /** -100..100（百分比），各 provider 内部换算 */
  rate?: number;
  pitch?: number;
  format?: 'mp3' | 'wav' | 'pcm';
  signal?: AbortSignal;
}

export interface TtsResult {
  /** 产出文件路径（服务端），前端经 /api/v1 取 */
  filePath: string;
  format: string;
  durationMs?: number;
  usedProvider: string;
  degradedFrom?: string;
  degradedReason?: string;
  /** 长文本分段后每段的时间轴（用于配音音画同步） */
  chunks?: { index: number; text: string; startMs: number; endMs: number }[];
}

export interface TranslateRequest {
  /** 待译条目。本项目**逐条**译（实体名 / 证据句），不整篇译。 */
  items: { id: string; text: string; kind?: 'term' | 'evidence' | 'prose' }[];
  from?: string;
  to: string;
  /**
   * ★ **术语表必须注入**（本项目领域要求，见 docs/PROVIDERS.md §4.2）。
   * 不注入会把 `index` 译成"指标"、`view` 译成"看法"。
   */
  glossary?: Record<string, string>;
  /**
   * 保留英文的标识符（`InnoDB`/`SELECT`/`sql_mode`…）。
   * ★ 译了就**无法检索** —— 这是数据库领域的正确行为，不是偷懒。
   */
  keepAsIs?: string[];
  signal?: AbortSignal;
}

export interface TranslateResult {
  items: { id: string; text: string; keptAsIs?: boolean }[];
  usedProvider: string;
  degradedFrom?: string;
  degradedReason?: string;
}

export interface OcrRequest {
  imagePath: string;
  language?: string;
  signal?: AbortSignal;
}

export interface OcrResult {
  text: string;
  blocks?: { text: string; box?: [number, number, number, number]; confidence?: number }[];
  usedProvider: string;
  degradedFrom?: string;
  degradedReason?: string;
}

// ─────────────────────────────────────────────────────────────
// 结构化输出（LLM）—— ⚠️ 必须 json_schema + strict，见坑 4
// ─────────────────────────────────────────────────────────────

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmJsonSchemaRequest {
  messages: LlmMessage[];
  /**
   * ★ **必须用 json_schema + strict**（坑 4：
   * `json_object` 模式**不强制 enum**，实测模型输出过 `"etype":"常用实现"`）。
   */
  schema: { name: string; schema: Record<string, unknown> };
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * ★ **优先级车道**（Lead 裁定的"最小形态公平性"）：
   * `'interactive'` = **人在等**（会话命名/答疑）→ 插到批量前面；
   * `'batch'`（默认）= 后台批量（抽取/OCR/翻译）→ 兜底。
   * ⚠️ 缺省即 `'batch'` ⟹ 既有调用方**行为不变**（同优先级仍 FIFO）。
   */
  priority?: 'interactive' | 'batch';
}

export interface LlmJsonSchemaResult<T = unknown> {
  data: T;
  raw: string;
  usedProvider: string;
  degradedFrom?: string;
  degradedReason?: string;
  /**
   * ★ 这一份产物是用哪种结构化输出模式拿到的（**实测**，不是声明）：
   * `'strict'` = 端点接受了严格 schema（`required` + `additionalProperties:false`）；
   * `'lenient'` = 端点拒绝严格 schema，已回落裸 schema（`strict:true` 不被强制）。
   * ⟹ 上游应把它写进 `meta.structured_output_mode`，让"网关恢复/退化"**可观测**。
   */
  structuredOutputMode?: 'strict' | 'lenient';
  usage?: { promptTokens: number; completionTokens: number };
}

/** 降级来源信息 —— 每次调用都要能说清"我原本想用谁、为什么没用上" */
export interface DegradeInfo {
  degradedFrom?: string;
  degradedReason?: string;
}

// ─────────────────────────────────────────────────────────────
// 错误
// ─────────────────────────────────────────────────────────────

export type ProviderErrorCode =
  | 'E_NOT_CONFIGURED'   // 凭据缺失
  | 'E_UNAVAILABLE'      // 真探测失败
  | 'E_LLM'              // 模型/凭据侧失败（如 402 欠费、403 无订阅）
  | 'E_TIMEOUT'
  | 'E_PROVIDER'         // provider 自身报错
  | 'E_CAPABILITY'       // 没有 provider 满足本次能力要求
  | 'E_NO_PROVIDER'      // 该 kind 没有任何可用 provider
  // ★ 单价守卫（openrouter_audio.ts::assertAudioModelAffordable）
  // 为什么要有独立的码：靠"注释里写着不要换成 gpt-audio"拦不住人（坑 24：承诺但不生效）。
  // 配了天价模型时必须在**配置/构造阶段**就失败，而不是等账单来了才发现。
  | 'E_PROVIDER_PRICE';

/**
 * ⚠️ **不要用 TypeScript 参数属性**（`constructor(public readonly x: T)`）——
 * Node 的 strip-only TS 模式**不支持**，会抛：
 *   `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported in strip-only mode`
 * （实测踩到。同理不支持 `enum` / `namespace` / 装饰器 —— 与 pi 仓库自身
 *  的 "erasable TS syntax only" 约束一致。）
 * 所以这里**显式声明字段**。
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  /** 给用户看的可读原因（UI 直接显示） */
  readonly hint?: string;
  readonly detail?: string;

  constructor(code: ProviderErrorCode, message: string, hint?: string, detail?: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.hint = hint;
    this.detail = detail;
  }
}

// ─────────────────────────────────────────────────────────────
// 配置（签名由 T-BACKEND 的 `config.ts` 提供；此处只声明消费方视角的类型）
// ─────────────────────────────────────────────────────────────

export interface ProviderConfigEntry {
  id: string;
  kind: ProviderKind;
  type: string;
  priority: number;
  enabled: boolean;
  /** ⚠️ `${ENV}` 已解析为**明文凭据** —— 禁止序列化外发、禁止打日志 */
  options: Record<string, unknown>;
  /** 声明了 `${X}` 但环境变量缺失 → `configured=false` 的依据 */
  missingEnv: string[];
  /** 原始字段 → 环境变量名（用于生成"缺哪个变量"的可读 reason） */
  envRefs: Record<string, string>;
}

export interface ProviderConfig {
  policy: Record<ProviderKind, Policy>;
  providers: Record<ProviderKind, ProviderConfigEntry[]>;
  sourcePath: string | null;
  warnings: string[];
}
