"""S1 抽音频的测试（**真实调用 ffmpeg**，素材由 :mod:`worker.video.synth` 合成）。

断言的是**具体值**（采样率/声道/位深/时长/字节数关系），不是"非空"。
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from worker.video import synth  # noqa: E402
from worker.video.audio import (  # noqa: E402
    extract_audio,
    read_wav_header,
    wav_duration_ms,
)
from worker.video.errors import MediaProbeError  # noqa: E402
from worker.video.ffmpeg_util import probe_media  # noqa: E402

#: 4 色 × 3 秒 = 12 秒（与 synth.DEFAULT_COLORS 对应）
DUR_MS = 12_000


@pytest.fixture(scope="module")
def av_video(tmp_path_factory) -> str:
    d = tmp_path_factory.mktemp("s1")
    return synth.synth_video(str(d / "av.mp4"), duration_ms=DUR_MS)


# ── 探测（不依赖 ffprobe：本机没装）─────────────────────────────────────
def test_probe_reads_header_without_ffprobe(av_video: str) -> None:
    from worker.video.ffmpeg_util import has_ffprobe

    assert has_ffprobe() is False, "本机实测没有 ffprobe；有了的话这条断言要更新"
    info = probe_media(av_video)
    assert info.duration_ms == DUR_MS, f"时长应精确等于 {DUR_MS}ms，实测 {info.duration_ms}"
    assert (info.has_video, info.has_audio) == (True, True)
    assert (info.width, info.height) == (320, 240)
    assert info.fps == 10.0
    assert info.sample_rate == 16_000
    assert info.channels == 1


def test_probe_rejects_non_media(tmp_path) -> None:
    junk = tmp_path / "junk.mp4"
    junk.write_text("this is definitely not a video", encoding="utf-8")
    with pytest.raises(MediaProbeError) as ei:
        probe_media(str(junk))
    assert ei.value.code == "E_PROBE"


def test_probe_rejects_empty_file(tmp_path) -> None:
    empty = tmp_path / "empty.mp4"
    empty.write_bytes(b"")
    with pytest.raises(MediaProbeError):
        probe_media(str(empty))


# ── 抽音频 ──────────────────────────────────────────────────────────────
def test_extract_audio_produces_asr_ready_wav(av_video: str, tmp_path) -> None:
    dst = str(tmp_path / "audio.wav")
    track = extract_audio(av_video, dst)
    assert os.path.isfile(dst)
    assert track.is_asr_ready is True, "ASR 要求 16k/单声道/16bit"
    assert track.sample_rate == 16_000
    assert track.channels == 1
    assert track.bits_per_sample == 16
    # 12 秒 16k 单声道 16bit = 12000ms * 16 samples/ms * 2 bytes = 384000 字节数据
    assert 384_000 - 4_000 <= track.size_bytes <= 384_000 + 4_000, track.size_bytes
    # 时长允许 ±100ms（aac 帧对齐），但必须**大致等于**源片长
    assert abs(track.duration_ms - DUR_MS) <= 100, track.duration_ms
    head = read_wav_header(dst)
    assert head["audio_format"] == 1, "1 = PCM"
    assert head["sample_rate"] == 16_000
    assert head["channels"] == 1
    assert head["bits_per_sample"] == 16
    assert wav_duration_ms(dst) == track.duration_ms


def test_extract_audio_reuses_existing_file(av_video: str, tmp_path) -> None:
    """断点复用：第二次不许重新转码（mtime 不变）。"""
    dst = str(tmp_path / "audio.wav")
    first = extract_audio(av_video, dst)
    stamp = os.stat(dst).st_mtime_ns
    second = extract_audio(av_video, dst)
    assert second.duration_ms == first.duration_ms
    assert os.stat(dst).st_mtime_ns == stamp, "已抽好的音频被重抽了（断点复用失效）"


def test_extract_audio_force_retranscodes(av_video: str, tmp_path) -> None:
    dst = str(tmp_path / "audio.wav")
    extract_audio(av_video, dst)
    os.utime(dst, (0, 0))  # 人为改旧
    extract_audio(av_video, dst, force=True)
    assert os.stat(dst).st_mtime_ns != 0
    assert read_wav_header(dst)["sample_rate"] == 16_000


def test_extract_audio_ignores_truncated_previous_file(av_video: str, tmp_path) -> None:
    """上次中断留下的半截 WAV 必须被识别并重抽（不是直接复用）。"""
    dst = str(tmp_path / "audio.wav")
    with open(dst, "wb") as fh:
        fh.write(b"RIFF\x00\x00\x00\x00WAVE")  # 只有 12 字节，没有 fmt 块
    track = extract_audio(av_video, dst)
    assert track.duration_ms >= DUR_MS - 100


def test_extract_audio_from_audio_only_file(tmp_path) -> None:
    wav = synth.synth_audio(str(tmp_path / "tone.wav"), duration_ms=3_000)
    track = extract_audio(wav, str(tmp_path / "out.wav"))
    assert track.sample_rate == 16_000
    assert abs(track.duration_ms - 3_000) <= 60, track.duration_ms


def test_extract_audio_fails_honestly_when_no_audio_stream(tmp_path) -> None:
    """**坑 10 的前置条件**：没有音轨 → 必须报错，不许产出空 WAV。"""
    silent = synth.synth_silent_video(str(tmp_path / "silent.mp4"), duration_ms=3_000)
    dst = str(tmp_path / "never.wav")
    with pytest.raises(MediaProbeError) as ei:
        extract_audio(silent, dst)
    assert ei.value.code == "E_NO_AUDIO"
    assert "没有音频流" in ei.value.message
    assert not os.path.exists(dst), "失败时不该留下文件"


def test_extract_audio_reports_progress_monotonically(av_video: str, tmp_path) -> None:
    seen: list[float] = []
    extract_audio(
        av_video,
        str(tmp_path / "audio.wav"),
        on_progress=lambda frac, stage: seen.append(frac),
    )
    assert len(seen) > 0, "抽音频必须上报进度"
    assert seen == sorted(seen), f"进度必须单调不减：{seen}"
    assert all(0.0 <= f <= 1.0 for f in seen)
