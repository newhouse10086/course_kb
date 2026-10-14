"""视频任务作业：把 :mod:`worker.video.runner` 接到 T1 的 ``TaskRunner`` 上。

T1 的 ``POST /api/v1/documents/{id}/video/reparse`` 会 ``runner.submit("asr", doc_id)``，
所以**必须有人注册名为 ``"asr"`` 的作业**，否则该端点返回 503
（``ASR 管线尚未交付``）。这就是那个注册点。

接线方式（T1 的 ``server/pipeline/runner.py::build_runner`` 里加一行）::

    from worker.video.tasks import register_video_tasks
    register_video_tasks(runner, settings=settings, llm=llm)

本模块**不导入 T1 的 pipeline 包**（避免循环依赖），只依赖 ``TaskContext`` 的鸭子类型
（``.task.doc_id`` / ``.repo`` / ``.update`` / ``.progress_fn`` / ``.artifact`` / ``.cancelled``）。

## 进度与取消

* ``ctx.progress_fn(base, span, label)`` 把流水线自带的 0~1 进度映射进任务进度条
  （流水线的进度**已保证单调不减**，所以 SSE 进度条不会倒退）
* ``should_cancel=lambda: ctx.cancelled``：用户在 UI 点取消 → 流水线在**块边界**停下
  并**落盘断点**，任务标 cancelled；用户再点重跑 → 从断点继续
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from worker.video import runner as runner_mod
from worker.video.errors import JobCancelled, VideoError

log = logging.getLogger(__name__)

#: 注册用的任务类型名（必须与 main.py 里的 ``runner.submit("asr", ...)`` 一致）
TASK_KIND = "asr"


def job_asr(
    ctx: Any,
    *,
    settings: Any = None,
    options: runner_mod.VideoOptions | None = None,
    llm: Callable[[str, dict], dict] | None = None,
    transcribe_fn: Any = None,
) -> dict[str, Any]:
    """视频解析任务（S1 抽音频 → S7 抽帧），产物写 ``video_artifacts``。

    :raises JobCancelled: 用户取消（→ 任务 ``cancelled``，断点保留）
    :raises VideoError: 视频层失败（ffmpeg 缺失/媒体损坏），由 TaskRunner 记 failed
    """
    doc_id = getattr(getattr(ctx, "task", None), "doc_id", None)
    repo = ctx.repo
    doc = repo.get_document(doc_id) if doc_id else None
    if doc is None:
        raise VideoError(f"文档不存在：{doc_id}")

    repo.update_document(doc_id, status="parsing")
    ctx.update(0.0, "视频：探测媒体")

    work_dir = runner_mod.default_work_dir(
        doc_id, getattr(settings, "artifact_dir", None)
    )
    adapter = _adapter(doc_id, doc, work_dir, settings, options, llm)
    ctx.log(f"视频解析开始：{doc.source_path}（工作目录 {work_dir}）")

    outcome = adapter.run(
        doc.source_path,
        doc_id,
        on_progress=ctx.progress_fn(0.0, 0.97, "视频："),
        should_cancel=lambda: bool(getattr(ctx, "cancelled", False)),
        transcribe_fn=transcribe_fn,
    )

    # 产物入库（契约 §2.7）
    repo.upsert_video_artifact(outcome.artifact)
    ctx.log(
        f"产物入库：段落 {len(outcome.artifact.segments)}、"
        f"分章 {len(outcome.artifact.transcript)}（来源 {outcome.transcript_source}）、"
        f"帧 {len(outcome.artifact.slides)}"
    )

    # 按契约 §5.5 广播产物 URL（SSE ``artifact`` 事件）
    if outcome.artifact.subtitle_srt:
        for fmt in ("srt", "vtt"):
            ctx.artifact(
                "subtitle",
                f"/api/v1/documents/{doc_id}/video/subtitle?fmt={fmt}",
            )
    if outcome.artifact.transcript:
        ctx.artifact("transcript", f"/api/v1/documents/{doc_id}/video/transcript")
    if outcome.artifact.mindmap_content:
        ctx.artifact("mindmap", f"/api/v1/documents/{doc_id}/video/mindmap")
    if outcome.artifact.slides:
        ctx.artifact("slides", f"/api/v1/documents/{doc_id}/video/slides")
    ctx.artifact("video", f"/api/v1/documents/{doc_id}/video")

    # 文档状态：能播放就算 ready（即使 ASR 不可用，仍可播放 + 看帧 + 手动传字幕）
    meta = dict(doc.meta or {})
    meta["video"] = {
        "duration_ms": outcome.artifact.duration_ms,
        "asr_available": outcome.asr_available,
        "asr_reason": outcome.asr_reason,
        "transcript_source": outcome.transcript_source,
        "mindmap_source": outcome.mindmap_source,
        "ocr_available": outcome.ocr_available,
        "slides": len(outcome.artifact.slides),
        "degraded": outcome.degraded,
        "work_dir": runner_mod.rel_path(outcome.work_dir),
        "slide_kind": "image_frame",
        "slide_note": "视频内 PPT 抽出的是图片帧（JPEG）+ 时间点，不是可编辑 PPT",
    }
    repo.update_document(
        doc_id,
        status="ready",
        lang=outcome.artifact.asr_lang or None,
        meta=meta,
    )
    ctx.update(1.0, "视频解析完成")
    return {
        "kind": "video",
        "duration_ms": outcome.artifact.duration_ms,
        "asr_available": outcome.asr_available,
        "asr_reason": outcome.asr_reason,
        "asr_model": outcome.artifact.asr_model,
        "asr_lang": outcome.artifact.asr_lang,
        "segments": len(outcome.artifact.segments),
        "chapters": len(outcome.artifact.transcript),
        "transcript_source": outcome.transcript_source,
        "mindmap_source": outcome.mindmap_source,
        "mindmap_chars": len(outcome.artifact.mindmap_content),
        "slides": len(outcome.artifact.slides),
        "ocr_available": outcome.ocr_available,
        # ★ 坑 10/11：降级原因必须原样透传给 UI，不许只留一句"成功"
        "degraded": outcome.degraded,
        "elapsed_ms": outcome.elapsed_ms,
    }


def _adapter(
    doc_id: str,
    doc: Any,
    work_dir: str,
    settings: Any,
    options: runner_mod.VideoOptions | None,
    llm: Callable[[str, dict], dict] | None,
):
    from worker.adapters.video import VideoAdapter

    return VideoAdapter(
        doc_id=doc_id,
        work_dir=work_dir,
        options=options or runner_mod.VideoOptions(),
        llm=llm,
        settings=settings,
        title=getattr(doc, "title", "") or "",
    )


def register_video_tasks(
    runner: Any,
    *,
    settings: Any = None,
    options: runner_mod.VideoOptions | None = None,
    llm: Callable[[str, dict], dict] | None = None,
) -> None:
    """把视频作业注册进 T1 的 ``TaskRunner``（注册名 ``"asr"``）。"""
    runner.register(
        TASK_KIND,
        lambda ctx: job_asr(ctx, settings=settings, options=options, llm=llm),
    )


__all__ = ["TASK_KIND", "job_asr", "register_video_tasks"]
