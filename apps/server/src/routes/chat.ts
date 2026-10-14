/**
 * 聊天 WebSocket 路由（契约 §7.2）—— **路由是我的，协议是 T-AGENT 的**。
 *
 * 分工（与 pi-bridge 约定）：
 * - `src/agent/stream.ts` 导出 `createChatConnection(opts)`（传输无关）
 * - 本文件只做「WS 连接 ↔ 连接对象」的桥接：`send` 接 `ws.send`，`onClose` 接 `ws.close`
 *
 * ⚠️ `pi.available=false` 时 `createChatConnection` **不抛**，而是发一帧
 * `error{E_PI_UNAVAILABLE, reason, hint}` 并请求关闭 —— 符合契约的诚实降级。
 */

import type { FastifyInstance } from 'fastify';

import type { AppDeps, ChatConnectionLike } from '../app-deps.ts';
import { redact } from '../config.ts';
import { safeJsonStringify } from '../tasks/bus.ts';

interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

/**
 * 注册 `/api/v1/chat/:sessionId`。
 * 返回 false = agent 模块未就绪（调用方据此在 `/capabilities` 里如实说明）。
 */
export function registerChatRoute(app: FastifyInstance, deps: AppDeps): boolean {
  if (!deps.chatFactory) return false;

  app.get('/api/v1/chat/:sessionId', { websocket: true }, async (conn, req) => {
    // ⚠️ `@fastify/websocket` v11 的第一个参数**就是 WebSocket 本身**
    //    （v8 及更早是 `SocketStream`，即 `{ socket }`）。
    //    原错误写法：只写 `(conn as {socket}).socket` → v11 下拿到 undefined，
    //    `socket.send/on/close` 全 TypeError → 连接异常断开（客户端看到 1006）。
    //    这里两种形状都收，避免将来升级/降级再踩。
    const socket = ((conn as { socket?: WsLike }).socket ?? conn) as WsLike;
    const { sessionId } = req.params as { sessionId: string };
    // RBAC：WS 握手同样过 401 闸门 → 这里 req.user 必然存在（未登录根本连不上）
    const user = req.user;

    let chat: ChatConnectionLike | null = null;
    let closed = false;

    try {
      chat = await deps.chatFactory!({
        sessionId,
        send: (frame) => {
          if (closed) return;
          try {
            // ⚠️ WS 帧**有长度前缀**，本不会像 SSE 那样被 U+2028/U+2029 错切 ——
            //    这里统一走 `safeJsonStringify` 是为了**不依赖协议特性**：
            //    全仓的 JSON→线协议出口（任务 SSE / 沙箱答疑 SSE / 聊天 WS）都用同一个函数，
            //    哪天有人把这段改成 SSE、写日志或转发，就不会悄悄退化成"单行保证被打破"。
            //    （坑 17：`JSON.stringify` 不转义 U+2028/U+2029，Node 24 实测。）
            socket.send(safeJsonStringify(frame));
          } catch {
            closed = true;
          }
        },
        onClose: (code, reason) => {
          if (closed) return;
          closed = true;
          try {
            socket.close(code, reason);
          } catch {
            /* 已断开 */
          }
        },
        // ★ 检索：钩子（可为 null，未接入时 agent 按 none 走）+ **服务端身份**
        //   客户端只能传模式名（`retrieval`），不许传 context 文本 —— pi-bridge 已在帧层拒绝
        retrieval: deps.retrieval ?? null,
        user: user ? { id: user.id, roles: user.roles } : null,
        // 每轮回答的审计（教学场景留痕）：三档引用校验 + 检索状态
        onAnswerAudit: (a) => {
          try {
            deps.repo.rbac.audit({
              userId: user?.id ?? null,
              action: 'chat',
              target: sessionId,
              detail: {
                round: a.round,
                citation_mode: a.mode,
                citations: a.citations.slice(0, 20),
                unknown_citations: a.unknown.slice(0, 20),
                context_provided: a.contextProvided,
                retrieval_mode: a.retrievalMode,
                retrieval_status: a.retrievalStatus,
                retrieval_reason: a.retrievalReason,
              },
            });
          } catch {
            /* 审计失败不许影响对话 */
          }
        },
      });
    } catch (err) {
      // factory 承诺不抛；真抛了也要如实告诉前端（不能让用户看到"空回复"）
      const msg = redact(err instanceof Error ? err.message : String(err));
      try {
        socket.send(JSON.stringify({ type: 'error', code: 'E_PI_UNAVAILABLE', msg, hint: 'agent 模块初始化失败' }));
        socket.close(1011, 'agent init failed');
      } catch {
        /* 已断开 */
      }
      return;
    }

    socket.on('message', (raw: unknown) => {
      if (!chat) return;
      const payload =
        typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw : raw instanceof Uint8Array ? raw : String(raw);
      void chat.handleClientMessage(payload).catch((err: unknown) => {
        const msg = redact(err instanceof Error ? err.message : String(err));
        try {
          socket.send(JSON.stringify({ type: 'error', code: 'E_INTERNAL', msg }));
        } catch {
          /* 已断开 */
        }
      });
    });

    socket.on('close', () => {
      closed = true;
      if (chat) void chat.close().catch(() => undefined);
    });
    socket.on('error', () => {
      closed = true;
      if (chat) void chat.close().catch(() => undefined);
    });
  });

  return true;
}
