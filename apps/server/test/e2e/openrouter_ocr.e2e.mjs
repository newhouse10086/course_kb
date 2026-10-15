/**
 * ★ OpenRouter OCR **真实调用证据**（显式跑；预计 3 次调用：glm 识别截图 + glm 空白图 + gemini 备选）
 *
 * 用 Lead 实测过的那张中文 UI 截图 `apps/web/test/screenshots/docs-dark.png`。
 * 覆盖 Lead 指定：真实调用（模型/耗时/token/文本片段）· **空白图负例** ·
 * `box`/`confidence` 的如实处理 · 降级链（首选 → 备选）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'or-ocr-'));

const { loadConfig } = await imp('apps/server/src/config.ts');
const { createOpenRouterOcr, OPENROUTER_OCR_MODEL_PRIMARY, OPENROUTER_OCR_MODEL_FALLBACK } = await imp(
  'apps/server/src/providers/openrouter_ocr.ts',
);

const cfg = loadConfig({ root: ROOT, env: { ...process.env, COURSE_KB_DATA_DIR: tmp } });
const entries = (cfg.providers.providers.ocr ?? []).filter((p) => p.type === 'openrouter_ocr');
console.log('配置: %s', entries.map((e) => `${e.id}[${e.options.model}]`).join(' | '));
const glm = entries.find((e) => String(e.options.model) === OPENROUTER_OCR_MODEL_PRIMARY);
const gem = entries.find((e) => String(e.options.model) === OPENROUTER_OCR_MODEL_FALLBACK);

const SHOT = path.join(ROOT, 'apps', 'web', 'test', 'screenshots', 'docs-dark.png');
console.log('截图存在 = %s (%d 字节)', fs.existsSync(SHOT), fs.existsSync(SHOT) ? fs.statSync(SHOT).size : 0);

/** 真跑一次识别并计时；返回 {text, ms, provider} */
async function runOcr(label, entry, imagePath) {
  const ocr = createOpenRouterOcr(entry);
  const t0 = Date.now();
  const out = await ocr.recognize({ imagePath, language: 'zh' });
  const ms = Date.now() - t0;
  console.log(
    '%s: %dms | provider=%s | 文本 %d 字 | blocks=%s | 含"缺少 BAIDU_OCR_KEY"=%s',
    label,
    ms,
    out.usedProvider,
    out.text.length,
    out.blocks === undefined ? '未提供（★ 不伪造 box/confidence）' : JSON.stringify(out.blocks).slice(0, 60),
    out.text.includes('BAIDU_OCR_KEY'),
  );
  console.log('   片段: %s', JSON.stringify(out.text.slice(0, 160)));
  console.log('   degradedReason: %s', String(out.degradedReason ?? '(无)').slice(0, 120));
  return { out, ms };
}

// ── ① 首选模型识别真实中文 UI 截图 ──
const r1 = await runOcr('① glm-5.3-flash 识别截图', glm, SHOT);

// ── ② 空白图负例（编造防线，真机）──
const blank = path.join(tmp, 'blank.png');
spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=320x200', '-frames:v', '1', blank], { windowsHide: true });
const r2 = await runOcr('② glm-5.3-flash 空白图', glm, blank);
console.log('   ★ 空白图判定: text 为空 = %s（必须 true）| usedProvider 如实 = %s', r2.out.text.trim() === '', r2.out.usedProvider === glm.id);

// ── ③ 备选模型（降级链第二档，真机）──
const r3 = await runOcr('③ gemini-2.5-flash-lite 识别截图（备选）', gem, SHOT);

// ── ④ 探测（healthCheck，各一次真调用）──
for (const [label, e] of [['glm', glm], ['gemini', gem]]) {
  const ocr = createOpenRouterOcr(e);
  const t0 = Date.now();
  const hc = await ocr.healthCheck();
  console.log('④ %s healthCheck: ok=%s | %dms | probe=%s | reason=%s', label, hc.ok, Date.now() - t0, hc.probe, hc.reason ?? '(无)');
}

console.log('---');
console.log('★ 汇总（真机）');
console.log('  首选 %s: %dms | %d 字 | 命中关键词=%s', OPENROUTER_OCR_MODEL_PRIMARY, r1.ms, r1.out.text.length, r1.out.text.includes('BAIDU_OCR_KEY'));
console.log('  空白图: %dms | text 空=%s | usedProvider=%s', r2.ms, r2.out.text.trim() === '', r2.out.usedProvider);
console.log('  备选 %s: %dms | %d 字 | 命中关键词=%s', OPENROUTER_OCR_MODEL_FALLBACK, r3.ms, r3.out.text.length, r3.out.text.includes('BAIDU_OCR_KEY'));
console.log('  ★ 坐标/置信度: blocks 一律未提供 = %s（不伪造）', r1.out.blocks === undefined && r2.out.blocks === undefined && r3.out.blocks === undefined);

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
process.exit(0);
