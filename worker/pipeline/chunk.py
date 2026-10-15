# -*- coding: utf-8 -*-
"""长文本分块（**跨度保留**）—— 把"超长单元被截断"改成"超长单元被分块"。

## 背景（本机实测，非推测）

改前两处**截断**（`chunk_chars` 是"死旋钮"，坑 24）：

```python
# extract_core.py:966       body = (pu.text or "")[:chunk_chars]
# extract.py:206            body = pu.text[: self.settings.llm_chunk_chars]
```

`[实测]` 真库 `data/course_kb.sqlite3`（2873 单元）：

| 阈值 | 单元数 |
|---|---|
| ≥ 8,000 字符 | **840** |
| ≥ 12,000 | 577 |
| ≥ 16,000 | 407 |
| ≥ 20,000 | 265 |
| **> 24,000（= 默认 `chunk_chars`，**内容真丢**）** | **111** |

最长单元 **37,829 字符**（`span=page 66-75`，`2.1.4.4 Signature Checking Using R`）。
⟹ **111 个单元超出 24k 的部分被静默丢弃** —— "看起来成功"（AGENTS 坑清单的判据）。

## 为什么不能只按"页窗口"解决

`units.pick_units` **已经**按**页数**切窗（`MAX_PAGES_PER_UNIT=8`），
但**一页正文可以很长**：实测最长 10 页窗口 = 37,829 字符
（≈ 3,783 字符/页，手册页密度高）。
⟹ **页窗口是"跨度预算"，不是"字符预算"**，两者都要有。

## 设计（三条约束一起满足）

1. **不截断**：超长单元切成 ≤ `chunk_chars` 的块，**逐块调用 LLM**，结果合并回同一单元。
2. **★ 跨度可回溯**：每块记住它在**本单元正文里的字符偏移** `[char_start, char_end)`，
   并按偏移**按比例**映射到单元的 `span`（页码/时间/字符）——
   于是每块抽出的卡片拿到的 `span` 就落在**它真正来源的那一段**上，
   而不是"整个单元的 span"（后者会让"证据可回溯"退化成"能定位到这一章"）。
3. **短单元不分块**：`len(text) <= chunk_chars` → 原样一块，行为与改前**完全一致**
   （防"全都分"的回归）。

## 为什么"按比例映射 span"是正确的而不是凑合

单元正文是**连续抽取**自其 span 覆盖的页面（`text_provider` 回源时逐页拼接）。
在"正文长度 ∝ 覆盖页数"的假设下，第 k 块的字符区间 `[a,b)` 对应
`span.start + (a/len)*size … span.start + (b/len)*size`。
`[实测]` 这个假设对**同质正文**成立；对"某一页特别长"的单元是**近似**。
⟹ 所以映射结果**必须夹在本单元 span 内**（`card_span()` 已有这个夹取），
且 `chunk_index` / 字符偏移**原样保留在卡片上** —— 真正的精确锚点是字符偏移，
span 是给人看的近似定位。**两者都给，不假装 span 是精确的。**
"""

from __future__ import annotations

from dataclasses import dataclass

from worker.models import Span

#: 默认块上限（与 `worker/config.py::llm_chunk_chars` / `cli.py` 的 24_000 一致）。
DEFAULT_CHUNK_CHARS = 24_000

#: 块下限：太小的块不值得一次 LLM 调用（避免病态配置把正文切成几百块）。
MIN_CHUNK_CHARS = 1_000


@dataclass(frozen=True)
class Chunk:
    """一个待抽取的块 —— **自含**，不依赖父单元即可构造提示词。"""

    #: 块序号（0-based）
    index: int
    #: 总块数
    total: int
    #: 本块正文（**原文切片，逐字**）
    text: str
    #: 在**本单元正文**里的字符区间 `[start, end)`
    char_start: int
    char_end: int
    #: 按比例映射到单元 span 的位置（**已夹在单元 span 内**）
    span: Span

    @property
    def chars(self) -> int:
        return len(self.text)

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "total": self.total,
            "char_start": self.char_start,
            "char_end": self.char_end,
            "chars": self.chars,
            "span": self.span.to_dict(),
        }


def split_text(text: str, chunk_chars: int = DEFAULT_CHUNK_CHARS) -> list[tuple[int, int]]:
    """把正文切成 ``[(char_start, char_end), ...]``（**不丢字**，逐字连续覆盖）。

    **优先在自然边界断开**（空行 > 换行 > 句号/分号 > 空格），
    在"不超过 `chunk_chars`"的前提下尽量靠后断 —— 这样块边界落在句子之间，
    而不是把一句话劈成两半（劈开会让两块都抽不出完整卡片）。

    ⚠️ **不丢字**是本函数最重要的不变量：所有块拼接 == 原文。
    因此"边界调整"只能**向前**收（`end` 变小），剩余部分归下一块 ——
    绝不跳过任何字符（跳过 = 静默丢内容，正是本模块要消灭的东西）。
    """
    s = text or ""
    n = len(s)
    if n == 0:
        return []
    cap = max(MIN_CHUNK_CHARS, int(chunk_chars))
    if n <= cap:
        return [(0, n)]

    #: 断点候选（**从后往前**找，尽量晚断 = 块更满）
    breaks = ("\n\n", "\n", "。", "；", "！", "？", ". ", "; ", " ")
    out: list[tuple[int, int]] = []
    start = 0
    while start < n:
        end = min(n, start + cap)
        if end < n:
            # 只在窗口的**后半段**找断点，避免"早断"导致块过小（碎块浪费调用）
            floor = start + cap // 2
            best = -1
            for br in breaks:
                pos = s.rfind(br, floor, end)
                if pos > best:
                    best = pos + len(br)  # 断在**分隔符之后**（含标点，读起来完整）
            if best > start:
                end = best
        out.append((start, end))
        start = end
    return out


def map_span(unit_span: Span, char_start: int, char_end: int, total_chars: int) -> Span:
    """字符区间 → 单元 span 上的区间（**按比例 + 夹取**）。

    ``char`` span 的映射是**精确**的（偏移同源，直接相加）；
    ``page/slide/time`` 是**按比例近似**（见模块 docstring 的诚实说明），
    但保证：① 落在单元 span 内 ② `end >= start` ③ 非空区间至少覆盖 1 个单位。
    """
    if total_chars <= 0:
        return unit_span
    size = int(unit_span.size)
    if unit_span.kind == "char":
        # 精确：char span 的 start 就是正文起点
        return Span("char", int(unit_span.start) + char_start, int(unit_span.start) + max(char_start, char_end - 1))
    lo = int(unit_span.start) + int(size * (char_start / total_chars))
    hi = int(unit_span.start) + int(size * (max(char_start, char_end - 1) / total_chars))
    lo = max(int(unit_span.start), min(int(unit_span.end), lo))
    hi = max(lo, min(int(unit_span.end), hi))
    return Span(unit_span.kind, lo, hi)


def empty_chunk(unit_span: Span) -> Chunk:
    """空正文单元的**占位块**（`chars: 0`）。

    ## 为什么空正文也要有"一个块"
    这是"**谁负责跳过空正文**"的单一职责问题。
    真正判"空正文不发 LLM + 报 `W_EMPTY_INPUT`"的是 **Node 侧闸门**
    （`tasks/extract.ts`，它遍历 `extract.plan` 的 items 来判断"这个单元正文为空"）。

    ⟹ plan **必须把空正文单元也列出来**，否则闸门 `known=false` → 不触发 →
    **防线被架空**（"看起来有防线、实际不触发"，比没有防线更危险）。
    worker 只**如实描述**（`chars=0`），**不替 Node 做跳过决定**（两处判断 = 两套真相）。
    """
    return Chunk(
        index=0,
        total=1,
        text="",
        char_start=0,
        char_end=0,
        span=Span(unit_span.kind, int(unit_span.start), int(unit_span.end)),
    )


def split_unit(text: str, unit_span: Span, chunk_chars: int = DEFAULT_CHUNK_CHARS) -> list[Chunk]:
    """把一个单元的正文切成若干 :class:`Chunk`（**短文本返回单块**）。

    ⚠️ 空正文返回 **0 块**（"没有内容可切"是事实）——
    需要"空单元也占一个位"的调用方（如 `plan_prompts`）应显式用 :func:`empty_chunk`。
    这个区分是刻意的：**"切不出块"与"有一个空块"是两件事**，调用方按自己的职责选。
    """
    spans = split_text(text, chunk_chars)
    total = len(spans)
    n = len(text or "")
    return [
        Chunk(
            index=i,
            total=total,
            text=(text or "")[a:b],
            char_start=a,
            char_end=b,
            span=map_span(unit_span, a, b, n),
        )
        for i, (a, b) in enumerate(spans)
    ]


def estimate_chunks(texts: list[str], chunk_chars: int = DEFAULT_CHUNK_CHARS) -> int:
    """预估**实际 LLM 调用数**（分块后）—— 供 `needs_confirm` 闸门与 meta 使用。

    ⚠️ 必须按**分块后**算：长单元会变成多次调用。
    `[实测]` 真库 840 个 ≥8k 单元按 24k 分块 → **951 次调用**（原 840 次，**多 111 次**）。
    若闸门仍按"单元数"算，用户看到的代价会**偏小** → 正是坑 24 的同族（承诺与生效不一致）。
    """
    return sum(max(1, len(split_text(t or "", chunk_chars))) for t in texts)


def max_chunk_count(texts: list[str], chunk_chars: int = DEFAULT_CHUNK_CHARS) -> int:
    """单个单元的最大块数（诊断用：有没有单元被切得很碎）。"""
    return max((len(split_text(t or "", chunk_chars)) for t in texts), default=0)
