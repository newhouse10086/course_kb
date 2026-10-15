/**
 * ★ 复现 `COURSE_KB_BOOTSTRAP_ADMIN` 在**全新库**上是否生效（Lead 的判据）。
 *
 * 用**隔离实例**（独立 DB / dataDir / settings / 端口），直接 `node src/index.ts` 起服务
 * （不走 `npm start` —— 坑 26：npm 包装进程会让"新实例"其实是旧进程）。
 * 断言：`/capabilities.auth.bootstrap === 'initialized'` + 用 bootstrap 口令**真登录成功**。
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const SERVER = path.join(ROOT, 'apps', 'server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-probe-'));
const USER = 'admin';
const PASS = 'Admin2026lab';

// 找一个空闲端口
const port = await new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port;
    srv.close(() => resolve(p));
  });
});

const env = {
  ...process.env,
  COURSE_KB_DB: path.join(tmp, 'fresh.sqlite3'),
  COURSE_KB_DATA_DIR: path.join(tmp, 'data'),
  COURSE_KB_SETTINGS_FILE: path.join(tmp, 'settings.json'),
  COURSE_KB_PORT: String(port),
  COURSE_KB_BOOTSTRAP_ADMIN: `${USER}:${PASS}`,
};

console.log('隔离实例: db=%s port=%d', path.basename(env.COURSE_KB_DB), port);
console.log('COURSE_KB_BOOTSTRAP_ADMIN 已设置 = %s（口令不回显）', Boolean(env.COURSE_KB_BOOTSTRAP_ADMIN));

const child = spawn(process.execPath, ['src/index.ts'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => (out += String(d)));
child.stderr.on('data', (d) => (out += String(d)));

const base = `http://127.0.0.1:${port}`;
const waitHealth = async (ms = 60_000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    try {
      const r = await fetch(`${base}/api/v1/health`);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((x) => setTimeout(x, 300));
  }
  return false;
};

const cleanup = async () => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  // 坑 26：按端口补杀，确认真的停了
  await new Promise((x) => setTimeout(x, 500));
  try {
    const r = await fetch(`${base}/api/v1/health`).catch(() => null);
    console.log('收尾: 端口 %d 仍可访问 = %s', port, Boolean(r?.ok));
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows 偶发占用 */
  }
};

try {
  const up = await waitHealth();
  console.log('服务起来 = %s', up);
  const bootLog = out.split(/\r?\n/).filter((l) => l.includes('[auth]')).join(' || ');
  console.log('★ 启动日志 [auth]: %s', bootLog || '(无)');

  if (up) {
    const caps = await fetch(`${base}/api/v1/capabilities`).then((r) => r.json());
    const bootstrap = caps?.auth?.bootstrap;
    console.log('★ /capabilities auth.bootstrap = %s（期望 initialized）', JSON.stringify(bootstrap));

    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS }),
    });
    const body = await login.json();
    console.log('★ 用 bootstrap 口令登录: HTTP %d | ok=%s | user=%s', login.status, body?.ok ?? body?.user?.username ?? '(无)', JSON.stringify(body?.user?.username ?? body?.error ?? '').slice(0, 80));
    console.log('---');
    console.log(
      '★ 判定: bootstrap 生效 = %s',
      bootstrap === 'initialized' && login.status === 200 ? '✅ 是（契约成立）' : '❌ 否（复现了缺陷）',
    );
  }
} finally {
  await cleanup();
}
process.exit(0);
