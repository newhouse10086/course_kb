# -*- coding: utf-8 -*-
"""worker.models —— 数据模型的再导出层。

⚠️ **本文件曾被误删**（Lead 清理临时脚本时用了 _*.py 通配，匹配到了 __init__.py），
   且因 .gitignore 里同样有 _*.py，它**从未被 git 跟踪** → 无法从历史恢复，只能按用法重建。
   教训：① .gitignore 不要用 _*.py（会匹配 __init__.py）；
        ② 包标记文件必须入库，否则 clone 后 worker 直接坏掉；
        ③ 清理临时文件要按**具体路径**删，不要按通配符删。
"""

from .common import (
    EnumViolation,
    ModelError,
    Span,
    id_for,
    name_key,
    now_ms,
)
from .unit import (
    Unit,
)
from .card import (
    Card,
)
from .document import (
    Document,
)
from .graph import (
    Edge,
    Entity,
    ExtractedGraph,
)
from .task import (
    Task,
)
from .video import (
    VideoArtifact,
    VideoSegment,
)
from .xref import (
    Xref,
    XREF_RELS,
)

__all__ = [
    'EnumViolation',
    'ModelError',
    'Span',
    'id_for',
    'name_key',
    'now_ms',
    'Unit',
    'Card',
    'Document',
    'Edge',
    'Entity',
    'ExtractedGraph',
    'Task',
    'VideoArtifact',
    'VideoSegment',
    'Xref',
    'XREF_RELS',
]
