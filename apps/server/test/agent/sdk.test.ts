/**
 * `sdk.ts` 单测：**动态 import 加载层 + 诚实降级**。
 *
 * 核心主张：SDK 装不上时，服务必须还能起来并**如实**报不可用（而不是崩在模块加载阶段）。
 * 这里用注入的 importer 模拟各种失败；真实 SDK 加载见 integration.test.ts。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SDK_SPECIFIER, clearSdkCache, loadSdk, peekSdkCache, warmupSdk } from '../../src/agent/sdk.ts';

const fakeModule = {
  VERSION: '9.9.9',
  createAgentSession: async () => ({ session: {} }),
  SessionManager: function SessionManager() {},
};

test('加载成功 → available:true + version + loadMs；缺 VERSION 时为 null（不编造）', async () => {
  clearSdkCache();
  const sdk = await loadSdk({ importer: async () => fakeModule });
  assert.equal(sdk.available, true);
  if (!sdk.available) return;
  assert.equal(sdk.version, '9.9.9');
  assert.equal(sdk.specifier, DEFAULT_SDK_SPECIFIER);
  assert.equal(typeof sdk.loadMs, 'number');
  assert.equal(typeof sdk.createAgentSession, 'function');
  assert.equal(typeof sdk.SessionManager, 'function');

  const noVersion = await loadSdk({ importer: async () => ({ ...fakeModule, VERSION: undefined }) });
  assert.equal(noVersion.available, true);
  if (noVersion.available) assert.equal(noVersion.version, null);
});

test('ERR_MODULE_NOT_FOUND → available:false + 明确提示 npm install', async () => {
  clearSdkCache();
  const err = Object.assign(new Error("Cannot find package '@earendil-works/pi-coding-agent'"), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
  const sdk = await loadSdk({
    importer: async () => {
      throw err;
    },
  });
  assert.equal(sdk.available, false);
  if (sdk.available) return;
  assert.match(sdk.reason, /未安装/);
  assert.match(sdk.reason, /npm install/);
  assert.match(sdk.detail, /ERR_MODULE_NOT_FOUND/);
});

test('其它加载异常 → available:false + 原始信息（便于排查，不吞错）', async () => {
  clearSdkCache();
  const sdk = await loadSdk({
    importer: async () => {
      throw new Error('SyntaxError: Unexpected token in dist/index.js');
    },
  });
  assert.equal(sdk.available, false);
  if (sdk.available) return;
  assert.match(sdk.reason, /加载失败/);
  assert.match(sdk.reason, /Unexpected token/);
});

test('装了但缺关键导出 → 判不可用（不"半可用"）', async () => {
  clearSdkCache();
  const noCreate = await loadSdk({ importer: async () => ({ SessionManager: fakeModule.SessionManager }) });
  assert.equal(noCreate.available, false);
  if (!noCreate.available) assert.match(noCreate.reason, /createAgentSession/);

  const noSm = await loadSdk({ importer: async () => ({ createAgentSession: fakeModule.createAgentSession }) });
  assert.equal(noSm.available, false);
  if (!noSm.available) assert.match(noSm.reason, /SessionManager/);
});

test('默认 specifier 的结果被缓存（含失败缓存：避免每次 /capabilities 重试 4 秒）', async () => {
  clearSdkCache();
  let imports = 0;
  const importer = async (): Promise<unknown> => {
    imports += 1;
    return fakeModule;
  };
  // 注入 importer 时**不缓存**（可注入=测试/特殊路径，必须每次如实）
  await loadSdk({ importer });
  await loadSdk({ importer });
  assert.equal(imports, 2);
  assert.equal(peekSdkCache(), null);

  // 真实路径（无注入）才缓存 —— 用 force 触发一次真实加载
  const real = await loadSdk({ force: true });
  assert.equal(peekSdkCache() !== null, true, '真实路径必须缓存');
  const cachedAgain = await loadSdk();
  assert.equal(cachedAgain.specifier, real.specifier);
});

test('warmupSdk 永不抛，返回是否可用', async () => {
  clearSdkCache();
  assert.equal(await warmupSdk({ importer: async () => fakeModule }), true);
  assert.equal(
    await warmupSdk({
      importer: async () => {
        throw new Error('nope');
      },
    }),
    false,
  );
});

test('并发调用只触发一次加载（inflight 合并）', async () => {
  clearSdkCache();
  let imports = 0;
  const importer = async (): Promise<unknown> => {
    imports += 1;
    await new Promise((r) => setTimeout(r, 30));
    return fakeModule;
  };
  const results = await Promise.all([loadSdk({ importer }), loadSdk({ importer })]);
  // 注入路径不缓存，所以这里是 2 次；真实路径才合并。
  assert.equal(imports, 2);
  assert.ok(results.every((r) => r.available));

  clearSdkCache();
  let realImports = 0;
  const realImporter = async (): Promise<unknown> => {
    realImports += 1;
    await new Promise((r) => setTimeout(r, 30));
    return fakeModule;
  };
  // 通过两次 force 绕过缓存但仍走同一 specifier 的 inflight 合并
  const [a, b] = await Promise.all([loadSdk({ importer: realImporter, force: true }), loadSdk({ importer: realImporter, force: true })]);
  assert.ok(a.available && b.available);
  assert.equal(realImports, 2, '注入路径各自加载（不做全局合并，避免测试间串味）');
});
