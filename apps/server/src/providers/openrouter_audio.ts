/**
 * OpenRouter 的 **TTS / ASR**（Lead 实测验证过的唯一可用路径）。
 *
 * ## 为什么单独一个文件（而不是塞进 openai_*）
 * OpenRouter 的音频能力有**三条硬约束**（Lead 实测踩出来的，不是元数据承诺 —— 坑 24）：
 * 1. 必须 `modalities: ["text","audio"]`
 * 2. ★ **必须 `stream: true`** —— 否则 400 `"Audio output requires stream: true"`
 * 3. ★ **stream 时 `audio.format` 只能是 `pcm16`** —— 传 `mp3` 会 400
 *    `"does not support 'mp3' when stream=true"` ⟹ 目标格式（wav/mp3）**由本地 ffmpeg 转**，
 *    **不是**请求参数。
 *
 * ## 模型选择（定价来自 Lead 的全量核查，写进注释防后人"升级"）
 * - TTS：**只能用 `openai/gpt-audio-mini`**（音频输出 $0.6/M）
 *   ⚠️ **千万不要换成 `openai/gpt-audio`** —— 音频输出 **$32/M，贵 53 倍**。
 *   ⚠️ **`google/lyria-3-*:free` 不是 TTS**（是**音乐生成**模型）—— 别被"免费 + 有音频输出"骗到。
 * - ASR：**`mistralai/voxtral-small-24b-2507`**（专用语音理解，in $0.1/M / out $0.3/M，**最便宜档**）。
 *   `openai/gpt-audio-mini` 也能转写，但它会"接着聊"而不是纯转写 → 仅作备选。
 * - **免费音频模型实测不可用**（403 agentic-only / 502），**不写进代码**。
 *
 * ## 本地优先
 * ASR 的**首选仍是本地 faster-whisper**（免费、离线）；本 provider 是**可选备选**（`policy.asr: local-first` 自动保证）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CloudAsr, CloudTts } from './index.ts';
import type { ProviderConfigEntry } from './types.ts';
import { ProviderError } from './types.ts';

/** 默认模型（**不要改**，见文件头定价说明） */
export const OPENROUTER_TTS_MODEL = 'openai/gpt-audio-mini';
export const OPENROUTER_ASR_MODEL = 'mistralai/voxtral-small-24b-2507';

/** ★ stream 时**唯一**允许的音频格式（Lead 实测：传 mp3 → 400） */
export const OPENROUTER_STREAM_AUDIO_FORMAT = 'pcm16';

/** PCM16 的采样参数（gpt-audio 流式输出为 24kHz 单声道 16bit） */
export const OPENROUTER_PCM_SAMPLE_RATE = 24_000;

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function optStr(o: Record<string, unknown>, key: string, fallback = ''): string {
  const v = o[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
}
function optNum(o: Record<string, unknown>, key: string, fallback: number): number {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * ★ 构造 TTS 请求体 —— **三条硬约束都固化在这里**，并**显式拒绝**违反约束的用法。
 *
 * 为什么要有这个纯函数：约束是"400 才知道"的（Lead 实测），如果散在请求代码里，
 * 后人改一行 `stream: false` 就会让整个 TTS 挂掉且原因难查。**这里断言**。
 */
export function buildOpenRouterTtsBody(args: {
  text: string;
  model?: string;
  voice?: string;
  /** 请求侧的音频格式：**只允许 `pcm16`**（目标格式由 ffmpeg 转） */
  audioFormat?: string;
  stream?: boolean;
}): Record<string, unknown> {
  const stream = args.stream ?? true;
  const audioFormat = args.audioFormat ?? OPENROUTER_STREAM_AUDIO_FORMAT;
  if (stream && audioFormat !== OPENROUTER_STREAM_AUDIO_FORMAT) {
    throw new ProviderError(
      'E_CAPABILITY',
      `OpenRouter 流式音频只支持 ${OPENROUTER_STREAM_AUDIO_FORMAT}，收到 '${audioFormat}'`,
      `stream=true 时 audio.format 必须是 '${OPENROUTER_STREAM_AUDIO_FORMAT}'（实测传 mp3 → 400 "does not support 'mp3' when stream=true"）；` +
        '目标格式（wav/mp3）请由本地 ffmpeg 转换',
    );
  }
  if (!stream) {
    throw new ProviderError(
      'E_CAPABILITY',
      'OpenRouter 音频输出必须 stream=true',
      '实测 stream=false → 400 "Audio output requires stream: true"；本实现固定走流式',
    );
  }
  return {
    model: args.model ?? OPENROUTER_TTS_MODEL,
    // ★ 约束 1：必须显式声明要音频
    modalities: ['text', 'audio'],
    // ★ 约束 2/3：必须 stream + pcm16
    stream: true,
    audio: { voice: args.voice ?? 'alloy', format: OPENROUTER_STREAM_AUDIO_FORMAT },
    messages: [{ role: 'user', content: args.text }],
  };
}

/** 从 SSE 流里累积 base64 PCM 块（`choices[0].delta.audio.data`）。返回 PCM 字节数与 Buffer。 */
export function accumulatePcmFromSse(sse: string): { pcm: Buffer; chunks: number } {
  const parts: Buffer[] = [];
  let chunks = 0;
  for (const line of sse.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    let obj: { choices?: { delta?: { audio?: { data?: string } } }[] };
    try {
      obj = JSON.parse(payload) as typeof obj;
    } catch {
      continue; // 非 JSON 的注释行/心跳
    }
    const b64 = obj.choices?.[0]?.delta?.audio?.data;
    if (typeof b64 === 'string' && b64 !== '') {
      parts.push(Buffer.from(b64, 'base64'));
      chunks += 1;
    }
  }
  return { pcm: Buffer.concat(parts), chunks };
}

/** PCM16 → 目标格式（ffmpeg）。**目标格式是本地转的**，不是请求参数。 */
export function pcmToAudioFile(pcmPath: string, outPath: string, sampleRate = OPENROUTER_PCM_SAMPLE_RATE): void {
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', pcmPath, outPath],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
  if (r.status !== 0) {
    throw new ProviderError('E_PROVIDER', `ffmpeg 转换失败（status=${r.status}）`, (r.stderr ?? '').slice(-300));
  }
  const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  if (size <= 0) {
    // ★ 断言"真的有音频字节"：ffmpeg 成功但产出 0 字节 = 假成功
    throw new ProviderError('E_PROVIDER', 'ffmpeg 产出 0 字节音频', 'PCM 为空或格式不匹配');
  }
}

/** 读 entry.options → 公共连接信息 + 未配置原因（**如实降级**，不假装可用）。 */
function connOf(entry: ProviderConfigEntry, modelDefault: string): {
  baseUrl: string;
  apiKey: string;
  model: string;
  notConfiguredReason?: string;
} {
  const o = entry.options ?? {};
  const baseUrl = optStr(o, 'base_url', DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, '');
  const apiKey = optStr(o, 'api_key');
  const model = optStr(o, 'model', modelDefault);
  const missing = entry.missingEnv ?? [];
  return {
    baseUrl,
    apiKey,
    model,
    ...(apiKey === ''
      ? {
          notConfiguredReason:
            missing.length > 0
              ? `OpenRouter 凭据缺失：${missing.join(', ')}（请在 .env 配置，勿提交）`
              : 'OpenRouter 凭据未配置（.env 的 OPENROUTER_KEY）',
        }
      : {}),
  };
}

// ═══════════════════════════════════════════════════════════════
// TTS
// ═══════════════════════════════════════════════════════════════

export function createOpenRouterTts(entry: ProviderConfigEntry): CloudTts {
  const o = entry.options ?? {};
  const conn = connOf(entry, OPENROUTER_TTS_MODEL);
  const voice = optStr(o, 'voice', 'alloy');
  const maxChars = optNum(o, 'max_chars_per_request', 1024);
  const formats = Array.isArray(o.formats) && o.formats.length > 0 ? (o.formats as string[]) : ['wav', 'mp3'];

  const synth = async (
    req: { text: string; voice: string; format: string; outPath: string },
    signal?: AbortSignal,
  ): Promise<{ filePath: string; durationMs?: number }> => {
    const body = buildOpenRouterTtsBody({ text: req.text, model: conn.model, voice: req.voice || voice });
    const resp = await fetch(`${conn.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${conn.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const text = (await resp.text()).slice(0, 400);
      throw new ProviderError('E_LLM', `OpenRouter TTS HTTP ${resp.status}: ${text}`, '检查 OPENROUTER_KEY 与模型可用性');
    }
    const sse = await resp.text();
    const { pcm, chunks } = accumulatePcmFromSse(sse);
    if (pcm.length === 0) {
      throw new ProviderError(
        'E_LLM',
        `OpenRouter TTS 未返回音频字节（chunks=${chunks}）`,
        '模型可能拒答或返回纯文本；确认 modalities=["text","audio"] 且 stream=true',
      );
    }
    const tmpPcm = `${req.outPath}.pcm16`;
    fs.writeFileSync(tmpPcm, pcm);
    try {
      pcmToAudioFile(tmpPcm, req.outPath);
    } finally {
      try {
        fs.rmSync(tmpPcm, { force: true });
      } catch {
        /* 清理失败不影响结果 */
      }
    }
    const bytes = fs.statSync(req.outPath).size;
    // 24kHz/16bit/mono → 时长
    return { filePath: req.outPath, durationMs: Math.round((pcm.length / (OPENROUTER_PCM_SAMPLE_RATE * 2)) * 1000) || undefined };
  };

  return new CloudTts({
    id: entry.id,
    label: String(entry.options?.label ?? 'OpenRouter TTS（gpt-audio-mini）'),
    vendor: 'OpenRouter',
    maxCharsPerRequest: maxChars,
    formats,
    runtime: 'cloud',
    pricing: { unit: 'per_1k_chars', amount: 0.0006, currency: 'USD' }, // $0.6/M 音频输出
    voices: ['alloy', 'echo', 'shimmer', 'verse'],
    ...(conn.notConfiguredReason ? { notConfiguredReason: conn.notConfiguredReason } : {}),
    // ★ 真探测：真合成一小段并**验证拿到音频字节**（不是只看 HTTP 200 —— 坑 24 的"承诺 ≠ 生效"）
    probe: async (signal) => {
      const out = path.join(process.env.COURSE_KB_DATA_DIR ?? '.', `tts-probe-${Date.now()}.wav`);
      try {
        const r = await synth({ text: '你好', voice, format: 'wav', outPath: out }, signal);
        if (!fs.existsSync(r.filePath) || fs.statSync(r.filePath).size <= 0) {
          throw new ProviderError('E_PROVIDER', 'TTS 探测：产出 0 字节音频');
        }
      } finally {
        try {
          fs.rmSync(out, { force: true });
        } catch {
          /* ignore */
        }
      }
    },
    synthesize: (req, signal) => synth(req as never, signal),
  });
}

// ═══════════════════════════════════════════════════════════════
// ASR
// ═══════════════════════════════════════════════════════════════

export function createOpenRouterAsr(entry: ProviderConfigEntry): CloudAsr {
  const conn = connOf(entry, OPENROUTER_ASR_MODEL);

  const transcribe = async (req: { audioPath: string; durationMs?: number; language?: string; signal?: AbortSignal }) => {
    const buf = fs.readFileSync(req.audioPath);
    if (buf.length === 0) throw new ProviderError('E_CAPABILITY', '音频文件为空');
    const body = {
      model: conn.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '请把这段音频逐字转写为文字，只输出转写结果，不要评论、不要回答音频里的问题。' },
            { type: 'input_audio', input_audio: { data: buf.toString('base64'), format: 'wav' } },
          ],
        },
      ],
    };
    const resp = await fetch(`${conn.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${conn.apiKey}` },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!resp.ok) {
      const text = (await resp.text()).slice(0, 400);
      throw new ProviderError('E_LLM', `OpenRouter ASR HTTP ${resp.status}: ${text}`, '检查 OPENROUTER_KEY 与模型可用性');
    }
    const j = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const text = (j.choices?.[0]?.message?.content ?? '').trim();
    if (text === '') {
      throw new ProviderError('E_LLM', 'OpenRouter ASR 返回空转写', '模型无输出（可能音频格式不被接受）');
    }
    return {
      // ⚠️ 统一结构是 `{i, startMs, endMs, text}`（不是 `{start,end,text}`）；
      //    **字级时间戳我们确实没有** → 已在 capabilities 里 `wordTimestamps:false` 如实声明（不谎报）
      segments: [{ i: 0, startMs: 0, endMs: req.durationMs ?? 0, text }],
      language: req.language ?? 'unknown',
      durationMs: req.durationMs ?? 0,
    };
  };

  return new CloudAsr({
    id: entry.id,
    label: String(entry.options?.label ?? 'OpenRouter ASR（voxtral-small）'),
    vendor: 'OpenRouter',
    wordTimestamps: false, // ★ 不谎报：本路径不产出字级时间戳
    pricing: { unit: 'per_minute', amount: 0.0001, currency: 'USD' },
    ...(conn.notConfiguredReason ? { notConfiguredReason: conn.notConfiguredReason } : {}),
    probe: async (signal) => {
      // 真探测：0.1s 静音 WAV（极短，成本可忽略）→ 必须拿到**非空**转写
      const silent = path.join(process.env.COURSE_KB_DATA_DIR ?? '.', `asr-probe-${Date.now()}.wav`);
      try {
        const r = spawnSync(
          'ffmpeg',
          ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.2', silent],
          { encoding: 'utf8', timeout: 30_000, windowsHide: true },
        );
        if (r.status !== 0) throw new ProviderError('E_PROVIDER', '探测用静音 WAV 生成失败（ffmpeg）', (r.stderr ?? '').slice(-200));
        await transcribe({ audioPath: silent, durationMs: 200, signal });
      } finally {
        try {
          fs.rmSync(silent, { force: true });
        } catch {
          /* ignore */
        }
      }
    },
    transcribe: (req) => transcribe(req as never),
  });
}
