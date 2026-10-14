"""course-kb Web UI 的 headless Chrome 测试夹具（T3 写域内：tests/test_web_*.py）

为什么不 mock fetch：契约 C6/坑 8 明确「页面走 http API」。
本夹具起一个**真 HTTP 服务**（同源静态文件 + 契约 §5 的 REST 端点），
数据来自上游已冻结的真实产物（tree.json / _ckpt_v2.json / graph_view.json），
转换成契约形状后提供 —— 于是页面跑的是真实数据体量（1644 节点 / 481 边 / 360 卡片），
而不是几行假 JSON。

用法：
    from test_web_common import serve, dump_dom, jsonscript, meta
    srv = serve(degraded=False)          # 或 pytest fixture: web_server
    dom = dump_dom(f"{srv.base}/index.html?selftest=1")
    report = jsonscript(dom, "selftest-report")
"""

from __future__ import annotations

import html
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import wave
from collections import Counter, defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import pytest

# ---------------------------------------------------------------- 路径与环境

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                                  # course-kb/
WEB = ROOT / "web"
UPSTREAM = ROOT.parent / "数据库课程智能体调研" / "data"
TREE_JSON = UPSTREAM / "refman_extract" / "tree.json"
GRAPH_JSON = UPSTREAM / "refman_extract" / "graph_view.json"
CKPT_JSON = UPSTREAM / "refman_v2" / "_ckpt_v2.json"
INTROS_JSON = UPSTREAM / "refman_v2" / "manual_intros.json"
INTROS_L3_JSON = UPSTREAM / "refman_v2" / "manual_intros_l3.json"

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

DOC_PDF = "doc_refman00001"
DOC_VIDEO = "doc_video00001"
WIKI_UNIT = "unt_0131"          # 5.3.1 Creating and Selecting a Database（13 张卡片 / 24 个实体）
WIKI_UNIT_CARDS = 13
WIKI_UNIT_TITLE = "5.3.1 Creating and Selecting a Database"

# 无头同步屏障：/hold 最多扣住多久（页面崩了也不能把 Chrome 永久卡住）
HOLD_TIMEOUT_S = 90.0
RELEASE = threading.Event()

# 夹具开关：模拟「T1 的 /graph 没给 unit_ids」这一集成风险（契约 §5.2 节点字段）
CFG = {"strip_unit_ids": False}

# 契约 §2.5 的 mention 假阳性过滤（与前端 xref.js / docs 一致）
NOISE = {
    "use", "and", "or", "not", "in", "is", "as", "on", "to", "by", "if", "for",
    "all", "any", "set", "key", "desc", "path", "date", "char", "time", "text", "blob", "view",
    "index", "table", "value", "name", "type", "user", "host", "port", "file", "test", "data", "event",
}
IDENT_RE = re.compile(r"[\u4e00-\u9fff()\[\].\-_@#$%]")


def chrome_path() -> str:
    for c in CHROME_CANDIDATES:
        if Path(c).exists():
            return c
    return ""


# ---------------------------------------------------------------- 数据构建

def _uid(i) -> str:
    return f"unt_{int(i):04d}"


def _layer_of(node_type: str) -> str:
    if node_type in ("product", "feature", "table"):
        return "L2"
    if node_type in ("business", "role"):
        return "L3"
    if node_type in ("concept", "mechanism", "problem", "misconception", "station"):
        return "L1"
    if node_type == "regulation":
        return "L0"
    return ""


def build_fixture() -> dict:
    """把上游真实产物转换成契约 §2/§5 形状。"""
    tree = json.loads(TREE_JSON.read_text(encoding="utf-8"))
    nodes = tree["nodes"]
    entity_home = tree.get("entity_home", {})

    intros = {}
    for p in (INTROS_JSON, INTROS_L3_JSON):
        if p.exists():
            d = json.loads(p.read_text(encoding="utf-8"))
            intros.update(d.get("intros", {}))

    ckpt = json.loads(CKPT_JSON.read_text(encoding="utf-8"))
    sections = ckpt["sections"]

    # ---------------- units / outline ----------------
    units = {}
    for key, n in nodes.items():
        if key == "__GENERAL__":
            continue
        span = {"kind": "page", "start": int(n.get("pg") or 0), "end": int(n.get("end") or n.get("pg") or 0)}
        units[_uid(key)] = {
            "id": _uid(key),
            "doc_id": DOC_PDF,
            "order": int(key) if str(key).isdigit() else 0,
            "title": n.get("title") or "",
            "level": int(n.get("lvl") or 1),
            "parent_id": _uid(n["parent"]) if n.get("parent") and str(n["parent"]) in nodes else None,
            "span": span,
            "text": "",
            "text_len": 0,
            "_key": str(key),
        }
    for key, n in nodes.items():
        if key == "__GENERAL__":
            continue
        u = units.get(_uid(key))
        if not u:
            continue
        u["children"] = [_uid(c) for c in (n.get("children") or []) if str(c) in nodes]
        u["entities"] = [e.get("id") for e in (n.get("entities") or [])]

    # ---------------- cards ----------------
    cards, xrefs = [], []
    sec_of_card = {}
    for sec in sections:
        meta = sec.get("_meta", {})
        node_i = meta.get("node_i")
        unit_id = _uid(node_i) if node_i is not None else None
        s = sec.get("section", {})
        for c in sec.get("cards", []):
            cid = f"crd_{len(cards) + 1:04d}"
            page = int(c.get("evidence_page") or meta.get("pg") or 0)
            cards.append({
                "id": cid,
                "doc_id": DOC_PDF,
                "unit_id": unit_id,
                "name": c.get("name") or "",
                "kind": c.get("kind") or "other",
                "one_line": c.get("one_line") or "",
                "purpose": c.get("purpose") or "",
                "usage_mode": c.get("usage_mode") or "unknown",
                "operational_role": c.get("operational_role") or "unknown",
                "lifecycle": c.get("lifecycle") or "unknown",
                "example": c.get("example"),
                "example_explained": c.get("example_explained"),
                "prerequisites": c.get("prerequisites") or [],
                "cautions": c.get("cautions") or [],
                "evidence_quote": c.get("evidence_quote") or "",
                "evidence_span": {"kind": "page", "start": page, "end": page},
                "confidence": float(c.get("confidence") or 0.0),
                "name_key": (c.get("name") or "").strip().lower(),
            })
            sec_of_card[cid] = unit_id
        if unit_id and unit_id in units:
            units[unit_id]["intro"] = s.get("section_summary") or ""
            units[unit_id]["objectives"] = s.get("learning_objectives") or []
            units[unit_id]["key_takeaways"] = s.get("key_takeaways") or []
            units[unit_id]["section_role"] = s.get("section_role") or ""
    # 所有层级都要有 intro（F3）：手写覆盖层优先，其次 ckpt 的 section_summary
    for key, n in nodes.items():
        if key == "__GENERAL__":
            continue
        u = units.get(_uid(key))
        if not u or u.get("intro"):
            continue
        ov = intros.get(str(key)) or {}
        u["intro"] = ov.get("intro") or ""
        u["why"] = ov.get("why") or ""

    cards_by_id = {c["id"]: c for c in cards}
    cards_by_key = defaultdict(list)
    for c in cards:
        cards_by_key[c["name_key"]].append(c)

    def card_text(c):
        return " ".join(filter(None, [
            c["name"], c["one_line"], c["purpose"], c["example"] or "",
            c["example_explained"] or "", c["evidence_quote"] or "",
            " ".join(c["cautions"]), " ".join(c["prerequisites"]),
        ]))

    # mention：正文提到（按契约 §2.5 过滤，短名/含空格要求全大写出现）
    texts = {c["id"]: card_text(c) for c in cards}
    mention_n = 0
    for a in cards:
        body = texts[a["id"]]
        per_card = 0
        for b in sorted(cards, key=lambda x: x["id"]):
            if a["id"] == b["id"]:
                continue
            nm = b["name"].strip()
            if not nm:
                continue
            low = nm.lower()
            bare_a = a["name"].strip().lower().rstrip("()")
            if low.rstrip("()") == bare_a:                       # 坑 7：自引用
                continue
            if IDENT_RE.search(nm):
                hit = nm in body
            elif low in NOISE:                                   # 坑 6
                hit = False
            elif len(low) < 6 or " " in low:
                hit = nm.isascii() and nm.upper() in body        # 规则 3：只认全大写代码形式
            else:
                hit = nm.lower() in body.lower()
            if hit:
                xrefs.append({"from_card_id": a["id"], "to_card_id": b["id"], "rel": "mention", "weight": 1})
                mention_n += 1
                per_card += 1
                if per_card >= 60:
                    break

    # also_in：同名卡片跨单元复现
    also_n = 0
    for key, group in cards_by_key.items():
        if len(group) < 2:
            continue
        for i, a in enumerate(group):
            for b in group[i + 1:]:
                if sec_of_card[a["id"]] != sec_of_card[b["id"]]:
                    xrefs.append({"from_card_id": a["id"], "to_card_id": b["id"], "rel": "also_in", "weight": 1})
                    xrefs.append({"from_card_id": b["id"], "to_card_id": a["id"], "rel": "also_in", "weight": 1})
                    also_n += 2

    # same_unit：同单元其他卡片（每卡最多 4 个，边界明确、可复现）
    same_n = 0
    by_unit = defaultdict(list)
    for c in cards:
        by_unit[c["unit_id"]].append(c)
    for uid, group in by_unit.items():
        ordered = sorted(group, key=lambda c: c["id"])
        for i, a in enumerate(ordered):
            for b in ordered[i + 1:i + 5]:
                xrefs.append({"from_card_id": a["id"], "to_card_id": b["id"], "rel": "same_unit", "weight": 1})
                xrefs.append({"from_card_id": b["id"], "to_card_id": a["id"], "rel": "same_unit", "weight": 1})
                same_n += 2

    # ---------------- graph ----------------
    g = json.loads(GRAPH_JSON.read_text(encoding="utf-8"))
    unit_of_entity = {}
    for ent, home in entity_home.items():
        # "__GENERAL__" 是上游的「全书通用概念」伪节点，没有页码归属 → 不给 unit_ids
        if str(home) in nodes and str(home) != "__GENERAL__":
            unit_of_entity[str(ent)] = _uid(home)
    for key, n in nodes.items():
        if key == "__GENERAL__":
            continue
        for e in (n.get("entities") or []):
            eid = str(e.get("id"))
            unit_of_entity.setdefault(eid, _uid(key))

    degree = Counter()
    for e in g["edges"]:
        degree[e["src"]] += 1
        degree[e["dst"]] += 1

    g_nodes = [{
        "id": n["id"],
        "name": n.get("name") or n["id"],
        "name_zh": n.get("zh") or "",
        "type": n.get("type") or "",
        "layer": _layer_of(n.get("type") or ""),
        "degree": degree.get(n["id"], 0),
        "unit_ids": [unit_of_entity[n["id"]]] if n["id"] in unit_of_entity else [],
    } for n in g["nodes"]]

    g_edges, flagged_n = [], 0
    for i, e in enumerate(g["edges"]):
        # flagged：夹具里用「证据未验证」+ 每 11 条取一条，构造出可断言、可复现的 flagged 样本
        flagged = (e.get("verified") is False) or (i % 11 == 0)
        if flagged:
            flagged_n += 1
        pages = e.get("pages") or [0]
        g_edges.append({
            "id": f"edg_{i + 1:04d}",
            "src": e["src"],
            "dst": e["dst"],
            "etype": e["etype"],
            "evidence": e.get("evidence") or "",
            "span": {"kind": "page", "start": int(pages[0]), "end": int(pages[-1])},
            "confidence": float(e.get("confidence") or 0.0),
            "flagged": flagged,
        })

    # typed：图谱边两端实体名能对上卡片名 → 类型化交叉引用
    ent_to_card = {}
    for n in g_nodes:
        for nm in (n["name"], n["name_zh"]):
            k = (nm or "").strip().lower()
            if k and k in cards_by_key:
                ent_to_card[n["id"]] = cards_by_key[k][0]["id"]
    typed_n = 0
    for e in g_edges:
        a, b = ent_to_card.get(e["src"]), ent_to_card.get(e["dst"])
        if a and b and a != b:
            xrefs.append({"from_card_id": a, "to_card_id": b, "rel": "typed", "weight": 1})
            typed_n += 1

    # 去重（同 from/to/rel 只留一条）
    seen, uniq = set(), []
    for x in xrefs:
        k = (x["from_card_id"], x["to_card_id"], x["rel"])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(x)
    xrefs = uniq

    cross_unit_mention = sum(
        1 for x in xrefs
        if x["rel"] == "mention" and sec_of_card[x["from_card_id"]] != sec_of_card[x["to_card_id"]]
    )

    # ---------------- outline（契约 §5.2） ----------------
    n_cards = Counter(c["unit_id"] for c in cards)
    outline_nodes = {}
    for key, n in nodes.items():
        if key == "__GENERAL__":
            continue
        u = units[_uid(key)]
        outline_nodes[u["id"]] = {
            "id": u["id"],
            "title": u["title"],
            "level": u["level"],
            "span": u["span"],
            "children": u.get("children", []),
            "n_cards": n_cards.get(u["id"], 0),
            "n_units": len(u.get("children", [])),
            "intro": u.get("intro", ""),
            "why": u.get("why", ""),
            "objectives": u.get("objectives", []),
            "key_takeaways": u.get("key_takeaways", []),
            "section_role": u.get("section_role", ""),
        }
    roots = [_uid(r) for r in tree["roots"] if str(r) in nodes and str(r) != "__GENERAL__"]

    # ---------------- video（合成夹具数据；真实产物由 T2 产出） ----------------
    DUR = 3_600_000
    seg_n = 3000
    segs = []
    for i in range(seg_n):
        start = i * (DUR // seg_n)
        segs.append({
            "i": i,
            "start": start,
            "end": start + (DUR // seg_n) - 60,
            "text": f"第 {i + 1} 段：这一节讲索引的选择性与回表代价，示例 SELECT * FROM t WHERE k = {i}; （夹具合成文本）",
            "confidence": round(0.86 + (i % 12) / 100, 3),
        })
    chapters = []
    for c in range(8):
        start = c * (DUR // 8)
        end = DUR if c == 7 else (c + 1) * (DUR // 8)
        chapters.append({
            "title": f"第 {c + 1} 章 " + ["索引基础", "B+ 树结构", "聚簇与二级索引", "回表与覆盖索引",
                                            "EXPLAIN 解读", "执行计划与代价", "索引失效场景", "调优实战"][c],
            "start": start, "end": end,
            "text": f"本章（{start // 1000}s–{end // 1000}s）讲解……（夹具合成文稿，长度受限）",
            "summary": f"本章小结：{['索引的选择性如何影响查询', 'B+ 树叶节点与页分裂', '聚簇索引与二级索引的差别',
                                       '回表代价与覆盖索引的收益', 'EXPLAIN 各列的含义', '优化器如何估算代价',
                                       '哪些写法会让索引失效', '一次真实的慢查询调优'][c]}。",
        })
    mindmap_md = "\n".join([
        "# 索引与执行计划（夹具合成思维导图）",
        "## 一、索引基础 (00:00:00)",
        "- 选择性与基数",
        "- 最左前缀",
        "## 二、B+ 树结构 (00:07:30)",
        "- 叶节点与页分裂",
        "- 三层树能存多少行",
        "## 三、聚簇与二级索引 (00:15:00)",
        "- 聚簇索引即数据",
        "- 二级索引回表",
        "## 四、覆盖索引 (00:22:30)",
        "- 回表代价",
        "- 索引下推",
        "## 五、EXPLAIN (00:30:00)",
        "- type / key / rows / filtered",
        "- Extra 里的 Using index",
        "## 六、索引失效 (00:45:00)",
        "- 函数包列",
        "- 隐式类型转换",
        "## 七、调优实战 (00:52:30)",
        "- 慢查询定位",
        "- 改写 SQL",
    ])
    slides = [{
        "index": i + 1,
        "at_ms": 30_000 + i * 260_000,
        "image": f"/api/v1/documents/{DOC_VIDEO}/video/slides/{i + 1}/image",
        "ocr_text": f"第 {i + 1} 帧 OCR 文本（夹具）：索引结构与执行计划要点",
        "title": f"幻灯片 {i + 1}",
    } for i in range(12)]

    return {
        "documents": [
            {"id": DOC_PDF, "title": "MySQL 26.7 Reference Manual（上游真实产物 · 测试夹具）", "kind": "pdf",
             "source_path": f"data/uploads/{DOC_PDF}/original.pdf", "size_bytes": 44160000,
             "page_count": 6392, "lang": "en", "status": "ready",
             "meta": {"toc_entries": 2545, "chapters": 42},
             "created_at": 1760400000000, "updated_at": 1760400000000},
            {"id": DOC_VIDEO, "title": "第 5 讲 索引与执行计划（合成夹具数据）", "kind": "video",
             "source_path": f"data/uploads/{DOC_VIDEO}/original.mp4", "size_bytes": 1024 * 1024,
             "page_count": 0, "lang": "zh", "status": "ready", "meta": {"fixture": True},
             "created_at": 1760400000000, "updated_at": 1760400000000},
        ],
        "units": units, "outline_nodes": outline_nodes, "roots": roots,
        "cards": cards, "xrefs": xrefs, "graph": {"nodes": g_nodes, "edges": g_edges},
        "video": {
            "id": "vid_0001", "doc_id": DOC_VIDEO, "duration_ms": DUR,
            "asr_model": "faster-whisper/base", "asr_lang": "zh",
            "segments": segs,
            "subtitles": {"srt": f"data/artifacts/vid_0001/subtitle.srt",
                          "vtt": f"data/artifacts/vid_0001/subtitle.vtt"},
            "transcript": chapters,
            "mindmap": {"format": "markmap", "content": mindmap_md},
            "slides": slides,
            "summary": "（夹具合成全文总结）本讲围绕索引的选择性、B+ 树结构、回表代价与 EXPLAIN 解读展开，"
                       "给出索引失效的典型写法与一次慢查询调优的完整过程。",
        },
        "meta": {
            "units": len(outline_nodes), "cards": len(cards), "roots": len(roots),
            "graph_nodes": len(g_nodes), "graph_edges": len(g_edges), "flagged_edges": flagged_n,
            "xrefs": {"total": len(xrefs), "typed": typed_n, "mention": mention_n,
                      "also_in": also_n, "same_unit": same_n, "cross_unit_mention": cross_unit_mention},
            "wiki_unit": WIKI_UNIT, "wiki_unit_cards": WIKI_UNIT_CARDS, "wiki_unit_title": WIKI_UNIT_TITLE,
            "unit_with_entities": max(
                units.items(), key=lambda kv: len(kv[1].get("entities", []))
            )[0] if units else None,
            "video": {"segments": seg_n, "chapters": len(chapters), "slides": len(slides)},
            "doc_pdf": DOC_PDF, "doc_video": DOC_VIDEO,
        },
    }


_FIXTURE = None
_FIX_LOCK = threading.Lock()


def fixture() -> dict:
    global _FIXTURE
    with _FIX_LOCK:
        if _FIXTURE is None:
            _FIXTURE = build_fixture()
        return _FIXTURE


# ---------------------------------------------------------------- HTTP 服务

MEDIA_WAV_CACHE = {}


def silent_wav(seconds=60, rate=8000) -> bytes:
    """生成静音 WAV —— 让 <video> 在无头环境里也能 loadedmetadata / 可 seek。
    仅测试夹具使用；真实视频由 T2 的视频管线产出。"""
    key = (seconds, rate)
    if key in MEDIA_WAV_CACHE:
        return MEDIA_WAV_CACHE[key]
    import io
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * (rate * seconds))
    data = buf.getvalue()
    MEDIA_WAV_CACHE[key] = data
    return data


PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082"
)

# 最小合法 PDF（供「原文跳转」链路的下载响应，不追求内容）
MINIMAL_PDF = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
               b"2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n"
               b"trailer<</Root 1 0 R>>\n%%EOF\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "course-kb-fixture/1.0"
    fix: dict = None
    degraded: bool = False

    def log_message(self, fmt, *args):        # 静默（测试输出干净）
        pass

    # ---- 工具 ----
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True       # Chrome 关页面时会掐断连接（正常现象）

    def _error(self, status, code, msg, hint=""):
        self._json({"error": {"code": code, "msg": msg, "detail": "", "hint": hint}}, status)

    def _bytes(self, data: bytes, ctype: str, status=200, extra=None):
        try:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Accept-Ranges", "bytes")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True

    def _range_bytes(self, data: bytes, ctype: str):
        rng = self.headers.get("Range")
        if not rng or not rng.startswith("bytes="):
            self._bytes(data, ctype)
            return
        spec = rng[len("bytes="):].split(",")[0].strip()
        a, _, b = spec.partition("-")
        try:
            start = int(a) if a else 0
            end = int(b) if b else len(data) - 1
        except ValueError:
            self._bytes(data, ctype)
            return
        start = max(0, min(start, len(data) - 1))
        end = max(start, min(end, len(data) - 1))
        chunk = data[start:end + 1]
        try:
            self.send_response(206)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(chunk)))
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True

    # ---- 路由 ----
    def do_GET(self):
        u = urlparse(self.path)
        path, q = u.path, parse_qs(u.query)
        F = self.fix
        reqlog = CFG.setdefault("reqlog", [])
        reqlog.append(f"GET {path}")
        if len(reqlog) > 200:
            del reqlog[:-200]
        try:
            if path.startswith("/api/v1/"):
                return self.api(path, q)
            return self.static(path)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True
        except Exception as e:                # 夹具自身出错要显式暴露，不要静默 500
            self._error(500, "E_FIXTURE", f"fixture error: {e}")

    def do_POST(self):
        u = urlparse(self.path)
        if u.path.endswith("/video/reparse"):
            doc = u.path.split("/")[4]
            if self.degraded:
                return self._error(503, "E_ASR_LOAD", "faster-whisper 模型加载失败（degraded 夹具）", "可改用 tiny 模型")
            if not any(d["id"] == doc for d in self.fix["documents"]):
                return self._error(404, "E_NOTFOUND", "document not found")
            return self._json({"task_id": "tsk_fixture0001", "status": "queued"})
        return self._error(404, "E_NOTFOUND", "no such endpoint")

    def static(self, path):
        rel = path.lstrip("/") or "index.html"
        target = (WEB / rel).resolve()
        if not str(target).startswith(str(WEB.resolve())) or not target.is_file():
            return self._error(404, "E_NOTFOUND", f"static not found: {rel}")
        ctype = {
            ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
            ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
        }.get(target.suffix, "application/octet-stream")
        data = target.read_bytes()
        return self._bytes(data, ctype)

    def api(self, path, q):
        F = self.fix
        p = path[len("/api/v1"):]
        one = lambda k, d=None: (q.get(k) or [d])[0]

        if p == "/health":
            return self._json({"ok": True, "version": "1.0.0-fixture"})

        if p == "/capabilities":
            if self.degraded:
                return self._json({
                    "adapters": ["text"],
                    "asr": {"available": False, "engine": "faster-whisper", "models": [],
                            "device": "cpu", "reason": "faster-whisper 未安装（pip install faster-whisper 后可用）"},
                    "llm": {"configured": False, "model": "", "reason": "未配置 LLM API 凭据"},
                    "pi": {"available": False, "reason": "pi 未构建且未全局安装"},
                    "ffmpeg": {"available": False, "reason": "ffmpeg not found on PATH"},
                })
            return self._json({
                "adapters": ["pdf", "pptx", "docx", "text", "video"],
                "asr": {"available": True, "engine": "faster-whisper", "models": ["tiny", "base", "small"], "device": "cpu"},
                "llm": {"configured": True, "model": "deepseek-v4.1-flash"},
                "pi": {"available": True, "version": "1.2.0", "mode": "rpc"},
                "ffmpeg": {"available": True, "version": "N-124868"},
            })

        if p == "/_fixture/meta":
            return self._json({"degraded": self.degraded, "meta": F["meta"]})

        # ---- 无头同步屏障：/hold 扣住请求直到 /release（或超时） ----
        # 用途：让 Chrome 的 load 事件等到页面把异步数据渲染完，从而**不需要**
        # --virtual-time-budget（虚拟时钟下 performance.now() 恒为 0，性能数字是假的）。
        if p == "/_fixture/hold":
            deadline = time.time() + HOLD_TIMEOUT_S
            while not RELEASE.is_set() and time.time() < deadline:
                time.sleep(0.02)
            RELEASE.clear()
            return self._bytes(PNG_1PX, "image/png")
        if p == "/_fixture/release":
            RELEASE.set()
            return self._json({"released": True})

        if p == "/_fixture/config":
            for k in CFG:
                if k in q:
                    CFG[k] = one(k) in ("1", "true", "yes")
            return self._json({"config": dict(CFG)})

        if p == "/documents":
            docs = F["documents"]
            kind = one("kind")
            if kind:
                docs = [d for d in docs if d["kind"] == kind]
            return self._json({"items": docs, "total": len(docs), "offset": int(one("offset", 0)),
                               "limit": int(one("limit", 50))})

        m = re.match(r"^/documents/([^/]+)(?:/(.*))?$", p)
        if m:
            doc_id, rest = m.group(1), (m.group(2) or "")
            doc = next((d for d in F["documents"] if d["id"] == doc_id), None)
            if not doc:
                return self._error(404, "E_NOTFOUND", f"document {doc_id}")
            if rest == "":
                return self._json(doc)
            if doc_id == DOC_VIDEO:
                if rest == "video":
                    v = dict(F["video"])
                    if self.degraded:
                        # degraded 夹具：视频已上传但 ASR 不可用 → 没有任何转写产物。
                        # 这正是 F6 坑 10 要测的场景：入口必须禁用 + 说明原因 + 不编造内容。
                        v = dict(v)
                        v.update({"asr_model": "", "segments": [], "transcript": [],
                                  "mindmap": {"format": "", "content": ""}, "slides": [], "summary": ""})
                    return self._json(v)
                if rest == "video/transcript":
                    items = [] if self.degraded else F["video"]["transcript"]
                    return self._json({"items": items, "total": len(items)})
                if rest == "video/mindmap":
                    return self._json({"format": "", "content": ""} if self.degraded else F["video"]["mindmap"])
                if rest == "video/slides":
                    items = [] if self.degraded else F["video"]["slides"]
                    return self._json({"items": items, "total": len(items)})
                if rest.startswith("video/slides/") and rest.endswith("/image"):
                    return self._bytes(PNG_1PX, "image/png")
                if rest.startswith("video/subtitle"):
                    fmt = one("fmt", "vtt")
                    lines = ["WEBVTT", ""] if fmt == "vtt" else []
                    for s in F["video"]["segments"][:200]:
                        a = _ts(s["start"]); b = _ts(s["end"])
                        if fmt == "vtt":
                            lines += [f"{a} --> {b}", s["text"], ""]
                        else:
                            lines += [f"{len(lines) + 1}", f"{a.replace('.', ',')} --> {b.replace('.', ',')}",
                                      s["text"], ""]
                    ctype = "text/vtt; charset=utf-8" if fmt == "vtt" else "application/x-subrip; charset=utf-8"
                    return self._bytes("\n".join(lines).encode("utf-8"), ctype)
                if rest == "stream":
                    return self._range_bytes(silent_wav(60), "audio/wav")
                if rest == "file":
                    return self._bytes(silent_wav(60), "audio/wav")
            if rest == "outline":
                return self._json({"document_id": doc_id, "roots": F["roots"], "nodes": F["outline_nodes"]})
            if rest == "units":
                items = list(F["units"].values())
                return self._json({"items": items, "total": len(items)})
            if rest == "cards":
                off = int(one("offset", 0)); lim = int(one("limit", 50))
                return self._json({"items": F["cards"][off:off + lim], "total": len(F["cards"]),
                                   "offset": off, "limit": lim})
            if rest == "graph":
                nodes = F["graph"]["nodes"]
                if CFG.get("strip_unit_ids"):
                    nodes = [{k: v for k, v in n.items() if k != "unit_ids"} for n in nodes]
                return self._json({"document_id": doc_id, "nodes": nodes, "edges": F["graph"]["edges"],
                                   "stats": {"nodes": len(nodes),
                                             "edges": len(F["graph"]["edges"]), "types": 12,
                                             "verify_rate": 0.9501}})
            if rest == "xrefs":
                return self._json({"items": F["xrefs"], "total": len(F["xrefs"])})
            if rest == "file":
                return self._bytes(MINIMAL_PDF, "application/pdf")

        m = re.match(r"^/cards/([^/]+)(?:/(.*))?$", p)
        if m:
            cid, rest = m.group(1), (m.group(2) or "")
            card = next((c for c in F["cards"] if c["id"] == cid), None)
            if not card:
                return self._error(404, "E_NOTFOUND", f"card {cid}")
            out = [{"id": x["to_card_id"], "name": _card_name(F, x["to_card_id"]), "rel": x["rel"]}
                   for x in F["xrefs"] if x["from_card_id"] == cid]
            back = [{"id": x["from_card_id"], "name": _card_name(F, x["from_card_id"]), "rel": x["rel"]}
                    for x in F["xrefs"] if x["to_card_id"] == cid]
            unit = F["units"].get(card["unit_id"])
            if rest == "xrefs":
                return self._json({"items": out, "total": len(out)})
            if rest == "backlinks":
                return self._json({"items": back, "total": len(back)})
            return self._json({
                "card": card,
                "unit": {"id": card["unit_id"], "title": (unit or {}).get("title", "")},
                "source": {"kind": "pdf", "file": f"{DOC_PDF}/original.pdf",
                           "page": card["evidence_span"]["start"],
                           "url": f"/api/v1/documents/{DOC_PDF}/file#page={card['evidence_span']['start']}"},
                "xrefs": out, "backlinks": back,
            })

        if p == "/search":
            qq = (one("q") or "").strip().lower()
            doc_id = one("doc_id")
            hits = []
            if doc_id == DOC_VIDEO or doc_id is None:
                for s in F["video"]["segments"][:5]:
                    if qq and qq in s["text"].lower():
                        hits.append({"kind": "unit", "ref_id": f"{DOC_VIDEO}#{s['i']}", "title": s["text"][:24],
                                     "snippet": s["text"], "score": 3.0, "doc_id": DOC_VIDEO})
            if doc_id == DOC_PDF or doc_id is None:
                for c in F["cards"]:
                    blob = f"{c['name']} {c['one_line']} {c['purpose']}".lower()
                    if qq and qq in blob:
                        hits.append({"kind": "card", "ref_id": c["id"], "title": c["name"],
                                     "snippet": f"…{c['one_line'][:60]}…", "score": 8.2, "doc_id": DOC_PDF})
            return self._json({"q": one("q") or "", "total": len(hits), "hits": hits[:20]})

        if p == "/search/suggest":
            return self._json({"q": one("q") or "", "suggestions": [c["name"] for c in F["cards"][:10]]})

        m = re.match(r"^/tasks/([^/]+)(?:/(.*))?$", p)
        if m:
            task_id, rest = m.group(1), (m.group(2) or "")
            CFG["last_task_route"] = f"{task_id}/{rest}"
            CFG["task_hits"] = int(CFG.get("task_hits", 0)) + 1
            if rest == "":
                return self._json({"id": task_id, "doc_id": DOC_VIDEO, "kind": "asr", "status": "running",
                                   "progress": 0.5, "stage": "转写中", "detail": {}, "error": None,
                                   "created_at": 1760400000000, "finished_at": None})
            if rest == "events":
                # 契约 §6：单行 JSON data + keepalive 注释帧 + done 后主动关闭。
                # 必须用 chunked（uvicorn 的 StreamingResponse 也是 chunked）：
                # 曾用「HTTP/1.1 + Connection: close 无长度」的裸流，Chrome 的 EventSource
                # 直接 error(state=CLOSED)，一个帧都收不到（实测）。
                frames = [
                    'event: progress\ndata: ' + json.dumps(
                        {"task_id": task_id, "progress": 0.42, "stage": "转写音频", "done": 42, "total": 100},
                        ensure_ascii=False) + '\n\n',
                    ': keepalive\n\n',
                    'event: log\ndata: ' + json.dumps(
                        {"task_id": task_id, "level": "info", "msg": "夹具：分章与思维导图"}, ensure_ascii=False) + '\n\n',
                    'event: done\ndata: ' + json.dumps(
                        {"task_id": task_id, "status": "done", "elapsed_ms": 1200}, ensure_ascii=False) + '\n\n',
                ]
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    for i, fr in enumerate(frames):
                        raw = fr.encode("utf-8")
                        self.wfile.write(f"{len(raw):X}\r\n".encode("ascii") + raw + b"\r\n")
                        self.wfile.flush()
                        if i == 0:
                            time.sleep(0.4)
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass
                self.close_connection = True
                return

        return self._error(404, "E_NOTFOUND", f"no route: {p}")


def _ts(ms: int) -> str:
    s, msec = divmod(int(ms), 1000)
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{sec:02d}.{msec:03d}"


def _card_name(F, cid):
    for c in F["cards"]:
        if c["id"] == cid:
            return c["name"]
    return cid


class Server:
    def __init__(self, degraded=False):
        self.degraded = degraded
        RELEASE.clear()
        handler = type("H", (Handler,), {"fix": fixture(), "degraded": degraded})
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"

    def stop(self):
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:
            pass


_SERVERS = []


def serve(degraded=False) -> Server:
    s = Server(degraded=degraded)
    _SERVERS.append(s)
    return s


def _stop_all():
    while _SERVERS:
        _SERVERS.pop().stop()


# ---------------------------------------------------------------- Chrome

_CHROME = None
_PROFILE = None


def chrome() -> str:
    global _CHROME
    if _CHROME is None:
        _CHROME = chrome_path()
        if not _CHROME:
            pytest.skip("未找到 Chrome（headless DOM 断言需要它）")
    return _CHROME


def profile_dir() -> str:
    global _PROFILE
    if _PROFILE is None:
        _PROFILE = tempfile.mkdtemp(prefix="coursekb-chrome-")
    return _PROFILE


def dump_dom(url: str, virtual_time_budget=None, timeout=240, extra_args=None, barrier=True) -> str:
    """headless Chrome --dump-dom，取页面把 API 数据渲染完之后的 DOM。

    两种同步方式：
      barrier=True（默认）—— 页面注入挂起的 <img>（/api/v1/_fixture/hold），load 事件被推迟；
                            页面干完活调 /release → dump。**真实时间**，性能数字可信。
      virtual_time_budget=N —— 无屏障时的兜底：虚拟时钟快进（但 performance.now() 会失真）。
    """
    exe = chrome()
    if barrier:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}barrier=/api/v1/_fixture/hold"
    cmd = [
        exe, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        "--disable-extensions", "--disable-background-networking", "--mute-audio",
        "--autoplay-policy=no-user-gesture-required",
        "--allow-file-access-from-files",          # 用户指定的参数（file:// 场景兜底）
        "--user-data-dir=" + profile_dir(),
    ]
    if not barrier and virtual_time_budget:
        cmd.append(f"--virtual-time-budget={virtual_time_budget}")
    cmd += ["--dump-dom", url]
    if extra_args:
        cmd[1:1] = list(extra_args)
    p = subprocess.run(cmd, capture_output=True, timeout=timeout)
    out = p.stdout.decode("utf-8", errors="replace")
    if not out.strip():
        err = p.stderr.decode("utf-8", errors="replace")[-2000:]
        raise AssertionError(f"chrome 没有输出 DOM（exit={p.returncode}）\nstderr:\n{err}")
    return out


# ---------------------------------------------------------------- DOM 助手

def jsonscript(dom: str, el_id: str):
    """取 <script type="application/json" id=...> 里的 JSON（headless 下 canvas 断言不了 → 把结果落 DOM）。"""
    m = re.search(
        rf'<script[^>]*id="{re.escape(el_id)}"[^>]*>(.*?)</script>', dom, re.S | re.I)
    if not m:
        return None
    raw = html.unescape(m.group(1)).strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise AssertionError(f"#{el_id} 不是合法 JSON: {e}\n前 300 字：{raw[:300]}")


def tag_attrs(dom: str, el_id: str) -> dict:
    """取 id 所在开始标签的属性（属性顺序不限）。"""
    m = re.search(rf'<([a-zA-Z0-9]+)([^>]*\bid="{re.escape(el_id)}"[^>]*)>', dom)
    if not m:
        return {}
    attrs = {}
    for am in re.finditer(r'([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?', m.group(2)):
        attrs[am.group(1)] = am.group(2) if am.group(2) is not None else ""
    return attrs


def element_json(dom: str, el_id: str):
    """取任意元素的文本并当 JSON 解析（#v-seeklog 这类用 <div> 记录的报告）。"""
    txt = text_of(dom, el_id)
    if not txt:
        return None
    try:
        return json.loads(txt)
    except json.JSONDecodeError:
        return None


def class_of(dom: str, el_id: str) -> str:
    return tag_attrs(dom, el_id).get("class", "")


def count(dom: str, pattern: str) -> int:
    return len(re.findall(pattern, dom))


def has(dom: str, pattern: str) -> bool:
    return re.search(pattern, dom) is not None


def text_of(dom: str, el_id: str) -> str:
    """朴素取文本：找 id 元素，按同名标签配平到闭合标签。"""
    m = re.search(rf'<([a-zA-Z0-9]+)[^>]*\bid="{re.escape(el_id)}"[^>]*>', dom)
    if not m:
        return ""
    tag = m.group(1)
    body = dom[m.end():]
    depth = 1
    for mm in re.finditer(rf'</?{tag}\b[^>]*>', body):
        if mm.group(0).startswith("</"):
            depth -= 1
            if depth == 0:
                seg = body[:mm.start()]
                seg = re.sub(r"<[^>]+>", "", seg)
                return html.unescape(seg).strip()
        else:
            depth += 1
    return ""


def strip_tags(dom: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", " ", dom))


# ---------------------------------------------------------------- pytest fixtures

@pytest.fixture(scope="session")
def web_server():
    s = serve(degraded=False)
    yield s
    _stop_all()


@pytest.fixture(scope="session")
def degraded_server():
    return serve(degraded=True)


@pytest.fixture(scope="session")
def meta(web_server):
    return fixture()["meta"]
