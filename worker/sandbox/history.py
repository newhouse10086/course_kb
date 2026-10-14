# -*- coding: utf-8 -*-
"""执行历史 / 审计日志（**L1 日志的主来源**）。

规格依据：
* ``docs/LAB_DB_DEPLOY.md`` §7.6「审计：学生的每次执行记 ``audit_log``」
* §8.3 SQLite 的 L1 = 我们自己的 ``audit_log``（每次 SQL 与错误）+ 引擎原文报错
* §8.5 安全：**只读**、**必须过滤到本人会话**、**脱敏**、``limit`` 上限

为什么落成**每会话一个 JSONL 文件**（而不是 SQLite 表）：
``sandbox.exec`` 每次都可能是**独立进程**，还要在"死循环被 kill"的情况下**照样留下记录** ——
JSONL 追加写（``O_APPEND`` 一行一条）不怕进程被杀，也不需要另开一个库连接。
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Iterable

from worker.sandbox.errmsg import redact
from worker.sandbox.paths import SandboxRoots

#: 单会话最多保留多少条（超出后按"最近优先"读，文件本身做裁剪）
MAX_RECORDS = 500
#: 一次查询的上限（§8.5 长度限制）
MAX_LIMIT = 200


class SessionIsolationError(PermissionError):
    """跨会话读历史（越权）—— A 学生不能看 B 学生的 SQL 日志。"""

    code = "E_LOG_ISOLATION"


def history_path(root: SandboxRoots, user_id: str, session_id: str) -> Path:
    return root.session_path(user_id, session_id).with_suffix(".audit.jsonl")


def _safe_record(record: dict[str, Any]) -> dict[str, Any]:
    """写盘前**脱敏**（SQL 里可能带密码字面量，日志比数据更敏感）。"""
    out = dict(record)
    for key in ("sql", "error", "message", "hint"):
        if isinstance(out.get(key), str):
            out[key] = redact(out[key])
    if isinstance(out.get("statements"), list):
        out["statements"] = [
            {**s, **({"sql": redact(s["sql"])} if isinstance(s.get("sql"), str) else {})}
            for s in out["statements"]
        ]
    return out


def append(root: SandboxRoots, user_id: str, session_id: str,
           record: dict[str, Any]) -> dict[str, Any]:
    """追加一条执行记录（原子追加；进程被杀也不丢已写入的行）。"""
    path = history_path(root, user_id, session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    row = _safe_record({"at": int(time.time() * 1000), **record,
                        "userId": user_id, "sessionId": session_id})
    line = json.dumps(row, ensure_ascii=True) + "\n"
    # O_APPEND + 单次 write：并发/被杀都不会写坏已有行
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, line.encode("utf-8"))
    finally:
        os.close(fd)
    _trim(path)
    return row


def _trim(path: Path, keep: int = MAX_RECORDS) -> None:
    """超过上限时保留最近 ``keep`` 条（教学历史不需要无限增长）。"""
    try:
        if path.stat().st_size < 64 * 1024:
            return
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        if len(lines) <= keep:
            return
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text("\n".join(lines[-keep:]) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass


def read(root: SandboxRoots, user_id: str, session_id: str,
         *, since: int | None = None, limit: int = 50,
         request_user_id: str | None = None) -> list[dict[str, Any]]:
    """读该会话最近 ``limit`` 条记录（**只读**）。

    :param request_user_id: 发起方身份 —— **必须与记录所属会话一致**，
        否则抛 :class:`SessionIsolationError`（越权读别人的 SQL 日志）。
    """
    if request_user_id is not None and request_user_id != user_id:
        raise SessionIsolationError(
            f"拒绝跨用户读历史：请求者 {request_user_id!r} ≠ 会话所有者 {user_id!r}"
        )
    path = history_path(root, user_id, session_id)
    if not path.exists():
        return []
    cap = max(1, min(int(limit or 50), MAX_LIMIT))
    out: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue            # 半行（进程正好被杀）→ 跳过，不影响其它行
            if since is not None and int(row.get("at") or 0) < int(since):
                continue
            out.append(row)
    return out[-cap:]


def recent_executions(root: SandboxRoots, user_id: str, session_id: str,
                      limit: int = 20) -> list[dict[str, Any]]:
    """给 S4 答疑用的**精简形状**（与 ``pi-bridge`` 的 ``ExecutionRecord`` 对齐）：

    ``{at, sql, ok, error?, rowCount?, elapsedMs?}``
    """
    rows = read(root, user_id, session_id, limit=limit)
    out: list[dict[str, Any]] = []
    for row in rows:
        if row.get("action"):
            continue        # 非执行记录（如 agent 读日志的审计）不算"最近执行"
        item: dict[str, Any] = {
            "at": row.get("at"),
            "sql": row.get("sql") or "",
            "ok": bool(row.get("ok")),
        }
        err = row.get("error")
        if err:
            item["error"] = err
        # 写入端用 snake（row_count/elapsed_ms），对外形状是 camelCase（pi-bridge 契约）
        row_count = row.get("rowCount", row.get("row_count"))
        if row_count is not None:
            item["rowCount"] = row_count
        elapsed = row.get("elapsedMs", row.get("elapsed_ms"))
        if elapsed is not None:
            item["elapsedMs"] = elapsed
        # 超时的补充信息：S4/T-FRONTEND 要能说"是被停掉的，不是语法错"
        if row.get("code") == "E_SQL_TIMEOUT" or row.get("killed_by"):
            item["killedBy"] = row.get("killed_by") or row.get("killedBy")
            item["hardKilled"] = bool(row.get("hard_killed") or row.get("hardKilled"))
            if row.get("timeout_ms") is not None:
                item["timeoutMs"] = row.get("timeout_ms")
        if row.get("kind"):
            item["kind"] = row.get("kind")
        out.append(item)
    return out


def clear(root: SandboxRoots, user_id: str, session_id: str) -> None:
    """只在 ``reset`` 时内部调用 —— **不对外暴露**（日志只读，§8.5）。"""
    try:
        history_path(root, user_id, session_id).unlink(missing_ok=True)
    except OSError:
        pass
