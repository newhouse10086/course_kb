"""适配器注册表（契约 §4）。

用法::

    from worker.adapters.registry import pick, available_kinds
    adapter = pick(path)           # 按扩展名/魔数选 adapter
    draft = adapter.parse(path)    # → DocDraft

新增格式：写一个 ``DocumentAdapter`` 子类并 ``@register`` 即可，
**不要改本文件之外的核心代码**（写域规则 §2）。
"""

from __future__ import annotations

import importlib
import logging
from pathlib import Path

from worker.adapters.base import DocumentAdapter, UnsupportedFormat

log = logging.getLogger(__name__)

#: 已注册的 adapter 类（顺序 = 匹配优先级）
ADAPTERS: list[type[DocumentAdapter]] = []

#: 内置 adapter 模块（按优先级）。video 属 T2 写域，缺失时**不报错**（如实降级）。
BUILTIN_MODULES: tuple[str, ...] = (
    "worker.adapters.pdf",
    "worker.adapters.slide",
    "worker.adapters.docx",
    "worker.adapters.text",
    "worker.adapters.video",  # 可选：T2 交付前不存在也允许
)

_loaded = False

#: 魔数 → kind（文件被改名/无扩展名时的兜底）
MAGIC_KINDS: tuple[tuple[bytes, str], ...] = (
    (b"%PDF-", "pdf"),
    (b"PK\x03\x04", "zip-office"),  # pptx/docx 都是 zip，需再判别
)

_OFFICE_KINDS: dict[str, str] = {
    "ppt/": "pptx",
    "word/": "docx",
}


def register(cls: type[DocumentAdapter]) -> type[DocumentAdapter]:
    """注册一个 adapter（可作装饰器）。

    重复注册同一类会被忽略（import 两次不产生重复项）。
    """
    if not isinstance(cls, type) or not issubclass(cls, DocumentAdapter):
        raise TypeError(f"register() 需要 DocumentAdapter 子类，收到 {cls!r}")
    if cls not in ADAPTERS:
        ADAPTERS.append(cls)
    return cls


def clear() -> None:
    """清空注册表（仅测试用）。"""
    ADAPTERS.clear()


def load_builtin_adapters(*, force: bool = False) -> list[str]:
    """导入内置 adapter 模块触发 ``@register``；返回实际加载成功的模块名。

    ⚠️ **不因某个 adapter 缺失而失败**：T2 的 video adapter 尚未交付时，
    其余格式必须照常可用（禁止假装可用，也禁止一起崩）。
    """
    global _loaded
    if _loaded and not force:
        return []
    loaded: list[str] = []
    for mod in BUILTIN_MODULES:
        try:
            importlib.import_module(mod)
        except ImportError as exc:  # 依赖缺失 / 模块还没交付
            log.warning("adapter 模块 %s 未加载：%s", mod, exc)
            continue
        loaded.append(mod)
    _loaded = True
    return loaded


def instances() -> list[DocumentAdapter]:
    load_builtin_adapters()
    return [cls() for cls in ADAPTERS]


def available_kinds() -> list[str]:
    """``/capabilities`` 的 ``adapters`` 字段（按注册顺序，去重）。"""
    out: list[str] = []
    for a in instances():
        if a.kind and a.kind not in out:
            out.append(a.kind)
    return out


def supported_extensions() -> tuple[str, ...]:
    exts: list[str] = []
    for a in instances():
        for e in a.extensions:
            e = e.lower()
            if e not in exts:
                exts.append(e)
    return tuple(exts)


def sniff_kind(path: str | Path) -> str | None:
    """按魔数判断类型（扩展名不可信时的兜底）。"""
    p = Path(path)
    try:
        with p.open("rb") as fh:
            head = fh.read(8192)
    except OSError:
        return None
    if head.startswith(b"%PDF-"):
        return "pdf"
    if head.startswith(b"PK\x03\x04"):
        # Office OOXML：zip 内含特定目录；退而看中央目录里的关键字
        blob = head
        try:
            with p.open("rb") as fh:
                fh.seek(max(0, p.stat().st_size - 65536))
                blob += fh.read()
        except OSError:
            pass
        for token, kind in _OFFICE_KINDS.items():
            if token.encode() in blob:
                return kind
        return None
    return None


def by_kind(kind: str) -> DocumentAdapter | None:
    load_builtin_adapters()
    for cls in ADAPTERS:
        if cls.kind == kind:
            return cls()
    return None


def pick(path: str) -> DocumentAdapter:
    """按扩展名/魔数挑一个 adapter；都不匹配 → :class:`UnsupportedFormat`。"""
    load_builtin_adapters()
    p = Path(path)
    tried: list[type] = []
    for cls in ADAPTERS:
        adapter = cls()
        tried.append(cls)
        try:
            if adapter.can_handle(str(path)):
                return adapter
        except Exception as exc:  # noqa: BLE001 - 单个 adapter 的 can_handle 不该拖垮选择
            log.warning("%s.can_handle(%s) 抛异常：%s", cls.__name__, path, exc)
    # 扩展名不信：再看魔数
    sniffed = sniff_kind(p) if p.exists() else None
    if sniffed:
        for cls in ADAPTERS:
            if cls.kind == sniffed:
                return cls()
    raise UnsupportedFormat(str(path), tried)


def has(path: str) -> bool:
    try:
        pick(path)
        return True
    except UnsupportedFormat:
        return False


def describe() -> list[dict]:
    """给 UI/调试用的注册表快照。"""
    return [
        {
            "kind": a.kind,
            "class": type(a).__name__,
            "extensions": list(a.extensions),
        }
        for a in instances()
    ]
