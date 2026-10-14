"""Entity / Edge 模型（契约 §2.4）—— 知识图谱。

``etype`` 与 ``type`` 都来自 ``schema/edge_types.json``（封闭枚举）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .common import (
    EnumViolation,
    ModelError,
    Span,
    as_float,
    as_int,
    clamp01,
    name_key,
)
from .schema_enums import entity_types, edge_types, layers


@dataclass
class Entity:
    """图谱节点（DB 表 ``entities``）。"""

    id: str
    doc_id: str
    name: str
    name_zh: str = ""
    layer: str = ""
    type: str = "concept"
    degree: int = 0
    name_key: str = ""

    def __post_init__(self) -> None:
        if not self.id or not self.doc_id:
            raise ModelError("entity.id / doc_id 不能为空")
        if not self.name:
            raise ModelError("entity.name 不能为空")
        if self.type not in entity_types():
            raise EnumViolation(
                f"entity.type={self.type!r} 不在 schema/edge_types.json entity_types 内；"
                f"允许：{list(entity_types())}"
            )
        if self.layer and self.layer not in layers():
            raise EnumViolation(
                f"entity.layer={self.layer!r} 非法；允许：{list(layers())} 或空串"
            )
        self.degree = as_int(self.degree)
        if not self.name_key:
            self.name_key = name_key(self.name)

    def to_dict(self, unit_ids: list[str] | None = None) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "name_zh": self.name_zh,
            "type": self.type,
            "layer": self.layer,
            "degree": self.degree,
            "doc_id": self.doc_id,
        }
        if unit_ids is not None:
            d["unit_ids"] = list(unit_ids)
        return d

    def to_row(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "doc_id": self.doc_id,
            "name": self.name,
            "name_zh": self.name_zh,
            "layer": self.layer,
            "type": self.type,
            "degree": self.degree,
            "name_key": self.name_key,
        }

    @classmethod
    def from_row(cls, row: Any) -> "Entity":
        return cls(
            id=row["id"],
            doc_id=row["doc_id"],
            name=row["name"],
            name_zh=row["name_zh"] or "",
            layer=row["layer"] or "",
            type=row["type"],
            degree=as_int(row["degree"]),
            name_key=row["name_key"] or name_key(row["name"]),
        )


@dataclass
class Edge:
    """图谱边（DB 表 ``edges``，``UNIQUE(doc_id, src_id, dst_id, etype)``）。

    ⚠️ ``flagged``：因果可疑**只标记不删除**（曾因过度校验删掉真边）。
    """

    id: str
    doc_id: str
    src_id: str
    dst_id: str
    etype: str
    evidence_text: str = ""
    span: Span = field(default_factory=lambda: Span("page", 0, 0))
    confidence: float = 0.0
    flagged: bool = False

    def __post_init__(self) -> None:
        if not (self.id and self.doc_id and self.src_id and self.dst_id):
            raise ModelError("edge.id / doc_id / src_id / dst_id 不能为空")
        if self.etype not in edge_types():
            raise EnumViolation(
                f"edge.etype={self.etype!r} 不在 schema/edge_types.json 的 "
                f"{len(edge_types())} 种内；允许：{list(edge_types())}"
            )
        if self.src_id == self.dst_id:
            raise ModelError(f"edge 不允许自环：{self.src_id}")
        if isinstance(self.span, dict):
            self.span = Span.from_dict(self.span)
        self.confidence = clamp01(self.confidence)
        self.flagged = bool(self.flagged)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "src": self.src_id,
            "dst": self.dst_id,
            "etype": self.etype,
            "evidence": self.evidence_text,
            "span": self.span.to_dict(),
            "confidence": self.confidence,
            "flagged": self.flagged,
            "doc_id": self.doc_id,
        }

    def to_row(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "doc_id": self.doc_id,
            "src_id": self.src_id,
            "dst_id": self.dst_id,
            "etype": self.etype,
            "evidence_text": self.evidence_text,
            "span_kind": self.span.kind,
            "span_start": self.span.start,
            "span_end": self.span.end,
            "confidence": self.confidence,
            "flagged": 1 if self.flagged else 0,
        }

    @classmethod
    def from_row(cls, row: Any) -> "Edge":
        return cls(
            id=row["id"],
            doc_id=row["doc_id"],
            src_id=row["src_id"],
            dst_id=row["dst_id"],
            etype=row["etype"],
            evidence_text=row["evidence_text"] or "",
            span=Span(
                kind=row["span_kind"] or "page",
                start=as_int(row["span_start"]),
                end=as_int(row["span_end"]),
            ),
            confidence=as_float(row["confidence"]),
            flagged=bool(row["flagged"]),
        )


@dataclass
class ExtractedGraph:
    """一次抽取产出的图（LLM 输出的中立容器，入库前用）。"""

    entities: list[Entity] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)
    dropped: dict[str, int] = field(default_factory=dict)

    def as_json(self) -> str:
        return json.dumps(
            {
                "entities": [e.to_dict() for e in self.entities],
                "edges": [e.to_dict() for e in self.edges],
                "dropped": dict(self.dropped),
            },
            ensure_ascii=False,
            indent=1,
        )
