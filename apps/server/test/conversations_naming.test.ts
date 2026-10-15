/**
 * ★★ **会话命名后端**（契约 `docs/SESSION_NAMING.md`）—— 重命名 + AI 生成名字。
 *
 * ## 核心设计：`title_source`（`'default' | 'ai' | 'user'`）
 * ```
 * ★ 铁律: title_source === 'user' → **AI 永远不许覆盖**
 * ★ **不许**用 `title === '新问答'` 当判据（坑 21：用内容当状态不可靠 ——
 *   用户可以把会话命名成"新问答"，之后 AI 会以为"还是默认值"而覆盖它）
 * ```
 *
 * ## 判据（契约 §6 必验项，全部断言**具体值**）
 * ```
 * ✔ 重命名 → 200 + `title_source='user'` · 空白/超长 → **400（不静默截断）** · 幂等
 * ✔ ★★ 用户改过名后 AI **不再覆盖**（409 E_TITLE_USER_SET，**不静默**）
 * ✔ ★ 别人的会话 → **404**（不泄露存在性，与 reparse 同策略）
 * ✔ ★ 清洗：`"聚簇索引的区别"。` → `聚簇索引的区别`；空/超长/多行 → 保留原名 或 如实截断
 * ✔ ★ 失败 → 保留原名（不假装成功）
 * ✔ ★ 迁移 v7：**已迁移的库**也有新列
 * ✔ ★★ **同源**：命名读到的"首条用户提问" **逐字等于** `history` 里的那条；
 *    且**跳过**非用户消息（坑 28：别假设"第一条就是用户提问"）
 * ★ 全零 LLM：`providers` 用替身（记录**真实请求体**，不是"我们传了参数"）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';

import { buildApp } from '../src/index.ts';
import type { BuiltApp } from '../src/index.ts';
import { loadConfig } from '../src/config.ts';
import { entriesToHistory } from '../src/agent/history.ts';
import {
  cleanGeneratedTitle,
  pickNamingInput,
  TITLE_GEN_MAX_TOKENS,
  TITLE_MAX_CHARS,
} from '../src/routes/conversation-title.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
let tmp = '';
let built: BuiltApp | null = null;
let base = '';
let adminCookie = '';
let bobCookie = '';
let adminId = '';
let bobId = '';

/** 替身 LLM：记录**真实请求体**（含 messages/maxTokens），按脚本返回。 */
interface LlmCall {
  messages: { role: string; content: string }[];
  maxTokens?: number;
  schema?: { name?: string };
}
let llmCalls: LlmCall[] = [];
let llmScript: (() => unknown) | null = null;

function setLlm(fn: () => unknown): void {
  llmCalls = [];
  llmScript = fn;
}

async function http(
  method: string,
  url: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      // ⚠️ 只有**真的带 body** 时才设 content-type：否则 Fastify 报
      //    `Body cannot be empty when content-type is set to 'application/json'`
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'naming-'));
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DB: path.join(tmp, 't.sqlite3'),
      COURSE_KB_DATA_DIR: path.join(tmp, 'data'),
      COURSE_KB_SETTINGS_FILE: path.join(tmp, 'settings.json'),
      COURSE_KB_BOOTSTRAP_ADMIN: 'admin:naming-pass-1',
    } as Record<string, string>,
  });
  built = await buildApp({ cfg });
  const rbac = built.deps.repo.rbac;
  adminId = rbac.getUserRowByName('admin')!.id;
  const { hashPassword } = await import('../src/auth/password.ts');
  bobId = rbac.createUser({
    username: 'bob',
    displayName: 'Bob',
    passwordHash: await hashPassword('bob-pass-0001'),
    roles: ['student'],
  });

  // ★ 用**自己的对象**替换 providers（不补丁 facade：settings 热重载会重建它 → 偶发真调用）
  built.deps.providers = {
    capabilities: async () => ({}),
    completeJson: async (req: LlmCall) => {
      llmCalls.push(req);
      if (!llmScript) throw new Error('测试未设置 LLM 脚本');
      const data = llmScript();
      if (data instanceof Error) throw data;
      return { data: data as Record<string, unknown>, usedProvider: 'spy' };
    },
  } as never;

  // ★ 同源历史：注入 `sessionHistory`（生产是 `AgentSessionManager.get(id).history()`，
  //   内部同样是 `entriesToHistory`）—— 测试里直接喂 **pi 条目**，与 UI 走同一映射函数。
  const entries: Record<string, unknown> = {};
  built.deps.sessionHistory = (sessionId: string) => {
    const e = entries[sessionId];
    return e ? (entriesToHistory(e as unknown[]) as never) : null;
  };
  seedHistory = (sessionId, list) => {
    entries[sessionId] = list;
  };

  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('取不到端口');
  base = `http://127.0.0.1:${addr.port}`;
  const a = await http('POST', '/api/v1/auth/login', { body: { username: 'admin', password: 'naming-pass-1' } });
  adminCookie = ((a.json as { raw?: string }).raw ?? '') as string;
  const loginRes = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'naming-pass-1' }),
  });
  adminCookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.ok(adminCookie, `admin 必须能登录（HTTP ${loginRes.status}）`);
  const loginBob = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: 'bob-pass-0001' }),
  });
  bobCookie = (loginBob.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.ok(bobCookie, `bob 必须能登录（HTTP ${loginBob.status}）`);
});

let seedHistory: (sessionId: string, list: Record<string, unknown>[]) => void = () => {};

after(async () => {
  try {
    if (built) await built.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows 偶发占用 */
  }
});

/** 建一个属于 admin 的会话 */
async function newConversation(title?: string): Promise<string> {
  const r = await http('POST', '/api/v1/conversations', {
    cookie: adminCookie,
    body: title !== undefined ? { title } : {},
  });
  assert.equal(r.status, 201, `建会话应 201（实际 ${r.status} ${JSON.stringify(r.json)}）`);
  const conv = (r.json as { conversation?: { id?: string } }).conversation;
  assert.ok(conv?.id, '必须返回会话 id');
  return conv.id;
}

// ═══════════════════════════════════════════════════════════════════════
// 纯函数：清洗（模型一定会加引号/解释）
// ═══════════════════════════════════════════════════════════════════════
test('★ 清洗：`"聚簇索引的区别"。` → `聚簇索引的区别`（去引号 + 去结尾标点）', () => {
  const r = cleanGeneratedTitle('"聚簇索引的区别"。');
  assert.equal(r.title, '聚簇索引的区别');
  assert.equal(r.warnings.length, 0, '正常输出不该有警告');
});

test('★ 清洗：多行只取**第一行**；`标题：xxx` 前缀去掉；英文不留半个词', () => {
  assert.equal(cleanGeneratedTitle('聚簇索引\n\n补充说明：……').title, '聚簇索引');
  assert.equal(cleanGeneratedTitle('标题：二级索引与回表').title, '二级索引与回表');
  const long = 'How clustered indexes differ from secondary indexes in InnoDB';
  const cut = cleanGeneratedTitle(long);
  assert.ok(cut.title.length <= 40, `纯 ASCII 上限 40（实际 ${cut.title.length}）`);
  assert.equal(cut.title, 'How clustered indexes differ from', '★ 在词边界截断，不留半个词');
  assert.equal(cut.warnings[0]?.code, 'W_TITLE_TRUNCATED');
});

test('★ 清洗：**空 → 返回空 + 如实警告**（调用方保留原名，不写空名字）', () => {
  const r = cleanGeneratedTitle('   \n  \n');
  assert.equal(r.title, '', '★ 清洗后为空必须返回空（**不许编一个名字**）');
  assert.equal(r.warnings[0]?.code, 'W_TITLE_EMPTY');
});

test('★ 清洗：中文超 20 字 → **如实截断** + W_TITLE_TRUNCATED（不静默）', () => {
  const r = cleanGeneratedTitle('聚簇索引与二级索引在InnoDB中的区别以及回表代价的详细说明');
  assert.equal(Array.from(r.title).length, 20, '★ 中文上限 20 字');
  assert.equal(r.warnings[0]?.code, 'W_TITLE_TRUNCATED');
});

test('★ 输入选取：**跳过非用户消息**找第一条用户提问（坑 28），助手回答取其后第一条', () => {
  const picked = pickNamingInput([
    { role: 'system', text: '你是助教' },
    { role: 'assistant', text: '（开场白）' },
    { role: 'user', text: '什么是聚簇索引？' },
    { role: 'assistant', text: '聚簇索引决定物理存储顺序。' },
    { role: 'user', text: '那二级索引呢？' },
  ]);
  assert.deepEqual(picked, {
    firstUser: '什么是聚簇索引？',
    firstAssistant: '聚簇索引决定物理存储顺序。',
  });
  assert.equal(pickNamingInput([{ role: 'assistant', text: 'hi' }]), null, '★ 没有用户消息 → null（调用方 400）');
});

// ═══════════════════════════════════════════════════════════════════════
// PATCH 重命名
// ═══════════════════════════════════════════════════════════════════════
test('★ 重命名 → 200 + `title_source="user"`；重复设置同一名字**幂等**', async () => {
  const id = await newConversation();
  const r1 = await http('PATCH', `/api/v1/conversations/${id}`, {
    cookie: adminCookie,
    body: { title: '  聚簇索引与二级索引的区别  ' },
  });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  const c1 = (r1.json as { conversation?: { title?: string; title_source?: string } }).conversation;
  assert.equal(c1?.title, '聚簇索引与二级索引的区别', '★ 必须 trim 后存');
  assert.equal(c1?.title_source, 'user', '★ 设定后 title_source 必须是 user');

  const r2 = await http('PATCH', `/api/v1/conversations/${id}`, {
    cookie: adminCookie,
    body: { title: '聚簇索引与二级索引的区别' },
  });
  assert.equal(r2.status, 200, '★ 幂等：重复设同一 title → 200');
});

test('★ 空白名 / 超长名 → **400**（**不静默截断**，原名不变）', async () => {
  const id = await newConversation('原名保留');
  const blank = await http('PATCH', `/api/v1/conversations/${id}`, { cookie: adminCookie, body: { title: '   ' } });
  assert.equal(blank.status, 400, '全空白 → 400');
  assert.equal(
    ((blank.json as { error?: { code?: string } }).error?.code),
    'E_BADREQUEST',
  );
  const tooLong = await http('PATCH', `/api/v1/conversations/${id}`, {
    cookie: adminCookie,
    body: { title: '长'.repeat(TITLE_MAX_CHARS + 1) },
  });
  assert.equal(tooLong.status, 400, '超长 → 400');
  const after = await http('GET', `/api/v1/conversations/${id}`, { cookie: adminCookie });
  const c = (after.json as { conversation?: { title?: string; title_source?: string } }).conversation;
  assert.equal(c?.title, '原名保留', '★ 400 时原名必须**不变**（不静默截断）');
  assert.equal(c?.title_source, 'default', '★ 400 不许改 title_source');
});

test('★ IDOR：**别人的会话 → 404**（不泄露存在性；不是 403）', async () => {
  const id = await newConversation();
  const r = await http('PATCH', `/api/v1/conversations/${id}`, { cookie: bobCookie, body: { title: '我要改别人的' } });
  assert.equal(r.status, 404, `★ 别人的会话必须 404（实际 ${r.status}）`);
  assert.equal((r.json as { error?: { code?: string } }).error?.code, 'E_NOTFOUND');
  // 不存在的 id 也是同一形状（★ 判据：**不泄露存在性** ——
  // 唯一允许的差异是**回显客户端自己给的 id**，那不是秘密；msg 里不许出现
  // "属于别人/无权限" 这类**能区分"存在但不是你的"**的说法）
  const ghost = await http('PATCH', '/api/v1/conversations/cnv_ghost', { cookie: bobCookie, body: { title: 'x' } });
  assert.equal(ghost.status, 404);
  assert.equal((ghost.json as { error?: { code?: string } }).error?.code, 'E_NOTFOUND');
  const norm = (o: Record<string, unknown>, id: string): string =>
    JSON.stringify(o).split(id).join('<id>');
  assert.equal(
    norm(ghost.json, 'cnv_ghost'),
    norm(r.json, id),
    '★ "别人的"与"不存在的"响应必须**逐字一致**（除回显的 id）',
  );
  const msg = String((r.json as { error?: { msg?: string } }).error?.msg ?? '');
  assert.ok(
    !/属于|别人|无权限|不是你的|forbidden/i.test(msg),
    `★ msg 不许暗示"存在但不是你的"（实际：${msg}）`,
  );
});

// ═══════════════════════════════════════════════════════════════════════
// POST title/generate
// ═══════════════════════════════════════════════════════════════════════
test('★★ 用户手动命名后：generate → **409 E_TITLE_USER_SET**（不静默跳过）', async () => {
  const id = await newConversation();
  await http('PATCH', `/api/v1/conversations/${id}`, { cookie: adminCookie, body: { title: '我自己起的名字' } });
  setLlm(() => ({ title: 'AI 想覆盖的名字' }));
  const r = await http('POST', `/api/v1/conversations/${id}/title/generate`, { cookie: adminCookie });
  assert.equal(r.status, 409, `★ 必须是 409（实际 ${r.status} ${JSON.stringify(r.json)}）`);
  const err = (r.json as { error?: { code?: string; msg?: string } }).error;
  assert.equal(err?.code, 'E_TITLE_USER_SET');
  assert.match(String(err?.msg), /手动设定|未被 AI 覆盖/, '★ msg 要说清"未被 AI 覆盖"');
  assert.equal(llmCalls.length, 0, '★ 409 时**根本不该调 LLM**（别浪费额度）');
  const after = await http('GET', `/api/v1/conversations/${id}`, { cookie: adminCookie });
  assert.equal(
    ((after.json as { conversation?: { title?: string; title_source?: string } }).conversation)?.title,
    '我自己起的名字',
    '★ 名字必须没被覆盖',
  );
});

test('★ 无消息 → **400**（不编名字）', async () => {
  const id = await newConversation();
  setLlm(() => ({ title: '编一个' }));
  const r = await http('POST', `/api/v1/conversations/${id}/title/generate`, { cookie: adminCookie });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.equal(llmCalls.length, 0, '★ 无消息时不该调 LLM');
});

test('★★ 生成成功：清洗后写库 + `title_source="ai"` + **max_tokens=32**', async () => {
  const id = await newConversation();
  seedHistory(id, [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '聚簇索引和二级索引有什么区别？' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '聚簇索引叶子节点存整行数据……' }] } },
  ]);
  setLlm(() => ({ title: '"聚簇索引的区别"。' }));
  const r = await http('POST', `/api/v1/conversations/${id}/title/generate`, { cookie: adminCookie });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const out = r.json as { conversation?: { title?: string; title_source?: string }; generated?: boolean };
  assert.equal(out.generated, true);
  assert.equal(out.conversation?.title, '聚簇索引的区别', '★ 引号与句号必须被清掉');
  assert.equal(out.conversation?.title_source, 'ai');
  assert.equal(llmCalls.length, 1);
  assert.equal(llmCalls[0]?.maxTokens, TITLE_GEN_MAX_TOKENS, '★ max_tokens 必须小（32）——命名成本极低');
});

test('★★ 同源：命名读到的首条用户提问**逐字等于** `history` 里那条（且跳过非用户消息）', async () => {
  const id = await newConversation();
  const entries = [
    { type: 'message', message: { role: 'system', content: '你是助教' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '（开场白，不是回答）' }] } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '什么是回表？为什么二级索引要回表？' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '因为二级索引叶子只存主键值。' }] } },
  ];
  seedHistory(id, entries);
  // ★ 与 UI 走**同一个**映射函数（`entriesToHistory`）→ 逐字比对
  const uiHistory = entriesToHistory(entries as unknown[]);
  const uiFirstUser = uiHistory.messages.find((m) => m.role === 'user')!.text;

  setLlm(() => ({ title: '回表的原因' }));
  const r = await http('POST', `/api/v1/conversations/${id}/title/generate`, { cookie: adminCookie });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const prompt = llmCalls[0]!.messages.map((m) => m.content).join('\n');
  assert.ok(
    prompt.includes(uiFirstUser),
    `★ 命名输入必须与 UI 同源（逐字包含）：期望含 ${JSON.stringify(uiFirstUser)}；实际 prompt=${prompt.slice(0, 300)}`,
  );
  assert.ok(!prompt.includes('你是助教'), '★ system 消息不许进命名输入');
  assert.ok(prompt.includes('因为二级索引叶子只存主键值。'), '助手回答必须取该提问**之后**那条');
});

test('★ 模型返回空 → **保留原名** + `generated:false` + 如实警告（不写空名字）', async () => {
  const id = await newConversation('原来的名字');
  seedHistory(id, [{ type: 'message', message: { role: 'user', content: '你好' } }]);
  setLlm(() => ({ title: '   \n  ' }));
  const r = await http('POST', `/api/v1/conversations/${id}/title/generate`, { cookie: adminCookie });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const out = r.json as {
    conversation?: { title?: string; title_source?: string };
    generated?: boolean;
    warnings?: { code?: string }[];
  };
  assert.equal(out.generated, false, '★ 不许假装成功');
  assert.equal(out.conversation?.title, '原来的名字', '★ 保留原名');
  assert.equal(out.conversation?.title_source, 'default', '★ 没写成 ai（因为没生成出名字）');
  assert.equal(out.warnings?.[0]?.code, 'W_TITLE_EMPTY', '★ 必须如实记警告');
});

test('★ 生成失败（上游报错）→ **保留原名** + 如实警告（不阻塞、不假装成功）', async () => {
  const id = await newConversation('失败也要留住的名字');
  seedHistory(id, [{ type: 'message', message: { role: 'user', content: '你好' } }]);
  setLlm(() => new Error('HTTP 400: This response_format type is unavailable now'));
  const r = await http('POST', `/api/v1/conversations/${id}/title/generate`, { cookie: adminCookie });
  assert.equal(r.status, 200, `★ 命名失败**不该**让请求失败（聊天是主路径）—— 实际 ${r.status}`);
  const out = r.json as { generated?: boolean; warnings?: { code?: string; msg?: string }[]; conversation?: { title?: string } };
  assert.equal(out.generated, false);
  assert.equal(out.conversation?.title, '失败也要留住的名字');
  assert.equal(out.warnings?.[0]?.code, 'W_TITLE_GEN_FAILED');
  assert.match(String(out.warnings?.[0]?.msg), /unavailable now/, '★ 必须带**原始 reason**（不许笼统）');
});

test('★ IDOR：别人的会话 generate → **404**（且不调 LLM）', async () => {
  const id = await newConversation();
  seedHistory(id, [{ type: 'message', message: { role: 'user', content: 'hi' } }]);
  setLlm(() => ({ title: 'x' }));
  const r = await http('POST', `/api/v1/conversations/${id}/title/generate`, { cookie: bobCookie });
  assert.equal(r.status, 404);
  assert.equal(llmCalls.length, 0, '★ 越权请求不许触发 LLM 调用');
});

test('★ 列表/详情都带 `title_source`（前端据此决定能否"重新生成"）', async () => {
  const id = await newConversation();
  await http('PATCH', `/api/v1/conversations/${id}`, { cookie: adminCookie, body: { title: '列表要看到来源' } });
  const list = await http('GET', '/api/v1/conversations', { cookie: adminCookie });
  const convs = (list.json as { conversations?: { id: string; title_source?: string }[] }).conversations ?? [];
  const mine = convs.find((c) => c.id === id);
  assert.equal(mine?.title_source, 'user', '★ 列表必须带 title_source');
  const one = await http('GET', `/api/v1/conversations/${id}`, { cookie: adminCookie });
  assert.equal(
    ((one.json as { conversation?: { title_source?: string } }).conversation)?.title_source,
    'user',
    '★ 详情必须带 title_source',
  );
});

// ═══════════════════════════════════════════════════════════════════════
// ★★ 铁律的**最内层**守卫：SQL 层的原子条件（防 TOCTOU）
// ═══════════════════════════════════════════════════════════════════════
test('★★ 仓库层：`title_source="user"` 时 `setConversationTitleAi` **不写入**（SQL 原子守卫，防 TOCTOU）', async () => {
  const id = await newConversation();
  const rbac = built!.deps.repo.rbac;
  const set = rbac.setConversationTitle(adminId, id, '用户亲手起的名字');
  assert.equal(set?.title_source, 'user');

  // ★ 直接调仓库（绕过路由的 409 前置检查）—— 模拟"AI 与用户改名**同一瞬间**"的竞态：
  //   路由先查 source 再写 会有 TOCTOU 窗口；守卫写在 SQL 的 WHERE 里才是原子的。
  const out = rbac.setConversationTitleAi(adminId, id, 'AI 偷偷覆盖的名字');
  assert.equal(out.applied, false, '★ 守卫必须拒绝写入（applied=false）');
  const after = rbac.getConversation(adminId, id);
  assert.equal(after?.title, '用户亲手起的名字', '★★ **用户的名字永不被 AI 覆盖**（铁律）');
  assert.equal(after?.title_source, 'user');

  // 反向：default 名下允许 AI 写（否则就是"关了功能"）
  const id2 = await newConversation();
  const ok = rbac.setConversationTitleAi(adminId, id2, 'AI 起的名字');
  assert.equal(ok.applied, true, 'default → 允许 AI 命名');
  assert.equal(ok.row?.title_source, 'ai');
});

// ═══════════════════════════════════════════════════════════════════════
// 迁移 v7：**已迁移的库**也要有新列
// ═══════════════════════════════════════════════════════════════════════
test('★ 迁移 v7：**已迁移过的库**（无该列）→ 重开后被补上（v5 的教训）', async () => {
  const dbFile = path.join(tmp, 'legacy.sqlite3');
  // ⚠️ 不能 `fs.copyFileSync`：应用跑 WAL 模式，主文件里可能还没有数据
  //    （拷贝出来会"没有 conversations 表"→ DROP COLUMN 报 SQLITE_ERROR）。
  //    `VACUUM INTO` 产出一份**完整干净**的副本（含 WAL 里的内容）。
  built!.deps.repo.db.run(`VACUUM INTO '${dbFile.replace(/\\/g, '/')}'`);
  // 造出"v7 之前"的状态：删掉迁移记录 + 删掉列（模拟已迁移库）
  const raw = new Database(dbFile);
  raw.prepare('DELETE FROM schema_migrations WHERE version = 7').run();
  raw.exec('ALTER TABLE conversations DROP COLUMN title_source');
  const cols = (raw.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(!cols.includes('title_source'), '前置：列必须真的被删掉');
  raw.close();

  const cfg2 = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DB: dbFile,
      COURSE_KB_DATA_DIR: path.join(tmp, 'data2'),
      COURSE_KB_SETTINGS_FILE: path.join(tmp, 'settings2.json'),
    } as Record<string, string>,
  });
  const again = await buildApp({ cfg: cfg2 });
  try {
    const rows = again.deps.repo.db.all<{ name: string }>('PRAGMA table_info(conversations)');
    assert.ok(
      rows.some((r) => r.name === 'title_source'),
      '★★ v7 必须给**已迁移的库**补上 title_source（只加进 v2 补列块对已迁移库无效）',
    );
    const ver = again.deps.repo.db.all<{ version: number }>('SELECT version FROM schema_migrations');
    assert.ok(ver.some((v) => v.version === 7), '★ 必须记录 v7');
    const old = again.deps.repo.db.all<{ title_source: string }>('SELECT title_source FROM conversations LIMIT 1');
    for (const row of old) assert.equal(row.title_source, 'default', '★ 既有行的默认值必须是 default');
  } finally {
    await again.close();
  }
});

test('★ 单测：adminId/bobId 就位（前置自检，避免"看起来通过"）', () => {
  assert.ok(adminId.startsWith('usr_'), `admin id 形状（实际 ${adminId}）`);
  assert.ok(bobId.startsWith('usr_'), `bob id 形状（实际 ${bobId}）`);
  assert.notEqual(adminId, bobId);
});
