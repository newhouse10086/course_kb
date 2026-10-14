/**
 * ASR Provider —— 语音转文字
 *
 * 规格：[`docs/PROVIDERS.md`](../../../docs/PROVIDERS.md) §2
 *
 * ## 本机已实测的事实（**直接用，别重测**）
 *  | 事实 | 值 |
 *  |---|---|
 *  | 环境 | `faster-whisper 1.2.1` / `ctranslate2 4.8.3` / CPU int8 |
 *  | 模型 | `tiny` **已缓存**（74.6MB），无需联网 |
 *  | ⚠️ 必踩的坑 | **传文件路径会炸**：`av.open(..., metadata_errors=...)` 在 PyAV 19.0.1 不存在 |
 *  | ✅ 解法 | **传 numpy float32 数组**（`ffmpeg → wave → float32`），由 Python worker 实现 |
 *  | **真实性能** | **RTF ≈ 2x**（真实中文人声：5 分钟音频 → 128s）→ **1 小时课 ≈ 25–30 分钟** |
 *  | ⚠️ 反例 | 5 秒**纯正弦波**曾测出 9x —— **那是假象**（无人声），**不能用来估时长** |
 *  | 模型下载 | HF 会卡（实测 base 卡在 2.5MB）→ 默认 tiny + 超时降级 + 可配 `HF_ENDPOINT` 镜像 |
 *
 * ## 云端接口差异（必须在实现内抹平）
 *  | 差异 | 本地 fw | 阿里云 | 腾讯云 | OpenAI |
 *  |---|---|---|---|---|
 *  | 调用模式 | 同步 | **异步任务**（提交→轮询→取结果） | 同步/异步 | 同步 |
 *  | 时间戳 | **词级** | 词级 | 词级 | **仅段级** |
 */

import type {
  AsrRequest, AsrResult, AsrSegment, HealthResult,
  Provider, ProviderConfigEntry, ProviderInfo,
} from '../types.ts';
import { ProviderError } from '../types.ts';

// ─────────────────────────────────────────────────────────────
// 通用工具：能力校验
// ─────────────────────────────────────────────────────────────

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

function withTimeout(ms: number, signal?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

// ─────────────────────────────────────────────────────────────
// ① 本地 worker provider（经 Python worker 的 faster-whisper）
// ─────────────────────────────────────────────────────────────

/**
 * 调用 Python worker 做本地转写。
 *
 * 由 T-BACKEND 注入 `runWorker`（worker 调用器），本模块**不自己 spawn**，
 * 以便复用超时/取消/僵尸回收那一套。
 */
export type WorkerRunner = (job: {
  job: 'asr';
  input: Record<string, unknown>;
  onEvent?: (e: Record<string, unknown>) => void;
  signal?: AbortSignal;
}) => Promise<Record<string, unknown>>;

export interface LocalAsrOptions {
  id?: string;
  model?: string;
  runWorker: WorkerRunner;
  /** 传给 worker 的额外参数 */
  extra?: Record<string, unknown>;
}

export class LocalWorkerAsr implements Provider {
  readonly info: ProviderInfo;
  private readonly model: string;
  private readonly runWorker: WorkerRunner;
  private readonly extra: Record<string, unknown>;

  constructor(o: LocalAsrOptions) {
    this.model = o.model ?? 'tiny';
    this.runWorker = o.runWorker;
    this.extra = o.extra ?? {};
    this.info = {
      id: o.id ?? 'local-fw',
      kind: 'asr',
      label: `本地 faster-whisper（${this.model}）`,
      vendor: '本地',
      runtime: 'local',
      configured: true,           // 本地无需凭据
      available: false,           // 待真探测
      capabilities: {
        wordTimestamps: true,
        languages: ['zh', 'en', 'ja', 'ko', 'auto'],
        streaming: false,
        /** 实测 RTF≈2x → 1 小时音频约需 25–30 分钟 */
        rtf: 2.0,
      },
      pricing: { unit: 'hour', amount: 0, currency: 'CNY', note: '本地 CPU，无 API 费用' },
      limits: { concurrency: 1, maxDurationSec: 4 * 3600 },
    };
  }

  /** 真探测：让 worker 报它自己的自检结果（模型是否就绪），**不是只看文件存在** */
  async healthCheck(signal?: AbortSignal): Promise<HealthResult> {
    const t0 = Date.now();
    try {
      const r = await this.runWorker({
        job: 'asr',
        input: { op: 'probe', model: this.model, ...this.extra },
        signal,
      });
      const ok = r?.ok === true;
      return {
        ok,
        reason: ok ? undefined : String(r?.reason ?? 'worker 报告 ASR 不可用'),
        latencyMs: Date.now() - t0,
        probe: 'worker:asr op=probe（加载模型并做一次空转）',
      };
    } catch (e) {
      return {
        ok: false,
        reason: `本地 ASR 探测失败：${(e as Error).message}`,
        latencyMs: Date.now() - t0,
        probe: 'worker:asr op=probe',
      };
    }
  }

  async transcribe(req: AsrRequest, onEvent?: (e: Record<string, unknown>) => void): Promise<AsrResult> {
    const r = await this.runWorker({
      job: 'asr',
      input: {
        op: 'transcribe',
        audio_path: req.audioPath,
        model: this.model,
        language: req.language,
        word_timestamps: req.requireWordTimestamps ?? true,
        ...this.extra,
      },
      onEvent,
      signal: req.signal,
    });

    const segments = normalizeSegments(r.segments);
    // ⚠️ `r` 是 Record<string, unknown>（worker 返回值未做运行时校验），
    //    所以先显式取数值再比较 —— 直接 `(r.durationMs ?? 0) > 0` 会被 tsc 判为 `{} > number`。
    const reportedDurationMs = Number(r.durationMs ?? 0);
    if (!segments.length && reportedDurationMs > 0) {
      // ⚠️ 铁律 R3：**不产出假数据**。有音频却 0 段 → 如实报错，而不是返回空字幕冒充成功。
      throw new ProviderError(
        'E_PROVIDER',
        `本地 ASR 返回 0 段（音频 ${r.durationMs}ms）`,
        '可能音频无人声或模型异常，请检查音频内容',
      );
    }
    return {
      segments,
      language: String(r.language ?? req.language ?? 'auto'),
      durationMs: Number(r.durationMs ?? req.durationMs ?? 0),
      usedProvider: this.info.id,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// ② 云端 provider（阿里云 / 腾讯云 / OpenAI …）
// ─────────────────────────────────────────────────────────────

export interface CloudAsrOptions {
  id: string;
  label: string;
  vendor: string;
  /** 是否需要字级时间戳（决定 capabilities 与降级时是否被跳过） */
  wordTimestamps: boolean;
  /** 单次最大时长（秒）；阿里云录音文件识别有上限 */
  maxDurationSec?: number;
  maxSizeBytes?: number;
  pricing?: ProviderInfo['pricing'];
  /** **真探测**实现：必须真发一次最小请求。返回 throw 表示不可用 */
  probe: (signal?: AbortSignal) => Promise<void>;
  /** 转写实现：接 16k mono WAV，返回统一结构 */
  transcribe: (req: AsrRequest) => Promise<Omit<AsrResult, 'usedProvider'>>;
  /** 未配置时的可读原因（含缺哪个环境变量） */
  notConfiguredReason?: string;
}

/**
 * 云端 ASR 通用壳。
 *
 * 各家的**接口差异**（异步任务制、参数名、时间戳粒度）由构造时传入的
 * `probe` / `transcribe` 适配器抹平，**对外只有一个统一结构**。
 */
export class CloudAsr implements Provider {
  readonly info: ProviderInfo;
  private readonly probeImpl: (signal?: AbortSignal) => Promise<void>;
  private readonly transcribeImpl: (req: AsrRequest) => Promise<Omit<AsrResult, 'usedProvider'>>;

  constructor(o: CloudAsrOptions) {
    this.probeImpl = o.probe;
    this.transcribeImpl = o.transcribe;
    this.info = {
      id: o.id,
      kind: 'asr',
      label: o.label,
      vendor: o.vendor,
      runtime: 'cloud',
      configured: !o.notConfiguredReason,
      available: false,
      reason: o.notConfiguredReason,
      capabilities: {
        wordTimestamps: o.wordTimestamps,   // ⚠️ 如实声明：OpenAI 只有段级
        languages: ['zh', 'en', 'auto'],
        streaming: false,
      },
      pricing: o.pricing,
      limits: {
        maxDurationSec: o.maxDurationSec,
        maxSizeBytes: o.maxSizeBytes,
        concurrency: 1,
      },
    };
  }

  async healthCheck(signal?: AbortSignal): Promise<HealthResult> {
    if (!this.info.configured) {
      return { ok: false, reason: this.info.reason ?? '凭据未配置', probe: 'config' };
    }
    const t0 = Date.now();
    const { signal: s, done } = withTimeout(DEFAULT_PROBE_TIMEOUT_MS, signal);
    try {
      await this.probeImpl(s);
      return { ok: true, latencyMs: Date.now() - t0, probe: 'cloud minimal request' };
    } catch (e) {
      return {
        ok: false,
        reason: `云端 ASR 探测失败：${(e as Error).message}`,
        latencyMs: Date.now() - t0,
        probe: 'cloud minimal request',
      };
    } finally {
      done();
    }
  }

  async transcribe(req: AsrRequest): Promise<AsrResult> {
    if (!this.info.configured) {
      throw new ProviderError('E_NOT_CONFIGURED', `${this.info.id} 凭据未配置`, this.info.reason);
    }
    // 能力校验：需要字级时间戳但我没有 → **抛错让降级链跳过**（而不是产出残缺数据）
    if (req.requireWordTimestamps && !this.info.capabilities.wordTimestamps) {
      throw new ProviderError(
        'E_CAPABILITY',
        `${this.info.id} 不支持字级时间戳`,
        '本次要求字级时间戳，请改用支持该能力的 provider',
      );
    }
    const limit = this.info.limits?.maxDurationSec;
    if (limit && req.durationMs && req.durationMs / 1000 > limit) {
      throw new ProviderError(
        'E_CAPABILITY',
        `${this.info.id} 单次上限 ${limit}s，本次 ${Math.round(req.durationMs / 1000)}s`,
        '请先用 ffmpeg 分段（worker 已支持）后分批调用',
      );
    }
    const r = await this.transcribeImpl(req);
    return { ...r, usedProvider: this.info.id };
  }
}

// ─────────────────────────────────────────────────────────────
// 归一化：把各家结构统一成 `AsrSegment[]`
// ─────────────────────────────────────────────────────────────

/** 容错归一化：接受 `startMs/start_ms/start` 等多种字段名（各家差异大） */
export function normalizeSegments(input: unknown): AsrSegment[] {
  if (!Array.isArray(input)) return [];
  const out: AsrSegment[] = [];
  input.forEach((raw, idx) => {
    const s = raw as Record<string, unknown>;
    const start = num(s.startMs ?? s.start_ms ?? s.start ?? s.begin);
    const end = num(s.endMs ?? s.end_ms ?? s.end ?? s.finish);
    const text = String(s.text ?? s.sentence ?? s.content ?? '').trim();
    if (!text) return;
    out.push({
      i: idx,
      startMs: start,
      endMs: end > start ? end : start,
      text,
      confidence: s.confidence !== undefined ? num(s.confidence) : undefined,
      words: normalizeWords(s.words),
    });
  });
  // 时间轴单调性：本项目的字幕要求（worker 侧也断言，这里再兜一层）
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

function normalizeWords(input: unknown): AsrSegment['words'] {
  if (!Array.isArray(input)) return undefined;
  const ws = input
    .map((raw) => {
      const w = raw as Record<string, unknown>;
      const text = String(w.w ?? w.word ?? w.text ?? '').trim();
      if (!text) return null;
      return {
        w: text,
        startMs: num(w.startMs ?? w.start_ms ?? w.start),
        endMs: num(w.endMs ?? w.end_ms ?? w.end),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return ws.length ? ws : undefined;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ─────────────────────────────────────────────────────────────
// 工厂
// ─────────────────────────────────────────────────────────────

export interface AsrFactoryDeps {
  runWorker: WorkerRunner;
}

/**
 * type: `local_worker` | `aliyun_nls` | `tencent_asr` | `openai_asr`
 *
 * 未实现的云端 type 返回 `null` → 注册表会**如实记 reason**（不假装可用）。
 */
export function createAsrProvider(
  entry: ProviderConfigEntry,
  deps: AsrFactoryDeps,
): Provider | null {
  const o = entry.options as Record<string, unknown>;
  switch (entry.type) {
    case 'local_worker':
      return applyMissingEnv(
        new LocalWorkerAsr({
          id: entry.id,
          model: String(o.model ?? 'tiny'),
          runWorker: deps.runWorker,
          extra: subset(o, ['compute_type', 'device', 'hf_endpoint']),
        }),
        entry,
      );
    case 'openai_asr':
      return applyMissingEnv(
        new CloudAsr({
          id: entry.id,
          label: String(o.label ?? 'OpenAI Whisper API'),
          vendor: 'OpenAI',
          wordTimestamps: false,     // ⚠️ 如实：OpenAI 只有段级时间戳
          maxSizeBytes: 25 * 1024 * 1024,
          pricing: { unit: 'minute', amount: 0.006, currency: 'USD' },
          notConfiguredReason: reasonIfMissing(entry, 'OPENAI_API_KEY'),
          probe: notImplementedProbe(entry, 'openai_asr'),
          transcribe: notImplementedTranscribe(entry, 'openai_asr'),
        }),
        entry,
      );
    case 'aliyun_nls':
      return applyMissingEnv(
        new CloudAsr({
          id: entry.id,
          label: String(o.label ?? '阿里云智能语音交互'),
          vendor: '阿里云',
          wordTimestamps: true,
          maxDurationSec: 4 * 3600,
          pricing: { unit: 'hour', amount: 2.5, currency: 'CNY', note: '录音文件识别，按小时计' },
          notConfiguredReason: reasonIfMissing(entry, 'ALIYUN_AK / ALIYUN_SK / ALIYUN_APPKEY'),
          probe: notImplementedProbe(entry, 'aliyun_nls'),
          transcribe: notImplementedTranscribe(entry, 'aliyun_nls'),
        }),
        entry,
      );
    case 'tencent_asr':
      return applyMissingEnv(
        new CloudAsr({
          id: entry.id,
          label: String(o.label ?? '腾讯云语音识别'),
          vendor: '腾讯云',
          wordTimestamps: true,
          maxSizeBytes: 5 * 1024 * 1024,
          pricing: { unit: 'hour', amount: 2.0, currency: 'CNY' },
          notConfiguredReason: reasonIfMissing(entry, 'TENCENT_SECRET_ID / TENCENT_SECRET_KEY'),
          probe: notImplementedProbe(entry, 'tencent_asr'),
          transcribe: notImplementedTranscribe(entry, 'tencent_asr'),
        }),
        entry,
      );
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 未实现 type 的诚实占位
// ─────────────────────────────────────────────────────────────

/**
 * ⚠️ 未实现的云端 provider **必须显式声明未实现**，
 * 而不是在调用时抛一个含糊错误 —— 那样用户会以为"配置好了但坏了"。
 */
function notImplementedProbe(entry: ProviderConfigEntry, type: string) {
  return async (): Promise<void> => {
    throw new Error(`${type} 适配器尚未实现（provider id=${entry.id}）`);
  };
}

function notImplementedTranscribe(entry: ProviderConfigEntry, type: string) {
  return async (): Promise<Omit<AsrResult, 'usedProvider'>> => {
    throw new ProviderError(
      'E_PROVIDER',
      `${type} 适配器尚未实现`,
      `provider「${entry.id}」的 type=${type} 还没有实现，请改用已实现的 provider 或补充适配器`,
    );
  };
}

// ─────────────────────────────────────────────────────────────
// 配置辅助
// ─────────────────────────────────────────────────────────────

function reasonIfMissing(entry: ProviderConfigEntry, humanNames: string): string | undefined {
  return (entry.missingEnv?.length ?? 0) > 0
    ? `缺少 ${humanNames}（在 course-kb/.env 配置，变量名见 config/providers.yaml）`
    : undefined;
}

function applyMissingEnv(p: Provider, entry: ProviderConfigEntry): Provider {
  if (entry.missingEnv?.length) {
    p.info.configured = false;
    p.info.available = false;
    p.info.reason ??= `缺少环境变量 ${entry.missingEnv.join(' / ')}（在 course-kb/.env 配置）`;
  }
  return p;
}

function subset(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
