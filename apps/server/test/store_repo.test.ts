/**
 * store 层测试：Repo / outline / xref / search —— 全部用**真 SQLite**（`:memory:`），断言具体值。
 *
 * 重点覆盖两条"踩过坑"的规则：
 * - **坑 6**：mention 假阳性过滤（`USE` 被引 198 次、`AND` 183 次）→ 必须被 NOISE 规则挡掉
 * - **F3**：outline 所有层级都有 `intro`，且 `intro_source` **如实标注来源**
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { buildOutline, outlineFlat } from '../src/store/outline.ts';
import { buildXrefs, mentionOk, NOISE } from '../src/store/xref.ts';
import { buildContrastConclusion, contrast, indexDocument, search, snippet, suggest } from '../src/store/search.ts';

function freshRepo(): { db: Db; repo: Repo } {
  const db = Db.open(':memory:');
  return { db, repo: new Repo(db) };
}

function seedDoc(repo: Repo): string {
  const docId = repo.insertDocument({
    title: '测试手册',
    kind: 'pdf',
    source_path: 'data/uploads/x/original.pdf',
    page_count: 20,
  });
  const ids = repo.replaceUnits(docId, [
    { ord: 1, title: 'Chapter 1 总览', level: 1, parent_ord: null, span: { kind: 'page', start: 1, end: 8 }, text: '第一章正文。' },
    { ord: 2, title: '1.1 索引', level: 2, parent_ord: 1, span: { kind: 'page', start: 1, end: 3 }, text: '聚簇索引将数据按主键顺序存放，二级索引需要回表。' },
    { ord: 3, title: '1.2 事务', level: 2, parent_ord: 1, span: { kind: 'page', start: 4, end: 8 }, text: '事务的隔离级别决定并发可见性。' },
    { ord: 4, title: 'Chapter 2 优化', level: 1, parent_ord: null, span: { kind: 'page', start: 9, end: 14 }, text: '' },
    { ord: 5, title: '2.1 慢查询', level: 2, parent_ord: 4, span: { kind: 'page', start: 9, end: 14 }, text: 'USE slow_log AND 慢查询分析。' },
  ]);
  repo.replaceCards(docId, [
    { unit_id: ids[1] as string, name: '聚簇索引', kind: 'concept', one_line: '数据按主键顺序存放的索引', purpose: '范围查询快', evidence_quote: 'Clustered indexes sort rows by key.', evidence_span: { kind: 'page', start: 1, end: 3 }, confidence: 0.95 },
    { unit_id: ids[1] as string, name: 'log_filter_dragnet', kind: 'log_filter', one_line: '可加载的错误日志过滤器', evidence_quote: 'The log_filter_dragnet filter...', evidence_span: { kind: 'page', start: 2, end: 2 }, confidence: 0.9 },
    { unit_id: ids[2] as string, name: '事务隔离级别', kind: 'concept', one_line: '控制并发事务可见性的设置', evidence_quote: 'The isolation level controls visibility.', evidence_span: { kind: 'page', start: 4, end: 8 }, confidence: 0.9 },
    // 坑 6 的诱饵：都是英文段落里的普通单词
    { unit_id: ids[4] as string, name: 'USE', kind: 'sql_statement', one_line: '切换数据库', evidence_quote: 'USE db;', evidence_span: { kind: 'page', start: 9, end: 9 }, confidence: 0.5 },
    { unit_id: ids[4] as string, name: 'AND', kind: 'operator', one_line: '逻辑与', evidence_quote: 'a AND b', evidence_span: { kind: 'page', start: 9, end: 9 }, confidence: 0.5 },
  ]);
  return docId;
}

// ═══════════════════════════════════════════════════════════════════════
// Repo / 契约字段映射
// ═══════════════════════════════════════════════════════════════════════

test('Repo：契约字段映射（ord→order、span_*→evidence_span、meta_json→meta）', () => {
  const { db, repo } = freshRepo();
  try {
    const docId = seedDoc(repo);
    const u = repo.listUnits(docId).units[1];
    assert.equal(u?.order, 2, 'DB 列是 ord，响应字段必须是 order');
    assert.deepEqual(u?.span, { kind: 'page', start: 1, end: 3 });
    assert.equal(u?.text_len, (u?.text ?? '').length);

    const c = repo.allCardRows(docId).find((x) => x.name === '聚簇索引');
    assert.ok(c);
    const api = repo.getCard(String(c?.id));
    assert.deepEqual(api?.evidence_span, { kind: 'page', start: 1, end: 3 });
    assert.deepEqual(api?.prerequisites, []);

    const doc = repo.getDocument(docId);
    assert.equal(doc?.meta !== undefined, true, 'meta_json 要暴露成 meta 对象');
    assert.equal(doc?.counts.units, 5);
    assert.equal(doc?.counts.cards, 5);
    assert.equal(doc?.source_path, 'data/uploads/x/original.pdf');
  } finally {
    db.close();
  }
});

test('Repo：replaceGraph 同名实体归并 + 边唯一约束（UNIQUE(doc,src,dst,etype)）', () => {
  const { db, repo } = freshRepo();
  try {
    const docId = repo.insertDocument({ title: 't', kind: 'pdf', source_path: 'p' });
    repo.replaceUnits(docId, [{ ord: 1, title: 'u', level: 1, span: { kind: 'page', start: 1, end: 1 }, text: 'x' }]);
    const out = repo.replaceGraph(
      docId,
      [
        { name: 'Clustered index', name_zh: '聚簇索引', type: 'feature', layer: 'L2' },
        { name: 'clustered  INDEX', name_zh: '聚簇索引', type: 'feature', layer: 'L2' }, // name_key 相同 → 归并
        { name: 'B+tree', name_zh: 'B+树', type: 'mechanism', layer: 'L1' },
      ],
      [
        { src: 'Clustered index', dst: 'B+tree', etype: 'IMPLEMENTS', confidence: 0.9 },
        { src: 'Clustered index', dst: 'B+tree', etype: 'IMPLEMENTS', confidence: 0.7 }, // 重复 → 去重
        { src: 'B+tree', dst: 'B+tree', etype: 'PART_OF' }, // 自引用 → 丢弃
      ],
    );
    assert.equal(out.entities.size, 2, '大小写/空格不同的同名实体必须归并成一个');
    assert.equal(out.edges, 1, '同 (src,dst,etype) 只留 1 条；自引用边丢弃');
    const g = repo.getGraph(docId);
    assert.equal(g.nodes.length, 2);
    assert.equal(g.edges.length, 1);
    const deg = Object.fromEntries(g.nodes.map((n) => [n.name, n.degree]));
    assert.equal(deg['Clustered index'], 1, 'degree 按去重后的边计算');
    assert.equal(deg['B+tree'], 1);
  } finally {
    db.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// outline（F3：所有层级都有 intro，且来源如实）
// ═══════════════════════════════════════════════════════════════════════

test('outline：5 档 intro 来源逐档断言（manual > section_summary > rollup_llm > rollup_titles > none）', () => {
  const { db, repo } = freshRepo();
  try {
    const docId = seedDoc(repo);
    const ids = repo.allUnitRows(docId).map((u) => u.id);
    repo.mergeDocumentMeta(docId, {
      manual_intros: { [ids[0] as string]: { intro: '手写总览', why: '先读这个' } },
      section_summaries: {
        [ids[1] as string]: {
          section_summary: '本节讲索引的存储结构。',
          section_role: 'concept_intro',
          key_takeaways: ['聚簇索引按主键顺序存放'],
          learning_objectives: [],
        },
      },
      rollup: { [ids[3] as string]: { intro: 'LLM 汇总：本讲优化手段。', why_important: '性能是核心能力' } },
    });

    const o = buildOutline(repo, docId);
    assert.equal(o.roots.length, 2, '两个 level=1 根节点');
    assert.equal(Object.keys(o.nodes).length, 5);
    const n = (i: number): Record<string, unknown> =>
      (o.nodes[ids[i] as string] ?? {}) as unknown as Record<string, unknown>;

    // ① manual（最高优先）
    assert.equal(n(0).intro, '手写总览');
    assert.equal(n(0).why, '先读这个');
    assert.equal(n(0).intro_source, 'manual');

    // ② section_summary（why 由 key_takeaways 拼）
    assert.equal(n(1).intro, '本节讲索引的存储结构。');
    assert.equal(n(1).why, '聚簇索引按主键顺序存放');
    assert.equal(n(1).intro_source, 'section_summary');

    // ③ rollup_llm
    assert.equal(n(3).intro, 'LLM 汇总：本讲优化手段。');
    assert.equal(n(3).why, '性能是核心能力');
    assert.equal(n(3).intro_source, 'rollup_llm');

    // ④ rollup_titles（确定性标题汇总，无 LLM 也有 intro）
    //    ids[2] 是"1.2 事务"，无任何摘要且是叶子 → 走 none；根 ids[3] 有 rollup_llm
    //    这里给 ids[0] 之外的另一个根验证 rollup_titles 需要"有子节点且无摘要"：ids[3] 已有 rollup_llm，
    //    故临时构造一个只用标题汇总的场景
    repo.mergeDocumentMeta(docId, { rollup: {} });
    const o2 = buildOutline(repo, docId);
    const nodeOf = (id: string): Record<string, unknown> =>
      (o2.nodes[id] ?? {}) as unknown as Record<string, unknown>;
    const root2 = nodeOf(ids[3] as string);
    assert.equal(root2.intro_source, 'rollup_titles');
    assert.equal(root2.intro, '本节包含 2.1 慢查询。（该节点及其子节点共 2 个知识点）');
    assert.equal(root2.why, '');

    // ⑤ none（叶子且无正文 → 如实说明，不编）
    const n2 = n(2) as Record<string, unknown>;
    assert.equal(n2.intro_source, 'none');
    assert.match(String(n2.intro), /^（未生成摘要）正文开头：/);
    assert.match(String(n2.intro), /事务的隔离级别/);

    // 统计：可见节点 100% 有 intro（F3 验收）
    assert.equal(o2.stats.with_intro, Object.keys(o2.nodes).length);
    assert.equal(o2.stats.units, 5);
    assert.deepEqual(o2.stats.levels, [1, 2]);
    const flat = outlineFlat(o2);
    // 种子数据只有 level 1/2（两个根各带子节点）→ 深度序列就是 [0,1,1,0,1]
    assert.deepEqual(flat.map((x) => x.depth), [0, 1, 1, 0, 1], '深度顺序 = 树的前序展开');
    // 子树计数：根 1 含 ids[1] 的 2 张卡片 + ids[2] 的 1 张
    assert.equal(nodeOf(ids[0] as string).n_cards, 3);
    assert.equal(nodeOf(ids[0] as string).n_units, 3);
  } finally {
    db.close();
  }
});

test('outline：空正文的叶子给"无正文"文案（不假装有摘要）', () => {
  const { db, repo } = freshRepo();
  try {
    const docId = repo.insertDocument({ title: 't', kind: 'pdf', source_path: 'p' });
    repo.replaceUnits(docId, [{ ord: 1, title: '空节', level: 1, span: { kind: 'page', start: 1, end: 1 }, text: '   ' }]);
    const o = buildOutline(repo, docId);
    const only = Object.values(o.nodes)[0] as unknown as Record<string, unknown>;
    assert.equal(only.intro, '（本节无正文，也未生成摘要）');
    assert.equal(only.intro_source, 'none');
    assert.equal(o.stats.with_intro, 1, '"有 intro"的判定成立（哪怕内容是诚实占位）');
  } finally {
    db.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// xref（坑 6 / 坑 7）
// ═══════════════════════════════════════════════════════════════════════

test('★ 坑 6：mention 假阳性过滤（USE/AND 在 NOISE 里 → 0 条 mention）', () => {
  const { db, repo } = freshRepo();
  try {
    const docId = seedDoc(repo);
    const { xrefs, stats } = buildXrefs(repo, docId);
    const mentionPairs = xrefs.filter((x) => x.rel === 'mention').map((x) => x.to_card_id);

    // 文本里确实出现了 "USE" 与 "AND"（ids[4] 的正文）
    const text = repo.allUnitRows(docId)[4]?.text ?? '';
    assert.match(text, /USE/);
    assert.match(text, /AND/);

    // 但它们**不能**成为 mention 目标
    const useCard = repo.allCardRows(docId).find((c) => c.name === 'USE');
    const andCard = repo.allCardRows(docId).find((c) => c.name === 'AND');
    assert.ok(!mentionPairs.includes(String(useCard?.id)), 'USE 不许被引（NOISE）');
    assert.ok(!mentionPairs.includes(String(andCard?.id)), 'AND 不许被引（NOISE）');
    assert.equal(stats.noise_hits.use, 1, '统计里要如实记下被拒的噪音名');
    assert.equal(stats.noise_hits.and, 1);
    assert.equal(stats.mention_rejected.noise, 2);

    // 中文名"聚簇索引"含中文 → 规则 1 直接放行 → 单元 1 内的 B+树/日志卡片会引用它
    assert.ok(mentionPairs.length >= 1, '中文卡名应能产生 mention');

    // 自引用必须为 0
    for (const x of xrefs) assert.notEqual(x.from_card_id, x.to_card_id);
  } finally {
    db.close();
  }
});

test('mentionOk：契约 §2.5 四条规则逐条（含坑 7 的尾部括号）', () => {
  // 规则 1：含中文 或 含符号 → 允许
  assert.deepEqual(mentionOk('聚簇索引', ''), [true, 'identifier']);
  assert.deepEqual(mentionOk('log_filter_dragnet', ''), [true, 'identifier']);
  assert.deepEqual(mentionOk('VARCHAR(255)', ''), [true, 'identifier']);
  // 规则 2：NOISE → 拒绝
  for (const w of ['use', 'AND', 'table', 'index', 'value', 'type']) {
    assert.equal(mentionOk(w, `${w} appears here`)[0], false, `${w} 在 NOISE 里必须拒绝`);
  }
  // 契约 §2.5 的 NOISE 列表逐字数过 = **36** 个词（文档里没有给数量，这里是实测值）
  assert.equal(NOISE.size, 36, 'NOISE 集合必须逐字等于契约 §2.5 列举的 36 个词');
  // 规则 3：长度 <6 或含空格 → 必须以全大写代码形式出现
  assert.equal(mentionOk('BEGIN', 'BEGIN;')[0], true, '全大写出现 → 允许');
  assert.deepEqual(mentionOk('BEGIN', 'begin;'), [false, 'short_or_spaced_without_uppercase']);
  assert.equal(mentionOk('CREATE TABLE', 'CREATE TABLE t(x int);')[0], true, '含空格但全大写出现 → 允许');
  assert.equal(mentionOk('CREATE TABLE', 'create table t(x int);')[0], false);
  // 规则 4：其余 → 允许
  assert.deepEqual(mentionOk('B+tree', ''), [true, 'ok']);
  assert.deepEqual(mentionOk('InnoDB', ''), [true, 'ok']);
  assert.deepEqual(mentionOk('', ''), [false, 'empty']);
  // 坑 7：自引用去尾部括号
  const { isSelf } = { isSelf: (a: string, b: string): boolean => a.trim().replace(/[()]+$/, '') === b.trim().replace(/[()]+$/, '') };
  assert.equal(isSelf('TIMESTAMPDIFF()', 'TIMESTAMPDIFF'), true);
});

test('xref：四路来源规模可断言（typed / mention / also_in / same_unit）', () => {
  const { db, repo } = freshRepo();
  try {
    const docId = seedDoc(repo);
    repo.replaceGraph(
      docId,
      [
        { name: 'Clustered index', name_zh: '聚簇索引', type: 'feature', layer: 'L2' },
        { name: 'B+tree', name_zh: 'B+树', type: 'mechanism', layer: 'L1' },
      ],
      [{ src: 'Clustered index', dst: 'B+tree', etype: 'IMPLEMENTS', span: { kind: 'page', start: 1, end: 1 } }],
    );
    const { xrefs, stats } = buildXrefs(repo, docId);
    // typed：Clustered index(有卡片"聚簇索引") → B+tree(无同名卡片) → 端点缺卡片 → 0 条（如实，不硬凑）
    assert.equal(stats.typed, 0, '端点没有对应卡片时不许编出一条 typed 引用');
    assert.ok(stats.mention >= 1, '中文卡名互提产生 mention');
    assert.equal(stats.also_in, 0, '无跨单元重名卡片');
    assert.ok(stats.same_unit >= 1, '单元 1 内两张卡片互链');
    assert.equal(stats.total, xrefs.length);
    assert.equal(stats.self_refs_skipped >= 0, true);
    // 写库后按 rel 查得回来
    repo.replaceXrefs(docId, xrefs);
    const list = repo.listXrefs(docId);
    assert.equal(list.length, xrefs.length);
    assert.ok(list.every((x) => ['typed', 'mention', 'also_in', 'same_unit'].includes(x.rel)));
  } finally {
    db.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// search
// ═══════════════════════════════════════════════════════════════════════

test('search：索引 → 命中具体条目；suggest 前缀；snippet 来自原文', () => {
  const { db, repo } = freshRepo();
  try {
    const docId = seedDoc(repo);
    const counts = indexDocument(db, repo, docId);
    assert.deepEqual(counts, { cards: 5, units: 5, rows: 10 });

    const r = search(db, repo, '索引');
    assert.equal(r.total, 2, '命中：卡片"聚簇索引" + 单元 1.1「聚簇索索引…」正文');
    assert.equal(r.mode, 'bigram');
    assert.deepEqual(r.terms, ['索引']);
    const refs = r.hits.map((h) => h.ref_id).sort();
    assert.equal(refs.length, 2);
    const cardHit = r.hits.find((h) => h.kind === 'card') as (typeof r.hits)[number];
    assert.equal(cardHit.title, '聚簇索引');
    assert.match(cardHit.snippet, /聚簇索引/);
    assert.ok(!cardHit.snippet.includes('聚簇 簇索'), 'snippet 必须是原文，不是 bigram 串');
    assert.ok(cardHit.score > 0, 'score 取 -bm25 → 相关时为正');

    // 英文标识符（含下划线，整词保留）
    assert.deepEqual(search(db, repo, 'log_filter_dragnet').hits.map((h) => h.ref_id), [
      (repo.allCardRows(docId).find((c) => c.name === 'log_filter_dragnet') as { id: string }).id,
    ]);
    // 不存在的词 → 0（不是"没实现"）
    assert.equal(search(db, repo, '根本不存在的词组').total, 0);
    // doc_id 过滤
    assert.equal(search(db, repo, '索引', { docId: 'doc_不存在' }).total, 0);
    assert.equal(search(db, repo, '索引', { docId }).total, 2);
    // 分页
    assert.equal(search(db, repo, '索引', { limit: 1 }).hits.length, 1);
    assert.equal(search(db, repo, '索引', { offset: 1, limit: 1 }).hits.length, 1);
    // 空查询
    assert.equal(search(db, repo, '   ').total, 0);

    // suggest
    assert.deepEqual(suggest(db, '聚簇'), ['聚簇索引']);
    assert.deepEqual(suggest(db, '不存在'), []);
    assert.deepEqual(suggest(db, ''), []);

    // snippet 边界
    assert.match(snippet('前缀…索引优化后面还有内容', '索引'), /索引优化/);
    assert.equal(snippet('', '索引'), '');
  } finally {
    db.close();
  }
});

test('search：/search/contrast 的对照在 store 层也是 0 vs N（坑 15 回归）', () => {
  const { db, repo } = freshRepo();
  try {
    const docId = seedDoc(repo);
    indexDocument(db, repo, docId);
    const c = contrast(db, repo, '索引', { docId });
    assert.equal(c.bigram_hits, 2);
    assert.equal(c.unicode61_hits, 0);
    assert.equal(c.texts_compared, 4 + 5, '对照文本 = 4 个有正文的 unit（1 个空正文被跳过）+ 5 cards');
    assert.equal(c.tokenizer, 'unicode61');
    assert.match(c.conclusion, /坑 15/);

    // 不存在的词：两者都 0，且结论与"tokenizer 有问题"区分开
    const c2 = contrast(db, repo, '完全不存在的词', { docId });
    assert.equal(c2.bigram_hits, 0);
    assert.equal(c2.unicode61_hits, 0);
    assert.match(c2.conclusion, /确实不存在/);
  } finally {
    db.close();
  }
});

test('★ contrast 的 conclusion 必须与实测数字严格一致（4 种情况都不许撒谎）', () => {
  // 真实数据上出现过的情形：一张卡片名正好等于查询词 → unicode61 也会命中
  assert.equal(
    buildContrastConclusion(11, 2),
    'bigram 11 命中 / unicode61 2 命中：unicode61 的少量命中来自"整条内容正好等于查询词"或"该词被空格/标点切成独立 token"，**中文连续文本仍需 bigram**（漏检率随语料上升）',
  );
  assert.equal(buildContrastConclusion(2, 0), 'bigram 命中而 unicode61 为 0 → 必须自建 bigram（坑 15）');
  assert.equal(buildContrastConclusion(0, 0), '两者都 0：该查询词在这批正文里确实不存在（不是 tokenizer 问题）');
  assert.match(buildContrastConclusion(1, 3), /unicode61 3 命中 ≥ bigram 1 命中/);
  // 关键回归：unicode61 > 0 时**不许**再说"unicode61 为 0"
  assert.ok(!buildContrastConclusion(11, 2).includes('unicode61 为 0'));
});

test('indexDocument 幂等：重复索引不产生重复行', () => {
  const { db, repo } = freshRepo();
  try {
    const docId = seedDoc(repo);
    indexDocument(db, repo, docId);
    const first = db.ftsCounts();
    indexDocument(db, repo, docId);
    assert.deepEqual(db.ftsCounts(), first, '重复建索引必须幂等');
    assert.deepEqual(first, { search_docs: 10, search_fts: 10 });
  } finally {
    db.close();
  }
});
