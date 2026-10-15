/**
 * ★★ **reparse 端点守卫**（用户当前唯一能用上 OCR 修复的入口）。
 *
 * ## 为什么需要（真实阻塞）
 * `wiki-architect` 修好了扫描件的文字层判定 + 本地 OCR（实测 **0 字符 → 31,133 字符**），
 * 但**没有任何接口能让它重跑** ⟹ 用户手上的旧文档永远"解析成功但正文为空"。
 * **"修好了但用户用不上" 与没修一样。**
 *
 * ## 判据（★ 关键：**断言 units 正文真的变了**，不是"接口返回 200"）
 * 1. ★★ 重跑后 `units` 的正文**真的变了**（旧正文 → 新解析出的正文）
 * 2. 权限：学生（无 extract 权限）→ **403**
 * 3. 幂等：正在跑 → **409**（不造第二条 parse）
 * 4. ★ 代价可见：图片型/正文为空 → 响应里给 `needs_ocr` + `est_minutes` + 可读 `cost_note`
 * 5. 状态回写：重跑后文档状态能回到终态（不卡在 `parsing`）
 *
 * ⚠️ 本文件**零 LLM**：`autoExtractOnParse: false`（解析后不自动抽取）。
 *    真 OCR（9–12 秒/页）**不在单测里跑** —— 用 TXT 走真 worker 解析即可验证"正文真的变了"。
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
let base = '';
let teacherCookie = '';
let studentCookie = '';
let docId = '';

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reparse-'));
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DB: path.join(tmp, 't.sqlite3'),
      COURSE_KB_DATA_DIR: path.join(tmp, 'data'),
      COURSE_KB_SETTINGS_FILE: path.join(tmp, 'settings.json'),
      COURSE_KB_BOOTSTRAP_ADMIN: 'admin:reparse-pass-01',
      // ★ 零 LLM：只解析不抽取（`autoExtractOnParse` 现在真的接了这个开关 —— 原先声明了没人传）
      COURSE_KB_AUTO_EXTRACT: '0',
    } as Record<string, string>,
  });
  built = await buildApp({ cfg });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('取不到端口');
  base = `http://127.0.0.1:${addr.port}`;

  const rbac = built.deps.repo.rbac;
  const { hashPassword } = await import('../src/auth/password.ts');
  rbac.createUser({ username: 'tea', displayName: 'T', passwordHash: await hashPassword('tea-pass-0001'), roles: ['teacher'] });
  rbac.createUser({ username: 'stu', displayName: 'S', passwordHash: await hashPassword('stu-pass-0001'), roles: ['student'] });
  teacherCookie = await login('tea', 'tea-pass-0001');
  studentCookie = await login('stu', 'stu-pass-0001');

  // 造一个"旧正文"的文档（模拟 OCR 修复前解析出的空/错正文），文件是**真 TXT**（走真 worker 解析）
  const teaId = rbac.getUserRowByName('tea')!.id;
  const src = path.join(tmp, 'scan-like.txt');
  fs.writeFileSync(src, '数据库系统概论 第5版\n第一章 绪论\n数据库是长期存储在计算机内、有组织、可共享的数据集合。\n', 'utf8');
  docId = built.deps.repo.insertDocument({
    title: '扫描件（旧正文为空）',
    kind: 'txt',
    source_path: src,
    status: 'ready',
    ownerId: teaId,
    // ★ 让学生**可见**（published+public）→ 才能测到"可见但无权 → 403"；
    //   若不可见，RBAC 的正确表现是 **404（对外不存在，不泄露存在性）** —— 那是另一条语义
    visibility: 'public',
    reviewStatus: 'published',
  });
  // 旧正文（模拟"OCR 修复前"的状态）：正文为空
  built.deps.repo.db.run(
    `INSERT INTO units(id,doc_id,ord,title,text,text_len,span_kind,span_start,span_end) VALUES(?,?,?,?,?,?,?,?,?)`,
    'unt_old_0',
    docId,
    0,
    '旧单元',
    '',
    0,
    'page',
    1,
    1,
  );
  built.deps.repo.mergeDocumentMeta(docId, { text_gate: 'empty_body', text_mode: 'image', parse_status: 'done' });
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

async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(r.status, 200, `${username} 必须能登录`);
  return (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

const TERMINAL = ['done', 'failed', 'cancelled', 'partial', 'done_empty'];
async function waitTask(id: string, ms = 180_000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    const t = built!.deps.repo.getTask(id);
    if (t && TERMINAL.includes(t.status)) return t;
    await new Promise((x) => setTimeout(x, 250));
  }
  return built!.deps.repo.getTask(id);
}

const unitsOf = (id: string): { id: string; text: string }[] =>
  built!.deps.repo.db.all<{ id: string; text: string }>('SELECT id, text FROM units WHERE doc_id = ? ORDER BY ord', id);

test('★ 权限：学生调 reparse → **403**（服务端权威判定）', async () => {
  const r = await fetch(`${base}/api/v1/documents/${docId}/reparse`, { method: 'POST', headers: { cookie: studentCookie } });
  assert.equal(r.status, 403, `★ 学生不许重跑解析（实际 ${r.status}）`);
});

test('★★ 重跑后 `units` 正文**真的变了**（空 → 解析出的正文），不是"接口返回 200"', async () => {
  const before = unitsOf(docId);
  assert.equal(before.length, 1, '前置：只有 1 个旧单元');
  assert.equal(before[0]!.text, '', '前置：旧正文为空（模拟 OCR 修复前）');

  const r = await fetch(`${base}/api/v1/documents/${docId}/reparse`, { method: 'POST', headers: { cookie: teacherCookie } });
  assert.equal(r.status, 202, `重跑应受理（实际 ${r.status}）`);
  const body = (await r.json()) as { task_id: string; needs_ocr?: boolean; cost_note?: string; est_minutes?: number[] };
  assert.ok(body.task_id, '必须返回 task_id');

  const done = await waitTask(body.task_id);
  assert.ok(['done', 'partial'].includes(done?.status ?? ''), `parse 应成功，实际 ${done?.status} ${JSON.stringify(done?.error)}`);

  // ★★ 关键判据：正文**真的变了**（不是"任务入队了"）
  const after = unitsOf(docId);
  assert.ok(after.length > 0, '重跑后必须重新产出单元');
  const joined = after.map((u) => u.text).join('\n');
  assert.ok(joined.trim().length > 0, `★ 重跑后正文不许仍为空（用户要的是"扫描件能出内容"）实际=${JSON.stringify(joined.slice(0, 80))}`);
  assert.match(joined, /数据库/, '★ 正文必须是**新解析出的真实内容**（原文件里的字）');
  assert.notDeepEqual(
    after.map((u) => u.text),
    before.map((u) => u.text),
    '★ 单元正文必须与重跑前**不同**（否则只是"跑了一遍但什么都没变"）',
  );
});

test('★ 代价可见：正文为空/图片型 → 响应给 `needs_ocr` + `est_minutes` + 可读 `cost_note`', async () => {
  // 复位成"图片型且正文为空"（模拟用户那份 434 页扫描件）
  built!.deps.repo.db.run('UPDATE documents SET page_count = 434 WHERE id = ?', docId);
  built!.deps.repo.mergeDocumentMeta(docId, { text_mode: 'image', text_gate: 'empty_body' });
  const r = await fetch(`${base}/api/v1/documents/${docId}/reparse`, { method: 'POST', headers: { cookie: teacherCookie } });
  // 可能在跑 → 409 也算"如实拒绝"（幂等），但代价可见只在 202 上断言
  if (r.status === 202) {
    const body = (await r.json()) as { task_id?: string; needs_ocr?: boolean; est_minutes?: number[]; cost_note?: string };
    assert.ok(body.task_id, '必须返回 task_id');
    assert.equal(body.needs_ocr, true, '★ 图片型必须标 needs_ocr');
    const est = body.est_minutes;
    assert.ok(Array.isArray(est) && est.length === 2, `★ 必须给时长区间（434 页 ≈ 65 分钟），实际 ${JSON.stringify(est)}`);
    assert.ok(Number(est[1]) >= 60, `★ 434 页应是"小时级"，实际上限 ${JSON.stringify(est)} 分钟`);
    assert.match(String(body.cost_note), /OCR/, '★ 必须说明会走本地 OCR（用户要**先知道**）');
    assert.match(String(body.cost_note), /不消耗 LLM|LLM/, 'cost_note 要说清 LLM 与 OCR 的差别');
    const t = await waitTask(body.task_id!);
    assert.ok(['done', 'failed', 'partial'].includes(t?.status ?? ''), '任务必须能到达终态（不卡 parsing）');
    const st = (built!.deps.repo.getDocumentRow(docId) as { status?: string } | undefined)?.status;
    assert.notEqual(st, 'parsing', `★ 终态后不许卡在 parsing（实际 ${st}）`);
  } else {
    assert.equal(r.status, 409, `并发时应如实 409，实际 ${r.status}`);
  }
});
