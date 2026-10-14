"""S3 字幕：ASR 段落 → SRT / VTT（契约 §2.7 ``subtitles``）。

## 不变量（测试逐个断言，别只断言"非空"）

1. **时间轴单调递增**：``cue[i].start >= cue[i-1].end``，**任何两条都不重叠**
2. ``end > start``：每条字幕至少 :data:`MIN_CUE_MS` 毫秒（否则播放器闪一下等于没显示）
3. 全部落在 ``[0, duration_ms]`` 内，**不越界**
4. **换行合并**：ASR 是按短句切段的，直接输出会得到一堆 3 个字一条的字幕；
   相邻且间隔小的段落要合并，长句再按 :data:`MAX_CHARS_PER_LINE` 折行
5. **不丢字**：合并与折行只允许改空白，不允许丢内容

SRT 时间戳 ``HH:MM:SS,mmm``（逗号），VTT 用 ``HH:MM:SS.mmm``（点）——这是**格式硬性要求**，
张冠李戴会让播放器整条字幕不显示。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Sequence

from .errors import SubtitleParseError

#: 单行最大字符数（中文课程按字计数；20 字一行在 1080p 上不会出屏）
MAX_CHARS_PER_LINE = 20
#: 相邻段落间隔 ≤ 此值时考虑合并
MAX_GAP_MS = 800
#: 合并后单条字幕的最大时长（超过就断开，避免"一句话挂 20 秒"）
MAX_CUE_MS = 7000
#: 单条字幕的最小时长（低于此值补到 MIN_CUE_MS；仍受"不与下一条重叠"约束）
MIN_CUE_MS = 500
#: 合并后单条字幕的最大字符数
MAX_CUE_CHARS = 42

_CJK_RE = re.compile(r"[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]")
_SRT_TS_RE = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
)
_VTT_TS_RE = _SRT_TS_RE


@dataclass
class Cue:
    """一条字幕（``text`` 可含 ``\\n``，表示两行）。"""

    start: int
    end: int
    text: str

    def to_dict(self) -> dict:
        return {"start": self.start, "end": self.end, "text": self.text}

    @property
    def duration(self) -> int:
        return self.end - self.start


# ── 时间戳 ──────────────────────────────────────────────────────────────
def ms_to_srt_ts(ms: int) -> str:
    """毫秒 → ``HH:MM:SS,mmm``。负数按 0 处理（SRT 不接受负时间）。"""
    ms = max(0, int(ms))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, msec = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{msec:03d}"


def ms_to_vtt_ts(ms: int) -> str:
    """毫秒 → ``HH:MM:SS.mmm``（VTT 用点，不是逗号）。"""
    return ms_to_srt_ts(ms).replace(",", ".")


def parse_ts(text: str) -> int:
    """``HH:MM:SS,mmm`` / ``HH:MM:SS.mmm`` / ``MM:SS.mmm`` → 毫秒。"""
    text = text.strip().replace(",", ".")
    parts = text.split(":")
    try:
        nums = [float(p) for p in parts]
    except ValueError as exc:
        raise SubtitleParseError(f"无法解析时间戳：{text!r}") from exc
    if len(nums) == 3:
        h, m, s = nums
    elif len(nums) == 2:
        h, (m, s) = 0.0, (nums[0], nums[1])
    elif len(nums) == 1:
        h = m = 0.0
        s = nums[0]
    else:
        raise SubtitleParseError(f"时间戳段数不对：{text!r}")
    return int(round(((h * 60 + m) * 60 + s) * 1000))


# ── 文本处理 ────────────────────────────────────────────────────────────
def join_text(left: str, right: str) -> str:
    """拼接两句：中文之间**不加空格**，拉丁文之间加。

    错误写法（曾用）：无条件 ``left + " " + right`` → 中文文稿里满屏多余空格，
    复制出去像被拆开过。
    """
    left = left.strip()
    right = right.strip()
    if not left:
        return right
    if not right:
        return left
    if _CJK_RE.search(left[-1]) or _CJK_RE.search(right[0]):
        return left + right
    return f"{left} {right}"


def wrap_lines(text: str, *, max_chars: int = MAX_CHARS_PER_LINE) -> str:
    """把长句折成每行 ≤ ``max_chars`` 的多行（**不丢字**）。

    先按已有换行切开，再对每段贪心折行：优先在标点/空格处断，
    找不到就硬断（硬断比丢字好）。
    """
    out: list[str] = []
    for raw in str(text).split("\n"):
        line = raw.strip()
        if not line:
            continue
        out.extend(_wrap_one(line, max_chars))
    return "\n".join(out)


def _wrap_one(line: str, max_chars: int) -> list[str]:
    if max_chars <= 0 or len(line) <= max_chars:
        return [line]
    breaks = "，。！？；：、,.!?;: "
    res: list[str] = []
    cur = ""
    for ch in line:
        cur += ch
        if len(cur) >= max_chars:
            # 回退到最近的断点（只在能留下至少一半内容时才回退，避免退化成 1 字一行）
            cut = -1
            for idx in range(len(cur) - 1, max(0, len(cur) - max_chars // 2), -1):
                if cur[idx] in breaks:
                    cut = idx + 1
                    break
            if cut > 0:
                res.append(cur[:cut].strip())
                cur = cur[cut:]
            else:
                res.append(cur.strip())
                cur = ""
    if cur.strip():
        res.append(cur.strip())
    return res


# ── 段落 → 字幕条 ───────────────────────────────────────────────────────
def build_cues(
    segments: Sequence,
    *,
    max_chars: int = MAX_CUE_CHARS,
    max_gap_ms: int = MAX_GAP_MS,
    max_cue_ms: int = MAX_CUE_MS,
    min_cue_ms: int = MIN_CUE_MS,
    duration_ms: int | None = None,
) -> list[Cue]:
    """ASR 段落 → 字幕条（合并 + 折行 + 强制不变量）。

    ``segments`` 只要每项有 ``start`` / ``end`` / ``text`` 即可
    （``VideoSegment`` 与测试里的假对象都行）。
    """
    cleaned: list[Cue] = []
    for seg in segments:
        text = str(getattr(seg, "text", "") or "").strip()
        if not text:
            continue  # 空段直接丢，不产出空字幕条
        start = max(0, int(getattr(seg, "start", 0)))
        end = max(start, int(getattr(seg, "end", start)))
        cleaned.append(Cue(start=start, end=end, text=text))
    cleaned.sort(key=lambda c: (c.start, c.end))

    merged: list[Cue] = []
    for cue in cleaned:
        if merged:
            prev = merged[-1]
            gap = cue.start - prev.end
            joined = join_text(prev.text, cue.text)
            if (
                gap <= max_gap_ms
                and len(joined.replace("\n", "")) <= max_chars
                and (cue.end - prev.start) <= max_cue_ms
            ):
                prev.end = max(prev.end, cue.end)
                prev.text = joined
                continue
        merged.append(Cue(start=cue.start, end=cue.end, text=cue.text))

    return enforce_timeline(merged, duration_ms=duration_ms, min_cue_ms=min_cue_ms)


def enforce_timeline(
    cues: Iterable[Cue],
    *,
    duration_ms: int | None = None,
    min_cue_ms: int = MIN_CUE_MS,
) -> list[Cue]:
    """强制 §「不变量」1~3：不越界、单调递增、不重叠、``end > start``。

    这是**唯一的收口处**：所有字幕/时间轴产物都必须过一遍，
    否则 ASR 段之间的重叠（分段转写拼接处很常见）会漏到播放器。
    """
    src = sorted((c for c in cues), key=lambda c: (c.start, c.end))
    out: list[Cue] = []
    for cue in src:
        start = max(0, int(cue.start))
        end = max(start, int(cue.end))
        if duration_ms is not None:
            start = min(start, max(0, duration_ms))
            end = min(end, max(0, duration_ms))
        if out:
            prev = out[-1]
            if start < prev.end:  # 重叠 → 顶到上一条结束
                start = prev.end
            if start == prev.end == 0 and end == 0:
                continue
            if start >= end:
                # 时间被前一条吃光了：并进上一条（保字不保时间），不产出零长字幕
                prev.text = join_text(prev.text, cue.text)
                continue
        if end - start < min_cue_ms:
            end = start + min_cue_ms
            if duration_ms is not None:
                end = min(end, max(start + 1, duration_ms))
        if duration_ms is not None and end > duration_ms:
            end = duration_ms
            if start >= end:
                out.append(Cue(start=max(0, end - 1), end=end, text=cue.text))
                continue
        if end <= start:
            end = start + 1
        # 顶到上一条之后若越界（start 已到片尾）→ 并进上一条
        if out and start >= (duration_ms if duration_ms is not None else 1 << 62):
            out[-1].text = join_text(out[-1].text, cue.text)
            continue
        text = wrap_lines(cue.text)
        if not text.strip():
            continue
        out.append(Cue(start=start, end=end, text=text))
    return out


def validate_timeline(
    cues: Sequence[Cue], *, duration_ms: int | None = None
) -> None:
    """断言不变量（测试与自检共用；违反了**当场报错**而不是产出坏字幕）。"""
    prev_end = 0
    for idx, cue in enumerate(cues):
        if cue.end <= cue.start:
            raise SubtitleParseError(f"第 {idx + 1} 条字幕 end({cue.end}) <= start({cue.start})")
        if cue.start < prev_end:
            raise SubtitleParseError(
                f"第 {idx + 1} 条字幕与上一条重叠：start({cue.start}) < 上一条 end({prev_end})"
            )
        if duration_ms is not None and cue.end > duration_ms:
            raise SubtitleParseError(
                f"第 {idx + 1} 条字幕越界：end({cue.end}) > duration({duration_ms})"
            )
        prev_end = cue.end


# ── 序列化 ──────────────────────────────────────────────────────────────
def to_srt(cues: Sequence[Cue]) -> str:
    """SRT（序号从 1 开始，块间空行，行尾 ``\\n``）。"""
    blocks = []
    for i, cue in enumerate(cues, start=1):
        blocks.append(
            f"{i}\n{ms_to_srt_ts(cue.start)} --> {ms_to_srt_ts(cue.end)}\n{cue.text}"
        )
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def to_vtt(cues: Sequence[Cue]) -> str:
    """WebVTT（必须 ``WEBVTT`` 头 + **恰好一个**空行；时间戳用点）。

    错误写法（曾用）：``"\\n\\n".join(["WEBVTT", ""] + blocks)``
    → 头部后面多出一个空行（``WEBVTT\\n\\n\\n\\n``），严格播放器会整个不显示字幕。
    """
    if not cues:
        return "WEBVTT\n"
    head = "WEBVTT\n\n"
    blocks = [
        f"{ms_to_vtt_ts(cue.start)} --> {ms_to_vtt_ts(cue.end)}\n{cue.text}" for cue in cues
    ]
    return head + "\n\n".join(blocks) + "\n"


def segments_to_srt(segments: Sequence, **kw) -> str:
    return to_srt(build_cues(segments, **kw))


def segments_to_vtt(segments: Sequence, **kw) -> str:
    return to_vtt(build_cues(segments, **kw))


# ── 反向解析（坑 10 的降级路径：ASR 不可用时手动上传字幕）─────────────
def parse_srt(text: str) -> list[Cue]:
    """解析 SRT/VTT 文本 → :class:`Cue` 列表（手动上传字幕用）。"""
    if not text or not text.strip():
        raise SubtitleParseError("字幕内容为空")
    body = re.sub(r"^WEBVTT.*?$", "", text.strip(), count=1, flags=re.MULTILINE)
    cues: list[Cue] = []
    for raw in re.split(r"\n\s*\n", body):
        lines = [ln for ln in raw.splitlines() if ln.strip()]
        if not lines:
            continue
        ts_idx = None
        for i, ln in enumerate(lines):
            if "-->" in ln:
                ts_idx = i
                break
        if ts_idx is None:
            continue
        m = _VTT_TS_RE.search(lines[ts_idx])
        if not m:
            raise SubtitleParseError(f"时间行格式不对：{lines[ts_idx]!r}")
        start = parse_ts(":".join(m.group(1, 2, 3)) + "." + m.group(4))
        end = parse_ts(":".join(m.group(5, 6, 7)) + "." + m.group(8))
        cue_text = "\n".join(ln.strip() for ln in lines[ts_idx + 1 :] if ln.strip())
        if cue_text:
            cues.append(Cue(start=start, end=end, text=cue_text))
    if not cues:
        raise SubtitleParseError("没有解析出任何字幕条（检查是否为合法 SRT/VTT）")
    return cues


def detect_and_parse(text: str) -> list[Cue]:
    """SRT/VTT 自动识别（两者时间戳格式兼容，统一走一条路）。"""
    return parse_srt(text)


__all__ = [
    "Cue",
    "MAX_CHARS_PER_LINE",
    "MAX_GAP_MS",
    "MAX_CUE_MS",
    "MIN_CUE_MS",
    "MAX_CUE_CHARS",
    "build_cues",
    "enforce_timeline",
    "validate_timeline",
    "wrap_lines",
    "join_text",
    "ms_to_srt_ts",
    "ms_to_vtt_ts",
    "parse_ts",
    "to_srt",
    "to_vtt",
    "segments_to_srt",
    "segments_to_vtt",
    "parse_srt",
    "detect_and_parse",
]
