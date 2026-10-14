"""把上游**已验证产物**导入本工程的库（契约 C3/C4；Lead 已批准的做法）。

上游（``../数据库课程智能体调研/``）有一批**真实抽取、带证据链**的产物：

| 文件 | 内容 |
|---|---|
| ``data/refman_v2/_ckpt_v2.json`` | 30 节 / **360 张知识卡片**（v2 schema） |
| ``data/refman_extract/graph_view.json`` | **1644 节点 / 481 边**（带 evidence + pages） |

本机当时**没有可用 LLM 额度**（402 insufficient_balance），所以 M2 的
「卡片 / 图谱 / 引用」用这批产物做**真实导入验证**，并在
``documents.meta_json`` 里**如实标注来源**：

```json
{"import_source": "upstream_frozen",
 "from": {"cards": "_ckpt_v2.json", "graph": "graph_view.json"},
 "llm": "none（导入的是上游已抽取产物，不是本次 LLM 实跑）"}
```

## 幂等（Lead 要求 ①）

* 文档 ID：``doc_`` + ``sha1(source_path)`` 前 12 位 → 重复导入命中同一文档；
* 卡片/实体/边 ID：由内容指纹派生（``sha1(doc|name_key|unit)`` 等）→
  ``INSERT ... ON CONFLICT DO UPDATE``，重复导入**不产生重复行**。

用法：

```powershell
python -m server.store.import_upstream --list
python -m server.store.import_upstream --doc-id doc_xxx --cards <_ckpt_v2.json> --graph <graph_view.json>
python -m server.store.import_upstream --new-doc --title "MySQL 26.7 Reference Manual" \
       --source ../refman-26.7-en.a4.pdf --cards ... --graph ...
```
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

from server.config import get_settings
from server.models import (
    Card,
    Document,
    Edge,
    Entity,
    Span,
    Unit,
    id_for,
    name_key,
    now_ms,
)
from server.models.schema_enums import entity_types
from server.store.db import open_db
from server.store.repo import Repo

log = logging.getLogger(__name__)

#: 上游资产默认位置（相对 course-kb/）
UPSTREAM_ROOT = Path(__file__).resolve().parents[2].parent / "数据库课程智能体调研"
DEFAULT_CARDS = UPSTREAM_ROOT / "data" / "refman_v2" / "_ckpt_v2.json"
DEFAULT_GRAPH = UPSTREAM_ROOT / "data" / "refman_extract" / "graph_view.json"


def stable_id(prefix: str, *parts: Any) -> str:
    """内容指纹 ID（幂等的关键）。"""
    h = hashlib.sha1("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()
    return f"{prefix}_{h[:12]}"


def doc_id_for(source_path: str) -> str:
    return stable_id("doc", Path(source_path).as_posix())


@dataclass
class ImportStats:
    doc_id: str = ""
    sections: int = 0
    cards: int = 0
    cards_skipped: int = 0
    cards_unmapped: int = 0
    entities: int = 0
    entities_skipped: int = 0
    edges: int = 0
    edges_skipped: int = 0
    fallback_units: int = 0
    xrefs: int = 0
    index_rows: int = 0
    source_files: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


# ═══════════════════════════════════════════════════════════════════════
# 单元定位
# ═══════════════════════════════════════════════════════════════════════
def load_units(repo: Repo, doc_id: str) -> tuple[list[Unit], dict[str | None, list[Unit]]]:
    units = repo.all_units(doc_id)
    children: dict[str | None, list[Unit]] = {}
    for u in units:
        children.setdefault(u.parent_id, []).append(u)
    return units, children


def deepest_unit_for_page(units: Sequence[Unit], page: int) -> Unit | None:
    """找**最深的**包含该页的 unit（深度优先；同深度取 span 最小者）。"""
    best: Unit | None = None
    best_key: tuple[int, int] | None = None
    for u in units:
        if u.span.kind != "page":
            continue
        if u.span.start <= page <= u.span.end:
            key = (u.level, -(u.span.end - u.span.start))
            if best_key is None or key > best_key:
                best, best_key = u, key
    return best


def ensure_unit_for_span(
    repo: Repo, doc_id: str, *, page: int, title: str, fallback: list[Unit]
) -> Unit:
    """卡片找不到归属 unit 时，生成一个**诚实的兜底单元**（不静默丢卡片）。"""
    uid = stable_id("unt", doc_id, "fallback", page)
    existing = repo.get_unit(uid)
    if existing:
        return existing
    unit = Unit(
        id=uid,
        doc_id=doc_id,
        ord=repo.unit_count(doc_id) + 1,
        title=f"{title}（p.{page} 兜底，上游产物未落在本次单元内）",
        level=1,
        parent_id=None,
        span=Span("page", page, page),
        text="",
    )
    repo.insert_units([unit])
    fallback.append(unit)
    return unit


# ═══════════════════════════════════════════════════════════════════════
# 导入卡片
# ═══════════════════════════════════════════════════════════════════════
def import_cards(
    repo: Repo,
    doc_id: str,
    ckpt_path: str | Path,
    *,
    fallback_units: list[Unit] | None = None,
) -> ImportStats:
    """导入 ``_ckpt_v2.json``（结构：``{"sections": [{"_meta":…, "cards":[…]}…]}``）。"""
    stats = ImportStats(doc_id=doc_id)
    p = Path(ckpt_path)
    if not p.exists():
        raise FileNotFoundError(f"找不到上游卡片文件：{p}")
    stats.source_files["cards"] = p.name
    raw = json.loads(p.read_text(encoding="utf-8"))
    sections = raw.get("sections") or []
    stats.sections = len(sections)
    units = repo.all_units(doc_id)
    fallback = fallback_units if fallback_units is not None else []

    # 预计算：每个一级单元的页码区间（用于解析 section 的章节路径）
    by_page = sorted(
        [u for u in units if u.span.kind == "page"], key=lambda u: (u.span.start, -u.level)
    )

    cards: list[Card] = []
    for si, sec in enumerate(sections):
        meta = sec.get("_meta") or {}
        pg = int(meta.get("pg") or 0)
        end = int(meta.get("end") or pg)
        path = str(meta.get("path") or sections[si].get("section", {}).get("title") or "")
        unit: Unit | None = None
        if pg:
            unit = deepest_unit_for_page(units, pg)
            # ⚠️ 落不到任何 unit 时**生成兜底单元**，而不是挂到"页码最近的"那个 unit：
            #    曾经打算这么干，但那会把 p.32 的卡片塞进"封面 p.1–5"，
            #    读者点开看到的是错的原文位置 —— 宁可多一个诚实的兜底单元。
        if unit is None:
            unit = ensure_unit_for_span(
                repo, doc_id, page=pg or 1, title=path.split(" › ")[-1] or "上游小节", fallback=fallback
            )
        stats.fallback_units = len(fallback)
        for rc in sec.get("cards") or []:
            name = str(rc.get("name") or "").strip()
            kind = rc.get("kind") or "other"
            if not name:
                stats.cards_skipped += 1
                continue
            page = int(rc.get("evidence_page") or pg or 1)
            span = Span("page", max(1, page), max(1, page))
            cid = stable_id("crd", doc_id, name_key(name), unit.id)
            try:
                cards.append(
                    Card(
                        id=cid,
                        doc_id=doc_id,
                        unit_id=unit.id,
                        name=name,
                        kind=kind,
                        one_line=rc.get("one_line") or "",
                        purpose=rc.get("purpose") or "",
                        usage_mode=rc.get("usage_mode") or "unknown",
                        operational_role=rc.get("operational_role") or "unknown",
                        lifecycle=rc.get("lifecycle") or "unknown",
                        example=rc.get("example"),
                        example_explained=rc.get("example_explained"),
                        prerequisites=rc.get("prerequisites") or [],
                        cautions=rc.get("cautions") or [],
                        evidence_quote=rc.get("evidence_quote") or "",
                        span=span,
                        confidence=rc.get("confidence") or 0.0,
                    )
                )
            except Exception as exc:  # noqa: BLE001
                stats.cards_skipped += 1
                log.warning("跳过非法卡片 %r：%s", name, exc)
    written = repo.upsert_cards(cards)
    stats.cards = written
    stats.cards_unmapped = 0
    return stats


# ═══════════════════════════════════════════════════════════════════════
# 导入图谱
# ═══════════════════════════════════════════════════════════════════════
def import_graph(
    repo: Repo, doc_id: str, graph_path: str | Path, *, merge_cards: bool = True
) -> ImportStats:
    """导入 ``graph_view.json``（``nodes[]`` + ``edges[]``）。"""
    stats = ImportStats(doc_id=doc_id)
    p = Path(graph_path)
    if not p.exists():
        raise FileNotFoundError(f"找不到上游图谱文件：{p}")
    stats.source_files["graph"] = p.name
    raw = json.loads(p.read_text(encoding="utf-8"))
    nodes = raw.get("nodes") or []
    edges = raw.get("edges") or []

    entities: list[Entity] = []
    for n in nodes:
        name = str(n.get("name") or n.get("id") or "").strip()
        etype = n.get("type") or "concept"
        if not name or etype not in entity_types():
            stats.entities_skipped += 1
            continue
        entities.append(
            Entity(
                id=stable_id("ent", doc_id, name_key(name)),
                doc_id=doc_id,
                name=name,
                name_zh=str(n.get("zh") or ""),
                layer="",  # 上游 graph_view 的 layer 在**边**上，不在节点上 → 留空不编
                type=etype,
            )
        )
    mapping = repo.upsert_entities(entities)
    stats.entities = len(mapping)

    # 上游边引用的是小写 id（= name.lower()），统一走 name_key 解析
    by_key = {name_key(e.name): e for e in entities}
    key_alias: dict[str, str] = {}
    for e in entities:
        key_alias[name_key(e.name)] = e.name_key
    cards_by_key: dict[str, list[Card]] = {}
    if merge_cards:
        for c in repo.all_cards(doc_id):
            cards_by_key.setdefault(c.name_key, []).append(c)

    out_edges: list[Edge] = []
    for e in edges:
        src_key = name_key(str(e.get("src") or ""))
        dst_key = name_key(str(e.get("dst") or ""))
        etype = e.get("etype")
        src = mapping.get(src_key)
        dst = mapping.get(dst_key)
        if not src or not dst or src == dst or etype not in _edge_enum():
            stats.edges_skipped += 1
            continue
        pages = e.get("pages") or []
        page = int(pages[0]) if pages else 0
        out_edges.append(
            Edge(
                id=stable_id("edg", doc_id, src, dst, etype),
                doc_id=doc_id,
                src_id=src,
                dst_id=dst,
                etype=etype,
                evidence_text=str(e.get("evidence") or ""),
                span=Span("page", max(1, page), max(1, page)) if page else Span("page", 1, 1),
                confidence=float(e.get("confidence") or 0.0),
                flagged=not bool(e.get("verified", True)),
            )
        )
    written = repo.upsert_edges(out_edges)
    repo.recompute_degrees(doc_id)
    stats.edges = written
    return stats


def _edge_enum() -> tuple[str, ...]:
    from server.models.schema_enums import edge_types

    return edge_types()


# ═══════════════════════════════════════════════════════════════════════
# 入口
# ═══════════════════════════════════════════════════════════════════════
def ensure_document(
    repo: Repo,
    *,
    source_path: str,
    title: str,
    kind: str = "pdf",
    page_count: int = 0,
    size_bytes: int = 0,
    meta: dict[str, Any] | None = None,
) -> Document:
    """按 source_path 指纹取文档，不存在则建（幂等）。"""
    did = doc_id_for(source_path)
    existing = repo.get_document(did)
    if existing:
        return existing
    doc = Document(
        id=did,
        title=title,
        kind=kind,
        source_path=source_path,
        size_bytes=size_bytes,
        page_count=page_count,
        status="ready",
        meta=meta or {},
    )
    repo.create_document(doc)
    return doc


def run_import(
    repo: Repo,
    *,
    doc_id: str | None = None,
    source_path: str | None = None,
    title: str = "MySQL 26.7 Reference Manual",
    cards_path: str | Path | None = None,
    graph_path: str | Path | None = None,
    rebuild_xrefs: bool = True,
    rebuild_index: bool = True,
) -> ImportStats:
    """一个函数跑完全部导入（幂等，可反复执行）。"""
    if doc_id is None:
        if not source_path:
            raise ValueError("必须给 doc_id 或 source_path")
        doc = ensure_document(
            repo,
            source_path=source_path,
            title=title,
            meta={
                "import_source": "upstream_frozen",
                "from": {
                    "cards": Path(cards_path).name if cards_path else "",
                    "graph": Path(graph_path).name if graph_path else "",
                },
                "llm": "none（导入上游已抽取产物，不是本次 LLM 实跑）",
                "imported_at": now_ms(),
            },
        )
        doc_id = doc.id
    else:
        doc = repo.get_document(doc_id)
        if doc is None:
            raise FileNotFoundError(f"文档不存在：{doc_id}")
        meta = dict(doc.meta or {})
        meta.setdefault("import_source", "upstream_frozen")
        meta.setdefault("llm", "none（导入上游已抽取产物，不是本次 LLM 实跑）")
        meta.setdefault(
            "from",
            {
                "cards": Path(cards_path).name if cards_path else "",
                "graph": Path(graph_path).name if graph_path else "",
            },
        )
        repo.update_document(doc_id, meta=meta)

    stats = ImportStats(doc_id=doc_id)
    if cards_path:
        s = import_cards(repo, doc_id, cards_path)
        stats.sections = s.sections
        stats.cards = s.cards
        stats.cards_skipped = s.cards_skipped
        stats.fallback_units = s.fallback_units
        stats.source_files["cards"] = s.source_files.get("cards", "")
    if graph_path:
        g = import_graph(repo, doc_id, graph_path)
        stats.entities = g.entities
        stats.entities_skipped = g.entities_skipped
        stats.edges = g.edges
        stats.edges_skipped = g.edges_skipped
        stats.source_files["graph"] = g.source_files.get("graph", "")

    if rebuild_xrefs:
        from server.pipeline.xref import apply_xrefs

        n, _ = apply_xrefs(repo, doc_id)
        stats.xrefs = n
    if rebuild_index:
        from server.pipeline.search import index_document

        rows = index_document(repo, doc_id)
        stats.index_rows = int(rows.get("rows", 0))

    doc = repo.get_document(doc_id)
    if doc:
        meta = dict(doc.meta or {})
        meta["import_stats"] = stats.to_dict()
        meta["counts"] = repo.counts(doc_id).to_dict()
        repo.update_document(doc_id, meta=meta, status="ready")
    return stats


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="导入上游已验证产物（幂等）")
    ap.add_argument("--db", default=None, help="SQLite 路径（默认用 config 的 data/course_kb.sqlite3）")
    ap.add_argument("--doc-id", default=None)
    ap.add_argument("--source", default=str(UPSTREAM_ROOT.parent / "refman-26.7-en.a4.pdf"))
    ap.add_argument("--title", default="MySQL 26.7 Reference Manual")
    ap.add_argument("--cards", default=str(DEFAULT_CARDS))
    ap.add_argument("--graph", default=str(DEFAULT_GRAPH))
    ap.add_argument("--no-xrefs", action="store_true")
    ap.add_argument("--no-index", action="store_true")
    ap.add_argument("--list", action="store_true", help="只列出上游资产是否存在")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    settings = get_settings()
    db_path = args.db or settings.db_path
    db = open_db(db_path)
    repo = Repo(db)

    if args.list:
        for label, p in (("cards", Path(args.cards)), ("graph", Path(args.graph))):
            print(f"{label}: {p} exists={p.exists()} size={p.stat().st_size if p.exists() else 0}")
        print("db:", db_path, "stats:", db.stats())
        return 0

    stats = run_import(
        repo,
        doc_id=args.doc_id,
        source_path=args.source,
        title=args.title,
        cards_path=args.cards or None,
        graph_path=args.graph or None,
        rebuild_xrefs=not args.no_xrefs,
        rebuild_index=not args.no_index,
    )
    print(json.dumps(stats.to_dict(), ensure_ascii=False, indent=1))
    print("库内规模：", json.dumps(db.stats(), ensure_ascii=False))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
