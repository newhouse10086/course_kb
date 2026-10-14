"""``inline`` provider：把**引擎级**转写函数包成 :class:`AsrProvider`。

为什么需要它：

* 单元测试要注入 ``transcribe_fn(idx, chunk) -> (segments, lang, prob)``，
  走**引擎级**假实现（不加载模型、不联网）；
* 流水线要**一条路**（provider 链）—— 不能"测试走 A 路、生产走 B 路"，
  否则降级/能力检查这些逻辑在测试里根本没被执行到。

所以测试注入的引擎假实现被包成 provider，**照样经过 configured → health →
capability → transcribe 四道关**，只是这四道关的回答由假实现给。
"""

from __future__ import annotations

import time
from typing import Any, Callable

from worker.models.video import VideoSegment
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

#: 引擎级假实现的签名（与 :data:`worker.video.asr.TranscribeFn` 一致）
EngineFn = Callable[[int, "asr_engine.AudioChunk"], "tuple[list[VideoSegment], str, float]"]


class InlineTranscribeProvider(AsrProvider):
    """用注入的引擎函数跑完整的分段/断点流程（provider 层只是薄包装）。"""

    def __init__(
        self,
        engine: EngineFn,
        *,
        id: str = "local-fw",
        model: str = "tiny",
        word_timestamps: bool = True,
        reason: str = "",
        available: bool = True,
        configured: bool = True,
    ):
        self.id = id
        self._engine = engine
        self.model = model
        self._word_ts = word_timestamps
        self._reason = reason
        self._available = available
        self._configured = configured

    def info(self, *, health: bool = False) -> ProviderInfo:
        return ProviderInfo(
            id=self.id,
            kind="asr",
            label="注入式 ASR（测试/内联）",
            vendor="inline",
            runtime="local",
            configured=self._configured,
            available=self._available,
            reason=self._reason,
            capabilities={
                "wordTimestamps": self._word_ts,
                "segmentLevelTimestamps": True,
                "languages": ["*"],
                "mode": "sync",
                "models": [self.model],
                "injected": True,
            },
        )

    def health_check(self) -> tuple[bool, str]:
        return self._available, self._reason

    def transcribe(self, req: AsrRequest) -> AsrResponse:
        started = time.time()
        try:
            result = asr_engine.transcribe_audio(
                req.audio_path,
                model=req.model or self.model,
                lang=req.language,
                duration_ms=req.duration_ms or None,
                work_dir=req.work_dir or None,
                chunk_ms=req.chunk_ms or asr_engine.DEFAULT_CHUNK_MS,
                resume=req.resume,
                transcribe_fn=self._engine,
                on_progress=req.on_progress,
                should_cancel=req.should_cancel,
            )
        except asr_engine.AsrUnavailable as exc:
            # ★ detail 必须带上：调用方（和测试）要看到"到底为什么不可用"
            raise ProviderError(
                exc.code, exc.message, detail=exc.detail, provider=self.id
            ) from exc
        segs = [AsrSegmentDTO.from_video_segment(s) for s in result.segments]
        return AsrResponse(
            segments=segs,
            language=result.lang,
            provider=self.id,
            used_provider=self.id,
            model=result.model,
            attempts=[AsrAttempt(self.id, True, "transcribe", "", result.elapsed_ms, len(segs))],
            elapsed_ms=int((time.time() - started) * 1000),
            compute_type=result.compute_type,
            chunks_total=result.chunks_total,
            chunks_resumed=result.chunks_resumed,
        )


__all__ = ["InlineTranscribeProvider", "EngineFn"]
