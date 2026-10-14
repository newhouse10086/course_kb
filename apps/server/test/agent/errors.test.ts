/**
 * `errors.ts` 单测：**失败可见**（契约 §7.3.1 ⚠️7/⚠️8）。
 *
 * 所有错误串都取自**真实抓包**（v1/v2 本机实测），不是编的：
 *   - `403: … An active OpenCode Go subscription is required …`
 *   - `402: {"code":"insufficient_balance","details":{"reset_at":"2026-10-14T15:44:45Z"} …}`
 *   - `Request timed out.`
 *   - SDK 文档化的 `no model selected` / `no api key available`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_ERROR_CODES,
  HINT_SDK_BAD,
  HINT_SDK_OK,
  classifyFailure,
  describeThrowable,
  scrubSecrets,
  sdkUnavailableError,
} from '../../src/agent/errors.ts';

const REAL_403 =
  '403: {"type":"server_error","message":"Upstream request failed: An active OpenCode Go subscription is required to use Go models."}';
const REAL_402 =
  '402: {"code":"insufficient_balance","details":{"coding_plan_exhausted":true,"reset_at":"2026-10-14T15:44:45Z"},"message":"[code=insufficient_balance] Coding Plan quota is exhausted and wallet balance is insufficient."}';

test('★ 真实 403「无订阅」→ E_LLM，hint 明确指向订阅侧', () => {
  const c = classifyFailure(new Error(REAL_403), { where: '本轮运行', model: 'glm-5.2', attempts: 3 });
  assert.equal(c.code, AGENT_ERROR_CODES.E_LLM);
  assert.equal(c.kind, 'subscription');
  assert.match(c.msg, /An active OpenCode Go subscription is required/);
  assert.ok(c.hint.startsWith(HINT_SDK_OK), 'hint 必须说清"SDK 是好的"');
  assert.match(c.hint, /订阅/);
  assert.match(c.hint, /glm-5\.2/);
  assert.match(c.hint, /已自动重试 3 次/);
});

test('★ 真实 402「额度耗尽」→ E_LLM，hint 指向额度', () => {
  const c = classifyFailure(new Error(REAL_402), { where: '本轮运行', model: 'deepseek-v4.1-flash' });
  assert.equal(c.code, AGENT_ERROR_CODES.E_LLM);
  assert.equal(c.kind, 'quota');
  assert.match(c.hint, /额度已耗尽/);
  assert.match(c.detail, /kind=quota/);
});

test('真实 `Request timed out.` → E_PI_TIMEOUT（不是 E_LLM）', () => {
  const c = classifyFailure(new Error('Request timed out.'), { where: '本轮运行' });
  assert.equal(c.code, AGENT_ERROR_CODES.E_PI_TIMEOUT);
  assert.equal(c.kind, 'timeout');
});

test('凭据类：401 / invalid api key → credential，提示查环境变量', () => {
  for (const message of ['401 Unauthorized', 'invalid api key provided', 'Incorrect API key']) {
    const c = classifyFailure(new Error(message), { where: '模型探测' });
    assert.equal(c.kind, 'credential', message);
    assert.match(c.hint, /凭据无效|API key/);
  }
  const withStatus = classifyFailure({ status: 401, message: 'nope' }, { where: '模型探测' });
  assert.equal(withStatus.kind, 'credential', '没有文字线索时也要用 status 判断');
});

test('SDK 文档化的 "no model selected" / "no api key available" → 配置问题（不是 SDK 故障）', () => {
  for (const message of ['no model selected', 'no API key available for provider']) {
    const c = classifyFailure(new Error(message), { where: '发送 prompt' });
    assert.equal(c.kind, 'model_missing', message);
    assert.ok(c.hint.startsWith(HINT_SDK_OK));
    assert.match(c.hint, /配置/);
  }
});

test('网络类：fetch failed / ECONNREFUSED / ENOTFOUND → network', () => {
  for (const message of ['fetch failed', 'connect ECONNREFUSED 127.0.0.1:443', 'getaddrinfo ENOTFOUND amr-link']) {
    const c = classifyFailure(new Error(message), { where: '模型探测' });
    assert.equal(c.kind, 'network', message);
    assert.match(c.hint, /网络|DNS/);
  }
});

test('限流：429 / too many requests → rate_limit', () => {
  const c = classifyFailure(new Error('429 Too Many Requests'), { where: '模型探测' });
  assert.equal(c.kind, 'rate_limit');
  assert.match(c.hint, /限流|稍后重试/);
});

test('schema 违规 → E_LLM_SCHEMA', () => {
  const c = classifyFailure(new Error('model output did not match schema'), { where: '结构化抽取' });
  assert.equal(c.code, AGENT_ERROR_CODES.E_LLM_SCHEMA);
});

test('未分类错误 → unknown，但仍然给出可操作 hint（不返回空话）', () => {
  const c = classifyFailure(new Error('something weird happened'), { where: '本轮运行' });
  assert.equal(c.kind, 'unknown');
  assert.equal(c.code, AGENT_ERROR_CODES.E_LLM);
  assert.ok(c.hint.startsWith(HINT_SDK_OK));
  assert.ok(c.hint.length > 20);
});

test('describeThrowable 覆盖 string / Error+code / 对象 / null', () => {
  assert.deepEqual(describeThrowable('直接字符串'), { message: '直接字符串' });
  const withCode = describeThrowable(Object.assign(new Error('boom'), { code: 'ERR_MODULE_NOT_FOUND' }));
  assert.match(withCode.message, /boom/);
  assert.match(withCode.message, /ERR_MODULE_NOT_FOUND/, 'code 要保留，否则分类会退化');
  assert.deepEqual(describeThrowable({ message: 'obj msg', status: 402 }), { message: 'obj msg', status: 402 });
  assert.equal(describeThrowable(null).message, '未知错误');
});

test('classifyFailure 永不抛（畸形输入）', () => {
  for (const bad of [null, undefined, 42, Symbol('x'), { get message() { throw new Error('getter 炸了'); } }]) {
    assert.doesNotThrow(() => classifyFailure(bad, { where: 'x' }));
  }
});

test('sdkUnavailableError 的 hint 前缀与模型侧失败**可区分**', () => {
  const err = sdkUnavailableError('pi SDK 未安装：xxx');
  assert.equal(err.code, AGENT_ERROR_CODES.E_PI_UNAVAILABLE);
  assert.ok(err.hint?.startsWith(HINT_SDK_BAD));
  assert.notEqual(HINT_SDK_BAD, HINT_SDK_OK);
  // 两类 hint 前缀不同 → 前端/日志一眼能分辨
  assert.ok(!HINT_SDK_BAD.startsWith(HINT_SDK_OK));
});

test('scrubSecrets 抹掉凭据（且不动无关文本）', () => {
  const key = 'sk-abcdefghijklmnop';
  const text = `请求失败 Authorization: Bearer ${key} 其他内容保留`;
  const scrubbed = scrubSecrets(text, [key, undefined, null, 'short']);
  assert.ok(!scrubbed.includes(key));
  assert.match(scrubbed, /<redacted>/);
  assert.match(scrubbed, /其他内容保留/);
});
