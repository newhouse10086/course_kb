"""ffmpeg 封装：定位可执行文件 / 探测媒体信息 / 带进度执行。

## ⚠️ 本机实测（2026-10-14，坑 16）

1. **只有 ``ffmpeg.exe``，没有 ``ffprobe.exe``**（``C:\\tools\\ffmpeg\\`` 下只有一个文件）。
   → 媒体信息一律解析 ``ffmpeg -i <file>`` 的 **stderr 头**，不要调 ffprobe。
2. **``select`` 过滤后一帧都没选中时，ffmpeg 会以退出码 1 失败**，
   并且报一个**误导性**的错误：
   ``[mjpeg @ ...] Non full-range YUV is non-standard ... Error while opening encoder``
   → 这不是编码器参数问题，是"没有帧"。必须把"0 帧"识别为**合法空结果**，
     否则真实视频里"没有场景切换"会被当成崩溃。
3. 抽帧写 JPEG 时必须显式 ``-pix_fmt yuvj420p``（或在 select 前加 ``-strict unofficial``），
   否则本机这套 ffmpeg 的 mjpeg 编码器对 limited-range yuv420p 直接开不了。
4. ``-vsync vfr`` 已被弃用，用 **``-fps_mode vfr``**（本机 N-124868 实测可用）。

## 进度

用 ``-progress pipe:1`` 读 ``out_time=HH:MM:SS.ffffff``（**不要用 ``out_time_ms``**：
ffmpeg 这个字段的实际单位是微秒，名字是历史遗留的坑）。
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Callable, Iterable, Sequence

from .errors import FfmpegRunError, FfmpegUnavailable, MediaProbeError

#: 本机实测路径（找不到时回退 PATH）
_KNOWN_FFMPEG_DIRS = (r"C:\tools\ffmpeg", r"C:\ffmpeg\bin")

_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)")
_STREAM_RE = re.compile(r"Stream #\d+:\d+.*?: (Video|Audio): ")
_VIDEO_SIZE_RE = re.compile(r"(\d{2,5})x(\d{2,5})")
_FPS_RE = re.compile(r"(\d+(?:\.\d+)?)\s*fps")
_AUDIO_RATE_RE = re.compile(r"(\d+)\s*Hz")
_CHANNELS = {"mono": 1, "stereo": 2, "2.1": 3, "5.1": 6, "7.1": 8}
_OUT_TIME_RE = re.compile(r"out_time=(\d+):(\d{2}):(\d{2})\.(\d+)")
_OUT_TIME_US_RE = re.compile(r"out_time_us=(\d+)")


def find_ffmpeg() -> str:
    """定位 ffmpeg 可执行文件；找不到抛 :class:`FfmpegUnavailable`。"""
    env = os.environ.get("COURSE_KB_FFMPEG")
    if env and os.path.isfile(env):
        return env
    found = shutil.which("ffmpeg")
    if found:
        return found
    for d in _KNOWN_FFMPEG_DIRS:
        cand = os.path.join(d, "ffmpeg.exe")
        if os.path.isfile(cand):
            return cand
        cand = os.path.join(d, "ffmpeg")
        if os.path.isfile(cand):
            return cand
    raise FfmpegUnavailable(
        "找不到 ffmpeg 可执行文件",
        detail=(
            "ffmpeg 不在 PATH，且常见目录 " + ", ".join(_KNOWN_FFMPEG_DIRS) + " 下也没有。"
            "可用环境变量 COURSE_KB_FFMPEG 指定绝对路径。"
            "没有 ffmpeg 时视频只能播放，无法抽音频/抽帧。"
        ),
    )


def ffmpeg_available() -> bool:
    try:
        find_ffmpeg()
        return True
    except FfmpegUnavailable:
        return False


def has_ffprobe() -> bool:
    """本机**没有** ffprobe（实测）——保留此函数是为了明确表达这个事实。"""
    return shutil.which("ffprobe") is not None or bool(
        os.environ.get("COURSE_KB_FFPROBE")
    )


# ── 媒体探测 ────────────────────────────────────────────────────────────
@dataclass
class MediaInfo:
    """``ffmpeg -i`` 头解析出来的媒体信息（单位：毫秒）。"""

    path: str
    duration_ms: int = 0
    has_video: bool = False
    has_audio: bool = False
    width: int = 0
    height: int = 0
    fps: float = 0.0
    sample_rate: int = 0
    channels: int = 0
    raw_header: str = field(default="", repr=False)

    @property
    def is_av(self) -> bool:
        return self.has_video and self.has_audio

    def to_dict(self) -> dict:
        return {
            "duration_ms": self.duration_ms,
            "has_video": self.has_video,
            "has_audio": self.has_audio,
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
        }


def _parse_hms(h: str, m: str, s: str, frac: str) -> int:
    """``00:01:02.34`` → 毫秒（frac 位数不定，按小数解析）。"""
    ms = int(round(float(f"0.{frac}") * 1000)) if frac else 0
    return ((int(h) * 60 + int(m)) * 60 + int(s)) * 1000 + ms


def parse_media_header(stderr: str, path: str = "") -> MediaInfo:
    """解析 ``ffmpeg -i`` 的 stderr 头 → :class:`MediaInfo`。

    **不依赖 ffprobe**（本机没装，坑 16）。``Duration: N/A`` 时 duration_ms=0
    （例如裸 H.264 流），此时由调用方决定怎么处理（我们选择如实报 0，不猜）。
    """
    info = MediaInfo(path=path, raw_header=stderr)
    m = _DURATION_RE.search(stderr)
    if m:
        info.duration_ms = _parse_hms(*m.groups())
    for line in stderr.splitlines():
        sm = _STREAM_RE.search(line)
        if not sm:
            continue
        if sm.group(1) == "Video" and not info.has_video:
            info.has_video = True
            dim = _VIDEO_SIZE_RE.search(line)
            if dim:
                info.width, info.height = int(dim.group(1)), int(dim.group(2))
            fps = _FPS_RE.search(line)
            if fps:
                info.fps = float(fps.group(1))
        elif sm.group(1) == "Audio" and not info.has_audio:
            info.has_audio = True
            rate = _AUDIO_RATE_RE.search(line)
            if rate:
                info.sample_rate = int(rate.group(1))
            for name, n in _CHANNELS.items():
                if re.search(rf"\b{re.escape(name)}\b", line):
                    info.channels = n
                    break
    return info


def probe_media(path: str, *, ffmpeg: str | None = None) -> MediaInfo:
    """探测媒体信息（不完整解码，只读头部，快）。

    文件不存在/不是媒体 → :class:`MediaProbeError`。
    """
    exe = ffmpeg or find_ffmpeg()
    if not os.path.isfile(path):
        raise MediaProbeError(f"文件不存在：{path}")
    with open(path, "rb") as fh:
        head = fh.read(16)
    if not head:
        raise MediaProbeError(f"文件为空：{path}")
    proc = subprocess.run(
        [exe, "-hide_banner", "-i", path],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    info = parse_media_header(proc.stderr, path)
    if not info.has_video and not info.has_audio:
        raise MediaProbeError(
            f"无法识别的媒体文件：{path}",
            detail=(
                "ffmpeg -i 没有解析出任何 video/audio 流。"
                f"stderr 尾部：{chr(10).join(proc.stderr.strip().splitlines()[-6:])}"
            ),
            code="E_PROBE",
        )
    return info


# ── 执行 ────────────────────────────────────────────────────────────────
def run_ffmpeg(
    args: Sequence[str],
    *,
    timeout: float | None = None,
    ffmpeg: str | None = None,
) -> subprocess.CompletedProcess:
    """执行 ffmpeg（``-hide_banner -nostdin`` 自动补上；失败抛 :class:`FfmpegRunError`）。"""
    exe = ffmpeg or find_ffmpeg()
    cmd = [exe, "-hide_banner", "-nostdin", *args]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise FfmpegRunError(
            f"ffmpeg 执行失败（退出码 {proc.returncode}）", cmd=cmd, stderr=proc.stderr
        )
    return proc


def run_ffmpeg_streaming(
    args: Sequence[str],
    *,
    total_ms: int = 0,
    on_progress: Callable[[float, str], None] | None = None,
    stage: str = "",
    ffmpeg: str | None = None,
    timeout: float | None = None,
    should_cancel: Callable[[], bool] | None = None,
    cancel_exc: type[BaseException] | None = None,
) -> tuple[int, str]:
    """执行 ffmpeg 并**实时**上报进度。

    :return: ``(returncode, stderr_text)``
    :raises FfmpegUnavailable: 没有 ffmpeg
    :raises KeyboardInterrupt 风格的中断异常: 当 ``should_cancel()`` 为真

    ⚠️ 退出码 **可能非 0 却是正常结果**（坑 16：select 一帧没选中）。
    所以这里**不抛异常**，把退出码与 stderr 交给调用方判断。
    """
    exe = ffmpeg or find_ffmpeg()
    cmd = [exe, "-hide_banner", "-nostdin", "-progress", "pipe:1", "-nostats", *args]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    cancel_exc = cancel_exc or KeyboardInterrupt
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if should_cancel is not None and should_cancel():
                proc.kill()
                proc.wait(timeout=10)
                raise cancel_exc("ffmpeg 被取消")
            us = _OUT_TIME_US_RE.search(line)
            if us and total_ms > 0 and on_progress is not None:
                frac = min(0.999, int(us.group(1)) / 1000.0 / total_ms)
                _safe_progress(on_progress, frac, stage)
                continue
            ot = _OUT_TIME_RE.search(line)
            if ot and total_ms > 0 and on_progress is not None:
                cur = _parse_hms(*ot.groups())
                _safe_progress(on_progress, min(0.999, cur / total_ms), stage)
        stderr = proc.stderr.read() if proc.stderr is not None else ""
        proc.wait(timeout=timeout)
    finally:
        for stream in (proc.stdout, proc.stderr):
            try:
                if stream is not None:
                    stream.close()
            except Exception:  # noqa: BLE001
                pass
    return proc.returncode, stderr


def _safe_progress(cb: Callable[[float, str], None], frac: float, stage: str) -> None:
    """进度回调是旁观者：它抛异常不能拖垮转码（同 adapters.base.report 的语义）。"""
    try:
        cb(max(0.0, min(1.0, frac)), stage)
    except Exception:  # noqa: BLE001
        pass


def stderr_tail(stderr: str, lines: int = 8) -> str:
    return "\n".join(stderr.strip().splitlines()[-lines:])


__all__ = [
    "MediaInfo",
    "find_ffmpeg",
    "ffmpeg_available",
    "has_ffprobe",
    "probe_media",
    "parse_media_header",
    "run_ffmpeg",
    "run_ffmpeg_streaming",
    "stderr_tail",
]
