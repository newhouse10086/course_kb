"""S6 思维导图：LLM → Markdown 大纲（markmap 兼容）+ 可折叠树。

## 格式约定

markmap 直接吃 Markdown：

```markdown
# 索引原理
## B+ 树
### 结构
- 只有叶子节点存数据
- 非叶节点只存键
```

* 只允许 **H1~H4 标题** 与 **无序列表项**（``- ``），**不出现表格/代码块/图片**
  —— 这些在 markmap 里渲染成噪声。
* 有且只有一个 ``# `` 根节点。
* ``______`` 分隔线、``> `` 引用、``**加粗**`` 全部剥掉。

:func:`to_tree` 把同一份 markdown 转成嵌套 JSON，
**前端不用引 markmap 也能渲染成可折叠树**（原生虚拟滚动那一节同理，避免构建链）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from worker.models.video import TranscriptChapter

#: markmap 格式标识（契约 §2.7 ``mindmap.format``）
MINDMAP_FORMAT = "markmap"
#: 最大层级（H1 根 + H2/H3/H4）
MAX_DEPTH = 4

MINDMAP_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": ["markdown"],
    "properties": {
        "markdown": {
            "type": "string",
            "description": "markmap 兼容的 Markdown 大纲：单 # 根节点，##/###/#### 作分支，- 作叶子",
        }
    },
}

_FENCE_LINE_RE = re.compile(r"^[ \t]*```[^\n]*$", re.MULTILINE)
_HEADING_RE = re.compile(r"^(#{1,6})\s*(.*)$")
_BULLET_RE = re.compile(r"^(\s*)([-*+]|\d+\.)\s+(.*)$")


def build_mindmap_prompt(
    chapters: list[TranscriptChapter],
    *,
    summary: str = "",
    video_title: str = "",
    max_depth: int = MAX_DEPTH,
) -> str:
    """构造思维导图提示词（喂**分章结构 + 章节摘要**，不喂全文，省 token 且更聚焦）。"""
    outline = []
    for ch in chapters:
        outline.append(f"### {ch.title}")
        if ch.summary:
            outline.append(f"  摘要：{ch.summary}")
    return (
        f"下面是网课《{video_title or '未命名'}》的分章大纲"
        f"（全局摘要：{summary or '(无)'}）。\n\n"
        + "\n".join(outline)
        + "\n\n## 任务\n"
        "生成一份 **markmap 兼容的 Markdown 思维导图**：\n"
        f"1. 只用一个 ``# `` 作根节点（课程主题）；分支用 ``##`` / ``###`` / ``####``，最深 {max_depth} 层。\n"
        "2. 叶子用无序列表 ``- ``，每条 ≤ 20 字，是**知识点**而不是整句复述。\n"
        "3. 只用上面提到过的内容，**不要编造**新的知识点或术语。\n"
        "4. 不要表格、代码块、图片、引用、加粗。\n"
        '只输出 JSON：{"markdown": "..."}'
    )


def normalize_markmap(text: str, *, max_depth: int = MAX_DEPTH) -> str:
    """把模型输出洗成**干净的 markmap markdown**（幂等：再洗一次结果不变）。

    处理：剥代码围栏 → 剥行内标记 → 只留标题/列表 → 限制层级 → 合并重复兄弟 → 单根。
    """
    if not text or not text.strip():
        return ""
    # 只剥**围栏行本身**（```markdown / ```），不能连围栏里的内容一起删。
    # 错误写法（曾用）：re.DOTALL 的 r"^\s*```.*?^\s*```\s*$" → 把整个大纲删空，
    # 结果是 normalize 返回 ""，导图直接消失（看着像模型没输出）。
    body = _FENCE_LINE_RE.sub("", text)
    lines: list[str] = []
    for raw_line in body.splitlines():
        line = raw_line.rstrip()
        if not line.strip():
            continue
        stripped = line.strip()
        if stripped.startswith(("|", ">", "!", "---", "***", "===")):
            continue  # 表格/引用/图片/分隔线：markmap 里是噪声
        line = re.sub(r"\*\*(.+?)\*\*", r"\1", line)
        line = re.sub(r"`(.+?)`", r"\1", line)
        line = re.sub(r"^\s*[-*_]{3,}\s*$", "", line)
        if not line.strip():
            continue
        hm = _HEADING_RE.match(line.strip())
        if hm:
            depth = min(len(hm.group(1)), max_depth)
            title = hm.group(2).strip()
            if not title:
                continue
            lines.append("#" * depth + " " + title)
            continue
        bm = _BULLET_RE.match(line)
        if bm:
            indent = len(bm.group(1).replace("\t", "  ")) // 2
            title = bm.group(3).strip()
            if not title:
                continue
            level = min(max_depth, 2 + min(indent, max_depth - 2))
            lines.append("  " * min(indent, max_depth - 2) + "- " + title)
            continue
        # 裸文本：当根标题（只有第一条有意义，其余忽略，避免模型把正文塞进来）
        if not lines:
            lines.append("# " + line.strip())
    if not lines:
        return ""
    # 保证只有一个 H1 根，且在最前
    roots = [i for i, ln in enumerate(lines) if ln.startswith("# ")]
    if not roots:
        lines.insert(0, "# 课程思维导图")
    elif roots[0] != 0 or len(roots) > 1:
        first = lines[roots[0]]
        lines = [ln for i, ln in enumerate(lines) if i not in roots[1:]]
        lines.remove(first)
        lines.insert(0, first)
    return "\n".join(_dedupe_siblings(lines)) + "\n"


def _dedupe_siblings(lines: list[str]) -> list[str]:
    """同一父节点下重复的同级条目只留一条（模型常见复读）。"""
    out: list[str] = []
    for ln in lines:
        if out and out[-1].strip() == ln.strip():
            continue
        out.append(ln)
    return out


def from_chapters(
    chapters: list[TranscriptChapter], *, summary: str = "", root: str = "课程思维导图"
) -> str:
    """**不用 LLM 的兜底大纲**：章节 → 两级 markmap。

    只搬真实存在的信息（章标题 / 章摘要 / 章节时间），
    **不编造知识点**；``source`` 会标记成 ``structural``。
    """
    if not chapters:
        return ""
    lines = [f"# {root}"]
    for ch in chapters:
        lines.append(f"## {ch.title}")
        if ch.summary:
            lines.append(f"- {ch.summary}")
        lines.append(f"- 时间 {_fmt(ch.start)}–{_fmt(ch.end)}")
    return normalize_markmap("\n".join(lines))


def _fmt(ms: int) -> str:
    s = int(ms) // 1000
    return f"{s // 60:02d}:{s % 60:02d}"


@dataclass
class MindNode:
    """可折叠树的节点（前端直接渲染，无需 markmap 依赖）。"""

    title: str
    depth: int
    children: list["MindNode"] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "depth": self.depth,
            "children": [c.to_dict() for c in self.children],
        }


def to_tree(markdown: str) -> dict:
    """markdown 大纲 → 嵌套树 JSON（``{"title","depth","children"}``）。

    标题按层级嵌套；列表项挂到**最近的标题**下（同级列表项共享父节点）。
    """
    root = MindNode(title="", depth=0)
    stack: list[MindNode] = [root]
    for raw in markdown.splitlines():
        if not raw.strip():
            continue
        hm = _HEADING_RE.match(raw.strip())
        if hm:
            depth = len(hm.group(1))
            title = hm.group(2).strip()
            if not title:
                continue
            node = MindNode(title=title, depth=depth)
            while stack and stack[-1].depth >= depth:
                stack.pop()
            (stack[-1] if stack else root).children.append(node)
            stack.append(node)
            continue
        bm = _BULLET_RE.match(raw)
        if bm:
            title = bm.group(3).strip()
            if not title:
                continue
            indent = len(bm.group(1).replace("\t", "  ")) // 2
            depth = (stack[-1].depth if stack else 1) + 1 + indent
            node = MindNode(title=title, depth=depth)
            parent = stack[-1] if stack else root
            parent.children.append(node)
    kids = [c for c in root.children if c.title]
    if not kids:
        return {"title": "课程思维导图", "depth": 1, "children": []}
    head = kids[0]
    return _prune(head).to_dict()


def _prune(node: MindNode, depth: int = 1) -> MindNode:
    return MindNode(
        title=node.title,
        depth=depth,
        children=[_prune(c, depth + 1) for c in node.children],
    )


def node_count(node: dict) -> int:
    """节点总数（测试断言具体值用）。"""
    return 1 + sum(node_count(c) for c in node.get("children", []))


__all__ = [
    "MINDMAP_FORMAT",
    "MINDMAP_SCHEMA",
    "MAX_DEPTH",
    "MindNode",
    "build_mindmap_prompt",
    "normalize_markmap",
    "from_chapters",
    "to_tree",
    "node_count",
]
