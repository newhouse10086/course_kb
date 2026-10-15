/**
 * ★★ **LLM 并发可配**（用户要求："并发设置为固定可改"）—— 判据是**真的并发了几路**，
 * **不是**"我们读了配置"（坑 24：能配 ≠ 真的生效）。
 *
 * ## 背景（这是坑 24 最纯粹的形态）
 * ```
 * 原实现: class SerialQueue { tail = Promise.resolve(); }   // promise 链
 *         export const LLM_QUEUE = new SerialQueue();        // ★ 机制里**没有"并发"这个维度**
 * ⟹ 就算把配置/钳制全改对，**改配置也不生效**（前几次死旋钮是"某处忘了读"，这次是"机制不存在"）
 * ```
 * `backend-api` 已把机制换成 `LlmSemaphore`（可配上限 · FIFO · `peakInFlight` 观测）；
 * 本文件验证**接线**（`index.ts::setLimit` + `/capabilities` 同源）真的生效。
 *
 * ## 判据（Lead 指定）
 * ```
 * ✔ ★★ **同时进行的调用数 == 配置值**（用可控的假 provider 记录**进入/离开**，断言**区间重叠数**）
 * ✔ ★ **默认 = 1**：断言**实际并发是 1**（不是断言"默认值是 1"）
 * ✔ ★ **配 3 → 真的同时跑 3 个**
 * ✔ ★ **配 99 / 0 / 负数 / 非数字 → 拒绝启动 + 可读 reason**（**不静默截断**）
 * ✔ ★ `/capabilities` 的并发值 **与 `LLM_QUEUE.concurrency` 同源**（坑 21）
 * ✔ ★ **公平性**：FIFO ⟹ **排队的任务都会被唤醒**（不饿死）；并**如实记录**当前语义的边界
 * ```
 * ⚠️ `LLM_QUEUE` 是**进程内单例** → 本文件在 `after()` 里恢复 `1`，避免污染其它测试。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, test } from 'node:test';

import { buildApp } from '../src/index.ts';
import type { BuiltApp } from '../src/index.ts';
import { loadConfig, resolveLlmConcurrency } from '../src/config.ts';
import { LLM_QUEUE } from '../src/providers/llm/openai_compatible.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  LLM_QUEUE.setLimit(1); // ★ 单例：每个用例后恢复默认，别污染别的测试
});

let tmp = '';
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-conc-'));
});
after(() => {
  LLM_QUEUE.setLimit(1);
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows 偶发占用 */
  }
});

/** 建 app（可选注入并发 env）；返回 app + 是否因非法配置被拒。 */
async function tryBuild(env: Record<string, string> = {}): Promise<{ app?: BuiltApp; error?: string }> {
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DB: path.join(tmp, `t-${Math.random().toString(36).slice(2)}.sqlite3`),
      COURSE_KB_DATA_DIR: path.join(tmp, 'data'),
      COURSE_KB_SETTINGS_FILE: path.join(tmp, 'settings.json'),
      COURSE_KB_BOOTSTRAP_ADMIN: 'admin:conc-pass-1',
      ...env,
    } as Record<string, string>,
  });
  try {
    return { app: await buildApp({ cfg }) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ① 配置解析（纯函数）：非法值**拒绝**而不是静默截断
// ═══════════════════════════════════════════════════════════════════════
test('★ `resolveLlmConcurrency`：不配 → 1；配 3 → 3；配 99 / 0 / -1 / abc → **rejected + 可读 reason**', () => {
  const d = resolveLlmConcurrency({});
  assert.equal(d.value, 1, '★ 不配必须默认 1（与改动前行为一致）');
  assert.equal(d.requested, null);
  assert.equal(d.rejected, undefined);

  const three = resolveLlmConcurrency({ COURSE_KB_LLM_CONCURRENCY: '3' });
  assert.equal(three.value, 3);
  assert.equal(three.rejected, undefined);

  const over = resolveLlmConcurrency({ COURSE_KB_LLM_CONCURRENCY: '99' });
  assert.ok(over.rejected, '★ 超上限必须 rejected');
  assert.match(over.rejected!, /99/, 'reason 必须含用户给的值');
  assert.match(over.rejected!, /拒绝/, 'reason 必须说清"拒绝"（不静默截断）');

  for (const bad of ['0', '-1', 'abc']) {
    const r = resolveLlmConcurrency({ COURSE_KB_LLM_CONCURRENCY: bad });
    assert.ok(r.rejected, `★ ${bad} 必须 rejected（0 并发 = 永远不跑）`);
    assert.equal(r.value, 1, '回落值必须是 1（绝不许是 0）');
  }
  // 上限本身可调
  const raised = resolveLlmConcurrency({ COURSE_KB_LLM_CONCURRENCY: '6', COURSE_KB_LLM_CONCURRENCY_MAX: '8' });
  assert.equal(raised.value, 6, '提高上限后 6 合法');
});

// ═══════════════════════════════════════════════════════════════════════
// ② ★★ 真的同时跑几路（**核心判据**）
// ═══════════════════════════════════════════════════════════════════════
/**
 * 用假 fetch 记录**每个请求的进入/离开**，算出**最大区间重叠数**（= 真实并发）。
 * ⚠️ 断言的是**重叠**，不是"配置值等于几"（坑 24）。
 */
async function measureRealConcurrency(built: BuiltApp, n: number, delayMs = 60): Promise<number> {
  let inFlight = 0;
  let peak = 0;
  const events: string[] = [];
  globalThis.fetch = (async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    events.push(`+${inFlight}`);
    await new Promise((r) => setTimeout(r, delayMs));
    inFlight -= 1;
    events.push(`-${inFlight}`);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  const req = { messages: [{ role: 'user' as const, content: 'hi' }], schema: { name: 's', schema: { type: 'object' } } };
  await Promise.all(Array.from({ length: n }, () => built.deps.providers!.completeJson(req)));
  return peak;
}

test('★★ 默认（不配）= **实际并发 1**（断言真实重叠，不是断言"默认值是 1"）', async () => {
  const { app } = await tryBuild();
  assert.ok(app, 'app 必须建起来');
  assert.equal(LLM_QUEUE.concurrency, 1, '前置：装配后队列上限应为 1');
  const peak = await measureRealConcurrency(app!, 4);
  assert.equal(peak, 1, `★ 默认必须**真的**串行（实测峰值 ${peak}）`);
  assert.equal(LLM_QUEUE.peakInFlight, 1, '观测字段也必须记录到 1');
  await app!.close();
});

test('★★ 配 `COURSE_KB_LLM_CONCURRENCY=3` → **真的同时跑 3 个**', async () => {
  const { app } = await tryBuild({ COURSE_KB_LLM_CONCURRENCY: '3' });
  assert.ok(app, 'app 必须建起来');
  assert.equal(LLM_QUEUE.concurrency, 3, '前置：装配应把上限设成 3');
  const peak = await measureRealConcurrency(app!, 6);
  assert.equal(peak, 3, `★ 配 3 必须**真的**同时跑 3 路（实测峰值 ${peak}）`);
  assert.equal(LLM_QUEUE.peakInFlight, 3, '★ 观测字段必须同步（peak_in_flight）');
  await app!.close();
});

test('★★ 配 99 / 0 / -1 / abc → **拒绝启动**（带可读 reason，**不静默截断**）', async () => {
  for (const bad of ['99', '0', '-1', 'abc']) {
    const { app, error } = await tryBuild({ COURSE_KB_LLM_CONCURRENCY: bad });
    assert.equal(app, undefined, `★ ${bad} 必须**拒绝启动**（不许静默改成别的值跑起来）`);
    assert.match(String(error), /拒绝启动/, `${bad} 的 reason 必须说清"拒绝启动"（实际：${error}）`);
    assert.match(String(error), new RegExp(bad === 'abc' ? 'abc' : bad), 'reason 必须含用户给的值');
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ③ 同源：`/capabilities` 读真值（坑 21）
// ═══════════════════════════════════════════════════════════════════════
test('★ `/capabilities` 的并发值**与队列同源**（配 2 → 两处都报 2，不是硬编码 1）', async () => {
  const { app } = await tryBuild({ COURSE_KB_LLM_CONCURRENCY: '2' });
  assert.ok(app);
  const addr = await app!.app.listen({ host: '127.0.0.1', port: 0 });
  const res = await REAL_FETCH(`${addr}/api/v1/capabilities`);
  assert.equal(res.status, 200);
  const j = (await res.json()) as Record<string, unknown>;
  const llm = j.llm as Record<string, unknown>;
  assert.equal(llm.concurrency, 2, '★ 契约 C1 的并发字段必须报**真值**');
  assert.equal(llm.concurrency, LLM_QUEUE.concurrency, '★ 必须与队列同源（不是第二个常量）');
  const detail = llm.concurrency_detail as Record<string, unknown>;
  assert.equal(typeof detail.in_flight, 'number', '必须给出在飞/排队观测（运维据此判断"调大有没有用"）');
  assert.equal(typeof detail.peak_in_flight, 'number');
  // 生成能力里的那份也必须同源
  const text = JSON.stringify(j);
  assert.match(text, /"llm_concurrency":2/, '★ 生成能力里的 llm_concurrency 也必须是真的 2（原来硬编码 1）');
  await app!.close();
});

// ═══════════════════════════════════════════════════════════════════════
// ④ 公平性：FIFO ⟹ 排队者都会被唤醒（不饿死）
// ═══════════════════════════════════════════════════════════════════════
test('★ 公平性：limit=1 时 5 个任务**全部完成且按提交顺序**（FIFO，不饿死任何排队者）', async () => {
  LLM_QUEUE.setLimit(1);
  const order: number[] = [];
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      LLM_QUEUE.run(async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(i);
      }),
    ),
  );
  assert.deepEqual(order, [0, 1, 2, 3, 4], '★ FIFO：后提交的不会被无限推迟（不饿死）');
  assert.equal(LLM_QUEUE.pending, 0, '全部完成后队列必须清空');
});

/**
 * ★ **如实记录当前语义的边界**（Lead 要求"要有断言，不能只是设计上应该公平"）：
 * 现状 = **FIFO 单池** ⟹ 一个**长任务**（如 434 页抽取）先占槽时，**短任务（用户提问）会排在它后面等**。
 * 这不是"饿死"（FIFO 保证它最终会跑），但**交互式请求的延迟 = 长任务剩余时间**。
 * ★ **优先级车道（交互优先 / 批量让路）需要改 `LlmSemaphore`**（`providers/**` 归 backend-api）
 *   ⟹ 本文件**只断言现状**，并把差异**如实上报**（不擅自重构别人的 semaphore）。
 */
test('★ 现状语义（如实记录）：长任务先占槽 → 短任务**排队等待**（FIFO，非饿死；优先级车道需改 semaphore）', async () => {
  LLM_QUEUE.setLimit(1);
  const timeline: string[] = [];
  const long = LLM_QUEUE.run(async () => {
    timeline.push('long:start');
    await new Promise((r) => setTimeout(r, 80));
    timeline.push('long:end');
  });
  await new Promise((r) => setTimeout(r, 10)); // 确保长任务已占槽
  const short = LLM_QUEUE.run(async () => {
    timeline.push('short:start');
    timeline.push('short:end');
  });
  await Promise.all([long, short]);
  assert.deepEqual(
    timeline,
    ['long:start', 'long:end', 'short:start', 'short:end'],
    '★ 现状：短任务必须**等长任务让出槽位**（FIFO）——若将来加了优先级车道，这条会红，**那时改它**',
  );
});

// ═══════════════════════════════════════════════════════════════════════
// ⑤ ★★ 公平性（Lead 裁定"最小形态"）：优先级车道
//    · 交互（人在等）插到批量前面 · 批量**仍必须能跑**（不饿死）· 默认不变
// ═══════════════════════════════════════════════════════════════════════
test('★★ ① 长批量在跑 + 交互提交 → **交互先完成**（长抽取不再堵住用户提问）', async () => {
  LLM_QUEUE.setLimit(1);
  const timeline: string[] = [];
  // 一个长批量任务先占住唯一槽位
  const longBatch = LLM_QUEUE.run(
    async () => {
      timeline.push('batch-long:start');
      await new Promise((r) => setTimeout(r, 60));
      timeline.push('batch-long:end');
    },
    { priority: 'batch' },
  );
  await new Promise((r) => setTimeout(r, 10)); // 确保它已占槽
  // 先排一个**批量**（本该按 FIFO 排第一），再排一个**交互**
  const queuedBatch = LLM_QUEUE.run(
    async () => {
      timeline.push('batch-queued:start');
      timeline.push('batch-queued:end');
    },
    { priority: 'batch' },
  );
  const interactive = LLM_QUEUE.run(
    async () => {
      timeline.push('interactive:start');
      timeline.push('interactive:end');
    },
    { priority: 'interactive' },
  );
  assert.equal(LLM_QUEUE.pendingInteractive, 1, '前置：交互车道里应有 1 个在等');
  assert.equal(LLM_QUEUE.pendingBatch, 1, '前置：批量车道里应有 1 个在等');
  await Promise.all([longBatch, queuedBatch, interactive]);
  assert.deepEqual(
    timeline,
    ['batch-long:start', 'batch-long:end', 'interactive:start', 'interactive:end', 'batch-queued:start', 'batch-queued:end'],
    '★ 交互必须**插到排在前面的批量之前**（这是"人在等"的公平性）',
  );
  assert.equal(LLM_QUEUE.pending, 0, '队列必须清空');
});

test('★★ ② **批量最终仍完成**（不饿死 —— 防"交互独占"这种反向不公平）', async () => {
  LLM_QUEUE.setLimit(1);
  const done: string[] = [];
  // 3 个批量 + 3 个交互交替提交，全部必须完成
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < 3; i += 1) {
    tasks.push(LLM_QUEUE.run(async () => {
      await new Promise((r) => setTimeout(r, 5));
      done.push(`batch${i}`);
    }, { priority: 'batch' }));
    tasks.push(LLM_QUEUE.run(async () => {
      await new Promise((r) => setTimeout(r, 5));
      done.push(`interactive${i}`);
    }, { priority: 'interactive' }));
  }
  await Promise.all(tasks);
  assert.equal(done.length, 6, '★ 6 个任务必须**全部完成**（交互优先 ≠ 批量饿死）');
  for (let i = 0; i < 3; i += 1) {
    assert.ok(done.includes(`batch${i}`), `★ 批量 batch${i} 必须跑完`);
    assert.ok(done.includes(`interactive${i}`), `交互 interactive${i} 必须跑完`);
  }
  assert.equal(LLM_QUEUE.pending, 0);
});

test('★ 默认优先级 = 批量：既有调用方行为不变（同优先级仍 FIFO）', async () => {
  LLM_QUEUE.setLimit(1);
  const order: number[] = [];
  await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      // ⚠️ 不传 priority（= 既有调用方的写法）→ 必须与改动前一样按提交顺序
      LLM_QUEUE.run(async () => {
        await new Promise((r) => setTimeout(r, 3));
        order.push(i);
      }),
    ),
  );
  assert.deepEqual(order, [0, 1, 2, 3], '★ 不传 priority 时行为必须与改动前一致（FIFO）');
});

test('★★ 端到端（真 provider 路径）：`priority:"interactive"` 真的插队 —— 假 fetch 记录**真实请求顺序**', async () => {
  const { app } = await tryBuild(); // 默认并发 1
  assert.ok(app);
  const fetchOrder: string[] = [];
  let releaseFirst: (() => void) | null = null;
  globalThis.fetch = (async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: { content?: string }[] };
    const tag = String(body.messages?.[0]?.content ?? '?');
    // ⚠️ 只记本用例的三个标签：假 fetch 也会看到**启动期探测**（如 'ping'）—— 那不是队列行为
    if (tag === 'long-batch' || tag === 'queued-batch' || tag === 'user-waiting') fetchOrder.push(tag);
    if (tag === 'long-batch') {
      // 第一个（批量）请求**卡住**，直到我们放行 —— 期间交互请求会排队
      await new Promise<void>((r) => {
        releaseFirst = r;
      });
    } else {
      await new Promise((r) => setTimeout(r, 5));
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  const call = (content: string, priority: 'interactive' | 'batch') =>
    app!.deps.providers!.completeJson({
      messages: [{ role: 'user' as const, content }],
      schema: { name: 's', schema: { type: 'object' } },
      priority,
    });

  const p1 = call('long-batch', 'batch'); // 先占槽（长）
  await new Promise((r) => setTimeout(r, 20));
  const p2 = call('queued-batch', 'batch'); // 先排的批量
  const p3 = call('user-waiting', 'interactive'); // 后提交但"人在等"
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fetchOrder, ['long-batch'], '前置：只有一个请求真的发出（并发=1）');
  releaseFirst!(); // 放行长批量
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(
    fetchOrder,
    ['long-batch', 'user-waiting', 'queued-batch'],
    '★★ 真 provider 路径：交互请求必须**插到排在前面的批量之前**（端到端，不只是 semaphore 单测）',
  );
  await app!.close();
});
