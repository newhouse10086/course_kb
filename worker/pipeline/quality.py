"""抽取质量闸门 —— 防「看起来成功」（`docs/FUNCTIONAL_SPEC.md` 坑 10 的同族）。

## 为什么需要它（`[实测]` 真实事故）

用户上传《数据库系统概论 第5版》（434 页扫描件）后看到的状态是：
```
parse  : done ✅
units  : 167  ✅
然后   : cards=1, edges=0, entities=1
任务   : "完成"
文档   : status='ready'
```
**从这些数字完全看不出问题** —— 用户的原话是「**显示可用，抽取结果在哪**」。
根因（已查明）：该 PDF 是纯扫描件，**167 个 unit 的正文合计 0 字符**，
发给 LLM 只能得到空内容/非 JSON，于是 167 个单元只出 1 张卡。

⟹ **光修解析层不够，必须让"抽不出东西"这件事本身可被机器发现。**
本模块把「质量异常」变成**结构化、可上报、可断言**的字段（`documents.meta.extract_quality`）。

## 设计原则

1. **只诊断，不改数据** —— 本模块**绝不**删卡片/改状态。它产出判定，由调用方决定怎么办。
2. **阈值必须可解释** —— 每个 `suspect` 都写明命中了哪条判据与当时的实际数字。
3. **`empty_text` 与 `no_cards` 分开** —— 两者根因不同（前者是解析/OCR 问题，后者是抽取问题），
   混成一个「抽取失败」会把排查方向带偏。
4. **不许用"看起来正常"当通过** —— `ok=True` 只在**全部判据通过**时给出。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

#: `units > N` 时才有意义判"抽不出卡片"（小文档本来就可能没有知识点）。
MIN_UNITS_FOR_YIELD_CHECK = 5

#: 卡片/单元 比例低于此值 → 疑似抽取失败（正常教材经验值约 0.3~3 张卡/单元）。
#: 取 0.02 是**保守**的：只在"几乎没抽出东西"时报，不误伤内容稀疏的资料。
LOW_YIELD_CARDS_PER_UNIT = 0.02

#: 正文为空（或近空）的单元占比超过此值 → 疑似解析/OCR 问题。
EMPTY_TEXT_RATIO_SUSPECT = 0.5

#: 单个单元正文少于该字符数视为"空单元"（只有标题、没有正文）。
MIN_UNIT_TEXT_CHARS = 10

#: 卡片数 ≥ 此值但 edges==0 → 疑似关系抽取失效（卡片有内容却连不成图）。
MIN_CARDS_FOR_EDGE_CHECK = 3

#: 判据代号 → 中文说明（供 UI/报告直接展示）
SUSPECT_LABELS: dict[str, str] = {
    "empty_body": "整篇正文为空（解析或 OCR 未产出文字）",
    "mostly_empty_units": "多数单元正文为空",
    "no_cards": "有单元但一张卡片都没抽出",
    "low_yield": "卡片产出率异常低",
    "no_edges": "有卡片但没有关系边",
    "no_entities": "有卡片但没有实体",
}


@dataclass
class QualityInput:
    """质量判定的输入 —— 全部是**实际落库的数字**（不传"预期值"）。"""

    units_total: int = 0
    units_with_text: int = 0
    #: 正文总字符数（units.text 之和）
    text_chars: int = 0
    cards: int = 0
    entities: int = 0
    edges: int = 0
    xrefs: int = 0
    #: 抽取阶段如实上报的失败条目数（若上游给了）
    extract_failures: int = 0
    #: 抽取状态（done/partial/failed/unavailable/none）
    extract_status: str = ""
    #: 解析阶段的 text_mode（native/image/mixed/empty），来自 pdf adapter
    text_mode: str = ""


@dataclass
class QualityReport:
    """结构化质量判定（可直接序列化进 `documents.meta.extract_quality`）。"""

    ok: bool
    suspects: list[str] = field(default_factory=list)
    reasons: dict[str, str] = field(default_factory=dict)
    metrics: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "suspects": list(self.suspects),
            "suspect_labels": {s: SUSPECT_LABELS.get(s, s) for s in self.suspects},
            "reasons": dict(self.reasons),
            "metrics": dict(self.metrics),
        }


def evaluate_quality(q: QualityInput) -> QualityReport:
    """按一组**可解释判据**判定抽取质量。

    ⚠️ 判据顺序有意设计成"先根因、后表象"：
    `empty_body`/`mostly_empty_units`（解析层）先判，
    然后才是 `no_cards`/`low_yield`（抽取层）。
    这样报告里第一条 suspect 直接指向真正的排查方向。
    """
    suspects: list[str] = []
    reasons: dict[str, str] = {}

    empty_units = max(0, q.units_total - q.units_with_text)
    empty_ratio = (empty_units / q.units_total) if q.units_total else 0.0
    cards_per_unit = (q.cards / q.units_total) if q.units_total else 0.0

    metrics: dict[str, Any] = {
        "units_total": q.units_total,
        "units_with_text": q.units_with_text,
        "units_empty": empty_units,
        "empty_ratio": round(empty_ratio, 4),
        "text_chars": q.text_chars,
        "cards": q.cards,
        "entities": q.entities,
        "edges": q.edges,
        "xrefs": q.xrefs,
        "cards_per_unit": round(cards_per_unit, 4),
        "extract_status": q.extract_status,
        "text_mode": q.text_mode,
    }

    # ── ① 解析层根因：整篇没有正文 ──
    if q.units_total > 0 and q.text_chars == 0:
        suspects.append("empty_body")
        hints = []
        if q.text_mode == "image":
            hints.append("该 PDF 为**扫描件**（逐页无文字层，只有整页图）")
        elif q.text_mode == "empty":
            hints.append("该 PDF 既无文字层也无图片")
        if q.extract_failures:
            hints.append(f"抽取阶段已有 {q.extract_failures} 条失败记录")
        reasons["empty_body"] = (
            f"{q.units_total} 个单元正文合计 **0 字符**"
            + ("；" + "；".join(hints) if hints else "")
            + " ⟹ 抽取无从下手（**不是**抽取器的问题）"
        )

    # ── ② 多数单元空正文（半扫描件/OCR 未覆盖）──
    elif q.units_total >= MIN_UNITS_FOR_YIELD_CHECK and empty_ratio >= EMPTY_TEXT_RATIO_SUSPECT:
        suspects.append("mostly_empty_units")
        reasons["mostly_empty_units"] = (
            f"{empty_units}/{q.units_total} 个单元正文为空（{empty_ratio:.0%} ≥ "
            f"{EMPTY_TEXT_RATIO_SUSPECT:.0%}）；text_mode={q.text_mode or '未知'}"
            + ("；部分页可能需要 OCR" if q.text_mode == "mixed" else "")
        )

    # ── ③ 抽取层：有单元却零卡片 ──
    if q.units_total >= MIN_UNITS_FOR_YIELD_CHECK and q.cards == 0 and q.text_chars > 0:
        suspects.append("no_cards")
        reasons["no_cards"] = (
            f"{q.units_total} 个单元（正文 {q.text_chars} 字符）**一张卡片都没抽出**"
            + (f"；抽取状态={q.extract_status}" if q.extract_status else "")
            + (f"；失败 {q.extract_failures} 条" if q.extract_failures else "")
            + " ⟹ 疑似抽取管线失败（**不是**「这篇没有知识点」）"
        )

    # ── ④ 产出率异常低 ──
    elif q.units_total >= MIN_UNITS_FOR_YIELD_CHECK and 0 < cards_per_unit < LOW_YIELD_CARDS_PER_UNIT:
        suspects.append("low_yield")
        reasons["low_yield"] = (
            f"卡片/单元 = {q.cards}/{q.units_total} = {cards_per_unit:.4f} < "
            f"{LOW_YIELD_CARDS_PER_UNIT}（正常教材约 0.3~3）"
            + (f"；抽取失败 {q.extract_failures} 条" if q.extract_failures else "")
        )

    # ── ⑤ 有卡片但没实体 ──
    if q.cards > 0 and q.entities == 0:
        suspects.append("no_entities")
        reasons["no_entities"] = f"有 {q.cards} 张卡片但 0 个实体 ⟹ 实体抽取环节失效"

    # ── ⑥ 有卡片但没边 ──
    if q.cards >= MIN_CARDS_FOR_EDGE_CHECK and q.edges == 0:
        suspects.append("no_edges")
        reasons["no_edges"] = (
            f"有 {q.cards} 张卡片但 0 条关系边 ⟹ 关系抽取失效（图会退化成孤点集合）"
        )

    return QualityReport(ok=not suspects, suspects=suspects, reasons=reasons, metrics=metrics)


def summarize_for_ui(report: QualityReport) -> str:
    """一句话结论（给任务 detail / 前端 banner 用）。**不掩饰**。"""
    if report.ok:
        m = report.metrics
        return f"抽取质量正常（units={m['units_total']}, cards={m['cards']}, edges={m['edges']}）"
    label = "；".join(SUSPECT_LABELS.get(s, s) for s in report.suspects)
    return f"⚠️ 疑似抽取异常：{label}（详见 extract_quality.reasons）"
