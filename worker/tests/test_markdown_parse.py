"""Markdown 结构解析测试（`worker/adapters/text.py`）。

★ 锁死两个**实测 bug**：
1. **代码围栏内的 `#` 注释被误判成标题** → 假层级 + 打乱父子树（见 test_code_fence_*）
2. `.md` 走的是 `kind='text'`（`EXT_TO_KIND`），但 Markdown 的结构比纯文本强 ——
   这里断言它**真的**按 `#` 数映射 level，而不是退化成通用划分。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from worker.adapters.text import TextAdapter


def _write_md(tmp_path: Path, content: str) -> Path:
    p = tmp_path / "doc.md"
    p.write_text(content, encoding="utf-8")
    return p


# ═══════════════════════════════════════════════════════════════════════
# 基础：`#` 数 → level
# ═══════════════════════════════════════════════════════════════════════


def test_markdown_hash_count_maps_to_level(tmp_path: Path) -> None:
    """`#`/`##`/`###` 直接映射成 level 1/2/3，且父子关系正确。"""
    p = _write_md(
        tmp_path,
        "\n".join(
            [
                "# 数据库索引",
                "",
                "总述。",
                "",
                "## 聚簇索引",
                "",
                "数据按主键顺序存放。",
                "",
                "### 回表",
                "",
                "二级索引要回表。",
                "",
                "## 二级索引",
                "",
                "需要回表。",
            ]
        ),
    )
    d = TextAdapter().parse(str(p))
    assert d.meta["mode"] == "headings"
    assert len(d.units) == 4
    assert [u.level for u in d.units] == [1, 2, 3, 2]
    assert [u.title for u in d.units] == ["数据库索引", "聚簇索引", "回表", "二级索引"]
    # 父子：聚簇索引(2) → 数据库索引(1)；回表(3) → 聚簇索引(2)；二级索引(2) → 数据库索引(1)
    assert [u.parent_ord for u in d.units] == [None, 1, 2, 1]


# ═══════════════════════════════════════════════════════════════════════
# ★ 回归：代码围栏（实测 bug）
# ═══════════════════════════════════════════════════════════════════════


def test_code_fence_hash_comments_are_not_headings(tmp_path: Path) -> None:
    """★★ 回归：```sql 块内的 `# 注释` **不得**变成标题。

    `[实测]` 修复前：同一份 Markdown 产出 **6 个单元**（应为 3 个），且
    `## 聚簇索引` 被挂到假标题 `也不是标题` 之下（parent=3）。
    """
    p = _write_md(
        tmp_path,
        "\n".join(
            [
                "# 数据库索引",
                "",
                "索引把随机 IO 变成顺序 IO。下面是建索引的 SQL：",
                "",
                "```sql",
                "-- # 这是一条注释，不是标题",
                "CREATE INDEX idx_a ON t(a);",
                "# 也不是标题",
                "```",
                "",
                "## 聚簇索引",
                "",
                "```python",
                "# 注释：也不是标题",
                "x = 1",
                "```",
                "",
                "## 二级索引",
                "",
                "二级索引需要回表。",
            ]
        ),
    )
    d = TextAdapter().parse(str(p))

    titles = [u.title for u in d.units]
    # 只应有 3 个标题（三个真实标题）
    assert len(d.units) == 3, f"代码块内的 # 被当成了标题：{titles}"
    assert titles == ["数据库索引", "聚簇索引", "二级索引"]
    # ★ 关键：假标题消失后，父子树恢复正确
    assert [u.parent_ord for u in d.units] == [None, 1, 1]
    # 围栏行本身也不能变成标题
    assert not any("```" in t for t in titles)
    # 代码块内容仍应出现在**正文**里（不能因为跳标题就丢内容）
    assert "CREATE INDEX idx_a ON t(a);" in d.units[0].text


def test_tilde_fence_also_respected(tmp_path: Path) -> None:
    """~~~ 围栏同样必须被识别（CommonMark 两种围栏）。"""
    p = _write_md(
        tmp_path,
        "\n".join(["# 标题A", "", "~~~", "# 不是标题", "~~~", "", "## 标题B"]),
    )
    d = TextAdapter().parse(str(p))
    assert [u.title for u in d.units] == ["标题A", "标题B"]
    assert [u.level for u in d.units] == [1, 2]


def test_fence_with_language_and_longer_closing_fence(tmp_path: Path) -> None:
    """带语言后缀的围栏 + 更长的关闭围栏（```` 关 ```）都要正确。"""
    p = _write_md(
        tmp_path,
        "\n".join(['# 标题A', "", "```bash", "# 注释1", "````", "", "## 标题B"]),
    )
    d = TextAdapter().parse(str(p))
    # ```` 关闭了 ``` 围栏 → 标题B 应被识别
    assert [u.title for u in d.units] == ["标题A", "标题B"]


def test_short_fence_does_not_close_long_fence(tmp_path: Path) -> None:
    """⚠️ 反例：```` 开的围栏**不能**被 ``` 关闭（CommonMark 要求不短于开启者）。

    若实现写错（只要遇到 ``` 就翻转），`# 假标题` 会被漏进标题列表。
    """
    p = _write_md(
        tmp_path,
        "\n".join(["# 标题A", "", "````", "# 假标题", "```", "# 还是假标题", "````", "", "## 标题B"]),
    )
    d = TextAdapter().parse(str(p))
    assert [u.title for u in d.units] == ["标题A", "标题B"]


def test_fence_only_file_falls_back_to_windows(tmp_path: Path) -> None:
    """整篇都是代码块（没有标题）→ 退回窗口切分，**不产出假标题**。"""
    body = "\n".join(["```python"] + ["# 注释行 " + str(i) for i in range(60)] + ["```"])
    p = _write_md(tmp_path, body)
    d = TextAdapter().parse(str(p))
    assert d.meta["mode"] == "windows", "没有真标题时应退回窗口切分"
    assert len(d.units) >= 1


def test_unclosed_fence_swallows_rest(tmp_path: Path) -> None:
    """未闭合的围栏：其后内容都算代码块（**不产出假标题**）—— 如实行为。"""
    p = _write_md(tmp_path, "\n".join(["# 标题A", "", "```", "# 此行在未闭合围栏内", "## 也是"]))
    d = TextAdapter().parse(str(p))
    assert [u.title for u in d.units] == ["标题A"]
    assert d.meta["mode"] == "headings"


def test_numbered_heading_still_works_outside_fence(tmp_path: Path) -> None:
    """围栏修复**不得**破坏原有编号标题识别（1.2 xxx）。"""
    p = _write_md(
        tmp_path,
        "\n".join(["1 关系模型", "", "正文。", "", "1.1 键与约束", "", "主键唯一。", "", "```", "1.2 在代码块内不算", "```"]),
    )
    d = TextAdapter().parse(str(p))
    titles = [u.title for u in d.units]
    assert "关系模型" in titles[0] or titles[0] == "1 关系模型"
    assert any("键与约束" in t for t in titles)
    assert not any("在代码块内" in t for t in titles)


# ═══════════════════════════════════════════════════════════════════════
# ★ 回归：CJK 行被 `.isupper()` 误判成"全大写标题"（实测 bug）
# ═══════════════════════════════════════════════════════════════════════


def test_chinese_prose_with_acronyms_is_not_a_heading(tmp_path: Path) -> None:
    """★★ 回归：含中文 + 英文缩写的**正文**不得被当成"全大写标题"。

    `[实测]` 根因：`str.isupper()` 对无大小写的字符（中文）返回 True，
    所以 `'索引把随机 IO 变成顺序 IO。下面是建索引的 SQL：'.isupper()` → **True**
    （整行只有 `IO`/`SQL` 有大小写且都大写）。

    修复前该行会变成一个 lvl=1 的假标题并打乱父子树。
    """
    p = _write_md(
        tmp_path,
        "\n".join(
            [
                "# 数据库索引",
                "",
                "索引把随机 IO 变成顺序 IO。下面是建索引的 SQL：",
                "",
                "```sql",
                "CREATE INDEX idx_a ON t(a);",
                "```",
                "",
                "## 聚簇索引",
                "",
                "正文。",
            ]
        ),
    )
    d = TextAdapter().parse(str(p))
    titles = [u.title for u in d.units]
    assert titles == ["数据库索引", "聚簇索引"], f"中文正文被误判成标题：{titles}"
    assert [u.parent_ord for u in d.units] == [None, 1]
    # 那段正文必须**留在**上一个标题的正文里（不能因为不认标题就丢）
    assert "随机 IO 变成顺序 IO" in d.units[0].text


def test_fullwidth_colon_terminated_chinese_line_is_not_heading(tmp_path: Path) -> None:
    """★★ 回归：以**全角冒号 `：`** 结尾的中文行不得成为标题。

    `[实测]` 原错误写法：尾字符排除表只有半角 `":"`，漏了全角 `"："`。
    """
    p = _write_md(
        tmp_path,
        "\n".join(["# 标题", "", "注意下面几点：", "", "## 小节", "", "内容。"]),
    )
    d = TextAdapter().parse(str(p))
    assert [u.title for u in d.units] == ["标题", "小节"]


def test_english_all_caps_heading_still_recognised(tmp_path: Path) -> None:
    """⚠️ 反例：**纯英文**全大写短行**仍然**要当标题（修复不得矫枉过正）。"""
    p = _write_md(tmp_path, "\n".join(["DATABASE SYSTEMS", "", "body text here.", "", "NEXT TOPIC", "", "more."]))
    d = TextAdapter().parse(str(p))
    titles = [u.title for u in d.units]
    assert "DATABASE SYSTEMS" in titles
    assert "NEXT TOPIC" in titles

