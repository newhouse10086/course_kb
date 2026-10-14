/**
 * 层次树（契约 §5.2 `/outline`）—— **所有层级都有 intro / why**。
 *
 * 逐字移植 `worker/pipeline/outline.py`（v1 已验证）。intro 取用优先级（**如实标注来源**）：
 *
 * | 优先级 | 来源 | `intro_source` |
 * |---|---|---|
 * | 1 | `documents.meta.manual_intros[unit_id]`（人工手写覆盖层） | `manual` |
 * | 2 | `documents.meta.section_summaries[unit_id].section_summary`（S1 产出） | `section_summary` |
 * | 3 | `documents.meta.rollup[unit_id].intro`（S2 自底向上 LLM 汇总） | `rollup_llm` |
 * | 4 | 由**子节点标题**拼出的确定性概括（无 LLM 也有 intro） | `rollup_titles` |
 * | 5 | 如实说明"未生成摘要"（**不编造**） | `none` |
 *
 * ⚠️ 第 4 档是**确定性文本**（"本节包含 A、B、C"），不是模型编的话 ——
 * 这样无 LLM 时也能满足"可见节点 100% 有 intro"，且读者能看出这是目录级概括。
 */

import type { Repo, UnitRow } from './repo.ts';
import type { SpanKind } from './types.ts';

export interface OutlineNode {
  id: string;
  title: string;
  level: number;
  span: { kind: SpanKind; start: number; end: number };
  children: string[];
  n_cards: number;
  n_units: number;
  intro: string;
  why: string;
  intro_source: string;
}

export interface OutlineResponse {
  document_id: string;
  roots: string[];
  nodes: Record<string, OutlineNode>;
  stats: {
    units: number;
    levels: number[];
    with_intro: number;
    intro_sources: Record<string, number>;
  };
}

type Meta = Record<string, unknown>;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function buildOutline(repo: Repo, docId: string): OutlineResponse {
  const doc = repo.getDocumentRow(docId);
  if (!doc) throw new Error(`document not found: ${docId}`);
  const units = repo.allUnitRows(docId);

  const children = new Map<string | null, UnitRow[]>();
  for (const u of units) {
    const key = u.parent_id ?? null;
    const list = children.get(key) ?? [];
    list.push(u);
    children.set(key, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.ord - b.ord || a.id.localeCompare(b.id));

  const cardCounts = repo.cardCountsByUnit(docId);

  let meta: Meta = {};
  try {
    meta = JSON.parse(doc.meta_json || '{}') as Meta;
  } catch {
    meta = {};
  }
  const manualIntros = asRecord(meta.manual_intros) ?? {};
  const sections = asRecord(meta.section_summaries) ?? {};
  const rollup = asRecord(meta.rollup) ?? {};

  // 子树卡片数/单元数：一次自底向上，避免每个节点都扫一遍（O(n²)）
  const subtreeCards = new Map<string, number>();
  const subtreeUnits = new Map<string, number>();
  const aggregate = (u: UnitRow): [number, number] => {
    let c = cardCounts.get(u.id) ?? 0;
    let n = 1;
    for (const k of children.get(u.id) ?? []) {
      const [kc, kn] = aggregate(k);
      c += kc;
      n += kn;
    }
    subtreeCards.set(u.id, c);
    subtreeUnits.set(u.id, n);
    return [c, n];
  };
  for (const r of children.get(null) ?? []) aggregate(r);

  const nodes: Record<string, OutlineNode> = {};
  for (const u of units) {
    const kids = children.get(u.id) ?? [];
    const [intro, why, source] = resolveIntro(u, kids, manualIntros, sections, rollup, subtreeCards);
    nodes[u.id] = {
      id: u.id,
      title: u.title,
      level: u.level,
      span: { kind: u.span_kind as SpanKind, start: u.span_start, end: u.span_end },
      children: kids.map((k) => k.id),
      n_cards: subtreeCards.get(u.id) ?? cardCounts.get(u.id) ?? 0,
      n_units: subtreeUnits.get(u.id) ?? 1,
      intro,
      why,
      intro_source: source,
    };
  }

  const sources: Record<string, number> = {};
  for (const n of Object.values(nodes)) sources[n.intro_source] = (sources[n.intro_source] ?? 0) + 1;

  return {
    document_id: docId,
    roots: (children.get(null) ?? []).map((u) => u.id),
    nodes,
    stats: {
      units: units.length,
      levels: [...new Set(units.map((u) => u.level))].sort((a, b) => a - b),
      with_intro: Object.values(nodes).filter((n) => n.intro).length,
      intro_sources: sources,
    },
  };
}

function resolveIntro(
  u: UnitRow,
  kids: UnitRow[],
  manualIntros: Record<string, unknown>,
  sections: Record<string, unknown>,
  rollup: Record<string, unknown>,
  subtreeCards: Map<string, number>,
): [string, string, string] {
  const m = asRecord(manualIntros[u.id]);
  if (m && typeof m.intro === 'string' && m.intro) {
    return [String(m.intro), typeof m.why === 'string' ? m.why : '', 'manual'];
  }

  const s = asRecord(sections[u.id]);
  if (s && typeof s.section_summary === 'string' && s.section_summary) {
    // 用 key_takeaways 拼一句"为什么要看"，避免 why 恒为空
    const takeaways = Array.isArray(s.key_takeaways) ? s.key_takeaways : [];
    const why = takeaways.length > 0 ? String(takeaways[0]) : '';
    return [s.section_summary, why, 'section_summary'];
  }

  const r = asRecord(rollup[u.id]);
  if (r && typeof r.intro === 'string' && r.intro) {
    return [r.intro, typeof r.why_important === 'string' ? r.why_important : '', 'rollup_llm'];
  }

  if (kids.length > 0) {
    const names = kids
      .slice(0, 6)
      .map((k) => k.title)
      .filter(Boolean)
      .join('、');
    const more = kids.length > 6 ? ` 等 ${kids.length} 个小节` : '';
    const cards = subtreeCards.get(u.id) ?? 0;
    let intro = names ? `本节包含 ${names}${more}。` : `本节含 ${kids.length} 个子小节。`;
    if (cards) intro += `（该节点及其子节点共 ${cards} 个知识点）`;
    return [intro, '', 'rollup_titles'];
  }

  // 叶子且无摘要：如实说明，而不是编
  const text = (u.text ?? '').trim();
  if (text) {
    const first = text.split('\n')[0]?.slice(0, 80) ?? '';
    return [`（未生成摘要）正文开头：${first}`, '', 'none'];
  }
  return ['（本节无正文，也未生成摘要）', '', 'none'];
}

/** 拍平成带 depth 的列表（调试/导出用）。 */
export function outlineFlat(outline: OutlineResponse): (OutlineNode & { depth: number })[] {
  const out: (OutlineNode & { depth: number })[] = [];
  const walk = (uid: string, depth: number): void => {
    const n = outline.nodes[uid];
    if (!n) return;
    out.push({ ...n, depth });
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const r of outline.roots) walk(r, 0);
  return out;
}
