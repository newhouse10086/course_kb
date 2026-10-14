# -*- coding: utf-8 -*-
"""SQLite 报错解读 + 脱敏 —— **原文一字不改**，另附本地确定性解读。

为什么两块都要（``pi-bridge``/S4 的硬要求）：

1. **原文必须原样保留**：学生最常卡在"看不懂报错"，答疑的核心价值就是看见它。
   我们**不做任何翻译/截断/只留 code** —— ``message`` 字段就是 ``sqlite3`` 的原始文本
   （``near "FROM": syntax error`` / ``no such table: student`` /
   ``UNIQUE constraint failed: students.id``）。
2. **另附**本地确定性解读（``hint``）：常见报错 → 中文含义 + 该去看什么。
   这是**系统侧的真实推断**（不是编答案），模型不可用时也能给出诚实降级。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

#: 常见 SQLite 报错的确定性解读（正则, 中文含义, 建议动作）
PATTERNS: tuple[tuple[re.Pattern[str], str, str], ...] = (
    (re.compile(r'near "([^"]+)": syntax error', re.I),
     "语法错误：在 {0} 附近解析失败",
     "检查关键字拼写、逗号/括号是否配对；SQLite 对子句顺序要求严格"
     "（SELECT … FROM … WHERE … GROUP BY … HAVING … ORDER BY … LIMIT）"),
    (re.compile(r"no such table: (\S+)", re.I),
     "表 {0} 不存在",
     "先确认表名拼写与大小写；用 SELECT name FROM sqlite_master WHERE type='table' 看现有表"),
    (re.compile(r"no such column: (\S+)", re.I),
     "列 {0} 不存在",
     "用 PRAGMA table_info(表名) 看真实列名；注意别把别名用在了 WHERE 里"),
    (re.compile(r"no such function: (\S+)", re.I),
     "函数 {0} 不存在（SQLite 内置函数比 MySQL 少）",
     "换用 SQLite 等价函数（NOW()→datetime('now')、DATE_FORMAT→strftime）；"
     "窗口函数需 SQLite 3.25+"),
    (re.compile(r"UNIQUE constraint failed: (.+)", re.I),
     "唯一约束冲突：{0}",
     "该键已存在；改用 INSERT OR IGNORE / INSERT OR REPLACE，或换主键值"),
    (re.compile(r"NOT NULL constraint failed: (.+)", re.I),
     "非空约束冲突：{0} 不能为 NULL",
     "INSERT 时给该列提供值，或给列加 DEFAULT"),
    (re.compile(r"CHECK constraint failed: (.+)", re.I),
     "CHECK 约束不满足：{0}",
     "检查数据是否满足建表时写的检查条件"),
    (re.compile(r"FOREIGN KEY constraint failed", re.I),
     "外键约束失败：被引用的行不存在，或被引用行仍被引用",
     "先插父表再插子表；删父表行前先处理子表行；或 PRAGMA foreign_keys 的开关差异"),
    (re.compile(r"table (\S+) already exists", re.I),
     "表 {0} 已存在",
     "改列名/换表名，或先 DROP TABLE IF EXISTS（实验里这很常见）"),
    (re.compile(r"table (\S+) has (\d+) columns but (\d+) values were supplied", re.I),
     "INSERT 的列数与值个数不一致",
     "INSERT INTO t(a,b) VALUES(1,2) 里显式列出列名，避免顺序/个数错位"),
    (re.compile(r"incomplete input", re.I),
     "SQL 不完整（少了右括号/引号/END）",
     "检查引号与括号是否闭合；CTE 的 WITH 是否写了完整 SELECT"),
    (re.compile(r"interrupted", re.I),
     "执行被中断（通常是超时）",
     "给学生看的提示：递归 CTE 需要终止条件（WHERE 里的递归约束），先加 LIMIT 试小范围"),
    (re.compile(r"ambiguous column name: (\S+)", re.I),
     "列名 {0} 有歧义（多表同名列未加表前缀）",
     "用 表名.列名 或表别名限定（JOIN 语句常见）"),
    (re.compile(r"misuse of aggregate|aggregate functions are not allowed", re.I),
     "聚合函数位置错误",
     "聚合不能直接放 WHERE（要用 HAVING）；也别把聚合与普通列混在 SELECT 里"),
    (re.compile(r"datatype mismatch", re.I),
     "数据类型不匹配",
     "SQLite 是动态类型，但声明为 INTEGER PRIMARY KEY 的列必须是整数"),
    (re.compile(r"not authorized", re.I),
     "被安全闸拒绝（SQLite 授权层）",
     "该语句涉及沙箱禁止的能力（ATTACH / load_extension / 白名单外 PRAGMA 等）"),
    (re.compile(r"attempt to write a readonly database", re.I),
     "试图写只读库",
     "确认库文件权限；沙箱库应为可写（每个学生独立文件）"),
    (re.compile(r"database is locked", re.I),
     "库被锁住（另一条语句还没结束）",
     "等上一条执行完再试；长事务要尽快 COMMIT/ROLLBACK"),
)


@dataclass
class Interpreted:
    raw: str                # ★ 原文（一字不改）
    message: str            # 中文含义（带具体对象名）
    hint: str               # 建议动作
    matched: bool           # 是否命中已知模式（False = 诚实说"没有本地解读"）

    def to_dict(self) -> dict:
        return {"message": self.message, "hint": self.hint, "matched": self.matched}


def interpret_error(raw: str) -> Interpreted:
    """把 SQLite 原始报错映射成中文含义 + 建议（**不改动原文**）。"""
    text = raw or ""
    for pattern, meaning, hint in PATTERNS:
        m = pattern.search(text)
        if m:
            try:
                message = meaning.format(*m.groups())
            except (IndexError, KeyError):
                message = meaning
            return Interpreted(raw=text, message=message, hint=hint, matched=True)
    return Interpreted(
        raw=text,
        message=text.splitlines()[0] if text else "（无报错文本）",
        hint="本地没有这条报错的确定性解读；建议结合上一条 SQL 与表结构排查",
        matched=False,
    )


# ═══════════════════════════════════════════════════════════════════════
# 脱敏（日志比数据更敏感 —— LAB_DB_DEPLOY §8.5）
# ═══════════════════════════════════════════════════════════════════════
_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?i)(password|passwd|pwd)\s*[=:]\s*(\S+)"), r"\1=***"),
    (re.compile(r"(?i)(lab_pg|lab_mysql|lab_opengauss)_password\s*=\s*(\S+)"),
     r"\1_password=***"),
    (re.compile(r"(?i)(postgres(?:ql)?|mysql|opengauss)://([^:@\s/]+):([^@\s/]+)@"),
     r"\1://\2:***@"),
    (re.compile(r"(?i)\b(api[_-]?key|secret|token)\s*[=:]\s*([A-Za-z0-9_\-\.]{8,})"),
     r"\1=***"),
    (re.compile(r"(?i)\bhttps?://[^/\s:]+:[^@\s/]+@"), "https://***@"),
)


def redact(text: str) -> str:
    """把连接串/密码/token 打码（日志里出现的任何一处都要打）。"""
    out = text or ""
    for pattern, repl in _PATTERNS:
        out = pattern.sub(repl, out)
    return out
