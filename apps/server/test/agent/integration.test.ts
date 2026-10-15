/**
 * **真实 SDK 集成测试**（进程内真 pi，不是 mock）。
 *
 * 这一组测试回答两件事：
 *   1. 契约里标着"必须现场核实"的 **`prompt()` resolve 语义**（实测：resolve 时本轮已结束）
 *   2. v1 的安全教训在 SDK 路径下**同样成立**：系统提示词一个字节都不许下发
 *
 * ⚠️ 本组测试**不依赖"模型能答对"**：本机 LLM 凭据额度耗尽（402 insufficient_balance）/
 * provider 无订阅（403），因此断言全部是**结构性**的（帧类型、时序、泄漏、计数），
 * 不看模型输出内容。配额恢复后这些断言同样成立（只会多出 text_delta）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentSessionManager } from '../../src/agent/session.ts';
import { loadSdk } from '../../src/agent/sdk.ts';
import { HINT_SDK_OK, HINT_SDK_BAD } from '../../src/agent/errors.ts';
import { SYSTEM_PROMPT_MARKERS, type AgentFrame } from '../../src/agent/stream.ts';

/** 每轮最长等待（模型慢/重试都需要时间；实测 403 走 3 次重试约 25s） */
const ROUND_TIMEOUT_MS = 150_000;

/**
 * ★ **真调 LLM 的测试只在显式开启时跑** —— 否则每次 `npm test` 都会：
 *   ① **烧真实额度**（用户明确要求控制成本）
 *   ② **flaky**：实测撞过 `E_PI_TIMEOUT`（一次 28.5s 后整轮失败）
 * 与 `test:e2e:audio` / `test:e2e:agent` **同一处理方式**（真机 e2e 不进默认套件）。
 *
 * 开启：`COURSE_KB_LLM_E2E=1 npm test`（或 `npm run test:e2e:llm`）
 *
 * ⚠️ **原错误写法**：这些测试**无条件**在默认套件里跑 →
 *    `npm test` 每次都花额度，且网络/上游一抖动就红（把"环境抖动"报成"代码回归"）。
 */
const REAL_LLM = process.env.COURSE_KB_LLM_E2E === '1';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
      timer.unref?.();
    }),
  ]);
}

function assertNoSystemPromptLeak(frames: AgentFrame[], label: string): void {
  const wire = JSON.stringify(frames);
  for (const marker of SYSTEM_PROMPT_MARKERS) {
    assert.ok(!wire.includes(marker), `${label}：下发帧命中系统提示词特征串「${marker}」`);
  }
  assert.ok(!wire.includes('project_instructions'), `${label}：AGENTS.md 内容泄漏`);
}

// ===========================================================================

test('真实 loadSdk：pi SDK 1.2.0 可加载，导出可用', async () => {
  const sdk = await loadSdk({ force: true });
  assert.equal(sdk.available, true, sdk.available ? '' : `不可用：${sdk.reason}`);
  if (!sdk.available) return;
  assert.equal(sdk.version, '1.2.0', 'npm latest 实测为 1.2.0');
  assert.equal(typeof sdk.createAgentSession, 'function');
  assert.equal(typeof sdk.SessionManager, 'function');
  assert.ok(sdk.loadMs > 0);
  console.log(`    [measure] SDK 首次加载 ${sdk.loadMs}ms，version=${sdk.version}`);
});

test('★ 真实会话一轮：结束信号时序 + system 提示词不外泄 + 持久化可观测', { skip: !REAL_LLM }, async () => {
  const chatDir = mkdtempSync(join(tmpdir(), 'agent-real-'));
  const manager = new AgentSessionManager({
    sessionDir: chatDir, // 真落盘（验证 session_file 可观测）
    tools: [], // 不给工具：测试不该动项目文件
    onDiagnostic: (m) => console.log(`    [diag] ${m}`),
  });
  console.log(`    [measure] manager.cwd=${manager.cwd}`);
  assert.ok(manager.cwd.endsWith('course-kb') || manager.cwd.length > 0);

  const session = await manager.getOrCreate('integration-real-1');
  const ready = session.readyFrame();
  console.log(`    [measure] ready=${JSON.stringify({ ...ready, persistence_reason: undefined })}`);
  assert.equal(ready.type, 'ready');
  assert.equal(ready.mode, 'sdk');
  assert.ok(ready.model, '真实会话必须有模型');
  assert.equal(ready.persistence, 'native');
  assert.ok(ready.pi_session_id, 'pi 自己的 sessionId 必须可观测');
  assert.ok(String(ready.session_file).endsWith('.jsonl'));
  assertNoSystemPromptLeak([ready], 'ready 帧');

  // ★ 先订阅再 prompt（坑 14）
  const frames: AgentFrame[] = [];
  let settledAt: number | null = null;
  session.subscribe((frame) => {
    if (frame.type === 'settled') settledAt = Date.now();
    frames.push(frame);
  });

  const startedAt = Date.now();
  const outcome = await withTimeout(session.prompt('只回复 ok 两个字，不要使用任何工具。'), ROUND_TIMEOUT_MS, '真实 prompt');
  const resolvedAt = Date.now();

  const types = frames.map((f) => f.type);
  console.log(
    `    [measure] prompt() ${resolvedAt - startedAt}ms 结束；帧序列=${types.join(',')}；disposition=${outcome.disposition}`,
  );

  // --- 结束信号（契约的待核实点）---
  assert.ok(settledAt !== null, `必须收到 settled（帧序列：${types.join(',')}）`);
  assert.equal(types.filter((t) => t === 'settled').length, 1, '一轮恰好一个 settled');
  const settleDelay = (settledAt as number | null)! - resolvedAt;
  console.log(`    [measure] prompt() resolve 与 agent_settled 相差 ${settleDelay}ms`);
  assert.ok(
    Math.abs(settleDelay) < 1000,
    `实测 resolve 与 settled 应在同一时间尺度内（实际 ${settleDelay}ms）`,
  );
  assert.ok(settledAt! <= resolvedAt + 50, 'prompt() resolve 时本轮应当已经结束（agent_settled 已发）');

  // --- ⚠️6 系统提示词 ---
  assertNoSystemPromptLeak(frames, '真实一轮');
  // 断言**角色**而不是条数：流量取决于模型行为（失败重试时每次尝试都会有一条 assistant
  // 的 message_end —— v1 实测 403 一轮就有 4 条）。原写法 `<= 2` 把"重试次数"当成了不变量，
  // 是错的断言；真正的不变量是「**system 角色的 message_end 一条都不许转发**」。
  const messageEnds = frames.filter((f) => f.type === 'message_end');
  const roles: string[] = messageEnds.map((f) => String((f.message as { role?: unknown } | null)?.role ?? '?'));
  const badRoles: string[] = roles.filter((r) => r !== 'user' && r !== 'assistant');
  assert.equal(badRoles.length, 0, `message_end 只应有 user/assistant，实际：${roles.join(',')}`);

  // --- ⚠️7 失败可见：模型不可用时必须**恰好一条** error，且 hint 指明"SDK 正常" ---
  const errors = frames.filter((f) => f.type === 'error');
  assert.ok(errors.length <= 1, `最多一条 error，实际 ${errors.length}`);
  if (errors.length === 1) {
    const err = errors[0]!;
    assert.equal(err.type === 'error' && err.code, 'E_LLM');
    assert.ok(
      String(err.type === 'error' ? err.hint : '').startsWith(HINT_SDK_OK),
      `hint 必须说清"SDK 是好的"：${String(err.type === 'error' ? err.hint : '')}`,
    );
    assert.ok(!String(err.type === 'error' ? err.hint : '').startsWith(HINT_SDK_BAD));
    console.log(`    [measure] 真实失败帧：${JSON.stringify({ code: err.code, msg: String(err.msg).slice(0, 120), hint: err.hint })}`);
  } else {
    console.log('    [measure] 本轮模型侧成功（无 error 帧）');
  }

  // --- 持久化真的落盘了（首次 prompt 之后）---
  const file = session.currentSessionFile();
  assert.ok(file && existsSync(file), `会话文件应已落盘：${String(file)}`);

  assert.equal(session.isRunning, false, '结束后必须回到空闲');

  const before = frames.length;
  await session.prompt('第二轮：只回复 ok。').catch(() => undefined);
  assert.ok(frames.length > before, '第二轮也要能跑（会话可复用）');
  assertNoSystemPromptLeak(frames, '两轮合计');

  manager.closeAll();
  rmSync(chatDir, { recursive: true, force: true });
});

test('★ 真实 abort：运行中中断 → 本轮结束、回到空闲（aborted 字段是布尔）', { skip: !REAL_LLM }, async () => {
  const manager = new AgentSessionManager({ sessionDir: null, tools: [] });
  const session = await manager.getOrCreate('integration-real-abort');
  const frames: AgentFrame[] = [];
  session.subscribe((f) => frames.push(f));

  const running = session.prompt('写一篇 800 字的数据库索引科普文章。').catch(() => undefined);
  // 等运行真的开始（agent_settled 之前 isRunning=true）
  await new Promise((r) => setTimeout(r, 800));
  const wasRunning = session.isRunning;
  await session.abort();
  await withTimeout(running, ROUND_TIMEOUT_MS, 'abort 后的 prompt');

  const settled = frames.filter((f) => f.type === 'settled');
  assert.equal(settled.length, 1, `中断后应恰好一个 settled；帧序列=${frames.map((f) => f.type).join(',')}`);
  const s = settled[0]!;
  assert.equal(typeof (s.type === 'settled' ? s.aborted : undefined), 'boolean');
  console.log(`    [measure] abort：运行中=${wasRunning}，settled.aborted=${String(s.type === 'settled' ? s.aborted : '?')}，abort_source=${String((s as { abort_source?: string }).abort_source ?? 'none')}`);
  assert.equal(session.isRunning, false);
  manager.closeAll();
});

// ---------------------------------------------------------------------------
// 真流式（需要可用凭据；没有就 skip。模型侧失败时也**不算**测试失败，但会如实打印）
// ---------------------------------------------------------------------------

const COURSE_KB_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const envPath = join(COURSE_KB_ROOT, '.env');

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !m[1] || m[2] === undefined) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const projectEnv = readEnvFile(envPath);
const hasProjectLlm = Boolean(projectEnv.AMR_BASE && projectEnv.AMR_KEY && projectEnv.LLM_MODEL);

test(
  '★ 真实流式（本项目 LLM 凭据）：逐字 delta + 结束信号 + 无系统提示词泄漏',
  { skip: hasProjectLlm ? false : 'SKIP: course-kb/.env 缺 AMR_BASE/AMR_KEY/LLM_MODEL' },
  async () => {
    // 临时 agentDir：把项目的 OpenAI 兼容端点告诉 pi（**只写进 os.tmpdir()，测完删除**）
    const agentDir = mkdtempSync(join(tmpdir(), 'agent-creds-'));
    const modelId = projectEnv.LLM_MODEL!;
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          amr: {
            baseUrl: projectEnv.AMR_BASE,
            api: 'openai-completions',
            apiKey: projectEnv.AMR_KEY,
            models: [{ id: modelId }],
          },
        },
      }),
      'utf8',
    );
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultModel: `amr/${modelId}` }), 'utf8');

    const manager = new AgentSessionManager({ agentDir, sessionDir: null, tools: [] });
    const frames: AgentFrame[] = [];
    try {
      const session = await manager.getOrCreate('integration-real-stream');
      let settledAt: number | null = null;
      session.subscribe((f) => {
        if (f.type === 'settled') settledAt = Date.now();
        frames.push(f);
      });

      const started = Date.now();
      await withTimeout(session.prompt('用三句话解释数据库索引是什么。'), ROUND_TIMEOUT_MS, '真实流式 prompt');
      const resolvedAt = Date.now();

      const deltas = frames.filter((f) => f.type === 'text_delta');
      const errors = frames.filter((f) => f.type === 'error');
      const text = deltas.map((f) => (f.type === 'text_delta' ? f.delta : '')).join('');
      console.log(
        `    [measure] ${resolvedAt - started}ms；text_delta=${deltas.length} 帧/${text.length} 字；error=${errors.length}；settled@${settledAt === null ? '-' : String((settledAt as number) - resolvedAt)}ms`,
      );
      if (text) console.log(`    [measure] 真实文本前 120 字：${JSON.stringify(text.slice(0, 120))}`);

      // --- 不变量（与模型是否可用无关）---
      assert.equal(frames.filter((f) => f.type === 'settled').length, 1, '一轮恰好一个 settled');
      assertNoSystemPromptLeak(frames, '真实流式一轮');
      const roles = frames
        .filter((f) => f.type === 'message_end')
        .map((f) => String((f.message as { role?: unknown } | null)?.role ?? '?'));
      assert.ok(roles.every((r) => r === 'user' || r === 'assistant'), `message_end 角色：${roles.join(',')}`);

      // --- 有文本时：必须是**流式**（多帧），不是一次性出完 ---
      if (text.length > 0) {
        assert.ok(deltas.length > 1, `有文本时必须逐字流式（实际只有 ${deltas.length} 帧）`);
        assert.ok(text.length > 10, '真实回答不该只有几个字');
        console.log('    [measure] ✅ 已用真实模型验证：逐字流式 + 结束信号 + 无提示词泄漏');
      } else {
        // 模型侧不可用时（额度/订阅）必须给出**一条**可读错误，而不是空回复
        assert.equal(errors.length, 1, `模型没出文本时必须恰好一条 error，实际 ${errors.length}`);
        const err = errors[0]!;
        assert.ok(String(err.type === 'error' ? err.hint : '').startsWith(HINT_SDK_OK));
        console.log('    [measure] ⚠️ 本轮模型侧不可用，但已如实报 E_LLM（这条路径同样被验证）');
      }
    } finally {
      manager.closeAll();
      rmSync(agentDir, { recursive: true, force: true });
    }
  },
);
