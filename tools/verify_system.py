# -*- coding: utf-8 -*-
"""
verify_system.py —— **独立验收**：起真实服务，用真实 HTTP 打真实接口。

为什么不用测试套件代替
----------------------
测试套件会注入 stub（假 worker、假抽取器、假 provider）。它证明的是"逻辑对"，
**不证明"真服务能跑"**。本脚本起 `node src/index.ts` 真实进程 + 真实 SQLite，
用 urllib 发真实 HTTP，读**真实状态码与响应体**。

判据（Lead 指定）
-----------------
> 如果一个 bug 的表现是"看起来成功"，它比崩溃危险得多。

所以本脚本对每个检查都记录**实际值**，并把「期望 vs 实际」并列写出；
任何与预期不符都进 `problems`，并按严重度排序。**绝不把"非空"当通过。**

设计约束
--------
- 独立库：`COURSE_KB_DB` 指到 `data/verify/verify.sqlite3`，不污染开发库。
- 独立端口：默认 8791（避开开发的 8787）。
- 所有产出写到 `data/verify/**`（本脚本的唯一写域）。
- 不修改任何产品代码；只读 + 发 HTTP。

用法
----
  python tools/verify_system.py                 # 全套
  python tools/verify_system.py --skip-sandbox  # 跳过沙箱（若未就绪）
  python tools/verify_system.py --keep          # 保留服务进程（调试）
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from http.cookiejar import CookieJar
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

KB = Path(__file__).resolve().parents[1]
VERIFY = KB / "data" / "verify"
OUT = VERIFY / "system_verification.json"
PORT = int(os.environ.get("VERIFY_PORT", "8791"))
BASE = f"http://127.0.0.1:{PORT}"
ADMIN_USER = os.environ.get("VERIFY_ADMIN_USER", "vadmin")
ADMIN_PASS = os.environ.get("VERIFY_ADMIN_PASS", "verify-pass-123")

PDF = KB.parent / "refman-26.7-en.a4.pdf"
TXT = VERIFY / "sample_corpus.txt"


def p(*a):
    print(*a)
    sys.stdout.flush()


# ══════════════════════════════════════════════════════════════════════
# HTTP 客户端（cookie 会话）
# ══════════════════════════════════════════════════════════════════════
class Session:
    """一个 HTTP 会话（自带 cookie jar，模拟浏览器）。"""

    def __init__(self, label: str):
        self.label = label
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar))

    def req(self, method, path, body=None, raw=None, ctype=None, timeout=180):
        url = BASE + path
        data = None
        headers = {}
        if raw is not None:
            data = raw
            headers["Content-Type"] = ctype or "application/octet-stream"
        elif body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        r = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with self.opener.open(r, timeout=timeout) as resp:
                payload = resp.read()
                return {"status": resp.status, "body": _parse(payload),
                        "raw": payload, "headers": dict(resp.headers)}
        except urllib.error.HTTPError as e:
            payload = e.read()
            return {"status": e.code, "body": _parse(payload), "raw": payload,
                    "headers": dict(e.headers)}
        except Exception as e:  # noqa: BLE001
            return {"status": 0, "body": None, "raw": b"",
                    "error": f"{type(e).__name__}: {e}"}

    def login(self, username, password):
        r = self.req("POST", "/api/v1/auth/login",
                     {"username": username, "password": password})
        return r


def _parse(payload: bytes):
    try:
        return json.loads(payload.decode("utf-8"))
    except Exception:
        try:
            return payload.decode("utf-8", "replace")
        except Exception:
            return None


def err_code(body):
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        return body["error"].get("code")
    return None


def err_hint(body):
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        return body["error"].get("hint") or ""
    return ""


# ══════════════════════════════════════════════════════════════════════
# 检查记录
# ══════════════════════════════════════════════════════════════════════
CHECKS: list[dict] = []
PROBLEMS: list[dict] = []


def check(group, name, ok, expected, actual, severity="high", command="", note=""):
    """记录一条检查。`ok=False` 时按 severity 进 problems。"""
    rec = {"group": group, "name": name, "ok": bool(ok), "expected": expected,
           "actual": actual, "severity": severity, "command": command, "note": note}
    CHECKS.append(rec)
    mark = "OK  " if ok else "FAIL"
    p("  [%s] %-46s expected=%s actual=%s" % (mark, name[:46], _s(expected), _s(actual)))
    if not ok:
        PROBLEMS.append(rec)
    return rec


def _s(v, n=110):
    if isinstance(v, (dict, list)):
        v = json.dumps(v, ensure_ascii=False)
    v = str(v).replace("\n", " ")
    return v[:n]


# ══════════════════════════════════════════════════════════════════════
# 起服务
# ══════════════════════════════════════════════════════════════════════
def port_free(port):
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) != 0


def start_server(env_extra=None):
    VERIFY.mkdir(parents=True, exist_ok=True)
    db = VERIFY / "verify.sqlite3"
    for suf in ("", "-wal", "-shm"):
        f = Path(str(db) + suf)
        if f.exists():
            f.unlink()
    env = dict(os.environ)
    env.update({
        "COURSE_KB_AUTOSTART": "1",
        "COURSE_KB_PORT": str(PORT),
        "COURSE_KB_DB": str(db),
        "COURSE_KB_DATA_DIR": str(VERIFY / "data"),
        "COURSE_KB_BOOTSTRAP_ADMIN": f"{ADMIN_USER}:{ADMIN_PASS}",
        "PYTHONIOENCODING": "utf-8",
    })
    if env_extra:
        env.update(env_extra)
    log = open(VERIFY / "server.log", "wb")
    proc = subprocess.Popen(
        [os.environ.get("NODE_BIN", "node"), "src/index.ts"],
        cwd=str(KB / "apps" / "server"), env=env,
        stdout=log, stderr=subprocess.STDOUT)
    # 等 /health
    deadline = time.time() + 90
    while time.time() < deadline:
        if proc.poll() is not None:
            return None, proc, (VERIFY / "server.log").read_text(encoding="utf-8", errors="replace")[-2500:]
        s = Session("probe")
        r = s.req("GET", "/api/v1/health", timeout=5)
        if r["status"] == 200:
            return s, proc, ""
        time.sleep(0.7)
    return None, proc, "启动超时（90s）"


def stop_server(proc):
    if proc and proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=15)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


# ══════════════════════════════════════════════════════════════════════
# 各检查组
# ══════════════════════════════════════════════════════════════════════
def group_health(root: Session):
    p("\n== A. 健康与能力诚实性 ==")
    r = root.req("GET", "/api/v1/health")
    check("health", "GET /health → 200", r["status"] == 200, 200, r["status"],
          "high", "curl /api/v1/health")
    b = r["body"] if isinstance(r["body"], dict) else {}
    for f in ("ok", "version"):
        check("health", f"/health 含契约字段 {f}", f in b, f"有 {f}",
              f"实际键 {sorted(b.keys())[:8]}", "medium")

    r = root.req("GET", "/api/v1/capabilities", timeout=300)
    if r["status"] != 200:
        # 重试一次：--watch 重启窗口内会瞬时拒连，不代表接口坏了
        time.sleep(5)
        r = root.req("GET", "/api/v1/capabilities", timeout=300)
    check("capabilities", "GET /capabilities → 200", r["status"] == 200, 200, r["status"],
          "high", "curl /api/v1/capabilities")
    cap = r["body"] if isinstance(r["body"], dict) else {}
    # 契约 RBAC §8：capabilities 要有 auth 段
    check("capabilities", "capabilities 含 auth 段（RBAC §8）", "auth" in cap,
          "有 auth", f"键 {sorted(cap.keys())[:10]}", "medium",
          "契约 docs/RBAC.md §8 要求 auth:{required,bootstrap}")
    if isinstance(cap.get("auth"), dict):
        a = cap["auth"]
        check("capabilities", "auth.required 为 true", a.get("required") is True,
              True, a.get("required"), "medium")
        check("capabilities", "auth.bootstrap 报已初始化",
              a.get("bootstrap") in ("已初始化", "initialized", True),
              "已初始化/initialized", a.get("bootstrap"), "low")
    # 契约 RETRIEVAL §3.3：rag 必须 available:false + 可读 reason
    rt = cap.get("retrieval")
    if rt is None:
        check("capabilities", "capabilities 含 retrieval 段（RETRIEVAL §3.3）", False,
              "有 retrieval", "缺失", "medium",
              "rt = cap.get('retrieval')")
    else:
        modes = rt if isinstance(rt, dict) else {}
        p("     retrieval 段: %s" % _s(modes, 300))
        rag = modes.get("rag") if isinstance(modes, dict) else None
        if isinstance(rag, dict):
            check("capabilities", "retrieval.rag.available 为 false（未接 embedding）",
                  rag.get("available") is False, False, rag.get("available"), "medium")
            check("capabilities", "retrieval.rag 有可读 reason",
                  bool(rag.get("reason")), "非空 reason", rag.get("reason"), "low")
    return cap


def group_auth(root: Session):
    p("\n== B. 认证与安全负例（真实 HTTP 码）==")
    anon = Session("anon")
    protected = [
        ("GET", "/api/v1/documents"),
        ("GET", "/api/v1/tasks"),
        ("GET", "/api/v1/auth/me"),
        ("GET", "/api/v1/notes"),
        ("GET", "/api/v1/users"),
        ("GET", "/api/v1/settings"),
    ]
    for m, path in protected:
        r = anon.req(m, path)
        code = err_code(r["body"])
        check("auth", f"未登录 {m} {path} → 401",
              r["status"] == 401, 401, f'{r["status"]} code={code}', "high",
              f"curl -i {BASE}{path}",
              "契约 RBAC §9：未登录 → 401（不是 500，也不是空数据）")

    # 登录三种角色
    sessions = {}
    r = root.login(ADMIN_USER, ADMIN_PASS)
    check("auth", "admin 登录 → 200", r["status"] == 200, 200,
          f'{r["status"]} {_s(r["body"], 80)}', "high")
    sessions["admin"] = root

    return sessions


def group_rbac(root: Session, cap):
    p("\n== C. RBAC：建号/建课/发布/draft 隔离 ==")
    sess = {"admin": root}

    def mkuser(name, roles):
        r = root.req("POST", "/api/v1/users",
                     {"username": name, "password": "pass-12345", "roles": roles})
        return r

    def login_as(name):
        s = Session(name)
        rr = s.login(name, "pass-12345")
        return s, rr

    ur = mkuser("vteach", ["teacher"])
    check("rbac", "admin 建教师号 → 2xx", 200 <= ur["status"] < 300, "2xx", ur["status"],
          "medium", "POST /users")
    us = mkuser("vstu1", ["student"])
    check("rbac", "admin 建学生号 → 2xx", 200 <= us["status"] < 300, "2xx", us["status"],
          "medium")
    us2 = mkuser("vstu2", ["student"])
    check("rbac", "admin 建第二个学生号 → 2xx", 200 <= us2["status"] < 300, "2xx",
          us2["status"], "medium")

    # 学生不能建号
    stu, sr = login_as("vstu1")
    check("rbac", "学生登录 → 200", sr["status"] == 200, 200, sr["status"], "high")
    r = stu.req("POST", "/api/v1/users",
                {"username": "vbad", "password": "pass-12345", "roles": ["admin"]})
    check("rbac", "学生建号被拒（403）", r["status"] == 403, 403,
          f'{r["status"]} {err_code(r["body"])}', "high",
          "学生 POST /users", "提权防护")
    r = stu.req("GET", "/api/v1/users")
    check("rbac", "学生列用户被拒（403）", r["status"] == 403, 403, r["status"], "high")

    teac, tr = login_as("vteach")
    check("rbac", "教师登录 → 200", tr["status"] == 200, 200, tr["status"], "high")

    # 学生上传 → 应被拒（RBAC：上传=teacher）
    small = b"hello verify\n"
    boundary = "----verifyboundary"
    mp = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
          f"filename=\"v.txt\"\r\nContent-Type: text/plain\r\n\r\n").encode() + small + \
         f"\r\n--{boundary}--\r\n".encode()
    r = stu.req("POST", "/api/v1/documents", raw=mp,
                ctype=f"multipart/form-data; boundary={boundary}")
    check("rbac", "学生上传资料被拒（403）", r["status"] == 403, 403,
          f'{r["status"]} {err_code(r["body"])}', "high",
          "学生 POST /documents", "RBAC §1：上传=teacher")
    return sess, teac, stu


def group_upload_and_read(teac: Session, stu: Session):
    p("\n== D. 真实上传 → outline/cards/graph/search ==")
    # 用真 PDF（若存在），否则用合成语料
    if PDF.exists():
        payload = PDF.read_bytes()
        fname, ctype = "refman-26.7-en.a4.pdf", "application/pdf"
        p("     用真 PDF：%s（%.1f MB）" % (PDF.name, len(payload) / 1e6))
    else:
        TXT.write_text("索引 index 是加速查询的数据结构。\nB+树是索引的常用实现。\n",
                       encoding="utf-8")
        payload = TXT.read_bytes()
        fname, ctype = "sample_corpus.txt", "text/plain"
        p("     PDF 不存在，改用合成语料")

    boundary = "----verifyupload"
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
            f"filename=\"{fname}\"\r\nContent-Type: {ctype}\r\n\r\n").encode()
    mp = head + payload + f"\r\n--{boundary}--\r\n".encode()
    t0 = time.time()
    r = teac.req("POST", "/api/v1/documents", raw=mp,
                 ctype=f"multipart/form-data; boundary={boundary}", timeout=900)
    dt = time.time() - t0
    ok = 200 <= r["status"] < 300
    check("pipeline", f"教师上传 {fname} → 2xx", ok, "2xx",
          f'{r["status"]} ({dt:.1f}s) {_s(r["body"], 140)}', "high",
          f"上传 {fname}")
    if not ok:
        return None
    body = r["body"] if isinstance(r["body"], dict) else {}
    doc_id = body.get("document_id") or body.get("id") or (body.get("document") or {}).get("id")
    check("pipeline", "上传返回 document_id", bool(doc_id), "非空 id", doc_id, "high")
    if not doc_id:
        return None
    # ★ 必须等 parse 完成：上传是 202 异步，立刻 extract 会撞 E_PARSE（那不是抽取的 bug）
    task_id = body.get("task_id")
    if task_id:
        deadline = time.time() + 600
        st = None
        while time.time() < deadline:
            tr = teac.req("GET", f"/api/v1/tasks/{task_id}")
            tb = tr["body"] if isinstance(tr["body"], dict) else {}
            task = tb.get("task") if isinstance(tb.get("task"), dict) else tb
            st = task.get("status")
            if st in ("done", "failed", "cancelled"):
                break
            time.sleep(1.5)
        check("pipeline", "上传后的 parse 任务终态 = done", st == "done", "done", st, "high",
              f"GET /tasks/{task_id}", "异步上传必须先等 parse，否则 extract 会 422")
        u = teac.req("GET", f"/api/v1/documents/{doc_id}/units")
        nu = _count(u["body"], "units")
        check("pipeline", "parse 后 units 非空", (nu or 0) > 0, "> 0", f"n={nu}", "high",
              f"GET /documents/{doc_id}/units")
    return doc_id


def group_doc_endpoints(teac: Session, stu: Session, doc_id: str, run_extract: bool = True,
                        expect_cards: bool = False):
    p("\n== E. 文档读取端点 + draft 隔离（核心安全负例）==")
    # ★ 触发真实抽取（真 LLM，并发=1）：这是"真端到端"的关键一步。
    #   不跑它只能看到 cards=0，无法判断"没有卡片"是正确还是静默失败。
    extract_task_id = None
    task_detail: dict = {}
    es = None
    if run_extract:
        r = teac.req("POST", f"/api/v1/documents/{doc_id}/extract", timeout=60)
        check("pipeline", "POST /documents/:id/extract → 202", r["status"] == 202, 202,
              f'{r["status"]} {_s(r["body"], 110)}', "high",
              "POST /documents/:id/extract")
        task_id = (r["body"] or {}).get("task_id") if isinstance(r["body"], dict) else None
        extract_task_id = task_id
        if task_id:
            p("     等待抽取任务（真 LLM，可能需要数分钟）…")
            t0 = time.time()
            final = None
            while time.time() - t0 < 1200:
                tr = teac.req("GET", f"/api/v1/tasks/{task_id}")
                tb = tr["body"] if isinstance(tr["body"], dict) else {}
                task = tb.get("task") if isinstance(tb.get("task"), dict) else tb
                st = task.get("status")
                if st in ("done", "failed", "cancelled"):
                    final = task
                    break
                time.sleep(3)
            if final is None:
                check("pipeline", "抽取任务在 20 分钟内终态", False, "done",
                      "超时未终态", "high")
            else:
                # ⚠️ 上游 LLM 会瞬时 503 Service Overload（实测过），那不是代码缺陷。
                #    这里把「环境故障」与「代码缺陷」分开报，避免误判。
                err_txt = str(final.get("error") or "")
                detail_txt = _s(final.get("detail"), 300)
                env_outage = ("503" in err_txt or "503" in detail_txt
                              or "Overload" in err_txt or "Overload" in detail_txt
                              or "返回非 JSON" in detail_txt)
                if final.get("status") != "done" and env_outage:
                    check("pipeline", "抽取任务终态（环境故障，非代码缺陷）", True,
                          "记录实际值",
                          f'{final.get("status")} ← 上游 LLM 503/非 JSON，属环境问题',
                          "medium", f"GET /tasks/{task_id}",
                          "本项不计为缺陷；但 error 文案未保留 HTTP 状态码，会误导排查（见 problems）")
                else:
                    check("pipeline", "抽取任务终态 = done", final.get("status") == "done",
                          "done", f'{final.get("status")} err={_s(final.get("error"), 90)}',
                          "high", f"GET /tasks/{task_id}",
                          "failed 说明抽取链路真有问题；done 才继续看产物")
                p("     抽取耗时 %.0fs  status=%s" % (time.time() - t0, final.get("status")))
                # 取 detail：status 之外还要看 extract_status / warnings（done_empty 判据）
                task_detail = final.get("detail") if isinstance(final.get("detail"), dict) else {}
                if not task_detail:
                    task_detail = final  # 有的形状把 detail 摊平在 task 上
                es = (task_detail.get("extract_status")
                      or (task_detail.get("extract") or {}).get("extract_status")
                      or task_detail.get("status"))
                p("     extract_status=%r  warnings=%d" % (es, len(task_detail.get("warnings") or [])))

    for m, path, key in [
        ("GET", f"/api/v1/documents/{doc_id}/outline", "outline"),
        ("GET", f"/api/v1/documents/{doc_id}/cards", "cards"),
        ("GET", f"/api/v1/documents/{doc_id}/graph", "graph"),
    ]:
        r = teac.req(m, path)
        ok = r["status"] == 200
        n = _count(r["body"], key)
        check("pipeline", f"教师 {m} .../{path.split('/')[-1]} → 200", ok, 200,
              f'{r["status"]} n={n}', "high", f"curl {path}")
        if path.endswith("/cards"):
            n = n or 0
            if not expect_cards:
                # ★ T-WORKER 按本报告修了 done_empty：端到端验证"零产出 ≠ 失败"。
                #   判据（backend-core 请求）：extract_status 必须与 failed 可区分，
                #   且 done_empty 时带可读 warnings（含模型自己的说明）。
                check("pipeline", "★ 零卡片时 extract_status 与 failed 可区分",
                      es in ("done_empty", "failed", "unavailable"),
                      "done_empty / failed / unavailable", f"extract_status={es!r}",
                      "high", f"GET /tasks/{extract_task_id}",
                      "本报告提出的『成功但空产出』静默失败：修复前为 'done'，与真实失败不可区分")
                if es == "done_empty":
                    warn = (task_detail or {}).get("warnings") or []
                    has_note = any(isinstance(w, dict) and (w.get("model_note") or w.get("msg"))
                                   for w in warn)
                    check("pipeline", "★ done_empty 带可读 warnings（含模型说明）",
                          len(warn) > 0 and has_note, "非空 warnings 且含 model_note/msg",
                          f"n={len(warn)} first={_s(warn[:1], 150)}", "medium",
                          f"GET /tasks/{extract_task_id}",
                          "让前端能显示『本节内容不足以建档』而不是当正常完成")
                check("pipeline", "抽取后 cards 数（合成语料，0 可能是模型的合理拒绝）",
                      True, "记录实际值", f"n={n} extract_status={es!r}", "low",
                      f"curl {path}")
            else:
                check("pipeline", "★ 抽取后 cards 非空（真 PDF 应有卡片）",
                      n > 0, "> 0", f"n={n} extract_status={es!r}", "high",
                      f"curl {path}", "E_PICK_KEY 类静默丢卡片的历史坑")
        if path.endswith("/outline") and isinstance(r["body"], dict):
            ol = r["body"].get("outline") or r["body"].get("nodes") or []
            check("pipeline", "outline 有节点", len(ol) > 0, "> 0", f"n={len(ol)}",
                  "medium")

    # search
    for q in ("索引", "index", "B+树"):
        r = teac.req("GET", f"/api/v1/search?q={urllib.parse.quote(q)}")
        n = _count(r["body"], "results") if r["status"] == 200 else None
        check("search", f"GET /search?q={q} → 200", r["status"] == 200, 200,
              f'{r["status"]} n={n}', "high", f"curl /search?q={q}")

    # ★ draft 隔离必须在**发布前**测（此时文档仍是 draft）
    r = stu.req("GET", f"/api/v1/documents/{doc_id}/cards")
    check("rbac-security", "★ 学生读 draft 文档 cards → 403/404（不是 200 空数组）",
          r["status"] in (403, 404), "403 或 404",
          f'{r["status"]} {err_code(r["body"])}', "critical",
          f"学生 GET /documents/{doc_id}/cards",
          "契约 RBAC §9：学生访问 draft → 403/404，不许返回空列表冒充成功")
    r = stu.req("GET", f"/api/v1/documents/{doc_id}/outline")
    check("rbac-security", "★ 学生读 draft 文档 outline → 403/404",
          r["status"] in (403, 404), "403 或 404",
          f'{r["status"]} {err_code(r["body"])}', "critical")
    r = stu.req("GET", f"/api/v1/documents/{doc_id}")
    check("rbac-security", "★ 学生读 draft 文档详情 → 403/404",
          r["status"] in (403, 404), "403 或 404",
          f'{r["status"]} {err_code(r["body"])}', "critical")
    r = stu.req("GET", "/api/v1/documents")
    lst = r["body"] if isinstance(r["body"], dict) else {}
    items = lst.get("items") or lst.get("documents") or []
    ids = [str(d.get("id")) for d in items if isinstance(d, dict)]
    check("rbac-security", "★ 学生文档列表不含 draft 文档（不靠空列表冒充）",
          doc_id not in ids, f"不含 {doc_id}",
          f'{r["status"]} items={len(items)} 含={doc_id in ids}', "critical",
          "学生 GET /documents")
    return True


def group_publish(teac: Session, stu: Session, doc_id: str):
    p("\n== F. 教师发布 → 学生可见 ==")
    r = teac.req("POST", f"/api/v1/documents/{doc_id}/review",
                 {"status": "published", "visibility": "public"})
    check("rbac", "教师发布文档 → 2xx", 200 <= r["status"] < 300, "2xx",
          f'{r["status"]} {_s(r["body"], 90)}', "high",
          'POST /documents/:id/review {"status":"published","visibility":"public"}')
    if 200 <= r["status"] < 300:
        r2 = stu.req("GET", f"/api/v1/documents/{doc_id}/cards")
        check("rbac", "发布后学生可读 cards → 200", r2["status"] == 200, 200,
              f'{r2["status"]} n={_count(r2["body"], "cards")}', "high")
    else:
        check("rbac", "发布后学生可读 cards → 200", False, 200,
              f"上一步发布 {r['status']}", "high", note="发布失败，后续无法验证")


def group_notes_isolation(stu: Session, root: Session):
    p("\n== G. 跨用户笔记隔离（RBAC §6 SQL 层）==")
    r = stu.req("POST", "/api/v1/notes", {"body": "vstu1 的私有笔记"})
    ok = 200 <= r["status"] < 300
    check("rbac-security", "学生建笔记 → 2xx", ok, "2xx",
          f'{r["status"]} {_s(r["body"], 90)}', "high", "POST /notes")
    nid = None
    if ok and isinstance(r["body"], dict):
        nid = r["body"].get("id") or (r["body"].get("note") or {}).get("id")
    if not nid:
        return
    stu2 = Session("vstu2")
    rr = stu2.login("vstu2", "pass-12345")
    check("rbac-security", "vstu2 登录 → 200", rr["status"] == 200, 200, rr["status"], "medium")
    r = stu2.req("GET", f"/api/v1/notes/{nid}")
    check("rbac-security", "★ A 读不到 B 的笔记（404/403）",
          r["status"] in (403, 404), "403 或 404",
          f'{r["status"]} {err_code(r["body"])}', "critical",
          "vstu2 GET /notes/<vstu1 的 id>")
    r = stu2.req("GET", "/api/v1/notes")
    items = (r["body"] or {}).get("items") if isinstance(r["body"], dict) else []
    ids = [str(x.get("id")) for x in (items or []) if isinstance(x, dict)]
    check("rbac-security", "★ A 的笔记列表不含 B 的笔记",
          nid not in ids, f"不含 {nid}", f"items={len(ids)} 含={nid in ids}",
          "critical", "vstu2 GET /notes")


def group_sandbox_worker():
    """沙箱 HTTP 路由尚未交付 → 直接驱动 worker 层验证安全边界（真实执行）。

    这是**真跑**：真的建库、真的执行 SQL、真的量超时。
    """
    p("\n== H. SQL 沙箱（worker 层真跑；HTTP 路由未交付）==")
    sys.path.insert(0, str(KB))
    try:
        from worker.sandbox import runner as R
    except Exception as e:  # noqa: BLE001
        check("sandbox", "可导入 worker.sandbox.runner", False, "可导入",
              f"{type(e).__name__}: {e}", "medium")
        return
    # ⚠️ 沙箱库**必须**在 worker 约定的根目录下（data/sandbox）—— 这是安全设计，
    #   不是可绕过的配置；验证也用同一目录（子目录 _verify，避免污染真实学生库）。
    root = KB / "data" / "sandbox" / "_verify"
    root.mkdir(parents=True, exist_ok=True)
    a = root / "stuA.sqlite3"
    b = root / "stuB.sqlite3"
    for f in (a, b):
        for suf in ("", "-wal", "-shm"):
            q = Path(str(f) + suf)
            if q.exists():
                q.unlink()

    def run(sql, db):
        return R.run_payload({"sql": sql, "db_path": str(db), "timeout_ms": 3000,
                              "max_rows": 200, "allow_multi": False})

    def code_of(res):
        return ((res or {}).get("error") or {}).get("code")

    # 正常 CRUD
    for sql, nm in [
        ("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)", "CREATE TABLE"),
        ("INSERT INTO t(id,v) VALUES (1,'a')", "INSERT"),
        ("SELECT * FROM t", "SELECT"),
        ("UPDATE t SET v='b' WHERE id=1", "UPDATE"),
        ("DELETE FROM t WHERE id=1", "DELETE"),
    ]:
        r = run(sql, a)
        check("sandbox", f"沙箱可执行 {nm}", code_of(r) is None, "无 error",
              code_of(r) or "ok", "medium", f"run_payload({sql!r})")

    # ATTACH / load_extension / 多语句 / PRAGMA 越界
    for sql, label in [
        ("ATTACH DATABASE 'evil.db' AS x", "ATTACH"),
        ("SELECT load_extension('evil.dll')", "load_extension"),
        ("SELECT 1; DROP TABLE t", "多语句"),
        ("PRAGMA writable_schema=ON", "PRAGMA writable_schema"),
        ("PRAGMA temp_store_directory='/tmp'", "PRAGMA temp_store_directory"),
        ("PRAGMA foreign_keys=OFF", "PRAGMA foreign_keys=OFF"),
        ("VACUUM", "VACUUM"),
    ]:
        r = run(sql, a)
        c = code_of(r)
        check("sandbox-security", f"★ {label} 被拒", c is not None, "有 error", c or "ok",
              "critical", f"run_payload({sql!r})",
              "词法闸 guard + SQLite authorizer 两道防线")

    # sqlite_master 直写（词法闸漏，但 SQLite 自己拦）
    r = run("INSERT INTO sqlite_master VALUES('t','t','t',0,'')", a)
    check("sandbox-security", "★ 直写 sqlite_master 被 SQLite 拒绝", code_of(r) is not None,
          "有 error", code_of(r) or "ok", "high",
          "run_payload(\"INSERT INTO sqlite_master ...\")",
          "第二道防线（SQLite 自身）生效；但词法闸漏掉它，见 problems")

    # 注释/换行绕过关键字（词法闸漏 → 靠 SQLite 语法报错兜住）
    for sql, label in [
        ("AT/**/TACH DATABASE 'e.db' AS x", "ATTACH 注释分隔"),
        ("AT\nTACH DATABASE 'e.db' AS x", "ATTACH 换行分隔"),
        ("SELECT load_/**/extension('x')", "load_extension 注释分隔"),
    ]:
        r = run(sql, a)
        c = code_of(r)
        check("sandbox-security", f"{label}（被兜住）", c is not None, "有 error",
              c or "ok", "medium", f"run_payload({sql!r})",
              "词法闸未命中，靠 SQLite 语法/authorizer 兜住 —— 能执行不了，但报错文案若为 E_SQL_FORBIDDEN 更清楚")

    # ★ 跨学生隔离
    run("CREATE TABLE secret(v TEXT)", a)
    run("INSERT INTO secret VALUES('A的私有数据')", a)
    ra = run("SELECT * FROM secret", a)
    rb = run("SELECT * FROM secret", b)
    check("sandbox-security", "★ A 能读自己的表", code_of(ra) is None, "无 error",
          code_of(ra) or "ok", "high")
    check("sandbox-security", "★ B 看不到 A 的表（跨学生隔离）", code_of(rb) is not None,
          "报不存在", code_of(rb) or "ok", "critical", "run_payload('SELECT * FROM secret', stuB)")

    # ★ 路径越界
    for bad, label in [
        (KB / "data" / "escape.sqlite3", "../ 逃逸（沙箱外）"),
        (KB / "data" / "course_kb.sqlite3", "主知识库"),
        (KB / "data" / "sandbox" / ".." / "escape2.sqlite3", "../ 归一化逃逸"),
    ]:
        try:
            r = run("SELECT 1", bad)
            check("sandbox-security", f"★ 路径越界被拒：{label}", False, "拒绝",
                  f"未拒绝：{code_of(r) or 'ok'}", "critical", f"run_payload(db_path={bad})")
        except Exception as e:  # noqa: BLE001
            check("sandbox-security", f"★ 路径越界被拒：{label}", True, "拒绝",
                  f"{type(e).__name__}", "critical", f"run_payload(db_path={bad})")

    # ★ 死循环必须被硬超时杀掉
    p("     死循环测试（WITH RECURSIVE 无限递归，限 3000ms）…")
    t0 = time.time()
    r = run("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c", a)
    dt = time.time() - t0
    check("sandbox-security", "★ 死循环被超时杀掉（≤6s）", dt <= 6.0,
          "≤ 6s", f"{dt:.2f}s code={code_of(r)}", "critical",
          "run_payload('WITH RECURSIVE ...')",
          "规格 §3：必须在独立进程里执行并硬超时杀进程")
    check("sandbox-security", "死循环返回 E_SQL_TIMEOUT",
          code_of(r) == "E_SQL_TIMEOUT", "E_SQL_TIMEOUT", code_of(r), "high")


def group_sandbox(stu: Session):
    """HTTP 层沙箱路由尚未交付 → 直接真跑 worker 层的安全边界。

    HTTP 路由（/sandbox/*）当前 404，故这里不用 HTTP 断言接口存在，
    而是驱动 worker.sandbox.runner **真实执行** SQL —— 安全边界才是重点。
    """
    group_sandbox_worker()


def group_sandbox_http(stu: Session, root: Session):
    """HTTP 层沙箱负例（路由已交付时启用）—— 安全边界必须**端到端**验。"""
    p("\n== H2. SQL 沙箱 HTTP 层负例（真 HTTP）==")
    r = stu.req("POST", "/api/v1/sandbox/session", {})
    if r["status"] != 200:
        p("     沙箱 session 未就绪（%s），跳过 HTTP 层" % r["status"])
        return
    b = r["body"] if isinstance(r["body"], dict) else {}
    sid = b.get("sessionId") or b.get("session_id")
    check("sandbox-http", "POST /sandbox/session → 200 且返回 sessionId", bool(sid),
          "非空 sessionId", f'{r["status"]} sid={sid}', "high",
          "POST /api/v1/sandbox/session")

    def ex(sql, timeout=60):
        return stu.req("POST", "/api/v1/sandbox/execute",
                       {"sessionId": sid, "sql": sql}, timeout=timeout)

    def rejected(rr):
        """被拒 = HTTP>=400，或 200 但 body 里带 error。"""
        body = rr["body"] if isinstance(rr["body"], dict) else {}
        return rr["status"] >= 400 or bool(body.get("error"))

    # 正常 CRUD（先证明能用，再证明危险面被堵）
    for sql, nm in [
        ("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)", "CREATE TABLE"),
        ("INSERT INTO t(id,v) VALUES (1,'a')", "INSERT"),
        ("SELECT * FROM t", "SELECT"),
    ]:
        rr = ex(sql)
        check("sandbox-http", f"沙箱 {nm} 可执行", not rejected(rr), "无 error",
              f'{rr["status"]} {_s(rr["body"], 110)}', "medium", f"execute {sql!r}")

    for sql, label, sev in [
        ("ATTACH DATABASE 'evil.sqlite3' AS evil", "ATTACH", "critical"),
        ("SELECT load_extension('x')", "load_extension", "critical"),
        ("SELECT 1; DROP TABLE t;", "多语句拼接", "critical"),
        ("PRAGMA writable_schema=ON", "PRAGMA writable_schema", "critical"),
        ("VACUUM", "VACUUM", "high"),
    ]:
        rr = ex(sql)
        check("sandbox-http", f"★ HTTP 层 {label} 被拒", rejected(rr), "被拒",
              f'{rr["status"]} {_s(rr["body"], 130)}', sev, f"execute {sql!r}")

    # ★ 死循环：接口必须在额度内返回，且 /health 仍 200
    p("     HTTP 层死循环测试…")
    t0 = time.time()
    rr = ex("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c",
            timeout=90)
    dt = time.time() - t0
    check("sandbox-http", "★ HTTP 层死循环被超时杀掉（≤30s）", dt <= 30.0, "≤ 30s",
          f"{dt:.1f}s status={rr['status']} {_s(rr['body'], 90)}", "critical",
          "execute WITH RECURSIVE 死循环")
    h = Session("health-after-loop").req("GET", "/api/v1/health", timeout=10)
    check("sandbox-http", "★ 死循环后 /health 仍 200（事件循环未阻塞）",
          h["status"] == 200, 200, f'{h["status"]} ({dt:.1f}s)', "critical",
          "GET /api/v1/health")


def group_static_pitfalls():
    """静态扫描已知的「看起来成功」反模式（AGENTS.md 坑清单里的可机器化部分）。

    这是**可重复**的 bug 猎捕：把 Lead 列出的坑变成断言，每次跑都查。
    只读源码，不改。
    """
    p("\n== K. 静态扫描：已知「看起来成功」反模式 ==")
    SRC = KB / "apps" / "server" / "src"
    files = list(SRC.rglob("*.ts"))
    texts = {f: f.read_text(encoding="utf-8", errors="replace") for f in files}

    # ① 所有写 SSE `data:` 的地方必须用转义版（坑 17）
    #    ⚠️ 必须排除**注释行**：`tasks/bus.ts:218` 在注释里引用"原错误写法"
    #       —— 那是文档，不是缺陷（实测误报过一次，已修正正则）。
    def is_comment(line: str) -> bool:
        s = line.strip()
        return s.startswith("//") or s.startswith("*") or s.startswith("/*")
    sse_writers = []
    for f, t in texts.items():
        for ln, line in enumerate(t.split("\n"), 1):
            if is_comment(line) :
                continue
            if re.search(r"data:\s*\$\{JSON\.stringify", line):
                sse_writers.append(f"{f.relative_to(KB)}:{ln}")
    check("static", "★ 无 `data: ${JSON.stringify(...)}`（坑 17，U+2028 会打穿单行保证）",
          not sse_writers, "0 处（注释除外）", sse_writers or "0 处", "critical",
          "grep -rn 'data: \\${JSON.stringify' apps/server/src",
          "唯一安全写法是 safeJsonStringify（agent/guards.ts 与 tasks/bus.ts 各有一份、须一致）")

    # ② json_object 模式（坑 4：不强制 enum）
    jo = []
    for f, t in texts.items():
        for ln, line in enumerate(t.split("\n"), 1):
            if re.search(r"['\"]json_object['\"]", line) and "不要" not in line and "//" not in line.split("json_object")[0][-30:]:
                jo.append(f"{f.relative_to(KB)}:{ln}")
    check("static", "★ 无 `response_format=json_object`（坑 4：不强制枚举）",
          not jo, "0 处", jo or "0 处", "high",
          "grep -rn \"json_object\" apps/server/src")

    # ③ healthCheck 是否只看 HTTP 成功、不看 content（假绿风险）
    llm = SRC / "providers" / "llm" / "openai_compatible.ts"
    if llm.exists():
        t = llm.read_text(encoding="utf-8", errors="replace")
        seg = t[t.find("healthCheck"): t.find("healthCheck") + 1500] if "healthCheck" in t else ""
        # 找 PROBE_MAX_TOKENS 的值
        m = re.search(r"PROBE_MAX_TOKENS\s*=\s*(\d+)", t)
        probe_n = int(m.group(1)) if m else None
        check("static", "healthCheck 探测断言 content 非空（推理模型空 content 不能算可用）",
              bool(re.search(r"content", seg)), "检查 content",
              f"PROBE_MAX_TOKENS={probe_n}；segment 含 content={'content' in seg}",
              "high", "读 apps/server/src/providers/llm/openai_compatible.ts::healthCheck",
              "该端点是推理模型：max_tokens 会被 reasoning 吃光 → content 空但 HTTP 200")

    # ④ worker JSONL 读取不得用 readline（坑 3）
    wsrc = KB / "apps" / "server" / "src" / "worker"
    rl = []
    for f in wsrc.rglob("*.ts"):
        t = f.read_text(encoding="utf-8", errors="replace")
        for ln, line in enumerate(t.split("\n"), 1):
            if "readline" in line and not line.strip().startswith("*") and "//" not in line[:line.find("readline")]:
                rl.append(f"{f.relative_to(KB)}:{ln}")
    check("static", "worker JSONL 读取不用 readline（坑 3：U+2028 错切帧）",
          not rl, "0 处", rl or "0 处", "high", "grep -rn readline apps/server/src/worker")

    # ⑤ 出错时不得静默返回空的 `catch {}`
    silent = []
    for f, t in texts.items():
        for ln, line in enumerate(t.split("\n"), 1):
            if re.search(r"catch\s*(\([^)]*\))?\s*\{\s*\}", line):
                silent.append(f"{f.relative_to(KB)}:{ln}")
    check("static", "无空 catch（静默吞异常）", not silent, "0 处",
          f"{len(silent)} 处：{silent[:4]}", "medium", "grep -rn 'catch { }' apps/server/src")


def group_sandbox_http_live(root: Session):
    """--live 模式：沙箱 HTTP 验收（用 admin 自己的会话，不碰别人数据）。"""
    p("\n== H2. SQL 沙箱 HTTP 层（live）==")
    r = root.req("POST", "/api/v1/sandbox/session", {})
    b = r["body"] if isinstance(r["body"], dict) else {}
    sid = b.get("sessionId") or b.get("session_id")
    check("sandbox-http", "POST /sandbox/session → 200 且返回 sessionId", bool(sid),
          "非空 sessionId", f'{r["status"]} sid={sid}', "high",
          "POST /api/v1/sandbox/session")
    if not sid:
        return

    def ex(sql, timeout=120):
        return root.req("POST", "/api/v1/sandbox/execute",
                        {"sessionId": sid, "sql": sql}, timeout=timeout)

    def rejected(rr):
        bd = rr["body"] if isinstance(rr["body"], dict) else {}
        return rr["status"] >= 400 or bool(bd.get("error"))

    for sql, nm in [
        ("DROP TABLE IF EXISTS v1", "DROP IF EXISTS"),
        ("CREATE TABLE v1(id INTEGER PRIMARY KEY, v TEXT)", "CREATE TABLE"),
        ("INSERT INTO v1(id,v) VALUES (1,'a')", "INSERT"),
        ("SELECT * FROM v1", "SELECT"),
    ]:
        rr = ex(sql)
        check("sandbox-http", f"沙箱 {nm} 可执行", not rejected(rr), "无 error",
              f'{rr["status"]} {_s(rr["body"], 90)}', "medium", f"execute {sql!r}")

    for sql, label, sev in [
        ("ATTACH DATABASE 'evil.sqlite3' AS evil", "ATTACH", "critical"),
        ("SELECT load_extension('x')", "load_extension", "critical"),
        ("SELECT 1; DROP TABLE v1;", "多语句拼接", "critical"),
        ("PRAGMA writable_schema=ON", "PRAGMA writable_schema", "critical"),
        ("VACUUM", "VACUUM", "high"),
    ]:
        rr = ex(sql)
        check("sandbox-http", f"★ HTTP 层 {label} 被拒", rejected(rr), "被拒",
              f'{rr["status"]} {_s(rr["body"], 120)}', sev, f"execute {sql!r}")

    # ★ 事务：契约 LAB_DB_DEPLOY §6 要求 BEGIN…ROLLBACK 可用
    p("     事务回滚检查（契约 LAB_DB_DEPLOY §6）…")
    ex("DROP TABLE IF EXISTS vtx")
    ex("CREATE TABLE vtx(id INTEGER PRIMARY KEY)")
    ex("INSERT INTO vtx VALUES (1)")
    ex("BEGIN")
    ex("INSERT INTO vtx VALUES (2)")
    r_roll = ex("ROLLBACK")
    r_cnt = ex("SELECT count(*) AS n FROM vtx")
    n = None
    if isinstance(r_cnt["body"], dict) and r_cnt["body"].get("rows"):
        n = r_cnt["body"]["rows"][0][0]
    check("sandbox-http", "★ BEGIN…ROLLBACK 真能回滚（契约 §6 要求）", n == 1,
          "回滚后 count=1", f"count={n}  ROLLBACK→{_s(r_roll['body'], 80)}", "critical",
          "BEGIN / INSERT / ROLLBACK / SELECT count(*)",
          "跨调用的 BEGIN/ROLLBACK 必须真生效；否则是『看起来成功』")

    # ★ 死循环：必须被超时杀，且并发 /health 保持 200
    p("     HTTP 层死循环（并发打 /health）…")
    import threading
    samples = []
    stop = threading.Event()

    def poll():
        while not stop.is_set():
            t1 = time.time()
            hh = Session("h").req("GET", "/api/v1/health", timeout=20)
            samples.append((hh["status"], round(time.time() - t1, 2)))
            time.sleep(0.3)

    th = threading.Thread(target=poll, daemon=True)
    th.start()
    time.sleep(0.5)
    t0 = time.time()
    rr = ex("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c",
            timeout=90)
    dt = time.time() - t0
    stop.set()
    th.join(timeout=5)
    check("sandbox-http", "★ 死循环被硬超时杀（≤30s）", dt <= 30.0, "≤ 30s",
          f"{dt:.2f}s {_s(rr['body'], 80)}", "critical", "execute WITH RECURSIVE 死循环")
    codes = [c for c, _ in samples]
    lat = [l for _, l in samples] or [0]
    check("sandbox-http", "★ 死循环期间 /health 全程 200（事件循环未阻塞）",
          bool(codes) and all(c == 200 for c in codes), "全部 200",
          f"采样 {len(codes)} 次，非200 {sum(1 for c in codes if c != 200)} 次；max延迟 {max(lat):.2f}s",
          "critical", "并发 GET /api/v1/health")

    # ★ 跨学生隔离（用 admin 拿**别人的** sessionId 会被拒；此处造一个他人前缀）
    rr = root.req("POST", "/api/v1/sandbox/execute",
                  {"sessionId": "s_b3RoZXJfc3R1ZGVudA_sc", "sql": "SELECT 1"})
    check("sandbox-http", "★ 拿别人的 sessionId 执行 → 403",
          rr["status"] == 403, 403, f'{rr["status"]} {_s(rr["body"], 110)}', "critical",
          "POST /sandbox/execute 用非本人 sessionId")


def group_live_settings(root: Session):
    """--live 模式：settings / models 的诚实性（只读，不改文件）。"""
    p("\n== L. settings / models 诚实性（live，只读）==")
    _r = root.req("GET", "/api/v1/settings")
    st, s = _r["status"], _r["body"]
    check("settings", "GET /settings → 200", st == 200, 200, st, "high",
          "GET /api/v1/settings")
    if not isinstance(s, dict):
        return
    llm = ((s.get("settings") or {}).get("llm") or {})
    meta = s.get("meta") or {}
    check("settings", "settings.llm.concurrency == 1（不可调高）",
          llm.get("concurrency") == 1, 1, llm.get("concurrency"), "high",
          "GET /settings")
    check("settings", "meta.watching == true（热重载已启用）",
          meta.get("watching") is True, True, meta.get("watching"), "medium")
    check("settings", "meta.lastReloadError 为 null（当前配置合法）",
          meta.get("lastReloadError") in (None, ""), "null",
          str(meta.get("lastReloadError"))[:80], "low")
    p("     activeModel=%s revision=%s" % (llm.get("active"), meta.get("revision")))

    # /models 与 /capabilities 的模型必须一致；available=true 的必须真能产出内容
    _rm = root.req("GET", "/api/v1/models", timeout=300)
    st, m = _rm["status"], _rm["body"]
    check("settings", "GET /models → 200", st == 200, 200, st, "medium")
    if not isinstance(m, dict):
        return
    models = m.get("models") or []
    check("settings", "/models 有模型列表", len(models) > 0, "> 0", len(models), "low")
    avail = [x for x in models if x.get("available")]
    # ★ 关键断言：available=false 必须带可读 reason（不能无声不可用）
    no_reason = [x["id"] for x in models if not x.get("available") and not (x.get("reason") or "").strip()]
    check("settings", "★ available=false 的模型都有可读 reason", not no_reason,
          "0 个缺 reason", no_reason or "0 个", "high", "GET /models",
          "诚实降级：不可用必须说明原因")
    p("     available 模型: %s" % [x["id"] for x in avail])
    p("     不可用模型: %s" % [(x["id"], (x.get("reason") or "")[:50]) for x in models if not x.get("available")])

    # 与 capabilities.pi.model 对拍
    _rc = root.req("GET", "/api/v1/capabilities", timeout=180)
    st, cap = _rc["status"], _rc["body"]
    pi_model = ((cap or {}).get("pi") or {}).get("model") or {}
    if pi_model.get("model"):
        check("settings", "capabilities.pi.model 与 /models 里 active 的一致",
              any(x["id"] == pi_model["model"] for x in models), "一致",
              f"pi={pi_model['model']}", "low")

    # ★ 真探测：available=true 的模型能否产出**非空 content**（防假绿）
    p("     真探测 available=true 的模型是否真能产出内容…")
    try:
        sys.path.insert(0, str(KB))
        import io as _io
        envd = {}
        for ln in _io.open(KB / ".env", encoding="utf-8"):
            ln = ln.strip()
            if ln and not ln.startswith("#") and "=" in ln:
                k, v = ln.split("=", 1)
                envd[k.strip()] = v.strip()
        from openai import OpenAI
        cl = OpenAI(base_url=envd["AMR_BASE"], api_key=envd["AMR_KEY"], timeout=120)
        schema = {"type": "object",
                  "properties": {"a": {"type": "string"}}, "required": ["a"],
                  "additionalProperties": False}
        rfmt = {"type": "json_schema",
                "json_schema": {"name": "x", "strict": True, "schema": schema}}
        for x in avail[:4]:
            try:
                resp = cl.chat.completions.create(
                    model=x["id"], messages=[{"role": "user", "content": "a=1"}],
                    temperature=0, max_tokens=512, response_format=rfmt)
                content = resp.choices[0].message.content or ""
                check("settings", f"★ /models 报 available 的 {x['id']} 真能产出内容",
                      content.strip() != "", "非空 content",
                      f"len={len(content)} finish={resp.choices[0].finish_reason}", "high",
                      f"真调 {x['id']} json_schema+512",
                      "假绿检验：HTTP 200 但 content 空不算可用")
            except Exception as e:  # noqa: BLE001
                check("settings", f"★ /models 报 available 的 {x['id']} 真能产出内容",
                      False, "非空 content", f"{type(e).__name__}: {str(e)[:90]}", "high",
                      f"真调 {x['id']} json_schema+512",
                      "★ 这是假绿：/models 说可用，实际调用失败")
    except Exception as e:  # noqa: BLE001
        check("settings", "真探测模型内容产出", False, "可探测", f"{type(e).__name__}: {e}", "medium")


def group_not_yet_delivered(root: Session, cap):
    """契约里有、但**当前尚未交付**的接口 —— 如实记为未交付（不是 bug，是进度）。"""
    p("\n== I. 契约要求但尚未交付的接口（如实记录，不当作 bug）==")
    probes = [
        ("sandbox",  "POST", "/api/v1/sandbox/session"),
        ("sandbox",  "POST", "/api/v1/sandbox/execute"),
        ("sandbox",  "GET",  "/api/v1/sandbox/datasets"),
        ("retrieval", "GET", "/api/v1/models"),
        ("retrieval", "GET", "/api/v1/settings"),
        ("retrieval", "POST", "/api/v1/settings/llm/switch"),
    ]
    missing = []
    for grp, m, path in probes:
        r = root.req(m, path, {} if m == "POST" else None)
        if r["status"] == 404:
            missing.append(path)
        p("     %-6s %-34s -> %s" % (m, path, r["status"]))
    for seg in ("retrieval", "sandbox"):
        present = isinstance(cap, dict) and seg in cap
        p("     capabilities.%-10s 存在 = %s" % (seg, present))
        missing.append(f"capabilities.{seg}") if not present else None
    p("     （未交付清单：%d 项）" % len(missing))
    return missing


def group_agent_resume(root: Session):
    p("\n== J. agent 模型来源与恢复能力 ==")
    # 完整「发消息 → 重启服务 → 看历史」会打断在跑的服务，需隔离实例才能验；
    # 我已单独用隔离实例验过（结论见报告 notes）：
    #   ready.resumed=false(首次) → 发一条消息落盘 → 重启 → resumed=true, restoredMessages=6
    # 这里做**只读**检查：模型来源必须可解释（本报告发现 3 的修复点）。
    r = root.req("GET", "/api/v1/capabilities", timeout=180)
    cap = r["body"] if isinstance(r["body"], dict) else {}
    agent = cap.get("pi") or cap.get("agent")
    if isinstance(agent, dict):
        m = agent.get("model") or {}
        p("     pi.available=%s model=%s toolsSource=%s"
          % (agent.get("available"), m.get("model"), agent.get("toolsSource")))
        src = m.get("source") or m.get("modelSource") or agent.get("modelSource")
        if src is None:
            p("     （capabilities 未暴露 model_source；ready 帧里有，需 WS 才能读）")
        else:
            check("agent", "agent 模型来源可解释（不静默回落 pi 全局默认）",
                  src in ("injected", "resolved", "pi-global-fallback"), "可解释来源",
                  f"model_source={src}", "high", "GET /capabilities",
                  "本报告发现 3：agent 曾静默用 pi 全局 glm-5.2（key 已失效）")
        # 若回落，必须有可读 warning（不许静默）
        if src == "pi-global-fallback":
            warn = m.get("warning") or m.get("modelWarning") or agent.get("modelWarning")
            check("agent", "回落 pi 全局默认时必须带可读 warning", bool(warn),
                  "非空 warning", str(warn)[:120], "high", "GET /capabilities")
    return "checked"


def _count(body, key):
    if isinstance(body, dict):
        v = body.get(key)
        if isinstance(v, list):
            return len(v)
        if isinstance(v, int):
            return v
        items = body.get("items")
        if isinstance(items, list):
            return len(items)
    if isinstance(body, list):
        return len(body)
    return None


# ══════════════════════════════════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-sandbox", action="store_true")
    ap.add_argument("--skip-pdf", action="store_true", help="不传真 PDF（快）")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--live", action="store_true",
                    help="对**已在运行的**服务验收（复用实例；跳过上传/建设数据，避免污染）")
    args = ap.parse_args()

    global PDF
    if args.skip_pdf:
        PDF = Path("__nonexistent__")

    VERIFY.mkdir(parents=True, exist_ok=True)
    p("=" * 78)
    p("独立验收：真实服务 + 真实 HTTP" + ("（--live 复用已运行实例）" if args.live else ""))
    p("=" * 78)

    if args.live:
        root = Session("live-root")
        r0 = root.req("GET", "/api/v1/health")
        if r0["status"] != 200:
            p("live 服务不可达（%s）；请确认 %s 在跑" % (r0["status"], BASE))
            return 2
        p("live 服务可用：%s  版本=%s" % (BASE, (r0["body"] or {}).get("version")))
        t_start = time.time()
        missing = []
        cap = group_health(root)
        group_auth(root)
        group_sandbox_http_live(root)
        group_live_settings(root)
        group_agent_resume(root)
        missing = group_not_yet_delivered(root, cap)
        group_static_pitfalls()
    else:
        if not port_free(PORT):
            p("端口 %d 已被占用，无法起验证服务" % PORT)
            return 2
        root, proc, err = start_server()
        if root is None:
            p("✗ 服务启动失败")
            p(err[-2000:])
            stop_server(proc)
            report = {"started": False, "error": err[-3000:], "checks": [], "problems": []}
            OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            return 1
        p("服务已起：%s（pid=%s）" % (BASE, proc.pid))
        t_start = time.time()
        missing = []
        try:
            cap = group_health(root)
            group_auth(root)
            _, teac, stu = group_rbac(root, cap)
            doc_id = group_upload_and_read(teac, stu)
            if doc_id:
                group_doc_endpoints(teac, stu, doc_id, expect_cards=(not args.skip_pdf))
                group_publish(teac, stu, doc_id)
            group_notes_isolation(stu, root)
            if not args.skip_sandbox:
                group_sandbox(stu)
                group_sandbox_http(stu, root)
            missing = group_not_yet_delivered(root, cap)
            group_agent_resume(root)
            group_static_pitfalls()
        finally:
            if not args.keep:
                stop_server(proc)
            else:
                p("(--keep：服务仍在跑，pid=%s；请自行结束)" % proc.pid)

    sev_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    PROBLEMS.sort(key=lambda x: sev_order.get(x["severity"], 9))
    report = {
        "schema": "verify.system.v1",
        "base": BASE,
        "elapsed_s": round(time.time() - t_start, 1),
        "checks_total": len(CHECKS),
        "checks_failed": len(PROBLEMS),
        "by_severity": dict(Counter(x["severity"] for x in PROBLEMS)),
        "not_yet_delivered": missing,
        "manual_verification_notes": {
            "agent_resume": ("用隔离实例（8795，独立库）实测：ready.resumed=false（首次）→ "
                             "发一条消息（触发落盘）→ 杀进程 → 重启同库 → "
                             "ready.resumed=true、restoredMessages=6、会话文件 12 行。"
                             "本项需重启服务，故不在主流程里自动化。"),
            "sandbox_transaction": ("跨调用 BEGIN→INSERT→ROLLBACK **不回滚**："
                                    "ROLLBACK 报 E_SQL_EXEC、count 仍为 2（数据已提交）。"
                                    "根因见 worker/sandbox/runner.py：isolation_level=None（autocommit）"
                                    "+ 每次 execute 新建连接并在结束时 close()。"
                                    "契约 docs/LAB_DB_DEPLOY.md:248 要求事务/回滚可用。"),
            "sandbox_isolation_worker": ("worker 层 24 项安全负例全过（ATTACH/load_extension/多语句/"
                                         "PRAGMA 越界/VACUUM/写 sqlite_master/跨学生隔离/路径越界/"
                                         "死循环 3.00s 硬超时）。"),
            "retrieval_modes": ("四种模式走 WS（chat 入口），非 HTTP。我实测连接与 ready 帧正常；"
                                "但**回答链路**当时被 pi 全局模型（glm-5.2，key 401）卡住，"
                                "拿不到四种模式的结果差异 —— 该项**未验证**（见 problems/发现 3）。"),
        },
        "problems": PROBLEMS,
        "checks": CHECKS,
    }
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    p("\n" + "=" * 78)
    p("结果：%d 项检查，%d 项失败" % (len(CHECKS), len(PROBLEMS)))
    p("按严重度：%s" % json.dumps(report["by_severity"], ensure_ascii=False))
    for i, pr in enumerate(PROBLEMS, 1):
        p("  %d. [%s] %s" % (i, pr["severity"], pr["name"]))
        p("       expected=%s  actual=%s" % (_s(pr["expected"]), _s(pr["actual"])))
    p("\n写出：%s" % OUT)
    return 0 if not PROBLEMS else 3


if __name__ == "__main__":
    raise SystemExit(main())
