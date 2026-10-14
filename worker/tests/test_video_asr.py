"""S2 ASR 的测试。

分两层：

* **逻辑层（总是跑）**：分段、拼接、断点续跑 —— 用注入的 ``transcribe_fn``，
  不加载模型、不联网，断言的是**精确数值**。
* **真机层（``COURSE_KB_ASR_E2E=1`` 时跑）**：真的调 faster-whisper（tiny，CPU）
  转写 SAPI 合成的中文语音。默认跳过是因为首次要下载 75MB 模型、耗时几十秒，
  不适合放进每次``pytest``；但它**真的跑过**（结果见交付报告）。
"""

from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from worker.models.video import VideoSegment  # noqa: E402
from worker.video import asr as A  # noqa: E402
from worker.video import synth  # noqa: E402
from worker.video.errors import AsrUnavailable, JobCancelled  # noqa: E402

E2E = os.environ.get("COURSE_KB_ASR_E2E") == "1"


def seg(i: int, start: int, end: int, text: str) -> VideoSegment:
    return VideoSegment(i=i, start=start, end=end, text=text, confidence=0.9)


# ── 能力探测（坑 10 的接口）────────────────────────────────────────────
def test_asr_capability_shape_and_no_side_effects() -> None:
    """``/capabilities`` 依赖这个函数：字段齐、**不做下载/加载**（调用要快）。"""
    import time

    t0 = time.time()
    cap = A.asr_capability()
    elapsed = time.time() - t0
    assert elapsed < 2.0, f"能力探测不能加载模型（耗时 {elapsed:.2f}s）"
    for key in ("available", "engine", "models", "device", "reason"):
        assert key in cap, f"缺字段 {key}"
    assert cap["engine"] == "faster-whisper"
    assert cap["device"] == "cpu"
    assert cap["models"] == ["tiny", "base", "small"], "降级链必须是 tiny→base→small"
    # 本机实测 faster-whisper 1.2.1 已装 → available 必须为真
    assert cap["available"] is True, cap["reason"]
    assert "tiny" in str(cap["cached_models"]), "tiny 已缓存（实测）"
    assert isinstance(cap["reason"], str) and cap["reason"]


def test_asr_capability_reports_false_when_package_missing(monkeypatch) -> None:
    """模拟"faster-whisper 没装" → 必须如实 False 且给出人话原因（坑 10）。"""
    import builtins

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "faster_whisper" or name.startswith("faster_whisper."):
            raise ImportError("No module named 'faster_whisper'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    monkeypatch.delitem(sys.modules, "faster_whisper", raising=False)
    cap = A.asr_capability()
    assert cap["available"] is False
    assert "faster-whisper" in cap["reason"]
    assert "pip install" in cap["reason"]


# ── 分段 ────────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    ("duration_ms", "chunk_ms", "expected"),
    [
        (3_720_000, 600_000, 7),   # 62 分钟 → 7 块（最后一块只 12 分钟）
        (1_200_000, 600_000, 2),   # 整除 → 恰好 2 块（不留空尾块）
        (600_000, 600_000, 1),     # 恰一块
        (599_999, 600_000, 1),
        (600_001, 600_000, 2),
        (0, 600_000, 1),           # 时长未知 → 整段一块
    ],
)
def test_plan_chunks_counts(duration_ms: int, chunk_ms: int, expected: int) -> None:
    assert len(A.plan_chunks(duration_ms, chunk_ms)) == expected


def test_plan_chunks_boundaries_are_contiguous() -> None:
    chunks = A.plan_chunks(3_720_000, 600_000)
    assert [(c.index, c.start_ms, c.end_ms) for c in chunks] == [
        (0, 0, 600_000),
        (1, 600_000, 1_200_000),
        (2, 1_200_000, 1_800_000),
        (3, 1_800_000, 2_400_000),
        (4, 2_400_000, 3_000_000),
        (5, 3_000_000, 3_600_000),
        (6, 3_600_000, 3_720_000),
    ]
    assert sum(c.duration_ms for c in chunks) == 3_720_000


def test_plan_chunks_rejects_nonpositive_chunk() -> None:
    with pytest.raises(ValueError):
        A.plan_chunks(1_000, 0)


# ── 拼接（块边界的重叠是真实存在的坑）──────────────────────────────────
def test_stitch_segments_clamps_overlap_at_chunk_boundary() -> None:
    raw = [
        seg(0, 0, 5_000, "第一句"),
        seg(1, 4_500, 9_000, "第二句"),   # 与上一条重叠 500ms
        seg(2, 9_000, 9_000, "零长度"),   # 完全落在上一条内部 → 丢
        seg(3, 12_000, 15_000, "第三句"),
    ]
    out = A.stitch_segments(raw)
    assert [(s.i, s.start, s.end, s.text) for s in out] == [
        (0, 0, 5_000, "第一句"),
        (1, 5_000, 9_000, "第二句"),
        (2, 12_000, 15_000, "第三句"),
    ]


def test_stitch_segments_drops_empty_text() -> None:
    out = A.stitch_segments([seg(0, 0, 1_000, "  "), seg(1, 2_000, 3_000, "有字")])
    assert [s.text for s in out] == ["有字"]
    assert [s.i for s in out] == [0], "重编号必须从 0 连续"


def test_stitch_segments_clamps_to_duration() -> None:
    """whisper 末段常 overshoot（实测几百 ms）→ 必须裁到片长，否则分章越界。"""
    raw = [seg(0, 0, 5_000, "正常"), seg(1, 9_800, 10_700, "超出片尾")]
    out = A.stitch_segments(raw, duration_ms=10_000)
    assert [(s.start, s.end) for s in out] == [(0, 5_000), (9_800, 10_000)]


def test_stitch_segments_drops_fully_out_of_range() -> None:
    out = A.stitch_segments([seg(0, 0, 1_000, "在范围内"), seg(1, 11_000, 12_000, "整个越界")],
                            duration_ms=10_000)
    assert [s.text for s in out] == ["在范围内"]


# ── 断点文件 ────────────────────────────────────────────────────────────
def test_checkpoint_round_trip(tmp_path) -> None:
    path = str(tmp_path / "asr.ckpt.json")
    ckpt = A.AsrCheckpoint(
        path=path,
        fingerprint="fp1",
        model="tiny",
        lang="zh",
        duration_ms=1_200_000,
        done_chunks=[0, 1],
        segments=[seg(0, 0, 1_000, "你好").to_dict()],
    )
    ckpt.save()
    assert os.path.isfile(path)
    assert not os.path.exists(path + ".tmp"), "原子写要清掉临时文件"
    back = A.AsrCheckpoint.load(path, "fp1")
    assert back is not None
    assert back.done_chunks == [0, 1]
    assert back.model == "tiny"
    assert back.lang == "zh"
    assert back.duration_ms == 1_200_000
    assert back.segments == [seg(0, 0, 1_000, "你好").to_dict()]
    assert back.updated_at > 0


def test_checkpoint_rejects_fingerprint_mismatch(tmp_path) -> None:
    """音频换了/模型换了 → 断点必须作废（否则会把两段音频的段拼在一起）。"""
    path = str(tmp_path / "asr.ckpt.json")
    A.AsrCheckpoint(path=path, fingerprint="fp-A", model="tiny", done_chunks=[0]).save()
    assert A.AsrCheckpoint.load(path, "fp-B") is None


def test_checkpoint_rejects_corrupt_json(tmp_path) -> None:
    """上次被 kill 留下的半截 JSON 不能让续跑崩掉（原子写是第二层保护）。"""
    path = str(tmp_path / "asr.ckpt.json")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write('{"version":1,"fingerprint":"fp","done_chunks":[0')
    assert A.AsrCheckpoint.load(path, "fp") is None


def test_checkpoint_rejects_version_bump(tmp_path) -> None:
    path = str(tmp_path / "asr.ckpt.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"version": 99, "fingerprint": "fp", "done_chunks": [0]}, fh)
    assert A.AsrCheckpoint.load(path, "fp") is None


def test_audio_fingerprint_changes_with_model_and_size(tmp_path) -> None:
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"RIFF....WAVEfmt ")
    fp1 = A.audio_fingerprint(str(wav), "tiny", 1_000)
    assert fp1 != A.audio_fingerprint(str(wav), "base", 1_000)
    wav.write_bytes(b"RIFF....WAVEfmt " + b"\x00" * 100)
    assert fp1 != A.audio_fingerprint(str(wav), "tiny", 1_000)


# ── 转写（注入后端：断言精确数值 + 断点续跑）────────────────────────────
def _make_audio(tmp_path, duration_ms: int = 1_200_000) -> str:
    """造一个"够长"的 WAV（不真放 20 分钟音频：写文件头 + 静音数据即可）。

    ⚠️ 我们不解析内容，只按 WAV 数据长度算时长，所以可以便宜地造长音频。
    """
    import struct

    path = str(tmp_path / f"audio_{duration_ms}.wav")
    rate, ch, bits = 16_000, 1, 16
    data_bytes = int(duration_ms * rate * ch * (bits // 8) / 1000)
    with open(path, "wb") as fh:
        fh.write(b"RIFF")
        fh.write(struct.pack("<I", 36 + data_bytes))
        fh.write(b"WAVEfmt ")
        fh.write(struct.pack("<IHHIIHH", 16, 1, ch, rate, rate * ch * 2, ch * 2, bits))
        fh.write(b"data")
        fh.write(struct.pack("<I", data_bytes))
        chunk = b"\x00" * 65_536
        written = 0
        while written < data_bytes:
            n = min(len(chunk), data_bytes - written)
            fh.write(chunk[:n])
            written += n
    assert A.wav_duration_ms(path) == duration_ms
    return path


def test_transcribe_uses_chunks_and_offsets(tmp_path) -> None:
    """2 块音频 → 段偏移必须加上块起点（第一块 0，第二块 +600000）。"""
    audio = _make_audio(tmp_path, 1_200_000)
    calls: list[int] = []

    def fake(idx, chunk):
        calls.append(idx)
        base = chunk.start_ms
        return (
            [
                seg(0, 0, 1_000, f"块{idx}第一句"),
                seg(1, 2_000, 3_000, f"块{idx}第二句"),
            ],
            "zh",
            0.97,
        )

    result = A.transcribe_audio(
        audio,
        model="tiny",
        duration_ms=1_200_000,
        work_dir=str(tmp_path / "w"),
        transcribe_fn=fake,
        chunk_ms=600_000,
    )
    assert calls == [0, 1]
    assert len(result.segments) == 4
    assert [(s.start, s.end) for s in result.segments] == [
        (0, 1_000),
        (2_000, 3_000),
        (600_000, 601_000),
        (602_000, 603_000),
    ]
    assert result.chunks_total == 2
    assert result.chunks_done == 2
    assert result.chunks_resumed == 0
    assert result.lang == "zh"
    assert result.model == "tiny"


def test_transcribe_reports_progress_monotonically(tmp_path) -> None:
    audio = _make_audio(tmp_path, 1_200_000)
    seen: list[float] = []
    A.transcribe_audio(
        audio,
        duration_ms=1_200_000,
        work_dir=str(tmp_path / "w"),
        transcribe_fn=lambda i, c: ([seg(0, 0, 1_000, f"块{i}")], "zh", 0.9),
        on_progress=lambda f, s: seen.append(f),
    )
    assert seen == sorted(seen)
    assert seen[-1] > 0.9


def test_transcribe_resumes_after_cancel(tmp_path) -> None:
    """★ 验收项「中断后 --resume 可续」：取消 → 断点落盘 → 续跑只做剩下的块。"""
    audio = _make_audio(tmp_path, 1_800_000)  # 3 块
    work = str(tmp_path / "w")
    calls: list[int] = []

    def cancelling(idx, chunk):
        calls.append(idx)
        if idx == 1:
            raise JobCancelled("模拟用户取消")
        return ([seg(0, 0, 1_000, f"块{idx}")], "zh", 0.9)

    with pytest.raises(JobCancelled):
        A.transcribe_audio(
            audio,
            duration_ms=1_800_000,
            work_dir=work,
            transcribe_fn=cancelling,
            chunk_ms=600_000,
        )
    assert calls == [0, 1], "第 1 块应当已经跑过并落盘"

    ckpt_path = os.path.join(work, "asr.ckpt.json")
    saved = A.AsrCheckpoint.load(ckpt_path, A.audio_fingerprint(audio, "tiny", 1_800_000))
    assert saved is not None, "取消后必须留下断点"
    assert saved.done_chunks == [0]

    calls.clear()
    resumed = A.transcribe_audio(
        audio,
        duration_ms=1_800_000,
        work_dir=work,
        transcribe_fn=lambda i, c: (calls.append(i) or [seg(0, 0, 1_000, f"块{i}")], "zh", 0.9),
        chunk_ms=600_000,
    )
    assert calls == [1, 2], f"续跑只该做第 1、2 块，实际 {calls}"
    assert resumed.chunks_resumed == 1
    assert [s.text for s in resumed.segments] == ["块0", "块1", "块2"]


def test_transcribe_all_chunks_done_returns_from_checkpoint(tmp_path) -> None:
    """全部完成时直接读断点，**一块都不再跑**（结果与首次一致）。"""
    audio = _make_audio(tmp_path, 600_000)
    work = str(tmp_path / "w")
    first = A.transcribe_audio(
        audio,
        duration_ms=600_000,
        work_dir=work,
        transcribe_fn=lambda i, c: ([seg(0, 0, 1_000, "唯一一块")], "zh", 0.9),
    )
    assert len(first.segments) == 1

    def forbidden(idx, chunk):  # pragma: no cover - 走到这里就是 bug
        raise AssertionError("断点已完成，不该再转写")

    again = A.transcribe_audio(
        audio, duration_ms=600_000, work_dir=work, transcribe_fn=forbidden
    )
    assert [(s.text, s.start, s.end) for s in again.segments] == [("唯一一块", 0, 1_000)]
    assert again.chunks_resumed == 1


def test_transcribe_raises_when_no_speech_found(tmp_path) -> None:
    """★ 坑 10：识别不到语音 → 抛 AsrUnavailable，**绝不返回空字幕**。"""
    audio = _make_audio(tmp_path, 600_000)
    with pytest.raises(AsrUnavailable) as ei:
        A.transcribe_audio(
            audio,
            duration_ms=600_000,
            work_dir=str(tmp_path / "w"),
            transcribe_fn=lambda i, c: ([], "zh", 0.5),
        )
    assert ei.value.code == "E_ASR_EMPTY"
    assert "没有识别出任何语音" in ei.value.message
    assert "不产出字幕与文稿" in ei.value.detail


def test_transcribe_rejects_missing_audio(tmp_path) -> None:
    with pytest.raises(AsrUnavailable) as ei:
        A.transcribe_audio(str(tmp_path / "nope.wav"), work_dir=str(tmp_path / "w"))
    assert ei.value.code == "E_ASR_NO_AUDIO"


def test_transcribe_rejects_zero_length_audio(tmp_path) -> None:
    audio = _make_audio(tmp_path, 0)
    with pytest.raises(AsrUnavailable) as ei:
        A.transcribe_audio(audio, duration_ms=0, work_dir=str(tmp_path / "w"))
    assert ei.value.code == "E_ASR_NO_AUDIO"
    assert "时长为 0" in ei.value.message


def test_transcribe_chunk_failure_saves_checkpoint_first(tmp_path) -> None:
    """块级异常也必须先落断点再抛（否则"中断可续"是假的）。"""
    audio = _make_audio(tmp_path, 1_200_000)
    work = str(tmp_path / "w")

    def boom(idx, chunk):
        if idx == 0:
            return ([seg(0, 0, 1_000, "好的一块")], "zh", 0.9)
        raise RuntimeError("模拟解码崩了")

    with pytest.raises(AsrUnavailable) as ei:
        A.transcribe_audio(
            audio, duration_ms=1_200_000, work_dir=work, transcribe_fn=boom, chunk_ms=600_000
        )
    assert ei.value.code == "E_ASR_RUN"
    assert "已完成块 1/2" in ei.value.detail
    saved = A.AsrCheckpoint.load(
        os.path.join(work, "asr.ckpt.json"), A.audio_fingerprint(audio, "tiny", 1_200_000)
    )
    assert saved is not None and saved.done_chunks == [0]


def test_transcribe_writes_checkpoint_incrementally(tmp_path) -> None:
    """每块落盘：跑完 2 块后断点里应有 2 个 done_chunks（不是最后才写）。"""
    audio = _make_audio(tmp_path, 1_200_000)
    work = str(tmp_path / "w")
    A.transcribe_audio(
        audio,
        duration_ms=1_200_000,
        work_dir=work,
        transcribe_fn=lambda i, c: ([seg(0, 0, 1_000, f"块{i}")], "zh", 0.9),
        chunk_ms=600_000,
    )
    with open(os.path.join(work, "asr.ckpt.json"), encoding="utf-8") as fh:
        data = json.load(fh)
    assert data["done_chunks"] == [0, 1]
    assert len(data["segments"]) == 2


def test_transcribe_reuses_existing_chunk_files(tmp_path) -> None:
    """断点 + 块文件复用：续跑时不该重新跑 ffmpeg 切块。"""
    audio = _make_audio(tmp_path, 1_200_000)
    work = str(tmp_path / "w")
    A.transcribe_audio(
        audio,
        duration_ms=1_200_000,
        work_dir=work,
        transcribe_fn=lambda i, c: ([seg(0, 0, 1_000, f"块{i}")], "zh", 0.9),
        chunk_ms=600_000,
    )
    stamps = {
        name: os.stat(os.path.join(work, name)).st_mtime_ns
        for name in os.listdir(work)
        if name.startswith("chunk_")
    }
    assert len(stamps) == 2
    # 删掉断点（但保留块文件）→ 会重跑转写，但切块应复用
    os.remove(os.path.join(work, "asr.ckpt.json"))
    A.transcribe_audio(
        audio,
        duration_ms=1_200_000,
        work_dir=work,
        transcribe_fn=lambda i, c: ([seg(0, 0, 1_000, f"块{i}")], "zh", 0.9),
        chunk_ms=600_000,
    )
    for name, stamp in stamps.items():
        assert os.stat(os.path.join(work, name)).st_mtime_ns == stamp, f"{name} 被重切了"


# ── 真机 E2E（默认跳过；本机实际跑过，见报告）──────────────────────────
@pytest.mark.skipif(not E2E, reason="设 COURSE_KB_ASR_E2E=1 才跑真机 ASR（首次需下载模型）")
def test_real_asr_transcribes_synthesized_chinese_speech(tmp_path) -> None:
    """真 faster-whisper（tiny/CPU）转写 SAPI 合成的中文语音。

    素材是**本机合成**的语音波形（不依赖任何外部音频文件）。
    """
    wav = synth.synth_speech_wav(
        str(tmp_path / "speech.wav"), "今天我们讲数据库索引，B加树是最常用的结构。"
    )
    cap = A.asr_capability()
    assert cap["available"] is True, cap["reason"]
    result = A.transcribe_audio(
        wav,
        model="tiny",
        duration_ms=None,
        work_dir=str(tmp_path / "w"),
        vad_filter=False,
    )
    assert result.model == "tiny"
    assert result.lang == "zh", f"应识别为中文，实际 {result.lang}"
    assert len(result.segments) >= 1
    joined = "".join(s.text for s in result.segments)
    assert any("\u4e00" <= ch <= "\u9fff" for ch in joined), f"转写结果没有中文：{joined!r}"
    # 时间轴必须单调
    starts = [s.start for s in result.segments]
    assert starts == sorted(starts)
    print(f"\n[真机 ASR] 模型={result.model} 语言={result.lang} "
          f"段数={len(result.segments)} 耗时={result.elapsed_ms}ms 文本={joined[:80]!r}")
