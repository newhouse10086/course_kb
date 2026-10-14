"""知识卡片 + 图谱抽取的**纯函数核心**（v2 worker）。

与 v1 `worker/pipeline/extract.py::Extractor` 的区别：

| | v1 Extractor | 本模块 |
|---|---|---|
| 依赖 | SQLite ``Repo``（v1 存储层） | **零存储依赖**（输入 units，输出 JSON 可序列化结果） |
| 凭据 | 读环境变量 | **从 job 参数传入**（架构 v2 §3：provider/凭据归 Node 层） |
| 调用者 | FastAPI 任务 | ``worker/cli.py``（JSONL 协议） |

本文件是抽取逻辑的**唯一实现**；``extract.py`` 只保留 v1 的 DB 包装
（提示词 / schema / 断点类都从这里 re-export，避免两份提示词漂移）。

硬要求（保持不退化）：
* **并发 = 1**（由 :class:`worker.pipeline.llm.LLMClient` 的锁强制）
* ``json_schema`` + ``strict: true`` + ``additionalProperties: false``（坑 4）
* 边类型 / kind 只能来自 ``contracts/schema/*.json``（封闭枚举）
* 每单元**落盘断点**（契约 C4），原子替换（C5）
* 单元划分 = 递归下降 + 引言段（坑 5，见 :mod:`worker.pipeline.units`）
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, NamedTuple, Sequence

from worker.config import Settings, get_settings
from worker.models import Card, Edge, Entity, ExtractedGraph, Span, Unit, id_for, name_key
from worker.models.schema_enums import (
    card_kinds,
    edge_type_docs,
    edge_types,
    entity_types,
    layers,
    lifecycles,
    operational_roles,
    section_roles,
    usage_modes,
)
from worker.pipeline import units as units_mod
from worker.pipeline.llm import LLMClient, LLMError, LLMResult

log = logging.getLogger(__name__)

CARD_SYSTEM_PROMPT = """你是**数据库课程的知识工程师**，把 {source_name} 编译成**学生能直接读懂的知识卡片**。

## 你的读者
学过基础 SQL、但对 MySQL 内部不熟的学生。他们想知道：
  · 这个东西**是什么**（一句话，不用查别的就能懂）
  · 它**能做什么**、解决什么问题
  · 是**我主动去用的**，还是**服务器自动在跑的**
  · 是**实现功能**的，还是**维护/监控/安全**用的
  · **怎么用**（有示例就给示例，并说清示例在干什么）
  · 有什么**坑**（注意事项）

## 关键要求

### 1. kind —— 这个东西到底是什么
从枚举里选。特别注意区分：
  · `component` / `plugin` / `log_sink` / `log_filter` = 服务器组件（通常要 INSTALL）
  · `client_program` / `utility_program` / `server_program` = 可执行程序
  · `system_variable` / `status_variable` = 配置项 / 状态项
  · `sql_statement` / `sql_clause` / `function` = SQL 语言成分
  不要一律标 concept。

### 2. one_line —— 一句话定义
必须让**不懂 MySQL 的人**看懂。反例：
  ✗ "log_filter_dragnet 是一个日志过滤组件"（同义反复，没说清）
  ✓ "一个错误日志过滤器，按你写的规则（IF 条件 THEN 动作）筛选哪些错误写入日志"

### 3. purpose —— 能做什么（不要复述 one_line）
  ✗ "用于日志过滤"（等于没说）
  ✓ "让 DBA 只保留关心的错误（如只记 ERROR 级、或节流重复错误），避免日志被淹没"

### 4. usage_mode —— 谁在用它
  · `user_invoked`：用户主动敲命令/写配置（如 mysqldump、SET GLOBAL）
  · `server_automatic`：服务器内部自动运行，用户不直接调用（如 log_sink_internal）
  · `both`：两者都有
  · `internal`：纯内部机制（如 buffer pool）
  · `unknown`：原文没说清

### 5. operational_role —— 干什么用的
`feature`(实现业务功能) / `maintenance`(运维) / `performance`(性能) /
`security`(安全) / `diagnostics`(诊断) / `replication`(复制) /
`storage`(存储) / `configuration`(配置)

### 6. example / example_explained
  · example：**原文中的代码，逐字照抄**。没有就填 null，**绝不自己编**
  · example_explained：用**中文**说清这段代码在干什么。例：
      example: `SET GLOBAL log_error_services = 'log_filter_dragnet; log_sink_internal';`
      example_explained: "把错误日志的『过滤器』换成 dragnet，日志仍写入内置文件。
                          注意 GLOBAL 只在本次运行有效，重启会丢——要持久化得用 SET PERSIST。"

### 7. cautions —— 坑
原文中的 Note / Warning / "be careful" / "is ignored" 之类。没有则空数组。

### 8. section 级概括
  · section_summary：2-3 句说清**这节讲什么**
  · learning_objectives：3-5 条，动词开头（"能区分…"、"会配置…"）
  · section_role：这节的体裁（concept_intro / how_to / reference / ...）

## 诚实原则（最重要）
  · **原文没说的，填 `unknown` 或 null，绝不编造**
  · `prerequisites`/`cautions` 没提到就给空数组
  · `confidence` 反映信息完整度：信息稀疏时**必须低**
  · 宁可少写，也不要写看起来合理但原文没说的内容

## 附：同时输出知识图谱（PROMPTS.md §附「已知需要改进的点」第 1 条）

EDGE TYPES (exactly one of these 12; never invent):
{edge_rules}

STRICT RULES:
1. evidence_text MUST be copied VERBATIM from the input (a contiguous substring).
2. Only extract relations the text ACTUALLY states. Never infer.
3. The edge TYPE must match the semantic definitions above. If unsure, OMIT the edge.
   A verbatim quote does NOT justify a type mismatch.
4. Prefer FEW high-confidence edges over many speculative ones.
5. Entity names keep ORIGINAL English wording.
6. entities 里的 name 必须与 edges 里的 src/dst 逐字一致。"""

CARD_USER_PROMPT = """把下面这段 {source_name} 内容编译成知识卡片。

## 位置
章节路径：{path}
{range_label}：{pg_start}–{pg_end}

## {source_label}原文
{body}

## 输出
严格按 JSON schema。注意：
  · section 是**本节**的概括，cards 是本节出现的**具体知识点**
  · 只抽**有实质内容**的知识点；纯提及而无解释的，one_line 可写但 confidence 要低
  · 标识符（命令/函数/变量名）保留英文，不翻译"""


def edge_rules_block() -> str:
    """12 种边类型定义（逐字取自 PROMPTS.md §2.1，枚举值从 schema/ 读）。"""
    docs = edge_type_docs()
    lines = []
    for name in edge_types():
        d = docs.get(name, {})
        lines.append(f"- {name}: {d.get('desc', '')}")
    return "\n".join(lines)


#: 中文资料里"页码"这个词不成立（PPT/视频）
SPAN_LABELS = {
    "page": ("页码", "手册"),
    "slide": ("幻灯片", "讲义"),
    "time": ("时间戳(ms)", "讲稿"),
    "char": ("字符偏移", "材料"),
}


def build_system_prompt(source_name: str) -> str:
    return CARD_SYSTEM_PROMPT.format(source_name=source_name, edge_rules=edge_rules_block())


def build_user_prompt(
    *, source_name: str, span_kind: str, path: str, start: int, end: int, body: str
) -> str:
    range_label, source_label = SPAN_LABELS.get(span_kind, ("位置", "材料"))
    return CARD_USER_PROMPT.format(
        source_name=source_name,
        path=path,
        range_label=range_label,
        pg_start=start,
        pg_end=end,
        source_label=source_label,
        body=body,
    )


# ═══════════════════════════════════════════════════════════════════════
# JSON Schema（枚举一律来自 schema/*.json）
# ═══════════════════════════════════════════════════════════════════════
def build_extraction_schema() -> dict[str, Any]:
    """抽取输出 schema（strict 模式；``strictify`` 会把每个 object 补齐）。"""
    return {
        "type": "object",
        "properties": {
            "section": {
                "type": "object",
                "properties": {
                    "section_summary": {"type": "string"},
                    "learning_objectives": {"type": "array", "items": {"type": "string"}},
                    "section_role": {"type": "string", "enum": list(section_roles())},
                    "key_takeaways": {"type": "array", "items": {"type": "string"}},
                },
            },
            "cards": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "kind": {"type": "string", "enum": list(card_kinds())},
                        "one_line": {"type": "string"},
                        "purpose": {"type": "string"},
                        "usage_mode": {"type": "string", "enum": list(usage_modes())},
                        "operational_role": {
                            "type": "string",
                            "enum": list(operational_roles()),
                        },
                        "lifecycle": {"type": "string", "enum": list(lifecycles())},
                        "example": {"type": ["string", "null"]},
                        "example_explained": {"type": ["string", "null"]},
                        "prerequisites": {"type": "array", "items": {"type": "string"}},
                        "cautions": {"type": "array", "items": {"type": "string"}},
                        "evidence_quote": {"type": "string"},
                        "evidence_page": {"type": "integer"},
                        "confidence": {"type": "number"},
                    },
                },
            },
            "entities": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "name_zh": {"type": "string"},
                        "type": {"type": "string", "enum": list(entity_types())},
                        "layer": {"type": "string", "enum": [*list(layers()), ""]},
                    },
                },
            },
            "edges": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "src": {"type": "string"},
                        "dst": {"type": "string"},
                        "etype": {"type": "string", "enum": list(edge_types())},
                        "evidence_text": {"type": "string"},
                        "confidence": {"type": "number"},
                    },
                },
            },
        },
    }


#: strict 模式下保持可空的字段（其余一律必填 —— 这是 strict 的硬性要求）
OPTIONAL_CARD_FIELDS = {"example", "example_explained", "lifecycle"}
class Checkpoint:
    """单元级断点文件（``data/checkpoints/{doc_id}_extract.json``）。"""

    def __init__(self, path: Path, doc_id: str, model: str = ""):
        self.path = Path(path)
        self.doc_id = doc_id
        self.model = model
        self.data: dict[str, Any] = {
            "doc_id": doc_id,
            "model": model,
            "schema_version": "1",
            "started_at": int(time.time() * 1000),
            "done": {},
            "stats": {},
        }
        self.load()

    def load(self) -> bool:
        if not self.path.exists():
            return False
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("断点损坏，忽略：%s（%s）", self.path, exc)
            return False
        if raw.get("doc_id") != self.doc_id:
            log.warning("断点属于其它文档（%s），忽略", raw.get("doc_id"))
            return False
        if raw.get("model") and self.model and raw["model"] != self.model:
            log.warning("断点模型不同（%s → %s），忽略", raw["model"], self.model)
            return False
        self.data.update(raw)
        return True

    @property
    def done_keys(self) -> set[str]:
        return set((self.data.get("done") or {}).keys())

    def mark(self, key: str, info: dict[str, Any]) -> None:
        self.data.setdefault("done", {})[key] = info

    def save(self) -> None:
        """**原子替换**：先写临时文件再 os.replace。

        ✗ 曾经的错误写法：直接 ``open(path,'w')`` 覆盖 —— 中途异常会留下半个 JSON，
          下一次续跑就读不出来了（上游曾因"先删后写"丢过整批产物）。
        """
        # 身份字段以构造参数为准：否则旧断点里的空 model 会把当前模型覆盖掉，
        # 导致"换模型后断点仍被当成同一批"（测试抓出来的）
        self.data["doc_id"] = self.doc_id
        if self.model:
            self.data["model"] = self.model
        self.data["updated_at"] = int(time.time() * 1000)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(
            json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        os.replace(tmp, self.path)


def checkpoint_path(settings: Settings, doc_id: str) -> Path:
    return settings.checkpoint_dir / f"{doc_id}_extract.json"


class ParsedKey(NamedTuple):
    """解析后的单元/节点键。

    ``parse_key('unt_x#page:1-2')`` → ``ParsedKey('unt_x', 'page', 1, 2)``
    ``parse_key('unt_y#node')``     → ``ParsedKey('unt_y', 'node', None, None)``

    是 NamedTuple：既能按属性取（``.unit_id``），也能和普通元组比较
    （既有测试里写的是 ``== ("unt_x","page",1,2)``）。
    """

    unit_id: str
    kind: str
    start: int | None = None
    end: int | None = None


#: 键分隔符 —— 抽取与汇总**共用**，不要另起一套（Lead 明确要求单一实现）
KEY_SEP = "#"

_SPAN_REST_RE = re.compile(r"^(?P<kind>[a-z]+):(?P<start>-?\d+)-(?P<end>-?\d+)$")
_NODE_REST = "node"


def make_key(unit_id: str, span: Span) -> str:
    """生成单元键：``unt_x#page:1-2``。

    ⚠️ 这个格式是 **plan ↔ convert 的契约**：两侧都必须用 :func:`make_key` /
    :func:`parse_key`，**不要各写一份**（实测踩过：plan 产出的 key 在 convert 里
    对不上，导致"LLM 已花钱抽出卡片，convert 全部丢弃、还 exit 0"）。
    """
    return f"{unit_id}{KEY_SEP}{span.kind}:{int(span.start)}-{int(span.end)}"


def make_node_key(node_id: str) -> str:
    """生成**汇总节点**键：``unt_x#node``（与 :func:`make_key` 同一分隔符/同一解析器）。

    汇总节点没有"页码 span"（它是目录树节点），所以不套用 ``Span``；
    但键的语法与解析仍走同一实现，避免出现第二套 key 规则。
    """
    return f"{node_id}{KEY_SEP}{_NODE_REST}"


def parse_key(key: str) -> ParsedKey | None:
    """解析键 → :class:`ParsedKey`；不合法返回 ``None``。

    支持两种形态（同一实现）：
    * 单元：``unt_x#page:1-2`` / ``unt_x#char:0-9999`` / ``unt_x#time:0-480000``
    * 节点：``unt_x#node``

    ``parse_key('unt_x#page:1-2')`` → ``('unt_x', 'page', 1, 2)``
    """
    text = key or ""
    head, sep, rest = text.partition(KEY_SEP)
    if not sep or not head or not rest:
        return None
    if rest == _NODE_REST:
        return ParsedKey(head, _NODE_REST, None, None)
    m = _SPAN_REST_RE.match(rest)
    if not m:
        return None
    try:
        return ParsedKey(head, m.group("kind"), int(m.group("start")), int(m.group("end")))
    except (TypeError, ValueError):
        return None


def span_key(span: Span) -> str:
    """只用 span 的键（跨 doc_id / 跨合成 id 都能对上）。"""
    return f"{span.kind}:{int(span.start)}-{int(span.end)}"


def synth_unit_id(ord_val: int) -> str:
    """**doc_id 无关**的确定性单元 id（给没有 id 的 UnitDraft 用）。

    ⚠️ 为什么不把 doc_id 掺进哈希：``extract.plan`` 与 ``extract.convert`` 是
    **两次独立进程调用**，调用方未必传同一个 doc_id（Lead 复现时 plan 没传、
    convert 传了 ``d1``）—— 一旦 id 依赖 doc_id，key 就对不上，
    表现为"卡片被静默丢弃"（exit 0 + cards=0）。
    """
    h = hashlib.sha1(f"unit|{int(ord_val)}".encode("utf-8")).hexdigest()[:12]
    return f"unt_{h}"


def pick_key(pu: units_mod.PickedUnit) -> str:
    """断点键 / plan-convert 键：单元 + 具体 span（同单元被切窗时各算一件）。"""
    return make_key(pu.unit_id, pu.span)


def stable_card_id(doc_id: str, unit_id: str, name: str) -> str:
    """**确定性**卡片 ID：同一 (文档, 单元, 规范化名) 永远同一个 id。

    为什么不用随机 id：``extract_document(resume=False)`` 重跑时随机 id 会
    把 360 张卡片变成 720 张（实测过的经典翻倍 bug）。确定性 id 让
    ``upsert_cards`` 变成真正的幂等更新。
    """
    import hashlib

    h = hashlib.sha1(f"{doc_id}|{unit_id}|{name_key(name)}".encode("utf-8")).hexdigest()
    return f"crd_{h[:12]}"


# ═══════════════════════════════════════════════════════════════════════
# 纯转换：模型输出 → models（无存储）
# ═══════════════════════════════════════════════════════════════════════
def stable_entity_id(doc_id: str, name: str) -> str:
    """确定性实体 ID：同一 (文档, 规范化名) 永远同一个 id。

    为什么不用随机 id：TS 侧按 id upsert；随机 id 会让重跑产生重复实体。
    """
    h = hashlib.sha1(f"{doc_id}|entity|{name_key(name)}".encode("utf-8")).hexdigest()
    return f"ent_{h[:12]}"


def card_span(pu: "units_mod.PickedUnit", evidence_page: Any) -> Span:
    """卡片锚点：优先用模型给的具体页，越界则夹回本单元 span。"""
    if pu.span.kind == "page" and isinstance(evidence_page, int):
        pg = max(pu.span.start, min(pu.span.end, evidence_page))
        return Span("page", pg, pg)
    return pu.span


def build_cards(doc_id: str, pu: "units_mod.PickedUnit", raw_cards: Sequence[dict]) -> list[Card]:
    """模型输出 → :class:`Card` 列表（非法枚举**丢弃并记日志**，不炸整篇）。"""
    out: list[Card] = []
    for rc in raw_cards or []:
        name = str(rc.get("name") or "").strip()
        if not name:
            continue
        try:
            out.append(
                Card(
                    id=stable_card_id(doc_id, pu.unit_id, name),
                    doc_id=doc_id,
                    unit_id=pu.unit_id,
                    name=name,
                    kind=rc.get("kind") or "other",
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
                    span=card_span(pu, rc.get("evidence_page")),
                    confidence=rc.get("confidence") or 0.0,
                )
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("丢弃非法卡片 %r：%s", name, exc)
    return out


@dataclass
class GraphBuild:
    entities: list[Entity] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)
    dropped_edges: int = 0
    dropped_entities: int = 0


def build_graph(doc_id: str, pu: "units_mod.PickedUnit", data: dict[str, Any]) -> GraphBuild:
    """模型输出 → 实体 + 边（**同名实体归并**，否则图谱出现孤岛节点）。"""
    out = GraphBuild()
    by_key: dict[str, Entity] = {}
    for re_ in data.get("entities") or []:
        name = str(re_.get("name") or "").strip()
        if not name:
            out.dropped_entities += 1
            continue
        try:
            ent = Entity(
                id=stable_entity_id(doc_id, name),
                doc_id=doc_id,
                name=name,
                name_zh=str(re_.get("name_zh") or ""),
                layer=str(re_.get("layer") or ""),
                type=re_.get("type") or "concept",
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("丢弃非法实体 %r：%s", name, exc)
            out.dropped_entities += 1
            continue
        k = name_key(name)
        if k in by_key:
            continue  # 同名 → 归并（degree 由 TS 侧或 recompute 决定）
        by_key[k] = ent
        out.entities.append(ent)

    seen_edges: set[tuple[str, str, str]] = set()
    for re_ in data.get("edges") or []:
        src_name = str(re_.get("src") or "").strip()
        dst_name = str(re_.get("dst") or "").strip()
        etype = re_.get("etype")
        src = by_key.get(name_key(src_name))
        dst = by_key.get(name_key(dst_name))
        if not src or not dst or src.id == dst.id or etype not in edge_types():
            out.dropped_edges += 1
            continue
        key = (src.id, dst.id, etype)
        if key in seen_edges:
            continue
        seen_edges.add(key)
        try:
            out.edges.append(
                Edge(
                    id=id_for("edge"),
                    doc_id=doc_id,
                    src_id=src.id,
                    dst_id=dst.id,
                    etype=etype,
                    evidence_text=str(re_.get("evidence_text") or ""),
                    span=pu.span,
                    confidence=re_.get("confidence") or 0.0,
                    flagged=bool(re_.get("flagged", False)),
                )
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("丢弃非法边 %s→%s(%s)：%s", src_name, dst_name, etype, exc)
            out.dropped_edges += 1
    return out


def dedupe_entities(entities: Iterable[Entity]) -> list[Entity]:
    """按 id 去重（同一实体在多个单元里被抽到 → 结果里只留一条）。

    为什么要在 worker 侧去重：结果是**一份 JSON 交给 Node 落库**，
    重复 id 会让 `entities.length` 虚高（图谱节点数、度统计都会被带偏）。
    后出现的条目只用来**补空字段**（name_zh / layer），不覆盖已有值。
    """
    out: dict[str, Entity] = {}
    for e in entities:
        cur = out.get(e.id)
        if cur is None:
            out[e.id] = e
            continue
        if not cur.name_zh and e.name_zh:
            cur.name_zh = e.name_zh
        if not cur.layer and e.layer:
            cur.layer = e.layer
    return list(out.values())


def ancestor_paths(units: Sequence[Unit]) -> dict[str, str]:
    """每个 unit 的祖先链（喂给模型的"章节路径"）。"""
    by_id = {u.id: u for u in units}
    out: dict[str, str] = {}
    for u in units:
        chain: list[str] = []
        cur: Unit | None = u
        guard = 0
        while cur is not None and guard < 32:
            chain.append(cur.title or "")
            cur = by_id.get(cur.parent_id) if cur.parent_id else None
            guard += 1
        out[u.id] = " › ".join(t for t in reversed(chain) if t)
    return out


# ═══════════════════════════════════════════════════════════════════════
# 抽取主流程（纯函数：units + llm → cards/entities/edges + 断点）
# ═══════════════════════════════════════════════════════════════════════
@dataclass
class ExtractOutcome:
    """一次抽取的**全部产出**（可直接 JSON 化交给 Node 落库）。"""

    doc_id: str = ""
    cards: list[Card] = field(default_factory=list)
    entities: list[Entity] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)
    #: unit_id → section 级概括（F3 的叶子层摘要来源）
    sections: dict[str, dict[str, Any]] = field(default_factory=dict)
    stats: dict[str, Any] = field(default_factory=dict)
    errors: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "doc_id": self.doc_id,
            # ★ 显式成功标记：调用方"只看 cards"会把"全部丢弃"误判成"这篇没有知识点"
            "ok": not self.errors,
            "error_count": len(self.errors),
            "cards": [c.to_dict() for c in self.cards],
            "entities": [e.to_dict() for e in self.entities],
            "edges": [e.to_dict() for e in self.edges],
            "sections": self.sections,
            "stats": self.stats,
            "errors": self.errors,
        }


#: 事件回调（cli 用它写 JSONL；测试用它收集事件）
EmitFn = Callable[[dict[str, Any]], None]


def _emit(emit: EmitFn | None, event: dict[str, Any]) -> None:
    if emit is None:
        return
    try:
        emit(event)
    except Exception:  # noqa: BLE001 - 事件通道不该拖垮抽取
        log.debug("emit 失败", exc_info=True)


def extract_units(
    *,
    doc_id: str,
    units: Sequence[Unit],
    llm: LLMClient,
    source_name: str = "课程资料",
    max_pages: int = units_mod.MAX_PAGES_PER_UNIT,
    pages_total: int = 0,
    excluded_ranges: Sequence[Sequence[int]] | None = None,
    text_provider: units_mod.TextProvider | None = None,
    checkpoint_file: Path | None = None,
    resume: bool = True,
    max_units: int | None = None,
    chunk_chars: int = 24_000,
    emit: EmitFn | None = None,
) -> ExtractOutcome:
    """把 unit 树编译成知识卡片 + 图谱（**顺序执行，绝不并发**）。

    :param checkpoint_file: 断点文件（``None`` = 不落盘）。每单元写一次，原子替换。
    :param emit: 事件回调：``progress`` / ``unit`` / ``log``（**result 由调用方发**）。
    """
    if not units:
        raise LLMError("E_PARSE", "没有 units，无法抽取（先跑 parse job）")
    if not llm.configured:
        raise LLMError(
            "E_LLM",
            "未配置 LLM：job 参数缺少 llm.base_url / llm.api_key",
            detail=llm.cfg.reason,
            hint="凭据由 Node 层下发（架构 v2 §3）；worker 不读环境变量",
        )

    started = time.time()
    picked, pick_stats = units_mod.pick_units(
        units,
        max_pages=max_pages,
        text_provider=text_provider,
        pages_total=pages_total,
        excluded_ranges=excluded_ranges,
    )
    outcome = ExtractOutcome(doc_id=doc_id)
    outcome.stats["pick"] = pick_stats.to_dict()
    outcome.stats["units_total"] = len(picked)

    ckpt: Checkpoint | None = None
    done: set[str] = set()
    if checkpoint_file is not None:
        ckpt = Checkpoint(Path(checkpoint_file), doc_id, llm.cfg.model)
        done = ckpt.done_keys if resume else set()

    todo: list[tuple[str, units_mod.PickedUnit]] = []
    skipped = 0
    for pu in picked:
        key = pick_key(pu)
        if key in done:
            skipped += 1
            continue
        todo.append((key, pu))
    if max_units is not None:
        todo = todo[: int(max_units)]

    outcome.stats.update(
        {
            "units_done": 0,
            "units_skipped": skipped,
            "units_empty": 0,
            "units_failed": 0,
            "llm_calls": 0,
            "cards": 0,
            "entities": 0,
            "edges": 0,
            "edges_dropped": 0,
            "source_name": source_name,
        }
    )
    if not todo:
        outcome.stats["elapsed_s"] = round(time.time() - started, 1)
        return outcome

    path_index = ancestor_paths(units)
    schema = build_extraction_schema()
    system_prompt = build_system_prompt(source_name)

    for i, (key, pu) in enumerate(todo, 1):
        frac = i / len(todo)
        _emit(
            emit,
            {
                "type": "progress",
                "stage": "extract",
                "frac": round(frac, 4),
                "detail": {"done": i - 1, "total": len(todo), "unit_id": pu.unit_id,
                           "title": pu.title, "span": pu.span.to_dict()},
            },
        )
        body = (pu.text or "")[:chunk_chars]
        if not body.strip():
            outcome.stats["units_empty"] += 1
            if ckpt:
                ckpt.mark(key, {"unit_id": pu.unit_id, "cards": 0, "reason": "空文本",
                                "at": int(time.time() * 1000)})
                ckpt.save()
            _emit(emit, {"type": "log", "level": "warning",
                         "msg": f"单元无正文，跳过：{pu.title[:60]}"})
            continue
        try:
            result = llm.complete_json(
                system=system_prompt,
                user=build_user_prompt(
                    source_name=source_name,
                    span_kind=pu.span.kind,
                    path=path_index.get(pu.unit_id, pu.title),
                    start=pu.span.start,
                    end=pu.span.end,
                    body=body,
                ),
                schema=schema,
                name="knowledge_extraction",
                optional=OPTIONAL_CARD_FIELDS,
            )
        except LLMError as exc:
            outcome.stats["units_failed"] += 1
            outcome.errors.append(
                {"unit_id": pu.unit_id, "title": pu.title, "code": exc.code, "msg": exc.msg,
                 "detail": exc.detail}
            )
            _emit(emit, {"type": "log", "level": "error",
                         "msg": f"单元抽取失败 {pu.title[:40]}：{exc.code} {exc.msg}"})
            if ckpt:
                ckpt.save()
            # 额度/凭据类错误：继续只会耗时间 → 中断（断点已存，可续跑）
            if exc.code == "E_LLM" and ("402" in (exc.detail or "") or "401" in (exc.detail or "")):
                outcome.errors.append({"code": "E_LLM_ABORT",
                                       "msg": "检测到额度/凭据问题，已中断（断点已保存，可续跑）"})
                break
            continue

        outcome.stats["llm_calls"] += 1
        data = result.data or {}
        cards = build_cards(doc_id, pu, data.get("cards") or [])
        graph = build_graph(doc_id, pu, data)
        outcome.cards.extend(cards)
        outcome.entities.extend(graph.entities)
        outcome.edges.extend(graph.edges)
        outcome.stats["cards"] += len(cards)
        outcome.stats["entities"] += len(graph.entities)
        outcome.stats["edges"] += len(graph.edges)
        outcome.stats["edges_dropped"] += graph.dropped_edges
        outcome.stats["units_done"] += 1

        section = data.get("section") or {}
        if section.get("section_summary"):
            outcome.sections[pu.unit_id] = {
                "section_summary": section.get("section_summary", ""),
                "learning_objectives": section.get("learning_objectives") or [],
                "section_role": section.get("section_role") or "",
                "key_takeaways": section.get("key_takeaways") or [],
                "span": pu.span.to_dict(),
                "path": path_index.get(pu.unit_id, pu.title),
            }

        if ckpt:
            ckpt.mark(
                key,
                {
                    "unit_id": pu.unit_id,
                    "span": pu.span.to_dict(),
                    "cards": len(cards),
                    "entities": len(graph.entities),
                    "edges": len(graph.edges),
                    "dropped": graph.dropped_edges,
                    "attempts": result.attempts,
                    "ms": result.elapsed_ms,
                    "at": int(time.time() * 1000),
                },
            )
            ckpt.save()  # ★ 每单元落盘（契约 C4）

        # 增量产出：大文档可以边抽边入库（Node 决定是否消费 unit 事件）
        _emit(
            emit,
            {
                "type": "unit",
                "data": {
                    "unit_id": pu.unit_id,
                    "title": pu.title,
                    "level": pu.level,
                    "span": pu.span.to_dict(),
                    "cards": [c.to_dict() for c in cards],
                    "entities": [e.to_dict() for e in graph.entities],
                    "edges": [e.to_dict() for e in graph.edges],
                    "section": outcome.sections.get(pu.unit_id, {}),
                },
            },
        )
        _emit(
            emit,
            {
                "type": "progress",
                "stage": "extract",
                "frac": round(frac, 4),
                "detail": {"done": i, "total": len(todo), "unit_id": pu.unit_id,
                           "cards": len(cards)},
            },
        )

    # 实体按 id 去重（同一实体在多个单元被抽到 → 只留一条，别让 Node 侧计数虚高）
    outcome.entities = dedupe_entities(outcome.entities)
    outcome.stats["entities"] = len(outcome.entities)
    outcome.stats["elapsed_s"] = round(time.time() - started, 1)
    outcome.stats["concurrency"] = llm.max_inflight
    outcome.stats["llm"] = llm.cfg.redacted()
    return outcome


def plan_prompts(
    *,
    units: Sequence[Unit],
    source_name: str = "课程资料",
    max_pages: int = units_mod.MAX_PAGES_PER_UNIT,
    pages_total: int = 0,
    excluded_ranges: Sequence[Sequence[int]] | None = None,
    text_provider: units_mod.TextProvider | None = None,
    chunk_chars: int = 24_000,
) -> dict[str, Any]:
    """只**生成提示词与 schema**，不调 LLM。

    用途（架构 v2 §3「LLM 调用归 Node」时）：Node 自己调 provider，
    再把手写/模型返回的 JSON 交给 :func:`convert_payloads` 校验转换 ——
    这样"提示词 + 封闭枚举 + 转换规则"仍然只有 worker 一份实现。
    """
    picked, pick_stats = units_mod.pick_units(
        units, max_pages=max_pages, text_provider=text_provider,
        pages_total=pages_total, excluded_ranges=excluded_ranges,
    )
    ord_by_id = {u.id: u.ord for u in units}
    path_index = ancestor_paths(units)
    system_prompt = build_system_prompt(source_name)
    schema = build_extraction_schema()
    items = []
    for pu in picked:
        items.append(
            {
                "key": pick_key(pu),
                # ★ 可移植的键：不含"合成 unit_id"，跨进程/跨 doc_id 也能对上
                #   （`key` 里含 unit_id；若 Node 在 plan 与 convert 之间换了
                #     doc_id/合成规则，用 unit_key 匹配即可 —— 实测踩过这个坑）
                "unit_key": f"{ord_by_id.get(pu.unit_id, 0)}#{pu.span.kind}:{pu.span.start}-{pu.span.end}",
                "unit_ord": ord_by_id.get(pu.unit_id, 0),
                "unit_id": pu.unit_id,
                "title": pu.title,
                "kind": pu.kind,
                "span": pu.span.to_dict(),
                "chars": pu.chars,
                "system": system_prompt,
                "user": build_user_prompt(
                    source_name=source_name,
                    span_kind=pu.span.kind,
                    path=path_index.get(pu.unit_id, pu.title),
                    start=pu.span.start,
                    end=pu.span.end,
                    body=(pu.text or "")[:chunk_chars],
                ),
            }
        )
    return {
        "schema": schema,
        "optional_fields": sorted(OPTIONAL_CARD_FIELDS),
        "pick": pick_stats.to_dict(),
        "items": items,
    }


def convert_payloads(
    *,
    doc_id: str,
    units: Sequence[Unit],
    payloads: Sequence[dict[str, Any]],
    max_pages: int = units_mod.MAX_PAGES_PER_UNIT,
    pages_total: int = 0,
    excluded_ranges: Sequence[Sequence[int]] | None = None,
) -> ExtractOutcome:
    """把 Node 侧拿到的模型输出（``payloads``）校验 + 转成卡片/图谱。

    ``payloads`` 每项：``{"key": <pick_key> 或 "unit_id", "data": {section,cards,entities,edges}}``
    （与 :func:`plan_prompts` 的 ``items[].key`` 对齐）。
    """
    picked, pick_stats = units_mod.pick_units(
        units, max_pages=max_pages, pages_total=pages_total, excluded_ranges=excluded_ranges
    )
    by_key = {pick_key(pu): pu for pu in picked}
    by_unit: dict[str, units_mod.PickedUnit] = {}
    for pu in picked:
        by_unit.setdefault(pu.unit_id, pu)
    #: 兜底匹配：unit_key / span（跨 doc_id、跨合成 id 都能对上）
    ord_by_id = {u.id: u.ord for u in units}
    by_unit_key = {
        f"{ord_by_id.get(pu.unit_id, 0)}#{pu.span.kind}:{pu.span.start}-{pu.span.end}": pu
        for pu in picked
    }
    by_span: dict[str, units_mod.PickedUnit] = {}
    for pu in picked:
        by_span.setdefault(span_key(pu.span), pu)

    outcome = ExtractOutcome(doc_id=doc_id)
    outcome.stats["pick"] = pick_stats.to_dict()
    outcome.stats.update({"units_total": len(picked), "units_done": 0, "cards": 0,
                          "entities": 0, "edges": 0, "edges_dropped": 0, "llm_calls": 0})
    for item in payloads or []:
        key = str(item.get("key") or "")
        unit_key = str(item.get("unit_key") or "")
        span = item.get("span") or {}
        span_k = f"{span.get('kind')}:{span.get('start')}-{span.get('end')}" if span else ""
        # ⚠️ 匹配顺序（逐级放宽）——最后一级"只按 span"专门兜住
        #    "plan 与 convert 用了不同 doc_id / 合成 id" 的情况（Lead 实测的那个 bug）
        pu = by_key.get(key) or by_unit_key.get(unit_key)
        if pu is None:
            parsed = parse_key(key)
            if parsed:
                _uid, kind, start, end = parsed
                pu = (
                    by_key.get(key)
                    or by_span.get(f"{kind}:{start}-{end}")
                    or by_unit.get(_uid)
                )
        if pu is None:
            pu = by_span.get(span_k)
        if pu is None:
            outcome.errors.append(
                {
                    "code": "E_PICK_KEY",
                    "msg": f"未知单元：key={key!r} unit_key={unit_key!r} span={span_k!r}",
                }
            )
            continue
        data = item.get("data") if isinstance(item.get("data"), dict) else item
        cards = build_cards(doc_id, pu, (data or {}).get("cards") or [])
        graph = build_graph(doc_id, pu, data or {})
        outcome.cards.extend(cards)
        outcome.entities.extend(graph.entities)
        outcome.edges.extend(graph.edges)
        outcome.stats["units_done"] += 1
        outcome.stats["cards"] += len(cards)
        outcome.stats["entities"] += len(graph.entities)
        outcome.stats["edges"] += len(graph.edges)
        outcome.stats["edges_dropped"] += graph.dropped_edges
        section = (data or {}).get("section") or {}
        if section.get("section_summary"):
            outcome.sections[pu.unit_id] = {
                "section_summary": section.get("section_summary", ""),
                "learning_objectives": section.get("learning_objectives") or [],
                "section_role": section.get("section_role") or "",
                "key_takeaways": section.get("key_takeaways") or [],
                "span": pu.span.to_dict(),
            }
    outcome.entities = dedupe_entities(outcome.entities)
    outcome.stats["entities"] = len(outcome.entities)
    return outcome



