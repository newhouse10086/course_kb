"""Python worker 入口（CLI + **严格 JSONL** 协议）。

契约：``docs/ARCHITECTURE_V2.md`` §3.1。

```
Node:  spawn("python", ["-m", "worker.cli", "--job", "parse", "--in", "<json>"], ...)
       stdin:  一个 JSON（任务参数）
       stdout: 一行一个 JSON（进度/结果），**严格 JSONL**
       stderr: 日志（非协议，随便写）
```

## stdout 只走协议（硬保证）

外壳做了两件事，让**任何**第三方库的 `print()` 都不污染协议：

1. 事件写入**保存下来的真实 stdout buffer**（UTF-8 字节 + 立即 flush）；
2. 任务执行期间把 ``sys.stdout`` **重定向到 stderr**（坑 12 的同源教训：
   "stdout 只走协议数据，日志走 stderr"）。

另外输出统一 **纯 ASCII**（``ensure_ascii=True``）：中文转成 ``\\uXXXX``，
这样任何"按 ``\\n`` 切字节"的读取器都不会被多字节字符或 U+2028/2029 坑到
（**Node 侧同样不许用 readline**）。

## 事件（§3.1）

```json
{"type":"progress","stage":"parse","frac":0.42,"detail":{"page":1040}}
{"type":"log","level":"info","msg":"..."}
{"type":"unit","data":{...}}          // 增量产出（大文档流式入库）
{"type":"result","data":{...}}        // 最终结果（每轮恰好一个）
{"type":"error","code":"E_PARSE","msg":"...","detail":"..."}
```

## 退出码

| code | 含义 |
|---|---|
| 0 | 成功（**可能带降级**，降级信息在 result.data 里） |
| 1 | 任务失败（已发 ``error`` 事件） |
| 2 | 参数/用法错误（JSON 坏了、job 不存在、缺字段） |
| 130 | 被中断（Ctrl-C / 父进程 kill） |

## job 一览

| job | 作用 | 归谁 |
|---|---|---|
| ``parse`` | 文件 → 层次化 units（PDF/PPTX/DOCX/TXT） | T-WORKER |
| ``units`` | 单元划分（递归下降 + 引言段，坑 5） | T-WORKER |
| ``extract`` | units → 卡片 + 图谱（LLM 配置**从参数传入**） | T-WORKER |
| ``extract.plan`` | 只产出提示词 + json_schema（Node 自己调 LLM） | T-WORKER |
| ``extract.convert`` | 把模型输出校验/转成卡片 + 图谱 | T-WORKER |
| ``xref`` | 交叉引用（mention 假阳性过滤，坑 6） | T-WORKER |
| ``index`` | bigram 检索行（坑 15） | T-WORKER |
| ``search`` | 查询词 → bigram 词项 + FTS5 MATCH 表达式 | T-WORKER |
| ``video.*`` | 视频管线（整包转 ``worker.video.job.run_job``） | T2 video-pipeline |
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import logging
import os
import sys
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from worker import stdio

#: 版本号：Node 侧可用 ``--version`` 做兼容判断
WORKER_VERSION = "2.0.0"

#: 错误码（与 v1 契约 §8 对齐；worker 侧只用到这几个）
E_JOB_JSON = "E_JOB_JSON"          # 入参 JSON 坏了
E_JOB_UNKNOWN = "E_JOB_UNKNOWN"    # 未知 job
E_PAYLOAD = "E_PAYLOAD"            # job 参数缺字段/类型不对
E_NOFILE = "E_NOFILE"
E_FORMAT = "E_FORMAT"
E_PARSE = "E_PARSE"
E_LLM = "E_LLM"
E_LLM_SCHEMA = "E_LLM_SCHEMA"
E_INTERNAL = "E_INTERNAL"

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_INTERRUPT = 130

log = logging.getLogger("worker.cli")


class PayloadError(ValueError):
    """job 参数不合法（缺字段/类型不对）→ 退出码 2。"""

    code = E_PAYLOAD


# ═══════════════════════════════════════════════════════════════════════
# 事件发射器（**唯一**写 stdout 的地方）
# ═══════════════════════════════════════════════════════════════════════
class Emitter:
    """把事件写成一行一个 JSON（纯 ASCII + 立即 flush）。"""

    def __init__(self, stream: Any | None = None, *, echo_stderr: bool = False):
        #: 保存**真实** stdout（任务执行期间 sys.stdout 会被重定向到 stderr）
        self._stream = stream if stream is not None else sys.stdout.buffer
        self._echo = echo_stderr
        self.count = 0
        #: 最近一次 result.data（``--out`` 用）
        self.last_result: dict[str, Any] | None = None

    def __call__(self, event: dict[str, Any]) -> None:
        line = json.dumps(event, ensure_ascii=True, separators=(",", ":"))
        # 一行一个 JSON：字符串里的换行已被 json 转义，这里只写记录分隔符
        data = (line + "\n").encode("utf-8")
        try:
            self._stream.write(data)
            self._stream.flush()
        except (BrokenPipeError, ValueError):
            # 下游（Node）已经关了管道：不是我们的错，也不要炸出 traceback
            pass
        self.count += 1
        if self._echo:
            sys.stderr.write(line + "\n")

    # ── 语义化快捷方法 ──────────────────────────────────────────────
    def progress(self, stage: str, frac: float, detail: dict[str, Any] | None = None) -> None:
        self(
            {
                "type": "progress",
                "stage": stage,
                "frac": max(0.0, min(1.0, round(float(frac), 4))),
                "detail": detail or {},
            }
        )

    def info(self, msg: str) -> None:
        self({"type": "log", "level": "info", "msg": msg})

    def warn(self, msg: str) -> None:
        self({"type": "log", "level": "warning", "msg": msg})

    def unit(self, data: dict[str, Any]) -> None:
        self({"type": "unit", "data": data})

    def result(self, data: dict[str, Any]) -> None:
        self.last_result = data
        self({"type": "result", "data": data})

    def error(self, code: str, msg: str, detail: str = "") -> None:
        self({"type": "error", "code": code, "msg": msg, "detail": detail})


# ═══════════════════════════════════════════════════════════════════════
# 入参解析
# ═══════════════════════════════════════════════════════════════════════
def read_payload(in_path: str | None) -> dict[str, Any]:
    """读 job 参数。

    三种来源都要支持（Node 调用器的习惯不一样，实测 T-BACKEND 两种都给）：

    1. ``--in <文件路径>`` → 读文件
    2. ``--in '<内联 JSON>'`` → 直接当 JSON 解析（T-BACKEND 就是这么传的）
    3. 缺省 / ``-`` → 读 stdin

    任何一步失败都尽量回退到下一来源：**不要因为传法不同就报"参数错误"**。
    """
    candidates: list[str] = []
    if in_path and in_path != "-":
        p = Path(in_path)
        if p.exists() and p.is_file():
            # ★ 显式解码（BOM 识别 + UTF-8 strict），不用默认编码
            candidates.append(stdio.read_text_file(p))
        else:
            candidates.append(in_path)  # 内联 JSON
    try:
        if not sys.stdin.isatty():
            # ★★ 关键修复：**不用 sys.stdin.read()** —— 它按语言环境解码
            #    （Windows 中文机 = GBK）→ 中文 payload 走 stdin 会**静默乱码**。
            #    而 stdin 正是我们**推荐**的大 payload 通道（argv 有 32KB 上限，坑 18）。
            #    第一版只在调用方恰好设了 PYTHONIOENCODING=utf-8 时才对 ——
            #    "靠调用方的巧合"正是最脆的安全（T-BACKEND 实测：Node 调用器设了 env 所以一直绿）。
            candidates.append(stdio.read_stdin_text())
    except stdio.PayloadEncodingError:
        raise

    errors: list[str] = []
    for raw in candidates:
        raw = (raw or "").strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            errors.append(f"{exc}")
            continue
        if not isinstance(data, dict):
            errors.append(f"参数必须是 JSON 对象，收到 {type(data).__name__}")
            continue
        return normalize_payload(data)
    raise PayloadError(
        "没有收到合法的 JSON 参数（--in <file|JSON> 或 stdin）"
        + (f"；尝试过 {len(candidates)} 个来源，错误：{'; '.join(errors[:2])}" if errors else "")
    )


def normalize_payload(data: dict[str, Any]) -> dict[str, Any]:
    """把嵌套的 ``input`` 摊平（不同调用器的习惯不同，两种都认）。

    ``{"job":"asr","input":{"op":"probe"}}`` ≡ ``{"job":"asr","op":"probe"}``
    显式的外层字段优先（避免内层意外覆盖 job 名）。
    """
    inner = data.get("input")
    if isinstance(inner, dict):
        merged = {**inner, **data}
        merged["input"] = inner  # 保留原样，方便 job 自己再看
        return merged
    return data


def need(payload: dict[str, Any], key: str, typ: type | tuple[type, ...] = object) -> Any:
    if key not in payload or payload[key] is None:
        raise PayloadError(f"缺少字段 {key!r}")
    val = payload[key]
    if typ is not object and not isinstance(val, typ):
        raise PayloadError(f"字段 {key!r} 类型应为 {typ}，收到 {type(val).__name__}")
    return val


def opt(payload: dict[str, Any], key: str, default: Any = None) -> Any:
    val = payload.get(key)
    return default if val is None else val


# ═══════════════════════════════════════════════════════════════════════
# 模型 ↔ dict（Node 传 JSON，worker 用 models）
# ═══════════════════════════════════════════════════════════════════════
def units_from_payload(raw_units: Sequence[dict[str, Any]], doc_id: str) -> "list[Any]":
    """把入参里的 units 变成 model 对象 —— **两种形状都收**：

    1. **持久化形状**（Node 从 SQLite 读出来）：有 ``id`` / ``parent_id``
    2. **``parse`` 的输出形状**（契约 §4 ``UnitDraft``）：``ord`` / ``parent_ord``，**没有 id**

    第 2 种很重要：Node 往往在**入库前**就调 ``units`` / ``extract.plan``
    （先拿提示词再入库），此时没有 id。这里用**确定性 id**
    （``extract_core.synth_unit_id(ord)``，**与 doc_id 无关**）补齐，
    父子关系按 ``parent_ord → parent_id`` 映射，这样 ``picked[].unit_id``
    在 plan / convert 两次独立调用之间**一定一致**（否则 key 对不上 → 卡片被静默丢弃）。
    """
    from worker.models import Span, Unit
    from worker.pipeline.extract_core import synth_unit_id

    if not raw_units:
        return []
    # 判定形状：只要有一条带 id 就按持久化形状处理
    has_ids = any(u.get("id") for u in raw_units)
    if has_ids:
        return [unit_from_dict(u, doc_id) for u in raw_units]

    ord_to_id: dict[int, str] = {}
    for u in raw_units:
        ord_val = int(u.get("ord", u.get("order", 0)) or 0)
        ord_to_id[ord_val] = synth_unit_id(ord_val)
    out: list[Any] = []
    for u in raw_units:
        span = u.get("span") or {}
        ord_val = int(u.get("ord", u.get("order", 0)) or 0)
        parent_ord = u.get("parent_ord")
        out.append(
            Unit(
                id=ord_to_id[ord_val],
                doc_id=doc_id,
                ord=ord_val,
                title=str(u.get("title") or ""),
                level=int(u.get("level") or 1),
                parent_id=(ord_to_id.get(int(parent_ord)) if parent_ord is not None else None),
                span=Span(
                    str(span.get("kind") or "page"),
                    int(span.get("start") or 0),
                    int(span.get("end") or span.get("start") or 0),
                ),
                text=str(u.get("text") or ""),
            )
        )
    return out


def unit_from_dict(d: dict[str, Any], doc_id: str) -> "Any":
    from worker.models import Span, Unit

    span = d.get("span") or {}
    return Unit(
        id=str(need(d, "id")),
        doc_id=str(d.get("doc_id") or doc_id),
        ord=int(d.get("order", d.get("ord", 0))),
        title=str(d.get("title") or ""),
        level=int(d.get("level") or 1),
        parent_id=d.get("parent_id"),
        span=Span(
            str(span.get("kind") or "page"),
            int(span.get("start") or 0),
            int(span.get("end") or span.get("start") or 0),
        ),
        text=str(d.get("text") or ""),
    )


def card_from_dict(d: dict[str, Any]) -> "Any":
    from worker.models import Card, Span

    span = d.get("evidence_span") or d.get("span") or {}
    return Card(
        id=str(need(d, "id")),
        doc_id=str(need(d, "doc_id")),
        unit_id=str(need(d, "unit_id")),
        name=str(need(d, "name")),
        kind=str(need(d, "kind")),
        one_line=str(d.get("one_line") or ""),
        purpose=str(d.get("purpose") or ""),
        usage_mode=str(d.get("usage_mode") or "unknown"),
        operational_role=str(d.get("operational_role") or "unknown"),
        lifecycle=str(d.get("lifecycle") or "unknown"),
        example=d.get("example"),
        example_explained=d.get("example_explained"),
        prerequisites=list(d.get("prerequisites") or []),
        cautions=list(d.get("cautions") or []),
        evidence_quote=str(d.get("evidence_quote") or ""),
        span=Span(
            str(span.get("kind") or "page"),
            int(span.get("start") or 0),
            int(span.get("end") or span.get("start") or 0),
        ),
        confidence=float(d.get("confidence") or 0.0),
    )


def entity_from_dict(d: dict[str, Any], doc_id: str) -> "Any":
    from worker.models import Entity

    return Entity(
        id=str(need(d, "id")),
        doc_id=str(d.get("doc_id") or doc_id),
        name=str(need(d, "name")),
        name_zh=str(d.get("name_zh") or ""),
        layer=str(d.get("layer") or ""),
        type=str(d.get("type") or "concept"),
        degree=int(d.get("degree") or 0),
    )


def edge_from_dict(d: dict[str, Any], doc_id: str) -> "Any":
    from worker.models import Edge, Span

    span = d.get("span") or {}
    return Edge(
        id=str(need(d, "id")),
        doc_id=str(d.get("doc_id") or doc_id),
        src_id=str(d.get("src_id") or d.get("src")),
        dst_id=str(d.get("dst_id") or d.get("dst")),
        etype=str(need(d, "etype")),
        evidence_text=str(d.get("evidence_text") or d.get("evidence") or ""),
        span=Span(
            str(span.get("kind") or "page"),
            int(span.get("start") or 0),
            int(span.get("end") or span.get("start") or 0),
        ),
        confidence=float(d.get("confidence") or 0.0),
        flagged=bool(d.get("flagged", False)),
    )


def _doc_id(payload: dict[str, Any]) -> str:
    """worker 不生成文档 ID（ID 归 Node），但内部模型需要它。

    缺省用 ``doc_worker000000``：只用于模型校验，不会写进任何存储。
    """
    return str(payload.get("doc_id") or "doc_worker000000")


# ═══════════════════════════════════════════════════════════════════════
# 各 job 实现（签名统一：payload, emit → result dict）
# ═══════════════════════════════════════════════════════════════════════
def job_parse(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """文件 → 层次化 units（adapter 可插拔，核心不动）。"""
    from worker.adapters import registry
    from worker.adapters.base import UnsupportedFormat

    path = str(need(payload, "path", str))
    p = Path(path)
    if not p.exists():
        raise PayloadError(f"文件不存在：{path}")

    try:
        adapter = registry.pick(path)
    except UnsupportedFormat as exc:
        from worker.cli import _Fail

        raise _Fail(E_FORMAT, str(exc), f"支持：{', '.join(registry.supported_extensions())}")

    kind_hint = opt(payload, "kind")
    if kind_hint:
        forced = registry.by_kind(str(kind_hint))
        if forced is not None:
            adapter = forced

    max_pages_per_unit = int(opt(payload, "max_pages_per_unit", 8) or 8)
    max_pages = int(opt(payload, "max_pages", 0) or 0)
    # 允许覆盖 adapter 的构造参数（PDF 的页窗 / 页数上限）
    if adapter.kind == "pdf":
        adapter = type(adapter)(max_pages_per_unit=max_pages_per_unit, max_pages=max_pages)

    stream_units = bool(opt(payload, "stream_units", True))
    emit.progress("parse", 0.0, {"adapter": type(adapter).__name__, "kind": adapter.kind})

    def on_progress(frac: float, stage: str) -> None:
        emit.progress("parse", frac, {"stage": stage})

    draft = adapter.parse(path, on_progress=on_progress)
    draft.validate()

    # 增量产出 units（大文档可以让 Node 边解析边入库）
    if stream_units:
        for u in draft.units:
            emit.unit(u.to_dict())

    result = {
        # ★ T-BACKEND 约定的形状（document / units / stats）—— 直接用，不让他们适配
        "document": {
            "title": draft.title,
            "kind": draft.kind,
            "page_count": draft.page_count,
            "lang": draft.lang,
            "meta": {"parse": dict(draft.meta or {})},
        },
        "units": [u.to_dict() for u in draft.units],
        "stats": {
            "units": len(draft.units),
            "chars": draft.text_chars,
            "roots": len(draft.roots),
            "max_level": max((u.level for u in draft.units), default=0),
            "parse_mode": (draft.meta or {}).get("mode"),
            "skipped_nodes": (draft.meta or {}).get("skipped_nodes"),
            "streamed_units": len(draft.units) if stream_units else 0,
        },
        # 兼容字段（v1 形状，UI/调试可能还在用）
        "title": draft.title,
        "kind": draft.kind,
        "page_count": draft.page_count,
        "lang": draft.lang,
        "meta": dict(draft.meta or {}),
        "adapter": type(adapter).__name__,
    }
    emit.progress("parse", 1.0, {"units": len(draft.units)})
    return result


def job_units(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """单元划分：递归下降 + 引言段 + 大跨度切窗（坑 5）。"""
    from worker.pipeline import units as units_mod

    doc_id = _doc_id(payload)
    raw_units = need(payload, "units", list)
    units = units_from_payload(raw_units, doc_id)
    max_pages = int(opt(payload, "max_pages", 8) or 8)
    pages_total = int(opt(payload, "pages_total", 0) or 0)
    excluded = opt(payload, "excluded_ranges") or []

    picked, stats = units_mod.pick_units(
        units,
        max_pages=max_pages,
        pages_total=pages_total,
        excluded_ranges=excluded,
    )
    if bool(opt(payload, "stream_units", False)):
        for pu in picked:
            emit.unit(pu.to_dict())
    return {
        "picked": [
            {**pu.to_dict(), "text": pu.text[: int(opt(payload, "text_limit", 200) or 200)]}
            for pu in picked
        ],
        "stats": stats.to_dict(),
    }


def job_extract(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """units → 卡片 + 图谱（LLM 配置从 ``payload.llm`` 来，worker 不读环境变量）。"""
    from worker.pipeline.extract_core import extract_units
    from worker.pipeline.llm import LLMClient, LLMConfig

    doc_id = _doc_id(payload)
    raw_units = need(payload, "units", list)
    units = units_from_payload(raw_units, doc_id)
    units, skipped_titles, skipped_units = _filter_units_by_title(units, opt(payload, "skip_titles"))
    if skipped_titles:
        emit.warn(f"skip_titles 命中 {len(skipped_titles)} 个标题（含子树共 {skipped_units} 个单元，均为调用方显式指定）")
    cfg = LLMConfig.from_dict(payload.get("llm"))
    if not cfg.configured:
        from worker.cli import _Fail

        raise _Fail(E_LLM, "缺少 llm 配置", cfg.reason)

    emit.info(
        "抽取开始：模型 %s（并发 %d，凭据来自 job 参数）" % (cfg.model, cfg.concurrency)
    )
    llm = LLMClient(config=cfg)
    checkpoint_file = opt(payload, "checkpoint_file")
    outcome = extract_units(
            text_origin_pages=_text_origin_pages(payload),
            text_origin=str(payload.get('text_origin') or ''),
        doc_id=doc_id,
        units=units,
        llm=llm,
        source_name=str(opt(payload, "source_name", "课程资料")),
        max_pages=int(opt(payload, "max_pages", 8) or 8),
        pages_total=int(opt(payload, "pages_total", 0) or 0),
        excluded_ranges=opt(payload, "excluded_ranges") or [],
        checkpoint_file=Path(str(checkpoint_file)) if checkpoint_file else None,
        resume=bool(opt(payload, "resume", True)),
        max_units=(int(payload["max_units"]) if payload.get("max_units") is not None else None),
        chunk_chars=int(opt(payload, "chunk_chars", 24_000) or 24_000),
        emit=emit,
    )
    data = outcome.to_dict()
    emit.progress("extract", 1.0, {"cards": len(outcome.cards), "units_done": outcome.stats.get("units_done")})
    return data


def _text_origin_pages(payload: dict[str, Any]) -> dict[str, str]:
    """取逐页来源表（``documents.meta.text_origin_pages``，Node 原样转发）。

    ⚠️ 只做**形状**校验（dict[str,str]），值只认 ``native``/``ocr``（其它值忽略）——
    worker 不猜来源，拿不到就当"未知"（不写进结果，也不编造）。
    """
    raw = payload.get("text_origin_pages")
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in raw.items():
        key = str(k).strip()
        val = str(v or "").strip().lower()
        if key and val in ("native", "ocr"):
            out[key] = val
    return out


def _filter_units_by_title(
    units: list[Any], patterns: Sequence[Any] | None
) -> tuple[list[Any], list[str], int]:
    """按标题正则**显式**过滤单元（默认不启用 —— 不做隐式魔法）。

    ⚠️ 两个设计点（都是实测踩出来的）：

    1. **匹配的是"整棵子树"**：只丢父节点会**把子节点变成孤儿**，
       它们在 picker 里会被当成新的根、还各自生出一段"引言"，
       结果"跳过一个章"变成"多出三个零碎单元"（第一版就是这样）。
    2. **不做隐式跳过**：`parse` 只排除公认非内容章（索引/术语表，且如实记进 meta）。
       标题页/前言/版权页**属于内容**，跳过与否由调用方显式决定，并把跳过的标题原样回报。

    :return: ``(保留的单元, 命中的标题, 被丢弃的单元总数)``
    """
    if not patterns:
        return units, [], 0
    import re as _re

    compiled = []
    for p in patterns:
        try:
            compiled.append(_re.compile(str(p), _re.I))
        except _re.error:
            raise PayloadError(f"skip_titles 里的正则不合法：{p!r}")

    matched: list[str] = []
    drop_ids: set[str] = set()
    for u in units:
        title = getattr(u, "title", "") or ""
        if any(c.search(title) for c in compiled):
            matched.append(title)
            drop_ids.add(getattr(u, "id", ""))

    if not drop_ids:
        return units, [], 0

    # 连带丢弃后代（BFS；units 已由 units_from_payload 建好 parent_id 关系）
    children: dict[str, list[Any]] = {}
    for u in units:
        pid = getattr(u, "parent_id", None)
        if pid:
            children.setdefault(pid, []).append(u)
    queue = list(drop_ids)
    while queue:
        cur = queue.pop()
        for k in children.get(cur, []):
            kid = getattr(k, "id", "")
            if kid and kid not in drop_ids:
                drop_ids.add(kid)
                queue.append(kid)

    kept = [u for u in units if getattr(u, "id", "") not in drop_ids]
    return kept, matched, len(drop_ids)


def job_extract_plan(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """只产出提示词 + schema（架构 v2：LLM 调用可以归 Node）。

    ``items`` 的顺序 = **文档顺序**（根节点按 ``ord`` 遍历 → 递归下降），
    所以前几个 item 通常是标题页/前言。要让技术章节先出现，用
    ``skip_titles``（正则数组，**连同子树**一起跳过）显式过滤，
    或由调用方按 ``items[].span``/``title`` 自行排序。
    """
    from worker.pipeline.extract_core import plan_prompts

    doc_id = _doc_id(payload)
    units = units_from_payload(need(payload, "units", list), doc_id)
    units, skipped_titles, skipped_units = _filter_units_by_title(
        units, opt(payload, "skip_titles")
    )
    out = plan_prompts(
            text_origin_pages=_text_origin_pages(payload),
            text_origin=str(payload.get('text_origin') or ''),
        units=units,
        source_name=str(opt(payload, "source_name", "课程资料")),
        max_pages=int(opt(payload, "max_pages", 8) or 8),
        pages_total=int(opt(payload, "pages_total", 0) or 0),
        excluded_ranges=opt(payload, "excluded_ranges") or [],
        chunk_chars=int(opt(payload, "chunk_chars", 24_000) or 24_000),
    )
    out["order"] = "document"
    out["skipped_titles"] = skipped_titles
    out["skipped_items"] = len(skipped_titles)
    out["skipped_units"] = skipped_units
    if skipped_titles:
        emit.warn(f"skip_titles 命中 {len(skipped_titles)} 个标题（含子树共 {skipped_units} 个单元）：" +
                  "；".join(t[:40] for t in skipped_titles[:5]))
    emit.progress("extract.plan", 1.0, {"items": len(out["items"]),
                                        "skipped": skipped_units})
    return out


def job_extract_convert(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """把 Node 侧拿到的模型输出校验 + 转成卡片/图谱。"""
    from worker.pipeline.extract_core import convert_payloads

    doc_id = _doc_id(payload)
    units = units_from_payload(need(payload, "units", list), doc_id)
    payloads = need(payload, "payloads", list)
    outcome = convert_payloads(
            text_origin_pages=_text_origin_pages(payload),
            text_origin=str(payload.get('text_origin') or ''),
        doc_id=doc_id,
        units=units,
        payloads=payloads,
        max_pages=int(opt(payload, "max_pages", 8) or 8),
        pages_total=int(opt(payload, "pages_total", 0) or 0),
        excluded_ranges=opt(payload, "excluded_ranges") or [],
    )
    emit.progress("extract.convert", 1.0, {"cards": len(outcome.cards)})
    data = outcome.to_dict()
    # ★ 让失败更响亮：有 payload 但**一条都没转成** → 这是失败（退出码 1），
    #   否则调用方"只看 cards"会把"全部丢弃"误判成"这篇文档没有知识点"。
    #   部分成功（有错但转了）仍算成功，但 data.ok=false + error_count 已明确标记。
    if payloads and outcome.stats.get("units_done", 0) == 0:
        raise _Fail(
            "E_PICK_KEY",
            f"{len(payloads)} 个 payload **一个都没匹配上**（cards={len(outcome.cards)}）",
            "; ".join(str(e.get("msg", "")) for e in outcome.errors[:3]),
        )
    return data


def job_rollup_plan(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """S2 自底向上汇总：只产出**提示词 + 裸 schema**（LLM 调用归 Node，同 extract.plan）。

    入参 ``nodes``：``[{id,title,level,self_intro?,children:[{title,intro,key_takeaways,n_cards}]}]``
    出参：``{order,schema,items:[{key,node_id,title,level,system,user,...}],nodes_total,internal_nodes}``
    —— ``schema`` 是**裸的**（不含 ``{name, schema}`` 包装）。
    """
    from worker.pipeline.rollup_core import plan_rollups

    nodes = need(payload, "nodes", list)
    nodes, skipped_titles, skipped_nodes = _filter_nodes_by_title(
        nodes, opt(payload, "skip_titles")
    )
    out = plan_rollups(nodes)
    out["skipped_titles"] = skipped_titles
    out["skipped_nodes"] = skipped_nodes
    if skipped_titles:
        emit.warn(f"skip_titles 命中 {len(skipped_titles)} 个标题（含子树共 {skipped_nodes} 个节点）")
    emit.progress("rollup.plan", 1.0, {"items": len(out["items"]), "skipped": skipped_nodes})
    return out


def job_rollup_convert(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """把 Node 侧拿到的汇总输出校验 + 转成 ``{node_id: {...}}``。"""
    from worker.pipeline.rollup_core import convert_rollups

    payloads = need(payload, "payloads", list)
    out = convert_rollups(payloads)
    emit.progress("rollup.convert", 1.0, {"converted": out["converted"],
                                          "errors": out["error_count"]})
    # ★ 与 extract.convert 同样的"失败要响"：有 payload 却一条都没转成 → 退出码 1
    if payloads and out["converted"] == 0:
        raise _Fail(
            "E_ROLLUP_KEY",
            f"{len(payloads)} 个 payload **一个都没转换成功**",
            "; ".join(str(e.get("msg", "")) for e in out["errors"][:3]),
        )
    return out


def _count_nodes(children: Sequence[Any]) -> int:
    total = 0
    for c in children:
        if isinstance(c, dict):
            total += 1 + _count_nodes(c.get("children") or [])
        else:
            total += 1
    return total


def _filter_nodes_by_title(
    nodes: list[Any], patterns: Sequence[Any] | None
) -> tuple[list[Any], list[str], int]:
    """按标题正则过滤**节点树**（匹配的节点**连同子树**一起跳过）。

    与 :func:`_filter_units_by_title` 同一套语义：只丢父节点会让子节点变成孤儿，
    所以这里按内联 ``children`` 递归整棵丢弃，并回报命中的标题与丢弃数量。
    """
    if not patterns:
        return nodes, [], 0
    import re as _re

    compiled = []
    for p in patterns:
        try:
            compiled.append(_re.compile(str(p), _re.I))
        except _re.error:
            raise PayloadError(f"skip_titles 里的正则不合法：{p!r}")

    matched: list[str] = []
    dropped = 0

    def walk(n: Any) -> Any | None:
        nonlocal dropped
        if not isinstance(n, dict):
            return n
        title = str(n.get("title") or "")
        if any(c.search(title) for c in compiled):
            matched.append(title)
            dropped += 1 + _count_nodes(n.get("children") or [])
            return None
        kids = n.get("children") or []
        return {**n, "children": [k for k in (walk(x) for x in kids) if k is not None]}

    kept = [k for k in (walk(n) for n in nodes) if k is not None]
    # 同一标题可能在多个位置出现（如父节点与内联子节点同名）→ 去重保序，别让报告噪声过大
    seen: set[str] = set()
    unique_titles = [t for t in matched if not (t in seen or seen.add(t))]
    return kept, unique_titles, dropped


# ═══════════════════════════════════════════════════════════════════════
# 学生 SQL 沙箱（docs/SETTINGS_AND_SANDBOX.md §3 + docs/LAB_DB_DEPLOY.md）
# ═══════════════════════════════════════════════════════════════════════
def _sandbox_engine(payload: dict[str, Any]) -> Any:
    """取引擎（默认 sqlite）；未注册/不可用 → 可读错误 + 文档章节。"""
    from worker.sandbox import engine as engine_mod

    engine_id = str(opt(payload, "engine", "sqlite") or "sqlite").lower()
    try:
        # ★ 带上 root：payload 指定的沙箱根必须生效（否则测试/多租户会串到默认目录）
        eng = engine_mod.get_engine(engine_id, opt(payload, "root"))
    except KeyError:
        raise _Fail("E_ENGINE_UNKNOWN", f"未知引擎 {engine_id!r}",
                    f"已注册：{', '.join(engine_mod.registry_ids())}")
    if not eng.info.available:
        raise _Fail("E_ENGINE_UNAVAILABLE",
                    f"引擎 {engine_id} 不可用：{eng.info.reason}",
                    "见 docs/LAB_DB_DEPLOY.md §4（部署）/ §5（如何发现引擎）")
    return eng


def _sandbox_ids(payload: dict[str, Any]) -> tuple[str, str]:
    """解析 (user_id, session_id)：优先显式字段，其次从 db_path 推断。"""
    user_id = str(opt(payload, "user_id", "") or "")
    session_id = str(opt(payload, "session_id", "") or "")
    if user_id and session_id:
        return user_id, session_id
    db_path = opt(payload, "db_path")
    if db_path:
        p = Path(str(db_path))
        user_id = user_id or p.parent.name
        session_id = session_id or p.stem
    if not user_id or not session_id:
        raise PayloadError("需要 user_id + session_id（或 db_path，从其路径推断）")
    return user_id, session_id


def job_sandbox_init(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """建/取学生沙箱会话（不存在则按数据集初始化）→ ``{db_path, schema, ...}``。"""
    eng = _sandbox_engine(payload)
    user_id, session_id = _sandbox_ids(payload)
    emit.progress("sandbox.init", 0.2, {"engine": eng.info.id, "session": session_id})
    out = eng.ensure_session(user_id, session_id, opt(payload, "dataset"))
    emit.progress("sandbox.init", 1.0, {"db_path": out.get("db_path")})
    out["engine"] = eng.info.id
    out["dialect"] = eng.info.dialect
    out["capabilities"] = dict(eng.info.capabilities)
    return out


def job_sandbox_reset(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """重置到初始 schema（学生把库搞坏了可恢复）。"""
    eng = _sandbox_engine(payload)
    user_id, session_id = _sandbox_ids(payload)
    emit.progress("sandbox.reset", 0.3, {"dataset": opt(payload, "dataset")})
    out = eng.reset_session(user_id, session_id, opt(payload, "dataset"))
    emit.progress("sandbox.reset", 1.0, {"db_path": out.get("db_path")})
    out["engine"] = eng.info.id
    out["dialect"] = eng.info.dialect
    return out


def job_sandbox_exec(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """执行一条 SQL（独立进程 + 硬超时）→ ``{columns, rows, rowCount, elapsedMs, error?}``。

    ``multi: true`` 允许"显式分隔 + 逐条校验"的批次（事务实验：
    ``BEGIN; UPDATE …; ROLLBACK;``）。

    ⚠️ **路径由服务端推导**：sqlite 引擎只用 ``user_id`` + ``session_id`` 定位库文件，
    **不信任** payload 里的 ``db_path``；如果传了且与实际位置不一致 → 直接拒（不静默分歧）。
    """
    from worker.sandbox.engine import ExecRequest
    from worker.sandbox.paths import SandboxPathError

    eng = _sandbox_engine(payload)
    user_id, session_id = _sandbox_ids(payload)
    # ★ 用能力判断而不是引擎 id：只有嵌入式引擎才有"文件系统 db_path"这回事
    if payload.get("db_path") and eng.info.capabilities.get("dbPath"):
        expected = eng.db_path_for(user_id, session_id)
        given = Path(str(payload["db_path"]))
        if os.path.abspath(str(given)) != os.path.abspath(str(expected)):
            raise SandboxPathError(
                f"db_path 与 (user_id, session_id) 推导出的沙箱库不一致："
                f"{given} ≠ {expected}（沙箱库只能落在 data/sandbox/<user>/<session>.sqlite3）"
            )
    sql = str(need(payload, "sql", str) or "")
    emit.progress("sandbox.exec", 0.1, {"engine": eng.info.id, "chars": len(sql)})
    req = ExecRequest(
        session_id=session_id, user_id=user_id, sql=sql,
        max_rows=int(opt(payload, "max_rows",
                         eng.info.capabilities.get("maxRowsDefault", 200)) or 200),
        timeout_ms=int(opt(payload, "timeout_ms", 5_000) or 5_000),
        allow_multi=bool(opt(payload, "multi", False)),
    )
    out = eng.exec(req)
    emit.progress("sandbox.exec", 1.0, {"rows": out.get("rowCount", 0),
                                        "ok": out.get("ok", not out.get("error"))})
    return out


def job_sandbox_datasets(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """可选数据集（课程预置）：``{datasets:[...], default}``。"""
    from worker.sandbox import datasets as ds_mod

    with_sql = bool(opt(payload, "with_sql", False))
    emit.progress("sandbox.datasets", 1.0, {})
    return {"datasets": ds_mod.list_datasets(with_sql=with_sql),
            "default": ds_mod.DEFAULT_DATASET}


def job_sandbox_schema(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """库结构自省（S4 答疑要用）→ ``{dialect, tables:[{name, columns:[...]}]}``。"""
    from worker.sandbox.schema import describe_text, introspect

    eng = _sandbox_engine(payload)
    user_id, session_id = _sandbox_ids(payload)
    if payload.get("db_path"):
        # ★ 自省也要过路径闸：否则学生能借 schema 读取**任意** sqlite 文件
        #   （包括主知识库 —— 只读也是信息泄露）
        db_path = eng.roots.validate(str(payload["db_path"]))
    else:
        db_path = eng.db_path_for(user_id, session_id)
    out = introspect(db_path, dialect=eng.info.dialect,
                     row_counts=bool(opt(payload, "row_counts", True)))
    out["engine"] = eng.info.id
    if opt(payload, "with_text"):
        out["text"] = describe_text(out)
    emit.progress("sandbox.schema", 1.0, {"tables": len(out["tables"])})
    return out


def job_sandbox_history(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """最近执行记录（S4 要看"他刚才试了几次、错在哪"）。**只读 + 隔离**。"""
    from worker.sandbox.history import recent_executions
    from worker.sandbox.paths import SandboxRoots

    user_id, session_id = _sandbox_ids(payload)
    roots = SandboxRoots.resolve(opt(payload, "root"))
    limit = int(opt(payload, "limit", 20) or 20)
    request_user_id = opt(payload, "request_user_id")
    if request_user_id is not None and str(request_user_id) != user_id:
        raise _Fail("E_LOG_ISOLATION",
                    f"拒绝跨用户读历史：{request_user_id!r} ≠ {user_id!r}",
                    "日志隔离是硬要求（LAB_DB_DEPLOY §8.5.2）")
    records = recent_executions(roots, user_id, session_id, limit=limit)
    emit.progress("sandbox.history", 1.0, {"records": len(records)})
    return {"records": records, "count": len(records)}


def job_sandbox_logs(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """数据库日志（L1 会话诊断）→ ``{source, entries:[LogEntry]}``。

    SQLite 只有 L1（无 L2/L3）→ **如实声明**；拉取**只读 + 隔离 + 脱敏**。
    """
    from worker.sandbox import logs as logs_mod
    from worker.sandbox.paths import SandboxRoots

    from worker.sandbox import engine as engine_mod

    engine_id = str(opt(payload, "engine", "sqlite") or "sqlite").lower()
    # 引擎的运行时类型（embedded/server）决定日志边界文案 —— 不按 id 猜
    try:
        eng_info = engine_mod.get_engine(engine_id).info
    except KeyError:
        eng_info = None
    roots = SandboxRoots.resolve(opt(payload, "root"))
    # ★ 必须把 root 传进去：否则读到的是仓库默认目录的历史（payload 的 root 被忽略）
    source = logs_mod.get_log_source(engine_id, roots)
    if source is None:
        raise _Fail("E_LOG_NO_SOURCE", f"引擎 {engine_id} 没有注册日志源",
                    "见 docs/LAB_DB_DEPLOY.md §8")
    user_id, session_id = _sandbox_ids(payload)
    req = {
        "session_id": session_id, "user_id": user_id,
        "since": opt(payload, "since"), "limit": opt(payload, "limit", 50),
        "layers": opt(payload, "layers"),
        "request_user_id": opt(payload, "request_user_id"),
    }
    try:
        entries = source.fetch(req)
    except PermissionError as exc:
        raise _Fail("E_LOG_ISOLATION", str(exc), "A 学生不能看 B 学生的 SQL 日志") from exc
    except ValueError as exc:
        raise PayloadError(str(exc)) from exc
    # 运行时/层数从**引擎与日志源自己**取（不按 id 猜）
    runtime = getattr(getattr(eng_info, "runtime", None), "value", None) or \
        str(getattr(eng_info, "runtime", "server"))
    status, fact = logs_mod.status_fact(entries, engine_id=engine_id,
                                        reason=source.info.reason,
                                        runtime=str(runtime),
                                        layers=tuple(source.info.layers or ()))
    out: dict[str, Any] = {
        "source": source.info.to_dict(),
        "entries": entries,
        "count": len(entries),
        # ★ 状态用**中文事实句**给：只给 ok/empty/unavailable 这种英文词，
        #   模型会把"可读但没记录"说成"读不到"（pi-bridge 真机抓到过这类事实错误）
        "status": status,
        "fact": fact,
        "auditLogged": True,      # 本次读取已写审计（§8.5.5），但不作为日志内容返回
    }
    if str(runtime) == "embedded":
        # 精确表述：不是"拿不到"，是**嵌入式引擎根本没有这两层**
        out["boundary"] = (f"该引擎**没有** L2/L3：{engine_id} 是嵌入式引擎，"
                           "既没有实例级统计视图、也没有日志文件（不是权限或网络问题）；"
                           "L1（引擎原文报错 + audit_log）已在上面的 entries 里")
    else:
        out["boundary"] = (f"读不到该引擎日志（原因：{source.info.reason or '日志源未接入'}）"
                           "——agent 必须如实说明，不许假装看过")
    if opt(payload, "with_text"):
        out["text"] = logs_mod.summarize_for_prompt(entries)
    emit.progress("sandbox.logs", 1.0, {"entries": len(entries), "status": status})
    return out


def job_sandbox_engines(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """逐引擎**真探测**上报（给 ``/capabilities``），外加日志源能力。"""
    from worker.sandbox import engine as engine_mod
    from worker.sandbox import logs as logs_mod
    from worker.sandbox.paths import SandboxRoots

    root = opt(payload, "root")
    engine_mod.clear_registry()
    engine_mod.register_default_engines(root)
    logs_mod.clear_log_sources()
    logs_mod.register_default_log_sources(SandboxRoots.resolve(root))
    engines = engine_mod.engines_report()
    emit.progress("sandbox.engines", 1.0, {"engines": len(engines)})
    return {
        "defaultEngine": "sqlite",
        "engines": engines,
        "logSources": logs_mod.log_sources_report(),
        "sandboxRoot": str(SandboxRoots.resolve(root).root),
    }


def job_xref(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """交叉引用（四路来源 + mention 假阳性过滤，坑 6/7）。"""
    from worker.pipeline import xref as xref_mod

    doc_id = _doc_id(payload)
    cards = [card_from_dict(c) for c in need(payload, "cards", list)]
    units = units_from_payload(opt(payload, "units", []) or [], doc_id)
    entities = [entity_from_dict(e, doc_id) for e in (opt(payload, "entities", []) or [])]
    edges = [edge_from_dict(e, doc_id) for e in (opt(payload, "edges", []) or [])]
    emit.progress("xref", 0.1, {"cards": len(cards), "units": len(units)})
    xrefs, stats = xref_mod.build_xrefs_from(cards, units, entities, edges)
    emit.progress("xref", 1.0, {"xrefs": len(xrefs)})
    return {"xrefs": [x.to_dict() for x in xrefs], "stats": stats.to_dict()}


def job_index(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """生成 bigram 检索行（坑 15：FTS5 默认 tokenizer 对中文 0 命中）。"""
    from worker.pipeline import search as search_mod

    doc_id = _doc_id(payload)
    cards = [card_from_dict(c) for c in (opt(payload, "cards", []) or [])]
    units = units_from_payload(opt(payload, "units", []) or [], doc_id)
    rows: list[dict[str, Any]] = []
    for c in cards:
        rows.append(search_mod.card_index_row(c))
    for u in units:
        rows.append(search_mod.unit_index_row(u))
    emit.progress("index", 1.0, {"rows": len(rows)})
    return {"rows": rows, "counts": {"cards": len(cards), "units": len(units), "rows": len(rows)}}


def job_search(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """查询词 → bigram 词项 + FTS5 MATCH 表达式（SQL 由 Node 执行）。"""
    from worker.pipeline import search as search_mod

    mode = str(opt(payload, "mode", "query"))
    if mode == "bigram":
        texts = [str(t) for t in need(payload, "texts", list)]
        return {"bigrams": [search_mod.to_bigram(t) for t in texts]}
    q = str(need(payload, "q", str))
    terms = search_mod.query_terms(q)
    out = {
        "q": q,
        "terms": terms,
        "match_expr": search_mod.match_expr(q, mode=str(opt(payload, "match_mode", "and"))),
        "note": "match_expr 直接用于 `search_fts MATCH ?`；中文必须 bigram 预处理",
    }
    if payload.get("q_terms_only"):
        out.pop("match_expr", None)
    return out


def job_asr(payload: dict[str, Any], emit: Emitter) -> dict[str, Any]:
    """本地 ASR（faster-whisper）：``op:"probe"`` 真加载模型 / ``op:"transcribe"`` 转写。

    调用方（T-BACKEND / Provider 层）的约定：

    ```json
    {"job":"asr","input":{"op":"probe","model":"tiny","compute_type":"int8","device":"cpu"}}
    {"job":"asr","input":{"op":"transcribe","audio_path":"...","model":"tiny",
                          "language":"zh","word_timestamps":true}}
    ```

    返回（camelCase，跨语言契约）：

    ```json
    {"ok":true,"model":"tiny","device":"cpu"}                       // probe 成功
    {"ok":false,"reason":"模型未下载…"}                              // probe 失败（★ 绝不假装 ok）
    {"segments":[{"i":0,"startMs":0,"endMs":1200,"text":"…"}],
     "language":"zh","model":"faster-whisper/tiny","durationMs":300002}
    ```

    ⚠️ **诚实降级**（铁律）：``probe`` 会**真的加载一次模型**并丢掉结果；
    失败一律 ``ok:false`` + 可读 ``reason``，绝不返回 ``ok:true``。
    """
    from worker.video import asr as asr_mod

    inner = payload.get("input") if isinstance(payload.get("input"), dict) else payload
    op = str(inner.get("op") or "transcribe").strip().lower()
    model = str(inner.get("model") or "tiny")
    device = str(inner.get("device") or "cpu")
    compute_type = inner.get("compute_type")
    download_root = inner.get("download_root")
    emit.progress("asr", 0.02, {"op": op, "model": model, "device": device})

    if op in ("probe", "health", "healthcheck"):
        try:
            loaded = asr_mod.load_model_with_fallback(
                model, device=device, compute_type=compute_type, download_root=download_root
            )
            # load_model_with_fallback 返回 (model_obj, 实际型号, compute_type)
            actual = loaded[1] if isinstance(loaded, tuple) and len(loaded) > 1 else model
            ct = loaded[2] if isinstance(loaded, tuple) and len(loaded) > 2 else compute_type
            out: dict[str, Any] = {
                "ok": True,
                "model": actual,
                "device": device,
                "compute_type": ct or "",
                "requested_model": model,
            }
            if str(actual) != str(model):
                # 降级到链上其它模型：**如实标注**（否则调用方以为请求的模型可用）
                out["degraded"] = True
                out["reason"] = f"请求的模型 {model} 不可用，已降级到 {actual}"
                emit.warn(out["reason"])
            else:
                out["degraded"] = False
            emit.info(f"ASR probe 成功：{actual}（device={device}）")
            return out
        except Exception as exc:  # noqa: BLE001 - probe 永不抛，只如实报
            reason = getattr(exc, "detail", "") or getattr(exc, "msg", "") or str(exc)
            emit.warn(f"ASR probe 失败：{reason[:200]}")
            return {"ok": False, "reason": reason or type(exc).__name__,
                    "model": model, "device": device,
                    "code": getattr(exc, "code", "E_ASR_LOAD")}

    if op != "transcribe":
        raise PayloadError(f"op 只支持 probe/transcribe，收到 {op!r}")

    audio_path = str(need(inner, "audio_path", str))
    if not Path(audio_path).exists():
        raise _Fail("E_ASR_NO_AUDIO", f"音频文件不存在：{audio_path}")

    def on_progress(frac: float, stage: str) -> None:
        emit.progress("asr", 0.05 + 0.9 * max(0.0, min(1.0, frac)), {"stage": stage})

    try:
        res = asr_mod.transcribe_audio(
            audio_path,
            model=model,
            lang=(str(inner["language"]) if inner.get("language") else None),
            duration_ms=(int(inner["duration_ms"]) if inner.get("duration_ms") else None),
            work_dir=(str(inner["work_dir"]) if inner.get("work_dir") else None),
            model_chain=tuple(inner.get("model_chain") or asr_mod.DEFAULT_MODEL_CHAIN),
            device=device,
            compute_type=compute_type,
            download_root=download_root,
            word_timestamps=bool(inner.get("word_timestamps", True)),
            resume=bool(inner.get("resume", True)),
            on_progress=on_progress,
        )
    except Exception as exc:  # noqa: BLE001 - 统一成 _Fail，带可读原因
        code = getattr(exc, "code", "E_ASR_LOAD")
        msg = getattr(exc, "msg", None) or str(exc)
        detail = getattr(exc, "detail", "") or ""
        # 进度事件：如实标注失败
        emit.progress("asr", 1.0, {"ok": False, "code": code})
        raise _Fail(str(code), str(msg), str(detail)[:2000]) from exc

    segments = [
        {
            "i": s.i,
            "startMs": int(s.start),
            "endMs": int(s.end),
            "text": s.text,
            "confidence": float(getattr(s, "confidence", 0.0) or 0.0),
        }
        for s in res.segments
    ]
    emit.progress("asr", 1.0, {"segments": len(segments), "lang": res.lang})
    return {
        "segments": segments,
        "language": res.lang,
        "model": f"faster-whisper/{res.model}",
        "durationMs": int(res.duration_ms),
        "device": res.device,
        # ⚠️ 时间/分块字段**统一 camelCase**（T2 反馈：同一 payload 混用 snake/camel 会踩坑）
        "chunksTotal": int(getattr(res, "chunks_total", 0) or 0),
        "chunksDone": int(getattr(res, "chunks_done", 0) or 0),
        "chunksResumed": int(getattr(res, "chunks_resumed", 0) or 0),
        "elapsedMs": int(getattr(res, "elapsed_ms", 0) or 0),
        # 字级时间戳（T2 反馈：之前没转发）
        "words": list(getattr(res, "words", []) or []),
        "langProbability": float(getattr(res, "lang_probability", 0.0) or 0.0),
    }


# ═══════════════════════════════════════════════════════════════════════
# 调度
# ═══════════════════════════════════════════════════════════════════════
@dataclass
class JobSpec:
    fn: Callable[[dict[str, Any], Emitter], dict[str, Any]]
    summary: str


JOBS: dict[str, JobSpec] = {
    "parse": JobSpec(job_parse, "文件 → 层次化 units（PDF/PPTX/DOCX/TXT）"),
    "units": JobSpec(job_units, "单元划分（递归下降 + 引言段，坑 5）"),
    "extract": JobSpec(job_extract, "units → 卡片 + 图谱（LLM 配置从参数传入）"),
    "extract.plan": JobSpec(job_extract_plan, "只产出提示词 + json_schema（Node 自己调 LLM）"),
    "extract.convert": JobSpec(job_extract_convert, "模型输出 → 校验/转成卡片 + 图谱"),
    "rollup.plan": JobSpec(job_rollup_plan, "S2 汇总：node 树 → 提示词 + 裸 schema"),
    "rollup.convert": JobSpec(job_rollup_convert, "S2 汇总：模型输出 → 校验/转成 node 富化"),
    # ── 学生 SQL 沙箱（默认引擎 sqlite；引擎可插拔，见 docs/LAB_DB_DEPLOY.md）──
    "sandbox.engines": JobSpec(job_sandbox_engines, "逐引擎真探测上报 + 日志源能力"),
    "sandbox.init": JobSpec(job_sandbox_init, "建/取学生沙箱会话（按数据集初始化）"),
    "sandbox.reset": JobSpec(job_sandbox_reset, "重置到初始 schema（学生搞坏了可恢复）"),
    "sandbox.exec": JobSpec(job_sandbox_exec, "执行 SQL（独立进程 + 硬超时；CRUD/事务可用）"),
    "sandbox.datasets": JobSpec(job_sandbox_datasets, "课程预置数据集（sc/employees/orders）"),
    "sandbox.schema": JobSpec(job_sandbox_schema, "库结构自省（给 AI 答疑看表/列）"),
    "sandbox.history": JobSpec(job_sandbox_history, "最近执行记录（只读 + 会话隔离）"),
    "sandbox.logs": JobSpec(job_sandbox_logs, "数据库日志 L1 会话诊断（只读+隔离+脱敏）"),
    "xref": JobSpec(job_xref, "交叉引用（mention 假阳性过滤，坑 6）"),
    "index": JobSpec(job_index, "bigram 检索行（坑 15）"),
    "search": JobSpec(job_search, "查询词 → bigram 词项 + FTS5 MATCH 表达式"),
    "asr": JobSpec(job_asr, "本地 ASR：op=probe 真探测 / op=transcribe 转写（camelCase 时间戳）"),
}


class _Fail(Exception):
    """job 失败（业务错误）→ 退出码 1 + error 事件。"""

    def __init__(self, code: str, msg: str, detail: str = ""):
        super().__init__(msg)
        self.code = code
        self.msg = msg
        self.detail = detail


def _video_job(payload: dict[str, Any], emit: Emitter) -> dict[str, Any] | int:
    """``video.*`` 整包转给 T2 的 ``worker.video.job.run_job``（feature-detect）。"""
    try:
        from worker.video.job import run_job  # type: ignore
    except ImportError as exc:
        raise _Fail(
            E_JOB_UNKNOWN,
            "video job 需要 worker/video/job.py（T2 交付）",
            f"{type(exc).__name__}: {exc}",
        ) from exc
    code = run_job(payload, emit)
    # T2 的约定：0 = 完成（可能带降级）；1 = 失败/取消
    return int(code or 0)


def run(payload: dict[str, Any], emit: Emitter) -> int:
    """执行一个 job，返回退出码。**所有**输出都经由 emit。"""
    job = str(payload.get("job") or "")
    if not job:
        raise PayloadError("缺少字段 'job'（或用 --job 指定）")

    if job.startswith("video."):
        out = _video_job(payload, emit)
        return int(out) if isinstance(out, int) else EXIT_OK

    if job == "ping":
        # 自检用：Node 可以拿它快速验证 worker 可执行 + 版本一致
        emit.result({"worker_version": WORKER_VERSION, "jobs": sorted(JOBS), "pong": True})
        return EXIT_OK

    spec = JOBS.get(job)
    if spec is None:
        raise _Fail(
            E_JOB_UNKNOWN,
            f"未知 job：{job}",
            "可用：" + ", ".join([*sorted(JOBS), "video.*", "ping"]),
        )
    data = spec.fn(payload, emit)
    emit.result(data)
    return EXIT_OK


# ═══════════════════════════════════════════════════════════════════════
# main
# ═══════════════════════════════════════════════════════════════════════
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="python -m worker.cli",
        description="课程知识平台 · Python worker（CLI + 严格 JSONL 协议）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            '  python -m worker.cli --job parse --in payload.json\n'
            '  echo {"job":"ping"} | python -m worker.cli\n'
            "  python -m worker.cli --list-jobs\n\n"
            "stdout 是严格 JSONL（纯 ASCII，一行一个 JSON）；日志走 stderr。\n"
            "退出码：0 成功 / 1 任务失败 / 2 参数错误 / 130 中断"
        ),
    )
    ap.add_argument("--job", default=None, help="job 名（也可写在入参 JSON 的 job 字段里）")
    ap.add_argument("--in", dest="in_path", default=None,
                    help="入参 JSON 文件（缺省或 '-' 读 stdin）")
    ap.add_argument("--out", dest="out_path", default=None,
                    help="额外把 result.data 写到该文件（调试用）")
    ap.add_argument("--list-jobs", action="store_true", help="列出所有 job（JSON）")
    ap.add_argument("--log-level", default=None,
                    help="stderr 日志级别（DEBUG/INFO/WARNING/ERROR，默认 WARNING）")
    # ⚠️ 不用 argparse 的 version action：它会把纯文本写到 stdout，破坏 JSONL 协议。
    #    Node 会调 `--version`，所以它也必须是一帧 JSON。
    ap.add_argument("--version", action="store_true", help="打印版本（JSONL 一帧）")
    return ap


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    # 日志一律走 stderr（stdout 只走协议）；stderr 显式 UTF-8（可读且不会因编码崩）
    stdio.configure_stdio_utf8()
    logging.basicConfig(
        level=getattr(logging, (args.log_level or "WARNING").upper(), logging.WARNING),
        stream=sys.stderr,
        format="%(levelname)s %(name)s: %(message)s",
    )
    #: 保存真实 stdout：任务执行期间 sys.stdout 会被重定向到 stderr
    real_stdout = sys.stdout
    emit = Emitter(real_stdout.buffer)

    if args.version:
        emit.result({"worker_version": WORKER_VERSION})
        return EXIT_OK

    if args.list_jobs:
        emit.result(
            {
                "worker_version": WORKER_VERSION,
                "jobs": [
                    {"job": k, "summary": v.summary} for k, v in sorted(JOBS.items())
                ]
                + [{"job": "video.*", "summary": "视频管线（T2 video-pipeline）"},
                   {"job": "ping", "summary": "自检：返回版本与 job 列表"}],
            }
        )
        return EXIT_OK

    try:
        payload = read_payload(args.in_path)
        if args.job:
            payload["job"] = args.job  # CLI 覆盖入参里的 job
        emit.info(f"worker {WORKER_VERSION} 启动：job={payload.get('job')}")
        # ★ stdout 只走协议：任务期间的 print() 一律进 stderr
        with contextlib.redirect_stdout(sys.stderr):
            code = run(payload, emit)
        if args.out_path and emit.last_result is not None:
            Path(args.out_path).write_text(
                json.dumps(emit.last_result, ensure_ascii=False, indent=1), encoding="utf-8"
            )
        return code
    except PayloadError as exc:
        emit.error(E_PAYLOAD if not isinstance(exc, _Fail) else exc.code, str(exc))
        return EXIT_USAGE
    except _Fail as exc:
        emit.error(exc.code, exc.msg, exc.detail)
        return EXIT_FAILED
    except KeyboardInterrupt:
        emit.error(E_INTERNAL, "被中断（SIGINT）")
        return EXIT_INTERRUPT
    except Exception as exc:  # noqa: BLE001 - 任何异常都要变成 error 事件
        code = str(getattr(exc, "code", E_INTERNAL))
        msg = getattr(exc, "msg", None) or str(exc) or type(exc).__name__
        detail = getattr(exc, "detail", "") or traceback.format_exc(limit=6)
        emit.error(code, str(msg), str(detail)[:2000])
        # 入参/路径类错误（如 E_SANDBOX_PATH）→ 退出码 2：调用方该改参数，重试没用
        if isinstance(exc, ValueError) and code.startswith(("E_SANDBOX", "E_PAYLOAD", "E_SQL")):
            return EXIT_USAGE
        return EXIT_FAILED


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
