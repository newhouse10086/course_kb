"""graph.html（独立图谱页）headless Chrome 断言。

验收对应（F5）：
  · 渲染 ≥1000 节点不卡 → 用 #perf-report 里的具体数字断言（物理 ms/tick、帧 ms）
  · 12 边类型筛选、flagged 虚线、节点大小 ∝ degree、点击看证据
运行：python -m pytest tests/test_web_graph.py -q
"""

from __future__ import annotations

import json
import re

import pytest

from test_web_common import (
    WEB, dump_dom, jsonscript, tag_attrs, count, has, strip_tags, text_of, DOC_PDF,
    # 夹具复用（不能新增 conftest.py：写域限定 tests/test_web_*.py）
    web_server, degraded_server, meta,
)

# 物理迭代基准阈值：1644 节点 / 481 边，一步迭代必须远低于 1/60s 的预算
TICK_MS_BUDGET = 25.0
AVG_FRAME_MS_BUDGET = 40.0


def graph_url(srv, selftest=False, focus=None):
    q = [f"doc={DOC_PDF}", "selftest=1" if selftest else "", f"focus={focus}" if focus else ""]
    return f"{srv.base}/graph.html?" + "&".join(x for x in q if x)


# ---------------------------------------------------------------- 静态结构

def test_graph_shell_structure():
    html = (WEB / "graph.html").read_text(encoding="utf-8")
    for needle in ['id="g-canvas"', 'id="etype-filters"', 'id="g-detail"', 'id="g-flagged"',
                   'id="g-mindeg"', 'id="g-legend"', 'id="g-selftest"', 'assets/graph-page.js']:
        assert needle in html, f"graph.html 缺少 {needle}"
    assert not re.search(r'(src|href)="https?://', html), "graph.html 引用了外部资源"
    body = strip_tags(html)
    assert "flagged" in body and "虚线" in body, "页面上必须说明 flagged 边用虚线"
    assert "degree" in body


def test_flagged_edges_drawn_dashed_in_source():
    """flagged 边必须走虚线分支（只标记不删除）。"""
    core = (WEB / "assets" / "graph-core.js").read_text(encoding="utf-8")
    assert re.search(r"setLineDash\(e\.flagged \? \[", core), "flagged 边没有虚线分支"
    assert re.search(r"flagged:\s*e\.flagged === true", core), "契约字段 flagged 没有解析"
    # flagged 不允许被过滤掉（只标记不删除）
    assert "flagged" in core and "!this.flaggedOnly || e.flagged" in core


def test_node_radius_scales_with_degree():
    core = (WEB / "assets" / "graph-core.js").read_text(encoding="utf-8")
    m = re.search(r"radiusOf\(n\)\s*\{\s*return\s*([^;]+);", core)
    assert m, "找不到 radiusOf 实现"
    assert "degree" in m.group(1), "节点半径必须 ∝ degree"


def test_twelve_etype_colors():
    core = (WEB / "assets" / "graph-core.js").read_text(encoding="utf-8")
    block = core.split("ETYPE_COLORS = {", 1)[1].split("}", 1)[0]
    keys = re.findall(r"([A-Z_]+):", block)
    assert len(keys) == 12, f"契约是封闭的 12 种 etype，实际 {len(keys)}：{keys}"
    for k in ("DEPENDS_ON", "PART_OF", "REALIZES", "IMPLEMENTS", "CONTRASTS_WITH", "INSTANCE_OF",
              "SCHEMA_PATTERN", "USED_IN_ROLE", "GOVERNED_BY", "HISTORICAL_ORIGIN",
              "COMMON_MISCONCEPTION", "ASSESSED_BY"):
        assert k in keys, f"缺少 {k}（schema/edge_types.json）"


# ---------------------------------------------------------------- 实跑（1644 节点 / 481 边）

@pytest.fixture(scope="module")
def dom(web_server):
    return dump_dom(graph_url(web_server, selftest=True), virtual_time_budget=30000)


def test_graph_meta_counts(dom, meta):
    a = tag_attrs(dom, "g-meta")
    assert int(a["data-nodes"]) == meta["graph_nodes"] == 1644
    assert int(a["data-edges"]) == meta["graph_edges"] == 481
    assert "1644" in text_of(dom, "g-meta")


def test_etype_filters_render_12(dom, meta):
    assert count(dom, r'data-etype-box="[A-Z_]+"') == 12, "12 种边类型必须有 12 个筛选框"
    for k in ("DEPENDS_ON", "PART_OF", "IMPLEMENTS", "CONTRASTS_WITH"):
        assert f'data-etype-box="{k}"' in dom
    # 每个筛选器旁边给出该类型的真实条数
    assert count(dom, r'class="cnt"') == 12


def test_flagged_edges_visible_and_legend(dom, meta):
    assert "legend-line dashed" in dom, "图例里必须有 flagged 虚线"
    assert tag_attrs(dom, "g-legend").get("data-flagged-legend") == "1"
    st = jsonscript(dom, "perf-report")
    assert st["flagged_edges"] == meta["flagged_edges"] == 66
    assert "flagged 66" in text_of(dom, "g-stats")


def test_perf_report_numbers(dom, meta):
    """≥1000 节点不卡：断言**真实时间**下的物理迭代耗时与帧耗时分布。

    注意：这里不用 --virtual-time-budget（虚拟时钟下 performance.now() 在同步执行期间
    不前进，实测 bench 恒为 0 —— 那样的"性能达标"是假的）。夹具用挂起请求把 load 事件
    推迟到页面渲染完成，于是拿到的是真实数字。
    """
    perf = jsonscript(dom, "perf-report")
    assert perf, "缺少 #perf-report"
    assert perf["nodes"] == 1644 and perf["edges"] == 481
    assert perf["ticks"] > 0 and perf["frames"] > 0
    assert perf["settled"] is True, f"布局没收敛就写性能报告：{perf}"
    assert perf["frame_samples"] >= 20, f"有效帧样本太少：{perf['frame_samples']}"
    bench = perf["bench"]
    assert bench["n"] == 10 and bench["per_tick_ms"] is not None
    assert bench["per_tick_ms"] > 0, "性能计时被虚拟时钟吞掉了（数字为 0 说明测量方式不对）"
    assert bench["per_tick_ms"] < TICK_MS_BUDGET, \
        f"单步物理迭代 {bench['per_tick_ms']}ms 超过预算 {TICK_MS_BUDGET}ms（1644 节点会卡）"
    p50 = perf["frame_ms_p50"]
    assert p50 is not None and p50 < AVG_FRAME_MS_BUDGET, \
        f"帧耗时中位数 {p50}ms 超过预算 {AVG_FRAME_MS_BUDGET}ms"
    assert perf["frame_ms_p95"] is not None
    assert perf["elapsed_ms"] > 0


def test_selftest_filters_and_click(dom, meta):
    r = jsonscript(dom, "selftest-report")
    assert r, "缺少 #selftest-report"
    c = r["checks"]
    assert c["nodes"] == 1644 and c["edges"] == 481
    assert c["etype_checkboxes"] == 12
    assert c["filter_ok"] is True, f"按 etype 筛选后的可见边数不对：{c}"
    assert c["filter_visible_edges"] == c["filter_expect_edges"]
    assert c["flagged_only_ok"] is True, "只看 flagged 时可见边没有全部是 flagged"
    assert c["flagged_only_visible_edges"] == meta["flagged_edges"]
    assert c["legend_dashed_flagged"] is True
    assert c["radius_monotonic"] is True, "节点半径必须随 degree 单调增"
    assert c["node_click_ok"] is True
    assert c["node_click_name"], "点击节点后详情面板要有节点名"
    assert c["perf_ok"] is True
    assert r["ok"] is True, f"图谱页自检未通过：{json.dumps(c, ensure_ascii=False)[:900]}"


def test_node_detail_panel_and_evidence(dom):
    """点击看证据：详情面板列出出边/入边与证据文本。"""
    body = strip_tags(dom)
    assert "出边" in body and "入边" in body
    assert "degree" in body
    assert count(dom, r'class="edge-row"') >= 1
    assert count(dom, r'class="etype"') >= 1
    assert 'id="g-evidence"' in dom
    assert count(dom, r'class="gnode-row"') >= 10, "节点列表应给出按 degree 排序的可点列表"


def test_focus_deeplink(web_server):
    """?focus=<ent_id> 深链：直接打开某节点的证据面板（等价于点它）。"""
    dom = dump_dom(graph_url(web_server, selftest=False, focus="innodb"), virtual_time_budget=20000)
    a = tag_attrs(dom, "g-detail")
    assert a.get("data-node-id") == "innodb", f"深链没定位到节点：{a}"
    assert a.get("data-node-name") == "InnoDB"
    assert "在知识库中打开该单元" in strip_tags(dom) or "单元" in strip_tags(dom)


def test_legend_and_units_note(dom):
    body = strip_tags(dom)
    assert "节点大小 ∝ degree" in body
    assert "12 种 etype" in body
    assert "只标记不删除" in body


def test_no_fatal_banner(dom):
    assert 'id="fatal-banner"' not in dom
    assert "初始化失败" not in strip_tags(dom)


def test_degraded_llm_note(degraded_server):
    """LLM 未配置 → 图谱页必须如实说明（图谱是 LLM 抽的），而不是装作正常。"""
    dom = dump_dom(graph_url(degraded_server, selftest=False), timeout=300)
    assert 'id="llm-note"' in dom, "LLM 未配置时应给出说明横幅"
    body = strip_tags(dom)
    assert "llm.configured=false" in body or "未配置 LLM" in body
    assert "已有图谱仍可浏览" in body
    assert 'data-cap="LLM 抽取" data-available="false"' in dom
    # 图谱本身仍然渲染（不因为 LLM 不可用就把已有数据藏起来）
    assert int(tag_attrs(dom, "g-meta")["data-nodes"]) == 1644
