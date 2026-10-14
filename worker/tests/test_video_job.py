"""视频 job 的 **JSONL 协议**测试（``docs/ARCHITECTURE_V2.md`` §3.1）。

验收要点：
* 事件**严格 JSONL**：每行一个 JSON，**纯 ASCII**（中文全转义）→ Node 侧任何切帧实现都不会错帧
* 事件类型齐全：``progress`` / ``log`` / ``subtitle_ready`` / ``transcript_ready`` /
  ``mindmap_ready`` / ``slides_ready`` / ``result`` / ``error``
* ``result.data.artifact`` 是**契约 §2.7 snake_case**（可直接入库）
* **降级如实上报**：ASR 全链失败 → ``asrAvailable=false`` + 可读 reason，
  且**没有**字幕/文稿产物（不产出空文件）
* ``video.caps`` 的 ``providers.asr[]`` 是 ``docs/PROVIDERS.md`` §7 的形状
"""

from __future__ import annotations

import io
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from worker.video import job as job_mod  # noqa: E402
from worker.video import synth  # noqa: E402
from worker.video.job import Emitter, run_job  # noqa: E402
from worker.video.providers.base import (  # noqa: E402
    AsrProvider,
    AsrRequest,
    AsrResponse,
    AsrSegmentDTO,
    ProviderError,
    ProviderInfo,
)

DUR_MS = 12_000


@pytest.fixture(scope="module")
def video(tmp_path_factory) -> str:
    d = tmp_path_factory.mktemp("job")
    return synth.synth_video(
        str(d / "lesson.mp4"), duration_ms=DUR_MS, colors=synth.SCENE_COLORS, text="DB Index"
    )


class FakeAsr(AsrProvider):
    """协议测试用的假 provider（不加载模型、不联网）。"""

    id = "local-fw"

    def __init__(self, *, segments: int = 3, fail: bool = False, configured: bool = True):
        self._segments = segments
        self._fail = fail
        self._configured = configured

    def info(self, *, health: bool = False) -> ProviderInfo:
        return ProviderInfo(
            id=self.id, kind="asr", label="fake", vendor="fake", runtime="local",
            configured=self._configured, available=self._configured,
            reason="" if self._configured else "假 provider 未配置",
            capabilities={"wordTimestamps": True, "segmentLevelTimestamps": True, "languages": ["*"]},
        )

    def health_check(self) -> tuple[bool, str]:
        return self._configured, ""

    def transcribe(self, req: AsrRequest) -> AsrResponse:
        if self._fail:
            raise ProviderError("E_ASR_LOAD", "假 provider 故意失败", provider=self.id)
        span = max(1, (req.duration_ms or 12_000) // (self._segments + 1))
        return AsrResponse(
            segments=[
                AsrSegmentDTO(
                    i=k, startMs=k * span, endMs=k * span + span - 200,
                    text=f"第{k}句 索引与B加树", confidence=0.9,
                )
                for k in range(self._segments)
            ],
            language="zh", provider=self.id, used_provider=self.id, model="fake-tiny",
        )


def _run(payload: dict, **kw) -> tuple[int, list[dict], str]:
    buf = io.StringIO()
    rc = run_job(payload, Emitter(buf), **kw)
    raw = buf.getvalue()
    events = [json.loads(line) for line in raw.splitlines() if line.strip()]
    return rc, events, raw


def _of(events: list[dict], type_: str) -> list[dict]:
    return [e for e in events if e.get("type") == type_]


# ── 协议外壳 ────────────────────────────────────────────────────────────
def test_emitter_outputs_strict_ascii_jsonl() -> None:
    """★ 切帧安全：每行一个 JSON，且**全是 ASCII**（中文转义成 \\uXXXX）。"""
    buf = io.StringIO()
    emit = Emitter(buf)
    emit.progress("字幕", 0.5, {})
    emit.log("中文日志：索引与 B加树")
    emit.ready("subtitle", {"cues": 1, "text": "索引"})
    lines = buf.getvalue().splitlines()
    assert len(lines) == 3
    for line in lines:
        assert line.isascii(), f"输出里出现了非 ASCII（会加大 Node 侧切帧风险）：{line[:60]!r}"
        json.loads(line)  # 每行都是合法 JSON
    assert "\n" not in json.loads(lines[1])["msg"], "msg 里不能有裸换行"


def test_emitter_event_fields() -> None:
    buf = io.StringIO()
    emit = Emitter(buf)
    emit.progress("语音转写", 0.75, {"segments": 3})
    emit.error("E_ASR_ALL_FAILED", "全链失败", "逐跳原因")
    evs = [json.loads(x) for x in buf.getvalue().splitlines()]
    assert evs[0] == {"type": "progress", "stage": "语音转写", "frac": 0.75, "detail": {"segments": 3}}
    assert evs[1] == {"type": "error", "code": "E_ASR_ALL_FAILED", "msg": "全链失败", "detail": "逐跳原因"}


def test_progress_frac_is_clamped() -> None:
    buf = io.StringIO()
    emit = Emitter(buf)
    emit.progress("x", 1.7)
    emit.progress("y", -0.3)
    fr = [json.loads(x)["frac"] for x in buf.getvalue().splitlines()]
    assert fr == [1.0, 0.0]


# ── 错误路径 ────────────────────────────────────────────────────────────
def test_missing_job_name_reports_error() -> None:
    rc, events, _ = _run({})
    assert rc == 1
    assert _of(events, "error")[0]["code"] == "E_JOB"


def test_unknown_job_reports_supported_list() -> None:
    rc, events, _ = _run({"job": "video.nope"})
    assert rc == 1
    err = _of(events, "error")[0]
    assert "video.parse" in err["detail"]


def test_parse_requires_doc_id_and_path() -> None:
    rc, events, _ = _run({"job": "video.parse", "docId": "doc_x"})
    assert rc == 1
    assert _of(events, "error")[0]["code"] == "E_JOB"


def test_parse_missing_file_reports_notfound() -> None:
    rc, events, _ = _run({"job": "video.parse", "docId": "doc_x", "videoPath": "nope.mp4"})
    assert rc == 1
    assert _of(events, "error")[0]["code"] == "E_NOTFOUND"


def test_cli_rejects_bad_json_stdin(monkeypatch, capsys) -> None:
    monkeypatch.setattr(sys, "stdin", io.StringIO("{not json"))
    rc = job_mod.main([])
    assert rc == 1
    out = capsys.readouterr().out.strip()
    assert json.loads(out)["code"] == "E_JOB_JSON"


# ── video.caps ──────────────────────────────────────────────────────────
def test_caps_job_matches_providers_doc_shape() -> None:
    rc, events, _ = _run({"job": "video.caps", "policy": "local-first", "health": True})
    assert rc == 0
    data = _of(events, "result")[0]["data"]
    assert set(data["providers"]) == {"asr"}
    ids = [p["id"] for p in data["providers"]["asr"]]
    assert ids == ["local-fw", "openai-asr", "aliyun-asr", "tencent-asr", "xfyun-asr"]
    local = next(p for p in data["providers"]["asr"] if p["id"] == "local-fw")
    assert local["available"] is True
    assert local["capabilities"]["wordTimestamps"] is True
    assert data["policy"] == {"asr": "local-first"}
    assert data["ffmpeg"]["available"] is True
    assert data["ffmpeg"]["ffprobe"] is False
    assert data["slides"]["kind"] == "image_frame"
    assert data["ocr"]["available"] in (True, False)
    assert set(data["asr"]) >= {"available", "engine", "reason", "providers"}


def test_caps_job_defaults_to_no_network_probe() -> None:
    """默认 ``health=false``：``/capabilities`` 不该触发网络探测。"""
    rc, events, raw = _run({"job": "video.caps"})
    assert rc == 0
    assert _of(events, "result")[0]["data"]["asr"]["policy"] == "local-first"


# ── video.parse（全链成功，注入假 provider）─────────────────────────────
def test_parse_job_emits_all_ready_events(video: str, tmp_path) -> None:
    work = str(tmp_path / "w")
    rc, events, raw = _run(
        {
            "job": "video.parse",
            "docId": "doc_job1",
            "videoPath": video,
            "title": "索引课",
            "workDir": work,
            "options": {"maxSlides": 10, "enableLlm": False},
        },
        providers={"local-fw": FakeAsr(segments=3)},
    )
    assert rc == 0
    kinds = [e["type"] for e in events]
    assert "progress" in kinds and "log" in kinds
    assert "subtitle_ready" in kinds
    assert "transcript_ready" in kinds
    assert "mindmap_ready" in kinds
    assert "slides_ready" in kinds
    assert kinds[-1] == "result", "result 必须是最后一个事件"

    # 进度单调不减（SSE 进度条不会倒退）
    fracs = [e["frac"] for e in _of(events, "progress")]
    assert fracs == sorted(fracs)
    assert fracs[-1] == pytest.approx(1.0, abs=0.02)

    sub = _of(events, "subtitle_ready")[0]["data"]
    # 3 段：前两段合并成 1 条；第三段因合并后时长超过 MAX_CUE_MS=7000 而**不合并** → 2 条。
    # 时间点按**规范时长**（= max(视频 12000, 抽出的 WAV) ≈ 12032，WAV 因 AAC 帧对齐略长）
    # 平分：每段 3008ms → 最后一条结束于 8824ms。
    assert sub["cues"] == 2
    assert sub["firstMs"] == 0
    assert sub["lastMs"] == 8_824
    assert sub["srtChars"] > 0 and sub["srtPath"].endswith("subtitle.srt")

    tr = _of(events, "transcript_ready")[0]["data"]
    assert tr["source"] == "mechanical", "enableLlm=false → 如实降级"
    assert tr["chapters"] >= 1
    assert tr["coveredMs"][0] == 0

    mm = _of(events, "mindmap_ready")[0]["data"]
    assert mm["format"] == "markmap"
    assert mm["source"] == "structural"
    assert mm["content"].startswith("#")
    assert mm["tree"]["title"]
    assert mm["nodes"] >= 1

    sl = _of(events, "slides_ready")[0]["data"]
    assert sl["count"] == 3
    assert sl["atMs"] == [3_000, 6_000, 9_000]
    assert sl["kind"] == "image_frame"
    assert "不是可编辑 PPT" in sl["note"]

    result = _of(events, "result")[0]["data"]
    assert result["docId"] == "doc_job1"
    assert result["provider"]["asrAvailable"] is True
    assert result["provider"]["usedProvider"] == "local-fw"
    assert result["provider"]["transcriptSource"] == "mechanical"
    assert result["hasText"] is True
    assert result["elapsedMs"] > 0
    assert result["workDir"] == work
    assert set(result["files"]) >= {"audio", "srt", "vtt", "mindmap", "chapters", "state"}
    # ★ artifact 必须是契约 §2.7 的 snake_case（Node 直接入库）
    art = result["artifact"]
    assert set(art) >= {"id", "doc_id", "duration_ms", "asr_model", "asr_lang", "segments",
                        "subtitles", "transcript", "mindmap", "slides"}
    assert art["segments"][0]["i"] == 0
    assert "start" in art["segments"][0] and "startMs" not in art["segments"][0]
    assert art["mindmap"]["format"] == "markmap"
    assert art["slides"][0]["at_ms"] == 3_000
    assert art["subtitles"]["srt"].startswith("1\n"), "字幕字段存**内容**不是路径"
    # 产物真的落盘
    for key in ("audio", "srt", "vtt", "mindmap", "state"):
        assert os.path.isfile(result["files"][key]), key


# ── 降级：ASR 全链失败 ─────────────────────────────────────────────────
def test_parse_job_degrades_honestly_when_asr_fails(video: str, tmp_path) -> None:
    """★ 坑 10：全链失败 → 没有字幕/文稿，但**播放器 + 时间轴 + 幻灯片帧**照常。"""
    work = str(tmp_path / "w")
    rc, events, raw = _run(
        {
            "job": "video.parse",
            "docId": "doc_job2",
            "videoPath": video,
            "workDir": work,
            "options": {"maxSlides": 10},
        },
        providers={"local-fw": FakeAsr(fail=True)},
    )
    assert rc == 0, "降级不算 job 失败（产物仍然有效）"
    kinds = [e["type"] for e in events]
    assert "subtitle_ready" not in kinds, "不许产出字幕（哪怕是空的）"
    assert "transcript_ready" not in kinds
    assert "mindmap_ready" not in kinds
    assert "slides_ready" in kinds, "帧仍要产出"
    result = _of(events, "result")[0]["data"]
    assert result["provider"]["asrAvailable"] is False
    assert "假 provider 故意失败" in result["provider"]["asrReason"]
    assert result["hasText"] is False
    assert result["artifact"]["segments"] == []
    assert result["artifact"]["subtitles"] == {"srt": "", "vtt": ""}
    assert not os.path.exists(os.path.join(work, "subtitle.srt"))
    assert result["degraded"], "degraded[] 必须写明降级原因"
    assert any("ASR 不可用" in d for d in result["degraded"])
    warns = [e for e in _of(events, "log") if e["level"] == "warning"]
    assert any("降级" in w["msg"] for w in warns)


def test_parse_job_reports_provider_fallback(video: str, tmp_path) -> None:
    """本地失败 → 云端接上：``degradedFrom`` 必须如实上报（R0）。"""

    class CloudFake(FakeAsr):
        id = "openai-asr"

        def info(self, *, health: bool = False) -> ProviderInfo:
            info = super().info(health=health)
            info.runtime = "cloud"
            info.capabilities = {**info.capabilities, "wordTimestamps": False}
            return info

    work = str(tmp_path / "w")
    rc, events, _ = _run(
        {
            "job": "video.parse",
            "docId": "doc_job3",
            "videoPath": video,
            "workDir": work,
            "options": {"maxSlides": 5},
        },
        providers={"local-fw": FakeAsr(fail=True), "openai-asr": CloudFake(segments=2)},
    )
    assert rc == 0
    result = _of(events, "result")[0]["data"]
    assert result["provider"]["usedProvider"] == "openai-asr"
    assert result["provider"]["degradedFrom"] == "local-fw"
    assert result["provider"]["asrAvailable"] is True
    attempts = result["stages"]["asr"]["attempts"]
    assert [a["provider"] for a in attempts] == ["local-fw", "openai-asr"]
    assert attempts[0]["ok"] is False


def test_parse_job_reports_interval_mode_degradation(video: str, tmp_path) -> None:
    """帧是"等间隔兜底"抽的（不是检测到翻页）→ 必须如实标注 mode=interval。"""
    solid = synth.synth_video(str(tmp_path / "solid.mp4"), duration_ms=DUR_MS, colors=("gray",))
    rc, events, _ = _run(
        {
            "job": "video.parse",
            "docId": "doc_job4",
            "videoPath": solid,
            "workDir": str(tmp_path / "w"),
            "options": {"fallbackIntervalMs": 3000, "enableAsr": False},
        }
    )
    assert rc == 0
    sl = _of(events, "slides_ready")[0]["data"]
    assert sl["mode"] == "interval"
    assert sl["atMs"] == [0, 3_000, 6_000, 9_000]
    result = _of(events, "result")[0]["data"]
    assert any("等间隔" in d for d in result["degraded"])


# ── 手动字幕（坑 10 的降级路径）─────────────────────────────────────────
def test_manual_subtitles_job(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(job_mod, "make_text_model", lambda cfg, **kw: (None, "测试：无 LLM"))
    srt = (
        "1\n00:00:01,000 --> 00:00:05,000\n人工第一句\n\n"
        "2\n00:00:06,000 --> 00:00:09,000\n人工第二句\n"
    )
    rc, events, _ = _run(
        {
            "job": "video.manual_subtitles",
            "docId": "doc_manual",
            "text": srt,
            "durationMs": 10_000,
            "workDir": str(tmp_path / "m"),
        }
    )
    assert rc == 0
    sub = _of(events, "subtitle_ready")[0]["data"]
    assert sub["cues"] == 2
    assert sub["firstMs"] == 1_000 and sub["lastMs"] == 9_000
    result = _of(events, "result")[0]["data"]
    assert result["provider"]["asrAvailable"] is False
    assert "人工上传" in result["provider"]["asrReason"]
    assert len(result["artifact"]["segments"]) == 2
    assert result["hasText"] is True


def test_manual_subtitles_job_rejects_garbage(tmp_path) -> None:
    rc, events, _ = _run(
        {"job": "video.manual_subtitles", "docId": "d", "text": "没有时间轴", "durationMs": 1000}
    )
    assert rc == 1
    assert _of(events, "error")[0]["code"] == "E_SUBTITLE_PARSE"


def test_manual_subtitles_requires_fields() -> None:
    rc, events, _ = _run({"job": "video.manual_subtitles", "docId": "d"})
    assert rc == 1
    assert _of(events, "error")[0]["code"] == "E_JOB"


# ── 参数解析（camelCase → snake_case）───────────────────────────────────
def test_options_mapping_from_camel_case() -> None:
    opts = job_mod._options(
        {
            "options": {
                "asrPolicy": "cloud-first",
                "asrModel": "base",
                "chunkMs": 300000,
                "maxChapters": 5,
                "sceneThreshold": 0.25,
                "maxSlides": 42,
                "frameMode": "interval",
                "enableAsr": False,
                "enableOcr": False,
                "enableLlm": False,
                "requireWordTimestamps": True,
                "resume": False,
            }
        }
    )
    assert opts.asr_policy == "cloud-first"
    assert opts.asr_model == "base"
    assert opts.chunk_ms == 300_000
    assert opts.max_chapters == 5
    assert opts.scene_threshold == 0.25
    assert opts.max_slides == 42
    assert opts.frame_mode == "interval"
    assert opts.enable_asr is False
    assert opts.enable_ocr is False
    assert opts.enable_llm is False
    assert opts.require_word_timestamps is True
    assert opts.resume is False


def test_options_ignores_unknown_and_null() -> None:
    opts = job_mod._options({"options": {"asrModel": None, "whatever": 1}})
    assert opts.asr_model == "tiny", "None 不该覆盖默认值"
    assert not hasattr(opts, "whatever")


def test_options_defaults_when_absent() -> None:
    opts = job_mod._options({})
    assert opts.asr_policy == "local-first"
    assert opts.asr_model == "tiny"
    assert opts.enable_asr is True and opts.resume is True


def test_print_payload_schema_has_all_jobs() -> None:
    example = job_mod._PAYLOAD_EXAMPLE
    assert example["job"] == "video.parse"
    assert set(example["options"]) >= {"asrPolicy", "enableLlm", "resume"}
    assert "llm" in example, "LLM 配置由 Node 下发，示例里必须体现"


# ── 真机 E2E（默认跳过；``COURSE_KB_ASR_E2E=1`` 时跑）──────────────────
E2E = os.environ.get("COURSE_KB_ASR_E2E") == "1"


@pytest.mark.skipif(not E2E, reason="设 COURSE_KB_ASR_E2E=1 才跑真机 ASR（首次需下载模型/较慢）")
def test_real_chain_end_to_end_through_job(tmp_path) -> None:
    """★ 真机全链：SAPI 中文语音视频 → **不注入任何假实现** →
    真 faster-whisper（``local-fw`` provider）→ 真 SRT/文稿/导图/帧。

    这条覆盖"测试走 A 路、生产走 B 路"的风险：走的是**和 Node 完全一样的** job 入口。
    """
    video = synth.synth_narrated_video(
        str(tmp_path / "narrated.mp4"),
        duration_ms=20_000,
        sentence="今天我们讲数据库索引，B加树是最常用的索引结构。",
    )
    work = str(tmp_path / "w")
    rc, events, _ = _run(
        {
            "job": "video.parse",
            "docId": "doc_real",
            "videoPath": video,
            "title": "真机自检：索引",
            "workDir": work,
            "options": {"maxSlides": 5, "enableLlm": False},
        }
    )
    assert rc == 0, [e for e in events if e["type"] == "error"]
    result = _of(events, "result")[0]["data"]
    assert result["provider"]["asrAvailable"] is True, result["provider"]["asrReason"]
    assert result["provider"]["usedProvider"] == "local-fw"
    sub = _of(events, "subtitle_ready")[0]["data"]
    assert sub["cues"] >= 1
    assert sub["firstMs"] == 0
    assert sub["lastMs"] <= 20_400
    art = result["artifact"]
    assert art["asr_lang"] == "zh"
    assert len(art["segments"]) >= 1
    text = "".join(s["text"] for s in art["segments"])
    assert any("\u4e00" <= ch <= "\u9fff" for ch in text), f"转写结果没有中文：{text!r}"
    jian = _of(events, "transcript_ready")[0]["data"]
    assert jian["coveredMs"] == [0, art["duration_ms"]]
    print(
        f"\n[真机链] provider={result['provider']['usedProvider']} 段={len(art['segments'])} "
        f"字幕={sub['cues']}条 lang={art['asr_lang']} 文本={text[:60]!r}"
    )
