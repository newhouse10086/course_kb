/**
 * `/api/v1/settings` · `/api/v1/models` · `/api/v1/settings/llm/switch`
 * （`docs/SETTINGS_AND_SANDBOX.md` §1 + §2；契约 `docs/API_PROTOCOL.md` §8 错误码）。
 *
 * | 方法 | 路径 | 权限 | 说明 |
 * |---|---|---|---|
 * | GET  | `/api/v1/settings` | teacher/admin | **脱敏**只读（不回显凭据） |
 * | PUT  | `/api/v1/settings` | **admin** | 局部更新（深合并）；非法 → 400 且**不落盘** |
 * | GET  | `/api/v1/models` | teacher/admin | 模型列表（**逐个真探测** available/延迟/reason） |
 * | POST | `/api/v1/settings/llm/switch` | **admin** | 热切换 `{model, mode}` |
 *
 * ⚠️ 注册由 `backend-api` 做（他动态 import 本文件）：
 * ```ts
 * createSettingsRoutes({ cfg, store, catalog, repo, queue, providers })(app)
 * ```
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ServerConfig } from '../config.ts';
import type { Repo } from '../store/repo.ts';
import { ApiError } from '../store/errors.ts';
import { hasRole, isAdmin, type AuthUser } from '../auth/types.ts';
import type { ModelCatalog, ModelsResult } from '../settings/models.ts';
import type { SettingsStore } from '../settings/store.ts';
import type { ProviderFacade } from '../app-deps.ts';
import {
  ModelSwitcher,
  redactSettings,
  validateSettings,
  SettingsError,
  sandboxLimitsOf,
  type QueueLike,
  type SwitchMode,
  type SettingsCapabilities,
} from '../settings/index.ts';
import { sendError } from './util.ts';

export interface SettingsRoutesDeps {
  cfg: ServerConfig;
  /** 已加载 + 已挂热重载的 store（`watchSettings({root: cfg.root})`） */
  store: SettingsStore;
  /** 模型目录（真探测）；不传则内部按 `cfg` 新建 */
  catalog?: ModelCatalog;
  repo: Repo;
  queue?: QueueLike | null;
  providers?: ProviderFacade | null;
  /** 额外审计钩子（默认写 `repo.rbac.audit`） */
  audit?: (e: { userId: string | null; action: string; target?: string; detail?: Record<string, unknown> }) => void;
  /** 注入（测试用） */
  switcher?: ModelSwitcher;
}

// ═══════════════════════════════════════════════════════════════════════
// 鉴权
//
// ⚠️ **为什么这里不用 `can(action, GLOBAL)`**：RBAC 的 `Action` 联合类型里
//    **没有** settings 相关动作（`auth/types.ts` 不在本任务写域）——
//    硬套 `manage_users`/`audit_read` 会让"这个接口到底要什么权限"变得不可读。
//    这里用 `isAdmin`/`hasRole` 显式判定，并把状态码对齐契约 §8：
//      未登录 → 401 E_UNAUTHENTICATED；权限不足 → 403 E_FORBIDDEN。
//    TODO(RBAC owner)：新增 `manage_settings`(admin) / `view_settings`(teacher+) 后改回 `can()`。
// ═══════════════════════════════════════════════════════════════════════

function requester(req: FastifyRequest): AuthUser | null {
  return (req as FastifyRequest & { user?: AuthUser | null }).user ?? null;
}

function requireUser(req: FastifyRequest): AuthUser {
  const u = requester(req);
  if (!u) {
    throw new ApiError('E_UNAUTHENTICATED', '未登录：请先 POST /api/v1/auth/login', { hint: '先登录' });
  }
  if (u.status === 'disabled') throw new ApiError('E_ACCOUNT_DISABLED', '账号已被禁用，请联系管理员');
  return u;
}

/** 读写设置页需要 **teacher 及以上**（学生看不到模型/配额配置）。 */
function requireTeacher(req: FastifyRequest): AuthUser {
  const u = requireUser(req);
  if (isAdmin(u) || hasRole(u, 'teacher')) return u;
  throw new ApiError('E_FORBIDDEN', '该操作需要教师权限（settings）', { detail: 'action=view_settings' });
}

/** 改设置 / 热切换模型：**仅 admin**（误切会中断全班长任务）。 */
function requireAdmin(req: FastifyRequest): AuthUser {
  const u = requireUser(req);
  if (!isAdmin(u)) {
    throw new ApiError('E_FORBIDDEN', '该操作需要管理员权限（settings 写 / 模型切换）', {
      detail: 'action=manage_settings',
    });
  }
  return u;
}

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) {
    throw new ApiError('E_BADREQUEST', '请求体应为 JSON 对象');
  }
  return b as Record<string, unknown>;
}

/** 深合并（`PUT` 局部更新）：只覆盖请求里出现的键，其余保持原值。 */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && prev && typeof prev === 'object' && !Array.isArray(prev)) {
      out[k] = deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// 工厂
// ═══════════════════════════════════════════════════════════════════════

export function createSettingsRoutes(deps: SettingsRoutesDeps): (app: FastifyInstance) => Promise<void> {
  const { store, repo } = deps;
  const audit =
    deps.audit ??
    ((e) => {
      repo.rbac.audit(e);
    });

  // 懒建目录（真探测需要 cfg.llm 凭据；不传就按 cfg 建）
  let catalog = deps.catalog ?? null;
  const getCatalog = async (): Promise<ModelCatalog> => {
    if (catalog) return catalog;
    const mod = await import('../settings/models.ts');
    catalog = new mod.ModelCatalog({ cfg: deps.cfg });
    return catalog;
  };

  let switcher = deps.switcher ?? null;
  const getSwitcher = async (): Promise<ModelSwitcher> => {
    if (switcher) return switcher;
    switcher = new ModelSwitcher({
      cfg: deps.cfg,
      store,
      repo,
      catalog: await getCatalog(),
      queue: deps.queue ?? null,
      audit,
    });
    return switcher;
  };

  return async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
    // ── GET /api/v1/settings（脱敏只读）──────────────────────────────
    app.get('/api/v1/settings', async (req, reply) => {
      try {
        requireTeacher(req);
        const v = store.view();
        return reply.send({
          settings: redactSettings(v.settings),
          meta: {
            source: v.source,
            path: v.path,
            revision: v.revision,
            mtimeMs: v.mtimeMs,
            loadedAt: v.loadedAt,
            watching: v.watching,
            lastReloadError: v.lastReloadError,
            lastReloadErrorAt: v.lastReloadErrorAt,
          },
          // 被忽略的配置（如 concurrency 被钳制）+ 建议性告警：**如实回显**
          ignored: v.ignored,
          warnings: v.warnings,
          sandboxLimits: sandboxLimitsOf(v.settings),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });

    // ── PUT /api/v1/settings（仅 admin；非法不落盘）──────────────────
    app.put('/api/v1/settings', async (req, reply) => {
      try {
        const me = requireAdmin(req);
        const patch = bodyOf(req);
        // 允许包一层 `{settings:{...}}`（前端有的写法）也允许直接给字段
        const rawPatch = (patch.settings && typeof patch.settings === 'object' && !Array.isArray(patch.settings)
          ? (patch.settings as Record<string, unknown>)
          : patch);

        const current = redactSettings(store.get()) as Record<string, unknown>;
        const merged = deepMerge(current, rawPatch);

        // ★ 校验：非法 → 400 且**一个字节都不写**（不静默用默认值）
        let validated;
        try {
          validated = validateSettings(merged, { path: store.view().path });
        } catch (e) {
          if (e instanceof SettingsError) {
            audit({ userId: me.id, action: 'settings_update_rejected', target: 'settings.json', detail: { issues: e.issues } });
            return reply.code(400).send(e.toBody());
          }
          throw e;
        }

        const view = store.apply(validated.settings, {
          persist: true,
          warnings: validated.warnings,
          ignored: validated.ignored,
        });
        audit({
          userId: me.id,
          action: 'settings_update',
          target: 'settings.json',
          detail: {
            revision: view.revision,
            keys: Object.keys(rawPatch),
            ignored: validated.ignored.map((i) => i.path),
          },
        });
        return reply.send({
          ok: true,
          settings: redactSettings(view.settings),
          meta: { source: view.source, path: view.path, revision: view.revision, loadedAt: view.loadedAt, watching: view.watching },
          ignored: view.ignored,
          warnings: view.warnings,
          sandboxLimits: sandboxLimitsOf(view.settings),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });

    // ── GET /api/v1/models（逐个真探测）─────────────────────────────
    app.get('/api/v1/models', async (req, reply) => {
      try {
        requireTeacher(req);
        const q = (req.query ?? {}) as Record<string, unknown>;
        const deep = q.deep === '1' || q.deep === 'true' || q.deep === true;
        const s = store.get();
        const cat = await getCatalog();
        const result: ModelsResult = await cat.list({
          active: s.llm.active,
          fallbacks: s.llm.fallbacks,
          deep,
        });
        return reply.send({
          ...result,
          // 前端「模型设置页」要显示"运行中时按钮变为终止并切换" → 顺带给忙状态
          busy: (await getSwitcher()).busy(),
          fallbacks: s.llm.fallbacks,
          concurrency: s.llm.concurrency,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });

    // ── POST /api/v1/settings/llm/switch（仅 admin）──────────────────
    app.post('/api/v1/settings/llm/switch', async (req, reply) => {
      try {
        const me = requireAdmin(req);
        const b = bodyOf(req);
        const model = typeof b.model === 'string' ? b.model : '';
        const mode = b.mode === undefined ? 'drain' : String(b.mode);
        if (!model.trim()) {
          throw new ApiError('E_BADREQUEST', '缺少 model', { hint: '{"model":"glm-5.3","mode":"drain"}' });
        }
        const sw = await getSwitcher();
        const result = await sw.switch({
          model,
          mode: mode as SwitchMode,
          userId: me.id,
          username: me.username,
          // ★ 默认 false：TTL 内复用探测缓存（`probe()` 是**真计费请求**）。
          //   只有调用方显式要"现在就确认它可用"时才传 true —— 代价因此**由调用方知情**。
          forceProbe: b.forceProbe === true,
        });
        // drain 超时 = 200 + state:'timeout'（**没切**，如实说明）。UI 应据此提示而不是当成功。
        const status = result.state === 'timeout' ? 200 : 200;
        return reply.code(status).send({ ...result, activeModel: store.get().llm.active });
      } catch (err) {
        return sendError(reply, err);
      }
    });

    // ── POST /api/v1/settings/llm/switch/resume（仅 admin）──────────────
    //
    // 为什么必须存在：`mode:"drain"` 超时会**保持准入暂停**（等人工处理），
    // 没有出口 = 队列**永久停摆**（学生/教师再也提交不了任务，只能重启服务）。
    // 另有**自动兜底**（`ModelSwitcher` 的自动恢复定时器，默认 10 分钟）——
    // 这条接口是"立刻恢复"，兜底是"人忘了也不会死"。
    app.post('/api/v1/settings/llm/switch/resume', async (req, reply) => {
      try {
        const me = requireAdmin(req);
        const sw = await getSwitcher();
        const before = sw.admissionState();
        const r = sw.resumeAdmissions({ by: 'manual', userId: me.id, username: me.username });
        audit({
          userId: me.id,
          action: 'admissions_resume_requested',
          target: 'settings.llm.admissions',
          detail: { resumed: r.resumed, pausedForMs: before.pausedForMs, by: me.username },
        });
        return reply.send(r);
      } catch (err) {
        return sendError(reply, err);
      }
    });

    // ── GET /api/v1/settings/llm（切换相关的只读视图；给 UI 轮询忙状态）──
    app.get('/api/v1/settings/llm', async (req, reply) => {
      try {
        requireTeacher(req);
        const sw = await getSwitcher();
        const s = store.get();
        const last = sw.lastSwitchInfo();
        return reply.send({
          activeModel: s.llm.active,
          fallbacks: s.llm.fallbacks,
          concurrency: s.llm.concurrency,
          switchedFrom: last?.from ?? null,
          switchedAt: last?.at ?? null,
          busy: sw.busy(),
          // 让 UI 能显示"准入被暂停了 + 还有多久自动恢复"（否则用户只看到"提交没反应"）
          admissions: sw.admissionState(),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  };
}

/** `/capabilities` 的 settings 段落数据（**注册由 backend-api 做**，这里只给数据）。 */
export function settingsCapabilities(store: SettingsStore, switcher?: ModelSwitcher | null): SettingsCapabilities {
  const v = store.view();
  const last = switcher ? switcher.lastSwitchInfo() : null;
  return {
    activeModel: v.settings.llm.active,
    fallbacks: v.settings.llm.fallbacks,
    switchedFrom: last?.from ?? null,
    switchedAt: last?.at ?? null,
    settingsSource: v.source,
    settingsRevision: v.revision,
    hotReload: v.watching,
    lastReloadError: v.lastReloadError,
    ignored: v.ignored,
    concurrency: v.settings.llm.concurrency,
  };
}
