"""DOCX 适配器（span = ``char``，切分依据 = 标题层级）。

⚠️ 顺序陷阱：``doc.paragraphs`` 只给段落，**表格不在其中**。
若先遍历段落再遍历表格，表格内容会全部错位到文末 —— 所以这里按 ``body`` 的
XML 子元素顺序遍历（``w:p`` / ``w:tbl`` 交替），保证正文顺序与 Word 里一致。
"""

from __future__ import annotations

import re
from pathlib import Path

from worker.adapters.base import (
    DocDraft,
    DocumentAdapter,
    ParseError,
    ProgressFn,
    UnitDraft,
    report,
)
from worker.adapters.base import Span
from worker.adapters.registry import register
from worker.adapters.text import (
    TEXT_WINDOW_CHARS,
    RawNode,
    build_parents,
    clean_text,
    fixed_windows,
    guess_lang,
    level_from_numbering,
    nodes_to_draft,
)

#: ``Heading 3`` / ``标题 3`` / ``heading3`` 都认
_HEADING_STYLE = re.compile(r"^(?:heading|标题|h)\s*([1-9])$", re.I)


@register
class DocxAdapter(DocumentAdapter):
    """Word 文档：按 ``Heading N`` 样式切层级，span 用字符偏移。"""

    kind = "docx"
    extensions = (".docx",)

    def can_handle(self, path: str) -> bool:
        return Path(path).suffix.lower() in self.extensions

    def parse(self, path: str, *, on_progress: ProgressFn | None = None) -> DocDraft:
        p = Path(path)
        if not p.exists():
            raise ParseError(f"文件不存在：{path}")
        try:
            import docx  # python-docx
            from docx.table import Table
            from docx.text.paragraph import Paragraph
        except ImportError as exc:  # pragma: no cover - 依赖已装
            raise ParseError(f"python-docx 不可用：{exc}") from exc

        report(on_progress, 0.05, "打开 Word 文档")
        document = docx.Document(str(p))
        try:
            body = document.element.body
        except AttributeError as exc:  # 损坏文件
            raise ParseError(f"无法读取文档结构：{exc}") from exc

        # ── 1. 按 XML 顺序抽出 (level, title, text) ──────────────────
        blocks: list[tuple[int, str, str]] = []  # (level, title, body_text)
        offset = 0
        spans_meta: list[tuple[int, int]] = []
        for child in body.iterchildren():
            tag = child.tag.split("}")[-1]
            if tag == "p":
                para = Paragraph(child, document)
                txt = clean_text(para.text)
                level = self._heading_level(para, txt)
                blocks.append((level or 0, txt if level else "", txt))
                spans_meta.append((offset, offset + len(txt)))
                offset += len(txt) + 1
            elif tag == "tbl":
                table = Table(child, document)
                rows: list[str] = []
                for row in table.rows:
                    cells = [clean_text(c.text).replace("\n", " ") for c in row.cells]
                    if any(cells):
                        rows.append(" | ".join(cells))
                txt = "\n".join(rows)
                if txt.strip():
                    blocks.append((0, "", txt))
                    spans_meta.append((offset, offset + len(txt)))
                    offset += len(txt) + 1

        if not blocks:
            raise ParseError("文档没有任何可读段落（可能是纯图片文档）")

        # ── 2. 切 heading 层级 ──────────────────────────────────────
        heads = [i for i, (lvl, _, _) in enumerate(blocks) if lvl > 0]
        nodes: list[RawNode] = []
        if heads:
            for k, hi in enumerate(heads):
                lvl, title, _ = blocks[hi]
                start = spans_meta[hi][0]
                end_i = heads[k + 1] - 1 if k + 1 < len(heads) else len(blocks) - 1
                end = spans_meta[end_i][1] if end_i >= hi else spans_meta[hi][1]
                body_text = "\n".join(
                    blocks[j][2] for j in range(hi + 1, end_i + 1) if blocks[j][2]
                )
                nodes.append(
                    RawNode(
                        i=k,
                        lvl=lvl,
                        title=title or f"节 {k + 1}",
                        start=start,
                        end=max(start, end),
                        text=body_text.strip(),
                    )
                )
            nodes = build_parents(nodes)
        else:
            # 无标题样式：降级为固定字符窗口（不把整篇当一个 unit）
            full = "\n".join(b[2] for b in blocks if b[2])
            for i, (s, e) in enumerate(
                fixed_windows(len(full), TEXT_WINDOW_CHARS, snap_newline=full)
            ):
                chunk = full[s : e + 1]
                first = next((ln.strip() for ln in chunk.split("\n") if ln.strip()), "")
                nodes.append(
                    RawNode(
                        i=i,
                        lvl=1,
                        title=first[:60] or f"第 {i + 1} 块",
                        start=s,
                        end=e,
                        text=clean_text(chunk),
                    )
                )

        report(on_progress, 0.8, f"建树（{len(nodes)} 个单元）")
        draft = nodes_to_draft(
            nodes,
            kind=self.kind,
            title=p.stem,
            span_kind="char",
            meta={
                "paragraphs": len(blocks),
                "chars": offset,
                "mode": "headings" if heads else "windows",
                "tables": sum(1 for b in blocks if b[0] == 0 and "\n" in b[2]),
            },
            lang=guess_lang("\n".join(b[2] for b in blocks)),
        )
        report(on_progress, 1.0, "完成")
        return draft

    @staticmethod
    def _heading_level(para, text: str) -> int | None:
        style = getattr(getattr(para, "style", None), "name", "") or ""
        m = _HEADING_STYLE.match(style.strip())
        if m:
            return int(m.group(1))
        # 样式被改乱时用编号兜底（'7.4.2 xxx'）
        if text and len(text) <= 90:
            return level_from_numbering(text)
        return None
