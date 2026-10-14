# -*- coding: utf-8 -*-
"""★ SQL 安全闸测试 —— **负例是重点**（``docs/LAB_DB_DEPLOY.md`` §7.3）。

每一条负例都对应一个真实逃逸手法，断言的是**具体错误码 + 关键文案**，
不是"没通过"这种模糊判断。
"""

from __future__ import annotations

import pytest

from worker.sandbox import guard


# ═══════════════════════════════════════════════════════════════════════
# 负例：必须拒绝
# ═══════════════════════════════════════════════════════════════════════
@pytest.mark.parametrize("sql,code,needle", [
    # ① ATTACH：能读写沙箱外的库（含主知识库）
    ("ATTACH '/tmp/other.sqlite3' AS other", "E_SQL_FORBIDDEN", "ATTACH"),
    ("attach database 'x.db' as x", "E_SQL_FORBIDDEN", "ATTACH"),
    ("DETACH DATABASE main", "E_SQL_FORBIDDEN", "DETACH"),
    # ② load_extension：任意代码执行
    ("SELECT load_extension('evil.dll')", "E_SQL_FORBIDDEN", "load_extension"),
    ("SELECT LOAD_EXTENSION('x')", "E_SQL_FORBIDDEN", "load_extension"),
    # ③ 多语句：第一句过审、第二句搞破坏
    ("SELECT 1; DROP TABLE students", "E_SQL_MULTI", "单条"),
    ("DROP TABLE students; DROP TABLE courses", "E_SQL_MULTI", "单条"),
    ("SELECT 1; ATTACH 'x' AS y", "E_SQL_MULTI", "单条"),
    # ④ PRAGMA 白名单
    ("PRAGMA writable_schema=ON", "E_SQL_FORBIDDEN", "writable_schema"),
    ("PRAGMA temp_store_directory='/tmp'", "E_SQL_FORBIDDEN", "temp_store_directory"),
    ("PRAGMA journal_mode=DELETE", "E_SQL_PRAGMA", "白名单"),
    ("PRAGMA cache_size=-1000", "E_SQL_PRAGMA", "白名单"),
    ("PRAGMA foreign_keys=OFF", "E_SQL_PRAGMA", "白名单"),
    # ⑤ 语句类型白名单
    ("VACUUM INTO '/tmp/x'", "E_SQL_KIND", "VACUUM"),
    ("REINDEX students", "E_SQL_KIND", "REINDEX"),
    ("ANALYZE", "E_SQL_KIND", "ANALYZE"),
    ("GRANT ALL ON db TO x", "E_SQL_KIND", "GRANT"),
    # ⑥ 其他引擎的越权入口（服务器类引擎接入后同样要拦）
    ("SELECT * INTO OUTFILE '/tmp/x' FROM students", "E_SQL_FORBIDDEN", "OUTFILE"),
    ("SELECT pg_read_file('/etc/passwd')", "E_SQL_FORBIDDEN", "pg_read_file"),
    ("LOAD DATA INFILE '/etc/passwd' INTO TABLE t", "E_SQL_FORBIDDEN", "LOAD DATA"),
    # ⑦ 空/超长
    ("", "E_SQL_EMPTY", "空"),
    ("   ;  ", "E_SQL_EMPTY", "空"),
    ("-- 只有注释\n", "E_SQL_EMPTY", "空"),
])
def test_negative_cases_are_rejected(sql: str, code: str, needle: str) -> None:
    v = guard.check_sql(sql)
    assert v.ok is False, f"竟然放过了：{sql!r}"
    assert v.code == code
    assert needle.lower() in v.msg.lower(), v.msg


def test_long_sql_rejected() -> None:
    v = guard.check_sql("SELECT '" + "x" * 30_000 + "'")
    assert v.ok is False and v.code == "E_SQL_TOO_LONG"
    assert "30000" in v.msg or "过" in v.msg


# ═══════════════════════════════════════════════════════════════════════
# 正例：必须放行（**假阳性同样致命** —— 会把课程功能拦死）
# ═══════════════════════════════════════════════════════════════════════
@pytest.mark.parametrize("sql,kind", [
    ("SELECT * FROM students", "SELECT"),
    ("select sid, sname from students where age > 20", "SELECT"),
    ("INSERT INTO students(sid,sname) VALUES(9,'测试')", "INSERT"),
    ("UPDATE students SET age = age + 1 WHERE sid = 1", "UPDATE"),
    ("DELETE FROM students WHERE sid = 9", "DELETE"),
    ("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT NOT NULL)", "CREATE"),
    ("CREATE VIEW v AS SELECT sid FROM students", "CREATE"),
    ("CREATE INDEX idx_sname ON students(sname)", "CREATE"),
    ("CREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE t SET name='x'; END".replace(";", ""), "CREATE"),
    ("ALTER TABLE students ADD COLUMN email TEXT", "ALTER"),
    ("DROP TABLE IF EXISTS t", "DROP"),
    ("BEGIN", "BEGIN"),
    ("COMMIT", "COMMIT"),
    ("ROLLBACK", "ROLLBACK"),
    ("SAVEPOINT sp1", "SAVEPOINT"),
    ("EXPLAIN QUERY PLAN SELECT * FROM students", "EXPLAIN"),
    ("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<10) "
     "SELECT COUNT(*) FROM c", "WITH"),
    ("VALUES (1), (2)", "VALUES"),
    ("PRAGMA table_info(students)", "PRAGMA"),
    ("PRAGMA foreign_key_list('enrollments')", "PRAGMA"),
    ("PRAGMA integrity_check", "PRAGMA"),
    ("PRAGMA foreign_keys=ON", "PRAGMA"),          # 教学上要能练习开关（仍在白名单？见下）
])
def test_positive_cases_pass(sql: str, kind: str) -> None:
    v = guard.check_sql(sql)
    if sql.startswith("PRAGMA foreign_keys"):
        # foreign_keys 不在白名单（默认恒为 ON，避免学生关掉外键约束）
        assert v.ok is False and v.code == "E_SQL_PRAGMA"
        return
    assert v.ok is True, f"误拦了合法语句：{sql!r} → {v.code} {v.msg}"
    assert v.kind == kind


def test_strings_and_comments_do_not_trigger_false_positives() -> None:
    """字符串/注释里的危险词与分号**不能**误伤（假阳性会把功能拦死）。"""
    ok_cases = [
        "SELECT 'ATTACH' AS trick",
        "SELECT 'a;b' AS semi",
        "SELECT 1 /* ; DROP TABLE t */",
        "SELECT 1 -- ; DROP TABLE t",
        "SELECT 'load_extension' AS s",
        "INSERT INTO t(note) VALUES('请勿 ATTACH 别的库')",
    ]
    for sql in ok_cases:
        v = guard.check_sql(sql)
        assert v.ok is True, f"误拦：{sql!r} → {v.code} {v.msg}"


def test_verdict_statement_is_original_not_stripped() -> None:
    """★ 回归：执行用的必须是**原文**（剥离版会把字符串变成空格 → 语法错）。

    第一版 `verdict.statement` 用了剥离后的文本，
    于是 `WHERE dept='计算机'` 变成 `WHERE dept=` + 一串空格 →
    `near "ORDER": syntax error`（学生写对了 SQL 却报语法错，最难查的一类 bug）。
    """
    sql = "SELECT sid FROM students WHERE dept = '计算机' ORDER BY sid"
    v = guard.check_sql(sql)
    assert v.ok is True
    assert "'计算机'" in v.statement, "字符串字面量被剥掉了 → 执行必然失败"
    assert v.statement == sql.strip()
    # 末尾单个分号要去掉（sqlite3 的 execute 不接受）
    v2 = guard.check_sql("SELECT 1;")
    assert v2.statement == "SELECT 1"
    # 注释保留在原文里（SQLite 自己会忽略）
    v3 = guard.check_sql("SELECT 1 -- 注释")
    assert "注释" in v3.statement


# ═══════════════════════════════════════════════════════════════════════
# 批次（显式分隔 + 逐条校验）—— 事务实验必需
# ═══════════════════════════════════════════════════════════════════════
def test_split_statements_respects_strings_and_comments() -> None:
    assert guard.split_statements("SELECT 1") == ["SELECT 1"]
    # 末尾分号只产生空片段（``check_sql`` 会过滤掉）
    assert guard.split_statements("BEGIN; UPDATE t SET x=1; ROLLBACK;") == [
        "BEGIN", " UPDATE t SET x=1", " ROLLBACK"]
    # 字符串里的分号**不能**切开
    parts = guard.split_statements("INSERT INTO t VALUES('a;b'); SELECT 1")
    assert len(parts) == 2 and "'a;b'" in parts[0]
    # 注释里的分号同理
    parts2 = guard.split_statements("SELECT 1 /* ; */; SELECT 2")
    assert len(parts2) == 2


def test_multi_mode_validates_every_statement() -> None:
    ok = guard.check_sql("BEGIN; INSERT INTO t VALUES('a;b'); ROLLBACK;", allow_multi=True)
    assert ok.ok is True and ok.kind == "BEGIN;INSERT;ROLLBACK"
    # 藏在第二条里的危险语句同样被拦，并且**指出是第几句**
    bad = guard.check_sql("BEGIN; ATTACH 'x' AS y; ROLLBACK;", allow_multi=True)
    assert bad.ok is False and bad.code == "E_SQL_FORBIDDEN"
    assert "第 2 句" in bad.msg
    many = guard.check_sql(";".join(["SELECT 1"] * 60), allow_multi=True)
    assert many.ok is False and many.code == "E_SQL_TOO_MANY"


def test_default_mode_still_rejects_multi() -> None:
    v = guard.check_sql("BEGIN; UPDATE t SET x=1; ROLLBACK;")
    assert v.ok is False and v.code == "E_SQL_MULTI"


# ═══════════════════════════════════════════════════════════════════════
# 方言提示（诚实标注：SQLite ≠ MySQL）
# ═══════════════════════════════════════════════════════════════════════
def test_dialect_hints() -> None:
    hints = guard.dialect_hints("CREATE TABLE t(id INT AUTO_INCREMENT PRIMARY KEY)")
    assert any("AUTOINCREMENT" in h for h in hints)
    assert any("NOW()" in h for h in guard.dialect_hints("SELECT NOW()"))
    assert any("SHOW TABLES" in h for h in guard.dialect_hints("SHOW TABLES"))
    assert any("LIMIT" in h for h in guard.dialect_hints("SELECT * FROM t LIMIT 10, 5"))
    assert guard.dialect_hints("SELECT * FROM students") == []


def test_verdict_to_dict_shape() -> None:
    d = guard.check_sql("SELECT 1").to_dict()
    assert set(d) == {"ok", "code", "msg", "kind", "hints"}
    assert d["ok"] is True and d["kind"] == "SELECT"
