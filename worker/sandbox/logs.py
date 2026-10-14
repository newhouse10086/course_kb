# -*- coding: utf-8 -*-
"""``LogSource`` 抽象 + SQLite 的 L1 实现 —— 契约见 ``docs/LAB_DB_DEPLOY.md`` §8.2/§8.3。

设计取向（**必须照做**）：**L1 为主、L2 为辅、L3 可选**。
理由：L1/L2 只靠**一条 SQL / API** 就能拿到，**远程部署也适用**；
L3 要读引擎日志文件，在"用户自己部署的数据库"场景下**大概率不可用** →
只能**可降级**，拿不到就**如实说**（严禁假装看过）。

| 层 | 内容 | SQLite |
|---|---|---|
| **L1 会话诊断** | 报错原文 + code + hint + 上一条语句 + `EXPLAIN QUERY PLAN` | ✅ **主来源**：``sqlite3`` 原文 + 我们自己的 audit_log |
| **L2 实例统计** | 锁等待、慢查询、活动连接 | ❌ 嵌入式引擎没有实例级视图 → **如实声明不支持** |
| **L3 引擎日志文件** | error log / slow log | ❌ 无文件日志 → ``layers`` 里**不含** L3 |

安全（§8.5，**日志比数据更敏感**）：
1. **只读** —— 本模块只提供 ``fetch``，没有任何写/清理接口
2. **隔离** —— 拉取时必须**过滤到本人会话**（``request_user_id`` 必须与会话所有者一致）
3. **脱敏** —— 所有文本过 :func:`worker.sandbox.errmsg.redact`
4. **长度限制** —— ``limit`` 上限 200 行（``history.MAX_LIMIT``）
5. **审计** —— 读日志这个动作本身也记 audit（``action="log_read"``）
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from worker.sandbox import history as history_mod
from worker.sandbox.errmsg import interpret_error, redact
from worker.sandbox.paths import SandboxRoots

#: 单次拉取上限（§8.5）
DEFAULT_LIMIT = 50
LAYERS_L1 = ("L1",)


@dataclass
class LogSourceInfo:
    id: str
    layers: tuple[str, ...]
    available: bool
    reason: str = ""
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "layers": list(self.layers),
                               "available": self.available}
        if not self.available:
            out["reason"] = self.reason or "不可用"
        if self.note:
            out["note"] = self.note
        return out


@runtime_checkable
class LogSource(Protocol):
    """与 ``DatabaseEngine`` **并列**的接口（注册方式一致）。"""

    info: LogSourceInfo

    def fetch(self, req: dict[str, Any]) -> list[dict[str, Any]]:
        ...


@dataclass
class SqliteLogSource:
    """SQLite 的 L1 日志源（**只读**）。

    数据来源两处，都是我们**天然拥有**的：
    * ``audit_log``（每会话 JSONL）：每次执行的 SQL / 结果 / 错误 / 耗时
    * 上一条错误的**引擎原文**（执行时已存进 audit）
    """

    root: SandboxRoots | None = None
    info: LogSourceInfo = field(default_factory=lambda: LogSourceInfo(
        id="sqlite",
        layers=LAYERS_L1,
        available=True,
        note="SQLite 是嵌入式引擎：无 L2 实例统计、无 L3 日志文件；"
             "L1 = 引擎原文报错 + 本系统 audit_log（§8.3）",
    ))

    def fetch(self, req: dict[str, Any]) -> list[dict[str, Any]]:
        """``req = {session_id, user_id, since?, limit?, layers?}``。

        隔离：``user_id`` 必须与记录所属会话一致（跨会话读 → 抛异常）。
        """
        roots = self.root or SandboxRoots.resolve()
        session_id = str(req.get("session_id") or req.get("sessionId") or "")
        user_id = str(req.get("user_id") or req.get("userId") or "")
        if not session_id or not user_id:
            raise ValueError("fetch 需要 session_id 与 user_id（隔离过滤的依据）")
        limit = min(int(req.get("limit") or DEFAULT_LIMIT), history_mod.MAX_LIMIT)
        layers = tuple(req.get("layers") or LAYERS_L1)

        # 审计：读日志本身也要留痕（§8.5.5）
        history_mod.append(roots, user_id, session_id,
                           {"action": "log_read", "kind": "LOG_READ",
                            "limit": limit, "layers": list(layers)})

        records = history_mod.read(roots, user_id, session_id,
                                  since=req.get("since"), limit=limit,
                                  request_user_id=req.get("request_user_id"))
        entries: list[dict[str, Any]] = []
        for row in records:
            if row.get("action") == "log_read":
                entries.append({
                    "at": row.get("at"), "level": "info", "source": "L1",
                    "sessionId": session_id, "message": "（agent 读取了本会话日志）",
                    "context": {"action": "log_read"},
                })
                continue
            err = row.get("error")
            code = row.get("code")
            if err:
                # ★ 超时用**确定性**解读：审计里存的是人话（"执行超过 1000ms 被中断…"），
                #   直接拿去跑正则匹配不到 `interrupted` → 会误报"没有本地解读"。
                #   超时这条对我们来说是已知的，固定用 interrupted 的解读。
                interp = (interpret_error("interrupted")
                          if code == "E_SQL_TIMEOUT" else interpret_error(str(err)))
                context: dict[str, Any] = {
                    "localReading": interp.message,
                    "localMatched": interp.matched,
                    "elapsedMs": row.get("elapsedMs", row.get("elapsed_ms")),
                    "kind": row.get("kind"),
                }
                if code == "E_SQL_TIMEOUT":
                    # ★ 超时案例要能自证"是被停掉的，不是语法错"（pi-bridge 的 P1）：
                    #   killedBy=progress（SQLite 层中断）/ process（父进程硬杀）
                    context["killedBy"] = row.get("killed_by") or row.get("killedBy")
                    context["hardKilled"] = bool(row.get("hard_killed") or row.get("hardKilled"))
                    if row.get("timeout_ms") is not None:
                        context["timeoutMs"] = row.get("timeout_ms")
                entries.append({
                    "at": row.get("at"), "level": "error", "source": "L1",
                    "sessionId": session_id,
                    "sql": redact(row.get("sql") or ""),
                    "code": code or "E_SQL_EXEC",
                    "message": redact(str(err)),          # ★ 引擎原文（脱敏后）
                    "hint": interp.hint,
                    "context": context,
                })
            else:
                entries.append({
                    "at": row.get("at"), "level": "info", "source": "L1",
                    "sessionId": session_id,
                    "sql": redact(row.get("sql") or ""),
                    "message": f"执行成功（{row.get('rowCount', 0)} 行）",
                    "context": {"elapsedMs": row.get("elapsedMs", row.get("elapsed_ms")),
                                "kind": row.get("kind"),
                                "rowCount": row.get("rowCount")},
                })
        return entries

    def last_error(self, user_id: str, session_id: str) -> dict[str, Any] | None:
        """答疑最需要的那一条：**最近的报错**（引擎原文 + 上一条 SQL）。"""
        entries = [e for e in self.fetch({"session_id": session_id, "user_id": user_id,
                                         "limit": 20}) if e.get("level") == "error"]
        return entries[-1] if entries else None


# ═══════════════════════════════════════════════════════════════════════
# 注册表（与引擎注册表同构）
# ═══════════════════════════════════════════════════════════════════════
_LOG_SOURCES: dict[str, LogSource] = {}


def register_log_source(source: LogSource) -> None:
    _LOG_SOURCES[source.info.id] = source


def ensure_default_log_sources(root: SandboxRoots | None = None) -> list[str]:
    """惰性注册默认日志源（同引擎：CLI 每次都是新进程，registry 初始为空）。"""
    if not _LOG_SOURCES:
        register_default_log_sources(root)
    return list(_LOG_SOURCES)


def get_log_source(engine_id: str = "sqlite",
                   root: SandboxRoots | None = None) -> LogSource | None:
    """取日志源；``root`` 给了就用它重建 SQLite 日志源。

    ⚠️ 与 ``engine.get_engine`` 同理：**忽略 payload 的 root 会读到别处的历史**
    （CLI 每次是新进程，但注册表里那个 ``SqliteLogSource(root=None)`` 指向仓库默认目录）。
    """
    ensure_default_log_sources(root)
    key = (engine_id or "sqlite").lower()
    if root is not None and key == "sqlite":
        _LOG_SOURCES["sqlite"] = SqliteLogSource(root=root)
    return _LOG_SOURCES.get(key)


def clear_log_sources() -> None:
    _LOG_SOURCES.clear()


def log_sources_report() -> list[dict[str, Any]]:
    ensure_default_log_sources()
    return [src.info.to_dict() for _, src in sorted(_LOG_SOURCES.items())]


def register_default_log_sources(root: SandboxRoots | None = None) -> list[str]:
    register_log_source(SqliteLogSource(root=root))
    # MySQL/PG/openGauss：只留位置，**不假装可用**（§8.3 的取法已写进文档，
    # adapter 接入后按同一注册方式挂进来即可）
    for engine_id, doc in (("mysql", "§8.3"), ("postgres", "§8.3"), ("opengauss", "§8.3")):
        register_log_source(_UnavailableLogSource(
            engine_id, f"该引擎的日志源 adapter 尚未接入（取法见 docs/LAB_DB_DEPLOY.md {doc}）"))
    return list(_LOG_SOURCES)


@dataclass
class _UnavailableLogSource:
    """未接入的日志源：**如实报不可用**（不假装能读日志 —— §8.4 硬要求）。"""

    id: str
    reason: str
    info: LogSourceInfo = field(init=False)

    def __post_init__(self) -> None:
        self.info = LogSourceInfo(id=self.id, layers=(), available=False, reason=self.reason)

    def fetch(self, req: dict[str, Any]) -> list[dict[str, Any]]:
        return []


def summarize_for_prompt(entries: list[dict[str, Any]], *, max_entries: int = 5,
                         max_chars: int = 1200) -> str:
    """把日志压成"喂提示词用的摘要"（§8.5.4：只放摘要 + 关键行）。

    读不到时**如实**写在摘要里（供 agent 说明"我读不到引擎日志"）。
    """
    if not entries:
        return "（本会话暂无 L1 日志：学生还没执行过语句，或日志已被重置）"
    lines: list[str] = []
    for e in entries[-max_entries:]:
        at = e.get("at")
        stamp = time.strftime("%H:%M:%S", time.localtime(at / 1000)) if at else "?"
        sql = (e.get("sql") or "").strip().replace("\n", " ")
        if len(sql) > 160:
            sql = sql[:160] + "…"
        head = f"[{stamp}][{e.get('source')}][{e.get('level')}]"
        if e.get("level") == "error":
            ctx = e.get("context") or {}
            extra = ""
            if ctx.get("killedBy"):
                extra = (f" | killedBy={ctx['killedBy']}"
                         f" hardKilled={str(bool(ctx.get('hardKilled'))).lower()}")
                if ctx.get("timeoutMs") is not None:
                    extra += f" timeoutMs={ctx['timeoutMs']}"
            lines.append(f"{head} {e.get('code')}: {e.get('message')}"
                         + (f" | SQL: {sql}" if sql else "") + extra)
        else:
            lines.append(f"{head} {sql or e.get('message')}")
    text = "\n".join(lines)
    if len(text) > max_chars:
        text = text[-max_chars:]
        lines = ["（日志片段已截断，只保留最近部分）", text]
        text = "\n".join(lines)
    return text
