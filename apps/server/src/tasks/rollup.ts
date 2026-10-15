/**
 * `rollup` —— F3 全层级摘要（S2 **自底向上**汇总）。
 *
 * 规格：`docs/FUNCTIONAL_SPEC.md` **F3** ｜ `docs/PROVIDERS.md` §0（三条铁律）
 *
 * ## 为什么自底向上
 * F3 原文：中间层的"这章讲什么"**不该重读原文**（昂贵且易不一致），
 * 而由**已抽好的子节点摘要合并** —— 与人类写综述的方式一致，且**可追溯**。
 *
 * ```text
 * 深度 L6 ──► L1（从深到浅）
 * 对每个内部节点 k：
 *   输入 = k 自身引言段（若有）+ 每个子节点 c 的 {title, intro, key_takeaways, n_cards}
 *   一次 LLM 调用 → {intro, why_important, objectives, key_takeaways, section_role}
 *   落盘 → 供其父节点使用（**父节点的输入依赖子节点的输出**，这就是"自底向上"）
 * ```
 *
 * ## 提示词为什么不在这里（这是硬约束，不是风格）
 * lead 裁定：**提示词 + 封闭枚举必须只有一份实现**（在 `worker/pipeline/rollup_core.py`）。
 * 本文件**不写任何提示词、不写任何 schema** —— 只从 worker 的 `rollup.plan` 取：
 *
 * ```text
 * rollup.plan    { nodes:[...] } → { schema:<裸 JSON Schema>, items:[{key,node_id,system,user}] }
 * rollup.convert { nodes:[...], payloads:[{key,data}] } → { ok, error_count, rollups:{...} }
 * ```
 * （Node 侧抄一份提示词 = 第二份真相，改一处忘另一处**且不会报错** —— 必须避免。）
 *
 * ## 三条铁律的落点
 * - **R1** `configured` ≠ `available`：本模块先看 `completeJson` 是否存在（configured），
 *   再看调用是否**真的成功**（available）。二者分开记录进 `detail`。
 * - **R2** 不靠"配了 key"就开工：真正失败（含 402 欠费）在**第一跳**就被捕获并如实记录。
 * - **R3** 全链失败 → **不产出假 intro**：回退到**确定性** intro 并如实标
 *   `intro_source='deterministic'`；任务 `detail` 里写清 `llm_used=false` + `reason`。
 *
 * ## 与 `store/outline.ts` 的关系（别搞混两套来源标记）
 * `outline.ts` 的 `intro_source` 是**读页面时的优先级**：
 * `manual > section_summary > rollup_llm > rollup_titles > none`
 * 本模块写进 `meta.rollup[unit_id]`，其中每个节点带 `source` ∈
 * `llm | deterministic | skipped`（**生成本身**的来源，如实标注）。
 * 两者不冲突：`outline.ts` 只在**没有** `section_summary`/`manual` 时才会用到这里写入的 `intro`。
 */

import type { ServerConfig } from '../config.ts';
import type { Db } from '../store/db.ts';
import type { Repo, UnitRow } from '../store/repo.ts';
import type { TaskHandler, TaskHandlerContext } from './queue.ts';
import type { CompleteJsonFn } from './extract.ts';
// ⚠️ 用 `worker/runner.ts` 的 `WorkerRunner`（`job: string`，通用），**不要**用
// `providers/index.ts` 重导出的那个 —— 那个是 ASR 专用的（`job: 'asr'`），
// 拿它调 `rollup.plan` 会直接是类型错（实测踩到）。
// 只做 **type-only** import，不碰 backend-api 的实现文件。
import type { WorkerRunner } from '../worker/runner.ts';
import { ApiError } from '../store/errors.ts';

// ═══════════════════════════════════════════════════════════════════════
// 常量与类型
// ═══════════════════════════════════════════════════════════════════════

/** 生成来源（**如实标注**，与 outline.ts 的读取优先级是两件事）。 */
export const ROLLUP_SOURCE = {
  /** LLM 真实汇总产出 */
  llm: 'llm',
  /** LLM 不可用 → 确定性回退（由子节点标题拼出，**不是模型编的话**） */
  deterministic: 'deterministic',
  /** 该节点本轮未处理（断点已存在 / 被 max_nodes 截断） */
  skipped: 'skipped',
} as const;
export type RollupSource = (typeof ROLLUP_SOURCE)[keyof typeof ROLLUP_SOURCE];

/** 单个内部节点的汇总结果（`meta.rollup[unit_id]`）。 */
export interface RollupEntry {
  intro: string;
  why_important: string;
  objectives: string[];
  key_takeaways: string[];
  /** 可选（来自契约 §2.3 `section_role` 封闭枚举，由 worker 校验） */
  section_role?: string;
  /** ★ 本条的**生成来源**（如实标注，读页面时据此判断可信度） */
  source: RollupSource;
  /** 深度（自底向上用；也是断点续跑后校验顺序的痕迹） */
  depth: number;
  /** 生成时间戳（ms） */
  at: number;
  /** 真实使用的 provider（降级时如实上报） */
  used_provider?: string;
  degraded_from?: string;
  degraded_reason?: string;
}

/**
 * 单次 worker 调用的**参数 JSON 字节上限**。
 *
 * ⚠️ 这是**实测出来的硬约束，不是保守估计**。
 * `worker/client.ts::defaultLauncher` 把参数同时放进 **argv**（`--in <json>`）与 stdin，
 * 而 **Windows 的 argv 有约 32 KB 上限**：超过就 `spawn` 直接抛 `ENAMETOOLONG`
 * （实测：40 KB argv → `ENAMETOOLONG`；20 KB → ok）。
 *
 * 本机实测（refman，376 个内部节点）**每一层都超**：
 * ```text
 * depth=4  1 节点   1.2 KB
 * depth=3  24 节点  31.0 KB   ← 已贴上限
 * depth=2  173 节点 289.5 KB  ← 超 9 倍
 * depth=1  145 节点 251.6 KB
 * depth=0  33 节点  66.1 KB
 * ```
 * 症状（未分批时）：`rollup.plan 不可用：无法启动 worker` → **整篇静默退化成确定性回退**，
 * 376 个节点一个 LLM intro 都生不出来，而任务却"成功"。
 *
 * ⟹ 必须**按字节分批**，每批留足余量（16 KB，约等于上限的一半）。
 */
export const MAX_PLAN_PAYLOAD_BYTES = 16 * 1024;

/**
 * 把一层节点切成**字节预算内**的若干批（保序）。
 *
 * 单个节点自己就超预算时**仍然单独成批**（不丢节点）—— 那种情况说明该节点输入异常大，
 * 交由 worker 报错并如实记录，而不是在这里静默跳过。
 */
export function batchByPayloadBytes(
  nodes: Record<string, unknown>[],
  maxBytes = MAX_PLAN_PAYLOAD_BYTES,
): Record<string, unknown>[][] {
  const batches: Record<string, unknown>[][] = [];
  let cur: Record<string, unknown>[] = [];
  let curBytes = 0;
  const overhead = 12; // {"nodes":[]} 的固定开销
  for (const n of nodes) {
    const size = JSON.stringify(n).length + 1;
    if (cur.length > 0 && curBytes + size + overhead > maxBytes) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(n);
    curBytes += size;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

export interface RollupHandlerDeps {
  repo: Repo;
  db: Db;
  cfg: ServerConfig;
  /**
   * Python worker 调用器。本模块只用两个 job：
   * `rollup.plan`（出提示词 + 裸 schema）与 `rollup.convert`（校验 + 转换）。
   */
  runner: WorkerRunner;
  /**
   * 结构化 LLM 调用（`providers/index.ts::completeJson`，内部 `LLM_QUEUE` ⇒ **并发=1**）。
   * `null` = 没有可用 LLM → **如实降级**（不产假 intro）。
   */
  completeJson: CompleteJsonFn | null;
  /** 真探测（R2）。不提供时退化为"看 completeJson 是否有"。 */
  availability?: () => Promise<{ ok: boolean; reason: string }>;
  /** 单次任务最多处理多少内部节点（小样本先跑；0/undefined = 不限） */
  maxNodesPerRun?: number;
}

/** worker `rollup.plan` 的返回（**schema 是裸的** —— 包装层由我们补）。 */
export interface RollupPlanResult {
  order?: string;
  schema: Record<string, unknown>;
  items: { key: string; node_id: string; system: string; user: string; title?: string; level?: number }[];
  nodes_total?: number;
  internal_nodes?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// 纯函数：树结构与"自底向上"顺序（可单测，无 IO）
// ═══════════════════════════════════════════════════════════════════════

export interface TreeNode {
  unit: UnitRow;
  children: string[];
  /** 从根算起的深度（根 = 0） */
  depth: number;
  /** 子树里的最大相对深度（叶子 = 0），用于自底向上排序 */
  height: number;
}

/**
 * 由 units 建树 + 算深度。
 *
 * ⚠️ 用**显式栈 + 记忆化**，不用递归：递归在深树（L6）上会爆栈，
 * 且父节点缺失（脏 parent_id）时会无限递归。
 */
export function buildTree(units: UnitRow[]): Map<string, TreeNode> {
  const byId = new Map<string, UnitRow>();
  for (const u of units) byId.set(u.id, u);

  const childrenOf = new Map<string, string[]>();
  for (const u of units) {
    const p = u.parent_id;
    // 父节点不存在（脏数据 / 跨文档引用）→ 视为根，**不静默丢弃该节点**
    const key = p && byId.has(p) ? p : '';
    const list = childrenOf.get(key) ?? [];
    list.push(u.id);
    childrenOf.set(key, list);
  }
  // 稳定顺序：ord → id（与 outline.ts 一致）
  for (const list of childrenOf.values()) {
    list.sort((a, b) => {
      const ua = byId.get(a);
      const ub = byId.get(b);
      if (!ua || !ub) return 0;
      return ua.ord - ub.ord || a.localeCompare(b);
    });
  }

  const depth = new Map<string, number>();
  const height = new Map<string, number>();
  const nodes = new Map<string, TreeNode>();

  // 迭代式后序遍历（算 height 必须自底向上）
  const roots = childrenOf.get('') ?? [];
  const visited = new Set<string>();
  const stack: { id: string; phase: 0 | 1; d: number }[] = roots
    .map((id) => ({ id, phase: 0 as const, d: 0 }));

  while (stack.length > 0) {
    const top = stack[stack.length - 1] as { id: string; phase: 0 | 1; d: number };
    if (top.phase === 0) {
      if (visited.has(top.id)) {
        stack.pop();
        continue;
      }
      visited.add(top.id);
      depth.set(top.id, top.d);
      top.phase = 1;
      for (const c of childrenOf.get(top.id) ?? []) {
        stack.push({ id: c, phase: 0, d: top.d + 1 });
      }
    } else {
      stack.pop();
      let h = 0;
      for (const c of childrenOf.get(top.id) ?? []) h = Math.max(h, (height.get(c) ?? 0) + 1);
      height.set(top.id, h);
    }
  }

  // 孤立节点（父不存在 / 环导致未被遍历到）→ 兜底登记，保证**不丢节点**
  for (const u of units) {
    if (depth.has(u.id)) continue;
    depth.set(u.id, 0);
    if (!height.has(u.id)) height.set(u.id, 0);
  }

  for (const u of units) {
    nodes.set(u.id, {
      unit: u,
      children: childrenOf.get(u.id) ?? [],
      depth: depth.get(u.id) ?? 0,
      height: height.get(u.id) ?? 0,
    });
  }
  return nodes;
}

/** 内部节点 = 有子节点的节点（叶子摘要由 S1 顺带产出，不属于本任务的量） */
export function internalNodes(nodes: Map<string, TreeNode>): TreeNode[] {
  return [...nodes.values()].filter((n) => n.children.length > 0);
}

/** 内部节点按**层级从深到浅**排序（L6 → L1）—— 自底向上的执行顺序。 */
export function bottomUpOrder(nodes: Map<string, TreeNode>): TreeNode[] {
  return internalNodes(nodes).sort((a, b) => b.depth - a.depth || a.unit.ord - b.unit.ord || a.unit.id.localeCompare(b.unit.id));
}

/** LLM 不可用时的**确定性** intro（由子节点标题拼出）—— **不是模型编的话**。 */
export function deterministicIntro(node: TreeNode, nodes: Map<string, TreeNode>, nCards: number): string {
  const kids = node.children.map((id) => nodes.get(id)).filter((x): x is TreeNode => Boolean(x));
  const names = kids.slice(0, 6).map((k) => k.unit.title).filter(Boolean).join('、');
  const more = kids.length > 6 ? ` 等 ${kids.length} 个小节` : '';
  let intro = names ? `本节包含 ${names}${more}。` : `本节含 ${kids.length} 个子小节。`;
  if (nCards > 0) intro += `（该节点及其子节点共 ${nCards} 个知识点）`;
  return intro;
}

/** 子树卡片数（一次遍历算全，避免每节点重扫 —— O(n²)）。 */
export function subtreeCardCounts(nodes: Map<string, TreeNode>, cardCounts: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const ordered = [...nodes.values()].sort((a, b) => a.height - b.height || b.depth - a.depth);
  for (const n of ordered) {
    let c = cardCounts.get(n.unit.id) ?? 0;
    for (const kid of n.children) c += out.get(kid) ?? 0;
    out.set(n.unit.id, c);
  }
  return out;
}

/**
 * 子节点摘要的解析器 —— **镜像 `store/outline.ts` 的优先级**，但**只取"已存在的摘要"**。
 *
 * 这一点是 F3 的核心约束，别写错：
 * > 中间层的"这章讲什么"**不该重读原文**（昂贵且易不一致），而由**已抽好的子节点摘要合并**。
 *
 * ⚠️ **原错误写法**（我第一版真的这么写了）：直接把 `child.unit.text` 截断当 intro。
 * 那等于让父节点**重读原文**，恰好违背 F3；而且会把原始正文当"摘要"喂给模型，
 * 归纳质量差、token 还贵。
 *
 * 优先级（与 outline.ts 一致，**只到 `rollup` 为止**，不含最后的"标题拼接"兜底）：
 * `manual_intros` → `section_summaries` → 已算出的 `rollup`
 * 三者都没有时**如实返回 `（无摘要）`**，由 worker 提示词要求模型写"子节点摘要不足以归纳"，
 * **不替它编**。
 */
export interface ChildSummarySources {
  manualIntros: Record<string, unknown>;
  sections: Record<string, unknown>;
  rollup: Record<string, unknown>;
}

export function resolveChildSummary(
  childId: string,
  sources: ChildSummarySources,
): { intro: string; key_takeaways: string[]; intro_source: string } {
  const m = asRecord(sources.manualIntros[childId]);
  if (m && typeof m.intro === 'string' && m.intro.trim()) {
    return { intro: m.intro, key_takeaways: [], intro_source: 'manual' };
  }
  const s = asRecord(sources.sections[childId]);
  if (s && typeof s.section_summary === 'string' && s.section_summary.trim()) {
    return {
      intro: s.section_summary,
      key_takeaways: asStrArray(s.key_takeaways).slice(0, 3),
      intro_source: 'section_summary',
    };
  }
  const r = asRecord(sources.rollup[childId]);
  if (r && typeof r.intro === 'string' && r.intro.trim()) {
    return {
      intro: r.intro,
      key_takeaways: asStrArray(r.key_takeaways).slice(0, 3),
      intro_source: typeof r.source === 'string' ? `rollup:${r.source}` : 'rollup',
    };
  }
  return { intro: '（无摘要）', key_takeaways: [], intro_source: 'none' };
}

/**
 * 单个节点在提示词里最多带多少个子节点摘要。
 *
 * 为什么需要上限（两层原因，都实测过）：
 *  1. **传输**：`worker/client.ts` 把参数放在 argv 里，Windows 约 32 KB 上限。
 *     **一个节点就可能有几十个子节点**（实测 refman：最多 **66** 个，>20 个的有 15 个），
 *     `batchByPayloadBytes` 按"节点"切分**帮不了这种情况** —— 单个节点自身就超预算。
 *  2. **质量**：一次给模型 66 个子节摘要，重点会被稀释。人类写综述也不会把 66 个小节逐条抄进去。
 *
 * ⚠️ 省略**必须如实告知**：子节点块里会带一句"另有 N 个小节未列出"，
 * 与 `deterministicIntro` 已有的"等 N 个小节"写法一致 —— 不让模型以为这就是全部。
 */
export const MAX_CHILDREN_PER_NODE = 30;

/** 子节点摘要的截断长度（LLM 产出的 intro 是 2–3 句，240 字符足够，且能压住 payload）。 */
export const MAX_CHILD_INTRO_CHARS = 240;

/** 子节点摘要的第三个参数：本节点共多少个子节点（用于"另有 N 个未列出"的如实告知）。 */
export interface ChildPayloadResult {
  children: Record<string, unknown>[];
  total: number;
}

/** 子节点摘要块（喂给 worker 的 `nodes[].children`）—— **不读原文**。 */
export function childPayloads(
  node: TreeNode,
  nodes: Map<string, TreeNode>,
  subtreeCards: Map<string, number>,
  sources: ChildSummarySources,
): Record<string, unknown>[] {
  return childPayloadsCapped(node, nodes, subtreeCards, sources).children;
}

/**
 * 与 `childPayloads` 相同，但**显式返回总数**（供调用方如实标注"另有 N 个未列出"）。
 * 保序取前 `MAX_CHILDREN_PER_NODE` 个（目录顺序即教学顺序，先讲的先出现）。
 */
export function childPayloadsCapped(
  node: TreeNode,
  nodes: Map<string, TreeNode>,
  subtreeCards: Map<string, number>,
  sources: ChildSummarySources,
  maxChildren = MAX_CHILDREN_PER_NODE,
): ChildPayloadResult {
  const all = node.children
    .map((id) => nodes.get(id))
    .filter((x): x is TreeNode => Boolean(x));
  const picked = all.slice(0, Math.max(0, maxChildren));
  const children = picked.map((k) => {
    const s = resolveChildSummary(k.unit.id, sources);
    const intro = s.intro.length > MAX_CHILD_INTRO_CHARS
      ? `${s.intro.slice(0, MAX_CHILD_INTRO_CHARS)}…`
      : s.intro;
    return {
      title: k.unit.title,
      intro,
      key_takeaways: s.key_takeaways.map((t) => (t.length > 120 ? `${t.slice(0, 120)}…` : t)),
      n_cards: subtreeCards.get(k.unit.id) ?? 0,
      intro_source: s.intro_source,
    };
  });
  return { children, total: all.length };
}

// ═══════════════════════════════════════════════════════════════════════
// 断点（长任务可续 —— 契约 C4）
// ═══════════════════════════════════════════════════════════════════════

export interface RollupCheckpoint {
  doc_id: string;
  done: Record<string, { intro_len: number; source: RollupSource; at: number }>;
  updated_at: number;
}

export function readCheckpoint(raw: unknown, docId: string): RollupCheckpoint {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const doneRaw = o.done && typeof o.done === 'object' ? (o.done as Record<string, unknown>) : {};
  const done: RollupCheckpoint['done'] = {};
  for (const [k, v] of Object.entries(doneRaw)) {
    const e = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    const src = e.source;
    done[k] = {
      intro_len: typeof e.intro_len === 'number' ? e.intro_len : 0,
      source: src === ROLLUP_SOURCE.llm || src === ROLLUP_SOURCE.deterministic ? src : ROLLUP_SOURCE.skipped,
      at: typeof e.at === 'number' ? e.at : 0,
    };
  }
  return { doc_id: docId, done, updated_at: typeof o.updated_at === 'number' ? o.updated_at : 0 };
}

export function checkpointPath(cfg: ServerConfig, docId: string): string {
  return `${cfg.checkpointsDir}/${docId}_rollup.json`;
}

// ═══════════════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════════════

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string').map(String) : [];
}

export function createRollupHandler(deps: RollupHandlerDeps): TaskHandler {
  const { repo, db, cfg, runner } = deps;
  // ★ 先绑成局部 const 收窄 null —— TS 不会跨 `await` 保持 `deps.completeJson` 的非空收窄
  //   （实测报 TS18047 'completeJson' is possibly 'null'）。
  const completeJson = deps.completeJson;

  return async (ctx: TaskHandlerContext): Promise<Record<string, unknown>> => {
    const docId = ctx.docId;
    if (!docId) throw new ApiError('E_NOTFOUND', 'rollup 任务缺少 doc_id');
    if (!repo.getDocumentRow(docId)) throw new ApiError('E_NOTFOUND', `文档不存在：${docId}`);

    const units = repo.allUnitRows(docId);
    if (units.length === 0) {
      throw new ApiError('E_PARSE', '该文档没有单元，无法生成层级摘要', {
        hint: '请先完成解析（parse）',
      });
    }

    const nodes = buildTree(units);
    const cardCounts = repo.cardCountsByUnit(docId);
    const subtreeCards = subtreeCardCounts(nodes, cardCounts);
    const allInternal = internalNodes(nodes);
    const order = bottomUpOrder(nodes);

    // ── 断点：读已有 rollup + checkpoint ──
    const docRow = repo.getDocumentRow(docId);
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(docRow?.meta_json || '{}') as Record<string, unknown>;
    } catch {
      meta = {};
    }
    const rollup: Record<string, unknown> = { ...(asRecord(meta.rollup) ?? {}) };
    // ★ 子节点摘要的三处来源（与 outline.ts 同优先级，**不读原文**）
    const manualIntros = asRecord(meta.manual_intros) ?? {};
    const sections = asRecord(meta.section_summaries) ?? {};
    /** 每次都要读**最新**的 rollup（本层刚写的要能被下一层看见 —— 这就是自底向上） */
    const summarySources = (): ChildSummarySources => ({ manualIntros, sections, rollup });

    const cpPath = checkpointPath(cfg, docId);
    let cp: RollupCheckpoint = { doc_id: docId, done: {}, updated_at: 0 };
    try {
      const fs = await import('node:fs');
      if (fs.existsSync(cpPath)) cp = readCheckpoint(JSON.parse(fs.readFileSync(cpPath, 'utf8')), docId);
    } catch {
      cp = { doc_id: docId, done: {}, updated_at: 0 }; // 断点损坏 → 从头（不抛，长任务可重跑）
    }

    const saveCheckpoint = async (): Promise<void> => {
      try {
        const fs = await import('node:fs');
        fs.mkdirSync(cfg.checkpointsDir, { recursive: true });
        cp.updated_at = Date.now();
        fs.writeFileSync(cpPath, JSON.stringify(cp), 'utf8');
      } catch {
        /* 断点写失败不该让任务失败；下次会重算这一批 */
      }
    };

    // ── 能力真探测（R2：不只看"配了 key"）──
    let llmOk = completeJson !== null;
    let llmReason = completeJson ? '' : '未注入 LLM（providers 不可用）';
    if (deps.availability) {
      try {
        const av = await deps.availability();
        llmOk = llmOk && av.ok;
        if (!av.ok) llmReason = av.reason || 'LLM 真探测未通过';
      } catch (err) {
        llmOk = false;
        llmReason = `LLM 探测抛错：${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const maxNodes = deps.maxNodesPerRun && deps.maxNodesPerRun > 0 ? deps.maxNodesPerRun : 0;
    /**
     * 已完成（LLM）的不重算；deterministic 的**允许重算**（LLM 恢复后应升级它）。
     *
     * ⚠️ **必须同时满足两个条件才算"已完成"**：断点说 llm **且** `meta.rollup` 里真有非空 intro。
     *
     * 原错误写法：只看 `cp.done[id].source === 'llm'`。断点文件与 `meta.rollup` 是**两个独立的存储**
     * （断点在 `checkpoints/`，内容在 DB 的 `documents.meta_json`），它们会不同步
     * （实测复现：换了 DB 副本但断点仍在 → 断点说 9 个 llm，实际 meta 里只有 3 个）。
     * 后果有两层，都属于"报告了没发生的事"：
     *   ① 被跳过的节点在本轮**不会**从 LLM 重新生成，收尾时被静默改写成确定性 intro → LLM 成果丢失；
     *   ② 统计从断点算 → 报 `llm_generated: 9`，而页面上真正能读到的只有 3 条。
     * ⟹ 判据改为**以内容为准**（`meta.rollup`），断点只作提示。
     */
    const hasLlmIntro = (id: string): boolean => {
      const e = asRecord(rollup[id]);
      return Boolean(e && typeof e.intro === 'string' && e.intro.trim() && e.source === ROLLUP_SOURCE.llm);
    };
    const doneIds = new Set(
      Object.entries(cp.done)
        .filter(([id, v]) => v.source === ROLLUP_SOURCE.llm && hasLlmIntro(id))
        .map(([id]) => id),
    );

    let todo = order.filter((n) => !doneIds.has(n.unit.id));
    if (maxNodes > 0) todo = todo.slice(0, maxNodes);

    let llmUsed = 0;
    let deterministic = 0;
    let failed = 0;
    /** worker 调用失败次数（批级）。用于如实区分"worker 全程不可用"与"偶发失败若干批"。 */
    let workerFailures = 0;
    const failures: string[] = [];

    // ── 无 LLM：**整篇确定性回退**（不产假 intro，如实标 source）──
    if (!llmOk) {
      ctx.log(`LLM 不可用（${llmReason}）→ 使用确定性回退，不生成模型摘要`, 'warn');
      let preserved = 0;
      for (const n of allInternal) {
        // ⚠️ **不覆盖已有的 LLM 结果**：LLM 这次不可用（如短暂欠费）不代表上次的成果作废。
        //    原错误写法：无条件整篇改写 → 一次配额抖动就把之前花掉的 LLM 调用全抹掉。
        if (hasLlmIntro(n.unit.id)) {
          preserved += 1;
          continue;
        }
        rollup[n.unit.id] = {
          intro: deterministicIntro(n, nodes, subtreeCards.get(n.unit.id) ?? 0),
          why_important: '',
          objectives: [],
          key_takeaways: [],
          source: ROLLUP_SOURCE.deterministic,
          depth: n.depth,
          at: Date.now(),
        } satisfies RollupEntry;
        cp.done[n.unit.id] = { intro_len: 0, source: ROLLUP_SOURCE.deterministic, at: Date.now() };
        deterministic += 1;
      }
      repo.mergeDocumentMeta(docId, { rollup });
      await saveCheckpoint();
      ctx.progress(1, '完成（确定性回退）');
      return {
        rollup: {
          llm_configured: completeJson !== null,
          llm_available: false,
          reason: llmReason,
          internal_nodes: allInternal.length,
          // 如实：本轮没生成，但库里可能保留了上次的 LLM 成果
          llm_generated: preserved,
          preserved_from_previous_run: preserved,
          deterministic: internalNodes(nodes).length - preserved,
          with_intro: allInternal.length,
          intro_coverage: allInternal.length > 0 ? 1 : 0,
          intro_sources: { deterministic: allInternal.length - preserved, llm: preserved },
        },
      };
    }

    // ── 逐层（深→浅）跑；**每层结束落盘**，保证父节点能看到子节点结果 ──
    // ★ 走到这里 `llmOk === true`，也就意味着 `completeJson !== null`；
    //   显式断言一次，让 TS 在循环内收窄（否则每个调用点都报 TS18047）。
    const callJson: CompleteJsonFn = completeJson as CompleteJsonFn;
    const byDepth = new Map<number, TreeNode[]>();
    for (const n of todo) {
      const list = byDepth.get(n.depth) ?? [];
      list.push(n);
      byDepth.set(n.depth, list);
    }
    const depths = [...byDepth.keys()].sort((a, b) => b - a); // 深 → 浅

    let processed = 0;
    for (const depth of depths) {
      if (ctx.signal.aborted) break;
      const layer = byDepth.get(depth) ?? [];

      // 本层的**全部** nodes（不截断、不采样）；子节点摘要按上限截断并**如实标注省略数**
      const allPlanNodes = layer.map((n) => {
        const capped = childPayloadsCapped(n, nodes, subtreeCards, summarySources());
        return {
          id: n.unit.id,
          title: n.unit.title,
          level: n.unit.level,
          self_intro: (n.unit.text ?? '').slice(0, 800),
          n_children_total: capped.total,
          ...(capped.total > capped.children.length
            ? { children_note: `另有 ${capped.total - capped.children.length} 个小节未列出（仅列前 ${capped.children.length} 个）` }
            : {}),
          children: capped.children,
        };
      });
      // ★ 按**字节预算**分批：Windows argv 约 32 KB 上限（实测 ENAMETOOLONG），
      //   而真实文档单层可达 250–290 KB。见 `MAX_PLAN_PAYLOAD_BYTES` 的实测表。
      const byId = new Map(layer.map((n) => [n.unit.id, n]));
      const nodeBatches = batchByPayloadBytes(allPlanNodes);

      for (const planNodes of nodeBatches) {
      if (ctx.signal.aborted) break;
      const batch = planNodes.map((p) => byId.get(String(p.id))).filter((x): x is TreeNode => Boolean(x));
      if (batch.length === 0) continue;

      let plan: RollupPlanResult;
      try {
        const raw = await runner({ job: 'rollup.plan', input: { nodes: planNodes }, signal: ctx.signal });
        plan = raw as unknown as RollupPlanResult;
      } catch (err) {
        /**
         * ⚠️ **批级失败不得中止整篇**（长任务断点友好）。
         *
         * 原错误写法：这里直接 `for (allInternal) 全篇确定性回退 + return`。
         * 实测后果（refman 376 节点，真实 21 分钟跑）：worker 在某一批**偶发**退出码 1
         * （`worker 异常退出（exit code 1）`）→ **后续所有批全部放弃**，
         * 最终 `worker_ok:false` 且 156/376 个节点退化成确定性，而本来大部分能跑成。
         *
         * 正确行为：只把**这一批**退化为确定性，记录失败，**继续跑剩下的批**；
         * 只有"第一批就失败且从未成功过"才可能是真的 worker 不可用（那时也会如实报 worker_ok）。
         */
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`rollup.plan 失败（本批 ${batch.length} 个节点）：${msg} → 本批确定性回退`, 'warn');
        if (failures.length < 20) failures.push(`rollup.plan: ${msg}`);
        workerFailures += 1;
        failed += batch.length;
        for (const n of batch) {
          // 不覆盖已有的 LLM 成果（与"LLM 不可用"分支同一条纪律）
          if (hasLlmIntro(n.unit.id)) continue;
          rollup[n.unit.id] = {
            intro: deterministicIntro(n, nodes, subtreeCards.get(n.unit.id) ?? 0),
            why_important: '', objectives: [], key_takeaways: [],
            source: ROLLUP_SOURCE.deterministic, depth: n.depth, at: Date.now(),
          } satisfies RollupEntry;
          cp.done[n.unit.id] = { intro_len: 0, source: ROLLUP_SOURCE.deterministic, at: Date.now() };
        }
        // 本批落盘后**继续下一批**
        repo.mergeDocumentMeta(docId, { rollup });
        await saveCheckpoint();
        continue;
      }

      if (!Array.isArray(plan.items) || plan.items.length === 0) {
        // 实测教训（Lead）：**不能只看长度就当成功**。这里如实报失败，不做假成功。
        const msg = `rollup.plan 返回 0 个 item（nodes_total=${plan.nodes_total ?? '?'}）；可能 nodes 不完整`;
        ctx.log(msg, 'error');
        failed += batch.length;
        failures.push(msg);
        continue;
      }

      // ★ schema 是**裸** JSON Schema → 包装层由我们补（Lead 实测踩过这个坑）
      const schemaWrapped = { name: 'section_rollup', schema: plan.schema };
      const payloads: { key: string; data: unknown }[] = [];
      /** 本层的降级信息（如实上报到 `detail` 与每个节点） */
      let layerUsedProvider = '';
      let layerDegradedFrom = '';
      let layerDegradedReason = '';

      for (const item of plan.items) {
        if (ctx.signal.aborted) break;
        try {
          const res = await callJson({
            messages: [
              { role: 'system', content: item.system },
              { role: 'user', content: item.user },
            ],
            schema: schemaWrapped,
            temperature: 0,
            maxTokens: 2048,
            signal: ctx.signal,
          });
          payloads.push({ key: item.key, data: res.data });
          llmUsed += 1;
          // ★ 这里**不写** rollup 条目：真正的内容由本层末尾的 `rollup.convert` 产出。
          //   原错误写法：先塞一个 `intro:''` 的占位条目 —— 会让后续"是否有 intro"的判断
          //   短暂为真，可能把空 intro 当成已完成（就是 outline 会显示空话的那类 bug）。
          //   若 convert 整层失败，末尾的统一兜底会补确定性 intro，**不留空**。
          if (res.usedProvider) layerUsedProvider = res.usedProvider;
          if (res.degradedFrom) {
            layerDegradedFrom = res.degradedFrom;
            layerDegradedReason = res.degradedReason ?? '';
          }
        } catch (err) {
          // 单节点失败不放弃整篇（断点友好），但**如实记录**（不产假数据）
          failed += 1;
          const msg = `node ${item.node_id}: ${err instanceof Error ? err.message : String(err)}`;
          if (failures.length < 5) failures.push(msg);
        }
        processed += 1;
        ctx.progress(
          Math.min(0.95, processed / Math.max(1, todo.length)),
          `汇总 L${depth}（${processed}/${todo.length}）`,
          { done: processed, total: todo.length },
        );
      }

      // ── 本层交给 worker 校验 + 转换（唯一实现处）──
      if (payloads.length > 0) {
        try {
          const conv = (await runner({
            job: 'rollup.convert',
            input: { nodes: planNodes, payloads },
            signal: ctx.signal,
          })) as Record<string, unknown>;

          // ★ 看 ok / error_count，不只看数组长度（`E_PICK_KEY` 静默失败教训）
          const ok = conv.ok === true;
          const errorCount = typeof conv.error_count === 'number' ? conv.error_count : 0;
          // 实际实现返回 `rollups`；对 lead 规格里的 `nodes` 做兜底
          const rollupMap = asRecord(conv.rollups) ?? asRecord(conv.nodes) ?? {};
          const converted = Object.keys(rollupMap).length;

          if (!ok && converted === 0) {
            const msg = `rollup.convert 失败：ok=false, error_count=${errorCount}, 转换 0 条`;
            ctx.log(msg, 'error');
            failures.push(msg);
            // 该层退回确定性（**不留空 intro**）
            for (const n of batch) {
              rollup[n.unit.id] = {
                intro: deterministicIntro(n, nodes, subtreeCards.get(n.unit.id) ?? 0),
                why_important: '', objectives: [], key_takeaways: [],
                source: ROLLUP_SOURCE.deterministic, depth: n.depth, at: Date.now(),
              } satisfies RollupEntry;
              cp.done[n.unit.id] = { intro_len: 0, source: ROLLUP_SOURCE.deterministic, at: Date.now() };
            }
          } else {
            if (!ok) {
              failures.push(`rollup.convert 部分失败：error_count=${errorCount}, 成功 ${converted}`);
            }
            let upgraded = 0;
            for (const [nodeId, v] of Object.entries(rollupMap)) {
              const d = asRecord(v) ?? {};
              const intro = typeof d.intro === 'string' ? d.intro : '';
              // ★ 空 intro 视为**无效**，不写入（否则 outline 会显示一句空话）
              if (!intro.trim()) continue;
              const prev = asRecord(rollup[nodeId]) ?? {};
              const entry: RollupEntry = {
                intro,
                why_important: typeof d.why_important === 'string' ? d.why_important : '',
                objectives: asStrArray(d.objectives),
                key_takeaways: asStrArray(d.key_takeaways),
                source: ROLLUP_SOURCE.llm,
                depth: typeof prev.depth === 'number' ? prev.depth : depth,
                at: Date.now(),
              };              if (typeof d.section_role === 'string' && d.section_role) entry.section_role = d.section_role;
              // 降级信息来自本层真实的 provider 调用（**如实上报**，不假装没降级）
              if (layerUsedProvider) entry.used_provider = layerUsedProvider;
              if (layerDegradedFrom) {
                entry.degraded_from = layerDegradedFrom;
                entry.degraded_reason = layerDegradedReason;
              }
              rollup[nodeId] = entry;
              cp.done[nodeId] = { intro_len: intro.length, source: ROLLUP_SOURCE.llm, at: Date.now() };
              upgraded += 1;
            }
            // 模型没回传的节点 → 确定性兜底（保证"可见节点 100% 有 intro"）
            for (const n of batch) {
              if (cp.done[n.unit.id]?.source === ROLLUP_SOURCE.llm) continue;
              const entry = asRecord(rollup[n.unit.id]);
              if (entry && typeof entry.intro === 'string' && entry.intro.trim()) continue;
              rollup[n.unit.id] = {
                intro: deterministicIntro(n, nodes, subtreeCards.get(n.unit.id) ?? 0),
                why_important: '', objectives: [], key_takeaways: [],
                source: ROLLUP_SOURCE.deterministic, depth: n.depth, at: Date.now(),
              } satisfies RollupEntry;
              cp.done[n.unit.id] = { intro_len: 0, source: ROLLUP_SOURCE.deterministic, at: Date.now() };
            }
            void upgraded;
          }
        } catch (err) {
          const msg = `rollup.convert 调用失败：${err instanceof Error ? err.message : String(err)}`;
          ctx.log(msg, 'warn');
          failures.push(msg);
          for (const n of batch) {
            if (cp.done[n.unit.id]?.source === ROLLUP_SOURCE.llm) continue;
            rollup[n.unit.id] = {
              intro: deterministicIntro(n, nodes, subtreeCards.get(n.unit.id) ?? 0),
              why_important: '', objectives: [], key_takeaways: [],
              source: ROLLUP_SOURCE.deterministic, depth: n.depth, at: Date.now(),
            } satisfies RollupEntry;
            cp.done[n.unit.id] = { intro_len: 0, source: ROLLUP_SOURCE.deterministic, at: Date.now() };
          }
        }
      }

      // ★ 每批落盘：父节点的输入依赖子节点的输出 → 必须先持久化本批
      //   （同一层的批之间无依赖，但跨层有 —— 所以落盘放在批末尾最稳）
      repo.mergeDocumentMeta(docId, { rollup });
      await saveCheckpoint();
      }
    }

    // ── 收尾：保证**每个内部节点都有 intro**（无 intro 的用确定性补齐）──
    for (const n of allInternal) {
      const e = asRecord(rollup[n.unit.id]);
      if (e && typeof e.intro === 'string' && e.intro.trim()) continue;
      rollup[n.unit.id] = {
        intro: deterministicIntro(n, nodes, subtreeCards.get(n.unit.id) ?? 0),
        why_important: '', objectives: [], key_takeaways: [],
        source: ROLLUP_SOURCE.deterministic, depth: n.depth, at: Date.now(),
      } satisfies RollupEntry;
      if (!cp.done[n.unit.id]) {
        cp.done[n.unit.id] = { intro_len: 0, source: ROLLUP_SOURCE.deterministic, at: Date.now() };
      }
    }

    repo.mergeDocumentMeta(docId, { rollup });
    await saveCheckpoint();

    // ── 统计（**以落库内容为准**，不是以断点为准）──
    // ⚠️ 原错误写法：从 `cp.done[...].source` 统计。断点与 `meta.rollup` 是两个独立存储，
    //    不同步时统计会报出**页面上读不到的数字**（实测：报 llm=9，meta 里只有 3）。
    //    ⟹ 统计必须扫 `rollup`（即真正会写进 meta 的那份）。
    const entries = allInternal.map((n) => asRecord(rollup[n.unit.id]) ?? {});
    const generated = entries.filter((e) => e.source === ROLLUP_SOURCE.llm
      && typeof e.intro === 'string' && e.intro.trim().length > 0);
    const det = entries.filter((e) => e.source === ROLLUP_SOURCE.deterministic
      && typeof e.intro === 'string' && e.intro.trim().length > 0);
    const withIntro = entries.filter((e) => typeof e.intro === 'string' && e.intro.trim().length > 0);

    ctx.progress(1, '完成');
    return {
      rollup: {
        llm_configured: true,
        llm_available: true,
        // worker_ok = **所有** worker 调用都成功（有偶发失败就如实 false，不粉饰）
        worker_ok: workerFailures === 0,
        ...(workerFailures > 0 ? { worker_failed_batches: workerFailures } : {}),
        internal_nodes: allInternal.length,
        layers: depths.length,
        llm_generated: generated.length,
        deterministic: det.length,
        llm_calls: llmUsed,
        failed,
        with_intro: withIntro.length,
        intro_coverage: allInternal.length > 0 ? withIntro.length / allInternal.length : 0,
        intro_sources: { llm: generated.length, deterministic: det.length },
        ...(failures.length > 0 ? { failures } : {}),
      },
    };
  };
}

/** 供其它模块读 `meta.rollup` 的一致入口（避免各处自己 asRecord）。 */
export function readRollupMeta(meta: Record<string, unknown>): Record<string, RollupEntry> {
  const raw = asRecord(meta.rollup) ?? {};
  const out: Record<string, RollupEntry> = {};
  for (const [k, v] of Object.entries(raw)) {
    const o = asRecord(v);
    if (!o || typeof o.intro !== 'string') continue;
    out[k] = o as unknown as RollupEntry;
  }
  return out;
}
