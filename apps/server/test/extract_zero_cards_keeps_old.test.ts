/**
 * ★★ **抽取产出 0 卡片时不许覆盖旧产物**（机制 1，(b) 守卫）—— 与机制 2 是**两条**独立的清卡路径。
 *
 * ## 机制 1（本文件守它）
 * `handlers.ts` 抽取成功后**无条件**全量替换：`repo.replaceGraph(...)` + `repo.replaceCards(docId, result.cards)`。
 * 于是"抽取产出 0 卡片"（空正文 → 上游 HTTP 400 → worker `partial`/`failed`）会**清掉旧卡片**。
 *
 * ## 判据（★ 全零 LLM：注入 `createWorkerExtractor` + 替身 runner/LLM，**不发任何网络请求**）
 * - ① **0 卡片 + 有失败 → 抛错** → 上层**不动**旧 cards/图谱 + meta 如实标 `failed` + 可读 reason
 * - ② **0 卡片 + 无失败（worker `done_empty`：内容确实没有知识点）→ 照常替换**（不是失败，别误伤）
 * - ③ **有卡片 + 有失败（partial）→ 照常入库**（已产出的是真进度）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { buildApp } from '../src/index.ts';
import type { BuiltApp } from '../src/index.ts';
import { loadConfig } from '../src/config.ts';
import { createWorkerExtractor } from '../src/tasks/extract.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
let tmp = '';
let built: BuiltApp | null = null;
let adminId = '';
let docId = '';
let unitId = '';

/** 替身 worker：只回答 plan / convert 两个 job（不启动真子进程 → 快且零额度） */
let convertResult: Record<string, unknown> = {};
const fakeRunner = {
  raw: async (job: { job: string }): Promise<unknown> => {
    if (job.job === 'extract.plan') {
      return {
        ok: true,
        result: {
          schema: { type: 'object', properties: { cards: { type: 'array', items: { type: 'object' } } } },
          pick: {},
          items: [
            {
              key: `${unitId}#char:0-10`,
              unit_key: `1#char:0-10`,
              unit_id: unitId,
              unit_ord: 1,
              system: '你是抽取器',
              user: '## 手册原文\n索引是加速查询的数据结构。\n\n## 输出\n严格按 JSON schema。',
            },
          ],
        },
      };
    }
    if (job.job === 'extract.convert') return { ok: true, result: convertResult };
    return { ok: false, error: { code: 'E_JOB_UNKNOWN', msg: `未预期的 job ${job.job}` } };
  },
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-cards-'));
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DB: path.join(tmp, 't.sqlite3'),
      COURSE_KB_DATA_DIR: path.join(tmp, 'data'),
      COURSE_KB_SETTINGS_FILE: path.join(tmp, 'settings.json'),
      COURSE_KB_BOOTSTRAP_ADMIN: 'admin:zero-cards-1',
      COURSE_KB_AUTO_EXTRACT: '0',
    } as Record<string, string>,
  });
  // ★ 注入"真 extractor + 替身 deps"：守卫（在 extract.ts 里）被真正执行，但不发网络请求
  const extractor = createWorkerExtractor({
    runner: fakeRunner as never,
    completeJson: (async () => ({ data: {}, raw: '{}', usedProvider: 'spy' })) as never,
  });
  built = await buildApp({ cfg, extractor });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const repo = built.deps.repo;
  adminId = repo.rbac.getUserRowByName('admin')!.id;

  const src = path.join(tmp, 'a.txt');
  fs.writeFileSync(src, '索引是加速查询的数据结构。', 'utf8');
  docId = repo.insertDocument({
    title: '零卡片保旧', kind: 'txt', source_path: src, status: 'ready', ownerId: adminId,
    visibility: 'public', reviewStatus: 'published',
  });
  unitId = 'unt_seed_1';
  repo.db.run(
    `INSERT INTO units(id,doc_id,ord,title,text,text_len,span_kind,span_start,span_end) VALUES(?,?,?,?,?,?,?,?,?)`,
    unitId, docId, 1, '索引', '索引是加速查询的数据结构。', 13, 'char', 0, 13,
  );
});

after(async () => {
  try {
    if (built) await built.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows 偶发占用 */
  }
});

const TERMINAL = ['done', 'failed', 'cancelled', 'partial', 'done_empty'];
async function runExtract(ms = 120_000) {
  const taskId = built!.deps.queue.enqueue({ docId, kind: 'extract', userId: adminId, params: {} });
  const dl = Date.now() + ms;
  let t = built!.deps.repo.getTask(taskId);
  while (t && !TERMINAL.includes(t.status) && Date.now() < dl) {
    await new Promise((x) => setTimeout(x, 200));
    t = built!.deps.repo.getTask(taskId);
  }
  return t;
}
const cardsOf = () => built!.deps.repo.listCards(docId, { offset: 0, limit: 50 });
const meta = (): Record<string, unknown> => {
  const row = built!.deps.repo.getDocumentRow(docId) as { meta_json?: string } | undefined;
  try {
    return JSON.parse(String(row?.meta_json ?? '{}')) as Record<string, unknown>;
  } catch {
    return {};
  }
};
function seedOldCards(n = 2): string[] {
  const drafts = Array.from({ length: n }, (_, i) => ({
    unit_id: unitId, name: `旧卡片${i + 1}`, kind: 'concept', one_line: 'o', purpose: 'p',
    usage_mode: 'unknown', operational_role: 'unknown', lifecycle: 'unknown',
    example: null, example_explained: null, prerequisites: [], cautions: [],
    evidence_quote: '索引是加速查询的数据结构', evidence_span: { kind: 'char', start: 0, end: 12 },
    confidence: 0.9,
  }));
  const ids = built!.deps.repo.replaceCards(docId, drafts as never);
  built!.deps.repo.mergeDocumentMeta(docId, { extract_status: 'done' });
  return ids;
}

test('① ★★ 0 卡片 + 有失败 → **不覆盖**旧卡片（机制 1）+ meta 如实标失败', async () => {
  const before = seedOldCards(2);
  assert.equal(cardsOf().total, 2, '前置：应有 2 张旧卡片');

  convertResult = {
    cards: [], entities: [], edges: [], sections: {},
    status: 'partial', ok: false, error_count: 1,
    errors: [{ msg: 'E_LLM: HTTP 400（输入正文为空）' }],
  };
  const t = await runExtract();

  assert.equal(t?.status, 'failed', `★ 0 卡片且有失败 → 任务必须 failed（实际 ${t?.status}）`);
  const after = cardsOf();
  assert.equal(after.total, 2, `★ 不许覆盖旧卡片（机制 1）：期望 2 张，实际 ${after.total} 张`);
  assert.deepEqual(after.cards.map((c) => c.id).sort(), [...before].sort(), '★ 卡片 id 必须一模一样');
  const m = meta();
  assert.equal(m.extract_status, 'failed', '★ meta 必须如实标 failed');
  assert.match(String(m.extract_error ?? ''), /不覆盖|未产出任何卡片/, `★ 必须留可读原因（实际 ${String(m.extract_error)}）`);
});

test('② ★ 0 卡片 + **无失败**（worker `done_empty`）→ 照常替换（不是失败，别误伤）', async () => {
  const before = seedOldCards(2);
  convertResult = { cards: [], entities: [], edges: [], sections: {}, status: 'done_empty', ok: true, error_count: 0 };
  const t = await runExtract();
  assert.ok(['done', 'done_empty'].includes(t?.status ?? ''), `内容确实没有知识点 → 不该 failed（实际 ${t?.status}）`);
  assert.equal(cardsOf().total, 0, '★ 这一条**应该**替换成 0 卡片（否则"确实没有知识点"的文档会永远显示旧卡）');
  assert.equal(meta().extract_status, 'done_empty', '★ 如实标 done_empty（不许报 done）');
  assert.ok(before.length === 2, '前置无误');
});

test('③ ★ 有卡片 + 有失败（partial）→ 照常入库（已产出的是真进度）', async () => {
  convertResult = {
    cards: [
      {
        id: 'card_new_1', unit_id: unitId, name: '新卡片', kind: 'concept', one_line: 'o', purpose: 'p',
        usage_mode: 'unknown', operational_role: 'unknown', lifecycle: 'unknown',
        evidence_quote: '索引是加速查询的数据结构', evidence_span: { kind: 'char', start: 0, end: 12 },
        confidence: 0.8,
      },
    ],
    entities: [], edges: [], sections: {},
    status: 'partial', ok: false, error_count: 1, errors: [{ msg: '另一个单元失败' }],
  };
  const t = await runExtract();
  assert.ok(['partial', 'done'].includes(t?.status ?? ''), `有产出 + 有失败 → partial（实际 ${t?.status}）`);
  assert.equal(cardsOf().total, 1, '★ 已产出的卡片必须入库（不许因为"有失败"就整批丢弃）');
  assert.equal(meta().extract_status, 'partial', '★ 如实标 partial');
});
