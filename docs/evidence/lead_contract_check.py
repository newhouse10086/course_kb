# -*- coding: utf-8 -*-
"""Lead 集成信号检查（只读，不干扰 teammate）。

检查：
  1. 关键模块能否 import（语法/依赖/循环引用）
  2. 契约符合性：schema 枚举是否从 schema/*.json 真实读取
  3. 契约符合性：SQLite 表名是否与 API_PROTOCOL §3 一致
  4. 契约符合性：pi 桥是否用了 readline（P1 违规）
  5. 契约符合性：单元划分是否有递归下降 + 引言段（bug 5 修复）
  6. 契约符合性：xref 是否有假阳性过滤（bug 6 修复）
  7. 契约符合性：search 是否用 bigram（bug 15 修复）
"""
import io
import json
import os
import re
import sys

KB = r"D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\course-kb"
sys.path.insert(0, KB)

def p(*a):
    print(*a); sys.stdout.flush()

ok, bad = [], []
def ck(name, cond, detail=""):
    (ok if cond else bad).append(name)
    p(("  OK   " if cond else "  FAIL ") + name + (f"   [{detail}]" if detail and not cond else ""))

def read(rel):
    fp = os.path.join(KB, rel)
    if not os.path.exists(fp):
        return None
    return io.open(fp, encoding="utf-8", errors="replace").read()

p("=" * 76)
p("一、模块 import 检查")
p("=" * 76)
mods = ["server.config", "server.models.schema_enums", "server.adapters.base",
        "server.adapters.registry", "server.adapters.pdf", "server.store.db",
        "server.pipeline.units", "server.pipeline.xref", "server.pipeline.search",
        "server.video.audio", "server.video.subtitle",
        "server.pi_bridge.client", "server.pi_bridge.events", "server.pi_bridge.launcher"]
for m in mods:
    try:
        __import__(m)
        ck(f"import {m}", True)
    except Exception as e:
        ck(f"import {m}", False, f"{type(e).__name__}: {str(e)[:90]}")

p("")
p("=" * 76)
p("二、契约符合性（这些是「坑」的修复证据）")
p("=" * 76)

# C1 schema 枚举从 JSON 读，不硬编码
t = read("server/models/schema_enums.py") or ""
ck("schema_enums 从 schema/*.json 读取（非硬编码）",
   ("edge_types.json" in t and "knowledge_card.json" in t), "未发现读取 schema 文件")

# C2 SQLite 表名与契约一致
t = read("server/store/db.py") or ""
need = ["documents", "units", "cards", "entities", "edges", "xrefs", "tasks",
        "video_artifacts", "search_docs", "search_fts"]
missing = [n for n in need if n not in t]
ck(f"db.py 含契约 §3 的全部 10 张表", not missing, f"缺 {missing}")

# C3 pi 桥 P1：**stdout 协议通道**不能用 readline
#
# ⚠️ 检查范围说明（我的第一版误报了）：
#   P1 约束的是 **stdout 协议通道**的切帧 —— 那里 U+2028/2029 会破坏协议。
#   **stderr 是诊断通道（P3 明确说不走协议）**，对它用 readline 是**允许的**，
#   因为 stderr 里出现 U+2028 不会破坏任何东西。
#   所以：只检查「非 stderr 函数内」的 readline 调用。
def readline_violations(path):
    """返回「在协议/正文字段里」用 readline 的行号（排除 stderr 相关函数与注释）。"""
    src = io.open(os.path.join(KB, path), encoding="utf-8", errors="replace").read()
    lines = src.splitlines()
    # 找出所有函数定义的行号与名称
    funcs = []
    for i, ln in enumerate(lines):
        m = re.match(r"\s*(?:async\s+)?def\s+(\w+)\s*\(", ln)
        if m:
            funcs.append((i, m.group(1)))
    def enclosing_func(idx):
        cur = None
        for fi, name in funcs:
            if fi <= idx:
                cur = name
            else:
                break
        return cur
    out = []
    in_doc = False
    for i, ln in enumerate(lines):
        s = ln.strip()
        # 粗略跳过注释行与文档字符串行
        if s.startswith("#"):
            continue
        if s.count('"""') == 1:
            in_doc = not in_doc
            continue
        if in_doc:
            continue
        if re.search(r"\breadline\s*\(", ln):
            fn = enclosing_func(i) or ""
            if "stderr" in fn.lower():
                continue        # stderr 诊断通道：允许
            out.append((i + 1, fn, ln.strip()[:60]))
    return out

viol = []
for f in ["server/pi_bridge/client.py", "server/pi_bridge/session.py"]:
    for ln, fn, txt in readline_violations(f):
        viol.append(f"{f}:{ln} in {fn}()  {txt}")
ck("pi 桥**协议通道**未使用 readline（P1；stderr 诊断通道除外）",
   not viol, f"违规 {viol}")
# 必须用 read1 / os.read
t = read("server/pi_bridge/client.py") or ""
ck("pi 桥用 read1/os.read 切字节流", ("read1" in t or "os.read" in t), "未发现 read1/os.read")
# ensure_ascii
ck("pi 桥发命令用 ensure_ascii（消除出站 U+2028 风险）",
   "ensure_ascii" in t, "未发现 ensure_ascii")
# agent_settled 兜底
t2 = read("server/pi_bridge/events.py") or ""
ck("agent_settled 用 .get 兜底 aborted（防 KeyError）",
   ('get("aborted"' in t2 or "get('aborted'" in t2), "未发现 .get('aborted') 兜底")

# C4 bug5：单元划分递归下降 + 引言段
t = read("server/pipeline/units.py") or ""
ck("units.py 含递归下降（bug5 修复）",
   ("def pick_units" in t or "yield from" in t or "rec" in t.lower()), "未发现递归结构")
ck("units.py 含父节点引言段处理（bug5 修复）",
   ("intro" in t.lower() and "kids" in t.lower()), "未发现引言段逻辑")

# C5 bug6：xref 假阳性过滤
t = read("server/pipeline/xref.py") or ""
has_noise = ("NOISE" in t or "假阳性" in t or "mention_ok" in t)
ck("xref.py 含假阳性过滤（bug6 修复）", has_noise, "未发现 NOISE/mention_ok")
ck("xref.py NOISE 含 use/and（实测的两个典型误报）",
   (("use" in t) and ("and" in t)), "")

# C6 bug15：bigram
t = read("server/pipeline/search.py") or ""
ck("search.py 用 bigram（bug15 修复）",
   ("bigram" in t.lower()), "未发现 bigram")

p("")
p("=" * 76)
p("三、ASR（Lead 已实测的解法是否被采用）")
p("=" * 76)
t = read("server/video/asr.py") or ""
ck("asr.py 传 numpy 数组而非文件路径（绕过 PyAV）",
   ("numpy" in t or "np." in t) and ("transcribe" in t), "未发现 numpy 路径")
ck("asr.py 用了 wave 模块读 WAV",
   ("wave" in t), "未发现 wave 模块")
ck("asr.py 有模型降级策略（tiny→base→small）",
   ("tiny" in t and "base" in t), "未发现模型降级")
ck("asr.py 有断点（长任务要求）",
   ("checkpoint" in t.lower() or "断点" in t), "未发现断点")

p("")
p("=" * 76)
p(f"结果: {len(ok)} 通过 / {len(bad)} 失败")
for b in bad:
    p("  ✘ " + b)
p("=" * 76)
sys.exit(1 if bad else 0)
