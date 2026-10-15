/**
 * `stream.ts` 单测：契约 §7.2/§7.3 的映射 + **⚠️6 系统提示词不外泄** + ⚠️1/⚠️2/⚠️7。
 *
 * 用假事件驱动，不需要真 pi；真实 SDK 由 integration.test.ts 覆盖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_FRAME_TYPES,
  SSE_KEEPALIVE,
  SYSTEM_PROMPT_MARKERS,
  beginRound,
  createChatConnection,
  createMapperState,
  formatSse,
  frameLeaksSystemPrompt,
  makeReadyFrame,
  mapSdkEvent,
  sanitizeOutgoingFrame,
  type AgentFrame,
  type ChatSessionLike,
  type ChatSessionManagerLike,
  type MapperState,
  type ReadyFrame,
} from '../../src/agent/stream.ts';
import {
  agentEnd,
  agentSettled,
  agentStart,
  autoRetryEnd,
  autoRetryStart,
  messageEnd,
  systemMessageEnd,
  textDelta,
  thinkingDelta,
  toolEnd,
  toolStart,
  waitFor,
} from './helpers/fakes.ts';

function collect(events: unknown[], state: MapperState = createMapperState()): AgentFrame[] {
  const frames: AgentFrame[] = [];
  for (const event of events) {
    frames.push(...mapSdkEvent(event as never, state));
  }
  return frames;
}

// ===========================================================================
// 映射（契约 §7.3）
// ===========================================================================

test('text_delta / thinking_delta 直通；其它 assistantMessageEvent 不转发', () => {
  const frames = collect([
    textDelta('聚簇'),
    thinkingDelta('先确认…'),
    { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{}' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'done' } },
    textDelta(''),
  ]);
  assert.deepEqual(frames, [
    { type: 'text_delta', delta: '聚簇' },
    { type: 'thinking_delta', delta: '先确认…' },
  ]);
});

test('工具事件映射：start/update/end（含 ok 与 duration_ms）', () => {
  const frames = collect([
    toolStart('call_1', 'read', { path: 'docs/AGENTS.md' }),
    {
      type: 'tool_execution_update',
      toolCallId: 'call_1',
      toolName: 'read',
      partialResult: { content: [{ type: 'text', text: '读到一半' }] },
    },
    toolEnd('call_1', 'read', { durationMs: 120, text: 'AGENTS.md 内容' }),
    toolEnd('call_2', 'bash', { isError: true }),
  ]);
  assert.deepEqual(frames[0], { type: 'tool_start', id: 'call_1', tool: 'read', args: { path: 'docs/AGENTS.md' } });
  assert.deepEqual(frames[1], { type: 'tool_update', id: 'call_1', tool: 'read', partial: '读到一半' });
  assert.deepEqual(frames[2], {
    type: 'tool_end',
    id: 'call_1',
    tool: 'read',
    ok: true,
    duration_ms: 120,
    result_text: 'AGENTS.md 内容',
  });
  assert.equal(frames[3]?.type === 'tool_end' && frames[3].ok, false);
  assert.equal(frames[3]?.type === 'tool_end' && frames[3].duration_ms, null, '没给 durationMs 时必须是 null 而不是编造');
});

test('agent_settled → settled；⚠️1 缺 aborted 字段时按 false 处理', () => {
  assert.deepEqual(collect([agentSettled()]), [{ type: 'settled', aborted: false }]);
  assert.deepEqual(collect([agentSettled(false)]), [{ type: 'settled', aborted: false }]);
  assert.deepEqual(collect([agentSettled(true)]), [{ type: 'settled', aborted: true }]);
});

test('⚠️1 桥侧补标记：我们发过 abort 而 SDK 没标 → aborted:true + abort_source:"client"', () => {
  const state = createMapperState();
  state.abortRequested = true;
  const frames = collect([agentSettled(false)], state);
  assert.deepEqual(frames, [{ type: 'settled', aborted: true, abort_source: 'client' }]);
  assert.equal(state.abortRequested, false, '补过标记后应清账，避免污染下一轮');

  // SDK 自己标了 → 不抢功（不加 abort_source）
  const state2 = createMapperState();
  state2.abortRequested = true;
  assert.deepEqual(collect([agentSettled(true)], state2), [{ type: 'settled', aborted: true }]);

  // 没发过 abort → 不许凭空标"已中断"
  const state3 = createMapperState();
  assert.deepEqual(collect([agentSettled(false)], state3), [{ type: 'settled', aborted: false }]);
});

test('⚠️2 agent_end 不转发（重试场景会出现多次，转发会让 UI 提前置空闲）', () => {
  const state = createMapperState();
  const frames = collect(
    [
      agentStart(),
      agentEnd(),
      autoRetryStart(1, 3, 'boom'),
      agentEnd(),
      autoRetryStart(2, 3, 'boom'),
      agentEnd(),
      autoRetryEnd(false, 2, 'boom'),
      agentSettled(),
    ],
    state,
  );
  const types: string[] = frames.map((f) => f.type);
  assert.equal(types.filter((t) => t === 'settled').length, 1, '一轮只能有一个 settled');
  assert.ok(!types.includes('agent_end'), 'agent_end 不该被转发');
  assert.ok(!types.includes('agent_start'));
});

test('⚠️7 模型失败 → **恰好一条** E_LLM，带 hint 与 attempts', () => {
  const state = createMapperState();
  const frames = collect(
    [
      agentStart(),
      messageEnd('assistant', { stopReason: 'error', errorMessage: 'Request timed out.' }),
      autoRetryStart(1, 3, 'Request timed out.'),
      autoRetryEnd(false, 1, '402: {"code":"insufficient_balance"}'),
      agentSettled(),
    ],
    state,
  );
  const errors = frames.filter((f) => f.type === 'error');
  assert.equal(errors.length, 1, `只应报一条错误，实际 ${errors.length}`);
  const err = errors[0];
  assert.equal(err?.type === 'error' && err.code, 'E_LLM');
  assert.match(String(err?.type === 'error' ? err.msg : ''), /402/);
  assert.match(String(err?.type === 'error' ? err.hint : ''), /^pi SDK 正常，/);
  assert.match(String(err?.type === 'error' ? err.detail : ''), /attempts=1/);
  const settled = frames.at(-1);
  assert.equal(settled?.type, 'settled');
});

test('自动重试成功 → 不报错', () => {
  const frames = collect([autoRetryStart(1, 3, 'boom'), autoRetryEnd(true, 2), textDelta('答出来了')]);
  assert.deepEqual(frames, [{ type: 'text_delta', delta: '答出来了' }]);
});

test('一轮内 message_end 只转发非 system 角色', () => {
  const frames = collect([systemMessageEnd(), messageEnd('user'), messageEnd('assistant')]);
  assert.deepEqual(
    frames.map((f) => (f.type === 'message_end' ? (f.message as { role: string }).role : f.type)),
    ['user', 'assistant'],
  );
});

test('未知事件/畸形事件不抛、不产生帧（前向兼容）', () => {
  const state = createMapperState();
  for (const bad of [
    null,
    undefined,
    {},
    { type: 'brand_new_event_from_future_pi' },
    { type: 'message_update' },
    { type: 'message_update', assistantMessageEvent: {} },
    { type: 'message_end', message: null },
    { type: 'tool_execution_end' },
  ]) {
    assert.doesNotThrow(() => mapSdkEvent(bad as never, state));
  }
  assert.deepEqual(collect([{ type: 'message_end', message: null }], state), [
    { type: 'message_end', message: null },
  ]);
});

test('只发契约 §7.2 的 9 种帧，绝不发明新类型', () => {
  const state = createMapperState();
  const frames = collect(
    [
      agentStart(),
      textDelta('a'),
      thinkingDelta('b'),
      toolStart('c', 'read', {}),
      { type: 'tool_execution_update', toolCallId: 'c', toolName: 'read', partialResult: 'p' },
      toolEnd('c', 'read'),
      messageEnd('assistant'),
      agentEnd(),
      agentSettled(),
    ],
    state,
  );
  for (const frame of frames) {
    assert.ok((AGENT_FRAME_TYPES as readonly string[]).includes(frame.type), `非法帧类型 ${frame.type}`);
  }
  assert.deepEqual([...new Set(frames.map((f) => f.type))].sort(), [
    'message_end',
    'settled',
    'text_delta',
    'thinking_delta',
    'tool_end',
    'tool_start',
    'tool_update',
  ]);
});

// ===========================================================================
// ⚠️6 系统提示词不外泄 —— 三层防线
// ===========================================================================

test('★ 主防线：system 角色的 message_end 完全不产生帧（含 sections/AGENTS.md 全文）', () => {
  const state = createMapperState();
  const frames = collect([systemMessageEnd(), agentSettled()], state);
  assert.deepEqual(frames.map((f) => f.type), ['settled']);
  const wire = JSON.stringify(frames);
  for (const marker of SYSTEM_PROMPT_MARKERS) {
    assert.ok(!wire.includes(marker), `下发帧里出现了系统提示词特征串：${marker}`);
  }
  assert.ok(!wire.includes('project_instructions'), 'AGENTS.md 全文泄漏！');
});

test('★ 整轮回放：文本 + 工具 + system 提示词混在一起，下发的字节里没有系统提示词', () => {
  const state = createMapperState();
  const frames = collect(
    [
      agentStart(),
      systemMessageEnd(), // 每轮 pi 都会先发这一条（v1/v2 实测）
      messageEnd('user'),
      textDelta('聚簇索引'),
      toolStart('call_1', 'read', { path: '/x' }),
      toolEnd('call_1', 'read', { text: 'ok' }),
      messageEnd('assistant', { content: [{ type: 'text', text: '聚簇索引是…' }] }),
      agentEnd(),
      agentSettled(),
    ],
    state,
  );
  const wire = JSON.stringify(frames);
  for (const marker of SYSTEM_PROMPT_MARKERS) {
    assert.ok(!wire.includes(marker), `泄漏特征串：${marker}`);
  }
  assert.match(wire, /聚簇索引/, '正常文本必须还在（防"过度过滤"把真内容也删了）');
  assert.equal(state.systemMessagesForwarded, 0);
});

test('第二道防线：非 system 消息里若混进 sections/systemPrompt，转发前被剥掉', () => {
  const polluted: AgentFrame = {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '正常回答' }],
      sections: { preamble: 'You are an expert coding assistant operating inside pi' },
      systemPrompt: 'You are an expert coding assistant operating inside pi',
    },
  };
  const cleaned = sanitizeOutgoingFrame(polluted);
  assert.ok(cleaned, '清洗后应仍可下发（只剥字段，不整帧丢弃）');
  const json = JSON.stringify(cleaned);
  assert.ok(!json.includes('sections'));
  assert.ok(!json.includes('systemPrompt'));
  assert.match(json, /正常回答/);
});

test('第三道防线 frameLeaksSystemPrompt 能识别泄漏（并给出可读断言）', () => {
  assert.equal(frameLeaksSystemPrompt({ type: 'text_delta', delta: '正常' }), false);
  assert.equal(
    frameLeaksSystemPrompt({ type: 'text_delta', delta: '<project_instructions path="x">' }),
    true,
  );
  assert.equal(frameLeaksSystemPrompt({ type: 'message_end', message: systemMessageEnd().message }), true);
});

test('system 角色的 message_end 即使被硬塞进出口，也会被 sanitize 丢弃并计入违规', async () => {
  const manager = makeFakeManager({
    onSubscribeEmit: [
      { type: 'message_end', message: systemMessageEnd().message },
      { type: 'settled', aborted: false },
    ],
  });
  const sent: AgentFrame[] = [];
  const conn = await createChatConnection({
    sessionId: 'sess-leak',
    send: (f) => {
      sent.push(f);
    },
    manager,
  });
  assert.ok(await waitFor(() => sent.some((f) => f.type === 'settled')));
  assert.equal(sent.filter((f) => f.type === 'message_end').length, 0);
  const wire = JSON.stringify(sent);
  for (const marker of SYSTEM_PROMPT_MARKERS) assert.ok(!wire.includes(marker), marker);
  await conn.close();
});

// ===========================================================================
// ready 帧 + SSE
// ===========================================================================

test('ready 帧包含 §7.3.1 ⚠️9 的可观测字段，且绝不含系统提示词', () => {
  const ready: ReadyFrame = makeReadyFrame({
    sessionId: 'web-1',
    model: 'glm-5.2',
    tools: [],
    toolsSource: 'explicit',
    version: '1.2.0',
    persistence: 'native',
    persistenceReason: 'pi 原生 session：…/data/chat',
    sessionFile: 'D:/x/data/chat/2026-10-14T15-00-00-000Z_abc.jsonl',
    piSessionId: 'abc',
    thinkingLevel: 'high',
    restarted: false,
  });
  assert.equal(ready.type, 'ready');
  assert.equal(ready.session_id, 'web-1');
  assert.equal(ready.pi_session_id, 'abc', 'session_id 与 pi_session_id 必须分开');
  assert.equal(ready.mode, 'sdk');
  assert.equal(ready.persistence, 'native');
  assert.ok(ready.session_file?.endsWith('.jsonl'));
  assert.equal(frameLeaksSystemPrompt(ready), false);
});

test('SSE 格式化：data 是单行 JSON + keepalive 注释帧', () => {
  const line = formatSse({ type: 'text_delta', delta: 'a\nb' });
  assert.ok(line.startsWith('event: text_delta\ndata: '));
  assert.ok(line.endsWith('\n\n'));
  const dataLine = line.split('\n')[1] ?? '';
  assert.equal(dataLine.split('\n').length, 1, 'data 必须是单行');
  assert.deepEqual(JSON.parse(dataLine.slice('data: '.length)), { type: 'text_delta', delta: 'a\nb' });
  assert.equal(SSE_KEEPALIVE, ': keepalive\n\n');
});

// ===========================================================================
// createChatConnection（客户端消息 → 会话调用）
// ===========================================================================

function makeFakeSession(opts: {
  onSubscribeEmit?: AgentFrame[];
  promptError?: Error;
  running?: boolean;
  disposition?: string;
} = {}) {
  const listeners = new Set<(f: AgentFrame) => void>();
  const prompts: { message: string; opts?: { steer?: boolean; followUp?: boolean } }[] = [];
  let aborts = 0;
  let resets = 0;
  const setModelCalls: string[] = [];

  const session: ChatSessionLike & {
    prompts: typeof prompts;
    abortsValue: () => number;
    resetsValue: () => number;
    setModelCalls: string[];
  } = {
    id: 's',
    isRunning: opts.running ?? false,
    prompts,
    abortsValue: () => aborts,
    resetsValue: () => resets,
    setModelCalls,
    subscribe(listener) {
      listeners.add(listener);
      for (const frame of opts.onSubscribeEmit ?? []) listener(frame);
      return () => {
        listeners.delete(listener);
      };
    },
    async prompt(message, popts) {
      prompts.push({ message, ...(popts ? { opts: popts } : {}) });
      if (opts.promptError) throw opts.promptError;
      return { disposition: opts.disposition ?? 'started', aborted: false, syntheticSettled: false };
    },
    async abort() {
      aborts += 1;
    },
    async setModel(ref: string) {
      setModelCalls.push(ref);
      return { ok: true };
    },
    async reset() {
      resets += 1;
      return makeReadyFrame({
        sessionId: 's',
        model: null,
        tools: [],
        toolsSource: 'explicit',
        version: '1.2.0',
        persistence: 'ephemeral',
        persistenceReason: 'x',
        sessionFile: null,
        piSessionId: null,
        thinkingLevel: null,
        restarted: true,
      });
    },
    readyFrame: () =>
      makeReadyFrame({
        sessionId: 's',
        model: 'fake-model',
        tools: [],
        toolsSource: 'explicit',
        version: '1.2.0',
        persistence: 'ephemeral',
        persistenceReason: 'x',
        sessionFile: null,
        piSessionId: 'pi-1',
        thinkingLevel: 'medium',
        restarted: false,
      }),
  };
  return session;
}

function makeFakeManager(session: ReturnType<typeof makeFakeSession> | { onSubscribeEmit?: AgentFrame[] } = {}): ChatSessionManagerLike & {
  released: string[];
} {
  const real = 'subscribe' in session ? session : makeFakeSession(session as { onSubscribeEmit?: AgentFrame[] });
  const manager = {
    released: [] as string[],
    async getOrCreate() {
      return real;
    },
    release(id: string) {
      manager.released.push(id);
    },
  };
  return manager;
}

test('连接建立后先发 ready，再收事件（先订阅再触发）', async () => {
  const manager = makeFakeManager({ onSubscribeEmit: [{ type: 'text_delta', delta: '早到的增量' }] });
  const sent: AgentFrame[] = [];
  const conn = await createChatConnection({
    sessionId: 'sess-1',
    send: (f) => {
      sent.push(f);
    },
    manager,
  });
  assert.equal(sent[0]?.type, 'ready', 'ready 必须是第一帧');
  assert.ok(await waitFor(() => sent.some((f) => f.type === 'text_delta')));
  assert.equal(sent[1]?.type, 'text_delta', '订阅之后就收到的事件不能丢');
  await conn.close();
  assert.deepEqual(manager.released, ['sess-1']);
});

test('客户端消息：prompt/steer/abort/set_model/new_session/get_state', async () => {
  const session = makeFakeSession();
  const manager = makeFakeManager(session);
  const sent: AgentFrame[] = [];
  const conn = await createChatConnection({ sessionId: 'sess-2', send: (f) => { sent.push(f); }, manager });

  await conn.handleClientMessage(JSON.stringify({ type: 'prompt', message: '问题一' }));
  // 断言**语义**（走 prompt 通道、且不是 steer），而不是 opts 对象的确切形状 ——
  // 原断言要求显式带 `followUp:false`，那只是"恰好没传"，不是契约语义。
  assert.equal(session.prompts.length, 1);
  assert.equal(session.prompts[0]?.message, '问题一');
  assert.notEqual(session.prompts[0]?.opts?.steer, true, '普通 prompt 不该被当成 steer');

  await conn.handleClientMessage(JSON.stringify({ type: 'steer', message: '插话' }));
  assert.equal(session.prompts.length, 2);
  assert.equal(session.prompts[1]?.message, '插话');
  assert.equal(session.prompts[1]?.opts?.steer, true, '桥的 steer 命令必须转成 streamingBehavior=steer');
  assert.notEqual(session.prompts[1]?.opts?.followUp, true, 'steer 不该同时当成 followUp');

  await conn.handleClientMessage(JSON.stringify({ type: 'abort' }));
  assert.equal(session.abortsValue(), 1);

  await conn.handleClientMessage(JSON.stringify({ type: 'set_model', model: 'provider/model-x' }));
  assert.deepEqual(session.setModelCalls, ['provider/model-x']);
  assert.ok(sent.some((f) => f.type === 'ready'), 'set_model 后应重发 ready');

  const before = sent.length;
  await conn.handleClientMessage(JSON.stringify({ type: 'new_session' }));
  assert.equal(session.resetsValue(), 1);
  const ready = sent.slice(before).find((f) => f.type === 'ready');
  assert.equal(ready?.type === 'ready' && ready.restarted, true, 'new_session 的 ready 应标记 restarted');

  await conn.handleClientMessage(JSON.stringify({ type: 'get_state' }));
  assert.ok(sent.slice(before).filter((f) => f.type === 'ready').length >= 2);
  await conn.close();
});

test('非法客户端消息：坏 JSON / 缺字段 / 未知类型 → E_PI_CMD（不崩）', async () => {
  const manager = makeFakeManager();
  const sent: AgentFrame[] = [];
  const conn = await createChatConnection({ sessionId: 'sess-3', send: (f) => { sent.push(f); }, manager });

  await conn.handleClientMessage('not json');
  await conn.handleClientMessage(JSON.stringify({ type: 'prompt' }));
  await conn.handleClientMessage(JSON.stringify({ type: 'nope' }));
  await conn.handleClientMessage(JSON.stringify({ type: 'set_model' }));

  const errors = sent.filter((f) => f.type === 'error');
  assert.equal(errors.length, 4);
  for (const err of errors) assert.equal(err.type === 'error' && err.code, 'E_PI_CMD');
  assert.match(String(errors[1]?.type === 'error' ? errors[1].msg : ''), /message/);
  await conn.close();
});

test('非法 session id → E_PI_SESSION_ID + onClose(1008)，不创建会话', async () => {
  const sent: AgentFrame[] = [];
  const closes: [number, string][] = [];
  const manager = makeFakeManager();
  let created = 0;
  const counting = { ...manager, async getOrCreate() { created += 1; return manager.getOrCreate('x'); } };
  const conn = await createChatConnection({
    sessionId: '../etc/passwd',
    send: (f) => { sent.push(f); },
    onClose: (code, reason) => closes.push([code, reason]),
    manager: counting,
  });
  assert.equal(sent[0]?.type === 'error' && sent[0].code, 'E_PI_SESSION_ID');
  assert.deepEqual(closes, [[1008, 'invalid session id']]);
  assert.equal(created, 0);
  await conn.close();
});

test('会话创建失败（SDK 不可用）→ error{E_PI_UNAVAILABLE} + onClose(1013) + 哑连接', async () => {
  const sent: AgentFrame[] = [];
  const closes: [number, string][] = [];
  const failing: ChatSessionManagerLike = {
    async getOrCreate() {
      const err = new Error('pi SDK 未安装：@earendil-works/pi-coding-agent 无法解析');
      err.name = 'PiSdkUnavailable';
      throw err;
    },
    release() {},
  };
  const conn = await createChatConnection({
    sessionId: 'sess-4',
    send: (f) => { sent.push(f); },
    onClose: (c, r) => closes.push([c, r]),
    manager: failing,
  });
  const err = sent[0];
  assert.equal(err?.type, 'error');
  assert.match(String(err?.type === 'error' ? err.hint : ''), /^pi SDK 不可用：/);
  assert.deepEqual(closes, [[1013, 'pi unavailable']]);
  // 哑连接：后续消息不再假装能用
  const before = sent.length;
  await conn.handleClientMessage(JSON.stringify({ type: 'prompt', message: 'x' }));
  assert.equal(sent.length, before);
  await conn.close();
});

test('会话里抛出的错误被分类后变成 error 帧（不会把异常抛给调用方）', async () => {
  const session = makeFakeSession({ promptError: new Error('402: {"code":"insufficient_balance"}') });
  const manager = makeFakeManager(session);
  const sent: AgentFrame[] = [];
  const conn = await createChatConnection({ sessionId: 'sess-5', send: (f) => { sent.push(f); }, manager });
  await assert.doesNotReject(() => conn.handleClientMessage(JSON.stringify({ type: 'prompt', message: 'x' })));
  const err = sent.find((f) => f.type === 'error');
  assert.equal(err?.type === 'error' && err.code, 'E_LLM');
  assert.match(String(err?.type === 'error' ? err.hint : ''), /额度/);
  await conn.close();
});

test('订阅者抛异常不影响其它订阅者（隔离）', async () => {
  const manager = makeFakeManager({ onSubscribeEmit: [{ type: 'text_delta', delta: 'a' }] });
  const good: AgentFrame[] = [];
  const conn = await createChatConnection({
    sessionId: 'sess-6',
    send: () => {
      throw new Error('对端已断开');
    },
    manager,
  });
  // send 抛异常不应让连接创建失败
  assert.ok(conn);
  const conn2 = await createChatConnection({ sessionId: 'sess-7', send: (f) => { good.push(f); }, manager });
  assert.ok(await waitFor(() => good.length > 0));
  await conn.close();
  await conn2.close();
});

test('beginRound 重置本轮状态但保留违规计数', () => {
  const state = createMapperState();
  state.violations = 3;
  state.settledSent = true;
  state.abortRequested = true;
  state.pendingError = 'x';
  beginRound(state);
  assert.equal(state.violations, 3, '违规计数是全局的，不能清');
  assert.equal(state.settledSent, false);
  assert.equal(state.abortRequested, true, 'abortRequested 由调用方显式管理，beginRound 不动它');
  assert.equal(state.pendingError, null);
});
