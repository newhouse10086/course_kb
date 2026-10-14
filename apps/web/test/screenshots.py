#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""5 个视图 × 亮/暗 = 10 张 headless Chrome 截图 + **对比度实测**

用法：python test/screenshots.py [输出目录]（默认 test/screenshots/）

为什么要截图：设计系统（docs/DESIGN_SYSTEM.md）的验收是"肉眼可辨手册感"——
那必须真出图，不能靠嘴说。截图用 CDP（test/cdp.py），等页面 `#*-report` 出现后再截，
所以截到的是**数据填满**的状态（不是骨架屏）。

对比度：按 WCAG 相对亮度公式实算（正文 ≥7:1、元数据 ≥4.5:1），**不凭感觉**。
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
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEB = HERE.parent
sys.path.insert(0, str(HERE))
from cdp import Chrome, find_chrome  # noqa: E402

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)

VIEWS = [
    ("wiki", "wiki?doc={pdf}&unit={unit}", "!!document.getElementById('selftest-report') || !!document.getElementById('wiki-report')"),
    ("graph", "graph?doc={pdf}", "!!document.getElementById('perf-report')"),
    ("video", "video?doc={video}", "!!document.getElementById('video-report')"),
    ("chat", "chat", "!!document.getElementById('chat-report')"),
    ("docs", "docs", "!!document.getElementById('docs-report')"),
    ("settings", "settings", "!!document.getElementById('settings-report')"),
    ("lab", "lab?load=1", "!!document.getElementById('lab-report') && !!document.querySelector('[data-testid=\"sql-input\"]')"),
]

# 空状态的页面截不出设计效果 → 截图前先做一次**真实交互**把内容填上（不是塞假 DOM）
WARMUP = {
    # 对话：**等 WS open** 再输入；点击放在下一个 tick（Vue 的 disabled 是异步刷新的，
    #   同一 tick 里读 `b.disabled` 拿到的还是旧值 —— 第一版就栽在这）
    "chat": (
        "(() => {"
        " const st=document.querySelector('[data-testid=\"ws-state\"]');"
        " if(!st || st.textContent.trim()!=='open') return 'wait-open';"
        " const t=document.querySelector('[data-testid=\"chat-input\"]');"
        " if(!t) return 'no-input';"
        " const v='聚簇索引和二级索引有什么区别？';"
        " if(t.value!==v){ t.value=v; t.dispatchEvent(new Event('input',{bubbles:true})); }"
        " if(window.__shotSent) return 'sent';"
        " window.__shotSent=1;"
        " setTimeout(() => { const b=document.querySelector('[data-testid=\"chat-send\"]');"
        "   if(b && !b.disabled) b.click() }, 120);"
        " return 'scheduled' })()",
        4000,
    ),
    # 视频：点一条字幕跳到该时间点（截到"当前字幕/当前章节"有值的样子）
    "video": (
        "(() => { const r=document.querySelector('[data-testid=\"vscroll\"] .vscroll-row');"
        " if(!r) return 'no-row'; r.click(); return 'clicked' })()",
        900,
    ),
}


def start_mock() -> tuple[subprocess.Popen, dict]:
    port_file = Path(tempfile.gettempdir()) / f"coursekb-shot-ports-{os.getpid()}.json"
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
            raise RuntimeError((proc.stderr.read() or b"").decode("utf-8", "replace")[-1200:])
        time.sleep(0.2)
    raise RuntimeError("mock server 未就绪")


# ---------------------------------------------------------------- 对比度

def _lin(c: float) -> float:
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def contrast(fg: str, bg: str) -> float:
    a, b = luminance(fg), luminance(bg)
    hi, lo = max(a, b), min(a, b)
    return round((hi + 0.05) / (lo + 0.05), 2)


# 与 src/style.css 的 token 一一对应（改样式时这里也要同步，测试会打印实测值）
TOKENS = {
    "light": {"paper": "#f7f4ec", "panel": "#fdfcf8", "ink": "#1c1a16", "ink-2": "#4a453c", "muted": "#6f6759", "accent": "#b8332a", "accent-ink": "#8f251d"},
    "dark": {"paper": "#14161a", "panel": "#191c21", "ink": "#e8e4da", "ink-2": "#b6b1a6", "muted": "#8d887c", "accent": "#e0564a", "accent-ink": "#f07a6e"},
}


def measure_contrast() -> int:
    print("\n[对比度实测 · WCAG 2.1]")
    bad = 0
    for theme, t in TOKENS.items():
        rows = [
            ("正文 ink / paper", t["ink"], t["paper"], 7.0),
            ("正文 ink / panel", t["ink"], t["panel"], 7.0),
            ("次级正文 ink-2 / paper", t["ink-2"], t["paper"], 7.0),
            ("元数据 muted / paper", t["muted"], t["paper"], 4.5),
            ("元数据 muted / panel", t["muted"], t["panel"], 4.5),
            ("朱红 accent-ink / paper", t["accent-ink"], t["paper"], 4.5),
        ]
        print(f"  {theme}:")
        for label, fg, bg, need in rows:
            r = contrast(fg, bg)
            flag = "✓" if r >= need else "✗"
            if r < need:
                bad += 1
            print(f"    {flag} {label}: {r}:1（要求 ≥{need}:1）")
    return bad


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
    shots = 0
    try:
        with Chrome(chrome, width=1560, height=1080) as ch:
            for theme in ("light", "dark"):
                ch.set_theme(theme)
                for name, route, ready in VIEWS:
                    r = route.format(pdf=docs["pdf"], video=docs["video"], unit=docs["unit"])
                    url = f"{base}/#/{r}{'&' if '?' in r else '?'}theme={theme}"
                    try:
                        ch.navigate(url, timeout=120)
                        ch.wait_for(ready, timeout=120, interval=0.2)
                        warm = WARMUP.get(name)
                        if warm:
                            got = "wait-open"
                            for _ in range(20):                      # 等 WS 连上（最多 ~6s）
                                got = ch.evaluate(warm[0])
                                if got != "wait-open":
                                    break
                                time.sleep(0.3)
                            time.sleep(warm[1] / 1000)
                            print(f"    · {name} 预热：{got}")
                        time.sleep(0.6)                       # 卡片错峰淡入（≤300ms）走完再截
                        path = OUT / f"{name}-{theme}.png"
                        ch.screenshot(str(path), full_page=True)
                        size = path.stat().st_size
                        print(f"  ✓ {path.name}（{size // 1024} KB）")
                        shots += 1
                    except Exception as e:
                        print(f"  ✗ {name}-{theme} 截图失败：{type(e).__name__}: {e}")
                    ch.navigate("about:blank", timeout=30)
    finally:
        mock.terminate()
        try:
            mock.wait(timeout=10)
        except subprocess.TimeoutExpired:
            mock.kill()

    bad = measure_contrast()
    print(f"\n{'✓' if shots == len(VIEWS) * 2 and bad == 0 else '✗'} 截图 {shots}/{len(VIEWS) * 2} 张 → {OUT}")
    return 0 if shots == len(VIEWS) * 2 and bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

