/**
 * ★★ 云端 OCR 代价估算的**跨语言一致性**测试（Lead 裁定 (b) 的落地）。
 *
 * ## 它解决什么问题
 * "同一个数写在两个地方" = **两个真相**（坑 24 家族：改一处忘另一处就撒谎）。
 * 今晚真实发生过：
 * ```
 * worker/adapters/pdf.py  CLOUD_OCR_SECS_PER_PAGE_EST = 1.5
 * routes/documents.ts     里又写了 1.21                     ← 同一个数，两个来源
 * ```
 * 当时我改了 worker 却没同步 Node 侧 → **估算会撒谎，而且不报错**。
 *
 * ## 判据（不是"记得改"，而是"改了一定红"）
 * 1. **Node 侧常量与 worker 侧常量逐项相等**（**真读 Python 文件解析出值**，不硬编码）；
 * 2. **`usdPerPage` 必须等于用 token 口径独立复算的结果**（防止"单价对了乘法错了"）；
 * 3. 434 页的 est_minutes 区间必须与常量**自洽**（不是硬编码 [7,11]）。
 *
 * ⚠️ 为什么"真解析 Python 文件"而不是共享 JSON：
 * 共享 JSON 更彻底，但今晚 8 条线并行时动配置文件风险更高；
 * 本测试同样能**防漂移**（改任意一侧 → 必红），成本低得多。Lead 同意此取舍。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { OCR_CLOUD_EST } from '../src/routes/documents.ts';
import { findRoot } from '../src/config.ts';

/** 从 `worker/adapters/pdf.py` 解析出一个 `NAME = <number>` 常量的值。 */
function readWorkerConst(name: string): number {
  const root = findRoot();
  const py = path.join(root, 'worker', 'adapters', 'pdf.py');
  const src = fs.readFileSync(py, 'utf8');
  const m = new RegExp(`^${name}\\s*=\\s*([0-9_.]+)`, 'm').exec(src);
  assert.ok(m, `worker/adapters/pdf.py 里找不到常量 ${name}`);
  return Number(String(m[1]).replace(/_/g, ''));
}

test('★★ 跨语言一致性：Node 侧 OCR 估算常量 == worker 侧常量（防"两处真相"）', () => {
  // ① 每页耗时：Node 的"保守侧"必须等于 worker 的估算常量
  assert.equal(
    OCR_CLOUD_EST.secsPerPageHi,
    readWorkerConst('CLOUD_OCR_SECS_PER_PAGE_EST'),
    'Node 的 secsPerPageHi 必须与 worker 的 CLOUD_OCR_SECS_PER_PAGE_EST 一致 —— ' +
      '不一致说明只改了一处（今晚真实发生过）',
  );

  // ② 每页 token：两边必须是同一组实测值
  assert.equal(OCR_CLOUD_EST.promptTokensPerPage, readWorkerConst('CLOUD_OCR_PROMPT_TOKENS_PER_PAGE'));
  assert.equal(OCR_CLOUD_EST.completionTokensPerPage, readWorkerConst('CLOUD_OCR_COMPLETION_TOKENS_PER_PAGE'));

  // ③ 单价：必须一致
  assert.equal(OCR_CLOUD_EST.usdPerMInput, readWorkerConst('CLOUD_OCR_USD_PER_M_INPUT'));
  assert.equal(OCR_CLOUD_EST.usdPerMOutput, readWorkerConst('CLOUD_OCR_USD_PER_M_OUTPUT'));
});

test('★★ usdPerPage 必须等于用 token 口径独立复算的结果（防"单价对了、乘法错了"）', () => {
  const expect =
    (OCR_CLOUD_EST.promptTokensPerPage / 1_000_000) * OCR_CLOUD_EST.usdPerMInput +
    (OCR_CLOUD_EST.completionTokensPerPage / 1_000_000) * OCR_CLOUD_EST.usdPerMOutput;
  // 允许 1% 相对误差（常量是四舍五入过的）
  const rel = Math.abs(OCR_CLOUD_EST.usdPerPage - expect) / expect;
  assert.ok(
    rel < 0.01,
    `每页单价 ${OCR_CLOUD_EST.usdPerPage} 与独立复算 ${expect.toFixed(6)} 差 ${(rel * 100).toFixed(1)}%`,
  );
});

test('★ 输出单价必须高于输入单价 —— 否则"必须分开算"这个前提变了，需人工复核', () => {
  assert.ok(
    OCR_CLOUD_EST.usdPerMOutput > OCR_CLOUD_EST.usdPerMInput,
    '若输出≤输入，则"只按单一单价估算会低估"这一结论不再成立 → 请复核注释与文档',
  );
});

test('★ 434 页的 est_minutes 区间必须与常量自洽（不是硬编码 [7,11]）', () => {
  const pages = 434;
  const lo = Math.max(1, Math.round((pages * OCR_CLOUD_EST.secsPerPageLo) / 60));
  const hi = Math.max(1, Math.round((pages * OCR_CLOUD_EST.secsPerPageHi) / 60));
  // 自洽性：用常量重算，必须与文档里承诺的口径一致
  assert.equal(lo, Math.round((434 * 1.0) / 60));
  assert.equal(hi, Math.round((434 * 1.5) / 60));
  // 云端区间应显著小于旧的本地口径（65~87 分钟）—— 换云端的收益要体现在数字上
  assert.ok(hi < 20, `434 页云端上限应 < 20 分钟，实际 ${hi}（若 ≥20 说明常量没跟上换云端）`);
  // 每页费用 × 页数 与 est_usd 口径一致
  const usd434 = Math.round(pages * OCR_CLOUD_EST.usdPerPage * 10000) / 10000;
  assert.ok(usd434 > 0.5 && usd434 < 0.7, `434 页费用应约 $0.57，实际 $${usd434}`);
});

test('★ 旧值不复存在：不许残留"本地 OCR 9–12 秒/页"的口径', () => {
  const root = findRoot();
  const src = fs.readFileSync(path.join(root, 'apps', 'server', 'src', 'routes', 'documents.ts'), 'utf8');
  // 这些字样在换云端后就是错的（会误导用户"不花钱、等一小时"）
  assert.ok(!/走\*\*本地 OCR\*\*/.test(src), 'documents.ts 仍在说"走本地 OCR" —— 已改云端，须删');
  assert.ok(!/不消耗 LLM 额度，但会占用 CPU/.test(src), '文档仍在用本地 OCR 的旧口径文案');
  // 必须声明"以账单为准"（估算 ≠ 账单）
  assert.ok(/以 OpenRouter 账单为准/.test(src), '必须声明估算 ≠ 账单');
});
