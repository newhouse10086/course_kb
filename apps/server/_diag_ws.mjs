// 诊断：chat WS 到底能不能连？为什么 /health 200 但 WS 连接被拒？
import { WebSocket } from 'ws';

const BASE = 'http://127.0.0.1:8787/api/v1';
const r = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'Admin2026lab' }),
});
const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
console.log('login:', r.status, 'cookie:', cookie ? 'ok' : 'none');

const h = await fetch(`${BASE}/health`);
console.log('health:', h.status);

function tryOnce(mode, waitMs = 40000) {
  return new Promise((resolve) => {
    const sid = `diag_${mode}_${Date.now()}`;
    const events = [];
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:8787/api/v1/chat/${sid}`,
        { headers: { cookie }, handshakeTimeout: 10000 });
    } catch (e) {
      resolve([{ ev: 'ctor_error', msg: e.message }]); return;
    }
    const done = () => { try { ws.close(); } catch {} resolve(events); };
    ws.on('open', () => { events.push({ ev: 'open' }); ws.send(JSON.stringify({ type: 'prompt', message: '什么是索引？', retrieval: mode })); });
    ws.on('message', (d) => {
      let f; try { f = JSON.parse(d.toString()); } catch { return; }
      events.push({ ev: 'frame', type: f.type, keys: Object.keys(f).slice(0, 10),
                    sample: JSON.stringify(f).slice(0, 180) });
      if (['settled', 'agent_error', 'error'].includes(f.type)) done();
    });
    ws.on('error', (e) => { events.push({ ev: 'error', msg: e.message }); done(); });
    ws.on('close', (code, reason) => { events.push({ ev: 'close', code, reason: String(reason).slice(0, 120) }); done(); });
    ws.on('unexpected-response', (_req, res) => { events.push({ ev: 'unexpected', status: res.statusCode }); done(); });
    setTimeout(() => { events.push({ ev: 'timeout' }); done(); }, waitMs);
  });
}

for (const mode of ['none', 'wiki']) {
  console.log(`\n--- ${mode} ---`);
  const evs = await tryOnce(mode);
  for (const e of evs) console.log('   ', JSON.stringify(e).slice(0, 260));
  const h2 = await fetch(`${BASE}/health`).catch((e) => ({ status: `ERR ${e.message}` }));
  console.log('   health after:', h2.status);
}
