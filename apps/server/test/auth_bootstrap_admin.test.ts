/**
 * ★★ `COURSE_KB_BOOTSTRAP_ADMIN` 的**生效守卫**（坑 24：能配 ≠ 真的会生效）。
 *
 * ## 背景（真机排查过一次）
 * `web-ui` 在全新库上设了该变量却看到 `[auth] 尚无任何用户`，怀疑"启动路径不读它"。
 * 我用**隔离实例**实测复现：**变量真的到达进程时，启动路径会创建管理员**
 * （`/capabilities.auth.bootstrap = initialized` + 用该口令登录 200）→ **契约成立**，
 * 那次是环境问题（变量没进进程 / 看的是旧进程日志 —— 坑 26）。
 *
 * 但排查暴露了一个**真实的静默面**：变量**存在却格式不对**时，
 * `parseBootstrapAdmin` 返回 null → 与"根本没设"走同一条日志 → 运维以为变量没生效。
 * ⟹ 现在"设了但解析不了"**拒绝启动**（本文件守这条）。
 *
 * 真机端到端（全新库起隔离实例 + 真登录）见 `test/e2e/bootstrap_admin.e2e.mjs`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig, parseBootstrapAdmin } from '../src/config.ts';
import { buildApp } from '../src/index.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** 全新隔离配置（独立 DB/dataDir/settings） */
function freshEnv(tmp: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    COURSE_KB_DB: path.join(tmp, 'fresh.sqlite3'),
    COURSE_KB_DATA_DIR: path.join(tmp, 'data'),
    COURSE_KB_SETTINGS_FILE: path.join(tmp, 'settings.json'),
    ...extra,
  };
}

test('★ 解析：正常值解析成功；缺冒号/空用户名/空口令 → null', () => {
  assert.deepEqual(parseBootstrapAdmin('admin:Admin2026lab'), { username: 'admin', password: 'Admin2026lab' });
  assert.deepEqual(parseBootstrapAdmin('admin:pa:ss:word'), { username: 'admin', password: 'pa:ss:word' }, '口令里允许冒号');
  assert.equal(parseBootstrapAdmin(undefined), null);
  assert.equal(parseBootstrapAdmin(''), null);
  assert.equal(parseBootstrapAdmin('admin'), null, '★ 缺冒号 = 解析不了（不能静默当没设）');
  assert.equal(parseBootstrapAdmin(':pass'), null, '空用户名');
  assert.equal(parseBootstrapAdmin('admin:'), null, '空口令');
});

test('★★ 变量到达进程 → 全新库真的建出管理员（`countUsers()` 断言，不是"我们传了参数"）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-happy-'));
  let built: Awaited<ReturnType<typeof buildApp>> | null = null;
  try {
    const cfg = loadConfig({ root: ROOT, env: freshEnv(tmp, { COURSE_KB_BOOTSTRAP_ADMIN: 'admin:Admin2026lab' }) });
    assert.deepEqual(cfg.auth.bootstrapAdmin, { username: 'admin', password: 'Admin2026lab' }, '配置层必须解析出来');
    built = await buildApp({ cfg });
    // ★ 判据打在**库里的真实状态**上（坑 24/21）
    assert.equal(built.deps.repo.rbac.countUsers(), 1, '★ 全新库必须真的建出 1 个用户');
    const row = built.deps.repo.rbac.getUserRowByName('admin');
    assert.ok(row, '★ 必须能查到 admin 行');
    assert.equal(row.status, 'active', '★ 必须是可用状态（角色由端到端登录断言：e2e 里以 admin 身份登录 200）');
    assert.ok(row.password_hash && row.password_hash.length > 20, '★ 必须存的是**口令哈希**（不是明文）');
    assert.notEqual(row.password_hash, 'Admin2026lab', '★ 库里绝不能出现明文口令');
  } finally {
    try {
      if (built) await built.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('★★ 变量存在但格式不对 → **拒绝启动**（不许静默退化成"没设"）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-bad-'));
  try {
    // `admin` 没有冒号 → 解析为 null，但变量**确实存在**
    const cfg = loadConfig({ root: ROOT, env: freshEnv(tmp, { COURSE_KB_BOOTSTRAP_ADMIN: 'admin' }) });
    assert.equal(cfg.auth.bootstrapAdmin, null, '解析不了');
    await assert.rejects(
      () => buildApp({ cfg }),
      /COURSE_KB_BOOTSTRAP_ADMIN 已设置但格式不合法/,
      '★ 设了却不合法必须**拒绝启动**（原实现会静默打印"尚无任何用户"，运维以为变量没生效）',
    );
  } finally {
    // ⚠️ `buildApp` 抛错时可能留下打开的 SQLite 句柄 → Windows 删目录会 EPERM。
    //    清理失败**不该让测试变红**（真正的断言已经过了）。
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* Windows 偶发占用 */
    }
  }
});

test('★ 未设变量 → 不建用户（如实 not_initialized），且不抛错', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-none-'));
  let built: Awaited<ReturnType<typeof buildApp>> | null = null;
  try {
    const cfg = loadConfig({ root: ROOT, env: freshEnv(tmp) });
    assert.equal(cfg.auth.bootstrapAdmin, null);
    built = await buildApp({ cfg });
    assert.equal(built.deps.repo.rbac.countUsers(), 0, '未设变量 → 库里没有用户（等 CLI 或变量）');
  } finally {
    try {
      if (built) await built.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('★ 库里已有用户 → bootstrap **不再生效**（不会每次重启重置口令）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-existing-'));
  let built: Awaited<ReturnType<typeof buildApp>> | null = null;
  try {
    // 第一次：bootstrap 建 admin
    const cfg1 = loadConfig({ root: ROOT, env: freshEnv(tmp, { COURSE_KB_BOOTSTRAP_ADMIN: 'admin:Admin2026lab' }) });
    built = await buildApp({ cfg: cfg1 });
    const id1 = built.deps.repo.rbac.getUserRowByName('admin')?.id;
    await built.close();
    // 第二次：同样变量，但库里已有用户 → 不应再建/改
    const cfg2 = loadConfig({ root: ROOT, env: freshEnv(tmp, { COURSE_KB_BOOTSTRAP_ADMIN: 'admin:DifferentPass9' }) });
    built = await buildApp({ cfg: cfg2 });
    assert.equal(built.deps.repo.rbac.countUsers(), 1, '仍然只有 1 个用户');
    assert.equal(built.deps.repo.rbac.getUserRowByName('admin')?.id, id1, '★ 同一个人（没有被重建/重置）');
  } finally {
    try {
      if (built) await built.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
