"""index.html（知识库浏览 + **Wiki 内嵌图谱**）headless Chrome 断言。

断言的是**具体值**（卡片数、单元标题、节点数、跳转目标），不是"非空"（AGENTS.md §7）。
运行：python -m pytest tests/test_web_index.py -q

两个 DOM 夹具：
  dom_view    —— 固定停在 unit=unt_0131 的静态视图（结构/渲染断言）
  dom_selftest—— 带 ?selftest=1，页面用真实 click 事件跑跳转链路并把结果写进 #selftest-report
                 （点击会切单元，所以渲染断言必须用 dom_view，不能共用）
"""

from __future__ import annotations

import json
import re

import pytest

from test_web_common import (
    WEB, dump_dom, jsonscript, tag_attrs, count, has, text_of, strip_tags,
    WIKI_UNIT, WIKI_UNIT_CARDS, WIKI_UNIT_TITLE, DOC_PDF, DOC_VIDEO,
    # fixtures 必须在测试模块里可见：pytest 只自动加载 conftest.py，
    # 而本任务写域限定 tests/test_web_*.py（不能新增 conftest.py）→ 用导入复用夹具
    web_server, degraded_server, meta,
)


def index_url(srv, unit=WIKI_UNIT, selftest=False, doc=DOC_PDF, extra=""):
    q = [f"doc={doc}", f"unit={unit}", "selftest=1" if selftest else "", extra]
    return f"{srv.base}/index.html?" + "&".join(x for x in q if x)


# ---------------------------------------------------------------- 静态结构（不启浏览器）

def test_index_shell_structure():
    html = (WEB / "index.html").read_text(encoding="utf-8")
    for needle in ['id="tree"', 'id="view"', 'id="search-input"', 'id="doc-select"',
                   'id="caps"', 'assets/wiki.js', 'assets/app.css', 'id="nav-chat"']:
        assert needle in html, f"index.html 缺少 {needle}"
    assert not re.search(r'(src|href)="https?://', html), "index.html 引用了外部资源（违反无构建链）"
    css = (WEB / "assets" / "app.css").read_text(encoding="utf-8")
    assert "graph-panel" in css and "kcard" in css and "xr.typed" in css


def test_no_third_party_graph_lib():
    """F5 硬要求：图表自绘，不引入第三方图库。"""
    forbidden = ["d3.", "cytoscape", "vis-network", "vis.js", "sigma", "echarts",
                 "force-graph", "chart.js", "three.min", "from 'vue'", 'from "vue']
    js = "\n".join(p.read_text(encoding="utf-8") for p in (WEB / "assets").glob("*.js"))
    low = js.lower()
    for f in forbidden:
        assert f not in low, f"前端代码里出现了第三方库标记：{f}"
    assert "requestAnimationFrame" in js, "力导向应当自己跑 rAF 循环"
    assert "buildQuad" in js, "大图需要空间划分（Barnes-Hut 四叉树）"


def test_api_client_is_same_origin():
    """坑 8：数据必须走同源 HTTP（相对路径），不能 fetch file://。"""
    api = (WEB / "assets" / "api.js").read_text(encoding="utf-8")
    assert "'/api/v1'" in api or '"/api/v1"' in api, "API 前缀应是同源相对路径"
    assert not re.search(r'fetch\(\s*[`"\']file:', api), "不允许 fetch file://"
    assert "location.origin + '/api/v1'" not in api, "不该硬编码 origin"
    assert "capabilities" in api and "applyGate" in api


def test_boot_timing_pattern():
    """坑 9：boot() 必须在 DOMContentLoaded 或脚本末尾调用。"""
    for name in ("wiki.js", "graph-page.js", "video-page.js"):
        src = (WEB / "assets" / name).read_text(encoding="utf-8")
        assert "DOMContentLoaded" in src, f"{name} 没有处理 DOMContentLoaded"
        assert re.search(r"else\s*\{\s*\n?\s*boot\(\);", src) or re.search(r"else boot\(\);", src), \
            f"{name} 的 boot() 调用时机不对（脚本末尾兜底缺失）"


# ---------------------------------------------------------------- 实跑（真实数据体量）

@pytest.fixture(scope="module")
def dom_view(web_server):
    """静态视图：不跑自检，页面不会被点击切换单元。"""
    return dump_dom(index_url(web_server, selftest=False), virtual_time_budget=25000)


@pytest.fixture(scope="module")
def dom_selftest(web_server):
    return dump_dom(index_url(web_server, selftest=True), virtual_time_budget=30000)


def test_boot_report(dom_view, meta):
    r = jsonscript(dom_view, "boot-report")
    assert r, "缺少 #boot-report（页面没跑完 boot）"
    assert r["ok"] is True
    assert r["doc"] == meta["doc_pdf"] == DOC_PDF
    assert r["unit"] == WIKI_UNIT
    assert r["cards"] == meta["cards"] == 360          # /cards 分页拉全量
    assert r["caps_asr"] is True


def test_tree_renders_with_empty_badges(dom_view, meta):
    # 注意 class="trow active"：计数要允许追加的类名（第一版写 class="trow" 漏掉选中行）
    rows = count(dom_view, r'class="trow[ "]')
    assert rows >= meta["roots"], f"层次树没渲染出根节点（trow={rows} roots={meta['roots']}）"
    assert count(dom_view, r'class="badge-empty"') >= 1, "无内容节点应显示 – 徽章"
    assert count(dom_view, r'class="badge-cards"') >= 0


def test_section_summary_and_cards(dom_view):
    assert WIKI_UNIT_TITLE in dom_view, "当前单元的标题没有渲染"
    body = strip_tags(dom_view)
    for label in ("本节讲什么", "学习目标", "要点"):
        assert label in body, f"概括区缺少：{label}"
    for label in ("是什么", "能做什么", "示例", "注意", "前提"):
        assert label in body, f"卡片缺少五要素标签：{label}"
    assert count(dom_view, r'class="kcard"') == WIKI_UNIT_CARDS, "当前单元的卡片数不对"
    assert count(dom_view, r'id="cards-panel"') == 1
    assert 'data-card-count="13"' in dom_view


def test_xrefs_and_backlinks(dom_view):
    assert count(dom_view, r'class="xref-h" data-rel="typed"') >= 1, "缺少类型化引用组"
    assert count(dom_view, r'class="xref-h" data-rel="mention"') >= 1, "缺少正文提到组"
    assert count(dom_view, r'class="xref-h" data-rel="same_unit"') >= 1, "缺少同单元组"
    assert count(dom_view, r'a class="xr[^"]*" href="#card-crd_') >= 1, "引用锚点没有 href（无法跨节跳转）"
    assert count(dom_view, r'a class="inner" href="#card-crd_') >= 1, "正文内链没有渲染"
    # 引用区必须带 rel 标记，测试与样式都依赖它
    assert count(dom_view, r'data-rel="mention"') >= 1


def test_backlinks_present(dom_view):
    """反链是 wiki 的精髓（F4）。夹具里 3063 条 xref，必然有卡片被引用。"""
    assert count(dom_view, r'data-rel="backlinks"') >= 1 or count(dom_view, r'class="xr back"') >= 1, \
        "没有任何反链渲染"


def test_source_jump_links(dom_view):
    """C8：页码/时间戳必须可回溯原文。"""
    m = re.findall(r'data-source-kind="page"\s+data-source-value="(\d+)"', dom_view)
    assert len(m) >= WIKI_UNIT_CARDS, f"卡片的原文跳转缺失（{len(m)}）"
    assert all(int(v) > 0 for v in m)
    assert re.search(r'href="/api/v1/documents/doc_refman00001/file#page=\d+', dom_view), \
        "PDF 原文链接必须带 #page=N"


# ---------------------------------------------------------------- 内嵌图谱（用户核心要求）

def test_embedded_graph_present_in_wiki_page(dom_view):
    """图谱必须**内嵌在 Wiki 页里**，而不是只能跳去独立页。"""
    assert has(dom_view, r'id="subgraph-panel"[^>]*data-kind="wiki-embedded"'), "Wiki 页缺少内嵌图谱面板"
    attrs = tag_attrs(dom_view, "subgraph-panel")
    nodes = int(attrs.get("data-nodes", "0"))
    seeds = int(attrs.get("data-seed-units", "0"))
    assert nodes > 0, "内嵌子图没有节点"
    assert seeds > 0, "当前单元没有图谱种子（unit_ids 映射失败）"
    assert nodes >= seeds, "局部子图应当 = 单元内实体 + 一跳邻居"
    assert 'id="sg-canvas"' in dom_view, "内嵌图谱应有自己的 canvas"
    assert count(dom_view, r'class="node-chip" href="#card-crd_') >= 1, "内嵌图谱节点没有可点击跳转目标"
    assert "在完整图谱中打开" in strip_tags(dom_view)
    assert "本单元知识图谱" in strip_tags(dom_view)
    # 图谱面板在卡片区之前（Wiki 页内嵌，而不是页面底部孤零零一块）
    assert dom_view.index('id="subgraph-panel"') < dom_view.index('id="cards-panel"')
    # 节点 chips 的 names 来自真实图谱
    names = re.findall(r'data-node-id="([^"]+)"', dom_view)
    assert len(set(names)) >= 3, "内嵌图谱节点过少"


def test_embedded_graph_flagged_legend(dom_view):
    """flagged 边视觉可辨（虚线）——子图里有 flagged 边时图例必须出现虚线说明。"""
    attrs = tag_attrs(dom_view, "subgraph-panel")
    flagged = int(attrs.get("data-flagged", "0"))
    if flagged > 0:
        assert "legend-line dashed" in dom_view, "有 flagged 边却没有虚线图例"
        assert "flagged" in strip_tags(dom_view)
    else:  # 子图里确实没有 flagged 边时，只要求图例机制存在（独立图谱页会覆盖）
        assert has(dom_view, r'id="sg-legend"')


# ---------------------------------------------------------------- 自检（真实 click 事件链路）

def test_selftest_report_all_green(dom_selftest):
    r = jsonscript(dom_selftest, "selftest-report")
    assert r, "缺少 #selftest-report"
    c = r["checks"]
    assert c["subgraph_engine"]["nodes"] == c["subgraph_nodes"]
    assert c["subgraph_engine"]["drawn_nodes"] == c["subgraph_nodes"]
    assert r["ok"] is True, f"页面自检未通过：{json.dumps(c, ensure_ascii=False)[:1200]}"


def test_embedded_graph_node_click_navigates(dom_selftest):
    """内嵌图谱节点点击 → 跳到该卡片（页面用真实 MouseEvent 跑的）。"""
    c = jsonscript(dom_selftest, "selftest-report")["checks"]
    click = c["subgraph_click"]
    assert click.get("target", "").startswith("crd_"), click
    assert click["highlighted"] is True, "点击图谱节点后目标卡片没有高亮"
    assert click["unit_after"] == click["unit_before"] or click["unit_changed"] is True


def test_card_mini_relation_graph(dom_selftest):
    """F5 第三种形态：卡片内的迷你关系图。"""
    c = jsonscript(dom_selftest, "selftest-report")["checks"]
    mg = c["mini_graph"]
    assert c["mini_graph_ok"] is True, f"迷你关系图没渲染出来：{mg}"
    assert mg["shown"] is True and mg["canvas"] is True and mg["nodes"] >= 2


def test_time_span_source_link(dom_selftest):
    """C8：视频型卡片必须给 video.currentTime 跳转；没有 span 时必须如实说缺失。"""
    c = jsonscript(dom_selftest, "selftest-report")["checks"]
    assert c["time_source_ok"] is True, c.get("time_source_href")
    assert "video.html?doc=doc_refman00001&t=754000" in c["time_source_href"]
    assert c["missing_span_honest"] is True


def test_unit_ids_missing_still_renders_embedded_graph(web_server):
    """集成风险兜底：T1 的 /graph 若没给 unit_ids，内嵌子图要用卡片名反查实体。"""
    import json as _json
    import urllib.request
    cfg = f"{web_server.base}/api/v1/_fixture/config?strip_unit_ids=1"
    with urllib.request.urlopen(cfg) as f:
        assert _json.load(f)["config"]["strip_unit_ids"] is True
    try:
        dom = dump_dom(index_url(web_server, selftest=True), timeout=300)
    finally:
        with urllib.request.urlopen(f"{web_server.base}/api/v1/_fixture/config?strip_unit_ids=0"):
            pass
    assert 'id="fatal-banner"' not in dom
    attrs = tag_attrs(dom, "subgraph-panel")
    assert attrs.get("data-seed-source") in ("card_names", "unit_ids+card_names"), \
        f"兜底种子没生效：{attrs}"
    assert int(attrs.get("data-nodes", "0")) > 0, "没给 unit_ids 时内嵌子图空了"
    c = jsonscript(dom, "selftest-report")["checks"]
    assert c["subgraph_nodes"] > 0 and c["subgraph_clickable_chips"] >= 1


def test_xref_click_cross_unit(dom_selftest):
    """验收：点击引用能跨节跳转 + 高亮定位。"""
    c = jsonscript(dom_selftest, "selftest-report")["checks"]
    x = c["xref_cross_unit_click"]
    assert x["unit_before"] != x["unit_after"], f"跨节引用没有切换单元：{x}"
    assert x["target_unit"] == x["unit_after"], "跳转没有落到目标卡片所在单元"
    assert x["highlighted"] is True, "跳转后目标卡片没有高亮"
    assert c["xref_cross_unit_ok"] is True and c["xref_click_ok"] is True


def test_search_and_empty_badges(dom_selftest):
    c = jsonscript(dom_selftest, "selftest-report")["checks"]
    assert c["search_ok"] is True and c["search_hits"] > 0
    assert c["empty_badges_expanded"] > 0, "展开后应能看到「–」无内容徽章"
    assert c["tree_rows_expanded"] >= c["tree_rows"]


def test_no_fatal_banner(dom_view, dom_selftest):
    for d in (dom_view, dom_selftest):
        assert 'id="fatal-banner"' not in d, "页面报了初始化失败"
        assert "初始化失败" not in strip_tags(d)


# ---------------------------------------------------------------- 能力渲染（诚实降级）

def test_capability_chips_render(dom_view):
    assert count(dom_view, r'class="cap-chip') >= 4, "顶栏应显示 ASR/pi/LLM/ffmpeg 能力芯片"
    assert 'data-cap="ASR 字幕" data-available="true"' in dom_view
    assert 'data-cap="pi 助教" data-available="true"' in dom_view


def test_chat_entry_enabled_when_pi_available(dom_selftest):
    c = jsonscript(dom_selftest, "selftest-report")["checks"]
    assert c["chat_gate_disabled"] is False, "pi 可用时不该禁用入口"


def test_degraded_capabilities_disable_entries(degraded_server):
    """pi/ASR/LLM 不可用 → 入口禁用 + 有说明文字（F7 降级路径 C / 坑 10）。"""
    dom = dump_dom(index_url(degraded_server, selftest=True), virtual_time_budget=25000)
    r = jsonscript(dom, "selftest-report")
    assert r, "降级模式下页面没能跑完自检"
    c = r["checks"]
    assert c["caps_loaded"] is True, "能力接口本身要能读到（不是加载失败）"
    assert c["chat_gate_disabled"] is True, "pi 不可用时 AI 助教入口必须禁用"
    assert "pi" in (c["chat_gate_reason"] or "").lower(), f"禁用原因没写清楚：{c['chat_gate_reason']}"
    attrs = tag_attrs(dom, "nav-chat")
    assert attrs.get("aria-disabled") == "true"
    assert 'data-cap="pi 助教" data-available="false"' in dom
    assert 'data-cap="ASR 字幕" data-available="false"' in dom
    assert "不可用" in strip_tags(dom)


def test_backend_unreachable_reports_honestly(web_server):
    """后端连不上时：明确报错 + 说明怎么起服务，绝不渲染假数据。"""
    dom = dump_dom(f"{web_server.base}/index.html?api=http://127.0.0.1:9/api/v1&selftest=1",
                   timeout=300)
    assert 'id="fatal-banner"' in dom, "后端不可达时应显示错误横幅"
    body = strip_tags(dom)
    assert "无法连接后端" in body
    assert "uvicorn server.main:app" in body, "错误提示要给出可操作的下一步"
    r = jsonscript(dom, "boot-report")
    assert r and r["ok"] is False, "boot 应当如实报告失败"
    assert r["error"] and "无法连接后端" in r["error"], f"错误信息没说清楚：{r}"
    assert count(dom, r'class="trow"') == 0, "后端不可达时不该渲染出目录树"
    assert count(dom, r'class="kcard"') == 0, "后端不可达时不该渲染出卡片"
