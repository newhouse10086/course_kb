# -*- coding: utf-8 -*-
"""沙箱执行引擎测试 —— **CRUD 真跑 / 硬超时真杀 / 两学生真隔离**（LAB_DB_DEPLOY §9）。

注意：这里的"隔离"不是单元测试级的 mock，而是**真开两个库文件、真跑 SQL**。
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from worker.sandbox import datasets as ds_mod
from worker.sandbox import exec as exec_mod
from worker.sandbox import history as history_mod
from worker.sandbox.paths import SandboxPathError, SandboxRoots


@pytest.fixture()
def roots(tmp_path: Path) -> SandboxRoots:
    r = SandboxRoots.resolve(tmp_path / "sandbox")
    r.ensure()
    return r


@pytest.fixture()
def sc_db(roots: SandboxRoots) -> Path:
    p = roots.session_path("u_alice", "lab1")
    ds_mod.load_dataset(p, "sc")
    return p


def ex(db: Path, sql: str, **kw):
    """执行一条 SQL（**显式带 root**：测试用 tmp 沙箱根，不是仓库的 data/sandbox）。"""
    kw.setdefault("user_id", "u_alice")
    kw.setdefault("session_id", "lab1")
    kw.setdefault("root", str(Path(db).parent.parent))
    return exec_mod.execute(db_path=db, sql=sql, **kw)


# ═══════════════════════════════════════════════════════════════════════
# ★ CRUD 真跑（验收项：能建表、插数、查询、更新、删除）
# ═══════════════════════════════════════════════════════════════════════
def test_full_crud_lifecycle(sc_db: Path) -> None:
    r = ex(sc_db, "CREATE TABLE t_lab(id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL)")
    assert r["ok"] is True and r["statementKind"] == "CREATE"

    r = ex(sc_db, "INSERT INTO t_lab(name, score) VALUES('甲', 88.5), ('乙', 91.0), ('丙', 59.0)")
    assert r["ok"] is True and r["affected"] == 3

    r = ex(sc_db, "SELECT name, score FROM t_lab ORDER BY score DESC")
    assert r["columns"] == ["name", "score"]
    assert r["rows"] == [["乙", 91.0], ["甲", 88.5], ["丙", 59.0]]
    assert r["rowCount"] == 3

    r = ex(sc_db, "UPDATE t_lab SET score = score + 5 WHERE name = '丙'")
    assert r["affected"] == 1
    r = ex(sc_db, "SELECT score FROM t_lab WHERE name = '丙'")
    assert r["rows"] == [[64.0]]

    r = ex(sc_db, "DELETE FROM t_lab WHERE name = '乙'")
    assert r["affected"] == 1
    r = ex(sc_db, "SELECT COUNT(*) AS n FROM t_lab")
    assert r["rows"] == [[2]]

    # 聚合 / JOIN / 子查询（课程要练的都在）
    r = ex(sc_db, "SELECT AVG(score) AS avg_score FROM t_lab")
    assert r["rows"][0][0] == pytest.approx(76.25)
    r = ex(sc_db, "SELECT s.sname, e.grade FROM students s "
                  "JOIN enrollments e ON s.sid = e.sid WHERE e.grade IS NULL")
    assert r["rows"] == [["李四", None], ["周八", None]]

    r = ex(sc_db, "DROP TABLE t_lab")
    assert r["ok"] is True
    r = ex(sc_db, "SELECT name FROM sqlite_master WHERE type='table' AND name='t_lab'")
    assert r["rows"] == []


def test_row_limit_truncates_with_flag(sc_db: Path) -> None:
    r = ex(sc_db, "SELECT * FROM enrollments", max_rows=3)
    assert r["rowCount"] == 3 and r["truncated"] is True
    r2 = ex(sc_db, "SELECT * FROM enrollments", max_rows=100)
    assert r2["rowCount"] == 15 and r2["truncated"] is False


# ═══════════════════════════════════════════════════════════════════════
# ★ 事务（BEGIN … ROLLBACK 真生效）
# ═══════════════════════════════════════════════════════════════════════
def test_transaction_rollback_and_commit(sc_db: Path) -> None:
    before = ex(sc_db, "SELECT COUNT(*) AS n FROM students")["rows"][0][0]
    r = ex(sc_db, "BEGIN; INSERT INTO students(sid, sname) VALUES(555,'回滚'); ROLLBACK;",
           allow_multi=True)
    assert r["ok"] is True
    assert [(s["kind"], s["ok"]) for s in r["statements"]] == [("BEGIN", True), ("INSERT", True), ("ROLLBACK", True)]
    assert ex(sc_db, "SELECT COUNT(*) AS n FROM students")["rows"][0][0] == before

    r2 = ex(sc_db, "BEGIN; INSERT INTO students(sid, sname) VALUES(556,'提交'); COMMIT;",
            allow_multi=True)
    assert r2["ok"] is True
    assert ex(sc_db, "SELECT COUNT(*) AS n FROM students")["rows"][0][0] == before + 1


def test_batch_stops_at_error_and_reports_index(sc_db: Path) -> None:
    r = ex(sc_db, "BEGIN; INSERT INTO 不存在表(x) VALUES(1); SELECT 1;", allow_multi=True)
    assert r["ok"] is False
    assert r["error"]["code"] == "E_SQL_NO_OBJECT"
    # 已执行的语句如实回报，出错那句标 ok=False
    assert [s["ok"] for s in r["statements"]] == [True, False]


# ═══════════════════════════════════════════════════════════════════════
# ★ 死循环 → 硬超时（进程级）
# ═══════════════════════════════════════════════════════════════════════
INFINITE_RECURSION = ("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) "
                     "SELECT COUNT(*) FROM c")


def test_infinite_recursion_is_timed_out(sc_db: Path) -> None:
    t0 = time.monotonic()
    r = ex(sc_db, INFINITE_RECURSION, timeout_ms=1_200)
    elapsed = time.monotonic() - t0
    assert r["error"]["code"] == "E_SQL_TIMEOUT"
    assert elapsed < 8, f"超时没生效（跑了 {elapsed:.1f}s）"
    assert r["killedBy"] in ("progress", "process")
    assert "超" in r["error"]["message"]
    # 报错要带上"递归要有终止条件"的教学提示
    assert "递归" in r["error"]["hint"]
    # ★ 超时后仍能正常执行（服务没有被拖死）
    r2 = ex(sc_db, "SELECT 1 AS alive")
    assert r2["ok"] is True and r2["rows"] == [[1]]


def test_parent_kill_path_works(sc_db: Path, monkeypatch) -> None:
    """父进程 **kill()** 这条兜底路径也要真跑一次（把父进程超时提前到子进程之前）。"""
    monkeypatch.setattr(exec_mod, "KILL_GRACE_S", -1.4)   # 父进程比子进程先超时
    r = ex(sc_db, INFINITE_RECURSION, timeout_ms=2_000)
    assert r["error"]["code"] == "E_SQL_TIMEOUT"
    assert r["hardKilled"] is True and r["killedBy"] == "process"
    assert "进程已被硬杀" in r["error"]["message"]
    assert ex(sc_db, "SELECT 2 AS alive")["rows"] == [[2]]


def test_no_orphan_runner_processes(sc_db: Path) -> None:
    """硬杀之后不能留下**占着库文件**的残留进程（否则长跑会累积、库被锁）。

    判据用"文件可删"而不是列进程：Windows 下若还有进程持有该 SQLite 文件，
    ``unlink`` 会失败 —— 这比调 ``tasklist``/``wmic`` 更**确定性**，
    也不受沙箱环境里那些命令是否可用/会不会卡住的影响。
    """
    for _ in range(3):
        r = ex(sc_db, INFINITE_RECURSION, timeout_ms=900)
        assert r["error"]["code"] == "E_SQL_TIMEOUT"
    time.sleep(0.4)
    # ① 库文件必须可删 → 没有任何子进程还占着它
    sc_db.unlink()
    assert not sc_db.exists()
    # ② 删掉之后还能从头再来（下一句会自动重建空库）
    r = ex(sc_db, "SELECT 1 AS fresh")
    assert r["ok"] is True and r["rows"] == [[1]]


# ═══════════════════════════════════════════════════════════════════════
# ★ 危险语句（词法闸 + SQLite authorizer 双层）
# ═══════════════════════════════════════════════════════════════════════
@pytest.mark.parametrize("sql,code", [
    ("ATTACH '/tmp/other.sqlite3' AS other", "E_SQL_FORBIDDEN"),
    ("SELECT load_extension('x')", "E_SQL_FORBIDDEN"),
    ("SELECT 1; DROP TABLE students", "E_SQL_MULTI"),
    ("PRAGMA writable_schema=ON", "E_SQL_FORBIDDEN"),
])
def test_dangerous_sql_rejected_at_exec_layer(sc_db: Path, sql: str, code: str) -> None:
    r = ex(sc_db, sql)
    assert r["ok"] is False and r["error"]["code"] == code
    # 被拒的语句**不能**改库
    assert ex(sc_db, "SELECT COUNT(*) AS n FROM students")["rows"][0][0] == 6


def test_runner_authorizer_blocks_attach_even_if_guard_bypassed(sc_db: Path) -> None:
    """★ 第二道防线：**绕过词法闸**直接调 runner，ATTACH 仍必须失败。

    （词法闸是第一道；万一它被绕过，SQLite 的 authorizer 必须兜住。）
    """
    from worker.sandbox.runner import run_payload

    r = run_payload({"db_path": str(sc_db), "sql": "ATTACH '/tmp/x.sqlite3' AS x",
                     "root": str(sc_db.parent.parent)})
    # 词法闸仍在 runner 内生效（先过闸），所以这里是 E_SQL_FORBIDDEN
    assert r["error"]["code"] == "E_SQL_FORBIDDEN"

    # 真·绕过：直接开连接（复刻 runner 的 _connect），验证 authorizer 本身
    from worker.sandbox.runner import _connect
    conn = _connect(sc_db, 5.0)
    try:
        with pytest.raises(Exception) as exc:
            conn.execute("ATTACH '/tmp/x.sqlite3' AS x")
        assert "authorized" in str(exc.value).lower()
        with pytest.raises(Exception):
            conn.execute("PRAGMA writable_schema=ON")
        with pytest.raises(Exception):
            conn.execute("SELECT load_extension('x')")
    finally:
        conn.close()


# ═══════════════════════════════════════════════════════════════════════
# ★ 两学生隔离（负例）
# ═══════════════════════════════════════════════════════════════════════
def test_two_students_are_isolated(roots: SandboxRoots) -> None:
    a = roots.session_path("u_alice", "lab1")
    b = roots.session_path("u_bob", "lab1")
    ds_mod.load_dataset(a, "sc")
    ds_mod.load_dataset(b, "sc")
    assert a != b and a.parent != b.parent

    # A 删表 + 插自己的数据 → B 完全不受影响
    # 注意：外键开启时**不能直接删被引用的父表**（SQLite 会报 FK 失败）—— 先删子表
    assert exec_mod.execute(db_path=a, sql="DROP TABLE enrollments", user_id="u_alice",
                            session_id="lab1", root=str(roots.root))["ok"] is True
    assert exec_mod.execute(db_path=a, sql="DROP TABLE students", user_id="u_alice",
                            session_id="lab1", root=str(roots.root))["ok"] is True
    assert exec_mod.execute(db_path=a, sql="CREATE TABLE only_a(x INTEGER)",
                            user_id="u_alice", session_id="lab1",
                            root=str(roots.root))["ok"] is True
    rb = exec_mod.execute(db_path=b, sql="SELECT COUNT(*) AS n FROM students",
                          user_id="u_bob", session_id="lab1", root=str(roots.root))
    assert rb["rows"] == [[6]]
    tables_b = exec_mod.execute(
        db_path=b, sql="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        user_id="u_bob", session_id="lab1", root=str(roots.root))["rows"]
    assert ["only_a"] not in tables_b
    assert [t[0] for t in tables_b] == ["courses", "enrollments", "students"]


def test_db_path_outside_root_rejected(roots: SandboxRoots, tmp_path: Path) -> None:
    """学生库**只能**落在沙箱根目录里（否则能删主知识库）。"""
    outside = tmp_path / "course-kb.sqlite3"
    with pytest.raises(SandboxPathError):
        exec_mod.execute(db_path=outside, sql="SELECT 1", user_id="u", session_id="s",
                         root=str(roots.root))
    with pytest.raises(SandboxPathError):
        roots.validate(roots.root / ".." / ".." / "course-kb.sqlite3")
    with pytest.raises(SandboxPathError):
        roots.session_path("../evil", "s1")
    # 后缀也必须是 .sqlite3
    with pytest.raises(SandboxPathError):
        roots.validate(roots.root / "x.db")


# ═══════════════════════════════════════════════════════════════════════
# 报错原文 + 本地解读（S4 的硬要求）
# ═══════════════════════════════════════════════════════════════════════
def test_error_keeps_engine_raw_text(sc_db: Path) -> None:
    r = ex(sc_db, "SELECT * FROM student")
    err = r["error"]
    assert err["message"] == "no such table: student"      # ★ 一字不改
    assert err["code"] == "E_SQL_NO_OBJECT"
    assert err["localReading"] == "表 student 不存在"
    assert err["localMatched"] is True
    assert "sqlite_master" in err["hint"]

    # ★ 拼写错误要看 **SQLite 原生报错**（教学价值最高：学生最常卡在"看不懂报错"）——
    #   所以闸对"认不出的关键字"是**放行给 SQLite 解析**，而不是笼统回 E_SQL_KIND
    r2 = ex(sc_db, "SELEC * FROM students")
    assert "syntax error" in r2["error"]["message"].lower(), r2["error"]
    assert "SELEC" in r2["error"]["message"]
    assert r2["error"]["raw"] == r2["error"]["message"]

    r3 = ex(sc_db, "INSERT INTO students(sid, sname) VALUES(1, '重号')")
    assert "UNIQUE constraint failed" in r3["error"]["message"]
    assert "唯一约束冲突" in r3["error"]["localReading"]


def test_foreign_key_enforced_by_default(sc_db: Path) -> None:
    """外键默认开启（与 MySQL 对齐）；SQLite 默认是 OFF，这是方言差异。"""
    r = ex(sc_db, "INSERT INTO enrollments(sid, cid, grade) VALUES(999, 1, 90)")
    assert r["ok"] is False
    assert "FOREIGN KEY constraint failed" in r["error"]["message"]


# ═══════════════════════════════════════════════════════════════════════
# 审计（L1 日志来源）
# ═══════════════════════════════════════════════════════════════════════
def test_execution_is_audited(sc_db: Path, roots: SandboxRoots) -> None:
    ex(sc_db, "SELECT 1 AS ok_one")
    ex(sc_db, "SELECT * FROM student")            # 失败也要记
    ex(sc_db, "ATTACH 'x' AS y")                  # 被闸拦的也要记（学生试过什么很重要）
    records = history_mod.recent_executions(roots, "u_alice", "lab1", limit=10)
    assert [r["ok"] for r in records] == [True, False, False]
    assert records[1]["error"] == "no such table: student"
    assert records[2]["error"] is not None
    assert records[0]["sql"] == "SELECT 1 AS ok_one"
    assert records[0]["rowCount"] == 1
    assert isinstance(records[0]["elapsedMs"], int)


def test_history_is_isolated_and_redacted(roots: SandboxRoots) -> None:
    p = roots.session_path("u_alice", "lab1")
    ds_mod.load_dataset(p, "sc")
    exec_mod.execute(db_path=p, sql="SELECT 'password=hunter2' AS leak", user_id="u_alice",
                     session_id="lab1", root=str(roots.root))
    # ① 隔离：B 读 A 的历史 → 抛异常
    with pytest.raises(history_mod.SessionIsolationError):
        history_mod.read(roots, "u_alice", "lab1", request_user_id="u_bob")
    # ② 脱敏：密码字面量落盘前已被打码
    recs = history_mod.recent_executions(roots, "u_alice", "lab1")
    assert "hunter2" not in recs[0]["sql"]
    assert "***" in recs[0]["sql"]
    # ③ 只读：模块不提供任何写/清理 API 之外的入口
    assert not hasattr(history_mod, "update")
    assert callable(history_mod.append) and callable(history_mod.read)


def test_db_size_cap_rolls_back_write(roots: SandboxRoots) -> None:
    """★ 库大小上限：超出 → `E_SANDBOX_SIZE` **且回滚本次写入**（规格 §7.5）。

    故意用极小上限（1 字节）来**真跑**这条路径 ——
    否则它只是"文档里写了、代码没验过"。
    """
    db = roots.session_path("u_quota", "s1")
    ds_mod.load_dataset(db, "sc")
    before = exec_mod.execute(db_path=db, sql="SELECT COUNT(*) AS n FROM students",
                              user_id="u_quota", session_id="s1", root=str(roots.root))
    assert before["rows"] == [[6]]

    r = exec_mod.execute(db_path=db, sql="INSERT INTO students(sid, sname) VALUES(4242,'超限')",
                         user_id="u_quota", session_id="s1", root=str(roots.root),
                         max_db_bytes=1)
    assert r["ok"] is False and r["error"]["code"] == "E_SANDBOX_SIZE"
    assert "回滚" in r["error"]["message"]

    after = exec_mod.execute(db_path=db, sql="SELECT COUNT(*) AS n FROM students",
                            user_id="u_quota", session_id="s1", root=str(roots.root))
    assert after["rows"] == [[6]], "超限的写入必须被回滚（不能只报错还写进去）"


def test_empty_db_exec_creates_file_and_reports_shape(roots: SandboxRoots) -> None:
    p = roots.session_path("u_new", "s1")
    r = exec_mod.execute(db_path=p, sql="SELECT 1 AS x", user_id="u_new", session_id="s1",
                         root=str(roots.root))
    assert r["ok"] is True and r["rows"] == [[1]]
    assert p.exists()
    # SQLite 的 0 字节空库是**正常**的（还没有页写入）→ 写一张表后才应 >0
    assert r["dbBytes"] >= 0
    r2 = exec_mod.execute(db_path=p, sql="CREATE TABLE t(x INTEGER)", user_id="u_new",
                          session_id="s1", root=str(roots.root))
    assert r2["ok"] is True and r2["dbBytes"] > 0
