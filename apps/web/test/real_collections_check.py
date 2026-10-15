#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""真机只读验证（**零 LLM**）：collections 后端已实现 → UI 应显示目录/新建入口，**不是**"后端未实现"

判据（Lead 要求，按坑 37：**已登录 + 对照组**，不靠推断）：
  ① `GET /api/v1/collections`（带 cookie）→ **200**（对照 `GET /nonexistent-xyz` → 404）
  ② 视频页 `collections-note` **不含**"尚未实现"
  ③ 教师登录时 `collection-teacher-ops`（新建目录 + 上传入口）**存在**

用法：python test/real_collections_check.py [--backend http://127.0.0.1:8787] [--user teacher] [--password …]
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
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
    jar = CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def call(path: str, body=None, method='GET'):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f'{BACKEND}{path}', data=data, method=method,
                                     headers={'Content-Type': 'application/json'})
        try:
            with op.open(req, timeout=30) as r:
                return r.status, r.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode('utf-8', 'replace')[:200]

    st, _ = call('/api/v1/auth/login', {'username': USER, 'password': PW}, 'POST')
    print(f'login({USER}): {st}')
    if st != 200:
        print('✗ 登录失败（不继续）')
        return 2
    # ★ 坑 37：已登录下探"已知存在"与"确定不存在"的对照组
    st_ok, body_ok = call('/api/v1/collections')
    st_404, _ = call('/api/v1/nonexistent-xyz')
    print(f'GET /collections → {st_ok}: {body_ok[:160]}')
    print(f'GET /nonexistent-xyz → {st_404}（对照组）')
    exists = st_ok == 200 and st_404 == 404
    print(f'{"✓" if exists else "✗"} 对照组可区分（200 vs 404）→ 端点**真的存在**（不是靠推断）')

    chrome = find_chrome()
    if not chrome:
        print('✗ 找不到 Chrome')
        return 2
    pf = Path(tempfile.gettempdir()) / f'ckb-coll-{os.getpid()}.json'
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
            ch.navigate(f'{base}/#/login?next=/video', timeout=120)
            ch.wait_for("!!document.getElementById('login-report')", timeout=90, interval=0.3)
            ch.evaluate("(() => { const u=document.querySelector('[data-testid=\"login-username\"]');"
                        f" u.value={json.dumps(USER)}; u.dispatchEvent(new Event('input',{{bubbles:true}}));"
                        " const p=document.querySelector('[data-testid=\"login-password\"]');"
                        f" p.value={json.dumps(PW)}; p.dispatchEvent(new Event('input',{{bubbles:true}})); return 1 }})()")
            time.sleep(0.5)
            ch.evaluate("document.querySelector('[data-testid=\"login-submit\"]').click()")
            ch.wait_for("location.hash.includes('/video')", timeout=120, interval=0.3)
            ch.wait_for("!!document.querySelector('[data-testid=\"collections\"]')", timeout=120, interval=0.5)
            time.sleep(1.5)
            note = str(ch.evaluate("(document.querySelector('[data-testid=\"collections-note\"]')||{}).textContent || ''"))
            n_items = ch.evaluate('document.querySelectorAll(\'[data-testid="collection-item"]\').length')
            has_teacher = ch.evaluate("!!document.querySelector('[data-testid=\"collection-teacher-ops\"]')")
            has_create = ch.evaluate("!!document.querySelector('[data-testid=\"collection-create\"]')")
            has_upload = ch.evaluate("!!document.querySelector('[data-testid=\"collection-upload\"]')")
            print(f'视频页：目录项={n_items} · note="{note[:80]}" · 教师操作={has_teacher} · 新建={has_create} · 上传={has_upload}')
            ok_note = '尚未实现' not in note
            print(f'{"✓" if ok_note else "✗"} 不再显示"后端未实现"（collections 已实现）')
            print(f'{"✓" if (has_teacher and has_create and has_upload) else "✗"} 教师看到"新建目录 + 上传"入口')
            return 0 if (exists and ok_note and has_teacher and has_create and has_upload) else 1
    finally:
        proxy.terminate()
        try:
            proxy.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proxy.kill()


if __name__ == '__main__':
    sys.exit(main())
