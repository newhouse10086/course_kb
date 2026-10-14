/**
 * 真实端到端：在**真文档副本**上跑 rollup（真 worker + 真 LLM），产出可核实数字。
 *
 * 为什么不直接在 data/course_kb.sqlite3 上跑：那是 shared dev DB（backend-api 也在用）。
 * 这里先复制一份到临时库，跑完打印数字并删掉 —— **无副作用**。
 *
 * 用法：
 *   node _wa_real_rollup.mjs [maxNodes]     # 省略 = 全量（376 个内部节点）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from './src/config.ts';
import { Db } from './src/store/db.ts';
import { Repo } from './src/store/repo.ts';
import { WorkerClient } from './src/worker/client.ts';
import { createWorkerRunner } from './src/worker/runner.ts';
import { createRollupHandler, buildTree, internalNodes } from './src/tasks/rollup.ts';

const maxNodes = Number(process.argv[2] ?? 0);

const cfg = loadConfig();
const srcDb = cfg.dbPath;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-real-rollup-'));
const dbPath = path.join(tmp, 'copy.sqlite3');
// WAL 模式下要一起拷 -wal/-shm，否则可能丢最新事务
for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(srcDb + suffix)) fs.copyFileSync(srcDb + suffix, dbPath + suffix);
}
console.log('源库:', srcDb);
console.log('副本:', dbPath);

const db = Db.open(dbPath);
const repo = new Repo(db);

const docRow = repo.listDocuments({ limit: 1 }).documents[0];
if (!docRow) throw new Error('库里没有文档');
const docId = docRow.id;
const units = repo.allUnitRows(docId);
const nodes = buildTree(units);
console.log(`文档 ${docId}  标题=${docRow.title.slice(0, 50)}`);
console.log(`units=${units.length}  内部节点=${internalNodes(nodes).length}  cards=${repo.counts(docId).cards}`);

// ── provider 层（真 LLM）──
const { createProviderLayer } = await import('./src/providers/index.ts');
const workerClient = new WorkerClient({
  pythonBin: cfg.pythonBin,
  workerModule: cfg.workerModule,
  cwd: cfg.root,
  timeoutMs: cfg.workerTimeoutMs,
});
const runner = createWorkerRunner(workerClient);
const providers = createProviderLayer({ config: cfg.providers, runWorker: runner });

const caps = await providers.capabilities({ deep: true });
const llmList = (caps.providers?.llm ?? []);
console.log('LLM provider:', JSON.stringify(llmList.map((p) => ({ id: p.id, configured: p.configured, available: p.available }))));

// ── 真 worker 探测 rollup.plan 是否已注册 ──
try {
  const probe = await runner({ job: 'rollup.plan', input: { nodes: [] } });
  console.log('worker rollup.plan 可用 ✅', JSON.stringify({ keys: Object.keys(probe), items: (probe.items ?? []).length }));
} catch (err) {
  console.log('worker rollup.plan 不可用 ❌', err instanceof Error ? err.message : String(err));
}

// ── 真跑 ──
const handler = createRollupHandler({
  repo,
  db,
  cfg,
  runner,
  completeJson: (req) => providers.completeJson(req),
  availability: async () => {
    const c = await providers.capabilities({ deep: true });
    const llm = (c.providers?.llm ?? []).find((p) => p.available === true);
    return llm ? { ok: true, reason: '' } : { ok: false, reason: (c.providers?.llm ?? [])[0]?.reason ?? '无可用 LLM' };
  },
  ...(maxNodes > 0 ? { maxNodesPerRun: maxNodes } : {}),
});

const t0 = Date.now();
const events = [];
const ctx = {
  taskId: 'real',
  docId,
  kind: 'rollup',
  params: {},
  signal: new AbortController().signal,
  progress: (frac, stage, detail) => {
    events.push({ frac: Math.round(frac * 100) / 100, stage, detail });
    if (events.length % 20 === 0) {
      process.stdout.write(`  [${Math.round(frac * 100)}%] ${stage}\n`);
    }
  },
  log: (msg) => console.log('  LOG:', msg),
  artifact: () => {},
};

const out = await handler(ctx);
const secs = ((Date.now() - t0) / 1000).toFixed(0);

console.log('\n═══ rollup 真实结果 ═══');
console.log(JSON.stringify(out, null, 1));
console.log(`\n耗时 ${secs}s  进度事件 ${events.length}`);

// ── 落库核对（不是只看返回值）──
const after = JSON.parse(repo.getDocumentRow(docId).meta_json ?? '{}');
// ⚠️ 不能命名 `rollup`：本文件顶层已 import 了模块 `./src/tasks/rollup.ts` 的同名绑定
const rollupMap = after.rollup ?? {};
const realNodes = internalNodes(nodes);
let withIntro = 0;
let llmSrc = 0;
let detSrc = 0;
let emptyIntro = 0;
for (const n of realNodes) {
  const e = rollupMap[n.unit.id];
  const intro = typeof e?.intro === 'string' ? e.intro.trim() : '';
  if (intro) withIntro += 1; else emptyIntro += 1;
  if (e?.source === 'llm') llmSrc += 1;
  if (e?.source === 'deterministic') detSrc += 1;
}
console.log('\n═══ 落库核对（meta.rollup）═══');
console.log(`内部节点 ${realNodes.length}  |  有 intro ${withIntro} (${(withIntro / realNodes.length * 100).toFixed(1)}%)  |  空 intro ${emptyIntro}`);
console.log(`source=llm ${llmSrc}  |  source=deterministic ${detSrc}`);
const sampleIds = realNodes.slice(0, 2);
for (const n of sampleIds) {
  const id = n.unit.id;
  const e = rollupMap[id] ?? {};
  console.log(`\n抽样 ${id} (${String(n.unit.title).slice(0, 40)}):`);
  console.log(`  source=${e.source} provider=${e.used_provider ?? '-'} depth=${e.depth}`);
  console.log(`  intro=${String(e.intro ?? '').slice(0, 200)}`);
  console.log(`  why=${String(e.why_important ?? '').slice(0, 150)}`);
  console.log(`  objectives=${JSON.stringify((e.objectives ?? []).slice(0, 3))}`);
}
// 父子命中核对（outline 要能读到）
const ids = new Set(units.map((u) => u.id));
const metaKeys = Object.keys(rollupMap);
console.log(`\nmeta.rollup keys ${metaKeys.length}  |  与 unit id 命中 ${metaKeys.filter((k) => ids.has(k)).length}`);

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n临时副本已清理。');
