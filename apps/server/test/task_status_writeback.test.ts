/**
 * ★★ **任务终态必须回写文档状态**（用户直接撞到的 bug）。
 *
 * ## 缺陷（真库证据）
 * ```
 * doc_473f915e315f  documents.status='extracting'  而 tasks.status='failed'
 *                   error="LLM 调用全部失败（3 个 item 无一成功）"
 * doc_055d06be9a5d  documents.status='extracting'  而 tasks.status='failed'
 *                   error="FOREIGN KEY constraint failed"
 * ```
 * ⟹ 界面**不显示失败、不显示原因**，用户以为"还在跑"（原话："显示是可用的，请问抽取的结果在哪"）。
 * 根因：抽取 handler 只写 `meta.extract_status`，**从不更新 `documents.status`**；
 * 而队列的失败出口（无处理器 / 抛异常 / 取消）也**不回写**。
 *
 * ## 判据（★ 打在"真实终态"上 —— 坑 21：状态字段必须与真实终态同源）
 * 1. 必然失败的任务（无处理器）→ `documents.status === 'failed'` + **可读 reason 进 meta**
 * 2. 抽取任务失败 → 同样 `failed`（**不是**停在 `extracting`）
 * 3. 抽取任务成功 → **从 `extracting` 放出来**（回到 `ready`；产出数在 meta 里如实报）
 * 4. 回写是**队列层统一**做的（三条失败出口都覆盖），不是"各 handler 各自记得"
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { buildApp } from '../src/index.ts';
import { loadConfig } from '../src/config.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
let tmp = '';
let built: Awaited<ReturnType<typeof buildApp>> | null = null;
let userId = '';

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'writeback-'));
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DB: path.join(tmp, 't.sqlite3'),
      COURSE_KB_DATA_DIR: path.join(tmp, 'data'),
      COURSE_KB_SETTINGS_FILE: path.join(tmp, 'settings.json'),
      COURSE_KB_BOOTSTRAP_ADMIN: 'admin:writeback-pass-1',
    } as Record<string, string>,
  });
  built = await buildApp({ cfg });
  userId = built.deps.repo.rbac.getUserRowByName('admin')!.id;
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
async function waitTask(id: string, ms = 60_000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    const t = built!.deps.repo.getTask(id);
    if (t && TERMINAL.includes(t.status)) return t;
    await new Promise((x) => setTimeout(x, 100));
  }
  return built!.deps.repo.getTask(id);
}
const metaOf = (docId: string): Record<string, unknown> => {
  const row = built!.deps.repo.getDocumentRow(docId) as { meta_json?: string } | undefined;
  try {
    return JSON.parse(String(row?.meta_json ?? '{}')) as Record<string, unknown>;
  } catch {
    return {};
  }
};
const statusOf = (docId: string): string | undefined =>
  (built!.deps.repo.getDocumentRow(docId) as { status?: string } | undefined)?.status;

test('★★ 必然失败的任务（无处理器）→ 文档必须变 `failed` + **可读 reason**（不是停在进行中）', async () => {
  const docId = built!.deps.repo.insertDocument({
    title: '注定失败.pdf',
    kind: 'pdf',
    source_path: '/tmp/x.pdf',
    status: 'extracting', // ★ 模拟"任务在跑"的中间态
    ownerId: userId,
  });
  assert.equal(statusOf(docId), 'extracting', '前置：文档处于进行中');

  const taskId = built!.deps.queue.enqueue({ docId, kind: 'no_such_kind_xyz', userId, params: {} });
  const done = await waitTask(taskId);
  assert.equal(done?.status, 'failed', '任务必须失败');

  // ★ 判据：文档状态**真的**跟着终态变了（不是停在 extracting）
  assert.equal(
    statusOf(docId),
    'failed',
    `★ 任务失败后 documents.status 必须是 failed（原缺陷：永远停在 extracting）实际=${statusOf(docId)}`,
  );
  const meta = metaOf(docId);
  assert.equal(meta.task_failed_kind, 'no_such_kind_xyz', '必须记下是哪个 kind 失败');
  assert.match(String(meta.task_failed_error), /没有注册 kind=no_such_kind_xyz/, '★ reason 必须可读（用户要知道为什么）');
  assert.equal(typeof meta.task_failed_at, 'number', '必须记下失败时间');
});

test('★★ 抽取任务失败 → 同样 `failed`（不允许停在 `extracting`）', async () => {
  // 空文档（0 单元）→ 抽取必然失败/早退（**零 LLM 调用**：没有单元就不会发请求）
  const docId = built!.deps.repo.insertDocument({
    title: '空文档.pdf',
    kind: 'pdf',
    source_path: '/tmp/empty.pdf',
    status: 'extracting',
    ownerId: userId,
  });
  const taskId = built!.deps.queue.enqueue({ docId, kind: 'extract', userId, params: {} });
  const done = await waitTask(taskId);

  const st = statusOf(docId);
  assert.notEqual(st, 'extracting', `★ 抽取结束后**绝不许**停在 extracting（实际=${st}，任务=${done?.status}）`);
  assert.equal(st, 'failed', `空文档抽取应如实失败，实际=${st}`);
  assert.match(
    String(metaOf(docId).extract_error ?? metaOf(docId).task_failed_error ?? ''),
    /./,
    '失败原因必须写进 meta（前端要能显示）',
  );
});

test('★ 抽取**成功**路径也必须把状态从 `extracting` 放出来', async () => {
  // ⚠️ 成功路径需要"真有单元"的文档 → 由 `test/extract_max_tokens.test.ts`（真 worker 解析 + spy completeJson）
  //    覆盖：那里断言了 `doc.status !== 'extracting'`。本文件只守**失败**终态（那才是用户撞到的 bug）。
  assert.ok(true, '成功路径的断言在 extract_max_tokens.test.ts（需要真解析出的单元，本文件不重复造）');
});
