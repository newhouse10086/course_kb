/**
 * `/api/v1/chat/{sessionId}` WebSocket 薄层测试（契约 §7.2）—— **真 WS 连接**。
 *
 * 路由是我的写域，协议是 T-AGENT 的（`createChatConnection`）。
 * 这里只验证**我这层**的职责：
 * 1. 帧透传：client → `handleClientMessage`，`send` → ws.send(JSON)
 * 2. **诚实降级**：agent 不可用时把 `E_PI_UNAVAILABLE` 送到前端并关闭（不是静默挂着）
 * 3. `onClose` 真的关 socket
 * 4. **agent 模块缺失时路由不注册**（`GET` 落到 404，不是 500）
 * 5. 工厂抛异常时**服务不崩**（后续请求仍 200）
 *
 * ⚠️ 断言的是**具体帧内容与关闭码**，不是"连上了"。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import { buildApp } from '../src/index.ts';
import type { BuiltApp } from '../src/index.ts';
import type { ChatConnectionFactory } from '../src/app-deps.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
let tmpRoot = '';
let counter = 0;

const noopExtractor = {
  name: 'noop',
  async available() {
    return { ok: false, reason: '测试不需要抽取' };
  },
  async extractDocument() {
    throw new Error('不应被调用');
  },
};

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'chat-pass-12345';
let authCookie: string | null = null;

/**
 * ★★ 安全回归：**只有 admin 能拿到 agent 工具**（`read`/`bash`/`edit`/`write`）。
 *
 * ## 为什么要这条（polysemy-prober live 复现的 critical）
 * 学生连上后 `ready.tools = ["read","bash","edit","write"]` —— 直接拿到**服务器 shell**：
 * 绕过 RBAC（`RBAC.md §1` 没有"执行命令"）、绕过整个 SQL 沙箱（用 `bash` 跑 `sqlite3` 从旁边绕），
 * 还能读任意文件（实测读到 `C:\Windows\win.ini`）。
 *
 * 这里断言**服务端策略**：工厂收到的 `allowTools` 必须按**服务端身份**判定
 * （`teacher`/`student` → false，`admin` → true），且**客户端无法影响它**
 * （帧里塞 `roles`/`allowTools` 都不许改变结果 —— 与"客户端不许传检索 context"同一条原则）。
 *
 * 注：agent 层"真的不注册工具"由 pi-bridge 的测试覆盖；本条守的是**判定与传递**这一环。
 */
test('★★ 安全：仅 admin 允许 agent 工具；student/teacher 一律 false（服务端权威，客户端伪造无效）', async () => {
  const seen: { user: unknown; allowTools: unknown }[] = [];
  const spyFactory: ChatConnectionFactory = async (opts) => {
    seen.push({ user: opts.user, allowTools: opts.allowTools });
    return {
      async handleClientMessage() {
        /* noop */
      },
      async close() {
        /* noop */
      },
    };
  };
  const built = await makeApp(spyFactory);
  const wsBase = await listen(built); // ⚠️ 本文件的 listen() 返回的是 **ws://** 基址
  const httpBase = wsBase.replace(/^ws/, 'http');
  try {
    // admin 建号：一个 student、一个 teacher
    for (const [name, role] of [
      ['sec-stu', 'student'],
      ['sec-tea', 'teacher'],
    ] as const) {
      const res = await fetch(`${httpBase}/api/v1/users`, {
        method: 'POST',
        headers: { cookie: authCookie!, 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, password: 'sec-pass-12345', roles: [role] }),
      });
      assert.ok(res.status === 200 || res.status === 201, `建号 ${name} 失败：${res.status} ${await res.text()}`);
    }

    const connectAs = async (name: string): Promise<Record<string, unknown>[]> => {
      const login = await fetch(`${httpBase}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, password: 'sec-pass-12345' }),
      });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      assert.equal(login.status, 200, `${name} 登录失败`);
      const before = seen.length;
      const ws = new WebSocket(`${wsBase}/api/v1/chat/sec-${name}`, { headers: { cookie } });
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => {
          // ★ 客户端**伪造**角色与 allowTools：服务端必须无视
          ws.send(JSON.stringify({ type: 'prompt', message: 'hi', roles: ['admin'], allowTools: true, user: { roles: ['admin'] } }));
          setTimeout(() => {
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            resolve();
          }, 250);
        });
        ws.addEventListener('error', () => reject(new Error(`${name} WS 连接失败`)));
      });
      assert.equal(seen.length, before + 1, `${name} 应触发一次工厂调用`);
      return seen.slice(before);
    };

    const stu = await connectAs('sec-stu');
    const stu0 = stu[0]!;
    assert.equal(stu0.allowTools, false, '★★ student 绝不许拿工具（服务器 shell = 绕过 RBAC + 沙箱）');
    assert.deepEqual((stu0.user as { roles: string[] }).roles, ['student'], '角色必须是**服务端**解出的，不是帧里的');

    const tea = await connectAs('sec-tea');
    assert.equal(tea[0]!.allowTools, false, '★★ teacher 也不许（教学场景不需要服务器 shell）');

    // admin：允许（管理员本来就有服务器权限，工具不扩大其权力）
    const adminSeenBefore = seen.length;
    const wsAdmin = new WebSocket(`${wsBase}/api/v1/chat/sec-admin`, {
      headers: { cookie: authCookie! },
    });
    await new Promise<void>((resolve, reject) => {
      wsAdmin.addEventListener('open', () => {
        setTimeout(() => {
          try {
            wsAdmin.close();
          } catch {
            /* ignore */
          }
          resolve();
        }, 250);
      });
      wsAdmin.addEventListener('error', () => reject(new Error('admin WS 连接失败')));
    });
    assert.equal(seen.length, adminSeenBefore + 1);
    assert.equal(seen[seen.length - 1]!.allowTools, true, 'admin 应允许工具');
  } finally {
    await built.close();
  }
});

/**
 * 回归：**连接就绪前到达的客户端帧不许丢**。
 *
 * 原 bug（polysemy-prober 的"180s 零帧"）：`socket.on('message')` 在
 * `await chatFactory(...)` **之后**才注册，而建连接要 ~2.7s（解析模型、开 pi 会话）；
 * 浏览器习惯在 `onopen` 后**立刻**发 prompt → 帧到达时没有监听器 → 被 EventEmitter 丢弃 → 永远沉默。
 * 这里用一个**故意慢**（250ms）的工厂复现那个窗口。
 */
test('★ 连接就绪前发出的帧必须被缓冲并回放（慢工厂 250ms 复现竞态）', async () => {
  const slowFactory: ChatConnectionFactory = async ({ send }) => {
    await new Promise((r) => setTimeout(r, 250)); // 模拟"解析模型 + 开 pi 会话"的耗时
    return {
      async handleClientMessage(raw) {
        await send({ type: 'echo', got: String(raw) });
        await send({ type: 'settled' });
      },
      async close() {
        /* noop */
      },
    };
  };
  const built = await makeApp(slowFactory);
  const wsBase = await listen(built);
  try {
    // connect() 在 `open` 事件里立刻发送 —— 正好落在工厂还没 resolve 的窗口内
    const c = connect(`${wsBase}/api/v1/chat/slow-1`, {
      send: JSON.stringify({ type: 'prompt', message: '早到的帧' }),
      timeoutMs: 30_000,
    });
    // ⚠️ 不等"服务端关连接"（stub 不会主动关）：**等帧到齐**，有界轮询后自己收尾
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !c.frames.some((f) => f.type === 'settled')) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const echo = c.frames.find((f) => f.type === 'echo');
    assert.ok(echo, `★ 早到的帧被丢了：收到 ${JSON.stringify(c.frames)}`);
    assert.equal(echo.got, JSON.stringify({ type: 'prompt', message: '早到的帧' }), '回放的内容必须与客户端发的**逐字相同**');
    assert.ok(c.frames.some((f) => f.type === 'settled'), 'settled 也要到达');
  } finally {
    await built.close();
  }
});

/** 起服务 + 登录（WS 也要带 cookie —— 我的鉴权钩子对 WS 握手同样生效）。 */
async function loginFor(base: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  if (res.status !== 200) throw new Error(`登录失败(${res.status})：${await res.text()}`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function makeApp(chatFactory: ChatConnectionFactory | null): Promise<BuiltApp> {
  counter += 1;
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DATA_DIR: path.join(tmpRoot, `data-${counter}`),
      COURSE_KB_DB: path.join(tmpRoot, `chat-${counter}.sqlite3`),
      COURSE_KB_BOOTSTRAP_ADMIN: `${ADMIN_USER}:${ADMIN_PASS}`,
    } as Record<string, string>,
  });
  return buildApp({
    cfg,
    extractor: noopExtractor,
    chatFactory,
    agentCapabilities: null,
    workerProbe: async () => ({
      available: false,
      bin: 'python',
      module: 'worker.cli',
      pythonVersion: null,
      moduleImportable: false,
      reason: '测试未启用 worker',
      checkedAt: Date.now(),
      cached: false,
      probes: {
        python: { ok: false, stdout: '', stderr: '', code: null, elapsedMs: 0 },
        module: { ok: false, stdout: '', stderr: '', code: null, elapsedMs: 0 },
      },
    }),
  });
}

async function listen(built: BuiltApp): Promise<string> {
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('无法取到监听地址');
  // RBAC：登录一次，WS 握手时带上 cookie（/chat 受 401 闸门保护）
  authCookie = await loginFor(`http://127.0.0.1:${addr.port}`);
  return `ws://127.0.0.1:${addr.port}`;
}

interface Collected {
  frames: Record<string, unknown>[];
  /** 收到的原始文本（用于断言"确实透传了"） */
  raw: string[];
  closed: Promise<{ code: number; reason: string }>;
}

/** 连上去、收集帧，直到服务端关闭（带超时，避免测试挂死）。 */
function connect(url: string, opts: { send?: string; sendSeq?: string[]; timeoutMs?: number } = {}): Collected {
  const ws = new WebSocket(url, authCookie ? { headers: { cookie: authCookie } } : undefined);
  const frames: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error(`WS 在 ${opts.timeoutMs ?? 5000}ms 内没有关闭`));
    }, opts.timeoutMs ?? 5000);
    ws.addEventListener('message', (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
      raw.push(text);
      try {
        frames.push(JSON.parse(text) as Record<string, unknown>);
      } catch {
        /* 非 JSON 帧也记录原始文本 */
      }
    });
    ws.addEventListener('close', (ev) => {
      clearTimeout(timer);
      resolve({ code: ev.code, reason: ev.reason });
    });
    ws.addEventListener('error', () => {
      /* close 会随后到达 */
    });
    ws.addEventListener('open', () => {
      if (opts.send !== undefined) ws.send(opts.send);
      if (opts.sendSeq) {
        // 按序发多条（间隔 60ms，保证服务端按序处理）
        opts.sendSeq.forEach((m, i) => {
          setTimeout(() => {
            try {
              ws.send(m);
            } catch {
              /* 已关闭 */
            }
          }, i * 60);
        });
      }
    });
  });
  return { frames, raw, closed };
}

/**
 * ★ 对话模式的服务端校验（Lead 裁定）：只接受 `chat`/`agent`；**未知值 → 明确报错**（不静默降级）。
 * 覆盖：URL `?mode=` 非法（建连接时就拒）+ 帧里 `mode` 非法/不一致（拒且**不转发**给 agent）。
 */
test('★ 模式校验：?mode=agent 合法；未知 mode → 明确报错并关闭（不静默降级）', async () => {
  const seenModes: unknown[] = [];
  const spyFactory: ChatConnectionFactory = async (opts) => {
    seenModes.push(opts.mode);
    return {
      async handleClientMessage() {
        /* noop */
      },
      async close() {
        /* noop */
      },
    };
  };
  const built = await makeApp(spyFactory);
  const wsBase = await listen(built);
  /**
   * ⚠️ 不等"服务端关连接"：stub 工厂不会主动关 → 等**帧到齐**（有界轮询）后自己收尾。
   * （上次那条测试就是这么红的：断言要盯要验证的那件事，别顺带依赖无关副作用。）
   */
  const connectRaw = async (
    base: string,
    path: string,
    send?: string,
    waitMs = 1500,
  ): Promise<{ frames: Record<string, unknown>[]; closed: boolean }> => {
    const ws = new WebSocket(`${base}${path}`, { headers: { cookie: authCookie! } });
    const frames: Record<string, unknown>[] = [];
    let closed = false;
    ws.addEventListener('message', (ev) => {
      try {
        frames.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)));
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener('close', () => {
      closed = true;
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => {
        if (send) ws.send(send);
        resolve();
      });
      ws.addEventListener('error', () => reject(new Error('WS 连接失败')));
      setTimeout(() => resolve(), 8000);
    });
    // 有界等待：等到"出现 error 帧"或"被关闭"或超时（合法连接不会被关闭 → 走超时分支）
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && !closed && !frames.some((f) => f.type === 'error')) {
      await new Promise((r) => setTimeout(r, 25));
    }
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    return { frames, closed };
  };
  try {
    // ① 缺省 → chat（无工具模式）
    const dflt = await connectRaw(wsBase, '/api/v1/chat/mode-dflt');
    assert.equal(seenModes.at(-1), 'chat', '缺省必须是 chat');
    assert.deepEqual(dflt.frames, [], '正常连接不该收到 error 帧');

    // ② ?mode=agent 合法（模式传到工厂 —— 工具集在建会话时定）
    const agent = await connectRaw(wsBase, '/api/v1/chat/mode-agent?mode=agent');
    assert.equal(seenModes.at(-1), 'agent', '?mode=agent 必须传到工厂');
    assert.deepEqual(agent.frames, [], 'agent 模式正常连接不该收到 error 帧');

    // ③ ★ 未知 mode → **明确报错**（E_BADREQUEST + hint 指向合法值），且**不建连接**
    const before = seenModes.length;
    const bad = await connectRaw(wsBase, '/api/v1/chat/mode-bad?mode=tool');
    assert.equal(seenModes.length, before, '★ 非法 mode 不许建连接（不能静默降级成 chat）');
    const err = bad.frames.find((f) => f.type === 'error');
    assert.ok(err, `★ 必须发 error 帧：${JSON.stringify(bad.frames)}`);
    assert.equal(err.code, 'E_BADREQUEST');
    assert.match(String(err.msg), /tool/, '错误信息要带上收到的非法值');
    assert.match(String(err.hint), /chat/, 'hint 要指出合法取值');
    assert.equal(bad.closed, true, '策略违规应主动关闭连接');
  } finally {
    await built.close();
  }

  // ④ ★ 帧里 mode 与连接不一致 → 明确报错，且**不转发**给 agent 层
  const forwarded: string[] = [];
  const strictFactory: ChatConnectionFactory = async () => ({
    async handleClientMessage(raw) {
      forwarded.push(String(raw)); // 记录"有没有被转发"
    },
    async close() {
      /* noop */
    },
  });
  const built2 = await makeApp(strictFactory);
  const wsBase2 = await listen(built2);
  try {
    const c = await connectRaw(
      wsBase2,
      '/api/v1/chat/mode-mismatch',
      JSON.stringify({ type: 'prompt', message: 'hi', mode: 'agent' }),
    );
    const err2 = c.frames.find((f) => f.type === 'error');
    assert.ok(err2, `★ 不一致必须报错：${JSON.stringify(c.frames)}`);
    assert.equal(err2.code, 'E_BADREQUEST');
    assert.match(String(err2.hint), /会话级|重连/, 'hint 要解释"模式是会话级的"');
    assert.deepEqual(forwarded, [], '★ 不一致的帧**不许转发**给 agent 层（否则它会按错误模式跑）');
  } finally {
    await built2.close();
  }
});

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ckb-chat-'));
});

after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows 偶发占用 */
  }
});

test('chat 正常路径：客户端帧原样交给 agent，agent 的帧原样下发（JSON 字符串）', async () => {
  const seen: string[] = [];
  const factory: ChatConnectionFactory = async ({ sessionId, send, onClose }) => {
    assert.equal(sessionId, 'sess_abc-1');
    await send({ type: 'ready', session_id: sessionId, mode: 'sdk' });
    return {
      async handleClientMessage(rawIn) {
        seen.push(String(rawIn));
        const parsed = JSON.parse(String(rawIn)) as { type: string; message?: string };
        if (parsed.type === 'prompt') {
          await send({ type: 'text_delta', delta: `echo:${parsed.message}` });
          await send({ type: 'settled', aborted: false });
        } else if (parsed.type === 'abort') {
          onClose(1000, 'client abort');
        }
      },
      async close() {
        /* 由 onClose 关 */
      },
    };
  };

  const built = await makeApp(factory);
  const base = await listen(built);
  try {
    const c = connect(`${base}/api/v1/chat/sess_abc-1`, {
      // 先 prompt（拿流式帧），再 abort（让 agent 请求关闭 1000）
      sendSeq: [JSON.stringify({ type: 'prompt', message: '解释聚簇索引' }), JSON.stringify({ type: 'abort' })],
    });
    const close = await c.closed;
    assert.equal(close.code, 1000);
    assert.equal(close.reason, 'client abort');
    assert.deepEqual(c.frames[0], { type: 'ready', session_id: 'sess_abc-1', mode: 'sdk' });
    assert.deepEqual(c.frames[1], { type: 'text_delta', delta: 'echo:解释聚簇索引' });
    assert.deepEqual(c.frames[2], { type: 'settled', aborted: false });
    assert.deepEqual(
      seen,
      [JSON.stringify({ type: 'prompt', message: '解释聚簇索引' }), JSON.stringify({ type: 'abort' })],
      '客户端帧必须按序原样透传',
    );
    assert.ok(c.raw.every((t) => typeof JSON.parse(t) === 'object'), '每一帧都必须是 JSON 字符串');
  } finally {
    await built.close();
  }
});

test('★ 诚实降级：agent 不可用时下发 error{E_PI_UNAVAILABLE} 并关闭 1013（不静默挂着）', async () => {
  // 模拟 pi-bridge 承诺的行为：不抛，发一帧 error 后请求关闭
  const factory: ChatConnectionFactory = async ({ send, onClose }) => {
    await send({
      type: 'error',
      code: 'E_PI_UNAVAILABLE',
      msg: 'pi SDK 不可用',
      hint: '装好 @earendil-works/pi-coding-agent 后重启',
    });
    onClose(1013, 'pi unavailable');
    return {
      async handleClientMessage() {
        await send({ type: 'error', code: 'E_PI_UNAVAILABLE', msg: 'pi 不可用（哑连接）' });
      },
      async close() {
        /* noop */
      },
    };
  };

  const built = await makeApp(factory);
  const base = await listen(built);
  try {
    const c = connect(`${base}/api/v1/chat/sess_down`);
    const close = await c.closed;
    assert.equal(close.code, 1013, '必须用 1013（服务不可用）关闭');
    assert.deepEqual(c.frames[0], {
      type: 'error',
      code: 'E_PI_UNAVAILABLE',
      msg: 'pi SDK 不可用',
      hint: '装好 @earendil-works/pi-coding-agent 后重启',
    });
  } finally {
    await built.close();
  }
});

test('工厂抛异常 → 路由自己兜底发 error{E_PI_UNAVAILABLE} 并关 1011；服务不崩', async () => {
  const factory: ChatConnectionFactory = async () => {
    throw new Error('SDK 初始化炸了');
  };

  const built = await makeApp(factory);
  const base = await listen(built);
  try {
    const c = connect(`${base}/api/v1/chat/sess_boom`);
    const close = await c.closed;
    assert.equal(close.code, 1011, '内部错误用 1011 关闭');
    assert.equal(c.frames.length, 1);
    const f = c.frames[0] as Record<string, unknown>;
    assert.equal(f.type, 'error');
    assert.equal(f.code, 'E_PI_UNAVAILABLE');
    assert.match(String(f.msg), /SDK 初始化炸了/);
    assert.match(String(f.hint), /agent 模块初始化失败/);

    // 服务仍然健康（异常没有被扩散）
    const health = await fetch(`http://127.0.0.1:${(built.app.server.address() as { port: number }).port}/api/v1/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as Record<string, unknown>).ok, true);
  } finally {
    await built.close();
  }
});

test('agent 模块缺失（factory=null）→ 不注册 WS 路由，HTTP GET 落 404（不是 500）', async () => {
  const built = await makeApp(null);
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (built.app.server.address() as { port: number }).port;
  try {
    // RBAC：先登录 —— 否则会先撞 401 闸门（那是**正确**行为：未登录不该知道路由存在与否）
    const cookie = await loginFor(`http://127.0.0.1:${port}`);
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/chat/sess_x`, { headers: { cookie } });
    assert.equal(res.status, 404);
    // 未登录时同一个路径必须是 401（不是 404 —— 不泄露"该路由是否存在"）
    const anon = await fetch(`http://127.0.0.1:${port}/api/v1/chat/sess_x`);
    assert.equal(anon.status, 401);
    const body = (await res.json()) as Record<string, Record<string, string>>;
    assert.equal(body.error?.code, 'E_NOTFOUND');
    // 能力上报也要如实说"聊天不可用"
    const caps = (await (await fetch(`http://127.0.0.1:${port}/api/v1/capabilities?deep=0`)).json()) as Record<
      string,
      Record<string, unknown>
    >;
    assert.equal((caps.pi as Record<string, unknown>).available, false);
    assert.match(String((caps.pi as Record<string, unknown>).reason), /agent/);
  } finally {
    await built.close();
  }
});
