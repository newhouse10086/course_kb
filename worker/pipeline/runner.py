"""任务作业（把 adapter → units → 索引 → 抽取 → 交叉引用 串成一条链）。

上传一个 PDF 后发生的事（一个 ``parse`` 任务，SSE 全程可见）：

```
① 解析（adapter）        0.02 → 0.55    units 入库
② 建检索索引（bigram）    0.55 → 0.60
③ 抽取卡片 + 图谱（LLM）  0.60 → 0.95    并发=1，逐单元落盘
④ 交叉引用 + 重建索引     0.95 → 1.00
```

**无 LLM 凭据时如实降级**：①②④ 照跑，③ 跳过并在任务 detail 里写明
``llm_configured=false``（绝不假装抽了卡片）。
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Any

from worker.adapters import registry
from worker.adapters.base import ParseError, UnsupportedFormat, draft_to_units
from worker.adapters.pdf import text_provider_for
from worker.config import Settings, get_settings
from worker.pipeline import search as search_mod
from worker.pipeline import xref as xref_mod
from worker.pipeline.extract import Extractor
from worker.pipeline.llm import LLMClient
from worker.pipeline.rollup import rollup_document
from worker.pipeline.tasks import TaskContext, TaskRunner
# ⚠️ v2：worker 不依赖任何 store（SQLite 归 TS 层）。
# 这里只做**类型注解**引用，运行期不 import legacy store；
# legacy（FastAPI + SQLite）路径的函数体内会自行延迟导入。
if TYPE_CHECKING:  # pragma: no cover
    from worker._legacy.store.repo import Repo

log = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════
# 作业实现
# ═══════════════════════════════════════════════════════════════════════
def job_parse(
    ctx: TaskContext, *, llm: LLMClient, settings: Settings, extract_after: bool = True
) -> dict[str, Any]:
    doc_id = ctx.task.doc_id
    doc = ctx.repo.get_document(doc_id) if doc_id else None
    if doc is None:
        raise ParseError(f"文档不存在：{doc_id}")

    ctx.repo.update_document(doc_id, status="parsing")
    ctx.update(0.02, "选择适配器")
    try:
        adapter = registry.pick(doc.source_path)
    except UnsupportedFormat as exc:
        exc.code = "E_FORMAT"  # type: ignore[attr-defined]
        raise
    ctx.log(f"使用适配器 {type(adapter).__name__}（kind={adapter.kind}）")

    provider = text_provider_for(doc.source_path)
    try:
        draft = adapter.parse(
            doc.source_path, on_progress=ctx.progress_fn(0.02, 0.5, "解析：")
        )
        draft.validate()
        ctx.update(0.55, f"解析完成：{len(draft.units)} 个单元")
        units = draft_to_units(draft, doc_id)
        ctx.repo.replace_units(doc_id, units)

        meta = dict(doc.meta or {})
        meta["parse"] = {
            **draft.meta,
            "adapter": type(adapter).__name__,
            "units": len(units),
            "chars": draft.text_chars,
        }
        ctx.repo.update_document(
            doc_id,
            status="parsing",
            page_count=draft.page_count,
            lang=draft.lang,
            title=doc.title or draft.title,
            meta=meta,
        )

        ctx.update(0.6, "建检索索引")
        index_stats = search_mod.index_document(ctx.repo, doc_id)
        ctx.artifact("outline", f"/api/v1/documents/{doc_id}/outline")

        detail: dict[str, Any] = {
            "units": len(units),
            "pages": draft.page_count,
            "parse_mode": draft.meta.get("mode"),
            "skipped_nodes": draft.meta.get("skipped_nodes"),
            "index": index_stats,
            "llm_configured": llm.configured,
        }

        if not (extract_after and llm.configured):
            reason = (
                "未配置 LLM 凭据：已完成解析与索引；知识卡片/图谱需要凭据"
                if not llm.configured
                else "仅解析（未要求抽取）"
            )
            ctx.log(reason, level="warn" if not llm.configured else "info")
            ctx.update(1.0, "解析完成（未抽取卡片）")
            detail["note"] = reason
            return detail

        ctx.update(0.62, "抽取知识卡片")
        extractor = Extractor(ctx.repo, llm, settings=settings)
        stats = extractor.extract_document(
            doc_id,
            text_provider=provider.text if provider else None,
            excluded_ranges=(meta.get("parse", {}) or {}).get("excluded_ranges") or [],
            on_progress=ctx.progress_fn(0.62, 0.3, "抽取："),
        )
        detail["extract"] = stats.to_dict()
        ctx.artifact("cards", f"/api/v1/documents/{doc_id}/cards")
        ctx.artifact("graph", f"/api/v1/documents/{doc_id}/graph")

        ctx.update(0.94, "生成交叉引用")
        n_xref, xstats = xref_mod.apply_xrefs(ctx.repo, doc_id)
        detail["xrefs"] = xstats.to_dict()
        ctx.update(0.98, "重建检索索引")
        search_mod.index_document(ctx.repo, doc_id)
        ctx.repo.update_document(doc_id, status="ready")
        ctx.update(1.0, "完成")
        detail["counts"] = ctx.repo.counts(doc_id).to_dict()
        return detail
    finally:
        if provider is not None:
            provider.close()  # type: ignore[attr-defined]


def job_extract(ctx: TaskContext, *, llm: LLMClient, settings: Settings) -> dict[str, Any]:
    doc_id = ctx.task.doc_id
    if not doc_id:
        raise ParseError("任务缺少 doc_id")
    doc = ctx.repo.get_document(doc_id)
    if doc is None:
        raise ParseError(f"文档不存在：{doc_id}")
    if not llm.configured:
        raise _llm_unavailable(settings)
    ctx.repo.update_document(doc_id, status="extracting")
    provider = text_provider_for(doc.source_path)
    try:
        extractor = Extractor(ctx.repo, llm, settings=settings)
        stats = extractor.extract_document(
            doc_id,
            text_provider=provider.text if provider else None,
            on_progress=ctx.progress_fn(0.05, 0.8, "抽取："),
        )
    finally:
        if provider is not None:
            provider.close()  # type: ignore[attr-defined]
    ctx.update(0.88, "生成交叉引用")
    _, xstats = xref_mod.apply_xrefs(ctx.repo, doc_id)
    ctx.update(0.95, "重建检索索引")
    search_mod.index_document(ctx.repo, doc_id)
    ctx.repo.update_document(doc_id, status="ready")
    return {
        "extract": stats.to_dict(),
        "xrefs": xstats.to_dict(),
        "counts": ctx.repo.counts(doc_id).to_dict(),
    }


def job_index(ctx: TaskContext, *, settings: Settings) -> dict[str, Any]:
    doc_id = ctx.task.doc_id
    if not doc_id:
        raise ParseError("任务缺少 doc_id")
    ctx.update(0.2, "生成交叉引用")
    n, xstats = xref_mod.apply_xrefs(ctx.repo, doc_id)
    ctx.update(0.6, "重建检索索引")
    counts = search_mod.index_document(ctx.repo, doc_id)
    ctx.update(1.0, "完成")
    return {"xrefs": xstats.to_dict(), "index": counts}


def job_rollup(ctx: TaskContext, *, llm: LLMClient, settings: Settings) -> dict[str, Any]:
    doc_id = ctx.task.doc_id
    if not doc_id:
        raise ParseError("任务缺少 doc_id")
    if not llm.configured:
        raise _llm_unavailable(settings)
    if ctx.repo.unit_count(doc_id) == 0:
        raise ParseError("文档还没有 units，先跑 parse")
    stats = rollup_document(
        ctx.repo, llm, doc_id, settings=settings,
        on_progress=ctx.progress_fn(0.05, 0.9, "汇总："),
    )
    return stats


def _llm_unavailable(settings: Settings) -> Exception:
    from worker.pipeline.llm import LLMError

    exc = LLMError(
        "E_LLM",
        "未配置 LLM 凭据",
        detail=settings.llm_reason,
        hint="设置 AMR_KEY/AMR_BASE（或 OPENAI_API_KEY/OPENAI_BASE_URL）后重试",
    )
    return exc


# ═══════════════════════════════════════════════════════════════════════
# 装配
# ═══════════════════════════════════════════════════════════════════════
def build_runner(
    repo: Repo,
    *,
    settings: Settings | None = None,
    llm: LLMClient | None = None,
    bus=None,
) -> TaskRunner:
    """注册全部作业并返回 runner（调用方决定何时 ``start()``）。"""
    settings = settings or get_settings()
    llm = llm or LLMClient(settings)
    runner = TaskRunner(repo, bus=bus, settings=settings)
    runner.register("parse", lambda ctx: job_parse(ctx, llm=llm, settings=settings))
    runner.register("extract", lambda ctx: job_extract(ctx, llm=llm, settings=settings))
    runner.register("index", lambda ctx: job_index(ctx, settings=settings))
    runner.register("rollup", lambda ctx: job_rollup(ctx, llm=llm, settings=settings))
    return runner
