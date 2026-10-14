"""通用类型与工具（models 层，只依赖标准库）。

★ 契约：docs/API_PROTOCOL.md §1.1
  · 时间统一 **毫秒时间戳 int**（不用 ISO 字符串）
  · ID 统一 ``<前缀>_<12位随机>``，如 doc_a1b2c3d4e5f6
  · ``span.kind`` ∈ page | slide | time | char（§2.2）
"""

from __future__ import annotations

import re
import secrets
import time
from dataclasses import dataclass
from typing import Any, Iterable

# ── span.kind（契约 §2.2）────────────────────────────────────────────────
SPAN_KINDS: tuple[str, ...] = ("page", "slide", "time", "char")

#: span.kind → 该 span 指向什么（给前端做回溯源链接）
SPAN_KIND_MEANING: dict[str, str] = {
    "page": "页码（1-based，PDF/EPUB 可回溯）",
    "slide": "幻灯片号（1-based）",
    "time": "毫秒（视频/音频）",
    "char": "字符偏移（纯文本/网页）",
}


class ModelError(ValueError):
    """模型层校验失败。"""


class EnumViolation(ModelError):
    """值不在封闭枚举内（契约 C3：不许发明枚举）。"""


class SpanViolation(ModelError):
    """span 不合法（类型/范围）。"""


# ── 时间 ────────────────────────────────────────────────────────────────
def now_ms() -> int:
    """当前毫秒时间戳（契约 §1.1：不用 ISO 字符串）。"""
    return int(time.time() * 1000)


# ── ID ──────────────────────────────────────────────────────────────────
_ID_ALPHABET = "0123456789abcdef"
_ID_RE = re.compile(r"^[a-z]+_[0-9a-zA-Z_\-]+$")


def new_id(prefix: str) -> str:
    """生成 ``<前缀>_<12位随机>`` ID（契约 §1.1）。

    用 secrets 而非 random：ID 会出现在 URL 里，不希望可预测。
    """
    body = "".join(secrets.choice(_ID_ALPHABET) for _ in range(12))
    return f"{prefix}_{body}"


#: 各类资源的 ID 前缀（只用契约里出现过的前缀，不发明）
ID_PREFIXES: dict[str, str] = {
    "document": "doc",
    "unit": "unt",
    "card": "crd",
    "entity": "ent",
    "edge": "edg",
    "task": "tsk",
    "video": "vid",
    "chat": "pi",
}


def id_for(kind: str) -> str:
    """按资源类别生成 ID；未知类别直接报错（避免静默造前缀）。"""
    if kind not in ID_PREFIXES:
        raise ModelError(f"未知的 ID 类别 {kind!r}；允许：{sorted(ID_PREFIXES)}")
    return new_id(ID_PREFIXES[kind])


# ── 枚举校验 ────────────────────────────────────────────────────────────
def check_enum(value: Any, allowed: Iterable[str], field: str) -> str:
    """断言 ``value`` 在封闭枚举内，否则抛 :class:`EnumViolation`。

    契约 C3：边类型/卡片 kind 只能来自 schema/*.json，不许发明。
    """
    allowed_t = tuple(allowed)
    if not isinstance(value, str) or value not in allowed_t:
        raise EnumViolation(
            f"{field}={value!r} 不在封闭枚举内；允许值：{list(allowed_t)}"
        )
    return value


# ── span ────────────────────────────────────────────────────────────────
@dataclass
class Span:
    """可回溯原文的锚点（契约 §2.2 / §2.3 ``evidence_span``）。

    PDF→页码、PPTX→幻灯片号、视频→毫秒、文本→字符偏移。
    """

    kind: str
    start: int
    end: int

    def __post_init__(self) -> None:
        check_enum(self.kind, SPAN_KINDS, "span.kind")
        self.start = int(self.start)
        self.end = int(self.end)
        if self.start < 0:
            raise SpanViolation(f"span.start 不能为负：{self.start}")
        if self.end < self.start:
            # 单点锚点允许 start == end（如卡片只定位到 1 页）
            raise SpanViolation(f"span.end({self.end}) < span.start({self.start})")

    # -- 序列化 ---------------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "start": self.start, "end": self.end}

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> "Span":
        d = d or {}
        return cls(
            kind=d.get("kind") or "page",
            start=int(d.get("start") or 0),
            end=int(d.get("end") or d.get("start") or 0),
        )

    # -- 便捷 -----------------------------------------------------------
    @property
    def size(self) -> int:
        """跨度 + 1（页数/幻灯片数/毫秒数/字符数）。"""
        return self.end - self.start + 1

    def contains(self, other: "Span") -> bool:
        return (
            self.kind == other.kind
            and self.start <= other.start
            and other.end <= self.end
        )

    def __str__(self) -> str:  # pragma: no cover - 只为日志可读
        return f"{self.kind}[{self.start}..{self.end}]"


#: 常用单点 span
def point_span(kind: str, at: int) -> Span:
    return Span(kind=kind, start=int(at), end=int(at))


# ── 名称规范化 ──────────────────────────────────────────────────────────
_WS_RE = re.compile(r"\s+")


def name_key(name: str) -> str:
    """规范化名（契约 §3 ``name_key``：小写 + 去空格），用于交叉引用。

    ⚠️ 只做小写与空白折叠，**绝不剥离领域关键词**：
    上游 bug（`数据库课程智能体调研/AGENTS.md` §3.2①）—— 无条件剥掉
    index/table/engine 后缀使 "index" 变成空 key，消歧证据全毁。
    """
    if not name:
        return ""
    return _WS_RE.sub(" ", name.replace("\u00a0", " ")).strip().lower()


def as_int(value: Any, default: int = 0) -> int:
    """容错整数转换（DB 里 INTEGER 可能是 None）。"""
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def as_float(value: Any, default: float = 0.0) -> float:
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def clamp01(value: Any, default: float = 0.0) -> float:
    """confidence 归一化到 [0, 1]。"""
    v = as_float(value, default)
    return 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)
