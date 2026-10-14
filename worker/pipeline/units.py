"""单元划分（★ 修坑 5）：**递归下降 + 引言段**。

``FUNCTIONAL_SPEC.md`` 坑 5 的原始错误写法：

```python
# ✗ 错误：跨度 > N 的节点既不选、也不下钻 → 整片丢页
if span <= N: 选它
# 实测：N=8 时漏掉 1874 个节点，含 Chapter 8 Security 的 616 页
```

正确做法（本文件实现）：

```python
def pick(node, N=8):
    kids = children(node)
    if kids and kids[0].pg > node.pg:      # ① 父节点自己的引言段（否则这段没人管）
        yield intro(node.pg, kids[0].pg - 1)
    if not kids or (node.end - node.pg) <= N:   # ② 叶子，或已经够小
        yield section(node)
        return
    for c in kids:                          # ③ 太大 → 下钻（**不是丢弃**）
        yield from pick(c, N)
```

本实现比原式**更严一层**：连「叶子但跨度 > N」和「引言段本身 > N」也会按
N 页切成窗口（``window``），保证**任何页都不会因为太大而没人管**。
:func:`pick_units_legacy` 保留了旧的错误算法，专门用来做对照实验证明修好了。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Sequence

from worker.models import Span, Unit

#: 抽取单元上限（**按 span 种类**给预算；已验证常量 8 页，不要重新发明）
MAX_PAGES_PER_UNIT = 8
MAX_SLIDES_PER_UNIT = 8
#: 纯文本/网页：字符预算（≈ 8 页正文的体量）
MAX_CHARS_PER_UNIT = 8_000
#: 视频/音频：毫秒预算（5 分钟音视频 ≈ 800 字，一屏可读完）
MAX_MS_PER_UNIT = 300_000

#: 文本提供者：给 span 返回正文（用于跨越 DB 存储上限的大跨度窗口）
TextProvider = Callable[[Span], str]


def budget_for(span_kind: str, max_pages: int = MAX_PAGES_PER_UNIT) -> int:
    """不同 span 种类的"多大算太大"。

    ⚠️ 必须区分种类：``char`` span 的 ``end - start`` 是**字符数**，
    若沿用「8」会把 5000 字的正文切成 8 字一段（第一版就踩了这个）。
    """
    if span_kind == "page":
        return max(1, int(max_pages))
    if span_kind == "slide":
        return MAX_SLIDES_PER_UNIT
    if span_kind == "time":
        return MAX_MS_PER_UNIT
    return MAX_CHARS_PER_UNIT


@dataclass
class PickedUnit:
    """一个待抽取的单元（可能不是 DB 里的原始 unit，见 ``kind``）。"""

    ord: int
    unit_id: str
    title: str
    level: int
    kind: str  # section | intro | window
    span: Span
    text: str

    @property
    def chars(self) -> int:
        return len(self.text)

    def to_dict(self) -> dict:
        return {
            "ord": self.ord,
            "unit_id": self.unit_id,
            "title": self.title,
            "level": self.level,
            "kind": self.kind,
            "span": self.span.to_dict(),
            "chars": self.chars,
        }


@dataclass
class PickStats:
    """划分质量指标（用于验收「不丢页」）。"""

    pages_total: int = 0
    content_units: int = 0
    pages_covered: int = 0
    missing_pages: list[int] = field(default_factory=list)
    n_nodes: int = 0
    n_picked: int = 0
    n_section: int = 0
    n_intro: int = 0
    n_window: int = 0

    @property
    def coverage(self) -> float:
        """**内容覆盖率**：单元声明的区间里，被抽取单元覆盖的比例。

        分母用"内容单位"（所有 unit span 的并集，扣除主动排除的页），
        而不是文档总页数 —— 否则被有意排除的索引章（如 MySQL 的 969 页）
        会把覆盖率算低，看起来像"丢了内容"。
        """
        return (self.pages_covered / self.content_units) if self.content_units else 0.0

    @property
    def missing_count(self) -> int:
        """漏掉的**内容单位**数（0 = 一个都没丢，坑 5 的验收判据）。"""
        return len(self.missing_pages)

    @property
    def coverage_declared(self) -> float:
        """相对文档声明规模（``page_count``）的覆盖率（含被排除页）。"""
        return (self.pages_covered / self.pages_total) if self.pages_total else 0.0

    def to_dict(self) -> dict:
        return {
            "pages_total": self.pages_total,
            "content_units": self.content_units,
            "pages_covered": self.pages_covered,
            "coverage": round(self.coverage, 4),
            "coverage_declared": round(self.coverage_declared, 4),
            "missing_pages": self.missing_pages[:50],
            "missing_count": len(self.missing_pages),
            "n_nodes": self.n_nodes,
            "n_picked": self.n_picked,
            "n_section": self.n_section,
            "n_intro": self.n_intro,
            "n_window": self.n_window,
        }


# ── 主算法 ──────────────────────────────────────────────────────────────
def pick_units(
    units: Sequence[Unit],
    *,
    max_pages: int = MAX_PAGES_PER_UNIT,
    text_provider: TextProvider | None = None,
    pages_total: int = 0,
    excluded_ranges: Sequence[Sequence[int]] | None = None,
) -> tuple[list[PickedUnit], PickStats]:
    """把层次树切成待抽取单元（递归下降 + 引言段 + 大跨度切窗）。

    :param excluded_ranges: 主动排除的区间（如 PDF 的索引章），既不算"内容"，
        也不算"漏页"。格式 ``[[start, end], ...]``。
    """
    max_pages = max(1, int(max_pages))
    by_id = {u.id: u for u in units}
    children: dict[str | None, list[Unit]] = {}
    for u in sorted(units, key=lambda x: x.ord):
        children.setdefault(u.parent_id if u.parent_id in by_id else None, []).append(u)

    picked: list[PickedUnit] = []
    stats = PickStats()
    stats.n_nodes = len(units)
    seen_spans: set[tuple[str, int, int]] = set()

    def text_for(unit: Unit, span: Span) -> str:
        """取 span 的正文。

        优先级：``text_provider``（回源，精确） > DB 存的完整正文（span == unit.span）
        > 按比例/偏移切（近似，仅在无 provider 时用）。
        """
        if text_provider is not None:
            return text_provider(span)
        if span.kind == unit.span.kind and span.start == unit.span.start and span.end == unit.span.end:
            return unit.text
        if not unit.text:
            return ""
        # char span：偏移是**同一份文本**上的位置，可以精确切
        if span.kind == "char" and unit.span.kind == "char":
            off = max(0, span.start - unit.span.start)
            return unit.text[off : off + (span.end - span.start + 1)]
        # page/slide/time：DB 只存了前 N 页，只能按比例近似（有 provider 时不会走到这）
        size = max(1, unit.span.size)
        fs = max(0.0, (span.start - unit.span.start) / size)
        fe = min(1.0, (span.end - unit.span.start + 1) / size)
        n = len(unit.text)
        return unit.text[int(fs * n) : int(fe * n)]

    def emit(unit: Unit, span: Span, kind: str, title: str) -> None:
        key = (span.kind, span.start, span.end)
        if key in seen_spans:
            return
        seen_spans.add(key)
        txt = text_for(unit, span).strip()
        picked.append(
            PickedUnit(
                ord=len(picked) + 1,
                unit_id=unit.id,
                title=title,
                level=unit.level,
                kind=kind,
                span=span,
                text=txt,
            )
        )
        stats.n_picked += 1
        if kind == "section":
            stats.n_section += 1
        elif kind == "intro":
            stats.n_intro += 1
        else:
            stats.n_window += 1

    def emit_windows(unit: Unit, span: Span, kind: str, title: str) -> None:
        """把跨度超过预算的区间切成 ≤ 预算的窗口（一个单位也不丢）。"""
        step = budget_for(span.kind, max_pages)
        total = span.end - span.start + 1
        if total <= step:
            emit(unit, span, kind, title)
            return
        k = 0
        n_win = (total + step - 1) // step
        start = span.start
        while start <= span.end:
            end = min(span.end, start + step - 1)
            k += 1
            emit(unit, Span(span.kind, start, end), "window", f"{title}（{k}/{n_win}）")
            start = end + 1

    def walk(unit: Unit) -> None:
        kids = [c for c in children.get(unit.id, []) if c.span.start >= unit.span.start]
        if not kids:
            # 叶子：不管多大都要产出（大叶子按窗口切）
            emit_windows(unit, unit.span, "section", unit.title)
            return

        # ① 引言段：父节点自身在第一个子节点之前的部分
        first = min(k.span.start for k in kids)
        if first > unit.span.start:
            emit_windows(
                unit,
                Span(unit.span.kind, unit.span.start, first - 1),
                "intro",
                f"{unit.title}（引言）",
            )

        # ② 够小 **且子节点确实落在父区间内** → 整体作为一个单元（不再下钻）
        #
        #   ⚠️ 为什么必须加"子节点在父区间内"这个条件：
        #      PDF 的父节点 span 覆盖子节点（TOC 的 end 一直算到下一个同级），
        #      但 **char span（文本/DOCX）的父节点区间止于下一个标题** ——
        #      子节点的区间根本不在父区间里。若此时"够小就收手"，
        #      子节点的正文会**整片没人管**（正是坑 5 的同一种丢内容）。
        span_len = unit.span.end - unit.span.start + 1
        kids_inside = all(
            unit.span.start <= k.span.start and k.span.end <= unit.span.end for k in kids
        )
        if span_len <= budget_for(unit.span.kind, max_pages) and kids_inside:
            emit(unit, unit.span, "section", unit.title)
            return

        # ③ 太大（或区间不嵌套）→ **下钻**（坑 5 的关键：绝不丢弃）
        for c in kids:
            walk(c)

        # ④ 兜底：父区间里没被子节点覆盖的部分（TOC 缺页 / 非嵌套结构）
        covered: set[int] = set()
        for c in kids:
            covered.update(range(c.span.start, c.span.end + 1))
        start = unit.span.start
        while start <= unit.span.end:
            if start in covered:
                start += 1
                continue
            end = start
            while end + 1 <= unit.span.end and (end + 1) not in covered:
                end += 1
            emit_windows(
                unit,
                Span(unit.span.kind, start, end),
                "window",
                f"{unit.title}（补漏）",
            )
            start = end + 1

    roots = children.get(None, [])
    for r in roots:
        walk(r)

    # ── 覆盖率（防丢页的自证指标）────────────────────────────────────
    # 分母 = **内容单位**（所有 unit span 的并集，扣除主动排除的区间），
    # 而不是文档声明页数：被有意排除的索引章不该让覆盖率看起来像"丢了内容"。
    excluded: set[int] = set()
    for rng in excluded_ranges or []:
        try:
            s, e = int(rng[0]), int(rng[1])
        except (IndexError, TypeError, ValueError):
            continue
        excluded.update(range(s, e + 1))
    content: set[int] = set()
    for u in units:
        content.update(range(u.span.start, u.span.end + 1))
    content -= excluded
    # ★ Lead 集成修复（2026-10-14）：原代码此处是**半截表达式**，导致 SyntaxError:
    #     covered = {p for p in (set().union(*[set(range(...)) for p in picked])
    #                            if picked) if p in content}
    #     → "expected 'else' after 'if' expression"
    #   后果：server/main.py import 失败 → 整个服务起不来，2 个测试文件无法收集。
    #   现拆成显式循环：语义更清楚，且天然处理 picked 为空的情况。
    _picked_pages: set[int] = set()
    for _u in picked:
        _picked_pages.update(range(_u.span.start, _u.span.end + 1))
    covered = {p for p in _picked_pages if p in content}
    stats.pages_total = int(pages_total or (max(content) - min(content) + 1 if content else 0))
    stats.content_units = len(content)
    stats.pages_covered = len(covered)
    stats.missing_pages = sorted(content - covered)
    return picked, stats


def pick_units_legacy(
    units: Sequence[Unit], *, max_pages: int = MAX_PAGES_PER_UNIT
) -> tuple[list[PickedUnit], PickStats]:
    """**旧的错误算法**（保留做对照实验，证明坑 5 真的修好了）。

    ```python
    # ✗ 错误：跨度 > N 的节点既不选、也不下钻 → 整片丢页
    for n in nodes:                 # 上游 extract_v2.build_blocks 是**平铺**遍历
        if span <= N: 选它           # 否则什么都不做（包括不递归子节点）
    ```

    关键点：它是**平铺**扫描，不是递归 —— 所以"大章下的小节"仍会被选中，
    丢的是"大章自己覆盖、而其子节点没覆盖到的那些页"（实测漏 1874 个节点）。
    """
    picked: list[PickedUnit] = []
    stats = PickStats()
    stats.n_nodes = len(units)
    for u in sorted(units, key=lambda x: x.ord):
        if (u.span.end - u.span.start + 1) <= max_pages:
            picked.append(
                PickedUnit(
                    ord=len(picked) + 1,
                    unit_id=u.id,
                    title=u.title,
                    level=u.level,
                    kind="section",
                    span=u.span,
                    text=u.text,
                )
            )
            stats.n_section += 1
        # ✗ 就是这里：跨度太大的节点被直接跳过，其覆盖的页再没人管
    stats.n_picked = len(picked)
    content: set[int] = set()
    for u in units:
        content.update(range(u.span.start, u.span.end + 1))
    covered = {p for p in content if any(q.span.start <= p <= q.span.end for q in picked)}
    stats.pages_total = (max(content) - min(content) + 1) if content else 0
    stats.content_units = len(content)
    stats.pages_covered = len(covered)
    stats.missing_pages = sorted(content - covered)
    return picked, stats


def compare_algorithms(
    units: Sequence[Unit], *, max_pages: int = MAX_PAGES_PER_UNIT
) -> dict:
    """对照实验：旧算法 vs 递归下降（bug 5 的量化证据）。"""
    _, old = pick_units_legacy(units, max_pages=max_pages)
    _, new = pick_units(units, max_pages=max_pages)
    return {
        "max_pages": max_pages,
        "legacy": old.to_dict(),
        "recursive": new.to_dict(),
        "pages_recovered": old.pages_covered and (new.pages_covered - old.pages_covered),
        "missing_pages_legacy": len(old.missing_pages),
        "missing_pages_recursive": len(new.missing_pages),
    }
