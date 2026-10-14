/**
 * `wiki` 检索器 —— **词法检索（bigram 倒排 + FTS5）**，`docs/RETRIEVAL.md` §3.1。
 *
 * ## 为什么是"接上即可"而不是重写
 * `store/search.ts` 已经实现并已验证了 v1 的两条血泪教训：
 * - **坑 15**：FTS5 默认 `unicode61` 对中文 **0 命中** → 必须自建 bigram（本机实测对照）
 * - **坑 16**：FTS5 增量更新**脏索引**（`'delete'` 传新值 → 搜得到已删内容且不报错）
 * ⟹ 本模块**只做三件 search.ts 不做的事**：
 * 1. **RBAC 过滤**（`scope.ts`，SQL 层）—— search.ts 不认 user
 * 2. **补 `evidence` 锚点**（卡片/单元的 `span_*` → 页码/毫秒）—— 规则 1 的落点
 * 3. **补 `why`**（`bigram 命中「索引」`）—— 规则 2 的落点
 *
 * ⚠️ **不发明第二套检索**：FTS5 的 `snippet()` 给的是**原文**片段（不是 bigram 串），
 * 正文取 `card.evidence_quote` / `unit.text` 的**原文**。
 */

import type {
  RetrievalDeps,
  RetrievalQuery,
  Retrieved,
  RetrievedItem,
  RetrievedItemDraft,
  Retriever,
  RetrieverHealth,
} from './types.ts';
import { DEFAULT_LIMIT, toSpan } from './types.ts';
import type { Span } from '../store/types.ts';
import { enforceEvidence } from './evidence.ts';
import { scopeForUser, visibleDocIds } from './scope.ts';
import { queryTerms, toBigram } from '../store/bigram.ts';
import { search, snippet } from '../store/search.ts';
import type { CardRow, UnitRow } from '../store/repo.ts';

/** 命中项的锚点 + 原文（`evidence` 与 `text` 的素材）。 */
function anchorOfCard(repo: RetrievalDeps['repo'], cardId: string): { quote: string; text: string; span: Span } | null {
  const c: CardRow | undefined = repo.getCardRow(cardId);
  if (!c) return null;
  const span = toSpan(c);
  if (!span) return null; // 没有真锚点 → 由调用方丢弃（规则 1），不做"假锚点"
  const quote = (c.evidence_quote ?? '').trim();
  const text = [c.name, c.one_line, c.purpose, quote].filter(Boolean).join(' — ');
  return { quote, text, span };
}

function anchorOfUnit(repo: RetrievalDeps['repo'], unitId: string): { quote: string; text: string; span: Span } | null {
  const u: UnitRow | undefined = repo.getUnitRow(unitId);
  if (!u) return null;
  const span = toSpan(u);
  if (!span) return null;
  return {
    quote: '',
    text: [u.title, u.text].filter(Boolean).join(' — '),
    span,
  };
}

/** `why`：[检索到的命中词项] —— 让学生看到"为什么这条被召回"。 */
export function wikiWhy(terms: string[], hitQuote: string, matched: string[]): string {
  const shown = matched.length > 0 ? matched : terms.slice(0, 3);
  const list = shown.map((t) => `「${t}」`).join('');
  return hitQuote
    ? `bigram 命中${list}；原文含「${hitQuote}」`
    : `bigram 命中${list}`;
}

/** RRF 秩分常数（文献常用 60）。 */
export const RRF_K = 60;

/**
 * 由**秩**派生分数：`1/(K+rank)`（rank 从 0 起）。
 *
 * 为什么不用 bm25 原值：实测本语料下 `bm25()` ≈ 1e-6，`store/search.ts` 的
 * `.toFixed(4)` 会把它全部舍成 0（见 `retrieve` 里的长注释）。
 * 秩分**单调等价于 FTS 顺序**，且与 `kg` 的分数可比（用于 `mergeItems` 排序）。
 */
export function rrfScore(rank: number): number {
  return Number((1 / (RRF_K + Math.max(0, rank))).toFixed(8));
}

/**
 * 多文档结果按**秩交错**：每个文档的第 1 名并列在前，再排第 2 名……
 * 保证"每个文档都有机会进 top-K"，同时**不破坏每个文档内部的相关性顺序**。
 */
export function interleaveByRank(drafts: RetrievedItemDraft[]): RetrievedItemDraft[] {
  const byDoc = new Map<string, RetrievedItemDraft[]>();
  for (const d of drafts) {
    const key = String(d.doc_id ?? '');
    const list = byDoc.get(key) ?? [];
    list.push(d);
    byDoc.set(key, list);
  }
  // 文档顺序固定（按 doc_id）⟹ 结果可复现
  const docs = [...byDoc.keys()].sort();
  const out: RetrievedItemDraft[] = [];
  const maxLen = Math.max(0, ...[...byDoc.values()].map((v) => v.length));
  for (let i = 0; i < maxLen; i += 1) {
    for (const doc of docs) {
      const item = byDoc.get(doc)?.[i];
      if (item) out.push(item);
    }
  }
  return out;
}

export class WikiRetriever implements Retriever {
  readonly mode = 'wiki' as const;
  private readonly deps: RetrievalDeps;

  constructor(deps: RetrievalDeps) {
    this.deps = deps;
  }

  /**
   * 真探测：查一次**空串** + 读索引行数。
   * `search()` 对空查询返回 `{total:0}` 且**不抛** —— 能返回就说明
   * `search_docs` / `search_fts` 存在（迁移跑过、表建好了）。
   *
   * ★ `dataReady` 用**索引行数**（`search_docs`）判定，**不是**"空串查询的命中数"——
   * 空串查询本来就恒为 0，拿它当 dataReady 会**永远 false**（典型的探测写错）。
   */
  async healthCheck(): Promise<RetrieverHealth> {
    try {
      const r = search(this.deps.db, this.deps.repo, '', { limit: 1 });
      if (r.mode !== 'bigram') {
        return { ok: false, dataReady: false, dataCount: 0, reason: 'search() 未返回 bigram 模式（实现漂移？）' };
      }
      const counts = this.deps.db.ftsCounts();
      const rows = Number(counts.search_docs ?? 0);
      if (rows <= 0) {
        return {
          ok: true,
          dataReady: false,
          dataCount: 0,
          reason:
            'bigram FTS5 就绪（表与分词器可用）；但**当前检索索引为空（索引行 0）→ 检索必然 0 命中**。' +
            '需先上传资料并跑抽取/建索引。',
        };
      }
      return {
        ok: true,
        dataReady: true,
        dataCount: rows,
        reason: `bigram FTS5 就绪：索引行 ${rows}，FTS 行 ${Number(counts.search_fts ?? 0)}`,
      };
    } catch (err) {
      return {
        ok: false,
        dataReady: false,
        dataCount: 0,
        reason: `词法检索不可用：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async retrieve(query: RetrievalQuery): Promise<Retrieved> {
    const t0 = Date.now();
    const limit = Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT));
    const q = (query.q ?? '').trim();

    const health = await this.healthCheck();
    if (!health.ok) {
      return {
        mode: 'wiki',
        modes: ['wiki'],
        items: [],
        elapsedMs: Date.now() - t0,
        available: false,
        reason: health.reason ?? '词法检索不可用',
      };
    }
    // v1 的诚实传统：空查询**结果就是空**，不是"没实现"（search() 已如此，这里补 why）
    if (!q) {
      return { mode: 'wiki', modes: ['wiki'], items: [], elapsedMs: Date.now() - t0, available: true };
    }

    const scope = scopeForUser(this.deps.repo, query.userId);
    const { ids } = visibleDocIds(this.deps.repo, scope, query.docId);
    if (ids.length === 0) {
      return {
        mode: 'wiki',
        modes: ['wiki'],
        items: [],
        elapsedMs: Date.now() - t0,
        available: true,
        reason: query.docId ? '该文档不存在或对你不可见' : '当前没有可见文档',
      };
    }

    const terms = queryTerms(q);
    const drafts: RetrievedItemDraft[] = [];
    /** ★ 在**进入 drafts 之前**就丢掉的条目（源行缺锚点）也必须计数 —— 见下方注释。 */
    let droppedAtSource = 0;

    // 按文档逐个查（`search()` 一次只接受一个 docId）；`limit` 是**每文档**上限，
    // 后面统一按 rank 截断 —— 这样"某个文档命中很多"不会把别的文档挤掉。
    //
    // ⚠️ **不能按 `score` 重排**。实测：SQLite 的 `bm25()` 在小语料上量级是 1e-6，
    // 而 `store/search.ts` 用 `.toFixed(4)` 收口 ⟹ **所有 score 都被舍入成 0**。
    // 此时 `sort((a,b) => b.score - a.score)` 是**空操作**，接着按 doc_id/id 兜底排序，
    // 就等于**把 FTS 已经算好的相关性顺序彻底打乱**（搜"索引"时最相关的卡片可能排到最后）。
    // 唯一可靠的信号是 `search()` 返回的**顺序本身**（`db.ftsSearch` 是 `ORDER BY score`）。
    // 因此这里：① 保留 FTS 顺序 ② 用**秩**（rank）派生可比较的分数。
    for (const docId of ids) {
      const res = search(this.deps.db, this.deps.repo, q, { docId, limit });
      res.hits.forEach((hit, rank) => {
        const info = hit.kind === 'card' ? anchorOfCard(this.deps.repo, hit.ref_id) : anchorOfUnit(this.deps.repo, hit.ref_id);
        // ⚠️ 原错误写法：`if (!info) continue;` —— 静默丢弃。
        //    那正是"看起来成功"的 bug：命中 10 条、返回 3 条、**没有任何提示**。
        //    必须计数并在 reason 里如实说明（规则 1 的诚实要求）。
        if (!info) {
          droppedAtSource += 1;
          return;
        }
        // 命中了哪些查询词项（用于 why）
        const textBI = toBigram(info.text);
        const matched = terms.filter((t) => textBI.includes(t));
        const quoteHit = matched.find((t) => info.text.toLowerCase().includes(t.toLowerCase())) ?? '';
        drafts.push({
          kind: hit.kind === 'card' ? 'card' : 'unit',
          id: hit.ref_id,
          title: hit.title || info.text.slice(0, 40),
          text: info.text,
          evidence: { span: info.span, ...(info.quote ? { quote: info.quote } : {}) },
          // RRF 秩分：`1/(K+rank)`。K=60 是文献常用值；秩从 0 开始。
          // 保留 `rawScore` 仅作原始留痕（当前恒为 0，见上）。
          score: rrfScore(rank),
          why: wikiWhy(terms, quoteHit, matched),
          doc_id: docId,
        });
      });
    }

    // 文档间按**秩**交错（每个文档的第 1 名并列在前，再排第 2 名……），
    // 同名卡片去重后截断 —— 全部保持 FTS 的相关性顺序。
    const ordered = interleaveByRank(drafts);
    const { items, dropped } = enforceEvidence(dedupeByName(ordered), limit);

    // ★ 两类丢弃都要如实上报：源行缺锚点（droppedAtSource）+ 草稿缺锚点（dropped）
    const totalDropped = dropped + droppedAtSource;
    return {
      mode: 'wiki',
      modes: ['wiki'],
      items,
      elapsedMs: Date.now() - t0,
      available: true,
      ...(totalDropped > 0 ? { reason: `${totalDropped} 条命中无可回溯锚点，已按规则 1 丢弃` } : {}),
    };
  }
}

/** 同名去重（保留最高分那条）。 */
export function dedupeByName(drafts: RetrievedItemDraft[]): RetrievedItemDraft[] {
  const seen = new Map<string, RetrievedItemDraft>();
  for (const d of drafts) {
    const key = `${d.kind}\u0000${d.title}`;
    const prev = seen.get(key);
    if (!prev || d.score > prev.score) seen.set(key, d);
  }
  return [...seen.values()];
}

/** 便捷函数（`registry.ts` 与测试用）。 */
export function createWikiRetriever(deps: RetrievalDeps): WikiRetriever {
  return new WikiRetriever(deps);
}

export type { RetrievedItem };
