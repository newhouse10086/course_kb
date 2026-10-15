/**
 * SQLite 连接 + 迁移（better-sqlite3）。
 *
 * 契约 `docs/API_PROTOCOL.md` §3：**表结构逐字对齐**，字段名/类型不许改动。
 * 迁移策略：`CREATE TABLE IF NOT EXISTS` 幂等；`schema_migrations` 记录已应用版本。
 *
 * 坑 15 的落点：`search_docs.body_bi` 存 **bigram 预处理后** 的正文，
 * `search_fts` 是 external-content FTS5（不会自动跟随内容表，必须显式同步 —— 见 `ftsUpsert`）。
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase, Statement } from 'better-sqlite3';

/** 契约 §3 的 DDL（原文照抄，仅加 `IF NOT EXISTS` 使其幂等）。 */
export const DDL_V1 = `
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

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  title, body_bi, content='search_docs', content_rowid='rowid'
);
`;

/** 检索索引辅助索引（契约 §3 未列，但为查询性能所加；**不改表结构**）。 */
const DDL_LOCAL_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_search_doc ON search_docs(doc_id);
CREATE INDEX IF NOT EXISTS idx_search_ref ON search_docs(ref_id);
`;

const DDL_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;

/**
 * 迁移 v2：RBAC + 课程 + 草稿/发布状态机（`docs/RBAC.md` §3，**DDL 逐字照抄**）。
 *
 * 新增 8 表：users / user_roles / courses / course_members / sessions / notes / conversations / audit_log
 * 既有表加列：documents(+owner_id/visibility/review_status/course_id)、tasks(+priority/user_id)
 *
 * ⚠️ 加列用「**读 table_info 再补缺列**」而不是裸 ALTER：
 * SQLite 没有 `ADD COLUMN IF NOT EXISTS`，重复 ALTER 会报错；这样迁移可重复执行。
 */
export const DDL_V2_TABLES = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role);

CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  term TEXT DEFAULT '',
  owner_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS course_members (
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (course_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON course_members(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  user_agent TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT, unit_id TEXT, doc_id TEXT,
  body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id, created_at);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_id TEXT, title TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT, action TEXT NOT NULL,
  target TEXT DEFAULT '', detail_json TEXT DEFAULT '{}',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
`;

/** v2 要给既有表补的列（名字 → 列定义；SQLite 不支持 ADD COLUMN IF NOT EXISTS，故运行时判缺）。 */
const V2_ADDED_COLUMNS: Record<string, Record<string, string>> = {
  documents: {
    // 契约 RBAC §3：既有表加列
    owner_id: 'TEXT REFERENCES users(id)',
    visibility: "TEXT NOT NULL DEFAULT 'private'",
    review_status: "TEXT NOT NULL DEFAULT 'draft'",
    course_id: 'TEXT REFERENCES courses(id)',
    // ★ v4：视频"目录"归属（**可空** —— 不属于任何目录的视频仍可用，不破坏既有数据）
    collection_id: 'TEXT',
  },
  tasks: {
    // RBAC §5：任务优先级与归属（LLM 并发=1 是全局的，必须能区分师生）
    priority: 'INTEGER NOT NULL DEFAULT 0',
    user_id: 'TEXT REFERENCES users(id)',
  },
};

/** v2 索引（列补完后再建）。 */
const DDL_V2_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_doc_review ON documents(review_status);
CREATE INDEX IF NOT EXISTS idx_doc_owner ON documents(owner_id);
CREATE INDEX IF NOT EXISTS idx_doc_course ON documents(course_id);
CREATE INDEX IF NOT EXISTS idx_task_priority ON tasks(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_task_user ON tasks(user_id, status);
`;

/**
 * 迁移 v3：`embeddings` 空表（`docs/RETRIEVAL.md`：rag 只留接口，**表先建、不填数据**）。
 *
 * 为什么现在建：rag retriever 的 `healthCheck()` 要如实回答"为什么不可用"——
 * "没有 embedding provider" 与 "表都不存在" 是**两种不同的 reason**，不能混成一句。
 */
const DDL_V3_EMBEDDINGS = `
CREATE TABLE IF NOT EXISTS embeddings (
  model TEXT NOT NULL,
  ref_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB,
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (model, ref_kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_ref ON embeddings(ref_kind, ref_id);
`;

/**
 * 迁移 v4：**视频目录**（`collections`）+ `documents.collection_id`。
 *
 * ## 为什么是**独立表**而不是 `documents` 加一列（Lead 征询过裁定）
 * 1. **目录是实体**：要重命名/排序/独立发布/将来权限 —— 一列**很快不够用**，
 *    第一次要加"目录级发布"时又得迁移一次。
 * 2. ★ **目录必须能独立于视频发布**（学生"选某个文件夹"→ 文件夹本身有可见性）—— 一列表达不了。
 * 3. ★★ **复用既有可见性词汇**：本表刻意带上 `owner_id` / `visibility` / `review_status` / `course_id`
 *    —— 与 `documents` **完全同构**，于是 `docScopeSql(scope)` 可以**逐字复用**（见 `store/scope.ts`），
 *    **不引入第二套 RBAC 方言**（新接口因此不可能成为绕过 RBAC 的后门）。
 *
 * ⚠️ 原错误写法（若按"加一列"实现）：`documents.collection TEXT` —— 无发布语义、无 owner、
 *    无法重命名，且学生可见性只能靠"猜字符串前缀"，必然演变成两套权限判断。
 */
const DDL_V4_COLLECTIONS = `
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  owner_id TEXT REFERENCES users(id),
  visibility TEXT NOT NULL DEFAULT 'private',
  review_status TEXT NOT NULL DEFAULT 'draft',
  course_id TEXT REFERENCES courses(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collection_owner ON collections(owner_id);
CREATE INDEX IF NOT EXISTS idx_collection_review ON collections(review_status);
`;

/**
 * 迁移 v4 的**索引**，必须**在 `addMissingColumns()` 之后**执行。
 *
 * ⚠️ **原错误写法**：`idx_doc_collection` 原先写在 `DDL_V4_COLLECTIONS` 里（与建表同批），
 *    而 `documents.collection_id` 是 `addMissingColumns()` **之后**才补上的列 ——
 *    ⟹ 全新库/旧库启动时 `CREATE INDEX ... ON documents(collection_id)` **必然报
 *      `SqliteError: no such column: collection_id`**，**服务直接起不来**（实测踩到：
 *      用户正在实测的服务被这条卡死）。
 *    ★ 教训：**"建表"与"在别表上建索引"不是同一批** ——
 *      前者依赖表存在，后者还依赖**列已补**。凡是索引涉及"补出来的列"，都必须排在补列之后。
 */
const DDL_V4_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_doc_collection ON documents(collection_id);
`;

export interface SearchRow {
  id: string;
  doc_id: string;
  ref_id: string;
  kind: string;
  title: string;
  body_bi: string;
  rowid?: number;
}

export interface FtsHitRow {
  ref_id: string;
  doc_id: string;
  kind: string;
  title: string;
  score: number;
}

/**
 * SQLite 句柄封装。
 * better-sqlite3 是**同步** API —— 与 Node 单线程配合反而简单：写操作天然串行，
 * 不需要 v1 Python 版的连接池/写锁。
 */
export class Db {
  readonly path: string;
  readonly db: SqliteDatabase;
  private readonly stmtCache = new Map<string, Statement>();

  private constructor(dbPath: string, db: SqliteDatabase) {
    this.path = dbPath;
    this.db = db;
  }

  /** 打开（`:memory:` 或文件路径）+ 迁移。 */
  static open(dbPath: string): Db {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 30000');
    db.pragma('synchronous = NORMAL');
    const out = new Db(dbPath, db);
    out.migrate();
    return out;
  }

  /** 迁移（幂等）。返回已应用的版本号。 */
  migrate(): number {
    this.db.exec(DDL_MIGRATIONS);
    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
    );
    if (!applied.has(1)) {
      this.db.exec(DDL_V1);
      this.db.exec(DDL_LOCAL_INDEXES);
      this.db
        .prepare('INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES(?,?,?)')
        .run(1, 'api_protocol_v1_section3', Date.now());
    }
    if (!applied.has(2)) {
      this.db.exec(DDL_V2_TABLES);
      this.addMissingColumns();
      this.db.exec(DDL_V2_INDEXES);
      this.db
        .prepare('INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES(?,?,?)')
        .run(2, 'rbac_v1_section3', Date.now());
    }
    if (!applied.has(3)) {
      this.db.exec(DDL_V3_EMBEDDINGS);
      this.db
        .prepare('INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES(?,?,?)')
        .run(3, 'retrieval_embeddings_table', Date.now());
    }
    if (!applied.has(4)) {
      // ★ 先建表（`documents.collection_id` 的语义依赖它），再补列（幂等机制复用 v2 的）
      this.db.exec(DDL_V4_COLLECTIONS);
      this.addMissingColumns();
      // ★ 索引**必须在补列之后**（它涉及补出来的 `documents.collection_id`）—— 见 DDL_V4_INDEXES 注释
      this.db.exec(DDL_V4_INDEXES);
      this.db
        .prepare('INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES(?,?,?)')
        .run(4, 'video_collections', Date.now());
    }
    /**
     * ★ 迁移 v5：**补建 `idx_doc_collection`**（幂等 `CREATE INDEX IF NOT EXISTS`）。
     *
     * ## 为什么需要它（真实发生过，且**是并发编辑的产物**）
     * `idx_doc_collection` 原本写在 `DDL_V4_COLLECTIONS` 里、排在 `addMissingColumns()` **之前** →
     * `no such column: collection_id` → **服务起不来**。修复（把索引挪到补列之后）**先落地**，
     * v4 因此**成功并写入了 `schema_migrations`**；随后补上的索引语句**再也不会执行**。
     * ⟹ 那个库处于"**v4 已记录、但索引不存在**"的状态 —— **只靠改 v4 的代码救不回来**，
     *    必须**新版本号**才会重跑。这正是"迁移一旦记录就不会重跑"的必然推论。
     *
     * ⚠️ 教训（写进提交信息）：**迁移块一旦被别人跑过，就只能靠新版本号前进** ——
     *    改旧块的代码对已迁移的库**无效**。
     */
    if (!applied.has(5)) {
      this.db.exec(DDL_V4_INDEXES);
      this.db
        .prepare('INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES(?,?,?)')
        .run(5, 'doc_collection_index_backfill', Date.now());
    }
    return Math.max(1, ...applied);
  }

  /**
   * 补齐 v2 新增列（幂等）。
   *
   * 为什么不用裸 `ALTER TABLE … ADD COLUMN`：SQLite **没有** `IF NOT EXISTS`，
   * 重复执行会抛 `duplicate column name`，导致"第二次启动就起不来"。
   * 这里先读 `PRAGMA table_info` 判缺，再补 —— 迁移因此可重复执行。
   */
  private addMissingColumns(): void {
    for (const [table, columns] of Object.entries(V2_ADDED_COLUMNS)) {
      const existing = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name),
      );
      if (existing.size === 0) continue; // 表不存在（理论上不会）
      for (const [col, decl] of Object.entries(columns)) {
        if (existing.has(col)) continue;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
      }
    }
  }

  /** 该连接是否真的开了外键约束（`PRAGMA foreign_keys` 是**每连接**设置，独立连接读 0 属正常）。 */
  foreignKeysEnabled(): boolean {
    return this.db.pragma('foreign_keys', { simple: true }) === 1;
  }

  close(): void {
    this.stmtCache.clear();
    try {
      this.db.close();
    } catch {
      /* 已关闭 */
    }
  }

  /** 预编译语句缓存（better-sqlite3 的 prepare 不便宜）。 */
  stmt(sql: string): Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.stmt(sql).run(...params);
  }

  scalar<T = number>(sql: string, ...params: unknown[]): T | undefined {
    const row = this.get<Record<string, unknown>>(sql, ...params);
    if (!row) return undefined;
    return Object.values(row)[0] as T;
  }

  /** 写事务（异常回滚）。同步 API → 天然串行，无需锁。 */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── FTS5 external-content 同步 ────────────────────────────────────────
  /**
   * 写入 `search_docs` 并同步 external-content 的 `search_fts`。
   *
   * ⚠️ FTS5 external-content 表**不会自动跟随**内容表（契约 §3 没写触发器）。
   * 更新时必须先发 `'delete'` 指令再插新行，否则索引里会留旧词条 → 搜出已改掉的内容。
   *
   * ⚠️ **`'delete'` 指令必须传「旧值」**（title/body_bi），FTS5 靠它算出要从索引里移除哪些 token。
   * 传新值 = 什么都没删掉，旧词条永久残留（静默脏索引，搜索命中已删内容）。
   * 原错误写法（v1 `store/db.py::fts_upsert` 就是这么写的，且只 `SELECT rowid`）：
   * ```text
   * old = SELECT rowid FROM search_docs WHERE id = ?      ← 只取了 rowid
   * INSERT INTO search_fts(search_fts,rowid,title,body_bi) VALUES('delete', old.rowid, 新title, 新body_bi)
   * ```
   * 本实现改为同时取回旧 `title`/`body_bi` 并传给 `'delete'`；`test/store_bigram.test.ts` 有回归断言。
   */
  ftsUpsert(rows: SearchRow[]): number {
    const findOld = this.stmt('SELECT rowid, title, body_bi FROM search_docs WHERE id = ?');
    const del = this.stmt(
      "INSERT INTO search_fts(search_fts, rowid, title, body_bi) VALUES('delete', ?, ?, ?)",
    );
    const upd = this.stmt(
      'UPDATE search_docs SET doc_id=?, ref_id=?, kind=?, title=?, body_bi=? WHERE id=?',
    );
    const ins = this.stmt(
      'INSERT INTO search_docs(id, doc_id, ref_id, kind, title, body_bi) VALUES(?,?,?,?,?,?)',
    );
    const insFts = this.stmt('INSERT INTO search_fts(rowid, title, body_bi) VALUES(?,?,?)');

    let n = 0;
    for (const r of rows) {
      const old = findOld.get(r.id) as { rowid: number; title: string; body_bi: string } | undefined;
      let rowid: number;
      if (old) {
        // ★ 传旧值，不是新值
        del.run(old.rowid, old.title ?? '', old.body_bi ?? '');
        upd.run(r.doc_id, r.ref_id, r.kind, r.title ?? '', r.body_bi, r.id);
        rowid = old.rowid;
      } else {
        const res = ins.run(r.id, r.doc_id, r.ref_id, r.kind, r.title ?? '', r.body_bi);
        rowid = Number(res.lastInsertRowid);
      }
      insFts.run(rowid, r.title ?? '', r.body_bi);
      n += 1;
    }
    return n;
  }

  /** 删除某文档的全部检索行（先同步 FTS 再删内容行）。 */
  ftsDeleteDoc(docId: string): number {
    const rows = this.all<{ rowid: number; title: string; body_bi: string }>(
      'SELECT rowid, title, body_bi FROM search_docs WHERE doc_id = ?',
      docId,
    );
    const del = this.stmt(
      "INSERT INTO search_fts(search_fts, rowid, title, body_bi) VALUES('delete', ?, ?, ?)",
    );
    for (const r of rows) del.run(r.rowid, r.title, r.body_bi);
    this.run('DELETE FROM search_docs WHERE doc_id = ?', docId);
    return rows.length;
  }

  /** 索引行数（自检/测试用）。 */
  ftsCounts(): { search_docs: number; search_fts: number } {
    return {
      search_docs: Number(this.scalar<number>('SELECT COUNT(*) FROM search_docs') ?? 0),
      search_fts: Number(this.scalar<number>('SELECT COUNT(*) FROM search_fts') ?? 0),
    };
  }

  /** 裸 FTS5 查询（MATCH 表达式由 `search.ts` 用 bigram 构造）。bm25 越小越相关。 */
  ftsSearch(expr: string, opts: { docId?: string; limit?: number } = {}): FtsHitRow[] {
    let sql =
      'SELECT d.ref_id AS ref_id, d.doc_id AS doc_id, d.kind AS kind, d.title AS title, ' +
      'bm25(search_fts) AS score ' +
      'FROM search_fts JOIN search_docs d ON d.rowid = search_fts.rowid ' +
      'WHERE search_fts MATCH ?';
    const params: unknown[] = [expr];
    if (opts.docId) {
      sql += ' AND d.doc_id = ?';
      params.push(opts.docId);
    }
    sql += ' ORDER BY score LIMIT ?';
    params.push(Math.max(1, Math.trunc(opts.limit ?? 20)));
    return this.all<FtsHitRow>(sql, ...params);
  }

  /** 某文档的 FTS 命中总数。 */
  ftsCount(expr: string, docId?: string): number {
    let sql =
      'SELECT COUNT(*) AS c FROM search_fts JOIN search_docs d ON d.rowid = search_fts.rowid ' +
      'WHERE search_fts MATCH ?';
    const params: unknown[] = [expr];
    if (docId) {
      sql += ' AND d.doc_id = ?';
      params.push(docId);
    }
    return Number(this.get<{ c: number }>(sql, ...params)?.c ?? 0);
  }
}

/**
 * 坑 15 的**对照实验**：把同样的正文灌进 `tokenize='unicode61'`（FTS5 默认）的临时表，
 * 返回命中数。同库同文本下 bigram > 0 而 unicode61 == 0 —— 这就是 bigram 必要性的可复现证明。
 *
 * 用**独立的 `:memory:` 库**，不污染主库、不参与外键/事务（与 v1 的 `contrast_fts` 同思路）。
 */
export function contrastUnicode61(q: string, texts: Iterable<string>): number {
  const mem = new Database(':memory:');
  try {
    mem.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='unicode61')");
    const ins = mem.prepare('INSERT INTO t(body) VALUES(?)');
    for (const t of texts) if (t) ins.run(t);
    // unicode61 不切中文 → 查询词必须整段引号包裹，否则是语法错
    const expr = `"${q.replace(/"/g, '""')}"`;
    const row = mem.prepare('SELECT COUNT(*) AS c FROM t WHERE t MATCH ?').get(expr) as { c: number };
    return Number(row.c);
  } catch {
    return 0;
  } finally {
    mem.close();
  }
}
