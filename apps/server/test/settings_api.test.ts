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
    this.paused = true;
    this.pauseCalls += 1;
  }

  resumeAdmissions(): void {
    this.paused = false;
    this.resumeCalls += 1;
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
  /** URL 子串 → 响应；未命中给 200 ok */
  routes?: Record<string, { status: number; body?: string }>;
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
        const hit = opts.routes?.['__discovery'];
        if (hit) return hit;
        return { status: 200, body: JSON.stringify({ data: [{ id: 'discovered-1' }, { id: 'discovered-2' }] }) };
      }
      // ⚠️ 模型名在**请求体**里，不在 URL 里 —— 早期版本按 URL 匹配，
      //    结果"给 model-beta 配 402"永远不生效（测试会莫名其妙地全绿）。
      let model = '';
      try {
        model = String((JSON.parse(String(init?.body ?? '{}')) as { model?: string }).model ?? '');
      } catch {
        model = '';
      }
      const hit = opts.routes?.[model];
      if (hit) return hit;
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'pong' } }] }) };
    }),
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
    const r = await req(ctx, 'GET', '/api/v1/models', { as: 'teacher' });
    assert.equal(r.status, 200);
    const models = r.body.models as { id: string; available: boolean; latencyMs: number; active: boolean; sources: string[] }[];
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
    // 真发了 chat/completions 请求（不是照抄配置）
    assert.ok(ctx.calls.some((u) => u.endsWith('/chat/completions')), `应真探测，实际调用：${JSON.stringify(ctx.calls)}`);
    assert.equal((r.body.discovery as Record<string, unknown>).ok, true);
  });
});

test('GET /models：模型 402 → available:false + 可读 reason（区分"欠费"而不是"请求失败"）', async () => {
  await withCtx(
    { routes: { [MODEL_B]: { status: 402, body: JSON.stringify({ error: { message: 'insufficient_balance' } }) } }, settings: { version: 1, llm: { active: MODEL_A, fallbacks: [MODEL_B] } } },
    async (ctx) => {
      const r = await req(ctx, 'GET', '/api/v1/models', { as: 'admin' });
      const models = r.body.models as { id: string; available: boolean; reason: string }[];
      const bad = models.find((m) => m.id === MODEL_B);
      assert.ok(bad, '应有 model-beta');
      assert.equal(bad?.available, false);
      assert.match(bad?.reason ?? '', /HTTP 402：余额不足/);
      assert.match(bad?.reason ?? '', /insufficient_balance/, '要带上游原文（已脱敏）');
      assert.equal(r.body.activeAvailable, true, '当前模型仍可用');
    },
  );
});

test('GET /models：探测抛异常（超时）→ available:false + 超时说明', async () => {
  await withCtx(
    {
      settings: { version: 1, llm: { active: MODEL_A } },
      routes: Object.fromEntries(
        [MODEL_A].map(() => [] as unknown as [string, { status: number }]),
      ) as Record<string, { status: number }>,
    },
    async (ctx) => {
      // 直接换掉 catalog 的探测路径：让 fetch 抛错
      const cat = new ModelCatalog({
        cfg: ctx.cfg,
        timeoutMs: 500,
        fetchImpl: (async () => {
          throw new Error('The operation was aborted');
        }) as typeof fetch,
      });
      const list = await cat.list({ active: MODEL_A, fallbacks: [] });
      assert.equal(list.models[0]?.available, false);
      assert.match(list.models[0]?.reason ?? '', /探测超时/);
    },
  );
});

test('GET /models：/models 发现失败 → discovery.ok=false 且**不影响**其它字段', async () => {
  await withCtx(
    { routes: { __discovery: { status: 404, body: '{"error":"not found"}' } } },
    async (ctx) => {
      const r = await req(ctx, 'GET', '/api/v1/models', { as: 'admin' });
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
  });
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
    { routes: { [MODEL_B]: { status: 401, body: '{"error":{"message":"invalid api key"}}' } } },
    async (ctx) => {
      const r = await req(ctx, 'POST', '/api/v1/settings/llm/switch', { as: 'admin', body: { model: MODEL_B, mode: 'now' } });
      assert.equal(r.status, 502);
      assert.equal(codeOf(r.body), 'E_MODEL_PROBE');
      assert.match(msgOf(r.body), /已\*\*回滚\*\*到 model-alpha/);
      assert.match((r.body.error as Record<string, string>).detail ?? '', /HTTP 401：凭据无效/);
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
