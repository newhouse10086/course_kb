"""S2 自底向上汇总的**纯函数核心**（v2 worker）。

与 `rollup.py`（v1 的 repo 版）的关系，和 `extract_core.py` ↔ `extract.py` 一样：

| | v1 `rollup.py` | 本模块 |
|---|---|---|
| 依赖 | SQLite ``Repo``（取 unit 树） | **零存储**：节点树由调用方以 JSON 传入 |
| 凭据 | 读环境变量 | **调用方给提示词**，worker 只产出提示词/校验结果 |
| 调用者 | FastAPI 任务 | ``worker/cli.py`` 的 ``rollup.plan`` / ``rollup.convert`` |

为什么拆成 plan/convert（Lead 裁定）：架构 v2 要求「LLM 调用归 Node」，
但**提示词与封闭枚举必须只有一份实现** —— 于是 worker 出提示词 + 校验转换，
Node 用自家 provider 调模型。这样不会出现"Node 侧抄一份提示词慢慢漂移"。

硬要求：
* 汇总**只做归纳**，不引入子节点摘要之外的信息（提示词里已写明诚实约束）
* `node_id` 的 key 语法与抽取侧共用同一实现（``extract_core.make_node_key/parse_key``）
"""

from __future__ import annotations

import logging
from typing import Any, Sequence

from worker.pipeline.llm import validate_against_schema

log = logging.getLogger(__name__)

ROLLUP_SYSTEM = """你是数据库课程的知识架构师。现在要把**下级小节已写好的摘要**合并成上级小节（章/节）的介绍。

## 你的读者
正在浏览目录、想快速判断"这一章要不要现在读"的学生。

## 规则
1. **不要重读原文、不要引入子节点摘要之外的信息** —— 你只能做**归纳**，不能新增事实。
2. `intro`：2-3 句，说清**这一层涵盖哪些主题**，要点名关键子主题（不要写"本章介绍…"这种空话）。
3. `why_important`：1 句，说明它在整门课/整个系统里的位置（学生什么时候需要它）。
4. `key_takeaways`：2-4 条，来自子节点要点的**合并去重**高中层抽象。
5. `objectives`：2-4 条，动词开头（"能区分…"、"会配置…"）。
6. 若子节点摘要不足以判断，**如实写"（子节点摘要不足以归纳）"**，不要编造。

标识符（命令/函数/变量名）保留英文。"""

ROLLUP_USER = """## 本节
{title}（层级 L{level}）

## 它包含的 {n_kids} 个子节点摘要
{children_block}

## 输出
严格按 JSON schema 输出本节介绍。"""


def build_rollup_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "intro": {"type": "string"},
            "why_important": {"type": "string"},
            "key_takeaways": {"type": "array", "items": {"type": "string"}},
            "objectives": {"type": "array", "items": {"type": "string"}},
        },
    }




# ═══════════════════════════════════════════════════════════════════════
# 纯函数：产出提示词 / 校验转换
# ═══════════════════════════════════════════════════════════════════════
#: 富化节点允许的 section_role（来自 contracts/schema/knowledge_card.json）
def allowed_section_roles() -> tuple[str, ...]:
    from worker.models.schema_enums import section_roles

    return tuple(section_roles())


def build_rollup_output_schema(*, strict: bool = True) -> dict[str, Any]:
    """**给 LLM 用的**汇总输出 schema。

    = 上游验证过的基础 schema（``build_rollup_schema()``，逐字未改）
      + 一个**可选**的 ``section_role``（枚举来自 ``contracts/schema``）。

    为什么额外加它：Lead 要求 ``rollup.convert`` 产出
    ``{intro, why_important, objectives, key_takeaways, section_role}``。
    可选字段在 strict 模式下必须写成 ``["string","null"]`` 且列入 ``required``
    （结构化输出的硬要求）—— 用抽取侧同一个 ``strictify`` 实现，
    不在这里手写第二套规则。
    """
    plain = build_rollup_schema()
    enriched = {
        **plain,
        "properties": {
            **plain.get("properties", {}),
            "section_role": {"type": "string", "enum": list(allowed_section_roles())},
        },
    }
    if not strict:
        return enriched
    from worker.pipeline.llm import strictify

    return strictify(enriched, optional={"section_role"})


def _child_block(children: Sequence[dict[str, Any]]) -> str:
    """把子节点摘要拼成提示词里的"下级摘要"段。

    子节点可来自调用方的两种形状：**内联对象**（`{title,intro,...}`）
    或**id 字符串**（需配合 `nodes` 全量列表解析）—— 两种都认，别让调用方改结构。
    """
    if not children:
        return "（无子节点）"
    lines: list[str] = []
    for ch in children:
        if not isinstance(ch, dict):
            lines.append(f"### {ch}")
            continue
        intro = ch.get("intro") or ch.get("section_summary") or "（无摘要）"
        takeaways = ch.get("key_takeaways") or []
        n_cards = ch.get("n_cards")
        lines.append(f"### {ch.get('title') or ch.get('id') or '(未命名)'}")
        lines.append(f"- 摘要：{intro}")
        if takeaways:
            lines.append("- 要点：" + "；".join(str(t) for t in takeaways[:4]))
        if n_cards is not None:
            lines.append(f"- 知识点卡片：{n_cards} 张")
        if ch.get("intro_source"):
            lines.append(f"- 摘要来源：{ch['intro_source']}")
    return "\n".join(lines)


def build_rollup_user_prompt(node: dict[str, Any]) -> str:
    """按节点生成 user 提示词（title/level/子节点摘要）。"""
    return ROLLUP_USER.format(
        title=node.get("title") or node.get("id") or "",
        level=int(node.get("level") or 1),
        n_kids=len(node.get("children") or []),
        children_block=_child_block(node.get("children") or []),
    )


def plan_rollups(nodes: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """为每个**内部节点**产出 ``{key, node_id, system, user}`` + **裸 schema**。

    :param nodes: ``[{id, title, level, self_intro?, children:[{title,intro,
        key_takeaways,n_cards}|id]}]``（自底向上顺序由调用方决定：
        通常是"子节点已有摘要"的节点，即深度大 → 小）
    :return: ``{"schema": {...}, "items": [...]}`` —— **schema 是裸的**，
        不含 ``{name, schema}`` 包装（那是 response_format 组装方的事；
        Lead 明确提过包装层容易踩坑）。
    """
    from worker.pipeline.extract_core import make_node_key

    system = ROLLUP_SYSTEM
    schema = build_rollup_output_schema()
    items: list[dict[str, Any]] = []
    for n in nodes:
        node_id = str(n.get("id") or "")
        if not node_id:
            continue
        items.append(
            {
                "key": make_node_key(node_id),
                "node_id": node_id,
                "title": n.get("title") or "",
                "level": int(n.get("level") or 1),
                "n_children": len(n.get("children") or []),
                "has_self_intro": bool((n.get("self_intro") or "").strip()),
                "system": system,
                "user": build_rollup_user_prompt(n),
            }
        )
    return {
        "order": "caller",
        "schema": schema,
        "items": items,
        "nodes_total": len(nodes),
        "internal_nodes": len(items),
    }


def convert_rollups(payloads: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """模型输出 → ``{node_id: {intro, why_important, objectives, key_takeaways, section_role}}``。

    * 校验：``json_schema`` 语义（必填/类型/枚举），不合规**逐条报错**（不静默）
    * key：``<node_id>#node``（与抽取侧共用 :func:`extract_core.parse_key`）
    """
    from worker.pipeline.extract_core import parse_key

    schema = build_rollup_output_schema()
    rollups: dict[str, dict[str, Any]] = {}
    errors: list[dict[str, Any]] = []
    roles = allowed_section_roles()

    for item in payloads or []:
        key = str(item.get("key") or "")
        node_id = str(item.get("node_id") or "")
        parsed = parse_key(key)
        if parsed is not None and not node_id:
            node_id = parsed.unit_id
        if not node_id:
            errors.append({"code": "E_ROLLUP_KEY",
                           "msg": f"缺少 node_id（key={key!r} 无法解析）"})
            continue
        data = item.get("data") if isinstance(item.get("data"), dict) else item
        data = dict(data or {})
        # 去掉可能夹带的包装字段（模型/调用方多给字段时不该整体失败）
        for k in ("key", "node_id", "id", "title"):
            data.pop(k, None)
        # ★ 可空字段"没给"=合法：先补 None 再校验。
        #   strict 模式下 section_role 仍在 required 里，直接校验会被判"缺必填"→ 误杀整条
        data.setdefault("section_role", None)
        violations = validate_against_schema(data, schema)
        role = data.get("section_role")
        if role in (None, ""):
            data.pop("section_role", None)  # 可选字段：空值直接不写
        elif role not in roles:
            violations.append(f"$.section_role: {role!r} 不在枚举 {list(roles)} 内")
        if violations:
            errors.append({"code": "E_ROLLUP_SCHEMA", "node_id": node_id,
                           "msg": "; ".join(violations[:5])})
            continue
        rollups[node_id] = {
            "intro": str(data.get("intro") or ""),
            "why_important": str(data.get("why_important") or ""),
            "objectives": [str(x) for x in (data.get("objectives") or [])],
            "key_takeaways": [str(x) for x in (data.get("key_takeaways") or [])],
            **({"section_role": role} if role else {}),
        }

    return {
        "ok": not errors,
        "error_count": len(errors),
        "rollups": rollups,
        "converted": len(rollups),
        "errors": errors,
    }