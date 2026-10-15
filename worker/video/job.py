"""视频 job 的 **JSONL 协议入口**（``docs/ARCHITECTURE_V2.md`` §3.1）。

Node 侧调用::

    spawn("python", ["-m", "worker.cli", "--job", "video.parse", "--in", "<json>"])
        stdin : 一个 JSON（任务参数）
        stdout: 一行一个 JSON（**严格 JSONL**）
        stderr: 日志（**非协议**）

本模块也能**独立运行**（cli.py 还没接上时也能测协议）::

    python -m worker.video.job --in '{"job":"video.parse",...}'
    echo '<json>' | python -m worker.video.job

## 事件（type）

| 事件 | 何时 | data |
|---|---|---|
| ``progress`` | 每阶段 | ``{stage, frac, detail}`` |
| ``log`` | 关键节点 | ``{level, msg}`` |
| ``subtitle_ready`` | S3 完成 | ``{cues, firstMs, lastMs, srtChars, vttChars, srtPath, vttPath}`` |
| ``transcript_ready`` | S4/S5 完成 | ``{chapters, source, titles, summaryChars, coveredMs}`` |
| ``mindmap_ready`` | S6 完成 | ``{format, content, nodes, source}`` |
| ``slides_ready`` | S7 完成 | ``{count, mode, atMs, ocrHits}`` |
| ``result`` | 结束 | 见 :func:`_result_payload` |
| ``error`` | 失败 | ``{code, msg, detail}`` |

**退出码**：``0`` = 完成（**可能带降级**，看 ``result.degraded[]``）；``1`` = 失败/取消。

## ⚠️ 切帧教训（跨语言有效）

Node 侧**不要用 readline**：``U+2028``/``U+2029`` 在 JSON 字符串里合法，会被错误切帧。
按 ``\\n`` 切**字节流**（``docs/ARCHITECTURE_V2.md`` §3.1）。本模块用
``ensure_ascii=True`` 输出（把非 ASCII 转义掉），**额外**降低这类风险。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Callable

from . import mindmap as mindmap_mod
from . import runner as runner_mod
from . import slides as slides_mod
from . import subtitle as subtitle_mod
from .errors import JobCancelled, VideoError
from .llm import make_text_model
from .providers import provider_capabilities
from .subtitle import validate_timeline

#: 本模块负责的 job 名前缀（backend-core 的 cli.py 按此前缀分派）
JOB_PREFIX = "video."
#: 支持的 job
JOBS = (
    "video.parse",
    "video.caps",
    "video.manual_subtitles",
    # ★ 云端 ASR 的 plan/convert（OpenRouter 调用在 Node；见 cloud_asr.py 模块文档）
    "video.asr.plan",
    "video.asr.convert",
)

EmitFn = Callable[[dict], None]


# ── 事件发射 ────────────────────────────────────────────────────────────
class Emitter:
    """把事件写成**严格 JSONL**（一行一个 JSON，``ensure_ascii=True``）。

    ``ensure_ascii=True`` 是刻意的：中文全部转义成 ``\\uXXXX``，
    输出里**永远只有 ASCII**，Node 侧任何切帧实现都不会被多字节字符坑到。
    """

    def __init__(self, stream: Any = None):
        self.stream = stream or sys.stdout

    def __call__(self, event: dict) -> None:
        line = json.dumps(event, ensure_ascii=True, separators=(",", ":"))
        self.stream.write(line + "\n")
        self.stream.flush()

    # 便捷构造
    def progress(self, stage: str, frac: float, detail: dict | None = None) -> None:
        self({"type": "progress", "stage": stage, "frac": round(max(0.0, min(1.0, frac)), 4),
              "detail": detail or {}})

    def log(self, msg: str, level: str = "info") -> None:
        self({"type": "log", "level": level, "msg": msg})

    def ready(self, kind: str, data: dict) -> None:
        self({"type": f"{kind}_ready", "data": data})

    def result(self, data: dict) -> None:
        self({"type": "result", "data": data})

    def error(self, code: str, msg: str, detail: str = "") -> None:
        self({"type": "error", "code": code, "msg": msg, "detail": detail})


# ── 入口 ────────────────────────────────────────────────────────────────
def run_job(payload: dict, emit: EmitFn, *, providers: dict | None = None) -> int:
    """执行一个视频 job。

    :param payload: ``{"job": "video.parse", "docId": "...", "videoPath": "...", ...}``
    :param emit: 事件回调（一行一个 JSON；见模块文档）
    :param providers: **可选**的 ASR provider 注册表覆盖（测试/内联用；
        生产为 ``None`` 走全局注册表）。签名与 backend-core 约定的两参数形式兼容。
    :return: 退出码（``0`` 完成 / ``1`` 失败或取消）
    """
    job = str(payload.get("job") or "").strip()
    if not job:
        emit({"type": "error", "code": "E_JOB", "msg": "payload 缺少 job 字段",
              "detail": f"支持：{list(JOBS)}"})
        return 1
    if job == "video.caps":
        return _run_caps(payload, emit)
    if job == "video.manual_subtitles":
        return _run_manual(payload, emit)
    if job == "video.asr.plan":
        return _run_asr_plan(payload, emit)
    if job == "video.asr.convert":
        return _run_asr_convert(payload, emit)
    if job != "video.parse":
        emit({"type": "error", "code": "E_JOB", "msg": f"未知 job：{job}",
              "detail": f"支持：{list(JOBS)}"})
        return 1
    return _run_parse(payload, emit, providers=providers)


def _wire(payload: dict):
    """读入参：**两种调用习惯都认**。

    * 扁平 camelCase（``video.parse`` 一直这么用）：``{"videoPath": …, "workDir": …}``
    * 嵌套 snake_case（Node ``runner`` 传 ``input`` 的习惯，见 ``cli.normalize_payload``）：
      ``{"input": {"video_path": …, "work_dir": …}}``

    ★ 两种都认是**刻意的**：Node 侧调用器风格不统一（`asr` job 走 ``input`` + snake_case，
    ``video.parse`` 走扁平 camelCase），让 worker 兼容比让每个调用点记住风格更不容易踩坑。
    """

    inner = payload.get("input") if isinstance(payload.get("input"), dict) else {}

    def pick(*names: str, default: Any = None) -> Any:
        for src in (payload, inner):
            for n in names:
                if n in src and src[n] is not None:
                    return src[n]
        return default

    return pick


def _run_asr_plan(payload: dict, emit: EmitFn) -> int:
    """``video.asr.plan``：**只产媒体**（抽音频 + 切块 + 断点）→ 交给 Node 调 OpenRouter。

    入参（两种写法都认，见 :func:`_wire`）::

        {"job":"video.asr.plan","videoPath":"…","workDir":"…",
         "options":{"chunkMs":30000,"resume":true,"language":"zh"}}

    出参见 :func:`worker.video.cloud_asr.plan`。★ 本 job **不加载任何模型、不发 HTTP**。
    """
    from . import cloud_asr as cloud

    pick = _wire(payload)
    options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
    video = str(pick("videoPath", "path", "video_path") or "")
    doc_id = str(pick("docId", "doc_id") or "")
    work_dir = str(pick("workDir", "work_dir", "artifactDir") or "")
    if not video:
        emit({"type": "error", "code": "E_JOB", "msg": "video.asr.plan 需要 videoPath",
              "detail": f"收到 payload keys={sorted(payload)}"})
        return 1
    if not work_dir:
        work_dir = runner_mod.default_work_dir(doc_id or os.path.basename(video))

    chunk_ms = int(options.get("chunkMs") or options.get("chunk_ms")
                   or pick("chunkMs", "chunk_ms", default=cloud.DEFAULT_CLOUD_CHUNK_MS))
    language = str(options.get("language") or pick("language", default="") or "")
    resume = bool(options.get("resume", True))
    model_hint = str(options.get("model") or pick("model", default="") or "")

    emit({"type": "log", "level": "info",
          "msg": f"云端 ASR plan：抽音频 + 切 {chunk_ms}ms 块 → {work_dir}"
                 f"（OpenRouter 调用由 Node 负责；本进程不回退本地）"})

    def on_progress(frac: float, stage: str) -> None:
        emit({"type": "progress", "stage": stage or "asr.plan",
              "frac": round(0.02 + 0.18 * max(0.0, min(1.0, frac)), 4), "detail": {}})

    try:
        out = cloud.plan(
            video_path=video,
            work_dir=work_dir,
            chunk_ms=chunk_ms,
            language=language,
            resume=resume,
            model_hint=model_hint,
            on_progress=on_progress,
        )
    except VideoError as exc:
        emit({"type": "error", "code": exc.code, "msg": exc.message, "detail": exc.detail})
        return 1

    est = out.get("estimate") or {}
    if est.get("measured"):
        emit({"type": "log", "level": "info",
              "msg": f"计费估算（**实测**口径）：{out['chunksTotal']} 次调用 / "
                     f"{est.get('audioSeconds')}s 音频 ≈ ${est.get('usd')}"
                     f"（≈${est.get('usdPerAudioMinute')}/分钟音频、"
                     f"≈${est.get('usdPerAudioHour')}/小时视频；USD；音频时长是大头）"})
    else:
        emit({"type": "log", "level": "warning",
              "msg": f"计费估算不可用：{est.get('reason')}"})
    emit({"type": "result", "data": out})
    return 0


def _run_asr_convert(payload: dict, emit: EmitFn) -> int:
    """``video.asr.convert``：Node 的云端转写结果 → 段 + 与本地 ``asr`` job 同形的产物。

    入参::

        {"job":"video.asr.convert",
         "plan": {…video.asr.plan 的 result…},
         "transcriptions":[{"index":0,"text":"…","model":"…","usage":{…}}, …],
         "model":"mistralai/voxtral-small-24b-2507"}

    ★ ``transcriptions`` 也支持 ``transcriptionsPath``（大 payload 时 Node 落盘再传路径）。
    ★ 缺块 / 全空 → **如实失败**，绝不回退本地、绝不产出空字幕。
    """
    from . import cloud_asr as cloud

    pick = _wire(payload)
    plan_data = pick("plan", "planData", "plan_data", default=None)
    if isinstance(plan_data, str) and os.path.isfile(plan_data):
        with open(plan_data, encoding="utf-8") as fh:
            plan_data = json.load(fh)
    if not isinstance(plan_data, dict):
        emit({"type": "error", "code": "E_JOB", "msg": "video.asr.convert 需要 plan 对象",
              "detail": f"收到 payload keys={sorted(payload)}"})
        return 1

    items = pick("transcriptions", "texts", default=None)
    tpath = pick("transcriptionsPath", "transcriptions_path", default=None)
    if items is None and tpath and os.path.isfile(str(tpath)):
        with open(str(tpath), encoding="utf-8") as fh:
            items = json.load(fh)
    if not isinstance(items, list):
        emit({"type": "error", "code": "E_JOB",
              "msg": "video.asr.convert 需要 transcriptions 数组（或 transcriptionsPath）"})
        return 1

    work_dir = str(pick("workDir", "work_dir", default="") or "")
    model = str(pick("model", default="") or "")
    language = str(pick("language", default="") or "")
    elapsed_ms = int(pick("elapsedMs", "elapsed_ms", default=0) or 0)

    def on_progress(frac: float, stage: str) -> None:
        emit({"type": "progress", "stage": stage or "asr.convert",
              "frac": round(0.05 + 0.9 * max(0.0, min(1.0, frac)), 4), "detail": {}})

    try:
        out = cloud.convert(
            plan_data=plan_data,
            transcriptions=items,
            model=model,
            work_dir=work_dir or None,
            language=language,
            on_progress=on_progress,
            elapsed_ms=elapsed_ms,
        )
    except VideoError as exc:
        # ★ 如实失败（含 E_ASR_CLOUD_MISSING / E_ASR_EMPTY）——**不降级到本地**
        emit({"type": "error", "code": exc.code, "msg": exc.message, "detail": exc.detail})
        return 1

    emit({"type": "log", "level": "info",
          "msg": f"云端 ASR 完成：{out['model']}（{out['asrSource']}，块级时间戳）"
                 f" 段={len(out['segments'])} 块={out['chunksDone']}/{out['chunksTotal']}"
                 f" 续推={out['chunksResumed']}"})
    emit({"type": "result", "data": out})
    return 0


def _run_caps(payload: dict, emit: EmitFn) -> int:
    """``video.caps``：ASR/OCR/LLM/ffmpeg 能力快照（``docs/PROVIDERS.md`` §7 格式）。"""
    policy = str(payload.get("policy") or runner_mod.VideoOptions().asr_policy)
    health = bool(payload.get("health", False))
    emit({"type": "log", "level": "info", "msg": f"探测视频能力（policy={policy}, health={health}）"})
    cap = {
        "providers": {"asr": provider_capabilities(policy=policy, health=health)["providers"]},
        "policy": {"asr": policy},
        "asr": provider_capabilities(policy=policy, health=health),
        "ocr": slides_mod.ocr_availability(),
        "ffmpeg": _ffmpeg_caps(),
        "slides": {
            "kind": slides_mod.SLIDE_KIND_IMAGE,
            "note": "视频内 PPT 抽出的是**图片帧**（JPEG）+ 时间点，不是可编辑 PPT",
        },
    }
    emit({"type": "result", "data": cap})
    return 0


def _run_manual(payload: dict, emit: EmitFn) -> int:
    """``video.manual_subtitles``：坑 10 的降级路径（ASR 不可用时人工上传字幕）。"""
    doc_id = str(payload.get("docId") or "")
    text = str(payload.get("text") or payload.get("subtitleText") or "")
    if not doc_id or not text.strip():
        emit({"type": "error", "code": "E_JOB", "msg": "manual_subtitles 需要 docId 与 text"})
        return 1
    duration_ms = int(payload.get("durationMs") or 0)
    work_dir = str(payload.get("workDir") or runner_mod.default_work_dir(doc_id, payload.get("artifactDir")))
    cfg = payload.get("llm")
    llm, llm_reason = make_text_model(cfg if isinstance(cfg, dict) else None)
    emit({"type": "log", "level": "info", "msg": f"人工字幕：{'LLM 可用' if llm else llm_reason}"})
    try:
        outcome = runner_mod.apply_manual_subtitles(
            text,
            doc_id=doc_id,
            duration_ms=duration_ms or _guess_duration(text),
            work_dir=work_dir,
            title=str(payload.get("title") or ""),
            options=_options(payload),
            llm=llm,
        )
    except VideoError as exc:
        emit({"type": "error", "code": exc.code, "msg": exc.message, "detail": exc.detail})
        return 1
    _emit_ready(emit, outcome)
    emit({"type": "result", "data": _result_payload(outcome, doc_id, work_dir)})
    return 0


def _run_parse(payload: dict, emit: EmitFn, *, providers: dict | None = None) -> int:
    doc_id = str(payload.get("docId") or "")
    video = str(payload.get("videoPath") or payload.get("path") or "")
    if not doc_id or not video:
        emit({"type": "error", "code": "E_JOB", "msg": "video.parse 需要 docId 与 videoPath",
              "detail": f"收到 payload keys={sorted(payload)}"})
        return 1
    if not os.path.isfile(video):
        emit({"type": "error", "code": "E_NOTFOUND", "msg": f"视频文件不存在：{video}"})
        return 1

    opts = _options(payload)
    if providers is not None:
        opts.asr_providers = providers
    work_dir = str(payload.get("workDir") or runner_mod.default_work_dir(doc_id, payload.get("artifactDir")))
    title = str(payload.get("title") or os.path.splitext(os.path.basename(video))[0])

    # ★ v2：LLM 配置从 job 参数来（worker 不读凭据）
    cfg = payload.get("llm")
    if not opts.enable_llm:
        llm, llm_reason = None, "本次任务关闭了 LLM（enableLlm=false）"
    else:
        llm, llm_reason = make_text_model(cfg if isinstance(cfg, dict) else None)
    emit({"type": "log", "level": "info",
          "msg": f"视频解析开始：{video} → {work_dir}（ASR 策略 {opts.asr_policy}）"})
    emit({"type": "log", "level": "info" if llm else "warning",
          "msg": f"LLM：{'可用' if llm else llm_reason}"})

    stages_seen: list[str] = []

    def on_progress(frac: float, stage: str) -> None:
        if stage and (not stages_seen or stages_seen[-1] != stage):
            stages_seen.append(stage)
            emit({"type": "log", "level": "info", "msg": f"阶段：{stage}"})
        emit({"type": "progress", "stage": stage or "video", "frac": frac, "detail": {}})

    try:
        outcome = runner_mod.run_pipeline(
            video,
            doc_id,
            work_dir=work_dir,
            options=opts,
            llm=llm,
            title=title,
            on_progress=on_progress,
            should_cancel=lambda: False,
        )
    except JobCancelled as exc:
        emit({"type": "error", "code": "E_CANCELLED", "msg": exc.message, "detail": exc.detail})
        return 1
    except VideoError as exc:
        emit({"type": "error", "code": exc.code, "msg": exc.message, "detail": exc.detail})
        return 1

    for note in outcome.degraded:
        emit({"type": "log", "level": "warning", "msg": f"降级：{note}"})
    _emit_ready(emit, outcome)
    emit({"type": "result", "data": _result_payload(outcome, doc_id, work_dir)})
    return 0


def _ready(emit: EmitFn, kind: str, data: dict) -> None:
    """发一个 ``{kind}_ready`` 帧。

    ⚠️ **只用可调用协议 ``emit({...})``**，不要用 ``emit.ready(...)``。
    工程里有**两个** Emitter：
    * ``worker/video/job.py::Emitter``（本模块的，有 ``.ready()``）
    * ``worker/cli.py::Emitter``（**生产路径**用的那个，只有
      ``__call__ / progress / info / warn / unit / result / error``，**没有 ``ready``**）

    原实现这里写的是 ``emit.ready("subtitle", …)`` —— 单测用的是本模块的 Emitter（有该方法）
    所以一直是绿的；但走 ``python -m worker.cli --job video.parse`` 时会在**最后一步上报**炸掉：
    ``AttributeError: 'Emitter' object has no attribute 'ready'``。
    实测后果很坑：**整条管线跑完、产物全部落盘**（音频/5 段 ASR/字幕/文稿/思维导图/幻灯片帧），
    却在"上报"这一步崩 → 退出码 1 + ``E_INTERNAL`` + 没有 ``*_ready``/``result`` 帧
    ⟹ Node 侧看到的是"失败"，而实际活儿已经干完了（反向的"看起来失败"）。
    两者唯一的公共接口就是 ``__call__``，所以统一用它。
    """
    emit({"type": f"{kind}_ready", "data": data})


def _emit_ready(emit: EmitFn, outcome: runner_mod.PipelineOutcome) -> None:
    """发 4 类"产物就绪"事件（Lead 要求的 ``*_ready``）。"""
    art = outcome.artifact
    if art.subtitle_srt:
        cues = subtitle_mod.parse_srt(art.subtitle_srt)
        validate_timeline(cues, duration_ms=art.duration_ms)
        st = outcome.stages.get("subtitle") or {}
        _ready(
            emit,
            "subtitle",
            {
                "cues": len(cues),
                "firstMs": cues[0].start,
                "lastMs": cues[-1].end,
                "srtChars": len(art.subtitle_srt),
                "vttChars": len(art.subtitle_vtt),
                "srtPath": st.get("srt_path", ""),
                "vttPath": st.get("vtt_path", ""),
                "url": f"/api/v1/documents/{art.doc_id}/video/subtitle?fmt=srt",
            },
        )
    if art.transcript:
        _ready(
            emit,
            "transcript",
            {
                "chapters": len(art.transcript),
                "source": outcome.transcript_source,
                "titles": [c.title for c in art.transcript],
                "summaryChars": sum(len(c.summary) for c in art.transcript),
                "coveredMs": [art.transcript[0].start, art.transcript[-1].end],
                "url": f"/api/v1/documents/{art.doc_id}/video/transcript",
            },
        )
    if art.mindmap_content:
        tree = mindmap_mod.to_tree(art.mindmap_content)
        _ready(
            emit,
            "mindmap",
            {
                "format": art.mindmap_format,
                "content": art.mindmap_content,
                "nodes": mindmap_mod.node_count(tree),
                "source": outcome.mindmap_source,
                "tree": tree,  # 前端可直接渲染可折叠树，不必引 markmap
                "url": f"/api/v1/documents/{art.doc_id}/video/mindmap",
            },
        )
    if art.slides:
        _ready(
            emit,
            "slides",
            {
                "count": len(art.slides),
                "mode": (outcome.stages.get("slides") or {}).get("mode", "scene"),
                "atMs": [s.at_ms for s in art.slides],
                "ocrHits": int((outcome.stages.get("slides") or {}).get("ocr_hits", 0)),
                "kind": slides_mod.SLIDE_KIND_IMAGE,
                "note": "图片帧（JPEG）+ 时间点，不是可编辑 PPT",
                "url": f"/api/v1/documents/{art.doc_id}/video/slides",
            },
        )


def _result_payload(outcome: runner_mod.PipelineOutcome, doc_id: str, work_dir: str) -> dict:
    """``result`` 事件的数据体。

    ``artifact`` 用**契约 §2.7 的 snake_case**（Node 直接入库/下发）；
    ``provider`` 用**camelCase**（跨语言的 provider 契约，见 ``docs/PROVIDERS.md`` §2.2）。
    """
    art = outcome.artifact
    return {
        "docId": doc_id,
        "artifact": art.to_dict(),
        "provider": {
            "usedProvider": outcome.asr_provider,
            "degradedFrom": outcome.asr_degraded_from,
            "asrAvailable": outcome.asr_available,
            "asrReason": outcome.asr_reason,
            "transcriptSource": outcome.transcript_source,
            "mindmapSource": outcome.mindmap_source,
            "ocrAvailable": outcome.ocr_available,
            "llmAvailable": outcome.llm_available,
            "llmReason": outcome.llm_reason,
        },
        "stages": outcome.stages,
        "degraded": outcome.degraded,
        "media": outcome.media,
        "workDir": work_dir,
        "files": {
            "audio": os.path.join(work_dir, "audio.wav"),
            "srt": os.path.join(work_dir, "subtitle.srt"),
            "vtt": os.path.join(work_dir, "subtitle.vtt"),
            "mindmap": os.path.join(work_dir, "mindmap.md"),
            "chapters": os.path.join(work_dir, "chapters.json"),
            "slides": os.path.join(work_dir, "slides.json"),
            "framesDir": os.path.join(work_dir, "frames"),
            "state": os.path.join(work_dir, "state.json"),
        },
        "elapsedMs": outcome.elapsed_ms,
        "hasText": outcome.has_text,
    }


# ── 参数解析 ────────────────────────────────────────────────────────────
def _options(payload: dict) -> runner_mod.VideoOptions:
    """``payload.options``（camelCase）→ :class:`VideoOptions`（snake_case）。"""
    raw = payload.get("options") or {}
    if not isinstance(raw, dict):
        raw = {}
    merged = {**(payload.get("options_snake") or {}), **raw}
    opts = runner_mod.VideoOptions()
    mapping = {
        "asrModel": "asr_model",
        "asrLang": "asr_lang",
        "asrPolicy": "asr_policy",
        "asrProvider": "asr_provider",
        "requireWordTimestamps": "require_word_timestamps",
        "chunkMs": "chunk_ms",
        "maxChapters": "max_chapters",
        "sceneThreshold": "scene_threshold",
        "maxSlides": "max_slides",
        "minFrameGapMs": "min_frame_gap_ms",
        "frameMode": "frame_mode",
        "fallbackIntervalMs": "fallback_interval_ms",
        "enableAsr": "enable_asr",
        "enableSlides": "enable_slides",
        "enableOcr": "enable_ocr",
        "enableLlm": "enable_llm",
        "wordTimestamps": "word_timestamps",
        "vadFilter": "vad_filter",
        "beamSize": "beam_size",
        "resume": "resume",
        "allowMechanicalFallback": "allow_mechanical_fallback",
    }
    for src, dst in mapping.items():
        if src in merged and merged[src] is not None:
            value = merged[src]
            if isinstance(getattr(opts, dst), bool):
                value = bool(value)
            elif isinstance(getattr(opts, dst), int) and not isinstance(getattr(opts, dst), bool):
                value = int(value)
            elif isinstance(getattr(opts, dst), float):
                value = float(value)
            setattr(opts, dst, value)
    for dst in mapping.values():  # 也接受 snake_case 直传
        if dst in merged and merged[dst] is not None:
            setattr(opts, dst, merged[dst])
    return opts


def _ffmpeg_caps() -> dict:
    from .ffmpeg_util import find_ffmpeg, has_ffprobe

    try:
        path = find_ffmpeg()
        return {
            "available": True,
            "path": path,
            # ⚠️ 本机**只有 ffmpeg.exe**，没有 ffprobe.exe（实测）→ 媒体信息靠 `ffmpeg -i` 头解析
            "ffprobe": has_ffprobe(),
            "note": "无 ffprobe：时长/流信息由 `ffmpeg -i` 的 stderr 头解析",
        }
    except VideoError as exc:
        return {"available": False, "path": "", "ffprobe": False, "reason": exc.message}


def _guess_duration(text: str) -> int:
    """人工字幕没给片长时，用最后一条字幕的结束时间兜底（比猜 0 强）。"""
    cues = subtitle_mod.detect_and_parse(text)
    return int(cues[-1].end) if cues else 0


# ── CLI ─────────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001
            pass
    ap = argparse.ArgumentParser(description="视频 job（JSONL 协议，ARCHITECTURE_V2 §3.1）")
    ap.add_argument("--in", dest="infile", default="", help="payload JSON 文件（缺省读 stdin）")
    ap.add_argument("--job", default="", help="覆盖 payload 里的 job 名")
    ap.add_argument("--print-payload-schema", action="store_true", help="打印 payload 示例后退出")
    args = ap.parse_args(argv)

    if args.print_payload_schema:
        print(json.dumps(_PAYLOAD_EXAMPLE, ensure_ascii=False, indent=2))
        return 0

    raw = ""
    if args.infile:
        with open(args.infile, encoding="utf-8") as fh:
            raw = fh.read()
    else:
        raw = sys.stdin.read()
    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        Emitter()({"type": "error", "code": "E_JOB_JSON", "msg": f"payload 不是合法 JSON：{exc}"})
        return 1
    if not isinstance(payload, dict):
        Emitter()({"type": "error", "code": "E_JOB_JSON", "msg": "payload 必须是 JSON 对象"})
        return 1
    if args.job:
        payload["job"] = args.job
    return run_job(payload, Emitter())


#: payload 示例（`--print-payload-schema` 直接打印，给 Node 侧照着拼）
_PAYLOAD_EXAMPLE: dict[str, Any] = {
    "job": "video.parse",
    "docId": "doc_5f786d5e5007",
    "videoPath": "data/uploads/doc_5f786d5e5007/lesson.mp4",
    "title": "第 3 讲 索引原理",
    "workDir": "data/artifacts/doc_5f786d5e5007",
    "llm": {"base_url": "https://…/v1", "api_key": "<由 Node 下发，worker 不读 .env>", "model": "deepseek-v4.1-flash"},
    "options": {
        "asrPolicy": "local-first",
        "asrProvider": None,
        "asrModel": "tiny",
        "asrLang": None,
        "requireWordTimestamps": False,
        "chunkMs": 600000,
        "maxChapters": 8,
        "sceneThreshold": 0.4,
        "maxSlides": 200,
        "frameMode": "auto",
        "enableAsr": True,
        "enableSlides": True,
        "enableOcr": True,
        "enableLlm": True,
        "resume": True,
    },
}


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
