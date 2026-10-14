"""CRUD 仓储（契约 §2 数据模型 ↔ §3 表结构）。

设计约定：
* 每个方法都是**真实 SQL**（不 mock），测试可直接断言条数。
* 写操作走 :meth:`Database.transaction`，异常回滚。
* 对外返回 **models** 对象（不是 sqlite3.Row），API 层只做序列化。
* 幂等：``upsert_*`` 重复调用不产生重复行（断点续跑的必要条件，契约 C4）。
"""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from server.models import (
    Card,
    Document,
    Edge,
    Entity,
    Span,
    Task,
    Unit,
    VideoArtifact,
    Xref,
    id_for,
    name_key,
    now_ms,
    xref_sort_key,
)
from server.store.db import Database

log = logging.getLogger(__name__)


@dataclass
class Counts:
    """一份文档的规模快照（/documents/{id} 与 /capabilities 自检用）。"""

    units: int = 0
    cards: int = 0
    entities: int = 0
    edges: int = 0
    xrefs: int = 0

    def to_dict(self) -> dict[str, int]:
        return {
            "units": self.units,
            "cards": self.cards,
            "entities": self.entities,
            "edges": self.edges,
            "xrefs": self.xrefs,
        }


class Repo:
    """全部 SQL 集中在这里；上层不写裸 SQL。"""

    def __init__(self, db: Database):
        self.db = db

    # ═══════════════════════════════════════════════════════════════
    # documents
    # ═══════════════════════════════════════════════════════════════
    def create_document(self, doc: Document) -> Document:
        self.db.execute(
            "INSERT INTO documents(id,title,kind,source_path,size_bytes,page_count,lang,"
            "status,meta_json,created_at,updated_at) VALUES(:id,:title,:kind,:source_path,"
            ":size_bytes,:page_count,:lang,:status,:meta_json,:created_at,:updated_at)",
            doc.to_row(),
        )
        return doc

    def get_document(self, doc_id: str) -> Document | None:
        row = self.db.query_one("SELECT * FROM documents WHERE id = ?", (doc_id,))
        return Document.from_row(row) if row else None

    def list_documents(
        self,
        *,
        offset: int = 0,
        limit: int = 50,
        kind: str | None = None,
        status: str | None = None,
    ) -> tuple[list[Document], int]:
        where: list[str] = []
        params: list[Any] = []
        if kind:
            where.append("kind = ?")
            params.append(kind)
        if status:
            where.append("status = ?")
            params.append(status)
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        total = int(
            self.db.scalar(f"SELECT COUNT(*) FROM documents{clause}", params, default=0)
        )
        rows = self.db.query(
            f"SELECT * FROM documents{clause} ORDER BY created_at DESC, id LIMIT ? OFFSET ?",
            [*params, int(limit), int(offset)],
        )
        return [Document.from_row(r) for r in rows], total

    def update_document(
        self,
        doc_id: str,
        *,
        status: str | None = None,
        page_count: int | None = None,
        lang: str | None = None,
        title: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> Document | None:
        import json

        sets: list[str] = ["updated_at = ?"]
        params: list[Any] = [now_ms()]
        if status is not None:
            sets.append("status = ?")
            params.append(status)
        if page_count is not None:
            sets.append("page_count = ?")
            params.append(int(page_count))
        if lang is not None:
            sets.append("lang = ?")
            params.append(lang)
        if title is not None:
            sets.append("title = ?")
            params.append(title)
        if meta is not None:
            sets.append("meta_json = ?")
            params.append(json.dumps(meta, ensure_ascii=False))
        params.append(doc_id)
        self.db.execute(f"UPDATE documents SET {', '.join(sets)} WHERE id = ?", params)
        return self.get_document(doc_id)

    def delete_document(self, doc_id: str) -> bool:
        """删除文档（``ON DELETE CASCADE`` 会带走 units/cards/entities/edges/tasks）。

        ⚠️ 契约 C5：先确认再删 —— 调用方负责暂存原件；这里只删库。
        另外 delete 前先清 FTS（external content 表不会级联）。
        """
        with self.db.transaction() as conn:
            self.db.fts_delete_doc(conn, doc_id)
            cur = conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
            return cur.rowcount > 0

    # ═══════════════════════════════════════════════════════════════
    # units
    # ═══════════════════════════════════════════════════════════════
    def insert_units(self, units: Sequence[Unit]) -> int:
        if not units:
            return 0
        with self.db.transaction() as conn:
            conn.executemany(
                "INSERT INTO units(id,doc_id,ord,title,level,parent_id,span_kind,"
                "span_start,span_end,text,text_len) VALUES(:id,:doc_id,:ord,:title,:level,"
                ":parent_id,:span_kind,:span_start,:span_end,:text,:text_len)",
                [u.to_row() for u in units],
            )
        return len(units)

    def replace_units(self, doc_id: str, units: Sequence[Unit]) -> int:
        """原子替换某文档的全部 unit（重解析幂等）。"""
        with self.db.transaction() as conn:
            conn.execute("DELETE FROM units WHERE doc_id = ?", (doc_id,))
            conn.executemany(
                "INSERT INTO units(id,doc_id,ord,title,level,parent_id,span_kind,"
                "span_start,span_end,text,text_len) VALUES(:id,:doc_id,:ord,:title,:level,"
                ":parent_id,:span_kind,:span_start,:span_end,:text,:text_len)",
                [u.to_row() for u in units],
            )
        return len(units)

    def get_unit(self, unit_id: str) -> Unit | None:
        row = self.db.query_one("SELECT * FROM units WHERE id = ?", (unit_id,))
        return Unit.from_row(row) if row else None

    def list_units(
        self, doc_id: str, *, offset: int = 0, limit: int = 500, with_text: bool = False
    ) -> tuple[list[Unit], int]:
        total = self.unit_count(doc_id)
        rows = self.db.query(
            "SELECT * FROM units WHERE doc_id = ? ORDER BY ord LIMIT ? OFFSET ?",
            (doc_id, int(limit), int(offset)),
        )
        units = [Unit.from_row(r) for r in rows]
        if not with_text:
            for u in units:
                u.text = ""
        return units, total

    def all_units(self, doc_id: str) -> list[Unit]:
        rows = self.db.query("SELECT * FROM units WHERE doc_id = ? ORDER BY ord", (doc_id,))
        return [Unit.from_row(r) for r in rows]

    def unit_count(self, doc_id: str) -> int:
        return int(
            self.db.scalar("SELECT COUNT(*) FROM units WHERE doc_id = ?", (doc_id,), 0)
        )

    def unit_children(self, doc_id: str) -> dict[str | None, list[Unit]]:
        """按 parent_id 分组的全量 unit（建树用，避免 N+1 查询）。"""
        out: dict[str | None, list[Unit]] = {}
        for u in self.all_units(doc_id):
            out.setdefault(u.parent_id, []).append(u)
        return out

    # ═══════════════════════════════════════════════════════════════
    # cards
    # ═══════════════════════════════════════════════════════════════
    def upsert_cards(self, cards: Sequence[Card]) -> int:
        """按主键 upsert（同 id 覆盖）。返回写入条数。"""
        if not cards:
            return 0
        rows = [c.to_row() for c in cards]
        with self.db.transaction() as conn:
            conn.executemany(
                "INSERT INTO cards(id,doc_id,unit_id,name,kind,one_line,purpose,usage_mode,"
                "operational_role,lifecycle,example,example_explained,prerequisites_json,"
                "cautions_json,evidence_quote,span_kind,span_start,span_end,confidence,name_key) "
                "VALUES(:id,:doc_id,:unit_id,:name,:kind,:one_line,:purpose,:usage_mode,"
                ":operational_role,:lifecycle,:example,:example_explained,:prerequisites_json,"
                ":cautions_json,:evidence_quote,:span_kind,:span_start,:span_end,:confidence,"
                ":name_key) "
                "ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,"
                "one_line=excluded.one_line,purpose=excluded.purpose,"
                "usage_mode=excluded.usage_mode,operational_role=excluded.operational_role,"
                "lifecycle=excluded.lifecycle,example=excluded.example,"
                "example_explained=excluded.example_explained,"
                "prerequisites_json=excluded.prerequisites_json,"
                "cautions_json=excluded.cautions_json,"
                "evidence_quote=excluded.evidence_quote,span_kind=excluded.span_kind,"
                "span_start=excluded.span_start,span_end=excluded.span_end,"
                "confidence=excluded.confidence,name_key=excluded.name_key",
                rows,
            )
        return len(rows)

    def get_card(self, card_id: str) -> Card | None:
        row = self.db.query_one("SELECT * FROM cards WHERE id = ?", (card_id,))
        return Card.from_row(row) if row else None

    def list_cards(
        self, doc_id: str, *, offset: int = 0, limit: int = 200, unit_id: str | None = None
    ) -> tuple[list[Card], int]:
        if unit_id:
            total = int(
                self.db.scalar(
                    "SELECT COUNT(*) FROM cards WHERE doc_id = ? AND unit_id = ?",
                    (doc_id, unit_id),
                    0,
                )
            )
            rows = self.db.query(
                "SELECT * FROM cards WHERE doc_id = ? AND unit_id = ? "
                "ORDER BY unit_id, name LIMIT ? OFFSET ?",
                (doc_id, unit_id, int(limit), int(offset)),
            )
        else:
            total = self.card_count(doc_id)
            rows = self.db.query(
                "SELECT * FROM cards WHERE doc_id = ? ORDER BY unit_id, name LIMIT ? OFFSET ?",
                (doc_id, int(limit), int(offset)),
            )
        return [Card.from_row(r) for r in rows], total

    def all_cards(self, doc_id: str) -> list[Card]:
        rows = self.db.query("SELECT * FROM cards WHERE doc_id = ?", (doc_id,))
        return [Card.from_row(r) for r in rows]

    def card_count(self, doc_id: str) -> int:
        return int(self.db.scalar("SELECT COUNT(*) FROM cards WHERE doc_id = ?", (doc_id,), 0))

    def card_counts_by_unit(self, doc_id: str) -> dict[str, int]:
        rows = self.db.query(
            "SELECT unit_id, COUNT(*) AS n FROM cards WHERE doc_id = ? GROUP BY unit_id",
            (doc_id,),
        )
        return {r["unit_id"]: int(r["n"]) for r in rows}

    def existing_card_keys(self, doc_id: str, unit_id: str) -> set[str]:
        """某 unit 已抽过的卡片名（断点续跑用：跳过已完成的 unit）。"""
        rows = self.db.query(
            "SELECT name_key FROM cards WHERE doc_id = ? AND unit_id = ?", (doc_id, unit_id)
        )
        return {r["name_key"] for r in rows}

    def done_unit_ids(self, doc_id: str) -> set[str]:
        """已有卡片的 unit（+ 显式标记为空结果的 unit）。

        断点续跑用它跳过已完成工作：一个 unit 抽完就问这里，避免重复调 LLM。
        """
        rows = self.db.query(
            "SELECT DISTINCT unit_id FROM cards WHERE doc_id = ?", (doc_id,)
        )
        out = {r["unit_id"] for r in rows}
        # 空结果的 unit 存在 meta 里（否则"抽过但没卡片"会被反复重跑）
        doc = self.get_document(doc_id)
        if doc:
            out |= set(doc.meta.get("extracted_empty_units", []) or [])
        return out

    def mark_unit_empty(self, doc_id: str, unit_id: str) -> None:
        doc = self.get_document(doc_id)
        if not doc:
            return
        meta = dict(doc.meta or {})
        lst = list(meta.get("extracted_empty_units", []) or [])
        if unit_id not in lst:
            lst.append(unit_id)
        meta["extracted_empty_units"] = lst
        self.update_document(doc_id, meta=meta)

    def cards_by_name_key(self, doc_id: str, key: str) -> list[Card]:
        rows = self.db.query(
            "SELECT * FROM cards WHERE doc_id = ? AND name_key = ?", (doc_id, key)
        )
        return [Card.from_row(r) for r in rows]

    # ═══════════════════════════════════════════════════════════════
    # entities / edges
    # ═══════════════════════════════════════════════════════════════
    def upsert_entities(self, entities: Sequence[Entity]) -> dict[str, str]:
        """按 ``(doc_id, name_key)`` 归并实体，返回 ``name_key -> entity_id``。

        为什么不用 ``INSERT OR REPLACE``：DDL 里 ``entities`` 只有
        ``idx_ent_key(doc_id, name_key)`` 这个**普通索引**（不是 UNIQUE），
        所以必须先查后写；而且同名实体被多条边引用时**必须复用同一个 id**，
        否则图谱会出现一堆孤岛节点（上游 v1 的实际问题）。
        """
        mapping: dict[str, str] = {}
        if not entities:
            return mapping
        with self.db.transaction() as conn:
            for e in entities:
                row = conn.execute(
                    "SELECT id FROM entities WHERE doc_id = ? AND name_key = ? LIMIT 1",
                    (e.doc_id, e.name_key),
                ).fetchone()
                if row:
                    eid = row["id"]
                    conn.execute(
                        "UPDATE entities SET name=?, name_zh=COALESCE(NULLIF(?,''), name_zh), "
                        "layer=COALESCE(NULLIF(?,''), layer), type=? WHERE id=?",
                        (e.name, e.name_zh, e.layer, e.type, eid),
                    )
                else:
                    eid = e.id
                    conn.execute(
                        "INSERT INTO entities(id,doc_id,name,name_zh,layer,type,degree,name_key) "
                        "VALUES(?,?,?,?,?,?,?,?)",
                        (
                            eid,
                            e.doc_id,
                            e.name,
                            e.name_zh,
                            e.layer,
                            e.type,
                            e.degree,
                            e.name_key,
                        ),
                    )
                mapping[e.name_key] = eid
        return mapping

    def upsert_edges(self, edges: Sequence[Edge]) -> int:
        """按 ``UNIQUE(doc_id, src_id, dst_id, etype)`` upsert。"""
        if not edges:
            return 0
        rows = [e.to_row() for e in edges]
        with self.db.transaction() as conn:
            conn.executemany(
                "INSERT INTO edges(id,doc_id,src_id,dst_id,etype,evidence_text,span_kind,"
                "span_start,span_end,confidence,flagged) VALUES(:id,:doc_id,:src_id,:dst_id,"
                ":etype,:evidence_text,:span_kind,:span_start,:span_end,:confidence,:flagged) "
                "ON CONFLICT(doc_id,src_id,dst_id,etype) DO UPDATE SET "
                "evidence_text=excluded.evidence_text, span_kind=excluded.span_kind, "
                "span_start=excluded.span_start, span_end=excluded.span_end, "
                "confidence=excluded.confidence, flagged=excluded.flagged",
                rows,
            )
        return len(rows)

    def get_entity(self, entity_id: str) -> Entity | None:
        row = self.db.query_one("SELECT * FROM entities WHERE id = ?", (entity_id,))
        return Entity.from_row(row) if row else None

    def list_entities(self, doc_id: str) -> list[Entity]:
        rows = self.db.query(
            "SELECT * FROM entities WHERE doc_id = ? ORDER BY degree DESC, name", (doc_id,)
        )
        return [Entity.from_row(r) for r in rows]

    def list_edges(self, doc_id: str) -> list[Edge]:
        rows = self.db.query("SELECT * FROM edges WHERE doc_id = ?", (doc_id,))
        return [Edge.from_row(r) for r in rows]

    def entity_count(self, doc_id: str) -> int:
        return int(
            self.db.scalar("SELECT COUNT(*) FROM entities WHERE doc_id = ?", (doc_id,), 0)
        )

    def edge_count(self, doc_id: str) -> int:
        return int(self.db.scalar("SELECT COUNT(*) FROM edges WHERE doc_id = ?", (doc_id,), 0))

    def recompute_degrees(self, doc_id: str) -> int:
        """重算 degree（节点度数）。边变化后必须调用，否则 UI 大小是错的。"""
        with self.db.transaction() as conn:
            conn.execute(
                "UPDATE entities SET degree = 0 WHERE doc_id = ?", (doc_id,)
            )
            conn.execute(
                "UPDATE entities SET degree = ("
                "  SELECT COUNT(*) FROM edges e"
                "  WHERE (e.src_id = entities.id OR e.dst_id = entities.id)"
                ") WHERE doc_id = ?",
                (doc_id,),
            )
        return self.entity_count(doc_id)

    def entity_unit_map(self, doc_id: str) -> dict[str, list[str]]:
        """``entity_id -> [unit_id...]``（/graph 契约要求节点带 ``unit_ids``）。

        实体表本身没有 unit_id（契约 §3 DDL 如此），所以按**同名卡片**回推：
        entity.name_key 与 card.name_key 相同的卡片，其 unit 就是该实体的出现单元。
        """
        rows = self.db.query(
            "SELECT e.id AS eid, c.unit_id AS uid FROM entities e "
            "JOIN cards c ON c.doc_id = e.doc_id AND c.name_key = e.name_key "
            "WHERE e.doc_id = ?",
            (doc_id,),
        )
        out: dict[str, list[str]] = {}
        for r in rows:
            lst = out.setdefault(r["eid"], [])
            if r["uid"] not in lst:
                lst.append(r["uid"])
        return out

    def entity_edges(self, doc_id: str) -> dict[str, list[Edge]]:
        """``entity_id -> [edge...]``（一跳邻居，wiki 内嵌子图用）。"""
        out: dict[str, list[Edge]] = {}
        for e in self.list_edges(doc_id):
            out.setdefault(e.src_id, []).append(e)
            out.setdefault(e.dst_id, []).append(e)
        return out

    # ═══════════════════════════════════════════════════════════════
    # xrefs
    # ═══════════════════════════════════════════════════════════════
    def replace_xrefs(self, doc_id: str, xrefs: Sequence[Xref]) -> int:
        """原子替换该文档的交叉引用（重算幂等）。"""
        with self.db.transaction() as conn:
            conn.execute(
                "DELETE FROM xrefs WHERE from_card_id IN (SELECT id FROM cards WHERE doc_id = ?)",
                (doc_id,),
            )
            conn.executemany(
                "INSERT OR IGNORE INTO xrefs(from_card_id,to_card_id,rel,weight) "
                "VALUES(:from_card_id,:to_card_id,:rel,:weight)",
                [x.to_row() for x in xrefs],
            )
        return self.xref_count(doc_id)

    def xref_count(self, doc_id: str) -> int:
        return int(
            self.db.scalar(
                "SELECT COUNT(*) FROM xrefs WHERE from_card_id IN "
                "(SELECT id FROM cards WHERE doc_id = ?)",
                (doc_id,),
                default=0,
            )
        )

    def out_links(self, card_id: str, *, rels: Sequence[str] | None = None) -> list[dict]:
        sql = (
            "SELECT x.rel, x.weight, c.id, c.name, c.kind, c.unit_id FROM xrefs x "
            "JOIN cards c ON c.id = x.to_card_id WHERE x.from_card_id = ?"
        )
        params: list[Any] = [card_id]
        if rels:
            sql += f" AND x.rel IN ({','.join('?' * len(rels))})"
            params.extend(rels)
        rows = self.db.query(sql, params)
        out = [dict(r) for r in rows]
        out.sort(key=lambda d: (("typed", "mention", "also_in", "same_unit").index(d["rel"]), d["name"]))
        return out

    def back_links(self, card_id: str) -> list[dict]:
        rows = self.db.query(
            "SELECT x.rel, x.weight, c.id, c.name, c.kind, c.unit_id FROM xrefs x "
            "JOIN cards c ON c.id = x.from_card_id WHERE x.to_card_id = ?",
            (card_id,),
        )
        out = [dict(r) for r in rows]
        out.sort(key=lambda d: (("typed", "mention", "also_in", "same_unit").index(d["rel"]), d["name"]))
        return out

    def list_xrefs(
        self, doc_id: str, *, rel: str | None = None, offset: int = 0, limit: int = 1000
    ) -> tuple[list[Xref], int]:
        where = ["c.doc_id = ?"]
        params: list[Any] = [doc_id]
        if rel:
            where.append("x.rel = ?")
            params.append(rel)
        clause = " AND ".join(where)
        total = int(
            self.db.scalar(
                f"SELECT COUNT(*) FROM xrefs x JOIN cards c ON c.id = x.from_card_id "
                f"WHERE {clause}",
                params,
                default=0,
            )
        )
        rows = self.db.query(
            f"SELECT x.* FROM xrefs x JOIN cards c ON c.id = x.from_card_id WHERE {clause} "
            f"ORDER BY x.rel, x.from_card_id LIMIT ? OFFSET ?",
            [*params, int(limit), int(offset)],
        )
        return [Xref.from_row(r) for r in rows], total

    def rel_histogram(self, doc_id: str) -> dict[str, int]:
        rows = self.db.query(
            "SELECT x.rel AS rel, COUNT(*) AS n FROM xrefs x JOIN cards c ON c.id = x.from_card_id "
            "WHERE c.doc_id = ? GROUP BY x.rel",
            (doc_id,),
        )
        return {r["rel"]: int(r["n"]) for r in rows}

    def cards_with_xrefs(self, doc_id: str) -> int:
        """有引用（出链）的卡片数 —— F4 验收「有引用的卡片占比 > 50%」。"""
        return int(
            self.db.scalar(
                "SELECT COUNT(DISTINCT x.from_card_id) FROM xrefs x "
                "JOIN cards c ON c.id = x.from_card_id WHERE c.doc_id = ?",
                (doc_id,),
                default=0,
            )
        )

    # ═══════════════════════════════════════════════════════════════
    # tasks
    # ═══════════════════════════════════════════════════════════════
    def create_task(self, task: Task) -> Task:
        self.db.execute(
            "INSERT INTO tasks(id,doc_id,kind,status,progress,stage,detail_json,error,"
            "created_at,finished_at) VALUES(:id,:doc_id,:kind,:status,:progress,:stage,"
            ":detail_json,:error,:created_at,:finished_at)",
            task.to_row(),
        )
        return task

    def get_task(self, task_id: str) -> Task | None:
        row = self.db.query_one("SELECT * FROM tasks WHERE id = ?", (task_id,))
        return Task.from_row(row) if row else None

    def list_tasks(
        self, *, doc_id: str | None = None, status: str | None = None,
        offset: int = 0, limit: int = 50,
    ) -> tuple[list[Task], int]:
        where: list[str] = []
        params: list[Any] = []
        if doc_id:
            where.append("doc_id = ?")
            params.append(doc_id)
        if status:
            where.append("status = ?")
            params.append(status)
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        total = int(
            self.db.scalar(f"SELECT COUNT(*) FROM tasks{clause}", params, default=0)
        )
        rows = self.db.query(
            f"SELECT * FROM tasks{clause} ORDER BY created_at DESC LIMIT ? OFFSET ?",
            [*params, int(limit), int(offset)],
        )
        return [Task.from_row(r) for r in rows], total

    def update_task(
        self,
        task_id: str,
        *,
        status: str | None = None,
        progress: float | None = None,
        stage: str | None = None,
        detail: dict[str, Any] | None = None,
        error: str | None = None,
        finished_at: int | None = None,
    ) -> Task | None:
        import json

        sets: list[str] = []
        params: list[Any] = []
        if status is not None:
            sets.append("status = ?")
            params.append(status)
        if progress is not None:
            sets.append("progress = ?")
            params.append(max(0.0, min(1.0, float(progress))))
        if stage is not None:
            sets.append("stage = ?")
            params.append(stage)
        if detail is not None:
            sets.append("detail_json = ?")
            params.append(json.dumps(detail, ensure_ascii=False))
        if error is not None:
            sets.append("error = ?")
            params.append(error)
        if finished_at is not None:
            sets.append("finished_at = ?")
            params.append(int(finished_at))
        if not sets:
            return self.get_task(task_id)
        params.append(task_id)
        self.db.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE id = ?", params)
        return self.get_task(task_id)

    def cancel_task(self, task_id: str) -> Task | None:
        task = self.get_task(task_id)
        if task is None:
            return None
        if task.is_terminal:
            return task
        return self.update_task(
            task_id, status="cancelled", finished_at=now_ms(), stage="已取消"
        )

    # ═══════════════════════════════════════════════════════════════
    # video_artifacts（契约 §2.7；写入方是 T2 的 server/video/**）
    # ═══════════════════════════════════════════════════════════════
    def upsert_video_artifact(self, art: VideoArtifact) -> VideoArtifact:
        self.db.execute(
            "INSERT INTO video_artifacts(doc_id,duration_ms,asr_model,asr_lang,segments_json,"
            "subtitle_srt,subtitle_vtt,transcript_json,mindmap_format,mindmap_content,slides_json) "
            "VALUES(:doc_id,:duration_ms,:asr_model,:asr_lang,:segments_json,:subtitle_srt,"
            ":subtitle_vtt,:transcript_json,:mindmap_format,:mindmap_content,:slides_json) "
            "ON CONFLICT(doc_id) DO UPDATE SET duration_ms=excluded.duration_ms, "
            "asr_model=excluded.asr_model, asr_lang=excluded.asr_lang, "
            "segments_json=excluded.segments_json, subtitle_srt=excluded.subtitle_srt, "
            "subtitle_vtt=excluded.subtitle_vtt, transcript_json=excluded.transcript_json, "
            "mindmap_format=excluded.mindmap_format, mindmap_content=excluded.mindmap_content, "
            "slides_json=excluded.slides_json",
            art.to_row(),
        )
        return art

    def get_video_artifact(self, doc_id: str) -> VideoArtifact | None:
        row = self.db.query_one("SELECT * FROM video_artifacts WHERE doc_id = ?", (doc_id,))
        return VideoArtifact.from_row(row) if row else None

    # ═══════════════════════════════════════════════════════════════
    # 检索索引（bigram 正文由 pipeline.search 生成）
    # ═══════════════════════════════════════════════════════════════
    def index_search_rows(self, rows: Iterable[dict[str, Any]]) -> int:
        """写入/更新检索索引行（``body_bi`` 必须是 bigram 化后的文本）。"""
        rows = list(rows)
        if not rows:
            return 0
        with self.db.transaction() as conn:
            return self.db.fts_upsert(conn, rows)

    def clear_search_index(self, doc_id: str) -> int:
        with self.db.transaction() as conn:
            return self.db.fts_delete_doc(conn, doc_id)

    def fts_search(
        self, match_expr: str, *, doc_id: str | None = None, limit: int = 20
    ) -> list[sqlite3.Row]:
        """裸 FTS5 查询（MATCH 表达式由 pipeline.search 构造，含 bigram）。"""
        sql = (
            "SELECT d.id, d.doc_id, d.ref_id, d.kind, d.title, "
            "       bm25(search_fts) AS score "
            "FROM search_fts JOIN search_docs d ON d.rowid = search_fts.rowid "
            "WHERE search_fts MATCH ?"
        )
        params: list[Any] = [match_expr]
        if doc_id:
            sql += " AND d.doc_id = ?"
            params.append(doc_id)
        sql += " ORDER BY score LIMIT ?"
        params.append(int(limit))
        return self.db.query(sql, params)

    # ═══════════════════════════════════════════════════════════════
    # 汇总
    # ═══════════════════════════════════════════════════════════════
    def counts(self, doc_id: str) -> Counts:
        return Counts(
            units=self.unit_count(doc_id),
            cards=self.card_count(doc_id),
            entities=self.entity_count(doc_id),
            edges=self.edge_count(doc_id),
            xrefs=self.xref_count(doc_id),
        )

    def new_id(self, kind: str) -> str:
        return id_for(kind)
