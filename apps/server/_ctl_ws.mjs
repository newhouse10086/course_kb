// 受控实验：区分「我发 prompt 导致服务崩」与「node --watch 因他人改文件重启」。
// 做法：先静默观测 20s（不发任何请求），记录 /health 中断次数；再发 prompt，记录中断次数。
const BASE = 'http://127.0.0.1:8787/api/v1';
import { WebSocket } from 'ws';

async function health() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) });
    return r.status;
  } catch (e) {
    return `ERR:${e.name}`;
  }
}

async function observe(seconds, label) {
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    samples.push(await health());
    await new Promise((r) => setTimeout(r, 700));
  }
  const bad = samples.filter((s) => s !== 200);
  console.log(`  [${label}] 采样 ${samples.length} 次，非200 ${bad.length} 次 ${bad.length ? JSON.stringify([...new Set(bad)]) : ''}`);
  return bad.length;
}

console.log('=== 阶段 0：静默观测（不发任何请求，看 --watch 是否因他人改文件重启）===');
const idle = await observe(20, '静默 20s');

console.log('\n=== 阶段 1：连续打 /health（纯读，不应致死）===');
const busy = await observe(10, '读 10s');

console.log('\n=== 阶段 2：发一次 prompt，然后立刻观测 ===');
const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'Admin2026lab' }),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
console.log('  login:', login.status);

const promptErr = await new Promise((resolve) => {
  let settled = false;
  const sid = `ctl_${Date.now()}`;
  const ws = new WebSocket(`ws://127.0.0.1:8787/api/v1/chat/${sid}`,
    { headers: { cookie }, handshakeTimeout: 8000 });
  const fin = (v) => { if (!settled) { settled = true; try { ws.close(); } catch {} resolve(v); } };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'prompt', message: '什么是索引？', retrieval: 'none' })));
  ws.on('message', (d) => { try { const f = JSON.parse(d.toString()); if (f.type !== 'ready') console.log('    帧:', String(d).slice(0, 150)); } catch {} });
  ws.on('error', (e) => fin(`error:${e.message}`));
  ws.on('close', (c) => fin(`close:${c}`));
  setTimeout(() => fin('timeout'), 30000);
});
console.log('  prompt 会话结束于:', promptErr);
const after = await observe(15, 'prompt 后 15s');

console.log('\n=== 判定 ===');
console.log(`  静默期中断 ${idle} 次 / 读期 ${busy} 次 / prompt 后 ${after} 次`);
if (idle > 0) console.log('  ⟹ 静默期就有中断 → 主因是 **node --watch 因他人改文件重启**，不是我的请求打崩的');
else if (after > busy) console.log('  ⟹ 发 prompt 后中断明显增加 → 疑似 prompt 路径真的让服务退出（真 bug）');
else console.log('  ⟹ 未观测到因 prompt 导致的中断');
