/**
 * `/api/v1/capabilities` —— **诚实接口**（契约 §5.1 + PROVIDERS §7）。
 *
 * 铁律落地（PROVIDERS §0）：
 * - **R1** `configured`（凭据齐备）与 `available`（**真探测**通过）**分开报**
 * - **R3** 不可用必须给**人能看懂**的 `reason`（缺哪个变量 / 为什么 / 怎么办）
 * - **不回显凭据**：只报 `configured` 布尔与缺失的变量名
 *
 * 本机实测过的诚实例子（写在这里防止实现漂移）：
 * - `pi.available=true` 但**模型 403** → 必须落在 `pi.model.available=false`，
 *   **不能**因此把 `pi.available` 置 false（那是撒谎，见 §7.3.1「available 的语义边界」）
 * - `ffmpeg` 用 `ffmpeg -version` **真执行**判定，不是看 PATH 里有没有文件
 * - `worker` 用 `python -m worker.cli` 真 import 判定
 */

import { spawnSync } from 'node:child_process';

import type { FastifyInstance } from 'fastify';

import type { AppDeps } from '../app-deps.ts';
import { redact } from '../config.ts';
import { selftestBigram } from '../store/bigram.ts';
import { schemaSummary } from '../store/schema-enums.ts';
import { searchStats } from '../store/search.ts';
import { probeWorker } from '../worker/probe.ts';
import { sendError } from './util.ts';

export const SERVER_VERSION = '1.0.0';

interface FfmpegProbe {
  available: boolean;
  version: string;
  reason: string;
  checkedAt: number;
}

let ffmpegCache: FfmpegProbe | null = null;
const FFMPEG_TTL_MS = 300_000;

/** `ffmpeg -version` **真执行**（与 pi 探测同源教训：只看文件存在会给假绿）。 */
export function probeFfmpeg(force = false): FfmpegProbe {
  if (!force && ffmpegCache && Date.now() - ffmpegCache.checkedAt < FFMPEG_TTL_MS) return ffmpegCache;
  const res = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  const first = (res.stdout || '').split('\n')[0]?.trim() ?? '';
  const value: FfmpegProbe = res.status === 0 && first
    ? { available: true, version: first.replace(/^ffmpeg version\s*/i, '').split(' ')[0] ?? first, reason: '', checkedAt: Date.now() }
    : {
        available: false,
        version: '',
        reason: res.error
          ? `ffmpeg 不可执行：${res.error.message}`
          : `ffmpeg -version 失败（exit ${res.status}）：${(res.stderr || '').split('\n')[0] ?? ''}`.trim(),
        checkedAt: Date.now(),
      };
  ffmpegCache = value;
  return value;
}

/** 文档解析适配器由 **worker** 提供 → worker 不可用则如实为空（不假装能解析）。 */
function adaptersFromWorker(workerAvailable: boolean): string[] {
  return workerAvailable ? ['pdf', 'pptx', 'docx', 'text', 'video'] : [];
}

function providerList(caps: Record<string, unknown> | undefined, kind: string): unknown[] {
  const list = caps?.providers;
  if (!list || typeof list !== 'object') return [];
  const arr = (list as Record<string, unknown>)[kind];
  return Array.isArray(arr) ? arr : [];
}

/** 从 provider 的 asr 列表挑一条"可用"的，映射成契约 §5.1 的 `asr` 块。 */
function asrBlock(caps: Record<string, unknown> | undefined): Record<string, unknown> {
  const list = providerList(caps, 'asr') as Record<string, unknown>[];
  const usable = list.filter((p) => p.available === true);
  const first = usable[0] ?? list[0];
  if (!first) {
    return {
      available: false,
      engine: '',
      models: [],
      device: '',
      reason: '没有可用的 ASR provider（本机未装 faster-whisper 且未配置云 ASR 凭据）',
    };
  }
  const capsInner = (first.capabilities as Record<string, unknown>) ?? {};
  const models = Array.isArray(capsInner.models) ? capsInner.models : capsInner.model ? [capsInner.model] : [];
  const available = usable.length > 0;
  return {
    available,
    engine: String(first.id ?? ''),
    models,
    device: String(capsInner.device ?? (first.runtime === 'local' ? 'cpu' : 'cloud')),
    ...(available ? {} : { reason: String(first.reason ?? '未探测到可用的 ASR provider') }),
  };
}

function llmBlock(deps: AppDeps, caps: Record<string, unknown> | undefined): Record<string, unknown> {
  const creds = deps.cfg.llm;
  const list = providerList(caps, 'llm') as Record<string, unknown>[];
  const usable = list.filter((p) => p.available === true);
  const first = usable[0] ?? list[0];
  const configured = Boolean(creds?.configured) || list.some((p) => p.configured === true);
  const available = usable.length > 0;
  const reason = available
    ? ''
    : String(
        first?.reason ??
          (configured
            ? 'LLM 凭据齐备但真探测未通过（可能欠费/被墙/模型下线）'
            : '未配置 LLM 凭据'),
      );
  return {
    configured,
    available,
    model: creds?.model || String(first?.model ?? ''),
    provider: creds?.providerId || String(first?.id ?? ''),
    // 契约 C1：并发恒为 1（用户硬要求）
    concurrency: 1,
    ...(reason ? { reason } : {}),
    ...(creds && creds.missingEnv.length > 0 ? { missing_env: [...creds.missingEnv] } : {}),
  };
}

/**
 * `/capabilities` 的**短 TTL 缓存**。
 *
 * 为什么需要（web-ui 实测）：该端点无缓存时 **7–14s**（`pi.loadMs≈2.9s` + 模型真探测 ≈2.5s +
 * 4 个引擎真探测 + FTS 计数）。首屏能力横幅等 7–14s，用户会以为页面卡住了。
 *
 * 诚实性要求（不能因为"要快"就假装是实时值）：
 * - 命中缓存时响应里带 `cached:true` + `cached_age_ms` + `cache_ttl_ms`，UI/脚本能看出来
 * - `?refresh=1`（或 `?deep=1`）**强制绕过缓存**重新探测
 * - 只缓存**成功**的响应；出错不缓存（避免把一次故障钉在 TTL 里）
 */
const CAPS_TTL_MS = 15_000;

/**
 * 缓存命中时**必须实时重算**的字段（白名单）。
 *
 * ## 为什么要有这个白名单（这个 bug class 已踩**两次**）
 * 加 15s 缓存是为了修"首屏 7–14s"，但缓存会**悄悄抵消**掉"某些字段承诺实时"的语义：
 * 1. `auth.bootstrap` —— 语义是"实时反映库里有没有用户"（启动后 `create-admin` 建号要立刻变
 *    `initialized`）。被缓存冻住 → 复活"启动瞬间快照"那个 bug。（kg-rag 抓到）
 * 2. `retrieval.*.dataReady` —— 语义是"**当前**有没有数据"（抽完资料要立刻变 `true`）。
 *    被缓存冻住 → 抽完后 15s 内仍显示"知识库为空 → 先去抽取" → **学生会重复去抽**。（kg-rag 实测）
 *
 * 三者共同点：**都是"当前状态"**，且都**极便宜**（`auth` 一次 COUNT；`retrieval.capabilities()`
 * 实测 0.05ms；`settings` 读内存 store）—— 与"昂贵探测"（pi 加载 ≈2.9s / 模型探测 ≈2.5s /
 * 4 引擎探测 / FTS 计数）差好几个数量级。
 *
 * **判据（写在这里防止第三次）**：加缓存/去重优化时，逐个字段问
 * "这个字段承诺的是**实时**还是**快照**？" —— 承诺实时的，一律放进这里。
 */
const REALTIME_ON_CACHE_HIT = ['auth', 'settings', 'retrieval'] as const;

export function registerCapabilityRoutes(app: FastifyInstance, deps: AppDeps): void {
  let capsCache: { at: number; key: string; body: Record<string, unknown> } | null = null;

  /** 构造白名单里那几个**实时**字段（缓存命中路径与主路径共用 → 两处语义不会漂）。 */
  async function realtimeFields(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {
      auth: {
        required: deps.auth.required,
        bootstrap: deps.repo.rbac.countUsers() > 0 ? 'initialized' : 'not_initialized',
      },
    };
    if (deps.settingsCapabilities) {
      try {
        out.settings = await deps.settingsCapabilities();
      } catch (err) {
        // 如实报"探测失败"（而不是省略字段 —— 省略会让前端分不清"没接入"和"探测失败"）
        out.settings = {
          available: false,
          reason: `设置层探测失败：${redact(err instanceof Error ? err.message : String(err))}`,
        };
      }
    } else {
      out.settings = {
        available: false,
        reason: '设置层未接入（src/settings/** 或 routes/settings.ts 不可用）→ 模型选择走 providers.yaml/.env',
        activeModel: null,
      };
    }
    if (deps.retrieval?.capabilities) {
      try {
        out.retrieval = await deps.retrieval.capabilities();
      } catch (err) {
        out.retrieval = { registered: true, error: redact(err instanceof Error ? err.message : String(err)) };
      }
    } else {
      out.retrieval = {
        registered: false,
        reason: '检索层未接入（src/retrieval/** 动态导入失败或未交付）→ chat 按 retrieval:none 走',
        modes: {
          none: { available: true, reason: '不检索' },
          wiki: { available: false, reason: '检索层未接入' },
          kg: { available: false, reason: '检索层未接入' },
          rag: { available: false, reason: '检索层未接入' },
        },
      };
    }
    return out;
  }

  app.get('/api/v1/capabilities', async (req, reply) => {
    try {
      const q = (req.query ?? {}) as Record<string, unknown>;
      // 默认深探测（诚实值）；`?deep=0` 走缓存求快
      const deep = q.deep !== '0' && q.deep !== 'false';
      const cacheKey = deep ? 'deep' : 'shallow';
      const forceRefresh = q.refresh === '1' || q.force === '1';

      // ★ 短 TTL 缓存：命中就**如实标注** `cached:true` + 年龄（不假装是实时值）
      // ⚠️ 但白名单里的字段（`REALTIME_ON_CACHE_HIT`）必须**每次实时重算** —— 见那里的注释
      //   （这个 bug class 已踩两次：`auth.bootstrap` 一次、`retrieval.dataReady` 一次）
      if (!forceRefresh && capsCache && capsCache.key === cacheKey) {
        const age = Date.now() - capsCache.at;
        if (age < CAPS_TTL_MS) {
          return reply.send({
            ...capsCache.body, // 只有**昂贵探测**（pi 加载 / 模型探测 / 4 引擎 / FTS 计数）走缓存
            ...(await realtimeFields()), // ★ 承诺实时的字段：auth / settings / retrieval
            cached: true,
            cached_age_ms: age,
            cache_ttl_ms: CAPS_TTL_MS,
            realtime_fields: [...REALTIME_ON_CACHE_HIT],
          });
        }
      }

      // worker：真 import 探测（缓存 300s）。走注入的探针，保证测试可控、生产为真执行
      deps.workerCapability = await deps.workerProbe(deep && q.force === '1');
      const worker = deps.workerCapability;

      const ffmpeg = probeFfmpeg(q.force === '1');

      let providerCaps: Record<string, unknown> | undefined;
      let providersError: string | null = deps.providersError;
      if (deps.providers) {
        try {
          providerCaps = (await deps.providers.capabilities({ deep })) as Record<string, unknown>;
        } catch (err) {
          providersError = redact(err instanceof Error ? err.message : String(err));
        }
      }

      let pi: Record<string, unknown>;
      if (deps.agentCapabilities) {
        try {
          pi = await deps.agentCapabilities();
        } catch (err) {
          pi = { available: false, reason: `agent 能力探测抛错：${redact(String(err))}` };
        }
      } else {
        pi = { available: false, reason: deps.agentError ?? 'agent 模块未就绪（src/agent/ 尚未交付）' };
      }

      const asr = asrBlock(providerCaps);
      const llm = llmBlock(deps, providerCaps);

      const providers: Record<string, unknown[]> = {};
      for (const kind of ['llm', 'asr', 'tts', 'translate', 'ocr', 'embedding']) {
        providers[kind] = providerList(providerCaps, kind);
      }

      const schema = schemaSummary(deps.enums);

      // ④ 检索能力 / ⑤ 系统设置段：**由 `realtimeFields()` 统一构造**（见 `REALTIME_ON_CACHE_HIT`）——
      //    这里不再各自算一遍，否则缓存命中路径与主路径就有**两处真相**，迟早漂。

      // ④ 学生 SQL 沙箱：逐引擎**真探测**（不可用必给 reason + 指向部署文档）
      let sandbox: Record<string, unknown>;
      if (deps.sandboxCapabilities) {
        try {
          sandbox = await deps.sandboxCapabilities();
        } catch (err) {
          sandbox = { available: false, reason: `沙箱探测失败：${redact(err instanceof Error ? err.message : String(err))}` };
        }
      } else {
        sandbox = {
          available: false,
          reason: '沙箱未接入（worker 不可用或未注册 sandbox 路由）',
          defaultEngine: null,
          engines: [],
        };
      }

      // ⑤ 系统设置段：**由 `realtimeFields()` 统一构造**（同 ④，避免两处真相）

      const body = {
        version: SERVER_VERSION,        // ⓪ RBAC 自述（docs/RBAC.md §8）：UI 据此决定要不要显示登录页
        //   `auth` / `retrieval` / `settings` 三个字段与**缓存命中路径共用** `realtimeFields()`
        //   （见 `REALTIME_ON_CACHE_HIT`）→ 两条路径的语义不会漂。
        //   历史：`bootstrap` 曾在组装期算一次 → 建号后仍报 `not_initialized`（已修，并加了结构级守卫）。
        ...(await realtimeFields()),
        // ④ 学生 SQL 沙箱：**真探测**（逐引擎 + 不可用必给 reason）——
        //    `sqlite` 永远可用；MySQL/PostgreSQL/openGauss 未部署 → 如实 false + 指向部署文档
        sandbox: sandbox,
        // ① 解析能力：**来自 worker 的真探测**（worker 不可用 → 空数组 + worker.reason 说明）
        adapters: adaptersFromWorker(worker.available),
        // ② 契约 §5.1 的四个能力块（缺一个就是"假装可用"）
        asr,
        llm,
        pi,
        ffmpeg: { available: ffmpeg.available, version: ffmpeg.version, ...(ffmpeg.available ? {} : { reason: ffmpeg.reason }) },
        // ③ v2 新增：worker + 逐 provider 上报（PROVIDERS §7）
        worker: {
          available: worker.available,
          bin: worker.bin,
          module: worker.module,
          python: worker.pythonVersion,
          module_importable: worker.moduleImportable,
          reason: worker.reason,
          cached: worker.cached,
          checked_at: worker.checkedAt,
          // 模块 import 失败时把 stderr 尾给出来，便于排查"到底缺哪个依赖"
          detail: worker.available ? '' : (worker.probes.module.stderr || worker.probes.python.stderr || '').trim().slice(-400),
        },
        providers,
        policy: (providerCaps?.policy as Record<string, string>) ?? deps.cfg.providers.policy,
        ...(providersError ? { providers_error: providersError } : {}),
        // ④ 检索自述（坑 15 的诚实标注）
        search: { ...searchStats(deps.db), selftest: selftestBigram() },
        // ⑤ 封闭枚举规模（来自 schema/*.json；不许发明）
        schema,
        // ⑥ 已验证的管线常量（AGENTS.md §5：不要重新发明）
        pipeline: {
          max_pages_per_unit: 8,
          span_threshold: 3,
          min_degree_for_page: 2,
          llm_concurrency: 1,
          unit_split: 'recursive_descent_with_intro',
        },
        paths: {
          root: deps.cfg.root,
          db: deps.cfg.dbPath,
          uploads: deps.cfg.uploadsDir,
          artifacts: deps.cfg.artifactsDir,
        },
      };
      // 只缓存**成功**的响应（出错不缓存，避免把一次故障钉在 TTL 里）
      capsCache = { at: Date.now(), key: cacheKey, body };
      return reply.send({ ...body, cached: false, cache_ttl_ms: CAPS_TTL_MS });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** 契约 §5.1：`{"ok":true,"version":"1.0.0"}`；附带计数便于前端首屏（附加字段）。 */
  app.get('/api/v1/health', async (_req, reply) => {
    const counts = deps.repo.globalCounts();
    return reply.send({
      ok: true,
      version: SERVER_VERSION,
      documents: deps.repo.countDocuments(),
      units: counts.units,
      cards: counts.cards,
      entities: counts.entities,
      edges: counts.edges,
      xrefs: counts.xrefs,
      tasks_active: deps.queue.running().length,
      tasks_pending: deps.queue.pendingCount,
    });
  });

  /** 封闭枚举（v1 有，前端图例要用；附加非破坏）。 */
  app.get('/api/v1/schema', async (_req, reply) => {
    return reply.send({
      edge_types: deps.enums.edgeTypes,
      card_kinds: deps.enums.cardKinds,
      entity_types: deps.enums.entityTypes,
      layers: deps.enums.layers,
      usage_modes: deps.enums.usageModes,
      operational_roles: deps.enums.operationalRoles,
      lifecycles: deps.enums.lifecycles,
      sources: deps.enums.sources,
      warnings: deps.enums.warnings,
    });
  });
}
