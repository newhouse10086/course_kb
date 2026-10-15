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

test('★★ 三角色（含 admin）默认都没有工具：toolsFor 不再单独发放', async () => {
  const { sdk, captured } = capturingSdk();
  const manager = new AgentSessionManager({ sessionDir: null, persist: false, sdkLoader: async () => sdk });
  const policy = (u: { roles?: string[] }): string[] => (u.roles?.includes('admin') ? ['kb_read'] : []);

  for (const [id, roles, expect] of [
    ['u-student', ['student'], []],
    ['u-teacher', ['teacher'], []],
    ['u-admin', ['admin'], []],
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
    // ★ 新契约：`toolsFor` 只在危险开关下生效 → 三个角色**都**是空集
    //   （admin 也不例外：lead 裁定"管理员不等于可以借浏览器执行主机命令"）
    assert.deepEqual(ready.tools, [], `${id}(${roles.join('/')}) 的 ready.tools`);
    assert.equal(ready.tools_source, 'disabled-by-role', `${id} 的来源标注`);
    await conn.close();
  }
  const passed = captured.map((c) => c.tools);
  assert.deepEqual(passed, [[], [], []], '★ 真正传给 createAgentSession 的工具集（三角色全空）');
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

test('★ allowPiDefaultTools:true 才允许 pi 默认全集，并标刺眼的 dangerous-opt-in', async () => {
  const { sdk, captured } = capturingSdk();
  const manager = new AgentSessionManager({
    sessionDir: null,
    persist: false,
    sdkLoader: async () => sdk,
    allowPiDefaultTools: true,
  });
  await manager.getOrCreate('sec-pi-default');
  assert.equal(captured[0]!.tools, undefined, '显式放行时才不传（= pi 默认）');
  // 命名刻意刺眼：lead 裁定不要把它做成「管理员就该有」的默认
  assert.equal(manager.toolsSource, 'dangerous-opt-in');
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
  assert.equal(caps2.toolsSource, 'dangerous-opt-in');
  assert.match(String(caps2.toolsWarning), /bash|read/);
  m2.closeAll();
});

test('★★ 通道层三态策略：disabled-by-role / explicit / dangerous-opt-in（与 tools 永远一致）', async () => {
  function probe(connOpts: Record<string, unknown>, managerTools: string[] | null = []) {
    const seen: { tools?: string[] } = {};
    const frames: AgentFrame[] = [];
    const session: ChatSessionLike = {
      id: 'p',
      isRunning: false,
      subscribe: () => () => {},
      prompt: async () => ({ disposition: 'started', aborted: false, syntheticSettled: false }),
      abort: async () => {},
      reset: async () => session.readyFrame(),
      readyFrame: (): ReadyFrame => ({
        type: 'ready', session_id: 'p', model: null, tools: [], tools_source: 'explicit', version: null,
        mode: 'sdk', persistence: 'ephemeral', persistence_reason: 't', session_file: null,
        pi_session_id: null, thinking_level: null, restarted: false,
      }),
    };
    return (async () => {
      const conn = await createChatConnection({
        sessionId: 'policy-probe',
        send: (f) => {
          frames.push(f);
        },
        manager: {
          get tools() {
            return managerTools;
          },
          async getOrCreate(_id: string, init?: { tools?: string[] }) {
            seen.tools = init?.tools;
            return session;
          },
          release: () => {},
        },
        ...connOpts,
      });
      await conn.close();
      return { passedTools: seen.tools, ready: frames.find((f) => f.type === 'ready') as ReadyFrame };
    })();
  }

  // ① 什么都不传（缺省）→ **显式空数组** + disabled-by-role
  const a = await probe({});
  assert.deepEqual(a.passedTools, [], '★ 必须显式传 []（不依赖"不传 = 空"这种隐式默认）');
  assert.equal(a.ready.tools_source, 'disabled-by-role');

  // ② teacher/student（allowTools=false）→ 同上
  const b = await probe({ allowTools: false, user: { id: 'u1', roles: ['student'] } });
  assert.deepEqual(b.passedTools, []);
  assert.equal(b.ready.tools_source, 'disabled-by-role');

  // ★★ ③ admin（allowTools=true）→ **也是空集**（lead 裁定：管理员不等于可以借浏览器执行主机命令）
  const c = await probe({ allowTools: true, user: { id: 'a1', roles: ['admin'] } }, null);
  assert.deepEqual(c.passedTools, [], '★ admin 默认也必须显式传 []（不依赖角色推断危险能力）');
  assert.equal(c.ready.tools_source, 'disabled-by-role');

  // ③' admin + 管理器放行过 pi 默认 → 仍被连接层按策略关掉（连接层是权威）
  const c2 = await probe({ allowTools: true, user: { id: 'a1', roles: ['admin'] } }, null);
  assert.deepEqual(c2.passedTools, [], '管理器配了什么都不能让 admin 悄悄拿到全集');

  // ④ ★ 新契约：要只读知识库工具走 **mode:'agent'**（不是靠通用 `tools` 白名单）
  const kbMode = await probe({ mode: 'agent', user: { id: 'a1', roles: ['admin'] } });
  assert.deepEqual(kbMode.passedTools, ['kb_search', 'kb_get'], 'agent 模式 → 只给只读 kb 工具');
  assert.equal(kbMode.ready.tools_source, 'kb-readonly');
  assert.deepEqual(
    (kbMode.passedTools ?? []).filter((t) => ['bash', 'read', 'edit', 'write'].includes(t)),
    [],
    '★ agent 模式绝不含危险内置工具',
  );

  // ④' 通用白名单不再能单独发放工具（没有危险开关就不生效）
  const d = await probe({ allowTools: true, tools: ['kb_read'], user: { id: 'a1', roles: ['admin'] } });
  assert.deepEqual(d.passedTools, [], '没有 dangerousTools 开关时，通用白名单不生效');
  assert.equal(d.ready.tools_source, 'disabled-by-role');

  // ⑤ ★ 危险 opt-in 必须**独立开关**（不来自角色）→ 才允许落到 pi 默认
  const g = await probe({ dangerousTools: true, user: { id: 'a1', roles: ['admin'] } });
  assert.equal(g.passedTools, undefined, '危险 opt-in：交给管理器（它还需 allowPiDefaultTools）');
  assert.equal(g.ready.tools_source, 'dangerous-opt-in');
  // ★ 危险状态要**在帧里说出来**（独立验收建议：免得教师借 admin 账号演示时把 shell 交给学生）
  assert.match(String(g.ready.tools_warning), /主机工具|bash/);
  assert.match(String(g.ready.tools_warning), /演示|共享账号|浏览器/);
  // 安全状态下不能有这条警告（否则成噪音、失去警示作用）
  assert.equal(a.ready.tools_warning, undefined, '默认（无工具）不该有危险警告');
  assert.equal(kbMode.ready.tools_warning, undefined, 'kb-readonly 不是危险状态，不该有危险警告');

  // ⑤' 危险 opt-in + 白名单 → 白名单生效（仍在危险策略下）
  const g2 = await probe({ dangerousTools: true, tools: ['kb_read'] });
  assert.deepEqual(g2.passedTools, ['kb_read']);

  // ⑥ toolsFor 只在危险开关下生效（避免"按角色自定义"绕过安全边界）
  const e = await probe({
    dangerousTools: true,
    toolsFor: (u: { roles?: string[] }) => (u.roles?.includes('admin') ? ['kb_read'] : []),
    user: { id: 'a1', roles: ['admin'] },
  });
  assert.deepEqual(e.passedTools, ['kb_read']);
  const eNoSwitch = await probe({
    toolsFor: (u: { roles?: string[] }) => (u.roles?.includes('admin') ? ['kb_read'] : []),
    user: { id: 'a1', roles: ['admin'] },
  });
  assert.deepEqual(eNoSwitch.passedTools, [], '没有危险开关时，toolsFor 也不发放工具');
  const f = await probe({
    toolsFor: (u: { roles?: string[] }) => (u.roles?.includes('admin') ? ['kb_read'] : []),
    user: { id: 's1', roles: ['student'] },
  });
  assert.deepEqual(f.passedTools, []);
  assert.equal(f.ready.tools_source, 'disabled-by-role');
});
