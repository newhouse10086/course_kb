/**
 * 专用**只读知识库工具**（`kb_search` / `kb_get`）—— chat/agent 模式里的 `agent` 用它。
 *
 * ## 为什么需要
 * 模型想读卡片原文是**合理需求**（早前观察到的"模型想查证却没有工具 → tool 调用退化成正文乱码"）。
 * 正确做法是给它**只读、限知识库、按用户过滤可见性**的专用工具，
 * 而**不是**放开 pi 的 `read`（读主机文件）/ `bash`（执行主机命令）。
 *
 * ## 硬约束（照 lead 的接口约定实现）
 * - **只读**：没有任何写/删/SQL 能力
 * - **只查知识库**：`kb_search` / `kb_get` 都只经注入的 `KbProvider`，**不碰文件系统**
 * - ★ **可见性由 provider 按 `userId` 过滤**（`docScopeSql()`），工具这边**只透传服务端身份**，
 *   绝不接受客户端提供的 userId（`createChatConnection` 的 `user` 才是来源）
 * - **返回长度上限**：`snippet ≤200` 字（provider 负责）、`text` 在工具层再截断并**如实标注"已截断"**
 * - **不进危险名单**：它是安全工具；但仍需**显式白名单**（`tools: ['kb_search','kb_get']`）才生效
 * - **`null` = 没找到或无权访问** → 如实告诉模型，**不编内容**
 *
 * ## 与 pi 的接法
 * pi 的自定义工具通过**扩展工厂**注册（`pi.registerTool`），扩展经
 * `DefaultResourceLoader({ extensionFactories: [factory] })` 传入 `createAgentSession`。
 * 工具名必须同时出现在 `options.tools` 白名单里才会被激活。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

/** ★ 只读知识库工具名（chat/agent 模式的 `agent` 用它；**不含** read/bash/edit/write） */
export const KB_TOOL_NAMES = ['kb_search', 'kb_get'] as const;
export type KbToolName = (typeof KB_TOOL_NAMES)[number];

/** 检索命中（形状与 backend-api 的 `KbHit` 对齐） */
export interface KbHit {
  kind: 'card' | 'unit';
  ref_id: string;
  title: string;
  score: number;
  /** ≤200 字，provider 侧已截断 */
  snippet: string;
}

/** 单条原文（形状与 backend-api 的 `KbDoc` 对齐） */
export interface KbDoc {
  kind: 'card' | 'unit';
  ref_id: string;
  title: string;
  text: string;
  doc_id: string;
  /** provider 侧是否已截断 */
  truncated?: boolean;
  /** ★ 可回溯锚点（"这句话来自哪里"）——lead 要求必须有；provider 给不了就如实缺省 */
  evidence?: { span: { kind: string; start: number; end: number }; quote: string };
}

/**
 * 知识库查询能力（**服务端内部**；由 backend-api 注入，内部已按 `userId` 过滤可见性）。
 * 缺省（`null`）= 知识库工具不可用 → `agent` 模式如实降级（工具集为空 + 可读原因）。
 */
export interface KbProvider {
  search(args: { userId: string; query: string; docId?: string; limit?: number }): Promise<KbHit[]> | KbHit[];
  get(args: { userId: string; refId: string }): Promise<KbDoc | null> | KbDoc | null;
  /**
   * ★ `context` 帧用：把客户端给的 **id** 解析成真实标题/snippet。
   *
   * **只接受 id**（客户端内容不可信）；解析不到的项**必须**放进 `dropped` 并给 reason。
   * `session_id`（沙箱会话）**必须按 userId 校验归属** —— 不做或校验失败就返回 dropped。
   * 未实现本方法 → 消费侧一律 dropped（**安全的缺省**，不猜）。
   */
  resolveContext?(args: {
    userId: string;
    docId?: string;
    unitId?: string;
    sessionId?: string;
  }): Promise<{
    docTitle?: string;
    unitTitle?: string;
    unitSpan?: Record<string, unknown>;
    dropped?: { field: string; value: string; reason: string }[];
    note?: string;
  }>;
}

/** 请求侧 `context`（**只接受 id**；自由文本一律不收） */
export interface PageContext {
  doc_id?: string;
  unit_id?: string;
  session_id?: string;
  page?: number;
}

/** `context` 帧（契约 §7.2 第 11 种）*/
export interface ContextFramePayload {
  used: PageContext;
  resolved: { doc_title?: string; unit_title?: string; unit_span?: Record<string, unknown> };
  dropped: { field: string; value: string; reason: string }[];
  note: string;
}

const ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * 校验 + 解析请求侧 `context`（lead 裁定：**只接受 id**，解析不到就丢弃并如实说明）。
 *
 * 安全检查：
 * - 非字符串 / 超长 / 含非法字符的 id → 丢弃（带 reason）
 * - `page` 只接受有限数字；其它字段一律忽略（**不收自由文本**）
 * - provider 未实现 `resolveContext` → 全部丢弃（安全缺省：不知道归属就别注入）
 */
export async function resolvePageContext(opts: {
  raw: unknown;
  userId: string;
  kb: KbProvider | null | undefined;
}): Promise<{ frame: ContextFramePayload; hasAny: boolean }> {
  const dropped: { field: string; value: string; reason: string }[] = [];
  const used: PageContext = {};
  const rawObj = (opts.raw && typeof opts.raw === 'object' ? opts.raw : {}) as Record<string, unknown>;

  const takeId = (field: 'doc_id' | 'unit_id' | 'session_id'): string | undefined => {
    const v = rawObj[field];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') {
      dropped.push({ field, value: String(v).slice(0, 40), reason: '不是字符串，已忽略' });
      return undefined;
    }
    if (!ID_RE.test(v)) {
      dropped.push({ field, value: v.slice(0, 40), reason: 'id 格式非法（只允许字母/数字/._-，长度 1..80），已忽略' });
      return undefined;
    }
    used[field] = v;
    return v;
  };

  takeId('doc_id');
  takeId('unit_id');
  takeId('session_id');
  if (rawObj.page !== undefined) {
    const n = Number(rawObj.page);
    if (Number.isFinite(n) && n >= 0 && n <= 100000) used.page = Math.floor(n);
    else dropped.push({ field: 'page', value: String(rawObj.page).slice(0, 20), reason: '页码不是合法数字，已忽略' });
  }
  // 其它字段一律忽略（不收自由文本）
  for (const key of Object.keys(rawObj)) {
    if (!['doc_id', 'unit_id', 'session_id', 'page'].includes(key)) {
      dropped.push({ field: key, value: String(rawObj[key] ?? '').slice(0, 40), reason: '不接受的字段（只收 doc_id/unit_id/session_id/page 的 id）' });
    }
  }

  const hasAny = Object.keys(used).length > 0;
  const resolved: ContextFramePayload['resolved'] = {};
  let note = '';

  if (hasAny && !opts.kb) {
    // 没有知识库能力 → 无法解析 id → 全部视为丢弃（**不猜标题**）
    for (const [k, v] of Object.entries(used)) dropped.push({ field: k, value: String(v), reason: '知识库查询未接入，无法解析该 id' });
    return { frame: { used: {}, resolved, dropped, note: '知识库查询未接入（kb provider 缺失），本轮未使用页面上下文' }, hasAny: false };
  }
  if (hasAny && opts.kb && typeof opts.kb.resolveContext !== 'function') {
    for (const [k, v] of Object.entries(used)) {
      dropped.push({ field: k, value: String(v), reason: '知识库未提供 context 解析能力，无法确认该 id 的归属' });
    }
    return { frame: { used: {}, resolved, dropped, note: '知识库不支持上下文解析，本轮未使用页面上下文（不猜）' }, hasAny: false };
  }
  if (hasAny && opts.kb?.resolveContext) {
    try {
      const r = await opts.kb.resolveContext({
        userId: opts.userId,
        ...(used.doc_id ? { docId: used.doc_id } : {}),
        ...(used.unit_id ? { unitId: used.unit_id } : {}),
        ...(used.session_id ? { sessionId: used.session_id } : {}),
      });
      if (r.docTitle !== undefined) resolved.doc_title = r.docTitle;
      if (r.unitTitle !== undefined) resolved.unit_title = r.unitTitle;
      if (r.unitSpan !== undefined) resolved.unit_span = r.unitSpan;
      if (r.dropped?.length) dropped.push(...r.dropped);
      if (r.note) note = r.note;
      // provider 没解析出来的 id：如实丢弃（不留"用了但没解析"的模糊态）
      if (used.doc_id && r.docTitle === undefined && !r.dropped?.some((d) => d.field === 'doc_id')) {
        dropped.push({ field: 'doc_id', value: used.doc_id, reason: '未找到或无权访问' });
      }
      if (used.unit_id && r.unitTitle === undefined && !r.dropped?.some((d) => d.field === 'unit_id')) {
        dropped.push({ field: 'unit_id', value: used.unit_id, reason: '未找到或无权访问' });
      }
      if (used.session_id && !r.dropped?.some((d) => d.field === 'session_id')) {
        // provider 未明确回报 session 归属校验结果 → 保守丢弃（跨用户读取就是这么来的）
        const sessionKept = typeof r.note === 'string' && r.note.includes('session');
        if (!sessionKept) dropped.push({ field: 'session_id', value: used.session_id, reason: '未能校验会话归属，已忽略（安全缺省）' });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      for (const [k, v] of Object.entries(used)) dropped.push({ field: k, value: String(v), reason: `解析失败：${reason}` });
      return { frame: { used: {}, resolved, dropped, note: `上下文解析失败：${reason}` }, hasAny: false };
    }
  }

  const keptFields = Object.keys(used).filter((k) => !dropped.some((d) => d.field === k));
  const usedKept: PageContext = {};
  for (const k of keptFields) {
    const key = k as keyof PageContext;
    const v = used[key];
    if (v !== undefined) (usedKept as Record<string, unknown>)[key] = v;
  }
  if (dropped.length > 0 && note === '') note = `有 ${dropped.length} 项上下文未能解析，已忽略（见 dropped）`;
  return { frame: { used: usedKept, resolved, dropped, note }, hasAny: Object.keys(usedKept).length > 0 };
}

export interface KbToolOptions {
  provider: KbProvider;
  /** ★ 服务端权威身份（可见性过滤用它；**绝不来自客户端帧**） */
  userId: string;
  /** 单条原文的**工具层**长度上限（默认 4000 字；超出截断并如实标注） */
  maxTextChars?: number;
  onDiagnostic?: (message: string) => void;
}

/** 工具返回值（pi `AgentToolResult` 的最小形状；显式声明避免两个分支的联合类型不兼容） */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  details: Record<string, unknown>;
  isError?: boolean;
}

/** 工具层文本截断（如实标注，不静默截断） */
export function truncateForTool(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n…（已截断，原文 ${text.length} 字，只显示了前 ${maxChars} 字）`, truncated: true };
}

/** `kb_search` 的返回文本（给模型看；结构清晰、可引用 `ref_id`） */
export function formatSearchResult(hits: readonly KbHit[]): string {
  if (hits.length === 0) return '知识库检索：没有命中（可能知识库为空、或该主题尚未收录）。请如实说明没有查到，不要编造内容。';
  const lines = hits.map(
    (h, i) =>
      `[${i + 1}] kind=${h.kind} ref_id=${h.ref_id} score=${h.score.toFixed(1)} title=${h.title}\n    ${h.snippet}`,
  );
  return `知识库检索命中 ${hits.length} 条（引用时用 [[card:<ref_id>]] 或说明 ref_id）：\n${lines.join('\n')}`;
}

/** `kb_get` 的返回文本 */
export function formatDocResult(doc: KbDoc | null, refId: string, maxChars: number): string {
  if (doc === null) {
    // ★ 不区分"不存在"与"无权访问"更安全（避免探测别人有什么），但要如实说"拿不到"
    return `kb_get(${refId})：没有找到该条目，或你无权访问它。请如实说明拿不到，不要凭印象编内容。`;
  }
  const body = truncateForTool(doc.text, maxChars);
  const parts = [`kind=${doc.kind} ref_id=${doc.ref_id} title=${doc.title} doc_id=${doc.doc_id}`];
  if (body.truncated || doc.truncated === true) parts.push('（原文过长，已截断）');
  parts.push('', body.text);
  if (doc.evidence) {
    parts.push(
      '',
      `可回溯锚点：span=${doc.evidence.span.kind}[${doc.evidence.span.start},${doc.evidence.span.end})` +
        (doc.evidence.quote ? ` quote="${doc.evidence.quote.slice(0, 120)}"` : ''),
    );
  } else {
    parts.push('', '（本条没有可回溯锚点）');
  }
  return parts.join('\n');
}

/**
 * 构造 pi 扩展工厂：注册 `kb_search` / `kb_get` 两个**只读**工具。
 *
 * ⚠️ 本模块静态依赖 `typebox`（pi 的 `ToolDefinition.parameters` 要 TypeBox schema）。
 * 所以 `session.ts` **动态 import** 它：SDK/依赖缺失时只是"kb 工具不可用"，
 * 而不是让整个 agent 模块加载失败（保持"缺啥如实降级"）。
 */
export function createKbExtension(opts: KbToolOptions): (pi: ExtensionAPI) => void {
  const maxTextChars = opts.maxTextChars ?? 4000;
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'kb_search',
      label: '知识库检索',
      description:
        '在本课程知识库中检索卡片/单元。**只读**。返回命中列表（ref_id/title/score/摘要），' +
        '需要原文时再用 kb_get(ref_id) 读取。引用时请带上 [[card:ref_id]]。',
      promptSnippet: 'kb_search(query, doc_id?, limit?)：检索知识库（只读）',
      promptGuidelines: [
        '回答课程知识问题时优先用 kb_search 查证，再引用命中的 [[card:ref_id]]。',
        '不要凭印象编内容；kb_search 没命中就如实说明没有查到。',
      ],
      parameters: Type.Object({
        query: Type.String({ description: '检索关键词或问题（中文）' }),
        doc_id: Type.Optional(Type.String({ description: '限定在某份文档内检索（可选）' })),
        limit: Type.Optional(Type.Number({ description: '返回条数，默认 5，最大 20' })),
      }),
      async execute(
        _toolCallId: string,
        params: { query: string; doc_id?: string; limit?: number },
      ): Promise<ToolResult> {
        const limit = Math.max(1, Math.min(20, Math.floor(params.limit ?? 5)));
        try {
          const hits = await opts.provider.search({
            userId: opts.userId,
            query: String(params.query ?? ''),
            ...(params.doc_id ? { docId: String(params.doc_id) } : {}),
            limit,
          });
          return {
            content: [{ type: 'text' as const, text: formatSearchResult(hits) }],
            details: { tool: 'kb_search', hits: hits.length, refIds: hits.map((h) => h.ref_id) },
          };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          opts.onDiagnostic?.(`kb_search 失败：${reason}`);
          return {
            content: [{ type: 'text' as const, text: `知识库检索失败：${reason}。请如实说明检索不可用，不要编造内容。` }],
            details: { tool: 'kb_search', error: reason },
            isError: true,
          };
        }
      },
    });

    pi.registerTool({
      name: 'kb_get',
      label: '读知识库原文',
      description:
        '按 ref_id（crd_* / unt_*）读取知识库条目的**原文**与可回溯锚点。**只读**。' +
        '拿不到时（不存在或无权访问）会明确说明——此时不要凭印象作答。',
      promptSnippet: 'kb_get(ref_id)：读单条知识库原文（只读，按你的权限过滤）',
      promptGuidelines: ['只在需要原文/精确表述时调用 kb_get，避免逐条无目的地读。'],
      parameters: Type.Object({
        ref_id: Type.String({ description: '条目 id（来自 kb_search 的 ref_id 或上下文里的 [[card:…]]）' }),
      }),
      async execute(_toolCallId: string, params: { ref_id: string }): Promise<ToolResult> {
        const refId = String(params.ref_id ?? '');
        try {
          const doc = await opts.provider.get({ userId: opts.userId, refId });
          return {
            content: [{ type: 'text' as const, text: formatDocResult(doc, refId, maxTextChars) }],
            details: {
              tool: 'kb_get',
              refId,
              found: doc !== null,
              ...(doc ? { docId: doc.doc_id, truncated: doc.truncated === true } : {}),
            },
          };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          opts.onDiagnostic?.(`kb_get(${refId}) 失败：${reason}`);
          return {
            content: [{ type: 'text' as const, text: `读取知识库条目失败：${reason}。请如实说明读取不可用，不要编造。` }],
            details: { tool: 'kb_get', refId, error: reason },
            isError: true,
          };
        }
      },
    });
  };
}
