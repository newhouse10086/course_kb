/**
 * 长文本分块的**调用数预估**（与 `worker/pipeline/chunk.py` **必须逐字等价**）。
 *
 * ## 为什么要在 TS 侧再实现一份（而不是调 worker）
 * `needs_confirm` 闸门发生在 `parse` 的第 ④ 步（`handlers.ts`），**早于** `extract.plan`；
 * 而闸门必须在**任何 LLM 调用之前**给出"要花多少次调用"的决定。
 * 为了不在闸门处额外起一次 worker 进程（慢 + 多一条失败路径），这里做一份**镜像实现**。
 *
 * ## 为什么不怕"两份实现漂移"
 * `test/chunk_parity.test.ts` **同一批输入同时跑两份**（TS 这份 + 真跑 Python 那份），
 * 断言结果完全一致 —— 漂移会被测试立刻抓住。
 * 判据：**"两份实现"只有在有等价性测试时才是可接受的**；否则就是同族坑（承诺 ≠ 生效）。
 *
 * ⚠️ 阈值默认值也必须一致：这里用 `extract.ts` 的 `DEFAULT_CHUNK_CHARS`，
 * Python 侧用 `chunk.DEFAULT_CHUNK_CHARS`（两边都是 24_000，测试对账）。
 */

import { DEFAULT_CHUNK_CHARS } from './extract.ts';

/** 与 Python `chunk.MIN_CHUNK_CHARS` 一致。 */
export const MIN_CHUNK_CHARS = 1_000;

/** 与 Python `chunk.split_text` 的 `breaks` 一致（**顺序即优先级**）。 */
const BREAKS = ['\n\n', '\n', '。', '；', '！', '？', '. ', '; ', ' '] as const;

/**
 * 把正文切成 `[start, end)` 区间 —— **不丢字**，优先在自然边界断开。
 *
 * 逐字镜像 `worker/pipeline/chunk.py::split_text`（含"只在窗口后半段找断点"的规则）。
 */
export function splitText(text: string, chunkChars: number = DEFAULT_CHUNK_CHARS): [number, number][] {
  const s = text ?? '';
  const n = s.length;
  if (n === 0) return [];
  const cap = Math.max(MIN_CHUNK_CHARS, Math.trunc(chunkChars));
  if (n <= cap) return [[0, n]];

  const out: [number, number][] = [];
  let start = 0;
  while (start < n) {
    let end = Math.min(n, start + cap);
    if (end < n) {
      const floor = start + Math.floor(cap / 2);
      let best = -1;
      for (const br of BREAKS) {
        const pos = s.lastIndexOf(br, end - 1);
        if (pos >= floor && pos + br.length > best) best = pos + br.length;
      }
      if (best > start) end = best;
    }
    out.push([start, end]);
    start = end;
  }
  return out;
}

/** 一个单元的块数（与 Python `len(split_unit(...))` 等价）。 */
export function chunkCount(text: string, chunkChars: number = DEFAULT_CHUNK_CHARS): number {
  return splitText(text, chunkChars).length;
}

/**
 * 一批单元的**实际 LLM 调用数**（= 分块后的块总数）。
 *
 * 短单元 1 块 ⟹ 结果等于单元数（与改前一致）；长单元多块 ⟹ 大于单元数。
 */
export function estimateChunkCalls(texts: string[], chunkChars: number = DEFAULT_CHUNK_CHARS): number {
  return texts.reduce((sum, t) => sum + Math.max(1, chunkCount(t ?? '', chunkChars)), 0);
}

/** 发生分块（>1 块）的单元数 —— 供 meta 展示"其中 N 个长单元被分块"。 */
export function countChunkedUnits(texts: string[], chunkChars: number = DEFAULT_CHUNK_CHARS): number {
  return texts.reduce((n, t) => n + (chunkCount(t ?? '', chunkChars) > 1 ? 1 : 0), 0);
}
