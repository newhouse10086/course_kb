# -*- coding: utf-8 -*-
"""云端 ASR（``video.asr.plan`` / ``video.asr.convert``）的测试。

## 零额度
本文件**不发起任何网络请求**（OpenRouter 调用在 Node 侧，Python 这边根本不发 HTTP）：
用**假 transcriptions** 模拟 Node 回传的结果，覆盖"缺块 / 空文本 / 续推 / 时间戳"。

## 三条硬要求对应的测试
1. ★ **绝不静默降级回本地** → :func:`test_plan_and_convert_never_touch_local_model`
   把本地模型加载换成"一调用就炸"，plan/convert **仍必须跑通**（= 这两条路根本不碰本地）。
2. ★ **不许产出空字幕假装成功** → 全空文本必须抛 ``E_ASR_EMPTY``；缺块必须抛 ``E_ASR_CLOUD_MISSING``。
3. ★ **如实标注来源 + 实际模型 + 粒度** → ``asrSource='openrouter'`` / ``timestamps='chunk'`` /
   ``wordTimestamps=False``，且**与实际调用路径同源**（见 ``test_meta_source_matches_actual_path``）。
"""

from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from worker.video import cloud_asr as C  # noqa: E402
from worker.video import job as job_mod  # noqa: E402
from worker.video import synth  # noqa: E402
from worker.video.errors import VideoError  # noqa: E402

CHUNK_MS = 2_000
DUR_MS = 6_000


@pytest.fixture(scope="module")
def audio(tmp_path_factory) -> str:
    """6.0s / 16k 单声道 WAV（正弦音）—— 时长为**整数毫秒**，所以块边界是确定值。"""
    d = tmp_path_factory.mktemp("cloud_asr")
    return synth.synth_audio(str(d / "a.wav"), duration_ms=DUR_MS)


def _plan(audio: str, work: str, **kw) -> dict:
    return C.plan(video_path=audio, work_dir=work, chunk_ms=kw.pop("chunk_ms", CHUNK_MS), **kw)


def _texts(n: int) -> list[dict]:
    return [{"index": i, "text": f"第{i}块文本", "model": "mistralai/voxtral-small-24b-2507"} for i in range(n)]


# ── plan：媒体 + 边界 + 断点 ─────────────────────────────────────────────
def test_plan_splits_audio_with_exact_offsets(audio: str, tmp_path) -> None:
    p = _plan(audio, str(tmp_path / "w"))
    assert p["durationMs"] == DUR_MS
    assert p["chunkMs"] == CHUNK_MS
    assert p["chunksTotal"] == 3, "6s / 2s → 恰好 3 块（不多出空的尾块）"
    assert [(c["index"], c["startMs"], c["endMs"]) for c in p["chunks"]] == [
        (0, 0, 2_000),
        (1, 2_000, 4_000),
        (2, 4_000, 6_000),
    ], "块边界必须是**确定值**（这是块级时间戳的唯一来源）"
    for c in p["chunks"]:
        assert os.path.isfile(c["path"]), f"块文件必须真落盘：{c['path']}"
        assert os.path.getsize(c["path"]) > 44
        assert c["done"] is False
    assert os.path.isfile(p["audioPath"])


def test_plan_marks_stage_and_does_not_pretend_transcribed(audio: str, tmp_path) -> None:
    """★ plan 只是"媒体就绪"：**不许**报出段来假装已经转写。"""
    p = _plan(audio, str(tmp_path / "w"))
    assert p["meta"]["stage"] == "awaiting_cloud_asr"
    assert p["meta"]["asrSource"] == C.CLOUD_ASR_SOURCE
    assert p["segmentsSoFar"] == [], "还没调云端 → 不许有段"
    assert "不会**回退本地" in p["meta"]["note"] or "不会" in p["meta"]["note"]
    assert p["requires"] == {
        "perChunkText": True,
        "wordTimestamps": False,
        "timestamps": "chunk",
        "chunkMs": CHUNK_MS,
    }, "必须显式告诉 Node：要每块一条文本，且**没有**词级时间戳"


# ── ★ 硬要求 1：绝不碰本地模型 ──────────────────────────────────────────
def test_plan_and_convert_never_touch_local_model(audio: str, tmp_path, monkeypatch) -> None:
    """★ 守卫：把本地模型加载换成"一调用就炸" → plan/convert **仍必须跑通**。

    这证明云端这两条路**根本不碰** faster-whisper（不是"碰巧没用"，是"用不了"）。
    """
    from worker.video import asr as asr_mod

    def boom(*a, **k):  # noqa: ANN002, ANN003
        raise AssertionError("云端路径**绝不允许**加载本地 ASR 模型！")

    monkeypatch.setattr(asr_mod, "load_model_with_fallback", boom)
    monkeypatch.setattr(asr_mod, "transcribe_audio", boom)

    work = str(tmp_path / "w")
    p = _plan(audio, work)
    out = C.convert(plan_data=p, transcriptions=_texts(3), model="mistralai/voxtral-small-24b-2507")
    assert len(out["segments"]) == 3
    assert out["asrSource"] == C.CLOUD_ASR_SOURCE


# ── ★ 硬要求 2：缺块 / 空文本不许假装成功 ───────────────────────────────
def test_missing_chunk_fails_honestly(audio: str, tmp_path) -> None:
    p = _plan(audio, str(tmp_path / "w"))
    with pytest.raises(VideoError) as ei:
        C.convert(plan_data=p, transcriptions=_texts(1), model="voxtral")
    assert ei.value.code == "E_ASR_CLOUD_MISSING"
    assert "缺 2 块" in ei.value.message
    assert "不会**回退本地" in ei.value.detail or "不回退本地" in ei.value.detail


def test_all_empty_text_is_not_success(audio: str, tmp_path) -> None:
    """★ 坑 10：没有语音 → **绝不产出空字幕假装成功**。"""
    p = _plan(audio, str(tmp_path / "w"))
    with pytest.raises(VideoError) as ei:
        C.convert(plan_data=p, transcriptions=[{"index": i, "text": " "} for i in range(3)], model="voxtral")
    assert ei.value.code == "E_ASR_EMPTY"
    assert "不产出字幕与文稿" in ei.value.detail


def test_failed_run_does_not_poison_checkpoint(audio: str, tmp_path) -> None:
    """★ 回归（实测抓到）：失败的转换**不许**把块标成已完成。

    第一版"先落盘再判空"→ 一次全空失败会把 done_chunks 写成 [0,1,2]，
    之后每次重跑都"全部已完成、0 段" → **永久停摆**（而且看起来像"这视频没语音"）。
    """
    work = str(tmp_path / "w")
    p = _plan(audio, work)
    with pytest.raises(VideoError):
        C.convert(plan_data=p, transcriptions=[{"index": i, "text": ""} for i in range(3)], model="voxtral")
    p2 = _plan(audio, work)
    assert p2["doneChunks"] == [], "失败运行不得留断点"
    assert p2["segmentsSoFar"] == []
    # 重跑（这次有文本）必须真的能跑出来
    out = C.convert(plan_data=p2, transcriptions=_texts(3), model="voxtral")
    assert len(out["segments"]) == 3


# ── 段与时间戳：块级、绝对、单调 ────────────────────────────────────────
def test_convert_offsets_are_absolute_and_chunk_level(audio: str, tmp_path) -> None:
    p = _plan(audio, str(tmp_path / "w"))
    out = C.convert(plan_data=p, transcriptions=_texts(3), model="mistralai/voxtral-small-24b-2507")
    assert [(s["i"], s["startMs"], s["endMs"], s["text"]) for s in out["segments"]] == [
        (0, 0, 2_000, "第0块文本"),
        (1, 2_000, 4_000, "第1块文本"),
        (2, 4_000, 6_000, "第2块文本"),
    ], "段必须是**绝对时间**且等于块边界（块级粒度）"
    assert out["language"] == "unknown" or isinstance(out["language"], str)
    assert out["model"] == "mistralai/voxtral-small-24b-2507"
    assert out["durationMs"] == DUR_MS


def test_convert_reports_source_and_granularity_honestly(audio: str, tmp_path) -> None:
    """★ 坑 21：自述字段必须与实际同源 —— 粒度**只敢报块级**，不谎报词级。"""
    p = _plan(audio, str(tmp_path / "w"))
    out = C.convert(plan_data=p, transcriptions=_texts(3), model="voxtral")
    assert out["asrSource"] == "openrouter"
    assert out["timestamps"] == "chunk"
    assert out["wordTimestamps"] is False
    assert out["words"] == [], "没有词级时间戳就**不许**编（空数组，不是假数据）"
    assert out["device"] == "openrouter", "device 字段这里表示实际执行方（云端）"
    # 与本地 job 同形的字段也要在（Node 的 upsertVideoArtifact 不改）
    for k in ("segments", "language", "model", "durationMs", "chunksTotal", "chunksDone",
              "chunksResumed", "elapsedMs", "words", "langProbability"):
        assert k in out, f"与本地 asr job 同形的字段缺 {k}"


def test_segments_do_not_exceed_duration(audio: str, tmp_path) -> None:
    """块级段不得越界（拼接会裁到片长）—— 分章"覆盖全片不越界"靠它。"""
    p = _plan(audio, str(tmp_path / "w"))
    out = C.convert(plan_data=p, transcriptions=_texts(3), model="voxtral")
    assert max(s["endMs"] for s in out["segments"]) <= DUR_MS
    starts = [s["startMs"] for s in out["segments"]]
    assert starts == sorted(starts), "段必须单调不减"


# ── 断点续推 ────────────────────────────────────────────────────────────
def test_resume_skips_done_chunks_and_merges(audio: str, tmp_path) -> None:
    """★ 中断可续：先转 0,1（partial 落盘）→ 再补 2，且**不重跑前两块**。

    ★ 为什么第一段要 ``partial=True``：26 块的视频按块计费，跑到一半被杀时，
    没有 partial 的话断点里一条都没有 → 重跑要把前几块**再付一次钱**。
    partial 让"已付费的块"留痕，重跑只补剩下的。
    """
    work = str(tmp_path / "w")
    p1 = _plan(audio, work)
    r1 = C.convert(plan_data=p1, transcriptions=_texts(2), model="voxtral", partial=True)
    assert len(r1["segments"]) == 2
    assert r1["chunksResumed"] == 0, "第一次跑没有可续的块"
    assert r1["chunksDone"] == 2 and r1["chunksTotal"] == 3
    assert r1["partial"] is True, "块没齐 → **不许**声称完成"
    assert r1["missingChunks"] == [2]

    p2 = _plan(audio, work)
    assert p2["doneChunks"] == [0, 1], "plan 要能告诉 Node 哪些块已完成（它只需补剩下的）"
    assert len(p2["segmentsSoFar"]) == 2
    assert [c["done"] for c in p2["chunks"]] == [True, True, False]

    r2 = C.convert(plan_data=p2, transcriptions=[{"index": 2, "text": "第三块"}], model="voxtral")
    assert r2["chunksResumed"] == 2, "续推计数必须如实（2 块是复用断点的）"
    assert r2["chunksDone"] == 3 and r2["chunksTotal"] == 3
    assert r2["partial"] is False and r2["missingChunks"] == []
    assert [s["text"] for s in r2["segments"]] == ["第0块文本", "第1块文本", "第三块"]


def test_partial_without_any_text_still_persists_nothing(audio: str, tmp_path) -> None:
    """partial 且这一批全是空文本 → 返回 partial（0 段），但**不污染断点**。"""
    work = str(tmp_path / "w")
    p = _plan(audio, work)
    out = C.convert(plan_data=p, transcriptions=[{"index": 0, "text": ""}], model="voxtral", partial=True)
    assert out["partial"] is True and out["segments"] == []
    assert out["missingChunks"] == [1, 2]
    assert _plan(audio, work)["doneChunks"] == [], "没有文本产出就不该落盘"


def test_checkpoint_fingerprint_invalidates_on_chunk_change(audio: str, tmp_path) -> None:
    """换 chunk 粒度 → 旧断点作废（宁可重跑，也不把两种切法的段拼成怪物）。"""
    work = str(tmp_path / "w")
    _ = C.convert(plan_data=_plan(audio, work, chunk_ms=2_000), transcriptions=_texts(3), model="voxtral")
    p_other = _plan(audio, work, chunk_ms=3_000)
    assert p_other["chunksTotal"] == 2
    assert p_other["doneChunks"] == [], "粒度变了 → 断点必须作废"


# ── job 层（Node 真正调的那一层）────────────────────────────────────────
def _run(payload: dict) -> tuple[int, list[dict]]:
    events: list[dict] = []
    rc = job_mod.run_job(payload, events.append)
    return rc, events


def test_job_plan_and_convert_through_jsonl(audio: str, tmp_path) -> None:
    """★ 走 **job 入口**（和 Node 完全一样的路径）：plan → 假云端 → convert。"""
    work = str(tmp_path / "w")
    rc, events = _run({"job": "video.asr.plan", "docId": "doc_x", "videoPath": audio,
                       "workDir": work, "options": {"chunkMs": CHUNK_MS}})
    assert rc == 0, [e for e in events if e["type"] == "error"]
    plan_data = [e for e in events if e["type"] == "result"][0]["data"]
    assert plan_data["chunksTotal"] == 3
    assert any(e["type"] == "progress" for e in events)

    rc2, events2 = _run({"job": "video.asr.convert", "plan": plan_data,
                         "transcriptions": _texts(3), "model": "mistralai/voxtral-small-24b-2507",
                         "workDir": work})
    assert rc2 == 0, [e for e in events2 if e["type"] == "error"]
    out = [e for e in events2 if e["type"] == "result"][0]["data"]
    assert len(out["segments"]) == 3
    assert out["asrSource"] == "openrouter"


def test_job_plan_accepts_nested_snake_case_input(audio: str, tmp_path) -> None:
    """Node 的 runner 习惯用 ``input`` + snake_case（见 cli.normalize_payload）→ **必须也认**。"""
    rc, events = _run({"job": "video.asr.plan",
                       "input": {"video_path": audio, "work_dir": str(tmp_path / "w2"), "chunk_ms": CHUNK_MS}})
    assert rc == 0, [e for e in events if e["type"] == "error"]
    data = [e for e in events if e["type"] == "result"][0]["data"]
    assert data["chunksTotal"] == 3


def test_job_convert_missing_transcriptions_reports_error_frame(audio: str, tmp_path) -> None:
    """缺 transcriptions → **error 帧**（不是 result 帧），退出码非 0。"""
    rc, events = _run({"job": "video.asr.convert", "plan": _plan(audio, str(tmp_path / "w"))})
    assert rc == 1
    err = [e for e in events if e["type"] == "error"]
    assert err and err[0]["code"] == "E_JOB"
    assert not [e for e in events if e["type"] == "result"], "失败不许有 result 帧"


# ── 计费：没实测就**不许**给数字；实测了就要**对得上账单** ──────────────────
def test_cost_estimate_refuses_to_guess() -> None:
    """★ 坑 24/21：**没实测**的模型 → ``measured:false`` + 原因，**数值一律不给**。

    用户要拿这个数字决定"投多少钱"，猜的单价不能用（Lead 明确要求实测后写）。
    """
    raw = C.CloudCostModel(model="someone/new-asr")  # 没量过
    est = raw.estimate(13 * 60 * 1000, chunk_ms=30_000)
    assert est["measured"] is False
    assert est["reason"], "必须说明为什么没有数字"
    for k in ("usd", "usdPerAudioMinute", "usdPerAudioHour", "audioTokens", "completionTokens"):
        assert k not in est, f"没实测就不许给 {k}（宁可没有，也不给猜的）"
    assert est["calls"] == 26, "13 分钟 / 30s = 26 次调用（调用次数与单价无关，可以给）"
    assert est["audioSeconds"] == 780.0


def test_measured_model_reproduces_real_invoice() -> None:
    """★★ **实测自校验**：用实测换算率重建那张账单，必须**逐项对得上** ``usage``。

    2026-10-16 真调用（30.0s 音频）的原始字段：
    ``prompt_tokens=68``（其中 ``audio_tokens=30``）、``completion_tokens=185``、
    ``cost=0.0030593``（``prompt_cost=0.0030038`` + ``completion_cost=0.0000555``）。
    """
    est = C.MEASURED_COST.estimate(30_000, chunk_ms=30_000)
    assert est["measured"] is True
    assert est["audioTokens"] == 30, "30 秒音频 = 30 个 audio token（实测 1 token/秒）"
    assert est["audioUsd"] == pytest.approx(0.003, abs=1e-9), "30 × $0.0001"
    assert est["completionUsd"] == pytest.approx(0.0000555, abs=1e-9), "185 × $0.3/M"
    assert est["textUsd"] == pytest.approx(0.0000038, abs=1e-9), "38 × $0.1/M"
    # ★ 合计必须等于 OpenRouter 返回的 usage.cost
    assert est["usd"] == pytest.approx(0.0030593, abs=1e-7), "要与 usage.cost 逐位对上"


def test_cost_is_dominated_by_audio_minutes_not_text_tokens() -> None:
    """★ 计费口径的**关键事实**：账单大头是**音频时长**（不是文字 token）。

    ``$0.1/M in`` 这种说法会让用户以为很便宜；实测是 **≈$0.0061/分钟 ≈ $0.367/小时**。
    这条断言把这个口径钉住，防止后人按 token 单价"优化"出一个错的心智模型。
    """
    est = C.MEASURED_COST.estimate(3_600_000, chunk_ms=30_000)  # 1 小时视频
    assert est["calls"] == 120
    assert est["usdPerAudioMinute"] == pytest.approx(0.0061186, abs=1e-6)
    assert est["usdPerAudioHour"] == pytest.approx(0.367116, abs=1e-4)
    assert est["audioUsd"] > est["completionUsd"] * 50, "音频成本应远大于输出 token 成本"


def test_wall_time_estimate_uses_measured_throughput() -> None:
    """实测吞吐 6.28× 实时 → 1 小时视频 ≈ 9.6 分钟墙钟（不是"比实时快很多"的拍脑袋）。"""
    est = C.MEASURED_COST.estimate(3_600_000, chunk_ms=30_000)
    assert est["wallSecondsEstimate"] == pytest.approx(573.2, abs=1.0)
    assert C.MEASURED_COST.model == "mistralai/voxtral-small-24b-2507"
    assert C.MEASURED_COST.measured_at == "2026-10-16"


def test_module_has_no_http_and_no_whisper_import() -> None:
    """★ 结构性守卫：本模块**不许**真的导入 HTTP 客户端或本地 ASR。

    ⚠️ **用 AST 而不是字符串搜索** —— 第一版 ```if "import httpx" not in src``` 被
    **文件自己的文档**（那句"没有 ``import httpx``"）判红了：字符串搜索会把注释里的
    反例当成真代码。这正是坑 36「判据本身会撒谎」的迷你版：**先让检查方法可信**。
    AST 只看真正的 ``import`` 语句，注释/文档串一律不算。
    """
    import ast

    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "video", "cloud_asr.py")
    src = open(path, encoding="utf-8").read()
    tree = ast.parse(src)

    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])

    forbidden = {"httpx", "requests", "urllib", "aiohttp", "openai", "faster_whisper"}
    hit = imported & forbidden
    assert not hit, f"cloud_asr.py 不许导入 {sorted(hit)}（OpenRouter 调用只在 Node，本地 ASR 不许碰）"

    # 也不许"绕过 import 用法"地调本地转写（例如 asr_mod.transcribe_audio(...)）
    called = {
        n.func.attr if isinstance(n.func, ast.Attribute) else getattr(n.func, "id", "")
        for n in ast.walk(tree)
        if isinstance(n, ast.Call)
    }
    assert "transcribe_audio" not in called, "不许调用本地转写入口 transcribe_audio"
