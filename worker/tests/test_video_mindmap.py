"""S6 思维导图的测试（markmap 清洗 + 可折叠树）。"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from worker.models.video import TranscriptChapter  # noqa: E402
from worker.video import mindmap as M  # noqa: E402

SAMPLE = """```markdown
# 数据库索引
## 索引原理
### 为什么需要索引
- 减少磁盘 IO
- 避免全表扫描
## B+ 树
- 叶子节点存数据
- 非叶节点只存键
```

| 表格 | 应该被剥掉 |
|---|---|
| a | b |

> 引用也要剥掉
"""


def test_schema_is_strict() -> None:
    assert M.MINDMAP_SCHEMA["additionalProperties"] is False
    assert M.MINDMAP_SCHEMA["required"] == ["markdown"]


def test_normalize_strips_fences_tables_quotes() -> None:
    out = M.normalize_markmap(SAMPLE)
    assert out.startswith("# 数据库索引\n")
    assert "```" not in out
    assert "|" not in out, "表格必须剥掉（markmap 里是噪声）"
    assert ">" not in out
    assert out.splitlines() == [
        "# 数据库索引",
        "## 索引原理",
        "### 为什么需要索引",
        "- 减少磁盘 IO",
        "- 避免全表扫描",
        "## B+ 树",
        "- 叶子节点存数据",
        "- 非叶节点只存键",
    ]


def test_normalize_is_idempotent() -> None:
    once = M.normalize_markmap(SAMPLE)
    twice = M.normalize_markmap(once)
    assert once == twice


def test_normalize_adds_root_when_missing() -> None:
    out = M.normalize_markmap("## 只有二级标题\n- 叶子")
    assert out.splitlines()[0] == "# 课程思维导图"
    assert "## 只有二级标题" in out


def test_normalize_collapses_multiple_roots() -> None:
    out = M.normalize_markmap("# 根一\n## A\n- a\n# 根二\n## B\n- b")
    assert out.count("\n# ") == 0, "只能有一个一级根"
    assert out.startswith("# 根一")
    assert "# 根二" not in out.splitlines(), "多余根被降级/丢弃"


def test_normalize_limits_depth() -> None:
    deep = "# 根\n" + "\n".join(f"{'#' * (i + 2)} 层级{i + 2}" for i in range(5)) + "\n"
    out = M.normalize_markmap(deep, max_depth=4)
    assert max(len(ln.split(" ")[0]) for ln in out.splitlines() if ln.startswith("#")) == 4
    assert "######" not in out


def test_normalize_removes_inline_markup_and_dup_siblings() -> None:
    out = M.normalize_markmap("# 根\n- **加粗**内容\n- **加粗**内容\n- `代码`项")
    assert out.splitlines() == ["# 根", "- 加粗内容", "- 代码项"]


def test_normalize_empty_input() -> None:
    assert M.normalize_markmap("") == ""
    assert M.normalize_markmap("   \n\n") == ""


def test_normalize_dedents_flat_bullets() -> None:
    out = M.normalize_markmap("根标题\n- 第一\n- 第二")
    assert out.splitlines() == ["# 根标题", "- 第一", "- 第二"]


# ── 可折叠树 ────────────────────────────────────────────────────────────
def test_to_tree_exact_structure() -> None:
    tree = M.to_tree(M.normalize_markmap(SAMPLE))
    assert tree["title"] == "数据库索引"
    assert tree["depth"] == 1
    assert [c["title"] for c in tree["children"]] == ["索引原理", "B+ 树"]
    principle = tree["children"][0]
    assert [c["title"] for c in principle["children"]] == ["为什么需要索引"]
    leaves = principle["children"][0]["children"]
    assert [c["title"] for c in leaves] == ["减少磁盘 IO", "避免全表扫描"]
    assert all(c["children"] == [] for c in leaves)
    assert M.node_count(tree) == 8


def test_to_tree_handles_empty() -> None:
    tree = M.to_tree("")
    assert tree == {"title": "课程思维导图", "depth": 1, "children": []}


def test_to_tree_depths_are_renumbered_from_one() -> None:
    tree = M.to_tree("# 根\n## 二\n### 三\n- 叶")
    assert tree["depth"] == 1
    assert tree["children"][0]["depth"] == 2
    assert tree["children"][0]["children"][0]["depth"] == 3
    assert tree["children"][0]["children"][0]["children"][0]["depth"] == 4


# ── 无 LLM 的兜底 ───────────────────────────────────────────────────────
def test_from_chapters_structural_fallback() -> None:
    chapters = [
        TranscriptChapter("第一章 索引原理", 0, 480_000, "正文", "讲索引的作用"),
        TranscriptChapter("第二章 B+树", 480_000, 900_000, "正文", "讲结构与分裂"),
    ]
    out = M.from_chapters(chapters, root="数据库索引")
    lines = out.splitlines()
    assert lines[0] == "# 数据库索引"
    assert "## 第一章 索引原理" in lines
    assert "- 讲索引的作用" in lines
    assert "- 时间 00:00–08:00" in lines
    assert "- 时间 08:00–15:00" in lines
    tree = M.to_tree(out)
    assert [c["title"] for c in tree["children"]] == ["第一章 索引原理", "第二章 B+树"]


def test_from_chapters_without_summary_still_works() -> None:
    out = M.from_chapters([TranscriptChapter("只有标题", 0, 1_000)], root="根")
    assert out.splitlines() == ["# 根", "## 只有标题", "- 时间 00:00–00:01"]


def test_from_chapters_empty() -> None:
    assert M.from_chapters([]) == ""


def test_build_prompt_mentions_constraints() -> None:
    prompt = M.build_mindmap_prompt(
        [TranscriptChapter("第一章", 0, 1_000, "", "摘要文本")],
        summary="全局摘要",
        video_title="索引课",
    )
    assert "索引课" in prompt
    assert "全局摘要" in prompt
    assert "第一章" in prompt
    assert "摘要文本" in prompt
    assert "markmap" in prompt
    assert "不要编造" in prompt
