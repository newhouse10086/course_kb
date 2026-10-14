"""封闭枚举的唯一来源：``schema/*.json``（只读）。

契约 C3：**边类型 / 卡片 kind 必须来自 ``schema/*.json``，不许硬编码，更不许发明**。
所以本模块在导入时**真实读取** schema 文件，任何硬编码的枚举副本都视为 bug。

同时这里还负责把 schema 转成 **LLM 的 json_schema**（契约 C2：
必须 ``json_schema`` + ``strict: true`` + 每个 object ``additionalProperties: false``）。
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parents[2]


def _find_schema_dir(root: Path) -> Path:
    """定位封闭枚举目录。

    ★ Lead 集成修复（2026-10-14）：原为硬编码单路径
        `_SCHEMA_DIR = Path(__file__).resolve().parents[2] / "schema"`
    但契约（AGENTS.md §2 / ARCHITECTURE_V2 §2）把封闭枚举定在
    **`contracts/schema/`**，我据此移动了目录 → 硬编码路径直接断链（ImportError）。
    现改为**双路径探测**，顺序与 TS 侧 `schema-enums.ts::findSchemaDir` 保持一致：
        先 `<root>/contracts/schema`，再 `<root>/schema`（向后兼容）。
    """
    for candidate in (root / "contracts" / "schema", root / "schema"):
        if (candidate / "edge_types.json").exists():
            return candidate
    # 都不存在 → 返回契约位置，让后续 SchemaError 报出可读路径
    return root / "contracts" / "schema"


_SCHEMA_DIR = _find_schema_dir(_ROOT)
EDGE_TYPES_FILE = _SCHEMA_DIR / "edge_types.json"
KNOWLEDGE_CARD_FILE = _SCHEMA_DIR / "knowledge_card.json"


class SchemaError(RuntimeError):
    """schema 文件缺失或结构不符合预期。"""


@lru_cache(maxsize=8)
def _load(path_str: str) -> dict[str, Any]:
    path = Path(path_str)
    if not path.exists():
        raise SchemaError(
            f"缺少契约文件 {path}；schema/** 是数据契约（只读），不能凭空发明枚举"
        )
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def schema_dir() -> Path:
    return _SCHEMA_DIR


@lru_cache(maxsize=1)
def edge_schema() -> dict[str, Any]:
    return _load(str(EDGE_TYPES_FILE))


@lru_cache(maxsize=1)
def card_schema() -> dict[str, Any]:
    return _load(str(KNOWLEDGE_CARD_FILE))


# ── 边类型（12 种，封闭）───────────────────────────────────────────────
@lru_cache(maxsize=1)
def edge_types() -> tuple[str, ...]:
    return tuple(edge_schema()["edge_types"].keys())


@lru_cache(maxsize=1)
def transitive_edge_types() -> tuple[str, ...]:
    return tuple(edge_schema().get("transitive", []))


@lru_cache(maxsize=1)
def edge_type_docs() -> dict[str, dict[str, Any]]:
    return dict(edge_schema()["edge_types"])


@lru_cache(maxsize=1)
def entity_types() -> tuple[str, ...]:
    return tuple(edge_schema()["entity_types"].keys())


@lru_cache(maxsize=1)
def layers() -> tuple[str, ...]:
    return tuple(edge_schema()["layers"].keys())


# ── 卡片 kind（封闭）与卡片字段枚举 ────────────────────────────────────
@lru_cache(maxsize=1)
def card_kinds() -> tuple[str, ...]:
    return tuple(card_schema()["card_fields"]["kind"]["values"])


@lru_cache(maxsize=1)
def card_field(name: str) -> dict[str, Any]:
    fields = card_schema()["card_fields"]
    if name not in fields:
        raise SchemaError(f"knowledge_card.json 无字段 {name!r}；现有：{sorted(fields)}")
    return fields[name]


@lru_cache(maxsize=1)
def usage_modes() -> tuple[str, ...]:
    return tuple(card_field("usage_mode")["values"])


@lru_cache(maxsize=1)
def operational_roles() -> tuple[str, ...]:
    return tuple(card_field("operational_role")["values"])


@lru_cache(maxsize=1)
def lifecycles() -> tuple[str, ...]:
    return tuple(card_field("lifecycle")["values"])


@lru_cache(maxsize=1)
def section_roles() -> tuple[str, ...]:
    return tuple(card_schema()["section_fields"]["section_role"]["values"])


# ── 校验 ────────────────────────────────────────────────────────────────
def is_edge_type(value: Any) -> bool:
    return isinstance(value, str) and value in edge_types()


def is_card_kind(value: Any) -> bool:
    return isinstance(value, str) and value in card_kinds()


def is_entity_type(value: Any) -> bool:
    return isinstance(value, str) and value in entity_types()


def enum_error_hint(field: str, value: Any) -> str:
    """给 LLM 重试提示与日志用的可读报错。"""
    table = {
        "etype": edge_types(),
        "kind": card_kinds(),
        "type": entity_types(),
        "layer": layers(),
        "usage_mode": usage_modes(),
        "operational_role": operational_roles(),
        "lifecycle": lifecycles(),
        "section_role": section_roles(),
    }
    allowed = table.get(field, ())
    return f"{field}={value!r} 非法；只允许 {list(allowed)}（schema/ 封闭枚举）"


def summary() -> dict[str, int]:
    """给 /capabilities 与日志用的规模摘要。"""
    return {
        "edge_types": len(edge_types()),
        "card_kinds": len(card_kinds()),
        "entity_types": len(entity_types()),
        "layers": len(layers()),
    }
