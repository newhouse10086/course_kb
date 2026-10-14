"""Card 模型（契约 §2.3）—— 知识卡片，字段权威定义见 ``schema/knowledge_card.json``。"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .common import EnumViolation, ModelError, Span, as_float, clamp01, name_key
from .schema_enums import (
    card_kinds,
    lifecycles,
    operational_roles,
    usage_modes,
)


@dataclass
class Card:
    """一张知识卡片（DB 表 ``cards``）。"""

    id: str
    doc_id: str
    unit_id: str
    name: str
    kind: str
    one_line: str = ""
    purpose: str = ""
    usage_mode: str = "unknown"
    operational_role: str = "unknown"
    lifecycle: str = "unknown"
    example: str | None = None
    example_explained: str | None = None
    prerequisites: list[str] = field(default_factory=list)
    cautions: list[str] = field(default_factory=list)
    evidence_quote: str = ""
    span: Span = field(default_factory=lambda: Span("page", 0, 0))
    confidence: float = 0.0
    name_key: str = ""

    def __post_init__(self) -> None:
        if not self.id or not self.doc_id or not self.unit_id:
            raise ModelError("card.id / doc_id / unit_id 不能为空")
        if not self.name:
            raise ModelError("card.name 不能为空（没有名字的卡片无法被引用）")
        # 封闭枚举：字段必须以 schema/knowledge_card.json 为准
        if self.kind not in card_kinds():
            raise EnumViolation(
                f"card.kind={self.kind!r} 不在 schema/knowledge_card.json 的 "
                f"{len(card_kinds())} 种内"
            )
        if self.usage_mode not in usage_modes():
            raise EnumViolation(f"card.usage_mode={self.usage_mode!r} 非法")
        if self.operational_role not in operational_roles():
            raise EnumViolation(f"card.operational_role={self.operational_role!r} 非法")
        if self.lifecycle not in lifecycles():
            raise EnumViolation(f"card.lifecycle={self.lifecycle!r} 非法")
        if isinstance(self.span, dict):
            self.span = Span.from_dict(self.span)
        self.prerequisites = [str(x) for x in (self.prerequisites or []) if str(x).strip()]
        self.cautions = [str(x) for x in (self.cautions or []) if str(x).strip()]
        self.confidence = clamp01(self.confidence)
        if not self.name_key:
            self.name_key = name_key(self.name)

    def to_dict(self) -> dict[str, Any]:
        """API 形态（契约 §2.3：``evidence_span`` 是可回溯锚点）。"""
        return {
            "id": self.id,
            "doc_id": self.doc_id,
            "unit_id": self.unit_id,
            "name": self.name,
            "kind": self.kind,
            "one_line": self.one_line,
            "purpose": self.purpose,
            "usage_mode": self.usage_mode,
            "operational_role": self.operational_role,
            "lifecycle": self.lifecycle,
            "example": self.example,
            "example_explained": self.example_explained,
            "prerequisites": list(self.prerequisites),
            "cautions": list(self.cautions),
            "evidence_quote": self.evidence_quote,
            "evidence_span": self.span.to_dict(),
            "confidence": self.confidence,
        }

    def to_row(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "doc_id": self.doc_id,
            "unit_id": self.unit_id,
            "name": self.name,
            "kind": self.kind,
            "one_line": self.one_line,
            "purpose": self.purpose,
            "usage_mode": self.usage_mode,
            "operational_role": self.operational_role,
            "lifecycle": self.lifecycle,
            "example": self.example,
            "example_explained": self.example_explained,
            "prerequisites_json": json.dumps(self.prerequisites, ensure_ascii=False),
            "cautions_json": json.dumps(self.cautions, ensure_ascii=False),
            "evidence_quote": self.evidence_quote,
            "span_kind": self.span.kind,
            "span_start": self.span.start,
            "span_end": self.span.end,
            "confidence": self.confidence,
            "name_key": self.name_key,
        }

    @classmethod
    def from_row(cls, row: Any) -> "Card":
        def _lst(key: str) -> list[str]:
            raw = row[key] if key in row.keys() else "[]"
            try:
                val = json.loads(raw or "[]")
            except json.JSONDecodeError:
                return []
            return [str(x) for x in val] if isinstance(val, list) else []

        return cls(
            id=row["id"],
            doc_id=row["doc_id"],
            unit_id=row["unit_id"],
            name=row["name"],
            kind=row["kind"],
            one_line=row["one_line"] or "",
            purpose=row["purpose"] or "",
            usage_mode=row["usage_mode"] or "unknown",
            operational_role=row["operational_role"] or "unknown",
            lifecycle=row["lifecycle"] or "unknown",
            example=row["example"],
            example_explained=row["example_explained"],
            prerequisites=_lst("prerequisites_json"),
            cautions=_lst("cautions_json"),
            evidence_quote=row["evidence_quote"] or "",
            span=Span(
                kind=row["span_kind"] or "page",
                start=int(row["span_start"] or 0),
                end=int(row["span_end"] or 0),
            ),
            confidence=as_float(row["confidence"]),
            name_key=row["name_key"] or name_key(row["name"]),
        )
