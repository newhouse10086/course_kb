/**
 * 探测响应形状（"HTTP 200 ≠ 模型可用"）—— 独立验收指出的**假绿**风险。
 *
 * 背景（polysemy-prober 实测）：本项目端点是**推理模型** ——
 * `max_tokens=100` 时 `content` 仍为空、全被 reasoning 吃光，要到 ~500 才稳定出内容。
 * 契约 `SETTINGS_AND_SANDBOX.md` §0 明确：
 * 「`content` 空但 `reasoning_content` 非空 → **显式报错**（不许当成功）」。
 *
 * 原实现只看 `res.ok` → 一个网关/门户页返回 200 也会被当成"模型可用"（假绿）。
 * 现在：必须看到合法的 `choices` 才算通；只拿到 reasoning 时如实标 `contentEmpty` + warning。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { probeLlmEndpoint, clearCapabilitiesCache } from '../../src/agent/capabilities.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CREDS = { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test-1234567890', model: 'reasoning-model', configured: true };

test('★ 200 但 body 不是 chat completion（网关/门户页）→ available=false，不当成功', async () => {
  clearCapabilitiesCache();
  for (const body of [{ choices: [] }, { ok: true }, { data: 'html-ish' }]) {
    const cap = await probeLlmEndpoint(CREDS, { fetchImpl: async () => jsonResponse(200, body) });
    assert.equal(cap.available, false, `body=${JSON.stringify(body)} 不该被判为可用`);
    assert.match(cap.reason, /不是合法的 chat completion/);
    assert.equal(cap.httpStatus, 200, '仍如实记录 HTTP 状态');
  }
});

test('★ 200 但响应是 HTML（非 JSON）→ available=false', async () => {
  clearCapabilitiesCache();
  const cap = await probeLlmEndpoint(CREDS, {
    fetchImpl: async () => new Response('<!doctype html><title>Portal</title>', { status: 200 }),
  });
  assert.equal(cap.available, false);
  assert.equal(cap.bodyShape, 'unknown');
  assert.match(cap.reason, /不是合法的 chat completion/);
});

test('★ 200 但 body 里有 error → available=false（也不当成功）', async () => {
  clearCapabilitiesCache();
  const cap = await probeLlmEndpoint(CREDS, {
    fetchImpl: async () => jsonResponse(200, { error: { message: 'upstream overloaded' } }),
  });
  assert.equal(cap.available, false);
  assert.equal(cap.bodyShape, 'error');
});

test('★★ 推理模型的典型响应（content 空、finish_reason=length）→ 如实标记 + warning，不假装内容正常', async () => {
  clearCapabilitiesCache();
  // 照抄真机实测形状：max_tokens=100 时 content='' 且全是 reasoning
  const cap = await probeLlmEndpoint(CREDS, {
    fetchImpl: async () =>
      jsonResponse(200, {
        choices: [
          {
            finish_reason: 'length',
            message: { role: 'assistant', content: '', reasoning_content: 'x'.repeat(437) },
          },
        ],
      }),
  });
  assert.equal(cap.available, true, '凭据/额度/端点确实通了 —— 这一层可以说可用');
  assert.equal(cap.bodyShape, 'choices');
  assert.equal(cap.finishReason, 'length');
  assert.equal(cap.contentEmpty, true, '★ 必须如实标出"没拿到内容"');
  assert.ok(cap.warning, '要有 warning，不能静默');
  assert.match(cap.warning!, /推理模型/);
  assert.match(cap.warning!, /只证明\*\*凭据\/额度\/端点可用\*\*/);
  assert.match(cap.warning!, /probeMaxTokens/);
  assert.match(cap.warning!, /500/);
});

test('★ 提高 probeMaxTokens（≥500）后拿到 content → contentEmpty=false、无 warning', async () => {
  clearCapabilitiesCache();
  const cap = await probeLlmEndpoint(CREDS, {
    probeMaxTokens: 500,
    fetchImpl: async (_url, init) => {
      const sent = JSON.parse(String(init?.body)) as { max_tokens?: number };
      assert.equal(sent.max_tokens, 500, '预算要真的传上去');
      return jsonResponse(200, {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{ "ok": true }' } }],
      });
    },
  });
  assert.equal(cap.available, true);
  assert.equal(cap.contentEmpty, false);
  assert.equal(cap.warning, null);
});

test('★ content 为 null（部分实现的空回复形态）也算空', async () => {
  clearCapabilitiesCache();
  const cap = await probeLlmEndpoint(CREDS, {
    fetchImpl: async () =>
      jsonResponse(200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null } }] }),
  });
  assert.equal(cap.contentEmpty, true);
  assert.ok(cap.warning);
});

test('★ 4xx/402 仍然走分类器（额度/凭据），形状字段留空不编造', async () => {
  clearCapabilitiesCache();
  const cap = await probeLlmEndpoint(CREDS, {
    fetchImpl: async () =>
      jsonResponse(402, { error: { code: 'insufficient_balance', message: 'no balance', reset_at: '2026-10-15T00:00:00Z' } }),
  });
  assert.equal(cap.available, false);
  assert.equal(cap.httpStatus, 402);
  assert.equal(cap.bodyShape, null, '失败路径不该编造形状');
  assert.equal(cap.finishReason, null);
  assert.equal(cap.resetAt, '2026-10-15T00:00:00Z');
});
