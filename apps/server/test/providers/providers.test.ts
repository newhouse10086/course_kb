/**
 * Provider 层测试 —— 覆盖三条铁律 + 降级链 + 能力过滤 + 领域翻译规则
 *
 * 运行：`node --test test/providers/`
 *
 * ## 为什么这些测试重要
 *  Provider 层的**核心风险不是"调不通"，而是"调不通却假装成功"**。
 *  所以每个测试都在验证**失败时是否如实**，而不只是成功路径。
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ProviderRegistry } from '../../src/providers/registry.ts';
import { ProviderError } from '../../src/providers/types.ts';
import type { HealthResult, Provider, ProviderInfo, ProviderKind } from '../../src/providers/types.ts';
import { OpenAiCompatibleLlm, LLM_QUEUE, redact } from '../../src/providers/llm/openai_compatible.ts';
import { splitForTts, estimateDurationMs, TtsCache } from '../../src/providers/tts/index.ts';
import { shouldKeepAsIs, renderGlossary, DEFAULT_DB_GLOSSARY } from '../../src/providers/translate/index.ts';
import { normalizeSegments } from '../../src/providers/asr/index.ts';

// ─────────────────────────────────────────────────────────────
// 测试替身：可控的假 provider
// ─────────────────────────────────────────────────────────────

class FakeProvider implements Provider {
  info: ProviderInfo;
  private readonly health: HealthResult;
  private readonly behavior: () => Promise<unknown>;
  healthCalls = 0;

  constructor(o: {
    id: string;
    kind: ProviderKind;
    runtime?: 'local' | 'cloud';
    configured?: boolean;
    reason?: string;
    health?: HealthResult;
    capabilities?: Record<string, unknown>;
    price?: number;
    behavior?: () => Promise<unknown>;
  }) {
    this.info = {
      id: o.id,
      kind: o.kind,
      label: o.id,
      vendor: o.runtime === 'local' ? '本地' : '云',
      runtime: o.runtime ?? 'cloud',
      configured: o.configured ?? true,
      available: false,
      reason: o.reason,
      capabilities: o.capabilities ?? {},
      pricing: o.price !== undefined ? { unit: 'call', amount: o.price, currency: 'CNY' } : undefined,
    };
    this.health = o.health ?? { ok: true };
    this.behavior = o.behavior ?? (async () => ({ ok: true }));
  }

  async healthCheck(): Promise<HealthResult> {
    this.healthCalls++;
    return this.health;
  }

  async call(): Promise<unknown> {
    return this.behavior();
  }
}

const K = 'asr' as const;

// ─────────────────────────────────────────────────────────────
// 铁律 R1：configured 与 available 必须分开
// ─────────────────────────────────────────────────────────────

describe('R1 configured 与 available 分开报', () => {
  test('有凭据但真探测失败 → configured=true, available=false + 可读 reason', async () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeProvider({
      id: 'cloud-x', kind: K,
      configured: true,
      health: { ok: false, reason: 'HTTP 402: 配额耗尽' },
    }));

    const caps = await reg.capabilities({ deep: true });
    const p = caps.providers[K]![0]!;

    assert.equal(p.configured, true, '有凭据 → configured 必须为 true（不能因为探测失败就报未配置）');
    assert.equal(p.available, false, '探测失败 → available 必须为 false');
    assert.equal(p.reason, 'HTTP 402: 配额耗尽', 'reason 必须是探测给出的真实原因');
  });

  test('缺凭据 → 不探测（省时间），configured=false 且 reason 指出缺哪个变量', async () => {
    const reg = new ProviderRegistry();
    const fp = new FakeProvider({
      id: 'cloud-y', kind: K,
      configured: false,
      reason: '缺少环境变量 ALIYUN_AK / ALIYUN_SK（在 course-kb/.env 配置）',
    });
    reg.register(fp);

    const caps = await reg.capabilities({ deep: true });
    const p = caps.providers[K]![0]!;

    assert.equal(p.configured, false);
    assert.equal(p.available, false);
    assert.match(p.reason!, /ALIYUN_AK/);
    assert.equal(fp.healthCalls, 0, '未配置时不应发起网络探测');
  });

  test('deep=false 且未探测过 → available=false，reason 说明"尚未探测"（不给假绿）', async () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeProvider({ id: 'p1', kind: K }));
    const caps = await reg.capabilities({ deep: false });
    const p = caps.providers[K]![0]!;
    assert.equal(p.available, false, '未探测不能报 available=true');
    assert.match(p.reason!, /尚未探测/);
  });
});

// ─────────────────────────────────────────────────────────────
// 铁律 R2 + 降级链
// ─────────────────────────────────────────────────────────────

describe('降级链', () => {
  test('第一跳探测失败 → 自动降级第二跳，并上报 degraded_from + reason', async () => {
    const reg = new ProviderRegistry({ policy: { asr: 'local-first' } });
    reg.register(new FakeProvider({
      id: 'local-bad', kind: K, runtime: 'local',
      health: { ok: false, reason: '本地模型加载失败' },
    }));
    reg.register(new FakeProvider({
      id: 'cloud-good', kind: K, runtime: 'cloud',
      behavior: async () => ({ text: '来自云端' }),
    }));

    const r = await reg.run<{ text: string }>(K, {}, async (p) => (p as unknown as FakeProvider).call() as Promise<{ text: string }>);

    assert.equal(r.usedProvider, 'cloud-good', '应降级到云端');
    assert.equal(r.degradedFrom, 'local-bad', '必须上报从谁降级');
    assert.match(r.degradedReason!, /本地模型加载失败/, '必须上报降级原因');
    assert.equal(r.attempts.length, 1, '记录失败的那一跳');
    assert.equal(r.attempts[0]!.id, 'local-bad');
  });

  test('降级链**每一跳都真探测**（不能只看配置就给假绿）', async () => {
    const reg = new ProviderRegistry();
    const a = new FakeProvider({ id: 'a', kind: K, runtime: 'local' });
    const b = new FakeProvider({ id: 'b', kind: K, runtime: 'cloud' });
    reg.register(a);
    reg.register(b);
    // 两者都"已配置"，但都没探测过 → 必须真的探测
    await reg.run(K, {}, async (p) => (p as unknown as FakeProvider).call());
    assert.equal(a.healthCalls + b.healthCalls > 0, true, '至少探测了链上的 provider');
  });

  test('策略 local-first 优先本地；cloud-first 反过来', () => {
    const mk = () => {
      const reg = new ProviderRegistry();
      reg.register(new FakeProvider({ id: 'L', kind: K, runtime: 'local' }));
      reg.register(new FakeProvider({ id: 'C', kind: K, runtime: 'cloud' }));
      return reg;
    };
    assert.deepEqual(mk().chain(K, { policy: 'local-first' }).map((p) => p.info.id), ['L', 'C']);
    assert.deepEqual(mk().chain(K, { policy: 'cloud-first' }).map((p) => p.info.id), ['C', 'L']);
  });

  test('策略 cost 按价格升序', () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeProvider({ id: 'exp', kind: K, price: 10 }));
    reg.register(new FakeProvider({ id: 'cheap', kind: K, price: 0.1 }));
    reg.register(new FakeProvider({ id: 'free', kind: K, runtime: 'local', price: 0 }));
    assert.deepEqual(
      reg.chain(K, { policy: 'cost' }).map((p) => p.info.id),
      ['free', 'cheap', 'exp'],
    );
  });

  test('explicit 策略要求显式指定 id；找不到就抛错（不静默选别的）', () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeProvider({ id: 'x', kind: K }));
    assert.equal(reg.chain(K, { policy: 'explicit', explicitId: 'x' }).length, 1);
    assert.throws(
      () => reg.chain(K, { policy: 'explicit', explicitId: 'nope' }),
      (e: unknown) => e instanceof ProviderError && e.code === 'E_NO_PROVIDER',
    );
    assert.throws(
      () => reg.chain(K, { policy: 'explicit' }),
      (e: unknown) => e instanceof ProviderError,
    );
  });
});

// ─────────────────────────────────────────────────────────────
// 铁律 R3：全链失败必须抛错，绝不返回假数据
// ─────────────────────────────────────────────────────────────

describe('R3 全链失败如实报错', () => {
  test('全部失败 → 抛 ProviderError（不返回空结果冒充成功）', async () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeProvider({ id: 'a', kind: K, health: { ok: false, reason: '挂了' } }));
    reg.register(new FakeProvider({
      id: 'b', kind: K,
      behavior: async () => { throw new Error('调用炸了'); },
    }));

    await assert.rejects(
      () => reg.run(K, {}, async (p) => (p as unknown as FakeProvider).call()),
      (e: unknown) => {
        assert.ok(e instanceof ProviderError, '必须是 ProviderError');
        assert.equal(e.code, 'E_UNAVAILABLE');
        assert.match(e.message, /a → 挂了/);
        assert.match(e.message, /b → 调用失败：调用炸了/);
        assert.ok(e.hint && e.hint.length > 0, '必须给可读 hint');
        return true;
      },
    );
  });

  test('全链都是"未配置" → 错误码是 E_NOT_CONFIGURED（不是 E_UNAVAILABLE）', async () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeProvider({ id: 'a', kind: K, configured: false, reason: '缺 KEY' }));
    await assert.rejects(
      () => reg.run(K, {}, async (p) => (p as unknown as FakeProvider).call()),
      (e: unknown) => e instanceof ProviderError && e.code === 'E_NOT_CONFIGURED',
    );
  });

  test('该 kind 没有任何 provider → E_NO_PROVIDER + 指引去配置', async () => {
    const reg = new ProviderRegistry();
    await assert.rejects(
      () => reg.run(K, {}, async (p) => (p as unknown as FakeProvider).call()),
      (e: unknown) => {
        assert.ok(e instanceof ProviderError);
        assert.equal(e.code, 'E_NO_PROVIDER');
        assert.match(e.hint!, /providers\.yaml/);
        return true;
      },
    );
  });

  test('调用失败后该 provider 的探测缓存被清空（下次重新探测）', async () => {
    const reg = new ProviderRegistry();
    const bad = new FakeProvider({ id: 'flaky', kind: K, health: { ok: true } });
    const good = new FakeProvider({ id: 'ok', kind: K, behavior: async () => ({ ok: 1 }) });
    reg.register(bad);
    reg.register(good);
    // 让 flaky 的 healthCheck 成功但调用失败
    (bad as unknown as { behavior: () => Promise<unknown> }).behavior = async () => { throw new Error('x'); };

    await reg.run(K, {}, async (p) => (p as unknown as FakeProvider).call());
    const afterFirst = bad.healthCalls;
    assert.equal(afterFirst, 1, '第一次 run 应探测一次');

    // 再跑一次：flaky 上次调用失败 → 缓存已失效 → **必须重新探测**
    // （否则它会一直被跳过，或带着过期的"可用"状态）
    await reg.run(K, {}, async (p) => (p as unknown as FakeProvider).call());
    assert.equal(bad.healthCalls, afterFirst + 1, '调用失败后应重新探测，而不是复用旧结果');
  });
});

// ─────────────────────────────────────────────────────────────
// 能力过滤：降级不能产出**残缺数据**
// ─────────────────────────────────────────────────────────────

describe('能力过滤（降级时不能只看"连得上"）', () => {
  test('requireWordTimestamps=true 时，只支持段级时间戳的 provider 被跳过', async () => {
    const reg = new ProviderRegistry({ policy: { asr: 'cloud-first' } });
    const noWords = new FakeProvider({
      id: 'openai-asr', kind: K, runtime: 'cloud',
      capabilities: { wordTimestamps: false },
      behavior: async () => ({ segments: [{ text: '段级' }] }),
    });
    const withWords = new FakeProvider({
      id: 'local-fw', kind: K, runtime: 'local',
      capabilities: { wordTimestamps: true },
      behavior: async () => ({ segments: [{ text: '字级' }] }),
    });
    reg.register(noWords);
    reg.register(withWords);

    const r = await reg.run<{ segments: { text: string }[] }>(
      K,
      { require: { wordTimestamps: true } },
      async (p) => (p as unknown as FakeProvider).call() as Promise<{ segments: { text: string }[] }>,
    );

    assert.equal(r.usedProvider, 'local-fw', '必须跳过不支持字级时间戳的 provider');
    assert.equal(r.degradedFrom, 'openai-asr');
    assert.match(r.attempts[0]!.reason, /能力不足/, '跳过原因要说明是能力不足，不是"连不上"');
    assert.equal(noWords.healthCalls, 0, '能力不满足时不必探测（省时间）');
  });

  test('require 未指定时，不做能力过滤', async () => {
    const reg = new ProviderRegistry({ policy: { asr: 'cloud-first' } });
    reg.register(new FakeProvider({
      id: 'c', kind: K, runtime: 'cloud',
      capabilities: { wordTimestamps: false },
      behavior: async () => ({ ok: 1 }),
    }));
    const r = await reg.run(K, {}, async (p) => (p as unknown as FakeProvider).call());
    assert.equal(r.usedProvider, 'c');
  });

  test('所有 provider 都能力不足 → hint 明确说"不满足能力要求"（不是"全部失败"）', async () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeProvider({ id: 'a', kind: K, capabilities: { wordTimestamps: false } }));
    await assert.rejects(
      () => reg.run(K, { require: { wordTimestamps: true } }, async (p) => (p as unknown as FakeProvider).call()),
      (e: unknown) => {
        assert.ok(e instanceof ProviderError);
        assert.match(e.hint!, /能力要求/);
        return true;
      },
    );
  });
});

// ─────────────────────────────────────────────────────────────
// LLM：并发 = 1 与 结构化输出约束
// ─────────────────────────────────────────────────────────────

describe('LLM provider', () => {
  test('★ 并发 = 1：队列串行执行（不是并行）', async () => {
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;

    const mk = (id: string, delay: number) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      const start = Date.now();
      await new Promise((r) => setTimeout(r, delay));
      order.push(`${id}:${start}`);
      running--;
    };

    const t0 = LLM_QUEUE.run(mk('a', 40));
    const t1 = LLM_QUEUE.run(mk('b', 10));
    const t2 = LLM_QUEUE.run(mk('c', 10));
    await Promise.all([t0, t1, t2]);

    assert.equal(maxRunning, 1, `并发必须为 1，实测最大并发 ${maxRunning}`);
    assert.equal(order.length, 3);
  });

  test('凭据不全时 configured=false（不发起请求）', async () => {
    const llm = new OpenAiCompatibleLlm({ baseUrl: '', apiKey: '', model: 'x' });
    assert.equal(llm.info.configured, false);
    await assert.rejects(
      () => llm.completeJson({ messages: [], schema: { name: 's', schema: {} } }),
      (e: unknown) => e instanceof ProviderError && e.code === 'E_NOT_CONFIGURED',
    );
  });

  /**
   * ★★ **能力上报不许无条件乐观**（坑 10「能力不可用假装可用」+ 坑 24「声明 ≠ 生效」）。
   *
   * ## 原测试为什么被改（**原断言本身编码了缺陷**）
   * 原实现无条件写 `structuredOutput: true` / `jsonSchemaStrict: true`，本测试就断言这两个 `true`。
   * 但**实测该端点**（同一端点、时间相邻的 3 次调用）：
   * ```
   * 裸 schema + strict:true            → 200（**strict 被忽略**）
   * 真 strict schema（required + …）   → **400** `This response_format type is unavailable now`
   * ```
   * ⟹ 无条件 `true` 是**假绿的能力声明** —— 任何依赖它的代码都会以为"结构化输出有保证"。
   * 现在：初始值 = **false（未验证）** + 可读 `structuredOutputReason`；
   * **真实调用结果**写回（strict 成功 → true；被拒回落 → false + 端点原始文案）—— 同源（坑 21）。
   *
   * ★ 坑 4 的**真正判据**（"必须用 `json_schema` + `strict:true`，不许退回 `json_object`"）
   * 断言在**真实请求体**上 —— 见 `test/providers_llm_structured_fallback.test.ts`
   * （它断言第 1 次请求带严格 schema、第 2 次回落裸 schema，且 `strict:true` 始终在）。
   */
  test('★ capabilities **不无条件**声称支持严格结构化输出（未验证 → false + 可读 reason）', () => {
    const llm = new OpenAiCompatibleLlm({
      baseUrl: 'https://example.com/v1', apiKey: 'sk-test1234567890', model: 'm',
    });
    assert.equal(
      llm.info.capabilities.structuredOutput,
      false,
      '★ 未验证不许声称 true（原实现无条件 true = 坑 10：能力不可用假装可用）',
    );
    assert.equal(llm.info.capabilities.jsonSchemaStrict, false, '★ 同上');
    assert.match(
      String(llm.info.capabilities.structuredOutputReason),
      /尚未验证/,
      '★ 必须给出可读的未验证原因（前端/运维据此理解"为什么不是 true"）',
    );
    assert.equal(llm.info.limits?.concurrency, 1, 'limits 必须声明并发=1');
  });

  test('★ 脱敏：402/403 等错误信息里不得回显 key', () => {
    const key = 'sk-fake-for-redaction-test-000000';
    const upstream = `{"error":"invalid key ${key} please check"}`;
    const safe = redact(upstream, [key]);
    assert.equal(safe.includes(key), false, '凭据绝不能出现在日志/错误信息里');
    assert.match(safe, /\*\*\*/);

    // 兜底：即使没传 secrets，也要能识别 sk- 形态
    assert.equal(redact(`key=sk-abcdef123456`, []).includes('sk-abcdef123456'), false);
  });
});

// ─────────────────────────────────────────────────────────────
// TTS：分段不能切在词中间
// ─────────────────────────────────────────────────────────────

describe('TTS 文本分段', () => {
  test('★ 按句子边界切，不切在词中间', () => {
    const text = '第一句话。第二句话！第三句话？第四句话，还没有结束，继续下去。';
    const chunks = splitForTts(text, 12);
    assert.ok(chunks.length > 1, '应切成多段');
    for (const c of chunks) {
      assert.ok(c.length <= 12, `每段必须 ≤12 字，实际 ${c.length}`);
    }
    // 重新拼接应还原（允许去空白）
    assert.equal(chunks.join(''), text.replace(/\s/g, ''));
    // 每段都应以**边界标点**结尾（除最后一段）
    // ⚠️ 不只认句末标点：超长句会在次级标点（，、：；）处切 —— 那是**更好的**切点，
    //    比在字中间硬切强（这条是测试抓出来的：初版只找空格，切出了半句）
    for (let i = 0; i < chunks.length - 1; i++) {
      assert.match(chunks[i]!,
        /[。！？；，、：,.!?;]$/,
        `第 ${i} 段应在边界标点处切开，实际：${chunks[i]}`,
      );
    }
    // 强化：切点必须落在**标点处**，而不是字中间。
    // 判据：每段的最后一个字符是边界标点（最后一段除外）。
    // （不对段数做硬编码断言 —— 段数取决于标点分布，不是契约）
    assert.ok(chunks.length >= 3, `应切成多段，实际 ${chunks.length}`);
  });

  test('短文本不切', () => {
    assert.deepEqual(splitForTts('短句。', 100), ['短句。']);
  });

  test('空文本返回空数组', () => {
    assert.deepEqual(splitForTts('   ', 100), []);
  });

  test('超长单句（无标点）退化为硬切但仍是 ≤ maxChars', () => {
    const long = 'a'.repeat(250);
    const chunks = splitForTts(long, 100);
    assert.ok(chunks.length >= 3);
    for (const c of chunks) assert.ok(c.length <= 100);
    assert.equal(chunks.join(''), long);
  });

  test('缓存：同文本+音色命中，不重复合成', () => {
    const cache = new TtsCache(2);
    const k = TtsCache.key('你好', 'v1', 0, 0, 'mp3');
    assert.equal(cache.get(k), undefined);
    cache.set(k, { filePath: '/a.mp3', format: 'mp3', usedProvider: 'x' });
    assert.equal(cache.get(k)?.filePath, '/a.mp3');
    assert.equal(cache.size, 1);
  });

  test('时长估算：中文约 4 字/秒', () => {
    const ms = estimateDurationMs('这是一段二十个字的中文测试文本内容');
    assert.ok(ms > 4000 && ms < 8000, `20 字应约 5s，实际 ${ms}ms`);
  });
});

// ─────────────────────────────────────────────────────────────
// 翻译：领域规则（本项目特色）
// ─────────────────────────────────────────────────────────────

describe('翻译领域规则', () => {
  test('★ 标识符保留英文（译了就无法检索）', () => {
    for (const id of ['sql_mode', 'InnoDB', 'SELECT', 'log_filter_dragnet', 'crc32', 'utf8mb4_general_ci', 'MY-ISAM']) {
      assert.equal(shouldKeepAsIs(id), true, `${id} 应保留英文`);
    }
  });

  test('★★ 回归：以 `.` 结尾的英文句子**必须被翻译**（句末句号不是标识符）', () => {
    // 这个 bug 由 wiki-architect 实测发现：原实现把 `.` 放进标识符字符类，
    // 导致**所有以句号结尾的英文句子**都被判为"标识符" → 证据句一条都不送译
    // → 翻译任务"成功但什么都没做"（**静默空转**）。
    // 本项目证据句几乎全部以 `.` 结尾，所以这等于**证据翻译功能没实现**。
    for (const s of [
      'Clustered indexes sort rows by key.',
      'InnoDB provides MVCC.',
      'A transaction is a unit of work.',
    ]) {
      assert.equal(shouldKeepAsIs(s), false, `句末句号 ≠ 标识符，整句应翻译：${s}`);
    }
    // 对照组：限定名里的点**必须**仍算标识符（别把修复改过头）
    for (const q of ['db.table', 'information_schema.tables', 'mysql.user']) {
      assert.equal(shouldKeepAsIs(q), true, `限定名应保留英文：${q}`);
    }
  });

  test('★ 证据句含标识符时整体保留（不意译）', () => {
    assert.equal(shouldKeepAsIs('InnoDB uses a B-tree data structure'), false,
      '整句英文应可翻译（句中的标识符由提示词规则保护）');
    assert.equal(shouldKeepAsIs('SELECT * FROM t'), true, 'SQL 开头 → 保留');
  });

  test('已有中文 → 不重复翻译', () => {
    assert.equal(shouldKeepAsIs('聚簇索引'), true);
  });

  test('普通英文词 → 需要翻译', () => {
    for (const w of ['clustered index', 'data warehouse', 'transaction']) {
      assert.equal(shouldKeepAsIs(w), false, `${w} 应翻译`);
    }
  });

  test('白名单生效（大小写不敏感）', () => {
    assert.equal(shouldKeepAsIs('BufferPool', ['bufferpool']), true);
  });

  test('★ 术语表渲染：必须包含领域对照（否则 index→"指标"）', () => {
    const s = renderGlossary({ index: '索引', view: '视图' });
    assert.match(s, /index → 索引/);
    assert.match(s, /view → 视图/);
    assert.match(s, /必须严格遵守/);
  });

  test('术语表为空时给出提示（不静默）', () => {
    const s = renderGlossary(undefined);
    assert.match(s, /无术语表/);
  });

  test('内置数据库术语表覆盖核心概念', () => {
    const must = ['index', 'view', 'transaction', 'data warehouse', 'fact table'];
    for (const k of must) {
      assert.ok(DEFAULT_DB_GLOSSARY[k], `内置术语表应含 ${k}`);
    }
    assert.equal(DEFAULT_DB_GLOSSARY['index'], '索引');
  });
});

// ─────────────────────────────────────────────────────────────
// ASR：结构归一化
// ─────────────────────────────────────────────────────────────

describe('ASR 结构归一化', () => {
  test('★ 抹平各家字段名差异（start_ms / start / begin）', () => {
    const r = normalizeSegments([
      { start_ms: 0, end_ms: 1000, text: 'a' },
      { start: 1000, end: 2000, text: 'b' },
      { begin: 2000, finish: 3000, text: 'c' },
    ]);
    assert.equal(r.length, 3);
    assert.deepEqual(r.map((x) => x.startMs), [0, 1000, 2000]);
    assert.deepEqual(r.map((x) => x.endMs), [1000, 2000, 3000]);
  });

  test('时间轴按 startMs 排序（单调递增）', () => {
    const r = normalizeSegments([
      { startMs: 2000, endMs: 3000, text: 'c' },
      { startMs: 0, endMs: 1000, text: 'a' },
    ]);
    assert.deepEqual(r.map((x) => x.startMs), [0, 2000]);
  });

  test('end < start 时纠正为 end = start（不产生负时长）', () => {
    const r = normalizeSegments([{ startMs: 5000, endMs: 1000, text: 'x' }]);
    assert.equal(r[0]!.endMs, 5000);
  });

  test('空文本段被丢弃（不产出空字幕）', () => {
    const r = normalizeSegments([
      { startMs: 0, endMs: 1, text: '  ' },
      { startMs: 1, endMs: 2, text: 'ok' },
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0]!.text, 'ok');
  });

  test('非数组输入 → 空数组（不抛）', () => {
    assert.deepEqual(normalizeSegments(null), []);
    assert.deepEqual(normalizeSegments(undefined), []);
    assert.deepEqual(normalizeSegments({}), []);
  });

  test('字级时间戳归一化', () => {
    const r = normalizeSegments([
      { startMs: 0, endMs: 1000, text: 'ab', words: [{ w: 'a', startMs: 0, endMs: 500 }, { word: 'b', start_ms: 500, end_ms: 1000 }] },
    ]);
    assert.equal(r[0]!.words?.length, 2);
    assert.equal(r[0]!.words?.[1]!.w, 'b');
  });
});
