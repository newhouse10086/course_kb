# -*- coding: utf-8 -*-
"""沙箱 **job 级**测试（真子进程 + 真 JSONL 协议）。

验证的是 Node 实际会看到的东西：``sandbox.*`` 的入参/出参形状、退出码、
以及"学生 SQL 报错不算 job 失败"这一语义（错误在 ``data.error`` 里，exit 仍为 0）。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def run_cli(job: str, payload: dict | None = None, timeout: int = 120,
            env_extra: dict | None = None):
    blob = json.dumps({"job": job, **(payload or {})}, ensure_ascii=False)
    args = [sys.executable, "-m", "worker.cli", "--job", job]
    if len(blob) < 7000:
        args += ["--in", blob]
    # ★ 敌意环境（清掉 PYTHONIOENCODING/PYTHONUTF8）：中文 payload 走 stdin 是推荐通道，
    #   必须证明"不靠调用方的 env 也正确"（历史上这个 bug 被正确 env 掩盖过）
    env = {k: v for k, v in os.environ.items()
           if k.upper() not in ("PYTHONIOENCODING", "PYTHONUTF8")}
    env["PYTHONUTF8"] = "0"
    env.update(env_extra or {})
    proc = subprocess.run(args, input=(blob if len(blob) >= 7000 else None),
                          capture_output=True, cwd=str(ROOT), timeout=timeout, text=True,
                          encoding="utf-8", env=env)
    events = [json.loads(ln) for ln in proc.stdout.split("\n") if ln.strip()]
    results = [e for e in events if e["type"] == "result"]
    return proc.returncode, (results[-1]["data"] if results else None), (events[-1] if events else None)


@pytest.fixture()
def sandbox_root(tmp_path: Path) -> str:
    root = tmp_path / "sandbox"
    root.mkdir(parents=True, exist_ok=True)
    return str(root)


@pytest.fixture()
def session(sandbox_root: str) -> dict:
    ids = {"user_id": "u_cli", "session_id": "lab1", "root": sandbox_root}
    code, data, _ = run_cli("sandbox.init", {**ids, "dataset": "sc"})
    assert code == 0
    assert data["created"] is True
    return ids


# ═══════════════════════════════════════════════════════════════════════
# 引擎上报
# ═══════════════════════════════════════════════════════════════════════
def test_engines_job_reports_honestly(sandbox_root: str) -> None:
    code, data, _ = run_cli("sandbox.engines", {"root": sandbox_root})
    assert code == 0
    assert data["defaultEngine"] == "sqlite"
    engines = {e["id"]: e for e in data["engines"]}
    assert engines["sqlite"]["available"] is True
    caps = engines["sqlite"]["capabilities"]
    assert caps["crud"] is True and caps["ddl"] is True and caps["procedures"] is False
    assert caps["maxRowsDefault"] == 200
    # ★ 事务：结构化上报（same_call 可以，cross_call 不行 + 给出可用参数）
    assert caps["transactions"]["same_call"] is True
    assert caps["transactions"]["cross_call"] is False
    assert caps["transactions"]["batch_param"] == "multi"
    for eid in ("mysql", "postgres", "opengauss"):
        assert engines[eid]["available"] is False
        assert engines[eid]["reason"], "不可用必须给可读原因"
        assert "LAB_DB_DEPLOY" in engines[eid]["reason"], "原因要指向文档章节"
    sources = {s["id"]: s for s in data["logSources"]}
    assert sources["sqlite"] == {"id": "sqlite", "layers": ["L1"], "available": True,
                                "note": sources["sqlite"]["note"]}
    assert sources["postgres"]["layers"] == [] and sources["postgres"]["available"] is False


def test_unknown_engine_is_rejected(sandbox_root: str) -> None:
    code, _data, last = run_cli("sandbox.init", {"user_id": "u1", "session_id": "s1",
                                                 "engine": "oracle", "root": sandbox_root})
    assert code == 1
    assert last["code"] == "E_ENGINE_UNKNOWN" and "sqlite" in last["detail"]


def test_unavailable_engine_never_pretends(sandbox_root: str) -> None:
    code, _data, last = run_cli("sandbox.init", {"user_id": "u1", "session_id": "s1",
                                                 "engine": "postgres", "root": sandbox_root})
    assert code == 1
    assert last["code"] == "E_ENGINE_UNAVAILABLE"
    assert "LAB_DB_DEPLOY" in last["detail"]


# ═══════════════════════════════════════════════════════════════════════
# 数据集 / 会话
# ═══════════════════════════════════════════════════════════════════════
def test_datasets_job(sandbox_root: str) -> None:
    code, data, _ = run_cli("sandbox.datasets", {})
    assert code == 0
    assert data["default"] == "sc"
    assert [d["id"] for d in data["datasets"]] == ["employees", "orders", "sc"]
    assert data["datasets"][2]["tables"] == ["students", "courses", "enrollments"]


def test_init_and_reset(session: dict) -> None:
    code, data, _ = run_cli("sandbox.schema", {**session, "with_text": True})
    assert code == 0
    assert data["dialect"] == "sqlite"
    assert [t["name"] for t in data["tables"]] == ["courses", "enrollments", "students"]
    assert "students（6 行）" in data["text"]

    # 搞坏 → reset 真恢复
    run_cli("sandbox.exec", {**session, "sql": "DROP TABLE enrollments"})
    run_cli("sandbox.exec", {**session, "sql": "CREATE TABLE junk(x)"})
    code, data, _ = run_cli("sandbox.reset", {**session, "dataset": "sc"})
    assert code == 0
    assert data["dataset"] == "sc"
    assert [t["name"] for t in data["schema"]["tables"]] == ["courses", "enrollments", "students"]


# ═══════════════════════════════════════════════════════════════════════
# 执行（CRUD / 事务 / 报错 / 超时）
# ═══════════════════════════════════════════════════════════════════════
def test_exec_crud_over_cli(session: dict) -> None:
    code, d, _ = run_cli("sandbox.exec", {**session, "sql":
                        "CREATE TABLE t_cli(id INTEGER PRIMARY KEY, v TEXT)"})
    assert code == 0 and d["ok"] is True and d["statementKind"] == "CREATE"
    code, d, _ = run_cli("sandbox.exec", {**session, "sql":
                        "INSERT INTO t_cli(v) VALUES('a'),('b')"})
    assert d["affected"] == 2
    code, d, _ = run_cli("sandbox.exec", {**session, "sql": "SELECT v FROM t_cli ORDER BY id"})
    assert d["columns"] == ["v"] and d["rows"] == [["a"], ["b"]]
    code, d, _ = run_cli("sandbox.exec", {**session, "sql": "UPDATE t_cli SET v='B' WHERE id=2"})
    assert d["affected"] == 1
    code, d, _ = run_cli("sandbox.exec", {**session, "sql": "DELETE FROM t_cli WHERE id=1"})
    assert d["affected"] == 1
    code, d, _ = run_cli("sandbox.exec", {**session, "sql": "SELECT COUNT(*) AS n FROM t_cli"})
    assert d["rows"] == [[1]]


def test_single_statement_tx_control_rejected_via_cli(session: dict) -> None:
    """★ 单发事务控制 → `E_SQL_UNSUPPORTED`（HTTP/CLI 两侧语义一致，且**不是学生的错**）。"""
    for sql in ("BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT sp1"):
        code, d, _ = run_cli("sandbox.exec", {**session, "sql": sql})
        assert code == 0, sql                       # 仍然是"这条 SQL 失败"，不是 job 失败
        assert d["ok"] is False, sql
        assert d["error"]["code"] == "E_SQL_UNSUPPORTED", sql
        assert d["error"]["who"] == "rules"
        assert d["txUnsupported"] is True
        assert "multi" in d["error"]["hint"]
    # 数据没被动过
    code, d, _ = run_cli("sandbox.exec", {**session, "sql": "SELECT COUNT(*) AS n FROM students"})
    assert d["rows"] == [[6]]


def test_exec_transaction_batch(session: dict) -> None:
    code, d, _ = run_cli("sandbox.exec", {**session, "multi": True,
                        "sql": "BEGIN; INSERT INTO students(sid,sname) VALUES(777,'批'); ROLLBACK;"})
    assert code == 0 and d["ok"] is True
    assert [s["kind"] for s in d["statements"]] == ["BEGIN", "INSERT", "ROLLBACK"]
    code, d, _ = run_cli("sandbox.exec", {**session, "sql": "SELECT COUNT(*) AS n FROM students"})
    assert d["rows"] == [[6]]


def test_sql_error_is_not_a_job_failure(session: dict) -> None:
    """★ 学生写错 SQL **不是 job 失败**：exit=0，错误在 data.error 里（Node 展示给学生）。"""
    code, d, _ = run_cli("sandbox.exec", {**session, "sql": "SELECT * FROM student"})
    assert code == 0
    assert d["ok"] is False
    assert d["error"]["message"] == "no such table: student"     # 引擎原文
    assert d["error"]["code"] == "E_SQL_NO_OBJECT"
    assert d["error"]["localReading"] == "表 student 不存在"
    assert d["columns"] == [] and d["rowCount"] == 0


def test_dangerous_sql_via_cli(session: dict) -> None:
    for sql, want in [("ATTACH '/tmp/x.sqlite3' AS o", "E_SQL_FORBIDDEN"),
                      ("SELECT 1; DROP TABLE students", "E_SQL_MULTI"),
                      ("PRAGMA writable_schema=ON", "E_SQL_FORBIDDEN"),
                      ("VACUUM INTO '/tmp/y'", "E_SQL_KIND")]:
        code, d, _ = run_cli("sandbox.exec", {**session, "sql": sql})
        assert code == 0, sql
        assert d["ok"] is False and d["error"]["code"] == want, (sql, d["error"])
    # 库没被改坏
    code, d, _ = run_cli("sandbox.exec", {**session, "sql": "SELECT COUNT(*) AS n FROM students"})
    assert d["rows"] == [[6]]


def test_timeout_is_hard_killed_via_cli(session: dict) -> None:
    sql = ("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT COUNT(*) FROM c")
    code, d, _ = run_cli("sandbox.exec", {**session, "sql": sql, "timeout_ms": 1200})
    assert code == 0
    assert d["error"]["code"] == "E_SQL_TIMEOUT"
    assert d["killedBy"] in ("progress", "process")
    assert d["error"]["code"] == "E_SQL_TIMEOUT"
    # 超时后 CLI 仍能立刻服务（进程没被拖死）
    code, d2, _ = run_cli("sandbox.exec", {**session, "sql": "SELECT 1 AS alive"})
    assert code == 0 and d2["rows"] == [[1]]


def test_path_escape_is_usage_error(session: dict, tmp_path: Path) -> None:
    """客户端给的 ``db_path`` **不被信任**：与 (user, session) 推导值不一致就拒。

    （沙箱库只能落在 ``data/sandbox/<user>/<session>.sqlite3`` —— 传别的路径既不能生效，
      也不要静默忽略，否则调用方以为自己在操作某个库、其实操作的是另一个。）
    """
    code, _d, last = run_cli("sandbox.exec", {
        **session, "db_path": str(tmp_path / ".." / "course-kb.sqlite3"), "sql": "SELECT 1"})
    assert code == 2
    assert last["code"] == "E_SANDBOX_PATH"
    assert "不一致" in last["msg"] and "data/sandbox/<user>/<session>.sqlite3" in last["msg"]

    # 路径穿越同样被拒（不经引擎推导的那条路）
    code2, _d2, last2 = run_cli("sandbox.schema", {
        **session, "db_path": str(tmp_path / ".." / ".." / "course-kb.sqlite3")})
    assert code2 == 2 and last2["code"] == "E_SANDBOX_PATH"


# ═══════════════════════════════════════════════════════════════════════
# 历史 / 日志（S4 的两块数据 + 隔离）
# ═══════════════════════════════════════════════════════════════════════
def test_history_shape_for_s4(session: dict) -> None:
    run_cli("sandbox.exec", {**session, "sql": "SELECT 1 AS one"})
    run_cli("sandbox.exec", {**session, "sql": "SELECT * FROM 不存在"})
    code, data, _ = run_cli("sandbox.history", {**session, "limit": 5})
    assert code == 0
    recs = data["records"]
    assert [r["ok"] for r in recs] == [True, False]
    assert set(recs[0]) >= {"at", "sql", "ok", "rowCount", "elapsedMs"}
    assert recs[1]["error"].startswith("no such table")
    assert recs[0]["sql"] == "SELECT 1 AS one"


def test_history_cross_user_is_forbidden(session: dict) -> None:
    code, _d, last = run_cli("sandbox.history", {**session, "request_user_id": "u_other"})
    assert code == 1
    assert last["code"] == "E_LOG_ISOLATION"


def test_empty_session_logs_are_honest(session: dict) -> None:
    """★ 没执行过任何 SQL 的会话：entries 为空、status=empty、且**不能说成读不到**。"""
    code, data, _ = run_cli("sandbox.logs", {**session, "with_text": True})
    assert code == 0
    assert data["count"] == 0 and data["entries"] == []
    assert data["status"] == "empty"
    assert "可读" in data["fact"] and "≠" in data["fact"]
    assert data["auditLogged"] is True
    assert "不等于读不到日志" in data["text"]


def test_unavailable_engine_logs_are_honest(session: dict) -> None:
    """mysql 日志源未接入 → status=unavailable + 可读原因（不假装）。"""
    code, data, _ = run_cli("sandbox.logs", {**session, "engine": "mysql"})
    assert code == 0
    assert data["status"] == "unavailable" and data["entries"] == []
    assert "读不到" in data["fact"] and "LAB_DB_DEPLOY" in data["fact"]


def test_logs_job_shape_and_isolation(session: dict) -> None:
    run_cli("sandbox.exec", {**session, "sql": "SELECT 'x' AS a"})
    run_cli("sandbox.exec", {**session, "sql": "SELECT * FROM nope"})
    code, data, _ = run_cli("sandbox.logs", {**session, "limit": 10, "with_text": True})
    assert code == 0
    assert data["source"]["layers"] == ["L1"] and data["source"]["available"] is True
    # ★ 精确表述：不是"拿不到"，是**嵌入式引擎根本没有这两层**
    assert "没有** L2/L3" in data["boundary"]
    assert "不是权限或网络问题" in data["boundary"]
    assert data["status"] == "ok" and "读到了" in data["fact"]
    errors = [e for e in data["entries"] if e["level"] == "error"]
    assert errors and errors[-1]["message"] == "no such table: nope"
    assert errors[-1]["source"] == "L1" and errors[-1]["sessionId"] == "lab1"
    assert "no such table: nope" in data["text"]

    code, _d, last = run_cli("sandbox.logs", {**session, "request_user_id": "u_other"})
    assert code == 1 and last["code"] == "E_LOG_ISOLATION"

# ═══════════════════════════════════════════════════════════════════════
# ① 多引擎契约（本机可验部分）：未安装引擎 → 明确错误，**不静默回退 sqlite**
# ═══════════════════════════════════════════════════════════════════════
@pytest.mark.parametrize("engine", ["mysql", "postgres", "opengauss"])
def test_unavailable_engine_never_falls_back_to_sqlite(tmp_path, engine: str) -> None:
    """★ 指定未安装引擎必须**明确失败**，绝不静默回退 sqlite。

    静默回退 = 学生以为在练 PG、其实在练 SQLite —— 典型"看起来成功"。
    判据不只是错误码：**沙箱目录里不许出现任何 sqlite 文件**（回退的物理证据）。
    """
    root = tmp_path / "sbroot"
    code, d, last = run_cli("sandbox.exec", {"engine": engine, "user_id": "u1",
                                             "session_id": "s1", "root": str(root),
                                             "sql": "SELECT 1"})
    assert code == 1, d
    assert last["code"] == "E_ENGINE_UNAVAILABLE"
    assert engine in last["msg"]
    detail = str(last.get("detail", ""))
    assert "deploy-lab-db" in detail or "LAB_DB_DEPLOY" in detail
    files = [p for p in root.rglob("*") if p.is_file()] if root.exists() else []
    assert files == [], f"出现文件 → 疑似静默回退到 sqlite：{files}"


def test_engine_and_dialect_labels_match_actual_engine(tmp_path) -> None:
    """①-3 方言标注：engine/dialect 字段必须与实际执行的引擎一致。"""
    root = tmp_path / "sbroot"
    base = {"engine": "sqlite", "user_id": "u1", "session_id": "s1", "root": str(root),
            "dataset": "sc"}
    code, init, _ = run_cli("sandbox.init", base)
    assert code == 0 and init["engine"] == "sqlite" and init["dialect"] == "sqlite"
    code, sch, _ = run_cli("sandbox.schema", base)
    assert sch["engine"] == "sqlite" and sch["dialect"] == "sqlite"
    assert {tb["name"] for tb in sch["tables"]} == {"students", "courses", "enrollments"}
    code, ex, _ = run_cli("sandbox.exec", {**base, "sql": "SELECT COUNT(*) AS n FROM students"})
    assert ex["engine"] == "sqlite" and ex["rows"] == [[6]]
    # 未安装引擎的 schema 也必须拒（不能拿 sqlite 的 schema 冒充 PG）
    code, _d, last = run_cli("sandbox.schema", {**base, "engine": "postgres"})
    assert code == 1 and last["code"] == "E_ENGINE_UNAVAILABLE"


def test_credentials_are_reported_missing_but_never_echoed() -> None:
    """①-4 凭据：如实报缺失（点名变量），且**绝不回显**其值。"""
    secret = "SUPER_SECRET_PW_9f3a"
    code, d, _ = run_cli("sandbox.engines", {}, env_extra={
        "LAB_DB_ENGINE": "postgres", "LAB_DB_HOST": "127.0.0.1", "LAB_DB_PORT": "5432",
        "LAB_DB_NAME": "labdb", "LAB_DB_USER": "labadmin", "LAB_PG_PASSWORD": secret})
    assert code == 0
    pg = [e for e in d["engines"] if e["id"] == "postgres"][0]
    assert pg["available"] is False and "psql" in pg["reason"]     # 本机无 psql → 如实
    assert pg["target"] == {"host": "127.0.0.1", "port": 5432, "database": "labdb"}
    assert secret not in json.dumps(d, ensure_ascii=False)

    code2, d2, _ = run_cli("sandbox.engines", {}, env_extra={
        "LAB_DB_ENGINE": "mysql", "LAB_DB_HOST": "127.0.0.1"})
    my = [e for e in d2["engines"] if e["id"] == "mysql"][0]
    assert "LAB_MYSQL_PASSWORD" in my["reason"]        # 点名缺哪个变量
    assert secret not in json.dumps(d2, ensure_ascii=False)


def test_engines_report_declares_log_layers_honestly() -> None:
    """①-1（附带）：日志层能力也要如实 —— sqlite 只有 L1，server 引擎 layers 为空。"""
    code, d, _ = run_cli("sandbox.engines", {})
    by_id = {s["id"]: s for s in d["logSources"]}
    assert by_id["sqlite"]["layers"] == ["L1"] and by_id["sqlite"]["available"] is True
    for eng in ("mysql", "postgres", "opengauss"):
        assert by_id[eng]["layers"] == [] and by_id[eng]["available"] is False
        assert by_id[eng]["reason"]
