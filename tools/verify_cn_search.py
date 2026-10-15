# -*- coding: utf-8 -*-
"""端到端验证：真实**中文**语料上的 bigram 全文检索。

背景：dev 库里只有英文版 MySQL 手册（refman-26.7-en.pdf），
      所以此前 /search?q=索引 返回 0 是**正确行为**（语料里没这个词）。
      但这也意味着**中文 bigram 路径从未在真实中文语料上端到端验证过** —— 本脚本补上。

流程：造中文 TXT → 上传 → parse → units → index → 中文检索（对照英译词）
"""
import io
import json
import os
import subprocess
import sys
import time
import urllib.request

KB = r"D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\course-kb"
BASE = "http://127.0.0.1:8787/api/v1"
ADMIN = ("admin", "Admin2026lab")

CN_TEXT = """数据库系统原理 · 第三章 索引与查询优化

3.1 聚簇索引
聚簇索引将数据行按照键值的顺序物理存储在磁盘上，因此一个表只能有一个聚簇索引。
在 InnoDB 存储引擎中，主键索引就是聚簇索引；如果没有定义主键，InnoDB 会选择一个
唯一的非空索引代替，若不存在这样的索引，则隐式定义一个行号作为聚簇索引键。
二级索引的叶子节点存储的是主键值而不是行指针，因此通过二级索引查询非索引列时
需要回表，也就是再根据主键值到聚簇索引中查找完整的数据行。

3.2 覆盖索引
如果一个索引包含了查询所需的全部列，就称为覆盖索引。使用覆盖索引可以避免回表，
从而显著减少磁盘随机读取的次数。例如查询 SELECT 主键 FROM 表 WHERE 条件，
只扫描二级索引即可完成，无需访问聚簇索引。

3.3 最左前缀原则
对于联合索引，查询条件必须从索引的最左列开始连续匹配才能有效利用索引。
跳过最左列、或者在索引列上使用函数与类型转换，都会导致索引失效而退化为全表扫描。
范围查询之后的条件列无法继续使用索引的有序性来加速。

3.4 事务与隔离级别
事务具有原子性、一致性、隔离性和持久性四个特性，简称 ACID。
InnoDB 通过多版本并发控制实现一致性读，也就是我们常说的 MVCC。
在可重复读隔离级别下，快照读使用一致性视图，而当前读会读取最新提交的数据。
间隙锁用于防止幻读，它锁住的是索引记录之间的间隙，而不是记录本身。

3.5 查询优化实践
使用 EXPLAIN 可以查看执行计划，重点关注访问类型、使用的索引、预估扫描行数。
当出现全表扫描时，应当检查是否存在合适索引、统计信息是否过期、
以及查询条件是否因为隐式类型转换或函数调用而无法使用索引。
慢查询日志可以帮助定位执行时间超过阈值的语句，是性能调优的起点。
"""


def sh(args, cwd=KB):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


def http(method, path, *, data=None, cookie=None, ctype="application/json", raw=False):
    url = BASE + path
    body = None
    if data is not None:
        body = data if raw else json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        req.add_header("Content-Type", ctype)
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            txt = r.read().decode("utf-8", "replace")
            ck = r.headers.get("Set-Cookie", "")
            return r.status, (json.loads(txt) if txt.strip().startswith(("{", "[")) else txt), ck
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(txt), e.headers.get("Set-Cookie", "")
        except Exception:
            return e.code, txt, e.headers.get("Set-Cookie", "")


def main():
    print("=" * 74)
    print("中文语料 bigram 端到端验证")
    print("=" * 74)

    # 0) 登录
    st, body, ck = http("POST", "/auth/login",
                        data={"username": ADMIN[0], "password": ADMIN[1]})
    cookie = ck.split(";")[0]
    print(f"\n[0] 登录 → HTTP {st}  cookie={'有' if cookie else '无'}")
    if st != 200:
        print("     登录失败，终止：", str(body)[:200])
        return 1

    # 1) 造中文 TXT
    tmp = os.path.join(KB, "data", "tmp")
    os.makedirs(tmp, exist_ok=True)
    fp = os.path.join(tmp, "db_cn_sample.txt")
    io.open(fp, "w", encoding="utf-8", newline="\n").write(CN_TEXT)
    print(f"[1] 造中文样本 → {os.path.basename(fp)}  {os.path.getsize(fp)} 字节  {len(CN_TEXT)} 字符")

    # 2) 上传（multipart 手写，避免依赖）
    boundary = "----ckboundary1234567890"
    with io.open(fp, "rb") as f:
        filedata = f.read()
    parts = []
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(b'Content-Disposition: form-data; name="file"; filename="db_cn_sample.txt"\r\n')
    parts.append(b"Content-Type: text/plain\r\n\r\n")
    parts.append(filedata)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    payload = b"".join(parts)
    st, body, _ = http("POST", "/documents", data=payload, cookie=cookie,
                       ctype=f"multipart/form-data; boundary={boundary}", raw=True)
    print(f"[2] 上传 → HTTP {st}  {str(body)[:160]}")
    doc_id = (body or {}).get("document_id") or (body or {}).get("id") if isinstance(body, dict) else None
    if not doc_id:
        print("     未取到 document_id，终止")
        return 1

    # 3) parse（同步端点或任务）
    st, body, _ = http("POST", f"/documents/{doc_id}/parse", data={}, cookie=cookie)
    print(f"[3] parse → HTTP {st}  {str(body)[:140]}")

    # 轮询文档状态
    for i in range(40):
        st, doc, _ = http("GET", f"/documents/{doc_id}", cookie=cookie)
        if isinstance(doc, dict) and doc.get("parse_status") == "done":
            print(f"     parse done（{i} 轮轮询）  units={doc.get('units_count', doc.get('unit_count'))}")
            break
        time.sleep(1.5)
    else:
        print("     ⚠️ parse 未在 60s 内完成，继续尝试检索")

    # 4) 建索引
    st, body, _ = http("POST", f"/documents/{doc_id}/index", data={}, cookie=cookie)
    print(f"[4] index → HTTP {st}  {str(body)[:140]}")

    # 5) ★ 中文检索
    import urllib.parse
    print("\n[5] ★ 中文检索（真实中文语料）")
    ok_any = False
    for q in ["聚簇索引", "回表", "最左前缀", "间隙锁", "幻读", "覆盖索引", "事务", "索引"]:
        enc = urllib.parse.quote(q)
        st, body, _ = http("GET", f"/search?q={enc}", cookie=cookie)
        n = len(body.get("hits", [])) if isinstance(body, dict) else -1
        if n > 0:
            ok_any = True
        top = ""
        if isinstance(body, dict) and body.get("hits"):
            h = body["hits"][0]
            top = f"  首条={h.get('title','')[:26]}"
        print(f"     q={q:<8} → HTTP {st}  hits={n}{top}")

    # 6) 反向对照：不存在的词
    st, body, _ = http("GET", "/search?q=" + urllib.parse.quote("量子纠缠"), cookie=cookie)
    n = len(body.get("hits", [])) if isinstance(body, dict) else -1
    print(f"     q=量子纠缠（不存在）→ hits={n}  ← 应为 0")

    # 7) contrast：bigram vs unicode61（自证）
    st, body, _ = http("GET", "/search/contrast?q=" + urllib.parse.quote("聚簇索引"), cookie=cookie)
    if isinstance(body, dict):
        print(f"\n[6] /search/contrast 「聚簇索引」")
        print(f"     bigram={body.get('bigram_hits')}  unicode61={body.get('unicode61_hits')}")
        print(f"     conclusion={body.get('conclusion')}")

    print()
    print("=" * 74)
    print("结论: " + ("✅ 中文 bigram 端到端可用（英文语料下 0 命中是正确行为，此处理解为真实可用）"
                     if ok_any else "❌ 中文检索仍然 0 命中 —— 真 bug"))
    print("=" * 74)
    return 0 if ok_any else 1


if __name__ == "__main__":
    sys.exit(main())
