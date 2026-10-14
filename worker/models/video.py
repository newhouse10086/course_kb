"""VideoArtifact 模型（契约 §2.7）—— 视频产物。

⚠️ 本文件是**数据模型**（models 层，T1 写域）；视频**管线实现**在 ``server/video/**``（T2 写域）。
T2 负责往这张表里写数据，模型形态以契约 §2.7 为准。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .common import ModelError, as_float, as_int, clamp01

#: 幻灯帧的诚实标注（坑 11：不把"帧图"过度承诺成"可编辑 PPT"）
SLIDE_KIND_IMAGE = "image_frame"
SLIDE_KIND_OCR = "ocr_text"


@dataclass
class VideoSegment:
    """ASR 段落（字级时间戳汇成段级）。"""

    i: int
    start: int  # ms
    end: int  # ms
    text: str
    confidence: float = 0.0

    def __post_init__(self) -> None:
        self.i = as_int(self.i)
        self.start = max(0, as_int(self.start))
        self.end = max(self.start, as_int(self.end))
        self.confidence = clamp01(self.confidence)

    def to_dict(self) -> dict[str, Any]:
        return {
            "i": self.i,
            "start": self.start,
            "end": self.end,
            "text": self.text,
            "confidence": self.confidence,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "VideoSegment":
        return cls(
            i=d.get("i", 0),
            start=d.get("start", 0),
            end=d.get("end", 0),
            text=d.get("text", ""),
            confidence=as_float(d.get("confidence")),
        )


@dataclass
class TranscriptChapter:
    """文稿分章（契约 §2.7 transcript[]）。"""

    title: str
    start: int
    end: int
    text: str = ""
    summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "start": self.start,
            "end": self.end,
            "text": self.text,
            "summary": self.summary,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "TranscriptChapter":
        return cls(
            title=d.get("title", ""),
            start=as_int(d.get("start")),
            end=as_int(d.get("end")),
            text=d.get("text", ""),
            summary=d.get("summary", ""),
        )


@dataclass
class VideoSlide:
    """视频内幻灯片**帧图**（不是可编辑 PPT）。"""

    index: int
    at_ms: int
    image: str
    ocr_text: str = ""
    title: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "at_ms": self.at_ms,
            "image": self.image,
            "ocr_text": self.ocr_text,
            "title": self.title,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "VideoSlide":
        return cls(
            index=as_int(d.get("index")),
            at_ms=as_int(d.get("at_ms")),
            image=d.get("image", ""),
            ocr_text=d.get("ocr_text", ""),
            title=d.get("title", ""),
        )


@dataclass
class VideoArtifact:
    """一份视频的全部产物（DB 表 ``video_artifacts``，doc_id 为主键）。"""

    doc_id: str
    id: str = ""
    duration_ms: int = 0
    asr_model: str = ""
    asr_lang: str = ""
    segments: list[VideoSegment] = field(default_factory=list)
    subtitle_srt: str = ""
    subtitle_vtt: str = ""
    transcript: list[TranscriptChapter] = field(default_factory=list)
    mindmap_format: str = ""
    mindmap_content: str = ""
    slides: list[VideoSlide] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.doc_id:
            raise ModelError("video_artifact.doc_id 不能为空")
        self.duration_ms = max(0, as_int(self.duration_ms))
        if not self.id:
            # 确定性 ID（从 doc_id 派生），否则每次读库都会变
            tail = self.doc_id.split("_", 1)[-1][-12:] or "000000000000"
            self.id = f"vid_{tail}"

    # ── API 形态（契约 §2.7）─────────────────────────────────────────
    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "doc_id": self.doc_id,
            "duration_ms": self.duration_ms,
            "asr_model": self.asr_model,
            "asr_lang": self.asr_lang,
            "segments": [s.to_dict() for s in self.segments],
            "subtitles": {"srt": self.subtitle_srt, "vtt": self.subtitle_vtt},
            "transcript": [t.to_dict() for t in self.transcript],
            "mindmap": {"format": self.mindmap_format, "content": self.mindmap_content},
            "slides": [s.to_dict() for s in self.slides],
        }

    def to_row(self) -> dict[str, Any]:
        return {
            "doc_id": self.doc_id,
            "duration_ms": self.duration_ms,
            "asr_model": self.asr_model,
            "asr_lang": self.asr_lang,
            "segments_json": json.dumps(
                [s.to_dict() for s in self.segments], ensure_ascii=False
            ),
            "subtitle_srt": self.subtitle_srt,
            "subtitle_vtt": self.subtitle_vtt,
            "transcript_json": json.dumps(
                [t.to_dict() for t in self.transcript], ensure_ascii=False
            ),
            "mindmap_format": self.mindmap_format,
            "mindmap_content": self.mindmap_content,
            "slides_json": json.dumps(
                [s.to_dict() for s in self.slides], ensure_ascii=False
            ),
        }

    @classmethod
    def from_row(cls, row: Any) -> "VideoArtifact":
        def _load(key: str) -> list[dict[str, Any]]:
            raw = row[key] if key in row.keys() else "[]"
            try:
                val = json.loads(raw or "[]")
            except json.JSONDecodeError:
                return []
            return val if isinstance(val, list) else []

        return cls(
            doc_id=row["doc_id"],
            duration_ms=as_int(row["duration_ms"]),
            asr_model=row["asr_model"] or "",
            asr_lang=row["asr_lang"] or "",
            segments=[VideoSegment.from_dict(d) for d in _load("segments_json")],
            subtitle_srt=row["subtitle_srt"] or "",
            subtitle_vtt=row["subtitle_vtt"] or "",
            transcript=[TranscriptChapter.from_dict(d) for d in _load("transcript_json")],
            mindmap_format=row["mindmap_format"] or "",
            mindmap_content=row["mindmap_content"] or "",
            slides=[VideoSlide.from_dict(d) for d in _load("slides_json")],
        )
