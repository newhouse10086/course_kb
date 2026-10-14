# -*- coding: utf-8 -*-
"""真实 LLM 抽取（修正版）—— 按 extract.plan 的**真实结构**调用。

★ 修正记录（我第一版猜错了，实测后改）：
   1. `plan.schema` 是**裸 JSON Schema**（只有 `type`/`properties`），
      **没有** `{name, schema}` 包装 → 调用 LLM 时要自己补 `name`。
   2. `extract.plan` 必须传**完整 unit 列表** —— 它要先建层次树再选单元。
      我只传 2~6 个截断的 unit 时 `items=0`（建不出树）。
"""
import io
import json
import os
import subprocess
import sys
import time

KB = r"D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\course-kb"
PDF = r"D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\refman-26.7-en.a4.pdf"
N_LLM = int(os.environ.get("N_LLM", "3"))     # 只对前 N 个 item 真调 LLM（省时间/额度）


def p(*a):
    print(*a); sys.stdout.flush()


def load_env():
    env = {}
    for ln in io.open(os.path.join(KB, ".env"), encoding="utf-8"):
        ln = ln.strip()
        if ln and not ln.startswith("#") and "=" in ln:
            k, v = ln.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def call(job, payload, timeout=1800):
    payload = {"job": job, **payload}
    t0 = time.time()
    r = subprocess.run([sys.executable, "-m", "worker.cli", "--job", job],
                       input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                       capture_output=True, cwd=KB, timeout=timeout)
    res, errs = None, []
    for line in r.stdout.decode("utf-8", "replace").split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("type") == "result":
            res = e.get("data")
        elif e.get("type") == "error":
            errs.append(e)
    return {"exit": r.returncode, "elapsed": time.time() - t0, "data": res,
            "errors": errs, "stderr": r.stderr.decode("utf-8", "replace")[:400]}


def main():
    env = load_env()
    p("=" * 76)
    p("1. parse 全量 PDF")
    p("=" * 76)
    r = call("parse", {"path": PDF}, timeout=900)
    units = (r["data"] or {}).get("units") or []
    p(f"  exit={r['exit']} {r['elapsed']:.1f}s  units={len(units)}")
    if not units:
        p(f"  ✗ {r['errors'][:1]}"); return 1

    p("")
    p("=" * 76)
    p("2. extract.plan（传**完整** units —— 它要先建树）")
    p("=" * 76)
    r = call("extract.plan", {"units": units, "source_name": "MySQL 26.7 Reference Manual"})
    plan = r["data"] or {}
    items = plan.get("items") or []
    pick = plan.get("pick") or {}
    p(f"  exit={r['exit']} {r['elapsed']:.2f}s")
    p(f"  items={len(items)}   optional_fields={len(plan.get('optional_fields') or [])}")
    p(f"  pick: nodes={pick.get('n_nodes')} picked={pick.get('n_picked')} "
      f"(section={pick.get('n_section')} intro={pick.get('n_intro')} window={pick.get('n_window')})")
    p(f"  覆盖率: {pick.get('coverage')}  covered={pick.get('pages_covered')}/{pick.get('content_units')} "
      f"missing={pick.get('missing_count')}")
    schema = plan.get("schema") or {}
    p(f"  schema 顶层键={list(schema.keys())} properties={len((schema.get('properties') or {}))}")
    if not items:
        p("  ✗ items 仍为空"); return 1

    p("")
    p("=" * 76)
    p(f"3. 真实 LLM（并发=1，json_schema+strict，前 {N_LLM} 个 item）")
    p("=" * 76)
    from openai import OpenAI
    client = OpenAI(base_url=env["AMR_BASE"], api_key=env["AMR_KEY"], timeout=300)
    # ★ 真实结构：schema 是裸 schema，需自己包 {name, schema}
    rfmt = {"type": "json_schema",
            "json_schema": {"name": "knowledge_cards", "strict": True, "schema": schema}}

    payloads, tin, tout = [], 0, 0
    t_all = time.time()
    for i, it in enumerate(items[:N_LLM]):
        t0 = time.time()
        try:
            resp = client.chat.completions.create(
                model=env["LLM_MODEL"],
                messages=[{"role": "system", "content": it.get("system", "")},
                          {"role": "user", "content": it.get("user", "")}],
                temperature=0, max_tokens=4096, response_format=rfmt)
            txt = resp.choices[0].message.content or ""
            tin += resp.usage.prompt_tokens; tout += resp.usage.completion_tokens
            data = json.loads(txt)
            nc = len(data.get("cards") or [])
            p(f"  [{i+1}/{N_LLM}] {str(it.get('title',''))[:44]:44} cards={nc:2} "
              f"{time.time()-t0:5.1f}s out_tok={resp.usage.completion_tokens}")
            payloads.append({"key": it.get("key"), "data": data})
        except Exception as e:
            p(f"  [{i+1}/{N_LLM}] ✗ {type(e).__name__}: {str(e)[:150]}")
    p(f"  合计 {time.time()-t_all:.1f}s   tokens in={tin} out={tout}")

    if not payloads:
        p("  ✗ 无成功返回（**不伪造**）"); return 1

    p("")
    p("=" * 76)
    p("4. extract.convert（校验 + 转卡片/实体/边）")
    p("=" * 76)
    r = call("extract.convert", {"doc_id": "doc_lead_probe", "units": units, "payloads": payloads})
    conv = r["data"] or {}
    p(f"  exit={r['exit']} {r['elapsed']:.2f}s")
    if r["errors"]:
        p(f"  ✗ {json.dumps(r['errors'][:1], ensure_ascii=False)[:300]}")
    p(f"  convert 顶层键: {list(conv.keys())}")

    cards = conv.get("cards") or []
    ents = conv.get("entities") or []
    edges = conv.get("edges") or []
    p("")
    p("=" * 76)
    p("★ 真实数字")
    p("=" * 76)
    p(f"  卡片={len(cards)}  实体={len(ents)}  边={len(edges)}")
    if cards:
        kinds = {}
        for c in cards:
            kinds[c.get("kind")] = kinds.get(c.get("kind"), 0) + 1
        p(f"  kind 多样性: {len(kinds)} 种 → {json.dumps(kinds, ensure_ascii=False)}")
        req = ["name", "kind", "one_line"]
        p(f"  必填完整: {sum(1 for c in cards if all(c.get(f) for f in req))}/{len(cards)}")
        for f, nm in (("example", "示例"), ("evidence_quote", "证据"), ("purpose", "用途")):
            n = sum(1 for c in cards if c.get(f))
            p(f"  {nm}覆盖: {n}/{len(cards)} = {100*n/len(cards):.0f}%")
        p("")
        p("  样例卡片:")
        for c in cards[:3]:
            p(f"    · {c.get('name')}  [kind={c.get('kind')}]")
            p(f"      {str(c.get('one_line'))[:100]}")
            if c.get("purpose"):
                p(f"      用途: {str(c['purpose'])[:90]}")
    for k in ("dropped", "warnings", "stats"):
        if conv.get(k):
            p(f"  {k}: {json.dumps(conv[k], ensure_ascii=False)[:260]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
