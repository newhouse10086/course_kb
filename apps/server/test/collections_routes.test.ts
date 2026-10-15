/**
 * ★★ **视频目录 HTTP 层**（`routes/collections.ts`）—— 修"前端有、后端没有"。
 *
 * ## 缺陷（Lead 实测）
 * ```
 * GET /api/v1/collections（**已登录**）→ 404 接口不存在
 * ✅ 表有（DDL_V4_COLLECTIONS）· ✅ repo 有（collections-repo.ts）· ❌ **路由层没有**
 * ⟹ 前端 Video.vue 完整实现却只能显示"后端尚未实现视频目录（404）"
 * ```
 * ## 判据（Lead 指定，全部断言**具体值**）
 * ```
 * ✔ ★ **对照组**（已登录）：存在的端点 200 · 不存在的端点 404 —— **可区分**
 * ✔ ★★ **坑 37**：**未登录**时两者**都是 401** ⟹ "未登录探 401"证明不了端点存在
 * ✔ 建目录 201 + `can_manage` 由**服务端**算（teacher=true / student=false）
 * ✔ ★★ `video_count` **真实统计**：建目录 → 上传 1 个视频 → **=== 1**（不是"字段存在"）
 * ✔ ★★ `published` **派生**：改 review_status → **结果真的跟着变**
 * ✔ ★★ `videos_detached`：删目录 → 那 N 个视频**真的还在**（只是 collection_id 变 null，**不许一起删**）
 * ✔ ★ IDOR：别人的目录 PATCH/DELETE → **404**（不泄露存在性）· 学生建目录 → 403
 * ✔ ★ 上传带**不可见**目录 → **404 且不产生文档**（fail-closed，**先校验再落盘**）
 * ✔ `ai_parse`：抽取器不可用时 **available=false + 原因**（不假装可用），**不编** `estimated_llm_calls`
 * ★ 全零 LLM：不触发任何抽取（`COURSE_KB_AUTO_EXTRACT=0` + 假 mp4 的解析失败不影响判据）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { buildApp } from '../src/index.ts';
import type { BuiltApp } from '../src/index.ts';
import { loadConfig } from '../src/config.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
let tmp = '';
let built: BuiltApp | null = null;
let base = '';
let teacherCookie = '';
let otherTeacherCookie = '';
let studentCookie = '';
let teacherId = '';
let otherTeacherId = '';

async function http(
  method: string,
  url: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
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

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.ok(cookie, `${username} 必须能登录（HTTP ${res.status}）`);
  return cookie;
}

/** 真·multipart 上传（与前端 `client.ts::uploadDocument` 同形状：file + collection_id 字段） */
async function uploadVideo(
  cookie: string,
  collectionId: string | null,
  filename = 'lecture.mp4',
): Promise<{ status: number; json: Record<string, unknown> }> {
  const form = new FormData();
  // 假 mp4（内容不重要：这里只验"目录归属 + 计数"，解析失败不影响判据）
  form.append('file', new Blob([Buffer.from('fake-mp4-bytes')], { type: 'video/mp4' }), filename);
  if (collectionId) form.append('collection_id', collectionId);
  const res = await fetch(`${base}/api/v1/documents`, { method: 'POST', headers: { cookie }, body: form });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

/**
 * ★ **直接种一个视频文档**（不走上传 → **不排 parse 任务**）。
 *
 * 为什么需要它：上传会给该用户排一个 `parse` 任务，而**每用户任务配额 = 2**
 * （实测：第三个上传 → `429 E_QUOTA 并发任务已达配额（2/2）`）⟹ 多个测试连着上传会**假红**。
 * 判据本身与"解析"无关（只验目录归属/计数/派生/解绑）→ 直接种行，**快且确定**。
 * ⚠️ 但"上传接口真的接受 `collection_id`"必须**至少有一条真 multipart 用例**（见 `video_count` 测试）。
 */
function insertVideoDoc(collectionId: string | null, title = 'v.mp4'): string {
  return built!.deps.repo.insertDocument({
    title,
    kind: 'video',
    source_path: `uploads/${title}`,
    status: 'ready',
    ownerId: teacherId,
    visibility: 'private',
    reviewStatus: 'draft',
    collectionId,
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collections-'));
  const cfg = loadConfig({
    root: ROOT,
    env: {
      ...process.env,
      COURSE_KB_DB: path.join(tmp, 't.sqlite3'),
      COURSE_KB_DATA_DIR: path.join(tmp, 'data'),
      COURSE_KB_SETTINGS_FILE: path.join(tmp, 'settings.json'),
      COURSE_KB_BOOTSTRAP_ADMIN: 'admin:collections-pass-1',
      COURSE_KB_AUTO_EXTRACT: '0', // ★ 零 LLM
    } as Record<string, string>,
  });
  built = await buildApp({ cfg });
  const rbac = built.deps.repo.rbac;
  const { hashPassword } = await import('../src/auth/password.ts');
  teacherId = rbac.createUser({
    username: 'teacher_a',
    displayName: 'Teacher A',
    passwordHash: await hashPassword('teacher-pass-0001'),
    roles: ['teacher'],
  });
  otherTeacherId = rbac.createUser({
    username: 'teacher_b',
    displayName: 'Teacher B',
    passwordHash: await hashPassword('teacher-pass-0002'),
    roles: ['teacher'],
  });
  rbac.createUser({
    username: 'student_c',
    displayName: 'Student C',
    passwordHash: await hashPassword('student-pass-0001'),
    roles: ['student'],
  });

  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('取不到端口');
  base = `http://127.0.0.1:${addr.port}`;
  teacherCookie = await login('teacher_a', 'teacher-pass-0001');
  otherTeacherCookie = await login('teacher_b', 'teacher-pass-0002');
  studentCookie = await login('student_c', 'student-pass-0001');
});

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

async function newCollection(name: string, cookie = teacherCookie): Promise<string> {
  const r = await http('POST', '/api/v1/collections', { cookie, body: { name } });
  assert.equal(r.status, 201, `建目录应 201（实际 ${r.status} ${JSON.stringify(r.json)}）`);
  const id = (r.json as { collection?: { id?: string } }).collection?.id;
  assert.ok(id, '必须返回目录 id');
  return id;
}

// ═══════════════════════════════════════════════════════════════════════
// ★★ 端点存在性判据（坑 37）
// ═══════════════════════════════════════════════════════════════════════
test('★★ 对照组（**已登录**）：存在的端点 200 · 不存在的端点 404 —— 可区分', async () => {
  const real = await http('GET', '/api/v1/collections', { cookie: teacherCookie });
  assert.equal(real.status, 200, `★ /collections 必须存在（原来 404）—— 实际 ${real.status}`);
  const ghost = await http('GET', '/api/v1/nonexistent-xyz-42', { cookie: teacherCookie });
  assert.equal(ghost.status, 404, '不存在的端点必须 404');
  assert.notEqual(real.status, ghost.status, '★ 已登录下两者必须**可区分**');
});

test('★★ 坑 37：**未登录**时"存在"与"不存在"**都是 401** ⟹ 未登录探 401 证明不了端点存在', async () => {
  const real = await http('GET', '/api/v1/collections'); // 无 cookie
  const ghost = await http('GET', '/api/v1/nonexistent-xyz-42'); // 无 cookie
  assert.equal(real.status, 401, '未登录访问**存在**的端点 → 401（全局鉴权先于路由匹配）');
  assert.equal(ghost.status, 401, '★ 未登录访问**不存在**的端点 → **也是 401**');
  assert.equal(real.status, ghost.status, '★ 所以"未登录探 401"**无法区分存在性**（必须带凭据 + 对照组）');
});

// ═══════════════════════════════════════════════════════════════════════
// 建 / 读 / 权限
// ═══════════════════════════════════════════════════════════════════════
test('★ 建目录 → 201 + `can_manage` 由**服务端**算 + `published` 派生为 false', async () => {
  const r = await http('POST', '/api/v1/collections', {
    cookie: teacherCookie,
    body: { name: '  数据库系列视频  ', description: '索引与事务' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const c = (r.json as { collection?: Record<string, unknown> }).collection!;
  assert.equal(c.name, '数据库系列视频', '★ 必须 trim');
  assert.equal(c.description, '索引与事务');
  assert.equal(c.can_manage, true, '★ owner 的 can_manage 必须由服务端算为 true');
  assert.equal(c.published, false, '★ 新建默认 draft → published 必须 false（派生）');
  assert.equal(c.video_count, 0, '★ 空目录计数必须是 0（真实统计）');
  assert.equal(c.owner_id, teacherId);
});

test('★ 学生**不能**建目录（403，且走 can() 单一入口）', async () => {
  const r = await http('POST', '/api/v1/collections', { cookie: studentCookie, body: { name: '学生想建' } });
  assert.equal(r.status, 403, `学生建目录必须 403（实际 ${r.status}）`);
  assert.equal((r.json as { error?: { code?: string } }).error?.code, 'E_FORBIDDEN');
});

test('★ 空白名/超长名 → 400（**不静默截断**）', async () => {
  const blank = await http('POST', '/api/v1/collections', { cookie: teacherCookie, body: { name: '   ' } });
  assert.equal(blank.status, 400);
  const long = await http('POST', '/api/v1/collections', {
    cookie: teacherCookie,
    body: { name: '长'.repeat(81) },
  });
  assert.equal(long.status, 400, '★ 超长必须 400（不截断）');
});

test('★ IDOR：别人的目录 PATCH/DELETE → **404**（不泄露存在性）；自己的 → 200', async () => {
  const mine = await newCollection('teacher_a 的目录');
  const patchOther = await http('PATCH', `/api/v1/collections/${mine}`, {
    cookie: otherTeacherCookie,
    body: { name: '我要改别人的' },
  });
  assert.equal(patchOther.status, 404, `★ 别人的目录必须 404（实际 ${patchOther.status}）`);
  assert.equal((patchOther.json as { error?: { code?: string } }).error?.code, 'E_NOTFOUND');
  const delOther = await http('DELETE', `/api/v1/collections/${mine}`, { cookie: otherTeacherCookie });
  assert.equal(delOther.status, 404, '★ 别人的目录删除也必须 404');

  const patchMine = await http('PATCH', `/api/v1/collections/${mine}`, {
    cookie: teacherCookie,
    body: { name: '改名成功' },
  });
  assert.equal(patchMine.status, 200);
  assert.equal((patchMine.json as { collection?: { name?: string } }).collection?.name, '改名成功');
});

// ═══════════════════════════════════════════════════════════════════════
// ★★ video_count / published / videos_detached（Lead 指定三条）
// ═══════════════════════════════════════════════════════════════════════
test('★★ `video_count` **真实统计**：建目录 → 上传 1 个视频 → === 1', async () => {
  const id = await newCollection('计数目录');
  const up = await uploadVideo(teacherCookie, id);
  assert.equal(up.status, 202, `上传应 202（实际 ${up.status} ${JSON.stringify(up.json)}）`);
  const docId = String(up.json.document_id);
  assert.ok(docId, '必须返回 document_id');

  const one = await http('GET', `/api/v1/collections/${id}`, { cookie: teacherCookie });
  assert.equal(
    (one.json as { collection?: { video_count?: number } }).collection?.video_count,
    1,
    '★ video_count 必须真的是 1（不是 0 占位）',
  );
  // 文档真的挂在这个目录下（不是只改了计数）
  const row = built!.deps.repo.getDocumentRow(docId);
  assert.equal(row?.collection_id, id, '★ documents.collection_id 必须真的写上了');
  assert.equal(row?.kind, 'video', '上传的必须是 video kind');

  // 第二个视频 → 2（★ 直接种行：上传会给该用户排 parse 任务，连传会撞**每用户配额(2)**
  //   → `429 E_QUOTA` —— 那是**配额**不是目录的 bug，不该让计数判据受它影响）
  insertVideoDoc(id, 'lecture2.mp4');
  const two = await http('GET', `/api/v1/collections/${id}`, { cookie: teacherCookie });
  assert.equal(
    (two.json as { collection?: { video_count?: number } }).collection?.video_count,
    2,
    '★ 再传一个必须变 2（真实统计，不是常量）',
  );
});

test('★★ `published` **派生**：改 review_status → 结果真的跟着变（不是"我们算了"）', async () => {
  const id = await newCollection('发布态目录');
  const before1 = await http('GET', `/api/v1/collections/${id}`, { cookie: teacherCookie });
  assert.equal((before1.json as { collection?: { published?: boolean } }).collection?.published, false);
  const pub = await http('PATCH', `/api/v1/collections/${id}`, {
    cookie: teacherCookie,
    body: { review_status: 'published' },
  });
  assert.equal(pub.status, 200);
  assert.equal(
    (pub.json as { collection?: { published?: boolean; review_status?: string } }).collection?.published,
    true,
    '★ 改成 published 后派生字段必须变 true',
  );
  const after = await http('GET', `/api/v1/collections/${id}`, { cookie: teacherCookie });
  assert.equal(
    (after.json as { collection?: { published?: boolean } }).collection?.published,
    true,
    '★ 重新 GET 也必须是 true（不是只在 PATCH 响应里算）',
  );
  const back = await http('PATCH', `/api/v1/collections/${id}`, {
    cookie: teacherCookie,
    body: { review_status: 'draft' },
  });
  assert.equal((back.json as { collection?: { published?: boolean } }).collection?.published, false, '★ 改回 draft 必须变 false');
});

test('★★ `videos_detached`：删目录 → 视频**还在**（只解绑，**不许一起删**，坑 27 家族）', async () => {
  const id = await newCollection('待删目录');
  const docId = insertVideoDoc(id, 'detach.mp4');
  assert.ok(docId.startsWith('doc_'), `必须拿到 doc id（实际 ${docId}）`);
  const del = await http('DELETE', `/api/v1/collections/${id}`, { cookie: teacherCookie });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.equal((del.json as { videos_detached?: number }).videos_detached, 1, '★ 必须如实回报解绑数量');
  assert.equal((del.json as { ok?: boolean }).ok, true);

  const still = await http('GET', `/api/v1/documents/${docId}`, { cookie: teacherCookie });
  assert.equal(
    still.status,
    200,
    `★★ 视频必须**还在**（删目录不等于删视频）；docId=${docId}；DB 行=${JSON.stringify(
      built!.deps.repo.getDocumentRow(docId) ?? null,
    ).slice(0, 200)}`,
  );
  const row = built!.deps.repo.getDocumentRow(docId);
  assert.equal(row?.collection_id, null, '★ 只是 collection_id 变 null');
  const gone = await http('GET', `/api/v1/collections/${id}`, { cookie: teacherCookie });
  assert.equal(gone.status, 404, '目录本身必须没了');
});

test('★ 上传带**不可见**目录 → 404 且**不产生文档**（fail-closed，先校验再落盘）', async () => {
  const mine = await newCollection('别人的私有目录'); // teacher_a 的，且 private+draft
  const before = built!.deps.repo.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM documents')?.n ?? 0;
  const up = await uploadVideo(otherTeacherCookie, mine, 'sneak.mp4');
  assert.equal(up.status, 404, `★ 不可见目录必须 404（实际 ${up.status} ${JSON.stringify(up.json)}）`);
  const after = built!.deps.repo.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM documents')?.n ?? 0;
  assert.equal(after, before, '★★ 校验失败**不许留下文档**（否则是"未授权但已上传"）');
});

// ═══════════════════════════════════════════════════════════════════════
// videos 端点 + 可见性
// ═══════════════════════════════════════════════════════════════════════
test('★ `GET :id/videos`：真返回视频 + `parse_state`/`parse_reason`/`ai_parse`（不假装可用、不编数字）', async () => {
  const id = await newCollection('列表目录');
  const docId = insertVideoDoc(id, 'listed.mp4');
  // ★ 注入"不可用"的可用性（否则 `available` 取决于测试环境的真探测 → **环境相关的假红/假绿**）
  built!.deps.extractAvailability = async () => ({ ok: false, reason: '测试注入：模型不可用' });
  const r = await http('GET', `/api/v1/collections/${id}/videos`, { cookie: teacherCookie });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const videos = (r.json as { videos?: Record<string, unknown>[] }).videos ?? [];
  assert.equal(videos.length, 1, `必须返回 1 个视频（实际 ${videos.length}）`);
  const v = videos[0]!;
  assert.equal(v.id, docId);
  assert.equal(v.collection_id, id);
  assert.ok(['none', 'running', 'done', 'failed'].includes(String(v.parse_state)), `parse_state 形状（实际 ${v.parse_state}）`);
  assert.ok(typeof v.parse_reason === 'string' && v.parse_reason !== '', '必须给 parse_reason（不许空）');
  const ai = v.ai_parse as Record<string, unknown>;
  // ★★ 同源（坑 21）：注入"不可用" → 字段必须**跟着变 false**（不是硬编码）
  assert.equal(ai.available, false, '★ 注入不可用后必须如实 available=false（不假装可用）');
  assert.match(String(ai.reason ?? ''), /测试注入/, '★ 原因必须来自**同一个**可用性来源（同源）');
  assert.equal(ai.estimated_llm_calls, undefined, '★★ **不编数字**：没有 video_parse 实现就不给估算');
  assert.ok(String(ai.cost_note ?? '') !== '', '必须给代价说明（哪怕说明"尚未接入"）');

  // ★ 反向：注入"可用" → 必须真的变 true（证明它来自可用性，而不是写死的 false）
  built!.deps.extractAvailability = async () => ({ ok: true, reason: '' });
  const r2 = await http('GET', `/api/v1/collections/${id}/videos`, { cookie: teacherCookie });
  const ai2 = ((r2.json as { videos?: Record<string, unknown>[] }).videos ?? [])[0]!.ai_parse as Record<string, unknown>;
  assert.equal(ai2.available, true, '★ 注入可用后必须变 true（同源，不是写死 false）');
});

test('★ 可见性：学生的列表里**看不到** draft 目录（scope 过滤走 docScopeSql 同一份实现）', async () => {
  const draftId = await newCollection('未发布目录');
  const stuList = await http('GET', '/api/v1/collections', { cookie: studentCookie });
  assert.equal(stuList.status, 200);
  const ids = ((stuList.json as { collections?: { id: string }[] }).collections ?? []).map((c) => c.id);
  assert.ok(!ids.includes(draftId), '★ 学生不许看到 draft 目录');
  const stuOne = await http('GET', `/api/v1/collections/${draftId}/videos`, { cookie: studentCookie });
  assert.equal(stuOne.status, 404, '★ 不可见目录的视频列表也必须 404（不泄露存在性）');
  // 教师自己看得到
  const tList = await http('GET', '/api/v1/collections', { cookie: teacherCookie });
  const tIds = ((tList.json as { collections?: { id: string }[] }).collections ?? []).map((c) => c.id);
  assert.ok(tIds.includes(draftId), 'owner 必须看得到自己的 draft 目录');
});

test('★ 前置自检：三个账号确实不同人（避免"看起来通过"）', () => {
  assert.notEqual(teacherId, otherTeacherId);
  assert.ok(teacherId.startsWith('usr_') && otherTeacherId.startsWith('usr_'));
  assert.equal(built!.deps.repo.rbac.getUserRowByName('student_c')?.id.startsWith('usr_'), true);
});
