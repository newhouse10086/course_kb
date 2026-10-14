/**
 * `translate` 测试（术语表注入 / 标识符保留英文 / 证据句不意译）。
 *
 * 断言**具体值**。重点覆盖三条领域硬要求与两条诚实要求：
 * 1. **术语表必须注入**：交给 provider 的 `glossary` 里必须有 `index→索引`（不注入会译成"指标"）
 * 2. **标识符保留英文**：`InnoDB`/`SELECT`/`sql_mode` **本地就拦下，不问模型**（省 token + 不被译坏）
 * 3. **证据句不意译**：证据条目以 `kind='evidence'` 送出去（provider 侧走"不意译"提示词）
 * 4. **无 provider 时如实失败**，绝不出假译文
 * 5. **断点续跑**：已完成条目不再送翻译
 *
 * 用**假 translate fn**（不真调 LLM）+ **真 SQLite**。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import {
  DB_TERMS,
  collectItems,
  createTranslateHandler,
  readCheckpoint,
  shouldKeepEnglish,
  translateCheckpointPath,
} from '../src/tasks/translate.ts';
import type { TranslateFn, TranslateProviderRequest } from '../src/tasks/translate.ts';
import type { TaskHandlerContext } from '../src/tasks/queue.ts';
import type { ServerConfig } from '../src/config.ts';
import { DEFAULT_DB_GLOSSARY } from '../src/providers/translate/index.ts';

// ═══════════════════════════════════════════════════════════════════════
// 脚手架
// ═══════════════════════════════════════════════════════════════════════

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'translate-test-'));
}
function freshCfg(dir: string): ServerConfig {
  // providers 为空 → 不会走"从配置推导"那条路（测试要显式控制）
  return {
    checkpointsDir: path.join(dir, 'checkpoints'),
    providers: { providers: { translate: [] }, policy: {}, sourcePath: null, warnings: [] },
  } as unknown as ServerConfig;
}
function freshRepo(): { db: Db; repo: Repo } {
  const db = Db.open(':memory:');
  return { db, repo: new Repo(db) };
}

/**
 * 种子：3 个实体名（2 个该译 + 1 个标识符）+ 2 条英文证据句。
 *
 * - `clustered index` → 该译（普通英文词组）
 * - `transaction`     → 该译
 * - `InnoDB`          → 标识符，**必须保留英文**
 */
function seedDoc(repo: Repo): { docId: string; unitId: string } {
  const docId = repo.insertDocument({
    title: '测试文档',
    kind: 'pdf',
    source_path: 'data/uploads/x/a.pdf',
    page_count: 5,
  });
  const ids = repo.replaceUnits(docId, [
    { ord: 1, title: 'S1', level: 1, parent_ord: null, span: { kind: 'page', start: 1, end: 5 }, text: '正文。' },
  ]);
  const unitId = ids[0] as string;
  repo.replaceCards(docId, [
    { unit_id: unitId, name: 'c1', kind: 'concept', evidence_quote: 'Clustered indexes sort rows by key.' },
    { unit_id: unitId, name: 'c2', kind: 'concept', evidence_quote: 'InnoDB provides MVCC.' },
  ]);
  repo.replaceGraph(
    docId,
    [
      { name: 'clustered index', type: 'concept' },
      { name: 'transaction', type: 'concept' },
      { name: 'InnoDB', type: 'product' },
    ],
    [],
  );
  return { docId, unitId };
}

function makeCtx(docId: string): { ctx: TaskHandlerContext; events: { frac: number; stage: string }[] } {
  const events: { frac: number; stage: string }[] = [];
  const ac = new AbortController();
  return {
    ctx: {
      taskId: 't1',
      docId,
      kind: 'translate',
      params: {},
      signal: ac.signal,
      progress: (frac, stage) => events.push({ frac, stage }),
      log: () => {},
      artifact: () => {},
    },
    events,
  };
}

/** 假 translate：把英文包成 `<zh:原文>`，并记录每次请求（术语表是否注入要断言）。 */
function fakeTranslate(rec: { calls: TranslateProviderRequest[] }): TranslateFn {
  return async (req) => {
    rec.calls.push(req);
    return {
      // 保留英文的原样回传（provider 层就是这么做的）
      items: req.items.map((it) => ({ id: it.id, text: `<zh:${it.text}>`, keptAsIs: false })),
      usedProvider: 'llm-mt',
    };
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 纯函数
// ═══════════════════════════════════════════════════════════════════════

test('DB_TERMS 是 provider 层术语表的**转发**（不是第二份副本）', () => {
  // ★ 单一真相：对象**同一个引用**。抄一份必然漂移 —— 这是故意断言的。
  assert.equal(DB_TERMS, DEFAULT_DB_GLOSSARY);
  // 实测关心的那几条必须在（不注入会把 index 译成"指标"）
  assert.equal(DB_TERMS.index, '索引');
  assert.equal(DB_TERMS.view, '视图');
  assert.equal(DB_TERMS.transaction, '事务');
});

test('shouldKeepEnglish：标识符保留英文，普通词组要译', () => {
  // 保留（标识符 / 产品名 / 全大写 / 白名单）
  assert.equal(shouldKeepEnglish('InnoDB'), true);
  assert.equal(shouldKeepEnglish('sql_mode'), true);
  assert.equal(shouldKeepEnglish('SELECT'), true);
  assert.equal(shouldKeepEnglish('MyISAM'), true);
  assert.equal(shouldKeepEnglish('utf8'), true);
  assert.equal(shouldKeepEnglish('索引'), true, '已含中文 → 无需译');
  assert.equal(shouldKeepEnglish('MyThing', ['mything']), true, '白名单命中');
  // 该译（普通英文词组/单词）
  assert.equal(shouldKeepEnglish('clustered index'), false);
  assert.equal(shouldKeepEnglish('transaction'), false);
  assert.equal(shouldKeepEnglish('Table'), false, '仅 1 个大写不算产品名');
  assert.equal(shouldKeepEnglish('data warehouse'), false);
});

test('collectItems：实体名 + 证据句两类；去重；已含中文的跳过', () => {
  const { repo } = freshRepo();
  const { docId } = seedDoc(repo);
  const { items, stats } = collectItems(repo, docId);

  assert.equal(stats.terms, 3);
  assert.equal(stats.evidences, 2);
  assert.equal(items.length, 5);

  const terms = items.filter((i) => i.kind === 'term').map((i) => i.text).sort();
  assert.deepEqual(terms, ['InnoDB', 'clustered index', 'transaction'].sort());
  const evids = items.filter((i) => i.kind === 'evidence').map((i) => i.text).sort();
  assert.deepEqual(evids, ['Clustered indexes sort rows by key.', 'InnoDB provides MVCC.'].sort());
  // 已含中文的实体不再收集
  repo.db.run("UPDATE entities SET name_zh = '事务' WHERE name = 'transaction'");
  assert.equal(collectItems(repo, docId).stats.terms, 2);
});

test('readCheckpoint：坏数据不抛，返回空断点', () => {
  assert.deepEqual(readCheckpoint(null, 'd1').done, {});
  assert.deepEqual(readCheckpoint({ done: 'bad' }, 'd1').done, {});
  const cp = readCheckpoint({ done: { a: { text: 'X', kept: false, at: 5 }, b: { nope: 1 } } }, 'd1');
  assert.deepEqual(Object.keys(cp.done), ['a']);
  assert.equal(cp.done.a!.text, 'X');
});

// ═══════════════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════════════

test('★ 术语表**必须注入**；标识符本地拦下不问模型；证据句带 kind=evidence', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const { docId } = seedDoc(repo);
  const rec = { calls: [] as TranslateProviderRequest[] };

  const handler = createTranslateHandler({
    repo, db: repo.db, cfg: freshCfg(dir), translate: fakeTranslate(rec),
  });
  const out = (await handler(makeCtx(docId).ctx)) as { translate: Record<string, unknown> };
  const r = out.translate;

  // ★ 术语表注入：`index → 索引` 必须在里面（否则会译成"指标"）
  assert.equal(rec.calls.length, 1);
  const first = rec.calls[0]!;
  assert.equal(first.to, 'zh');
  assert.equal(first.glossary?.index, '索引');
  assert.equal(first.glossary?.transaction, '事务');
  assert.equal(first.glossary?.view, '视图');

  // ★ 标识符 InnoDB **不在**送译列表里（本地拦下）
  const sentTexts = first.items.map((i) => i.text);
  assert.deepEqual(sentTexts.sort(), ['clustered index', 'transaction', 'Clustered indexes sort rows by key.', 'InnoDB provides MVCC.'].sort());
  assert.equal(sentTexts.includes('InnoDB'), false, 'InnoDB 是标识符，不该问模型');

  // ★ 证据句带 kind='evidence'（provider 侧据此走"不意译"提示词）
  const evidItem = first.items.find((i) => i.text.startsWith('Clustered indexes'));
  assert.equal(evidItem?.kind, 'evidence');
  const termItem = first.items.find((i) => i.text === 'clustered index');
  assert.equal(termItem?.kind, 'term');

  // 统计：5 条里 1 条保留英文（InnoDB），4 条译出
  assert.equal(r.items_total, 5);
  assert.equal(r.kept_english, 1);
  assert.equal(r.translated, 4);
  assert.equal(r.kept_ratio, 1 / 5);
  assert.equal(r.translated_ratio, 4 / 5);
  assert.equal(r.glossary_terms, Object.keys(DB_TERMS).length);
  assert.equal(r.provider, 'llm-mt');
  // 落库：2 个实体名译出（InnoDB 保留英文 → 不写 name_zh）+ 2 条证据译文
  assert.deepEqual(r.persisted, { entities: 2, evidences: 2 });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ 回写：实体名进 name_zh；证据译文进 meta 且**不覆盖英文原文**', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const { docId } = seedDoc(repo);

  const handler = createTranslateHandler({
    repo, db: repo.db, cfg: freshCfg(dir), translate: fakeTranslate({ calls: [] }),
  });
  await handler(makeCtx(docId).ctx);

  // ① 实体 name_zh 已被写入
  const ents = repo.db.all<{ name: string; name_zh: string }>('SELECT name, name_zh FROM entities WHERE doc_id = ? ORDER BY name', docId);
  const map = new Map(ents.map((e) => [e.name, e.name_zh]));
  assert.equal(map.get('clustered index'), '<zh:clustered index>');
  assert.equal(map.get('transaction'), '<zh:transaction>');
  assert.equal(map.get('InnoDB'), '', 'InnoDB 保留英文 → name_zh 留空（不是被译）');

  // ② 证据译文进 meta
  const meta = JSON.parse(repo.getDocumentRow(docId)!.meta_json) as { translations_evidence: Record<string, string> };
  const vals = Object.values(meta.translations_evidence);
  assert.equal(vals.length, 2);
  assert.equal(vals.includes('<zh:Clustered indexes sort rows by key.>'), true);

  // ③ ★ 英文原文**必须保留**（证据是可核查的引用）
  const cards = repo.allCardRows(docId);
  assert.equal(cards.find((c) => c.name === 'c1')!.evidence_quote, 'Clustered indexes sort rows by key.');
  assert.equal(cards.find((c) => c.name === 'c2')!.evidence_quote, 'InnoDB provides MVCC.');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ 无 provider：**如实失败**（不出假译文），且 detail 说清保留了几条', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const { docId } = seedDoc(repo);

  const handler = createTranslateHandler({
    repo, db: repo.db, cfg: freshCfg(dir), translate: null,
  });

  // 有"必须译"的条目却无 provider → 抛 E_LLM（不假装成功）
  await assert.rejects(
    () => handler(makeCtx(docId).ctx),
    (err: unknown) => {
      const e = err as { code?: string; message?: string; hint?: string; detail?: string };
      assert.equal(e.code, 'E_LLM');
      assert.match(String(e.message), /翻译不可用/);
      assert.match(String(e.detail), /待译 4 条/);
      assert.match(String(e.detail), /保留英文 1 条/);
      return true;
    },
  );

  // ★ 没有写入任何假译文
  const ents = repo.db.all<{ name_zh: string }>('SELECT name_zh FROM entities WHERE doc_id = ?', docId);
  assert.deepEqual(ents.map((e) => e.name_zh), ['', '', '']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ 无 provider 但全部条目都该保留英文 → 成功且如实报 0 译', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const docId = repo.insertDocument({ title: 'x', kind: 'pdf', source_path: 'p', page_count: 1 });
  const ids = repo.replaceUnits(docId, [
    { ord: 1, title: 'S1', level: 1, parent_ord: null, span: { kind: 'page', start: 1, end: 1 }, text: 't' },
  ]);
  repo.replaceCards(docId, []);
  // 全是标识符 → 无需翻译
  repo.replaceGraph(docId, [
    { name: 'InnoDB', type: 'product' },
    { name: 'SELECT', type: 'feature' },
  ], []);
  void ids;

  const handler = createTranslateHandler({
    repo, db: repo.db, cfg: freshCfg(dir), translate: null,
  });
  const out = (await handler(makeCtx(docId).ctx)) as { translate: Record<string, unknown> };
  assert.equal(out.translate.provider_available, false);
  assert.equal(out.translate.items_total, 2);
  assert.equal(out.translate.kept_english, 2);
  assert.equal(out.translate.translated, 0);
  assert.equal(out.translate.kept_ratio, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ 断点续跑：已完成条目**不再送翻译**', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const { docId } = seedDoc(repo);

  // 第一轮：跑完
  const rec1 = { calls: [] as TranslateProviderRequest[] };
  const h1 = createTranslateHandler({ repo, db: repo.db, cfg: freshCfg(dir), translate: fakeTranslate(rec1) });
  const out1 = (await h1(makeCtx(docId).ctx)) as { translate: Record<string, unknown> };
  assert.equal(out1.translate.translated, 4);

  const cpPath = translateCheckpointPath(freshCfg(dir), docId);
  assert.equal(fs.existsSync(cpPath), true);
  const cp = JSON.parse(fs.readFileSync(cpPath, 'utf8')) as { done: Record<string, { kept: boolean }> };
  assert.equal(Object.keys(cp.done).length, 5);
  // InnoDB 那条 kept=true
  assert.equal(Object.values(cp.done).filter((d) => d.kept).length, 1);

  // 第二轮：**不该再调 translate**
  const rec2 = { calls: [] as TranslateProviderRequest[] };
  const h2 = createTranslateHandler({ repo, db: repo.db, cfg: freshCfg(dir), translate: fakeTranslate(rec2) });
  const out2 = (await h2(makeCtx(docId).ctx)) as { translate: Record<string, unknown> };
  assert.equal(rec2.calls.length, 0, '全部已完成 → 不应再调 provider');

  // ★ 第二轮的**采集范围会缩小**：已译好的实体名（`name_zh` 非空）不再进待译列表。
  //   这是**幂等**的正确表现，不是数据丢失。
  //   剩下 3 条 = 1 个实体（InnoDB，保留英文 → `name_zh` 仍为空 → 仍会被采集）+ 2 条证据句。
  assert.equal(out2.translate.items_total, 3, '2 个已译实体不再被采集；InnoDB 仍在内（它本来就保留英文）');
  assert.equal(out2.translate.kept_english, 1, 'InnoDB 仍判为保留英文');
  assert.equal(out2.translate.translated, 2, '2 条证据句已在断点里，直接算已完成');
  // 库里译文**没被第二轮改坏**
  const map2 = new Map(
    repo.db.all<{ name: string; name_zh: string }>('SELECT name, name_zh FROM entities WHERE doc_id = ?', docId)
      .map((e) => [e.name, e.name_zh]),
  );
  assert.equal(map2.get('clustered index'), '<zh:clustered index>');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ provider 漏回条目 → 该批失败并如实记录（不许静默丢条目）', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const { docId } = seedDoc(repo);

  const badTranslate: TranslateFn = async (req) => ({
    // 故意只回一半
    items: req.items.slice(0, 1).map((it) => ({ id: it.id, text: `<zh:${it.text}>` })),
    usedProvider: 'llm-mt',
  });

  const handler = createTranslateHandler({ repo, db: repo.db, cfg: freshCfg(dir), translate: badTranslate });
  const out = (await handler(makeCtx(docId).ctx)) as { translate: Record<string, unknown> };
  const r = out.translate;

  assert.equal(r.failed, 4, '4 条送译全部失败（缺 id 判定为整批失败）');
  assert.equal(r.translated, 0);
  assert.equal(r.kept_english, 1);
  assert.match(String((r.failures as string[])[0]), /缺 3 条/);

  // 没有写进假译文
  const ents = repo.db.all<{ name_zh: string }>('SELECT name_zh FROM entities WHERE doc_id = ? ORDER BY name', docId);
  assert.deepEqual(ents.map((e) => e.name_zh), ['', '', '']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('batchSize 生效：4 条该译条目按 2 条一批 → 2 次调用', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const { docId } = seedDoc(repo);
  const rec = { calls: [] as TranslateProviderRequest[] };

  const handler = createTranslateHandler({
    repo, db: repo.db, cfg: freshCfg(dir), translate: fakeTranslate(rec), batchSize: 2,
  });
  await handler(makeCtx(docId).ctx);

  assert.equal(rec.calls.length, 2);
  assert.deepEqual(rec.calls.map((c) => c.items.length), [2, 2]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('已含中文的 name_zh **不被覆盖**（人工/上游优先）', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const { docId } = seedDoc(repo);
  repo.db.run("UPDATE entities SET name_zh = '人工译名' WHERE name = 'transaction'");

  const handler = createTranslateHandler({
    repo, db: repo.db, cfg: freshCfg(dir), translate: fakeTranslate({ calls: [] }),
  });
  await handler(makeCtx(docId).ctx);

  const row = repo.db.get<{ name_zh: string }>('SELECT name_zh FROM entities WHERE name = ?', 'transaction');
  assert.equal(row!.name_zh, '人工译名');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('★★ 回归：以 `.` 结尾的**证据句必须被翻译**（不被误判成标识符而整条保留）', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const { docId } = seedDoc(repo);
  const rec = { calls: [] as TranslateProviderRequest[] };

  const handler = createTranslateHandler({
    repo, db: repo.db, cfg: freshCfg(dir), translate: fakeTranslate(rec),
  });
  const out = (await handler(makeCtx(docId).ctx)) as { translate: Record<string, unknown> };

  // 两条证据句都以 `.` 结尾。
  // ⚠️ 原错误行为：对证据句也套 `shouldKeepEnglish`，而标识符规则含 `.` 字符
  //    → 判为"标识符" → `kept=true` → **整条不译**，任务"成功但什么都没做"（静默空转）。
  //    正确行为：证据句要译（只是"不意译"），所以它们必须出现在送译列表里。
  const sent = rec.calls[0]!.items.map((i) => i.text);
  assert.equal(sent.includes('Clustered indexes sort rows by key.'), true, '证据句必须送译');
  assert.equal(sent.includes('InnoDB provides MVCC.'), true, '证据句必须送译');
  assert.equal(sent.filter((t) => t.endsWith('.')).length, 2, '两条证据句都在送译列表里');

  assert.equal(out.translate.kept_english, 1, '只有实体名 InnoDB 两条规则保留');
  assert.equal(out.translate.translated, 4);

  // 证据译文确实落进了 meta
  const meta = JSON.parse(repo.getDocumentRow(docId)!.meta_json) as { translations_evidence: Record<string, string> };
  assert.equal(Object.keys(meta.translations_evidence).length, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('缺少 doc_id / 文档不存在 → E_NOTFOUND', async () => {
  const { repo } = freshRepo();
  const handler = createTranslateHandler({
    repo, db: repo.db, cfg: freshCfg(tmpDir()), translate: fakeTranslate({ calls: [] }),
  });
  await assert.rejects(() => handler({ ...makeCtx('x').ctx, docId: null }), /缺少 doc_id/);
  await assert.rejects(() => handler(makeCtx('doc_missing').ctx), /文档不存在/);
});
