# -*- coding: utf-8 -*-
"""``DatabaseEngine`` 抽象 + 注册表 —— 契约见 ``docs/LAB_DB_DEPLOY.md`` §2。

用户原话：「数据库不要使用 mysql 这种不能一键部署的，或者这个作为可以后面配置加入的？
**总之留有接口**」→ 默认 **SQLite**（零部署、已在项目里），
MySQL / PostgreSQL / openGauss 作为**后续配置加入**的 adapter。

**验收要求**：「加一个引擎 = 加 adapter + 配置，不改上层（用"假引擎"测注册表）」。
所以这里的关键不是"多写几个引擎"，而是**上层（``exec.py``/``cli.py``）只依赖接口**：
新引擎只要 :func:`register_engine` 注册一个对象即可，上层一行不改。

诚实原则（坑 10）：未配置/连不上的引擎 → ``available: false`` + **可读 reason**，
绝不"配置了就算可用"。本次交付里 MySQL/PG/openGauss **只有接口 + 诚实降级**，
因为本机既没有 Docker 也没有这些服务（见 AGENTS.md §4 环境事实）。

TS 侧对应实现（T-BACKEND）：``apps/server/src/sandbox/engines/registry.ts`` —— 两边形状必须一致。
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable


@dataclass
class EngineInfo:
    """引擎自述（字段与契约 §2 ``EngineInfo`` 一一对应）。"""

    id: str
    label: str
    dialect: str
    runtime: str                        # 'embedded' | 'server'
    available: bool
    reason: str = ""
    capabilities: dict[str, Any] = field(default_factory=lambda: {
        "crud": True, "ddl": True, "transactions": True, "procedures": False,
        "maxRowsDefault": 200,
    })
    target: dict[str, Any] = field(default_factory=dict)   # **脱敏**：不含密码

    def to_dict(self) -> dict[str, Any]:
        out = {
            "id": self.id, "label": self.label, "dialect": self.dialect,
            "runtime": self.runtime, "available": self.available,
            "capabilities": dict(self.capabilities),
        }
        if not self.available:
            out["reason"] = self.reason or "未配置"
        if self.target:
            out["target"] = dict(self.target)
        return out


@dataclass
class ExecRequest:
    session_id: str
    sql: str
    max_rows: int = 200
    timeout_ms: int = 5_000
    user_id: str = ""
    allow_multi: bool = False


@runtime_checkable
class DatabaseEngine(Protocol):
    """★ 唯一契约（TS/Python 两侧同名同形）。"""

    info: EngineInfo

    def health_check(self) -> dict[str, Any]:
        """**真探测**：embedded 试开库；server 类真连一次。返回 ``{ok, reason?}``。"""
        ...

    def ensure_session(self, user_id: str, session_id: str, dataset_id: str | None = None) -> dict[str, Any]:
        """一个学生一个逻辑沙箱（SQLite 一个文件 / server 类一个独立 database）。"""
        ...

    def exec(self, req: ExecRequest) -> dict[str, Any]:
        """执行 SQL → ``{columns, rows, rowCount, elapsedMs, affected?, error?}``。"""
        ...

    def reset_session(self, user_id: str, session_id: str, dataset_id: str | None = None) -> dict[str, Any]:
        ...

    def list_datasets(self) -> list[dict[str, Any]]:
        ...

    def dispose(self) -> None:
        ...


# ═══════════════════════════════════════════════════════════════════════
# 注册表
# ═══════════════════════════════════════════════════════════════════════
_REGISTRY: dict[str, DatabaseEngine] = {}


def register_engine(engine: DatabaseEngine) -> None:
    """注册一个引擎（**上层不需要改任何代码** —— 验收项之一）。"""
    _REGISTRY[engine.info.id] = engine


def unregister_engine(engine_id: str) -> None:
    _REGISTRY.pop(engine_id, None)


def clear_registry() -> None:
    _REGISTRY.clear()


def ensure_default_engines(root: str | Path | None = None) -> list[str]:
    """惰性注册默认引擎（**进程启动时 registry 是空的** —— CLI 每次都是新进程）。

    第一版只在 ``sandbox.engines`` job 里注册 → 别的 job 调 ``get_engine('sqlite')``
    直接 ``E_ENGINE_UNKNOWN``（自己踩的坑，写下来防回归）。
    """
    if not _REGISTRY:
        register_default_engines(root)
    return list(_REGISTRY)


def get_engine(engine_id: str = "sqlite", root: str | Path | None = None) -> DatabaseEngine:
    """取引擎；未注册 → ``KeyError``（上层转成可读错误）。

    ``root`` 给了就**用这个根目录**重建 SQLite 引擎 ——
    否则 payload 里的 ``root`` 被无声忽略，所有会话都落到仓库默认的 ``data/sandbox``
    （多租户/测试会互相串库；实测踩过把测试数据写进仓库目录）。
    """
    ensure_default_engines()
    key = (engine_id or "sqlite").lower()
    if key not in _REGISTRY:
        raise KeyError(key)
    if root is not None and key == "sqlite":
        _REGISTRY["sqlite"] = SQLiteEngine(root)
    return _REGISTRY[key]


def registry_ids() -> list[str]:
    ensure_default_engines()
    return list(_REGISTRY)


def engines_report() -> list[dict[str, Any]]:
    """给 ``/capabilities`` 用的逐引擎如实上报（**真探测**，不是"配置了就算"）。"""
    ensure_default_engines()
    out: list[dict[str, Any]] = []
    for eid in sorted(_REGISTRY):
        engine = _REGISTRY[eid]
        info = engine.info
        item = info.to_dict()
        if info.available:
            try:
                hc = engine.health_check()
            except Exception as exc:  # noqa: BLE001 - 探测失败必须如实报
                hc = {"ok": False, "reason": f"{type(exc).__name__}: {exc}"}
            item["available"] = bool(hc.get("ok"))
            if not item["available"]:
                item["reason"] = hc.get("reason") or "探测失败"
        out.append(item)
    return out


# ═══════════════════════════════════════════════════════════════════════
# SQLite（默认引擎，**本机完全可用**）
# ═══════════════════════════════════════════════════════════════════════
class SQLiteEngine:
    """内置引擎：一个学生一个 ``.sqlite3`` 文件，零部署。"""

    def __init__(self, root: str | Path | None = None):
        from worker.sandbox.paths import SandboxRoots

        self._roots = SandboxRoots.resolve(root)
        self.info = EngineInfo(
            id="sqlite",
            label="SQLite（内置，零部署）",
            dialect="sqlite",
            runtime="embedded",
            available=True,
            capabilities={"crud": True, "ddl": True, "transactions": True,
                          "procedures": False, "maxRowsDefault": 200},
        )

    # ── 路径 ──────────────────────────────────────────────────────────
    @property
    def roots(self):
        return self._roots

    def db_path_for(self, user_id: str, session_id: str) -> Path:
        return self._roots.session_path(user_id, session_id)

    def health_check(self) -> dict[str, Any]:
        """真探测：建目录 + 真开一次库 + 跑一条 SQL。"""
        import sqlite3

        try:
            self._roots.ensure()
        except OSError as exc:
            return {"ok": False, "reason": f"沙箱根目录不可写：{exc}"}
        probe = self._roots.root / "__probe__.sqlite3"
        try:
            conn = sqlite3.connect(str(probe))
            try:
                conn.execute("CREATE TABLE IF NOT EXISTS probe(x INTEGER)")
                conn.execute("INSERT INTO probe VALUES (1)")
                row = conn.execute("SELECT COUNT(*) FROM probe").fetchone()
                conn.execute("DROP TABLE probe")
                if row[0] != 1:
                    return {"ok": False, "reason": f"探测查询结果异常：{row}"}
            finally:
                conn.close()
        except sqlite3.Error as exc:
            return {"ok": False, "reason": f"打开/执行失败：{exc}"}
        finally:
            try:
                probe.unlink(missing_ok=True)
            except OSError:
                pass
        return {"ok": True}

    # ── 会话 ──────────────────────────────────────────────────────────
    def ensure_session(self, user_id: str, session_id: str,
                       dataset_id: str | None = None) -> dict[str, Any]:
        """建库（不存在则从数据集初始化）→ 返回 ``{db_path, created, dataset, schema}``。"""
        from worker.sandbox import datasets as ds_mod
        from worker.sandbox.schema import introspect

        path = self.db_path_for(user_id, session_id)
        created = not path.exists()
        if created:
            self.reset_session(user_id, session_id, dataset_id)
        return {
            "engine": self.info.id,
            "db_path": str(path),
            "created": created,
            "dataset": (dataset_id or ds_mod.DEFAULT_DATASET),
            "dbBytes": path.stat().st_size if path.exists() else 0,
            "schema": introspect(path, dialect=self.info.dialect),
        }

    def reset_session(self, user_id: str, session_id: str,
                      dataset_id: str | None = None) -> dict[str, Any]:
        from worker.sandbox import datasets as ds_mod
        from worker.sandbox.schema import introspect

        path = self.db_path_for(user_id, session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            path.unlink()
        ds_name = dataset_id or ds_mod.DEFAULT_DATASET
        ds_mod.load_dataset(path, ds_name)
        return {
            "engine": self.info.id,
            "db_path": str(path),
            "dataset": ds_name,
            "dbBytes": path.stat().st_size,
            "schema": introspect(path, dialect=self.info.dialect),
        }

    # ── 执行 ──────────────────────────────────────────────────────────
    def exec(self, req: ExecRequest) -> dict[str, Any]:
        """委托 ``exec.py``（独立子进程 + 硬超时 kill）。"""
        from worker.sandbox.exec import execute

        path = self.db_path_for(req.user_id or "anonymous", req.session_id or "default")
        return execute(
            db_path=path,
            sql=req.sql,
            max_rows=req.max_rows,
            timeout_ms=req.timeout_ms,
            user_id=req.user_id,
            session_id=req.session_id,
            allow_multi=req.allow_multi,
            # ★ 必须把引擎自己的根目录传下去：否则 driver 会用**默认**根去校验路径
            #   （payload 指定的 root 被忽略 → E_SANDBOX_PATH，或写到别的地方）
            root=str(self._roots.root),
        )

    def list_datasets(self) -> list[dict[str, Any]]:
        from worker.sandbox import datasets as ds_mod

        return ds_mod.list_datasets()

    def dispose(self) -> None:      # embedded：无长连接可关
        return None


# ═══════════════════════════════════════════════════════════════════════
# 服务器类引擎：**只有诚实降级**（本机不可跑通，见 §4/§7）
# ═══════════════════════════════════════════════════════════════════════
class _ServerEngineStub:
    """MySQL/PG/openGauss 的占位实现。

    **为什么不假装可用**：本机没有 Docker、也没有这些服务（AGENTS.md §4）。
    契约 §2 要求 ``available`` 是**真探测结果**，所以这里：

    * 读 ``.env``（由 ``scripts/deploy-lab-db.sh`` 写入）判断"是否启用 + 是否配置齐全"：
      ``LAB_DB_ENGINE``（当前启用的引擎）、``LAB_DB_HOST/PORT/NAME/USER``、
      以及各引擎自己的 ``LAB_PG_PASSWORD`` / ``LAB_MYSQL_PASSWORD`` / ``LAB_OG_PASSWORD``；
    * 缺任何一项 → ``available: false`` + **可读 reason**（缺哪个变量 + 该看文档哪一节）；
    * **密码只判断"在不在"，绝不读取/落盘/打日志**（凭据不进事件流）。

    ⚠️ 服务器类引擎的**执行**在 v2 里归 Node（它有 pg/mysql 驱动）；
    worker 这里的职责是**如实的可用性上报**与把参数形状对齐。
    """

    def __init__(self, engine_id: str, label: str, dialect: str, *, client: str,
                 default_port: int, doc_section: str, password_env: str,
                 procedures: bool = True):
        self._id = engine_id
        self._doc_section = doc_section
        self._client = client
        self._password_env = password_env

        env_engine = (os.environ.get("LAB_DB_ENGINE") or "").strip().lower()
        host = (os.environ.get("LAB_DB_HOST") or "").strip()
        port = _int_or_none(os.environ.get("LAB_DB_PORT")) or default_port
        database = (os.environ.get("LAB_DB_NAME") or "").strip()
        user = (os.environ.get("LAB_DB_USER") or "").strip()
        has_password = bool(os.environ.get(password_env))
        #: "这个引擎是否被部署脚本启用" —— 只看变量**在不在**，不读密码值
        self._enabled = (env_engine == engine_id)
        self._configured = bool(host and has_password)
        self._probe = {"host": host, "port": port, "database": database, "user": user,
                       "passwordEnv": password_env, "passwordSet": has_password}
        self.info = EngineInfo(
            id=engine_id, label=label, dialect=dialect, runtime="server",
            available=False, reason=self._reason(),
            capabilities={"crud": True, "ddl": True, "transactions": True,
                          "procedures": procedures, "maxRowsDefault": 500},
            # 脱敏：只有 host/port/database（不含密码、不含账号等凭据）
            target={k: v for k, v in (("host", host or None), ("port", port or None),
                                      ("database", database or None)) if v},
        )

    def _reason(self) -> str:
        doc = f"docs/LAB_DB_DEPLOY.md {self._doc_section}"
        if not self._enabled:
            env_engine = (os.environ.get("LAB_DB_ENGINE") or "（未设置）")
            return (f"未启用：.env 的 LAB_DB_ENGINE={env_engine}；"
                    f"启用请跑 scripts/deploy-lab-db.sh {self._id}（{doc}）")
        if not self._probe["host"]:
            return f"已启用但缺 LAB_DB_HOST；请重跑 scripts/deploy-lab-db.sh（{doc}）"
        if not self._probe["passwordSet"]:
            return (f"已启用但缺 {self._password_env}（凭据变量未设置）；"
                    f"请重跑 scripts/deploy-lab-db.sh（{doc}）")
        if not shutil.which(self._client):
            return (f"找不到 {self._client} 客户端，无法真探测连通性；"
                    f"确认引擎已安装并在 PATH 中（{doc}）")
        return (f"已配置 {self._probe['host']}:{self._probe['port']}，"
                f"但本进程未执行连接探测（server 类引擎的执行归 Node 侧驱动）")

    def health_check(self) -> dict[str, Any]:
        """如实：没有真正的客户端连接就不宣称可用（坑 10）。"""
        if self._enabled and self._configured and not shutil.which(self._client):
            return {"ok": False, "reason": f"缺少 {self._client} 客户端，无法真连"}
        return {"ok": False, "reason": self.info.reason}

    def ensure_session(self, user_id: str, session_id: str,
                       dataset_id: str | None = None) -> dict[str, Any]:
        raise EngineUnavailable(self.info)

    def exec(self, req: ExecRequest) -> dict[str, Any]:
        raise EngineUnavailable(self.info)

    def reset_session(self, user_id: str, session_id: str,
                      dataset_id: str | None = None) -> dict[str, Any]:
        raise EngineUnavailable(self.info)

    def list_datasets(self) -> list[dict[str, Any]]:
        from worker.sandbox import datasets as ds_mod

        return ds_mod.list_datasets()

    def dispose(self) -> None:
        return None


class EngineUnavailable(RuntimeError):
    """引擎不可用（上层转成 ``E_ENGINE_UNAVAILABLE`` + reason + 文档章节）。"""

    code = "E_ENGINE_UNAVAILABLE"

    def __init__(self, info: EngineInfo):
        self.info = info
        super().__init__(f"引擎 {info.id} 不可用：{info.reason}")


def _int_or_none(value: str | None) -> int | None:
    try:
        return int(value) if value else None
    except ValueError:
        return None


def register_default_engines(root: str | Path | None = None) -> list[str]:
    """注册内置引擎（SQLite 永远可用；server 类按 ``.env`` 如实报）。

    ``.env`` 的键由 ``scripts/deploy-lab-db.sh`` 写入（**同一份契约**）：
    ``LAB_DB_ENGINE`` / ``LAB_DB_HOST`` / ``LAB_DB_PORT`` / ``LAB_DB_NAME`` / ``LAB_DB_USER``
    + 各引擎密码 ``LAB_PG_PASSWORD`` / ``LAB_MYSQL_PASSWORD`` / ``LAB_OG_PASSWORD``。
    """
    register_engine(SQLiteEngine(root))
    register_engine(_ServerEngineStub(
        "mysql", "MySQL 8.4 LTS", "mysql", client="mysql", default_port=3306,
        doc_section="§4.3", password_env="LAB_MYSQL_PASSWORD"))
    register_engine(_ServerEngineStub(
        "postgres", "PostgreSQL 17", "postgres", client="psql", default_port=5432,
        doc_section="§4.2", password_env="LAB_PG_PASSWORD"))
    register_engine(_ServerEngineStub(
        "opengauss", "openGauss 6.0", "postgres", client="gsql", default_port=5432,
        doc_section="§4.4", password_env="LAB_OG_PASSWORD"))
    return registry_ids()
