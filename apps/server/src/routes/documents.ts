/**
 * 文档与知识库路由（契约 §5.2 / §5.5 / §5.7）。
 *
 * | 方法 | 路径 |
 * |---|---|
 * | POST | `/api/v1/documents`（multipart，字段 `file`）→ 202 |
 * | GET | `/api/v1/documents`（`?offset&limit&kind&status`） |
 * | GET | `/api/v1/documents/{id}` / DELETE |
 * | GET | `/api/v1/documents/{id}/outline` / `units` / `cards` / `graph` / `xrefs` |
 * | GET | `/api/v1/documents/{id}/file`（**Range**） |
 * | GET | `/api/v1/documents/{id}/video[/subtitle|transcript|mindmap|slides|stream]` / POST `video/reparse` |
 */

import fs from 'node:fs';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';

import type { FastifyInstance } from 'fastify';

import type { AppDeps } from '../app-deps.ts';
import { ApiError, notFound } from '../store/errors.ts';
import { buildOutline } from '../store/outline.ts';
import { newDocId } from '../store/ids.ts';
import { EXT_TO_KIND, KIND_TO_MIME, kindFromFilename } from '../store/types.ts';
import { xrefHistogram } from '../store/xref.ts';
import { EXTRACT_STATUS, readExtractStatus } from '../tasks/handlers.ts';
import type { DocumentApi, DocumentRow } from '../store/repo.ts';
import { docVisible } from '../store/scope.ts';
import { can, reasonOf } from '../auth/permissions.ts';
import { documentResource, requireUser, scopeFor } from '../auth/middleware.ts';
import { taskPriority } from '../auth/types.ts';
import type { Action } from '../auth/types.ts';
import { intParam, pageParams, requireDoc, sendError, strParam, supportedFormatsHint } from './util.ts';

const SUPPORTED_EXTS = Object.keys(EXT_TO_KIND);

/**
 * ★ 文档级授权的**唯一入口**（RBAC §2/§4/§6）。
 *
 * 语义（**刻意区分 404 与 403**）：
 * - 文档不存在 → 404
 * - 存在但**对该用户不可见**（例如学生对 draft）→ **404**：不泄露"存在一个你看不到的东西"
 * - 可见但无权做该动作（例如学生想 review 已发布文档）→ **403** + 可读原因
 *
 * 这样"学生访问 draft"**不会返回空数据冒充成功** —— 它就是 404。
 */
function authorizeDoc(
  req: Parameters<typeof requireUser>[0],
  deps: AppDeps,
  id: string,
  action: Action,
): DocumentRow {
  const user = requireUser(req);
  const row = deps.repo.getDocumentRow(id);
  if (!row) throw notFound('document', id);
  const visible = docVisible(scopeFor(user), row);
  const decision = can(user, action, documentResource(row));
  if (!decision.ok) {
    // 不可见时**一律 404**（哪怕真实原因是权限不足）—— 不泄露存在性
    if (!visible) throw notFound('document', id);
    if (decision.code === 'E_UNAUTHENTICATED') throw new ApiError('E_UNAUTHENTICATED', reasonOf(decision));
    throw new ApiError('E_FORBIDDEN', reasonOf(decision), { detail: `action=${action} document_id=${id}` });
  }
  if (!visible) throw notFound('document', id);
  return row;
}

/**
 * 文档详情里的「抽取状态」表达（**"未抽取" 必须能与 "抽取了但没结果" 区分**）。
 * 前端据此显示"尚未抽取卡片 / 抽取失败（原因）/ 已抽取 N 张"，而不是把空列表当成功。
 */
function withExtractStatus(deps: AppDeps, doc: DocumentApi): Record<string, unknown> {
  const st = readExtractStatus(doc.meta ?? {});
  const lastExtract = deps.repo.listTasks({ docId: doc.id, limit: 30 }).find((t) => t.kind === 'extract');
  return {
    ...doc,
    extract_status: st.extract_status,
    extract_error: st.extract_error,
    extract_done_at: st.extract_done_at,
    ...(lastExtract ? { extract_task_id: lastExtract.id, extract_task_status: lastExtract.status } : {}),
  };
}

export function registerDocumentRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { repo, cfg, queue } = deps;

  // ── 上传（202）──────────────────────────────────────────────────────
  app.post('/api/v1/documents', async (req, reply) => {
    try {
      // RBAC §1：只有教师/管理员能上传资料（学生"看不到"上传入口）
      const user = requireUser(req);
      {
        const d = can(user, 'upload', { kind: 'global' });
        if (!d.ok) throw new ApiError('E_FORBIDDEN', reasonOf(d), { detail: 'action=upload' });
      }
      if (!req.isMultipart()) {
        throw new ApiError('E_NOFILE', '请求必须是 multipart/form-data', {
          detail: '字段名应为 file',
          hint: '用 -F "file=@xxx.pdf" 上传',
        });
      }
      const part = await req.file({ limits: { fileSize: cfg.maxUploadBytes } });
      if (!part) {
        throw new ApiError('E_NOFILE', '未提供文件', {
          detail: '字段名应为 file',
          hint: supportedFormatsHint(SUPPORTED_EXTS),
        });
      }
      const filename = part.filename ?? '';
      const kind = kindFromFilename(filename);
      if (!kind) {
        // 上传失败**不留空文档**（先校验再落库）
        throw new ApiError('E_FORMAT', `不支持的文件格式：${filename || '(无扩展名)'}`, {
          detail: supportedFormatsHint(SUPPORTED_EXTS),
          hint: '换用受支持的格式，或为该格式新增 worker adapter',
        });
      }

      const docId = newDocId();
      const ext = path.extname(filename).toLowerCase() || '.bin';
      const docDir = path.join(cfg.uploadsDir, docId);
      fs.mkdirSync(docDir, { recursive: true });

      // 契约 C5：**先写暂存，再原子替换**（曾先删后写导致全丢）
      const tmpDir = path.join(cfg.tmpDir, 'uploads');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `${docId}.part`);
      const finalFile = path.join(docDir, `original${ext}`);
      await streamPipeline(part.file, fs.createWriteStream(tmpFile));

      if (part.file.truncated) {
        fs.rmSync(tmpFile, { force: true });
        fs.rmSync(docDir, { recursive: true, force: true });
        const mb = Math.round(cfg.maxUploadBytes / (1024 * 1024));
        throw new ApiError('E_TOOBIG', `文件超过上限 ${mb} MB`, {
          detail: `limit=${cfg.maxUploadBytes}`,
          hint: `当前上限 ${mb} MB，可用 COURSE_KB_MAX_UPLOAD 调整`,
        });
      }
      if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) {
        fs.rmSync(tmpFile, { force: true });
        fs.rmSync(docDir, { recursive: true, force: true });
        throw new ApiError('E_NOFILE', '上传内容为空', { hint: '确认文件不是 0 字节' });
      }
      fs.renameSync(tmpFile, finalFile); // 原子替换

      const size = fs.statSync(finalFile).size;
      const relPath = path.relative(cfg.root, finalFile).split(path.sep).join('/');
      // RBAC：记录上传者；**抽取产物默认 draft**（学生看不到，教师审核后才发布，§2）
      const courseId = strParam(req.query ? (req.query as Record<string, unknown>).course_id : undefined) ?? null;
      if (courseId) {
        const course = repo.rbac.getCourse(courseId);
        if (!course) throw new ApiError('E_NOTFOUND', `课程不存在：${courseId}`);
        const d = can(user, 'manage_courses', { kind: 'course', ownerId: course.owner_id, courseId });
        if (!d.ok) throw new ApiError('E_FORBIDDEN', reasonOf(d), { detail: 'action=upload_to_course' });
      }
      repo.insertDocument({
        id: docId,
        title: filename.replace(/\.[^.]+$/, ''),
        kind,
        source_path: relPath,
        size_bytes: size,
        status: 'uploading',
        meta: { original_filename: filename, uploaded_at: Date.now() },
        ownerId: user.id,
        visibility: courseId ? 'course' : 'private',
        reviewStatus: 'draft',
        courseId,
      });

      const taskId = queue.enqueue({
        docId,
        kind: 'parse',
        params: { doc_id: docId },
        // RBAC §5：教师/系统 = 0 优先；学生（若能上传）也不会挤掉教师
        priority: taskPriority(user),
        userId: user.id,
      });
      repo.rbac.audit({ userId: user.id, action: 'upload', target: docId, detail: { filename, kind, course_id: courseId } });
      return reply.code(202).send({
        document_id: docId,
        task_id: taskId,
        status: 'uploading',
        review_status: 'draft',
        events_url: `/api/v1/tasks/${taskId}/events`,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── 列表（**按 scope 过滤**：学生只看得到 published）─────────────────
  app.get('/api/v1/documents', async (req, reply) => {
    try {
      const user = requireUser(req);
      const q = (req.query ?? {}) as Record<string, unknown>;
      const { offset, limit } = pageParams(q);
      // ★ `listDocumentsScoped(scope, …)`：scope 必填 → 不可能"忘了加可见性"
      const out = repo.listDocumentsScoped(scopeFor(user), {
        offset,
        limit,
        ...(strParam(q.kind) ? { kind: strParam(q.kind) as string } : {}),
        ...(strParam(q.status) ? { status: strParam(q.status) as string } : {}),
        ...(strParam(q.review_status) ? { reviewStatus: strParam(q.review_status) as string } : {}),
      });
      return reply.send({
        total: out.total,
        documents: out.documents,
        offset,
        limit,
        // 让调用方知道"你看到的不是全部"（学生）——避免把过滤当成"库里就这些"
        scope: { is_admin: user.roles.includes('admin'), filtered_by_review: !user.roles.includes('admin') && user.teacherCourseIds.length === 0 },
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── 审核 / 发布（RBAC §2 的状态机）───────────────────────────────────
  /**
   * `POST /api/v1/documents/{id}/review` `{status: 'reviewed'|'published'|'draft', note?}`
   *
   * 状态机：`draft → reviewed → published`（也允许 `published → reviewed` 撤回）。
   * 权限（走 `can()`，不在这里写第二个 if）：
   * - `review`（draft↔reviewed）：教师及以上，且是 owner 或该课程任课教师
   * - `publish`（→published）：**同样只给教师** —— RBAC §4 明写"owner 除发布外全权"，
   *   所以"仅因为是 owner"不足以发布
   */
  app.post('/api/v1/documents/:id/review', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const target = typeof body.status === 'string' ? body.status : '';
      if (target !== 'draft' && target !== 'reviewed' && target !== 'published') {
        throw new ApiError('E_FORMAT', `非法状态：${target || '(空)'}`, {
          detail: 'status ∈ draft | reviewed | published',
        });
      }

      // 拿**未过滤**的行：不存在 → 404；存在但不可见 → 404；可见但无权 → 403
      const row = authorizeDoc(req, deps, id, target === 'published' ? 'publish' : 'review');
      const user = requireUser(req);
      const previous = row.review_status;
      if (previous === target) {
        return reply.send({ document_id: id, review_status: target, changed: false, previous });
      }
      repo.setReviewStatus(id, target, user.id);
      repo.rbac.audit({
        userId: user.id,
        action: target === 'published' ? 'publish' : 'review',
        target: id,
        detail: { from: previous, to: target, note: typeof body.note === 'string' ? body.note.slice(0, 500) : '' },
      });
      return reply.send({ document_id: id, review_status: target, changed: true, previous });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── 详情（不可见 → 404，不返回空壳）─────────────────────────────────
  app.get('/api/v1/documents/:id', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      authorizeDoc(req, deps, id, 'read');
      const doc = requireDoc(repo.getDocumentScoped(id, scopeFor(requireUser(req))), id);
      return reply.send(withExtractStatus(deps, doc));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * `POST /api/v1/documents/{id}/extract` —— 触发卡片/图谱/交叉引用抽取（202，与上传同形）。
   *
   * 语义（**这是"未抽取"与"抽取了但没结果"的分界**）：
   * - 抽取能力**不可用** → 503 `E_LLM` + 可读 `reason`（**不排任务**，不假装成功）
   * - 文档还没有 units → 422 `E_PARSE`（提示先解析）
   * - 可选 `{units?: number[], limit?: number}` 先小样本跑
   */
  app.post('/api/v1/documents/:id/extract', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      // RBAC：路由的每个"存在性检查"都必须带可见性（§2/§6）
      authorizeDoc(req, deps, id, 'read');

      const nUnits = repo.listUnits(id, { limit: 1 }).total;
      if (nUnits === 0) {
        throw new ApiError('E_PARSE', '该文档还没有解析出单元，无法抽取', {
          detail: `document_id=${id}`,
          hint: '等待 parse 任务完成；若已失败，重新上传或查看 /api/v1/tasks?doc_id=',
        });
      }

      const av = await deps.extractAvailability();
      if (!av.ok) {
        throw new ApiError('E_LLM', '抽取能力当前不可用', {
          detail: av.reason,
          hint: '配置 LLM 凭据（.env 的 AMR_KEY / config/providers.yaml）后重试；额度恢复后重试即可',
        });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const taskId = queue.enqueue({
        docId: id,
        kind: 'extract',
        params: {
          ...(Array.isArray(body.units) ? { units: body.units } : {}),
          ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
        },
      });
      return reply.code(202).send({
        document_id: id,
        task_id: taskId,
        status: 'queued',
        events_url: `/api/v1/tasks/${taskId}/events`,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/v1/documents/:id', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      // RBAC：路由的每个"存在性检查"都必须带可见性（§2/§6）
      authorizeDoc(req, deps, id, 'read');
      deps.bus.forget(id);
      const ok = repo.deleteDocument(id);
      return reply.send({ deleted: ok });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── outline / units / cards / graph / xrefs ─────────────────────────
  app.get('/api/v1/documents/:id/outline', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      // RBAC：路由的每个"存在性检查"都必须带可见性（§2/§6）
      authorizeDoc(req, deps, id, 'read');
      return reply.send(buildOutline(repo, id));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/v1/documents/:id/units', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      // RBAC：路由的每个"存在性检查"都必须带可见性（§2/§6）
      authorizeDoc(req, deps, id, 'read');
      const { offset, limit } = pageParams((req.query ?? {}) as Record<string, unknown>, 500);
      return reply.send(repo.listUnits(id, { offset, limit }));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/v1/documents/:id/cards', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      // RBAC：路由的每个"存在性检查"都必须带可见性（§2/§6）
      authorizeDoc(req, deps, id, 'read');
      const { offset, limit } = pageParams((req.query ?? {}) as Record<string, unknown>, 200);
      return reply.send(repo.listCards(id, { offset, limit }));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/v1/documents/:id/graph', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      // RBAC：路由的每个"存在性检查"都必须带可见性（§2/§6）
      authorizeDoc(req, deps, id, 'read');
      const g = repo.getGraph(id);
      const types = new Set(g.edges.map((e) => e.etype));
      const verified = g.edges.filter((e) => !e.flagged && e.confidence > 0).length;
      return reply.send({
        document_id: id,
        nodes: g.nodes,
        edges: g.edges,
        stats: {
          nodes: g.nodes.length,
          edges: g.edges.length,
          types: types.size,
          verify_rate: g.edges.length === 0 ? 0 : Number((verified / g.edges.length).toFixed(3)),
        },
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/v1/documents/:id/xrefs', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      // RBAC：路由的每个"存在性检查"都必须带可见性（§2/§6）
      authorizeDoc(req, deps, id, 'read');
      const rows = repo.listXrefs(id);
      const histogram = xrefHistogram(repo, id);
      const froms = new Set(rows.map((r) => r.from_card_id));
      return reply.send({
        document_id: id,
        total: rows.length,
        xrefs: rows,
        histogram,
        cards_with_xrefs: froms.size,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── 原文件（**Range**：PDF 跳页 / 视频拖动都依赖它）──────────────────
  app.get('/api/v1/documents/:id/file', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const doc = authorizeDoc(req, deps, id, 'read');
      const abs = path.isAbsolute(doc.source_path) ? doc.source_path : path.join(cfg.root, doc.source_path);
      if (!fs.existsSync(abs)) {
        throw new ApiError('E_NOTFOUND', '原始文件不在磁盘上', {
          detail: abs,
          hint: '文件可能已被移动或删除；重新上传即可',
        });
      }
      const size = fs.statSync(abs).size;
      const mime = KIND_TO_MIME[doc.kind] ?? 'application/octet-stream';
      const rangeHeader = req.headers.range;

      if (!rangeHeader) {
        return reply
          .code(200)
          .header('content-type', mime)
          .header('content-length', String(size))
          .header('accept-ranges', 'bytes')
          .header('content-disposition', `inline; filename="${encodeURIComponent(path.basename(abs))}"`)
          .send(fs.createReadStream(abs));
      }

      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (!m) {
        return reply
          .code(416)
          .header('content-range', `bytes */${size}`)
          .send({ error: { code: 'E_FORMAT', msg: `非法 Range 头：${rangeHeader}`, hint: '形如 bytes=0-99' } });
      }
      const startRaw = m[1] ?? '';
      const endRaw = m[2] ?? '';
      let start: number;
      let end: number;
      if (startRaw === '') {
        // 后缀范围：bytes=-500 → 最后 500 字节
        const suffix = Number.parseInt(endRaw, 10);
        start = Math.max(0, size - suffix);
        end = size - 1;
      } else {
        start = Number.parseInt(startRaw, 10);
        end = endRaw === '' ? size - 1 : Number.parseInt(endRaw, 10);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        return reply
          .code(416)
          .header('content-range', `bytes */${size}`)
          .send({ error: { code: 'E_FORMAT', msg: `Range 越界：${rangeHeader}`, detail: `文件大小 ${size}` } });
      }
      end = Math.min(end, size - 1);
      return reply
        .code(206)
        .header('content-type', mime)
        .header('content-length', String(end - start + 1))
        .header('content-range', `bytes ${start}-${end}/${size}`)
        .header('accept-ranges', 'bytes')
        .send(fs.createReadStream(abs, { start, end }));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── 视频产物（契约 §5.5）────────────────────────────────────────────
  app.get('/api/v1/documents/:id/video', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      // RBAC：路由的每个"存在性检查"都必须带可见性（§2/§6）
      authorizeDoc(req, deps, id, 'read');
      const art = repo.getVideoArtifact(id);
      // 产物不存在 → 404（**不是**空切片假装成功）
      if (!art) throw notFound('视频产物', id);
      return reply.send(art);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/v1/documents/:id/video/subtitle', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      // RBAC：路由的每个"存在性检查"都必须带可见性（§2/§6）
      authorizeDoc(req, deps, id, 'read');
      const art = repo.getVideoArtifact(id);
      if (!art) throw notFound('字幕', id);
      const fmt = strParam((req.query as Record<string, unknown>).fmt) ?? 'srt';
      if (fmt !== 'srt' && fmt !== 'vtt') {
        throw new ApiError('E_FORMAT', `不支持的字幕格式：${fmt}`, { detail: '支持 srt | vtt' });
      }
      const rel = String(((art.subtitles as Record<string, unknown>) ?? {})[fmt] ?? '');
      if (!rel) throw notFound(`${fmt} 字幕`, id);
      const abs = path.isAbsolute(rel) ? rel : path.join(cfg.root, rel);
      if (!fs.existsSync(abs)) {
        throw new ApiError('E_NOTFOUND', '字幕文件不在磁盘上', { detail: abs });
      }
      const mime = fmt === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8';
      return reply
        .code(200)
        .header('content-type', mime)
        .header('content-disposition', `inline; filename="subtitle.${fmt}"`)
        .send(fs.readFileSync(abs, 'utf8'));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/v1/documents/:id/video/transcript', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      // RBAC：路由的每个"存在性检查"都必须带可见性（§2/§6）
      authorizeDoc(req, deps, id, 'read');
      const art = repo.getVideoArtifact(id);
      if (!art) throw notFound('文稿', id);
      return reply.send({ document_id: id, transcript: art.transcript });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/v1/documents/:id/video/mindmap', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      // RBAC：路由的每个"存在性检查"都必须带可见性（§2/§6）
      authorizeDoc(req, deps, id, 'read');
      const art = repo.getVideoArtifact(id);
      if (!art) throw notFound('思维导图', id);
      const mindmap = (art.mindmap as Record<string, unknown>) ?? {};
      if (!mindmap.content) {
        throw new ApiError('E_NOTFOUND', '思维导图尚未生成', {
          hint: '需先跑 mindmap 任务（依赖 ASR 文稿）',
        });
      }
      return reply.send({ document_id: id, ...mindmap });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/v1/documents/:id/video/slides', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      // RBAC：路由的每个"存在性检查"都必须带可见性（§2/§6）
      authorizeDoc(req, deps, id, 'read');
      const art = repo.getVideoArtifact(id);
      if (!art) throw notFound('幻灯片帧', id);
      return reply.send({ document_id: id, slides: art.slides });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** 视频流：与 `/file` 同源的 Range 实现（前端 `video` 元素直接指向它）。 */
  app.get('/api/v1/documents/:id/stream', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const doc = authorizeDoc(req, deps, id, 'read');
      if (doc.kind !== 'video') {
        throw new ApiError('E_FORMAT', '该文档不是视频', {
          detail: `kind=${doc.kind}`,
          hint: '视频流只对 kind=video 的文档可用',
        });
      }
      return reply.redirect(`/api/v1/documents/${id}/file`);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * 重跑视频解析（可指定 asr_model）。
   * worker 不具备 asr 能力时**如实 503 `E_ASR_LOAD`**，而不是排一个跑不起来的任务。
   */
  app.post('/api/v1/documents/:id/video/reparse', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      // RBAC：路由的每个"存在性检查"都必须带可见性（§2/§6）
      authorizeDoc(req, deps, id, 'read');
      if (!deps.workerCapability.available) {
        throw new ApiError('E_ASR_LOAD', '本地 ASR 不可用，无法重跑视频解析', {
          detail: deps.workerCapability.reason,
          hint: '确认 worker/cli.py 可用且已安装 faster-whisper；或配置云端 ASR provider',
        });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const taskId = queue.enqueue({
        docId: id,
        kind: 'asr',
        params: {
          op: 'transcribe',
          ...(strParam(body.asr_model) ? { model: strParam(body.asr_model) as string } : {}),
          ...(strParam(body.language) ? { language: strParam(body.language) as string } : {}),
        },
      });
      return reply.code(202).send({
        document_id: id,
        task_id: taskId,
        status: 'queued',
        events_url: `/api/v1/tasks/${taskId}/events`,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
