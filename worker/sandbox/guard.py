# -*- coding: utf-8 -*-
"""★ SQL 安全闸 —— 学生执行的每一条 SQL 都必须先过这里。

规格：``docs/SETTINGS_AND_SANDBOX.md`` §3「安全（这是最危险的部分，必须做对）」。

这是**第一道**闸（第二道在 SQLite 的 ``set_authorizer``，见 ``runner.py``）。
两道都要有：正则/词法闸负责"给人看得懂的原因"，authorizer 负责"漏网也执行不了"。

设计要点（每条都对应一个真实逃逸手法）：

| 手法 | 后果 | 这里怎么拦 |
|---|---|---|
| ``ATTACH '/path/other.sqlite3' AS x`` | 读写**别人的库/主知识库** | 关键字拒绝 + authorizer ``SQLITE_ATTACH`` |
| ``SELECT load_extension('evil.dll')`` | **任意代码执行** | 关键字拒绝 + ``enable_load_extension(False)`` + authorizer |
| ``SELECT 1; DROP TABLE students`` | 多语句逃逸（第一句过审、第二句搞破坏） | **只允许单条**：字符串/注释之外出现 ``;`` 即拒 |
| ``PRAGMA writable_schema=ON`` | 直接篡改 ``sqlite_master``，库结构可被写成任意值 | PRAGMA 白名单（不含它）+ authorizer |
| ``PRAGMA temp_store_directory='/tmp'`` | 写到任意目录 | 同上 |
| 注释/字符串里藏关键字 ``SELECT 'ATTACH'`` | 误报（把合法查询拦了） | **先剥离注释与字符串字面量再分析** |
| ``sqlite_master`` 写入 | 库结构损坏 | 由 SQLite 自身禁止 + authorizer 拒绝 ``SQLITE_UPDATE`` on ``sqlite_master``（见 runner） |

诚实原则：**白名单**而不是黑名单 —— 只放行课程需要的那几类语句，
未知的一律拒绝并说明原因（``E_SQL_KIND``），而不是"看起来没危险就放"。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

#: 允许的**起始**关键字（WITH 是 ``WITH RECURSIVE`` 教学必需；
#: BEGIN/COMMIT/ROLLBACK 是「事务回滚」实验必需，见 LAB_DB_DEPLOY §6）
ALLOWED_KINDS = (
    "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER",
    "WITH", "VALUES", "EXPLAIN", "PRAGMA",
    "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "END",
)

#: 任何位置出现都直接拒绝的关键字（含大小写不敏感匹配）
FORBIDDEN_TOKENS = (
    "ATTACH", "DETACH", "LOAD_EXTENSION", "WRITABLE_SCHEMA", "TEMP_STORE_DIRECTORY",
    "READFILE", "WRITEFILE", "FSDIR", "EDIT", "SHELL", "SYSTEM",
    # 其他引擎的危险面（服务器类引擎接入后同样要拦；见 LAB_DB_DEPLOY §7.3）
    "INTO OUTFILE", "INTO DUMPFILE", "LOAD DATA", "PG_READ_FILE", "PG_READ_BINARY_FILE",
    "PG_LS_DIR", "LO_IMPORT", "LO_EXPORT", "DBLINK", "COPY", "PROGRAM",
)

#: 其他引擎的危险短语（含空格，用子串匹配；服务器类引擎接入后同样要拦，见 LAB_DB_DEPLOY §7.3）
FORBIDDEN_PHRASES = (
    "into outfile", "into dumpfile", "load data", "pg_read_file", "pg_read_binary_file",
    "pg_ls_dir", "lo_import", "lo_export", "dblink", "copy ", "copy(", "from program",
)

#: 明确**拒绝**的语句类型（危险或无关实验：VACUUM 能写任意文件、GRANT 是权限演练范畴外）
DENIED_KINDS = (
    "ATTACH", "DETACH", "VACUUM", "REINDEX", "ANALYZE", "GRANT", "REVOKE",
    "PRAGMA_VACUUM", "SAVEPOINT_RELEASE_ALL",
)

#: PRAGMA 白名单：**只读/自省**用途。写状态的（journal_mode/writable_schema/
#: temp_store_directory/cache_size…）一律不在内 —— 课程里也不需要。
#: ⚠️ `foreign_keys` 也**不在**白名单：沙箱连接固定 `foreign_keys=ON`（与 MySQL 对齐），
#:    允许学生关掉会让"外键约束"实验失去意义。
PRAGMA_WHITELIST = frozenset({
    "table_info", "table_xinfo", "table_list", "index_list", "index_info", "index_xinfo",
    "foreign_key_list", "database_list", "compile_options", "encoding", "page_count",
    "page_size", "schema_version", "user_version", "integrity_check",
    "quick_check", "function_list", "module_list", "pragma_list", "collation_list",
})

#: MySQL → SQLite 的方言提示（诚实标注：不要让学生以为两者语法等同）
DIALECT_HINTS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bAUTO_INCREMENT\b", re.I),
     "MySQL 用 AUTO_INCREMENT，SQLite 用 INTEGER PRIMARY KEY AUTOINCREMENT"),
    (re.compile(r"\bNOW\s*\(\s*\)", re.I),
     "MySQL 的 NOW() 在 SQLite 写成 datetime('now') 或 CURRENT_TIMESTAMP"),
    (re.compile(r"\bIFNULL\b", re.I), "SQLite 支持 IFNULL，但标准写法是 COALESCE(x, y)"),
    (re.compile(r"\bLIMIT\s+\d+\s*,", re.I),
     "MySQL 的 LIMIT offset,count 在 SQLite 写成 LIMIT count OFFSET offset"),
    (re.compile(r"\bSHOW\s+(TABLES|DATABASES)\b", re.I),
     "SQLite 没有 SHOW TABLES；用 SELECT name FROM sqlite_master WHERE type='table'"),
    (re.compile(r"\bDESCRIBE\b|\bDESC\s+\w", re.I),
     "SQLite 没有 DESCRIBE 表；用 PRAGMA table_info(表名)"),
    (re.compile(r"\bVARCHAR\s*\(\s*\d+\s*\)", re.I), "SQLite 无长度约束，TEXT 即可"),
    (re.compile(r"\bRIGHT\s+JOIN\b|\bFULL\s+(OUTER\s+)?JOIN\b", re.I),
     "SQLite 3.39+ 支持 RIGHT/FULL JOIN；旧版需改写"),
    (re.compile(r"`", re.I), "MySQL 的反引号在 SQLite 也能用，但标准是双引号或方括号"),
    (re.compile(r"\bGROUP_CONCAT\s*\(", re.I), "SQLite 有 GROUP_CONCAT，分隔符写法为 GROUP_CONCAT(x, ',')"),
    (re.compile(r"\bCURDATE\s*\(\s*\)|\bDATE_FORMAT\s*\(", re.I),
     "SQLite 用 strftime('%Y-%m-%d', ...) 替代 CURDATE()/DATE_FORMAT()"),
    (re.compile(r"\bENGINE\s*=", re.I), "SQLite 没有存储引擎概念（CREATE TABLE 不带 ENGINE）"),
)

_KIND_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*")
_PRAGMA_NAME_RE = re.compile(r"^PRAGMA\s+(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)")


@dataclass
class Verdict:
    """闸门结论。``ok=False`` 时 ``code``/``msg`` 直接用于 error 帧。"""

    ok: bool
    code: str = ""
    msg: str = ""
    kind: str = ""                     # 起始关键字（SELECT/CREATE/...）
    statement: str = ""                # 去掉注释后的语句（原样保留大小写）
    hints: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"ok": self.ok, "code": self.code, "msg": self.msg, "kind": self.kind,
                "hints": list(self.hints)}


def strip_comments_and_strings(sql: str) -> str:
    """把注释与字符串字面量替换成等长空白（保留其它内容的**字节位置**）。

    ★ 必须先做这一步：不剥的话
    * ``SELECT 'ATTACH' AS x`` 会被误判成危险语句（假阳性 → 课程功能不可用）
    * ``SELECT 1 /* ; DROP TABLE t */`` 里的分号会被当成多语句（同样误判）

    支持：``--`` 行注释、``/* */`` 块注释、``'...'``（``''`` 转义）、
    ``"..."``、``[...]``、``X'..'`` 形式的 blob 字面量。
    """
    out = list(sql)
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if ch == "-" and nxt == "-":
            while i < n and sql[i] != "\n":
                out[i] = " "
                i += 1
            continue
        if ch == "/" and nxt == "*":
            out[i] = out[i + 1] = " "
            i += 2
            while i < n and not (sql[i] == "*" and i + 1 < n and sql[i + 1] == "/"):
                if sql[i] != "\n":
                    out[i] = " "
                i += 1
            if i < n:
                out[i] = " "
                if i + 1 < n:
                    out[i + 1] = " "
                i += 2
            continue
        if ch in ("'", '"', "`"):
            quote = ch
            out[i] = " "
            i += 1
            while i < n:
                if sql[i] == quote:
                    if i + 1 < n and sql[i + 1] == quote:   # 双写转义
                        out[i] = out[i + 1] = " "
                        i += 2
                        continue
                    out[i] = " "
                    i += 1
                    break
                if sql[i] != "\n":
                    out[i] = " "
                i += 1
            continue
        if ch == "[":
            out[i] = " "
            i += 1
            while i < n and sql[i] != "]":
                out[i] = " "
                i += 1
            if i < n:
                out[i] = " "
                i += 1
            continue
        i += 1
    return "".join(out)


def split_statements(sql: str) -> list[str]:
    """按**字符串/注释之外**的分号切分语句（保留原样文本，不重排）。

    用于"显式分隔 + 逐条校验"的批次模式（事务实验必需）。
    不能简单 ``sql.split(";")`` —— 字符串字面量里的分号会被切碎
    （``INSERT INTO t VALUES ('a;b')`` 是**一条**语句）。
    """
    out: list[str] = []
    buf: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if ch == "-" and nxt == "-":
            j = i
            while j < n and sql[j] != "\n":
                j += 1
            buf.append(sql[i:j])
            i = j
            continue
        if ch == "/" and nxt == "*":
            j = i + 2
            while j < n and not (sql[j] == "*" and j + 1 < n and sql[j + 1] == "/"):
                j += 1
            j = min(j + 2, n)
            buf.append(sql[i:j])
            i = j
            continue
        if ch in ("'", '"', "`"):
            quote = ch
            j = i + 1
            while j < n:
                if sql[j] == quote:
                    if j + 1 < n and sql[j + 1] == quote:
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            buf.append(sql[i:j])
            i = j
            continue
        if ch == ";":
            out.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    if "".join(buf).strip():
        out.append("".join(buf))
    return out


#: 事务控制类语句。**单独发**时在"每次执行一个新进程/新连接"的沙箱里**无法生效** ——
#: 见 `exec.py::execute` 的诚实拒绝（E_SQL_UNSUPPORTED），这是 backend-api 独立复现的 bug：
#: 单发 `BEGIN` 报成功、随后 `ROLLBACK` 报 "no transaction is active"，而数据**已被提交**。
TX_CONTROL_KINDS = ("BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "END")


def is_tx_control(kind: str) -> bool:
    """这一句（或这一批）是不是**纯事务控制**语句。"""
    kinds = [k for k in str(kind or "").split(";") if k]
    return bool(kinds) and all(k in TX_CONTROL_KINDS for k in kinds)


def statement_kind(clean: str) -> str:
    m = _KIND_RE.match(clean.strip())
    return m.group(0).upper() if m else ""


def check_sql(sql: str, *, max_length: int = 20_000, allow_multi: bool = False) -> Verdict:
    """SQL 安全闸主入口。返回 :class:`Verdict`（``ok=False`` 时给出可读原因）。

    :param allow_multi: ``False``（默认）→ **只允许单条语句**；
        ``True`` → 允许 ``BEGIN; UPDATE …; ROLLBACK;`` 这种**显式分隔**的批次，
        但会**逐条**过同一个闸（规格 §3 明确允许"或显式分隔且逐条校验"）。
        每一句仍然受全部关键字/PRAGMA 规则约束 —— 多语句不是"放宽"，只是"多验几遍"。
    """
    raw = sql or ""
    if not raw.strip():
        return Verdict(False, "E_SQL_EMPTY", "SQL 为空")
    if len(raw) > max_length:
        return Verdict(False, "E_SQL_TOO_LONG",
                       f"SQL 过长（{len(raw)} 字符 > {max_length}）")

    if allow_multi:
        parts = split_statements(raw)
        # 末尾分号会产生空片段 → 过滤
        parts = [p for p in parts if strip_comments_and_strings(p).strip("; \t\r\n")]
        if not parts:
            return Verdict(False, "E_SQL_EMPTY", "SQL 为空（只有分号/注释）")
        if len(parts) > 50:
            return Verdict(False, "E_SQL_TOO_MANY", f"批次语句过多（{len(parts)} > 50）")
        kinds: list[str] = []
        for idx, part in enumerate(parts):
            v = check_sql(part, max_length=max_length, allow_multi=False)
            if not v.ok:
                return Verdict(False, v.code, f"第 {idx + 1} 句：{v.msg}", kind=v.kind)
            kinds.append(v.kind)
        return Verdict(True, kind=";".join(kinds), statement=raw.strip(),
                       hints=dialect_hints(raw))

    return check_one(raw, max_length=max_length)


def check_one(sql: str, *, max_length: int = 20_000) -> Verdict:
    """单条语句检查（:func:`check_sql` 的非批次路径）。"""
    raw = sql or ""
    if not raw.strip():
        return Verdict(False, "E_SQL_EMPTY", "SQL 为空")
    if len(raw) > max_length:
        return Verdict(False, "E_SQL_TOO_LONG",
                       f"SQL 过长（{len(raw)} 字符 > {max_length}）")

    clean = strip_comments_and_strings(raw)
    # ★ 分析用 clean，**执行必须用原文**！
    #   第一版把 `verdict.statement` 设成了剥离后的文本 → 字符串字面量被替换成空格，
    #   于是 `WHERE dept='计算机'` 变成 `WHERE dept=        ` → `near "ORDER": syntax error`；
    #   `CREATE TABLE t(id ...)` 也报错。**分析和执行必须是两份文本**。
    original = raw.strip()
    if original.endswith(";"):
        original = original[:-1].rstrip()
    # ① 单语句：字符串/注释之外的分号只允许出现在**末尾**（其后只能是空白）
    stripped_clean = clean.strip()
    body = stripped_clean[:-1] if stripped_clean.endswith(";") else stripped_clean
    if ";" in body:
        return Verdict(False, "E_SQL_MULTI",
                       "只允许**单条**语句（检测到多个分号）：防注入式逃逸")
    if not body.strip():
        return Verdict(False, "E_SQL_EMPTY", "SQL 为空（只有分号/注释）")

    # ② 危险关键字**先查**（拿到具体原因，而不是笼统的"类型不允许"）：
    #    例：ATTACH 本就不在白名单类型里，但学生更该看到"禁止 ATTACH：能读写沙箱外的库"
    upper = body.upper()
    for token in FORBIDDEN_TOKENS:
        if re.search(rf"\b{re.escape(token)}\b", upper):
            reason = {
                "ATTACH": "禁止 ATTACH：会读写沙箱外的库文件（含主知识库）",
                "DETACH": "禁止 DETACH",
                "LOAD_EXTENSION": "禁止 load_extension：等于任意代码执行",
                "WRITABLE_SCHEMA": "禁止 writable_schema：会直接篡改库结构",
                "TEMP_STORE_DIRECTORY": "禁止 temp_store_directory：会写到任意目录",
                "READFILE": "禁止 readfile（文件读取）",
                "WRITEFILE": "禁止 writefile（文件写入）",
                "FSDIR": "禁止 fsdir",
                "EDIT": "禁止 edit",
                "SHELL": "禁止 shell",
                "SYSTEM": "禁止 system",
            }.get(token, f"禁止 {token}")
            return Verdict(False, "E_SQL_FORBIDDEN", reason, kind=statement_kind(body))

    # ③ 语句类型：明确拒绝的一律拒；**认不出的交给 SQLite 自己报语法错**
    #    （比我们在闸里笼统说"类型不允许"更有教学价值：
    #     学生写 `SELEC * FROM students` 该看到 `near "SELEC": syntax error`）
    kind = statement_kind(body)
    if kind in DENIED_KINDS:
        return Verdict(False, "E_SQL_KIND",
                       f"不允许的语句类型 {kind}（沙箱只做课程实验所需的读写与自省）")
    if not kind:
        return Verdict(False, "E_SQL_KIND", "无法识别语句类型（既不是 SQL 关键字也不是合法语句）")
    if kind not in ALLOWED_KINDS:
        # 交给 SQLite：它必然给语法错误（C 层解析器不会执行未知语句）
        pass

    # ④ PRAGMA 白名单
    if kind == "PRAGMA":
        m = _PRAGMA_NAME_RE.match(body.strip())
        name = (m.group(1).lower() if m else "")
        if name not in PRAGMA_WHITELIST:
            return Verdict(False, "E_SQL_PRAGMA",
                           f"PRAGMA {name or '(未识别)'} 不在白名单内；只允许只读自省类："
                           f"{', '.join(sorted(PRAGMA_WHITELIST))}", kind=kind)

    # ④b 其他引擎的危险短语（含空格的形式，词边界匹配不到）
    low = body.lower()
    for phrase in FORBIDDEN_PHRASES:
        if phrase in low:
            return Verdict(False, "E_SQL_FORBIDDEN",
                           f"禁止 {phrase.upper().strip()}：服务器类引擎的越权/读文件入口"
                           "（LAB_DB_DEPLOY §7.3）", kind=kind)

    # ⑤ 单语句里禁止 `BEGIN`/`COMMIT` 之外的"事务控制逃逸"？—— 允许：
    #    教学要练 `BEGIN … ROLLBACK`，见 docs/LAB_DB_DEPLOY §6「事务/回滚 ✅」
    return Verdict(True, kind=kind, statement=original, hints=dialect_hints(raw))


def dialect_hints(sql: str) -> list[str]:
    """MySQL → SQLite 方言提示（非致命，随结果一起返回）。"""
    out: list[str] = []
    for pattern, message in DIALECT_HINTS:
        if pattern.search(sql or "") and message not in out:
            out.append(message)
    return out
