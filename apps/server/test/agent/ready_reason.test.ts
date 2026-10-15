/**
 * ★ `ready.reason` —— 前端"该不该清空消息列表"的**明确依据**（lead 裁定）。
 *
 * 真事故形状（用户反馈"聊了几轮只剩最新一条"）：
 * **看起来像"没做历史"，真因是"历史被清了"** —— 若前端"见 ready 就清空"，
 * 那么 `get_state`（页面聚焦/重连复查）与 `set_model` 都会把列表清掉。
 *
 * 判据（本文件钉住）：
 * - **唯一该清空**的是 `new_session`；`mode_change` 换了上下文也该清
 * - `connect` / `set_model` / `get_state` **都不该清空**（并集必须覆盖全部重发点）
 * - 每个重发点都要**带上自己的 reason**（不许有 ready 缺 reason —— 缺了前端只能靠猜）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChatConnection, type AgentFrame, type ChatSessionLike, type ReadyFrame } from '../../src/agent/stream.ts';

class Session implements ChatSessionLike {
  readonly id: string;
  isRunning = false;
  constructor(id = 's') {
    this.id = id;
  }
  subscribe(): () => void {
    return () => {};
  }
  async prompt() {
    return { disposition: 'started', aborted: false, syntheticSettled: false };
  }
  async abort(): Promise<void> {}
  /** ★ 必须有 `setModel`：否则会走到"SDK 路径不支持 set_model"的错误分支（不发 ready） */
  async setModel(_ref: string): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }
  async reset(): Promise<ReadyFrame> {
    return this.readyFrame();
  }
  readyFrame(): ReadyFrame {
    return {
      type: 'ready', session_id: this.id, model: null, tools: [], tools_source: 'explicit', version: null,
      mode: 'sdk', persistence: 'ephemeral', persistence_reason: 't', session_file: null,
      pi_session_id: null, thinking_level: null, restarted: false,
    };
  }
}

function manager() {
  const byId = new Map<string, Session>();
  return {
    async getOrCreate(id: string) {
      let s = byId.get(id);
      if (!s) {
        s = new Session(id);
        byId.set(id, s);
      }
      return s;
    },
    release: () => {},
  };
}

test('★★ 五个重发点各自带上正确的 reason（唯一该清空的是 new_session / mode_change）', async () => {
  const frames: AgentFrame[] = [];
  const conn = await createChatConnection({
    sessionId: 'ready-reason-1',
    send: (f) => {
      frames.push(f);
    },
    manager: manager() as never,
    user: { id: 'u1', roles: ['student'] },
    kb: { search: async () => [], get: async () => null },
  });

  const readies = (): ReadyFrame[] => frames.filter((f) => f.type === 'ready') as ReadyFrame[];
  assert.equal(readies().length, 1);
  assert.equal(readies()[0]!.reason, 'connect', '首个 ready 必须是 connect（**不清空**）');

  await conn.handleClientMessage(JSON.stringify({ type: 'get_state' }));
  assert.equal(readies().at(-1)!.reason, 'get_state', '状态刷新必须能区分（**不清空**）');

  await conn.handleClientMessage(JSON.stringify({ type: 'set_model', model: 'whatever/model' }));
  assert.equal(readies().at(-1)!.reason, 'set_model', '切模型**不清空**');

  await conn.handleClientMessage(JSON.stringify({ type: 'prompt', message: 'x', mode: 'agent' }));
  assert.equal(readies().at(-1)!.reason, 'mode_change', '切模式换了上下文 → 该清空');
  assert.equal(readies().at(-1)!.agent_mode, 'agent');

  await conn.handleClientMessage(JSON.stringify({ type: 'new_session' }));
  assert.equal(readies().at(-1)!.reason, 'new_session', '★ 唯一"真·新会话"（该清空）');

  // 全覆盖：任何 ready 都必须带 reason（缺了前端只能猜 —— 那正是这次 bug 的来源）
  for (const [i, r] of readies().entries()) {
    // ⚠️ 用 `as { reason?: unknown }` 而非直接比较：`ReadyReason` 是封闭 union，
    //    `!== ''` 会被 TS 判成"无重叠比较"（TS2367）
    assert.ok(typeof (r as { reason?: unknown }).reason === 'string', `第 ${i + 1} 个 ready 缺 reason`);
  }
  await conn.close();
});

test('★ 清空判据表（文档化，供前端直接抄）', () => {
  const CLEAR_ON: Record<string, boolean> = {
    connect: false,
    new_session: true,
    mode_change: true,
    set_model: false,
    get_state: false,
  };
  assert.deepEqual(Object.keys(CLEAR_ON).sort(), ['connect', 'get_state', 'mode_change', 'new_session', 'set_model']);
  assert.equal(CLEAR_ON.new_session, true);
  assert.equal(CLEAR_ON.get_state, false, '★ 页面聚焦/重连复查走这条 —— 清空它就是"聊了几轮只剩一条"');
});
