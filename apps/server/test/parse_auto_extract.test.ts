/**
 * ★★ **自动抽取的闸门守卫**（用户诉求："上传了要能看到东西" **且** 不许无声花钱）。
 *
 * ## 背景（两个真实发现）
 * 1. **抽取曾经从不运行**：全库只有 `parse×4` 任务、`meta.extract_status=null`。
 *    原以为要"补一条自动链"，但 **Lead 真上传实测**发现：
 *    **`parse` handler 的 ④ 步本身就会抽取**（`handlers.ts:440-455`）⟹
 *    队列级再链一次会**双倍花费**（这次靠 `extract_status` 幂等闸门才没双跑）。
 *    ⟹ **唯一权威路径 = `parse` ④**；队列级自动链**已移除**。
 * 2. **闸门原先缺失**：refman 2523 单元会**无声花掉 2523 次调用**（并发=1 ≈3–7 小时）；
 *    正文为空的扫描件会**空转花钱**却注定 0 卡片。
 *
 * ## 判据（★ 全零 LLM：决策是**纯函数**，可穷举断言）
 * 1. `text_gate='empty_body'` → `skip` + 可读 reason
 * 2. 单元数 > 阈值 → `needs_confirm` + **代价可见（次数 + 时长区间）**
 * 3. 阈值内 → `run`
 * 4. ★ **阈值 `COURSE_KB_AUTO_EXTRACT_MAX_UNITS` 真的被读**（改小→挡、改大→放行）—— 坑 24
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { autoExtractMaxUnits, estimateExtractMinutes } from '../src/tasks/queue.ts';
import { decideAutoExtract } from '../src/tasks/handlers.ts';

test('★ 阈值默认 100 且**真的读 env**（非法值回落默认，不静默变 0）', () => {
  assert.equal(autoExtractMaxUnits({}), 100, '默认 100（并发=1 下 ≈10–20 分钟，已是后台任务量级）');
  assert.equal(autoExtractMaxUnits({ COURSE_KB_AUTO_EXTRACT_MAX_UNITS: '7' }), 7, '★ env 必须真的被读');
  assert.equal(
    autoExtractMaxUnits({ COURSE_KB_AUTO_EXTRACT_MAX_UNITS: '0' }),
    100,
    '0 非法 → 回落默认（否则"永远不自动抽取"看起来像没这功能）',
  );
  assert.equal(autoExtractMaxUnits({ COURSE_KB_AUTO_EXTRACT_MAX_UNITS: '-3' }), 100, '负数非法');
  assert.equal(autoExtractMaxUnits({ COURSE_KB_AUTO_EXTRACT_MAX_UNITS: 'abc' }), 100, 'NaN 非法');
});

test('★ 时长估算必须是**区间**且量级正确（只报次数不够 —— 用户痛在"要等多久"）', () => {
  const [lo, hi] = estimateExtractMinutes(2523);
  assert.ok(lo < hi && lo > 0, `应给区间，实际 [${lo}, ${hi}]`);
  assert.ok(hi >= 60, `2523 单元是"小时级"，实际上限 ${hi} 分钟`);
  const [l1, h1] = estimateExtractMinutes(1);
  assert.ok(l1 >= 1 && h1 >= l1, '小文档也要给合法区间');
});

test('★★ `text_gate=empty_body` → **skip** + 可读 reason（不许空转花钱）', () => {
  const d = decideAutoExtract({ units: 3, textGate: 'empty_body', maxUnits: 100 });
  assert.equal(d.action, 'skip', '★ 正文为空必须跳过（注定 0 卡片）');
  assert.equal(d.meta.extract_auto, 'skipped');
  assert.match(String(d.meta.extract_skip_reason), /正文为空/, '必须给可读原因（前端要能显示）');
});

test('★★ 超阈值 → `needs_confirm` + **代价可见（次数 + 时长区间）**', () => {
  const d = decideAutoExtract({ units: 2523, maxUnits: 100 });
  assert.equal(d.action, 'needs_confirm', '★ 超阈值不许自动跑（2523 次调用 ≈3–7 小时 + 真实花费）');
  assert.equal(d.meta.needs_confirm, true, '前端据此显示"开始抽取"按钮');
  assert.equal(d.meta.est_calls, 2523, '★ 代价可见：次数 = 单元数');
  const est = d.meta.est_minutes as number[];
  assert.ok(
    Array.isArray(est) && est.length === 2 && Number(est[0]) <= Number(est[1]),
    `时长区间必须合法：${JSON.stringify(est)}`,
  );
  assert.match(String(d.meta.extract_skip_reason), /超过自动抽取阈值/, 'reason 要说明为什么被挡');
  assert.match(String(d.meta.extract_skip_reason), /预计 \d+–\d+ 分钟/, '★ reason 里也要带时长（用户真正感受到的痛）');
});

test('★ 阈值内 → `run`（小文档即传即出内容）', () => {
  const d = decideAutoExtract({ units: 4, maxUnits: 100 });
  assert.equal(d.action, 'run', '★ 4 单元的小文档必须放行（否则用户永远看不到内容）');
  assert.equal(d.meta.extract_auto, 'running');
  assert.equal(d.meta.extract_auto_units, 4);
});

test('★ 边界：正好等于阈值 → 放行；阈值+1 → 待确认（判据不能差一）', () => {
  assert.equal(decideAutoExtract({ units: 100, maxUnits: 100 }).action, 'run', '等于阈值应放行');
  assert.equal(decideAutoExtract({ units: 101, maxUnits: 100 }).action, 'needs_confirm', '超过 1 个就该挡');
});

test('★ 阈值可配**真的生效**：同一份 5 单元文档，阈值 2 → 挡；阈值 50 → 放行', () => {
  assert.equal(
    decideAutoExtract({ units: 5, maxUnits: autoExtractMaxUnits({ COURSE_KB_AUTO_EXTRACT_MAX_UNITS: '2' }) }).action,
    'needs_confirm',
  );
  assert.equal(
    decideAutoExtract({ units: 5, maxUnits: autoExtractMaxUnits({ COURSE_KB_AUTO_EXTRACT_MAX_UNITS: '50' }) }).action,
    'run',
  );
});

// ═══════════════════════════════════════════════════════════════════════
// ★ 结构性守卫：**只许有一条抽取路径**（Lead 要求；防"以修复之名"把双跑带回来）
// ═══════════════════════════════════════════════════════════════════════

test("★★ 全仓 `enqueue({kind:'extract'})` **只许一处**，且必须是显式端点（不是自动链）", () => {
  const srcDir = path.resolve(import.meta.dirname, '..', 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) files.push(p);
    }
  };
  walk(srcDir);

  const hits: { file: string; line: number }[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      // 只数**真正入队抽取**的调用（`kind: 'extract'` 作为 enqueue 参数）
      if (/kind:\s*'extract'/.test(text)) hits.push({ file: path.relative(srcDir, f), line: i + 1 });
    });
  }
  assert.equal(
    hits.length,
    1,
    `★ 抽取入队只许有**一条**路径（多一条 = 双倍花费 + 两套真相）。实际命中：${hits.map((h) => `${h.file}:${h.line}`).join(', ')}`,
  );
  assert.match(hits[0]!.file, /routes[\\/]documents\.ts$/, '★ 唯一入口必须是显式端点 POST /documents/:id/extract');
});

test('★★ 死代码守卫：`queue.ts` 里**不许**再出现自动链（`maybeAutoExtract` 的定义/调用）', () => {
  const q = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'tasks', 'queue.ts'), 'utf8');
  // 允许"这里曾有 …（已删除）"的**指针注释**，但不许有定义或调用
  const defOrCall = q.split(/\r?\n/).filter((l) => /maybeAutoExtract/.test(l) && !/^\s*\/\//.test(l));
  assert.deepEqual(
    defOrCall,
    [],
    `★ queue.ts 不许有自动链的定义/调用（会造出第二条抽取路径 → 双倍花费）。命中：${defOrCall.join(' | ')}`,
  );
  // 正向：闸门必须在**权威路径**上（handlers.ts 导出纯函数）
  const h = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'tasks', 'handlers.ts'), 'utf8');
  assert.match(h, /export function decideAutoExtract/, '★ 闸门必须在 parse 的权威路径上（纯函数，可穷举断言）');
});
