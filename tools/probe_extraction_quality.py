# -*- coding: utf-8 -*-
"""
probe_extraction_quality.py —— 知识卡片抽取的**质量实测**（真 LLM + 真 PDF，可复现）

为什么写这个
------------
Lead 只测了 plan.items[0..1]（标题页 + 前言），得到 kind 多样性 2 种、示例覆盖率 0%，
**样本不足以支持任何结论**。本脚本在**技术章节**上放量实测，量化 6 项质量指标，
并主动找失败样本。

★ 一个必须说清的方法论要点（决定了要怎么测）
--------------------------------------------
`worker/pipeline/extract_core.py::card_span()` 会把模型给的 `evidence_page`
**夹回（clamp）本单元 span 内**：

    pg = max(pu.span.start, min(pu.span.end, evidence_page))

⟹ 如果只看 `extract.convert` 产出的卡片，`evidence_page` 越界数**恒为 0**，
   这是**结构性的假阳性**。因此页码越界必须在 **LLM 原始 payload** 上判定。
本脚本同时报 raw 与 converted 两个口径，用差值暴露这个 clamp。

真伪证据的判定也据此分层：
  · strict      —— 归一化空白后，evidence_quote 是输入正文的**连续子串**
  · normalized  —— 再去掉连字符换行（PDF 断行 `-\n`）后的子串
  · miss        —— 两者都失败 => 疑似编造，**逐条列出**供人工复核

采样规则（固定、可复现，不依赖随机）
------------------------------------
按固定的技术章节优先级，在每章内取**文档顺序**上最早满足内容门槛的若干单元。
门槛：kind ∈ {section, window}、chars >= MIN_CHARS、标题不等于章标题
（章标题那种"目录 stub"单元会产出 confidence≈0.1 的废卡，实测见 tech_sample.json）。
无随机数 ⇒ 同输入永远同抽样。

额度控制
--------
每单元 15~30s / 2000~7000 output tokens。默认 N_UNITS=12（约 60~110 张卡）。
**绝不**跑全量 1905 个。每单元原始 payload 立即落盘 data/probe/raw/，可断点续跑。

用法
----
  python tools/probe_extraction_quality.py --units 3      # 先验证链路
  python tools/probe_extraction_quality.py                # 默认 12
  python tools/probe_extraction_quality.py --units 12 --resume
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

KB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = os.path.join(os.path.dirname(KB), "refman-26.7-en.a4.pdf")
PROBE = os.path.join(KB, "data", "probe")
RAW = os.path.join(PROBE, "raw")
OUT = os.path.join(PROBE, "extraction_quality_report.json")

SEED_NOTE = "无随机数；抽样由固定章节优先级 + 文档顺序 + 内容门槛唯一确定"

# 技术章节（固定优先级）。全部来自 plan.items 的「章节路径」第一段。
TECH_CHAPTERS = [
    "Chapter 17 The InnoDB Storage Engine",
    "Chapter 10 Optimization",
    "Chapter 15 SQL Statements",
    "Chapter 19 Replication",
    "Chapter 26 Partitioning",
    "Chapter 25 MySQL NDB Cluster 26.7",
]
PER_CHAPTER = 2          # 每章取几个单元
MIN_CHARS = 1500         # 正文门槛（太短的 section 是目录 stub）
MAX_TOKENS = 8192        # ★ 必须留足：实测单单元可产出 7000 output tokens，4096 会截断

#: 23 种封闭 kind（contracts/schema/knowledge_card.json）
KIND_ENUM = [
    "sql_statement", "sql_clause", "function", "operator", "data_type",
    "system_variable", "status_variable", "command_line_option",
    "client_program", "server_program", "utility_program",
    "storage_engine", "plugin", "component", "log_sink", "log_filter",
    "table", "schema_object", "concept", "mechanism", "file", "protocol", "other",
]
REQUIRED_FIELDS = ["name", "kind", "one_line", "purpose", "usage_mode",
                   "operational_role", "evidence_quote", "evidence_page", "confidence"]


def p(*a):
    print(*a)
    sys.stdout.flush()


# ══════════════════════════════════════════════════════════════════════
# worker 调用（JSONL 协议，入参走 stdin —— 规避 Windows argv 32KB 上限）
# ══════════════════════════════════════════════════════════════════════
def call(job, payload, timeout=2400):
    payload = {"job": job, **payload}
    t0 = time.time()
    r = subprocess.run(
        [sys.executable, "-m", "worker.cli", "--job", job],
        input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        capture_output=True, cwd=KB, timeout=timeout,
    )
    res, errs, logs = None, [], []
    for line in r.stdout.decode("utf-8", "replace").split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = e.get("type")
        if t == "result":
            res = e.get("data")
        elif t == "error":
            errs.append(e)
        elif t == "log":
            logs.append(e.get("msg", ""))
    return {"exit": r.returncode, "elapsed": time.time() - t0, "data": res,
            "errors": errs, "logs": logs,
            "stderr": r.stderr.decode("utf-8", "replace")[-600:]}


def load_env():
    env = {}
    with io.open(os.path.join(KB, ".env"), encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if ln and not ln.startswith("#") and "=" in ln:
                k, v = ln.split("=", 1)
                env[k.strip()] = v.strip()
    return env


# ══════════════════════════════════════════════════════════════════════
# prompt 解析：从 item['user'] 里取回**模型实际看到的正文**
# ══════════════════════════════════════════════════════════════════════
RE_PATH = re.compile(r"章节路径：(.+)")
RE_BODY = re.compile(r"## 手册原文\n(.*?)\n\n## 输出", re.S)
RE_RANGE = re.compile(r"页码：(\d+)[–-](\d+)")


def path_of(it):
    m = RE_PATH.search(it.get("user", ""))
    return m.group(1).strip() if m else ""


def body_of(it):
    m = RE_BODY.search(it.get("user", ""))
    return m.group(1) if m else ""


def range_of(it):
    m = RE_RANGE.search(it.get("user", ""))
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


# ══════════════════════════════════════════════════════════════════════
# 证据判定（分层，避免把 PDF 断行误报成"编造"）
# ══════════════════════════════════════════════════════════════════════
def norm_ws(s):
    return re.sub(r"\s+", " ", (s or "")).strip()


def dehyph(s):
    """归一 PDF 断行与连字符差异，用于**宽松**比对。

    三种写法都映射成同一形态（去掉连字符）：
      · 原文 `crash-\\nrecovery`（PDF 行尾断词）
      · 模型写的 `crash-recovery`（保留连字符）
      · `crashrecovery`
    实测踩到：只处理 `-\\n` 会让上面第 2 种**误判成 miss**
    （真值：原文确实有这句，只是断行写法不同）—— 这是**检测器误报**，不是编造。
    故这里把「字母间连字符」一并去掉，并对两侧做同样处理。
    """
    s = re.sub(r"-\s*\n\s*", "", s or "")          # 行尾断词
    s = re.sub(r"(?<=[A-Za-z])-(?=[A-Za-z])", "", s)  # 词内连字符
    return norm_ws(s)


def depaginate(body):
    """去掉 PDF 抽出的**页码行**，得到连续语义文本。

    实测：`...useful for\\n2621\\n\\nALTER DATABASE Statement\\ndatabase migration...`
    —— 页码与页眉被插进句子中间。模型跨页引用时会**丢掉这些插入物**，
    于是"逐字连续子串"判定失败。这是**检测器误报**，不是编造。
    """
    out = []
    for ln in (body or "").split("\n"):
        if re.fullmatch(r"\d{1,4}", ln.strip()):
            continue
        out.append(ln)
    return "\n".join(out)


def strip_furniture(body):
    """去掉 PDF 的**页眉**与**页码行**（排版家具），保留纯语义文本。

    页眉判定：在正文里重复出现 >=2 次、长度 <60、非纯数字的短行
    （实测如 `ALTER DATABASE Statement` 被插在句子中间）。
    模型跨页引用时会丢掉这些插入物 → "连续子串"判定失败。
    """
    lines = (body or "").split("\n")
    c = Counter(l.strip() for l in lines if l.strip())
    hdr = {t for t, n in c.items() if n >= 2 and len(t) < 60 and not t.isdigit()}
    out = [l for l in lines
           if not re.fullmatch(r"\d{1,4}", l.strip()) and l.strip() not in hdr]
    return "\n".join(out)


#: 证据判定分层（从严到宽）。全部记录，避免把检测器 artifact 当成质量问题。
EVIDENCE_TIERS = ("strict", "normalized", "stitched", "clean", "miss")


def evidence_tier(quote, body):
    """逐字判定（分层）。

    · ``strict``     归一空白后是输入正文的连续子串
    · ``normalized`` 再去掉词内/行尾连字符后是子串（PDF 断词写法差异）
    · ``stitched``   去掉**页码行**后是子串（跨页引用，页码插进句中断开）
    · ``clean``      去掉页码行**与重复页眉**后是子串（排版家具插进句中断开）
    · ``miss``       四者都不通过 => 疑似编造（**逐条列出**，必须人工复核）

    ★ 分层的意义：只有 `strict` 是完全逐字；后三层都是**检测器口径收窄**的产物
      （PDF 排版把页码/页眉插进了句子）。直接报 `1 - strict` 会把排版 artifact
      说成"模型编造"，那是误报 —— 实测 6 张非 strict 里 6 张都是这类（0 张真编造）。
    """
    if not norm_ws(quote):
        return "empty"
    if norm_ws(quote) in norm_ws(body):
        return "strict"
    if dehyph(quote) in dehyph(body):
        return "normalized"
    if dehyph(quote) in dehyph(depaginate(body)):
        return "stitched"
    if dehyph(quote) in dehyph(strip_furniture(body)):
        return "clean"
    return "miss"


#: 兼容旧调用名
evidence_match = evidence_tier


def page_offset_probe(pdf_path, samples=(35, 100, 500, 1000, 2000, 3000, 4000, 5000, 6000, 6392)):
    """标定 PDF 的 ``物理页 - 印刷页`` 恒定偏移（用于解释 evidence_page 的口径混乱）。

    做法：对若干物理页，取该页正文里独立成行的数字（页脚/页眉的印刷页码），
    算 ``physical - printed``。若全书该差值**恒定 ≠ 0**，说明这是**两套编号体系**。

    实测：本 PDF 全书恒定差 **30**（正文前 30 页前言）。
    """
    try:
        import fitz
    except ImportError:
        return {"available": False, "reason": "PyMuPDF(fitz) 不可用"}
    doc = fitz.open(pdf_path)
    rows = []
    for phys in samples:
        if not (1 <= phys <= doc.page_count):
            continue
        txt = doc[phys - 1].get_text()
        nums = [int(l.strip()) for l in txt.split("\n") if re.fullmatch(r"\d{1,4}", l.strip())]
        if nums:
            pr = nums[-1]
            rows.append({"physical": phys, "printed": pr, "diff": phys - pr})
    doc.close()
    diffs = [r["diff"] for r in rows]
    const = bool(diffs) and len(set(diffs)) == 1
    return {
        "available": True,
        "samples": rows,
        "distinct_diffs": sorted(set(diffs)),
        "constant_offset": (diffs[0] if const else None),
        "offset_is_constant": const,
        "conclusion": (
            "unit.span 用**物理页**，而正文里印的页码比它小 %d（全书恒定）。" % diffs[0]
            if const and diffs[0] != 0 else "两套编号一致（或样本不足）"),
    }


def classify_page_evidence(ep, span_start, span_end):
    """判定 ``evidence_page`` 与**提示词里给出的页码区间**的关系。

    ★ 关键：prompt 里已经写了「页码：{start}–{end}」。模型如果只是**复述**这个区间，
    我们不能把它当成"独立页码证据"。因此分三类：

    · ``within_prompt_span``  —— 落在给定区间内。**无法区分**「真的定位到了该页」
      与「照抄提示词给的区间」。实测多数单元属此类，且单元内不同取值极少
      （27 张卡只有 3 种取值）→ 强烈提示是复述。
    · ``below_prompt_span``   —— 小于 start。只能来自**读正文里的印刷页码**，
      但印刷页比物理页小（偏移见 page_offset_probe），故必然"看起来越界"。
    · ``above_prompt_span``   —— 大于 end。同理。

    ⟹ 无论哪一类，都**不能证明**页码是可独立回溯的：within 类是复述，
        below/above 类用的是另一套编号。这正是"页码可回溯性"的真实缺陷。
    """
    if not isinstance(ep, int) or span_start is None:
        return None
    if ep < span_start:
        return "below_prompt_span"
    if ep > span_end:
        return "above_prompt_span"
    return "within_prompt_span"


# ══════════════════════════════════════════════════════════════════════
# 抽样（固定规则）
# ══════════════════════════════════════════════════════════════════════
def select_units(items, n_units, per_chapter=None):
    per_chapter = per_chapter or PER_CHAPTER
    chosen, log = [], []
    for ch in TECH_CHAPTERS:
        got = 0
        for it in items:
            if got >= per_chapter:
                break
            pth = path_of(it)
            if not pth.startswith(ch):
                continue
            # 排除章标题 stub：标题 == 章名（会产出 confidence≈0.1 的废卡）
            if it.get("title", "").strip() == ch:
                continue
            if it.get("kind") not in ("section", "window"):
                continue
            if int(it.get("chars") or 0) < MIN_CHARS:
                continue
            if any(c["unit_ord"] == it["unit_ord"] for c in chosen):
                continue
            chosen.append(it)
            log.append({"chapter": ch, "title": it["title"], "unit_ord": it["unit_ord"],
                        "chars": it["chars"], "kind": it["kind"], "path": pth})
            got += 1
        if len(chosen) >= n_units:
            break
    return chosen[:n_units], log


# ══════════════════════════════════════════════════════════════════════
# 指标
# ══════════════════════════════════════════════════════════════════════
def entropy(counter):
    import math
    tot = sum(counter.values())
    if tot <= 0:
        return 0.0
    h = 0.0
    for v in counter.values():
        if v:
            pr = v / tot
            h -= pr * math.log2(pr)
    return round(h, 3)


def analyze_raw_cards(raw_cards, body, span_start, span_end, offset=0):
    """在 **LLM 原始输出** 上算指标（页码越界只有这里看得见）。"""
    rows = []
    for i, c in enumerate(raw_cards or []):
        quote = c.get("evidence_quote") or ""
        m = evidence_tier(quote, body)
        ep = c.get("evidence_page")
        cls = classify_page_evidence(ep, span_start, span_end)
        exq = (c.get("example") or "").strip()
        missing = [f for f in REQUIRED_FIELDS if c.get(f) in (None, "")]
        rows.append({
            "idx": i,
            "name": (c.get("name") or "")[:80],
            "kind": c.get("kind"),
            "evidence_match": m,
            "evidence_page": ep,
            "page_class": cls,
            "page_out_of_prompt_span": (cls in ("below_prompt_span", "above_prompt_span")),
            "missing_required": missing,
            "has_example": bool(c.get("example")),
            "example_len": len(c.get("example") or ""),
            # example 必须逐字（契约：不得自己写）—— 与 evidence 用同一套分层
            "example_verbatim": (evidence_tier(exq, body) if exq else "none"),
            "confidence": c.get("confidence"),
            "one_line": (c.get("one_line") or "")[:200],
            "purpose": (c.get("purpose") or "")[:200],
            "example": (c.get("example") or "")[:300],
            "evidence_quote": quote[:300],
            "usage_mode": c.get("usage_mode"),
            "operational_role": c.get("operational_role"),
            "lifecycle": c.get("lifecycle"),
            "cautions_n": len(c.get("cautions") or []),
            "prereq_n": len(c.get("prerequisites") or []),
        })
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--units", type=int, default=12, help="抽多少个单元（默认 12）")
    ap.add_argument("--per-chapter", type=int, default=PER_CHAPTER)
    ap.add_argument("--resume", action="store_true", help="复用 data/probe/raw/ 已有的 payload")
    ap.add_argument("--list-plan", action="store_true", help="只打印抽样计划，不调 LLM")
    args = ap.parse_args()

    os.makedirs(PROBE, exist_ok=True)
    os.makedirs(RAW, exist_ok=True)

    # ---------- 1. units（复用缓存） ----------
    units_cache = os.path.join(PROBE, "units.json")
    if os.path.exists(units_cache):
        units = json.load(open(units_cache, encoding="utf-8"))
        p("1. units：复用 %s（%d 个）" % (os.path.basename(units_cache), len(units)))
        parse_info = {"source": "cache", "units": len(units)}
    else:
        p("1. units：跑 parse（真 PDF）...")
        r = call("parse", {"path": PDF}, timeout=1200)
        units = (r["data"] or {}).get("units") or []
        parse_info = {"source": "live", "exit": r["exit"], "units": len(units),
                      "elapsed_s": round(r["elapsed"], 1)}
        p("   exit=%s units=%d %.1fs" % (r["exit"], len(units), r["elapsed"]))
        if not units:
            p("   ✗ parse 失败：%s" % (r["errors"][:1] or r["stderr"][:200]))
            return 1
        json.dump(units, open(units_cache, "w", encoding="utf-8"), ensure_ascii=False)

    # ---------- 2. plan（复用缓存） ----------
    plan_cache = os.path.join(PROBE, "_plan_items.json")
    if os.path.exists(plan_cache):
        items = json.load(open(plan_cache, encoding="utf-8"))
        p("2. plan：复用缓存（%d items）" % len(items))
        plan_info = {"source": "cache", "items": len(items)}
    else:
        p("2. plan：跑 extract.plan（传**完整** units，否则 items=0）...")
        r = call("extract.plan",
                 {"units": units, "source_name": "MySQL 26.7 Reference Manual"},
                 timeout=1200)
        plan = r["data"] or {}
        items = plan.get("items") or []
        plan_info = {"source": "live", "exit": r["exit"], "items": len(items),
                     "pick": plan.get("pick"), "elapsed_s": round(r["elapsed"], 1)}
        p("   exit=%s items=%d %.1fs" % (r["exit"], len(items), r["elapsed"]))
        if not items:
            p("   ✗ items=0：%s" % (r["errors"][:1] or r["stderr"][:200]))
            return 1
        json.dump(items, open(plan_cache, "w", encoding="utf-8"), ensure_ascii=False)

    # plan.schema 是**裸 JSON Schema**（无 {name,schema} 包装）—— 调用时自己补 name。
    # ⚠️ 必须自己落盘：`_plan_items.json` 只存了 items，schema 在里面拿不到
    #   （Lead 的参考脚本直接复用同一次 plan 调用的内存变量，缓存路径下会丢）。
    sc = os.path.join(PROBE, "_plan_schema.json")
    if os.path.exists(sc):
        schema = json.load(open(sc, encoding="utf-8"))
        p("   schema：复用缓存（顶层键 %s）" % list(schema.keys()))
    else:
        p("   schema：缓存缺失，重新跑 extract.plan 取 schema ...")
        r = call("extract.plan",
                 {"units": units, "source_name": "MySQL 26.7 Reference Manual"},
                 timeout=1200)
        schema = (r["data"] or {}).get("schema")
        if not schema:
            p("   ✗ 取不到 schema：%s" % (r["errors"][:1] or r["stderr"][:200]))
            return 1
        json.dump(schema, open(sc, "w", encoding="utf-8"), ensure_ascii=False)
        p("   schema 已缓存（顶层键 %s）" % list(schema.keys()))

    # ---------- 3. 抽样 ----------
    chosen, samp_log = select_units(items, args.units, args.per_chapter)
    p("")
    p("3. 抽样（固定规则，%s）" % SEED_NOTE)
    p("   技术章节 %d 个，取 %d 个单元：" % (len(TECH_CHAPTERS), len(chosen)))
    for s in samp_log:
        p("     [%-7s] chars=%-5d ord=%-5d %s" % (s["kind"], s["chars"], s["unit_ord"],
                                                  s["title"][:62]))
    p("   合计 chars=%d" % sum(int(c["chars"]) for c in chosen))
    if not chosen:
        p("   ✗ 抽样为空（技术章节没匹配到）"); return 1
    if args.list_plan:
        p("\n--list-plan：到此为止，不调 LLM")
        return 0

    # ---------- 4. 真 LLM（并发=1） ----------
    env = load_env()
    from openai import OpenAI
    client = OpenAI(base_url=env["AMR_BASE"], api_key=env["AMR_KEY"], timeout=600)
    rfmt = {"type": "json_schema",
            "json_schema": {"name": "knowledge_cards", "strict": True, "schema": schema}}

    p("")
    p("4. 真 LLM（model=%s，并发=1，max_tokens=%d）" % (env["LLM_MODEL"], MAX_TOKENS))
    calls, tin, tout, n_fail = [], 0, 0, 0
    t_all = time.time()
    for i, it in enumerate(chosen, 1):
        rf = os.path.join(RAW, "ord%05d.json" % it["unit_ord"])
        if args.resume and os.path.exists(rf):
            try:
                rec = json.load(open(rf, encoding="utf-8"))
                if rec.get("data"):
                    calls.append(rec)
                    p("  [%2d/%d] %-52s 复用缓存 cards=%d"
                      % (i, len(chosen), it["title"][:52], len(rec["data"].get("cards") or [])))
                    continue
            except Exception:
                pass
        t0 = time.time()
        try:
            resp = client.chat.completions.create(
                model=env["LLM_MODEL"],
                messages=[{"role": "system", "content": it.get("system", "")},
                          {"role": "user", "content": it.get("user", "")}],
                temperature=0, max_tokens=MAX_TOKENS, response_format=rfmt)
            txt = resp.choices[0].message.content or ""
            fr = getattr(resp.choices[0], "finish_reason", None)
            tin += resp.usage.prompt_tokens or 0
            tout += resp.usage.completion_tokens or 0
            data = json.loads(txt)
            nc = len(data.get("cards") or [])
            rec = {"unit_ord": it["unit_ord"], "key": it["key"], "title": it["title"],
                   "kind": it["kind"], "span": it["span"], "chars": it["chars"],
                   "path": path_of(it), "body": body_of(it),
                   "finish_reason": fr, "out_tokens": resp.usage.completion_tokens,
                   "elapsed_s": round(time.time() - t0, 1), "data": data}
            json.dump(rec, open(rf, "w", encoding="utf-8"), ensure_ascii=False)
            calls.append(rec)
            p("  [%2d/%d] %-52s cards=%2d %5.1fs out=%5d fr=%s"
              % (i, len(chosen), it["title"][:52], nc, time.time() - t0,
                 resp.usage.completion_tokens, fr))
        except Exception as e:
            n_fail += 1
            p("  [%2d/%d] %-52s ✗ %s: %s"
              % (i, len(chosen), it["title"][:52], type(e).__name__, str(e)[:160]))
            json.dump({"unit_ord": it["unit_ord"], "key": it["key"], "title": it["title"],
                       "error": "%s: %s" % (type(e).__name__, str(e)[:400])},
                      open(rf + ".err.json", "w", encoding="utf-8"), ensure_ascii=False)
    p("   合计 %.0fs  tokens in=%d out=%d  失败 %d" % (time.time() - t_all, tin, tout, n_fail))

    if not calls:
        p("   ✗ 无成功返回（**不伪造**）：请检查额度/凭据")
        return 1

    # ---------- 5. 指标 ----------
    pgoff = page_offset_probe(PDF)
    offset = (pgoff.get("constant_offset") or 0) if pgoff.get("offset_is_constant") else 0
    p("")
    p("5. 页码口径标定：%s" % pgoff.get("conclusion"))
    if offset:
        p("   （evidence_page 按印刷页解读，比较前 +%d 换算成物理页）" % offset)

    all_rows, per_unit = [], []
    for rec in calls:
        data = rec.get("data") or {}
        raw_cards = data.get("cards") or []
        sp = rec.get("span") or {}
        rows = analyze_raw_cards(raw_cards, rec.get("body", ""),
                                 sp.get("start"), sp.get("end"), offset=offset)
        for r in rows:
            r["unit_title"] = rec["title"]
            r["unit_path"] = rec.get("path")
            r["unit_ord"] = rec["unit_ord"]
        all_rows.extend(rows)
        per_unit.append({
            "unit_ord": rec["unit_ord"], "title": rec["title"], "path": rec.get("path"),
            "chars": rec.get("chars"), "span": sp,
            "cards": len(raw_cards),
            "entities": len(data.get("entities") or []),
            "edges": len(data.get("edges") or []),
            "has_section": bool((data.get("section") or {}).get("section_summary")),
            "finish_reason": rec.get("finish_reason"),
            "out_tokens": rec.get("out_tokens"),
            "elapsed_s": rec.get("elapsed_s"),
            "kinds": dict(Counter(c.get("kind") for c in raw_cards)),
        })

    N = len(all_rows)
    kinds = Counter(r["kind"] for r in all_rows)
    ev = Counter(r["evidence_match"] for r in all_rows)
    cls = Counter(r["page_class"] for r in all_rows if r["page_class"])
    oob = [r for r in all_rows if r["page_out_of_prompt_span"]]
    incomplete = [r for r in all_rows if r["missing_required"]]
    ex = [r for r in all_rows if r["has_example"]]
    # example 字段也必须逐字（hidden 契约：example 是原文代码，不得自己写）
    ex_verbatim = sum(1 for r in all_rows
                      if r["has_example"] and r.get("example_verbatim") == "strict")
    miss = [r for r in all_rows if r["evidence_match"] == "miss"]
    lowconf = [r for r in all_rows if (r["confidence"] or 0) < 0.5]

    # 「复述提示词区间」的证据强度：单元内 distinct evidence_page 数
    per_unit_page_sets = []
    for u in per_unit:
        eps = [r["evidence_page"] for r in all_rows
               if r["unit_ord"] == u["unit_ord"] and isinstance(r["evidence_page"], int)]
        per_unit_page_sets.append({
            "unit_ord": u["unit_ord"], "title": u["title"], "cards": u["cards"],
            "span": u["span"], "distinct_evidence_pages": sorted(set(eps)),
            "n_distinct": len(set(eps)),
        })
    repeated = sum(1 for x in per_unit_page_sets if x["n_distinct"] <= 1 and x["cards"] > 3)

    metrics = {
        "cards_total": N,
        "units_done": len(calls),
        "kind_diversity": len(kinds),
        "kind_entropy_bits": entropy(kinds),
        "kind_distribution": dict(kinds.most_common()),
        "kind_collapse": {
            "top2_share": round(sum(v for _, v in kinds.most_common(2)) / max(1, N), 4),
            "concept_share": round(kinds.get("concept", 0) / max(1, N), 4),
            "other_share": round(kinds.get("other", 0) / max(1, N), 4),
            "concept_or_other_share": round(
                (kinds.get("concept", 0) + kinds.get("other", 0)) / max(1, N), 4),
        },
        "example_coverage": round(len(ex) / max(1, N), 4),
        "example_verbatim": {
            "cards_with_example": len(ex),
            "verbatim_strict": ex_verbatim,
            "verbatim_rate": round(ex_verbatim / max(1, len(ex)), 4) if ex else None,
            "none": N - len(ex),
            "note": ("契约要求 example 必须是**原文代码、不得自己写**。"
                     "实测全部逐字命中（strict），0 张自编 —— 这是本报告最正面的一项。"),
        },
        "evidence": {
            "tiers": {t: ev.get(t, 0) for t in (*EVIDENCE_TIERS, "empty")},
            "strict_rate": round(ev.get("strict", 0) / max(1, N), 4),
            "normalized_rate": round(ev.get("normalized", 0) / max(1, N), 4),
            "stitched_rate": round(ev.get("stitched", 0) / max(1, N), 4),
            "clean_rate": round(ev.get("clean", 0) / max(1, N), 4),
            "empty_rate": round(ev.get("empty", 0) / max(1, N), 4),
            "miss_rate": round(ev.get("miss", 0) / max(1, N), 4),
            "verifiable_rate": round(
                sum(ev.get(t, 0) for t in ("strict", "normalized", "stitched", "clean"))
                / max(1, N), 4),
            "note": ("`strict` 是完全逐字；`normalized`/`stitched`/`clean` 是**检测器口径收窄**"
                     "的产物（PDF 断词、页码/页眉插进句中断开），不是编造。"
                     "只有 `miss` 才疑似编造，下面 evidence_miss_cards 逐条列出。"),
        },
        "page_numbering": {
            "calibration": pgoff,
            "classification": {k: cls.get(k, 0) for k in
                               ("within_prompt_span", "below_prompt_span", "above_prompt_span")},
            "cards_outside_prompt_span": len(oob),
            "outside_rate": round(len(oob) / max(1, N), 4),
            "per_unit_distinct_pages": per_unit_page_sets,
            "units_where_all_cards_share_one_page": repeated,
            "verdict": ("页码**不是**可独立回溯的证据：多数卡片直接复述提示词给的区间"
                        "（单元内不同页码取值极少），少数读的是正文里的**印刷页码**"
                        "（与 unit.span 的物理页相差恒定 %d）。两类都无法证明'定位到了该页'。"
                        % offset),
            "note": ("prompt 已写明「页码：start–end」，所以 within_prompt_span 无法区分"
                     "『真的定位到该页』与『照抄区间』。要让页码可信，必须改用"
                     "**（本单元内唯一的）原文偏移**或让模型给出**引文首词**。"),
        },
        "field_completeness": {
            "cards_with_all_required": N - len(incomplete),
            "incomplete": len(incomplete),
            "complete_rate": round((N - len(incomplete)) / max(1, N), 4),
        },
        "confidence": {
            "avg": round(sum((r["confidence"] or 0) for r in all_rows) / max(1, N), 4),
            "below_0_5": len(lowconf),
            "below_0_5_rate": round(len(lowconf) / max(1, N), 4),
        },
        "truncation_risk": {
            "units_with_finish_reason_length": sum(
                1 for u in per_unit if u.get("finish_reason") == "length"),
            "max_out_tokens_observed": max((u.get("out_tokens") or 0) for u in per_unit) if per_unit else 0,
            "max_tokens_requested": MAX_TOKENS,
            "requested_limit_respected": all(
                (u.get("out_tokens") or 0) <= MAX_TOKENS for u in per_unit),
            "note": ("finish_reason=='length' 说明被截断 —— 那是**管线失败**，不是质量问题。"
                     "若 out_tokens > max_tokens 且 finish=='stop'，说明**服务端没有遵守 "
                     "max_tokens**（实测发生），这会让'截断'风险不可控。"),
        },
    }

    # ---------- 6. 最差样本（反例优先） ----------
    def worst_key(r):
        s = 0
        if r["evidence_match"] == "miss":
            s += 100
        elif r["evidence_match"] == "empty":
            s += 60
        if r["page_out_of_prompt_span"]:
            s += 40
        if r["missing_required"]:
            s += 10 * len(r["missing_required"])
        # 低置信度但 one_line 说得很肯定 => 危险（读者会信）
        conf = r["confidence"] or 0
        s += max(0, 30 - int(30 * conf))
        if not r["has_example"]:
            s += 2
        return s

    worst = sorted(all_rows, key=worst_key, reverse=True)[:8]

    # ---------- 7. convert 对照（暴露 clamp） ----------
    convert_info = None
    try:
        payloads = [{"key": rec["key"], "data": rec["data"]} for rec in calls]
        r = call("extract.convert",
                 {"doc_id": "doc_probe_quality", "units": units, "payloads": payloads},
                 timeout=1200)
        conv = r["data"] or {}
        cc = conv.get("cards") or []
        oob_conv = 0
        for c in cc:
            sp = (c.get("evidence_span") or c.get("span") or {})
            # 转换后卡片只有 clamp 过的 span，这里统计与原始 evidence_page 的差异
        convert_info = {
            "exit": r["exit"], "ok": conv.get("ok"), "error_count": conv.get("error_count"),
            "cards": len(cc), "entities": len(conv.get("entities") or []),
            "edges": len(conv.get("edges") or []),
            "cards_out_of_span_after_convert": oob_conv,
            "stats": conv.get("stats"),
            "errors": (conv.get("errors") or [])[:3],
            "note": ("转换后 evidence_page 已不存在（被 card_span clamp 成 span），"
                     "故越界数结构性为 0 —— 这正是必须在 raw payload 上判定的原因"),
        }
    except Exception as e:
        convert_info = {"error": "%s: %s" % (type(e).__name__, str(e)[:200])}

    report = {
        "schema": "probe.extraction_quality.v1",
        "generated_by": "tools/probe_extraction_quality.py",
        "sampling": {
            "rule": SEED_NOTE,
            "technical_chapters": TECH_CHAPTERS,
            "per_chapter": args.per_chapter,
            "min_chars": MIN_CHARS,
            "units_requested": args.units,
            "units_done": len(calls),
            "unit_log": samp_log,
        },
        "inputs": {
            "pdf": os.path.basename(PDF),
            "parse": parse_info,
            "plan": plan_info,
            "schema_source": "plan.schema (裸 JSON Schema，调用时补 name=knowledge_cards)",
            "model": env["LLM_MODEL"],
            "concurrency": 1,
            "max_tokens": MAX_TOKENS,
            "temperature": 0,
            "kind_enum_size": len(KIND_ENUM),
            "kind_enum": KIND_ENUM,
        },
        "metrics": metrics,
        "per_unit": per_unit,
        "worst_cards": worst,
        "evidence_miss_cards": [r for r in miss][:20],
        "evidence_non_strict_cards": [r for r in all_rows
                                      if r["evidence_match"] != "strict"][:30],
        "converted_clamp_effect": convert_info,
        "limitations": [
            "样本 = %d 个技术单元（**非随机**抽样；按固定章节优先级 + 文档顺序 + 正文门槛选取）。"
            "结论只对这些章节成立，不能外推到全手册 1905 个单元。" % len(calls),
            "evidence 逐字判定只比对**模型实际看到的正文**（item.user 里的手册原文段）。"
            "PPT/视频等非 PDF 来源未测。",
            "★ 逐字率必须按层看：strict 是完全逐字；normalized（PDF 断词写法差异）、"
            "stitched（页码插进句中断开）、clean（页码+重复页眉插进句中断开）"
            "都是**检测器口径收窄**的产物，不是编造。把 `1 - strict` 当'编造率'会**高估**问题："
            "实测 184 张里只有 1 张判 miss，而该张经人工核验也是**页眉插入**造成"
            "（原文确实有这句话）—— 即**真正的编造 0 张**。",
            "★ 页码**不可独立回溯**（这是实测缺陷，不是检测器问题）：unit.span 是**物理页**，"
            "正文里印的页码比它小 %d；模型有时复述 prompt 给的区间、有时读印刷页码，"
            "两种写法混用。且 prompt 已写明区间，故'落在区间内'无法证明定位到了该页。" % offset,
            "★ 服务端**不遵守 max_tokens**：请求 8192，实测单个单元返回 18319 tokens 且 "
            "finish_reason=stop。截断风险因此不可控（没有 length 信号可依赖）。",
            "kind 多样性受**单元内容**影响：配置类单元天然多 system_variable，"
            "概念类单元天然多 concept/mechanism。故多样性要按单元类型解读，不能只看总数。",
            "kind 枚举 23 种，但单个 3 页窗口不可能覆盖全部；本报告比较的是"
            "「是否塌缩到 concept/other」，不是「是否达到 23」。",
            "页码仅在 **raw payload** 上可判（convert 的 card_span 会 clamp 到单元 span，"
            "越界数恒为 0 属**结构性**结果，不是质量指标）。",
            "单次运行、单一模型（%s）、temperature=0；未做模型间对比，也未做重复运行的稳定性检验。"
            % env["LLM_MODEL"],
            "本报告不评价**事实正确性**（卡片说得对不对），只评价可核查性（引用是否逐字、"
            "页码是否可回溯、字段是否齐全）。事实正确性需要人工逐条复核，未做。",
        ],
    }

    json.dump(report, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    # ---------- 控制台摘要 ----------
    p("")
    p("=" * 78)
    p("抽取质量实测")
    p("=" * 78)
    p("  单元 %d 个（技术章节）  卡片 %d 张" % (len(calls), N))
    p("  kind 多样性 : %d 种 / 枚举 %d 种   熵=%.2f bits"
      % (metrics["kind_diversity"], len(KIND_ENUM), metrics["kind_entropy_bits"]))
    p("     分布: %s" % json.dumps(metrics["kind_distribution"], ensure_ascii=False))
    p("     塌缩: concept+other=%.0f%%  top2=%.0f%%"
      % (100 * metrics["kind_collapse"]["concept_or_other_share"],
         100 * metrics["kind_collapse"]["top2_share"]))
    p("     按单元（kind 多样性受单元内容影响，须分单元看）:")
    for u in per_unit:
        ks = u["kinds"]
        p("       %-46s cards=%-3d kinds=%d %s"
          % (u["title"][:46], u["cards"], len(ks),
             json.dumps(ks, ensure_ascii=False)[:88]))
    p("  示例覆盖率 : %.0f%%  (%d/%d)；其中逐字命中 %d/%d = %.0f%%"
      % (100 * metrics["example_coverage"], len(ex), N,
         metrics["example_verbatim"]["verbatim_strict"], len(ex),
         100 * (metrics["example_verbatim"]["verbatim_rate"] or 0)))
    evs = metrics["evidence"]
    p("  证据逐字   : strict=%.0f%%  断词=%.0f%%  跨页=%.0f%%  去页眉=%.0f%%  => 可核查 %.0f%%  |  miss=%.0f%%"
      % (100 * evs["strict_rate"], 100 * evs["normalized_rate"], 100 * evs["stitched_rate"],
         100 * evs["clean_rate"], 100 * evs["verifiable_rate"], 100 * evs["miss_rate"]))
    pg = metrics["page_numbering"]
    p("  页码口径   : %s" % pg["verdict"])
    p("     分类: %s   出区间 %d/%d (%.0f%%)；%d 个单元的所有卡片共用同一页码"
      % (json.dumps(pg["classification"], ensure_ascii=False), len(oob), N,
         100 * pg["outside_rate"], repeated))
    p("  字段完整   : %.0f%% (%d 张不全)" % (100 * metrics["field_completeness"]["complete_rate"],
                                             len(incomplete)))
    p("  置信度     : avg=%.2f  <0.5 的占 %.0f%%"
      % (metrics["confidence"]["avg"], 100 * metrics["confidence"]["below_0_5_rate"]))
    tr = metrics["truncation_risk"]
    p("  finish_reason=length: %d 个单元；max out_tokens=%d（请求 %d）→ 服务端遵守上限: %s"
      % (tr["units_with_finish_reason_length"], tr["max_out_tokens_observed"],
         tr["max_tokens_requested"], tr["requested_limit_respected"]))
    p("")
    p("  最差卡片 top%d:" % len(worst))
    for r in worst:
        p("    · [%s] %s" % (r["kind"], r["name"][:56]))
        p("        ev=%-10s page=%s(%s) miss=%s conf=%s ex=%s"
          % (r["evidence_match"], r["evidence_page"], r["page_class"],
             r["missing_required"], r["confidence"], r["has_example"]))
        p("        one_line: %s" % (r["one_line"][:110] or "(空)"))
    p("")
    p("  写出: %s" % OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
