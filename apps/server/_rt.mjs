// 补验：四种检索模式各自独立（pi-bridge 修了模型绑定后重试）。
// 用隔离实例 8793 会打断；改为对 live 8787 做（只发 chat，不写库）。
import { WebSocket } from 'ws';

const PORT = process.argv[2] || '8787';
const USER = process.argv[3] || 'admin';
const PASS = process.argv[4] || 'Admin2026lab';
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const Q = '什么是索引？';

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
console.log('login:', login.status);
const settings = await (await fetch(`${BASE}/settings`)).json();
console.log('settings.llm.active =', settings?.settings?.llm?.active);

function ask(mode, waitMs = 150000) {
  return new Promise((resolve) => {
    const sid = `rt_${mode}_${Date.now()}`;
    const frames = [];
    let settled = false;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/chat/${sid}`,
      { headers: { cookie }, handshakeTimeout: 10000 });
    const fin = () => { if (!settled) { settled = true; try { ws.close(); } catch {} resolve(frames); } };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'prompt', message: Q, retrieval: mode })));
    ws.on('message', (d) => {
      let f; try { f = JSON.parse(d.toString()); } catch { return; }
      frames.push(f);
      if (['settled', 'agent_error', 'error'].includes(f.type)) fin();
    });
    ws.on('error', (e) => { frames.push({ type: 'ws_error', msg: e.message }); fin(); });
    setTimeout(() => { frames.push({ type: 'TIMEOUT' }); fin(); }, waitMs);
  });
}

const out = {};
for (const mode of ['none', 'wiki', 'kg', 'rag']) {
  const t0 = Date.now();
  const frames = await ask(mode);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const text = frames.filter((f) => f.type === 'text_delta').map((f) => f.delta).join('');
  const ready = frames.find((f) => f.type === 'ready') || {};
  // 检索元信息可能在这些帧里
  const rmeta = frames.find((f) => f.retrieval || f.retrieval_status || f.type === 'retrieval') || {};
  const err = frames.find((f) => ['agent_error', 'error'].includes(f.type));
  out[mode] = { frames: frames.length, dt, textLen: text.length, model: ready.model,
                modelSource: ready.model_source, retrieval: rmeta, err: err || null, text };
  console.log(`\n--- ${mode} ---`);
  console.log(`  用时 ${dt}s 帧=${frames.length} model=${ready.model} source=${ready.model_source}`);
  console.log(`  types=${JSON.stringify([...new Set(frames.map((f) => f.type))])}`);
  if (Object.keys(rmeta).length) console.log(`  检索元信息: ${JSON.stringify(rmeta).slice(0, 300)}`);
  console.log(`  回答len=${text.length}: ${JSON.stringify(text.slice(0, 180))}`);
  if (err) console.log(`  错误: ${JSON.stringify(err).slice(0, 240)}`);
}

console.log('\n' + '='.repeat(66));
console.log('四模式独立性判定');
console.log('='.repeat(66));
for (const m of ['none', 'wiki', 'kg', 'rag']) {
  const r = out[m];
  const st = r.retrieval.retrieval_status ?? r.retrieval.status ?? '(未带)';
  console.log(`  ${m.padEnd(5)} status=${String(st).padEnd(14)} textLen=${String(r.textLen).padEnd(6)} model=${r.model}`);
}
const sts = ['none', 'wiki', 'kg', 'rag'].map((m) => String(out[m].retrieval.retrieval_status ?? out[m].retrieval.status ?? 'none'));
console.log(`\n  状态集合: ${JSON.stringify(sts)}  去重后 ${new Set(sts).size} 种`);
console.log(`  textLen 集合: ${JSON.stringify(['none', 'wiki', 'kg', 'rag'].map((m) => out[m].textLen))}`);
