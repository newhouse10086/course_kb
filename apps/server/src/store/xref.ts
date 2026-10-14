/**
 * 交叉引用（契约 §2.5 / 坑 6、坑 7）—— **四路来源 + 假阳性过滤**。
 *
 * 逐字移植 `worker/pipeline/xref.py`（v1 已验证）。四路（rel 顺序即优先级）：
 *
 * | rel | 来源 |
 * |---|---|
 * | `typed` | 图谱类型化边（Edge）投影到卡片 |
 * | `mention` | 正文提及（**必须过滤**） |
 * | `also_in` | 同名卡片出现在多个 Unit |
 * | `same_unit` | 同 Unit 内其它知识点 |
 *
 * ## ★ 坑 6：不过滤时 `USE` 被引 198 次、`AND` 183 次
 * 过滤规则**逐字照抄契约 §2.5**（不是自己发明的启发式）：
 * ```text
 * 1. 名字含中文 或 含符号 ( ) [ ] . - _ @ # $ %  → 是标识符，允许
 * 2. 名字在 NOISE 集合 → 拒绝
 * 3. 名字长度 < 6 或含空格 → 必须以全大写代码形式出现 → 否则拒绝
 * 4. 其余 → 允许
 * ```
 * ## ★ 坑 7：自引用
 * `TIMESTAMPDIFF()` 的正文提到 `TIMESTAMPDIFF` —— 比较前要去尾部 `()`。
 */

// ★ Lead 集成修复（2026-10-14）：原为
//     import { nameKey, type CardRow, type Repo } from './repo.ts';
//   但 `nameKey` 实际定义在 `./ids.ts`（repo.ts 只 import 它，**没有再导出**）→ 启动即报：
//     SyntaxError: The requested module './repo.ts' does not provide an export named 'nameKey'
//   后果：整个 server 无法启动（index.ts → routes → store/xref）。
//   现拆成两条：函数从 ids.ts 取，类型从 repo.ts 取。
import { nameKey } from './ids.ts';
import type { CardRow, Repo } from './repo.ts';

/** 契约 §2.5 的 NOISE 集合（逐字；英文普通单词在这类文档里到处都是）。 */
export const NOISE: ReadonlySet<string> = new Set(
  `use and or not in is as on to by if for all any set key
   desc path date char time text blob view index table value name type user
   host port file test data event`
    .split(/\s+/)
    .filter(Boolean),
);

/** 规则 1：这些符号出现 → 是标识符/代码，允许。 */
export const IDENT_SYMBOLS = '()[]-_@#$%';

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export function hasCjk(s: string): boolean {
  return CJK_RE.test(s ?? '');
}

/** 该名字是否允许作为 mention 目标（返回 `[允许?, 原因]`）。 */
export function mentionOk(name: string, text: string): [boolean, string] {
  const n = (name ?? '').trim();
  if (!n) return [false, 'empty'];
  // 规则 1
  if (hasCjk(n) || [...n].some((ch) => IDENT_SYMBOLS.includes(ch))) return [true, 'identifier'];
  // 规则 2
  if (NOISE.has(n.toLowerCase())) return [false, 'noise'];
  // 规则 3
  if (n.length < 6 || n.includes(' ')) {
    // 必须以**全大写代码形式**出现（大小写敏感）
    const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(n.toUpperCase())}(?![A-Za-z0-9_])`);
    if (re.test(text ?? '')) return [true, 'uppercase_code'];
    return [false, 'short_or_spaced_without_uppercase'];
  }
  // 规则 4
  return [true, 'ok'];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 坑 7：`TIMESTAMPDIFF()` == `TIMESTAMPDIFF`。 */
function stripParens(s: string): string {
  return (s ?? '').trim().replace(/[()]+$/, '').trim();
}

export function isSelf(src: string, dst: string): boolean {
  return stripParens(src).toLowerCase() === stripParens(dst).toLowerCase();
}

export interface XrefDraft {
  from_card_id: string;
  to_card_id: string;
  rel: 'typed' | 'mention' | 'also_in' | 'same_unit';
  weight: number;
}

export interface XrefStats {
  total: number;
  typed: number;
  mention: number;
  also_in: number;
  same_unit: number;
  candidates: number;
  mention_rejected: Record<string, number>;
  noise_hits: Record<string, number>;
  self_refs_skipped: number;
}

/** 上限：避免同单元 13 张卡片产生 156 条噪音边（v1 已验证的常量）。 */
export const MAX_SAME_UNIT_LINKS = 4;
export const MAX_ALSO_IN_CARDS = 8;

/** 生成四类交叉引用（不写库）。 */
export function buildXrefs(repo: Repo, docId: string): { xrefs: XrefDraft[]; stats: XrefStats } {
  const cards: CardRow[] = repo.allCardRows(docId);
  const units = repo.allUnitRows(docId);
  const out: XrefDraft[] = [];
  const mentionRejected: Record<string, number> = {};
  const noiseHits: Record<string, number> = {};
  let typed = 0;
  let mention = 0;
  let alsoIn = 0;
  let sameUnit = 0;
  let selfRefsSkipped = 0;

  const byId = new Map(cards.map((c) => [c.id, c]));
  const byKey = new Map<string, string[]>();
  for (const c of cards) {
    const list = byKey.get(c.name_key) ?? [];
    list.push(c.id);
    byKey.set(c.name_key, list);
  }

  // ── ① typed：图谱边投影到卡片 ──────────────────────────────────────
  //
  // ⚠️ 匹配必须**同时看实体英文名与 `name_zh`**：本项目实测的抽取产出是
  // 实体「英文名 + 中文名」（`Clustered index` / `聚簇索引`）而卡片名多为中文，
  // 只比 `name_key(e.name)` 会导致 typed 引用恒为 0（静默丢一路来源）。
  const graph = repo.getGraph(docId);
  const entKeys = new Map<string, string[]>(
    graph.nodes.map((n) => [
      n.id,
      [...new Set([nameKey(n.name), n.name_zh ? nameKey(n.name_zh) : ''].filter(Boolean))],
    ]),
  );
  const cardByEntityKey = (entityId: string): string | undefined => {
    for (const k of entKeys.get(entityId) ?? []) {
      const hit = byKey.get(k)?.[0];
      if (hit) return hit;
    }
    return undefined;
  };
  for (const e of graph.edges) {
    const a = cardByEntityKey(e.src);
    const b = cardByEntityKey(e.dst);
    if (!a || !b || a === b) continue;
    out.push({ from_card_id: a, to_card_id: b, rel: 'typed', weight: 1 });
    typed += 1;
  }

  // ── ② mention：正文提及（先过滤候选，再一条正则扫全文）────────────
  const candidates: { id: string; name: string }[] = [];
  for (const c of cards) {
    const [ok, reason] = mentionOk(c.name, '');
    // 规则 3 需要正文才能判定 → 先收进来，扫描时再判
    if (!ok && (reason === 'noise' || reason === 'empty')) {
      mentionRejected[reason] = (mentionRejected[reason] ?? 0) + 1;
      if (reason === 'noise') {
        const k = c.name.toLowerCase();
        noiseHits[k] = (noiseHits[k] ?? 0) + 1;
      }
      continue;
    }
    candidates.push({ id: c.id, name: c.name });
  }

  if (candidates.length > 0) {
    const sorted = [...candidates].sort((a, b) => b.name.length - a.name.length);
    const pattern = new RegExp(sorted.map((c) => escapeRe(c.name)).join('|'), 'g');
    const byNameLower = new Map(candidates.map((c) => [c.name.toLowerCase(), c]));
    const cardsByUnit = new Map<string, CardRow[]>();
    for (const c of cards) {
      const list = cardsByUnit.get(c.unit_id) ?? [];
      list.push(c);
      cardsByUnit.set(c.unit_id, list);
    }
    for (const unit of units) {
      const text = unit.text ?? '';
      if (!text) continue;
      const hits = new Map<string, number>();
      for (const m of text.matchAll(pattern)) {
        const g = m[0];
        hits.set(g, (hits.get(g) ?? 0) + 1);
      }
      if (hits.size === 0) continue;
      for (const [hit, count] of hits) {
        const tgt = byNameLower.get(hit.toLowerCase());
        if (!tgt) continue;
        for (const srcCard of cardsByUnit.get(unit.id) ?? []) {
          if (isSelf(srcCard.name, tgt.name)) {
            selfRefsSkipped += 1;
            continue;
          }
          const [ok, reason] = mentionOk(tgt.name, text);
          if (!ok) {
            mentionRejected[reason] = (mentionRejected[reason] ?? 0) + 1;
            continue;
          }
          out.push({ from_card_id: srcCard.id, to_card_id: tgt.id, rel: 'mention', weight: Math.min(5, count) });
          mention += 1;
        }
      }
    }
  }

  // ── ③ also_in：同名卡片跨单元复现 ─────────────────────────────────
  for (const ids of byKey.values()) {
    if (ids.length < 2) continue;
    for (const a of ids.slice(0, MAX_ALSO_IN_CARDS)) {
      for (const b of ids.slice(0, MAX_ALSO_IN_CARDS)) {
        if (a === b) continue;
        const ca = byId.get(a);
        const cb = byId.get(b);
        if (!ca || !cb || ca.unit_id === cb.unit_id) continue;
        out.push({ from_card_id: a, to_card_id: b, rel: 'also_in', weight: 1 });
        alsoIn += 1;
      }
    }
  }

  // ── ④ same_unit：同单元知识点（有上限，避免噪音）───────────────────
  const byUnit = new Map<string, CardRow[]>();
  for (const c of cards) {
    const list = byUnit.get(c.unit_id) ?? [];
    list.push(c);
    byUnit.set(c.unit_id, list);
  }
  for (const group of byUnit.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name)).slice(0, 12);
    for (const c of ranked) {
      for (const o of ranked.filter((x) => x.id !== c.id).slice(0, MAX_SAME_UNIT_LINKS)) {
        if (isSelf(c.name, o.name)) {
          selfRefsSkipped += 1;
          continue;
        }
        out.push({ from_card_id: c.id, to_card_id: o.id, rel: 'same_unit', weight: 1 });
        sameUnit += 1;
      }
    }
  }

  // ── 去重（DB 主键是 (from,to,rel)，同键只留最大 weight）+ 最后一道自引用过滤 ──
  const merged = new Map<string, XrefDraft>();
  for (const x of out) {
    const a = byId.get(x.from_card_id);
    const b = byId.get(x.to_card_id);
    if (!a || !b) continue;
    if (isSelf(a.name, b.name) || x.from_card_id === x.to_card_id) {
      selfRefsSkipped += 1;
      continue;
    }
    const k = `${x.from_card_id}\u0000${x.to_card_id}\u0000${x.rel}`;
    const prev = merged.get(k);
    if (prev) prev.weight = Math.max(prev.weight, x.weight);
    else merged.set(k, { ...x });
  }
  const xrefs = [...merged.values()];

  return {
    xrefs,
    stats: {
      total: xrefs.length,
      typed,
      mention,
      also_in: alsoIn,
      same_unit: sameUnit,
      candidates: candidates.length,
      mention_rejected: mentionRejected,
      noise_hits: noiseHits,
      self_refs_skipped: selfRefsSkipped,
    },
  };
}

/** 算完写库（原子替换，可重复执行）。 */
export function applyXrefs(repo: Repo, docId: string): { written: number; stats: XrefStats } {
  const { xrefs, stats } = buildXrefs(repo, docId);
  const written = repo.replaceXrefs(docId, xrefs);
  return { written, stats };
}

/** 四路直方图（`/documents/{id}/xrefs` 用）。 */
export function xrefHistogram(repo: Repo, docId: string): Record<string, number> {
  const hist: Record<string, number> = {};
  for (const x of repo.listXrefs(docId)) hist[x.rel] = (hist[x.rel] ?? 0) + 1;
  return hist;
}
