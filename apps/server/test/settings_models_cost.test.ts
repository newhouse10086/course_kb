/**
 * ★★ **探测的成本守卫** —— 真实缺陷修复的回归测试。
 *
 * ## 缺陷（Lead 定位，用户侧症状）
 * 平台显示 **kimi-k3 被调用 263 次**，而**会话文件里 kimi = 0** → 调用不来自对话，来自**模型探测**。
 * 根因：`ModelCatalog.list()` 对**所有候选**（`active` + `fallbacks` + **端点发现的全部模型**）
 * 逐个 `probe()`，而 `probe()` 是**真发一次 `chat/completions`（计费）**。
 * 于是"看一眼模型列表"这种**无害只读操作**会花掉 8+ 次真实调用 —— 用户完全不会预期它花钱。
 *
 * ## 本测试的判据（★ **打在"真发出去的调用次数"上**，不是"我们缓存了"）
 * 1. `/models` **默认路径**：**只 1 次**（active）；fallbacks 与端点模型 **0 次**
 * 2. `?deep=1`：调用数 = 候选数，且 `probeCalls` 与**真实调用数一致**（坑 21：自述必须与生效同源）
 * 3. **兜底模型在无降级时零调用**
 * 4. **TTL 内二次请求零调用**
 * 5. `skippedProbe` 如实列出"因成本隔离没探的模型"，且它们**不谎报可用**
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { before, test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import type { ServerConfig } from '../src/config.ts';
import { ModelCatalog } from '../src/settings/models.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
let cfg: ServerConfig;
before(() => {
  cfg = loadConfig({
    root: ROOT,
    env: {
      AMR_BASE: 'https://cost-test.local/v1',
      AMR_KEY: 'sk-cost-test-key-0123456789',
      LLM_MODEL: 'active-model',
    } as Record<string, string>,
  });
});

interface Counted {
  /** ★ **计费调用**（`POST …/chat/completions` = 探测） */
  probes: string[];
  /** 非计费：`GET /models`（端点发现） */
  discovers: number;
}

/**
 * 替换 `globalThis.fetch`：**只统计计费调用**（探测 POST），并让探测"成功"
 * （HTTP 200 + 非空 content —— 否则会被判 `available:false`，影响其它断言）。
 */
async function withCountedFetch<T>(
  fn: (c: Counted) => Promise<T>,
  opts: { endpointModels?: string[] } = {},
): Promise<{ result: T; counted: Counted }> {
  const orig = globalThis.fetch;
  const counted: Counted = { probes: [], discovers: 0 };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/chat/completions')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      counted.probes.push(String(body.model ?? ''));
      // 探测成功的形状（provider 层 healthCheck 会读 content）
      return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), { status: 200 });
    }
    counted.discovers += 1;
    return new Response(JSON.stringify({ data: (opts.endpointModels ?? []).map((id) => ({ id })) }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await fn(counted);
    return { result, counted };
  } finally {
    globalThis.fetch = orig;
  }
}

const INPUT = { active: 'active-model', fallbacks: ['cheap-fallback', 'kimi-k3'] };

test('★★ 默认路径：只探 active（1 次计费调用）；fallbacks 与端点模型 **0 次**', async () => {
  const cat = new ModelCatalog({ cfg, timeoutMs: 500 });
  const { result, counted } = await withCountedFetch(
    () => cat.list({ ...INPUT }),
    { endpointModels: ['endpoint-a', 'endpoint-b', 'endpoint-c'] },
  );

  assert.deepEqual(counted.probes, ['active-model'], `★ 默认只该探 active，实际探了 ${JSON.stringify(counted.probes)}`);
  assert.equal(result.probeCalls, 1, '★ probeCalls 必须是 1（= 真实调用数）');
  assert.deepEqual(result.probed, ['active-model'], 'probed 与真实调用同源');
  // ★ 兜底模型**零调用**（无降级时不该花钱）—— 这正是 263 次 kimi 的来源
  assert.ok(!counted.probes.includes('kimi-k3'), '★ 兜底模型 kimi-k3 绝不能在默认路径被探测');
  assert.ok(!counted.probes.includes('cheap-fallback'), '★ 另一个 fallback 也不许被探');
  // 未探的模型如实列出，且**不谎报可用**
  for (const id of ['cheap-fallback', 'kimi-k3', 'endpoint-a']) {
    assert.ok(result.skippedProbe.includes(id), `未探测的 ${id} 必须出现在 skippedProbe`);
    const entry = result.models.find((m) => m.id === id);
    assert.ok(entry, `${id} 仍应出现在清单里（只是没探）`);
    assert.equal(entry.probe, 'skipped', '★ 如实标注 probe=skipped');
    assert.equal(entry.available, false, '★ 未探测不许报"可用"（坑 10：不假装可用）');
    assert.match(entry.reason, /未探测/, 'reason 要说清"未探测"而不是"不可用"');
  }
  // active 必须真探过
  const act = result.models.find((m) => m.id === 'active-model');
  assert.equal(act?.probe === 'skipped', false, 'active 必须真探');
  assert.equal(act?.available, true, 'active 探测成功应可用');
});

test('★ ?deep=1：调用数 = 候选数，且 probeCalls 与**真实调用数一致**（坑 21 同源）', async () => {
  const cat = new ModelCatalog({ cfg, timeoutMs: 500 });
  const { result, counted } = await withCountedFetch(
    () => cat.list({ ...INPUT, deep: true }),
    { endpointModels: ['endpoint-a', 'endpoint-b'] },
  );
  // 候选 = active + 2 fallbacks + 2 endpoint = 5（provider 模型与 active 同名，去重后仍是 5）
  const candidates = result.models.length;
  assert.equal(counted.probes.length, candidates, `★ deep 应探全部候选（${candidates}），实际 ${counted.probes.length}`);
  assert.equal(result.probeCalls, counted.probes.length, '★ probeCalls 必须等于真实调用数（不许自述不符）');
  assert.deepEqual([...result.probed].sort(), [...counted.probes].sort(), 'probed 列表必须与真实调用逐一对上');
  assert.equal(result.skippedProbe.length, 0, 'deep 下没有跳过的模型');
  assert.ok(counted.probes.includes('kimi-k3'), 'deep 是**显式**全探（代价可见）');
});

test('★ TTL 内二次请求：**零调用**（缓存命中不算调用）', async () => {
  const cat = new ModelCatalog({ cfg, timeoutMs: 500 }); // 默认 TTL = 5 分钟
  const first = await withCountedFetch(() => cat.list({ ...INPUT }));
  assert.equal(first.counted.probes.length, 1, '首次：1 次');
  const second = await withCountedFetch(() => cat.list({ ...INPUT }));
  assert.equal(second.counted.probes.length, 0, '★ TTL 内再问**一次调用都不许有**');
  assert.equal(second.result.probeCalls, 0, 'probeCalls 如实为 0（用的是缓存）');
  assert.equal(second.result.models.find((m) => m.id === 'active-model')?.cached, true, 'cached 必须为 true');
  assert.equal(second.result.ttlMs, 300_000, '★ TTL 必须是 5 分钟（原 60s 太短 → 每分钟轮询都在烧钱）');
});

test('★ TTL 过期 → 重新真探（缓存不是"永远不探"）', async () => {
  let now = 1_000_000;
  const cat = new ModelCatalog({ cfg, timeoutMs: 500, ttlMs: 1000, now: () => now });
  const a = await withCountedFetch(() => cat.list({ ...INPUT }));
  assert.equal(a.counted.probes.length, 1);
  now += 1001; // 过期
  const b = await withCountedFetch(() => cat.list({ ...INPUT }));
  assert.equal(b.counted.probes.length, 1, '★ 过期后必须重新真探（否则"可用性"会一直是旧结论）');
});

test('★ 兜底模型只在**显式 deep** 时才被调用（无降级 → 平时零调用）', async () => {
  const cat = new ModelCatalog({ cfg, timeoutMs: 500 });
  const { counted } = await withCountedFetch(() => cat.list({ ...INPUT }));
  const fallbacks = ['cheap-fallback', 'kimi-k3'];
  for (const f of fallbacks) {
    assert.ok(!counted.probes.includes(f), `★ 无降级时 ${f} 必须零调用`);
  }
});
