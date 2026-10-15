/**
 * 检索层测试（2/3）：`wiki` 词法检索 —— **真数据、真页码锚点**。
 *
 * 覆盖 lead 的验收项：
 * - `wiki`：真返回卡片 + **页码锚点**（实测「索引」有命中）
 * - `wiki` 与 `kg` **各自独立**（`wiki` 不碰图、`kg` 不碰 FTS）
 * - 跨用户隔离（负例）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { indexDocument } from '../src/store/search.ts';
import { createRetrievalFacade } from '../src/retrieval/index.ts';
import { createRegistry, retrieve as regRetrieve } from '../src/retrieval/registry.ts';
import { WikiRetriever } from '../src/retrieval/wiki.ts';

function seedDoc(
  repo: Repo,
  opts: { title: string; ownerId?: string | null; reviewStatus?: 'draft' | 'published'; visibility?: 'private' | 'public'; cards?: { name: string; one_line: string; quote: string; start: number; end: number; text: string }[] },
): string {
  const docId = repo.insertDocument({
    title: opts.title,
    kind: 'pdf',
    source_path: `data/uploads/${opts.title}.pdf`,
    page_count: 50,
    status: 'ready',
    ownerId: opts.ownerId ?? null,
    reviewStatus: opts.reviewStatus ?? 'published',
    visibility: opts.visibility ?? 'public',
  });
  const cards = opts.cards ?? [];
  const unitIds = repo.replaceUnits(docId, [
    { ord: 1, title: 'Chapter 1 索引与优化', level: 1, parent_ord: null, span: { kind: 'page', start: 1, end: 30 }, text: cards.map((c) => c.text).join(' ') },
  ]);
  repo.replaceCards(
    docId,
    cards.map((c) => ({
      unit_id: unitIds[0] as string,
      name: c.name,
      kind: 'concept',
      one_line: c.one_line,
      evidence_quote: c.quote,
      evidence_span: { kind: 'page', start: c.start, end: c.end },
      confidence: 0.9,
    })),
  );
  indexDocument(repo.db, repo, docId);
  return docId;
}

function fresh() {
  const db = Db.open(':memory:');
  const repo = new Repo(db);
  return { db, repo, facade: createRetrievalFacade({ db, repo }) };
}

/** 造一个用户 + 课程成员（外键开着，**必须先建行**，否则 SQLITE_CONSTRAINT_FOREIGNKEY）。 */
function makeUser(repo: Repo, name: string): string {
  // `roles` 是必填（RBAC）：不给则该用户只有 owner 权限，学生的课程可见性靠 course_members
  return repo.rbac.createUser({ username: name, displayName: name, passwordHash: 'x', roles: ['student'] });
}

// ═══════════════════════════════════════════════════════════════════════

test('wiki：中文「索引」真命中卡片，且带**页码锚点**与可读 why', async () => {
  const { db, repo, facade } = fresh();
  const docId = seedDoc(repo, {
    title: '手册A',
    cards: [
      { name: '聚簇索引', one_line: '数据按主键顺序存放的索引', quote: 'Clustered indexes sort rows by key.', start: 3174, end: 3174, text: '聚簇索引将数据按主键顺序存放，二级索引需要回表。' },
      { name: '事务隔离', one_line: '控制并发可见性', quote: 'Isolation controls visibility.', start: 400, end: 401, text: '事务的隔离性决定并发可见性。' },
    ],
  });

  const res = await facade.retrieve({ mode: 'wiki', query: '索引', userId: null, docId });
  assert.equal(res.available, true, 'wiki 必须可用（底层已有）');
  assert.ok(res.items.length > 0, '「索引」必须真的有命中（中文 bigram）');

  const top = res.items[0]!;
  assert.equal(top.refKind, 'card');
  assert.equal(top.title, '聚簇索引');
  // ★ 页码锚点 —— lead 的验收项
  assert.deepEqual(top.evidence, { kind: 'page', start: 3174, end: 3174 });
  assert.match(top.why!, /bigram 命中/, 'why 必须说明是词法命中');
  assert.match(top.why!, /索引/, 'why 要点出命中词');
  // 每条都有锚点（规则 1）
  assert.ok(res.items.every((i) => i.evidence && i.evidence.start >= 1));
  db.close();
});

test('wiki：无命中的查询 → 可用的空结果（不是"不可用"）', async () => {
  const { db, repo, facade } = fresh();
  const docId = seedDoc(repo, {
    title: '手册A',
    cards: [{ name: '聚簇索引', one_line: 'x', quote: 'y', start: 2, end: 2, text: '聚簇索引正文。' }],
  });
  const res = await facade.retrieve({ mode: 'wiki', query: '量子纠缠', userId: null, docId });
  assert.equal(res.available, true, '★ 搜不到 ≠ 不可用（这是两种完全不同的状态）');
  assert.deepEqual(res.items, []);
  db.close();
});

test('wiki：英文术语也能命中（bigram 保 ASCII 整词）', async () => {
  const { db, repo, facade } = fresh();
  const docId = seedDoc(repo, {
    title: '手册A',
    cards: [{ name: 'Clustered index', one_line: 'sorted by key', quote: 'Clustered indexes sort rows by key.', start: 10, end: 10, text: 'Clustered indexes sort rows by key.' }],
  });
  const res = await facade.retrieve({ mode: 'wiki', query: 'Clustered', userId: null, docId });
  assert.ok(res.items.length > 0, '英文查询同样要走通（同一 FTS）');
  assert.equal(res.items[0]!.title, 'Clustered index');
  db.close();
});

test('wiki：无锚点卡片不进结果（规则 1 端到端）', async () => {
  const { db, repo, facade } = fresh();
  const docId = repo.insertDocument({ title: '手册B', kind: 'pdf', source_path: 'p', page_count: 1, status: 'ready', reviewStatus: 'published', visibility: 'public' });
  const unitIds = repo.replaceUnits(docId, [{ ord: 1, title: 'u', level: 1, parent_ord: null, span: { kind: 'page', start: 1, end: 1 }, text: '索引正文索引。' }]);
  // span_kind='' + 0/0 → 无锚点
  repo.replaceCards(docId, [{ unit_id: unitIds[0] as string, name: '无锚点卡片', kind: 'concept', one_line: '在正文里能被搜到', evidence_quote: '索引', confidence: 0.5 }]);
  indexDocument(repo.db, repo, docId);

  const res = await facade.retrieve({ mode: 'wiki', query: '索引', userId: null, docId });
  const cardItems = res.items.filter((i) => i.refKind === 'card');
  assert.deepEqual(cardItems, [], '★ 卡片 span 非法 → 不许进上下文');
  // 但单元（有合法 span）仍应进入 —— 说明丢弃是**按条目**的，不是整个查询失败
  assert.ok(res.items.some((i) => i.refKind === 'unit'), '有锚点的单元条目必须保留');
  assert.match(res.reason ?? '', /无可回溯锚点/, '丢弃要如实上报');
  db.close();
});

test('wiki 与 kg 各自独立：wiki 不产图谱边，kg 不产单元，二者的 id 空间不重叠', async () => {
  const { db, repo } = fresh();
  const docId = seedDoc(repo, {
    title: '手册A',
    cards: [{ name: '聚簇索引', one_line: 'x', quote: 'Clustered indexes sort rows by key.', start: 2, end: 2, text: '聚簇索引正文。' }],
  });
  repo.replaceGraph(docId, [{ name: '聚簇索引', name_zh: '聚簇索引', type: 'mechanism', layer: 'L1' }, { name: 'B+tree', name_zh: 'B+树', type: 'mechanism', layer: 'L1' }], [
    { src: '聚簇索引', dst: 'B+tree', etype: 'IMPLEMENTS', evidence_text: 'implemented as B+tree', span: { kind: 'page', start: 2, end: 2 } },
  ]);
  const registry = createRegistry({ db, repo, edgeTypes: ['IMPLEMENTS', 'PART_OF', 'DEPENDS_ON'] });

  const wiki = await regRetrieve(registry, { mode: 'wiki', q: '索引', userId: null, docId });
  const kg = await regRetrieve(registry, { mode: 'kg', q: '聚簇索引', userId: null, docId });

  assert.ok(wiki.items.length > 0 && kg.items.length > 0);
  assert.ok(wiki.items.every((i) => i.kind === 'card' || i.kind === 'unit'), 'wiki 只出卡片/单元');
  assert.ok(kg.items.every((i) => i.kind === 'entity' || i.kind === 'edge'), 'kg 只出实体/边');
  // kg 的 why 是图语言，wiki 的是词法语言 —— 学生据此看出两种检索的差别
  assert.ok(kg.items.some((i) => /跳|锚点命中实体|边证据/.test(i.why)), 'kg 的 why 必须是图语言');
  assert.ok(wiki.items.some((i) => /bigram 命中/.test(i.why)), 'wiki 的 why 必须是词法语言');
  db.close();
});

test('wiki：同分结果顺序**稳定可复现**（连跑三次完全一致）', async () => {
  const { db, repo, facade } = fresh();
  const docId = seedDoc(repo, {
    title: '手册A',
    cards: [
      { name: '索引甲', one_line: '索引', quote: '索引', start: 10, end: 10, text: '索引 索引' },
      { name: '索引乙', one_line: '索引', quote: '索引', start: 20, end: 20, text: '索引 索引' },
      { name: '索引丙', one_line: '索引', quote: '索引', start: 30, end: 30, text: '索引 索引' },
    ],
  });
  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await facade.retrieve({ mode: 'wiki', query: '索引', userId: null, docId, limit: 10 });
    runs.push(r.items.map((x) => x.refId).join(','));
  }
  assert.equal(runs[0], runs[1], '排序必须稳定（否则测试会随机翻车）');
  assert.equal(runs[1], runs[2]);
  db.close();
});

test('★ wiki 相关性：必须**保持 FTS 顺序**，且分数单调非增（回归：曾经全是 0）', async () => {
  const { db, repo, facade } = fresh();
  // 只给「聚簇索引」高密度查询词 —— 它必须排在「索引条件下推」前面
  const docId = seedDoc(repo, {
    title: '手册A',
    cards: [
      { name: '索引条件下推', one_line: '无关', quote: '索引', start: 1, end: 1, text: '索引' },
      { name: '聚簇索引', one_line: '索引', quote: '索引 索引 索引 索引 索引 索引', start: 2, end: 2, text: '索引 索引 索引 索引 索引 索引 索引 索引' },
    ],
  });
  const res = await facade.retrieve({ mode: 'wiki', query: '索引', userId: null, docId, limit: 10 });
  assert.ok(res.items.length >= 2);

  // ★ 回归断言：分数**不能全是 0**。
  // 原错误写法 `score: hit.score`（来自 `search()` 的 `.toFixed(4)`）在本语料下
  // bm25 ≈ 1e-6 ⟹ 全部舍成 0 ⟹ 我随后的 `sort` 变成空操作，
  // 又按 id 兜底排序 ⟹ **把 FTS 算好的相关性顺序彻底打乱**（且不报错、看起来正常）。
  const scores = res.items.map((i) => i.score!);
  assert.ok(scores.some((s) => s > 0), `分数不许全为 0（实测 ${JSON.stringify(scores)}）`);
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(scores[i - 1]! >= scores[i]!, `分数必须单调非增：${JSON.stringify(scores)}`);
  }
  // 相关性顺序确实来自 FTS：更"密集"命中查询词的卡片排在前面
  assert.equal(res.items[0]!.title, '聚簇索引', 'FTS 顺序必须被保留（不许被兜底排序打乱）');
  db.close();
});

test('★ 组合检索用 RRF 秩融合（量纲不同的分数不许直接比较）', async () => {
  const { db, repo } = fresh();
  const docId = seedDoc(repo, {
    title: '手册A',
    cards: [{ name: '聚簇索引', one_line: 'x', quote: 'Clustered indexes', start: 3174, end: 3174, text: '聚簇索引正文。' }],
  });
  repo.replaceGraph(docId, [{ name: '聚簇索引', name_zh: '聚簇索引', type: 'mechanism', layer: 'L1' }, { name: 'B+tree', name_zh: 'B+树', type: 'mechanism', layer: 'L1' }], [
    { src: '聚簇索引', dst: 'B+tree', etype: 'IMPLEMENTS', evidence_text: 'implemented as B+tree', span: { kind: 'page', start: 2, end: 2 } },
  ]);
  const registry = createRegistry({ db, repo, edgeTypes: ['IMPLEMENTS'] });
  const res = await regRetrieve(registry, { mode: ['wiki', 'kg'], q: '聚簇索引', userId: null, docId, limit: 10 });

  assert.equal(res.mode, 'multi');
  assert.ok(res.items.length > 0);
  // RRF 分必须在 (0,1] 区间（kg 的原始分是 500+/1000+，不许泄漏到融合结果里）
  for (const it of res.items) {
    assert.ok(it.score! > 0 && it.score! <= 1, `RRF 分必须在 (0,1]：${it.title} = ${it.score}`);
  }
  // 分数单调非增
  const s = res.items.map((i) => i.score!);
  for (let i = 1; i < s.length; i += 1) assert.ok(s[i - 1]! >= s[i]!, 'RRF 结果必须单调非增');
  // 同一实体被两个模式同时命中 → why 里两个模式都要出现（对比教学的价值）
  const both = res.items.find((i) => (i.whys ?? []).some((w) => w.startsWith('[wiki]')) && (i.whys ?? []).some((w) => w.startsWith('[kg]')));
  assert.ok(both, '同时被 wiki 与 kg 命中的条目，why 要汇集两个来源');
  db.close();
});

test('wiki：healthCheck 真探测（能查 FTS 才算可用）', async () => {
  const { db, repo } = fresh();
  const r = new WikiRetriever({ db, repo });
  const h = await r.healthCheck();
  assert.equal(h.ok, true);
  assert.match(h.reason ?? '', /bigram FTS5 就绪/);
  db.close();
});

test('wiki：limit 生效且**不因丢弃而少给**（先过滤后截断）', async () => {
  const { db, repo, facade } = fresh();
  const docId = seedDoc(repo, {
    title: '手册A',
    cards: [
      { name: '索引一', one_line: '索引', quote: '索引', start: 1, end: 1, text: '索引' },
      { name: '索引二', one_line: '索引', quote: '索引', start: 2, end: 2, text: '索引' },
      { name: '索引三', one_line: '索引', quote: '索引', start: 3, end: 3, text: '索引' },
    ],
  });
  const res = await facade.retrieve({ mode: 'wiki', query: '索引', userId: null, docId, limit: 2 });
  assert.equal(res.items.length, 2, 'limit=2 必须给满 2 条（不许被丢弃挤掉）');
  db.close();
});

// ═══════════════════════════════════════════════════════════════════════
// ★ 跨用户隔离（负例测试）
// ═══════════════════════════════════════════════════════════════════════

test('跨用户隔离（负例）：A 用户检索不到 B 用户的私有资料', async () => {
  const { db, repo, facade } = fresh();
  const userA = makeUser(repo, 'alice');
  const userB = makeUser(repo, 'bob');

  // B 的私有草稿：只有 B 能看
  const docB = seedDoc(repo, {
    title: 'B的秘密手册',
    ownerId: userB,
    reviewStatus: 'draft',
    visibility: 'private',
    cards: [{ name: 'B的私有索引', one_line: 'secret', quote: 'secret quote', start: 5, end: 5, text: '索引 秘密内容' }],
  });

  // B 自己能检索到
  const asB = await facade.retrieve({ mode: 'wiki', query: '索引', userId: userB, docId: docB });
  assert.ok(asB.items.length > 0, 'B 必须能看到自己的文档');

  // ★ A 检索同一 docId：必须什么都拿不到（SQL 层过滤）
  const asA = await facade.retrieve({ mode: 'wiki', query: '索引', userId: userA, docId: docB });
  assert.deepEqual(asA.items, [], '★ A 不许看到 B 的私有文档内容');
  assert.match(asA.reason ?? '', /不可见|没有可见文档/, 'reason 要如实说明为何为空');

  // ★ 不限定 docId 时，A 的全局检索也不许出现 B 的卡片
  const globalA = await facade.retrieve({ mode: 'wiki', query: '索引', userId: userA });
  assert.ok(
    globalA.items.every((i) => !i.title.includes('B的私有索引')),
    '★ 全局检索同样不许泄露（这是最容易漏的一条路径）',
  );
  db.close();
});

test('跨用户隔离（负例）：kg 检索同样按 userId 过滤（第二个读取路径）', async () => {
  const { db, repo, facade } = fresh();
  const userA = makeUser(repo, 'alice');
  const userB = makeUser(repo, 'bob');

  const docB = repo.insertDocument({ title: 'B图谱', kind: 'pdf', source_path: 'p', page_count: 5, status: 'ready', ownerId: userB, reviewStatus: 'draft', visibility: 'private' });
  const unitIds = repo.replaceUnits(docB, [{ ord: 1, title: 'u', level: 1, parent_ord: null, span: { kind: 'page', start: 1, end: 5 }, text: '秘密' }]);
  repo.replaceCards(docB, [{ unit_id: unitIds[0] as string, name: 'B的秘密实体', kind: 'concept', one_line: 'x', evidence_quote: 'q', evidence_span: { kind: 'page', start: 5, end: 5 } }]);
  repo.replaceGraph(docB, [{ name: 'B的秘密实体', name_zh: 'B的秘密实体', type: 'mechanism', layer: 'L1' }, { name: '叶子页', name_zh: '叶子页', type: 'mechanism', layer: 'L1' }], [
    { src: 'B的秘密实体', dst: '叶子页', etype: 'PART_OF', evidence_text: 'part of', span: { kind: 'page', start: 5, end: 5 } },
  ]);

  const asA = await facade.retrieve({ mode: 'kg', query: 'B的秘密实体', userId: userA, docId: docB });
  assert.deepEqual(asA.items, [], '★ kg 是第二个读取路径，同样必须隔离（RBAC §6）');

  const asB = await facade.retrieve({ mode: 'kg', query: 'B的秘密实体', userId: userB, docId: docB });
  assert.ok(asB.items.length > 0, 'B 自己必须能检索到');
  db.close();
});

test('跨用户隔离（正例）：public + published 对匿名可见（不是"一律看不到"）', async () => {
  const { db, repo, facade } = fresh();
  const docId = seedDoc(repo, {
    title: '公开手册',
    reviewStatus: 'published',
    visibility: 'public',
    cards: [{ name: '公开索引概念', one_line: 'x', quote: 'Clustered indexes', start: 7, end: 7, text: '索引 公开内容' }],
  });
  const anon = await facade.retrieve({ mode: 'wiki', query: '索引', userId: null, docId });
  assert.ok(anon.items.length > 0, 'public+published 必须对匿名可见');
  assert.equal(anon.items[0]!.evidence?.start, 7);
  db.close();
});
