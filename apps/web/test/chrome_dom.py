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



