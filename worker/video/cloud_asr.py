# -*- coding: utf-8 -*-
"""云端 ASR 的**Python 侧**：``plan`` / ``convert`` —— OpenRouter 的 HTTP 调用**在 Node**。

## 为什么是 plan/convert（不是新发明，是照抄本仓库的自家范式）

=================================  ==============================  ==============================
既有先例（现存代码）                   Python 侧                        Node 侧
=================================  ==============================  ==============================
``extract.plan`` / ``extract.convert``  只产提示词 + 裸 schema          自己调 LLM
``rollup.plan`` / ``rollup.convert``    只产提示词 + 裸 schema          自己调 LLM
**``video.asr.plan`` / ``video.asr.convert``**  **抽音频 + 切块 + 断点**  **逐块调 OpenRouter**
=================================  ==============================  ==============================

⟹ **Node 依旧是编排者，Python 依旧是计算器**（AGENTS §0）。ASR 与 OCR 是**同一个形状**。

## 三条铁律（Lead 硬要求）

1. ★★ **本模块绝不调用本地 faster-whisper**。本文件里**没有** ``import faster_whisper``，
   也不调 :func:`worker.video.asr.transcribe_audio`。云端拿不到结果 → **如实不可用 + 可读 reason**，
   **绝不静默降级回本地**。守卫测试把 ``load_model_with_fallback`` 换成"一调用就炸"，
   plan/convert **仍必须跑通** —— 这就是"不碰本地"的硬证据。
2. ★★ **OpenRouter 调用只许一处**：``apps/server/src/providers/openrouter_audio.ts::createOpenRouterAsr``。
   本模块**不发任何 HTTP**（没有 ``import httpx``/``requests``/``urllib``）。
3. ★ **断点/分块/拼接沿用** :mod:`worker.video.asr` 那套（``plan_chunks`` / ``split_audio`` /
   ``AsrCheckpoint`` / ``stitch_segments``）—— 那些是踩出来的，不重写。

## 诚实口径（不许美化）

* **时间戳粒度 = 块级**（``chunk_ms`` 的边界），**不是**词级、也不是句级。
  voxtral 的响应里**没有**时间戳 → 块内**不做伪细分**（编造时间比没有更坏，坑 10/21）。
  ⟹ ``wordTimestamps: false`` 必须如实上报，``timestamps: "chunk"`` 也一并写明。
* **计费**来自**实测**（1 次真调用的 ``usage`` 原始字段），见 :data:`MEASURED_COST`；
  没实测过就 ``measured: false`` + 原因，**不许拿官方价目表冒充实测**。
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

from ..models.video import VideoSegment
from . import asr as asr_mod
from .audio import extract_audio
from .errors import AsrUnavailable, VideoError

#: 云端分块的默认长度。
#:
#: 口径：**块 = 一次 API 调用 = 一条字幕**。所以它同时决定
#: ① 字幕粒度 ② 调用次数（计费次数） ③ 单次请求的音频体积（base64 后 ≈ 每秒 32KB×1.33）。
#: 30s：字幕不至于一条 5 分钟；13 分钟视频 = 26 次调用；单请求 ≈ 1.3MB base64，稳妥。
DEFAULT_CLOUD_CHUNK_MS = 30_000

#: 云端 ASR 的“模型名”占位（真实模型名由 Node 下发/回填，Python 不猜）
CLOUD_ASR_SOURCE = "openrouter"


# ═══════════════════════════════════════════════════════════════════════
# 计费 / 速度：**实测**口径
# ═══════════════════════════════════════════════════════════════════════
@dataclass(frozen=True)
class CloudCostModel:
    """一次真调用量出来的计费与速度（**不是价目表抄来的**）。

    ## 为什么字段长这样（实测发现的计费口径）

    2026-10-16 用 `mistralai/voxtral-small-24b-2507` 转 30.0s 音频，OpenRouter 原始 ``usage``：

    .. code-block:: json

        {"prompt_tokens": 68, "completion_tokens": 185, "total_tokens": 253,
         "cost": 0.0030593,
         "prompt_tokens_details": {"audio_tokens": 30},
         "cost_details": {"upstream_inference_prompt_cost": 0.0030038,
                          "upstream_inference_completions_cost": 0.0000555}}

    ``/api/v1/models`` 给的单价是 ``{"prompt":"0.0000001","completion":"0.0000003","audio":"0.0001"}``
    （**每 token**，不是每百万）。对起来：

    * ``audio_tokens = 30``（30 秒音频）⟹ **1 audio token = 1 秒音频**
    * 音频成本 = 30 × ``0.0001`` = **$0.003**（占总额 98%）
    * 输出成本 = 185 × ``0.0000003`` = $0.0000555 ✓ 与 cost_details 完全对上
    * 合计 $0.0030593 ✓ 与 ``usage.cost`` 完全对上

    ★★ **结论（与原先的假设差 60 倍）**：ASR 的账单大头是**音频时长**，
    不是文字 token。所以 ``$0.1/M in`` 这种说法**会严重低估**：
    真实是 **≈$0.0061/分钟音频 ≈ $0.367/小时视频**。
    本模型按**实测**口径重建这张账单，并有一条单测拿 30s 的实测值自校验。

    :param audio_tokens_per_second: 音频 → audio token（实测 1.0 秒/个）
    :param audio_usd_per_audio_token: 每个 audio token 的单价（实测 0.0001）
    :param text_prompt_tokens_per_audio_second: 除音频外的提示词 token（实测 ~1.27/s）
    :param completion_tokens_per_audio_second: 输出 token 密度（实测 185/30 ≈ 6.17/s，与语速有关）
    :param audio_seconds_per_wall_second: **实测**吞吐（实测 6.28× 实时）
    :param measured_at: 实测时间；``""`` = **没实测过**
    :param source: 实测出处（哪条命令 / 哪个 raw usage）
    """

    model: str
    audio_tokens_per_second: float = 0.0
    audio_usd_per_audio_token: float = 0.0
    text_prompt_tokens_per_audio_second: float = 0.0
    text_prompt_usd_per_million: float = 0.0
    completion_tokens_per_audio_second: float = 0.0
    completion_usd_per_million: float = 0.0
    audio_seconds_per_wall_second: float = 0.0
    measured_at: str = ""
    source: str = ""

    @property
    def measured(self) -> bool:
        """是否**真**实测过（没实测就绝不给"看起来像真的"的数字）。"""
        return bool(
            self.measured_at
            and self.audio_tokens_per_second > 0
            and self.audio_usd_per_audio_token > 0
        )

    def estimate(self, duration_ms: int, *, chunk_ms: int = DEFAULT_CLOUD_CHUNK_MS) -> dict[str, Any]:
        """按**实测**换算率估算一段视频的 token / 费用 / 墙钟。

        ⚠️ 没实测过 → ``measured: false`` + ``reason``，数值一律不给
        （**宁可不给数字，也不给猜的数字** —— 用户要拿它决定"投多少钱"）。
        """
        chunks = max(1, len(asr_mod.plan_chunks(int(duration_ms), int(chunk_ms))))
        audio_s = max(0.0, duration_ms / 1000.0)
        if not self.measured:
            return {
                "model": self.model or "",
                "measured": False,
                "reason": "未实测：需要 1 次真调用读 usage（价目表不等于实测，不拿来冒充）",
                "calls": chunks,
                "audioSeconds": round(audio_s, 1),
            }
        audio_tokens = self.audio_tokens_per_second * audio_s
        audio_usd = audio_tokens * self.audio_usd_per_audio_token
        text_tokens = self.text_prompt_tokens_per_audio_second * audio_s
        text_usd = text_tokens / 1_000_000 * self.text_prompt_usd_per_million
        compl_tokens = self.completion_tokens_per_audio_second * audio_s
        compl_usd = compl_tokens / 1_000_000 * self.completion_usd_per_million
        total = audio_usd + text_usd + compl_usd
        return {
            "model": self.model,
            "measured": True,
            "source": self.source,
            "measuredAt": self.measured_at,
            "calls": chunks,
            "audioSeconds": round(audio_s, 1),
            "audioTokens": int(round(audio_tokens)),
            "completionTokens": int(round(compl_tokens)),
            # ⚠️ 这里必须留 8 位小数：单块成本是**亚美分**级（实测 30s ≈ $0.00306，
            #    输出部分只有 $0.0000555）。第一版 round(...,6) 把 0.0000555 抹成 0.000055，
            #    与账单对不上（自校验单测当场抓到）。
            "audioUsd": round(audio_usd, 8),
            "textUsd": round(text_usd, 8),
            "completionUsd": round(compl_usd, 8),
            "usd": round(total, 8),
            "usdPerAudioMinute": round(total / max(audio_s / 60.0, 1e-9), 6),
            "usdPerAudioHour": round(total / max(audio_s / 3600.0, 1e-9), 4),
            "wallSecondsEstimate": round(audio_s / self.audio_seconds_per_wall_second, 1)
            if self.audio_seconds_per_wall_second > 0
            else None,
            "note": "按**实测** audio token 换算率与单价估算（音频时长是账单大头）；实际以 OpenRouter 账单为准",
        }


#: ★ **实测**结果：1 次真调用（2026-10-16，30.0s 音频，`usage.cost` 原始字段见类文档）。
#:
#: 30s 音频 → ``usage.cost = 0.0030593`` ⟹ **$0.00612/分钟音频 ≈ $0.367/小时视频**。
#: 同一份 ``usage`` 反推出各换算率（:meth:`CloudCostModel.estimate` 用它们重建这张账单，
#: 单测 ``test_measured_model_reproduces_real_invoice`` 拿实测值自校验）。
MEASURED_COST = CloudCostModel(
    model="mistralai/voxtral-small-24b-2507",
    audio_tokens_per_second=1.0,             # 30 个 audio token / 30.0s
    audio_usd_per_audio_token=0.0001,        # /models 的 "audio":"0.0001"（每 token）
    text_prompt_tokens_per_audio_second=38.0 / 30.0,   # 68 总 prompt − 30 audio
    text_prompt_usd_per_million=0.1,         # "prompt":"0.0000001" × 1e6
    completion_tokens_per_audio_second=185.0 / 30.0,   # 实测（与语速有关，偏保守）
    completion_usd_per_million=0.3,          # "completion":"0.0000003" × 1e6
    audio_seconds_per_wall_second=30.0 / 4.775,        # 实测墙钟 4.775s
    measured_at="2026-10-16",
    source="1 次真调用（openrouter_audio.ts::createOpenRouterAsr，30s 音频）：usage.cost=0.0030593",
)


def cost_estimate(
    duration_ms: int, *, chunk_ms: int = DEFAULT_CLOUD_CHUNK_MS, cost: CloudCostModel | None = None
) -> dict[str, Any]:
    """给 Node/UI 用的成本估算（**只报实测口径**；没实测就如实说没有）。"""
    model = cost or MEASURED_COST
    out = model.estimate(int(duration_ms), chunk_ms=chunk_ms)
    out["timestamps"] = "chunk"
    out["chunkMs"] = int(chunk_ms)
    return out


# ═══════════════════════════════════════════════════════════════════════
# plan：抽音频 + 切块 + 断点
# ═══════════════════════════════════════════════════════════════════════
def plan(
    *,
    video_path: str,
    work_dir: str,
    chunk_ms: int = DEFAULT_CLOUD_CHUNK_MS,
    language: str | None = None,
    resume: bool = True,
    force_audio: bool = False,
    model_hint: str = "",
    on_progress: Callable[[float, str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """**第一阶段**：产媒体（音频块）→ 交给 Node 去调 OpenRouter。

    :returns: ``{audioPath, durationMs, fingerprint, chunkMs, chunks:[{index,path,startMs,endMs,done}],
                 doneChunks, segmentsSoFar, meta:{stage, asrSource, ...}, estimate:{...}}``

    ``meta.stage == "awaiting_cloud_asr"`` 表示**还没转写**（Node 该去逐块调 API）；
    这不是错误，也**不会**回退本地 —— 与 PDF OCR 的 ``rendered_awaiting_cloud_ocr`` 同形。

    ⚠️ 本函数**只做媒体**：不加载模型、不发 HTTP。
    """
    if not os.path.isfile(video_path):
        raise _fail("E_NOTFOUND", f"视频文件不存在：{video_path}")

    audio_dir = os.path.join(work_dir, "asr")
    os.makedirs(audio_dir, exist_ok=True)
    audio_path = os.path.join(audio_dir, "audio.wav")
    chunks_dir = os.path.join(audio_dir, "chunks")
    ckpt_path = os.path.join(audio_dir, "asr.ckpt.json")

    _safe(on_progress, 0.02, "抽音频")
    track = extract_audio(video_path, audio_path, duration_ms=None, force=force_audio)
    duration_ms = int(track.duration_ms or 0)
    _safe(on_progress, 0.10, "切分音频")

    chunks = asr_mod.plan_chunks(duration_ms, int(chunk_ms))

    def split_progress(frac: float, stage: str) -> None:
        _safe(on_progress, 0.10 + 0.10 * max(0.0, min(1.0, frac)), stage or "切分音频")

    chunks = asr_mod.split_audio(
        audio_path, chunks, chunks_dir, on_progress=split_progress, should_cancel=should_cancel
    )

    # 指纹：音频 + **云端模型 + 分块粒度**（换模型/换切法 → 断点作废，
    # 避免把两个模型的段、或两种切法的段拼成怪物）。
    # ⚠️ 第一版漏了 chunk_ms：改成 3s 粒度后仍会复用 2s 粒度的断点 → 段与块对不上（实测抓到）。
    model_for_fp = f"{model_hint or 'cloud:unknown'}#chunk={int(chunk_ms)}"
    fingerprint = asr_mod.audio_fingerprint(audio_path, model_for_fp, duration_ms)
    ckpt = asr_mod.AsrCheckpoint.load(ckpt_path, fingerprint) if resume else None
    done = sorted(set(int(x) for x in (ckpt.done_chunks if ckpt else [])))
    done_set = set(done)

    _safe(on_progress, 0.20, "等待云端转写")
    return {
        "audioPath": audio_path,
        "durationMs": duration_ms,
        "fingerprint": fingerprint,
        "chunkMs": int(chunk_ms),
        "language": language or "",
        "chunks": [
            {
                "index": c.index,
                "path": c.path,
                "startMs": int(c.start_ms),
                "endMs": int(c.end_ms),
                "durationMs": int(c.duration_ms),
                "done": c.index in done_set,
            }
            for c in chunks
        ],
        "doneChunks": done,
        "chunksTotal": len(chunks),
        # 断点里已完成的段（Node 只需补没做完的块）
        "segmentsSoFar": [dict(s) for s in (ckpt.segments if ckpt else [])],
        "requires": {
            # ★ 显式告诉 Node：我要的是**每块一条文本**，且我**没有**时间戳可给
            "perChunkText": True,
            "wordTimestamps": False,
            "timestamps": "chunk",
            "chunkMs": int(chunk_ms),
        },
        "meta": {
            "stage": "awaiting_cloud_asr",
            "asrSource": CLOUD_ASR_SOURCE,
            "model": model_hint or "",
            "note": "媒体已就绪，等待 Node 调 OpenRouter；本进程**不会**回退本地 faster-whisper",
        },
        "estimate": cost_estimate(duration_ms, chunk_ms=int(chunk_ms)),
        "elapsedMs": 0,
    }


# ═══════════════════════════════════════════════════════════════════════
# convert：收结果 → 拼接 → 与本地路径**同形**的产物
# ═══════════════════════════════════════════════════════════════════════
@dataclass
class CloudTranscription:
    """Node 回传的**一块**转写结果（OpenRouter 的响应已被 Node 归一化成这个形状）。"""

    index: int
    text: str
    model: str = ""
    language: str = ""
    elapsed_ms: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    raw_usage: dict[str, Any] = field(default_factory=dict)


def _coerce_transcriptions(items: Sequence[Any]) -> list[CloudTranscription]:
    out: list[CloudTranscription] = []
    for it in items or []:
        if isinstance(it, CloudTranscription):
            out.append(it)
            continue
        if not isinstance(it, dict):
            raise _fail("E_BADREQUEST", f"transcriptions 元素必须是对象，收到 {type(it).__name__}")
        if "index" not in it:
            raise _fail("E_BADREQUEST", "transcriptions 元素缺少 index")
        out.append(
            CloudTranscription(
                index=int(it["index"]),
                text=str(it.get("text") or ""),
                model=str(it.get("model") or ""),
                language=str(it.get("language") or ""),
                elapsed_ms=int(it.get("elapsedMs") or it.get("elapsed_ms") or 0),
                prompt_tokens=int(it.get("promptTokens") or it.get("prompt_tokens") or 0),
                completion_tokens=int(it.get("completionTokens") or it.get("completion_tokens") or 0),
                raw_usage=dict(it.get("usage") or {}),
            )
        )
    return out


def convert(
    *,
    plan_data: dict[str, Any],
    transcriptions: Sequence[Any],
    model: str = "",
    work_dir: str | None = None,
    language: str | None = None,
    on_progress: Callable[[float, str], None] | None = None,
    elapsed_ms: int = 0,
    partial: bool = False,
) -> dict[str, Any]:
    """**第二阶段**：Node 的云端转写结果 → 段（绝对时间）→ 与本地 ``asr`` job **同形**的返回。

    :param partial: ``True`` = **阶段性落盘**（Node 每转完几块调一次，**不要求**块已齐）。
        存在的理由很实际：26 块的视频按块计费，跑到第 10 块进程被杀 → 没有 partial 的话
        断点里一条都没有，重跑要把前 10 块**再付一次钱**。``partial=True`` 会把已转好的块
        写进断点，重跑只补剩下的（**省钱且不重复计费**）。
        块没齐时返回 ``partial: true`` + ``missingChunks``，**不声称完成**。
        默认 ``False``：块必须齐（断点里已有 + 本次回传），否则如实失败。

    ★ 关键行为（Lead 硬要求 1）：

    * **缺块**（既不在断点里、也没回传）且 ``partial=False`` → 抛 ``E_ASR_CLOUD_MISSING``，
      **绝不**回退本地、**绝不**用空文本凑一个段（坑 10：不产出空字幕假装成功）。
    * **块齐但全空文本** → 抛 ``E_ASR_EMPTY``（音频里没有语音）—— 与本地路径同一判据。
    * 断点：**只在真的有文本产出时**落盘（见下方"失败不留断点"的注释）。
    * 时间戳：块边界（**块级**），一个块一个段；``wordTimestamps: false`` 如实上报。

    返回与 ``worker/cli.py::job_asr`` 的转写分支**同形**（Node 的 ``upsertVideoArtifact`` 不用改）：

    ``{segments, language, model, durationMs, device, chunksTotal, chunksDone, chunksResumed,
       elapsedMs, words, langProbability}``

    额外如实字段：``asrSource`` / ``timestamps`` / ``wordTimestamps`` / ``partial`` /
    ``missingChunks`` / ``costEstimate``。
    """
    audio_path = str(plan_data.get("audioPath") or "")
    work_dir = work_dir or (os.path.dirname(os.path.dirname(audio_path)) if audio_path else "")
    duration_ms = int(plan_data.get("durationMs") or 0)
    chunk_ms = int(plan_data.get("chunkMs") or DEFAULT_CLOUD_CHUNK_MS)
    fingerprint = str(plan_data.get("fingerprint") or "")
    chunks = list(plan_data.get("chunks") or [])
    if not chunks:
        raise _fail("E_INPUT", "plan 数据里没有 chunks：convert 需要 plan 阶段的输出")

    ckpt_path = os.path.join(work_dir, "asr", "asr.ckpt.json") if work_dir else ""
    ckpt = asr_mod.AsrCheckpoint.load(ckpt_path, fingerprint) if ckpt_path else None
    if ckpt is None:
        ckpt = asr_mod.AsrCheckpoint(path=ckpt_path, fingerprint=fingerprint)
        ckpt.duration_ms = duration_ms
    done_before = sorted(set(int(x) for x in ckpt.done_chunks))

    got = {t.index: t for t in _coerce_transcriptions(transcriptions)}
    by_index = {int(c["index"]): c for c in chunks}

    unknown = sorted(set(got) - set(by_index))
    if unknown:
        raise _fail("E_BADREQUEST", f"transcriptions 里有 plan 之外的块号：{unknown}")

    # ★ 缺块 = 如实失败（partial=True 时允许，但要如实标注"还没完"）
    missing = [i for i in sorted(by_index) if i not in got and i not in set(done_before)]
    if missing and not partial:
        raise _fail(
            "E_ASR_CLOUD_MISSING",
            f"云端转写结果缺 {len(missing)} 块（{missing[:8]}{'…' if len(missing) > 8 else ''}）",
            "每块都必须有文本；worker **不会**回退本地 faster-whisper，也不产出空字幕。"
            "请检查 Node 侧的 OpenRouter 调用是否全部成功（含重试）。"
            "若是分阶段落盘，请显式传 partial=true。",
        )

    # 1) 先用断点里已完成的段（续跑）
    segs: list[VideoSegment] = []
    for s in ckpt.segments:
        try:
            segs.append(
                VideoSegment(
                    i=len(segs),
                    start=int(s["start"]),
                    end=int(s["end"]),
                    text=str(s.get("text") or ""),
                    confidence=float(s.get("confidence") or 0.0),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    new_done: list[int] = []
    new_seg_dicts: list[dict[str, Any]] = []
    used_models: set[str] = set()
    prompt_tokens = completion_tokens = 0
    for idx in sorted(got):
        t = got[idx]
        chunk = by_index[idx]
        text = (t.text or "").strip()
        if t.model:
            used_models.add(t.model)
        prompt_tokens += int(t.prompt_tokens or 0)
        completion_tokens += int(t.completion_tokens or 0)
        new_done.append(idx)
        if not text:
            # 这一块没有语音 → **不产出段**（不是失败；但若全部如此，下面会如实报 E_ASR_EMPTY）
            continue
        start = int(chunk.get("startMs") or 0)
        end = int(chunk.get("endMs") or 0)
        # ★ 块级时间戳：**就是块的边界**，不做伪细分；裁到片长
        if duration_ms > 0:
            end = min(end, duration_ms)
        if end <= start:
            end = max(start + 1, end)
        seg = VideoSegment(i=0, start=start, end=end, text=text, confidence=0.0)
        new_seg_dicts.append({"start": seg.start, "end": seg.end, "text": seg.text, "confidence": 0.0})
        segs.append(seg)

    # 3) 拼接：单调不重叠 + 裁到片长（**复用本地路径那套**，不重写）
    stitched = asr_mod.stitch_segments(segs, duration_ms=duration_ms or None)

    if not stitched and not missing:
        # ★ 块齐了、却一段都没有 → 与本地路径同一判据：**绝不产出空字幕假装成功**
        #
        # ⚠️ **这里必须在断点落盘之前**（实测踩到）：第一版先落盘再判空 →
        #    一次"全空"的失败运行会把 done_chunks 写成 [0,1,2]，
        #    之后每次重跑都"全部已完成、0 段" → **永久停摆**（且看起来像"没语音"）。
        #    失败**不留断点**：重跑会重新请求云端（可能花几次调用，但状态是干净的）。
        raise _fail(
            "E_ASR_EMPTY",
            "音频里没有识别出任何语音（0 段）",
            f"已收到全部 {len(got)} 块的云端结果，但文本都是空的。"
            "可能是纯音乐/静音视频，或音轨损坏。此时**不产出字幕与文稿**。",
        )

    # 4) 断点落盘：**只在真的有文本产出时**（避免"全空失败"污染断点 → 永久停摆）
    if ckpt_path and stitched:
        ckpt.model = model or next(iter(used_models), "") or ckpt.model
        ckpt.lang = (language or plan_data.get("language") or "")
        ckpt.duration_ms = duration_ms
        ckpt.done_chunks = sorted(set(done_before) | set(new_done))
        ckpt.segments = [
            {"i": s.i, "start": int(s.start), "end": int(s.end), "text": s.text,
             "confidence": float(s.confidence or 0.0)}
            for s in stitched
        ]
        ckpt.save()

    chunks_total = len(by_index)
    chunks_done = len(set(ckpt.done_chunks)) if ckpt_path else len(new_done) + len(done_before)
    _safe(on_progress, 0.95, "拼接云端结果")
    is_partial = bool(missing) or partial

    model_used = model or (next(iter(used_models)) if len(used_models) == 1 else "") or "openrouter"
    out = {
        "segments": [
            {
                "i": s.i,
                "startMs": int(s.start),
                "endMs": int(s.end),
                "text": s.text,
                "confidence": float(s.confidence or 0.0),
            }
            for s in stitched
        ],
        "language": (language or plan_data.get("language") or "unknown"),
        "model": model_used,
        "durationMs": duration_ms,
        "device": CLOUD_ASR_SOURCE,
        # 与本地路径同形的计数（camelCase，混用会踩坑）
        "chunksTotal": chunks_total,
        "chunksDone": chunks_done,
        "chunksResumed": len(done_before),
        "elapsedMs": int(elapsed_ms or 0),
        "words": [],
        "langProbability": 0.0,
        # ── ★ 如实标注（坑 21：自述字段必须与实际同源）──
        "asrSource": CLOUD_ASR_SOURCE,
        "timestamps": "chunk",
        "wordTimestamps": False,
        "chunkMs": chunk_ms,
        # partial=true 时**不声称完成**：段是"到目前为止"的，缺哪些块也如实列出
        "partial": is_partial,
        "missingChunks": list(missing),
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "costEstimate": cost_estimate(duration_ms, chunk_ms=chunk_ms),
    }
    _safe(on_progress, 0.5 if is_partial else 1.0, "阶段性落盘" if is_partial else "完成")
    return out


# ── 小工具 ──────────────────────────────────────────────────────────────
def _fail(code: str, msg: str, detail: str = "") -> VideoError:
    """统一的"如实失败"：带**错误码** + 可读原因（不抛裸 Exception）。"""
    return VideoError(msg, detail=detail or msg, code=code)


def _safe(cb: Callable[[float, str], None] | None, frac: float, stage: str) -> None:
    """进度回调是旁观者：它炸了不该影响主流程（沿用 asr.py 的口径）。"""
    if cb is None:
        return
    try:
        cb(max(0.0, min(1.0, frac)), stage)
    except Exception:  # noqa: BLE001
        pass


__all__ = [
    "CLOUD_ASR_SOURCE",
    "DEFAULT_CLOUD_CHUNK_MS",
    "CloudCostModel",
    "CloudTranscription",
    "MEASURED_COST",
    "cost_estimate",
    "plan",
    "convert",
]
