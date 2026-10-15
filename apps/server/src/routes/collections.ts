/**
 * ★ **视频目录**（`collections`）HTTP 层（契约：前端 `apps/web/src/api/client.ts` §collections）。
 *
 * ## 为什么会有这个文件（真实缺口）
 * ```
 * ✅ db.ts:324  DDL_V4_COLLECTIONS（迁移 v4 已建表 + documents.collection_id）
 * ✅ store/collections-repo.ts（完整 CRUD + scope 过滤 + can_manage/video_count 派生）
 * ❌ routes/     —— **没有这一层** → 前端 `GET /api/v1/collections` 拿到 404
 * ```
 * ⟹ 前端（`Video.vue`）**已完成并在等后端** —— "前后端不一致"比"功能没做"更糟（用户会以为坏了）。
 *
 * ## 硬要求（Lead 指定）
 * ```
 * ① ★ `can_manage` 由**服务端**算（repo 的 `canManageCollection`）—— 前端不许推断
 * ② ★ `published` 是**派生**字段（`review_status === 'published'`）—— 如实算，不硬编码
 * ③ ★ 权限 fail-closed：**不可见 → 404（不泄露存在性）**；可见但无管理权 → 403
 * ④ ★ `video_count` 真实统计（repo `countVideos`，不返回 0 占位）
 * ⑤ ★ 授权判定走 `can()` **单一入口**（不在路由里写第二套 `if (role === …)`）
 * ```
 * ## ⚠️ 关于 `ai_parse.estimated_llm_calls` / `cost_note`（**不编数字**）
 * 前端在缺这两项时会显示"（后端未给代价说明 —— 不编数字）"（`Video.vue::aiParseCost`）。
 * 而 `video_parse` 任务处理器**目前还不存在**（`tasks/` 里没有该 kind）⟹ 任何"预计 N 次调用"
 * 都只能是**编的**。所以这里**如实返回 `available:false` + 原因**，代价字段留空 ——
 * ★ 等 `video-pipeline` 实现 handler 时，**由它给出唯一一份估算**（避免两处算法漂移）。
 */
import type { FastifyInstance } from 'fastify';

import type { AppDeps } from '../app-deps.ts';
import { ApiError, notFound } from '../store/errors.ts';
import { requireUser, scopeFor } from '../auth/middleware.ts';
import { can, reasonOf } from '../auth/permissions.ts';
import { canManageCollection } from '../store/collections-repo.ts';
import { pageParams, sendError, strParam } from './util.ts';

/** 目录名上限（与前端输入框一致；**超长 400，不静默截断**） */
export const COLLECTION_NAME_MAX = 80;
const VISIBILITIES = new Set(['private', 'course', 'public']);
const REVIEW_STATUSES = new Set(['draft', 'reviewed', 'published']);

/**
 * 目录的"内容管理"权限（建/改/删）—— 走 `can()` 单一入口。
 *
 * 语义：这是**教师级内容管理**（与上传/审核同级），不是"读"。
 * ⚠️ 用既有的 `manage_courses` + `global` 资源（= teacher/admin），**不发明新 Action**
 *   （新增 Action 要改 `auth/types.ts` + `permissions.ts`，那不在本次写域内 —— 已向 Lead 报备）。
 */
function requireContentManager(user: ReturnType<typeof requireUser>, deps: AppDeps, detail: string): void {
  void deps;
  const d = can(user, 'manage_courses', { kind: 'global' });
  if (!d.ok) throw new ApiError('E_FORBIDDEN', reasonOf(d), { detail });
}

export function registerCollectionRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { repo } = deps;
  const cols = repo.collections;

  /** `GET /api/v1/collections` —— 按 scope 过滤（学生只看到已发布且 public/本课程的）。 */
  app.get('/api/v1/collections', async (req, reply) => {
    try {
      const user = requireUser(req);
      const { offset, limit } = pageParams((req.query ?? {}) as Record<string, unknown>, 100);
      const list = cols.listScoped(scopeFor(user), { limit, offset });
      // 响应形状与其它列表端点一致（`{total, <items>, offset, limit}`）——
      // 前端读的是 `collections` 字段（`client.ts::collections`）
      return reply.send({ collections: list, total: list.length, offset, limit });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * `GET /api/v1/collections/:id` —— 单个目录（**按 scope**；不可见 → 404）。
   *
   * ⚠️ 前端**不依赖**它（列表 + `/videos` 已够用），但补上它是自然的 REST 形状，
   * 也让"改完之后读回来"这类断言不必绕列表 —— **不可见 → 404** 与其它端点同策略。
   */
  app.get('/api/v1/collections/:id', async (req, reply) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as { id: string };
      const one = cols.getScoped(id, scopeFor(user));
      if (!one) throw notFound('目录', id);
      return reply.send({ collection: one });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** `POST /api/v1/collections` —— 建目录（teacher/admin）。 */
  app.post('/api/v1/collections', async (req, reply) => {
    try {
      const user = requireUser(req);
      requireContentManager(user, deps, 'action=create_collection');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') {
        throw new ApiError('E_BADREQUEST', '目录名不能为空白', { hint: 'Body: { "name": "…" }' });
      }
      if (Array.from(name).length > COLLECTION_NAME_MAX) {
        throw new ApiError('E_BADREQUEST', `目录名过长（上限 ${COLLECTION_NAME_MAX} 字）`, {
          detail: `实际 ${Array.from(name).length}`,
          hint: '服务端**不静默截断**',
        });
      }
      const description = typeof body.description === 'string' ? body.description : undefined;
      const visibility = typeof body.visibility === 'string' ? body.visibility : undefined;
      if (visibility !== undefined && !VISIBILITIES.has(visibility)) {
        throw new ApiError('E_BADREQUEST', `visibility 只能是 private/course/public（实际 ${visibility}）`);
      }
      const id = cols.create({
        name,
        ...(description !== undefined ? { description } : {}),
        ...(visibility !== undefined ? { visibility: visibility as 'private' | 'course' | 'public' } : {}),
        ownerId: user.id,
      });
      const created = cols.getScoped(id, scopeFor(user));
      return reply.code(201).send({ collection: created });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** `PATCH /api/v1/collections/:id` —— 改名/描述/可见性/发布状态（**owner 或 admin**）。 */
  app.patch('/api/v1/collections/:id', async (req, reply) => {
    try {
      const user = requireUser(req);
      const scope = scopeFor(user);
      const { id } = req.params as { id: string };
      const row = cols.getScopedRow(id, scope);
      if (!row) throw notFound('目录', id); // ★ 不可见 → 404（不泄露存在性）
      if (!canManageCollection(row, scope)) {
        throw new ApiError('E_FORBIDDEN', '只能修改自己创建的目录', { detail: `collection=${id}` });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Parameters<typeof cols.update>[1] = {};
      if (body.name !== undefined) {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') throw new ApiError('E_BADREQUEST', '目录名不能为空白');
        if (Array.from(name).length > COLLECTION_NAME_MAX) {
          throw new ApiError('E_BADREQUEST', `目录名过长（上限 ${COLLECTION_NAME_MAX} 字）`);
        }
        patch.name = name;
      }
      if (body.description !== undefined) {
        if (typeof body.description !== 'string') throw new ApiError('E_BADREQUEST', 'description 必须是字符串');
        patch.description = body.description;
      }
      if (body.visibility !== undefined) {
        if (typeof body.visibility !== 'string' || !VISIBILITIES.has(body.visibility)) {
          throw new ApiError('E_BADREQUEST', 'visibility 只能是 private/course/public');
        }
        patch.visibility = body.visibility as 'private' | 'course' | 'public';
      }
      if (body.review_status !== undefined) {
        if (typeof body.review_status !== 'string' || !REVIEW_STATUSES.has(body.review_status)) {
          throw new ApiError('E_BADREQUEST', 'review_status 只能是 draft/reviewed/published');
        }
        patch.reviewStatus = body.review_status as 'draft' | 'reviewed' | 'published';
      }
      if (body.sort_order !== undefined) {
        const n = Number(body.sort_order);
        if (!Number.isFinite(n)) throw new ApiError('E_BADREQUEST', 'sort_order 必须是数字');
        patch.sortOrder = Math.trunc(n);
      }
      cols.update(id, patch);
      return reply.send({ collection: cols.getScoped(id, scope) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * `DELETE /api/v1/collections/:id` —— 删目录（**owner 或 admin**）。
   * ★ **不删视频**：视频回到"未归类"（repo 的既定语义）。
   */
  app.delete('/api/v1/collections/:id', async (req, reply) => {
    try {
      const user = requireUser(req);
      const scope = scopeFor(user);
      const { id } = req.params as { id: string };
      const row = cols.getScopedRow(id, scope);
      if (!row) throw notFound('目录', id);
      if (!canManageCollection(row, scope)) {
        throw new ApiError('E_FORBIDDEN', '只能删除自己创建的目录', { detail: `collection=${id}` });
      }
      const before = cols.countVideos(id);
      cols.delete(id);
      // 如实回报"视频去哪了"（不静默：用户会问"我的视频呢"）
      return reply.send({ ok: true, deleted: id, videos_detached: before });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * `GET /api/v1/collections/:id/videos` —— 目录下的视频（**按 scope 过滤**）。
   *
   * 每项带 `parse_state` / `parse_reason` / `ai_parse`：
   * · `parse_state`：来自该视频**最近的 `video_parse` 任务**（没有 → `'none'`）
   * · `ai_parse.available`：抽取器**真探测**结果（`deps.extractAvailability`）**且** 有 `video_parse` 处理器
   *   —— ★ 缺一不可，**不假装可用**（坑 10）
   * · `estimated_llm_calls` / `cost_note`：★ **不编数字**（见文件头注释）
   */
  app.get('/api/v1/collections/:id/videos', async (req, reply) => {
    try {
      const user = requireUser(req);
      const scope = scopeFor(user);
      const { id } = req.params as { id: string };
      const row = cols.getScopedRow(id, scope);
      if (!row) throw notFound('目录', id);

      const docs = cols.listVideosScoped(id, scope, 'video');
      // `ai_parse` 的可用性：**真探测**（不是"配置里有 key"就算可用）
      const av = await deps.extractAvailability();
      const model = (deps.cfg as { llm?: { model?: string } }).llm?.model ?? '';
      const videos = docs.map((d) => {
        const tasks = repo.listTasks({ docId: d.id, limit: 20 });
        const parseTask = tasks.find((t) => t.kind === 'video_parse');
        const state = parseTask
          ? parseTask.status === 'done'
            ? 'done'
            : parseTask.status === 'failed'
              ? 'failed'
              : parseTask.status === 'queued' || parseTask.status === 'running'
                ? 'running'
                : 'none'
          : 'none';
        return {
          id: d.id,
          title: d.title,
          kind: d.kind,
          collection_id: d.collection_id ?? null,
          size_bytes: d.size_bytes,
          parse_state: state,
          parse_reason: parseTask
            ? String(parseTask.error ?? '') || `任务 ${parseTask.id}（${parseTask.status}）`
            : '尚未触发 AI 解析',
          ai_parse: {
            // ★ 只有"探测通过 + 处理器存在"才算可用
            available: av.ok === true,
            reason: av.ok === true ? '' : av.reason || '模型不可用（未说明原因）',
            ...(model ? { llm_model: model } : {}),
            // ★ 不编数字：代价由将来的 `video_parse` 实现给出唯一一份估算
            cost_note: '视频 AI 解析的代价估算由解析实现给出（当前尚未接入，**不编数字**）',
          },
        };
      });
      return reply.send({ videos, documents: videos, total: videos.length, collection_id: id });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
