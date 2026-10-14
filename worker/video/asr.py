"""S2 ASR 转写：16k 单声道 WAV → 带时间戳的段落（faster-whisper）。

## 为什么是 faster-whisper

参考文章的 **FunASR + Docker** 方案在本机**不可用（Docker 未安装，实测）**；
替代：`faster-whisper`（`pip install faster-whisper` 可达，CPU 可跑，int8 量化）。
流程设计照抄文章（抽音频 → ASR 带时间戳 → 分章 → 摘要 → 思维导图），**只换实现**。

## 三个硬要求（都在这里落地）

1. **分段 + 断点**（F6 关键参数表）：1 小时视频 CPU 转写要 10+ 分钟，
   不能"跑到一半崩了全部重来"。做法见 :func:`transcribe_audio`：
   音频按 :data:`DEFAULT_CHUNK_MS` 切块，**每块转写完立刻落盘**（:class:`AsrCheckpoint`），
   `resume=True` 时跳过已完成块，段偏移自动接上。
2. **如实降级**（坑 10）：任何一环不可用（包没装 / 模型下不下来 / 音轨为空 /
   音频里没有语音）都抛 :class:`AsrUnavailable`，**绝不返回空字幕假装成功**。
   :func:`asr_capability` 供 `/capabilities` 的 `asr.available` 使用。
3. **单位统一毫秒**（契约 §2.2 span.kind=time）。

## 拼接处的坑

分段转写拼接时，相邻块在边界上会**重叠**（whisper 会在块尾补全上一句）。
落盘前用 :func:`stitch_segments` 把时间轴压成**单调不重叠**，
否则 SRT 会出现"两条字幕同一秒"（播放器表现是字幕闪跳）。
"""

from __future__ import annotations

import json
import logging
import os
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from worker.models.video import VideoSegment

from .audio import wav_duration_ms
from .errors import AsrDependencyMissing, AsrUnavailable, JobCancelled
from .ffmpeg_util import FfmpegUnavailable, find_ffmpeg, run_ffmpeg_streaming, stderr_tail

log = logging.getLogger(__name__)

#: 一次转写的音频块长度。10 分钟：CPU 上单块 ≈1~3 分钟，断点粒度够细，
#: 又不会因为块太短而丢掉上下文（whisper 每块都要重新"热身"）。
DEFAULT_CHUNK_MS = 600_000

#: 模型降级链（F6 关键参数：tiny → base → small，CPU 无 CUDA）
DEFAULT_MODEL_CHAIN: tuple[str, ...] = ("tiny", "base", "small")

#: compute_type 降级链（老 CPU 不支持 int8 时退到 float32）
_COMPUTE_CHAIN: tuple[str, ...] = ("int8", "int8_float32", "float32")

#: 断点文件版本；不兼容时**丢弃重来**（不猜测旧格式）
CKPT_VERSION = 1


# ── 能力探测（无副作用；backend-core 的 /capabilities 直接调）───────────
def _hf_cache_dir() -> Path:
    root = os.environ.get("HF_HOME") or os.path.join(
        os.path.expanduser("~"), ".cache", "huggingface"
    )
    return Path(root) / "hub"


def cached_models() -> list[str]:
    """本地已缓存的 faster-whisper 模型名（Systran 官方仓库）。

    ⚠️ 首次转写需要联网从 HuggingFace 下载（tiny≈75MB / base≈145MB / small≈480MB）。
    本机实测可下载（2026-10-14）。
    """
    hub = _hf_cache_dir()
    out: list[str] = []
    if not hub.is_dir():
        return out
    for name in DEFAULT_MODEL_CHAIN + ("medium", "large-v3", "large-v2"):
        for pat in (f"models--Systran--faster-whisper-{name}", f"models--*--{name}"):
            if any(hub.glob(pat)):
                out.append(name)
                break
    return out


def asr_capability(*, device: str = "cpu") -> dict:
    """ASR 能力快照（**不做任何下载/加载**，可在 `/capabilities` 里随便调）。

    :return: ``{"available": bool, "engine": str, "models": [...], "device": str,
              "reason": str, "cached_models": [...]}``

    ``available=False`` 时 UI 必须**禁用**"生成字幕"入口并显示 ``reason``（坑 10）；
    此时仍可产出播放器 + 时间轴 + 幻灯片帧 + 手动上传字幕。
    """
    info: dict[str, Any] = {
        "available": False,
        "engine": "faster-whisper",
        "models": list(DEFAULT_MODEL_CHAIN),
        "device": device,
        "reason": "",
        "cached_models": [],
    }
    try:
        import faster_whisper  # noqa: F401
    except Exception as exc:  # noqa: BLE001 - ImportError 之外还可能 OSError（DLL 缺）
        info["reason"] = (
            f"未安装 faster-whisper（{type(exc).__name__}: {exc}）；"
            "执行 `python -m pip install faster-whisper` 后可用"
        )
        return info
    about = getattr(faster_whisper, "__version__", "?")
    info["version"] = about
    try:
        find_ffmpeg()
    except FfmpegUnavailable as exc:
        info["reason"] = f"缺少 ffmpeg，无法从视频抽出音轨：{exc.message}"
        return info
    info["available"] = True
    info["cached_models"] = cached_models()
    if info["cached_models"]:
        info["reason"] = (
            f"就绪（{about}，{device}，int8）；已缓存模型：{', '.join(info['cached_models'])}"
        )
    else:
        info["reason"] = (
            f"就绪（{about}，{device}，int8），但本地无缓存模型，"
            "首次转写需联网下载（tiny≈75MB）"
        )
    return info


# ── 分段 ────────────────────────────────────────────────────────────────
@dataclass
class AudioChunk:
    """一个待转写的音频块（时间单位毫秒，相对**整段音频**）。"""

    index: int
    start_ms: int
    end_ms: int
    path: str = ""
    #: 词级时间戳（``word_timestamps=True`` 时由 :func:`_consume` 填）
    words: list[dict] = field(default_factory=list)

    @property
    def duration_ms(self) -> int:
        return max(0, self.end_ms - self.start_ms)

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "path": self.path,
        }


def plan_chunks(duration_ms: int, chunk_ms: int = DEFAULT_CHUNK_MS) -> list[AudioChunk]:
    """把整段音频切成等长块（**最后一块按剩余长度，不产出空块**）。

    整除时不产生尾部空块（``plan_chunks(600000, 600000)`` 只有 1 块）。
    """
    if duration_ms <= 0:
        # 时长未知（如裸流）：整段当一块，交给 ASR 自己判断
        return [AudioChunk(index=0, start_ms=0, end_ms=max(0, duration_ms))]
    if chunk_ms <= 0:
        raise ValueError("chunk_ms 必须为正数")
    out: list[AudioChunk] = []
    start = 0
    while start < duration_ms:
        end = min(start + chunk_ms, duration_ms)
        out.append(AudioChunk(index=len(out), start_ms=start, end_ms=end))
        start = end
    return out


def split_audio(
    audio_path: str,
    chunks: Sequence[AudioChunk],
    work_dir: str,
    *,
    sample_rate: int = 16000,
    ffmpeg: str | None = None,
    on_progress: Callable[[float, str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> list[AudioChunk]:
    """用 ffmpeg 把长音频切成块文件（重采样成 WAV，避免 ASR 再解容器）。

    已存在且非空的块文件**直接复用**（断点续跑的第二层保护）。
    """
    os.makedirs(work_dir, exist_ok=True)
    total = sum(c.duration_ms for c in chunks) or 1
    done = 0
    out: list[AudioChunk] = []
    for chunk in chunks:
        dst = os.path.join(work_dir, f"chunk_{chunk.index:05d}.wav")
        chunk.path = dst
        if os.path.isfile(dst) and os.path.getsize(dst) > 44:
            out.append(chunk)
            done += chunk.duration_ms
            continue
        args = [
            "-y",
            "-ss",
            f"{chunk.start_ms / 1000:.3f}",
            "-t",
            f"{chunk.duration_ms / 1000:.3f}",
            "-i",
            audio_path,
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "-c:a",
            "pcm_s16le",
            dst,
        ]
        rc, stderr = run_ffmpeg_streaming(
            args,
            total_ms=chunk.duration_ms,
            on_progress=(
                None
                if on_progress is None
                else lambda frac, stage, _d=done: on_progress(  # type: ignore[misc]
                    min(0.999, (_d + frac * chunk.duration_ms) / total), stage
                )
            ),
            stage="切分音频",
            ffmpeg=ffmpeg,
            should_cancel=should_cancel,
            cancel_exc=JobCancelled,
        )
        if rc != 0 or not os.path.isfile(dst):
            raise AsrUnavailable(
                f"切分音频第 {chunk.index} 块失败",
                detail=stderr_tail(stderr, 6),
                code="E_ASR_CHUNK",
            )
        done += chunk.duration_ms
        out.append(chunk)
    return out


# ── 断点 ────────────────────────────────────────────────────────────────
@dataclass
class AsrCheckpoint:
    """转写断点（落盘 JSON；契约 C4「长任务必须可续」）。

    指纹 = 音频路径 + 字节数 + 时长 + 模型名。任一不一致 → **丢弃重来**
    （宁可重跑，也不把两段不同音频的段拼接成怪物）。
    """

    path: str
    fingerprint: str = ""
    model: str = ""
    lang: str = ""
    duration_ms: int = 0
    done_chunks: list[int] = field(default_factory=list)
    segments: list[dict] = field(default_factory=list)
    words: list[dict] = field(default_factory=list)
    started_at: int = 0
    updated_at: int = 0

    def to_dict(self) -> dict:
        return {
            "version": CKPT_VERSION,
            "fingerprint": self.fingerprint,
            "model": self.model,
            "lang": self.lang,
            "duration_ms": self.duration_ms,
            "done_chunks": self.done_chunks,
            "segments": self.segments,
            "words": self.words,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
        }

    def save(self) -> None:
        """原子写（临时文件 + ``os.replace``）：**中断不会留下半截 JSON**。

        错误写法（曾用）：直接 ``open(path,"w")`` 写 →
        在 Windows 上被 kill 时留下截断的 JSON，续跑时 ``json.load`` 全崩。
        """
        self.updated_at = int(time.time() * 1000)
        tmp = f"{self.path}.tmp"
        os.makedirs(os.path.dirname(os.path.abspath(self.path)) or ".", exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.to_dict(), fh, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.path)

    @classmethod
    def load(cls, path: str, fingerprint: str) -> "AsrCheckpoint | None":
        """读断点；文件不存在/版本不符/指纹不符 → ``None``（静默重跑并记日志）。"""
        ckpt = cls(path=path)
        if not os.path.isfile(path):
            return None
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("断点文件损坏，忽略并重跑：%s（%s）", path, exc)
            return None
        if int(data.get("version", 0)) != CKPT_VERSION:
            log.warning("断点版本不符（%s ≠ %s），忽略：%s", data.get("version"), CKPT_VERSION, path)
            return None
        if data.get("fingerprint") != fingerprint:
            log.warning("断点指纹不符（音频/模型变了），忽略：%s", path)
            return None
        ckpt.fingerprint = data.get("fingerprint", "")
        ckpt.model = data.get("model", "")
        ckpt.lang = data.get("lang", "")
        ckpt.duration_ms = int(data.get("duration_ms", 0))
        ckpt.done_chunks = [int(x) for x in data.get("done_chunks", [])]
        ckpt.segments = list(data.get("segments", []))
        ckpt.words = list(data.get("words", []))
        ckpt.started_at = int(data.get("started_at", 0))
        ckpt.updated_at = int(data.get("updated_at", 0))
        return ckpt


def audio_fingerprint(audio_path: str, model: str, duration_ms: int = 0) -> str:
    try:
        size = os.path.getsize(audio_path)
    except OSError:
        size = -1
    return f"{os.path.abspath(audio_path)}|{size}|{duration_ms}|{model}"


# ── 段拼接 ──────────────────────────────────────────────────────────────
def stitch_segments(
    raw: Iterable[VideoSegment], duration_ms: int | None = None
) -> list[VideoSegment]:
    """把带偏移的各块段拼成**单调不重叠**的整段序列（并在最后重编 ``i``）。

    块边界处 whisper 会重复上一句的尾巴 → 这里把 ``start`` 顶到上一条的 ``end``；
    若整条被吃光（``end <= start``）则**丢弃**（它是重复内容，不是新内容）。

    ``duration_ms`` 给定时会**裁到片长**：whisper 末段常overshoot 几百毫秒，
    不裁的话分章"覆盖全片不越界"当场就不成立（实测过）。
    """
    out: list[VideoSegment] = []
    prev_end = 0
    for seg in raw:
        text = (seg.text or "").strip()
        if not text:
            continue
        start = max(0, int(seg.start))
        end = max(start, int(seg.end))
        if duration_ms is not None and duration_ms > 0:
            if start >= duration_ms:
                continue  # 整条在片尾之外（whisper 的补齐幻觉）
            end = min(end, duration_ms)
        if out and start < prev_end:
            start = prev_end
        if out and end <= start:
            continue  # 整条落在上一条内部 → 重复，丢
        if end <= start:
            end = start + 1
        out.append(
            VideoSegment(
                i=len(out),
                start=start,
                end=end,
                text=text,
                confidence=float(seg.confidence or 0.0),
            )
        )
        prev_end = out[-1].end
    return out


def segments_duration_ms(segments: Sequence[VideoSegment]) -> int:
    return max((int(s.end) for s in segments), default=0)


# ── 模型加载 ────────────────────────────────────────────────────────────
def _load_whisper_model(
    name: str,
    *,
    device: str = "cpu",
    compute_type: str | None = None,
    download_root: str | None = None,
):
    """加载模型；``compute_type`` 与模型名都按链降级。返回 ``(model, name, compute_type)``。

    :raises AsrDependencyMissing: 包没装
    :raises AsrUnavailable: 所有候选都加载失败（附每个候选的真实报错）
    """
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        raise AsrDependencyMissing(
            "未安装 faster-whisper",
            detail=f"python -m pip install faster-whisper（{type(exc).__name__}: {exc}）",
        ) from exc

    root = download_root or os.environ.get("COURSE_KB_MODEL_DIR") or None
    if name not in cached_models() and not root:
        log.warning(
            "模型 %s 本地无缓存，将从 HuggingFace 下载；若卡住请先设 "
            "HF_ENDPOINT=https://hf-mirror.com（必须在 import faster_whisper **之前**设置），"
            "或用 COURSE_KB_MODEL_DIR 指定已下好的模型目录。",
            name,
        )
    compute_chain: list[str] = (
        [compute_type] if compute_type else list(_COMPUTE_CHAIN)
    )
    failures: list[str] = []
    for ctype in compute_chain:
        try:
            model = WhisperModel(name, device=device, compute_type=ctype, download_root=root)
            return model, name, ctype
        except Exception as exc:  # noqa: BLE001 - 磁盘/网络/不支持的计算类型都在这
            failures.append(f"{name}/{ctype}: {type(exc).__name__}: {exc}")
            log.warning("加载 %s（%s）失败：%s", name, ctype, exc)
    raise AsrUnavailable(
        f"ASR 模型 {name} 加载失败（{device}）",
        detail=(
            "候选全部失败：\n  "
            + "\n  ".join(failures)
            + "\n提示：首次使用需要联网下载模型（本机实测 tiny 已缓存、base 下载会卡在 2.5MB）；"
            "离线或下载不稳时：① 设 HF_ENDPOINT=https://hf-mirror.com（须在 import faster_whisper 之前）；"
            "② 或把已下好的模型目录交给 COURSE_KB_MODEL_DIR；"
            "③ 或改用请求模型链里已缓存的更小模型。"
        ),
    )


def load_model_with_fallback(
    model: str,
    *,
    device: str = "cpu",
    compute_type: str | None = None,
    download_root: str | None = None,
    chain: Sequence[str] = DEFAULT_MODEL_CHAIN,
):
    """按 ``请求模型 → 降级链`` 顺序加载，返回 ``(model, 实际型号, compute_type)``。"""
    order = [model] + [m for m in chain if m != model]
    failures: list[str] = []
    for name in order:
        try:
            return (*_load_whisper_model(
                name,
                device=device,
                compute_type=compute_type,
                download_root=download_root,
            ),)
        except AsrDependencyMissing:
            raise
        except AsrUnavailable as exc:
            failures.append(exc.detail)
    raise AsrUnavailable(
        f"没有任何可用 ASR 模型（尝试过：{', '.join(order)}）",
        detail="\n".join(failures),
    )


# ── 转写 ────────────────────────────────────────────────────────────────
@dataclass
class AsrResult:
    """一次转写的完整结果。"""

    model: str
    lang: str
    lang_probability: float
    duration_ms: int
    segments: list[VideoSegment]
    device: str = "cpu"
    compute_type: str = ""
    words: list[dict] = field(default_factory=list)
    chunks_total: int = 0
    chunks_done: int = 0
    chunks_resumed: int = 0
    elapsed_ms: int = 0

    def to_dict(self) -> dict:
        return {
            "model": self.model,
            "lang": self.lang,
            "lang_probability": self.lang_probability,
            "duration_ms": self.duration_ms,
            "segments": [s.to_dict() for s in self.segments],
            "device": self.device,
            "compute_type": self.compute_type,
            "chunks_total": self.chunks_total,
            "chunks_done": self.chunks_done,
            "chunks_resumed": self.chunks_resumed,
            "elapsed_ms": self.elapsed_ms,
        }


#: 注入式转写函数签名：``(chunk_index, chunk) -> (segments, lang, lang_prob)``
TranscribeFn = Callable[[int, AudioChunk], "tuple[list[VideoSegment], str, float]"]


def read_wav_as_float32(path: str) -> "Any":
    """16-bit PCM 单声道 WAV → ``float32`` 数组，取值范围 [-1, 1]。

    ## ⚠️ 坑 17（本机实测，必须记下来）

    **不能把文件路径直接传给 ``model.transcribe()``。**

    错误写法（曾用，必然崩）::

        model.transcribe(chunk.path, ...)

    报错::

        faster_whisper/audio.py:46
        with av.open(input_file, mode="r", metadata_errors="ignore") as container:
        TypeError: open() got an unexpected keyword argument 'metadata_errors'

    根因不是我们的代码：``faster-whisper 1.2.1`` 调用了 PyAV 的 ``metadata_errors`` 参数，
    而本机 ``PyAV 19.0.1`` **不支持**该参数 → 只要走"路径 → PyAV 解码"这条路就必炸。

    **解法（比升级依赖更稳）**：传 **numpy float32 数组** → 完全跳过 PyAV 解码路径。
    反正我们的管线本来就先用 ffmpeg 转成了 16k/mono/PCM WAV，直接用标准库 ``wave`` 读即可。
    """
    import numpy as np

    with wave.open(path, "rb") as w:
        assert w.getsampwidth() == 2, f"期望 16-bit PCM，实际 {w.getsampwidth() * 8}-bit"
        assert w.getnchannels() == 1, f"期望单声道，实际 {w.getnchannels()} 声道"
        frames = w.readframes(w.getnframes())
    if not frames:
        return np.zeros(0, dtype=np.float32)
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def _whisper_transcribe_chunk(
    model,
    lang: str | None,
    *,
    vad_filter: bool,
    word_timestamps: bool,
    beam_size: int,
    initial_prompt: str | None = None,
):
    """构造一个真实转写闭包（挂在 ``model`` 上，逐块调用）。

    ★ 传的是 **numpy 数组**而不是路径（坑 17，见 :func:`read_wav_as_float32`）。
    """

    state: dict[str, Any] = {"lang": lang or "", "lang_prob": 0.0}

    def run(chunk_index: int, chunk: AudioChunk) -> tuple[list[VideoSegment], str, float]:
        kwargs: dict[str, Any] = {
            "beam_size": beam_size,
            "word_timestamps": word_timestamps,
            "vad_filter": vad_filter,
            "condition_on_previous_text": False,  # 分块转写：不要跨块继承上下文
        }
        if state["lang"]:
            kwargs["language"] = state["lang"]
        if initial_prompt:
            kwargs["initial_prompt"] = initial_prompt
        samples = read_wav_as_float32(chunk.path)  # ★ 数组，不是路径
        if samples.size == 0:
            raise AsrUnavailable(
                f"第 {chunk_index} 块音频为空（0 采样）",
                detail=f"{chunk.path} 没有可解码的采样；块切分可能失败。",
                code="E_ASR_NO_AUDIO",
            )
        try:
            seg_iter, info = model.transcribe(samples, **kwargs)
            segs, words = _consume(seg_iter)
        except Exception as exc:  # noqa: BLE001
            if not vad_filter:
                raise
            # VAD 模型下载失败（onnxruntime/silero）→ 关掉 VAD 重试，而不是整单失败
            log.warning("VAD 失败，改为不用 VAD 重试：%s", exc)
            kwargs["vad_filter"] = False
            seg_iter, info = model.transcribe(samples, **kwargs)
            segs, words = _consume(seg_iter)
        if not state["lang"]:
            state["lang"] = getattr(info, "language", "") or "und"
            state["lang_prob"] = float(getattr(info, "language_probability", 0.0) or 0.0)
        chunk.words = words
        return segs, state["lang"], state["lang_prob"]

    return run


def _consume(seg_iter) -> tuple[list[VideoSegment], list[dict]]:
    """消费 whisper 的生成器 → 段（**块内相对时间**）+ 词级时间戳。

    ⚠️ 这里**不加块偏移**：偏移由 :func:`transcribe_audio` 统一加。
    原因：偏移只加在一处，注入式后端（测试）与真 whisper 才会走同一条逻辑；
    曾经把偏移写在 ``_consume`` 里，结果注入后端返回的段**没有偏移**，
    "第 2 块"的段落在时间轴开头，拼接后全乱。
    """
    segs: list[VideoSegment] = []
    words: list[dict] = []
    for seg in seg_iter:
        text = (getattr(seg, "text", "") or "").strip()
        if not text:
            continue
        start = int(round(float(getattr(seg, "start", 0.0)) * 1000))
        end = int(round(float(getattr(seg, "end", 0.0)) * 1000))
        avg_logprob = getattr(seg, "avg_logprob", None)
        # whisper 给的是 log 概率；exp 后就是几何平均概率，映射到 [0,1] 直观值
        conf = 0.0
        if avg_logprob is not None:
            try:
                conf = max(0.0, min(1.0, float(2.718281828459045 ** float(avg_logprob))))
            except (OverflowError, ValueError):
                conf = 0.0
        segs.append(
            VideoSegment(i=len(segs), start=start, end=max(start, end), text=text, confidence=conf)
        )
        for w in getattr(seg, "words", None) or []:
            wtext = (getattr(w, "word", "") or "").strip()
            if not wtext:
                continue
            words.append(
                {
                    "w": wtext,
                    "start": int(round(float(getattr(w, "start", 0.0)) * 1000)),
                    "end": int(round(float(getattr(w, "end", 0.0)) * 1000)),
                }
            )
    return segs, words


def shift_to_absolute(
    segments: Sequence[VideoSegment], words: Sequence[dict], offset_ms: int
) -> tuple[list[VideoSegment], list[dict]]:
    """块内相对时间 + 块偏移 → 全片绝对时间（唯一加偏移的地方）。"""
    if offset_ms == 0:
        return list(segments), list(words)
    shifted = [
        VideoSegment(
            i=s.i,
            start=int(s.start) + offset_ms,
            end=int(s.end) + offset_ms,
            text=s.text,
            confidence=s.confidence,
        )
        for s in segments
    ]
    shifted_words = [
        {**w, "start": int(w["start"]) + offset_ms, "end": int(w["end"]) + offset_ms} for w in words
    ]
    return shifted, shifted_words


def transcribe_audio(
    audio_path: str,
    *,
    model: str = "tiny",
    lang: str | None = None,
    duration_ms: int | None = None,
    work_dir: str | None = None,
    ckpt_path: str | None = None,
    chunk_ms: int = DEFAULT_CHUNK_MS,
    resume: bool = True,
    model_chain: Sequence[str] = DEFAULT_MODEL_CHAIN,
    device: str = "cpu",
    compute_type: str | None = None,
    download_root: str | None = None,
    vad_filter: bool = True,
    word_timestamps: bool = True,
    beam_size: int = 1,
    initial_prompt: str | None = None,
    transcribe_fn: TranscribeFn | None = None,
    on_progress: Callable[[float, str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> AsrResult:
    """转写整段音频（**分段 + 断点**）。

    :param transcribe_fn: 注入式后端（测试用；给定则不加载模型）
    :param ckpt_path: 断点文件；默认 ``<work_dir>/asr.ckpt.json``
    :param resume: 为真且有可用断点时跳过已完成块
    :raises AsrUnavailable: 包缺失 / 模型加载失败 / 没识别出任何语音
    :raises JobCancelled: 取消（**断点已保存**，可直接续）
    """
    if not os.path.isfile(audio_path):
        raise AsrUnavailable(f"音频文件不存在：{audio_path}", code="E_ASR_NO_AUDIO")
    if duration_ms is None or duration_ms <= 0:
        duration_ms = wav_duration_ms(audio_path)
    if duration_ms <= 0:
        raise AsrUnavailable(
            "音频时长为 0，无法转写（空音轨）",
            detail="源视频可能是静音的，或抽取音频时被截断。",
            code="E_ASR_NO_AUDIO",
        )

    work_dir = work_dir or os.path.join(os.path.dirname(os.path.abspath(audio_path)), "asr")
    os.makedirs(work_dir, exist_ok=True)
    ckpt_path = ckpt_path or os.path.join(work_dir, "asr.ckpt.json")

    started = time.time()
    chunks = plan_chunks(duration_ms, chunk_ms)

    # ── 断点 ──
    ckpt: AsrCheckpoint | None = None
    fingerprint = audio_fingerprint(audio_path, model, duration_ms)
    if resume:
        ckpt = AsrCheckpoint.load(ckpt_path, fingerprint)
    if ckpt is None:
        ckpt = AsrCheckpoint(
            path=ckpt_path,
            fingerprint=fingerprint,
            model=model,
            lang=lang or "",
            duration_ms=duration_ms,
            started_at=int(time.time() * 1000),
        )
    resumed = len(ckpt.done_chunks)

    # 已完成块的段已经在断点里：先按块过滤出"未完成"的
    done_set = set(ckpt.done_chunks)
    pending = [c for c in chunks if c.index not in done_set]
    segs_all: list[VideoSegment] = [VideoSegment.from_dict(d) for d in ckpt.segments]
    words_all: list[dict] = list(ckpt.words)

    if not pending:
        final = stitch_segments(segs_all, duration_ms)
        if not final:
            raise AsrUnavailable(
                "断点显示已全部转写，但没有任何段落",
                detail="断点文件可能损坏；删除 asr.ckpt.json 后重跑。",
                code="E_ASR_EMPTY",
            )
        return AsrResult(
            model=ckpt.model or model,
            lang=ckpt.lang or (lang or ""),
            lang_probability=0.0,
            duration_ms=duration_ms,
            segments=final,
            compute_type="(cached)",
            words=words_all,
            chunks_total=len(chunks),
            chunks_done=len(done_set),
            chunks_resumed=resumed,
            elapsed_ms=int((time.time() - started) * 1000),
        )

    pending = split_audio(
        audio_path,
        pending,
        work_dir,
        ffmpeg=None,
        on_progress=(
            None
            if on_progress is None
            else lambda frac, stage: on_progress(0.15 * frac, stage)
        ),
        should_cancel=should_cancel,
    )

    # ── 后端 ──
    if transcribe_fn is not None:
        run_chunk = transcribe_fn
        used_model, used_ctype, load_ms = model, "(injected)", 0
        detected_lang, detected_prob = lang or "", 0.0
    else:
        t0 = time.time()
        whisper, used_model, used_ctype = load_model_with_fallback(
            model,
            device=device,
            compute_type=compute_type,
            download_root=download_root,
            chain=model_chain,
        )
        load_ms = int((time.time() - t0) * 1000)
        bk = _whisper_transcribe_chunk(
            whisper,
            lang,
            vad_filter=vad_filter,
            word_timestamps=word_timestamps,
            beam_size=beam_size,
            initial_prompt=initial_prompt,
        )
        detected_lang, detected_prob = lang or "", 0.0

        def run_chunk(idx: int, chunk: AudioChunk):  # type: ignore[misc]
            nonlocal detected_lang, detected_prob
            segs, lg, lp = bk(idx, chunk)
            detected_lang, detected_prob = lg, lp
            return segs, lg, lp

    # 断点里记下实际用的模型（续跑时能看出模型换了没有）
    ckpt.model = used_model
    done_ms = sum(c.duration_ms for c in chunks if c.index in done_set)
    total_ms = sum(c.duration_ms for c in chunks) or 1

    for chunk in pending:
        if should_cancel is not None and should_cancel():
            ckpt.save()
            raise JobCancelled("转写被取消（断点已保存）", code="E_CANCELLED")
        try:
            chunk_segs, lg, lp = run_chunk(chunk.index, chunk)
        except JobCancelled:
            ckpt.save()
            raise
        except AsrUnavailable:
            ckpt.save()
            raise
        except Exception as exc:  # noqa: BLE001
            # 块级失败：**先存断点再抛**，让"中断可续"成立
            ckpt.save()
            raise AsrUnavailable(
                f"转写第 {chunk.index} 块失败：{type(exc).__name__}: {exc}",
                detail=(
                    f"块 {chunk.index} [{chunk.start_ms}..{chunk.end_ms}]ms；"
                    f"已完成块 {len(ckpt.done_chunks)}/{len(chunks)}，重跑可从此处续。"
                ),
                code="E_ASR_RUN",
            ) from exc
        if lg:
            detected_lang, detected_prob = lg, lp
        # ★ 块内相对时间 → 全片绝对时间（唯一加偏移的地方，见 shift_to_absolute）
        abs_segs, abs_words = shift_to_absolute(chunk_segs, getattr(chunk, "words", []) or [], chunk.start_ms)
        segs_all.extend(abs_segs)
        words_all.extend(abs_words)
        ckpt.done_chunks = sorted(set([*ckpt.done_chunks, chunk.index]))
        ckpt.segments = [s.to_dict() for s in stitch_segments(segs_all, duration_ms)]
        ckpt.words = words_all
        ckpt.lang = detected_lang or ckpt.lang
        ckpt.save()  # ★ 每块落盘（契约 C4）
        done_ms += chunk.duration_ms
        if on_progress is not None:
            _safe(on_progress, 0.15 + 0.85 * min(1.0, done_ms / total_ms), "语音转写")

    final = stitch_segments(segs_all)
    if not final:
        # 坑 10：**绝不产出空字幕**。识别不到语音就如实报不可用。
        raise AsrUnavailable(
            "音频里没有识别出任何语音（0 段）",
            detail=(
                f"已跑完全部 {len(chunks)} 块（{duration_ms}ms，模型 {used_model}）。"
                "可能是纯音乐/静音视频，或音轨损坏。"
                "此时**不产出字幕与文稿**；播放器、时间轴、幻灯片帧仍可用。"
            ),
            code="E_ASR_EMPTY",
        )
    return AsrResult(
        model=used_model,
        lang=detected_lang or (lang or ""),
        lang_probability=detected_prob,
        duration_ms=duration_ms,
        segments=final,
        device=device,
        compute_type=used_ctype,
        words=words_all,
        chunks_total=len(chunks),
        chunks_done=len(ckpt.done_chunks),
        chunks_resumed=resumed,
        elapsed_ms=int((time.time() - started) * 1000),
    )


def _safe(cb: Callable[[float, str], None], frac: float, stage: str) -> None:
    try:
        cb(max(0.0, min(1.0, frac)), stage)
    except Exception:  # noqa: BLE001
        pass


__all__ = [
    "AsrResult",
    "AsrCheckpoint",
    "AudioChunk",
    "DEFAULT_CHUNK_MS",
    "DEFAULT_MODEL_CHAIN",
    "CKPT_VERSION",
    "asr_capability",
    "cached_models",
    "plan_chunks",
    "split_audio",
    "audio_fingerprint",
    "stitch_segments",
    "shift_to_absolute",
    "segments_duration_ms",
    "load_model_with_fallback",
    "transcribe_audio",
]
