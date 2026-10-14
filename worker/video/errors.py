"""视频管线的异常与错误码（契约 §6 ``failed`` 事件的 ``code``）。

设计原则（坑 10）：**能力缺失就是能力缺失**，用独立的异常类型表达，
让上层能把它映射成 ``/capabilities`` 的 ``available=false``，
而不是吞掉异常、产出空产物、假装成功。
"""

from __future__ import annotations


class VideoError(Exception):
    """视频管线错误基类。

    :param code: 契约 §6 ``failed`` 事件的 ``code`` 字段
    :param detail: 给日志/UI 的人话说明（**必须是真实原因，不许含糊**）
    """

    code = "E_VIDEO"

    def __init__(self, message: str, *, detail: str = "", code: str | None = None):
        super().__init__(message)
        self.message = message
        self.detail = detail or message
        if code:
            self.code = code


class FfmpegUnavailable(VideoError):
    """找不到 ffmpeg 可执行文件（本机 ffmpeg 在 ``C:\\tools\\ffmpeg\\ffmpeg.exe``）。

    ⚠️ 本机只有 ``ffmpeg.exe``，**没有 ``ffprobe.exe``**（实测 2026-10-14）。
    所以媒体信息一律用 ``ffmpeg -i`` 的 stderr 头解析，不要调 ffprobe。
    """

    code = "E_FFMPEG_MISSING"


class MediaProbeError(VideoError):
    """媒体探测失败：文件损坏 / 不是媒体文件 / 输出无法解析。"""

    code = "E_PROBE"


class FfmpegRunError(VideoError):
    """ffmpeg 执行失败（带退出码与 stderr 尾部）。"""

    code = "E_FFMPEG_RUN"

    def __init__(self, message: str, *, cmd: list[str] | None = None, stderr: str = ""):
        tail = "\n".join(stderr.strip().splitlines()[-12:])
        detail = f"{message}\n  cmd: {' '.join(cmd or [])}\n  stderr: {tail}"
        super().__init__(message, detail=detail, code="E_FFMPEG_RUN")
        self.cmd = cmd or []
        self.stderr = stderr


class AsrUnavailable(VideoError):
    """ASR 不可用（坑 10）。

    触发场景：``faster_whisper`` 未安装 / 模型下载失败 / 模型加载失败 /
    音频为空。上层必须把 ``asr.available`` 置为 ``false`` 并在 UI 禁用入口，
    **绝不允许**伪造字幕或文稿。
    """

    code = "E_ASR_LOAD"


class AsrDependencyMissing(AsrUnavailable):
    """``faster_whisper`` 这个包本身就没装（不是模型问题）。"""

    code = "E_ASR_MISSING"


class TextModelUnavailable(VideoError):
    """LLM 不可用（分章/摘要/思维导图是 LLM 派生能力，缺了就必须降级说明）。"""

    code = "E_LLM"


class TextModelSchemaError(VideoError):
    """LLM 返回的结构不符合 json_schema（坑 4：必须 strict schema，不能 json_object）。"""

    code = "E_LLM_SCHEMA"


class JobCancelled(VideoError):
    """任务被取消（SSE ``cancelled``）。**不是失败**，断点保留。"""

    code = "E_CANCELLED"


class SubtitleParseError(VideoError):
    """手动上传的字幕解析失败（坑 10 的降级路径）。"""

    code = "E_SUBTITLE_PARSE"


__all__ = [
    "VideoError",
    "FfmpegUnavailable",
    "MediaProbeError",
    "FfmpegRunError",
    "AsrUnavailable",
    "AsrDependencyMissing",
    "TextModelUnavailable",
    "TextModelSchemaError",
    "JobCancelled",
    "SubtitleParseError",
]
