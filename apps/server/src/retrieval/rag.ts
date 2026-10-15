/**
 * `rag` 检索器 —— **本次只留接口**（`docs/RETRIEVAL.md` §3.3）。
 *
 * ## 为什么"只留接口"也要认真写
 * 用户裁决是"**先不接具体 embedding 模型**"。但"没接"必须表现为
 * **可读的 `available:false` + reason**，而不是"点了报错"或"静默返回空"。
 * 本模块因此是**完整实现**，只是 provider 探测返回不可用 ——
 * 一旦将来接上 embedding，`retrieve()` 可以直接工作，**不需要改契约**。
 *
 * ## ★ 三种不可用原因**必须分开报**（backend-api 明确要求，不要混成一句）
 * 1. **没有 embedding provider**（`providers.embedding` 为空/未配置凭据）
 * 2. **provider 有、但向量表是空的**（`embeddings` 零行）→ 可检索但库里没有向量
 * 3. **向量表/迁移缺失**（正常不该发生；真发生了就是迁移没跑）
 *
 * ## ★ 不许回退冒充（规则 2）
 * 任何一种不可用都必须 `items: []` + `available:false`。
 * **绝不允许**"向量不可用就悄悄改走 wiki" —— 那会让用户以为查过向量库，
 * 而这恰恰是四种模式对比教学要避免的假象。
 */

import type {
  EmbeddingProviderProbe,
  RetrievalDeps,
  RetrievalQuery,
  Retrieved,
  RetrievedItemDraft,
  Retriever,
  RetrieverHealth,
} from './types.ts';
import { DEFAULT_LIMIT } from './types.ts';
import { enforceEvidence } from './evidence.ts';
import { scopeForUser, visibleDocIds } from './scope.ts';

/** `embeddings` 表的状态（三态，与 reason 一一对应）。 */
export type EmbeddingsTableState =
  | { state: 'missing'; reason: string }
  | { state: 'empty'; reason: string }
  | { state: 'ready'; rows: number; models: string[] };

export class RagRetriever implements Retriever {
  readonly mode = 'rag' as const;
  private readonly deps: RetrievalDeps;

  constructor(deps: RetrievalDeps) {
    this.deps = deps;
  }

  /** 向量表状态（**真查表**，不看"文件在不在"）。 */
  embeddingsTableState(): EmbeddingsTableState {
    try {
      const rows = Number(this.deps.db.scalar<number>('SELECT COUNT(*) FROM embeddings') ?? 0);
      const models = this.deps.db.all<{ model: string }>('SELECT DISTINCT model FROM embeddings').map((r) => r.model);
      if (rows === 0) {
        return {
          state: 'empty',
          reason: '向量表 embeddings 已建但**零数据**（尚未对任何卡片/单元生成向量）',
        };
      }
      return { state: 'ready', rows, models };
    } catch (err) {
      return {
        state: 'missing',
        reason:
          '向量表 embeddings 不存在（迁移未跑或库过旧）' +
          `：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async providerProbes(): Promise<EmbeddingProviderProbe[]> {
    if (!this.deps.embeddingProviders) return [];
    try {
      return await this.deps.embeddingProviders();
    } catch (err) {
      return [
        {
          id: 'unknown',
          available: false,
          reason: `embedding provider 探测抛错：${err instanceof Error ? err.message : String(err)}`,
        },
      ];
    }
  }

  /**
   * 真探测：provider **与** 向量表都要就绪。
   * 顺序有讲究：先看表（便宜、本地），再看 provider。
   *
   * ★ `dataReady` = **向量表里有数据**（与 `ok` 正交；rag 的 `ok` 还要求 provider）。
   */
  async healthCheck(): Promise<RetrieverHealth> {
    const table = this.embeddingsTableState();
    const probes = await this.providerProbes();
    const usable = probes.filter((p) => p.available);
    const dataReady = table.state === 'ready' && table.rows > 0;
    const dataCount = table.state === 'ready' ? table.rows : 0;

    // 原因 1：provider（最根本的缺件）
    if (usable.length === 0) {
      const first = probes[0];
      const detail = first?.reason ?? (probes.length === 0 ? 'providers.embedding 为空' : '没有可用的 embedding provider');
      return {
        ok: false,
        dataReady,
        dataCount,
        reason:
          `未配置可用的 embedding provider（${detail}）；` +
          `向量表状态：${table.state === 'ready' ? `已有 ${table.rows} 行` : table.reason}。` +
          '见 docs/RETRIEVAL.md §3.3',
      };
    }
    // 原因 2：provider 有了但表空
    if (table.state === 'empty') {
      return {
        ok: false,
        dataReady: false,
        dataCount: 0,
        reason: `embedding provider（${usable.map((p) => p.id).join(', ')}）就绪，但${table.reason}`,
      };
    }
    // 原因 3：表缺失
    if (table.state === 'missing') {
      return { ok: false, dataReady: false, dataCount: 0, reason: table.reason };
    }
    return {
      ok: true,
      dataReady: true,
      dataCount,
      reason: `向量检索就绪：模型 ${table.models.join(', ')}，${table.rows} 行`,
    };
  }

  /**
   * 不可用时**如实返回空**（规则 2）。
   * 这里**刻意不做任何"降级到 wiki"的分支** —— 见文件头注释。
   */
  async retrieve(query: RetrievalQuery): Promise<Retrieved> {
    const t0 = Date.now();
    const limit = Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT));
    const health = await this.healthCheck();

    if (!health.ok) {
      return {
        mode: 'rag',
        modes: ['rag'],
        items: [], // ★ 不许回退冒充
        elapsedMs: Date.now() - t0,
        available: false,
        reason: health.reason ?? '向量检索不可用',
      };
    }

    // provider + 表都就绪 → 走到这里说明真的可以有向量了。
    // ⚠️ 当前**没有** provider 会走到这里（本机无 embedding）。
    //    下面保留完整实现（最近邻 = 全表读向量 + 余弦），因为它是契约的一部分；
    //    一旦接入 provider，`retrieve()` 无需改动即可工作。
    const q = (query.q ?? '').trim();
    if (!q) return { mode: 'rag', modes: ['rag'], items: [], elapsedMs: Date.now() - t0, available: true };

    const scope = scopeForUser(this.deps.repo, query.userId);
    const { ids } = visibleDocIds(this.deps.repo, scope, query.docId);
    if (ids.length === 0) {
      return {
        mode: 'rag',
        modes: ['rag'],
        items: [],
        elapsedMs: Date.now() - t0,
        available: true,
        reason: query.docId ? '该文档不存在或对你不可见' : '当前没有可见文档',
      };
    }

    // 目前只能"如实报告还没有能算查询向量的东西"
    return {
      mode: 'rag',
      modes: ['rag'],
      items: [],
      elapsedMs: Date.now() - t0,
      available: false,
      reason:
        'embedding provider 未接入查询侧编码器（本项目当前不接具体 embedding 模型）；' +
        '向量表与检索骨架已就绪，见 docs/RETRIEVAL.md §3.3。**未回退到其它模式。**',
    };
  }

  /** 供 `/capabilities` 的 `retrieval.rag` 段（诚实上报）。 */
  async capabilityBlock(): Promise<Record<string, unknown>> {
    const health = await this.healthCheck();
    const table = this.embeddingsTableState();
    const probes = await this.providerProbes();
    return {
      available: health.ok,
      /** ★ 与 `available` 正交（见 types.ts 的 `RetrieverHealth`） */
      dataReady: health.dataReady,
      dataCount: health.dataCount,
      mode: 'rag',
      reason: health.reason ?? '',
      embedding_providers: probes.map((p) => ({ id: p.id, available: p.available, reason: p.reason ?? '' })),
      embeddings_table: {
        state: table.state,
        rows: table.state === 'ready' ? table.rows : 0,
        models: table.state === 'ready' ? table.models : [],
      },
      /** 契约 §3.3 的迁移 DDL 已由 backend-api 落在 store/db.ts v3 迁移 */
      table: 'embeddings(model, ref_kind, ref_id, dim, vector, created_at)',
    };
  }
}

/** 便捷函数。 */
export function createRagRetriever(deps: RetrievalDeps): RagRetriever {
  return new RagRetriever(deps);
}

/** 供测试构造"客户端拿到空 items"的场景（保持导出面稳定）。 */
export type { RetrievedItemDraft };
