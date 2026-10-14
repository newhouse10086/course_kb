"""合成测试媒体（**不依赖任何外部素材**）。

测试与验收都要求"用 ffmpeg 合成一个测试视频"，这个模块就是那件事的实现。
它同时也是一个可用的自检工具：

```powershell
# 生成一段 12 秒 4 色切换 + 正弦音轨的视频
python -m worker.video.synth --out data/tmp/cuts.mp4 --colors red green blue white

# 生成一段带文字的帧（用来验证 OCR）
python -m worker.video.synth --out data/tmp/text.mp4 --text "Index B+Tree 42"

# 用 Windows SAPI 合成中文语音（给 ASR 端到端测试用，无需麦克风/外部音频）
python -m worker.video.synth --out data/tmp/speech.wav --speech "今天我们讲数据库索引"
```

⚠️ 合成素材的**已知确定性**（本机实测 N-124868，测试依赖这些值）：

* ``colors=synth.DEFAULT_COLORS``（red/green/blue/white）、每色 3 秒、``fps=10``、
  带 drawtext → 场景检测（阈值 0.4）**恰好 1 帧 @ 9000ms**
  （红→绿得分 **0.3988**，**刚好低于 0.4** —— 这个数字说明阈值不是随便定的）
* ``colors=synth.SCENE_COLORS``（black/white 交替）→ **恰好 3 帧** @ **3000/6000/9000ms**
  （黑白满对比度，每次得分 1.0）
* 单色视频场景检测 **0 帧** → 走等间隔兜底，得 1 帧 @ 0ms
* ``text="Index B+Tree 42"`` 时 drawtext 能把字画进画面，本机 rapidocr 可识别
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys

from .errors import FfmpegUnavailable, MediaProbeError
from .ffmpeg_util import find_ffmpeg, stderr_tail

#: 默认 4 色
DEFAULT_COLORS: tuple[str, ...] = ("red", "green", "blue", "white")

#: 场景检测测试专用：黑白交替 → **满对比度切换**，本机实测每次得分 1.0
#: （默认配色里"红→绿"只有 0.3988，刚好**卡在 0.4 阈值下面**，
#: 所以想稳定验证"场景检测抽到 N 帧"时请用这组颜色）
SCENE_COLORS: tuple[str, ...] = ("black", "white", "black", "white")


def _run(args: list[str]) -> subprocess.CompletedProcess:
    proc = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise MediaProbeError(
            "ffmpeg 合成素材失败",
            detail=stderr_tail(proc.stderr, 8),
            code="E_SYNTH",
        )
    return proc


def synth_video(
    path: str,
    *,
    duration_ms: int = 12_000,
    colors: tuple[str, ...] = DEFAULT_COLORS,
    width: int = 320,
    height: int = 240,
    fps: int = 10,
    tone_hz: int = 440,
    sample_rate: int = 16000,
    text: str = "",
) -> str:
    """合成"颜色切换 + 正弦音轨"的测试视频（h264 + aac）。

    :param colors: 依次出现的纯色（**颜色数量 = 画面切段数**）
    :param text: 非空时给每段画面叠一行文字（供 OCR 测试；本机 rapidocr 实测可识别）
    """
    ff = find_ffmpeg()
    colors = tuple(colors) or DEFAULT_COLORS
    n = len(colors)
    seg_ms = max(1, duration_ms // n)
    args: list[str] = [ff, "-y", "-hide_banner", "-loglevel", "error"]
    for color in colors:
        args += [
            "-f",
            "lavfi",
            "-i",
            f"color=c={color}:s={width}x{height}:d={seg_ms / 1000.0:.3f}:r={fps},format=yuv420p",
        ]
    args += [
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency={tone_hz}:sample_rate={sample_rate}:duration={n * seg_ms / 1000.0:.3f}",
    ]
    chain = []
    for i, color in enumerate(colors):
        label = f"{text} {i + 1}" if text else f"{color} {i + 1}"
        chain.append(
            f"[{i}:v]drawtext=text='{_esc(label)}':fontsize=28:fontcolor=black:x=20:y=100[v{i}]"
        )
    chain.append("".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[vout]")
    args += [
        "-filter_complex",
        ";".join(chain),
        "-map",
        "[vout]",
        "-map",
        f"{n}:a",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        path,
    ]
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    _run(args)
    return path


def synth_audio(
    path: str, *, duration_ms: int = 12_000, tone_hz: int = 440, sample_rate: int = 16000
) -> str:
    """合成一段 WAV（正弦音；给"没有视频流的音频"路径用）。"""
    ff = find_ffmpeg()
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    _run(
        [
            ff,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={tone_hz}:sample_rate={sample_rate}:duration={duration_ms / 1000.0:.3f}",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            path,
        ]
    )
    return path


def synth_silent_video(path: str, *, duration_ms: int = 6000, color: str = "gray") -> str:
    """合成**没有音轨**的视频（验证"抽音频必须如实失败"）。"""
    ff = find_ffmpeg()
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    _run(
        [
            ff,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=c={color}:s=320x240:d={duration_ms / 1000.0:.3f}:r=10",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-an",
            path,
        ]
    )
    return path


#: Windows SAPI 语音（本机实测可用：zh-CN Microsoft Huihui Desktop）
SAPI_VOICES: tuple[str, ...] = ("Microsoft Huihui Desktop", "Microsoft Zira Desktop")


def synth_speech_wav(path: str, text: str, *, voice: str = "") -> str:
    """用 Windows SAPI 合成**真人语音波形**（离线、无需外部素材）。

    为什么需要它：``testsrc + sine`` 里**没有语音**，whisper 只会输出空或幻觉，
    无法验证"真的转写出了字"。SAPI 是 Windows 自带能力，仍然不依赖外部素材。

    :raises MediaProbeError: 非 Windows / SAPI 不可用
    """
    if sys.platform != "win32":
        raise MediaProbeError("合成语音需要 Windows SAPI", code="E_SYNTH")
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        raise MediaProbeError("找不到 powershell，无法调用 SAPI", code="E_SYNTH")
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    voice_line = f"$s.SelectVoice('{voice}')" if voice else ""
    script = (
        "Add-Type -AssemblyName System.Speech;"
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        f"{voice_line};"
        f"$s.SetOutputToWaveFile('{path}');"
        f"$s.Speak('{text}');"
        "$s.Dispose();"
    )
    proc = subprocess.run(
        [powershell, "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0 or not os.path.isfile(path) or os.path.getsize(path) < 1024:
        raise MediaProbeError(
            f"SAPI 合成语音失败：{stderr_tail(proc.stderr or proc.stdout, 6)}",
            code="E_SYNTH",
        )
    return path


def synth_narrated_video(
    path: str,
    *,
    duration_ms: int = 300_000,
    sentence: str = "今天我们讲数据库索引，B加树是最常用的索引结构，它可以把查询的时间复杂度降到对数级别。",
    colors: tuple[str, ...] = SCENE_COLORS,
    width: int = 320,
    height: int = 240,
    fps: int = 5,
    voice: str = "",
    text: str = "",
) -> str:
    """合成一段**有人声旁白**的长视频（画面用颜色切换，音轨用 SAPI 语音循环）。

    用途：ASR 端到端与验收跑批（真实人声、但**不依赖任何外部素材**）。
    语音比画面短时用 ``-stream_loop -1`` 循环补齐到目标时长。
    """
    ff = find_ffmpeg()
    import tempfile

    with tempfile.TemporaryDirectory(prefix="ck_synth_") as tmp:
        speech = synth_speech_wav(os.path.join(tmp, "speech.wav"), sentence, voice=voice)
        colors = tuple(colors) or SCENE_COLORS
        n = len(colors)
        seg_ms = max(1, duration_ms // n)
        args: list[str] = [ff, "-y", "-hide_banner", "-loglevel", "error"]
        for color in colors:
            args += [
                "-f",
                "lavfi",
                "-i",
                f"color=c={color}:s={width}x{height}:d={seg_ms / 1000.0:.3f}:r={fps},format=yuv420p",
            ]
        args += ["-stream_loop", "-1", "-i", speech]
        chain = [f"[{i}:v]null[v{i}]" for i in range(n)]
        chain.append("".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[vout]")
        args += [
            "-filter_complex",
            ";".join(chain),
            "-map",
            "[vout]",
            "-map",
            f"{n}:a",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-t",
            f"{duration_ms / 1000.0:.3f}",
            path,
        ]
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        _run(args)
    return path


def _esc(text: str) -> str:
    """drawtext 的转义（``:`` 与 ``,`` 会截断参数，反斜杠要转义）。"""
    return (
        str(text)
        .replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace(",", "\\,")
        .replace("'", "")
        .replace("%", "\\%")
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="合成测试媒体（不依赖外部素材）")
    ap.add_argument("--out", required=True)
    ap.add_argument("--duration-ms", type=int, default=12_000)
    ap.add_argument("--colors", nargs="*", default=list(DEFAULT_COLORS))
    ap.add_argument("--text", default="")
    ap.add_argument("--speech", default="", help="用 Windows SAPI 合成这段语音（输出 wav）")
    ap.add_argument("--audio-only", action="store_true")
    ap.add_argument("--no-audio", action="store_true", help="合成没有音轨的视频")
    args = ap.parse_args(argv)
    try:
        if args.speech:
            p = synth_speech_wav(args.out, args.speech)
        elif args.audio_only:
            p = synth_audio(args.out, duration_ms=args.duration_ms)
        elif args.no_audio:
            p = synth_silent_video(args.out, duration_ms=args.duration_ms)
        else:
            p = synth_video(
                args.out,
                duration_ms=args.duration_ms,
                colors=tuple(args.colors),
                text=args.text,
            )
    except FfmpegUnavailable as exc:
        print(f"没有 ffmpeg：{exc.detail}", file=sys.stderr)
        return 2
    print(p)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
