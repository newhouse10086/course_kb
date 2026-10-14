/**
 * 🔴 CRITICAL 回归：**工具默认必须为空**（学生不能通过 agent 执行 shell / 读主机文件）。
 *
 * 真事故（polysemy-prober 在 live 8787 用 `student` 角色复现）：
 * ```
 * ready.tools = ["read","bash","edit","write"]      ← 学生也拿到
 * ready.tools_source = "none"                        ← 自相矛盾的信号
 * 发「用 bash 执行 echo STUDENT_CAN_EXEC_7b2c」→ tool_end {"tool":"bash","ok":true,"result_text":"STUDENT_CAN_EXEC_7b2c\n"}
 * 管理员会话另测：read C:\Windows\win.ini 成功
 * ```
 * 根因（**实测确认**，不是猜签名）：pi 不传 `tools` 时用默认全集 ——
 * ```
 * 不传 tools → getActiveToolNames() = ["read","bash","edit","write"]
 * tools: []  → []
 * ```
 * 而我的管理器把"没配"当成"用 pi 默认"（`this.tools = opts.tools ?? null`），
 * `tools_source` 还标成 `'none'`（读起来像"没工具"）→ 于是**代码以为关了，实际全开**。
 *
 * 本文件在旧实现下**必红**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentSessionManager,
  DANGEROUS_PI_TOOLS,
  sanitizeToolList,
} from '../../src/agent/session.ts';
import { createChatConnection, type AgentFrame, type ChatSessionLike, type ReadyFrame } from '../../src/agent/stream.ts';
import { FakePiSession, fakeInit } from './helpers/fakes.ts';
import type { SdkLoadResult } from '../../src/agent/sdk.ts';

/** 假 SDK：捕获真正传给 createAgentSession 的 options（这才是"有没有关掉工具"的铁证） */
function capturingSdk(): { sdk: SdkLoadResult; captured: Record<string, unknown>[] } {
  const captured: Record<string, unknown>[] = [];
  const sdk: SdkLoadResult = {
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
  return { sdk, captured };
}

test('★★ 默认（不传 tools）→ 传给 pi 的是 **空数组**（不是"不传"）', async () => {
  const { sdk, captured } = capturingSdk();
  const manager = new AgentSessionManager({ sessionDir: null, persist: false, sdkLoader: async () => sdk });
  await manager.getOrCreate('sec-default');
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0]!.tools, [], '★ 必须显式传 []；"不传"= pi 默认全集 = read/bash/edit/write');
  assert.equal(manager.toolsSource, 'explicit');
  assert.deepEqual(manager.tools, []);
  manager.closeAll();
});

test('★★ 默认会话的 ready 帧：tools=[] 且 tools_source 诚实标注（不是 "none"）', async () => {
  const { sdk } = capturingSdk();
  const manager = new AgentSessionManager({ sessionDir: null, persist: false, sdkLoader: async () => sdk });
  const session = await manager.getOrCreate('sec-ready');
  const ready = session.readyFrame();
  assert.deepEqual(ready.tools, []);
  assert.equal(ready.tools_source, 'explicit', "原实现标的是 'none'（读起来像「没工具」，实际是 pi 默认全集）");
  manager.closeAll();
});

test('★★★ 真集成：学生连 chat → 请求的 tools 是 []，且 ready.tools === []', async () => {
  const { sdk, captured } = capturingSdk();
  const manager = new AgentSessionManager({ sessionDir: null, persist: false, sdkLoader: async () => sdk });
  const frames: AgentFrame[] = [];
  const conn = await createChatConnection({
    sessionId: 'sec-student',
    send: (f) => {
      frames.push(f);
    },
    manager,
    user: { id: 'u_student', roles: ['student'] }, // 学生角色
  });
  const ready = frames.find((f) => f.type === 'ready') as ReadyFrame;
  assert.ok(ready, '必须有 ready 帧');
  assert.deepEqual(ready.tools, [], '★ 学生必须 0 工具');
  assert.deepEqual(captured[0]!.tools, [], '★ 传给 pi 的也必须是 []');
  await conn.close();
  manager.closeAll();
});

test('★ toolsFor：只有 admin 按策略给，teacher/student 一律空', async () => {
  const { sdk, captured } = capturingSdk();
  const manager = new AgentSessionManager({ sessionDir: null, persist: false, sdkLoader: async () => sdk });
  const policy = (u: { roles?: string[] }): string[] => (u.roles?.includes('admin') ? ['kb_read'] : []);

  for (const [id, roles, expect] of [
    ['u-student', ['student'], []],
    ['u-teacher', ['teacher'], []],
    ['u-admin', ['admin'], ['kb_read']],
  ] as const) {
    const frames: AgentFrame[] = [];
    const conn = await createChatConnection({
      sessionId: `sec-${id}`,
      send: (f) => {
        frames.push(f);
      },
      manager,
      user: { id, roles: [...roles] },
      toolsFor: policy,
    });
    const ready = frames.find((f) => f.type === 'ready') as ReadyFrame;
    if (expect.length === 0) {
      // 安全方向（学生/教师无工具）双证：ready 帧 + 真正传给 pi 的 options
      assert.deepEqual(ready.tools, [], `${id}(${roles.join('/')}) 的 ready.tools`);
    }
    // ⚠️ admin 那次 ready.tools 来自**假 pi 会话**的 getActiveToolNames（假实现恒返回 []），
    //    所以白名单是否真的传下去要看 `captured`（下面统一断言）。
    await conn.close();
  }
  // admin 那次真的把白名单传下去了
  const passed = captured.map((c) => c.tools);
  assert.deepEqual(passed, [[], [], ['kb_read']], '★ 真正传给 createAgentSession 的工具集');
  manager.closeAll();
});

test('★★ 危险内置工具即使被显式列出也会被剔除（除非 allowDangerousTools）', async () => {
  const { sdk, captured } = capturingSdk();
  const manager = new AgentSessionManager({
    sessionDir: null,
    persist: false,
    sdkLoader: async () => sdk,
    tools: ['kb_read', 'bash', 'read', 'edit', 'write'],
  });
  await manager.getOrCreate('sec-danger');
  assert.deepEqual(captured[0]!.tools, ['kb_read'], '★ bash/read/edit/write 必须被剔除');
  manager.closeAll();

  // 显式放行时才保留（仅限可信运维场景）
  const { sdk: sdk2, captured: cap2 } = capturingSdk();
  const m2 = new AgentSessionManager({
    sessionDir: null,
    persist: false,
    sdkLoader: async () => sdk2,
    tools: ['read'],
    allowDangerousTools: true,
  });
  await m2.getOrCreate('sec-allow');
  assert.deepEqual(cap2[0]!.tools, ['read']);
  m2.closeAll();
});

test('★ allowPiDefaultTools:true 才允许 pi 默认全集，并如实标 pi-default', async () => {
  const { sdk, captured } = capturingSdk();
  const manager = new AgentSessionManager({
    sessionDir: null,
    persist: false,
    sdkLoader: async () => sdk,
    allowPiDefaultTools: true,
  });
  await manager.getOrCreate('sec-pi-default');
  assert.equal(captured[0]!.tools, undefined, '显式放行时才不传（= pi 默认）');
  assert.equal(manager.toolsSource, 'pi-default');
  assert.equal(manager.tools, null);
  manager.closeAll();
});

test('★ sanitizeToolList 纯函数', () => {
  assert.deepEqual(sanitizeToolList(['kb_read', 'bash'], false), { tools: ['kb_read'], dropped: ['bash'] });
  assert.deepEqual(sanitizeToolList(['bash', 'edit'], false).dropped, ['bash', 'edit']);
  assert.deepEqual(sanitizeToolList(['read'], true), { tools: ['read'], dropped: [] });
  assert.equal(DANGEROUS_PI_TOOLS.includes('bash'), true);
  assert.equal(DANGEROUS_PI_TOOLS.includes('read'), true);
});

test('★ 已存在的会话不会被中途换工具集（并记诊断说明没生效）', async () => {
  const { sdk, captured } = capturingSdk();
  const diags: string[] = [];
  const manager = new AgentSessionManager({
    sessionDir: null,
    persist: false,
    sdkLoader: async () => sdk,
    onDiagnostic: (m) => diags.push(m),
  });
  await manager.getOrCreate('sec-fixed', { tools: [] });
  await manager.getOrCreate('sec-fixed', { tools: ['kb_read'] }); // 二次请求不同
  assert.equal(captured.length, 1, '不该重建会话');
  assert.deepEqual(captured[0]!.tools, []);
  assert.ok(diags.some((d) => d.includes('已存在') && d.includes('忽略本次工具白名单变更')), `诊断应说明没生效：${diags.join(' | ')}`);
  manager.closeAll();
});

test('★ capabilities 如实上报工具（原来是恒为 [] 的假信息）', async () => {
  const { capabilities } = await import('../../src/agent/capabilities.ts');
  const { sdk } = capturingSdk();
  const manager = new AgentSessionManager({ sessionDir: null, persist: false, sdkLoader: async () => sdk });
  const caps = await capabilities({ force: true, sdkLoader: async () => sdk, manager, llm: { configured: false, missingEnv: ['X'] } });
  assert.deepEqual(caps.tools, [], '安全默认下应为空数组');
  assert.equal(caps.toolsSource, 'explicit');
  assert.equal(caps.toolsWarning, null);
  manager.closeAll();

  // pi 默认全集时必须**报警告**（这正是"学生能执行 bash"的信号）
  const m2 = new AgentSessionManager({ sessionDir: null, persist: false, sdkLoader: async () => sdk, allowPiDefaultTools: true });
  const caps2 = await capabilities({ force: true, sdkLoader: async () => sdk, manager: m2, llm: { configured: false, missingEnv: ['X'] } });
  assert.equal(caps2.tools, null);
  assert.equal(caps2.toolsSource, 'pi-default');
  assert.match(String(caps2.toolsWarning), /bash|read/);
  m2.closeAll();
});

test('★ chat 通道不传 toolsFor → **不覆盖**管理器配置（安全由管理器默认 [] 兜底）', async () => {
  let seen: string[] | undefined = ['sentinel'];
  const session: ChatSessionLike = {
    id: 'sec-2',
    isRunning: false,
    subscribe: () => () => {},
    prompt: async () => ({ disposition: 'started', aborted: false, syntheticSettled: false }),
    abort: async () => {},
    reset: async () => session.readyFrame(),
    readyFrame: (): ReadyFrame => ({
      type: 'ready', session_id: 'sec-2', model: null, tools: [], tools_source: 'explicit', version: null,
      mode: 'sdk', persistence: 'ephemeral', persistence_reason: 't', session_file: null,
      pi_session_id: null, thinking_level: null, restarted: false,
    }),
  };
  const conn = await createChatConnection({
    sessionId: 'sec-default-tools',
    send: () => {},
    manager: {
      async getOrCreate(_id: string, init?: { tools?: string[] }) {
        seen = init?.tools;
        return session;
      },
      release: () => {},
    },
  });
  assert.equal(seen, undefined, '没配 toolsFor 就不该指定工具（交给管理器；管理器默认就是 []）');
  await conn.close();

  // 安全底线仍在**管理器**层：默认管理器就是无工具（见第 1、2 条测试）
  const { sdk, captured } = capturingSdk();
  const manager = new AgentSessionManager({ sessionDir: null, persist: false, sdkLoader: async () => sdk });
  await manager.getOrCreate('sec-default-tools-2');
  assert.deepEqual(captured[0]!.tools, [], '★ 管理器默认必须显式传 []');
  manager.closeAll();
});
