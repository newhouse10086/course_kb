"""Task 模型（契约 §2.6）—— 后台任务 + SSE 进度的数据载体。"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .common import ModelError, as_float, check_enum, clamp01, now_ms

#: ``kind`` 枚举（契约 §2.6）
TASK_KINDS: tuple[str, ...] = (
    "parse",
    "extract",
    "rollup",
    "translate",
    "asr",
    "slides",
    "mindmap",
    "index",
)

#: ``status`` 枚举（契约 §2.6）
TASK_STATUS: tuple[str, ...] = ("queued", "running", "done", "failed", "cancelled")

#: 终态（到达后 SSE 应主动关闭、进度不再变化）
TASK_TERMINAL: tuple[str, ...] = ("done", "failed", "cancelled")


@dataclass
class Task:
    """一个后台任务（DB 表 ``tasks``）。"""

    id: str
    doc_id: str | None
    kind: str
    status: str = "queued"
    progress: float = 0.0
    stage: str = ""
    detail: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    created_at: int = 0
    finished_at: int | None = None

    def __post_init__(self) -> None:
        if not self.id:
            raise ModelError("task.id 不能为空")
        check_enum(self.kind, TASK_KINDS, "task.kind")
        check_enum(self.status, TASK_STATUS, "task.status")
        self.progress = clamp01(self.progress)
        if not self.created_at:
            self.created_at = now_ms()
        if self.status in TASK_TERMINAL and not self.finished_at:
            self.finished_at = now_ms()

    @property
    def is_terminal(self) -> bool:
        return self.status in TASK_TERMINAL

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "doc_id": self.doc_id,
            "kind": self.kind,
            "status": self.status,
            "progress": self.progress,
            "stage": self.stage,
            "detail": dict(self.detail or {}),
            "error": self.error,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
        }

    def to_row(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "doc_id": self.doc_id,
            "kind": self.kind,
            "status": self.status,
            "progress": self.progress,
            "stage": self.stage,
            "detail_json": json.dumps(self.detail or {}, ensure_ascii=False),
            "error": self.error,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
        }

    @classmethod
    def from_row(cls, row: Any) -> "Task":
        raw = row["detail_json"] if "detail_json" in row.keys() else "{}"
        try:
            detail = json.loads(raw or "{}")
        except json.JSONDecodeError:
            detail = {}
        return cls(
            id=row["id"],
            doc_id=row["doc_id"],
            kind=row["kind"],
            status=row["status"],
            progress=as_float(row["progress"]),
            stage=row["stage"] or "",
            detail=detail,
            error=row["error"],
            created_at=row["created_at"],
            finished_at=row["finished_at"],
        )
