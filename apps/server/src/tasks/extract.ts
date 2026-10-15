/**
 * 卡片/图谱抽取 —— **A1 分工**（`ARCHITECTURE_V2` §3「LLM 调用归 Node」+ Lead 裁决）。
 *
 * ```text
 * worker.extract.plan      → 提示词 + json_schema + 单元挑选（**worker 侧唯一实现**）
 * providers.completeJson   → Node 调 LLM（凭据不下发子进程；json_schema + strict）
 * worker.extract.convert   → 校验 + 转卡片/实体/边（**worker 侧唯一实现**）
 * ```
 *
 * ⚠️ **为什么不再在 TS 侧自建提示词/schema**（原写法，已删除）：
 * 那样会有**两份实现**（TS 一份、worker 一份）→ 必然漂移：改了一处忘另一处，
 * 抽出的 `kind`/`etype` 就会越界或字段缺失，而且**不会报错**（静默产出脏数据）。
 * 现在提示词 + 封闭枚举 + 转换规则只有 worker 一处，TS 只负责"调模型"和"落库"。
 *
 * worker 侧接口实测事实（backend-core 提供）：
 * - `extract.plan` **必须传完整 units**：它要先建层次树再挑单元；只传截断单元会得到 `items=0`
 * - `plan.schema` 是**裸 JSON Schema**（无 `{name, schema}` 包装）→ 调用方自己补 `name`
 * - `plan.items[]` 带 `key` / `unit_key` / `system` / `user` / `span` / `chars`
 * - `extract.convert` 收 `payloads: [{key, data}]`，返回 `{ok, error_count, cards, entities, edges, sections, stats, errors}`
 * - **"有 payload 但一条都没匹配上"会 exit 1** → 成功判断必须看 `ok`/`units_done`，**不能只看 cards**
 */

import type { CardDraft, EdgeDraft, EntityDraft } from '../store/repo.ts';
import type { Span } from '../store/types.ts';
import { ApiError } from '../store/errors.ts';
import type { WorkerRunnerWithRaw } from '../worker/runner.ts';

/** provider 层 `completeJson` 的**结构化**依赖（不 import 其 types，避免耦合）。 */
export interface CompleteJsonRequest {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  /** ★ worker 给的是裸 schema，这里补上 `name` 再传（provider 层要求 `{name, schema}`） */
  schema: { name: string; schema: Record<string, unknown> };
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface CompleteJsonResult {
  data: unknown;
  usedProvider?: string;
  degradedFrom?: string;
  degradedReason?: string;
  /** ★ 实测的结构化输出模式（provider 降级链的回执；上游写进 meta） */
  structuredOutputMode?: 'strict' | 'lenient';
}

export type CompleteJsonFn = (req: CompleteJsonRequest) => Promise<CompleteJsonResult>;

export interface SectionSummary {
  section_summary: string;
  learning_objectives?: string[];
  section_role?: string;
  key_takeaways?: string[];
}

/** 传给 worker 的单元（**持久化形状**：带 `id`/`parent_id`）。 */
export interface ExtractUnitInput {
  id: string;
  ord: number;
  title: string;
  level: number;
  parent_id: string | null;
  span: Span;
  text: string;
}

export interface ExtractDocumentRequest {
  docId: string;
  /** ★ 必须传**完整** units（worker 要先建树再挑）；不要只传截断样本 */
  units: ExtractUnitInput[];
  title?: string;
  pagesTotal?: number;
  /** 只抽前 N 个 item（小样本先跑）；item 粒度由 worker 的 pick 决定 */
  limit?: number;
  excludedRanges?: number[][];
  /**
   * 断点文件（`worker/README.md` §7）：worker 每单元落盘（原子替换）。
   * 模型热切换的 `mode:"abort"` = 存断点 → 终止 → 换模型 → **从断点续推**（不重复计费）。
   */
  checkpointFile?: string;
  /** `true` 时 worker **跳过已完成单元**（必须与同一个 `checkpointFile` 配对才有意义）。 */
  resume?: boolean;
  signal?: AbortSignal;
  onProgress?: (info: { stage: string; done: number; total: number }) => void;
  onEvent?: (e: Record<string, unknown>) => void;
}

export interface ExtractDocumentResult {
  cards: CardDraft[];
  entities: EntityDraft[];
  edges: EdgeDraft[];
  /** unit_id → section 概括（F3 的叶子层摘要来源） */
  sections: Record<string, SectionSummary>;
  /**
   * ★ worker 自报的批次状态：`done` | `done_empty` | `partial` | `failed`。
   * `done_empty` = 全部成功但**零卡片**（内容不足）→ 调用方**不许当成功**（见 `EXTRACT_STATUS`）。
   */
  status?: string;
  /** 零卡片/部分失败时的告警（`W_NO_CARDS` 带**模型自己的解释** `model_note`，可直接给学生看） */
  warnings?: unknown[];
  usedProvider?: string;
  degradedFrom?: string;
  degradedReason?: string;
  /**
   * ★ **实测**的结构化输出模式（来自 provider 降级链的回执）：
   * `'strict'` = 端点接受严格 schema；`'lenient'` = 端点拒绝 → 已回落裸 schema。
   * 上游写进 `meta.structured_output_mode`（可观测：网关恢复/退化看得见）。
   */
  structuredOutputMode?: 'strict' | 'lenient';
  stats: {
    /** worker pick 出来的 item 数（全量 PDF 实测 1905，不是单元数 2523） */
    items: number;
    llmCalls: number;
    llmFailures: number;
    /** worker convert 自报的错误数 */
    errorCount: number;
    ok: boolean;
    unitsDone: number;
    pick?: Record<string, unknown>;
    skippedUnits?: number;
    /** ★ 真正发 LLM 的 item 数（= plan items − 空正文跳过） */
    itemsRunnable?: number;
    /** ★ 因**正文为空**跳过 LLM 的单元数（单元保留在层级树里，未删除） */
    itemsSkippedEmpty?: number;
    /** ★ 被跳过的单元 id 列表（如实上报，便于排查"为什么这篇没出卡片"） */
    skippedEmptyUnitIds?: string[];
    // ── ★ 长文本分块（坑 24：`chunkChars` 从死旋钮变成真生效）────────────
    /** 分块后 plan 产出的**块级** item 数（= 预期 LLM 调用数） */
    chunksPlanned?: number;
    /** plan 的**单元**数（与 `chunksPlanned` 不等 ⟹ 发生了分块） */
    unitsPlanned?: number;
    /** 发生分块的单元数（`>0` 说明长文本被拆分而非截断） */
    chunkedUnits?: number;
    /** 单元内最大块数（诊断"有没有单元被切得很碎"） */
    maxChunksPerUnit?: number;
    /** worker convert 侧自报的块总数（与 plan 对账，不一致 = key 匹配出问题） */
    chunksTotal?: number;
    /** worker convert 侧真正处理完的块数 */
    chunksDone?: number;
    /** 本次生效的分块阈值（字符）—— 让"死旋钮"变成可观测的真值 */
    chunkChars?: number;
    errorMessages?: string[];
  };
}

export interface ExtractorAvailability {
  ok: boolean;
  reason: string;
  enumsOk?: boolean;
}

export interface Extractor {
  readonly name: string;
  /** 是否可用。**必须真探测**（PROVIDERS §0 R2），不能只看"配了 key"。 */
  available(): Promise<ExtractorAvailability>;
  /**
   * **文档级**抽取：worker 的 pick 是文档级决策，逐单元调用会与它选出的单元集不一致。
   */
  extractDocument(req: ExtractDocumentRequest): Promise<ExtractDocumentResult>;
}

// ═══════════════════════════════════════════════════════════════════════
// worker + provider 组合实现（A1）
// ═══════════════════════════════════════════════════════════════════════

/**
 * ★ **抽取的结构化输出预算**（8192）。
 *
 * 为什么是 8192 而不是 4096：端点是**推理模型**，推理 token **计入 `max_tokens`**
 * （实测 8 字回复用 54 reasoning token）；一个单元要产出多张卡片的 JSON，
 * 4096 很容易被推理吃光 → 空 content / 截断 JSON（与 `PROBE_MAX_TOKENS` 的假绿同机制）。
 * worker 侧契约对结构化输出的建议是 ≥2000，这里是"结构化 + 推理开销"的取值。
 */
export const EXTRACT_MAX_TOKENS = 8192;

/**
 * ★ 长文本分块阈值（字符）的**单一默认值**。
 *
 * ⚠️ 与 worker 侧 `worker/pipeline/chunk.py::DEFAULT_CHUNK_CHARS` **必须一致**：
 * plan 与 convert 两次独立进程调用都按它分块，**两侧不同 → 块级 key 对不上
 * → 卡片被静默丢弃**（E_PICK_KEY）。改这里必须同步改 worker 侧（有测试对账）。
 */
export const DEFAULT_CHUNK_CHARS = 24_000;

export interface WorkerExtractorDeps {
  runner: WorkerRunnerWithRaw;
  completeJson: CompleteJsonFn;
  /** 抽取器可用性探测（真 LLM 探测；由组装方注入，结果自缓存） */
  probe?: () => Promise<{ ok: boolean; reason?: string }>;
  sourceName?: string;
  /** 契约 §5.1 的已验证常量：`MAX_PAGES_PER_UNIT = 8` */
  maxPages?: number;
  chunkChars?: number;
  /** provider 层要求 schema 带名字（实测 plan 给的是裸 schema） */
  schemaName?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];
}
function asString(v: unknown, dflt = ''): string {
  return typeof v === 'string' ? v : dflt;
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string').map(String) : [];
}
function asNumber(v: unknown, dflt = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function normalizeSpan(v: unknown, fallbackKind = 'page'): Span {
  const o = asRecord(v);
  if (!o) return { kind: fallbackKind as Span['kind'], start: 0, end: 0 };
  const kindRaw = asString(o.kind, fallbackKind);
  const kind = (['page', 'slide', 'time', 'char'] as const).includes(kindRaw as Span['kind'])
    ? (kindRaw as Span['kind'])
    : (fallbackKind as Span['kind']);
  const start = asNumber(o.start);
  const end = asNumber(o.end, start);
  return { kind, start, end: end < start ? start : end };
}

export function createWorkerExtractor(deps: WorkerExtractorDeps): Extractor {
  const maxPages = deps.maxPages ?? 8;
  const schemaName = deps.schemaName ?? 'knowledge_cards';
  /**
   * ★ 生效的分块阈值（坑 24：`chunkChars` 原先是**死旋钮** ——
   * `WorkerExtractorDeps.chunkChars` 只被 plan 读了一次，而 worker 侧真正用的是
   * 自己的默认 24_000；现在**plan 与 convert 都传同一个值**，且默认值下沉到一处）。
   */
  const chunkCharsEffective = Math.max(1_000, Math.trunc(deps.chunkChars ?? DEFAULT_CHUNK_CHARS));

  return {
    name: 'worker-plan-convert',

    async available(): Promise<ExtractorAvailability> {
      if (deps.probe) {
        const p = await deps.probe();
        return { ok: p.ok, reason: p.reason ?? '' };
      }
      return { ok: true, reason: '' };
    },

    async extractDocument(req: ExtractDocumentRequest): Promise<ExtractDocumentResult> {
      if (req.units.length === 0) {
        return {
          cards: [],
          entities: [],
          edges: [],
          sections: {},
          stats: { items: 0, llmCalls: 0, llmFailures: 0, errorCount: 0, ok: true, unitsDone: 0 },
        };
      }

      // ── ① plan：worker 产出提示词 + schema（★ 必须传完整 units）────────
      req.onProgress?.({ stage: 'plan', done: 0, total: 0 });
      const planRun = await deps.runner.raw({
        job: 'extract.plan',
        input: {
          doc_id: req.docId,
          units: req.units,
          source_name: deps.sourceName ?? req.title ?? '课程资料',
          max_pages: maxPages,
          pages_total: req.pagesTotal ?? 0,
          // ★ 长文本分块阈值（不再是"死旋钮"：plan 与 convert 都传这个值）
          chunk_chars: chunkCharsEffective,
          ...(req.excludedRanges ? { excluded_ranges: req.excludedRanges } : {}),
          // ★ 断点续跑（模型热切换 `mode:"abort"` 依赖它）：
          //   契约 `worker/README.md` §7 —— `payload.checkpoint_file` + `resume:true`
          //   会**跳过已完成单元**。原实现没转发这两个字段 → "终止后 resume" 其实是
          //   **从头重跑**（静默重复计费，正是 spec 要避免的）。这里必须透传。
          ...(req.checkpointFile ? { checkpoint_file: req.checkpointFile } : {}),
          ...(req.resume ? { resume: true } : {}),
        },
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.onEvent ? { onEvent: req.onEvent } : {}),
      });
      if (!planRun.ok || !planRun.result) {
        throw new ApiError('E_WORKER', `extract.plan 失败：${planRun.error?.msg ?? '未知原因'}`, {
          ...(planRun.error?.detail ? { detail: planRun.error.detail } : {}),
          hint: 'worker 负责提示词与单元挑选；确认 worker/cli.py 可用',
        });
      }
      const plan = planRun.result as Record<string, unknown>;
      const rawSchema = asRecord(plan.schema);
      if (!rawSchema) {
        throw new ApiError('E_WORKER_PROTOCOL', 'extract.plan 未返回 schema', {
          detail: `keys=${Object.keys(plan).join(',')}`,
          hint: 'worker 版本可能过旧',
        });
      }
      let items = asArray(plan.items);
      if (req.limit && req.limit > 0) items = items.slice(0, req.limit);

      if (items.length === 0) {
        // worker 的 pick 全跳过 → 如实报 0（这是"确实没有可抽单元"，不是失败）
        return {
          cards: [],
          entities: [],
          edges: [],
          sections: {},
          stats: {
            items: 0,
            llmCalls: 0,
            llmFailures: 0,
            errorCount: 0,
            ok: true,
            unitsDone: 0,
            pick: asRecord(plan.pick) ?? {},
            skippedUnits: asNumber(plan.skipped_units, 0),
          },
        };
      }

      // ═══════════════════════════════════════════════════════════════════
      // ★★ (a) **单元级**空正文闸门（文档级 text_gate **抓不到**"个别单元为空"）
      //
      // 真实缺陷（Lead 真库实测 doc_ec5a4ce88038，328 字符 markdown）：
      //   第一次 parse → cards=3；★ **reparse → cards=0**（越修越糟）。
      // 根因链：markdown `# 数据库索引` **紧跟** `## 聚簇索引` → 顶层标题**没有自己的正文**
      //   → `unit.text=''`（title 有值）→ 把**空正文**发给 LLM → 上游 **HTTP 400**
      //   → extract_status="partial" → **整个抽取 0 卡片** → 上层全量替换 cards → 旧卡片被清。
      // 全库规模：单元 2873 中**空正文 238（8%）**（扫描件 167 全空；434 页教材 69 空，集中在 L3 标题）。
      //
      // ★★ 关键：**单元不删** —— 空正文的标题单元是 **Wiki 层级树的骨架**，
      //    这里只是"不发空正文给模型"，**不是**"删单元"。
      // ★★ 不许静默跳过：跳过数 + 单元 id 走 `warnings`（`W_EMPTY_INPUT`）→
      //    上层把它写进 `meta.extract_warnings`（handlers.ts 已有该通道），前端可如实显示。
      // ═══════════════════════════════════════════════════════════════════
      const textById = new Map<string, string>();
      const textByOrd = new Map<number, string>();
      const titleById = new Map<string, string>();
      const titleByOrd = new Map<number, string>();
      for (const u of req.units) {
        textById.set(u.id, u.text ?? '');
        textByOrd.set(u.ord, u.text ?? '');
        titleById.set(u.id, u.title ?? '');
        titleByOrd.set(u.ord, u.title ?? '');
      }
      const runnableItems: Record<string, unknown>[] = [];
      const emptySkipped: { unitId: string; title: string; key: string; ord: number }[] = [];
      for (const item of items) {
        const it = item as Record<string, unknown>;
        const key = asString(it.key) || asString(it.unit_key) || asString(it.unit_id);
        const unitId = asString(it.unit_id) || key.split('#')[0] || '';
        const ord = asNumber(it.unit_ord, Number.NaN);
        const known = textById.has(unitId) || (Number.isFinite(ord) && textByOrd.has(ord));
        const text = textById.get(unitId) ?? (Number.isFinite(ord) ? textByOrd.get(ord) : undefined) ?? '';
        // ⚠️ 只有**能证明**正文为空时才跳过（known=false 时**放行**）——
        //    否则"查不到正文"会变成"静默丢单元"，那是更坏的一类 bug。
        if (known && text.trim() === '') {
          emptySkipped.push({
            unitId,
            title: titleById.get(unitId) ?? (Number.isFinite(ord) ? titleByOrd.get(ord) : undefined) ?? '',
            key,
            ord: Number.isFinite(ord) ? ord : -1,
          });
          continue;
        }
        runnableItems.push(it);
      }
      const emptyWarnings = emptySkipped.map((s) => ({
        code: 'W_EMPTY_INPUT',
        unit_id: s.unitId,
        title: s.title,
        key: s.key,
        skipped_units: emptySkipped.length,
        unit_ids: emptySkipped.map((x) => x.unitId),
        msg:
          `该单元正文为空（标题单元通常没有自己的正文）→ **未调用 LLM**（不再产生 E_LLM: HTTP 400）；` +
          `单元**保留**在层级树里（未删除）。本文档共 ${emptySkipped.length} 个空正文单元。`,
      }));
      if (runnableItems.length === 0) {
        // 全空 → 不调 LLM（否则就是拿空正文去换 400）。**抛错**而不是"返回 0 卡片"：
        // 返回 0 卡片会被上层全量替换 → **清掉旧卡片**（"越修越糟"）。抛错则上层不动产物。
        // ⚠️ 码用 `E_BADREQUEST`（400，**封闭错误码集合**成员，见 `store/errors.ts`）：
        //    "输入里没有任何可抽取的正文"属输入不合法，**不是**模型故障 ——
        //    原先这里产生 `E_LLM: HTTP 400`，会被误读成"模型有问题"。
        throw new ApiError('E_BADREQUEST', `全部 ${items.length} 个单元正文为空 → 未调用 LLM（单元保留）`, {
          detail: `skipped_empty_units=${emptySkipped.length}; unit_ids=${emptySkipped.map((s) => s.unitId).join(',')}`,
          hint: '文档级闸门（text_gate=empty_body）本应先挡住；若这是重跑，上次的卡片/图谱会**保留不动**',
        });
      }

      // ── ② 逐个 item 调 LLM（**并发 = 1**，契约 C1）───────────────────
      const payloads: { key: string; data: unknown }[] = [];
      const failureMessages: string[] = [];
      let usedProvider = '';
      let degradedFrom = '';
      let degradedReason = '';
      /** ★ 实测的结构化输出模式（strict=端点接受严格 schema / lenient=回落裸 schema） */
      let structuredOutputMode: 'strict' | 'lenient' | undefined;

      for (let i = 0; i < runnableItems.length; i += 1) {
        const item = runnableItems[i] as Record<string, unknown>;
        if (req.signal?.aborted) break;
        const key = asString(item.key) || asString(item.unit_key) || asString(item.unit_id);
        const system = asString(item.system);
        const user = asString(item.user);
        try {
          const res = await deps.completeJson({
            messages: [
              ...(system ? [{ role: 'system' as const, content: system }] : []),
              { role: 'user' as const, content: user },
            ],
            // ★ plan 给的是裸 schema → 补 name（provider 层要 {name, schema}）
            schema: { name: schemaName, schema: rawSchema },
            temperature: 0,
            /**
             * ★ **显式传输出预算**（坑 24：`maxTokens` 原先"只有声明、没有调用方" → 抽取恒用 provider 默认 4096）。
             *
             * 为什么必须显式且要大：本端点是**推理模型**，**推理 token 计入 `max_tokens`**
             * （实测 8 字回复用 54 reasoning token）→ 长单元的结构化输出（多张卡片 JSON）
             * 在 4096 下很容易被推理吃光 → 空 content / 截断 JSON。
             * 与 `PROBE_MAX_TOKENS` 的假绿是**同一机制**（预算被推理吃光）。
             */
            maxTokens: EXTRACT_MAX_TOKENS,
            ...(req.signal ? { signal: req.signal } : {}),
          });
          payloads.push({ key, data: res.data });
          if (res.usedProvider) usedProvider = res.usedProvider;
          /**
           * ★ 记录**实测**的结构化输出模式（strict / lenient）→ 写进 meta。
           * 为什么要记：端点对严格 schema **时好时坏**（实测同一端点 200/400 都出现过），
           * 记下来才能看见"网关恢复（strict 命中率上升）/退化（掉到 lenient）"——
           * **可观测，不是猜的**（坑 21：抓了但没上报 = 等于没抓）。
           */
          if (res.structuredOutputMode) structuredOutputMode = res.structuredOutputMode;
          if (res.degradedFrom) {
            degradedFrom = res.degradedFrom;
            degradedReason = res.degradedReason ?? '';
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          /**
           * ★ 把 provider 的 `detail` 一起留下 —— 它常含**模型原文**。
           *
           * 现场教训（Lead 报的卡点）：任务 error 只有 `E_LLM: amr 返回非 JSON`，
           * **看不到模型到底返回了什么**（散文？markdown 包裹的 JSON？被截断的半截 JSON？）→ 排查只能靠猜。
           * 而 provider **已经抓到了**原文：`providers/llm/openai_compatible.ts` 的
           * `new ProviderError('E_LLM', '…返回非 JSON', '模型未遵守 json_schema', raw.slice(0, 500))`
           * —— 第 4 个参数就是原文，**只是这里聚合失败信息时被丢掉了**。
           * ⚠️ 截断 240 字符：够判断形态，又不让任务 detail 膨胀。
           * ⚠️ 模型输出是外部文本 → 只进 `detail`（排查用），不进用户可见的 `msg`。
           */
          const detail = err instanceof Error ? String((err as { detail?: unknown }).detail ?? '') : '';
          const rawHint = detail ? ` raw=${JSON.stringify(detail.slice(0, 240))}` : '';
          if (failureMessages.length < 5) {
            failureMessages.push(`item ${i + 1}(${key.slice(0, 40)}): ${msg}${rawHint}`);
          }
        }
        req.onProgress?.({ stage: 'extract', done: i + 1, total: runnableItems.length });
      }

      // ⚠️ 全部 LLM 调用失败 → **绝不能**继续走 convert 然后报"0 张卡片算成功"
      if (payloads.length === 0) {
        throw new ApiError('E_LLM', `LLM 调用全部失败（${runnableItems.length} 个 item 无一成功）`, {
          ...(failureMessages.length > 0 ? { detail: failureMessages.join(' | ') } : {}),
          hint: '检查 LLM 凭据/额度；或稍后重试（provider 层有降级链）',
        });
      }

      // ── ③ convert：worker 校验 + 转卡片/实体/边 ──────────────────────
      req.onProgress?.({ stage: 'convert', done: payloads.length, total: runnableItems.length });
      const convRun = await deps.runner.raw({
        job: 'extract.convert',
        input: {
          doc_id: req.docId,
          units: req.units,
          payloads,
          max_pages: maxPages,
          pages_total: req.pagesTotal ?? 0,
          // ★ 与 plan **同一个** chunk_chars（否则块级 key 对不上 → 卡片全丢）
          chunk_chars: chunkCharsEffective,
          ...(req.excludedRanges ? { excluded_ranges: req.excludedRanges } : {}),
          ...(req.checkpointFile ? { checkpoint_file: req.checkpointFile } : {}),
          ...(req.resume ? { resume: true } : {}),
        },
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.onEvent ? { onEvent: req.onEvent } : {}),
      });
      // worker 在"有 payload 但一条都没匹配上"时 **exit 1** → 如实报错，不静默当作 0 卡片
      if (!convRun.ok || !convRun.result) {
        // ⚠️ worker 自报的 `E_PICK_KEY` **不新增对外错误码**（契约 §8 是封闭集合），
        // 统一归到 `E_LLM_SCHEMA`（502），但把 worker 的原始 code 留在 detail 里不丢信息。
        throw new ApiError('E_LLM_SCHEMA', `extract.convert 失败：${convRun.error?.msg ?? '未知原因'}`, {
          detail: `worker_code=${convRun.error?.code ?? 'unknown'}${convRun.error?.detail ? `; ${convRun.error.detail}` : ''}`,
          hint: '模型输出的 key 与 plan 不一致，或输出不符合 schema',
        });
      }
      const conv = convRun.result as Record<string, unknown>;

      // ── ④ 映射成入库 draft（字段名与 worker 的 to_dict 对齐）──────────
      const cards: CardDraft[] = asArray(conv.cards).map((c) => ({
        unit_id: asString(c.unit_id),
        name: asString(c.name),
        kind: asString(c.kind, 'other'),
        one_line: asString(c.one_line),
        purpose: asString(c.purpose),
        usage_mode: asString(c.usage_mode, 'unknown'),
        operational_role: asString(c.operational_role, 'unknown'),
        lifecycle: asString(c.lifecycle, 'unknown'),
        example: typeof c.example === 'string' ? c.example : null,
        example_explained: typeof c.example_explained === 'string' ? c.example_explained : null,
        prerequisites: asStringArray(c.prerequisites),
        cautions: asStringArray(c.cautions),
        evidence_quote: asString(c.evidence_quote),
        evidence_span: normalizeSpan(c.evidence_span),
        confidence: asNumber(c.confidence, 0),
      }));

      const rawEntities = asArray(conv.entities);
      const entities: EntityDraft[] = rawEntities.map((e) => ({
        name: asString(e.name),
        name_zh: asString(e.name_zh),
        type: asString(e.type, 'concept'),
        layer: asString(e.layer, 'L1'),
      }));

      // worker 的边用**实体 id**（src/dst）；我的 store 按 name_key 归并，故先映射回名字
      const nameById = new Map(rawEntities.map((e) => [asString(e.id), asString(e.name)]));
      const edges: EdgeDraft[] = asArray(conv.edges)
        .map((e) => ({
          src: nameById.get(asString(e.src)) ?? asString(e.src),
          dst: nameById.get(asString(e.dst)) ?? asString(e.dst),
          etype: asString(e.etype, 'DEPENDS_ON'),
          evidence_text: asString(e.evidence),
          span: normalizeSpan(e.span),
          confidence: asNumber(e.confidence, 0),
          flagged: e.flagged === true,
        }))
        .filter((e) => e.src && e.dst && e.src !== e.dst);

      const sections: Record<string, SectionSummary> = {};
      for (const [unitId, raw] of Object.entries(asRecord(conv.sections) ?? {})) {
        const s = asRecord(raw);
        if (s && asString(s.section_summary)) {
          sections[unitId] = {
            section_summary: asString(s.section_summary),
            learning_objectives: asStringArray(s.learning_objectives),
            section_role: asString(s.section_role),
            key_takeaways: asStringArray(s.key_takeaways),
          };
        }
      }

      const convStats = asRecord(conv.stats) ?? {};
      const errorMessages = asArray(conv.errors)
        .map((e) => asString(e.msg))
        .filter(Boolean)
        .slice(0, 5);

      // ═══════════════════════════════════════════════════════════════════
      // ★★ (b) **零卡片 + 有失败 → 抛错**，让上层**不覆盖**上次的卡片/图谱（方案 B）
      //
      // 为什么用 (B) 而不是事务性替换 (A)：(A) 要"新产物入临时区再原子替换"，
      // 涉及 units/cards/entities/edges/xrefs **五张表 + 索引重建** —— 改面大、中途失败会留半套产物。
      // (B) 直接消除用户损失、改动小；(A) 留作后续增强（"先用最小改动消除用户损失，高风险改动推后"）。
      //
      // 判据（**只看"是否真的产出可用结果"**，不看"接口返回 200"）：
      //   · 有卡片 → 照常返回（partial 也是真进度，替换是对的）
      //   · 0 卡片 **且** 有失败（LLM 失败 / convert 报错 / worker 自报 failed）→ 抛错 → 上层不动产物
      //   · 0 卡片 **且无任何失败**（worker `done_empty`：内容确实没有知识点）→ 照常返回（替换是对的）
      // ⚠️ 必须放在 `errorMessages` 之后（tsc 抓到的"used before declaration"）。
      // ═══════════════════════════════════════════════════════════════════
      const convErrorCount = asNumber(conv.error_count, 0);
      const workerStatusNow = asString(conv.status);
      const llmFailCount = runnableItems.length - payloads.length;
      const looksFailed =
        failureMessages.length > 0 || convErrorCount > 0 || workerStatusNow === 'failed' || conv.ok === false;
      if (cards.length === 0 && looksFailed) {
        const reason =
          [...failureMessages, ...errorMessages].join(' | ') || `worker status=${workerStatusNow || 'unknown'}`;
        throw new ApiError(
          failureMessages.length > 0 ? 'E_LLM' : 'E_LLM_SCHEMA',
          `抽取未产出任何卡片（${reason.slice(0, 200)}）→ **不覆盖**上次抽取结果`,
          {
            detail:
              `worker_status=${workerStatusNow || 'unknown'}; error_count=${convErrorCount}; ` +
              `llm_failures=${llmFailCount}; items=${runnableItems.length}; skipped_empty=${emptySkipped.length}`,
            hint: '上次的卡片/图谱保持不动（避免"重跑失败反而清空"）；修好后可再跑一次',
          },
        );
      }

      return {
        cards,
        entities,
        edges,
        sections,
        // ★ 透传 worker 的批次状态与告警（`done_empty` 必须能被上层看见，不许当成功）
        ...(asString(conv.status) ? { status: asString(conv.status) } : {}),
        // ★ 空正文跳过（W_EMPTY_INPUT）与 worker 的告警（W_NO_CARDS 等）**都要带上**：
        //   前者是"我们跳过了什么"（不许静默），后者是"模型为什么不产出"
        ...(emptyWarnings.length > 0 || asArray(conv.warnings).length > 0
          ? { warnings: [...emptyWarnings, ...asArray(conv.warnings)] }
          : {}),
        ...(usedProvider ? { usedProvider } : {}),
        ...(degradedFrom ? { degradedFrom, degradedReason } : {}),
        // ★ **实测**的结构化输出模式（strict / lenient）→ handler 写进 meta：
        //   端点对严格 schema 时好时坏，记下来才看得见"网关恢复/退化"（可观测，不是猜的）。
        ...(structuredOutputMode ? { structuredOutputMode } : {}),
        stats: {
          items: items.length,
          // ★ 新增：真正发 LLM 的 item 数 / 空正文跳过数（+ id 列表）—— 判据要能对账
          itemsRunnable: runnableItems.length,
          itemsSkippedEmpty: emptySkipped.length,
          skippedEmptyUnitIds: emptySkipped.map((s) => s.unitId),
          llmCalls: payloads.length,
          llmFailures: runnableItems.length - payloads.length,
          errorCount: asNumber(conv.error_count, 0),
          ok: conv.ok === true,
          unitsDone: asNumber(convStats.units_done, 0),
          pick: asRecord(plan.pick) ?? {},
          skippedUnits: asNumber(plan.skipped_units, 0),
          // ★★ 长文本分块（坑 24：`chunkChars` 从"死旋钮"变成"真生效"）——
          //    `items` 是**块级**清单（长单元 → 多块 → 多次调用）。
          //    `unitsPlanned` 是单元数；两者不等 说明发生了分块（`chunkedUnits` > 0）。
          //    ⚠️ 代价必须可见：`llmCalls`（= payloads.length）就是**真实调用数**。
          chunksPlanned: asNumber(plan.chunks, 0),
          unitsPlanned: asNumber(plan.units_planned, 0),
          chunkedUnits: asNumber(plan.chunked_units, 0),
          maxChunksPerUnit: asNumber(plan.max_chunks_per_unit, 0),
          // worker convert 侧自报的块计数（与 plan 对账：不一致说明 key 匹配出了问题）
          chunksTotal: asNumber(convStats.chunks_total, 0),
          chunksDone: asNumber(convStats.chunks_done, 0),
          chunkChars: chunkCharsEffective,
          ...(errorMessages.length > 0 || failureMessages.length > 0
            ? { errorMessages: [...failureMessages, ...errorMessages] }
            : {}),
        },
      };
    },
  };
}
