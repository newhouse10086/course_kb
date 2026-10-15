/**
 * ★ OpenRouter TTS / ASR **真实调用证据**（Lead 批准消耗额度；预计 4 次调用：TTS 探测 1 + 合成 1 + ASR 探测 1 + 转写 1）。
 *
 * 覆盖 Lead 指定的断言：
 * - TTS：**真的拿到音频字节**（>0）· `mp3 + stream` → **明确报错**（不发请求，纯函数断言）
 * - ASR：转写**非空且含关键词**（用 TTS 产出的 WAV 喂回去 —— 端到端闭环）
 * - 降级：错误 key / 不可用模型 → **可读 reason**（如实降级，不假装可用）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'or-audio-'));
process.env.COURSE_KB_DATA_DIR = tmp;

const { loadConfig } = await imp('apps/server/src/config.ts');
const { createOpenRouterTts, createOpenRouterAsr, buildOpenRouterTtsBody } = await imp(
  'apps/server/src/providers/openrouter_audio.ts',
);

const cfg = loadConfig({ root: ROOT, env: { ...process.env, COURSE_KB_DATA_DIR: tmp } });
const ttsEntry = (cfg.providers.providers.tts ?? []).find((p) => p.type === 'openrouter_tts');
const asrEntry = (cfg.providers.providers.asr ?? []).find((p) => p.type === 'openrouter_asr');
console.log('配置: tts=%s asr=%s | OPENROUTER_KEY 有 = %s', Boolean(ttsEntry), Boolean(asrEntry), Boolean(cfg.env?.OPENROUTER_KEY));

// ── ① 纯函数断言：mp3 + stream → 明确报错（不发请求）──
let guard = '?';
try {
  buildOpenRouterTtsBody({ text: 'x', audioFormat: 'mp3', stream: true });
  guard = '❌ 没有报错（应报错）';
} catch (e) {
  guard = `✅ 明确报错：${String(e.message).slice(0, 60)}`;
}
console.log('① 约束断言 mp3+stream →', guard);
try {
  buildOpenRouterTtsBody({ text: 'x', stream: false });
  console.log('① 约束断言 stream=false → ❌ 没有报错');
} catch (e) {
  console.log('① 约束断言 stream=false → ✅ 明确报错：', String(e.message).slice(0, 50));
}
const bodyOk = buildOpenRouterTtsBody({ text: '你好' });
console.log(
  '① 正常请求体: modalities=%s stream=%s audio.format=%s model=%s',
  JSON.stringify(bodyOk.modalities),
  bodyOk.stream,
  bodyOk.audio.format,
  bodyOk.model,
);

const tts = createOpenRouterTts(ttsEntry);
const asr = createOpenRouterAsr(asrEntry);

// ── ② TTS 真探测（真合成一小段 → 必须拿到字节）──
const hc = await tts.healthCheck();
console.log('② TTS 真探测: ok=%s | probe=%s | reason=%s', hc.ok, hc.probe, hc.reason ?? '(无)');

// ── ③ TTS 真合成（公开 API 是 `synthesizeText(req, outDir)`）──
const TEXT = '聚簇索引会把数据行按照主键顺序存储在叶子节点上。';
const outDir = path.join(tmp, 'tts');
fs.mkdirSync(outDir, { recursive: true });
const t0 = Date.now();
const res = await tts.synthesizeText({ text: TEXT, voice: 'alloy', format: 'wav' }, outDir);
const bytes = fs.statSync(res.filePath).size;
console.log('③ TTS 合成: %dms | 文件=%s | ★ 字节=%d | 估算时长=%sms', Date.now() - t0, path.basename(res.filePath), bytes, res.durationMs ?? '?');
const outWav = res.filePath;

// ── ④ ASR 真探测 + 真转写（把 TTS 的 WAV 喂回去）──
const hcAsr = await asr.healthCheck();
console.log('④ ASR 真探测: ok=%s | probe=%s | reason=%s', hcAsr.ok, hcAsr.probe, hcAsr.reason ?? '(无)');
const t1 = Date.now();
const tr = await asr.transcribe({ audioPath: outWav, durationMs: res.durationMs, language: 'zh' });
const text = tr.segments.map((s) => s.text).join('');
console.log('④ ASR 转写: %dms | ★ 文本=%s', Date.now() - t1, JSON.stringify(text.slice(0, 120)));
const KEY = '聚簇索引';
console.log('④ 判定: 非空=%s | 含关键词"%s"=%s | 时间戳能力如实声明=%s', text.length > 0, KEY, text.includes(KEY), asr.info.capabilities.wordTimestamps);

// ── ⑤ 降级路径（如实报错，不假装可用）：错误 key ──
const badEntry = { ...ttsEntry, options: { ...ttsEntry.options, api_key: 'sk-or-invalid-key-for-degradation-test' } };
const badTts = createOpenRouterTts(badEntry);
const badDir = path.join(tmp, 'bad');
fs.mkdirSync(badDir, { recursive: true });
try {
  await badTts.synthesizeText({ text: '你好', voice: 'alloy', format: 'wav' }, badDir);
  console.log('⑤ 错误 key → ❌ 竟然成功了（应报错）');
} catch (e) {
  console.log('⑤ 错误 key → ✅ 如实报错: code=%s msg=%s', e.code ?? '?', String(e.message).slice(0, 110));
}
// 未配置（缺 env）→ configured=false + 可读 reason（不发请求）
const noKey = { ...asrEntry, options: { ...asrEntry.options, api_key: '' }, missingEnv: ['OPENROUTER_KEY'] };
const noKeyAsr = createOpenRouterAsr(noKey);
console.log('⑤ 缺凭据 → configured=%s | reason=%s', noKeyAsr.info.configured, noKeyAsr.info.reason ?? '(无)');
console.log('⑤ 缺凭据 healthCheck: ok=%s reason=%s', (await noKeyAsr.healthCheck()).ok, (await noKeyAsr.healthCheck()).reason ?? '');

// 汇总（ASR 不可用时的诚实降级：本地 faster-whisper 仍是首选）
console.log('---');
console.log('★ 汇总: TTS 字节=%d（>0 %s）| ASR 文本长度=%d | 闭环（TTS→ASR）%s', bytes, bytes > 0, text.length, text.length > 0 ? '成功' : '失败');

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
process.exit(0);
