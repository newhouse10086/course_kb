#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""真机零 LLM 验证：**先 POST /conversations 拿 id → 用该 id 连 WS 成功**（IDOR 修复后的新流程）

不花额度：只登录 + 建会话 + 握手，**不发 prompt**。
用法：python test/real_session_register.py [--backend http://127.0.0.1:8787]
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

BACKEND = 'http://127.0.0.1:8787'
USER, PW = 'teacher', 'Teacher2026lab'
for i, a in enumerate(sys.argv):
    if a == '--backend' and i + 1 < len(sys.argv):
        BACKEND = sys.argv[i + 1]
    if a == '--user' and i + 1 < len(sys.argv):
        USER = sys.argv[i + 1]
    if a == '--password' and i + 1 < len(sys.argv):
        PW = sys.argv[i + 1]


def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    chrome = find_chrome()
    if not chrome:
        print('✗ 找不到 Chrome')
        return 2
    pf = Path(tempfile.gettempdir()) / f'ckb-sess-{os.getpid()}.json'
    if pf.exists():
        pf.unlink()
    proxy = subprocess.Popen(['node', str(HERE / 'mock-server.mjs'), '--proxy', BACKEND, '--port-file', str(pf)],
                             cwd=str(WEB), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for _ in range(200):
            if pf.exists():
                break
            time.sleep(0.2)
        base = f"http://127.0.0.1:{json.loads(pf.read_text(encoding='utf-8'))['real']}"
        with Chrome(chrome) as ch:
            ch.navigate(f'{base}/#/login?next=/chat', timeout=120)
            ch.wait_for("!!document.getElementById('login-report')", timeout=90, interval=0.3)
            ch.evaluate("(() => { const u=document.querySelector('[data-testid=\"login-username\"]');"
                        f" u.value={json.dumps(USER)}; u.dispatchEvent(new Event('input',{{bubbles:true}}));"
                        " const p=document.querySelector('[data-testid=\"login-password\"]');"
                        f" p.value={json.dumps(PW)}; p.dispatchEvent(new Event('input',{{bubbles:true}})); return 1 }})()")
            time.sleep(0.5)
            ch.evaluate("document.querySelector('[data-testid=\"login-submit\"]').click()")
            ch.wait_for("location.hash.includes('/chat')", timeout=120, interval=0.3)
            ch.wait_for("!!document.querySelector('[data-testid=\"session-origin\"]')", timeout=120, interval=0.5)
            origin = ch.evaluate("document.querySelector('[data-testid=\"session-origin\"]').dataset.origin")
            sid = ch.evaluate("document.querySelector('[data-testid=\"current-session\"]').textContent")
            note = ch.evaluate("(document.querySelector('[data-testid=\"session-origin-note\"]')||{}).textContent || ''")
            print(f'会话来源 = {origin} ｜ {sid.strip()}')
            if note:
                print(f'⚠️ 登记提示：{note}')
            ok_origin = origin == 'server' and 'cnv_' in str(sid)
            print(f'{"✓" if ok_origin else "✗"} 用的是 POST /conversations 返回的 id（服务端签发）')
            # WS 必须连上（零 LLM：不发 prompt）
            try:
                ch.wait_for("document.querySelector('[data-testid=\"ws-state\"]')?.textContent === 'open'",
                            timeout=90, interval=0.5)
                ws_ok = True
            except Exception:
                ws_ok = False
            ws_note = ch.evaluate("(document.querySelector('[data-testid=\"ws-note\"]')||{}).textContent || ''")
            err = ch.evaluate("(document.querySelector('[data-testid=\"chat-error\"]')||{}).textContent || ''")
            print(f'{"✓" if ws_ok else "✗"} WS 用该 id 连上（state=open）｜note={str(ws_note)[:80]}')
            if err:
                print(f'⚠️ 页面错误：{str(err)[:200]}')
            return 0 if (ok_origin and ws_ok) else 1
    finally:
        proxy.terminate()
        try:
            proxy.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proxy.kill()


if __name__ == '__main__':
    sys.exit(main())
