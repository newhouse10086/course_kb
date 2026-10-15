/**
 * ★ 坑 24「死旋钮」的守卫：**"能配"必须等于"真的会生效"**。
 *
 * 原缺陷（实测）：`providers/llm/openai_compatible.ts` 硬编码 `setTimeout(…, 120_000)`，
 * 而契约注释写"其它可选参数（如 `timeoutMs`）" —— `extra` **只读了 `maxContextTokens`**。
 * 运维按注释配了 `timeoutMs` **不会生效**（**比没有这个配置更坏**：他会以为调过了）。
 *
 * ## 本测试的判据（Lead 指定）
 * - `extra.timeoutMs` **真的被读**：给**极小值 → 立刻超时**；给大值 → 不超时
 * - env `LLM_TIMEOUT_MS` 生效，且**优先级明确**：`extra` > `env` > 默认
 * - `maxTokens` **真的进了请求体**（断言 body 里的值，**不是**断言"我们传了参数"）
 * - `E_TIMEOUT` **只重试一次**且受**总预算**约束（不许变成 `120s × N`）
 *
 * 做法：替换 `globalThis.fetch` 捕获**真实请求体**并模拟慢响应（不需要真网络、不花额度）。
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { OpenAiCompatibleLlm, resolveLlmTimeoutMs, resolveLlmRetryBudgetMs, DEFAULT_LLM_TIMEOUT_MS } from '../src/providers/llm/openai_compatible.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.LLM_TIMEOUT_MS;
  delete process.env.LLM_RETRY_BUDGET_MS;
});

interface Captured {
  bodies: Record<string, unknown>[];
  calls: number;
}

/** 替换 fetch：记录请求体；按 `mode` 模拟"立刻回"或"永远不回"。 */
function stubFetch(mode: 'fast' | 'slow', reply: unknown = { choices: [{ message: { content: '{"ok":true}' } }] }): Captured {
  const cap: Captured = { bodies: [], calls: 0 };
  globalThis.fetch = (async (_url: string, init?: { body?: string; signal?: AbortSignal }) => {
    cap.calls += 1;
    cap.bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    if (mode === 'slow') {
      // 永不 resolve，但**响应 abort**（与真 fetch 一致：signal 中止时 reject）
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), {
          once: true,
        });
      });
    }
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return cap;
}

const mk = (extra?: Record<string, unknown>): OpenAiCompatibleLlm =>
  new OpenAiCompatibleLlm({ id: 't', baseUrl: 'http://x.invalid/v1', apiKey: 'k', model: 'm', ...(extra ? { extra } : {}) });

const REQ = {
  messages: [{ role: 'user' as const, content: 'hi' }],
  schema: { name: 's', schema: { type: 'object', properties: {}, additionalProperties: false } },
};

test('★ extra.timeoutMs 真的生效：极小值 → 立刻超时（证明它被读了，不是死旋钮）', async () => {
  stubFetch('slow');
  const p = mk({ timeoutMs: 60, retryBudgetMs: 60 }); // 预算=60 → 不允许重试，只测"超时是否真的发生"
  const t0 = Date.now();
  await assert.rejects(
    () => p.completeJson(REQ),
    (e: unknown) => (e as { code?: string }).code === 'E_TIMEOUT',
    '★ 极小 timeoutMs 必须触发 E_TIMEOUT（原实现硬编码 120s → 这条会挂 2 分钟）',
  );
  const dt = Date.now() - t0;
  assert.ok(dt < 3000, `必须**很快**超时（说明真的读了 60ms），实际 ${dt}ms`);
});

test('★ extra.timeoutMs 给大值 → 不超时（能配也要能放宽）', async () => {
  stubFetch('fast');
  const p = mk({ timeoutMs: 30_000 });
  const out = await p.completeJson(REQ);
  assert.deepEqual(out.data, { ok: true });
});

test('★ 优先级：extra > env > 默认（三个都断言，避免"配了但被 env 覆盖"）', () => {
  process.env.LLM_TIMEOUT_MS = '111';
  assert.equal(resolveLlmTimeoutMs({ timeoutMs: 222 }), 222, 'extra 必须压过 env');
  assert.equal(resolveLlmTimeoutMs(undefined), 111, 'env 必须生效（extra 缺省时）');
  delete process.env.LLM_TIMEOUT_MS;
  assert.equal(resolveLlmTimeoutMs(undefined), DEFAULT_LLM_TIMEOUT_MS, '都没有 → 默认 120s');
  // 非法值不许"静默变 0"（0 会让每次请求立刻超时）
  assert.equal(resolveLlmTimeoutMs({ timeoutMs: 0 }), DEFAULT_LLM_TIMEOUT_MS, '0 非法 → 回落默认');
  assert.equal(resolveLlmTimeoutMs({ timeoutMs: -5 }), DEFAULT_LLM_TIMEOUT_MS, '负数非法 → 回落默认');
  process.env.LLM_RETRY_BUDGET_MS = '333';
  assert.equal(resolveLlmRetryBudgetMs(undefined), 333, '重试预算 env 生效');
  assert.equal(resolveLlmRetryBudgetMs({ retryBudgetMs: 444 }), 444, '重试预算 extra 优先');
});

test('★ 行为级优先级：env 给小值、extra 给大值 → 不超时（说明 extra 真的赢了）', async () => {
  process.env.LLM_TIMEOUT_MS = '50'; // env：极小
  stubFetch('slow');
  // ⚠️ extra 取 1200ms（不是 30s）：足以证明"远大于 env 的 50ms"，又不会让挂起的请求拖慢测试文件
  const p = mk({ timeoutMs: 1200, retryBudgetMs: 1000 });
  const res = await Promise.race([
    p.completeJson(REQ).then(() => 'ok').catch((e: unknown) => `err:${(e as { code?: string }).code}`),
    new Promise((r) => setTimeout(() => r('still-running'), 500)),
  ]);
  assert.equal(res, 'still-running', `★ extra 必须压过 env：若被 env(50ms) 生效会立刻 E_TIMEOUT，实际 ${res}`);
  // 收尾：等它按 extra 的 1200ms 超时结束（不留挂起请求）
  await p.completeJson(REQ).catch(() => undefined);
});

test('★ maxTokens 真的进了请求体（断言 body，不是断言"我们传了参数"）', async () => {
  const cap = stubFetch('fast');
  const p = mk({ timeoutMs: 5000 });
  await p.completeJson({ ...REQ, maxTokens: 8192 });
  assert.equal(cap.bodies[0]?.max_tokens, 8192, '★ 请求体里的 max_tokens 必须是调用方给的值');
  // 未传 → provider 默认（4096）；这是"调用方没意见"的显式默认，不是死旋钮
  await p.completeJson(REQ);
  assert.equal(cap.bodies[1]?.max_tokens, 4096, '未传时用默认 4096');
  // 其它关键字段也在（json_schema + strict：坑 4）
  const rf = cap.bodies[0]?.response_format as { type?: string; json_schema?: { strict?: boolean } };
  assert.equal(rf?.type, 'json_schema');
  assert.equal(rf?.json_schema?.strict, true, '★ strict 必须在请求体里（坑 4：json_object 不强制 enum）');
});

test('★ E_TIMEOUT 只重试一次：第一次超时、第二次成功 → 共 2 次请求且结果可用', async () => {
  let n = 0;
  globalThis.fetch = (async (_url: string, init?: { signal?: AbortSignal }) => {
    n += 1;
    if (n === 1) {
      return await new Promise((_r, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const p = mk({ timeoutMs: 50, retryBudgetMs: 5000 }); // 预算充足 → 允许重试
  const out = await p.completeJson(REQ);
  assert.deepEqual(out.data, { ok: true }, '重试后应拿到结果');
  assert.equal(n, 2, '★ 恰好 2 次（重试一次，不是无限）');
});

test('★ 总预算约束：预算不足 → **不重试**（防止 120s × N 让任务耗时翻倍）', async () => {
  const cap = stubFetch('slow');
  const p = mk({ timeoutMs: 60, retryBudgetMs: 60 }); // 剩余预算(≈0) < 单次超时(60) → 不重试
  await assert.rejects(() => p.completeJson(REQ), (e: unknown) => (e as { code?: string }).code === 'E_TIMEOUT');
  assert.equal(cap.calls, 1, '★ 预算不足时必须只请求 1 次');
});

test('★ 非超时错误**不重试**（4xx/5xx 重试只会浪费额度）', async () => {
  let n = 0;
  globalThis.fetch = (async () => {
    n += 1;
    return new Response('{"error":"rate limited"}', { status: 429 });
  }) as unknown as typeof fetch;
  const p = mk({ timeoutMs: 5000, retryBudgetMs: 5000 });
  await assert.rejects(() => p.completeJson(REQ), (e: unknown) => (e as { code?: string }).code === 'E_LLM');
  assert.equal(n, 1, '429 不许重试');
});
