// 验收 3：四种检索模式各自独立（真实 WebSocket）。
// chat 入口是 WS（routes/chat.ts），不是 HTTP。
// 用 Node 内置的 WebSocket（Node 24 全局可用）+ fetch 登录拿 cookie。
import { WebSocket } from 'ws';

const BASE = 'http://127.0.0.1:8787/api/v1';
const WSBASE = 'ws://127.0.0.1:8787/api/v1/chat/';
const QUESTION = process.argv[2] || '什么是索引？';
const MODES = ['none', 'wiki', 'kg', 'rag'];

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Admin2026lab' }),
  });
  const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  return { status: r.status, cookie };
}

function ask(mode, cookie, waitMs = 150000) {
  return new Promise((resolve) => {
    const sid = `verify_${mode}_${Date.now()}`;
    const frames = [];
    let done = false;
    let ws;
    const finish = () => {
      if (done) return;
      done = true;
      try { ws && ws.close(); } catch {}
      resolve(frames);
    };
    try {
      ws = new WebSocket(`${WSBASE}${sid}`, { headers: { cookie } });
    } catch (e) {
      resolve([{ type: 'agent_error', msg: `WS 构造失败: ${e.message}` }]);
      return;
    }
    const on = (ev, fn) => ws.on(ev, fn);
on('open', () => {
      ws.send(JSON.stringify({ type: 'prompt', message: QUESTION, retrieval: mode }));
    });
    on('message', (raw) => {
      const ev = { data: raw };
      let f;
      try { f = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
      catch { return; }
      frames.push(f);
      if (['settled', 'agent_error', 'error'].includes(f.type)) finish();
    });
    on('error', (e) => {
      frames.push({ type: 'agent_error', msg: `WS error: ${e.message || e.type || 'unknown'}` });
      finish();
    });
    on('close', (code, reason) => {
      const e = { code, reason };
      if (!done) { frames.push({ type: 'closed', code: e.code, reason: e.reason }); finish(); }
    });
    setTimeout(() => { frames.push({ type: 'timeout' }); finish(); }, waitMs);
  });
}

function summarize(frames) {
  const meta = {};
  let text = '';
  const types = [];
  for (const f of frames) {
    types.push(f.type);
    if (f.type === 'text_delta' && f.delta) text += f.delta;
    for (const k of ['retrieval_mode', 'retrieval_status', 'retrieval_reason',
                     'retrieval_items', 'retrieval_items_n']) {
      if (k in f) meta[k] = f[k];
    }
    if (f.retrieval && typeof f.retrieval === 'object') meta.retrieval = f.retrieval;
  }
  return { meta, text, types };
}

const { status, cookie } = await login();
console.log(`login: ${status} cookie=${cookie ? 'ok' : '(none)'}`);
const results = {};
for (const mode of MODES) {
  const t0 = Date.now();
  const frames = await ask(mode, cookie);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const { meta, text, types } = summarize(frames);
  results[mode] = { frames: frames.length, meta, text, types };
  console.log(`\n--- mode=${mode} ---`);
  console.log(`  帧数=${frames.length} 用时=${dt}s  types=${JSON.stringify([...new Set(types)])}`);
  console.log(`  检索元信息: ${JSON.stringify(meta).slice(0, 320)}`);
  console.log(`  回答(len=${text.length}): ${JSON.stringify(text.slice(0, 200))}`);
  const err = frames.find((f) => ['agent_error', 'error'].includes(f.type));
  if (err) console.log(`  错误帧: ${JSON.stringify(err).slice(0, 260)}`);
}

console.log('\n' + '='.repeat(70));
console.log('独立性判定');
console.log('='.repeat(70));
for (const m of MODES) {
  const r = results[m];
  const st = r.meta.retrieval_status ?? r.meta.retrieval?.status ?? '-';
  const n = r.meta.retrieval_items_n ?? r.meta.retrieval?.count ?? '-';
  console.log(`  ${m.padEnd(5)} frames=${String(r.frames).padEnd(3)} status=${String(st).padEnd(12)} items=${String(n).padEnd(4)} text_len=${r.text.length}`);
}
const sts = Object.fromEntries(MODES.map((m) => [m, results[m].meta.retrieval_status ?? results[m].meta.retrieval?.status ?? null]));
console.log(`\n  各模式 status: ${JSON.stringify(sts)}`);
console.log(`  none 不检索          : ${sts.none === null || sts.none === 'none'}`);
console.log(`  rag 如实不可用        : ${sts.rag === 'unavailable'}`);
console.log(`  四模式状态不完全相同  : ${new Set(MODES.map((m) => String(sts[m]))).size > 1}`);
