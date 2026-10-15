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
import { auditRenderFormat, type RenderAudit } from '../agent/prompts.ts';
import { checkSessionOwner } from '../store/chat-session-owner.ts';
import { safeJsonStringify } from '../tasks/bus.ts';

interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

/**
 * ★ 对话模式的**服务端校验**（Lead 裁定）。
 *
 * ## 为什么模式必须在**建连接时**就定下来（而不是只在 prompt 帧里）
 * `tools` 只能在建会话时确定（pi 的会话把 mode 编进会话 key：`<sessionId>#agent`）。
 * 所以模式从 **URL 查询参数** `?mode=` 读；prompt 帧里的 `mode` 只做**一致性校验**。
 *
 * ## 规则（唯一一条）
 * - 缺省 / `'chat'` → `chat`（无工具）
 * - `'agent'` → `agent`（只读知识库工具；**危险工具仍被 agent 层剔除**）
 * - **其它任何值 → 明确报错**（`E_BADREQUEST`），**绝不静默降级**：
 *   静默降级会让前端显示 agent 却拿不到工具 —— 正是"看起来成功"那类坑。
 */
export const CHAT_MODES = ['chat', 'agent'] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

/**
 * ★ `agent` 模式允许的角色（**服务端权威**，与 `/capabilities.chat_modes.allowed_roles.agent` 同源）。
 *
 * Lead 裁定（2026-10-15）：**含 `student`** —— 答疑的主体是学生，不给学生开等于功能对主要场景无效；
 * `kb_search`/`kb_get` 是**只读**、按 `userId` 过滤、无主机工具、无 SQL 执行（与 `bash` 风险画像完全不同）。
 * 且它是**安全的正向收益**：给模型一个受控出口读原文，比"想读却没工具 → tool 调用退化成正文乱码"更好。
 */
export const AGENT_ALLOWED_ROLES = ['admin', 'teacher', 'student'] as const;

export function canUseAgentMode(roles: string[] | undefined | null): boolean {
  if (!Array.isArray(roles)) return false;
  return roles.some((r) => (AGENT_ALLOWED_ROLES as readonly string[]).includes(r));
}

/**
 * ★ **助手入口**（决定用哪套系统提示词）—— 服务端校验，与 `mode` 同样**不静默降级**。
 *
 * - `chat`（默认）：通用助教提示词（`CHAT_ASSISTANT_SYSTEM_PROMPT`）
 * - `video`：视频助手提示词（`VIDEO_ASSISTANT_SYSTEM_PROMPT`，按视频文稿回答）
 *
 * 为什么放在**连接参数**（`?assistant=`）而不是 prompt 帧：`systemPrompt` 是**管理器级**的
 * （`AgentSessionManager.getOrCreate` 不接受按会话的 systemPrompt）→ 必须在建会话时定。
 */
export const ASSISTANTS = ['chat', 'video'] as const;
export type Assistant = (typeof ASSISTANTS)[number];

export function validateAssistant(raw: unknown): { ok: true; assistant: Assistant } | { ok: false; got: unknown } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, assistant: 'chat' };
  if (typeof raw === 'string' && (ASSISTANTS as readonly string[]).includes(raw)) {
    return { ok: true, assistant: raw as Assistant };
  }
  return { ok: false, got: raw };
}

export function validateMode(raw: unknown): { ok: true; mode: ChatMode } | { ok: false; got: unknown } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, mode: 'chat' };
  if (typeof raw === 'string' && (CHAT_MODES as readonly string[]).includes(raw)) {
    return { ok: true, mode: raw as ChatMode };
  }
  return { ok: false, got: raw };
}

/**
 * 校验**帧里**的 `mode`（若带）：返回 `null` = 通过；否则返回要下发的 error 帧。
 *
 * 只对 `prompt` 帧生效（其它帧不带 mode）。**解析失败不算 mode 问题** ——
 * 非法 JSON 交给 agent 层按它自己的协议错误处理（不越权替它判）。
 */
export function checkFrameMode(payload: string, sessionMode: ChatMode): Record<string, unknown> | null {
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!frame || typeof frame !== 'object' || frame.type !== 'prompt' || !('mode' in frame)) return null;
  const check = validateMode(frame.mode);
  if (!check.ok) {
    return {
      type: 'error',
      code: 'E_BADREQUEST',
      msg: `未知的对话模式：${JSON.stringify(check.got)}`,
      hint: `mode 只接受 ${CHAT_MODES.map((m) => `'${m}'`).join(' | ')}`,
    };
  }
  if (check.mode !== sessionMode) {
    return {
      type: 'error',
      code: 'E_BADREQUEST',
      msg: `模式不一致：本连接是 '${sessionMode}'，帧里是 '${check.mode}'`,
      hint:
        '模式是**会话级**的（agent 模式的工具集在建会话时就确定了，切模式会丢上下文），' +
        `请用 ?mode=${check.mode} 重新连接`,
    };
  }
  return null;
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

    /**
     * ★★ **会话归属闸门（IDOR 修复）** —— 必须在**任何**会话读写之前。
     *
     * ## 缺陷（修复前）
     * 这里只校验了"**已登录**"，**没有校验"这个 sessionId 属于你"**；而 pi 转录文件在共享目录
     * `data/chat/` 按 `<ISO>_<sessionId>.jsonl` 找 ⟹ 用户 A 知道/猜到 B 的 sessionId
     * 就能**读 B 的历史、以 B 的身份继续对话**（B 的知识库可见性、B 的笔记都会生效）。
     *
     * ## 规则（见 `store/chat-session-owner.ts`，fail-closed）
     * 归属行（`conversations` 表）匹配 → 放行；不匹配 → 拒绝；
     * **无归属行但有转录文件** → 拒绝（遗留会话归属不明，宁可失效也不跨用户放行）。
     *
     * ## 为什么拒绝理由只有一句
     * "不存在"与"不属于你"**逐字相同** → 攻击者无法用"id 是否存在"枚举空间。
     */
    if (!user) {
      // 理论上不可达（401 闸门在前）；真到了也**不许**放行
      try {
        socket.send(safeJsonStringify({ type: 'error', code: 'E_UNAUTHORIZED', msg: '未登录' }));
        socket.close(1008, 'unauthorized');
      } catch {
        /* 已断开 */
      }
      return;
    }
    const ownerCheck = checkSessionOwner({
      repo: deps.repo,
      root: deps.cfg.root,
      sessionId,
      userId: user.id,
    });
    if (!ownerCheck.ok) {
      try {
        // ★ 只发**统一**理由（不区分"不存在"/"别人的"）
        socket.send(
          safeJsonStringify({
            type: 'error',
            code: 'E_FORBIDDEN',
            msg: ownerCheck.reason,
            hint: '聊天会话必须由你自己的账号创建：先 POST /api/v1/conversations 取得 id，再用该 id 连接。',
          }),
        );
        socket.close(1008, 'session not owned');
      } catch {
        /* 已断开 */
      }
      return;
    }
    if (ownerCheck.created) {
      // 首次连接 → 建立归属（审计留痕：谁认领了哪个会话）
      try {
        deps.repo.rbac.audit({
          userId: user.id,
          action: 'chat_session_claim',
          target: sessionId,
          detail: { via: 'ws-handshake' },
        });
      } catch {
        /* 审计失败不影响连接 */
      }
    }

    // ★ 模式：从查询参数读（建连接时就要定，见 `validateMode` 注释）
    const modeRaw = (req.query as Record<string, unknown> | undefined)?.mode;
    const modeCheck = validateMode(modeRaw);
    if (!modeCheck.ok) {
      // **明确报错**（不静默降级成 chat）：前端能立刻看到"你传的 mode 不合法"
      try {
        socket.send(
          safeJsonStringify({
            type: 'error',
            code: 'E_BADREQUEST',
            msg: `未知的对话模式：${JSON.stringify(modeCheck.got)}`,
            hint: `mode 只接受 ${CHAT_MODES.map((m) => `'${m}'`).join(' | ')}；缺省 = 'chat'。` +
              '注意模式是**会话级**的（工具在建会话时确定），请用 ?mode=… 重连',
          }),
        );
        socket.close(1008, 'invalid mode');
      } catch {
        /* 已断开 */
      }
      return;
    }
    const mode = modeCheck.mode;

    // ★ 助手入口（决定系统提示词）：`?assistant=video` → 视频提示词；未知值 → **明确报错**
    const assistantRaw = (req.query as Record<string, unknown> | undefined)?.assistant;
    const assistantCheck = validateAssistant(assistantRaw);
    if (!assistantCheck.ok) {
      try {
        socket.send(
          safeJsonStringify({
            type: 'error',
            code: 'E_BADREQUEST',
            msg: `未知的助手入口：${JSON.stringify(assistantCheck.got)}`,
            hint: `assistant 只接受 ${ASSISTANTS.map((a) => `'${a}'`).join(' | ')}；缺省 = 'chat'。` +
              '（它决定用哪套系统提示词，是**会话级**的：请用 ?assistant=… 重连）',
          }),
        );
        socket.close(1008, 'invalid assistant');
      } catch {
        /* 已断开 */
      }
      return;
    }
    const assistant = assistantCheck.assistant;

    // ★ 角色策略：`agent` 模式需要允许的角色（**服务端判定**，客户端无法影响）
    if (mode === 'agent' && !canUseAgentMode(user?.roles)) {
      try {
        socket.send(
          safeJsonStringify({
            type: 'error',
            code: 'E_FORBIDDEN',
            msg: `当前角色不允许 agent 模式（roles=${JSON.stringify(user?.roles ?? [])}）`,
            hint: `agent 模式允许的角色：${AGENT_ALLOWED_ROLES.join(', ')}；chat 模式对所有登录用户开放`,
          }),
        );
        socket.close(1008, 'agent mode forbidden');
      } catch {
        /* 已断开 */
      }
      return;
    }

    let chat: ChatConnectionLike | null = null;
    let closed = false;
    /** 本轮渲染契约审计结果（`settled` 时由 `send` 填充；见 `auditRenderFormat`） */
    let renderAudit: RenderAudit | null = null;

    /**
     * ★ 早到的客户端帧必须**缓冲**，不能丢。
     *
     * 原实现的真 bug（polysemy-prober 看到的"180s 零帧"就是它 + 模型未绑定叠加）：
     * `socket.on('message', …)` 在 `await deps.chatFactory(...)` **之后**才注册，而建连接要
     * ~2.7s（解析模型、开 pi 会话）。浏览器习惯在 `onopen` 后**立刻**发 prompt →
     * 那些帧到达时**还没有监听器** → 被 EventEmitter 直接丢弃 → 客户端只看到 `ready`，之后永远沉默。
     *
     * 所以：监听器**立刻**注册，连接就绪前把帧排队，就绪后按序回放。
     */
    const earlyFrames: string[] = [];
    const toPayload = (raw: unknown): string =>
      typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : String(raw);

    socket.on('message', (raw: unknown) => {
      const payload = toPayload(raw);
      /**
       * ★ 帧级 `mode` 校验（服务端权威）：
       * - 未知值 → 明确报错（不静默降级）
       * - 与本连接的模式**不一致** → 明确报错并提示"模式是会话级的，请用 ?mode=… 重连"
       *   （否则会出现"前端以为切到 agent，实际还是 chat 的 tools"这种**看起来成功**的假象）
       */
      const modeIssue = checkFrameMode(payload, mode);
      if (modeIssue) {
        try {
          socket.send(safeJsonStringify(modeIssue));
        } catch {
          /* 已断开 */
        }
        return; // **不转发**给 agent 层（避免它按错误的模式继续跑）
      }
      if (!chat) {
        earlyFrames.push(payload); // 连接还没建好 → 排队（**不丢**）
        return;
      }
      void chat.handleClientMessage(payload).catch((err: unknown) => {
        const msg = redact(err instanceof Error ? err.message : String(err));
        try {
          socket.send(safeJsonStringify({ type: 'error', code: 'E_INTERNAL', msg }));
        } catch {
          /* 已断开 */
        }
      });
    });

    try {
      /**
       * ★ 累积本轮回答文本，供**渲染契约**事后审计（`auditRenderFormat`）。
       *
       * 为什么在路由层做：`onAnswerAudit` 只给引用/检索状态，**没有正文**；
       * 而正文只经过 `send` 这一处（`text_delta`）。这里累积 → `settled` 时审计 → 写进 audit_log，
       * 于是"模型没按契约输出"**能被观测到**（不靠人眼看）。
       */
      let roundText = '';
      chat = await deps.chatFactory!({
        sessionId,
        // ★ 助手入口 → 工厂据此选**视频/通用**提示词的管理器（见 index.ts 的两个管理器）
        assistant,
        send: (frame) => {
          if (closed) return;
          try {
            const f = frame as { type?: unknown; delta?: unknown };
            if (f?.type === 'text_delta' && typeof f.delta === 'string') roundText += f.delta;
            if (f?.type === 'settled') {
              // 审计是**只上报**（不改回答）：违规也照常返回给前端，只是留痕
              renderAudit = auditRenderFormat(roundText);
            }
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
        /**
         * ★★ **仅 admin 可给 agent 工具**（`read`/`bash`/`edit`/`write`）—— 安全边界，不是体验选项。
         *
         * ## 为什么（polysemy-prober live 复现的 critical）
         * 原先 `tools_source` 报 `"none"`（代码以为关了工具），但 pi 实际用了**默认全集**：
         * 学生连上后 `ready.tools = ["read","bash","edit","write"]` → 直接拿到服务器 **shell**：
         * - **绕过整个 RBAC**（`RBAC.md §1` 的学生能力里没有"在服务器执行命令"）
         * - **绕过 SQL 沙箱**：我们辛苦做的禁 ATTACH/多语句、独立库、路径限制、硬超时、跨学生隔离，
         *   全都可以用 `bash` 跑 `sqlite3` CLI 从旁边绕过去
         * - 还能读服务器任意文件（实测读到了 `C:\Windows\win.ini`）
         *
         * ## 判定规则（**服务端权威**）
         * `roles` 来自 `req.user`（会话令牌解出的身份），**绝不从客户端帧里读** ——
         * 与"不许客户端传检索 context 文本"同一条原则（那类伪造我们已修过一次）。
         * `teacher`/`student` → `false`；`admin` → `true`（管理员本来就有服务器权限，工具不扩大其权力）。
         */
        allowTools: Array.isArray(user?.roles) && user.roles.includes('admin'),
        /**
         * ★ **对话模式**（Lead 裁定）：`chat`（默认，无工具）/ `agent`（只读知识库工具）。
         *
         * ## 一条规则（清楚到能背）
         * `mode === 'agent'` **且** 角色允许 → 只读知识库工具（`kb_search`/`kb_get`）；否则 `[]`。
         * - **危险工具永远剔除**（`read`/`bash`/`edit`/`write` 由 agent 层 `sanitizeToolList` 处理）——
         *   `agent` 模式**不等于**放开主机工具，安全边界不松。
         * - 非法 `mode` → **明确报错**（见 `validateMode`），**不静默降级**：
         *   "静默降级成 chat"会让前端显示 agent 却拿不到工具，正是"看起来成功"那类坑。
         */
        mode: mode ?? 'chat',
        // ★ 只读知识库查询（**已按 userId 过滤可见性**）—— agent 模式的工具用它
        kb: deps.kb ?? null,
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
                // ★ 渲染契约审计（`agent/prompts.ts::auditRenderFormat`）——
                //   **客观判据**：模型有没有按契约输出（`$...$` 而非 `\(...\)`、代码块带语言且闭合…）。
                //   只上报、不改回答：违规也照常返回前端，但**能被观测到**（否则只能靠人眼看）。
                ...(renderAudit
                  ? {
                      render_format_ok: renderAudit.ok,
                      render_violations: renderAudit.violations.slice(0, 10),
                      render_observed: renderAudit.observed,
                    }
                  : { render_format_ok: null, render_audit_note: '本轮无正文（无 text_delta）→ 未审计' }),
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

    // ★ 回放连接就绪前收到的帧（见上方 `earlyFrames` 注释）
    for (const payload of earlyFrames.splice(0)) {
      void chat.handleClientMessage(payload).catch((err: unknown) => {
        const msg = redact(err instanceof Error ? err.message : String(err));
        try {
          socket.send(safeJsonStringify({ type: 'error', code: 'E_INTERNAL', msg }));
        } catch {
          /* 已断开 */
        }
      });
    }

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
