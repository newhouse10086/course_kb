/**
 * 首个管理员引导（`docs/RBAC.md` §7）—— **绝不硬编码默认口令**。
 *
 * 两条路径：
 * 1. 环境变量 `COURSE_KB_BOOTSTRAP_ADMIN=用户名:初始口令`（**仅当库里没有任何用户时**生效）
 * 2. CLI：`npm run create-admin -- <用户名> [口令]`（不传口令则**随机生成并打印一次**）
 *
 * ⚠️ 第 1 条"仅当无用户"是关键：否则每次重启都会把管理员口令重置成环境变量里的旧值
 * （相当于一个"持久后门"，而且没人会发现）。
 */

import crypto from 'node:crypto';

import { loadConfig, ensureDirs } from '../config.ts';
import { Db } from '../store/db.ts';
import { Repo } from '../store/repo.ts';
import { hashPassword, passwordProblem } from './password.ts';

export interface BootstrapResult {
  created: boolean;
  userId?: string;
  username: string;
  /** 随机生成的口令（**只打印一次**，调用方负责提示用户立刻改） */
  generatedPassword?: string;
  skippedReason?: string;
}

/**
 * 若「库里零用户」且配置了 bootstrap → 建首个 admin。
 * 已存在用户 → **什么都不做**（返回 skippedReason，便于日志说明）。
 */
export async function bootstrapAdmin(repo: Repo, cfg: { bootstrapAdmin: { username: string; password: string } | null }): Promise<BootstrapResult | null> {
  const spec = cfg.bootstrapAdmin;
  if (!spec) return null;
  if (repo.rbac.countUsers() > 0) {
    return {
      created: false,
      username: spec.username,
      skippedReason: '库里已有用户，bootstrap 不再生效（避免每次重启重置口令）',
    };
  }
  const problem = passwordProblem(spec.password);
  if (problem) {
    // **如实拒绝启动**：宁可不启动，也不要建一个弱口令管理员
    throw new Error(`COURSE_KB_BOOTSTRAP_ADMIN 的口令不合规：${problem}`);
  }
  const id = repo.rbac.createUser({
    username: spec.username,
    displayName: `${spec.username}（bootstrap admin）`,
    passwordHash: await hashPassword(spec.password),
    roles: ['admin'],
  });
  repo.rbac.audit({ userId: id, action: 'bootstrap_admin', target: id, detail: { username: spec.username } });
  return { created: true, userId: id, username: spec.username };
}

/** CLI：创建（或重置）一个管理员。 */
export async function createAdminCli(argv: string[]): Promise<number> {
  const cfg = loadConfig();
  ensureDirs(cfg);
  const db = Db.open(cfg.dbPath);
  try {
    const repo = new Repo(db);
    const username = argv[0] ?? 'admin';
    const explicit = argv[1];
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
      process.stderr.write(`用户名不合规：${username}（需 3–32 位字母/数字/._-）\n`);
      return 2;
    }
    const password = explicit ?? crypto.randomBytes(12).toString('base64url');
    const problem = passwordProblem(password);
    if (problem) {
      process.stderr.write(`${problem}\n`);
      return 2;
    }
    const existing = repo.rbac.getUserRowByName(username);
    if (existing) {
      repo.rbac.setPassword(existing.id, await hashPassword(password));
      if (!repo.rbac.rolesOf(existing.id).includes('admin')) repo.rbac.setRoles(existing.id, [...repo.rbac.rolesOf(existing.id), 'admin']);
      repo.rbac.deleteUserSessions(existing.id);
      process.stderr.write(`已重置现有用户 ${username} 的口令并确保其具备 admin 角色\n`);
    } else {
      repo.rbac.createUser({
        username,
        displayName: `${username}（管理员）`,
        passwordHash: await hashPassword(password),
        roles: ['admin'],
      });
      process.stderr.write(`已创建管理员 ${username}\n`);
    }
    repo.rbac.audit({ userId: null, action: 'create_admin_cli', target: username });
    if (!explicit) {
      // 只打印一次；提示立刻修改
      process.stdout.write(`${password}\n`);
      process.stderr.write('（上面是随机生成的口令，只显示这一次；登录后请立刻 POST /api/v1/auth/password 修改）\n');
    }
    return 0;
  } finally {
    db.close();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
  createAdminCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`create-admin 失败：${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
