"""流水线编排的端到端测试（**真实 ffmpeg 抽音频/抽帧**；ASR 与 LLM 用注入的假后端）。

验收项在这里落地：
* 合成视频 → SRT/VTT，条数与首尾时间戳是**具体值**
* 分章时间轴覆盖全片不越界
* 幻灯片帧有时间点
* **ASR 不可用 → 如实降级**：``asr_available=False``、不产出空字幕文件、仍出帧
* **断点续跑**：第二次跑不重复调 LLM / 不重抽帧
* 手动上传字幕（坑 10 的降级路径）
"""

from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from worker.models.video import VideoSegment  # noqa: E402
from worker.video import runner as R  # noqa: E402
from worker.video import subtitle as S  # noqa: E402
from worker.video import synth  # noqa: E402
from worker.video.errors import AsrUnavailable  # noqa: E402

DUR_MS = 12_000


@pytest.fixture(scope="module")
def video(tmp_path_factory) -> str:
    d = tmp_path_factory.mktemp("run")
    return synth.synth_video(
        str(d / "lesson.mp4"), duration_ms=DUR_MS, colors=synth.SCENE_COLORS, text="DB Index"
    )


def fake_transcribe(*, per_chunk: int = 3):
    """假 ASR：每块产出 ``per_chunk`` 段（**块内相对时间**，与真 whisper 一致）。"""

    def run(idx: int, chunk) -> tuple[list[VideoSegment], str, float]:
        out = []
        span = max(1, chunk.duration_ms // (per_chunk + 1))
        for k in range(per_chunk):
            start = k * span
            out.append(
                VideoSegment(
                    i=k,
                    start=start,
                    end=start + span - 200,
                    text=f"第{idx}块第{k}句 索引与B加树",
                    confidence=0.92,
                )
            )
        return out, "zh", 0.97

    return run


def fake_llm_factory(chapters: list[dict] | None = None, markdown: str | None = None):
    calls: list[dict] = []

    def llm(prompt: str, schema: dict) -> dict:
        calls.append({"prompt": prompt, "schema": schema})
        if "chapters" in schema.get("properties", {}):
            return {
                "chapters": chapters
                or [
                    {"title": "索引原理", "start_i": 0, "end_i": 1, "summary": "讲索引"},
                    {"title": "B加树结构", "start_i": 2, "end_i": 2, "summary": "讲结构"},
                ],
                "summary": "整篇摘要：索引与 B加树。",
            }
        return {"markdown": markdown or "# 数据库索引\n## 索引原理\n- B加树\n## 使用场景\n- 范围查询"}

    llm.calls = calls  # type: ignore[attr-defined]
    return llm


# ── 端到端（ASR + LLM 都在）────────────────────────────────────────────
def test_pipeline_end_to_end_produces_all_four_artifacts(video: str, tmp_path) -> None:
    work = str(tmp_path / "w")
    llm = fake_llm_factory()
    oc = R.run_pipeline(
        video, "doc_e2e", work_dir=work, llm=llm, transcribe_fn=fake_transcribe(), title="索引课"
    )
    art = oc.artifact
    assert oc.asr_available is True and oc.asr_reason == ""
    assert art.doc_id == "doc_e2e"
    # 规范时长 = max(视频 12000ms, 抽出的 WAV)。WAV 因 AAC 帧对齐会略长（实测 +32ms），
    # 取较大值才能保证"分章覆盖全片不越界"（见 runner 里 duration_ms 的注释）。
    dur = art.duration_ms
    assert DUR_MS <= dur <= DUR_MS + 100, dur
    assert art.asr_model == "tiny"
    assert art.asr_lang == "zh"
    assert len(art.segments) == 3, "12 秒只用 1 块 → 3 段"
    assert art.segments[0].start == 0 and art.segments[-1].end <= dur

    # ① 字幕：文件真的落盘 + 内容单调不重叠 + 具体条数/首尾时间戳
    srt_path = os.path.join(work, "subtitle.srt")
    vtt_path = os.path.join(work, "subtitle.vtt")
    assert os.path.isfile(srt_path) and os.path.isfile(vtt_path)
    srt = open(srt_path, encoding="utf-8").read()
    vtt = open(vtt_path, encoding="utf-8").read()
    assert vtt.startswith("WEBVTT\n\n")
    cues = S.parse_srt(srt)
    S.validate_timeline(cues, duration_ms=dur)
    # 每段 2.8 秒、间隔 0.2 秒：
    # 前两段合并成一条（换行合并，26 字折成两行）；第三段**不合并**——
    # 合并后时长会到 8824ms，超过 MAX_CUE_MS=7000 的上限（防"一句话挂 20 秒"）。
    assert len(cues) == 2
    assert [(c.start, c.end) for c in cues] == [(0, 5_816), (6_016, 8_824)]
    # 两条 ASR 段被合并 → 折行成两行；折行只允许丢**行边界的空白**，不许丢字
    assert cues[0].text.replace("\n", "").replace(" ", "") == (
        "第0块第0句索引与B加树第0块第1句索引与B加树"
    )
    assert len(cues[0].text.split("\n")) == 2
    assert cues[0].text.split("\n")[1].endswith("索引与B加树")
    assert srt.startswith("1\n00:00:00,000 --> 00:00:05,816\n")
    assert "2\n00:00:06,016 --> 00:00:08,824\n" in srt
    assert srt.strip().endswith("索引与B加树")

    # ② 文稿分章：覆盖全片 + 不越界 + 有摘要
    assert [c.title for c in art.transcript] == ["索引原理", "B加树结构"]
    assert art.transcript[0].start == 0
    assert art.transcript[-1].end == dur
    assert [c.start for c in art.transcript] == [0, art.transcript[0].end]
    assert oc.transcript_source == "llm"
    assert "整篇摘要" in json.load(open(os.path.join(work, "chapters.json"), encoding="utf-8"))["summary"]

    # ③ 思维导图：markmap 格式 + 单根
    assert art.mindmap_format == "markmap"
    assert art.mindmap_content.startswith("# 数据库索引\n")
    assert oc.mindmap_source == "llm"

    # ④ 幻灯片帧：有时间点 + 图片帧标注
    assert [(s.index, s.at_ms) for s in art.slides] == [(1, 3_000), (2, 6_000), (3, 9_000)]
    assert all(s.image for s in art.slides)
    assert all(s.title in ("图片帧",) or s.title.startswith("DB") for s in art.slides)

    assert oc.stages["audio"]["status"] == "done"
    assert oc.stages["asr"]["segments"] == 3
    assert oc.stages["slides"]["count"] == 3
    assert oc.degraded == [], oc.degraded
    # 流水线自己落 state.json；（outcome.json 由 VideoAdapter.run 落，见 adapter 测试）
    assert os.path.isfile(os.path.join(work, "state.json"))
    state = json.load(open(os.path.join(work, "state.json"), encoding="utf-8"))
    assert state["duration_ms"] == dur
    assert state["asr_available"] is True
    assert state["transcript_source"] == "llm"
    assert state["stages"]["slides"]["count"] == 3


def test_pipeline_percent_is_monotonic_and_reaches_one(video: str, tmp_path) -> None:
    seen: list[float] = []
    R.run_pipeline(
        video,
        "doc_p",
        work_dir=str(tmp_path / "w"),
        llm=fake_llm_factory(),
        transcribe_fn=fake_transcribe(),
        on_progress=lambda f, s: seen.append(f),
    )
    assert seen == sorted(seen), "进度必须单调不减（SSE 进度条会倒退）"
    assert seen[-1] == pytest.approx(1.0), seen[-1]
    assert seen[0] < 0.05


def test_pipeline_chords_offset_between_chunks(tmp_path) -> None:
    """多块：第 2 块的段必须落在 600s 之后（偏移只加一次）。"""
    video = synth.synth_video(str(tmp_path / "short.mp4"), duration_ms=DUR_MS)
    audio_dir = tmp_path / "w"
    oc = R.run_pipeline(
        video,
        "doc_multi",
        work_dir=str(audio_dir),
        llm=fake_llm_factory(),
        transcribe_fn=fake_transcribe(per_chunk=1),
        options=R.VideoOptions(chunk_ms=6_000, enable_slides=False),
    )
    starts = [s.start for s in oc.artifact.segments]
    assert len(starts) == 2
    assert starts[0] < 1_000
    assert starts[1] >= 5_900, f"第 2 块的段没有块偏移：{starts}"


# ── 坑 10：ASR 不可用时如实降级 ────────────────────────────────────────
def test_pipeline_degrades_honestly_when_asr_unavailable(video: str, tmp_path) -> None:
    """★ 核心验收：ASR 挂了 → 不产出空字幕、不编造文稿，但仍出帧与时间轴。"""
    work = str(tmp_path / "w")

    def broken(idx, chunk):
        raise AsrUnavailable("ASR 模型加载失败", detail="模拟：模型下不下来", code="E_ASR_LOAD")

    oc = R.run_pipeline(video, "doc_deg", work_dir=work, llm=fake_llm_factory(), transcribe_fn=broken)
    assert oc.asr_available is False
    assert "模型下不下来" in oc.asr_reason
    assert oc.artifact.segments == []
    assert oc.artifact.subtitle_srt == "" and oc.artifact.subtitle_vtt == ""
    assert oc.artifact.transcript == []
    assert oc.artifact.mindmap_content == ""
    assert oc.transcript_source == "none" and oc.mindmap_source == "none"
    # ★ 关键：磁盘上**不许**有空的 SRT 文件冒充成功
    assert not os.path.exists(os.path.join(work, "subtitle.srt"))
    assert not os.path.exists(os.path.join(work, "subtitle.vtt"))
    assert not os.path.exists(os.path.join(work, "chapters.json"))
    # 幻灯片帧照常产出（坑 10：仍可产出播放器 + 时间轴 + 幻灯片帧）
    assert [(s.index, s.at_ms) for s in oc.artifact.slides] == [(1, 3_000), (2, 6_000), (3, 9_000)]
    dur = oc.artifact.duration_ms
    assert DUR_MS <= dur <= DUR_MS + 100, dur
    assert oc.stages["asr"]["status"] == "failed"
    assert oc.stages["subtitle"]["status"] == "skipped"
    assert any("ASR 不可用" in d for d in oc.degraded)
    assert oc.has_text is False


def test_pipeline_degrades_when_no_speech_detected(tmp_path) -> None:
    """ASR 跑通了但 0 段（纯静音）→ 同样不许产出假字幕。"""
    video = synth.synth_video(str(tmp_path / "v.mp4"), duration_ms=DUR_MS)
    work = str(tmp_path / "w")
    oc = R.run_pipeline(
        video, "doc_silent", work_dir=work, transcribe_fn=lambda i, c: ([], "zh", 0.4)
    )
    assert oc.asr_available is False
    assert "没有识别出任何语音" in oc.asr_reason
    assert not os.path.exists(os.path.join(work, "subtitle.srt"))
    assert oc.artifact.slides, "帧还是要出"


def test_pipeline_handles_video_without_audio_track(tmp_path) -> None:
    silent = synth.synth_silent_video(str(tmp_path / "silent.mp4"), duration_ms=6_000)
    work = str(tmp_path / "w")
    oc = R.run_pipeline(silent, "doc_noaudio", work_dir=work, transcribe_fn=fake_transcribe())
    assert oc.asr_available is False
    assert oc.asr_reason == "源视频没有音轨"
    assert oc.stages["audio"]["status"] == "skipped"
    assert not os.path.exists(os.path.join(work, "subtitle.srt"))
    assert any("没有音轨" in d for d in oc.degraded)


def test_pipeline_audio_only_file_skips_slides(tmp_path) -> None:
    """纯音频（网课录音）也能转写；只是没有帧可抽。"""
    wav = synth.synth_audio(str(tmp_path / "rec.wav"), duration_ms=6_000)
    work = str(tmp_path / "w")
    oc = R.run_pipeline(
        wav,
        "doc_audio",
        work_dir=work,
        llm=fake_llm_factory(),
        transcribe_fn=fake_transcribe(per_chunk=2),
        options=R.VideoOptions(enable_slides=False),
    )
    assert oc.asr_available is True
    assert len(oc.artifact.segments) == 2
    assert oc.artifact.slides == []
    assert any("没有视频流" in d for d in oc.degraded)
    assert oc.artifact.subtitle_srt


# ── LLM 不可用 → 机械分节（如实降级，不编造）──────────────────────────
def test_pipeline_mechanical_chapters_when_no_llm(video: str, tmp_path) -> None:
    oc = R.run_pipeline(
        video, "doc_nollm", work_dir=str(tmp_path / "w"), llm=None, transcribe_fn=fake_transcribe()
    )
    assert oc.llm_available is False
    assert oc.transcript_source == "mechanical"
    assert oc.artifact.transcript
    assert all(c.title.startswith("分节") for c in oc.artifact.transcript)
    from worker.video.transcript import validate_coverage

    validate_coverage(oc.artifact.transcript, oc.artifact.duration_ms)
    # 思维导图退化为结构图（只搬章节标题，不编造知识点）
    assert oc.mindmap_source == "structural"
    assert oc.artifact.mindmap_content.startswith("# 课程思维导图")
    assert "## 分节 1" in oc.artifact.mindmap_content
    assert any("机械分节" in d or "结构图" in d for d in oc.degraded)


def test_pipeline_survives_llm_exception(video: str, tmp_path) -> None:
    def boom(prompt: str, schema: dict) -> dict:
        raise RuntimeError("503 from LLM")

    oc = R.run_pipeline(
        video, "doc_llmboom", work_dir=str(tmp_path / "w"), llm=boom, transcribe_fn=fake_transcribe()
    )
    assert oc.transcript_source == "mechanical"
    assert oc.artifact.transcript
    assert oc.has_text is True, "ASR 成功了，文字产物必须还在"


# ── 断点续跑 ────────────────────────────────────────────────────────────
def test_second_run_reuses_llm_and_frames(video: str, tmp_path) -> None:
    """★ 断点：第二次跑不重复调 LLM、不重抽帧（对比 mtime）。"""
    work = str(tmp_path / "w")
    llm1 = fake_llm_factory()
    oc1 = R.run_pipeline(video, "doc_resume", work_dir=work, llm=llm1, transcribe_fn=fake_transcribe())
    assert len(llm1.calls) == 2, "第一次：一次分章 + 一次思维导图"

    frame_files = sorted(
        f for f in os.listdir(os.path.join(work, "frames")) if f.endswith(".jpg")
    )
    stamps = {f: os.stat(os.path.join(work, "frames", f)).st_mtime_ns for f in frame_files}
    audio_stamp = os.stat(os.path.join(work, "audio.wav")).st_mtime_ns

    llm2 = fake_llm_factory()
    oc2 = R.run_pipeline(video, "doc_resume", work_dir=work, llm=llm2, transcribe_fn=fake_transcribe())
    assert llm2.calls == [], "续跑不该再调 LLM（chapters.json / mindmap.md 已缓存）"
    assert oc2.stages["chapters"]["status"] == "skipped"
    assert oc2.stages["mindmap"]["note"] == "复用 mindmap.md"
    assert os.stat(os.path.join(work, "audio.wav")).st_mtime_ns == audio_stamp, "音频被重抽了"
    for name, stamp in stamps.items():
        assert os.stat(os.path.join(work, "frames", name)).st_mtime_ns == stamp, f"{name} 被重抽了"
    assert [s.to_dict() for s in oc2.artifact.slides] == [s.to_dict() for s in oc1.artifact.slides]
    assert [c.to_dict() for c in oc2.artifact.transcript] == [
        c.to_dict() for c in oc1.artifact.transcript
    ]


def test_resume_false_forces_full_rerun(video: str, tmp_path) -> None:
    work = str(tmp_path / "w")
    R.run_pipeline(video, "doc_force", work_dir=work, llm=fake_llm_factory(), transcribe_fn=fake_transcribe())
    llm2 = fake_llm_factory()
    R.run_pipeline(
        video,
        "doc_force",
        work_dir=work,
        llm=llm2,
        transcribe_fn=fake_transcribe(),
        options=R.VideoOptions(resume=False),
    )
    assert len(llm2.calls) == 2, "resume=False 时必须重新分章与画导图"


# ── 手动上传字幕（坑 10 的降级路径）────────────────────────────────────
def test_apply_manual_subtitles(tmp_path) -> None:
    work = str(tmp_path / "manual")
    srt = (
        "1\n00:00:01,000 --> 00:00:05,000\n人工上传的第一句\n\n"
        "2\n00:00:06,000 --> 00:00:09,000\n人工上传的第二句\n"
    )
    oc = R.apply_manual_subtitles(
        srt,
        doc_id="doc_manual",
        duration_ms=10_000,
        work_dir=work,
        title="手工字幕课",
        llm=fake_llm_factory(),
    )
    assert oc.asr_available is False
    assert "人工上传" in oc.asr_reason
    assert [(s.start, s.end) for s in oc.artifact.segments] == [(1_000, 5_000), (6_000, 9_000)]
    assert oc.artifact.subtitle_srt.splitlines()[0] == "1"
    assert oc.artifact.subtitle_vtt.startswith("WEBVTT")
    assert oc.artifact.segments, "人工字幕也要落成 segments，供时间轴/跳转使用"
    assert os.path.isfile(os.path.join(work, "subtitle.srt"))
    assert oc.artifact.transcript
    assert oc.artifact.mindmap_content.startswith("#")
    assert oc.stages["manual_subtitles"]["cues"] == 2


def test_apply_manual_subtitles_rejects_garbage(tmp_path) -> None:
    from worker.video.errors import SubtitleParseError

    with pytest.raises(SubtitleParseError):
        R.apply_manual_subtitles(
            "这里没有时间轴", doc_id="d", duration_ms=1_000, work_dir=str(tmp_path / "m")
        )


# ── 能力快照 ────────────────────────────────────────────────────────────
def test_capabilities_shape() -> None:
    cap = R.capabilities()
    video_cap = cap["video"]
    assert set(video_cap) == {"ffmpeg", "asr", "ocr", "text_model", "slides"}
    assert video_cap["ffmpeg"]["available"] is True
    assert video_cap["ffmpeg"]["path"]
    assert video_cap["ffmpeg"]["ffprobe"] is False, "本机没有 ffprobe（实测）"
    assert video_cap["asr"]["available"] is True
    assert video_cap["asr"]["models"] == ["tiny", "base", "small"]
    assert video_cap["slides"]["kind"] == "image_frame"
    assert "图片帧" in video_cap["slides"]["note"]
    assert "可编辑 PPT" in video_cap["slides"]["note"]


def test_rel_path_is_project_relative() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    inside = os.path.join(root, "data", "artifacts", "doc_x", "subtitle.srt")
    assert R.rel_path(inside, root) == "data/artifacts/doc_x/subtitle.srt"
    outside = os.path.join(os.environ.get("TEMP", "/tmp"), "x.srt")
    assert R.rel_path(outside, root) == outside.replace("\\", "/")
