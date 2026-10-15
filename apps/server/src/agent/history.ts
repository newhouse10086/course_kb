/**
 * ★ 历史消息映射（**只许一份实现** —— lead 硬要求）。
 *
 * `history` 帧（WS，恢复当前会话）与 backend-api 的 HTTP 历史接口**必须共用本函数**，
 * 否则就是"两套真相源"（同类问题已经在 `healthCheck`/`probe` 上踩过：两份实现漂移）。
 *
 * ## 安全（与系统提示词泄漏那条同族）
 * pi 的会话条目里带 `sections` / `systemPrompt` 等**只给模型看的字段**（实测：系统提示词 11KB）。
 * 历史下发给浏览器时**必须剥掉**，并且**只取 `role=user|assistant` 的文本块** ——
 * `system` 角色一律不下发（与 `stream.ts` 的 `SYSTEM_ONLY_KEYS` / `frameLeaksSystemPrompt` 同一原则）。
 */

export interface HistoryMessage {
  role: 'user' | 'assistant';
  text: string;
  /** 毫秒时间戳（来源是条目/消息里的 `timestamp`；拿不到就不编） */
  ts: number;
}

export interface HistoryPayload {
  messages: HistoryMessage[];
  /** 是否**截断过**（只保留最近 N 条）—— 如实标注，不许静默截断 */
  truncated: boolean;
}

/** 单条消息文本上限（超出截断并标注，避免一次下发过多） */
export const HISTORY_MAX_TEXT_CHARS = 4000;
/** 最多下发多少条（自**最近**往前取） */
export const HISTORY_MAX_MESSAGES = 200;

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (!b || typeof b !== 'object') return '';
      const block = b as { type?: unknown; text?: unknown };
      if (block.type !== 'text') return '';
      return typeof block.text === 'string' ? block.text : '';
    })
    .filter((s) => s !== '')
    .join('\n');
}

/**
 * 把 pi 的会话条目（`SessionManager.getEntries()` 的返回值）映射成可下发的历史。
 *
 * **纯函数**（不碰磁盘）→ 便于 HTTP 与 WS 两侧复用、也便于单测。
 */
export function entriesToHistory(
  entries: readonly unknown[],
  opts: { maxMessages?: number; maxTextChars?: number } = {},
): HistoryPayload {
  const maxMessages = opts.maxMessages ?? HISTORY_MAX_MESSAGES;
  const maxTextChars = opts.maxTextChars ?? HISTORY_MAX_TEXT_CHARS;
  const all: HistoryMessage[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as { type?: unknown; message?: unknown; timestamp?: unknown };
    if (entry.type !== 'message') continue;
    const msg = (entry.message ?? {}) as { role?: unknown; content?: unknown; timestamp?: unknown };
    const role = msg.role;
    // ★ 只放行 user/assistant；`system`（含 sections/systemPrompt）**一律不下发**
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textOfContent(msg.content).trim();
    if (text === '') continue;
    const tsRaw = msg.timestamp ?? entry.timestamp;
    const ts = typeof tsRaw === 'number' && Number.isFinite(tsRaw) ? tsRaw : 0;
    all.push({
      role,
      text: text.length > maxTextChars ? `${text.slice(0, maxTextChars)}…（已截断）` : text,
      ts,
    });
  }
  const truncated = all.length > maxMessages;
  const messages = truncated ? all.slice(all.length - maxMessages) : all;
  return { messages, truncated };
}

/**
 * 自我检查：历史负载里**是否混进了只给模型看的字段**（系统提示词泄漏防线）。
 *
 * ⚠️ 判据刻意用**结构**而不是关键词匹配：
 * - 关键词匹配会**误伤** —— 学生完全可能问"systemPrompt 是什么"，那是正常的用户消息，
 *   静默丢掉它就等于"历史少了却不说"（比不检查更坏）。
 * - 真正要防的是**映射回归**（比如某个实现顺手把整条 system 条目拷进来）→ 那必然表现为
 *   **多出未预期的键**（`sections`/`systemPrompt`/`thinking`…）。
 *
 * 另加一条**内容签名**：pi 默认系统提示词的开头 `expert coding assistant`
 * （用户消息里出现这句话的概率极低，误伤可忽略）。
 */
export function historyLeaksSystemPrompt(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const allowedTop = new Set(['messages', 'truncated']);
  const allowedMsg = new Set(['role', 'text', 'ts']);
  const p = payload as Record<string, unknown>;
  if (Object.keys(p).some((k) => !allowedTop.has(k))) return true;
  const messages = Array.isArray(p.messages) ? p.messages : [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (Object.keys(m as Record<string, unknown>).some((k) => !allowedMsg.has(k))) return true;
    const text = (m as { text?: unknown }).text;
    if (typeof text === 'string' && /expert coding assistant/i.test(text)) return true;
  }
  return false;
}
