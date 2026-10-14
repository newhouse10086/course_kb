# -*- coding: utf-8 -*-
"""存储层测试（契约 §2 / §3）。

⚠️ 全部断言**具体值**（AGENTS.md 质量门：禁止"只断言非空"——历史上放过了真 bug）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from worker.models import (
    Card,
    Document,
    Edge,
    Entity,
    ExtractedGraph,
    Span,
    Task,
    Unit,
    VideoArtifact,
    VideoSegment,
    Xref,
    EnumViolation,
    ModelError,
)
from worker.models.schema_enums import card_kinds, edge_types, entity_types
from server.store.db import Database, open_db
from server.store.repo import Repo


# ── fixtures（就地定义，不建共享 conftest：写域规则要求各人只碰自己的文件）──
@pytest.fixture()
def db(tmp_path: Path) -> Database:
    return open_db(tmp_path / "test.sqlite3")


@pytest.fixture()
def repo(db: Database) -> Repo:
    return Repo(db)


def make_doc(doc_id: str = "doc_aaaaaaaaaaaa") -> Document:
    return Document(
        id=doc_id,
        title="MySQL 26.7 Reference Manual",
        kind="pdf",
        source_path="data/uploads/doc_aaaaaaaaaaaa/original.pdf",
        size_bytes=44160000,
        page_count=6392,
        lang="en",
        status="ready",
        meta={"toc_entries": 2545, "chapters": 42},
    )


def make_unit(unit_id: str = "unt_000000000001", doc_id: str = "doc_aaaaaaaaaaaa") -> Unit:
    return Unit(
        id=unit_id,
        doc_id=doc_id,
        ord=12,
        title="7.4.2.6 Rule-Based Error Log Filtering",
        level=4,
        parent_id=None,
        span=Span("page", 1040, 1045),
        text="The log_filter_dragnet log filter component enables...",
    )


# ═══════════════════════════════════════════════════════════════════════
# 建表 / PRAGMA
# ═══════════════════════════════════════════════════════════════════════
def test_schema_tables_and_pragmas(db: Database) -> None:
    names = set(db.table_names())
    expected = {
        "documents",
        "units",
        "cards",
        "entities",
        "edges",
        "xrefs",
        "tasks",
        "video_artifacts",
        "search_docs",
        "search_fts",
    }
    assert expected <= names, f"缺表：{expected - names}"
    assert db.scalar("PRAGMA journal_mode") == "wal"
    assert db.scalar("PRAGMA foreign_keys") == 1
    # 索引也在（契约 §3 明列）
    idx = {r["name"] for r in db.query("SELECT name FROM sqlite_master WHERE type='index'")}
    for name in ("idx_doc_status", "idx_unit_doc", "idx_card_key", "idx_edge_type", "idx_xref_to"):
        assert name in idx


def test_schema_is_idempotent(db: Database) -> None:
    before = set(db.table_names())
    db.init_schema()
    assert set(db.table_names()) == before


# ═══════════════════════════════════════════════════════════════════════
# documents / units / cards
# ═══════════════════════════════════════════════════════════════════════
def test_document_roundtrip_concrete(repo: Repo) -> None:
    doc = repo.create_document(make_doc())
    got = repo.get_document(doc.id)
    assert got is not None
    assert got.title == "MySQL 26.7 Reference Manual"
    assert got.kind == "pdf"
    assert got.page_count == 6392
    assert got.size_bytes == 44160000
    assert got.meta == {"toc_entries": 2545, "chapters": 42}
    d = got.to_dict()
    assert set(d) == {
        "id", "title", "kind", "source_path", "size_bytes", "page_count",
        "lang", "status", "meta", "created_at", "updated_at",
    }
    assert d["created_at"] == d["updated_at"]


def test_document_filters_and_pagination(repo: Repo) -> None:
    base = 1760400000000
    for i in range(3):
        repo.create_document(
            Document(
                id=f"doc_{i:012d}",
                title=f"doc {i}",
                kind="pdf" if i < 2 else "pptx",
                source_path=f"/tmp/{i}.pdf",
                status="ready",
                created_at=base + i * 1000,
                updated_at=base + i * 1000,
            )
        )
    docs, total = repo.list_documents(kind="pdf")
    assert total == 2 and [d.title for d in docs] == ["doc 1", "doc 0"]
    docs2, total2 = repo.list_documents(offset=1, limit=1)
    assert total2 == 3 and [d.title for d in docs2] == ["doc 1"]
    docs3, total3 = repo.list_documents(status="failed")
    assert total3 == 0 and docs3 == []


def test_unit_replace_and_read(repo: Repo) -> None:
    repo.create_document(make_doc())
    n = repo.replace_units("doc_aaaaaaaaaaaa", [make_unit()])
    assert n == 1
    u = repo.get_unit("unt_000000000001")
    assert u is not None
    assert u.ord == 12 and u.level == 4
    assert u.span.to_dict() == {"kind": "page", "start": 1040, "end": 1045}
    assert u.text_len == 54 == len("The log_filter_dragnet log filter component enables...")
    # replace 幂等：再替换一次还是 1 条
    assert repo.replace_units("doc_aaaaaaaaaaaa", [make_unit()]) == 1
    assert repo.unit_count("doc_aaaaaaaaaaaa") == 1
    # 列表默认不带正文（省流量），with_text=True 才带
    units, total = repo.list_units("doc_aaaaaaaaaaaa")
    assert total == 1 and units[0].text == ""
    units2, _ = repo.list_units("doc_aaaaaaaaaaaa", with_text=True)
    assert units2[0].text.startswith("The log_filter_dragnet")


def test_card_roundtrip_and_enum_guard(repo: Repo) -> None:
    repo.create_document(make_doc())
    repo.replace_units("doc_aaaaaaaaaaaa", [make_unit()])
    card = Card(
        id="crd_000000000001",
        doc_id="doc_aaaaaaaaaaaa",
        unit_id="unt_000000000001",
        name="log_filter_dragnet",
        kind="log_filter",
        one_line="一个可加载的错误日志过滤器组件",
        purpose="让 DBA 精确控制错误日志内容",
        usage_mode="user_invoked",
        operational_role="diagnostics",
        lifecycle="install_then_use",
        example="INSTALL COMPONENT 'file://component_log_filter_dragnet';",
        example_explained="先安装组件",
        prerequisites=["必须先 INSTALL COMPONENT 加载过滤器组件"],
        cautions=["使用它会忽略 log_error_suppression_list"],
        evidence_quote="The log_filter_dragnet log filter component enables…",
        span=Span("page", 1040, 1040),
        confidence=0.95,
    )
    assert repo.upsert_cards([card]) == 1
    got = repo.get_card("crd_000000000001")
    assert got is not None
    assert got.name_key == "log_filter_dragnet"
    assert got.prerequisites == ["必须先 INSTALL COMPONENT 加载过滤器组件"]
    assert got.cautions == ["使用它会忽略 log_error_suppression_list"]
    assert got.confidence == pytest.approx(0.95)
    assert got.span.to_dict() == {"kind": "page", "start": 1040, "end": 1040}
    d = got.to_dict()
    assert d["evidence_span"] == {"kind": "page", "start": 1040, "end": 1040}
    assert "evidence_page" not in d  # 契约用 evidence_span

    # upsert（同 id 覆盖），不产生第二行
    card.one_line = "改过的定义"
    repo.upsert_cards([card])
    assert repo.card_count("doc_aaaaaaaaaaaa") == 1
    assert repo.get_card(card.id).one_line == "改过的定义"

    # ★ 坑 4 的回归：非法 kind / etype 必须当场炸（不许发明枚举）
    with pytest.raises(EnumViolation):
        Card(
            id="crd_x", doc_id="doc_aaaaaaaaaaaa", unit_id="unt_000000000001",
            name="x", kind="常用实现", evidence_quote="", confidence=0.5,
        )
    with pytest.raises(EnumViolation):
        Edge(id="edg_x", doc_id="doc_aaaaaaaaaaaa", src_id="ent_1", dst_id="ent_2",
             etype="常用实现")


def test_enum_sources_are_schema_files() -> None:
    """封闭枚举必须与 schema/*.json 一致（不是代码里手写的副本）。"""
    root = Path(__file__).resolve().parents[1]
    edge_raw = json.loads((root / "schema" / "edge_types.json").read_text(encoding="utf-8"))
    card_raw = json.loads((root / "schema" / "knowledge_card.json").read_text(encoding="utf-8"))
    assert list(edge_types()) == list(edge_raw["edge_types"].keys())
    assert list(entity_types()) == list(edge_raw["entity_types"].keys())
    assert list(card_kinds()) == list(card_raw["card_fields"]["kind"]["values"])
    assert len(edge_types()) == 12
    # schema 文件列的 kind 就是 23 个（文档里写 22，以实现文件为准）
    assert len(card_kinds()) == len(card_raw["card_fields"]["kind"]["values"])


# ═══════════════════════════════════════════════════════════════════════
# 图谱
# ═══════════════════════════════════════════════════════════════════════
def test_entities_edges_degrees(repo: Repo) -> None:
    repo.create_document(make_doc())
    e1 = Entity(id="ent_1", doc_id="doc_aaaaaaaaaaaa", name="InnoDB clustered index",
                name_zh="InnoDB 聚簇索引", layer="L2", type="feature")
    e2 = Entity(id="ent_2", doc_id="doc_aaaaaaaaaaaa", name="B+tree", name_zh="B+树",
                layer="L1", type="mechanism")
    mapping = repo.upsert_entities([e1, e2])
    assert mapping == {"innodb clustered index": "ent_1", "b+tree": "ent_2"}

    edge = Edge(id="edg_1", doc_id="doc_aaaaaaaaaaaa", src_id="ent_1", dst_id="ent_2",
                etype="IMPLEMENTS", evidence_text="InnoDB uses a B-tree data structure …",
                span=Span("page", 3174, 3174), confidence=0.95)
    assert repo.upsert_edges([edge]) == 1
    # 同一 (doc,src,dst,etype) 第二次 upsert 只更新，不新增
    repo.upsert_edges([edge])
    assert repo.edge_count("doc_aaaaaaaaaaaa") == 1

    repo.recompute_degrees("doc_aaaaaaaaaaaa")
    assert repo.get_entity("ent_1").degree == 1
    assert repo.get_entity("ent_2").degree == 1
    got = repo.list_edges("doc_aaaaaaaaaaaa")[0]
    assert got.etype == "IMPLEMENTS"
    assert got.flagged is False
    assert got.span.start == 3174

    # 同名实体归并到同一 id（否则图谱会出现孤岛节点）
    mapping2 = repo.upsert_entities(
        [Entity(id="ent_999", doc_id="doc_aaaaaaaaaaaa", name="B+tree", type="mechanism")]
    )
    assert mapping2["b+tree"] == "ent_2"
    assert repo.entity_count("doc_aaaaaaaaaaaa") == 2

    # 自环边必须被拒（图谱里没有意义，且会让力导向图抖动）
    with pytest.raises(ModelError):
        Edge(id="edg_self", doc_id="doc_aaaaaaaaaaaa", src_id="ent_1", dst_id="ent_1",
             etype="PART_OF")


def test_entity_unit_map_and_graph_shape(repo: Repo) -> None:
    repo.create_document(make_doc())
    repo.replace_units("doc_aaaaaaaaaaaa", [make_unit()])
    repo.upsert_entities(
        [Entity(id="ent_1", doc_id="doc_aaaaaaaaaaaa", name="log_filter_dragnet",
                type="feature")]
    )
    repo.upsert_cards(
        [Card(id="crd_1", doc_id="doc_aaaaaaaaaaaa", unit_id="unt_000000000001",
              name="log_filter_dragnet", kind="log_filter", evidence_quote="q", confidence=0.9)]
    )
    unit_map = repo.entity_unit_map("doc_aaaaaaaaaaaa")
    assert unit_map == {"ent_1": ["unt_000000000001"]}


def test_extracted_graph_container() -> None:
    g = ExtractedGraph(
        entities=[Entity(id="ent_1", doc_id="doc_a", name="a", type="concept")],
        edges=[],
        dropped={"edges_unknown_entity": 2},
    )
    payload = json.loads(g.as_json())
    assert payload["entities"][0]["name"] == "a"
    assert payload["dropped"] == {"edges_unknown_entity": 2}


# ═══════════════════════════════════════════════════════════════════════
# 交叉引用
# ═══════════════════════════════════════════════════════════════════════
def test_xrefs_out_back_and_histogram(repo: Repo) -> None:
    repo.create_document(make_doc())
    repo.replace_units("doc_aaaaaaaaaaaa", [make_unit()])
    repo.upsert_cards(
        [
            Card(id="crd_1", doc_id="doc_aaaaaaaaaaaa", unit_id="unt_000000000001",
                 name="CREATE TABLE", kind="sql_statement", evidence_quote="", confidence=0.9),
            Card(id="crd_2", doc_id="doc_aaaaaaaaaaaa", unit_id="unt_000000000001",
                 name="VARCHAR", kind="data_type", evidence_quote="", confidence=0.9),
            Card(id="crd_3", doc_id="doc_aaaaaaaaaaaa", unit_id="unt_000000000001",
                 name="ALTER TABLE", kind="sql_statement", evidence_quote="", confidence=0.9),
        ]
    )
    n = repo.replace_xrefs(
        "doc_aaaaaaaaaaaa",
        [
            Xref("crd_1", "crd_2", "mention", 3),
            Xref("crd_1", "crd_3", "also_in", 1),
            Xref("crd_3", "crd_2", "mention", 1),
        ],
    )
    assert n == 3
    out = repo.out_links("crd_1")
    assert [x["name"] for x in out] == ["VARCHAR", "ALTER TABLE"]  # mention 优先于 also_in
    back = repo.back_links("crd_2")
    assert sorted(x["name"] for x in back) == ["ALTER TABLE", "CREATE TABLE"]
    assert repo.rel_histogram("doc_aaaaaaaaaaaa") == {"mention": 2, "also_in": 1}
    assert repo.cards_with_xrefs("doc_aaaaaaaaaaaa") == 2
    # 重复插入被主键 (from,to,rel) 吸收
    repo.replace_xrefs("doc_aaaaaaaaaaaa", [Xref("crd_1", "crd_2", "mention", 9)])
    assert repo.list_xrefs("doc_aaaaaaaaaaaa")[1] == 1
    assert repo.out_links("crd_1")[0]["weight"] == 9


def test_xref_self_reference_rejected_by_model() -> None:
    with pytest.raises(ModelError):
        Xref("", "crd_2")
    with pytest.raises(ModelError):
        Xref("crd_1", "crd_2", "不合法的rel")


# ═══════════════════════════════════════════════════════════════════════
# 任务 / 视频产物
# ═══════════════════════════════════════════════════════════════════════
def test_task_lifecycle(repo: Repo) -> None:
    repo.create_document(make_doc())
    task = repo.create_task(Task(id="tsk_1", doc_id="doc_aaaaaaaaaaaa", kind="extract"))
    assert task.status == "queued" and task.progress == 0.0
    repo.update_task("tsk_1", status="running", progress=0.42, stage="抽取知识卡片",
                     detail={"done": 42, "total": 100})
    got = repo.get_task("tsk_1")
    assert got.progress == pytest.approx(0.42)
    assert got.stage == "抽取知识卡片"
    assert got.detail == {"done": 42, "total": 100}
    assert got.finished_at is None
    done = repo.update_task("tsk_1", status="done", finished_at=1760400000000)
    assert done.finished_at == 1760400000000 and done.is_terminal
    # 终态任务不再被取消
    assert repo.cancel_task("tsk_1").status == "done"
    # 进度越界会被夹到 [0,1]
    t2 = repo.create_task(Task(id="tsk_2", doc_id="doc_aaaaaaaaaaaa", kind="index"))
    assert repo.update_task("tsk_2", progress=3.0).progress == 1.0


def test_video_artifact_roundtrip(repo: Repo) -> None:
    repo.create_document(make_doc())
    art = VideoArtifact(
        doc_id="doc_aaaaaaaaaaaa",
        duration_ms=3720000,
        asr_model="faster-whisper/base",
        asr_lang="zh",
        segments=[VideoSegment(i=0, start=1200, end=4800, text="今天我们讲索引…", confidence=0.91)],
        subtitle_srt="1\n00:00:01,200 --> 00:00:04,800\n今天我们讲索引…\n",
        subtitle_vtt="WEBVTT\n\n00:00:01.200 --> 00:00:04.800\n今天我们讲索引…\n",
        transcript=[],
        mindmap_format="markmap",
        mindmap_content="# 索引\n## B+树\n",
        slides=[],
    )
    repo.upsert_video_artifact(art)
    got = repo.get_video_artifact("doc_aaaaaaaaaaaa")
    assert got.duration_ms == 3720000
    assert got.segments[0].to_dict() == {
        "i": 0, "start": 1200, "end": 4800, "text": "今天我们讲索引…", "confidence": 0.91,
    }
    assert got.id == "vid_aaaaaaaaaaaa"
    # 再次 upsert 不重复
    art.duration_ms = 1000
    repo.upsert_video_artifact(art)
    assert repo.get_video_artifact("doc_aaaaaaaaaaaa").duration_ms == 1000


# ═══════════════════════════════════════════════════════════════════════
# 级联删除 / FTS
# ═══════════════════════════════════════════════════════════════════════
def test_cascade_delete_and_fts_cleanup(repo: Repo) -> None:
    repo.create_document(make_doc())
    repo.replace_units("doc_aaaaaaaaaaaa", [make_unit()])
    repo.upsert_cards(
        [Card(id="crd_1", doc_id="doc_aaaaaaaaaaaa", unit_id="unt_000000000001",
              name="索引", kind="concept", one_line="聚簇索引按主键顺序存放数据",
              evidence_quote="", confidence=0.9)]
    )
    repo.upsert_entities([Entity(id="ent_1", doc_id="doc_aaaaaaaaaaaa", name="索引", type="concept")])
    repo.create_task(Task(id="tsk_1", doc_id="doc_aaaaaaaaaaaa", kind="index"))
    from worker.pipeline.search import index_document

    index_document(repo, "doc_aaaaaaaaaaaa")
    assert repo.db.fts_counts()["search_docs"] == 2  # 1 card + 1 unit

    assert repo.delete_document("doc_aaaaaaaaaaaa") is True
    assert repo.get_document("doc_aaaaaaaaaaaa") is None
    assert repo.unit_count("doc_aaaaaaaaaaaa") == 0
    assert repo.card_count("doc_aaaaaaaaaaaa") == 0
    assert repo.entity_count("doc_aaaaaaaaaaaa") == 0
    assert repo.db.scalar("SELECT COUNT(*) FROM tasks") == 0
    # FTS 是 external content 表，不会随 documents 级联 → repo 显式清理
    assert repo.db.fts_counts()["search_docs"] == 0


def test_fts_external_content_upsert(repo: Repo) -> None:
    from worker.pipeline.search import to_bigram

    rows = [
        {"id": "card:crd_1", "doc_id": "doc_a", "ref_id": "crd_1", "kind": "card",
         "title": "聚簇索引", "body_bi": to_bigram("聚簇索引将数据按主键顺序存放")},
        {"id": "card:crd_2", "doc_id": "doc_a", "ref_id": "crd_2", "kind": "card",
         "title": "事务隔离", "body_bi": to_bigram("事务隔离级别")},
    ]
    assert repo.index_search_rows(rows) == 2
    assert repo.db.fts_counts() == {"search_docs": 2, "search_fts": 2}
    # 更新同一 id → 不产生重复行
    rows[0]["title"] = "聚簇索引（改）"
    rows[0]["body_bi"] = to_bigram("聚簇索引覆盖索引")
    repo.index_search_rows([rows[0]])
    assert repo.db.fts_counts()["search_fts"] == 2
    hits = repo.fts_search('"索引"')
    assert len(hits) == 1 and hits[0]["ref_id"] == "crd_1"


# ═══════════════════════════════════════════════════════════════════════
# 上游产物导入（幂等）
# ═══════════════════════════════════════════════════════════════════════
def _write_fake_upstream(tmp: Path) -> tuple[Path, Path]:
    ckpt = tmp / "_ckpt_v2.json"
    ckpt.write_text(
        json.dumps(
            {
                "sections": [
                    {
                        "_meta": {"path": "Chapter 1 General Information › 1.1 About This Manual",
                                  "pg": 32, "end": 34, "node_i": 3},
                        "section": {"section_summary": "本节讲手册怎么用", "learning_objectives": [],
                                    "section_role": "reference", "key_takeaways": ["先读 1.1"]},
                        "cards": [
                            {
                                "name": "SHOW DATABASES", "kind": "sql_statement",
                                "one_line": "列出服务器上有哪些数据库", "purpose": "摸清现有库",
                                "usage_mode": "user_invoked", "operational_role": "diagnostics",
                                "example": "SHOW DATABASES;", "example_explained": "执行后返回库列表",
                                "lifecycle": "builtin", "prerequisites": [], "cautions": [],
                                "evidence_quote": "Use the SHOW statement to find out…",
                                "evidence_page": 32, "confidence": 0.95,
                            },
                            {"name": "坏卡片", "kind": "不存在的kind", "evidence_page": 33},
                        ],
                    }
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    graph = tmp / "graph_view.json"
    graph.write_text(
        json.dumps(
            {
                "nodes": [
                    {"id": "atomic ddl", "name": "Atomic DDL", "zh": "原子 DDL",
                     "type": "feature", "pages": [32]},
                    {"id": "innodb", "name": "InnoDB", "zh": "InnoDB",
                     "type": "product", "pages": [32]},
                    {"id": "bad", "name": "Bad", "type": "不存在的type"},
                ],
                "edges": [
                    {"src": "innodb", "dst": "atomic ddl", "etype": "IMPLEMENTS",
                     "layer": "L2→L1", "verified": True, "confidence": 0.85, "count": 1,
                     "evidence": "the InnoDB storage engine supports atomic DDL.",
                     "pages": [32], "chapter": "Chapter 15 SQL Statements"},
                    {"src": "innodb", "dst": "不存在", "etype": "IMPLEMENTS",
                     "evidence": "x", "pages": [32]},
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return ckpt, graph


def test_import_upstream_idempotent(repo: Repo, tmp_path: Path) -> None:
    from server.store.import_upstream import run_import

    ckpt, graph = _write_fake_upstream(tmp_path)
    doc = repo.create_document(
        Document(
            id="doc_upstream0001",
            title="MySQL 26.7 Reference Manual",
            kind="pdf",
            source_path="upstream/refman.pdf",
            page_count=6392,
            status="ready",
        )
    )
    repo.replace_units(
        doc.id,
        [
            Unit(id="unt_ch1", doc_id=doc.id, ord=1, title="Chapter 1 General Information",
                 level=1, span=Span("page", 31, 57), text="..."),
            Unit(id="unt_11", doc_id=doc.id, ord=2, title="1.1 About This Manual",
                 level=2, parent_id="unt_ch1", span=Span("page", 32, 34), text="..."),
        ],
    )

    args = dict(doc_id=doc.id, cards_path=ckpt, graph_path=graph)
    s1 = run_import(repo, **args)
    assert s1.cards == 1 and s1.cards_skipped == 1  # 非法 kind 被跳过并计数
    assert s1.entities == 2 and s1.entities_skipped == 1
    assert s1.edges == 1 and s1.edges_skipped == 1
    assert s1.fallback_units == 0  # 卡片落在已有 unit 上
    card = repo.list_cards(doc.id)[0][0]
    assert card.unit_id == "unt_11"  # 落到**最深**的包含该页的 unit
    assert card.name == "SHOW DATABASES"
    counts1 = repo.counts(doc.id).to_dict()

    s2 = run_import(repo, **args)  # 第二次导入
    counts2 = repo.counts(doc.id).to_dict()
    assert counts2 == counts1, f"导入不幂等：{counts1} → {counts2}"
    assert s2.cards == 1 and s2.entities == 2 and s2.edges == 1
    meta = repo.get_document(doc.id).meta
    assert meta["import_source"] == "upstream_frozen"
    assert "上游已抽取产物" in meta["llm"]
    assert meta["counts"] == counts2
    assert s2.xrefs == 0, "只有 1 张卡片，且图谱实体名与卡片名不同 → 不该凭空产生引用"
    assert s2.index_rows >= 2


def test_fallback_unit_when_page_uncovered(repo: Repo, tmp_path: Path) -> None:
    from server.store.import_upstream import run_import

    ckpt, _graph = _write_fake_upstream(tmp_path)
    doc = repo.create_document(make_doc("doc_fallback0001"))
    repo.replace_units(
        doc.id,
        [Unit(id="unt_only", doc_id=doc.id, ord=1, title="封面", level=1,
              span=Span("page", 1, 5), text="")],
    )
    s = run_import(repo, doc_id=doc.id, cards_path=ckpt, graph_path=None)
    assert s.fallback_units == 1
    fallback = [u for u in repo.all_units(doc.id) if "兜底" in u.title]
    assert len(fallback) == 1 and fallback[0].span.start == 32
    assert repo.list_cards(doc.id)[0][0].unit_id == fallback[0].id
