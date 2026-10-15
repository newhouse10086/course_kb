/**
 * ★★ 真 HTTP 落盘验证（**零 LLM**）：请求真的进日志文件；**假密钥 grep 不到**；env 真的被读。
 *
 * 这一层是必需的 —— 单测（`test/logging.test.ts`）只证明"日志器本身对"，
 * 证明不了"**接入点真的把请求写进去了**"（坑 21：不走真实路径就测不出）。
 *
 * 隔离实例：用 `buildApp({ cfg })` + 临时目录 + **端口 0**（系统分配，绝不占用 8787/5173）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApp } from '../src/index.ts';
import { loadConfig } from '../src/config.ts';
import { findSensitiveLeaks } from '../src/logging/index.ts';

const FAKE_KEY = 'sk-FAKE-LOGKEY-0123456789abcdef';

function readLogs(dir: string): string {
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

test('★★ 真 HTTP：启动行 + 请求行落盘；★ 假密钥（URL 查询串 / 请求体）grep 不到', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-log-http-'));
  const dataDir = join(root, 'data');
  const logDir = join(dataDir, 'logs');
  const cfg = loadConfig({
    root,
    env: {
      COURSE_KB_ROOT: root,
      COURSE_KB_DATA_DIR: dataDir,
      COURSE_KB_LOG_DIR: logDir,
      COURSE_KB_LOG_LEVEL: 'info',
      COURSE_KB_DB: join(dataDir, 'test.sqlite3'),
      COURSE_KB_BOOTSTRAP_ADMIN: 'log_admin:log-pass-123',
    },
  });
  const built = await buildApp({ cfg, chatFactory: null }); // 不起 pi/agent
  try {
    assert.ok(built.logging, '必须启用了落盘日志');
    // ① 启动行（main() 里写；测试里手动等价调用一次，再断言文件确实被创建）
    built.logging!.writeLine({ event: 'startup', logFile: built.logging!.file }, 'server starting');
    assert.ok(existsSync(built.logging!.file), `日志文件必须被创建：${built.logging!.file}`);

    await built.app.listen({ host: '127.0.0.1', port: 0 });
    const addr = built.app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    assert.ok(port > 0, '必须拿到真实端口（用 0 让系统分配，避免占用 8787/5173）');
    const base = `http://127.0.0.1:${port}`;

    // ② 正常请求（健康检查，无需登录）
    const okResp = await fetch(`${base}/api/v1/health`);
    assert.equal(okResp.status, 200);

    // ③ 带假密钥的请求：查询串 + 请求体 + 头（未登录 → 401；关键是**日志里不许出现密钥**）
    const loginResp = await fetch(`${base}/api/v1/auth/login?token=${FAKE_KEY}&page=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${FAKE_KEY}`, cookie: `kb_session=${FAKE_KEY}` },
      body: JSON.stringify({ username: 'log_admin', password: FAKE_KEY, api_key: FAKE_KEY }),
    }).catch(() => undefined);
    // 未知路径：登录前会被鉴权钩子拦下（401）——**按实际返回码断言**，不硬编码
    const unknownResp = await fetch(`${base}/api/v1/definitely-not-here?token=${FAKE_KEY}`);
    const unknownStatus = unknownResp.status;
    assert.ok([401, 404].includes(unknownStatus), `未知路径应为 401（鉴权先拦）或 404，实际 ${unknownStatus}`);

    // ④ 等 onResponse 钩子写完（同步写，但钩子在响应之后触发）
    await new Promise((r) => setTimeout(r, 300));

    const text = readLogs(logDir);
    assert.ok(text.length > 0, `日志文件不能为空（目录 ${logDir}）`);
    // 启动行
    assert.match(text, /server starting/);
    assert.match(text, /"event":"startup"/);
    // 请求行：方法/路径/状态/耗时
    assert.match(text, /"msg":"request"/);
    assert.match(text, /\/api\/v1\/health/);
    assert.match(text, /"status":200/);
    assert.match(text, /"ms":/);
    assert.match(text, /"method":"GET"/);
    assert.match(text, /"path":"\/api\/v1\/definitely-not-here"/, '★ 路径里不许带查询串');
    assert.match(text, new RegExp(`"path":"/api/v1/definitely-not-here","status":${unknownStatus}`));
    assert.ok(loginResp === undefined || text.includes(`"status":${loginResp.status}`), '登录请求（带密钥）也要被记，且只记状态码');
    // ★★ 假密钥不许出现（URL 查询串、Authorization 头、Cookie、请求体、密码字段）
    const leaks = findSensitiveLeaks(text, [FAKE_KEY]);
    assert.deepEqual(leaks, [], `★ 日志里 grep 到了假密钥（${leaks.length} 处）—— 脱敏没生效`);
    // ★★ 响应侧也要 grep（lead 新加）：`set-cookie` / `Bearer` / `token=` 这些**响应**面的东西
    for (const pattern of ['set-cookie', 'set-cookie:', 'token=' + FAKE_KEY, 'Bearer ' + FAKE_KEY]) {
      assert.ok(!text.includes(pattern), `★ 响应侧泄漏：日志里出现了 ${pattern.slice(0, 24)}`);
    }
    // ★★ 不许把 Fastify 的原始对象 dump 进日志（lead 实测：`res.raw` 让 90 秒涨到 83.8KB，≈17KB/请求）
    for (const key of ['"raw":', '"_readableState"', '"_consuming"', '"[Symbol(', 'socket']) {
      assert.ok(!text.includes(key), `★ 不该出现底层对象字段 ${key}（会把日志放大 ~100 倍）`);
    }
    // ★★ 判据：一条请求日志行 **≤ 300 字节**（正常应在 ~150 字节）
    const requestLines = text.split('\n').filter((l) => l.includes('"msg":"request"'));
    assert.ok(requestLines.length >= 2, `应有多条请求行，实际 ${requestLines.length}`);
    for (const line of requestLines) {
      const bytes = Buffer.byteLength(line, 'utf8');
      assert.ok(bytes <= 300, `请求行过大（${bytes} 字节）：${line.slice(0, 120)}…`);
    }
    // ★★ 判据（lead 新加）：**不该有底层对象 dump**。
    //    "最长行 ≤ N 字节"这个粗判据会把"带堆栈的错误行"误伤（那是**要**的，见需求 6），
    //    所以判据改成：**长行只允许是带 stack 的错误行**，其余必须紧凑。
    const allLines = text.split('\n').filter((l) => l.trim() !== '');
    for (const line of allLines) {
      const bytes = Buffer.byteLength(line, 'utf8');
      if (bytes <= 1000) continue;
      const isErrorWithStack = /"level":(4\d|5\d|60)/.test(line) && line.includes('"stack"');
      assert.ok(
        isErrorWithStack,
        `★ 长行（${bytes} 字节）既不是错误行、也没有堆栈 → 疑似把对象 dump 进来了：${line.slice(0, 160)}…`,
      );
      assert.ok(bytes <= 8000, `单行 ${bytes} 字节过大（错误行也不该这么大）`);
    }
    const maxAny = Math.max(...allLines.map((l) => Buffer.byteLength(l, 'utf8')));
    assert.ok(maxAny <= 8000, `单行最长 ${maxAny} 字节（Fastify 默认 dump 是 ~5.7KB/请求，这里应当远小于）`);
    assert.ok(!text.includes('?token='), '路径里不许带查询串');
    // ★ 启动行也必须是紧凑的（不是几 KB）
    const startupLines = text.split('\n').filter((l) => l.includes('"event":"startup"'));
    assert.ok(startupLines.length >= 1);
    for (const line of startupLines) assert.ok(Buffer.byteLength(line, 'utf8') <= 800, '启动行过大');
  } finally {
    await built.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('★ env 真的被读：`COURSE_KB_LOG_DIR` 指到哪就写哪；`COURSE_KB_LOG_LEVEL=debug` 时 debug 行出现', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-log-env-'));
  const dataDir = join(root, 'data');
  const customLogDir = join(root, '自定义目录', 'logs'); // 含中文，验证路径处理
  const cfg = loadConfig({
    root,
    env: {
      COURSE_KB_ROOT: root,
      COURSE_KB_DATA_DIR: dataDir,
      COURSE_KB_LOG_DIR: customLogDir,
      COURSE_KB_LOG_LEVEL: 'debug',
      COURSE_KB_DB: join(dataDir, 'test.sqlite3'),
    },
  });
  assert.equal(cfg.logging.dir, customLogDir, 'COURSE_KB_LOG_DIR 必须真的被读');
  assert.equal(cfg.logging.level, 'debug', 'COURSE_KB_LOG_LEVEL 必须真的被读');

  const built = await buildApp({ cfg, chatFactory: null });
  try {
    assert.equal(built.logging!.level, 'debug');
    built.logging!.debug({ probe: 'env' }, 'debug-probe-line');
    built.logging!.close();
    const text = readLogs(customLogDir);
    assert.match(text, /debug-probe-line/, '★ debug 级别必须真的落 debug 行（证明级别生效，而不是死旋钮）');
    assert.ok(!existsSync(join(dataDir, 'logs')), '不该写到默认目录（env 已指定）');
  } finally {
    await built.close();
    rmSync(root, { recursive: true, force: true });
  }
});
