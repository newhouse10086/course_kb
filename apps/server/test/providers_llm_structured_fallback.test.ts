/**
 * ★★ 结构化输出**降级链**（strict → lenient）+ **能力同源上报**。
 *
 * ## 现场（本轮实测，同一端点、时间相邻的 3 次调用）
 * ```
 * 裸 schema + strict:true   → 200（strict 被忽略，模型可省略 cards）
 * 真 strict schema          → 400  {"error":{"message":"Upstream request failed:
 *                              [invalid_request_error] This response_format type is unavailable now"}}
 * ```
 * ⟹ ★ **不能直接 strictify**（每次抽取都会 400）；也**不能无条件声称** `structuredOutput: true`
 *   （坑 10：能力不可用假装可用；坑 24：声明 ≠ 生效）。
 *
 * ## 判据（全部断言**真实请求体**与**实测结果**，不断言"我们传了参数"）
 * 1. ★ 第一次请求带的是**严格 schema**（`required` 含全部属性 + `additionalProperties:false`）
 * 2. ★ 端点 400 拒绝 → **自动回落**，第二次请求带的是**原始（裸）schema**
 * 3. ★ 回落成功 → `structuredOutputMode === 'lenient'`，且 `capabilities.structuredOutput === false`
 *    + reason 里含**端点原始文案**（`unavailable now`）—— **同源**
 * 4. ★ 严格模式 200 → `mode === 'strict'` 且 `capabilities.structuredOutput === true`
 * 5. ★ 两种模式都失败 → `E_LLM`，**两个 reason 都在**
 * 6. ★ 401/402/429 **不回落**（避免"配置问题"被当成"schema 问题"而多烧一次调用）
 * 7. ★ `strictifySchema` **幂等**（已 strict 的再跑不变）
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  isStrictSchemaRejected,
  OpenAiCompatibleLlm,
  strictifySchema,
} from '../src/providers/llm/openai_compatible.ts';

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

interface Call {
  body: {
    response_format?: { type?: string; json_schema?: { strict?: boolean; schema?: Record<string, unknown> } };
    [k: string]: unknown;
  };
}

/** 装一个假 fetch：按顺序返回预设响应，并记录每次**真实请求体**。 */
function stubFetch(script: { status: number; body: string }[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls.push({ body: JSON.parse(init.body) as Call['body'] });
    const step = script[Math.min(i, script.length - 1)]!;
    i += 1;
    return new Response(step.body, {
      status: step.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return calls;
}

const OK_BODY = JSON.stringify({
  choices: [{ message: { content: '{"section":{"section_summary":"x"}}' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});
const STRICT_400 = JSON.stringify({
  error: {
    type: 'invalid_request_error',
    code: 400,
    message: 'Upstream request failed: [invalid_request_error] This response_format type is unavailable now',
  },
});

function makeProvider(): OpenAiCompatibleLlm {
  return new OpenAiCompatibleLlm({
    id: 'amr',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'test-key',
    model: 'deepseek-v4.1-flash',
  });
}

const REQ = {
  messages: [{ role: 'user' as const, content: 'hi' }],
  schema: {
    name: 'knowledge_cards',
    // ★ 裸 schema（= worker 的 extract.plan 给的形状，**故意不含 required**）
    schema: {
      type: 'object',
      properties: { section: { type: 'object', properties: { section_summary: { type: 'string' } } } },
    } as Record<string, unknown>,
  },
};

test('★ 幂等 strictify：裸 schema → 补 required + additionalProperties:false；再跑不变', () => {
  const once = strictifySchema(REQ.schema.schema);
  const twice = strictifySchema(once);
  assert.deepEqual(once, twice, '★ strictify 必须幂等');
  assert.deepEqual(once.required, ['section'], 'required 必须含全部属性');
  assert.equal(once.additionalProperties, false);
  const inner = (once.properties as Record<string, Record<string, unknown>>).section!;
  assert.deepEqual(inner.required, ['section_summary'], '嵌套对象也要 strictify');
  assert.equal(inner.additionalProperties, false);
});

test('★ 端点 400 拒绝严格 schema → 自动回落裸 schema + mode=lenient + 能力同源为 false', async () => {
  const calls = stubFetch([{ status: 400, body: STRICT_400 }, { status: 200, body: OK_BODY }]);
  const p = makeProvider();

  const res = await p.completeJson<{ section: { section_summary: string } }>(REQ);

  assert.equal(calls.length, 2, '★ 必须发两次（严格失败 → 回落）');
  // ① 第一次：严格 schema
  const first = calls[0]!.body.response_format!.json_schema!;
  assert.equal(first.strict, true);
  assert.deepEqual((first.schema as Record<string, unknown>).required, ['section'], '★ 第一次必须带 required');
  assert.equal((first.schema as Record<string, unknown>).additionalProperties, false);
  // ② 第二次：原始裸 schema（**没有** required —— 与线上形状一致）
  const second = calls[1]!.body.response_format!.json_schema!;
  assert.equal((second.schema as Record<string, unknown>).required, undefined, '★ 回落必须用**原始** schema');
  assert.equal(second.strict, true, 'strict 开关本身不改（错的是 schema 形状）');
  // ③ 结果与能力同源
  assert.equal(res.data.section.section_summary, 'x');
  assert.equal(res.structuredOutputMode, 'lenient', '★ 必须如实记录用了哪种模式');
  assert.equal(p.info.capabilities.structuredOutput, false, '★ 端点拒绝严格 schema → 不许声称 true');
  assert.match(
    String(p.info.capabilities.structuredOutputReason),
    /unavailable now/,
    '★ reason 必须带**端点原始文案**（同源）',
  );
});

test('★ 严格模式 200 → mode=strict 且能力上报 true', async () => {
  const calls = stubFetch([{ status: 200, body: OK_BODY }]);
  const p = makeProvider();
  const res = await p.completeJson(REQ);
  assert.equal(calls.length, 1, '严格成功就不该有第二次调用');
  assert.equal(res.structuredOutputMode, 'strict');
  assert.equal(p.info.capabilities.structuredOutput, true);
  assert.equal(p.info.capabilities.jsonSchemaStrict, true);
});

test('★ 两种模式都失败 → E_LLM 且**两个 reason 都在**（不许只说"非 JSON"）', async () => {
  stubFetch([{ status: 400, body: STRICT_400 }, { status: 400, body: STRICT_400 }]);
  const p = makeProvider();
  await assert.rejects(
    () => p.completeJson(REQ),
    (err: Error) => {
      assert.match(err.message, /unavailable now/, '必须带端点原始文案');
      assert.match(err.message, /strict|严格/, '必须说清是严格模式失败');
      return true;
    },
  );
});

test('★ 429 **不回落**（配置/限流问题不该被当成 schema 问题多烧一次调用）', async () => {
  const calls = stubFetch([{ status: 429, body: '{"error":{"message":"rate limited"}}' }]);
  const p = makeProvider();
  await assert.rejects(() => p.completeJson(REQ));
  assert.equal(calls.length, 1, '★ 429 只发一次（不回落）');
  assert.equal(isStrictSchemaRejected(new Error('HTTP 429: rate limited')), false);
  assert.equal(isStrictSchemaRejected(new Error('HTTP 400: {"error":{"message":"This response_format type is unavailable now"}}')), true);
});
