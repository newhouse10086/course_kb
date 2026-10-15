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

import { createHash } from 'node:crypto';
import path from 'node:path';

import type { ServerConfig } from '../config.ts';
import { ApiError } from '../store/errors.ts';
import type { Db } from '../store/db.ts';
import type { CardDraft, EdgeDraft, EntityDraft, Repo, UnitDraft, UnitApi } from '../store/repo.ts';
import { unitToApi } from '../store/repo.ts';
import { indexDocument } from '../store/search.ts';
import { applyXrefs } from '../store/xref.ts';
import { autoExtractMaxUnits, estimateExtractMinutes } from './queue.ts';
import { enumsComplete, type SchemaEnums } from '../store/schema-enums.ts';
import type { Span } from '../store/types.ts';
import type { WorkerRunnerWithRaw } from '../worker/runner.ts';
import type { WorkerEvent } from '../worker/protocol.ts';
import type { TaskHandler, TaskHandlerContext } from './queue.ts';
import type { Extractor, CompleteJsonFn } from './extract.ts';
import { OPENROUTER_ASR_MODEL, createOpenRouterAsr } from '../providers/openrouter_audio.ts';

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
  /**
   * ★ **第三态**（坑 32）：真探测**还在进行中** —— 此时 `ok:true` 的含义是
   * "**允许尝试**（按轻量判据放行）"，**不是**"已验证可用"。
   *
   * 为什么必须有这一态：布尔值在"检测中"这个状态下**必然要说谎** ——
   * 说 `true` = 假装可用（坑 10）；说 `false` = 假装不可用（用户明明配好了却被拒）。
   *
   * ⚠️ 消费者必须**如实转述**它（给用户看"正在检测"），不许把它当成 `ready`。
   */
  detecting?: boolean;
  /** 探测已等待时长（ms）；仅 `detecting` 时有意义 —— 用来如实告知"在等什么、等了多久" */
  waitedMs?: number;
}

/**
 * ★★ 可用性解析器：**三态 + 后台探测 + 只探一次**（坑 32 的核心）。
 *
 * ## 修的是什么
 * 原来 `index.ts` 里是**惰性 await**：第一个抽取任务走到这里 → 真发一次 LLM 探测（**实测 67,986ms**）
 * → 用户看到"运行中"却**没有任何解释**，以为卡死。
 *
 * ## 现在的行为
 * - `warmUp()`：服务启动时**后台**开探（不阻塞任何请求）
 * - `current()`：**立即返回**，绝不 `await` 进行中的探测
 *   · 已知结果 → 返回真实结果
 *   · 探测中 → `{ok:true, detecting:true, waitedMs}`（放行 + 如实告知）
 * - 探测**只发一次**（进程内缓存）；失败**如实降级**（`ok:false + reason`），
 *   **绝不会因为"预热过了"就报可用**（反例判据）
 *
 * ## 兜底（不许静默）
 * `detecting` 期间放行的那次**真调用**若失败，错误由调用方**如实抛出/记录** ——
 * 见 `runExtraction` 的 detail 与任务失败原因。
 */
export function createAvailabilityResolver(opts: {
  /** 真探测（会真发一次网络/LLM 请求） */
  probe: () => Promise<{ ok: boolean; reason: string }>;
  /** 硬性不可用的同步判据（如"没有抽取器"/"枚举没加载"）—— 有值时**不探测**，直接如实降级 */
  hardUnavailable?: () => { ok: false; reason: string } | null;
  /** 探测结果回调（写日志/上报用；只回调一次） */
  onResolved?: (result: ExtractAvailability) => void;
  now?: () => number;
}): {
  current: () => Promise<ExtractAvailability>;
  warmUp: () => void;
  /** 测试/诊断：探测是否已开始/已完成 */
  state: () => 'idle' | 'detecting' | 'resolved';
  /** 测试用：等探测结束（生产**不要**用它阻塞请求） */
  settled: () => Promise<ExtractAvailability>;
} {
  const now = opts.now ?? ((): number => Date.now());
  let resolved: ExtractAvailability | null = null;
  let inflight: Promise<ExtractAvailability> | null = null;
  let startedAt = 0;

  const run = (): Promise<ExtractAvailability> => {
    if (inflight) return inflight;
    const hard = opts.hardUnavailable?.() ?? null;
    if (hard) {
      // 硬性不可用：不浪费一次真探测
      resolved = { ok: false, reason: hard.reason, detecting: false };
      opts.onResolved?.(resolved);
      return Promise.resolve(resolved);
    }
    startedAt = now();
    inflight = opts
      .probe()
      .then((r) => {
        resolved = { ok: r.ok, reason: r.reason || '', detecting: false };
        opts.onResolved?.(resolved);
        return resolved;
      })
      .catch((err: unknown) => {
        // ★ 探测抛异常 = **不可用**，不是"可用"（反例判据）
        resolved = {
          ok: false,
          reason: `LLM 可用性探测异常：${err instanceof Error ? err.message : String(err)}`,
          detecting: false,
        };
        opts.onResolved?.(resolved);
        return resolved;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    async current(): Promise<ExtractAvailability> {
      if (resolved) return resolved;
      // ★ 探测**在进行中** → 立即返回 `detecting`（这就是"预热"要保证的状态：生产 `main()` 启动即预热）
      if (inflight) {
        return { ok: true, reason: '', detecting: true, waitedMs: now() - startedAt };
      }
      // ⚠️ 没人预热过（测试/嵌入式用法）→ **只能等一次真探测**。
      //   故意保留这个语义：否则"抽取器不可用"的路由判据（503 + reason）会在第一次请求时失效
      //   —— 实测踩到：`★ 抽取器不可用 → 503 + 可读 reason，不排任务、不假装成功` 变红。
      //   生产路径不会走到这里（`main()` 已 `warmUp()`）。
      return run();
    },
    warmUp(): void {
      void run();
    },
    state(): 'idle' | 'detecting' | 'resolved' {
      if (resolved) return 'resolved';
      return inflight ? 'detecting' : 'idle';
    },
    async settled(): Promise<ExtractAvailability> {
      return inflight ?? run();
    },
  };
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

/**
 * ★★ **自动抽取的闸门决策（纯函数）** —— 放在 `parse` ④ 之前调用。
 *
 * ## 为什么要有闸门（真实代价）
 * - 并发=1 下**一次调用约 20–120 秒**；refman 有 **2523 个单元** ⟹ 自动抽取 = **3–7 小时 + 2523 次真实花费**
 *   （用户明确在意 LLM 花费 —— kimi 事件）。**不能无声发生**。
 * - `text_gate='empty_body'`（图片型且无文字层/OCR）时抽取**注定 0 卡片** —— 空转花钱。
 *
 * ## 为什么是纯函数
 * 决策要能被**穷举断言**（含"阈值真的被读" —— 坑 24），而不是只能靠跑真任务碰运气。
 *
 * @returns `run` = 放行；`needs_confirm` = 超阈值，交用户确认；`skip` = 正文为空，不入队
 */
/**
 * ★★ **单元 id 计划**（机制 2 修复：id 不稳定 → FK 级联删卡）。
 *
 * ## 被修的真实缺陷（零 LLM 实测证据）
 * ```
 * 重跑前 cards=1  units=unt_old_1
 * parse 终态 done            ← 解析**成功**
 * 重跑后 cards=0             ← ★ 卡片没了
 * 重跑后 units=unt_0cd7d866e78e,unt_1f7970dfe6e1   ← 单元 id 全变
 * ```
 * 根因：`handlers.ts` 构造 `drafts` 时**不带 id** → `repo.replaceUnits` 对每个单元
 * `newUnitId()` → 新 id 与旧 id 不同 → `cards.unit_id REFERENCES units(id) ON DELETE CASCADE`
 * **级联删掉全部卡片** —— **与抽取成功与否无关**（成功的 reparse 也清卡）。
 *
 * ## 两条规则
 * 1. **结构未变 → 复用旧 id**（条件 2(ii)）：按 `(ord, span)` 配对且**正文相同**时，
 *    直接沿用旧 id。⟹ **真实升级路径**（库里现存 id 是随机的）第一次 reparse **也不丢卡**；
 *    只做确定性哈希的话，迁移那一次仍会因 id 变化而清卡 —— 等于没修。
 * 2. 否则用**确定性 id** `unt_<sha1(docId|ord|span|title)[:12]>`：同一文件重跑得到同一 id。
 *    ⚠️ `span` 可能缺失：null/undefined 用 `'-'` 占位（**不许与 `''` 算出同一个哈希**）。
 *
 * ## 碰撞（条件 1）
 * 同一文档内 `(docId, ord, span, title)` 相同时哈希相同 → 若直接覆盖就是**静默丢单元**。
 * 这里**加后缀** `-2`/`-3`… 并**如实记录** `collisions`（调用方写进 meta）——**绝不静默覆盖**。
 */
export interface UnitIdPlan {
  /** 与 drafts 一一对应的 id */
  ids: string[];
  /** 复用旧 id 的数量（结构未变） */
  reused: number;
  /** 用确定性哈希新算的数量 */
  deterministic: number;
  /** 碰撞（同哈希）→ 已加后缀；如实上报，便于排查"为什么有重复结构" */
  collisions: { index: number; base: string; final: string }[];
}

export function planUnitIds(opts: {
  docId: string;
  drafts: { ord: number; title?: string; span?: { kind?: string; start?: number; end?: number }; text?: string }[];
  oldUnits: { id: string; ord: number; span_kind?: string; span_start?: number; span_end?: number; text?: string | null }[];
}): UnitIdPlan {
  const { docId, drafts, oldUnits } = opts;
  const part = (v: unknown): string => (v === null || v === undefined || v === '' ? '-' : String(v));
  const detId = (d: { ord: number; title?: string; span?: { kind?: string; start?: number; end?: number } }): string => {
    const kind = part(d.span?.kind);
    const start = Number.isFinite(d.span?.start) ? String(d.span?.start) : '-';
    const end = Number.isFinite(d.span?.end) ? String(d.span?.end) : '-';
    const h = createHash('sha1').update(`${docId}|${d.ord}|${kind}|${start}|${end}|${part(d.title)}`).digest('hex');
    return `unt_${h.slice(0, 12)}`;
  };
  const key = (ord: number, kind: unknown, start: unknown, end: unknown): string =>
    `${ord}|${part(kind)}|${Number.isFinite(start) ? String(start) : '-'}|${Number.isFinite(end) ? String(end) : '-'}`;

  // 旧单元按 (ord, span) 分组 → 供"结构未变则复用 id"
  const oldByKey = new Map<string, { id: string; text: string }[]>();
  for (const u of oldUnits) {
    const k = key(u.ord, u.span_kind, u.span_start, u.span_end);
    const list = oldByKey.get(k) ?? [];
    list.push({ id: u.id, text: u.text ?? '' });
    oldByKey.set(k, list);
  }
  const consumed = new Set<string>();
  const used = new Set<string>();
  const ids: string[] = [];
  const collisions: { index: number; base: string; final: string }[] = [];
  let reused = 0;
  let deterministic = 0;

  drafts.forEach((d, i) => {
    const k = key(d.ord, d.span?.kind, d.span?.start, d.span?.end);
    let id = '';
    const cands = oldByKey.get(k) ?? [];
    const hit = cands.find((c) => !consumed.has(c.id) && c.text === (d.text ?? ''));
    if (hit) {
      id = hit.id;
      consumed.add(id);
      reused += 1;
    } else {
      id = detId(d);
      deterministic += 1;
    }
    // 碰撞：同批次内 id 已被占用 → 加后缀（**不许静默覆盖**）
    if (used.has(id)) {
      const base = id;
      let n = 2;
      while (used.has(`${base}-${n}`)) n += 1;
      id = `${base}-${n}`;
      collisions.push({ index: i, base, final: id });
    }
    used.add(id);
    ids.push(id);
  });

  return { ids, reused, deterministic, collisions };
}

export function decideAutoExtract(input: {
  units: number;
  textGate?: string;
  maxUnits: number;
}): { action: 'run' | 'needs_confirm' | 'skip'; meta: Record<string, unknown> } {
  // ① 正文为空 → 不入队（注定 0 卡片）
  if (input.textGate === 'empty_body') {
    return {
      action: 'skip',
      meta: {
        extract_auto: 'skipped',
        extract_skip_reason: '该资料正文为空（图片型且未产出文字层/OCR）—— 抽取会注定产出 0 张卡片，故不自动抽取',
      },
    };
  }
  // ② 单元数超阈值 → 不自动抽取，标"待确认" + **代价可见（次数 + 时长区间）**
  if (input.units > input.maxUnits) {
    const [lo, hi] = estimateExtractMinutes(input.units);
    return {
      action: 'needs_confirm',
      meta: {
        needs_confirm: true,
        est_calls: input.units,
        est_minutes: [lo, hi],
        extract_auto: 'needs_confirm',
        extract_skip_reason:
          `单元数 ${input.units} 超过自动抽取阈值 ${input.maxUnits} —— 抽取会发起约 ${input.units} 次 LLM 调用` +
          `（并发=1，预计 ${lo}–${hi} 分钟）。请在界面确认后手动开始（POST /api/v1/documents/:id/extract）。`,
      },
    };
  }
  return { action: 'run', meta: { extract_auto: 'running', extract_auto_units: input.units, extract_auto_at: Date.now() } };
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

    // ★ 三态如实上报（坑 32）：探测未完成时**放行**（不阻塞用户），但**必须说明"正在检测"** ——
    //   绝不写成"已验证可用"（坑 10：不许假装可用）。用户/前端据此显示"正在检测模型可用性"。
    if (av.detecting) {
      repo.mergeDocumentMeta(docId, {
        extract_note:
          `模型可用性检测中（首次约 1 分钟，已等待 ${Math.round((av.waitedMs ?? 0) / 1000)}s）` +
          `—— 本次已直接开始抽取；若模型实际不可用会如实报错`,
      });
    } else if (av.ok) {
      repo.mergeDocumentMeta(docId, { extract_note: '' });
    }

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
      /**
       * ★ **实测**的结构化输出模式（`strict` = 端点接受严格 schema；`lenient` = 已回落裸 schema）。
       * 为什么写进 meta：该端点对严格 schema **时好时坏**（实测 200/400 都出现过）——
       * 记下来才能**看见**"网关恢复（strict 命中率上升）/ 退化（掉到 lenient 的比例上升）"，
       * 而不是靠猜（坑 21：抓了但没上报 = 等于没抓）。
       */
      ...(result.structuredOutputMode ? { structured_output_mode: result.structuredOutputMode } : {}),
    });

    /**
     * ★★ **抽取结束后必须把文档状态从 `extracting` 放出来**（用户直接撞到的 bug）。
     *
     * 缺陷证据：`doc_473f915e315f` 的 `tasks.status='failed'` 而 `documents.status` **仍是 `extracting`**
     * ⟹ 界面不显示失败/原因，用户以为还在跑（"显示是可用的，请问抽取的结果在哪"）。
     * 本 handler 原先只写 `meta.extract_status`，**从不更新 `documents.status`** —— 于是它永远停在 `extracting`。
     *
     * 映射（如实）：
     * - `failed` → `documents.status='failed'`（原因在 meta 的 `extract_error`，前端可读）
     * - `done` / `partial` / `done_empty` → **回到 `ready`**（抽取这一阶段结束了；卡片数在 meta 里如实报）
     *   ⚠️ `done_empty` **不是** ready 意义上的"有内容"—— 前端要读 `extract_status` 显示"未产出卡片"，
     *   不许只看 `documents.status`（那是**阶段**状态，不是**产出**状态）。
     */
    repo.updateDocument(docId, { status: status === EXTRACT_STATUS.failed ? 'failed' : 'ready' });

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
    // ★★ 机制 2 修复（Lead 授权方案 4 + 条件 2(ii)）：**单元 id 必须稳定**。
    //    原实现不带 id → `repo.replaceUnits` 每次 `newUnitId()` → 新 id ≠ 旧 id
    //    → `cards.unit_id REFERENCES units(id) ON DELETE CASCADE` **级联删掉全部卡片**
    //    （实测：**成功的 reparse 也清卡**，与抽取成功与否无关）。
    const idPlan = planUnitIds({ docId, drafts, oldUnits: repo.allUnitRows(docId) });
    drafts.forEach((d, i) => {
      d.id = idPlan.ids[i];
    });
    const unitIds = repo.replaceUnits(docId, drafts);
    if (idPlan.collisions.length > 0) {
      // ★ 碰撞**不许静默**：已加后缀保证"都还在"，但原因要能被排查
      repo.mergeDocumentMeta(docId, {
        unit_id_collisions: idPlan.collisions,
        unit_id_collision_note:
          '同一文档内有单元的 (ord, span, title) 完全相同 → 确定性 id 会撞；已加后缀保留全部单元',
      });
    }
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
      // ★ 单元 id 来源如实记录（复用旧 id = 结构未变；deterministic = 新算）
      //   为什么记：迁移期用户会问"为什么这次没丢卡片/为什么 id 变了"
      unit_id_plan: { reused: idPlan.reused, deterministic: idPlan.deterministic },
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

    /**
     * ★★ **抽取前的闸门（纯函数决策，可穷举断言）** —— 修掉两件事：
     * 1. **2523 单元会无声花掉 2523 次调用**（并发=1 约 3–7 小时）—— 必须让用户先看到代价再决定
     * 2. `text_gate='empty_body'`（图片型、正文为空）时抽取**注定 0 卡片** —— 不该空转花钱
     *
     * ⚠️ 决策放在**这里**（parse ④）而不是队列层：`parse` 本身就会抽取
     * （Lead 真上传实测：只有 parse 任务却产出了卡片）⟹ 队列再链一次会**双倍花费**。
     */
    const gate = decideAutoExtract({
      units: unitIds.length,
      textGate: typeof parsedMeta.text_gate === 'string' ? parsedMeta.text_gate : undefined,
      maxUnits: autoExtractMaxUnits(),
    });
    if (gate.action !== 'run') {
      repo.mergeDocumentMeta(docId, gate.meta);
      detail.extract_status = gate.action === 'needs_confirm' ? 'needs_confirm' : 'skipped';
      detail.counts = repo.counts(docId);
      Object.assign(detail, gate.meta);
      ctx.progress(1, gate.action === 'needs_confirm' ? '完成（待确认是否抽取）' : '完成（未抽取卡片）');
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
   * 视频 ASR —— **走 OpenRouter（云端）**：plan / convert 两阶段。
   *
   * 形状照抄本仓库已有的 plan/convert 范式（`extract.plan`→Node 调 LLM→`extract.convert`）：
   *
   * ```
   * ① worker video.asr.plan      [Python] ffmpeg 抽音频 + 切块 + **断点** → chunks[]
   * ② 本函数逐块调 OpenRouter     [Node]   providers/openrouter_audio.ts::createOpenRouterAsr（**唯一实现**）
   * ③ worker video.asr.convert   [Python] 结果 + 块偏移 → 段（块级时间戳）→ 与本地 asr job **同形**的产物
   * ```
   *
   * ## 三条硬要求（用户裁定 + Lead 明确）
   *
   * 1. ★★ **绝不静默降级回本地 faster-whisper**：这里**不走 provider 的 policy 降级链**
   *    （链里 `local-fw` 排第一，会"悄悄"用本地），而是**直接按 id 取 openrouter_asr 构造**——
   *    结构上就没有本地那一跳。云端失败 → **如实抛** + 可读 reason。
   * 2. ★ **不许两套 ASR 实现**：HTTP 调用只在 `openrouter_audio.ts`，本函数只做编排。
   * 3. ★ **代价可见**：plan 带回实测口径的计费估算（音频时长是账单大头），逐块进度也上报。
   *
   * ⚠️ 想改成"用注册表里的实例"也行，但那需要给 `PipelineDeps` 加 `providers`；
   *    这里用**同一工厂 + 配置项**构造（仍是**同一实现**，不是第二套），顺便天然绕开 policy 链。
   */
  const asrViaOpenRouter = async (
    ctx: TaskHandlerContext,
    docId: string,
    absPath: string,
  ): Promise<Record<string, unknown>> => {
    // ⚠️ 路径是 `cfg.providers.providers.asr`：`cfg.providers` 是 ProviderConfig
    //    （{policy, providers, sourcePath, warnings}），**不是**按 kind 索引的 map。
    const entries = cfg.providers?.providers?.asr ?? [];
    const entry = entries.find(
      (p) => p.type === 'openrouter_asr' || p.id === 'openrouter-asr' || p.id === 'openrouter_asr',
    );
    if (!entry) {
      throw new ApiError('E_ASR_LOAD', '没有配置 OpenRouter ASR provider', {
        hint:
          'ASR 已改为**云端优先**（用户裁定）。请在 config/providers.yaml 的 providers.asr 下配置 ' +
          '`type: openrouter_asr` + `.env` 的 `OPENROUTER_KEY`。本地 faster-whisper 仅在显式指定时使用。',
      });
    }
    const asr = createOpenRouterAsr(entry);
    if (!asr.info.configured) {
      throw new ApiError('E_ASR_LOAD', `OpenRouter ASR 不可用：${asr.info.reason}`, {
        hint: '检查 .env 的 OPENROUTER_KEY 是否配置；**不会**回退本地 faster-whisper（用户明确要求走 API）。',
      });
    }
    const asrModel = String(entry.options?.model ?? OPENROUTER_ASR_MODEL);
    const workDir = path.join(cfg.dataDir, 'video', docId);
    const language = asStr(ctx.params.language, '');

    const forward = (e: unknown): void => {
      const ev = e as Partial<WorkerEvent> & { type?: string };
      if (ev.type === 'log') {
        ctx.log(asStr(ev.msg), (ev.level as 'info' | 'warn' | 'error' | 'debug') ?? 'info');
      } else if (ev.type === 'progress') {
        ctx.log(`[plan] ${asStr(ev.stage, '')}`, 'debug');
      }
    };

    // ① plan：Python 产媒体（抽音频 + 切块 + 断点），**不转写**
    ctx.progress(0.06, '准备音频（抽轨 + 切块）');
    const plan = (await runner({
      job: 'video.asr.plan',
      input: {
        doc_id: docId,
        path: absPath,
        work_dir: workDir,
        options: { chunkMs: asNum(ctx.params.chunkMs, 30_000), language, resume: true },
      },
      signal: ctx.signal,
      timeoutMs: cfg.workerTimeoutMs,
      onEvent: forward,
    })) as {
      chunks?: { index: number; path: string; startMs: number; endMs: number; durationMs?: number; done?: boolean }[];
      chunksTotal?: number;
      doneChunks?: number[];
      estimate?: Record<string, unknown>;
      language?: string;
    };

    const all = plan.chunks ?? [];
    if (all.length === 0) throw new ApiError('E_ASR_LOAD', 'plan 没有产出任何音频块（视频无音轨？）');
    const total = all.length;
    const resumeFrom = plan.doneChunks?.length ?? 0;
    ctx.log(
      `云端 ASR：${total} 块（${resumeFrom} 块已在断点里） 模型=${asrModel} 计费估算=${JSON.stringify(plan.estimate ?? {})}`,
      'info',
    );

    // ② 逐块调 OpenRouter（**并发=1**：用户硬要求；顺带让进度/计费可预期）
    const transcriptions: { index: number; text: string; model: string; elapsedMs: number }[] = [];
    let done = resumeFrom;
    for (const c of all) {
      if (c.done) continue;
      if (ctx.signal?.aborted) {
        // 取消：**不抛错**（队列会把 abort 收尾成 `cancelled`），也不继续调 API 白花钱。
        // 断点里已完成的块由上面的阶段性 convert 落过盘 → 续跑不重复计费。
        ctx.log(`任务被取消，已落盘 ${done}/${total} 块（断点保留，可续跑）`, 'warn');
        return { video: { cancelled: true, chunks_done: done, chunks_total: total } };
      }
      const t0 = Date.now();
      let r: Awaited<ReturnType<typeof asr.transcribe>>;
      try {
        r = await asr.transcribe({
          audioPath: c.path,
          durationMs: c.durationMs ?? c.endMs - c.startMs,
          ...(language ? { language } : {}),
          requireWordTimestamps: false, // voxtral 没有词级时间戳 → 如实不要求（块级）
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // ★ 如实失败：**不**换本地、**不**产出空字幕
        throw new ApiError('E_ASR_LOAD', `云端 ASR 第 ${c.index + 1}/${total} 块失败：${msg}`, {
          hint:
            'ASR 走 OpenRouter（用户裁定）。请检查 OPENROUTER_KEY/额度/网络后重试；' +
            '断点已保存，重试只会补没转完的块（不会重复计费已完成的块）。',
        });
      }
      const text = r.segments.map((s) => s.text).join(' ').trim();
      transcriptions.push({
        index: c.index,
        text,
        model: asrModel,
        elapsedMs: Date.now() - t0,
      });
      done += 1;
      ctx.progress(0.06 + 0.88 * (done / total), `云端转写 ${done}/${total}${text ? '' : '（本块无语音）'}`);

      // ③ 阶段性落盘（每 5 块 / 最后一块）：中断后重跑**不会重复计费**已完成的块
      if (done % 5 === 0 || done === total) {
        await runner({
          job: 'video.asr.convert',
          input: {
            doc_id: docId,
            path: absPath,
            work_dir: workDir,
            plan,
            transcriptions,
            model: asrModel,
            partial: true,
          },
          signal: ctx.signal,
          timeoutMs: cfg.workerTimeoutMs,
          onEvent: forward,
        });
        ctx.log(`云端 ASR：已落盘 ${done}/${total} 块断点`, 'debug');
      }
    }

    // ④ 最终 convert：块必须齐 + 全空文本 → 如实失败（绝不产出空字幕假装成功）
    const result = (await runner({
      job: 'video.asr.convert',
      input: {
        doc_id: docId,
        path: absPath,
        work_dir: workDir,
        plan,
        transcriptions,
        model: asrModel,
        partial: false,
      },
      signal: ctx.signal,
      timeoutMs: cfg.workerTimeoutMs,
      onEvent: forward,
    })) as Record<string, unknown> & { segments?: unknown[] };

    ctx.log(
      `云端 ASR 完成：${asrModel}（来源 openrouter，块级时间戳） 段=${(result.segments ?? []).length}`,
      'info',
    );
    repo.upsertVideoArtifact(docId, result);
    ctx.artifact('subtitle', `/api/v1/documents/${docId}/video/subtitle?fmt=srt`);
    ctx.progress(1, '完成');
    return {
      video: {
        duration_ms: asNum(result.durationMs),
        segments: Array.isArray(result.segments) ? result.segments.length : 0,
        // ★ 如实标注来源与实际模型（降级也要标；这里没有降级路径）
        asr_source: 'openrouter',
        asr_model: asrModel,
        asrProvider: 'openrouter-asr',
      },
    };
  };

  /**
   * 视频/音频任务：本地路径（faster-whisper / 抽帧 / 导图）。
   *
   * ⚠️ **ASR 已改走云端**（见 :func:`asrViaOpenRouter`）：本函数的 `asr` 分支不再用本地转写。
   * 保留本地实现作**显式可选**路径（离线/降级场景），但**默认不走**、也**不许静默降级**。
   */
  const videoJob = (job: 'asr' | 'video' | 'slides' | 'mindmap'): TaskHandler => async (ctx) => {
    const docId = ctx.docId;
    if (!docId) throw new ApiError('E_NOTFOUND', `${job} 任务缺少 doc_id`);
    const doc = repo.getDocumentRow(docId);
    if (!doc) throw new ApiError('E_NOTFOUND', `文档不存在：${docId}`);
    const absPath = path.isAbsolute(doc.source_path) ? doc.source_path : path.join(cfg.root, doc.source_path);

    // ★ ASR：云端（plan/convert）。**不走下面的本地 worker `asr` job**。
    if (job === 'asr') return asrViaOpenRouter(ctx, docId, absPath);

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
            hint:
              '这条是**本地**媒体路径（抽帧/导图等）。ASR 已改为**云端 OpenRouter**（`asr` 任务走 plan/convert），' +
              '若这里是 ASR 相关失败，请检查 .env 的 OPENROUTER_KEY 与 config/providers.yaml 的 openrouter_asr 配置。',
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
