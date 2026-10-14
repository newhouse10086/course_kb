# -*- coding: utf-8 -*-
"""Adapter 契约测试（契约 §4）—— 用**真实生成的文件**跑，不 mock。

覆盖：
* 四种格式各自的切分/层级/span 具体值
* ``DocDraft.validate()`` 的四类非法输入（空 units / ord 重复 / 悬空 parent / 环）
* PDF 的坑 1（栈式建树）/ 坑 2（不嵌套不修）/ 坑 3（非内容章排除但不静默丢页）
* 注册表 ``pick()`` / ``by_kind()`` / ``available_kinds()`` 一致性
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from worker.adapters import registry
from worker.adapters.base import (
    DocDraft,
    ParseError,
    Span,
    UnitDraft,
    UnsupportedFormat,
    draft_to_units,
)
from worker.adapters.pdf import PdfAdapter, normalize_title
from worker.models.common import ModelError, SpanViolation


# ═══════════════════════════════════════════════════════════════════════
# fixtures：真实生成文件
# ═══════════════════════════════════════════════════════════════════════
@pytest.fixture()
def md_file(tmp_path: Path) -> Path:
    p = tmp_path / "course.md"
    p.write_text(
        "# 第一章 数据库基础\n"
        "关系模型把数据组织成二维表。\n"
        "\n"
        "## 1.1 关系模型\n"
        "关系是一张表，元组是一行。\n"
        "\n"
        "### 1.1.1 键\n"
        "超键、候选键、主键。\n"
        "\n"
        "## 1.2 范式\n"
        "1NF 到 3NF。\n"
        "\n"
        "# 第二章 索引\n"
        "索引加速查询。\n",
        encoding="utf-8",
    )
    return p


@pytest.fixture()
def plain_text_file(tmp_path: Path) -> Path:
    lines = []
    for i in range(1, 91):
        lines.append(f"第 {i} 行：数据库课程讲义正文内容，用于验证无标题时的固定窗口切分（每块 2000 字符）。")
    p = tmp_path / "plain.txt"
    p.write_text("\n".join(lines), encoding="utf-8")
    return p


@pytest.fixture()
def docx_file(tmp_path: Path) -> Path:
    docx = pytest.importorskip("docx")
    from docx.shared import Pt  # noqa: F401

    doc = docx.Document()
    doc.add_heading("数据库课程讲义", level=1)
    doc.add_paragraph("课程简介：本课程讲关系模型、SQL 与索引。")
    doc.add_heading("1 关系模型", level=2)
    doc.add_paragraph("关系模型用二维表表示数据。")
    doc.add_heading("1.1 键与约束", level=3)
    doc.add_paragraph("主键唯一标识一行。")
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "字段"
    table.cell(0, 1).text = "含义"
    table.cell(1, 0).text = "id"
    table.cell(1, 1).text = "主键"
    doc.add_heading("2 SQL 基础", level=2)
    doc.add_paragraph("SELECT 是最常用的语句。")
    p = tmp_path / "lecture.docx"
    doc.save(str(p))
    return p


@pytest.fixture()
def pptx_file(tmp_path: Path) -> Path:
    pptx = pytest.importorskip("pptx")
    prs = pptx.Presentation()
    layout = prs.slide_layouts[1]  # Title and Content
    titles = ["数据库课程", "1.1 关系模型", "1.2 索引", "3.1 事务"]
    for t in titles:
        slide = prs.slides.add_slide(layout)
        slide.shapes.title.text = t
        slide.placeholders[1].text = f"{t} 的内容要点。"
        slide.notes_slide.notes_text_frame.text = f"{t} 的备注（老师讲解）。"
    p = tmp_path / "slides.pptx"
    prs.save(str(p))
    return p


@pytest.fixture()
def pdf_file(tmp_path: Path) -> Path:
    """12 页 PDF，TOC 含：嵌套小节、一个真正的 Index 章、一个含 Index 字样的**正文**小节。"""
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    for i in range(1, 13):
        page = doc.new_page()
        page.insert_text((72, 72), f"page {i} body text about MySQL indexes and tables.")
    doc.set_toc(
        [
            [1, "Chapter 1 General Information", 1],
            [2, "1.1 About This Manual", 1],
            [3, "1.1.1 Using the Manual", 2],
            [1, "Chapter 2 Installing MySQL", 5],
            [2, "2.1 General Installation Guidance", 5],
            [1, "Chapter 3 Optimization and Indexes", 9],
            [2, "3.1 Add Indexes", 9],
            [1, "Index", 11],
        ]
    )
    p = tmp_path / "manual.pdf"
    doc.save(str(p))
    doc.close()
    return p


@pytest.fixture()
def pdf_no_toc(tmp_path: Path) -> Path:
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    for i in range(1, 20):
        doc.new_page().insert_text((72, 72), f"content {i}")
    p = tmp_path / "no_toc.pdf"
    doc.save(str(p))
    doc.close()
    return p


# ═══════════════════════════════════════════════════════════════════════
# 注册表
# ═══════════════════════════════════════════════════════════════════════
def test_registry_pick_by_extension(md_file: Path, pdf_file: Path, docx_file: Path, pptx_file: Path) -> None:
    assert registry.pick(str(md_file)).kind == "text"
    assert registry.pick(str(pdf_file)).kind == "pdf"
    assert registry.pick(str(docx_file)).kind == "docx"
    assert registry.pick(str(pptx_file)).kind == "pptx"
    kinds = registry.available_kinds()
    assert {"pdf", "pptx", "docx", "text"} <= set(kinds)
    assert registry.by_kind("pdf") is not None
    assert registry.by_kind("不存在") is None
    assert ".pdf" in registry.supported_extensions()


def test_registry_unsupported(tmp_path: Path) -> None:
    p = tmp_path / "weird.zzz"
    p.write_bytes(b"\x00\x01\x02")
    with pytest.raises(UnsupportedFormat) as exc:
        registry.pick(str(p))
    assert "weird.zzz" in str(exc.value)


# ═══════════════════════════════════════════════════════════════════════
# TextAdapter
# ═══════════════════════════════════════════════════════════════════════
def test_text_adapter_markdown_hierarchy(md_file: Path) -> None:
    draft = registry.pick(str(md_file)).parse(str(md_file))
    draft.validate()
    titles = [u.title for u in draft.units]
    assert titles == ["第一章 数据库基础", "1.1 关系模型", "1.1.1 键", "1.2 范式", "第二章 索引"]
    assert [u.level for u in draft.units] == [1, 2, 3, 2, 1]
    assert [u.ord for u in draft.units] == [1, 2, 3, 4, 5]
    # 父子：1.1 与 1.2 挂在第一章下，1.1.1 挂在 1.1 下，第二章是新的根
    assert [u.parent_ord for u in draft.units] == [None, 1, 2, 1, None]
    assert len(draft.roots) == 2
    assert draft.units[2].text == "超键、候选键、主键。"
    assert "关系是一张表" in draft.units[1].text
    # span 是字符偏移，且单位是 char
    assert all(u.span.kind == "char" for u in draft.units)
    assert draft.units[0].span.start == 0
    assert draft.units[1].span.start > draft.units[0].span.start
    assert draft.meta["mode"] == "headings"


def test_text_adapter_windows_when_no_headings(plain_text_file: Path) -> None:
    draft = registry.pick(str(plain_text_file)).parse(str(plain_text_file))
    assert draft.meta["mode"] == "windows"
    chars = draft.meta["chars"]
    # 窗口 2000 字符 → 3 块（5400+ 字符）
    assert chars > 4000, chars
    assert len(draft.units) == (chars + 1999) // 2000
    assert all(u.level == 1 and u.parent_ord is None for u in draft.units)
    assert draft.units[0].span.start == 0
    assert draft.units[-1].span.end == chars - 1
    # 窗口必须首尾相接，不能有空隙（丢内容）
    for a, b in zip(draft.units, draft.units[1:]):
        assert b.span.start == a.span.end + 1


def test_text_adapter_numbered_headings(tmp_path: Path) -> None:
    p = tmp_path / "chapter.txt"
    p.write_text(
        "1 数据库系统概述\n数据库系统由数据库、DBMS、应用组成。\n"
        "1.1 三级模式\n外模式、概念模式、内模式。\n"
        "1.1.1 数据独立性\n逻辑独立性与物理独立性。\n"
        "2 关系模型\n关系、元组、属性。\n",
        encoding="utf-8",
    )
    draft = registry.pick(str(p)).parse(str(p))
    assert [u.level for u in draft.units] == [1, 2, 3, 1]
    assert [u.parent_ord for u in draft.units] == [None, 1, 2, None]
    assert draft.units[2].title == "1.1.1 数据独立性"


# ═══════════════════════════════════════════════════════════════════════
# DocxAdapter
# ═══════════════════════════════════════════════════════════════════════
def test_docx_adapter_headings_and_table(docx_file: Path) -> None:
    draft = registry.pick(str(docx_file)).parse(str(docx_file))
    draft.validate()
    assert [u.title for u in draft.units] == [
        "数据库课程讲义", "1 关系模型", "1.1 键与约束", "2 SQL 基础",
    ]
    assert [u.level for u in draft.units] == [1, 2, 3, 2]
    assert [u.parent_ord for u in draft.units] == [None, 1, 2, 1]
    assert all(u.span.kind == "char" for u in draft.units)
    # 表格内容必须在正文里（且位于所属小节，不是全跑到文末）
    assert "字段 | 含义" in draft.units[2].text
    assert "id | 主键" in draft.units[2].text
    assert "SELECT 是最常用的语句。" in draft.units[3].text
    assert draft.meta["mode"] == "headings"


# ═══════════════════════════════════════════════════════════════════════
# SlideAdapter
# ═══════════════════════════════════════════════════════════════════════
def test_slide_adapter_one_unit_per_slide(pptx_file: Path) -> None:
    draft = registry.pick(str(pptx_file)).parse(str(pptx_file))
    draft.validate()
    assert len(draft.units) == 4
    assert [u.span.to_dict() for u in draft.units] == [
        {"kind": "slide", "start": 1, "end": 1},
        {"kind": "slide", "start": 2, "end": 2},
        {"kind": "slide", "start": 3, "end": 3},
        {"kind": "slide", "start": 4, "end": 4},
    ]
    assert [u.title for u in draft.units] == ["数据库课程", "1.1 关系模型", "1.2 索引", "3.1 事务"]
    # 带编号的标题会推出层级（1.1 → L2）
    assert [u.level for u in draft.units] == [1, 2, 2, 2]
    # ★ 编号前缀校验：这份 deck 里没有 "1"/"3" 这两级，
    #   所以 1.x / 3.x 都**不硬挂**到封面页下面，而是各自成根（不编造层级）
    assert [u.parent_ord for u in draft.units] == [None, None, None, None]
    # 备注也要抽（F1 明确要求）
    assert "[备注]" in draft.units[0].text
    assert "的内容要点。" in draft.units[0].text
    assert draft.page_count == 4
    assert draft.meta["slides"] == 4


def test_slide_adapter_reports_error_for_broken_file(tmp_path: Path) -> None:
    p = tmp_path / "broken.pptx"
    p.write_bytes(b"not a zip at all")
    with pytest.raises(ParseError):
        registry.pick(str(p)).parse(str(p))


# ═══════════════════════════════════════════════════════════════════════
# PdfAdapter（坑 1 / 2 / 3）
# ═══════════════════════════════════════════════════════════════════════
def test_pdf_toc_tree_stack_algorithm(pdf_file: Path) -> None:
    draft = PdfAdapter().parse(str(pdf_file))
    draft.validate()
    assert draft.page_count == 12
    titles = [u.title for u in draft.units]
    # "Index" 是非内容章 → 排除；其余 7 个保留
    assert titles == [
        "Chapter 1 General Information",
        "1.1 About This Manual",
        "1.1.1 Using the Manual",
        "Chapter 2 Installing MySQL",
        "2.1 General Installation Guidance",
        "Chapter 3 Optimization and Indexes",
        "3.1 Add Indexes",
    ]
    assert [u.level for u in draft.units] == [1, 2, 3, 1, 2, 1, 2]
    # 坑 1：栈式建树 —— 1.1 挂 Chapter 1，1.1.1 挂 1.1，2.1 挂 Chapter 2
    assert [u.parent_ord for u in draft.units] == [None, 1, 2, None, 4, None, 6]
    # span 是"自己 + 子树"的页区间（父节点覆盖子节点所在页）：
    #   Chapter 1 = p.1–4, 1.1 = p.1–4, 1.1.1 = p.2–4, Chapter 2 = p.5–8 …
    assert draft.units[0].span.to_dict() == {"kind": "page", "start": 1, "end": 4}
    assert draft.units[1].span.to_dict() == {"kind": "page", "start": 1, "end": 4}
    assert draft.units[2].span.to_dict() == {"kind": "page", "start": 2, "end": 4}
    assert draft.units[3].span.to_dict() == {"kind": "page", "start": 5, "end": 8}
    assert draft.units[5].span.to_dict() == {"kind": "page", "start": 9, "end": 10}
    assert draft.meta["mode"] == "toc"
    assert draft.meta["toc_nodes"] == 8
    assert draft.meta["skipped_nodes"] == 1
    assert draft.meta["skipped_roots"] == ["Index"]
    assert draft.meta["skipped_pages"] == 2  # p.11–12
    # 坑 3 的**反例保护**：名字里含 Index 的正文小节绝不能被当成索引章删掉
    assert "3.1 Add Indexes" in titles
    assert draft.meta["skipped_pages"] == 2
    assert draft.meta["excluded_pages"] == 2


def test_pdf_skipped_pages_are_not_re_added(pdf_file: Path) -> None:
    draft = PdfAdapter().parse(str(pdf_file))
    # 被排除的 Index 章（p.11–12）不能再以"未编入目录"的形式回来
    assert not any("未编入目录" in u.title for u in draft.units)
    assert draft.meta["synthetic_units"] == 0
    assert draft.meta["coverage_pages"] == 10  # p.1–10 全部被 TOC 覆盖
    assert draft.meta["coverage_rate"] == 1.0


def test_pdf_text_capped_to_max_pages(pdf_file: Path) -> None:
    draft = PdfAdapter(max_pages_per_unit=2).parse(str(pdf_file))
    # 跨度 >2 页的节点只存前 2 页正文（上层章只要引言段），并如实计数
    assert draft.meta["text_capped_units"] >= 1
    big = [u for u in draft.units if u.span.end - u.span.start + 1 > 2]
    assert big, "本 fixture 里应有跨度 >2 的节点"
    assert all(u.text.count("page ") <= 2 for u in big)


def test_pdf_without_toc_falls_back_to_windows(pdf_no_toc: Path) -> None:
    draft = PdfAdapter().parse(str(pdf_no_toc))
    draft.validate()
    assert draft.meta["mode"] == "fixed_windows"
    assert len(draft.units) == 3  # 19 页 / 8 页一块 → 3 块（1-8, 9-16, 17-19）
    assert [u.span.to_dict() for u in draft.units] == [
        {"kind": "page", "start": 1, "end": 8},
        {"kind": "page", "start": 9, "end": 16},
        {"kind": "page", "start": 17, "end": 19},
    ]
    assert draft.meta["coverage_pages"] == 19


def test_pdf_gap_pages_get_synthetic_unit(tmp_path: Path) -> None:
    """TOC 从第 4 页才开始（前面是封面/版权页）→ 未覆盖的页必须有归宿。"""
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    for i in range(1, 21):
        doc.new_page().insert_text((72, 72), f"page {i}")
    doc.set_toc([[1, "Chapter 1 Only", 4], [2, "1.1 Small", 6]])
    p = tmp_path / "gap.pdf"
    doc.save(str(p))
    doc.close()
    draft = PdfAdapter().parse(str(p))
    assert draft.meta["synthetic_units"] == 1
    synth = [u for u in draft.units if "未编入目录" in u.title]
    assert synth[0].span.to_dict() == {"kind": "page", "start": 1, "end": 3}
    assert draft.meta["coverage_pages"] == 20
    assert draft.meta["coverage_rate"] == 1.0


def test_pdf_magic_number_detection(tmp_path: Path) -> None:
    """扩展名不可信（上传文件可能被改名）时按魔数认出来。"""
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    doc.new_page().insert_text((72, 72), "hello")
    p = tmp_path / "renamed.bin"
    doc.save(str(p))
    doc.close()
    assert PdfAdapter().can_handle(str(p)) is True


def test_normalize_title_strips_numbering() -> None:
    assert normalize_title("7.4.2.6 Rule-Based Error Log Filtering") == "Rule-Based Error Log Filtering"
    assert normalize_title("Appendix C Indexes") == "Appendix C Indexes"
    assert normalize_title("Chapter 1 General Information") == "General Information"
    assert normalize_title("第 3 章 事务") == "事务"


# ═══════════════════════════════════════════════════════════════════════
# DocDraft 校验（契约 §4 的"必须切出层次 / span 可回溯"）
# ═══════════════════════════════════════════════════════════════════════
def test_draft_validate_rejects_bad_input() -> None:
    with pytest.raises(ModelError, match="没有任何 unit"):
        DocDraft(title="t", kind="text").validate()

    dup = DocDraft(
        title="t", kind="text",
        units=[
            UnitDraft(ord=1, title="a", level=1, span=Span("char", 0, 5), text="x"),
            UnitDraft(ord=1, title="b", level=1, span=Span("char", 6, 9), text="y"),
        ],
    )
    with pytest.raises(ModelError, match="ord 重复"):
        dup.validate()

    dangling = DocDraft(
        title="t", kind="text",
        units=[UnitDraft(ord=1, title="a", level=2, span=Span("char", 0, 5), text="x",
                         parent_ord=99)],
    )
    with pytest.raises(ModelError, match="悬空 parent_ord"):
        dangling.validate()

    selfref = DocDraft(
        title="t", kind="text",
        units=[UnitDraft(ord=1, title="a", level=1, span=Span("char", 0, 5), text="x",
                         parent_ord=1)],
    )
    with pytest.raises(ModelError, match="指向自己"):
        selfref.validate()

    cycle = DocDraft(
        title="t", kind="text",
        units=[
            UnitDraft(ord=1, title="a", level=2, span=Span("char", 0, 5), text="x", parent_ord=2),
            UnitDraft(ord=2, title="b", level=2, span=Span("char", 6, 9), text="y", parent_ord=1),
        ],
    )
    with pytest.raises(ModelError, match="成环"):
        cycle.validate()


def test_span_and_level_guards() -> None:
    with pytest.raises(SpanViolation):
        Span("page", 5, 4)
    with pytest.raises(ModelError):
        Span("page", -1, 4)
    with pytest.raises(ModelError):
        UnitDraft(ord=1, title="x", level=0, span=Span("page", 1, 1), text="")
    with pytest.raises(ModelError):
        UnitDraft(ord=-1, title="x", level=1, span=Span("page", 1, 1), text="")
    # 单点 span 合法（卡片定位到某一页）
    assert Span("page", 7, 7).size == 1


def test_draft_to_units_maps_parent_ord_to_id() -> None:
    draft = DocDraft(
        title="t", kind="text",
        units=[
            UnitDraft(ord=10, title="父", level=1, span=Span("char", 0, 9), text="a" * 10),
            UnitDraft(ord=20, title="子", level=2, span=Span("char", 10, 19), text="b" * 10,
                      parent_ord=10),
        ],
    )
    ids = iter(["unt_aaaaaaaaaaaa", "unt_bbbbbbbbbbbb"])
    units = draft_to_units(draft, "doc_cccccccccccc", id_factory=lambda: next(ids))
    assert [u.id for u in units] == ["unt_aaaaaaaaaaaa", "unt_bbbbbbbbbbbb"]
    assert units[0].parent_id is None
    assert units[1].parent_id == "unt_aaaaaaaaaaaa"  # ord → id 的映射发生在这一步
    assert units[0].text_len == 10 and units[0].doc_id == "doc_cccccccccccc"


def test_all_adapters_declare_contract_fields() -> None:
    """契约 §4：kind 必须在文档 kind 枚举内、extensions 必须是小写含点。"""
    from worker.models.document import DOC_KINDS

    for cls in registry.ADAPTERS:
        a = cls()
        assert a.kind in DOC_KINDS, f"{cls.__name__}.kind={a.kind!r} 不在契约枚举内"
        assert a.extensions, f"{cls.__name__} 必须声明 extensions"
        assert all(e == e.lower() and e.startswith(".") for e in a.extensions)
        # can_handle 不得抛异常
        assert a.can_handle("nonexistent.file") in (True, False)


def test_probe_returns_concrete_numbers(pdf_file: Path, pptx_file: Path) -> None:
    assert registry.pick(str(pdf_file)).probe(str(pdf_file)) == {"pages": 12, "toc_entries": 8}
    assert registry.pick(str(pptx_file)).probe(str(pptx_file)) == {"slides": 4}


def test_json_serialisable_draft(pdf_file: Path) -> None:
    draft = PdfAdapter().parse(str(pdf_file))
    payload = json.loads(json.dumps(draft.to_dict(), ensure_ascii=False))
    assert payload["units"][1]["parent_ord"] == 1
    assert payload["units"][1]["span"] == {"kind": "page", "start": 1, "end": 4}