/**
 * ★★ 坑 32：**服务启动后第一次抽取不再白等 ~68 秒**（三态 + 后台预热）。
 *
 * ## 修之前的真实形状（Lead/backend-core 实测）
 * ```
 * 任务 719ms 就 running，但**第一次 completeJson 在 67,986ms**
 * 真因: runExtraction → availability() → resolveExtractorAvailability()
 *       → extractor.available() → providers.capabilities({deep:true}) = **一次真 LLM 探测**
 * 后果: UI 显示"运行中"，用户**以为卡死**（"看不到的失败"的体验版）
 * ```
 *
 * ## 两条判据（lead 指定，都要测）
 * ① **首个 LLM 调用延迟 ≤ 2s**（现在 68s）
 * ② **反例**：探测**真的失败/异常**时，**不许**因为"预热过了"就报可用 → 必须如实降级
 *
 * 全程**零 LLM**（用桩探测：挂起 / 失败 / 成功三种）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAvailabilityResolver } from '../src/tasks/handlers.ts';

/** 一个可控的桩探测：手动决定何时 resolve、以及 resolve 成什么 */
function controllableProbe(): {
  probe: () => Promise<{ ok: boolean; reason: string }>;
  resolveWith: (v: { ok: boolean; reason: string }) => void;
  rejectWith: (e: Error) => void;
  calls: () => number;
} {
  let calls = 0;
  let settle: (v: { ok: boolean; reason: string }) => void = () => {};
  let fail: (e: Error) => void = () => {};
  const promise = new Promise<{ ok: boolean; reason: string }>((res, rej) => {
    settle = res;
    fail = rej;
  });
  return {
    probe: () => {
      calls += 1;
      return promise;
    },
    resolveWith: (v) => settle(v),
    rejectWith: (e) => fail(e),
    calls: () => calls,
  };
}

test('★ 判据①：探测挂起 60s 也不阻塞 —— 首个"真调用"在 ≤2s 内发生（三态 detecting）', async () => {
  // ★ 模拟"真 LLM 探测要 60 秒"（实测 68s 的那种）
  const hanging = new Promise<{ ok: boolean; reason: string }>(() => {});
  let probeCalls = 0;
  const resolver = createAvailabilityResolver({
    probe: () => {
      probeCalls += 1;
      return hanging; // 永远不 resolve —— 模拟慢探测
    },
  });

  // 启动预热（后台）
  resolver.warmUp();
  assert.equal(resolver.state(), 'detecting', 'warmUp 后应在检测中');

  // ★ 关键：抽取路径问可用性 —— 必须**立即**返回，不许 await 探测
  const t0 = Date.now();
  const av = await resolver.current();
  const waited = Date.now() - t0;
  assert.ok(waited < 2_000, `★ 可用性查询必须立即返回（实际 ${waited}ms）—— 这就是 68s 的来源`);
  assert.equal(av.ok, true, '检测中应放行（按轻量判据尝试）');
  assert.equal(av.detecting, true, '★ 必须如实标注"检测中"（既不是 ready 也不是 unavailable）');
  assert.equal(typeof av.waitedMs, 'number', '要能如实告知"等了多久"');
  assert.equal(probeCalls, 1, '探测只发一次（不许每个任务都真探测）');

  // ★ 判据①的完整形状：放行后第一次"真调用"立刻发生（这里用 20ms 的假调用代表真 LLM 请求）
  const firstCallAt = Date.now();
  await new Promise((r) => setTimeout(r, 20));
  const firstCallLatency = Date.now() - firstCallAt;
  assert.ok(firstCallLatency < 2_000, `首个真调用延迟必须 ≤2s（实际 ${firstCallLatency}ms）`);

  // 再问一次仍是检测中（不重复探测）
  const av2 = await resolver.current();
  assert.equal(av2.detecting, true);
  assert.equal(probeCalls, 1, '第二次询问不该再发探测');
});

test('★★ 判据②（反例）：探测**真的失败** → 必须如实降级，不许因为"预热过了"就报可用', async () => {
  const ctl = controllableProbe();
  const resolver = createAvailabilityResolver({ probe: ctl.probe });

  resolver.warmUp(); // 预热
  const during = await resolver.current();
  assert.equal(during.detecting, true, '探测未完成时是 detecting');

  // ★ 探测**真的**返回不可用（例如额度耗尽 / 未配置凭据）
  ctl.resolveWith({ ok: false, reason: 'LLM 真探测未通过：401 invalid api key' });

  // ⚠️ 断言前必须等"结果被记录"：pino 式 promise 链是在**微任务**里写 `resolved` 的，
  //    紧接着同步断言会看到上一刻的 `detecting`（我第一版就这么误判过 —— 是**测试的错**，不是实现的错）。
  const recorded = await resolver.settled();
  assert.equal(recorded.ok, false, '★ settled() 必须给出真实结果');

  const after = await resolver.current();
  assert.equal(after.detecting, false, '探测完成后不再是 detecting');
  assert.equal(after.ok, false, '★★ 探测失败必须报不可用 —— 这正是"不许因为预热过就报可用"');
  assert.match(after.reason, /401 invalid api key/, 'reason 要如实带出（用户/运维要知道为什么）');
});

test('★★ 判据②（更强反例）：探测**抛异常** → 同样必须如实降级（不许被吞掉当可用）', async () => {
  const ctl = controllableProbe();
  const resolver = createAvailabilityResolver({ probe: ctl.probe });
  resolver.warmUp();
  assert.equal((await resolver.current()).detecting, true);

  ctl.rejectWith(new Error('ECONNRESET 探测连接被重置'));

  const recorded = await resolver.settled();
  assert.equal(recorded.ok, false, '★ 探测异常 = 不可用（不是"可用"）');
  assert.equal(recorded.detecting, false, '异常也要落成明确结论，不能停在"检测中"');
  assert.match(recorded.reason, /ECONNRESET/, '异常原因要如实带出');
  const after = await resolver.current();
  assert.equal(after.ok, false, '后续询问同样如实报不可用');
});

test('★ 探测成功 → 如实报可用（且只探测一次、结果被缓存）', async () => {
  const ctl = controllableProbe();
  let resolvedEvents = 0;
  const resolver = createAvailabilityResolver({
    probe: ctl.probe,
    onResolved: () => {
      resolvedEvents += 1;
    },
  });
  resolver.warmUp();
  ctl.resolveWith({ ok: true, reason: '' });
  await resolver.settled(); // 等结果被记录（微任务）

  const a = await resolver.current();
  const b = await resolver.current();
  assert.equal(a.ok, true);
  assert.equal(a.detecting, false);
  assert.deepEqual(b, a, '结果应被缓存');
  assert.equal(ctl.calls(), 1, '只探一次');
  assert.equal(resolvedEvents, 1, '结果回调只触发一次');
  assert.equal(resolver.state(), 'resolved');
});

test('★ 硬性不可用（没抽取器 / 枚举没加载）→ **不浪费真探测**，立即如实拒绝', async () => {
  const ctl = controllableProbe();
  const resolver = createAvailabilityResolver({
    probe: ctl.probe,
    hardUnavailable: () => ({ ok: false, reason: '封闭枚举未加载（schema/ 缺失）' }),
  });
  resolver.warmUp();
  const av = await resolver.current();
  assert.equal(av.ok, false);
  assert.equal(av.detecting, false, '硬性不可用不该显示"检测中"（那会误导用户以为在等）');
  assert.match(av.reason, /封闭枚举未加载/);
  assert.equal(ctl.calls(), 0, '★ 硬性不可用时**一次网络探测都不该发**（省额度）');
});

test('★ settled()：只有显式等待时才等（生产路径不用它阻塞请求）', async () => {
  const ctl = controllableProbe();
  const resolver = createAvailabilityResolver({ probe: ctl.probe });
  resolver.warmUp();
  const p = resolver.settled();
  ctl.resolveWith({ ok: true, reason: '' });
  const av = await p;
  assert.equal(av.ok, true);
  assert.equal(av.detecting, false);
});
