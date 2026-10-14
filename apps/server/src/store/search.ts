/**
 * 中文全文检索（契约 §5.4 / 坑 15）—— bigram 预处理 + FTS5。
 *
 * 语义**逐字对齐** `worker/pipeline/search.py`（v1 已验证）：
 * - 索引写入 `search_docs.body_bi`（bigram 化后的正文）
 * - 查询词同样 bigram 化，再构造 FTS5 `MATCH`
 * - `snippet` 取自**原文**（不是 bigram 串），否则前端显示的是"聚簇 簇索"这种碎片
 * - `score = -bm25(...)`：bm25 越小越相关，取负让"分数大 = 更相关"，与契约 §5.4 示例一致
 */

import type { Db } from './db.ts';
import { contrastUnicode61 } from './db.ts';
import type { SearchRow } from './db.ts';
import { matchExpr, queryTerms, toBigram } from './bigram.ts';
import type { CardApi, CardRow, Repo, UnitApi, UnitRow } from './repo.ts';
import { cardToApi, unitToApi } from './repo.ts';

export interface SearchHit {
  kind: string;
  ref_id: string;
  title: string;
  snippet: string;
  score: number;
  doc_id: string;
}

export interface SearchResponse {
  q: string;
  total: number;
  hits: SearchHit[];
  /** 契约 §5.4 未强制，但 UI 要显示"用的是 bigram"（v1 同款） */
  mode: 'bigram';
  terms: string[];
}

// ═══════════════════════════════════════════════════════════════════════
// 索引行构造
// ═══════════════════════════════════════════════════════════════════════

export function cardIndexRow(card: CardApi): SearchRow {
  const body = [
    card.name,
    card.one_line,
    card.purpose,
    card.example ?? '',
    card.example_explained ?? '',
    card.evidence_quote,
    card.prerequisites.join(' '),
    card.cautions.join(' '),
  ]
    .filter(Boolean)
    .join(' ');
  return {
    id: `card:${card.id}`,
    doc_id: card.doc_id,
    ref_id: card.id,
    kind: 'card',
    title: card.name,
    body_bi: toBigram(body),
  };
}

export function unitIndexRow(unit: UnitApi): SearchRow {
  return {
    id: `unit:${unit.id}`,
    doc_id: unit.doc_id,
    ref_id: unit.id,
    kind: 'unit',
    title: unit.title,
    body_bi: toBigram(`${unit.title} ${unit.text}`),
  };
}

/** 重建某文档的检索索引（**幂等**：先清后建）。 */
export function indexDocument(db: Db, repo: Repo, docId: string): { cards: number; units: number; rows: number } {
  const cards = repo.allCardRows(docId).map(cardToApi);
  const units = repo.allUnitRows(docId).map(unitToApi);
  const rows: SearchRow[] = [
    ...cards.map(cardIndexRow),
    ...units.map(unitIndexRow),
  ];
  return db.tx(() => {
    db.ftsDeleteDoc(docId);
    const written = db.ftsUpsert(rows);
    return { cards: cards.length, units: units.length, rows: written };
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 查询
// ═══════════════════════════════════════════════════════════════════════

/** 从**原文**（不是 bigram）里截取包含查询词的片段。 */
export function snippet(text: string, q: string, width = 70): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  for (const term of queryTerms(q)) {
    if (term.length >= 2) {
      const i = flat.toLowerCase().indexOf(term);
      if (i !== -1) {
        const s = Math.max(0, i - Math.floor(width / 2));
        const e = Math.min(flat.length, i + width);
        return `${s > 0 ? '…' : ''}${flat.slice(s, e)}${e < flat.length ? '…' : ''}`;
      }
    }
  }
  return flat.slice(0, width * 2) + (flat.length > width * 2 ? '…' : '');
}

/** 命中项的原文（snippet 的素材）。卡片把 name 放最前：命中常来自名字本身。 */
function sourceText(repo: Repo, kind: string, refId: string): string {
  if (kind === 'card') {
    const c = repo.getCard(refId);
    if (!c) return '';
    return [c.name, c.one_line, c.purpose, c.evidence_quote].filter(Boolean).join(' ');
  }
  const u = repo.getUnit(refId);
  return u ? `${u.title} ${u.text}`.trim() : '';
}

/** bigram 检索。**空结果 = 真的没有**（不是"没实现"）。 */
export function search(
  db: Db,
  repo: Repo,
  q: string,
  opts: { docId?: string; limit?: number; offset?: number } = {},
): SearchResponse {
  const expr = matchExpr(q);
  const terms = queryTerms(q);
  const limit = Math.max(1, Math.trunc(opts.limit ?? 20));
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  if (!expr) return { q, total: 0, hits: [], mode: 'bigram', terms: [] };

  const total = db.ftsCount(expr, opts.docId);
  const rows = db.ftsSearch(expr, { ...(opts.docId ? { docId: opts.docId } : {}), limit: limit + offset });
  const hits: SearchHit[] = rows.slice(offset).map((r) => ({
    kind: r.kind,
    ref_id: r.ref_id,
    title: r.title ?? '',
    snippet: snippet(sourceText(repo, r.kind, r.ref_id), q),
    score: Number((-Number(r.score)).toFixed(4)),
    doc_id: r.doc_id,
  }));
  return { q, total, hits, mode: 'bigram', terms };
}

/** 补全：卡片名/单元标题的子串匹配（按长度升序，短标题更像"词条"）。 */
export function suggest(db: Db, q: string, opts: { limit?: number } = {}): string[] {
  const limit = Math.max(1, Math.trunc(opts.limit ?? 10));
  const needle = (q ?? '').trim();
  if (!needle) return [];
  const rows = db.all<{ title: string }>(
    'SELECT title FROM search_docs WHERE title LIKE ? ORDER BY LENGTH(title) LIMIT ?',
    `%${needle}%`,
    limit * 2,
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const t = r.title;
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * ★ 坑 15 的**可复现对照**：同一批正文、同一个查询词，
 * `unicode61`（FTS5 默认 tokenizer）→ 0 命中，bigram → N 命中。
 *
 * 对照必须用**真实正文**（中文连续书写、无空格）。若文本里写成 "索引 " 带空格，
 * unicode61 反而能命中 —— 那不是真实场景，会得出错误结论。
 */
export function contrast(
  db: Db,
  repo: Repo,
  q: string,
  opts: { docId?: string } = {},
): {
  q: string;
  doc_id: string | null;
  bigram_hits: number;
  unicode61_hits: number;
  texts_compared: number;
  tokenizer: 'unicode61';
  conclusion: string;
} {
  const expr = matchExpr(q);
  const bigramHits = expr ? db.ftsCount(expr, opts.docId) : 0;

  const texts: string[] = [];
  const docIds = opts.docId
    ? [opts.docId]
    : db.all<{ doc_id: string }>('SELECT DISTINCT doc_id FROM search_docs').map((r) => r.doc_id);
  for (const docId of docIds) {
    for (const u of repo.allUnitRows(docId)) if (u.text) texts.push(u.text);
    for (const c of repo.allCardRows(docId)) {
      const body = [c.name, c.one_line, c.purpose, c.evidence_quote].filter(Boolean).join(' ');
      if (body) texts.push(body);
    }
  }

  const unicode61Hits = contrastUnicode61(q, texts);
  return {
    q,
    doc_id: opts.docId ?? null,
    bigram_hits: bigramHits,
    unicode61_hits: unicode61Hits,
    texts_compared: texts.length,
    tokenizer: 'unicode61',
    // ⚠️ `conclusion` 必须**永远与这两个数字一致**。
    // 原错误写法：`bigramHits > unicode61Hits ? '…unicode61 为 0…'` ——
    // 当真实数据里 unicode61 命中 2（存在一个**正好等于查询词**的卡片名，
    // 或该词被标点/空格切成独立 token）而 bigram 命中 11 时，
    // 这条"两者都 > 0 但 bigram 更多"的情况会被错误描述成"unicode61 为 0"**撒谎**。
    conclusion: buildContrastConclusion(bigramHits, unicode61Hits),
  };
}

/** 生成与实测数字严格一致的结论（4 种情况互斥且穷尽）。 */
export function buildContrastConclusion(bigramHits: number, unicode61Hits: number): string {
  if (bigramHits === 0 && unicode61Hits === 0) {
    return '两者都 0：该查询词在这批正文里确实不存在（不是 tokenizer 问题）';
  }
  if (unicode61Hits === 0 && bigramHits > 0) {
    return 'bigram 命中而 unicode61 为 0 → 必须自建 bigram（坑 15）';
  }
  if (bigramHits > unicode61Hits) {
    return (
      `bigram ${bigramHits} 命中 / unicode61 ${unicode61Hits} 命中：` +
      'unicode61 的少量命中来自"整条内容正好等于查询词"或"该词被空格/标点切成独立 token"，' +
      '**中文连续文本仍需 bigram**（漏检率随语料上升）'
    );
  }
  return `unicode61 ${unicode61Hits} 命中 ≥ bigram ${bigramHits} 命中：本批语料对中文切词不敏感（多见于英文/代码为主的语料），bigram 无优势`;
}

/** 检索索引规模（`/capabilities` 与诊断用）。 */
export function searchStats(db: Db): { tokenizer: 'bigram'; fts5: true; rows: number; indexed: number } {
  const counts = db.ftsCounts();
  return { tokenizer: 'bigram', fts5: true, rows: counts.search_docs, indexed: counts.search_fts };
}

/** 供测试直接构造索引行（避免依赖 Repo）。 */
export function rowsForCards(cards: CardRow[]): SearchRow[] {
  return cards.map((c) => cardIndexRow(cardToApi(c)));
}

export function rowsForUnits(units: UnitRow[]): SearchRow[] {
  return units.map((u) => unitIndexRow(unitToApi(u)));
}
