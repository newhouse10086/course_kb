# -*- coding: utf-8 -*-
"""课程预置数据集 —— 每个都带 **CREATE + INSERT**，可一键 ``reset`` 回初始态。

规格：``docs/LAB_DB_DEPLOY.md`` §6「每个数据集带 reset：一键回到初始 schema」。

三个数据集对应数据库课程的三个教学阶段：

| id | 表 | 教学点 |
|---|---|---|
| ``sc`` | students / courses / enrollments | 学生-课程-成绩（课程经典样例）：三表 JOIN、聚合、`NULL` 成绩（`IS NULL`/`LEFT JOIN`） |
| ``employees`` | departments / employees（自引用 ``mgr_id``） | **自连接**与**递归 CTE**（找上下级、层级深度、组织树） |
| ``orders`` | customers / products / orders / order_items | 聚合、`GROUP BY … HAVING`、**窗口函数**（按月累计、排名） |

设计细节（都是有意留给学生踩的）：
* ``enrollments.grade`` 有 **NULL**（"还没出成绩"）→ 练 `IS NULL`、`COUNT(*)` vs `COUNT(grade)`、
  `AVG` 忽略 NULL 的语义
* ``employees.mgr_id`` 造出**三层**层级（老总→经理→员工）→ 递归 CTE 有真实结果
* ``orders`` 跨 3 个月、含 ``cancelled`` 状态 → 练"统计时该不该过滤状态"
* 表间**真外键**（并开启 ``PRAGMA foreign_keys=ON``，与 MySQL 行为对齐；
  注意 SQLite 默认是 OFF —— 这是方言差异，见 ``guard.DIALECT_HINTS``）
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: 默认数据集（学生首次进沙箱看到的就是它）
DEFAULT_DATASET = "sc"


@dataclass(frozen=True)
class Dataset:
    id: str
    label: str
    description: str
    sql: str
    teaching_points: tuple[str, ...] = ()
    dialect_notes: tuple[str, ...] = ()
    tables: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self, *, with_sql: bool = False) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "tables": list(self.tables),
            "teachingPoints": list(self.teaching_points),
            "dialectNotes": list(self.dialect_notes),
        }
        if with_sql:
            out["sql"] = self.sql
        return out


# ═══════════════════════════════════════════════════════════════════════
# sc —— 学生-课程-成绩
# ═══════════════════════════════════════════════════════════════════════
_SC_SQL = """
DROP TABLE IF EXISTS enrollments;
DROP TABLE IF EXISTS courses;
DROP TABLE IF EXISTS students;

CREATE TABLE students (
  sid    INTEGER PRIMARY KEY,
  sname  TEXT NOT NULL,
  age    INTEGER,
  sex    TEXT CHECK (sex IN ('M','F')),
  dept   TEXT
);

CREATE TABLE courses (
  cid     INTEGER PRIMARY KEY,
  cname   TEXT NOT NULL,
  teacher TEXT,
  credits INTEGER NOT NULL DEFAULT 3
);

-- 成绩表：主键 (sid,cid)；grade 允许 NULL（还没出成绩）
CREATE TABLE enrollments (
  sid   INTEGER NOT NULL REFERENCES students(sid),
  cid   INTEGER NOT NULL REFERENCES courses(cid),
  grade REAL,
  term  TEXT,
  PRIMARY KEY (sid, cid)
);

INSERT INTO students (sid, sname, age, sex, dept) VALUES
  (1, '张三', 20, 'M', '计算机'),
  (2, '李四', 21, 'M', '计算机'),
  (3, '王五', 19, 'F', '软件工程'),
  (4, '赵六', 22, 'M', '软件工程'),
  (5, '孙七', 20, 'F', '数据科学'),
  (6, '周八', 23, 'F', '数据科学');

INSERT INTO courses (cid, cname, teacher, credits) VALUES
  (1, '数据库系统原理', '陈老师', 4),
  (2, '数据结构',       '林老师', 4),
  (3, '操作系统',       '黄老师', 3),
  (4, '计算机网络',     '吴老师', 3),
  (5, '数据库实验',     '陈老师', 1);

-- 有意留两条 NULL 成绩（李四的数据结构、周八的数据库实验还没出分）
INSERT INTO enrollments (sid, cid, grade, term) VALUES
  (1, 1, 92.5, '2026春'), (1, 2, 88.0, '2026春'), (1, 5, 95.0, '2026春'),
  (2, 1, 76.0, '2026春'), (2, 2, NULL, '2026春'),
  (3, 1, 84.5, '2026春'), (3, 3, 90.0, '2026春'), (3, 5, 88.0, '2026春'),
  (4, 1, 59.5, '2026春'), (4, 4, 72.0, '2026春'),
  (5, 2, 81.0, '2026春'), (5, 3, 78.5, '2026春'), (5, 4, 85.0, '2026春'),
  (6, 1, 95.5, '2026春'), (6, 5, NULL, '2026春');
"""

# ═══════════════════════════════════════════════════════════════════════
# employees —— 自连接 / 递归 CTE
# ═══════════════════════════════════════════════════════════════════════
_EMP_SQL = """
DROP TABLE IF EXISTS employees;
DROP TABLE IF EXISTS departments;

CREATE TABLE departments (
  dept_id   INTEGER PRIMARY KEY,
  dept_name TEXT NOT NULL
);

-- 自引用：mgr_id 指向 employees.emp_id（三层：老总 → 经理 → 员工）
CREATE TABLE employees (
  emp_id   INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  mgr_id   INTEGER REFERENCES employees(emp_id),
  dept_id  INTEGER REFERENCES departments(dept_id),
  salary   REAL NOT NULL,
  hired_on TEXT NOT NULL
);

INSERT INTO departments (dept_id, dept_name) VALUES
  (10, '研发部'), (20, '教学部'), (30, '行政部');

INSERT INTO employees (emp_id, name, mgr_id, dept_id, salary, hired_on) VALUES
  (1, '总经理-方',  NULL, 30, 42000.0, '2015-03-01'),
  (2, '研发经理-林', 1,   10, 30000.0, '2017-06-15'),
  (3, '教学经理-陈', 1,   20, 28000.0, '2018-09-01'),
  (4, '工程师-张',   2,   10, 21000.0, '2020-07-01'),
  (5, '工程师-李',   2,   10, 19500.0, '2021-03-15'),
  (6, '工程师-王',   2,   10, 18000.0, '2022-09-01'),
  (7, '讲师-赵',     3,   20, 17000.0, '2021-02-01'),
  (8, '助教-孙',     3,   20, 12000.0, '2023-07-01'),
  (9, '行政-周',     1,   30, 11000.0, '2023-01-10'),
  (10,'实习生-吴',   4,   10,  6000.0, '2026-01-05');
"""

# ═══════════════════════════════════════════════════════════════════════
# orders —— 聚合 / 窗口函数
# ═══════════════════════════════════════════════════════════════════════
_ORD_SQL = """
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS customers;

CREATE TABLE customers (
  customer_id INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  city        TEXT
);

CREATE TABLE products (
  product_id INTEGER PRIMARY KEY,
  pname      TEXT NOT NULL,
  price      REAL NOT NULL
);

CREATE TABLE orders (
  order_id    INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  order_date  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'paid',
  CHECK (status IN ('paid','shipped','cancelled'))
);

CREATE TABLE order_items (
  order_id   INTEGER NOT NULL REFERENCES orders(order_id),
  product_id INTEGER NOT NULL REFERENCES products(product_id),
  qty        INTEGER NOT NULL CHECK (qty > 0),
  unit_price REAL NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

INSERT INTO customers (customer_id, name, city) VALUES
  (1, '清华大学',     '北京'),
  (2, '浙江大学',     '杭州'),
  (3, '华中科技大学', '武汉'),
  (4, '电子科技大学', '成都'),
  (5, '西安交通大学', '西安');

INSERT INTO products (product_id, pname, price) VALUES
  (1, '数据库实验指导书', 45.0),
  (2, '在线课程年卡',    999.0),
  (3, '实验环境授权',     300.0),
  (4, 'SQL 练习题库',     88.0),
  (5, '教师培训服务',    2000.0),
  (6, '技术支持月包',     150.0);

-- 跨 3 个月、含 cancelled（教学点：统计时该不该过滤状态）
INSERT INTO orders (order_id, customer_id, order_date, status) VALUES
  (1001, 1, '2026-03-05', 'paid'),
  (1002, 1, '2026-04-11', 'shipped'),
  (1003, 2, '2026-03-18', 'paid'),
  (1004, 2, '2026-05-02', 'cancelled'),
  (1005, 3, '2026-03-27', 'paid'),
  (1006, 3, '2026-04-30', 'shipped'),
  (1007, 4, '2026-04-06', 'paid'),
  (1008, 4, '2026-05-15', 'paid'),
  (1009, 5, '2026-03-09', 'paid'),
  (1010, 5, '2026-05-21', 'shipped'),
  (1011, 2, '2026-05-28', 'paid'),
  (1012, 1, '2026-05-30', 'paid');

INSERT INTO order_items (order_id, product_id, qty, unit_price) VALUES
  (1001, 1, 40, 45.0),  (1001, 4, 20, 88.0),
  (1002, 2,  2, 999.0), (1002, 3,  1, 300.0),
  (1003, 1, 60, 45.0),  (1003, 3,  2, 300.0),
  (1004, 5,  1, 2000.0),
  (1005, 1, 25, 45.0),  (1005, 4, 30, 88.0),
  (1006, 2,  1, 999.0), (1006, 6,  6, 150.0),
  (1007, 3,  4, 300.0), (1007, 1, 15, 45.0),
  (1008, 5,  1, 2000.0),
  (1009, 1, 50, 45.0),  (1009, 4, 10, 88.0),
  (1010, 2,  3, 999.0), (1010, 6, 12, 150.0),
  (1011, 1, 80, 45.0),  (1011, 3,  3, 300.0),
  (1012, 4, 100, 88.0), (1012, 6, 24, 150.0);
"""


DATASETS: dict[str, Dataset] = {
    "sc": Dataset(
        id="sc",
        label="学生-课程-成绩（课程经典样例）",
        description="students / courses / enrollments 三表：JOIN、聚合、NULL 成绩、外键约束",
        sql=_SC_SQL,
        teaching_points=(
            "三表 JOIN（学生选了什么课、拿了多少分）",
            "AVG/COUNT 忽略 NULL：COUNT(*) 与 COUNT(grade) 的差别",
            "LEFT JOIN 找出「没选课的学生」或「没出成绩的记录」（IS NULL）",
            "CHECK 约束与主键冲突（(sid,cid) 复合主键）",
            "GROUP BY … HAVING 找平均分低于某线的课程",
        ),
        tables=("students", "courses", "enrollments"),
    ),
    "employees": Dataset(
        id="employees",
        label="员工层级（自连接 / 递归）",
        description="employees.mgr_id 自引用 + departments：自连接、递归 CTE、组织树",
        sql=_EMP_SQL,
        teaching_points=(
            "自连接：把员工和他的经理放在同一行（e JOIN employees m ON e.mgr_id=m.emp_id）",
            "递归 CTE：WITH RECURSIVE 展开三层组织树、算层级深度",
            "推荐写法：递归必须有终止条件，否则会跑到超时被沙箱硬杀",
            "聚合：按部门算平均工资、按经理算下属人数",
        ),
        tables=("departments", "employees"),
    ),
    "orders": Dataset(
        id="orders",
        label="订单明细（聚合 / 窗口函数）",
        description="customers/products/orders/order_items：聚合、HAVING、窗口函数、月度趋势",
        sql=_ORD_SQL,
        teaching_points=(
            "多表聚合：订单金额 = Σ(qty × unit_price)",
            "窗口函数：RANK() / SUM() OVER (PARTITION BY … ORDER BY …) 做月度累计与排名",
            "业务过滤：统计时是否排除 status='cancelled'（两种答案都要能解释）",
            "EXISTS / IN / JOIN 三种写法的等价改写与执行计划差异（EXPLAIN QUERY PLAN）",
        ),
        tables=("customers", "products", "orders", "order_items"),
    ),
}


def list_datasets(*, with_sql: bool = False) -> list[dict[str, Any]]:
    return [DATASETS[k].to_dict(with_sql=with_sql) for k in sorted(DATASETS)]


def get_dataset(name: str | None) -> Dataset:
    key = (name or DEFAULT_DATASET).lower()
    if key not in DATASETS:
        raise KeyError(f"未知数据集 {name!r}；可用：{', '.join(sorted(DATASETS))}")
    return DATASETS[key]


def script(name: str | None) -> str:
    return get_dataset(name).sql


def load_dataset(db_path: str | Path, name: str | None = None) -> dict[str, Any]:
    """把数据集**重建**到 ``db_path``（幂等 + **真 reset**）。

    这是 ``reset`` 的实现：无论学生把库搞成什么样，跑完就回到初始态。
    ★ 会先 **DROP 掉库里所有用户表**（含学生自己建的表与脏数据），
      而不是只 DROP 数据集自带的那几张 —— 否则学生建的 ``junk`` 表会一直留到下次实验
      （"reset 到初始 schema"就名不副实）。
      DROP 期间临时关外键（否则删父表会被 FK 拦住）。
    """
    ds = get_dataset(name)
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
        existing = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        for table in existing:
            conn.execute(f'DROP TABLE IF EXISTS "{table}"')
        conn.execute("PRAGMA foreign_keys=ON")
        conn.executescript(ds.sql)
        conn.commit()
        counts = {
            t: int(conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0])
            for t in ds.tables
        }
        remaining = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
            "ORDER BY name")]
    finally:
        conn.close()
    return {
        "dataset": ds.id,
        "label": ds.label,
        "db_path": str(path),
        "tables": counts,
        "dropped": [t for t in existing if t not in ds.tables],   # 如实回报清掉了什么
        "remainingTables": remaining,
        "dbBytes": path.stat().st_size,
    }
