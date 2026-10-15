#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""三种渲染的**真实截图**（Lead 要求）：公式（KaTeX）/ 代码块 / 思维导图

- 公式 + 代码：对话页（夹具 `rich=1` 让助手回答带行内/块级公式、中文 \\text{}、坏公式、代码块、未闭合围栏）
- 思维导图：视频页（markmap 解析 + 节点「▶ 时间」按钮，与字幕联动）

用法：python test/screenshot_rich.py [输出目录]
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEB = HERE.parent
sys.path.insert(0, str(HERE))
from cdp import Chrome, find_chrome  # noqa: E402

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "screenshots"


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    chrome = find_chrome()
    if not chrome:
        print("✗ 找不到 Chrome")
        return 2
    pf = Path(tempfile.gettempdir()) / f"ckb-rich-shot-{os.getpid()}.json"
    if pf.exists():
        pf.unlink()
    mock = subprocess.Popen(["node", str(HERE / "mock-server.mjs"), "--port-file", str(pf)],
                            cwd=str(WEB), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    shots = 0
    try:
        for _ in range(200):
            if pf.exists():
                break
            time.sleep(0.2)
        info = json.loads(pf.read_text(encoding="utf-8"))
        base = f"http://127.0.0.1:{info['normal']}"
        docs = info["docs"]
        # 夹具：让助手回答里带公式/代码/未闭合围栏
        urllib.request.urlopen(f"{base}/api/v1/_fixture/config?rich=1", timeout=10).read()

        with Chrome(chrome, width=1560, height=1080) as ch:
            for theme in ("light", "dark"):
                ch.set_theme(theme)
                # ① 公式 + 代码块（对话页）
                ch.navigate(f"{base}/#/chat?theme={theme}", timeout=120)
                ch.wait_for("!!document.getElementById('chat-report')", timeout=120, interval=0.3)
                ch.wait_for("document.querySelector('[data-testid=\"ws-state\"]')?.textContent === 'open'", timeout=120, interval=0.3)
                ch.evaluate("(() => { const t=document.querySelector('[data-testid=\"chat-input\"]');"
                            " t.value='讲讲 B+ 树的复杂度与建表 SQL'; t.dispatchEvent(new Event('input',{bubbles:true}));"
                            " setTimeout(()=>document.querySelector('[data-testid=\"chat-send\"]').click(),150); return 1 })()")
                ch.wait_for("!!document.querySelector('[data-testid=\"assistant-text\"] [data-testid=\"code-unclosed\"]')",
                            timeout=90, interval=0.3)
                time.sleep(1.0)
                p = OUT / f"rich-formula-code-{theme}.png"
                ch.screenshot(str(p), full_page=True)
                print(f"  ✓ {p.name}（{p.stat().st_size // 1024} KB）")
                shots += 1
                # ② 思维导图（视频页）
                ch.navigate(f"{base}/#/video?doc={docs['video']}&theme={theme}", timeout=120)
                ch.wait_for("!!document.querySelector('[data-testid=\"mindmap\"]')", timeout=180, interval=0.3)
                time.sleep(1.0)
                p2 = OUT / f"rich-mindmap-{theme}.png"
                ch.screenshot(str(p2), full_page=True)
                print(f"  ✓ {p2.name}（{p2.stat().st_size // 1024} KB）")
                shots += 1
                ch.navigate("about:blank", timeout=30)
        print(f"\n{'✓' if shots == 4 else '✗'} 三种渲染截图 {shots}/4 张 → {OUT}")
        return 0 if shots == 4 else 1
    finally:
        mock.terminate()
        try:
            mock.wait(timeout=10)
        except subprocess.TimeoutExpired:
            mock.kill()


if __name__ == "__main__":
    sys.exit(main())
