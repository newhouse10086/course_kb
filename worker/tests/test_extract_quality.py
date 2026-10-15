"""抽取质量闸门测试（`worker/pipeline/quality.py`）。

全部断言**具体值**（AGENTS.md §7 质量门），不用"非空"蒙混。

★ 第一个用例是**真实事故的回归**：用户上传 434 页扫描件 →
167 units / cards=1 / edges=0 / 全程"看起来成功"。
这个用例锁死"这种状态必须被判定为异常"。
"""

from __future__ import annotations

import pytest

from worker.pipeline.quality import (
    QualityInput,
    SUSPECT_LABELS,
    evaluate_quality,
    summarize_for_ui,
)


def test_regression_real_scanned_pdf_incident_is_flagged() -> None:
    """★ 真实事故回归：167 个空正文单元 + 1 张卡 → **必须**判异常。

    实测来源：`doc_45d7826c5c4c`（数据库系统概论 第5版, 434 页扫描件）
      库里：units=167、text_len>0 的 unit 数 = 0、cards=1、entities=1、edges=0
    """
    r = evaluate_quality(
        QualityInput(
            units_total=167,
            units_with_text=0,
            text_chars=0,
            cards=1,
            entities=1,
            edges=0,
            xrefs=0,
            extract_status="partial",
            extract_failures=7,
            text_mode="image",
        )
    )

    assert r.ok is False
    # 根因（解析层）必须排在最前 —— 它决定排查方向
    assert r.suspects[0] == "empty_body"
    assert "low_yield" in r.suspects
    # 根因说明必须含**真实数字**与"不是抽取器的问题"这个关键判断
    assert "167 个单元正文合计 **0 字符**" in r.reasons["empty_body"]
    assert "扫描件" in r.reasons["empty_body"]
    assert "抽取器的问题" in r.reasons["empty_body"]
    # 指标逐字
    assert r.metrics["units_total"] == 167
    assert r.metrics["units_empty"] == 167
    assert r.metrics["empty_ratio"] == 1.0
    assert r.metrics["cards_per_unit"] == 0.006
    assert r.metrics["text_mode"] == "image"
    # UI 一句话必须点出"异常"
    assert summarize_for_ui(r).startswith("⚠️ 疑似抽取异常")


def test_healthy_document_passes_with_no_suspects() -> None:
    """正常文档必须 ok=True —— 否则闸门会被当成噪声忽略。"""
    r = evaluate_quality(
        QualityInput(
            units_total=2523,
            units_with_text=2523,
            text_chars=20_008_670,
            cards=500,
            entities=300,
            edges=200,
            xrefs=120,
            extract_status="done",
            text_mode="mixed",
        )
    )
    assert r.ok is True
    assert r.suspects == []
    assert r.reasons == {}
    assert summarize_for_ui(r) == "抽取质量正常（units=2523, cards=500, edges=200）"


def test_no_cards_with_nonempty_text_points_at_extractor() -> None:
    """有正文却零卡片 → 指向**抽取层**（与 empty_body 是两个方向）。"""
    r = evaluate_quality(
        QualityInput(units_total=100, units_with_text=100, text_chars=50_000, cards=0, extract_status="failed")
    )
    assert r.suspects == ["no_cards"]
    assert "一张卡片都没抽出" in r.reasons["no_cards"]
    assert "抽取状态=failed" in r.reasons["no_cards"]
    # **不能**误判成 empty_body（正文非空）
    assert "empty_body" not in r.suspects


def test_empty_body_takes_priority_over_no_cards() -> None:
    """整篇空正文时，即使 cards==0 也只报根因，不重复报表象。"""
    r = evaluate_quality(QualityInput(units_total=50, units_with_text=0, text_chars=0, cards=0))
    assert r.suspects == ["empty_body"]
    assert "no_cards" not in r.suspects  # 根因已覆盖，避免噪声


def test_low_yield_threshold_boundaries() -> None:
    """产出率阈值边界：0.02 恰好不报，低于才报。"""
    # 恰好 0.02 → 不报（判据是 < 0.02）
    at = evaluate_quality(QualityInput(units_total=100, units_with_text=100, text_chars=9000, cards=2, entities=2))
    assert "low_yield" not in at.suspects
    # 0.019 → 报
    below = evaluate_quality(QualityInput(units_total=1000, units_with_text=1000, text_chars=90_000, cards=19, entities=5))
    assert "low_yield" in below.suspects
    assert "0.0190" in below.reasons["low_yield"]


def test_small_document_is_not_flagged_for_yield() -> None:
    """小文档（< 5 单元）不判产出率 —— 本来就可能没有知识点，避免误伤。"""
    r = evaluate_quality(QualityInput(units_total=3, units_with_text=3, text_chars=1200, cards=0))
    assert r.ok is True
    assert r.suspects == []


def test_empty_body_still_flagged_for_tiny_document() -> None:
    """⚠️ 但"整篇空正文"对**再小的文档**也要报（根因明确，不是产出率问题）。"""
    r = evaluate_quality(QualityInput(units_total=3, units_with_text=0, text_chars=0, cards=0))
    assert r.suspects == ["empty_body"]


def test_mixed_text_mode_reports_possible_ocr_need() -> None:
    """半扫描件（mixed）：多数单元空正文 → 报且提示"部分页可能需要 OCR"。"""
    r = evaluate_quality(
        QualityInput(units_total=100, units_with_text=40, text_chars=20_000, cards=3, entities=2, edges=1, text_mode="mixed")
    )
    assert "mostly_empty_units" in r.suspects
    assert "60/100 个单元正文为空（60% ≥ 50%）" in r.reasons["mostly_empty_units"]
    assert "text_mode=mixed" in r.reasons["mostly_empty_units"]
    assert "部分页可能需要 OCR" in r.reasons["mostly_empty_units"]


def test_mostly_empty_ratio_boundary() -> None:
    """空单元占比 50% 恰好命中（判据是 >= 0.5）。"""
    half = evaluate_quality(QualityInput(units_total=10, units_with_text=5, text_chars=3000, cards=5, entities=3, edges=2))
    assert "mostly_empty_units" in half.suspects
    # 49% → 不报
    below = evaluate_quality(QualityInput(units_total=100, units_with_text=51, text_chars=30_000, cards=30, entities=10, edges=5))
    assert "mostly_empty_units" not in below.suspects


def test_no_entities_and_no_edges_are_separate_signals() -> None:
    """有卡片但没实体 / 没边，是两个独立的信号。"""
    ents = evaluate_quality(QualityInput(units_total=50, units_with_text=50, text_chars=20_000, cards=10, entities=0, edges=8))
    assert "no_entities" in ents.suspects
    assert "no_edges" not in ents.suspects

    edges = evaluate_quality(QualityInput(units_total=50, units_with_text=50, text_chars=20_000, cards=10, entities=6, edges=0))
    assert "no_edges" in edges.suspects
    assert "no_entities" not in edges.suspects

    # 少量卡片时**不**判 no_edges（卡少边少是正常的）
    few = evaluate_quality(QualityInput(units_total=50, units_with_text=50, text_chars=20_000, cards=2, entities=2, edges=0))
    assert "no_edges" not in few.suspects


def test_every_suspect_code_has_a_label() -> None:
    """每个判据代号都必须有中文标签 —— 否则 UI 会显示英文代号。"""
    all_inputs = [
        QualityInput(units_total=167, units_with_text=0, text_chars=0, cards=1),
        QualityInput(units_total=100, units_with_text=40, text_chars=20_000, cards=3, entities=2, edges=1),
        QualityInput(units_total=100, units_with_text=100, text_chars=50_000, cards=0),
        QualityInput(units_total=1000, units_with_text=1000, text_chars=90_000, cards=19, entities=5),
        QualityInput(units_total=50, units_with_text=50, text_chars=20_000, cards=10, entities=6, edges=0),
        QualityInput(units_total=50, units_with_text=50, text_chars=20_000, cards=10, entities=0, edges=8),
    ]
    seen: set[str] = set()
    for inp in all_inputs:
        seen.update(evaluate_quality(inp).suspects)
    assert seen, "应至少命中一个判据"
    for code in seen:
        assert code in SUSPECT_LABELS, f"判据 {code} 缺中文标签"
        assert SUSPECT_LABELS[code].strip()


def test_report_is_json_serialisable_and_gate_never_mutates_input() -> None:
    """报告可序列化；且本模块**只诊断不改数据**（输入对象不被改动）。"""
    import json

    inp = QualityInput(units_total=167, units_with_text=0, text_chars=0, cards=1, text_mode="image")
    before = (inp.units_total, inp.cards, inp.text_chars)
    r = evaluate_quality(inp)
    after = (inp.units_total, inp.cards, inp.text_chars)
    assert before == after, "质量闸门不得改动输入"

    payload = json.dumps(r.to_dict(), ensure_ascii=False)
    back = json.loads(payload)
    assert back["ok"] is False
    assert back["suspects"][0] == "empty_body"
    assert back["metrics"]["text_mode"] == "image"
    assert "empty_body" in back["suspect_labels"]
