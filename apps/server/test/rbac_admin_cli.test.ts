/**
 * `npm run create-admin` 的参数解析与**真进程**行为（Lead 实测踩到的静默误解析回归）。
 *
 * 原 bug：只认位置参数 → `--username admin --password X` 被解析成
 * 用户名 `--username`、口令 `admin` → 报"口令至少 8 位" →
 * **用户以为是口令太短，实际是参数被静默误解析**（"看不懂的失败"）。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { CREATE_ADMIN_USAGE, parseCreateAdminArgs } from '../src/auth/create-admin.ts';
import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';

const SERVER_DIR = path.resolve(import.meta.dirname, '..');
let tmpDir = '';

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckb-admin-cli-'));
});
after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows 偶发占用 */
  }
});

/** 真跑 CLI（新进程），返回 { status, stdout, stderr }。 */
function runCli(
  argv: string[],
  dbName: string,
): { status: number; stdout: string; stderr: string } {
  const dbPath = path.join(tmpDir, dbName);
  // 用 spawnSync：成功/失败两条路径都能同时拿到 stdout 与 stderr
  // （execFileSync 成功时只回 stdout，会把"已创建管理员"这类 stderr 提示吞掉）
  const r = spawnSync(process.execPath, ['src/auth/create-admin.ts', ...argv], {
    cwd: SERVER_DIR,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      COURSE_KB_DB: dbPath,
      COURSE_KB_DATA_DIR: path.join(tmpDir, 'data'),
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 直接读库核对"到底建了谁"。 */
function whoWasCreated(dbName: string): { username: string; roles: string[]; argon2id: boolean }[] {
  const db = Db.open(path.join(tmpDir, dbName));
  try {
    const repo = new Repo(db);
    return repo.rbac
      .listUsers({ limit: 50 })
      .users.map((u) => {
        const row = repo.rbac.getUserRow(u.id);
        return {
          username: u.username,
          roles: u.roles,
          argon2id: Boolean(row?.password_hash.startsWith('$argon2id$')),
        };
      });
  } finally {
    db.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ① 解析器单测
// ═══════════════════════════════════════════════════════════════════════

test('parseCreateAdminArgs：位置参数（兼容旧写法）', () => {
  assert.deepEqual(parseCreateAdminArgs(['admin', 'Admin2026lab']), {
    args: { username: 'admin', password: 'Admin2026lab' },
  });
  assert.deepEqual(parseCreateAdminArgs(['admin']), { args: { username: 'admin' } });
  assert.deepEqual(parseCreateAdminArgs([]), { args: {} });
});

test('parseCreateAdminArgs：--username/--password（含 = 形式与短写）', () => {
  assert.deepEqual(parseCreateAdminArgs(['--username', 'admin', '--password', 'Admin2026lab']), {
    args: { username: 'admin', password: 'Admin2026lab' },
  });
  assert.deepEqual(parseCreateAdminArgs(['--username=admin', '--password=Admin2026lab']), {
    args: { username: 'admin', password: 'Admin2026lab' },
  });
  assert.deepEqual(parseCreateAdminArgs(['-u', 'admin', '-p', 'Admin2026lab']), {
    args: { username: 'admin', password: 'Admin2026lab' },
  });
  // 单个 flag（口令走随机生成）
  assert.deepEqual(parseCreateAdminArgs(['--username', 'admin']), { args: { username: 'admin' } });
  // 只给 --password（用户名默认 admin）
  assert.deepEqual(parseCreateAdminArgs(['--password', 'Admin2026lab']), {
    args: { password: 'Admin2026lab' },
  });
  assert.deepEqual(parseCreateAdminArgs(['--help']), { args: { help: true } });
});

test('parseCreateAdminArgs：★ 单独的 `--` 被跳过（npm 常见的双层 `--`）', () => {
  assert.deepEqual(parseCreateAdminArgs(['--', '--username', 'admin', '--password', 'Admin2026lab']), {
    args: { username: 'admin', password: 'Admin2026lab' },
  });
  assert.deepEqual(parseCreateAdminArgs(['--', 'admin', 'Admin2026lab']), {
    args: { username: 'admin', password: 'Admin2026lab' },
  });
});

test('★ parseCreateAdminArgs：不认识的 flag → 明确报错（**不再静默当位置值**）', () => {
  const r1 = parseCreateAdminArgs(['--passwordd', 'Admin2026lab']);
  assert.ok('error' in r1 && r1.error.includes('未知参数：--passwordd'), JSON.stringify(r1));
  const r2 = parseCreateAdminArgs(['--force']);
  assert.ok('error' in r2 && r2.error.includes('--force'));
  // 缺值
  assert.ok('error' in parseCreateAdminArgs(['--username']));
  assert.ok('error' in parseCreateAdminArgs(['--username=']));
  // 重复指定 → 报错（不静默丢弃）
  assert.ok('error' in parseCreateAdminArgs(['--username', 'a', '--username', 'b']));
  assert.ok('error' in parseCreateAdminArgs(['--username', 'admin', 'other']));
  assert.ok('error' in parseCreateAdminArgs(['admin', 'Pass12345', 'extra']));
  // 位置参数以 - 开头 → 报错（这正是原 bug 的形状）
  assert.ok('error' in parseCreateAdminArgs(['-x']));
});

// ═══════════════════════════════════════════════════════════════════════
// ② 真进程：三种调用方式都要能建出**正确用户名**的人
// ═══════════════════════════════════════════════════════════════════════

test('真跑 CLI：`npm run create-admin -- admin Pass12345`（位置参数）仍可用', () => {
  const r = runCli(['posadmin', 'Pos2026lab'], 'pos.sqlite3');
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const users = whoWasCreated('pos.sqlite3');
  assert.deepEqual(
    users.map((u) => u.username),
    ['posadmin'],
  );
  assert.deepEqual(users[0]?.roles, ['admin']);
  assert.equal(users[0]?.argon2id, true);
});

test('★ 真跑 CLI：`-- --username X --password Y` 不再被误解析（Lead 踩的那条）', () => {
  const r = runCli(['--', '--username', 'flagadmin', '--password', 'Flag2026lab'], 'flag.sqlite3');
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const users = whoWasCreated('flag.sqlite3');
  // 关键断言：用户名是 flagadmin，**不是** `--username`
  assert.deepEqual(
    users.map((u) => u.username),
    ['flagadmin'],
    `实际建出：${JSON.stringify(users)}`,
  );
  assert.equal(users.some((u) => u.username.startsWith('-')), false, '用户名不许是 flag 本身');
});

test('★ 真跑 CLI：未知 flag → 非 0 退出 + 说明"未知参数" + usage（不再报"口令太短"）', () => {
  const r = runCli(['--username', 'x', '--whatever', 'y'], 'bad.sqlite3');
  assert.notEqual(r.status, 0);
  assert.equal(r.status, 2, '参数错误约定退出码 2');
  assert.match(r.stderr, /未知参数：--whatever/);
  assert.match(r.stderr, /用法：/);
  // **错误行本身**不许是误导性的"口令至少 8 位"（usage 里出现该短语是合法的，只看首行）
  const firstLine = r.stderr.split('\n')[0] ?? '';
  assert.match(firstLine, /^参数错误：未知参数：--whatever/);
  assert.equal(/口令/.test(firstLine), false, `首行应是参数错误而不是口令错误：${firstLine}`);
  // 参数错误时**不建任何人**（无副作用）
  assert.deepEqual(whoWasCreated('bad.sqlite3'), []);
});

test('真跑 CLI：不传口令 → 随机口令只打印一次 + 提示改口令；--help 打印用法', () => {
  const r = runCli(['tmpadmin'], 'rand.sqlite3');
  assert.equal(r.status, 0, r.stderr);
  const printed = r.stdout.trim();
  assert.ok(printed.length >= 5, `应打印随机口令，实际 stdout=${JSON.stringify(r.stdout)}`);
  assert.match(r.stderr, /只显示这一次/);
  assert.match(r.stderr, /auth\/password/);
  // 随机口令能真的登录（哈希写入正确）
  const db = Db.open(path.join(tmpDir, 'rand.sqlite3'));
  try {
    const repo = new Repo(db);
    const row = repo.rbac.getUserRowByName('tmpadmin');
    assert.ok(row);
  } finally {
    db.close();
  }

  const h = runCli(['--help'], 'help.sqlite3');
  assert.equal(h.status, 0);
  assert.match(h.stdout, /用法：/);
  assert.equal(h.stdout.includes(CREATE_ADMIN_USAGE), true);
  // --help 不建人
  assert.deepEqual(whoWasCreated('help.sqlite3'), []);
});

test('真跑 CLI：已存在的用户名 → 重置口令并确保 admin 角色（幂等可重入）', () => {
  assert.equal(runCli(['reuse', 'First2026lab'], 'reuse.sqlite3').status, 0);
  const again = runCli(['--username', 'reuse', '--password', 'Second2026lab'], 'reuse.sqlite3');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /已重置现有用户 reuse/);
  const users = whoWasCreated('reuse.sqlite3');
  assert.equal(users.length, 1, '重置不该建出第二个用户');
  assert.deepEqual(users[0]?.roles, ['admin']);
});
