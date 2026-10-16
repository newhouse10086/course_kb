"""Lead 端到端验收（零 LLM）—— 今晚所有交付的最终确认。

判据全部落在**真 HTTP + 真数据**上，不采信任何自述。
用法: python -X utf8 tools/_lead_acceptance.py
"""
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8787/api/v1"
DB = r"D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\course-kb\data\course_kb.sqlite3"

ok = 0
bad = 0


def check(label, cond, detail=""):
    global ok, bad
    if cond:
        ok += 1
        print(f"  ✅ {label}" + (f" — {detail}" if detail else ""))
    else:
        bad += 1
        print(f"  ✗ {label}" + (f" — {detail}" if detail else ""))


def req(path, method="GET", body=None, cookie=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    if data:
        r.add_header("Content-Type", "application/json")
    if cookie:
        r.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def login(user, pw):
    st, raw = req("/auth/login", "POST", {"username": user, "password": pw})
    if st != 200:
        return None
    # 从 set-cookie 拿 ckb_session（urlopen 已处理 cookie? 不，手动拿）
    return raw


print("=" * 62)
print("Lead 端到端验收（零 LLM）")
print("=" * 62)

# ── ① health ────────────────────────────────────────────────
print("\n① 服务与数据")
st, raw = req("/health")
h = json.loads(raw) if st == 200 else {}
check("health 200", st == 200, f"ok={h.get('ok')} docs={h.get('documents')} cards={h.get('cards')}")
check("无卡死任务", h.get("tasks_active", -1) == 0, f"tasks_active={h.get('tasks_active')}")

# ── ② 三账号登录（用 cookie jar 手写）────────────────────────
print("\n② 三账号登录 + 对照组（坑 37）")
import http.cookiejar  # noqa: E402

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def oreq(path, method="GET", body=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    if data:
        r.add_header("Content-Type", "application/json")
    try:
        with opener.open(r, timeout=20) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


for u, p in (("teacher", "Teacher2026lab"), ("student", "Student2026lab"), ("admin", "Admin2026lab")):
    cj.clear()
    st, raw = oreq("/auth/login", "POST", {"username": u, "password": p})
    check(f"{u} 登录", st == 200, f"HTTP {st}")

# ── ③ teacher 登录后的验收 ──────────────────────────────────
cj.clear()
st, _ = oreq("/auth/login", "POST", {"username": "teacher", "password": "Teacher2026lab"})
check("teacher 已登录", st == 200)

print("\n③ collections（教师建课程系列 + 上传视频）")
st, raw = oreq("/collections")
d = json.loads(raw) if st == 200 else {}
check("GET /collections 200", st == 200, f"total={d.get('total')}")
check("形状 = {collections,total}", isinstance(d.get("collections"), list) and "total" in d, f"keys={list(d)[:5]}")

st, raw = oreq("/collections", "POST", {"name": f"Lead验收-{int(time.time())}"})
col = json.loads(raw).get("collection", {}) if st == 201 else {}
check("POST /collections 201", st == 201, f"id={col.get('id')}")
if col.get("id"):
    st, raw = oreq(f"/collections/{col['id']}/videos")
    check("GET :id/videos 200", st == 200, raw[:80])

print("\n④ 对照组（坑 37: 已登录下 200 与 404 必须可区分）")
st_doc, _ = oreq("/documents")
st_404, _ = oreq("/nonexistent-xyz")
check("已知存在 /documents → 200", st_doc == 200, f"HTTP {st_doc}")
check("确定不存在 → 404", st_404 == 404, f"HTTP {st_404}")
check("★ 两者可区分", st_doc != st_404)

print("\n⑤ 会话命名（AI 不许覆盖 user）")
st, raw = oreq("/conversations", "POST", {"title": "验收会话"})
cnv = json.loads(raw).get("conversation", {}) if st == 201 else {}
cid = cnv.get("id")
check("建会话 201", st == 201, f"id={cid} title_source={cnv.get('title_source')}")
if cid:
    st, raw = oreq(f"/conversations/{cid}", "PATCH", {"title": "我手动改的名字"})
    c = json.loads(raw).get("conversation", {}) if st == 200 else {}
    check("PATCH 改名 200", st == 200, f"title={c.get('title')!r}")
    check("★ title_source='user'", c.get("title_source") == "user", f"={c.get('title_source')!r}")
    st, raw = oreq(f"/conversations/{cid}/title/generate", "POST", {})
    check("★ AI 生成 → 409 E_TITLE_USER_SET", st == 409 and "E_TITLE_USER_SET" in raw, f"HTTP {st} {raw[:70]}")

print("\n⑥ 并发可配（/capabilities 真值 + 同源）")
st, raw = oreq("/capabilities")
cap = json.loads(raw) if st == 200 else {}
llm = cap.get("llm", {})
cd = llm.get("concurrency_detail", {})
check("llm.concurrency 有值", isinstance(llm.get("concurrency"), int), f"={llm.get('concurrency')}")
check("★ concurrency_detail 有观测字段", "in_flight" in cd and "peak_in_flight" in cd, f"keys={list(cd)}")
check("pipeline.llm_concurrency 与 llm.concurrency 同源",
      cap.get("pipeline", {}).get("llm_concurrency") == llm.get("concurrency"),
      f"{cap.get('pipeline', {}).get('llm_concurrency')} vs {llm.get('concurrency')}")

print("\n⑦ OCR 走国产模型（★ 配置驱动 —— 2026-10-16 修正）")
ocrs = cap.get("providers", {}).get("ocr", [])
names = [o.get("id") for o in ocrs]
labels = " ".join((o.get("label") or "") for o in ocrs)
check("openrouter-ocr 已注册", any("openrouter-ocr" in (n or "") for n in names), f"ids={names}")
# ★ 判据: 配置里必须是**国产模型**（label 带 qwen），且**不再有 glm**
check("★ OCR label 含 qwen（配置真的换成国产）", "qwen" in labels.lower(), labels[:80])
check("★ OCR label 不含 glm（旧模型已换掉）", "glm" not in labels.lower(), labels[:80])
# ★ policy 已从 local-first 改成 cloud-first（与用户裁定一致；代码本身按 id 直连绕过 policy）
check("policy.ocr = cloud-first（不再对外声称'本地优先'）",
      cap.get("policy", {}).get("ocr") == "cloud-first", f"={cap.get('policy', {}).get('ocr')}")
check("policy.asr = cloud-first（用户裁定：ASR 也走 API）",
      cap.get("policy", {}).get("asr") == "cloud-first", f"={cap.get('policy', {}).get('asr')}")

print("\n⑧ ★★ cards 保 id（今晚的核心修复）—— 直连 DB 判据")
con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
rows = con.execute("select doc_id, count(*) n from cards group by doc_id").fetchall()
check("库里有卡片", len(rows) > 0, f"doc 数={len(rows)} 总卡数={sum(r['n'] for r in rows)}")
# 每张卡：用真 HTTP 探它的 id 是否 200
probe_n = 0
probe_ok = 0
for r in con.execute("select id from cards limit 5"):
    cid_card = r["id"]
    st, _ = oreq(f"/cards/{cid_card}")
    probe_n += 1
    if st == 200:
        probe_ok += 1
check("★ 现存卡片 id 用真 HTTP 探 → 200（不是 404）", probe_ok == probe_n, f"{probe_ok}/{probe_n}")
# 悬空检查
dangling = con.execute(
    "select count(*) from cards c where c.unit_id is not null and not exists(select 1 from units u where u.id=c.unit_id)"
).fetchone()[0]
check("★ 卡片 → unit 悬空 = 0", dangling == 0, f"悬空={dangling}")
dx = con.execute(
    "select count(*) from xrefs x where not exists(select 1 from cards c where c.id=x.from_card_id)"
    " or not exists(select 1 from cards c where c.id=x.to_card_id)"
).fetchone()[0]
check("★ xrefs 悬空 = 0", dx == 0, f"悬空={dx}")

print("\n⑨ 看门狗（v8 心跳列 + 周期扫描）")
cols = [d[1] for d in con.execute("pragma table_info(tasks)")]
check("tasks.heartbeat_at 列存在（迁移 v8）", "heartbeat_at" in cols, f"有={'heartbeat_at' in cols}")
migs = [r[0] for r in con.execute("select version from schema_migrations order by version")]
check("schema_migrations 含 8", 8 in migs, f"={migs}")
con.close()

print("\n" + "=" * 62)
print(f"结果: **{ok} 通过 / {bad} 失败**")
print("=" * 62)
sys.exit(1 if bad else 0)
