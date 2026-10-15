/**
 * OpenRouter **视觉 LLM OCR**（Lead 实测 5 个视觉模型后定的方案）。
 *
 * ## 模型选择（**实测结论**，不是元数据承诺 —— 坑 24）
 * ```
 * 首选  z-ai/glm-5.3-flash            3821ms  最快且准确（中文强、无编造）
 * 备选  google/gemini-2.5-flash-lite  5460ms  最准（连"缺少 BAIDU_OCR_KEY"都完整）→ 降级链第二档
 * ✗禁用 google/gemma-3-4b-it          3023ms  ★ **会编造原文没有的文字**
 *        （实测编出"上海程序员+mock"、"示教模拟用户"、伪造页数）—— **不许因为便宜换它**
 * ✗不用 qwen/qwen3.7-flash             19251ms 太慢（批量不可接受）
 * ✗不用 openai/gpt-4.1-nano            3423ms  漏内容（OCR 漏内容比慢更糟）
 * ```
 *
 * ## ★ 三条如实性约束（LLM 型 OCR 与检测框 OCR **能力不同**）
 * 1. **不伪造 `box` 坐标** —— 视觉 LLM 输出的是自由文本，**没有检测框**。
 *    填假坐标会让下游"点文字跳转"**静默指错位置**（典型"看起来成功"）。
 *    → 本实现**省略 `blocks`**（连 `text` 都不给块级切分），并在 `degradedReason` 里**明说**。
 * 2. **不编 `confidence`** —— LLM 不返回置信度，就不填。
 * 3. ★ **编造是最大风险** → 提示词明确要求"**逐字提取，看不清标 `[看不清]`，不要猜测**"，
 *    并且**空白图/纯色图必须返回空文本**（`test/providers_openrouter_ocr.test.ts` 有断言 ——
 *    这是 OCR 版的"零卡片静默"防线）。
 *
 * ## 图片体积
 * 大图会让 token 爆炸（Lead 实测 105KB PNG 用 1869–3819 prompt tokens）→
 * 先由 **ffmpeg 等比缩到 ≤`maxImageWidth`（默认 1600px）并转 JPEG**，再 base64 成 data URL。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CloudOcr } from './index.ts';
import type { ProviderConfigEntry } from './types.ts';
import { ProviderError } from './types.ts';

/**
 * 首选模型（**不要改**，见文件头实测表）
 *
 * ## ★ 2026-10-16 换为**国产模型**（用户要求："最好换成一个国产的"）
 *
 * 用户原话：**"ocr哪个模型不太可以哦。最好换成一个国产的哦，不用改太多，你看看有什么模型。对着文档改一下对应接口就行"**
 *
 * `[实测]` **本机真端点探测**（真实教材页 = 434 页扫描件第 30 页 + 空白图，见下表）：
 * | 模型 | 真实页 | 单页耗时 | prompt tok | completion tok | 空白图 |
 * |---|---|---|---|---|---|
 * | `qwen/qwen3-vl-235b-a22b-instruct` | **954 字符**（教材正文，无编造）| **1211ms** | 1457 | 533 | `""`（诚实）|
 * | `qwen/qwen3-vl-30b-a3b-instruct`   | **921 字符**（同上）        | **1344ms** | 1457 | 524 | `[看不清]`（诚实）|
 *
 * ⟹ **两个都通过**（HTTP 200 + 内容对得上 + 空白图不编造）→ 主/备**都改成国产**。
 * ★ 接口**一行未改** —— `buildOcrBody` 用的是标准 OpenAI 视觉格式，所有兼容模型通用
 *   （用户判断"不用改太多"是对的）。
 */
export const OPENROUTER_OCR_MODEL_PRIMARY = 'qwen/qwen3-vl-235b-a22b-instruct';
/**
 * 降级链第二档（更便宜，仍是国产 —— 原为 `google/gemini-2.5-flash-lite`，用户要求换国产）。
 * `[实测]` 真实页 921 字符、1344ms、空白图诚实 —— 与首选同档可用。
 */
export const OPENROUTER_OCR_MODEL_FALLBACK = 'qwen/qwen3-vl-30b-a3b-instruct';
/** ★ **禁用清单**（写进代码，防后人"图便宜"换它） */
export const OPENROUTER_OCR_BANNED_MODELS = ['google/gemma-3-4b-it'] as const;

export const DEFAULT_OPENROUTER_OCR_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_MAX_IMAGE_WIDTH = 1600;

/**
 * ★ **提示词**：逐字提取 + 看不清标记 + **禁止猜测**（Lead 实测这句有效）。
 * 另外明确"只输出正文"（避免模型加解释/评论，那会污染 `OcrResult.text`）。
 */
export const OCR_SYSTEM_PROMPT =
  '你是 OCR 引擎。请**逐字提取**图片中的所有可见文字，保持原有阅读顺序与换行。\n' +
  '规则：\n' +
  '1. **只输出提取到的文字本身**，不要任何解释、评论、前后缀、Markdown 围栏。\n' +
  '2. 看不清的字用 `[看不清]` 占位，**绝对不要猜测或补全**。\n' +
  '3. 图里没有文字（空白/纯色/纯图形）→ **输出空字符串**，不要编造任何内容。\n' +
  '4. 保留中英文与数字原样，不要翻译。';

function optStr(o: Record<string, unknown>, key: string, fallback = ''): string {
  const v = o[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
}
function optNum(o: Record<string, unknown>, key: string, fallback: number): number {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** 构造视觉请求体（纯函数 → 可断言，不需要网络）。 */
export function buildOcrBody(args: { model: string; dataUrl: string; language?: string }): Record<string, unknown> {
  if (OPENROUTER_OCR_BANNED_MODELS.includes(args.model as (typeof OPENROUTER_OCR_BANNED_MODELS)[number])) {
    // ★ 在**本地**就拦下"图便宜换编造模型"（不让它发出去）
    throw new ProviderError(
      'E_CAPABILITY',
      `模型 ${args.model} 已被禁用（实测会编造原文没有的文字）`,
      `禁用清单：${OPENROUTER_OCR_BANNED_MODELS.join(', ')}；请用 ${OPENROUTER_OCR_MODEL_PRIMARY} 或 ${OPENROUTER_OCR_MODEL_FALLBACK}`,
    );
  }
  if (!args.dataUrl.startsWith('data:image/')) {
    throw new ProviderError('E_CAPABILITY', '图片必须是 base64 data URL', '形状：data:image/png;base64,…');
  }
  return {
    model: args.model,
    temperature: 0,
    messages: [
      { role: 'system', content: OCR_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: args.language ? `语言提示：${args.language}` : '请提取这张图片里的全部文字。' },
          { type: 'image_url', image_url: { url: args.dataUrl } },
        ],
      },
    ],
  };
}

/** 清理模型输出：去掉可能被套上的 Markdown 围栏与首尾空白（**不改内容**）。 */
export function cleanOcrText(raw: string): string {
  let t = (raw ?? '').trim();
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/;
  const m = t.match(fence);
  if (m) t = (m[1] ?? '').trim();
  // 模型有时会回 "(空)" / "图片中没有文字" 之类 → **不能当成文字内容**（否则下游以为识别出了东西）
  if (/^(（?空）?|\(空\)|无文字|图片中没有?文字|没有?可见文字|\[空\])$/.test(t)) return '';
  return t;
}

/**
 * 输出是否**只是"看不清"占位符**（没有编造真实内容）。
 *
 * 为什么要区分：`[看不清]` 是**提示词允许的表达**（"这里有字但我认不出"）——
 * 空白图上回它，是"诚实地说读不到"，**不是编造**；
 * 而回"上海程序员+mock"那种**具体文字**才是编造（`gemma-3-4b-it` 实测病症）。
 * 探测若把两者一视同仁，会把诚实模型误判为不可用（我第一版就是这样把 gemini 判 false 的）。
 */
export function isUnreadablePlaceholderOnly(text: string): boolean {
  const t = (text ?? '').trim();
  if (t === '') return true;
  // 允许：连续的 [看不清]/[模糊]/[无法识别] 占位符（含中英文括号），中间可有空白
  return /^(\s*[\[(【]\s*(看不清|模糊|无法识别|unreadable|illegible)\s*[\])】]\s*)+$/i.test(t);
}

/** 等比缩到 ≤maxWidth 并转 JPEG（**减小 token**）；已是小图则原样返回。 */
export function prepareImageForOcr(
  imagePath: string,
  opts: { maxWidth?: number; outDir?: string } = {},
): { dataUrl: string; bytes: number; width?: number; resized: boolean } {
  const maxWidth = opts.maxWidth ?? DEFAULT_MAX_IMAGE_WIDTH;
  const before = fs.statSync(imagePath).size;
  const outDir = opts.outDir ?? os.tmpdir();
  const outPath = path.join(outDir, `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
  // `scale='min(iw,N)':-2` → 只缩不放，保持偶数高度（JPEG 要求）
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', imagePath, '-vf', `scale='min(iw,${maxWidth})':-2`, '-q:v', '4', outPath],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
  if (r.status !== 0 || !fs.existsSync(outPath)) {
    throw new ProviderError('E_PROVIDER', '图片预处理失败（ffmpeg）', (r.stderr ?? '').slice(-300));
  }
  const bytes = fs.statSync(outPath).size;
  const dataUrl = `data:image/jpeg;base64,${fs.readFileSync(outPath).toString('base64')}`;
  return { dataUrl, bytes, resized: bytes !== before || path.extname(imagePath).toLowerCase() !== '.jpg' };
}

export function createOpenRouterOcr(entry: ProviderConfigEntry): CloudOcr {
  const o = entry.options ?? {};
  const baseUrl = optStr(o, 'base_url', DEFAULT_OPENROUTER_OCR_BASE_URL).replace(/\/+$/, '');
  const apiKey = optStr(o, 'api_key');
  const model = optStr(o, 'model', OPENROUTER_OCR_MODEL_PRIMARY);
  const maxWidth = optNum(o, 'max_image_width', DEFAULT_MAX_IMAGE_WIDTH);
  const missing = entry.missingEnv ?? [];
  const notConfiguredReason =
    apiKey === ''
      ? missing.length > 0
        ? `OpenRouter 凭据缺失：${missing.join(', ')}（请在 .env 配置，勿提交）`
        : 'OpenRouter 凭据未配置（.env 的 OPENROUTER_KEY）'
      : undefined;

  const recognize = async (req: { imagePath: string; language?: string; signal?: AbortSignal }) => {
    const prep = prepareImageForOcr(req.imagePath, { maxWidth });
    const body = buildOcrBody({ model, dataUrl: prep.dataUrl, ...(req.language ? { language: req.language } : {}) });
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!resp.ok) {
      const text = (await resp.text()).slice(0, 400);
      throw new ProviderError('E_LLM', `OpenRouter OCR HTTP ${resp.status}: ${text}`, '检查 OPENROUTER_KEY 与模型可用性');
    }
    const j = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = cleanOcrText(j.choices?.[0]?.message?.content ?? '');
    /**
     * ★ **不填 `blocks`**（→ 不伪造 `box`、不编 `confidence`）。
     *
     * 视觉 LLM 给不出检测框；填假坐标会让"点文字跳转"静默指错位置。
     * 代价（无坐标）**如实写进 `degradedReason`**，让下游知道"这条链能力与百度不同"。
     *
     * ⚠️ 另外：**即使 `text` 为空也必须正常返回**（不抛错）——
     * "调用了但没识别出内容"（空白图）与"没调用"是两件事（坑 22 同族）；
     * `usedProvider` 由 `CloudOcr` 壳填成 `entry.id`，调用方据此知道**是哪个模型返回的空**。
     */
    return {
      text,
      degradedReason:
        'LLM 型 OCR：无版面坐标（`blocks[].box` 不可用，故意不伪造）；也无置信度。需要坐标请用有检测框的 OCR（如百度 OCR）',
      ...(j.usage ? { usage: { promptTokens: j.usage.prompt_tokens ?? 0, completionTokens: j.usage.completion_tokens ?? 0 } } : {}),
    } as Omit<import('./types.ts').OcrResult, 'usedProvider'>;
  };

  return new CloudOcr({
    id: entry.id,
    label: String(o.label ?? `OpenRouter OCR（${model}）`),
    vendor: 'OpenRouter',
    runtime: 'cloud',
    languages: ['zh', 'en'],
    pricing: { unit: 'per_1k_tokens', amount: 0.0001, currency: 'USD' },
    ...(notConfiguredReason ? { notConfiguredReason } : {}),
    /**
     * ★ **真探测**：用一张**极小空白图**真发一次请求 —— 同时验证
     * ① 凭据/模型可用；② **空白图确实返回空文本**（编造防线）。
     * 若模型对空白图编出内容 → 探测**失败**（如实暴露，而不是记一条"可用"）。
     */
    probe: async (signal) => {
      const blank = path.join(os.tmpdir(), `ocr-probe-${Date.now()}.png`);
      try {
        const r = spawnSync(
          'ffmpeg',
          ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=64x64', '-frames:v', '1', blank],
          { encoding: 'utf8', timeout: 30_000, windowsHide: true },
        );
        if (r.status !== 0) throw new ProviderError('E_PROVIDER', '探测用空白图生成失败（ffmpeg）', (r.stderr ?? '').slice(-200));
        const out = await recognize({ imagePath: blank, signal });
        // ★ 判据：空白图上**不许产出具体文字**；但**只有"看不清"占位符算诚实**（见 `isUnreadablePlaceholderOnly`）
        if (!isUnreadablePlaceholderOnly(out.text)) {
          throw new ProviderError(
            'E_PROVIDER',
            `空白图竟返回了文本（疑似编造）：${out.text.slice(0, 60)}`,
            '视觉模型不该在空白图上产出**具体内容**（只回 [看不清] 这类占位符是允许的）；换模型或加严提示词',
          );
        }
      } finally {
        try {
          fs.rmSync(blank, { force: true });
        } catch {
          /* ignore */
        }
      }
    },
    recognize: (req) => recognize(req as never),
  });
}
