"""``local-fw`` —— 本地 faster-whisper provider（**本机已验证可用**）。

这一层很薄：真正的转写引擎在 :mod:`worker.video.asr`（分段 + 断点 + 模型降级链），
这里只负责"把它包成 :class:`AsrProvider`"，并**如实上报能力**。

已验证事实（``docs/PROVIDERS.md`` §2.3）：
* ``faster-whisper 1.2.1`` / ``ctranslate2 4.8.3`` / CPU int8 / ``tiny`` 已缓存
* ⚠️ **传文件路径会炸**（PyAV 19.0.1 没有 ``metadata_errors`` 参数）→ :mod:`asr` 里
  已经改成传 numpy 数组
* **RTF ≈ 2x**（真实中文人声：5 分钟音频 → 128s）→ 1 小时课程 ≈ 25–30 分钟，不是 10 分钟
"""

from __future__ import annotations

import logging
import time

from worker.video import asr as asr_engine

from .base import (
    AsrAttempt,
    AsrProvider,
    AsrRequest,
    AsrResponse,
    AsrSegmentDTO,
    ProviderError,
    ProviderInfo,
)

log = logging.getLogger(__name__)


class LocalFasterWhisperProvider(AsrProvider):
    """本地 faster-whisper（零成本、有字级时间戳、CPU 慢）。"""

    id = "local-fw"

    def __init__(
        self,
        *,
        model: str = "tiny",
        model_chain: tuple[str, ...] = asr_engine.DEFAULT_MODEL_CHAIN,
        device: str = "cpu",
        compute_type: str | None = None,
        vad_filter: bool = True,
        word_timestamps: bool = True,
        beam_size: int = 1,
        download_root: str | None = None,
    ):
        self.model = model
        self.model_chain = tuple(model_chain)
        self.device = device
        self.compute_type = compute_type
        self.vad_filter = vad_filter
        self.word_timestamps = word_timestamps
        self.beam_size = beam_size
        self.download_root = download_root
        self._probe: tuple[bool, str] | None = None

    # ── 能力 ────────────────────────────────────────────────────────
    def info(self, *, health: bool = False) -> ProviderInfo:
        configured, reason = self._configured()
        available = configured
        if health and configured:
            available, reason = self.health_check()
        cached = asr_engine.cached_models()
        return ProviderInfo(
            id=self.id,
            kind="asr",
            label="本地 faster-whisper",
            vendor="本地",
            runtime="local",
            configured=configured,
            available=available,
            reason=reason,
            capabilities={
                "wordTimestamps": True,
                "segmentLevelTimestamps": True,
                "languages": ["*"],  # whisper 多语言；具体语言在转写时自动检测
                "mode": "sync",
                "maxSizeBytes": None,
                "maxDurationSec": None,
                "diarization": False,
                "models": list(self.model_chain),
                "cachedModels": cached,
                "device": self.device,
                "computeType": self.compute_type or "int8(自动降级)",
                "rtfEstimate": 2.0,
            },
            pricing={"unit": "hour", "amount": 0, "currency": "CNY", "note": "本地 CPU，RTF≈2x"},
        )

    def _configured(self) -> tuple[bool, str]:
        """依赖齐备吗（**不加载模型**）。"""
        cap = asr_engine.asr_capability(device=self.device)
        return bool(cap["available"]), str(cap.get("reason", ""))

    def health_check(self) -> tuple[bool, str]:
        """真探测：包能 import + ffmpeg 可用 + 模型本地有缓存（这三条决定"现在能不能真跑"）。

        ⚠️ **故意不加载模型**：加载要几秒到几十秒，不能放进 ``/capabilities``。
        模型加载失败会在 :meth:`transcribe` 里被降级链捕获。
        """
        if self._probe is not None:
            return self._probe
        configured, reason = self._configured()
        if not configured:
            self._probe = (False, reason)
            return self._probe
        cached = asr_engine.cached_models()
        want = self.model
        if want in cached:
            self._probe = (True, f"就绪：{want} 已缓存（{self.device}/int8）")
        else:
            self._probe = (
                True,
                f"就绪，但 {want} 未缓存 → 首次转写需联网下载（可用 HF_ENDPOINT 换镜像）",
            )
        return self._probe

    # ── 转写 ────────────────────────────────────────────────────────
    def transcribe(self, req: AsrRequest) -> AsrResponse:
        started = time.time()
        duration = req.duration_ms or asr_engine.wav_duration_ms(req.audio_path)
        try:
            result = asr_engine.transcribe_audio(
                req.audio_path,
                model=req.model or self.model,
                lang=req.language,
                duration_ms=duration,
                work_dir=req.work_dir or None,
                ckpt_path=req.ckpt_path,
                chunk_ms=req.chunk_ms or asr_engine.DEFAULT_CHUNK_MS,
                resume=req.resume,
                model_chain=self.model_chain,
                device=self.device,
                compute_type=self.compute_type,
                download_root=self.download_root,
                vad_filter=self.vad_filter,
                word_timestamps=self.word_timestamps and (
                    req.prefer_word_timestamps or req.require_word_timestamps
                ),
                beam_size=self.beam_size,
                on_progress=req.on_progress,
                should_cancel=req.should_cancel,
            )
        except asr_engine.AsrUnavailable as exc:
            raise ProviderError(exc.code, exc.message, detail=exc.detail, provider=self.id) from exc

        words_by_seg: dict[int, list[dict]] = {}
        for w in result.words:
            # 词归属：按时间落在哪个段里（段是单调不重叠的）
            for seg in result.segments:
                if seg.start <= w["start"] < seg.end or (seg.start <= w["end"] <= seg.end):
                    words_by_seg.setdefault(int(seg.i), []).append(w)
                    break
        segments = [
            AsrSegmentDTO.from_video_segment(seg, words_by_seg.get(int(seg.i)))
            for seg in result.segments
        ]
        return AsrResponse(
            segments=segments,
            language=result.lang,
            provider=self.id,
            used_provider=self.id,
            model=result.model,
            attempts=[AsrAttempt(self.id, True, "transcribe", "", result.elapsed_ms, len(segments))],
            elapsed_ms=int((time.time() - started) * 1000),
            compute_type=result.compute_type,
            chunks_total=result.chunks_total,
            chunks_resumed=result.chunks_resumed,
        )


__all__ = ["LocalFasterWhisperProvider"]
