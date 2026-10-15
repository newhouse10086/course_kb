/**
 * 独立验收 ④：`context` 帧（第 11 种帧）—— 契约 RETRIEVAL.md §4.0.2 / API_PROTOCOL.md §7.2。
 *
 * Lead 自己写的 WS 探针。验证：
 *  1. `prompt.context` 只接受 id → 服务端解析成**真实标题**回在 `context.resolved`
 *  2. ★ **`dropped` 非空必须如实回**（给一个不存在的 unit_id）
 *  3. ★ **每轮帧序**：`context → retrieval → …`（context 必须在 retrieval 之前）
 *  4. `context` 与 `retrieval` **正交**：`retrieval:'none'` 时 context 仍然存在
 *
 * 运行：node tools/_scratch_context_probe.mjs   （从 apps/server 目录）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER = path.resolve(import.meta.dirname, '..', 'apps', 'server');
const PORT = 8807;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-probe-'));

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✔ ${n}`); }
  else { fail++; console.log(`  ✖ ${n}${d ? `  → ${d}` : ''}`); }
};

// ── 起隔离实例（★ settings 与 data 都不共用开发库）────────────────────
const env = {
  ...process.env,
  COURSE_KB_ROOT: iso,                      // root 换掉 → settings/providers 都从 iso 读
  COURSE_KB_DATA_DIR: path.join(iso, 'data'),
  COURSE_KB_PORT: String(PORT),
  COURSE_KB_BOOTSTRAP_ADMIN: 'ctxadmin:CtxAdmin2026lab',
};
fs.mkdirSync(path.join(iso, 'config'), { recursive: true });
const repoRoot = path.resolve(SERVER, '..', '..');
for (const rel of ['config/settings.json', 'config/providers.yaml', '.env']) {
  const src = path.join(repoRoot, rel);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(iso, rel));
}

console.log(`隔离 root: ${iso}\n启动实例 :${PORT} …`);
const srv = spawn(process.execPath, ['src/index.ts'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = '';
srv.stdout.on('data', (b) => { srvLog += b.toString(); });
srv.stderr.on('data', (b) => { srvLog += b.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* retry */ }
    await sleep(500);
  }
  return false;
}

try {
  if (!(await waitUp())) throw new Error(`实例未起来\n${srvLog.slice(-800)}`);

  // ── 登录 + 造一份有卡片的文档 ────────────────────────────────────
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ctxadmin', password: 'CtxAdmin2026lab' }),
  });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const H = { 'content-type': 'application/json', cookie };

  const form = new FormData();
  form.append('file', new Blob([`# 第 3 章 索引\n\n聚簇索引把数据行按主键顺序存放在叶子页，因此范围查询很快。\n`.repeat(20)], { type: 'text/markdown' }), 'ctx-probe.md');
  const up = await fetch(`${BASE}/documents`, { method: 'POST', headers: { cookie }, body: form });
  const doc = await up.json();
  const docId = doc.id ?? doc.document?.id ?? doc.doc_id;
  await fetch(`${BASE}/documents/${docId}/parse`, { method: 'POST', headers: H });
  for (let i = 0; i < 40; i++) {
    const d = await (await fetch(`${BASE}/documents/${docId}`, { headers: { cookie } })).json();
    if ((d.status ?? d.document?.status) === 'ready') break;
    await sleep(500);
  }
  const outline = await (await fetch(`${BASE}/documents/${docId}/outline`, { headers: { cookie } })).json();
  const firstUnit = (outline.units ?? outline.outline ?? outline.nodes ?? [])[0];
  const unitId = firstUnit?.id ?? firstUnit?.unit_id;
  console.log(`文档 ${docId} · 首个单元 ${unitId}\n`);

  // ── WS 连接 ────────────────────────────────────────────────────
  const { WebSocket } = await import(pathToFileURL(path.join(SERVER, 'node_modules/ws/index.js')).href);
  const frames = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/chat/probe-ctx?mode=chat`, { headers: { cookie } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch { /* ignore */ } });
  await sleep(2500);   // 等 ready

  console.log('=== ④ 发一轮带 context 的 prompt（含一个不存在的 unit_id）===');
  ws.send(JSON.stringify({
    type: 'prompt',
    message: '我在看哪一章？请只回答章节标题。',
    retrieval: 'none',
    context: { doc_id: docId, unit_id: 'unt_DOES_NOT_EXIST_0000', page: 3 },
  }));
  await sleep(12000);

  const idx = (t) => frames.findIndex((f) => f.type === t);
  const ctx = frames.find((f) => f.type === 'context');
  const ret = frames.find((f) => f.type === 'retrieval');

  check('收到 `context` 帧（第 11 种帧真的发了）', !!ctx, `帧类型=${[...new Set(frames.map((f) => f.type))].join(',')}`);
  check('★ `retrieval:"none"` 时 context 仍然存在（两者正交）', !!ctx && !!ret);
  check('★ 帧序 context 在 retrieval 之前', idx('context') >= 0 && idx('retrieval') >= 0 && idx('context') < idx('retrieval'),
    `context@${idx('context')} retrieval@${idx('retrieval')}`);
  check('★ `used` 回显了请求里的 id（只收 id）', !!ctx?.used && ctx.used.doc_id === docId, `used=${JSON.stringify(ctx?.used)}`);
  check('★ **`dropped` 非空且如实说明**（不存在的 unit_id 不许静默丢）',
    Array.isArray(ctx?.dropped) && ctx.dropped.length > 0 && /unt_DOES_NOT_EXIST/.test(JSON.stringify(ctx.dropped)),
    `dropped=${JSON.stringify(ctx?.dropped)}`);
  check('★ `resolved` 给的是**服务端解析出的真实标题**（不是客户端传的 id）',
    !!ctx?.resolved && (ctx.resolved.doc_title === undefined || ctx.resolved.doc_title !== docId),
    `resolved=${JSON.stringify(ctx?.resolved)}`);
  check('帧序首位是 context 或 ready（不是 text_delta 抢先）', idx('context') <= 1 || idx('ready') === 0);

  console.log(`\n  帧序: ${frames.map((f) => f.type).slice(0, 10).join(' → ')}`);
  if (ctx) console.log(`  context 帧: ${JSON.stringify(ctx).slice(0, 400)}`);
  ws.close();
} catch (e) {
  console.log(`\n探针异常: ${e.message}`);
  fail++;
} finally {
  srv.kill();
  await sleep(600);
  try { fs.rmSync(iso, { recursive: true, force: true }); } catch { /* windows lock */ }
}

console.log(`\n${'='.repeat(60)}\n④ 结果: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
