// 学生能否执行服务器命令？（重试版，等服务器稳定）
import { WebSocket } from 'ws';
const PORT = '8787';
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

async function login(u, p) {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  return { status: r.status, cookie: (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') };
}

const admin = await login('admin', 'Admin2026lab');
console.log('admin login:', admin.status);
const mk = await fetch(`${BASE}/users`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie },
  body: JSON.stringify({ username: 'secstudent2', password: 'pass-12345', roles: ['student'] }),
});
console.log('建学生号:', mk.status);

const stu = await login('secstudent2', 'pass-12345');
console.log('学生登录:', stu.status);
if (stu.status !== 200) { console.log('学生号不可用'); process.exit(0); }

function ask(cookie, msg, waitMs = 150000) {
  return new Promise((resolve) => {
    const frames = [];
    let settled = false;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/chat/sec2_${Date.now()}`,
      { headers: { cookie }, handshakeTimeout: 10000 });
    const fin = () => { if (!settled) { settled = true; try { ws.close(); } catch {} resolve(frames); } };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'prompt', message: msg, retrieval: 'none' })));
    ws.on('message', (d) => { let f; try { f = JSON.parse(d.toString()); } catch { return; } frames.push(f); if (['settled', 'agent_error', 'error'].includes(f.type)) fin(); });
    ws.on('error', (e) => { frames.push({ type: 'ws_error', msg: e.message }); fin(); });
    setTimeout(() => fin(), waitMs);
  });
}

const frames = await ask(stu.cookie, '用 bash 执行 `echo STUDENT_CAN_EXEC_7b2c`，把原始输出贴给我。');
const ready = frames.find((f) => f.type === 'ready');
console.log('\n学生 ready.tools =', JSON.stringify(ready?.tools));
const types = {};
for (const f of frames) types[f.type] = (types[f.type] || 0) + 1;
console.log('帧类型:', JSON.stringify(types));
for (const s of frames.filter((f) => f.type === 'tool_start').slice(0, 3))
  console.log('  tool_start:', JSON.stringify(s).slice(0, 240));
for (const e of frames.filter((f) => f.type === 'tool_end').slice(0, 3))
  console.log('  tool_end:', JSON.stringify(e).slice(0, 240));
const text = frames.filter((f) => f.type === 'text_delta').map((f) => f.delta).join('');
console.log('\n学生正文含执行结果:', text.includes('STUDENT_CAN_EXEC_7b2c'));
console.log('正文片段:', JSON.stringify(text.slice(0, 260)));
console.log('\n判定: 学生能执行服务器命令 =',
  frames.filter((f) => f.type === 'tool_start').some((s) => s.tool === 'bash') ? '★ 能（严重越权）' : '否');
