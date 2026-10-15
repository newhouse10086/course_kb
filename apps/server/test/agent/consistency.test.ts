/**
 * ★ 坑 21 的同源断言：**自述字段必须与生效值一致**（两个方向都查）。
 *
 * 实证（同一个 bug 的两个方向，都是真事故）：
 * - `tools_source:'none'` 而 `ready.tools` 有 4 个危险工具 → **说关了其实开着**（学生能执行 shell）
 * - `tools_source:'kb-readonly'` 而 `tools:[]` → **说开了其实关着**（模型："我没有这两个工具"）
 *
 * 所以：**`ready.tools`（生效值）是唯一真相**，`tools_source` 只是标签 —— 二者必须同源。
 * 本文件把这条判据固化成断言（含"反向"：工具非空时不许标成"已关闭"）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChatConnection, type AgentFrame, type ChatSessionLike, type ReadyFrame } from '../../src/agent/stream.ts';
import { KB_TOOL_NAMES } from '../../src/agent/kb_tools.ts';

/** 假会话：`activeTools` 模拟 pi 的 `getActiveToolNames()`（**生效值**） */
class Session implements ChatSessionLike {
  readonly id: string;
  isRunning = false;
  /** ⚠️ T1：Node strip-only TS 禁参数属性 → 显式声明再赋值 */
  protected activeTools: string[];
  constructor(id: string, activeTools: string[]) {
    this.id = id;
    this.activeTools = activeTools;
  }
  subscribe(_fn: (f: AgentFrame) => void): () => void {
    return () => {
      /* 默认不推帧 */
    };
  }
  async prompt() {
    return { disposition: 'started', aborted: false, syntheticSettled: false };
  }
  async abort(): Promise<void> {}
  async reset(): Promise<ReadyFrame> {
    return this.readyFrame();
  }
  readyFrame(): ReadyFrame {
    return {
      type: 'ready', session_id: this.id, model: null, tools: this.activeTools, tools_source: 'explicit', version: null,
      mode: 'sdk', persistence: 'ephemeral', persistence_reason: 't', session_file: null,
      pi_session_id: null, thinking_level: null, restarted: false,
    };
  }
}

const DANGEROUS = ['bash', 'read', 'edit', 'write'];

/** ★ 同源判据（对**任何** ready 帧都成立） */
export function assertToolsSourceConsistent(ready: ReadyFrame, where: string): void {
  const tools = ready.tools ?? [];
  // ⚠️ 显式放宽成 `string | undefined`：`ToolsSource` 是封闭 union（不含 `''`），
  //    直接写 `src !== ''` 会被 tsc 判为"无重叠的比较"（TS2367）。
  //    这里要防的是"**缺字段**"（`undefined`）—— 消费者会把 undefined 当假值（坑 21 同族）。
  const src: string | undefined = ready.tools_source as string | undefined;
  assert.ok(typeof src === 'string' && src !== '', `${where}: tools_source 必须恒有值（缺字段会被消费者当假值）`);
  if (src === 'disabled-by-role') {
    assert.deepEqual(tools, [], `${where}: 标了 disabled-by-role，生效值必须是空集（否则"说关了其实开着"）`);
  }
  if (src === 'kb-readonly') {
    for (const t of KB_TOOL_NAMES) {
      assert.ok(tools.includes(t), `${where}: 标了 kb-readonly，生效值必须含 ${t}（否则"说开了其实关着"）`);
    }
    assert.deepEqual(tools.filter((t) => DANGEROUS.includes(t)), [], `${where}: kb-readonly 绝不能带危险工具`);
  }
  if (src === 'dangerous-opt-in') {
    assert.ok(tools.length > 0, `${where}: 标了 dangerous-opt-in 就该真有工具（否则名不副实）`);
  }
  // 反向：工具非空时不许标成"已关闭"
  if (tools.length > 0) {
    assert.notEqual(src, 'disabled-by-role', `${where}: 有工具却标成 disabled-by-role（自述与生效值相反）`);
  }
}

function manager(sessionFor: (mode: string) => ChatSessionLike) {
  return {
    calls: [] as { id: string; tools?: string[] }[],
    async getOrCreate(id: string, init?: { tools?: string[] }) {
      this.calls.push({ id, ...(init?.tools ? { tools: init.tools } : {}) });
      return sessionFor(id.endsWith('.agent') ? 'agent' : 'chat');
    },
    release: () => {},
  };
}

test('★ 同源：chat（生效值 []）→ tools_source 必须是 disabled-by-role', async () => {
  const frames: AgentFrame[] = [];
  const m = manager(() => new Session('s', []));
  const conn = await createChatConnection({
    sessionId: 'ss-1',
    send: (f) => {
      frames.push(f);
    },
    manager: m as never,
    user: { id: 'u1' },
  });
  const ready = frames.find((f) => f.type === 'ready') as ReadyFrame;
  assertToolsSourceConsistent(ready, 'chat');
  await conn.close();
});

test('★★ 同源：agent（生效值含 kb 工具）→ tools_source 必须是 kb-readonly', async () => {
  const frames: AgentFrame[] = [];
  const m = manager((mode) => new Session('s', mode === 'agent' ? [...KB_TOOL_NAMES] : []));
  const conn = await createChatConnection({
    sessionId: 'ss-2',
    send: (f) => {
      frames.push(f);
    },
    manager: m as never,
    user: { id: 'u1' },
    kb: { search: async () => [], get: async () => null },
  });
  await conn.handleClientMessage(JSON.stringify({ type: 'prompt', message: 'x', mode: 'agent' }));
  const readies = frames.filter((f) => f.type === 'ready') as ReadyFrame[];
  assert.ok(readies.length >= 2, '切换模式必须重发 ready');
  for (const r of readies) assertToolsSourceConsistent(r, `agent ready(${r.agent_mode})`);
  const agentReady = readies.at(-1)!;
  assert.equal(agentReady.agent_mode, 'agent');
  assert.equal(agentReady.tools_source, 'kb-readonly');
  await conn.close();
});

test('★★★ 反向陷阱：生效值有工具、但策略算成"关闭" → 必须被断言抓出来（不许两者相反）', () => {
  const bad: ReadyFrame = {
    type: 'ready', session_id: 'x', model: null, tools: [...DANGEROUS], tools_source: 'disabled-by-role', version: null,
    mode: 'sdk', persistence: 'ephemeral', persistence_reason: 't', session_file: null,
    pi_session_id: null, thinking_level: null, restarted: false,
  };
  assert.throws(() => assertToolsSourceConsistent(bad, '反向陷阱'), /disabled-by-role/);

  const bad2: ReadyFrame = { ...bad, tools: [], tools_source: 'kb-readonly' };
  assert.throws(() => assertToolsSourceConsistent(bad2, '说开了其实关着'), /kb-readonly/);

  const bad3: ReadyFrame = { ...bad, tools: [...KB_TOOL_NAMES, 'bash'], tools_source: 'kb-readonly' };
  assert.throws(() => assertToolsSourceConsistent(bad3, 'kb 里混进危险工具'), /危险工具/);

  const bad4 = { ...bad, tools_source: '' } as unknown as ReadyFrame;
  assert.throws(() => assertToolsSourceConsistent(bad4, '缺字段'), /恒有值/);
});

test('★★ 回归：切换模式后**新会话的帧必须能到达客户端**（原错误：只订阅初始会话 → 静默丢帧）', async () => {
  // 这个假会话在 prompt 时往订阅者推帧，模拟真实 pi 的事件流
  class EmittingSession extends Session {
    private listeners = new Set<(f: AgentFrame) => void>();
    override subscribe(fn: (f: AgentFrame) => void): () => void {
      this.listeners.add(fn);
      return () => {
        this.listeners.delete(fn);
      };
    }
    override async prompt(): Promise<{ disposition: string; aborted: boolean; syntheticSettled: boolean }> {
      for (const l of [...this.listeners]) l({ type: 'text_delta', delta: '来自 agent 会话' });
      for (const l of [...this.listeners]) l({ type: 'settled', aborted: false });
      return { disposition: 'started', aborted: false, syntheticSettled: false };
    }
  }
  const frames: AgentFrame[] = [];
  const m = manager((mode) => new EmittingSession('s', mode === 'agent' ? [...KB_TOOL_NAMES] : []));
  const conn = await createChatConnection({
    sessionId: 'ss-3',
    send: (f) => {
      frames.push(f);
    },
    manager: m as never,
    user: { id: 'u1' },
    kb: { search: async () => [], get: async () => null },
  });
  await conn.handleClientMessage(JSON.stringify({ type: 'prompt', message: 'x', mode: 'agent' }));
  assert.ok(
    frames.some((f) => f.type === 'text_delta' && f.delta.includes('来自 agent 会话')),
    `切模式后必须仍能收到新会话的帧，实际帧：${frames.map((f) => f.type).join(',')}`,
  );
  assert.ok(frames.some((f) => f.type === 'settled'), 'settled 必须到达（否则前端一直等）');
  await conn.close();
});
