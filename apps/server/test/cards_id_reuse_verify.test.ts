/**
 * ★★ **cards 复用 id 的独立验证**（`reparse` 后旧卡不许被换掉）。
 *
 * ## 背景（`polysemy-prober` 真机发现，我已独立读码复验成立）
 * ```ts
 * replaceCards(docId, drafts) { tx(() => { DELETE FROM cards WHERE doc_id=?; return insertCardsNoTx(...); }); }
 * ```
 * 实测：抽取 10 张 → reparse 后 8 张，但**旧 id 保留 0/10** ——
 * ★ **数量变化把"全量替换"伪装成"小幅减少"**（只数总数会漏掉这个 bug）。
 * 用户可见危害：旧卡链接 `GET /cards/<旧id>` → **404**；`notes.card_id`（纯 TEXT 无 FK）→ **悬空且静默**。
 *
 * ## 判据（Lead 指定，沿用 prober 的）
 * ① ★ **S1 ⊆ S2**：抽取 → 记 id 集合 → reparse → 旧 id **全部仍在**（**按集合，不是数总数**）
 * ② ★ **反例**：`drafts` 为空（抽取失败/零产出）→ **旧卡一张都不许少**（失败不清库）
 * ③ ★ **内容变了要换 id**（该卡确实变了，重抽是对的）—— 别修成"永远复用"
 * ④ ★ **真 HTTP**：`GET /cards/<旧 id>` → reparse 后**仍 200**（不是 404）—— **用户可见**
 * ⑤ ★ **悬空检查**：`xrefs`/`edges` 悬空 = 0（prober 验过是好的，别被这次改动弄坏）
 *
 * ## 方法（★ 不采信自述）
 * - 直连 repo（不走 HTTP）验 id 集合语义 —— 与 HTTP 探针**两种独立方法**互证
 * - **零 LLM**：自己造 units/cards，不跑抽取
 *
 * ⚠️ 本文件在**修复前**应当**红**（正是它存在的意义）；修复后应全绿。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { Db } from '../src/store/db.ts';
import { Repo, type CardDraft, type UnitDraft } from '../src/store/repo.ts';

let tmp = '';
let db: Db;
let repo: Repo;
let userId = '';
let docId = '';

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-reuse-'));
  db = Db.open(path.join(tmp, 't.sqlite3'));
  db.migrate();
  repo = new Repo(db);
  userId = repo.rbac.createUser({ username: 't1', displayName: 'T', passwordHash: 'x', roles: ['teacher'] });
  docId = repo.insertDocument({
    title: 'doc.pdf',
    kind: 'pdf',
    source_path: '/tmp/x.pdf',
    status: 'ready',
    ownerId: userId,
  });
});

after(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows 偶发占用 */
  }
});

const unit = (ord: number, text: string): UnitDraft =>
  ({ ord, title: `单元${ord}`, level: 2, span: { kind: 'page', start: ord, end: ord }, text }) as UnitDraft;

const card = (unitId: string, name: string, quote: string): CardDraft =>
  ({
    unit_id: unitId,
    name,
    kind: 'concept',
    one_line: `${name} 的一句话`,
    purpose: 'purpose',
    usage_mode: 'unknown',
    operational_role: 'unknown',
    lifecycle: 'unknown',
    evidence_quote: quote,
    span: { kind: 'page', start: 1, end: 1 },
    confidence: 0.9,
  }) as unknown as CardDraft;

const idsOf = (id: string): Set<string> =>
  new Set(repo.allCardRows(id).map((c) => c.id));

test('★★ 判据①：同样的草稿再写一次 → **旧 id 必须全部保留**（S1 ⊆ S2）', () => {
  const unitIds = repo.replaceUnits(docId, [unit(1, '聚簇索引正文'), unit(2, '二级索引正文')]);
  assert.equal(unitIds.length, 2, '前置：两个单元');

  // 第一次写卡（模拟抽取）
  const first = repo.replaceCards(docId, [
    card(unitIds[0]!, '聚簇索引', '聚簇索引正文'),
    card(unitIds[1]!, '二级索引', '二级索引正文'),
  ]);
  const s1 = idsOf(docId);
  assert.equal(s1.size, 2, `前置：应有 2 张卡，实际 ${s1.size}`);

  // ★ 再写一次**相同内容**（模拟 reparse 后重新抽取得到同样结果）
  const second = repo.replaceCards(docId, [
    card(unitIds[0]!, '聚簇索引', '聚簇索引正文'),
    card(unitIds[1]!, '二级索引', '二级索引正文'),
  ]);
  void first;
  void second;
  const s2 = idsOf(docId);
  const kept = [...s1].filter((id) => s2.has(id));
  assert.equal(
    kept.length,
    s1.size,
    `★ 旧 id 必须全部保留（S1 ⊆ S2）：保留 ${kept.length}/${s1.size} —— ` +
      `原缺陷是"全删重插"（真机实测 10→8 张但旧 id 保留 0/10）。` +
      `丢失：${[...s1].filter((id) => !s2.has(id)).join(', ')}`,
  );
});

test('★★ 判据②：`drafts` 为空 → **旧卡一张都不许少**（失败不清库）', () => {
  const before = idsOf(docId);
  assert.ok(before.size > 0, '前置：已有卡片');
  repo.replaceCards(docId, []); // 模拟"抽取失败/零产出"
  const after2 = idsOf(docId);
  assert.equal(
    after2.size,
    before.size,
    `★ 零产出不许清库：${before.size} → ${after2.size}（原缺陷会全删；与 replaceUnits 的"失败不清库"同一原则）`,
  );
});

test('★ 判据③：**内容真的变了 → 换 id**（别修成"永远复用"）', () => {
  const unitIds = repo.allUnitRows(docId).map((u) => u.id);
  const before = repo.allCardRows(docId).map((c) => ({ id: c.id, name: c.name }));
  const target = before.find((c) => c.name === '聚簇索引');
  assert.ok(target, '前置：应有"聚簇索引"卡');

  // 改内容（one_line 变了）→ 该卡应换 id（重抽是对的），其余保持不变
  repo.replaceCards(docId, [
    card(unitIds[0]!, '聚簇索引', '聚簇索引正文（改写后的引用）'),
    card(unitIds[1]!, '二级索引', '二级索引正文'),
  ]);
  const after3 = repo.allCardRows(docId).map((c) => ({ id: c.id, name: c.name }));
  const stillThere = after3.some((c) => c.id === target.id);
  assert.equal(
    stillThere,
    false,
    '★ 内容变了的卡片**应当换 id**（"永远复用"会把旧内容钉住，让重抽白跑）—— 判据：复用键要含内容/引用',
  );
  // 未变的卡片仍应保留（否则又变成全删重插）
  const unchanged = before.find((c) => c.name === '二级索引');
  assert.ok(
    after3.some((c) => c.id === unchanged?.id),
    '★ 内容未变的卡片必须**保留 id**（否则仍是全量替换）',
  );
});

test('★ 判据⑤：xrefs / edges **悬空 = 0**（别被这次改动弄坏）', () => {
  const dangling = db.get<{ n: number }>(
    // ⚠️ 原写法用 `xrefs.src_id/dst_id` —— 真实列名是 `from_card_id/to_card_id`（见 db.ts 的 xrefs DDL）
    //    → 原写法必然 SQLITE_ERROR，判据⑤**永远红**（与 replaceCards 的修复无关）
    // ⚠️ 该 SQL **没有占位符**（xrefs 没有 doc_id 列）→ 不能再传 docId 实参
    `SELECT COUNT(*) AS n FROM xrefs WHERE from_card_id NOT IN (SELECT id FROM cards) OR to_card_id NOT IN (SELECT id FROM cards)`,
  );
  assert.equal(dangling?.n ?? -1, 0, '★ xrefs 不许有悬空引用（prober 验过是好的）');
  const danglingEdges = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM edges WHERE doc_id = ? AND (src_id NOT IN (SELECT id FROM entities) OR dst_id NOT IN (SELECT id FROM entities))`,
    docId,
  );
  assert.equal(danglingEdges?.n ?? -1, 0, '★ edges 不许有悬空引用');
});
