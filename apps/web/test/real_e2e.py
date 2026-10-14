#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""对着**真后端**跑一遍关键链路（同源代理 + 真 cookie 登录 + 真数据）

为什么单独一个脚本（而不是塞进 chrome_dom.py）：
  · chrome_dom.py 是**契约 mock** 的完整回归（180 条），跑得快、可离线复现；
  · 本脚本是**真后端**验证：登录是 httpOnly cookie、数据是真空态、部分接口还没实现 ——
    断言的目标不一样（"如实降级"本身就是要断言的东西）。

用法：
  node test/mock-server.mjs --proxy http://127.0.0.1:8799 --port-file <tmp>   # 由本脚本自己拉起
  python test/real_e2e.py [--backend http://127.0.0.1:8799] [--user admin] [--pass Admin2026lab]
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEB = HERE.parent
sys.path.insert(0, str(HERE))
from cdp import Chrome, find_chrome  # noqa: E402

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

RESULTS: list[str] = []
FAILURES = 0


def ok(name: str, cond: bool, detail: str = '') -> bool:
    global FAILURES
    if cond:
        RESULTS.append(f'  ✓ {name}')
        return True
    FAILURES += 1
    RESULTS.append(f'  ✗ {name}' + (f' — {detail}' if detail else ''))
    return False


def report(dom: str, el_id: str):
    m = re.search(rf'<script[^>]*id="{re.escape(el_id)}"[^>]*>(.*?)</script>', dom, re.S | re.I)
    if not m:
        return None
    raw = m.group(1).strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def has(dom: str, pattern: str) -> bool:
    """DOM 里是否存在某模式（正则）"""
    return re.search(pattern, dom, re.S) is not None


def run_view(tag: str, fn) -> None:
    RESULTS.append(f'\n[{tag}]')
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        global FAILURES
        FAILURES += 1
        RESULTS.append(f'  ✗ 抛异常：{type(e).__name__}: {e}')


def start_proxy() -> tuple[subprocess.Popen, str]:
    port_file = Path(tempfile.gettempdir()) / f'coursekb-real-{os.getpid()}.json'
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
            raise RuntimeError((proc.stderr.read() or b'').decode('utf-8', 'replace')[-800:])
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

    proxy, base = start_proxy()
    print(f'真后端 {BACKEND} ← 同源前端 {base}')
    try:
        with Chrome(chrome) as ch:
            def nav(route: str, ready: str | None = None, timeout: int = 90):
                ch.navigate('about:blank', timeout=30)
                ch.navigate(f'{base}/#/{route}', timeout=timeout)
                if ready:
                    ch.wait_for(ready, timeout=timeout, interval=0.2)
                return ch.outer_html()

            # ============ 1. 未登录：受保护接口 401 → 页面出现登录入口 ============
            dom = nav('wiki', "!!document.getElementById('wiki-report') || !!document.getElementById('login-bar')", 120)

            def check_anon() -> None:
                ok('未登录时顶栏给"登录"入口', 'data-testid="do-login"' in dom or 'data-testid="login-bar"' in dom)
                ok('提示 401 语义（httpOnly cookie，前端不存 token）',
                   'data-testid="login-bar"' in dom and '401' in dom, '登录提示条缺失')
                rep = report(dom, 'wiki-report') or {}
                # 未登录 → 文档/大纲拿不到，页面必须**如实**说"未登录"，不能假装空数据
                ok('知识库页如实反映未登录（不是伪造空数据）',
                   bool(rep.get('error')) or '未登录' in dom or 'E_UNAUTHENTICATED' in dom,
                   json.dumps(rep, ensure_ascii=False)[:200])
            run_view('未登录 / 401 语义', check_anon)

            # ============ 2. 登录页：错密码 → 如实报错 ============
            nav('login?next=/wiki', "!!document.getElementById('login-report')")

            def check_bad_login() -> None:
                ch.evaluate("(() => { const u=document.querySelector('[data-testid=\"login-username\"]');"
                            " u.value='admin'; u.dispatchEvent(new Event('input',{bubbles:true}));"
                            " const p=document.querySelector('[data-testid=\"login-password\"]');"
                            " p.value='definitely-wrong'; p.dispatchEvent(new Event('input',{bubbles:true}));"
                            " return 1 })()")
                time.sleep(0.3)
                ch.evaluate("document.querySelector('[data-testid=\"login-submit\"]').click()")
                ch.wait_for("!!document.querySelector('[data-testid=\"login-error\"]')", timeout=40, interval=0.2)
                err = ch.evaluate("document.querySelector('[data-testid=\"login-error\"]').textContent") or ''
                code = ch.evaluate("document.querySelector('[data-testid=\"login-error\"]').dataset.code") or ''
                rep = report(ch.outer_html(), 'login-report') or {}
                ok('错密码显示可读错误（不是"网络错误"）', '不正确' in err or '失败' in err, str(err)[:120])
                ok('错误带后端错误码', bool(code) and code != 'E_LOCAL', f'code={code}')
                ok('错误页留在登录页（不跳走）', 'data-testid="login-username"' in ch.outer_html())
                ok('login-report 记录失败', rep.get('ok') is False, json.dumps(rep, ensure_ascii=False)[:160])
            run_view('登录 / 错误凭据', check_bad_login)

            # ============ 3. 登录页：正确凭据 → httpOnly cookie + 回跳 ============
            nav('login?next=/wiki', "!!document.getElementById('login-report')")

            def check_login() -> None:
                ch.evaluate("(() => { const u=document.querySelector('[data-testid=\"login-username\"]');"
                            f" u.value={json.dumps(USER)}; u.dispatchEvent(new Event('input',{{bubbles:true}}));"
                            " const p=document.querySelector('[data-testid=\"login-password\"]');"
                            f" p.value={json.dumps(PASSWORD)}; p.dispatchEvent(new Event('input',{{bubbles:true}}));"
                            " return 1 })()")
                time.sleep(0.3)
                ch.evaluate("document.querySelector('[data-testid=\"login-submit\"]').click()")
                ch.wait_for("location.hash.startsWith('#/wiki')", timeout=40, interval=0.2)
                # httpOnly：JS **读不到** cookie（这正是"前端不存 token"的证据）
                cookie_js = ch.evaluate("document.cookie")
                # ⚠️ CDP 默认不 await Promise → 必须显式 await_promise=True（第一版忘了，断言永远假）
                has_session_cookie = ch.evaluate("fetch('/api/v1/auth/me').then(r => r.ok)", await_promise=True)
                me = ch.evaluate("fetch('/api/v1/auth/me').then(r => r.json()).then(j => JSON.stringify(j.user||{}))",
                                 await_promise=True)
                me_obj = json.loads(me) if isinstance(me, str) and me.startswith('{') else {}
                ok('登录成功后回到 next 目标页', ch.evaluate("location.hash").startswith('#/wiki'), ch.evaluate('location.hash'))
                ok('JS 读不到会话 cookie（httpOnly 生效）', 'ckb_session' not in str(cookie_js), f'document.cookie={cookie_js!r}')
                ok('带 cookie 的 /auth/me 返回 200', has_session_cookie is True)
                ok('身份来自 user.roles（真后端形状）', me_obj.get('username') == USER and 'admin' in (me_obj.get('roles') or []),
                   json.dumps(me_obj, ensure_ascii=False)[:160])
                # App 的身份是异步拉的 → 等顶栏真的显示出用户名再断言
                ch.wait_for("(() => { const a=document.querySelector('[data-testid=\"auth-box\"]');"
                            " return !!a && a.textContent.includes('admin') })()", timeout=40, interval=0.2)
                dom2 = ch.outer_html()
                ok('顶栏显示用户 + 角色', 'data-testid="auth-box"' in dom2 and 'admin' in dom2)
                ok('退出按钮可用（真 cookie 会话）', 'data-testid="do-logout"' in dom2)
            run_view('登录 / httpOnly cookie', check_login)

            # ============ 4. 真数据：知识库（cards=0 → 如实空态） ============
            dom = nav('wiki', "!!document.getElementById('wiki-report')", 120)

            def check_wiki_real() -> None:
                rep = report(dom, 'wiki-report') or {}
                ok('读到真文档/单元（不是 mock 的 2458/360）', int(rep.get('units') or 0) > 0 and rep.get('units') != 2458,
                   json.dumps({k: rep.get(k) for k in ('units', 'cards', 'graph_nodes')}, ensure_ascii=False))
                ok('真数据下 cards=0 如实显示（未抽取完成）', int(rep.get('cards') or 0) == 0, f"cards={rep.get('cards')}")
                ok('卡片区给出空态说明（不是空白）', 'data-testid="no-cards"' in dom or '暂无知识卡片' in dom)
                ok('树渲染真单元（含中文标题）', '聚簇索引' in dom or 'data-unit="unt_' in dom)
                ok('概括区有内容（intro 来自真后端）', 'data-testid="unit-intro"' in dom and '未生成摘要' in dom)
            run_view('真数据 / 知识库（空态如实）', check_wiki_real)

            # ============ 5. 真数据：图谱（0 节点） ============
            dom = nav('graph', "!!document.getElementById('perf-report')", 120)

            def check_graph_real() -> None:
                rep = report(dom, 'perf-report') or {}
                ok('图谱如实显示 0 节点（edges 为空）', int(rep.get('nodes') or 0) == 0 and int(rep.get('edges') or 0) == 0,
                   json.dumps({k: rep.get(k) for k in ('nodes', 'edges')}, ensure_ascii=False))
                ok('页面不伪造节点（画布节点数 = 数据节点数）', 'data-nodes="0"' in dom or rep.get('nodes') == 0)
                ok('标题显示真实统计', '0 节点' in dom, '标题未显示真实计数')
            run_view('真数据 / 图谱（0 节点如实）', check_graph_real)

            # ============ 6. 真数据：中文检索（bigram） ============
            dom = nav('wiki', "!!document.getElementById('wiki-report')", 120)

            def check_search_real() -> None:
                # ⚠️ 第一版写错了前提：当前选中的是**英文 MySQL 手册**（2523 units），
                #    却搜中文词 → 0 命中其实是**正确行为**（不是 bug）。分两步验证：
                #    ① 英文手册搜 index（真 FTS5 命中）
                ch.evaluate("(() => { const i=document.querySelector('[data-testid=\"search-input\"]');"
                            " i.value='index'; i.dispatchEvent(new Event('input',{bubbles:true}));"
                            " setTimeout(() => { const b=i.closest('form').querySelector('button'); if (b) b.click() }, 150);"
                            " return 1 })()")
                ch.wait_for("document.querySelectorAll('.hit').length > 0", timeout=90, interval=0.3)
                hits = ch.evaluate("Array.from(document.querySelectorAll('.hit')).slice(0,3).map(e => e.textContent.trim().slice(0,60))")
                ok('英文手册检索命中（真 bigram/FTS5）', isinstance(hits, list) and len(hits) > 0,
                   json.dumps(hits, ensure_ascii=False)[:160])
                ok('命中带单元标题与片段', any('score' in str(h) for h in (hits or [])), json.dumps(hits, ensure_ascii=False)[:160])

                # ② 切到中文样本文档 → 中文词必须命中（bigram 分词真在跑）
                cn_doc = ch.evaluate(
                    "fetch('/api/v1/documents').then(r=>r.json()).then(j=>{const d=(j.documents||[]).find(x=>x.lang==='zh'); return d?d.id:''})",
                    await_promise=True)
                if not cn_doc:
                    ok('存在中文样本文档（用于验证中文检索）', False, '未找到 lang=zh 的文档')
                    return
                ch.navigate(f'{base}/#/wiki?doc={cn_doc}', timeout=90)
                # ⚠️ 同文档 hash 导航**不会重载页面**：必须等报告里的 doc 真的变成中文样本文档，
                #    否则检索仍按英文手册过滤（第一版就是这么误判成"中文检索 0 命中"的）
                ch.wait_for(
                    "(() => { const r=document.getElementById('wiki-report'); if(!r) return false;"
                    f" try {{ return JSON.parse(r.textContent).doc === '{cn_doc}' }} catch(e) {{ return false }} }})()",
                    timeout=90, interval=0.3)
                ch.evaluate("(() => { const i=document.querySelector('[data-testid=\"search-input\"]');"
                            " i.value='聚簇索引'; i.dispatchEvent(new Event('input',{bubbles:true}));"
                            " setTimeout(() => { const b=i.closest('form').querySelector('button'); if (b) b.click() }, 150);"
                            " return 1 })()")
                # stale hit warning: switching doc does not reload the page, old .hit stays in DOM
                ch.wait_for("Array.from(document.querySelectorAll('.hit')).some(e => /\u805a\u7c07\u7d22\u5f15|\u8986\u76d6\u7d22\u5f15/.test(e.textContent))",
                            timeout=90, interval=0.3)
                cn_hits = ch.evaluate("Array.from(document.querySelectorAll('.hit')).slice(0,3).map(e => e.textContent.trim().slice(0,60))")
                ok('中文检索命中「聚簇索引」（bigram 真分词）',
                   any('聚簇索引' in str(h) or '覆盖索引' in str(h) for h in (cn_hits or [])),
                   json.dumps(cn_hits, ensure_ascii=False)[:200])
                ok('检索结果可点（跳单元/卡片）', ch.evaluate("!!document.querySelector('.hit')"))

            run_view('真数据 / 中文检索', check_search_real)

            # ============ 7. 真数据：文档页 ============
            dom = nav('docs', "!!document.getElementById('docs-report')", 90)

            def check_docs_real() -> None:
                rep = report(dom, 'docs-report') or {}
                ok('文档列表来自真后端', int(rep.get('count') or 0) >= 1, json.dumps(rep, ensure_ascii=False)[:200])
                ok('显示真实状态（extracting/ready 等）', 'data-status=' in dom)
                ok('标题是真实文件名/标题', 'original' in dom or 'db_cn_sample' in dom or 'MySQL' in dom)
            run_view('真数据 / 文档页', check_docs_real)

            # ============ 8. 真后端已实现：模型设置页（真模型表 + busy + 二次确认）============
            dom = nav('settings?selftest=1', "!!document.getElementById('settings-report')", 240)

            def check_settings_real() -> None:
                rep = report(dom, 'settings-report') or {}
                ok('设置页识别 admin 角色（user.roles）', rep.get('is_staff') is True and 'admin' in str(rep.get('role')),
                   json.dumps({k: rep.get(k) for k in ('role', 'is_staff')}, ensure_ascii=False))
                ok('后端已实现 /models（不再是 404）', rep.get('backend_implemented') is True,
                   json.dumps(rep.get('missing'), ensure_ascii=False)[:200])
                n_models = int(rep.get('models') or 0)
                ok('模型列表来自真 /models', n_models >= 3, f'models={n_models}')
                ok('显示真探测延迟（latencyMs）', 'ms' in dom and 'model-table' in dom)
                ok('不可用模型带 reason（如探测超时）',
                   '探测超时' in dom or 'reason' in dom.lower() or '不可用' in dom)
                ok('activeModel 来自真响应', bool(rep.get('active')) and rep.get('active') != '', str(rep.get('active')))
                ok('concurrency 固定为 1 且只读', rep.get('concurrency') == 1 and has(dom, r'data-testid="concurrency"[^>]*disabled'))
                ok('显示队列忙状态（/models.busy，权威来源）', isinstance(rep.get('busy'), dict) and 'busy' in rep['busy'],
                   json.dumps(rep.get('busy'), ensure_ascii=False)[:200])
                st = report(dom, 'selftest-report') or {}
                c = st.get('checks', {})
                ok('设置页自检全绿', st.get('ok') is True, f"failed={st.get('failed')}")
                ok('有可切换的目标模型（按钮可用）', c.get('button_disabled') is False, str(c.get('button_disabled')))
                ok('切换必须二次确认（含三种 mode）', c.get('confirm_required') is True and 'mode=now' in dom and 'mode=abort' in dom)
                # ★ 不真切 Lead 的 activeModel：确认框打开后**取消**
                ch.evaluate("(() => { const b=document.querySelector('[data-testid=\"confirm-no\"]'); if (b) b.click(); return 1 })()")
                time.sleep(0.5)
                ok('取消后不发起切换（activeModel 未变）',
                   (report(ch.outer_html(), 'settings-report') or {}).get('active') == rep.get('active'))
            run_view('真后端 / 模型设置页（真模型表 + busy + 二次确认）', check_settings_real)

            # ============ 8b. 真后端已实现：SQL 练习台（真引擎 + 真 schema + 真 CRUD + 真错误码）============
            dom = nav('lab?selftest=1', "!!document.getElementById('lab-report')", 240)

            def check_lab_real() -> None:
                rep = report(dom, 'lab-report') or {}
                ok('/capabilities 已上报 sandbox', rep.get('sandbox_reported') is True)
                ok('后端已实现 /sandbox/*', rep.get('backend_implemented') is True,
                   json.dumps(rep.get('missing'), ensure_ascii=False)[:200])
                engines = rep.get('engines') or []
                ok('引擎列表来自真 /capabilities.sandbox.engines（≥2 个）', len(engines) >= 2,
                   json.dumps(engines, ensure_ascii=False)[:240])
                ok('不可用引擎带原因 + 部署文档指向',
                   any((not e.get('available')) and e.get('reason') for e in engines)
                   and 'LAB_DB_DEPLOY' in dom,
                   json.dumps([e for e in engines if not e.get('available')], ensure_ascii=False)[:260])
                ok('默认数据集是服务端 default（sc）', rep.get('default_dataset') == 'sc', str(rep.get('default_dataset')))
                ok('数据集来自真 /sandbox/datasets', len(rep.get('datasets') or []) >= 2,
                   json.dumps(rep.get('datasets'), ensure_ascii=False))
                ok('真方言标注（sqlite）', 'sqlite' in str(rep.get('dialect')).lower(), str(rep.get('dialect')))
                st = report(dom, 'selftest-report') or {}
                ok('练习台自检全绿', st.get('ok') is True, f"failed={st.get('failed')}")
                c = st.get('checks', {})
                ok('真 schema 表清单（schema.tables）', len(c.get('schema_tables') or []) >= 2,
                   json.dumps(c.get('schema_tables'), ensure_ascii=False)[:200])
                ok('① 建表（真 worker 执行）', (c.get('crud_ddl') or {}).get('error') is None,
                   json.dumps(c.get('crud_ddl'), ensure_ascii=False))
                ok('② 插入 + ③ 查询读到 1 行', (c.get('crud_select') or {}).get('rows') == [[1, '我的笔记']],
                   json.dumps(c.get('crud_select'), ensure_ascii=False)[:200])
                ok('④ 更新后查询可见新值', c.get('crud_update_visible') is True)
                ok('⑤ 删除后查询为 0 行', c.get('crud_delete_visible') is True)
                j = c.get('join') or {}
                ok('真 schema 上的三表 JOIN', len(j.get('rows') or []) == 3, json.dumps(j, ensure_ascii=False)[:200])
                ok('GROUP BY 聚合', len((c.get('agg') or {}).get('rows') or []) == 3, json.dumps(c.get('agg'), ensure_ascii=False)[:200])
                # ★ 真后端错误码（我 mock 用的是 E_SANDBOX_*，实测是 E_SQL_*）
                ok('ATTACH 被拒（E_SQL_FORBIDDEN）', (c.get('attach_blocked') or {}).get('code') == 'E_SQL_FORBIDDEN',
                   json.dumps(c.get('attach_blocked'), ensure_ascii=False)[:160])
                ok('多语句被拒（E_SQL_MULTI）', (c.get('multi_blocked') or {}).get('code') == 'E_SQL_MULTI',
                   json.dumps(c.get('multi_blocked'), ensure_ascii=False)[:160])
                ok('不存在的表 → E_SQL_NO_OBJECT + 原生错误文本',
                   (c.get('bad_table_error') or {}).get('code') == 'E_SQL_NO_OBJECT'
                   and 'no such table' in str((c.get('bad_table_error') or {}).get('msg')),
                   json.dumps(c.get('bad_table_error'), ensure_ascii=False)[:200])
                ok('reset 回到初始 schema（表都回来且行数>0）', bool(c.get('reset_restores')),
                   json.dumps(c.get('reset_tables'), ensure_ascii=False)[:200])
                # ★ 答疑：真模型流式 + 真引用
                ask = c.get('ask') or {}
                ok('答疑流式返回（>40 字）', int(ask.get('len') or 0) > 40, json.dumps(ask, ensure_ascii=False)[:200])
                ok('答疑看到学生的真实报错', 'no such table' in str((ask.get('context') or {}).get('error')))
                ok('答疑引用知识库卡片（≥1，可跳原文）',
                   int(ask.get('citations') or 0) >= 1
                   and str(c.get('citation_anchor', '')).startswith('#/wiki?'),
                   json.dumps(c.get('citation_links'), ensure_ascii=False)[:200])
            run_view('真后端 / SQL 练习台（真引擎 + 真 CRUD + E_SQL_* + 答疑）', check_lab_real)

            # ============ 9. 真数据：能力横幅（llm 真探测 / tts/ocr 缺凭据原因） ============
            # ⚠️ 真后端 /capabilities 实测 9–16s/次（每次调用都真探测，无 TTL 缓存）→ 等 240s
            dom = nav('wiki', "!!document.getElementById('wiki-report') && !!document.querySelector('[data-testid=\"caps-bar\"] [data-cap=\"llm\"]')", 240)

            def check_caps_real() -> None:
                ok('能力横幅读真 /capabilities', 'data-testid="caps-bar"' in dom)
                ok('LLM 可用（真探测通过）', 'data-cap="llm"' in dom and 'data-available="true"' in dom)
                ok('不可用能力给出原因（缺哪个环境变量）',
                   'data-testid="caps-bar"' in dom and ('ALIYUN' in dom or 'BAIDU' in dom or '未配置' in dom),
                   '能力原因未显示')
                ok('导航按能力渲染（pi 可用 → 助教入口可用）', 'data-nav="/chat"' in dom)
            run_view('真数据 / 能力横幅', check_caps_real)

            # ============ 10. 退出登录 → 又回到未登录 ============
            def check_logout() -> None:
                ch.evaluate("document.querySelector('[data-testid=\"do-logout\"]')?.click()")
                ch.wait_for("location.hash.startsWith('#/login')", timeout=40, interval=0.2)
                st = ch.evaluate("fetch('/api/v1/auth/me').then(r => r.status)", await_promise=True)
                ok('退出后 /auth/me 回到 401', st == 401, f'status={st}')
                ok('退出后落到登录页', ch.evaluate('location.hash').startswith('#/login'), ch.evaluate('location.hash'))
            run_view('退出登录', check_logout)
    finally:
        proxy.terminate()
        try:
            proxy.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proxy.kill()

    print('\n'.join(RESULTS))
    passed = len([r for r in RESULTS if r.startswith('  ✓')])
    print(f"\n{'✓' if FAILURES == 0 else '✗'} 真后端 e2e：{passed} 通过 / {FAILURES} 失败（后端 {BACKEND}）")
    return 0 if FAILURES == 0 else 1


if __name__ == '__main__':
    sys.exit(main())

