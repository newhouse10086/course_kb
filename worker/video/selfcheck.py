"""端到端自检 / 验收跑批（**真 ASR + 真 LLM**，素材自合成，不依赖外部文件）。

```powershell
# 5 分钟合成视频（SAPI 中文旁白 + 颜色切换画面）→ 真转写 → 字幕/文稿/导图/帧
python -m worker.video.selfcheck --minutes 5 --out data/tmp/video_selfcheck

# 只用 tiny、跳过 LLM（离线也能跑）
python -m worker.video.selfcheck --minutes 1 --no-llm
```

它做什么：

1. 用 :mod:`worker.video.synth` 合成 N 分钟**有人声**的测试视频
2. 用真 ``faster-whisper``（默认 tiny，CPU int8）转写，**逐块落断点**
3. 用真 LLM（读 ``.env`` 里的凭据）做分章/摘要/思维导图；不可用则如实降级
4. 打印**实测数字**：抽音频耗时、转写耗时、实时倍率（RTF）、字幕条数与首尾时间戳、
   分章覆盖校验、帧数与时间点、降级说明
5. 把报告写到 ``<out>/selfcheck_report.json``，产物留在 ``<out>/work/``

⚠️ 这是**自检**不是单元测试：它跑真的模型，慢（5 分钟视频 ≈ 1 分钟）。
单元测试（``tests/test_video_*.py``）默认不加载模型。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Callable

from . import asr as asr_mod
from . import mindmap as mindmap_mod
from . import runner as runner_mod
from . import slides as slides_mod
from . import subtitle as subtitle_mod
from . import synth
from . import transcript as transcript_mod
from .audio import extract_audio
from .errors import VideoError
from .ffmpeg_util import probe_media
from .llm import make_text_model


def resolve_llm(settings: Any) -> tuple[Callable[[str, dict], dict] | None, str, dict]:
    """自检工具专用的 LLM 接入：**从 .env 拼 cfg** 交给生产构造函数 :func:`make_text_model`。

    ⚠️ 这是**开发/自检工具的例外**：v2 下生产路径的 worker **不读凭据**
    （provider 策略归 Node 层，LLM 配置由 job 参数下发，见 ``docs/ARCHITECTURE_V2.md`` §3/§4）。
    自检要能脱离 Node 单独跑，所以这里自己拼一份 cfg。

    :return: ``(调用器或 None, 说明, 能力快照)``
    """
    cfg = None
    if settings is not None and getattr(settings, "llm_configured", False):
        cfg = {
            "base_url": getattr(settings, "llm_base_url", ""),
            "api_key": getattr(settings, "llm_api_key", ""),
            "model": getattr(settings, "llm_model", ""),
        }
    caller, reason = make_text_model(cfg)
    cap = runner_mod.llm_capability(llm=caller)
    if caller is None:
        return None, reason or cap.get("reason", "不可用"), cap
    return caller, f"自检直连 .env 凭据（model={cap.get('model')}）", cap


def run_selfcheck(
    *,
    minutes: float = 5.0,
    out_dir: str = "data/tmp/video_selfcheck",
    model: str = "tiny",
    use_llm: bool = True,
    keep_video: bool = True,
) -> dict:
    """跑一次完整自检并返回报告 dict。"""
    os.makedirs(out_dir, exist_ok=True)
    duration_ms = int(minutes * 60_000)
    video = os.path.join(out_dir, "lesson.mp4")
    work = os.path.join(out_dir, "work")
    report: dict[str, Any] = {
        "minutes": minutes,
        "asr_model": model,
        "video": video,
        "work_dir": work,
    }
    print(f"[1/5] 合成 {minutes} 分钟测试视频（SAPI 中文旁白 + 颜色切换画面）…")
    t0 = time.time()
    if not (keep_video and os.path.isfile(video)):
        synth.synth_narrated_video(video, duration_ms=duration_ms)
    report["synth_s"] = round(time.time() - t0, 2)
    info = probe_media(video)
    report["media"] = info.to_dict()
    print(
        f"      时长 {info.duration_ms}ms 画面 {info.width}x{info.height}@{info.fps}fps "
        f"音频 {info.sample_rate}Hz/{info.channels}ch（合成 {report['synth_s']}s）"
    )

    print(f"[2/5] 抽音频（16k/mono/PCM）…")
    t0 = time.time()
    track = extract_audio(video, os.path.join(work, "audio.wav"), duration_ms=info.duration_ms)
    report["audio"] = track.to_dict()
    report["audio_s"] = round(time.time() - t0, 2)
    print(f"      {track.duration_ms}ms → {track.size_bytes / 1e6:.1f}MB，耗时 {report['audio_s']}s")

    print(f"[3/5] 真 ASR 转写（faster-whisper/{model}，CPU int8，逐块落断点）…")
    cap = asr_mod.asr_capability()
    report["asr_capability"] = cap
    if not cap["available"]:
        print(f"      ✗ ASR 不可用：{cap['reason']}")
        report["ok"] = False
        _write_report(out_dir, report)
        return report
    t0 = time.time()
    asr_result = asr_mod.transcribe_audio(
        track.path,
        model=model,
        duration_ms=track.duration_ms,
        work_dir=os.path.join(work, "asr"),
        on_progress=lambda f, s: None,
    )
    wall = time.time() - t0
    segs = asr_result.segments
    last_end = segs[-1].end if segs else 0
    report["asr"] = {
        "model": asr_result.model,
        "lang": asr_result.lang,
        "lang_probability": asr_result.lang_probability,
        "segments": len(segs),
        "chunks_total": asr_result.chunks_total,
        "chunks_resumed": asr_result.chunks_resumed,
        "wall_s": round(wall, 2),
        "audio_s": round(last_end / 1000.0, 2),
        "realtime_factor": round((last_end / 1000.0) / wall, 2) if wall > 0 else 0.0,
        "text_sample": "".join(s.text for s in segs)[:200],
        "monotonic": all(b.start >= a.end for a, b in zip(segs, segs[1:])),
    }
    print(
        f"      语言 {asr_result.lang}（p={asr_result.lang_probability:.2f}） "
        f"{len(segs)} 段 / {asr_result.chunks_total} 块，耗时 {wall:.1f}s → "
        f"RTF {report['asr']['realtime_factor']}x"
    )
    print(f"      文本样例：{report['asr']['text_sample'][:80]!r}")

    print("[4/5] 字幕 / 分章 / 思维导图 …")
    cues = subtitle_mod.build_cues(segs, duration_ms=track.duration_ms)
    subtitle_mod.validate_timeline(cues, duration_ms=track.duration_ms)
    srt_path = os.path.join(work, "subtitle.srt")
    vtt_path = os.path.join(work, "subtitle.vtt")
    _write(srt_path, subtitle_mod.to_srt(cues))
    _write(vtt_path, subtitle_mod.to_vtt(cues))
    report["subtitles"] = {
        "cues": len(cues),
        "first": cues[0].to_dict() if cues else None,
        "last": cues[-1].to_dict() if cues else None,
        "monotonic": all(b.start >= a.end for a, b in zip(cues, cues[1:])),
        "within_duration": all(c.end <= track.duration_ms for c in cues),
        "srt_bytes": os.path.getsize(srt_path),
        "vtt_bytes": os.path.getsize(vtt_path),
    }
    print(
        f"      SRT {len(cues)} 条：{subtitle_mod.ms_to_srt_ts(cues[0].start)} → "
        f"{subtitle_mod.ms_to_srt_ts(cues[-1].end)}（单调 {report['subtitles']['monotonic']}）"
    )

    llm, llm_note, llm_cap = (
        resolve_llm(_settings()) if use_llm else (None, "命令行关闭了 LLM（--no-llm）", {})
    )
    report["llm"] = {"note": llm_note, "available": llm is not None, "capability": llm_cap}
    t0 = time.time()
    tres = transcript_mod.analyze_transcript(
        llm,
        segs,
        duration_ms=track.duration_ms,
        video_title="数据库索引（自检）",
    )
    report["llm_s"] = round(time.time() - t0, 2)
    transcript_mod.validate_coverage(tres.chapters, track.duration_ms)
    report["transcript"] = {
        "source": tres.source,
        "note": tres.note,
        "chapters": len(tres.chapters),
        "titles": [c.title for c in tres.chapters],
        "covered": (tres.chapters[0].start, tres.chapters[-1].end),
        "summary_chars": len(tres.summary),
    }
    if llm is not None:
        client = getattr(llm, "client", None)
        report["llm"]["calls"] = getattr(client, "calls", None)
        report["llm"]["status"] = (
            client.status_.to_dict() if client is not None and hasattr(client, "status_") else {}
        )
    print(
        f"      分章 {len(tres.chapters)} 章（来源 {tres.source}） 覆盖 "
        f"[{tres.chapters[0].start},{tres.chapters[-1].end}] / {track.duration_ms}"
    )
    if tres.source != "llm":
        print(f"      ⚠ 分章未用 LLM：{tres.note}｜LLM：{llm_note}")
    for c in tres.chapters[:10]:
        print(f"        · {c.title}  [{c.start}–{c.end}]")

    mm = ""
    mm_source = "none"
    if llm is not None:
        try:
            payload = llm(
                mindmap_mod.build_mindmap_prompt(
                    tres.chapters, summary=tres.summary, video_title="数据库索引（自检）"
                ),
                mindmap_mod.MINDMAP_SCHEMA,
            )
            mm = mindmap_mod.normalize_markmap(str((payload or {}).get("markdown") or ""))
            mm_source = "llm" if mm else "none"
        except Exception as exc:  # noqa: BLE001
            print(f"      ⚠ 思维导图 LLM 失败：{exc}")
    if not mm:
        mm = mindmap_mod.from_chapters(tres.chapters, root="数据库索引（自检）")
        mm_source = "structural" if mm else "none"
    if mm:
        _write(os.path.join(work, "mindmap.md"), mm)
    tree = mindmap_mod.to_tree(mm)
    report["mindmap"] = {
        "source": mm_source,
        "chars": len(mm),
        "nodes": mindmap_mod.node_count(tree),
        "root": tree["title"],
    }
    print(f"      思维导图 来源 {mm_source}：{mm.splitlines()[0]!r}（{report['mindmap']['nodes']} 节点）")

    print("[5/5] 场景检测抽帧 …")
    t0 = time.time()
    frames = slides_mod.detect_frames(
        video, os.path.join(work, "frames"), duration_ms=track.duration_ms
    )
    if frames:
        slides_mod.attach_ocr(frames)
    report["slides"] = {
        "count": len(frames),
        "mode": frames[0].mode if frames else "none",
        "at_ms": [f.at_ms for f in frames],
        "ocr_hits": sum(1 for f in frames if f.ocr_text),
        "ocr_available": slides_mod.ocr_availability()["available"],
        "seconds": round(time.time() - t0, 2),
    }
    print(
        f"      {len(frames)} 帧（mode={report['slides']['mode']}，OCR 命中 "
        f"{report['slides']['ocr_hits']}），时间点前 8 个 {report['slides']['at_ms'][:8]}"
    )

    report["ok"] = bool(segs and cues and report["subtitles"]["monotonic"])
    report["artifact_files"] = {
        "video": video,
        "audio": track.path,
        "srt": srt_path,
        "vtt": vtt_path,
        "mindmap": os.path.join(work, "mindmap.md") if mm else "",
        "frames_dir": os.path.join(work, "frames"),
    }
    _write_report(out_dir, report)
    print(f"\n✅ 自检完成（ok={report['ok']}），报告：{os.path.join(out_dir, 'selfcheck_report.json')}")
    return report


def _settings() -> Any:
    try:
        from worker.config import get_settings

        return get_settings()
    except Exception:  # noqa: BLE001
        return None


def _write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def _write_report(out_dir: str, report: dict) -> None:
    _write(os.path.join(out_dir, "selfcheck_report.json"), json.dumps(report, ensure_ascii=False, indent=2))


def main(argv: list[str] | None = None) -> int:
    # ⚠️ Windows 控制台默认 GBK：直接 print("⚠"/"✅"/"·") 会抛
    #    UnicodeEncodeError: 'gbk' codec can't encode character '\u26a0'
    #    （实测踩过，整条自检在最后一步崩掉）。这里把 stdout/stderr 切成 UTF-8 + replace。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001
            pass
    ap = argparse.ArgumentParser(description="视频管线端到端自检（真 ASR + 真 LLM）")
    ap.add_argument("--minutes", type=float, default=5.0, help="合成视频时长（分钟）")
    ap.add_argument("--out", default="data/tmp/video_selfcheck", help="产物目录")
    ap.add_argument("--asr-model", default="tiny", help="ASR 模型（tiny/base/small）")
    ap.add_argument("--no-llm", action="store_true", help="跳过 LLM（离线自检）")
    ap.add_argument("--force-synth", action="store_true", help="即使已存在也重新合成视频")
    args = ap.parse_args(argv)
    try:
        rep = run_selfcheck(
            minutes=args.minutes,
            out_dir=args.out,
            model=args.asr_model,
            use_llm=not args.no_llm,
            keep_video=not args.force_synth,
        )
    except VideoError as exc:
        print(f"❌ 自检失败：{exc.message}\n{exc.detail}", file=sys.stderr)
        return 1
    return 0 if rep.get("ok") else 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
