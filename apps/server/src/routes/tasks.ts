/**
 * 任务路由（契约 §5.6 + §6）—— 含 **SSE 进度流**。
 *
 * | 方法 | 路径 |
 * |---|---|
 * | GET | `/api/v1/tasks`（列表，附加） |
 * | GET | `/api/v1/tasks/{id}` |
 * | GET | `/api/v1/tasks/{id}/events` ← SSE |
 * | POST | `/api/v1/tasks/{id}/cancel` |
 *
 * SSE 契约（§6，逐条落实）：
 * - `data:` 是**单行 JSON**（`JSON.stringify` 天然满足：字符串里的换行/U+2028 都会转义）
 * - 每 **15 秒**一次 `: keepalive` 注释帧
 * - 任务结束（done/failed/cancelled）后**服务端主动关闭**
 * - 断线重连用 **`Last-Event-ID`** 从断点续推
 *
 * ⚠️ 进程重启后内存缓冲为空，但**任务行还在库**里 —— 此时按 DB 状态**合成**
 * `progress` + 终态帧，保证前端不会挂在"永远没有 done"的流上。
 */

import type { FastifyInstance } from 'fastify';

import type { AppDeps } from '../app-deps.ts';
import { notFound } from '../store/errors.ts';
import { formatSseFrame } from '../tasks/bus.ts';
import { intParam, sendError, strParam } from './util.ts';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

export function registerTaskRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { repo, bus, queue, cfg } = deps;

  /** 任务列表（`?doc_id&status&limit`）—— v1 无此端点，附加且非破坏。 */
  app.get('/api/v1/tasks', async (req, reply) => {
    try {
      const q = (req.query ?? {}) as Record<string, unknown>;
      return reply.send({
        tasks: repo.listTasks({
          ...(strParam(q.doc_id) ? { docId: strParam(q.doc_id) as string } : {}),
          ...(strParam(q.status) ? { status: strParam(q.status) as string } : {}),
          limit: intParam(q.limit, 50, { min: 1, max: 500 }),
        }),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/v1/tasks/:id', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const task = repo.getTask(id);
      if (!task) throw notFound('任务', id);
      return reply.send(task);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/v1/tasks/:id/cancel', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const task = repo.getTask(id);
      if (!task) throw notFound('任务', id);
      const cancelled = queue.cancel(id);
      return reply.send({ task_id: id, cancelled, status: queue.status(id) ?? task.status });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── SSE ────────────────────────────────────────────────────────────
  app.get('/api/v1/tasks/:id/events', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const task = repo.getTask(id);
      if (!task) throw notFound('任务', id);

      // `Last-Event-ID` 头优先；兼容 query（EventSource 之外的手动重连）
      const headerId = req.headers['last-event-id'];
      const queryId = (req.query as Record<string, unknown> | undefined)?.last_event_id;
      const fromRaw = typeof headerId === 'string' ? headerId : typeof queryId === 'string' ? queryId : undefined;
      const fromId = fromRaw !== undefined && Number.isFinite(Number.parseInt(fromRaw, 10))
        ? Number.parseInt(fromRaw, 10)
        : null;

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      let closed = false;
      const writeFrame = (frame: Parameters<typeof formatSseFrame>[0]): void => {
        if (closed) return;
        try {
          reply.raw.write(formatSseFrame(frame));
        } catch {
          closed = true;
        }
      };
      const endStream = (): void => {
        if (closed) return;
        closed = true;
        try {
          reply.raw.end();
        } catch {
          /* 已断开 */
        }
      };

      // worker 未启动过的任务（如服务重启）：内存无缓冲 → 按 DB 状态合成帧
      const haveHistory = bus.lastEventId(id) > 0;
      if (!haveHistory && TERMINAL.has(task.status)) {
        writeFrame({ id: 1, event: 'progress', data: { task_id: id, progress: task.progress, stage: task.stage } });
        if (task.status === 'done') {
          writeFrame({
            id: 2,
            event: 'done',
            data: {
              task_id: id,
              status: 'done',
              elapsed_ms: Math.max(0, (task.finished_at ?? task.created_at) - task.created_at),
            },
          });
        } else if (task.status === 'cancelled') {
          writeFrame({ id: 2, event: 'done', data: { task_id: id, status: 'cancelled', elapsed_ms: 0 } });
        } else {
          writeFrame({
            id: 2,
            event: 'failed',
            data: { task_id: id, error: task.error ?? '任务失败', code: 'E_INTERNAL' },
          });
        }
        endStream();
        return reply;
      }

      // ★ 先订阅再发请求（坑 14）：subscribe 内部已保证"先注册订阅者再重放缓冲"
      const unsubscribe = bus.subscribe(id, {
        fromId,
        keepaliveMs: cfg.sseKeepaliveMs,
        onFrame: writeFrame,
        onClose: endStream,
      });

      // 任务已在 DB 里终结、但 bus 里没终结（进程重启）→ 补一个结束帧
      if (TERMINAL.has(task.status) && !bus.isFinished(id)) {
        bus.publish(id, task.status === 'failed' ? 'failed' : 'done', {
          task_id: id,
          status: task.status,
          ...(task.status === 'failed' ? { error: task.error ?? '任务失败', code: 'E_INTERNAL' } : { elapsed_ms: 0 }),
        });
        bus.finish(id);
      }

      let ping: NodeJS.Timeout | undefined = setInterval(() => {
        if (closed) return;
        try {
          reply.raw.write(': ping\n\n');
        } catch {
          closed = true;
        }
      }, 30_000);
      ping.unref?.();

      const cleanup = (): void => {
        if (ping) {
          clearInterval(ping);
          ping = undefined;
        }
        unsubscribe();
      };
      req.raw.on('close', cleanup);
      req.raw.on('error', cleanup);

      return reply;
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
