/**
 * 学生 SQL 沙箱 HTTP 层（`docs/SETTINGS_AND_SANDBOX.md` §3 + `worker/README.md` §10）。
 *
 * ## 为什么执行交给 Python worker
 * `better-sqlite3` 是**同步**的 —— 学生写个 `WITH RECURSIVE` 死循环会**卡死 Node 事件循环**
 * （`/health` 不再响应）。所以每次执行都在**独立子进程**里，由 worker 做三层硬超时
 * （SQLite `progress_handler` → 子进程 deadline → 父进程 `kill`）。
 *
 * ## ★ 错误语义（最容易做错的地方）
 * **学生 SQL 写错时 `sandbox.exec` 依然 exit 0**，错误在 `data.error`（`ok:false`）——
 * 那是"**这条 SQL 失败**"，不是"job 失败"。**绝不能当 500 抛**，否则学生看到的
 * 是"服务器错误"而不是"你的 SQL 哪儿错了"，答疑也没法拿到报错原文。
 *
 * 三档区分（本文件的核心职责）：
 * | 情况 | HTTP | 语义 |
 * |---|---|---|
 * | SQL 写错 / 被规则拒 / 超时 | **200** + `ok:false` + `error{code,message,hint,localReading,who}` | 请求成功，SQL 失败 |
 * | 引擎不可用（缺依赖/未部署） | **503** + `E_ENGINE_UNAVAILABLE` | 环境问题，不是学生的问题 |
 * | 调用方错误（缺 sql / 会话不归你） | **400 / 403** | 前端 bug 或越权尝试 |
 *
 * `error.who`（`student|student_logic|rules|system|config|caller`）由 pi-bridge 的
 * `explainDbError()` 分类后**透传**（前端与答疑靠它区分责任方）。
 */

import type { FastifyInstance } from 'fastify';
import path from 'node:path';

import type { AppDeps, SandboxAskHook, SandboxLimits } from '../app-deps.ts';
import { ApiError } from '../store/errors.ts';
import { requireUser } from '../auth/middleware.ts';
import { redact } from '../config.ts';
import { explainDbError } from '../sandbox/ask.ts';
import { safeJsonStringify } from '../tasks/bus.ts';

/** 学生端默认限制（`settings.json` 未接入时的诚实兜底；接入后由 sandbox.limits 覆盖）。 */
export const DEFAULT_LIMITS: SandboxLimits = {
  enabled: true,
  engine: 'sqlite',
  maxRows: 200,
  timeoutMs: 3000,
  maxDbBytes: 20 * 1024 * 1024,
  allowWrites: true,
  resetPolicy: 'per_session',
};

/** 允许出现在会话 id 里的字符（与 worker §10.2 的路径隔离规则对齐）。 */
export function sanitizeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_\-\u4e00-\u9fff]/g, '').slice(0, 48);
}

/** userId → 可放进会话 id 的**可逆**片段（base64url：只含 `A-Za-z0-9-_`，符合 worker 白名单）。 */
export function encodeOwner(userId: string): string {
  return Buffer.from(userId, 'utf8').toString('base64url');
}

export function decodeOwner(encoded: string): string | null {
  try {
    const out = Buffer.from(encoded, 'base64url').toString('utf8');
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * 会话 id 的**服务端推导**：`s_<base64url(userId)>_<dataset>`。
 *
 * 为什么不由客户端随便给：worker 的库路径是 `data/sandbox/<user_id>/<session_id>.sqlite3`，
 * 而 `user_id` **只能来自会话**（不信任客户端）→ 路径天然隔离。
 * 会话 id 绑定用户名还可以让"拿着别人的 sessionId 来执行"在**入口就被拦**
 * （`assertOwnSession`），不必等 worker 去建一个新库。
 *
 * 用 base64url 而不是直接拼 userId：userId 里本身有 `_`（`usr_xxx`），直接拼会导致
 * "会话属于谁"**解析歧义**（`s_usr_abc_sc` 无法确定是 user=`usr` 还是 `usr_abc`）。
 */
export function sessionIdFor(userId: string, dataset = 'sc'): string {
  return `s_${encodeOwner(userId)}_${sanitizeIdPart(dataset) || 'sc'}`;
}

/** 会话 id → 所有者 userId（**解析不出来返回 null**，绝不猜）。 */
export function ownerOfSession(sessionId: string, datasets = ['sc', 'employees', 'orders']): string | null {
  if (!sessionId.startsWith('s_')) return null;
  const parts = sessionId.split('_');
  if (parts.length < 3) return null;
  // 末段是 dataset（我们只会写固定几个名字）→ 其余是 owner
  const last = parts[parts.length - 1] as string;
  const ownerSeg = datasets.includes(last) ? parts.slice(1, -1).join('_') : parts.slice(1).join('_');
  return decodeOwner(ownerSeg);
}

/** 只允许操作**自己的**会话（跨用户 → 403，负例测试覆盖）。 */
export function assertOwnSession(userId: string, sessionId: string): void {
  const owner = ownerOfSession(sessionId);
  if (owner !== userId) {
    throw new ApiError('E_FORBIDDEN', '该沙箱会话不属于当前用户', {
      detail: `session_id=${sessionId} owner=${owner ?? '(无法解析)'} caller=${userId}`,
      hint: '每个学生有独立沙箱库；请先 POST /api/v1/sandbox/session 取自己的 sessionId',
    });
  }
}

/**
 * 渲染一帧 SSE（`data:` 必须是**单行** JSON，契约 §6）。
 *
 * 单独抽成函数是为了**可测**：`/sandbox/ask` 的帧里带学生 SQL 与 SQLite 报错（任意文本），
 * 只要含 `U+2028`/`U+2029` 就会打穿"单行"保证 → 读取器把一帧裂成两帧、**静默丢事件**。
 */
export function sandboxSseFrame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${safeJsonStringify(data)}\n\n`;
}

/** worker 结果 → 学生可读的 `error`（含 `who` 透传）。 */export function decorateError(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const code = typeof e.code === 'string' ? e.code : '';
  const out: Record<string, unknown> = { ...e };
  // `who` 由分类器给出（码比文本稳）；**认不出来就如实说认不出来**，不许瞎归因
  const reading = code ? explainDbError(code) : null;
  if (reading) {
    out.who = reading.who;
    out.who_label = reading.kind;
    out.who_source = 'classifier';
    if (!out.localReading) out.localReading = reading.zh;
  } else {
    out.who_unknown = true;
    out.who_hint = `未识别的错误码${code ? `：${code}` : ''}，无法判定责任方（不猜）`;
  }
  return out;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function registerSandboxRoutes(app: FastifyInstance, deps: AppDeps): void {
  const limitsOf = (): SandboxLimits => deps.sandboxLimits?.() ?? DEFAULT_LIMITS;
  /**
   * 沙箱库的根目录 = `<COURSE_KB_DATA_DIR>/sandbox`。
   *
   * ⚠️ 必须**显式传**：worker 的 `root` 缺省是 `data/sandbox`（相对它自己的 cwd），
   * 不传就会把学生的库写进**仓库默认目录** —— 测试会污染仓库、且 `COURSE_KB_DATA_DIR`
   * 这个"数据目录"配置形同虚设（数据跑到别处去了）。
   * 传到 dataDir 下还有一个好处：清库/备份/迁移 `data/` 一次搞定。
   */
  const sandboxRoot = (): string => path.join(deps.cfg.dataDir, 'sandbox');

  /** 调 worker 并**如实**处理两类失败（job 失败 vs 引擎不可用）。 */
  async function callWorker(
    job: string,
    input: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const res = await deps.runner.raw({ job, input, timeoutMs });
    if (res.ok && res.result) return res.result;
    if (res.cancelled) throw new ApiError('E_BUSY', '沙箱任务被取消', { hint: '重试即可' });
    const code = res.error?.code ?? 'E_WORKER';
    const msg = res.error?.msg ?? '沙箱 worker 调用失败';
    const detail = res.error?.detail ?? res.stderrTail ?? '';
    // 引擎不可用 / worker 缺失 → 如实 503（**不是 500**：环境问题，不是学生的问题）
    if (code === 'E_ENGINE_UNAVAILABLE' || code === 'E_WORKER_UNAVAILABLE') {
      throw new ApiError('E_ASR_LOAD', `沙箱引擎不可用：${msg}`, {
        detail,
        hint: '本机 SQLite 引擎应当永远可用；若报此错说明 worker 环境异常（见 worker/README.md §10.4）',
      });
    }
    if (code === 'E_SANDBOX_PATH' || code === 'E_PAYLOAD') {
      throw new ApiError('E_BADREQUEST', `沙箱入参被拒绝：${msg}`, { detail });
    }
    throw new ApiError('E_WORKER', `沙箱 worker 失败（${code}）：${msg}`, { detail });
  }

  // ── 会话（建/取）───────────────────────────────────────────────────
  app.post('/api/v1/sandbox/session', async (req, reply) => {
    try {
      const user = requireUser(req);
      const lim = limitsOf();
      if (!lim.enabled) {
        throw new ApiError('E_FORBIDDEN', '沙箱已被管理员关闭（settings.sandbox.enabled=false）', {
          hint: '联系教师/管理员开启',
        });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const dataset = typeof body.dataset === 'string' && body.dataset ? body.dataset : 'sc';
      // 客户端可传自己上次拿到的 sessionId（会校验归属），否则服务端推导
      const sessionId =
        typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : sessionIdFor(user.id, dataset);
      assertOwnSession(user.id, sessionId);
      const out = await callWorker(
        'sandbox.init',
        { user_id: user.id, session_id: sessionId, dataset, root: sandboxRoot() },
        Math.max(15_000, lim.timeoutMs * 4),
      );
      return reply.send({
        sessionId,
        engine: out.engine ?? lim.engine,
        dataset: out.dataset ?? dataset,
        created: out.created === true,
        dbBytes: out.dbBytes ?? null,
        schema: out.schema ?? null,
        capabilities: out.capabilities ?? null,
        limits: lim,
      });
    } catch (err) {
      return sendErr(reply, err, deps);
    }
  });

  // ── 执行（★ 学生 SQL 错误仍 200）────────────────────────────────────
  app.post('/api/v1/sandbox/execute', async (req, reply) => {
    try {
      const user = requireUser(req);
      const lim = limitsOf();
      if (!lim.enabled) throw new ApiError('E_FORBIDDEN', '沙箱已被管理员关闭');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sql = typeof body.sql === 'string' ? body.sql : '';
      if (!sql.trim()) {
        throw new ApiError('E_BADREQUEST', '缺少 sql', { detail: 'body 形如 {"sessionId":"…","sql":"SELECT 1"}' });
      }
      const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : sessionIdFor(user.id);
      assertOwnSession(user.id, sessionId);
      const maxRows = num(body.maxRows, lim.maxRows, 1, 5000);
      const timeoutMs = num(body.timeoutMs, lim.timeoutMs, 100, 60_000);

      const out = await callWorker(
        'sandbox.exec',
        {
          user_id: user.id,
          session_id: sessionId,
          sql,
          multi: body.multi === true,
          max_rows: maxRows,
          timeout_ms: timeoutMs,
          // ★ 必须与 init/schema/history 用**同一个 root**！
          //   漏了它 → exec 落到 worker 的默认 `data/sandbox`，而 init 写在你配置的 dataDir 下
          //   → 表现是"建会话成功、一执行就 no such table"（且**不报路径错**，极难查）。
          root: sandboxRoot(),
        },
        // 外层留足余量：让 **worker 自己的超时** 先报（它带 killedBy/hardKilled/可读 hint）；
        // 外层只是"进程彻底不动了"的兜底，不该抢在它前面
        timeoutMs + 15_000,
      );

      const error = decorateError(out.error);
      // ★ 学生 SQL 失败 → **200**（请求成功，SQL 失败）；只有环境问题才是 5xx
      return reply.send({
        sessionId,
        ok: out.ok === true,
        columns: out.columns ?? [],
        rows: out.rows ?? [],
        rowCount: out.rowCount ?? 0,
        truncated: out.truncated === true,
        elapsedMs: out.elapsedMs ?? null,
        statementKind: out.statementKind ?? null,
        engine: out.engine ?? lim.engine,
        affected: out.affected ?? null,
        dbBytes: out.dbBytes ?? null,
        hints: out.hints ?? [],
        ...(Array.isArray(out.statements) ? { statements: out.statements } : {}),
        ...(error ? { error } : {}),
        // 超时/被杀的可读归因（§10.3：S4 答疑要靠它说清"是被超时停掉的，不是语法错"）
        ...(out.killedBy !== undefined ? { killedBy: out.killedBy } : {}),
        ...(out.hardKilled !== undefined ? { hardKilled: out.hardKilled } : {}),
      });
    } catch (err) {
      return sendErr(reply, err, deps);
    }
  });

  // ── 重置 ───────────────────────────────────────────────────────────
  app.post('/api/v1/sandbox/reset', async (req, reply) => {
    try {
      const user = requireUser(req);
      const lim = limitsOf();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const dataset = typeof body.dataset === 'string' && body.dataset ? body.dataset : 'sc';
      const sessionId =
        typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : sessionIdFor(user.id, dataset);
      assertOwnSession(user.id, sessionId);
      const out = await callWorker(
        'sandbox.reset',
        { user_id: user.id, session_id: sessionId, dataset, root: sandboxRoot() },
        Math.max(15_000, lim.timeoutMs * 4),
      );
      deps.repo.rbac.audit({ userId: user.id, action: 'sandbox_reset', target: sessionId });
      return reply.send({ sessionId, reset: true, engine: out.engine ?? lim.engine, schema: out.schema ?? null });
    } catch (err) {
      return sendErr(reply, err, deps);
    }
  });

  // ── 数据集 / 引擎 / schema / 历史 / 日志 ────────────────────────────
  app.get('/api/v1/sandbox/datasets', async (req, reply) => {
    try {
      const lim = limitsOf();
      const withSql = (req.query as Record<string, unknown> | undefined)?.with_sql === '1';
      const out = await callWorker('sandbox.datasets', { with_sql: withSql, root: sandboxRoot() }, 30_000);
      return reply.send({
        default: out.default ?? 'sc',
        datasets: out.datasets ?? [],
        engine: lim.engine,
        limits: lim,
      });
    } catch (err) {
      return sendErr(reply, err, deps);
    }
  });

  app.get('/api/v1/sandbox/engines', async (_req, reply) => {
    try {
      const out = await callWorker('sandbox.engines', { root: sandboxRoot() }, 30_000);
      return reply.send(out);
    } catch (err) {
      return sendErr(reply, err, deps);
    }
  });

  app.get('/api/v1/sandbox/schema', async (req, reply) => {
    try {
      const user = requireUser(req);
      const q = (req.query ?? {}) as Record<string, unknown>;
      const sessionId = typeof q.sessionId === 'string' && q.sessionId ? q.sessionId : sessionIdFor(user.id);
      assertOwnSession(user.id, sessionId);
      const out = await callWorker(
        'sandbox.schema',
        { user_id: user.id, session_id: sessionId, with_text: q.with_text === '1', root: sandboxRoot() },
        30_000,
      );
      return reply.send({ sessionId, ...out });
    } catch (err) {
      return sendErr(reply, err, deps);
    }
  });

  app.get('/api/v1/sandbox/history', async (req, reply) => {
    try {
      const user = requireUser(req);
      const q = (req.query ?? {}) as Record<string, unknown>;
      const sessionId = typeof q.sessionId === 'string' && q.sessionId ? q.sessionId : sessionIdFor(user.id);
      assertOwnSession(user.id, sessionId);
      const limit = num(q.limit, 20, 1, 200);
      // ★ `request_user_id` 必须等于调用者：worker 侧据此做**日志隔离**（§10.2）
      const out = await callWorker(
        'sandbox.history',
        { user_id: user.id, session_id: sessionId, limit, request_user_id: user.id, root: sandboxRoot() },
        30_000,
      );
      // ⚠️ worker 出参是 `{records, count}`（不是 `entries`）—— 原写成 `out.entries ?? out` 会
      //    把整个对象当数组返回（前端 `.some()`/`.length` 全崩）。两个名字都收，且**返回真数组**。
      const records = Array.isArray(out.records)
        ? (out.records as unknown[])
        : Array.isArray(out.entries)
          ? (out.entries as unknown[])
          : Array.isArray(out)
            ? (out as unknown[])
            : [];
      return reply.send({ sessionId, entries: records, count: out.count ?? records.length });
    } catch (err) {
      return sendErr(reply, err, deps);
    }
  });

  app.get('/api/v1/sandbox/logs', async (req, reply) => {
    try {
      const user = requireUser(req);
      const q = (req.query ?? {}) as Record<string, unknown>;
      const sessionId = typeof q.sessionId === 'string' && q.sessionId ? q.sessionId : sessionIdFor(user.id);
      assertOwnSession(user.id, sessionId);
      const out = await callWorker(
        'sandbox.logs',
        {
          user_id: user.id,
          session_id: sessionId,
          limit: num(q.limit, 50, 1, 500),
          with_text: q.with_text === '1',
          request_user_id: user.id,
        },
        30_000,
      );
      deps.repo.rbac.audit({ userId: user.id, action: 'sandbox_log_read', target: sessionId });
      return reply.send({ sessionId, ...out });
    } catch (err) {
      return sendErr(reply, err, deps);
    }
  });

  // ── ★ AI 答疑（SSE 流式；handler 由 pi-bridge 的 `createAskHandler` 提供）──
  app.post('/api/v1/sandbox/ask', async (req, reply) => {
    const user = requireUser(req);
    const ask: SandboxAskHook | null = deps.sandboxAsk ?? null;
    if (!ask) {
      // 如实降级：agent 不可用时不能假装能答疑
      throw new ApiError('E_PI_UNAVAILABLE', 'AI 答疑不可用（agent 模块未就绪）', {
        hint: '检查 /api/v1/capabilities 的 pi 段与 providers 配置',
      });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : sessionIdFor(user.id);
    assertOwnSession(user.id, sessionId);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (event: string, data: Record<string, unknown>): void => {
      try {
        // ★ 必须用 `safeJsonStringify`（不是 `JSON.stringify`）：学生 SQL 与 SQLite 报错是**任意文本**，
        //   而 `JSON.stringify` **不转义 U+2028/U+2029**（坑 17，Node 24 实测）——按行切帧的读取器
        //   会把一帧裂成两帧，第二段不是合法 JSON → **静默丢事件**；而"学生写错 SQL 正需要解答"
        //   恰恰是最依赖这条帧的时刻。SSE 契约（§6）要求 `data:` 是**单行** JSON。
        reply.raw.write(sandboxSseFrame(event, data));
      } catch {
        /* 对端断开 */
      }
    };
    write('open', { sessionId, user: user.username });
    try {
      const outcome = await ask.handle(
        {
          sessionId,
          sql: typeof body.sql === 'string' ? body.sql : undefined,
          error: typeof body.error === 'string' ? body.error : undefined,
          rawError: typeof body.rawError === 'string' ? body.rawError : undefined,
          question: typeof body.question === 'string' ? body.question : undefined,
          userId: user.id,
        },
        (frame) => write('frame', frame as Record<string, unknown>),
      );
      write('done', outcome as Record<string, unknown>);
    } catch (err) {
      write('error', { code: 'E_INTERNAL', msg: redact(err instanceof Error ? err.message : String(err)) });
    } finally {
      try {
        reply.raw.end();
      } catch {
        /* 已结束 */
      }
    }
  });
}

/** 统一的错误出口（复用既有契约形状）。 */
function sendErr(
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  err: unknown,
  deps: AppDeps,
): unknown {
  if (err instanceof ApiError) {
    return reply.code(err.httpStatus).send({
      error: { code: err.code, msg: err.message, ...(err.detail ? { detail: err.detail } : {}), ...(err.hint ? { hint: err.hint } : {}) },
    });
  }
  const msg = redact(err instanceof Error ? err.message : String(err));
  void deps;
  return reply.code(500).send({ error: { code: 'E_INTERNAL', msg } });
}
