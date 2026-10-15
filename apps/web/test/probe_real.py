#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""真后端契约探针（只读为主）：把真实响应形状打出来，和我写的 mock 逐项对比。

用法：python test/probe_real.py [base] [--mutate]
默认 base=http://127.0.0.1:8799（我自己起的实例）；--mutate 才会真的调 switch/execute 等写接口。
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

BASE = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else 'http://127.0.0.1:8799'
MUTATE = '--mutate' in sys.argv

jar = CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(method: str, path: str, body=None, timeout: int = 60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json', 'Accept': 'application/json'})
    try:
        with opener.open(req, timeout=timeout) as r:
            raw = r.read().decode('utf-8', 'replace')
            return r.status, (json.loads(raw) if raw.strip().startswith(('{', '[')) else raw), dict(r.headers)
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(raw), dict(e.headers)
        except json.JSONDecodeError:
            return e.code, raw, dict(e.headers)
    except Exception as e:  # noqa: BLE001
        return 0, f'{type(e).__name__}: {e}', {}


def show(label: str, status, body, limit: int = 900):
    if isinstance(body, (dict, list)):
        text = json.dumps(body, ensure_ascii=False)
    else:
        text = str(body)
    print(f'\n### {label}  [HTTP {status}]')
    print('   ' + text[:limit] + ('…' if len(text) > limit else ''))


def keys_of(obj, path: str = ''):
    if isinstance(obj, dict):
        out = []
        for k, v in obj.items():
            out.append(f'{path}{k}:{type(v).__name__}')
        return out
    if isinstance(obj, list) and obj:
        return [f'{path}[0]'] + keys_of(obj[0], path + '[0].')
    return []


def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    print(f'== 探针目标 {BASE}（mutate={MUTATE}）==')

    show('GET /health', *call('GET', '/api/v1/health')[:2])
    st, caps, _ = call('GET', '/api/v1/capabilities')
    show('GET /capabilities', st, caps)
    if isinstance(caps, dict):
        print('   顶层键：', list(caps.keys()))
        print('   providers 键：', list((caps.get('providers') or {}).keys()))
        print('   auth：', json.dumps(caps.get('auth'), ensure_ascii=False))
        print('   sandbox：', json.dumps(caps.get('sandbox'), ensure_ascii=False)[:500])
        print('   pi：', json.dumps(caps.get('pi'), ensure_ascii=False)[:300])
        print('   retrieval：', json.dumps(caps.get('retrieval'), ensure_ascii=False)[:300])

    # ---- 未登录访问受保护接口 ----
    show('GET /documents（未登录，期望 401）', *call('GET', '/api/v1/documents')[:2], limit=300)
    show('GET /auth/me（未登录）', *call('GET', '/api/v1/auth/me')[:2], limit=300)

    # ---- 登录 ----
    st, body, headers = call('POST', '/api/v1/auth/login', {'username': 'admin', 'password': 'Admin2026lab'})
    show('POST /auth/login', st, body)
    print('   Set-Cookie：', headers.get('Set-Cookie', '(none)')[:200])
    print('   cookie jar：', [(c.name, c.path, 'HttpOnly' if c.has_nonstandard_attr('HttpOnly') else '-') for c in jar])
    show('GET /auth/me（登录后）', *call('GET', '/api/v1/auth/me')[:2])

    show('GET /documents', *call('GET', '/api/v1/documents')[:2], limit=500)

    # ---- 我新做的两页要的接口 ----
    show('GET /models', *call('GET', '/api/v1/models')[:2])
    show('GET /settings', *call('GET', '/api/v1/settings')[:2])

    st, docs, _ = call('GET', '/api/v1/documents')
    doc_id = None
    if isinstance(docs, dict):
        items = docs.get('documents') or docs.get('items') or []
        if items:
            doc_id = items[0].get('id')
    if doc_id:
        show(f'GET /documents/{doc_id}/outline（根数）', 200, {
            'roots': len((call('GET', f'/api/v1/documents/{doc_id}/outline')[1] or {}).get('roots', [])),
            'nodes': len((call('GET', f'/api/v1/documents/{doc_id}/outline')[1] or {}).get('nodes', {})),
        }, limit=300)
        show(f'GET /documents/{doc_id}/cards', *call('GET', f'/api/v1/documents/{doc_id}/cards?limit=5')[:2], limit=400)
        show(f'GET /documents/{doc_id}/graph', *call('GET', f'/api/v1/documents/{doc_id}/graph')[:2], limit=400)

    # ---- 沙箱 ----
    show('GET /sandbox/datasets', *call('GET', '/api/v1/sandbox/datasets')[:2], limit=600)
    st, sess, _ = call('POST', '/api/v1/sandbox/session', {'dataset': 'student-course'})
    show('POST /sandbox/session', st, sess, limit=600)
    sid = sess.get('sessionId') if isinstance(sess, dict) else None
    if MUTATE and sid:
        for sql in ['SELECT * FROM student LIMIT 2',
                    "INSERT INTO student (sno,sname,ssex,sage,sdept) VALUES ('2021099','探针','女',20,'计算机系')",
                    'SELECT COUNT(*) FROM student',
                    "DELETE FROM student WHERE sno = '2021099'",
                    'SELECT * FROM no_such_table',
                    "ATTACH DATABASE 'x.db' AS x",
                    'SELECT 1; DROP TABLE student']:
            st, r, _ = call('POST', '/api/v1/sandbox/execute', {'sessionId': sid, 'sql': sql})
            err = (r or {}).get('error') if isinstance(r, dict) else r
            print(f'   exec[{sql[:40]:<40}] → {st} err={json.dumps(err, ensure_ascii=False)[:90]} rows={(r or {}).get("rowCount") if isinstance(r, dict) else "?"}')
        show('POST /sandbox/reset', *call('POST', '/api/v1/sandbox/reset', {})[:2], limit=300)

    # ---- 模型热切换（只在 --mutate 下真调） ----
    if MUTATE:
        st, r, _ = call('POST', '/api/v1/settings/llm/switch', {'model': 'glm-5.3', 'mode': 'now'})
        show('POST /settings/llm/switch mode=now（有运行中任务时期望 409）', st, r)
        st, r, _ = call('POST', '/api/v1/settings/llm/switch', {'model': 'no-such-model', 'mode': 'now'})
        show('POST /settings/llm/switch 未知模型（期望 4xx）', st, r, limit=400)
    else:
        print('\n### POST /settings/llm/switch —— 跳过（未加 --mutate，避免动真环境）')

    # ---- 答疑（SSE，真模型；只在 --mutate 下跑） ----
    if MUTATE:
        body = {'sessionId': sid, 'sql': 'SELECT * FROM no_such_table', 'error': 'no such table: no_such_table', 'question': '为什么报错'}
        req = urllib.request.Request(BASE + '/api/v1/sandbox/ask', data=json.dumps(body).encode(), method='POST',
                                     headers={'Content-Type': 'application/json', 'Accept': 'text/event-stream'})
        try:
            with opener.open(req, timeout=180) as r:
                print(f'\n### POST /sandbox/ask  [HTTP {r.status}] ctype={r.headers.get("Content-Type")}')
                frames = []
                buf = ''
                while True:
                    chunk = r.read(1)
                    if not chunk:
                        break
                    buf += chunk.decode('utf-8', 'replace')
                    if buf.endswith('\n\n'):
                        frames.append(buf.strip())
                        buf = ''
                    if len(frames) > 40:
                        break
                for f in frames[:6]:
                    print('   ' + f.replace('\n', ' | ')[:170])
                print(f'   …共 {len(frames)} 帧')
                cites = [f for f in frames if f.startswith('event: citation')]
                if cites:
                    print('   citation 帧：', cites[0][:400])
        except Exception as e:  # noqa: BLE001
            print('\n### POST /sandbox/ask 失败：', type(e).__name__, e)

    return 0


if __name__ == '__main__':
    sys.exit(main())
