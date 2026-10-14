# -*- coding: utf-8 -*-
"""诊断 faster-whisper 的 metadata_errors 报错（版本不兼容）。

现象：tiny 模型已缓存（74.6MB），WhisperModel 构造成功，
      但 transcribe 时报 TypeError: open() got an unexpected keyword argument 'metadata_errors'
"""
import os
import subprocess
import sys
import tempfile
import traceback

def p(*a):
    print(*a); sys.stdout.flush()

p("=" * 74)
p("一、相关包版本")
p("=" * 74)
from importlib.metadata import version, PackageNotFoundError
for pkg in ["faster-whisper", "huggingface-hub", "tokenizers", "transformers",
            "ctranslate2", "onnxruntime", "numpy", "av"]:
    try:
        p(f"  {pkg:22} {version(pkg)}")
    except PackageNotFoundError:
        p(f"  {pkg:22} (未安装)")

p("")
p("=" * 74)
p("二、合成音频")
p("=" * 74)
tmp = tempfile.mkdtemp(prefix="fwdiag_")
wav = os.path.join(tmp, "t.wav")
subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
               capture_output=True, timeout=60)
p(f"  {wav}  {os.path.getsize(wav)} bytes")

p("")
p("=" * 74)
p("三、用 tiny 复现并取完整 traceback")
p("=" * 74)
try:
    from faster_whisper import WhisperModel
    p("  构造 WhisperModel('tiny', device='cpu', compute_type='int8') ...")
    m = WhisperModel("tiny", device="cpu", compute_type="int8")
    p("  ✅ 构造成功")
    p("  调用 transcribe ...")
    segs, info = m.transcribe(wav, language="zh", word_timestamps=True)
    segs = list(segs)
    p(f"  ✅ 成功：{len(segs)} 段")
except Exception:
    p("  ✗ 失败，完整 traceback：")
    p("")
    tb = traceback.format_exc()
    for line in tb.splitlines():
        p("    " + line)
    p("")
    # 定位出错文件
    p("  " + "-" * 68)
    p("  定位出错位置：")
    for line in tb.splitlines():
        if "site-packages" in line or ".py\"" in line:
            p("    " + line.strip())

p("")
p("=" * 74)
p("四、检查 tokenizers / huggingface_hub 的 open() 签名")
p("=" * 74)
try:
    import inspect
    import huggingface_hub
    from huggingface_hub import hf_hub_download
    sig = inspect.signature(hf_hub_download)
    p(f"  hf_hub_download 参数含 metadata_errors: "
      f"{'metadata_errors' in sig.parameters}")
    p(f"  实际参数: {list(sig.parameters.keys())[:14]}")
except Exception as e:
    p(f"  检查失败: {e}")

p("")
p("  搜索 metadata_errors 出现的位置：")
import site
roots = [site.getusersitepackages()] + site.getsitepackages()
found = []
for root in roots:
    for dirpath, _, files in os.walk(root):
        if "site-packages" not in dirpath:
            continue
        for fn in files:
            if not fn.endswith(".py"):
                continue
            fp = os.path.join(dirpath, fn)
            try:
                with open(fp, encoding="utf-8", errors="ignore") as f:
                    txt = f.read()
                if "metadata_errors" in txt:
                    found.append((fp, txt.count("metadata_errors")))
            except Exception:
                pass
    if found:
        break
for fp, n in found[:10]:
    p(f"    {fp}  ×{n}")
if not found:
    p("    （未找到 —— 可能是二进制/编译层）")
