# -*- coding: utf-8 -*-
"""长文本分块测试（`worker/pipeline/chunk.py`）—— **不截断 + 跨度可回溯**。

覆盖 Lead 的四条验收：
1. 超长单元 → 真的分块（**块数 > 1**）
2. 每块都能**定位回原文**（字符区间 + 映射 span 落在单元 span 内）
3. **短单元不分块**（反例，防"全都分"）
4. 分块前后**卡片总数不减少**（对比：截断会少）
"""

from __future__ import annotations

import pytest

from worker.models import Span
from worker.pipeline import chunk as chunk_mod


# ═══════════════════════════════════════════════════════════════════════
# ① 分块：块数 > 1
# ═══════════════════════════════════════════════════════════════════════

def test_long_text_is_chunked_not_truncated() -> None:
    """超长单元 → 多块（**这是本模块存在的理由**）。"""
    text = "索引优化方法。" * 4200          # 字面长度 4200*7 = 29400 > 24000
    assert len(text) > 24000
    chunks = chunk_mod.split_unit(text, Span("page", 66, 75), 24_000)
    assert len(chunks) > 1, "超长正文必须被分块，而不是截断"
    assert len(chunks) == 2


def test_no_truncation_bytes_are_preserved() -> None:
    """★ **不丢字**：所有块拼接 == 原文（截断版会在这里失败）。"""
    text = "段落内容。" * 6000
    chunks = chunk_mod.split_unit(text, Span("page", 1, 10), 24_000)
    assert "".join(c.text for c in chunks) == text, "分块必须无损；任何字符都不能丢"


def test_chunk_ranges_are_contiguous_and_cover_all() -> None:
    """字符区间**连续、无重叠、全覆盖**。"""
    text = "abcdefghij" * 3000               # 30000 > 24000
    chunks = chunk_mod.split_unit(text, Span("char", 0, len(text)), 24_000)
    assert chunks[0].char_start == 0
    assert chunks[-1].char_end == len(text)
    for a, b in zip(chunks, chunks[1:]):
        assert a.char_end == b.char_start, "块之间不许有缝隙（缝隙 = 静默丢内容）"
    # 区间必须与文本切片一致（可核对）
    for c in chunks:
        assert c.text == text[c.char_start:c.char_end]


def test_split_prefers_natural_boundaries() -> None:
    """优先在句号/换行处断开（不在句子中间劈开）。"""
    text = ("第一句。" * 5000) + ("第二段。" * 5000)
    chunks = chunk_mod.split_unit(text, Span("page", 1, 100), 24_000)
    for c in chunks[:-1]:
        # 除最后一块外，都应以句末/换行结束（自然边界）
        assert c.text.rstrip().endswith(("。", "\n", "；", "！", "？")), repr(c.text[-10:])


# ═══════════════════════════════════════════════════════════════════════
# ② 跨度可回溯
# ═══════════════════════════════════════════════════════════════════════

def test_every_chunk_span_is_inside_unit_span() -> None:
    """★ 每块的映射 span **必须夹在单元 span 内**（否则锚点越界 = 不可回溯）。"""
    unit = Span("page", 66, 75)
    text = "内容。" * 8000                    # 24000 字
    chunks = chunk_mod.split_unit(text, unit, 12_000)
    assert len(chunks) >= 2
    for c in chunks:
        assert unit.start <= c.span.start <= unit.end
        assert unit.start <= c.span.end <= unit.end
        assert c.span.start <= c.span.end
        assert c.span.kind == "page"


def test_chunk_spans_are_ordered_and_monotonic() -> None:
    """块的 span 随块序**单调不减**（学生看到的顺序与原文一致）。"""
    unit = Span("page", 10, 30)
    chunks = chunk_mod.split_unit("文字。" * 9000, unit, 10_000)
    assert len(chunks) >= 3
    prev = unit.start
    for c in chunks:
        assert c.span.start >= prev, "块 span 必须单调（否则展示顺序会乱）"
        prev = c.span.start


def test_char_span_mapping_is_exact() -> None:
    """`char` span 的映射是**精确**的（偏移同源，不需要按比例）。"""
    text = "x" * 30_000
    unit = Span("char", 100, 30_099)          # 单元覆盖 [100, 30099]
    chunks = chunk_mod.split_unit(text, unit, 24_000)
    assert len(chunks) >= 2
    assert chunks[0].span.start == 100, "char span 应从单元起点精确开始"
    # 第二块的起点 = 100 + 第一块的长度（精确，不是近似）
    assert chunks[1].span.start == 100 + chunks[0].chars


def test_page_span_mapping_reflects_char_proportion() -> None:
    """`page` span 按**字符比例**映射（长单元 → 前半块落在前半页）。"""
    text = "y" * 36_000
    unit = Span("page", 1, 12)                # 12 页
    chunks = chunk_mod.split_unit(text, unit, 24_000)
    assert len(chunks) == 2
    # 第一块 ~2/3 字符 → 应覆盖前 ~2/3 页（不是整个 1-12）
    assert chunks[0].span.start == 1
    assert chunks[0].span.end < unit.end, "第一块不应覆盖整个单元 span（那等于没定位）"
    assert chunks[1].span.end == unit.end


def test_real_world_sample_66_75() -> None:
    """★ 真库样本：`span=page 66-75` 的 37,829 字符单元（实测最长）。

    用**精确长度**构造（`"MySQL 手册内容行。"` 是 12 字符）：`12 × 3153 = 37,836`。
    """
    unit_text = "MySQL 手册内容行。"
    assert len(unit_text) == 12
    text = unit_text * 3153                     # 37,836 字符（对齐真库 37,829 的量级）
    assert len(text) == 37_836
    chunks = chunk_mod.split_unit(text, Span("page", 66, 75), 24_000)
    assert len(chunks) == 2
    assert chunks[0].span.start == 66
    assert chunks[1].span.end == 75
    # 两块 span 不重叠（各自定位到不同页区间）
    assert chunks[0].span.end <= chunks[1].span.start
    assert "".join(c.text for c in chunks) == text


# ═══════════════════════════════════════════════════════════════════════
# ③ 短单元不分块（反例）
# ═══════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("n", [0, 1, 100, 999, 1_000, 12_000, 23_999, 24_000])
def test_short_text_is_single_chunk(n: int) -> None:
    """★ 不超过阈值 → **恒为 1 块**（防"全都分"的回归；`0` 长度返回 0 块）。"""
    text = ("内容。" * (n // 3 + 1))[:n]
    chunks = chunk_mod.split_unit(text, Span("page", 1, 5), 24_000)
    if n == 0:
        assert chunks == [], "空正文 → 0 块（调用方据此计 units_empty）"
    else:
        assert len(chunks) == 1, f"{n} 字不应被分块"
        assert chunks[0].char_start == 0
        assert chunks[0].char_end == n
        assert chunks[0].text == text


def test_threshold_boundary_exactly_one_over() -> None:
    """边界：恰好超出 1 个字符 → 2 块（阈值是"包含"而非"超过"）。"""
    cap = 24_000
    just = "a" * cap
    over = "a" * (cap + 1)
    assert len(chunk_mod.split_unit(just, Span("page", 1, 1), cap)) == 1
    assert len(chunk_mod.split_unit(over, Span("page", 1, 1), cap)) == 2


def test_min_chunk_chars_floor_prevents_pathological_splitting() -> None:
    """病态小阈值 → 被 `MIN_CHUNK_CHARS` 兜住（不把正文切成几百块）。"""
    text = "x" * 5_000
    chunks = chunk_mod.split_unit(text, Span("page", 1, 1), 10)   # 传 10，远小于下限
    assert len(chunks) <= 5, "必须被 MIN_CHUNK_CHARS 兜住，不能切成 500 块"


# ═══════════════════════════════════════════════════════════════════════
# ④ 卡片数不减少（截断会少）+ 调用数如实
# ═══════════════════════════════════════════════════════════════════════

def test_chunking_yields_more_content_than_truncation() -> None:
    """★ **核心判据**：分块覆盖的字数 > 截断覆盖的字数（截断会丢尾部）。

    这条正是"红证"要打的靶子：把实现改回截断 → 本断言必红。
    """
    cap = 24_000
    unit_text = "知识点内容。"
    assert len(unit_text) == 6
    text = unit_text * 7000                   # 42,000 字（> cap）
    assert len(text) == 42_000
    chunks = chunk_mod.split_unit(text, Span("page", 1, 20), cap)
    covered = sum(c.chars for c in chunks)
    truncated = min(len(text), cap)           # 截断版只能覆盖这么多
    assert len(chunks) > 1
    assert covered > truncated, "分块覆盖必须严格多于截断（多出尾部内容）"
    assert covered == len(text)
    assert len(text) - truncated == 18_000, "被截断版丢弃的字符数（可对账）"


def test_estimate_chunks_matches_actual_split() -> None:
    """`estimate_chunks` 必须等于逐个 `split_unit` 的真实块数（不许两套口径）。

    ⚠️ 空正文：`split_unit` 返回 **0 块**，而 `estimate_chunks` 用 `max(1, ...)`
    记 **1 次**（"这个单元要过一次"）—— 两者的差异是**刻意的**：
    `estimate_chunks` 回答"计划里有多少个 item 位"（空单元也占位，好让闸门看见），
    `split_unit` 回答"正文能切出几块"（空正文切不出）。
    """
    texts = ["a" * 100, "b" * 24_001, "c" * 50_000, "", "d" * 24_000]
    expect = sum(max(1, len(chunk_mod.split_unit(t, Span("page", 1, 1), 24_000))) for t in texts)
    assert chunk_mod.estimate_chunks(texts, 24_000) == expect
    # 短文本时等于单元数（行为与改前一致）
    assert chunk_mod.estimate_chunks(["a" * 100] * 7, 24_000) == 7
    # 空正文仍占 1 个位（Node 闸门要能看见它）
    assert chunk_mod.estimate_chunks([""], 24_000) == 1
    assert chunk_mod.split_unit("", Span("page", 1, 1), 24_000) == []


def test_estimate_chunks_counted_on_real_long_unit_shape() -> None:
    """真库形状：840 个 ≥8k 单元里 111 个 >24k → 调用数由 840 增至 951。"""
    texts = ["x" * 24_000] * (840 - 111) + ["y" * 37_829] * 111
    calls = chunk_mod.estimate_chunks(texts, 24_000)
    assert calls == (840 - 111) + 111 * 2 == 951, f"实测应为 951，得到 {calls}"


def test_max_chunk_count_reports_worst_case() -> None:
    """`max_chunk_count` 报最碎的那个单元（诊断用）。"""
    assert chunk_mod.max_chunk_count(["a" * 100, "b" * 100_000], 24_000) == 5
    assert chunk_mod.max_chunk_count([], 24_000) == 0


# ═══════════════════════════════════════════════════════════════════════
# ★★ 回归：空正文单元**必须仍出现在 plan 里**（不许被分块悄悄吃掉）
#
# 背景（我引入的真回归，`npm test` 唯一失败）：
#   分块第一版写 `for ch in split_unit(pu.text)`:  ← 空正文 → 0 块 → 循环不执行
#   → 空正文单元**根本不在 plan items 里** → Node 侧闸门 `known=false`
#   → `W_EMPTY_INPUT` **永不触发** → `test/extract_empty_unit_gate.test.ts` 红。
#   本质：worker 悄悄替 Node 做了"跳过" ⟹ 两处判断（坑 27 家族），
#   且把 Node 的防线**架空**（"看起来有防线、实际不触发"）。
# ═══════════════════════════════════════════════════════════════════════

def test_empty_chunk_helper_shape() -> None:
    """`empty_chunk()` 是零长块，且 span 与本单元一致（占位但不伪造内容）。"""
    c = chunk_mod.empty_chunk(Span("char", 100, 100))
    assert c.chars == 0
    assert c.text == ""
    assert c.index == 0 and c.total == 1
    assert c.char_start == 0 and c.char_end == 0
    assert (c.span.kind, c.span.start, c.span.end) == ("char", 100, 100)


def test_empty_unit_still_listed_in_plan() -> None:
    """★★ **空正文单元必须出现在 `plan_prompts` 的 items 里**（否则闸门被架空）。

    这条是上面那个回归的**守卫**：把 `empty_chunk` 拿掉 → 本测试必红。
    """
    from worker.models import Unit
    from worker.pipeline.extract_core import plan_prompts

    units = [
        Unit(id="unt_title_empty", doc_id="doc_t", ord=1, title="数据库索引", level=1,
             parent_id=None, span=Span("char", 100, 100), text=""),
        Unit(id="unt_body_text", doc_id="doc_t", ord=2, title="聚簇索引", level=1,
             parent_id=None, span=Span("char", 200, 240),
             text="聚簇索引决定表中数据在磁盘上的物理存储顺序。叶子页写满时发生页分裂。"),
    ]
    out = plan_prompts(units=units)
    by_unit = {it["unit_id"]: it for it in out["items"]}

    # ① 空单元**在** items 里（这是闸门能报 W_EMPTY_INPUT 的前提）
    assert "unt_title_empty" in by_unit, "★ 空正文单元必须仍列进 plan（否则 Node 闸门看不到它）"
    empty_item = by_unit["unt_title_empty"]
    assert empty_item["chars"] == 0
    assert empty_item["empty_body"] is True, "空正文明示，供调用方跳过 LLM"
    # ② 有正文的单元照常在
    assert by_unit["unt_body_text"]["chars"] > 0
    assert by_unit["unt_body_text"]["empty_body"] is False
    # ③ ★ 计费调用数**不含**空单元（它不会发 LLM；算进去就是虚报花费）
    assert out["chunks"] == 1, f"计费调用数应为 1（只有有正文的单元），得到 {out['chunks']}"
    assert out["units_planned"] == 2
    assert out["empty_units"] == 1


def test_empty_unit_key_matches_between_plan_and_convert() -> None:
    """空单元的 key 在 plan 与 convert 两侧**一致**（否则 convert 会报 E_PICK_KEY）。"""
    from worker.models import Unit
    from worker.pipeline.extract_core import convert_payloads, plan_prompts

    units = [
        Unit(id="unt_e", doc_id="doc_t", ord=1, title="空", level=1,
             parent_id=None, span=Span("char", 5, 5), text=""),
    ]
    out = plan_prompts(units=units)
    assert len(out["items"]) == 1
    key = out["items"][0]["key"]
    # 即使 Node 对空单元也发了 payload（不该发，但两侧索引必须同构），也不能报"未知单元"
    conv = convert_payloads(doc_id="doc_t", units=units, payloads=[{"key": key, "data": {"cards": []}}])
    assert conv.stats.get("units_failed") in (0, None), "两侧 key 必须一致，不许 E_PICK_KEY"
    assert not any(e.get("code") == "E_PICK_KEY" for e in conv.errors)


def test_chunked_unit_plan_items_share_one_unit_id_with_distinct_keys() -> None:
    """★ 长单元的多块：**同一个 `unit_id`、不同的 key/span**（合并回同一单元的依据）。

    ⚠️ 注意**两级切分是叠加的**：`pick_units` 先按**页预算**（`MAX_PAGES_PER_UNIT=8`）
    把 66-75 切成窗口（66-73 / 74-75），**再**由 `chunk.split_unit` 按**字符预算**
    把每个窗口切成块。所以这里用 8 页以内的 span（66-70）来**单独验证字符级分块**，
    避免两级混在一起让断言含糊。
    """
    from worker.models import Unit
    from worker.pipeline.extract_core import plan_prompts

    unit_text = "内容。"
    assert len(unit_text) == 3
    long_text = unit_text * 12_000            # 36,000 字 > 24,000
    assert len(long_text) == 36_000
    units = [
        # span 66-70 = 5 页 ≤ 8 页预算 → **不会被页窗口切开**，只剩字符级分块
        Unit(id="unt_long", doc_id="doc_t", ord=1, title="长章", level=1,
             parent_id=None, span=Span("page", 66, 70), text=long_text),
    ]
    out = plan_prompts(units=units)
    items = out["items"]
    assert len(items) >= 2, f"36k 字必须被分块，得到 {len(items)}"
    assert len(items) == out["chunks"], "chunks 必须等于 items 数（都是非空块）"
    assert {it["unit_id"] for it in items} == {"unt_long"}, "多块必须同属一个 unit_id（要合并回同一单元）"
    keys = {it["key"] for it in items}
    assert len(keys) == len(items), "★ 多块的 key 必须互不相同（否则 convert 只认第一块、其余卡片全丢）"
    spans = [(it["span"]["kind"], it["span"]["start"], it["span"]["end"]) for it in items]
    assert len(set(spans)) == len(items), "多块的 span 也必须互不相同（各自定位）"
    # 单元级 span 原样保留（未被页窗口切开的场景）——它是落库锚点
    assert all(it["unit_span"] == {"kind": "page", "start": 66, "end": 70} for it in items)
    assert out["chunked_units"] == 1
    # 块 span 必须夹在单元 span 内（可回溯）
    for it in items:
        assert 66 <= it["span"]["start"] <= it["span"]["end"] <= 70
    # 每块都带自己的字符区间（可回溯到原文哪一段）
    for it in items:
        assert it["chunk"]["total"] == len(items)
        assert it["chunk"]["char_end"] > it["chunk"]["char_start"]
    # 字符区间连续覆盖全文（不丢字）
    ordered = sorted(items, key=lambda x: x["chunk"]["char_start"])
    assert ordered[0]["chunk"]["char_start"] == 0
    assert ordered[-1]["chunk"]["char_end"] == len(long_text)
    for a, b in zip(ordered, ordered[1:]):
        assert a["chunk"]["char_end"] == b["chunk"]["char_start"]


def test_page_window_and_char_chunk_compose() -> None:
    """★ **两级切分叠加**：页窗口（`pick_units`）+ 字符分块（`chunk`）都要生效。

    单元 `span=66-75`（10 页 > 8 页预算）→ 页窗口切成 66-73 / 74-75；
    第一个窗口的正文又超 24k 字符 → 再被字符分块。
    ⟹ 结果是"窗口 × 块"的笛卡尔展开，**每一块都能定位到具体的页区间 + 字符区间**。
    """
    from worker.models import Unit
    from worker.pipeline.extract_core import plan_prompts

    text = "内容。" * 12_000                  # 36,000 字
    units = [
        Unit(id="unt_win", doc_id="doc_t", ord=1, title="超长章", level=1,
             parent_id=None, span=Span("page", 66, 75), text=text),
    ]
    out = plan_prompts(units=units)
    items = out["items"]
    # 至少 2 个窗口 → 至少 2 个 item；且每个 item 的 unit_span 都被窗口夹过
    assert len(items) >= 2
    unit_spans = {(it["unit_span"]["start"], it["unit_span"]["end"]) for it in items}
    assert unit_spans != {(66, 75)}, "页窗口必须生效（unit_span 不再等于原始 66-75）"
    # 每个 item 的块 span ⊆ 它自己的 unit_span（两级都夹得住）
    for it in items:
        us, sp = it["unit_span"], it["span"]
        assert us["start"] <= sp["start"] <= sp["end"] <= us["end"], f"块 {sp} 越出窗口 {us}"
    # 所有块拼起来仍是完整原文（两级切分都不许丢字）
    assert sum(it["chars"] for it in items) == len(text)
