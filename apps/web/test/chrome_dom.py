#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""headless Chrome DOM 断言（Vue3 前端的 e2e）

为什么驱动是 Python 而不是 Node（**本机实测，不是偏好**）：
  · Node `spawn/spawnSync` 拉起 Chrome 时，Chrome 的 network service 进程**创建命名管道被拒绝**
    （stderr: `Failed to open named pipe server process … 拒绝访问 (0x5)`），
    结果是 **Chrome 连本地 HTTP 请求都发不出去** —— 页面永远不 load，`--dump-dom` 永不返回。
    已验证：`--no-sandbox` / `--single-process` / `--in-process-gpu` / detached+文件重定向 全部无效。
  · **同一个 Chrome 由 Python `subprocess` 拉起则 0.8s 正常返回 DOM**（对照实验见
    本目录 README「e2e 驱动为什么用 Python」）。
  mock server 仍然是 Node（test/mock-server.mjs），由本脚本以子进程方式拉起。

断言内容：五个视图 + 降级能力场景，断言 `#*-report` / `#selftest-report` 里的**具体值**
（不是"非空"），并检查关键 DOM 结构（内嵌图谱、12 个 etype 筛选、flagged 虚线图例、
虚拟滚动窗口、能力禁用与 reason 文案等）。

运行：npm run test:e2e   （= vite build && python test/chrome_dom.py）
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from html import unescape
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEB = HERE.parent
DIST = WEB / "dist"
sys.path.insert(0, str(HERE))
from cdp import Chrome, find_chrome  # noqa: E402  （同目录，标准库实现的 CDP 客户端）
CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

RESULTS: list[str] = []
FAILURES = 0


def ok(name: str, cond: bool, detail: str = "") -> bool:
    global FAILURES
    if cond:
        RESULTS.append(f"  ✓ {name}")
        return True
    FAILURES += 1
    RESULTS.append(f"  ✗ {name}" + (f" — {detail}" if detail else ""))
    return False


def eq(name: str, actual, expected) -> bool:
    return ok(name, actual == expected, f"实际 {actual!r} ≠ 期望 {expected!r}")


# ---------------------------------------------------------------- 基础设施

def find_chrome() -> str | None:
    for c in CHROME_CANDIDATES:
        if Path(c).exists():
            return c
    return None


def start_mock() -> tuple[subprocess.Popen, dict]:
    """拉起 Node mock server（normal + degraded），等它把端口写进文件。"""
    port_file = Path(tempfile.gettempdir()) / f"coursekb-ports-{os.getpid()}.json"
    if port_file.exists():
        port_file.unlink()
    proc = subprocess.Popen(
        ["node", str(HERE / "mock-server.mjs"), "--port-file", str(port_file)],
        cwd=str(WEB), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    deadline = time.time() + 60
    while time.time() < deadline:
        if port_file.exists():
            try:
                info = json.loads(port_file.read_text(encoding="utf-8"))
                if info.get("normal"):
                    return proc, info
            except json.JSONDecodeError:
                pass
        if proc.poll() is not None:
            err = (proc.stderr.read() or b"").decode("utf-8", "replace")[-1500:]
            raise RuntimeError(f"mock server 退出（code={proc.returncode}）：{err}")
        time.sleep(0.2)
    raise RuntimeError("mock server 未在 60s 内就绪")


def dump_dom(driver, url: str, ready: str, timeout: int = 240) -> str:
    """CDP：导航 → 轮询 ready 条件 → 取 DOM。

    不用 `--dump-dom` + 挂起 img 的原因见 test/cdp.py 头部（会占满每源 6 个连接槽导致假死）。
    ready 条件由页面自己写的 `#*-report` 决定 —— 那正是"页面干完活"的确定性信号。
    """
    return driver.dump(url, ready, timeout)


class Driver:
    """一层健壮性包装：视图之间 `about:blank` 释放内存；崩了就重启 Chrome 重试一次。

    （实测：连续跑 10 个视图时偶发一次 CDP 连接被关闭 —— 重启后继续，不让偶发中断污染结果。）
    """

    def __init__(self, chrome: str):
        self.chrome = chrome
        self.ch = Chrome(chrome)
        self.restarts = 0

    def _dump(self, url: str, ready: str, timeout: int) -> str:
        self.ch.navigate("about:blank", timeout=30)
        self.ch.navigate(url, timeout=timeout)
        self.ch.wait_for(ready, timeout=timeout, interval=0.15)
        return self.ch.outer_html()

    def dump(self, url: str, ready: str, timeout: int = 240) -> str:
        try:
            return self._dump(url, ready, timeout)
        except Exception as first:
            self.restarts += 1
            try:
                self.ch.close()
            except Exception:
                pass
            self.ch = Chrome(self.chrome)
            try:
                return self._dump(url, ready, timeout)
            except Exception as second:
                raise RuntimeError(f"{first}｜重启后仍失败：{second}") from second

    def close(self) -> None:
        try:
            self.ch.close()
        except Exception:
            pass

    def __enter__(self) -> "Driver":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def report(dom: str, el_id: str):
    m = re.search(rf'<script[^>]*id="{re.escape(el_id)}"[^>]*>(.*?)</script>', dom, re.S | re.I)
    if not m:
        return None
    raw = unescape(m.group(1)).strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def count(dom: str, pattern: str) -> int:
    return len(re.findall(pattern, dom))


def has(dom: str, pattern: str) -> bool:
    return re.search(pattern, dom) is not None


def text_of(dom: str, el_id: str) -> str:
    m = re.search(rf'<([a-zA-Z0-9]+)[^>]*\bdata-testid="{re.escape(el_id)}"[^>]*>', dom)
    if not m:
        m = re.search(rf'<([a-zA-Z0-9]+)[^>]*\bid="{re.escape(el_id)}"[^>]*>', dom)
    if not m:
        return ""
    tag = m.group(1)
    body = dom[m.end():]
    depth = 1
    for mm in re.finditer(rf"</?{tag}\b[^>]*>", body):
        if mm.group(0).startswith("</"):
            depth -= 1
            if depth == 0:
                return unescape(re.sub(r"<[^>]+>", "", body[: mm.start()])).strip()
        else:
            depth += 1
    return ""


def attrs_of(dom: str, el_id: str) -> dict:
    m = re.search(rf"<([a-zA-Z0-9]+)([^>]*\bid=\"{re.escape(el_id)}\"[^>]*)>", dom)
    if not m:
        return {}
    return {a.group(1): (a.group(2) if a.group(2) is not None else "")
            for a in re.finditer(r'([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?', m.group(2))}


# ---------------------------------------------------------------- 用例

def run_view(tag: str, fn) -> None:
    RESULTS.append(f"\n[{tag}]")
    try:
        fn()
    except Exception as e:  # 单个视图失败不影响其它视图
        global FAILURES
        FAILURES += 1
        RESULTS.append(f"  ✗ 抛异常：{type(e).__name__}: {e}")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    chrome = find_chrome()
    if not chrome:
        print("✗ 找不到 Chrome（改 CHROME_CANDIDATES）")
        return 2
    if not (DIST / "index.html").exists():
        print("✗ dist/ 不存在：先 npm run build（npm run test:e2e 已包含）")
        return 2

    mock, info = start_mock()
    normal = f"http://127.0.0.1:{info['normal']}"
    degraded = f"http://127.0.0.1:{info['degraded']}"
    M = info["meta"]
    DOC_PDF = info["docs"]["pdf"]
    DOC_VIDEO = info["docs"]["video"]
    UNIT = info["docs"]["unit"]
    WIKI_CARDS = 13

    def api(path: str) -> dict:
        with urllib.request.urlopen(normal + path, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))

    READY_VIEW = "!!document.getElementById('selftest-report') || !!document.getElementById('docs-report')"
    # ★ 页面级 `current-session` 选择器：**排除抽屉内的同名节点**
    #   （抽屉与整页共用 testid；不限定作用域时"抽屉打开就可能在读另一个实例"——
    #    现在能过只是因为抽屉是 v-if 关闭态，属"碰巧对"）
    SID_PAGE = ("Array.from(document.querySelectorAll('[data-testid=\"current-session\"]'))"
                ".find(e => !e.closest('[data-testid=\"assistant-drawer\"]'))")
    READY_WIKI_STATIC = "!!document.getElementById('wiki-report')"

    try:
        with Driver(chrome) as driver:
            def url(base: str, route: str) -> str:
                return f"{base}/#/{route}"

            # ============ 1. WikiIndex：树 + 概括区 + 卡片 + 交叉引用 + ★内嵌图谱 ============
            wiki = dump_dom(driver, url(normal, f"wiki?doc={DOC_PDF}&unit={UNIT}&selftest=1"), READY_VIEW)

        def check_wiki() -> None:
            rep = report(wiki, "wiki-report")
            ok("wiki-report 存在", bool(rep))
            eq("units", rep and rep.get("units"), M["units"])
            eq("cards（分页拉全量）", rep and rep.get("cards"), M["cards"])
            eq("graph_nodes", rep and rep.get("graph_nodes"), M["graph_nodes"])
            eq("graph_edges", rep and rep.get("graph_edges"), M["graph_edges"])
            ok("单元标题渲染", "5.3.1 Creating and Selecting a Database" in wiki)
            eq("该单元卡片数", count(wiki, r'class="kcard'), WIKI_CARDS)
            ok("概括区（本节讲什么）", "本节讲什么" in wiki)
            ok("五要素标签齐全", all(t in wiki for t in ("是什么", "能做什么", "示例", "前提", "注意")))
            ok("原文跳转带 #page=N", has(wiki, r'href="/api/v1/documents/doc_refman00001/file#page=\d+'))
            ok("交叉引用锚点（带 href）", count(wiki, r'class="xr[^"]*" href="#card-crd_') > 0)
            ok("反链区", 'data-rel="backlinks"' in wiki or 'class="xr back"' in wiki)
            ok("正文内链", count(wiki, r'class="inner" href="#card-crd_') > 0)

            m = re.search(r'id="embedded-graph"[^>]*', wiki)
            ok("★内嵌图谱面板存在", bool(m) and 'data-kind="wiki-embedded"' in m.group(0), m.group(0) if m else "")
            attrs = attrs_of(wiki, "embedded-graph")
            nodes = int(attrs.get("data-nodes", "0") or 0)
            seeds = int(attrs.get("data-seed-count", "0") or 0)
            ok("内嵌图谱有节点", nodes > 0, f"nodes={nodes}")
            ok("种子来自 unit_ids", seeds > 0 and attrs.get("data-seed-source") in ("unit_ids", "unit_ids+card_names"),
               f"seeds={seeds} source={attrs.get('data-seed-source')}")
            ok("内嵌图谱在卡片区之前", wiki.find('id="embedded-graph"') < wiki.find('id="cards-panel"'))
            ok("节点 chips 可点击跳转", count(wiki, r'class="node-chip"[^>]*data-goto-card') > 0)
            ok("内嵌图谱 canvas", 'class="graph-canvas"' in wiki)
            ok("“在完整图谱中打开”", "在完整图谱中打开" in wiki)

            st = report(wiki, "selftest-report")
            ok("selftest-report 存在", bool(st))
            ok("页面自检全绿", bool(st) and st.get("ok") is True, f"failed={st and st.get('failed')}")
            c = (st or {}).get("checks", {})
            ok("树行数 > 0", int(c.get("tree_rows", 0)) > 0)
            ok("无内容节点显示 – 徽章", int(c.get("empty_badges", 0)) > 0)
            eq("该单元卡片数（自检）", c.get("cards_in_unit"), WIKI_CARDS)
            ok("内嵌图谱节点可映射到卡片", int(c.get("embedded_mapped", 0)) > 0)
            ok("★点击内嵌图谱节点 → 跳卡片 + 高亮",
               (c.get("embedded_click") or {}).get("highlighted") is True, json.dumps(c.get("embedded_click"), ensure_ascii=False))
            xc = c.get("xref_cross_unit_click") or {}
            ok("★点击交叉引用 → 跨单元跳转 + 高亮", xc.get("unit_changed") is True and xc.get("highlighted") is True,
               json.dumps(xc, ensure_ascii=False))
            ok("卡片级迷你关系图（canvas）", (c.get("mini_graph") or {}).get("canvas") is True,
               json.dumps(c.get("mini_graph"), ensure_ascii=False))
            ok("TTS 门控状态正确", (c.get("tts_gate") or {}).get("disabled") == (not (c.get("tts_gate") or {}).get("available")),
               json.dumps(c.get("tts_gate"), ensure_ascii=False))
            ok("时间型 span → 视频跳转", "#/video?doc=" in str(c.get("time_source_href")) and "t=754000" in str(c.get("time_source_href")),
               str(c.get("time_source_href")))
            ok("检索有命中", int(c.get("search_hits", 0)) > 0, f"q={c.get('search_q')} total={c.get('search_total')}")

        run_view("WikiIndex / 知识库 + 内嵌图谱", check_wiki)

        # ============ 2. 内嵌图谱兜底：/graph 不带 unit_ids ============
        api("/api/v1/_fixture/config?strip_unit_ids=1")
        wiki2 = dump_dom(driver, url(normal, f"wiki?doc={DOC_PDF}&unit={UNIT}&selftest=1"), READY_VIEW)
        api("/api/v1/_fixture/config?strip_unit_ids=0")

        def check_wiki_fallback() -> None:
            attrs = attrs_of(wiki2, "embedded-graph")
            ok("panel 仍渲染", bool(attrs))
            eq("兜底种子来源 = card_names", attrs.get("data-seed-source"), "card_names")
            ok("节点数 > 0", int(attrs.get("data-nodes", "0") or 0) > 0, str(attrs))
            st = report(wiki2, "selftest-report")
            ok("自检仍全绿", bool(st) and st.get("ok") is True, f"failed={st and st.get('failed')}")

        run_view("WikiIndex / unit_ids 缺失兜底", check_wiki_fallback)

        # ============ 3. Graph：1644 节点性能 + 12 etype + flagged 虚线 ============
        graph = dump_dom(driver, url(normal, f"graph?doc={DOC_PDF}&selftest=1&focus=innodb"), READY_VIEW)

        def check_graph() -> None:
            perf = report(graph, "perf-report") or {}
            ok("perf-report 存在", bool(perf))
            eq("nodes", perf.get("nodes"), M["graph_nodes"])
            eq("edges", perf.get("edges"), M["graph_edges"])
            eq("flagged_edges", perf.get("flagged_edges"), M["flagged_edges"])
            ok("布局收敛", perf.get("settled") is True, json.dumps({k: perf.get(k) for k in ("alpha", "ticks")}))
            ok("有效帧样本 ≥ 20", int(perf.get("frame_samples") or 0) >= 20, f"samples={perf.get('frame_samples')}")
            tick = (perf.get("bench") or {}).get("per_tick_ms")
            ok("物理单步 > 0ms（不是虚拟时钟的 0）", float(tick or 0) > 0, json.dumps(perf.get("bench")))
            ok("物理单步 < 25ms", float(tick or 999) < 25, f"{tick} ms/tick")
            p50 = perf.get("frame_ms_p50")
            ok("帧耗时中位 < 25ms", p50 is not None and float(p50) < 25,
               f"p50={p50} p95={perf.get('frame_ms_p95')} max={perf.get('frame_ms_max')}")
            eq("12 个 etype 筛选框", count(graph, r'data-etype-box="'), 12)
            ok("flagged 虚线图例", has(graph, r"legend-line dashed"))
            st = report(graph, "selftest-report") or {}
            c = st.get("checks", {})
            ok("节点大小 ∝ degree", c.get("radius_monotonic") is True)
            # 断言"具体值"（页面内的 need() 只把失败项写进 failed；这里复算一遍，别依赖布尔）
            ok("按 etype 筛选：可见边数 = 该 etype 总数，且可见集只含该 etype",
               c.get("filter_visible_edges") == c.get("filter_expect_edges") and int(c.get("filter_expect_edges") or 0) > 0
               and c.get("filter_visible_etypes") == [c.get("filter_etype")],
               json.dumps({k: c.get(k) for k in ("filter_etype", "filter_visible_edges", "filter_expect_edges", "filter_visible_etypes")}, ensure_ascii=False))
            ok("只看 flagged：可见边全为 flagged，且条数 = flagged 总数",
               c.get("flagged_only_visible") == c.get("flagged_total_flagged") and int(c.get("flagged_not_ok") or 0) == 0,
               json.dumps({k: c.get(k) for k in ("flagged_only_visible", "flagged_total_flagged", "flagged_not_ok")}))
            ok("点击节点出详情", bool(c.get("node_click_id")), str(c.get("node_click_id")))
            ok("点击边出证据", bool((c.get("edge_evidence") or {}).get("shown")),
               json.dumps(c.get("edge_evidence"), ensure_ascii=False))
            ok("深链 focus=innodb 生效", 'data-node-id="innodb"' in graph)
            ok("自检全绿", st.get("ok") is True, f"failed={st.get('failed')}")

        run_view("Graph / 全屏力导向（1644 节点）", check_graph)

        # ============ 4. Video：真媒体字幕同步（v1 的 media_check.ok=false 必须真修掉） ============
        video = dump_dom(driver, url(normal, f"video?doc={DOC_VIDEO}&selftest=1&t=2400"), READY_VIEW)

        def check_video() -> None:
            rep = report(video, "video-report") or {}
            eq("segments", rep.get("segments"), M["video"]["segments"])
            eq("chapters", rep.get("chapters"), M["video"]["chapters"])
            eq("slides", rep.get("slides"), M["video"]["slides"])
            ok("mindmap 有内容", rep.get("mindmap") is True)
            ok("ASR 可用（providers.asr[0].available）", rep.get("asr_available") is True)
            st = report(video, "selftest-report") or {}
            c = st.get("checks", {})
            vs = c.get("vscroll") or {}
            eq("虚拟滚动总条数", vs.get("total"), 3000)
            ok("虚拟滚动 DOM 行数 < 200", int(vs.get("dom_rows") or 0) < 200, json.dumps(vs))
            eq("占位高度（3000×42）", vs.get("spacer"), "126000px")
            sc = c.get("subtitle_click") or {}
            ok("点字幕 → seek 到该条 start", sc.get("last_ms") == sc.get("want"), json.dumps(sc))
            ct = c.get("chapter_toggle") or {}
            ok("章节可折叠", ct.get("was") != ct.get("now"), json.dumps(ct))
            mc = c.get("mindmap_collapse") or {}
            ok("思维导图可折叠（真实点击 → DOM 加/去 collapsed）",
               mc.get("after_click_collapsed") is True and mc.get("after_second_click_expanded") is True, json.dumps(mc))
            ok("幻灯片帧点击跳转", (c.get("slide_click") or {}).get("ok") is True, json.dumps(c.get("slide_click")))
            ok("标注“图片帧”（坑 11）", c.get("slides_frames_label") is True)
            # ★ v1 失败点 1：真媒体下 video.currentTime 真的接受 seek
            mchk = c.get("media_check") or {}
            ok("★真实媒体 seek 通过（media_check.ok=true）", mchk.get("ok") is True, json.dumps(mchk, ensure_ascii=False))
            eq("媒体时长（夹具音轨）", int(mchk.get("duration_ms") or 0), 60000)
            eq("媒体校验目标 ms", int(mchk.get("want_ms") or 0), 30000)
            eq("媒体实际 currentTime ms", int(mchk.get("media_ms") or 0), 30000)
            # ★ v1 失败点 2：重跑入口不是摆设（真提交 + 进度 + 完成）
            rp = c.get("reparse") or {}
            ok("★重跑提交拿到 task_id", bool(rp.get("id")), json.dumps(rp, ensure_ascii=False))
            eq("重跑进度 42%", int(rp.get("progress") or 0), 42)
            eq("重跑 done 帧", rp.get("done"), "true")
            ok("自检全绿", st.get("ok") is True, f"failed={st.get('failed')}")

        run_view("Video / 真媒体字幕同步 + SSE 重跑", check_video)

        # ============ 5. Video：合成时钟（N/A 如实标注） ============
        video_sim = dump_dom(driver, url(normal, f"video?doc={DOC_VIDEO}&selftest=1&simclock=1"), READY_VIEW)

        def check_video_sim() -> None:
            st = report(video_sim, "selftest-report") or {}
            c = st.get("checks", {})
            ok("合成时钟下字幕同步生效",
               c.get("sync_active_index") == c.get("sync_target_index") and c.get("sync_active_dom") is True,
               json.dumps({k: c.get(k) for k in ("sync_active_index", "sync_target_index")}))
            eq("media_seek 如实标注 skipped", c.get("media_seek"), "skipped(simclock)")
            ok("自检全绿", st.get("ok") is True, f"failed={st.get('failed')}")

        run_view("Video / 合成时钟回退路径", check_video_sim)

        # ============ 6. Chat：WebSocket 流式 + 工具可见 + 可中断 ============
        chat = dump_dom(driver, url(normal, "chat?selftest=1"), READY_VIEW)

        def check_chat() -> None:
            rep = report(chat, "chat-report") or {}
            ok("chat-report 存在", bool(rep))
            ok("pi/模型均可用", rep.get("pi_available") is True and rep.get("model_available") is True)
            st = report(chat, "selftest-report") or {}
            c = st.get("checks", {})
            eq("WS 状态 open", c.get("ws_state"), "open")
            ok("流式文本已渲染", len(str(c.get("streamed_text") or "")) > 8, str(c.get("streamed_text"))[:60])
            ok("工具调用卡片可见", int(c.get("tool_cards") or 0) > 0, json.dumps(c.get("tool_names"), ensure_ascii=False))
            ok("思考过程可见", c.get("thinking_shown") is True)
            ok("收到 settled（唯一结束信号）", int(c.get("settled_count") or 0) > 0)
            ok("settled 后 busy=false", c.get("busy_after_settled") is False)
            ok("abort → settled(aborted)", c.get("abort_seen") is True, json.dumps(c.get("abort_settled_delta")))
            ok("自检全绿", st.get("ok") is True, f"failed={st.get('failed')}")

        run_view("Chat / pi 助教", check_chat)

        # ============ 7. Docs ============
        docs_dom = dump_dom(driver, url(normal, "docs"), "!!document.getElementById('docs-report') && document.querySelectorAll('[data-testid=\\\"doc-table\\\"] tbody tr').length >= 2")

        def check_docs() -> None:
            rep = report(docs_dom, "docs-report") or {}
            eq("文档数", rep.get("count"), 2)
            ok("表格两行", count(docs_dom, r'data-doc="doc_') >= 2)
            ok("上传区存在", 'data-testid="dropzone"' in docs_dom)
            ok("能力横幅渲染", 'data-testid="caps-bar"' in docs_dom)

        run_view("Docs / 文档管理", check_docs)

        # ============ 8. 降级：视频页（ASR 不可用 + OCR 不可用） ============
        deg_video = dump_dom(driver, url(degraded, f"video?doc={DOC_VIDEO}&selftest=1"), READY_VIEW)

        def check_deg_video() -> None:
            rep = report(deg_video, "video-report") or {}
            ok("asr_available=false", rep.get("asr_available") is False)
            ok("ocr_available=false", rep.get("ocr_available") is False)
            st = report(deg_video, "selftest-report") or {}
            c = st.get("checks", {})
            ok("重跑入口禁用", c.get("reparse_disabled") is True)
            ok("禁用原因来自 providers.reason",
               "faster-whisper" in str(c.get("reparse_gate_reason")), str(c.get("reparse_gate_reason")))
            rp = c.get("reparse") or {}
            ok("点击禁用入口不提交任务", rp.get("gated") is True and not rp.get("id"), json.dumps(rp, ensure_ascii=False))
            ok("ASR 说明块可见", 'data-testid="asr-note"' in deg_video and "ASR 不可用" in deg_video)
            ok("字幕空状态如实说明", "不生成假字幕" in deg_video)
            # OCR 不可用 = 正常降级：帧图仍要显示（**不隐藏整个幻灯片区**）
            n_slides = count(deg_video, r'class="slide-card')
            eq("幻灯片区仍渲染 12 帧", n_slides, 12)
            ok("OCR 说明写明“图片帧”", "图片帧" in deg_video and 'data-testid="ocr-note"' in deg_video)
            ok("文稿/总结空状态如实说明",
               ("后端未产出文稿" in deg_video) or ("后端未产出全文总结" in deg_video) or ("后端未产出思维导图" in deg_video))
            ok("自检全绿", st.get("ok") is True, f"failed={st.get('failed')}")

        run_view("降级 / 视频页（ASR + OCR 不可用）", check_deg_video)

        # ============ 9. 降级：对话入口禁用 + 原因 ============
        deg_chat = dump_dom(driver, url(degraded, "chat?selftest=1"), READY_VIEW)

        def check_deg_chat() -> None:
            rep = report(deg_chat, "chat-report") or {}
            ok("chat-report 记录 pi 不可用", rep.get("pi_available") is False)
            ok("输入框禁用", has(deg_chat, r'data-testid="chat-input"[^>]*disabled'))
            ok("发送按钮禁用", has(deg_chat, r'data-testid="chat-send"[^>]*disabled'))
            ok("门控说明含缺哪个凭据 / 原因",
               'data-testid="chat-gate"' in deg_chat and ("pi SDK" in deg_chat or "AMR_KEY" in deg_chat))
            ok("导航入口标记不可用", 'data-nav="/chat"' in deg_chat and "不可用" in deg_chat)

        # ============ 9b. 检索模式徽标（契约 §4）：none / wiki / kg(0命中) / rag(不可用) ============
        def chat_retrieval(mode: str, kg_hit: bool = False):
            api(f"/api/v1/_fixture/config?retrieval={mode}" + ("&kg_hit=1" if kg_hit else ""))
            dom = dump_dom(driver, url(normal, "chat?selftest=1"), READY_VIEW)
            # 发一句 → 等检索帧与一轮结束
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"retrieval-badge\"]')", timeout=60, interval=0.2)
            return dom

        def check_retrieval_wiki() -> None:
            dom = chat_retrieval("wiki")
            ok("wiki：徽标出现", 'data-testid="retrieval-badge"' in dom)
            ok("wiki：标注模式与命中数（status=ok）",
               'data-mode="wiki"' in dom and 'data-hits="2"' in dom and 'data-status="ok"' in dom,
               "缺 data-mode/hits/status")
            ok("wiki：显示耗时（教学对比用）", "耗时" in dom and "s" in dom)
            ok("wiki：可展开依据（why）", 'data-testid="retrieval-why-toggle"' in dom)
            # 展开 → 看到 why 与路径
            driver.ch.evaluate("document.querySelector('[data-testid=\"retrieval-why-toggle\"]').click()")
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"retrieval-why\"]')", timeout=20, interval=0.2)
            why_dom = driver.ch.outer_html()
            ok("wiki：why 里是可读的命中原因（bigram 命中「索引」）", "bigram 命中" in why_dom, "why 未显示可读原因")
            ok("wiki：命中项带 title/score", "聚簇索引" in why_dom and "score" in why_dom)

        # ============ 9b-1. 富文本渲染：公式（KaTeX）/ 代码块 / 未闭合容错 / 失败如实 ============
        def check_rich_text() -> None:
            # ★ fixture 开关要走 `/_fixture/config`（不是页面 URL 上的 query）—— 第一版写错了，
            #   结果拿到的是默认回答（没有公式），e2e 白等 60s（"看着像渲染坏了，其实是夹具没开"）
            cfg = api("/api/v1/_fixture/config?rich=1")
            # 夹具必须真的生效（否则会白等 60s，看起来像渲染坏了）—— 先断言再继续
            ok("富文本夹具已生效（rich_answer=true）", bool((cfg.get("config") or {}).get("rich_answer")),
               json.dumps(cfg, ensure_ascii=False)[:200])
            dump_dom(driver, url(normal, "chat?selftest=0"),
                     "!!document.getElementById('chat-report')", timeout=120)
            driver.ch.evaluate("(() => { const t=document.querySelector('[data-testid=\"chat-input\"]');"
                               " t.value='讲讲复杂度'; t.dispatchEvent(new Event('input',{bubbles:true}));"
                               " setTimeout(() => document.querySelector('[data-testid=\"chat-send\"]').click(), 150); return 1 })()")
            # 限定在**助手**消息内取富文本（用户消息也会渲染 RichText）
            # ⚠️ 取**最后一条**助手消息：history 恢复后第一条是历史里的助手消息（我第一版取第一条 → 全是假失败）
            ASSIST = "Array.from(document.querySelectorAll('[data-testid=\"assistant-text\"] [data-testid=\"rich-text\"]')).pop()"
            # ⚠️ 必须等**这一轮流式结束**再断言：只等 math≠0 会拿到中途快照
            #    （第一版就是这样 → "代码块/未闭合/失败"全红，其实渲染是对的）
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"assistant-text\"] [data-testid=\"code-unclosed\"]')",
                               timeout=120, interval=0.3)   # 并发跑 vitest 时 60s 偶发不够（实测 flaky）
            rich = driver.ch.evaluate("(() => { const r=" + ASSIST + ";"
                                      " return JSON.stringify({math:r.dataset.math, fail:r.dataset.mathFail,"
                                      " code:r.dataset.code, unclosed:r.dataset.unclosed, blocks:r.dataset.blocks}) })()")
            st = json.loads(rich)
            ok("公式：行内 + 块级都渲染成 KaTeX（data-math>0）", int(st["math"]) >= 3, rich)
            ok("公式：中文 \\text{} 能渲染（不报错）", int(st["fail"]) >= 1 and int(st["math"]) >= 3, rich)
            ok("公式失败：坏公式被如实标记（data-math-fail≥1）", int(st["fail"]) >= 1, rich)
            dom = driver.ch.outer_html()
            ok("公式失败：显示原文 + 「公式渲染失败」提示（不静默）",
               'data-testid="rich-text"' in dom and "公式渲染失败" in dom)
            ok("公式失败：原文仍在（学生不会看到空白）", '\\frac{1}{$' in dom or "frac" in dom)
            ok("KaTeX 真渲染出 DOM（.katex 存在）", "katex" in dom)
            ok("代码块：标了语言（sql）", 'data-lang="sql"' in dom)
            ok("代码块：未闭合围栏**照样按代码块渲染**并标注（不整段崩成纯文本）",
               'data-unclosed="1"' in dom and "代码围栏未闭合" in dom, "未闭合容错未生效")
            ok("代码块：有复制按钮 + 行数", 'data-testid="code-copy"' in dom and "data-lines=" in dom)
            # ★★ 用户实测反馈：**Markdown 没渲染**（标题/表格/粗体/列表全是纯文本）
            # ⚠️ 这些统计在**根元素的 dataset** 上（我第一版从旧 JSON 读 → 全是 None 假失败）
            ds = driver.ch.evaluate("(() => { const r=" + ASSIST + "; return r ? JSON.stringify(Object.assign({}, r.dataset)) : '{}' })()")
            d = json.loads(ds)
            ok("Markdown：标题渲染成 <h2>（不是 `##` 纯文本）", int(d.get("h2", "0")) >= 1, ds)
            ok("Markdown：表格渲染成 <table>（不是 `|` 纯文本）", int(d.get("table", "0")) >= 1, ds)
            ok("Markdown：粗体渲染成 <strong>", int(d.get("strong", "0")) >= 1, ds)
            ok("Markdown：列表渲染成 <ul>/<ol>", int(d.get("list", "0")) >= 1, ds)
            ok("Markdown：引用渲染成 <blockquote>", int(d.get("quote", "0")) >= 1, ds)
            ok("Markdown：链接渲染成 <a>（白名单协议）", int(d.get("link", "0")) >= 1, ds)
            md = driver.ch.evaluate("(() => { const r=" + ASSIST + ";"
                                    " return JSON.stringify({h2:r.querySelectorAll('h2').length,"
                                    " table:r.querySelectorAll('table.md-table').length,"
                                    " th:r.querySelectorAll('table.md-table th').length,"
                                    " td:r.querySelectorAll('table.md-table td').length,"
                                    " strong:r.querySelectorAll('strong').length,"
                                    " ul:r.querySelectorAll('ul.md-list').length,"
                                    " ol:r.querySelectorAll('ol.md-list').length,"
                                    " quote:r.querySelectorAll('blockquote.md-quote').length,"
                                    " hr:r.querySelectorAll('hr.md-hr').length,"
                                    " a:r.querySelectorAll('a.md-a').length,"
                                    " rawHash:(r.textContent.match(/^#{1,6}\s/m)||[]).length,"
                                    " rawPipe:(r.textContent.match(/^\|/m)||[]).length}) })()")
            mdj = json.loads(md)
            ok("Markdown：DOM 里真有 h2/table/th/td/strong/ul/ol/blockquote/hr/a",
               all(int(mdj[k]) >= 1 for k in ("h2", "table", "th", "td", "strong", "ul", "ol", "quote", "hr", "a")), md)
            ok("Markdown：**没有**残留的 `##` / `|` 行首纯文本",
               int(mdj["rawHash"]) == 0 and int(mdj["rawPipe"]) == 0, md)
            # 表格样式必须走设计 token（不是浏览器默认）
            tw = driver.ch.evaluate("(() => { const th=document.querySelector('table.md-table th');"
                                    " if (!th) return ''; const s=getComputedStyle(th);"
                                    " return JSON.stringify({border:s.borderTopWidth, pad:s.paddingTop, weight:s.fontWeight}) })()")
            ok("Markdown：表格有样式（边框/内边距/表头加粗）",
               '"border":"0px"' not in str(tw) and str(tw) != '""', str(tw))
            # ★ 语法高亮（Lead 裁定：highlight.js 按需语言 + 设计 token 配色）
            ok("代码块：sql 真的有高亮（hljs-* 类名）",
               'data-hl="1"' in dom and "hljs-keyword" in dom, "未见 hljs 类名")
            ok("代码块：高亮状态如实标注（已高亮/未标语言）",
               'data-testid="code-hl-ok"' in dom or 'data-testid="code-no-hl"' in dom)
            # 未标语言的代码块**不高亮**（不猜语言）
            unlabeled = driver.ch.evaluate("(() => { const b=Array.from(document.querySelectorAll('[data-testid=\"code-block\"]'))"
                                           ".find(x => x.dataset.lang === '');"
                                           " return b ? JSON.stringify({hl:b.dataset.hl, hasHljs: !!b.querySelector('[class*=hljs-]')}) : 'none' })()")
            ok("代码块：未标语言 → 不高亮（data-hl=0 且无 hljs 类名）",
               str(unlabeled) == 'none' or ('"hl":"0"' in str(unlabeled) and '"hasHljs":false' in str(unlabeled)), str(unlabeled))
            # ★ XSS：喂一段含 <script> 的代码 → DOM 里不能出现真的 script 元素，且文本原样
            danger = driver.ch.evaluate("(() => { const blocks=document.querySelectorAll('[data-testid=\"code-block\"]');"
                                        " const n=document.querySelectorAll('[data-testid=\"assistant-text\"] script').length;"
                                        " const t=Array.from(blocks).map(b=>b.textContent).join(' ');"
                                        " return JSON.stringify({script:n, hasAngle: t.includes('&lt;') || t.includes('<'),"
                                        " blocks: blocks.length}) })()")
            ok("代码块路径：无真的 script 元素（highlight.js 输出已转义）",
               '"script":0' in str(danger), str(danger))
            # 注入安全：模型输出里的 HTML 必须被转义（不能出现可执行标签）
            driver.ch.evaluate("(() => { const t=document.querySelector('[data-testid=\"chat-input\"]');"
                               " t.value='<img src=x onerror=alert(1)>'; t.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()")
            time.sleep(0.3)
            safe = driver.ch.evaluate("(() => { const r=" + ASSIST + ";"
                                      " return r ? r.querySelectorAll('img,script,iframe').length : -1 })()")
            ok("注入安全：模型输出里的 HTML 被转义（页面无 img/script/iframe）", int(safe) == 0, f"危险节点数={safe}")
            api("/api/v1/_fixture/config?rich=0")   # 复位，别影响后续用例

        run_view("富文本 / 公式 + 代码块 + 未闭合容错 + 失败如实", check_rich_text)

        # ============ 9b-2. 全局 chat 小助手：**每个页面**都能打开（用户明确需求） ============
        def check_dock_everywhere() -> None:
            # 六个页面（含我新做的 Settings / Lab）逐个断言：浮动入口存在 + 抽屉能开
            pages = [
                ("wiki", f"wiki?doc={DOC_PDF}&unit={UNIT}", 'data-ctx-keys="doc_id,unit_id"'),
                ("graph", f"graph?doc={DOC_PDF}", 'data-ctx-keys="doc_id"'),
                ("video", f"video?doc={DOC_VIDEO}", 'data-ctx-keys="doc_id"'),
                ("docs", "docs", ""),
                ("settings", "settings", ""),
                ("lab", "lab?load=1", 'data-ctx-keys="session_id"'),
            ]
            for name, route, want_ctx in pages:
                # ⚠️ 这里**不能**用 READY_VIEW（它只认 selftest-report/docs-report）——
                #    无自检的页面（settings/lab/graph）会一直等到超时。小助手是全局的，用它当就绪信号。
                dump_dom(driver, url(normal, route),
                         "!!document.querySelector('[data-testid=\"assistant-fab\"]')", timeout=120)
                if want_ctx == 'data-ctx-keys="session_id"':
                    # Lab 的 session_id 要等沙箱会话建立后才写入
                    driver.ch.wait_for("(document.querySelector('[data-testid=\"assistant-dock\"]')?.dataset.ctxKeys || '').includes('session_id')",
                                       timeout=120, interval=0.3)
                dom = driver.ch.outer_html()
                ok(f"{name}：小助手浮动入口存在", 'data-testid="assistant-fab"' in dom, f"{name} 无入口")
                ok(f"{name}：入口标出所在页", f'data-page="/{name}"' in dom)
                driver.ch.evaluate("document.querySelector('[data-testid=\"assistant-fab\"]').click()")
                driver.ch.wait_for("!!document.querySelector('[data-testid=\"assistant-drawer\"]')", timeout=30, interval=0.2)
                drawer = driver.ch.outer_html()
                ok(f"{name}：抽屉能打开且内含对话组件", 'data-testid="assistant-drawer"' in drawer and 'data-testid="chat-input"' in drawer)
                if want_ctx:
                    ok(f"{name}：带对页面上下文（{want_ctx}）", want_ctx in drawer,
                       f"{name} 上下文缺失：{want_ctx}")
                # 关掉，避免影响后续用例
                driver.ch.evaluate("document.querySelector('[data-testid=\"assistant-close\"]').click()")

        run_view("全局小助手 / 六个页面都能打开", check_dock_everywhere)

        def check_dock_chat() -> None:
            dump_dom(driver, url(normal, f"wiki?doc={DOC_PDF}&unit={UNIT}"),
                     "!!document.querySelector('[data-testid=\"assistant-fab\"]')", timeout=120)
            driver.ch.evaluate("document.querySelector('[data-testid=\"assistant-fab\"]').click()")
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"chat-input\"]')", timeout=30, interval=0.2)
            # 在抽屉里真发一条 → 真流式回答（走同一个 WS）
            driver.ch.evaluate("(() => { const d=document.querySelector('[data-testid=\"assistant-drawer\"]');"
                               " const t=d.querySelector('[data-testid=\"chat-input\"]');"
                               " t.value='这一节讲什么？'; t.dispatchEvent(new Event('input',{bubbles:true}));"
                               " setTimeout(() => d.querySelector('[data-testid=\"chat-send\"]').click(), 150); return 1 })()")
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"assistant-text\"]')",
                               timeout=60, interval=0.3)
            dom = driver.ch.outer_html()
            ok("小助手：能发消息并流式回答", 'data-testid="assistant-text"' in dom)
            # ★ 显式等 `context-used`（`context` 帧与流式回答是竞态 → 取一次快照会偶发失败，实测 308/307/307）
            try:
                driver.ch.wait_for("!!document.querySelector('[data-testid=\"context-used\"]')", timeout=30, interval=0.2)
                ctx_ok = True
            except Exception:
                ctx_ok = False
            dom2 = driver.ch.outer_html()
            ok("小助手：显示正在参考（服务端解析出的真实标题）",
               ctx_ok and 'data-testid="context-used"' in dom2 and "MySQL 26.7 Reference Manual" in dom2,
               "未显示 context 帧的 resolved 标题")
            # ★ 真正要保的性质：**抽屉发 prompt 时确实带上了 doc_id/unit_id**（不是"碰巧显示了标题"）
            keys = driver.ch.evaluate("(document.querySelector('[data-testid=\"input-context\"]')||{}).dataset?.keys || ''")
            ok("小助手：prompt 带上页面上下文（doc_id/unit_id）", "doc_id" in str(keys), f"keys={keys}")

        def check_assistant_entry() -> None:
            # 视频页：小助手的 WS 必须带 `assistant=video`（否则跑的是通用提示词 —— 契约不生效）
            dump_dom(driver, url(normal, f"video?doc={DOC_VIDEO}"),
                     "!!document.querySelector('[data-testid=\"assistant-fab\"]')", timeout=180)
            # 点开抽屉（视频页可能有覆盖层 → 失败重试一次；实测偶发点不中）
            opened = False
            for _ in range(3):
                driver.ch.evaluate("document.querySelector('[data-testid=\"assistant-fab\"]').click()")
                time.sleep(1.0)
                if driver.ch.evaluate("!!document.querySelector('[data-testid=\"assistant-drawer\"]')"):
                    opened = True
                    break
            ok("视频页：小助手抽屉能打开", opened)
            # 抽屉里的对话组件渲染出会话头（entry 标记 + ws 状态）
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"assistant-entry\"]')",
                               timeout=120, interval=0.3)
            driver.ch.wait_for("document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"ws-state\"]')?.textContent === 'open'",
                               timeout=120, interval=0.3)
            ok("视频页小助手：WS 已连上（能渲染会话头）", "ws-state" in driver.ch.outer_html())
            # 发一轮，断言 mock 回显的 assistant 入口是 video
            driver.ch.evaluate("(() => { const d=document.querySelector('[data-testid=\"assistant-drawer\"]');"
                               " const t=d.querySelector('[data-testid=\"chat-input\"]');"
                               " t.value='讲一下页分裂'; t.dispatchEvent(new Event('input',{bubbles:true}));"
                               " setTimeout(()=>d.querySelector('[data-testid=\"chat-send\"]').click(),150); return 1 })()")
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"assistant-text\"]')", timeout=60, interval=0.3)
            entry = driver.ch.evaluate("(document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"assistant-entry\"]')||{}).dataset?.entry || ''")
            ok("视频页小助手：入口 = video（系统提示词含渲染契约）", str(entry) == "video", f"entry={entry}")
            driver.ch.evaluate("document.querySelector('[data-testid=\"assistant-close\"]').click()")
            # 非视频页：入口 = chat
            dump_dom(driver, url(normal, f"wiki?doc={DOC_PDF}&unit={UNIT}"),
                     "!!document.querySelector('[data-testid=\"assistant-fab\"]')", timeout=120)
            driver.ch.evaluate("document.querySelector('[data-testid=\"assistant-fab\"]').click()")
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"assistant-entry\"]')", timeout=60, interval=0.3)
            entry2 = driver.ch.evaluate("(document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"assistant-entry\"]')||{}).dataset?.entry || ''")
            ok("Wiki 页小助手：入口 = chat", str(entry2) == "chat", f"entry={entry2}")
            driver.ch.evaluate("document.querySelector('[data-testid=\"assistant-close\"]').click()")

        run_view("助手入口 / video 页用视频提示词（assistant=video）", check_assistant_entry)

        run_view("全局小助手 / 真发消息 + 上下文回显", check_dock_chat)

        # ============ 9b-3. tools 自述字段与实际值**同源**（AGENTS.md 坑 21） ============
        def check_tools_consistency() -> None:
            # chat 模式：source=disabled-by-role ⇒ tools 必须为空
            dump_dom(driver, url(normal, "chat?selftest=0"), "!!document.getElementById('chat-report')", timeout=120)
            driver.ch.evaluate("(() => { const t=document.querySelector('[data-testid=\"chat-input\"]');"
                               " t.value='一致性检查'; t.dispatchEvent(new Event('input',{bubbles:true}));"
                               " setTimeout(() => document.querySelector('[data-testid=\"chat-send\"]').click(), 150); return 1 })()")
            driver.ch.wait_for("document.querySelector('[data-testid=\"session-tools\"]')?.dataset.source === 'disabled-by-role'",
                               timeout=60, interval=0.2)
            tools = driver.ch.evaluate("document.querySelector('[data-testid=\"session-tools\"]')?.dataset.tools || ''")
            ok("chat：tools_source=disabled-by-role ⇒ tools 必须为空（同源断言）",
               str(tools).strip() == "", f"tools={tools}")
            # agent 模式：source=kb-readonly ⇒ tools 必须含 KB 工具（反向断言：说开了就真开）
            driver.ch.evaluate("document.querySelector('[data-testid=\"mode-agent\"]').click()")
            driver.ch.wait_for("document.querySelector('[data-testid=\"session-tools\"]')?.dataset.source === 'kb-readonly'",
                               timeout=60, interval=0.2)
            tools2 = driver.ch.evaluate("document.querySelector('[data-testid=\"session-tools\"]')?.dataset.tools || ''")
            ok("agent：tools_source=kb-readonly ⇒ tools 必须含 kb_search/kb_get（同源断言）",
               "kb_search" in str(tools2) and "kb_get" in str(tools2), f"tools={tools2}")
            ok("agent：自述只读时绝不含危险工具（反向断言）",
               not any(x in str(tools2) for x in ("bash", "read", "edit", "write")), f"tools={tools2}")

        run_view("工具自述 vs 实际（同源断言，坑 21）", check_tools_consistency)

        # ============ 9b-4. AI 助教页体验（用户判据：消息分明 / 流式光标 / 工具步骤 / 会话列表） ============
        def check_chat_ux() -> None:
            api("/api/v1/_fixture/config?rich=1")
            dump_dom(driver, url(normal, "chat?selftest=0"),
                     "!!document.getElementById('chat-report')", timeout=120)
            # ① 会话列表（平铺，接后端接口；不本地造假）
            driver.ch.wait_for("document.querySelectorAll('[data-testid=\"session-item\"]').length >= 2", timeout=60, interval=0.3)
            dom = driver.ch.outer_html()
            ok("会话列表：平铺显示（来自后端 /chat/sessions）", 'data-testid="session-list"' in dom and 'data-testid="session-item"' in dom)
            # ⚠️ mock 的 cnv_mock0001 现在故意是**默认名 '新问答'**（用于验证派生显示名），
            #    所以这里断言**有真名的那条**（另一条的服务端 title）
            ok("会话列表：有标题与时间", "B+ 树节点分裂的代价" in dom, "列表里没有服务端 title")
            ok("会话列表：标出当前会话 id", 'data-testid="current-session"' in dom)
            # ② 输入区：上下文 chip（可点掉）+ 控件 + 发送
            ok("输入区：有上下文指示（可点掉）",
               'data-testid="input-context"' in dom or 'data-testid="input-context-none"' in dom)
            ok("输入区：模式/检索/发送都在输入区里",
               'data-testid="mode-select"' in dom and 'data-testid="retrieval-select"' in dom and 'data-testid="chat-send"' in dom)
            # ③ 发一轮 → 流式光标 / 消息分明 / 工具步骤
            driver.ch.evaluate("(() => { const t=document.querySelector('[data-testid=\"chat-input\"]');"
                               " t.value='讲讲 B+ 树'; t.dispatchEvent(new Event('input',{bubbles:true}));"
                               " setTimeout(()=>document.querySelector('[data-testid=\"chat-send\"]').click(),150); return 1 })()")
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"stream-cursor\"]')", timeout=30, interval=0.15)
            ok("流式：生成中有可见光标（stream-cursor）", True)
            ok("流式：busy 时发送按钮变『停止』",
               driver.ch.evaluate("!!document.querySelector('[data-testid=\"chat-abort\"]') && !document.querySelector('[data-testid=\"chat-send\"]')"))
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"assistant-text\"] [data-testid=\"code-unclosed\"]')",
                               timeout=120, interval=0.3)
            # ⚠️ 文本到达 ≠ 这一轮结束：`settled` 之后 busy 才 false（光标消失、发送按钮回来）
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"chat-send\"]')", timeout=60, interval=0.3)
            time.sleep(0.5)
            ux = driver.ch.evaluate("(() => {"
                                    " const user=document.querySelector('.msg.user'); const ai=document.querySelector('.msg.assistant');"
                                    " const cs=(el)=>{ const s=getComputedStyle(el); return s.backgroundColor+'|'+s.borderTopWidth+'|'+s.textAlign };"
                                    " const steps=Array.from(document.querySelectorAll('[data-testid=\"tool-call\"]'));"
                                    " return JSON.stringify({userBg: cs(user.querySelector('.body')), aiBg: cs(ai.querySelector('.body')),"
                                    " userCount: document.querySelectorAll('.msg.user').length, aiCount: document.querySelectorAll('.msg.assistant').length,"
                                    " toolTag: steps[0] ? steps[0].tagName : '', toolSummary: steps[0] ? steps[0].querySelector('summary').textContent.trim().slice(0,60) : '',"
                                    " toolCount: steps.length, cursorGone: !document.querySelector('[data-testid=\"stream-cursor\"]')}) })()")
            u = json.loads(ux)
            ok("消息结构：用户与 AI 是**不同的块**（各自底色/边框不同）", u["userBg"] != u["aiBg"], ux)
            ok("消息结构：多轮消息累积显示（user+assistant 都在）", int(u["userCount"]) >= 1 and int(u["aiCount"]) >= 1, ux)
            # 人话标签：不是原始工具名（`read`/`kb_search`），而是中文说明（读文件 / 检索知识库 …）
            summ = str(u["toolSummary"])
            ok("工具调用：渲染成可折叠的一步（<details> + **人话标签**）",
               u["toolTag"] == "DETAILS" and any(w in summ for w in ("读文件", "检索知识库", "读知识库原文", "执行命令"))
               and not summ.strip().startswith(("read", "kb_search", "bash")), ux)
            ok("流式结束后光标消失（不是一直闪）", bool(u["cursorGone"]), ux)
            # ④ 切会话：点第二个 → 当前会话 id 变化（新连接）
            before = driver.ch.evaluate("document.querySelector('[data-testid=\"current-session\"]').textContent")
            driver.ch.evaluate("Array.from(document.querySelectorAll('[data-testid=\"session-item\"]'))[1].click()")
            time.sleep(2)
            after = driver.ch.evaluate("document.querySelector('[data-testid=\"current-session\"]').textContent")
            ok("会话列表：点击可切换会话（当前会话 id 变化）", str(before) != str(after), f"{before} → {after}")
            api("/api/v1/_fixture/config?rich=0")

        run_view("AI 助教页体验 / 消息分明 + 流式 + 工具步骤 + 会话列表", check_chat_ux)

        # ============ 9b-5. 会话登记（IDOR 安全修复）：**必须用 POST /conversations 的 id 连 WS** ============
        def check_conversation_registration() -> None:
            dump_dom(driver, url(normal, "chat?selftest=0"),
                     "!!document.getElementById('chat-report')", timeout=120)
            # ① 会话来源必须是**服务端签发**（不是本地 web-<uuid>）
            driver.ch.wait_for("document.querySelector('[data-testid=\"session-origin\"]')?.dataset.origin === 'server'",
                               timeout=60, interval=0.3)
            sid = driver.ch.evaluate("document.querySelector('[data-testid=\"current-session\"]').textContent")
            ok("会话登记：当前会话 id 来自 POST /conversations（cnv_ 前缀）", "cnv_" in str(sid), str(sid))
            ok("会话登记：UI 标明会话由服务端登记",
               "服务端登记" in str(driver.ch.evaluate("document.querySelector('[data-testid=\"session-origin\"]').textContent")))
            # ② WS 真的连上了（说明服务端认这个 id）
            driver.ch.wait_for("document.querySelector('[data-testid=\"ws-state\"]')?.textContent === 'open'",
                               timeout=60, interval=0.3)
            ok("会话登记：用该 id 连 WS 成功（state=open）", True)
            # ③ 会话列表来自 GET /conversations（真实接口）
            driver.ch.wait_for("document.querySelectorAll('[data-testid=\"session-item\"]').length >= 2", timeout=60, interval=0.3)
            ok("会话列表：来自 GET /conversations（cnv_ 前缀）",
               "cnv_mock0001" in driver.ch.outer_html())
            # ④ 新建会话 → **再登记一个**（id 变化，且仍是服务端签发）
            before = str(sid)
            driver.ch.evaluate("document.querySelector('[data-testid=\"chat-newsession\"]').click()")
            time.sleep(3)
            after = driver.ch.evaluate("document.querySelector('[data-testid=\"current-session\"]').textContent")
            ok("新建会话：走登记流程（id 变化且仍为服务端签发）",
               str(after) != before and "cnv_" in str(after), f"{before} → {after}")

        run_view("会话登记 / 先 POST /conversations 再连 WS", check_conversation_registration)

        # ============ 9b-6. history 帧（刷新恢复）+ ready.reason（不清空） ============
        def check_history_and_reason() -> None:
            api("/api/v1/_fixture/config?history=1")
            dump_dom(driver, url(normal, "chat?selftest=0"),
                     "!!document.getElementById('chat-report')", timeout=120)
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"history-note\"]')", timeout=60, interval=0.3)
            hn = driver.ch.evaluate("(() => { const n=document.querySelector('[data-testid=\"history-note\"]');"
                                    " return JSON.stringify({count:n.dataset.historyCount, truncated:n.dataset.truncated,"
                                    " text:n.textContent.trim().slice(0,60), msgs:document.querySelectorAll('.msg').length,"
                                    " hasTable: !!document.querySelector('.msg.assistant table.md-table')}) })()")
            h = json.loads(hn)
            ok("history 帧：把历史消息铺进列表（≥2 条）", int(h["count"]) >= 2 and int(h["msgs"]) >= 2, hn)
            ok("history 帧：如实标注条数", "已从服务端恢复" in str(h["text"]), hn)
            ok("history 帧：内容按富文本渲染（历史里的表格也渲染）", bool(h["hasTable"]), hn)
            api("/api/v1/_fixture/config?history=0")

        run_view("history 帧 / 刷新后恢复消息列表", check_history_and_reason)

        # ============ 9b-7. 登记失败 → 输入禁用（Lead 判据：别给注定失败的会话） ============
        def check_conv_fail_blocks() -> None:
            # ★ 先清掉本地会话（有了 localStorage 兜底后，旧 id 会让 ensureSession 提前返回，
            #   夹具注入的"登记失败"根本走不到 —— 第一版就是这样超时的）
            dump_dom(driver, url(normal, "docs"), "!!document.getElementById('docs-report')", timeout=120)
            driver.ch.evaluate("localStorage.removeItem('ckb.chat.session')")
            api("/api/v1/_fixture/config?conv_fail=1")
            dump_dom(driver, url(normal, "chat?selftest=0"),
                     "!!document.getElementById('chat-report')", timeout=120)
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"session-blocked\"]')", timeout=90, interval=0.3)
            dom = driver.ch.outer_html()
            ok("登记失败：显示无法对话门控（不是先给一个连不上的会话）", 'data-testid="session-blocked"' in dom)
            ok("登记失败：写明原因（可读，不是网络错误）",
               "会话登记失败" in dom or "登记" in dom)
            ok("登记失败：给出出路（重试登记 / 新建会话）",
               'data-testid="session-retry"' in dom and 'data-testid="session-new"' in dom)
            disabled = driver.ch.evaluate("document.querySelector('[data-testid=\"chat-input\"]').disabled")
            ok("★ 登记失败：输入区**禁用**（判据）", bool(disabled), f"disabled={disabled}")
            api("/api/v1/_fixture/config?conv_fail=0")

        run_view("会话登记失败 / 输入禁用 + 可读提示", check_conv_fail_blocks)

        # ============ 9b-8. 抽取状态（done_empty 不是成功；needs_confirm 报次数+时长） ============
        def check_extract_status() -> None:
            dump_dom(driver, url(normal, "docs"), "!!document.getElementById('docs-report')", timeout=120)
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"extract-status\"]')", timeout=60, interval=0.3)
            dom = driver.ch.outer_html()
            # ★ 抽取状态是**按文档**的（不是"最新那份"）→ 取 PDF 那一行的单元格
            CELL = "document.querySelector('[data-doc-extract=\"" + DOC_PDF + "\"]')"
            st = driver.ch.evaluate(f"({CELL}?.querySelector('[data-testid=\"extract-status\"]')||{{}}).dataset?.status || ''")
            txt = driver.ch.evaluate(f"({CELL}?.querySelector('[data-testid=\"extract-status\"]')||{{}}).textContent?.trim() || ''")
            est = driver.ch.evaluate(f"({CELL}?.querySelector('[data-testid=\"extract-estimate\"]')||{{}}).textContent || ''")
            prog = driver.ch.evaluate(f"({CELL}?.querySelector('[data-testid=\"extract-progress\"]')||{{}}).textContent || ''")
            ok("抽取状态：读的是 meta.extract_status", str(st) == "done_empty", f"status={st}")
            ok("★ done_empty 不显示成成功（文案含零卡片）", "零卡片" in str(txt) and "成功" not in str(txt), str(txt))
            ok("★ done_empty 有如实说明（跑完但没产出）",
               "没有产出任何卡片" in dom, "缺少解释")
            ok("★ needs_confirm：按钮显示**次数 + 时长**（都要有）",
               "2523" in str(est) and ("3–7 小时" in str(est) or "3-7" in str(est)), str(est))
            ok("抽取进度：显示已抽取/总数", "340" in str(prog) and "2523" in str(prog), str(prog))
            ok("抽取按钮存在（needs_confirm 时才出现）", 'data-testid="extract-start"' in dom)

        run_view("抽取状态 / done_empty 不是成功 + 代价（次数+时长）", check_extract_status)

        # ============ 9b-9. 🔴 切走再回来消息还在（用户实测 bug） ============
        def check_session_survives_navigation() -> None:
            api("/api/v1/_fixture/config?conv_fail=0")   # 防御：上一个用例超时会让夹具残留
            dump_dom(driver, url(normal, "chat?selftest=0"),
                     "!!document.getElementById('chat-report')", timeout=120)
            driver.ch.wait_for("document.querySelector('[data-testid=\"ws-state\"]')?.textContent === 'open'", timeout=90, interval=0.3)
            sid1 = driver.ch.evaluate(f"({SID_PAGE}).textContent")
            ok("会话 id 已写进 URL（可分享/可刷新）", "session=cnv_" in str(driver.ch.evaluate("location.hash")),
               str(driver.ch.evaluate("location.hash"))[:120])
            # 发 1 轮（快，避免等太久；"2 轮"用下面的第二条断言覆盖多轮累积）
            for q in ("第一轮：聚簇索引是什么", "第二轮：那二级索引呢"):
                driver.ch.evaluate("(() => { const t=document.querySelector('[data-testid=\"chat-input\"]');"
                                   f" t.value={q!r}; t.dispatchEvent(new Event('input',{{bubbles:true}}));"
                                   " setTimeout(()=>document.querySelector('[data-testid=\"chat-send\"]').click(),150); return 1 })()")
                driver.ch.wait_for("!!document.querySelector('[data-testid=\"chat-send\"]')", timeout=90, interval=0.3)
                time.sleep(0.6)
            n_before = driver.ch.evaluate("document.querySelectorAll('[data-testid=\"chat-log\"] .msg').length")
            ok("多轮消息累积显示（≥2 条）", int(n_before) >= 2, f"msgs={n_before}")
            # ★ 切到知识库页 → 再切回对话页
            dump_dom(driver, url(normal, f"wiki?doc={DOC_PDF}&unit={UNIT}"), READY_WIKI_STATIC, timeout=120)
            dump_dom(driver, url(normal, "chat?selftest=0"), "!!document.getElementById('chat-report')", timeout=120)
            driver.ch.wait_for("document.querySelector('[data-testid=\"ws-state\"]')?.textContent === 'open'", timeout=90, interval=0.3)
            time.sleep(1.0)
            sid2 = driver.ch.evaluate(f"({SID_PAGE}).textContent")
            ok("★ 切走再回来：**sessionId 不变**（根因判据）", str(sid1) == str(sid2), f"{sid1} → {sid2}")
            n_after = driver.ch.evaluate("document.querySelectorAll('[data-testid=\"chat-log\"] .msg').length")
            ok("★ 切走再回来：**消息仍在**（history 帧恢复）", int(n_after) >= 2, f"before={n_before} after={n_after}")
            hist = driver.ch.evaluate("(document.querySelector('[data-testid=\"history-note\"]')||{}).textContent || ''")
            ok("★ 恢复走的是 history 帧（有可核验提示）", "恢复" in str(hist), str(hist)[:80])
            # ★ 反例：点"新会话" → id 变化 + 消息清空
            driver.ch.evaluate("document.querySelector('[data-testid=\"chat-newsession\"]').click()")
            time.sleep(3)
            sid3 = driver.ch.evaluate(f"({SID_PAGE}).textContent")
            n_new = driver.ch.evaluate("document.querySelectorAll('[data-testid=\"chat-log\"] .msg').length")
            ok("★ 点新会话：sessionId **变化**（只在用户要求时新建）", str(sid3) != str(sid2), f"{sid2} → {sid3}")
            ok("★ 新会话：消息**清空**（不能把旧消息填到新会话）", int(n_new) == 0, f"msgs={n_new}")

        run_view("🔴 切走再回来 / 会话与消息都还在", check_session_survives_navigation)

        # ============ 9b-10. 🔴 抽屉与整页必须是**两个独立会话**（polysemy-prober 复验抓出） ============
        def check_dock_session_isolated() -> None:
            # 干净起点：先清两个键，避免上一用例残留
            dump_dom(driver, url(normal, "docs"), "!!document.getElementById('docs-report')", timeout=120)
            driver.ch.evaluate("localStorage.removeItem('ckb.chat.session'); localStorage.removeItem('ckb.assistant.session')")
            # ① 整页 → 记 id
            dump_dom(driver, url(normal, "chat?selftest=0"), "!!document.getElementById('chat-report')", timeout=120)
            driver.ch.wait_for("document.querySelector('[data-testid=\"ws-state\"]')?.textContent === 'open'", timeout=90, interval=0.3)
            page_sid = str(driver.ch.evaluate(f"({SID_PAGE}).textContent")).strip()
            # ② 另一页开抽屉 → 记 id（必须是**不同的**会话）
            dump_dom(driver, url(normal, f"wiki?doc={DOC_PDF}&unit={UNIT}"), READY_WIKI_STATIC, timeout=120)
            driver.ch.evaluate("document.querySelector('[data-testid=\"assistant-fab\"]').click()")
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"current-session\"]')",
                               timeout=90, interval=0.3)
            driver.ch.wait_for("document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"ws-state\"]')?.textContent === 'open'",
                               timeout=90, interval=0.3)
            dock_sid = str(driver.ch.evaluate("document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"current-session\"]').textContent")).strip()
            ok("★ 抽屉与整页是**两个独立会话**（id 不同）", page_sid != dock_sid, f"page={page_sid} dock={dock_sid}")
            ok("★ 抽屉的会话也是服务端登记的（cnv_）", "cnv_" in dock_sid, dock_sid)
            ok("★ 抽屉不写页面 URL（仍在 wiki 页）",
               "session=" not in str(driver.ch.evaluate("location.hash")), str(driver.ch.evaluate("location.hash"))[:80])
            # ★ 关系判据（Lead）：抽屉点「新会话」**不得影响**主对话页的 id
            driver.ch.evaluate("document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"chat-newsession\"]').click()")
            time.sleep(3)
            dock2 = str(driver.ch.evaluate("document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"current-session\"]').textContent")).strip()
            ok("★ 抽屉点新会话：抽屉 id 变化", dock2 != dock_sid, f"{dock_sid} → {dock2}")
            dump_dom(driver, url(normal, "chat?selftest=0"), "!!document.getElementById('chat-report')", timeout=120)
            driver.ch.wait_for("document.querySelector('[data-testid=\"ws-state\"]')?.textContent === 'open'", timeout=90, interval=0.3)
            page2 = str(driver.ch.evaluate(f"({SID_PAGE}).textContent")).strip()
            ok("★ 抽屉新建会话**不影响**主对话页 id（关系判据）", page2 == page_sid, f"page {page_sid} → {page2}（dock={dock2}）")
            ok("★ 反向：主页面 id 与抽屉 id 始终不同", page2 != dock2, f"page={page2} dock={dock2}")

        run_view("🔴 抽屉/整页会话隔离", check_dock_session_isolated)

        # ============ 9b-11. PDF 重新解析入口（后端有端点、前端要有入口 + ★ 暂时禁用） ============
        def check_reparse_entry() -> None:
            dump_dom(driver, url(normal, "docs"), "!!document.getElementById('docs-report')", timeout=120)
            # ⚠️ ROW 必须**在用例开头**定义（第一版放在后面，前面的断言引用它 → UnboundLocalError）
            ROW = f"document.querySelector('[data-reparse=\"{DOC_PDF}\"]')?.closest('tr')"
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"btn-reparse\"]')", timeout=60, interval=0.3)
            dom = driver.ch.outer_html()
            ok("文档页有「重新解析」入口（后端端点有了，前端要能点到）",
               'data-testid="btn-reparse"' in dom)
            # ★ 已开放（Lead 真数据验证：units=4 · cards=5）→ 断言方向翻转
            ok("★ 按钮**已开放**（后端保卡修复已真数据验证）",
               driver.ch.evaluate(f"({ROW}?.querySelector('[data-testid=\"btn-reparse\"]')).disabled === false")
               and 'data-reparse-enabled="1"' in dom)
            ok("★ 旧的禁用理由文案已移除（完成使命）", 'data-testid="reparse_gate_reason"' not in dom)
            # ⚠️ 按**目标文档**限定（第一行是 video，page_count=0 → "页数未知"；我第一版就读错了行）
            est = driver.ch.evaluate(f"({ROW}?.querySelector('[data-testid=\"reparse_estimate\"]')||{{}}).textContent || ''")
            ok("★ 代价可见：给**区间**（不是假精确的单个数）", "–" in str(est) or "-" in str(est), str(est))
            ok("★ 代价里写明 OCR 本地、不耗 LLM 额度但占 CPU",
               "不消耗 LLM 额度" in str(est) and "CPU" in str(est), str(est))
            # ★ 现在点击**应该真的发请求**（与"禁用时不许发"互为反例 —— 同一判据的两个方向都要有）
            before = api("/api/v1/_fixture/reparse_calls").get("calls")
            driver.ch.evaluate(f"({ROW}?.querySelector('[data-testid=\"btn-reparse\"]')).click()")
            time.sleep(1.5)
            after = api("/api/v1/_fixture/reparse_calls").get("calls")
            ok("★★ 开放后点击**真的发请求**（调用数 +1）", int(after) > int(before), f"calls {before} → {after}")
            # ★ 服务端给的代价在**独立持久元素**里（不被进度帧冲掉）—— 用户整个任务期间都能看到"要等多久"
            cost = driver.ch.evaluate(f"({ROW}?.querySelector('[data-testid=\"reparse_server_cost\"]')||{{}}).textContent || ''")
            ok("★ 服务端代价**持久可见**：需 OCR + **区间** + cost_note",
               "需 OCR" in str(cost) and "65–87" in str(cost) and "消耗 LLM 额度" in str(cost), str(cost)[:160])
            st = driver.ch.evaluate(f"({ROW}?.querySelector('[data-testid=\"reparse_state\"]')||{{}}).textContent || ''")
            ok("★ 长任务进度可见（在动，不是卡死）",
               "tsk_reparse_mock" in str(st) and ("%" in str(st) or "进行中" in str(st)), str(st)[:120])

        run_view("PDF 重新解析 / 入口 + 禁用 + 代价（禁用点击不发请求）", check_reparse_entry)

        # ============ 9b-12. ★ 选择器作用域反例：**抽屉打开时**仍要读到正确那一个 ============
        def check_scoped_selectors() -> None:
            api("/api/v1/_fixture/config?conv_fail=0")
            dump_dom(driver, url(normal, "chat?selftest=0"), "!!document.getElementById('chat-report')", timeout=120)
            driver.ch.wait_for("document.querySelector('[data-testid=\"ws-state\"]')?.textContent === 'open'", timeout=90, interval=0.3)
            page_sid = str(driver.ch.evaluate(f"({SID_PAGE}).textContent")).strip()
            ok("反例准备：能读到**页面**会话节点（排除抽屉）", "cnv_" in page_sid, page_sid)
            # ★ 打开抽屉（抽屉里也有同名 `current-session`）→ 再读一次，必须**还是页面那个**
            driver.ch.evaluate("document.querySelector('[data-testid=\"assistant-fab\"]').click()")
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"current-session\"]')",
                               timeout=90, interval=0.3)
            both = driver.ch.evaluate("document.querySelectorAll('[data-testid=\"current-session\"]').length")
            page2 = str(driver.ch.evaluate(f"({SID_PAGE}).textContent")).strip()
            drawer_sid = str(driver.ch.evaluate("document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"current-session\"]').textContent")).strip()
            ok("★ 反例：抽屉打开后，页面级选择器仍读到**页面**那个（不是抽屉的）",
               page2 == page_sid and page2 != drawer_sid, f"page={page_sid}→{page2} drawer={drawer_sid} (同名节点数={both})")
            ok("★ 反例：两个同名节点确实同时存在（证明这条断言有意义）", int(both) >= 2, f"同名节点数={both}")
            driver.ch.evaluate("document.querySelector('[data-testid=\"assistant-close\"]').click()")

        run_view("★ 选择器作用域反例 / 抽屉打开时仍读对", check_scoped_selectors)

        # ============ 9b-13. 会话显示名兜底（契约 SESSION_NAMING §4.3：不再一排"新问答"） ============
        def check_session_label_fallback() -> None:
            # 干净起点（本地派生表会持久化，先清掉）
            dump_dom(driver, url(normal, "docs"), "!!document.getElementById('docs-report')", timeout=120)
            driver.ch.evaluate("localStorage.removeItem('ckb.chat.firstq'); localStorage.removeItem('ckb.chat.session')")
            api("/api/v1/_fixture/config?conv_fail=0")
            dump_dom(driver, url(normal, "chat?selftest=0"), "!!document.getElementById('chat-report')", timeout=120)
            driver.ch.wait_for("document.querySelectorAll('[data-testid=\"session-item\"]').length >= 2", timeout=60, interval=0.3)
            # ① 默认名会话**不再显示 '新问答'**（而是派生名或明确"未命名"）
            rows = driver.ch.evaluate(
                "JSON.stringify(Array.from(document.querySelectorAll('[data-testid=\"session-title\"]')).map(e => ({"
                " t: e.textContent.trim(), src: e.dataset.titleSource, api: e.dataset.apiTitle })))")
            items = json.loads(rows)
            default_row = [x for x in items if x["api"] == "新问答"]
            ok("契约 §4.3：默认名会话**不显示 '新问答'**",
               bool(default_row) and default_row[0]["t"] != "新问答", rows)
            ok("契约 §4.3：派生名标注来源（derived / server 可核验）",
               bool(default_row) and default_row[0]["src"] == "derived" and any(x["src"] == "server" for x in items), rows)
            # ② ★ 分清"DOM 显示"与"接口 title"：接口 title 仍是 '新问答'（派生**不写库**）
            api_list = api("/api/v1/conversations").get("conversations") or []
            api_title = next((c.get("title") for c in api_list if c.get("id") == "cnv_mock0001"), None)
            ok("★ 派生只是**显示层**：接口 title 仍是 '新问答'（不写库）", str(api_title) == "新问答", f"api title={api_title}")
            # ③ 发一条 → 该会话的派生名变成**首条提问前 20 字**
            q = "这是一个很长的问题用来验证前二十个字的截断行为是否生效以及省略号"
            driver.ch.evaluate("(() => { const t=document.querySelector('[data-testid=\"chat-input\"]');"
                               f" t.value={q!r}; t.dispatchEvent(new Event('input',{{bubbles:true}}));"
                               " setTimeout(()=>document.querySelector('[data-testid=\"chat-send\"]').click(),150); return 1 })()")
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"chat-send\"]')", timeout=90, interval=0.3)
            time.sleep(0.8)
            sid = str(driver.ch.evaluate(f"({SID_PAGE}).textContent")).strip()
            # 当前会话（服务端新登记的）不在列表里也没关系 —— 断言本地派生表已写入
            stored = driver.ch.evaluate("localStorage.getItem('ckb.chat.firstq') || ''")
            ok("★ 首条提问被本地记住（用于派生显示名）", q[:10] in str(stored), str(stored)[:120])
            # ④ 边界：超长 → 截断 + 省略号；HTML 特殊字符 → 不注入、不崩
            driver.ch.evaluate("localStorage.setItem('ckb.chat.firstq', JSON.stringify({'cnv_mock0001': "
                               "'<img src=x onerror=alert(1)> 这是一段超长文本用来验证截断以及注入安全边界是否成立'}))")
            dump_dom(driver, url(normal, "chat?selftest=0"), "!!document.getElementById('chat-report')", timeout=120)
            driver.ch.wait_for("document.querySelectorAll('[data-testid=\"session-item\"]').length >= 2", timeout=60, interval=0.3)
            b = driver.ch.evaluate(
                "(() => { const e=document.querySelector('[data-testid=\"session-title\"][data-api-title=\"新问答\"]');"
                " return JSON.stringify({ text: e.textContent.trim(), len: e.textContent.trim().length,"
                " injected: document.querySelectorAll('[data-testid=\"session-list\"] img, [data-testid=\"session-list\"] script').length }) })()")
            bj = json.loads(b)
            ok("★ 边界：超长 → 截断到 20 字 + 省略号", int(bj["len"]) <= 22 and bj["text"].endswith("…"), b)
            ok("★ 边界：HTML 特殊字符**不注入**（列表内无 img/script 节点）", int(bj["injected"]) == 0, b)
            ok("★ 边界：文本按原样显示（`<img …>` 作为纯文本）", "<img" in str(bj["text"]), b)

        run_view("会话显示名兜底 / 不再一排新问答 + 边界", check_session_label_fallback)

        # ============ 9b-14. 视频目录（collections）：教师建目录/上传；学生选目录→播放→AI 解析 ============
        def check_video_collections() -> None:
            api("/api/v1/_fixture/config?role=teacher&collections_missing=0")
            dump_dom(driver, url(normal, "video"), "!!document.getElementById('video-report')", timeout=120)
            driver.ch.wait_for("document.querySelectorAll('[data-testid=\"collection-item\"]').length >= 1", timeout=60, interval=0.3)
            dom = driver.ch.outer_html()
            ok("视频目录：列出服务端目录（不是前端编的）", 'data-testid="collection-item"' in dom and "第 5 讲 索引与执行计划" in dom)
            ok("视频目录：展示服务端算的 can_manage / published（不自己推断权限）",
               'data-can-manage="1"' in dom and 'data-published="1"' in dom)
            # ① 教师：建目录（表单可见）→ 创建后列表增加
            ok("★ 教师：有建目录入口 + 上传入口",
               'data-testid="collection-teacher-ops"' in dom and 'data-testid="collection-name"' in dom
               and 'data-testid="collection-upload"' in dom)
            before = driver.ch.evaluate("document.querySelectorAll('[data-testid=\"collection-item\"]').length")
            driver.ch.evaluate("(() => { const i=document.querySelector('[data-testid=\"collection-name\"]');"
                               " i.value='第 7 讲 备份与恢复'; i.dispatchEvent(new Event('input',{bubbles:true}));"
                               " document.querySelector('[data-testid=\"collection-create\"]').click(); return 1 })()")
            time.sleep(1.5)
            after = driver.ch.evaluate("document.querySelectorAll('[data-testid=\"collection-item\"]').length")
            ok("★ 教师：新建目录后列表增加", int(after) > int(before), f"{before} → {after}")
            # ② 选目录 → 视频列表 + 解析状态
            driver.ch.evaluate("document.querySelector('[data-testid=\"collection-item\"]').click()")
            driver.ch.wait_for("document.querySelectorAll('[data-testid=\"collection-video\"]').length >= 1", timeout=60, interval=0.3)
            vdom = driver.ch.outer_html()
            ok("目录内视频：显示解析状态（parse_state，服务端给的）",
               'data-testid="parse-state"' in vdom and 'data-parse-state="done"' in vdom)
            ok("目录内视频：显示解析原因（parse_reason）", 'data-testid="parse-reason"' in vdom)
            # ③ ★ AI 解析：可用 → **先展示代价**（次数 + cost_note）；不可用 → 禁用 + 逐字 reason
            costs = driver.ch.evaluate(
                "JSON.stringify(Array.from(document.querySelectorAll('[data-testid=\"ai-parse-cost\"]')).map(e => e.textContent.trim()))")
            ok("★ AI 解析：**先展示代价**（含次数 + 说明）",
               "42" in str(costs) and "消耗 LLM 额度" in str(costs), str(costs)[:160])
            gate = driver.ch.evaluate(
                "(() => { const b=Array.from(document.querySelectorAll('[data-testid=\"btn-ai-parse\"]'));"
                " return JSON.stringify(b.map(x => ({ disabled: x.disabled, reason: x.dataset.gateReason }))) })()")
            gj = json.loads(gate)
            ok("★ AI 解析不可用时：按钮**禁用** + 逐字显示后端 reason",
               any(x["disabled"] and "faster-whisper" in str(x["reason"]) for x in gj), gate)
            # ④ ★★ 禁用状态点击**不发请求**
            before_calls = api("/api/v1/_fixture/ai_parse_calls").get("calls")
            driver.ch.evaluate("Array.from(document.querySelectorAll('[data-testid=\"btn-ai-parse\"]')).filter(b=>b.disabled)[0]?.click()")
            time.sleep(1.0)
            after_calls = api("/api/v1/_fixture/ai_parse_calls").get("calls")
            ok("★★ 不可用时点击**不发请求**（调用数不变）", int(before_calls) == int(after_calls), f"{before_calls} → {after_calls}")
            # ⑤ 可用时点击 → 真的提交（计数 +1）
            driver.ch.evaluate("Array.from(document.querySelectorAll('[data-testid=\"btn-ai-parse\"]')).filter(b=>!b.disabled)[0].click()")
            time.sleep(1.5)
            calls2 = api("/api/v1/_fixture/ai_parse_calls").get("calls")
            ok("★ AI 解析可用时点击 → 真的提交（调用数 +1）", int(calls2) > int(after_calls), f"{after_calls} → {calls2}")
            note = driver.ch.evaluate("(document.querySelector('[data-testid=\"ai-parse-note\"]')||{}).textContent || ''")
            ok("提交后如实说明（含会消耗 LLM 额度）", "消耗 LLM 额度" in str(note) or "已提交" in str(note), str(note)[:100])

        run_view("视频目录 / 教师建目录+上传 + AI 解析代价", check_video_collections)

        # ============ 9b-15. 视频目录：**学生视图** + **后端未实现时如实说明** ============
        def check_video_collections_student_and_missing() -> None:
            # ① 学生：无教师操作，且有明确说明
            api("/api/v1/_fixture/config?role=student&collections_missing=0")
            dump_dom(driver, url(normal, "video"), "!!document.getElementById('video-report')", timeout=120)
            driver.ch.wait_for("document.querySelectorAll('[data-testid=\"collection-item\"]').length >= 1", timeout=60, interval=0.3)
            driver.ch.evaluate("document.querySelector('[data-testid=\"collection-item\"]').click()")
            time.sleep(1.0)
            sdom = driver.ch.outer_html()
            ok("★ 学生：**看不到**教师操作（建目录/上传）",
               'data-testid="collection-teacher-ops"' not in sdom)
            ok("★ 学生：有明确说明（为什么不能建/传）",
               'data-testid="collection-student-note"' in sdom)
            ok("★ 学生：仍能选目录 + 播放 + 看到 AI 解析",
               'data-testid="collection-videos"' in sdom and 'data-testid="btn-play"' in sdom
               and 'data-testid="btn-ai-parse"' in sdom)
            # ② 后端未实现 → 如实说明，且**不渲染假目录**
            api("/api/v1/_fixture/config?role=teacher&collections_missing=1")
            dump_dom(driver, url(normal, "video"), "!!document.getElementById('video-report')", timeout=120)
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"collections-note\"]')", timeout=60, interval=0.3)
            note = driver.ch.evaluate("document.querySelector('[data-testid=\"collections-note\"]').textContent")
            n_items = driver.ch.evaluate("document.querySelectorAll('[data-testid=\"collection-item\"]').length")
            ok("★ 后端未实现：如实说明（含尚未实现）", "尚未实现" in str(note), str(note)[:120])
            ok("★ 后端未实现：**不渲染假目录**（目录项数 = 0）", int(n_items) == 0, f"items={n_items}")
            api("/api/v1/_fixture/config?role=teacher&collections_missing=0")

        run_view("视频目录 / 学生视图 + 未实现如实说明", check_video_collections_student_and_missing)

        # ============ 9b-16. 会话命名（契约 SESSION_NAMING §4）：行内重命名 + AI 起名 ============
        def check_session_rename() -> None:
            api("/api/v1/_fixture/config?rename_fail=0")
            dump_dom(driver, url(normal, "chat?selftest=0"), "!!document.getElementById('chat-report')", timeout=120)
            driver.ch.wait_for("document.querySelectorAll('[data-testid=\"rename-start\"]').length >= 2", timeout=60, interval=0.3)
            # ① 行内编辑：Enter 提交 → 乐观更新 + 服务端确认
            before = api("/api/v1/_fixture/title_calls").get("rename")
            # ★ 记下**要改的是哪一个会话**（坑 28：不靠"第一个"，按 id 限定读取）
            target_id = str(driver.ch.evaluate("document.querySelector('[data-testid=\"rename-start\"]').dataset.id"))
            driver.ch.evaluate("document.querySelector('[data-testid=\"rename-start\"]').click()")
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"rename-input\"]')", timeout=30, interval=0.2)
            ok("★ 行内编辑：有输入框 + 长度计数（0/80，服务端才是权威）",
               'data-testid="rename-counter"' in driver.ch.outer_html()
               and "80" in str(driver.ch.evaluate("document.querySelector('[data-testid=\"rename-counter\"]').textContent")))
            driver.ch.evaluate("(() => { const i=document.querySelector('[data-testid=\"rename-input\"]');"
                               " i.value='我改的名字'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()")
            # ★ 先确认 v-model **真的**更新了（计数器是模型长度）—— 否则后面全是"输入没进去"的假象
            cnt = str(driver.ch.evaluate("document.querySelector('[data-testid=\"rename-counter\"]').textContent"))
            ok("行内编辑：输入后模型同步（计数器反映长度）", cnt.startswith("5/"), f"counter={cnt}")
            driver.ch.evaluate("(() => { const i=document.querySelector('[data-testid=\"rename-input\"]');"
                               " i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 1 })()")
            time.sleep(1.2)
            after = api("/api/v1/_fixture/title_calls").get("rename")
            ok("★ Enter 提交 → 真的发了 PATCH（调用数 +1）", int(after) > int(before), f"{before} → {after}")
            # ★ 按**目标 id** 读那一行（不读"第一个"）
            t1 = driver.ch.evaluate(
                f"document.querySelector('[data-testid=\"session-item\"][data-id=\"{target_id}\"] [data-testid=\"session-title\"]')?.textContent?.trim() || ''")
            ok("★ 乐观更新：列表**立即**显示新名字", "我改的名字" in str(t1), f"target={target_id} title={t1}")
            ok("★ 显示用服务端返回的 title_source（=user）",
               "user" in str(driver.ch.evaluate("document.querySelector('[data-testid=\"session-title\"][data-title-source-server=\"user\"]')?.dataset?.titleSourceServer || ''")))
            # ② Esc 取消：不改名、不发请求
            before2 = api("/api/v1/_fixture/title_calls").get("rename")
            driver.ch.evaluate("Array.from(document.querySelectorAll('[data-testid=\"rename-start\"]'))[1].click()")
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"rename-input\"]')", timeout=30, interval=0.2)
            driver.ch.evaluate("(() => { const i=document.querySelector('[data-testid=\"rename-input\"]');"
                               " i.value='不该保存'; i.dispatchEvent(new Event('input',{bubbles:true}));"
                               " i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return 1 })()")
            time.sleep(0.8)
            after2 = api("/api/v1/_fixture/title_calls").get("rename")
            ok("★ Esc 取消：**不发请求**（调用数不变）", int(before2) == int(after2), f"{before2} → {after2}")
            ok("★ Esc 取消：输入框关闭且名字未变",
               not driver.ch.evaluate("!!document.querySelector('[data-testid=\"rename-input\"]')")
               and "不该保存" not in driver.ch.outer_html())
            # ③ 空白名 → 本地拦截（不发请求）
            before3 = api("/api/v1/_fixture/title_calls").get("rename")
            driver.ch.evaluate("document.querySelector('[data-testid=\"rename-start\"]').click()")
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"rename-input\"]')", timeout=30, interval=0.2)
            driver.ch.evaluate("(() => { const i=document.querySelector('[data-testid=\"rename-input\"]');"
                               " i.value='   '; i.dispatchEvent(new Event('input',{bubbles:true}));"
                               " i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 1 })()")
            time.sleep(0.8)
            after3 = api("/api/v1/_fixture/title_calls").get("rename")
            note = driver.ch.evaluate("(document.querySelector('[data-testid=\"rename-note\"]')||{}).textContent || ''")
            ok("★ 空白名：本地拦截 + 如实提示（不发请求）",
               int(before3) == int(after3) and "不能为空" in str(note), f"{before3} → {after3} / {note}")
            driver.ch.evaluate("document.querySelector('[data-testid=\"rename-cancel\"]')?.click()")
            # ④ AI 起名：可用时 → 生成中 → 更新为 AI 名（title_source=ai）
            gen_before = api("/api/v1/_fixture/title_calls").get("generate")
            driver.ch.evaluate("Array.from(document.querySelectorAll('[data-testid=\"title-generate\"]')).filter(b=>!b.disabled)[0].click()")
            time.sleep(1.5)
            gen_after = api("/api/v1/_fixture/title_calls").get("generate")
            ok("★ AI 起名：点击真的发请求（调用数 +1）", int(gen_after) > int(gen_before), f"{gen_before} → {gen_after}")
            ok("★ AI 起名：成功后名字更新且标记为 AI（title_source=ai）",
               "AI" in driver.ch.outer_html() and 'data-testid="title-ai-mark"' in driver.ch.outer_html())
            # ⑤ ★ `title_source==='user'` → AI 按钮**禁用**（服务端也会拒 409）
            dis = driver.ch.evaluate(
                "(() => { const b=document.querySelector('[data-testid=\"title-generate\"][data-title-source-server=\"user\"]');"
                " return b ? b.disabled : null })()")
            ok("★ 已由用户命名（title_source=user）→ AI 起名按钮**禁用**", dis is True, f"disabled={dis}")

        run_view("会话命名 / 行内重命名 + AI 起名", check_session_rename)

        # ============ 9b-17. 重命名**失败要回滚** + 如实提示（乐观更新的反例） ============
        def check_rename_rollback() -> None:
            api("/api/v1/_fixture/config?rename_fail=1")
            dump_dom(driver, url(normal, "chat?selftest=0"), "!!document.getElementById('chat-report')", timeout=120)
            driver.ch.wait_for("document.querySelectorAll('[data-testid=\"rename-start\"]').length >= 2", timeout=60, interval=0.3)
            orig = driver.ch.evaluate("document.querySelectorAll('[data-testid=\"session-title\"]')[0].textContent.trim()")
            driver.ch.evaluate("document.querySelector('[data-testid=\"rename-start\"]').click()")
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"rename-input\"]')", timeout=30, interval=0.2)
            driver.ch.evaluate("(() => { const i=document.querySelector('[data-testid=\"rename-input\"]');"
                               " i.value='注定失败的名字'; i.dispatchEvent(new Event('input',{bubbles:true}));"
                               " i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 1 })()")
            time.sleep(1.5)
            now = driver.ch.evaluate("document.querySelectorAll('[data-testid=\"session-title\"]')[0].textContent.trim()")
            note = driver.ch.evaluate("(document.querySelector('[data-testid=\"rename-note\"]')||{}).textContent || ''")
            ok("★ 失败**回滚**原名（不留下没保存成功的名字）", str(now) == str(orig), f"{orig} → {now}")
            ok("★ 失败**如实提示**（不是静默失败）", "回滚" in str(note) or "失败" in str(note), str(note)[:100])
            api("/api/v1/_fixture/config?rename_fail=0")

        run_view("会话命名 / 失败回滚 + 如实提示", check_rename_rollback)

        # ============ 9b-18. 可用性三态文案（detecting / unavailable(reason)） ============
        def check_availability_tristate() -> None:
            # ① detecting：**"正在检测模型可用性（首次约 1 分钟）"**，且**不许**说成"可用/不可用"
            api("/api/v1/_fixture/config?avail=detecting")
            dump_dom(driver, url(normal, "docs"), "!!document.getElementById('docs-report')", timeout=120)
            ROW_PDF = f"document.querySelector('[data-doc-avail=\"{DOC_PDF}\"]')"
            driver.ch.wait_for(f"!!{ROW_PDF}", timeout=60, interval=0.3)
            dtext = str(driver.ch.evaluate(f"({ROW_PDF}).textContent"))
            ok("★ detecting 文案：正在检测模型可用性（首次约 1 分钟）",
               "正在检测模型可用性" in dtext and "1 分钟" in dtext, dtext[:120])
            ok("★★ detecting：不许显示成可用或不可用（探测未完成时不成立）",
               "不可用" not in dtext, dtext[:120])
            ok("★ detecting：任务侧 extract_note 逐字显示（含已等待 12s）",
               "已等待 12s" in str(driver.ch.outer_html()), "缺少 extract_note")
            ok("★ detecting：`data-availability` 如实标出状态机",
               str(driver.ch.evaluate(f"({ROW_PDF}).dataset.availability")) == "detecting")
            # ② unavailable：显示 **reason 原文** + 入口**禁用**（不画"能点但会失败"的按钮）
            api("/api/v1/_fixture/config?avail=unavailable")
            dump_dom(driver, url(normal, "docs"), "!!document.getElementById('docs-report')", timeout=120)
            driver.ch.wait_for(f"!!{ROW_PDF}", timeout=60, interval=0.3)
            utext = str(driver.ch.evaluate(f"({ROW_PDF}).textContent"))
            ok("★ unavailable 文案：显示 reason **原文**",
               "amr 返回 403" in utext and "凭据无效" in utext, utext[:160])
            ok("★ unavailable：`data-availability` = unavailable",
               str(driver.ch.evaluate(f"({ROW_PDF}).dataset.availability")) == "unavailable")
            gate = driver.ch.evaluate(
                f"(() => {{ const r={ROW_PDF}?.closest('tr'); const b=r?.querySelector('[data-testid=\"extract-start\"]');"
                " return JSON.stringify({ has: !!b, disabled: b ? b.disabled : null, reason: b ? b.dataset.gateReason : '' }) })()")
            gj = json.loads(gate)
            ok("★★ unavailable：抽取入口禁用 + 逐字原因（不画能点但会失败的按钮）",
               (gj["has"] is False) or (gj["disabled"] is True and "不可用" in str(gj["reason"])), gate)
            api("/api/v1/_fixture/config?avail=")

        run_view("可用性三态 / detecting + unavailable 文案", check_availability_tristate)

        # ============ 9c. 模式选择器（chat / agent）—— 用户需求，两个正交控件 ============
        def check_mode_switch() -> None:
            dom = dump_dom(driver, url(normal, "chat?selftest=0"), "!!document.getElementById('chat-report')", timeout=120)
            ok("模式分段控件存在（chat / agent）",
               'data-testid="mode-select"' in dom and 'data-testid="mode-chat"' in dom and 'data-testid="mode-agent"' in dom)
            ok("说清两者差异（快/能翻原文）", 'data-testid="mode-explain"' in dom and "kb_search" in dom)
            ok("检索与模式是**两个独立控件**",
               'data-testid="retrieval-select"' in dom and 'data-testid="mode-select"' in dom)
            # 发一轮（chat 默认）→ 后端回显 agent_mode=chat 且 tools 为空
            driver.ch.evaluate("(() => { const t=document.querySelector('[data-testid=\"chat-input\"]');"
                               " t.value='聚簇索引是什么？'; t.dispatchEvent(new Event('input',{bubbles:true}));"
                               " setTimeout(() => document.querySelector('[data-testid=\"chat-send\"]').click(), 150); return 1 })()")
            driver.ch.wait_for("document.querySelector('[data-testid=\"backend-mode\"]')?.dataset.backendMode === 'chat'",
                               timeout=60, interval=0.2)
            chat_dom = driver.ch.outer_html()
            ok("chat：后端回显 agent_mode=chat（不是自己选的）", 'data-backend-mode="chat"' in chat_dom)
            ok("chat：**没有** kb 工具帧（chat 不读原文）", 'data-testid="retrieval-tool"' not in chat_dom)
            # 切到 agent → 再发一轮 → 应有 kb_search/kb_get 工具帧 + tools 真值
            driver.ch.evaluate("document.querySelector('[data-testid=\"mode-agent\"]').click()")
            # ★ 断言**持久**提示（瞬时 mode-note 会被重连后的 ready 清掉 —— 那正是用户需要解释的时刻）
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"mode-switch-notice\"]')", timeout=30, interval=0.2)
            note = driver.ch.evaluate("document.querySelector('[data-testid=\"mode-switch-notice\"]').textContent")
            ok("切模式如实提示上下文重新开始（重连后仍在）", "上下文重新开始" in str(note), str(note)[:120])
            driver.ch.evaluate("(() => { const t=document.querySelector('[data-testid=\"chat-input\"]');"
                               " t.value='再讲一次聚簇索引'; t.dispatchEvent(new Event('input',{bubbles:true}));"
                               " setTimeout(() => document.querySelector('[data-testid=\"chat-send\"]').click(), 150); return 1 })()")
            driver.ch.wait_for("document.querySelectorAll('[data-testid=\"retrieval-tool\"]').length >= 2",
                               timeout=60, interval=0.2)
            agent_dom = driver.ch.outer_html()
            ok("agent：后端回显 agent_mode=agent", 'data-backend-mode="agent"' in agent_dom)
            ok("agent：真调用 kb_search", 'data-tool="kb_search"' in agent_dom)
            ok("agent：真调用 kb_get（读原文）", 'data-tool="kb_get"' in agent_dom)
            tools = driver.ch.evaluate("document.querySelector('[data-testid=\"session-tools\"]')?.dataset.tools || ''")
            src = driver.ch.evaluate("document.querySelector('[data-testid=\"session-tools\"]')?.dataset.source || ''")
            ok("agent：ready.tools 真值含 kb_search/kb_get",
               "kb_search" in str(tools) and "kb_get" in str(tools), f"tools={tools}")
            ok("agent：tools_source=kb-readonly", str(src) == "kb-readonly", f"source={src}")
            ok("agent：不含 bash/read（不是全能 agent）",
               "bash" not in str(tools) and "read" not in str(tools), f"tools={tools}")
            ok("agent：工具卡显示读了哪张卡片（result_text）", "unt_0001" in agent_dom or "3.1 聚簇索引" in agent_dom)

        run_view("模式选择器 / chat ⇄ agent（工具真值）", check_mode_switch)

        # ============ 9d. context 帧：服务端解析出的真实标题 + dropped 如实显示 ============
        def check_context_frame() -> None:
            # 带一个**不存在**的 unit_id → 后端应丢进 dropped 并如实显示
            dump_dom(driver, url(normal, "chat?selftest=0&doc=" + DOC_PDF + "&unit=unt_not_exist_zzz"), "!!document.getElementById('chat-report')", timeout=120)
            driver.ch.evaluate("(() => { const t=document.querySelector('[data-testid=\"chat-input\"]');"
                               " t.value='这一节讲什么？'; t.dispatchEvent(new Event('input',{bubbles:true}));"
                               " setTimeout(() => document.querySelector('[data-testid=\"chat-send\"]').click(), 150); return 1 })()")
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"context-used\"]')", timeout=60, interval=0.2)
            dom = driver.ch.outer_html()
            ok("context 帧：显示服务端解析出的**真实标题**（不是客户端 id）",
               'data-testid="context-used"' in dom and "MySQL 26.7 Reference Manual" in dom, "未显示 doc_title")
            ok("context 帧：解析不到的 unit_id 如实进 dropped（不静默）",
               'data-testid="context-dropped"' in dom and "未找到或无权访问" in dom, "dropped 未显示")

        run_view("context 帧 / 真实标题 + dropped 如实显示", check_context_frame)

        run_view("检索徽标 / wiki（命中 3 条）", check_retrieval_wiki)

        def check_retrieval_none() -> None:
            dom = chat_retrieval("none")
            ok("none：徽标标注没查库（不是 0 命中）",
               'data-mode="none"' in dom and 'data-status="none"' in dom and 'data-searched="0"' in dom,
               "none 与 empty 没区分开")
            ok("none：文案明确没查库", "没查库" in dom or "不检索" in dom)
            ok("none：与查了没命中视觉不同（灰虚线 vs 橙）",
               'data-status="none"' in dom and 'data-status="empty"' not in dom)

        run_view("检索徽标 / none（没查库）", check_retrieval_none)

        def check_retrieval_kg_empty() -> None:
            dom = chat_retrieval("kg")
            ok("kg：查了但 0 命中 → status=empty（与 none 不同）",
               'data-mode="kg"' in dom and 'data-status="empty"' in dom and 'data-hits="0"' in dom,
               "kg 空命中未标注")
            ok("kg：明确写查了但 0 命中", "0 命中" in dom)

        run_view("检索徽标 / kg（查了但 0 命中）", check_retrieval_kg_empty)

        def check_retrieval_kg_hit() -> None:
            dom = chat_retrieval("kg", kg_hit=True)
            ok("kg 命中：status=ok + why 可见（DEPENDS_ON）",
               'data-status="ok"' in dom and 'data-hits="1"' in dom)
            driver.ch.evaluate("document.querySelector('[data-testid=\"retrieval-why-toggle\"]').click()")
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"retrieval-why\"]')", timeout=20, interval=0.2)
            why_dom = driver.ch.outer_html()
            ok("kg：why 显示跳数（DEPENDS_ON 1 跳）", "DEPENDS_ON" in why_dom, "kg 的可解释性未显示")

        run_view("检索徽标 / kg（命中 1 条 + 路径）", check_retrieval_kg_hit)

        def check_retrieval_rag_unavailable() -> None:
            dom = chat_retrieval("rag")
            ok("rag：不可用 → status=unavailable + 未使用知识库",
               'data-mode="rag"' in dom and 'data-status="unavailable"' in dom and 'data-available="0"' in dom)
            ok("rag：显示可读原因（未配置 embedding provider）",
               'data-testid="retrieval-reason"' in dom and "embedding" in dom,
               "不可用原因未显示")

        run_view("检索徽标 / rag（不可用 + 原因）", check_retrieval_rag_unavailable)
        api("/api/v1/_fixture/config?retrieval=wiki&kg_hit=0")

        run_view("降级 / 对话入口禁用 + 原因", check_deg_chat)

        # ============ 10. 降级：知识库 TTS 禁用（各能力独立） ============
        deg_wiki = dump_dom(driver, url(degraded, f"wiki?doc={DOC_PDF}&unit={UNIT}&selftest=1"), READY_VIEW)

        def check_deg_wiki() -> None:
            st = report(deg_wiki, "selftest-report") or {}
            c = st.get("checks", {})
            tts = c.get("tts_gate") or {}
            ok("TTS 按钮禁用 + 原因含 ALIYUN", tts.get("disabled") is True and "ALIYUN" in str(tts.get("reason")),
               json.dumps(tts, ensure_ascii=False))
            ok("能力横幅列出不可用原因", len(c.get("caps_banner_gates") or []) > 0,
               json.dumps(c.get("caps_banner_gates"), ensure_ascii=False)[:200])
            ok("图谱/卡片仍可用（能力互相独立）",
               int(c.get("embedded_nodes") or 0) > 0 and c.get("cards_in_unit") == WIKI_CARDS,
               json.dumps({k: c.get(k) for k in ("embedded_nodes", "cards_in_unit")}))

        run_view("降级 / 知识库（TTS 禁用，其它能力不受影响）", check_deg_wiki)

        # ============ 11. 模型设置页（teacher）：热切换状态机 ============
        settings_dom = dump_dom(driver, url(normal, "settings?selftest=1"), READY_VIEW)

        def check_settings() -> None:
            rep = report(settings_dom, "settings-report") or {}
            ok("settings-report 存在", bool(rep))
            eq("角色为 teacher", rep.get("role"), "teacher")
            ok("识别为教师（可进设置页）", rep.get("is_staff") is True)
            eq("模型数（端点实测 8 个）", rep.get("models"), 8)
            eq("可用模型数", rep.get("available_models"), 7)
            ok("配置来源如实标注", rep.get("settings_source") in ("file", "default"), str(rep.get("settings_source")))
            ok("concurrency 锁为 1", rep.get("concurrency") == 1 and rep.get("concurrency_locked") is True)
            run = rep.get("running") or {}
            ok("显示运行中任务（不再是 0/368）", int(run.get("done") or 0) > 0 and int(run.get("total") or 0) == 368,
               json.dumps(run, ensure_ascii=False))
            # 进度/按钮文案在**自检 checks** 里（那是交互后的实测值；report 只是运行前快照）
            st = report(settings_dom, "selftest-report") or {}
            c = st.get("checks", {})
            ok("运行中进度条百分比 > 0", int(c.get("progress_pct") or 0) > 0, str(c.get("progress_pct")))
            ok("按钮文案为「终止并切换」", c.get("switch_button_label") == "终止并切换", str(c.get("switch_button_label")))
            ok("模型表格每行带 available", count(settings_dom, r'data-available="1"') >= 7)
            ok("concurrency 输入框禁用且标注固定=1",
               has(settings_dom, r'data-testid="concurrency"[^>]*disabled') and "固定=1" in settings_dom)
            ok("设置页自检全绿", st.get("ok") is True, f"failed={st.get('failed')}")
            ok("切换必须二次确认", c.get("confirm_required") is True)
            ok("运行中默认走 abort（终止并切换）", c.get("confirm_default_mode") == "abort")
            br = c.get("busy_rejected") or {}
            ok("运行中直接热切被拒（409 E_MODEL_BUSY）",
               "拒绝直接热切" in str(br.get("note")) and "rollup 137/368" in str(br.get("note")), json.dumps(br, ensure_ascii=False))
            sw = c.get("switched") or {}
            ok("abort 切换成功且 from→to 正确", sw.get("mode") == "abort" and sw.get("from") and sw.get("to"), json.dumps(sw, ensure_ascii=False)[:200])
            ok("切换后断点续推（从 137 继续，不重复计费）",
               int(((sw.get("resume") or {}).get("from_checkpoint")) or 0) == 137 and (sw.get("resume") or {}).get("state") == "resuming",
               json.dumps(sw.get("resume"), ensure_ascii=False))
            ok("切换后 activeModel 变为目标", c.get("active_after_switch") == sw.get("to"), str(c.get("active_after_switch")))
            ok("记录 switchedFrom / switchedAt", c.get("switched_from") == sw.get("from") and c.get("switched_at_text") not in ("", "—", None),
               f"{c.get('switched_from')} @ {c.get('switched_at_text')}")
            rb = c.get("rollback") or {}
            ok("切到坏模型 → 回滚且 activeModel 不变",
               "已回滚" in str(rb.get("note")) and rb.get("activeModel") == sw.get("to"), json.dumps(rb, ensure_ascii=False))
            ok("表里显示不可用模型的 reason", "HTTP 503" in settings_dom and 'data-testid="model-down-note"' in settings_dom)

        run_view("模型设置 / 热切换状态机（teacher）", check_settings)

        # ============ 12. 模型设置页：学生角色 → 入口不给（权限在服务端） ============
        api("/api/v1/_fixture/config?role=student")
        settings_student = dump_dom(driver, url(normal, "settings?selftest=1"), "!!document.getElementById('settings-report')")
        api("/api/v1/_fixture/config?role=teacher")

        def check_settings_student() -> None:
            rep = report(settings_student, "settings-report") or {}
            eq("角色为 student", rep.get("role"), "student")
            ok("不识别为教师", rep.get("is_staff") is False)
            ok("显示角色门控说明（不是空白页）",
               'data-testid="role-gate"' in settings_student and "需要教师或管理员角色" in settings_student)
            ok("导航里的设置入口标记不可用",
               'data-nav="/settings"' in settings_student and ("不可用" in settings_student or "需要教师" in settings_student))
            ok("模型表格不渲染（无权限）", 'data-testid="model-table"' not in settings_student)

        run_view("模型设置 / 学生角色门控", check_settings_student)

        # ============ 13. SQL 练习台：引擎门控 + 完整 CRUD + 答疑引用 ============
        lab_dom = dump_dom(driver, url(normal, "lab?selftest=1"), READY_VIEW)

        def check_lab() -> None:
            rep = report(lab_dom, "lab-report") or {}
            ok("lab-report 存在", bool(rep))
            eq("选中引擎", rep.get("engine"), "sqlite")
            ok("引擎可用", rep.get("engine_available") is True)
            engines = rep.get("engines") or []
            ok("引擎列表来自 /capabilities.sandbox.engines（含不可用项及原因）",
               len(engines) >= 2 and any(not e.get("available") and e.get("reason") for e in engines),
               json.dumps(engines, ensure_ascii=False)[:200])
            eq("数据集数量（真后端默认 sc + 我保留的 3 套）", len(rep.get("datasets") or []), 4)
            ok("方言显著标注", "SQLite" in str(rep.get("dialect")))
            ok("maxRows 声明在页面上", has(lab_dom, r'data-testid="limits"') and "maxRows=" in lab_dom)
            ok("方言差异表（诚实标注 SQLite ≠ MySQL）",
               'data-testid="dialect-note"' in lab_dom and "AUTO_INCREMENT" in lab_dom and "存储过程" in lab_dom)
            st = report(lab_dom, "selftest-report") or {}
            ok("练习台自检全绿", st.get("ok") is True, f"failed={st.get('failed')}")
            c = st.get("checks", {})
            ok("引擎下拉项数 = 上报数", c.get("engines_rendered") == len(engines), str(c.get("engines_rendered")))
            ok("不可用引擎带原因（指向 Docker 部署文档）",
               any("未安装 Docker" in str(x) for x in (c.get("engines_disabled") or [])), json.dumps(c.get("engines_disabled"), ensure_ascii=False))
            # ★ 完整 CRUD（真点击「运行」按钮）
            ok("① 建表 CREATE TABLE", (c.get("crud_ddl") or {}).get("error") is None, json.dumps(c.get("crud_ddl"), ensure_ascii=False))
            ok("② 插数 → ③ 查询读到 1 行", (c.get("crud_select") or {}).get("rows") == [[1, "我的笔记"]],
               json.dumps(c.get("crud_select"), ensure_ascii=False))
            ok("④ 更新后查询可见新值", c.get("crud_update_visible") is True)
            ok("⑤ 删除后查询为 0 行", c.get("crud_delete_visible") is True)
            ok("⑦ 事务 BEGIN 可执行", c.get("tx_begin") is not False)
            j = c.get("join") or {}
            ok("三表 JOIN（真实教学 schema）", len(j.get("rows") or []) == 3 and j.get("cols") == ["sname", "cname", "grade"],
               json.dumps(j, ensure_ascii=False))
            a = c.get("agg") or {}
            ok("GROUP BY 聚合", len(a.get("rows") or []) == 3, json.dumps(a, ensure_ascii=False))
            ok("reset 回到初始 schema（默认数据集 sc：students/courses/enrollments 行数 >0）",
               sum(1 for t in (c.get("reset_tables") or []) if "(" in str(t) and str(t).split("(")[1].rstrip(")").isdigit()
                   and int(str(t).split("(")[1].rstrip(")")) > 0) >= 2,
               json.dumps(c.get("reset_tables"), ensure_ascii=False))
            # 安全红线
            ok("ATTACH 被拒（E_SQL_FORBIDDEN）", (c.get("attach_blocked") or {}).get("code") == "E_SQL_FORBIDDEN")
            ok("多语句拼接被拒（E_SQL_MULTI）", (c.get("multi_blocked") or {}).get("code") == "E_SQL_MULTI")
            ok("报错文本是 SQL 原生错误（no such table + E_SQL_NO_OBJECT）",
               "no such table" in str((c.get("bad_table_error") or {}).get("msg"))
               and (c.get("bad_table_error") or {}).get("code") == "E_SQL_NO_OBJECT",
               json.dumps(c.get("bad_table_error"), ensure_ascii=False)[:160])
            # ★ 答疑
            ask = c.get("ask") or {}
            ok("答疑流式返回（>40 字）", int(ask.get("len") or 0) > 40, json.dumps(ask, ensure_ascii=False)[:160])
            # 真后端没有 progress 帧 → 上下文在"回显的用户消息"里（ask_user_echo）；两条路都算证据
            seen = str((ask.get("context") or {}).get("error") or "") + " " + str(c.get("ask_user_echo") or "")
            ok("答疑看到学生的真实报错（SQL/报错进了提示词）", "no such table" in seen, seen[:160])
            ok("答疑是「先问后引」而不是直接给答案", "先别急着" in str(ask.get("head")))
            ok("答疑引用知识库卡片（≥1）", int(ask.get("citations") or 0) > 0)
            # ★ 错误归因三档（Lead 硬要求：三种不能长得一样）
            w1, w2, w3 = c.get("who_student") or {}, c.get("who_rules") or {}, c.get("who_system") or {}
            ok("学生的错：who=student + E_SQL_SYNTAX", w1.get("kind") == "student" and w1.get("code") == "E_SQL_SYNTAX",
               json.dumps(w1, ensure_ascii=False)[:180])
            ok("规则限制：who=rules + E_SQL_FORBIDDEN", w2.get("kind") == "rules" and w2.get("code") == "E_SQL_FORBIDDEN",
               json.dumps(w2, ensure_ascii=False)[:180])
            ok("系统/超时：E_SQL_TIMEOUT + killedBy 归因", w3.get("kind") == "system" and w3.get("code") == "E_SQL_TIMEOUT",
               json.dumps(w3, ensure_ascii=False)[:180])
            ok("三档视觉色调互不相同", len({w1.get("tone"), w2.get("tone"), w3.get("tone")}) == 3,
               f"{w1.get('tone')}/{w2.get('tone')}/{w3.get('tone')}")
            ok("三档文案互不相同（规则/系统话术各就其位）",
               len({w1.get("text"), w2.get("text"), w3.get("text")}) == 3
               and "规则限制" in str(w2.get("text")) and ("系统" in str(w3.get("text")) or "中断" in str(w3.get("text"))),
               json.dumps([w1.get("text"), w2.get("text"), w3.get("text")], ensure_ascii=False)[:300])
            ok("超时显示 killedBy/hardKilled 归因", "killedBy=" in str(c.get("kill_attribution")), str(c.get("kill_attribution"))[:120])
            ok("引用链接可跳原文（#/wiki?...&card=）",
               str(c.get("citation_anchor", "")).startswith("#/wiki?") and "card=" in str(c.get("citation_anchor")),
               str(c.get("citation_anchor")))

        run_view("SQL 练习台 / CRUD + 安全红线 + 答疑", check_lab)

        # ============ 14. 练习台：maxRows 截断必须明示 ============
        api("/api/v1/_fixture/config?maxrows=2")
        dump_dom(driver, url(normal, "lab?selftest=0&load=1"), "!!document.getElementById('lab-report')")

        def check_truncate() -> None:
            # 走页面里的真实执行链路：填 SQL → 点「运行」→ 断言"仅显示前 N 行"提示
            driver.ch.evaluate(
                "(() => { const t=document.querySelector('[data-testid=\"sql-input\"]');"
                " t.value='SELECT * FROM enrollments'; t.dispatchEvent(new Event('input',{bubbles:true}));"
                " setTimeout(() => document.querySelector('[data-testid=\"btn-run\"]').click(), 80); return 1 })()"
            )
            driver.ch.wait_for("!!document.querySelector('[data-testid=\"truncate-note\"]')", timeout=60, interval=0.2)
            dom = driver.ch.outer_html()
            ok("超过 maxRows 时给出截断提示", 'data-testid="truncate-note"' in dom, "无提示即视为骗人")
            ok("提示写明「仅显示前 N 行」", "仅显示前" in dom and "共" in dom)
            ok("结果表仍渲染（不是空）", 'data-testid="result-table"' in dom and count(dom, r"<tr") > 2,
               f"rows={count(dom, r'<tr')}")

        run_view("SQL 练习台 / maxRows 截断明示", check_truncate)
        api("/api/v1/_fixture/config?maxrows=200")

        # ============ 15. 降级：沙箱引擎不可用（禁用 + 原因 + 文档指向） ============
        deg_lab = dump_dom(driver, url(degraded, "lab?selftest=1"), "!!document.getElementById('lab-report')")

        def check_deg_lab() -> None:
            rep = report(deg_lab, "lab-report") or {}
            ok("降级下引擎不可用", rep.get("engine_available") is False)
            ok("显示禁用说明（不是空白）", 'data-testid="engine-gate"' in deg_lab and "不可用" in deg_lab)
            ok("原因指向部署文档章节", "LAB_DB_DEPLOY" in deg_lab, "只说「不可用」不合格")
            ok("运行按钮禁用", has(deg_lab, r'data-testid="btn-run"[^>]*disabled'))
            ok("重置按钮禁用", has(deg_lab, r'data-testid="btn-reset"[^>]*disabled'))
            ok("练习题不假装能执行：没有结果表", 'data-testid="result"' not in deg_lab)

        run_view("降级 / SQL 练习台（引擎不可用）", check_deg_lab)

        # ============ 16. 文档页：真 multipart 上传（CDP 选文件） ============
        upload_probe = WEB / "test" / "_upload_probe.txt"

        def check_upload() -> None:
            upload_probe.write_text("课程知识平台上传测试：这是一个纯文本资料。" * 40, encoding="utf-8")
            try:
                driver.ch.navigate("about:blank", timeout=30)
                driver.ch.navigate(url(normal, "docs"), timeout=60)
                driver.ch.wait_for("!!document.getElementById('docs-report')", timeout=60, interval=0.2)
                before = len(api("/api/v1/_fixture/meta")["config"]["uploads"])
                # 真选文件（`input.value = path` 在浏览器里是只读的，必须走 DOM.setFileInputFiles）
                driver.ch.call("DOM.enable")
                doc_node = driver.ch.call("DOM.getDocument", {"depth": -1})
                node = driver.ch.call("DOM.querySelector", {"nodeId": doc_node["root"]["nodeId"], "selector": 'input[type="file"]'})
                ok("页面上有 file input", bool(node.get("nodeId")))
                driver.ch.call("DOM.setFileInputFiles", {"files": [str(upload_probe)], "nodeId": node["nodeId"]})
                # 等**上传真正结束**：note 一出现是"正在上传…"，那不是结果
                driver.ch.wait_for(
                    "(() => { const n=document.querySelector('[data-testid=\"upload-note\"]');"
                    " return !!n && /已上传|失败/.test(n.textContent) })()",
                    timeout=90, interval=0.2)
                note = str(driver.ch.evaluate("document.querySelector('[data-testid=\"upload-note\"]').textContent") or "")
                meta = api("/api/v1/_fixture/meta")["config"]
                after = len(meta["uploads"])
                ok("上传真的发出去了（mock 收到 multipart）", after == before + 1, f"{before} → {after}")
                ok("界面显示上传结果（含 document_id）", "document_id=" in note, note[:100])
                ok("上传后触发解析任务（task_id）", "task_id=" in note or "tsk_" in note, note[:120])
                # 任务进度（SSE 主 + 轮询兜底都在 TaskStream 里）——必须等**真帧到达**再断言
                driver.ch.wait_for(
                    "(() => { const e=document.querySelector('[data-testid=\"task-info\"]');"
                    " return !!e && e.dataset.progress !== '' && e.dataset.done === 'true' })()",
                    timeout=60, interval=0.2)
                task_attrs = driver.ch.evaluate(
                    "(() => { const e=document.querySelector('[data-testid=\"task-info\"]');"
                    " return JSON.stringify({ id:e.dataset.taskId, done:e.dataset.done, progress:e.dataset.progress }) })()"
                )
                t = json.loads(task_attrs)
                ok("任务进度可见（id + done 帧）", bool(t.get("id")) and t.get("done") == "true", task_attrs)
                ok("进度百分比来自 SSE progress 帧（42%）", str(t.get("progress")) == "42", task_attrs)
            finally:
                try:
                    upload_probe.unlink()
                except OSError:
                    pass

        run_view("文档页 / 真 multipart 上传 + 任务进度", check_upload)

    finally:
        mock.terminate()
        try:
            mock.wait(timeout=10)
        except subprocess.TimeoutExpired:
            mock.kill()

    print("\n".join(RESULTS))
    passed = len([r for r in RESULTS if r.startswith("  ✓")])
    print(f"\n{'✓' if FAILURES == 0 else '✗'} headless Chrome DOM 断言：{passed} 通过 / {FAILURES} 失败")
    return 0 if FAILURES == 0 else 1


if __name__ == "__main__":
    sys.exit(main())




