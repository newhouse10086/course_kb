/**
 * 知识库**只读**查询 —— 给 agent 工具（`kb_search` / `kb_get`）用（Lead 交办）。
 *
 * ## 为什么单独一个模块（而不是让 agent 直接查库）
 * 1. **可见性过滤是硬要求**：必须复用 RBAC 的 `docScopeSql()`/`docVisible()` ——
 *    否则学生能用 `kb_get('crd_xxx')` 读到**别人或未发布的草稿**，
 *    而"agent 工具成为绕过 RBAC 的后门"正是我们刚在 RBAC 里立规矩要防的事。
 * 2. **只读**：这里只有 SELECT（没有写/删/执行 SQL 的入口）—— 工具的能力边界 = 这个模块的导出。
 * 3. **复用既有检索**：走 `store/search.ts` 的 bigram（**不重写第二份**），
 *    否则中文检索会出现两套行为（坑 15 的 bigram 是实测结论，不能有第二种实现）。
 *
 * ## 截断语义（如实标注，不静默截断）
 * - `snippet` ≤ `SNIPPET_MAX`（200）字，截断加 `…`
 * - `text` ≤ `TEXT_MAX`（4000）字，超出时 `truncated: true`
 * 判据：**"看起来完整"比"明确截断"危险** —— 模型会把截断文本当全文引用。
 */
import type { Db } from './db.ts';
import type { Repo } from './repo.ts';
import { search } from './search.ts';
import { docScopeSql } from './scope.ts';
import type { DocScope } from './scope.ts';

export const SNIPPET_MAX = 200;
export const TEXT_MAX = 4000;
export const SEARCH_LIMIT_DEFAULT = 8;
export const SEARCH_LIMIT_MAX = 20;

export interface KbHit {
  kind: 'card' | 'unit';
  ref_id: string;
  title: string;
  score: number;
  /** ≤200 字（已截断，末尾 `…`） */
  snippet: string;
  /** 命中所在文档（前端/模型可用于"跳原文"） */
  doc_id: string;
}

export interface KbEvidence {
  span: { kind: string; start: number; end: number };
  quote: string;
}

export interface KbDoc {
  kind: 'card' | 'unit';
  ref_id: string;
  title: string;
  text: string;
  doc_id: string;
  /** ★ 如实标注：`text` 因超长被截断（不是全文） */
  truncated: boolean;
  evidence?: KbEvidence;
}

export interface KbQuery {
  search(args: { userId: string; query: string; docId?: string; limit?: number }): KbHit[];
  get(args: { userId: string; refId: string }): KbDoc | null;
}

/** 截断到 `max` 字（超长时末尾加 `…`，**如实**表示"这不是全部"）。 */
export function clip(text: string, max: number): { text: string; truncated: boolean } {
  const s = text ?? '';
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)}…`, truncated: true };
}

/**
 * 把"用户 id"解析成 `DocScope`。
 *
 * ⚠️ 这里**只按 userId 取**：`teacherCourseIds`/`studentCourseIds` 来自会话身份
 * （`scopeFor(user)`），而工具调用路径只拿到 `userId`。
 * 所以本模块的可见性 = **owner 自己 + public&published**（比完整 scope 更**保守**，
 * 宁可少给内容，也绝不多给）—— 这是**有意的**：工具没有完整会话身份，
 * 就不该假装拥有它。要放宽必须把完整 scope 传进来（由路由层决定）。
 */
function scopeOfUser(userId: string): DocScope {
  return { isAdmin: false, userId, teacherCourseIds: [], studentCourseIds: [] };
}

/** 该用户**可见的文档 id 集合**（一次查库，后续 O(1) 判定）。 */
export function visibleDocIds(db: Db, userId: string): Set<string> {
  const frag = docScopeSql(scopeOfUser(userId));
  const rows = db.all<{ id: string }>(`SELECT id FROM documents WHERE ${frag.sql}`, ...frag.params);
  return new Set(rows.map((r) => r.id));
}

/** 卡片 → 可读全文（含出处锚点）。 */
function cardDoc(repo: Repo, id: string): KbDoc | null {
  const card = repo.getCard(id);
  if (!card) return null;
  const parts = [card.one_line, card.purpose, card.example ?? '', card.example_explained ?? ''].filter(
    (s) => s && s.trim() !== '',
  );
  const body = parts.join('\n\n');
  const clipped = clip(body, TEXT_MAX);
  const span = card.evidence_span;
  return {
    kind: 'card',
    ref_id: card.id,
    title: card.name,
    text: clipped.text,
    doc_id: card.doc_id,
    truncated: clipped.truncated,
    ...(span && card.evidence_quote
      ? {
          evidence: {
            span: { kind: span.kind ?? 'page', start: span.start ?? 0, end: span.end ?? 0 },
            quote: card.evidence_quote,
          },
        }
      : {}),
  };
}

/** 单元 → 可读全文（含 span 锚点）。 */
function unitDoc(repo: Repo, id: string): KbDoc | null {
  const unit = repo.getUnit(id);
  if (!unit) return null;
  const clipped = clip(unit.text ?? '', TEXT_MAX);
  const span = unit.span;
  return {
    kind: 'unit',
    ref_id: unit.id,
    title: unit.title,
    text: clipped.text,
    doc_id: unit.doc_id,
    truncated: clipped.truncated,
    ...(span
      ? {
          evidence: {
            span: { kind: span.kind ?? 'page', start: span.start ?? 0, end: span.end ?? 0 },
            quote: (unit.text ?? '').slice(0, SNIPPET_MAX),
          },
        }
      : {}),
  };
}

/**
 * 构造只读查询门面（`AppDeps.kb`）。
 *
 * 两个方法**都**先做可见性过滤：命中/取回的文档必须在 `visibleDocIds(userId)` 里，
 * 否则**当作不存在**（返回 `null` / 过滤掉）—— 不返回"无权访问"这种可枚举信号。
 */
export function createKbQuery(deps: { db: Db; repo: Repo }): KbQuery {
  return {
    search({ userId, query, docId, limit }): KbHit[] {
      const q = (query ?? '').trim();
      if (!q) return [];
      const cap = Math.min(Math.max(1, Math.trunc(limit ?? SEARCH_LIMIT_DEFAULT)), SEARCH_LIMIT_MAX);
      const visible = visibleDocIds(deps.db, userId);
      if (visible.size === 0) return [];
      // 多取一些：可见性过滤会砍掉一部分（否则过滤后可能不足 limit）
      const res = search(deps.db, deps.repo, q, { ...(docId ? { docId } : {}), limit: cap * 3 });
      const out: KbHit[] = [];
      for (const h of res.hits) {
        if (!visible.has(h.doc_id)) continue; // ★ 不可见 → 当作不存在
        const clipped = clip(h.snippet ?? '', SNIPPET_MAX);
        out.push({
          kind: h.kind === 'unit' ? 'unit' : 'card',
          ref_id: h.ref_id,
          title: h.title ?? '',
          score: h.score,
          snippet: clipped.text,
          doc_id: h.doc_id,
        });
        if (out.length >= cap) break;
      }
      return out;
    },

    get({ userId, refId }): KbDoc | null {
      const id = (refId ?? '').trim();
      if (!id) return null;
      const visible = visibleDocIds(deps.db, userId);
      // 卡片优先，其次单元（`ref_id` 前缀不保证，所以两边都试）
      for (const build of [cardDoc, unitDoc]) {
        const doc = build(deps.repo, id);
        if (doc) return visible.has(doc.doc_id) ? doc : null; // ★ 不可见 → 当作不存在
      }
      return null;
    },
  };
}
