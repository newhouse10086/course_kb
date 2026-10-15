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

export interface CreateAdminArgs {
  username?: string;
  password?: string;
  help?: boolean;
}

export const CREATE_ADMIN_USAGE = `用法：
  npm run create-admin -- <用户名> [口令]                 # 位置参数（兼容旧写法）
  npm run create-admin -- --username <用户名> [--password <口令>]

说明：
  · 不传口令 → **随机生成**并只打印一次（登录后请立刻改）
  · 口令至少 8 位；用户名 3–32 位（字母/数字/._-）
  · 已存在的用户名 → 重置其口令并确保具备 admin 角色

可选：
  -u, --username <u>   用户名
  -p, --password <p>   口令
  --help               显示本说明
`;

/**
 * 解析 CLI 参数。
 *
 * ⚠️ **原实现的真 bug（Lead 实测踩到）**：只按位置参数取值（`argv[0]`=用户名、`argv[1]`=口令），
 * 于是 `--username admin --password X` 被当成 **用户名 `--username`**、口令 `admin` →
 * 报"口令至少 8 位" → **用户以为是自己口令太短，实际是参数被静默误解析**（"看不懂失败"那类）。
 *
 * 现在：① 支持 `--username/--password`（含 `--k=v` 与 `-u/-p`）；
 * ② **不认识的 `--flag` 直接报错**（绝不静默当位置值）；③ 同一槽位两种写法重复指定 → 报错；
 * ④ 单独的 `--` 按 npm/通用习惯**跳过**继续解析。
 */
export function parseCreateAdminArgs(argv: string[]): { args: CreateAdminArgs } | { error: string } {
  const args: CreateAdminArgs = {};
  const positionals: string[] = [];
  let usernameFromFlag = false;
  let passwordFromFlag = false;

  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i] as string;
    // 单独的 `--`：npm `run --` 之后还会再带一层 `--` 时会出现，跳过而不是当成"选项结束"
    if (tok === '--') continue;
    if (tok === '--help' || tok === '-h') {
      args.help = true;
      continue;
    }

    let flag: string | null = null;
    let inline: string | null = null;
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      flag = eq >= 0 ? tok.slice(0, eq) : tok;
      inline = eq >= 0 ? tok.slice(eq + 1) : null;
    } else if (tok.startsWith('-') && tok.length > 1) {
      flag = tok;
    }

    if (flag !== null) {
      const isUser = flag === '--username' || flag === '--user' || flag === '-u';
      const isPass = flag === '--password' || flag === '--pass' || flag === '-p';
      if (!isUser && !isPass) {
        // ★ 不认识的 flag → 明确报错（"静默误解析"的根因）
        return { error: `未知参数：${flag}` };
      }
      let value: string;
      let consumedNext = false;
      if (inline !== null) {
        if (inline === '') return { error: `${flag} 需要一个值` };
        value = inline;
      } else {
        const next = argv[i + 1];
        if (next === undefined) return { error: `${flag} 需要一个值` };
        value = next;
        consumedNext = true;
      }
      if (isUser) {
        if (args.username !== undefined) return { error: '用户名被重复指定' };
        args.username = value;
        usernameFromFlag = true;
      } else {
        if (args.password !== undefined) return { error: '口令被重复指定' };
        args.password = value;
        passwordFromFlag = true;
      }
      if (consumedNext) i += 1;
      continue;
    }

    if (tok.startsWith('-')) return { error: `位置参数不能以 - 开头：${tok}` };
    positionals.push(tok);
  }

  if (positionals.length > 2) return { error: `位置参数过多：${positionals.slice(2).join(' ')}` };
  const [posUser, posPass] = positionals;
  if (posUser !== undefined) {
    if (usernameFromFlag) return { error: `用户名被重复指定：--username 与位置参数 ${posUser}` };
    args.username = posUser;
  }
  if (posPass !== undefined) {
    if (passwordFromFlag) return { error: '口令被重复指定：--password 与位置参数同时给了' };
    args.password = posPass;
  }
  return { args };
}

/** CLI：创建（或重置）一个管理员。 */
export async function createAdminCli(argv: string[]): Promise<number> {
  // 先解析参数（**在打开数据库之前**）：参数错了不该留下任何副作用
  const parsed = parseCreateAdminArgs(argv);
  if ('error' in parsed) {
    process.stderr.write(`参数错误：${parsed.error}\n\n${CREATE_ADMIN_USAGE}`);
    return 2;
  }
  if (parsed.args.help) {
    process.stdout.write(CREATE_ADMIN_USAGE);
    return 0;
  }

  const cfg = loadConfig();
  ensureDirs(cfg);
  const db = Db.open(cfg.dbPath);
  try {
    const repo = new Repo(db);
    const username = parsed.args.username ?? 'admin';
    const explicit = parsed.args.password;
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
      process.stderr.write(`用户名不合规：${username}（需 3–32 位字母/数字/._-）\n\n${CREATE_ADMIN_USAGE}`);
      return 2;
    }
    const password = explicit ?? crypto.randomBytes(12).toString('base64url');
    const problem = passwordProblem(password);
    if (problem) {
      process.stderr.write(`${problem}\n\n${CREATE_ADMIN_USAGE}`);
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
