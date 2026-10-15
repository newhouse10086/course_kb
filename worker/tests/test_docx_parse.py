"""DOCX 适配器测试（`worker/adapters/docx.py`）。

★ 用**真 .docx**（python-docx 生成，真实 OOXML），不是 mock。

重点验证三件 lead 点名的事：
1. **标题层级**：`Heading N` → level（`doc.paragraphs` 拿不到的东西）
2. **表格结构是否被丢** —— 这是 lead 的原始疑问（"python-docx 只给段落"）
3. **表格与段落的内容顺序**（顺序错了，正文语义会错位到文末）
"""

from __future__ import annotations

from pathlib import Path

import pytest

from worker.adapters.docx import DocxAdapter


def _make_docx(tmp_path: Path, name: str = "lecture.docx") -> Path:
    docx = pytest.importorskip("docx")

    doc = docx.Document()
    doc.add_heading("数据库课程讲义", level=1)
    doc.add_paragraph("课程简介：本课程讲关系模型、SQL 与索引。")
    doc.add_heading("1 关系模型", level=2)
    doc.add_paragraph("关系模型用二维表表示数据。")
    # ★ 表格：插在"1 关系模型"之后、"1.1"之前 —— 顺序错了能测出来
    table = doc.add_table(rows=3, cols=3)
    table.cell(0, 0).text = "字段"
    table.cell(0, 1).text = "类型"
    table.cell(0, 2).text = "含义"
    table.cell(1, 0).text = "id"
    table.cell(1, 1).text = "INT"
    table.cell(1, 2).text = "主键"
    table.cell(2, 0).text = "name"
    table.cell(2, 1).text = "VARCHAR"
    table.cell(2, 2).text = "姓名"
    doc.add_heading("1.1 键与约束", level=3)
    doc.add_paragraph("主键唯一标识一行。")
    doc.add_heading("2 SQL 基础", level=2)
    doc.add_paragraph("SELECT 是最常用的语句。")
    p = tmp_path / name
    doc.save(str(p))
    return p


# ═══════════════════════════════════════════════════════════════════════
# 标题层级
# ═══════════════════════════════════════════════════════════════════════


def test_docx_heading_levels_and_tree(tmp_path: Path) -> None:
    """`Heading 1/2/3` → level 1/2/3，父子关系正确。"""
    p = _make_docx(tmp_path)
    d = DocxAdapter().parse(str(p))

    assert d.meta["mode"] == "headings"
    titles = [u.title for u in d.units]
    # 注意：docx 的 heading 文本是 "1 关系模型"（编号在标题里），不做剥号
    assert titles[0] == "数据库课程讲义"
    assert any(t.endswith("关系模型") for t in titles)
    assert any(t.endswith("键与约束") for t in titles)
    assert any(t.endswith("SQL 基础") for t in titles)
    assert [u.level for u in d.units] == [1, 2, 3, 2]
    # 父子：1 关系模型 → 讲义；1.1 → 1 关系模型；2 SQL → 讲义
    assert [u.parent_ord for u in d.units] == [None, 1, 2, 1]


# ═══════════════════════════════════════════════════════════════════════
# ★ 表格（lead 的原始疑问）
# ═══════════════════════════════════════════════════════════════════════


def test_window_boundary_does_not_split_words_or_numbers(tmp_path: Path) -> None:
    """★★ 回归：窗口边界**不得从词/数字中间切开**（实测会静默损坏正文）。

    `[实测]` 原错误写法（`text.py::fixed_windows`）：
    ```python
    nl = snap_newline.find("\\n", end)       # 只**向后**找换行
    if nl != -1 and nl - end < size // 3:
        end = nl
    ```
    当 `end` 落在一段中间、而其后很久才有换行时 → 不吸附 → **从词中间切**。
    实测：2000 字符窗口把 `第 60 段` 切成 `第 6` + `0 段`，两个单元各拿半截数字。

    修法：向后找不到"足够近"的换行时**退而向前**找，让窗口稍短而非切坏词。
    """
    docx = pytest.importorskip("docx")
    doc = docx.Document()
    for i in range(60):
        doc.add_paragraph(f"第 {i + 1} 段：数据库课程讲义正文内容，用于验证编号不被误判成标题。")
    p = tmp_path / "windows.docx"
    doc.save(str(p))

    d = DocxAdapter().parse(str(p))
    assert d.meta["mode"] == "windows"
    assert len(d.units) >= 2
    # ★ 每个窗口都必须从"段落开头"开始（即前一个窗口在换行处结束）
    for u in d.units:
        assert u.text.startswith("第 "), f"窗口从词中间切开了：{u.text[:20]!r}"
    # 全文所有段落完整（60 段都在，没有被切坏）
    all_text = "\n".join(u.text for u in d.units)
    for i in (1, 30, 60):
        assert f"第 {i} 段：" in all_text, f"第 {i} 段 被切坏了"


def test_docx_numbered_prose_is_not_a_heading(tmp_path: Path) -> None:
    """★★ 回归：以"第 N 段…。"开头的**普通段落**不得被判成标题。

    `[实测]` 原错误写法（`docx.py::_heading_level` 的编号兜底）：
    ```python
    if text and len(text) <= 90:
        return level_from_numbering(text)      # ← 没有标点护栏
    ```
    后果：一份 60 段的纯文字 Word 被判成 `mode='headings'`、产出 **60 个假单元**
    （本该走 `windows` 窗口切分）。

    ★ 这条与 `text.py` 的"全角冒号"bug 是**同一形状**：
    编号识别逻辑在 `text.py` 有护栏、在 `docx.py` 没有 →
    **看起来两条路都有编号识别，实际只有一条有护栏**。
    修法是让两处**共用** `is_title_like()`，一处实现不会漂移。
    """
    docx = pytest.importorskip("docx")
    doc = docx.Document()
    for i in range(60):
        # 每段都以"第 N 段："开头、以句号结尾 —— 是正文，不是标题
        doc.add_paragraph(f"第 {i + 1} 段：数据库课程讲义正文内容，用于验证编号不被误判成标题。")
    p = tmp_path / "numbered_prose.docx"
    doc.save(str(p))

    d = DocxAdapter().parse(str(p))
    assert d.meta["mode"] == "windows", "编号正文被误判成标题（会产出几十个假单元）"
    # windows 模式应切成少数几个窗口（而非每段一个单元）
    assert len(d.units) >= 2
    assert len(d.units) < 20, f"窗口切分不该产出那么多单元：{len(d.units)}"
    # ★ 关键：不该是"每段一个单元"的 headings 模式（60 段 → 60 个单元）
    assert len(d.units) != 60
    # 所有正文内容都还在（没丢段、没被切坏）
    all_text = "\n".join(u.text for u in d.units)
    for i in (1, 30, 60):
        assert f"第 {i} 段：" in all_text, f"第 {i} 段 被切坏了"


def test_docx_real_heading_without_style_is_still_detected(tmp_path: Path) -> None:
    """⚠️ 反例：**真的编号标题**（`7.4.2 xxx`，无 Heading 样式）仍必须被识别。

    修复不得矫枉过正 —— 只排除"以句末标点结尾"的句子，编号标题没有句末标点。
    """
    docx = pytest.importorskip("docx")
    doc = docx.Document()
    doc.add_paragraph("7.4.2 索引优化")
    doc.add_paragraph("这一节讲索引的选择性与覆盖索引的使用。")
    doc.add_paragraph("7.4.3 事务隔离")
    doc.add_paragraph("这一节讲隔离级别与并发异常。")
    p = tmp_path / "numbered_headings.docx"
    doc.save(str(p))

    d = DocxAdapter().parse(str(p))
    assert d.meta["mode"] == "headings"
    titles = [u.title for u in d.units]
    assert "7.4.2 索引优化" in titles
    assert "7.4.3 事务隔离" in titles


def test_docx_table_content_is_not_lost(tmp_path: Path) -> None:
    """★★ 表格内容**必须进入正文**（不能被丢）。

    lead 的疑问："python-docx 只给段落，丢标题层级/表格结构"。
    实测结论：**表格没丢** —— adapter 按 `body` 的 XML 子元素顺序遍历
    （`w:p` / `w:tbl` 交替），把表格转成 `a | b | c` 行。
    """
    p = _make_docx(tmp_path)
    d = DocxAdapter().parse(str(p))

    all_text = "\n".join(u.text for u in d.units)
    # 表头与单元格都在
    for cell in ("字段", "类型", "含义", "id", "INT", "主键", "name", "VARCHAR", "姓名"):
        assert cell in all_text, f"表格单元格 {cell!r} 丢了"
    # 用 ` | ` 连接，保留行列结构（不是把单元格粘成一坨）
    assert "字段 | 类型 | 含义" in all_text
    assert "id | INT | 主键" in all_text


def test_docx_table_appears_in_correct_section(tmp_path: Path) -> None:
    """★★ 表格必须落在**它所在的那个小节**里，不能错位到文末。

    `docx.py` docstring 记录的坑：
    > ⚠️ 顺序陷阱：`doc.paragraphs` 只给段落，**表格不在其中**。
    > 若先遍历段落再遍历表格，表格内容会全部错位到文末。

    本用例锁死"按 XML 顺序"这个行为：表格插在 `1 关系模型` 与 `1.1 键与约束` 之间，
    所以它应出现在 `1 关系模型` 的正文里，**不在** `2 SQL 基础` 里。
    """
    p = _make_docx(tmp_path)
    d = DocxAdapter().parse(str(p))

    rel = next(u for u in d.units if u.title.endswith("关系模型"))
    sql = next(u for u in d.units if u.title.endswith("SQL 基础"))
    assert "字段 | 类型 | 含义" in rel.text, "表格应属于它前面的小节"
    assert "字段 | 类型 | 含义" not in sql.text, "表格不该错位到别的小节"


def test_docx_table_rows_are_joined_with_pipe(tmp_path: Path) -> None:
    """单元格用 ` | ` 连接、行用换行分隔 —— 保留可读的行列结构。"""
    p = _make_docx(tmp_path)
    d = DocxAdapter().parse(str(p))
    rel = next(u for u in d.units if u.title.endswith("关系模型"))
    lines = [ln for ln in rel.text.split("\n") if "|" in ln]
    assert len(lines) == 3, f"应有 3 行表格，实际 {len(lines)}：{lines}"
    assert lines[0] == "字段 | 类型 | 含义"


def test_docx_meta_reports_table_count(tmp_path: Path) -> None:
    """`meta.tables` 如实报表格数（供上游统计/诊断）。"""
    p = _make_docx(tmp_path)
    d = DocxAdapter().parse(str(p))
    assert d.meta["tables"] == 1


# ═══════════════════════════════════════════════════════════════════════
# 纯图片 / 无标题
# ═══════════════════════════════════════════════════════════════════════


def test_docx_without_headings_falls_back_to_windows(tmp_path: Path) -> None:
    """无 `Heading N` 样式 → 退回字符窗口（**不把整篇当一个 unit**）。"""
    docx = pytest.importorskip("docx")
    doc = docx.Document()
    for i in range(60):
        doc.add_paragraph(f"第 {i + 1} 段：数据库课程讲义正文内容，用于验证无标题时的窗口切分。")
    p = tmp_path / "plain.docx"
    doc.save(str(p))

    d = DocxAdapter().parse(str(p))
    assert d.meta["mode"] == "windows"
    assert len(d.units) >= 2, "应切成多个窗口，而不是 1 个大 unit"
    assert d.text_chars > 1000


def test_docx_empty_document_raises_parse_error(tmp_path: Path) -> None:
    """空文档 → **如实抛 ParseError**（不是静默产出 0 个 unit）。"""
    docx = pytest.importorskip("docx")
    from worker.adapters.base import ParseError

    doc = docx.Document()
    p = tmp_path / "empty.docx"
    doc.save(str(p))
    with pytest.raises(ParseError):
        DocxAdapter().parse(str(p))


def test_docx_can_handle_only_docx(tmp_path: Path) -> None:
    """`can_handle` 只认 .docx（不该抢走 .pdf/.md）。"""
    a = DocxAdapter()
    assert a.can_handle("x.docx") is True
    assert a.can_handle("x.DOCX") is True
    assert a.can_handle("x.pdf") is False
    assert a.can_handle("x.md") is False
