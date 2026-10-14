# -*- coding: utf-8 -*-
"""Lead 端到端验收：真 PDF → 上传 → worker 解析 → 查 API 产物。

这是**跨层验收**（用户要求 Lead 亲自跑），覆盖：
  TS 路由 → SQLite → worker 调用器 → Python worker → 回写 → REST 查询

用法：先启动服务（node src/index.ts），再跑本脚本。
"""
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = "http://127.0.0.1:8787/api/v1"
PDF = r"D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\refman-26.7-en.a4.pdf"
if not os.path.exists(PDF):
    PDF = r"D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\数据库课程智能体调研\corpus\index.pdf"


def p(*a):
    print(*a); sys.stdout.flush()


def get(path, timeout=60):
    req = urllib.request.Request(BASE + path)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode("utf-8"))


def post_file(path, filepath, timeout=900):
    """multipart/form-data 上传（手搓，避免额外依赖）。"""
    boundary = "----LeadE2E" + uuid.uuid4().hex
    fn = os.path.basename(filepath)
    with io.open(filepath, "rb") as f:
        data = f.read()
    body = io.BytesIO()
    body.write(("--%s\r\n" % boundary).encode())
    body.write(('Content-Disposition: form-data; name="file"; filename="%s"\r\n' % fn).encode())
    body.write(b"Content-Type: application/pdf\r\n\r\n")
    body.write(data)
    body.write(("\r\n--%s--\r\n" % boundary).encode())
    raw = body.getvalue()
    req = urllib.request.Request(BASE + path, data=raw, method="POST")
    req.add_header("Content-Type", "multipart/form-data; boundary=%s" % boundary)
    req.add_header("Content-Length", str(len(raw)))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode("utf-8"))


def main():
    p("=" * 74)
    p("0. 健康检查")
    p("=" * 74)
    st, h = get("/health")
    p(f"  GET /health → {st}  {json.dumps(h, ensure_ascii=False)}")

    p("")
    p("=" * 74)
    p(f"1. 上传 PDF：{os.path.basename(PDF)}  ({os.path.getsize(PDF)/1024/1024:.1f} MB)")
    p("=" * 74)
    t0 = time.time()
    try:
        st, up = post_file("/documents", PDF)
    except urllib.error.HTTPError as e:
        p(f"  ✗ HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:400]}")
        return 1
    p(f"  → {st}  {json.dumps(up, ensure_ascii=False)[:300]}")
    doc_id = up.get("document_id") or up.get("id")
    task_id = up.get("task_id")
    p(f"  document_id={doc_id}  task_id={task_id}  上传耗时 {time.time()-t0:.1f}s")
    if not doc_id:
        p("  ✗ 没有 document_id，无法继续")
        return 1

    p("")
    p("=" * 74)
    p("2. 轮询任务（后端在调 Python worker 解析）")
    p("=" * 74)
    last = None
    for i in range(120):          # 最多 10 分钟
        try:
            st, t = get(f"/tasks/{task_id}")
        except Exception as e:
            p(f"  轮询出错：{e}"); break
        line = f"{t.get('status')} {t.get('progress')} {t.get('stage') or ''}"
        if line != last:
            p(f"  [{time.time()-t0:6.1f}s] {line}")
            last = line
        if t.get("status") in ("done", "failed", "cancelled"):
            if t.get("error"):
                p(f"  ✗ 任务失败：{t.get('error')}")
            break
        time.sleep(5)

    p("")
    p("=" * 74)
    p("3. 查产物（这是验收的核心）")
    p("=" * 74)
    for name, path in [
        ("文档详情", f"/documents/{doc_id}"),
        ("层次树",   f"/documents/{doc_id}/outline"),
        ("单元",     f"/documents/{doc_id}/units?limit=3"),
        ("卡片",     f"/documents/{doc_id}/cards?limit=3"),
        ("图谱",     f"/documents/{doc_id}/graph"),
        ("交叉引用", f"/documents/{doc_id}/xrefs?limit=3"),
    ]:
        try:
            st, d = get(path, timeout=120)
        except urllib.error.HTTPError as e:
            p(f"  {name:8} ✗ HTTP {e.code}: {e.read().decode('utf-8','replace')[:160]}")
            continue
        except Exception as e:
            p(f"  {name:8} ✗ {type(e).__name__}: {str(e)[:120]}")
            continue
        # 摘要化
        if isinstance(d, dict):
            keys = list(d.keys())
            summary = {}
            for k in ("total", "count", "nodes", "edges", "roots"):
                if k in d:
                    v = d[k]
                    summary[k] = len(v) if isinstance(v, (list, dict)) else v
            if "units" in d and isinstance(d["units"], list):
                summary["units"] = len(d["units"])
            if "cards" in d and isinstance(d["cards"], list):
                summary["cards"] = len(d["cards"])
            if "nodes" in d and isinstance(d["nodes"], list):
                summary["nodes"] = len(d["nodes"])
            if "edges" in d and isinstance(d["edges"], list):
                summary["edges"] = len(d["edges"])
            p(f"  {name:8} ✓ keys={keys[:8]}  {json.dumps(summary, ensure_ascii=False)}")
        else:
            p(f"  {name:8} ✓ {type(d).__name__} len={len(d)}")

    p("")
    p("=" * 74)
    p("4. 中文检索（坑 15 验证：bigram 应该能命中）")
    p("=" * 74)
    for q in ("索引", "事务", "InnoDB"):
        try:
            st, d = get(f"/search?q={urllib.parse.quote(q)}&limit=3", timeout=60)
            hits = d.get("hits") or []
            p(f"  搜「{q}」→ total={d.get('total')} 返回 {len(hits)} 条"
              + (f"  例：{hits[0].get('title')}" if hits else ""))
        except Exception as e:
            p(f"  搜「{q}」✗ {type(e).__name__}: {str(e)[:120]}")

    p("")
    p("=" * 74)
    p("验收结论")
    p("=" * 74)
    p(f"  总耗时 {time.time()-t0:.1f}s")
    return 0


if __name__ == "__main__":
    import urllib.parse  # noqa: E402
    sys.exit(main())
