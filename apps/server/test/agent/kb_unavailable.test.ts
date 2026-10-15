/**
 * 🔴 回归：**kb 工具没能注册时，`tools_source` 不许再说 `kb-readonly`**（坑 21 第二方向）。
 *
 * 真事故（`polysemy-prober` 对照实验：同一份代码，隔离实例里**只差有没有 `.env` 凭据**）：
 * ```
 * ① 无凭据 → ready.tools=[]                  tools_source='kb-readonly'  ← ❌ 说开了其实关着
 * ② 有凭据 → ready.tools=["kb_search","kb_get"] tools_source='kb-readonly'  ← ✅
 * ```
 * 根因是**三处串联**（少修一处就不生效）：
 * 1. `stream.ts` 在建会话**之前**就定了 `policy='kb-readonly'`，之后不回头看实际生效值；
 * 2. `session.ts` 把 kb 工具从白名单剔除并记了 diagnostic，**但没把原因报进 ready 帧**；
 * 3. `makeReadyFrame` **根本没填** `kb_tools_warning` → 连接层依赖它的兜底分支永远拿不到值；
 *    而兜底条件还写成 `policy === 'disabled-by-role'`（agent 模式下恒为 `kb-readonly`）→ **永假**。
 *
 * ⟹ 后果比"说错了"更坏：**把"工具没装"伪装成"知识库是空的"**（学生以为课程没内容）。
 *
 * 本文件在旧实现下**必红**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createChatConnection,
  makeReadyFrame,
  withToolsPolicy,
  type AgentFrame,
  type ChatSessionLike,
  type ReadyFrame,
} from '../../src/agent/stream.ts';
import { AgentSessionManager } from '../../src/agent/session.ts';
import { KB_TOOL_NAMES } from '../../src/agent/kb_tools.ts';
import { FakePiSession } from './helpers/fakes.ts';
import type { SdkLoadResult } from '../../src/agent/sdk.ts';

// ---------------------------------------------------------------------------
// 1. 单元：策略降级 + 警告必须出现（不看真实会话也能钉住判据）
// ---------------------------------------------------------------------------

function baseFrame(over: Partial<ReadyFrame> = {}): ReadyFrame {
  return {
    type: 'ready', session_id: 's', model: null, tools: [], tools_source: 'explicit', version: null,
    mode: 'sdk', persistence: 'ephemeral', persistence_reason: 't', session_file: null,
    pi_session_id: null, thinking_level: null, restarted: false,
    ...over,
  };
}

test('★★ 同源：kb 工具没注册（有原因）→ 策略降级为 kb-unavailable + 警告非空', () => {
  const out = withToolsPolicy(
    baseFrame({ tools: [], kb_tools_warning: '知识库查询能力未接入（AgentSessionManager 未提供 kb provider）' }),
    'kb-readonly',
    'agent',
  );
  assert.equal(out.tools_source, 'kb-unavailable', '★ 不许再报 kb-readonly（说开了其实关着）');
  assert.deepEqual(out.tools, []);
  assert.match(String(out.tools_warning), /只读知识库工具不可用/);
  assert.match(String(out.tools_warning), /知识库查询能力未接入/);
});

test('★★ 同源：即使会话层没报原因，生效工具集里没有 kb 工具也要降级', () => {
  const out = withToolsPolicy(baseFrame({ tools: ['kb_search', 'kb_get'] }), 'kb-readonly', 'agent');
  assert.equal(out.tools_source, 'kb-readonly', '真有工具就保持 kb-readonly');
  assert.equal(out.tools_warning, undefined, '有工具时不该有"不可用"警告');

  const gone = withToolsPolicy(baseFrame({ tools: [] }), 'kb-readonly', 'agent'); // 无 warning，但工具没了
  assert.equal(gone.tools_source, 'kb-unavailable', '★ 生效值是唯一真相：工具没了就不许说开');
  assert.match(String(gone.tools_warning), /只读知识库工具不可用/);
});

test('★★ 0 工具（如 admin/学生）：策略仍是 disabled-by-role，且**不**报成 kb-unavailable', () => {
  const out = withToolsPolicy(baseFrame({ tools: [] }), 'disabled-by-role', 'chat');
  assert.equal(out.tools_source, 'disabled-by-role');
  assert.equal(out.tools_warning, undefined, '普通"按角色关掉"不该出现 kb 警告（否则成噪音）');
});

test('★★ makeReadyFrame 必须真的填 kb_tools_warning（原实现只声明不填 → 兜底永假）', () => {
  const f = makeReadyFrame({
    sessionId: 's', model: null, tools: [], toolsSource: 'explicit', version: null,
    persistence: 'ephemeral', persistenceReason: 't', sessionFile: null, piSessionId: null,
    thinkingLevel: null, restarted: false, kbToolsWarning: '缺少服务端用户身份',
  });
  assert.equal(f.kb_tools_warning, '缺少服务端用户身份');
  // 没有原因时不该出现空字符串字段（"缺字段"和"明确是空"语义不同 —— 坑 22）
  const f2 = makeReadyFrame({
    sessionId: 's', model: null, tools: [], toolsSource: 'explicit', version: null,
    persistence: 'ephemeral', persistenceReason: 't', sessionFile: null, piSessionId: null,
    thinkingLevel: null, restarted: false,
  });
  assert.equal('kb_tools_warning' in f2, false);
});

// ---------------------------------------------------------------------------
// 2. 会话层：三条"kb 工具注册不了"的分支都要把原因报出来（并真的从白名单移除）
// ---------------------------------------------------------------------------

function capturingSdk(captured: Record<string, unknown>[]): SdkLoadResult {
  return {
    available: true,
    createAgentSession: (async (options?: unknown) => {
      captured.push((options ?? {}) as Record<string, unknown>);
      return { session: new FakePiSession({ sessionFile: null, persistence: 'ephemeral' }) as never };
    }) as never,
    SessionManager: {
      create: () => ({ getEntries: () => [], getSessionId: () => 'pi-1', getSessionFile: () => undefined }),
      inMemory: () => ({ getEntries: () => [], getSessionId: () => 'pi-1', getSessionFile: () => undefined }),
      open: () => ({ getEntries: () => [], getSessionId: () => 'pi-1', getSessionFile: () => undefined }),
    } as never,
    version: '1.2.0',
    loadMs: 1,
    specifier: 'fake',
  };
}

test('★★ agent 模式 + 无 kb provider → 白名单里去掉 kb 工具，且原因进 ready 帧', async () => {
  const captured: Record<string, unknown>[] = [];
  const manager = new AgentSessionManager({
    sessionDir: null, persist: false, sdkLoader: async () => capturingSdk(captured),
    // 注意：**不提供 kb**
  });
  const session = await manager.getOrCreate('kbn-1', { tools: [...KB_TOOL_NAMES], kbUserId: 'u1' });
  const ready = session.readyFrame();
  assert.deepEqual(captured[0]!.tools, [], '★ 注册不了的 kb 工具必须从白名单移除（不留假工具名）');
  assert.match(String(ready.kb_tools_warning), /知识库查询能力未接入/);
  manager.closeAll();
});

test('★★ agent 模式 + 缺服务端身份 → 同样移除 + 报"缺少身份"（不能放开可见性过滤）', async () => {
  const captured: Record<string, unknown>[] = [];
  const manager = new AgentSessionManager({
    sessionDir: null, persist: false, sdkLoader: async () => capturingSdk(captured),
    kb: { search: async () => [], get: async () => null },
  });
  const session = await manager.getOrCreate('kbn-2', { tools: [...KB_TOOL_NAMES] }); // 没有 kbUserId
  const ready = session.readyFrame();
  assert.deepEqual(captured[0]!.tools, []);
  assert.match(String(ready.kb_tools_warning), /缺少服务端用户身份/);
  manager.closeAll();
});

test('★ agent 模式 + kb 齐备 → 保留两个 kb 工具，且**没有** kb 警告', async () => {
  const captured: Record<string, unknown>[] = [];
  const manager = new AgentSessionManager({
    sessionDir: null, persist: false, sdkLoader: async () => capturingSdk(captured),
    kb: { search: async () => [], get: async () => null },
  });
  const session = await manager.getOrCreate('kbn-3', { tools: [...KB_TOOL_NAMES], kbUserId: 'u1' });
  const ready = session.readyFrame();
  assert.deepEqual(captured[0]!.tools, [...KB_TOOL_NAMES]);
  assert.equal(ready.kb_tools_warning, undefined, '正常路径不该出现警告');
  manager.closeAll();
});

// ---------------------------------------------------------------------------
// 3. 端到端（连接层）：agent 模式 + 无 kb → tools=[] 且 source 不是 kb-readonly，警告非空
// ---------------------------------------------------------------------------

/** 假会话：忠实模拟"kb 工具已被剔除"的真会话（`getActiveToolNames()` 返回真实生效值） */
class EmulatingSession implements ChatSessionLike {
  readonly id: string;
  isRunning = false;
  private tools: string[];
  private warn: string | undefined;
  constructor(id: string, tools: string[], warn?: string) {
    this.id = id;
    this.tools = tools;
    this.warn = warn;
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
  readyFrame(): ReadyFrame {
    return makeReadyFrame({
      sessionId: this.id, model: null, tools: this.tools, toolsSource: 'explicit', version: null,
      persistence: 'ephemeral', persistenceReason: 't', sessionFile: null, piSessionId: null,
      thinkingLevel: null, restarted: false,
      ...(this.warn !== undefined ? { kbToolsWarning: this.warn } : {}),
    });
  }
}

test('★★★ 端到端：agent 模式 + 无 kb 能力 → tools=[] 且 tools_source≠kb-readonly + 警告非空', async () => {
  const frames: AgentFrame[] = [];
  const conn = await createChatConnection({
    sessionId: 'kbn-e2e',
    send: (f) => {
      frames.push(f);
    },
    manager: {
      // 模拟真实管理器：拿到 kb 工具白名单但注册不了 → 移除 + 报原因
      async getOrCreate() {
        return new EmulatingSession('kbn-e2e.agent', [], '知识库查询能力未接入（AgentSessionManager 未提供 kb provider）');
      },
      release: () => {},
    },
    user: { id: 'u1', roles: ['student'] },
    kb: { search: async () => [], get: async () => null },
    mode: 'agent',
  });
  const ready = frames.find((f) => f.type === 'ready') as ReadyFrame;
  assert.deepEqual(ready.tools, [], '真实生效值：没有工具');
  assert.notEqual(ready.tools_source, 'kb-readonly', '★ 不许说 kb 工具可用（说开了其实关着）');
  assert.equal(ready.tools_source, 'kb-unavailable');
  assert.equal(ready.agent_mode, 'agent', '模式仍如实回显');
  assert.match(String(ready.tools_warning), /只读知识库工具不可用/, '★ 兜底警告必须能出现（原条件永假）');
  assert.match(String(ready.tools_warning), /工具未装/, '要能区分"工具没装"与"知识库为空"');
  await conn.close();
});

test('★★★ 端到端：agent 模式 + kb 正常 → tools=[kb_search,kb_get] 且 source=kb-readonly、无警告', async () => {
  const frames: AgentFrame[] = [];
  const conn = await createChatConnection({
    sessionId: 'kbn-ok',
    send: (f) => {
      frames.push(f);
    },
    manager: {
      async getOrCreate() {
        return new EmulatingSession('kbn-ok.agent', [...KB_TOOL_NAMES]);
      },
      release: () => {},
    },
    user: { id: 'u1', roles: ['student'] },
    kb: { search: async () => [], get: async () => null },
    mode: 'agent',
  });
  const ready = frames.find((f) => f.type === 'ready') as ReadyFrame;
  assert.deepEqual(ready.tools, [...KB_TOOL_NAMES]);
  assert.equal(ready.tools_source, 'kb-readonly');
  assert.equal(ready.tools_warning, undefined);
  await conn.close();
});

test('★★ 同源判据（对任意 ready 帧）：kb-readonly ⇔ 真的含 kb 工具；kb-unavailable ⇒ 不含', () => {
  const check = (f: ReadyFrame): void => {
    const tools = f.tools ?? [];
    const hasKb = tools.some((t) => (KB_TOOL_NAMES as readonly string[]).includes(t));
    if (f.tools_source === 'kb-readonly') assert.equal(hasKb, true, 'kb-readonly 必须有 kb 工具');
    if (f.tools_source === 'kb-unavailable') {
      assert.equal(hasKb, false, 'kb-unavailable 不该含 kb 工具');
      assert.ok(String(f.tools_warning ?? '').length > 0, 'kb-unavailable 必须带可读原因');
    }
  };
  check(withToolsPolicy(baseFrame({ tools: [...KB_TOOL_NAMES] }), 'kb-readonly', 'agent'));
  check(withToolsPolicy(baseFrame({ tools: [], kb_tools_warning: 'x' }), 'kb-readonly', 'agent'));
  check(withToolsPolicy(baseFrame({ tools: [] }), 'kb-readonly', 'agent'));
});
