"""PPTX 适配器（span = ``slide``，切分依据 = 每张幻灯片）。

要点：
* 标题取 ``slide.shapes.title``；**备注（notes）也要抽**（F1 明确要求）。
* 层级：幻灯片标题若带编号（``3.2 xxx``）→ 用编号推层级 + 栈式建树；
  否则拍平为 L1（PPT 本来没有更可靠的层级信息，**不硬猜**）。
* 表格与文本框一并抽出（学生在 PPT 里放的内容常在文本框里）。
"""

from __future__ import annotations

from pathlib import Path

from worker.adapters.base import (
    DocDraft,
    DocumentAdapter,
    ParseError,
    ProgressFn,
    Span,
    UnitDraft,
    report,
)
from worker.adapters.registry import register
from worker.adapters.text import (
    build_parents,
    clean_text,
    guess_lang,
    level_from_numbering,
    RawNode,
)

#: 单张幻灯片正文长度上限（防止某页塞进整篇论文）
MAX_SLIDE_CHARS = 20_000


@register
class SlideAdapter(DocumentAdapter):
    """PowerPoint：每张幻灯片一个 unit。"""

    kind = "pptx"
    extensions = (".pptx",)

    def can_handle(self, path: str) -> bool:
        return Path(path).suffix.lower() in self.extensions

    def parse(self, path: str, *, on_progress: ProgressFn | None = None) -> DocDraft:
        p = Path(path)
        if not p.exists():
            raise ParseError(f"文件不存在：{path}")
        try:
            from pptx import Presentation
        except ImportError as exc:  # pragma: no cover
            raise ParseError(f"python-pptx 不可用：{exc}") from exc

        report(on_progress, 0.05, "打开演示文稿")
        try:
            prs = Presentation(str(p))
        except Exception as exc:  # python-pptx 对损坏文件抛多种异常
            raise ParseError(f"无法打开 pptx：{exc}") from exc

        slides = list(prs.slides)
        if not slides:
            raise ParseError("演示文稿没有幻灯片")

        nodes: list[RawNode] = []
        for idx, slide in enumerate(slides, start=1):
            title, body = self._slide_text(slide)
            lvl = level_from_numbering(title) if title else None
            nodes.append(
                RawNode(
                    i=idx - 1,
                    lvl=lvl or 1,
                    title=title or f"幻灯片 {idx}",
                    start=idx,
                    end=idx,
                    text=body[:MAX_SLIDE_CHARS],
                )
            )
            if idx % 25 == 0 or idx == len(slides):
                report(on_progress, 0.05 + 0.75 * idx / len(slides), f"读取幻灯片 {idx}/{len(slides)}")

        # 只有出现层级信号时才建树；否则保持平铺（不许硬猜层级）
        # check_numbering=True：PPT 的编号常跨章（1.1 与 3.1 之间没有 3），
        # 不加校验会把 3.1 硬挂到上一个 L1 下面（层级对、语义错）。
        if any(n.lvl > 1 for n in nodes):
            nodes = build_parents(nodes, check_numbering=True)

        report(on_progress, 0.85, f"建树（{len(nodes)} 个单元）")
        units = [
            UnitDraft(
                ord=n.i + 1,
                title=n.title,
                level=max(1, n.lvl),
                span=Span("slide", n.start, n.end),
                text=n.text,
                parent_ord=(n.parent + 1) if n.parent is not None else None,
            )
            for n in nodes
        ]
        draft = DocDraft(
            title=p.stem,
            kind=self.kind,
            units=units,
            meta={
                "slides": len(slides),
                "chars": sum(u.text_len for u in units),
                "notes_included": True,
            },
            page_count=len(slides),
            lang=guess_lang("".join(u.text for u in units)),
        )
        draft.validate()
        report(on_progress, 1.0, "完成")
        return draft

    def probe(self, path: str) -> dict:
        try:
            from pptx import Presentation

            return {"slides": len(Presentation(str(path)).slides)}
        except Exception:  # noqa: BLE001 - 探测失败不报错
            return {}

    @staticmethod
    def _slide_text(slide) -> tuple[str, str]:
        """返回 (标题, 正文含备注)。"""
        title = ""
        try:
            if slide.shapes.title is not None:
                title = clean_text(slide.shapes.title.text)
        except (AttributeError, ValueError):
            title = ""

        parts: list[str] = []
        for shape in slide.shapes:
            # 标题已经单独抽了，正文里不重复
            if title and shape is getattr(slide.shapes, "title", None):
                continue
            if shape.has_text_frame:
                txt = clean_text(shape.text_frame.text)
                if txt:
                    parts.append(txt)
            if getattr(shape, "has_table", False):
                for row in shape.table.rows:
                    cells = [clean_text(c.text).replace("\n", " ") for c in row.cells]
                    if any(cells):
                        parts.append(" | ".join(cells))
        # 备注页
        try:
            if slide.has_notes_slide:
                notes = clean_text(slide.notes_slide.notes_text_frame.text)
                if notes:
                    parts.append(f"[备注] {notes}")
        except (AttributeError, ValueError):
            pass
        return title, "\n".join(parts)
