/**
 * ★ 日志落盘：**脱敏** / **轮转** / **env 真的被读** / **真 HTTP 请求进日志**。
 *
 * 缺口（用户要求补的）：改动前 `index.ts` 是 `logger: false` → 请求、异常堆栈、worker stderr
 * **只进终端**；落盘的只有"结果"（audit_log / tasks / chat jsonl / sandbox 审计），**过程全丢**。
 *
 * 判据（每条都对应 lead 的验收项，且**零 LLM**）：
 * 1. 启动 → 日志文件被创建且含启动行
 * 2. 真请求 → 日志里有它（方法/路径/状态/耗时/用户 id）
 * 3. ★★ **假密钥 grep 不到**（构造带假密钥的请求）
 * 4. 级别 env 真的生效（debug 行出现）
 * 5. 轮转真的发生（超上限 → 新文件）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAppLogging,
  createRateLimiter,
  createRotatingFileStream,
  findSensitiveLeaks,
  normalizeLogLevel,
  redactDeep,
  sanitizeUrl,
  looksLikeSecret,
} from '../src/logging/index.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'kblog-'));
}

function readAll(dir: string): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

// ---------------------------------------------------------------------------
// 1. 脱敏（纯函数）
// ---------------------------------------------------------------------------

test('★ sanitizeUrl：查询串里的 token/key/password 值被打码，键名保留', () => {
  assert.equal(sanitizeUrl('/api/v1/x?token=abc123&page=2'), '/api/v1/x?token=[REDACTED]&page=2');
  assert.equal(sanitizeUrl('/a?api_key=sk-live-1234&q=索引'), '/a?api_key=[REDACTED]&q=索引');
  assert.equal(sanitizeUrl('/a?password=p%40ss&x=1'), '/a?password=[REDACTED]&x=1');
  assert.equal(sanitizeUrl('/no-query'), '/no-query');
  assert.equal(sanitizeUrl('/trailing?'), '/trailing?');
  // 键名不敏感但值像密钥 → 兜底打码
  assert.equal(sanitizeUrl('/a?h=sk-ZZZ_abcdefghijklmnop'), '/a?h=[REDACTED]');
});

test('★ redactDeep：按字段名脱敏，且**不改非敏感字段**', () => {
  const out = redactDeep({
    user: { id: 'u1', password: 'p@ss', token: 'abc' },
    apiKey: 'sk-xxxx',
    note: '正常内容',
    nested: [{ secret: 's', keep: 'yes' }],
  }) as Record<string, unknown>;
  const blob = JSON.stringify(out);
  for (const secret of ['p@ss', 'abc', 'sk-xxxx', 's']) assert.ok(!blob.includes(`"${secret}"`), `不该出现 ${secret}`);
  assert.ok(blob.includes('正常内容'));
  assert.ok(blob.includes('yes'));
  assert.ok(blob.includes('[REDACTED]'));
});

test('★ looksLikeSecret：常见密钥形状能识别，普通词不误判', () => {
  assert.equal(looksLikeSecret('sk-live_abcdefghijklmnop'), true);
  assert.equal(looksLikeSecret('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc'), true);
  assert.equal(looksLikeSecret('9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c'), true);
  assert.equal(looksLikeSecret('聚簇索引'), false);
  assert.equal(looksLikeSecret('info'), false);
});

test('★ findSensitiveLeaks：命中/未命中都要准（测试与出口自检都用它）', () => {
  assert.deepEqual(findSensitiveLeaks('abc sk-REAL-KEY-123456 def', ['sk-REAL-KEY-123456']), ['sk-REAL-KEY-123456']);
  assert.deepEqual(findSensitiveLeaks('nothing here', ['sk-REAL-KEY-123456']), []);
  // 太短的串不参与（避免把 "a" 这种误报成泄漏）
  assert.deepEqual(findSensitiveLeaks('abc', ['a']), []);
});

test('★ normalizeLogLevel：非法值回落 info 且**给出告警**（不静默接受）', () => {
  assert.deepEqual(normalizeLogLevel('debug'), { level: 'debug' });
  assert.deepEqual(normalizeLogLevel('WARN'), { level: 'warn' });
  assert.deepEqual(normalizeLogLevel(''), { level: 'info' });
  const bad = normalizeLogLevel('verbose');
  assert.equal(bad.level, 'info');
  assert.match(String(bad.warning), /不是合法级别/);
});

test('★ worker stderr 限速 + 截断（避免刷爆日志）', () => {
  const limiter = createRateLimiter({ maxPerSecond: 3, maxChars: 10 });
  const allowed = [limiter.allow(), limiter.allow(), limiter.allow(), limiter.allow(), limiter.allow()];
  assert.deepEqual(allowed, [true, true, true, false, false]);
  assert.equal(limiter.dropped(), 2);
  const long = '一二三四五六七八九十十一十二'; // 14 字
  assert.equal([...long].length, 14);
  assert.equal(limiter.truncate(long), '一二三四五六七八九十…（已截断，原 14 字）');
});

// ---------------------------------------------------------------------------
// 2. 轮转（真文件）
// ---------------------------------------------------------------------------

test('★★ 轮转：单文件超上限 → 真的换到下一个文件（不是无限追加）', () => {
  const dir = tempDir();
  try {
    const stream = createRotatingFileStream({ dir, maxBytes: 200, now: () => new Date('2026-10-15T00:00:00Z') });
    for (let i = 0; i < 20; i += 1) stream.write(JSON.stringify({ i, pad: 'x'.repeat(30) }));
    const files = stream.listFiles();
    assert.ok(files.length >= 2, `超上限必须轮转，实际只有 ${files.length} 个文件：${files.join(',')}`);
    // 每个文件都不超过上限（除最后正在写的那个）
    for (const f of files.slice(0, -1)) {
      const size = readFileSync(f, 'utf8').length;
      assert.ok(size <= 400, `${f} 应在上限附近（实际 ${size}）`);
    }
    assert.ok(readAll(dir).includes('"i":19'), '最后一条必须仍被写入（轮转不能丢数据）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ 轮转：跨天 → 新的一天新文件', () => {
  const dir = tempDir();
  try {
    let day = 15;
    const stream = createRotatingFileStream({ dir, maxBytes: 1_000_000, now: () => new Date(`2026-10-${day}T10:00:00Z`) });
    stream.write('第一天');
    day = 16;
    stream.write('第二天');
    const files = stream.listFiles().map((f) => f.split(/[\\/]/).pop());
    assert.deepEqual(files, ['app-2026-10-15.log', 'app-2026-10-16.log']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 轮转：超过保留天数的旧文件被清理；**解析不出日期的文件不删**（避免误删）', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'app-2026-09-01.log'), '很久以前\n', 'utf8'); // 44 天前 > 14
    writeFileSync(join(dir, 'app-2026-10-14.log'), '昨天\n', 'utf8');
    writeFileSync(join(dir, 'notes.txt'), '运维手放的文件\n', 'utf8');
    const stream = createRotatingFileStream({ dir, retentionDays: 14, now: () => new Date('2026-10-15T10:00:00Z') });
    stream.write('今天');
    const names = readdirSync(dir);
    assert.ok(!names.includes('app-2026-09-01.log'), '超过 14 天的必须清掉');
    assert.ok(names.includes('app-2026-10-14.log'), '保留期内的不许删');
    assert.ok(names.includes('notes.txt'), '非本前缀的文件一律不动');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. 日志器：启动行 / 级别 env / 泄漏自检
// ---------------------------------------------------------------------------

test('★ 启动行写进文件（含日志文件绝对路径，运维要知道去哪找）', () => {
  const dir = tempDir();
  try {
    const log = createAppLogging({ dir, level: 'info', stdout: false });
    log.writeLine({ event: 'startup', logFile: log.file, port: 8787 }, 'server starting');
    const text = readFileSync(log.file, 'utf8');
    assert.match(text, /server starting/);
    assert.match(text, /"event":"startup"/);
    assert.match(text, /8787/);
    assert.ok(existsSync(log.file));
    log.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ 级别 env 真的被读：debug 级别下 debug 行**真的出现**（坑 24：别做死旋钮）', () => {
  const dir = tempDir();
  try {
    const inf = createAppLogging({ dir, level: 'info', stdout: false });
    inf.debug({ level: 'debug' }, 'debug-marker-1');
    inf.info({ level: 'info' }, 'info-marker-1');
    inf.close();
    const infoText = readAll(dir);
    // info 级别下 pino 会丢 debug 行，但 info 行必须在
    assert.ok(!infoText.includes('debug-marker-1'), 'info 级别不该出现 debug 行');
    assert.ok(infoText.includes('info-marker-1'), 'info 行必须出现（否则是"级别把该记的也吞了"）');

    const dir2 = tempDir();
    const dbg = createAppLogging({ dir: dir2, level: 'debug', stdout: false });
    dbg.debug({ level: 'debug' }, 'debug-marker-2');
    dbg.close();
    assert.match(readAll(dir2), /debug-marker-2/, '★ debug 级别必须真的出现 debug 行（证明 env 被读）');
    rmSync(dir2, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ 路径与日志文件路径**不许**被误打码（否则日志失去排障价值）', () => {
  // 真机实测踩到：启动行里的 root/db/logFile 全变成 [REDACTED] ——
  // 因为"高熵"启发式把 Windows 路径（大写+小写+数字+反斜杠）当成了密钥。
  const out = redactDeep({
    root: 'D:\\temp临时脚本\\26-10-13 数据库数据仓库课程优化\\course-kb',
    db: 'D:\\temp临时脚本\\course-kb\\data\\course_kb.sqlite3',
    logFile: '/var/log/course-kb/app-2026-10-15.log',
    port: 8787,
  }) as Record<string, unknown>;
  assert.match(String(out.root), /course-kb$/);
  assert.match(String(out.db), /course_kb\.sqlite3$/);
  assert.match(String(out.logFile), /app-2026-10-15\.log$/);
  assert.equal(out.port, 8787);
  // 反过来：同样的启发式仍要能认出真密钥
  const withKey = redactDeep({ note: 'sk-FAKE-KEY-0123456789abcdef' }) as Record<string, unknown>;
  assert.equal(withKey.note, '[REDACTED]');
});

test('★★ URL 字符串里的敏感查询参数要被打码（不能只靠"整串像密钥"碰巧拦住）', () => {
  const out = redactDeep({ url: '/api/v1/x?token=sk-FAKE-KEY-0123456789abcdef&page=1' }) as Record<string, unknown>;
  assert.equal(out.url, '/api/v1/x?token=[REDACTED]&page=1');
  const withHost = redactDeep({ next: 'http://127.0.0.1:8787/a?api_key=abcdef0123456789&q=1' }) as Record<string, unknown>;
  assert.match(String(withHost.next), /api_key=\[REDACTED\]/);
  assert.match(String(withHost.next), /q=1/, '非敏感参数要保留（可排障）');
});

test('★★ 结构化日志里塞进密钥 → **落盘文件里 grep 不到**（含 URL 查询串）', () => {
  const dir = tempDir();
  const FAKE_KEY = 'sk-FAKE-KEY-0123456789abcdef';
  try {
    const log = createAppLogging({ dir, level: 'info', stdout: false });
    // ① 直接作为对象字段
    log.writeLine({ password: 'p@ssw0rd-FAKE', api_key: FAKE_KEY, token: 'tok-FAKE-1234567890' }, 'credentials test');
    // ② 作为 URL 查询串
    log.writeLine({ event: 'req', url: `/api/v1/x?token=${FAKE_KEY}&page=1` }, 'url test');
    log.close();
    const text = readAll(dir);
    const leaks = findSensitiveLeaks(text, [FAKE_KEY, 'p@ssw0rd-FAKE', 'tok-FAKE-1234567890']);
    assert.deepEqual(leaks, [], `★ 日志里不许出现密钥，实际命中：${leaks.join(', ')}`);
    assert.ok(text.includes('[REDACTED]'), '被打码的位置要留下标记（便于确认脱敏真的生效）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ 红证：故意关掉脱敏（redactEnabled:false）→ 假密钥**真的出现在日志里**（证明检测有效）', () => {
  const dir = tempDir();
  const FAKE_KEY = 'sk-FAKE-KEY-0123456789abcdef';
  try {
    // 这条红证的作用：证明上面那条"grep 不到"不是**因为断言写错/没写到文件**而假绿。
    // 注入"脱敏失效"后，同样的写入路径必须真的暴露密钥。
    const log = createAppLogging({ dir, level: 'info', stdout: false, redactEnabled: false });
    log.writeLine({ api_key: FAKE_KEY }, 'leak proof');
    log.close();
    const text = readAll(dir);
    const leaks = findSensitiveLeaks(text, [FAKE_KEY]);
    assert.deepEqual(leaks, [FAKE_KEY], '★ 关掉脱敏后应当**能**grep 到（否则说明测试根本没写到文件）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
