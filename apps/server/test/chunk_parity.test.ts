/**
 * ★ **TS ↔ Python 分块等价性**（`chunk-cost.ts` vs `worker/pipeline/chunk.py`）。
 *
 * ## 为什么必须有这条测试
 * 分块阈值在两侧各有一份实现：
 * - `apps/server/src/tasks/chunk-cost.ts`（闸门预估调用数，**早于** `extract.plan`）
 * - `worker/pipeline/chunk.py`（真正的分块，plan + convert 都用它）
 *
 * 两份实现只有**结果逐字一致**时，"预估代价"才等于"真实花费"。
 * 否则就是 AGENTS 坑 24 的同族：**承诺 ≠ 生效**。
 *
 * ## 为什么是"真跑 Python"而不是再抄一份期望值
 * 抄期望值只能证明"我的 TS 符合我写下的数字"，**证明不了与 Python 一致**。
 * 这里**真的 spawn python** 跑 `chunk.split_text`，与 TS 结果逐字段比对 ——
 * 任一侧改了规则（断点表、下限、边界条件）都会立刻红。
 *
 * ⚠️ 本机 python 可用（AGENTS §4：Python 3.14.4）；不可用时**跳过并明确说明**，
 * 而不是静默通过（否则测试会在别的机器上变成"假绿"）。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { MIN_CHUNK_CHARS, splitText } from '../src/tasks/chunk-cost.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** 两端都必须用同一个默认阈值（任一侧改动都要在这里对账）。 */
const CAP = 24_000;

/** 构造与 Python 侧**完全同序**的用例（顺序必须一致，才能按下标比对）。 */
function cases(): string[] {
  const out: string[] = [];
  // 边界附近（含恰好等于阈值、恰好超 1）
  for (const n of [0, 1, 999, 1_000, 1_001, 23_999, 24_000, 24_001, 37_829, 48_000, 100_000]) {
    out.push('段落内容。'.repeat(Math.floor(n / 5) + 1).slice(0, n));
  }
  // 无断点长串（英文 + 单字符）
  for (const n of [24_001, 37_829, 50_000]) out.push('word '.repeat(Math.floor(n / 5) + 1).slice(0, n));
  out.push('索引优化'.repeat(9_000));
  out.push('a'.repeat(30_000));
  out.push('行内容\n'.repeat(7_000));
  out.push('句号结尾。'.repeat(9_000));
  out.push('');
  return out;
}

/**
 * 真跑 Python 的 `chunk.split_text`，返回每个用例的块区间。
 *
 * ## ⚠️ 必须显式钉死两端的 UTF-8（实测踩到的坑）
 * 通过 **stdin** 传中文时，Python 在 Windows 上默认按 **GBK** 解 UTF-8 字节
 * ⟹ 中文被解成乱码 / 长度翻倍。`[实测]`：传 `"段"`（1 字符）→ Python 收到 **2 字符**
 * ⟹ 块区间与 TS 对不上 → **parity 测试假红**（看着像"两份实现漂移"，实则是**传输编码**问题）。
 *
 * 修法（两道一起上，任一道就够，但都要防"环境变了"）：
 * 1. `-X utf8` + `PYTHONIOENCODING=utf-8`（钉死解释器/stdin 的编码）
 * 2. 传参**不用 stdin**，改用**临时文件**（`read_text(encoding='utf-8')`）——
 *    显式 UTF-8 读写，与 AGENTS 坑 20 的教训一致（"要改就用显式 UTF-8 读写"）。
 *
 * 与坑 20/23 同族：**跨进程边界的编码必须显式**，不能靠环境默认值。
 */
function pythonSplit(texts: string[]): [number, number][][] | null {
  const tmpIn = path.join(ROOT, `_parity_in_${process.pid}.json`);
  const tmpOut = path.join(ROOT, `_parity_out_${process.pid}.json`);
  const script = [
    'import json, sys',
    'sys.path.insert(0, ' + JSON.stringify(ROOT) + ')',
    'from worker.pipeline.chunk import split_text',
    // ★ 显式 UTF-8 读入（不依赖 stdin 的环境编码）
    "texts = json.loads(open(sys.argv[1], encoding='utf-8').read())",
    "open(sys.argv[2], 'w', encoding='utf-8').write(json.dumps([split_text(t, " + CAP + ') for t in texts]))',
  ].join('\n');
  try {
    fs.writeFileSync(tmpIn, JSON.stringify(texts), 'utf8');
    execFileSync('python', ['-X', 'utf8', '-c', script, tmpIn, tmpOut], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 60_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    return JSON.parse(fs.readFileSync(tmpOut, 'utf8')) as [number, number][][];
  } catch {
    return null;
  } finally {
    for (const f of [tmpIn, tmpOut]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* 清理失败不影响判据 */
      }
    }
  }
}

test('★ chunk-cost.ts 与 worker/pipeline/chunk.py 的分块结果**逐字一致**', () => {
  const texts = cases();
  const py = pythonSplit(texts);
  if (py === null) {
    // ⚠️ python 不可用：**必须响亮地说明**，不许静默通过（否则是假绿）
    assert.fail(
      'python 不可用 → 无法验证 TS/Python 分块等价性。' +
        '这条测试是"两份实现不许漂移"的唯一保证，缺失时必须显式失败（AGENTS 坑 10：不许假装可用）。',
    );
  }
  assert.equal(py.length, texts.length, 'Python 返回的用例数必须与输入一致');

  texts.forEach((t, i) => {
    const mine = splitText(t, CAP);
    const theirs = py[i]!;
    assert.deepEqual(
      mine,
      theirs,
      `用例 #${i}（len=${t.length}）分块结果不一致：\n` +
        `  TS     : ${JSON.stringify(mine)}\n` +
        `  Python : ${JSON.stringify(theirs)}`,
    );
  });
  // 至少有一个用例真的分了块（否则这条测试可能因为"全都单块"而空转）
  const chunked = texts.filter((t) => splitText(t, CAP).length > 1).length;
  assert.ok(chunked >= 5, `必须有多个用例真的分块（实际 ${chunked}），否则等价性测试没覆盖到分块路径`);
});

test('★ 两侧的 MIN_CHUNK_CHARS / 默认阈值常量一致', () => {
  assert.equal(MIN_CHUNK_CHARS, 1_000, 'TS 侧下限');
  // ⚠️ 用 `-X utf8` 钉死解码（同 `pythonSplit` 的教训：跨进程编码不许靠默认值）
  const script =
    'import sys; sys.path.insert(0, ' + JSON.stringify(ROOT) + '); ' +
    'from worker.pipeline.chunk import MIN_CHUNK_CHARS, DEFAULT_CHUNK_CHARS; ' +
    'print(MIN_CHUNK_CHARS, DEFAULT_CHUNK_CHARS)';
  let out = '';
  try {
    out = execFileSync('python', ['-X', 'utf8', '-c', script], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 30_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    }).trim();
  } catch {
    assert.fail('python 不可用 → 无法验证两侧常量一致');
  }
  const [pyMin, pyDefault] = out.split(/\s+/).map(Number);
  assert.equal(pyMin, MIN_CHUNK_CHARS, `MIN_CHUNK_CHARS 不一致：TS=${MIN_CHUNK_CHARS} Python=${pyMin}`);
  assert.equal(pyDefault, CAP, `DEFAULT_CHUNK_CHARS 不一致：TS=${CAP} Python=${pyDefault}`);
});
