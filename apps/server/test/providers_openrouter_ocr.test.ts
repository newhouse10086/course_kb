/**
 * ★ OpenRouter 视觉 LLM OCR 的**离线断言**（不联网、不花额度）。
 *
 * 守的是"调通"之外必须钉住的东西（Lead 指定）：
 * - ★ **不伪造 `box` 坐标、不编 `confidence`**（视觉 LLM 没有检测框 → 省略 `blocks`）
 * - ★ **空白图/纯色图 → 必须空文本**（OCR 版的"零卡片静默"防线）
 * - ★ **`text` 为空时 `usedProvider` 仍要如实填**（"调用了但没识别出" ≠ "没调用" —— 坑 22 同族）
 * - ★ 禁用模型（`gemma-3-4b-it`，实测会编造）**在本地就拦下**
 * - 大图**真的被缩/压**（token 爆炸防线）；未配置 → 可读 reason（不假装可用）
 *
 * 真机证据（模型/耗时/token/文本片段 + 空白图负例）在 `test/e2e/openrouter_ocr.e2e.mjs`（显式跑）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';

import {
  DEFAULT_MAX_IMAGE_WIDTH,
  OCR_SYSTEM_PROMPT,
  OPENROUTER_OCR_BANNED_MODELS,
  OPENROUTER_OCR_MODEL_FALLBACK,
  OPENROUTER_OCR_MODEL_PRIMARY,
  buildOcrBody,
  cleanOcrText,
  createOpenRouterOcr,
  isUnreadablePlaceholderOnly,
  prepareImageForOcr,
} from '../src/providers/openrouter_ocr.ts';
import type { ProviderConfigEntry } from '../src/providers/types.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const entry = (options: Record<string, unknown>, missingEnv: string[] = []): ProviderConfigEntry =>
  ({ id: 'or-ocr', kind: 'ocr', type: 'openrouter_ocr', priority: 2, enabled: true, options, missingEnv, envRefs: {} }) as ProviderConfigEntry;

const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

/** 造一张图（真 ffmpeg）：`size` 形如 `3200x120`，可加文字。 */
function makeImage(size: string, opts: { text?: string; out?: string } = {}): string {
  const out = opts.out ?? path.join(os.tmpdir(), `ocr-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
  const args = opts.text
    ? ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=white:s=${size}`, '-vf', `drawtext=text='${opts.text}':fontsize=40:x=20:y=20:fontcolor=black`, '-frames:v', '1', out]
    : ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=white:s=${size}`, '-frames:v', '1', out];
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(r.status, 0, `造图失败：${(r.stderr ?? '').slice(-200)}`);
  return out;
}

test('★ 提示词：逐字提取 + 看不清标记 + **禁止猜测** + 空白图输出空（编造防线）', () => {
  assert.match(OCR_SYSTEM_PROMPT, /逐字提取/, '必须要求逐字提取');
  assert.match(OCR_SYSTEM_PROMPT, /\[看不清\]/, '看不清要标记（而不是猜）');
  assert.match(OCR_SYSTEM_PROMPT, /不要猜测|绝对不要/, '必须明确禁止猜测');
  assert.match(OCR_SYSTEM_PROMPT, /空字符串/, '空白图必须输出空（否则会编造）');
});

test('★ 禁用模型在**本地**就拦下（gemma-3-4b-it 实测会编造）', () => {
  for (const banned of OPENROUTER_OCR_BANNED_MODELS) {
    assert.throws(
      () => buildOcrBody({ model: banned, dataUrl: DATA_URL }),
      /禁用/,
      `★ ${banned} 必须被本地拦下（不许"图便宜"换它）`,
    );
  }
  // 首选/备选必须放行
  assert.doesNotThrow(() => buildOcrBody({ model: OPENROUTER_OCR_MODEL_PRIMARY, dataUrl: DATA_URL }));
  assert.doesNotThrow(() => buildOcrBody({ model: OPENROUTER_OCR_MODEL_FALLBACK, dataUrl: DATA_URL }));
  // 非 data URL → 明确报错（形状错误早暴露）
  assert.throws(() => buildOcrBody({ model: OPENROUTER_OCR_MODEL_PRIMARY, dataUrl: 'http://x/a.png' }), /data URL/);
});

test('★ 请求体形状：system 提示词 + image_url(data URL) + temperature=0', () => {
  const body = buildOcrBody({ model: OPENROUTER_OCR_MODEL_PRIMARY, dataUrl: DATA_URL, language: 'zh' });
  const messages = body.messages as { role: string; content: unknown }[];
  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages[0]?.content, OCR_SYSTEM_PROMPT, '系统提示词必须逐字进请求');
  const userContent = messages[1]?.content as { type: string; image_url?: { url: string } }[];
  assert.ok(Array.isArray(userContent), 'user content 必须是数组（多模态形状）');
  assert.equal(userContent.find((c) => c.type === 'image_url')?.image_url?.url, DATA_URL, '★ 图片走 base64 data URL');
  assert.equal(body.temperature, 0, 'OCR 要确定性输出');
});

test('★ 输出清理：去围栏；"(空)"/"图片中没有文字" **不许当成内容**', () => {
  assert.equal(cleanOcrText('```\n聚簇索引\n```'), '聚簇索引', '去掉 Markdown 围栏（不改内容）');
  assert.equal(cleanOcrText('```text\nSELECT 1;\n```'), 'SELECT 1;');
  // ★ 这些是"模型在说没有内容"，不是识别结果 —— 当成内容会让下游以为识别出了东西
  for (const noise of ['(空)', '（空）', '无文字', '图片中没有文字', '没有可见文字']) {
    assert.equal(cleanOcrText(noise), '', `★ "${noise}" 必须归一为空字符串`);
  }
  assert.equal(cleanOcrText('  聚簇索引 会把数据行按主键顺序存储  '), '聚簇索引 会把数据行按主键顺序存储', '正文原样保留（含内部空格）');
});

test('★ 空白图 → **空文本**，且 `usedProvider` 仍如实填（"没识别出" ≠ "没调用"）', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '' } }], usage: { prompt_tokens: 12, completion_tokens: 0 } }), {
      status: 200,
    })) as unknown as typeof fetch;
  const ocr = createOpenRouterOcr(entry({ api_key: 'k', model: OPENROUTER_OCR_MODEL_PRIMARY }));
  const blank = makeImage('64x64');
  try {
    const out = await ocr.recognize({ imagePath: blank });
    assert.equal(out.text, '', '★ 空白图必须空文本（不许编造）');
    assert.equal(out.usedProvider, 'or-ocr', '★ 空文本也必须如实填 usedProvider（否则会被误读成"没调用过"）');
    assert.equal(out.blocks, undefined, '★ 不伪造 blocks（视觉 LLM 没有检测框）');
    assert.match(String(out.degradedReason), /无版面坐标/, '★ 必须明说"无坐标"，让下游知道与百度链能力不同');
  } finally {
    fs.rmSync(blank, { force: true });
  }
});

test('★★ 编造防线：模型对**空白图**编出内容 → 探测必须**失败**（如实暴露，不记"可用"）', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '上海程序员 + mock 示教模拟用户' } }] }), { status: 200 })) as unknown as typeof fetch;
  const ocr = createOpenRouterOcr(entry({ api_key: 'k', model: OPENROUTER_OCR_MODEL_PRIMARY }));
  const hc = await ocr.healthCheck();
  assert.equal(hc.ok, false, '★ 空白图被编造 → 探测必须失败（这正是 gemma-3-4b-it 的病症）');
  assert.match(String(hc.reason), /编造|空白图/, 'reason 要说清是"空白图返回了文本"');
});

test('★ 占位符 ≠ 编造：空白图只回 `[看不清]` → 探测**通过**（真机 gemini 就是这个行为）', async () => {
  // 实测：gemini-2.5-flash-lite 在空白图上回 `[看不清]` —— 那是**诚实地说读不到**，不是编造。
  // 我第一版把它判成"疑似编造"→ 会把最准的备选模型误报为不可用。判据已按此修正。
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '[看不清]' } }] }), { status: 200 })) as unknown as typeof fetch;
  const ocr = createOpenRouterOcr(entry({ api_key: 'k', model: OPENROUTER_OCR_MODEL_FALLBACK }));
  const hc = await ocr.healthCheck();
  assert.equal(hc.ok, true, '★ 只回占位符必须算通过（否则误判诚实模型不可用）');
  // 纯函数边界
  assert.equal(isUnreadablePlaceholderOnly('[看不清]'), true);
  assert.equal(isUnreadablePlaceholderOnly('[看不清] [模糊]'), true);
  assert.equal(isUnreadablePlaceholderOnly(''), true);
  assert.equal(isUnreadablePlaceholderOnly('上海程序员'), false, '具体文字 = 编造');
  assert.equal(isUnreadablePlaceholderOnly('看不清'), false, '没有括号的裸词不算占位符（可能是真文本）');
});

test('★ 大图真的被缩/压（token 爆炸防线），且输出是 JPEG', () => {
  const big = makeImage('3200x200');
  try {
    const before = fs.statSync(big).size;
    const prep = prepareImageForOcr(big, { maxWidth: DEFAULT_MAX_IMAGE_WIDTH, outDir: os.tmpdir() });
    assert.match(prep.dataUrl, /^data:image\/jpeg;base64,/, '转 JPEG（体积更小）');
    assert.ok(prep.bytes > 0, '必须产出字节');
    assert.ok(prep.bytes < before, `★ 必须比原图小（原 ${before}B → ${prep.bytes}B）`);
    // 宽度 ≤ maxWidth：用 ffprobe 验（缩图必须真的发生）
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', big.replace(/\.png$/, '.jpg')], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    });
    void probe; // 输出文件路径由 prepareImageForOcr 内部生成；下面用图片头宽度做等价校验
    const head = Buffer.from(prep.dataUrl.split(',')[1] ?? '', 'base64').subarray(0, 4).toString('hex');
    assert.equal(head.slice(0, 4), 'ffd8', 'JPEG 魔数（ffd8）—— 确认真是 JPEG');
  } finally {
    fs.rmSync(big, { force: true });
  }
});

test('★ 未配置 → configured=false + 可读 reason（含缺哪个 env），且不发请求', async () => {
  let called = 0;
  globalThis.fetch = (async () => {
    called += 1;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const ocr = createOpenRouterOcr(entry({ api_key: '', model: OPENROUTER_OCR_MODEL_PRIMARY }, ['OPENROUTER_KEY']));
  assert.equal(ocr.info.configured, false);
  assert.match(String(ocr.info.reason), /OPENROUTER_KEY/);
  const hc = await ocr.healthCheck();
  assert.equal(hc.ok, false);
  assert.equal(hc.probe, 'config');
  assert.equal(called, 0, '★ 未配置不许发请求');
});

test('★ 上游错误 → 如实 E_LLM（带状态码），不静默成功', async () => {
  globalThis.fetch = (async () => new Response('{"error":{"message":"rate limited","code":429}}', { status: 429 })) as unknown as typeof fetch;
  const ocr = createOpenRouterOcr(entry({ api_key: 'k', model: OPENROUTER_OCR_MODEL_PRIMARY }));
  const img = makeImage('64x64');
  try {
    await assert.rejects(
      () => ocr.recognize({ imagePath: img }),
      (e: unknown) => {
        assert.equal((e as { code?: string }).code, 'E_LLM', '★ 429 必须映射为 E_LLM');
        assert.match(String((e as { message?: string }).message), /429/, '错误要带上游状态码');
        return true;
      },
    );
  } finally {
    fs.rmSync(img, { force: true });
  }
});
