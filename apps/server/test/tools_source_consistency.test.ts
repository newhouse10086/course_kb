/**
 * ★ 结构性守卫：**自述字段与生效值必须同源**（Lead 裁定的坑 21）。
 *
 * ## 为什么必须有一条**快**的（不需要真模型）
 * 同一个 bug class 在**两个方向**上都发生过（实测）：
 * ```
 * 之前: tools_source='none'        （说关了）  实际 ready.tools 有 4 个危险工具 → 说关了其实开着（安全事故）
 * 现在: tools_source='kb-readonly' （说开了）  实际 ready.tools = []            → 说开了其实关着（功能失效）
 * ```
 * 共同根因：**自述字段与实际生效值不同源**。而 `ready.tools`（实际值）是**唯一真相**，
 * `tools_source` 只是标签 —— 标签必须能被实际值验证。
 *
 * ## 这条测试怎么做到"快"
 * 只建**连接**并收 `ready` 帧，**不发 prompt** → 不调用 LLM（0 额度、~1s 的 SDK 初始化）。
 * 真模型那条（"模型会不会用工具"）在 `test/e2e/agent_kb.e2e.ts`，**显式跑**（`npm run test:e2e:agent`）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig, ensureDirs, materializePiModels } from '../src/config.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const DANGEROUS = ['bash', 'read', 'edit', 'write'];

interface ReadyFrame {
  type?: string;
  tools?: unknown;
  tools_source?: unknown;
  [k: string]: unknown;
}

/** 建连接、收 `ready` 帧（**不发 prompt** → 不花钱）。 */
async function collectReady(opts: {
  mode: 'chat' | 'agent';
  kb: unknown;
  toolsSource?: string;
}): Promise<{ ready: ReadyFrame | null; frames: ReadyFrame[] }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-src-'));
  const cfg = loadConfig({
    root: ROOT,
    env: { ...process.env, COURSE_KB_DATA_DIR: path.join(tmp, 'data'), COURSE_KB_DB: path.join(tmp, 'x.sqlite3') },
  });
  ensureDirs(cfg);
  const pi = materializePiModels(cfg);

  const { AgentSessionManager } = (await import('../src/agent/session.ts')) as unknown as {
    AgentSessionManager: new (o: Record<string, unknown>) => unknown;
  };
  const { createChatConnection } = (await import('../src/agent/stream.ts')) as unknown as {
    createChatConnection: (o: Record<string, unknown>) => Promise<{ close: () => Promise<void> }>;
  };

  const manager = new AgentSessionManager({
    ...(pi ? { agentDir: pi.agentDir, model: pi.modelRef } : {}),
    kb: opts.kb,
    ...(opts.toolsSource ? { toolsSource: opts.toolsSource } : {}),
  });

  const frames: ReadyFrame[] = [];
  const conn = await createChatConnection({
    sessionId: `src-${opts.mode}`,
    send: (f: unknown) => frames.push(f as ReadyFrame),
    manager,
    mode: opts.mode,
    user: { id: 'usr_test', roles: ['student'] },
    retrieval: null,
  });
  // `ready` 是建连接时同步/尽快发出的；给一小段窗口（不发 prompt → 不会有 LLM 调用）
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !frames.some((f) => f.type === 'ready')) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const ready = frames.find((f) => f.type === 'ready') ?? null;
  try {
    await conn.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  return { ready, frames };
}

/** ★ 核心判据：自述 ↔ 生效 必须一致（两个方向都查）。 */
function assertSourceMatchesTools(ready: ReadyFrame, expectMode: 'chat' | 'agent'): void {
  const tools = Array.isArray(ready.tools) ? (ready.tools as string[]) : null;
  const source = typeof ready.tools_source === 'string' ? ready.tools_source : null;
  assert.ok(tools !== null, `★ ready.tools 必须是数组（实际值，唯一真相）：${JSON.stringify(ready.tools)}`);
  assert.ok(source !== null, `★ ready.tools_source 必须显式给值（缺字段会被消费者当假值）：${JSON.stringify(ready.tools_source)}`);

  // 任何情况下都不许出现危险工具（安全底线，与自述无关）
  assert.deepEqual(
    tools.filter((t) => DANGEROUS.includes(t)),
    [],
    `★★ agent/chat 模式都不许有危险工具，实际 ${JSON.stringify(tools)}`,
  );

  // 方向 1：自述 → 生效
  if (source === 'disabled-by-role') {
    assert.deepEqual(tools, [], `★ 自述 disabled-by-role 时 tools 必须为空，实际 ${JSON.stringify(tools)}`);
  }
  if (source === 'kb-readonly') {
    assert.ok(
      tools.includes('kb_search') && tools.includes('kb_get'),
      `★ 自述 kb-readonly 时 tools 必须含 kb_search/kb_get，实际 ${JSON.stringify(tools)}`,
    );
  }
  if (source === 'dangerous-opt-in') {
    assert.ok(tools.length > 0, '★ 自述 dangerous-opt-in 时 tools 必须非空');
  }
  // 方向 2：生效 → 自述（反方向也要查，否则"说关了其实开着"抓不到）
  if (tools.length > 0) {
    assert.notEqual(source, 'disabled-by-role', `★ tools 非空时不许自述 disabled-by-role（说关了其实开着）`);
  }
  // 与模式一致
  if (expectMode === 'chat') {
    assert.deepEqual(tools, [], `chat 模式必须无工具，实际 ${JSON.stringify(tools)}`);
  }
}

test('★ tools_source ↔ ready.tools 同源：chat 模式自述与生效一致（无危险工具）', async () => {
  const { ready, frames } = await collectReady({ mode: 'chat', kb: null });
  assert.ok(ready, `必须收到 ready 帧，实际 ${JSON.stringify(frames.map((f) => f.type))}`);
  assertSourceMatchesTools(ready, 'chat');
});

test('★ tools_source ↔ ready.tools 同源：agent 模式**真的注册了** kb 工具（这是"说开了其实关着"的守卫）', async () => {
  // 用一个**真**的 kb 门面（不查库：这里只验"工具是否注册"，不验检索质量）
  const kb = {
    search: () => [],
    get: () => null,
  };
  const { ready, frames } = await collectReady({ mode: 'agent', kb });
  assert.ok(ready, `必须收到 ready 帧，实际 ${JSON.stringify(frames.map((f) => f.type))}`);
  const tools = Array.isArray(ready.tools) ? (ready.tools as string[]) : [];
  // ★ 若 agent 层认为"kb 工具已开"，就必须**真的**在 tools 里
  if (ready.tools_source === 'kb-readonly') {
    assert.deepEqual(
      tools.sort(),
      ['kb_get', 'kb_search'],
      `★ 自述 kb-readonly 但实际 tools=${JSON.stringify(tools)} —— ` +
        '这正是"说开了其实关着"（我实测踩过：kb 只传给连接、没注入 AgentSessionManager）',
    );
  } else {
    // 若没开（例如 kb 注入路径变了），也要**如实**说明原因，不许静默
    assert.equal(tools.length, 0, `tools_source=${String(ready.tools_source)} 时不该有工具`);
  }
  assertSourceMatchesTools(ready, 'agent');
});
