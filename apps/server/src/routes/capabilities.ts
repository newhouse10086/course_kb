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

export function registerCapabilityRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/v1/capabilities', async (req, reply) => {
    try {
      const q = (req.query ?? {}) as Record<string, unknown>;
      // 默认深探测（诚实值）；`?deep=0` 走缓存求快
      const deep = q.deep !== '0' && q.deep !== 'false';

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

      return reply.send({
        version: SERVER_VERSION,
        // ⓪ RBAC 自述（docs/RBAC.md §8）：UI 据此决定要不要显示登录页
        auth: deps.auth,
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
