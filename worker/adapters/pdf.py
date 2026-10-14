"""PDF 适配器（span = ``page``，切分依据 = TOC 小节）。

三个必须遵守的坑（FUNCTIONAL_SPEC 坑 1/2/3）：

* **坑 1**：建树必须用「层级 + 顺序」**栈式算法**（抄 `build_tree.py::build_parents`）。
  ✗ 曾经的错误写法：用页码区间反推父子 → 层级跳跃、``6.5`` 下挂 ``6.4.3``。
* **坑 2**：页码区间**不嵌套不是 bug**（实测 3.4% 的父子对如此）——不修、不当断言。
* **坑 3**：书后索引/目录/术语表要排除（MySQL 手册 969 页属此类）——
  但**必须如实记进 meta**，不能静默丢页。

文本策略：每个 unit 只存**前 ``MAX_PAGES_PER_UNIT`` 页**的正文。
理由：递归下降的抽取单元（pipeline/units.py）只会选跨度 ≤ 8 页的节点，
所以被选的单元文本是**完整**的；上层大章只需引言段（F3 的输入），
这样既避免把 616 页塞进一条记录，也不丢内容（下钻会重新取到）。
"""

from __future__ import annotations

import os
import re
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
    RawNode,
)

#: 抽取单元页数上限（已验证常量，不要重新发明）
MAX_PAGES_PER_UNIT = 8

#: 非内容章标题（坑 3）。匹配前先去掉编号与空白。
#:
#: ⚠️ 只匹配**兜底附录类**的索引/术语表，**不能**匹配所有含 index 的标题：
#:    第一版写成 ``^.*\bindex(es)?$`` → 把 "17.5.3 Adaptive Hash Index"、
#:    "22.3.3.6 Create and Drop Indexes"、"10.3 Optimization and Indexes"
#:    这些**真正的正文小节**整片删掉了（实测误删 44 节点 / 37 页）。
#:    现在只认「Index / Indexes」或「Appendix X Indexes」这种独立成章的形态。
_SKIP_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^(table of contents|contents|目录|目次)$", re.I),
    re.compile(r"^(index|indexes|appendix\s+[a-z]\s+indexes?)$", re.I),
    re.compile(r"^.*\bglossary$", re.I),  # "MySQL Glossary"
    re.compile(r"^(bibliography|references|colophon|索引|术语表|参考文献)$", re.I),
)

#: 编号前缀：``7.4.2.6 Rule-Based…`` / ``Chapter 7 xxx`` / ``第 3 章 xxx``
_NUM_PREFIX = re.compile(
    r"^(?:\d+(?:\.\d+)*|\d+(?:\.\d+)*\.|[A-Z]\.|chapter\s+\d+|第\s*\d+\s*章)\s*[.:、]?\s+",
    re.I,
)


def normalize_title(title: str) -> str:
    """去掉编号前缀与空白，便于匹配（保留原样用于展示）。"""
    t = (title or "").replace("\xa0", " ").strip()
    for _ in range(3):  # "1.2.3 4.2 Title" 这种多重编号
        new = _NUM_PREFIX.sub("", t)
        if new == t:
            break
        t = new
    return re.sub(r"\s+", " ", t).strip()


def is_non_content(title: str) -> bool:
    t = normalize_title(title)
    return any(p.match(t) for p in _SKIP_PATTERNS)


def extra_skip_patterns() -> tuple[re.Pattern[str], ...]:
    """``COURSE_KB_PDF_SKIP`` 加分号分隔的额外正则（资料相关的索引章等）。"""
    raw = os.environ.get("COURSE_KB_PDF_SKIP", "").strip()
    if not raw:
        return ()
    out = []
    for part in raw.split(";"):
        part = part.strip()
        if part:
            try:
                out.append(re.compile(part, re.I))
            except re.error:
                continue
    return tuple(out)


@register
class PdfAdapter(DocumentAdapter):
    """PDF：TOC 小节 → 层次树；无 TOC 时降级为固定页窗。"""

    kind = "pdf"
    extensions = (".pdf",)

    def __init__(self, *, max_pages_per_unit: int = MAX_PAGES_PER_UNIT, max_pages: int = 0):
        self.max_pages_per_unit = max(1, int(max_pages_per_unit))
        #: >0 时只解析前 N 页（调试/测试用；0 = 全篇）
        self.max_pages = max(0, int(max_pages))

    def can_handle(self, path: str) -> bool:
        if Path(path).suffix.lower() in self.extensions:
            return True
        # 扩展名不可信时的魔数兜底（上传文件可能被改名）
        try:
            with open(path, "rb") as fh:
                return fh.read(5) == b"%PDF-"
        except OSError:
            return False

    # ── 解析 ────────────────────────────────────────────────────────
    def parse(self, path: str, *, on_progress: ProgressFn | None = None) -> DocDraft:
        p = Path(path)
        if not p.exists():
            raise ParseError(f"文件不存在：{path}")
        try:
            import fitz  # PyMuPDF
        except ImportError as exc:  # pragma: no cover
            raise ParseError(f"PyMuPDF 不可用：{exc}") from exc

        report(on_progress, 0.02, "打开 PDF")
        try:
            doc = fitz.open(str(p))
        except Exception as exc:
            raise ParseError(f"无法打开 PDF：{exc}") from exc

        try:
            total_pages = int(doc.page_count)
            limit = min(total_pages, self.max_pages) if self.max_pages else total_pages
            toc = doc.get_toc(simple=True) or []
            report(on_progress, 0.06, f"读目录（{len(toc)} 项 / {total_pages} 页）")

            cache: dict[int, str] = {}

            def page_text(pg: int) -> str:
                if pg not in cache:
                    try:
                        cache[pg] = doc[pg - 1].get_text("text") or ""
                    except Exception:  # noqa: BLE001 - 单页坏不该毁整篇
                        cache[pg] = ""
                return cache[pg]

            meta: dict = {
                "toc_entries": len(toc),
                "pages_total": total_pages,
                "pages_parsed": limit,
                "text_policy": f"每个 unit 仅存前 {self.max_pages_per_unit} 页正文",
            }

            if toc:
                nodes, skip_meta, excluded = self._toc_nodes(
                    toc, total_pages, limit, page_text, on_progress
                )
                meta.update(skip_meta)
                # 被排除的非内容章（索引/术语表）**不当作"未编入目录"**再补回来
                nodes = self._add_uncovered(nodes, total_pages, limit, page_text, excluded)
                meta["synthetic_units"] = sum(1 for n in nodes if getattr(n, "_synthetic", False))
                covered_pages = self._coverage(nodes)
                meta["coverage_pages"] = covered_pages
                meta["excluded_pages"] = len(excluded)
                meta["content_pages"] = limit - len(excluded)
                # ⚠️ 夹到 ≤1：节点的 end 语义是"到下一个同级条目的前一页"，
                #    与被排除区间的边界页可能重叠 1 页 → 曾算出 1.0013 这种 >1 的值
                meta["coverage_rate"] = min(
                    1.0, round(covered_pages / max(1, limit - len(excluded)), 4)
                )
                mode = "toc"
            else:
                nodes = self._window_nodes(limit, page_text, on_progress)
                meta["coverage_pages"] = self._coverage(nodes)
                meta["synthetic_units"] = 0
                mode = "fixed_windows"
                report(on_progress, 0.6, f"无 TOC，按 {self.max_pages_per_unit} 页窗口切分")

            units = [
                UnitDraft(
                    ord=int(getattr(n, "_ord")),
                    title=n.title,
                    level=max(1, n.lvl),
                    span=Span("page", n.start, n.end),
                    text=n.text,
                    parent_ord=(int(getattr(n, "_parent_ord")) if getattr(n, "_parent_ord", None) is not None else None),
                )
                for n in nodes
            ]
            sample = "\n".join(n.title for n in nodes[:200])
            draft = DocDraft(
                title=(doc.metadata or {}).get("title") or p.stem,
                kind=self.kind,
                units=units,
                meta={**meta, "mode": mode, "depth": max((n.lvl for n in nodes), default=0)},
                page_count=total_pages,
                lang=guess_lang(sample + " " + (page_text(1) if limit else "")),
            )
            meta_conflict = self._check_text_cap(draft)
            draft.meta["text_capped_units"] = meta_conflict
            report(on_progress, 0.98, f"完成（{len(units)} 个单元）")
            return draft
        finally:
            doc.close()

    # ── TOC → 树 ────────────────────────────────────────────────────
    def _toc_nodes(
        self,
        toc: list,
        total_pages: int,
        limit: int,
        page_text,
        on_progress: ProgressFn | None,
    ) -> tuple[list[RawNode], dict, set[int]]:
        raw: list[RawNode] = []
        for i, entry in enumerate(toc):
            try:
                lvl, title, pg = int(entry[0]), str(entry[1]), int(entry[2])
            except (IndexError, TypeError, ValueError):
                continue
            pg = max(1, min(pg, total_pages))
            if pg > limit:
                # 超出本次解析窗口（COURSE_KB_PDF_MAX_PAGES）的条目直接不参与，
                # 否则它们的 start 会落在窗口外，把覆盖率算成 > 解析页数
                continue
            raw.append(
                RawNode(
                    i=len(raw),
                    lvl=max(1, lvl),
                    # PyMuPDF 的 TOC 标题含 \xa0（不换行空格），统一成普通空格
                    title=title.replace("\xa0", " ").strip(),
                    start=pg,
                )
            )

        # 计算 end：下一个 lvl <= 自己的条目（且页码更靠后）就是边界，否则到末页
        # 用 next.start - 1（不含）而不是 next.start：否则相邻小节在边界页重叠，
        # 覆盖率与"被排除页"会同时把该页算两遍（实测 coverage 11 / excluded 2 重叠）。
        for k, n in enumerate(raw):
            n.end = limit
            for j in range(k + 1, len(raw)):
                if raw[j].lvl <= n.lvl and raw[j].start > n.start:
                    n.end = min(limit, raw[j].start - 1)
                    break
            n.end = max(n.start, n.end)

        raw = build_parents(raw)

        # 非内容章：自身或**祖先**命中 → 整棵子树排除（坑 3）
        extra = extra_skip_patterns()
        def skipped(title: str) -> bool:
            t = normalize_title(title)
            return is_non_content(title) or any(pat.match(t) for pat in extra)

        drop: set[int] = set()
        for n in raw:
            anc: list[int | None] = []
            cur: RawNode | None = n
            while cur is not None:
                anc.append(cur.i)
                cur = raw[cur.parent] if cur.parent is not None else None
            if any(skipped(raw[a].title) for a in anc):
                drop.add(n.i)

        kept = [n for n in raw if n.i not in drop]
        for n in kept:
            n.children = [c for c in (n.children or []) if c not in drop]
            if n.parent is not None and n.parent in drop:
                n.parent = None
        # 被排除的页数：只数「被丢弃子树的根」（父的 end 已覆盖子孙）
        skipped_roots = [i for i in drop if raw[i].parent is None or raw[i].parent not in drop]
        skipped_pages = sum(raw[i].end - raw[i].start + 1 for i in skipped_roots)
        excluded: set[int] = set()
        excluded_ranges: list[list[int]] = []
        for i in skipped_roots:
            s, e = raw[i].start, min(raw[i].end, limit)
            excluded.update(range(s, e + 1))
            excluded_ranges.append([s, e])

        # ord 重排（1..N），parent 下标 → 新下标
        index_map = {n.i: k for k, n in enumerate(kept)}
        for k, n in enumerate(kept):
            n._ord = k + 1  # type: ignore[attr-defined]
            n._parent_ord = (index_map[n.parent] + 1) if n.parent in index_map else None  # type: ignore[attr-defined]
            n.text = self._node_text(n, page_text)

        # ⚠️ 坑 2：**不做**「把子节点 end 夹到父 end 内」的"修复"。
        #    TOC 里 3.4% 的父子对页码不嵌套（end 对同级失效），这是原始数据特性。
        #    夹住会造成真实丢页（夹掉的页既不在子节点也不在父节点），
        #    而覆盖率的正确算法是取并集（_coverage），不是假设嵌套成立。

        report(on_progress, 0.45, f"建树：保留 {len(kept)} / {len(raw)} 个 TOC 节点")
        return kept, {
            "toc_nodes": len(raw),
            "kept_nodes": len(kept),
            "skipped_nodes": len(drop),
            "skipped_pages": skipped_pages,
            "skipped_roots": [raw[i].title for i in skipped_roots][:20],
            # 供抽取管线扣除（避免把"主动排除的索引章"算成"漏页"）
            "excluded_ranges": excluded_ranges,
        }, excluded

    def _node_text(self, n: RawNode, page_text) -> str:
        """节点正文 = 前 ``max_pages_per_unit`` 页（大章只取引言段）。"""
        last = min(n.end, n.start + self.max_pages_per_unit - 1)
        parts = [page_text(pg) for pg in range(n.start, last + 1)]
        return clean_text("\n".join(parts))

    def _window_nodes(self, limit: int, page_text, on_progress: ProgressFn | None) -> list[RawNode]:
        """无 TOC 的降级：固定页窗（每窗 ≤ ``max_pages_per_unit`` 页）。"""
        nodes: list[RawNode] = []
        step = self.max_pages_per_unit
        k = 0
        for start in range(1, limit + 1, step):
            end = min(limit, start + step - 1)
            txt = clean_text("\n".join(page_text(pg) for pg in range(start, end + 1)))
            first_line = next((ln.strip() for ln in txt.split("\n") if ln.strip()), "")
            nodes.append(
                RawNode(
                    i=k,
                    lvl=1,
                    title=first_line[:70] or f"p.{start}–{end}",
                    start=start,
                    end=end,
                    text=txt,
                )
            )
            nodes[k]._ord = k + 1  # type: ignore[attr-defined]
            nodes[k]._parent_ord = None  # type: ignore[attr-defined]
            k += 1
            if k % 20 == 0:
                report(on_progress, 0.1 + 0.5 * end / max(1, limit), f"切分 p.{start}")
        return nodes

    def _add_uncovered(
        self,
        nodes: list[RawNode],
        total_pages: int,
        limit: int,
        page_text,
        excluded: set[int] | None = None,
    ) -> list[RawNode]:
        """补上 TOC 未覆盖的页（防"整片丢页"，与坑 5 同源的洁癖）。

        TOC 之外的页通常是封面/版权/插图页；**不静默丢**，生成一个 L1 合成单元。
        ``excluded`` 里的页属于**主动排除的非内容章**（索引/术语表），不补回来。
        """
        excluded = excluded or set()
        covered = set(excluded)
        for n in nodes:
            covered.update(range(n.start, min(n.end, limit) + 1))
        out = list(nodes)
        k = len(out)
        pg = 1
        while pg <= limit:
            if pg in covered:
                pg += 1
                continue
            start = pg
            while pg <= limit and pg not in covered:
                pg += 1
            end = pg - 1
            txt = clean_text(
                "\n".join(
                    page_text(p) for p in range(start, min(end, start + self.max_pages_per_unit - 1) + 1)
                )
            )
            node = RawNode(i=k, lvl=1, title=f"未编入目录 p.{start}–{end}", start=start, end=end, text=txt)
            node._ord = k + 1  # type: ignore[attr-defined]
            node._parent_ord = None  # type: ignore[attr-defined]
            node._synthetic = True  # type: ignore[attr-defined]
            out.append(node)
            k += 1
        return out

    @staticmethod
    def _coverage(nodes: list[RawNode]) -> int:
        pages: set[int] = set()
        for n in nodes:
            pages.update(range(n.start, n.end + 1))
        return len(pages)

    def _check_text_cap(self, draft: DocDraft) -> int:
        """统计被截断正文的 unit 数（如实告知：上层章只存了引言段）。"""
        n = 0
        for u in draft.units:
            if u.span.end - u.span.start + 1 > self.max_pages_per_unit:
                n += 1
        return n

    def probe(self, path: str) -> dict:
        try:
            import fitz

            d = fitz.open(str(path))
            try:
                return {"pages": d.page_count, "toc_entries": len(d.get_toc(simple=True) or [])}
            finally:
                d.close()
        except Exception:  # noqa: BLE001
            return {}


class PdfTextProvider:
    """按页码回源取正文（给 pipeline.units 用）。

    为什么需要它：adapter 只把每个 unit 的**前 8 页**存进库（避免 616 页的章
    撑爆一条记录），而"引言段本身 > 8 页"时抽取管线仍需完整文本 —— 那就回源读。
    页文本带缓存，一次解析只读每页一次。
    """

    def __init__(self, path: str):
        import fitz

        self._doc = fitz.open(str(path))
        self._cache: dict[int, str] = {}

    def text(self, span) -> str:
        if getattr(span, "kind", "") != "page":
            return ""
        parts: list[str] = []
        for pg in range(int(span.start), int(span.end) + 1):
            if pg not in self._cache:
                try:
                    self._cache[pg] = self._doc[pg - 1].get_text("text") or ""
                except Exception:  # noqa: BLE001
                    self._cache[pg] = ""
            parts.append(self._cache[pg])
        return clean_text("\n".join(parts))

    def close(self) -> None:
        try:
            self._doc.close()
        except Exception:  # noqa: BLE001
            pass

    def __enter__(self) -> "PdfTextProvider":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def text_provider_for(path: str):
    """按扩展名给一个回源取文本的 provider（只有 PDF 需要）。"""
    if Path(path).suffix.lower() == ".pdf":
        try:
            return PdfTextProvider(path)
        except Exception:  # noqa: BLE001
            return None
    return None
