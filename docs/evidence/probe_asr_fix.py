# -*- coding: utf-8 -*-
"""验证 ASR 绕过方案：直接把 numpy 数组喂给 faster-whisper，绕开 PyAV。

## 根因（已诊断）
faster-whisper 1.2.1 的 audio.py:46 调用：
    av.open(input_file, mode="r", metadata_errors="ignore")
而本机 PyAV 19.0.1 的 open() **不接受 metadata_errors** → TypeError

## 绕过方案（更优，非权宜）
传**文件路径**时 faster-whisper 会走 PyAV 解码；
传 **numpy float32 数组**时直接跳过解码环节（transcribe.py 里 decode_audio 不会被调用）。

而我们的管线**本来就要先用 ffmpeg 转 16kHz 单声道 PCM WAV**，所以：
    ffmpeg → 16k WAV → Python 内置 wave 模块读 → numpy float32 → transcribe()
**完全不依赖 PyAV**，还省一次解码。这是比"升级 av"更稳的做法（不引入依赖变更风险）。

## 本脚本验证
1. numpy 路径能否真转写（tiny，已缓存）
2. 顺带记录耗时，作为 T2 的性能基线
"""
import os
import subprocess
import sys
import tempfile
import time
import wave

import numpy as np

def p(*a):
    print(*a); sys.stdout.flush()

def read_wav_as_float32(path: str) -> np.ndarray:
    """用 Python 内置 wave 读 16-bit PCM WAV → float32 [-1,1]。

    只依赖标准库 + numpy，**不碰 PyAV**。
    """
    with wave.open(path, "rb") as w:
        assert w.getsampwidth() == 2, f"期望 16-bit，实际 {w.getsampwidth()*8}-bit"
        assert w.getnchannels() == 1, f"期望单声道，实际 {w.getnchannels()} 声道"
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0

p("=" * 74)
p("一、先用 ffmpeg 做 16kHz 单声道 WAV（管线本来的第一步）")
p("=" * 74)
tmp = tempfile.mkdtemp(prefix="asrfix_")
mp3 = os.path.join(tmp, "in.mp3")
wav = os.path.join(tmp, "out.wav")

# 合成一段有节奏变化的音频（纯正弦转写结果为空，无法验证文字输出；
# 但能验证**整条链路不报错**，这才是本次要证的）
r = subprocess.run(["ffmpeg", "-y", "-f", "lavfi",
                    "-i", "sine=frequency=440:duration=5",
                    "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", mp3],
                   capture_output=True, timeout=90)
p(f"  合成 mp3: rc={r.returncode}  {os.path.getsize(mp3) if os.path.exists(mp3) else 0} bytes")

r = subprocess.run(["ffmpeg", "-y", "-i", mp3, "-vn", "-ac", "1", "-ar", "16000",
                    "-c:a", "pcm_s16le", wav], capture_output=True, timeout=90)
p(f"  转 16k wav: rc={r.returncode}  {os.path.getsize(wav) if os.path.exists(wav) else 0} bytes")

p("")
p("=" * 74)
p("二、用内置 wave 读成 numpy float32（绕开 PyAV）")
p("=" * 74)
t0 = time.time()
audio = read_wav_as_float32(wav)
p(f"  ✅ 读取成功  shape={audio.shape}  dtype={audio.dtype}  "
  f"时长={len(audio)/16000:.2f}s  ({time.time()-t0:.3f}s)")
p(f"  幅值范围 [{audio.min():.3f}, {audio.max():.3f}]")

p("")
p("=" * 74)
p("三、把 numpy 数组喂给 faster-whisper（关键验证）")
p("=" * 74)
from faster_whisper import WhisperModel

t0 = time.time()
model = WhisperModel("tiny", device="cpu", compute_type="int8")
load_s = time.time() - t0
p(f"  模型加载: tiny  {load_s:.2f}s")

t0 = time.time()
try:
    segs, info = model.transcribe(audio, language="zh", word_timestamps=True)
    segs = list(segs)
    el = time.time() - t0
    p(f"  ✅✅ **转写成功**，未走 PyAV，无 TypeError")
    p(f"     段数={len(segs)}  耗时={el:.2f}s  "
      f"实时率={len(audio)/16000/el:.1f}x（越大越快）")
    p(f"     language={info.language}  duration={info.duration:.2f}s")
    for s in segs[:3]:
        p(f"       [{s.start:.2f}-{s.end:.2f}] {s.text[:60]!r}")
    if segs and segs[0].words:
        w0 = segs[0].words[0]
        p(f"     词级时间戳可用：{len(segs[0].words)} 个词，例 {w0.word!r}@{w0.start:.2f}s")
    p("")
    p("  ⟹ 结论：**numpy 路径可用**，ASR 不需要 PyAV，也不需要改依赖")
    ok = True
except Exception as e:
    import traceback
    p(f"  ✗ numpy 路径也失败: {type(e).__name__}: {e}")
    for line in traceback.format_exc().splitlines()[-6:]:
        p("    " + line)
    ok = False

p("")
p("=" * 74)
p("四、对照：文件路径（走 PyAV）仍失败吗？")
p("=" * 74)
try:
    model.transcribe(wav, language="zh")
    p("  文件路径也能用（说明 av 问题不存在？）")
except TypeError as e:
    p(f"  ✗ 文件路径仍失败（预期）：{e}")
    p("  ⟹ 证实：**必须传 numpy 数组**，不能传路径")
except Exception as e:
    p(f"  其他错误: {type(e).__name__}: {e}")

p("")
p("=" * 74)
p("结论（给 T2）")
p("=" * 74)
p("""  1. 根因：PyAV 19.0.1 与 faster-whisper 1.2.1 不兼容（metadata_errors 参数）
  2. 解法：**传 numpy float32 数组**，不要传文件路径 → 跳过 PyAV 解码
     ffmpeg(16k mono PCM) → wave 模块读 → float32 → transcribe()
  3. 额外收益：少一次解码；ffmpeg 参数由我们完全掌控
  4. 依赖无需变更（不动 av / faster-whisper 版本）
  5. tiny 已缓存可直接用；base/small 需联网下载（HF 下载慢，有 .incomplete 卡住现象）
""")
sys.exit(0 if ok else 1)
