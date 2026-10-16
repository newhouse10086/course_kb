"""查 /capabilities 为何 llm/providers/policy 为空（Lead 验收发现的 4 条失败）。"""
import json
import urllib.error
import urllib.request
import http.cookiejar

BASE = "http://127.0.0.1:8787/api/v1"
cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def call(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        r.add_header("Content-Type", "application/json")
    try:
        with op.open(r, timeout=25) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


st, _ = call("/auth/login", "POST", {"username": "teacher", "password": "Teacher2026lab"})
print(f"login = {st}")

st, raw = call("/capabilities")
print(f"capabilities = {st}, 长度 {len(raw)}")
try:
    d = json.loads(raw)
except Exception as e:  # noqa: BLE001
    print("解析失败:", e)
    print(raw[:600])
    raise SystemExit(1)

print(f"\ntop-level keys ({len(d)}): {list(d)}")
print()
for k in ("llm", "providers", "policy", "pipeline", "worker", "pi", "asr", "sandbox", "providers_error"):
    v = d.get(k)
    if isinstance(v, dict):
        print(f"  {k}: dict, keys={list(v)[:10]}")
    elif isinstance(v, list):
        print(f"  {k}: list, len={len(v)}")
    else:
        print(f"  {k}: {type(v).__name__} = {str(v)[:120]}")

print()
print(f"cached={d.get('cached')}  probe_calls={d.get('probe_calls')}")
print(f"cache_ttl_ms={d.get('cache_ttl_ms')}")
print()
print("★ llm 原文:", json.dumps(d.get("llm"), ensure_ascii=False)[:400])
print()
print("★ providers 原文:", json.dumps(d.get("providers"), ensure_ascii=False)[:400])
print()
print("★ providers_error:", json.dumps(d.get("providers_error"), ensure_ascii=False)[:400])
print()
print("★ policy:", json.dumps(d.get("policy"), ensure_ascii=False)[:300])
