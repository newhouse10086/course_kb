"""真机零 LLM 直连检查：登录 → POST /conversations → 用该 id 连 WS（不经浏览器）

用途：把"UI 的问题"与"后端/代理的问题"分开（对照实验）。
用法：python test/real_ws_owner_probe.py [--backend http://127.0.0.1:8787] [--user teacher] [--password …]
"""
from __future__ import annotations

import json
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
            with op.open(req, timeout=60) as r:
                return r.status, json.loads(r.read().decode('utf-8', 'replace'))
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode('utf-8', 'replace')[:300]

    st, lg = call('/api/v1/auth/login', {'username': USER, 'password': PW}, 'POST')
    print(f'login({USER}): {st}')
    if st != 200:
        print('   ', str(lg)[:200])
        return 2
    cookie = '; '.join(f'{c.name}={c.value}' for c in jar)
    st, cv = call('/api/v1/conversations', {'title': 'probe-owner'}, 'POST')
    print(f'POST /conversations: {st} → {json.dumps(cv, ensure_ascii=False)[:200]}')
    cid = ((cv.get('conversation') or {}).get('id') if isinstance(cv, dict) else None) or ''
    if not cid:
        print('✗ 没拿到 conversation.id')
        return 2
    # 直连后端（不经代理）——把代理因素排除
    script = f"""
const WS = require('ws');
const ws = new WS({json.dumps(BACKEND.replace('http', 'ws') + '/api/v1/chat/' + cid + '?assistant=chat&mode=chat')},
  {{ headers: {{ Cookie: {json.dumps(cookie)} }} }});
const seen = [];
ws.on('open', () => console.log('OPEN'));
ws.on('message', (d) => {{ const m = JSON.parse(d.toString()); seen.push(m.type);
  if (m.type === 'error') console.log('ERROR', JSON.stringify(m).slice(0, 240)); }});
ws.on('close', (code, reason) => {{ console.log('CLOSE', code, String(reason).slice(0, 80)); console.log('TYPES', JSON.stringify(seen)); process.exit(0); }});
ws.on('error', (e) => {{ console.log('WSERR', e.message); process.exit(0); }});
setTimeout(() => {{ console.log('TIMEOUT(仍开着=成功)'); console.log('TYPES', JSON.stringify(seen)); ws.close(); process.exit(0); }}, 3000);
"""
    out = subprocess.run(['node', '-e', script], cwd=str(WEB), capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60)
    print('— 直连 WS（同 cookie，用刚建的 id）—')
    print((out.stdout or '').strip() or (out.stderr or '')[:300])
    return 0


if __name__ == '__main__':
    sys.exit(main())
