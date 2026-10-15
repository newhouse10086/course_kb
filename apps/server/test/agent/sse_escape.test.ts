/**
 * SSE 写出必须转义 U+2028/U+2029（AGENTS.md ⚠️坑 17）。
 *
 * 独立验收（polysemy-prober）抓出的真 bug：`formatSse` 原本直接 `JSON.stringify(frame)`，
 * 於是 `data:` 行里出现**裸** U+2028 —— JSON 里合法、`JSON.stringify` 不报错，
 * 但按行切帧的读取器会把它当行分隔符 → 一帧裂成两帧、第二段不是合法 JSON → **静默丢事件**。
 *
 * 这里不只断言字符串，还**真的起 HTTP 服务走一遍字节**（质量门要求"有真实调用"）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { formatSse, SSE_KEEPALIVE, type AgentFrame } from '../../src/agent/stream.ts';
import { hasRawLineSeparator, safeJsonStringify } from '../../src/agent/guards.ts';

const NASTY = '报告\u2028结论如下\u2029完';

test('★ formatSse：不含裸 U+2028/U+2029，且 `data:` 只有一行', () => {
  const out = formatSse({ type: 'text_delta', delta: NASTY });
  assert.equal(hasRawLineSeparator(out), false, '★ `data:` 里不许出现裸行分隔符');
  assert.ok(out.includes('\\u2028'), '应转义成 \\u2028 字面量');
  assert.ok(out.includes('\\u2029'));
  assert.equal(out.split('\n').filter((l) => l.startsWith('data: ')).length, 1, 'data 必须单行');
  assert.ok(out.endsWith('\n\n'), 'SSE 事件以空行结束');
});

test('★ 转义后**不丢内容**：解析回来与原文逐字相等', () => {
  const out = formatSse({ type: 'text_delta', delta: NASTY });
  const dataLine = out.split('\n').find((l) => l.startsWith('data: '))!;
  const parsed = JSON.parse(dataLine.slice('data: '.length)) as { delta: string };
  assert.equal(parsed.delta, NASTY, '转义只影响传输，不影响语义');
  assert.equal(parsed.delta.length, NASTY.length);
});

test('★ 嵌套结构（message_end 的 message）里的行分隔符也被转义', () => {
  const frame: AgentFrame = {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: `a\u2028b` }], meta: { file: 'x\u2029y.json' } },
  };
  const out = formatSse(frame);
  assert.equal(hasRawLineSeparator(out), false);
  const parsed = JSON.parse(out.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as {
    message: { content: { text: string }[]; meta: { file: string } };
  };
  assert.equal(parsed.message.content[0]!.text, 'a\u2028b');
  assert.equal(parsed.message.meta.file, 'x\u2029y.json');
});

test('★ safeJsonStringify 与 tasks/bus.ts 的同名函数行为一致（同一条 SSE 契约）', async () => {
  const { safeJsonStringify: busVersion } = (await import('../../src/tasks/bus.ts')) as {
    safeJsonStringify: (v: unknown) => string;
  };
  for (const value of [NASTY, { a: 'x\u2028y' }, ['\u2029'], 42, null, { nested: { s: 'p\u2028q' } }]) {
    assert.equal(safeJsonStringify(value), busVersion(value), `与 bus.ts 结果不一致：${JSON.stringify(value)}`);
  }
});

test('★ 真实 HTTP：线上字节里没有裸 U+2028/U+2029，且客户端能按行解析出完整事件', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write(formatSse({ type: 'text_delta', delta: NASTY }));
    res.write(formatSse({ type: 'settled', aborted: false }));
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const buf = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/`)).arrayBuffer());
    const raw = buf.toString('utf8');
    // ★ 关键断言：字节层面不能出现裸行分隔符
    assert.ok(!raw.includes('\u2028'), '★ 线上出现裸 U+2028');
    assert.ok(!raw.includes('\u2029'), '★ 线上出现裸 U+2029');

    // 模拟"按行切帧"的读取器（AGENTS.md §3.1 里本项目自己写的那种）
    const events: { event: string; data: string }[] = [];
    let name = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event: ')) name = line.slice(7);
      else if (line.startsWith('data: ')) events.push({ event: name, data: line.slice(6) });
    }
    assert.equal(events.length, 2, `按行切帧应得到 2 个事件，实际 ${events.length}`);
    const first = JSON.parse(events[0]!.data) as { delta: string };
    assert.equal(first.delta, NASTY, '切帧后内容必须完整（不丢事件、不错切）');
    assert.equal(JSON.parse(events[1]!.data).type, 'settled');
  } finally {
    server.close();
  }
});

test('SSE keepalive 是注释行（不含 JSON，也就不会有行分隔符问题）', () => {
  assert.ok(SSE_KEEPALIVE.startsWith(':'), 'keepalive 必须是 SSE 注释');
  assert.equal(hasRawLineSeparator(SSE_KEEPALIVE), false);
  assert.equal(SSE_KEEPALIVE.endsWith('\n\n'), true);
});
