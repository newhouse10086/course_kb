/**
 * 会话命名：**清洗**与**输入选取**（契约 `docs/SESSION_NAMING.md` §3）。
 *
 * 本文件**只放纯函数**（不碰 DB/网络）—— 便于单测、也便于"UI 与命名同源"的逐字比对断言。
 *
 * ## 两条硬要求（Lead 裁定）
 * 1. ★ **输入必须与 UI 显示的对话同源**：命名读到的"首条用户提问"**必须等于**
 *    `history` 帧/UI 里那条（复用 `agent/history.ts::entriesToHistory`，**只许一份实现**）。
 * 2. ★ **不许假设"第一条就是用户提问"**（坑 28：**"取第一个"经常不是你要的那个**）——
 *    必须**跳过** system/tool 等非用户消息，找**第一条真正的用户消息**。
 */

/** 用户手动命名的长度上限（契约 §3.1②：trim 后 1..80，**超长 400，不静默截断**） */
export const TITLE_MAX_CHARS = 80;

/** AI 名字的上限：含中文 → 20 字；纯 ASCII → 40 字符（契约 §3.2③） */
export const TITLE_GEN_MAX_CHARS_CJK = 20;
export const TITLE_GEN_MAX_CHARS_ASCII = 40;

/** ★ **命名成本必须极低**（契约 §3.2④）：32 tokens 足够一个短标题 */
export const TITLE_GEN_MAX_TOKENS = 32;

/** 命名输入的截断长度（首条提问/首条回答各 ~500 字符，契约 §3.2②） */
export const TITLE_INPUT_CLIP = 500;

/** 中文（CJK 统一表意文字）判定 —— 用于决定 20 字还是 40 字符上限 */
export function hasCjk(s: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(s);
}

/** 结尾标点（中英文都要去 —— 模型几乎一定会加句号/引号） */
const TRAILING_PUNCT = /[。．.!！?？;；:：,，、~～…·"'“”‘’）)\]】》」』]+$/u;
/** 首尾引号（中英文） */
const QUOTES = new Set(['"', "'", '“', '”', '‘', '’', '「', '」', '『', '』', '《', '》', '`']);

function stripWrappingQuotes(s: string): string {
  let out = s.trim();
  for (;;) {
    const first = out[0];
    const last = out[out.length - 1];
    if (out.length >= 2 && first !== undefined && last !== undefined && QUOTES.has(first) && QUOTES.has(last)) {
      out = out.slice(1, -1).trim();
      continue;
    }
    // 只包了左引号（模型常写成 `"标题`）也去掉
    if (out.length >= 1 && first !== undefined && QUOTES.has(first) && !QUOTES.has(last ?? '')) {
      out = out.slice(1).trim();
      continue;
    }
    return out;
  }
}

export interface TitleWarning {
  code: string;
  msg: string;
  detail?: Record<string, unknown>;
}

export interface CleanTitleResult {
  /** 清洗后的标题（**可能为空** —— 调用方此时必须保留原名，不许写空名字） */
  title: string;
  warnings: TitleWarning[];
}

/**
 * ★ **模型输出清洗**（契约 §3.2③）—— 模型一定会加引号/解释，必须清洗。
 *
 * ```
 * 取第一行 · 去掉首尾引号（中英文） · 去掉结尾标点 · 截断到 20 字（含中文）/ 40 字符
 * 若清洗后为空 → 返回空 + 如实警告（**调用方保留原名**，不写空名字）
 * ```
 * ⚠️ 截断**如实上报**（`W_TITLE_TRUNCATED` + 原始长度），**不静默截断**。
 * ⚠️ 纯 ASCII 截断时**不留半个词**（在最后一个空格处断）。
 */
export function cleanGeneratedTitle(raw: string): CleanTitleResult {
  const warnings: TitleWarning[] = [];
  // ① 取第一行**非空**内容（模型常先写"好的，标题是："再换行给标题）
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  let s = lines[0] ?? '';
  // 去掉常见的"前缀说明"（如 `标题：xxx` / `Title: xxx`）—— 只在前缀后面确实还有内容时
  s = s.replace(/^(?:标题|会话名|名称|title|name)\s*[:：]\s*/i, '').trim();
  // ② 去首尾引号
  s = stripWrappingQuotes(s);
  // ③ 去结尾标点（可能有多层：`"标题"。`）
  for (let i = 0; i < 3; i += 1) {
    const next = stripWrappingQuotes(s.replace(TRAILING_PUNCT, '').trim());
    if (next === s) break;
    s = next;
  }
  // ④ 折叠空白（模型可能给多空格）
  s = s.replace(/\s+/g, ' ').trim();
  if (s === '') {
    warnings.push({
      code: 'W_TITLE_EMPTY',
      msg: '模型输出清洗后为空 → **保留原名**（不写空名字）',
      detail: { raw_head: String(raw ?? '').slice(0, 120) },
    });
    return { title: '', warnings };
  }
  // ⑤ 截断（如实上报）
  const limit = hasCjk(s) ? TITLE_GEN_MAX_CHARS_CJK : TITLE_GEN_MAX_CHARS_ASCII;
  const chars = Array.from(s);
  if (chars.length > limit) {
    let cut = chars.slice(0, limit).join('');
    // 纯 ASCII：**不留半个词**（在最后一个空格处断）
    if (!hasCjk(s) && /\s/.test(cut)) {
      const at = cut.lastIndexOf(' ');
      if (at > 0) cut = cut.slice(0, at);
    }
    cut = cut.replace(TRAILING_PUNCT, '').trim();
    warnings.push({
      code: 'W_TITLE_TRUNCATED',
      msg: `模型输出超长（${chars.length} > ${limit}）→ **如实截断**为 "${cut}"`,
      detail: { original_length: chars.length, limit },
    });
    s = cut;
  }
  return { title: s, warnings };
}

export interface NamingInput {
  /** 首条**真正的用户提问**（已截断） */
  firstUser: string;
  /** 该提问之后的**首条助手回答**（已截断；没有则为空串） */
  firstAssistant: string;
}

/**
 * ★ 从**同源**的历史消息里取命名输入（契约 §3.2②）。
 *
 * - ★ **跳过非用户消息**找第一条用户提问（坑 28 —— 别假设第一条就是用户提问）
 * - 助手回答取"该用户提问**之后**"的第一条（不是"全局第一条 assistant"）
 * - 各自截断到 `clip` 字符，并**如实**标注是否截断
 *
 * @returns `null` = **没有任何用户消息** → 调用方必须 **400（不编名字）**
 */
export function pickNamingInput(
  messages: readonly { role: string; text: string }[],
  clip: number = TITLE_INPUT_CLIP,
): NamingInput | null {
  const clipText = (s: string): string => {
    const t = s.trim();
    const chars = Array.from(t);
    return chars.length > clip ? chars.slice(0, clip).join('') : t;
  };
  const firstUserIdx = messages.findIndex((m) => m.role === 'user' && m.text.trim() !== '');
  if (firstUserIdx < 0) return null;
  const firstUser = clipText(messages[firstUserIdx]!.text);
  const after = messages.slice(firstUserIdx + 1);
  const firstAssistantMsg = after.find((m) => m.role === 'assistant' && m.text.trim() !== '');
  return { firstUser, firstAssistant: firstAssistantMsg ? clipText(firstAssistantMsg.text) : '' };
}

/** 命名提示词（★ 要求"只输出标题本身"，配合 `max_tokens=32`） */
export const TITLE_SYSTEM_PROMPT = [
  '你是课程问答平台的助手，负责给一次对话起一个**短标题**。',
  '要求：',
  '1. 只输出标题本身，**不要**引号、不要句号、不要解释、不要换行；',
  '2. 中文标题 ≤ 20 字（英文 ≤ 40 字符）；',
  '3. 标题要能让用户在会话列表里**一眼认出这次聊的是什么**（用具体主题，别用"问题咨询"这类空话）；',
  '4. 用与用户提问相同的语言。',
].join('\n');

export function buildTitleMessages(input: NamingInput): { role: 'system' | 'user'; content: string }[] {
  const parts = [`用户提问：${input.firstUser}`];
  if (input.firstAssistant !== '') parts.push(`助手回答（节选）：${input.firstAssistant}`);
  parts.push('请给出这次对话的短标题（只输出标题本身）。');
  return [
    { role: 'system', content: TITLE_SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/** 命名调用用的**极小** schema（只有 title 一个字段） */
export const TITLE_SCHEMA: { name: string; schema: Record<string, unknown> } = {
  name: 'conversation_title',
  schema: {
    type: 'object',
    properties: { title: { type: 'string' } },
  },
};

/** 从模型返回里取标题（兼容 `{title}` / `{name}` / 裸字符串） */
export function titleFromModelData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return '';
  const o = data as Record<string, unknown>;
  for (const k of ['title', 'name', 'conversation_title', 'text']) {
    if (typeof o[k] === 'string') return o[k] as string;
  }
  return '';
}
