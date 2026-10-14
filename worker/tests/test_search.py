# -*- coding: utf-8 -*-
"""中文检索测试（纯函数）—— 坑 15：FTS5 默认 tokenizer 对中文 **0 命中**。"""

from __future__ import annotations

import sqlite3

import pytest

from worker.models import Card, Unit, Span
from worker.pipeline import search as search_mod


# ═══════════════════════════════════════════════════════════════════════
# bigram 转换（断言具体字符串）
# ═══════════════════════════════════════════════════════════════════════
def test_to_bigram_exact_strings() -> None:
    assert search_mod.to_bigram("索引优化") == "索引 引优 优化"
    assert search_mod.to_bigram("B+tree index") == "b+tree index"
    assert search_mod.to_bigram("聚簇索引将数据按主键顺序存放") == (
        "聚簇 簇索 索引 引将 将数 数据 据按 按主 主键 键顺 顺序 序存 存放"
    )
    assert search_mod.to_bigram("库") == "库"          # 单字保留，否则单字永不命中
    assert search_mod.to_bigram("sql_mode 与 事务") == "sql_mode 与 事务"
    assert search_mod.to_bigram("") == ""
    assert search_mod.to_bigram("   ") == ""
    assert search_mod.to_bigram("MySQL 26.7 Reference Manual") == (
        "mysql 26.7 reference manual"
    )
    # 去重保序（重复 bigram 只会让 bm25 偏斜）
    assert search_mod.to_bigram("索引索引") == "索引 引索"


def test_query_terms_and_match_expr() -> None:
    assert search_mod.query_terms("索引") == ["索引"]
    assert search_mod.query_terms("索引优化") == ["索引", "引优", "优化"]
    assert search_mod.query_terms("sql_mode") == ["sql_mode"]
    assert search_mod.query_terms("") == []
    assert search_mod.match_expr("事务") == '"事务"'
    assert search_mod.match_expr("索引优化") == '"索引" AND "引优" AND "优化"'
    assert search_mod.match_expr("索引", mode="or") == '"索引"'
    assert search_mod.match_expr("") == ""
    # 词项先被分词，引号会被剥掉（不会拼出非法 FTS5 语法）
    assert search_mod.match_expr('a"b') == '"a" AND "b"'
    assert search_mod.match_expr("索引+优化") == '"索引" AND "优化"'


def test_selftest_reports() -> None:
    out = search_mod.selftest_bigram()
    assert out["索引优化"] == "索引 引优 优化"
    assert out["B+tree index"] == "b+tree index"
    assert out["terms_事务"] == ["事务"]


# ═══════════════════════════════════════════════════════════════════════
# 索引行
# ═══════════════════════════════════════════════════════════════════════
def test_card_and_unit_index_rows() -> None:
    card = Card(id="crd_1", doc_id="doc_x", unit_id="unt_1", name="聚簇索引",
                kind="concept", one_line="数据按主键顺序存放的索引", purpose="范围查询快",
                evidence_quote="Clustered indexes sort rows by key.", confidence=0.9)
    row = search_mod.card_index_row(card)
    assert row["id"] == "card:crd_1" and row["ref_id"] == "crd_1" and row["kind"] == "card"
    assert row["title"] == "聚簇索引"
    assert row["body_bi"].startswith("聚簇 簇索 索引")   # 名字在最前（snippet 命中来源）
    assert "聚簇 簇索" in row["body_bi"]
    assert "clustered indexes" in row["body_bi"]

    unit = Unit(id="unt_1", doc_id="doc_x", ord=1, title="14.6.2 索引优化", level=1,
                span=Span("page", 1, 5), text="聚簇索引将数据按主键顺序存放。")
    urow = search_mod.unit_index_row(unit)
    assert urow["id"] == "unit:unt_1" and urow["kind"] == "unit"
    assert urow["title"] == "14.6.2 索引优化"
    assert "索引 引优 优化" in urow["body_bi"]


def test_index_rows_are_fts5_searchable() -> None:
    """把生成的 bigram 行灌进真 FTS5，验证 bigram 能命中而 unicode61 不能。"""
    card = Card(id="crd_1", doc_id="doc_x", unit_id="unt_1", name="聚簇索引",
                kind="concept", one_line="聚簇索引将数据按主键顺序存放",
                evidence_quote="", confidence=0.9)
    rows = [search_mod.card_index_row(card)]

    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE VIRTUAL TABLE bi USING fts5(title, body_bi)")
    for r in rows:
        conn.execute("INSERT INTO bi(title, body_bi) VALUES(?,?)", (r["title"], r["body_bi"]))
    # ① bigram 命中（2 字词「索引」）
    expr = search_mod.match_expr("索引")
    hits = conn.execute("SELECT COUNT(*) FROM bi WHERE bi MATCH ?", (expr,)).fetchone()[0]
    assert hits == 1
    # ② unicode61 对**同一段中文正文** 0 命中（把 db.py 的对照逻辑搬到这里）
    conn.execute("CREATE VIRTUAL TABLE uni USING fts5(body, tokenize='unicode61')")
    conn.execute("INSERT INTO uni(body) VALUES(?)", (card.one_line,))
    uni_hits = conn.execute(
        'SELECT COUNT(*) FROM uni WHERE uni MATCH ?', ('"' + "索引" + '"',)
    ).fetchone()[0]
    assert uni_hits == 0, "unicode61 对中文必须 0 命中（否则说明测试文本里有空格分词）"
    # ③ 英文标识符：bigram 保持整词 → 可命中
    card2 = Card(id="crd_2", doc_id="doc_x", unit_id="unt_2", name="sql_mode",
                 kind="system_variable", one_line="控制 SQL 校验行为的系统变量",
                 evidence_quote="", confidence=0.9)
    r2 = search_mod.card_index_row(card2)
    conn.execute("INSERT INTO bi(title, body_bi) VALUES(?,?)", (r2["title"], r2["body_bi"]))
    assert conn.execute(
        "SELECT COUNT(*) FROM bi WHERE bi MATCH ?", (search_mod.match_expr("sql_mode"),)
    ).fetchone()[0] == 1


def test_contrast_unicode61_helper() -> None:
    """模块自带的对照工具（worker 内可用；不依赖存储）。"""
    class _NoRepo:  # 该函数只用 sqlite3，不需要 repo
        pass

    hits = search_mod.contrast_unicode61(
        _NoRepo(), "索引", ["聚簇索引将数据按主键顺序存放", "二级索引需要回表"]
    )
    assert hits == 0


def test_snippet_helper_prefers_original_text() -> None:
    text = "…聚簇索引将数据按主键顺序存放，因此范围查询只需读连续的一段…"
    snip = search_mod._snippet(text, "索引")
    assert "索引" in snip and "聚簇 簇索" not in snip
    assert search_mod._snippet("", "索引") == ""
    # 查不到词时给开头片段（不是空串）
    assert search_mod._snippet(text, "不存在") != ""


def test_search_module_has_no_fts_dml() -> None:
    """防回归：worker 不该执行 FTS DML（坑 16 的脏索引发生在 DML 侧）。

    这里断言模块源码里没有 `INSERT INTO search_fts` / `'delete'` 之类指令，
    避免有人把 v1 的脏索引写法搬进来。
    """
    import inspect

    src = inspect.getsource(search_mod)
    assert "'delete'" not in src
    assert "INSERT INTO search_fts" not in src
