# -*- coding: utf-8 -*-
"""沙箱执行子进程 —— **真正的执行体**（父进程用 ``subprocess`` + 硬超时杀它）。

为什么要单独一个进程（规格 §3 资源限制）：
``better-sqlite3`` 是**同步**的，学生在浏览器跑 ``WITH RECURSIVE`` 死循环会把
Node 事件循环整个卡住 → 必须"独立进程 + 硬超时杀进程"。
Python 侧同理：靠 SQLite 自己的 ``progress_handler`` 只能拦住"老实跑 SQL 的情况"，
拦不住死在 C 层/忘了回调的路径 —— 所以**父进程 kill 才是最终保证**
（``exec.py`` 负责），这里的 ``progress_handler`` 只是"更快、更干净地报超时"。

第二道防线（即使词法闸被绕过也执行不了）：
``set_authorizer`` 在 **SQLite 内部**拒绝 ``ATTACH`` / ``DETACH`` /
``load_extension`` / 白名单外 ``PRAGMA`` / 虚拟表 / 写 ``sqlite_master``。

本模块既可被当脚本跑（``python -m worker.sandbox.runner``，stdin 收 payload），
也可被测试直接调用 :func:`run_payload`（**不经词法闸** —— 测试用它验证 authorizer）。
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

from worker.sandbox.guard import PRAGMA_WHITELIST, check_sql
from worker.sandbox.paths import SandboxRoots

DEFAULT_MAX_ROWS = 200
DEFAULT_TIMEOUT_MS = 5_000
MAX_ROWS_LIMIT = 5_000
#: 单个学生库文件上限（超出即拒绝写入并回滚）
DEFAULT_MAX_DB_BYTES = 64 * 1024 * 1024
#: progress_handler 的回调间隔（VM 指令数）
_PROGRESS_EVERY = 2_000


def _authorizer(action: int, arg1: Any, arg2: Any, dbname: Any, source: Any) -> int:
    """SQLite 授权回调 —— **第二道防线**（在 SQLite 内部生效）。

    返回 ``SQLITE_DENY`` 会让语句执行失败（错误信息里带 "not authorized"）。
    """
    a = arg1 if isinstance(arg1, str) else ""
    lower = a.lower()
    if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_FUNCTION and (lower == "load_extension" or
                                              (isinstance(arg2, str) and arg2.lower() == "load_extension")):
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_PRAGMA:
        return sqlite3.SQLITE_OK if lower in PRAGMA_WHITELIST else sqlite3.SQLITE_DENY
    if action in (sqlite3.SQLITE_CREATE_VTABLE, sqlite3.SQLITE_DROP_VTABLE):
        return sqlite3.SQLITE_DENY
    # 写 sqlite_master（SQLite 自身也会拒，这里是双保险 + 更清楚的错误）
    if action in (sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE) \
            and lower in ("sqlite_master", "sqlite_schema", "sqlite_temp_master"):
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def statement_kind_of(sql: str) -> str:
    """单条语句的起始关键字（批次模式逐条记录用）。"""
    from worker.sandbox.guard import statement_kind, strip_comments_and_strings

    return statement_kind(strip_comments_and_strings(sql or ""))


def _jsonable(value: Any) -> Any:
    """把 SQLite 返回值转成 JSON 可序列化类型（诚实转换，不丢精度描述）。"""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        return {"__type__": "blob", "hex": raw.hex()[:512], "bytes": len(raw)}
    return str(value)


def _connect(db_path: Path, timeout_s: float) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=timeout_s, isolation_level=None)
    # ★ 关掉扩展加载：load_extension() 即使在词法闸被绕过时也不会成功
    try:
        conn.enable_load_extension(False)
    except Exception:  # noqa: BLE001 - 某些构建没编译该开关
        pass
    conn.set_authorizer(_authorizer)
    # defensive：限制单条 SQL 的长度与可挂载的库数量
    for limit_name, value in (("SQLITE_LIMIT_ATTACHED", 0),
                              ("SQLITE_LIMIT_LENGTH", 1_000_000),
                              ("SQLITE_LIMIT_SQL_LENGTH", 100_000),
                              ("SQLITE_LIMIT_COMPOUND_SELECT", 64)):
        limit = getattr(sqlite3, limit_name, None)
        if limit is not None:
            try:
                conn.setlimit(limit, value)
            except Exception:  # noqa: BLE001
                pass
    return conn


def _sqlite_error(exc: sqlite3.Error) -> dict[str, Any]:
    msg = str(exc)
    low = msg.lower()
    if "interrupted" in low:
        return {"code": "E_SQL_TIMEOUT", "msg": f"执行超时被中断：{msg}"}
    if "not authorized" in low:
        return {"code": "E_SQL_FORBIDDEN", "msg": f"SQLite 授权拒绝：{msg}"}
    if "syntax error" in low or "incomplete input" in low:
        return {"code": "E_SQL_SYNTAX", "msg": msg}
    if "no such table" in low or "no such column" in low or "no such function" in low:
        return {"code": "E_SQL_NO_OBJECT", "msg": msg}
    return {"code": "E_SQL_EXEC", "msg": msg}


def run_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """执行一条 SQL，返回结果字典（**不抛异常** —— 错误走 ``error`` 字段）。

    ``payload``：``{db_path, sql, max_rows, timeout_ms, max_db_bytes, root}``
    """
    roots = SandboxRoots.resolve(payload.get("root"))
    db_path = roots.validate(payload.get("db_path") or "")
    sql = str(payload.get("sql") or "")
    max_rows = min(int(payload.get("max_rows") or DEFAULT_MAX_ROWS), MAX_ROWS_LIMIT)
    timeout_ms = int(payload.get("timeout_ms") or DEFAULT_TIMEOUT_MS)
    max_db_bytes = int(payload.get("max_db_bytes") or DEFAULT_MAX_DB_BYTES)

    verdict = check_sql(sql, allow_multi=bool(payload.get("multi")))
    if not verdict.ok:
        return {"columns": [], "rows": [], "rowCount": 0, "elapsedMs": 0,
                "error": {"code": verdict.code, "msg": verdict.msg, "raw": verdict.msg},
                "hints": verdict.hints}
    from worker.sandbox.guard import split_statements

    batch = split_statements(verdict.statement) if payload.get("multi") else [verdict.statement]
    batch = [b for b in batch if b.strip()]
    statement = verdict.statement
    is_write = verdict.kind in ("INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER") or \
        any(k in verdict.kind for k in ("INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER"))

    started = time.monotonic()
    deadline = started + timeout_ms / 1000.0
    killed_by = {"reason": ""}

    def progress() -> int:
        if time.monotonic() > deadline:
            killed_by["reason"] = "progress"
            return 1          # 非 0 → SQLite 中断当前语句
        return 0

    conn: sqlite3.Connection | None = None
    try:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = _connect(db_path, timeout_s=max(1.0, timeout_ms / 1000.0))
        conn.set_progress_handler(progress, _PROGRESS_EVERY)

        columns: list[str] = []
        rows: list[list[Any]] = []
        truncated = False
        changes: int | None = None
        per_statement: list[dict[str, Any]] = []
        affected_total = 0

        # 事务批次（BEGIN … ROLLBACK）必须在**同一个连接**里逐条执行 ——
        # 这也是"事务/回滚"实验能做的前提（LAB_DB_DEPLOY §6）
        implicit_tx = is_write and not payload.get("multi")
        if implicit_tx:
            conn.execute("BEGIN IMMEDIATE")
        try:
            for idx, one in enumerate(batch, start=1):
                k = statement_kind_of(one)
                try:
                    cur = conn.execute(one)
                    if cur.description is not None:
                        columns = [d[0] for d in cur.description]
                        fetched = cur.fetchmany(max_rows + 1)
                        truncated = len(fetched) > max_rows
                        rows = [[_jsonable(v) for v in row] for row in fetched[:max_rows]]
                    else:
                        changes = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else None
                        affected_total += int(changes or 0)
                    per_statement.append({"index": idx, "kind": k, "ok": True,
                                          "sql": one.strip()[:500],
                                          **({"affected": changes} if changes is not None else {})})
                except sqlite3.Error as exc:
                    e = _sqlite_error(exc)
                    if killed_by["reason"] == "progress" and e["code"] != "E_SQL_TIMEOUT":
                        e = {"code": "E_SQL_TIMEOUT",
                             "msg": f"执行超过 {timeout_ms}ms 被中断（SQLite 层）"}
                    per_statement.append({"index": idx, "kind": k, "ok": False,
                                          "sql": one.strip()[:500], "error": e})
                    if len(batch) > 1:
                        # 批次模式：遇到错误**停在该处**并把已完成的部分如实回报
                        # （不自动回滚 —— 学生要自己观察"错在哪一步、库变成什么样"）
                        return {
                            "columns": columns, "rows": rows, "rowCount": len(rows),
                            "truncated": truncated, "changes": affected_total,
                            "statements": per_statement,
                            "elapsedMs": int((time.monotonic() - started) * 1000),
                            "error": e, "hints": verdict.hints,
                        }
                    raise
            if implicit_tx:
                size = db_path.stat().st_size if db_path.exists() else 0
                if size > max_db_bytes:
                    conn.execute("ROLLBACK")
                    return {
                        "columns": [], "rows": [], "rowCount": 0,
                        "elapsedMs": int((time.monotonic() - started) * 1000),
                        "error": {
                            "code": "E_SANDBOX_SIZE",
                            "msg": f"库文件超过上限（{size} > {max_db_bytes} 字节）→ 已回滚本次写入",
                        },
                        "hints": verdict.hints,
                    }
                conn.execute("COMMIT")
        except sqlite3.Error as exc:
            if implicit_tx:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
            err = _sqlite_error(exc)
            if killed_by["reason"] == "progress" and err["code"] != "E_SQL_TIMEOUT":
                err = {"code": "E_SQL_TIMEOUT",
                       "msg": f"执行超过 {timeout_ms}ms 被中断（SQLite 层）"}
            err["raw"] = str(exc)
            return {"columns": [], "rows": [], "rowCount": 0,
                    "elapsedMs": int((time.monotonic() - started) * 1000),
                    "error": err, "hints": verdict.hints,
                    **({"statements": per_statement} if per_statement else {})}

        elapsed_ms = int((time.monotonic() - started) * 1000)
        size = db_path.stat().st_size if db_path.exists() else 0
        out: dict[str, Any] = {
            "columns": columns,
            "rows": rows,
            "rowCount": len(rows),
            "truncated": truncated,
            "elapsedMs": elapsed_ms,
            "statementKind": verdict.kind,
            "dbBytes": size,
            "hints": verdict.hints,
        }
        if affected_total:
            out["affected"] = affected_total
        if changes is not None and not affected_total:
            out["affected"] = changes
        if len(batch) > 1:
            out["statements"] = per_statement
        return out
    except sqlite3.Error as exc:            # 连接层错误（打不开文件等）
        return {"columns": [], "rows": [], "rowCount": 0,
                "elapsedMs": int((time.monotonic() - started) * 1000),
                "error": _sqlite_error(exc), "hints": verdict.hints}
    except Exception as exc:  # noqa: BLE001 - 兜底：绝不让子进程带异常退出
        return {"columns": [], "rows": [], "rowCount": 0,
                "elapsedMs": int((time.monotonic() - started) * 1000),
                "error": {"code": "E_SQL_EXEC", "msg": f"{type(exc).__name__}: {exc}"},
                "hints": verdict.hints}
    finally:
        if conn is not None:
            try:
                conn.set_progress_handler(None, 0)
                conn.close()
            except Exception:  # noqa: BLE001
                pass


def main(argv: list[str] | None = None) -> int:
    """子进程入口：stdin 一行 JSON payload → stdout 一行 JSON 结果。"""
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": {"code": "E_PAYLOAD", "msg": f"payload 不是 JSON：{exc}"}},
                         ensure_ascii=True))
        return 2
    result = run_payload(payload)
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
