"""Cross-Reference 模型（契约 §2.5）—— Wiki 互相引用的边。

``rel`` 枚举（**顺序即优先级**）：typed > mention > also_in > same_unit
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .common import ModelError, as_int, check_enum

#: 契约 §2.5：顺序即优先级（渲染时高优先级在前）
XREF_RELS: tuple[str, ...] = ("typed", "mention", "also_in", "same_unit")

XREF_REL_DESC: dict[str, str] = {
    "typed": "图谱类型化边（来自 Edge）",
    "mention": "正文提及（含假阳性过滤）",
    "also_in": "跨单元复现（同名卡片出现在多个 Unit）",
    "same_unit": "同单元知识点",
}


@dataclass
class Xref:
    """一条交叉引用（DB 表 ``xrefs``，主键 (from,to,rel)）。"""

    from_card_id: str
    to_card_id: str
    rel: str = "mention"
    weight: int = 1

    def __post_init__(self) -> None:
        if not self.from_card_id or not self.to_card_id:
            raise ModelError("xref 的 from/to 不能为空")
        check_enum(self.rel, XREF_RELS, "xref.rel")
        self.weight = max(1, as_int(self.weight, 1))

    def to_dict(self) -> dict[str, Any]:
        return {
            "from_card_id": self.from_card_id,
            "to_card_id": self.to_card_id,
            "rel": self.rel,
            "weight": self.weight,
        }

    def to_row(self) -> dict[str, Any]:
        return {
            "from_card_id": self.from_card_id,
            "to_card_id": self.to_card_id,
            "rel": self.rel,
            "weight": self.weight,
        }

    @classmethod
    def from_row(cls, row: Any) -> "Xref":
        return cls(
            from_card_id=row["from_card_id"],
            to_card_id=row["to_card_id"],
            rel=row["rel"],
            weight=as_int(row["weight"], 1),
        )


def xref_sort_key(x: Xref) -> tuple[int, int, str]:
    """按 rel 优先级排序（typed 最前）。"""
    return (XREF_RELS.index(x.rel), -x.weight, x.to_card_id)
