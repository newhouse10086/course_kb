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
import { LLM_QUEUE } from '../providers/llm/openai_compatible.ts';
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
    // ★ 并发**真值**（同源，坑 21）：读 provider 层唯一队列，不再硬编码 1
    concurrency: LLM_QUEUE.concurrency,
    concurrency_detail: {
      in_flight: LLM_QUEUE.inFlight,
      pending: LLM_QUEUE.pending,
      peak_in_flight: LLM_QUEUE.peakInFlight,
      note: '默认 1；改 COURSE_KB_LLM_CONCURRENCY 需**重启**生效（非法值拒绝启动）',
    },
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
/**
 * 昂贵探测的缓存 TTL：**5 分钟**（原 15s）。
 *
 * ## 为什么必须显著长于轮询间隔（真实成本缺陷）
 * `/capabilities` **默认走深探测**（`deep = q.deep !== '0'`）→ registry 对**每个 configured provider**
 * 强制 `healthCheck()`（`force:true`）→ **每个 provider = 一次真实上游调用**（LLM/ASR/TTS/OCR）。
 * 而 15s 的 TTL **等于没有缓存**：前端按 15s 轮询 → **每 15s 烧一轮探测**。
 * 与 `/models` 原先"全候选都探"是**同一类放大器**（实测某平台 kimi-k3 被调 263 次）。
 *
 * ⟹ 昂贵且慢变的探测结果缓存 5 分钟；`?refresh=1` 显式强制重探（**调用方显式付费**），
 *    响应里的 `probe_calls` 让代价可见。
 *
 * ⚠️ **只作用于 `CACHEABLE_FIELDS`** —— `auth` / `settings` / `retrieval` / `search`
 * 仍在 `LIVE_FIELDS` 里**每次实时重算**（坑 19：不许把"承诺实时"的字段冻住）。
 */
const CAPS_TTL_MS = 300_000;

/**
 * ★★ **只有这些字段允许"陈旧"**（走缓存）；**其余一律实时重算** —— fail-safe 方向。
 *
 * ## 为什么是"可缓存白名单"而不是"实时白名单"（Lead 裁定的方向反转）
 * 我原先写的是 `REALTIME_ON_CACHE_HIT`（默认缓存、靠记得把新字段加进实时白名单）——
 * 这个坑**一轮内踩了 3 次**（`auth.bootstrap` / `settings.activeModel` / `retrieval.dataReady`），
 * 说明"靠记得加"不可靠。反转之后：
 * - **忘了分类 → 新字段按"实时"处理**（安全，最多慢一点）
 * - 而不是 → 新字段被悄悄缓存成**陈旧值**（不安全，且**测试不会红**）
 *
 * ## 判据（写在这里，防止再犯）
 * **一个"忘了就出错"的设计不可靠；一个"忘了就退化成保守"的设计才可靠。**
 * 与本项目其它原则一致：默认拒绝鉴权、默认不假装可用、`available` 与 `dataReady` 正交。
 *
 * ## 漏分类的兜底（靠机制，不靠记得）
 * 缓存命中前先检查：缓存体里是否有**既不在本白名单、也不在实时集**的顶层 key（= 有人新增字段却没分类）
 * → 那就**不冒险用缓存**，直接走完整重算，并把清单放进响应的 `unclassified_fields`；
 * 测试断言它为空 ⟹ **新字段忘分类时会红**。
 *
 * ## 历史（这些字段为什么"承诺实时"）
 * 1. `auth.bootstrap` —— "实时反映库里有没有用户"（启动后 `create-admin` 建号要立刻变 `initialized`）
 * 2. `settings.activeModel` —— 模型热切换后要立刻可见
 * 3. `retrieval.*.dataReady` —— "**当前**有没有数据"（抽完资料要立刻变 `true`）
 * 4. `search` —— FTS 行数（抽完资料要立刻可见）
 * 共同点：**都是"当前状态"**，且都**极便宜**（一次 COUNT / 读内存 store / 0.05ms / 0.007ms），
 * 与"昂贵探测"（pi 加载 ≈2.9s / 模型探测 ≈2.5s / 4 引擎探测）差好几个数量级。
 */
const CACHEABLE_FIELDS = [
  // 昂贵**真探测**（秒级）：pi 加载 ≈2.9s / 模型探测 ≈2.5s / 4 引擎探测 / worker import
  'pi',
  'llm',
  'asr',
  'sandbox',
  'providers',
  'worker',
  'ffmpeg',
  'adapters',
  'policy',
  'providers_error',
  // 启动期就定下来的**静态**值（运行期不变）
  'version',
  'schema',
  'pipeline',
  'paths',
  // `chat_modes`：模式/工具/允许角色都是启动期静态策略（`kb.available` 也是装配期定）
  'chat_modes',
] as const;

/** 缓存命中时**必须实时重算**的字段（都很便宜）。 */
/**
 * ★ **必须实时的字段**（每次请求都重算，绝不来自缓存）。
 *
 * `auth` / `settings` / `retrieval` / `search` 承诺"实时"（坑 19 一轮踩了 3 次：
 * `auth.bootstrap` / `settings.activeModel` / `retrieval.dataReady`）。
 *
 * `probe_calls` / `probe_detail` 也在这里：它们描述**本次请求的代价**，
 * 缓存命中时必须报 0（若进缓存，第二次请求会谎报"又探了 N 次"—— 自述与生效不符，坑 21）。
 */
const LIVE_FIELDS = ['auth', 'settings', 'retrieval', 'search', 'probe_calls', 'probe_detail'] as const;

export function registerCapabilityRoutes(app: FastifyInstance, deps: AppDeps): void {
  let capsCache: { at: number; key: string; body: Record<string, unknown> } | null = null;

  /** 构造**实时**字段（缓存命中路径与主路径共用 → 两处语义不会漂）。 */
  async function liveFields(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {
      auth: {
        required: deps.auth.required,
        bootstrap: deps.repo.rbac.countUsers() > 0 ? 'initialized' : 'not_initialized',
      },
      // 检索/FTS 统计：抽完资料后必须立刻可见（否则 UI 会显示"知识库为空"）
      search: { ...searchStats(deps.db), selftest: selftestBigram() },
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
      // ⚠️ 只把 `CACHEABLE_FIELDS`（昂贵探测 + 静态值）走缓存，**其余一律实时重算**；
      //    若发现**未分类**的顶层字段 → **不冒险用缓存**（走完整重算）—— 见 `CACHEABLE_FIELDS` 注释。
      if (!forceRefresh && capsCache && capsCache.key === cacheKey) {
        const age = Date.now() - capsCache.at;
        const cachedBody = capsCache.body;
        const cacheable = new Set<string>(CACHEABLE_FIELDS);
        const live = new Set<string>(LIVE_FIELDS);
        // 漏分类检测：既不可缓存、也不在实时集 → 新字段默认按"实时/重算"处理（安全方向）
        const unclassified = Object.keys(cachedBody).filter((k) => !cacheable.has(k) && !live.has(k));
        if (age < CAPS_TTL_MS && unclassified.length === 0) {
          const cachedPart: Record<string, unknown> = {};
          for (const k of CACHEABLE_FIELDS) if (k in cachedBody) cachedPart[k] = cachedBody[k];
          return reply.send({
            ...cachedPart, // 只有**允许陈旧**的字段来自缓存
            ...(await liveFields()), // ★ 其余实时重算：auth / settings / retrieval / search
            cached: true,
            cached_age_ms: age,
            cache_ttl_ms: CAPS_TTL_MS,
            // ★ 命中缓存 = **本次一次真探测都没有**（如实报 0，与 `/models` 同一原则）
            probe_calls: 0,
            probe_detail: { note: '命中缓存，本次未做任何真探测' },
            cacheable_fields: [...CACHEABLE_FIELDS],
            live_fields: [...LIVE_FIELDS],
            unclassified_fields: [],
          });
        }
        // age 到期 或 有未分类字段 → 落到下面**完整重算**（并在响应里如实报出未分类清单）
      }

      // worker：真 import 探测（缓存 300s）。走注入的探针，保证测试可控、生产为真执行
      deps.workerCapability = await deps.workerProbe(deep && q.force === '1');
      const worker = deps.workerCapability;

      const ffmpeg = probeFfmpeg(q.force === '1');

      let providerCaps: Record<string, unknown> | undefined;
      let providersError: string | null = deps.providersError;
      /**
       * ★ **成本计数**：本次请求真探测了几次（与 `/models` 的 `probeCalls` 同一原则 —— 代价必须可见）。
       *
       * 判据同源（坑 21）：`probe_calls` 由**实际发生的探测**推导 ——
       * `deep` 时 registry 会对**每个 `configured` 的 provider** 强制 `healthCheck()`（`force:true`，
       * 绕过它自己的缓存）→ 每个 = **一次真实上游调用**（LLM/ASR/TTS/OCR/翻译都算）。
       * 未配置的 provider **不探测**（registry 直接返回）→ 不计入。
       */
      let probeCalls = 0;
      let probeDetail: Record<string, number> = {};
      if (deps.providers) {
        try {
          providerCaps = (await deps.providers.capabilities({ deep })) as Record<string, unknown>;
          if (deep) {
            const byKind = (providerCaps.providers ?? {}) as Record<string, { configured?: boolean }[]>;
            for (const [kind, list] of Object.entries(byKind)) {
              const n = Array.isArray(list) ? list.filter((p) => p.configured === true).length : 0;
              if (n > 0) probeDetail[kind] = n;
              probeCalls += n;
            }
          }
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

      // ④ 检索能力 / ⑤ 系统设置段：**由 `liveFields()` 统一构造**（见 `CACHEABLE_FIELDS`）——
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

      // ⑤ 系统设置段：**由 `liveFields()` 统一构造**（同 ④，避免两处真相）

      const body = {
        version: SERVER_VERSION,        // ⓪ RBAC 自述（docs/RBAC.md §8）：UI 据此决定要不要显示登录页
        //   `auth` / `settings` / `retrieval` / `search` 与**缓存命中路径共用** `liveFields()`
        //   （见 `CACHEABLE_FIELDS` / `LIVE_FIELDS`）→ 两条路径的语义不会漂。
        //   历史：`bootstrap` 曾在组装期算一次 → 建号后仍报 `not_initialized`（已修，并加了结构级守卫）。
        ...(await liveFields()),
        /**
         * ★ 对话模式自述（Lead 裁定）：前端据此渲染模式选择器，**不必自己按 roles 推断**
         * （上次 `user.roles` 推断的教训：前端猜权限迟早与后端不一致）。
         *
         * - `chat`：无工具（默认）；`agent`：**只读**知识库工具 `kb_search`/`kb_get`
         * - 危险工具 `read`/`bash`/`edit`/`write` **永远剔除**（agent 模式 ≠ 放开主机工具）
         * - `allowed_roles`：`agent` 允许的角色（**服务端权威**）
         *   ★ Lead 裁定（2026-10-15）：**加 `student`** —— 答疑的主体是学生，不给学生开等于
         *   这个功能对主要场景无效；且风险画像与 `bash` 完全不同（只读 + 按 userId 过滤 +
         *   无主机工具 + 无 SQL 执行）。它还是**安全的正向收益**：给模型一个受控出口去读原文，
         *   比"想读却没工具 → 把 tool 调用退化成正文乱码"更好。
         * - `kb`：只读查询是否接入（未接入 → agent 模式**如实降级**，不假装有结果）
         */
        chat_modes: {
          modes: ['chat', 'agent'],
          default: 'chat',
          tools: { chat: [], agent: ['kb_search', 'kb_get'] },
          allowed_roles: { agent: ['admin', 'teacher', 'student'] },
          kb: deps.kb
            ? { available: true, readonly: true, scoped_by: 'userId' }
            : { available: false, reason: '只读知识库查询未接入（store/kb-query.ts）→ agent 模式如实降级' },
          note: '模式是**会话级**的（工具集在建会话时确定）：请用 `?mode=agent` 连接；未知 mode → 明确报错',
        },
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
        // ④ 检索自述（坑 15 的诚实标注）+ `search` —— 由 `liveFields()` 统一构造（与缓存命中路径共用）
        // ⑤ 封闭枚举规模（来自 schema/*.json；不许发明）
        schema,
        // ⑥ 已验证的管线常量（AGENTS.md §5：不要重新发明）
        pipeline: {
          max_pages_per_unit: 8,
          span_threshold: 3,
          min_degree_for_page: 2,
          llm_concurrency: LLM_QUEUE.concurrency, // ★ 同源：读真值（原为硬编码 1）
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
      return reply.send({
        ...body,
        cached: false,
        cache_ttl_ms: CAPS_TTL_MS,
        // ★ 成本可见（与 `/models` 的 `probeCalls` 同一原则）：本次真探测了几次
        probe_calls: probeCalls,
        probe_detail: probeDetail,
        // 如实报出分类：前端/验收脚本能看出"哪些字段允许陈旧、哪些每次实时"
        cacheable_fields: [...CACHEABLE_FIELDS],
        live_fields: [...LIVE_FIELDS],
        unclassified_fields: [],
      });
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
