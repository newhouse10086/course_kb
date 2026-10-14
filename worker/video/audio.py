"""S1 抽音频：视频 → 16kHz 单声道 PCM s16le WAV（ASR 的标准输入）。

```
ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 -c:a pcm_s16le out.wav
```

为什么**先转 WAV** 而不是直接喂给 ASR：
1. faster-whisper 底层是 PyAV/ffmpeg 解码，但现在走的是我们的 PyAV 版本，
   对某些容器（mkv/flv/ts）解码兼容性不如命令行 ffmpeg；
2. 抽成 16k 单声道 PCM 后，**转写阶段不用再解码视频流**，
   分段（chunk）时可以直接按字节偏移切，避免每段都重新解容器；
3. 断点续跑时，"音频已抽好"是一个明确可复用的中间产物。
"""

from __future__ import annotations

import os
import struct
from dataclasses import dataclass
from typing import Callable

from .errors import FfmpegRunError, MediaProbeError
from .ffmpeg_util import (
    MediaInfo,
    probe_media,
    run_ffmpeg_streaming,
    stderr_tail,
)

#: ASR 标准输入参数（FUNCTIONAL_SPEC F6 关键参数表）
TARGET_SAMPLE_RATE = 16000
TARGET_CHANNELS = 1
TARGET_CODEC = "pcm_s16le"


@dataclass
class AudioTrack:
    """抽出来的音轨（自描述，供 ASR 阶段直接用）。"""

    path: str
    duration_ms: int
    sample_rate: int
    channels: int
    bits_per_sample: int
    size_bytes: int

    @property
    def is_asr_ready(self) -> bool:
        """是否满足 Whisper 的输入约定（16k/单声道/16bit）。"""
        return (
            self.sample_rate == TARGET_SAMPLE_RATE
            and self.channels == TARGET_CHANNELS
            and self.bits_per_sample == 16
        )

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "duration_ms": self.duration_ms,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "bits_per_sample": self.bits_per_sample,
            "size_bytes": self.size_bytes,
        }


def read_wav_header(path: str) -> dict[str, int]:
    """读 WAV ``fmt `` 块，**用真实字节验证** ffmpeg 真的按我们要的参数输出了。

    不信任命令行参数：加 ``-ar`` 有时会被容器/编码器忽略，
    测试里必须断言实际采样率，所以这里直接解析文件头。
    """
    with open(path, "rb") as fh:
        riff = fh.read(12)
        if len(riff) < 12 or riff[0:4] != b"RIFF" or riff[8:12] != b"WAVE":
            raise MediaProbeError(f"不是合法的 WAV 文件：{path}")
        out: dict[str, int] = {}
        while True:
            hdr = fh.read(8)
            if len(hdr) < 8:
                break
            cid, size = struct.unpack("<4sI", hdr)
            if cid == b"fmt ":
                body = fh.read(size)
                if len(body) < 16:
                    raise MediaProbeError(f"WAV fmt 块损坏：{path}")
                (
                    _audio_fmt,
                    channels,
                    sample_rate,
                    _byte_rate,
                    _block_align,
                    bits,
                ) = struct.unpack("<HHIIHH", body[:16])
                out.update(
                    {
                        "audio_format": _audio_fmt,
                        "channels": channels,
                        "sample_rate": sample_rate,
                        "bits_per_sample": bits,
                    }
                )
                break
            if cid == b"data":
                break
            fh.seek(size + (size % 2), os.SEEK_CUR)
        if "sample_rate" not in out:
            raise MediaProbeError(f"WAV 里找不到 fmt 块：{path}")
        return out


def wav_duration_ms(path: str) -> int:
    """按数据字节数算时长（比 ffmpeg 头更可靠，且对 chunk 文件同样有效）。"""
    with open(path, "rb") as fh:
        riff = fh.read(12)
        if len(riff) < 12 or riff[0:4] != b"RIFF" or riff[8:12] != b"WAVE":
            raise MediaProbeError(f"不是合法的 WAV 文件：{path}")
        channels = sample_rate = bits = 0
        data_bytes = 0
        while True:
            hdr = fh.read(8)
            if len(hdr) < 8:
                break
            cid, size = struct.unpack("<4sI", hdr)
            if cid == b"fmt ":
                body = fh.read(size)
                _fmt, channels, sample_rate, _br, _ba, bits = struct.unpack(
                    "<HHIIHH", body[:16]
                )
            elif cid == b"data":
                data_bytes += size
                fh.seek(size + (size % 2), os.SEEK_CUR)
            else:
                fh.seek(size + (size % 2), os.SEEK_CUR)
    if not sample_rate or not channels or not bits:
        return 0
    return int(data_bytes * 1000 / (sample_rate * channels * (bits // 8)))


def extract_audio(
    src: str,
    dst: str,
    *,
    sample_rate: int = TARGET_SAMPLE_RATE,
    channels: int = TARGET_CHANNELS,
    ffmpeg: str | None = None,
    duration_ms: int | None = None,
    force: bool = False,
    timeout: float | None = None,
    on_progress: Callable[[float, str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> AudioTrack:
    """视频/音频 → 16k 单声道 PCM WAV。

    :param force: 已存在时是否重抽（断点续跑默认复用已抽好的音频）
    :raises MediaProbeError: 源文件没有音频流（→ 如实失败，不产出空字幕）
    :raises FfmpegRunError: ffmpeg 转码失败
    """
    if not force and os.path.isfile(dst) and os.path.getsize(dst) > 44:
        try:
            head = read_wav_header(dst)
            if (
                head["sample_rate"] == sample_rate
                and head["channels"] == channels
                and head["bits_per_sample"] == 16
            ):
                return AudioTrack(
                    path=dst,
                    duration_ms=wav_duration_ms(dst),
                    size_bytes=os.path.getsize(dst),
                    **{
                        k: head[k]
                        for k in ("sample_rate", "channels", "bits_per_sample")
                    },
                )
        except MediaProbeError:
            pass  # 半截文件（上次中断）→ 重抽

    info: MediaInfo | None = None
    if duration_ms is None:
        info = probe_media(src, ffmpeg=ffmpeg)
        duration_ms = info.duration_ms
        if not info.has_audio:
            raise MediaProbeError(
                f"源文件没有音频流，无法转写：{os.path.basename(src)}",
                detail=(
                    "探测到的流：" + ("video" if info.has_video else "") + ("audio" if info.has_audio else "(无)")
                    + "。没有音轨的视频仍可播放、可抽幻灯片帧，但**不会产出字幕/文稿**。"
                ),
                code="E_NO_AUDIO",
            )

    os.makedirs(os.path.dirname(os.path.abspath(dst)) or ".", exist_ok=True)
    args = [
        "-y",
        "-i",
        src,
        "-vn",
        "-ac",
        str(channels),
        "-ar",
        str(sample_rate),
        "-c:a",
        TARGET_CODEC,
        dst,
    ]
    rc, stderr = run_ffmpeg_streaming(
        args,
        total_ms=duration_ms or 0,
        on_progress=on_progress,
        stage="抽音频",
        ffmpeg=ffmpeg,
        timeout=timeout,
        should_cancel=should_cancel,
    )
    if rc != 0 or not os.path.isfile(dst):
        raise FfmpegRunError("抽音频失败", cmd=["ffmpeg", *args], stderr=stderr)
    if os.path.getsize(dst) <= 44:
        raise FfmpegRunError(
            "抽音频产出了空 WAV（0 采样）",
            cmd=["ffmpeg", *args],
            stderr=stderr_tail(stderr),
        )
    head = read_wav_header(dst)
    return AudioTrack(
        path=dst,
        duration_ms=wav_duration_ms(dst),
        sample_rate=head["sample_rate"],
        channels=head["channels"],
        bits_per_sample=head["bits_per_sample"],
        size_bytes=os.path.getsize(dst),
    )


__all__ = [
    "AudioTrack",
    "TARGET_SAMPLE_RATE",
    "TARGET_CHANNELS",
    "TARGET_CODEC",
    "extract_audio",
    "read_wav_header",
    "wav_duration_ms",
]
