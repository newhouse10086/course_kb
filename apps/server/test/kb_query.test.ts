/**
 * 只读知识库查询（`store/kb-query.ts`）—— agent 工具 `kb_search`/`kb_get` 的能力边界。
 *
 * 覆盖 Lead 的验收项：
 * - **可见性过滤（硬要求）**：学生拿别人的 `ref_id` / 别人文档的搜索结果 → **拿不到**
 * - 未发布草稿即使 `visibility='public'` → 非管理员**拿不到**（RBAC §6 的 published 硬编码）
 * - 只读：导出里没有写/删入口（结构性断言）
 * - 截断**如实标注**（`truncated`）+ `snippet` ≤200
 * - 锚点（`evidence.span`）真的能回溯到卡片/单元的 span
 * - 检索**复用 bigram**（中文能命中；坑 15：unicode61 对中文 0 命中）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { indexDocument } from '../src/store/search.ts';
import { createKbQuery, clip, SNIPPET_MAX, TEXT_MAX, visibleDocIds } from '../src/store/kb-query.ts';

interface SeedOpts {
  title: string;
  ownerId?: string | null;
  reviewStatus?: 'draft' | 'published';
  visibility?: 'private' | 'public';
  text?: string;
  cards?: { name: string; one_line: string; quote: string; start: number; end: number; text: string }[];
}

function seedDoc(repo: Repo, opts: SeedOpts): { docId: string; cardIds: string[]; unitIds: string[] } {
  const docId = repo.insertDocument({
    title: opts.title,
    kind: 'pdf',
    source_path: `data/uploads/${opts.title}.pdf`,
    page_count: 50,
    status: 'ready',
    ownerId: opts.ownerId ?? null,
    reviewStatus: opts.reviewStatus ?? 'published',
    // ⚠️ 默认 **private**：`public + published` 按 RBAC §6 是**所有人可见**的（含匿名）——
    //    测"隔离"必须用 private，否则测的是"公开文档确实公开"（我第一版就写错了默认值）
    visibility: opts.visibility ?? 'private',
  });
  const cards = opts.cards ?? [];
  const unitIds = repo.replaceUnits(docId, [
    {
      ord: 1,
      title: `第 1 章 ${opts.title}`,
      level: 1,
      parent_ord: null,
      span: { kind: 'page', start: 1, end: 30 },
      text: opts.text ?? cards.map((c) => c.text).join(' '),
    },
  ]) as string[];
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
  const cardIds = repo.listCards(docId, { limit: 50 }).cards.map((c) => c.id);
  return { docId, cardIds, unitIds };
}

function fresh() {
  const db = Db.open(':memory:');
  const repo = new Repo(db);
  return { db, repo, kb: createKbQuery({ db, repo }) };
}

/** 建用户（外键开着，`documents.owner_id` 引用 users → **必须先建行**，否则 SQLITE_CONSTRAINT_FOREIGNKEY）。 */
function makeUser(repo: Repo, name: string, roles: string[] = ['student']): string {
  return repo.rbac.createUser({ username: name, displayName: name, passwordHash: 'x', roles });
}

/** 常用四个身份（测试里反复用；`usr_admin` 是管理员用于对照）。 */
function seedUsers(repo: Repo): { alice: string; bob: string; tea: string; stu: string } {
  return {
    alice: makeUser(repo, 'alice'),
    bob: makeUser(repo, 'bob'),
    tea: makeUser(repo, 'tea', ['teacher']),
    stu: makeUser(repo, 'stu'),
  };
}

const CARD = {
  name: 'B+ 树索引',
  one_line: 'B+ 树把数据按序组织，使范围查询与等值查询都能走索引。',
  quote: '索引是一种数据结构，用于加速数据检索。',
  start: 12,
  end: 14,
  text: '索引 是数据库为了加速检索而建立的数据结构；B+ 树索引把键按序存放，因此范围查询也很高效。',
};

test('★ 可见性：学生**看不到**别人文档的搜索结果与卡片（agent 工具不能成为绕过 RBAC 的后门）', () => {
  const { repo, kb } = fresh();
  const u = seedUsers(repo);
  const alice = seedDoc(repo, { title: 'alice 私有讲义', ownerId: u.alice, cards: [CARD] });
  const bob = seedDoc(repo, { title: 'bob 私有讲义', ownerId: u.bob, cards: [{ ...CARD, name: '哈希索引', text: '索引 哈希索引 适合等值查询。' }] });

  // ① alice 自己的：**能搜到、能取到**（否则过滤把合法内容也挡了）
  const aliceHits = kb.search({ userId: u.alice, query: '索引' });
  assert.ok(aliceHits.length > 0, '本人文档必须能搜到（过滤不能把合法内容也挡掉）');
  assert.ok(
    aliceHits.every((h) => h.doc_id === alice.docId),
    `★ 结果里不许出现别人的文档：${JSON.stringify(aliceHits.map((h) => h.doc_id))}`,
  );
  const own = kb.get({ userId: u.alice, refId: alice.cardIds[0] as string });
  assert.ok(own, '本人卡片必须能取到');
  assert.equal(own.kind, 'card');
  assert.equal(own.title, CARD.name);
  assert.ok(own.text.includes('B+ 树'), '正文必须是真的卡片正文');
  assert.deepEqual(own.evidence?.span, { kind: 'page', start: 12, end: 14 }, '★ 锚点必须可回溯到卡片 span');
  assert.equal(own.evidence?.quote, CARD.quote);

  // ② ★ 负例：bob 拿 alice 的 ref_id → **拿不到**（当作不存在，不是"无权"）
  assert.equal(
    kb.get({ userId: u.bob, refId: alice.cardIds[0] as string }),
    null,
    '★ 学生拿别人的 ref_id 必须拿不到',
  );
  // ③ ★ 负例：bob 的搜索里**不许**出现 alice 的文档
  const bobHits = kb.search({ userId: u.bob, query: '索引' });
  assert.ok(
    bobHits.every((h) => h.doc_id === bob.docId),
    `★ 搜索结果不许串到别人的文档：${JSON.stringify(bobHits.map((h) => h.doc_id))}`,
  );
  // ④ 可见文档集合本身也要对
  assert.deepEqual([...visibleDocIds(repo.db, u.bob)].sort(), [bob.docId]);

  // ⑤ 对照：`public + published` 的文档按 RBAC §6 是**所有人可见**的
  //    （证明过滤不是"一律拒绝"—— 隔离只对 private/draft 生效）
  const pub = seedDoc(repo, {
    title: '公开讲义',
    ownerId: u.tea,
    visibility: 'public',
    reviewStatus: 'published',
    cards: [{ ...CARD, name: '公开卡片', text: '索引 公开内容。' }],
  });
  assert.ok(
    kb.get({ userId: u.bob, refId: pub.cardIds[0] as string }),
    '★ public+published 必须对所有人可见（否则过滤把合法内容也挡了）',
  );
  assert.ok(
    kb.search({ userId: u.bob, query: '索引' }).some((h) => h.doc_id === pub.docId),
    '★ 公开文档必须能搜到',
  );
});

test('★ 未发布草稿：即使 visibility=public，非管理员也拿不到（published 硬编码）', () => {
  const { repo, kb } = fresh();
  const u = seedUsers(repo);
  const draft = seedDoc(repo, { title: '未发布草稿', ownerId: u.tea, reviewStatus: 'draft', visibility: 'public', cards: [CARD] });
  // 非 owner 的学生：public 但 draft → 不可见
  assert.equal(kb.get({ userId: u.stu, refId: draft.cardIds[0] as string }), null, '★ 草稿不许被非管理员读到');
  assert.deepEqual(kb.search({ userId: u.stu, query: '索引' }), [], '★ 草稿也不许出现在搜索结果里');
  // owner 自己可见（自己的草稿）
  assert.ok(kb.get({ userId: u.tea, refId: draft.cardIds[0] as string }), '本人自己的草稿应可见');
  // 发布后就可见了（证明过滤不是"一律拒绝"）
  repo.setReviewStatus(draft.docId, 'published', null);
  assert.ok(kb.get({ userId: u.stu, refId: draft.cardIds[0] as string }), '发布后学生应能读到');
});

test('截断如实标注：snippet ≤200、超长正文 truncated=true（不静默截断）', () => {
  const { repo, kb } = fresh();
  const u = seedUsers(repo);
  const long = '索引'.repeat(3000); // 6000 字
  // ⚠️ 长正文在**单元**上（卡片是结构化字段：one_line/purpose/…，本身不会很长）
  const doc = seedDoc(repo, { title: '超长文档', ownerId: u.alice, text: long, cards: [CARD] });
  const hits = kb.search({ userId: u.alice, query: '索引' });
  assert.ok(hits.length > 0);
  for (const h of hits) assert.ok(h.snippet.length <= SNIPPET_MAX, `snippet 必须 ≤${SNIPPET_MAX}，实际 ${h.snippet.length}`);

  const unit = kb.get({ userId: u.alice, refId: doc.unitIds[0] as string });
  assert.ok(unit);
  assert.equal(unit.truncated, true, '★ 超长必须如实标 truncated（否则模型会把截断当全文）');
  assert.ok(unit.text.length <= TEXT_MAX + 1, `text 应 ≤${TEXT_MAX}+省略号，实际 ${unit.text.length}`);
  assert.ok(unit.text.endsWith('…'), '截断要有可见标记');

  // 卡片（结构化字段拼起来）没超长 → **不许**谎报 truncated
  const card = kb.get({ userId: u.alice, refId: doc.cardIds[0] as string });
  assert.ok(card);
  assert.equal(card.truncated, false, '没超长就不许标 truncated（如实 = 两个方向都要准）');

  // 纯函数：边界（刚好等于上限 → 不截断）
  assert.deepEqual(clip('x'.repeat(10), 10), { text: 'x'.repeat(10), truncated: false });
  assert.deepEqual(clip('x'.repeat(11), 10), { text: `${'x'.repeat(10)}…`, truncated: true });
});

test('单元也能查：kb_get 取单元正文 + span 锚点；kb_search 同时覆盖 card/unit', () => {
  const { repo, kb } = fresh();
  const u = seedUsers(repo);
  const doc = seedDoc(repo, { title: '含单元文档', ownerId: u.alice, text: '索引 优化 单元正文示例', cards: [CARD] });
  const unit = kb.get({ userId: u.alice, refId: doc.unitIds[0] as string });
  assert.ok(unit, '单元必须能取到');
  assert.equal(unit.kind, 'unit');
  assert.ok(unit.text.includes('单元正文示例'));
  assert.deepEqual(unit.evidence?.span, { kind: 'page', start: 1, end: 30 }, '单元锚点 = 它的 span');
  const kinds = new Set(kb.search({ userId: u.alice, query: '索引' }).map((h) => h.kind));
  assert.ok(kinds.has('card'), 'search 必须覆盖卡片');
});

test('边界与只读：空 query/未知 ref/空库 → 空结果（不报错）；导出里**没有写入口**', () => {
  const { repo, kb } = fresh();
  const u = seedUsers(repo);
  seedDoc(repo, { title: '文档', ownerId: u.alice, cards: [CARD] });
  assert.deepEqual(kb.search({ userId: u.alice, query: '   ' }), [], '空 query → 空结果');
  assert.equal(kb.get({ userId: u.alice, refId: 'crd_不存在' }), null, '未知 ref → null');
  assert.equal(kb.get({ userId: u.alice, refId: '' }), null, '空 ref → null');
  assert.deepEqual(kb.search({ userId: 'usr_没人', query: '索引' }), [], '无可见文档 → 空结果');
  // ★ 结构性：门面只有两个方法（能力边界 = 这个模块的导出，不给写/删/执行 SQL 的入口）
  assert.deepEqual(Object.keys(kb).sort(), ['get', 'search']);
  // limit 上限生效
  const many = kb.search({ userId: u.alice, query: '索引', limit: 999 });
  assert.ok(many.length <= 20, 'limit 必须被夹到上限（20）');
});
