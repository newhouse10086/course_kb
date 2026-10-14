#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""真后端截图：**如实保留空态**（不用 mock 数据美化）

与 screenshots.py 的区别：
  · screenshots.py 是设计系统的证据（契约 mock 的饱满数据，14 张）
  · 本脚本是**真后端**的证据：登录真流程（httpOnly cookie）+ 真数据（cards=0 的空态也照样拍）

用法：python test/screenshots_real.py [--backend http://127.0.0.1:8799] [--user admin] [--pass Admin2026lab]
产出：test/screenshots/real-{wiki,graph,docs,lab,settings}-{light,dark}.png
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

OUT = HERE / 'screenshots'
BACKEND = 'http://127.0.0.1:8799'
USER = 'admin'
PASSWORD = 'Admin2026lab'
for i, a in enumerate(sys.argv):
    if a == '--backend' and i + 1 < len(sys.argv):
        BACKEND = sys.argv[i + 1]
    if a == '--user' and i + 1 < len(sys.argv):
        USER = sys.argv[i + 1]
    if a == '--pass' and i + 1 < len(sys.argv):
        PASSWORD = sys.argv[i + 1]

# (名字, 路由, 就绪条件) —— 就绪条件里都带"真数据已渲染"的判据
VIEWS = [
    ('wiki', 'wiki', "!!document.getElementById('wiki-report')"),
    ('graph', 'graph', "!!document.getElementById('perf-report')"),
    ('docs', 'docs', "!!document.getElementById('docs-report')"),
    ('lab', 'lab', "!!document.getElementById('lab-report')"),
    ('settings', 'settings', "!!document.getElementById('settings-report')"),
]


def start_proxy() -> tuple[subprocess.Popen, str]:
    port_file = Path(tempfile.gettempdir()) / f'coursekb-shots-{os.getpid()}.json'
    if port_file.exists():
        port_file.unlink()
    proc = subprocess.Popen(['node', str(HERE / 'mock-server.mjs'), '--proxy', BACKEND, '--port-file', str(port_file)],
                            cwd=str(WEB), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    deadline = time.time() + 60
    while time.time() < deadline:
        if port_file.exists():
            info = json.loads(port_file.read_text(encoding='utf-8'))
            if info.get('real'):
                return proc, f"http://127.0.0.1:{info['real']}"
        if proc.poll() is not None:
            raise RuntimeError((proc.stderr.read() or b'').decode('utf-8', 'replace')[-600:])
        time.sleep(0.2)
    raise RuntimeError('代理未就绪')


def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    chrome = find_chrome()
    if not chrome:
        print('✗ 找不到 Chrome')
        return 2
    if not (WEB / 'dist' / 'index.html').exists():
        print('✗ 先 npm run build')
        return 2
    OUT.mkdir(exist_ok=True)
    proxy, base = start_proxy()
    shots = 0
    try:
        with Chrome(chrome) as ch:
            # ---- 真登录（httpOnly cookie 由服务端下发） ----
            ch.navigate(f'{base}/#/login?next=/wiki', timeout=90)
            ch.wait_for("!!document.getElementById('login-report')", timeout=90, interval=0.2)
            ch.evaluate("(() => { const u=document.querySelector('[data-testid=\"login-username\"]');"
                        f" u.value={json.dumps(USER)}; u.dispatchEvent(new Event('input',{{bubbles:true}}));"
                        " const p=document.querySelector('[data-testid=\"login-password\"]');"
                        f" p.value={json.dumps(PASSWORD)}; p.dispatchEvent(new Event('input',{{bubbles:true}}));"
                        " return 1 })()")
            time.sleep(0.4)
            # 登录页本身也拍一张（真后端 auth.required=true 的第一屏）
            for theme in ('light', 'dark'):
                ch.set_theme(theme)
                time.sleep(0.5)
                ch.screenshot(OUT / f'real-login-{theme}.png')
                shots += 1
                print(f'  ✓ real-login-{theme}.png')
            ch.evaluate("document.querySelector('[data-testid=\"login-submit\"]').click()")
            ch.wait_for("location.hash.startsWith('#/wiki')", timeout=60, interval=0.2)
            ch.wait_for("(() => { const a=document.querySelector('[data-testid=\"auth-box\"]');"
                        " return !!a && a.textContent.includes('admin') })()", timeout=60, interval=0.2)
            for theme in ('light', 'dark'):
                ch.set_theme(theme)
                for name, route, ready in VIEWS:
                    ch.navigate('about:blank', timeout=30)
                    ch.navigate(f'{base}/#/{route}', timeout=120)
                    ch.wait_for(ready, timeout=120, interval=0.25)
                    # 能力横幅慢（真探测 7–8.4s）→ 截图前等它落地，否则拍到"加载中"
                    try:
                        ch.wait_for("!!document.querySelector('[data-testid=\"caps-bar\"] [data-cap=\"llm\"]')", timeout=30, interval=0.3)
                    except TimeoutError:
                        print(f'    ! {name}: 能力横幅 30s 内未就绪（如实拍下"加载中"）')
                    ch.set_theme(theme)
                    time.sleep(1.2)
                    ch.screenshot(OUT / f'real-{name}-{theme}.png')
                    shots += 1
                    print(f'  ✓ real-{name}-{theme}.png')
    finally:
        proxy.terminate()
        try:
            proxy.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proxy.kill()
    print(f'\n{"✓" if shots >= 10 else "✗"} 真后端截图 {shots} 张 → {OUT}（空态如实保留）')
    return 0 if shots >= 10 else 1


if __name__ == '__main__':
    sys.exit(main())
