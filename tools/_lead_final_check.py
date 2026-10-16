"""最终确认：配置驱动了 qwen + 端到端验收 + 关键回归。"""
import http.cookiejar
import json
import urllib.error
import urllib.request

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


call("/auth/login", "POST", {"username": "teacher", "password": "Teacher2026lab"})
st, raw = call("/capabilities")
d = json.loads(raw)
print("① policy（配置层）")
print(f"   ocr = {d['policy']['ocr']}   asr = {d['policy']['asr']}")
print()
print("② OCR providers（label 里带模型名 —— 这是目前唯一能从外部看到的模型信息）")
for p in d["providers"]["ocr"]:
    print(f"   {p['id']:<32} {p.get('label')}")
print()
print("③ ★ 判据: label 必须出现 qwen（证明配置真的驱动了国产模型）")
labels = " ".join((p.get("label") or "") for p in d["providers"]["ocr"])
print(f"   含 'qwen' = {'qwen' in labels.lower()}")
print(f"   含 'glm'  = {'glm' in labels.lower()}   ← 必须 False（旧模型已换掉）")
print()
print("④ ASR providers（用户要 API 方式）")
for p in d["providers"]["asr"]:
    print(f"   {p['id']:<20} runtime={p.get('runtime')} available={p.get('available')} {p.get('label')}")
print()
print("⑤ 并发（真值 + 同源）")
llm = d["llm"]
print(f"   llm.concurrency={llm.get('concurrency')}  pipeline.llm_concurrency={d['pipeline'].get('llm_concurrency')}")
print(f"   detail={json.dumps(llm.get('concurrency_detail'), ensure_ascii=False)}")
