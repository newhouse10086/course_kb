/**
 * ★ `tool_start` 是否"重复发"的**帧层判据**（lead 要求：以 call id 为准，不靠时间戳猜）。
 *
 * 真机判定（`subagents/tool_id_probe.mjs`，真 SDK + 真模型）：
 * ```
 * 探针 A 原始 SDK 事件：tool_execution_start ×2，id 各不相同（call_00_… / call_01_…），
 *                       两者在**同一毫秒**（14681/14682ms）—— 这是"模型在同一轮里并行调了两个工具"，
 *                       不是重复发帧。start/end 各 1:1。
 * 探针 B 我的帧：       tool_start ×2（id 与 A 逐一对应）、tool_end ×2、tool_update ×0
 * ```
 * ⟹ 结论：**模型真的调了两次（并行）**，不是帧层 bug。前端按 id 分组天然正确。
 *
 * 本文件把"帧层不会重复"这条性质钉住：
 * `tool_execution_start` → **恰好一条** `tool_start`（同 id 不会出现两次），且 id 来自 `toolCallId`。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMapperState, mapSdkEvent, type MapperState } from '../../src/agent/stream.ts';

const freshState = (): MapperState => createMapperState();

test('★ 一次 tool_execution_start → 恰好一条 tool_start，且 id = toolCallId', () => {
  const state = freshState();
  const frames = mapSdkEvent(
    { type: 'tool_execution_start', toolCallId: 'call_00_abc', toolName: 'kb_search', args: { query: '聚簇索引' } } as never,
    state,
  );
  assert.equal(frames.length, 1, '一次事件只该产出一帧（重复发就会在这里被抓住）');
  assert.equal(frames[0]!.type, 'tool_start');
  const f = frames[0] as { id?: unknown; tool?: unknown; args?: unknown };
  assert.equal(f.id, 'call_00_abc', '★ id 字段名是 `id`，值来自 SDK 的 `toolCallId`');
  assert.equal(f.tool, 'kb_search');
  assert.deepEqual(f.args, { query: '聚簇索引' });
});

test('★★ 并行两次调用（同一毫秒、id 不同）→ 两条 tool_start，id 各自独立（不是重复）', () => {
  const state = freshState();
  const events = [
    { type: 'tool_execution_start', toolCallId: 'call_00_x', toolName: 'kb_get', args: { ref_id: 'crd_1' } },
    { type: 'tool_execution_start', toolCallId: 'call_01_y', toolName: 'kb_get', args: { ref_id: 'crd_2' } },
    { type: 'tool_execution_end', toolCallId: 'call_00_x', toolName: 'kb_get', isError: false, durationMs: 2, result: { content: [{ type: 'text', text: 'A' }] } },
    { type: 'tool_execution_end', toolCallId: 'call_01_y', toolName: 'kb_get', isError: false, durationMs: 3, result: { content: [{ type: 'text', text: 'B' }] } },
  ] as const;
  const frames = events.flatMap((e) => mapSdkEvent(e as never, state));
  const starts = frames.filter((f) => f.type === 'tool_start') as { id: string; tool: string }[];
  assert.equal(starts.length, 2, '两次调用 → 两条 start（模型真的调了两次，前端应如实显示）');
  assert.deepEqual(starts.map((s) => s.id), ['call_00_x', 'call_01_y'], 'id 必须各不相同');
  assert.equal(new Set(starts.map((s) => s.id)).size, starts.length, '同 id 重复出现 = 帧层 bug（这里必须为假）');
  const ends = frames.filter((f) => f.type === 'tool_end') as { id: string }[];
  assert.deepEqual(ends.map((e) => e.id), ['call_00_x', 'call_01_y'], '每个 id 恰好一条 end（1:1）');
});

test('★★ 同一 id 若被重复触发（模拟 SDK/上游重复发）→ 会产出两条同 id 帧（可被上层断言发现）', () => {
  const state = freshState();
  const ev = { type: 'tool_execution_start', toolCallId: 'call_dup', toolName: 'kb_search', args: {} } as never;
  const frames = [...mapSdkEvent(ev, state), ...mapSdkEvent(ev, state)];
  assert.equal(frames.filter((f) => f.type === 'tool_start').length, 2);
  // ⚠️ 映射层是**无状态**的（不记忆已发过的 id）——这是刻意的：
  //    "是否重复"要靠**消费侧按 id 去重**判断，而不是让映射层悄悄吞事件（吞了会丢真实调用）。
  //    真机上（探针 A）SDK 从未对同一 id 发过两次 start，所以现状无需去重。
});
