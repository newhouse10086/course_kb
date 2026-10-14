# -*- coding: utf-8 -*-
"""引擎抽象 + 注册表 + 日志源测试。

★ 验收项（LAB_DB_DEPLOY §9）：**加一个引擎 = 加 adapter + 配置，不改上层** ——
这里用一个"假引擎"证明：注册后上层（``get_engine``/``ExecRequest`` 流程）零改动即可用。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

from worker.sandbox import engine as engine_mod
from worker.sandbox import logs as logs_mod
from worker.sandbox import datasets as ds_mod
from worker.sandbox.paths import SandboxRoots


@pytest.fixture(autouse=True)
def clean_registry():
    """每个用例前后都清空注册表（避免互相污染）。"""
    engine_mod.clear_registry()
    logs_mod.clear_log_sources()
    yield
    engine_mod.clear_registry()
    logs_mod.clear_log_sources()


# ═══════════════════════════════════════════════════════════════════════
# ★ 假引擎：证明"加引擎只加 adapter + 配置"
# ═══════════════════════════════════════════════════════════════════════
@dataclass
class FakeEngine:
    """完全假的引擎（不连任何东西）：只实现协议要求的 6 个方法。"""

    info: engine_mod.EngineInfo

    def __init__(self) -> None:
        self.info = engine_mod.EngineInfo(
            id="fake", label="假引擎（注册表测试用）", dialect="fake", runtime="server",
            available=True,
            capabilities={"crud": True, "ddl": True, "transactions": True,
                          "procedures": True, "maxRowsDefault": 42},
        )
        self.calls: list[tuple] = []

    def health_check(self):
        self.calls.append(("health",))
        return {"ok": True}

    def ensure_session(self, user_id, session_id, dataset_id=None):
        self.calls.append(("ensure", user_id, session_id, dataset_id))
        return {"engine": "fake", "db_path": f"mem://{user_id}/{session_id}",
                "created": True, "dataset": dataset_id or "sc", "schema": {"dialect": "fake",
                                                                          "tables": []}}

    def exec(self, req: engine_mod.ExecRequest):
        self.calls.append(("exec", req.sql, req.max_rows))
        return {"columns": ["x"], "rows": [[1]], "rowCount": 1, "elapsedMs": 1,
                "engine": "fake", "ok": True}

    def reset_session(self, user_id, session_id, dataset_id=None):
        self.calls.append(("reset", user_id, session_id))
        return {"engine": "fake", "db_path": "mem://", "dataset": dataset_id or "sc"}

    def list_datasets(self):
        return ds_mod.list_datasets()

    def dispose(self):
        self.calls.append(("dispose",))


def test_fake_engine_registers_and_works_without_touching_upper_layers() -> None:
    fake = FakeEngine()
    engine_mod.register_engine(fake)
    # ① 上层只认接口（不需要 isinstance 分支、不需要改 executor）
    assert isinstance(fake, engine_mod.DatabaseEngine)
    got = engine_mod.get_engine("fake")
    assert got is fake
    assert "fake" in engine_mod.registry_ids()

    # ② 走同一套 ExecRequest 流程
    req = engine_mod.ExecRequest(session_id="s1", sql="SELECT 1", max_rows=7, user_id="u1")
    out = got.exec(req)
    assert out["rows"] == [[1]] and out["engine"] == "fake"
    assert ("exec", "SELECT 1", 7) in fake.calls

    # ③ ensure / reset / healthCheck 都按契约被调用
    got.ensure_session("u1", "s1", "orders")
    got.reset_session("u1", "s1", "sc")
    assert got.health_check() == {"ok": True}
    assert ("ensure", "u1", "s1", "orders") in fake.calls
    assert ("reset", "u1", "s1") in fake.calls


def test_unavailable_engine_is_reported_honestly() -> None:
    """不可用引擎必须给 **available:false + reason**，而不是"配置了就算可用"（坑 10）。"""

    class Broken:
        def __init__(self):
            self.info = engine_mod.EngineInfo(
                id="broken", label="坏引擎", dialect="x", runtime="server",
                available=True,  # 自称可用
            )

        def health_check(self):
            return {"ok": False, "reason": "连接失败：ECONNREFUSED 127.0.0.1:5432"}

        def ensure_session(self, *a, **k):
            raise engine_mod.EngineUnavailable(self.info)

        exec = ensure_session
        reset_session = ensure_session
        list_datasets = lambda self: []
        dispose = lambda self: None

    engine_mod.register_engine(Broken())
    report = {e["id"]: e for e in engine_mod.engines_report()}
    assert report["broken"]["available"] is False
    assert "ECONNREFUSED" in report["broken"]["reason"]


def test_default_engines_registered_lazily() -> None:
    """★ 回归：CLI 每次都是新进程，registry 初始为空 —— 取引擎必须能**惰性注册**。

    第一版只在 ``sandbox.engines`` job 里注册 → 别的 job 调 sqlite 直接
    ``E_ENGINE_UNKNOWN``（自己踩的坑）。
    """
    engine_mod.clear_registry()
    assert engine_mod.registry_ids() == [] or True     # 清空后
    eng = engine_mod.get_engine("sqlite")              # 不预注册也能拿到
    assert eng.info.id == "sqlite" and eng.info.available is True
    assert set(engine_mod.registry_ids()) >= {"sqlite", "mysql", "postgres", "opengauss"}


def test_sqlite_engine_health_check_really_probes(tmp_path: Path) -> None:
    eng = engine_mod.SQLiteEngine(tmp_path / "sb")
    r = eng.health_check()
    assert r["ok"] is True
    # 探测不能留下垃圾文件
    assert not (tmp_path / "sb" / "__probe__.sqlite3").exists()


def test_server_engines_are_honest_stubs() -> None:
    engine_mod.register_default_engines()
    for eid, doc in (("mysql", "§4.3"), ("postgres", "§4.2"), ("opengauss", "§4.4")):
        info = engine_mod.get_engine(eid).info
        assert info.available is False, f"{eid} 不该在这台机器上宣称可用"
        assert doc in info.reason, info.reason
        # 能力表如实：server 类有存储过程
        assert info.capabilities["procedures"] is True
        with pytest.raises(engine_mod.EngineUnavailable):
            engine_mod.get_engine(eid).exec(
                engine_mod.ExecRequest(session_id="s", sql="SELECT 1"))


def test_engines_report_shape_for_capabilities() -> None:
    engine_mod.register_default_engines()
    report = {e["id"]: e for e in engine_mod.engines_report()}
    sqlite = report["sqlite"]
    assert sqlite["available"] is True
    assert sqlite["runtime"] == "embedded" and sqlite["dialect"] == "sqlite"
    assert sqlite["capabilities"] == {"crud": True, "ddl": True, "transactions": True,
                                      "procedures": False, "maxRowsDefault": 200}
    # 不可用的一定有 reason（UI 要显示"为什么不能选 + 指向文档"）
    for eid in ("mysql", "postgres", "opengauss"):
        assert report[eid]["available"] is False
        assert report[eid]["reason"]


def test_ensure_session_creates_then_reuses(tmp_path: Path) -> None:
    eng = engine_mod.SQLiteEngine(tmp_path / "sb")
    first = eng.ensure_session("u1", "s1", "sc")
    assert first["created"] is True and first["dataset"] == "sc"
    assert [t["name"] for t in first["schema"]["tables"]] == ["courses", "enrollments", "students"]
    second = eng.ensure_session("u1", "s1", "orders")
    assert second["created"] is False, "已存在就该复用（不能每次重建把学生数据抹了）"
    assert [t["name"] for t in second["schema"]["tables"]] == [
        "courses", "enrollments", "students"]     # 仍是 sc 的库
    # reset 才会换数据集
    third = eng.reset_session("u1", "s1", "orders")
    assert third["dataset"] == "orders"
    assert "order_items" in [t["name"] for t in third["schema"]["tables"]]


# ═══════════════════════════════════════════════════════════════════════
# 日志源
# ═══════════════════════════════════════════════════════════════════════
def test_logs_carry_timeout_kill_context(tmp_path: Path) -> None:
    """★ pi-bridge 的 P1：超时被杀要能自证"是被停掉的，不是语法错"。

    ``sandbox.logs`` 的 entries 必须带 ``context.killedBy`` / ``hardKilled`` /
    ``elapsedMs``，``sandbox.history`` 也要带 —— 否则答疑只能说"超时了"，
    说不清"你的递归 CTE 被硬杀了，不是你语法错"。
    """
    from worker.sandbox import exec as exec_mod
    from worker.sandbox import history as history_mod

    roots = SandboxRoots.resolve(tmp_path / "sb")
    roots.ensure()
    db = roots.session_path("u1", "s1")
    ds_mod.load_dataset(db, "sc")
    loop = ("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) "
            "SELECT COUNT(*) FROM c")
    r = exec_mod.execute(db_path=db, sql=loop, timeout_ms=1000, user_id="u1",
                         session_id="s1", root=str(roots.root))
    assert r["error"]["code"] == "E_SQL_TIMEOUT"

    # ① history：超时条目带 killedBy / hardKilled / timeoutMs
    recs = history_mod.recent_executions(roots, "u1", "s1", limit=5)
    tmo = recs[-1]
    assert tmo["ok"] is False and "E_SQL_TIMEOUT" in (tmo["error"] or "")
    assert tmo["killedBy"] in ("progress", "process")
    assert isinstance(tmo["hardKilled"], bool)
    assert tmo["timeoutMs"] == 1000
    assert isinstance(tmo["elapsedMs"], int)

    # ② logs：context 里同样有（S4 直接消费这个）
    src = logs_mod.SqliteLogSource(root=roots)
    entries = src.fetch({"session_id": "s1", "user_id": "u1", "limit": 5})
    err = [e for e in entries if e["level"] == "error"][-1]
    assert err["code"] == "E_SQL_TIMEOUT"
    ctx = err["context"]
    assert ctx["killedBy"] in ("progress", "process")
    assert isinstance(ctx["hardKilled"], bool)
    assert ctx["timeoutMs"] == 1000
    assert isinstance(ctx["elapsedMs"], int)
    assert "递归" in err["hint"] or "递归" in ctx["localReading"]

    # ③ 提示词摘要里也要出现 killedBy（否则模型看不到）
    text = logs_mod.summarize_for_prompt(entries)
    assert "killedBy=" in text and "hardKilled=" in text


def test_logs_carry_hard_kill_flag_from_parent_kill(tmp_path: Path, monkeypatch) -> None:
    """父进程 hard kill 那条路径：``killedBy=process`` + ``hardKilled=true`` 也要落进日志。"""
    from worker.sandbox import exec as exec_mod

    monkeypatch.setattr(exec_mod, "KILL_GRACE_S", -1.4)
    roots = SandboxRoots.resolve(tmp_path / "sb2")
    roots.ensure()
    db = roots.session_path("u1", "s1")
    ds_mod.load_dataset(db, "sc")
    loop = ("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) "
            "SELECT COUNT(*) FROM c")
    r = exec_mod.execute(db_path=db, sql=loop, timeout_ms=2000, user_id="u1",
                         session_id="s1", root=str(roots.root))
    assert r["hardKilled"] is True and r["killedBy"] == "process"

    src = logs_mod.SqliteLogSource(root=roots)
    entries = src.fetch({"session_id": "s1", "user_id": "u1", "limit": 5})
    err = [e for e in entries if e["level"] == "error"][-1]
    assert err["context"]["killedBy"] == "process"
    assert err["context"]["hardKilled"] is True


def test_sqlite_log_source_declares_l1_only(tmp_path: Path) -> None:
    roots = SandboxRoots.resolve(tmp_path / "sb")
    roots.ensure()
    src = logs_mod.SqliteLogSource(root=roots)
    info = src.info.to_dict()
    # ★ 如实声明：SQLite 只有 L1（无 L2 实例统计、无 L3 文件日志）
    assert info["layers"] == ["L1"]
    assert info["available"] is True
    assert "L2" in info["note"] and "L3" in info["note"]


def test_logs_return_raw_error_and_previous_sql(tmp_path: Path) -> None:
    from worker.sandbox import exec as exec_mod

    roots = SandboxRoots.resolve(tmp_path / "sb")
    roots.ensure()
    db = roots.session_path("u1", "s1")
    ds_mod.load_dataset(db, "sc")
    exec_mod.execute(db_path=db, sql="SELECT COUNT(*) FROM students", user_id="u1",
                     session_id="s1", root=str(roots.root))
    exec_mod.execute(db_path=db, sql="SELECT * FROM student", user_id="u1", session_id="s1",
                     root=str(roots.root))

    src = logs_mod.SqliteLogSource(root=roots)
    entries = src.fetch({"session_id": "s1", "user_id": "u1", "limit": 10})
    assert len(entries) >= 2
    err = [e for e in entries if e["level"] == "error"][-1]
    assert err["source"] == "L1" and err["code"] == "E_SQL_NO_OBJECT"
    assert err["message"] == "no such table: student"          # 引擎原文
    assert "表 student 不存在" == err["context"]["localReading"]
    assert err["sql"] == "SELECT * FROM student"
    # 上一条成功的 SQL 也在（答疑要知道"他刚才在干什么"）
    assert any(e["sql"] == "SELECT COUNT(*) FROM students" for e in entries)


def test_logs_isolated_between_students(tmp_path: Path) -> None:
    """★ 隔离负例：A 学生**看不到** B 学生的 SQL 日志（LAB_DB_ALLOY §8.5.2）。"""
    from worker.sandbox import exec as exec_mod

    roots = SandboxRoots.resolve(tmp_path / "sb")
    roots.ensure()
    for user in ("u_alice", "u_bob"):
        db = roots.session_path(user, "s1")
        ds_mod.load_dataset(db, "sc")
    exec_mod.execute(db_path=roots.session_path("u_alice", "s1"),
                     sql="SELECT 'alice_secret' AS x", user_id="u_alice", session_id="s1",
                     root=str(roots.root))
    exec_mod.execute(db_path=roots.session_path("u_bob", "s1"),
                     sql="SELECT 'bob_secret' AS x", user_id="u_bob", session_id="s1",
                     root=str(roots.root))

    src = logs_mod.SqliteLogSource(root=roots)
    # ① 就算有人拿 alice 的身份去读 bob 的会话 —— 也被拒
    with pytest.raises(PermissionError):
        src.fetch({"session_id": "s1", "user_id": "u_alice", "request_user_id": "u_bob"})
    # ② 各自只看到自己的
    a = src.fetch({"session_id": "s1", "user_id": "u_alice", "limit": 10})
    b = src.fetch({"session_id": "s1", "user_id": "u_bob", "limit": 10})
    assert all("bob_secret" not in (e.get("sql") or "") for e in a)
    assert all("alice_secret" not in (e.get("sql") or "") for e in b)


def test_logs_redact_secrets(tmp_path: Path) -> None:
    from worker.sandbox import exec as exec_mod

    roots = SandboxRoots.resolve(tmp_path / "sb")
    roots.ensure()
    db = roots.session_path("u1", "s1")
    ds_mod.load_dataset(db, "sc")
    exec_mod.execute(db_path=db, sql="SELECT 'password=hunter2' AS leak", user_id="u1",
                     session_id="s1", root=str(roots.root))
    src = logs_mod.SqliteLogSource(root=roots)
    entries = src.fetch({"session_id": "s1", "user_id": "u1"})
    joined = "\n".join(e.get("sql") or "" for e in entries)
    assert "hunter2" not in joined and "***" in joined


def test_unavailable_log_sources_are_declared(tmp_path: Path) -> None:
    logs_mod.register_default_log_sources(SandboxRoots.resolve(tmp_path / "sb"))
    report = {s["id"]: s for s in logs_mod.log_sources_report()}
    assert report["sqlite"]["available"] is True and report["sqlite"]["layers"] == ["L1"]
    for eid in ("mysql", "postgres", "opengauss"):
        assert report[eid]["available"] is False
        assert report[eid]["layers"] == []          # 不声明任何层
        assert report[eid]["reason"]


def test_prompt_summary_is_bounded_and_honest(tmp_path: Path) -> None:
    text = logs_mod.summarize_for_prompt([])
    assert "暂无 L1 日志" in text
    many = [{"at": 1_700_000_000_000, "level": "error", "source": "L1",
             "code": "E_SQL_SYNTAX", "message": "near \"FROM\": syntax error",
             "sql": "SELECT FROM t"} for _ in range(50)]
    out = logs_mod.summarize_for_prompt(many, max_entries=3, max_chars=400)
    assert len(out) <= 400 + 40
    assert out.count("E_SQL_SYNTAX") == 3
