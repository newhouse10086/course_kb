/**
 * ★ 会话 resume 测试（RETRIEVAL.md §5 / lead 点名的 `resume = 0` 缺口）。
 *
 * 需求原文：
 *  1. 会话落盘（pi 原生 session 格式）
 *  2. `getOrCreate` **先尝试从磁盘恢复**：有 → 恢复历史；无 → 新建
 *  3. **可观测**：`ready` 帧带 `resumed: true/false` + `restoredMessages: N`
 *  4. **失败要如实降级**：`resumed:false` + `reason`，不许静默当新会话
 *  5. 空闲 `dispose` **不能删会话文件**
 *  6. 测试：发消息 → 释放 → 重新 getOrCreate → 断言历史恢复 + `resumed:true`；
 *     文件损坏 → `resumed:false` + reason 且**不抛**
 *
 * 这里用**真 SDK**（不需要模型出文本的部分）+ 一次真实 prompt 轮（有凭据时）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentSessionManager, findSessionFile } from '../../src/agent/session.ts';

const COURSE_KB_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

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

const projectEnv = readEnvFile(join(COURSE_KB_ROOT, '.env'));
const hasProjectLlm = Boolean(projectEnv.AMR_BASE && projectEnv.AMR_KEY && projectEnv.LLM_MODEL);

/** 用本项目 .env 的凭据造一个临时 agentDir（测完删掉，含明文 key 的临时文件） */
function makeCredsAgentDir(): string {
  const agentDir = mkdtempSync(join(tmpdir(), 'agent-resume-creds-'));
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
  return agentDir;
}

// ===========================================================================
// 1. findSessionFile（发现历史文件的机制）
// ===========================================================================

test('★ findSessionFile：按 `<时间戳>_<key>.jsonl` 找最新的一份；没有则 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sess-dir-'));
  try {
    assert.equal(findSessionFile(dir, 'k1'), null, '空目录 → null');
    writeFileSync(join(dir, '2026-01-01T00-00-00-000Z_k1.jsonl'), 'x', 'utf8');
    writeFileSync(join(dir, '2026-02-02T00-00-00-000Z_k1.jsonl'), 'y', 'utf8');
    writeFileSync(join(dir, '2026-03-03T00-00-00-000Z_other.jsonl'), 'z', 'utf8');
    const found = findSessionFile(dir, 'k1');
    assert.ok(found?.endsWith('2026-02-02T00-00-00-000Z_k1.jsonl'), `应取最新一份，实际 ${String(found)}`);
    assert.ok(!String(found).includes('other'), '不能拿别人的会话文件');
    assert.equal(findSessionFile(dir, 'k9'), null);
    assert.equal(findSessionFile(join(dir, '不存在'), 'k1'), null, '目录不存在 → null（不抛）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 2. ★ 损坏文件 → 如实降级（不抛、不静默当新会话）
// ===========================================================================

test('★ 会话文件损坏 → resumed:false + 可读 reason，且**不抛**', async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'sess-corrupt-'));
  const key = 'corrupt-1';
  try {
    // 造一个"存在但内容不是合法 JSONL"的文件（模拟写一半被杀/磁盘损坏）
    writeFileSync(join(sessionDir, `2026-01-01T00-00-00-000Z_${key}.jsonl`), '{"type":"message"  ← 截断的坏文件\nnot json at all\n', 'utf8');

    const manager = new AgentSessionManager({ sessionDir, tools: [] });
    let session;
    await assert.doesNotReject(async () => {
      // ★ 归属登记（跨用户读取防护）要求：**有历史文件但未登记**的会话默认拒开。
      //   本用例测的是"损坏文件的降级"，所以要显式走**迁移/认领**路径（真实运维场景）。
      session = await manager.getOrCreate(key, { userId: 'u_resume_test', allowUnclaimed: true });
    });
    const ready = session!.readyFrame();
    assert.equal(ready.resumed, false, '★ 读不了就必须报 false，不许假装恢复成功');
    assert.ok((ready.resumeReason ?? '').length > 0, '必须给出原因');
    assert.match(String(ready.resumeReason), /损坏|读取失败|读不到|截断/);
    assert.equal(ready.restoredMessages, 0);
    manager.closeAll();
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('★ 未启用持久化时 resumeReason 明确说明（不是"损坏"）', async () => {
  const manager = new AgentSessionManager({ sessionDir: null, tools: [] });
  const session = await manager.getOrCreate('ephemeral-1');
  const ready = session.readyFrame();
  assert.equal(ready.persistence, 'ephemeral');
  assert.equal(ready.resumed, false);
  assert.match(String(ready.resumeReason), /未启用持久化/);
  manager.closeAll();
});

// ===========================================================================
// 3. ★★ 真实验证：发消息 → 释放 → 重新 getOrCreate → 历史恢复 + resumed:true
// ===========================================================================

test(
  '★★ 真实验证：prompt → 释放（进程内 dispose）→ 新 manager 恢复 → resumed:true + 历史条数 > 0',
  { skip: hasProjectLlm ? false : 'SKIP: course-kb/.env 缺 AMR_BASE/AMR_KEY/LLM_MODEL' },
  async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'sess-resume-'));
    const agentDir = makeCredsAgentDir();
    const key = 'resume-real-1';
    try {
      // ---- 第一次：全新会话，跑一轮（让 pi 真的把 session 写盘）----
      const manager1 = new AgentSessionManager({ sessionDir, agentDir, tools: [] });
      // ★ 归属登记（跨用户读取防护）：真实路径由路由传 req.user.id —— 这里模拟同一用户重连
      const session1 = await manager1.getOrCreate(key, { userId: 'u_resume_test' });
      const ready1 = session1.readyFrame();
      assert.equal(ready1.persistence, 'native');
      assert.equal(ready1.resumed, false, '首次应当是新建');
      assert.match(String(ready1.resumeReason), /首次/);

      await session1.prompt('用一句话说明什么是主键。');
      const file = session1.currentSessionFile();
      assert.ok(file && existsSync(file), `prompt 之后会话文件必须落盘：${String(file)}`);
      const fileBefore = file as string;
      const sizeBefore = readFileSync(fileBefore, 'utf8').length;
      assert.ok(sizeBefore > 0);

      // ---- 释放（模拟空闲回收 / 进程退出前的 dispose）----
      manager1.close(key);
      assert.equal(existsSync(fileBefore), true, '★ 需求 5：dispose **不能**删会话文件');

      // ---- 第二次：**新的 manager 实例**（等价于进程重启）从磁盘恢复 ----
      const manager2 = new AgentSessionManager({ sessionDir, agentDir, tools: [] });
      const session2 = await manager2.getOrCreate(key, { userId: 'u_resume_test' });
      const ready2 = session2.readyFrame();

      assert.equal(ready2.resumed, true, '★ 必须从磁盘恢复了历史');
      assert.ok((ready2.restoredMessages ?? 0) > 0, `恢复出的消息条数应 > 0，实际 ${String(ready2.restoredMessages)}`);
      assert.equal(ready2.session_file, fileBefore, '必须恢复到**同一份**会话文件');
      assert.equal(session2.currentSessionFile(), fileBefore);

      // 恢复后的会话可以继续用（不是只读快照）
      await session2.prompt('再补一句：主键不能为 NULL 吗？');
      assert.ok(readFileSync(fileBefore, 'utf8').length > sizeBefore, '续聊应当继续追加到同一文件');

      manager2.closeAll();
      console.log(
        `    [measure] resume 验证：resumed=${String(ready2.resumed)} restoredMessages=${String(ready2.restoredMessages)} file=${fileBefore.split(/[\\/]/).pop()}`,
      );
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  },
);

test(
  '★ 恢复后再释放，文件仍在（可反复恢复，不会"用一次就丢"）',
  { skip: hasProjectLlm ? false : 'SKIP: course-kb/.env 缺 AMR_BASE/AMR_KEY/LLM_MODEL' },
  async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'sess-resume2-'));
    const agentDir = makeCredsAgentDir();
    const key = 'resume-real-2';
    try {
      const m1 = new AgentSessionManager({ sessionDir, agentDir, tools: [] });
      const s1 = await m1.getOrCreate(key, { userId: 'u_resume_test' });
      await s1.prompt('只回复 ok。');
      const file = s1.currentSessionFile() as string;
      m1.close(key);

      // 恢复两次，每次都应当仍然是 resumed:true 且文件还在
      for (const round of [1, 2]) {
        const m = new AgentSessionManager({ sessionDir, agentDir, tools: [] });
        const s = await m.getOrCreate(key, { userId: 'u_resume_test' });
        assert.equal(s.readyFrame().resumed, true, `第 ${round} 次恢复应当是 resumed:true`);
        m.close(key);
        assert.equal(existsSync(file), true, `第 ${round} 次释放后文件必须还在`);
      }
      assert.equal(readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl')).length, 1, '同一个 key 只应有一份会话文件');
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  },
);

test('★ 不同 key 的历史互不串台（A 不会恢复成 B 的上下文）', async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'sess-keys-'));
  try {
    // 只给 B 造假文件（内容可读性无所谓：只要 A 不去读它）
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, '2026-01-01T00-00-00-000Z_ask-b.jsonl'), 'garbage\n', 'utf8');

    const manager = new AgentSessionManager({ sessionDir, tools: [] });
    const sessionA = await manager.getOrCreate('ask-a');
    const readyA = sessionA.readyFrame();
    assert.equal(readyA.resumed, false, 'A 没有历史，不该被 B 的文件恢复');
    assert.match(String(readyA.resumeReason), /首次/);
    assert.ok(!String(readyA.session_file).includes('ask-b'));
    manager.closeAll();
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});
