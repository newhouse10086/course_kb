"""层次树（契约 §5.2 ``/outline``）—— **所有层级都有 intro / why**（F3）。

intro 的取用优先级（**如实标注来源**，不含幻觉）：

| 优先级 | 来源 | ``intro_source`` |
|---|---|---|
| 1 | ``documents.meta_json.manual_intros[unit_id]``（人工手写覆盖层，最高） | ``manual`` |
| 2 | S1 抽取时顺带产出的 ``section_summaries[unit_id].section_summary`` | ``section_summary`` |
| 3 | S2 自底向上汇总（LLM，见 ``pipeline/rollup.py``） | ``rollup_llm`` |
| 4 | 由**子节点标题**拼出的确定性概括（无 LLM 也有 intro） | ``rollup_titles`` |

⚠️ 第 4 档是**确定性文本**（"本节包含 A、B、C"），不是模型编的话 —— 这样在
无 LLM 时也能满足"可见节点 100% 有 intro"，且读者能看出这是目录级概括。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from worker.models import Unit
# ⚠️ v2：worker 不依赖任何 store（SQLite 归 TS 层）。
# 这里只做**类型注解**引用，运行期不 import legacy store；
# legacy（FastAPI + SQLite）路径的函数体内会自行延迟导入。
if TYPE_CHECKING:  # pragma: no cover
    from worker._legacy.store.repo import Repo


def _subtree_units(children: dict[str | None, list[Unit]], root: Unit) -> list[Unit]:
    out: list[Unit] = []
    stack = [root]
    guard = 0
    while stack and guard < 100_000:
        u = stack.pop()
        out.append(u)
        stack.extend(children.get(u.id, []))
        guard += 1
    return out


def build_outline(repo: Repo, doc_id: str) -> dict[str, Any]:
    """返回契约 §5.2 的 outline 结构。"""
    doc = repo.get_document(doc_id)
    if doc is None:
        raise KeyError(doc_id)
    units = repo.all_units(doc_id)
    children: dict[str | None, list[Unit]] = {}
    for u in units:
        children.setdefault(u.parent_id, []).append(u)
    for lst in children.values():
        lst.sort(key=lambda u: u.ord)
    card_counts = repo.card_counts_by_unit(doc_id)

    meta = doc.meta or {}
    manual_intros: dict[str, Any] = meta.get("manual_intros", {}) or {}
    sections: dict[str, Any] = meta.get("section_summaries", {}) or {}
    rollup: dict[str, Any] = meta.get("rollup", {}) or {}

    # 子树卡片数（一次遍历自底向上，避免每个节点都扫一遍）
    subtree_cards: dict[str, int] = {}
    subtree_units: dict[str, int] = {}

    def aggregate(u: Unit) -> tuple[int, int]:
        c = card_counts.get(u.id, 0)
        n = 1
        for k in children.get(u.id, []):
            kc, kn = aggregate(k)
            c += kc
            n += kn
        subtree_cards[u.id] = c
        subtree_units[u.id] = n
        return c, n

    for r in children.get(None, []):
        aggregate(r)

    nodes: dict[str, Any] = {}
    for u in units:
        kids = children.get(u.id, [])
        intro, why, source = _resolve_intro(
            u, kids, manual_intros, sections, rollup, subtree_cards
        )
        nodes[u.id] = {
            "id": u.id,
            "title": u.title,
            "level": u.level,
            "span": u.span.to_dict(),
            "children": [k.id for k in kids],
            "n_cards": subtree_cards.get(u.id, card_counts.get(u.id, 0)),
            "n_units": subtree_units.get(u.id, 1),
            "intro": intro,
            "why": why,
            "intro_source": source,
        }
    roots = [u.id for u in children.get(None, [])]
    return {
        "document_id": doc_id,
        "roots": roots,
        "nodes": nodes,
        "stats": {
            "units": len(units),
            "levels": sorted({u.level for u in units}),
            "with_intro": sum(1 for n in nodes.values() if n["intro"]),
            "intro_sources": _source_histogram(nodes),
        },
    }


def _resolve_intro(
    u: Unit,
    kids: list[Unit],
    manual_intros: dict[str, Any],
    sections: dict[str, Any],
    rollup: dict[str, Any],
    subtree_cards: dict[str, int],
) -> tuple[str, str, str]:
    m = manual_intros.get(u.id)
    if isinstance(m, dict) and (m.get("intro") or ""):
        return str(m.get("intro")), str(m.get("why") or ""), "manual"
    s = sections.get(u.id)
    if isinstance(s, dict) and s.get("section_summary"):
        why = ""
        # 用 section_role + key_takeaways 拼一句"为什么要看"，避免空 why
        takeaways = s.get("key_takeaways") or []
        if takeaways:
            why = str(takeaways[0])
        return str(s["section_summary"]), why, "section_summary"
    r = rollup.get(u.id)
    if isinstance(r, dict) and r.get("intro"):
        return str(r["intro"]), str(r.get("why_important") or ""), "rollup_llm"
    if kids:
        names = "、".join(k.title for k in kids[:6] if k.title)
        more = f" 等 {len(kids)} 个小节" if len(kids) > 6 else ""
        cards = subtree_cards.get(u.id, 0)
        intro = f"本节包含 {names}{more}。" if names else f"本节含 {len(kids)} 个子小节。"
        if cards:
            intro += f"（该节点及其子节点共 {cards} 个知识点）"
        return intro, "", "rollup_titles"
    # 叶子且无任何摘要：如实说明，而不是编
    if u.text.strip():
        first = u.text.strip().split("\n", 1)[0][:80]
        return f"（未生成摘要）正文开头：{first}", "", "none"
    return "（本节无正文，也未生成摘要）", "", "none"


def _source_histogram(nodes: dict[str, Any]) -> dict[str, int]:
    hist: dict[str, int] = {}
    for n in nodes.values():
        hist[n["intro_source"]] = hist.get(n["intro_source"], 0) + 1
    return hist


def outline_flat(nodes: dict[str, Any], roots: list[str]) -> list[dict[str, Any]]:
    """把树拍平成带 depth 的列表（调试/导出用）。"""
    out: list[dict[str, Any]] = []

    def walk(uid: str, depth: int) -> None:
        n = nodes[uid]
        out.append({**n, "depth": depth})
        for c in n["children"]:
            walk(c, depth + 1)

    for r in roots:
        walk(r, 0)
    return out
