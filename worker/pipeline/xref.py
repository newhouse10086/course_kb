"""交叉引用（F4 / 契约 §2.5）—— **四路来源 + 假阳性过滤**。

四路（rel 顺序即优先级）：

| rel | 来源 |
|---|---|
| ``typed`` | 图谱类型化边（Edge）投影到卡片 |
| ``mention`` | 正文提及其他知识点（**必须过滤**，见下） |
| ``also_in`` | 同名卡片出现在多个 Unit |
| ``same_unit`` | 同 Unit 内的其它知识点 |

## ★ 坑 6：mention 假阳性（不过滤时 ``USE`` 被引 198 次、``AND`` 183 次）

过滤规则**逐字照抄契约 §2.5**（不是自己发明的启发式）：

```
规则：
  1. 名字含中文 或 含符号 ( ) [ ] . - _ @ # $ %  → 是标识符，允许
  2. 名字在 NOISE 集合 → 拒绝
  3. 名字长度 < 6 或含空格 → 必须以全大写代码形式出现 → 否则拒绝
  4. 其余 → 允许
```

## ★ 坑 7：自引用

``TIMESTAMPDIFF()`` 的正文提到 ``TIMESTAMPDIFF`` —— 比较前要去尾部 ``()``。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Iterable, Sequence

from worker.models import XREF_RELS, Xref, name_key  # noqa: F401  (XREF_RELS 供调用方复用)
# ⚠️ v2：worker 不依赖任何 store（SQLite 归 TS 层）。
# 这里只做**类型注解**引用，运行期不 import legacy store；
# legacy（FastAPI + SQLite）路径的函数体内会自行延迟导入。
if TYPE_CHECKING:  # pragma: no cover
    from worker._legacy.store.repo import Repo

#: 契约 §2.5 的 NOISE 集合（逐字；英文普通单词在这类文档里到处都是）
NOISE: frozenset[str] = frozenset(
    """use and or not in is as on to by if for all any set key
    desc path date char time text blob view index table value name type user
    host port file test data event""".split()
)

#: 规则 1：这些符号出现 → 是标识符/代码，允许
IDENT_SYMBOLS = "()[]-_@#$%"

_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def has_cjk(s: str) -> bool:
    return bool(_CJK_RE.search(s or ""))


def mention_ok(name: str, text: str) -> tuple[bool, str]:
    """该名字是否允许作为 mention 目标（返回 ``(允许?, 原因)``）。"""
    n = (name or "").strip()
    if not n:
        return False, "empty"
    # 规则 1
    if has_cjk(n) or any(ch in n for ch in IDENT_SYMBOLS):
        return True, "identifier"
    # 规则 2
    if n.lower() in NOISE:
        return False, "noise"
    # 规则 3
    if len(n) < 6 or " " in n:
        # 必须以全大写代码形式出现（大小写敏感）
        if re.search(rf"(?<![A-Za-z0-9_]){re.escape(n.upper())}(?![A-Za-z0-9_])", text or ""):
            return True, "uppercase_code"
        return False, "short_or_spaced_without_uppercase"
    # 规则 4
    return True, "ok"


def _strip_parens(s: str) -> str:
    """坑 7：``TIMESTAMPDIFF()`` == ``TIMESTAMPDIFF``。"""
    return (s or "").strip().rstrip("()").strip()


def is_self(src: str, dst: str) -> bool:
    return _strip_parens(src).lower() == _strip_parens(dst).lower()


@dataclass
class XrefStats:
    typed: int = 0
    mention: int = 0
    also_in: int = 0
    same_unit: int = 0
    mention_rejected: dict[str, int] = field(default_factory=dict)
    noise_hits: dict[str, int] = field(default_factory=dict)
    self_refs_skipped: int = 0
    candidates: int = 0

    @property
    def total(self) -> int:
        return self.typed + self.mention + self.also_in + self.same_unit

    def to_dict(self) -> dict:
        return {
            "total": self.total,
            "typed": self.typed,
            "mention": self.mention,
            "also_in": self.also_in,
            "same_unit": self.same_unit,
            "candidates": self.candidates,
            "mention_rejected": dict(self.mention_rejected),
            "noise_hits": dict(self.noise_hits),
            "self_refs_skipped": self.self_refs_skipped,
        }


#: 上限：避免同单元 13 张卡片产生 156 条噪音边
MAX_SAME_UNIT_LINKS = 4
MAX_ALSO_IN_CARDS = 8


def build_xrefs(repo: Repo, doc_id: str, *, max_units_mention: int = 5000) -> tuple[list[Xref], XrefStats]:
    """生成四类交叉引用（不写库；调用 :func:`apply_xrefs` 落库）。

    v1（FastAPI + SQLite）路径。**v2 worker 用 :func:`build_xrefs_from`**：
    数据由 Node 从 SQLite 取出来后以 JSON 传进来，worker 不碰存储。
    """
    return build_xrefs_from(
        repo.all_cards(doc_id),
        repo.all_units(doc_id),
        repo.list_entities(doc_id),
        repo.list_edges(doc_id),
    )


def build_xrefs_from(
    cards: Sequence[Any],
    units: Sequence[Any],
    entities: Sequence[Any] = (),
    edges: Sequence[Any] = (),
) -> tuple[list[Xref], XrefStats]:
    """四类交叉引用的**纯函数**实现（输入全是 model 对象，零存储依赖）。

    :param cards: :class:`worker.models.Card`
    :param units: :class:`worker.models.Unit`（用其 ``text`` 做 mention 扫描）
    :param entities: :class:`worker.models.Entity`（typed 边解析用）
    :param edges: :class:`worker.models.Edge`
    """
    stats = XrefStats()
    out: list[Xref] = []

    by_id = {c.id: c for c in cards}
    unit_text = {u.id: (u.text or "") for u in units}

    # ── ① typed：图谱边 → 卡片对 ────────────────────────────────────
    cards_by_key: dict[str, list[str]] = {}
    for c in cards:
        cards_by_key.setdefault(c.name_key, []).append(c.id)
    ent_key = {e.id: e.name_key for e in entities}
    for e in edges:
        src_key, dst_key = ent_key.get(e.src_id), ent_key.get(e.dst_id)
        if not src_key or not dst_key:
            continue
        for a in cards_by_key.get(src_key, [])[:1]:
            for b in cards_by_key.get(dst_key, [])[:1]:
                if a == b:
                    continue
                out.append(Xref(a, b, "typed", 1))
                stats.typed += 1

    # ── ② mention：正文提及（先过滤，再扫描）───────────────────────
    candidates: list[tuple[str, str, str]] = []  # (card_id, name, name_key)
    for c in cards:
        ok, _reason = mention_ok(c.name, "")
        # 规则 3 需要正文才能判定，故先收进来，扫描时再判
        if not ok and _reason in ("noise", "empty"):
            stats.mention_rejected[_reason] = stats.mention_rejected.get(_reason, 0) + 1
            if _reason == "noise":
                stats.noise_hits[c.name.lower()] = stats.noise_hits.get(c.name.lower(), 0) + 1
            continue
        candidates.append((c.id, c.name, c.name_key))
    stats.candidates = len(candidates)

    if candidates:
        # 一条正则扫全文（避免 n_cards × n_names 次 str.find）
        alt = "|".join(
            re.escape(n) for _, n, _ in sorted(candidates, key=lambda x: -len(x[1]))
        )
        pattern = re.compile(alt) if alt else None
        by_name_lower = {n.lower(): (cid, n, nk) for cid, n, nk in candidates}
        for unit in units:
            text = unit_text.get(unit.id, "")
            if not text or not pattern:
                continue
            hits: dict[str, int] = {}
            for m in pattern.finditer(text):
                hits[m.group(0)] = hits.get(m.group(0), 0) + 1
            if not hits:
                continue
            for hit, count in hits.items():
                tgt = by_name_lower.get(hit.lower())
                if not tgt:
                    continue
                tgt_id, tgt_name, _ = tgt
                for src_card in [c for c in cards if c.unit_id == unit.id]:
                    if is_self(src_card.name, tgt_name):
                        stats.self_refs_skipped += 1
                        continue
                    ok, reason = mention_ok(tgt_name, text)
                    if not ok:
                        stats.mention_rejected[reason] = (
                            stats.mention_rejected.get(reason, 0) + 1
                        )
                        continue
                    out.append(Xref(src_card.id, tgt_id, "mention", min(5, count)))
                    stats.mention += 1

    # ── ③ also_in：同名卡片跨单元复现 ──────────────────────────────
    for key, ids in cards_by_key.items():
        if len(ids) < 2:
            continue
        for a in ids[:MAX_ALSO_IN_CARDS]:
            for b in ids[:MAX_ALSO_IN_CARDS]:
                if a == b:
                    continue
                if by_id[a].unit_id == by_id[b].unit_id:
                    continue
                out.append(Xref(a, b, "also_in", 1))
                stats.also_in += 1

    # ── ④ same_unit：同单元知识点（有上限，避免噪音）───────────────
    by_unit: dict[str, list] = {}
    for c in cards:
        by_unit.setdefault(c.unit_id, []).append(c)
    for uid, group in by_unit.items():
        if len(group) < 2:
            continue
        ranked = sorted(group, key=lambda c: (-c.confidence, c.name))[:12]
        for c in ranked:
            others = [o for o in ranked if o.id != c.id][:MAX_SAME_UNIT_LINKS]
            for o in others:
                if is_self(c.name, o.name):
                    stats.self_refs_skipped += 1
                    continue
                out.append(Xref(c.id, o.id, "same_unit", 1))
                stats.same_unit += 1

    # 去重（DB 主键是 (from,to,rel)，同键只留最大 weight）
    merged: dict[tuple[str, str, str], Xref] = {}
    for x in out:
        k = (x.from_card_id, x.to_card_id, x.rel)
        if is_self(by_id.get(x.from_card_id).name if x.from_card_id in by_id else "", by_id.get(x.to_card_id).name if x.to_card_id in by_id else ""):
            stats.self_refs_skipped += 1
            continue
        if k in merged:
            merged[k].weight = max(merged[k].weight, x.weight)
        else:
            merged[k] = x
    return list(merged.values()), stats


def apply_xrefs(repo: Repo, doc_id: str) -> tuple[int, XrefStats]:
    """算完写库（原子替换，可重复执行）。"""
    xrefs, stats = build_xrefs(repo, doc_id)
    n = repo.replace_xrefs(doc_id, xrefs)
    return n, stats


def mention_ok_batch(names: Iterable[str], text: str) -> dict[str, bool]:
    """批量判定（调试/测试用）。"""
    return {n: mention_ok(n, text)[0] for n in names}
