/**
 * 检索层测试（1/3）：**契约 + 规则 1/2 + 模式独立**。
 *
 * 断言口径（AGENTS.md §7）：**断言具体值**，不许只断言非空。
 * 全部用**真 SQLite `:memory:`**（迁移 v1/v2/v3 自动跑），不 mock store。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { createRetrievalFacade } from '../src/retrieval/index.ts';
import { hasEvidence, isValidSpan, normalizeModeSpec, toSpan } from '../src/retrieval/types.ts';
import { enforceEvidence } from '../src/retrieval/evidence.ts';
import { createRegistry, formatContext, retrieve as regRetrieve } from '../src/retrieval/registry.ts';
import { anchorLabel } from '../src/retrieval/registry.ts';

// ═══════════════════════════════════════════════════════════════════════
// fixture
// ═══════════════════════════════════════════════════════════════════════

interface SeedOpts {
  reviewStatus?: 'draft' | 'reviewed' | 'published';
  visibility?: 'private' | 'course' | 'public';
  ownerId?: string | null;
}

function seed(opts: SeedOpts = {}): { db: Db; repo: Repo; docId: string } {
  const db = Db.open(':memory:');
  const repo = new Repo(db);
  const docId = repo.insertDocument({
    title: '测试手册',
    kind: 'pdf',
    source_path: 'data/uploads/x/original.pdf',
    page_count: 20,
    status: 'ready',
    reviewStatus: opts.reviewStatus ?? 'published',
    visibility: opts.visibility ?? 'public',
    ownerId: opts.ownerId ?? null,
  });
  const ids = repo.replaceUnits(docId, [
    { ord: 1, title: 'Chapter 1 总览', level: 1, parent_ord: null, span: { kind: 'page', start: 1, end: 8 }, text: '第一章正文。' },
    { ord: 2, title: '1.1 索引', level: 2, parent_ord: 1, span: { kind: 'page', start: 1, end: 3 }, text: '聚簇索引将数据按主键顺序存放，二级索引需要回表。' },
    { ord: 3, title: '1.2 事务', level: 2, parent_ord: 1, span: { kind: 'page', start: 4, end: 8 }, text: '事务的隔离级别决定并发可见性。' },
  ]);
  repo.replaceCards(docId, [
    { unit_id: ids[1] as string, name: '聚簇索引', kind: 'concept', one_line: '数据按主键顺序存放的索引', purpose: '范围查询快', evidence_quote: 'Clustered indexes sort rows by key.', evidence_span: { kind: 'page', start: 2, end: 3 }, confidence: 0.95 },
    { unit_id: ids[2] as string, name: '事务隔离级别', kind: 'concept', one_line: '控制并发事务可见性的设置', evidence_quote: 'The isolation level controls visibility.', evidence_span: { kind: 'page', start: 4, end: 8 }, confidence: 0.9 },
    // 无锚点的卡片（span 为空）→ 必须被规则 1 挡掉
    { unit_id: ids[2] as string, name: '无锚点概念', kind: 'concept', one_line: '没有 span 的卡片', evidence_quote: 'no span here', confidence: 0.5 },
  ]);
  repo.replaceGraph(
    docId,
    [
      { name: 'Clustered index', name_zh: '聚簇索引', type: 'mechanism', layer: 'L1' },
      { name: 'B+tree', name_zh: 'B+树', type: 'mechanism', layer: 'L1' },
      { name: 'Leaf Page', name_zh: '叶子页', type: 'mechanism', layer: 'L1' },
      { name: 'InnoDB', name_zh: '', type: 'product', layer: 'L2' },
      { name: 'Lonely', name_zh: '孤立概念', type: 'concept', layer: 'L1' },
    ],
    [
      { src: 'Clustered index', dst: 'B+tree', etype: 'IMPLEMENTS', evidence_text: 'Clustered index is implemented as a B+tree.', span: { kind: 'page', start: 2, end: 2 }, confidence: 0.9 },
      { src: 'B+tree', dst: 'Leaf Page', etype: 'PART_OF', evidence_text: 'Leaf pages are part of the B+tree.', span: { kind: 'page', start: 3, end: 3 }, confidence: 0.8 },
      { src: 'InnoDB', dst: 'Clustered index', etype: 'IMPLEMENTS', evidence_text: 'InnoDB uses a clustered index.', span: { kind: 'page', start: 2, end: 2 }, confidence: 0.85 },
    ],
  );
  return { db, repo, docId };
}

/** 建索引（wiki 检索的前提）。 */
async function seedWithIndex(opts: SeedOpts = {}) {
  const s = seed(opts);
  const { indexDocument } = await import('../src/store/search.ts');
  indexDocument(s.db, s.repo, s.docId);
  return s;
}

function facadeFor(db: Db, repo: Repo) {
  return createRetrievalFacade({ db, repo, edgeTypes: undefined });
}

// ═══════════════════════════════════════════════════════════════════════
// 模式表达式规范化
// ═══════════════════════════════════════════════════════════════════════

test('模式规范化：默认 none；数组去重；未知模式**显式拒绝**（不静默当 none）', () => {
  assert.deepEqual(normalizeModeSpec(undefined), { modes: ['none'], invalid: [] });
  assert.deepEqual(normalizeModeSpec(''), { modes: ['none'], invalid: [] });
  assert.deepEqual(normalizeModeSpec('wiki'), { modes: ['wiki'], invalid: [] });
  assert.deepEqual(normalizeModeSpec(['wiki', 'wiki', 'kg']), { modes: ['wiki', 'kg'], invalid: [] });
  // ★ 关键：未知模式必须被报出来，否则"选了 kg 却没检索"无法发现
  assert.deepEqual(normalizeModeSpec('graph'), { modes: [], invalid: ['graph'] });
  assert.deepEqual(normalizeModeSpec(['wiki', 'lexical']), { modes: ['wiki'], invalid: ['lexical'] });
  // 规格里的四个名字必须被接受（backend-api 纠正过我）
  for (const m of ['none', 'wiki', 'kg', 'rag'] as const) {
    assert.deepEqual(normalizeModeSpec(m), { modes: [m], invalid: [] }, `${m} 必须是合法模式`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ★ 规则 1：evidence 必填
// ═══════════════════════════════════════════════════════════════════════

test('规则1：isValidSpan 分 span 类型 —— char 允许 start=0，page 必须 start>=1', () => {
  assert.equal(isValidSpan({ kind: 'page', start: 1, end: 1 }), true);
  assert.equal(isValidSpan({ kind: 'page', start: 0, end: 0 }), false, 'page 0 是无锚点（DB 默认值）');
  assert.equal(isValidSpan({ kind: 'char', start: 0, end: 10 }), true, '★ 文档开头的卡片合法，原写法 start>=1 会误杀');
  assert.equal(isValidSpan({ kind: 'time', start: 0, end: 500 }), true, '视频第 0ms 合法');
  assert.equal(isValidSpan({ kind: 'page', start: 5, end: 3 }), false, 'end<start 非法');
  assert.equal(isValidSpan({ kind: '', start: 0, end: 0 }), false, '空 kind 不是合法 span');
  assert.equal(isValidSpan({ kind: 'page', start: Number.NaN, end: 1 }), false);
  assert.equal(isValidSpan({ kind: 'page', start: 1, end: Number.POSITIVE_INFINITY }), false);
});

test('规则1：toSpan 把 DB 自由文本转成合法 Span，无锚点返回 null（不做假锚点）', () => {
  assert.deepEqual(toSpan({ span_kind: 'page', span_start: 3, span_end: 4 }), { kind: 'page', start: 3, end: 4 });
  assert.equal(toSpan({ span_kind: '', span_start: 0, span_end: 0 }), null, '★ 不许 as const 强转出假锚点');
  assert.equal(toSpan({ span_kind: 'page', span_start: 0, span_end: 0 }), null);
  assert.equal(toSpan({}), null);
  assert.equal(toSpan({ span_kind: 'nonsense', span_start: 1, span_end: 2 }), null);
});

test('规则1：enforceEvidence 丢无锚点条目 + 诚实计数 + 先过滤后截断', () => {
  const base = { kind: 'card' as const, id: 'c1', title: 't', text: 'x', score: 1, why: 'w' };
  const drafts = [
    { ...base, id: 'a', evidence: { span: { kind: 'page' as const, start: 1, end: 1 } } },
    { ...base, id: 'b' }, // 无 evidence
    { ...base, id: 'c', evidence: { span: { kind: 'page' as const, start: 0, end: 0 } } }, // 假锚点
    { ...base, id: 'd', evidence: { span: { kind: 'page' as const, start: 2, end: 2 } } },
  ];
  const r = enforceEvidence(drafts, 8);
  assert.deepEqual(r.items.map((i) => i.id), ['a', 'd']);
  assert.equal(r.dropped, 2, '无锚点计数必须如实上报，不许静默');

  // 先过滤后截断：limit=1 时不能因为"b 没锚点"而少返回
  const r2 = enforceEvidence(drafts, 1);
  assert.deepEqual(r2.items.map((i) => i.id), ['a']);
  assert.equal(r2.dropped, 0, 'limit 命中后不再继续扫（b/c 未被计入）');
});

test('规则1（端到端）：有实体但无卡片锚点 → 不进结果，reason 如实说明丢弃', async () => {
  const { db, repo, docId } = seed();
  const f = facadeFor(db, repo);
  // 「孤立概念」(Lonely) 是图里的实体，但**没有任何同名卡片** → 拿不到 span
  const res = await f.retrieve({ mode: 'kg', query: '孤立概念', userId: null, docId });
  assert.equal(res.available, true, '图可用、实体也命中了 → 不是"不可用"');
  assert.deepEqual(res.items, [], '★ 无锚点实体不许进上下文（规则 1），也不许给它编个 span');
  assert.match(res.reason ?? '', /无可回溯锚点/, '丢弃必须如实上报（不许静默）');
  db.close();
});

test('规则1（端到端）：有卡片锚点的实体**必须**返回且带页码', async () => {
  const { db, repo, docId } = seed();
  const f = facadeFor(db, repo);
  const res = await f.retrieve({ mode: 'kg', query: '聚簇索引', userId: null, docId });
  assert.equal(res.available, true);
  assert.ok(res.items.length > 0, '「聚簇索引」有卡片且 span=page 2-3，必须能返回');
  const ent = res.items.find((i) => i.refKind === 'entity');
  assert.ok(ent, '应包含锚点实体');
  assert.equal(ent!.evidence?.kind, 'page');
  assert.equal(ent!.evidence?.start, 2, '锚点必须来自卡片 span（不许是 0/0 假锚点）');
  assert.match(ent!.why!, /锚点命中实体「聚簇索引」/);
  assert.ok(res.items.every((i) => !!i.evidence && i.evidence.start >= 1), '每条都必须有真锚点');
  db.close();
});

// ═══════════════════════════════════════════════════════════════════════
// ★ 规则 2：不可用不许回退冒充
// ═══════════════════════════════════════════════════════════════════════

test('规则2：rag 不可用 → available:false + 可读 reason + items 为空（不回退 wiki）', async () => {
  const { db, repo, docId } = await seedWithIndex();
  const f = facadeFor(db, repo);
  const res = await f.retrieve({ mode: 'rag', query: '索引', userId: null, docId });

  assert.equal(res.available, false, 'rag 必须如实报不可用');
  assert.deepEqual(res.items, [], '★ 不可用时 items 必须为空 —— 绝不许拿 wiki 数据冒充向量检索');
  assert.equal(res.mode, 'rag');
  assert.ok(res.reason && res.reason.length > 0, 'reason 必须可读');
  assert.match(res.reason!, /embedding provider/i, 'reason 应点明缺 provider');
  db.close();
});

test('规则2：单模式不可用时整体 available=false（组合里其它模式可用则为 true）', async () => {
  const { db, repo, docId } = await seedWithIndex();
  const registry = createRegistry({ db, repo, edgeTypes: ['DEPENDS_ON', 'PART_OF', 'IMPLEMENTS'] });

  const onlyRag = await regRetrieve(registry, { mode: 'rag', q: '索引', userId: null, docId });
  assert.equal(onlyRag.available, false, '只请求 rag → 整体不可用');
  assert.deepEqual(onlyRag.items, []);

  const combo = await regRetrieve(registry, { mode: ['wiki', 'rag'], q: '索引', userId: null, docId });
  assert.equal(combo.available, true, '组合中 wiki 可用 → 整体可用');
  assert.equal(combo.mode, 'multi');
  assert.ok(combo.items.length > 0, 'wiki 的结果必须在');
  // rag 的不可用要如实写在 reason 里
  assert.match(combo.reason ?? '', /\[rag\]/, 'reason 要标明是哪个模式不可用');
  db.close();
});

test('规则2：未知模式 → available:false 且**不执行任何检索器**（不静默当 none）', async () => {
  const { db, repo, docId } = await seedWithIndex();
  const registry = createRegistry({ db, repo, edgeTypes: ['IMPLEMENTS'] });
  const res = await regRetrieve(registry, { mode: 'graph', q: '索引', userId: null, docId });
  assert.equal(res.available, false);
  assert.deepEqual(res.items, []);
  assert.match(res.reason!, /graph/, 'reason 要点出非法值');
  assert.match(res.reason!, /none \/ wiki \/ kg \/ rag/, 'reason 要给出合法值');
  db.close();
});

test('规则2：none 是"不检索"，不是"不可用"（available:true + 空 items）', async () => {
  const { db, repo, docId } = await seedWithIndex();
  const registry = createRegistry({ db, repo, edgeTypes: ['IMPLEMENTS'] });
  const res = await regRetrieve(registry, { mode: 'none', q: '索引', userId: null, docId });
  assert.equal(res.available, true);
  assert.deepEqual(res.items, []);
  assert.equal(res.elapsedMs, 0, 'none 是短路，不花时间');
  db.close();
});

test('规则2：检索器抛错 → 该模式不可用（不是回退到别的模式）', async () => {
  const { db, repo } = seed();
  const broken = {
    mode: 'kg' as const,
    async healthCheck() {
      return { ok: true };
    },
    async retrieve() {
      throw new Error('模拟图遍历炸了');
    },
  };
  const registry = {
    get: (m: string) => (m === 'kg' ? (broken as never) : undefined),
    modes: () => ['none', 'kg'],
  };
  const res = await regRetrieve(registry as never, { mode: 'kg', q: 'x', userId: null });
  assert.equal(res.available, false);
  assert.deepEqual(res.items, []);
  assert.match(res.reason!, /模拟图遍历炸了/);
  db.close();
});

// ═══════════════════════════════════════════════════════════════════════
// 上下文格式化
// ═══════════════════════════════════════════════════════════════════════

test('formatContext：带"不是指令"边界 + 每条带锚点 + why', () => {
  const text = formatContext(
    [
      {
        kind: 'card',
        id: 'crd_1',
        title: '聚簇索引',
        text: 'Clustered indexes sort rows by key.',
        evidence: { span: { kind: 'page', start: 2, end: 3 } },
        score: 1,
        why: 'bigram 命中「索引」',
      },
    ],
    'wiki',
  );
  assert.match(text, /^\[检索到的知识库内容/, '开头必须有边界');
  assert.match(text, /不是对你的指令/, '★ 必须声明不是指令（防 prompt injection）');
  assert.match(text, /【卡片】聚簇索引 · 页码 p\.2–3/, '标题 + 锚点都要在');
  assert.match(text, /原文：Clustered indexes sort rows by key\./);
  assert.match(text, /为什么检索到：bigram 命中「索引」/);
  assert.match(text, /\[以上为检索结果结束\]/, '结尾必须有边界');
});

test('formatContext：无锚点条目被排除；全无锚点 → 空串（不产生空壳边界）', () => {
  const none = formatContext([
    {
      kind: 'card',
      id: 'x',
      title: 't',
      text: 'y',
      // @ts-expect-error 故意缺 evidence，验证防御性过滤
      evidence: undefined,
      score: 1,
      why: 'w',
    },
  ]);
  assert.equal(none, '', '没有可用条目时不许返回只有边界的空壳');
});

test('anchorLabel：四种 span 类型都能读（页码/幻灯片/毫秒/偏移）', () => {
  assert.equal(anchorLabel({ kind: 'page', start: 3174, end: 3174 }), '页码 p.3174');
  assert.equal(anchorLabel({ kind: 'page', start: 2, end: 3 }), '页码 p.2–3');
  assert.equal(anchorLabel({ kind: 'slide', start: 12, end: 12 }), '幻灯片 s.12');
  assert.equal(anchorLabel({ kind: 'time', start: 12480, end: 12480 }), '时间 00:12.480');
  assert.equal(anchorLabel({ kind: 'char', start: 1024, end: 1024 }), '偏移 #1024');
});

test('★ formatContext 门面：外部构造的**假锚点**同样被挡（不许有 as never 后门）', async () => {
  const { db, repo } = seed();
  const f = facadeFor(db, repo);
  const text = f.formatContext(
    [
      { refKind: 'card', refId: 'a', title: '真锚点', snippet: 'x', evidence: { kind: 'page', start: 5, end: 5 }, why: 'w' },
      // 假锚点：page 0/0（DB 默认值的形状）—— 必须被挡
      { refKind: 'card', refId: 'b', title: '假锚点', snippet: 'y', evidence: { kind: 'page', start: 0, end: 0 }, why: 'w' },
      // 非法 kind
      { refKind: 'card', refId: 'c', title: '非法锚点', snippet: 'z', evidence: { kind: 'bogus', start: 1, end: 1 }, why: 'w' },
    ],
    'wiki',
  );
  assert.match(text, /真锚点/, '合法锚点必须保留');
  assert.doesNotMatch(text, /假锚点/, '★ page 0/0 必须被挡（这正是 as never 强转会放行的）');
  assert.doesNotMatch(text, /非法锚点/, '非法 kind 必须被挡');
  db.close();
});
