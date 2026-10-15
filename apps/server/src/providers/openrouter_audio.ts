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
 * ## 模型选择（定价来自 `/api/v1/models` 权威字段 + 1 次真调用实测）
 *
 * ⚠️ **2026-10-16 修正**：原作者把几个数字**记混了**（$32/M 是 gpt-audio 的音频**输入**价，
 * 它的音频**输出**是 $64/M；mini 的输出是 $2.4/M）。旧注释写"音频输出 $32/M，贵 53 倍"，
 * 两个数字都不是输出价 —— **注释里的数字也会撒谎**，所以下面每个数字都标了出处。
 *
 * | 模型 | audio in | audio out | 用途 |
 * |---|---|---|---|
 * | `openai/gpt-audio-mini` | $0.6/M | **$2.4/M** | TTS ✅（默认） |
 * | `openai/gpt-audio` | $32/M | **$64/M** | ❌ 音频输出是 mini 的 **26.7×** |
 * | `mistralai/voxtral-small-24b-2507` | **$100/M**（$0.0001/audio-token，1 token=1 秒） | —（audio→text，无音频输出） | ASR ✅（默认） |
 *
 * ★ **注释不是守卫**（坑 24「死旋钮 / 承诺但不生效」的变体）：光写"千万不要换成 gpt-audio"，
 * 后人改一行 `model:` 就绕过去了。所以这里改成**代码强制** —— 见
 * :func:`assertAudioModelAffordable`：单价超上限 / 模型不合适 / 模型不在表里，一律**直接抛**。
 * ⚠️ **`google/lyria-3-*:free` 不是 TTS**（是**音乐生成**模型）—— 别被"免费 + 有音频输出"骗到。
 * `openai/gpt-audio-mini` 也能转写，但它会"接着聊"而不是纯转写 → 仅作备选。
 * **免费音频模型实测不可用**（403 agentic-only / 502），**不写进代码**。
 *
 * ## ASR 走云端（2026-10-16 用户裁定）
 * ★ **ASR 默认走 OpenRouter API（`mistralai/voxtral-small-24b-2507`），不再以本地 faster-whisper 为默认**。
 * 本地实现保留为**显式可选**（离线/降级场景），但默认路径不许走它，**也不许静默降级回本地**：
 * 云端不可用 → **如实报错 + 可读 reason**（`worker/video/cloud_asr.py` 里 plan/convert 分工，
 * OpenRouter 调用只在本文件这一处）。
 *
 * ★ **实测计费口径（2026-10-16，30s 音频）**：`usage.cost = 0.0030593`
 * ⟹ **≈$0.0061/分钟音频 ≈ $0.367/小时视频**；账单大头是**音频时长**（1 audio token = 1 秒），
 * 不是文字 token。所以别用"in $0.1/M"去估 ASR 成本（会**严重低估**）。
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

// ═══════════════════════════════════════════════════════════════
// ★ 单价守卫：把"注释里的警告"变成**代码强制**（坑 24）
// ═══════════════════════════════════════════════════════════════

/** 音频模型单价表（USD / 1M token；来自 `/api/v1/models` 的 `pricing` 字段，2026-10-16）。 */
export const AUDIO_MODEL_PRICES: Record<
  string,
  { audioInPerM: number; audioOutPerM: number; modality: string; note?: string }
> = {
  'mistralai/voxtral-small-24b-2507': {
    // usage: {"audio_tokens":30} 对应 30.0s 音频 ⟹ 1 audio token = 1 秒
    audioInPerM: 100, // pricing.audio = "0.0001" /token × 1e6
    audioOutPerM: 0,
    modality: 'text+file+audio->text',
    note: 'ASR 专用；实测 ≈$0.0061/分钟音频',
  },
  'openai/gpt-audio-mini': {
    audioInPerM: 0.6,
    audioOutPerM: 2.4,
    modality: 'text+audio->text+audio',
    note: 'TTS 默认；实测可用（见 providers_openrouter_audio.test.ts）',
  },
  'openai/gpt-audio': {
    audioInPerM: 32,
    audioOutPerM: 64,
    modality: 'text+audio->text+audio',
    note: '音频输出是 mini 的 26.7× —— 禁止用于 TTS',
  },
};

/** TTS：音频**输出** token 价上限（USD/1M）。mini=2.4 ✅；gpt-audio=64 ❌ */
export const TTS_AUDIO_OUTPUT_CEILING_USD_PER_M = 10;
/** ASR：每分钟音频总成本上限（USD）。voxtral 实测 ≈0.0061 ✅ */
export const ASR_USD_PER_AUDIO_MINUTE_CEILING = 0.05;

/**
 * ★ 单价守卫：模型**单价过高 / 不适合该用途 / 不在表里** → 直接抛。
 *
 * 存在理由（Lead 要求）：文件头写着"千万不要换成 `openai/gpt-audio`（音频输出 $64/M）"，
 * 但**注释不是守卫** —— 改一行 `model:` 就绕过去了（坑 24：承诺但不生效）。
 * 这里让它变成**可执行的约束**：配置阶段就失败，而不是等账单来了才发现。
 *
 * **fail-closed**：表里没有的模型一律拒绝（宁可让新人显式加表 + 填价，也不放行未知单价）。
 *
 * @throws ProviderError `E_PROVIDER_PRICE`
 */
export function assertAudioModelAffordable(model: string, kind: 'asr' | 'tts'): void {
  const p = AUDIO_MODEL_PRICES[model];
  if (!p) {
    throw new ProviderError(
      'E_PROVIDER_PRICE',
      `音频模型 ${model} 不在单价表里（拒绝放行未知单价）`,
      `请在 openrouter_audio.ts 的 AUDIO_MODEL_PRICES 里补上它的 pricing（来源：GET /api/v1/models）与 modality，` +
        `并确认单价可接受；不要为了"先跑起来"绕过这个检查。`,
    );
  }
  if (kind === 'tts') {
    if (!p.modality.includes('audio') || !p.modality.split('->')[1]?.includes('audio')) {
      throw new ProviderError(
        'E_PROVIDER_PRICE',
        `模型 ${model} 不是音频输出模型（modality=${p.modality}），不能用于 TTS`,
        'TTS 需要形如 `text+audio->text+audio` 的模型（音频输出）。',
      );
    }
    if (p.audioOutPerM > TTS_AUDIO_OUTPUT_CEILING_USD_PER_M) {
      throw new ProviderError(
        'E_PROVIDER_PRICE',
        `模型 ${model} 音频输出 $${p.audioOutPerM}/M 超过上限 $${TTS_AUDIO_OUTPUT_CEILING_USD_PER_M}/M`,
        `${p.note ?? ''}；TTS 请用 ${OPENROUTER_TTS_MODEL}（音频输出 $${AUDIO_MODEL_PRICES[OPENROUTER_TTS_MODEL]?.audioOutPerM}/M）。`,
      );
    }
    return;
  }
  // ASR：必须是"音频输入 → **纯文本输出**"，且每分钟音频总成本可接受
  //
  // ⚠️ 判据必须是**输出侧恰好是 text**，不能用 `modality.includes('audio->text')`：
  //    `text+audio->text+audio`（gpt-audio）里**也**含有子串 `audio->text`！
  //    第一版就是这么写的 → gpt-audio 被放行当 ASR（红证当场抓到）。
  const [inSide, outSide] = p.modality.split('->');
  if (!inSide?.includes('audio') || outSide?.trim() !== 'text') {
    throw new ProviderError(
      'E_PROVIDER_PRICE',
      `模型 ${model} 不适合做 ASR（modality=${p.modality}）`,
      `ASR 需要形如 \`text+file+audio->text\` 的模型（输出侧**恰好是 text**）；${model} 的输出侧是 ` +
        `"${outSide ?? ''}"（双向音频模型会"接着聊"而不是纯转写）。ASR 请用 ${OPENROUTER_ASR_MODEL}。`,
    );
  }
  // 1 audio token = 1 秒音频（实测）⟹ 每分钟 60 个 audio token
  const perMinute = (60 * p.audioInPerM) / 1_000_000;
  if (perMinute > ASR_USD_PER_AUDIO_MINUTE_CEILING) {
    throw new ProviderError(
      'E_PROVIDER_PRICE',
      `模型 ${model} 音频输入约 $${perMinute.toFixed(4)}/分钟，超过上限 $${ASR_USD_PER_AUDIO_MINUTE_CEILING}/分钟`,
      `${p.note ?? ''}；ASR 请用 ${OPENROUTER_ASR_MODEL}（实测 ≈$0.0061/分钟）。`,
    );
  }
}

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
  // ★ 单价守卫（fail-closed）：换成 gpt-audio 之类 → 这里当场抛，不等账单
  assertAudioModelAffordable(conn.model, 'tts');
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
  // ★ 单价守卫（fail-closed）：不是 audio→text 的模型（如 gpt-audio）→ 当场抛
  assertAudioModelAffordable(conn.model, 'asr');

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
    // ⚠️ 2026-10-16 修正：原来写 `per_minute: 0.0001`（≈$0.0001/分钟）—— **比实测低 61 倍**，
    //    属于"自述字段与实际不同源"（坑 21），会让用户拿它算预算时严重低估。
    //    实测（1 次真调用，30.0s 音频）：usage.cost=0.0030593 ⟹ $0.0030593/30s = 0.0061186/分钟。
    pricing: { unit: 'per_minute', amount: 0.0061186, currency: 'USD' },
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
