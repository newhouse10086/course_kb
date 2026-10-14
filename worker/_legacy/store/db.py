"""SQLite 存储层（契约 §3 的 DDL **逐字落地**）。

三个必须遵守的点：

1. ``PRAGMA journal_mode = WAL``（读写并发）+ ``PRAGMA foreign_keys = ON``（级联删除）
   —— ``foreign_keys`` 是**每连接**生效的，容易漏。
2. ``search_docs`` 存 **bigram 预处理后** 的正文（坑 15：FTS5 默认 tokenizer 对中文 0 命中）。
3. 连接按线程缓存：FastAPI 的同步 handler 跑在线程池里，``sqlite3.Connection``
   **不能跨线程复用**（默认 ``check_same_thread=True`` 会直接抛错）。
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

log = logging.getLogger(__name__)

#: 契约 §3 的 DDL（唯一权威）。加了 IF NOT EXISTS 以便幂等建表。
DDL = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_path TEXT NOT NULL,
  size_bytes INTEGER DEFAULT 0,
  page_count INTEGER DEFAULT 0,
  lang TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'uploading',
  meta_json TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_status ON documents(status);

CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  level INTEGER DEFAULT 1,
  parent_id TEXT,
  span_kind TEXT NOT NULL,
  span_start INTEGER NOT NULL,
  span_end INTEGER NOT NULL,
  text TEXT DEFAULT '',
  text_len INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_unit_doc ON units(doc_id, ord);
CREATE INDEX IF NOT EXISTS idx_unit_parent ON units(parent_id);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  one_line TEXT DEFAULT '',
  purpose TEXT DEFAULT '',
  usage_mode TEXT DEFAULT 'unknown',
  operational_role TEXT DEFAULT 'unknown',
  lifecycle TEXT DEFAULT 'unknown',
  example TEXT,
  example_explained TEXT,
  prerequisites_json TEXT DEFAULT '[]',
  cautions_json TEXT DEFAULT '[]',
  evidence_quote TEXT DEFAULT '',
  span_kind TEXT DEFAULT '',
  span_start INTEGER DEFAULT 0,
  span_end INTEGER DEFAULT 0,
  confidence REAL DEFAULT 0.0,
  name_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_doc ON cards(doc_id);
CREATE INDEX IF NOT EXISTS idx_card_unit ON cards(unit_id);
CREATE INDEX IF NOT EXISTS idx_card_key ON cards(doc_id, name_key);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_zh TEXT DEFAULT '',
  layer TEXT DEFAULT '',
  type TEXT NOT NULL,
  degree INTEGER DEFAULT 0,
  name_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ent_doc ON entities(doc_id);
CREATE INDEX IF NOT EXISTS idx_ent_key ON entities(doc_id, name_key);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  src_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  dst_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  etype TEXT NOT NULL,
  evidence_text TEXT DEFAULT '',
  span_kind TEXT DEFAULT '',
  span_start INTEGER DEFAULT 0,
  span_end INTEGER DEFAULT 0,
  confidence REAL DEFAULT 0.0,
  flagged INTEGER DEFAULT 0,
  UNIQUE(doc_id, src_id, dst_id, etype)
);
CREATE INDEX IF NOT EXISTS idx_edge_src ON edges(src_id);
CREATE INDEX IF NOT EXISTS idx_edge_dst ON edges(dst_id);
CREATE INDEX IF NOT EXISTS idx_edge_type ON edges(doc_id, etype);

CREATE TABLE IF NOT EXISTS xrefs (
  from_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  to_card_id   TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  rel TEXT NOT NULL,
  weight INTEGER DEFAULT 1,
  PRIMARY KEY (from_card_id, to_card_id, rel)
);
CREATE INDEX IF NOT EXISTS idx_xref_to ON xrefs(to_card_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL DEFAULT 0.0,
  stage TEXT DEFAULT '',
  detail_json TEXT DEFAULT '{}',
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_task_doc ON tasks(doc_id);
CREATE INDEX IF NOT EXISTS idx_task_status ON tasks(status);

CREATE TABLE IF NOT EXISTS video_artifacts (
  doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  duration_ms INTEGER DEFAULT 0,
  asr_model TEXT DEFAULT '',
  asr_lang TEXT DEFAULT '',
  segments_json TEXT DEFAULT '[]',
  subtitle_srt TEXT DEFAULT '',
  subtitle_vtt TEXT DEFAULT '',
  transcript_json TEXT DEFAULT '[]',
  mindmap_format TEXT DEFAULT '',
  mindmap_content TEXT DEFAULT '',
  slides_json TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS search_docs (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT DEFAULT '',
  body_bi TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_doc ON search_docs(doc_id);
CREATE INDEX IF NOT EXISTS idx_search_ref ON search_docs(ref_id);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  title, body_bi, content='search_docs', content_rowid='rowid'
);
"""

#: 独立连接（不参与外键/事务），用于对比证明 unicode61 对中文 0 命中
UNICODE61_CONTRAST_DDL = """
CREATE VIRTUAL TABLE IF NOT EXISTS contrast_fts USING fts5(
  body, tokenize='unicode61'
);
"""


class Database:
    """SQLite 连接管理（线程安全的**连接池**，不是连接共享）。"""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._local = threading.local()
        #: 写操作串行化：SQLite 同一时刻只允许一个写事务；拿 Python 锁比撞 SQLITE_BUSY 干净
        self._write_lock = threading.RLock()
        self._closed = False

    # ── 连接 ────────────────────────────────────────────────────────
    def connect(self) -> sqlite3.Connection:
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is not None:
            return conn
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(
            str(self.path),
            timeout=30.0,
            isolation_level=None,  # 自己管事务（见 transaction()）
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")  # ★ 每连接都要设
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute("PRAGMA synchronous = NORMAL")  # WAL 下足够安全，写入快很多
        self._local.conn = conn
        return conn

    def close(self) -> None:
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    # ── 事务 ────────────────────────────────────────────────────────
    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """写事务（表级串行）。异常回滚。"""
        conn = self.connect()
        with self._write_lock:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            else:
                conn.execute("COMMIT")

    # ── 便捷查询 ────────────────────────────────────────────────────
    def query(self, sql: str, params: Sequence[Any] | dict[str, Any] = ()) -> list[sqlite3.Row]:
        return list(self.connect().execute(sql, params))

    def query_one(
        self, sql: str, params: Sequence[Any] | dict[str, Any] = ()
    ) -> sqlite3.Row | None:
        cur = self.connect().execute(sql, params)
        return cur.fetchone()

    def scalar(
        self, sql: str, params: Sequence[Any] | dict[str, Any] = (), default: Any = None
    ) -> Any:
        row = self.query_one(sql, params)
        if row is None:
            return default
        val = row[0]
        return default if val is None else val

    def execute(
        self, sql: str, params: Sequence[Any] | dict[str, Any] = ()
    ) -> sqlite3.Cursor:
        # ⚠️ 不要 tuple(params)：命名占位符（:id）必须收到 dict，
        #    转成 sequence 会抛 "named parameter, but you supplied a sequence"。
        with self.transaction() as conn:
            return conn.execute(sql, params)

    def executemany(
        self, sql: str, rows: Iterable[Sequence[Any] | dict[str, Any]]
    ) -> int:
        rows = list(rows)
        if not rows:
            return 0
        with self.transaction() as conn:
            conn.executemany(sql, rows)
        return len(rows)

    # ── 建表 ────────────────────────────────────────────────────────
    def init_schema(self) -> "Database":
        conn = self.connect()
        # executescript 会隐式提交，不能包在 transaction() 里
        conn.executescript(DDL)
        return self

    # ── FTS（bigram 正文）───────────────────────────────────────────
    def fts_upsert(self, conn: sqlite3.Connection, rows: Iterable[dict[str, Any]]) -> int:
        """写入 ``search_docs`` 并同步外部内容表 ``search_fts``。

        FTS5 external-content 表不会自动跟随内容表，必须显式同步
        （契约 §3 没写触发器，所以在 repo 里显式做 —— 触发器会让
        ``search_docs`` 的删除语义不直观）。
        """
        n = 0
        for r in rows:
            old = conn.execute(
                "SELECT rowid FROM search_docs WHERE id = ?", (r["id"],)
            ).fetchone()
            if old is not None:
                # 先删 FTS 里的旧行（external content 的 'delete' 指令）
                conn.execute(
                    "INSERT INTO search_fts(search_fts, rowid, title, body_bi) "
                    "VALUES('delete', ?, ?, ?)",
                    (old["rowid"], r.get("title", ""), r.get("body_bi", "")),
                )
                conn.execute(
                    "UPDATE search_docs SET doc_id=?, ref_id=?, kind=?, title=?, body_bi=? "
                    "WHERE id=?",
                    (
                        r["doc_id"],
                        r["ref_id"],
                        r["kind"],
                        r.get("title", ""),
                        r["body_bi"],
                        r["id"],
                    ),
                )
                rowid = old["rowid"]
            else:
                cur = conn.execute(
                    "INSERT INTO search_docs(id, doc_id, ref_id, kind, title, body_bi) "
                    "VALUES(?,?,?,?,?,?)",
                    (
                        r["id"],
                        r["doc_id"],
                        r["ref_id"],
                        r["kind"],
                        r.get("title", ""),
                        r["body_bi"],
                    ),
                )
                rowid = cur.lastrowid
            conn.execute(
                "INSERT INTO search_fts(rowid, title, body_bi) VALUES(?,?,?)",
                (rowid, r.get("title", ""), r["body_bi"]),
            )
            n += 1
        return n

    def fts_delete_doc(self, conn: sqlite3.Connection, doc_id: str) -> int:
        rows = conn.execute(
            "SELECT rowid, title, body_bi FROM search_docs WHERE doc_id = ?", (doc_id,)
        ).fetchall()
        for r in rows:
            conn.execute(
                "INSERT INTO search_fts(search_fts, rowid, title, body_bi) "
                "VALUES('delete', ?, ?, ?)",
                (r["rowid"], r["title"], r["body_bi"]),
            )
        conn.execute("DELETE FROM search_docs WHERE doc_id = ?", (doc_id,))
        return len(rows)

    def fts_rebuild(self, conn: sqlite3.Connection | None = None) -> None:
        (conn or self.connect()).execute(
            "INSERT INTO search_fts(search_fts) VALUES('rebuild')"
        )

    def fts_counts(self) -> dict[str, int]:
        return {
            "search_docs": int(self.scalar("SELECT COUNT(*) FROM search_docs", default=0)),
            "search_fts": int(self.scalar("SELECT COUNT(*) FROM search_fts", default=0)),
        }

    # ── 诊断 ────────────────────────────────────────────────────────
    def table_names(self) -> list[str]:
        rows = self.query(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name"
        )
        return [r["name"] for r in rows]

    def stats(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for t in (
            "documents",
            "units",
            "cards",
            "entities",
            "edges",
            "xrefs",
            "tasks",
            "video_artifacts",
        ):
            if t in self.table_names():
                out[t] = int(self.scalar(f"SELECT COUNT(*) FROM {t}", default=0))
        return out


#: 便捷函数：给定路径建库并建表
def open_db(path: str | Path) -> Database:
    db = Database(path)
    db.init_schema()
    return db
