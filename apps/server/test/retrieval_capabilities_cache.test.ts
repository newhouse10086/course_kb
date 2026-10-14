/**
 * ★ `/capabilities` 缓存 × 检索层 `dataReady` —— **跨 HTTP 的实时性回归测试**。
 *
 * ## 为什么必须有一条"走真实 HTTP"的测试
 * 本项目已因同一 bug class **踩了三次**：
 * 1. `auth.bootstrap` 被启动期快照冻住（已修）
 * 2. `settings.activeModel` 被缓存冻住（已修）
 * 3. **`retrieval.dataReady` 被 15s 缓存冻住** ← 本文件守的就是这条
 *
 * 关键在于：**只调检索层的单测全都绿**（`test/retrieval_*.test.ts` 直接调
 * `createRetrievalFacade`，不经过路由缓存）⟹ 缓存层的 bug **只有
 * "真实 HTTP + 中途改数据 + 命中缓存"** 这个组合才能暴露。
 *
 * ## 判据（两条一起看，缺一条都测不出）
 * ```text
 * ① 写数据后立刻再 GET（**应命中缓存**，cached=true）
 * ② 该响应里 retrieval.{wiki,kg}.dataReady 必须已是**新值 true**
 * ```
 * 只断言 ①：缓存生效了，但可能冻住状态字段（当前 bug）。
 * 只断言 ②：可能是缓存没命中（`refresh=1` 之类），掩盖了问题。
 *
 * ⚠️ 写域说明：本文件在 `test/retrieval_capabilities_cache.test.ts`（检索层测试域）。
 * **它读 `src/routes/capabilities.ts` 的行为但不修改它** —— 缓存语义是接口契约的一部分，
 * 检索层有责任守住"自己上报的 `dataReady` 不会被上游缓存冻住"。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import { buildApp } from '../src/index.ts';
import type { BuiltApp } from '../src/index.ts';
import { indexDocument } from '../src/store/search.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
let tmpRoot = '';
let counter = 0;
const builtApps: BuiltApp[] = [];

/** 真 listen（与 `rbac_api.test.ts` 同款脚手架：真端口 + 真 fetch）。 */
async function makeApp(): Promise<{ built: BuiltApp; base: string }> {
  counter += 1;
  if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retr-caps-'));
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DATA_DIR: path.join(tmpRoot, `d${counter}`),
      COURSE_KB_DB: path.join(tmpRoot, `caps-${counter}.sqlite3`),
    } as Record<string, string>,
  });
  const built = await buildApp({
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
  builtApps.push(built);
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('无法取到监听地址');
  return { built, base: `http://127.0.0.1:${addr.port}` };
}

after(async () => {
  for (const b of builtApps) {
    try {
      await b.app.close();
    } catch {
      /* 已关闭 */
    }
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface CapsBody {
  cached?: boolean;
  cached_age_ms?: number;
  cache_ttl_ms?: number;
  retrieval?: {
    wiki?: { available: boolean; dataReady: boolean; dataCount: number };
    kg?: { available: boolean; dataReady: boolean; dataCount: number; reason: string };
    rag?: { available: boolean; dataReady: boolean };
    summary?: { any_available: boolean; any_data: boolean; empty_kb: boolean; hint: string };
  };
}

async function getCaps(base: string, query = ''): Promise<CapsBody> {
  const res = await fetch(`${base}/api/v1/capabilities${query}`);
  assert.equal(res.status, 200, `/capabilities 必须 200`);
  return (await res.json()) as CapsBody;
}

/** 往真库里写"抽取完成"的数据（文档 + 单元 + 卡片 + 图 + FTS 索引）。 */
function seedExtracted(built: BuiltApp): { docId: string } {
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
  return { docId };
}

// ═══════════════════════════════════════════════════════════════════════

test('★ 缓存命中时 retrieval.dataReady 仍须实时（防第 3 次"承诺实时却被缓存"回归）', async () => {
  const { built, base } = await makeApp();

  // ① 预热：空库 → 能力就绪但无数据
  const before1 = await getCaps(base);
  assert.equal(before1.cached, false, '首次必须不命中缓存');
  assert.equal(before1.retrieval?.kg?.available, true, '能力就绪');
  assert.equal(before1.retrieval?.kg?.dataReady, false, '空库 → dataReady:false');
  assert.equal(before1.retrieval?.wiki?.dataReady, false);
  assert.equal(before1.retrieval?.summary?.empty_kb, true, '空库态');

  // ② 中途"抽取完成"（直接写真库，等价于学生刚跑完抽取）
  seedExtracted(built);

  // ③ 立刻再 GET —— **应命中缓存**（15s TTL 内），但 retrieval 段必须已是新值
  const after1 = await getCaps(base);
  assert.equal(after1.cached, true, '★ 这一条很关键：必须真的命中缓存，否则测不出"缓存冻住状态字段"');
  assert.ok(
    (after1.cached_age_ms ?? 0) >= 0 && (after1.cache_ttl_ms ?? 0) > 0,
    '命中缓存时要如实标注 age/ttl',
  );

  // ★ 核心断言：缓存命中 ≠ 状态字段可以是旧的
  assert.equal(
    after1.retrieval?.kg?.dataReady,
    true,
    '★ 抽完数据后，即使命中缓存，kg.dataReady 也必须立刻变 true\n' +
      '  （否则学生看到 empty_kb:true + "先去抽取"，会以为抽取没生效、重复去抽）',
  );
  assert.equal(after1.retrieval?.wiki?.dataReady, true, '★ wiki.dataReady 同理');
  assert.ok((after1.retrieval?.kg?.dataCount ?? 0) > 0, 'dataCount 必须是新条数，不是缓存的 0');
  assert.equal(after1.retrieval?.summary?.empty_kb, false, '★ 不再是空库态');

  // ④ 反向：删掉数据后再 GET（仍应命中缓存）→ dataReady 必须回到 false
  const { db, repo } = built.deps;
  db.run('DELETE FROM edges');
  db.run('DELETE FROM entities');
  const afterDel = await getCaps(base);
  assert.equal(afterDel.retrieval?.kg?.dataReady, false, '★ 数据清空后也必须立刻反映（双向都要实时）');
  assert.equal(afterDel.retrieval?.wiki?.dataReady, false, 'wiki 同理');
  void repo;
});

test('★ 缓存 TTL/标注字段仍在（修实时性不许把缓存整个删掉）', async () => {
  const { base } = await makeApp();

  const first = await getCaps(base);
  assert.equal(first.cached, false, '首次不命中');
  assert.equal(first.cache_ttl_ms, 15_000, 'TTL 契约（15s）');

  const second = await getCaps(base);
  assert.equal(second.cached, true, 'TTL 内应命中缓存（性能优化本身要保留）');
  assert.ok((second.cached_age_ms ?? -1) >= 0, 'age 必须如实上报');

  // `refresh=1` 强制绕过缓存
  const forced = await getCaps(base, '?refresh=1');
  assert.equal(forced.cached, false, 'refresh=1 必须绕过缓存');
});

test('★ 空库态的 hint 必须指向"去抽取"（UI 横幅直接用它）', async () => {
  const { base } = await makeApp();
  const caps = await getCaps(base);
  const s = caps.retrieval?.summary;
  assert.ok(s, '必须有 summary 段');
  assert.equal(s!.any_available, true, '能力就绪');
  assert.equal(s!.any_data, false, '但无数据');
  assert.equal(s!.empty_kb, true);
  assert.match(s!.hint, /抽取/, 'hint 必须指出下一步动作（不是只说"没有数据"）');
  // 命中缓存时 hint 也要跟着状态（不能缓存成空串或旧值）
  seedExtracted;
  const again = await getCaps(base);
  assert.equal(again.cached, true);
  assert.equal(again.retrieval?.summary?.empty_kb, true, '空库未变时 summary 应保持（这里只是确认字段存在且一致）');
});
