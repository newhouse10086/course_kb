"""清理 Lead/web-ui 昨晚验收造的测试数据 + 最终可用性确认。

只删**名字可识别为验收产物**的（Lead验收-* / 验收目录-* / 验收会话 / 我手动改的名字），
不碰任何真实数据。
"""
import http.cookiejar
import json
import sqlite3
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8787/api/v1"
DB = r"D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\course-kb\data\course_kb.sqlite3"

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


print("=" * 60)
print("① 清理验收产物")
print("=" * 60)
st, _ = call("/auth/login", "POST", {"username": "teacher", "password": "Teacher2026lab"})
print(f"  teacher 登录 = {st}")

st, raw = call("/collections")
cols = json.loads(raw).get("collections", []) if st == 200 else []
print(f"  现有目录 {len(cols)} 个:")
for c in cols:
    print(f"    {c['id']}  {c.get('name')!r}")
    if "验收" in (c.get("name") or "") or "Lead" in (c.get("name") or ""):
        st2, _ = call(f"/collections/{c['id']}", "DELETE")
        print(f"      → 删除（验收产物）HTTP {st2}")

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
print()
print("  清理验收会话:")
for r in con.execute("select id,title,title_source from conversations").fetchall():
    t = r["title"] or ""
    if "验收" in t or t == "我手动改的名字" or "探测" in t:
        con.execute("delete from conversations where id=?", (r["id"],))
        print(f"    {r['id']}  {t!r}  → 删除")
con.commit()

print()
print("=" * 60)
print("② 最终可用性确认")
print("=" * 60)
st, raw = call("/health")
h = json.loads(raw)
print(f"  后端 health ✅ ok={h['ok']} docs={h['documents']} units={h['units']} cards={h['cards']} tasks_active={h['tasks_active']}")

for u, p in (("teacher", "Teacher2026lab"), ("student", "Student2026lab"), ("admin", "Admin2026lab")):
    cj.clear()
    st, _ = call("/auth/login", "POST", {"username": u, "password": p})
    print(f"  {u:<8} 登录 = {st}")

cj.clear()
call("/auth/login", "POST", {"username": "teacher", "password": "Teacher2026lab"})
st, raw = call("/capabilities")
d = json.loads(raw)
labels = " ".join((x.get("label") or "") for x in d["providers"]["ocr"])
print(f"  OCR 国产模型 ✅ {'qwen' in labels.lower()}（label: {labels[:60]}）")
print(f"  并发 = {d['llm']['concurrency']} · policy.ocr = {d['policy']['ocr']}")

print()
print("  剩余目录:")
st, raw = call("/collections")
for c in json.loads(raw).get("collections", []):
    print(f"    {c['id']}  {c.get('name')!r}")
print()
print("  剩余会话（前 5）:")
for r in con.execute("select id,title,title_source from conversations order by created_at desc limit 5"):
    print(f"    {r['id']}  {r['title']!r}  {r['title_source']}")
print()
print("  文档:")
for r in con.execute("select id,kind,status,page_count from documents order by created_at"):
    print(f"    {r['id']}  {r['kind']:<6} {r['status']:<10} pages={r['page_count']}")
con.close()
