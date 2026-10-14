"""``VideoAdapter`` —— 视频/音频 → :class:`DocDraft`（契约 §4 + §2.2 span.kind=time）。

## 这个 adapter 做什么

:meth:`VideoAdapter.parse` 跑完整条视频流水线（``server/video/runner.py``），
把产物切成**三层** unit：

```
level 1  全片（span = [0, duration_ms]）
└─ level 2  章节（来自 LLM 分章 / 机械分节；span = 章的时间区间）
   └─ level 3  段块（每 ~120 秒或 ~1200 字一块，真正的检索粒度）
```

ASR 不可用时（坑 10）**仍然**切出可导航的结构：
level 1 全片 + level 2 时间轴分段（空文字，标题如实写「无文字稿」）
或幻灯片帧（图片帧 + 时间点），**不编造任何文字**。

## 给 T1 的两个入口

1. :meth:`VideoAdapter.run` —— **推荐**：一次拿到 ``PipelineOutcome``，
   里面的 ``artifact`` 直接 ``repo.upsert_video_artifact()``
2. :meth:`VideoAdapter.parse` —— 契约要求的方法，返回 ``DocDraft``（内部同样跑流水线）

``parse()`` 里跑的流水线结果会存在 ``self.last_outcome``；
但**更可靠**的是读流水线落盘的 ``<work_dir>/outcome.json``
（:meth:`VideoAdapter.load_outcome`），进程重启后也能拿回产物。

## 单位

视频统一用**毫秒**（契约 §2.2 ``span.kind=time``）；``documents.page_count`` 对视频无意义，
保持 0，时长放 ``meta.duration_ms``。
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Callable, Sequence

from worker.adapters.base import (
    DocDraft,
    DocumentAdapter,
    ParseError,
    ProgressFn,
    UnitDraft,
    report,
)
from worker.adapters.registry import register
from worker.models.common import Span
from worker.models.video import SLIDE_KIND_IMAGE, VideoSegment

from worker.video import runner as video_runner
from worker.video.audio import read_wav_header  # noqa: F401  (导出给测试用)
from worker.video.errors import VideoError
from worker.video.ffmpeg_util import MediaProbeError, probe_media

log = logging.getLogger(__name__)

#: 视频的 level 3 段块：每块最多这么多毫秒
UNIT_BLOCK_MS = 120_000
#: 视频的 level 3 段块：每块最多这么多字
UNIT_BLOCK_CHARS = 1200
#: 无文字稿时的时间轴分段长度（1 小时视频 → 60 个导航锚点）
TIMELINE_ANCHOR_MS = 60_000
#: 小标题里的时间格式
def _ts(ms: int) -> str:
    s = max(0, int(ms)) // 1000
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


#: 魔数 → 是否像视频/音频容器（改名的文件也要能认出来）
_MAGIC_PROBES: tuple[tuple[bytes, int, str], ...] = (
    (b"ftyp", 4, "mp4/mov"),
    (b"\x1a\x45\xdf\xa3", 0, "matroska/webm"),
    (b"FLV", 0, "flv"),
    (b"ID3", 0, "mp3"),
)

_VIDEO_EXTS = (
    ".mp4",
    ".mkv",
    ".mov",
    ".webm",
    ".avi",
    ".flv",
    ".m4v",
    ".ts",
    ".wmv",
    ".mpg",
    ".mpeg",
)
_AUDIO_EXTS = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".wma")


@register
class VideoAdapter(DocumentAdapter):
    """视频网课 adapter（``kind="video"``，契约 §2.1 枚举内）。"""

    kind = "video"
    extensions = _VIDEO_EXTS + _AUDIO_EXTS

    def __init__(
        self,
        doc_id: str | None = None,
        *,
        work_dir: str | None = None,
        artifact_dir: str | Path | None = None,
        options: video_runner.VideoOptions | None = None,
        llm: Callable[[str, dict], dict] | None = None,
        settings: Any = None,
        title: str = "",
    ):
        self.doc_id = doc_id
        self.work_dir = work_dir
        self.artifact_dir = artifact_dir
        self.options = options or video_runner.VideoOptions()
        self.llm = llm
        self.settings = settings
        self.title = title
        #: 最近一次流水线结果（``parse()`` 也会填）
        self.last_outcome: video_runner.PipelineOutcome | None = None
        self.last_draft: DocDraft | None = None

    # ── 契约：能不能处理 ────────────────────────────────────────────
    def can_handle(self, path: str) -> bool:
        """扩展名优先，再看魔数。**绝不抛异常**（registry.pick 依赖这一点）。"""
        try:
            p = Path(str(path))
            if p.suffix.lower() in self.extensions:
                return True
            if not p.is_file():
                return False
            with p.open("rb") as fh:
                head = fh.read(16)
        except OSError:
            return False
        if not head:
            return False
        for magic, offset, _name in _MAGIC_PROBES:
            if head[offset : offset + len(magic)] == magic:
                return True
        if head[:4] == b"RIFF":
            form = head[8:12]
            if form in (b"WAVE", b"AVI "):
                return True
        if head[0] == 0x47 and len(head) > 1 and head[1] == 0x40:
            return True  # MPEG-TS
        return False

    # ── 契约：探测（上传时估时长）────────────────────────────────────
    def probe(self, path: str) -> dict:
        """轻量探测（只读 ffmpeg 头，不解码）。失败时返回 ``{}`` 而不是抛异常。"""
        try:
            info = probe_media(path)
        except VideoError as exc:
            log.info("probe 失败（%s）：%s", path, exc.message)
            return {}
        out = info.to_dict()
        out["kind"] = self.kind
        out["is_audio_only"] = not info.has_video
        out["asr"] = _asr_capability_safe()
        return out

    # ── 主入口（T1 推荐用这个）───────────────────────────────────────
    def run(
        self,
        path: str,
        doc_id: str | None = None,
        *,
        on_progress: ProgressFn | None = None,
        should_cancel: Callable[[], bool] | None = None,
        transcribe_fn: Any = None,
    ) -> video_runner.PipelineOutcome:
        """跑流水线，返回 ``PipelineOutcome``（含可入库的 ``VideoArtifact``）。"""
        doc = doc_id or self.doc_id or _derive_doc_id(path)
        work = self.work_dir or video_runner.default_work_dir(doc, self.artifact_dir)
        # 进度必须是**单调不减**的（AGENTS.md §7）：所以这里只报 0.0，
        # 之后全部交给 run_pipeline 自己的加权进度表；**不要**在流水线返回后再补报
        # 一个更小的值（曾经在结尾报 0.99，把已经到 1.0 的进度条拉回去了）。
        report(on_progress, 0.0, "视频：探测媒体")
        try:
            outcome = video_runner.run_pipeline(
                path,
                doc,
                work_dir=work,
                options=self.options,
                llm=self.llm,
                settings=self.settings,
                title=self.title or Path(path).stem,
                transcribe_fn=transcribe_fn,
                on_progress=on_progress,
                should_cancel=should_cancel,
            )
        except video_runner.JobCancelled:
            raise  # 取消不是失败：断点保留，交给上层标 cancelled
        except video_runner.VideoError as exc:
            raise ParseError(f"视频解析失败：{exc.message}（{exc.detail}）") from exc
        self.last_outcome = outcome
        self.work_dir = work
        _write_outcome(work, outcome)
        return outcome

    # ── 契约：解析 → DocDraft ───────────────────────────────────────
    def parse(self, path: str, *, on_progress: ProgressFn | None = None) -> DocDraft:
        """契约 §4：视频 → 三层 unit（span.kind 一律 ``"time"``，单位毫秒）。"""
        outcome = self.run(path, on_progress=on_progress)
        draft = self.draft_from_outcome(outcome, source_path=path)
        draft.validate()  # 悬空 parent_ord / 重复 ord / span 越界 → 当场报错
        self.last_draft = draft
        return draft

    # ── 产物 → DocDraft ────────────────────────────────────────────
    def draft_from_outcome(
        self, outcome: video_runner.PipelineOutcome, *, source_path: str = ""
    ) -> DocDraft:
        """把流水线产物切成层次化 unit（纯函数，便于测试）。"""
        art = outcome.artifact
        duration = max(0, int(art.duration_ms))
        title = self.title or _title_from_path(source_path) or "视频"
        units: list[UnitDraft] = []
        ordn = 1

        has_text = bool(art.transcript) or bool(art.segments)
        root_text = ""
        if art.transcript and art.transcript[0].text:
            root_text = art.transcript[0].text[:2000]
        root = UnitDraft(
            ord=ordn,
            title=f"{title}（{_ts(duration)}）" if duration else title,
            level=1,
            span=Span("time", 0, duration),
            text=root_text,
            parent_ord=None,
        )
        units.append(root)
        ordn += 1

        if art.transcript:
            for ch in art.transcript:
                cu = UnitDraft(
                    ord=ordn,
                    title=ch.title or f"章节 {ordn - 1}",
                    level=2,
                    span=Span("time", int(ch.start), max(int(ch.start), int(ch.end))),
                    text=ch.text or ch.summary or "",
                    parent_ord=root.ord,
                )
                units.append(cu)
                ordn += 1
                for block in _split_blocks(ch.text, ch.start, ch.end):
                    units.append(
                        UnitDraft(
                            ord=ordn,
                            title=f"{_ts(block['start'])}–{_ts(block['end'])}",
                            level=3,
                            span=Span("time", block["start"], block["end"]),
                            text=block["text"],
                            parent_ord=cu.ord,
                        )
                    )
                    ordn += 1
        else:
            # ASR 不可用：只切"可导航结构"，**不编造文字**（坑 10）
            anchors: list[SlideFrameTuple] = []
            for slide in art.slides:
                anchors.append(
                    (
                        slide.title or ("图片帧" if not slide.ocr_text else ""),
                        int(slide.at_ms),
                        slide.ocr_text or "",
                    )
                )
            if not anchors:
                span_ms = max(TIMELINE_ANCHOR_MS, 1)
                at = 0
                while at < max(duration, span_ms):
                    end = min(at + span_ms, duration) if duration else at + span_ms
                    anchors.append((f"{_ts(at)}–{_ts(end)}（无文字稿）", at, ""))
                    at = end
            for an_title, at_ms, text in anchors:
                end_ms = max(at_ms, min(duration or at_ms, at_ms + 1))
                units.append(
                    UnitDraft(
                        ord=ordn,
                        title=an_title or "图片帧",
                        level=2,
                        span=Span("time", at_ms, end_ms),
                        text=text,
                        parent_ord=root.ord,
                    )
                )
                ordn += 1

        meta = {
            "duration_ms": duration,
            "asr": {
                "available": outcome.asr_available,
                "model": art.asr_model,
                "lang": art.asr_lang,
                "reason": outcome.asr_reason,
            },
            "text_model": {
                "available": outcome.llm_available,
                "reason": outcome.llm_reason,
            },
            "ocr": {"available": outcome.ocr_available},
            "transcript": {
                "source": outcome.transcript_source,
                "chapters": len(art.transcript),
                "summary_chars": sum(len(c.summary) for c in art.transcript),
            },
            "mindmap": {"source": outcome.mindmap_source, "chars": len(art.mindmap_content)},
            "subtitles": {
                # ⚠️ `VideoArtifact.subtitle_srt/vtt` 里存的是**内容**（T1 的
                # `/video/subtitle` 直接把它当响应体返回）；文件路径在 stages 里。
                "srt_chars": len(art.subtitle_srt),
                "vtt_chars": len(art.subtitle_vtt),
                "srt_path": (outcome.stages.get("subtitle") or {}).get("srt_path", ""),
                "vtt_path": (outcome.stages.get("subtitle") or {}).get("vtt_path", ""),
                "segments": len(art.segments),
            },
            "slides": {
                "count": len(art.slides),
                "kind": SLIDE_KIND_IMAGE,
                "note": "视频内 PPT 抽出的是**图片帧**（JPEG）与时间点，不是可编辑 PPT",
            },
            "media": outcome.media,
            "degraded": list(outcome.degraded),
            "has_text": has_text,
            "work_dir": video_runner.rel_path(outcome.work_dir) if outcome.work_dir else "",
            "elapsed_ms": outcome.elapsed_ms,
        }
        return DocDraft(
            title=title,
            kind=self.kind,
            units=units,
            meta=meta,
            page_count=0,  # 视频没有"页"，时长在 meta.duration_ms
            lang=art.asr_lang or "",
        )

    @staticmethod
    def load_outcome(work_dir: str | Path) -> dict | None:
        """从 ``<work_dir>/outcome.json`` 读回产物（进程重启后也能取）。"""
        p = Path(work_dir) / "outcome.json"
        try:
            with p.open(encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else None
        except (OSError, json.JSONDecodeError):
            return None


#: ``(标题, 起始毫秒, 文本)``
SlideFrameTuple = tuple[str, int, str]


def _split_blocks(
    text: str, start_ms: int, end_ms: int
) -> list[dict[str, Any]]:
    """章内再切块（level 3）：按 ``UNIT_BLOCK_CHARS`` 或 ``UNIT_BLOCK_MS`` 切。

    检索粒度：一章可能 5000 字，整章当一个 unit 会让卡片抽取吃不下（坑 5 同源）。
    """
    text = (text or "").strip()
    total = max(0, int(end_ms) - int(start_ms))
    if not text:
        return []
    chunks: list[str] = []
    for para in text.split("\n"):
        para = para.strip()
        if not para:
            continue
        while len(para) > UNIT_BLOCK_CHARS:
            chunks.append(para[:UNIT_BLOCK_CHARS])
            para = para[UNIT_BLOCK_CHARS:]
        if para:
            chunks.append(para)
    if not chunks:
        chunks = [text]
    if total <= UNIT_BLOCK_MS and len(chunks) <= 1:
        return []  # 章本来就短：不再下钻，避免无意义的 level 3
    n = len(chunks)
    span_each = max(1, total // n)
    out: list[dict[str, Any]] = []
    for i, chunk in enumerate(chunks):
        s = int(start_ms) + i * span_each
        e = int(end_ms) if i == n - 1 else min(int(end_ms), s + span_each)
        out.append({"start": max(int(start_ms), s), "end": max(s, e), "text": chunk})
    return out


def _write_outcome(work_dir: str, outcome: video_runner.PipelineOutcome) -> None:
    os.makedirs(work_dir, exist_ok=True)
    path = os.path.join(work_dir, "outcome.json")
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(outcome.to_dict(), fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)  # 原子替换：中断不留半截 JSON


def _asr_capability_safe() -> dict:
    try:
        return video_runner.asr_mod.asr_capability()
    except Exception as exc:  # noqa: BLE001 - 能力探测失败不能让 probe 崩掉
        return {"available": False, "reason": f"能力探测失败：{exc}"}


def _derive_doc_id(path: str) -> str:
    """没有 doc_id 时派生一个稳定的（同一文件 → 同一 doc_id，断点才能复用）。"""
    import hashlib

    h = hashlib.sha1(str(Path(path).resolve()).encode("utf-8")).hexdigest()[:12]
    return f"doc_{h}"


def _title_from_path(path: str) -> str:
    return Path(path).stem.strip() if path else ""


__all__ = ["VideoAdapter"]
