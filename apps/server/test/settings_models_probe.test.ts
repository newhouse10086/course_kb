/**
 * `/models` 的**探测判定**测试 —— 专治"假绿"（`docs/SETTINGS_AND_SANDBOX.md` §2 / §0）。
 *
 * ## 背景（这是真发生过的 bug，不是我臆想的边界）
 * `src/settings/models.ts` 原来自行发 `POST /chat/completions` 并**只判 HTTP 200**，
 * 预算自定为 `max_tokens=8`。而本项目端点是**推理模型**、推理 token **计入 `max_tokens`**：
 * 8 个 token 被 reasoning 吃光 → `content` 为空、HTTP 仍 **200** → 报 `available:true`。
 * 实测：8 个模型里 7 个是这种"假绿"。
 * 后果最要命的一条：**热切换的"探测不通就回滚"失效** → 切到产不出内容的模型 →
 * 抽取静默产出 0 张卡片（"看起来成功"）。
 *
 * ## 修法与本文档的关系
 * 探测改为**复用 provider 层的 `healthCheck()`**（预算 512 + 空 `content` 不算成功 + 诊断信息），
 * 于是 `/models` 与 `/capabilities` 用**同一份判据**。
 * 本文件因此重点测两件事：
 * 1. **判定语义**：HTTP 200 + 空 content 必须 `available:false`（旧实现下必红）
 * 2. **不许漂**：provider 层的 `PROBE_MAX_TOKENS` 不得被调回小值（≥ 512）
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import type { ServerConfig } from '../src/config.ts';
import { ModelCatalog } from '../src/settings/models.ts';
import { PROBE_MAX_TOKENS } from '../src/providers/llm/openai_compatible.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

let cfg: ServerConfig;
before(() => {
  cfg = loadConfig({
    root: ROOT,
    env: {
      AMR_BASE: 'https://probe-test.local/v1',
      AMR_KEY: 'sk-probe-test-key-0123456789',
      LLM_MODEL: 'configured-model',
    } as Record<string, string>,
  });
});
after(() => {
  /* 无临时资源 */
});

/** 用假 fetch 跑**真 provider 路径**（`OpenAiCompatibleLlm.healthCheck`）。 */
async function withPatchedFetch<T>(body: unknown, status: number, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  const sent: { url: string; body: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    sent.push({ url, body: String(init?.body ?? '') });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

/** 抓最后一次探测请求体（断言预算真的传了 512）。 */
const lastBody = { url: '', body: '' };
async function withCapture<T>(body: unknown, status: number, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    lastBody.url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    lastBody.body = String(init?.body ?? '');
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 0. 预算守卫（防"常量漂移"，这个 bug 已经真实发生过一次）
// ═══════════════════════════════════════════════════════════════════════

test('★ 守卫：provider 层的 PROBE_MAX_TOKENS ≥ 512（推理 token 计入预算，小预算=假绿）', () => {
  assert.ok(
    PROBE_MAX_TOKENS >= 512,
    `PROBE_MAX_TOKENS=${PROBE_MAX_TOKENS} 太小 —— 推理 token 会吃光预算导致 content 为空但 HTTP 200（假绿）`,
  );
});

test('★ 守卫：探测预算**只有一份实现** —— models.ts 里不许再出现自定义的 max_tokens 常量', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/settings/models.ts'), 'utf8');
  // 允许在注释里提到，但**不许有赋值**（旧 bug 就是 `const PROBE_MAX_TOKENS = 8;`）
  assert.equal(
    /(const|let|var)\s+[A-Z_]*PROBE_MAX_TOKENS\s*=/.test(src),
    false,
    'settings/models.ts 不许自己定义探测预算常量（必须复用 providers 层，否则必然再次漂移）',
  );
  // 也不许自己直接 POST /chat/completions（那是 provider 层的事）
  assert.equal(
    /chat\/completions/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')),
    false,
    'settings/models.ts 不许自己发 /chat/completions 请求（探测必须走 provider.healthCheck）',
  );
});

// ═══════════════════════════════════════════════════════════════════════
// 1. ★ 核心回归：HTTP 200 + content 为空 → available:false（旧实现下必红）
// ═══════════════════════════════════════════════════════════════════════

test('★ HTTP 200 但 content 为空 → available:false + 可读诊断（旧实现会报 true）', async () => {
  const cat = new ModelCatalog({ cfg, timeoutMs: 500 });
  const p = await withPatchedFetch(
    {
      choices: [{ message: { content: '', reasoning_content: 'r'.repeat(31) }, finish_reason: 'length' }],
      usage: { completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 31 } },
    },
    200,
    () => cat.probe('some-model', { force: true }),
  );
  assert.equal(p.available, false, '★ 空 content 必须判为不可用（这就是"假绿"）');
  assert.match(p.reason, /E_LLM_EMPTY_CONTENT/);
  assert.match(p.reason, /finish_reason=length/);
  assert.match(p.reason, /reasoning_content=31 字符/);
  assert.match(p.reason, /推理 token 吃光了输出预算/);
  assert.match(p.reason, /不可当作模型可用/);
  assert.equal(p.judgedBy, 'provider.healthCheck');
  assert.ok(p.latencyMs >= 0);
});

test('★ 判据是 content，不是 finish_reason：finish_reason=stop 但 content 空 → 仍不可用', async () => {
  // Lead 实测提醒：`finish_reason=length` 会出现但**不保证总出现**
  const cat = new ModelCatalog({ cfg, timeoutMs: 500 });
  const p = await withPatchedFetch(
    { choices: [{ message: { content: '   ', reasoning_content: 'x' }, finish_reason: 'stop' }] },
    200,
    () => cat.probe('m-stop-empty', { force: true }),
  );
  assert.equal(p.available, false, 'content 只有空白也算空');
  assert.match(p.reason, /E_LLM_EMPTY_CONTENT/);
  assert.match(p.reason, /finish_reason=stop/, '诊断里要如实写 finish_reason=stop（不能因此判为可用）');
});

test('HTTP 200 且有 content → available:true（不能矫枉过正把好的判成坏的）', async () => {
  const cat = new ModelCatalog({ cfg, timeoutMs: 500 });
  const p = await withPatchedFetch(
    { choices: [{ message: { content: 'pong 🏓', reasoning_content: '思考中' }, finish_reason: 'stop' }] },
    200,
    () => cat.probe('m-good', { force: true }),
  );
  assert.equal(p.available, true);
  assert.equal(p.reason, '', '可用时 reason 必须为空串（前端据此显示"可用"）');
});

// ═══════════════════════════════════════════════════════════════════════
// 2. 探测真的用了 512 预算（防"改了常量但没生效"）
// ═══════════════════════════════════════════════════════════════════════

test('★ 探测请求体里 max_tokens === provider 层常量（512），不是 8', async () => {
  const cat = new ModelCatalog({ cfg, timeoutMs: 500 });
  await withCapture(
    { choices: [{ message: { content: 'pong' } }] },
    200,
    () => cat.probe('budget-model', { force: true }),
  );
  const sent = JSON.parse(lastBody.body) as { model: string; max_tokens: number };
  assert.equal(sent.max_tokens, PROBE_MAX_TOKENS);
  assert.equal(sent.max_tokens, 512);
  assert.notEqual(sent.max_tokens, 8, '★ 8 就是那个假绿 bug 的预算');
  assert.equal(sent.model, 'budget-model', '探测的必须是**被问的那个模型**（不是配置里的默认模型）');
  assert.equal(lastBody.url, 'https://probe-test.local/v1/chat/completions');
});

// ═══════════════════════════════════════════════════════════════════════
// 3. 各种失败也要如实、可读、不泄密
// ═══════════════════════════════════════════════════════════════════════

test('HTTP 402 → available:false + 欠费说明（区分"欠费"与"网络不通"）', async () => {
  const cat = new ModelCatalog({ cfg, timeoutMs: 500 });
  const p = await withPatchedFetch(
    { error: { message: 'insufficient_balance' } },
    402,
    () => cat.probe('m-402', { force: true }),
  );
  assert.equal(p.available, false);
  assert.match(p.reason, /额度不足|欠费/);
  assert.match(p.reason, /insufficient_balance/);
});

test('HTTP 401 → available:false + 凭据提示', async () => {
  const cat = new ModelCatalog({ cfg, timeoutMs: 500 });
  const p = await withPatchedFetch({ error: { message: 'invalid api key' } }, 401, () => cat.probe('m-401', { force: true }));
  assert.equal(p.available, false);
  assert.match(p.reason, /凭据无效/);
});

test('★ reason 里绝不出现 api key（探测失败常带回上游原文）', async () => {
  const key = 'sk-probe-test-key-0123456789';
  const cat = new ModelCatalog({ cfg, timeoutMs: 500 });
  const p = await withPatchedFetch(
    { error: { message: `bad key ${key} rejected` } },
    401,
    () => cat.probe('m-leak', { force: true }),
  );
  assert.equal(p.available, false);
  // 实测：provider 层已把上游原文里的密钥打码成 `***`，我这层再兜一次 `<redacted:…>`
  assert.ok(!p.reason.includes(key), `reason 泄漏了密钥：${p.reason}`);
  assert.ok(!p.reason.includes('sk-'), `reason 里不该出现 sk- 前缀的任何串：${p.reason}`);
  assert.match(p.reason, /\*\*\*|<redacted/, `应能看到打码痕迹，实际：${p.reason}`);
  assert.match(p.reason, /凭据无效/, '同时要保留可读结论');
  assert.match(p.reason, /HTTP 401/, '以及状态码（便于排障）');
});

test('网络异常（fetch 抛）→ available:false + 可读原因，不冒泡', async () => {
  const cat = new ModelCatalog({ cfg, timeoutMs: 500 });
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:443');
  }) as typeof fetch;
  try {
    const p = await cat.probe('m-net', { force: true });
    assert.equal(p.available, false);
    assert.match(p.reason, /ECONNREFUSED/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('healthCheck 抛异常 → 我这边兜住并如实报（不让 /models 500）', async () => {
  const cat = new ModelCatalog({
    cfg,
    timeoutMs: 500,
    makeProvider: () => ({
      info: { id: 'x', kind: 'llm', label: 'x', vendor: 'x', runtime: 'cloud', configured: true, available: false, capabilities: {} },
      healthCheck() {
        throw new Error('unexpected');
      },
    }),
  });
  const p = await cat.probe('m-throws', { force: true });
  assert.equal(p.available, false);
  assert.match(p.reason, /探测抛异常：unexpected/);
  assert.equal(p.probe, 'healthCheck(threw)');
});

// ═══════════════════════════════════════════════════════════════════════
// 4. 缓存语义（避免每次 /models 都打 8 次真请求，但 deep=1 要能强制刷新）
// ═══════════════════════════════════════════════════════════════════════

test('探测结果按 TTL 缓存；`force` 绕过缓存', async () => {
  const cat = new ModelCatalog({ cfg, ttlMs: 60_000 });
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await cat.probe('m-cache');
    await cat.probe('m-cache');
    assert.equal(calls, 1, '第二次应命中缓存');
    await cat.probe('m-cache', { force: true });
    assert.equal(calls, 2, 'force 应重新探测');
    cat.invalidate();
    await cat.probe('m-cache');
    assert.equal(calls, 3, 'invalidate 后应重新探测');
  } finally {
    globalThis.fetch = orig;
  }
});

test('list()：候选含 active/fallbacks/provider/发现，且当前生效排最前', async () => {
  const cat = new ModelCatalog({
    cfg,
    ttlMs: 60_000,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'disc-a' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
    makeProvider: () => ({
      info: { id: 'amr', kind: 'llm', label: 'amr', vendor: 'AMR', runtime: 'cloud', configured: true, available: false, capabilities: {} },
      async healthCheck() {
        return { ok: true, latencyMs: 3, probe: 'POST /chat/completions (max_tokens=512)' };
      },
    }),
  });
  const r = await cat.list({ active: 'active-m', fallbacks: ['fb-1'] });
  assert.deepEqual(
    r.models.map((m) => m.id).sort(),
    ['active-m', 'configured-model', 'disc-a', 'fb-1'].sort(),
  );
  assert.equal(r.models[0]?.id, 'active-m');
  assert.equal(r.models[0]?.active, true);
  assert.equal(r.models[0]?.judgedBy, 'provider.healthCheck');
  assert.match(r.models[0]?.probe ?? '', /max_tokens=512/);
  assert.equal(r.activeAvailable, true);
});
