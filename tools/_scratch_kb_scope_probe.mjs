/**
 * 独立验收 ②：`kb_get` / `kb_search` 的跨用户与未发布草稿边界。
 *
 * Lead 自己写的探针（不复跑 `test/kb_query.test.ts`）：
 * - 用**独立的临时 SQLite**（不碰 data/ 里的开发库）
 * - 造 **两个真实用户** + 三份文档（alice 的 private、alice 的 public+draft、alice 的 public+published）
 * - 断言 **bob 拿不到 alice 的**（`kbGet` → null、`kbSearch` 结果里零 alice doc_id）
 * - ★ **正向对照**：alice 拿得到自己的；public+published 对所有人可见
 *   （没有对照就分不清"按规则过滤"还是"一律拒绝"）
 *
 * 运行：node tools/_scratch_kb_scope_probe.mjs   （从 apps/server 目录，用它的 node_modules）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER = path.resolve(import.meta.dirname, '..', 'apps', 'server');
// ⚠️ Windows：动态 import() 的绝对路径必须是 file:// URL（否则 ERR_UNSUPPORTED_ESM_URL_SCHEME）
const mod = (rel) => import(pathToFileURL(path.join(SERVER, rel)).href);
const { Db } = await mod('src/store/db.ts');
const { Repo } = await mod('src/store/repo.ts');
const { indexDocument } = await mod('src/store/search.ts');
const { createKbQuery } = await mod('src/store/kb-query.ts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-scope-'));
const dbPath = path.join(tmp, 'probe.sqlite3');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✔ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✖ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

const db = Db.open(dbPath);
const repo = new Repo(db);

// ── 造两个真实用户（外键开着：documents.owner_id → users，必须先建行）──────
const mkUser = (name, roles = ['student']) =>
  repo.rbac.createUser({ username: name, displayName: name, passwordHash: 'x', roles });
const aliceId = mkUser('alice_probe');
const bobId = mkUser('bob_probe');
console.log(`\n用户: alice=${aliceId}  bob=${bobId}\n`);

function seed(title, { ownerId, reviewStatus, visibility, marker }) {
  const docId = repo.insertDocument({
    title, kind: 'pdf', source_path: `data/uploads/${title}.pdf`, page_count: 10,
    status: 'ready', ownerId, reviewStatus, visibility,
  });
  const unitIds = repo.replaceUnits(docId, [{
    ord: 1, title: `第 1 章 ${title}`, level: 1, parent_ord: null,
    span: { kind: 'page', start: 1, end: 10 },
    text: `这是 ${title} 的正文。${marker} 是本章的核心概念，用于验证可见性边界。`,
  }]);
  const cardIds = repo.replaceCards(docId, [{
    unit_id: unitIds[0], name: `${marker}概念`, kind: 'concept',
    one_line: `${marker} 的简述`,
    evidence_quote: `${marker} 是本章的核心概念`,
    evidence_span: { kind: 'page', start: 2, end: 2 },
    confidence: 0.9,
  }]);
  indexDocument(db, repo, docId);   // ⚠️ 签名是 (db, repo, docId) 三个参数
  return { docId, unitId: unitIds[0], cardId: cardIds[0] };
}

const A_PRIV = seed('Alice 私有', { ownerId: aliceId, reviewStatus: 'published', visibility: 'private', marker: '甲乙私有' });
const A_DRAFT = seed('Alice 公开草稿', { ownerId: aliceId, reviewStatus: 'draft', visibility: 'public', marker: '甲乙草稿' });
const A_PUB = seed('Alice 公开已发布', { ownerId: aliceId, reviewStatus: 'published', visibility: 'public', marker: '甲乙公开' });

const kb = createKbQuery({ db, repo });

console.log('=== ② kb_get 跨用户 / 未发布 ===');
// ★ 核心断言：bob 拿 alice 的 ref_id
for (const [label, ref] of [['私有卡片', A_PRIV.cardId], ['公开草稿卡片', A_DRAFT.cardId], ['私有单元', A_PRIV.unitId]]) {
  const got = await kb.get({ userId: bobId, refId: ref });
  check(`bob kb_get(${label}) → null（拿不到）`, got === null, `实际=${got === null ? 'null' : JSON.stringify(got).slice(0, 80)}`);
}
// ★ 正向对照：alice 拿自己的私有
const own = await kb.get({ userId: aliceId, refId: A_PRIV.cardId });
check('★ 对照 alice kb_get(自己的私有) → 拿得到', own !== null && own.ref_id === A_PRIV.cardId, `实际=${own === null ? 'null' : own.ref_id}`);
// ★ 正向对照：public+published 对所有人（含 bob）可见
const pub = await kb.get({ userId: bobId, refId: A_PUB.cardId });
check('★ 对照 bob kb_get(public+published) → 拿得到（证明不是"一律拒绝"）', pub !== null, `实际=${pub === null ? 'null' : pub.ref_id}`);
// ★ 未发布草稿：即使 public，非管理员也拿不到
const draftByAdmin = await kb.get({ userId: aliceId, refId: A_DRAFT.cardId, isAdmin: true });
check('★ 对照 管理员 kb_get(public+draft) → 拿得到（证明过滤是按 published 规则）', draftByAdmin !== null, `实际=${draftByAdmin === null ? 'null' : draftByAdmin.ref_id}`);

console.log('\n=== ② kb_search 结果集隔离 ===');
const bobHits = await kb.search({ userId: bobId, query: '甲乙', limit: 20 });
const bobDocIds = new Set(bobHits.map((h) => h.doc_id));
check('bob 搜 ZZALICE 拿不到 alice 的私有文档', !bobDocIds.has(A_PRIV.docId), `命中 doc_ids=${[...bobDocIds].join(',')}`);
check('bob 搜 ZZALICE 拿不到 alice 的公开草稿', !bobDocIds.has(A_DRAFT.docId));
check('★ 对照 bob 搜得到 alice 的 public+published', bobDocIds.has(A_PUB.docId), `命中 doc_ids=${[...bobDocIds].join(',')}`);
const aliceHits = await kb.search({ userId: aliceId, query: '甲乙', limit: 20 });
const aliceDocIds = new Set(aliceHits.map((h) => h.doc_id));
check('★ 对照 alice 搜得到自己的私有文档', aliceDocIds.has(A_PRIV.docId), `命中 doc_ids=${[...aliceDocIds].join(',')}`);

console.log('\n=== ② 只读性（结构性） ===');
check('kb 模块只导出 get/search（无写入口）', JSON.stringify(Object.keys(kb).sort()) === JSON.stringify(['get', 'search']), `实际=${Object.keys(kb).join(',')}`);

console.log('\n=== ② 截断如实 + 中文 bigram ===');
const longUnit = await kb.get({ userId: aliceId, refId: A_PRIV.unitId });
check('单元可查且 truncated 是布尔（如实）', typeof longUnit?.truncated === 'boolean', `实际=${longUnit?.truncated}`);
const cn = await kb.search({ userId: aliceId, query: '核心概念', limit: 5 });
check('★ 中文经 bigram 能命中（坑 15：unicode61 为 0）', cn.length > 0, `命中=${cn.length}`);

db.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${'='.repeat(60)}\n② 结果: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
