# -*- coding: utf-8 -*-
"""查证：用的什么数据库 + 有没有用户/角色/权限表。"""
import io
import sqlite3
import sys

DB = r"D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\course-kb\data\course_kb.sqlite3"
p = print

c = sqlite3.connect(DB)
p("=== 数据库引擎 ===")
p("  sqlite3 模块版本 :", sqlite3.sqlite_version)
p("  文件             : course_kb.sqlite3")
p("  驱动（Node 侧）   : better-sqlite3 ^12.2.0")
p("")
p("=== 引擎设置 ===")
for k in ("journal_mode", "foreign_keys", "user_version"):
    try:
        p(f"  {k:16} = {c.execute('PRAGMA %s' % k).fetchone()[0]}")
    except Exception as e:
        p(f"  {k:16} ! {e}")

p("")
p("=== 全部表 / 视图 ===")
rows = c.execute(
    "SELECT type, name FROM sqlite_master "
    "WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' "
    "ORDER BY type, name"
).fetchall()
for t, n in rows:
    cnt = ""
    if t == "table":
        try:
            cnt = f"  {c.execute('SELECT count(*) FROM \"%s\"' % n).fetchone()[0]:>6} 行"
        except Exception as e:
            cnt = f"  ({e})"
    p(f"  {t:6} {n:24}{cnt}")

p("")
p("=== ★ 用户 / 角色 / 权限相关表 ===")
kw = ("user", "role", "perm", "account", "member", "auth", "login", "tenant", "acl")
found = [n for _, n in rows if any(k in n.lower() for k in kw)]
p("  " + (str(found) if found else "**没有 —— 一个都没有**"))

p("")
p("=== 表级：有无 user/owner/role 列 ===")
hits = []
for t, n in rows:
    if t != "table":
        continue
    try:
        cols = [r[1] for r in c.execute('PRAGMA table_info("%s")' % n)]
    except Exception:
        continue
    m = [col for col in cols if any(k in col.lower() for k in kw)]
    if m:
        hits.append((n, m))
p("  " + (str(hits) if hits else "**没有任何一张表带 owner/role/user 列**"))

p("")
p("=== 认证/会话相关：后端有没有鉴权中间件 ===")
p("  契约 docs/API_PROTOCOL.md：无「认证」章节，无 token/登录接口")
p("  服务绑定：127.0.0.1（本机单用户）")
