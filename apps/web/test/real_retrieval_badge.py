#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""真后端验证：**检索模式徽标**（契约 §4 / pi-bridge 已实现的 `retrieval` 帧）

为什么单独跑：整条 real_e2e 在 `node --watch` 重启窗口下偶发超时；徽标这条只依赖
"真 WS + 真模型 + 真 retrieval 帧"，单独跑更快、更稳，且能打印四种模式的真值。

用法：python test/real_retrieval_badge.py [--backend http://127.0.0.1:8787]
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
MODE = 'wiki'
for i, a in enumerate(sys.argv):
    if a == '--backend' and i + 1 < len(sys.argv):
        BACKEND = sys.argv[i + 1]
    if a == '--mode' and i + 1 < len(sys.argv):
        MODE = sys.argv[i + 1]


def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    chrome = find_chrome()
    if not chrome:
        print('✗ 找不到 Chrome')
        return 2
    port_file = Path(tempfile.gettempdir()) / f'ckb-retr-{os.getpid()}.json'
    if port_file.exists():
        port_file.unlink()
    proxy = subprocess.Popen(['node', str(HERE / 'mock-server.mjs'), '--proxy', BACKEND, '--port-file', str(port_file)],
                             cwd=str(WEB), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    base = None
    try:
        for _ in range(200):
            if port_file.exists():
                base = f"http://127.0.0.1:{json.loads(port_file.read_text(encoding='utf-8'))['real']}"
                break
            time.sleep(0.2)
        if not base:
            print('✗ 代理未就绪')
            return 2
        with Chrome(chrome) as ch:
            ch.navigate(f'{base}/#/login?next=/chat', timeout=120)
            ch.wait_for("!!document.getElementById('login-report')", timeout=90, interval=0.2)
            ch.evaluate("(() => { const u=document.querySelector('[data-testid=\"login-username\"]');"
                        " u.value='admin'; u.dispatchEvent(new Event('input',{bubbles:true}));"
                        " const p=document.querySelector('[data-testid=\"login-password\"]');"
                        " p.value='Admin2026lab'; p.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()")
            time.sleep(0.4)
            ch.evaluate("document.querySelector('[data-testid=\"login-submit\"]').click()")
            ch.wait_for("location.hash.includes('/chat')", timeout=120, interval=0.3)
            # ⚠️ 对话页是**能力门控**的：真后端 /capabilities 首屏 7–17s（之后 15s 内走缓存）→ 先等 caps
            ch.wait_for("!!document.querySelector('[data-testid=\"caps-bar\"] [data-cap=\"pi\"]')", timeout=300, interval=0.5)
            ch.wait_for("document.querySelector('[data-testid=\"ws-state\"]')?.textContent === 'open'", timeout=180, interval=0.3)

            # 发一句真 prompt（真模型 + 真检索）
            ch.evaluate("(() => { const t=document.querySelector('[data-testid=\"chat-input\"]');"
                        " t.value='聚簇索引是什么？'; t.dispatchEvent(new Event('input',{bubbles:true}));"
                        " setTimeout(() => document.querySelector('[data-testid=\"chat-send\"]').click(), 150); return 1 })()")
            ch.wait_for("!!document.querySelector('[data-testid=\"retrieval-badge\"]')", timeout=180, interval=0.3)
            badge = json.loads(ch.evaluate(
                "(() => { const b=document.querySelector('[data-testid=\\\"retrieval-badge\\\"]');"
                " return JSON.stringify({mode:b.dataset.mode, status:b.dataset.status, hits:b.dataset.hits,"
                " searched:b.dataset.searched, available:b.dataset.available, text:b.textContent.trim().slice(0,120)}) })()"))
            print('★ 真后端 retrieval 徽标：', json.dumps(badge, ensure_ascii=False))
            # 等这一轮结束：**要么出正文，要么如实报错**（真模型可能慢/失败，两种都算有结论）
            try:
                ch.wait_for("!!document.querySelector('[data-testid=\"assistant-text\"]') || !!document.querySelector('[data-testid=\"chat-error\"]')",
                            timeout=300, interval=0.5)
            except TimeoutError:
                print('  ⚠️ 300s 内既无正文也无错误（真模型仍在跑？）—— 徽标本条已通过，继续记录状态')
            note = ch.evaluate("JSON.stringify({ws:(document.querySelector('[data-testid=\"ws-state\"]')||{}).textContent,"
                               " err:(document.querySelector('[data-testid=\"chat-error\"]')||{}).textContent||'',"
                               " tools:(document.querySelector('[data-testid=\"session-tools\"]')||{}).dataset?.tools||''})")
            print('  会话状态：', note)
            time.sleep(2)
            tools = ch.evaluate("Array.from(document.querySelectorAll('[data-testid=\"retrieval-tool\"]')).map(e => e.dataset.tool)")
            print('  同轮工具徽标：', tools)
            ch.evaluate("document.querySelector('[data-testid=\"retrieval-why-toggle\"]')?.click()")
            time.sleep(0.5)
            why = ch.evaluate("Array.from(document.querySelectorAll('[data-testid=\"retrieval-why-line\"]')).map(e => e.textContent.trim())")
            print('  依据（why）：', json.dumps(why, ensure_ascii=False)[:300])
            text = ch.evaluate("(document.querySelector('[data-testid=\"assistant-text\"]')||{}).textContent||''")
            folded = ch.evaluate("(document.querySelector('[data-testid=\"tool-marker-folded\"]')||{}).textContent||''")
            print('  正文长度：', len(str(text)), '｜折叠提示：', str(folded)[:80] or '（无标记）')
            ok = badge.get('mode') in ('none', 'wiki', 'kg', 'rag') and badge.get('status') in ('none', 'ok', 'empty', 'unavailable', 'error')
            print(f"\n{'✓' if ok else '✗'} 徽标字段合法（mode={badge.get('mode')} status={badge.get('status')} hits={badge.get('hits')}）")
            return 0 if ok else 1
    finally:
        proxy.terminate()
        try:
            proxy.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proxy.kill()


if __name__ == '__main__':
    sys.exit(main())
