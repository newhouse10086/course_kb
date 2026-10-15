#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""真机验证：**视频助手（`?assistant=video`）是否真的按渲染契约输出**

★ 只用 `deepseek-v4.1-flash`（用户硬要求：kimi 太贵）：
  · 起**隔离实例**（独立 dataDir/db/settings，绝不与 Lead 的 8787 共用）
  · 启动前**断言** settings.json 的 `llm.active === 'deepseek-v4.1-flash'` 且 fallbacks 里没有 kimi
  · **只发 1 轮**（1 次 LLM 调用）—— 跑完在报告里写明模型与调用次数

四条判据（objective，不靠肉眼）：
  ① 帧/正文里用 `$…$` / `$$…$$`（不是 `\\(…\\)`）→ 渲染后 DOM 有 `.katex`
  ② 代码块**标了语言**且**闭合**（`data-lang` 非空、`data-unclosed=0`）
  ③ 渲染后 DOM 里 `.katex` 数量 > 0
  ④ 服务端事后审计 `render_format_ok`（若可取到 audit 接口）

用法：python test/real_video_assistant.py [--port 8799]
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEB = HERE.parent
REPO = WEB.parent.parent          # course-kb/
sys.path.insert(0, str(HERE))
from cdp import Chrome, find_chrome  # noqa: E402

PORT = 8801   # ⚠️ 8799 已被别人的实例占用（node src/index.ts, 14:38 启动）→ 用 8801，不动别人的
for i, a in enumerate(sys.argv):
    if a == '--port' and i + 1 < len(sys.argv):
        PORT = int(sys.argv[i + 1])
WANT_MODEL = 'deepseek-v4.1-flash'
CHEAP_FALLBACKS_OK = ('deepseek', 'glm')     # 兜底链里**不许**出现 kimi
QUESTION = '请用一段话讲清楚 B+ 树节点分裂的代价，带一个公式和一段 SQL 示例。'


def log(msg: str) -> None:
    print(msg, flush=True)


def check_settings(path: Path) -> tuple[bool, str]:
    """★ 启动前断言：active 必须是便宜的 flash，兜底链不许含 kimi"""
    try:
        j = json.loads(path.read_text(encoding='utf-8'))
    except Exception as e:
        return False, f'读不到 settings：{e}'
    llm = j.get('llm') or {}
    active = str(llm.get('active') or '')
    fbs = [str(x) for x in (llm.get('fallbacks') or [])]
    bad = [x for x in [active] + fbs if 'kimi' in x.lower()]
    if active != WANT_MODEL:
        return False, f'active={active!r} ≠ {WANT_MODEL!r}（**不要自己改，报 Lead**）'
    if bad:
        return False, f'兜底链/主模型里出现 kimi：{bad}（会烧钱）'
    if not all(any(x.startswith(p) for p in CHEAP_FALLBACKS_OK) for x in fbs):
        return False, f'兜底链里有非便宜模型：{fbs}'
    return True, f'active={active} · fallbacks={fbs}'


def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    settings_src = REPO / 'config' / 'settings.json'
    ok, why = check_settings(settings_src)
    log(f'{"✓" if ok else "✗"} 模型配置核对：{why}')
    if not ok:
        log('→ 不跑（按 Lead 要求：发现 active 不对就报他，不自己改）')
        return 2

    chrome = find_chrome()
    if not chrome:
        log('✗ 找不到 Chrome')
        return 2

    tmp = Path(tempfile.mkdtemp(prefix='ckb-video-verify-'))
    (tmp / 'settings.json').write_text(settings_src.read_text(encoding='utf-8'), encoding='utf-8')
    data = tmp / 'data'
    data.mkdir()
    env = {
        **os.environ,
        'COURSE_KB_DATA_DIR': str(data),
        'COURSE_KB_DB': str(data / 't.sqlite3'),
        'COURSE_KB_SETTINGS_FILE': str(tmp / 'settings.json'),
        'COURSE_KB_PORT': str(PORT),
    }
    log(f'隔离实例：data={data} · settings={tmp / "settings.json"} · port={PORT}')
    server = subprocess.Popen(['npm', 'start'], cwd=str(REPO / 'apps' / 'server'), env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, shell=True)
    proxy = None
    calls = 0
    try:
        # 等健康检查
        import urllib.request
        for _ in range(120):
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/api/v1/health', timeout=3) as r:
                    log('✓ 实例就绪：' + r.read().decode('utf-8')[:120])
                    break
            except Exception:
                time.sleep(1)
        else:
            log('✗ 实例没起来')
            return 2

        pf = tmp / 'ports.json'
        proxy = subprocess.Popen(['node', str(HERE / 'mock-server.mjs'), '--proxy', f'http://127.0.0.1:{PORT}',
                                  '--port-file', str(pf)], cwd=str(WEB),
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for _ in range(200):
            if pf.exists():
                break
            time.sleep(0.2)
        base = f"http://127.0.0.1:{json.loads(pf.read_text(encoding='utf-8'))['real']}"
        log(f'同源代理：{base}')

        with Chrome(chrome) as ch:
            ch.navigate(f'{base}/#/login?next=/video', timeout=180)
            ch.wait_for("!!document.getElementById('login-report')", timeout=120, interval=0.3)
            ch.evaluate("(() => { const u=document.querySelector('[data-testid=\"login-username\"]');"
                        " u.value='admin'; u.dispatchEvent(new Event('input',{bubbles:true}));"
                        " const p=document.querySelector('[data-testid=\"login-password\"]');"
                        " p.value='Admin2026lab'; p.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()")
            time.sleep(0.5)
            ch.evaluate("document.querySelector('[data-testid=\"login-submit\"]').click()")
            ch.wait_for("location.hash.includes('/video')", timeout=180, interval=0.3)
            ch.wait_for("!!document.querySelector('[data-testid=\"assistant-fab\"]')", timeout=180, interval=0.5)
            # 打开抽屉（视频页 → assistant=video）
            for _ in range(3):
                ch.evaluate("document.querySelector('[data-testid=\"assistant-fab\"]').click()")
                time.sleep(1.0)
                if ch.evaluate("!!document.querySelector('[data-testid=\"assistant-drawer\"]')"):
                    break
            ch.wait_for("document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"ws-state\"]')?.textContent === 'open'",
                        timeout=300, interval=0.5)
            entry = ch.evaluate("(document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"assistant-entry\"]')||{}).dataset?.entry || ''")
            model = ch.evaluate("(() => { const p=Array.from(document.querySelectorAll('[data-testid=\"assistant-drawer\"] .pill'));"
                                " const m=p.map(x=>x.textContent).find(t=>t && /flash|glm|kimi|gpt|claude/i.test(t)); return m || '' })()")
            log(f'入口={entry} · 会话模型={model}')

            # ★ 只发一轮（1 次 LLM 调用）
            ch.evaluate("(() => { const d=document.querySelector('[data-testid=\"assistant-drawer\"]');"
                        f" const t=d.querySelector('[data-testid=\"chat-input\"]'); t.value={json.dumps(QUESTION)};"
                        " t.dispatchEvent(new Event('input',{bubbles:true}));"
                        " setTimeout(()=>d.querySelector('[data-testid=\"chat-send\"]').click(),150); return 1 })()")
            calls += 1
            log('已发送 1 轮（LLM 调用 #1）…')
            try:
                ch.wait_for("!!document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"assistant-text\"]')",
                            timeout=600, interval=0.5)
            except Exception:
                log('⚠️ 10 分钟内没有正文（可能上游慢/失败）—— 记录错误帧')
            time.sleep(3)
            stats = json.loads(ch.evaluate(
                "(() => { const d=document.querySelector('[data-testid=\"assistant-drawer\"]');"
                " const r=d.querySelector('[data-testid=\"assistant-text\"] [data-testid=\"rich-text\"]');"
                " const codes=Array.from(d.querySelectorAll('[data-testid=\"code-block\"]'));"
                " const err=(d.querySelector('[data-testid=\"chat-error\"]')||{}).textContent||'';"
                " return JSON.stringify({math:r?r.dataset.math:'0', fail:r?r.dataset.mathFail:'0',"
                " code:codes.length, langs:codes.map(c=>c.dataset.lang), unclosed:codes.map(c=>c.dataset.unclosed),"
                " katex:d.querySelectorAll('.katex').length, err:err.slice(0,200),"
                " text:(d.querySelector('[data-testid=\"assistant-text\"]')||{}).textContent?.slice(0,400)||''}) })()"))
            raw = str(ch.evaluate("(document.querySelector('[data-testid=\"assistant-drawer\"] [data-testid=\"assistant-text\"]')||{}).textContent||''"))
            log('— 判据 —')
            c1 = int(stats['math']) > 0 and '\\(' not in raw[:2000]
            c3 = int(stats['katex']) > 0
            c2 = bool(stats['code']) and all(l for l in stats['langs']) and all(u == '0' for u in stats['unclosed'])
            log(f"① 用 $…$（不是 \\(…\\)）: math={stats['math']} fail={stats['fail']} → {'✓' if c1 else '✗'}")
            log(f"② 代码块标语言且闭合: code={stats['code']} langs={stats['langs']} unclosed={stats['unclosed']} → {'✓' if c2 else '✗'}")
            log(f"③ DOM 里 .katex 数量: {stats['katex']} → {'✓' if c3 else '✗'}")
            if stats['err']:
                log(f"⚠️ 页面错误帧：{stats['err']}")
            log('正文前 400 字：' + str(stats['text'])[:400].replace('\n', ' ⏎ '))
            log(f"\n模型：{model or '（会话头未显示，见 ready.model）'} · LLM 调用次数：{calls}")
            return 0 if (c1 and c2 and c3) else 1
    finally:
        for p in (proxy, server):
            if p:
                p.terminate()
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    p.kill()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
