/**
 * 中文检索预处理（契约 `docs/API_PROTOCOL.md` §3 尾注 / 坑 15）。
 *
 * ⚠️ **为什么必须自建 bigram**（本机实测，非转述）：
 * ```text
 * sqlite 3.53.2，同一段中文正文「聚簇索引将数据按主键顺序存放，二级索引需要回表。」
 *   unicode61（FTS5 默认 tokenizer）  索引 → 0 命中   ← 中文整段被当成一个 token
 *   bigram 预处理                     索引 → 1 命中
 * ```
 * 见 `test/store_bigram.test.ts` 的对照断言（同库同文本，两个数一起断言）。
 *
 * 语义**逐字对齐** `worker/pipeline/search.py`（v1 已验证的算法，不要重新发明）：
 * ```text
 * toBigram("索引优化")   → "索引 引优 优化"
 * toBigram("B+tree index")→ "b+tree index"      （英文标识符保持整词）
 * toBigram("库")         → "库"                  （单字保留，否则单字查询永不命中）
 * ```
 */

/** CJK 段（含扩展 A + 兼容表意文字）。 */
const CJK_SOURCE = '[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]+';
/** 英文/数字/标识符词（含 `. _ - + # $ @`，保持整词不切）。 */
const TOKEN_SOURCE = '[A-Za-z0-9_][A-Za-z0-9_.\\-+#$@]*';

function cjkRe(): RegExp {
  return new RegExp(CJK_SOURCE, 'gu');
}
function tokenRe(): RegExp {
  return new RegExp(TOKEN_SOURCE, 'gu');
}

interface SplitStats {
  terms: string[];
}

/** 把一段文本切成「中文 bigram + 英文整词」的词项序列（不去重）。 */
function termsOf(text: string): string[] {
  const out: string[] = [];
  let pos = 0;
  const re = cjkRe();
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const gap = text.slice(pos, m.index);
    for (const t of gap.match(tokenRe()) ?? []) out.push(t.toLowerCase());
    const run = m[0];
    if (run.length === 1) {
      out.push(run);
    } else {
      for (let i = 0; i + 2 <= run.length; i += 1) out.push(run.slice(i, i + 2));
    }
    pos = m.index + run.length;
  }
  for (const t of text.slice(pos).match(tokenRe()) ?? []) out.push(t.toLowerCase());
  return out;
}

/** 去重但保序（bigram 重复没有检索价值，还会让 bm25 偏斜）。 */
function dedupe(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of terms) {
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * 中文切 bigram，英文保持整词，空格分隔（契约 §3）。
 * 入库前对正文调用、查询时对查询词调用 —— **两侧必须用同一个函数**，否则永远搜不到。
 */
export function toBigram(s: string): string {
  if (!s) return '';
  const text = s.replace(/\u00a0/g, ' ');
  return dedupe(termsOf(text)).join(' ');
}

/** 查询词 → FTS5 词项（中文 bigram，英文整词）。 */
export function queryTerms(q: string): string[] {
  if (!q || !q.trim()) return [];
  return dedupe(termsOf(q.trim()));
}

/**
 * 构造 FTS5 MATCH 表达式：`"索引" AND "引优" AND "优化"`。
 * 每个词项都加双引号（防 `-`/`*`/`NEAR` 等被当语法），内部 `"` 双写转义。
 */
export function matchExpr(q: string, mode: 'and' | 'or' = 'and'): string {
  const terms = queryTerms(q);
  if (terms.length === 0) return '';
  const quoted = terms.map((t) => `"${t.replace(/"/g, '""')}"`);
  return quoted.join(mode === 'and' ? ' AND ' : ' OR ');
}

/** 自检（供 `/capabilities` 与日志；不依赖数据库）。 */
export function selftestBigram(): SplitStats & Record<string, unknown> {
  return {
    terms: queryTerms('索引'),
    ['索引优化']: toBigram('索引优化'),
    ['B+tree index']: toBigram('B+tree index'),
    terms_索引: queryTerms('索引'),
    terms_事务: queryTerms('事务'),
    terms_sql_mode: queryTerms('sql_mode'),
    match_索引: matchExpr('索引'),
  };
}
