"""FastAPI 应用（契约 §5 REST / §6 SSE / §8 错误码）。

对外接口一览（前缀 ``/api/v1``）：

* 能力：``GET /health``、``GET /capabilities``（**诚实接口**：能力不可用如实 false）
* 文档：``POST/GET /documents``、``GET/DELETE /documents/{id}``、
  ``/outline`` ``/units`` ``/cards`` ``/graph`` ``/xrefs`` ``/file``
* 卡片：``GET /cards/{id}`` ``/cards/{id}/xrefs`` ``/cards/{id}/backlinks``
* 检索：``GET /search``、``GET /search/suggest``
* 任务：``GET /tasks/{id}``、``GET /tasks/{id}/events``（SSE）、``POST /tasks/{id}/cancel``
* 视频：``/documents/{id}/video*``（数据由 T2 的 ``server/video/**`` 写入）

设计原则：**API 层只做协议转换**（DTO ↔ models），业务在 pipeline / store 里。
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Iterator

from fastapi import (
    FastAPI,
    File,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.responses import JSONResponse, StreamingResponse

from server.adapters import registry
from server.adapters.base import ParseError, UnsupportedFormat
from server.config import Settings, get_settings
from server.models import (
    Card,
    Document,
    Task,
    id_for,
    new_id,
)
from server.models.schema_enums import card_kinds, edge_types, entity_types, summary as schema_summary
from server.pipeline import search as search_mod
from server.pipeline import units as units_mod
from server.pipeline.llm import LLMClient, LLMError
from server.pipeline.outline import build_outline
from server.pipeline.runner import build_runner
from server.pipeline.tasks import TaskRunner, parse_sse_last_id, sse_frames
from server.store.db import open_db
from server.store.repo import Repo

log = logging.getLogger(__name__)

VERSION = "1.0.0"


# ═══════════════════════════════════════════════════════════════════════
# 错误（契约 §8）
# ═══════════════════════════════════════════════════════════════════════
class ApiError(Exception):
    def __init__(self, code: str, msg: str, *, status: int = 400,
                 detail: str = "", hint: str = ""):
        super().__init__(msg)
        self.code = code
        self.msg = msg
        self.status = status
        self.detail = detail
        self.hint = hint

    def body(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "msg": self.msg, "detail": self.detail, "hint": self.hint}}


ERROR_CODES: dict[str, tuple[int, str]] = {
    "E_NOFILE": (400, "未提供文件"),
    "E_FORMAT": (415, "不支持的格式"),
    "E_TOOBIG": (413, "超过大小限制"),
    "E_NOTFOUND": (404, "资源不存在"),
    "E_PARSE": (422, "解析失败"),
    "E_LLM": (502, "LLM 调用失败"),
    "E_LLM_SCHEMA": (502, "模型输出不符合 schema"),
    "E_ASR_LOAD": (503, "ASR 模型加载失败"),
    "E_FFMPEG": (500, "ffmpeg 失败"),
    "E_PI_EXIT": (502, "pi 子进程退出"),
    "E_PI_TIMEOUT": (504, "pi 超时"),
    "E_BUSY": (429, "任务队列满"),
}


# ═══════════════════════════════════════════════════════════════════════
# 能力探测（**诚实**）
# ═══════════════════════════════════════════════════════════════════════
def ffmpeg_capability() -> dict[str, Any]:
    exe = shutil.which("ffmpeg")
    if not exe:
        return {"available": False, "version": "", "reason": "PATH 里没有 ffmpeg"}
    try:
        out = subprocess.run(
            [exe, "-version"], capture_output=True, text=True, timeout=10, check=False
        )
        first = (out.stdout or "").splitlines()[0] if out.stdout else ""
        # "ffmpeg version N-124868-g0e1a0b3 Copyright (c) ..." → 取第二个词
        parts = first.split()
        version = parts[2] if len(parts) > 2 else first.strip()
        return {"available": True, "version": version, "path": exe}
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "version": "", "reason": f"{type(exc).__name__}: {exc}"}


def asr_capability() -> dict[str, Any]:
    """ASR 能力：由 T2 的 ``server/video/asr.py::asr_capability()`` 提供。

    模块还没交付时**如实返回 false**（不是假装可用，也不是崩）。
    """
    try:
        from server.video import asr as asr_mod  # type: ignore

        fn = getattr(asr_mod, "asr_capability", None)
        if callable(fn):
            cap = dict(fn() or {})
            cap.setdefault("available", False)
            cap.setdefault("engine", "faster-whisper")
            cap.setdefault("reason", "")
            return cap
    except ImportError as exc:
        return {
            "available": False,
            "engine": "faster-whisper",
            "models": [],
            "device": "cpu",
            "reason": f"server.video.asr 未交付（{exc}）",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "available": False,
            "engine": "faster-whisper",
            "models": [],
            "device": "cpu",
            "reason": f"探测失败：{type(exc).__name__}: {exc}",
        }


def pi_capability() -> dict[str, Any]:
    """pi 能力：由 T4 的 ``server/pi_bridge/ws.py::pi_capabilities()`` 提供。"""
    try:
        from server.pi_bridge.ws import pi_capabilities  # type: ignore

        cap = dict(pi_capabilities() or {})
        cap.setdefault("available", False)
        cap.setdefault("version", None)
        cap.setdefault("mode", "none")
        return cap
    except ImportError as exc:
        return {
            "available": False,
            "version": None,
            "mode": "none",
            "reason": f"server.pi_bridge 未交付（{exc}）",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "available": False,
            "version": None,
            "mode": "none",
            "reason": f"探测失败：{type(exc).__name__}: {exc}",
        }


def capabilities(app: FastAPI) -> dict[str, Any]:
    settings: Settings = app.state.settings
    llm: LLMClient = app.state.llm
    repo: Repo = app.state.repo
    llm_status = llm.status()  # 含 configured / available / reason
    return {
        "version": VERSION,
        "adapters": registry.available_kinds(),
        "adapter_details": registry.describe(),
        "asr": asr_capability(),
        "llm": {
            "configured": bool(llm_status.get("configured")),
            "available": bool(llm_status.get("available")),
            "model": llm_status.get("model", settings.llm_model),
            "mode": llm_status.get("mode", settings.llm_mode),
            "reason": llm_status.get("reason", ""),
            "concurrency": settings.llm_concurrency,
            "models": llm_status.get("models", []),
        },
        "pi": pi_capability(),
        "ffmpeg": ffmpeg_capability(),
        "schema": schema_summary(),
        "search": {
            "engine": "sqlite-fts5",
            "tokenizer": "bigram",
            "note": "中文必须 bigram 预处理（unicode61 对中文 0 命中，见 /search/contrast）",
        },
        "storage": {
            "db": str(settings.db_path),
            "counts": repo.db.stats(),
        },
        "pipeline": {
            "max_pages_per_unit": settings.max_pages_per_unit,
            "span_threshold": settings.span_threshold,
            "min_degree_for_page": settings.min_degree_for_page,
            "unit_split": "recursive_descent_with_intro",
            "llm_concurrency": 1,
        },
    }


# ═══════════════════════════════════════════════════════════════════════
# 应用工厂
# ═══════════════════════════════════════════════════════════════════════
def create_app(
    *,
    settings: Settings | None = None,
    repo: Repo | None = None,
    runner: TaskRunner | None = None,
    llm: LLMClient | None = None,
    start_runner: bool = True,
) -> FastAPI:
    settings = settings or get_settings()
    settings.ensure_dirs()
    if repo is None:
        repo = Repo(open_db(settings.db_path))
    if llm is None:
        llm = LLMClient(settings)

    app = FastAPI(title="Course Knowledge Platform", version=VERSION)
    app.state.settings = settings
    app.state.repo = repo
    app.state.llm = llm
    app.state.runner = runner or build_runner(repo, settings=settings, llm=llm)
    if start_runner:
        app.state.runner.start()

    _install_routes(app)
    _try_mount_pi_bridge(app)
    _try_mount_web(app)
    return app


def _install_routes(app: FastAPI) -> None:
    # ── 异常 → 契约错误码 ───────────────────────────────────────────
    @app.exception_handler(ApiError)
    async def _api_error(_req: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content=exc.body())

    @app.exception_handler(UnsupportedFormat)
    async def _fmt(_req: Request, exc: UnsupportedFormat) -> JSONResponse:
        return JSONResponse(
            status_code=415,
            content={
                "error": {
                    "code": "E_FORMAT",
                    "msg": str(exc),
                    "detail": f"支持：{', '.join(registry.supported_extensions())}",
                    "hint": "新增格式只需实现 DocumentAdapter（不改核心）",
                }
            },
        )

    @app.exception_handler(ParseError)
    async def _parse(_req: Request, exc: ParseError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"error": {"code": "E_PARSE", "msg": str(exc), "detail": "", "hint": "原始文件可下载核对"}},
        )

    @app.exception_handler(LLMError)
    async def _llm(_req: Request, exc: LLMError) -> JSONResponse:
        status = ERROR_CODES.get(exc.code, (502, ""))[0]
        return JSONResponse(status_code=status, content={"error": exc.to_dict()})

    @app.exception_handler(KeyError)
    async def _notfound(_req: Request, exc: KeyError) -> JSONResponse:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "E_NOTFOUND", "msg": f"资源不存在：{exc}", "detail": "", "hint": ""}},
        )

    # ═══ 健康与能力 ═══
    @app.get("/api/v1/health")
    def health() -> dict[str, Any]:
        return {
            "ok": True,
            "version": VERSION,
            "documents": app.state.repo.db.stats().get("documents", 0),
            "units": app.state.repo.db.stats().get("units", 0),
            "cards": app.state.repo.db.stats().get("cards", 0),
        }

    @app.get("/api/v1/capabilities")
    def get_capabilities() -> dict[str, Any]:
        return capabilities(app)

    # ═══ 文档 ═══
    @app.post("/api/v1/documents", status_code=202)
    async def upload_document(
        request: Request,
        file: UploadFile = File(...),
        kind: str | None = Query(default=None, description="覆盖类型推断（pdf/pptx/docx/text/video）"),
    ) -> dict[str, Any]:
        settings: Settings = app.state.settings
        repo: Repo = app.state.repo
        if file is None or not file.filename:
            raise ApiError("E_NOFILE", "未提供文件", status=400)

        doc_id = id_for("document")
        suffix = Path(file.filename).suffix.lower()
        target_dir = settings.doc_dir(doc_id)
        target_dir.mkdir(parents=True, exist_ok=True)
        final_path = target_dir / f"original{suffix}"
        tmp_path = target_dir / f".upload{suffix}.part"

        # 契约 C5：先写暂存，再原子替换（不先删后写）
        total = 0
        with tmp_path.open("wb") as fh:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > settings.max_upload_bytes:
                    fh.close()
                    tmp_path.unlink(missing_ok=True)
                    raise ApiError(
                        "E_TOOBIG",
                        f"文件超过上限 {settings.max_upload_bytes} 字节",
                        status=413,
                    )
                fh.write(chunk)
        os.replace(tmp_path, final_path)

        # 格式校验（没有 adapter 能处理就 415，并告诉用户支持什么）
        try:
            adapter = registry.pick(str(final_path))
        except UnsupportedFormat as exc:
            final_path.unlink(missing_ok=True)
            raise exc

        doc_kind = kind or adapter.kind
        probe: dict[str, Any] = {}
        try:
            probe = adapter.probe(str(final_path)) or {}
        except Exception as exc:  # noqa: BLE001 - 探测失败不该阻断上传
            log.info("probe 失败（忽略）：%s", exc)

        doc = Document(
            id=doc_id,
            title=Path(file.filename).stem,
            kind=doc_kind,
            source_path=str(final_path),
            size_bytes=total,
            page_count=int(probe.get("pages") or probe.get("slides") or 0),
            lang="",
            status="uploading",
            meta={"original_filename": file.filename, "probe": probe},
        )
        repo.create_document(doc)

        task = app.state.runner.submit("parse", doc_id)
        return {
            "document_id": doc_id,
            "task_id": task.id,
            "status": "uploading",
            "events_url": f"/api/v1/tasks/{task.id}/events",
        }

    @app.get("/api/v1/documents")
    def list_documents(
        offset: int = 0,
        limit: int = 50,
        kind: str | None = None,
        status: str | None = None,
    ) -> dict[str, Any]:
        docs, total = app.state.repo.list_documents(
            offset=offset, limit=limit, kind=kind, status=status
        )
        return {
            "total": total,
            "offset": offset,
            "limit": limit,
            "documents": [d.to_dict() for d in docs],
        }

    @app.get("/api/v1/documents/{doc_id}")
    def get_document(doc_id: str) -> dict[str, Any]:
        repo: Repo = app.state.repo
        doc = repo.get_document(doc_id)
        if doc is None:
            raise ApiError("E_NOTFOUND", f"文档不存在：{doc_id}", status=404)
        out = doc.to_dict()
        out["counts"] = repo.counts(doc_id).to_dict()
        out["import_source"] = (doc.meta or {}).get("import_source", "llm_live")
        return out

    @app.delete("/api/v1/documents/{doc_id}")
    def delete_document(doc_id: str) -> dict[str, Any]:
        repo: Repo = app.state.repo
        doc = repo.get_document(doc_id)
        if doc is None:
            raise ApiError("E_NOTFOUND", f"文档不存在：{doc_id}", status=404)
        ok = repo.delete_document(doc_id)
        return {"deleted": ok, "document_id": doc_id}

    @app.get("/api/v1/documents/{doc_id}/outline")
    def document_outline(doc_id: str) -> dict[str, Any]:
        repo: Repo = app.state.repo
        if repo.get_document(doc_id) is None:
            raise ApiError("E_NOTFOUND", f"文档不存在：{doc_id}", status=404)
        return build_outline(repo, doc_id)

    @app.get("/api/v1/documents/{doc_id}/units")
    def document_units(
        doc_id: str, offset: int = 0, limit: int = 200, with_text: bool = False
    ) -> dict[str, Any]:
        repo: Repo = app.state.repo
        units, total = repo.list_units(
            doc_id, offset=offset, limit=limit, with_text=with_text
        )
        return {
            "document_id": doc_id,
            "total": total,
            "offset": offset,
            "limit": limit,
            "units": [u.to_dict() for u in units],
        }

    @app.get("/api/v1/documents/{doc_id}/units/coverage")
    def units_coverage(doc_id: str, max_pages: int = 8) -> dict[str, Any]:
        """划分覆盖率自检 + **bug 5 对照实验**（旧算法 vs 递归下降）。

        这是"不丢页"的可复现证据：``legacy`` 是上游那个"跨度 > N 既不选也不下钻"
        的错误算法，``recursive`` 是本实现。
        """
        repo: Repo = app.state.repo
        doc = repo.get_document(doc_id)
        if doc is None:
            raise ApiError("E_NOTFOUND", f"文档不存在：{doc_id}", status=404)
        units = repo.all_units(doc_id)
        cmp = units_mod.compare_algorithms(units, max_pages=max_pages)
        cmp["document_id"] = doc_id
        cmp["pages_total"] = doc.page_count
        cmp["toc_skipped_pages"] = int((doc.meta or {}).get("parse", {}).get("skipped_pages") or 0)
        return cmp

    @app.get("/api/v1/documents/{doc_id}/cards")
    def document_cards(
        doc_id: str, offset: int = 0, limit: int = 200, unit_id: str | None = None
    ) -> dict[str, Any]:
        repo: Repo = app.state.repo
        cards, total = repo.list_cards(doc_id, offset=offset, limit=limit, unit_id=unit_id)
        return {
            "document_id": doc_id,
            "total": total,
            "offset": offset,
            "limit": limit,
            "cards": [c.to_dict() for c in cards],
        }

    @app.get("/api/v1/documents/{doc_id}/graph")
    def document_graph(
        doc_id: str, min_degree: int = 0, limit: int = 5000
    ) -> dict[str, Any]:
        repo: Repo = app.state.repo
        if repo.get_document(doc_id) is None:
            raise ApiError("E_NOTFOUND", f"文档不存在：{doc_id}", status=404)
        entities = repo.list_entities(doc_id)
        edges = repo.list_edges(doc_id)
        unit_map = repo.entity_unit_map(doc_id)
        nodes = [
            {**e.to_dict(unit_ids=unit_map.get(e.id, [])), "type": e.type}
            for e in entities
            if e.degree >= min_degree
        ][:limit]
        keep = {n["id"] for n in nodes}
        out_edges = [
            e.to_dict() for e in edges if e.src_id in keep and e.dst_id in keep
        ]
        verified = sum(1 for e in edges if (e.evidence_text or "").strip())
        return {
            "document_id": doc_id,
            "nodes": nodes,
            "edges": out_edges,
            "stats": {
                "nodes": len(nodes),
                "edges": len(out_edges),
                "types": len({e.etype for e in edges}),
                "verify_rate": round(verified / len(edges), 4) if edges else 0.0,
                "min_degree_filter": min_degree,
            },
        }

    @app.get("/api/v1/documents/{doc_id}/xrefs")
    def document_xrefs(
        doc_id: str, rel: str | None = None, offset: int = 0, limit: int = 1000
    ) -> dict[str, Any]:
        repo: Repo = app.state.repo
        xrefs, total = repo.list_xrefs(doc_id, rel=rel, offset=offset, limit=limit)
        return {
            "document_id": doc_id,
            "total": total,
            "histogram": repo.rel_histogram(doc_id),
            "cards_with_xrefs": repo.cards_with_xrefs(doc_id),
            "xrefs": [x.to_dict() for x in xrefs],
        }

    @app.get("/api/v1/documents/{doc_id}/file")
    def document_file(doc_id: str, request: Request) -> Response:
        repo: Repo = app.state.repo
        doc = repo.get_document(doc_id)
        if doc is None or not Path(doc.source_path).exists():
            raise ApiError("E_NOTFOUND", f"原始文件不存在：{doc_id}", status=404)
        return _range_response(Path(doc.source_path), request, _media_type(doc.kind))

    # ═══ 卡片 ═══
    @app.get("/api/v1/cards/{card_id}")
    def get_card(card_id: str) -> dict[str, Any]:
        repo: Repo = app.state.repo
        card: Card | None = repo.get_card(card_id)
        if card is None:
            raise ApiError("E_NOTFOUND", f"卡片不存在：{card_id}", status=404)
        doc = repo.get_document(card.doc_id)
        unit = repo.get_unit(card.unit_id)
        out_x = repo.out_links(card_id)
        back = repo.back_links(card_id)
        return {
            "card": card.to_dict(),
            "unit": unit.to_dict() if unit else None,
            "source": {
                "kind": doc.kind if doc else "",
                "file": Path(doc.source_path).name if doc else "",
                "page": card.span.start if card.span.kind == "page" else None,
                "url": f"/api/v1/documents/{card.doc_id}/file"
                + (f"#page={card.span.start}" if card.span.kind == "page" else ""),
            },
            "xrefs": [
                {"id": x["id"], "name": x["name"], "rel": x["rel"], "unit_id": x["unit_id"]}
                for x in out_x
            ],
            "backlinks": [
                {"id": x["id"], "name": x["name"], "rel": x["rel"], "unit_id": x["unit_id"]}
                for x in back
            ],
        }

    @app.get("/api/v1/cards/{card_id}/xrefs")
    def card_xrefs(card_id: str) -> dict[str, Any]:
        repo: Repo = app.state.repo
        if repo.get_card(card_id) is None:
            raise ApiError("E_NOTFOUND", f"卡片不存在：{card_id}", status=404)
        return {"card_id": card_id, "xrefs": repo.out_links(card_id)}

    @app.get("/api/v1/cards/{card_id}/backlinks")
    def card_backlinks(card_id: str) -> dict[str, Any]:
        repo: Repo = app.state.repo
        if repo.get_card(card_id) is None:
            raise ApiError("E_NOTFOUND", f"卡片不存在：{card_id}", status=404)
        return {"card_id": card_id, "backlinks": repo.back_links(card_id)}

    # ═══ 检索 ═══
    @app.get("/api/v1/search")
    def search(
        q: str = Query(..., description="查询词（中文按 bigram 切分）"),
        doc_id: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict[str, Any]:
        repo: Repo = app.state.repo
        hits = search_mod.search(repo, q, doc_id=doc_id, limit=limit, offset=offset)
        total = search_mod.search_total(repo, q, doc_id=doc_id)
        return {
            "q": q,
            "total": total,
            "limit": limit,
            "offset": offset,
            "mode": "bigram",
            "terms": search_mod.query_terms(q),
            "hits": [h.to_dict() for h in hits],
        }

    @app.get("/api/v1/search/suggest")
    def search_suggest(q: str = Query(...), limit: int = 10) -> dict[str, Any]:
        return {"q": q, "suggestions": search_mod.suggest(app.state.repo, q, limit=limit)}

    @app.get("/api/v1/search/contrast")
    def search_contrast(
        q: str = Query(..., description="对比 unicode61 与 bigram 的命中数"),
        doc_id: str | None = None,
    ) -> dict[str, Any]:
        """坑 15 的**可复现证明**：同一批文本、同一个词，两种 tokenizer 的命中数。"""
        repo: Repo = app.state.repo
        texts: list[str] = []
        if doc_id:
            for u in repo.all_units(doc_id):
                texts.append(f"{u.title} {u.text}")
            for c in repo.all_cards(doc_id):
                texts.append(" ".join(x for x in (c.name, c.one_line, c.purpose, c.evidence_quote) if x))
        else:
            rows = repo.db.query("SELECT body_bi FROM search_docs LIMIT 2000")
            for r in rows:
                texts.append(r["body_bi"])
        unicode61 = search_mod.contrast_unicode61(repo, q, texts)
        bigram = search_mod.search_total(repo, q, doc_id=doc_id)
        return {
            "q": q,
            "unicode61_hits": unicode61,
            "bigram_hits": bigram,
            "texts_compared": len(texts),
            "conclusion": "bigram 命中而 unicode61 为 0 → 必须自建 bigram（坑 15）",
        }

    # ═══ 任务 ═══
    @app.get("/api/v1/tasks")
    def list_tasks(
        doc_id: str | None = None, status: str | None = None, offset: int = 0, limit: int = 50
    ) -> dict[str, Any]:
        tasks, total = app.state.repo.list_tasks(
            doc_id=doc_id, status=status, offset=offset, limit=limit
        )
        return {"total": total, "tasks": [t.to_dict() for t in tasks]}

    @app.get("/api/v1/tasks/{task_id}")
    def get_task(task_id: str) -> dict[str, Any]:
        task: Task | None = app.state.repo.get_task(task_id)
        if task is None:
            raise ApiError("E_NOTFOUND", f"任务不存在：{task_id}", status=404)
        return task.to_dict()

    @app.get("/api/v1/tasks/{task_id}/events")
    def task_events(task_id: str, request: Request) -> Response:
        repo: Repo = app.state.repo
        task = repo.get_task(task_id)
        if task is None:
            raise ApiError("E_NOTFOUND", f"任务不存在：{task_id}", status=404)
        bus = app.state.runner.bus
        settings: Settings = app.state.settings
        last_id = parse_sse_last_id(request.headers.get("Last-Event-ID"))

        def terminal() -> bool:
            t = repo.get_task(task_id)
            return bool(t and t.is_terminal)

        gen: Iterator[str] = sse_frames(
            bus,
            task_id,
            last_event_id=last_id,
            poll_interval=settings.sse_poll_interval_s,
            keepalive=settings.sse_keepalive_s,
            is_terminal=terminal,
        )
        return StreamingResponse(
            gen,
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @app.post("/api/v1/tasks/{task_id}/cancel")
    def cancel_task(task_id: str) -> dict[str, Any]:
        task = app.state.runner.cancel(task_id)
        if task is None:
            raise ApiError("E_NOTFOUND", f"任务不存在：{task_id}", status=404)
        return task.to_dict()

    # ═══ 视频（数据由 T2 写；这里只做协议层）═══
    @app.get("/api/v1/documents/{doc_id}/video")
    def get_video(doc_id: str) -> dict[str, Any]:
        art = app.state.repo.get_video_artifact(doc_id)
        if art is None:
            raise ApiError(
                "E_NOTFOUND",
                f"该文档还没有视频产物：{doc_id}",
                status=404,
                hint="需要先跑 ASR 管线（server/video/**，T2）",
            )
        return art.to_dict()

    @app.get("/api/v1/documents/{doc_id}/video/subtitle")
    def get_video_subtitle(doc_id: str, fmt: str = Query("srt", pattern="^(srt|vtt)$")) -> Response:
        art = app.state.repo.get_video_artifact(doc_id)
        if art is None:
            raise ApiError("E_NOTFOUND", f"无字幕：{doc_id}", status=404)
        content = art.subtitle_srt if fmt == "srt" else art.subtitle_vtt
        if not content:
            raise ApiError(
                "E_NOTFOUND",
                f"字幕为空（ASR 可能未启用）：{doc_id}",
                status=404,
                hint="ASR 不可用时不会产出空字幕冒充成功",
            )
        return Response(
            content=content,
            media_type="application/x-subrip" if fmt == "srt" else "text/vtt",
            headers={"Content-Disposition": f'attachment; filename="{doc_id}.{fmt}"'},
        )

    @app.get("/api/v1/documents/{doc_id}/video/transcript")
    def get_video_transcript(doc_id: str) -> dict[str, Any]:
        art = app.state.repo.get_video_artifact(doc_id)
        if art is None:
            raise ApiError("E_NOTFOUND", f"无文稿：{doc_id}", status=404)
        return {"doc_id": doc_id, "transcript": [t.to_dict() for t in art.transcript]}

    @app.get("/api/v1/documents/{doc_id}/video/mindmap")
    def get_video_mindmap(doc_id: str) -> dict[str, Any]:
        art = app.state.repo.get_video_artifact(doc_id)
        if art is None:
            raise ApiError("E_NOTFOUND", f"无思维导图：{doc_id}", status=404)
        return {"doc_id": doc_id, "format": art.mindmap_format, "content": art.mindmap_content}

    @app.get("/api/v1/documents/{doc_id}/video/slides")
    def get_video_slides(doc_id: str) -> dict[str, Any]:
        art = app.state.repo.get_video_artifact(doc_id)
        if art is None:
            raise ApiError("E_NOTFOUND", f"无幻灯片帧：{doc_id}", status=404)
        return {
            "doc_id": doc_id,
            "slides": [s.to_dict() for s in art.slides],
            "note": "场景抽帧得到的是**图片帧**，不是可编辑 PPT（坑 11）",
        }

    @app.get("/api/v1/documents/{doc_id}/stream")
    def stream_video(doc_id: str, request: Request) -> Response:
        repo: Repo = app.state.repo
        doc = repo.get_document(doc_id)
        if doc is None or not Path(doc.source_path).exists():
            raise ApiError("E_NOTFOUND", f"视频文件不存在：{doc_id}", status=404)
        return _range_response(Path(doc.source_path), request, _media_type(doc.kind))

    @app.post("/api/v1/documents/{doc_id}/video/reparse")
    def reparse_video(doc_id: str, asr_model: str | None = None) -> dict[str, Any]:
        runner: TaskRunner = app.state.runner
        if "asr" not in runner.registered():
            raise ApiError(
                "E_ASR_LOAD",
                "ASR 管线尚未交付（server/video/** 属 T2 写域）",
                status=503,
                hint="交付后此端点会自动可用",
            )
        task = runner.submit("asr", doc_id)
        return {"document_id": doc_id, "task_id": task.id, "status": "queued",
                "events_url": f"/api/v1/tasks/{task.id}/events"}

    # ═══ 元信息 ═══
    @app.get("/api/v1/schema")
    def get_schema() -> dict[str, Any]:
        return {
            "edge_types": list(edge_types()),
            "card_kinds": list(card_kinds()),
            "entity_types": list(entity_types()),
        }

    @app.get("/api/v1/adapters")
    def get_adapters() -> dict[str, Any]:
        return {
            "adapters": registry.describe(),
            "extensions": list(registry.supported_extensions()),
        }


def _try_mount_pi_bridge(app: FastAPI) -> None:
    """挂载 T4 的 pi 桥（未交付时**不报错**，如实降级）。

    约定（与 pi-bridge 确认过）：
    * ``server/pi_bridge/ws.py::mount(app) -> bool``
    * ``server/pi_bridge/ws.py::pi_capabilities() -> dict``（已并入 /capabilities）
    """
    try:
        from server.pi_bridge.ws import mount as mount_pi_bridge  # type: ignore
    except ImportError as exc:
        log.info("pi_bridge 未交付，跳过挂载：%s", exc)
        return
    try:
        ok = mount_pi_bridge(app)
        log.info("pi_bridge 挂载：%s", ok)
    except Exception as exc:  # noqa: BLE001
        log.warning("pi_bridge 挂载失败（诚实降级）：%s", exc)


def _try_mount_web(app: FastAPI) -> None:
    """托管 T3 的 ``web/**`` 静态页（只读引用；目录不存在就跳过）。"""
    web_dir = Path(__file__).resolve().parents[1] / "web"
    if not web_dir.exists():
        return
    try:
        from fastapi.staticfiles import StaticFiles

        app.mount("/app", StaticFiles(directory=str(web_dir), html=True), name="web")

        @app.get("/")
        def _root() -> Response:
            index = web_dir / "index.html"
            if index.exists():
                return Response(
                    content=index.read_text(encoding="utf-8"), media_type="text/html"
                )
            return JSONResponse({"ok": True, "hint": "web/index.html 尚未交付", "api": "/api/v1/health"})

    except Exception as exc:  # noqa: BLE001
        log.info("web 静态目录挂载跳过：%s", exc)


def _media_type(kind: str) -> str:
    return {
        "pdf": "application/pdf",
        "video": "video/mp4",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text": "text/plain; charset=utf-8",
    }.get(kind, "application/octet-stream")


def _range_response(path: Path, request: Request, media_type: str) -> Response:
    """带 ``Range`` 的文件响应（PDF 跳页 / 视频拖动都要它）。"""
    size = path.stat().st_size
    range_header = request.headers.get("range")
    if not range_header:
        return StreamingResponse(
            _file_chunks(path),
            media_type=media_type,
            headers={"Accept-Ranges": "bytes", "Content-Length": str(size)},
        )
    try:
        unit, _, rng = range_header.partition("=")
        start_s, _, end_s = rng.partition("-")
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else size - 1
    except ValueError:
        raise ApiError("E_FORMAT", f"Range 头无法解析：{range_header}", status=400)
    end = min(end, size - 1)
    if start > end or start >= size:
        return Response(
            status_code=416, headers={"Content-Range": f"bytes */{size}"}
        )

    def gen() -> Iterator[bytes]:
        with path.open("rb") as fh:
            fh.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = fh.read(min(1024 * 256, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return StreamingResponse(
        gen(),
        status_code=206,
        media_type=media_type,
        headers={
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(end - start + 1),
        },
    )


def _file_chunks(path: Path) -> Iterator[bytes]:
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 512)
            if not chunk:
                break
            yield chunk


#: uvicorn 入口（``uvicorn server.main:app``）
app = create_app()
