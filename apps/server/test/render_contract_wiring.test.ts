/**
 * ★★ 渲染契约**真的生效**的守卫（坑 24：提示词"存在"≠"生效"）。
 *
 * ## 缺口（pi-bridge grep 发现 + 我核实）
 * `agent/prompts.ts` 导出了 `CHAT_ASSISTANT_SYSTEM_PROMPT`（含 `RENDER_CONTRACT`），
 * 但 **chat/视频会话从未传过 `systemPrompt`** → 模型跑 pi 默认的 coding 提示词 →
 * 前端做的 KaTeX / 代码高亮 / 导图渲染**没有内容可渲**。
 *
 * ## 判据（Lead 指定，**不是"我们传了参数"**）
 * 1. ★ **断言真正发给 SDK 的 `systemPrompt` 含契约关键词** —— 用 `sdkLoader` 注入假 SDK，
 *    捕获 `createAgentSession(options)` 的**真实 options**（零额度、不走网络）
 * 2. `auditRenderFormat` 对**故意违规**的文本必须报错（自证判据有效）
 * 3. `withRenderContract` **幂等**（重复追加不会写两遍）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHAT_ASSISTANT_SYSTEM_PROMPT,
  RENDER_CONTRACT,
  VIDEO_ASSISTANT_SYSTEM_PROMPT,
  auditRenderFormat,
  withRenderContract,
} from '../src/agent/prompts.ts';
import { AgentSessionManager } from '../src/agent/session.ts';
import { validateAssistant } from '../src/routes/chat.ts';

/** 契约关键词（提示词里必须出现；改了提示词这些断言会提醒你"契约变了"） */
const CONTRACT_MARKERS = ['输出格式契约', '$...$'];

test('★ 提示词本身含渲染契约（chat 与 video 两个入口都要）', () => {
  for (const [name, p] of [
    ['CHAT', CHAT_ASSISTANT_SYSTEM_PROMPT],
    ['VIDEO', VIDEO_ASSISTANT_SYSTEM_PROMPT],
  ] as const) {
    for (const marker of CONTRACT_MARKERS) {
      assert.ok(p.includes(marker), `★ ${name} 提示词必须含契约关键词「${marker}」`);
    }
  }
  // ★ 契约必须**明确禁止** `\(...\)`（前端 KaTeX 只认 `$...$`）—— 禁止项是契约的核心
  assert.ok(RENDER_CONTRACT.includes('\\(...\\)'), '契约必须点名禁止 LaTeX 圆括号写法');
});

test('★ 幂等：withRenderContract 重复调用不会把契约追加两遍', () => {
  const once = withRenderContract('基础提示词');
  const twice = withRenderContract(once);
  assert.equal(twice, once, '★ 幂等（否则提示词会随重启/多次包装膨胀）');
  assert.equal(once.split('输出格式契约（前端渲染要求').length - 1, 1, '契约只能出现一次');
});

test('★★ 真正发给 SDK 的 systemPrompt 含契约关键词（假 SDK 捕获真实 options，零额度）', async () => {
  const seen: Record<string, unknown>[] = [];
  /**
   * ★ 判据打在**正确的那一层**：`systemPrompt` 不是直接进 `createAgentSession` 的 options，
   * 而是经 **`DefaultResourceLoader`** 交给 pi（`session.ts:1163`）——
   * 所以"真的生效"要看**加载器收到的 options**。第一版我只查 `createAgentSession` 的 options，
   * 拿到空值 → 差点误判成"接线失败"（实际是我看错了层）。
   */
  const loaderSeen: Record<string, unknown>[] = [];
  class FakeResourceLoader {
    constructor(opts: Record<string, unknown>) {
      loaderSeen.push(opts);
    }
    async reload() {
      return undefined;
    }
  }
  const fakeSdk = {
    available: true as const,
    // session.ts 在持久化路径上会 `SessionManagerCtor.create(...)` / `.inMemory(...)`
    SessionManager: {
      create: () => ({ getSessionId: () => 'probe', getSessionFile: () => null }),
      inMemory: () => ({ getSessionId: () => 'probe', getSessionFile: () => null }),
    },
    DefaultResourceLoader: FakeResourceLoader,
    getAgentDir: () => '/tmp/fake-agent-dir',
    createAgentSession: async (options: Record<string, unknown>) => {
      seen.push(options);
      return { session: { sessionManager: {} } };
    },
  };
  const manager = new AgentSessionManager({
    systemPrompt: CHAT_ASSISTANT_SYSTEM_PROMPT,
    // ★ 注入假 SDK：捕获**真实传给 SDK 的 options**，完全不联网/不花额度
    sdkLoader: async () => fakeSdk as never,
  });
  await manager.createInit('prompt-probe-1');

  assert.ok(seen.length >= 1, '必须真的调用过 createAgentSession');
  assert.ok(loaderSeen.length >= 1, '★ 必须真的把系统提示词交给 DefaultResourceLoader（否则提示词没生效）');
  const sent = String(loaderSeen[0]?.systemPrompt ?? '');
  assert.ok(sent.length > 0, '★ systemPrompt 必须真的出现在交给 SDK 加载器的 options 里（不是"我们传了参数"）');
  for (const marker of CONTRACT_MARKERS) {
    assert.ok(sent.includes(marker), `★ 交给 SDK 的 systemPrompt 必须含「${marker}」`);
  }
  assert.equal(sent, CHAT_ASSISTANT_SYSTEM_PROMPT, '必须**逐字**是那个提示词（不是被截断/改写的版本）');
  assert.equal(loaderSeen[0]?.noContextFiles, undefined, 'chat 未开 noContextFiles（那是 ask 的语义）');
});

test('★ 助手入口校验：?assistant=video 合法；未知值 → 明确报错（不静默降级）', () => {
  assert.deepEqual(validateAssistant(undefined), { ok: true, assistant: 'chat' }, '缺省 = chat');
  assert.deepEqual(validateAssistant('chat'), { ok: true, assistant: 'chat' });
  assert.deepEqual(validateAssistant('video'), { ok: true, assistant: 'video' }, '视频助手入口必须被接受');
  for (const bad of ['VIDEO', 'vide0', 'agent', 42, {}]) {
    const r = validateAssistant(bad);
    assert.equal(r.ok, false, `★ 非法 assistant=${JSON.stringify(bad)} 必须被拒（否则会静默用错提示词）`);
  }
});

test('★ 自证判据有效：auditRenderFormat 对**故意违规**的文本必须报错', () => {  // ① 用了 LaTeX 圆括号（前端 KaTeX 不认）→ 必须报违规
  const bad = auditRenderFormat('公式：\\(a^2+b^2=c^2\\) 就这样。');
  assert.equal(bad.ok, false, '★ `\\(...\\)` 必须被判违规（否则契约形同虚设）');
  assert.ok(bad.violations.length > 0, '必须给出违规项');
  assert.ok(bad.observed.latexParen > 0, '实况里要能数出 LaTeX 圆括号');

  // ② 代码块没闭合 → 违规
  const unclosed = auditRenderFormat('```sql\nSELECT 1;');
  assert.equal(unclosed.ok, false, '★ 未闭合代码块必须被判违规');
  assert.equal(unclosed.observed.unclosedFence, true);

  // ③ 代码块没标语言 → 违规
  const noLang = auditRenderFormat('```\nSELECT 1;\n```');
  assert.equal(noLang.ok, false, '★ 代码块缺语言必须被判违规');

  // ④ 合规样例 → 必须 ok（判据不能"一律报错"）
  const good = auditRenderFormat('公式 $a^2+b^2=c^2$ 如下：\n\n```sql\nSELECT 1;\n```\n\n引用 [[card:crd_1]]');
  assert.equal(good.ok, true, `合规输出必须 ok，实际违规：${JSON.stringify(good.violations)}`);
  assert.ok(good.observed.inlineMath > 0, '应数出 `$...$` 行内公式');
  assert.ok(good.observed.citations.length > 0, '应识别出 `[[card:…]]` 引用');
});
