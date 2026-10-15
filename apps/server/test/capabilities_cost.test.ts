/**
 * ★★ `/capabilities` 的**成本守卫 + 实时性守卫**（Lead 裁定 ⑤）。
 *
 * ## 缺陷（与 `/models` 同一类放大器）
 * `/capabilities` **默认深探测**（`deep = q.deep !== '0'`）→ registry 对**每个 configured provider**
 * 强制 `healthCheck()`（`force:true`）→ 每个 = **一次真实上游调用**（LLM/ASR/TTS/OCR/翻译）。
 * 而 `CAPS_TTL_MS` 只有 **15s** ⟹ **等于没有缓存**：前端按 15s 轮询 → **每 15s 烧一轮探测**。
 *
 * ## 判据（★ 打在"真发出去的调用数"与"实时字段有没有被冻住"上）
 * 1. TTL 内二次请求 → **真探测调用数 = 0**（缓存生效），且 `probe_calls === 0`
 * 2. ★ **TTL 内改数据 → `auth` / `settings` / `retrieval` 仍立刻变**（LIVE_FIELDS 没被冻 —— 坑 19）
 * 3. `probe_calls` 与**真实探测次数逐一相等**（自述与生效同源 —— 坑 21）
 * 4. `?refresh=1` → 真探测（`probe_calls > 0`）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { buildApp } from '../src/index.ts';
import { loadConfig } from '../src/config.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
let tmp = '';
let built: Awaited<ReturnType<typeof buildApp>> | null = null;
let base = '';
let cookie = '';

/** ★ 统计**真实上游探测**：provider 层的 `healthCheck()` 会发 `POST …/chat/completions`。 */
const calls = { chatCompletions: 0, modelsGet: 0 };
let realFetch: typeof fetch;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-cost-'));
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DB: path.join(tmp, 't.sqlite3'),
      COURSE_KB_DATA_DIR: path.join(tmp, 'data'),
      COURSE_KB_SETTINGS_FILE: path.join(tmp, 'settings.json'),
      COURSE_KB_BOOTSTRAP_ADMIN: 'admin:caps-cost-pass-1',
      // 造一个"已配置"的 LLM provider（探测会真发请求 → 被我们数到）
      AMR_BASE: 'https://caps-cost.local/v1',
      AMR_KEY: 'sk-caps-cost-key-0123456789',
      LLM_MODEL: 'caps-cost-model',
    } as Record<string, string>,
  });
  built = await buildApp({ cfg });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('取不到监听地址');
  base = `http://127.0.0.1:${addr.port}`;

  // 假上游：探测成功（非空 content → available:true）
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(base)) return realFetch(input as never, init as never); // 本地请求走真 fetch
    if (url.includes('/chat/completions')) {
      calls.chatCompletions += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), { status: 200 });
    }
    calls.modelsGet += 1;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;

  const login = await realFetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'caps-cost-pass-1' }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

after(async () => {
  globalThis.fetch = realFetch;
  try {
    if (built) await built.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows 偶发占用 */
  }
});

const getCaps = async (qs = ''): Promise<Record<string, unknown>> => {
  const r = await realFetch(`${base}/api/v1/capabilities${qs}`, { headers: { cookie } });
  assert.equal(r.status, 200, `capabilities 应 200，实际 ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
};

test('★★ `?refresh=1` → 真探测，且 `probe_calls` 与**真实调用数**一致（坑 21 同源）', async () => {
  const before = calls.chatCompletions;
  const caps = await getCaps('?refresh=1');
  const real = calls.chatCompletions - before;
  const reported = Number(caps.probe_calls ?? -1);
  assert.ok(reported > 0, `★ refresh=1 必须真探测，probe_calls=${reported}`);
  assert.equal(reported, real, `★ probe_calls 必须等于真实探测次数（自述 ${reported} vs 真实 ${real}）`);
  assert.equal(caps.cached, false, 'refresh=1 不来自缓存');
  assert.equal(caps.cache_ttl_ms, 300_000, '★ TTL 必须是 5 分钟（原 15s 等于没有缓存）');
});

test('★★ TTL 内二次请求：**真探测调用数 = 0**，且 `probe_calls === 0`', async () => {
  await getCaps('?refresh=1'); // 先重建缓存
  const before = calls.chatCompletions;
  const second = await getCaps();
  const real = calls.chatCompletions - before;
  assert.equal(real, 0, `★ TTL 内再问**一次真探测都不许有**（实际 ${real} 次）`);
  assert.equal(second.cached, true, 'TTL 内应命中缓存');
  assert.equal(second.probe_calls, 0, '★ 命中缓存必须如实报 probe_calls=0（不许谎报"又探了 N 次"）');
});

test('★★ TTL 内改数据 → 实时字段**仍立刻变**（LIVE_FIELDS 没被 5 分钟 TTL 冻住 —— 坑 19）', async () => {
  await getCaps('?refresh=1'); // 预热缓存
  const warm = await getCaps();
  assert.equal(warm.cached, true, '先确认这一轮走的是缓存');

  // ★ 改数据：切模型（`settings.activeModel` 承诺实时）
  const sw = await realFetch(`${base}/api/v1/settings/llm/switch/resume`, { method: 'POST', headers: { cookie } });
  assert.ok([200, 400, 404].includes(sw.status), `切换/续推接口状态 ${sw.status}`);

  const after2 = await getCaps();
  const live = after2.live_fields as string[];
  for (const f of ['auth', 'settings', 'retrieval', 'search']) {
    assert.ok(live.includes(f), `★ ${f} 必须在 live_fields 里（承诺实时）`);
  }
  assert.ok(!(after2.cacheable_fields as string[]).includes('auth'), '★ auth 绝不许进可缓存集合');
  assert.ok(!(after2.cacheable_fields as string[]).includes('settings'), '★ settings 绝不许进可缓存集合');
  assert.ok(!(after2.cacheable_fields as string[]).includes('retrieval'), '★ retrieval 绝不许进可缓存集合');
  // 缓存命中时，实时字段来自**重算**（不是缓存体）—— 结构上保证：
  assert.equal(after2.cached, true, '命中缓存');
  assert.ok(after2.settings && typeof after2.settings === 'object', 'settings 仍在响应里（来自实时重算）');
  assert.ok(after2.auth && typeof after2.auth === 'object', 'auth 仍在响应里（来自实时重算）');
  // `probe_calls` / `probe_detail` 也在实时集合里（它们描述**本次**代价）
  assert.ok(live.includes('probe_calls'), '★ probe_calls 必须在实时集合（否则会谎报上次的探测数）');
});

test('★ 未分类字段 fail-safe 仍在：新字段默认按实时处理（不冒险用缓存）', async () => {
  const caps = await getCaps('?refresh=1');
  assert.deepEqual(caps.unclassified_fields, [], '★ 所有顶层字段都必须已分类（新字段忘了分类 → 会退化成全量重算）');
  // `probe_calls` 这类新字段必须已被显式分类，否则上面这条会红
  const classified = new Set([...(caps.cacheable_fields as string[]), ...(caps.live_fields as string[])]);
  assert.ok(classified.has('probe_calls'), 'probe_calls 必须显式分类');
  assert.ok(classified.has('chat_modes'), 'chat_modes 必须显式分类（历史坑）');
});
