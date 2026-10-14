"""S2 自底向上汇总（F3）—— 让**中间层**也有「这一节讲什么 + 为什么重要」。

为什么要自底向上（FUNCTIONAL_SPEC F3）：

> 中间层的"这章讲什么"**不该重读原文**（昂贵且易不一致），而由**已抽好的子节点摘要合并** ——
> 与人类写综述的方式一致，且**可追溯**。

顺序：按层级**从深到浅**（L6 → L1），每个内部节点一次调用，产出落盘供其父节点使用。
实测调用量参考：内部节点 368 个（不是全部 2459 个）。

⚠️ 无 LLM 凭据时**不得假装**：:func:`rollup_document` 直接抛 ``E_LLM``；
``/outline`` 会回落到确定性标题汇总（``intro_source="rollup_titles"``，见 outline.py）。
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from worker.config import Settings, get_settings
from worker.models import Unit
from worker.pipeline.extract import Checkpoint, checkpoint_path
from worker.pipeline.llm import LLMClient, LLMError
# ⚠️ v2：worker 不依赖任何 store（SQLite 归 TS 层）。
# 这里只做**类型注解**引用，运行期不 import legacy store；
# legacy（FastAPI + SQLite）路径的函数体内会自行延迟导入。
if TYPE_CHECKING:  # pragma: no cover
    from worker._legacy.store.repo import Repo

log = logging.getLogger(__name__)

# ⚠️ 汇总提示词 / schema 的**唯一实现**已移到 rollup_core.py（纯函数核心）。
#    这里 re-export 保持 v1 调用点不变，也保证提示词只有一份、不会漂移。
from worker.pipeline.rollup_core import (  # noqa: F401
    ROLLUP_SYSTEM,
    ROLLUP_USER,
    build_rollup_schema,
)

def _children_block(
    nodes: dict[str, Unit],
    children: dict[str | None, list[Unit]],
    summaries: dict[str, Any],
    rollup: dict[str, Any],
    unit: Unit,
) -> str:
    lines: list[str] = []
    for k in children.get(unit.id, []):
        s = summaries.get(k.id) or {}
        r = rollup.get(k.id) or {}
        intro = s.get("section_summary") or r.get("intro") or "（无摘要）"
        takeaways = (s.get("key_takeaways") or r.get("key_takeaways") or [])[:3]
        n_cards = int((s or {}).get("n_cards") or 0)
        lines.append(f"### {k.title}")
        lines.append(f"- 摘要：{intro}")
        if takeaways:
            lines.append("- 要点：" + "；".join(str(t) for t in takeaways))
        lines.append(f"- 知识点卡片：{n_cards} 张")
    return "\n".join(lines) if lines else "（无子节点）"


def rollup_document(
    repo: Repo,
    llm: LLMClient,
    doc_id: str,
    *,
    settings: Settings | None = None,
    on_progress: Callable[[float, str], None] | None = None,
    max_nodes: int | None = None,
    resume: bool = True,
) -> dict[str, Any]:
    """自底向上为内部节点生成 intro/why（断点续跑）。"""
    settings = settings or get_settings()
    doc = repo.get_document(doc_id)
    if doc is None:
        raise LLMError("E_NOTFOUND", f"文档不存在：{doc_id}")
    if not llm.configured:
        raise LLMError(
            "E_LLM",
            "未配置 LLM 凭据，无法生成全层级摘要",
            detail=settings.llm_reason,
        )

    units = repo.all_units(doc_id)
    nodes = {u.id: u for u in units}
    children: dict[str | None, list[Unit]] = {}
    for u in units:
        children.setdefault(u.parent_id, []).append(u)
    for lst in children.values():
        lst.sort(key=lambda u: u.ord)

    # 深度（自底向上：深度大的先算）
    depth: dict[str, int] = {}

    def d_of(u: Unit) -> int:
        if u.id in depth:
            return depth[u.id]
        depth[u.id] = 0 if u.parent_id is None else d_of(nodes[u.parent_id]) + 1
        return depth[u.id]

    for u in units:
        d_of(u)
    internal = [u for u in units if children.get(u.id)]
    internal.sort(key=lambda u: -depth[u.id])

    ckpt = Checkpoint(checkpoint_path(settings, doc_id).with_name(f"{doc_id}_rollup.json"),
                      doc_id, settings.llm_model)
    meta = dict(doc.meta or {})
    summaries: dict[str, Any] = dict(meta.get("section_summaries", {}) or {})
    rollup: dict[str, Any] = dict(meta.get("rollup", {}) or {})
    card_counts = repo.card_counts_by_unit(doc_id)
    for uid, cnt in card_counts.items():
        if uid in summaries:
            summaries[uid]["n_cards"] = cnt

    done = ckpt.done_keys if resume else set()
    todo = [u for u in internal if u.id not in done]
    if max_nodes is not None:
        todo = todo[: int(max_nodes)]

    started = time.time()
    made = 0
    for i, u in enumerate(todo, 1):
        if on_progress:
            on_progress(i / len(todo), f"汇总 L{depth[u.id]}：{u.title[:30]}")
        prompt = ROLLUP_USER.format(
            title=u.title,
            level=u.level,
            n_kids=len(children.get(u.id, [])),
            children_block=_children_block(nodes, children, summaries, rollup, u),
        )
        result = llm.complete_json(
            system=ROLLUP_SYSTEM,
            user=prompt,
            schema=build_rollup_schema(),
            name="section_rollup",
        )
        data = result.data or {}
        rollup[u.id] = {
            "intro": data.get("intro", ""),
            "why_important": data.get("why_important", ""),
            "key_takeaways": data.get("key_takeaways") or [],
            "objectives": data.get("objectives") or [],
            "depth": depth[u.id],
            "at": int(time.time() * 1000),
        }
        made += 1
        ckpt.mark(u.id, {"intro": rollup[u.id]["intro"][:200], "at": int(time.time() * 1000)})
        ckpt.save()
        # 每次都落库：中断后 /outline 立刻能用已完成的部分
        meta["rollup"] = rollup
        repo.update_document(doc_id, meta=meta)

    return {
        "doc_id": doc_id,
        "internal_nodes": len(internal),
        "generated": made,
        "skipped": len(internal) - len(todo),
        "elapsed_s": round(time.time() - started, 1),
        "llm_calls": made,
    }


def rollup_from_upstream(path: str | Path) -> dict[str, Any]:
    """读取上游手写节介绍（``manual_intros.json`` 结构）→ 可直接塞进 meta。

    结构：``{"intros": {"<node_i>": {"intro": "...", "why": "..."}}}``
    （上游按 TOC 节点号索引；导入时由 :mod:`server.store.import_upstream` 映射成 unit_id）
    """
    p = Path(path)
    if not p.exists():
        return {}
    raw = json.loads(p.read_text(encoding="utf-8"))
    return dict(raw.get("intros", raw) or {})
