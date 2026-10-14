# -*- coding: utf-8 -*-
"""抽取管线测试（**纯函数核心** `worker.pipeline.extract_core`）—— v2 迁移版。

覆盖契约硬要求：
* C1 **并发 = 1**（不是"看起来是 1"，是断言 `max_inflight == 1`）
* C2 `json_schema` + `strict:true` + `additionalProperties:false`（坑 4）
* C3 边类型/kind 只能来自 `contracts/schema/*.json`
* C4 断点续跑；C5 原子替换
* 提示词**逐字**（PROMPTS.md §3）且只有一份实现（与 `extract.py` 相等）

v1 里这些用例跑在 SQLite 上；v2 worker 不碰存储，所以全部改成纯函数 +
注入 transport（LLM 边界用测试替身，管线行为用**具体值**断言）。
单元划分 / 交叉引用 / 检索的用例分别见 `test_units.py`、`test_xref.py`、`test_search.py`。
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest

from worker.models import Span, Unit
from worker.models.schema_enums import card_kinds, edge_types, entity_types, section_roles
from worker.pipeline import extract as extract_legacy
from worker.pipeline import extract_core as core
from worker.pipeline import units as units_mod
from worker.pipeline.llm import (
    E_LLM_BAD_JSON,
    E_LLM_EMPTY_CONTENT,
    E_LLM_SCHEMA,
    E_LLM_UPSTREAM,
    LLMClient,
    LLMConfig,
    LLMError,
    LLMSchemaError,
    strictify,
    validate_against_schema,
)


# ═══════════════════════════════════════════════════════════════════════
# 工具
# ═══════════════════════════════════════════════════════════════════════
def cfg(**over) -> LLMConfig:
    base = {"base_url": "http://stub.invalid/v1", "api_key": "sk-test", "model": "m-test"}
    base.update(over)
    return LLMConfig.from_dict(base)


def mk_unit(uid: str, ord_: int, title: str, level: int, start: int, end: int,
            parent: str | None = None, text: str = "", kind: str = "page") -> Unit:
    return Unit(id=uid, doc_id="doc_pipe00000001", ord=ord_, title=title, level=level,
                parent_id=parent, span=Span(kind, start, end),
                text=text or f"{title} 的正文：讲索引与事务。")


def stub_payload(*, cards: int = 2, entities: int = 2, edges: int = 1, page: int = 1,
                 kind: str = "sql_statement", bad_kind: bool = False) -> str:
    return json.dumps(
        {
            "section": {
                "section_summary": "本节讲怎么查看服务器上的数据库。",
                "learning_objectives": ["能用 SHOW DATABASES 查库"],
                "section_role": "how_to",
                "key_takeaways": ["没有权限时结果不完整"],
            },
            "cards": [
                {
                    "name": f"知识点{i}",
                    "kind": ("常用实现" if bad_kind else kind),
                    "one_line": f"知识点{i} 的一句话定义",
                    "purpose": f"知识点{i} 用来做某事",
                    "usage_mode": "user_invoked", "operational_role": "diagnostics",
                    "lifecycle": "builtin", "example": "SHOW DATABASES;",
                    "example_explained": "执行这条语句", "prerequisites": ["需要先连接服务器"],
                    "cautions": ["注意权限"], "evidence_quote": "SHOW DATABASES lists databases.",
                    "evidence_page": page, "confidence": 0.9,
                }
                for i in range(cards)
            ],
            "entities": [
                {"name": f"Entity{i}", "name_zh": f"实体{i}", "type": "concept", "layer": "L1"}
                for i in range(entities)
            ],
            "edges": [
                {"src": "Entity0", "dst": "Entity1", "etype": "DEPENDS_ON",
                 "evidence_text": "Entity0 requires Entity1 first.", "confidence": 0.8}
                for _ in range(edges)
            ],
        },
        ensure_ascii=False,
    )


# ═══════════════════════════════════════════════════════════════════════
# C2：strict json_schema
# ═══════════════════════════════════════════════════════════════════════
def test_strictify_closes_every_object_including_nested() -> None:
    schema = {
        "type": "object",
        "properties": {
            "cards": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}, "example": {"type": "string"}},
                },
            }
        },
    }
    out = strictify(schema, optional={"example"})
    assert out["additionalProperties"] is False and out["required"] == ["cards"]
    item = out["properties"]["cards"]["items"]
    assert item["additionalProperties"] is False
    assert item["required"] == ["name", "example"]
    # ★ optional 是**按字段名全局生效**的（嵌套对象也要可空）—— 实测踩过
    assert item["properties"]["example"]["type"] == ["string", "null"]
    assert item["properties"]["name"]["type"] == "string"


def test_extraction_schema_enums_come_from_contracts() -> None:
    s = strictify(core.build_extraction_schema())
    card_props = s["properties"]["cards"]["items"]["properties"]
    assert card_props["kind"]["enum"] == list(card_kinds())
    assert s["properties"]["edges"]["items"]["properties"]["etype"]["enum"] == list(edge_types())
    assert s["properties"]["entities"]["items"]["properties"]["type"]["enum"] == list(entity_types())
    assert s["properties"]["section"]["properties"]["section_role"]["enum"] == list(section_roles())
    assert s["additionalProperties"] is False


def test_validate_catches_the_real_world_enum_violation() -> None:
    schema = strictify({"type": "object",
                        "properties": {"etype": {"type": "string",
                                                 "enum": ["DEPENDS_ON", "PART_OF"]}}})
    # ★ 坑 4 原样复现：模型真的输出过 "etype": "常用实现"
    errs = validate_against_schema({"etype": "常用实现"}, schema)
    assert errs and "不在枚举" in errs[0]
    assert validate_against_schema({"etype": "PART_OF"}, schema) == []
    assert validate_against_schema({"etype": "PART_OF", "extra": 1}, schema)   # 多字段也报错
    assert validate_against_schema({}, schema)                                 # 缺必填也报错


# ═══════════════════════════════════════════════════════════════════════
# C1：并发 = 1（含真多线程压测）
# ═══════════════════════════════════════════════════════════════════════
def test_llm_serialises_calls_under_threads() -> None:
    state = {"inflight": 0, "max": 0}
    lock = threading.Lock()

    def transport(payload: dict) -> str:
        with lock:
            state["inflight"] += 1
            state["max"] = max(state["max"], state["inflight"])
        time.sleep(0.03)          # 放大重叠窗口
        with lock:
            state["inflight"] -= 1
        return json.dumps({"ok": 1})

    llm = LLMClient(config=cfg(), transport=transport)
    schema = {"type": "object", "properties": {"ok": {"type": "integer"}}}
    results: list[dict] = []

    def work() -> None:
        results.append(llm.complete_json(system="s", user="u", schema=schema).data)

    threads = [threading.Thread(target=work) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(results) == 8 and all(r == {"ok": 1} for r in results)
    assert state["max"] == 1, f"transport 出现过 {state['max']} 个并发调用"
    m = llm.metrics()
    assert m["max_inflight"] == 1 and m["serial_ok"] is True and m["calls"] == 8
    assert m["concurrency_limit"] == 1


def test_llm_config_forces_concurrency_one_and_hides_key() -> None:
    c = LLMConfig.from_dict({"base_url": "http://x/v1", "api_key": "sk-secret",
                             "model": "m", "concurrency": 4, "vendor": "amr"})
    assert c.concurrency == 1, "并发必须被强制为 1（用户硬要求）"
    assert c.extra == {"vendor": "amr"}
    assert "sk-secret" not in json.dumps(c.redacted())
    assert c.redacted()["api_key_set"] is True


def test_llm_retries_schema_violation_with_feedback() -> None:
    calls: list[str] = []

    def transport(payload: dict) -> str:
        user = payload["messages"][1]["content"]
        calls.append(user)
        return json.dumps({"kind": "常用实现"}) if len(calls) == 1 else json.dumps({"kind": "concept"})

    llm = LLMClient(config=cfg(), transport=transport, sleep=lambda _s: None)
    schema = {"type": "object", "properties": {"kind": {"type": "string", "enum": ["concept"]}}}
    res = llm.complete_json(system="s", user="原始提问", schema=schema)
    assert res.data == {"kind": "concept"} and res.attempts == 2
    assert "上一次输出不合法" in calls[1]          # 违规项回灌
    llm2 = LLMClient(config=cfg(), transport=lambda p: json.dumps({"kind": "x"}),
                     sleep=lambda _s: None)
    with pytest.raises(LLMSchemaError) as exc:
        llm2.complete_json(system="s", user="u", schema=schema, max_attempts=3)
    assert exc.value.code == "E_LLM_SCHEMA" and "不在枚举" in exc.value.detail


def test_llm_payload_uses_json_schema_strict_and_no_key_leak() -> None:
    seen: dict = {}

    def transport(payload: dict) -> str:
        seen.update(payload)
        return json.dumps({"ok": 1})

    llm = LLMClient(config=cfg(), transport=transport)
    llm.complete_json(system="s", user="u",
                      schema={"type": "object", "properties": {"ok": {"type": "integer"}}})
    rf = seen["response_format"]
    assert rf["type"] == "json_schema" and rf["json_schema"]["strict"] is True
    assert rf["json_schema"]["schema"]["additionalProperties"] is False
    assert seen["temperature"] == 0.0 and seen["model"] == "m-test"
    assert "sk-test" not in json.dumps(seen)


def test_llm_unconfigured_is_honest() -> None:
    llm = LLMClient(config=LLMConfig())
    assert llm.configured is False
    assert "base_url" in llm.cfg.reason
    with pytest.raises(LLMError) as exc:
        llm.complete_json(system="s", user="u", schema={"type": "object"})
    assert exc.value.code == "E_LLM"


# ═══════════════════════════════════════════════════════════════════════
# extract_core：抽取落值与断点
# ═══════════════════════════════════════════════════════════════════════
def _units3() -> list[Unit]:
    return [
        mk_unit("unt_a", 1, "1.1 SHOW DATABASES", 1, 1, 3, text="Use the SHOW statement ..."),
        mk_unit("unt_b", 2, "1.2 CREATE TABLE", 1, 4, 6, text="CREATE TABLE defines columns."),
        mk_unit("unt_c", 3, "1.3 Indexes", 1, 7, 12, text="Indexes speed up lookups."),
    ]


def test_extract_units_persists_concrete_values() -> None:
    events: list[dict] = []
    llm = LLMClient(config=cfg(), transport=lambda p: stub_payload())
    out = core.extract_units(
        doc_id="doc_pipe00000001", units=_units3(), llm=llm,
        source_name="MySQL 26.7 Reference Manual", pages_total=12, emit=events.append,
    )
    assert out.stats["units_total"] == 3 and out.stats["units_done"] == 3
    assert out.stats["units_failed"] == 0 and out.stats["llm_calls"] == 3
    # 卡片 6 张（3 单元 × 2），实体**按 id 去重**后 2 个，边 3 条
    assert out.stats["cards"] == 6 and out.stats["entities"] == 2 and out.stats["edges"] == 3
    assert out.stats["pick"]["coverage"] == 1.0 and out.stats["pick"]["missing_count"] == 0
    assert out.stats["concurrency"] == 1
    assert out.stats["llm"]["api_key_set"] is True
    assert "sk-test" not in json.dumps(out.stats, ensure_ascii=False)

    card = [c for c in out.cards if c.unit_id == "unt_a"][0]
    assert card.kind == "sql_statement"
    assert card.one_line == "知识点0 的一句话定义"
    assert card.prerequisites == ["需要先连接服务器"] and card.cautions == ["注意权限"]
    assert card.span.to_dict() == {"kind": "page", "start": 1, "end": 1}  # evidence_page 夹在单元内
    assert card.confidence == pytest.approx(0.9)
    assert card.id == core.stable_card_id("doc_pipe00000001", "unt_a", "知识点0")

    assert {e.name for e in out.entities} == {"Entity0", "Entity1"}   # 跨单元**归并**
    assert len(out.edges) == 3 and {e.etype for e in out.edges} == {"DEPENDS_ON"}
    assert all(e.src_id != e.dst_id for e in out.edges)
    assert out.sections["unt_a"]["section_role"] == "how_to"
    assert out.sections["unt_a"]["key_takeaways"] == ["没有权限时结果不完整"]

    kinds = [e["type"] for e in events]
    assert kinds.count("unit") == 3
    assert kinds[0] == "progress" and kinds[-1] == "progress"
    unit_ev = [e for e in events if e["type"] == "unit"][0]["data"]
    assert unit_ev["unit_id"] == "unt_a" and len(unit_ev["cards"]) == 2
    assert unit_ev["span"]["kind"] == "page"


def test_extract_units_is_idempotent_with_deterministic_ids() -> None:
    llm = LLMClient(config=cfg(), transport=lambda p: stub_payload())
    a = core.extract_units(doc_id="doc_x", units=_units3(), llm=llm)
    b = core.extract_units(doc_id="doc_x", units=_units3(), llm=llm)
    assert [c.id for c in a.cards] == [c.id for c in b.cards], "重跑必须得到同一批 id"
    assert [e.id for e in a.entities] == [e.id for e in b.entities]


def test_extract_units_checkpoint_resume_and_atomic(tmp_path: Path) -> None:
    ckpt = tmp_path / "ckpt" / "doc_x_extract.json"
    calls = {"n": 0}

    def transport(p: dict) -> str:
        calls["n"] += 1
        return stub_payload()

    llm = LLMClient(config=cfg(), transport=transport)
    first = core.extract_units(doc_id="doc_x", units=_units3(), llm=llm,
                               checkpoint_file=ckpt, emit=lambda e: None)
    assert first.stats["units_done"] == 3 and calls["n"] == 3
    data = json.loads(ckpt.read_text(encoding="utf-8"))
    assert set(data["done"]) == {"unt_a#page:1-3", "unt_b#page:4-6", "unt_c#page:7-12"}
    assert data["done"]["unt_a#page:1-3"]["cards"] == 2
    assert data["model"] == "m-test"
    assert not (ckpt.parent / (ckpt.name + ".tmp")).exists(), "原子替换不能留临时文件"

    second = core.extract_units(doc_id="doc_x", units=_units3(), llm=llm,
                                checkpoint_file=ckpt, emit=lambda e: None)
    assert second.stats["units_skipped"] == 3 and second.stats["units_done"] == 0
    assert calls["n"] == 3, "断点续跑不该再调 LLM"

    third = core.extract_units(doc_id="doc_x", units=_units3(), llm=llm,
                               checkpoint_file=ckpt, resume=False, emit=lambda e: None)
    assert third.stats["units_done"] == 3 and calls["n"] == 6


def test_extract_units_marks_empty_units_and_aborts_on_quota() -> None:
    units = [
        # 注意：mk_unit 会给默认正文，这里要**真空文本**（无正文的单元）
        Unit(id="unt_empty", doc_id="doc_x", ord=1, title="1.1 空节", level=1,
             span=Span("page", 1, 2), text=""),
        mk_unit("unt_ok", 2, "1.2 有内容", 1, 3, 4, text="Some real content."),
    ]
    llm = LLMClient(config=cfg(), transport=lambda p: stub_payload())
    out = core.extract_units(doc_id="doc_x", units=units, llm=llm)
    assert out.stats["units_empty"] == 1 and out.stats["units_done"] == 1
    assert out.stats["llm_calls"] == 1

    def fail(p: dict) -> str:
        raise LLMError("E_LLM", "LLM 返回 HTTP 402", detail="HTTP 402；insufficient_balance")

    llm2 = LLMClient(config=cfg(), transport=fail)
    out2 = core.extract_units(doc_id="doc_x", units=_units3(), llm=llm2)
    assert out2.stats["units_failed"] == 1 and out2.stats["units_done"] == 0
    assert any(e.get("code") == "E_LLM_ABORT" for e in out2.errors), "额度问题要中断而不是硬跑"


def test_extract_units_requires_units_and_credentials() -> None:
    llm = LLMClient(config=cfg(), transport=lambda p: stub_payload())
    with pytest.raises(LLMError) as exc:
        core.extract_units(doc_id="doc_x", units=[], llm=llm)
    assert exc.value.code == "E_PARSE"
    with pytest.raises(LLMError) as exc2:
        core.extract_units(doc_id="doc_x", units=_units3(), llm=LLMClient(config=LLMConfig()))
    assert exc2.value.code == "E_LLM"


def test_illegal_kind_is_rejected_by_schema() -> None:
    """坑 4：模型给出非法 kind → schema 校验拦下（调用方会按需重试）。"""
    llm = LLMClient(config=cfg(), transport=lambda p: stub_payload(bad_kind=True),
                    sleep=lambda _s: None)
    with pytest.raises(LLMSchemaError):
        llm.complete_json(system="s", user="u", schema=core.build_extraction_schema(),
                          optional=core.OPTIONAL_CARD_FIELDS, max_attempts=1)


def test_build_cards_drops_illegal_enum_instead_of_crashing() -> None:
    pu = units_mod.PickedUnit(ord=1, unit_id="unt_a", title="t", level=1, kind="section",
                              span=Span("page", 1, 3), text="x")
    cards = core.build_cards("doc_x", pu, [
        {"name": "好卡片", "kind": "concept", "one_line": "ok", "purpose": "p",
         "usage_mode": "user_invoked", "operational_role": "feature", "evidence_quote": "q",
         "evidence_page": 2, "confidence": 0.9},
        {"name": "坏卡片", "kind": "常用实现", "one_line": "x", "purpose": "x",
         "usage_mode": "user_invoked", "operational_role": "feature", "evidence_quote": ""},
    ])
    assert [c.name for c in cards] == ["好卡片"]
    assert cards[0].span.to_dict() == {"kind": "page", "start": 2, "end": 2}


def test_build_graph_merges_entities_and_skips_bad_edges() -> None:
    pu = units_mod.PickedUnit(ord=1, unit_id="unt_a", title="t", level=1, kind="section",
                              span=Span("page", 1, 3), text="x")
    g = core.build_graph("doc_x", pu, {
        "entities": [
            {"name": "A", "type": "concept", "layer": "L1"},
            {"name": "a", "type": "concept", "layer": "L2"},           # 同名（规范化）→ 归并
            {"name": "B", "type": "不存在的type"},                      # 非法 → 丢弃计数
        ],
        "edges": [
            {"src": "A", "dst": "A", "etype": "PART_OF"},              # 自环 → 丢弃
            {"src": "A", "dst": "B", "etype": "不存在的边"},            # 非法 etype → 丢弃
            {"src": "A", "dst": "缺失", "etype": "PART_OF"},            # 悬空端点 → 丢弃
        ],
    })
    assert [e.name for e in g.entities] == ["A"]
    assert g.dropped_entities == 1 and g.dropped_edges == 3 and g.edges == []


# ═══════════════════════════════════════════════════════════════════════
# plan / convert 拆分的正确性（v2 新路径）
# ═══════════════════════════════════════════════════════════════════════
def test_plan_prompts_shape_and_portable_keys() -> None:
    plan = core.plan_prompts(units=_units3(), source_name="MySQL 26.7 Reference Manual")
    assert plan["pick"]["n_picked"] == 3
    assert len(plan["items"]) == 3
    first = plan["items"][0]
    assert set(first) >= {"key", "unit_key", "unit_ord", "unit_id", "title", "span",
                          "system", "user", "chars"}
    assert first["unit_key"] == "1#page:1-3"          # 含 ord，**不含**合成 unit_id
    assert first["key"] == "unt_a#page:1-3"
    assert "SHOW DATABASES" in first["user"]
    assert "章节路径" in first["user"]
    assert "你是**数据库课程的知识工程师**" in first["system"]
    assert plan["optional_fields"] == ["example", "example_explained", "lifecycle"]
    assert plan["schema"]["properties"]["cards"]["items"]["properties"]["kind"]["enum"] == list(card_kinds())


def test_convert_payloads_matches_by_key_unit_key_and_span() -> None:
    plan = core.plan_prompts(units=_units3())
    item = plan["items"][0]
    data = json.loads(stub_payload())
    out = core.convert_payloads(
        doc_id="doc_x", units=_units3(),
        payloads=[
            {"key": item["key"], "data": data},                        # 精确 key
            {"unit_key": plan["items"][1]["unit_key"], "data": data},   # 可移植 key
            {"span": plan["items"][2]["span"], "data": data},           # 仅 span
            {"key": "unt_不存在#page:1-1", "data": data},               # 未知 → 记错误
        ],
    )
    assert out.stats["units_done"] == 3
    assert out.stats["cards"] == 6
    assert len(out.errors) == 1 and out.errors[0]["code"] == "E_PICK_KEY"
    assert {c.unit_id for c in out.cards} == {"unt_a", "unt_b", "unt_c"}


def test_convert_payloads_empty_input() -> None:
    out = core.convert_payloads(doc_id="doc_x", units=_units3(), payloads=[])
    assert out.stats["units_done"] == 0 and out.cards == []
    assert out.to_dict()["doc_id"] == "doc_x"


# ═══════════════════════════════════════════════════════════════════════
# 提示词只有一份实现（防漂移）+ 逐字性
# ═══════════════════════════════════════════════════════════════════════
def test_prompts_are_single_sourced_between_modules() -> None:
    assert extract_legacy.build_system_prompt("X") == core.build_system_prompt("X")
    assert extract_legacy.build_extraction_schema() == core.build_extraction_schema()
    assert extract_legacy.Checkpoint is core.Checkpoint
    assert extract_legacy.stable_card_id is core.stable_card_id
    assert extract_legacy.pick_key is core.pick_key


def test_prompt_text_is_verbatim_from_prompts_md() -> None:
    sys_prompt = core.build_system_prompt("MySQL 26.7 Reference Manual")
    assert "你是**数据库课程的知识工程师**" in sys_prompt
    assert "## 你的读者" in sys_prompt and "## 诚实原则（最重要）" in sys_prompt
    assert '✗ "log_filter_dragnet 是一个日志过滤组件"（同义反复，没说清）' in sys_prompt
    assert "### 8. section 级概括" in sys_prompt
    assert sys_prompt.count("MySQL 官方手册") == 0, "已参数化为 {source_name}"
    for etype in edge_types():
        assert f"- {etype}:" in sys_prompt, etype
    user = core.build_user_prompt(source_name="讲义", span_kind="slide", path="第 3 章 › 3.1",
                                  start=1, end=2, body="BODY")
    assert "讲义" in user and "第 3 章 › 3.1" in user and "BODY" in user
    assert "幻灯片：1–2" in user
    user2 = core.build_user_prompt(source_name="X", span_kind="time", path="p", start=0,
                                   end=480000, body="B")
    assert "时间戳(ms)：0–480000" in user2


def test_checkpoint_tolerances(tmp_path: Path) -> None:
    p = tmp_path / "x_extract.json"
    p.write_text("{ 这还不是 JSON", encoding="utf-8")
    ck = core.Checkpoint(p, "doc_x")
    assert ck.load() is False and ck.done_keys == set()
    ck.mark("k", {"cards": 1})
    ck.save()
    assert core.Checkpoint(p, "doc_x").done_keys == {"k"}
    assert core.Checkpoint(p, "doc_other").load() is False
    ck2 = core.Checkpoint(p, "doc_x", model="m1")
    ck2.mark("k2", {"cards": 2})
    ck2.save()
    assert core.Checkpoint(p, "doc_x", model="m1").done_keys == {"k", "k2"}
    assert core.Checkpoint(p, "doc_x", model="m2").load() is False


def test_pick_key_and_stable_ids() -> None:
    pu = units_mod.PickedUnit(ord=1, unit_id="unt_a", title="t", level=1, kind="section",
                              span=Span("page", 3, 5), text="x")
    assert core.pick_key(pu) == "unt_a#page:3-5"
    assert core.stable_card_id("doc_a", "unt_a", "CREATE  TABLE") == \
        core.stable_card_id("doc_a", "unt_a", "create table")
    assert core.stable_card_id("doc_a", "unt_a", "x") != core.stable_card_id("doc_a", "unt_b", "x")
    assert core.stable_card_id("doc_a", "unt_a", "x").startswith("crd_")
    assert core.stable_entity_id("doc_a", "B+tree") == core.stable_entity_id("doc_a", "b+tree")
    assert core.stable_entity_id("doc_a", "B+tree").startswith("ent_")


def test_empty_output_is_distinguishable_from_failure() -> None:
    """★ polysemy-prober 独立验收发现的静默路径：**输出合法但零产出**。

    模型可以**合理地拒绝抽取**（原文只有一句定义式陈述，提示词本就要求"只抽有实质
    内容的知识点"）→ 这时 ``cards`` 键会整个缺失。第一版把它与"抽取失败/管线丢卡"
    表达成同一个结果（``ok:true, error_count:0, cards:0``），调用方无法分辨，
    前端只能把空知识库当正常完成展示。

    修法：**不改 ``ok`` 语义**（真实失败路径不受影响），加 ``status`` 细分 + ``warnings``。
    """
    units = [mk_unit("unt_1", 1, "索引简介", 1, 1, 1,
                     text="索引 index 是加速查询的数据结构。")]
    # 他们抓到的**原始 LLM 输出**：只有 section，没有 cards / entities 键
    refused = {"section": {
        "section_role": "concept_intro",
        "section_summary": "本节只有一句定义式陈述……不足以支撑任何操作层面的结论。",
    }}
    out = core.convert_payloads(doc_id="doc_x", units=units,
                                payloads=[{"key": "unt_1#page:1-1", "data": refused}])
    d = out.to_dict()
    assert d["ok"] is True and d["error_count"] == 0      # 不是失败
    assert d["status"] == "done_empty"                    # 但状态可区分
    assert d["warnings"][0]["code"] == "W_NO_CARDS"
    assert d["warnings"][0]["cards_key"] == "missing"     # 缺键 ≠ 空数组
    assert "不足以支撑任何操作层面的结论" in d["warnings"][0]["model_note"]
    assert d["stats"]["units_no_cards"] == 1
    assert d["stats"]["units_done"] == 1

    # 有卡片 → done
    good = {"section": refused["section"], "cards": [
        {"name": "索引", "kind": "concept", "one_line": "加速查询的数据结构",
         "purpose": "减少扫描行数", "usage_mode": "server_automatic",
         "operational_role": "performance", "evidence_quote": "index 是加速查询的数据结构"}]}
    out2 = core.convert_payloads(doc_id="doc_x", units=units,
                                 payloads=[{"key": "unt_1#page:1-1", "data": good}])
    assert out2.to_dict()["status"] == "done" and out2.to_dict()["warnings"] == []

    # 空数组（而非缺键）也要能区分
    empty_arr = {"section": refused["section"], "cards": [], "entities": [], "edges": []}
    out3 = core.convert_payloads(doc_id="doc_x", units=units,
                                 payloads=[{"key": "unt_1#page:1-1", "data": empty_arr}])
    assert out3.to_dict()["warnings"][0]["cards_key"] == "empty"

    # 全失败（key 对不上）→ failed（与 done_empty 明确不同）
    out4 = core.convert_payloads(doc_id="doc_x", units=units,
                                 payloads=[{"key": "unt_缺失#page:9-9", "data": good}])
    d4 = out4.to_dict()
    assert d4["ok"] is False and d4["status"] == "failed"
    assert [e["code"] for e in d4["errors"]] == ["E_PICK_KEY"]
    assert d4["stats"]["units_failed"] == 1


def test_extract_units_status_and_no_cards_warning() -> None:
    """★ 两条 LLM 路径对"零卡片"的表现**本来就不同**，测试把这个差异钉住：

    | 路径 | 模型省略 ``cards`` 键 | 结果 |
    |---|---|---|
    | **B：worker 内调 LLM**（``extract``） | **strict schema 要求该键** → 重试 3 次 → 失败 | `units_failed=3`、`status="failed"`（**本来就响**） |
    | **A：Node 调模型**（``plan`` → ``convert``） | 输出未经 strict 校验就回传 | **第一版静默**；现在 `status="done_empty"` + `warnings` |

    → polysemy-prober 观测到的静默案例走的正是 **A 路径**；这里两条都断言。
    """
    import json as _json

    # ① B 路径：缺 cards 键 → schema 拦下（重试后计失败，不是静默）
    missing = {"section": {"section_role": "concept_intro",
                           "section_summary": "内容不足，无法抽取"}}
    llm = LLMClient(config=cfg(), transport=lambda p: _json.dumps(missing, ensure_ascii=False),
                    sleep=lambda _s: None)
    out = core.extract_units(doc_id="doc_x", units=_units3(), llm=llm)
    d = out.to_dict()
    assert d["status"] == "failed" and d["ok"] is False
    assert d["stats"]["units_failed"] == 3
    assert all(str(e.get("code", "")).startswith("E_LLM") for e in d["errors"]), d["errors"][:1]

    # ② B 路径：schema 合法但 cards 为空数组 → done_empty + 警告
    llm2 = LLMClient(config=cfg(), transport=lambda p: stub_payload(cards=0, entities=0, edges=0))
    out2 = core.extract_units(doc_id="doc_x", units=_units3(), llm=llm2)
    d2 = out2.to_dict()
    assert d2["ok"] is True and d2["status"] == "done_empty"
    assert d2["stats"]["units_no_cards"] == 3
    assert {w["cards_key"] for w in d2["warnings"]} == {"empty"}

    # ③ 有产出 → done，且没有警告
    out3 = core.extract_units(doc_id="doc_x", units=_units3(),
                              llm=LLMClient(config=cfg(), transport=lambda p: stub_payload()))
    assert out3.to_dict()["status"] == "done" and out3.cards
    assert out3.to_dict()["warnings"] == []


def test_llm_empty_content_is_not_success() -> None:
    """★ 契约 §0：**空 content 不许当成功**（推理模型的推理 token 计入输出预算）。

    polysemy-prober 在 Node 侧实测：``max_tokens=8`` 时 ``content=''``、
    ``finish_reason='length'``、``reasoning_content`` 437 字符 ——
    只判 HTTP 200 就会**假绿**。worker 侧同类问题：第一版返回空串 →
    上层只看到"不是 JSON"，把"预算不足"误诊成"模型输出格式不对"。
    """

    # 注入 transport 返回的就是**assistant 的 content 本身**（空串 = 空内容）
    llm = LLMClient(config=cfg(), transport=lambda p: "", sleep=lambda _s: None)
    with pytest.raises(LLMError) as exc:
        llm.complete_json(system="s", user="u", schema={"type": "object"})
    err = exc.value
    assert err.code == E_LLM_EMPTY_CONTENT
    assert "没有输出内容" in err.msg
    assert "max_tokens" in err.hint and "2000" in err.hint
    # 只有空白也算空（模型有时返回 "\n\n"）
    llm2 = LLMClient(config=cfg(), transport=lambda p: "   \n ", sleep=lambda _s: None)
    with pytest.raises(LLMError) as exc2:
        llm2.complete_text(system="s", user="u")
    assert exc2.value.code == E_LLM_EMPTY_CONTENT


def test_llm_non_json_output_gets_dedicated_code_and_meta() -> None:
    """非 JSON 输出 → ``E_LLM_BAD_JSON`` + 诊断（不是笼统的 schema 错）。"""

    # transport 直接返回一句自然语言（不是 JSON）
    llm = LLMClient(config=cfg(), transport=lambda p: "抱歉，我无法完成",
                    sleep=lambda _s: None)
    with pytest.raises(LLMError) as exc:
        llm.complete_json(system="s", user="u", schema={"type": "object"}, max_attempts=2)
    assert exc.value.code == E_LLM_BAD_JSON
    assert "不是合法 JSON" in exc.value.msg
    assert "max_tokens" in exc.value.hint
    # 对照：**是 JSON 但字段不合规** → 仍然是 E_LLM_SCHEMA（两者处置不同）
    llm2 = LLMClient(config=cfg(), transport=lambda p: json.dumps({"kind": "乱写的"}),
                     sleep=lambda _s: None)
    with pytest.raises(LLMSchemaError) as exc2:
        llm2.complete_json(system="s", user="u",
                           schema={"type": "object",
                                   "properties": {"kind": {"type": "string", "enum": ["concept"]}}},
                           max_attempts=1)
    assert exc2.value.code == E_LLM_SCHEMA


def test_llm_upstream_5xx_is_retryable_and_keeps_status() -> None:
    """★ 上游 5xx（如 503 Service Overload）→ ``E_LLM_UPSTREAM``，**保留状态码与 body**。

    实测场景：一次真实 failed 其实源于上游瞬时 503，但错误文案只说"返回非 JSON"
    → 运维无法分辨"重试即可"与"要改提示词/结构"（polysemy-prober 报的发现 B）。
    """
    import httpx

    import worker.pipeline.llm as llm_mod

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": {"message": "Service Overload"}})

    class _Client(httpx.Client):
        def __init__(self, **kw):  # noqa: ANN003
            kw["transport"] = httpx.MockTransport(handler)
            super().__init__(**kw)

    original = llm_mod.httpx.Client
    llm_mod.httpx.Client = _Client
    try:
        llm = LLMClient(config=cfg(), sleep=lambda _s: None)
        with pytest.raises(LLMError) as exc:
            llm.complete_json(system="s", user="u", schema={"type": "object"})
    finally:
        llm_mod.httpx.Client = original
    err = exc.value
    assert err.code == E_LLM_UPSTREAM
    assert "HTTP 503" in err.msg
    assert "Service Overload" in err.detail          # ★ body 片段保留
    assert getattr(err, "retryable", False) is True
    assert "重试即可" in err.hint


def test_llm_always_sends_explicit_token_budget() -> None:
    """★ 必须**显式**给 ``max_tokens``：推理 token 计入预算，靠 provider 默认值就是碰运气。

    （Lead 实测：``max_tokens=8`` → content 空；512 → 正常出内容。
    Node 侧 ``settings.json`` 的 ``llm.maxTokens=16384`` 会随 job 参数进来。）
    """
    seen: dict = {}

    def transport(payload: dict) -> str:
        seen.update(payload)
        return json.dumps({"ok": 1})

    schema = {"type": "object", "properties": {"ok": {"type": "integer"}}}
    # ① 未指定 → 用配置默认（8192），**payload 里必须有这个键**
    llm = LLMClient(config=cfg(), transport=transport)
    llm.complete_json(system="s", user="u", schema=schema)
    assert seen["max_tokens"] == 8192

    # ② Node 传 maxTokens → 采纳
    llm2 = LLMClient(config=cfg(maxTokens=16384), transport=transport)
    llm2.complete_json(system="s", user="u", schema=schema)
    assert seen["max_tokens"] == 16384
    assert llm2.cfg.max_tokens == 16384
    # 它有正式字段，不该被当成"额外透传"塞进 extra
    assert "maxTokens" not in llm2.cfg.extra and "max_tokens" not in llm2.cfg.extra

    # ③ 调用方显式覆盖 → 优先
    llm3 = LLMClient(config=cfg(), transport=transport)
    llm3.complete_json(system="s", user="u", schema=schema, max_tokens=512)
    assert seen["max_tokens"] == 512


def test_llm_empty_content_wording_is_not_overclaiming() -> None:
    """措辞不越界：``finish_reason``/reasoning 只是**线索**，不能说成"必然原因"。

    （Lead 实测：8 token 时出现了 ``finish=length``，但不能依赖它 ——
    判据只看 ``content`` 是否为空。）
    """
    llm = LLMClient(config=cfg(), transport=lambda p: "", sleep=lambda _s: None)
    with pytest.raises(LLMError) as exc:
        llm.complete_json(system="s", user="u", schema={"type": "object"})
    assert "没有输出内容" in exc.value.msg
    assert "很可能" in exc.value.msg or "推理" not in exc.value.msg


def test_ancestor_paths() -> None:
    units = [
        mk_unit("unt_ch", 1, "Chapter 7 MySQL Server Administration", 1, 1, 30),
        mk_unit("unt_sec", 2, "7.4 Error Log", 2, 5, 10, parent="unt_ch"),
        mk_unit("unt_leaf", 3, "7.4.2.6 Rule-Based Error Log Filtering", 3, 6, 8,
                parent="unt_sec"),
    ]
    paths = core.ancestor_paths(units)
    assert paths["unt_leaf"] == (
        "Chapter 7 MySQL Server Administration › 7.4 Error Log › "
        "7.4.2.6 Rule-Based Error Log Filtering"
    )
    assert paths["unt_ch"] == "Chapter 7 MySQL Server Administration"


# ═══════════════════════════════════════════════════════════════════════
# S2 汇总（rollup.plan / rollup.convert 的纯函数核心）
# ═══════════════════════════════════════════════════════════════════════
def test_rollup_prompts_single_sourced_with_v1_module() -> None:
    """汇总提示词**只有一份实现**（在 rollup_core；rollup.py 只 re-export）。"""
    from worker.pipeline import rollup as rollup_v1
    from worker.pipeline import rollup_core

    assert rollup_core.ROLLUP_SYSTEM is rollup_v1.ROLLUP_SYSTEM
    assert rollup_core.ROLLUP_USER == rollup_v1.ROLLUP_USER
    assert rollup_core.build_rollup_schema() == rollup_v1.build_rollup_schema()


def test_rollup_plan_shape_bare_schema_and_node_keys() -> None:
    from worker.pipeline.rollup_core import plan_rollups

    nodes = [
        {"id": "unt_ch10", "title": "Chapter 10 Optimization", "level": 1, "children": [
            {"title": "10.1 Optimization Overview", "intro": "优化总览",
             "key_takeaways": ["先测再调"], "n_cards": 3},
            {"title": "10.2 Optimizing SQL Statements", "intro": "SQL 层优化", "n_cards": 5}]},
        {"id": "unt_root", "title": "MySQL 26.7 Reference Manual", "level": 0,
         "self_intro": "手册根", "children": [{"title": "Chapter 10 Optimization"}]},
    ]
    out = plan_rollups(nodes)
    # ① schema 是**裸的**（没有 {name, schema} 包装 —— Lead 踩过的坑）
    assert set(out["schema"]) >= {"type", "properties", "required", "additionalProperties"}
    assert "name" not in out["schema"] and "schema" not in out["schema"]
    assert sorted(out["schema"]["properties"]) == [
        "intro", "key_takeaways", "objectives", "section_role", "why_important",
    ]
    assert out["schema"]["additionalProperties"] is False
    assert out["schema"]["properties"]["section_role"]["type"] == ["string", "null"]
    assert out["schema"]["required"] == ["intro", "why_important", "key_takeaways",
                                        "objectives", "section_role"]
    # ② key 用共用的 node key（`<id>#node`），能被同一个 parse_key 解析
    assert [i["key"] for i in out["items"]] == ["unt_ch10#node", "unt_root#node"]
    assert [i["node_id"] for i in out["items"]] == ["unt_ch10", "unt_root"]
    assert core.parse_key(out["items"][0]["key"]) == ("unt_ch10", "node", None, None)
    assert out["nodes_total"] == 2 and out["internal_nodes"] == 2
    assert out["items"][1]["has_self_intro"] is True
    # ③ user 提示词注入了子节点摘要
    assert "Chapter 10 Optimization（层级 L1）" in out["items"][0]["user"]
    assert "### 10.1 Optimization Overview" in out["items"][0]["user"]
    assert "- 知识点卡片：3 张" in out["items"][0]["user"]
    assert "（无子节点）" not in out["items"][0]["user"]
    # ④ 无子节点时明确写"无"
    empty = plan_rollups([{"id": "x", "title": "T", "level": 2, "children": []}])
    assert "（无子节点）" in empty["items"][0]["user"]


def test_rollup_convert_validates_and_reports() -> None:
    from worker.pipeline.rollup_core import convert_rollups

    good = {"key": "unt_ch10#node", "data": {
        "intro": "本章讲怎么让 MySQL 更快", "why_important": "性能是生产核心诉求",
        "objectives": ["能解释 buffer pool"], "key_takeaways": ["先测量再优化"],
        "section_role": "concept_intro"}}
    out = convert_rollups([good])
    assert out["ok"] is True and out["error_count"] == 0 and out["converted"] == 1
    assert out["rollups"]["unt_ch10"] == {
        "intro": "本章讲怎么让 MySQL 更快", "why_important": "性能是生产核心诉求",
        "objectives": ["能解释 buffer pool"], "key_takeaways": ["先测量再优化"],
        "section_role": "concept_intro",
    }

    # ① 空 section_role（strict 模式下合法）→ 不写该字段，不算错
    null_role = {"key": "unt_x#node", "data": {
        "intro": "a", "why_important": "b", "objectives": [], "key_takeaways": [],
        "section_role": None}}
    out2 = convert_rollups([null_role])
    assert out2["ok"] is True and "section_role" not in out2["rollups"]["unt_x"]

    # ② 非法 role / 缺必填 / 坏 key → 逐条报错，且不产出该节点
    out3 = convert_rollups([
        {"key": "unt_bad#node", "data": {"intro": "a", "why_important": "b",
                                        "objectives": [], "key_takeaways": [],
                                        "section_role": "瞎写的角色"}},
        {"key": "unt_missing#node", "data": {"intro": "only intro"}},
        {"key": "没有分隔符", "data": {"intro": "a", "why_important": "b",
                                     "objectives": [], "key_takeaways": []}},
    ])
    assert out3["converted"] == 0 and out3["ok"] is False and out3["error_count"] == 3
    assert [e["code"] for e in out3["errors"]] == [
        "E_ROLLUP_SCHEMA", "E_ROLLUP_SCHEMA", "E_ROLLUP_KEY",
    ]
    assert "不在枚举" in out3["errors"][0]["msg"]
    assert "缺必填字段" in out3["errors"][1]["msg"]

    # ③ 多给字段（模型夹带 key/title）→ 剥掉后照样通过
    out4 = convert_rollups([{"key": "unt_y#node", "node_id": "unt_y", "data": {
        "key": "unt_y#node", "title": "标题", "intro": "a", "why_important": "b",
        "objectives": ["o"], "key_takeaways": ["k"]}}])
    assert out4["ok"] is True and out4["rollups"]["unt_y"]["intro"] == "a"
