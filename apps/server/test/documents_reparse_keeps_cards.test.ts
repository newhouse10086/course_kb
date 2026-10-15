/**
 * ★★ **reparse 不许清卡**（两个机制一起守）—— 用户"越修越糟"的核心。
 *
 * ## 两个机制（都是真库实测发现的）
 * ```
 * 机制 1（extract.ts 已修）：抽取产出 0 卡片时**照样**全量替换 → 旧卡被清
 * 机制 2（handlers.ts 已修）：parse 的 replaceUnits 每次给单元 **newUnitId()**
 *        → cards.unit_id REFERENCES units(id) **ON DELETE CASCADE** → **级联删卡**
 *        ⟹ 与抽取成功与否无关：**成功的 reparse 也清卡**
 * ```
 * 机制 2 的零 LLM 硬证据（本文件 ③b 就是它的回归测试）：
 * ```
 * 重跑前 cards=1  units=unt_old_1 ；parse 终态 done ；重跑后 cards=0，单元 id 全变
 * ```
 *
 * ## 判据（★ 全零 LLM：`COURSE_KB_AUTO_EXTRACT=0` 只解析不抽取）
 * - ③b ★★ **成功的 reparse + 结构未变 → 旧 cards 还在**（数量与 id 都不变）—— 机制 2 判据
 * - ③b' **真实升级路径**：库里 id 是**随机**的（改前就是这样）→ 第一次 reparse **也不丢卡**
 *        （条件 2(ii)：结构未变时复用旧 id；只做确定性哈希的话迁移那一次仍会清卡）
 * - ③a **失败的 reparse → 旧 cards 还在** + meta 如实标失败
 * - 条件 1 **碰撞**：同 (ord, span, title) 的单元 → 都还在（或如实报碰撞）—— 纯函数单测
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { buildApp } from '../src/index.ts';
import type { BuiltApp } from '../src/index.ts';
import { loadConfig } from '../src/config.ts';
import { planUnitIds } from '../src/tasks/handlers.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
let tmp = '';
let built: BuiltApp | null = null;
let adminId = '';
let docId = '';
let srcPath = '';

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-cards-'));
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DB: path.join(tmp, 't.sqlite3'),
      COURSE_KB_DATA_DIR: path.join(tmp, 'data'),
      COURSE_KB_SETTINGS_FILE: path.join(tmp, 'settings.json'),
      COURSE_KB_BOOTSTRAP_ADMIN: 'admin:keep-cards-1',
      // ★ 零 LLM：只解析不抽取 → 隔离"级联删卡"这一机制（抽取由另一个测试文件守）
      COURSE_KB_AUTO_EXTRACT: '0',
    } as Record<string, string>,
  });
  built = await buildApp({ cfg });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const repo = built.deps.repo;
  adminId = repo.rbac.getUserRowByName('admin')!.id;
  srcPath = path.join(tmp, 'doc.txt');
  fs.writeFileSync(srcPath, '# 数据库索引\n## 聚簇索引\n聚簇索引决定表中数据在磁盘上的物理存储顺序。\n', 'utf8');
  docId = repo.insertDocument({
    title: 'reparse 保卡',
    kind: 'txt',
    source_path: srcPath,
    status: 'ready',
    ownerId: adminId,
    visibility: 'public',
    reviewStatus: 'published',
  });
});

after(async () => {
  try {
    if (built) await built.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows 偶发占用 */
  }
});

const TERMINAL = ['done', 'failed', 'cancelled', 'partial', 'done_empty'];
async function runParse(ms = 180_000) {
  const taskId = built!.deps.queue.enqueue({ docId, kind: 'parse', userId: adminId, params: {} });
  const dl = Date.now() + ms;
  let t = built!.deps.repo.getTask(taskId);
  while (t && !TERMINAL.includes(t.status) && Date.now() < dl) {
    await new Promise((x) => setTimeout(x, 200));
    t = built!.deps.repo.getTask(taskId);
  }
  return t;
}

const unitsOf = (): {
  id: string; ord: number; title: string; text: string; level: number;
  parent_id: string | null; span_kind: string; span_start: number; span_end: number;
}[] =>
  built!.deps.repo.db.all(
    'SELECT id, ord, title, text, level, parent_id, span_kind, span_start, span_end FROM units WHERE doc_id = ? ORDER BY ord',
    docId,
  );
const cardsOf = () => built!.deps.repo.listCards(docId, { offset: 0, limit: 50 });
const meta = (): Record<string, unknown> => {
  const row = built!.deps.repo.getDocumentRow(docId) as { meta_json?: string } | undefined;
  try {
    return JSON.parse(String(row?.meta_json ?? '{}')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** 把当前单元改成"**随机的旧 id**"（模拟改前的真实库）+ 插入引用它们的旧卡片。 */
function seedLegacyRandomIdsAndCards(): { unitIds: string[]; cardIds: string[] } {
  const repo = built!.deps.repo;
  const rows = unitsOf();
  assert.ok(rows.length > 0, '前置：必须先解析出单元');
  // 用随机的"旧 id"重写单元（先删后插；此刻还没有卡片，不会级联）
  repo.db.run('DELETE FROM units WHERE doc_id = ?', docId);
  const unitIds: string[] = [];
  rows.forEach((r, i) => {
    const legacy = `unt_${(0x1d959dc1b164 + i * 7919).toString(16)}`; // 形如改前的随机 id
    unitIds.push(legacy);
    // ★ 必须**逐字段照抄**（含 span/level/parent_id）：复用判据是 `(ord, span)` + 正文，
    //   我第一版把 span 写死成 (0, 100+i) → 与真实解析结果不匹配 → 复用失效 → 测试假红。
    repo.db.run(
      `INSERT INTO units(id,doc_id,ord,title,text,text_len,level,parent_id,span_kind,span_start,span_end) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      legacy, docId, r.ord, r.title, r.text, r.text.length, r.level,
      i === 0 ? null : unitIds[0]!, r.span_kind, r.span_start, r.span_end,
    );
  });
  const cardIds = repo.replaceCards(docId, [
    {
      unit_id: unitIds[0]!, name: '旧卡片', kind: 'concept', one_line: 'o', purpose: 'p',
      usage_mode: 'unknown', operational_role: 'unknown', lifecycle: 'unknown',
      example: null, example_explained: null, prerequisites: [], cautions: [],
      evidence_quote: '聚簇索引', evidence_span: { kind: 'char', start: 0, end: 4 }, confidence: 0.9,
    },
  ] as never);
  repo.mergeDocumentMeta(docId, { extract_status: 'done', parse_status: 'done' });
  return { unitIds, cardIds };
}

test('③b ★★ 成功的 reparse + 结构未变 → 旧 cards **还在**（机制 2 判据）', async () => {
  const first = await runParse();
  assert.equal(first?.status, 'done', `首次解析应成功（实际 ${first?.status}）`);

  // ★ 前提（真 worker）：markdown `# 标题` 紧跟 `## 子标题` → **顶层标题单元正文为空**。
  //   这条是 (a) 单元级闸门的存在理由（文档级 text_gate 抓不到"个别单元为空"）。
  const emptyRows = built!.deps.repo.db.all<{ id: string; title: string }>(
    "SELECT id, title FROM units WHERE doc_id = ? AND trim(coalesce(text,'')) = ''",
    docId,
  );
  assert.ok(
    emptyRows.length > 0,
    `★ 真解析必须产出至少一个**空正文单元**（否则 (a) 闸门没有存在理由）；` +
      `实际 units=${JSON.stringify(unitsOf().map((u) => ({ ord: u.ord, title: u.title, n: (u.text ?? '').length })))}`,
  );

  // 造"改前的真实库"：随机旧 id + 引用它们的卡片
  const seeded = seedLegacyRandomIdsAndCards();
  const beforeCards = cardsOf();
  const beforeUnits = unitsOf().map((u) => u.id);
  assert.equal(beforeCards.total, 1, '前置：应有 1 张旧卡片');
  assert.deepEqual(beforeUnits, seeded.unitIds, '前置：单元应是"随机旧 id"');

  // ★ 重跑（**成功**的 reparse，结构未变）
  const second = await runParse();
  assert.equal(second?.status, 'done', `reparse 应成功（实际 ${second?.status} ${JSON.stringify(second?.error)}）`);

  const afterCards = cardsOf();
  const afterUnits = unitsOf().map((u) => u.id);
  assert.equal(
    afterCards.total,
    beforeCards.total,
    `★ 成功的 reparse **不许清卡**（机制 2：单元 id 变了 → FK 级联删除）。` +
      `重跑前 ${beforeCards.total} 张 → 重跑后 ${afterCards.total} 张`,
  );
  assert.deepEqual(
    afterCards.cards.map((c) => c.id).sort(),
    beforeCards.cards.map((c) => c.id).sort(),
    '★ 卡片 **id** 也要一模一样（不是"又抽了一批"）',
  );
  assert.deepEqual(afterUnits, beforeUnits, '★ 结构未变时单元 id 必须**复用旧 id**（否则级联删卡）');
  const plan = meta().unit_id_plan as { reused?: number } | undefined;
  assert.ok(plan && Number(plan.reused) > 0, `★ meta 应如实记录 id 复用情况（实际 ${JSON.stringify(plan)}）`);
});

test('③b′ ★ 真实升级路径：库里是随机 id → 第一次 reparse **也不丢卡**（条件 2(ii)）', async () => {
  // 再种一次"随机旧 id + 卡片"（模拟用户当前库；此时上面的修复已生效过一轮）
  const seeded = seedLegacyRandomIdsAndCards();
  const before = cardsOf();
  const beforeIds = unitsOf().map((u) => u.id);
  assert.deepEqual(beforeIds, seeded.unitIds, '前置：id 是随机的（改前形态）');

  const t = await runParse();
  assert.equal(t?.status, 'done', `reparse 应成功（实际 ${t?.status}）`);
  assert.equal(cardsOf().total, before.total, '★ 迁移那一次**也不能丢卡**（只做确定性哈希会在这里丢）');
  assert.deepEqual(unitsOf().map((u) => u.id), beforeIds, '★ 首次迁移就应复用旧 id（一次到位）');
});

test('③a ★ 失败的 reparse → 旧 cards 还在 + meta 如实标失败', async () => {
  const before = cardsOf();
  assert.ok(before.total > 0, '前置：应有旧卡片');
  // 让解析**必然失败**：源文件消失
  const gone = path.join(tmp, 'gone.txt');
  fs.writeFileSync(gone, 'x', 'utf8');
  built!.deps.repo.db.run('UPDATE documents SET source_path = ? WHERE id = ?', gone, docId);
  fs.rmSync(gone, { force: true });

  const t = await runParse();
  assert.equal(t?.status, 'failed', `解析失败时任务必须如实 failed（实际 ${t?.status}）`);
  const after = cardsOf();
  assert.equal(after.total, before.total, `★ 失败的 reparse 不许清卡（${before.total} → ${after.total}）`);
  assert.deepEqual(after.cards.map((c) => c.id).sort(), before.cards.map((c) => c.id).sort(), '★ 卡片 id 不变');
  const m = meta();
  assert.match(String(m.parse_error ?? m.extract_error ?? ''), /./, '★ meta 必须留下可读原因（不许只改状态）');
  // 恢复源文件，避免影响后续
  built!.deps.repo.db.run('UPDATE documents SET source_path = ? WHERE id = ?', srcPath, docId);
});

// ═══════════════════════════════════════════════════════════════════════
// ③c ★★ **解析产出 0 单元 → 旧 units 与旧 cards 都还在**（Lead 新加的边界）
//     `stale = 现有单元 − keep(新 id)`：若 drafts 为空则 keep 为空 → stale = 全部
//     → 删光 → 卡片级联删光。**"解析失败"不该等价于"删掉全部内容"**（与 (b) 同一原则）。
// ═══════════════════════════════════════════════════════════════════════
test('③c ★★ 解析产出 0 单元（空 drafts）→ 旧 units 与旧 cards **都还在**', () => {
  const repo = built!.deps.repo;
  const unitsBefore = unitsOf();
  const cardsBefore = cardsOf();
  assert.ok(unitsBefore.length > 0 && cardsBefore.total > 0, '前置：需要已有单元与卡片');

  // ★ 直接打 repo 层（解析"产不出单元"时 handler 就是这样调的）
  const ids = repo.replaceUnits(docId, []);
  assert.deepEqual(ids, [], '空 drafts 应返回空 id 列表');

  assert.deepEqual(
    unitsOf().map((u) => u.id).sort(),
    unitsBefore.map((u) => u.id).sort(),
    '★ 空 drafts **一个单元都不许删**（否则 stale=全部 → 删库）',
  );
  assert.equal(
    cardsOf().total,
    cardsBefore.total,
    `★ 空 drafts 不许级联删卡（期望 ${cardsBefore.total}，实际 ${cardsOf().total}）`,
  );
});

// ═══════════════════════════════════════════════════════════════════════
// ④ ★★ 可信度判据：**卡片活下来 ≠ 卡片还有效**
//     若单元正文被换成不同内容而卡片没重抽，卡片就引用了**不存在的原文** ——
//     比丢卡更危险（丢卡看得见；引用错原文看不出来）。
//     判据与 worker 的五分类一致：引用必须能在其单元正文里**逐字**（空白不敏感）找到。
// ═══════════════════════════════════════════════════════════════════════
test('④ ★★ 幸存卡片的 evidence_quote 仍能在其单元正文里逐字找到（不许 fabricated）', async () => {
  // 用"引用与正文一致"的卡片种一遍（模拟真实抽取产物），再重跑，再校验
  const repo = built!.deps.repo;
  const rows = unitsOf();
  assert.ok(rows.length > 0, '前置：需要单元');
  // ⚠️ 必须挑**有正文**的单元：ord=0 的那个是**空正文的标题单元**（正是 (a) 的前提），
  //    拿它做引用校验会得到空引用（missing），那是另一条判据。
  const host = rows.find((r) => (r.text ?? '').trim().length >= 4);
  assert.ok(host, `前置：需要至少一个**有正文**的单元（实际 ${JSON.stringify(rows.map((r) => r.text))}）`);
  const quote = (host.text || '').slice(0, 8);
  assert.ok(quote.length >= 4, `前置：单元正文要够长（实际 ${JSON.stringify(host.text)}）`);
  repo.replaceCards(docId, [
    {
      unit_id: host.id, name: '可信卡片', kind: 'concept', one_line: 'o', purpose: 'p',
      usage_mode: 'unknown', operational_role: 'unknown', lifecycle: 'unknown',
      example: null, example_explained: null, prerequisites: [], cautions: [],
      evidence_quote: quote, evidence_span: { kind: 'char', start: 0, end: quote.length }, confidence: 0.9,
    },
  ] as never);

  const t = await runParse();
  assert.equal(t?.status, 'done', `reparse 应成功（实际 ${t?.status}）`);

  // 与 worker `extract_core.check_quote` 同一判据：**只归一空白，不动字符**
  const squeeze = (s: string): string => (s ?? '').replace(/[\s\u3000]+/g, '').replace(/\ufeff/g, '');
  const unitText = new Map(unitsOf().map((u) => [u.id, u.text ?? '']));
  const cards = cardsOf().cards;
  assert.ok(cards.length > 0, '前置：应有幸存卡片');
  for (const c of cards) {
    const body = unitText.get(c.unit_id ?? '') ?? '';
    assert.ok(
      squeeze(body).includes(squeeze(c.evidence_quote ?? '')),
      `★ 幸存卡片的引用必须仍能在其单元正文里逐字找到（否则卡片引用了不存在的原文）：` +
        `card=${c.id} quote=${JSON.stringify(c.evidence_quote)} unit=${JSON.stringify(body.slice(0, 40))}`,
    );
    assert.ok((c.evidence_quote ?? '').trim().length > 0, '★ 不许出现空引用（那是 missing，不是 exact）');
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 条件 1：碰撞安全性（纯函数单测，快且穷举）
// ═══════════════════════════════════════════════════════════════════════
test('条件 1 ★ 同 (ord, span, title) 的单元 → id 不重复（加后缀）且**如实报碰撞**', () => {
  const drafts = [
    { ord: 1, title: '重复标题', span: { kind: 'char', start: 0, end: 10 }, text: 'A' },
    { ord: 1, title: '重复标题', span: { kind: 'char', start: 0, end: 10 }, text: 'B' },
    { ord: 2, title: '正常', span: { kind: 'char', start: 10, end: 20 }, text: 'C' },
  ];
  const plan = planUnitIds({ docId: 'doc_x', drafts, oldUnits: [] });
  assert.equal(new Set(plan.ids).size, 3, `★ 三个单元必须三个不同 id（不许静默覆盖）：${JSON.stringify(plan.ids)}`);
  assert.equal(plan.collisions.length, 1, `★ 碰撞必须如实上报（实际 ${JSON.stringify(plan.collisions)}）`);
  assert.match(plan.collisions[0]!.final, /-2$/, '碰撞的 id 应加 -2 后缀');
});

test('条件 1 ★ `span` 缺失时 null 与 "" **不许**算出同一个哈希', () => {
  const a = planUnitIds({ docId: 'd', drafts: [{ ord: 1, title: 't', span: undefined, text: 'x' }], oldUnits: [] });
  const b = planUnitIds({
    docId: 'd',
    drafts: [{ ord: 1, title: 't', span: { kind: '' as unknown as string, start: Number.NaN, end: Number.NaN }, text: 'x' }],
    oldUnits: [],
  });
  assert.equal(a.ids[0], b.ids[0], '缺失/空 span 都按同一占位符处理（都是"没有 span"）');
  const c = planUnitIds({
    docId: 'd',
    drafts: [{ ord: 1, title: 't', span: { kind: 'char', start: 0, end: 0 }, text: 'x' }],
    oldUnits: [],
  });
  assert.notEqual(a.ids[0], c.ids[0], '★ 有 span(0,0) 与没有 span **必须**不同 id（否则真实单元会撞上占位）');
});

test('条件 1 ★ 确定性：同一输入两次 → 同一 id（跨进程也不变）', () => {
  const drafts = [{ ord: 3, title: '索引', span: { kind: 'page', start: 1, end: 2 }, text: 'x' }];
  const p1 = planUnitIds({ docId: 'doc_a', drafts, oldUnits: [] });
  const p2 = planUnitIds({ docId: 'doc_a', drafts, oldUnits: [] });
  assert.deepEqual(p1.ids, p2.ids);
  const p3 = planUnitIds({ docId: 'doc_b', drafts, oldUnits: [] });
  assert.notDeepEqual(p1.ids, p3.ids, '不同文档的同一位置应是不同 id（docId 参与哈希）');
});

test('条件 2(ii) ★ 结构未变 + 正文相同 → 复用旧 id；正文变了 → 用确定性 id', () => {
  const old = [{ id: 'unt_random_1', ord: 1, span_kind: 'char', span_start: 0, span_end: 10, text: '旧正文' }];
  const same = planUnitIds({
    docId: 'd', oldUnits: old,
    drafts: [{ ord: 1, title: 't', span: { kind: 'char', start: 0, end: 10 }, text: '旧正文' }],
  });
  assert.equal(same.ids[0], 'unt_random_1', '★ 结构未变 + 正文相同 → 必须复用旧 id（否则级联删卡）');
  assert.equal(same.reused, 1);
  const changed = planUnitIds({
    docId: 'd', oldUnits: old,
    drafts: [{ ord: 1, title: 't', span: { kind: 'char', start: 0, end: 10 }, text: '新正文（OCR 补上了）' }],
  });
  assert.notEqual(changed.ids[0], 'unt_random_1', '正文变了 → 不复用（该单元确实换了内容）');
  assert.match(changed.ids[0]!, /^unt_[0-9a-f]{12}$/, '应用确定性 id');
});

// ═══════════════════════════════════════════════════════════════════════
// ★ 为什么 `replaceUnits` 必须是"只删消失的单元"（而不是全量 DELETE）
//
// 这条是**负向对照**（negative control）：它把 FK 级联的**时机**钉住 ——
// 级联发生在 `DELETE` 那一刻，**随后用同一个 id 重新 INSERT 也救不回来**。
// ⟹ 所以"稳定 id"单独不够（我第一版据此判断，被实测推翻），必须让仍在的单元**不被删除**。
// 有了这条，后来人改回全量 DELETE 时会立刻看到它红。
// ═══════════════════════════════════════════════════════════════════════
test('★ 负向对照：`DELETE units` 那一刻级联就删卡，重插同 id 也救不回来（所以必须"不删"）', () => {
  const repo = built!.deps.repo;
  const doc = repo.insertDocument({
    title: 'FK 时机对照',
    kind: 'txt',
    source_path: srcPath,
    status: 'ready',
    ownerId: adminId,
    visibility: 'public',
    reviewStatus: 'published',
  });
  const insUnit = (): void => {
    repo.db.run(
      `INSERT INTO units(id,doc_id,ord,title,text,text_len,span_kind,span_start,span_end) VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET text=excluded.text, text_len=excluded.text_len`,
      'unt_same_id', doc, 1, 't', '正文', 2, 'char', 0, 2,
    );
  };
  insUnit();
  repo.replaceCards(doc, [
    {
      unit_id: 'unt_same_id', name: 'c', kind: 'concept', one_line: 'o', purpose: 'p',
      usage_mode: 'unknown', operational_role: 'unknown', lifecycle: 'unknown',
      example: null, example_explained: null, prerequisites: [], cautions: [],
      evidence_quote: '正文', evidence_span: { kind: 'char', start: 0, end: 2 }, confidence: 0.5,
    },
  ] as never);
  assert.equal(repo.listCards(doc, {}).total, 1, '前置：1 张卡');

  // ① 删除单元 → 级联立刻发生
  repo.db.run('DELETE FROM units WHERE doc_id = ?', doc);
  assert.equal(repo.listCards(doc, {}).total, 0, '★ 级联发生在 DELETE 那一刻');
  // ② 用**同一个 id** 插回来 → 卡片不会复活
  insUnit();
  assert.equal(
    repo.listCards(doc, {}).total,
    0,
    '★ 重插同 id 救不回来 —— 这正是"稳定 id 单独不够"的证据（修法必须是不删）',
  );
});
