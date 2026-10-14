"""S7 幻灯片抽取：ffmpeg 场景切换检测抽帧 → **图片帧** + 时间点。

## ⚠️ 坑 11（必须写在代码里，不能只在文档里）

抽出来的是 **JPEG/PNG 图片帧**，**不是可编辑 PPT**：

* 有 OCR 引擎时 → 出 ``ocr_text``（:func:`ocr_availability` 为真才做）
* 没有 OCR → **只出帧图 + 时间点**，标题标成 :data:`IMAGE_FRAME_LABEL`（"图片帧"）
* **不承诺**还原版式 / 动画 / 可编辑对象

## 本机实测的两个坑（坑 16）

1. ``select`` 一帧都没选中时，ffmpeg **退出码 1** 并报一个**误导性**的
   "mjpeg 编码器打开失败"。→ :func:`detect_frames` 把"0 帧"识别为合法空结果。
2. 写 JPEG 必须显式 ``-pix_fmt yuvj420p``，否则本机 mjpeg 编码器直接开不了。
3. ``-vsync vfr`` 已弃用 → 用 ``-fps_mode vfr``。
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Callable, Sequence

from worker.models.video import SLIDE_KIND_IMAGE, SLIDE_KIND_OCR, VideoSlide

from .errors import FfmpegRunError, MediaProbeError
from .ffmpeg_util import (
    find_ffmpeg,
    probe_media,
    run_ffmpeg_streaming,
    stderr_tail,
)
from .subtitle import enforce_timeline
from .subtitle import Cue

log = logging.getLogger(__name__)

#: 场景切换阈值（F6 关键参数：0.4 是经验值，太低会抽出大量碎帧）
SCENE_THRESHOLD = 0.4
#: 两帧之间至少间隔这么长（去掉翻页动画产生的连续碎帧）
MIN_FRAME_GAP_MS = 1000
#: 默认上限（1 小时视频按 0.4 阈值一般 30~120 帧）
MAX_FRAMES = 200
#: 场景检测一帧没抽到时，退化成等间隔采样的间隔
FALLBACK_INTERVAL_MS = 30_000
#: 无 OCR 时的诚实标注（坑 11）
IMAGE_FRAME_LABEL = "图片帧"

_PTS_RE = re.compile(r"pts_time:([0-9.]+)")
_NOTHING_WRITTEN = "Nothing was written into output file"


@dataclass
class SlideFrame:
    """一帧幻灯图片（**不是**排版对象）。"""

    index: int
    at_ms: int
    image: str
    ocr_text: str = ""
    title: str = ""
    kind: str = SLIDE_KIND_IMAGE
    mode: str = "scene"

    def to_video_slide(self) -> VideoSlide:
        """→ 契约 §2.7 ``VideoSlide``。

        ``kind`` 不进模型（模型没这个字段，T1 冻结的），
        所以无 OCR 时用 ``title=IMAGE_FRAME_LABEL`` 把"这是图片帧"**显式**带进 API，
        UI 一看标题就知道不该期望可编辑内容（坑 11）。
        有 OCR 但没显式标题时（例如从 slides.json 缓存读回），用 OCR 首行当标题。
        """
        title = self.title
        if not title:
            if self.ocr_text:
                title = self.ocr_text.splitlines()[0].strip()[:40]
            else:
                title = IMAGE_FRAME_LABEL
        return VideoSlide(
            index=self.index,
            at_ms=self.at_ms,
            image=self.image,
            ocr_text=self.ocr_text,
            title=title,
        )

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "at_ms": self.at_ms,
            "image": self.image,
            "ocr_text": self.ocr_text,
            "title": self.title,
            "kind": self.kind,
            "mode": self.mode,
        }


# ── OCR（可选能力：没有就只出帧图）────────────────────────────────────
def ocr_availability() -> dict:
    """OCR 能力探测（**如实**；本机没装任何 OCR 引擎 → False）。

    :return: ``{"available": bool, "engine": str, "reason": str}``
    """
    for module, engine in (
        ("pytesseract", "tesseract"),
        ("easyocr", "easyocr"),
        ("paddleocr", "paddleocr"),
        ("rapidocr_onnxruntime", "rapidocr"),
    ):
        try:
            __import__(module)
        except Exception:  # noqa: BLE001
            continue
        if engine == "tesseract":
            import shutil

            if shutil.which("tesseract") is None:
                continue  # python 包在但没装 exe，仍然不可用
        return {
            "available": True,
            "engine": engine,
            "reason": f"OCR 可用（{engine}），会为帧图产出 ocr_text",
        }
    return {
        "available": False,
        "engine": "",
        "reason": (
            "未安装任何 OCR 引擎（pytesseract/easyocr/paddleocr 都没有）→ "
            "幻灯片**只出帧图 + 时间点**，标题标注为“图片帧”，不产出 ocr_text，"
            "也不承诺还原成可编辑 PPT"
        ),
    }


def ocr_image(path: str) -> str:
    """对单帧做 OCR；引擎不可用时返回空串（**不抛异常、不编造文本**）。"""
    cap = ocr_availability()
    if not cap["available"]:
        return ""
    engine = cap["engine"]
    try:
        if engine == "tesseract":
            import pytesseract  # type: ignore
            from PIL import Image  # type: ignore

            with Image.open(path) as img:
                return str(pytesseract.image_to_string(img, lang="chi_sim+eng")).strip()
        if engine == "rapidocr":
            from rapidocr_onnxruntime import RapidOCR  # type: ignore

            result, _ = RapidOCR()(path)
            return "\n".join(line[1] for line in (result or [])).strip()
        if engine == "easyocr":
            import easyocr  # type: ignore

            reader = easyocr.Reader(["ch_sim", "en"])
            return "\n".join(reader.readtext(path, detail=0)).strip()
    except Exception as exc:  # noqa: BLE001 - OCR 失败不该毁掉整条流水线
        log.warning("OCR 失败（%s）：%s", path, exc)
    return ""


# ── 抽帧 ────────────────────────────────────────────────────────────────
def _list_frames(out_dir: str, prefix: str) -> list[str]:
    from glob import glob

    return sorted(glob(os.path.join(out_dir, f"{prefix}_*.jpg")))


def detect_frames(
    video: str,
    out_dir: str,
    *,
    threshold: float = SCENE_THRESHOLD,
    max_frames: int = MAX_FRAMES,
    min_gap_ms: int = MIN_FRAME_GAP_MS,
    duration_ms: int | None = None,
    mode: str = "auto",
    fallback_interval_ms: int = FALLBACK_INTERVAL_MS,
    prefix: str = "slide",
    ffmpeg: str | None = None,
    on_progress: Callable[[float, str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> list[SlideFrame]:
    """场景切换检测抽帧。

    :param mode: ``scene`` 只做场景检测 / ``interval`` 只做等间隔 /
        ``auto``（默认）先场景检测，**一帧都没有**时退化等间隔采样
        （纯口播视频没有画面切换，等间隔至少给你一张"讲到这里"的图；
        但 ``mode`` 会如实标成 ``interval``，不冒充"检测到的幻灯片翻页"）
    :raises MediaProbeError: 文件不是媒体 / 没有视频流
    """
    if mode not in ("auto", "scene", "interval"):
        raise ValueError(f"mode 只能是 auto/scene/interval，收到 {mode!r}")
    exe = find_ffmpeg() if ffmpeg is None else ffmpeg
    if duration_ms is None:
        info = probe_media(video, ffmpeg=exe)
        if not info.has_video:
            raise MediaProbeError(
                f"文件没有视频流，无法抽帧：{os.path.basename(video)}",
                code="E_NO_VIDEO",
            )
        duration_ms = info.duration_ms
    os.makedirs(out_dir, exist_ok=True)

    frames: list[SlideFrame] = []
    if mode in ("scene", "auto"):
        frames = _extract_checked(
            video,
            out_dir,
            prefix=prefix,
            vf=f"select='gt(scene,{threshold})',showinfo",
            exe=exe,
            duration_ms=duration_ms,
            on_progress=on_progress,
            should_cancel=should_cancel,
            frame_mode="scene",
            stage=f"场景检测抽帧(阈值{threshold})",
        )
    if not frames and mode in ("auto", "interval") and duration_ms and duration_ms > 0:
        every = max(1000, min(fallback_interval_ms, max(1000, duration_ms)))
        frames = _extract_checked(
            video,
            out_dir,
            prefix=prefix,
            vf=f"fps=1000/{every},showinfo",
            exe=exe,
            duration_ms=duration_ms,
            on_progress=on_progress,
            should_cancel=should_cancel,
            frame_mode="interval",
            stage="等间隔抽帧",
        )
    if not frames:
        # 一帧都没抽到：先确认"到底有没有视频流"再下结论。
        # ⚠️ 调用方传了 duration_ms 时我们不会先探测，所以这里必须补一次探测——
        # 否则给一个 WAV 传进来会**静默返回空列表**，把"这不是视频"说成"没有场景切换"。
        if not probe_media(video, ffmpeg=exe).has_video:
            raise MediaProbeError(
                f"文件没有视频流，无法抽帧：{os.path.basename(video)}", code="E_NO_VIDEO"
            )
        # 有视频流但没抽到帧：**如实返回空**（坑 11：不编造幻灯片刻表）
        return []

    frames = dedupe_frames(frames, min_gap_ms=min_gap_ms)
    if max_frames > 0 and len(frames) > max_frames:
        log.info("抽到 %d 帧，按上限截到 %d 帧", len(frames), max_frames)
        frames = frames[:max_frames]
    # 时间轴收口（与字幕同一套不变量：单调、不越界）
    cues = enforce_timeline(
        [Cue(start=f.at_ms, end=min(f.at_ms + 1, duration_ms or f.at_ms + 1), text=str(f.index))
         for f in frames],
        duration_ms=duration_ms,
        min_cue_ms=1,
    )
    times = [c.start for c in cues]
    for i, frame in enumerate(frames):
        frame.index = i + 1
        if i < len(times):
            frame.at_ms = times[i]
    return frames


def _extract_checked(
    video: str,
    out_dir: str,
    *,
    prefix: str,
    vf: str,
    exe: str,
    duration_ms: int,
    on_progress: Callable[[float, str], None] | None,
    should_cancel: Callable[[], bool] | None,
    frame_mode: str,
    stage: str,
) -> list[SlideFrame]:
    """:func:`_extract` + **区分"0 帧"与"真出错"**。

    坑 16：``select`` 一帧没选中时 ffmpeg 退出码非 0（本机实测 ``-22``）并报
    "mjpeg 编码器打开失败"这种误导性错误；此时**不该**抛异常，而应交给调用方
    用媒体探测去判断"根本没有视频流"还是"没有场景切换"。
    """
    frames, rc, stderr = _extract(
        video,
        out_dir,
        prefix=prefix,
        vf=vf,
        exe=exe,
        duration_ms=duration_ms,
        on_progress=on_progress,
        should_cancel=should_cancel,
        frame_mode=frame_mode,
        stage=stage,
    )
    if frames:
        return frames
    if rc != 0 and _NOTHING_WRITTEN not in stderr and "Invalid argument" not in stderr:
        raise FfmpegRunError(
            f"抽帧失败（退出码 {rc}）", cmd=[exe, video], stderr=stderr_tail(stderr)
        )
    log.info("抽帧结果为空（rc=%d，合法：无场景切换或无视频流）", rc)
    return []


def _extract(
    video: str,
    out_dir: str,
    *,
    prefix: str,
    vf: str,
    exe: str,
    duration_ms: int,
    on_progress: Callable[[float, str], None] | None,
    should_cancel: Callable[[], bool] | None,
    frame_mode: str,
    stage: str,
) -> tuple[list[SlideFrame], int, str]:
    """跑一次 ffmpeg 抽帧并按 ``showinfo`` 的 ``pts_time`` 配时间点。

    :return: ``(帧列表, ffmpeg 退出码, stderr)`` —— **0 帧是合法结果**，
        退出码与 stderr 一并返回给 :func:`_extract_checked` 判断。
    """
    from .errors import JobCancelled

    pattern = os.path.join(out_dir, f"{prefix}_%05d.jpg")
    for old in _list_frames(out_dir, prefix):
        os.remove(old)  # 重跑不留上次的残留，避免时间点错配
    args = [
        "-y",
        "-i",
        video,
        "-vf",
        vf,
        "-fps_mode",
        "vfr",
        "-pix_fmt",
        "yuvj420p",
        "-q:v",
        "3",
        pattern,
    ]
    rc, stderr = run_ffmpeg_streaming(
        args,
        total_ms=duration_ms,
        on_progress=on_progress,
        stage=stage,
        ffmpeg=exe,
        should_cancel=should_cancel,
        cancel_exc=JobCancelled,
    )
    files = _list_frames(out_dir, prefix)
    if not files:
        return [], rc, stderr
    times = [int(round(float(m) * 1000)) for m in _PTS_RE.findall(stderr)]
    if len(times) != len(files):
        raise FfmpegRunError(
            f"抽帧时间点与图片数不匹配（图 {len(files)} 张，时间点 {len(times)} 个）",
            cmd=[exe, *args],
            stderr=stderr_tail(stderr),
        )
    out: list[SlideFrame] = []
    for i, (path, ms) in enumerate(zip(files, times), start=1):
        out.append(
            SlideFrame(
                index=i,
                at_ms=max(0, ms),
                image=path,
                kind=SLIDE_KIND_IMAGE,
                mode=frame_mode,
            )
        )
    return out, rc, stderr


def dedupe_frames(
    frames: Sequence[SlideFrame], *, min_gap_ms: int = MIN_FRAME_GAP_MS
) -> list[SlideFrame]:
    """去掉间隔过近的帧（保留最早的那张）。"""
    out: list[SlideFrame] = []
    for frame in sorted(frames, key=lambda f: f.at_ms):
        if out and frame.at_ms - out[-1].at_ms < min_gap_ms:
            continue
        out.append(frame)
    for i, frame in enumerate(out, start=1):
        frame.index = i
    return out


def attach_ocr(frames: Sequence[SlideFrame]) -> int:
    """给帧图补 ``ocr_text``；**没有 OCR 就什么也不做**并返回 0（坑 11）。

    :return: 成功识别出文字的帧数
    """
    cap = ocr_availability()
    if not cap["available"]:
        log.info("无 OCR 引擎，仅输出帧图与时间点：%s", cap["reason"])
        return 0
    hits = 0
    for frame in frames:
        text = ocr_image(frame.image)
        frame.ocr_text = text
        if text:
            hits += 1
            frame.kind = SLIDE_KIND_OCR
            first_line = text.splitlines()[0].strip()
            frame.title = first_line[:40]
    return hits


__all__ = [
    "SlideFrame",
    "SCENE_THRESHOLD",
    "MIN_FRAME_GAP_MS",
    "MAX_FRAMES",
    "FALLBACK_INTERVAL_MS",
    "IMAGE_FRAME_LABEL",
    "detect_frames",
    "dedupe_frames",
    "attach_ocr",
    "ocr_availability",
    "ocr_image",
]
