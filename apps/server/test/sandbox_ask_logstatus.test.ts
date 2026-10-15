/**
 * 日志状态**说错方向**的兜底测试（真机跑出来的 bug）。
 *
 * 背景：一次真模型运行里，日志状态是 `empty`（**可读**，只是本会话没有记录），
 * 模型却说"我暂时读不到该实例的引擎日志" —— 这是**事实说错**，会让学生以为系统坏了。
 * 原有兜底只覆盖了一个方向（unavailable 但没说 → 补说明）；
 * 这个文件覆盖**反方向**（可读却说读不到 → 补更正）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ASK_SYSTEM_PROMPT, createAskHandler, type AskDeps, type DbLogEntry, type LogSourceLike } from '../src/sandbox/ask.ts';
import type { AgentFrame, ChatSessionLike, ChatSessionManagerLike, ReadyFrame } from '../src/agent/stream.ts';

class FakeSession implements ChatSessionLike {
  readonly id = 'ask-fake';
  isRunning = false;
  answer = '';
  promptCalls: string[] = [];
  private listeners = new Set<(f: AgentFrame) => void>();
  subscribe(listener: (f: AgentFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async prompt(message: string) {
    this.promptCalls.push(message);
    if (this.answer !== '') {
      for (const l of [...this.listeners]) l({ type: 'text_delta', delta: this.answer });
      for (const l of [...this.listeners]) l({ type: 'message_end', message: { role: 'assistant', content: this.answer } });
    }
    for (const l of [...this.listeners]) l({ type: 'settled', aborted: false });
    return { disposition: 'started', aborted: false, syntheticSettled: false };
  }
  async abort(): Promise<void> {}
  async reset(): Promise<ReadyFrame> {
    return this.readyFrame();
  }
  readyFrame(): ReadyFrame {
    return {
      type: 'ready', session_id: this.id, model: null, tools: [], tools_source: 'explicit', version: null,
      mode: 'sdk', persistence: 'ephemeral', persistence_reason: '测试', session_file: null,
      pi_session_id: null, thinking_level: null, restarted: false,
    };
  }
}

function managerFor(session: FakeSession): ChatSessionManagerLike {
  return {
    async getOrCreate() {
      return session;
    },
    release() {},
  };
}

function logSource(over: { available?: boolean; reason?: string; entries?: DbLogEntry[] } = {}): LogSourceLike {
  return {
    info: () => ({
      id: 'sqlite',
      layers: ['L1'],
      available: over.available !== false,
      ...(over.reason !== undefined ? { reason: over.reason } : {}),
    }),
    async fetch() {
      return over.entries ?? [];
    },
  };
}

function deps(session: FakeSession, over: Partial<AskDeps> = {}): AskDeps {
  return {
    manager: managerFor(session),
    getSchema: async () => ({ dialect: 'sqlite', tables: [], text: '方言：sqlite\n- students（6 行）: sid INTEGER PK' }),
    getRecentExecutions: async () => [{ at: Date.now(), sql: 'SELECT 1', ok: true }],
    search: async () => [],
    ...over,
  };
}

const frames: AgentFrame[] = [];
const sink = (f: AgentFrame): void => {
  frames.push(f);
};

test('★ 日志可读（empty）但模型说"读不到" → 系统补更正 + logStatusMisstated', async () => {
  const session = new FakeSession();
  session.answer = '我暂时读不到该实例的引擎日志（原因：没有记录），下面的分析仅基于你的报错与 SQL。';
  const handler = createAskHandler(deps(session, { logSource: logSource({ entries: [] }) }));
  frames.length = 0;
  const out = await handler.handle({ sessionId: 's1', userId: 'u1', error: 'no such table: x' }, sink);

  assert.equal(out.logAccess.status, 'empty');
  assert.equal(out.logDisclaimerPresent, true, '模型确实说了"读不到"');
  assert.equal(out.logDisclaimerAppended, false, '不该再补"读不到"（方向反了）');
  assert.equal(out.logStatusMisstated, true, '★ 必须识别出"事实说错"');
  assert.ok(out.systemAppended.some((s) => s.includes('更正')), '要有更正说明');
  assert.match(out.text, /日志是可读的/);
  assert.match(out.text, /只是本会话没有匹配记录/);
});

test('★ 日志可读（ok）但模型说"读不到" → 同样更正，并说明读到了几条', async () => {
  const session = new FakeSession();
  session.answer = '日志读不到，我只能猜。';
  const handler = createAskHandler(
    deps(session, {
      logSource: logSource({ entries: [{ source: 'L1', level: 'error', message: 'no such table: x', sessionId: 's1' }] }),
    }),
  );
  const out = await handler.handle({ sessionId: 's1', userId: 'u1', error: 'no such table: x' }, sink);
  assert.equal(out.logAccess.status, 'ok');
  assert.equal(out.logStatusMisstated, true);
  assert.match(out.text, /读到了 1 条/);
});

test('★ 日志真读不到（unavailable）且模型说了 → 不误报 misstated', async () => {
  const session = new FakeSession();
  session.answer = '我暂时读不到该实例的引擎日志（原因：未配置），下面的分析仅基于你的报错与 SQL。';
  const handler = createAskHandler(
    deps(session, { logSource: logSource({ available: false, reason: '未配置日志路径' }) }),
  );
  const out = await handler.handle({ sessionId: 's1', userId: 'u1', error: 'x' }, sink);
  assert.equal(out.logAccess.status, 'unavailable');
  assert.equal(out.logDisclaimerPresent, true);
  assert.equal(out.logStatusMisstated, false, '这个方向是对的，不该被当成说错');
  assert.equal(out.systemAppended.length, 0);
});

test('★ 日志可读、模型也没说读不到 → 两边都安静（不啰嗦）', async () => {
  const session = new FakeSession();
  session.answer = '日志里能看到你用了 no such table 的表名。';
  const handler = createAskHandler(deps(session, { logSource: logSource({ entries: [] }) }));
  const out = await handler.handle({ sessionId: 's1', userId: 'u1', error: 'x' }, sink);
  assert.equal(out.logStatusMisstated, false);
  assert.equal(out.logDisclaimerAppended, false);
  assert.equal(out.systemAppended.length, 0);
});

test('★ 提示词用中文事实句说明日志情况（不再给模型一个英文状态词猜）', async () => {
  const cases: [Partial<AskDeps>, string][] = [
    [{ logSource: logSource({ entries: [] }) }, '日志情况：**日志可读**，但本会话没有匹配的记录（≠ 读不到；**不要说"读不到日志"**）'],
    [{ logSource: logSource({ available: false, reason: '未配置日志路径' }) }, '日志情况：**读不到**该实例的引擎日志（原因：未配置日志路径）'],
    [
      { logSource: logSource({ entries: [{ source: 'L1', level: 'error', message: 'e', sessionId: 's1' }] }) },
      '日志情况：**读到了**该实例的引擎日志（1 条',
    ],
    [{}, '日志情况：**读不到**该实例的引擎日志（原因：服务端未配置数据库日志源（logSource 未接入））'],
  ];
  for (const [over, expected] of cases) {
    const session = new FakeSession();
    session.answer = 'x';
    const handler = createAskHandler(deps(session, over));
    await handler.handle({ sessionId: 's1', userId: 'u1', error: 'x' }, sink);
    assert.ok(session.promptCalls[0]!.includes(expected), `提示词应含「${expected}」`);
  }
});

test('★ 系统提示词里有反向禁止条款：可读时不许说"读不到日志"', () => {
  assert.match(ASK_SYSTEM_PROMPT, /日志可读，但本会话没有记录/);
  assert.match(ASK_SYSTEM_PROMPT, /不许说"读不到日志"/);
  assert.match(ASK_SYSTEM_PROMPT, /读得到 vs 没内容/);
});
