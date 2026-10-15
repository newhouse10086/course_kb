/**
 * 渲染契约提示词 —— **前端用什么渲染，提示词就必须要求什么**。
 *
 * 背景：前端（`apps/web`）用 **KaTeX** 渲公式、按语言高亮代码块、把 markmap 层级渲成思维导图、
 * 把 `[[card:crd_…]]` 渲成可跳转引用。**模型不知道这些** ——
 * 它默认可能吐 `\(...\)`（KaTeX 不认，会原样显示）、漏掉代码块结尾的 ```（整段格式崩）、
 * 用普通列表当导图（没有跳转按钮）。所以这些**必须写进系统提示词**。
 *
 * ⚠️ 本文件只负责"**要求**"；**是否真的做到**要靠 `auditRenderFormat()` 事后检查
 * （自述/期望 ≠ 生效值 —— 与坑 21 同族：提示词说"要闭合"，模型不一定照做）。
 */

/**
 * 渲染契约（可直接拼进任何面向学生的系统提示词）。
 *
 * 5 条对应前端的 5 项渲染能力，**顺序与前端实现一一对应**，便于对照维护。
 */
export const RENDER_CONTRACT = `## 输出格式契约（前端渲染要求，必须遵守）

1. **公式**：只用 \`$...$\`（行内）与 \`$$...$$\`（块级）。
   - **禁止** \`\\(...\\)\`、\`\\[...\\]\`（前端 KaTeX **只认 \$ 定界符**，其它形式会原样显示成文本）
   - **禁止**贴公式图片或只给公式名
   - 中文/术语可与公式混排：\`\$\\text{聚簇索引}\$\`、\`\$O(\\log n)\$\`

2. **代码块**：必须用围栏并**标语言**，且**必须闭合**：
   \`\`\`sql … \`\`\`、\`\`\`python … \`\`\`、\`\`\`bash … \`\`\`
   - 结尾的 \`\`\` 一定要写（**漏了会让后面整段格式崩**）
   - 语言名写在开围栏后面，别只写 \`\`\`\`\`\`

3. **思维导图**：用 markmap 兼容的 Markdown —— \`#\`/\`##\` 标题作层级 + \`-\` 缩进作子节点。
   - **不要**用表格/ASCII 画图当导图
   - 节点若对应视频时间点，**必须带上时间戳**，写成 \`- 03:12 聚簇索引（可点跳转）\`
     （前端会把节点变成「▶ 03:12」按钮，点了跳到该位置）

4. **引用**：知识库/文稿引用一律写成 \`[[card:crd_xxxxxxxx]]\`；能给到原文时**附一小段原文引文**
   （前端渲成可点击跳转；**不要**自己编造 id）

5. **不许编造公式**：讲话稿/文稿里**没有出现的公式**一律不要补。
   学生问到时**如实回答**"文稿中未出现该公式"，可以解释相关概念，但**不要凭印象写公式**。
   （宁缺勿编 —— 编出来的公式会被学生当成课程内容背下来）`;

/** 视频 AI 助手（按视频文稿答疑） */
export const VIDEO_ASSISTANT_SYSTEM_PROMPT = `你是这门课程视频的 AI 助手，负责按**视频文稿**回答学生的问题。

## 你的立场
1. **只依据文稿**回答。文稿里没有的内容，明确说"文稿中未提到"，**不要用你的通用知识补**（学生会把它当课程原话）。
2. 回答尽量**指到具体位置**：给**时间戳**（\`mm:ss\`）与**原文引文**，让学生能跳过去核对。
3. 学生问"这段讲了什么/为什么这样说"时，**先引原文再解释**，解释与原文分开写。
4. 你在**讲解**，不是替学生写作业：代码类问题给思路与关键片段，不直接给整份可提交的答案。

${RENDER_CONTRACT}
`;

/** 通用对话助手（不限于视频页） */
export const CHAT_ASSISTANT_SYSTEM_PROMPT = `你是课程知识平台的 AI 助教，按知识库内容回答学生的问题。

## 你的立场
1. **有依据才说**：知识库没有的内容明确说"知识库中没有找到"，不要凭印象编。
2. 引用知识库时写 \`[[card:crd_xxxxxxxx]]\`，并附一小段原文引文。
3. 不要直接替学生完成作业；给方向与关键片段，让学生自己写。

${RENDER_CONTRACT}
`;

/** 把渲染契约追加到任意系统提示词末尾（已包含则不重复追加） */
export function withRenderContract(base: string): string {
  return base.includes('输出格式契约（前端渲染要求') ? base : `${base}\n\n${RENDER_CONTRACT}`;
}

// ---------------------------------------------------------------------------
// 事后检查：提示词"要求了"不等于"模型照做了"（坑 21 同族）
// ---------------------------------------------------------------------------

export interface RenderAudit {
  ok: boolean;
  violations: { rule: string; detail: string }[];
  /** 观测到的实况（便于断言"确实用了"与"确实没用错"） */
  observed: {
    inlineMath: number;
    blockMath: number;
    latexParen: number;
    latexBracket: number;
    fencesOpened: number;
    fencesClosed: number;
    fencesWithLang: number;
    unclosedFence: boolean;
    citations: string[];
    timestamps: string[];
  };
}

const MAX_DETAIL = 120;

/**
 * 检查模型输出是否符合渲染契约。
 *
 * 用途：① 真机 e2e 的**客观判据**（不靠人眼看）；② 需要时可在服务端记诊断。
 */
export function auditRenderFormat(text: string): RenderAudit {
  const violations: { rule: string; detail: string }[] = [];
  const src = typeof text === 'string' ? text : '';

  const inlineMath = (src.match(/(?<!\$)\$(?!\$)[^$\n]{1,200}\$(?!\$)/g) ?? []).length;
  const blockMath = (src.match(/\$\$[\s\S]{1,400}?\$\$/g) ?? []).length;
  const latexParen = (src.match(/\\\([\s\S]{1,200}?\\\)/g) ?? []).length;
  const latexBracket = (src.match(/\\\[[\s\S]{1,200}?\\\]/g) ?? []).length;

  // ★ 围栏要**成对解析**（原实现只按"有没有内容"数行 → "没标语言"这条规则形同虚设：
  //   两个裸 ``` 会被当成一对开/闭，既报不出"没语言"，也报不出"没闭合"）。
  //   配对规则：行首 ``` 后的第一个词是语言（可空）；在围栏内遇到裸 ``` 即闭合。
  let inFence = false;
  let fencesOpened = 0;
  let fencesClosed = 0;
  let fencesWithLang = 0;
  for (const line of src.split('\n')) {
    const m = /^\s*```+\s*([A-Za-z][\w+#.-]*)?\s*$/.exec(line);
    if (!m) continue;
    if (!inFence) {
      inFence = true;
      fencesOpened += 1;
      if (m[1]) fencesWithLang += 1;
    } else {
      inFence = false;
      fencesClosed += 1;
    }
  }
  const unclosedFence = inFence;

  const citations = src.match(/\[\[card:[A-Za-z0-9._-]+\]\]/g) ?? [];
  const timestamps = src.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g) ?? [];

  if (latexParen > 0) {
    violations.push({ rule: '公式定界符', detail: `出现 \\(...\\)：${String(src.match(/\\\([\s\S]{0,80}?\\\)/)?.[0] ?? '').slice(0, MAX_DETAIL)}` });
  }
  if (latexBracket > 0) {
    violations.push({ rule: '公式定界符', detail: `出现 \\[...\\]：${String(src.match(/\\\[[\s\S]{0,80}?\\\]/)?.[0] ?? '').slice(0, MAX_DETAIL)}` });
  }
  if (unclosedFence) {
    violations.push({ rule: '代码块闭合', detail: `开围栏 ${fencesOpened} 个、闭围栏 ${fencesClosed} 个（**结尾的 \`\`\` 漏了**）` });
  }
  if (fencesOpened > fencesWithLang) {
    violations.push({ rule: '代码块语言', detail: `${fencesOpened - fencesWithLang} 个代码块**没标语言**` });
  }

  return {
    ok: violations.length === 0,
    violations,
    observed: {
      inlineMath,
      blockMath,
      latexParen,
      latexBracket,
      fencesOpened,
      fencesClosed,
      fencesWithLang,
      unclosedFence,
      citations,
      timestamps,
    },
  };
}

/**
 * ★ 误导性回答的**诚实性**检查：文稿里没有的公式，必须明说"未出现"，不许编。
 *
 * 判据（可自动化）：若回答里出现了公式（`$...$`/`$$...$$`）而**检索到的原文里没有**
 * 对应片段 → 必须能在回答里找到"未出现/未提到/没有找到"这类**显式否认**。
 */
export function auditNoFabricatedFormula(answer: string, evidenceTexts: readonly string[]): { ok: boolean; detail: string } {
  const formulas = [
    ...(answer.match(/(?<!\$)\$(?!\$)[^$\n]{1,200}\$(?!\$)/g) ?? []),
    ...(answer.match(/\$\$[\s\S]{1,400}?\$\$/g) ?? []),
  ].map((f) => f.replace(/\$/g, '').trim());
  if (formulas.length === 0) return { ok: true, detail: '回答里没有公式（无需校验编造）' };
  const evidence = evidenceTexts.join('\n');
  const unsupported = formulas.filter((f) => f.length > 3 && !evidence.includes(f));
  if (unsupported.length === 0) return { ok: true, detail: `${formulas.length} 个公式都能在原文里找到` };
  const denied = /(文稿|原文|知识库|资料)(中|里)?\s*(未|没有|不)存在|未出现|没有出现|没有找到|未提到|未提及|没有提到/.test(answer);
  return {
    ok: denied,
    detail: denied
      ? `有 ${unsupported.length} 个公式不在原文里，但回答**已显式说明"未出现"**（符合宁缺勿编）`
      : `★ 有 ${unsupported.length} 个公式**不在原文里也没有说明**：${unsupported.slice(0, 3).join(' | ').slice(0, MAX_DETAIL)}`,
  };
}
