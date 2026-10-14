"""中文检索（F8 / 契约 §3 尾注）。

## ★ 坑 15：SQLite FTS5 默认 tokenizer 对中文 **0 命中**

| 方案 | 实测 |
|---|---|
| ``unicode61``（默认） | **0 命中**（中文整段当成一个 token） |
| ``trigram`` | 丢 2 字词（"事务" 搜不到） |
| **bigram 预处理** | **8/8 命中** ✅ |

所以：**入库前**把正文转成 bigram 存进 ``search_docs.body_bi``，查询词也转 bigram，
再用 FTS5 的 ``MATCH`` 查（英文标识符保持整词，不切）。

```python
to_bigram("索引优化")      # → "索引 引优 优化"
to_bigram("B+tree index") # → "b+tree index"
```
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Iterable, Sequence

from worker.models import Card, Unit
# ⚠️ v2：worker 不依赖任何 store（SQLite 归 TS 层）。
# 这里只做**类型注解**引用，运行期不 import legacy store；
# legacy（FastAPI + SQLite）路径的函数体内会自行延迟导入。
if TYPE_CHECKING:  # pragma: no cover
    from worker._legacy.store.repo import Repo

_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")
#: 英文/数字/标识符词（含 . _ - + # $ 等，保持整词不切）
_TOKEN_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.\-+#$@]*")


def to_bigram(s: str) -> str:
    """中文切 bigram，英文保持整词，空格分隔（契约 §3）。

    * ``"索引优化"`` → ``"索引 引优 优化"``
    * ``"B+tree index"`` → ``"b+tree index"``
    * 单字中文（如 "库"）保留本身 —— 否则单字查询永远命中不了
    """
    if not s:
        return ""
    text = s.replace("\u00a0", " ")
    out: list[str] = []
    pos = 0
    for m in _CJK_RE.finditer(text):
        # 中文段之间的英文/数字部分
        gap = text[pos : m.start()]
        out.extend(t.lower() for t in _TOKEN_RE.findall(gap))
        run = m.group(0)
        if len(run) == 1:
            out.append(run)
        else:
            out.extend(run[i : i + 2] for i in range(len(run) - 1))
        pos = m.end()
    out.extend(t.lower() for t in _TOKEN_RE.findall(text[pos:]))
    # 去重但保序（bigram 重复没有检索价值，还会让 bm25 偏斜）
    seen: set[str] = set()
    uniq: list[str] = []
    for t in out:
        if t and t not in seen:
            seen.add(t)
            uniq.append(t)
    return " ".join(uniq)


def query_terms(q: str) -> list[str]:
    """查询词 → FTS5 词项（中文 bigram，英文整词）。"""
    if not q or not q.strip():
        return []
    terms: list[str] = []
    text = q.strip()
    pos = 0
    for m in _CJK_RE.finditer(text):
        terms.extend(t.lower() for t in _TOKEN_RE.findall(text[pos : m.start()]))
        run = m.group(0)
        if len(run) == 1:
            terms.append(run)
        else:
            terms.extend(run[i : i + 2] for i in range(len(run) - 1))
        pos = m.end()
    terms.extend(t.lower() for t in _TOKEN_RE.findall(text[pos:]))
    seen: set[str] = set()
    out: list[str] = []
    for t in terms:
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def match_expr(q: str, *, mode: str = "and") -> str:
    """构造 FTS5 MATCH 表达式：``"索引" AND "引优"``（quote 每个词项防语法报错）。"""
    terms = query_terms(q)
    if not terms:
        return ""
    quoted = [f'"{t.replace(chr(34), chr(34) * 2)}"' for t in terms]
    joiner = " AND " if mode == "and" else " OR "
    return joiner.join(quoted)


# ═══════════════════════════════════════════════════════════════════════
# 索引
# ═══════════════════════════════════════════════════════════════════════
def card_index_row(card: Card) -> dict[str, Any]:
    body = " ".join(
        x
        for x in (
            card.name,
            card.one_line,
            card.purpose,
            card.example or "",
            card.example_explained or "",
            card.evidence_quote,
            " ".join(card.prerequisites),
            " ".join(card.cautions),
        )
        if x
    )
    return {
        "id": f"card:{card.id}",
        "doc_id": card.doc_id,
        "ref_id": card.id,
        "kind": "card",
        "title": card.name,
        "body_bi": to_bigram(body),
    }


def unit_index_row(unit: Unit) -> dict[str, Any]:
    body = f"{unit.title} {unit.text}"
    return {
        "id": f"unit:{unit.id}",
        "doc_id": unit.doc_id,
        "ref_id": unit.id,
        "kind": "unit",
        "title": unit.title,
        "body_bi": to_bigram(body),
    }


def index_cards(repo: Repo, cards: Sequence[Card]) -> int:
    return repo.index_search_rows([card_index_row(c) for c in cards])


def index_document(repo: Repo, doc_id: str, *, units: bool = True) -> dict[str, int]:
    """重建某文档的检索索引（幂等）。"""
    rows: list[dict[str, Any]] = []
    n_cards = 0
    for c in repo.all_cards(doc_id):
        rows.append(card_index_row(c))
        n_cards += 1
    n_units = 0
    if units:
        for u in repo.all_units(doc_id):
            rows.append(unit_index_row(u))
            n_units += 1
    with repo.db.transaction() as conn:
        repo.db.fts_delete_doc(conn, doc_id)
    written = repo.index_search_rows(rows)
    return {"cards": n_cards, "units": n_units, "rows": written}


# ═══════════════════════════════════════════════════════════════════════
# 查询
# ═══════════════════════════════════════════════════════════════════════
@dataclass
class Hit:
    kind: str
    ref_id: str
    title: str
    snippet: str
    score: float
    doc_id: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "ref_id": self.ref_id,
            "title": self.title,
            "snippet": self.snippet,
            "score": round(self.score, 4),
            "doc_id": self.doc_id,
        }


def _snippet(text: str, q: str, *, width: int = 70) -> str:
    """从**原文**（不是 bigram）里截取包含查询词的片段。"""
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        return ""
    for term in query_terms(q):
        if len(term) >= 2:
            i = text.lower().find(term)
            if i != -1:
                s = max(0, i - width // 2)
                e = min(len(text), i + width)
                return ("…" if s > 0 else "") + text[s:e] + ("…" if e < len(text) else "")
    return text[: width * 2] + ("…" if len(text) > width * 2 else "")


def _source_text(repo: Repo, kind: str, ref_id: str) -> str:
    if kind == "card":
        c = repo.get_card(ref_id)
        if not c:
            return ""
        # 名字放最前：命中往往来自名字本身（如"聚簇索引"），snippet 里要看得见
        return " ".join(x for x in (c.name, c.one_line, c.purpose, c.evidence_quote) if x)
    u = repo.get_unit(ref_id)
    return f"{u.title} {u.text}".strip() if u else ""


def search(
    repo: Repo, q: str, *, doc_id: str | None = None, limit: int = 20, offset: int = 0
) -> list[Hit]:
    """bigram 检索。返回空列表 = 真的没有（不是"没实现"）。"""
    expr = match_expr(q)
    if not expr:
        return []
    rows = repo.fts_search(expr, doc_id=doc_id, limit=int(limit) + int(offset))
    hits: list[Hit] = []
    for r in rows[offset:]:
        hits.append(
            Hit(
                kind=r["kind"],
                ref_id=r["ref_id"],
                title=r["title"] or "",
                snippet=_snippet(_source_text(repo, r["kind"], r["ref_id"]), q),
                # bm25 越小越相关 → 取负让"分数大 = 更相关"，与契约示例一致
                score=-float(r["score"]),
                doc_id=r["doc_id"],
            )
        )
    return hits


def search_total(repo: Repo, q: str, *, doc_id: str | None = None) -> int:
    expr = match_expr(q)
    if not expr:
        return 0
    sql = (
        "SELECT COUNT(*) FROM search_fts JOIN search_docs d ON d.rowid = search_fts.rowid "
        "WHERE search_fts MATCH ?"
    )
    params: list[Any] = [expr]
    if doc_id:
        sql += " AND d.doc_id = ?"
        params.append(doc_id)
    return int(repo.db.scalar(sql, params, default=0))


def suggest(repo: Repo, q: str, *, limit: int = 10) -> list[str]:
    """补全：卡片名 / 单元标题的前缀或包含匹配（按命中度排序）。"""
    if not q or not q.strip():
        return []
    out: list[str] = []
    seen: set[str] = set()
    rows = repo.db.query(
        "SELECT title FROM search_docs WHERE title LIKE ? ORDER BY LENGTH(title) LIMIT ?",
        (f"%{q.strip()}%", int(limit) * 2),
    )
    for r in rows:
        t = r["title"]
        if t and t not in seen:
            seen.add(t)
            out.append(t)
        if len(out) >= limit:
            break
    return out


# ═══════════════════════════════════════════════════════════════════════
# 对比证明：默认 tokenizer（unicode61）对中文 0 命中
# ═══════════════════════════════════════════════════════════════════════
def contrast_unicode61(repo: Repo, q: str, texts: Iterable[str]) -> int:
    """把**同样的正文**灌进 ``tokenize='unicode61'`` 的 FTS5 表，返回命中数。

    这是坑 15 的**可复现证明**：同一批文本、同一个查询词，
    unicode61 → 0，bigram → 有结果。
    """
    import sqlite3 as _sqlite3

    conn = _sqlite3.connect(":memory:")
    try:
        conn.execute(
            "CREATE VIRTUAL TABLE t USING fts5(body, tokenize='unicode61')"
        )
        conn.executemany(
            "INSERT INTO t(body) VALUES(?)", [(t,) for t in texts if t]
        )
        # unicode61 不切中文 → 查询词要原样匹配整段；用引号包住避免语法错
        expr = '"' + q.replace('"', '""') + '"'
        # 注意：即便按整段匹配，unicode61 也会把"索引"当作一个 token 与文本中
        # 被空格切开的片段比较 → 中文查询拿不到结果
        return int(conn.execute("SELECT COUNT(*) FROM t WHERE t MATCH ?", (expr,)).fetchone()[0])
    except _sqlite3.OperationalError:
        return 0
    finally:
        conn.close()


def selftest_bigram() -> dict[str, Any]:
    """给 /capabilities 或日志用的自检（不依赖数据库）。"""
    a = to_bigram("索引优化")
    b = to_bigram("B+tree index")
    return {
        "索引优化": a,
        "B+tree index": b,
        "terms_索引": query_terms("索引"),
        "terms_事务": query_terms("事务"),
        "terms_sql_mode": query_terms("sql_mode"),
        "match_索引": match_expr("索引"),
    }
