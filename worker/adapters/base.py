"""DocumentAdapter 契约（``docs/API_PROTOCOL.md`` §4）—— **多文档支持的核心**。

★★ 本文件是 T1 与 T2/T3 之间的**冻结契约**：新增一种文件格式时，
**只实现本文件的接口**，不改核心（pipeline / store / REST 一行都不动）。

契约要点（逐字对应 §4）：

1. 必须切出层次（``UnitDraft.level`` / ``parent_ord``），**不要把整个文档当 1 个 unit**
2. ``span`` 必须可回溯原文（页码 / 幻灯片号 / 毫秒 / 字符偏移）
3. 长任务**必须**在内部定期落盘断点（契约 C4）
4. ``on_progress(frac: float, stage: str)`` 用于上报进度

设计约束（写在类型里，不靠口头约定）：

* ``DocDraft.units`` 的 ``ord`` **全文档唯一**，且父子关系只用 ``ord`` 表达
  （入库时才映射成 ``unt_xxx``，见 :func:`draft_to_units`）。
* 返回前必须 :meth:`DocDraft.validate` 通过 —— 悬空 ``parent_ord`` / 重复 ``ord`` /
  ``span`` 越界都会当场报错，而不是把坏数据写进库。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Callable, Iterable

from worker.models.common import ModelError, Span  # noqa: F401  (Span 是契约的一部分)

#: 进度回调：``on_progress(frac, stage)``，frac ∈ [0, 1]
ProgressFn = Callable[[float, str], None]


class UnsupportedFormat(Exception):
    """没有任何 adapter 能处理该文件（→ REST 层映射为 ``E_FORMAT`` / 415）。"""

    def __init__(self, path: str, tried: Iterable[type] | None = None):
        self.path = path
        names = ", ".join(sorted(c.__name__ for c in (tried or ()))) or "(无)"
        super().__init__(f"不支持的文件格式：{path}（已尝试的 adapter：{names}）")


class ParseError(Exception):
    """解析失败（→ REST 层映射为 ``E_PARSE`` / 422）。"""


@dataclass
class UnitDraft:
    """单元草稿（入库前的形态）。

    :param ord: 全文档唯一顺序号（建议从 1 开始递增）
    :param title: 小节标题（空标题的 unit 在树里无法展示，尽量别空）
    :param level: 层级，1 = 顶层章；**必须 >= 1**
    :param span: 可回溯锚点（页码/幻灯片号/毫秒/字符偏移）
    :param text: 正文（可为空，如纯图片幻灯片）
    :param parent_ord: 父节点的 ``ord``；顶层为 ``None``
    """

    ord: int
    title: str
    level: int
    span: Span
    text: str
    parent_ord: int | None = None

    def __post_init__(self) -> None:
        self.ord = int(self.ord)
        if self.ord < 0:
            raise ModelError(f"UnitDraft.ord 不能为负：{self.ord}")
        self.level = int(self.level)
        if self.level < 1:
            raise ModelError(f"UnitDraft.level 必须 >= 1，收到 {self.level}")
        if isinstance(self.span, dict):  # 容错：允许传 dict
            self.span = Span.from_dict(self.span)  # type: ignore[assignment]
        self.title = (self.title or "").strip()
        self.text = self.text or ""

    @property
    def text_len(self) -> int:
        return len(self.text)

    def to_dict(self) -> dict:
        return {
            "ord": self.ord,
            "title": self.title,
            "level": self.level,
            "span": self.span.to_dict(),
            "text": self.text,
            "parent_ord": self.parent_ord,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "UnitDraft":
        return cls(
            ord=d["ord"],
            title=d.get("title", ""),
            level=d.get("level", 1),
            span=Span.from_dict(d.get("span")),
            text=d.get("text", ""),
            parent_ord=d.get("parent_ord"),
        )


@dataclass
class DocDraft:
    """一份文件解析后的统一形态（格式无关）。

    ``meta`` 放格式特有信息（如 PDF 的 ``toc_entries`` / ``skipped_pages``），
    核心管线**不读**它，只透传给 ``documents.meta_json`` 供 UI 展示。
    """

    title: str
    kind: str
    units: list[UnitDraft] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    page_count: int = 0
    lang: str = ""

    # ── 校验（入库前必须通过）─────────────────────────────────────────
    def validate(self, *, require_hierarchy: bool = True) -> "DocDraft":
        if not self.units:
            raise ModelError(f"DocDraft 没有任何 unit（{self.title!r}）：adapter 没切出内容")
        seen: set[int] = set()
        for u in self.units:
            if u.ord in seen:
                raise ModelError(f"DocDraft.ord 重复：{u.ord}（同一文档内必须唯一）")
            seen.add(u.ord)
        for u in self.units:
            if u.parent_ord is not None and u.parent_ord not in seen:
                raise ModelError(
                    f"悬空 parent_ord={u.parent_ord}（unit ord={u.ord} {u.title!r}）"
                )
            if u.parent_ord == u.ord:
                raise ModelError(f"unit ord={u.ord} 的 parent_ord 指向自己")
        if require_hierarchy:
            self._check_no_cycle()
        return self

    def _check_no_cycle(self) -> None:
        by_ord = {u.ord: u for u in self.units}
        for u in self.units:
            seen: set[int] = set()
            cur = u
            while cur.parent_ord is not None:
                if cur.parent_ord in seen:
                    raise ModelError(f"parent_ord 成环：从 ord={u.ord} 出发回到 {cur.parent_ord}")
                seen.add(cur.parent_ord)
                nxt = by_ord.get(cur.parent_ord)
                if nxt is None:
                    raise ModelError(f"悬空 parent_ord={cur.parent_ord}")
                cur = nxt

    # ── 便捷属性 ─────────────────────────────────────────────────────
    @property
    def roots(self) -> list[UnitDraft]:
        return [u for u in self.units if u.parent_ord is None]

    @property
    def children_of(self) -> dict[int | None, list[UnitDraft]]:
        out: dict[int | None, list[UnitDraft]] = {}
        for u in self.units:
            out.setdefault(u.parent_ord, []).append(u)
        return out

    @property
    def text_chars(self) -> int:
        return sum(u.text_len for u in self.units)

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "kind": self.kind,
            "page_count": self.page_count,
            "lang": self.lang,
            "meta": dict(self.meta),
            "units": [u.to_dict() for u in self.units],
        }


class DocumentAdapter(ABC):
    """把一种文件格式变成统一的 :class:`DocDraft`。

    子类必须声明 ``kind`` 与 ``extensions``，并实现 :meth:`can_handle` / :meth:`parse`。
    实现 :meth:`parse` 时的硬要求：

    * **层次**：切出 ``level``/``parent_ord``。整篇当一个 unit 是**不合格**的。
    * **可回溯**：``span`` 指向原文位置（页码/幻灯片号/毫秒/字符偏移）。
    * **断点**：解析/抽取超过 ~1 分钟的操作，必须在内部定期落盘（契约 C4）。
      小文件（< 千页）可省略，但要在注释里说明为什么可以省。
    * **进度**：定期调 ``on_progress(frac, stage)``；``frac`` 单调不减、∈[0,1]。
    * **异常**：文件损坏抛 :class:`ParseError`（不要抛裸 Exception）。
    """

    #: 文档类型，必须与契约 §2.1 的 ``kind`` 枚举一致（pdf|pptx|docx|video|epub|web|text）
    kind: str = ""
    #: 可处理的扩展名（小写，含点），如 ``(".pdf",)``
    extensions: tuple[str, ...] = ()

    # ── 契约接口 ────────────────────────────────────────────────────
    @abstractmethod
    def can_handle(self, path: str) -> bool:
        """能否处理该文件（按扩展名/魔数判断）。**不得抛异常**。"""

    @abstractmethod
    def parse(self, path: str, *, on_progress: ProgressFn | None = None) -> DocDraft:
        """解析文件 → :class:`DocDraft`（契约 §4）。"""

    # ── 可选钩子（默认实现已可用，子类按需覆写）──────────────────────
    def probe(self, path: str) -> dict:
        """轻量探测（不解析全文）：给上传接口估计页数/时长用。

        默认返回空 dict（核心管线不依赖它）。
        """
        return {}

    def __repr__(self) -> str:  # pragma: no cover - 只为日志
        return f"<{type(self).__name__} kind={self.kind!r} extensions={self.extensions}>"


def report(on_progress: ProgressFn | None, frac: float, stage: str) -> None:
    """安全上报进度：回调异常不能影响解析本身。"""
    if on_progress is None:
        return
    try:
        on_progress(max(0.0, min(1.0, float(frac))), stage)
    except Exception:  # noqa: BLE001 - 进度回调是旁观者，不该拖垮解析
        pass


def draft_to_units(
    draft: DocDraft,
    doc_id: str,
    *,
    id_factory: Callable[[], str] | None = None,
    start_ord: int = 1,
) -> list["object"]:
    """把 :class:`DocDraft` 落成 :class:`worker.models.Unit` 列表。

    ``ord`` → ``unt_xxx`` 的映射就发生在这里：先分配 ID，再把 ``parent_ord``
    换成 ``parent_id``（契约 §4 的「用 ord 表达父子，入库时映射为 id」）。

    :param start_ord: 库里已有 unit 数（断点续跑时避免 ord 撞车）
    """
    from worker.models import Unit, id_for

    draft.validate()
    new_id = id_factory or (lambda: id_for("unit"))
    ord_to_id: dict[int, str] = {}
    for u in draft.units:
        ord_to_id[u.ord] = new_id()
    out: list[Unit] = []
    for idx, u in enumerate(draft.units):
        out.append(
            Unit(
                id=ord_to_id[u.ord],
                doc_id=doc_id,
                ord=start_ord + idx,
                title=u.title or f"unit {u.ord}",
                level=u.level,
                parent_id=ord_to_id.get(u.parent_ord) if u.parent_ord is not None else None,
                span=u.span,
                text=u.text,
            )
        )
    return out
