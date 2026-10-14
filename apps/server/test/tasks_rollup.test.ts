/**
 * `rollup` 测试（F3 全层级摘要，S2 自底向上）。
 *
 * 全部断言**具体值**（AGENTS.md §7 质量门），不用"非空"蒙混。
 *
 * 覆盖四条最关键的路径：
 * 1. **自底向上顺序**：父节点的输入里必须**已经含子节点的 LLM 摘要**（这是 F3 的核心）
 * 2. **断点续跑**：中断后续跑**不重算**已完成的节点
 * 3. **无 LLM 如实降级**：不产假 intro，标 `deterministic`，覆盖率仍 100%
 * 4. **`ok`/`error_count` 判定**：`converted==0` 且有 payload = 失败（不是"这篇没内容"）
 *
 * 用**假 runner**（不真起 python）+ **真 SQLite**（`:memory:`）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { createRollupHandler, batchByPayloadBytes, childPayloadsCapped, buildTree, bottomUpOrder, deterministicIntro, internalNodes, resolveChildSummary, ROLLUP_SOURCE } from '../src/tasks/rollup.ts';
import type { CompleteJsonFn } from '../src/tasks/extract.ts';
import type { WorkerRunner } from '../src/worker/runner.ts';
import type { TaskHandlerContext } from '../src/tasks/queue.ts';
import type { ServerConfig } from '../src/config.ts';

// ═══════════════════════════════════════════════════════════════════════
// 测试脚手架
// ═══════════════════════════════════════════════════════════════════════

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rollup-test-'));
}

function freshCfg(dir: string): ServerConfig {
  return {
    checkpointsDir: path.join(dir, 'checkpoints'),
  } as unknown as ServerConfig;
}

function freshRepo(): { db: Db; repo: Repo } {
  const db = Db.open(':memory:');
  return { db, repo: new Repo(db) };
}

/** 三层结构：L1 根 → 2 个 L2 → 3 个 L3 叶子。内部节点 = 3 个。 */
function seedDoc(repo: Repo): string {
  const docId = repo.insertDocument({
    title: '测试文档',
    kind: 'pdf',
    source_path: 'data/uploads/x/a.pdf',
    page_count: 20,
  });
  repo.replaceUnits(docId, [
    { ord: 1, title: '第一章 总览', level: 1, parent_ord: null, span: { kind: 'page', start: 1, end: 20 }, text: '第一章正文。' },
    { ord: 2, title: '1.1 索引', level: 2, parent_ord: 1, span: { kind: 'page', start: 1, end: 10 }, text: '索引正文。' },
    { ord: 3, title: '1.1.1 聚簇索引', level: 3, parent_ord: 2, span: { kind: 'page', start: 1, end: 5 }, text: '聚簇索引叶子正文。' },
    { ord: 4, title: '1.1.2 二级索引', level: 3, parent_ord: 2, span: { kind: 'page', start: 6, end: 10 }, text: '二级索引叶子正文。' },
    { ord: 5, title: '1.2 事务', level: 2, parent_ord: 1, span: { kind: 'page', start: 11, end: 20 }, text: '事务正文。' },
    { ord: 6, title: '1.2.1 隔离级别', level: 3, parent_ord: 5, span: { kind: 'page', start: 11, end: 20 }, text: '隔离级别叶子正文。' },
  ]);
  repo.replaceCards(docId, [
    { unit_id: repo.allUnitRows(docId)[2]!.id, name: '聚簇索引', kind: 'concept', evidence_quote: 'q1' },
    { unit_id: repo.allUnitRows(docId)[3]!.id, name: '二级索引', kind: 'concept', evidence_quote: 'q2' },
  ]);
  return docId;
}

/** 造一个 ctx（只实现被测代码真正用的四个方法）。 */
function makeCtx(docId: string, opts: { aborted?: boolean } = {}): {
  ctx: TaskHandlerContext;
  events: { frac: number; stage: string }[];
  logs: string[];
} {
  const events: { frac: number; stage: string }[] = [];
  const logs: string[] = [];
  const ac = new AbortController();
  if (opts.aborted) ac.abort();
  const ctx: TaskHandlerContext = {
    taskId: 't1',
    docId,
    kind: 'rollup',
    params: {},
    signal: ac.signal,
    progress: (frac, stage) => events.push({ frac, stage }),
    log: (msg) => logs.push(msg),
    artifact: () => {},
  };
  return { ctx, events, logs };
}

/**
 * 假 worker：实现 `rollup.plan` / `rollup.convert` 的**真实形状**。
 *
 * `plan` 产出裸 schema + 每个节点的 system/user（**这里是真的从子节点摘要拼的**，
 * 以便断言"父节点输入含子节点摘要"）。
 * `convert` 从 payloads 的 `data` 里取字段，按真实实现返回 `rollups`。
 */
function fakeRunner(rec: { planCalls: { nodes: Record<string, unknown>[] }[] }): WorkerRunner {
  return async (job) => {
    if (job.job === 'rollup.plan') {
      const nodes = (job.input.nodes ?? []) as Record<string, unknown>[];
      rec.planCalls.push({ nodes });
      return {
        order: 'caller',
        // ★ 裸 schema（无 name / 无 schema 包装）—— 与 worker 实测一致
        schema: {
          type: 'object',
          properties: {
            intro: { type: 'string' },
            why_important: { type: 'string' },
            key_takeaways: { type: 'array', items: { type: 'string' } },
            objectives: { type: 'array', items: { type: 'string' } },
          },
        },
        items: nodes.map((n) => ({
          key: `${String(n.id)}#node`,
          node_id: String(n.id),
          title: String(n.title ?? ''),
          level: Number(n.level ?? 1),
          system: 'SYS',
          // user 里嵌子节点摘要 → 测试据此断言"父节点看到了子节点的摘要"
          user: `USER|title=${String(n.title)}|children=${JSON.stringify(n.children ?? [])}`,
        })),
        nodes_total: nodes.length,
        internal_nodes: nodes.length,
      };
    }
    if (job.job === 'rollup.convert') {
      const payloads = (job.input.payloads ?? []) as { key: string; data: unknown }[];
      const rollups: Record<string, unknown> = {};
      const errors: unknown[] = [];
      for (const p of payloads) {
        const nodeId = String(p.key).replace(/#node$/, '');
        const d = (p.data ?? {}) as Record<string, unknown>;
        if (typeof d.intro !== 'string' || !d.intro) {
          errors.push({ code: 'E_ROLLUP_SCHEMA', node_id: nodeId, msg: "$: 缺必填字段 'intro'" });
          continue;
        }
        rollups[nodeId] = {
          intro: d.intro,
          why_important: typeof d.why_important === 'string' ? d.why_important : '',
          objectives: Array.isArray(d.objectives) ? d.objectives : [],
          key_takeaways: Array.isArray(d.key_takeaways) ? d.key_takeaways : [],
        };
      }
      return { ok: errors.length === 0, error_count: errors.length, rollups, converted: Object.keys(rollups).length, errors };
    }
    throw new Error(`未预期的 job: ${job.job}`);
  };
}

/** 假 LLM：回一条稳定可断言的 intro，且把 user 里的 children 摘要**回抄**进 intro。 */
function fakeCompleteJson(rec: { users: string[]; calls: number }): CompleteJsonFn {
  return async (req) => {
    rec.calls += 1;
    const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
    rec.users.push(user);
    const title = /title=([^|]*)/.exec(user)?.[1] ?? '?';
    const children = /children=(\[.*\])$/.exec(user)?.[1] ?? '[]';
    let kids: { intro?: string }[] = [];
    try {
      kids = JSON.parse(children) as { intro?: string }[];
    } catch {
      kids = [];
    }
    const childIntros = kids.map((k) => k.intro ?? '').join(' / ');
    return {
      data: {
        intro: `【${title}】子摘要=${childIntros}`,
        why_important: `${title} 很重要`,
        key_takeaways: ['要点1', '要点2'],
        objectives: ['能说明'],
      },
      usedProvider: 'amr',
    };
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 纯函数：树与顺序
// ═══════════════════════════════════════════════════════════════════════

test('buildTree：深度与子树高度；内部节点 = 有子节点的节点', () => {
  const { repo } = freshRepo();
  const docId = seedDoc(repo);
  const nodes = buildTree(repo.allUnitRows(docId));

  assert.equal(nodes.size, 6);
  // 根 depth=0；叶子 depth=2
  assert.equal(nodes.get(repo.allUnitRows(docId)[0]!.id)!.depth, 0);
  assert.equal(nodes.get(repo.allUnitRows(docId)[2]!.id)!.depth, 2);
  // 根 height=2（最深两层）
  assert.equal(nodes.get(repo.allUnitRows(docId)[0]!.id)!.height, 2);
  // 叶子 height=0
  assert.equal(nodes.get(repo.allUnitRows(docId)[2]!.id)!.height, 0);

  // 内部节点：根 + 1.1 + 1.2 = 3（叶子不算，叶子摘要由 S1 顺带产出）
  assert.equal(internalNodes(nodes).length, 3);
});

test('bottomUpOrder：**从深到浅**（L2 先于 L1）—— 这是"自底向上"的定义', () => {
  const { repo } = freshRepo();
  const docId = seedDoc(repo);
  const nodes = buildTree(repo.allUnitRows(docId));
  const order = bottomUpOrder(nodes);

  assert.equal(order.length, 3);
  // 前两个是 depth=1 的（1.1 / 1.2），最后一个是 depth=0 的根
  assert.deepEqual(order.map((n) => n.unit.title), ['1.1 索引', '1.2 事务', '第一章 总览']);
  assert.deepEqual(order.map((n) => n.depth), [1, 1, 0]);
});

test('deterministicIntro：由**子节点标题**拼出（不是模型编的话）', () => {
  const { repo } = freshRepo();
  const docId = seedDoc(repo);
  const nodes = buildTree(repo.allUnitRows(docId));
  const root = nodes.get(repo.allUnitRows(docId)[0]!.id)!;

  assert.equal(deterministicIntro(root, nodes, 2), '本节包含 1.1 索引、1.2 事务。（该节点及其子节点共 2 个知识点）');
  // 无卡片时不带括号尾巴
  assert.equal(deterministicIntro(root, nodes, 0), '本节包含 1.1 索引、1.2 事务。');
});

test('resolveChildSummary：**只取已存在的摘要，不读原文**（F3 的核心约束）', () => {
  // ① manual 优先
  assert.deepEqual(
    resolveChildSummary('u1', { manualIntros: { u1: { intro: '手写' } }, sections: { u1: { section_summary: 'S1' } }, rollup: { u1: { intro: 'R' } } }).intro_source,
    'manual',
  );
  // ② 无 manual → section_summary
  assert.deepEqual(
    resolveChildSummary('u1', { manualIntros: {}, sections: { u1: { section_summary: 'S1' } }, rollup: { u1: { intro: 'R' } } }).intro_source,
    'section_summary',
  );
  // ③ 无 section → 已算出的 rollup（**父节点用的就是这一档**）
  const r = resolveChildSummary('u1', { manualIntros: {}, sections: {}, rollup: { u1: { intro: 'R', key_takeaways: ['k1', 'k2', 'k3', 'k4'] } } });
  assert.equal(r.intro_source, 'rollup');
  assert.equal(r.intro, 'R');
  assert.deepEqual(r.key_takeaways, ['k1', 'k2', 'k3']);   // 只取前 3
  // ④ 三者都没有 → 如实说"无摘要"，**不编**
  const none = resolveChildSummary('u1', { manualIntros: {}, sections: {}, rollup: {} });
  assert.equal(none.intro, '（无摘要）');
  assert.equal(none.intro_source, 'none');
});

// ═══════════════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════════════

test('★ 自底向上：父节点的输入里**必须已含子节点的 LLM 摘要**', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const docId = seedDoc(repo);
  const rec = { planCalls: [] as { nodes: Record<string, unknown>[] }[] };
  const llmRec = { users: [] as string[], calls: 0 };

  const handler = createRollupHandler({
    repo,
    db: repo.db,
    cfg: freshCfg(dir),
    runner: fakeRunner(rec),
    completeJson: fakeCompleteJson(llmRec),
    availability: async () => ({ ok: true, reason: '' }),
  });

  const { ctx } = makeCtx(docId);
  const out = (await handler(ctx)) as { rollup: Record<string, unknown> };
  const r = out.rollup;

  // 3 个内部节点全部生成（1.1 / 1.2 / 根）
  assert.equal(r.internal_nodes, 3);
  assert.equal(r.llm_generated, 3);
  assert.equal(r.deterministic, 0);
  assert.equal(r.with_intro, 3);
  assert.equal(r.intro_coverage, 1);
  assert.equal(r.llm_calls, 3);
  assert.deepEqual(r.intro_sources, { llm: 3, deterministic: 0 });

  // ★ plan 被调用 2 次：depth=1 一批、depth=0 一批（分批 = 分层）
  assert.equal(rec.planCalls.length, 2);

  // ★ 第二批（depth=0，即根）的 children 摘要里必须含**第一批产出的 LLM intro**
  const secondBatch = rec.planCalls[1]!;
  assert.equal(secondBatch.nodes.length, 1);
  const rootChildren = secondBatch.nodes[0]!.children as { intro: string; intro_source?: string }[];
  assert.equal(rootChildren.length, 2);
  // 子节点的 intro 必须来自 rollup（不是"（无摘要）"，也不是原文）
  assert.deepEqual(rootChildren.map((c) => c.intro_source), ['rollup:llm', 'rollup:llm']);
  assert.match(rootChildren[0]!.intro, /【1\.1 索引】/);
  assert.match(rootChildren[1]!.intro, /【1\.2 事务】/);

  // ★ 根自己的 intro 里应含**子节点 intro 的文本**（证明真的自底向上传递了）
  const stored = JSON.parse(repo.getDocumentRow(docId)!.meta_json) as { rollup: Record<string, Record<string, unknown>> };
  const rootId = repo.allUnitRows(docId)[0]!.id;
  const rootEntry = stored.rollup[rootId]!;
  assert.equal(rootEntry.source, ROLLUP_SOURCE.llm);
  assert.match(String(rootEntry.intro), /【第一章 总览】子摘要=/);
  assert.match(String(rootEntry.intro), /【1\.1 索引】/, '根的 intro 必须含子节点摘要（自底向上生效）');
  assert.match(String(rootEntry.intro), /【1\.2 事务】/);
  assert.equal(rootEntry.used_provider, 'amr');
  assert.deepEqual(rootEntry.key_takeaways, ['要点1', '要点2']);
  assert.deepEqual(rootEntry.objectives, ['能说明']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ 断点续跑：已完成（LLM）的节点**不重算**', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const docId = seedDoc(repo);

  // 第一轮：全跑
  const rec1 = { planCalls: [] as { nodes: Record<string, unknown>[] }[] };
  const h1 = createRollupHandler({
    repo, db: repo.db, cfg: freshCfg(dir), runner: fakeRunner(rec1),
    completeJson: fakeCompleteJson({ users: [], calls: 0 }),
    availability: async () => ({ ok: true, reason: '' }),
  });
  const out1 = (await h1(makeCtx(docId).ctx)) as { rollup: Record<string, unknown> };
  assert.equal(out1.rollup.llm_generated, 3);

  // 断点文件确实存在
  const cpPath = path.join(dir, 'checkpoints', `${docId}_rollup.json`);
  assert.equal(fs.existsSync(cpPath), true);
  const cp = JSON.parse(fs.readFileSync(cpPath, 'utf8')) as { done: Record<string, { source: string }> };
  assert.equal(Object.keys(cp.done).length, 3);
  assert.deepEqual(Object.values(cp.done).map((d) => d.source), ['llm', 'llm', 'llm']);

  // 第二轮：**一次 LLM 都不该调**
  const rec2 = { planCalls: [] as { nodes: Record<string, unknown>[] }[] };
  const llm2 = { users: [] as string[], calls: 0 };
  const h2 = createRollupHandler({
    repo, db: repo.db, cfg: freshCfg(dir), runner: fakeRunner(rec2),
    completeJson: fakeCompleteJson(llm2),
    availability: async () => ({ ok: true, reason: '' }),
  });
  const out2 = (await h2(makeCtx(docId).ctx)) as { rollup: Record<string, unknown> };

  assert.equal(llm2.calls, 0, '全部已完成 → 不应再调 LLM');
  assert.equal(rec2.planCalls.length, 0, '没有 todo 时连 plan 都不该调');
  assert.equal(out2.rollup.llm_generated, 3, '已完成的仍算作 LLM 生成（连点保留）');
  assert.equal(out2.rollup.with_intro, 3);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ 无 LLM：**不产假 intro**，标 deterministic，覆盖率仍 100%', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const docId = seedDoc(repo);
  const rec = { planCalls: [] as { nodes: Record<string, unknown>[] }[] };

  const handler = createRollupHandler({
    repo, db: repo.db, cfg: freshCfg(dir), runner: fakeRunner(rec),
    completeJson: null,                        // ← 无 LLM
    availability: async () => ({ ok: false, reason: 'quota exhausted' }),
  });

  const { ctx, logs } = makeCtx(docId);
  const out = (await handler(ctx)) as { rollup: Record<string, unknown> };
  const r = out.rollup;

  assert.equal(r.llm_configured, false);
  assert.equal(r.llm_available, false);
  assert.equal(r.reason, 'quota exhausted');
  assert.equal(r.llm_generated, 0);
  assert.equal(r.deterministic, 3);
  // ★ 覆盖率仍 100%（F3 验收：可见节点 100% 有 intro）
  assert.equal(r.with_intro, 3);
  assert.equal(r.intro_coverage, 1);
  // 连 plan 都不该调（没有 LLM 就没有意义）
  assert.equal(rec.planCalls.length, 0);
  assert.equal(logs.some((l) => l.includes('确定性回退')), true);

  // 库里的 intro 是**确定性文本**，不是模型编的
  const stored = JSON.parse(repo.getDocumentRow(docId)!.meta_json) as { rollup: Record<string, Record<string, unknown>> };
  const rootId = repo.allUnitRows(docId)[0]!.id;
  assert.equal(stored.rollup[rootId]!.source, 'deterministic');
  assert.equal(stored.rollup[rootId]!.intro, '本节包含 1.1 索引、1.2 事务。（该节点及其子节点共 2 个知识点）');
  assert.equal(stored.rollup[rootId]!.why_important, '', '不确定性编 why');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ `ok=false` 且 converted=0 → 失败并**退回确定性**（不产假数据）', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const docId = seedDoc(repo);

  // 假 runner：plan 正常，但 convert 全失败（ok=false, converted=0）
  const runner: WorkerRunner = async (job) => {
    if (job.job === 'rollup.plan') {
      const nodes = (job.input.nodes ?? []) as Record<string, unknown>[];
      return {
        schema: { type: 'object', properties: { intro: { type: 'string' } } },
        items: nodes.map((n) => ({ key: `${String(n.id)}#node`, node_id: String(n.id), system: 'S', user: 'U' })),
      };
    }
    // convert：模拟 worker 的 E_ROLLUP_SCHEMA 全失败
    return { ok: false, error_count: 3, rollups: {}, converted: 0, errors: [{ code: 'E_ROLLUP_SCHEMA' }] };
  };

  const handler = createRollupHandler({
    repo, db: repo.db, cfg: freshCfg(dir), runner,
    completeJson: async () => ({ data: { intro: 'x', why_important: '', key_takeaways: [], objectives: [] } }),
    availability: async () => ({ ok: true, reason: '' }),
  });

  const { ctx, logs } = makeCtx(docId);
  const out = (await handler(ctx)) as { rollup: Record<string, unknown> };
  const r = out.rollup;

  // 不能因为"LLM 调成功了"就报成功 —— 转换失败必须如实反映
  assert.equal(r.llm_generated, 0);
  assert.equal(r.deterministic, 3);
  assert.equal(r.with_intro, 3, '转换失败也要有 intro（确定性兜底），不能留空');
  assert.equal(r.intro_coverage, 1);
  assert.equal(Array.isArray(r.failures), true);
  assert.match(String((r.failures as string[])[0]), /rollup\.convert 失败/);
  assert.equal(logs.some((l) => l.includes('rollup.convert 失败')), true);

  // 库里是 deterministic，**不是** 'x'（模型给的假值没被写入）
  const stored = JSON.parse(repo.getDocumentRow(docId)!.meta_json) as { rollup: Record<string, Record<string, unknown>> };
  const rootId = repo.allUnitRows(docId)[0]!.id;
  assert.equal(stored.rollup[rootId]!.source, 'deterministic');
  assert.equal(stored.rollup[rootId]!.intro, '本节包含 1.1 索引、1.2 事务。（该节点及其子节点共 2 个知识点）');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ `plan` 返回 0 item → 如实记失败（不把"空"当成功）', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const docId = seedDoc(repo);

  const runner: WorkerRunner = async () => ({ schema: { type: 'object' }, items: [], nodes_total: 0 });

  const handler = createRollupHandler({
    repo, db: repo.db, cfg: freshCfg(dir), runner,
    completeJson: async () => ({ data: {} }),
    availability: async () => ({ ok: true, reason: '' }),
  });

  const { ctx } = makeCtx(docId);
  const out = (await handler(ctx)) as { rollup: Record<string, unknown> };
  assert.equal(out.rollup.failed, 3);
  // 但仍要有 intro（末尾确定性兜底），且如实标 source
  assert.equal(out.rollup.with_intro, 3);
  assert.equal(out.rollup.deterministic, 3);
  assert.match(String((out.rollup.failures as string[])[0]), /0 个 item/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ worker 不可用（rollup.plan 抛错）→ 确定性回退 + worker_ok=false', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const docId = seedDoc(repo);

  const runner: WorkerRunner = async (job) => {
    throw new Error(`worker job ${job.job} 失败`);
  };

  const handler = createRollupHandler({
    repo, db: repo.db, cfg: freshCfg(dir), runner,
    completeJson: async () => ({ data: { intro: 'x' } }),
    availability: async () => ({ ok: true, reason: '' }),
  });

  const { ctx } = makeCtx(docId);
  const out = (await handler(ctx)) as { rollup: Record<string, unknown> };
  assert.equal(out.rollup.worker_ok, false);
  assert.equal(out.rollup.worker_failed_batches, 2, '两层各一批，都失败');
  assert.equal(out.rollup.llm_generated, 0);
  assert.equal(out.rollup.deterministic, 3);
  assert.match(String((out.rollup.failures as string[])[0]), /worker job rollup\.plan 失败/);

  // 库里仍然是 deterministic，不是模型给的 'x'
  const stored = JSON.parse(repo.getDocumentRow(docId)!.meta_json) as { rollup: Record<string, Record<string, unknown>> };
  const rootId = repo.allUnitRows(docId)[0]!.id;
  assert.equal(stored.rollup[rootId]!.source, 'deterministic');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('★★ 回归：某批 worker 偶发失败**不得中止其余批**（真实 376 节点跑出来的）', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const docId = seedDoc(repo);

  // 让 depth=1 那一批（最先跑）失败一次，后面的 depth=0 批必须照常跑
  let planCalls = 0;
  const runner: WorkerRunner = async (job) => {
    if (job.job === 'rollup.plan') {
      planCalls += 1;
      if (planCalls === 1) throw new Error('worker 异常退出（exit code 1）');
      const nodes = (job.input.nodes ?? []) as Record<string, unknown>[];
      return {
        schema: { type: 'object', properties: { intro: { type: 'string' } } },
        items: nodes.map((n) => ({
          key: `${String(n.id)}#node`, node_id: String(n.id), system: 'S',
          user: `USER|title=${String(n.title)}`,
        })),
      };
    }
    const payloads = (job.input.payloads ?? []) as { key: string; data: unknown }[];
    const rollups: Record<string, unknown> = {};
    for (const p of payloads) {
      const d = (p.data ?? {}) as Record<string, unknown>;
      rollups[String(p.key).replace(/#node$/, '')] = {
        intro: String(d.intro ?? ''), why_important: '', objectives: [], key_takeaways: [],
      };
    }
    return { ok: true, error_count: 0, rollups, converted: Object.keys(rollups).length };
  };

  const handler = createRollupHandler({
    repo, db: repo.db, cfg: freshCfg(dir), runner,
    completeJson: async () => ({ data: { intro: '【LLM】', why_important: '', objectives: [], key_takeaways: [] } }),
    availability: async () => ({ ok: true, reason: '' }),
  });

  const out = (await handler(makeCtx(docId).ctx)) as { rollup: Record<string, unknown> };

  // ★ 第一批失败后，**后续批仍然跑**（第二次 plan 被调用 = 没有整篇中止）
  assert.equal(planCalls, 2, '第一批失败后第二批仍应被调用');
  assert.equal(out.rollup.llm_generated, 1, '第二批的根节点应该是 LLM 生成');
  assert.equal(out.rollup.with_intro, 3, '全部 3 个内部节点仍有 intro');
  assert.equal(out.rollup.intro_coverage, 1);
  // 如实标注失败批次
  assert.equal(out.rollup.worker_ok, false);
  assert.equal(out.rollup.worker_failed_batches, 1);

  const stored = JSON.parse(repo.getDocumentRow(docId)!.meta_json) as { rollup: Record<string, Record<string, unknown>> };
  const rootId = repo.allUnitRows(docId)[0]!.id;
  assert.equal(stored.rollup[rootId]!.source, 'llm', '第二批次正常完成');
  const u11 = repo.allUnitRows(docId)[1]!.id;
  assert.equal(stored.rollup[u11]!.source, 'deterministic', '第一批退化为确定性');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ section_summaries 存在时，子节点摘要优先用它（不是原文）', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const docId = seedDoc(repo);
  const units = repo.allUnitRows(docId);
  const leafId = units[2]!.id;      // 1.1.1 聚簇索引（叶子）

  // S1 已产出 section_summary
  repo.mergeDocumentMeta(docId, {
    section_summaries: { [leafId]: { section_summary: 'S1 已产出的摘要', key_takeaways: ['t1'] } },
  });

  const rec = { planCalls: [] as { nodes: Record<string, unknown>[] }[] };
  const handler = createRollupHandler({
    repo, db: repo.db, cfg: freshCfg(dir), runner: fakeRunner(rec),
    completeJson: fakeCompleteJson({ users: [], calls: 0 }),
    availability: async () => ({ ok: true, reason: '' }),
  });
  await handler(makeCtx(docId).ctx);

  // 1.1 的 children 里应含 S1 摘要
  const firstBatch = rec.planCalls[0]!;
  const node11 = firstBatch.nodes.find((n) => n.title === '1.1 索引') as {
    children: { intro: string; intro_source?: string; key_takeaways?: string[] }[];
  };
  const c = node11.children.find((x) => x.intro_source === 'section_summary');
  assert.ok(c, '应有一条来自 section_summary 的子节点摘要');
  assert.equal(c!.intro, 'S1 已产出的摘要');
  assert.deepEqual(c!.key_takeaways ?? [], ['t1']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('★★ 回归：断点与 meta.rollup **不同步**时，不丢 LLM 成果、统计不虚报', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const docId = seedDoc(repo);
  const units = repo.allUnitRows(docId);
  const internalIds = [units[1]!.id, units[4]!.id]; // 1.1 与 1.2（depth=1）

  // 构造"断点说 2 个已完成 llm，但 meta.rollup 里一条都没有"的分歧
  // （真实成因：换了 DB 副本/回滚了 meta，而 checkpoints/ 仍在）
  fs.mkdirSync(path.join(dir, 'checkpoints'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'checkpoints', `${docId}_rollup.json`),
    JSON.stringify({
      doc_id: docId,
      done: Object.fromEntries(internalIds.map((id) => [id, { intro_len: 10, source: 'llm', at: Date.now() }])),
      updated_at: Date.now(),
    }),
    'utf8',
  );

  const rec = { planCalls: [] as { nodes: Record<string, unknown>[] }[] };
  const llmRec = { users: [] as string[], calls: 0 };
  const handler = createRollupHandler({
    repo, db: repo.db, cfg: freshCfg(dir), runner: fakeRunner(rec),
    completeJson: fakeCompleteJson(llmRec),
    availability: async () => ({ ok: true, reason: '' }),
  });

  const out = (await handler(makeCtx(docId).ctx)) as { rollup: Record<string, unknown> };

  // ★ 那两个节点**必须被重算**（断点说做过了，但内容不在 → 以内容为准）
  assert.equal(llmRec.calls, 3, '3 个内部节点都应重算（断点的 2 条不作数）');
  assert.equal(rec.planCalls.length, 2);

  // ★ 统计不能虚报：报多少，meta 里就得有多少
  const stored = JSON.parse(repo.getDocumentRow(docId)!.meta_json) as { rollup: Record<string, Record<string, unknown>> };
  const metaLlm = Object.values(stored.rollup).filter((e) => e.source === 'llm' && String(e.intro ?? '').trim()).length;
  assert.equal(out.rollup.llm_generated, 3);
  assert.equal(out.rollup.llm_generated, metaLlm, '统计必须等于 meta 里真实可读的 LLM 条数');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ LLM 本次不可用时，**不抹掉**上次的 LLM 成果（只补缺的）', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const docId = seedDoc(repo);
  const rootId = repo.allUnitRows(docId)[0]!.id;

  // 先正常跑一轮（拿到 3 条 LLM intro）
  const h1 = createRollupHandler({
    repo, db: repo.db, cfg: freshCfg(dir), runner: fakeRunner({ planCalls: [] }),
    completeJson: fakeCompleteJson({ users: [], calls: 0 }),
    availability: async () => ({ ok: true, reason: '' }),
  });
  await h1(makeCtx(docId).ctx);
  const before = JSON.parse(repo.getDocumentRow(docId)!.meta_json) as { rollup: Record<string, Record<string, unknown>> };
  assert.equal(before.rollup[rootId]!.source, 'llm');
  const rootIntroBefore = String(before.rollup[rootId]!.intro);

  // 第二轮：LLM 欠费不可用
  const h2 = createRollupHandler({
    repo, db: repo.db, cfg: freshCfg(dir), runner: fakeRunner({ planCalls: [] }),
    completeJson: fakeCompleteJson({ users: [], calls: 0 }),
    availability: async () => ({ ok: false, reason: 'quota exhausted' }),
  });
  const out2 = (await h2(makeCtx(docId).ctx)) as { rollup: Record<string, unknown> };

  // ★ 上次的 LLM intro **必须原样保留**（配额抖动不该毁掉已花的调用）
  const after = JSON.parse(repo.getDocumentRow(docId)!.meta_json) as { rollup: Record<string, Record<string, unknown>> };
  assert.equal(after.rollup[rootId]!.source, 'llm', 'LLM 成果不能被确定性回退覆盖');
  assert.equal(String(after.rollup[rootId]!.intro), rootIntroBefore, 'intro 逐字不变');

  // 如实上报：本轮 0 生成，但保留 3 条
  assert.equal(out2.rollup.llm_available, false);
  assert.equal(out2.rollup.reason, 'quota exhausted');
  assert.equal(out2.rollup.llm_generated, 3, '如实报"库里保留的 LLM 条数"');
  assert.equal(out2.rollup.preserved_from_previous_run, 3);
  assert.equal(out2.rollup.deterministic, 0);
  assert.equal(out2.rollup.with_intro, 3);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('★★ 回归：单层超过 worker 参数上限时**自动分批**（Windows argv ≈32KB）', async () => {
  const dir = tmpDir();
  const { repo } = freshRepo();
  const docId = seedDoc(repo);

  // 造一棵**同层很宽**的树：根 + 300 个中间节点（各带 1 个叶子）。
  // 这对应真实 refman 的形状（实测 depth=2 有 173 个节点、单层 payload 289.5 KB）。
  // ⚠️ 必须**显式标注元素类型**：否则 TS 由首个元素把 `parent_ord` 推成 `null`，
  //    后续 push `parent_ord: 1` 会报 TS2322（number 不能赋给 null）。
  type Draft = {
    ord: number; title: string; level: number; parent_ord: number | null;
    span: { kind: 'page'; start: number; end: number }; text: string;
  };
  const drafts: Draft[] = [
    { ord: 1, title: '根', level: 1, parent_ord: null, span: { kind: 'page', start: 1, end: 300 }, text: 'r' },
  ];
  for (let i = 0; i < 300; i += 1) {
    drafts.push({
      ord: i * 2 + 2,
      title: `中间${i}`,
      level: 2,
      parent_ord: 1,
      span: { kind: 'page' as const, start: 1, end: 1 },
      text: 'm'.repeat(800),          // 使每个节点的 self_intro 都有 800 字符
    });
    drafts.push({
      ord: i * 2 + 3,
      title: `叶子${i}`,
      level: 3,
      parent_ord: i * 2 + 2,
      span: { kind: 'page' as const, start: 1, end: 1 },
      text: 'l',
    });
  }
  repo.replaceUnits(docId, drafts);

  const rec = { planCalls: [] as { nodes: Record<string, unknown>[] }[] };
  const handler = createRollupHandler({
    repo, db: repo.db, cfg: freshCfg(dir), runner: fakeRunner(rec),
    completeJson: fakeCompleteJson({ users: [], calls: 0 }),
    availability: async () => ({ ok: true, reason: '' }),
  });

  const out = (await handler(makeCtx(docId).ctx)) as { rollup: Record<string, unknown> };

  // 内部节点 = 300 个中间节点 + 根 = 301
  assert.equal(out.rollup.internal_nodes, 301);
  // ★ 关键是 plan **没有**因为参数过大而失败
  assert.equal(out.rollup.worker_ok, true);
  assert.equal(out.rollup.llm_generated, 301, '所有内部节点都要被覆盖（分批不能丢节点）');

  // ★ 每一批都必须在预算内（否则 Windows 上 spawn 会 ENAMETOOLONG）
  const sizes = rec.planCalls.map((c) => JSON.stringify({ nodes: c.nodes }).length);
  for (const bytes of sizes) {
    assert.ok(bytes <= 16 * 1024 + 4096, `单批 payload ${bytes} 字节，超出预算`);
  }
  // 301 个节点 × 800 字符 → 远超 16KB，必须切成多批
  assert.ok(rec.planCalls.length >= 5, `应切成多批，实际 ${rec.planCalls.length} 批`);
  // plan 收到的节点数之和 = 该层节点数（根 1 + 中间 300；叶子只作为 children 出现）
  assert.equal(
    rec.planCalls.reduce((s, c) => s + c.nodes.length, 0),
    301,
    'plan 收到的节点数之和应等于该层节点数',
  );

  // ★ 根节点有 300 个子节点 → children 必须被**截断到上限**，且**如实标注省略数**
  const rootCall = rec.planCalls.find((c) => c.nodes.some((n) => n.title === '根'))!;
  const rootNode = rootCall.nodes.find((n) => n.title === '根') as {
    children: unknown[];
    n_children_total?: number;
    children_note?: string;
  };
  assert.equal(rootNode.children.length, 30, `子节点应截断到 30，实际 ${rootNode.children.length}`);
  assert.equal(rootNode.n_children_total, 300);
  assert.match(String(rootNode.children_note), /另有 270 个小节未列出/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('childPayloads：按上限截断并如实返回总数（不让模型以为这就是全部）', () => {
  const { repo } = freshRepo();
  const docId = seedDoc(repo);
  const units = repo.allUnitRows(docId);
  const nodes = buildTree(units);
  const rootId = units[0]!.id;
  const root = nodes.get(rootId)!;
  const sources = { manualIntros: {}, sections: {}, rollup: {} };

  // 真实结构里根只有 2 个子节点 → 不截断
  const r = childPayloadsCapped(root, nodes, new Map(), sources, 30);
  assert.equal(r.total, 2);
  assert.equal(r.children.length, 2);

  // 上限设成 1 → 截断，但 total 仍是真实的 2
  const r1 = childPayloadsCapped(root, nodes, new Map(), sources, 1);
  assert.equal(r1.total, 2);
  assert.equal(r1.children.length, 1);
  assert.equal(r1.children[0]!.title, '1.1 索引', '保序：取目录里靠前的');
});

test('batchByPayloadBytes：按字节切分、保序、不丢节点；单节点超预算时单独成批', () => {
  const mk = (id: string, pad: number) => ({ id, title: id, pad: 'x'.repeat(pad) });
  // 每个约 100 字节 → 16KB 预算下应切成多批
  const many = Array.from({ length: 500 }, (_, i) => mk(`n${i}`, 80));
  const batches = batchByPayloadBytes(many);
  assert.ok(batches.length > 1, '应切成多批');
  // 保序 + 不丢
  assert.deepEqual(batches.flat().map((b) => b.id), many.map((b) => b.id));
  // 除"单节点超预算"外，都在预算内
  for (const b of batches) {
    if (b.length === 1) continue;
    assert.ok(JSON.stringify({ nodes: b }).length <= 16 * 1024, '多节点批必须在预算内');
  }
  // 单节点自身超预算 → 单独成批（不丢）
  const huge = [mk('big', 40000), mk('small', 10)];
  const hb = batchByPayloadBytes(huge);
  assert.equal(hb.length, 2);
  assert.deepEqual(hb[0]!.map((x) => x.id), ['big']);
  assert.deepEqual(hb[1]!.map((x) => x.id), ['small']);
});

test('缺少 doc_id / 文档不存在 → E_NOTFOUND', async () => {
  const { repo } = freshRepo();
  const handler = createRollupHandler({
    repo, db: repo.db, cfg: freshCfg(tmpDir()), runner: fakeRunner({ planCalls: [] }),
    completeJson: null,
  });
  await assert.rejects(() => handler({ ...makeCtx('x').ctx, docId: null }), /缺少 doc_id/);
  await assert.rejects(() => handler(makeCtx('doc_missing').ctx), /文档不存在/);
});
