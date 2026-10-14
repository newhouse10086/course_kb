/**
 * REST + SSE 端到端测试 —— **真实 HTTP（真 listen + 真 fetch）**，不 mock 框架、不 mock SQLite。
 *
 * worker 用**真子进程**（测试运行时生成的假 worker 脚本，走契约 §3.1 的同一套 JSONL 协议），
 * 因为 `worker/cli.py` 的解析结果不可在 CI 里稳定复现；协议层是真实的：
 * spawn → JSONL 字节帧 → 我们按 `\n` 切帧 → 入库 → REST 查询。
 *
 * 抽取器用**注入的确定性 stub**（真 LLM 路径由 provider 层自己的测试 + 真实抽取脚本覆盖），
 * 这样"链路正确性"与"模型产出"分开证明（v1 同款做法，避免用网络波动掩盖链路 bug）。
 *
 * 断言全部是**具体值**（AGENTS.md §7：不许只断言非空）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import { buildApp } from '../src/index.ts';
import type { BuiltApp } from '../src/index.ts';
import type {
  ExtractDocumentRequest,
  ExtractDocumentResult,
  Extractor,
  SectionSummary,
} from '../src/tasks/extract.ts';
import type { CardDraft, EdgeDraft, EntityDraft } from '../src/store/repo.ts';
import type { WorkerCapability } from '../src/worker/probe.ts';

// ═══════════════════════════════════════════════════════════════════════
// 假 worker：真进程、真 JSONL、真 worker 协议
// ═══════════════════════════════════════════════════════════════════════

const FAKE_WORKER = String.raw`# -*- coding: utf-8 -*-
"""假 worker：只覆盖 parse（协议与 worker/cli.py 一致），供 REST 端到端测试用。"""
import json, sys

def emit(p):
    sys.stdout.buffer.write(json.dumps(p, ensure_ascii=False).encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()

def main():
    argv = sys.argv[1:]
    job = argv[argv.index("--job") + 1] if "--job" in argv else "parse"
    raw = argv[argv.index("--in") + 1] if "--in" in argv else "{}"
    try:
        params = json.loads(raw)
    except Exception:
        params = {}
    path = params.get("path", "")
    if job == "parse":
        emit({"type": "progress", "stage": "parse", "frac": 0.5, "detail": {"page": 2}})
        units = [
            {"ord": 1, "title": "第一章 数据库基础", "level": 1, "parent_ord": None,
             "span": {"kind": "page", "start": 1, "end": 2},
             "text": "聚簇索引将数据按主键顺序存放，二级索引需要回表。"},
            {"ord": 2, "title": "1.1 事务隔离", "level": 2, "parent_ord": 1,
             "span": {"kind": "page", "start": 3, "end": 4},
             "text": "事务的隔离级别决定并发事务之间的可见性。"},
        ]
        for u in units:
            emit({"type": "unit", "data": u})
        emit({"type": "log", "level": "info", "msg": "parsed 2 units"})
        emit({"type": "result", "data": {
            "document": {"title": "课程讲义", "kind": "text", "page_count": 4, "lang": "zh",
                         "meta": {"parse": {"toc_entries": 2, "skipped_roots": []}}},
            "units": units,
            "stats": {"units": 2, "parse_mode": "headings", "skipped_nodes": 0}}})
    elif job == "index":
        emit({"type": "result", "data": {"ok": True}})
    else:
        emit({"type": "error", "code": "E_JOB_UNKNOWN", "msg": "unknown job " + job})
        sys.exit(1)

main()
`;

/**
 * 确定性 stub 抽取器（**文档级**，与 A1 的 `Extractor` 接口一致）：
 * 含「聚簇索引」的单元产出 2 张卡片（含 B+树，使 typed 引用可观测）+ 实体 + 边。
 *
 * ⚠️ 用注入 stub 是为了让"**链路正确性**"与"**模型产出**"分开证明：
 * 真实 LLM 路径由 `data/tmp/e2e_real.mjs` 的端到端跑（含真模型）单独证。
 */
function stubExtractor(available = true, reason = ''): Extractor {
  return {
    name: 'stub',
    async available() {
      return { ok: available, reason };
    },
    async extractDocument(req: ExtractDocumentRequest): Promise<ExtractDocumentResult> {
      const cards: CardDraft[] = [];
      const entities: EntityDraft[] = [];
      const edges: EdgeDraft[] = [];
      const sections: Record<string, SectionSummary> = {};
      const units = req.limit && req.limit > 0 ? req.units.slice(0, req.limit) : req.units;

      for (const u of units) {
        const isIndex = u.text.includes('聚簇索引');
        const base = {
          unit_id: u.id,
          usage_mode: 'server_automatic',
          operational_role: 'performance',
          lifecycle: 'builtin',
          prerequisites: [] as string[],
          evidence_span: u.span,
        };
        if (isIndex) {
          cards.push(
            {
              ...base,
              name: '聚簇索引',
              kind: 'concept',
              one_line: '数据按主键顺序存放的索引',
              purpose: '范围查询快',
              example: 'CREATE INDEX idx ON t(c);',
              example_explained: '在列 c 上建普通索引',
              cautions: ['二级索引需要回表'],
              evidence_quote: '聚簇索引将数据按主键顺序存放。',
              confidence: 0.9,
            },
            {
              ...base,
              name: 'B+树',
              kind: 'mechanism',
              one_line: '一种多路平衡查找树',
              purpose: '支撑范围查询与排序',
              example: null,
              example_explained: null,
              cautions: [],
              evidence_quote: 'Clustered indexes implement a B-tree structure.',
              confidence: 0.8,
            },
          );
          entities.push(
            { name: 'Clustered index', name_zh: '聚簇索引', type: 'feature', layer: 'L2', unit_ids: [u.id] },
            { name: 'B+tree', name_zh: 'B+树', type: 'mechanism', layer: 'L1', unit_ids: [u.id] },
          );
          edges.push({
            src: 'Clustered index',
            dst: 'B+tree',
            etype: 'IMPLEMENTS',
            evidence_text: 'Clustered indexes implement a B-tree structure.',
            span: u.span,
            confidence: 0.9,
          });
          sections[u.id] = {
            section_summary: '本节讲索引与事务的基本概念。',
            key_takeaways: ['聚簇索引按主键顺序存放数据'],
          };
        } else {
          cards.push({
            ...base,
            name: '事务隔离级别',
            kind: 'concept',
            one_line: '控制并发可见性的设置',
            purpose: '在一致性与并发度之间取舍',
            example: null,
            example_explained: null,
            cautions: [],
            evidence_quote: '事务的隔离级别决定可见性。',
            confidence: 0.85,
          });
          entities.push({ name: 'Isolation level', name_zh: '隔离级别', type: 'concept', layer: 'L1', unit_ids: [u.id] });
          sections[u.id] = {
            section_summary: '本节讲事务隔离级别。',
            key_takeaways: ['隔离级别决定并发可见性'],
          };
        }
        req.onProgress?.({ stage: 'extract', done: cards.length, total: units.length });
      }

      return {
        cards,
        entities,
        edges,
        sections,
        usedProvider: 'stub',
        stats: {
          items: units.length,
          llmCalls: units.length,
          llmFailures: 0,
          errorCount: 0,
          ok: true,
          unitsDone: units.length,
          pick: { n_picked: units.length, n_window: 0, n_intro: 0, n_section: units.length, coverage: 1, missing_count: 0 },
        },
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 环境
// ═══════════════════════════════════════════════════════════════════════

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
let tmpRoot = '';
let fakeWorkerPath = '';

function fakeWorkerCapability(available = true, reason = ''): WorkerCapability {
  const empty = { ok: true, stdout: '', stderr: '', code: 0, elapsedMs: 0 };
  return {
    available,
    bin: 'python',
    module: 'worker.cli',
    pythonVersion: 'Python (stub)',
    moduleImportable: available,
    reason,
    checkedAt: Date.now(),
    cached: false,
    probes: { python: empty, module: empty },
  };
}

let dbCounter = 0;

async function makeApp(opts: { extractor?: Extractor | null; workerAvailable?: boolean } = {}): Promise<BuiltApp> {
  dbCounter += 1;
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DATA_DIR: path.join(tmpRoot, `data-${dbCounter}`),
      COURSE_KB_DB: path.join(tmpRoot, `test-${dbCounter}.sqlite3`),
      SSE_KEEPALIVE_MS: '300',
    } as Record<string, string>,
  });
  return buildApp({
    cfg,
    extractor: opts.extractor === undefined ? stubExtractor(true) : opts.extractor,
    workerLauncher: (job, paramsJson) => ({
      bin: 'python',
      args: [fakeWorkerPath, '--job', job, '--in', paramsJson],
      cwd: tmpRoot,
    }),
    workerProbe: async () => fakeWorkerCapability(opts.workerAvailable ?? true, opts.workerAvailable === false ? 'stub：worker 不可用' : ''),
  });
}

interface Live {
  built: BuiltApp;
  base: string;
}

async function listen(built: BuiltApp): Promise<Live> {
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('无法取到监听地址');
  return { built, base: `http://127.0.0.1:${addr.port}` };
}

async function jget(live: Live, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(`${live.base}${url}`, { headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

async function uploadText(live: Live, filename: string, content: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), filename);
  const res = await fetch(`${live.base}/api/v1/documents`, { method: 'POST', body: form });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function waitTask(live: Live, taskId: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await jget(live, `/api/v1/tasks/${taskId}`);
    const t = r.body as Record<string, unknown>;
    if (['done', 'failed', 'cancelled'].includes(String(t.status))) return t;
    await new Promise((r2) => setTimeout(r2, 25));
  }
  throw new Error(`任务 ${taskId} 超时未结束`);
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ckb-routes-'));
  fakeWorkerPath = path.join(tmpRoot, 'fake_worker.py');
  fs.writeFileSync(fakeWorkerPath, FAKE_WORKER, 'utf8');
});

after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows 偶发占用 */
  }
});

const SAMPLE = '# 第一章 数据库基础\n聚簇索引将数据按主键顺序存放。\n## 1.1 事务隔离\n事务的隔离级别决定可见性。\n';

// ═══════════════════════════════════════════════════════════════════════
// ① 健康 / 能力（诚实接口）
// ═══════════════════════════════════════════════════════════════════════

test('GET /api/v1/health → 200 + 契约字段 + 计数', async () => {
  const live = await listen(await makeApp());
  try {
    const r = await jget(live, '/api/v1/health');
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.version, '1.0.0');
    assert.equal(body.documents, 0);
    assert.equal(body.units, 0);
    assert.equal(body.cards, 0);
  } finally {
    await live.built.close();
  }
});

test('GET /api/v1/capabilities → 四个能力块齐备 + 逐 provider + 封闭枚举规模', async () => {
  const live = await listen(await makeApp());
  try {
    const r = await jget(live, '/api/v1/capabilities?deep=0');
    assert.equal(r.status, 200);
    const cap = r.body as Record<string, unknown>;
    // 契约 §5.1：缺任何一个块就是"假装可用"
    for (const key of ['asr', 'llm', 'pi', 'ffmpeg']) {
      assert.ok(cap[key] && typeof cap[key] === 'object', `缺能力块 ${key}`);
      assert.ok('available' in (cap[key] as object), `${key} 缺 available（诚实接口要求）`);
    }
    // worker 段（v2 新增）：本测试注入了"可用"的探针
    assert.deepEqual((cap.worker as Record<string, unknown>).available, true);
    assert.deepEqual(cap.adapters, ['pdf', 'pptx', 'docx', 'text', 'video']);
    // 逐 provider 上报（PROVIDERS §7）
    assert.ok(cap.providers && typeof cap.providers === 'object');
    assert.ok(Array.isArray((cap.providers as Record<string, unknown>).asr));
    // 封闭枚举规模（来自 schema/*.json，实测值）
    const schema = cap.schema as Record<string, unknown>;
    assert.equal(schema.edge_types, 12);
    assert.equal(schema.card_kinds, 23);
    assert.equal(schema.entity_types, 12);
    assert.equal(schema.layers, 4);
    assert.equal(schema.complete, true);
    // 检索自述（坑 15）
    assert.equal((cap.search as Record<string, unknown>).tokenizer, 'bigram');
    // 管线常量（AGENTS.md §5：不要重新发明）
    const pipeline = cap.pipeline as Record<string, unknown>;
    assert.equal(pipeline.max_pages_per_unit, 8);
    assert.equal(pipeline.span_threshold, 3);
    assert.equal(pipeline.llm_concurrency, 1);
    assert.equal(pipeline.unit_split, 'recursive_descent_with_intro');
    assert.equal((cap.llm as Record<string, unknown>).concurrency, 1);
  } finally {
    await live.built.close();
  }
});

test('capabilities 如实报 worker 不可用：adapters 为空 + 可读 reason（不假装能解析）', async () => {
  const live = await listen(await makeApp({ workerAvailable: false }));
  try {
    const cap = (await jget(live, '/api/v1/capabilities?deep=0')).body as Record<string, unknown>;
    assert.deepEqual(cap.adapters, [], 'worker 不可用时不许列出解析格式');
    const worker = cap.worker as Record<string, unknown>;
    assert.equal(worker.available, false);
    assert.match(String(worker.reason), /stub：worker 不可用/);
  } finally {
    await live.built.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ② 上传 → parse → 知识库产物
// ═══════════════════════════════════════════════════════════════════════

test('上传 → worker parse → units/outline/cards/graph/xrefs/search 全链路（具体值断言）', async () => {
  const live = await listen(await makeApp());
  try {
    const up = await uploadText(live, 'lecture.md', SAMPLE);
    assert.equal(up.status, 202, JSON.stringify(up.body));
    const docId = String(up.body.document_id);
    const taskId = String(up.body.task_id);
    assert.match(docId, /^doc_[0-9a-f]{12}$/);
    assert.match(taskId, /^tsk_[0-9a-f]{12}$/);
    assert.equal(up.body.status, 'uploading');
    assert.equal(up.body.events_url, `/api/v1/tasks/${taskId}/events`);

    const task = await waitTask(live, taskId);
    assert.equal(task.status, 'done', JSON.stringify(task));
    assert.equal(task.progress, 1);
    const detail = task.detail as Record<string, unknown>;
    assert.equal(detail.units, 2);
    assert.equal(detail.parse_mode, 'headings');
    assert.equal(detail.llm_configured, true);
    const extract = detail.extract as Record<string, unknown>;
    assert.equal(extract.llm_calls, 2, '两个单元各一次 LLM 调用（并发=1 串行）');
    assert.equal(extract.cards, 3, '单元1 两张（聚簇索引/B+树）+ 单元2 一张');
    assert.equal(extract.entities, 3, 'Clustered index + B+tree + Isolation level');
    assert.equal(extract.edges, 1, '同名端点归并后只剩 1 条 IMPLEMENTS');
    assert.equal((detail.counts as Record<string, number>).units, 2);

    // ① 详情：含抽取状态（"未抽取" vs "抽取了但没结果" 的分界）
    const doc = (await jget(live, `/api/v1/documents/${docId}`)).body as Record<string, unknown>;
    assert.equal(doc.kind, 'text');
    assert.equal(doc.page_count, 4);
    assert.equal(doc.status, 'ready');
    assert.equal((doc.counts as Record<string, number>).units, 2);
    assert.equal((doc.counts as Record<string, number>).cards, 3);
    assert.equal(doc.extract_status, 'done');
    assert.equal(doc.extract_error, '');
    assert.equal((doc.meta as Record<string, unknown>).original_filename, 'lecture.md');

    // ② 列表
    const listing = (await jget(live, '/api/v1/documents')).body as Record<string, unknown>;
    assert.equal(listing.total, 1);
    assert.equal((listing.documents as unknown[]).length, 1);

    // ③ outline：层次 + intro 来源可追溯
    const outline = (await jget(live, `/api/v1/documents/${docId}/outline`)).body as Record<string, unknown>;
    assert.deepEqual(outline.roots, [Object.keys(outline.nodes as object)[0]]);
    assert.equal((outline.roots as string[]).length, 1);
    const nodes = outline.nodes as Record<string, Record<string, unknown>>;
    assert.equal(Object.keys(nodes).length, 2);
    const root = nodes[(outline.roots as string[])[0] as string] as Record<string, unknown>;
    assert.equal(root.level, 1);
    assert.deepEqual(root.span, { kind: 'page', start: 1, end: 2 });
    assert.equal(root.n_cards, 3, '子树卡片数（3 张都在根节点之下）');
    assert.equal(root.n_units, 2);
    assert.equal(root.intro, '本节讲索引与事务的基本概念。');
    assert.equal(root.intro_source, 'section_summary');
    assert.equal(root.why, '聚簇索引按主键顺序存放数据');
    const stats = outline.stats as Record<string, unknown>;
    assert.equal(stats.units, 2);
    assert.equal(stats.with_intro, 2, '可见节点 100% 有 intro');
    assert.deepEqual(stats.levels, [1, 2]);

    // ④ units：字段名是 order（契约 §2.2），span 可回溯
    const units = (await jget(live, `/api/v1/documents/${docId}/units`)).body as Record<string, unknown>;
    assert.equal(units.total, 2);
    const u0 = (units.units as Record<string, unknown>[])[0] as Record<string, unknown>;
    assert.equal(u0.order, 1);
    assert.equal(u0.title, '第一章 数据库基础');
    assert.equal(u0.level, 1);
    assert.equal(u0.parent_id, null);
    assert.deepEqual(u0.span, { kind: 'page', start: 1, end: 2 });
    const u1 = (units.units as Record<string, unknown>[])[1] as Record<string, unknown>;
    assert.equal(u1.parent_id, u0.id, 'parent_ord=1 必须映射成 parent_id');

    // ⑤ cards：evidence_span 可回溯 + cautions 数组
    const cards = (await jget(live, `/api/v1/documents/${docId}/cards`)).body as Record<string, unknown>;
    assert.equal(cards.total, 3);
    const names = (cards.cards as Record<string, unknown>[]).map((c) => c.name).sort();
    assert.deepEqual(names, ['B+树', '事务隔离级别', '聚簇索引']);
    const crd = (cards.cards as Record<string, unknown>[]).find((c) => c.name === '聚簇索引') as Record<string, unknown>;
    assert.equal(crd.kind, 'concept');
    assert.deepEqual(crd.evidence_span, { kind: 'page', start: 1, end: 2 });
    assert.deepEqual(crd.cautions, ['二级索引需要回表']);
    assert.equal(crd.confidence, 0.9);

    // ⑥ 单卡片：card/unit/source/xrefs/backlinks
    const cardId = String(crd.id);
    const single = (await jget(live, `/api/v1/cards/${cardId}`)).body as Record<string, unknown>;
    assert.equal((single.card as Record<string, unknown>).id, cardId);
    assert.equal((single.unit as Record<string, unknown>).id, u0.id);
    const source = single.source as Record<string, unknown>;
    assert.equal(source.kind, 'text');
    assert.equal(source.page, 1);
    assert.equal(source.url, `/api/v1/documents/${docId}/file#page=1`);
    assert.ok(Array.isArray(single.xrefs));
    assert.ok(Array.isArray(single.backlinks));
    const xrefsOnly = (await jget(live, `/api/v1/cards/${cardId}/xrefs`)).body as Record<string, unknown>;
    assert.deepEqual(xrefsOnly.xrefs, single.xrefs, '两个入口必须给同一份数据');
    const backOnly = (await jget(live, `/api/v1/cards/${cardId}/backlinks`)).body as Record<string, unknown>;
    assert.deepEqual(backOnly.backlinks, single.backlinks);

    // ⑦ graph：同名实体归并 + 边去重 + 自引用消失
    const graph = (await jget(live, `/api/v1/documents/${docId}/graph`)).body as Record<string, unknown>;
    const gstats = graph.stats as Record<string, number>;
    assert.equal(gstats.nodes, 3);
    assert.equal(gstats.edges, 1);
    assert.equal(gstats.types, 1);
    assert.equal(gstats.verify_rate, 1);
    const edge = (graph.edges as Record<string, unknown>[])[0] as Record<string, unknown>;
    assert.equal(edge.etype, 'IMPLEMENTS');
    assert.notEqual(edge.src, edge.dst);
    assert.equal(edge.flagged, false);
    assert.match(String(edge.evidence), /B-tree structure/);
    const node = (graph.nodes as Record<string, unknown>[]).find((n) => n.name === 'Clustered index') as Record<string, unknown>;
    assert.equal(node.type, 'feature');
    assert.equal(node.layer, 'L2');
    assert.equal(node.degree, 1);
    assert.ok((node.unit_ids as string[]).length >= 1, 'unit_ids 必须有可回溯来源');

    // ⑧ xrefs：四路直方图
    const xr = (await jget(live, `/api/v1/documents/${docId}/xrefs`)).body as Record<string, unknown>;
    assert.equal(xr.total, (xr.xrefs as unknown[]).length);
    const hist = xr.histogram as Record<string, number>;
    // typed：图谱边投影到卡片。**端点两侧都要有同名卡片**才有意义（实体 name_zh 也参与匹配）
    assert.equal(hist.typed, 1, 'IMPLEMENTS: Clustered index → B+tree，两侧都有卡片');
    // same_unit：单元 1 内 2 张卡片互链（双向）= 2 条
    assert.equal(hist.same_unit, 2);
    // also_in：本 fixture 里没有跨单元重名卡片 → 如实为 0（不是"没实现"）
    assert.equal(hist.also_in ?? 0, 0, '无跨单元重名 → 0；有重名时才有 also_in');
    // mention：单元 1 的正文里出现了"聚簇索引"，而该单元里还有 B+树 卡片 → 1 条 mention
    // （这正是 v1 坑 6 要过滤的那条路径；本 fixture 的卡片名不是通用词，故如实保留）
    assert.equal(hist.mention ?? 0, 1);
    assert.equal(xr.total, 4, '1 typed + 1 mention + 2 same_unit');
    assert.ok(Number(xr.cards_with_xrefs) >= 1);
    for (const x of xr.xrefs as Record<string, unknown>[]) {
      assert.notEqual(x.from_card_id, x.to_card_id, '自引用必须被过滤（契约 §2.5）');
    }

    // ⑨ 检索：中文 2 字词
    const s = (await jget(live, '/api/v1/search?q=' + encodeURIComponent('索引'))).body as Record<string, unknown>;
    assert.ok(Number(s.total) >= 1);
    assert.equal(s.mode, 'bigram');
    assert.deepEqual(s.terms, ['索引']);
    const hits = s.hits as Record<string, unknown>[];
    assert.ok(hits.some((h) => h.title === '聚簇索引'));
    // snippet 来自**原文**（不是 bigram 串）
    const hit = hits.find((h) => String(h.ref_id) === cardId) as Record<string, unknown>;
    assert.match(String(hit.snippet), /聚簇索引/);
    assert.ok(!String(hit.snippet).includes('聚簇 簇索'), 'snippet 不能是 bigram 碎片');
    // 英文标识符
    assert.ok(Number(((await jget(live, '/api/v1/search?q=B%2Btree')).body as Record<string, unknown>).total) >= 1);
    // 不存在的词 → 真的 0
    assert.equal(((await jget(live, '/api/v1/search?q=' + encodeURIComponent('根本不存在的词组'))).body as Record<string, unknown>).total, 0);
    // 补全
    const sug = (await jget(live, '/api/v1/search/suggest?q=' + encodeURIComponent('聚簇'))).body as Record<string, unknown>;
    assert.deepEqual(sug.suggestions, ['聚簇索引']);

    // ⑩ ★ 坑 15 对比证明（两个数一起断言）
    const contrast = (await jget(live, `/api/v1/search/contrast?q=${encodeURIComponent('索引')}&doc_id=${docId}`)).body as Record<string, unknown>;
    assert.ok(Number(contrast.bigram_hits) >= 1, `bigram 应有命中，实际 ${contrast.bigram_hits}`);
    assert.equal(contrast.unicode61_hits, 0, 'unicode61 对中文必须 0 命中');
    assert.equal(contrast.texts_compared, 2 + 3, '对照文本 = 2 units + 3 cards');
    assert.match(String(contrast.conclusion), /坑 15/);

    // ⑪ Range 请求
    const full = await fetch(`${live.base}/api/v1/documents/${docId}/file`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    const fullText = await full.text();
    assert.equal(fullText, SAMPLE);
    const size = Buffer.byteLength(SAMPLE, 'utf8');
    // ⚠️ Range 是**字节**语义，不是字符语义（中文 3 字节/字）。
    // 取 0-10 字节 = "# " + "第一章"（2 + 9 = 11 字节）正好落在字符边界上。
    const buf = Buffer.from(SAMPLE, 'utf8');
    const part = await fetch(`${live.base}/api/v1/documents/${docId}/file`, { headers: { Range: 'bytes=0-10' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 0-10/${size}`);
    assert.equal(part.headers.get('content-length'), '11');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), buf.subarray(0, 11), '字节必须逐字一致');
    assert.equal(buf.subarray(0, 11).toString('utf8'), '# 第一章');
    const bad = await fetch(`${live.base}/api/v1/documents/${docId}/file`, { headers: { Range: `bytes=${size + 10}-` } });
    assert.equal(bad.status, 416);

    // ⑫ SSE：历史可重放 + 单行 JSON + 收尾 done
    const sse = await fetch(`${live.base}${String(up.body.events_url)}`);
    assert.equal(sse.status, 200);
    assert.match(String(sse.headers.get('content-type')), /^text\/event-stream/);
    const sseText = await sse.text();
    assert.match(sseText, /event: progress/);
    assert.match(sseText, /event: done/);
    const dataLines = sseText.split('\n').filter((l) => l.startsWith('data: '));
    assert.ok(dataLines.length >= 2);
    for (const l of dataLines) {
      assert.ok(!l.slice(6).includes('\n'));
      JSON.parse(l.slice(6)); // 每一帧都必须是合法 JSON
    }
    const doneFrame = JSON.parse((dataLines.find((l) => l.includes('"status":"done"')) as string).slice(6)) as Record<string, unknown>;
    assert.equal(doneFrame.task_id, taskId);

    // ⑬ 删除（级联）
    const del = await fetch(`${live.base}/api/v1/documents/${docId}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(((await del.json()) as Record<string, unknown>).deleted, true);
    assert.equal((await jget(live, `/api/v1/documents/${docId}`)).status, 404);
    // 文档没了 → 其子资源一律 404（不是返回空列表假装"文档还在但没卡片"）
    for (const sub of ['cards', 'units', 'outline', 'graph', 'xrefs']) {
      const r = await jget(live, `/api/v1/documents/${docId}/${sub}`);
      assert.equal(r.status, 404, `${sub} 应 404`);
      assert.equal(((r.body as Record<string, Record<string, string>>).error as Record<string, string>).code, 'E_NOTFOUND');
    }
    assert.equal(((await jget(live, '/api/v1/health')).body as Record<string, unknown>).cards, 0);
    assert.equal(((await jget(live, '/api/v1/search?q=' + encodeURIComponent('索引'))).body as Record<string, unknown>).total, 0, '检索索引要随删除清掉');
  } finally {
    await live.built.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ③ extract 独立入口（Lead 实测发现的缺口）
// ═══════════════════════════════════════════════════════════════════════

test('POST /documents/:id/extract → 202 且任务 done，产出卡片/图谱/交叉引用', async () => {
  // 先关掉自动抽取，验证"手动入口"确实能产出（否则测不出这个入口）
  const built = await makeApp();
  const live = await listen(built);
  try {
    const up = await uploadText(live, 'lecture.md', SAMPLE);
    const docId = String(up.body.document_id);
    await waitTask(live, String(up.body.task_id));

    const res = await fetch(`${live.base}/api/v1/documents/${docId}/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 2 }),
    });
    assert.equal(res.status, 202);
    const up2 = (await res.json()) as Record<string, unknown>;
    assert.equal(up2.document_id, docId);
    assert.match(String(up2.task_id), /^tsk_[0-9a-f]{12}$/);
    assert.equal(up2.status, 'queued');
    assert.equal(up2.events_url, `/api/v1/tasks/${String(up2.task_id)}/events`);

    const task = await waitTask(live, String(up2.task_id));
    assert.equal(task.status, 'done', JSON.stringify(task));
    assert.equal(task.kind, 'extract');
    const detail = task.detail as Record<string, unknown>;
    assert.equal((detail.extract as Record<string, unknown>).cards, 3, 'detail.extract.cards');
    assert.equal(detail.cards, 3);
    assert.equal(detail.extract_status, 'done');

    const doc = (await jget(live, `/api/v1/documents/${docId}`)).body as Record<string, unknown>;
    assert.equal(doc.extract_status, 'done');
    assert.equal(doc.extract_task_id, up2.task_id, '详情要能指回最近一次 extract 任务');
    assert.equal((doc.counts as Record<string, number>).cards, 3);
    const graph2 = (await jget(live, `/api/v1/documents/${docId}/graph`)).body as {
      stats: { nodes: number };
    };
    assert.equal(graph2.stats.nodes, 3);
  } finally {
    await live.built.close();
  }
});

test('★ 抽取器不可用 → 503 + 可读 reason，**不排任务、不假装成功**', async () => {
  const live = await listen(await makeApp({ extractor: stubExtractor(false, '缺少环境变量 AMR_KEY') }));
  try {
    const up = await uploadText(live, 'lecture.md', SAMPLE);
    const docId = String(up.body.document_id);
    const parseTask = await waitTask(live, String(up.body.task_id));
    // parse 期间不自动抽取，且**如实标注"未抽取"**
    assert.equal(parseTask.status, 'done');
    const detail = parseTask.detail as Record<string, unknown>;
    assert.equal(detail.llm_configured, false);
    assert.equal(detail.extract_status, 'unavailable');
    assert.ok(!('extract' in detail), '没有抽取段 —— 不能把"未抽取"表达成"抽取了但没结果"');
    assert.match(String(detail.note), /AMR_KEY/);

    const doc = (await jget(live, `/api/v1/documents/${docId}`)).body as Record<string, unknown>;
    assert.equal(doc.extract_status, 'unavailable');
    assert.match(String(doc.extract_error), /AMR_KEY/);
    assert.equal((doc.counts as Record<string, number>).units, 2, 'units 照常解析出来（解析不依赖 LLM）');
    assert.equal((doc.counts as Record<string, number>).cards, 0);

    // 手动入口必须如实报错：契约 §8 里 `E_LLM` → **502**
    // （503 在本契约里是 `E_ASR_LOAD`，即"ASR 模型加载失败"；LLM 侧没有 503 码，
    //  不发明新码 → 用 §8 已有的 E_LLM/502，详情见交付报告）
    const res = await fetch(`${live.base}/api/v1/documents/${docId}/extract`, { method: 'POST' });
    assert.equal(res.status, 502);
    const err = ((await res.json()) as Record<string, Record<string, string>>).error as Record<string, string>;
    assert.equal(err.code, 'E_LLM');
    assert.equal(err.detail, '缺少环境变量 AMR_KEY');
    assert.match(String(err.hint), /重试/);

    // 而且**没有**产生新的 extract 任务（不排注定失败的任务）
    const tasks = (await jget(live, `/api/v1/tasks?doc_id=${docId}`)).body as Record<string, unknown>;
    assert.equal((tasks.tasks as Record<string, unknown>[]).filter((t) => t.kind === 'extract').length, 0);
  } finally {
    await live.built.close();
  }
});

test('文档没有 units 时 extract → 422 E_PARSE（而不是产出 0 张卡片算成功）', async () => {
  const live = await listen(await makeApp());
  try {
    // 直接造一个只有 documents 行的文档（模拟 parse 未跑）
    const docId = live.built.deps.repo.insertDocument({ title: 'x', kind: 'text', source_path: 'x.txt' });
    const res = await fetch(`${live.base}/api/v1/documents/${docId}/extract`, { method: 'POST' });
    assert.equal(res.status, 422);
    const err = ((await res.json()) as Record<string, Record<string, string>>).error as Record<string, string>;
    assert.equal(err.code, 'E_PARSE');
    assert.match(String(err.hint), /parse/);
  } finally {
    await live.built.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ④ SSE 断线重连续推（Last-Event-ID）
// ═══════════════════════════════════════════════════════════════════════

test('SSE Last-Event-ID 续推：只收到 id 大于断点的事件', async () => {
  const live = await listen(await makeApp());
  try {
    const up = await uploadText(live, 'lecture.md', SAMPLE);
    const taskId = String(up.body.task_id);
    await waitTask(live, taskId);

    const all = await (await fetch(`${live.base}/api/v1/tasks/${taskId}/events`)).text();
    const ids = all
      .split('\n')
      .filter((l) => l.startsWith('id: '))
      .map((l) => Number.parseInt(l.slice(4), 10));
    assert.ok(ids.length >= 2, `应有 >=2 帧，实际 ${ids.length}`);
    const cut = ids[0] as number;

    const resumed = await (
      await fetch(`${live.base}/api/v1/tasks/${taskId}/events`, { headers: { 'Last-Event-ID': String(cut) } })
    ).text();
    const ids2 = resumed
      .split('\n')
      .filter((l) => l.startsWith('id: '))
      .map((l) => Number.parseInt(l.slice(4), 10));
    assert.ok(ids2.length > 0, '续推必须还有内容');
    assert.ok(ids2.every((i) => i > cut), `续推的 id 必须全部 > ${cut}，实际 ${JSON.stringify(ids2)}`);
    assert.deepEqual(ids2, ids.filter((i) => i > cut), '续推内容 = 断点之后的所有帧');
    assert.match(resumed, /event: done/, '任务已结束时续推也要给出收尾帧');
  } finally {
    await live.built.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ④b SSE **实时**流（任务仍在跑时边跑边收 —— 不是结束后重放）
// ═══════════════════════════════════════════════════════════════════════

/** 慢 worker：先发一帧 progress，sleep 800ms 再发 result（用于验证"边跑边收"）。 */
const SLOW_WORKER = String.raw`# -*- coding: utf-8 -*-
import json, sys, time

def emit(p):
    sys.stdout.buffer.write(json.dumps(p, ensure_ascii=False).encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()

argv = sys.argv[1:]
emit({"type": "progress", "stage": "parse", "frac": 0.1})
emit({"type": "log", "level": "info", "msg": "slow worker 已启动"})
time.sleep(0.8)
emit({"type": "progress", "stage": "parse", "frac": 0.9})
emit({"type": "result", "data": {"document": {"title": "慢文档", "kind": "text", "page_count": 1, "lang": "zh", "meta": {}},
       "units": [{"ord": 1, "title": "唯一单元", "level": 1, "parent_ord": None,
                  "span": {"kind": "page", "start": 1, "end": 1}, "text": "索引"}],
       "stats": {"units": 1, "parse_mode": "headings", "skipped_nodes": 0}}})
`;

test('★ SSE 实时流：任务还在跑时就能收到 progress，结束后收到 done（增量推送，不是攒完一起发）', async () => {
  const slowWorker = path.join(tmpRoot, 'slow_worker.py');
  fs.writeFileSync(slowWorker, SLOW_WORKER, 'utf8');

  dbCounter += 1;
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DATA_DIR: path.join(tmpRoot, `data-slow`),
      COURSE_KB_DB: path.join(tmpRoot, 'slow.sqlite3'),
      SSE_KEEPALIVE_MS: '300',
    } as Record<string, string>,
  });
  const built = await buildApp({
    cfg,
    extractor: stubExtractor(true),
    workerLauncher: (job, paramsJson) => ({ bin: 'python', args: [slowWorker, '--job', job, '--in', paramsJson], cwd: tmpRoot }),
    workerProbe: async () => fakeWorkerCapability(true),
  });
  const live = await listen(built);
  try {
    const up = await uploadText(live, 'slow.md', SAMPLE);
    const taskId = String(up.body.task_id);

    // 立刻订阅（坑 14：先订阅再等结果），并**增量**读取
    const t0 = Date.now();
    const res = await fetch(`${live.base}/api/v1/tasks/${taskId}/events`);
    assert.equal(res.status, 200);
    assert.ok(res.body, 'SSE 必须有流式 body');

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    let firstProgressAt: number | null = null;
    let logAt: number | null = null;
    let doneAt: number | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const now = Date.now();
      if (firstProgressAt === null && text.includes('event: progress')) firstProgressAt = now;
      if (logAt === null && text.includes('slow worker 已启动')) logAt = now;
      if (doneAt === null && text.includes('event: done')) doneAt = now;
      if (now - t0 > 15_000) break;
    }

    assert.ok(firstProgressAt !== null, '必须收到 progress');
    assert.ok(logAt !== null, 'worker 的 log 事件也要转发到 SSE');
    assert.ok(doneAt !== null, '必须收到 done');
    // ★ 关键断言：第一帧 progress 在 worker 结束（~800ms）**之前**到达 → 真的是增量推送
    const firstMs = (firstProgressAt as number) - t0;
    assert.ok(firstMs < 700, `首帧 progress 应在 700ms 内到达（实测 ${firstMs}ms）；若 >=800ms 说明是攒完再发`);
    assert.ok((logAt as number) - t0 < 700, 'log 帧也必须是实时的');
    assert.ok((doneAt as number) - t0 >= 700, 'done 必须在 worker 真正结束之后（~800ms 起）');

    // 帧 id 单调递增，且以 done 收尾
    const ids = text
      .split('\n')
      .filter((l) => l.startsWith('id: '))
      .map((l) => Number.parseInt(l.slice(4), 10));
    assert.ok(ids.length >= 3);
    for (let i = 1; i < ids.length; i += 1) {
      assert.ok((ids[i] as number) > (ids[i - 1] as number), `id 必须严格递增：${JSON.stringify(ids)}`);
    }
    assert.ok(text.trimEnd().includes('event: done'), '流以 done 收尾');
    assert.equal(built.deps.repo.getTask(taskId)?.status, 'done');
  } finally {
    await live.built.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ⑤ 错误码（契约 §8）
// ═══════════════════════════════════════════════════════════════════════

test('错误码：415 / 413 / 404 都是契约形状，且失败不留空文档', async () => {
  const live = await listen(await makeApp());
  try {
    // 415 不支持的格式
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'application/octet-stream' }), 'x.zzz');
    const bad = await fetch(`${live.base}/api/v1/documents`, { method: 'POST', body: form });
    assert.equal(bad.status, 415);
    const badBody = ((await bad.json()) as Record<string, Record<string, string>>).error as Record<string, string>;
    assert.equal(badBody.code, 'E_FORMAT');
    assert.match(String(badBody.detail), /\.pdf/);
    assert.equal(((await jget(live, '/api/v1/documents')).body as Record<string, unknown>).total, 0, '失败上传不留空文档');

    // 413 超限
    live.built.deps.cfg.maxUploadBytes = 100;
    const big = await uploadText(live, 'big.md', 'x'.repeat(500));
    assert.equal(big.status, 413);
    assert.equal((big.body.error as Record<string, string>).code, 'E_TOOBIG');
    assert.equal(((await jget(live, '/api/v1/documents')).body as Record<string, unknown>).total, 0);
    live.built.deps.cfg.maxUploadBytes = 512 * 1024 * 1024;

    // 404 系列
    for (const url of [
      '/api/v1/documents/doc_missing',
      '/api/v1/documents/doc_missing/outline',
      '/api/v1/documents/doc_missing/graph',
      '/api/v1/documents/doc_missing/xrefs',
      '/api/v1/documents/doc_missing/units',
      '/api/v1/documents/doc_missing/video',
      '/api/v1/cards/crd_missing',
      '/api/v1/cards/crd_missing/xrefs',
      '/api/v1/cards/crd_missing/backlinks',
      '/api/v1/tasks/tsk_missing',
      '/api/v1/tasks/tsk_missing/events',
      '/api/v1/nope',
    ]) {
      const r = await jget(live, url);
      assert.equal(r.status, 404, `${url} 应 404，实际 ${r.status}`);
      assert.equal(((r.body as Record<string, Record<string, string>>).error as Record<string, string>).code, 'E_NOTFOUND', url);
    }
    const cancelMissing = await fetch(`${live.base}/api/v1/tasks/tsk_missing/cancel`, { method: 'POST' });
    assert.equal(cancelMissing.status, 404);
    const msg = ((await (await jget(live, '/api/v1/documents/doc_missing')).body) as Record<string, Record<string, string>>).error as Record<string, string>;
    assert.match(String(msg.msg), /doc_missing/);

    // 视频产物不存在 → 404（不是空切片假装成功）
    const up = await uploadText(live, 'lecture.md', SAMPLE);
    for (const p of ['video', 'video/subtitle', 'video/transcript', 'video/mindmap', 'video/slides']) {
      assert.equal((await jget(live, `/api/v1/documents/${String(up.body.document_id)}/${p}`)).status, 404, p);
    }
  } finally {
    await live.built.close();
  }
});
