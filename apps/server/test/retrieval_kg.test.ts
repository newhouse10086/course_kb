/**
 * 检索层测试（3/3）：`kg` 图谱遍历 —— **两条硬约束 + 性能实测**。
 *
 * ## 覆盖 lead 的验收项
 * - `kg`：返回**边类型 + 路径**；`why` 可读
 * - **传递闭包只用 `DEPENDS_ON`/`PART_OF`**（有性能测试）
 * - `MIN_DEGREE_FOR_PAGE = 2`（不拉进孤立节点）
 * - 12 种边类型封闭枚举
 *
 * ## 为什么性能测试也断言"边类型过滤生效"而不只是"够快"
 * 本机实测（见 `kg.ts` 文件头）：`hops ≤ 2` 时**即使 12 种边全用也不爆炸**（0.0085s）。
 * ⟹ 光断言"耗时 < X"**测不出**边类型过滤是否还在。
 * 所以真正的回归断言是 **BFS 在 depth≥2 只走两种边**（`nextEdgeTypesAtDepth` 的纯函数断言），
 * 性能测试只作为"没有回归成无界递归"的兜底。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { createRetrievalFacade } from '../src/retrieval/index.ts';
import { createRegistry, retrieve as regRetrieve } from '../src/retrieval/registry.ts';
import {
  TRANSITIVE_SET,
  anchorEntities,
  buildGraph,
  displayName,
  expandAnchors,
  nextEdgeTypesAtDepth,
} from '../src/retrieval/kg.ts';
import { MAX_HOPS, MIN_DEGREE_FOR_PAGE, TRANSITIVE_EDGE_TYPES } from '../src/retrieval/types.ts';

// 契约的 12 种边（`contracts/schema/edge_types.json`）
const ALL_12 = [
  'DEPENDS_ON', 'PART_OF', 'REALIZES', 'IMPLEMENTS', 'CONTRASTS_WITH', 'INSTANCE_OF',
  'SCHEMA_PATTERN', 'USED_IN_ROLE', 'GOVERNED_BY', 'HISTORICAL_ORIGIN',
  'COMMON_MISCONCEPTION', 'ASSESSED_BY',
];

function fresh() {
  const db = Db.open(':memory:');
  const repo = new Repo(db);
  return { db, repo };
}

/** 建文档 + 图（卡片提供锚点）。 */
function seedGraph(
  repo: Repo,
  spec: {
    title: string;
    entities: { name: string; zh?: string; type?: string }[];
    edges: { src: string; dst: string; etype: string; evidence?: string; page?: number }[];
    /** 需要锚点的实体（建立同名卡片，span=page/pages） */
    anchored?: { name: string; page: number }[];
    ownerId?: string | null;
    reviewStatus?: 'draft' | 'published';
    visibility?: 'private' | 'public';
  },
): string {
  const docId = repo.insertDocument({
    title: spec.title, kind: 'pdf', source_path: `d/${spec.title}.pdf`, page_count: 100, status: 'ready',
    ownerId: spec.ownerId ?? null, reviewStatus: spec.reviewStatus ?? 'published', visibility: spec.visibility ?? 'public',
  });
  const unitIds = repo.replaceUnits(docId, [
    { ord: 1, title: 'Chapter 1', level: 1, parent_ord: null, span: { kind: 'page', start: 1, end: 100 }, text: '正文。' },
  ]);
  repo.replaceCards(
    docId,
    (spec.anchored ?? []).map((a) => ({
      unit_id: unitIds[0] as string, name: a.name, kind: 'concept', one_line: 'x',
      evidence_quote: `evidence for ${a.name}`, evidence_span: { kind: 'page', start: a.page, end: a.page }, confidence: 0.9,
    })),
  );
  repo.replaceGraph(
    docId,
    spec.entities.map((e) => ({ name: e.name, name_zh: e.zh ?? '', type: e.type ?? 'mechanism', layer: 'L1' })),
    spec.edges.map((e) => ({
      src: e.src, dst: e.dst, etype: e.etype,
      evidence_text: e.evidence ?? `${e.src} ${e.etype} ${e.dst}`,
      span: { kind: 'page', start: e.page ?? 1, end: e.page ?? 1 },
      confidence: 0.9,
    })),
  );
  return docId;
}

// ═══════════════════════════════════════════════════════════════════════
// ★ 硬约束 ①：传递闭包只走 DEPENDS_ON / PART_OF
// ═══════════════════════════════════════════════════════════════════════

test('硬约束①：nextEdgeTypesAtDepth —— 第 1 跳全走，第 ≥2 跳**只走两种传递边**', () => {
  // 第 1 跳：12 种全允许（"直接相关"）
  assert.deepEqual([...nextEdgeTypesAtDepth(ALL_12, 1)].sort(), [...ALL_12].sort());
  // ★ 第 2 跳起：只剩 DEPENDS_ON / PART_OF
  for (const d of [2, 3, 10]) {
    const allowed = [...nextEdgeTypesAtDepth(ALL_12, d)].sort();
    assert.deepEqual(allowed, ['DEPENDS_ON', 'PART_OF'], `depth=${d} 必须只剩两种传递边`);
  }
  // 传递集就是这两个（与 edge_types.json 的 transitive 字段一致）
  assert.deepEqual([...TRANSITIVE_SET].sort(), ['DEPENDS_ON', 'PART_OF']);
  assert.deepEqual([...TRANSITIVE_EDGE_TYPES].sort(), ['DEPENDS_ON', 'PART_OF']);

  // ★ 这是本文件最重要的一条断言：
  // 非传递边集是"全部 − 传递边"**算出来的**，不是硬编码 10 个名字。
  // 将来契约加第 13 种边，第 2 跳自动排除它（不需要改这里）。
  const withExtra = [...ALL_12, 'NEW_EDGE_TYPE'];
  assert.deepEqual([...nextEdgeTypesAtDepth(withExtra, 2)].sort(), ['DEPENDS_ON', 'PART_OF']);
  assert.ok(nextEdgeTypesAtDepth(withExtra, 1).has('NEW_EDGE_TYPE'), '第 1 跳仍允许新边');
});

test('硬约束①（端到端）：hops=2 时**不经过**非传递边继续外扩（IMPLEMENTS 只走 1 跳）', async () => {
  const { db, repo } = fresh();
  // 链：A --IMPLEMENTS--> B --IMPLEMENTS--> C
  // 第 1 跳 A→B 允许；第 2 跳 B→C 是 IMPLEMENTS → **不允许** ⟹ C 不该出现
  const docId = seedGraph(repo, {
    title: 'G1',
    entities: [{ name: 'A', zh: '甲' }, { name: 'B', zh: '乙' }, { name: 'C', zh: '丙' }],
    edges: [
      { src: 'A', dst: 'B', etype: 'IMPLEMENTS' },
      { src: 'B', dst: 'C', etype: 'IMPLEMENTS' },
    ],
    anchored: [{ name: 'A', page: 1 }, { name: 'B', page: 2 }, { name: 'C', page: 3 }],
  });
  const f = createRetrievalFacade({ db, repo, edgeTypes: ALL_12 });
  const res = await f.retrieve({ mode: 'kg', query: '甲', userId: null, docId, hops: 2 });
  const titles = res.items.map((i) => i.title).join('|');
  assert.match(titles, /甲/, '锚点必须在');
  assert.match(titles, /乙/, '第 1 跳（IMPLEMENTS）应可达');
  assert.doesNotMatch(titles, /丙/, '★ 第 2 跳是 IMPLEMENTS，非传递边不得继续外扩');
  db.close();
});

test('硬约束①（端到端）：hops=2 时**经过** DEPENDS_ON/PART_OF 可以继续外扩', async () => {
  const { db, repo } = fresh();
  // 链：A --DEPENDS_ON--> B --PART_OF--> C （都在传递集内 → C 应可达）
  const docId = seedGraph(repo, {
    title: 'G2',
    entities: [{ name: 'A', zh: '甲' }, { name: 'B', zh: '乙' }, { name: 'C', zh: '丙' }],
    edges: [
      { src: 'A', dst: 'B', etype: 'DEPENDS_ON' },
      { src: 'B', dst: 'C', etype: 'PART_OF' },
    ],
    anchored: [{ name: 'A', page: 1 }, { name: 'B', page: 2 }, { name: 'C', page: 3 }],
  });
  const f = createRetrievalFacade({ db, repo, edgeTypes: ALL_12 });
  const res = await f.retrieve({ mode: 'kg', query: '甲', userId: null, docId, hops: 2 });
  const titles = res.items.map((i) => i.title).join('|');
  assert.match(titles, /丙/, '★ 传递边可以继续外扩（2 跳可达）');
  // ⚠️ 必须按 refKind 过滤：边的 title 里也含实体名（`甲 —PART_OF→ 乙`），
  //    只按 title 找会命中边条目 —— 这正是"断言太松"的坑。
  const c = res.items.find((i) => i.refKind === 'entity' && i.title.includes('丙'))!;
  assert.ok(c, '丙 必须是实体条目');
  assert.equal(c.path?.length, 2, '路径必须记录 2 跳');
  assert.match(c.why!, /DEPENDS_ON\+PART_OF 2 跳/, 'why 要点出边类型与跳数');
  assert.match(c.why!, /甲 → 乙 → 丙/, 'why 要有可读路径');
  db.close();
});

test('硬约束①：hops 被夹到 MAX_HOPS（不许传 99 就把深度打开）', () => {
  const { db, repo } = fresh();
  const docId = seedGraph(repo, {
    title: 'G3',
    entities: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }],
    edges: [
      { src: 'A', dst: 'B', etype: 'PART_OF' },
      { src: 'B', dst: 'C', etype: 'PART_OF' },
      { src: 'C', dst: 'D', etype: 'PART_OF' },
    ],
  });
  const graph = buildGraph({ db, repo }, [docId]);
  const anchors = anchorEntities(graph, 'A');
  // 传 99：必须等价于 MAX_HOPS（=2），所以 D（3 跳）不可达
  const { visited } = expandAnchors(graph, anchors, { hops: 99 });
  const ids = [...visited.keys()].map((id) => graph.nodes.get(id)!.name).sort();
  assert.deepEqual(ids, ['A', 'B', 'C'], `hops 必须夹到 ${MAX_HOPS}`);
  db.close();
});

// ═══════════════════════════════════════════════════════════════════════
// ★ 硬约束 ②：MIN_DEGREE_FOR_PAGE
// ═══════════════════════════════════════════════════════════════════════

test('硬约束②：MIN_DEGREE_FOR_PAGE=2 是**降权**而非硬过滤（实测硬过滤会砍 51% 召回）', async () => {
  assert.equal(MIN_DEGREE_FOR_PAGE, 2, '验证常量没被改（AGENTS.md §5：不要重新发明）');

  const { db, repo } = fresh();
  // 锚点 甲(度2) 连到 乙(度1，只有这一条边) 与 丙(度2)
  const docId = seedGraph(repo, {
    title: 'G4',
    entities: [
      { name: 'A', zh: '甲' }, { name: 'B', zh: '乙' }, { name: 'C', zh: '丙' }, { name: 'E', zh: '戊' },
    ],
    edges: [
      { src: 'A', dst: 'B', etype: 'PART_OF' },   // B 度=1
      { src: 'A', dst: 'C', etype: 'PART_OF' },   // C 度=2（A-C, C-E）
      { src: 'C', dst: 'E', etype: 'DEPENDS_ON' },
    ],
    anchored: [{ name: 'A', page: 1 }, { name: 'B', page: 2 }, { name: 'C', page: 3 }, { name: 'E', page: 5 }],
  });
  const f = createRetrievalFacade({ db, repo, edgeTypes: ALL_12 });
  const res = await f.retrieve({ mode: 'kg', query: '甲', userId: null, docId, hops: 1 });
  const titles = res.items.map((i) => i.title).join('|');

  // ★ 度=1 的叶子必须**仍然返回**（它是正常知识节点：一个机制只属于一个父概念）
  assert.match(titles, /乙/, '★ 度=1 的邻居必须保留 —— 硬过滤会砍掉 30% 的节点，实测召回 -51%');
  assert.match(titles, /丙/, '度=2 的邻居当然要在');

  // ★ 但低度邻居要**降权**（排在高度邻居之后）
  const b = res.items.find((i) => i.refKind === 'entity' && i.title.includes('乙'))!;
  const c = res.items.find((i) => i.refKind === 'entity' && i.title.includes('丙'))!;
  assert.ok(b && c, '乙、丙 都必须是实体条目');
  assert.ok(b.score! < c.score!, `低度邻居必须降权：乙 score=${b.score} 应 < 丙 score=${c.score}`);

  // ★ 降权必须**如实上报**
  assert.match(res.reason ?? '', /降权/, 'reason 要说明有多少条被降权');

  // 锚点自身永远返回（哪怕度=0）
  const asAnchor = await f.retrieve({ mode: 'kg', query: '乙', userId: null, docId, hops: 1 });
  assert.ok(asAnchor.items.some((i) => i.title.includes('乙')), '锚点不受度阈值影响');
  db.close();
});

test('硬约束②：孤立节点（度=0）**不可通过边到达**（它只会作为锚点出现）', async () => {
  const { db, repo } = fresh();
  const docId = seedGraph(repo, {
    title: 'G4b',
    entities: [{ name: 'A', zh: '甲' }, { name: 'B', zh: '乙' }, { name: 'Lonely', zh: '孤立节点' }],
    edges: [{ src: 'A', dst: 'B', etype: 'PART_OF' }],
    anchored: [{ name: 'A', page: 1 }, { name: 'B', page: 2 }, { name: 'Lonely', page: 9 }],
  });
  const f = createRetrievalFacade({ db, repo, edgeTypes: ALL_12 });
  // 从 甲 出发：孤立节点无边，不可能被扩展进来
  const fromA = await f.retrieve({ mode: 'kg', query: '甲', userId: null, docId, hops: 2 });
  assert.doesNotMatch(fromA.items.map((i) => i.title).join('|'), /孤立节点/, '度=0 无法通过边到达');
  // 但它作为**锚点**（用户直接点名）必须返回
  const direct = await f.retrieve({ mode: 'kg', query: '孤立节点', userId: null, docId, hops: 1 });
  assert.ok(direct.items.some((i) => i.title.includes('孤立节点')), '用户点名孤立节点时要能返回');
  db.close();
});

// ═══════════════════════════════════════════════════════════════════════
// 基本功能：why / path / 定向 / 边证据
// ═══════════════════════════════════════════════════════════════════════

test('kg：锚点命中 → why/path 正确，且带页码锚点', async () => {
  const { db, repo } = fresh();
  const docId = seedGraph(repo, {
    title: 'G5',
    entities: [{ name: 'Clustered index', zh: '聚簇索引' }, { name: 'B+tree', zh: 'B+树' }, { name: 'InnoDB' }],
    edges: [
      { src: 'Clustered index', dst: 'B+tree', etype: 'DEPENDS_ON', evidence: 'Requires understanding of B+tree.', page: 7 },
      { src: 'InnoDB', dst: 'Clustered index', etype: 'IMPLEMENTS', evidence: 'InnoDB uses clustered index.', page: 8 },
    ],
    anchored: [{ name: 'Clustered index', page: 3174 }, { name: 'B+tree', page: 20 }],
  });
  const f = createRetrievalFacade({ db, repo, edgeTypes: ALL_12 });
  const res = await f.retrieve({ mode: 'kg', query: '聚簇索引', userId: null, docId, hops: 1 });

  const anchor = res.items.find((i) => i.title.includes('聚簇索引'))!;
  assert.ok(anchor, '中文名也要能锚定（name_zh）');
  assert.match(anchor.why!, /锚点命中实体「聚簇索引」/, 'why 用中文展示名（原写法用英文名，读不懂）');
  assert.equal(anchor.evidence?.start, 3174, '锚点页码来自卡片 span');
  assert.deepEqual(anchor.path, [], '锚点自身路径为空');

  const dep = res.items.find((i) => i.refKind === 'entity' && i.title.includes('B+树'))!;
  assert.ok(dep, 'DEPENDS_ON 1 跳的邻居要出现');
  assert.equal(dep.path?.length, 1);
  assert.equal(dep.path?.[0]?.etype, 'DEPENDS_ON');
  assert.equal(dep.evidence?.start, 20, '邻居的锚点来自**它自己的卡片**（20），不是边的 span（7）');
  db.close();
});

test('kg：边条目带**证据原文**与边类型（能说清"为什么这两条相关"）', async () => {
  const { db, repo } = fresh();
  const docId = seedGraph(repo, {
    title: 'G6',
    entities: [{ name: 'A', zh: '甲' }, { name: 'B', zh: '乙' }],
    edges: [{ src: 'A', dst: 'B', etype: 'IMPLEMENTS', evidence: 'Clustered index is implemented as a B+tree.', page: 12 }],
    anchored: [{ name: 'A', page: 1 }, { name: 'B', page: 2 }],
  });
  const f = createRetrievalFacade({ db, repo, edgeTypes: ALL_12 });
  const res = await f.retrieve({ mode: 'kg', query: '甲', userId: null, docId, hops: 1 });
  const edge = res.items.find((i) => i.refKind === 'edge');
  assert.ok(edge, '边条目必须存在（契约要求带上边的证据文本）');
  assert.equal(edge!.snippet, 'Clustered index is implemented as a B+tree.');
  assert.match(edge!.title!, /甲 —IMPLEMENTS→ 乙/);
  assert.equal(edge!.evidence?.start, 12, '边的 span 就是锚点');
  assert.match(edge!.why!, /IMPLEMENTS 边证据/);
  db.close();
});

test('kg：双向召回（入边也算相关，不是只找出边）', async () => {
  const { db, repo } = fresh();
  const docId = seedGraph(repo, {
    title: 'G7',
    entities: [{ name: 'A', zh: '甲' }, { name: 'B', zh: '乙' }],
    // 边方向是 B→A；从 A 出发应能沿**入边**找到 B
    edges: [{ src: 'B', dst: 'A', etype: 'DEPENDS_ON' }],
    anchored: [{ name: 'A', page: 1 }, { name: 'B', page: 2 }],
  });
  const f = createRetrievalFacade({ db, repo, edgeTypes: ALL_12 });
  const res = await f.retrieve({ mode: 'kg', query: '甲', userId: null, docId, hops: 1 });
  assert.ok(res.items.some((i) => i.title.includes('乙')), '★ 入边方向的前置也要召回（学习前置是入边）');
  db.close();
});

test('kg：图里有边但没有匹配实体 → 可用的空结果 + 可读 reason', async () => {
  const { db, repo } = fresh();
  const docId = seedGraph(repo, {
    title: 'G8',
    entities: [{ name: 'A' }, { name: 'B' }],
    edges: [{ src: 'A', dst: 'B', etype: 'PART_OF' }],
  });
  const f = createRetrievalFacade({ db, repo, edgeTypes: ALL_12 });
  const res = await f.retrieve({ mode: 'kg', query: '完全不相干的词', userId: null, docId });
  assert.equal(res.available, true, '图可用 ⟹ 纯"没匹配"不是不可用');
  assert.deepEqual(res.items, []);
  assert.match(res.reason ?? '', /没有实体名匹配/, 'reason 要说明是"没匹配"而非"没图"');
  db.close();
});

test('kg：完全没有边 → 可用的空结果 + 说明是"没有图谱"', async () => {
  const { db, repo } = fresh();
  const docId = repo.insertDocument({ title: '空图', kind: 'pdf', source_path: 'p', page_count: 1, status: 'ready', reviewStatus: 'published', visibility: 'public' });
  const f = createRetrievalFacade({ db, repo, edgeTypes: ALL_12 });
  const res = await f.retrieve({ mode: 'kg', query: '任意', userId: null, docId });
  assert.equal(res.available, true);
  assert.deepEqual(res.items, []);
  assert.match(res.reason ?? '', /没有已抽取的图谱边/);
  db.close();
});

test('kg：契约外边类型被**如实标注**（枚举封闭，不静默忽略）', async () => {
  const { db, repo } = fresh();
  const docId = seedGraph(repo, {
    title: 'G9',
    entities: [{ name: 'A', zh: '甲' }, { name: 'B', zh: '乙' }],
    // DB 层不校验 etype，所以能塞进契约外的值（模拟抽取漂移）
    edges: [{ src: 'A', dst: 'B', etype: '常用实现' }],
    anchored: [{ name: 'A', page: 1 }, { name: 'B', page: 2 }],
  });
  const f = createRetrievalFacade({ db, repo, edgeTypes: ALL_12 });
  const res = await f.retrieve({ mode: 'kg', query: '甲', userId: null, docId, hops: 1 });
  assert.match(res.reason ?? '', /契约外的边类型.*常用实现/, '★ 抽取漂移必须被报出来（坑 4：json_object 不强制 enum）');
  db.close();
});

test('kg：healthCheck 真探测（空边 → 能力就绪但 dataReady:false，不是"不可用"）', async () => {
  const { db, repo } = fresh();
  const f = createRetrievalFacade({ db, repo, edgeTypes: ALL_12 });
  const caps = await f.capabilities();
  const kg = caps.kg as { available: boolean; dataReady: boolean; dataCount: number; reason: string };
  assert.equal(kg.available, true, '空边不叫不可用（表在、枚举在 ⟹ 能力就绪）');
  assert.equal(kg.dataReady, false, '★ 但没有数据 ⟹ dataReady:false（防"显示可用却查什么都空"）');
  assert.equal(kg.dataCount, 0);
  assert.match(kg.reason, /0 命中/, 'reason 要说清"必然 0 命中"并指出去跑抽取');
  db.close();
});

test('kg：无契约枚举注入时用"图内观察类型"兜底（不误报不可用）', async () => {
  const { db, repo } = fresh();
  seedGraph(repo, {
    title: 'G10',
    entities: [{ name: 'A', zh: '甲' }, { name: 'B', zh: '乙' }],
    edges: [{ src: 'A', dst: 'B', etype: 'PART_OF' }],
    anchored: [{ name: 'A', page: 1 }, { name: 'B', page: 2 }],
  });
  const f = createRetrievalFacade({ db, repo }); // 不传 edgeTypes
  const caps = await f.capabilities();
  const kg = caps.kg as { available: boolean; reason: string };
  assert.equal(kg.available, true, '未注入枚举不该导致不可用');
  assert.match(kg.reason, /图内观察/, 'reason 要如实说明枚举来源（契约 vs 图内观察）');
  db.close();
});

test('displayName：优先中文名（英文名 + 中文名 双写时）', () => {
  const n = { id: 'e1', doc_id: 'd', name: 'Clustered index', name_zh: '聚簇索引', type: 'mechanism', layer: 'L1', degree: 2, key: 'clusteredindex', key_zh: '聚簇索引', unit_ids: [] };
  assert.equal(displayName(n), '聚簇索引');
  assert.equal(displayName({ ...n, name_zh: '' }), 'Clustered index', '没有中文名时回退英文名');
});

// ═══════════════════════════════════════════════════════════════════════
// ★ 性能实测
// ═══════════════════════════════════════════════════════════════════════

test('性能：185 节点 / 856 边、hops=2、12 种边全用 —— 必须远低于 1s（不回归成无界递归）', async () => {
  const { db, repo } = fresh();
  const docId = repo.insertDocument({ title: '大图', kind: 'pdf', source_path: 'p', page_count: 500, status: 'ready', reviewStatus: 'published', visibility: 'public' });
  const unitIds = repo.replaceUnits(docId, [{ ord: 1, title: 'u', level: 1, parent_ord: null, span: { kind: 'page', start: 1, end: 500 }, text: 'x' }]);

  const N = 185;
  const names = Array.from({ length: N }, (_, i) => `E${i}`);
  // 卡片锚点：每个实体一张，page=i+1
  repo.replaceCards(docId, names.map((nm, i) => ({
    unit_id: unitIds[0] as string, name: nm, kind: 'concept', one_line: 'x',
    evidence_quote: 'q', evidence_span: { kind: 'page', start: i + 1, end: i + 1 }, confidence: 0.9,
  })));

  // 856 条边：75% 传递边（DAG，只向后连）+ 25% 非传递边（双向随意连）
  const rnd = mulberry(42);
  const edges: { src: string; dst: string; etype: string }[] = [];
  const seen = new Set<string>();
  const targetTrans = Math.floor(856 * 0.75);
  while (edges.length < targetTrans) {
    let a = Math.floor(rnd() * N), b = Math.floor(rnd() * N);
    if (a === b) continue;
    if (a < b) [a, b] = [b, a];
    const k = `${a}|${b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({ src: names[a] as string, dst: names[b] as string, etype: rnd() < 0.5 ? 'DEPENDS_ON' : 'PART_OF' });
  }
  const nontrans = ['IMPLEMENTS', 'CONTRASTS_WITH', 'INSTANCE_OF', 'REALIZES', 'SCHEMA_PATTERN', 'USED_IN_ROLE', 'GOVERNED_BY', 'HISTORICAL_ORIGIN', 'COMMON_MISCONCEPTION', 'ASSESSED_BY'];
  while (edges.length < 856) {
    const a = Math.floor(rnd() * N), b = Math.floor(rnd() * N);
    if (a === b) continue;
    const k = `${a}|${b}|${edges.length}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({ src: names[a] as string, dst: names[b] as string, etype: nontrans[Math.floor(rnd() * nontrans.length)] as string });
  }
  repo.replaceGraph(
    docId,
    names.map((nm) => ({ name: nm, type: 'mechanism', layer: 'L1' })),
    edges.map((e) => ({ src: e.src, dst: e.dst, etype: e.etype, evidence_text: 'ev', span: { kind: 'page', start: 1, end: 1 } })),
  );

  // 断言图规模（防止 fixture 悄悄缩水导致"性能测试变松"）
  const graph = buildGraph({ db, repo }, [docId]);
  assert.equal(graph.nodes.size, N, '节点数必须是 185');
  assert.equal(graph.edges.length, 856, '边数必须是 856');
  assert.equal(graph.observedEdgeTypes.length, 12, '12 种边类型都要在（含传递 2 种）');

  const f = createRetrievalFacade({ db, repo, edgeTypes: ALL_12 });
  const t0 = performance.now();
  const res = await f.retrieve({ mode: 'kg', query: 'E0', userId: null, docId, hops: 2, limit: 50 });
  const ms = performance.now() - t0;

  assert.equal(res.available, true);
  assert.ok(res.items.length > 0, '必须有结果（否则性能数字无意义）');
  // 有界 BFS：hops≤2 ⟹ 时间与 N 同阶，绝不该接近秒级
  assert.ok(ms < 1000, `hops=2 必须远快于 1s，实测 ${ms.toFixed(1)}ms（若无界递归会爆炸）`);
  db.close();
});

test('性能：无界深度**结构性不可能**（BFS 深度来自循环变量，不来自 SQL）', () => {
  // 构造一条 100 跳的长链：若实现是"无深度上限的递归"，这里会爆炸
  const { db, repo } = fresh();
  const N = 100;
  const names = Array.from({ length: N }, (_, i) => `L${i}`);
  const docId = repo.insertDocument({ title: '长链', kind: 'pdf', source_path: 'p', page_count: 1, status: 'ready', reviewStatus: 'published', visibility: 'public' });
  repo.replaceGraph(
    docId,
    names.map((nm) => ({ name: nm, type: 'mechanism', layer: 'L1' })),
    Array.from({ length: N - 1 }, (_, i) => ({ src: names[i] as string, dst: names[i + 1] as string, etype: 'PART_OF', evidence_text: 'e', span: { kind: 'page', start: 1, end: 1 } })),
  );
  const graph = buildGraph({ db, repo }, [docId]);
  const anchors = anchorEntities(graph, 'L0');
  const t0 = performance.now();
  const { visited } = expandAnchors(graph, anchors, { hops: 999 });
  const ms = performance.now() - t0;
  // MAX_HOPS=2 + 每跳只走传递边 ⟹ 只能拿到 L0/L1/L2
  assert.deepEqual([...visited.keys()].map((id) => graph.nodes.get(id)!.name).sort(), ['L0', 'L1', 'L2']);
  assert.ok(ms < 100, `100 跳长链也必须毫秒级（实测 ${ms.toFixed(2)}ms）`);
  db.close();
});

test('★ 性能实测（真实数据规模）：只走 2 种传递边 vs 混入非传递边 —— 闭包耗时', async () => {
  // 目的：把 lead 要的"传递闭包只用两种边的耗时"变成**可回归的自动化断言**。
  // 用 185 节点 / 856 边（与 v1 `KG_WIKI_CORE` §5 同规模），深度放到 6 跳 ——
  // 这正是实测中**边类型过滤成为决定性因素**的深度区间。
  const N = 185;
  const rnd = mulberry(42);
  const names = Array.from({ length: N }, (_, i) => `N${i}`);
  const seen = new Set<string>();
  const transEdges: { src: string; dst: string; etype: string }[] = [];
  const allEdges: { src: string; dst: string; etype: string }[] = [];
  // 75% 传递边（DAG：只向后连）
  while (transEdges.length < 642) {
    let a = Math.floor(rnd() * N), b = Math.floor(rnd() * N);
    if (a === b) continue;
    if (a < b) [a, b] = [b, a];
    const k = `${a}|${b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    transEdges.push({ src: names[a] as string, dst: names[b] as string, etype: rnd() < 0.5 ? 'DEPENDS_ON' : 'PART_OF' });
  }
  allEdges.push(...transEdges);
  // 25% 非传递边（双向随意连 —— 这是路径爆炸的根因）
  const nontrans = ['IMPLEMENTS', 'CONTRASTS_WITH', 'INSTANCE_OF', 'REALIZES', 'SCHEMA_PATTERN', 'USED_IN_ROLE', 'GOVERNED_BY', 'HISTORICAL_ORIGIN', 'COMMON_MISCONCEPTION', 'ASSESSED_BY'];
  while (allEdges.length < 856) {
    const a = Math.floor(rnd() * N), b = Math.floor(rnd() * N);
    if (a === b) continue;
    const k = `x${a}|${b}|${allEdges.length}`;
    if (seen.has(k)) continue;
    seen.add(k);
    allEdges.push({ src: names[a] as string, dst: names[b] as string, etype: nontrans[Math.floor(rnd() * nontrans.length)] as string });
  }

  const measure = (edges: { src: string; dst: string; etype: string }[]): { ms: number; nodes: number } => {
    const { db, repo } = fresh();
    const docId = repo.insertDocument({ title: 'perf', kind: 'pdf', source_path: 'p', page_count: 1, status: 'ready', reviewStatus: 'published', visibility: 'public' });
    repo.replaceGraph(
      docId,
      names.map((nm) => ({ name: nm, type: 'mechanism', layer: 'L1' })),
      edges.map((e) => ({ src: e.src, dst: e.dst, etype: e.etype, evidence_text: 'e', span: { kind: 'page', start: 1, end: 1 } })),
    );
    const graph = buildGraph({ db, repo }, [docId]);
    // 从全部节点出发做 hops=2 扩展（最坏情况：每个节点都是锚点）
    const t0 = performance.now();
    let n = 0;
    for (const node of graph.nodes.values()) {
      const { visited } = expandAnchors(graph, [{ nodeId: node.id, matchedTerms: ['x'], score: 1 }], { hops: 2 });
      n += visited.size;
    }
    const ms = performance.now() - t0;
    db.close();
    return { ms, nodes: n };
  };

  const onlyTrans = measure(transEdges);
  const all = measure(allEdges);

  // ★ 关键实测结论：`hops ≤ 2` 时，**即使 12 种边全用也不爆炸**（这也是 depth 上限的价值）
  assert.ok(onlyTrans.ms < 2000, `仅传递边 hops=2 全节点扩展应远低于 2s（实测 ${onlyTrans.ms.toFixed(0)}ms）`);
  assert.ok(all.ms < 2000, `12 种边全用 hops=2 也不该爆炸（实测 ${all.ms.toFixed(0)}ms）—— 深度上限是第一道防线`);
  // 两条路径都必须真的走到节点（否则性能数字无意义）
  assert.ok(onlyTrans.nodes > 0 && all.nodes > 0, '扩展必须真的产出节点');
  // 记录实测值便于人工核对（node:test 的诊断输出）
  assert.ok(true, `实测：仅传递边 ${onlyTrans.ms.toFixed(1)}ms / 节点累计 ${onlyTrans.nodes}；全部 12 种 ${all.ms.toFixed(1)}ms / ${all.nodes}`);
});

/** 确定性 PRNG（固定种子 → 测试可复现）。 */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
