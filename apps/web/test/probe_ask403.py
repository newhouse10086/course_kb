#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抓 `/sandbox/ask` 上游 403 的**原文**（脱敏），给 pi-bridge / backend-api 定位。

为什么要有这个脚本：Lead 要"403 响应体原文（含 code/message，脱敏）"。
它同时把**两条 LLM 路径的证据**摆在一起：
  · `/capabilities` 里 `providers.llm=amr(available=true, latencyMs≈2s)` —— 真探测通过
  · `/sandbox/ask` 的 frame 里 `message.provider=opencode-go / model=…` —— **另一条路径**
这样能直接区分"key 额度问题"还是"答疑走了别的 provider"。

用法：python test/probe_ask403.py [--backend http://127.0.0.1:8787] [--user admin] [--pass Admin2026lab]
"""
from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

BACKEND = 'http://127.0.0.1:8787'
USER, PASSWORD = 'admin', 'Admin2026lab'
for i, a in enumerate(sys.argv):
    if a == '--backend' and i + 1 < len(sys.argv):
        BACKEND = sys.argv[i + 1]
    if a == '--user' and i + 1 < len(sys.argv):
        USER = sys.argv[i + 1]
    if a == '--pass' and i + 1 < len(sys.argv):
        PASSWORD = sys.argv[i + 1]

jar = CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

# 脱敏：任何疑似密钥/令牌都换成 <REDACTED>
SECRET = re.compile(r'(sk-[A-Za-z0-9_\-]{6,}|[A-Za-z0-9_\-]{32,})')


def redact(s: str) -> str:
    return SECRET.sub('<REDACTED>', s)


def call(method: str, path: str, body=None, timeout: int = 120, raw: bool = False, retries: int = 4):
    """带重试：真后端是 `node --watch`，队友改码时会重启（连接被重置/拒绝）→ 退避重试"""
    import time as _t
    last = None
    for i in range(retries):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(BACKEND + path, data=data, method=method,
                                     headers={'Content-Type': 'application/json'})
        try:
            with op.open(req, timeout=timeout) as r:
                text = r.read().decode('utf-8', 'replace')
                return r.status, (text if raw else json.loads(text))
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode('utf-8', 'replace')
        except Exception as e:  # ConnectionReset / refused = 正在重启
            last = e
            print(f'   … {type(e).__name__}，{2 + i * 2}s 后重试（后端可能在 --watch 重启）')
            _t.sleep(2 + i * 2)
    raise last


def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    print(f'== {BACKEND} ==')
    print('login:', call('POST', '/api/v1/auth/login', {'username': USER, 'password': PASSWORD})[0])

    # ① 可用的那条路径（/capabilities 的 llm 探测）
    st, caps = call('GET', '/api/v1/capabilities', timeout=180)
    llm = (caps or {}).get('llm') or {}
    pi = (caps or {}).get('pi') or {}
    print('\n[路径 A] /capabilities.llm      :', json.dumps(llm, ensure_ascii=False)[:300])
    print('[路径 A] /capabilities.pi.model :', json.dumps(pi.get('model'), ensure_ascii=False)[:300])
    print('[路径 A] /capabilities.pi       :', json.dumps({k: v for k, v in pi.items() if k != 'model'}, ensure_ascii=False)[:240])

    # ② 出问题的那条路径（/sandbox/ask 的 SSE frame）
    st, sess = call('POST', '/api/v1/sandbox/session', {'dataset': 'sc'})
    sid = (sess or {}).get('sessionId')
    body = {'sessionId': sid, 'sql': 'SELECT * FROM no_such_table',
            'error': 'no such table: no_such_table', 'question': '为什么报错'}
    req = urllib.request.Request(BACKEND + '/api/v1/sandbox/ask', data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'Accept': 'text/event-stream'})
    frames: list[tuple[str, str]] = []
    with op.open(req, timeout=300) as r:
        event, data = '', ''
        for rawline in r:
            line = rawline.decode('utf-8', 'replace').rstrip('\n')
            if line.startswith('event:'):
                event = line[6:].strip()
            elif line.startswith('data:'):
                data += line[5:].strip()
            elif line == '':
                if event or data:
                    frames.append((event, data))
                    if event == 'done':
                        break
                event, data = '', ''

    print(f'\n[路径 B] /sandbox/ask 帧：{len(frames)} 个 →', [e for e, _ in frames])
    errs = [(e, d) for e, d in frames if '"type":"error"' in d or e == 'error']
    if errs:
        for e, d in errs:
            print(f'\n★ 403 原文（event={e}）：')
            print(redact(d))
    else:
        print('（本次没有 error 帧 —— 上游这次成功了？）')

    # ③ 答疑用的 provider/model（从 message_end 帧里取，最能说明"走了哪条路"）
    provs = set()
    for e, d in frames:
        m = re.search(r'"provider":"([^"]+)"', d)
        mod = re.search(r'"model":"([^"]+)"', d)
        if m or mod:
            provs.add(f'{m.group(1) if m else "?"}/{mod.group(1) if mod else "?"}')
    print('\n[路径 B] 答疑实际用的 provider/model：', sorted(provs) or '（无 message_end 帧）')

    done = next((d for e, d in frames if e == 'done'), '')
    if done:
        try:
            dj = json.loads(done)
            print('\n[路径 B] done：ok=', dj.get('ok'), 'citations=', len(dj.get('citations') or []),
                  'text 长度=', len(str(dj.get('text') or '')))
            print('done.text 片段：', redact(str(dj.get('text') or ''))[:300])
        except json.JSONDecodeError:
            print('\n[路径 B] done（非 JSON）：', redact(done)[:300])
    return 0


if __name__ == '__main__':
    sys.exit(main())
