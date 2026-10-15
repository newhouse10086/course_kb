/**
 * ★★ **聊天会话归属闸门**（IDOR 修复）。
 *
 * ## 缺陷（Lead 读码确认 + 我核实）
 * `routes/chat.ts` 的 WS 握手只校验"**已登录**"（401 闸门），**没有校验"这个 sessionId 属于你"**。
 * 而 pi 的转录文件在**共享目录** `data/chat/` 里按 `<ISO>_<sessionId>.jsonl` 找（`findSessionFile`）。
 * ⟹ **用户 A 只要知道/猜到 B 的 sessionId，就能连上 B 的会话**：读 B 的历史、以 B 的身份继续对话
 * （B 的知识库可见性、B 的笔记都会生效）—— 标准 **IDOR**。
 *
 * ## 真相源：**`conversations` 表**（已存在，本来就是 user 维度的聊天会话表）
 * ```sql
 * conversations(id, user_id NOT NULL REFERENCES users(id) ON DELETE CASCADE, doc_id, title, created_at)
 * ```
 * `rbac-repo.ts` 的注释原话："把 notes/conversations 放在这里，并让**每个方法的第一个参数都是 userId**"。
 * ⚠️ **不用 `sessions` 表**（那是 **auth 登录令牌**：`id,user_id,expires_at,user_agent` —— 语义不同）。
 *
 * ## 规则（**fail-closed**）
 * ```
 * 有行 且 user_id === 我  → 放行
 * 有行 且 user_id !== 我  → 拒绝（理由与"不存在"**逐字相同**）
 * 无行（**不存在** 或 **别人的**）→ ★ **同一句拒绝**（不区分 → 无存在性预言机）
 * ```
 * ## ★★ 为什么**不做"首次连接即认领"**（原实现有，已撤掉 —— 独立验收 `polysemy-prober` 抓出）
 * 原实现"无归属行 + 无转录 → 认领"看似方便，但带来两个真问题（**已实测复现**）：
 * 1. **存在性预言机**：`别人的 id → E_FORBIDDEN`，而 `不存在的 id → ready` ⟹
 *    攻击者"连一下看回什么"就能**枚举出哪些 id 存在** —— 与"拒绝理由必须不可区分"**直接互斥**。
 * 2. **抢注**：① 攻击者先连一个**已知/预定**的 id → 认领成功；② 合法用户再连 → **被锁在外面**。
 *    （`crypto.randomUUID()` 让盲猜不可行，但"**知道 id**"的场景 —— URL 分享/日志/历史 —— 仍成立；
 *     且 WS 握手**没有速率限制**，实测枚举 20 个 id / 1.5s。）
 * ⟹ **只接受服务端登记过的会话**：前端先 `POST /api/v1/conversations` 拿 id，再用该 id 连 WS。
 * 这同时是**会话列表/跨设备历史**的前提（没登记就无法按用户列出）。
 *
 * ## ⚠️ 已知代价（**提交信息里必须写明**）
 * 1. 现存会话文件（修复前创建）**没有归属行** → **全部不可访问**（fail-closed，宁可不给）。
 * 2. ★ **前端必须改为"先登记再连接"**（旧流程是 `crypto.randomUUID()` 自造 id 直连）——
 *    否则**所有用户都连不上**。改动见 `routes/chat.ts` 的 hint（`web-ui` 写域）。
 *
 * ## ⚠️ 不要因为"前端改用 UUID"就放松校验
 * `Math.random()` 不是 CSPRNG（可预测）→ 曾把 IDOR 从"要知道 id"降级成"可以猜到"。
 * 即使前端改成 `crypto.randomUUID()`，**归属校验仍是唯一防线**（服务端不假设 id 可信）。
 *
 * ## 断言见 `test/chat_session_owner.test.ts`（跨用户必须失败，且与"不存在"同表现）
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import type { Repo } from './repo.ts';

export interface OwnerCheckOk {
  ok: true;
  /** 是否本次新建了归属行（前端首次用该会话） */
  created: boolean;
}

export interface OwnerCheckFail {
  ok: false;
  /** ★ 对外**唯一**的拒绝理由（"不存在"与"不属于你"共用，避免泄漏存在性） */
  reason: string;
}

export type OwnerCheck = OwnerCheckOk | OwnerCheckFail;

/**
 * 对外统一的拒绝理由 —— **"不存在"与"不属于你"必须逐字相同**。
 *
 * 为什么：若两者可区分，攻击者就能用"这个 id 存不存在"把空间枚举出来
 * （先确认 id 存在，再去猜/钓内容）。安全上"不可区分"比"提示友好"重要。
 */
export const SESSION_DENIED_REASON = '会话不存在或无权访问（会话归属校验失败）';

/** 聊天转录目录（与 `AgentSessionManager` 的默认 `sessionDir` 一致：`<root>/data/chat`）。 */
export function chatTranscriptDir(root: string): string {
  return path.join(root, 'data', 'chat');
}

/**
 * 该会话是否已有 pi 转录文件 —— ⚠️ **现在只是诊断用，不是判定依据**。
 *
 * 历史：方案 A 之前它参与过"无归属行 + 有历史 → 拒绝认领"的加固判定；
 * 但**方案 A 已取消认领**（`!row` 一律拒绝）⟹ 这条探测**不再影响任何放行决定**。
 * 保留它是为了排障时能回答"这个 id 在盘上有没有历史"（例如解释"为什么旧会话连不上"）。
 */
export function transcriptExists(root: string, sessionId: string): boolean {
  const dir = chatTranscriptDir(root);
  if (!existsSync(dir)) return false;
  // pi 命名 `<ISO>_<sessionId>.jsonl`；只做"存在性"探测（**不做放行依据** —— 放行只看归属行）
  try {
    return readdirSync(dir).some((f) => f.endsWith(`_${sessionId}.jsonl`));
  } catch {
    return false;
  }
}

/**
 * ★ **唯一的归属判定入口**（WS 握手与 HTTP 历史接口共用 —— 防两套真相源漂移）。
 *
 * @param opts.repo      仓库（`conversations` 是唯一真相源）
 * @param opts.root      项目根（仅用于诊断探测 `data/chat/` 是否有转录，**不影响放行判定**）
 * @param opts.sessionId 客户端提交的会话 id —— ★ **必须已由 `POST /api/v1/conversations` 登记且属于调用者**；
 *                       未登记（含不存在、含别人的）**一律拒绝**（**已撤掉自动认领** —— 独立验收
 *                       `polysemy-prober` 抓出"认领"会带来**存在性预言机**与**抢注**，见文件头说明）
 * @param opts.userId    服务端解出的身份（**绝不来自客户端帧**）
 */
export function checkSessionOwner(opts: {
  repo: Repo;
  root: string;
  sessionId: string;
  userId: string;
}): OwnerCheck {
  const row = opts.repo.rbac.getConversationUnscoped(opts.sessionId);
  // ★ **无归属行 = 拒绝**（不存在与别人的**同一句话** → 无存在性预言机；也不给别人"抢注"的机会）
  if (!row) return { ok: false, reason: SESSION_DENIED_REASON };
  if (row.user_id !== opts.userId) return { ok: false, reason: SESSION_DENIED_REASON };
  return { ok: true, created: false };
}
