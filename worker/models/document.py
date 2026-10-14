"""Document 模型（契约 §2.1）。"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .common import ModelError, check_enum, now_ms

#: ``kind`` 枚举（契约 §2.1）
DOC_KINDS: tuple[str, ...] = ("pdf", "pptx", "docx", "video", "epub", "web", "text")

#: ``status`` 枚举（契约 §2.1）
DOC_STATUS: tuple[str, ...] = (
    "uploading",
    "parsing",
    "extracting",
    "ready",
    "failed",
)


@dataclass
class Document:
    """一份课程资料。

    对应 DB 表 ``documents``（契约 §3）；``meta`` 在库里存 ``meta_json``。
    """

    id: str
    title: str
    kind: str
    source_path: str
    size_bytes: int = 0
    page_count: int = 0
    lang: str = ""
    status: str = "uploading"
    meta: dict[str, Any] = field(default_factory=dict)
    created_at: int = 0
    updated_at: int = 0

    def __post_init__(self) -> None:
        check_enum(self.kind, DOC_KINDS, "document.kind")
        check_enum(self.status, DOC_STATUS, "document.status")
        if not self.id:
            raise ModelError("document.id 不能为空")
        if not self.title:
            # 标题可以由文件名兜底，但空标题会让 UI 无法展示
            self.title = self.source_path.rsplit("/", 1)[-1] or self.id
        self.size_bytes = int(self.size_bytes or 0)
        self.page_count = int(self.page_count or 0)
        if not self.created_at:
            self.created_at = now_ms()
        if not self.updated_at:
            self.updated_at = self.created_at

    # ── API 形态（契约 §2.1，键名逐字一致）───────────────────────────
    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "kind": self.kind,
            "source_path": self.source_path,
            "size_bytes": self.size_bytes,
            "page_count": self.page_count,
            "lang": self.lang,
            "status": self.status,
            "meta": dict(self.meta or {}),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    # ── DB 形态 ──────────────────────────────────────────────────────
    def to_row(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "kind": self.kind,
            "source_path": self.source_path,
            "size_bytes": self.size_bytes,
            "page_count": self.page_count,
            "lang": self.lang,
            "status": self.status,
            "meta_json": json.dumps(self.meta or {}, ensure_ascii=False),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_row(cls, row: Any) -> "Document":
        meta_raw = row["meta_json"] if "meta_json" in row.keys() else "{}"
        try:
            meta = json.loads(meta_raw or "{}")
        except json.JSONDecodeError:
            # 曾经把 meta_json 写成非 JSON（历史 bug）：不要让一条脏数据炸掉整页
            meta = {"_raw": meta_raw}
        return cls(
            id=row["id"],
            title=row["title"],
            kind=row["kind"],
            source_path=row["source_path"],
            size_bytes=row["size_bytes"],
            page_count=row["page_count"],
            lang=row["lang"] or "",
            status=row["status"],
            meta=meta,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
