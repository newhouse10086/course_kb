/**
 * ★ `history` 帧（契约 §7.2 第 12 种）：连接建立时恢复当前会话的历史消息。
 *
 * 要点：
 * - 时机：`ready → history → …`（**同一条 WS**，顺序确定；lead 裁定"恢复是会话建立的一部分"）
 * - 只在 `resumed===true` 时发（新建会话没有历史）
 * - ★ 安全：**只含 user/assistant 文本**；`system`（含 `sections`/`systemPrompt`）**绝不下发**
 * - ★ 截断如实标注（不静默）
 * - ★ 映射函数**与 HTTP 历史接口共用**（`entriesToHistory` —— 只许一份实现）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChatConnection, AGENT_FRAME_TYPES, type AgentFrame, type ChatSessionLike, type HistoryFrame, type ReadyFrame } from '../../src/agent/stream.ts';
import { entriesToHistory, historyLeaksSystemPrompt, HISTORY_MAX_MESSAGES } from '../../src/agent/history.ts';

// ---------------------------------------------------------------------------
// 1. 共享映射函数（HTTP 与 WS 都走它）
// ---------------------------------------------------------------------------

const PI_ENTRIES = [
  { type: 'session', id: 'pi-1', timestamp: 1 },
  {
    type: 'message',
    timestamp: 1000,
    message: {
      role: 'system',
      content: [{ type: 'text', text: '你是 pi，一个 expert coding assistant…' }],
      // 真机上系统条目还带 sections（系统提示词正文）—— **绝不能出现在下发内容里**
      sections: [{ title: 'system', text: 'EXPERT SYSTEM PROMPT 11KB…' }],
      systemPrompt: 'EXPERT SYSTEM PROMPT 11KB…',
      timestamp: 1000,
    },
  },
  { type: 'message', timestamp: 2000, message: { role: 'user', content: [{ type: 'text', text: '聚簇索引和二级索引的区别？' }], timestamp: 2000 } },
  {
    type: 'message',
    timestamp: 3000,
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '（思考块不该下发）' },
        { type: 'text', text: '聚簇索引决定物理顺序 [[card:crd_0001]]。' },
      ],
      timestamp: 3000,
    },
  },
  { type: 'model_change', timestamp: 4000 },
];

test('★★ 映射：只取 user/assistant 文本，system 与 sections 一律剥离', () => {
  const h = entriesToHistory(PI_ENTRIES);
  assert.deepEqual(
    h.messages.map((m) => m.role),
    ['user', 'assistant'],
  );
  assert.match(h.messages[0]!.text, /聚簇索引和二级索引/);
  assert.match(h.messages[1]!.text, /\[\[card:crd_0001\]\]/);
  assert.equal(h.truncated, false);
  // ★ 关键安全断言：系统提示词与只给模型看的字段绝不出现在下发内容里
  assert.equal(historyLeaksSystemPrompt(h), false);
  const blob = JSON.stringify(h);
  for (const banned of ['expert coding assistant', 'EXPERT SYSTEM PROMPT', 'sections', 'systemPrompt', 'thinking']) {
    assert.ok(!blob.includes(banned), `历史里不该出现 ${banned}`);
  }
  // 时间戳来自条目/消息
  assert.deepEqual(h.messages.map((m) => m.ts), [2000, 3000]);
});

test('★ 映射：超长文本截断并**如实标注**', () => {
  const long = 'x'.repeat(50);
  const h = entriesToHistory([{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: long }] } }], { maxTextChars: 10 });
  assert.match(h.messages[0]!.text, /已截断/);
});

test('★ 映射：超过条数上限 → 只保留**最近**的，且 truncated=true', () => {
  const entries = Array.from({ length: HISTORY_MAX_MESSAGES + 5 }, (_, i) => ({
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text: `第 ${i} 条` }], timestamp: i },
  }));
  const h = entriesToHistory(entries);
  assert.equal(h.messages.length, HISTORY_MAX_MESSAGES);
  assert.equal(h.truncated, true, '截断必须如实标注');
  assert.match(h.messages.at(-1)!.text, new RegExp(`第 ${HISTORY_MAX_MESSAGES + 4} 条`), '保留最近的一条');
});

test('★ 映射：非 message 条目、空文本、缺 role 都跳过（不产生空消息）', () => {
  const h = entriesToHistory([
    { type: 'session' },
    { type: 'message', message: { role: 'user', content: [] } },
    { type: 'message', message: { content: 'no role' } },
    null,
    'garbage',
  ]);
  assert.deepEqual(h.messages, []);
});

// ---------------------------------------------------------------------------
// 2. 帧层：时机与顺序
// ---------------------------------------------------------------------------

class HistorySession implements ChatSessionLike {
  readonly id: string;
  isRunning = false;
  private resumed: boolean;
  private payload: { messages: { role: 'user' | 'assistant'; text: string; ts: number }[]; truncated: boolean } | null;
  constructor(id: string, resumed: boolean, payload: HistorySession['payload']) {
    this.id = id;
    this.resumed = resumed;
    this.payload = payload;
  }
  subscribe(): () => void {
    return () => {};
  }
  async prompt() {
    return { disposition: 'started', aborted: false, syntheticSettled: false };
  }
  async abort(): Promise<void> {}
  async reset(): Promise<ReadyFrame> {
    return this.readyFrame();
  }
  history() {
    return this.payload;
  }
  readyFrame(): ReadyFrame {
    return {
      type: 'ready', session_id: this.id, model: null, tools: [], tools_source: 'explicit', version: null,
      mode: 'sdk', persistence: this.resumed ? 'native' : 'ephemeral', persistence_reason: 't',
      session_file: this.resumed ? '/tmp/x.jsonl' : null, pi_session_id: null, thinking_level: null, restarted: false,
      resumed: this.resumed, restoredMessages: this.resumed ? (this.payload?.messages.length ?? 0) : 0,
    };
  }
}

async function connect(s: ChatSessionLike, kb = true): Promise<AgentFrame[]> {
  const frames: AgentFrame[] = [];
  const conn = await createChatConnection({
    sessionId: 'hist-1',
    send: (f) => {
      frames.push(f);
    },
    manager: { getOrCreate: async () => s, release: () => {} } as never,
    user: { id: 'u1', roles: ['student'] },
    ...(kb ? { kb: { search: async () => [], get: async () => null } } : {}),
  });
  return frames;
}

test('★★ 恢复的会话：帧序必须是 ready → history，且内容正确', async () => {
  const payload = { messages: [{ role: 'user' as const, text: '之前的问题', ts: 2000 }], truncated: false };
  const frames = await connect(new HistorySession('s', true, payload));
  const types = frames.map((f) => f.type);
  assert.equal(types[0], 'ready');
  assert.equal(types[1], 'history', `顺序应为 ready → history，实际 ${types.join(',')}`);
  const h = frames.find((f) => f.type === 'history') as HistoryFrame;
  assert.deepEqual(h.messages, payload.messages);
  assert.equal(h.truncated, false);
});

test('★ 新建会话（resumed=false）：**不发** history 帧', async () => {
  const frames = await connect(new HistorySession('s', false, { messages: [{ role: 'user', text: 'x', ts: 1 }], truncated: false }));
  assert.ok(!frames.some((f) => f.type === 'history'));
});

test('★ 恢复了但历史为空：不发空帧（避免前端渲染空块）', async () => {
  const frames = await connect(new HistorySession('s', true, { messages: [], truncated: false }));
  assert.ok(!frames.some((f) => f.type === 'history'));
});

test('★ 契约帧表：12 种（新增 history）', () => {
  assert.equal(AGENT_FRAME_TYPES.length, 12);
  assert.ok(AGENT_FRAME_TYPES.includes('history'));
});

test('★★ 出口自检：历史帧里混进只给模型看的字段 → **丢弃**（绝不下发）', async () => {
  // 模拟"映射回归"：某个实现顺手把整条 system 条目拷了进来 → 表现为**多出未预期的键**
  const leaking = {
    messages: [{ role: 'user' as const, text: '正常问题', ts: 1, sections: [{ text: 'EXPERT SYSTEM PROMPT 11KB…' }] }],
    truncated: false,
  };
  const frames = await connect(new HistorySession('s', true, leaking as never));
  assert.ok(!frames.some((f) => f.type === 'history'), '★ 宁可没有历史，也不许下发系统提示词');

  // 顶层多字段同理
  const leaking2 = { messages: [{ role: 'user' as const, text: 'x', ts: 1 }], truncated: false, systemPrompt: '11KB…' };
  const frames2 = await connect(new HistorySession('s', true, leaking2 as never));
  assert.ok(!frames2.some((f) => f.type === 'history'));
});

test('★★ 但**不许误伤**：学生正常问"systemPrompt 是什么"必须照常下发', async () => {
  // 关键词匹配式的守卫会误伤这类消息 → 静默丢历史（历史少了却不说，比不检查更坏）
  const legit = {
    messages: [{ role: 'user' as const, text: 'systemPrompt 是什么？和 sections 有关系吗', ts: 1 }],
    truncated: false,
  };
  const frames = await connect(new HistorySession('s', true, legit));
  const h = frames.find((f) => f.type === 'history') as HistoryFrame;
  assert.ok(h, '正常消息必须下发');
  assert.match(h.messages[0]!.text, /systemPrompt 是什么/);
  assert.equal(historyLeaksSystemPrompt(legit), false, '结构合法 + 无提示词签名 → 不算泄漏');
});
