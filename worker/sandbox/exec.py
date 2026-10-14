# -*- coding: utf-8 -*-
"""沙箱执行驱动（父进程侧）—— **独立进程 + 硬超时 kill**。

为什么必须这样（``docs/SETTINGS_AND_SANDBOX.md`` §3 / ``LAB_DB_DEPLOY.md`` §7.4）：
``better-sqlite3`` 是**同步**的 → 学生在浏览器里跑
``WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT * FROM c``
会把 Node 事件循环**整个卡死**（``/health`` 不再响应）。
所以执行体必须落在**独立进程**，并由父进程用 ``subprocess(timeout=)`` + ``kill()``
做**进程级**硬超时 —— SQLite 自己的 ``progress_handler`` 只是"更快更干净"的第一层。

三层超时（都要有）：
1. SQLite ``progress_handler``（子进程内，2k VM 指令检查一次）→ 干净的超时错误
2. 子进程自身 ``deadline``（同上，覆盖非回调路径）
3. **父进程 ``kill()``** ← 最终保证（C 层死循环、回调不触发时只有它能兜住）
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from worker.sandbox import history as history_mod
from worker.sandbox.errmsg import interpret_error
from worker.sandbox.guard import check_sql, dialect_hints, is_tx_control
from worker.sandbox.paths import SandboxRoots

REPO_ROOT = Path(__file__).resolve().parents[2]
#: 父进程比子进程多等的余量（秒）—— 让子进程的干净超时先触发，kill 只做兜底
KILL_GRACE_S = 0.75
DEFAULT_MAX_ROWS = 200


def _runner_env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = str(REPO_ROOT) + (os.pathsep + existing if existing else "")
    return env


def _popen_kwargs() -> dict[str, Any]:
    if os.name == "nt":
        # CREATE_NO_WINDOW：不给每次执行弹黑框；不新开进程组（我们直接 kill 子进程）
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    return {"start_new_session": True}


def execute(*, db_path: str | Path, sql: str, max_rows: int = DEFAULT_MAX_ROWS,
            timeout_ms: int = 5_000, user_id: str = "", session_id: str = "",
            allow_multi: bool = False, root: str | Path | None = None,
            max_db_bytes: int | None = None, record_history: bool = True) -> dict[str, Any]:
    """执行一条（或一批显式分隔的）SQL，返回 ``ExecResult`` 形状的字典。

    结果里有两个**给人看**的额外字段（S4 答疑要用）：
    * ``error.message`` —— **引擎原文**（一字不改）
    * ``error.hint``    —— 本地确定性解读（如"表不存在 → 先看 sqlite_master"）
    """
    roots = SandboxRoots.resolve(root)
    path = roots.validate(db_path)
    hints = dialect_hints(sql)

    # ① 词法闸（第一道）—— 不通过就不执行，并且**仍然记审计**（学生试过什么很重要）
    verdict = check_sql(sql, allow_multi=allow_multi)
    if not verdict.ok:
        result = {
            "columns": [], "rows": [], "rowCount": 0, "elapsedMs": 0,
            "engine": "sqlite", "hints": hints, "ok": False,
            "killedBy": None, "hardKilled": False,
            "error": {"code": verdict.code, "message": verdict.msg, "raw": verdict.msg,
                      "hint": "该语句被沙箱安全策略拒绝（并非 SQL 写错）",
                      "localReading": verdict.msg, "localMatched": False},
        }
        if record_history:
            _record(roots, user_id, session_id, sql=sql, ok=False,
                    error=verdict.msg, code=verdict.code, kind=verdict.kind, elapsed_ms=0,
                    row_count=0)
        return result

    # ①b ★**单独发**的事务控制语句：诚实拒绝（不是静默失败、也不是假成功）
    #    为什么必须拒：每次执行都是**独立进程 + 独立连接**（这是硬超时安全的代价），
    #    所以 `BEGIN` 开的事务在连接关闭时就没了 —— 单发 BEGIN 报成功，随后 ROLLBACK
    #    报 "no transaction is active"，而中间的 INSERT **已被提交**（backend-api 独立复现：
    #    期望 1 行、实际 2 行）。这是"看起来成功"的最坏形态，必须显式说清。
    #    同一次调用内的批次（`multi:true`）**事务语义完全正确**，所以引导到批次。
    if not allow_multi and is_tx_control(verdict.kind):
        msg = ("沙箱每次执行都是独立进程，事务状态无法跨调用保留 → "
               f"单发的 {verdict.kind} 不会生效（后续语句会被立即提交）")
        if record_history:
            _record(roots, user_id, session_id, sql=sql, ok=False, error=msg,
                    code="E_SQL_UNSUPPORTED", kind=verdict.kind, elapsed_ms=0, row_count=0)
        return {
            "columns": [], "rows": [], "rowCount": 0, "elapsedMs": 0,
            "engine": "sqlite", "hints": hints, "ok": False,
            "killedBy": None, "hardKilled": False, "txUnsupported": True,
            "error": {
                "code": "E_SQL_UNSUPPORTED",
                "message": msg,
                "raw": msg,
                "hint": ("做事务实验请把整批语句放进**同一次**请求："
                         '{"sql":"BEGIN; INSERT …; ROLLBACK;","multi":true}（已实测可用）；'
                         "或用 sandbox.reset 恢复初始数据"),
                "localReading": "沙箱不支持**跨调用**事务（不是你的 SQL 写错了，也不是语法错）",
                "localMatched": True,
                "who": "rules",
            },
        }

    payload = {
        "db_path": str(path),
        "sql": verdict.statement,
        "multi": bool(allow_multi),
        "max_rows": int(max_rows or DEFAULT_MAX_ROWS),
        "timeout_ms": int(timeout_ms or 5_000),
        "root": str(roots.root),
    }
    if max_db_bytes is not None:
        payload["max_db_bytes"] = int(max_db_bytes)

    started = time.monotonic()
    proc = subprocess.Popen(
        [sys.executable, "-m", "worker.sandbox.runner"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=str(REPO_ROOT), env=_runner_env(), text=True, encoding="utf-8",
        **_popen_kwargs(),
    )
    timed_out = False
    stdout = stderr = ""
    try:
        stdout, stderr = proc.communicate(json.dumps(payload, ensure_ascii=False),
                                          timeout=timeout_ms / 1000.0 + KILL_GRACE_S)
    except subprocess.TimeoutExpired:
        # ★ 硬杀（这是"不阻塞服务"的最终保证）
        timed_out = True
        try:
            proc.kill()
        except OSError:
            pass
        try:
            stdout, stderr = proc.communicate(timeout=5)
        except (subprocess.TimeoutExpired, OSError):
            stdout, stderr = "", ""

    elapsed_ms = int((time.monotonic() - started) * 1000)

    if timed_out:
        result = {
            "columns": [], "rows": [], "rowCount": 0, "elapsedMs": elapsed_ms,
            "engine": "sqlite", "hints": hints, "hardKilled": True, "killedBy": "process",
            "error": {
                "code": "E_SQL_TIMEOUT",
                "message": f"执行超过 {timeout_ms}ms，**进程已被硬杀**（进程级超时）",
                "raw": "",
                "hint": "递归 CTE 必须有终止条件；也可先用 LIMIT 小范围试。"
                        "长查询不会影响其它学生（每次执行都在独立进程里）。",
            },
        }
        if record_history:
            _record(roots, user_id, session_id, sql=sql, ok=False,
                    error="E_SQL_TIMEOUT（进程被硬杀）", code="E_SQL_TIMEOUT",
                    kind=verdict.kind, elapsed_ms=elapsed_ms, row_count=0,
                    # ★ 审计要留下"是被硬杀的" —— S4 答疑靠它说清
                    #   "你的递归 CTE 是被超时停掉的，不是语法错"（pi-bridge 的 P1）
                    hard_killed=True, killed_by="process", timeout_ms=timeout_ms)
        return result

    parsed: dict[str, Any] | None = None
    for line in reversed([l for l in (stdout or "").split("\n") if l.strip()]):
        try:
            parsed = json.loads(line)
            break
        except json.JSONDecodeError:
            continue

    if parsed is None:
        err = {
            "code": "E_SANDBOX_RUNNER",
            "message": f"子进程没有返回可解析的 JSON（exit={proc.returncode}）",
            "raw": (stderr or "").strip()[-2000:],
            "hint": "沙箱执行体自身出错；这不是学生 SQL 的问题",
        }
        result = {"columns": [], "rows": [], "rowCount": 0, "elapsedMs": elapsed_ms,
                  "engine": "sqlite", "hints": hints, "error": err}
        if record_history:
            _record(roots, user_id, session_id, sql=sql, ok=False, error=err["message"],
                    code=err["code"], kind=verdict.kind, elapsed_ms=elapsed_ms, row_count=0)
        return result

    result = dict(parsed)
    result.setdefault("engine", "sqlite")
    result["hints"] = hints or result.get("hints") or []
    result.setdefault("elapsedMs", elapsed_ms)
    if proc.returncode not in (0,) and not result.get("error"):
        result["error"] = {
            "code": "E_SANDBOX_RUNNER",
            "message": f"子进程以 {proc.returncode} 退出且未给错误码",
            "raw": (stderr or "").strip()[-2000:],
            "hint": "沙箱执行体异常退出",
        }

    # ② 错误附带**引擎原文 + 本地解读**（S4 的核心输入）
    err = result.get("error")
    if isinstance(err, dict):
        raw = str(err.get("raw") or "")
        if not raw:
            raw = str(err.get("msg") or err.get("message") or "")
        interp = interpret_error(raw)
        child_msg = str(err.get("msg") or err.get("message") or "")
        is_timeout = err.get("code") == "E_SQL_TIMEOUT"
        if is_timeout:
            # 子进程的 progress_handler 先触发 → 干净超时（父进程 kill 仍在待命）
            err["message"] = (f"执行超过 {timeout_ms}ms 被中断"
                              f"（SQLite progress_handler；父进程 {KILL_GRACE_S}s 后硬杀）")
            err["killedBy"] = "progress"
            err["hardKilled"] = False
        else:
            # ★ 原文优先：S4 必须拿到 `near "FROM": syntax error` 这种**一字不改**的文本
            err["message"] = raw or child_msg
        err["raw"] = raw
        err.setdefault("hint", interp.hint)
        err["localReading"] = interp.message
        err["localMatched"] = interp.matched
        err.pop("msg", None)
        # 顶层也带一份（Node 侧不用深挖 error 就能判断"是不是被硬杀"）
        result["killedBy"] = err.get("killedBy")
        result["hardKilled"] = bool(err.get("hardKilled"))
    result["ok"] = not err

    if record_history:
        err_code = (err or {}).get("code") if isinstance(err, dict) else None
        err_msg = (err or {}).get("message") if isinstance(err, dict) else None
        if err_code == "E_SQL_TIMEOUT" and err_msg:
            # 让审计里的 error 文本也带码（两种超时路径格式统一，便于 grep/统计）
            err_msg = f"E_SQL_TIMEOUT：{err_msg}"
        _record(roots, user_id, session_id, sql=sql, ok=result["ok"],
                error=err_msg,
                code=err_code,
                kind=verdict.kind, elapsed_ms=result.get("elapsedMs", elapsed_ms),
                row_count=result.get("rowCount", 0),
                affected=result.get("affected"),
                statements=result.get("statements"),
                # ★ 超时信息一并落审计：S4 的 `sandbox.logs`/`sandbox.history` 要能
                #   告诉学生"是被超时停掉的，不是你语法错"（progress=SQLite 层中断，
                #   process=父进程硬杀）。⚠️ hardKilled 必须取**实际结果**，
                #   不能一律写 True —— progress 路径并没有杀进程（实测抓出过这个不一致）
                **({"killed_by": result.get("killedBy"),
                    "hard_killed": bool(result.get("hardKilled")),
                    "timeout_ms": timeout_ms} if err_code == "E_SQL_TIMEOUT" else {}))
    return result


def _record(roots: SandboxRoots, user_id: str, session_id: str, **fields: Any) -> None:
    if not user_id or not session_id:
        return
    try:
        history_mod.append(roots, user_id, session_id, fields)
    except Exception:  # noqa: BLE001 - 审计失败不能影响学生执行
        pass
