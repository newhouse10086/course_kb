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

    let chat: ChatConnectionLike | null = null;
    let closed = false;

    try {
      chat = await deps.chatFactory!({
        sessionId,
        send: (frame) => {
          if (closed) return;
          try {
            socket.send(JSON.stringify(frame));
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
