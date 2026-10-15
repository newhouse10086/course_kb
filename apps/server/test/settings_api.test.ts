/**
 * `/api/v1/settings` · `/api/v1/models` · `/api/v1/settings/llm/switch` 的**路由级**测试
 * （`docs/SETTINGS_AND_SANDBOX.md` §1 + §2；契约 `docs/API_PROTOCOL.md` §8）。
 *
 * 全部**真 HTTP**（真 listen + 真 fetch），模型探测用**注入的假 fetch**（不打真网络）。
 *
 * 重点覆盖"最容易糊弄过去"的地方：
 * - 401 / 403 的区分（学生能读配置？不能）
 * - `PUT` 非法 → 400 **且文件一个字节都没变**（先在磁盘上比对，再断言 400）
 * - `concurrency: 8` → 响应 `ignored[]` 回显 + 落盘就是 1
 * - `now` 忙 → **409 E_MODEL_BUSY**（不许假装切成功）
 * - `drain` 等当前单元跑完再切；**超时 → state:'timeout' 且准入保持暂停**
 * - `abort` → cancel → 等终态 → 切 → 续推（**同一 checkpoint_file + resume:true**）
 * - 探测失败 → **502 E_MODEL_PROBE + 回滚**（内存与磁盘都回到旧模型）
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import { loadConfig } from '../src/config.ts';
import type { ServerConfig } from '../src/config.ts';
import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { ModelCatalog } from '../src/settings/models.ts';
import { ModelSwitcher } from '../src/settings/switcher.ts';
import type { QueueLike } from '../src/settings/switcher.ts';
import { SettingsStore } from '../src/settings/store.ts';
import { createSettingsRoutes, settingsCapabilities } from '../src/routes/settings.ts';
import type { AuthUser } from '../src/auth/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const MODEL_A = 'model-alpha';
const MODEL_B = 'model-beta';

let tmp = '';
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-settings-api-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;

// ═══════════════════════════════════════════════════════════════════════
// 脚手架
// ═══════════════════════════════════════════════════════════════════════

const USERS: Record<string, AuthUser> = {
  admin: {
    id: 'u-admin', username: 'admin', displayName: '管理员', roles: ['admin'],
    teacherCourseIds: [], studentCourseIds: [], status: 'active',
  },
  teacher: {
    id: 'u-teacher', username: 'teacher', displayName: '教师', roles: ['teacher'],
    teacherCourseIds: [], studentCourseIds: [], status: 'active',
  },
  student: {
    id: 'u-student', username: 'student', displayName: '学生', roles: ['student'],
    teacherCourseIds: [], studentCourseIds: [], status: 'active',
  },
  disabled: {
    id: 'u-disabled', username: 'disabled', displayName: '停用', roles: ['admin'],
    teacherCourseIds: [], studentCourseIds: [], status: 'disabled',
  },
};

/** 假 fetch：按 URL 返回脚本化响应（**不打真网络**）。 */
function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: string }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const r = handler(url, init);
    return new Response(r.body ?? '{}', {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/** 队列假实现（真落库；`isLlm` 与 backend-api 的 `runningSummary()` 同形）。 */
class FakeQueue implements QueueLike {
  readonly runningIds = new Set<string>();
  readonly enqueued: { id: string; input: Record<string, unknown> }[] = [];
  paused = false;
  /** ★ 模拟真实 `TaskQueue` 的**幂等**暂停时刻（重复 pause **不刷新**） */
  private pausedAtMs: number | null = null;
  pauseCalls = 0;
  resumeCalls = 0;
  /**
   * ⚠️ **不能写成 `constructor(private readonly repo: Repo) {}`** ——
   * Node 的 strip-only TS 模式不支持参数属性（坑 T1，实测
   * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported`）。
   * 必须显式声明字段再赋值。
   */
  private readonly repo: Repo;

  constructor(repo: Repo) {
    this.repo = repo;
  }

  /** 起一个"在跑"的任务（返回 taskId） */
  start(kind: string, params: Record<string, unknown> = {}, docId: string | null = null): string {
    const id = this.repo.insertTask({ kind, status: 'running', docId, detail: { params } });
    this.runningIds.add(id);
    return id;
  }

  /** 让任务结束（done） */
  finish(id: string, status: 'done' | 'failed' = 'done'): void {
    this.repo.updateTask(id, { status });
    this.runningIds.delete(id);
  }

  cancel(taskId: string): boolean {
    const t = this.repo.getTask(taskId);
    if (!t || t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') return false;
    this.repo.updateTask(taskId, { status: 'cancelled' });
    this.runningIds.delete(taskId);
    return true;
  }

  running(): string[] {
    return [...this.runningIds];
  }

  get pendingCount(): number {
    return this.enqueued.length;
  }

  enqueue(input: { docId?: string | null; kind: string; params?: Record<string, unknown>; userId?: string | null; priority?: number }): string {
    const id = this.repo.insertTask({
      kind: input.kind, status: 'queued', docId: input.docId ?? null,
      detail: { params: input.params ?? {} }, userId: input.userId ?? null, priority: input.priority ?? 0,
    });
    this.enqueued.push({ id, input: input as unknown as Record<string, unknown> });
    return id;
  }

  pauseAdmissions(): void {
    // 幂等：已在暂停中时**不刷新**时刻（backend-api 的真实实现也是这个语义 ——
    // 否则"暂停超时自动恢复"永远等不到超时）
    if (!this.paused) {
      this.paused = true;
      this.pausedAtMs = Date.now();
    }
    this.pauseCalls += 1;
  }

  resumeAdmissions(): void {
    this.paused = false;
    this.pausedAtMs = null;
    this.resumeCalls += 1;
  }

  admissionsPausedAt(): number | null {
    return this.pausedAtMs;
  }

  admissionsPausedForMs(now = Date.now()): number | null {
    return this.pausedAtMs === null ? null : Math.max(0, now - this.pausedAtMs);
  }

  get admissionsPaused(): boolean {
    return this.paused;
  }

  runningSummary(): { taskId: string; kind: string; userId: string | null; docId: string | null; isLlm: boolean }[] {
    const LLM = new Set(['extract', 'rollup', 'translate', 'mindmap']);
    return [...this.runningIds].map((id) => {
      const t = this.repo.getTask(id);
      return { taskId: id, kind: t?.kind ?? '', userId: null, docId: t?.doc_id ?? null, isLlm: LLM.has(t?.kind ?? '') };
    });
  }
}

interface Ctx {
  app: FastifyInstance;
  base: string;
  store: SettingsStore;
  repo: Repo;
  queue: FakeQueue;
  catalog: ModelCatalog;
  switcher: ModelSwitcher;
  file: string;
  cfg: ServerConfig;
  calls: string[];
}

async function makeCtx(opts: {
  /**
   * 脚本化的 **healthCheck 结果**（按模型名）。
   *
   * ⚠️ 探测已改为**复用 provider 层的 `healthCheck()`**（单一实现），
   * 所以这里注入的是"provider 探测结果"，而不是 HTTP 响应 —— 早期版本按 URL/HTTP 脚本化，
   * 在换成 provider 路径后会**静默去连真网络**。
   */
  probes?: Record<string, { ok: boolean; reason?: string; latencyMs?: number }>;
  /** `/models` 发现端点的 HTTP 响应（这条仍走我自己的 fetch） */
  discovery?: { status: number; body?: string };
  settings?: Record<string, unknown>;
  /** 起几个"在跑"的 LLM 任务 */
  running?: { kind: string; params?: Record<string, unknown> }[];
} = {}): Promise<Ctx> {
  n += 1;
  const dir = path.join(tmp, `a${n}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify(opts.settings ?? { version: 1, llm: { active: MODEL_A, fallbacks: ['fallback-1'] } }, null, 2)}\n`,
    'utf8',
  );

  const cfg = loadConfig({
    root: ROOT,
    env: {
      AMR_BASE: 'https://fake.local/v1',
      AMR_KEY: 'sk-fake-key-not-real-000000',
      LLM_MODEL: 'cfg-model',
      COURSE_KB_DATA_DIR: path.join(dir, 'data'),
      COURSE_KB_DB: path.join(dir, 'db.sqlite3'),
    } as Record<string, string>,
  });
  // ⚠️ `Db` 的构造函数是 **private**（要跑迁移）→ 必须用 `Db.open()`。
  //    写成 `new Db(path)` 会得到一个"空壳"，第一次查询报
  //    `Cannot read properties of undefined (reading 'prepare')`（实测就是这么踩的）。
  const db = Db.open(':memory:');
  const repo = new Repo(db);
  const queue = new FakeQueue(repo);
  for (const r of opts.running ?? []) queue.start(r.kind, r.params ?? {});

  const calls: string[] = [];
  const catalog = new ModelCatalog({
    cfg,
    ttlMs: 60_000,
    timeoutMs: 500,
    fetchImpl: fakeFetch((url, init) => {
      calls.push(url);
      if (url.endsWith('/models')) {
        if (opts.discovery) return opts.discovery;
        return { status: 200, body: JSON.stringify({ data: [{ id: 'discovered-1' }, { id: 'discovered-2' }] }) };
      }
      void init;
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'pong' } }] }) };
    }),
    // ★ 注入脚本化 provider（探测走 provider 层的 healthCheck 契约）
    makeProvider: (_entry, model) => {
      const scripted = opts.probes?.[model];
      const probeLabel = `POST https://fake.local/v1/chat/completions (model=${model}, max_tokens=512)`;
      return {
        info: {
          id: 'amr', kind: 'llm', label: `fake(${model})`, vendor: 'fake', runtime: 'cloud',
          configured: true, available: false, capabilities: {},
        },
        async healthCheck() {
          if (scripted) {
            return {
              ok: scripted.ok,
              ...(scripted.reason ? { reason: scripted.reason } : {}),
              latencyMs: scripted.latencyMs ?? 1,
              probe: probeLabel,
            };
          }
          return { ok: true, latencyMs: 1, probe: probeLabel };
        },
      };
    },
  });

  const store = new SettingsStore({ root: dir, file, pollMs: 50, fsWatch: false });
  const switcher = new ModelSwitcher({
    cfg, store, repo, catalog, queue,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), // 测试里别真等 25ms
  });

  const app = Fastify({ logger: false });
  // 假的身份注入：`x-test-user: admin|teacher|student|disabled`（无头 → 未登录）
  app.addHook('onRequest', async (req) => {
    const who = req.headers['x-test-user'];
    if (typeof who === 'string' && USERS[who]) {
      (req as unknown as { user: AuthUser }).user = USERS[who];
    }
  });
  await createSettingsRoutes({ cfg, store, catalog, repo, queue, switcher })(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('无法取到端口');
  return { app, base: `http://127.0.0.1:${addr.port}`, store, repo, queue, catalog, switcher, file, cfg, calls };
}

async function req(
  ctx: Ctx,
  method: string,
  url: string,
  opts: { as?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (opts.as) headers['x-test-user'] = opts.as;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${ctx.base}${url}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { _raw: text };
  }
  return { status: res.status, body };
}

const codeOf = (b: Record<string, unknown>): string => ((b.error as Record<string, string>) ?? {}).code ?? '';
const msgOf = (b: Record<string, unknown>): string => ((b.error as Record<string, string>) ?? {}).msg ?? '';

/** 跑完即关（每个用例自己收尾，避免 watcher 泄漏） */
async function withCtx<T>(opts: Parameters<typeof makeCtx>[0], fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const ctx = await makeCtx(opts);
  try {
    return await fn(ctx);
  } finally {
    ctx.store.close();
    await ctx.app.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 1. 鉴权（401 / 403 / 200）
// ═══════════════════════════════════════════════════════════════════════

test('GET /settings：未登录 → 401 E_UNAUTHENTICATED；被禁用 → 403', async () => {
  await withCtx({}, async (ctx) => {
    const anon = await req(ctx, 'GET', '/api/v1/settings');
    assert.equal(anon.status, 401);
    assert.equal(codeOf(anon.body), 'E_UNAUTHENTICATED');
    assert.match(msgOf(anon.body), /未登录/);

    const dis = await req(ctx, 'GET', '/api/v1/settings', { as: 'disabled' });
    assert.equal(dis.status, 403);
    assert.equal(codeOf(dis.body), 'E_ACCOUNT_DISABLED');
  });
});

test('GET /settings：学生 403（看不到模型/配额配置）；教师 200', async () => {
  await withCtx({}, async (ctx) => {
    const stu = await req(ctx, 'GET', '/api/v1/settings', { as: 'student' });
    assert.equal(stu.status, 403);
    assert.equal(codeOf(stu.body), 'E_FORBIDDEN');
    assert.match(msgOf(stu.body), /需要教师权限/);

    const tea = await req(ctx, 'GET', '/api/v1/settings', { as: 'teacher' });
    assert.equal(tea.status, 200);
    assert.equal((tea.body.settings as Record<string, unknown>).version, 1);
  });
});

test('PUT /settings 与 switch：教师 403（**仅 admin**）；admin 放行', async () => {
  await withCtx({}, async (ctx) => {
    const t = await req(ctx, 'PUT', '/api/v1/settings', { as: 'teacher', body: { llm: { temperature: 0.2 } } });
    assert.equal(t.status, 403);
    assert.match(msgOf(t.body), /需要管理员权限/);

    const s = await req(ctx, 'POST', '/api/v1/settings/llm/switch', { as: 'teacher', body: { model: MODEL_B, mode: 'drain' } });
    assert.equal(s.status, 403);

    const a = await req(ctx, 'PUT', '/api/v1/settings', { as: 'admin', body: { llm: { temperature: 0.2 } } });
    assert.equal(a.status, 200);
    assert.equal((a.body.ok as boolean), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. GET /settings：脱敏 + meta + ignored 回显
// ═══════════════════════════════════════════════════════════════════════

test('GET /settings：返回设置 + meta(source/path/revision/watching) + sandboxLimits', async () => {
  await withCtx({}, async (ctx) => {
    const r = await req(ctx, 'GET', '/api/v1/settings', { as: 'teacher' });
    assert.equal(r.status, 200);
    const s = r.body.settings as Record<string, unknown>;
    assert.equal((s.llm as Record<string, unknown>).active, MODEL_A);
    // ★ 不许把 maxTokens 这种"含敏感词但合法"的字段打码
    assert.equal((s.llm as Record<string, unknown>).maxTokens, 16_384);
    const meta = r.body.meta as Record<string, unknown>;
    assert.equal(meta.source, 'file');
    assert.equal(meta.revision, 0);
    assert.equal(meta.watching, false, '本 ctx 用 fsWatch:false + 未 startWatching');
    assert.equal(meta.lastReloadError, null);
    assert.equal((r.body.sandboxLimits as Record<string, unknown>).engine, 'sqlite');
  });
});

test('GET /settings：不存在的凭据键一律不出现（脱敏是**结构性**的）', async () => {
  await withCtx({}, async (ctx) => {
    const r = await req(ctx, 'GET', '/api/v1/settings', { as: 'admin' });
    const text = JSON.stringify(r.body);
    assert.ok(!/sk-/.test(text), '响应里不该出现 sk- 开头的密钥');
    assert.ok(!/apiKey|api_key|AMR_KEY/.test(text), '不该出现凭据字段名');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. PUT /settings
// ═══════════════════════════════════════════════════════════════════════

test('PUT /settings：局部更新深合并（只改传入的键，其余保持）', async () => {
  await withCtx({}, async (ctx) => {
    const before = fs.readFileSync(ctx.file, 'utf8');
    const r = await req(ctx, 'PUT', '/api/v1/settings', { as: 'admin', body: { llm: { temperature: 0.7 } } });
    assert.equal(r.status, 200);
    const s = r.body.settings as { llm: { active: string; temperature: number } };
    assert.equal(s.llm.temperature, 0.7);
    assert.equal(s.llm.active, MODEL_A, 'active 不该被动');
    // 真落盘
    const onDisk = JSON.parse(fs.readFileSync(ctx.file, 'utf8')) as { llm: { temperature: number; active: string } };
    assert.equal(onDisk.llm.temperature, 0.7);
    assert.equal(onDisk.llm.active, MODEL_A);
    assert.notEqual(fs.readFileSync(ctx.file, 'utf8'), before, '文件应真的变了');
    // 审计
    const audit = ctx.repo.rbac.listAudit({ action: 'settings_update' });
    assert.equal(audit.total, 1);
    assert.equal(audit.entries[0]?.user_id, 'u-admin');
  });
});

test('★ PUT 非法 → 400 且**磁盘文件一个字节都没变**（不静默用默认值）', async () => {
  await withCtx({}, async (ctx) => {
    const before = fs.readFileSync(ctx.file, 'utf8');
    const r = await req(ctx, 'PUT', '/api/v1/settings', { as: 'admin', body: { sandbox: { limits: { maxRows: 99999 } } } });
    assert.equal(r.status, 400);
    assert.equal(codeOf(r.body), 'E_BADREQUEST');
    assert.match(msgOf(r.body), /1 处/);
    assert.match((r.body.error as Record<string, string>).detail ?? '', /\$\.sandbox\.limits\.maxRows: 不能大于 10000/);
    assert.equal(fs.readFileSync(ctx.file, 'utf8'), before, '非法 PUT 不许碰文件');
    assert.equal(ctx.store.get().sandbox.limits.maxRows, 200, '内存也不许变');
    // 拒绝也要留痕（教学场景）
    assert.equal(ctx.repo.rbac.listAudit({ action: 'settings_update_rejected' }).total, 1);
  });
});

test('★ PUT 凭据（apiKey / sk- 值）→ 400，绝不写进 settings.json', async () => {
  await withCtx({}, async (ctx) => {
    const before = fs.readFileSync(ctx.file, 'utf8');
    const byKey = await req(ctx, 'PUT', '/api/v1/settings', { as: 'admin', body: { llm: { apiKey: 'whatever-1234' } } });
    assert.equal(byKey.status, 400);
    assert.match((byKey.body.error as Record<string, string>).detail ?? '', /禁止放凭据|未知字段/);

    const byValue = await req(ctx, 'PUT', '/api/v1/settings', { as: 'admin', body: { llm: { active: 'sk-abcdef1234567890' } } });
    assert.equal(byValue.status, 400);
    assert.match((byValue.body.error as Record<string, string>).detail ?? '', /看起来是密钥/);

    assert.equal(fs.readFileSync(ctx.file, 'utf8'), before, '被拒的 PUT 不许落盘');
  });
});

test('★ PUT concurrency:8 → 200 + ignored 回显 + 落盘就是 1（用户硬要求）', async () => {
  await withCtx({}, async (ctx) => {
    const r = await req(ctx, 'PUT', '/api/v1/settings', { as: 'admin', body: { llm: { concurrency: 8 } } });
    assert.equal(r.status, 200);
    const ignored = r.body.ignored as { path: string; requested: unknown; applied: number; reason: string }[];
    assert.equal(ignored.length, 1);
    assert.deepEqual(ignored[0], {
      path: 'llm.concurrency',
      requested: 8,
      applied: 1,
      reason: '用户硬要求：LLM 并发恒为 1（配置无法调高）',
    });
    assert.equal((r.body.settings as { llm: { concurrency: number } }).llm.concurrency, 1);
    const onDisk = JSON.parse(fs.readFileSync(ctx.file, 'utf8')) as { llm: { concurrency: number } };
    assert.equal(onDisk.llm.concurrency, 1, '落盘也必须是 1');
    assert.equal(ctx.store.get().llm.concurrency, 1);
  });
});

test('PUT：`{settings:{...}}` 包一层也接受（前端两种写法都行）', async () => {
  await withCtx({}, async (ctx) => {
    const r = await req(ctx, 'PUT', '/api/v1/settings', { as: 'admin', body: { settings: { quota: { student: { dailyLlmCalls: 5 } } } } });
    assert.equal(r.status, 200);
    assert.equal(ctx.store.get().quota.student.dailyLlmCalls, 5);
    assert.equal(ctx.store.get().quota.teacher.dailyLlmCalls, 2000, '教师配额不受影响');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. GET /models（真探测，假端点）
// ═══════════════════════════════════════════════════════════════════════

test('GET /models：每个模型都有 available/latencyMs/reason，且来自**真探测**', async () => {
  await withCtx({}, async (ctx) => {
    // ★ `?deep=1`：**显式**全探（默认只探 active —— 探测是真计费请求，见 settings_models_cost.test.ts）
    const r = await req(ctx, 'GET', '/api/v1/models?deep=1', { as: 'teacher' });
    assert.equal(r.status, 200);
    const models = r.body.models as {
      id: string; available: boolean; latencyMs: number; active: boolean; sources: string[]; probe: string;
    }[];
    const ids = models.map((m) => m.id).sort();
    // 候选 = settings.active + fallbacks + provider 配的 model + 端点发现
    assert.deepEqual(ids, [MODEL_A, 'cfg-model', 'discovered-1', 'discovered-2', 'fallback-1'].sort());
    for (const m of models) {
      assert.equal(m.available, true, `${m.id} 应可用`);
      assert.equal(typeof m.latencyMs, 'number');
    }
    assert.equal(models[0]?.id, MODEL_A, '当前生效模型排最前');
    assert.equal(models[0]?.active, true);
    assert.equal(r.body.activeModel, MODEL_A);
    assert.equal(r.body.activeAvailable, true);
    // 判定来自 provider 层的 healthCheck（不是我自己发的裸请求）
    assert.match(String(models[0]?.probe), /max_tokens=512/, '必须用 provider 层的 512 预算');
    assert.equal((r.body.discovery as Record<string, unknown>).ok, true);
  });
});

test('★ GET /models：模型探测不通 → available:false + **可读 reason**（不假绿）', async () => {
  await withCtx(
    {
      settings: { version: 1, llm: { active: MODEL_A, fallbacks: [MODEL_B] } },
      probes: {
        [MODEL_B]: {
          ok: false,
          reason:
            '额度不足/欠费（本项目实测遇到过 Coding Plan 配额耗尽，响应头会带 reset_at）（HTTP 402：insufficient_balance）',
          latencyMs: 8,
        },
      },
    },
    async (ctx) => {
      const r = await req(ctx, 'GET', '/api/v1/models?deep=1', { as: 'admin' });
      const models = r.body.models as { id: string; available: boolean; reason: string }[];
      const bad = models.find((m) => m.id === MODEL_B);
      assert.ok(bad, '应有 model-beta');
      assert.equal(bad?.available, false);
      assert.match(bad?.reason ?? '', /额度不足|欠费/);
      assert.match(bad?.reason ?? '', /insufficient_balance/, '要带上游原文（已脱敏）');
      assert.equal(r.body.activeAvailable, true, '当前模型仍可用');
      // ★ 失败原因里绝不能有密钥
      assert.ok(!/sk-fake-key/.test(String(bad?.reason)), 'reason 不得泄漏 api key');
    },
  );
});

test('★ GET /models：**HTTP 200 但 content 为空**（推理 token 吃光预算）→ available:false【旧实现会红】', async () => {
  // 这条走**真 provider 路径**（补丁 globalThis.fetch），因此验证的是 provider 层的
  // 空 content 判定 —— 旧实现（只看 HTTP 200）在这里会报 available:true（假绿）。
  await withCtx(
    { settings: { version: 1, llm: { active: MODEL_A } } },
    async (ctx) => {
      const orig = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '', reasoning_content: '推理'+'很长'.repeat(40) }, finish_reason: 'length' }],
            usage: { completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 31 } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch;
      try {
        const { ModelCatalog } = await import('../src/settings/models.ts');
        const realCatalog = new ModelCatalog({ cfg: ctx.cfg, timeoutMs: 500 });
        const p = await realCatalog.probe(MODEL_A, { force: true });
        assert.equal(p.available, false, 'HTTP 200 且 content 为空 → 必须判为**不可用**');
        assert.match(p.reason, /E_LLM_EMPTY_CONTENT/);
        assert.match(p.reason, /finish_reason=length/);
        assert.match(p.reason, /reasoning_content=\d+ 字符/);
        assert.equal(p.judgedBy, 'provider.healthCheck');
      } finally {
        globalThis.fetch = orig;
      }
    },
  );
});

test('GET /models：healthCheck 抛异常 → available:false（不让 /models 整体 500）', async () => {
  await withCtx(
    {
      settings: { version: 1, llm: { active: MODEL_A } },
      probes: {},
    },
    async (ctx) => {
      const { ModelCatalog } = await import('../src/settings/models.ts');
      const cat = new ModelCatalog({
        cfg: ctx.cfg,
        timeoutMs: 500,
        makeProvider: () => ({
          info: { id: 'x', kind: 'llm', label: 'x', vendor: 'x', runtime: 'cloud', configured: true, available: false, capabilities: {} },
          healthCheck() {
            throw new Error('boom: connection reset');
          },
        }),
      });
      const list = await cat.list({ active: MODEL_A, fallbacks: [] });
      assert.equal(list.models[0]?.available, false);
      assert.match(list.models[0]?.reason ?? '', /探测抛异常：boom/);
    },
  );
});

test('GET /models：/models 发现失败 → discovery.ok=false 且**不影响**其它字段', async () => {
  await withCtx(
    { discovery: { status: 404, body: '{"error":"not found"}' } },
    async (ctx) => {
      const r = await req(ctx, 'GET', '/api/v1/models?deep=1', { as: 'admin' });
      assert.equal(r.status, 200);
      const disc = r.body.discovery as Record<string, unknown>;
      assert.equal(disc.ok, false);
      assert.match(String(disc.reason), /HTTP 404/);
      assert.equal(disc.count, 0);
      // 其它候选照常探测
      const models = r.body.models as { id: string; available: boolean }[];
      assert.ok(models.length >= 2);
      assert.equal(models.every((m) => m.available), true);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════
// 5. POST /settings/llm/switch
// ═══════════════════════════════════════════════════════════════════════

test('switch：缺 model / 非法 mode → 400 E_BADREQUEST', async () => {
  await withCtx({}, async (ctx) => {
    const noModel = await req(ctx, 'POST', '/api/v1/settings/llm/switch', { as: 'admin', body: { mode: 'now' } });
    assert.equal(noModel.status, 400);
    assert.match(msgOf(noModel.body), /缺少 model/);

    const badMode = await req(ctx, 'POST', '/api/v1/settings/llm/switch', { as: 'admin', body: { model: MODEL_B, mode: 'later' } });
    assert.equal(badMode.status, 400);
    assert.match(msgOf(badMode.body), /mode 必须是 now \| drain \| abort 之一/);
  });
});

test('★ switch mode:now（空闲）→ 立即生效 + 落盘 + 审计 model_switch', async () => {
  await withCtx({}, async (ctx) => {
    const r = await req(ctx, 'POST', '/api/v1/settings/llm/switch', { as: 'admin', body: { model: MODEL_B, mode: 'now' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'switched');
    assert.equal(r.body.activeModel, MODEL_B);
    assert.equal(r.body.switchedFrom, MODEL_A);
    assert.equal((r.body.probe as Record<string, unknown>).available, true);
    assert.equal(r.body.rolledBack, false);
    assert.equal(ctx.store.get().llm.active, MODEL_B);
    const onDisk = JSON.parse(fs.readFileSync(ctx.file, 'utf8')) as { llm: { active: string } };
    assert.equal(onDisk.llm.active, MODEL_B, '热切换要持久化');
    // 审计
    const audit = ctx.repo.rbac.listAudit({ action: 'model_switch' });
    assert.equal(audit.total, 1);
    assert.equal(audit.entries[0]?.target, MODEL_B);
    const detail = JSON.parse(String(audit.entries[0]?.detail_json ?? '{}')) as Record<string, unknown>;
    assert.equal(detail.from, MODEL_A);
    assert.equal(detail.to, MODEL_B);
    assert.equal(detail.mode, 'now');
    assert.equal(detail.by, 'admin');
    assert.equal(detail.result, 'ok');
  });
});

test('★ switch mode:now（有 LLM 任务在跑）→ **409 E_MODEL_BUSY**，模型不变（不许假装成功）', async () => {
  await withCtx({ running: [{ kind: 'extract' }] }, async (ctx) => {
    const r = await req(ctx, 'POST', '/api/v1/settings/llm/switch', { as: 'admin', body: { model: MODEL_B, mode: 'now' } });
    assert.equal(r.status, 409);
    assert.equal(codeOf(r.body), 'E_MODEL_BUSY');
    assert.match(msgOf(r.body), /1 个 LLM 任务在运行中/);
    assert.match((r.body.error as Record<string, string>).hint ?? '', /drain|abort/);
    assert.equal(ctx.store.get().llm.active, MODEL_A, '拒绝后模型必须没变');
    const onDisk = JSON.parse(fs.readFileSync(ctx.file, 'utf8')) as { llm: { active: string } };
    assert.equal(onDisk.llm.active, MODEL_A);
    // 失败也留痕
    const audit = ctx.repo.rbac.listAudit({ action: 'model_switch' });
    assert.equal(audit.total, 1);
    assert.match(String(audit.entries[0]?.detail_json), /E_MODEL_BUSY/);
  });
});

test('★ switch mode:now：非 LLM 任务（asr）在跑**不算忙** → 允许切换', async () => {
  await withCtx({ running: [{ kind: 'asr' }, { kind: 'parse' }] }, async (ctx) => {
    const r = await req(ctx, 'POST', '/api/v1/settings/llm/switch', { as: 'admin', body: { model: MODEL_B, mode: 'now' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.activeModel, MODEL_B);
  });
});

test('★ switch mode:drain → 停准入 → 等当前单元跑完 → 切 → **恢复准入**', async () => {
  await withCtx({ running: [{ kind: 'extract' }] }, async (ctx) => {
    // 60ms 后任务完成（模拟"当前单元跑完"）
    const id = [...ctx.queue.runningIds][0] as string;
    setTimeout(() => ctx.queue.finish(id), 60);

    const r = await req(ctx, 'POST', '/api/v1/settings/llm/switch', { as: 'admin', body: { model: MODEL_B, mode: 'drain' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'switched');
    assert.equal(r.body.activeModel, MODEL_B);
    assert.equal(r.body.drained, 1, '应报告等掉了 1 个任务');
    assert.equal(ctx.queue.pauseCalls, 1, '必须停过准入');
    assert.equal(ctx.queue.resumeCalls, 1, '切完必须恢复准入');
    assert.equal(ctx.queue.admissionsPaused, false, '最终不能停在暂停状态');
    assert.equal((r.body.notes as string[]).some((s) => /等当前 LLM 单元跑完/.test(s)), true);
  });
});

test('★ switch mode:drain **超时** → state:timeout、**没切**、准入保持暂停（不静默继续）', async () => {
  await withCtx({ running: [{ kind: 'extract' }] }, async (ctx) => {
    // 用 80ms 的小超时（默认 60s 会把测试拖死 —— 第一版就是漏了个默认超时的调用，跑了 60 秒）
    const res = await ctx.switcher.switch({ model: MODEL_B, mode: 'drain', drainTimeoutMs: 80, userId: 'u-admin' });
    assert.equal(res.state, 'timeout');
    assert.equal(res.activeModel, MODEL_A, '超时绝不能切');
    assert.equal(res.stillRunning.length, 1);
    assert.equal(res.notes.some((s) => /没等到空闲/.test(s)), true);
    // ★ 关键：保持暂停等人处理（而不是恢复准入假装无事发生）
    assert.equal(ctx.queue.admissionsPaused, true, 'drain 超时应保持暂停');
    assert.equal(ctx.store.get().llm.active, MODEL_A);
    const onDisk = JSON.parse(fs.readFileSync(ctx.file, 'utf8')) as { llm: { active: string } };
    assert.equal(onDisk.llm.active, MODEL_A, '磁盘也不能变');
    // ★ 响应里要给出"怎么恢复"与"还有多久自动恢复"，否则 UI/人不知道怎么办
    const adm = res.admissions as { paused: boolean; autoResumeInMs: number | null; stillRunning: unknown[] };
    assert.equal(adm.paused, true);
    assert.equal(typeof adm.autoResumeInMs, 'number', '必须告诉人还有多久自动恢复');
    assert.ok((adm.autoResumeInMs ?? 0) <= 600_000);
    assert.equal(adm.stillRunning.length, 1);
  });
});

test('★ POST /settings/llm/switch/resume：手动恢复准入（否则队列**永久停摆**）', async () => {
  await withCtx({ running: [{ kind: 'extract' }] }, async (ctx) => {
    // 教师无权恢复
    const denied = await req(ctx, 'POST', '/api/v1/settings/llm/switch/resume', { as: 'teacher' });
    assert.equal(denied.status, 403);

    // 先制造"暂停"
    await ctx.switcher.switch({ model: MODEL_B, mode: 'drain', drainTimeoutMs: 60, userId: 'u-admin' });
    assert.equal(ctx.queue.admissionsPaused, true);

    const r = await req(ctx, 'POST', '/api/v1/settings/llm/switch/resume', { as: 'admin' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.resumed, true);
    assert.match(String(r.body.note), /准入已恢复/);
    assert.equal(ctx.queue.admissionsPaused, false, '★ 队列必须真的恢复领取任务');
    assert.equal((r.body.state as { paused: boolean }).paused, false);
    assert.equal((r.body.state as { pausedForMs: number }).pausedForMs, 0);

    // 审计：手动恢复要留痕
    const audit = ctx.repo.rbac.listAudit({ action: 'admissions_resume' });
    assert.equal(audit.total, 1);
    const detail = JSON.parse(String(audit.entries[0]?.detail_json ?? '{}')) as Record<string, unknown>;
    assert.equal(detail.by, 'manual');
    assert.equal(detail.operator, 'admin');

    // 幂等：本来就开着 → 200 且如实说"无需恢复"
    const again = await req(ctx, 'POST', '/api/v1/settings/llm/switch/resume', { as: 'admin' });
    assert.equal(again.status, 200);
    assert.equal(again.body.resumed, false);
    assert.match(String(again.body.note), /本来就是开的/);
  });
});

test('★★ 自动兜底恢复：暂停超过时限后**无人干预也会自动恢复**（防"人忘了→永久停摆"）', async () => {
  const ctx = await makeCtx({ running: [{ kind: 'extract' }] });
  try {
    // 用 80ms 的自动恢复时限（默认 10 分钟）
    const { ModelCatalog } = await import('../src/settings/models.ts');
    const { ModelSwitcher } = await import('../src/settings/switcher.ts');
    const cat = new ModelCatalog({
      cfg: ctx.cfg,
      makeProvider: () => ({
        info: { id: 'amr', kind: 'llm', label: 'x', vendor: 'x', runtime: 'cloud', configured: true, available: false, capabilities: {} },
        async healthCheck() {
          return { ok: true, latencyMs: 1, probe: 'fake' };
        },
      }),
    });
    const sw = new ModelSwitcher({
      cfg: ctx.cfg, store: ctx.store, repo: ctx.repo, catalog: cat, queue: ctx.queue,
      autoResumeMs: 80,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    });
    try {
      const res = await sw.switch({ model: MODEL_B, mode: 'drain', drainTimeoutMs: 60, userId: 'u-admin' });
      assert.equal(res.state, 'timeout');
      assert.equal(ctx.queue.admissionsPaused, true, '超时先暂停');
      const adm = res.admissions as { autoResumeInMs: number | null };
      assert.ok((adm.autoResumeInMs ?? 0) <= 80, `应报出 80ms 内自动恢复，实际 ${adm.autoResumeInMs}`);

      // 等人为干预？不等 —— 什么都不做，让它自己恢复
      const deadline = Date.now() + 2000;
      while (ctx.queue.admissionsPaused && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(ctx.queue.admissionsPaused, false, '★ 超时后必须**自动恢复**（否则队列永久停摆）');
      // 自动恢复要留痕，且区分 manual/auto
      const audit = ctx.repo.rbac.listAudit({ action: 'admissions_auto_resume' });
      assert.equal(audit.total, 1);
      const detail = JSON.parse(String(audit.entries[0]?.detail_json ?? '{}')) as Record<string, unknown>;
      assert.equal(detail.by, 'auto');
      assert.match(String(detail.why), /暂停超过自动恢复时限/);
      assert.equal(sw.admissionState().paused, false);
    } finally {
      sw.close();
    }
  } finally {
    ctx.store.close();
    await ctx.app.close();
  }
});

test('★★ 自动兜底也要覆盖**别人发起的暂停**（用队列的 `admissionsPausedAt()`，不只我们自己那次）', async () => {
  const ctx = await makeCtx({ running: [{ kind: 'extract' }] });
  try {
    const { ModelCatalog } = await import('../src/settings/models.ts');
    const { ModelSwitcher } = await import('../src/settings/switcher.ts');
    const cat = new ModelCatalog({
      cfg: ctx.cfg,
      makeProvider: () => ({
        info: { id: 'amr', kind: 'llm', label: 'x', vendor: 'x', runtime: 'cloud', configured: true, available: false, capabilities: {} },
        async healthCheck() {
          return { ok: true, latencyMs: 1, probe: 'fake' };
        },
      }),
    });
    const sw = new ModelSwitcher({
      cfg: ctx.cfg, store: ctx.store, repo: ctx.repo, catalog: cat, queue: ctx.queue,
      autoResumeMs: 80,
    });
    try {
      // ★ 关键：**绕过我的切换器**，直接停准入（模拟"别人/别的代码路径"暂停）
      ctx.queue.pauseAdmissions();
      assert.equal(ctx.queue.admissionsPaused, true);
      // 状态应如实报出"不是我们发起的"，且暂停时刻来自队列
      const st = sw.admissionState();
      assert.equal(st.paused, true);
      assert.match(st.reason, /非本切换器发起/);
      assert.equal(typeof st.pausedSince, 'number');
      assert.equal(st.stillRunning.length, 0, '不是我们发起的，就没有任务快照（如实为空）');
      assert.ok((st.autoResumeInMs ?? -1) <= 80);

      // 什么都不做 → 也必须被兜底恢复
      const deadline = Date.now() + 2500;
      while (ctx.queue.admissionsPaused && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(ctx.queue.admissionsPaused, false, '★ 非本切换器发起的暂停也必须被自动恢复');
      const audit = ctx.repo.rbac.listAudit({ action: 'admissions_auto_resume' });
      assert.equal(audit.total, 1);
      assert.match(String(audit.entries[0]?.detail_json), /"by":"auto"/);
    } finally {
      sw.close();
    }
  } finally {
    ctx.store.close();
    await ctx.app.close();
  }
});

test('自动兜底恢复：**手动恢复后定时器要被清掉**（不许之后再冒出一次 auto 事件）', async () => {
  const ctx = await makeCtx({ running: [{ kind: 'extract' }] });
  try {
    const { ModelCatalog } = await import('../src/settings/models.ts');
    const { ModelSwitcher } = await import('../src/settings/switcher.ts');
    const cat = new ModelCatalog({
      cfg: ctx.cfg,
      makeProvider: () => ({
        info: { id: 'amr', kind: 'llm', label: 'x', vendor: 'x', runtime: 'cloud', configured: true, available: false, capabilities: {} },
        async healthCheck() {
          return { ok: true, latencyMs: 1, probe: 'fake' };
        },
      }),
    });
    const sw = new ModelSwitcher({
      cfg: ctx.cfg, store: ctx.store, repo: ctx.repo, catalog: cat, queue: ctx.queue,
      autoResumeMs: 120,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    });
    try {
      await sw.switch({ model: MODEL_B, mode: 'drain', drainTimeoutMs: 60, userId: 'u-admin' });
      assert.equal(ctx.queue.admissionsPaused, true);
      sw.resumeAdmissions({ by: 'manual', userId: 'u-admin' }); // 立刻手动恢复
      assert.equal(ctx.queue.admissionsPaused, false);
      await new Promise((r) => setTimeout(r, 300)); // 等过定时器时限
      assert.equal(ctx.repo.rbac.listAudit({ action: 'admissions_auto_resume' }).total, 0, '手动恢复后不该再有 auto 事件');
      assert.equal(ctx.repo.rbac.listAudit({ action: 'admissions_resume' }).total, 1);
    } finally {
      sw.close();
    }
  } finally {
    ctx.store.close();
    await ctx.app.close();
  }
});

test('★ switch mode:abort → cancel → 等终态 → 切 → 续推（同一 checkpoint_file + resume:true）', async () => {
  await withCtx(
    { running: [{ kind: 'extract', params: { checkpoint_file: 'C:/ck/task-1.json', doc_id: 'doc-1' } }] },
    async (ctx) => {
      const oldId = [...ctx.queue.runningIds][0] as string;
      const r = await req(ctx, 'POST', '/api/v1/settings/llm/switch', { as: 'admin', body: { model: MODEL_B, mode: 'abort' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.state, 'switched');
      assert.deepEqual(r.body.aborted, [oldId]);
      assert.equal(ctx.repo.getTask(oldId)?.status, 'cancelled', '旧任务必须真的被终止');
      // 续推
      const resumed = r.body.resumed as { taskId: string; newTaskId: string; kind: string; checkpointFile: string; hadCheckpoint: boolean }[];
      assert.equal(resumed.length, 1);
      assert.equal(resumed[0]?.taskId, oldId);
      assert.equal(resumed[0]?.kind, 'extract');
      assert.equal(resumed[0]?.checkpointFile, 'C:/ck/task-1.json', '★ 必须是**同一个**断点文件');
      assert.equal(resumed[0]?.hadCheckpoint, true);
      // 新任务的 params 真的带上了 resume:true + 同一 checkpoint_file
      const enq = ctx.queue.enqueued[0];
      assert.ok(enq);
      const params = (enq?.input as { params: Record<string, unknown> }).params;
      assert.equal(params.resume, true, '★ 必须传 resume:true（否则从头重跑=重复计费）');
      assert.equal(params.checkpoint_file, 'C:/ck/task-1.json');
      assert.equal(ctx.store.get().llm.active, MODEL_B);
      assert.equal(ctx.queue.admissionsPaused, false, 'abort 也要把准入恢复');
    },
  );
});

test('★ switch：新模型探测失败 → **502 E_MODEL_PROBE + 回滚**（内存与磁盘都回旧值）', async () => {
  await withCtx(
    { probes: { [MODEL_B]: { ok: false, reason: '凭据无效或已过期，请检查 API key（HTTP 401）', latencyMs: 5 } } },
    async (ctx) => {
      const r = await req(ctx, 'POST', '/api/v1/settings/llm/switch', { as: 'admin', body: { model: MODEL_B, mode: 'now' } });
      assert.equal(r.status, 502);
      assert.equal(codeOf(r.body), 'E_MODEL_PROBE');
      assert.match(msgOf(r.body), /已\*\*回滚\*\*到 model-alpha/);
      assert.match((r.body.error as Record<string, string>).detail ?? '', /凭据无效或已过期/);
      // ★ 回滚：内存 + 磁盘
      assert.equal(ctx.store.get().llm.active, MODEL_A);
      const onDisk = JSON.parse(fs.readFileSync(ctx.file, 'utf8')) as { llm: { active: string } };
      assert.equal(onDisk.llm.active, MODEL_A, '磁盘也必须回滚');
      // 审计记失败
      const audit = ctx.repo.rbac.listAudit({ action: 'model_switch' });
      assert.equal(audit.total, 1);
      assert.match(String(audit.entries[0]?.detail_json), /"result":"failed"/);
    },
  );
});

test('★ switch 回滚：新模型"能连通但 content 为空"（真 provider 判定）→ 502 + 回滚', async () => {
  // 这是 `/models` 假绿 bug 的**后果级**回归测试：若 `available` 不可信，
  // 切到"通但产不出内容"的模型不会回滚 → 抽取静默 0 卡片。
  await withCtx({}, async (ctx) => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '', reasoning_content: 're'.repeat(30) }, finish_reason: 'length' }],
          usage: { completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 31 } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    try {
      const { ModelCatalog } = await import('../src/settings/models.ts');
      const { ModelSwitcher } = await import('../src/settings/switcher.ts');
      const realCatalog = new ModelCatalog({ cfg: ctx.cfg, timeoutMs: 500 });
      const sw = new ModelSwitcher({
        cfg: ctx.cfg, store: ctx.store, repo: ctx.repo, catalog: realCatalog, queue: ctx.queue,
      });
      await assert.rejects(
        () => sw.switch({ model: MODEL_B, mode: 'now', userId: 'u-admin' }),
        (e: unknown) => {
          const err = e as { code?: string; message?: string };
          assert.equal(err.code, 'E_MODEL_PROBE', `应回滚并报 E_MODEL_PROBE，实际：${err.code}`);
          assert.match(String(err.message), /E_LLM_EMPTY_CONTENT|content 为空/);
          return true;
        },
      );
      assert.equal(ctx.store.get().llm.active, MODEL_A, '★ 必须回滚到旧模型');
      const onDisk = JSON.parse(fs.readFileSync(ctx.file, 'utf8')) as { llm: { active: string } };
      assert.equal(onDisk.llm.active, MODEL_A, '★ 磁盘也必须回滚');
    } finally {
      globalThis.fetch = orig;
    }
  });
});

test('switch：切到当前模型 → 只探测不切（幂等，notes 说明）', async () => {
  await withCtx({}, async (ctx) => {
    const r = await req(ctx, 'POST', '/api/v1/settings/llm/switch', { as: 'admin', body: { model: MODEL_A, mode: 'now' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.switchedFrom, MODEL_A);
    assert.equal(r.body.activeModel, MODEL_A);
    assert.equal((r.body.notes as string[])[0], '目标模型与当前一致 → 未做切换（只做了探测确认）');
  });
});

test('switch：并发点两次 → 串行执行（不会互相回滚）', async () => {
  await withCtx({}, async (ctx) => {
    const [a, b] = await Promise.all([
      req(ctx, 'POST', '/api/v1/settings/llm/switch', { as: 'admin', body: { model: MODEL_B, mode: 'now' } }),
      req(ctx, 'POST', '/api/v1/settings/llm/switch', { as: 'admin', body: { model: 'discovered-1', mode: 'now' } }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const final = ctx.store.get().llm.active;
    assert.ok(final === MODEL_B || final === 'discovered-1', `最终应是其中一个，实际 ${final}`);
    const onDisk = JSON.parse(fs.readFileSync(ctx.file, 'utf8')) as { llm: { active: string } };
    assert.equal(onDisk.llm.active, final, '内存与磁盘必须一致');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. /capabilities 数据函数 + 热重载对 API 的可见性
// ═══════════════════════════════════════════════════════════════════════

test('★ switch 响应如实报"两个模型真相源"是否一致（不许让"切换成功"变成局部真相）', async () => {
  await withCtx({}, async (ctx) => {
    // ctx 的 providers.yaml 配的是 cfg-model；切到 model-beta → 两个源**不一致**
    const r1 = await req(ctx, 'POST', '/api/v1/settings/llm/switch', { as: 'admin', body: { model: MODEL_B, mode: 'now' } });
    assert.equal(r1.status, 200);
    const ms1 = r1.body.modelSources as { settingsActive: string; providerConfigured: string; consistent: boolean };
    assert.equal(ms1.settingsActive, MODEL_B);
    assert.equal(ms1.providerConfigured, 'cfg-model');
    assert.equal(ms1.consistent, false);
    assert.equal(
      (r1.body.notes as string[]).some((n) => /provider 层配置的 model 仍是 cfg-model/.test(n)),
      true,
      '必须明确提示"有消费方可能仍用旧模型"',
    );

    // 切到与 provider 配置一致的那个模型 → consistent:true，且不再有该提示
    const r2 = await req(ctx, 'POST', '/api/v1/settings/llm/switch', { as: 'admin', body: { model: 'cfg-model', mode: 'now' } });
    assert.equal(r2.status, 200);
    const ms2 = r2.body.modelSources as { consistent: boolean };
    assert.equal(ms2.consistent, true);
    assert.equal((r2.body.notes as string[]).some((n) => /provider 层配置的 model 仍是/.test(n)), false);
  });
});

test('settingsCapabilities()：报 activeModel / switchedFrom / switchedAt（注册由 backend-api 做）', async () => {
  await withCtx({}, async (ctx) => {
    const before = settingsCapabilities(ctx.store, ctx.switcher);
    assert.equal(before.activeModel, MODEL_A);
    assert.equal(before.switchedFrom, null);
    assert.equal(before.switchedAt, null);
    assert.equal(before.concurrency, 1);
    assert.equal(before.hotReload, false, '未 startWatching → 如实 false');

    await req(ctx, 'POST', '/api/v1/settings/llm/switch', { as: 'admin', body: { model: MODEL_B, mode: 'now' } });
    const after = settingsCapabilities(ctx.store, ctx.switcher);
    assert.equal(after.activeModel, MODEL_B);
    assert.equal(after.switchedFrom, MODEL_A);
    assert.ok(typeof after.switchedAt === 'number' && after.switchedAt > 0);
  });
});

test('★ 热重载对 API 可见：外部改文件 → GET /settings 直接看到新值（不重启）', async () => {
  await withCtx({}, async (ctx) => {
    assert.equal(ctx.store.startWatching(), true);
    fs.writeFileSync(ctx.file, `${JSON.stringify({ version: 1, llm: { active: 'hot-swapped-model' } })}\n`, 'utf8');
    const deadline = Date.now() + 2000;
    let seen = '';
    while (Date.now() < deadline) {
      const r = await req(ctx, 'GET', '/api/v1/settings', { as: 'teacher' });
      seen = ((r.body.settings as { llm: { active: string } }).llm.active);
      if (seen === 'hot-swapped-model') break;
      await new Promise((r2) => setTimeout(r2, 25));
    }
    assert.equal(seen, 'hot-swapped-model', '外部改文件后 API 应立即返回新值');
    // revision 变了、来源是 file
    const r2 = await req(ctx, 'GET', '/api/v1/settings', { as: 'teacher' });
    assert.equal((r2.body.meta as Record<string, unknown>).revision, 1);
    assert.equal((r2.body.meta as Record<string, unknown>).source, 'file');
  });
});

test('★ 热重载拿到**非法**配置 → API 里 lastReloadError 有原因，但仍在服务旧配置', async () => {
  await withCtx({}, async (ctx) => {
    ctx.store.startWatching();
    fs.writeFileSync(ctx.file, `${JSON.stringify({ version: 1, llm: { active: MODEL_A, maxTokens: -1 } })}\n`, 'utf8');
    const deadline = Date.now() + 2000;
    let err: string | null = null;
    while (Date.now() < deadline) {
      const r = await req(ctx, 'GET', '/api/v1/settings', { as: 'teacher' });
      err = (r.body.meta as { lastReloadError: string | null }).lastReloadError;
      if (err) break;
      await new Promise((r2) => setTimeout(r2, 25));
    }
    assert.ok(err, '应记录 lastReloadError');
    assert.match(err ?? '', /\$\.llm\.maxTokens/);
    const r = await req(ctx, 'GET', '/api/v1/settings', { as: 'teacher' });
    assert.equal((r.body.settings as { llm: { active: string } }).llm.active, MODEL_A, '旧配置继续生效');
  });
});

test('GET /models 与 GET /settings 的**教师可读、学生不可读**一致', async () => {
  await withCtx({}, async (ctx) => {
    assert.equal((await req(ctx, 'GET', '/api/v1/models', { as: 'student' })).status, 403);
    assert.equal((await req(ctx, 'GET', '/api/v1/models', { as: 'teacher' })).status, 200);
    assert.equal((await req(ctx, 'GET', '/api/v1/settings/llm', { as: 'student' })).status, 403);
    assert.equal((await req(ctx, 'GET', '/api/v1/settings/llm', { as: 'teacher' })).status, 200);
  });
});

test('GET /settings/llm：给 UI 轮询忙状态（busy.runningLlm 列出具体任务）', async () => {
  await withCtx({ running: [{ kind: 'extract' }] }, async (ctx) => {
    const r = await req(ctx, 'GET', '/api/v1/settings/llm', { as: 'teacher' });
    assert.equal(r.status, 200);
    const busy = r.body.busy as { busy: boolean; runningLlm: { kind: string }[]; source: string };
    assert.equal(busy.busy, true);
    assert.equal(busy.runningLlm[0]?.kind, 'extract');
    assert.equal(busy.source, 'queue.runningSummary', '应优先用队列的 runningSummary（backend-api 提供）');
  });
});
