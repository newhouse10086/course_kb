"""S3 字幕的测试（纯函数，断言**逐字节的具体输出**）。

覆盖 F6 的不变量：时间轴单调递增、无重叠、不越界、换行合并。
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from worker.models.video import VideoSegment  # noqa: E402
from worker.video import subtitle as S  # noqa: E402
from worker.video.errors import SubtitleParseError  # noqa: E402


def seg(i: int, start: int, end: int, text: str) -> VideoSegment:
    return VideoSegment(i=i, start=start, end=end, text=text, confidence=0.9)


# ── 时间戳格式 ──────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    ("ms", "srt", "vtt"),
    [
        (0, "00:00:00,000", "00:00:00.000"),
        (1, "00:00:00,001", "00:00:00.001"),
        (1_200, "00:00:01,200", "00:00:01.200"),
        (3_723_456, "01:02:03,456", "01:02:03.456"),
        (3_600_000, "01:00:00,000", "01:00:00.000"),
        (59_999, "00:00:59,999", "00:00:59.999"),
        (-5, "00:00:00,000", "00:00:00.000"),  # 负数按 0（SRT 不接受负时间）
    ],
)
def test_timestamp_formatting(ms: int, srt: str, vtt: str) -> None:
    assert S.ms_to_srt_ts(ms) == srt
    assert S.ms_to_vtt_ts(ms) == vtt


@pytest.mark.parametrize(
    ("text", "ms"),
    [("01:02:03,456", 3_723_456), ("01:02:03.456", 3_723_456), ("00:00:01,200", 1_200),
     ("02:03,500", 123_500), ("1.5", 1_500)],
)
def test_parse_ts(text: str, ms: int) -> None:
    assert S.parse_ts(text) == ms


def test_parse_ts_rejects_garbage() -> None:
    with pytest.raises(SubtitleParseError):
        S.parse_ts("not-a-time")


# ── 文本拼接与折行 ──────────────────────────────────────────────────────
def test_join_text_no_space_between_cjk() -> None:
    assert S.join_text("今天我们讲", "数据库索引") == "今天我们讲数据库索引"
    assert S.join_text("hello", "world") == "hello world"
    assert S.join_text("讲 B+ 树", "索引") == "讲 B+ 树索引"
    assert S.join_text("", "只有右边") == "只有右边"


def test_wrap_lines_short_line_untouched() -> None:
    assert S.wrap_lines("短句") == "短句"
    assert S.wrap_lines("一二三四五") == "一二三四五"


def test_wrap_lines_exact_breaks() -> None:
    """33 字 / 每行 10 字 → 实测 4 行，长度 [10, 9, 10, 4]（第 2 行在「，」提前断）。"""
    text = "索引是数据库里用来加速查询的数据结构，B加树是最常用的一种实现方式"
    wrapped = S.wrap_lines(text, max_chars=10)
    lines = wrapped.split("\n")
    assert lines == [
        "索引是数据库里用来加",
        "速查询的数据结构，",
        "B加树是最常用的一种",
        "实现方式",
    ]
    assert [len(ln) for ln in lines] == [10, 9, 10, 4]
    assert "".join(lines) == text, "折行不许丢字"


def test_wrap_lines_prefers_punctuation_break() -> None:
    text = "第一句话结束了。第二句话开始了，这里有很长很长很长的内容"
    lines = S.wrap_lines(text, max_chars=12).split("\n")
    assert lines == ["第一句话结束了。", "第二句话开始了，", "这里有很长很长很长的内容"]
    assert "".join(lines) == text


def test_wrap_lines_never_drops_characters() -> None:
    text = "字" * 137
    lines = S.wrap_lines(text, max_chars=20).split("\n")
    assert len(lines) == 7
    assert "".join(lines) == text


# ── 合并 + 不变量 ───────────────────────────────────────────────────────
def test_build_cues_merges_nearby_short_segments() -> None:
    """换行合并：5 条碎句（间隔 200ms）→ 1 条字幕。"""
    segs = [
        seg(0, 0, 800, "今天我"),
        seg(1, 1_000, 1_800, "们讲"),
        seg(2, 2_000, 2_800, "数据库"),
        seg(3, 3_000, 3_800, "索引原"),
        seg(4, 4_000, 4_800, "理"),
    ]
    cues = S.build_cues(segs, duration_ms=10_000)
    assert len(cues) == 1, [c.to_dict() for c in cues]
    assert (cues[0].start, cues[0].end) == (0, 4_800)
    assert cues[0].text == "今天我们讲数据库索引原理"


def test_build_cues_splits_on_long_gap() -> None:
    """间隔 5 秒（> MAX_GAP_MS=800）→ 不许合并成一条。"""
    segs = [seg(0, 0, 1_000, "第一段"), seg(1, 6_000, 7_000, "第二段")]
    cues = S.build_cues(segs, duration_ms=10_000)
    assert [(c.start, c.end, c.text) for c in cues] == [
        (0, 1_000, "第一段"),
        (6_000, 7_000, "第二段"),
    ]


def test_build_cues_splits_when_too_long() -> None:
    """单条字幕字符数上限（42）会被遵守。"""
    segs = [seg(i, i * 1_100, i * 1_100 + 1_000, "一二三四五六七八九十") for i in range(8)]
    cues = S.build_cues(segs, duration_ms=60_000)
    assert len(cues) == 2, [(c.start, c.end, len(c.text)) for c in cues]
    for cue in cues:
        assert len(cue.text.replace("\n", "")) <= S.MAX_CUE_CHARS


def test_build_cues_drops_empty_segments() -> None:
    segs = [seg(0, 0, 1_000, "  "), seg(1, 2_000, 3_000, "有内容"), seg(2, 4_000, 5_000, "")]
    cues = S.build_cues(segs, duration_ms=10_000)
    assert len(cues) == 1
    assert cues[0].text == "有内容"


def test_build_cues_sorts_unordered_input() -> None:
    segs = [seg(0, 5_000, 6_000, "第二"), seg(1, 0, 1_000, "第一")]
    cues = S.build_cues(segs, duration_ms=10_000, max_gap_ms=100)
    assert [c.text for c in cues] == ["第一", "第二"]
    assert [c.start for c in cues] == [0, 5_000]


def test_build_cues_fixes_overlap_from_chunk_stitching() -> None:
    """分段转写拼接处的重叠（很常见）必须被拉直：不许出现两条同秒。"""
    segs = [seg(0, 0, 5_000, "前半句很长很长内容"), seg(1, 4_000, 9_000, "后半句也很长内容")]
    cues = S.build_cues(segs, duration_ms=10_000, max_gap_ms=0)
    S.validate_timeline(cues, duration_ms=10_000)
    assert cues[0].end <= cues[1].start
    assert [(c.start, c.end) for c in cues] == [(0, 5_000), (5_000, 9_000)]


def test_build_cues_clamps_to_duration() -> None:
    segs = [seg(0, 8_000, 99_000, "越界的内容要被裁到片长")]
    cues = S.build_cues(segs, duration_ms=10_000)
    assert cues[0].end == 10_000
    S.validate_timeline(cues, duration_ms=10_000)


def test_build_cues_enforces_min_duration_but_not_overrun() -> None:
    """极短段（10ms）补到 MIN_CUE_MS，但**不许**顶穿下一条。"""
    segs = [seg(0, 0, 10, "啊"), seg(1, 6_000, 6_500, "哦")]
    cues = S.build_cues(segs, duration_ms=10_000)
    assert cues[0].end - cues[0].start == S.MIN_CUE_MS
    assert cues[0].end <= cues[1].start


def test_validate_timeline_detects_violations() -> None:
    with pytest.raises(SubtitleParseError, match="重叠"):
        S.validate_timeline([S.Cue(0, 5_000, "a"), S.Cue(4_000, 6_000, "b")])
    with pytest.raises(SubtitleParseError, match="越界"):
        S.validate_timeline([S.Cue(0, 11_000, "a")], duration_ms=10_000)
    with pytest.raises(SubtitleParseError, match="<="):
        S.validate_timeline([S.Cue(5_000, 5_000, "a")])


def test_enforce_timeline_is_idempotent() -> None:
    raw = [S.Cue(0, 1_000, "a"), S.Cue(500, 1_500, "b"), S.Cue(9_500, 20_000, "c")]
    once = S.enforce_timeline(raw, duration_ms=10_000)
    twice = S.enforce_timeline(once, duration_ms=10_000)
    assert [c.to_dict() for c in once] == [c.to_dict() for c in twice]


# ── 序列化 ──────────────────────────────────────────────────────────────
def test_to_srt_exact_text() -> None:
    segs = [seg(0, 0, 1_200, "第一句"), seg(1, 6_000, 8_400, "第二句")]
    srt = S.segments_to_srt(segs, duration_ms=10_000)
    assert srt == (
        "1\n"
        "00:00:00,000 --> 00:00:01,200\n"
        "第一句\n"
        "\n"
        "2\n"
        "00:00:06,000 --> 00:00:08,400\n"
        "第二句\n"
    )


def test_to_vtt_exact_text() -> None:
    segs = [seg(0, 0, 1_200, "第一句")]
    vtt = S.segments_to_vtt(segs, duration_ms=10_000)
    assert vtt == "WEBVTT\n\n00:00:00.000 --> 00:00:01.200\n第一句\n"


def test_srt_cue_count_and_boundaries() -> None:
    """验收要求的具体值：字幕条数 + 首尾时间戳（5 段，每段 4s 间隔 1s）。"""
    segs = [seg(i, i * 4_000, i * 4_000 + 3_000, f"第{i + 1}段内容") for i in range(5)]
    cues = S.build_cues(segs, duration_ms=20_000)
    srt = S.to_srt(cues)
    assert len(cues) == 5
    assert [c.start for c in cues] == [0, 4_000, 8_000, 12_000, 16_000]
    assert [c.end for c in cues] == [3_000, 7_000, 11_000, 15_000, 19_000]
    assert srt.startswith("1\n00:00:00,000 --> 00:00:03,000\n第1段内容\n")
    assert "5\n00:00:16,000 --> 00:00:19,000\n第5段内容\n" in srt
    assert srt.count("-->") == 5


def test_srt_monotonic_and_non_overlapping_under_stress() -> None:
    """随机（固定种子）1000 段，含重叠与乱序 → 输出必须仍然严格单调不重叠。"""
    import random

    rnd = random.Random(20261014)
    segs = []
    t = 0
    for i in range(1_000):
        start = t + rnd.randint(-500, 900)
        start = max(0, start)
        dur = rnd.randint(200, 3_000)
        segs.append(seg(i, start, start + dur, f"内容{i}"))
        t = start + dur
    cues = S.build_cues(segs, duration_ms=3_600_000)
    S.validate_timeline(cues, duration_ms=3_600_000)
    assert len(cues) > 200
    starts = [c.start for c in cues]
    assert starts == sorted(starts)
    assert all(b.end <= c.start for b, c in zip(cues, cues[1:])), "出现了重叠"
    assert cues[-1].end <= 3_600_000


# ── 反向解析（坑 10 降级路径：手动上传字幕）────────────────────────────
def test_parse_srt_round_trip() -> None:
    segs = [seg(0, 0, 1_200, "第一句"), seg(1, 6_000, 8_400, "第二句很长的一句话")]
    srt = S.segments_to_srt(segs, duration_ms=10_000)
    cues = S.parse_srt(srt)
    assert [(c.start, c.end, c.text) for c in cues] == [
        (0, 1_200, "第一句"),
        (6_000, 8_400, "第二句很长的一句话"),
    ]


def test_parse_vtt_round_trip_with_multiline() -> None:
    vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n第一行\n第二行\n"
    cues = S.parse_srt(vtt)
    assert len(cues) == 1
    assert cues[0].text == "第一行\n第二行"
    assert (cues[0].start, cues[0].end) == (1_000, 3_000)


def test_parse_srt_rejects_empty_and_garbage() -> None:
    with pytest.raises(SubtitleParseError):
        S.parse_srt("")
    with pytest.raises(SubtitleParseError):
        S.parse_srt("这里没有任何时间轴")
