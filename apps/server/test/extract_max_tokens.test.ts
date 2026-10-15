/**
 * ★ 抽取路径的 `maxTokens` **真的进了请求**（坑 24 的第二半：「声明 ≠ 生效」）。
 *
 * 原缺陷：`ExtractDocumentRequest.maxTokens`（`tasks/extract.ts`）**只有声明、没有调用方**
 * → 抽取恒用 provider 默认 4096。对**推理模型**（推理 token 计入 `max_tokens`）来说，
 * 长单元的结构化输出很容易被推理吃光 → 空 content / 截断 JSON。
 *
 * ## 本测试**不花额度**（也不调 LLM）
 * 走**真 worker**（`extract.plan`，纯本地 Python）+ **spy `completeJson`**：
 * 在组装后把 `deps.providers.completeJson` 换成 spy（`index.ts` 在**调用时**读该属性，所以补丁生效），
 * 于是能**断言真实请求参数**（`maxTokens`）而完全不发网络请求。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import { buildApp } from '../src/index.ts';
import type { BuiltApp } from '../src/index.ts';
import { EXTRACT_MAX_TOKENS } from '../src/tasks/extract.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
let tmpRoot = '';
let built: BuiltApp | null = null;
let base = '';
let cookie = '';
let adminId = '';
/** spy 记录：抽取路径真正发出的请求参数 */
const seen: Record<string, unknown>[] = [];

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-tokens-'));
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DB: path.join(tmpRoot, 't.sqlite3'),
      COURSE_KB_DATA_DIR: path.join(tmpRoot, 'data'),
      COURSE_KB_SETTINGS_FILE: path.join(tmpRoot, 'settings.json'),
      COURSE_KB_BOOTSTRAP_ADMIN: 'admin:tokens-pass-1',
    },
  });
  built = await buildApp({ cfg });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('无法取到监听地址');
  base = `http://127.0.0.1:${addr.port}`;
  const r = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'tokens-pass-1' }),
  });
  cookie = (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const adminRow = built.deps.repo.rbac.getUserRowByName('admin');
  assert.ok(adminRow, 'admin 必须存在');
  adminId = adminRow.id;

  // ★ spy：记录参数 + 返回**合法**的结构化结果（不发任何网络请求 → 零额度）
  const providers = built.deps.providers;
  assert.ok(providers, 'provider 层必须可用');
  providers.completeJson = (async (req: Record<string, unknown>) => {
    seen.push(req);
    // 返回"一张卡片"的形状（schema 由 worker 的 plan 给出，这里给最小可用结构）
    return {
      data: {
        cards: [
          {
            name: '页分裂',
            kind: 'concept',
            one_line: '页分裂是 B+ 树插入溢出时的再平衡操作。',
            purpose: '叶子页写满时分裂并上提中间键。',
            evidence_quote: '页分裂把中间键上提',
            evidence_span: { kind: 'char', start: 0, end: 10 },
            confidence: 0.9,
          },
        ],
      },
      raw: '{}',
      usedProvider: 'spy',
    };
  }) as unknown as typeof providers.completeJson;
});

after(async () => {
  try {
    if (built) await built.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows 偶发占用：清理失败不该让测试变红 */
  }
});

test('★ 抽取请求真的带 maxTokens（= EXTRACT_MAX_TOKENS），而不是靠 provider 默认 4096', async () => {
  const TXT = '数据库索引是一种额外的数据结构，用于加速数据检索。当 B+ 树的叶子页写满时会发生页分裂：页分裂把中间键上提，左右两半各成一个新页。';
  const form = new FormData();
  form.append('file', new Blob([TXT], { type: 'text/plain' }), '索引原理.txt');
  form.append('kind', 'txt');
  const up = await fetch(`${base}/api/v1/documents`, { method: 'POST', headers: { cookie }, body: form });
  const upBody = (await up.json()) as { document_id?: string; task_id?: string };
  assert.ok(upBody.document_id, `上传失败：${JSON.stringify(upBody)}`);

  const TERMINAL = ['done', 'failed', 'cancelled', 'partial', 'done_empty'];
  const wait = async (id: string, ms = 180_000) => {
    const dl = Date.now() + ms;
    while (Date.now() < dl) {
      const t = built!.deps.repo.getTask(id);
      if (t && TERMINAL.includes(t.status)) return t;
      await new Promise((x) => setTimeout(x, 250));
    }
    return built!.deps.repo.getTask(id);
  };
  const parsed = await wait(upBody.task_id as string);
  assert.ok(['done', 'partial'].includes(parsed?.status ?? ''), `parse 未成功：${parsed?.status} ${JSON.stringify(parsed?.error)}`);

  const docId = upBody.document_id as string;
  const taskId = built!.deps.queue.enqueue({ docId, kind: 'extract', userId: adminId, params: {} });
  const done = await wait(taskId);
  assert.ok(seen.length > 0, `抽取必须真的调用 completeJson（任务状态 ${done?.status}）`);
  for (const req of seen) {
    assert.equal(
      req.maxTokens,
      EXTRACT_MAX_TOKENS,
      `★ 请求里的 maxTokens 必须是 ${EXTRACT_MAX_TOKENS}（原缺陷：声明了却没有调用方 → 恒用 4096）；实际 ${JSON.stringify(req.maxTokens)}`,
    );
  }
  assert.equal(EXTRACT_MAX_TOKENS, 8192, '常量值本身也要钉住（改动需显式）');
});
