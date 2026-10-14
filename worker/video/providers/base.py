"""ASR Provider 抽象（``docs/PROVIDERS.md`` §1/§2 的 Python 侧实现）。

## 为什么要有这一层

用户要求 ASR **大概率走大厂 API**（阿里云/腾讯云/讯飞/OpenAI），本地 faster-whisper
只是"本机零成本、已验证"的那一跳。所以：

* **接口统一**：不同厂商的调用模式（同步 / 异步任务制）、输入（URL/base64/文件）、
  结果结构（``Sentences[]`` / ``Sentence[]`` / ``segments[]``）**全部在 provider 内抹平**
* **能力如实上报**：OpenAI 只有**段级**时间戳，没有字级 → ``capabilities.wordTimestamps=false``，
  **不许硬凑**（伪造字级时间戳比报 false 更糟）
* **降级要真探测**：``configured``（有凭据）与 ``available``（真探测通过）**分开报**（R1/R2）
* **能力不满足就跳过**：请求要字级时间戳而这一跳不支持 → **继续下一跳**，不是降级产出次品
* **全链失败如实报错**：``AsrUnavailable`` + 每一跳的原因，**绝不产出空字幕或编造文稿**（R3）

## 统一输出结构

内部统一成**毫秒 + camelCase**（与 ``docs/PROVIDERS.md`` §2.2 一致）::

    {"i":0, "startMs":1200, "endMs":4800, "text":"…", "confidence":0.91,
     "words":[{"w":"索引","startMs":1200,"endMs":1700}]}

边界很清楚：**provider 接口用 camelCase**（跨语言契约，给 Node 看），
**入库模型 ``VideoSegment`` 用 snake_case ``start``/``end``**（契约 §2.7）。
转换只发生在 :meth:`AsrSegmentDTO.to_video_segment`。
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

from worker.models.video import VideoSegment

log = logging.getLogger(__name__)

#: Provider 类别（与 TS 侧 ``ProviderKind`` 对齐；worker 只管 media 类）
KINDS = ("asr", "ocr", "tts", "translate")


class ProviderError(Exception):
    """Provider 层错误（含可读原因与错误码）。"""

    def __init__(self, code: str, msg: str, *, detail: str = "", provider: str = ""):
        super().__init__(msg)
        self.code = code
        self.msg = msg
        self.detail = detail or msg
        self.provider = provider


@dataclass
class ProviderInfo:
    """Provider 元信息（``docs/PROVIDERS.md`` §1 的 ``ProviderInfo``）。"""

    id: str
    kind: str = "asr"
    label: str = ""
    vendor: str = ""
    runtime: str = "local"  # local | cloud
    configured: bool = False
    available: bool = False
    reason: str = ""
    capabilities: dict[str, Any] = field(default_factory=dict)
    pricing: dict[str, Any] | None = None
    limits: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "vendor": self.vendor,
            "runtime": self.runtime,
            "configured": self.configured,
            "available": self.available,
            "capabilities": dict(self.capabilities),
        }
        if not self.available:
            # ★ R3：不可用时**必须**给可读原因（UI 要显示，不能让用户点了才报错）
            out["reason"] = self.reason or "不可用（未说明原因）"
        elif self.reason:
            out["reason"] = self.reason
        if self.pricing:
            out["pricing"] = dict(self.pricing)
        if self.limits:
            out["limits"] = dict(self.limits)
        return out


@dataclass
class AsrWordDTO:
    w: str
    startMs: int
    endMs: int

    def to_dict(self) -> dict[str, Any]:
        return {"w": self.w, "startMs": self.startMs, "endMs": self.endMs}


@dataclass
class AsrSegmentDTO:
    """统一段落结构（**毫秒 + camelCase**）。"""

    i: int
    startMs: int
    endMs: int
    text: str
    confidence: float | None = None
    words: list[AsrWordDTO] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "i": self.i,
            "startMs": self.startMs,
            "endMs": self.endMs,
            "text": self.text,
        }
        if self.confidence is not None:
            out["confidence"] = self.confidence
        if self.words:
            out["words"] = [w.to_dict() for w in self.words]
        return out

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "AsrSegmentDTO":
        return cls(
            i=int(d.get("i", 0)),
            startMs=int(d.get("startMs", 0)),
            endMs=int(d.get("endMs", d.get("startMs", 0))),
            text=str(d.get("text", "")),
            confidence=(None if d.get("confidence") is None else float(d["confidence"])),
            words=[AsrWordDTO(str(w.get("w", "")), int(w.get("startMs", 0)), int(w.get("endMs", 0)))
                   for w in (d.get("words") or [])],
        )

    # ── 边界转换（provider camelCase ↔ 契约 snake_case）──────────────
    def to_video_segment(self) -> VideoSegment:
        return VideoSegment(
            i=self.i,
            start=self.startMs,
            end=max(self.startMs, self.endMs),
            text=self.text,
            confidence=float(self.confidence or 0.0),
        )

    @classmethod
    def from_video_segment(
        cls, seg: VideoSegment, words: Sequence[dict[str, Any]] | None = None
    ) -> "AsrSegmentDTO":
        """``VideoSegment`` 用的是 ``(start, end)`` 毫秒 + 词表 ``{"w","start","end"}``。"""
        return cls(
            i=int(seg.i),
            startMs=int(seg.start),
            endMs=int(seg.end),
            text=seg.text,
            confidence=float(seg.confidence) if seg.confidence else None,
            words=[
                AsrWordDTO(str(w.get("w", "")), int(w.get("start", 0)), int(w.get("end", 0)))
                for w in (words or [])
            ],
        )


@dataclass
class AsrRequest:
    """一次转写请求（provider 必须按 ``capabilities`` 判断自己能不能接）。"""

    audio_path: str
    duration_ms: int = 0
    language: str | None = None
    #: **硬要求**：不满足就必须跳过这一跳（不能"降级产出次品"）
    require_word_timestamps: bool = False
    #: **软偏好**：支持就带字级时间戳，不支持也能跑（OpenAI 段级）
    prefer_word_timestamps: bool = True
    work_dir: str = ""
    ckpt_path: str | None = None
    chunk_ms: int = 0
    resume: bool = True
    model: str | None = None
    should_cancel: Callable[[], bool] | None = None
    on_progress: Callable[[float, str], None] | None = None
    timeout_s: float = 120.0
    #: 云端需要的原视频/源文件（有的厂商要 URL 或整文件上传）
    source_path: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "AsrRequest":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in known})


@dataclass
class AsrAttempt:
    """降级链上**每一跳**的真实结果（R2：不许只看配置）。"""

    provider: str
    ok: bool
    stage: str = "transcribe"  # config | health | capability | transcribe
    reason: str = ""
    elapsed_ms: int = 0
    segments: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "ok": self.ok,
            "stage": self.stage,
            "reason": self.reason,
            "elapsed_ms": self.elapsed_ms,
            "segments": self.segments,
        }


@dataclass
class AsrResponse:
    """统一转写结果 + **降级上报**（PROVIDERS.md R0 的字段）。"""

    segments: list[AsrSegmentDTO]
    language: str = ""
    provider: str = ""
    model: str = ""
    used_provider: str = ""
    degraded_from: str = ""
    reason: str = ""
    attempts: list[AsrAttempt] = field(default_factory=list)
    elapsed_ms: int = 0
    compute_type: str = ""
    chunks_total: int = 0
    chunks_resumed: int = 0
    words: list[AsrWordDTO] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "used_provider": self.used_provider or self.provider,
            "degraded_from": self.degraded_from,
            "reason": self.reason,
            "model": self.model,
            "language": self.language,
            "segments": [s.to_dict() for s in self.segments],
            "attempts": [a.to_dict() for a in self.attempts],
            "elapsed_ms": self.elapsed_ms,
            "compute_type": self.compute_type,
            "chunks_total": self.chunks_total,
            "chunks_resumed": self.chunks_resumed,
        }


class AsrProvider(ABC):
    """ASR provider 基类。

    实现者必须：
    1. 声明 :attr:`id` 与 :meth:`info`（``configured`` / ``available`` **分开且真实**）
    2. ``health_check()`` **真探测**（不只看配置）
    3. ``supports()`` 如实回答能力问题
    4. ``transcribe()`` 返回统一结构；失败抛 :class:`ProviderError`
    """

    id: str = ""
    kind: str = "asr"

    @abstractmethod
    def info(self, *, health: bool = False) -> ProviderInfo:
        """能力快照。``health=True`` 时才做真探测（``/capabilities`` 不该触发网络）。"""

    @abstractmethod
    def health_check(self) -> tuple[bool, str]:
        """真探测 → ``(ok, reason)``。"""

    def supports(self, req: AsrRequest) -> tuple[bool, str]:
        """这一跳能否满足请求（默认按 ``capabilities`` 判断字级时间戳）。"""
        cap = self.info().capabilities
        if req.require_word_timestamps and not cap.get("wordTimestamps", False):
            return False, "缺少字级时间戳能力（require_word_timestamps=True）"
        max_bytes = cap.get("maxSizeBytes")
        if max_bytes and req.extra.get("size_bytes"):
            if int(req.extra["size_bytes"]) > int(max_bytes):
                return False, f"文件超过大小上限（{req.extra['size_bytes']} > {max_bytes} 字节）"
        max_sec = cap.get("maxDurationSec")
        if max_sec and req.duration_ms and req.duration_ms / 1000.0 > float(max_sec):
            return False, f"时长超过上限（{req.duration_ms / 1000:.0f}s > {max_sec}s）"
        langs = cap.get("languages")
        if req.language and langs and "*" not in langs and req.language not in langs:
            return False, f"不支持语言 {req.language}（支持 {langs}）"
        return True, ""

    @abstractmethod
    def transcribe(self, req: AsrRequest) -> AsrResponse:
        """执行转写（provider 内部负责分段/断点/超时）。"""


__all__ = [
    "KINDS",
    "ProviderError",
    "ProviderInfo",
    "AsrWordDTO",
    "AsrSegmentDTO",
    "AsrRequest",
    "AsrAttempt",
    "AsrResponse",
    "AsrProvider",
]
