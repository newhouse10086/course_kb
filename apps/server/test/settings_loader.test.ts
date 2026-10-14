/**
 * `settings.json` 加载 / 校验 / **热重载** 测试
 * （`docs/SETTINGS_AND_SANDBOX.md` §1）。
 *
 * 全部**真读写文件、真挂 `fs.watch`、真等事件**（不 mock fs）—— 因为要验的正是
 * "改文件不重启即生效"这条；用假 fs 会把最容易坏的环节（编辑器 rename、防抖、mtime）
 * 全绕过去。
 *
 * 断言**具体值**（不是"非空"）：
 * - 缺文件 → `source === 'default'` 且默认值逐字段相等
 * - 非法 → 抛错且 `issues` 里含**具体路径**（`$.llm.maxTokens`）
 * - `concurrency: 8` → 实际 `1`，且 `ignored[0].path === 'llm.concurrency'`
 * - 热重载：写完文件 → **拿到新值**、`revision` 自增、`loadedAt` 变新
 * - 非法热重载：**旧值继续生效** + `lastReloadError` 有内容 + 服务不崩
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
  SettingsError,
  SettingsStore,
  loadSettings,
  redactSettings,
  validateSettings,
  writeSettingsFile,
  HARD_LLM_CONCURRENCY,
  defaultSettings,
  sandboxLimitsOf,
} from '../src/settings/index.ts';
import type { Settings } from '../src/settings/index.ts';

let tmp = '';

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-settings-'));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
/** 每个用例一个独立目录（避免 watcher 互相干扰） */
function dir(): string {
  n += 1;
  const d = path.join(tmp, `c${n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 等条件成立（有界），避免"睡死等"导致测试慢或假过。 */
async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 1. 文件缺失 → 内置默认 + 如实标注来源
// ═══════════════════════════════════════════════════════════════════════

test('文件缺失 → source=default，且默认值逐字段确定', () => {
  const d = dir();
  const r = loadSettings({ root: d });
  assert.equal(r.source, 'default');
  assert.equal(r.path, path.join(d, 'config/settings.json'));
  assert.equal(r.mtimeMs, 0);
  assert.ok(r.warnings[0]?.includes('不存在'), `warnings 应说明文件不存在，实际：${r.warnings[0]}`);
  // 与内置默认**逐字段**相等（不是"非空"）
  assert.deepEqual(r.settings, defaultSettings());
  assert.equal(r.settings.llm.active, 'deepseek-v4.1-flash');
  assert.equal(r.settings.sandbox.limits.maxRows, 200);
  assert.equal(r.settings.hotReload.debounceMs, 500);
});

test('文件存在 → source=file，并回填真实 mtime', () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  writeJson(f, { version: 1, llm: { active: 'glm-5.3' } });
  const r = loadSettings({ root: d, file: f });
  assert.equal(r.source, 'file');
  assert.equal(r.settings.llm.active, 'glm-5.3');
  assert.ok(r.mtimeMs > 0, '应回填 mtime');
  // 未写的字段用默认（且这里没有 warning，因为不是"缺失文件"）
  assert.equal(r.settings.llm.temperature, 0);
  assert.equal(r.settings.translate.glossaryMode, 'inject');
});

// ═══════════════════════════════════════════════════════════════════════
// 2. 非法配置 → 拒绝 + **可读原因（含路径）**
// ═══════════════════════════════════════════════════════════════════════

test('非法配置被拒：类型错 → 报错含具体路径', () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  writeJson(f, { version: 1, llm: { active: 'glm-5.3', maxTokens: '很多' } });
  assert.throws(
    () => loadSettings({ root: d, file: f }),
    (e: unknown) => {
      assert.ok(e instanceof SettingsError, '应抛 SettingsError');
      const issues = (e as SettingsError).issues.join('\n');
      assert.match(issues, /\$\.llm\.maxTokens: 应为整数/, `issues 应指向具体路径，实际：${issues}`);
      return true;
    },
  );
});

test('非法配置被拒：未知字段（拼错）→ 报错并列出允许的字段', () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  writeJson(f, { version: 1, llm: { active: 'x', maxToken: 123 } });
  assert.throws(
    () => loadSettings({ root: d, file: f }),
    (e: unknown) => {
      const issues = (e as SettingsError).issues.join('\n');
      assert.match(issues, /\$\.llm\.maxToken: 未知字段（允许：/);
      return true;
    },
  );
});

test('非法配置被拒：越界值 / 枚举值 / 空字符串 都有各自可读原因', () => {
  const cases: { raw: Record<string, unknown>; expect: RegExp }[] = [
    { raw: { version: 1, llm: { active: 'x' }, sandbox: { limits: { maxRows: 99999 } } }, expect: /\$\.sandbox\.limits\.maxRows: 不能大于 10000/ },
    { raw: { version: 1, llm: { active: 'x' }, sandbox: { engine: 'oracle' } }, expect: /\$\.sandbox\.engine: 应为 sqlite \| postgres \| mysql \| opengauss 之一/ },
    { raw: { version: 1, llm: { active: '' } }, expect: /\$\.llm\.active: 不能为空字符串/ },
    { raw: { version: 1, llm: { active: 'x', temperature: 3 } }, expect: /\$\.llm\.temperature: 不能大于 2/ },
    { raw: { version: 1, llm: { active: 'x', fallbacks: ['ok', 7] } }, expect: /\$\.llm\.fallbacks\[1\]: 应为非空字符串/ },
    { raw: { version: 0, llm: { active: 'x' } }, expect: /\$\.version: 不能小于 1/ },
    { raw: { version: 1, llm: { active: 'x' }, quota: { student: { concurrentLlmTasks: 0 } } }, expect: /\$\.quota\.student\.concurrentLlmTasks: 不能小于 1/ },
    { raw: { version: 1, llm: { active: 'x' }, hotReload: { debounceMs: 10 } }, expect: /\$\.hotReload\.debounceMs: 不能小于 50/ },
  ];
  for (const c of cases) {
    assert.throws(
      () => validateSettings(c.raw),
      (e: unknown) => {
        const issues = (e as SettingsError).issues.join('\n');
        assert.match(issues, c.expect, `期望 ${c.expect}，实际 issues：${issues}`);
        return true;
      },
      `应拒绝：${JSON.stringify(c.raw)}`,
    );
  }
});

test('非法 JSON（含 // 注释）→ 报 JSON 解析失败 + 可读提示', () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  fs.writeFileSync(f, '{\n  // 注释是 JSONC，不允许\n  "version": 1\n}\n', 'utf8');
  assert.throws(
    () => loadSettings({ root: d, file: f }),
    (e: unknown) => {
      const issues = (e as SettingsError).issues.join('\n');
      assert.match(issues, /JSON 解析失败/);
      assert.match(issues, /JSONC/);
      return true;
    },
  );
});

test('SettingsError.toBody() 是契约 §8 形状（E_BADREQUEST 400 + detail 列出问题）', () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  writeJson(f, { version: 1, llm: { active: '' } });
  try {
    loadSettings({ root: d, file: f });
    assert.fail('应当抛错');
  } catch (e) {
    const body = (e as SettingsError).toBody();
    assert.equal(body.error.code, 'E_BADREQUEST');
    assert.match(body.error.msg, /1 处/);
    assert.match(body.error.detail, /\$\.llm\.active/);
    assert.ok(body.error.hint.includes('settings.schema.json'));
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 3. ★ 凭据不许进 settings.json
// ═══════════════════════════════════════════════════════════════════════

test('凭据键名（apiKey/token/password/accessKey）一律拒绝，并说明该放哪', () => {
  for (const key of ['api_key', 'apiKey', 'AMR_KEY', 'accessToken', 'password', 'accessKey', 'privateKey']) {
    assert.throws(
      () => validateSettings({ version: 1, llm: { active: 'x', [key]: 'whatever' } }),
      (e: unknown) => {
        const issues = (e as SettingsError).issues.join('\n');
        assert.match(issues, /禁止放凭据|未知字段/, `键 ${key} 应被拒，实际：${issues}`);
        return true;
      },
      `键 ${key} 必须被拒`,
    );
  }
});

test('凭据**值**（sk-…）混在合法字段里也被拒', () => {
  assert.throws(
    () => validateSettings({ version: 1, llm: { active: 'sk-abcdef1234567890' } }),
    (e: unknown) => {
      assert.match((e as SettingsError).issues.join('\n'), /看起来是密钥（sk-…）/);
      return true;
    },
  );
});

test('redactSettings 会把凭据样子的键/值打成 <redacted>', () => {
  const out = redactSettings({ llm: { active: 'x' }, apiKey: 'secret-value-123456', nested: { token: 'abc' } }) as Record<string, unknown>;
  assert.equal(out.apiKey, '<redacted>');
  assert.equal((out.nested as Record<string, unknown>).token, '<redacted>');
  assert.equal((out.llm as Record<string, unknown>).active, 'x', '正常字段不受影响');
});

// ═══════════════════════════════════════════════════════════════════════
// 4. ★ concurrency 钳制：传 8 仍为 1，且**如实回显 ignored[]**
// ═══════════════════════════════════════════════════════════════════════

test('★ concurrency: 8 → 实际 1，ignored[] 里如实说明（不是静默忽略）', () => {
  const r = validateSettings({ version: 1, llm: { active: 'x', concurrency: 8 } });
  assert.equal(r.settings.llm.concurrency, 1, '传 8 必须是 1');
  assert.equal(r.ignored.length, 1);
  assert.deepEqual(r.ignored[0], {
    path: 'llm.concurrency',
    requested: 8,
    applied: 1,
    reason: '用户硬要求：LLM 并发恒为 1（配置无法调高）',
  });
  assert.match(r.warnings[0] ?? '', /请求 8 → 实际 1/);
});

test('★ HARD_LLM_CONCURRENCY 就是 1，且没有任何配置能把 llm.concurrency 调高', () => {
  assert.equal(HARD_LLM_CONCURRENCY, 1);
  // 穷举"想调高"的写法（都是 JSON 能表达的）→ 一律只能是 1
  for (const want of [2, 3, 4, 8, 64, 1.5, 1e9]) {
    const r = validateSettings({ version: 1, llm: { active: 'x', concurrency: want } });
    assert.equal(r.settings.llm.concurrency, 1, `concurrency=${String(want)} 必须是 1`);
    assert.ok(r.ignored.length >= 1, `concurrency=${String(want)} 必须有 ignored 说明`);
    assert.equal(r.ignored[0]?.requested, want, 'ignored 要如实回显"你请求的是多少"');
  }
  // 传 1 不算钳制（不该报 ignored）
  const okOne = validateSettings({ version: 1, llm: { active: 'x', concurrency: 1 } });
  assert.equal(okOne.settings.llm.concurrency, 1);
  assert.equal(okOne.ignored.length, 0);
  // 传 0 → 抬回 1 并说明
  const zero = validateSettings({ version: 1, llm: { active: 'x', concurrency: 0 } });
  assert.equal(zero.settings.llm.concurrency, 1);
  assert.match(zero.ignored[0]?.reason ?? '', /并发至少为 1/);
});

test('非有限数（NaN/Infinity）被**拒绝**（JSON 表达不了，属防御性检查）', () => {
  // 注：JSON 里写不出 NaN/Infinity —— 这条防的是"JS 调用方直接传对象"的路径
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => validateSettings({ version: 1, llm: { active: 'x', concurrency: bad } }),
      (e: unknown) => {
        assert.match((e as SettingsError).issues.join('\n'), /\$\.llm\.concurrency: 应为有限数字/);
        return true;
      },
      `concurrency=${String(bad)} 应被拒`,
    );
  }
});

test('学生配额也不许超过全局并发 1（clamp 并回显）', () => {
  const r = validateSettings({ version: 1, llm: { active: 'x' }, quota: { student: { concurrentLlmTasks: 8 } } });
  assert.equal(r.settings.quota.student.concurrentLlmTasks, 1);
  assert.equal(r.ignored[0]?.path, 'quota.student.concurrentLlmTasks');
  assert.equal(r.ignored[0]?.requested, 8);
});

// ═══════════════════════════════════════════════════════════════════════
// 5. 建议性告警（能启动但会静默产坏数据的配置）
// ═══════════════════════════════════════════════════════════════════════

test('maxTokens 过小 → warning 说明推理 token 会吃掉预算（§0 实测教训）', () => {
  const r = validateSettings({ version: 1, llm: { active: 'x', maxTokens: 20 } });
  assert.equal(r.settings.llm.maxTokens, 20, '不拒绝，只是吵一声');
  const w = r.warnings.join('\n');
  assert.match(w, /maxTokens: 20 偏小/);
  assert.match(w, /54 个 reasoning token/);
  assert.match(w, /静默拿到空 content/);
});

test('jsonSchemaStrict: false → warning 指出会退化成 json_object（坑 4）', () => {
  const r = validateSettings({ version: 1, llm: { active: 'x', structured: { jsonSchemaStrict: false } } });
  assert.equal(r.settings.llm.structured.jsonSchemaStrict, false);
  assert.match(r.warnings.join('\n'), /json_object 模式 —— 它\*\*不强制 enum\/字段\*\*/);
});

// ═══════════════════════════════════════════════════════════════════════
// 6. ★ 热重载（真文件、真 watch）
// ═══════════════════════════════════════════════════════════════════════

test('★ 热重载：改文件 → **不重启**即生效（真 fs.watch）', async () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  writeJson(f, { version: 1, llm: { active: 'model-a' } });
  const store = new SettingsStore({ root: d, file: f, debounceMs: 30 });
  try {
    assert.equal(store.get().llm.active, 'model-a');
    assert.equal(store.view().revision, 0);

    const started = store.startWatching();
    assert.equal(started, true, '应能挂上监听');
    assert.equal(store.view().watching, true);

    // 改文件（模拟运维编辑）
    writeJson(f, { version: 1, llm: { active: 'model-b', temperature: 0.5 } });
    const ok = await waitFor(() => store.get().llm.active === 'model-b');
    assert.equal(ok, true, `热重载未生效，仍是 ${store.get().llm.active}`);
    assert.equal(store.get().llm.temperature, 0.5);
    assert.equal(store.view().revision, 1, 'revision 应自增');
    assert.equal(store.view().source, 'file');
    assert.equal(store.view().lastReloadError, null);
  } finally {
    store.close();
  }
});

test('★ 热重载：**非法**配置 → 旧配置继续生效 + lastReloadError 有原因（服务不崩）', async () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  writeJson(f, { version: 1, llm: { active: 'good-model' } });
  const store = new SettingsStore({ root: d, file: f, debounceMs: 30 });
  try {
    store.startWatching();
    assert.equal(store.get().llm.active, 'good-model');

    // 写一个非法值
    writeJson(f, { version: 1, llm: { active: 'good-model', maxTokens: -5 } });
    const flagged = await waitFor(() => store.view().lastReloadError !== null);
    assert.equal(flagged, true, '应记录 lastReloadError');
    assert.match(store.view().lastReloadError ?? '', /\$\.llm\.maxTokens: 不能小于 1/);
    // ★ 关键：旧配置仍然生效（没被清成默认值，也没崩）
    assert.equal(store.get().llm.active, 'good-model');
    assert.equal(store.get().llm.maxTokens, 16_384);
    assert.ok(store.view().lastReloadErrorAt !== null);

    // 修好之后应自动恢复
    writeJson(f, { version: 1, llm: { active: 'fixed-model' } });
    const recovered = await waitFor(() => store.get().llm.active === 'fixed-model');
    assert.equal(recovered, true, '修好后应恢复热重载');
    assert.equal(store.view().lastReloadError, null, '恢复后应清掉错误');
  } finally {
    store.close();
  }
});

test('热重载：文件被删 → 回到默认并如实标 default', async () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  writeJson(f, { version: 1, llm: { active: 'will-be-deleted' } });
  const store = new SettingsStore({ root: d, file: f, debounceMs: 30 });
  try {
    store.startWatching();
    assert.equal(store.view().source, 'file');
    fs.rmSync(f);
    const back = await waitFor(() => store.view().source === 'default');
    assert.equal(back, true, '删文件后应回到 default');
    assert.equal(store.get().llm.active, 'deepseek-v4.1-flash');
    assert.equal(store.view().mtimeMs, 0);
  } finally {
    store.close();
  }
});

test('hotReload.watch=false → startWatching() 返回 false（如实上报热重载不可用）', () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  writeJson(f, { version: 1, llm: { active: 'x' }, hotReload: { watch: false } });
  const store = new SettingsStore({ root: d, file: f });
  try {
    assert.equal(store.startWatching(), false);
    assert.equal(store.view().watching, false, '没有假装热重载可用');
  } finally {
    store.close();
  }
});

test('★ watch=false 时**不许留后台定时器**（改文件不会被悄悄捡起来）', async () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  writeJson(f, { version: 1, llm: { active: 'frozen-a' }, hotReload: { watch: false } });
  // pollMs 给 20ms：若真起了轮询，200ms 内必然发现改动
  const store = new SettingsStore({ root: d, file: f, pollMs: 20, debounceMs: 20 });
  try {
    assert.equal(store.startWatching(), false);
    writeJson(f, { version: 1, llm: { active: 'frozen-b' } });
    await sleep(220);
    assert.equal(store.get().llm.active, 'frozen-a', 'watch=false 就该完全不动（没有后台定时器）');
    assert.equal(store.view().revision, 0);
  } finally {
    store.close();
  }
});

test('close() 之后不再有定时器/监听（热重载彻底停止）', async () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  writeJson(f, { version: 1, llm: { active: 'closed-a' } });
  const store = new SettingsStore({ root: d, file: f, pollMs: 20, debounceMs: 20 });
  store.startWatching();
  assert.equal(store.view().watching, true);
  store.close();
  assert.equal(store.view().watching, false);
  writeJson(f, { version: 1, llm: { active: 'closed-b' } });
  await sleep(150);
  assert.equal(store.get().llm.active, 'closed-a', 'close() 之后不该再被热重载');
});

test('订阅者收到变更通知（PUT 与热重载同一路径）', async () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  writeJson(f, { version: 1, llm: { active: 'a' } });
  const store = new SettingsStore({ root: d, file: f, debounceMs: 30, pollMs: 40 });
  const seen: string[] = [];
  const off = store.subscribe((v) => seen.push(v.settings.llm.active));
  try {
    store.startWatching();
    // `fs.watch` 的句柄是**异步**挂上的：紧跟 startWatching() 就写文件可能整个丢事件。
    // 这里等一小会儿（同时也让兜底轮询有机会先跑一次），避免测试自身的不确定性。
    await sleep(60);
    writeJson(f, { version: 1, llm: { active: 'b' } });
    assert.equal(await waitFor(() => seen.includes('b')), true, `未收到热重载通知，seen=${JSON.stringify(seen)}`);
    store.apply({ ...store.get(), llm: { ...store.get().llm, active: 'c' } }, { persist: false });
    assert.deepEqual(seen, ['b', 'c']);
    off();
    store.apply({ ...store.get(), llm: { ...store.get().llm, active: 'd' } }, { persist: false });
    assert.deepEqual(seen, ['b', 'c'], '退订后不再收到');
  } finally {
    store.close();
  }
});

test('★ 兜底轮询：即使完全不挂 fs.watch，改文件也能生效（WSL /mnt、网络盘场景）', async () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  writeJson(f, { version: 1, llm: { active: 'poll-a' } });
  // fsWatch:false = 一个 fs.watch 事件都不会有，只有轮询（完全模拟 inotify 失效）
  const store = new SettingsStore({ root: d, file: f, pollMs: 30, fsWatch: false });
  try {
    assert.equal(store.startWatching(), true, '仅轮询也算"热重载可用"（如实降级）');
    assert.equal(store.view().watching, true);
    writeJson(f, { version: 1, llm: { active: 'poll-b' } });
    const ok = await waitFor(() => store.get().llm.active === 'poll-b', 2000);
    assert.equal(ok, true, `仅靠轮询也应热重载成功，实际仍是 ${store.get().llm.active}`);
    assert.equal(store.view().revision, 1);
  } finally {
    store.close();
  }
});

test('reload() 幂等：内容没变时不 +revision、不通知（避免 watcher+轮询双触发跳号）', () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  writeJson(f, { version: 1, llm: { active: 'same' } });
  const store = new SettingsStore({ root: d, file: f });
  const seen: number[] = [];
  store.subscribe((v) => seen.push(v.revision));
  try {
    const r0 = store.view().revision;
    store.reload();
    store.reload();
    assert.equal(store.view().revision, r0, '内容未变不应 +revision');
    assert.deepEqual(seen, [], '内容未变不应通知订阅者');
  } finally {
    store.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 7. 原子写盘 + 权限
// ═══════════════════════════════════════════════════════════════════════

test('writeSettingsFile 写出的文件可被重新解析，且带 $schema 提示', () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  const s: Settings = defaultSettings();
  s.llm.active = 'round-trip-model';
  writeSettingsFile(f, s);
  const text = fs.readFileSync(f, 'utf8');
  assert.match(text, /"\$schema": "\.\/settings\.schema\.json"/);
  const back = loadSettings({ root: d, file: f });
  assert.equal(back.source, 'file');
  assert.equal(back.settings.llm.active, 'round-trip-model');
  assert.deepEqual(back.settings, s, '写→读 应完全一致');
  // 不留临时文件
  assert.deepEqual(fs.readdirSync(d).sort(), ['settings.json']);
});

test('store.apply(persist:true) 真落盘（不是只改内存）', () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  writeJson(f, { version: 1, llm: { active: 'mem-only' } });
  const store = new SettingsStore({ root: d, file: f });
  try {
    const next: Settings = { ...store.get(), llm: { ...store.get().llm, active: 'persisted' } };
    store.apply(next, { persist: true });
    const onDisk = JSON.parse(fs.readFileSync(f, 'utf8')) as { llm: { active: string } };
    assert.equal(onDisk.llm.active, 'persisted');
    assert.equal(store.view().source, 'file');
  } finally {
    store.close();
  }
});

test('sandboxLimitsOf() 给出平铺视图（供 routes/sandbox.ts 直接消费）', () => {
  const s = defaultSettings();
  s.sandbox.limits = { maxRows: 50, timeoutMs: 1500, maxDbBytes: 4096 };
  assert.deepEqual(sandboxLimitsOf(s), {
    enabled: true,
    engine: 'sqlite',
    maxRows: 50,
    timeoutMs: 1500,
    maxDbBytes: 4096,
    allowWrites: true,
    resetPolicy: 'per_session',
  });
});

test('真实仓库的 config/settings.json 能通过校验（防止我自己的示例文件非法）', () => {
  const root = path.resolve(import.meta.dirname, '..', '..', '..');
  const r = loadSettings({ root });
  assert.equal(r.source, 'file', `仓库里应有合法的 config/settings.json（实际 source=${r.source}）`);
  assert.equal(r.settings.llm.active, 'deepseek-v4.1-flash');
  assert.equal(r.settings.llm.concurrency, 1);
  assert.equal(r.settings.sandbox.engine, 'sqlite');
  assert.equal(r.ignored.length, 0, '仓库文件不该触发任何钳制');
  assert.deepEqual(r.warnings, [], `仓库文件不该有告警，实际：${JSON.stringify(r.warnings)}`);
});
