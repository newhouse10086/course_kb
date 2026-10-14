# -*- coding: utf-8 -*-
"""端到端 API 测试（契约 §5 / §6）—— **真实 HTTP 调用**，不是 mock。

覆盖验收条目：
* ``GET /api/v1/health`` → ``{"ok": true, ...}``
* ``GET /api/v1/capabilities`` 如实反映本机能力（pi / ASR / ffmpeg / LLM）
* 上传真实 PDF → SSE 进度 → ``/outline`` 层次树 → ``/cards`` → ``/graph`` → ``/xrefs``
* 检索「索引」有结果；同条件 unicode61 = 0（``/search/contrast`` 对比证明）
* Range 请求（PDF 跳页 / 视频拖动）

LLM 用注入的 stub transport（**拉不到额度时也能验证链路正确性**）：
真实模型产出与管线正确性分开证明，报告里也会分开写。
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from worker.config import get_settings
from server.main import create_app
from worker.pipeline.llm import LLMClient
from server.store.db import open_db
from server.store.repo import Repo


# ═══════════════════════════════════════════════════════════════════════
# fixtures / 工具
# ═══════════════════════════════════════════════════════════════════════
def _make_settings(tmp_path: Path):
    s = get_settings()
    s.data_dir = tmp_path / "data"
    s.db_path = s.data_dir / "course_kb.sqlite3"
    s.__post_init__()
    s.ensure_dirs()
    s.llm_base_url = "http://stub.invalid/v1"
    s.llm_api_key = "stub-key"
    s.sse_poll_interval_s = 0.02
    s.sse_keepalive_s = 5.0
    return s


def _stub_payload(call_index: dict) -> str:
    """每次调用返回同一份结构（含中文，供检索断言用）。"""
    call_index["n"] = call_index.get("n", 0) + 1
    i = call_index["n"]
    return json.dumps(
        {
            "section": {
                "section_summary": "本节讲索引与事务的基本概念。",
                "learning_objectives": ["能说明聚簇索引的存储方式"],
                "section_role": "concept_intro",
                "key_takeaways": ["聚簇索引按主键顺序存放数据"],
            },
            "cards": [
                {
                    "name": f"聚簇索引{i}", "kind": "concept",
                    "one_line": "数据按主键顺序存放的索引",
                    "purpose": "让范围查询只读连续的一段数据",
                    "usage_mode": "server_automatic", "operational_role": "performance",
                    "lifecycle": "builtin", "example": "CREATE INDEX idx ON t(c);",
                    "example_explained": "在列 c 上建普通索引",
                    "prerequisites": [], "cautions": ["二级索引需要回表"],
                    "evidence_quote": "Clustered indexes sort rows by key.",
                    "evidence_page": 1, "confidence": 0.9,
                },
                {
                    "name": f"事务隔离级别{i}", "kind": "concept",
                    "one_line": "控制并发事务之间可见性的设置",
                    "purpose": "在一致性与并发度之间取舍",
                    "usage_mode": "user_invoked", "operational_role": "feature",
                    "lifecycle": "set_runtime", "example": None, "example_explained": None,
                    "prerequisites": [], "cautions": [],
                    "evidence_quote": "The isolation level controls visibility.",
                    "evidence_page": 1, "confidence": 0.85,
                },
            ],
            "entities": [
                {"name": "Clustered index", "name_zh": "聚簇索引", "type": "feature",
                 "layer": "L2"},
                {"name": "B+tree", "name_zh": "B+树", "type": "mechanism", "layer": "L1"},
            ],
            "edges": [
                {"src": "Clustered index", "dst": "B+tree", "etype": "IMPLEMENTS",
                 "evidence_text": "Clustered indexes implement a B-tree structure.",
                 "confidence": 0.9}
            ],
        },
        ensure_ascii=False,
    )


@pytest.fixture()
def client(tmp_path: Path):
    """真实 FastAPI app + 真实 SQLite + stub LLM（无网络）。"""
    settings = _make_settings(tmp_path)
    repo = Repo(open_db(settings.db_path))
    calls: dict = {}
    llm = LLMClient(settings, transport=lambda payload: _stub_payload(calls))
    app = create_app(settings=settings, repo=repo, llm=llm, start_runner=True)
    with TestClient(app) as c:
        c.app_state = app.state  # type: ignore[attr-defined]
        yield c
    app.state.runner.stop()


@pytest.fixture()
def pdf_path(tmp_path: Path) -> Path:
    """21 页 PDF：Chapter 3 跨度 12 页（>8）→ 触发递归下钻；末尾 Index 章应被排除。"""
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    for i in range(1, 22):
        page = doc.new_page()
        page.insert_text((72, 72), f"page {i} about indexes and transactions.")
    doc.set_toc(
        [
            [1, "Chapter 1 General Information", 1],
            [2, "1.1 About This Manual", 1],
            [3, "1.1.1 Using the Manual", 2],
            [1, "Chapter 2 Installing MySQL", 5],
            [2, "2.1 General Installation Guidance", 5],
            [1, "Chapter 3 Optimization and Indexes", 9],
            [2, "3.1 Add Indexes", 9],
            [2, "3.2 Transactions", 15],
            [1, "Index", 21],
        ]
    )
    p = tmp_path / "manual.pdf"
    doc.save(str(p))
    doc.close()
    return p


def _upload(client: TestClient, pdf: Path, name: str = "manual.pdf") -> dict:
    with pdf.open("rb") as fh:
        resp = client.post(
            "/api/v1/documents", files={"file": (name, fh, "application/pdf")}
        )
    assert resp.status_code == 202, resp.text
    return resp.json()


def _wait_task(client: TestClient, task_id: str, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        t = client.get(f"/api/v1/tasks/{task_id}").json()
        if t["status"] in ("done", "failed", "cancelled"):
            return t
        time.sleep(0.05)
    raise AssertionError(f"任务 {task_id} 超时未结束")


# ═══════════════════════════════════════════════════════════════════════
# 健康 / 能力（诚实接口）
# ═══════════════════════════════════════════════════════════════════════
def test_health(client: TestClient) -> None:
    r = client.get("/api/v1/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["version"] == "1.0.0"
    assert body["documents"] == 0 and body["units"] == 0 and body["cards"] == 0


def test_capabilities_honest(client: TestClient) -> None:
    r = client.get("/api/v1/capabilities")
    assert r.status_code == 200
    cap = r.json()
    # ① adapters 与实际注册表一致
    from worker.adapters import registry

    assert cap["adapters"] == registry.available_kinds()
    assert {"pdf", "pptx", "docx", "text"} <= set(cap["adapters"])
    # ② 四个能力块必须都在（缺了就是"假装可用"）
    for key in ("asr", "llm", "pi", "ffmpeg"):
        assert key in cap and isinstance(cap[key], dict), key
        assert "available" in cap[key], f"{key} 缺 available 字段（诚实接口要求）"
    # ③ LLM：stub 场景 configured=True（真实额度耗尽时 available 会是 false 并带 reason）
    assert cap["llm"]["configured"] is True
    assert cap["llm"]["concurrency"] == 1
    assert cap["llm"]["model"] == get_settings().llm_model
    # ④ 封闭枚举规模来自 schema/
    assert cap["schema"] == {"edge_types": 12, "card_kinds": 23, "entity_types": 12,
                             "layers": 4}
    # ⑤ 管线常量（不要重新发明的那些）
    assert cap["pipeline"]["max_pages_per_unit"] == 8
    assert cap["pipeline"]["span_threshold"] == 3
    assert cap["pipeline"]["llm_concurrency"] == 1
    assert cap["pipeline"]["unit_split"] == "recursive_descent_with_intro"
    # ⑥ 检索自述
    assert cap["search"]["tokenizer"] == "bigram"


def test_schema_endpoint(client: TestClient) -> None:
    r = client.get("/api/v1/schema")
    assert r.status_code == 200
    body = r.json()
    assert len(body["edge_types"]) == 12 and "IMPLEMENTS" in body["edge_types"]
    assert len(body["card_kinds"]) == 23 and "log_filter" in body["card_kinds"]
    assert len(body["entity_types"]) == 12


# ═══════════════════════════════════════════════════════════════════════
# 上传 → SSE → outline / cards / graph / xrefs / search
# ═══════════════════════════════════════════════════════════════════════
def test_upload_pdf_end_to_end(client: TestClient, pdf_path: Path) -> None:
    up = _upload(client, pdf_path)
    doc_id, task_id = up["document_id"], up["task_id"]
    assert doc_id.startswith("doc_") and task_id.startswith("tsk_")
    assert up["status"] == "uploading"
    assert up["events_url"] == f"/api/v1/tasks/{task_id}/events"

    task = _wait_task(client, task_id)
    assert task["status"] == "done", task
    assert task["progress"] == 1.0
    detail = task["detail"]
    assert detail["units"] == 8  # 9 个 TOC 条目 - 1 个 Index 章
    assert detail["parse_mode"] == "toc"
    assert detail["skipped_nodes"] == 1
    assert detail["llm_configured"] is True
    # Chapter 1/2 各 4 页（够小）→ 整体抽取；Chapter 3 跨 12 页 → **下钻**到 3.1/3.2
    assert detail["extract"]["llm_calls"] == 4
    assert detail["extract"]["pick"]["n_window"] == 0
    assert detail["extract"]["cards"] == 8
    assert detail["counts"]["units"] == 8
    assert detail["counts"]["cards"] == 8
    assert detail["counts"]["entities"] == 2 and detail["counts"]["edges"] == 1
    assert detail["xrefs"]["total"] == detail["counts"]["xrefs"]

    # ① 文档详情
    doc = client.get(f"/api/v1/documents/{doc_id}").json()
    assert doc["kind"] == "pdf" and doc["page_count"] == 21
    assert doc["status"] == "ready"
    assert doc["counts"]["units"] == 8 and doc["counts"]["cards"] == 8
    assert doc["meta"]["parse"]["toc_entries"] == 9
    assert doc["meta"]["parse"]["skipped_roots"] == ["Index"]
    assert doc["import_source"] == "llm_live"

    # ② 列表
    listing = client.get("/api/v1/documents").json()
    assert listing["total"] == 1
    assert listing["documents"][0]["id"] == doc_id

    # ③ /outline：层次树 + 所有层级都有 intro
    outline = client.get(f"/api/v1/documents/{doc_id}/outline").json()
    assert len(outline["roots"]) == 3
    assert len(outline["nodes"]) == 8
    assert set(outline["roots"]) <= set(outline["nodes"])
    ch1 = [n for n in outline["nodes"].values() if n["title"] == "Chapter 1 General Information"][0]
    assert ch1["level"] == 1
    assert len(ch1["children"]) == 1
    assert ch1["span"] == {"kind": "page", "start": 1, "end": 4}
    assert ch1["n_cards"] == 2 and ch1["n_units"] == 3
    # 被抽取的节点有 section_summary（S1 产出）
    assert ch1["intro"] == "本节讲索引与事务的基本概念。"
    assert ch1["intro_source"] == "section_summary"
    # Chapter 3 跨 12 页没被抽取 → 由**子节点标题**做确定性汇总（不是编造）
    ch3 = [n for n in outline["nodes"].values() if n["title"] == "Chapter 3 Optimization and Indexes"][0]
    assert ch3["intro"] == "本节包含 3.1 Add Indexes、3.2 Transactions。"
    assert ch3["why"] == ""
    assert ch3["intro_source"] == "rollup_titles"
    assert ch3["n_cards"] == 4 and ch3["n_units"] == 3
    # 没被抽取的叶子：如实标注"未生成摘要"，而不是空着或编一句
    leaf = [n for n in outline["nodes"].values() if n["title"] == "2.1 General Installation Guidance"][0]
    assert leaf["intro"].startswith("（未生成摘要）正文开头：page 5")
    assert leaf["intro_source"] == "none"
    assert outline["stats"]["with_intro"] == 8  # F3：可见节点 100% 有 intro
    assert outline["stats"]["intro_sources"]["section_summary"] == 4
    assert outline["stats"]["intro_sources"]["rollup_titles"] == 1
    assert outline["stats"]["intro_sources"]["none"] == 3

    # ④ /units
    units = client.get(f"/api/v1/documents/{doc_id}/units").json()
    assert units["total"] == 8
    assert units["units"][0]["title"] == "Chapter 1 General Information"
    assert units["units"][0]["order"] == 1
    assert units["units"][0]["span"]["kind"] == "page"

    # ⑤ /cards
    cards = client.get(f"/api/v1/documents/{doc_id}/cards").json()
    assert cards["total"] == 8
    names = {c["name"] for c in cards["cards"]}
    assert names == {f"聚簇索引{i}" for i in range(1, 5)} | {
        f"事务隔离级别{i}" for i in range(1, 5)
    }
    one = cards["cards"][0]
    assert one["kind"] == "concept"
    assert one["evidence_span"]["kind"] == "page"
    assert one["confidence"] == pytest.approx(0.9)
    assert one["cautions"] == ["二级索引需要回表"]

    # ⑥ 单卡片：含 unit / source / xrefs / backlinks
    card_id = one["id"]
    single = client.get(f"/api/v1/cards/{card_id}").json()
    assert single["card"]["id"] == card_id
    assert single["unit"]["id"] == one["unit_id"]
    assert single["source"]["kind"] == "pdf"
    assert single["source"]["url"].endswith(f"/documents/{doc_id}/file#page=1")
    assert isinstance(single["xrefs"], list) and isinstance(single["backlinks"], list)
    assert client.get(f"/api/v1/cards/{card_id}/xrefs").json()["xrefs"] == single["xrefs"]
    assert client.get(f"/api/v1/cards/{card_id}/backlinks").json()["backlinks"] == single["backlinks"]

    # ⑦ /graph：同名实体跨单元**归并**（2 个），同一 (src,dst,etype) 只留 1 条边
    graph = client.get(f"/api/v1/documents/{doc_id}/graph").json()
    assert graph["stats"]["nodes"] == 2
    assert graph["stats"]["edges"] == 1
    assert graph["stats"]["types"] == 1
    assert graph["stats"]["verify_rate"] == 1.0
    node_names = sorted(n["name"] for n in graph["nodes"])
    assert node_names == ["B+tree", "Clustered index"]
    edge = graph["edges"][0]
    assert edge["etype"] == "IMPLEMENTS"
    assert edge["src"] != edge["dst"]
    assert edge["flagged"] is False
    assert "B-tree structure" in edge["evidence"]
    node = [n for n in graph["nodes"] if n["name"] == "Clustered index"][0]
    assert node["type"] == "feature" and node["layer"] == "L2"
    assert node["degree"] == 1 and len(node["unit_ids"]) >= 1

    # ⑧ /xrefs：四路来源与直方图
    xr = client.get(f"/api/v1/documents/{doc_id}/xrefs").json()
    assert xr["total"] == len(xr["xrefs"])
    assert xr["histogram"].get("typed", 0) >= 1
    assert xr["histogram"].get("same_unit", 0) >= 1
    assert xr["cards_with_xrefs"] >= 1
    assert all(x["from_card_id"] != x["to_card_id"] for x in xr["xrefs"])

    # ⑨ 检索：中文 2 字词有结果（bigram）
    s = client.get("/api/v1/search", params={"q": "索引"}).json()
    assert s["total"] >= 1
    assert s["mode"] == "bigram" and s["terms"] == ["索引"]
    assert all("聚簇索引" in h["title"] or "索引" in h["title"] for h in s["hits"])
    s2 = client.get("/api/v1/search", params={"q": "事务"}).json()
    assert s2["total"] >= 1
    # 英文标识符
    assert client.get("/api/v1/search", params={"q": "B+tree"}).json()["total"] >= 1
    # 不存在的词 → 0
    assert client.get("/api/v1/search", params={"q": "根本不存在的词组"}).json()["total"] == 0
    sug = client.get("/api/v1/search/suggest", params={"q": "聚簇"}).json()
    assert any("聚簇" in x for x in sug["suggestions"])

    # ⑩ 坑 15 对比证明
    contrast = client.get("/api/v1/search/contrast",
                          params={"q": "索引", "doc_id": doc_id}).json()
    assert contrast["bigram_hits"] >= 1
    assert contrast["unicode61_hits"] == 0
    assert contrast["texts_compared"] == 8 + 8  # units + cards

    # ⑪ Range 请求（PDF 跳页 / 视频拖动依赖它）
    full = client.get(f"/api/v1/documents/{doc_id}/file")
    assert full.status_code == 200
    assert full.headers["content-type"] == "application/pdf"
    assert full.headers["accept-ranges"] == "bytes"
    size = len(full.content)
    assert size == pdf_path.stat().st_size
    part = client.get(f"/api/v1/documents/{doc_id}/file",
                      headers={"Range": "bytes=0-99"})
    assert part.status_code == 206
    assert part.headers["content-range"] == f"bytes 0-99/{size}"
    assert len(part.content) == 100
    assert part.content == full.content[:100]
    bad = client.get(f"/api/v1/documents/{doc_id}/file",
                     headers={"Range": f"bytes={size + 10}-"})
    assert bad.status_code == 416

    # ⑫ SSE：历史事件可重放（progress + done），data 是单行 JSON
    sse = client.get(up["events_url"])
    assert sse.status_code == 200
    assert sse.headers["content-type"].startswith("text/event-stream")
    body = sse.text
    assert "event: progress" in body and "event: done" in body
    assert '"progress"' in body
    frames = [f for f in body.split("\n\n") if f.strip()]
    data_lines = [ln for f in frames for ln in f.split("\n") if ln.startswith("data: ")]
    assert data_lines and all("\n" not in ln for ln in data_lines)
    for ln in data_lines:
        json.loads(ln[6:])  # 都能解析

    # ⑬ 删除（级联）
    deleted = client.delete(f"/api/v1/documents/{doc_id}")
    assert deleted.status_code == 200 and deleted.json()["deleted"] is True
    assert client.get(f"/api/v1/documents/{doc_id}").status_code == 404
    assert client.get(f"/api/v1/documents/{doc_id}/cards").json()["total"] == 0
    # 原始文件也随文档清理不要求（保留可下载），但库里不能留卡片
    assert client.get("/api/v1/health").json()["cards"] == 0


def test_capabilities_reflects_llm_unconfigured(tmp_path: Path) -> None:
    """无凭据时：capabilities 如实 false，且上传任务**不假装抽了卡片**。"""
    settings = _make_settings(tmp_path)
    settings.llm_base_url = ""
    settings.llm_api_key = ""
    repo = Repo(open_db(settings.db_path))
    app = create_app(settings=settings, repo=repo, llm=LLMClient(settings), start_runner=True)
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    for i in range(1, 5):
        doc.new_page().insert_text((72, 72), f"page {i}")
    doc.set_toc([[1, "Chapter 1 Only", 1]])
    pdf = tmp_path / "small.pdf"
    doc.save(str(pdf))
    doc.close()
    with TestClient(app) as client:
        cap = client.get("/api/v1/capabilities").json()
        assert cap["llm"]["configured"] is False
        assert cap["llm"]["available"] is False
        assert "AMR_KEY" in cap["llm"]["reason"]
        with pdf.open("rb") as fh:
            up = client.post("/api/v1/documents",
                             files={"file": ("small.pdf", fh, "application/pdf")}).json()
        task = _wait_task(client, up["task_id"])
        assert task["status"] == "done"
        assert task["detail"]["llm_configured"] is False
        assert "未配置 LLM 凭据" in task["detail"]["note"]
        assert "extract" not in task["detail"]
        # units 仍然解析出来了（解析不依赖 LLM）
        assert client.get(f"/api/v1/documents/{up['document_id']}/units").json()["total"] == 1
        assert client.get(f"/api/v1/documents/{up['document_id']}/cards").json()["total"] == 0
    app.state.runner.stop()


# ═══════════════════════════════════════════════════════════════════════
# 错误码（契约 §8）
# ═══════════════════════════════════════════════════════════════════════
def test_unsupported_format_415(client: TestClient, tmp_path: Path) -> None:
    p = tmp_path / "x.zzz"
    p.write_bytes(b"\x00\x01\x02\x03")
    with p.open("rb") as fh:
        r = client.post("/api/v1/documents", files={"file": ("x.zzz", fh, "application/octet-stream")})
    assert r.status_code == 415
    body = r.json()["error"]
    assert body["code"] == "E_FORMAT"
    assert ".pdf" in body["detail"]
    # 上传失败不留下空文档
    assert client.get("/api/v1/documents").json()["total"] == 0


def test_too_big_413(client: TestClient, pdf_path: Path) -> None:
    client.app_state.settings.max_upload_bytes = 100  # type: ignore[attr-defined]
    with pdf_path.open("rb") as fh:
        r = client.post("/api/v1/documents", files={"file": ("manual.pdf", fh, "application/pdf")})
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "E_TOOBIG"
    assert client.get("/api/v1/documents").json()["total"] == 0


def test_not_found_404s(client: TestClient) -> None:
    assert client.get("/api/v1/documents/doc_missing").status_code == 404
    assert client.get("/api/v1/documents/doc_missing/outline").status_code == 404
    assert client.get("/api/v1/documents/doc_missing/graph").status_code == 404
    assert client.get("/api/v1/cards/crd_missing").status_code == 404
    assert client.get("/api/v1/cards/crd_missing/xrefs").status_code == 404
    assert client.get("/api/v1/tasks/tsk_missing").status_code == 404
    assert client.get("/api/v1/tasks/tsk_missing/events").status_code == 404
    assert client.post("/api/v1/tasks/tsk_missing/cancel").status_code == 404
    body = client.get("/api/v1/documents/doc_missing").json()["error"]
    assert body["code"] == "E_NOTFOUND" and "doc_missing" in body["msg"]


def test_video_endpoints_degrade_honestly(client: TestClient, pdf_path: Path) -> None:
    """视频产物不存在时 → 404（不是空切片假装成功）。"""
    up = _upload(client, pdf_path)
    for path in ("video", "video/subtitle", "video/transcript", "video/mindmap", "video/slides"):
        r = client.get(f"/api/v1/documents/{up['document_id']}/{path}")
        assert r.status_code == 404, path
    # ASR 未交付时 reparse 如实返回 503，而不是排队一个跑不起来的任务
    if "asr" not in client.app_state.runner.registered():  # type: ignore[attr-defined]
        r = client.post(f"/api/v1/documents/{up['document_id']}/video/reparse")
        assert r.status_code == 503
        assert r.json()["error"]["code"] == "E_ASR_LOAD"


def test_text_document_end_to_end(client: TestClient, tmp_path: Path) -> None:
    """新增格式只写 adapter，核心不动 —— 用纯文本验证同一条链路。"""
    p = tmp_path / "lecture.md"
    p.write_text(
        "# 第一章 数据库基础\n关系模型把数据组织成表。\n"
        "## 1.1 索引\n聚簇索引按主键顺序存放数据。\n"
        "## 1.2 事务\n事务的隔离级别决定并发可见性。\n",
        encoding="utf-8",
    )
    with p.open("rb") as fh:
        up = client.post("/api/v1/documents",
                         files={"file": ("lecture.md", fh, "text/markdown")}).json()
    task = _wait_task(client, up["task_id"])
    assert task["status"] == "done", task
    assert task["detail"]["units"] == 3
    assert task["detail"]["parse_mode"] == "headings"
    doc_id = up["document_id"]
    units = client.get(f"/api/v1/documents/{doc_id}/units").json()
    assert [u["title"] for u in units["units"]] == ["第一章 数据库基础", "1.1 索引", "1.2 事务"]
    assert [u["level"] for u in units["units"]] == [1, 2, 2]
    assert all(u["span"]["kind"] == "char" for u in units["units"])
    assert client.get(f"/api/v1/documents/{doc_id}").json()["kind"] == "text"
    # char span 的父子区间**不嵌套**（父区间止于下一个标题）→ 必须下钻：
    # 顶层自己的开头段作为 intro 单元 + 两个小节，共 3 个抽取单元
    pick = task["detail"]["extract"]["pick"]
    assert pick["n_picked"] == 3 and pick["n_intro"] == 1 and pick["n_section"] == 2
    assert pick["coverage"] == 1.0 and pick["missing_count"] == 0
    assert task["detail"]["extract"]["llm_calls"] == 3
    cards = client.get(f"/api/v1/documents/{doc_id}/cards").json()
    assert cards["total"] == 6
    assert cards["cards"][0]["evidence_span"]["kind"] == "char"


def test_long_text_splits_windows_without_losing_chars(client: TestClient, tmp_path: Path) -> None:
    """跨度 > 字符预算时**必须切窗**（bug 5 的同一个道理，char span 版）。"""
    body = "索引与事务的正文内容。" * 2000  # 每节 ~22000 字符 ≫ 8000 预算
    p = tmp_path / "long.md"
    p.write_text(
        "# 第一章 数据库基础\n" + body + "\n"
        "## 1.1 索引\n" + body + "\n"
        "## 1.2 事务\n" + body + "\n",
        encoding="utf-8",
    )
    with p.open("rb") as fh:
        up = client.post("/api/v1/documents",
                         files={"file": ("long.md", fh, "text/markdown")}).json()
    task = _wait_task(client, up["task_id"])
    assert task["status"] == "done", task
    pick = task["detail"]["extract"]["pick"]
    # 3 段 × 各 3 个窗口（8000/8000/6000）= 9 个抽取单元，一个字符都不丢
    assert pick["n_picked"] == 9 and pick["n_window"] == 9
    assert pick["coverage"] == 1.0 and pick["missing_count"] == 0
    assert task["detail"]["extract"]["llm_calls"] == 9
    assert client.get(f"/api/v1/documents/{up['document_id']}/cards").json()["total"] == 18
