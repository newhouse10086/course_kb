"""云端 ASR provider（``openai-asr`` 已实现；阿里云/腾讯云/讯飞**如实声明为未实现**）。

## 诚实说明（必读）

* **``openai-asr``**：真的实现了（HTTP ``/audio/transcriptions`` + ``verbose_json``），
  可用任意 OpenAI 兼容端点；单请求 ≤25MB → **自动分段**（复用 :mod:`worker.video.asr`
  的切块逻辑），并**按块落断点/缓存**（云调用要钱，同一输入绝不重复计费）。
  ⚠️ 按 ``docs/PROVIDERS.md`` §2.1 的裁定，它的能力是**段级时间戳**：
  ``capabilities.wordTimestamps=false`` → 请求**硬要求**字级时间戳时会被降级链跳过。
* **``aliyun-asr`` / ``tencent-asr`` / ``xfyun-asr``**：调用需要各家的**签名算法**
  （阿里云 RPC 签名 / 腾讯云 TC3-HMAC-SHA256 / 讯飞 HMAC-SHA1），本机**没有凭据、
  也无法验证**，所以这里**只声明不实现**：``configured`` 按环境变量真实判断，
  ``available`` **恒为 false**，``reason`` 明确写"未实现 + 缺哪些变量"。
  **绝不**返回假转写结果占位。

新增一家真实实现 = 继承 :class:`OpenAiAsrProvider` 或直接实现 :class:`AsrProvider`，
然后在 :data:`worker.video.providers.CLOUD_SPECS` 里换成实现类即可（注册表不用改）。
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Callable, Sequence

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

#: OpenAI 兼容端点单请求文件上限（官方 25MB）
OPENAI_MAX_BYTES = 25 * 1024 * 1024
#: 云端一次请求的音频块长度（10 分钟 16k/mono/16bit ≈ 9.6MB，远低于 25MB 上限）
CLOUD_CHUNK_MS = 600_000


def redact(text: str, secrets: Sequence[str] = ()) -> str:
    """日志脱敏（凭据永不落日志，``docs/PROVIDERS.md`` §8）。"""
    out = str(text)
    for s in secrets:
        if s and len(s) >= 6:
            out = out.replace(s, "***")
    return out


class OpenAiAsrProvider(AsrProvider):
    """OpenAI 兼容 ``/audio/transcriptions``（段级时间戳）。"""

    id = "openai-asr"

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        model: str = "whisper-1",
        timeout_s: float = 120.0,
        transport: Any = None,
        env_prefix: tuple[str, ...] = ("COURSE_KB_ASR_BASE", "OPENAI_BASE_URL"),
        key_envs: tuple[str, ...] = ("COURSE_KB_ASR_KEY", "OPENAI_API_KEY"),
        cfg: dict[str, Any] | None = None,
    ):
        cfg = cfg or {}
        self._base_url = base_url or cfg.get("base_url") or _first_env(env_prefix)
        self._api_key = api_key or cfg.get("api_key") or _first_env(key_envs)
        self.model = model or cfg.get("model") or "whisper-1"
        self.timeout_s = timeout_s
        self._transport = transport  # 测试注入 httpx.MockTransport
        self._probe: tuple[bool, str] | None = None
        self._key_envs = key_envs

    # ── 能力 ────────────────────────────────────────────────────────
    def info(self, *, health: bool = False) -> ProviderInfo:
        configured = bool(self._base_url and self._api_key)
        reason = ""
        if not configured:
            missing = []
            if not self._base_url:
                missing.append("ASR base_url")
            if not self._api_key:
                missing.append("ASR api_key")
            reason = (
                "缺少凭据：" + "、".join(missing)
                + "（由 Node 层通过 job 参数下发，或设 "
                + "/".join(self._key_envs)
                + "）"
            )
        available = configured
        if health and configured:
            available, reason = self.health_check()
        return ProviderInfo(
            id=self.id,
            kind="asr",
            label="OpenAI Whisper API（兼容端点）",
            vendor="OpenAI",
            runtime="cloud",
            configured=configured,
            available=available,
            reason=reason,
            capabilities={
                # ★ 按 docs/PROVIDERS.md §2.1：OpenAI 只有**段级**时间戳。
                #   不硬凑字级（伪造字级时间戳比报 false 更糟）。
                "wordTimestamps": False,
                "segmentLevelTimestamps": True,
                "languages": ["*"],
                "mode": "sync",
                "maxSizeBytes": OPENAI_MAX_BYTES,
                "maxDurationSec": None,
                "diarization": False,
                "models": [self.model],
                "autoChunking": True,
            },
            pricing={"unit": "minute", "amount": 0.006, "currency": "USD", "note": "官方价，端点可能不同"},
            limits={"maxSizeBytes": OPENAI_MAX_BYTES, "rpm": None},
        )

    def health_check(self) -> tuple[bool, str]:
        """真探测：打一次 ``GET /models``（真请求，不是看配置）。

        ⚠️ 局限（如实说明）：``/models`` 通不代表 ``/audio/transcriptions`` 一定可用；
        真转写失败时降级链会捕获 :class:`ProviderError` 并继续下一跳。
        """
        if self._probe is not None:
            return self._probe
        if not (self._base_url and self._api_key):
            self._probe = (False, "缺少凭据")
            return self._probe
        try:
            import httpx

            with self._client(timeout=min(10.0, self.timeout_s)) as client:
                resp = client.get(f"{self._base_url.rstrip('/')}/models")
            if resp.status_code < 400:
                self._probe = (True, f"就绪（{self.model}）")
            else:
                self._probe = (
                    False,
                    f"探测失败：HTTP {resp.status_code} {redact(resp.text[:120], [self._api_key or ''])}",
                )
        except Exception as exc:  # noqa: BLE001 - 网络/证书/超时都算不可用
            self._probe = (False, f"探测异常：{type(exc).__name__}: {redact(str(exc), [self._api_key or ''])}")
        return self._probe

    def _client(self, *, timeout: float):
        import httpx

        kwargs: dict[str, Any] = {"timeout": timeout}
        if self._transport is not None:
            kwargs["transport"] = self._transport
        return httpx.Client(**kwargs)

    # ── 转写 ────────────────────────────────────────────────────────
    def transcribe(self, req: AsrRequest) -> AsrResponse:
        started = time.time()
        if not (self._base_url and self._api_key):
            raise ProviderError("E_ASR_CONFIG", "缺少 base_url/api_key", provider=self.id)
        duration = req.duration_ms or asr_engine.wav_duration_ms(req.audio_path)
        work = req.work_dir or os.path.join(
            os.path.dirname(os.path.abspath(req.audio_path)), "cloud"
        )
        os.makedirs(work, exist_ok=True)
        ckpt_path = req.ckpt_path or os.path.join(work, "asr.cloud.ckpt.json")
        # 云的断点指纹要把 provider + 模型算进去（换了端点就不该复用旧结果）
        fingerprint = f"{self.id}|{self.model}|{asr_engine.audio_fingerprint(req.audio_path, self.model, duration)}"
        ckpt = asr_engine.AsrCheckpoint.load(ckpt_path, fingerprint) if req.resume else None
        if ckpt is None:
            ckpt = asr_engine.AsrCheckpoint(
                path=ckpt_path,
                fingerprint=fingerprint,
                model=self.model,
                lang=req.language or "",
                duration_ms=duration,
                started_at=int(time.time() * 1000),
            )
        done = set(ckpt.done_chunks)
        chunks = asr_engine.plan_chunks(duration, req.chunk_ms or CLOUD_CHUNK_MS)
        pending = [c for c in chunks if c.index not in done]
        segments: list[AsrSegmentDTO] = [
            AsrSegmentDTO.from_dict(d) for d in ckpt.segments
        ]
        resumed = len(done)
        if pending:
            pending = asr_engine.split_audio(
                req.audio_path, pending, work, should_cancel=req.should_cancel
            )
            for chunk in pending:
                if req.should_cancel is not None and req.should_cancel():
                    ckpt.save()
                    raise ProviderError(
                        "E_CANCELLED", "云端转写被取消（断点已保存）", provider=self.id
                    )
                size = os.path.getsize(chunk.path)
                if size > OPENAI_MAX_BYTES:
                    raise ProviderError(
                        "E_ASR_TOOBIG",
                        f"分块后仍超过 {OPENAI_MAX_BYTES} 字节上限（{size}）",
                        detail="请调小 chunk_ms（当前 "
                        f"{req.chunk_ms or CLOUD_CHUNK_MS}ms）",
                        provider=self.id,
                    )
                got = self._post_chunk(chunk.path, req, timeout=req.timeout_s)
                for seg in got:
                    segments.append(
                        AsrSegmentDTO(
                            i=len(segments),
                            startMs=seg.startMs + chunk.start_ms,
                            endMs=seg.endMs + chunk.start_ms,
                            text=seg.text,
                            confidence=seg.confidence,
                        )
                    )
                ckpt.done_chunks = sorted({*ckpt.done_chunks, chunk.index})
                # 存"绝对时间"版本，续跑时直接读
                ckpt.segments = [s.to_dict() for s in _stitch(segments, duration)]
                ckpt.save()  # ★ 每块落盘：云调用要钱，中断后绝不重付
                if req.on_progress is not None:
                    done_ms = sum(c.duration_ms for c in chunks if c.index in ckpt.done_chunks)
                    _safe(req.on_progress, min(0.99, done_ms / max(1, duration)), "云端转写")
        final = _stitch(segments, duration)
        if not final:
            raise ProviderError(
                "E_ASR_EMPTY",
                "云端返回 0 段转写（音频里可能没有语音）",
                detail="不产出空字幕；请检查音频或换 provider",
                provider=self.id,
            )
        lang = req.language or ckpt.lang or ""
        return AsrResponse(
            segments=final,
            language=lang,
            provider=self.id,
            used_provider=self.id,
            model=self.model,
            attempts=[AsrAttempt(self.id, True, "transcribe", "", int((time.time() - started) * 1000), len(final))],
            elapsed_ms=int((time.time() - started) * 1000),
            chunks_total=len(chunks),
            chunks_resumed=resumed,
        )

    def _post_chunk(self, path: str, req: AsrRequest, *, timeout: float) -> list[AsrSegmentDTO]:
        """一次 ``/audio/transcriptions`` 调用 → 段（**块内相对时间**）。"""
        import httpx

        url = f"{self._base_url.rstrip('/')}/audio/transcriptions"
        data: dict[str, Any] = {"model": self.model, "response_format": "verbose_json"}
        if req.language:
            data["language"] = req.language
        try:
            with open(path, "rb") as fh:
                files = {"file": (os.path.basename(path), fh, "audio/wav")}
                with self._client(timeout=timeout) as client:
                    resp = client.post(
                        url,
                        headers={"Authorization": f"Bearer {self._api_key}"},
                        data=data,
                        files=files,
                    )
        except httpx.TimeoutException as exc:
            raise ProviderError(
                "E_ASR_TIMEOUT",
                f"云端转写超时（>{timeout}s）",
                detail=redact(str(exc), [self._api_key or ""]),
                provider=self.id,
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(
                "E_ASR_HTTP",
                f"云端转写网络错误：{type(exc).__name__}",
                detail=redact(str(exc), [self._api_key or ""]),
                provider=self.id,
            ) from exc
        if resp.status_code >= 400:
            raise ProviderError(
                "E_ASR_HTTP",
                f"云端转写失败：HTTP {resp.status_code}",
                detail=redact(resp.text[:300], [self._api_key or ""]),
                provider=self.id,
            )
        try:
            payload = resp.json()
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(
                "E_ASR_SCHEMA",
                "云端返回不是 JSON",
                detail=redact(resp.text[:200], [self._api_key or ""]),
                provider=self.id,
            ) from exc
        return _parse_verbose_json(payload)


def _parse_verbose_json(payload: dict[str, Any]) -> list[AsrSegmentDTO]:
    """``verbose_json`` → 段（秒 → 毫秒）。容忍 ``segments`` 缺失时的 ``text`` 兜底。"""
    out: list[AsrSegmentDTO] = []
    for n, seg in enumerate(payload.get("segments") or []):
        text = str(seg.get("text", "")).strip()
        if not text:
            continue
        start = int(round(float(seg.get("start", 0.0)) * 1000))
        end = int(round(float(seg.get("end", seg.get("start", 0.0))) * 1000))
        conf = seg.get("no_speech_prob")
        out.append(
            AsrSegmentDTO(
                i=n,
                startMs=start,
                endMs=max(start, end),
                text=text,
                confidence=(None if conf is None else max(0.0, min(1.0, 1.0 - float(conf)))),
            )
        )
    if out:
        return out
    text = str(payload.get("text", "")).strip()
    if text:
        # 极少数端点只回整段文本 → 给整段一个 0..duration 的兜底段（**不当成字级**）
        dur = int(round(float(payload.get("duration", 0.0)) * 1000))
        return [AsrSegmentDTO(i=0, startMs=0, endMs=max(1, dur), text=text, confidence=None)]
    return []


def _stitch(segments: Sequence[AsrSegmentDTO], duration_ms: int) -> list[AsrSegmentDTO]:
    """块拼接：单调不重叠 + 裁到片长（与本地路径同一套不变量）。"""
    out: list[AsrSegmentDTO] = []
    prev_end = 0
    for seg in sorted(segments, key=lambda s: (s.startMs, s.endMs)):
        text = (seg.text or "").strip()
        if not text:
            continue
        start = max(0, int(seg.startMs))
        end = max(start, int(seg.endMs))
        if duration_ms > 0:
            if start >= duration_ms:
                continue
            end = min(end, duration_ms)
        if out and start < prev_end:
            start = prev_end
        if out and end <= start:
            continue
        out.append(
            AsrSegmentDTO(
                i=len(out), startMs=start, endMs=max(start, end), text=text,
                confidence=seg.confidence, words=seg.words,
            )
        )
        prev_end = out[-1].endMs
    return out


class DeclaredAsrProvider(AsrProvider):
    """**只声明、不实现**的云 provider（缺凭据/缺签名实现时如实报不可用）。

    :param env_vars: 该家需要的环境变量名（用于生成"缺哪个变量"的可读原因）
    """

    def __init__(
        self,
        *,
        id: str,
        label: str,
        vendor: str,
        env_vars: Sequence[str],
        capabilities: dict[str, Any] | None = None,
        capabilities_source: str = "docs/PROVIDERS.md §2.1",
    ):
        self.id = id
        self.label = label
        self.vendor = vendor
        self.env_vars = tuple(env_vars)
        self._caps = dict(capabilities or {})
        self.capabilities_source = capabilities_source

    def info(self, *, health: bool = False) -> ProviderInfo:
        missing = [v for v in self.env_vars if not os.environ.get(v)]
        configured = not missing
        reason = (
            f"未实现：{self.vendor} ASR 需要厂商签名算法（见 {self.capabilities_source}）；"
            "本模块只有接口声明，不产出假结果。"
        )
        if missing:
            reason += "缺少环境变量：" + "、".join(missing) + "。"
        return ProviderInfo(
            id=self.id,
            kind="asr",
            label=self.label,
            vendor=self.vendor,
            runtime="cloud",
            configured=configured,
            available=False,  # ★ 恒为 false：没实现就是不可用，绝不假装
            reason=reason,
            capabilities={
                **self._caps,
                "implemented": False,
            },
        )

    def health_check(self) -> tuple[bool, str]:
        return False, self.info().reason

    def transcribe(self, req: AsrRequest) -> AsrResponse:
        raise ProviderError(
            "E_ASR_NOT_IMPLEMENTED",
            f"{self.id} 未实现",
            detail=self.info().reason,
            provider=self.id,
        )


def _first_env(names: Sequence[str]) -> str:
    for n in names:
        v = os.environ.get(n)
        if v and v.strip():
            return v.strip()
    return ""


def _safe(cb: Callable[[float, str], None], frac: float, stage: str) -> None:
    try:
        cb(max(0.0, min(1.0, frac)), stage)
    except Exception:  # noqa: BLE001
        pass


#: 云端候选（id → 构造器）。把某一家的构造器换成真实实现即可接入。
CLOUD_SPECS: dict[str, dict[str, Any]] = {
    "aliyun-asr": {
        "label": "阿里云智能语音交互",
        "vendor": "阿里云",
        "env_vars": ("ALIYUN_AK", "ALIYUN_SK", "ALIYUN_APPKEY"),
        "capabilities": {
            "wordTimestamps": True,
            "segmentLevelTimestamps": True,
            "languages": ["zh", "en"],
            "mode": "async",  # 录音文件识别是异步任务制（提交→轮询→取结果）
            "maxSizeBytes": None,
            "diarization": False,
        },
    },
    "tencent-asr": {
        "label": "腾讯云语音识别",
        "vendor": "腾讯云",
        "env_vars": ("TENCENT_SECRET_ID", "TENCENT_SECRET_KEY"),
        "capabilities": {
            "wordTimestamps": True,
            "segmentLevelTimestamps": True,
            "languages": ["zh", "en"],
            "mode": "sync",
            "diarization": False,
        },
    },
    "xfyun-asr": {
        "label": "讯飞听见",
        "vendor": "讯飞",
        "env_vars": ("XFYUN_APPID", "XFYUN_API_KEY", "XFYUN_API_SECRET"),
        "capabilities": {
            "wordTimestamps": True,
            "segmentLevelTimestamps": True,
            "languages": ["zh", "en"],
            "mode": "async",
            "diarization": False,
        },
    },
}


def build_declared_providers() -> dict[str, AsrProvider]:
    return {
        pid: DeclaredAsrProvider(
            id=pid,
            label=spec["label"],
            vendor=spec["vendor"],
            env_vars=spec["env_vars"],
            capabilities=spec["capabilities"],
        )
        for pid, spec in CLOUD_SPECS.items()
    }


__all__ = [
    "OpenAiAsrProvider",
    "DeclaredAsrProvider",
    "CLOUD_SPECS",
    "OPENAI_MAX_BYTES",
    "CLOUD_CHUNK_MS",
    "build_declared_providers",
    "redact",
]
