"""VideoAdapter 的测试：契约 §4（``DocDraft``/``UnitDraft``/``span.kind=time``）+ 注册表集成。

重点：
* ``span.kind`` **一律是 time**（毫秒），不许用 page 糊弄
* unit 必须是**有层次的**（level 1 → 2 → 3），不许整片一个 unit
* ASR 不可用时仍然切出层次结构，且**文字是空的**（不编造，坑 10/11）
* ``can_handle`` 认扩展名也认魔数，且**绝不抛异常**（registry.pick 依赖它）
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from worker.adapters.base import DocDraft, UnitDraft  # noqa: E402
from worker.adapters.registry import ADAPTERS, by_kind, pick  # noqa: E402
from worker.adapters.video import VideoAdapter  # noqa: E402
from worker.models.video import VideoSegment  # noqa: E402
from worker.video import runner as R  # noqa: E402
from worker.video import synth  # noqa: E402
from worker.video.errors import AsrUnavailable  # noqa: E402

DUR_MS = 12_000


@pytest.fixture(scope="module")
def video(tmp_path_factory) -> str:
    d = tmp_path_factory.mktemp("adapter")
    return synth.synth_video(str(d / "lesson.mp4"), duration_ms=DUR_MS, colors=synth.SCENE_COLORS)


def fake_transcribe(idx: int, chunk):
    """8 段，每段台词**故意写长**（>1200 字）——这样章内才会下钻出 level 3 块。"""
    span = max(1, chunk.duration_ms // 8)
    body = "索引用于加速查询，B加树是最常用的结构。" * 40  # 约 800 字
    return (
        [
            VideoSegment(i=k, start=k * span, end=k * span + span - 150,
                         text=f"第{k}句：{body}", confidence=0.9)
            for k in range(8)
        ],
        "zh",
        0.96,
    )


def fake_llm(prompt: str, schema: dict) -> dict:
    if "chapters" in schema.get("properties", {}):
        return {
            "chapters": [
                {"title": "索引概念", "start_i": 0, "end_i": 3, "summary": "介绍索引"},
                {"title": "B加树", "start_i": 4, "end_i": 7, "summary": "介绍结构"},
            ],
            "summary": "整篇摘要",
        }
    return {"markdown": "# 索引\n## 概念\n- 加速查询\n## 结构\n- B加树"}


# ── 注册表 ──────────────────────────────────────────────────────────────
def test_video_adapter_is_registered() -> None:
    from worker.adapters import registry

    registry.load_builtin_adapters(force=True)
    assert VideoAdapter in ADAPTERS
    assert by_kind("video") is not None
    assert isinstance(by_kind("video"), VideoAdapter)


@pytest.mark.parametrize(
    "name",
    ["a.mp4", "a.mkv", "a.mov", "a.webm", "a.avi", "a.flv", "a.m4v", "a.ts", "a.mp3", "a.wav", "a.m4a"],
)
def test_can_handle_by_extension(name: str) -> None:
    assert VideoAdapter().can_handle(name) is True


@pytest.mark.parametrize("name", ["a.pdf", "a.docx", "a.pptx", "a.txt", "a.epub", "noext"])
def test_can_handle_rejects_other_formats(name: str) -> None:
    assert VideoAdapter().can_handle(name) is False


def test_can_handle_never_raises_on_weird_paths() -> None:
    """``registry.pick`` 会遍历所有 adapter 调 ``can_handle`` → 它不能抛异常。"""
    adapter = VideoAdapter()
    for bad in ["", "\x00bad", "C:/does/not/exist.mp4", "x" * 5000, "con.mp4", "../..\\..\\x.mp4"]:
        assert adapter.can_handle(bad) in (True, False)


def test_can_handle_sniffs_magic_bytes(tmp_path) -> None:
    """文件被改名（没有扩展名）也要认得出来。"""
    import struct

    fake = tmp_path / "mystery.bin"
    fake.write_bytes(b"\x00\x00\x00\x20ftypisom" + b"\x00" * 64)
    assert VideoAdapter().can_handle(str(fake)) is True
    mkv = tmp_path / "mystery2.bin"
    mkv.write_bytes(b"\x1a\x45\xdf\xa3" + b"\x00" * 64)
    assert VideoAdapter().can_handle(str(mkv)) is True
    txt = tmp_path / "notes.bin"
    txt.write_bytes("这是一段文本".encode("utf-8"))
    assert VideoAdapter().can_handle(str(txt)) is False
    _ = struct


def test_pick_returns_video_adapter_for_real_file(video: str) -> None:
    adapter = pick(video)
    assert isinstance(adapter, VideoAdapter)


# ── probe ───────────────────────────────────────────────────────────────
def test_probe_reports_duration_and_streams(video: str) -> None:
    info = VideoAdapter().probe(video)
    assert info["duration_ms"] == DUR_MS
    assert info["has_video"] is True and info["has_audio"] is True
    assert info["kind"] == "video"
    assert info["is_audio_only"] is False
    assert info["asr"]["available"] is True


def test_probe_returns_empty_on_garbage(tmp_path) -> None:
    junk = tmp_path / "x.mp4"
    junk.write_bytes(b"not a video at all")
    assert VideoAdapter().probe(str(junk)) == {}


# ── parse → DocDraft（契约）────────────────────────────────────────────
def test_parse_produces_three_level_hierarchy(video: str, tmp_path) -> None:
    adapter = VideoAdapter(
        doc_id="doc_ad", work_dir=str(tmp_path / "w"), title="数据库索引课", llm=fake_llm
    )
    outcome = adapter.run(video, transcribe_fn=fake_transcribe)
    draft = adapter.draft_from_outcome(outcome, source_path=video)
    draft.validate()  # 契约：悬空 parent_ord / 重复 ord / span 越界 → 当场报错

    assert isinstance(draft, DocDraft)
    assert draft.kind == "video"
    assert draft.title == "数据库索引课"
    assert draft.page_count == 0, "视频没有页数，时长放 meta.duration_ms"
    assert draft.lang == "zh"

    levels = {u.level for u in draft.units}
    assert levels == {1, 2, 3}, f"必须有三层，实际 {levels}"
    roots = [u for u in draft.units if u.parent_ord is None]
    assert len(roots) == 1
    assert roots[0].level == 1
    assert roots[0].span.start == 0
    assert roots[0].span.end == draft.meta["duration_ms"]
    for u in draft.units:
        assert u.span.kind == "time", "视频必须用 time span（毫秒），不许用 page"
        assert u.span.start <= u.span.end
        assert u.level >= 1

    chapters = [u for u in draft.units if u.level == 2]
    assert [u.title for u in chapters] == ["索引概念", "B加树"]
    assert [u.span.start for u in chapters] == [0, chapters[0].span.end]
    assert chapters[-1].span.end == draft.meta["duration_ms"]
    ords = [u.ord for u in draft.units]
    assert ords == sorted(ords) and len(set(ords)) == len(ords)
    assert all(u.parent_ord in set(ords) for u in draft.units if u.parent_ord is not None)

    # 二级章下面必须挂三级块（检索粒度）
    assert [u for u in draft.units if u.level == 3]
    assert all(u.parent_ord is not None for u in draft.units if u.level == 3)


def test_parse_via_contract_signature(video: str, tmp_path) -> None:
    """按契约签名 ``parse(path, on_progress=...)`` 调用（pipeline 走的就是这条路）。"""
    seen: list[tuple[float, str]] = []
    adapter = VideoAdapter(
        doc_id="doc_parse", work_dir=str(tmp_path / "w"), title="索引课", llm=fake_llm
    )
    draft = adapter.parse(video, on_progress=lambda f, s: seen.append((f, s)))
    draft.validate()
    assert adapter.last_outcome is not None
    assert seen, "必须上报进度"
    assert [f for f, _ in seen] == sorted(f for f, _ in seen)
    assert all(0.0 <= f <= 1.0 for f, _ in seen)
    assert adapter.last_draft is draft


def test_parse_writes_outcome_json_for_restart(video: str, tmp_path) -> None:
    work = str(tmp_path / "w")
    adapter = VideoAdapter(doc_id="doc_out", work_dir=work, llm=fake_llm)
    adapter.run(video, transcribe_fn=fake_transcribe)
    loaded = VideoAdapter.load_outcome(work)
    assert loaded is not None
    assert loaded["artifact"]["doc_id"] == "doc_out"
    assert len(loaded["artifact"]["segments"]) == 8
    assert loaded["artifact"]["mindmap"]["content"].startswith("# 索引")
    assert loaded["asr_available"] is True
    assert "figures" not in loaded  # 不存在的字段不该出现（防止我以后手滑加字段）


def test_parse_failure_raises_ParseError(tmp_path) -> None:
    from worker.adapters.base import ParseError

    junk = tmp_path / "broken.mp4"
    junk.write_bytes(b"\x00\x00\x00\x20ftypisom" + b"\x11" * 200)  # 有 mp4 魔数但坏文件
    with pytest.raises(ParseError):
        VideoAdapter(doc_id="doc_bad", work_dir=str(tmp_path / "w")).parse(str(junk))


# ── 坑 10：ASR 不可用时的 draft 仍然有结构，但没有编造文字 ─────────────
def test_draft_without_asr_has_structure_but_no_invented_text(video: str, tmp_path) -> None:
    def broken(idx, chunk):
        raise AsrUnavailable("模型加载失败", detail="模拟", code="E_ASR_LOAD")

    adapter = VideoAdapter(doc_id="doc_noasr", work_dir=str(tmp_path / "w"), title="索引课")
    outcome = adapter.run(video, transcribe_fn=broken)
    assert outcome.asr_available is False
    draft = adapter.draft_from_outcome(outcome, source_path=video)
    draft.validate()

    assert draft.meta["asr"]["available"] is False
    assert draft.meta["asr"]["reason"]
    assert draft.meta["has_text"] is False
    # 仍然有层次：全片 → 幻灯片帧（图片帧 + 时间点）
    levels = {u.level for u in draft.units}
    assert levels == {1, 2}
    frames = [u for u in draft.units if u.level == 2]
    assert [u.span.start for u in frames] == [3_000, 6_000, 9_000]
    # ★ 不许编造正文：帧 unit 的文字**只能**等于该帧真实 OCR 出来的文字（本机装了
    #   rapidocr，所以这里能读到 drawtext 画的"black 1/white 2"）；没有 OCR 时为空。
    slides = outcome.artifact.slides
    assert len(frames) == len(slides)
    for u, s in zip(frames, slides):
        assert u.text == s.ocr_text, f"unit 文字必须来自真实 OCR：{u.text!r} ≠ {s.ocr_text!r}"
        assert u.title == (s.title or "图片帧")
    assert draft.meta["degraded"]


def test_draft_without_asr_and_without_slides_falls_back_to_timeline_anchors(tmp_path) -> None:
    """连帧都抽不到时，只切"时间轴导航锚点"，标题如实写「无文字稿」。"""
    import json

    work = str(tmp_path / "w")
    os.makedirs(work, exist_ok=True)
    # 直接构造一个 outcome（不跑流水线），模拟"没 ASR 也没帧"
    from worker.models.video import VideoArtifact

    outcome = R.PipelineOutcome(
        artifact=VideoArtifact(doc_id="doc_anchor", duration_ms=180_000),
        asr_available=False,
        asr_reason="模拟：ASR 不可用",
        work_dir=work,
    )
    adapter = VideoAdapter(doc_id="doc_anchor", work_dir=work, title="纯音频课")
    draft = adapter.draft_from_outcome(outcome)
    draft.validate()
    anchors = [u for u in draft.units if u.level == 2]
    assert len(anchors) == 3, "180 秒 / 60 秒一个锚点 = 3 个"
    assert all("无文字稿" in u.title for u in anchors)
    assert all(u.text == "" for u in anchors), "绝不许编造正文"
    assert [u.span.start for u in anchors] == [0, 60_000, 120_000]
    _ = json


def test_split_blocks_bounds() -> None:
    """章内切块：短章不下钻；长章按字数切且时间区间连续覆盖。"""
    from worker.adapters.video import _split_blocks

    assert _split_blocks("短", 0, 5_000) == []
    long_text = "字" * 3_000
    blocks = _split_blocks(long_text, 0, 300_000)
    assert len(blocks) == 3, [len(b["text"]) for b in blocks]
    assert [b["text"] for b in blocks] == ["字" * 1200, "字" * 1200, "字" * 600]
    assert blocks[0]["start"] == 0
    assert blocks[-1]["end"] == 300_000
    for a, b in zip(blocks, blocks[1:]):
        assert a["end"] == b["start"], "块之间必须首尾相接"


def test_derive_doc_id_is_stable(tmp_path) -> None:
    from worker.adapters.video import _derive_doc_id

    p = str(tmp_path / "x.mp4")
    assert _derive_doc_id(p) == _derive_doc_id(p)
    assert _derive_doc_id(p).startswith("doc_")
    assert _derive_doc_id(p) != _derive_doc_id(str(tmp_path / "y.mp4"))


def test_parse_error_includes_reason(tmp_path) -> None:
    """报错要能看出**为什么**失败（不是光说"解析失败"）。"""
    from worker.adapters.base import ParseError

    empty = tmp_path / "empty.mp4"
    empty.write_bytes(b"")
    with pytest.raises(ParseError) as ei:
        VideoAdapter(doc_id="d", work_dir=str(tmp_path / "w")).parse(str(empty))
    assert "视频解析失败" in str(ei.value)


def test_unit_draft_helper_defaults() -> None:
    """确认我们用的 UnitDraft 字段语义（防止 T1 改契约后我们静默错）。"""
    u = UnitDraft(ord=1, title="t", level=1, span={"kind": "time", "start": 0, "end": 5}, text="x")
    assert u.span.kind == "time"
    assert u.text_len == 1
    assert u.to_dict()["span"] == {"kind": "time", "start": 0, "end": 5}
