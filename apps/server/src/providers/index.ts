/**
 * Provider 层总入口
 *
 * 规格：[`docs/PROVIDERS.md`](../../../docs/PROVIDERS.md)
 *
 * ## T-BACKEND 怎么用
 * ```ts
 * import { createProviderLayer } from './providers/index.ts';
 * import { loadProviderConfig } from './config.ts';
 *
 * const providers = createProviderLayer({
 *   config: loadProviderConfig(),
 *   runWorker: workerRunner.run,        // 你实现的 Python worker 调用器
 * });
 *
 * // /api/v1/capabilities 里加这一段
 * app.get('/api/v1/capabilities', async (req) => {
 *   const caps = await providers.capabilities({ deep: req.query.deep === '1' });
 *   return { ...others, providers: caps.providers, policy: caps.policy };
 * });
 *
 * // 转写
 * const r = await providers.transcribe({ audioPath, requireWordTimestamps: true });
 * // r.degradedFrom / r.degradedReason 会告诉你是否降级过
 * ```
 */

import type { AsrRequest, AsrResult, ProviderKind, Policy, Provider } from './types.ts';
import { ProviderError } from './types.ts';
import { ProviderRegistry, buildRegistry, type ChainResult } from './registry.ts';
import { createOpenAiCompatible } from './llm/openai_compatible.ts';
import { createAsrProvider, type WorkerRunner } from './asr/index.ts';
import { DEFAULT_DB_GLOSSARY, createTranslateProvider } from './translate/index.ts';
import { createTtsProvider } from './tts/index.ts';
import { createOcrProvider } from './ocr/index.ts';

// ─────────────────────────────────────────────────────────────
// 重导出
// ─────────────────────────────────────────────────────────────

export * from './types.ts';
export { ProviderRegistry, buildRegistry, HEALTH_TTL_MS, type ChainResult, type AttemptFailure } from './registry.ts';
export { OpenAiCompatibleLlm, LLM_QUEUE, SerialQueue, redact, createOpenAiCompatible } from './llm/openai_compatible.ts';
export {
  LocalWorkerAsr, CloudAsr, createAsrProvider, normalizeSegments, type WorkerRunner,
} from './asr/index.ts';
export {
  LlmTranslateProvider, createTranslateProvider, DEFAULT_DB_GLOSSARY,
  shouldKeepAsIs, renderGlossary,
} from './translate/index.ts';
export { CloudTts, createTtsProvider, splitForTts, TtsCache, estimateDurationMs } from './tts/index.ts';
export { CloudOcr, createOcrProvider } from './ocr/index.ts';

// ─────────────────────────────────────────────────────────────
// 工厂表
// ─────────────────────────────────────────────────────────────

export interface CreateProviderLayerOptions {
  /** 来自 `config.ts::loadProviderConfig()` */
  config: {
    policy: Partial<Record<ProviderKind, Policy>>;
    providers: Partial<Record<ProviderKind, import('./types.ts').ProviderConfigEntry[]>>;
  };
  /** Python worker 调用器（T-BACKEND 提供）。ASR 的 local_worker 依赖它 */
  runWorker: WorkerRunner;
  /** 额外/覆盖的术语表（翻译用） */
  glossary?: Record<string, string>;
  /** 未注册 type 的告警（会进日志，不抛错） */
  onSkip?: (entry: import('./types.ts').ProviderConfigEntry, reason: string) => void;
}

// ─────────────────────────────────────────────────────────────
// 便捷 facade
// ─────────────────────────────────────────────────────────────

/**
 * 对上层暴露的 Provider 门面。
 *
 * ⚠️ 所有方法在**全链失败**时抛 `ProviderError`（铁律 R3）——
 * 调用方**不得**吞掉后返回假数据。
 */
export class ProviderLayer {
  readonly registry: ProviderRegistry;
  private readonly runWorker: WorkerRunner;

  constructor(registry: ProviderRegistry, runWorker: WorkerRunner) {
    this.registry = registry;
    this.runWorker = runWorker;
  }

  // ── 能力上报 ──
  capabilities(opts: { deep?: boolean } = {}) {
    return this.registry.capabilities(opts);
  }

  /** 某个 kind 的可用 provider 数（UI 可用它决定是否禁用入口） */
  async availableCount(kind: ProviderKind, deep = false): Promise<number> {
    const c = await this.registry.capabilities({ deep, kinds: [kind] });
    return (c.providers[kind] ?? []).filter((p) => p.available).length;
  }

  /** 手动刷新探测（配置热更新 / 用户点"重试"） */
  invalidate(id?: string): void {
    this.registry.invalidate(id);
  }

  // ── ASR ──

  /**
   * 语音转文字。
   *
   * @example
   * const r = await providers.transcribe({ audioPath: '/x/a.wav', durationMs: 300_000,
   *                                       requireWordTimestamps: true });
   * if (r.degradedFrom) console.warn(`从 ${r.degradedFrom} 降级：${r.degradedReason}`);
   */
  async transcribe(
    req: AsrRequest,
    onEvent?: (e: Record<string, unknown>) => void,
  ): Promise<AsrResult & { attempts: ChainResult<AsrResult>['attempts'] }> {
    const res = await this.registry.run<AsrResult>(
      'asr',
      {
        // ★ 能力要求会成为降级链的过滤条件：
        //   requireWordTimestamps=true 时，只有段级时间戳的 provider 会被**跳过**（不产残缺数据）
        require: req.requireWordTimestamps ? { wordTimestamps: true } : undefined,
        onAttempt: (id, ok, reason) => {
          if (!ok) onEvent?.({ type: 'provider_attempt_failed', provider: id, reason });
        },
      },
      async (p) => {
        if (p instanceof Object && 'transcribe' in p && typeof (p as { transcribe?: unknown }).transcribe === 'function') {
          return (await (p as unknown as { transcribe: (r: AsrRequest, e?: unknown) => Promise<AsrResult> })
            .transcribe(req, onEvent));
        }
        throw new ProviderError('E_PROVIDER', `${p.info.id} 不支持 ASR`);
      },
    );
    return { ...res.value, attempts: res.attempts };
  }

  // ── 翻译 ──

  /**
   * 逐条翻译（**注入术语表**，标识符保留英文，证据句不意译）。
   *
   * ⚠️ 这是本项目的领域要求，见 `docs/PROVIDERS.md` §4.2。
   */
  async translate(
    req: import('./types.ts').TranslateRequest,
  ): Promise<import('./types.ts').TranslateResult> {
    const res = await this.registry.run(
      'translate',
      {},
      async (p) => {
        const t = p as unknown as { translate?: (r: typeof req) => Promise<import('./types.ts').TranslateResult> };
        if (typeof t.translate !== 'function') {
          throw new ProviderError('E_PROVIDER', `${p.info.id} 不支持翻译`);
        }
        const out = await t.translate(req);
        return { ...out, degradedFrom: undefined, degradedReason: undefined };
      },
    );
    return {
      ...res.value,
      degradedFrom: res.degradedFrom,
      degradedReason: res.degradedReason,
    };
  }

  // ── TTS ──

  async synthesize(
    req: import('./types.ts').TtsRequest,
    outDir: string,
  ): Promise<import('./types.ts').TtsResult> {
    const res = await this.registry.run(
      'tts',
      {},
      async (p) => {
        const t = p as unknown as {
          synthesizeText?: (r: typeof req, d: string) => Promise<import('./types.ts').TtsResult>;
        };
        if (typeof t.synthesizeText !== 'function') {
          throw new ProviderError('E_PROVIDER', `${p.info.id} 不支持 TTS`);
        }
        return t.synthesizeText(req, outDir);
      },
    );
    return { ...res.value, degradedFrom: res.degradedFrom, degradedReason: res.degradedReason };
  }

  // ── OCR（**此项不可用是正常的**） ──

  /**
   * 识别幻灯片帧文字。
   *
   * ⚠️ 返回 `null` 表示**没有可用 OCR** —— 这是**正常降级**，
   * 上层应改为"只出帧图 + 时间点"并标注"图片帧"，**不要报错**。
   */
  async recognize(
    req: import('./types.ts').OcrRequest,
  ): Promise<import('./types.ts').OcrResult | null> {
    try {
      const res = await this.registry.run(
        'ocr',
        {},
        async (p) => {
          const o = p as unknown as { recognize?: (r: typeof req) => Promise<import('./types.ts').OcrResult> };
          if (typeof o.recognize !== 'function') {
            throw new ProviderError('E_PROVIDER', `${p.info.id} 不支持 OCR`);
          }
          return o.recognize(req);
        },
      );
      return { ...res.value, degradedFrom: res.degradedFrom, degradedReason: res.degradedReason };
    } catch (e) {
      if (e instanceof ProviderError && (e.code === 'E_NO_PROVIDER' || e.code === 'E_NOT_CONFIGURED')) {
        return null;      // ★ OCR 不可用 = 正常降级，不抛
      }
      throw e;
    }
  }

  // ── raw LLM（给抽卡片等管线用） ──

  /**
   * 结构化输出。**并发 = 1**，**`json_schema` + `strict`**。
   */
  async completeJson<T>(
    req: import('./types.ts').LlmJsonSchemaRequest,
  ): Promise<import('./types.ts').LlmJsonSchemaResult<T>> {
    const res = await this.registry.run(
      'llm',
      {},
      async (p) => {
        const l = p as unknown as {
          completeJson?: <R>(r: typeof req) => Promise<import('./types.ts').LlmJsonSchemaResult<R>>;
        };
        if (typeof l.completeJson !== 'function') {
          throw new ProviderError('E_PROVIDER', `${p.info.id} 不支持结构化输出`);
        }
        return l.completeJson<T>(req);
      },
    );
    return {
      ...res.value,
      degradedFrom: res.degradedFrom,
      degradedReason: res.degradedReason,
    };
  }

  /** 取某个 kind 的原始 provider（高级用法，如需要 provider 特有方法） */
  raw(kind: ProviderKind, id?: string): Provider | undefined {
    if (id) return this.registry.get(kind, id);
    return this.registry.chain(kind)[0];
  }
}

// ─────────────────────────────────────────────────────────────
// 组装
// ─────────────────────────────────────────────────────────────

/**
 * 从配置组装整个 Provider 层。
 *
 * 未实现的 `type` **不会抛错**（配置里预留将来才实现的 provider 是正常的），
 * 而是走 `onSkip` 记录 —— 但 `/capabilities` 会**如实**少列它，
 * 用户不会看到"配置了却用不了"的困惑。
 */
export function createProviderLayer(opts: CreateProviderLayerOptions): ProviderLayer {
  const { config, runWorker, glossary, onSkip } = opts;

  const registry = buildRegistry({
    config,
    onSkip,
    factories: {
      // LLM
      openai_compatible: createOpenAiCompatible,
      // ASR
      local_worker: (e) => createAsrProvider(e, { runWorker }),
      aliyun_nls: (e) => createAsrProvider(e, { runWorker }),
      tencent_asr: (e) => createAsrProvider(e, { runWorker }),
      openai_asr: (e) => createAsrProvider(e, { runWorker }),
      // 翻译
      llm: (e) => createTranslateProvider(e, { glossary }),
      deepl: (e) => createTranslateProvider(e, { glossary }),
      // TTS
      aliyun_nls_tts: createTtsProvider,
      tencent_tts: createTtsProvider,
      openai_tts: createTtsProvider,
      local_sapi: createTtsProvider,
      // OCR
      baidu_ocr: createOcrProvider,
      aliyun_ocr: createOcrProvider,
      tencent_ocr: createOcrProvider,
      local_tesseract: createOcrProvider,
      local_paddle: createOcrProvider,
    },
  });

  return new ProviderLayer(registry, runWorker);
}

export { DEFAULT_DB_GLOSSARY as GLOSSARY };
