"""知识卡片 + 图谱抽取管线（泛化自 ``数据库课程智能体调研/tools/extract_v2.py``）。

## 与原版的差异（**泛化**，不是重写）

| 项 | 原版（extract_v2.py） | 本实现 |
|---|---|---|
| 适用格式 | 只有 PDF（PyMuPDF 直接读页） | 任意 adapter（PDF/PPTX/DOCX/TXT…），单元自带 span |
| 切块 | ``build_blocks`` 只看 lvl≥3 且 span≤8，**跨度大的整片丢** | ``pipeline/units.py`` 递归下降 + 引言段 + 大跨度切窗 |
| 输入 | 固定 ``PRIORITY`` 章列表（MySQL 硬编码） | 全文档，按单元顺序 |
| 增量 | 全量 JSON 重写 | 每单元落盘 + **原子替换**（契约 C5） |
| 关系 | 未输出 → 类型化边只融到 17 条 | 同一次调用顺带输出 ``entities``/``edges``（PROMPTS.md §附 改进点 1） |

## 提示词

**逐字取自** ``数据库课程智能体调研/product/PROMPTS.md`` §3.1（system）/ §3.2（user），
边类型定义逐字取自 §2.1。**唯一改动是 2 处参数化**（MySQL 只是样例，不是特例）：

| 原文字样 | 改为 | 原因 |
|---|---|---|
| ``把 MySQL 官方手册编译成…`` | ``把 {source_name} 编译成…`` | 新增格式（PPT/视频文稿）没有"手册" |
| ``把下面这段 MySQL 手册内容…`` / ``## 手册原文`` | ``把下面这段 {source_name} 内容…`` / ``## {source_label}原文`` | 同上 |

其余（反例 ✗/✓、诚实原则、读者设定、kind 区分说明）**一字未改**。
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Sequence

from worker.config import Settings, get_settings
from worker.models import (
    Card,
    Edge,
    Entity,
    ExtractedGraph,
    Span,
    Unit,
    id_for,
    name_key,
)
from worker.models.schema_enums import (
    card_kinds,
    entity_types,
    edge_type_docs,
    edge_types,
    layers,
    lifecycles,
    operational_roles,
    section_roles,
    usage_modes,
)
from worker.pipeline import units as units_mod
from worker.pipeline.llm import LLMClient, LLMError, LLMResult
# ⚠️ v2：worker 不依赖任何 store（SQLite 归 TS 层）。
# 这里只做**类型注解**引用，运行期不 import legacy store；
# legacy（FastAPI + SQLite）路径的函数体内会自行延迟导入。
if TYPE_CHECKING:  # pragma: no cover
    from worker._legacy.store.repo import Repo

log = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════
# 提示词（逐字，见模块 docstring 的 2 处参数化）
# ═══════════════════════════════════════════════════════════════════════
# ⚠️ 提示词 / JSON Schema / 断点 / 稳定 ID 的**唯一实现**已移到 extract_core.py
#    （v2：纯函数核心，零存储依赖；这里 re-export 保持 v1 调用点不变，
#     也保证提示词只有一份，不会漂移）
from worker.pipeline.extract_core import (  # noqa: F401
    CARD_SYSTEM_PROMPT,
    CARD_USER_PROMPT,
    SPAN_LABELS,
    OPTIONAL_CARD_FIELDS,
    Checkpoint,
    checkpoint_path,
    build_extraction_schema,
    build_system_prompt,
    build_user_prompt,
    edge_rules_block,
    pick_key,
    stable_card_id,
)



# ═══════════════════════════════════════════════════════════════════════
# 断点（契约 C4：长任务必须落盘断点；C5：原子替换）
# ═══════════════════════════════════════════════════════════════════════
# ═══════════════════════════════════════════════════════════════════════
# 抽取统计
# ═══════════════════════════════════════════════════════════════════════
@dataclass
class ExtractStats:
    doc_id: str = ""
    units_total: int = 0
    units_done: int = 0
    units_skipped: int = 0
    units_empty: int = 0
    units_failed: int = 0
    cards: int = 0
    entities: int = 0
    edges: int = 0
    edges_dropped: int = 0
    llm_calls: int = 0
    elapsed_s: float = 0.0
    coverage: float = 0.0
    pick: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = dict(self.__dict__)
        d["elapsed_s"] = round(self.elapsed_s, 1)
        return d


# ═══════════════════════════════════════════════════════════════════════
# 抽取器
# ═══════════════════════════════════════════════════════════════════════
ProgressFn = Callable[[float, str], None]


class Extractor:
    """把 Unit 编译成知识卡片 + 图谱（**顺序执行，绝不并发**）。"""

    def __init__(
        self,
        repo: Repo,
        llm: LLMClient | None = None,
        *,
        settings: Settings | None = None,
    ):
        self.repo = repo
        self.settings = settings or get_settings()
        self.llm = llm or LLMClient(self.settings)

    # ── 主流程 ──────────────────────────────────────────────────────
    def extract_document(
        self,
        doc_id: str,
        *,
        max_units: int | None = None,
        resume: bool = True,
        text_provider: units_mod.TextProvider | None = None,
        excluded_ranges: Sequence[Sequence[int]] | None = None,
        on_progress: ProgressFn | None = None,
    ) -> ExtractStats:
        doc = self.repo.get_document(doc_id)
        if doc is None:
            raise LLMError("E_NOTFOUND", f"文档不存在：{doc_id}")
        if not self.llm.configured:
            raise LLMError(
                "E_LLM",
                "未配置 LLM 凭据，无法抽取知识卡片",
                detail=self.settings.llm_reason,
                hint="设置 AMR_KEY/AMR_BASE 后重试；已解析的 units 不受影响",
            )

        stats = ExtractStats(doc_id=doc_id)
        started = time.time()
        units = self.repo.all_units(doc_id)
        if not units:
            raise LLMError("E_PARSE", f"文档 {doc_id} 还没有 units，无法抽取")

        picked, pick_stats = units_mod.pick_units(
            units,
            max_pages=self.settings.max_pages_per_unit,
            text_provider=text_provider,
            pages_total=doc.page_count,
            excluded_ranges=excluded_ranges,
        )
        stats.pick = pick_stats.to_dict()

        ckpt = Checkpoint(checkpoint_path(self.settings, doc_id), doc_id, self.settings.llm_model)
        done = ckpt.done_keys if resume else set()
        todo = []
        for pu in picked:
            key = pick_key(pu)
            if key in done:
                stats.units_skipped += 1
                continue
            todo.append((key, pu))
        if max_units is not None:
            todo = todo[: int(max_units)]
        stats.units_total = len(picked)

        if not todo:
            # 全部命中断点：本次没有再调 LLM，units_done 保持 0（如实反映"这一轮没干活"）
            stats.units_done = 0
            stats.units_skipped = len(picked)
            stats.elapsed_s = time.time() - started
            return stats

        path_index = self._ancestor_paths(units)
        schema = build_extraction_schema()
        source_name = doc.title or doc.kind

        for i, (key, pu) in enumerate(todo, 1):
            frac = i / len(todo)
            if on_progress:
                on_progress(frac, f"抽取知识卡片（{i}/{len(todo)}）")
            body = pu.text[: self.settings.llm_chunk_chars]
            if not body.strip():
                stats.units_empty += 1
                self.repo.mark_unit_empty(doc_id, pu.unit_id)
                ckpt.mark(key, {"cards": 0, "reason": "空文本", "at": int(time.time() * 1000)})
                ckpt.save()
                continue
            try:
                result = self.llm.complete_json(
                    system=build_system_prompt(source_name),
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
                stats.llm_calls += 1
                n_cards, n_ent, n_edge, dropped = self._persist(
                    doc_id, pu, result, path_index
                )
                stats.cards += n_cards
                stats.entities += n_ent
                stats.edges += n_edge
                stats.edges_dropped += dropped
                stats.units_done += 1
                ckpt.mark(
                    key,
                    {
                        "unit_id": pu.unit_id,
                        "span": pu.span.to_dict(),
                        "cards": n_cards,
                        "entities": n_ent,
                        "edges": n_edge,
                        "dropped": dropped,
                        "attempts": result.attempts,
                        "ms": result.elapsed_ms,
                        "at": int(time.time() * 1000),
                    },
                )
                log.info(
                    "[%d/%d] %s → 卡片 %d / 实体 %d / 边 %d",
                    i, len(todo), pu.title[:40], n_cards, n_ent, n_edge,
                )
            except LLMError as exc:
                stats.units_failed += 1
                stats.errors.append(f"{pu.title}: {exc.code} {exc.msg}")
                log.error("单元抽取失败 %s：%s", pu.title[:40], exc.msg)
                ckpt.save()
                # 额度/凭据类错误：继续跑只会把时间耗光 → 直接中断（断点已存）
                if exc.code == "E_LLM" and ("402" in exc.detail or "401" in exc.detail):
                    stats.errors.append("检测到额度/凭据问题，已中断（断点已保存，可续跑）")
                    break
            # 每单元落盘（契约 C4）
            ckpt.save()

        self._finalize(doc_id, stats, pick_stats)
        stats.elapsed_s = time.time() - started
        stats.coverage = pick_stats.coverage
        return stats

    # ── 落库 ────────────────────────────────────────────────────────
    def _persist(
        self,
        doc_id: str,
        pu: units_mod.PickedUnit,
        result: LLMResult,
        path_index: dict[str, str],
    ) -> tuple[int, int, int, int]:
        data = result.data or {}
        cards = self._build_cards(doc_id, pu, data.get("cards") or [])
        graph = self._build_graph(doc_id, pu, data)

        if cards:
            self.repo.upsert_cards(cards)
        ent_map = self.repo.upsert_entities(graph.entities) if graph.entities else {}
        # 边：src/dst 用名字 → 解析成实体 id（落在同一批实体里）
        edges: list[Edge] = []
        dropped = 0
        for e in graph.edges:
            src = ent_map.get(name_key(e["src"]))
            dst = ent_map.get(name_key(e["dst"]))
            if not src or not dst or src == dst:
                dropped += 1
                continue
            edges.append(
                Edge(
                    id=id_for("edge"),
                    doc_id=doc_id,
                    src_id=src,
                    dst_id=dst,
                    etype=e["etype"],
                    evidence_text=e.get("evidence_text", ""),
                    span=pu.span,
                    confidence=e.get("confidence", 0.0),
                    flagged=bool(e.get("flagged", False)),
                )
            )
        if edges:
            self.repo.upsert_edges(edges)
            self.repo.recompute_degrees(doc_id)

        # 节级摘要 → documents.meta_json（/outline 的 intro 来源）
        section = data.get("section") or {}
        if section.get("section_summary"):
            doc = self.repo.get_document(doc_id)
            if doc:
                meta = dict(doc.meta or {})
                summaries = dict(meta.get("section_summaries", {}) or {})
                summaries[pu.unit_id] = {
                    "section_summary": section.get("section_summary", ""),
                    "learning_objectives": section.get("learning_objectives") or [],
                    "section_role": section.get("section_role") or "",
                    "key_takeaways": section.get("key_takeaways") or [],
                    "span": pu.span.to_dict(),
                    "path": path_index.get(pu.unit_id, pu.title),
                }
                meta["section_summaries"] = summaries
                self.repo.update_document(doc_id, meta=meta)
        elif cards:
            pass

        # 索引（bigram）随抽取增量写入，保证搜得到新卡片
        from worker.pipeline.search import index_cards

        if cards:
            index_cards(self.repo, cards)
        return len(cards), len(graph.entities), len(edges), dropped

    def _build_cards(
        self, doc_id: str, pu: units_mod.PickedUnit, raw_cards: Sequence[dict]
    ) -> list[Card]:
        out: list[Card] = []
        for rc in raw_cards:
            name = str(rc.get("name") or "").strip()
            if not name:
                continue
            span = self._card_span(pu, rc.get("evidence_page"))
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
                        span=span,
                        confidence=rc.get("confidence") or 0.0,
                    )
                )
            except Exception as exc:  # noqa: BLE001
                # 封闭枚举被违反（schema 校验应该已经拦住）→ 记日志不炸整篇
                log.warning("丢弃非法卡片 %r：%s", name, exc)
        return out

    @staticmethod
    def _card_span(pu: units_mod.PickedUnit, evidence_page: Any) -> Span:
        """卡片锚点：优先用模型给的具体位置，越界则夹回本单元 span。"""
        if pu.span.kind == "page" and isinstance(evidence_page, int):
            pg = max(pu.span.start, min(pu.span.end, evidence_page))
            return Span("page", pg, pg)
        return pu.span

    @staticmethod
    def _build_graph(doc_id: str, pu: units_mod.PickedUnit, data: dict) -> ExtractedGraph:
        ents: list[Entity] = []
        for re_ in data.get("entities") or []:
            name = str(re_.get("name") or "").strip()
            if not name:
                continue
            ents.append(
                Entity(
                    id=id_for("entity"),
                    doc_id=doc_id,
                    name=name,
                    name_zh=str(re_.get("name_zh") or ""),
                    layer=str(re_.get("layer") or ""),
                    type=re_.get("type") or "concept",
                )
            )
        raw_edges: list[dict] = []
        for re_ in data.get("edges") or []:
            src = str(re_.get("src") or "").strip()
            dst = str(re_.get("dst") or "").strip()
            etype = re_.get("etype")
            if not src or not dst or etype not in edge_types():
                continue
            raw_edges.append(
                {
                    "src": src,
                    "dst": dst,
                    "etype": etype,
                    "evidence_text": str(re_.get("evidence_text") or ""),
                    "confidence": re_.get("confidence") or 0.0,
                }
            )
        return ExtractedGraph(entities=ents, edges=raw_edges)  # type: ignore[arg-type]

    # ── 收尾 ────────────────────────────────────────────────────────
    def _finalize(self, doc_id: str, stats: ExtractStats, pick_stats) -> None:
        cards_before = self.repo.card_count(doc_id)
        self.repo.update_document(doc_id, status="ready")
        doc = self.repo.get_document(doc_id)
        if doc:
            meta = dict(doc.meta or {})
            meta["extract"] = {
                **meta.get("extract", {}),
                "last_run": {
                    "cards": stats.cards,
                    "entities": stats.entities,
                    "edges": stats.edges,
                    "units_done": stats.units_done,
                    "units_skipped": stats.units_skipped,
                    "coverage": round(pick_stats.coverage, 4),
                    "llm_calls": stats.llm_calls,
                },
                "cards_total": self.repo.card_count(doc_id),
                "cards_before_run": cards_before,
            }
            self.repo.update_document(doc_id, meta=meta)

    # ── 工具 ────────────────────────────────────────────────────────
    @staticmethod
    def _ancestor_paths(units: Sequence[Unit]) -> dict[str, str]:
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


