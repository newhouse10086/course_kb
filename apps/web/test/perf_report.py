#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""性能报告（真实体量）—— 打印可引用的数字，不做断言

跑法：npm run test:perf
产出：图谱（1644 节点 / 481 边）的 ticks / 帧 / 帧耗时 p50·p95·max / 单步物理耗时，
     以及 Wiki 页（内嵌子图）、视频页（3000 条字幕虚拟滚动）的加载耗时与 DOM 行数。

⚠️ 必须在**真实时间**下跑：`--virtual-time-budget` 会让 `performance.now()` 恒为 0，
   那样拿到的"0 ms"是假的（v1 踩过）。这里用 CDP，不存在虚拟时钟。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEB = HERE.parent
sys.path.insert(0, str(HERE))
from cdp import Chrome, find_chrome  # noqa: E402


def start_mock() -> tuple[subprocess.Popen, dict]:
    port_file = Path(tempfile.gettempdir()) / f"coursekb-perf-ports-{os.getpid()}.json"
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
        time.sleep(0.2)
    raise RuntimeError("mock server 未就绪")


def report_of(ch, el_id: str):
    raw = ch.evaluate(f"(document.getElementById('{el_id}')||{{}}).textContent")
    return json.loads(raw) if raw else {}


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    chrome = find_chrome()
    if not chrome:
        print("✗ 找不到 Chrome")
        return 2
    if not (WEB / "dist" / "index.html").exists():
        print("✗ 先 npm run build")
        return 2

    mock, info = start_mock()
    base = f"http://127.0.0.1:{info['normal']}"
    docs = info["docs"]
    rows: list[tuple[str, str]] = []
    try:
        with Chrome(chrome, width=1440, height=1000) as ch:
            # --- 图谱：等布局收敛（settled）---
            t0 = time.time()
            ch.navigate(f"{base}/#/graph?doc={docs['pdf']}", timeout=120)
            ch.wait_for("(() => { const p=document.getElementById('perf-report'); if(!p) return false; const d=JSON.parse(p.textContent||'{}'); return d.settled===true && d.nodes>0 })()", timeout=180, interval=0.3)
            p = report_of(ch, "perf-report")
            b = p.get("bench") or {}
            rows += [
                ("图谱 · 节点 / 边", f"{p.get('nodes')} / {p.get('edges')}（flagged {p.get('flagged_edges')}）"),
                ("图谱 · 布局收敛", f"{p.get('ticks')} ticks / {p.get('frames')} 帧 / {p.get('elapsed_ms')} ms（页面内 performance.now()）"),
                ("图谱 · 帧耗时", f"p50 {p.get('frame_ms_p50')} ms · p95 {p.get('frame_ms_p95')} ms · max {p.get('frame_ms_max')} ms · fps {p.get('fps')}"),
                ("图谱 · 有效帧样本", str(p.get("frame_samples"))),
                ("图谱 · 单步物理", f"{b.get('per_tick_ms')} ms/tick（{b.get('n')} 次基准 {b.get('total_ms')} ms）"),
            ]

            # --- Wiki：内嵌子图 ---
            t1 = time.time()
            ch.navigate(f"{base}/#/wiki?doc={docs['pdf']}&unit={docs['unit']}", timeout=120)
            ch.wait_for("!!document.getElementById('wiki-report')", timeout=120, interval=0.2)
            w = report_of(ch, "wiki-report")
            emb = ch.evaluate("(() => { const e=document.getElementById('embedded-graph'); const c=e.querySelector('.graph-canvas'); return JSON.stringify({nodes:e.dataset.nodes, edges:e.dataset.edges, seeds:e.dataset.seedCount, src:e.dataset.seedSource, p50:c.dataset.frameP50, ticks:c.dataset.ticks, drawn:c.dataset.drawn}) })()")
            e = json.loads(emb)
            cards_in_unit = ch.evaluate("document.querySelectorAll('.kcard').length")
            rows += [
                ("知识库 · 单元卡片", f"{docs['unit']} → {cards_in_unit} 张卡片"),
                ("知识库 · 页面加载", f"{w.get('load_ms')} ms（页面内 performance.now()）"),
                ("知识库 · 内嵌子图", f"{e['nodes']} 节点 / {e['edges']} 边（种子 {e['seeds']}，来源 {e['src']}，已绘制 {e['drawn']}）"),
                ("知识库 · 内嵌子图布局", f"{e.get('ticks')} ticks（帧中位 {e.get('p50') or '—'} ms）"),
            ]

            # --- 视频：3000 条字幕虚拟滚动 ---
            t2 = time.time()
            ch.navigate(f"{base}/#/video?doc={docs['video']}", timeout=120)
            ch.wait_for("!!document.getElementById('video-report')", timeout=120, interval=0.2)
            v = report_of(ch, "video-report")
            dom_rows = ch.evaluate("document.querySelectorAll('[data-testid=\"vscroll\"] .vscroll-row').length")
            spacer = ch.evaluate("(() => { const s=document.querySelector('[data-testid=\"vscroll\"] .vscroll-spacer'); return s ? s.style.height : '' })()")
            rows += [
                ("视频 · 字幕条数", str(v.get("segments"))),
                ("视频 · 页面加载", f"{v.get('load_ms')} ms（页面内 performance.now()）"),
                ("视频 · 虚拟滚动", f"DOM 行 {dom_rows} 行 / 占位高 {spacer}"),
                ("视频 · 章节 / 幻灯片", f"{v.get('chapters')} 章 / {v.get('slides')} 帧（图片帧）"),
            ]
    finally:
        mock.terminate()
        try:
            mock.wait(timeout=10)
        except subprocess.TimeoutExpired:
            mock.kill()

    width = max(len(k) for k, _ in rows)
    print("\n性能报告（headless Chromium，真实时间，非虚拟时钟）")
    print("─" * (width + 46))
    for k, v in rows:
        print(f"  {k.ljust(width)}  {v}")
    print("─" * (width + 46))
    return 0


if __name__ == "__main__":
    sys.exit(main())


