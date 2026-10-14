/**
 * 任务处理器（把 API 层与 worker/provider/sqlite 串起来）。
 *
 * ## v2 的职责切分（ARCHITECTURE_V2 §3）
 * ```text
 * worker (Python)  : parse   —— PDF/PPTX/DOCX/TXT → units + 文档 meta（成熟库不可替代）
 * Node (本文件)     : extract —— units → cards/entities/edges（LLM 调用归 Node，凭据不下发子进程）
 *                    index   —— bigram 检索索引
 * worker (Python)  : asr/video/slides/mindmap —— 音视频转写（faster-whisper）
 * ```
 *
 * ## 诚实降级（契约 §5.1 + PROVIDERS §0）—— **"未抽取" ≠ "抽取了但没结果"**
 * - worker 不可用 → 任务 `failed` + 可读 `error`（**不假装解析成功**）
 * - LLM 不可用 → units 照常入库，文档 meta 写 `extract_status='unavailable'` + `extract_error`，
 *   任务 detail **没有 `extract` 段**，且 `POST /documents/:id/extract` 会**如实 503**。
 *   前端据此显示"未抽取卡片"，而不是把空卡片列表当成功。
 * - 单单元抽取失败 → 已成功的部分照常入库，`extract_status='failed'` + `failures` 如实记录
 *   （长任务断点友好，契约 C4）。
 */

import path from 'node:path';

import type { ServerConfig } from '../config.ts';
import { ApiError } from '../store/errors.ts';
import type { Db } from '../store/db.ts';
import type { CardDraft, EdgeDraft, EntityDraft, Repo, UnitDraft, UnitApi } from '../store/repo.ts';
import { unitToApi } from '../store/repo.ts';
import { indexDocument } from '../store/search.ts';
import { applyXrefs } from '../store/xref.ts';
import { enumsComplete, type SchemaEnums } from '../store/schema-enums.ts';
import type { Span } from '../store/types.ts';
import type { WorkerRunnerWithRaw } from '../worker/runner.ts';
import type { WorkerEvent } from '../worker/protocol.ts';
import type { TaskHandler, TaskHandlerContext } from './queue.ts';
import type { Extractor, CompleteJsonFn } from './extract.ts';

/** 单个抽取窗口的字符预算（v1 用的同一量级；超长单元必须切窗，否则丢内容 —— 坑 5）。 */
export const MAX_EXTRACT_CHARS = 8000;

/** 文档 meta 里的抽取状态（REST 层可观测）。 */
export const EXTRACT_STATUS = {
  /** 从未抽取 */
  none: 'none',
  running: 'running',
  done: 'done',
  /**
   * ★ 全部成功但**零卡片**（内容不足）—— 后端 core 新增的 `status:"done_empty"`。
   *
   * 为什么必须单列：真链路实测过"`task.status=done`、`llm_calls=1`、`llm_failures=0`、`cards=0`"，
   * 调用方**无法分辨**"内容不足 / 输出不合规 / 管线丢卡"。若把它当 `done`，
   * 前端会显示"已抽取 0 张卡片"——**看起来成功、其实什么都没产出**。
   * 前端应显示"本节内容不足以生成卡片"（并展示模型给的 `model_note`）。
   */
  done_empty: 'done_empty',
  /** 部分成功（有卡片也有失败） */
  partial: 'partial',
  failed: 'failed',
  /** 抽取能力不可用（**不是**"抽取了但没结果"） */
  unavailable: 'unavailable',
} as const;
export type ExtractStatusValue = (typeof EXTRACT_STATUS)[keyof typeof EXTRACT_STATUS];

export interface ExtractAvailability {
  ok: boolean;
  reason: string;
}

export interface PipelineDeps {
  repo: Repo;
  db: Db;
  cfg: ServerConfig;
  runner: WorkerRunnerWithRaw;
  /** null = 没有可用的抽取器（如实降级，不假装抽了卡片） */
  extractor: Extractor | null;
  /**
   * LLM 结构化输出（**A1**：提示词/schema 都来自 worker，这里只负责"调模型"）。
   * `null` = provider 层不可用 → 需要 LLM 的任务（extract/rollup/translate）如实降级。
   */
  completeJson?: CompleteJsonFn | null;
  enums: SchemaEnums;
  /**
   * 真探测抽取器可用性（真 LLM 探测，结果缓存）。每次入队前都问一次，
   * 便于"额度刚恢复"的场景：用户手动重试即可生效。
   */
  resolveExtractorAvailability?: () => Promise<ExtractAvailability>;
  /** 上传后是否自动抽取（默认 true；大文档只想先解析时可关） */
  autoExtractOnParse?: boolean;
}

interface ParsedUnit {
  ord: number;
  title: string;
  level: number;
  parent_ord: number | null;
  parent_id: string | null;
  span: Span;
  text: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asStr(v: unknown, dflt = ''): string {
  return typeof v === 'string' ? v : dflt;
}
function asNum(v: unknown, dflt = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function asNumArray(v: unknown): number[] {
  return Array.isArray(v) ? v.map((x) => Number(x)).filter((n) => Number.isFinite(n)) : [];
}

function normalizeSpan(v: unknown, fallbackKind = 'page'): Span {
  const o = asRecord(v);
  if (!o) return { kind: fallbackKind as Span['kind'], start: 0, end: 0 };
  const kindRaw = asStr(o.kind, fallbackKind);
  const kind = (['page', 'slide', 'time', 'char'] as const).includes(kindRaw as Span['kind'])
    ? (kindRaw as Span['kind'])
    : (fallbackKind as Span['kind']);
  const start = asNum(o.start);
  const end = asNum(o.end, start);
  return { kind, start, end: end < start ? start : end };
}

/** worker `result.data.units[]` → 入库 draft（用 `ord`/`parent_ord`，与契约 §4 UnitDraft 一致）。 */
export function normalizeUnits(raw: unknown): ParsedUnit[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedUnit[] = [];
  raw.forEach((item, idx) => {
    const o = asRecord(item);
    if (!o) return;
    const parentOrdRaw = o.parent_ord === null || o.parent_ord === undefined ? null : asNum(o.parent_ord, -1);
    out.push({
      ord: asNum(o.ord, idx + 1),
      title: asStr(o.title),
      level: asNum(o.level, 1),
      parent_ord: parentOrdRaw === null || parentOrdRaw < 0 ? null : parentOrdRaw,
      parent_id: typeof o.parent_id === 'string' ? o.parent_id : null,
      span: normalizeSpan(o.span),
      text: asStr(o.text),
    });
  });
  return out.sort((a, b) => a.ord - b.ord);
}

/** 把单元正文切成窗口（超长不切会丢内容 —— 坑 5 的 char span 版）。 */
export function windowUnit(
  unit: UnitApi,
  maxChars = MAX_EXTRACT_CHARS,
): { text: string; part: number; total: number }[] {
  const text = unit.text ?? '';
  if (text.length <= maxChars) return [{ text, part: 1, total: 1 }];
  const parts: { text: string; part: number; total: number }[] = [];
  const total = Math.ceil(text.length / maxChars);
  for (let i = 0; i < total; i += 1) {
    parts.push({ text: text.slice(i * maxChars, (i + 1) * maxChars), part: i + 1, total });
  }
  return parts;
}

export function createHandlers(deps: PipelineDeps): Record<string, TaskHandler> {
  const { repo, db, cfg, runner } = deps;
  const autoExtract = deps.autoExtractOnParse ?? true;

  const availability = async (): Promise<ExtractAvailability> => {
    if (deps.resolveExtractorAvailability) return deps.resolveExtractorAvailability();
    return { ok: Boolean(deps.extractor), reason: deps.extractor ? '' : '未初始化抽取器' };
  };

  /**
   * 抽取实现 —— `parse` 的自动阶段与独立 `extract` 任务**共用同一段代码**，
   * 避免"两条路径行为不一致"这种最难查的 bug。
   */
  const runExtraction = async (
    ctx: TaskHandlerContext,
    docId: string,
    opts: { unitOrdWhitelist?: number[]; limit?: number; baseFrac: number; spanFrac: number },
  ): Promise<{ ok: boolean; unavailableReason?: string; detail: Record<string, unknown> }> => {
    const av = await availability();
    const enumsOk = enumsComplete(deps.enums);

    if (!deps.extractor || !av.ok || !enumsOk) {
      const reason = [
        av.reason || '抽取器不可用',
        ...(enumsOk
          ? []
          : deps.enums.warnings.length > 0
            ? deps.enums.warnings
            : ['封闭枚举未加载（schema/ 缺失）']),
      ]
        .filter(Boolean)
        .join('；');
      // ★ 关键：如实标注"未抽取"，而不是留下空卡片列表让人以为"抽了但没结果"
      repo.mergeDocumentMeta(docId, {
        extract_status: EXTRACT_STATUS.unavailable,
        extract_error: reason,
        extract_checked_at: Date.now(),
      });
      return { ok: false, unavailableReason: reason, detail: { llm_configured: false, note: reason } };
    }

    repo.mergeDocumentMeta(docId, {
      extract_status: EXTRACT_STATUS.running,
      extract_error: '',
      extract_started_at: Date.now(),
    });

    let unitRows = repo.allUnitRows(docId);
    if (opts.unitOrdWhitelist && opts.unitOrdWhitelist.length > 0) {
      const allow = new Set(opts.unitOrdWhitelist);
      unitRows = unitRows.filter((u) => allow.has(u.ord));
    }
    // ⚠️ A1：**必须传完整 units**（worker 要先建层次树再挑单元；截断会导致 items=0）。
    //    所以这里**不**做 `limit` 截断 —— 小样本由 worker 侧的 pick/item 决定，
    //    `limit` 只在 `extractDocument` 里对 **item** 生效。
    const units = unitRows.map((u) => ({
      id: u.id,
      ord: u.ord,
      title: u.title,
      level: u.level,
      parent_id: u.parent_id,
      span: { kind: u.span_kind as Span['kind'], start: u.span_start, end: u.span_end },
      text: u.text ?? '',
    }));

    let result;
    try {
      result = await deps.extractor.extractDocument({
        docId,
        units,
        ...(repo.getDocumentRow(docId)?.title ? { title: String(repo.getDocumentRow(docId)?.title) } : {}),
        pagesTotal: repo.getDocumentRow(docId)?.page_count ?? 0,
        // ★ 断点续跑透传（模型热切换 `mode:"abort"`：存断点 → 终止 → 换模型 → **跳过已完成单元**）
        //   契约名见 `worker/README.md` §7：`checkpoint_file` + `resume`
        ...(typeof ctx.params.checkpoint_file === 'string' && ctx.params.checkpoint_file
          ? { checkpointFile: ctx.params.checkpoint_file }
          : {}),
        ...(ctx.params.resume === true ? { resume: true } : {}),
        ...(opts.limit && opts.limit > 0 ? { limit: opts.limit } : {}),
        signal: ctx.signal,
        onProgress: ({ stage, done, total }) => {
          const frac = total > 0 ? done / total : 0;
          const label = stage === 'plan' ? '规划抽取单元' : stage === 'convert' ? '校验并转换卡片' : '抽取知识卡片';
          ctx.progress(opts.baseFrac + frac * opts.spanFrac, `${label} ${done}/${total}`, { done, total });
        },
        onEvent: (e) => {
          const ev = e as { type?: string; level?: string; msg?: string; frac?: number; stage?: string };
          if (ev.type === 'log') ctx.log(String(ev.msg ?? ''), (ev.level as 'info' | 'warn' | 'error' | 'debug') ?? 'info');
          else if (ev.type === 'progress' && typeof ev.frac === 'number') {
            ctx.progress(opts.baseFrac + ev.frac * opts.spanFrac, String(ev.stage ?? '抽取中'));
          }
        },
      });
    } catch (err) {
      // 抽取整体失败 → **如实标注**，并把已解析的 units 保留（不假装抽过）
      const msg = err instanceof Error ? err.message : String(err);
      repo.mergeDocumentMeta(docId, {
        extract_status: EXTRACT_STATUS.failed,
        extract_error: msg,
        extract_done_at: Date.now(),
      });
      throw err;
    }

    const failures = result.stats.errorMessages ?? [];
    const graph = repo.replaceGraph(docId, result.entities, result.edges);
    repo.replaceCards(docId, result.cards);
    repo.mergeDocumentMeta(docId, { section_summaries: result.sections });
    const xr = applyXrefs(repo, docId);
    indexDocument(db, repo, docId);

    // worker convert 自报 ok=false（部分成功）→ 如实标 failed，但已转出的卡片照常入库
    //
    // ★ 三态区分（backend-core 新增 `status`/`warnings`，见 worker/README §6 与他们的通知）：
    //   - 有卡片 + 有失败 → `partial`（**不是** failed：已产出的卡片是有效的）
    //   - 全部成功但**零卡片** → `done_empty`（内容不足；**绝不能报 done**，
    //     否则前端显示"已抽取 0 张卡片"，看起来成功、实际什么都没产出）
    //   - 全失败 → `failed`
    //   - 否则 → `done`
    const workerStatus = typeof result.status === 'string' ? result.status : '';
    const cardCount = result.cards.length;
    const status =
      workerStatus === 'failed' || (failures.length > 0 && cardCount === 0 && result.stats.ok === false)
        ? EXTRACT_STATUS.failed
        : cardCount === 0 && failures.length === 0
          ? EXTRACT_STATUS.done_empty
          : failures.length > 0 || result.stats.ok === false || workerStatus === 'partial'
            ? EXTRACT_STATUS.partial
            : EXTRACT_STATUS.done;
    repo.mergeDocumentMeta(docId, {
      extract_status: status,
      extract_error: failures.join(' | '),
      extract_done_at: Date.now(),
      extract_used_provider: result.usedProvider ?? '',
      // 零卡片时把 worker 的告警（含**模型自己的解释** `model_note`）带给前端：
      // 学生/教师看到的是"本节内容不足以生成卡片：<模型原话>"，而不是一个空列表
      ...(Array.isArray(result.warnings) && result.warnings.length > 0
        ? { extract_warnings: result.warnings }
        : {}),
      ...(result.degradedFrom
        ? { extract_degraded_from: result.degradedFrom, extract_degraded_reason: result.degradedReason ?? '' }
        : {}),
    });

    const pick = result.stats.pick ?? {};
    return {
      ok: true,
      detail: {
        llm_configured: true,
        extract_status: status,
        // v1 兼容的嵌套形状（`detail.extract.*`），同时给几个扁平便利字段
        extract: {
          llm_calls: result.stats.llmCalls,
          llm_failures: result.stats.llmFailures,
          llm_configured: true,
          used_provider: result.usedProvider ?? '',
          ...(result.degradedFrom
            ? { degraded_from: result.degradedFrom, degraded_reason: result.degradedReason ?? '' }
            : {}),
          /** worker pick 出的 item 数（全量 PDF 实测 1905） */
          items: result.stats.items,
          pick,
          units_done: result.stats.unitsDone,
          error_count: result.stats.errorCount,
          cards: result.cards.length,
          entities: result.entities.length,
          edges: graph.edges,
          xrefs_total: xr.stats.total,
          section_summaries: Object.keys(result.sections).length,
          extract_status: status,
          ...(failures.length > 0 ? { failures } : {}),
        },
        cards: result.cards.length,
        entities: result.entities.length,
        edges: graph.edges,
        xrefs_total: xr.stats.total,
        ...(failures.length > 0 ? { failures } : {}),
      },
    };
  };

  /** `parse` —— 上传后的主流程：worker 解析 → units 入库 →（可选）自动抽取 → 索引。 */
  const parse: TaskHandler = async (ctx: TaskHandlerContext) => {
    const docId = ctx.docId;
    if (!docId) throw new ApiError('E_NOTFOUND', 'parse 任务缺少 doc_id', { hint: '上传时未关联文档' });
    const doc = repo.getDocumentRow(docId);
    if (!doc) throw new ApiError('E_NOTFOUND', `文档不存在：${docId}`);

    const absPath = path.isAbsolute(doc.source_path) ? doc.source_path : path.join(cfg.root, doc.source_path);

    ctx.progress(0.02, '解析文档');
    repo.updateDocument(docId, { status: 'parsing' });

    // ① worker parse（真实子进程；事件实时转 SSE 进度）
    let workerResult: Record<string, unknown>;
    try {
      workerResult = await runner({
        job: 'parse',
        input: { doc_id: docId, path: absPath, kind: doc.kind, root: cfg.root, data_dir: cfg.dataDir },
        signal: ctx.signal,
        timeoutMs: cfg.workerTimeoutMs,
        onEvent: (e) => {
          const ev = e as Partial<WorkerEvent> & { type?: string };
          if (ev.type === 'progress') {
            const frac = typeof ev.frac === 'number' ? ev.frac : 0;
            // worker 的 0→1 映射到任务的 0.02→0.55
            ctx.progress(0.02 + frac * 0.53, asStr(ev.stage, '解析中'), asRecord(ev.detail) ?? undefined);
          } else if (ev.type === 'log') {
            ctx.log(asStr(ev.msg), (ev.level as 'info' | 'warn' | 'error' | 'debug') ?? 'info');
          }
        },
      });
    } catch (err) {
      repo.updateDocument(docId, { status: 'failed' });
      repo.mergeDocumentMeta(docId, { parse_status: 'failed', parse_error: String(err) });
      throw err instanceof ApiError
        ? err
        : new ApiError('E_PARSE', `文档解析失败：${err instanceof Error ? err.message : String(err)}`, {
            hint: 'worker 负责解析；确认 worker/cli.py 可用且文件格式受支持',
          });
    }

    // ② units 入库
    const docInfo = asRecord(workerResult.document) ?? {};
    const rawUnits = normalizeUnits(workerResult.units);
    const drafts: UnitDraft[] = rawUnits.map((u) => ({
      ord: u.ord,
      title: u.title,
      level: u.level,
      parent_ord: u.parent_ord,
      parent_id: u.parent_id,
      span: u.span,
      text: u.text,
    }));
    const unitIds = repo.replaceUnits(docId, drafts);
    ctx.progress(0.58, '单元入库', { done: unitIds.length, total: unitIds.length });

    const stats = asRecord(workerResult.stats) ?? {};
    const parsedMeta = asRecord(docInfo.meta) ?? {};
    repo.updateDocument(docId, {
      title: asStr(docInfo.title, doc.title),
      page_count: asNum(docInfo.page_count, doc.page_count),
      lang: asStr(docInfo.lang, doc.lang),
      status: 'ready',
    });
    repo.mergeDocumentMeta(docId, {
      ...parsedMeta,
      parse_status: 'done',
      parse_mode: asStr(stats.parse_mode, 'unknown'),
      parse_units: unitIds.length,
    });

    // ③ 检索索引（units 先可搜）
    indexDocument(db, repo, docId);

    const detail: Record<string, unknown> = {
      units: unitIds.length,
      parse_mode: asStr(stats.parse_mode, 'unknown'),
      skipped_nodes: asNum(stats.skipped_nodes, 0),
      counts: { units: unitIds.length, cards: 0, entities: 0, edges: 0, xrefs: 0 },
      llm_configured: false,
    };

    // ④ 自动抽取（不可用时如实标注"未抽取"）
    if (!autoExtract) {
      detail.note = '自动抽取已关闭，请调用 POST /api/v1/documents/{id}/extract';
      ctx.progress(1, '完成（未抽取卡片）');
      return detail;
    }

    repo.updateDocument(docId, { status: 'extracting' });
    const ex = await runExtraction(ctx, docId, { baseFrac: 0.6, spanFrac: 0.3 });
    repo.updateDocument(docId, { status: 'ready' });
    ctx.progress(1, ex.ok ? '完成' : '完成（未抽取卡片）');

    Object.assign(detail, ex.detail);
    detail.extract_status = ex.detail.extract_status ?? EXTRACT_STATUS.unavailable;
    detail.counts = repo.counts(docId);
    return detail;
  };

  /**
   * `extract` —— **独立入口**（实测发现：上传只入 parse，若不自动抽取则卡片永远是 0）。
   * 支持只抽部分单元（小样本先跑），跑完照样重算图谱/交叉引用/检索索引。
   */
  const extract: TaskHandler = async (ctx) => {
    const docId = ctx.docId;
    if (!docId) throw new ApiError('E_NOTFOUND', 'extract 任务缺少 doc_id');
    if (!repo.getDocumentRow(docId)) throw new ApiError('E_NOTFOUND', `文档不存在：${docId}`);
    const nUnits = Number(db.scalar<number>('SELECT COUNT(*) FROM units WHERE doc_id = ?', docId) ?? 0);
    if (nUnits === 0) {
      throw new ApiError('E_PARSE', '该文档没有可抽取的单元，请先完成解析（parse）', {
        hint: 'POST /api/v1/documents 上传会自动排 parse；确认解析是否失败',
      });
    }

    const ords = asNumArray(ctx.params.units);
    const limit = asNum(ctx.params.limit, 0);
    repo.updateDocument(docId, { status: 'extracting' });
    const ex = await runExtraction(ctx, docId, {
      ...(ords.length > 0 ? { unitOrdWhitelist: ords } : {}),
      ...(limit > 0 ? { limit } : {}),
      baseFrac: 0.05,
      spanFrac: 0.9,
    });
    repo.updateDocument(docId, { status: 'ready' });
    ctx.progress(1, ex.ok ? '完成' : '完成（未抽取卡片）');

    if (!ex.ok) {
      // 能力不可用 → 任务**失败**并带可读 reason（路由层入队前已拦一次，这里是双保险）
      throw new ApiError('E_LLM', `抽取失败：${ex.unavailableReason ?? '抽取器不可用'}`, {
        ...(ex.unavailableReason ? { detail: ex.unavailableReason } : {}),
        hint: '配置 LLM 凭据（.env 的 AMR_KEY）后重试；或检查模型额度',
      });
    }
    return { ...ex.detail, counts: repo.counts(docId) };
  };

  /** `index` —— 只重建检索索引（幂等）。 */
  const index: TaskHandler = async (ctx) => {
    const docId = ctx.docId;
    if (!docId) throw new ApiError('E_NOTFOUND', 'index 任务缺少 doc_id');
    if (!repo.getDocumentRow(docId)) throw new ApiError('E_NOTFOUND', `文档不存在：${docId}`);
    ctx.progress(0.2, '重建检索索引');
    const out = indexDocument(db, repo, docId);
    ctx.progress(1, '完成');
    return { indexed: out };
  };

  /**
   * 视频/音频任务：交给 worker（faster-whisper 不可替代）。
   * worker 不可用时**如实失败**（契约 §8 `E_ASR_LOAD`），不产出假字幕。
   */
  const videoJob = (job: 'asr' | 'video' | 'slides' | 'mindmap'): TaskHandler => async (ctx) => {
    const docId = ctx.docId;
    if (!docId) throw new ApiError('E_NOTFOUND', `${job} 任务缺少 doc_id`);
    const doc = repo.getDocumentRow(docId);
    if (!doc) throw new ApiError('E_NOTFOUND', `文档不存在：${docId}`);
    const absPath = path.isAbsolute(doc.source_path) ? doc.source_path : path.join(cfg.root, doc.source_path);

    ctx.progress(0.05, '准备媒体处理');
    let result: Record<string, unknown>;
    try {
      result = await runner({
        job,
        input: {
          doc_id: docId,
          path: absPath,
          op: asStr(ctx.params.op, 'transcribe'),
          model: asStr(ctx.params.model, 'tiny'),
          language: asStr(ctx.params.language, ''),
          data_dir: cfg.dataDir,
        },
        signal: ctx.signal,
        timeoutMs: cfg.workerTimeoutMs,
        onEvent: (e) => {
          const ev = e as Partial<WorkerEvent> & { type?: string };
          if (ev.type === 'progress') {
            ctx.progress(0.05 + asNum(ev.frac) * 0.9, asStr(ev.stage, '媒体处理中'), asRecord(ev.detail) ?? undefined);
          } else if (ev.type === 'log') {
            ctx.log(asStr(ev.msg), (ev.level as 'info' | 'warn' | 'error' | 'debug') ?? 'info');
          }
        },
      });
    } catch (err) {
      throw err instanceof ApiError
        ? err
        : new ApiError('E_ASR_LOAD', `媒体处理失败：${err instanceof Error ? err.message : String(err)}`, {
            hint: '本地 ASR 依赖 faster-whisper；可改用更小的模型或配置云端 provider',
          });
    }

    repo.upsertVideoArtifact(docId, result);
    ctx.artifact('subtitle', `/api/v1/documents/${docId}/video/subtitle?fmt=srt`);
    ctx.progress(1, '完成');
    return {
      video: {
        duration_ms: asNum(result.duration_ms),
        segments: Array.isArray(result.segments) ? result.segments.length : 0,
      },
    };
  };

  return {
    parse,
    extract,
    index,
    asr: videoJob('asr'),
    video: videoJob('video'),
    slides: videoJob('slides'),
    mindmap: videoJob('mindmap'),
  };
}

/** 文档 meta 里的抽取状态（路由层读它做"未抽取 / 抽取失败 / 已抽取"表达）。 */
export function readExtractStatus(meta: Record<string, unknown>): {
  extract_status: ExtractStatusValue;
  extract_error: string;
  extract_done_at: number | null;
} {
  const raw = typeof meta.extract_status === 'string' ? meta.extract_status : '';
  const valid = (Object.values(EXTRACT_STATUS) as string[]).includes(raw);
  return {
    extract_status: (valid ? raw : EXTRACT_STATUS.none) as ExtractStatusValue,
    extract_error: typeof meta.extract_error === 'string' ? meta.extract_error : '',
    extract_done_at: typeof meta.extract_done_at === 'number' ? meta.extract_done_at : null,
  };
}
