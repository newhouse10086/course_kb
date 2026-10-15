/**
 * ★ OpenRouter TTS/ASR 的**离线断言**（不花额度、不联网）。
 *
 * 真机证据（音频字节 / 转写文本）在 `test/e2e/openrouter_audio.e2e.ts`（显式跑）。
 * 本文件守的是**约束与降级**，即"调通"之外必须钉住的东西：
 * - ★ 三条硬约束（Lead 实测）：`modalities` 必须含 audio · 必须 `stream:true` · stream 时 **只允许 pcm16**
 *   → **违反就明确报错**（不是等上游 400）
 * - ★ SSE → PCM 累积**真的产出字节**（不是"HTTP 200 就算成功"）
 * - ★ PCM → WAV 由 **ffmpeg** 转，且**产出 >0 字节**（ffmpeg 成功但 0 字节 = 假成功）
 * - ★ 未配置 / 错误 key → **如实降级**（`configured=false` + 可读 reason；不假装可用）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  OPENROUTER_ASR_MODEL,
  OPENROUTER_PCM_SAMPLE_RATE,
  OPENROUTER_STREAM_AUDIO_FORMAT,
  OPENROUTER_TTS_MODEL,
  accumulatePcmFromSse,
  buildOpenRouterTtsBody,
  createOpenRouterAsr,
  createOpenRouterTts,
  pcmToAudioFile,
} from '../src/providers/openrouter_audio.ts';
import type { ProviderConfigEntry } from '../src/providers/types.ts';

const entry = (id: string, type: string, options: Record<string, unknown>, missingEnv: string[] = []): ProviderConfigEntry =>
  ({ id, kind: 'tts', type, priority: 1, enabled: true, options, missingEnv, envRefs: {} }) as ProviderConfigEntry;

test('★ 三条硬约束：modalities 含 audio · 必须 stream · stream 时只允许 pcm16（违反→明确报错）', () => {
  const body = buildOpenRouterTtsBody({ text: '你好' });
  assert.deepEqual(body.modalities, ['text', 'audio'], '★ 必须显式要音频（否则只有文本）');
  assert.equal(body.stream, true, '★ 必须 stream（实测 stream=false → 400 "Audio output requires stream: true"）');
  assert.deepEqual(body.audio, { voice: 'alloy', format: 'pcm16' }, `★ stream 时只能是 ${OPENROUTER_STREAM_AUDIO_FORMAT}`);
  assert.equal(body.model, OPENROUTER_TTS_MODEL);
  // 违反 → 明确报错（**在本地就拦下**，不等上游 400）
  assert.throws(() => buildOpenRouterTtsBody({ text: 'x', audioFormat: 'mp3', stream: true }), /pcm16/, '★ mp3+stream 必须明确报错');
  assert.throws(() => buildOpenRouterTtsBody({ text: 'x', audioFormat: 'wav', stream: true }), /pcm16/);
  assert.throws(() => buildOpenRouterTtsBody({ text: 'x', stream: false }), /stream=true/, '★ stream=false 必须明确报错');
  // 模型定价防线：不要被"升级"到贵 53 倍的模型（写进断言，防止后人手滑）
  assert.equal(OPENROUTER_TTS_MODEL, 'openai/gpt-audio-mini', '★ TTS 只用 gpt-audio-mini（gpt-audio 音频输出贵 53 倍）');
  assert.equal(OPENROUTER_ASR_MODEL, 'mistralai/voxtral-small-24b-2507', '★ ASR 用最便宜档的 voxtral-small');
});

test('★ SSE → PCM：真的累积出字节（不是"HTTP 200 就算成功"）', () => {
  const pcm = Buffer.alloc(480, 7); // 480 字节 = 10ms @24kHz/16bit/mono
  const sse = [
    'data: {"choices":[{"delta":{"audio":{"data":"' + pcm.subarray(0, 240).toString('base64') + '"}}}]}',
    ': 心跳注释行（应被忽略）',
    'data: {"choices":[{"delta":{"audio":{"data":"' + pcm.subarray(240).toString('base64') + '"}}}]}',
    'data: [DONE]',
  ].join('\n');
  const out = accumulatePcmFromSse(sse);
  assert.equal(out.chunks, 2, '两个音频块都要被计入');
  assert.equal(out.pcm.length, 480, '★ 字节数必须等于两块之和');
  assert.deepEqual(out.pcm, pcm, '字节内容必须逐字一致（base64 解码正确）');
  // 空/纯文本流 → 0 字节（调用方据此**如实报错**，不许当成功）
  assert.equal(accumulatePcmFromSse('data: {"choices":[{"delta":{"content":"只有文本"}}]}').pcm.length, 0);
});

test('★ PCM → 音频文件由 ffmpeg 转，且产出必须 >0 字节（0 字节 = 假成功）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-'));
  try {
    const pcmPath = path.join(tmp, 'a.pcm16');
    fs.writeFileSync(pcmPath, Buffer.alloc(OPENROUTER_PCM_SAMPLE_RATE * 2 / 10, 0)); // 0.1s 静音
    const outPath = path.join(tmp, 'a.wav');
    pcmToAudioFile(pcmPath, outPath);
    const size = fs.statSync(outPath).size;
    assert.ok(size > 0, `★ 必须产出 >0 字节音频，实际 ${size}`);
    assert.ok(size > 44, '至少要有 WAV 头 + 数据');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('★ 如实降级：缺凭据 → configured=false + 可读 reason（不假装可用）；探测也如实失败', async () => {
  const missing = entry('or-tts', 'openrouter_tts', { base_url: 'https://openrouter.ai/api/v1', api_key: '', model: OPENROUTER_TTS_MODEL }, [
    'OPENROUTER_KEY',
  ]);
  const tts = createOpenRouterTts(missing);
  assert.equal(tts.info.configured, false, '★ 缺凭据必须 configured=false');
  assert.match(String(tts.info.reason), /OPENROUTER_KEY/, '★ reason 必须指出缺哪个环境变量');
  const hc = await tts.healthCheck();
  assert.equal(hc.ok, false, '★ 探测必须如实失败');
  assert.equal(hc.probe, 'config', '未配置时不该发请求');

  const missingAsr = createOpenRouterAsr(entry('or-asr', 'openrouter_asr', { api_key: '', model: OPENROUTER_ASR_MODEL }, ['OPENROUTER_KEY']));
  assert.equal(missingAsr.info.configured, false);
  assert.match(String(missingAsr.info.reason), /OPENROUTER_KEY/);
});

test('★ 能力自述如实：ASR 不谎报字级时间戳；TTS 声明格式与上限', () => {
  const asr = createOpenRouterAsr(entry('or-asr', 'openrouter_asr', { api_key: 'k', model: OPENROUTER_ASR_MODEL }));
  assert.equal(asr.info.kind, 'asr');
  assert.equal(asr.info.capabilities.wordTimestamps, false, '★ 本路径没有字级时间戳 → 不许谎报 true');
  assert.equal(asr.info.configured, true);

  const tts = createOpenRouterTts(
    entry('or-tts', 'openrouter_tts', { api_key: 'k', model: OPENROUTER_TTS_MODEL, formats: ['wav', 'mp3'], max_chars_per_request: 1024 }),
  );
  assert.equal(tts.info.kind, 'tts');
  assert.deepEqual(tts.info.capabilities.formats, ['wav', 'mp3'], '目标格式由本地 ffmpeg 提供（请求侧恒为 pcm16）');
  const limits = tts.info.limits;
  assert.ok(limits, 'limits 必须存在（并发/上限的自述）');
  assert.equal(limits.maxCharsPerRequest, 1024);
  assert.equal(limits.concurrency, 1, '★ 并发=1（用户硬要求）');
});

test('★ 错误 key → 如实报错（E_LLM + 上游原文），不静默成功', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response('{"error":{"message":"Missing Authentication header","code":401}}', { status: 401 })) as unknown as typeof fetch;
    const tts = createOpenRouterTts(entry('or-tts', 'openrouter_tts', { api_key: 'bad', model: OPENROUTER_TTS_MODEL }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-'));
    await assert.rejects(
      () => tts.synthesizeText({ text: '你好', format: 'wav' }, dir),
      (e: unknown) => {
        const err = e as { code?: string; message?: string };
        assert.equal(err.code, 'E_LLM', '★ 401 必须映射为 E_LLM（不是静默成功）');
        assert.match(String(err.message), /401/, '错误里要带上游状态码，便于排查');
        return true;
      },
    );
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } finally {
    globalThis.fetch = realFetch;
  }
});
