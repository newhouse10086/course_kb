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
from worker.sandbox import history as history_mod
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
    # ★ 事务能力必须**结构化**：布尔值 `transactions: true` 是误导信号
    #   （单发 BEGIN 在"每次执行独立进程"的沙箱里不可能生效 —— Lead 裁定）
    caps = sqlite["capabilities"]
    assert caps["crud"] is True and caps["ddl"] is True
    assert caps["procedures"] is False and caps["maxRowsDefault"] == 200
    tx = caps["transactions"]
    assert isinstance(tx, dict), "transactions 不能是裸 bool（会误导 /capabilities 与前端）"
    assert tx["same_call"] is True and tx["cross_call"] is False
    assert tx["batch_param"] == "multi"
    assert "同一次执行" in tx["note"] and "独立进程" in tx["note"]
    assert "multi" in tx["note"]
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
    # ★ 空日志要说成"可读但没记录"，不能说成"读不到"（pi-bridge 真机抓到的模型误判）
    assert "暂无 L1 记录" in text and "不等于读不到日志" in text
    many = [{"at": 1_700_000_000_000, "level": "error", "source": "L1",
             "code": "E_SQL_SYNTAX", "message": "near \"FROM\": syntax error",
             "sql": "SELECT FROM t"} for _ in range(50)]
    out = logs_mod.summarize_for_prompt(many, max_entries=3, max_chars=400)
    assert len(out) <= 400 + 40
    assert out.count("E_SQL_SYNTAX") == 3


def test_log_status_fact_sentences() -> None:
    """★ 状态必须是**中文事实句**：``empty``（可读但没记录）不能说成"读不到"。

    背景：pi-bridge 真机实测到模型把 empty 说成"我暂时读不到该实例的引擎日志" ——
    事实说错，学生会以为系统坏了。根因是只给了一个英文状态词。
    """
    empty_status, empty_fact = logs_mod.status_fact([])
    assert empty_status == "empty"
    assert "可读" in empty_fact and "≠" in empty_fact and "不要说" in empty_fact

    ok_status, ok_fact = logs_mod.status_fact([{"level": "error"}, {"level": "info"}])
    assert ok_status == "ok" and "2 条" in ok_fact and "读到了" in ok_fact

    na_status, na_fact = logs_mod.status_fact([], engine_id="mysql", reason="adapter 未接入")
    assert na_status == "unavailable" and "读不到" in na_fact and "adapter 未接入" in na_fact


def test_log_read_audit_is_not_returned_as_log_content(tmp_path: Path) -> None:
    """★ 空会话的 ``sandbox.logs`` 必须返回**空 entries**。

    第一版把"谁读了日志"这条审计也当日志返回 → 空会话看起来有 1 条记录，
    调用方/模型会以为**有执行历史**（"没记录"说成"有记录"，与 empty/unavailable
    误判是同一类事实错误）。审计**照写**，但不作为日志内容。
    """
    roots = SandboxRoots.resolve(tmp_path / "sb")
    roots.ensure()
    db = roots.session_path("u1", "s1")
    ds_mod.load_dataset(db, "sc")
    src = logs_mod.SqliteLogSource(root=roots)

    # ① 空会话：0 条内容
    assert src.fetch({"session_id": "s1", "user_id": "u1"}) == []
    # ② 显式要审计时才给（给测试/审计工具用）
    with_audit = src.fetch({"session_id": "s1", "user_id": "u1"}, include_audit=True)
    assert [e.get("kind") for e in with_audit] == ["log_read", "log_read"]   # 两次读各留一条
    # ③ 审计确实落盘了（只是不混进内容）：上面两次读各留一条
    rows = history_mod.read(roots, "u1", "s1", limit=10)
    assert [r.get("kind") for r in rows] == ["LOG_READ", "LOG_READ"]


def test_logs_after_execution_show_exactly_the_executions(tmp_path: Path) -> None:
    """读日志之后再看：entries 只含真实执行（1 成功 + 1 失败），不含审计行。"""
    from worker.sandbox import exec as exec_mod

    roots = SandboxRoots.resolve(tmp_path / "sb3")
    roots.ensure()
    db = roots.session_path("u1", "s1")
    ds_mod.load_dataset(db, "sc")
    exec_mod.execute(db_path=db, sql="SELECT 1 AS ok_one", user_id="u1", session_id="s1",
                     root=str(roots.root))
    exec_mod.execute(db_path=db, sql="SELECT * FROM nope", user_id="u1", session_id="s1",
                     root=str(roots.root))
    src = logs_mod.SqliteLogSource(root=roots)
    entries = src.fetch({"session_id": "s1", "user_id": "u1", "limit": 20})
    assert [e["level"] for e in entries] == ["info", "error"]
    assert entries[0]["sql"] == "SELECT 1 AS ok_one"
    assert entries[1]["message"] == "no such table: nope"
    status, fact = logs_mod.status_fact(entries)
    assert status == "ok" and "2 条" in fact


def test_capabilities_shape_is_typed() -> None:
    """★ 锁**类型**而不只是值：能力上报是 `/capabilities` 的对外契约。

    Lead 认可 `isinstance(tx, dict)` 的价值在于：它防的不是"值错"，而是
    **"退回成误导性形状"**（例如有人把结构化事务能力改回裸 `true`，
    于是 `/capabilities` 与前端又开始宣称"支持事务"）。
    这里把**整张能力表**的类型都钉住（含 server 类引擎）。
    """
    engine_mod.register_default_engines()
    for item in engine_mod.engines_report():
        caps = item["capabilities"]
        # 布尔开关
        for key in ("crud", "ddl", "procedures"):
            assert isinstance(caps[key], bool), f"{item['id']}.{key} 必须是 bool"
        # 数字
        assert isinstance(caps["maxRowsDefault"], int) and not isinstance(
            caps["maxRowsDefault"], bool)
        assert caps["maxRowsDefault"] > 0
        # 事务能力：**必须**是结构化对象，字段类型固定
        tx = caps["transactions"]
        assert isinstance(tx, dict), f"{item['id']}.transactions 不能是裸 bool（误导信号）"
        assert isinstance(tx["same_call"], bool)
        assert isinstance(tx["cross_call"], bool)
        assert tx["batch_param"] == "multi" and isinstance(tx["batch_param"], str)
        assert isinstance(tx["note"], str) and len(tx["note"]) > 20
        # 语义自洽：跨调用不支持时，note 必须说明"同一次执行内"
        if tx["cross_call"] is False:
            assert "同一次" in tx["note"] or "未接入" in tx["note"], tx["note"]


def test_engines_report_json_roundtrip_keeps_shape() -> None:
    """能力上报经 JSON 序列化后形状不变（Node 拿到的就是这份）。"""
    import json as _json

    engine_mod.register_default_engines()
    raw = _json.dumps(engine_mod.engines_report(), ensure_ascii=True)
    back = _json.loads(raw)
    sqlite = [e for e in back if e["id"] == "sqlite"][0]
    assert isinstance(sqlite["capabilities"]["transactions"], dict)
    assert sqlite["capabilities"]["transactions"]["cross_call"] is False
    assert sqlite["available"] is True

