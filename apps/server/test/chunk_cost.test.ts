/**
 * 长文本分块的 **Node 侧**判据（`chunk-cost.ts`）—— 与 `worker/tests/test_chunk.py` 互补。
 *
 * ## 这条测试守什么
 * 1. **超长 → 真的分块**（块数 > 1）：`estimateChunkCalls` 严格大于单元数
 * 2. **短单元不分块**（反例，防"全都分"）
 * 3. **不丢字**：块区间连续覆盖全文（截断会丢尾部 —— 红证打的就是这个）
 * 4. **代价可见**：调用数 = 分块后的真实块数（`needs_confirm` 闸门按它算）
 * 5. **`chunkChars` 真的生效**（坑 24：它曾经是死旋钮）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MIN_CHUNK_CHARS,
  chunkCount,
  countChunkedUnits,
  estimateChunkCalls,
  splitText,
} from '../src/tasks/chunk-cost.ts';
import { DEFAULT_CHUNK_CHARS } from '../src/tasks/extract.ts';

const CAP = DEFAULT_CHUNK_CHARS;

test('★ 超长文本 → 真的分块（块数 > 1），而不是截断', () => {
  const text = '索引优化方法。'.repeat(4_000); // 7 × 4000 = 28,000 > 24,000
  assert.ok(text.length > CAP, `前置：文本必须超过阈值（实际 ${text.length}）`);
  const ranges = splitText(text, CAP);
  assert.ok(ranges.length > 1, `超长文本必须分块，实际 ${ranges.length} 块`);
  assert.equal(chunkCount(text, CAP), ranges.length);
});

test('★ 不丢字：块区间连续、无重叠、完整覆盖（截断会丢尾部）', () => {
  const text = '内容。'.repeat(20_000); // 60,000 字
  const ranges = splitText(text, CAP);
  assert.ok(ranges.length >= 3, `60k 字应至少 3 块，实际 ${ranges.length}`);

  // ① 起点 0、终点 == 长度
  assert.equal(ranges[0]![0], 0);
  assert.equal(ranges[ranges.length - 1]![1], text.length);
  // ② 连续无缝
  for (let i = 1; i < ranges.length; i += 1) {
    assert.equal(ranges[i]![0], ranges[i - 1]![1], `第 ${i} 块与前一块之间不许有缝隙`);
  }
  // ③ 覆盖总长 == 原文长度（★ 这条就是"分块 vs 截断"的判据）
  const covered = ranges.reduce((n, [a, b]) => n + (b - a), 0);
  assert.equal(covered, text.length, '分块必须覆盖全文（截断版只会覆盖 CAP）');
  assert.ok(covered > CAP, '覆盖量必须超过单次上限 —— 否则说明就是截断');
});

test('★ 短单元不分块（反例，防"全都分"）', () => {
  for (const n of [0, 1, 100, 999, 1_000, 12_000, CAP - 1, CAP]) {
    const text = '内'.repeat(n);
    const expect = n === 0 ? 0 : 1;
    assert.equal(chunkCount(text, CAP), expect, `${n} 字应为 ${expect} 块`);
  }
  // 恰好超 1 → 2 块（阈值是"包含"）
  assert.equal(chunkCount('内'.repeat(CAP + 1), CAP), 2);
});

test('★ 调用数 = 分块后的真实块数（代价可见，`needs_confirm` 按它算）', () => {
  // 840 个单元里 111 个超长 → 调用数由 840 增至 951（真库实测形状）
  const texts = [
    ...Array.from({ length: 840 - 111 }, () => 'x'.repeat(24_000)),
    ...Array.from({ length: 111 }, () => 'y'.repeat(37_829)),
  ];
  const calls = estimateChunkCalls(texts, CAP);
  assert.equal(calls, 840 - 111 + 111 * 2);
  assert.equal(calls, 951, '★ 真库实测：840 单元 → 951 次调用（多 111 次）');
  assert.ok(calls > texts.length, '有长单元时调用数必须严格大于单元数');

  // 没有长单元时 == 单元数（与改前一致）
  assert.equal(estimateChunkCalls(Array.from({ length: 7 }, () => 'x'.repeat(100)), CAP), 7);
  // 空正文单元仍占 1 个"位"（Node 闸门要能看见它 → W_EMPTY_INPUT）
  assert.equal(estimateChunkCalls([''], CAP), 1);
  assert.equal(chunkCount('', CAP), 0, '但"能切出几块"是 0 —— 两个问题不同');
});

test('★ `chunkChars` 真的生效（坑 24：曾是死旋钮）', () => {
  const text = 'x'.repeat(10_000);
  // 极小阈值被 MIN_CHUNK_CHARS 兜住
  assert.equal(chunkCount(text, 10), chunkCount(text, MIN_CHUNK_CHARS));
  // ★ 阈值变小 → 块数变多（证明参数被真的读进去了）
  const big = chunkCount(text, 8_000);
  const small = chunkCount(text, 2_000);
  assert.ok(small > big, `阈值必须真的生效：8000→${big} 块，2000→${small} 块`);
  // 阈值大于文本 → 永远 1 块
  assert.equal(chunkCount(text, 100_000), 1);
});

test('★ countChunkedUnits 如实报"有多少长单元被分块"', () => {
  const texts = ['a'.repeat(100), 'b'.repeat(CAP + 1), 'c'.repeat(100_000), ''];
  // 只有 b、c 超过阈值（a 短、空文本不算"分块"）
  assert.equal(countChunkedUnits(texts, CAP), 2);
  assert.equal(countChunkedUnits([], CAP), 0);
});

test('★ 优先在自然边界断开（不在句子中间劈开）', () => {
  const text = '第一句。'.repeat(10_000); // 40,000 字
  const ranges = splitText(text, CAP);
  assert.ok(ranges.length >= 2);
  for (const [a, b] of ranges.slice(0, -1)) {
    const tail = text.slice(a, b).trimEnd();
    assert.ok(
      ['。', '\n', '；', '！', '？'].some((p) => tail.endsWith(p)),
      `非末块应以自然边界结尾，实际结尾=${JSON.stringify(text.slice(Math.max(a, b - 8), b))}`,
    );
  }
});
