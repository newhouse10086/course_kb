# 接口协议（API Protocol）

> **本文件是并行开发的唯一契约。** 任何实现与本文不一致 → 视为 bug。
> 版本 v1.0 ｜ 2026-10-14

---

## 目录

1. [约定](#1-约定)
2. [数据模型](#2-数据模型)
3. [SQLite Schema](#3-sqlite-schema)
4. [Adapter 契约](#4-adapter-契约最重要)
5. [REST API](#5-rest-api)
6. [SSE 事件流](#6-sse-事件流)
7. [pi RPC 桥协议](#7-pi-rpc-桥协议)
8. [错误码](#8-错误码)
9. [版本与兼容](#9-版本与兼容)

---

## 1. 约定

### 1.1 基础

| 项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8787` |
| 前缀 | `/api/v1` |
| 编码 | UTF-8 |
| 时间 | **毫秒时间戳（int）**，不用 ISO 字符串 |
| ID | 字符串，`<前缀>_<12位随机>`，如 `doc_a1b2c3d4e5f6` |
| 分页 | `?offset=0&limit=50`，响应含 `total` |

### 1.2 ⚠️ 关键约定（踩过坑的）

| # | 约定 | 理由 |
|---|---|---|
| C1 | **所有 LLM 调用并发 = 1** | 用户明确要求；并发跑推理不合适 |
| C2 | **结构化输出必须 `json_schema` + `strict:true`** | `json_object` 不强制 enum（实测模型输出 `"etype":"常用实现"`） |
| C3 | **边类型/卡片 kind 必须来自 `schema/*.json`**，不许硬编码，更不许发明 | 封闭枚举 |
| C4 | **长任务必须落盘断点**，中断可续 | 52 分钟抽取曾差点全丢 |
| C5 | **删除文件前先写暂存目录，再原子替换** | 曾先删后写导致全丢 |
| C6 | **前端页面数据内联**（若走 `file://`）或经 API（若走 http） | `file://` 下 fetch 被 CORS 拦 |
| C7 | 标识符（`SELECT`/`sql_mode`/`InnoDB`）**保留英文**，不译 | 翻译会造成无法检索 |
| C8 | 页码/时间戳**必须可回溯原文** | 证据链是可核查性的基础 |

---

## 2. 数据模型

### 2.1 Document（文档）

```json
{
  "id": "doc_a1b2c3d4e5f6",
  "title": "MySQL 26.7 Reference Manual",
  "kind": "pdf",
  "source_path": "data/uploads/doc_a1b2c3d4e5f6/original.pdf",
  "size_bytes": 44160000,
  "page_count": 6392,
  "lang": "en",
  "status": "ready",
  "meta": { "toc_entries": 2545, "chapters": 42 },
  "created_at": 1760400000000,
  "updated_at": 1760400000000
}
```

**`kind` 枚举**：`pdf` | `pptx` | `docx` | `video` | `epub` | `web` | `text`
**`status` 枚举**：`uploading` | `parsing` | `extracting` | `ready` | `failed`

### 2.2 Unit（切分单元）

```json
{
  "id": "unt_0001",
  "doc_id": "doc_a1b2c3d4e5f6",
  "order": 12,
  "title": "7.4.2.6 Rule-Based Error Log Filtering",
  "level": 4,
  "parent_id": "unt_0011",
  "span": { "kind": "page", "start": 1040, "end": 1045 },
  "text": "The log_filter_dragnet log filter component enables...",
  "text_len": 8421
}
```

**`span.kind`**：

| kind | 适用 | 字段 |
|---|---|---|
| `page` | PDF/EPUB | `start`/`end` = 页码（1-based，**可回溯**） |
| `slide` | PPTX | `start`/`end` = 幻灯片号 |
| `time` | Video | `start`/`end` = **毫秒** |
| `char` | Text/Web | `start`/`end` = 字符偏移 |

### 2.3 Card（知识卡片）

**字段定义以 `schema/knowledge_card.json` 为唯一权威**（22 种 kind）。

```json
{
  "id": "crd_0001",
  "doc_id": "doc_a1b2c3d4e5f6",
  "unit_id": "unt_0001",
  "name": "log_filter_dragnet",
  "kind": "log_filter",
  "one_line": "一个可加载的错误日志过滤器组件，按用户自己写的规则决定哪些错误写入日志",
  "purpose": "让 DBA 精确控制错误日志内容，避免日志被淹没",
  "usage_mode": "user_invoked",
  "operational_role": "diagnostics",
  "lifecycle": "install_then_use",
  "example": "INSTALL COMPONENT 'file://component_log_filter_dragnet';",
  "example_explained": "先安装组件，再把它插入处理链…",
  "prerequisites": ["必须先 INSTALL COMPONENT 加载过滤器组件"],
  "cautions": ["使用它会忽略 log_error_suppression_list"],
  "evidence_quote": "The log_filter_dragnet log filter component enables…",
  "evidence_span": { "kind": "page", "start": 1040, "end": 1040 },
  "confidence": 0.95
}
```

**`evidence_span`** 是**可回溯的锚点**：
- PDF → 页码 → 前端生成 `原文.pdf#page=N`
- Video → 毫秒 → 前端 `video.currentTime = N/1000`

### 2.4 Entity / Edge（图谱）

```json
{
  "id": "ent_0001",
  "doc_id": "doc_a1b2c3d4e5f6",
  "name": "InnoDB clustered index",
  "name_zh": "InnoDB 聚簇索引",
  "layer": "L2",
  "type": "feature",
  "degree": 6
}
```

```json
{
  "id": "edg_0001",
  "doc_id": "doc_a1b2c3d4e5f6",
  "src_id": "ent_0001",
  "dst_id": "ent_0002",
  "etype": "IMPLEMENTS",
  "evidence_text": "InnoDB uses a B-tree data structure …",
  "evidence_span": { "kind": "page", "start": 3174, "end": 3174 },
  "confidence": 0.95,
  "flagged": false
}
```

> **`etype` 必须来自 `schema/edge_types.json` 的 12 种。**
> **`flagged`**：因果可疑**只标记不删除**（曾因过度校验删掉真边）。

### 2.5 Cross-Reference（交叉引用）

```json
{
  "from_card_id": "crd_0001",
  "to_card_id": "crd_0087",
  "rel": "mention",
  "weight": 1
}
```

**`rel` 枚举**（**顺序即优先级**）：

| rel | 含义 | 生成方式 |
|---|---|---|
| `typed` | 图谱类型化边 | 来自 Edge |
| `mention` | 正文提及 | 文本匹配 + **假阳性过滤**（见下） |
| `also_in` | 跨单元复现 | 同名卡片出现在多个 Unit |
| `same_unit` | 同单元知识点 | 同 Unit 内其他卡片 |

**⚠️ mention 的假阳性过滤（必做，否则页面全是噪音）**

实测：不过滤时 `USE` 被引用 **198** 次、`AND` **183** 次 —— 因为它们在英文原文里是**普通单词**。

```
规则：
  1. 名字含中文 或 含符号 ( ) [ ] . - _ @ # $ %  → 是标识符，**允许**
  2. 名字在 NOISE 集合（use/and/or/not/in/is/as/on/to/by/if/for/all/any/set/key/
     desc/path/date/char/time/text/blob/view/index/table/value/name/type/user/
     host/port/file/test/data/event）→ **拒绝**
  3. 名字长度 < 6 或含空格 → 必须**以全大写代码形式**出现 → 否则**拒绝**
  4. 其余 → 允许

过滤效果：783 → 274（丢弃 566 假阳性），USE/AND → 0
```

### 2.6 Task（后台任务）

```json
{
  "id": "tsk_0001",
  "doc_id": "doc_a1b2c3d4e5f6",
  "kind": "extract",
  "status": "running",
  "progress": 0.42,
  "stage": "抽取知识卡片",
  "detail": { "done": 42, "total": 100 },
  "error": null,
  "created_at": 1760400000000,
  "finished_at": null
}
```

**`kind` 枚举**：`parse` | `extract` | `rollup` | `translate` | `asr` | `slides` | `mindmap` | `index`
**`status` 枚举**：`queued` | `running` | `done` | `failed` | `cancelled`

### 2.7 VideoArtifact（视频产物）

```json
{
  "id": "vid_0001",
  "doc_id": "doc_a1b2c3d4e5f6",
  "duration_ms": 3720000,
  "asr_model": "faster-whisper/base",
  "asr_lang": "zh",
  "segments": [
    { "i": 0, "start": 1200, "end": 4800, "text": "今天我们讲索引…", "confidence": 0.91 }
  ],
  "subtitles": { "srt": "data/artifacts/vid_0001/subtitle.srt",
                 "vtt": "data/artifacts/vid_0001/subtitle.vtt" },
  "transcript": [ { "title": "第一章 索引原理", "start": 0, "end": 480000,
                    "text": "…", "summary": "…" } ],
  "mindmap": { "format": "markmap", "content": "# 索引\n## B+树\n..." },
  "slides": [ { "index": 1, "at_ms": 30000, "image": "…/slide_001.jpg",
                "ocr_text": "…", "title": "索引结构" } ]
}
```

---

## 3. SQLite Schema

> 引擎：SQLite 3 ｜ 中文检索用 **bigram 预处理**（`unicode61` 对中文 0 命中）

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE documents (
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
CREATE INDEX idx_doc_status ON documents(status);

CREATE TABLE units (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  level INTEGER DEFAULT 1,
  parent_id TEXT,
  span_kind TEXT NOT NULL,        -- page|slide|time|char
  span_start INTEGER NOT NULL,
  span_end INTEGER NOT NULL,
  text TEXT DEFAULT '',
  text_len INTEGER DEFAULT 0
);
CREATE INDEX idx_unit_doc ON units(doc_id, ord);
CREATE INDEX idx_unit_parent ON units(parent_id);

CREATE TABLE cards (
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
  name_key TEXT NOT NULL          -- 规范化名（小写+去空格），用于交叉引用
);
CREATE INDEX idx_card_doc ON cards(doc_id);
CREATE INDEX idx_card_unit ON cards(unit_id);
CREATE INDEX idx_card_key ON cards(doc_id, name_key);

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_zh TEXT DEFAULT '',
  layer TEXT DEFAULT '',
  type TEXT NOT NULL,
  degree INTEGER DEFAULT 0,
  name_key TEXT NOT NULL
);
CREATE INDEX idx_ent_doc ON entities(doc_id);
CREATE INDEX idx_ent_key ON entities(doc_id, name_key);

CREATE TABLE edges (
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
CREATE INDEX idx_edge_src ON edges(src_id);
CREATE INDEX idx_edge_dst ON edges(dst_id);
CREATE INDEX idx_edge_type ON edges(doc_id, etype);

CREATE TABLE xrefs (
  from_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  to_card_id   TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  rel TEXT NOT NULL,
  weight INTEGER DEFAULT 1,
  PRIMARY KEY (from_card_id, to_card_id, rel)
);
CREATE INDEX idx_xref_to ON xrefs(to_card_id);

CREATE TABLE tasks (
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
CREATE INDEX idx_task_doc ON tasks(doc_id);
CREATE INDEX idx_task_status ON tasks(status);

CREATE TABLE video_artifacts (
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

-- 中文全文检索：存 **bigram 预处理后** 的文本
CREATE TABLE search_docs (
  id TEXT PRIMARY KEY,            -- 'card:crd_0001' | 'unit:unt_0001'
  doc_id TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT DEFAULT '',
  body_bi TEXT NOT NULL           -- bigram 化后的文本
);
CREATE VIRTUAL TABLE search_fts USING fts5(
  title, body_bi, content='search_docs', content_rowid='rowid'
);
```

**⚠️ bigram 规则**（实测唯一有效的方案）：

```python
def to_bigram(s: str) -> str:
    """把中文切成 bigram，英文保持整词。空格分隔。"""
    # "索引优化" → "索引 引优 优化"
    # "B+tree index" → "B+tree index"
```

---

## 4. Adapter 契约（**最重要**）

**这是「多文档支持」的核心**：新增格式只实现此接口，**不改核心**。

```python
# server/adapters/base.py
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

@dataclass
class Span:
    kind: str          # page | slide | time | char
    start: int
    end: int

@dataclass
class UnitDraft:
    ord: int
    title: str
    level: int
    span: Span
    text: str
    parent_ord: int | None = None      # 用 ord 表达父子，入库时映射为 id

@dataclass
class DocDraft:
    title: str
    kind: str
    units: list[UnitDraft] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    page_count: int = 0
    lang: str = ""

class DocumentAdapter(ABC):
    """把一种文件格式变成统一的 DocDraft。"""

    kind: str = ""                       # 'pdf' | 'pptx' | 'video' | ...
    extensions: tuple[str, ...] = ()     # ('.pdf',)

    @abstractmethod
    def can_handle(self, path: str) -> bool:
        """能否处理该文件（按扩展名/魔数判断）。"""

    @abstractmethod
    def parse(self, path: str, *, on_progress=None) -> DocDraft:
        """解析文件 → DocDraft。

        约定：
          1. **必须切出层次**（units 的 level/parent_ord），不要把整个文档当 1 个 unit
          2. **span 必须可回溯原文**（页码 / 页码 / 毫秒）
          3. 长任务**必须**在内部定期落盘断点（见 C4）
          4. on_progress(frac: float, stage: str) 用于上报进度
        """
```

**注册表**：

```python
# server/adapters/registry.py
ADAPTERS: list[type[DocumentAdapter]] = []

def register(cls):
    ADAPTERS.append(cls); return cls

def pick(path: str) -> DocumentAdapter:
    for cls in ADAPTERS:
        a = cls()
        if a.can_handle(path):
            return a
    raise UnsupportedFormat(path)
```

**已规划的适配器**：

| 类 | kind | 切分依据 | span | 负责 |
|---|---|---|---|---|
| `PdfAdapter` | pdf | TOC 小节（**栈式建树**） | page | T1 |
| `SlideAdapter` | pptx | 每张幻灯片 | slide | T1 |
| `DocxAdapter` | docx | 标题层级 | char | T1 |
| `VideoAdapter` | video | ASR 段落 + 场景切换 | time | T2 |
| `TextAdapter` | text | 空行/标题 | char | T1 |
| `WebAdapter` | web | 标题层级 | char | 待定 |

**⚠️ PDF 建树的坑（必读）**：**必须用「层级+顺序」栈式算法**，不能用页码区间反推
（会导致层级跳跃 `L2→L4` 与编号矛盾 `6.5 下挂 6.4.3`）。见
`../数据库课程智能体调研/tools/build_tree.py::build_parents`。

---

## 5. REST API

### 5.1 健康与能力

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/health` | `{"ok":true,"version":"1.0.0"}` |
| GET | `/api/v1/capabilities` | 可用的 adapter / ASR / pi 状态 |

```json
// GET /api/v1/capabilities
{
  "adapters": ["pdf", "pptx", "docx", "text", "video"],
  "asr": { "available": true, "engine": "faster-whisper", "models": ["tiny","base","small"], "device": "cpu" },
  "llm": { "configured": true, "model": "deepseek-v4.1-flash" },
  "pi": { "available": true, "version": "1.2.0", "mode": "rpc" },
  "ffmpeg": { "available": true, "version": "N-124868" }
}
```

> **`capabilities` 是「诚实接口」**：某能力不可用必须如实返回 `false`，UI 据此禁用入口，
> 而不是让用户点了才报错。

### 5.2 文档

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/documents` | 上传（`multipart/form-data`，字段 `file`） |
| GET | `/api/v1/documents` | 列表（`?offset&limit&kind&status`） |
| GET | `/api/v1/documents/{id}` | 详情 |
| DELETE | `/api/v1/documents/{id}` | 删除（级联） |
| GET | `/api/v1/documents/{id}/outline` | **层次树**（供树状浏览） |
| GET | `/api/v1/documents/{id}/units` | 单元列表 |
| GET | `/api/v1/documents/{id}/cards` | 卡片列表 |
| GET | `/api/v1/documents/{id}/graph` | 图谱（nodes + edges） |
| GET | `/api/v1/documents/{id}/xrefs` | 交叉引用 |

**上传响应（202）**：

```json
{ "document_id": "doc_abc123def456",
  "task_id": "tsk_xyz789",
  "status": "uploading",
  "events_url": "/api/v1/tasks/tsk_xyz789/events" }
```

**`/outline` 响应**（层次树，前端直接渲染）：

```json
{
  "document_id": "doc_abc123def456",
  "roots": ["unt_0003"],
  "nodes": {
    "unt_0003": { "id":"unt_0003", "title":"Chapter 1 General Information",
                  "level":1, "span":{"kind":"page","start":31,"end":57},
                  "children":["unt_0005"],
                  "n_cards":0, "n_units":2,
                  "intro":"手册的使用说明与 MySQL 全貌…", "why":"上手前的第一站…" }
  }
}
```

> **`intro`/`why` 是「所有层级都要有」**（用户要求）。
> 叶子层来自 `section_summary`；上层来自 **S2 自底向上汇总**；
> **无知识点也必须给 intro**（可用 LLM 生成后缓存）。

**`/graph` 响应**：

```json
{
  "document_id": "doc_abc123def456",
  "nodes": [ { "id":"ent_0001","name":"InnoDB clustered index","name_zh":"InnoDB 聚簇索引",
               "type":"feature","layer":"L2","degree":6,
               "unit_ids":["unt_0042"] } ],
  "edges": [ { "id":"edg_0001","src":"ent_0001","dst":"ent_0002","etype":"IMPLEMENTS",
               "evidence":"…","span":{"kind":"page","start":3174,"end":3174},
               "confidence":0.95,"flagged":false } ],
  "stats": { "nodes":1644, "edges":481, "types":12, "verify_rate":0.952 }
}
```

### 5.3 卡片与交叉引用

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/cards/{id}` | 单卡片（含 `xrefs` / `backlinks`） |
| GET | `/api/v1/cards/{id}/xrefs` | 出链 |
| GET | `/api/v1/cards/{id}/backlinks` | **入链**（wiki 的精髓） |

```json
// GET /api/v1/cards/crd_0001
{
  "card": { "id":"crd_0001", "name":"CREATE TABLE", "one_line":"…" },
  "unit": { "id":"unt_0042", "title":"15.1.25 CREATE TABLE Statement" },
  "source": { "kind":"pdf", "file":"doc_abc/original.pdf", "page":2728,
              "url":"/api/v1/documents/doc_abc/file#page=2728" },
  "xrefs":     [ { "id":"crd_0087","name":"VARCHAR","rel":"mention" } ],
  "backlinks": [ { "id":"crd_0120","name":"ALTER TABLE","rel":"mention" } ]
}
```

### 5.4 检索

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/search?q=索引&doc_id=&limit=20` | 中文全文检索（bigram） |
| GET | `/api/v1/search/suggest?q=` | 补全 |

```json
{ "q":"索引", "total":37,
  "hits":[ { "kind":"card","ref_id":"crd_0001","title":"聚簇索引",
             "snippet":"…聚簇索引将数据按主键顺序存放…","score":8.2,
             "doc_id":"doc_abc" } ] }
```

### 5.5 视频

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/documents/{id}/video` | 视频产物（见 §2.7） |
| GET | `/api/v1/documents/{id}/video/subtitle?fmt=srt\|vtt` | 下载字幕 |
| GET | `/api/v1/documents/{id}/video/transcript` | 文稿（含分章） |
| GET | `/api/v1/documents/{id}/video/mindmap` | 思维导图（markmap/JSON） |
| GET | `/api/v1/documents/{id}/video/slides` | 幻灯片帧 |
| GET | `/api/v1/documents/{id}/stream` | 视频流（支持 `Range`） |
| POST | `/api/v1/documents/{id}/video/reparse` | 重跑（可指定 asr_model） |

### 5.6 任务

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/tasks/{id}` | 任务状态 |
| GET | `/api/v1/tasks/{id}/events` | **SSE 进度流** |
| POST | `/api/v1/tasks/{id}/cancel` | 取消 |

### 5.7 文件

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/documents/{id}/file` | 原始文件（支持 `Range`；PDF 用 `#page=N` 跳页） |

---

## 6. SSE 事件流

`GET /api/v1/tasks/{id}/events` → `text/event-stream`

```
event: progress
data: {"task_id":"tsk_1","progress":0.42,"stage":"抽取知识卡片","done":42,"total":100}

event: log
data: {"task_id":"tsk_1","level":"info","msg":"p1040 开始抽取"}

event: artifact
data: {"task_id":"tsk_1","kind":"subtitle","url":"/api/v1/documents/doc_abc/video/subtitle?fmt=srt"}

event: done
data: {"task_id":"tsk_1","status":"done","elapsed_ms":123456}

event: failed
data: {"task_id":"tsk_1","error":"ASR model load failed","code":"E_ASR_LOAD"}
```

**规则**：
- `event:` 后跟事件名，`data:` 是**单行 JSON**（不含裸换行）
- 每 15 秒发一次 `: keepalive` 注释帧防超时
- 任务结束（`done`/`failed`/`cancelled`）后服务端主动关闭
- 客户端断线重连用 `Last-Event-ID`，服务端从断点续推

---

## 7. pi RPC 桥协议

### 7.1 pi 原生协议（我们**必须遵守**）

**启动**：`pi --mode rpc --no-session`

**帧格式（严格 JSONL）**：

| 方向 | 记录 | 说明 |
|---|---|---|
| stdin | Command | `{"id":"req-1","type":"prompt","message":"..."}` |
| stdout | Response | `{"id":"req-1","type":"response","command":"prompt","success":true,"data":{...}}` |
| stdout | Event | `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"…"}}` |

**⚠️ pi RPC 的三个硬约束（来自官方文档，必须遵守）**

| # | 约束 | 原因 |
|---|---|---|
| P1 | **不要用 Node `readline` 或任何会把 `U+2028`/`U+2029` 当行分隔的读取器** | 它们在 JSON 字符串里合法，会**错误切帧**。按 `\n` 切字节流即可 |
| P2 | **必须持续读 stdout** | pi 遵守背压，客户端不读会**卡死进程** |
| P3 | **stdout 只走协议数据**，日志走 **stderr**，不要把 stderr 当协议解析 | — |

**常用命令**（完整 38 个见 `../pi/packages/coding-agent/docs/rpc-commands.md`）：

| 命令 | 用途 |
|---|---|
| `prompt` | 发消息（`data.disposition`: `started`/`queued`/`handled`） |
| `steer` / `follow_up` | 运行中插话 / 追加 |
| `abort` | 中断当前运行 |
| `get_state` | 取会话状态（model / thinking / tools） |
| `get_messages` | 取消息列表 |
| `set_model` / `get_available_models` | 模型切换 |
| `new_session` / `switch_session` / `fork` | 会话管理 |
| `get_session_stats` | 用量统计 |
| `bash` / `abort_bash` | 执行命令 |

**关键事件**：

| 事件 | 用途 |
|---|---|
| `agent_start` / `agent_end` / **`agent_settled`** | 运行生命周期。**`agent_settled` 才是"pi 不会再自动继续"** |
| `message_update` + `text_delta` | **流式文本**（逐字输出） |
| `thinking_delta` | 思考过程 |
| `tool_execution_start/update/end` | **工具调用可见**（UI 要展示） |
| `message_end` | 权威完整消息 |

> ⚠️ **`prompt` 响应 ≠ 完成**。它只说明"已受理/已排队"。
> 必须等 `agent_settled` 才认为这一轮结束。

### 7.2 我们的桥（Web ↔ pi）

**WebSocket** `ws://127.0.0.1:8787/api/v1/chat/{session_id}`

**客户端 → 服务端**：

```json
{ "type": "prompt",  "message": "解释一下聚簇索引", "steer": false }
{ "type": "steer",   "message": "用更短的例子" }
{ "type": "abort" }
{ "type": "set_model", "model": "deepseek-v4.1-flash" }
{ "type": "new_session" }
```

**服务端 → 客户端**（**复用 pi 事件名**，见 §7.3 映射）：

```json
{ "type":"ready",        "session_id":"pi_abc", "model":"…", "tools":["read","bash"] }
{ "type":"retrieval",    "mode":"wiki", "status":"ok", "available":true, "hits":2,
                         "elapsedMs":1240, "why":["bigram 命中「聚簇索引」"],
                         "reason":"", "sources":[{"kind":"unit","ref_id":"unt_0001","title":"3.1 聚簇索引"}] }
{ "type":"text_delta",   "delta":"聚簇" }
{ "type":"thinking_delta","delta":"先确认…" }
{ "type":"tool_start",   "id":"call_1", "tool":"read", "args":{...} }
{ "type":"tool_update",  "id":"call_1", "partial":"…" }
{ "type":"tool_end",     "id":"call_1", "ok":true, "duration_ms":120 }
{ "type":"message_end",  "message":{...} }
{ "type":"settled",      "aborted":false }
{ "type":"error",        "code":"E_PI_EXIT", "msg":"pi process exited" }
```

> **共 10 种帧**（原清单漏了 `retrieval` —— 由独立验收发现：契约 `RETRIEVAL.md` §4 要求它，
> 而实现的服务端**已算出 `retrievalStatus`/`retrievalReason` 并写进 audit，却没发给客户端**，
> 导致学生无法知道这次回答有没有用知识库、用的哪种检索）。
>
> **`retrieval` 帧的两条硬约束**：
> 1. **每轮恰好一帧**，且必须在**检索处理完、发 prompt 给 SDK 之前**发出（顺序：`ready → retrieval → …`）
> 2. ★ **`status` 必须显式区分五种情况**：`none`（没查库）/ `ok`（命中）/ **`empty`（查了但 0 命中）** /
>    `unavailable`（能力不可用）/ `error`。
>    **`available` 单字段表达不了这个区分** —— `none` 与 `empty` 都是 `available:true`，
>    但"没查库"与"查了没命中"对学生是完全不同的信息（这正是"四种检索各自独立"的可见性基础）。
> 3. **不可用/出错也要发帧**（`available:false` + 可读 `reason`）——
>    否则"没发帧"与"没检索"分不清。
> 4. **帧里不带正文片段**（`sources` ≤5 条，只有 id/title/kind/score）。

### 7.3 事件映射（pi → 我们的桥）

| pi 事件 | 我们的桥 | 说明 |
|---|---|---|
| `message_update` + `text_delta` | `text_delta` | 直通 |
| `message_update` + `thinking_delta` | `thinking_delta` | 直通 |
| `tool_execution_start` | `tool_start` | 改名（更短） |
| `tool_execution_update` | `tool_update` | 直通 |
| `tool_execution_end` | `tool_end` | 加 `ok` |
| `message_end` | `message_end` | **仅转发非 system 角色**（见下 ⚠️6） |
| **`agent_settled`** | **`settled`** | **一轮结束的唯一信号**。桥补 `aborted`/`abort_source`（见 ⚠️1） |
| `agent_end` | （**不转发**） | 见下 ⚠️2 |
| `auto_retry_start` / `auto_retry_end` | （可选转发） | 有重试时让 UI 知情 |
| 模型/凭据失败 | **`error` + `code:E_LLM`** | 见下 ⚠️7 |

### 7.3.1 Lead 裁定（v1.1，回应 pi-bridge 实测 5 条）

**⚠️1 `agent_settled` 正常结束时没有 `aborted` 字段**

```
正常结束: {"type":"agent_settled"}                    ← 无 aborted
中断时:   {"type":"agent_settled","aborted":true}     ← 才有
```
→ 桥必须 `bool(record.get("aborted", False))`，**直接取会 KeyError**。

**裁定**：桥**补标记**——真机实测 pi 在「abort 取消重试」路径下 `agent_settled`
**不带 `aborted`**，但桥知道是我们发的 abort，故补
`aborted:true, abort_source:"client"`（**仅当 pi 没标时**）。✅ 采纳

**⚠️2 `agent_end` 会出现多次，`agent_settled` 只出现一次**

实测一次失败 prompt（3 次重试）：`agent_end` ×3，`agent_settled` ×1。
→ 「**`agent_end` 不转发**」**实测正确且必要**：转发会让 UI **提前置空闲 3 次**。

**⚠️3 `message_start`/`message_end` 里 system 消息的 `content` 是空串**
真提示词在 `sections.{preamble,tools}` → 桥**不解析 `content`**。

**⚠️4 会话文件命名与恢复**
```
实际文件名: <ISO时间戳>_<session-id>.jsonl
恢复靠 --session-id + --session-dir，不要猜文件名
```
**⚠️5 `get_state.data.sessionFile`** → 放进 `ready` 帧（可观测的持久化）。

**⚠️6 ★ `message_end` 的 system 角色：裁定「不转发」**

实测：直通会把 **系统提示词 + 本项目 `AGENTS.md` 全文**推给浏览器，
**单帧最大 11038 字符，每轮都推一次**。

**裁定：`message_end` 只转发非 `system` 角色的消息。**
理由（三条，任一条都足够）：
1. **安全/隐私**：系统提示词与项目内部指令**不应暴露给浏览器端用户**
2. **载荷**：每轮多推 ~11KB，纯浪费
3. **UI 无用**：前端只需要 assistant 的 `message_end`

> 这是**契约变更**，但方向是收紧而非放松，不构成兼容性问题。
> 保留方式：若将来确需（如管理员视图），用**显式开关**而非默认直通。

**⚠️7 `E_LLM` 帧（模型/凭据侧失败）**

pi 的失败序列（`auto_retry_end success=false`）必须映射为：
```json
{"type":"error","code":"E_LLM",
 "msg":"403: ... An active OpenCode Go subscription is required ...",
 "hint":"pi 桥正常，失败发生在模型/凭据侧（已自动重试 3 次）",
 "detail":"auto_retry_end success=false; attempts=3"}
```
**理由**：否则用户只看到"空回复"而不知为何。
`hint` 是**关键**——它要能让人一眼区分「**桥坏了**」与「**桥是好的，模型/订阅有问题**」。

**⚠️8 扩展错误码**（补进 §8）

| code | 含义 | 与既有码的区别 |
|---|---|---|
| `E_PI_CMD` | 命令返回 `success:false` | 区别于**进程退出**（`E_PI_EXIT`）：进程没死但命令失败 |
| `E_PI_PROTOCOL` | 收到坏帧（JSON 解析失败） | — |
| `E_PI_UNAVAILABLE` | 三档全失败 | — |
| `E_PI_SESSION_ID` | 非法的 session id | — |

**理由**：复用 `E_PI_EXIT` 会报「进程死了」但**进程其实活着** —— 误导排查方向。

**⚠️9 `ready` 帧扩展字段**

```
tier, version, tools_source, persistence, persistence_reason,
session_file, pi_session_id, restarted
```
**注意**：`session_id` 是**浏览器会话 id**，pi 自己的是 **`pi_session_id`**，**两者不许混用**。
`persistence` / `persistence_reason` 让「持久化是否真生效」**可观测**。

#### ⚠️ 严重程度：`available` 的语义边界

`pi.available=true` 表示「**pi RPC 可用**」，**不表示模型可用**。
模型/凭据失败是**运行期**事件（`E_LLM`），不是能力探测结果。
**报 `available:false` 才是撒谎**（桥明明是好的）。这个区分必须保留。

#### P1（U+2028）证据的**范围说明**

⚠️ **出站与入站是两个方向，不能互相证明**：
- **出站（我们 → pi）**：采用 `json.dumps(..., ensure_ascii=True)` → U+2028 一律转义为 `\u2028`，
  **我们发出的字节里永远不会出现裸 U+2028** → **主动消除**该风险（比"依赖 pi 容忍"更强）。
- **入站（pi → 我们）**：必须靠**假 JSONL 字节流单元测试**证明（构造 `b'{"a":"\xe2\x80\xa8"}\n'`，断言不被错切）。
  真实端到端无法证明（模型不出文本时拿不到含 U+2028 的记录）。

> **教训**：一个方向通过的测试，**不能推断另一个方向**。

### 7.4 会话与持久化

> ⚠️ **契约勘误（v1.0 → v1.1）**：初版此处与 §7.1 的 `--no-session` **自相矛盾**
> —— `--no-session` 是不落盘，与"存原生 session 并恢复"不能同时成立。
> 由 pi-bridge 在实现时发现，裁定按下述方案（**已实测 1.0.2 支持这两个 flag**）：

```
默认 persist=True:
  pi --mode rpc --session-dir <course-kb>/data/chat --session-id <sid> --name <sid>
  → pi 自己写原生格式（见 ../pi/.../session-format.md），重启自动恢复

persist=False 或 探测到 flag 不支持:
  → 自动回落到 --no-session
```

**硬要求**：
- 回落必须**自动**且**可观测** —— 实际用的模式与原因必须出现在 `/capabilities` 与 `ready` 帧里，
  **不许让 UI 以为有持久化其实没有**。
- 每个浏览器会话 ↔ **一个 pi 子进程**；空闲 30 分钟回收。

### 7.5 pi 的启动方式（三档降级）

| 档 | 方式 | 命令 | 何时用 |
|---|---|---|---|
| **A** | 源码仓库 | `node ../pi/packages/coding-agent/dist/cli.js --mode rpc` | 已 `npm run build` |
| **B** | npm 全局包 | `<shutil.which("pi")> --mode rpc` | 装了 `@earendil-works/pi-coding-agent` |
| **C** | 都不可用 | `/capabilities` 返回 `pi.available=false` + `reason`，UI **禁用**对话入口并**说明原因** | — |

**优先级**：A → B（契约固定）；可用 `PI_PREFER=global` 翻转为 B 优先。

#### ⚠️ Windows 实测（本机验证，必须遵守）

| 事实 | 细节 |
|---|---|
| `pi` 在 Windows 是 **`.CMD` 包装器** | `shutil.which("pi")` → `...\npm\pi.CMD` |
| **`Popen(["pi",...])` 会 FileNotFoundError** | PATH 里只有 `.CMD`/`.ps1`，后者不被解析 |
| **正确做法** | **`.CMD` 全路径 + argv 列表**（实测可跑）。**不要用 `shell=True` 作主路径** —— 本项目路径含**空格 + 中文**（`D:\temp临时脚本\26-10-13 数据库数据仓库课程优化`），`shell=True` 需引号转义且有注入面 |
| `shell=True` 仅作兜底 | — |

#### ⚠️ 探测必须「真握手」，不能只看文件存在

```
probe()      路径解析 + --version 真实执行；结果缓存 300s    → 供 /capabilities，快
verify_rpc() 真起进程 → 发 get_state → 等带 id 的响应，超时判该档不可用 → 自动降级
```
**理由**：实测遇到过"命令在但启动即退"。只看文件存在会给**假绿**。

#### 实测的 `get_state` 响应（1.0.2，**照抄字段，别猜**）

```json
{"id":"t1","type":"response","command":"get_state","success":true,
 "data":{"model":{...},"thinkingLevel":...,"isStreaming":...,
         "isCompacting":...,"steeringMode":...,"followUpMode":...,
         "sessionFile":...,"sessionId":...,"autoCompactionEnabled":...,
         "messageCount":...,"pendingMessageCount":...}}
```

> ⚠️ **1.0.2 的 `get_state` 没有 `tools` 字段**。若 UI 需要工具列表：
> 用**启动时显式传的 `--tools`**，并在 `ready` 帧附 `tools_source`（`"explicit"` / `"none"`）标明来源。
> **不许凭空编造工具列表。**

> **不要求构建**：A→B 任一可用即可；都不可用则**如实降级**（C 档），不许假装可用。

---

## 8. 错误码

| code | HTTP | 含义 | UI 处理 |
|---|---|---|---|
| `E_NOFILE` | 400 | 未提供文件 | 提示 |
| `E_FORMAT` | 415 | 不支持的格式 | 列出支持的格式 |
| `E_TOOBIG` | 413 | 超过大小限制 | 提示上限 |
| `E_NOTFOUND` | 404 | 资源不存在 | — |
| `E_PARSE` | 422 | 解析失败 | 显示原因 + 原始文件可下载 |
| `E_LLM` | 502 | LLM 调用失败 | 可重试 |
| `E_LLM_SCHEMA` | 502 | 模型输出不符合 schema | 自动重试 3 次后报错 |
| `E_ASR_LOAD` | 503 | ASR 模型加载失败 | 提示换更小模型或改用云端 |
| `E_FFMPEG` | 500 | ffmpeg 失败 | 显示 ffmpeg stderr 摘要 |
| `E_PI_EXIT` | 502 | pi 子进程退出 | 自动重启一次，再失败则禁用对话 |
| `E_PI_TIMEOUT` | 504 | pi 超时 | 可中断重试 |
| `E_BUSY` | 429 | 任务队列满 | 排队或稍后 |
| `E_UNAUTHENTICATED` | 401 | **未登录 / 会话失效** | 跳登录页（**不是显示空数据**） |
| `E_FORBIDDEN` | 403 | 已登录但无权访问该资源 | 提示无权限 + 说明需要什么角色 |
| `E_ACCOUNT_DISABLED` | 403 | 账号被禁用 | 提示联系管理员（**旧 cookie 立即失效**） |
| `E_BADREQUEST` | 400 | 请求字段不合法（如缺 `username`） | 指明哪个字段 |
| `E_CONFLICT` | 409 | 唯一性冲突（如用户名已存在） | 提示换一个 |
| `E_QUOTA` | 429 | **该用户**的并发/配额超限 | 提示稍后 + 显示配额；**教师任务优先，不会被学生饿死** |
| `E_MODEL_BUSY` | 409 | 有批量推理在跑，**拒绝直接热切换模型** | 提示「终止并切换」或等 `drain` |
| `E_MODEL_PROBE` | 502 | 新模型探测失败 → **已回滚到旧模型** | 显示回滚 + 失败原因 |
| `E_SANDBOX_FORBIDDEN` | 403 | SQL 被安全闸拒绝（`ATTACH`/`load_extension`/多语句…） | 显示原因 + 说明为何禁止 |
| `E_SANDBOX_MULTI` | 400 | 一次只能执行**单条**语句 | 提示拆开执行 |
| `E_SANDBOX_PATH` | 400 | 沙箱路径越界 | 拒绝（不提示内部路径） |
| `E_SANDBOX_TIMEOUT` | 408 | 查询超时被中断 | **明确说明"不是语法错"** + 常见原因；区分 `killedBy=progress`（语句层中断）/ `process`（进程级硬杀） |
| `E_LOG_ISOLATION` | 403 | 请求的日志不属于该会话 | 拒绝（**跨用户读日志**） |

> ⚠️ **`E_FORMAT` 是 415（文件格式不支持），不是 400（字段不合法）** ——
> 用 `E_FORMAT` 表示"少传了 username"会给前端误导性状态码，所以另立 `E_BADREQUEST`。
>
> ⚠️ **`E_QUOTA` 与 `E_BUSY` 语义不同**：`E_BUSY` 是**全局**队列满（大家都等），
> `E_QUOTA` 是**该用户**超了自己的配额（别人还能跑）。前端文案要区分。
>
> ⚠️ **未登录必须是 401，不是 200 + 空列表** ——
> "返回空数据冒充成功"是本项目明令禁止的失败模式（见 `AGENTS.md` 坑清单判据）。

**错误响应体**：

```json
{ "error": { "code": "E_ASR_LOAD", "msg": "faster-whisper base 模型加载失败",
             "detail": "…", "hint": "可改用 tiny 模型" } }
```

---

## 9. 版本与兼容

- 路径带版本：`/api/v1/…`。**破坏性变更必须升 v2**，不静默改语义。
- `schema/edge_types.json` 与 `schema/knowledge_card.json` 是**数据契约**：
  新增枚举值 = **兼容**（前端未知值降级为原文显示）；**删除/改名 = 破坏性**。
- `/capabilities` 是**能力协商入口**：前端必须**按能力渲染**，不许假设某功能一定在。
- **不要发明枚举**。12 种边 + 22 种 kind 是封闭集合。

---

## 附：快速自检清单（每个 teammate 交付前）

- [ ] 所有响应字段与 §2 数据模型一致（含 `span` / `confidence`）
- [ ] 新增格式只实现 §4 的 `DocumentAdapter`，**没改核心**
- [ ] 长任务有断点（C4）+ 有 SSE 进度
- [ ] SSE 帧格式符合 §6（单行 JSON + keepalive）
- [ ] pi 桥遵守 P1/P2/P3（**不用 readline**、**持续读 stdout**、**stderr 不当协议**）
- [ ] 等 `agent_settled` 而非 `prompt` 响应判定结束
- [ ] 能力不可用时**如实降级**（`/capabilities` + UI 禁用 + 说明原因）
- [ ] 测试断言**具体值**，不是"非空"
