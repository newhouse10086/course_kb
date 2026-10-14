# -*- coding: utf-8 -*-
"""验证 faster-whisper 是否真的可用（T2 的最大风险点）。

实测三个层次：
  1. 能否 import（依赖是否齐）
  2. 能否加载模型（模型文件是否可下载/已缓存）
  3. 能否真转写一段合成音频（端到端）

模型下载走 HuggingFace，可能被墙 —— 这一步必须实测，不能假设。
"""
import os
import subprocess
import sys
import tempfile
import time

def p(*a):
    print(*a); sys.stdout.flush()

p("=" * 72)
p("1. import 检查")
p("=" * 72)
try:
    import faster_whisper
    p(f"  faster_whisper {faster_whisper.__version__} ✅")
except Exception as e:
    p(f"  ✗ import 失败: {type(e).__name__}: {e}")
    sys.exit(1)

try:
    import ctranslate2
    p(f"  ctranslate2 {ctranslate2.__version__} ✅")
except Exception as e:
    p(f"  ⚠️ ctranslate2: {e}")

p("")
p("=" * 72)
p("2. 依赖检查")
p("=" * 72)
for m in ["onnxruntime", "tokenizers", "huggingface_hub", "av", "numpy"]:
    try:
        mod = __import__(m)
        p(f"  {m:18} {getattr(mod, '__version__', 'ok')}")
    except Exception as e:
        p(f"  {m:18} ✗ {type(e).__name__}")

p("")
p("=" * 72)
p("3. 模型缓存检查（避免联网下载）")
p("=" * 72)
hub = os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
p(f"  HF 缓存目录: {hub}")
if os.path.isdir(hub):
    for d in sorted(os.listdir(hub))[:20]:
        if "whisper" in d.lower():
            sz = 0
            for root, _, files in os.walk(os.path.join(hub, d)):
                for f in files:
                    try:
                        sz += os.path.getsize(os.path.join(root, f))
                    except OSError:
                        pass
            p(f"    {d}  ({sz/1024/1024:.1f} MB)")
else:
    p("  （无缓存，首次使用需下载）")

p("")
p("=" * 72)
p("4. 合成测试音频（ffmpeg）")
p("=" * 72)
tmp = tempfile.mkdtemp(prefix="fwtest_")
wav = os.path.join(tmp, "tone.wav")
cmd = ["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
       "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]
r = subprocess.run(cmd, capture_output=True, timeout=60)
p(f"  ffmpeg rc={r.returncode}  {wav}  "
  f"{os.path.getsize(wav) if os.path.exists(wav) else 0} bytes")
if r.returncode != 0:
    p(f"  stderr: {r.stderr[:300]!r}")
    sys.exit(1)

p("")
p("=" * 72)
p("5. 真加载模型 + 真转写（关键：模型能否拿到）")
p("=" * 72)
for model_name in ["tiny", "base"]:
    p(f"  --- 尝试 {model_name} ---")
    t0 = time.time()
    try:
        from faster_whisper import WhisperModel
        m = WhisperModel(model_name, device="cpu", compute_type="int8")
        p(f"      模型加载成功 ✅  ({time.time()-t0:.1f}s)")
        t1 = time.time()
        segs, info = m.transcribe(wav, language="zh", word_timestamps=True)
        segs = list(segs)
        p(f"      转写完成  {len(segs)} 段  ({time.time()-t1:.1f}s)")
        p(f"      language={info.language} duration={info.duration:.1f}s")
        for s in segs[:3]:
            p(f"        [{s.start:.2f}-{s.end:.2f}] {s.text[:50]!r}")
        if segs and segs[0].words:
            p(f"        word timestamps: {len(segs[0].words)} 个词 "
              f"（例: {segs[0].words[0].word!r} @{segs[0].words[0].start:.2f}s）")
        p(f"  ⟹ **{model_name} 可用**")
        break
    except Exception as e:
        dt = time.time() - t0
        p(f"      ✗ 失败 ({dt:.1f}s): {type(e).__name__}: {str(e)[:200]}")

p("")
p("=" * 72)
p("结论")
p("=" * 72)
p(f"  临时文件: {tmp}（可删）")
