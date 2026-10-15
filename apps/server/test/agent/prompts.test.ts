/**
 * ★ 渲染契约提示词 + **客观判据**（`auditRenderFormat`）。
 *
 * 为什么需要：前端用 **KaTeX**（只认 `$...$`/`$$...$$`）、按语言高亮代码块、markmap 渲导图、
 * `[[card:…]]` 渲跳转引用 —— **模型不知道这些**，默认会吐 `\(...\)`、漏代码块结尾的 ```。
 *
 * ⚠️ 提示词只是"要求"；**是否做到要事后检查**（坑 21 同族：说了 ≠ 生效）。
 * 所以本文件同时提供 `auditRenderFormat()` / `auditNoFabricatedFormula()` 作为**客观判据**，
 * 供真机 e2e 断言（不靠人眼看）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_ASSISTANT_SYSTEM_PROMPT,
  RENDER_CONTRACT,
  VIDEO_ASSISTANT_SYSTEM_PROMPT,
  auditNoFabricatedFormula,
  auditRenderFormat,
  withRenderContract,
} from '../../src/agent/prompts.ts';

test('★ 契约覆盖 web-ui 的 5 条渲染要求（逐条对应，漏一条就会在真机露出）', () => {
  // 1 公式定界符
  assert.match(RENDER_CONTRACT, /\$\.\.\.\$/);
  assert.match(RENDER_CONTRACT, /\$\$\.\.\.\$\$/);
  assert.match(RENDER_CONTRACT, /KaTeX/);
  assert.match(RENDER_CONTRACT, /\\text\{聚簇索引\}/, '要给出中文混排示例');
  // 2 代码块：语言 + **必须闭合**
  assert.match(RENDER_CONTRACT, /```sql/);
  assert.match(RENDER_CONTRACT, /必须闭合/);
  assert.match(RENDER_CONTRACT, /结尾的 ``` 一定要写/);
  // 3 导图：markmap 兼容 + 时间戳
  assert.match(RENDER_CONTRACT, /markmap/);
  assert.match(RENDER_CONTRACT, /03:12/, '要给时间戳写法示例（前端靠它生成 ▶ 按钮）');
  // 4 引用锚点
  assert.match(RENDER_CONTRACT, /\[\[card:crd_/);
  // 5 不许编造公式
  assert.match(RENDER_CONTRACT, /文稿中未出现/);
  assert.match(RENDER_CONTRACT, /宁缺勿编/);
});

test('★ 禁止项要**明确写出**（不写模型会继续用 \\(...\\)）', () => {
  // ⚠️ 这里刻意**不用正则**：`\\(` 在正则字面量里要写 4 个反斜杠，极易写错成"看起来对但不匹配"。
  //    直接判定子串，语义一样强且没有转义陷阱。
  const banIdx = RENDER_CONTRACT.indexOf('禁止');
  const parenLatexIdx = RENDER_CONTRACT.indexOf('\\(');
  assert.ok(banIdx >= 0, '契约必须出现"禁止"');
  assert.ok(parenLatexIdx > banIdx, '必须在"禁止"之后明确写出 \\(...\\) 这种**不可用**的写法');
  assert.ok(RENDER_CONTRACT.includes('\\['), '块级 \\[...\\] 也要点名禁止');
  assert.match(RENDER_CONTRACT, /原样显示成文本/);
});

test('★ 三个提示词都能用，且视频助手带"只依据文稿 + 时间戳指位"', () => {
  assert.match(VIDEO_ASSISTANT_SYSTEM_PROMPT, /视频文稿/);
  assert.match(VIDEO_ASSISTANT_SYSTEM_PROMPT, /不要用你的通用知识补/);
  assert.match(VIDEO_ASSISTANT_SYSTEM_PROMPT, /mm:ss/);
  assert.match(VIDEO_ASSISTANT_SYSTEM_PROMPT, /输出格式契约/, '视频助手必须带渲染契约');
  assert.match(CHAT_ASSISTANT_SYSTEM_PROMPT, /输出格式契约/);
});

test('★ withRenderContract 幂等（重复调用不会叠加两份契约）', () => {
  const once = withRenderContract('基础提示词');
  const twice = withRenderContract(once);
  assert.equal(twice, once);
  assert.equal(once.match(/输出格式契约/g)?.length, 1);
});

test('★★ auditRenderFormat：正确输出 → 0 违规（含公式/代码块/引用/时间戳）', () => {
  const good = [
    '聚簇索引的查找复杂度是 $O(\\log n)$，其中 $\\text{聚簇索引}$ 决定物理顺序。',
    '',
    '块级公式：',
    '$$T(n) = O(n \\log n)$$',
    '',
    '```sql',
    'SELECT * FROM t WHERE id = 1;',
    '```',
    '',
    '- 03:12 聚簇索引 [[card:crd_0001]]',
  ].join('\n');
  const r = auditRenderFormat(good);
  assert.deepEqual(r.violations, []);
  assert.equal(r.ok, true);
  assert.equal(r.observed.inlineMath >= 2, true);
  assert.equal(r.observed.blockMath, 1);
  assert.equal(r.observed.fencesOpened, 1);
  assert.equal(r.observed.fencesClosed, 1);
  assert.equal(r.observed.fencesWithLang, 1);
  assert.deepEqual(r.observed.citations, ['[[card:crd_0001]]']);
  assert.ok(r.observed.timestamps.includes('03:12'));
});

test('★★ auditRenderFormat：`\\(...\\)` 与 `\\[...\\]` 必须被抓出来（KaTeX 不认）', () => {
  const bad = '行内用 \\(O(n)\\) 写的，块级用 \\[O(n^2)\\] 写的。';
  const r = auditRenderFormat(bad);
  assert.equal(r.ok, false);
  assert.equal(r.observed.latexParen, 1);
  assert.equal(r.observed.latexBracket, 1);
  assert.deepEqual([...new Set(r.violations.map((v) => v.rule))], ['公式定界符']);
  assert.match(r.violations.map((v) => v.detail).join(' '), /\\\(/);
});

test('★★ auditRenderFormat：**漏掉代码块结尾** 与 **没标语言** 都要报（v1 真机就踩过）', () => {
  const unclosed = '看这段：\n```sql\nSELECT 1;\n\n（后面没有闭合围栏）';
  const r1 = auditRenderFormat(unclosed);
  assert.equal(r1.observed.unclosedFence, true);
  assert.match(r1.violations.map((v) => v.rule).join(','), /代码块闭合/);

  const noLang = '```\nSELECT 1;\n```';
  const r2 = auditRenderFormat(noLang);
  assert.match(r2.violations.map((v) => v.rule).join(','), /代码块语言/);
  assert.match(r2.violations.map((v) => v.detail).join(','), /没标语言/);
});

test('★ auditRenderFormat：没有公式/代码块时不该误报（空输出也是合法的）', () => {
  const r = auditRenderFormat('聚簇索引决定行的物理顺序。');
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

test('★★ auditNoFabricatedFormula：文稿里没有的公式，**必须显式说"未出现"**', () => {
  // 案例 A：回答里的公式在原文里 → 通过
  const okA = auditNoFabricatedFormula('原文说 $O(\\log n)$ 的查找代价。', ['索引查找代价为 O(\\log n)']);
  assert.equal(okA.ok, true);

  // 案例 B：回答编了一个原文没有的公式，**且没有说明** → 必须判失败
  const bad = auditNoFabricatedFormula('该算法复杂度为 $O(n^2 \\log n)$。', ['本节只讲了 B+ 树的结构']);
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /不在原文里也没有说明/);

  // 案例 C：同一个公式，但回答**如实说明"文稿中未出现"** → 通过（宁缺勿编）
  const honest = auditNoFabricatedFormula(
    '公式 $O(n^2 \\log n)$ 在文稿中未出现，我不敢替课程下结论；文稿只讲了 B+ 树的结构。',
    ['本节只讲了 B+ 树的结构'],
  );
  assert.equal(honest.ok, true);
  assert.match(honest.detail, /已显式说明/);

  // 案例 D：没有公式 → 无需校验
  assert.equal(auditNoFabricatedFormula('文稿没有提到任何公式。', []).ok, true);
});
