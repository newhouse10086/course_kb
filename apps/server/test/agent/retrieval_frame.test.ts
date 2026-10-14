/**
 * ★ 契约 `RETRIEVAL.md` §4/§6：`retrieval` 元信息帧。
 *
 * 独立验收（polysemy-prober）发现：四种模式下**没有任何一帧**带检索元信息 ——
 * 数据（`retrievalStatus`/`retrievalReason`）本来就算出来了，还进了 audit，**就是没发给客户端**。
 * 后果：学生无法知道这次回答有没有用知识库、用的哪种检索；UI 也做不出模式徽标。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_FRAME_TYPES,
  createChatConnection,
  makeRetrievalFrame,
  type AgentFrame,
  type ChatSessionLike,
  type ReadyFrame,
  type RetrievalFrame,
} from '../../src/agent/stream.ts';
import type { RetrievedHitLike } from '../../src/agent/guards.ts';

class FakeSession implements ChatSessionLike {
  readonly id = 'r-fake';
  isRunning = false;
  answer = '回答';
  promptCalls: string[] = [];
  private listeners = new Set<(f: AgentFrame) => void>();
  subscribe(fn: (f: AgentFrame) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  async prompt(message: string) {
    this.promptCalls.push(message);
    for (const l of [...this.listeners]) l({ type: 'text_delta', delta: this.answer });
    for (const l of [...this.listeners]) l({ type: 'settled', aborted: false });
    return { disposition: 'started', aborted: false, syntheticSettled: false };
  }
  async abort(): Promise<void> {}
  async reset(): Promise<ReadyFrame> {
    return this.readyFrame();
  }
  readyFrame(): ReadyFrame {
    return {
      type: 'ready', session_id: this.id, model: null, tools: [], tools_source: 'none', version: null,
      mode: 'sdk', persistence: 'ephemeral', persistence_reason: '测试', session_file: null,
      pi_session_id: null, thinking_level: null, restarted: false,
    };
  }
}

const HITS: RetrievedHitLike[] = [
  { kind: 'unit', ref_id: 'unt_0001', title: '3.1 聚簇索引', score: 27.8, why: 'bigram 命中「索引」' },
  { kind: 'card', ref_id: 'crd_0042', title: 'B+ 树', score: 12.1, why: 'DEPENDS_ON 1 跳：索引 → B+树' },
];

function run(mode: unknown, retrieval: unknown): Promise<{ frames: AgentFrame[]; audit: unknown[] }> {
  const session = new FakeSession();
  const frames: AgentFrame[] = [];
  const audit: unknown[] = [];
  return (async () => {
    const conn = await createChatConnection({
      sessionId: `r-${String(mode)}`,
      send: (f) => {
        frames.push(f);
      },
      manager: { getOrCreate: async () => session, release: () => {} },
      ...(retrieval === null ? {} : { retrieval: retrieval as never }),
      user: { id: 'u1' },
      onAnswerAudit: (a) => audit.push(a),
    });
    await conn.handleClientMessage(JSON.stringify({ type: 'prompt', message: '什么是聚簇索引', retrieval: mode }));
    for (let i = 0; i < 50 && !frames.some((f) => f.type === 'settled'); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await conn.close();
    return { frames, audit };
  })();
}

const okHook = {
  async retrieve() {
    return { available: true, items: HITS, elapsedMs: 1240 };
  },
};

test('★ 契约帧名已注册：AGENT_FRAME_TYPES 含 retrieval', () => {
  assert.ok(AGENT_FRAME_TYPES.includes('retrieval'), '契约 §4 的检索帧必须登记在允许帧里');
});

test('★★ 四种模式**每种都发 retrieval 帧**，且 mode 与请求一致', async () => {
  for (const mode of ['none', 'wiki', 'kg', 'rag']) {
    const { frames } = await run(mode, okHook);
    const rs = frames.filter((f) => f.type === 'retrieval') as RetrievalFrame[];
    assert.equal(rs.length, 1, `${mode}：恰好一帧 retrieval，实际 ${rs.length}（帧类型=${frames.map((f) => f.type).join(',')}）`);
    assert.equal(rs[0]!.mode, mode, `${mode}：mode 必须与请求一致`);
  }
});

test('★ none 与 empty 必须可区分（学生看不出区别 = 教学对比落不了地）', async () => {
  const none = (await run('none', okHook)).frames.find((f) => f.type === 'retrieval') as RetrievalFrame;
  assert.equal(none.status, 'none');
  assert.equal(none.hits, 0);
  assert.equal(none.available, true, 'none 不是"不可用"，是用户主动不检索');
  assert.match(none.why.join(' '), /不使用知识库/);

  const empty = (
    await run('wiki', {
      async retrieve() {
        return { available: true, items: [], elapsedMs: 88 };
      },
    })
  ).frames.find((f) => f.type === 'retrieval') as RetrievalFrame;
  assert.equal(empty.status, 'empty');
  assert.equal(empty.hits, 0);
  assert.equal(empty.available, true, 'empty 是"可用但没命中"');
  assert.match(empty.why.join(' '), /0 命中/);
  assert.notEqual(none.status, empty.status, '★ 两者 status 必须不同');
});

test('★ 命中时带上 hits/elapsedMs/why/sources（UI 能显示"命中什么、为什么"）', async () => {
  const rs = (await run('kg', okHook)).frames.find((f) => f.type === 'retrieval') as RetrievalFrame;
  assert.equal(rs.status, 'ok');
  assert.equal(rs.hits, 2);
  assert.equal(rs.elapsedMs, 1240);
  assert.deepEqual(rs.why, ['bigram 命中「索引」', 'DEPENDS_ON 1 跳：索引 → B+树']);
  assert.deepEqual(rs.sources, [
    { kind: 'unit', ref_id: 'unt_0001', title: '3.1 聚簇索引', score: 27.8 },
    { kind: 'card', ref_id: 'crd_0042', title: 'B+ 树', score: 12.1 },
  ]);
  assert.equal(rs.reason, '');
});

test('★★ 检索不可用 → **也要发帧**（available:false + 可读 reason，而不是不发）', async () => {
  const rs = (
    await run('rag', {
      async retrieve() {
        return { available: false, reason: '未配置 embedding provider（providers.embedding 为空）', items: [] };
      },
    })
  ).frames.find((f) => f.type === 'retrieval') as RetrievalFrame;
  assert.equal(rs.status, 'unavailable');
  assert.equal(rs.available, false);
  assert.match(rs.reason, /未配置 embedding provider/);
  assert.match(rs.why.join(' '), /不可用/);
  assert.equal(rs.hits, 0);
});

test('★ 检索抛错 → status=error + reason（不把整轮搞挂）', async () => {
  const { frames } = await run('wiki', {
    async retrieve() {
      throw new Error('FTS5 表不存在');
    },
  });
  const rs = frames.find((f) => f.type === 'retrieval') as RetrievalFrame;
  assert.equal(rs.status, 'error');
  assert.equal(rs.available, false);
  assert.match(rs.reason, /FTS5 表不存在/);
  assert.ok(frames.some((f) => f.type === 'settled'), '仍然正常结束');
});

test('★ 客户端没传 retrieval（缺省 none）→ 也发帧，UI 可统一处理', async () => {
  const session = new FakeSession();
  const frames: AgentFrame[] = [];
  const conn = await createChatConnection({
    sessionId: 'r-default',
    send: (f) => {
      frames.push(f);
    },
    manager: { getOrCreate: async () => session, release: () => {} },
    user: { id: 'u1' },
  });
  await conn.handleClientMessage(JSON.stringify({ type: 'prompt', message: '问' }));
  for (let i = 0; i < 50 && !frames.some((f) => f.type === 'settled'); i += 1) await new Promise((r) => setTimeout(r, 5));
  const rs = frames.find((f) => f.type === 'retrieval') as RetrievalFrame;
  assert.ok(rs, '缺省也要发（mode=none）');
  assert.equal(rs.mode, 'none');
  await conn.close();
});

test('★ 帧顺序：ready → retrieval → text_delta … → settled（且每轮恰好一帧）', async () => {
  const session = new FakeSession();
  const frames: AgentFrame[] = [];
  const conn = await createChatConnection({
    sessionId: 'r-order',
    send: (f) => {
      frames.push(f);
    },
    manager: { getOrCreate: async () => session, release: () => {} },
    retrieval: okHook as never,
    user: { id: 'u1' },
  });
  await conn.handleClientMessage(JSON.stringify({ type: 'prompt', message: '问 1', retrieval: 'wiki' }));
  for (let i = 0; i < 50 && !frames.some((f) => f.type === 'settled'); i += 1) await new Promise((r) => setTimeout(r, 5));
  const types = frames.map((f) => f.type);
  assert.equal(types[0], 'ready', 'ready 必须第一帧');
  assert.equal(types[1], 'retrieval', '★ retrieval 应在 ready 之后、text_delta 之前');
  assert.ok(types.indexOf('retrieval') < types.indexOf('text_delta'));
  assert.equal(types.at(-1), 'settled');

  // 第二轮 → 再来一帧（每轮一帧）
  await conn.handleClientMessage(JSON.stringify({ type: 'prompt', message: '问 2', retrieval: 'kg' }));
  for (let i = 0; i < 50 && frames.filter((f) => f.type === 'settled').length < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(frames.filter((f) => f.type === 'retrieval').length, 2, '两轮 → 两帧');
  await conn.close();
});

test('★ 帧里不带正文片段（别把知识库正文推给浏览器）', async () => {
  const long = 'X'.repeat(2000);
  const rs = (
    await run('wiki', {
      async retrieve() {
        return { available: true, elapsedMs: 5, items: [{ kind: 'unit', ref_id: 'unt_9', title: 'T', snippet: long, score: 1 }] };
      },
    })
  ).frames.find((f) => f.type === 'retrieval') as RetrievalFrame;
  const wire = JSON.stringify(rs);
  assert.ok(!wire.includes(long), '★ 帧里不该带正文片段');
  assert.ok(!('snippet' in (rs.sources[0] ?? {})), 'sources 只给跳转需要的最小信息');
});

test('makeRetrievalFrame 纯函数：检索器没给 why 时给确定性说明（不编造）', () => {
  const frame = makeRetrievalFrame({
    mode: 'wiki',
    status: 'ok',
    hits: 3,
    elapsedMs: 10,
    reason: '',
    items: [{ ref_id: 'a' }, { ref_id: 'b' }, { ref_id: 'c' }],
  });
  assert.equal(frame.why.length, 1);
  assert.match(frame.why[0]!, /wiki 检索命中 3 条/);
  assert.match(frame.why[0]!, /未提供 why/);
  assert.deepEqual(
    frame.sources.map((s) => s.kind),
    ['unknown', 'unknown', 'unknown'],
    'kind 缺失时不编造',
  );
  // 超过 5 条只给前 5（别让帧无限大）
  const many = makeRetrievalFrame({
    mode: 'kg',
    status: 'ok',
    hits: 9,
    elapsedMs: 1,
    reason: '',
    items: Array.from({ length: 9 }, (_, i) => ({ ref_id: `c${i}` })),
  });
  assert.equal(many.sources.length, 5);
});
