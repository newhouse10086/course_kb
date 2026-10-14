"""S4/S5 文稿分章 + 全文摘要。

## 为什么让 LLM 返回**段号**而不是毫秒

坑：让模型直接吐绝对毫秒，它会给你编出 ``start=0, end=999999999`` 这种值，
然后再由我们"夹到范围里"—— 结果就是所有分章都挤在开头或者覆盖不全。

做法：把 ASR 段落编号后交给模型，模型只回答**章节边界落在第几段**
（``start_i`` / ``end_i``），毫秒由我们在 :func:`normalize_chapters` 里
**确定性**地算出来。于是「覆盖全片且不越界」是**构造性保证**，不靠模型自觉。

## 硬要求

1. **json_schema + strict**（坑 4）：``json_object`` 模式不强制 enum/字段，
   实测模型会漏字段。见 :data:`CHAPTERS_SCHEMA`。
2. **≤8 章**（F6 关键参数）：超过就在 :func:`normalize_chapters` 里合并最相邻的短章。
3. **覆盖全片**：``chapters[0].start == 0`` 且 ``chapters[-1].end == duration_ms``
   且相邻首尾相接（无空洞、不重叠）。
4. **并发=1**（AGENTS.md §8）：本模块**串行**调用模型，多窗口也一个一个来。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Callable, Sequence

from worker.models.video import TranscriptChapter, VideoSegment

from .errors import TextModelSchemaError, TextModelUnavailable

log = logging.getLogger(__name__)

#: 分章上限（F6 关键参数：太多章反而不好读）
MAX_CHAPTERS = 8
#: 单次 LLM 调用最多塞多少字的文稿（超了按窗口切分，串行调用）
MAX_WINDOW_CHARS = 6000
#: 机械分节的兜底：一个分节至少这么长
MIN_CHAPTER_MS = 30_000

#: LLM 回调签名：``(prompt, json_schema) -> dict``（实现见 runner.resolve_text_model）
TextModel = Callable[[str, dict], dict]

#: 分章 + 摘要的结构（**strict**：additionalProperties=False + required 齐全）
CHAPTERS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["chapters", "summary"],
    "properties": {
        "summary": {"type": "string", "description": "整段视频的摘要，200~400 字"},
        "chapters": {
            "type": "array",
            "minItems": 1,
            "maxItems": MAX_CHAPTERS,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["title", "start_i", "end_i", "summary"],
                "properties": {
                    "title": {"type": "string", "description": "章节标题，中文，≤20 字"},
                    "start_i": {"type": "integer", "description": "起始段落编号（含）"},
                    "end_i": {"type": "integer", "description": "结束段落编号（含）"},
                    "summary": {"type": "string", "description": "本章 1~3 句摘要"},
                },
            },
        },
    },
}


def _fmt_ts(ms: int) -> str:
    s, _ = divmod(int(ms), 1000)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def segments_digest(
    segments: Sequence[VideoSegment], *, max_chars: int = MAX_WINDOW_CHARS, start_i: int = 0
) -> str:
    """把段落压成给模型看的"带编号台词表"（截断只截在这一窗口内）。"""
    lines: list[str] = []
    used = 0
    for idx, seg in enumerate(segments, start=start_i):
        line = f"[{idx}] {_fmt_ts(seg.start)} {seg.text.strip()}"
        if used + len(line) > max_chars and lines:
            break
        lines.append(line)
        used += len(line)
    return "\n".join(lines)


def plan_windows(
    segments: Sequence[VideoSegment], *, max_chars: int = MAX_WINDOW_CHARS
) -> list[tuple[int, int]]:
    """按字数把段落切成 ``(起段号, 止段号)`` 窗口（长视频必须分次喂模型）。"""
    if not segments:
        return []
    windows: list[tuple[int, int]] = []
    start = 0
    used = 0
    for idx, seg in enumerate(segments):
        size = len(seg.text.strip()) + 24
        if used + size > max_chars and idx > start:
            windows.append((start, idx - 1))
            start = idx
            used = 0
        used += size
    windows.append((start, len(segments) - 1))
    return windows


def build_chapter_prompt(
    segments: Sequence[VideoSegment],
    *,
    duration_ms: int,
    max_chapters: int = MAX_CHAPTERS,
    start_i: int = 0,
    end_i: int | None = None,
    video_title: str = "",
    partial: bool = False,
    max_chars: int = MAX_WINDOW_CHARS,
) -> str:
    """构造分章提示词（**段落编号全局唯一**：窗口内也用全局段号）。"""
    last = (len(segments) - 1) if end_i is None else end_i
    body = segments_digest(segments, max_chars=max_chars, start_i=start_i)
    scope = (
        f"这是一整段视频中的一部分（第 {start_i}~{last} 段）。"
        if partial
        else "这是整段视频的全部台词。"
    )
    return (
        "你是一名课程内容编辑。下面是网课视频的 ASR 台词，每行格式为：\n"
        "``[段落编号] 时间 台词``。\n\n"
        f"{scope}视频总时长 {duration_ms} 毫秒（{_fmt_ts(duration_ms)}）。\n"
        f"视频标题：{video_title or '(未命名)'}\n\n"
        f"## 台词\n{body}\n\n"
        "## 任务\n"
        f"1. 按**语义**把台词切成不超过 {max_chapters} 个章节（不要按时间等分）。\n"
        "2. 每章给一个中文标题（≤20 字）与 1~3 句摘要。\n"
        f"3. ``start_i`` / ``end_i`` 必须是上面出现过的**段落编号**（含两端），"
        f"范围 {start_i}~{last}；章节必须**首尾相接**、不重叠、不留空。\n"
        "4. 第一个 start_i 必须是最小段号，最后一个 end_i 必须是最大段号。\n"
        "5. 另给整段视频的摘要（200~400 字），只依据台词内容，不要脑补。\n"
        "只输出 JSON，不要任何解释。"
    )


def build_summary_prompt(
    segments: Sequence[VideoSegment], *, duration_ms: int, video_title: str = ""
) -> str:
    body = segments_digest(segments, max_chars=MAX_WINDOW_CHARS * 2)
    return (
        f"下面是网课视频《{video_title or '未命名'}》（{_fmt_ts(duration_ms)}）的台词。\n"
        "请写一段 200~400 字的中文摘要，覆盖主要知识点与讲解顺序；"
        "**只依据台词**，不要补充台词里没有的内容。\n\n"
        f"## 台词\n{body}\n\n"
        '只输出 JSON：{"summary": "..."}'
    )


SUMMARY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary"],
    "properties": {"summary": {"type": "string"}},
}


# ── 归一化（构造性保证"覆盖全片 + 不越界"）──────────────────────────────
@dataclass
class RawChapter:
    """模型给出的候选章节（边界用段号表达）。"""

    title: str
    start_i: int
    end_i: int
    summary: str = ""


def parse_chapters(
    payload: Any, *, segments: Sequence[VideoSegment]
) -> tuple[list[RawChapter], str]:
    """解析模型输出 → 候选章节；**段号越界/倒置当场拒绝**（坑 4：别信模型结构）。

    同时容忍 ``start``/``end``（毫秒）写法：只有当整份输出**没有任何** ``*_i``
    字段时才按毫秒解释，避免两种单位混用（曾因此得到 ``start=0,end=8`` 的荒唐结果）。
    """
    if not isinstance(payload, dict):
        raise TextModelSchemaError(f"模型输出不是 JSON 对象：{type(payload).__name__}")
    raw_list = payload.get("chapters")
    if not isinstance(raw_list, list) or not raw_list:
        raise TextModelSchemaError("模型输出缺少非空的 chapters 数组")
    n_segments = len(segments)
    use_index = any("start_i" in c or "end_i" in c for c in raw_list if isinstance(c, dict))
    starts = [int(s.start) for s in segments]
    out: list[RawChapter] = []
    for n, item in enumerate(raw_list):
        if not isinstance(item, dict):
            raise TextModelSchemaError(f"chapters[{n}] 不是对象")
        title = str(item.get("title") or "").strip()
        summary = str(item.get("summary") or "").strip()
        if not title:
            title = f"第 {n + 1} 章"
        if use_index:
            try:
                s_i = int(item.get("start_i"))
                e_i = int(item.get("end_i"))
            except (TypeError, ValueError) as exc:
                raise TextModelSchemaError(
                    f"chapters[{n}] 的 start_i/end_i 不是整数：{item!r}"
                ) from exc
        else:  # 毫秒写法：转成段号（第一个 start >= t 的段）
            try:
                s_ms = int(item.get("start"))
                e_ms = int(item.get("end"))
            except (TypeError, ValueError) as exc:
                raise TextModelSchemaError(
                    f"chapters[{n}] 既没有 start_i/end_i，也没有毫秒 start/end：{item!r}"
                ) from exc
            s_i = _ms_to_index(s_ms, starts)
            e_i = max(s_i, _ms_to_index(e_ms, starts, round_up=True))
        if e_i < s_i:
            raise TextModelSchemaError(f"chapters[{n}] 的 end_i({e_i}) < start_i({s_i})")
        # 越界容忍：模型很常见的两个错是「1-based 差一」和「末尾多算一段」，
        # 这种小幅越界**夹回范围**（:func:`normalize_chapters` 本就会拉直）；
        # 但**大幅越界说明单位用错了**（比如把毫秒当段号），必须报错而不是悄悄夹掉。
        if n_segments:
            slack = max(2, n_segments // 5)
            if s_i < -slack or e_i > n_segments - 1 + slack:
                raise TextModelSchemaError(
                    f"chapters[{n}] 段号越界太多：[{s_i},{e_i}]，"
                    f"合法范围 [0,{n_segments - 1}]（超出 {slack} 段容差；是否把毫秒当段号了？）"
                )
            s_i = max(0, min(n_segments - 1, s_i))
            e_i = max(s_i, min(n_segments - 1, e_i))
        out.append(RawChapter(title=title, start_i=s_i, end_i=e_i, summary=summary))
    summary = str(payload.get("summary") or "").strip()
    return out, summary


def _ms_to_index(ms: int, starts: Sequence[int], *, round_up: bool = False) -> int:
    """毫秒 → 段号（``round_up`` 时取该时刻**所在**的段，否则取第一个 start ≥ ms 的段）。"""
    if not starts:
        return 0
    if round_up:
        idx = 0
        for i, s in enumerate(starts):
            if s <= ms:
                idx = i
            else:
                break
        return idx
    for i, s in enumerate(starts):
        if s >= ms:
            return i
    return len(starts) - 1


def normalize_chapters(
    raw: Sequence[RawChapter],
    segments: Sequence[VideoSegment],
    *,
    duration_ms: int,
    max_chapters: int = MAX_CHAPTERS,
) -> list[TranscriptChapter]:
    """候选章节 → **覆盖全片且不越界**的最终分章（构造性保证）。

    步骤（顺序不能换）：
    1. 段号排序 + 裁剪到合法范围
    2. 拉直：``[prev.end_i+1, cur.end_i]``，让相邻章**首尾相接无空洞**
    3. 首章强制从第 0 段开始，末章强制到末段结束
    4. 段号算毫秒；首章 ``start=0``、末章 ``end=duration_ms``
    5. 超过 ``max_chapters`` → 反复合并**最短的相邻对**
    6. 空章（没有段落）并进前一章
    """
    if not segments:
        raise TextModelUnavailable("没有 ASR 段落，无法分章")
    n = len(segments)
    duration_ms = max(0, int(duration_ms))

    cand = sorted(
        (RawChapter(c.title, max(0, min(n - 1, c.start_i)), max(0, min(n - 1, c.end_i)), c.summary) for c in raw),
        key=lambda c: (c.start_i, c.end_i),
    )
    if not cand:
        raise TextModelUnavailable("模型没有给出任何章节")

    # 2+3 拉直
    fixed: list[RawChapter] = []
    cursor = 0
    for c in cand:
        # 候选完全落在已接受范围之前 → **跳过**（多窗口调用时模型常把同一段
        # 重复报一次；旧写法用 max(start_i, c.end_i) 硬补一段，
        # 结果产出一个只有 1 段的畸形章节 —— 实测 titles 出现"第一章、第一章、第二章"）。
        if c.end_i < cursor:
            continue
        start_i = cursor
        end_i = c.end_i
        if end_i >= n:
            end_i = n - 1
        if end_i < start_i:
            continue
        fixed.append(RawChapter(c.title, start_i, end_i, c.summary))
        cursor = end_i + 1
        if cursor >= n:
            break
    if not fixed:
        fixed = [RawChapter("全文", 0, n - 1)]
    # 首章从 0 开始（第一个候选若没从 0 开始，把前面的段落并进来）
    if fixed[0].start_i != 0:
        fixed[0].start_i = 0
    # 末章吃到末尾
    if fixed[-1].end_i != n - 1:
        fixed[-1].end_i = n - 1
    # 丢掉滑出范围的章（理论上不会发生）
    fixed = [c for c in fixed if c.end_i >= c.start_i]

    # 5 合并到 max_chapters
    max_chapters = max(1, int(max_chapters))
    while len(fixed) > max_chapters:
        best = 0
        best_len = None
        for i in range(len(fixed) - 1):
            span = fixed[i + 1].start_i - fixed[i].start_i + (fixed[i + 1].end_i - fixed[i].end_i)
            if best_len is None or span < best_len:
                best_len, best = span, i
        a, b = fixed[best], fixed[best + 1]
        merged_title = a.title if len(a.title) <= len(b.title) else b.title
        merged_summary = a.summary or b.summary
        fixed[best : best + 2] = [
            RawChapter(merged_title, a.start_i, b.end_i, merged_summary)
        ]

    # 4 段号 → 毫秒（边界取段的 start/end，构造性保证不越界）
    out: list[TranscriptChapter] = []
    for i, c in enumerate(fixed):
        start_ms = 0 if i == 0 else segments[c.start_i].start
        end_ms = duration_ms if i == len(fixed) - 1 else segments[c.end_i].end
        start_ms = max(0, min(start_ms, duration_ms))
        end_ms = max(start_ms, min(end_ms, duration_ms))
        text = join_segment_text(segments[c.start_i : c.end_i + 1])
        out.append(
            TranscriptChapter(
                title=c.title, start=start_ms, end=end_ms, text=text, summary=c.summary
            )
        )
    return fill_gaps(out, duration_ms)


def join_segment_text(segments: Sequence[VideoSegment]) -> str:
    """章内台词拼接（中文不加空格，见 subtitle.join_text 的同一条规则）。"""
    from .subtitle import join_text

    acc = ""
    for seg in segments:
        acc = join_text(acc, seg.text)
    return acc


def fill_gaps(
    chapters: Sequence[TranscriptChapter], duration_ms: int
) -> list[TranscriptChapter]:
    """收口：保证首尾相接、覆盖 ``[0, duration_ms]``（不留空洞、不重叠）。

    ⚠️ 关键点：ASR 段落之间**本来就有静音间隙**（实测 200ms 很常见），
    分章边界取"下一章第一段的 start"会在时间轴上留下空洞，
    ``validate_coverage`` 当场就报「第 2 章与上一章不相接」。
    正确做法是让**边界由上一章的 end 决定**（间隙算给前一章）。
    错误写法（曾用）：只处理 ``start < prev.end``（重叠），
    结果间隙被原样保留下来。
    """
    if not chapters:
        return []
    duration_ms = max(0, int(duration_ms))
    fixed: list[TranscriptChapter] = []
    for i, ch in enumerate(chapters):
        start = 0 if not fixed else fixed[-1].end
        if i == len(chapters) - 1:
            end = max(start, duration_ms)
        else:
            end = min(max(int(ch.end), start + 1), duration_ms)
        if end <= start:
            end = min(start + 1, duration_ms) if duration_ms > start else start + 1
        if fixed and end <= start:  # 时间被前一章吃光 → 内容并进前一章
            fixed[-1].text = join_segment_text(
                [
                    VideoSegment(i=0, start=0, end=0, text=fixed[-1].text),
                    VideoSegment(i=1, start=0, end=0, text=ch.text),
                ]
            )
            fixed[-1].summary = fixed[-1].summary or ch.summary
            continue
        fixed.append(
            TranscriptChapter(
                title=ch.title, start=start, end=end, text=ch.text, summary=ch.summary
            )
        )
    if fixed:
        fixed[0].start = 0
        fixed[-1].end = max(fixed[-1].start, duration_ms)
    return fixed


def validate_coverage(
    chapters: Sequence[TranscriptChapter], duration_ms: int
) -> None:
    """断言分章时间轴**覆盖全片且不越界**（测试与自检共用）。

    检查顺序有讲究：**先查单章范围（越界/空章），再查首尾与相接**。
    反过来写的话，``[[0, 11000]]``（越界）会先撞上"末章没覆盖到片尾"，
    报出来的原因跟真实问题不是一回事。
    """
    if not chapters:
        raise TextModelSchemaError("分章结果为空")
    for i, ch in enumerate(chapters):
        if ch.end <= ch.start:
            raise TextModelSchemaError(f"第 {i + 1} 章时间轴为空：[{ch.start},{ch.end}]")
        if ch.start < 0 or ch.end > duration_ms:
            raise TextModelSchemaError(
                f"第 {i + 1} 章越界：[{ch.start},{ch.end}]，片长 {duration_ms}"
            )
    if chapters[0].start != 0:
        raise TextModelSchemaError(f"首章没有从 0 开始：{chapters[0].start}")
    if chapters[-1].end != duration_ms:
        raise TextModelSchemaError(
            f"末章没有覆盖到片尾：{chapters[-1].end} ≠ {duration_ms}"
        )
    for i, ch in enumerate(chapters):
        if i and ch.start != chapters[i - 1].end:
            raise TextModelSchemaError(
                f"第 {i + 1} 章与上一章不相接：{ch.start} ≠ {chapters[i - 1].end}"
            )


# ── 机械分节（LLM 不可用时的**如实降级**）──────────────────────────────
def mechanical_chapters(
    segments: Sequence[VideoSegment],
    *,
    duration_ms: int,
    max_chapters: int = MAX_CHAPTERS,
) -> list[TranscriptChapter]:
    """不用 LLM 的分节：**按静音间隙**切（真实信号，不是编造内容）。

    只在 LLM 不可用时使用；标题是"分节 N"，调用方必须把
    ``chapter_source="mechanical"`` 如实透传给 UI，不能假装这是语义分章。
    """
    if not segments:
        return []
    duration_ms = max(int(duration_ms), int(segments[-1].end))
    # 找最大的若干间隙
    gaps = [
        (segments[i + 1].start - segments[i].end, i)
        for i in range(len(segments) - 1)
    ]
    gaps = [g for g in gaps if g[0] > 1200]  # 1.2 秒以上才算"换段"
    gaps.sort(reverse=True)
    cuts = sorted(i for _gap, i in gaps[: max(0, max_chapters - 1)])
    bounds = [0, *[i + 1 for i in cuts], len(segments)]
    out: list[TranscriptChapter] = []
    for n, (a, b) in enumerate(zip(bounds, bounds[1:]), start=1):
        if b <= a:
            continue
        s_ms = 0 if n == 1 else segments[a].start
        e_ms = duration_ms if b >= len(segments) else segments[b - 1].end
        block = segments[a:b]
        out.append(
            TranscriptChapter(
                title=f"分节 {n}",
                start=max(0, s_ms),
                end=max(0, min(e_ms, duration_ms)),
                text=join_segment_text(block),
                summary="",
            )
        )
    return fill_gaps(out, duration_ms)


# ── 编排 ────────────────────────────────────────────────────────────────
@dataclass
class TranscriptResult:
    """分章 + 摘要（``source`` 说明是人话还是机械分节）。"""

    chapters: list[TranscriptChapter]
    summary: str
    source: str = "llm"  # llm | mechanical | none
    windows: int = 1
    note: str = ""


def analyze_transcript(
    llm: TextModel | None,
    segments: Sequence[VideoSegment],
    *,
    duration_ms: int,
    max_chapters: int = MAX_CHAPTERS,
    video_title: str = "",
    allow_mechanical_fallback: bool = True,
    on_progress: Callable[[float, str], None] | None = None,
) -> TranscriptResult:
    """S4+S5：分章 + 摘要。

    :param llm: ``(prompt, schema) -> dict``；``None`` 或调用失败 → 如实降级为机械分节，
        **绝不编造**章节标题/摘要（``result.source`` 会说明）。
    """
    if not segments:
        return TranscriptResult([], "", source="none", note="没有 ASR 段落（ASR 不可用）")
    duration_ms = max(int(duration_ms), int(segments[-1].end))

    if llm is not None:
        try:
            windows = plan_windows(segments)
            candidates: list[RawChapter] = []
            summary = ""
            for wi, (a, b) in enumerate(windows):
                partial = len(windows) > 1
                prompt = build_chapter_prompt(
                    segments[a : b + 1],
                    duration_ms=duration_ms,
                    max_chapters=max_chapters,
                    start_i=a,
                    end_i=b,
                    video_title=video_title,
                    partial=partial,
                )
                payload = llm(prompt, CHAPTERS_SCHEMA)  # 串行（并发=1）
                raw, win_summary = parse_chapters(payload, segments=segments)
                candidates.extend(raw)
                if win_summary and not summary:
                    summary = win_summary
                if on_progress is not None:
                    on_progress((wi + 1) / (len(windows) + 1), "文稿分章")
            chapters = normalize_chapters(
                candidates, segments, duration_ms=duration_ms, max_chapters=max_chapters
            )
            if not summary:
                summary = _summarize_from_chapters(llm, chapters, duration_ms, video_title)
            if on_progress is not None:
                on_progress(1.0, "全文摘要")
            validate_coverage(chapters, duration_ms)
            return TranscriptResult(
                chapters=chapters, summary=summary, source="llm", windows=len(windows)
            )
        except Exception as exc:  # noqa: BLE001 - LLM 是外部依赖，任何失败都降级但不编造
            # ⚠️ **不要**在这里写 `except TextModelUnavailable: raise`：
            #    LLM 挂了（402 额度耗尽 / 超时 / 模型下线）时，**机械分节比"没有章节"好得多** ——
            #    时间轴仍要可导航，标题如实标成"分节 N"（不编造内容）。
            #    真实踩过：额度耗尽那次若直接抛出去，产物 chapters 为空，UI 连导航都没有。
            log.warning("分章失败，降级为机械分节：%s", exc)
            if not allow_mechanical_fallback:
                raise
            return _mechanical_result(segments, duration_ms, max_chapters, note=f"LLM 分章失败：{exc}")

    if not allow_mechanical_fallback:
        raise TextModelUnavailable("没有可用的文本模型，无法分章")
    return _mechanical_result(segments, duration_ms, max_chapters, note="LLM 不可用")


def _mechanical_result(
    segments: Sequence[VideoSegment],
    duration_ms: int,
    max_chapters: int,
    *,
    note: str,
) -> TranscriptResult:
    chapters = mechanical_chapters(segments, duration_ms=duration_ms, max_chapters=max_chapters)
    validate_coverage(chapters, duration_ms)
    return TranscriptResult(
        chapters=chapters, summary="", source="mechanical", note=note
    )


def _summarize_from_chapters(
    llm: TextModel,
    chapters: Sequence[TranscriptChapter],
    duration_ms: int,
    video_title: str,
) -> str:
    """没有整篇摘要时，用分章摘要拼一句（并明确标注是拼的，不冒充整体摘要）。"""
    parts = [c.summary for c in chapters if c.summary]
    if parts:
        return "（自动汇总各章摘要）" + " ".join(parts)
    return ""


__all__ = [
    "CHAPTERS_SCHEMA",
    "SUMMARY_SCHEMA",
    "MAX_CHAPTERS",
    "MAX_WINDOW_CHARS",
    "TextModel",
    "RawChapter",
    "TranscriptResult",
    "analyze_transcript",
    "build_chapter_prompt",
    "build_summary_prompt",
    "plan_windows",
    "segments_digest",
    "parse_chapters",
    "normalize_chapters",
    "fill_gaps",
    "join_segment_text",
    "validate_coverage",
    "mechanical_chapters",
]
