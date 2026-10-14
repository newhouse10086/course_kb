# -*- coding: utf-8 -*-
"""沙箱路径闸 —— **每个学生独立库文件**，且**只能**落在沙箱根目录内。

规格：``docs/SETTINGS_AND_SANDBOX.md`` §3「每个学生独立库文件
（``data/sandbox/{userId}/{sessionId}.sqlite3``）—— 绝不共用一个库」。

为什么单独一个模块：「路径穿越」是这条链路里最容易**静默**失守的地方 ——
一旦 ``db_path`` 能指到 ``data/course-kb.sqlite3``（主知识库），
学生一句 ``DROP TABLE cards`` 就把课程库删了，而且**没有任何报错**。

三重防线（都要有，缺一不可）：
1. **结构**：``user_id`` / ``session_id`` 只允许 ``[A-Za-z0-9_-]{1,64}``（无 ``.``、``/``、``\\``）
2. **解析后校验**：``Path.resolve()`` 之后再判断是否在根目录**之内**（挡 ``..`` / symlink）
3. **后缀**：只允许 ``.sqlite3``
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

#: 沙箱根目录（相对仓库根）—— 规格里写死的位置
DEFAULT_ROOT = Path("data") / "sandbox"

#: 一份「绝对不能被学生打开」的清单（即使有人把 root 配错，也要拦住）
PROTECTED_NAMES = (
    "course-kb.sqlite3",
    "course_kb.sqlite3",
    "settings.json",
)

#: user_id / session_id 允许的字符：字母数字下划线连字符 + **中日韩汉字**
#: （学生 ID 可能是 `u_张三`；但绝不许出现路径分隔符、`.`、`..`）
_ID_RE = re.compile(r"^[\w\u4e00-\u9fff-]{1,64}$", re.UNICODE)

#: Windows 保留设备名（`CON`/`NUL`/`COM1`… 当目录名会出各种诡异行为）
_WINDOWS_RESERVED = frozenset(
    ["con", "prn", "aux", "nul"]
    + [f"com{i}" for i in range(1, 10)]
    + [f"lpt{i}" for i in range(1, 10)]
)
_SUFFIX = ".sqlite3"


class SandboxPathError(ValueError):
    """路径不合法（调用方应按 ``E_SANDBOX_PATH`` 处理，退出码 2）。"""

    code = "E_SANDBOX_PATH"


@dataclass(frozen=True)
class SandboxRoots:
    """沙箱根目录解析结果。"""

    root: Path

    @classmethod
    def resolve(cls, root: str | Path | None = None) -> "SandboxRoots":
        if root is None:
            base = Path(__file__).resolve().parents[2]  # course-kb/
            root_path = base / DEFAULT_ROOT
        else:
            root_path = Path(root)
            if not root_path.is_absolute():
                base = Path(__file__).resolve().parents[2]
                root_path = base / root_path
        return cls(root=Path(os.path.abspath(root_path)))

    def ensure(self) -> Path:
        self.root.mkdir(parents=True, exist_ok=True)
        return self.root

    def session_path(self, user_id: str, session_id: str) -> Path:
        """``data/sandbox/{user_id}/{session_id}.sqlite3``（结构校验 + 解析校验）。"""
        for label, value in (("user_id", user_id), ("session_id", session_id)):
            text = str(value or "")
            if not _ID_RE.match(text):
                raise SandboxPathError(
                    f"{label} 只允许字母/数字/下划线/连字符/汉字（1–64 字符），收到 {value!r}"
                    "（禁止 . / \\ 与空值，防目录穿越）"
                )
            if text.lower() in _WINDOWS_RESERVED or text != text.rstrip(". "):
                raise SandboxPathError(
                    f"{label}={value!r} 是保留名/以点或空格结尾，Windows 下会出问题"
                )
        return self.validate(self.root / str(user_id) / f"{session_id}{_SUFFIX}")

    def validate(self, db_path: str | Path) -> Path:
        """解析并确认 ``db_path`` 落在沙箱根目录内。

        ★ 必须在 ``resolve()`` **之后**比较 —— 否则 ``data/sandbox/../course-kb.sqlite3``
        这种"字面上看着在沙箱里"的路径会溜过去。
        """
        p = Path(db_path)
        if not p.is_absolute():
            p = self.root / p
        resolved = Path(os.path.abspath(p))
        root = self.root
        try:
            resolved.relative_to(root)
        except ValueError:
            raise SandboxPathError(
                f"db_path 必须位于沙箱根目录内：{resolved} 不在 {root} 之下"
                "（每个学生一个独立库；禁止指到主知识库）"
            ) from None
        if resolved.name in PROTECTED_NAMES:
            raise SandboxPathError(f"禁止打开受保护的库：{resolved.name}")
        if resolved.suffix.lower() != _SUFFIX:
            raise SandboxPathError(f"沙箱库后缀必须是 {_SUFFIX}，收到 {resolved.name!r}")
        return resolved

    def is_inside(self, db_path: str | Path) -> bool:
        try:
            self.validate(db_path)
            return True
        except SandboxPathError:
            return False


def default_root() -> Path:
    return SandboxRoots.resolve().root
