"""纯文本适配器 + **各 adapter 共用的文本工具**。

为什么工具放这里：`server/adapters/` 下只有 base/registry/pdf/slide/docx/text 六个文件
属 T1 写域（AGENTS.md §2），所以共用的小函数集中在 text.py（最早的适配器），
其它 adapter 从这里 import —— 不额外造文件，避免与 T2/T3 的写域撞车。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from worker.adapters.base import (
    DocDraft,
    DocumentAdapter,
    ProgressFn,
    Span,
    UnitDraft,
    report,
)
from worker.adapters.registry import register

# ── 语言/文本工具 ───────────────────────────────────────────────────────
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def cjk_ratio(s: str) -> float:
    """中文字符占比（用于猜 ``lang``，不用于分词）。"""
    if not s:
        return 0.0
    cjk = len(_CJK_RE.findall(s))
    # 只按非空白字符算，避免英文长文里空格多导致比例虚低
    body = re.sub(r"\s+", "", s)
    return cjk / max(1, len(body))


def guess_lang(s: str) -> str:
    return "zh" if cjk_ratio(s) > 0.05 else "en"


def clean_text(s: str) -> str:
    """去零宽字符与 \\xa0，压掉 3 个以上空行。"""
    if not s:
        return ""
    s = s.replace("\u00a0", " ").replace("\u200b", "").replace("\ufeff", "")
    s = re.sub(r"\r\n?", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


_NOISE_TITLE = re.compile(r"[\s\u3000]*$")


# ── 标题识别（pdf/slide/docx/text 共用）─────────────────────────────────
_MD_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
_NUM_HEADING = re.compile(r"^(\d+(?:\.\d+)*)[.)、]?\s+(\S.*)$")
_CHAPTER_HEADING = re.compile(
    r"^(chapter|part|appendix|section|第)\s*([0-9一二三四五六七八九十]+|[A-Z])[.:：、]?\s*(\S.*)$",
    re.I,
)


def level_from_numbering(title: str) -> int | None:
    """从标题编号推层级：``1``→1、``1.2``→2、``1.2.3``→3。

    这是**启发式**，只在没有权威层级（如 markdown ``#`` / docx Heading N）时用。
    """
    t = (title or "").strip()
    m = _NUM_HEADING.match(t)
    if m and len(t) <= 90:
        return m.group(1).count(".") + 1
    m2 = _CHAPTER_HEADING.match(t)
    if m2:
        # "Chapter 7 xxx" / "第 3 章 xxx" → 顶层
        return 1
    return None


def split_numbering(title: str) -> tuple[str, str]:
    """``"7.4.2 Buffer Pool"`` → ``("7.4.2", "Buffer Pool")``。"""
    t = (title or "").strip()
    m = _NUM_HEADING.match(t)
    if m:
        return m.group(1), m.group(2).strip()
    return "", t


@dataclass
class RawNode:
    """:func:`build_parents` 的输入/输出节点。"""

    i: int
    lvl: int
    title: str
    start: int
    end: int = 0
    parent: int | None = None
    children: list[int] | None = None
    text: str = ""

    def __post_init__(self) -> None:
        if self.children is None:
            self.children = []


def numbering_of(title: str) -> str:
    """取标题的编号（``"3.1 事务"``→``"3.1"``；``"Chapter 7 X"``→``"7"``；无 → ``""``）。"""
    t = (title or "").strip()
    m = _NUM_HEADING.match(t)
    if m:
        return m.group(1)
    m2 = _CHAPTER_HEADING.match(t)
    if m2:
        num = m2.group(2)
        zh = {"一": "1", "二": "2", "三": "3", "四": "4", "五": "5",
              "六": "6", "七": "7", "八": "8", "九": "9", "十": "10"}
        return zh.get(num, num)
    return ""


def numbering_compatible(parent_title: str, child_title: str) -> bool:
    """子标题的编号是否**真的**从属于父标题（``1`` ⊃ ``1.1``；``1`` ⊅ ``3.1``）。

    为什么需要：PPT/文本里标题编号往往**跨章**出现（``1.1`` 与 ``3.1`` 之间没有 ``3``），
    纯栈式算法会把 ``3.1`` 挂到上一个 L1（``数据库课程``）下面 —— 层级上说得通，
    语义上完全错。带编号的层级**必须**校验前缀。
    """
    p, c = numbering_of(parent_title), numbering_of(child_title)
    if not c:
        return True  # 子标题没编号 → 无法证伪，交给层级规则
    if not p:
        return False  # 父标题没编号，子标题有 → 不能当父子
    return c == p or c.startswith(p + ".")


def build_parents(nodes: list[RawNode], *, check_numbering: bool = False) -> list[RawNode]:
    """**栈式建树**（层级 + 顺序），抄自 ``数据库课程智能体调研/tools/build_tree.py::build_parents``。

    ✗ 曾经的错误写法：用**页码区间反推**父子 —— 页码在同章内会交错，
      症状是层级跳跃（L2→L4）、编号矛盾（6.5 下挂 6.4.3）、不可达根。
    ✓ 正确：层级字段（TOC 的 lvl / markdown 的 # 数 / docx 的 Heading N）
      **本身就是权威层级**，配上文档顺序，用栈即可 O(n) 确定性建树。
      若层级跳级（如 L2→L4），**规整**为父的直接子节点（保证树可达、不跳级）。

    :param check_numbering: 额外校验编号前缀（PPT/文本用；PDF 的 TOC 标题形如
        ``Chapter 7 xxx`` / ``7.4.2 xxx``，混排时前缀校验反而会误伤 → 默认关闭）
    """
    stack: list[RawNode] = []
    for n in nodes:
        n.children = []
        n.parent = None
    for n in nodes:
        while stack and stack[-1].lvl >= n.lvl:
            stack.pop()
        if stack:
            par = stack[-1]
            if check_numbering and not numbering_compatible(par.title, n.title):
                # 编号不连续 → 当成新的根，而不是硬挂
                n.parent = None
            else:
                n.parent = par.i
                par.children.append(n.i)
                if n.lvl > par.lvl + 1:
                    # 规整跳级：保留原始层级在 title 里已无从表达，这里只收敛 lvl
                    n.lvl = par.lvl + 1
        stack.append(n)
    return nodes


def fixed_windows(total: int, size: int, *, snap_newline: str | None = None) -> list[tuple[int, int]]:
    """把 ``[0, total)`` 切成固定长度的窗口（无标题可依据时的降级切分）。

    返回 ``(start, end)`` **闭区间**字符偏移。
    """
    if total <= 0:
        return []
    size = max(1, size)
    out: list[tuple[int, int]] = []
    start = 0
    while start < total:
        end = min(total, start + size) - 1
        if snap_newline is not None and end < total - 1:
            nl = snap_newline.find("\n", end)
            if nl != -1 and nl - end < size // 3:
                end = nl
        out.append((start, end))
        start = end + 1
    return out


def nodes_to_draft(
    nodes: list[RawNode],
    *,
    kind: str,
    title: str,
    span_kind: str,
    meta: dict | None = None,
    page_count: int = 0,
    lang: str = "",
) -> DocDraft:
    """把已建好父子关系的 :class:`RawNode` 列表转成 :class:`DocDraft`。

    ``RawNode.i`` 是列表下标；``parent`` 也是下标 → 映射成 ``ord = i + 1``。
    """
    units: list[UnitDraft] = []
    for idx, n in enumerate(nodes):
        ord_ = idx + 1
        parent_ord = (n.parent + 1) if n.parent is not None else None
        units.append(
            UnitDraft(
                ord=ord_,
                title=n.title,
                level=max(1, n.lvl),
                span=Span(span_kind, n.start, n.end),
                text=n.text,
                parent_ord=parent_ord,
            )
        )
    draft = DocDraft(
        title=title,
        kind=kind,
        units=units,
        meta=meta or {},
        page_count=page_count,
        lang=lang or guess_lang("".join(n.title for n in nodes)),
    )
    draft.validate()
    return draft


# ── TextAdapter ─────────────────────────────────────────────────────────
#: 固定窗口大小（字符）；无标题文本按此切块
TEXT_WINDOW_CHARS = 2000


@register
class TextAdapter(DocumentAdapter):
    """纯文本 / Markdown（span = ``char``）。

    切分依据（F1）：Markdown 用 ``#`` 层级；纯文本按编号标题（``1.2 x``）或短行标题；
    都没有 → 按固定窗口降级（**不把整篇当 1 个 unit**，契约 §4 硬要求）。
    """

    kind = "text"
    extensions = (".txt", ".md", ".markdown", ".rst", ".log", ".text")

    def can_handle(self, path: str) -> bool:
        return Path(path).suffix.lower() in self.extensions

    # ── 解析 ────────────────────────────────────────────────────────
    def parse(self, path: str, *, on_progress: ProgressFn | None = None) -> DocDraft:
        p = Path(path)
        report(on_progress, 0.05, "读取文本")
        raw = self._read(p)
        text = clean_text(raw)
        report(on_progress, 0.3, "识别标题")
        nodes = self._headings(text)
        mode = "headings"
        if not nodes:
            nodes = self._windows(text)
            mode = "windows"
        report(on_progress, 0.8, f"建树（{len(nodes)} 个单元）")
        draft = nodes_to_draft(
            nodes,
            kind=self.kind,
            title=p.stem,
            span_kind="char",
            meta={"chars": len(text), "mode": mode},
        )
        report(on_progress, 1.0, "完成")
        return draft

    def probe(self, path: str) -> dict:
        try:
            text = self._read(Path(path))
        except OSError:
            return {}
        return {"chars": len(text), "lang": guess_lang(text)}

    @staticmethod
    def _read(p: Path) -> str:
        data = p.read_bytes()
        for enc in ("utf-8", "utf-8-sig", "gb18030", "latin-1"):
            try:
                return data.decode(enc)
            except UnicodeDecodeError:
                continue
        return data.decode("utf-8", errors="replace")

    # ── 标题切分 ────────────────────────────────────────────────────
    def _headings(self, text: str) -> list[RawNode]:
        spans: list[tuple[int, int, str, int]] = []  # (offset, level, title, line_end)
        offset = 0
        lines = text.split("\n")
        for idx, line in enumerate(lines):
            line_with_nl = len(line) + 1
            m = _MD_HEADING.match(line)
            lvl: int | None = None
            title = ""
            if m:
                lvl = len(m.group(1))
                title = m.group(2).strip()
            else:
                stripped = line.strip()
                if (
                    0 < len(stripped) <= 90
                    and not stripped.endswith((".", ",", ";", ":", "。", "，", "；"))
                ):
                    n = level_from_numbering(stripped)
                    if n is not None:
                        lvl = n
                        title = stripped
                    elif (
                        len(stripped) <= 40
                        and stripped.isupper()
                        and any(c.isalpha() for c in stripped)
                    ):
                        lvl = 1
                        title = stripped
            if lvl is not None and title:
                spans.append((offset, lvl, title, offset + line_with_nl))
            offset += line_with_nl
        if not spans:
            return []
        # 每个标题的正文 = 从标题行结束到下一个标题开始
        nodes: list[RawNode] = []
        for k, (off, lvl, title, line_end) in enumerate(spans):
            region_end = spans[k + 1][0] - 1 if k + 1 < len(spans) else len(text) - 1
            # 空正文的标题要保证 span.start <= span.end，否则 Span 校验会拒
            region_end = max(off, region_end)
            body = text[line_end : region_end + 1].strip()
            nodes.append(
                RawNode(
                    i=k,
                    lvl=lvl,
                    title=title,
                    start=off,
                    end=region_end,
                    text=clean_text(body),
                )
            )
        return build_parents(nodes)

    def _windows(self, text: str) -> list[RawNode]:
        wins = fixed_windows(len(text), TEXT_WINDOW_CHARS, snap_newline=text)
        nodes: list[RawNode] = []
        for i, (s, e) in enumerate(wins):
            body = text[s : e + 1]
            first = next((ln.strip() for ln in body.split("\n") if ln.strip()), "")
            nodes.append(
                RawNode(
                    i=i,
                    lvl=1,
                    title=first[:60] or f"第 {i + 1} 块",
                    start=s,
                    end=e,
                    text=clean_text(body),
                )
            )
        return nodes
