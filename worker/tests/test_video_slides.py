"""S7 抽帧的测试（**真实调用 ffmpeg**，素材自合成）。

本机实测的确定性数值（测试直接断言这些值，见 ``synth`` 模块文档）：
* 黑白交替视频（每段 3s）→ 场景检测**恰好 3 帧**：``3000/6000/9000ms``（每次得分 1.0）
* 默认配色（red/green/blue/white）→ **恰好 1 帧 @ 9000ms**
  （红→绿得分 0.3988，**刚好卡在 0.4 阈值下面**）
* 单色视频 → 场景检测 0 帧 → 等间隔兜底 **1 帧 @ 0ms**
* 本机装了 ``rapidocr_onnxruntime`` → OCR **可用**，能识别 drawtext 画上去的文字
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from worker.models.video import SLIDE_KIND_IMAGE  # noqa: E402
from worker.video import slides as SL  # noqa: E402
from worker.video import synth  # noqa: E402

DUR_MS = 12_000


@pytest.fixture(scope="module")
def cut_video(tmp_path_factory) -> str:
    """黑白交替 → 3 次满对比度切换（稳定过 0.4 阈值）。"""
    d = tmp_path_factory.mktemp("s7")
    return synth.synth_video(
        str(d / "cuts.mp4"), duration_ms=DUR_MS, colors=synth.SCENE_COLORS
    )


@pytest.fixture(scope="module")
def default_color_video(tmp_path_factory) -> str:
    """默认配色（红绿蓝白）→ 只有蓝→白过阈值。"""
    d = tmp_path_factory.mktemp("s7c")
    return synth.synth_video(str(d / "rg.mp4"), duration_ms=DUR_MS)


@pytest.fixture(scope="module")
def solid_video(tmp_path_factory) -> str:
    d = tmp_path_factory.mktemp("s7b")
    return synth.synth_video(str(d / "solid.mp4"), duration_ms=DUR_MS, colors=("gray",))


# ── 场景检测（具体时间点）──────────────────────────────────────────────
def test_scene_detection_exact_timestamps(cut_video: str, tmp_path) -> None:
    frames = SL.detect_frames(cut_video, str(tmp_path / "frames"), duration_ms=DUR_MS)
    assert [(f.index, f.at_ms) for f in frames] == [(1, 3_000), (2, 6_000), (3, 9_000)]
    assert all(f.mode == "scene" for f in frames)
    assert all(f.kind == SLIDE_KIND_IMAGE for f in frames)
    for f in frames:
        assert os.path.isfile(f.image), f"帧图没落盘：{f.image}"
        with open(f.image, "rb") as fh:
            assert fh.read(3) == b"\xff\xd8\xff", f"不是合法 JPEG：{f.image}"
        # 纯黑/纯白帧压得很小（实测 671 字节），所以只断言"是个真文件"
        assert os.path.getsize(f.image) > 200


def test_threshold_controls_how_many_frames(cut_video: str, tmp_path) -> None:
    """阈值 1.0 → 连满分 1.0 的切换也不过线（``gt`` 是严格大于）→ 空结果。

    且**不抛异常**：0 帧是合法结果（坑 16：本机此时 ffmpeg 退出码 -22
    并报一个误导性的 mjpeg 编码器错误，代码里必须把它识别成"没有帧"）。
    """
    frames = SL.detect_frames(
        cut_video, str(tmp_path / "hi"), duration_ms=DUR_MS, threshold=1.0, mode="scene"
    )
    assert frames == []


def test_low_contrast_cut_scores_below_threshold(default_color_video: str, tmp_path) -> None:
    """红→绿得分 0.3988 < 0.4 → 默认阈值下**不应该**抽到那一帧。

    这条断言把"阈值 0.4 是干什么的"钉死了：它是真实的分界线，不是装饰。
    """
    frames = SL.detect_frames(
        default_color_video, str(tmp_path / "rg"), duration_ms=DUR_MS, mode="scene"
    )
    assert [(f.index, f.at_ms) for f in frames] == [(1, 9_000)], "只有蓝→白(1.0)过线"


def test_scene_detection_respects_threshold(cut_video: str, tmp_path) -> None:
    """阈值 1.0 → 没有任何切换能过线（``gt`` 是严格大于）→ 空结果，且**不抛异常**。

    本机实测：0 帧时 ffmpeg 退出码 -22 并报 "mjpeg 编码器打开失败" 这种误导性错误，
    代码必须把它识别成"没有帧"（坑 16）。
    """
    frames = SL.detect_frames(
        cut_video, str(tmp_path / "hi"), duration_ms=DUR_MS, threshold=1.0, mode="scene"
    )
    assert frames == []


def test_low_threshold_finds_more_frames(default_color_video: str, tmp_path) -> None:
    """阈值 0.01 → 实测 2 帧 [6000, 9000]；阈值 0.4 → 只有 1 帧 [9000]。

    （默认配色下两次切换得分实测 0.3988 与 1.0；0.3988 卡在 0.4 下面。）
    """
    low = SL.detect_frames(
        default_color_video, str(tmp_path / "low"), duration_ms=DUR_MS, threshold=0.01, mode="scene"
    )
    assert [f.at_ms for f in low] == [6_000, 9_000]
    high = SL.detect_frames(
        default_color_video, str(tmp_path / "high"), duration_ms=DUR_MS, threshold=0.4, mode="scene"
    )
    assert [f.at_ms for f in high] == [9_000]
    assert len(low) > len(high)


def test_fallback_to_interval_when_no_scene_change(solid_video: str, tmp_path) -> None:
    """纯色视频没有场景切换 → auto 模式退化为等间隔，**并如实标注 mode=interval**。"""
    frames = SL.detect_frames(solid_video, str(tmp_path / "solid"), duration_ms=DUR_MS)
    assert [(f.index, f.at_ms, f.mode) for f in frames] == [(1, 0, "interval")]


def test_interval_mode_is_deterministic(solid_video: str, tmp_path) -> None:
    frames = SL.detect_frames(
        solid_video,
        str(tmp_path / "iv"),
        duration_ms=DUR_MS,
        mode="interval",
        fallback_interval_ms=3_000,
    )
    assert [f.at_ms for f in frames] == [0, 3_000, 6_000, 9_000]
    assert all(f.mode == "interval" for f in frames)


def test_scene_mode_does_not_fall_back(solid_video: str, tmp_path) -> None:
    """明确要求 scene 模式时，不许偷偷换成等间隔（不许把兜底当检测结果）。"""
    assert SL.detect_frames(
        solid_video, str(tmp_path / "s"), duration_ms=DUR_MS, mode="scene"
    ) == []


def test_max_frames_truncates(cut_video: str, tmp_path) -> None:
    frames = SL.detect_frames(cut_video, str(tmp_path / "m"), duration_ms=DUR_MS, max_frames=1)
    assert len(frames) == 1
    assert frames[0].at_ms == 3_000


def test_min_gap_dedupes_frames(cut_video: str, tmp_path) -> None:
    """黑白视频抽到 3000/6000/9000；min_gap=5000 → 6000 那帧被压掉。"""
    frames = SL.detect_frames(
        cut_video, str(tmp_path / "g"), duration_ms=DUR_MS, min_gap_ms=5_000
    )
    times = [f.at_ms for f in frames]
    assert times == [3_000, 9_000], times
    assert all(b - a >= 5_000 for a, b in zip(times, times[1:])), times
    assert [f.index for f in frames] == [1, 2]


def test_frames_are_within_duration(default_color_video: str, tmp_path) -> None:
    frames = SL.detect_frames(
        default_color_video, str(tmp_path / "b"), duration_ms=DUR_MS, threshold=0.01
    )
    assert [f.at_ms for f in frames] == [6_000, 9_000]
    assert all(0 <= f.at_ms <= DUR_MS for f in frames)


def test_rejects_file_without_video_stream(tmp_path) -> None:
    from worker.video.errors import MediaProbeError

    wav = synth.synth_audio(str(tmp_path / "tone.wav"), duration_ms=2_000)
    with pytest.raises(MediaProbeError) as ei:
        SL.detect_frames(wav, str(tmp_path / "f"), duration_ms=2_000)
    assert ei.value.code == "E_NO_VIDEO"


def test_reruns_do_not_accumulate_stale_frames(cut_video: str, tmp_path) -> None:
    """重跑必须清掉上次的帧图：同样的参数跑两次，帧数**不翻倍**。

    不清的话第二次会拿到 6 张图 + 3 个时间点 → 时间点错配（真发生过）。
    """
    out = str(tmp_path / "re")
    first = SL.detect_frames(cut_video, out, duration_ms=DUR_MS, threshold=0.01)
    count_after_first = len(os.listdir(out))
    second = SL.detect_frames(cut_video, out, duration_ms=DUR_MS, threshold=0.01)
    assert [f.at_ms for f in second] == [f.at_ms for f in first]
    assert len(os.listdir(out)) == count_after_first, "上次的帧图没清干净"
    assert len(os.listdir(out)) == len(second), "磁盘上的帧数应与返回的帧数一致"


def test_max_frames_does_not_break_timestamp_mapping(cut_video: str, tmp_path) -> None:
    """截断到 1 帧时，时间点仍必须来自**真实的 showinfo**，不能瞎补。"""
    frames = SL.detect_frames(cut_video, str(tmp_path / "t"), duration_ms=DUR_MS, max_frames=1)
    assert [f.at_ms for f in frames] == [3_000]
    assert os.path.isfile(frames[0].image)


def test_report_progress_monotonically(cut_video: str, tmp_path) -> None:
    seen: list[float] = []
    SL.detect_frames(
        cut_video,
        str(tmp_path / "p"),
        duration_ms=DUR_MS,
        on_progress=lambda f, s: seen.append(f),
    )
    assert seen == sorted(seen)
    assert seen


# ── 去重 / 上限 ─────────────────────────────────────────────────────────
def test_dedupe_frames_keeps_earliest_and_renumbers() -> None:
    frames = [
        SL.SlideFrame(9, 1_000, "a.jpg"),
        SL.SlideFrame(8, 1_500, "b.jpg"),
        SL.SlideFrame(7, 2_600, "c.jpg"),
        SL.SlideFrame(6, 3_000, "d.jpg"),
    ]
    out = SL.dedupe_frames(frames, min_gap_ms=1_000)
    assert [(f.index, f.at_ms, f.image) for f in out] == [
        (1, 1_000, "a.jpg"),
        (2, 2_600, "c.jpg"),
    ]


# ── 坑 11：图片帧 ≠ 可编辑 PPT ─────────────────────────────────────────
def test_image_frame_label_when_no_ocr() -> None:
    frame = SL.SlideFrame(index=1, at_ms=30_000, image="slide_00001.jpg")
    slide = frame.to_video_slide()
    assert slide.title == SL.IMAGE_FRAME_LABEL == "图片帧"
    assert slide.ocr_text == ""
    assert slide.index == 1 and slide.at_ms == 30_000


def test_ocr_text_becomes_title() -> None:
    frame = SL.SlideFrame(index=1, at_ms=30_000, image="x.jpg", ocr_text="索引结构\n更多内容")
    assert frame.to_video_slide().title == "索引结构"


def test_ocr_availability_is_honest() -> None:
    cap = SL.ocr_availability()
    assert set(cap) == {"available", "engine", "reason"}
    if cap["available"]:
        assert cap["engine"] in ("tesseract", "easyocr", "paddleocr", "rapidocr")
        assert cap["engine"] in cap["reason"]
    else:
        assert cap["engine"] == ""
        assert "图片帧" in cap["reason"]
        assert "可编辑 PPT" in cap["reason"], "不可用时必须说明不承诺可编辑 PPT（坑 11）"


def test_attach_ocr_without_engine_returns_zero_and_keeps_frames(monkeypatch) -> None:
    """没有 OCR 引擎 → 一帧也不改，返回 0，并保留"图片帧"标注（坑 11）。"""
    monkeypatch.setattr(
        SL, "ocr_availability", lambda: {"available": False, "engine": "", "reason": "没有引擎"}
    )
    frames = [SL.SlideFrame(1, 0, "a.jpg"), SL.SlideFrame(2, 1_000, "b.jpg")]
    assert SL.attach_ocr(frames) == 0
    assert all(f.ocr_text == "" for f in frames)
    assert all(f.to_video_slide().title == "图片帧" for f in frames)


@pytest.mark.skipif(not SL.ocr_availability()["available"], reason="本机没有 OCR 引擎")
def test_real_ocr_reads_drawn_text(tmp_path) -> None:
    """真机 OCR：把文字画进视频第一帧，抽出来必须能读到（本机 rapidocr 实测可用）。"""
    video = synth.synth_video(
        str(tmp_path / "text.mp4"), duration_ms=DUR_MS, text="Index B+Tree 42"
    )
    frames = SL.detect_frames(video, str(tmp_path / "frames"), duration_ms=DUR_MS, mode="scene")
    assert frames, "至少应抽到一帧（阈值降到 0.01 才能确保有切换）"
    hits = SL.attach_ocr(frames[:1])
    text = frames[0].ocr_text
    assert hits == 1, f"OCR 应识别出文字，实际 {text!r}"
    assert "Index" in text, text
    assert frames[0].kind == "ocr_text"
    assert frames[0].to_video_slide().title.startswith("Index")
