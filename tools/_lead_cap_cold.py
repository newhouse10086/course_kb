"""查 /capabilities 冷调用为什么返回空 body（可能是真回归）。"""
import http.cookiejar
import json
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8787/api/v1"
cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def raw_call(path, method="GET", body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        r.add_header("Content-Type", "application/json")
    t0 = time.time()
    try:
        with op.open(r, timeout=timeout) as resp:
            b = resp.read()
            return resp.status, b, time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read(), time.time() - t0
    except Exception as e:  # noqa: BLE001
        return 0, str(e).encode(), time.time() - t0


st, b, dt = raw_call("/auth/login", "POST", {"username": "teacher", "password": "Teacher2026lab"})
print(f"login = {st} ({dt:.2f}s)")

print()
print("=== /capabilities 连打 5 次，看第几次才有内容 ===")
for i in range(1, 6):
    st, b, dt = raw_call("/capabilities")
    txt = b.decode("utf-8", "replace")
    try:
        d = json.loads(txt)
        keys = list(d)
        print(f"  #{i}: HTTP {st} · {len(b)} 字节 · {dt:.2f}s · keys={len(keys)} · 有 llm={'llm' in d} · cached={d.get('cached')}")
    except Exception as e:  # noqa: BLE001
        print(f"  #{i}: HTTP {st} · {len(b)} 字节 · {dt:.2f}s · ★ 不是 JSON: {e}")
        print(f"      原文前 200 字: {txt[:200]!r}")
    time.sleep(1)

print()
print("=== 对照：/health（已知稳定）连打 3 次 ===")
for i in range(1, 4):
    st, b, dt = raw_call("/health")
    print(f"  #{i}: HTTP {st} · {len(b)} 字节 · {dt:.2f}s · {b[:60]!r}")
    time.sleep(0.5)

print()
print("=== 后端日志里 /capabilities 相关的行 ===")
import os
from datetime import datetime

p = os.path.join(
    r"D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\course-kb\data\logs",
    f"app-{datetime.now().strftime('%Y-%m-%d')}.log",
)
if os.path.exists(p):
    lines = open(p, encoding="utf-8", errors="replace").read().splitlines()
    hits = [ln for ln in lines if "capabilities" in ln.lower()]
    print(f"  日志 {os.path.basename(p)}: {len(lines)} 行, 含 capabilities 的 {len(hits)} 行")
    for ln in hits[-6:]:
        print(f"    {ln[:220]}")
else:
    print(f"  日志不存在: {p}")
