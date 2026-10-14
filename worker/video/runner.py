"""视频流水线编排（S1 抽音频 → S2 ASR → S3 字幕 → S4/S5 分章+摘要 → S6 思维导图 → S7 抽帧）。

```
上传视频
  ├─ S1 抽音频      10%   ffmpeg → 16k/mono/pcm_s16le
  ├─ S2 ASR 转写     55%   faster-whisper（分段 + 断点）
  ├─ S3 字幕          5%   SRT/VTT（单调、不重叠）
  ├─ S4 文稿分章     12%   LLM（json_schema strict）；不可用 → 机械分节
  ├─ S5 全文摘要      3%   LLM
  ├─ S6 思维导图      5%   LLM → markmap；不可用 → 章节结构图
  └─ S7 幻灯片抽帧   10%   ffmpeg 场景检测 → 图片帧（有 OCR 才出 ocr_text）
```

## 断点（契约 C4）

每一步的产物都落盘在 ``<artifact_dir>/<doc_id>/``：

| 文件 | 复用条件 |
|---|---|
| ``audio.wav`` | 存在且头信息是 16k/单声道/16bit → 不重抽 |
| ``asr/asr.ckpt.json`` | 指纹一致 → 逐块跳过（见 ``asr.AsrCheckpoint``） |
| ``chapters.json`` | 存在 → **不重复调 LLM**（LLM 是最贵的一步） |
| ``mindmap.md`` | 存在 → 不重复调 LLM |
| ``frames/`` + ``slides.json`` | 存在 → 不重抽帧 |

## 坑 10：能力不可用时**如实降级**

* ASR 不可用 → ``asr_available=False`` + 真实 ``reason``；产物里
  ``segments=[] / subtitles 空 / transcript 空 / mindmap 空``，
  **绝不放空字幕文件冒充成功**；播放器 + 时间轴 + 幻灯片帧照常产出
* LLM 不可用 → 分章退化为**按静音间隙的机械分节**（``transcript_source="mechanical"``，
  标题是"分节 N"），思维导图退化为**章节结构图**（``mindmap_source="structural"``）
* OCR 不可用 → 帧图照出，``ocr_text=""``，标题标注"图片帧"（坑 11）
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Sequence

from worker.models.video import VideoArtifact, VideoSegment

from . import asr as asr_mod
from . import mindmap as mindmap_mod
from . import slides as slides_mod
from . import subtitle as subtitle_mod
from . import transcript as transcript_mod
from .audio import AudioTrack, extract_audio
from .errors import (
    AsrUnavailable,
    JobCancelled,
    MediaProbeError,
    TextModelUnavailable,
    VideoError,
)
from .ffmpeg_util import MediaInfo, probe_media
from .providers import AsrRequest, transcribe_with_chain
from .providers import provider_capabilities as asr_provider_capabilities

log = logging.getLogger(__name__)

#: 各阶段进度权重（和 = 1.0）
STAGE_WEIGHTS: dict[str, float] = {
    "audio": 0.10,
    "asr": 0.55,
    "subtitle": 0.05,
    "chapters": 0.12,
    "summary": 0.03,
    "mindmap": 0.05,
    "slides": 0.10,
}
#: 权重累加表（把每阶段的 0~1 映射到全局进度）
_STAGE_ORDER = ("audio", "asr", "subtitle", "chapters", "summary", "mindmap", "slides")
_STAGE_FLOOR: dict[str, float] = {}
_acc = 0.0
for _name in _STAGE_ORDER:
    _STAGE_FLOOR[_name] = _acc
    _acc += STAGE_WEIGHTS[_name]

#: 人工上传字幕的降级路径（坑 10）支持的格式
MANUAL_SUBTITLE_EXTS = (".srt", ".vtt")


@dataclass
class VideoOptions:
    """视频管线参数（REST 的 ``reparse`` 可以逐项覆盖）。"""

    asr_model: str = "tiny"
    asr_lang: str | None = None
    #: ★ 可插拔 ASR：策略与显式指定（`docs/PROVIDERS.md` §1/§2.4）
    asr_policy: str = "local-first"
    asr_provider: str | None = None  # 只跑这一家（失败即失败，不降级）
    #: 测试注入的 provider 注册表（None = 用全局注册表）
    asr_providers: dict | None = None
    #: 硬要求字级时间戳（不满足的 provider 会被**跳过**，而不是降级产出段级）
    require_word_timestamps: bool = False
    chunk_ms: int = asr_mod.DEFAULT_CHUNK_MS
    max_chapters: int = transcript_mod.MAX_CHAPTERS
    scene_threshold: float = slides_mod.SCENE_THRESHOLD
    max_slides: int = slides_mod.MAX_FRAMES
    min_frame_gap_ms: int = slides_mod.MIN_FRAME_GAP_MS
    frame_mode: str = "auto"
    fallback_interval_ms: int = slides_mod.FALLBACK_INTERVAL_MS
    enable_asr: bool = True
    enable_slides: bool = True
    enable_ocr: bool = True
    #: 是否允许用 LLM 做分章/摘要/思维导图；False 时直接走机械分节（离线跑批/测试用）
    enable_llm: bool = True
    word_timestamps: bool = True
    vad_filter: bool = True
    beam_size: int = 1
    resume: bool = True
    #: LLM 不可用时是否退化为机械分节（如实标注 source）
    allow_mechanical_fallback: bool = True

    def to_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass
class PipelineOutcome:
    """一次流水线的完整结果（artifact 可直接 ``upsert_video_artifact``）。"""

    artifact: VideoArtifact
    stages: dict[str, dict] = field(default_factory=dict)
    degraded: list[str] = field(default_factory=list)
    asr_available: bool = True
    asr_reason: str = ""
    #: ★ 实际用了哪家 ASR（`docs/PROVIDERS.md` R0 的降级上报字段）
    asr_provider: str = ""
    asr_degraded_from: str = ""
    llm_available: bool = False
    llm_reason: str = ""
    ocr_available: bool = False
    transcript_source: str = "none"
    mindmap_source: str = "none"
    media: dict = field(default_factory=dict)
    work_dir: str = ""
    elapsed_ms: int = 0

    def to_dict(self) -> dict:
        return {
            "artifact": self.artifact.to_dict(),
            "stages": self.stages,
            "degraded": self.degraded,
            "asr_available": self.asr_available,
            "asr_reason": self.asr_reason,
            "llm_available": self.llm_available,
            "llm_reason": self.llm_reason,
            "ocr_available": self.ocr_available,
            "transcript_source": self.transcript_source,
            "mindmap_source": self.mindmap_source,
            "media": self.media,
            "elapsed_ms": self.elapsed_ms,
        }

    @property
    def has_text(self) -> bool:
        """有没有真实文字产物（字幕/文稿）。**空产物不算有**。"""
        return bool(self.artifact.segments and self.artifact.subtitle_srt)


# ── 路径 ────────────────────────────────────────────────────────────────
def default_work_dir(doc_id: str, artifact_dir: str | Path | None = None) -> str:
    """``data/artifacts/<doc_id>``（与 config.Settings.artifact_dir 对齐）。"""
    base = Path(artifact_dir) if artifact_dir else Path(__file__).resolve().parents[2] / "data" / "artifacts"
    return str(base / doc_id)


def rel_path(path: str, root: str | Path | None = None) -> str:
    """转成**工程根目录相对**的 posix 路径（契约 §2.7 里写的是这种形式）。"""
    root_path = Path(root) if root else Path(__file__).resolve().parents[2]
    try:
        return Path(path).resolve().relative_to(root_path.resolve()).as_posix()
    except ValueError:
        return Path(path).as_posix()


# ── LLM 接入 ────────────────────────────────────────────────────────────
def resolve_text_model(
    settings: Any = None, *, caller: Callable[[str, dict], dict] | None = None
) -> tuple[Callable[[str, dict], dict] | None, str]:
    """取文本模型（``(prompt, schema) -> dict``）。

    ## v2 架构：**worker 不自己读凭据**

    provider 策略归 Node 层（``docs/ARCHITECTURE_V2.md`` §3/§4），
    所以这里**只认调用方显式传进来的** ``caller``（来自 job 参数的 ``llm`` 配置，
    由 :func:`worker.video.llm.make_text_model` 构造）。

    **不再**去 ``worker.pipeline.llm.LLMClient`` 兜配置 ——
    那条路是 v1 遗留（会从 ``.env`` 读凭据），v2 下属于越权，
    而且会让"没配 LLM"的 job 意外真的调起模型（测试里表现为 llm_available 假 True）。

    :return: ``(模型或 None, 不可用原因)``
    """
    if caller is not None:
        return caller, ""
    return None, (
        "未下发 LLM 配置（v2：worker 不自行读凭据，provider 策略归 Node 层）；"
        "请在 job 参数里给 llm={base_url,api_key,model} → 否则分章退化为机械分节"
    )


def llm_capability(settings: Any = None, *, llm: Any = None) -> dict:
    """LLM 能力快照（**不做网络探测**）。

    ``llm=None`` 时报"未下发"，UI 据此把分章/导图标注为降级路径。
    """
    if llm is not None:
        return {
            "available": True,
            "configured": True,
            "model": str(getattr(llm, "model", "") or ""),
            "mode": "openai_compatible",
            "reason": "已由 Node 下发 LLM 配置（分章/摘要/思维导图可用）",
        }
    return {
        "available": False,
        "configured": False,
        "model": "",
        "mode": "none",
        "reason": (
            "未下发 LLM 配置（worker 不读 .env；由 Node 层通过 job 参数下发）"
            "→ 分章退化为机械分节、思维导图退化为章节结构图"
        ),
    }


# ── 主流程 ──────────────────────────────────────────────────────────────
def run_pipeline(
    video_path: str,
    doc_id: str,
    *,
    work_dir: str | None = None,
    options: VideoOptions | None = None,
    llm: Callable[[str, dict], dict] | None = None,
    settings: Any = None,
    title: str = "",
    transcribe_fn: asr_mod.TranscribeFn | None = None,
    on_progress: Callable[[float, str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> PipelineOutcome:
    """跑完整条流水线。

    :param transcribe_fn: 注入式 ASR 后端（测试用；生产传 ``None`` 走 faster-whisper）
    :param llm: ``(prompt, json_schema) -> dict``；``None`` 时按 :func:`resolve_text_model` 找
    :raises MediaProbeError: 文件不是媒体 / 没有视频流
    :raises JobCancelled: 取消（产物与断点都保留，可直接 ``resume=True`` 续跑）
    """
    opts = options or VideoOptions()
    started = time.time()
    work = work_dir or default_work_dir(doc_id)
    frames_dir = os.path.join(work, "frames")
    asr_dir = os.path.join(work, "asr")
    os.makedirs(work, exist_ok=True)

    outcome = PipelineOutcome(
        artifact=VideoArtifact(
            doc_id=doc_id,
            asr_model="",
            asr_lang="",
            mindmap_format="",
            mindmap_content="",
        ),
        work_dir=work,
    )
    stages: dict[str, dict] = {}
    outcome.stages = stages

    def stage_begin(name: str) -> float:
        stages[name] = {"status": "running", "elapsed_ms": 0}
        return time.time()

    def stage_end(name: str, t0: float, **extra: Any) -> None:
        stages[name].update(
            {"status": "done", "elapsed_ms": int((time.time() - t0) * 1000), **extra}
        )

    def stage_skip(name: str, note: str, **extra: Any) -> None:
        stages[name] = {"status": "skipped", "note": note, "elapsed_ms": 0, **extra}

    def stage_fail(name: str, t0: float, note: str, **extra: Any) -> None:
        stages[name] = {
            "status": "failed",
            "note": note,
            "elapsed_ms": int((time.time() - t0) * 1000),
            **extra,
        }

    def progress(name: str, frac: float, detail: str) -> None:
        if on_progress is None:
            return
        try:
            on_progress(
                min(1.0, _STAGE_FLOOR.get(name, 0.0) + STAGE_WEIGHTS.get(name, 0.0) * max(0.0, min(1.0, frac))),
                detail,
            )
        except Exception:  # noqa: BLE001 - 进度回调是旁观者
            pass

    def cancelled() -> bool:
        return bool(should_cancel is not None and should_cancel())

    # ── 探测 ──
    info: MediaInfo = probe_media(video_path)
    outcome.media = info.to_dict()
    _safe_progress(on_progress, 0.0, "探测媒体")
    if not info.has_video:
        # 纯音频（网课录音）也支持：ASR/字幕/文稿/导图照跑，只是没有帧可抽。
        outcome.degraded.append("源文件没有视频流（纯音频）→ 不产出幻灯片帧")
        opts.enable_slides = False

    audio_path = os.path.join(work, "audio.wav")
    audio: AudioTrack | None = None

    # ── S1 抽音频 ──
    if not info.has_audio:
        stage_skip("audio", "源文件没有音频流 → 无法转写；仍产出播放器 + 幻灯片帧")
        outcome.degraded.append("源视频没有音轨：不产出字幕与文稿")
    else:
        t0 = stage_begin("audio")
        try:
            audio = extract_audio(
                video_path,
                audio_path,
                duration_ms=info.duration_ms,
                on_progress=lambda f, s: progress("audio", f, s),
                should_cancel=should_cancel,
            )
            stage_end("audio", t0, sample_rate=audio.sample_rate, duration_ms=audio.duration_ms)
        except JobCancelled:
            stage_fail("audio", t0, "被取消")
            raise
        except VideoError as exc:
            stage_fail("audio", t0, exc.detail)
            outcome.degraded.append(f"抽音频失败：{exc.message}")
            log.warning("抽音频失败：%s", exc.detail)

    # 规范时长：取"视频时长"与"音频时长"的较大值，保证分章覆盖全片不越界
    duration_ms = max(int(info.duration_ms or 0), int(audio.duration_ms if audio else 0))

    # ── S2 ASR ──
    segments: list[VideoSegment] = []
    if not info.has_audio or audio is None:
        stage_skip("asr", "没有音轨")
        outcome.asr_available = False
        outcome.asr_reason = "源视频没有音轨"
    elif not opts.enable_asr:
        stage_skip("asr", "本次任务关闭了 ASR（enable_asr=False）")
        outcome.asr_available = False
        outcome.asr_reason = "任务参数关闭了 ASR"
    else:
        t0 = stage_begin("asr")
        # 测试注入的引擎假实现也走**同一条 provider 链**（configured→health→capability→transcribe），
        # 否则降级/能力检查这些逻辑在测试里根本没被执行到（"两条路"是 bug 温床）。
        if transcribe_fn is not None:
            from .providers.inline import InlineTranscribeProvider

            registry_override: dict | None = {
                "local-fw": InlineTranscribeProvider(transcribe_fn, model=opts.asr_model)
            }
            policy = "local-first"
            explicit = "local-fw"
        else:
            registry_override = opts.asr_providers
            policy = opts.asr_policy
            explicit = opts.asr_provider
        try:
            resp = transcribe_with_chain(
                AsrRequest(
                    audio_path=audio.path,
                    duration_ms=duration_ms,
                    language=opts.asr_lang,
                    require_word_timestamps=opts.require_word_timestamps,
                    prefer_word_timestamps=opts.word_timestamps,
                    work_dir=asr_dir,
                    chunk_ms=opts.chunk_ms,
                    resume=opts.resume,
                    model=opts.asr_model,
                    source_path=video_path,
                    should_cancel=should_cancel,
                    on_progress=lambda f, s: progress("asr", f, s),
                ),
                policy=policy,
                explicit=explicit,
                providers=registry_override,
            )
            segments = [s.to_video_segment() for s in resp.segments]
            outcome.artifact.asr_model = resp.model or opts.asr_model
            outcome.artifact.asr_lang = resp.language or (opts.asr_lang or "")
            outcome.asr_available = True
            outcome.asr_reason = ""
            outcome.asr_provider = resp.used_provider
            outcome.asr_degraded_from = resp.degraded_from
            stage_end(
                "asr",
                t0,
                provider=resp.used_provider,
                degraded_from=resp.degraded_from,
                degraded_reason=resp.reason,
                model=resp.model,
                lang=resp.language,
                segments=len(resp.segments),
                chunks=resp.chunks_total,
                resumed_chunks=resp.chunks_resumed,
                compute_type=resp.compute_type,
                attempts=[a.to_dict() for a in resp.attempts],
                elapsed_ms=resp.elapsed_ms,
            )
        except JobCancelled:
            stage_fail("asr", t0, "被取消（断点已保存，可 --resume 续跑）")
            raise
        except AsrUnavailable as exc:
            # ★ 坑 10：如实降级，绝不产出空字幕。
            # reason 里**必须同时给"结论"和"原因"**：只给 detail 会让 UI 看不到
            # 到底哪一步失败（如"没有识别出任何语音"这句话在 message 里）。
            reason = exc.message if exc.detail == exc.message else f"{exc.message}｜{exc.detail}"
            stage_fail("asr", t0, exc.detail, code=exc.code)
            outcome.asr_available = False
            outcome.asr_reason = reason
            outcome.degraded.append(f"ASR 不可用：{exc.message}")
            log.warning("ASR 不可用：%s", exc.detail)

    # ── S3 字幕 ──
    outcome.artifact.segments = list(segments)  # ★ 漏过这一步：产物里看不到段落
    if segments:
        t0 = stage_begin("subtitle")
        srt = subtitle_mod.segments_to_srt(segments, duration_ms=duration_ms)
        vtt = subtitle_mod.segments_to_vtt(segments, duration_ms=duration_ms)
        cues = subtitle_mod.build_cues(segments, duration_ms=duration_ms)
        subtitle_mod.validate_timeline(cues, duration_ms=duration_ms)  # 违反当场炸
        srt_path = os.path.join(work, "subtitle.srt")
        vtt_path = os.path.join(work, "subtitle.vtt")
        _write_text(srt_path, srt)
        _write_text(vtt_path, vtt)
        # ⚠️ 契约 §2.7 的例子写的是**路径**（"data/artifacts/vid_0001/subtitle.srt"），
        # 但 T1 的 model 字段是 TEXT、main.py 的 `/video/subtitle` 直接把该字段当
        # **响应体**返回（Response(content=art.subtitle_srt)）。
        # 两者冲突 → 采取**两边都满足**的做法：字段里放**内容**（UI/下载立即可用），
        # 文件也照样落盘（可追溯、可人工检查），路径放进 stages/meta。
        outcome.artifact.subtitle_srt = srt
        outcome.artifact.subtitle_vtt = vtt
        stage_end(
            "subtitle",
            t0,
            cues=len(cues),
            srt_bytes=len(srt),
            vtt_bytes=len(vtt),
            srt_path=rel_path(srt_path),
            vtt_path=rel_path(vtt_path),
        )
    else:
        stage_skip("subtitle", "没有 ASR 段落 → 不产出字幕文件（不生成空 SRT 冒充成功）")

    # ── S4/S5 分章 + 摘要 ──
    text_model = llm
    if not opts.enable_llm:
        text_model, llm_reason = None, "本次任务关闭了 LLM（enable_llm=False）"
    elif text_model is None:
        text_model, llm_reason = resolve_text_model(settings)
    else:
        llm_reason = ""
    outcome.llm_available = text_model is not None
    outcome.llm_reason = llm_reason
    chapters_path = os.path.join(work, "chapters.json")

    if segments:
        chapters: list[transcript_mod.TranscriptChapter] = []
        summary = ""
        source = "none"
        cached = opts.resume and _read_json(chapters_path)
        if cached and cached.get("chapters"):
            chapters = [transcript_mod.TranscriptChapter.from_dict(d) for d in cached["chapters"]]
            summary = cached.get("summary", "")
            source = cached.get("source", "llm")
            stage_skip("chapters", "复用 chapters.json（不重复调 LLM）", source=source, chapters=len(chapters))
            stage_skip("summary", "复用 chapters.json")
            try:
                transcript_mod.validate_coverage(chapters, duration_ms)
            except Exception as exc:  # noqa: BLE001 - 缓存与当前片长不符 → 重算
                log.warning("缓存分章与当前片长不符（%s），重算", exc)
                cached = None
        if not cached:
            t0 = stage_begin("chapters")
            stages["summary"] = {"status": "running", "elapsed_ms": 0}
            try:
                tres = transcript_mod.analyze_transcript(
                    text_model,
                    segments,
                    duration_ms=duration_ms,
                    max_chapters=opts.max_chapters,
                    video_title=title,
                    allow_mechanical_fallback=opts.allow_mechanical_fallback,
                    on_progress=lambda f, s: progress("chapters", f, s),
                )
                chapters, summary, source = tres.chapters, tres.summary, tres.source
                if tres.source != "llm":
                    outcome.degraded.append(f"文稿分章降级：{tres.note or tres.source}")
                stage_end("chapters", t0, chapters=len(chapters), source=source, note=tres.note)
                stage_end("summary", t0, chars=len(summary))
            except TextModelUnavailable as exc:
                stage_fail("chapters", t0, exc.detail)
                stage_fail("summary", t0, exc.detail)
                outcome.degraded.append(f"分章不可用：{exc.message}")
                source = "none"
        if chapters:
            outcome.artifact.transcript = chapters
        outcome.transcript_source = source
        _write_json(
            chapters_path,
            {
                "version": 1,
                "source": source,
                "summary": summary,
                "chapters": [c.to_dict() for c in chapters],
            },
        )
    else:
        stage_skip("chapters", "没有 ASR 段落")
        stage_skip("summary", "没有 ASR 段落")
        outcome.transcript_source = "none"

    # ── S6 思维导图 ──
    mindmap_path = os.path.join(work, "mindmap.md")
    if outcome.artifact.transcript:
        t0 = stage_begin("mindmap")
        content = ""
        mm_source = "none"
        if opts.resume and os.path.isfile(mindmap_path):
            cached_mm = _read_text(mindmap_path)
            if cached_mm.strip():
                content, mm_source = cached_mm, "cached"
                stages["mindmap"]["note"] = "复用 mindmap.md"
        if not content and text_model is not None:
            try:
                payload = text_model(
                    mindmap_mod.build_mindmap_prompt(
                        outcome.artifact.transcript, summary="", video_title=title
                    ),
                    mindmap_mod.MINDMAP_SCHEMA,
                )
                raw = payload.get("markdown") if isinstance(payload, dict) else None
                content = mindmap_mod.normalize_markmap(str(raw or ""))
                mm_source = "llm" if content else "none"
            except Exception as exc:  # noqa: BLE001 - LLM 挂了不该毁掉整条流水线
                log.warning("思维导图 LLM 失败，退化为结构图：%s", exc)
                content = ""
        if not content:
            # 如实降级：只搬章节标题/摘要，不编造知识点
            content = mindmap_mod.from_chapters(
                outcome.artifact.transcript, root=title or "课程思维导图"
            )
            mm_source = "structural" if content else "none"
            if mm_source == "structural":
                outcome.degraded.append("思维导图降级为「章节结构图」（未调用 LLM，无知识点层级）")
        if content:
            outcome.artifact.mindmap_format = mindmap_mod.MINDMAP_FORMAT
            outcome.artifact.mindmap_content = content
            _write_text(mindmap_path, content)
        outcome.mindmap_source = mm_source
        stage_end("mindmap", t0, source=mm_source, chars=len(content))
    else:
        stage_skip("mindmap", "没有文稿（ASR 不可用）→ 不产出思维导图")
        outcome.mindmap_source = "none"

    # ── S7 幻灯片帧 ──
    slides_path = os.path.join(work, "slides.json")
    if not opts.enable_slides:
        stage_skip("slides", "本次任务关闭了抽帧（enable_slides=False）")
    else:
        t0 = stage_begin("slides")
        frames: list[slides_mod.SlideFrame] = []
        cached_slides = _read_json(slides_path) if opts.resume else None
        if cached_slides and cached_slides.get("slides"):
            frames = [slides_mod.SlideFrame(**d) for d in cached_slides["slides"]]
            frames = [f for f in frames if os.path.isfile(f.image)]
            if frames:
                stages["slides"]["note"] = "复用 slides.json"
        if not frames:
            try:
                frames = slides_mod.detect_frames(
                    video_path,
                    frames_dir,
                    threshold=opts.scene_threshold,
                    max_frames=opts.max_slides,
                    min_gap_ms=opts.min_frame_gap_ms,
                    duration_ms=duration_ms,
                    mode=opts.frame_mode,
                    fallback_interval_ms=opts.fallback_interval_ms,
                    on_progress=lambda f, s: progress("slides", f, s),
                    should_cancel=should_cancel,
                )
            except JobCancelled:
                stage_fail("slides", t0, "被取消")
                raise
            except VideoError as exc:
                stage_fail("slides", t0, exc.detail)
                outcome.degraded.append(f"抽帧失败：{exc.message}")
                log.warning("抽帧失败：%s", exc.detail)
        ocr_cap = slides_mod.ocr_availability()
        outcome.ocr_available = bool(ocr_cap["available"])
        if frames and opts.enable_ocr and ocr_cap["available"]:
            hits = slides_mod.attach_ocr(frames)
            stages["slides"]["ocr_hits"] = hits
        for frame in frames:
            frame.image = rel_path(frame.image)
        outcome.artifact.slides = [f.to_video_slide() for f in frames]
        if frames:
            _write_json(
                slides_path,
                {
                    "version": 1,
                    "mode": frames[0].mode,
                    "ocr": outcome.ocr_available,
                    "slides": [f.to_dict() for f in frames],
                },
            )
            if frames[0].mode == "interval":
                outcome.degraded.append("未检测到画面切换，幻灯片改为等间隔抽帧（mode=interval）")
        else:
            outcome.degraded.append("没有抽出任何幻灯片帧")
        stage_end(
            "slides",
            t0,
            count=len(frames),
            ocr=outcome.ocr_available,
            mode=(frames[0].mode if frames else "none"),
        )

    if not outcome.asr_available:
        outcome.degraded.append(
            "ASR 不可用：本次**没有**字幕/文稿产物（不产出空文件充数）；"
            "播放器 + 时间轴 + 幻灯片帧仍可用，也可手动上传 SRT/VTT"
        )

    outcome.artifact.duration_ms = duration_ms
    outcome.elapsed_ms = int((time.time() - started) * 1000)
    _safe_progress(on_progress, 1.0, "完成")
    _write_json(
        os.path.join(work, "state.json"),
        {
            "version": 1,
            "doc_id": doc_id,
            "video": video_path,
            "duration_ms": duration_ms,
            "stages": stages,
            "degraded": outcome.degraded,
            "asr_available": outcome.asr_available,
            "transcript_source": outcome.transcript_source,
            "mindmap_source": outcome.mindmap_source,
            "ocr_available": outcome.ocr_available,
            "elapsed_ms": outcome.elapsed_ms,
        },
    )
    return outcome


# ── 手动上传字幕（坑 10 的降级路径）────────────────────────────────────
def apply_manual_subtitles(
    text: str,
    *,
    doc_id: str,
    duration_ms: int,
    work_dir: str,
    title: str = "",
    options: VideoOptions | None = None,
    llm: Callable[[str, dict], dict] | None = None,
    settings: Any = None,
    on_progress: Callable[[float, str], None] | None = None,
) -> PipelineOutcome:
    """ASR 不可用时，用**人工上传的 SRT/VTT** 走同一套后处理。

    解析出的字幕条 → segments → SRT/VTT（规范化）+ 分章/摘要/思维导图。
    ``asr_available`` 仍是 ``False``，但 ``manual_subtitle=True`` 会写进 stages，
    UI 能明确区分"机器转写"与"人工上传"。
    """
    opts = options or VideoOptions()
    started = time.time()
    os.makedirs(work_dir, exist_ok=True)
    cues = subtitle_mod.detect_and_parse(text)
    subtitle_mod.validate_timeline(cues, duration_ms=duration_ms)
    segments = [VideoSegment(i=i, start=c.start, end=c.end, text=c.text.replace("\n", ""), confidence=1.0)
                for i, c in enumerate(cues)]
    artifact = VideoArtifact(doc_id=doc_id, duration_ms=duration_ms, asr_model="manual", asr_lang="")
    srt_path = os.path.join(work_dir, "subtitle.srt")
    vtt_path = os.path.join(work_dir, "subtitle.vtt")
    _write_text(srt_path, subtitle_mod.to_srt(cues))
    _write_text(vtt_path, subtitle_mod.to_vtt(cues))
    artifact.subtitle_srt = subtitle_mod.to_srt(cues)  # 内容（同 run_pipeline 的约定）
    artifact.subtitle_vtt = subtitle_mod.to_vtt(cues)
    artifact.segments = segments

    text_model = llm
    llm_reason = ""
    if text_model is None:
        text_model, llm_reason = resolve_text_model(settings)
    tres = transcript_mod.analyze_transcript(
        text_model,
        segments,
        duration_ms=duration_ms,
        max_chapters=opts.max_chapters,
        video_title=title,
        allow_mechanical_fallback=True,
        on_progress=on_progress,
    )
    artifact.transcript = tres.chapters
    content = ""
    mm_source = "none"
    if text_model is not None and tres.chapters:
        try:
            payload = text_model(
                mindmap_mod.build_mindmap_prompt(tres.chapters, summary=tres.summary, video_title=title),
                mindmap_mod.MINDMAP_SCHEMA,
            )
            content = mindmap_mod.normalize_markmap(str((payload or {}).get("markdown") or ""))
            mm_source = "llm" if content else "none"
        except Exception as exc:  # noqa: BLE001
            log.warning("思维导图 LLM 失败：%s", exc)
    if not content and tres.chapters:
        content = mindmap_mod.from_chapters(tres.chapters, root=title or "课程思维导图")
        mm_source = "structural" if content else "none"
    artifact.mindmap_format = mindmap_mod.MINDMAP_FORMAT if content else ""
    artifact.mindmap_content = content
    if content:
        _write_text(os.path.join(work_dir, "mindmap.md"), content)

    return PipelineOutcome(
        artifact=artifact,
        stages={
            "manual_subtitles": {"status": "done", "cues": len(cues), "elapsed_ms": 0},
            "chapters": {"status": "done", "chapters": len(tres.chapters), "source": tres.source},
        },
        degraded=["ASR 未参与：字幕来自人工上传（asr.available=false）"],
        asr_available=False,
        asr_reason="字幕为人工上传，非 ASR 产物",
        llm_available=text_model is not None,
        llm_reason=llm_reason,
        transcript_source=tres.source,
        mindmap_source=mm_source,
        work_dir=work_dir,
        elapsed_ms=int((time.time() - started) * 1000),
    )


# ── 小工具 ──────────────────────────────────────────────────────────────
def _write_text(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def _read_text(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def _write_json(path: str, data: dict) -> None:
    _write_text(path, json.dumps(data, ensure_ascii=False, indent=2))


def _read_json(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _safe_progress(
    cb: Callable[[float, str], None] | None, frac: float, stage: str
) -> None:
    if cb is None:
        return
    try:
        cb(max(0.0, min(1.0, frac)), stage)
    except Exception:  # noqa: BLE001
        pass


def capabilities(settings: Any = None) -> dict:
    """视频相关的 ``/capabilities`` 片段（诚实：不可用就是 False + 原因）。"""
    asr_cap = asr_mod.asr_capability()
    ocr_cap = slides_mod.ocr_availability()
    llm_cap = llm_capability(settings)
    try:
        from .ffmpeg_util import find_ffmpeg

        ffmpeg_path = find_ffmpeg()
        ffmpeg_ok = True
    except Exception as exc:  # noqa: BLE001
        ffmpeg_path, ffmpeg_ok = str(exc), False
    return {
        "video": {
            "ffmpeg": {"available": ffmpeg_ok, "path": ffmpeg_path, "ffprobe": False},
            "asr": asr_cap,
            "ocr": ocr_cap,
            "text_model": llm_cap,
            "slides": {
                "available": ffmpeg_ok,
                "kind": slides_mod.SLIDE_KIND_IMAGE,
                "note": "视频内 PPT 抽出的是**图片帧**，不是可编辑 PPT",
            },
        }
    }


__all__ = [
    "VideoOptions",
    "PipelineOutcome",
    "STAGE_WEIGHTS",
    "MANUAL_SUBTITLE_EXTS",
    "run_pipeline",
    "apply_manual_subtitles",
    "default_work_dir",
    "rel_path",
    "resolve_text_model",
    "llm_capability",
    "capabilities",
]
