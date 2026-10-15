/**
 * ★★ **判据④（真 HTTP）**：`GET /api/v1/cards/<旧 id>` → reparse 后**仍 200**（不是 404）。
 *
 * ## 为什么单独一个文件
 * `test/cards_id_reuse_verify.test.ts`（`backend-api`）实现了 ① ② ③ ⑤，
 * ★ 但 **④ 只写在文件头注释里**（未实现）—— 而 ④ 恰恰是**用户可见**的那条：
 * 旧卡链接/书签/前端缓存点开就是 404。
 * ⟹ 本文件**只补这一条**（不重复它的 5 条判据，避免"两个文件测同一件事"）。
 *
 * ## ★ 为什么用**最小 app**（而不是 `buildApp`）
 * `buildApp` 会启动 **settings 热重载 watcher**（watch 的是**项目的** `config/settings.json`）——
 * 并行开发时队友正在改那个文件 → watcher 回调在**测试 teardown 期间**触发 →
 * Windows 上直接 libuv 断言崩溃（`UV_HANDLE_CLOSING`），**整个文件被判 failed（尽管用例全绿）**。
 * 本文件只需要 cards 路由 + repo ⟹ 显式组装最小 app：**仍然走真 HTTP**，但不引入无关的全局副作用。
 *
 * ## 判据
 * 1. 直连 repo 写一次卡（模拟抽取）→ 记 id
 * 2. 再写一次**相同内容**（模拟 reparse 重抽出同样结果）→ `GET /cards/<旧 id>` **200** + 内容一致
 * 3. 反例（同样走 HTTP）：`replaceCards(docId, [])`（零产出）→ 旧卡**仍 200**（失败不清库）
 * 4. 内容真变了 → 旧 id **应当 404**（换 id 是对的）—— 证明"不是靠永远复用过判据"
 * ★ 零 LLM：不跑抽取，直连 repo 造数据。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import http from 'node:http';

import Fastify from 'fastify';

import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { registerCardRoutes } from '../src/routes/cards.ts';
import type { AppDeps } from '../src/app-deps.ts';

let tmp = '';
let db: Db | null = null;
let repo: Repo | null = null;
let app: ReturnType<typeof Fastify> | null = null;
let base = '';
let docId = '';
let unitIds: string[] = [];

const mkCard = (unitId: string, name: string, quote: string): Record<string, unknown> => ({
  unit_id: unitId,
  name,
  kind: 'concept',
  one_line: `${name} 的一句话`,
  purpose: 'purpose',
  usage_mode: 'unknown',
  operational_role: 'unknown',
  lifecycle: 'unknown',
  evidence_quote: quote,
  evidence_span: { kind: 'page', start: 1, end: 1 },
  confidence: 0.9,
});

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-http-'));
  db = Db.open(path.join(tmp, 't.sqlite3'));
  db.migrate();
  repo = new Repo(db);
  const userId = repo.rbac.createUser({ username: 't', displayName: 'T', passwordHash: 'x', roles: ['teacher'] });
  docId = repo.insertDocument({ title: 'd.pdf', kind: 'pdf', source_path: 'x.pdf', status: 'ready', ownerId: userId });
  unitIds = repo.replaceUnits(docId, [
    { ord: 1, title: 'u1', level: 2, span: { kind: 'page', start: 1, end: 1 }, text: '正文一' },
    { ord: 2, title: 'u2', level: 2, span: { kind: 'page', start: 2, end: 2 }, text: '正文二' },
  ] as never);

  // ★ 最小 app：只挂 cards 路由（**真 HTTP**，但不启动 watcher/agent 等全局副作用）
  app = Fastify({ logger: false });
  // cards 路由只用 `repo`（见 routes/cards.ts）—— 其余字段给最小占位，避免引入副作用
  registerCardRoutes(app, { repo, db } as unknown as AppDeps);
  const addr = await app.listen({ host: '127.0.0.1', port: 0 });
  base = addr;
});

after(async () => {
  try {
    if (app) await app.close();
  } catch {
    /* ignore */
  }
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows 偶发占用 */
  }
});

/**
 * ★ 用 `node:http` + `agent: false`（**不用 `fetch`**）：
 * undici 的连接池会在进程 teardown 时留 socket → Windows 上 libuv 断言崩溃
 * （`UV_HANDLE_CLOSING`），**整个文件被判 failed（尽管用例全绿）**。
 */
async function getCard(id: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = new URL(`${base}/api/v1/cards/${id}`);
  return await new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', agent: false },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            json = { raw: text };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('★★ 判据④：相同内容 reparse → `GET /cards/<旧 id>` **仍 200**（用户可见）', async () => {
  const ids = repo!.replaceCards(docId, [
    mkCard(unitIds[0]!, '聚簇索引', '聚簇索引正文'),
    mkCard(unitIds[1]!, '二级索引', '二级索引正文'),
  ] as never);
  assert.equal(ids.length, 2);
  const oldId = ids[0]!;
  const before1 = await getCard(oldId);
  assert.equal(before1.status, 200, '前置：旧卡本来就能取到');

  repo!.replaceCards(docId, [
    mkCard(unitIds[0]!, '聚簇索引', '聚簇索引正文'),
    mkCard(unitIds[1]!, '二级索引', '二级索引正文'),
  ] as never);

  const after1 = await getCard(oldId);
  assert.equal(after1.status, 200, '★★ 旧卡 id 必须仍能取到（原缺陷：全删重插 → 404）');
  const card = (after1.json as { card?: { name?: string; evidence_quote?: string } }).card;
  assert.equal(card?.name, '聚簇索引', `内容也要对得上（实际 ${JSON.stringify(after1.json).slice(0, 120)}）`);
  assert.equal(card?.evidence_quote, '聚簇索引正文');
});

test('★★ 反例（同样走 HTTP）：零产出 `replaceCards([])` → 旧卡**仍 200**（失败不清库）', async () => {
  const ids = repo!.allCardRows(docId).map((c) => c.id);
  assert.ok(ids.length > 0, '前置：有卡片');
  repo!.replaceCards(docId, []); // 模拟抽取失败/零产出
  for (const id of ids) {
    const r = await getCard(id);
    assert.equal(r.status, 200, `★ 零产出不许清库：${id} 必须仍 200（原缺陷会全删 → 404）`);
  }
});

test('★ 内容真变了 → 旧 id **应当 404**（换 id 是对的，证明不是"永远复用"过判据）', async () => {
  const rows = repo!.allCardRows(docId);
  const target = rows.find((c) => c.name === '聚簇索引');
  assert.ok(target, '前置：应有"聚簇索引"卡');
  const other = rows.find((c) => c.name === '二级索引');
  repo!.replaceCards(docId, [
    mkCard(target.unit_id, '聚簇索引', '聚簇索引正文（改写后的引用）'),
    mkCard(other!.unit_id, '二级索引', '二级索引正文'),
  ] as never);

  const gone = await getCard(target.id);
  assert.equal(gone.status, 404, '★ 内容变了的卡应当换 id（旧 id 404）');
  const kept = await getCard(other!.id);
  assert.equal(kept.status, 200, '★ 内容未变的卡必须保留 id（否则仍是全量替换）');
});
