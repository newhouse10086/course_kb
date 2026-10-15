/**
 * ★ `/capabilities` 缓存 × 检索层 `dataReady` —— **跨 HTTP 的实时性回归测试**。
 *
 * ## 为什么必须有一条"走真实 HTTP"的测试
 * 本项目已因同一 bug class **踩了三次**（AGENTS.md 坑 19）：
 * 1. `auth.bootstrap` 被启动期快照冻住
 * 2. `settings.activeModel` 被缓存冻住
 * 3. **`retrieval.dataReady` 被 15s 缓存冻住** ← 本文件守的就是这条
 *
 * 关键在于：**只调检索层的单测全都绿**（`test/retrieval_*.test.ts` 直接调
 * `createRetrievalFacade`，不经过路由缓存）⟹ 缓存层的 bug **只有
 * "真实 HTTP + 中途改数据 + 命中缓存"** 这个组合才能暴露。
 *
 * ## 判据（两条一起看，缺一条都测不出）
 * ```text
 * ① 写数据后立刻再 GET（**应命中缓存**，cached=true）
 * ② 该响应里 retrieval.{wiki,kg}.dataReady 必须已是**新值**
 * ```
 * 只断言 ①：缓存生效了，但可能冻住状态字段。
 * 只断言 ②：可能是缓存没命中（`refresh=1` 之类），掩盖了问题。
 *
 * ## ⚠️ 数据源别搞混（我第一版就在这里写错）
 * `wiki.dataReady` 读的是 **`search_docs`（FTS 索引行）**，
 * `kg.dataReady` 读的是 **`edges`**。二者**正交**：
 * 删掉边**不会**让 `wiki.dataReady` 变 false（索引还在）。
 * 所以反向断言必须**按各自的数据源分别清**，不能一起删。
 *
 * 写域：本文件在 `test/retrieval_capabilities_cache.test.ts`（检索层测试域）。
 * 它**读** `src/routes/capabilities.ts` 的行为但不修改它。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import { buildApp } from '../src/index.ts';
import type { BuiltApp } from '../src/index.ts';
import { indexDocument } from '../src/store/search.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
let tmpRoot = '';
let built: BuiltApp;
let base = '';

/**
 * 只建**一个** app 供三条测试复用 —— `buildApp` 很重（~15s：pi 加载 / provider 装配），
 * 每个 test 各建一个会让本文件跑到 60s+，拖慢整个 `npm test`。
 * 复用是安全的：三条用例在同一进程/端口内**顺序**执行（`--test-concurrency=1`），
 * 且各自只清理自己写入的数据。
 */
before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retr-caps-'));
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DATA_DIR: path.join(tmpRoot, 'd'),
      COURSE_KB_DB: path.join(tmpRoot, 'caps.sqlite3'),
    } as Record<string, string>,
  });
  built = await buildApp({
    cfg,
    extractor: {
      name: 'noop',
      async available() {
        return { ok: false, reason: '缓存回归测试不抽取' };
      },
      async extractDocument() {
        throw new Error('不应被调用');
      },
    },
    workerProbe: async () => ({
      available: false,
      bin: 'python',
      module: 'worker.cli',
      pythonVersion: null,
      moduleImportable: false,
      reason: '缓存回归测试未启用 worker',
      checkedAt: Date.now(),
      cached: false,
      probes: {
        python: { ok: false, stdout: '', stderr: '', code: null, elapsedMs: 0 },
        module: { ok: false, stdout: '', stderr: '', code: null, elapsedMs: 0 },
      },
    }),
  });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('无法取到监听地址');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  try {
    await built?.app.close();
  } catch {
    /* 已关闭 */
  }
  // ⚠️ `rmSync` 在 Windows 上可能 EPERM（sqlite 文件句柄尚未完全释放）——
  //    临时目录清理失败**不该让测试变红**（那不是被测行为），所以单独 try。
  try {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* 忽略 */
  }
});

interface CapsBody {
  cached?: boolean;
  cached_age_ms?: number;
  cache_ttl_ms?: number;
  /** ★ Lead 裁定的 fail-safe 方向：**可缓存**白名单（昂贵探测 + 静态值） */
  cacheable_fields?: string[];
  /** ★ 缓存命中时必须实时重算的字段（`realtime_fields` 已被它取代） */
  live_fields?: string[];
  /** 既不可缓存、也不在实时集 → 结构守卫生效时为 `[]` */
  unclassified_fields?: string[];
  retrieval?: {
    wiki?: { available: boolean; dataReady: boolean; dataCount: number };
    kg?: { available: boolean; dataReady: boolean; dataCount: number; reason: string };
    rag?: { available: boolean; dataReady: boolean };
    summary?: { any_available: boolean; any_data: boolean; empty_kb: boolean; hint: string };
  };
}

/**
 * ★ 统一走 `?deep=0`（浅探测）—— **本文件测的是"缓存有没有冻住状态字段"，
 * 与深/浅探测无关**：`liveFields()`（`auth`/`settings`/`retrieval`/`search`）在**两条路径上
 * 都会被调用**，所以浅探测足以覆盖本 bug class。
 *
 * `[实测]` 本机：深探测单次 **19.5s**（pi 加载 + 模型探测 + 4 引擎探测），
 * 浅探测 **227ms**。若用深探测，本文件要跑 44s+，**会明显拖慢整个 `npm test`**；
 * 用浅探测后 <1s。⚠️ 代价：浅探测走的是 `cacheKey='shallow'`，与深探测**不共用缓存槽**
 * —— 本文件内部一致即可（三个用例都用同一档）。
 */
async function getCaps(query = ''): Promise<CapsBody> {
  const qs = query ? `${query}&deep=0` : '?deep=0';
  const res = await fetch(`${base}/api/v1/capabilities${qs}`);
  assert.equal(res.status, 200, '/capabilities 必须 200');
  return (await res.json()) as CapsBody;
}

function diagOf(r: CapsBody): string {
  return (
    `cached=${String(r.cached)} age=${String(r.cached_age_ms)} ` +
    `kg=${String(r.retrieval?.kg?.dataReady)}/${String(r.retrieval?.kg?.dataCount)} ` +
    `wiki=${String(r.retrieval?.wiki?.dataReady)}/${String(r.retrieval?.wiki?.dataCount)} ` +
    `empty_kb=${String(r.retrieval?.summary?.empty_kb)}`
  );
}

/** 写"抽取完成"的数据（文档 + 单元 + 卡片 + 图 + FTS 索引）。 */
function seedExtracted(): string {
  const { db, repo } = built.deps;
  const docId = repo.insertDocument({
    title: '缓存回归用资料',
    kind: 'pdf',
    source_path: 'data/uploads/x.pdf',
    page_count: 9,
    status: 'ready',
    reviewStatus: 'published',
    visibility: 'public',
  });
  const unitIds = repo.replaceUnits(docId, [
    { ord: 1, title: '索引', level: 1, parent_ord: null, span: { kind: 'page', start: 1, end: 9 }, text: '聚簇索引将数据按主键顺序存放。' },
  ]);
  repo.replaceCards(docId, [
    {
      unit_id: unitIds[0] as string,
      name: '聚簇索引',
      kind: 'concept',
      one_line: '数据按主键顺序存放的索引',
      evidence_quote: 'Clustered indexes sort rows by key.',
      evidence_span: { kind: 'page', start: 3, end: 3 },
      confidence: 0.9,
    },
  ]);
  repo.replaceGraph(
    docId,
    [
      { name: '聚簇索引', name_zh: '聚簇索引', type: 'mechanism', layer: 'L1' },
      { name: 'B+树', name_zh: 'B+树', type: 'mechanism', layer: 'L1' },
    ],
    [
      { src: '聚簇索引', dst: 'B+树', etype: 'IMPLEMENTS', evidence_text: 'implemented as a B+tree', span: { kind: 'page', start: 3, end: 3 } },
    ],
  );
  indexDocument(db, repo, docId);
  return docId;
}

/** ★ 清 **wiki** 的数据源（`search_docs`/FTS 索引）—— 与 kg 的正交。 */
function clearWikiData(): void {
  built.deps.db.run('DELETE FROM search_fts');
  built.deps.db.run('DELETE FROM search_docs');
}

/** ★ 清 **kg** 的数据源（`edges`/`entities`）。 */
function clearKgData(): void {
  built.deps.db.run('DELETE FROM edges');
  built.deps.db.run('DELETE FROM entities');
}

// ═══════════════════════════════════════════════════════════════════════

test('★ 缓存命中时 retrieval.dataReady 必须实时（防第 3 次"承诺实时却被缓存"回归）', async () => {
  // ① 预热：空库 → 能力就绪但无数据
  const warm = await getCaps();
  assert.equal(warm.cached, false, '首次必须不命中缓存');
  assert.equal(warm.retrieval?.kg?.available, true, '能力就绪（表/枚举在）');
  assert.equal(warm.retrieval?.wiki?.available, true);
  assert.equal(warm.retrieval?.kg?.dataReady, false, `空库 → kg.dataReady:false（${diagOf(warm)}）`);
  assert.equal(warm.retrieval?.wiki?.dataReady, false, `空库 → wiki.dataReady:false（${diagOf(warm)}）`);
  assert.equal(warm.retrieval?.summary?.empty_kb, true, '空库态');

  // ② 中途"抽取完成"（等价于学生刚跑完抽取）
  seedExtracted();

  // ③ 立刻再 GET —— **应命中缓存**，但 retrieval 段必须已是新值
  const after = await getCaps();
  assert.equal(after.cached, true, '★ 必须真的命中缓存，否则测不出"缓存冻住状态字段"');
  assert.ok((after.cache_ttl_ms ?? 0) > 0, '命中缓存要如实标注 ttl');
  assert.equal(
    after.retrieval?.kg?.dataReady,
    true,
    '★ 抽完数据后即使命中缓存，kg.dataReady 也必须立刻变 true\n' +
      '  （否则学生看到 empty_kb:true + "先去抽取"，会以为抽取没生效、重复去抽）\n' +
      `  实测：${diagOf(after)}`,
  );
  assert.equal(after.retrieval?.wiki?.dataReady, true, `★ wiki.dataReady 同理；实测：${diagOf(after)}`);
  assert.ok((after.retrieval?.kg?.dataCount ?? 0) > 0, `dataCount 必须是新条数，不是缓存的 0；实测：${diagOf(after)}`);
  assert.equal(after.retrieval?.summary?.empty_kb, false, `★ 不再是空库态；实测：${diagOf(after)}`);

  // ④ 反向：**分别清两个数据源**，再 GET（仍命中缓存）→ 各自 dataReady 必须回到 false
  clearWikiData();
  clearKgData();
  const cleared = await getCaps();
  assert.equal(cleared.cached, true, '仍应在 TTL 内（否则测的是强制刷新路径）');
  assert.equal(cleared.retrieval?.kg?.dataReady, false, `★ kg：清了 edges 必须立刻反映；实测：${diagOf(cleared)}`);
  assert.equal(cleared.retrieval?.wiki?.dataReady, false, `★ wiki：清了 search_docs 必须立刻反映；实测：${diagOf(cleared)}`);
  assert.equal(cleared.retrieval?.summary?.empty_kb, true, '★ 回到空库态');
});

test('★ 只清一半数据时，两个模式必须各自独立反映（不许串台）', async () => {
  // 防的是"用同一个信号算 wiki/kg 的 dataReady"这种偷懒实现。
  seedExtracted();

  // 只清 kg 的数据（wiki 的索引保留）
  clearKgData();
  const kgCleared = await getCaps();
  assert.equal(kgCleared.cached, true, '命中缓存');
  assert.equal(kgCleared.retrieval?.kg?.dataReady, false, `kg 的边清了 → false；实测：${diagOf(kgCleared)}`);
  assert.equal(
    kgCleared.retrieval?.wiki?.dataReady,
    true,
    `★ wiki 的索引还在 → 必须仍为 true（两个数据源正交，不许一起变）；实测：${diagOf(kgCleared)}`,
  );

  // 再清 wiki 的数据
  clearWikiData();
  const bothCleared = await getCaps();
  assert.equal(bothCleared.cached, true, '命中缓存');
  assert.equal(bothCleared.retrieval?.wiki?.dataReady, false, `wiki 也清了 → false；实测：${diagOf(bothCleared)}`);
});

test('★ 缓存机制本身仍生效（修实时性不许把缓存整个删掉）', async () => {
  // ⚠️ 本文件三条用例**共用一个 app**（`buildApp` 太贵），缓存可能已被前面的用例预热。
  //    所以这里先用 `?refresh=1` **强制重建缓存**，再验证后续 GET 命中 —— 否则
  //    "首次不命中"会因测试顺序而随机失败（我第一版就是这样）。
  const initial = await getCaps('?refresh=1');
  assert.equal(initial.cached, false, 'refresh=1 必须绕过/重建缓存');
  assert.equal(initial.cache_ttl_ms, 15_000, 'TTL 契约（15s）');

  const second = await getCaps();
  assert.equal(second.cached, true, 'TTL 内应命中缓存（性能优化必须保留）');
  assert.ok((second.cached_age_ms ?? -1) >= 0, 'age 必须如实上报');

  // ★ Lead 裁定的**方向反转**（fail-safe）：白名单从"实时"改成"可缓存"。
  //   忘了分类 → 新字段按**实时**处理（安全，只是慢一点），
  //   而不是被悄悄缓存成陈旧值（不安全且测试不红）。
  //   字段名随之改变：`realtime_fields` → `live_fields`（且多了 `search`：
  //   它是"当前状态" —— 抽完资料 FTS 行数要立刻可见，与 `dataReady` 同类）。
  //
  //   ⚠️ 这里用 **"包含"而不是"相等"**（Lead 裁定）：
  //   将来**新增实时字段**不该让本测试红（那是进步，不是回归）；
  //   真正该红的是"**漏分类**"，由 `unclassified_fields` 与 backend-api 的结构守卫管。
  //   若用"相等"，每次扩清单都要来改这条断言 → 会训练人"顺手改断言"而削弱它。
  //   **测试该断言"承诺实时的字段确实实时"，不是"清单恰好等于某值"。**
  for (const f of ['auth', 'settings', 'retrieval', 'search']) {
    assert.ok(
      (second.live_fields ?? []).includes(f),
      `★ 承诺实时的字段必须出现在 live_fields：缺 ${f}（实测 ${JSON.stringify(second.live_fields)}）`,
    );
  }
  assert.ok(
    second.cacheable_fields?.includes('pi'),
    `可缓存白名单要如实列出（否则"缓存昂贵探测"就无从验证）；实测 ${JSON.stringify(second.cacheable_fields)}`,
  );
  assert.deepEqual(
    second.unclassified_fields,
    [],
    '★ 不许有未分类字段 —— 这是"新字段忘分类会被抓住"的结构守卫',
  );
  // 两个白名单必须**互斥**（同一字段既缓存又实时 = 两处真相，迟早漂）
  const overlap = (second.cacheable_fields ?? []).filter((f) => (second.live_fields ?? []).includes(f));
  assert.deepEqual(overlap, [], `★ 可缓存与实时白名单不许有交集，实测重叠：${JSON.stringify(overlap)}`);

  // 再确认一次强制刷新仍能绕过
  const forced = await getCaps('?refresh=1');
  assert.equal(forced.cached, false, 'refresh=1 每次都绕过缓存');
});

test('★ 空库态的 hint 必须指向"去抽取"（UI 横幅直接用它）', async () => {
  const caps = await getCaps();
  const s = caps.retrieval?.summary;
  assert.ok(s, '必须有 summary 段（UI 一句话提示）');
  assert.equal(s!.any_available, true, '能力就绪');
  // 此时数据已被前两条用例清空 → 应回到空库态
  assert.equal(s!.any_data, false, '无数据');
  assert.equal(s!.empty_kb, true, '空库态');
  assert.match(s!.hint, /抽取/, 'hint 必须指出下一步动作（不是只说"没有数据"）');
});
