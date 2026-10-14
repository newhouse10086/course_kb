/**
 * TTS Provider —— 文字转语音
 *
 * 规格：[`docs/PROVIDERS.md`](../../../docs/PROVIDERS.md) §3
 *
 * > ⚠️ 这是本项目**新增能力**（后续用于：知识点朗读、字幕配音、无障碍）
 *
 * ## 必须处理的三件事
 *  1. **单次字符上限** → 自动分段（**按句子边界切，不要切在词中间**）+ 拼接
 *  2. **接口差异抹平** → 音色参数各厂命名不同（`voice`/`VoiceType`/`vcn`/`voiceName`）
 *     → 统一为 `voice`，在 provider 内映射；语速/音调统一为 `rate`/`pitch`(-100..100)
 *  3. **缓存** → 同一段文本重复合成要命中缓存（省钱且稳定）
 *
 * ## 重要定位说明
 * Windows SAPI 本地合成**仅用于开发/测试**（v1 曾用它生成测试音频），**音质不适合交付**。
 * 生产走云。
 */

import type { HealthResult, Provider, ProviderConfigEntry, ProviderInfo, TtsRequest, TtsResult } from '../types.ts';
import { ProviderError } from '../types.ts';

// ─────────────────────────────────────────────────────────────
// 文本分段（★ 按句子边界，不切词）
// ─────────────────────────────────────────────────────────────

/** 中文/英文句末标点（含省略号）；切点放在标点**之后** */
const SENTENCE_END = /[。！？；.!?;]+[”"』」）)]*/g;

/**
 * 把长文本切成 ≤ `maxChars` 的片段。
 *
 * ⚠️ **只切在句子边界**。切在词中间会产生两个半截发音，
 * 拼接后听起来是断的（而且中文会被切成无意义的字组合）。
 *
 * 单句超长（无标点）时才退化为按标点/空格/硬切。
 */
export function splitForTts(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  // ① 先按句子切
  const sentences: string[] = [];
  let last = 0;
  for (const m of trimmed.matchAll(SENTENCE_END)) {
    const end = (m.index ?? 0) + m[0].length;
    sentences.push(trimmed.slice(last, end));
    last = end;
  }
  if (last < trimmed.length) sentences.push(trimmed.slice(last));

  // ② 把句子打包进 maxChars 的桶
  const chunks: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = '';
  };
  for (const s of sentences) {
    if (s.length > maxChars) {
      // 单句超长 → 先冲掉手上的，再硬切这一句
      flush();
      for (const piece of hardSplit(s, maxChars)) chunks.push(piece);
      continue;
    }
    if ((buf + s).length > maxChars) flush();
    buf += s;
  }
  flush();
  return chunks;
}

/**
 * 超长单句的退化切分。
 *
 * ⚠️ 中文没有空格，**硬切会把词切断**（听起来是断的）。
 * 所以优先级：**中文次级标点（，、：；）→ 空格 → 实在没有才硬切**。
 *
 * 实测踩到：初版只找空格，导致 `第四句话，还没有结束，继` 这种
 * 在半句处切开的片段（测试抓出来的）。
 */
function hardSplit(s: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    // ① 中文次级标点（逗号/顿号/冒号/分号）——最佳切点
    const cands = [
      window.lastIndexOf('，'),
      window.lastIndexOf('、'),
      window.lastIndexOf('：'),
      window.lastIndexOf('；'),
      window.lastIndexOf(','),
      window.lastIndexOf(' '),
    ];
    const best = Math.max(...cands);
    // ② 切点必须落在后半段，否则会切出很碎的前缀
    const at = best > maxChars * 0.5 ? best + 1 : maxChars;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

// ─────────────────────────────────────────────────────────────
// 缓存
// ─────────────────────────────────────────────────────────────

/** 简单 LRU：同文本+音色+参数 → 同一个音频文件（省钱、稳定） */
export class TtsCache {
  private readonly max: number;
  private readonly map = new Map<string, TtsResult>();

  constructor(max = 200) {
    this.max = max;
  }

  static key(text: string, voice: string, rate: number, pitch: number, format: string): string {
    // 用内容寻址，避免把长文本塞进 key
    let h = 2166136261;
    const s = `${voice}|${rate}|${pitch}|${format}|${text}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `tts_${(h >>> 0).toString(16)}_${text.length}`;
  }

  get(k: string): TtsResult | undefined {
    const v = this.map.get(k);
    if (v) {
      this.map.delete(k);
      this.map.set(k, v);        // 触碰即刷新（LRU）
    }
    return v;
  }

  set(k: string, v: TtsResult): void {
    this.map.set(k, v);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

// ─────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────

export interface CloudTtsOptions {
  id: string;
  label: string;
  vendor: string;
  /** ★ 单次字符上限（各家不同：300 / 1024 / 2000…） */
  maxCharsPerRequest: number;
  /** 支持的输出格式 */
  formats: string[];
  /** 是否需要网络（本地 SAPI 为 false） */
  runtime?: 'local' | 'cloud';
  pricing?: ProviderInfo['pricing'];
  /** ★ 真探测：必须真合成一小段并验返回 */
  probe: (signal?: AbortSignal) => Promise<void>;
  /** 单段合成（已保证 ≤ maxCharsPerRequest） */
  synthesize: (
    req: { text: string; voice: string; rate: number; pitch: number; format: string; outPath: string },
    signal?: AbortSignal,
  ) => Promise<{ filePath: string; durationMs?: number }>;
  notConfiguredReason?: string;
  /** 该 provider 的音色表（统一名） */
  voices?: string[];
}

export class CloudTts implements Provider {
  readonly info: ProviderInfo;
  private readonly impl: CloudTtsOptions;
  private readonly cache = new TtsCache();

  constructor(o: CloudTtsOptions) {
    this.impl = o;
    this.info = {
      id: o.id,
      kind: 'tts',
      label: o.label,
      vendor: o.vendor,
      runtime: o.runtime ?? 'cloud',
      configured: !o.notConfiguredReason,
      available: false,
      reason: o.notConfiguredReason,
      capabilities: {
        voices: o.voices ?? [],
        formats: o.formats,
        streaming: false,
        maxCharsPerRequest: o.maxCharsPerRequest,
      },
      pricing: o.pricing,
      limits: { maxCharsPerRequest: o.maxCharsPerRequest, concurrency: 1 },
    };
  }

  async healthCheck(signal?: AbortSignal): Promise<HealthResult> {
    if (!this.info.configured) {
      return { ok: false, reason: this.info.reason ?? '凭据未配置', probe: 'config' };
    }
    const t0 = Date.now();
    try {
      await this.impl.probe(signal);
      return { ok: true, latencyMs: Date.now() - t0, probe: '合成一小段文本' };
    } catch (e) {
      return {
        ok: false,
        reason: `TTS 探测失败：${(e as Error).message}`,
        latencyMs: Date.now() - t0,
        probe: '合成一小段文本',
      };
    }
  }

  /**
   * 合成。
   *
   * ⚠️ **长文本必须分段合成再拼接** —— 各厂都有单次上限，
   * 直接送超长文本会被截断（听起来"说到一半没了"，很难排查）。
   */
  async synthesizeText(req: TtsRequest, outDir: string): Promise<TtsResult> {
    if (!this.info.configured) {
      throw new ProviderError('E_NOT_CONFIGURED', `${this.info.id} 凭据未配置`, this.info.reason);
    }
    const voice = req.voice ?? this.impl.voices?.[0] ?? 'default';
    const rate = req.rate ?? 0;
    const pitch = req.pitch ?? 0;
    const format = req.format ?? 'mp3';

    const key = TtsCache.key(req.text, voice, rate, pitch, format);
    const hit = this.cache.get(key);
    if (hit) return hit;      // ★ 命中缓存，不重复计费

    const maxChars = this.info.limits?.maxCharsPerRequest ?? this.impl.maxCharsPerRequest;
    const chunks = splitForTts(req.text, maxChars);
    if (!chunks.length) {
      throw new ProviderError('E_PROVIDER', '待合成文本为空');
    }

    const parts: { filePath: string; durationMs?: number }[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const outPath = `${outDir}/${key}_${String(i).padStart(3, '0')}.${format}`;
      // `chunks[i]` 在 noUncheckedIndexedAccess 下是 string|undefined；循环边界已保证存在
      const r = await this.impl.synthesize(
        { text: chunks[i]!, voice, rate, pitch, format, outPath },
        req.signal,
      );
      parts.push(r);
    }

    // 时间轴：用于配音时的音画同步
    let cursor = 0;
    const timeline = chunks.map((text, i) => {
      const d = parts[i]!.durationMs ?? estimateDurationMs(text, rate);
      const seg = { index: i, text, startMs: cursor, endMs: cursor + d };
      cursor += d;
      return seg;
    });

    const result: TtsResult = {
      filePath: parts.length === 1 ? parts[0]!.filePath : parts.map((p) => p.filePath).join(','),
      format,
      durationMs: cursor,
      usedProvider: this.info.id,
      chunks: parts.length > 1 ? timeline : undefined,
    };
    this.cache.set(key, result);
    return result;
  }
}

/** 无时长信息时的估算：中文约 4 字/秒，英文约 180 词/分；rate 为正则更快 */
export function estimateDurationMs(text: string, rate = 0): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const other = text.length - cjk;
  const baseSec = cjk / 4 + other / 15;
  const factor = 1 - Math.max(-100, Math.min(100, rate)) / 200;
  return Math.max(200, Math.round(baseSec * factor * 1000));
}

// ─────────────────────────────────────────────────────────────
// 工厂
// ─────────────────────────────────────────────────────────────

/**
 * type: `aliyun_nls_tts` | `tencent_tts` | `openai_tts` | `local_sapi`
 *
 * 未实现的云端 type 会**如实声明未实现**（reason 里写清），不假装可用。
 */
export function createTtsProvider(entry: ProviderConfigEntry): Provider | null {
  const o = entry.options as Record<string, unknown>;
  const mk = (
    id: string,
    label: string,
    vendor: string,
    maxChars: number,
    formats: string[],
    missing: string,
    runtime: 'local' | 'cloud' = 'cloud',
    pricing?: ProviderInfo['pricing'],
  ): Provider => {
    const notConfigured = (entry.missingEnv?.length ?? 0) > 0
      ? `缺少 ${missing}（在 course-kb/.env 配置，变量名见 config/providers.yaml）`
      : undefined;
    return new CloudTts({
      id,
      label,
      vendor,
      maxCharsPerRequest: maxChars,
      formats,
      runtime,
      pricing,
      voices: Array.isArray(o.voices) ? (o.voices as string[]).map(String) : undefined,
      notConfiguredReason: notConfigured,
      probe: async () => {
        throw new Error(`${entry.type} 适配器尚未实现（provider id=${entry.id}）`);
      },
      synthesize: async () => {
        throw new ProviderError(
          'E_PROVIDER',
          `${entry.type} 适配器尚未实现`,
          `provider「${entry.id}」的 type=${entry.type} 还没有实现，请补充适配器或改用已实现的 provider`,
        );
      },
    });
  };

  switch (entry.type) {
    case 'aliyun_nls_tts':
      return mk(entry.id, String(o.label ?? '阿里云语音合成'), '阿里云',
        300, ['mp3', 'wav', 'pcm'], 'ALIYUN_AK / ALIYUN_SK / ALIYUN_APPKEY',
        'cloud', { unit: '1k_chars', amount: 0.3, currency: 'CNY' });
    case 'tencent_tts':
      return mk(entry.id, String(o.label ?? '腾讯云语音合成'), '腾讯云',
        150, ['mp3', 'wav'], 'TENCENT_SECRET_ID / TENCENT_SECRET_KEY',
        'cloud', { unit: '1k_chars', amount: 0.3, currency: 'CNY' });
    case 'openai_tts':
      return mk(entry.id, String(o.label ?? 'OpenAI TTS'), 'OpenAI',
        4096, ['mp3', 'wav', 'opus'], 'OPENAI_API_KEY',
        'cloud', { unit: '1k_chars', amount: 0.015, currency: 'USD' });
    case 'local_sapi':
      // ⚠️ 仅用于开发/测试（v1 用它生成 ASR 测试音频）；**音质不适合交付**
      return mk(entry.id, String(o.label ?? '本地 SAPI（仅测试）'), '本地',
        1000, ['wav'], '（本地无需凭据）', 'local',
        { unit: '1k_chars', amount: 0, currency: 'CNY', note: '仅开发测试，音质不适合交付' });
    default:
      return null;
  }
}
