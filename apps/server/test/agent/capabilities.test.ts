/**
 * `capabilities.ts` 单测：**两层探测**（契约 §5.1 + §7.3.1「available 的语义边界」）。
 *
 * 最关键的一条：**模型失败不许把 `pi.available` 置 false**（那是撒谎），
 * 反之 SDK 失败时 `model` 也不该被当成"模型的问题"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITIES_TTL_MS,
  capabilities,
  clearCapabilitiesCache,
  probeLlmEndpoint,
} from '../../src/agent/capabilities.ts';
import type { SdkLoadResult } from '../../src/agent/sdk.ts';

const okSdk: SdkLoadResult = {
  available: true,
  createAgentSession: async () => {
    throw new Error('不该被调用');
  },
  SessionManager: {} as never,
  version: '1.2.0',
  loadMs: 4127,
  specifier: '@earendil-works/pi-coding-agent',
};

const badSdk: SdkLoadResult = {
  available: false,
  specifier: '@earendil-works/pi-coding-agent',
  reason: 'pi SDK 未安装：@earendil-works/pi-coding-agent 无法解析（在 apps/server 下执行 npm install）',
  detail: 'ERR_MODULE_NOT_FOUND: Cannot find package',
  loadMs: 3,
};

/** 造一个假的 OpenAI 兼容响应 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const REAL_402_BODY = {
  error: {
    code: 'insufficient_balance',
    details: { coding_plan_exhausted: true, reset_at: '2026-10-14T15:44:45Z' },
    message: '[code=insufficient_balance] Coding Plan quota is exhausted and wallet balance is insufficient.',
    type: 'insufficient_balance',
  },
};

// ===========================================================================
// 第 1 层：SDK
// ===========================================================================

test('第 1 层：SDK 可加载 → available:true + version + loadMs', async () => {
  clearCapabilitiesCache();
  const caps = await capabilities({
    sdkLoader: async () => okSdk,
    llm: { baseUrl: 'https://x/v1', apiKey: 'k'.repeat(20), model: 'm' },
    fetchImpl: async () => jsonResponse(200, { choices: [{ message: { content: 'pong' } }] }),
    force: true,
  });
  assert.equal(caps.available, true);
  assert.equal(caps.version, '1.2.0');
  assert.equal(caps.loadMs, 4127);
  assert.equal(caps.mode, 'sdk');
  assert.equal(caps.reason, '');
  assert.equal(caps.model.available, true);
  assert.equal(caps.degraded, false);
});

test('第 1 层：SDK 装不上 → available:false + 可读 reason（**不抛**）', async () => {
  clearCapabilitiesCache();
  const caps = await capabilities({
    sdkLoader: async () => badSdk,
    llm: { configured: false, missingEnv: ['AMR_KEY'] },
    force: true,
  });
  assert.equal(caps.available, false);
  assert.equal(caps.version, null);
  assert.match(caps.reason, /未安装|无法解析/);
  assert.match(caps.reason, /npm install/);
});

test('sdkLoader 抛异常也不许把 capabilities() 掀翻', async () => {
  clearCapabilitiesCache();
  const caps = await capabilities({
    sdkLoader: async () => {
      throw new Error('loader 炸了');
    },
    llm: { configured: false },
    force: true,
  });
  assert.equal(caps.available, false);
  assert.match(caps.reason, /loader 炸了/);
});

// ===========================================================================
// ★ 第 2 层：模型真探测（不许把两层混为一谈）
// ===========================================================================

test('★★ 模型 402 额度耗尽 → pi.available 仍为 true（不撒谎），model.available=false 且带 resetAt', async () => {
  clearCapabilitiesCache();
  const calls: string[] = [];
  const caps = await capabilities({
    sdkLoader: async () => okSdk,
    llm: { providerId: 'amr', baseUrl: 'https://amr-link.open-design.ai/v1', apiKey: 'sk-'.padEnd(30, 'x'), model: 'deepseek-v4.1-flash', configured: true },
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse(402, REAL_402_BODY);
    },
    force: true,
  });

  assert.equal(caps.available, true, '★ SDK 是好的，绝不能因为模型失败就报 available:false');
  assert.equal(caps.model.available, false);
  assert.equal(caps.model.configured, true);
  assert.equal(caps.model.probe, 'live');
  assert.equal(caps.model.httpStatus, 402);
  assert.equal(caps.model.resetAt, '2026-10-14T15:44:45Z', '要把额度重置时间提出来（对用户有用）');
  assert.match(caps.model.reason, /额度已耗尽/);
  assert.equal(caps.model.endpointHost, 'amr-link.open-design.ai');
  assert.equal(caps.degraded, true, 'SDK 可用但模型不可用 = degraded');

  // 探测的是 OpenAI 兼容端点，且带上了 model
  assert.deepEqual(calls, ['https://amr-link.open-design.ai/v1/chat/completions']);
});

test('★ 模型 403 无订阅（真实串）→ reason 指向订阅，且不泄漏 apiKey', async () => {
  clearCapabilitiesCache();
  const secret = 'sk-super-secret-key-1234567890';
  const caps = await capabilities({
    sdkLoader: async () => okSdk,
    llm: { providerId: 'opencode-go', baseUrl: 'https://opencode.ai/inference/go/v1', apiKey: secret, model: 'glm-5.2', configured: true },
    fetchImpl: async () =>
      jsonResponse(403, {
        type: 'server_error',
        message: 'Upstream request failed: An active OpenCode Go subscription is required to use Go models.',
      }),
    force: true,
  });
  assert.equal(caps.available, true);
  assert.equal(caps.model.available, false);
  assert.match(caps.model.reason, /订阅/);
  assert.ok(!JSON.stringify(caps).includes(secret), '★ 返回值里绝不能出现 apiKey');
});

test('模型探测网络失败 → probe=failed + 网络类 reason（不是 SDK 的错）', async () => {
  clearCapabilitiesCache();
  const caps = await capabilities({
    sdkLoader: async () => okSdk,
    llm: { baseUrl: 'https://nope.invalid/v1', apiKey: 'k'.repeat(20), model: 'm', configured: true },
    fetchImpl: async () => {
      throw new Error('fetch failed');
    },
    force: true,
  });
  assert.equal(caps.available, true);
  assert.equal(caps.model.probe, 'failed');
  assert.equal(caps.model.available, false);
  assert.match(caps.model.reason, /网络|DNS/);
});

test('缺凭据 → model.probe=not-run + configured:false + 缺哪个变量名（不许发请求）', async () => {
  clearCapabilitiesCache();
  let fetched = 0;
  const caps = await capabilities({
    sdkLoader: async () => okSdk,
    llm: { configured: false, missingEnv: ['AMR_KEY', 'LLM_MODEL'] },
    fetchImpl: async () => {
      fetched += 1;
      return jsonResponse(200, {});
    },
    force: true,
  });
  assert.equal(fetched, 0, '缺凭据就不该发请求');
  assert.equal(caps.model.probe, 'not-run');
  assert.equal(caps.model.configured, false);
  assert.match(caps.model.reason, /AMR_KEY/);
  assert.match(caps.model.reason, /LLM_MODEL/);
});

test('sdkOnly → 跳过模型探测（很快，供高频路径）', async () => {
  clearCapabilitiesCache();
  let fetched = 0;
  const caps = await capabilities({
    sdkOnly: true,
    sdkLoader: async () => okSdk,
    fetchImpl: async () => {
      fetched += 1;
      return jsonResponse(200, {});
    },
    force: true,
  });
  assert.equal(fetched, 0);
  assert.equal(caps.model.probe, 'not-run');
  assert.equal(caps.available, true);
});

test('注入 modelProbe（可复用 T-PROVIDERS 的 healthCheck）', async () => {
  clearCapabilitiesCache();
  let seen: unknown = null;
  const caps = await capabilities({
    sdkLoader: async () => okSdk,
    llm: { providerId: 'amr', configured: true },
    modelProbe: async (creds) => {
      seen = creds;
      return {
        configured: true,
        available: true,
        model: 'from-injected-probe',
        provider: 'amr',
        endpointHost: 'x',
        reason: '',
        latencyMs: 12,
        probe: 'live',
        missingEnv: [],
        httpStatus: 200,
        resetAt: null,
        bodyShape: 'choices',
        finishReason: 'stop',
        contentEmpty: false,
        warning: null,
      };
    },
    force: true,
  });
  assert.deepEqual(seen, { providerId: 'amr', configured: true });
  assert.equal(caps.model.model, 'from-injected-probe');
  assert.equal(caps.degraded, false);
});

test('modelProbe 抛异常 → probe=failed，但 capabilities 仍返回（不抛）', async () => {
  clearCapabilitiesCache();
  const caps = await capabilities({
    sdkLoader: async () => okSdk,
    llm: { configured: true },
    modelProbe: async () => {
      throw new Error('probe 炸了');
    },
    force: true,
  });
  assert.equal(caps.available, true);
  assert.equal(caps.model.probe, 'failed');
  assert.match(caps.model.reason, /probe 炸了/);
});

// ===========================================================================
// probeLlmEndpoint 单元细节
// ===========================================================================

test('probeLlmEndpoint：200 → available，且请求体是 max_tokens=1 的最小探测', async () => {
  const captured: { body: Record<string, unknown> | null; headers: Record<string, string> } = {
    body: null,
    headers: {},
  };
  const cap = await probeLlmEndpoint(
    { baseUrl: 'https://x/v1/', apiKey: 'key-1234567890', model: 'm1', configured: true },
    {
      fetchImpl: async (_url, init) => {
        captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        captured.headers = (init?.headers ?? {}) as Record<string, string>;
        // ⚠️ 原 fixture 是 `{ choices: [] }` —— 那是**空 choices**，真实 chat completion 不会这样。
        // 独立验收指出"HTTP 200 ≠ 模型可用"后，实现改成必须看到合法的 choices；
        // 所以这里换成**真实形状**（否则测的是"假绿"本身）。
        return jsonResponse(200, {
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
        });
      },
    },
  );
  assert.equal(cap.available, true);
  assert.equal(cap.latencyMs !== null, true);
  assert.equal(captured.body?.model, 'm1');
  assert.equal(captured.body?.max_tokens, 1);
  assert.equal(captured.body?.stream, false);
  assert.equal(captured.headers.authorization, 'Bearer key-1234567890');
  assert.equal(cap.reason, '');
  // 响应形状被如实记录（新字段）
  assert.equal(cap.bodyShape, 'choices');
  assert.equal(cap.finishReason, 'stop');
  assert.equal(cap.contentEmpty, false);
  assert.equal(cap.warning, null);
});

test('probeLlmEndpoint：baseUrl 末尾斜杠不会拼出双斜杠', async () => {
  let url = '';
  await probeLlmEndpoint(
    { baseUrl: 'https://x/v1///', apiKey: 'k'.repeat(20), model: 'm', configured: true },
    {
      fetchImpl: async (u) => {
        url = String(u);
        return jsonResponse(200, {});
      },
    },
  );
  assert.equal(url, 'https://x/v1/chat/completions');
});

test('缓存：TTL 内命中 cache=true，force 可绕过', async () => {
  clearCapabilitiesCache();
  let loads = 0;
  const loader = async (): Promise<SdkLoadResult> => {
    loads += 1;
    return okSdk;
  };
  const first = await capabilities({ sdkLoader: loader, llm: { configured: false }, force: true });
  assert.equal(first.cached, false);
  const second = await capabilities({ sdkLoader: loader, llm: { configured: false } });
  assert.equal(second.cached, true);
  assert.equal(loads, 1, 'TTL 内不该重新探测');
  await capabilities({ sdkLoader: loader, llm: { configured: false }, force: true });
  assert.equal(loads, 2);
  assert.equal(CAPABILITIES_TTL_MS, 300_000);
  clearCapabilitiesCache();
});

test('返回对象可 JSON 序列化（要直接进 HTTP 响应）', async () => {
  clearCapabilitiesCache();
  const caps = await capabilities({ sdkOnly: true, sdkLoader: async () => okSdk, force: true });
  const parsed = JSON.parse(JSON.stringify(caps)) as Record<string, unknown>;
  assert.equal(parsed.mode, 'sdk');
  assert.equal(typeof parsed.available, 'boolean');
  assert.ok(parsed.model && typeof parsed.model === 'object');
});
