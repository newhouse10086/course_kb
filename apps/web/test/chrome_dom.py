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
            ok("答疑看到学生的真实报错", "no such table" in str((ask.get("context") or {}).get("error")))
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




