/**
 * ★★ **单元级空正文闸门**（`extract.ts`）—— 修"reparse 越修越糟"的第一半。
 *
 * ## 真实缺陷（Lead 真库实测 `doc_ec5a4ce88038`，328 字符 markdown）
 * ```
 * 第一次 parse → cards=3；★ reparse → cards=0（越修越糟）
 * ```
 * 根因链：markdown `# 数据库索引` **紧跟** `## 聚簇索引` → 顶层标题**没有自己的正文**
 * → `unit.text=''`（title 有值）→ 把**空正文**发给 LLM → 上游 **HTTP 400**
 * → `extract_status="partial"` → **整个抽取 0 卡片**。
 * 全库规模：单元 2873 中**空正文 238（8%）**。
 *
 * ★ **前提已在真 worker 上验证过**（零 LLM）：`extract.plan` 对"空正文标题单元"**确实产出 item**
 * （实测输出：`unit_id=unt_title ord=1 正文长度=0`）—— 所以本测试**直接种单元**
 * （不跑上传+解析那 ~50s 的真 worker 链路），让判据快且**不受机器负载影响**；
 * "真解析会产出空正文单元"由 `documents_reparse_keeps_cards.test.ts` 断言（那里本来就要解析）。
 *
 * ## 判据（★ 全零 LLM：`providers.completeJson` 是**注入替身**；plan/convert 走真 worker）
 * 1. ★ 空正文单元**不发 LLM**（替身记录到的每个 prompt 都必须**有正文**）
 * 2. ★ 其余单元**正常出卡片**
 * 3. ★ `meta.extract_warnings` 里 `W_EMPTY_INPUT` 如实报 `skipped_units` + `unit_ids`（**不许静默跳过**）
 * 4. ★ 空正文单元**仍在 `units` 表里**（它是 Wiki 层级树的骨架，**不删**）
 * 5. 抽取状态不是 `failed`（不再因为一个空单元把整篇判失败）
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
import type { WorkerRunnerWithRaw } from '../src/worker/runner.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
let tmp = '';
let built: BuiltApp | null = null;
let adminId = '';
let docId = '';
let delegateExtractor: { extractDocument: (r: never) => Promise<never> } | null = null;
const EMPTY_UNIT = 'unt_title_empty';
const TEXT_UNIT = 'unt_body_text';

/** 替身记录：每个 item 实际发出去的 prompt */
const calls: { user: string; body: string; maxTokens?: number }[] = [];

/** 从 worker 的 user prompt 里取"原文"段（`## …原文\n<body>\n\n## 输出`）。 */
function bodyOf(user: string): string {
  const head = user.split('## 输出')[0] ?? '';
  const idx = head.lastIndexOf('原文');
  return idx >= 0 ? head.slice(idx + 2).trim() : '';
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-gate-'));
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DB: path.join(tmp, 't.sqlite3'),
      COURSE_KB_DATA_DIR: path.join(tmp, 'data'),
      COURSE_KB_SETTINGS_FILE: path.join(tmp, 'settings.json'),
      COURSE_KB_BOOTSTRAP_ADMIN: 'admin:empty-gate-1',
      COURSE_KB_AUTO_EXTRACT: '0', // 抽取由本测试**显式入队**
    } as Record<string, string>,
  });
  // ★★ 用**延迟委托代理**注入抽取器：
  //   `buildApp` 内部创建 runner，而我们要"真 runner + 替身 LLM" → 只能先给代理，
  //   buildApp 之后再填真实实现（`built.deps` 与 handlers 捕获的 deps **不是同一个对象**，
  //   所以第一版"替换 built.deps.extractor"无效 —— 实测 4/4 假红，被这条抓出来）。
  const proxyExtractor = {
    name: 'test-proxy',
    available: async () => ({ ok: true, reason: '' }),
    extractDocument: async (req: unknown) => {
      if (!delegateExtractor) throw new Error('测试代理未就绪');
      return delegateExtractor.extractDocument(req as never);
    },
  };
  built = await buildApp({ cfg, extractor: proxyExtractor as never });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const repo = built.deps.repo;
  adminId = repo.rbac.getUserRowByName('admin')!.id;

  // ★★ 关掉"抽取器可用性**真探测**"：`resolveExtractorAvailability()` 会调
  //    `extractor.available()` → `providers.capabilities({deep:true})` = **一次真 LLM 请求**
  //    （本机实测让抽取任务在**第一次 LLM 调用前**等 ~60s；结果进程内缓存）。
  //    本测试的判据（空正文闸门）与可用性无关 → 直接给 ok：
  //    ① 保证**真零 LLM** ② 不受上游延迟影响（否则并行跑测试时会假红）。
  (built.deps as { resolveExtractorAvailability?: () => Promise<{ ok: boolean; reason: string }> })
    .resolveExtractorAvailability = async () => ({ ok: true, reason: '' });

  // ★★ 替身 LLM：**空正文就抛 400**（复刻真实故障），非空正文返回一张卡。
  //
  // ⚠️ 为什么**不**补丁 `providers.completeJson`（第一版做法，**偶发假红**）：
  //    `settings.json` **热重载**会重建 provider facade → 补丁被换回**真实现**
  //    → 偶发**真 LLM 调用**（实测报 `抽取失败：amr 网络错误：fetch failed`，3 次里红 1 次）。
  //    改成注入**自己的抽取器**（真 runner + 替身 LLM）：`runExtraction` 在调用时读
  //    `deps.extractor`，所以替换它即可 → 真 worker 的 plan/convert 照跑，LLM 永远是替身。
  const stubCompleteJson = async (req: Record<string, unknown>) => {
    const msgs = (req.messages ?? []) as { role?: string; content?: string }[];
    const user = String(msgs.find((m) => m.role === 'user')?.content ?? '');
    const body = bodyOf(user);
    calls.push({ user, body, maxTokens: req.maxTokens as number | undefined });
    if (!body) throw new Error('LLM 返回 HTTP 400：输入正文为空');
    return {
      data: {
        cards: [
          {
            name: '聚簇索引',
            kind: 'concept',
            one_line: '决定数据在磁盘上的物理存储顺序。',
            purpose: '让范围查询连续读页。',
            usage_mode: 'server_automatic',
            operational_role: 'performance',
            evidence_quote: body.slice(0, 12),
            evidence_span: { kind: 'char', start: 0, end: 12 },
            confidence: 0.9,
          },
        ],
      },
      raw: '{}',
      usedProvider: 'spy',
    };
  };
  const runner = (built.deps as unknown as { runner: WorkerRunnerWithRaw }).runner;
  delegateExtractor = createWorkerExtractor({
    runner, // ★ 真 runner：plan/convert 走真 worker（零 LLM job）
    completeJson: stubCompleteJson as never,
    sourceName: '课程资料',
    maxPages: 8,
  }) as never;

  // 种单元：**标题单元正文为空**（markdown `# 标题` 紧跟 `## 子标题` 的结构性结果）+ 一个有正文的单元
  const src = path.join(tmp, 'seed.txt');
  fs.writeFileSync(src, '聚簇索引决定表中数据在磁盘上的物理存储顺序。叶子页写满时发生页分裂。', 'utf8');
  docId = repo.insertDocument({
    title: '索引',
    kind: 'txt',
    source_path: src,
    status: 'ready',
    ownerId: adminId,
    visibility: 'public',
    reviewStatus: 'published',
  });
  const ins = (id: string, ord: number, title: string, text: string): void => {
    repo.db.run(
      `INSERT INTO units(id,doc_id,ord,title,text,text_len,span_kind,span_start,span_end) VALUES(?,?,?,?,?,?,?,?,?)`,
      id, docId, ord, title, text, text.length, 'char', ord * 100, ord * 100 + text.length,
    );
  };
  ins(EMPTY_UNIT, 1, '数据库索引', ''); // ★ 标题单元：没有自己的正文
  ins(TEXT_UNIT, 2, '聚簇索引', '聚簇索引决定表中数据在磁盘上的物理存储顺序。叶子页写满时发生页分裂。');
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
async function waitTask(id: string, ms = 120_000) {
  const dl = Date.now() + ms;
  let t = built!.deps.repo.getTask(id);
  while (t && !TERMINAL.includes(t.status) && Date.now() < dl) {
    await new Promise((x) => setTimeout(x, 200));
    t = built!.deps.repo.getTask(id);
  }
  return t;
}

test('★★ 空正文单元不发 LLM + 其余单元照常出卡片 + meta 如实报 N（不许静默跳过）', async () => {
  calls.length = 0;
  const taskId = built!.deps.queue.enqueue({ docId, kind: 'extract', userId: adminId, params: {} });
  const done = await waitTask(taskId);

  // ① ★ 核心判据：**没有任何一次调用是空正文**（闸门生效 → 不会再有 HTTP 400）
  const emptyBodyCalls = calls.filter((c) => c.body.length === 0);
  assert.equal(
    emptyBodyCalls.length,
    0,
    `★ 空正文必须**不发 LLM**（否则就是拿空正文换 400）。实际空正文调用 ${emptyBodyCalls.length} 次；` +
      `全部调用正文长度=${JSON.stringify(calls.map((c) => c.body.length))}`,
  );
  assert.ok(
    calls.length > 0,
    `非空单元必须真的调了 LLM（否则是"整体没跑"）；任务状态=${done?.status} ${JSON.stringify(done?.error ?? null)}`,
  );

  // ② ★ 其余单元正常出卡片（不再"一个空单元毁掉整篇"）
  const cards = built!.deps.repo.listCards(docId, { offset: 0, limit: 50 });
  assert.ok(cards.total > 0, `★ 有正文的单元必须产出卡片（实际 ${cards.total}）；任务状态=${done?.status}`);
  assert.ok(
    ['done', 'partial'].includes(done?.status ?? ''),
    `抽取不应失败（实际 ${done?.status} ${JSON.stringify(done?.error)}）`,
  );

  // ③ ★ 不许静默：meta 里如实报"跳过了几个空正文单元 + 是哪些"
  const row = built!.deps.repo.getDocumentRow(docId) as { meta_json?: string } | undefined;
  const m = JSON.parse(String(row?.meta_json ?? '{}')) as Record<string, unknown>;
  const warnings = (m.extract_warnings ?? []) as { code?: string; skipped_units?: number; unit_ids?: string[] }[];
  const emptyWarn = warnings.filter((w) => w.code === 'W_EMPTY_INPUT');
  assert.ok(
    emptyWarn.length > 0,
    `★ meta.extract_warnings 必须有 W_EMPTY_INPUT（实际 ${JSON.stringify(warnings.map((w) => w.code))}）`,
  );
  assert.equal(emptyWarn[0]!.skipped_units, 1, '★ 跳过数必须如实（本例恰好 1 个空正文单元）');
  assert.deepEqual(emptyWarn[0]!.unit_ids, [EMPTY_UNIT], '★ 跳过的单元 id 必须如实上报');
  // ★ 这条同时证明"闸门真的看到了 plan 里的那个空单元"（它只能从 plan items 得知）
  assert.equal(calls.length, 1, '★ 只应对**有正文**的那个单元发起调用（空单元在 plan 里但不发）');

  // ④ ★ 单元**不删**（空正文标题单元是 Wiki 层级树的骨架）
  const ids = built!.deps.repo.db
    .all<{ id: string }>('SELECT id FROM units WHERE doc_id = ? ORDER BY ord', docId)
    .map((u) => u.id);
  assert.deepEqual(ids, [EMPTY_UNIT, TEXT_UNIT], '★ 空正文单元必须**保留**在 units 表里（只跳过 LLM，不删单元）');

  // ⑤ 抽取状态不是 failed
  assert.notEqual(m.extract_status, 'failed', `★ 不该因为一个空单元把整篇判失败（实际 ${String(m.extract_status)}）`);
  assert.ok(calls.every((c) => c.maxTokens === 8192), '既有判据不许退化：maxTokens 仍须显式传 8192');
});
