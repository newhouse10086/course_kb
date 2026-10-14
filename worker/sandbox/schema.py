# -*- coding: utf-8 -*-
"""库结构自省 —— 给 S4 答疑用的 ``{dialect, tables:[{name, columns:[...]}]}``。

``pi-bridge`` 明确要求这个形状（他要交给模型看"学生库现在有什么表/列"），
并声明**不自己读我的文件**，由我提供。字段名按他的接口写：

```ts
{ dialect: 'sqlite',
  tables: [ { name: 'students',
              columns: [ { name:'id', type:'INTEGER', pk?:true, notnull?:true,
                           fk?:'departments(id)' } ] } ] }
```
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any


def introspect(db_path: str | Path, *, dialect: str = "sqlite",
               row_counts: bool = True) -> dict[str, Any]:
    """读取表/列/主键/外键（可选带行数）。

    只用**只读**查询（``sqlite_master`` + ``PRAGMA table_info/foreign_key_list``），
    即使库被学生搞坏也不会改它。
    """
    path = Path(db_path)
    out: dict[str, Any] = {"dialect": dialect, "tables": []}
    if not path.exists():
        out["note"] = "库文件不存在（尚未初始化）"
        return out
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        names = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
            "ORDER BY name")]
        for name in names:
            fk_map: dict[str, str] = {}
            try:
                for row in conn.execute(f'PRAGMA foreign_key_list("{name}")'):
                    # row: (id, seq, table, from, to, on_update, on_delete, match)
                    fk_map[str(row[3])] = f"{row[2]}({row[4]})"
            except sqlite3.Error:
                pass
            columns: list[dict[str, Any]] = []
            try:
                for row in conn.execute(f'PRAGMA table_info("{name}")'):
                    # row: (cid, name, type, notnull, dflt_value, pk)
                    col: dict[str, Any] = {"name": str(row[1]), "type": str(row[2] or "")}
                    if row[5]:
                        col["pk"] = True
                    if row[3]:
                        col["notnull"] = True
                    if row[4] is not None:
                        col["default"] = str(row[4])
                    if str(row[1]) in fk_map:
                        col["fk"] = fk_map[str(row[1])]
                    columns.append(col)
            except sqlite3.Error as exc:
                columns.append({"name": "?", "type": f"<读取失败: {exc}>"})
            table: dict[str, Any] = {"name": name, "columns": columns}
            if row_counts:
                try:
                    table["rows"] = int(
                        conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0])
                except sqlite3.Error:
                    table["rows"] = None
            out["tables"].append(table)
    finally:
        conn.close()
    return out


def table_names(schema: dict[str, Any]) -> list[str]:
    return [t["name"] for t in schema.get("tables", [])]


def describe_text(schema: dict[str, Any], *, max_tables: int = 40) -> str:
    """把 schema 压成一段给提示词用的纯文本（**摘要**，避免上下文爆炸）。

    只在答疑上下文里用；表格多时截断并**如实说明截断了**。
    """
    lines: list[str] = [f"方言：{schema.get('dialect', 'unknown')}"]
    tables = schema.get("tables", [])[:max_tables]
    for t in tables:
        cols = ", ".join(
            f"{c['name']} {c['type']}".strip() +
            (" PK" if c.get("pk") else "") +
            (f" → {c['fk']}" if c.get("fk") else "")
            for c in t.get("columns", [])
        )
        rows = t.get("rows")
        suffix = f"（{rows} 行）" if rows is not None else ""
        lines.append(f"- {t['name']}{suffix}: {cols}")
    total = len(schema.get("tables", []))
    if total > len(tables):
        lines.append(f"（还有 {total - len(tables)} 张表未列出 —— 已截断）")
    if not tables:
        lines.append("（当前库没有表）")
    return "\n".join(lines)
