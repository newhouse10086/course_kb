"""S4/S5 文稿分章的测试。

核心验收项：**分章时间轴覆盖全片且不越界** —— 这里用很多组构造数据去撞它，
包括"ASR 段落之间有静音间隙"（实测 200ms 很常见，正是它让第一版实现翻车）。
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from worker.models.video import TranscriptChapter, VideoSegment  # noqa: E402
from worker.video import transcript as T  # noqa: E402
from worker.video.errors import TextModelSchemaError  # noqa: E402


def seg(i: int, start: int, end: int, text: str) -> VideoSegment:
    return VideoSegment(i=i, start=start, end=end, text=text, confidence=0.9)


def make_segments(n: int, *, step: int = 4_000, dur: int = 3_000, gap: int = 0) -> list[VideoSegment]:
    return [
        seg(i, i * (step + gap), i * (step + gap) + dur, f"第{i}句台词内容")
        for i in range(n)
    ]


# ── schema（坑 4：必须 strict）──────────────────────────────────────────
def test_chapters_schema_is_strict() -> None:
    assert T.CHAPTERS_SCHEMA["additionalProperties"] is False
    assert set(T.CHAPTERS_SCHEMA["required"]) == {"chapters", "summary"}
    item = T.CHAPTERS_SCHEMA["properties"]["chapters"]["items"]
    assert item["additionalProperties"] is False
    assert set(item["required"]) == {"title", "start_i", "end_i", "summary"}
    assert item["properties"]["start_i"]["type"] == "integer"
    assert T.CHAPTERS_SCHEMA["properties"]["chapters"]["maxItems"] == T.MAX_CHAPTERS == 8


def test_summary_schema_is_strict() -> None:
    assert T.SUMMARY_SCHEMA["additionalProperties"] is False
    assert T.SUMMARY_SCHEMA["required"] == ["summary"]


# ── 解析模型输出 ────────────────────────────────────────────────────────
def test_parse_chapters_index_form() -> None:
    segs = make_segments(6)
    raw, summary = T.parse_chapters(
        {"chapters": [{"title": "一", "start_i": 0, "end_i": 2, "summary": "s1"},
                      {"title": "二", "start_i": 3, "end_i": 5, "summary": "s2"}],
         "summary": "总述"},
        segments=segs,
    )
    assert [(c.title, c.start_i, c.end_i) for c in raw] == [("一", 0, 2), ("二", 3, 5)]
    assert summary == "总述"


def test_parse_chapters_millisecond_form() -> None:
    """模型偶尔按毫秒给边界（没有 *_i 字段）→ 转成段号，不许混用两种单位。"""
    segs = make_segments(6)
    raw, _ = T.parse_chapters(
        {"chapters": [{"title": "前半", "start": 0, "end": 11_000, "summary": ""},
                      {"title": "后半", "start": 12_000, "end": 23_000, "summary": ""}]},
        segments=segs,
    )
    assert [(c.start_i, c.end_i) for c in raw] == [(0, 2), (3, 5)]


def test_parse_chapters_tolerates_small_overshoot() -> None:
    """模型常见的"1-based 差一 / 末尾多算一段"→ 夹回范围，不报错。"""
    segs = make_segments(10)
    raw, _ = T.parse_chapters(
        {"chapters": [{"title": "全片", "start_i": 1, "end_i": 10, "summary": ""}]},
        segments=segs,
    )
    assert (raw[0].start_i, raw[0].end_i) == (1, 9)


def test_parse_chapters_rejects_wild_overshoot() -> None:
    """大幅越界 = 单位用错了（把毫秒当段号）→ **必须报错**，不许悄悄夹掉。"""
    segs = make_segments(10)
    with pytest.raises(TextModelSchemaError, match="越界太多"):
        T.parse_chapters(
            {"chapters": [{"title": "全片", "start_i": 0, "end_i": 999_999, "summary": ""}]},
            segments=segs,
        )


def test_parse_chapters_rejects_reversed_and_missing() -> None:
    segs = make_segments(5)
    with pytest.raises(TextModelSchemaError, match="end_i"):
        T.parse_chapters(
            {"chapters": [{"title": "反了", "start_i": 3, "end_i": 1, "summary": ""}]},
            segments=segs,
        )
    with pytest.raises(TextModelSchemaError, match="chapters"):
        T.parse_chapters({"chapters": []}, segments=segs)
    with pytest.raises(TextModelSchemaError, match="JSON 对象"):
        T.parse_chapters("不是对象", segments=segs)
    with pytest.raises(TextModelSchemaError, match="既没有"):
        T.parse_chapters(
            {"chapters": [{"title": "没法定位", "summary": ""}]}, segments=segs
        )


# ── 归一化：覆盖全片 + 不越界 ───────────────────────────────────────────
def test_normalize_covers_whole_video_with_gaps_between_segments() -> None:
    """★ 关键回归：段落之间有静音间隙时，分章仍必须首尾相接覆盖全片。"""
    segs = [
        seg(0, 0, 3_000, "第一句"),
        seg(1, 3_200, 5_816, "第二句"),   # 与前一条有 200ms 间隙
        seg(2, 6_016, 8_824, "第三句"),   # 间隙 200ms
        seg(3, 9_024, 12_000, "第四句"),
    ]
    raw = [T.RawChapter("上半", 0, 1), T.RawChapter("下半", 2, 3)]
    chapters = T.normalize_chapters(raw, segs, duration_ms=12_000, max_chapters=8)
    T.validate_coverage(chapters, 12_000)
    assert [(c.title, c.start, c.end) for c in chapters] == [
        ("上半", 0, 5_816),
        ("下半", 5_816, 12_000),
    ]


def test_normalize_enforces_max_chapters_by_merging() -> None:
    """给 10 章候选、上限 8 → 必须合并成 8 章，且仍然覆盖全片。"""
    segs = make_segments(10, step=1_000, dur=900)
    dur = 10_000
    raw = [T.RawChapter(f"章{i}", i, i) for i in range(10)]
    chapters = T.normalize_chapters(raw, segs, duration_ms=dur, max_chapters=8)
    assert len(chapters) == 8
    T.validate_coverage(chapters, dur)
    assert chapters[0].start == 0 and chapters[-1].end == dur


def test_normalize_forces_first_chapter_to_zero() -> None:
    """模型从第 3 段开始分章 → 前两段必须并进第一章（不许留空洞）。"""
    segs = make_segments(6)
    dur = 24_000
    raw = [T.RawChapter("从中间开始", 2, 5)]
    chapters = T.normalize_chapters(raw, segs, duration_ms=dur, max_chapters=8)
    assert chapters[0].start == 0
    T.validate_coverage(chapters, dur)
    assert "第0句台词内容" in chapters[0].text
    assert "第5句台词内容" in chapters[0].text


def test_normalize_extends_last_chapter_to_end() -> None:
    """最后一章只到第 2 段，但视频有 6 段 → 必须吃到片尾。"""
    segs = make_segments(6)
    dur = 24_000
    raw = [T.RawChapter("只有一章", 0, 2)]
    chapters = T.normalize_chapters(raw, segs, duration_ms=dur, max_chapters=8)
    assert chapters[-1].end == dur
    assert "第5句台词内容" in chapters[-1].text


def test_normalize_clamps_chapters_beyond_duration() -> None:
    segs = [seg(0, 0, 2_000, "a"), seg(1, 2_000, 99_000, "越界的段")]
    chapters = T.normalize_chapters(
        [T.RawChapter("全片", 0, 1)], segs, duration_ms=10_000, max_chapters=8
    )
    T.validate_coverage(chapters, 10_000)
    assert chapters[-1].end == 10_000


def test_normalize_never_emits_empty_chapter() -> None:
    """零长度章（模型把两章指到同一段）→ 合并，不许产出 [x,x] 章节。"""
    segs = make_segments(4)
    raw = [T.RawChapter("一", 0, 0), T.RawChapter("二", 1, 1), T.RawChapter("三", 2, 3)]
    chapters = T.normalize_chapters(raw, segs, duration_ms=16_000, max_chapters=8)
    for ch in chapters:
        assert ch.end > ch.start
    T.validate_coverage(chapters, 16_000)


def test_normalize_chapter_text_matches_its_time_range() -> None:
    """章文字必须是落在该章时间范围内的台词（不许串台）。"""
    segs = make_segments(4, step=5_000, dur=4_000)  # 0-4k, 5k-9k, 10k-14k, 15k-19k
    chapters = T.normalize_chapters(
        [T.RawChapter("一", 0, 0), T.RawChapter("二", 1, 3)],
        segs,
        duration_ms=20_000,
        max_chapters=8,
    )
    assert chapters[0].text == "第0句台词内容"
    assert "第1句台词内容" in chapters[1].text
    assert "第3句台词内容" in chapters[1].text


def test_normalize_is_insensitive_to_input_order() -> None:
    segs = make_segments(6)
    a = T.normalize_chapters(
        [T.RawChapter("一", 3, 5), T.RawChapter("二", 0, 2)], segs, duration_ms=24_000, max_chapters=8
    )
    b = T.normalize_chapters(
        [T.RawChapter("二", 0, 2), T.RawChapter("一", 3, 5)], segs, duration_ms=24_000, max_chapters=8
    )
    assert [c.to_dict() for c in a] == [c.to_dict() for c in b]


def test_validate_coverage_catches_gap_and_overrun() -> None:
    with pytest.raises(TextModelSchemaError, match="不相接"):
        T.validate_coverage(
            [TranscriptChapter("a", 0, 5_000), TranscriptChapter("b", 6_000, 10_000)], 10_000
        )
    with pytest.raises(TextModelSchemaError, match="越界"):
        T.validate_coverage([TranscriptChapter("a", 0, 11_000)], 10_000)
    with pytest.raises(TextModelSchemaError, match="首章"):
        T.validate_coverage([TranscriptChapter("a", 100, 10_000)], 10_000)
    with pytest.raises(TextModelSchemaError, match="末章"):
        T.validate_coverage([TranscriptChapter("a", 0, 9_000)], 10_000)
    with pytest.raises(TextModelSchemaError, match="为空"):
        T.validate_coverage([], 10_000)


def test_validate_coverage_accepts_valid_chain() -> None:
    T.validate_coverage(
        [
            TranscriptChapter("a", 0, 5_000),
            TranscriptChapter("b", 5_000, 8_000),
            TranscriptChapter("c", 8_000, 10_000),
        ],
        10_000,
    )


# ── 机械分节（LLM 不可用的如实降级）────────────────────────────────────
def test_mechanical_chapters_cuts_at_real_silence_gaps() -> None:
    """按**真实静音间隙**切（不是编造内容）：两处大间隙 → 3 节。"""
    segs = [
        seg(0, 0, 3_000, "A1"), seg(1, 3_500, 6_000, "A2"),
        seg(2, 20_000, 23_000, "B1"), seg(3, 23_500, 26_000, "B2"),
        seg(4, 40_000, 43_000, "C1"), seg(5, 43_500, 46_000, "C2"),
    ]
    chapters = T.mechanical_chapters(segs, duration_ms=46_000, max_chapters=8)
    assert len(chapters) == 3
    assert [c.title for c in chapters] == ["分节 1", "分节 2", "分节 3"]
    assert [(c.start, c.end) for c in chapters] == [(0, 6_000), (6_000, 26_000), (26_000, 46_000)]
    T.validate_coverage(chapters, 46_000)


def test_mechanical_chapters_respects_cap() -> None:
    segs = [
        seg(i, i * 10_000, i * 10_000 + 5_000, f"句{i}") for i in range(10)
    ]
    chapters = T.mechanical_chapters(segs, duration_ms=100_000, max_chapters=4)
    assert len(chapters) == 4
    T.validate_coverage(chapters, 100_000)


def test_mechanical_chapters_single_when_no_gaps() -> None:
    segs = [seg(i, i * 1_000, i * 1_000 + 900, f"句{i}") for i in range(5)]
    chapters = T.mechanical_chapters(segs, duration_ms=5_000, max_chapters=8)
    assert len(chapters) == 1
    T.validate_coverage(chapters, 5_000)


# ── 编排（注入 LLM）────────────────────────────────────────────────────
def test_analyze_transcript_with_llm() -> None:
    segs = make_segments(6)
    calls: list[tuple[str, dict]] = []

    def fake_llm(prompt: str, schema: dict) -> dict:
        calls.append((prompt, schema))
        return {
            "chapters": [
                {"title": "索引概念", "start_i": 0, "end_i": 2, "summary": "讲概念"},
                {"title": "B加树", "start_i": 3, "end_i": 5, "summary": "讲结构"},
            ],
            "summary": "整篇摘要",
        }

    res = T.analyze_transcript(fake_llm, segs, duration_ms=24_000, video_title="索引课")
    assert res.source == "llm"
    assert res.summary == "整篇摘要"
    assert [c.title for c in res.chapters] == ["索引概念", "B加树"]
    T.validate_coverage(res.chapters, 24_000)
    assert len(calls) == 1, "不超过一个窗口时只调一次 LLM"
    assert "24_000" in calls[0][0] or "00:00:24" in calls[0][0], "提示词要带时长"
    assert calls[0][1] is T.CHAPTERS_SCHEMA, "必须传 strict schema（坑 4）"


def test_analyze_transcript_degrades_to_mechanical_when_llm_raises() -> None:
    """LLM 挂了 → **如实降级**成机械分节，标注 source=mechanical，不编造标题。"""
    segs = make_segments(6)

    def broken(prompt: str, schema: dict) -> dict:
        raise RuntimeError("502 Bad Gateway")

    res = T.analyze_transcript(broken, segs, duration_ms=24_000)
    assert res.source == "mechanical"
    assert res.summary == ""
    assert all(c.title.startswith("分节") for c in res.chapters)
    assert "LLM" in res.note
    T.validate_coverage(res.chapters, 24_000)


def test_analyze_transcript_without_llm_is_mechanical() -> None:
    segs = make_segments(6)
    res = T.analyze_transcript(None, segs, duration_ms=24_000)
    assert res.source == "mechanical"
    assert res.note == "LLM 不可用"
    T.validate_coverage(res.chapters, 24_000)


def test_analyze_transcript_without_segments_reports_none() -> None:
    res = T.analyze_transcript(None, [], duration_ms=10_000)
    assert res.chapters == []
    assert res.source == "none"


def test_analyze_transcript_splits_long_transcripts_into_windows() -> None:
    """长视频：超字数上限 → 分窗口**串行**调用（并发=1），最终仍覆盖全片。"""
    segs = make_segments(40, step=2_000, dur=1_800)
    segs = [VideoSegment(i=s.i, start=s.start, end=s.end, text=s.text * 40, confidence=0.9) for s in segs]
    assert len(T.plan_windows(segs)) > 1
    calls: list[str] = []

    def fake_llm(prompt: str, schema: dict) -> dict:
        calls.append(prompt)
        # 每个窗口返回一章（用窗口内的段号范围）
        return {"chapters": [{"title": "窗口章", "start_i": 0, "end_i": 0, "summary": "s"}],
                "summary": "摘要"}

    res = T.analyze_transcript(fake_llm, segs, duration_ms=80_000, max_chapters=8)
    assert len(calls) == len(T.plan_windows(segs))
    assert len(calls) > 1
    T.validate_coverage(res.chapters, 80_000)
    assert len(res.chapters) <= 8


def test_plan_windows_covers_every_segment_exactly_once() -> None:
    segs = make_segments(30, step=2_000, dur=1_800)
    segs = [VideoSegment(i=s.i, start=s.start, end=s.end, text=s.text * 30, confidence=0.9) for s in segs]
    windows = T.plan_windows(segs)
    assert windows[0][0] == 0
    assert windows[-1][1] == len(segs) - 1
    covered: list[int] = []
    for a, b in windows:
        assert a <= b
        covered.extend(range(a, b + 1))
    assert covered == list(range(len(segs))), "窗口必须无缝且不重复覆盖"


def test_segments_digest_includes_index_and_timestamp() -> None:
    segs = [seg(0, 65_000, 68_000, "第一句"), seg(1, 70_000, 72_000, "第二句")]
    digest = T.segments_digest(segs, start_i=5)
    assert digest.splitlines() == ["[5] 00:01:05 第一句", "[6] 00:01:10 第二句"]
