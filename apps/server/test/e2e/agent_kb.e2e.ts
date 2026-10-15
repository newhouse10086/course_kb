/**
 * ★★ **真 WS + 真模型 + 真知识库** 的 agent 模式端到端（**显式跑，不进默认套件**）。
 *
 * ```powershell
 * cd apps/server ; npm run test:e2e:agent
 * ```
 *
 * ## 为什么它必须独立存在（而且**只有它能**覆盖这件事）
 * 实测（Lead 裁定的坑 21）：`kb` 只传给"每次连接"的选项、**没注入 `AgentSessionManager`** 时：
 * ```
 * ready.tools = []            ← 实际：没有工具（功能失效）
 * tools_source = 'kb-readonly' ← 自述：kb 只读工具已开
 * 模型回答："当前会话里没有 kb_search / kb_get 这两个工具"
 * ```
 * 而**单元测试与 `/capabilities` 断言当时全绿**。所以：
 * - **工具是否真的注册** ⟹ 只有真 WS 能验（`ready.tools` 是唯一真相）
 * - **模型会不会用工具** ⟹ 只有真模型能验
 *
 * ## 为什么默认不跑
 * 真 LLM ≈ 20–25s + **消耗额度**。放进 `npm test` 会让每次反馈都变慢、都花钱。
 * （文件名是 `*.e2e.ts` 而不是 `*.test.ts`，所以 `npm test` 的 `test/**\/*.test.ts` glob **不会**收它。）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { loadConfig } from '../../src/config.ts';
import { buildApp } from '../../src/index.ts';
import type { BuiltApp } from '../../src/index.ts';
import { indexDocument } from '../../src/store/search.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const DANGEROUS = ['bash', 'read', 'edit', 'write'];
/** 独特标记词：只有真的读到卡片原文才会出现在回答里。 */
const MARK = 'ZZZ_索引页分裂_ZZZ';

let tmpRoot = '';
let built: BuiltApp | null = null;
let base = '';
let cookie = '';

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-'));
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DB: path.join(tmpRoot, 'e2e.sqlite3'),
      COURSE_KB_DATA_DIR: path.join(tmpRoot, 'data'),
      COURSE_KB_BOOTSTRAP_ADMIN: 'admin:agent-e2e-pass-1',
    },
  });
  built = await buildApp({ cfg });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('无法取到监听地址');
  base = `http://127.0.0.1:${addr.port}`;

  const login = async (u: string, p: string): Promise<string> => {
    const r = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    });
    assert.equal(r.status, 200, `登录 ${u} 失败：${await r.text()}`);
    return (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  };
  const adminCookie = await login('admin', 'agent-e2e-pass-1');
  const mk = await fetch(`${base}/api/v1/users`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'stu-agent', password: 'stu-pass-12345', roles: ['student'] }),
  });
  assert.ok(mk.status === 200 || mk.status === 201, `建学生失败：${mk.status} ${await mk.text()}`);
  cookie = await login('stu-agent', 'stu-pass-12345');

  // 学生**自己的**私有已发布文档 + 一张含独特标记词的卡片（可见性过滤应放行本人）
  const repo = built.deps.repo;
  const stu = repo.rbac.getUserRowByName('stu-agent');
  assert.ok(stu, '学生用户必须存在');
  const docId = repo.insertDocument({
    title: '索引原理讲义',
    kind: 'pdf',
    source_path: 'data/uploads/idx.pdf',
    page_count: 40,
    status: 'ready',
    ownerId: stu.id,
    reviewStatus: 'published',
    visibility: 'private',
  });
  const unitIds = repo.replaceUnits(docId, [
    {
      ord: 1,
      title: '第 1 章 索引结构',
      level: 1,
      parent_ord: null,
      span: { kind: 'page', start: 3, end: 9 },
      text: `B+ 树索引把键按序存放。页分裂发生时，${MARK}：中间键上提到父节点，左右两半各成一个页。`,
    },
  ]);
  repo.replaceCards(docId, [
    {
      unit_id: unitIds[0] as string,
      name: '页分裂',
      kind: 'concept',
      one_line: '页分裂是 B+ 树插入溢出时的再平衡操作。',
      purpose: `当叶子页写满时分裂，把中间键上提，标记词 ${MARK}。`,
      evidence_quote: `页分裂发生时，${MARK}：中间键上提到父节点。`,
      evidence_span: { kind: 'page', start: 5, end: 6 },
      confidence: 0.95,
    },
  ]);
  indexDocument(repo.db, repo, docId);
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

test('★ agent 模式真端到端：kb 工具真被调用 + 引用原文 + 无危险工具 + 正文无 tool 标记', async () => {
  const frames: Record<string, unknown>[] = [];
  const t0 = Date.now();
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/v1/chat/agent-e2e-1?mode=agent`, {
    headers: { cookie },
  });

  const outcome = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('timeout-180s'), 180_000);
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'prompt',
          message: 'B+ 树的页分裂是什么？请先用 kb_search 查资料，再用 kb_get 读原文，并引用原文说明。',
        }),
      );
    });
    ws.addEventListener('message', (ev) => {
      try {
        const f = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as Record<string, unknown>;
        frames.push(f);
        if (f.type === 'settled' || f.type === 'error') {
          clearTimeout(timer);
          resolve(String(f.type));
        }
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      resolve('ws-error');
    });
  });
  try {
    ws.close();
  } catch {
    /* ignore */
  }

  const ready = (frames.find((f) => f.type === 'ready') ?? {}) as Record<string, unknown>;
  const tools = Array.isArray(ready.tools) ? (ready.tools as string[]) : [];
  const toolCalls = frames
    .filter((f) => f.type === 'tool_start')
    .map((f) => String(f.tool ?? f.name ?? ''));
  const text = frames
    .filter((f) => f.type === 'text_delta')
    .map((f) => String(f.delta ?? ''))
    .join('');
  const markerRe = /<[|｜]\s*(tool|function)[^>]*[|｜]>/i;

  // ① kb 工具**真的被调用**（`ready.tools` 是唯一真相 + 真的出现 tool_start）
  assert.equal(outcome, 'settled', `对话应正常结束，实际 ${outcome}（帧：${frames.map((f) => f.type).join(',')}）`);
  assert.ok(
    tools.includes('kb_search') && tools.includes('kb_get'),
    `★ ready.tools 必须含 kb 工具（工具是否真的注册只有真 WS 能验），实际 ${JSON.stringify(tools)}`,
  );
  assert.ok(
    toolCalls.some((n) => n.includes('kb_search')) && toolCalls.some((n) => n.includes('kb_get')),
    `★ kb_search/kb_get 必须真被调用，实际 ${JSON.stringify(toolCalls)}`,
  );
  // ② 回答引用了卡片原文
  assert.ok(text.includes('页分裂'), `★ 回答必须引用卡片原文（含"页分裂"），实际前 200 字：${text.slice(0, 200)}`);
  // ③ 无危险工具
  assert.deepEqual(
    tools.filter((t) => DANGEROUS.includes(t)),
    [],
    `★★ agent 模式绝不许有危险工具，实际 ${JSON.stringify(tools)}`,
  );
  // ④ 正文里不出现原始 tool 标记（原问题症状）
  assert.ok(!markerRe.test(text), `★ 正文不许出现 tool 调用标记，实际命中：${text.match(markerRe)?.[0]}`);
  assert.ok(Date.now() - t0 > 0);
});
