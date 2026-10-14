"""Unit 模型（契约 §2.2）—— 文档切分单元。

PDF→小节、PPTX→幻灯片、视频→时间片、文本→字符块。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .common import ModelError, Span, as_int

#: 叙述性正文在 unit 里的最大长度（超长文本会撑爆 LLM 上下文，由 pipeline 截断）
MAX_UNIT_TEXT_CHARS = 60_000


@dataclass
class Unit:
    """一个切分单元（DB 表 ``units``）。"""

    id: str
    doc_id: str
    ord: int  # 文档内顺序（1-based 更直观；DB 列名 ord）
    title: str = ""
    level: int = 1
    parent_id: str | None = None
    span: Span = field(default_factory=lambda: Span("page", 0, 0))
    text: str = ""
    text_len: int = 0

    def __post_init__(self) -> None:
        if not self.id or not self.doc_id:
            raise ModelError("unit.id / unit.doc_id 不能为空")
        self.ord = int(self.ord)
        if self.ord < 0:
            raise ModelError(f"unit.ord 不能为负：{self.ord}")
        self.level = max(1, int(self.level or 1))
        if isinstance(self.span, dict):
            self.span = Span.from_dict(self.span)
        if self.text_len <= 0:
            self.text_len = len(self.text or "")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "doc_id": self.doc_id,
            "order": self.ord,  # 契约 §2.2 用 "order"
            "title": self.title,
            "level": self.level,
            "parent_id": self.parent_id,
            "span": self.span.to_dict(),
            "text": self.text,
            "text_len": self.text_len,
        }

    def to_row(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "doc_id": self.doc_id,
            "ord": self.ord,
            "title": self.title,
            "level": self.level,
            "parent_id": self.parent_id,
            "span_kind": self.span.kind,
            "span_start": self.span.start,
            "span_end": self.span.end,
            "text": self.text,
            "text_len": self.text_len,
        }

    @classmethod
    def from_row(cls, row: Any) -> "Unit":
        return cls(
            id=row["id"],
            doc_id=row["doc_id"],
            ord=as_int(row["ord"]),
            title=row["title"] or "",
            level=as_int(row["level"], 1),
            parent_id=row["parent_id"],
            span=Span(
                kind=row["span_kind"],
                start=as_int(row["span_start"]),
                end=as_int(row["span_end"]),
            ),
            text=row["text"] or "",
            text_len=as_int(row["text_len"]),
        )
