/**
 * `translate` —— 中文翻译**任务编排**（术语表注入，领域特定，不是通用翻译）。
 *
 * 规格：`docs/PROVIDERS.md` §4.2 ｜ `docs/API_PROTOCOL.md` C7
 *
 * ## 本项目**不是通用翻译**（三条硬要求）
 * 1. **术语表必须注入** —— v1 实测：不注入会把 `index` 译成"指标"、`view` 译成"看法"
 *    → 后果不是"译得不好"，是**学生搜"索引"搜不到**（检索直接失效）。
 * 2. **标识符保留英文** —— `InnoDB`/`SELECT`/`sql_mode` 译了就**无法检索**（C7）。
 * 3. **证据句不意译** —— 证据是**可核查的引用**，意译会失去可回溯性。
 *
 * ## 实测领域特征（**这是正确行为，不是失败**）
 * 414 个实体名：**56% 译中文 / 44% 保留英文**（其中 71% 是标识符）。
 * ⟹ **不要**为了让"翻译率"好看去翻标识符 —— 那会让检索失效。
 *
 * ## ⚠️ 本文件**不重新实现**领域规则（这是硬约束，不是风格）
 * lead 的裁定：**提示词与领域规则必须只有一份实现**。
 * 术语表渲染、`shouldKeepAsIs` 判定、分批、id 完整性校验 —— **全部在
 * `src/providers/translate/index.ts`**（provider 层）。
 *
 * 本模块的职责只有四件（编排层该干的事）：
 * ```text
 * ① 收集   从库里取出「实体名」与「证据句」两类待译条目（去重）
 * ② 编排   分批 + 并发=1 + 断点落盘（长任务可续）
 * ③ 回写   实体名 → entities.name_zh（供中文检索）；证据译文 → meta（**不覆盖英文原文**）
 * ④ 如实   统计"译了多少 / 保留英文多少"，无 provider 时**如实失败，绝不出假译文**
 * ```
 *
 * 原错误写法（我第一版真的踩了）：在 Node 侧又抄了一份 `SYSTEM_PROMPT` / `USER_TERM` /
 * `USER_EVIDENCE` / `shouldKeepEnglish`。那会形成**第二份真相** —— 改一处忘另一处
 * **且不会报错**（正是 lead 明确要避免的漂移风险）。现已全部删除，改为 import provider 层。
 *
 * ⚠️ 唯一保留的**本地**判定是 `shouldKeepEnglish` 的**统计用途**，它直接用 provider 层导出的
 * `shouldKeepAsIs` —— 不是镜像、不是副本。
 */

import type { ServerConfig } from '../config.ts';
import type { Db } from '../store/db.ts';
import type { Repo } from '../store/repo.ts';
import type { TaskHandler, TaskHandlerContext } from './queue.ts';
import { ApiError } from '../store/errors.ts';
// ★ 领域规则的**唯一实现**在 provider 层（只读 import，不修改 lead 的文件）
import { DEFAULT_DB_GLOSSARY, createTranslateProvider, shouldKeepAsIs } from '../providers/translate/index.ts';
import type { TranslateRequest, TranslateResult } from '../providers/types.ts';

// ═══════════════════════════════════════════════════════════════════════
// 术语表：**直接复用 provider 层的内置术语表**（唯一实现，不另抄一份）
// ═══════════════════════════════════════════════════════════════════════

/**
 * 数据库核心术语的统一译法 —— **转发 provider 层的实现**。
 *
 * 原先我在本文件抄了一份 60+ 条的 `DB_TERMS`（源自 PROMPTS.md §5.1）。
 * 那是重复实现：provider 层的 `DEFAULT_DB_GLOSSARY` 已是同一份东西，
 * 两份同时存在必然漂移。现改为**转发**，保持单一真相。
 */
export const DB_TERMS: Record<string, string> = DEFAULT_DB_GLOSSARY;

/** 术语表规模（用于任务 `detail` 里如实上报"注入了多少条术语"）。 */
export function glossarySize(glossary: Record<string, string>): number {
  return Object.keys(glossary).length;
}

/**
 * 是否保留英文 —— **转发 provider 层**（`shouldKeepAsIs`），仅用于统计。
 *
 * ⚠️ 这**不是**第二份规则：直接调用 provider 层函数，两者永远一致。
 */
export function shouldKeepEnglish(text: string, keepAsIs: readonly string[] = []): boolean {
  return shouldKeepAsIs(text, keepAsIs);
}

// ═══════════════════════════════════════════════════════════════════════
// 条目收集（纯函数，可单测）
// ═══════════════════════════════════════════════════════════════════════

/** 待译条目的 kind —— 两类走**不同提示词**（实体名求简、证据句求准，PROMPTS §5.4）。 */
export type TranslateItemKind = 'term' | 'evidence';

export interface TranslateItem {
  id: string;
  text: string;
  kind: TranslateItemKind;
}

/**
 * 从文档收集待译条目。
 *
 * - **实体名**（`kind='term'`）：`name_zh` 为空的实体才需要译
 * - **证据句**（`kind='evidence'`）：卡片的 `evidence_quote`，去重（同一句常被多张卡片引用）
 *
 * 已是中文的条目直接跳过 —— 送进去只会浪费 token。
 */
export function collectItems(repo: Repo, docId: string): { items: TranslateItem[]; stats: Record<string, number> } {
  const items: TranslateItem[] = [];
  const seenTerm = new Set<string>();
  const seenEvid = new Set<string>();

  for (const e of repo.getGraph(docId).nodes) {
    const name = (e.name ?? '').trim();
    if (!name) continue;
    if ((e.name_zh ?? '').trim()) continue; // 已有中文 → 不需要译
    const key = name.toLowerCase();
    if (seenTerm.has(key)) continue;
    seenTerm.add(key);
    items.push({ id: `ent:${e.id}`, text: name, kind: 'term' });
  }

  for (const c of repo.allCardRows(docId)) {
    const q = (c.evidence_quote ?? '').trim();
    if (!q) continue;
    if (/[\u4e00-\u9fff]/.test(q)) continue; // 已是中文
    const key = q.slice(0, 120);
    if (seenEvid.has(key)) continue;
    seenEvid.add(key);
    items.push({ id: `evi:${c.id}`, text: q, kind: 'evidence' });
  }

  return {
    items,
    stats: { terms: seenTerm.size, evidences: seenEvid.size, items_total: items.length },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 断点（长任务可续 —— 契约 C4）
// ═══════════════════════════════════════════════════════════════════════

export interface TranslateCheckpoint {
  doc_id: string;
  /** 已完成条目：id → {text, kept, at} */
  done: Record<string, { text: string; kept: boolean; at: number }>;
  updated_at: number;
}

export function readCheckpoint(raw: unknown, docId: string): TranslateCheckpoint {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const doneRaw = o.done && typeof o.done === 'object' ? (o.done as Record<string, unknown>) : {};
  const done: TranslateCheckpoint['done'] = {};
  for (const [k, v] of Object.entries(doneRaw)) {
    const e = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    if (typeof e.text !== 'string') continue;
    done[k] = { text: e.text, kept: e.kept === true, at: typeof e.at === 'number' ? e.at : 0 };
  }
  return { doc_id: docId, done, updated_at: typeof o.updated_at === 'number' ? o.updated_at : 0 };
}

export function translateCheckpointPath(cfg: ServerConfig, docId: string): string {
  return `${cfg.checkpointsDir}/${docId}_translate.json`;
}

// ═══════════════════════════════════════════════════════════════════════
// Provider 接口（结构化声明，避免与 lead 的实现文件耦合）
// ═══════════════════════════════════════════════════════════════════════

export type TranslateFn = (req: TranslateRequest) => Promise<TranslateResult>;
/** 兼容别名：测试/其它模块可能按这个名字引用（避免与 `providers/types.ts` 混淆）。 */
export type TranslateProviderRequest = TranslateRequest;

/**
 * 从 provider 配置**推导**一个翻译函数 —— 复用 provider 层自己的工厂
 * （`createTranslateProvider`），因此**领域规则仍只有一份实现**（提示词/术语表/保留判定
 * 全在 `src/providers/translate/index.ts`）。
 *
 * ## 为什么需要它
 * `index.ts` 的接入钩子（backend-api 的写域）传的是 `extraDeps`，**不含 `translate`**，
 * 只含 `completeJson`。若只认 `deps.translate`，则**明明 LLM 可用、翻译却永远报"没有 provider"**
 * —— 那是"假失败"，同样违反诚实原则（用户会以为翻译不可用）。
 *
 * 这里用 `config.providers.translate` 里第一条 `llm` 类型的配置**现组一个** provider。
 * 若没有该配置 → 返回 `null`（如实降级，不猜端点）。
 *
 * ⚠️ 不重复实现任何规则：连"哪些该保留英文"都由该 provider 内部判定。
 */
export function deriveTranslateFnFromConfig(
  entries: { id: string; type: string; options: Record<string, unknown>; missingEnv: string[] }[] | undefined,
  glossary: Record<string, string>,
): { fn: TranslateFn; id: string; reason: string } | null {
  if (!entries || entries.length === 0) return null;
  // 优先 `llm` 类型（带术语表注入）；`deepl` 等专用 MT 作为次选
  const ordered = [...entries].sort((a, b) => {
    const rank = (t: string): number => (t === 'llm' || t === 'openai_compatible' ? 0 : 1);
    return rank(a.type) - rank(b.type);
  });
  const entry = ordered[0] as (typeof ordered)[number];
  if (!entry) return null;
  const provider = createTranslateProvider(
    {
      id: entry.id,
      kind: 'translate',
      type: entry.type,
      priority: 0,
      enabled: true,
      options: entry.options,
      missingEnv: entry.missingEnv,
      envRefs: {},
    },
    { glossary },
  );
  if (!provider) return null;
  const withTranslate = provider as unknown as { translate?: TranslateFn };
  if (typeof withTranslate.translate !== 'function') return null;
  return {
    fn: (req) => (withTranslate.translate as TranslateFn)(req),
    id: provider.info.id,
    reason: provider.info.configured ? '' : (provider.info.reason ?? '凭据未配置'),
  };
}

export interface TranslateHandlerDeps {
  repo: Repo;
  db: Db;
  cfg: ServerConfig;
  /**
   * provider 层的 `translate()`（通常是 `providers.translate.bind(providers)`）。
   * `null` / 省略 = 没有直接注入 → 本模块会尝试从 `cfg.providers.translate` **推导**
   * （见 `deriveTranslateFnFromConfig`）；推导不出来才如实降级。
   */
  translate?: TranslateFn | null;
  /** 术语表覆盖（与 provider 层内置术语表**合并**；provider 层负责真正注入提示词） */
  glossary?: Record<string, string>;
  /** 保留英文白名单（透传给 provider 层） */
  keepAsIs?: string[];
  /** 目标语言（默认 `zh`） */
  to?: string;
  /** 每批条目数（也是断点粒度） */
  batchSize?: number;
  /** 单次最多处理多少条目（小样本先跑；0/undefined = 不限） */
  maxItemsPerRun?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════════════

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function createTranslateHandler(deps: TranslateHandlerDeps): TaskHandler {
  const { repo, cfg } = deps;
  const glossary = { ...DB_TERMS, ...(deps.glossary ?? {}) };
  const to = deps.to ?? 'zh';
  const batchSize = Math.max(1, deps.batchSize ?? 20);
  const keepAsIs = deps.keepAsIs ?? [];

  return async (ctx: TaskHandlerContext): Promise<Record<string, unknown>> => {    const docId = ctx.docId;
    if (!docId) throw new ApiError('E_NOTFOUND', 'translate 任务缺少 doc_id');
    if (!repo.getDocumentRow(docId)) throw new ApiError('E_NOTFOUND', `文档不存在：${docId}`);

    const { items, stats } = collectItems(repo, docId);

    // ── 断点 ──
    const cpPath = translateCheckpointPath(cfg, docId);
    let cp: TranslateCheckpoint = { doc_id: docId, done: {}, updated_at: 0 };
    try {
      const fs = await import('node:fs');
      if (fs.existsSync(cpPath)) cp = readCheckpoint(JSON.parse(fs.readFileSync(cpPath, 'utf8')), docId);
    } catch {
      cp = { doc_id: docId, done: {}, updated_at: 0 };
    }
    const saveCheckpoint = async (): Promise<void> => {
      try {
        const fs = await import('node:fs');
        fs.mkdirSync(cfg.checkpointsDir, { recursive: true });
        cp.updated_at = Date.now();
        fs.writeFileSync(cpPath, JSON.stringify(cp), 'utf8');
      } catch {
        /* 断点写失败不让任务失败；下次重算这批 */
      }
    };

    // ── 本地判定「必须保留英文」──
    // ⚠️ **只对 `term`（实体名）做这个判定，不对 `evidence`（证据句）做**。
    //    语义上：标识符规则是为了"别把 InnoDB 译成中文导致搜不到"，
    //    它天然适用于**名称**；而证据句是**整句**，本来就要译（只是"不意译"）。
    //
    //    原错误写法：对两类都套 `shouldKeepEnglish`。实测后果很严重 ——
    //    证据句几乎都以 `.` 结尾，会被判成"标识符"而**整句保留英文、一条都不译**，
    //    翻译任务于是"成功但什么都没做"（静默空转）。这正是本项目最忌讳的那类 bug。
    const keep: TranslateItem[] = [];
    const need: TranslateItem[] = [];
    for (const it of items) {
      // 证据句：只跳过**已经是中文的**（已是中文无需再译）
      if (it.kind === 'evidence') {
        if (/[\u4e00-\u9fff]/.test(it.text)) keep.push(it);
        else need.push(it);
        continue;
      }
      if (shouldKeepEnglish(it.text, keepAsIs)) keep.push(it);
      else need.push(it);
    }
    for (const it of keep) {
      cp.done[it.id] = { text: it.text, kept: true, at: Date.now() };
    }

    /** 统计用：某条最终是否保留英文（与上面的判定规则一致） */
    const isKept = (it: TranslateItem): boolean => {
      const d = cp.done[it.id];
      if (d) return d.kept === true;
      if (it.kind === 'evidence') return /[\u4e00-\u9fff]/.test(it.text);
      return shouldKeepEnglish(it.text, keepAsIs);
    };
    /** 统计用：某条是否**真的译出来了**（有非空译文且不是保留） */
    const isTranslated = (it: TranslateItem): boolean => {
      const d = cp.done[it.id];
      // ⚠️ 必须先 `if (!d) return false` 再访问字段 —— 写 `Boolean(d) && d.kept` 时
      //    TS 不会把 `Boolean(d)` 当作收窄（实测 TS18048 'd' is possibly 'undefined'）。
      if (!d) return false;
      return d.kept === false && (d.text ?? '').trim().length > 0;
    };

    const summarize = (
      extra: Record<string, unknown>,
    ): Record<string, unknown> => {
      const keptCount = items.filter(isKept).length;
      const translatedCount = items.filter(isTranslated).length;
      const total = items.length;
      return {
        glossary_terms: glossarySize(glossary),
        items_total: total,
        // ★ 领域特征：保留英文**是正确行为，不是失败**
        kept_english: keptCount,
        translated: translatedCount,
        kept_ratio: total > 0 ? keptCount / total : 0,
        translated_ratio: total > 0 ? translatedCount / total : 0,
        ...stats,
        ...extra,
      };
    };

    // ── 确定真正的翻译函数 ──
    // ① 直接注入的（provider 门面）优先；② 否则从 provider 配置**推导**（复用 provider 层工厂）；
    // ③ 都没有 → **如实失败 / 如实跳过，绝不出假译文**。
    let translateFn: TranslateFn | null = deps.translate ?? null;
    let derivedFrom = '';
    let derivedReason = '';
    if (!translateFn) {
      // ⚠️ 注意嵌套：`ServerConfig.providers` 是 `ProviderConfig`，
      //    真正的数组在 `ProviderConfig.providers.translate`（实测踩到 TS2339）。
      const derived = deriveTranslateFnFromConfig(cfg.providers?.providers?.translate, glossary);
      if (derived) {
        translateFn = derived.fn;
        derivedFrom = derived.id;
        derivedReason = derived.reason;
      }
    }

    if (!translateFn) {
      const reason =
        '没有可用的翻译 provider（provider 层 translate 未注入，且 config/providers.yaml 里没有可用的 translate 配置）';
      const pending = need.filter((it) => !isTranslated(it));
      await saveCheckpoint();
      if (pending.length > 0) {
        throw new ApiError('E_LLM', `翻译不可用：${reason}`, {
          hint: '在 config/providers.yaml 配置 translate（如 type: llm + ${AMR_BASE}/${AMR_KEY}）后重试',
          detail: `待译 ${pending.length} 条；已按领域规则保留英文 ${keep.length} 条`,
        });
      }
      ctx.progress(1, '完成（全部条目按领域规则保留英文）');
      return {
        translate: {
          provider_available: false,
          reason,
          persisted: { entities: 0, evidences: 0 },
          ...summarize({ provider: '' }),
        },
      };
    }
    // 收窄成非空常量（TS 不跨 await 保持收窄 —— 实测报 TS18047）
    const doTranslate: TranslateFn = translateFn;

    // ── 待译队列：已完成的不重跑（断点续跑）；maxItems 用于小样本 ──
    let todo = need.filter((it) => !isTranslated(it));
    const maxItems = deps.maxItemsPerRun && deps.maxItemsPerRun > 0 ? deps.maxItemsPerRun : 0;
    if (maxItems > 0) todo = todo.slice(0, maxItems);

    let failed = 0;
    const failures: string[] = [];
    let usedProvider = '';
    let degradedFrom = '';
    let degradedReason = '';

    for (let i = 0; i < todo.length; i += batchSize) {
      if (ctx.signal.aborted) break;
      const batch = todo.slice(i, i + batchSize);
      try {
        const res = await doTranslate({
          items: batch.map((it) => ({ id: it.id, text: it.text, kind: it.kind })),
          to,
          glossary,
          keepAsIs,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const byId = new Map(res.items.map((x) => [x.id, x]));
        // ★ 不许静默丢条目（provider 层也会查一次；这里是编排层的双保险）
        const missing = batch.filter((it) => !byId.has(it.id)).map((it) => it.id);
        if (missing.length > 0) {
          throw new Error(`翻译返回缺 ${missing.length} 条（${missing.slice(0, 5).join(',')}）`);
        }
        for (const it of batch) {
          const got = byId.get(it.id) as { text: string; keptAsIs?: boolean };
          cp.done[it.id] = { text: got.text, kept: got.keptAsIs === true, at: Date.now() };
        }
        if (res.usedProvider) usedProvider = res.usedProvider;
        if (res.degradedFrom) {
          degradedFrom = res.degradedFrom;
          degradedReason = res.degradedReason ?? '';
        }
        // 每批落盘（断点粒度 = 批次）
        await saveCheckpoint();
      } catch (err) {
        failed += batch.length;
        const msg = `batch ${Math.floor(i / batchSize) + 1}: ${err instanceof Error ? err.message : String(err)}`;
        if (failures.length < 5) failures.push(msg);
      }
      const progressed = Math.min(1, (i + batch.length) / Math.max(1, todo.length));
      ctx.progress(Math.min(0.95, progressed), `翻译 ${Math.min(i + batch.length, todo.length)}/${todo.length}`, {
        done: Math.min(i + batch.length, todo.length),
        total: todo.length,
      });
    }

    // ── 回写（实体 name_zh + 证据译文进 meta，**不覆盖英文原文**）──
    const persisted = await applyTranslations(repo, docId, cp);
    await saveCheckpoint();
    ctx.progress(1, '完成');

    return {
      translate: {
        provider_available: true,
        provider: usedProvider || derivedFrom,
        // 如实说明这个 provider 是**配置推导**出来的（不是门面直接注入的）
        ...(derivedFrom ? { provider_source: 'derived_from_config', configured_reason: derivedReason } : {}),
        ...(degradedFrom ? { degraded_from: degradedFrom, degraded_reason: degradedReason } : {}),
        persisted,
        failed,
        ...(failures.length > 0 ? { failures } : {}),
        ...summarize({}),
      },
    };
  };
}

/**
 * 把译文回写进库。
 *
 * - 实体名 → `entities.name_zh`（**中文检索用**：中文问句要能命中英文实体）
 * - 证据句译文 → `documents.meta.translations_evidence`
 *   ⚠️ **不覆盖 `cards.evidence_quote` 里的英文原文** —— 那是**可核查的引用**，
 *   必须留着（PROVIDERS §4.2 要求"中英并存"：证据中文译文 + 英文原文）。
 */
export async function applyTranslations(
  repo: Repo,
  docId: string,
  cp: TranslateCheckpoint,
): Promise<{ entities: number; evidences: number }> {
  let entities = 0;
  let evidences = 0;
  const evidenceMap: Record<string, string> = {};

  const byId = new Map(repo.getGraph(docId).nodes.map((n) => [n.id, n]));

  for (const [id, v] of Object.entries(cp.done)) {
    if (v.kept || !(v.text ?? '').trim()) continue;
    if (id.startsWith('ent:')) {
      const entId = id.slice(4);
      const node = byId.get(entId);
      if (!node) continue;
      if ((node.name_zh ?? '').trim()) continue; // 已有中文名不覆盖（人工/上游优先）
      try {
        repo.db.run('UPDATE entities SET name_zh = ? WHERE id = ? AND doc_id = ?', v.text, entId, docId);
        entities += 1;
      } catch {
        /* 单条回写失败不放弃整篇 */
      }
    } else if (id.startsWith('evi:')) {
      evidenceMap[id.slice(4)] = v.text;
      evidences += 1;
    }
  }

  if (evidences > 0) {
    const row = repo.getDocumentRow(docId);
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(row?.meta_json || '{}') as Record<string, unknown>;
    } catch {
      meta = {};
    }
    const prev = asRecord(meta.translations_evidence) ?? {};
    repo.mergeDocumentMeta(docId, { translations_evidence: { ...prev, ...evidenceMap } });
  }
  return { entities, evidences };
}
