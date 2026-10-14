# -*- coding: utf-8 -*-
"""交叉引用测试（纯函数）—— 坑 6（mention 假阳性）与坑 7（自引用）。"""

from __future__ import annotations

import pytest

from worker.models import Card, Edge, Entity, Span, Unit, Xref
from worker.pipeline import xref as xref_mod


def mk_card(cid: str, name: str, unit_id: str = "unt_1", kind: str = "concept",
            conf: float = 0.9) -> Card:
    return Card(id=cid, doc_id="doc_x", unit_id=unit_id, name=name, kind=kind,
                evidence_quote="", confidence=conf)


def mk_unit(uid: str, text: str, start: int = 1, end: int = 5) -> Unit:
    return Unit(id=uid, doc_id="doc_x", ord=1, title=f"unit {uid}", level=1,
                span=Span("page", start, end), text=text)


# ═══════════════════════════════════════════════════════════════════════
# 过滤规则（逐字对应契约 §2.5）
# ═══════════════════════════════════════════════════════════════════════
def test_mention_ok_follows_contract_rules() -> None:
    text = ("Use the SHOW statement to find out what databases exist. "
            "AND you can use USE to select one.")
    # 规则 1：含中文 / 含符号 → 标识符，允许
    assert xref_mod.mention_ok("sql_mode", text)[0] is True
    assert xref_mod.mention_ok("TIMESTAMPDIFF()", text)[0] is True
    assert xref_mod.mention_ok("索引优化", text)[0] is True
    assert xref_mod.mention_ok("utf8mb4_general_ci", text)[0] is True
    assert xref_mod.mention_ok("--log-error-verbosity", text)[0] is True
    # 规则 2：NOISE 集合 → 拒绝
    assert xref_mod.mention_ok("USE", text)[0] is False
    assert xref_mod.mention_ok("use", text)[1] == "noise"
    assert xref_mod.mention_ok("AND", text)[0] is False
    for w in ("index", "table", "view", "value", "key", "date"):
        assert xref_mod.mention_ok(w, text)[0] is False, w
    # 规则 3：长度 < 6 或含空格 → 必须以**全大写代码形式**出现
    assert xref_mod.mention_ok("pool", "the buffer pool is here")[0] is False
    assert xref_mod.mention_ok("pool", "the BUFFER POOL is here")[0] is True
    assert xref_mod.mention_ok("binary log", "binary log file")[0] is False
    assert xref_mod.mention_ok("binary log", "the BINARY LOG records changes")[0] is True
    assert xref_mod.mention_ok("InnoDB clustered index", text)[0] is False
    assert xref_mod.mention_ok(
        "InnoDB clustered index", "the INNODB CLUSTERED INDEX stores rows"
    )[0] is True
    # 规则 4：其余允许（长度 ≥ 6 且无空格）
    assert xref_mod.mention_ok("InnoDB", text)[0] is True
    assert xref_mod.mention_ok("mysqldump", text)[0] is True
    assert xref_mod.mention_ok("", text)[0] is False


def test_self_reference_ignores_trailing_parens() -> None:
    assert xref_mod.is_self("TIMESTAMPDIFF()", "TIMESTAMPDIFF") is True
    assert xref_mod.is_self("TIMESTAMPDIFF()", "timestampdiff") is True
    assert xref_mod.is_self("TIMESTAMPDIFF()", "TIMESTAMPADD") is False
    assert xref_mod.is_self("USE", "use") is True


def test_noise_set_is_the_contract_set() -> None:
    assert xref_mod.NOISE == frozenset(
        """use and or not in is as on to by if for all any set key
        desc path date char time text blob view index table value name type user
        host port file test data event""".split()
    )
    assert len(xref_mod.NOISE) == 36


# ═══════════════════════════════════════════════════════════════════════
# 四路来源
# ═══════════════════════════════════════════════════════════════════════
def test_build_xrefs_from_filters_noise_and_self() -> None:
    units = [
        mk_unit("unt_1", "Use USE and USE and AND. sql_mode is a variable. "
                         "TIMESTAMPDIFF() computes intervals. The buffer pool caches pages. "
                         "事务隔离级别与锁。"),
        mk_unit("unt_2", "事务隔离级别与锁。", start=6, end=10),
    ]
    cards = [
        mk_card("crd_use", "USE", "unt_1", "sql_statement", 0.5),
        mk_card("crd_and", "AND", "unt_1", "operator", 0.5),
        mk_card("crd_mode", "sql_mode", "unt_1", "system_variable"),
        mk_card("crd_ts", "TIMESTAMPDIFF()", "unt_1", "function"),
        mk_card("crd_pool", "buffer pool", "unt_1", "concept", 0.8),
        mk_card("crd_isol", "事务隔离级别", "unt_2", "concept"),
    ]
    xrefs, stats = xref_mod.build_xrefs_from(cards, units, [], [])

    targets = {x.to_card_id for x in xrefs if x.rel == "mention"}
    assert "crd_use" not in targets, "USE 是 NOISE（上游实测被误引 198 次）"
    assert "crd_and" not in targets, "AND 是 NOISE（上游实测 183 次）"
    assert "crd_pool" not in targets, "正文里是小写 buffer pool → 规则 3 拒绝"
    assert "crd_mode" in targets
    assert stats.noise_hits.get("use") == 1 and stats.noise_hits.get("and") == 1
    assert stats.self_refs_skipped >= 1
    assert stats.mention_rejected.get("short_or_spaced_without_uppercase", 0) >= 1
    # 自引用绝不出现（坑 7）
    assert all(x.from_card_id != x.to_card_id for x in xrefs)
    # 跨单元 mention：unt_1 的卡片提到 unt_2 的"事务隔离级别"
    assert any(x.from_card_id == "crd_mode" and x.to_card_id == "crd_isol" for x in xrefs)
    assert stats.mention >= 2


def test_typed_xrefs_from_graph_edges() -> None:
    units = [mk_unit("unt_1", "InnoDB implements B+tree.")]
    cards = [
        mk_card("crd_a", "InnoDB clustered index", "unt_1", "concept"),
        mk_card("crd_b", "B+tree", "unt_1", "mechanism"),
    ]
    entities = [
        Entity(id="ent_a", doc_id="doc_x", name="InnoDB clustered index", type="feature"),
        Entity(id="ent_b", doc_id="doc_x", name="B+tree", type="mechanism"),
    ]
    edges = [
        Edge(id="edg_1", doc_id="doc_x", src_id="ent_a", dst_id="ent_b", etype="IMPLEMENTS",
             evidence_text="InnoDB uses a B-tree data structure", confidence=0.95)
    ]
    xrefs, stats = xref_mod.build_xrefs_from(cards, units, entities, edges)
    typed = [x for x in xrefs if x.rel == "typed"]
    assert stats.typed == 1 and len(typed) == 1
    assert (typed[0].from_card_id, typed[0].to_card_id) == ("crd_a", "crd_b")
    # 悬空端点（实体没对应卡片）→ 不生成 typed，也不崩
    xrefs2, stats2 = xref_mod.build_xrefs_from(cards[:1], units, entities, edges)
    assert stats2.typed == 0 and not [x for x in xrefs2 if x.rel == "typed"]


def test_also_in_and_same_unit_caps() -> None:
    units = [mk_unit("unt_1", ""), mk_unit("unt_2", "", start=6, end=10)]
    cards = [
        mk_card("crd_r1", "隔离级别", "unt_1"),
        mk_card("crd_r2", "隔离级别", "unt_2"),
    ]
    cards += [mk_card(f"crd_u{i:02d}", f"知识点{i:02d}", "unt_1", conf=0.5 + i * 0.01)
              for i in range(14)]
    xrefs, stats = xref_mod.build_xrefs_from(cards, units, [], [])
    assert stats.also_in == 2                     # 同名跨单元双向
    assert stats.same_unit == 12 * 4              # 前 12 张 × 各 4 条上限
    assert all(x.from_card_id != x.to_card_id for x in xrefs)
    assert all(x.rel in xref_mod.XREF_RELS for x in xrefs)


def test_xref_rel_ordering_and_weights() -> None:
    units = [mk_unit("unt_1", "B mentions C.")]
    cards = [mk_card("crd_b", "B"), mk_card("crd_c", "C")]
    entities = [Entity(id="e1", doc_id="doc_x", name="B", type="concept"),
                Entity(id="e2", doc_id="doc_x", name="C", type="concept")]
    edges = [Edge(id="edg", doc_id="doc_x", src_id="e1", dst_id="e2", etype="PART_OF")]
    xrefs, _ = xref_mod.build_xrefs_from(cards, units, entities, edges)
    rels = {x.rel for x in xrefs}
    assert rels == {"typed", "mention", "same_unit"}
    # 同一对卡片可以有多种 rel（DB 主键是 from+to+rel）
    pair = [x for x in xrefs if x.from_card_id == "crd_b" and x.to_card_id == "crd_c"]
    assert sorted(x.rel for x in pair) == ["mention", "same_unit", "typed"]


def test_stats_to_dict_shape() -> None:
    stats = xref_mod.XrefStats(typed=1, mention=2)
    d = stats.to_dict()
    assert d["total"] == 3 and d["typed"] == 1 and d["mention"] == 2
    assert set(d) >= {"also_in", "same_unit", "noise_hits", "self_refs_skipped", "candidates"}


def test_xref_model_guards() -> None:
    with pytest.raises(Exception):
        Xref("", "crd_2")
    with pytest.raises(Exception):
        Xref("crd_1", "crd_2", "不存在的rel")
    assert Xref("crd_1", "crd_2", "mention", 0).weight == 1   # weight 至少 1
    assert Xref("crd_1", "crd_2", "typed", 9).to_dict() == {
        "from_card_id": "crd_1", "to_card_id": "crd_2", "rel": "typed", "weight": 9,
    }
