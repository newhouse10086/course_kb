# -*- coding: utf-8 -*-
"""单元划分测试（**纯函数**，不依赖存储）—— 坑 5 的量化对照。

迁移自 v1 `tests/test_pipeline.py` 的单元划分部分，改成 v2 worker 的纯 API
（`worker.pipeline.units`，输入输出都是 model 对象，无 SQLite）。
"""

from __future__ import annotations

import pytest

from worker.models import Span, Unit
from worker.pipeline import units as units_mod


def mk(uid: str, ord_: int, title: str, level: int, start: int, end: int,
       parent: str | None = None, text: str = "", kind: str = "page") -> Unit:
    return Unit(
        id=uid, doc_id="doc_test00000001", ord=ord_, title=title, level=level,
        parent_id=parent, span=Span(kind, start, end),
        text=text or f"{title} 正文内容",
    )


# ═══════════════════════════════════════════════════════════════════════
# ★ 坑 5：旧算法 vs 递归下降（漏页数对比）
# ═══════════════════════════════════════════════════════════════════════
def test_recursive_descent_beats_legacy_on_missing_pages() -> None:
    """90 页的叶子章 + 10 页的父章：旧算法把 90 页整片丢掉。

    上游实测同源现象：N=8 时漏 1874 个节点，含 Chapter 8 Security 的 616 页。
    """
    units = [
        mk("unt_root", 1, "Chapter 1 General Information", 1, 1, 10),
        mk("unt_11", 2, "1.1 About This Manual", 2, 1, 5, parent="unt_root"),
        mk("unt_12", 3, "1.2 Overview", 2, 6, 10, parent="unt_root"),
        mk("unt_c8", 4, "Chapter 8 Security", 1, 11, 100),
    ]
    picked, stats = units_mod.pick_units(units, max_pages=8)

    assert stats.content_units == 100          # 单元声明的全部内容单位
    assert stats.pages_covered == 100
    assert stats.missing_pages == []
    assert stats.coverage == 1.0
    assert stats.n_window == 12                # 90 页叶子 → 8×11 + 2
    assert stats.n_section == 2
    assert stats.n_intro == 0                  # 根从第 1 页起，没有引言段
    assert stats.n_picked == 14
    wins = [p for p in picked if p.kind == "window"]
    assert (wins[0].span.start, wins[0].span.end) == (11, 18)
    assert (wins[-1].span.start, wins[-1].span.end) == (99, 100)
    assert wins[0].unit_id == "unt_c8"

    legacy, lstats = units_mod.pick_units_legacy(units, max_pages=8)
    assert lstats.pages_covered == 10
    assert len(lstats.missing_pages) == 90
    assert lstats.missing_pages[0] == 11 and lstats.missing_pages[-1] == 100
    assert len(legacy) == 2

    cmp = units_mod.compare_algorithms(units, max_pages=8)
    assert cmp["missing_pages_legacy"] == 90
    assert cmp["missing_pages_recursive"] == 0
    assert cmp["legacy"]["n_picked"] == 2 and cmp["recursive"]["n_picked"] == 14


def test_intro_segment_emitted_when_first_child_late() -> None:
    """父节点在第一页就开始，子节点从 20 页起 → 1–19 页必须作为"引言段"补上。"""
    units = [
        mk("unt_root", 1, "Chapter 5 Tutorial", 1, 1, 40),
        mk("unt_a", 2, "5.1 Connecting", 2, 20, 25, parent="unt_root"),
        mk("unt_b", 3, "5.2 Entering Queries", 2, 26, 40, parent="unt_root"),
    ]
    picked, stats = units_mod.pick_units(units, max_pages=8)
    intros = [p for p in picked if "（引言）" in p.title]
    # 19 页引言 > 8 → 切成 3 个窗口（kind 记 window，标题保留"（引言）"）
    assert [(p.span.start, p.span.end) for p in intros] == [(1, 8), (9, 16), (17, 19)]
    assert intros[0].title == "Chapter 5 Tutorial（引言）（1/3）"
    assert stats.n_window == 5 and stats.n_section == 1  # 3 引言窗 + 5.2 的 2 个窗
    assert [(p.span.start, p.span.end) for p in picked if p.kind == "section"] == [(20, 25)]
    assert stats.coverage == 1.0 and stats.missing_pages == []


def test_small_parent_taken_as_whole_when_children_nested() -> None:
    """PDF 场景：父 span 覆盖子 span，且够小 → 整体一个单元（不过度下钻）。"""
    units = [
        mk("unt_root", 1, "1.4 Getting Information", 1, 30, 34),
        mk("unt_a", 2, "1.4.1 SHOW", 2, 30, 31, parent="unt_root"),
        mk("unt_b", 3, "1.4.2 SELECT", 2, 32, 34, parent="unt_root"),
    ]
    picked, _ = units_mod.pick_units(units, max_pages=8)
    assert len(picked) == 1
    assert picked[0].unit_id == "unt_root" and picked[0].kind == "section"


def test_non_nested_parent_must_descend_char_spans() -> None:
    """文本/DOCX 的父区间**止于下一个标题** → 子区间不在父区间内，必须下钻。

    ✗ 错误写法：只要 `span <= 预算` 就收手 → 子节点正文整片没人管
      （第一版就这样，靠"子节点是否落在父区间内"这个判据修掉）
    """
    units = [
        mk("unt_p", 1, "第一章 数据库基础", 1, 0, 99, kind="char"),
        mk("unt_11", 2, "1.1 索引", 2, 100, 199, parent="unt_p", kind="char"),
        mk("unt_12", 3, "1.2 事务", 2, 200, 299, parent="unt_p", kind="char"),
    ]
    picked, stats = units_mod.pick_units(units)
    assert stats.coverage == 1.0 and stats.missing_count == 0
    assert {p.unit_id for p in picked} == {"unt_p", "unt_11", "unt_12"}
    # 父节点自己的 0..99 作为"引言"产出
    assert [p.kind for p in picked] == ["intro", "section", "section"]


def test_char_budget_is_chars_not_pages() -> None:
    """char span 的预算是**字符数**（8 页 ≈ 8000 字符），不能拿 8 去切。"""
    assert units_mod.budget_for("page") == 8
    assert units_mod.budget_for("char") == 8000
    assert units_mod.budget_for("time") == 300_000
    assert units_mod.budget_for("slide") == 8

    text = "字" * 5000
    u = Unit(id="unt_t", doc_id="doc_x", ord=1, title="短章", level=1,
             span=Span("char", 0, 4999), text=text)
    picked, _ = units_mod.pick_units([u])
    assert len(picked) == 1 and picked[0].text == text[:8000]

    long_text = "".join(f"{i:04d}" for i in range(2500))  # 10000 字符
    u2 = Unit(id="unt_t2", doc_id="doc_x", ord=1, title="长章", level=1,
              span=Span("char", 0, 9999), text=long_text)
    picked2, stats2 = units_mod.pick_units([u2])
    assert len(picked2) == 2
    assert picked2[0].text == long_text[:8000]
    assert picked2[1].text == long_text[8000:]
    assert stats2.coverage == 1.0 and stats2.missing_count == 0


def test_excluded_ranges_are_not_counted_as_missing() -> None:
    """主动排除的非内容章（索引/术语表）既不算内容、也不算漏页。"""
    units = [mk("unt_1", 1, "Chapter 1", 1, 1, 10), mk("unt_2", 2, "Chapter 2", 1, 11, 20)]
    _picked, stats = units_mod.pick_units(
        units, max_pages=4, pages_total=20, excluded_ranges=[[15, 20]]
    )
    assert stats.pages_total == 20
    assert stats.content_units == 14          # 1..14（15..20 被排除）
    assert stats.missing_pages == []
    assert stats.coverage == 1.0
    assert stats.coverage_declared == 0.7     # 14/20（含被排除页的分母）


def test_empty_units_raises() -> None:
    picked, stats = units_mod.pick_units([])
    assert picked == [] and stats.pages_total == 0 and stats.coverage == 0.0


def test_pick_stats_to_dict_shape() -> None:
    units = [mk("unt_1", 1, "c1", 1, 1, 3)]
    _p, stats = units_mod.pick_units(units, max_pages=8)
    d = stats.to_dict()
    assert set(d) >= {
        "pages_total", "content_units", "pages_covered", "coverage", "coverage_declared",
        "missing_pages", "missing_count", "n_nodes", "n_picked", "n_section", "n_intro",
        "n_window",
    }
    assert d["n_picked"] == 1 and d["n_section"] == 1 and d["missing_count"] == 0


def test_picked_unit_shapes() -> None:
    units = [mk("unt_1", 1, "c1", 1, 1, 20, text="x" * 50)]
    picked, _ = units_mod.pick_units(units, max_pages=8)
    assert all(p.chars == len(p.text) for p in picked)
    assert picked[0].to_dict()["chars"] == picked[0].chars
    assert [p.ord for p in picked] == list(range(1, len(picked) + 1))
