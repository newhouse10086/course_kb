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
          ...(deps.chunkChars ? { chunk_chars: deps.chunkChars } : {}),
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

      // ── ② 逐个 item 调 LLM（**并发 = 1**，契约 C1）───────────────────
      const payloads: { key: string; data: unknown }[] = [];
      const failureMessages: string[] = [];
      let usedProvider = '';
      let degradedFrom = '';
      let degradedReason = '';

      for (let i = 0; i < items.length; i += 1) {
        const item = items[i] as Record<string, unknown>;
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
          if (res.degradedFrom) {
            degradedFrom = res.degradedFrom;
            degradedReason = res.degradedReason ?? '';
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (failureMessages.length < 5) failureMessages.push(`item ${i + 1}(${key.slice(0, 40)}): ${msg}`);
        }
        req.onProgress?.({ stage: 'extract', done: i + 1, total: items.length });
      }

      // ⚠️ 全部 LLM 调用失败 → **绝不能**继续走 convert 然后报"0 张卡片算成功"
      if (payloads.length === 0) {
        throw new ApiError('E_LLM', `LLM 调用全部失败（${items.length} 个 item 无一成功）`, {
          ...(failureMessages.length > 0 ? { detail: failureMessages.join(' | ') } : {}),
          hint: '检查 LLM 凭据/额度；或稍后重试（provider 层有降级链）',
        });
      }

      // ── ③ convert：worker 校验 + 转卡片/实体/边 ──────────────────────
      req.onProgress?.({ stage: 'convert', done: payloads.length, total: items.length });
      const convRun = await deps.runner.raw({
        job: 'extract.convert',
        input: {
          doc_id: req.docId,
          units: req.units,
          payloads,
          max_pages: maxPages,
          pages_total: req.pagesTotal ?? 0,
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

      return {
        cards,
        entities,
        edges,
        sections,
        // ★ 透传 worker 的批次状态与告警（`done_empty` 必须能被上层看见，不许当成功）
        ...(asString(conv.status) ? { status: asString(conv.status) } : {}),
        ...(asArray(conv.warnings).length > 0 ? { warnings: asArray(conv.warnings) } : {}),
        ...(usedProvider ? { usedProvider } : {}),
        ...(degradedFrom ? { degradedFrom, degradedReason } : {}),
        stats: {
          items: items.length,
          llmCalls: payloads.length,
          llmFailures: items.length - payloads.length,
          errorCount: asNumber(conv.error_count, 0),
          ok: conv.ok === true,
          unitsDone: asNumber(convStats.units_done, 0),
          pick: asRecord(plan.pick) ?? {},
          skippedUnits: asNumber(plan.skipped_units, 0),
          ...(errorMessages.length > 0 || failureMessages.length > 0
            ? { errorMessages: [...failureMessages, ...errorMessages] }
            : {}),
        },
      };
    },
  };
}
