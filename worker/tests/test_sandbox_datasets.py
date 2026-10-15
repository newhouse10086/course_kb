# -*- coding: utf-8 -*-
"""数据集测试：**行数断言具体值** + reset 真回初始态 + 教学点真的存在。"""

from __future__ import annotations

from pathlib import Path

import pytest

from worker.sandbox import datasets as ds_mod
from worker.sandbox import exec as exec_mod
from worker.sandbox.schema import describe_text, introspect


def ex(db: Path, sql: str, user: str = "u_ds"):
    return exec_mod.execute(db_path=db, sql=sql, user_id=user, session_id="s1",
                            root=str(db.parent.parent))


def test_list_datasets_shape() -> None:
    items = ds_mod.list_datasets()
    assert [d["id"] for d in items] == ["employees", "orders", "sc"]
    ids = {d["id"]: d for d in items}
    assert ids["sc"]["tables"] == ["students", "courses", "enrollments"]
    assert ids["employees"]["tables"] == ["departments", "employees"]
    assert ids["orders"]["tables"] == ["customers", "products", "orders", "order_items"]
    assert len(ids["sc"]["teachingPoints"]) == 5
    # 默认数据集 = sc（课程经典样例）
    assert ds_mod.DEFAULT_DATASET == "sc"
    # with_sql 才带建表脚本
    assert "sql" not in items[0]
    with_sql = ds_mod.list_datasets(with_sql=True)
    assert all(x["sql"].startswith("\nDROP TABLE") or "CREATE TABLE" in x["sql"] for x in with_sql)


@pytest.mark.parametrize("name,expected", [
    ("sc", {"students": 6, "courses": 5, "enrollments": 15}),
    ("employees", {"departments": 3, "employees": 10}),
    ("orders", {"customers": 5, "products": 6, "orders": 12, "order_items": 22}),
])
def test_load_dataset_row_counts(tmp_path: Path, name: str, expected: dict) -> None:
    db = tmp_path / name / "s1.sqlite3"
    info = ds_mod.load_dataset(db, name)
    assert info["tables"] == expected
    assert info["dbBytes"] > 0
    for table, rows in expected.items():
        got = ex(db, f"SELECT COUNT(*) FROM {table}")["rows"][0][0]
        assert got == rows, f"{name}.{table}"


def test_sc_has_null_grade_and_fk(tmp_path: Path) -> None:
    """教学点必须真的存在于数据里（不是文档里写了、数据里没有）。"""
    db = tmp_path / "sc" / "s1.sqlite3"
    ds_mod.load_dataset(db, "sc")
    # NULL 成绩（练 IS NULL / LEFT JOIN）
    r = ex(db, "SELECT s.sname, e.cid FROM students s JOIN enrollments e ON s.sid=e.sid "
               "WHERE e.grade IS NULL ORDER BY s.sid")
    assert r["rows"] == [["李四", 2], ["周八", 5]]
    # COUNT(*) vs COUNT(grade) 差异 = 2
    r = ex(db, "SELECT COUNT(*) AS all_rows, COUNT(grade) AS graded FROM enrollments")
    assert r["rows"] == [[15, 13]]
    # 外键真约束（插入不存在的 sid → 失败）
    r = ex(db, "INSERT INTO enrollments(sid, cid, grade, term) VALUES(999, 1, 90, 'x')")
    assert r["ok"] is False and "FOREIGN KEY constraint failed" in r["error"]["message"]


def test_employees_hierarchy_is_three_levels(tmp_path: Path) -> None:
    """自连接/递归 CTE 的教学点：真有三层组织树。"""
    db = tmp_path / "emp" / "s1.sqlite3"
    ds_mod.load_dataset(db, "employees")
    r = ex(db, "SELECT COUNT(*) FROM employees WHERE mgr_id IS NULL")
    assert r["rows"] == [[1]]                       # 只有一个根（总经理）
    # 自连接：直接下属数（总经理与研发经理各 3 人；讲师-赵 没有下属，内连接不会出现）
    r = ex(db, "SELECT m.name, COUNT(e.emp_id) AS reports FROM employees m "
               "JOIN employees e ON e.mgr_id = m.emp_id GROUP BY m.emp_id "
               "ORDER BY reports DESC, m.emp_id")
    assert r["rows"] == [["总经理-方", 3], ["研发经理-林", 3], ["教学经理-陈", 2],
                         ["工程师-张", 1]]
    # 用 LEFT JOIN 才能看到"没有下属的人"（教学点：INNER vs LEFT 的差别）
    r = ex(db, "SELECT e.name FROM employees e LEFT JOIN employees m "
               "ON m.mgr_id = e.emp_id WHERE m.emp_id IS NULL ORDER BY e.emp_id")
    assert [row[0] for row in r["rows"]] == [
        "工程师-李", "工程师-王", "讲师-赵", "助教-孙", "行政-周", "实习生-吴"]
    # 递归 CTE：算层级深度（真跑，验证数据的层级）
    r = ex(db, "WITH RECURSIVE tree(emp_id, name, depth) AS ("
               "  SELECT emp_id, name, 1 FROM employees WHERE mgr_id IS NULL"
               "  UNION ALL"
               "  SELECT e.emp_id, e.name, t.depth + 1 FROM employees e "
               "  JOIN tree t ON e.mgr_id = t.emp_id) "
               "SELECT MAX(depth) AS max_depth, COUNT(*) AS n FROM tree")
    assert r["rows"] == [[4, 10]]    # 四层：总经理→研发经理→工程师-张→实习生-吴；共 10 人


def test_orders_aggregate_and_window(tmp_path: Path) -> None:
    db = tmp_path / "ord" / "s1.sqlite3"
    ds_mod.load_dataset(db, "orders")
    # 订单金额 = Σ(qty × unit_price)
    r = ex(db, "SELECT o.order_id, SUM(i.qty * i.unit_price) AS amount FROM orders o "
               "JOIN order_items i ON i.order_id = o.order_id "
               "WHERE o.status <> 'cancelled' GROUP BY o.order_id ORDER BY amount DESC LIMIT 1")
    assert r["rows"][0][0] == 1012 and r["rows"][0][1] == pytest.approx(12400.0)
    # 窗口函数（SQLite 3.25+ 支持）：按月累计
    r = ex(db, "SELECT order_date, SUM(SUM(i.qty*i.unit_price)) OVER (ORDER BY order_date "
               "ROWS UNBOUNDED PRECEDING) AS running FROM orders o "
               "JOIN order_items i ON i.order_id = o.order_id "
               "WHERE o.status <> 'cancelled' GROUP BY o.order_date ORDER BY order_date "
               "LIMIT 1")
    assert r["rows"][0][0] == "2026-03-05"
    assert r["rows"][0][1] == pytest.approx(3560.0)
    # cancelled 订单确实存在（教学点：统计该不该过滤）
    r = ex(db, "SELECT COUNT(*) FROM orders WHERE status='cancelled'")
    assert r["rows"] == [[1]]


def test_reset_returns_to_initial_state(tmp_path: Path) -> None:
    """★ reset 必须能把被搞坏的库**完整**恢复（学生一键回到初始态）。"""
    db = tmp_path / "sc" / "s1.sqlite3"
    ds_mod.load_dataset(db, "sc")
    # 学生搞坏：删表 + 插脏数据 + 建怪表
    assert ex(db, "DROP TABLE enrollments")["ok"] is True
    assert ex(db, "INSERT INTO students(sid, sname) VALUES(77,'脏数据')")["ok"] is True
    assert ex(db, "CREATE TABLE junk(x)")["ok"] is True

    info = ds_mod.load_dataset(db, "sc")
    assert info["tables"] == {"students": 6, "courses": 5, "enrollments": 15}
    tables = [r[0] for r in ex(db, "SELECT name FROM sqlite_master WHERE type='table' "
                                  "ORDER BY name")["rows"]]
    assert tables == ["courses", "enrollments", "students"]       # junk 没了
    assert ex(db, "SELECT COUNT(*) FROM students")["rows"] == [[6]]
    assert ex(db, "SELECT COUNT(*) FROM enrollments WHERE grade IS NULL")["rows"] == [[2]]


def test_unknown_dataset_raises() -> None:
    with pytest.raises(KeyError):
        ds_mod.get_dataset("不存在的数据集")
    with pytest.raises(KeyError):
        ds_mod.load_dataset("x.sqlite3", "nope")


def test_schema_introspection_shape(tmp_path: Path) -> None:
    """S4 要的形状：``{dialect, tables:[{name, columns:[{name,type,pk,notnull,fk}]}]}``。"""
    db = tmp_path / "sc" / "s1.sqlite3"
    ds_mod.load_dataset(db, "sc")
    schema = introspect(db, dialect="sqlite")
    assert schema["dialect"] == "sqlite"
    by_name = {t["name"]: t for t in schema["tables"]}
    assert set(by_name) == {"students", "courses", "enrollments"}
    students = by_name["students"]
    assert students["rows"] == 6
    cols = {c["name"]: c for c in students["columns"]}
    assert cols["sid"]["type"] == "INTEGER" and cols["sid"]["pk"] is True
    assert cols["sname"]["notnull"] is True
    # 外键真被识别（enrollments.sid → students(sid)）
    enr = {c["name"]: c for c in by_name["enrollments"]["columns"]}
    assert enr["sid"]["fk"] == "students(sid)"
    assert enr["cid"]["fk"] == "courses(cid)"
    # 给提示词用的摘要
    text = describe_text(schema)
    assert "方言：sqlite" in text and "students（6 行）" in text and "sid INTEGER PK" in text


def test_introspect_missing_file_is_honest(tmp_path: Path) -> None:
    out = introspect(tmp_path / "nope.sqlite3")
    assert out["tables"] == [] and "不存在" in out.get("note", "")
