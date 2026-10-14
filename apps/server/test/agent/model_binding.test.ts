/**
 * ★ 两个真机事故的回归测试（polysemy-prober 验收抓出）：
 *
 * **事故 1：chat 发 prompt 静默无响应**
 *   `createAgentSession` 没传 `model` → pi 回落**全局默认**（`~/.pi/agent/settings.json`
 *   的 `glm-5.2`/`opencode-go`，key 已 401），而项目配置是 `amr/deepseek-v4.1-flash`
 *   → `ready`/`/settings`/`/capabilities` 三处两个答案，且 401 后**一帧都不发**，永远转圈。
 *
 * **事故 2：上游失败没有转成错误帧**
 *   SDK 的 `prompt()` 在某些上游失败下既不 resolve、也不发可映射事件 → 客户端无限等待。
 *
 * 本文件覆盖：模型注入（injected/resolved/pi-global-fallback 三态 + warning 外显）
 * 与**硬超时看门狗**（到点必须发 E_PI_TIMEOUT + settled）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentSessionManager,
  DEFAULT_PROMPT_TIMEOUT_MS,
  resolveConfiguredModelRef,
} from '../../src/agent/session.ts';
import type { SdkLoadResult } from '../../src/agent/sdk.ts';
import type { AgentFrame } from '../../src/agent/stream.ts';
import { FakePiSession, fakeInit } from './helpers/fakes.ts';

// ---------------------------------------------------------------------------
// 假 SDK：捕获 createAgentSession 收到的 options
// ---------------------------------------------------------------------------

function makeFakeSdk(over: {
  models?: Record<string, unknown>;
  noRuntime?: boolean;
  createThrows?: Error;
} = {}): { sdk: SdkLoadResult; captured: Record<string, unknown>[] } {
  const captured: Record<string, unknown>[] = [];
  const sdk: SdkLoadResult = {
    available: true,
    createAgentSession: (async (options?: unknown) => {
      if (over.createThrows) throw over.createThrows;
      captured.push((options ?? {}) as Record<string, unknown>);
      const fake = new FakePiSession({ sessionFile: null, persistence: 'ephemeral' });
      return { session: fake as never };
    }) as never,
    SessionManager: {
      create: () => ({ getEntries: () => [], getSessionId: () => 'pi-1', getSessionFile: () => undefined }),
      inMemory: () => ({ getEntries: () => [], getSessionId: () => 'pi-1', getSessionFile: () => undefined }),
      open: () => ({ getEntries: () => [], getSessionId: () => 'pi-1', getSessionFile: () => undefined }),
    } as never,
    version: '1.2.0',
    loadMs: 1,
    specifier: 'fake',
    ...(over.noRuntime
      ? {}
      : {
          ModelRuntime: {
            async create() {
              return {
                getModel: (providerId: string, modelId: string) => over.models?.[`${providerId}/${modelId}`] ?? undefined,
              };
            },
          },
        }),
  };
  return { sdk, captured };
}

const AMR_MODEL = { id: 'deepseek-v4.1-flash', provider: 'amr', api: 'openai-completions' };

function managerWith(sdk: SdkLoadResult, extra: Record<string, unknown> = {}): AgentSessionManager {
  return new AgentSessionManager({ sessionDir: null, persist: false, sdkLoader: async () => sdk, ...extra });
}

// ---------------------------------------------------------------------------
// 1. 模型注入
// ---------------------------------------------------------------------------

test('★ 注入 Model 对象 → options.model 就是它，model_source=injected', async () => {
  const { sdk, captured } = makeFakeSdk();
  const manager = managerWith(sdk, { model: AMR_MODEL });
  const session = await manager.getOrCreate('m1');
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.model, AMR_MODEL, '★ 必须把 Model 传给 createAgentSession（否则 pi 用全局默认）');
  const ready = session.readyFrame();
  assert.equal(ready.model_source, 'injected');
  assert.equal(ready.model_warning, undefined);
  manager.closeAll();
});

test('★ 传 "provider/model" 字符串 → 用 ModelRuntime 解析成 Model，model_source=resolved', async () => {
  const { sdk, captured } = makeFakeSdk({ models: { 'amr/deepseek-v4.1-flash': AMR_MODEL } });
  const manager = managerWith(sdk, { model: 'amr/deepseek-v4.1-flash', agentDir: 'C:/tmp/agent' });
  const session = await manager.getOrCreate('m2');
  assert.equal(captured[0]!.model, AMR_MODEL);
  assert.equal(session.readyFrame().model_source, 'resolved');
  assert.equal(session.readyFrame().model_warning, undefined);
  manager.closeAll();
});

test('★★ 模型解析不出来 → 如实标 pi-global-fallback + warning（绝不静默用错模型）', async () => {
  const { sdk, captured } = makeFakeSdk({ models: {} }); // 目录里没有这个模型
  const manager = managerWith(sdk, { model: 'amr/not-in-catalog', agentDir: 'C:/tmp/agent' });
  const session = await manager.getOrCreate('m3');
  assert.equal(captured[0]!.model, undefined, '解析不出来就不该乱传');
  const ready = session.readyFrame();
  assert.equal(ready.model_source, 'pi-global-fallback');
  assert.ok(ready.model_warning, '★ 必须有 warning，不许静默');
  assert.match(ready.model_warning!, /not-in-catalog/);
  assert.match(ready.model_warning!, /全局默认/);
  manager.closeAll();
});

test('★ 完全没有 ModelRuntime → 也是 fallback + warning（说明原因）', async () => {
  const { sdk, captured } = makeFakeSdk({ noRuntime: true });
  const manager = managerWith(sdk, { model: 'amr/x', agentDir: 'C:/tmp/agent' });
  const session = await manager.getOrCreate('m4');
  assert.equal(captured[0]!.model, undefined);
  const ready = session.readyFrame();
  assert.equal(ready.model_source, 'pi-global-fallback');
  assert.match(ready.model_warning!, /ModelRuntime/);
  manager.closeAll();
});

test('★ 没给 model 时：尝试项目配置，解析不到同样要 warning（不是无声回落）', async () => {
  const { sdk, captured } = makeFakeSdk({ models: {} });
  const manager = managerWith(sdk, { agentDir: 'C:/tmp/agent' });
  const session = await manager.getOrCreate('m5');
  assert.equal(captured[0]!.model, undefined);
  const ready = session.readyFrame();
  assert.equal(ready.model_source, 'pi-global-fallback');
  assert.ok(ready.model_warning && ready.model_warning.length > 10);
  manager.closeAll();
});

test('resolveConfiguredModelRef：能从环境变量得到 provider/model（与 /capabilities 同源）', async () => {
  const savedModel = process.env.LLM_MODEL;
  const savedProvider = process.env.LLM_PROVIDER;
  try {
    process.env.LLM_MODEL = 'deepseek-v4.1-flash';
    process.env.LLM_PROVIDER = 'amr';
    assert.equal(await resolveConfiguredModelRef(), 'amr/deepseek-v4.1-flash');
    delete process.env.LLM_PROVIDER;
    assert.equal(await resolveConfiguredModelRef(), 'amr/deepseek-v4.1-flash', '没有 provider 时默认 amr（与检出器一致）');
  } finally {
    if (savedModel === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = savedModel;
    if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = savedProvider;
  }
});

// ---------------------------------------------------------------------------
// 2. ★ 硬超时看门狗（不许让客户端无限等待）
// ---------------------------------------------------------------------------

class HangingFake extends FakePiSession {
  override async prompt(): Promise<void> {
    // 永远不 resolve、也不发任何事件（模拟"上游失败后静默挂起"）
    await new Promise<void>(() => {});
  }
}

test('★★ 上游挂起（prompt 永不 resolve）→ 硬超时 → E_PI_TIMEOUT + settled，绝不无限等待', async () => {
  const fake = new HangingFake({ sessionFile: null, persistence: 'ephemeral' });
  const manager = new AgentSessionManager({
    sessionDir: null,
    persist: false,
    promptTimeoutMs: 60, // 测试用极短超时
    sessionFactory: async () => fakeInit(fake),
  });
  const session = await manager.getOrCreate('hang-1');
  const frames: AgentFrame[] = [];
  session.subscribe((f) => frames.push(f));

  const started = Date.now();
  const outcome = await session.prompt('会挂住的一轮');
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2000, `必须靠超时结束，实际 ${elapsed}ms`);
  assert.equal(outcome.disposition, 'timeout');
  assert.equal(outcome.syntheticSettled, true);

  const err = frames.find((f) => f.type === 'error');
  assert.ok(err, '★ 必须发 error 帧（真机上这里一帧都没有 → 前端永远转圈）');
  assert.equal(err.type === 'error' ? err.code : '', 'E_PI_TIMEOUT');
  assert.match(String(err.type === 'error' ? err.msg : ''), /120|秒|结束信号/);
  assert.match(String(err.type === 'error' ? err.hint : ''), /pi SDK 正常/);
  assert.equal(frames.filter((f) => f.type === 'settled').length, 1, '恰好一条 settled');
  assert.equal(frames.at(-1)?.type, 'settled', 'settled 必须是最后一帧');
  assert.equal(session.isRunning, false, '★ 超时后必须回到空闲（否则后续提问全被拒）');

  // 超时后**还能继续用**（不能被永久卡住）
  const again = await session.prompt('再来一次');
  assert.equal(again.disposition, 'timeout');
  manager.closeAll();
});

test('★ 默认超时是 120s（不是无限）', () => {
  const manager = new AgentSessionManager({ sessionDir: null, persist: false });
  assert.equal(manager.promptTimeoutMs, DEFAULT_PROMPT_TIMEOUT_MS);
  assert.equal(DEFAULT_PROMPT_TIMEOUT_MS, 120_000);
  manager.closeAll();
});

test('★ 正常一轮不受看门狗影响（settled 到了就清掉计时器）', async () => {
  const fake = new FakePiSession({ sessionFile: null, persistence: 'ephemeral' });
  fake.emitBeforeResolve = [{ type: 'agent_settled', aborted: false }];
  const manager = new AgentSessionManager({
    sessionDir: null,
    persist: false,
    promptTimeoutMs: 5000,
    sessionFactory: async () => fakeInit(fake),
  });
  const session = await manager.getOrCreate('ok-1');
  const frames: AgentFrame[] = [];
  session.subscribe((f) => frames.push(f));
  const outcome = await session.prompt('正常一轮');
  assert.equal(outcome.disposition, 'started');
  assert.equal(frames.filter((f) => f.type === 'error').length, 0, '不该有 error');
  assert.equal(frames.filter((f) => f.type === 'settled').length, 1);
  manager.closeAll();
});

test('★ 看门狗的超时长度可配（生产默认 120s）', async () => {
  const { sdk } = makeFakeSdk();
  const m1 = managerWith(sdk, { promptTimeoutMs: 30_000 });
  assert.equal(m1.promptTimeoutMs, 30_000);
  const m2 = managerWith(sdk, {});
  assert.equal(m2.promptTimeoutMs, 120_000);
  m1.closeAll();
  m2.closeAll();
});
