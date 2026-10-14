# -*- coding: utf-8 -*-
"""扫描全部 Python 文件的语法错误（找 teammate 中途结束留下的半截代码）。"""
import ast
import io
import os
import sys

KB = r"D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\course-kb"
bad = []
total = 0

for root, dirs, files in os.walk(KB):
    dirs[:] = [d for d in dirs if d not in
               {"__pycache__", ".pytest_cache", "node_modules", ".git", "data"}]
    for fn in files:
        if not fn.endswith(".py"):
            continue
        fp = os.path.join(root, fn)
        rel = os.path.relpath(fp, KB)
        total += 1
        try:
            src = io.open(fp, encoding="utf-8", errors="replace").read()
            ast.parse(src, filename=fp)
        except SyntaxError as e:
            bad.append((rel, e.lineno, str(e.msg)))
        except Exception as e:
            bad.append((rel, 0, f"{type(e).__name__}: {e}"))

print(f"扫描 {total} 个 .py 文件")
print()
if bad:
    print(f"❌ 发现 {len(bad)} 个语法错误：")
    for rel, ln, msg in bad:
        print(f"  {rel}:{ln}  {msg}")
else:
    print("✅ 全部语法正确")

# 额外：检查有没有明显的"编辑中途"痕迹
print()
print("可疑标记扫描（TODO/未完成的占位）：")
marks = []
for root, dirs, files in os.walk(KB):
    dirs[:] = [d for d in dirs if d not in
               {"__pycache__", ".pytest_cache", "node_modules", ".git", "data"}]
    for fn in files:
        if not fn.endswith(".py"):
            continue
        fp = os.path.join(root, fn)
        rel = os.path.relpath(fp, KB)
        try:
            for i, ln in enumerate(io.open(fp, encoding="utf-8", errors="replace"), 1):
                if "…" in ln or "<<<<<<<" in ln or ">>>>>>>" in ln:
                    marks.append((rel, i, ln.strip()[:70]))
        except Exception:
            pass
for rel, i, txt in marks[:20]:
    print(f"  {rel}:{i}  {txt}")
if not marks:
    print("  （无）")
sys.exit(1 if bad else 0)
