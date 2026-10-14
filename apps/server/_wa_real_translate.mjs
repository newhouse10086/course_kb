/**
 * 真实端到端：在**真文档副本**上跑 translate（真 LLM + 术语表注入），产出可核实数字。
 *
 * 为什么在副本上跑：`data/course_kb.sqlite3` 是 shared dev DB。**无副作用**。
 *
 * 需要文档里已有 entities / cards（英文证据句）。若没有，脚本会如实报告"无可译条目"。
 *
 * 用法：node _wa_real_translate.mjs [maxItems]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from './src/config.ts';
import { Db } from './src/store/db.ts';
import { Repo } from './src/store/repo.ts';
import { WorkerClient } from './src/worker/client.ts';
import { createWorkerRunner } from './src/worker/runner.ts';
import {
  collectItems, createTranslateHandler, shouldKeepEnglish, DB_TERMS,
} from './src/tasks/translate.ts';

const maxItems = Number(process.argv[2] ?? 0);

const cfg = loadConfig();
const srcDb = cfg.dbPath;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-real-tr-'));
const dbPath = path.join(tmp, 'copy.sqlite3');
for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(srcDb + suffix)) fs.copyFileSync(srcDb + suffix, dbPath + suffix);
}

const db = Db.open(dbPath);
const repo = new Repo(db);
const docRow = repo.listDocuments({ limit: 1 }).documents[0];
if (!docRow) throw new Error('库里没有文档');
const docId = docRow.id;

const counts = repo.counts(docId);
console.log(`文档 ${docId}  units=${counts.units} cards=${counts.cards} entities=${counts.entities}`);

// ── 采集范围（本地，不花钱）──
const { items, stats } = collectItems(repo, docId);
console.log('采集:', JSON.stringify(stats));
const byKind = { term: 0, evidence: 0 };
const keepLocal = { term: 0, evidence: 0 };
for (const it of items) {
  byKind[it.kind] += 1;
  // 与实现同规则：term 用 shouldKeepEnglish；evidence 只在已含中文时保留
  const kept = it.kind === 'evidence' ? /[\u4e00-\u9fff]/.test(it.text) : shouldKeepEnglish(it.text);
  if (kept) keepLocal[it.kind] += 1;
}
console.log(`待译条目 term=${byKind.term} evidence=${byKind.evidence}`);
console.log(`本地判定保留英文 term=${keepLocal.term}/${byKind.term} evidence=${keepLocal.evidence}/${byKind.evidence}`);
console.log(`术语表 ${Object.keys(DB_TERMS).length} 条`);

if (items.length === 0) {
  console.log('\n⚠️ 该文档没有可译条目（entities/cards 为空）→ 无法给出翻译真实数字。');
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

// ── provider 层（真 LLM）──
const { createProviderLayer } = await import('./src/providers/index.ts');
const workerClient = new WorkerClient({
  pythonBin: cfg.pythonBin, workerModule: cfg.workerModule, cwd: cfg.root, timeoutMs: cfg.workerTimeoutMs,
});
const providers = createProviderLayer({ config: cfg.providers, runWorker: createWorkerRunner(workerClient) });

const handler = createTranslateHandler({
  repo, db, cfg,
  // ★ 用 provider 门面的 translate（领域规则的唯一实现处），不自己组提示词
  translate: (req) => providers.translate(req),
  ...(maxItems > 0 ? { maxItemsPerRun: maxItems } : {}),
});

const t0 = Date.now();
const events = [];
const ctx = {
  taskId: 'real',
  docId,
  kind: 'translate',
  params: {},
  signal: new AbortController().signal,
  progress: (frac, stage) => {
    events.push({ frac, stage });
    process.stdout.write(`  [${Math.round(frac * 100)}%] ${stage}\n`);
  },
  log: (msg) => console.log('  LOG:', msg),
  artifact: () => {},
};

const out = await handler(ctx);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log('\n═══ translate 真实结果 ═══');
console.log(JSON.stringify(out, null, 1));
console.log(`\n耗时 ${secs}s  进度事件 ${events.length}`);

// ── 落库核对 ──
const ents = db.prepare('SELECT name, name_zh FROM entities WHERE doc_id=? ORDER BY name').all(docId);
const filled = ents.filter((e) => (e.name_zh ?? '').trim() !== '');
console.log('\n═══ 落库核对 ═══');
console.log(`entities ${ents.length}  写入 name_zh ${filled.length} (${(filled.length / Math.max(1, ents.length) * 100).toFixed(1)}%)`);
console.log('抽样（前 12 条）：');
for (const e of ents.slice(0, 12)) {
  console.log(`  ${JSON.stringify(e.name).padEnd(46)} → ${JSON.stringify(e.name_zh)}`);
}
const meta = JSON.parse(repo.getDocumentRow(docId).meta_json ?? '{}');
const evTr = meta.translations_evidence ?? {};
console.log(`\ntranslations_evidence ${Object.keys(evTr).length} 条`);
const evKeys = Object.keys(evTr).slice(0, 3);
for (const k of evKeys) console.log(`  ${k} → ${String(evTr[k]).slice(0, 80)}`);
// 英文原文是否保留（不能被覆盖）
const cards = repo.allCardRows(docId);
const englishKept = cards.filter((c) => (c.evidence_quote ?? '') !== '' && !/[\u4e00-\u9fff]/.test(c.evidence_quote)).length;
console.log(`\n证据英文原文**仍在 cards.evidence_quote** 的条数：${englishKept} / cards ${cards.length}（应为全部，译文只进 meta）`);

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n临时副本已清理。');
