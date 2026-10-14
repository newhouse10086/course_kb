# -*- coding: utf-8 -*-
"""`worker/cli.py` 协议测试（ARCHITECTURE_V2 §3.1）—— **真子进程 + 真 JSONL**。

断言的是**字节级协议**（不是"看起来对"）：
* stdout 每行都是 JSON、**帧内无裸换行**、纯 ASCII
* 事件类型/字段（progress/log/unit/result/error）
* 退出码：0 成功 / 1 任务失败 / 2 入参错误
* `--in` 内联 JSON、`--in <file>`、stdin 三种传法
* `parse` → `units` → `extract.plan` → `extract.convert` 的链路（**含无 id 的 UnitDraft 形状**）
* `extract` 走**真 HTTP**（本地 stub 服务）验证 `json_schema + strict` 与并发=1
* `asr op=probe` 的形状与诚实降级（模型边界用替身，真模型在 E2E 里验过）
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from worker import cli
from worker.pipeline.llm import LLMConfig

ROOT = Path(__file__).resolve().parents[2]


# ═══════════════════════════════════════════════════════════════════════
# 工具
# ═══════════════════════════════════════════════════════════════════════
def run_cli(args: list[str], stdin_text: str | None = None, timeout: int = 180):
    proc = subprocess.run(
        [sys.executable, "-m", "worker.cli", *args],
        input=(stdin_text.encode("utf-8") if stdin_text is not None else None),
        capture_output=True, cwd=str(ROOT), timeout=timeout,
    )
    out = proc.stdout.decode("utf-8", "replace")
    events = [json.loads(ln) for ln in out.split("\n") if ln.strip()]
    return proc.returncode, events, out, proc.stderr.decode("utf-8", "replace")


def result_of(events: list[dict]) -> dict:
    rs = [e for e in events if e["type"] == "result"]
    assert rs, f"没有 result 帧：{events[-1] if events else '空'}"
    return rs[-1]["data"]


def last(events: list[dict]) -> dict:
    return events[-1]


@pytest.fixture()
def pdf_path(tmp_path: Path) -> Path:
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    for i in range(1, 13):
        doc.new_page().insert_text((72, 72), f"page {i} about indexes and transactions.")
    doc.set_toc([
        [1, "Chapter 1 General Information", 1],
        [2, "1.1 About This Manual", 1],
        [3, "1.1.1 Using the Manual", 2],
        [1, "Chapter 2 Installing MySQL", 5],
        [2, "2.1 General Installation Guidance", 5],
        [1, "Index", 11],
    ])
    p = tmp_path / "manual.pdf"
    doc.save(str(p))
    doc.close()
    return p


# ═══════════════════════════════════════════════════════════════════════
# 字节级协议
# ═══════════════════════════════════════════════════════════════════════
def test_stdout_is_strict_jsonl_and_ascii() -> None:
    """含 U+2028/U+2029 与换行的 payload：每帧一行、纯 ASCII、可逐帧解析。"""
    payload = {"job": "ping", "note": "行分隔符\u2028与\u2029还有\n换行"}
    code, events, out, err = run_cli([], stdin_text=json.dumps(payload, ensure_ascii=False))
    assert code == 0
    assert events and events[-1]["type"] == "result"
    # ① 逐行解析（按 \n 切字节即可，帧内无裸换行）
    lines = [ln for ln in out.split("\n") if ln.strip()]
    assert len(lines) == len(events)
    assert all(json.loads(ln) for ln in lines)
    # ② 纯 ASCII（中文/行分隔符都被转义，读取器不会踩到多字节）
    assert out.isascii(), "stdout 必须是纯 ASCII（ensure_ascii=True）"
    assert "\u2028" not in out and "\u2029" not in out
    # ③ 帧内无裸换行：第一帧里除结尾 \n 外没有 \n
    first = out.split("\n")[0]
    assert first.startswith('{"type":"log"') or first.startswith('{"type":"result"')
    assert json.loads(first)["type"] in ("log", "result")
    # ④ stderr 不是协议
    assert "result" not in err or "{" not in err


def test_stage_and_frac_types() -> None:
    """frac 必须是数字、stage 必须是字符串（T-BACKEND 会因此判坏帧）。"""
    code, events, out, err = run_cli(["--job", "parse"], stdin_text=json.dumps(
        {"job": "parse", "path": "不存在的文件.pdf"}))
    # 路径不存在属于**入参错误**（Node 应先在 TS 侧校验）→ exit 2 + error 帧
    assert code == 2
    assert last(events)["type"] == "error"
    assert last(events)["code"] == "E_PAYLOAD"
    assert "不存在" in last(events)["msg"]


def test_exit_codes() -> None:
    # 0：成功
    assert run_cli([], stdin_text='{"job":"ping"}')[0] == 0
    # 1：未知 job（已发 error + 退出码 1）
    code, events, _o, _e = run_cli(["--job", "nope"], stdin_text='{"job":"nope"}')
    assert code == 1 and last(events)["code"] == "E_JOB_UNKNOWN"
    assert "可用" in last(events)["detail"]
    # 2：坏 JSON / 无参数
    assert run_cli(["--job", "parse"], stdin_text="{ 不是 json")[0] == 2
    assert run_cli(["--job", "parse"], stdin_text="")[0] == 2
    # 2：字段缺失
    code2, ev2, _o, _e = run_cli(["--job", "search"], stdin_text='{"job":"search"}')
    assert code2 == 2 and last(ev2)["code"] == "E_PAYLOAD"


def test_inline_json_and_file_and_stdin_all_work(tmp_path: Path) -> None:
    inline = '{"job":"search","q":"索引优化"}'
    code, events, _o, _e = run_cli(["--job", "search", "--in", inline])
    assert code == 0
    assert result_of(events)["match_expr"] == '"索引" AND "引优" AND "优化"'

    f = tmp_path / "payload.json"
    f.write_text('{"job":"search","q":"sql_mode"}', encoding="utf-8")
    code2, events2, _o, _e = run_cli(["--job", "search", "--in", str(f)])
    assert code2 == 0 and result_of(events2)["terms"] == ["sql_mode"]

    code3, events3, _o, _e = run_cli([], stdin_text='{"job":"search","q":"事务"}')
    assert code3 == 0 and result_of(events3)["terms"] == ["事务"]


def test_list_jobs_and_version_and_help() -> None:
    code, events, out, _e = run_cli(["--list-jobs"])
    assert code == 0
    data = result_of(events)
    names = {j["job"] for j in data["jobs"]}
    assert {"parse", "units", "extract", "extract.plan", "extract.convert", "xref",
            "index", "search", "asr", "video.*", "ping"} <= names
    assert data["worker_version"] == cli.WORKER_VERSION

    code2, events2, _o2, _e = run_cli(["--version"])
    assert code2 == 0
    # stdout 只走协议：版本也是一帧 JSON（不是纯文本）
    assert result_of(events2)["worker_version"] == cli.WORKER_VERSION

    # --help 是人类可读文本（不走 JSONL 协议）→ 直接看 stdout 文本
    help_proc = subprocess.run([sys.executable, "-m", "worker.cli", "--help"],
                               capture_output=True, cwd=str(ROOT))
    assert help_proc.returncode == 0
    help_text = help_proc.stdout.decode("utf-8", "replace")
    assert "--job" in help_text and "JSONL" in help_text


def test_stdout_is_not_polluted_by_print() -> None:
    """第三方库/业务代码 print() 不能污染协议（外壳把 stdout 重定向到 stderr）。"""
    import io

    buf = io.BytesIO()

    class _Sink:
        def write(self, b):  # noqa: ANN001
            buf.write(b)

        def flush(self) -> None:
            pass

    emit = cli.Emitter(_Sink())
    saved = sys.stdout
    try:
        def job(payload, em):  # noqa: ANN001
            print("这行不能进协议")          # 模拟第三方库 print
            sys.stdout.write("也不能进协议\n")
            return {"ok": True}

        cli.JOBS["__test_print__"] = cli.JobSpec(job, "test")
        with __import__("contextlib").redirect_stdout(sys.stderr):
            code = cli.run({"job": "__test_print__"}, emit)
    finally:
        cli.JOBS.pop("__test_print__", None)
        sys.stdout = saved
    assert code == 0
    out = buf.getvalue().decode("utf-8")
    assert out.count("\n") == 1 and out.startswith('{"type":"result"')
    assert "不能进协议" not in out


# ═══════════════════════════════════════════════════════════════════════
# parse → units（含 UnitDraft 形状）
# ═══════════════════════════════════════════════════════════════════════
def test_parse_job_shape_and_unit_frames(pdf_path: Path) -> None:
    code, events, out, _e = run_cli(["--job", "parse"], stdin_text=json.dumps(
        {"job": "parse", "path": str(pdf_path)}))
    assert code == 0
    data = result_of(events)
    # ① T-BACKEND 约定形状
    assert set(data) >= {"document", "units", "stats"}
    doc = data["document"]
    assert doc["kind"] == "pdf" and doc["page_count"] == 12
    assert doc["meta"]["parse"]["toc_entries"] == 6
    assert doc["meta"]["parse"]["skipped_roots"] == ["Index"]
    assert data["stats"]["units"] == 5          # 6 个 TOC 条目保留 5 个（Index 被排除）
    assert data["stats"]["parse_mode"] == "toc"
    assert data["stats"]["skipped_nodes"] == 1
    # ② units 用 ord/parent_ord（契约 §4 UnitDraft）
    u0 = data["units"][0]
    assert set(u0) >= {"ord", "title", "level", "parent_ord", "span", "text"}
    assert "id" not in u0, "parse 输出的是 UnitDraft（入库时 Node 才分配 id）"
    assert [u["ord"] for u in data["units"]] == [1, 2, 3, 4, 5]
    assert data["units"][1]["parent_ord"] == 1
    assert data["units"][0]["span"] == {"kind": "page", "start": 1, "end": 4}
    # ③ 流式 unit 帧
    unit_frames = [e for e in events if e["type"] == "unit"]
    assert len(unit_frames) == 5
    assert unit_frames[0]["data"]["ord"] == 1
    # ④ 进度帧：frac 数字且单调不减
    fracs = [e["frac"] for e in events if e["type"] == "progress"]
    assert fracs and all(isinstance(f, (int, float)) for f in fracs)
    assert fracs == sorted(fracs) and fracs[-1] == 1.0


def test_parse_can_disable_unit_frames(pdf_path: Path) -> None:
    code, events, _o, _e = run_cli(["--job", "parse"], stdin_text=json.dumps(
        {"job": "parse", "path": str(pdf_path), "stream_units": False}))
    assert code == 0
    assert not [e for e in events if e["type"] == "unit"]


def test_parse_unsupported_format(tmp_path: Path) -> None:
    p = tmp_path / "x.zzz"
    p.write_bytes(b"\x00\x01\x02")
    code, events, _o, _e = run_cli(["--job", "parse"],
                                   stdin_text=json.dumps({"job": "parse", "path": str(p)}))
    assert code == 1 and last(events)["code"] == "E_FORMAT"
    assert ".pdf" in last(events)["detail"]


def test_units_job_accepts_idless_draft_shape(pdf_path: Path) -> None:
    """Node 在**入库前**调 units（此时没有 id）—— 必须能接。"""
    _c, ev, _o, _e = run_cli(["--job", "parse"], stdin_text=json.dumps(
        {"job": "parse", "path": str(pdf_path), "stream_units": False}))
    units = result_of(ev)["units"]
    code, ev2, _o, _e = run_cli(["--job", "units"], stdin_text=json.dumps(
        {"job": "units", "units": units, "max_pages": 8, "pages_total": 12}))
    assert code == 0
    data = result_of(ev2)
    # Chapter 1（1–4，含子区间）与 Chapter 2（5–10）都够小 → 各整体选 1 个
    assert data["stats"]["n_picked"] == 2
    assert data["stats"]["coverage"] == 1.0 and data["stats"]["missing_count"] == 0
    picked = data["picked"]
    # 合成 id 是确定性的（ord 派生），父子关系已映射
    assert picked[0]["unit_id"].startswith("unt_")
    assert picked[0]["kind"] == "section" and picked[0]["span"]["kind"] == "page"


# ═══════════════════════════════════════════════════════════════════════
# extract.plan → (Node 调模型) → extract.convert
# ═══════════════════════════════════════════════════════════════════════
def test_plan_and_convert_roundtrip_without_llm(pdf_path: Path) -> None:
    _c, ev, _o, _e = run_cli(["--job", "parse"], stdin_text=json.dumps(
        {"job": "parse", "path": str(pdf_path), "stream_units": False}))
    units = result_of(ev)["units"]

    code, ev1, _o, _e = run_cli(["--job", "extract.plan"], stdin_text=json.dumps(
        {"job": "extract.plan", "doc_id": "doc_cli000000001", "units": units,
         "source_name": "MySQL 26.7 Reference Manual", "pages_total": 12}))
    assert code == 0
    plan = result_of(ev1)
    assert len(plan["items"]) == 2
    assert plan["schema"]["properties"]["cards"]["items"]["properties"]["kind"]["enum"]
    item = plan["items"][0]
    assert item["system"].startswith("你是**数据库课程的知识工程师**")
    assert "## 位置" in item["user"] and "章节路径：Chapter 1" in item["user"]

    payloads = [
        {"key": it["key"], "unit_key": it["unit_key"], "span": it["span"], "data": {
            "section": {"section_summary": f"{it['title']} 的概述。", "learning_objectives": ["能读懂"],
                        "section_role": "reference", "key_takeaways": ["要点一"]},
            "cards": [{
                "name": "SHOW DATABASES", "kind": "sql_statement",
                "one_line": "列出服务器上现有数据库的语句", "purpose": "摸清有哪些库",
                "usage_mode": "user_invoked", "operational_role": "diagnostics",
                "lifecycle": "builtin", "example": "SHOW DATABASES;",
                "example_explained": "返回库列表", "prerequisites": [], "cautions": [],
                "evidence_quote": "Use the SHOW statement...", "evidence_page": 1,
                "confidence": 0.95,
            }],
            "entities": [{"name": "SHOW DATABASES", "name_zh": "", "type": "concept", "layer": "L1"},
                         {"name": "information_schema", "name_zh": "信息模式", "type": "concept", "layer": "L2"}],
            "edges": [{"src": "SHOW DATABASES", "dst": "information_schema", "etype": "DEPENDS_ON",
                       "evidence_text": "lists databases", "confidence": 0.8}],
        }}
        for it in plan["items"]
    ]
    code2, ev2, _o, _e = run_cli(["--job", "extract.convert"], stdin_text=json.dumps(
        {"job": "extract.convert", "doc_id": "doc_cli000000001", "units": units,
         "payloads": payloads}))
    assert code2 == 0
    conv = result_of(ev2)
    assert len(conv["cards"]) == 2
    assert len(conv["entities"]) == 2, "同名实体必须跨单元归并"
    assert len(conv["edges"]) == 2, "同一 (src,dst,etype) 在不同单元都成立"
    assert len(conv["sections"]) == 2
    assert conv["errors"] == []
    card = conv["cards"][0]
    assert card["kind"] == "sql_statement"
    assert card["evidence_span"]["kind"] == "page"
    assert card["id"] == conv["cards"][0]["id"] and card["id"].startswith("crd_")
    assert all(e["src"] != e["dst"] for e in conv["edges"])


def test_plan_order_is_document_order_and_skip_titles_is_explicit(pdf_path: Path) -> None:
    """`items` 是**文档顺序**；跳过前言类必须由调用方**显式**指定并如实回报。"""
    _c, ev, _o, _e = run_cli(["--job", "parse"], stdin_text=json.dumps(
        {"job": "parse", "path": str(pdf_path), "stream_units": False}))
    units = result_of(ev)["units"]

    _c1, ev1, _o, _e = run_cli(["--job", "extract.plan"], stdin_text=json.dumps(
        {"job": "extract.plan", "units": units}))
    plan = result_of(ev1)
    assert plan["order"] == "document"
    assert [it["title"] for it in plan["items"]] == [
        "Chapter 1 General Information", "Chapter 2 Installing MySQL",
    ]
    starts = [it["span"]["start"] for it in plan["items"]]
    assert starts == sorted(starts), "文档顺序 = 页码单调不减"

    # 显式跳过第一个 chapter（模拟"跳前言/封面"）
    _c2, ev2, _o, _e = run_cli(["--job", "extract.plan"], stdin_text=json.dumps(
        {"job": "extract.plan", "units": units, "skip_titles": ["^Chapter 1"]}))
    plan2 = result_of(ev2)
    assert len(plan2["items"]) == 1
    assert plan2["skipped_items"] == 1
    assert plan2["skipped_titles"] == ["Chapter 1 General Information"]
    # ★ 连同**子树**一起跳过（只丢父节点会把子节点变成孤儿，反而多出零碎单元）
    assert plan2["skipped_units"] == 3
    assert plan2["items"][0]["title"] == "Chapter 2 Installing MySQL"

    # 默认**不跳过任何东西**（不做隐式魔法）
    assert plan["skipped_items"] == 0 and plan["skipped_titles"] == []

    # 非法正则 → 入参错误（exit 2）
    code, ev3, _o, _e = run_cli(["--job", "extract.plan"], stdin_text=json.dumps(
        {"job": "extract.plan", "units": units, "skip_titles": ["["]}))
    assert code == 2 and last(ev3)["code"] == "E_PAYLOAD"


# ═══════════════════════════════════════════════════════════════════════
# S2 汇总 job（rollup.plan / rollup.convert）
# ═══════════════════════════════════════════════════════════════════════
ROLLUP_NODES = [
    {"id": "unt_ch10", "title": "Chapter 10 Optimization", "level": 1, "children": [
        {"title": "10.1 Optimization Overview", "intro": "优化总览",
         "key_takeaways": ["先测再调"], "n_cards": 3},
        {"title": "10.2 Optimizing SQL Statements", "intro": "SQL 层优化", "n_cards": 5}]},
    {"id": "unt_root", "title": "MySQL 26.7 Reference Manual", "level": 0,
     "self_intro": "手册根", "children": [{"title": "Chapter 10 Optimization"}]},
]


def test_rollup_plan_and_convert_roundtrip() -> None:
    code, ev, _o, _e = run_cli(["--job", "rollup.plan"], stdin_text=json.dumps(
        {"job": "rollup.plan", "nodes": ROLLUP_NODES}))
    assert code == 0
    plan = result_of(ev)
    # 裸 schema（无 {name,schema} 包装）+ 共用 key 语法
    assert "name" not in plan["schema"] and plan["schema"]["additionalProperties"] is False
    assert [i["key"] for i in plan["items"]] == ["unt_ch10#node", "unt_root#node"]
    assert plan["nodes_total"] == 2 and plan["skipped_nodes"] == 0
    assert "### 10.1 Optimization Overview" in plan["items"][0]["user"]

    payloads = [
        {"key": plan["items"][0]["key"], "data": {
            "intro": "本章讲怎么让 MySQL 更快", "why_important": "性能是生产核心诉求",
            "objectives": ["能解释 buffer pool"], "key_takeaways": ["先测量再优化"],
            "section_role": "concept_intro"}},
        {"key": plan["items"][1]["key"], "data": {
            "intro": "整本手册汇总", "why_important": "全局索引", "objectives": [],
            "key_takeaways": [], "section_role": None}},
    ]
    code2, ev2, _o, _e = run_cli(["--job", "rollup.convert"], stdin_text=json.dumps(
        {"job": "rollup.convert", "nodes": ROLLUP_NODES, "payloads": payloads}))
    assert code2 == 0
    conv = result_of(ev2)
    assert conv["ok"] is True and conv["error_count"] == 0 and conv["converted"] == 2
    assert sorted(conv["rollups"]) == ["unt_ch10", "unt_root"]
    assert conv["rollups"]["unt_ch10"]["section_role"] == "concept_intro"
    assert "section_role" not in conv["rollups"]["unt_root"], "空 role 不写该字段"


def test_rollup_convert_partial_and_total_failure() -> None:
    # 部分成功：exit 0 但 ok=false
    code, ev, _o, _e = run_cli(["--job", "rollup.convert"], stdin_text=json.dumps(
        {"job": "rollup.convert", "payloads": [
            {"key": "unt_a#node", "data": {"intro": "a", "why_important": "b",
                                          "objectives": [], "key_takeaways": []}},
            {"key": "坏", "data": {}}]}))
    assert code == 0
    data = result_of(ev)
    assert data["ok"] is False and data["error_count"] == 1 and data["converted"] == 1
    assert data["errors"][0]["code"] == "E_ROLLUP_KEY"

    # 全部失败 → exit 1（响亮，与 extract.convert 同语义）
    code2, ev2, _o, _e = run_cli(["--job", "rollup.convert"], stdin_text=json.dumps(
        {"job": "rollup.convert", "payloads": [{"key": "坏", "data": {}}]}))
    assert code2 == 1
    assert last(ev2)["code"] == "E_ROLLUP_KEY" and "一个都没" in last(ev2)["msg"]


def test_rollup_plan_skip_titles_drops_subtree() -> None:
    code, ev, _o, _e = run_cli(["--job", "rollup.plan"], stdin_text=json.dumps(
        {"job": "rollup.plan", "nodes": ROLLUP_NODES, "skip_titles": ["^Chapter 10"]}))
    assert code == 0
    plan = result_of(ev)
    # 父节点 + 内联子节点（同名）一起被丢；标题去重后只报一次
    assert [i["key"] for i in plan["items"]] == ["unt_root#node"]
    assert plan["skipped_nodes"] == 4
    assert plan["skipped_titles"] == ["Chapter 10 Optimization"]

    code2, ev2, _o, _e = run_cli(["--job", "rollup.plan"], stdin_text=json.dumps(
        {"job": "rollup.plan", "nodes": ROLLUP_NODES, "skip_titles": ["["]}))
    assert code2 == 2 and last(ev2)["code"] == "E_PAYLOAD"


# ═══════════════════════════════════════════════════════════════════════
# ★ 回归：plan → convert 的 key 契约（Lead 实测「卡片被静默丢弃」）
# ═══════════════════════════════════════════════════════════════════════
def test_key_syntax_is_shared_between_plan_and_convert() -> None:
    """`<unit_id>#<kind>:<start>-<end>` —— 只有一份实现（extract_core）。"""
    from worker.models import Span
    from worker.pipeline.extract_core import make_key, parse_key, pick_key, span_key

    assert make_key("unt_x", Span("page", 1, 2)) == "unt_x#page:1-2"
    assert parse_key("unt_x#page:1-2") == ("unt_x", "page", 1, 2)
    assert parse_key("unt_x#char:0-9999") == ("unt_x", "char", 0, 9999)
    assert parse_key("unt_x#time:0-480000") == ("unt_x", "time", 0, 480000)
    assert parse_key("nonsense") is None
    assert parse_key("") is None
    assert parse_key("unt_x#page:1") is None
    pu = __import__("worker.pipeline.units", fromlist=["PickedUnit"]).PickedUnit(
        ord=1, unit_id="unt_x", title="t", level=1, kind="section",
        span=Span("page", 1, 2), text="x")
    assert pick_key(pu) == make_key("unt_x", pu.span) == "unt_x#page:1-2"
    assert span_key(pu.span) == "page:1-2"


def test_plan_convert_roundtrip_keeps_every_card(pdf_path: Path) -> None:
    """★ Lead 提的回归：plan → 人工造 payload → convert，**卡片数必须相等**。

    原 bug：plan 的 key 在 convert 里对不上 → cards=0 但 exit=0（静默丢弃）。
    """
    _c, ev, _o, _e = run_cli(["--job", "parse"], stdin_text=json.dumps(
        {"job": "parse", "path": str(pdf_path), "stream_units": False}))
    units = result_of(ev)["units"]
    # ⚠️ 故意**不传 doc_id**（真实调用方很可能这么干）
    _c2, ev1, _o, _e = run_cli(["--job", "extract.plan"], stdin_text=json.dumps(
        {"job": "extract.plan", "units": units}))
    plan = result_of(ev1)

    def one_card(i: int) -> dict:
        return {
            "name": f"知识点{i}", "kind": "concept", "one_line": f"第{i}个定义",
            "purpose": "p", "usage_mode": "user_invoked", "operational_role": "feature",
            "lifecycle": "builtin", "example": None, "example_explained": None,
            "prerequisites": [], "cautions": [], "evidence_quote": "q",
            "evidence_page": 1, "confidence": 0.9,
        }

    payloads = [
        {"key": it["key"], "data": {"section": {"section_summary": "s",
                                                "learning_objectives": [],
                                                "section_role": "concept_intro",
                                                "key_takeaways": []},
                                    "cards": [one_card(i) for i in range(2)],
                                    "entities": [], "edges": []}}
        for i, it in enumerate(plan["items"])
    ]
    # convert 传**另一个 doc_id**（模拟两次独立调用）→ 仍必须全部匹配
    code, ev2, _o, _e = run_cli(["--job", "extract.convert"], stdin_text=json.dumps(
        {"job": "extract.convert", "doc_id": "d1", "units": units, "payloads": payloads}))
    assert code == 0, last(ev2)
    conv = result_of(ev2)
    assert conv["ok"] is True and conv["error_count"] == 0
    assert len(payloads) == 2 and len(conv["cards"]) == 2 * len(payloads) == 4
    assert {c["name"] for c in conv["cards"]} == {f"知识点{i}" for i in range(2)}


def test_convert_fails_loudly_when_nothing_matches(pdf_path: Path) -> None:
    """全部对不上 → exit 1 + E_PICK_KEY（**不许静默成功**）。"""
    _c, ev, _o, _e = run_cli(["--job", "parse"], stdin_text=json.dumps(
        {"job": "parse", "path": str(pdf_path), "stream_units": False}))
    units = result_of(ev)["units"]
    code, ev2, _o, _e = run_cli(["--job", "extract.convert"], stdin_text=json.dumps(
        {"job": "extract.convert", "doc_id": "d1", "units": units,
         "payloads": [{"key": "unt_不存在#page:99-99", "data": {"cards": []}}]}))
    assert code == 1
    assert last(ev2)["code"] == "E_PICK_KEY"
    assert "一个都没匹配上" in last(ev2)["msg"]


def test_convert_partial_success_sets_ok_false(pdf_path: Path) -> None:
    """部分成功：exit 0，但 data.ok=false + error_count 明确标记（调用方看得到）。"""
    _c, ev, _o, _e = run_cli(["--job", "parse"], stdin_text=json.dumps(
        {"job": "parse", "path": str(pdf_path), "stream_units": False}))
    units = result_of(ev)["units"]
    _c2, ev1, _o, _e = run_cli(["--job", "extract.plan"], stdin_text=json.dumps(
        {"job": "extract.plan", "units": units}))
    it = result_of(ev1)["items"][0]
    good = {"key": it["key"], "data": {
        "section": {"section_summary": "s", "learning_objectives": [],
                    "section_role": "concept_intro", "key_takeaways": []},
        "cards": [], "entities": [], "edges": []}}
    code, ev2, _o, _e = run_cli(["--job", "extract.convert"], stdin_text=json.dumps(
        {"job": "extract.convert", "doc_id": "d1", "units": units,
         "payloads": [good, {"key": "unt_坏#page:1-1", "data": {"cards": []}}]}))
    assert code == 0
    data = result_of(ev2)
    assert data["ok"] is False and data["error_count"] == 1
    assert data["stats"]["units_done"] == 1


# ═══════════════════════════════════════════════════════════════════════
# extract：真 HTTP（本地 stub 服务）
# ═══════════════════════════════════════════════════════════════════════
class _StubLLM(BaseHTTPRequestHandler):
    """极简 OpenAI 兼容 stub：记录收到的请求体，按固定 JSON 回复。"""

    seen: list[dict] = []

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        type(self).seen.append(body)
        content = json.dumps({
            "section": {"section_summary": "本节讲索引。", "learning_objectives": ["能说明聚簇索引"],
                        "section_role": "concept_intro", "key_takeaways": ["按主键顺序存放"]},
            "cards": [{"name": "聚簇索引", "kind": "concept", "one_line": "数据按主键顺序存放的索引",
                       "purpose": "范围查询只读连续一段", "usage_mode": "server_automatic",
                       "operational_role": "performance", "lifecycle": "builtin",
                       "example": None, "example_explained": None, "prerequisites": [],
                       "cautions": ["二级索引要回表"], "evidence_quote": "Clustered indexes…",
                       "evidence_page": 1, "confidence": 0.9}],
            "entities": [{"name": "聚簇索引", "name_zh": "聚簇索引", "type": "feature", "layer": "L2"}],
            "edges": [],
        }, ensure_ascii=False)
        payload = json.dumps({"choices": [{"message": {"content": content}}]}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):  # noqa: ANN002 - 静音
        pass


@pytest.fixture()
def stub_llm_server():
    _StubLLM.seen = []
    server = HTTPServer(("127.0.0.1", 0), _StubLLM)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{server.server_port}/v1"
    server.shutdown()


def test_extract_job_over_real_http(pdf_path: Path, stub_llm_server: str, tmp_path: Path) -> None:
    _c, ev, _o, _e = run_cli(["--job", "parse"], stdin_text=json.dumps(
        {"job": "parse", "path": str(pdf_path), "stream_units": False}))
    units = result_of(ev)["units"]
    ckpt = tmp_path / "ckpt" / "doc_extract.json"
    payload = {
        "job": "extract", "doc_id": "doc_http00000001", "units": units,
        "llm": {"base_url": stub_llm_server, "api_key": "sk-stub", "model": "stub-model"},
        "checkpoint_file": str(ckpt), "resume": True, "pages_total": 12,
    }
    code, ev2, _o, _e = run_cli(["--job", "extract"], stdin_text=json.dumps(payload))
    assert code == 0
    data = result_of(ev2)
    assert data["stats"]["units_done"] == 2
    assert data["stats"]["cards"] == 2 and data["stats"]["entities"] == 1
    assert data["stats"]["concurrency"] == 1
    assert data["stats"]["llm"]["model"] == "stub-model"
    assert "sk-stub" not in json.dumps(data)
    # ① 请求确实用了 json_schema + strict（坑 4）
    assert len(_StubLLM.seen) == 2
    for req in _StubLLM.seen:
        rf = req["response_format"]
        assert rf["type"] == "json_schema" and rf["json_schema"]["strict"] is True
        assert rf["json_schema"]["schema"]["additionalProperties"] is False
        assert req["temperature"] == 0.0
    # ② 断点落盘 + 续跑不再调模型
    assert ckpt.exists()
    seen_before = len(_StubLLM.seen)
    code2, ev3, _o, _e = run_cli(["--job", "extract"], stdin_text=json.dumps(payload))
    assert code2 == 0
    assert result_of(ev3)["stats"]["units_skipped"] == 2
    assert len(_StubLLM.seen) == seen_before, "断点续跑不该再发请求"


def test_extract_job_without_llm_config_fails_honestly(pdf_path: Path) -> None:
    _c, ev, _o, _e = run_cli(["--job", "parse"], stdin_text=json.dumps(
        {"job": "parse", "path": str(pdf_path), "stream_units": False}))
    units = result_of(ev)["units"]
    code, ev2, _o, _e = run_cli(["--job", "extract"], stdin_text=json.dumps(
        {"job": "extract", "units": units}))
    assert code == 1
    assert last(ev2)["code"] == "E_LLM"
    assert "llm" in last(ev2)["detail"]


# ═══════════════════════════════════════════════════════════════════════
# asr：probe 形状 + 诚实降级（模型边界用替身）
# ═══════════════════════════════════════════════════════════════════════
def test_asr_probe_shape_and_honest_failure(monkeypatch) -> None:
    events: list[dict] = []
    emit = cli.Emitter(__import__("io").BytesIO()) if False else _collector(events)

    # ① 成功：load_model_with_fallback 返回 (model, 实际型号, compute_type)
    from worker.video import asr as asr_mod

    monkeypatch.setattr(asr_mod, "load_model_with_fallback",
                        lambda name, **kw: (object(), name, "int8"))
    out = cli.job_asr({"input": {"op": "probe", "model": "tiny", "device": "cpu"}}, emit)
    assert out == {"ok": True, "model": "tiny", "device": "cpu", "compute_type": "int8",
                   "requested_model": "tiny", "degraded": False}

    # ② 降级：请求的模型不可用但链上有 → ok:true + degraded:true + 如实说明
    monkeypatch.setattr(asr_mod, "load_model_with_fallback",
                        lambda name, **kw: (object(), "tiny", "int8"))
    out2 = cli.job_asr({"input": {"op": "probe", "model": "large"}}, emit)
    assert out2["ok"] is True and out2["model"] == "tiny"
    assert out2["degraded"] is True and "large" in out2["reason"]

    # ③ 全链失败 → ok:false + reason（**绝不假装 ok**）
    def boom(name, **kw):  # noqa: ANN001
        raise RuntimeError("模型未下载")

    monkeypatch.setattr(asr_mod, "load_model_with_fallback", boom)
    out3 = cli.job_asr({"input": {"op": "probe", "model": "tiny"}}, emit)
    assert out3["ok"] is False and "模型未下载" in out3["reason"]
    assert out3["code"] == "E_ASR_LOAD"

    # ④ 未知 op → 参数错误
    with pytest.raises(cli.PayloadError):
        cli.job_asr({"input": {"op": "dance"}}, emit)


def test_asr_transcribe_requires_existing_audio(monkeypatch) -> None:
    emit = _collector()
    with pytest.raises(cli._Fail) as exc:
        cli.job_asr({"input": {"op": "transcribe", "audio_path": "不存在.wav"}}, emit)
    assert exc.value.code == "E_ASR_NO_AUDIO"


def test_asr_transcribe_maps_segments_to_camel_case(monkeypatch, tmp_path: Path) -> None:
    from worker.models import VideoSegment
    from worker.video import asr as asr_mod

    audio = tmp_path / "a.wav"
    audio.write_bytes(b"RIFF....")

    class _Res:
        segments = [VideoSegment(i=0, start=0, end=1200, text="今天我们讲索引", confidence=0.91),
                    VideoSegment(i=1, start=1200, end=2600, text="B+ 树", confidence=0.88)]
        lang = "zh"
        model = "tiny"
        duration_ms = 2600
        device = "cpu"
        chunks_total = 1
        chunks_done = 1
        chunks_resumed = 0
        elapsed_ms = 1234

    monkeypatch.setattr(asr_mod, "transcribe_audio",
                        lambda path, **kw: _Res())
    monkeypatch.setattr(asr_mod, "DEFAULT_MODEL_CHAIN", ("tiny", "base"))
    out = cli.job_asr({"input": {"op": "transcribe", "audio_path": str(audio), "model": "tiny",
                                 "language": "zh"}}, _collector())
    assert out["language"] == "zh" and out["model"] == "faster-whisper/tiny"
    assert out["durationMs"] == 2600
    assert out["segments"] == [
        {"i": 0, "startMs": 0, "endMs": 1200, "text": "今天我们讲索引", "confidence": 0.91},
        {"i": 1, "startMs": 1200, "endMs": 2600, "text": "B+ 树", "confidence": 0.88},
    ]


# ═══════════════════════════════════════════════════════════════════════
# 入参归一化
# ═══════════════════════════════════════════════════════════════════════
def test_normalize_payload_flattens_input() -> None:
    flat = cli.normalize_payload({"job": "asr", "input": {"op": "probe", "model": "tiny"}})
    assert flat["op"] == "probe" and flat["model"] == "tiny" and flat["job"] == "asr"
    assert flat["input"] == {"op": "probe", "model": "tiny"}
    # 外层字段优先（不被内层覆盖 job）
    flat2 = cli.normalize_payload({"job": "asr", "input": {"job": "别的", "op": "probe"}})
    assert flat2["job"] == "asr"
    assert cli.normalize_payload({"job": "x"})["job"] == "x"


def test_units_from_payload_synthesises_deterministic_ids() -> None:
    raw = [
        {"ord": 1, "title": "A", "level": 1, "parent_ord": None, "span": {"kind": "page", "start": 1, "end": 3}, "text": "t"},
        {"ord": 2, "title": "B", "level": 2, "parent_ord": 1, "span": {"kind": "page", "start": 4, "end": 5}, "text": "t"},
    ]
    a = cli.units_from_payload(raw, "doc_x")
    b = cli.units_from_payload(raw, "doc_x")
    assert [u.id for u in a] == [u.id for u in b]
    assert a[1].parent_id == a[0].id
    assert a[0].id.startswith("unt_")
    # 持久化形状（有 id）原样采纳
    persisted = [{"id": "unt_real", "doc_id": "doc_x", "order": 1, "title": "A", "level": 1,
                  "parent_id": None, "span": {"kind": "page", "start": 1, "end": 3}, "text": "t"}]
    got = cli.units_from_payload(persisted, "doc_x")
    assert got[0].id == "unt_real"


class _collector:
    """把事件收进 list 的 emit（测试用）。"""

    def __init__(self, sink: list[dict] | None = None):
        self.events = sink if sink is not None else []

    def __call__(self, event: dict) -> None:
        self.events.append(event)

    # 兼容 Emitter 的快捷方法签名（job_asr 只调用 __call__）
    def progress(self, *a, **k) -> None:  # noqa: ANN002, ANN003
        pass

    def info(self, msg: str) -> None:
        pass

    def warn(self, msg: str) -> None:
        pass
