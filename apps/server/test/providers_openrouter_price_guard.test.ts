/**
 * ★ 音频模型的**单价守卫**测试（零额度：不发任何网络请求）。
 *
 * ## 为什么要有这个文件（Lead 的红证要求）
 * 文件头里写着"**千万不要换成 `openai/gpt-audio`**（音频输出 $64/M）"——
 * 但**注释不是守卫**：后人改一行 `model:` 就绕过去了（坑 24「承诺但不生效」家族）。
 * 这里把警告变成**可执行约束**，并给出**故意的反例**：
 * 把模型配成 `openai/gpt-audio` → **必须抛**（不是警告、不是"跑起来再说"）。
 *
 * ## 定价来源（可复核）
 * `GET https://openrouter.ai/api/v1/models` 的 `pricing` 字段（2026-10-16 抓取，免费接口）：
 * - `openai/gpt-audio`        `audio: 0.000032`（in）/ `audio_output: 0.000064`（out）→ $32/M、$64/M
 * - `openai/gpt-audio-mini`   `audio: 0.0000006` / `audio_output: 0.0000024` → $0.6/M、$2.4/M
 * - `mistralai/voxtral-small-24b-2507` `audio: 0.0001` /token（1 audio token = 1 秒音频，**实测**）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ASR_USD_PER_AUDIO_MINUTE_CEILING,
  AUDIO_MODEL_PRICES,
  OPENROUTER_ASR_MODEL,
  OPENROUTER_TTS_MODEL,
  TTS_AUDIO_OUTPUT_CEILING_USD_PER_M,
  assertAudioModelAffordable,
  createOpenRouterAsr,
  createOpenRouterTts,
} from '../src/providers/openrouter_audio.ts';
import { ProviderError } from '../src/providers/types.ts';
import type { ProviderConfigEntry } from '../src/providers/types.ts';

/** 完整的配置项（不做 `as never` 这种绕过类型的把戏 —— 坑 30）。 */
function entry(id: string, model?: string): ProviderConfigEntry {
  return {
    id,
    kind: 'asr',
    type: 'openrouter_asr',
    priority: 1,
    enabled: true,
    options: model ? { api_key: 'k'.repeat(20), model } : { api_key: 'k'.repeat(20) },
    missingEnv: [],
    envRefs: { api_key: 'OPENROUTER_KEY' },
  };
}

const ENTRY = entry('openrouter-asr');
const TTS_ENTRY: ProviderConfigEntry = { ...entry('openrouter-tts'), kind: 'tts', type: 'openrouter_tts' };

/** 取抛出的错误（没有抛 → 返回 null，便于断言"必须抛"）。 */
function thrown(fn: () => unknown): ProviderError | null {
  try {
    fn();
    return null;
  } catch (e) {
    assert.ok(e instanceof ProviderError, `期望 ProviderError，实际 ${String(e)}`);
    return e as ProviderError;
  }
}

// ── ★ 红证：天价模型必须被拦下 ────────────────────────────────────────────
test('★ 红证：TTS 配成 openai/gpt-audio（音频输出 $64/M）→ 必须抛 E_PROVIDER_PRICE', () => {
  const err = thrown(() => createOpenRouterTts(entry('openrouter-tts', 'openai/gpt-audio')));
  assert.ok(err, '换成 gpt-audio 竟然没抛 —— 守卫失效（这正是注释做不到的事）');
  assert.equal(err.code, 'E_PROVIDER_PRICE');
  assert.match(err.message, /64/);
  assert.match(err.message, /超过上限/);
});

test('★ 红证：断言函数本身也必须拦 gpt-audio（不只靠工厂调用）', () => {
  const err = thrown(() => assertAudioModelAffordable('openai/gpt-audio', 'tts'));
  assert.ok(err && err.code === 'E_PROVIDER_PRICE');
  assert.equal(AUDIO_MODEL_PRICES['openai/gpt-audio']?.audioOutPerM, 64);
  assert.ok(64 > TTS_AUDIO_OUTPUT_CEILING_USD_PER_M, 'gpt-audio 必须高于上限，否则这条测试是空的');
});

test('★ 红证：把 gpt-audio 当 ASR 用 → 也必须抛（它不是 audio→text 模型）', () => {
  const err = thrown(() => assertAudioModelAffordable('openai/gpt-audio', 'asr'));
  assert.ok(err, 'gpt-audio 是双向音频模型（会"接着聊"），不该被当成 ASR');
  assert.match(err.message, /不适合做 ASR/);
  assert.match(err.hint ?? '', /输出侧/);
  assert.match(AUDIO_MODEL_PRICES['openai/gpt-audio']!.modality, /audio->text\+audio/);
});

// ── fail-closed：未知模型不放行 ───────────────────────────────────────────
test('不在单价表里的模型 → 拒绝（宁可让新人显式填价，也不放行未知单价）', () => {
  const err = thrown(() => assertAudioModelAffordable('some/new-audio-model', 'asr'));
  assert.ok(err && err.code === 'E_PROVIDER_PRICE');
  assert.match(err.message, /不在单价表里/);
  assert.match(err.hint ?? '', /AUDIO_MODEL_PRICES/);
});

// ── 默认模型必须通过（否则生产起不来） ────────────────────────────────────
test('默认 ASR/TTS 模型通过守卫，且 TTS 上限确实卡在两者之间', () => {
  assert.equal(thrown(() => assertAudioModelAffordable(OPENROUTER_ASR_MODEL, 'asr')), null);
  assert.equal(thrown(() => assertAudioModelAffordable(OPENROUTER_TTS_MODEL, 'tts')), null);

  const mini = AUDIO_MODEL_PRICES[OPENROUTER_TTS_MODEL]!;
  const big = AUDIO_MODEL_PRICES['openai/gpt-audio']!;
  assert.ok(mini.audioOutPerM < TTS_AUDIO_OUTPUT_CEILING_USD_PER_M, 'mini 必须在阈值下');
  assert.ok(big.audioOutPerM > TTS_AUDIO_OUTPUT_CEILING_USD_PER_M, 'gpt-audio 必须在阈值上');
  assert.ok(big.audioOutPerM / mini.audioOutPerM > 20, '两者差距应 >20×（旧注释写 53× 是记混了字段）');
});

test('工厂构造：默认模型能建出 provider，且 ASR 不谎报词级时间戳', () => {
  const asr = createOpenRouterAsr(ENTRY);
  assert.equal(asr.info.id, 'openrouter-asr');
  assert.equal(asr.info.capabilities.wordTimestamps, false, '块级/整段级 → 不许报 true');
  const tts = createOpenRouterTts(TTS_ENTRY);
  assert.equal(tts.info.id, 'openrouter-tts');
});

test('ASR 自述单价必须是**实测**值（不是那个低 61 倍的旧值）', () => {
  const asr = createOpenRouterAsr(ENTRY);
  const p = (asr.info.pricing ?? {}) as { unit?: string; amount?: number };
  assert.equal(p.unit, 'per_minute');
  // 实测：30.0s → usage.cost 0.0030593 ⟹ 每分钟 0.0061186
  assert.ok(
    Math.abs(Number(p.amount) - 0.0061186) < 1e-9,
    `自述单价应等于实测值 0.0061186，实际 ${String(p.amount)}`,
  );
  const perMinuteFromTable = (60 * AUDIO_MODEL_PRICES[OPENROUTER_ASR_MODEL]!.audioInPerM) / 1_000_000;
  assert.ok(perMinuteFromTable <= ASR_USD_PER_AUDIO_MINUTE_CEILING, '表中单价必须在 ASR 上限内');
});
