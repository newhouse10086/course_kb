# 角色权限设计（RBAC + 课程边界）

> 用户裁决：**本地账号体系**（argon2 + httpOnly cookie session）+ **立刻开发**
> 版本 v1.0 ｜ 2026-10-15

---

## 0. 现状（诚实起点）

**当前完全没有权限体系**：无 `users`/`roles` 表、无认证中间件、契约无「认证」章节、服务绑 `127.0.0.1`（单用户本机工具假设）。
本文档是**新增**设计，不是对已有实现的描述。

---

## 1. 角色

| 角色 | 代号 | 能力 |
|---|---|---|
| 管理员 | `admin` | 全部 + 用户管理 + **provider 凭据配置** |
| 教师 | `teacher` | 上传资料、触发抽取、**审核/编辑 Wiki 与图谱**、发布课程、看班级学情 |
| 学生 | `student` | 看**已发布**内容、看视频、问 AI 助教、做笔记（**只有自己的**） |
| 访客 | `guest` | 只读 `public` 内容 |

**角色存储**：`user_roles(user_id, role)` 多对多（一人可既是教师又是管理员）。

---

## 2. ★ 核心设计：抽取产物是「草稿」，教师审核后才发布

**这是本项目独有的要求**：我们的诚实原则是「**模型输出不算事实**」。
LLM 抽出来的卡片**直接给学生看是不负责任的**。

```
draft ──(教师审核)──> reviewed ──(教师发布)──> published
  │                                              │
  └── 仅教师可见                                  └── 学生可见
```

**实现**：`documents.review_status`（`draft`/`reviewed`/`published`）。
**所有面向学生的查询必须带 `review_status='published'`** —— 在 **repo 层**强制，不靠路由记得加。

---

## 3. 表结构（新增）

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,          -- argon2id
  status TEXT NOT NULL DEFAULT 'active',-- active | disabled
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                   -- admin | teacher | student
  PRIMARY KEY (user_id, role)
);

CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  term TEXT DEFAULT '',                 -- 学期
  owner_id TEXT REFERENCES users(id),   -- 任课教师
  created_at INTEGER NOT NULL
);

CREATE TABLE course_members (
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                   -- teacher | student
  PRIMARY KEY (course_id, user_id)
);

CREATE TABLE sessions (                 -- httpOnly cookie 会话
  id TEXT PRIMARY KEY,                  -- 随机 token 的哈希
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  user_agent TEXT DEFAULT ''
);

CREATE TABLE notes (                    -- 学生笔记，**按 user 隔离**
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT, unit_id TEXT, doc_id TEXT,
  body TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE conversations (            -- AI 助教会话，**按 user 隔离**
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_id TEXT, title TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_log (                -- 教学场景必须留痕
  id TEXT PRIMARY KEY,
  user_id TEXT, action TEXT NOT NULL,   -- login | upload | extract | review | publish | chat
  target TEXT DEFAULT '', detail_json TEXT DEFAULT '{}',
  at INTEGER NOT NULL
);

-- 既有表加列
ALTER TABLE documents ADD COLUMN owner_id TEXT REFERENCES users(id);
ALTER TABLE documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'; -- private|course|public
ALTER TABLE documents ADD COLUMN review_status TEXT NOT NULL DEFAULT 'draft';-- draft|reviewed|published
ALTER TABLE documents ADD COLUMN course_id TEXT REFERENCES courses(id);
```

---

## 4. 权限判定顺序（**固定顺序，不许各处自己判断**）

```
requirePerm(action, resource):
  1. 无会话           → 401 E_UNAUTHENTICATED
  2. 账号被禁用        → 403 E_ACCOUNT_DISABLED
  3. admin            → 放行
  4. 资源 owner        → 放行（owner 对自己的文档，除"发布"外全权）
  5. 课程成员          → 按 course_members.role 判
  6. 资源 visibility=public 且 review_status=published → 只读放行
  7. 否则              → 403 E_FORBIDDEN
```

**统一入口**：`apps/server/src/auth/permissions.ts` 导出
`can(user, action, resource): { ok: boolean; reason?: string }` —— **单一实现**，
路由只调它，**不自己写 if**。

---

## 5. ★ 本项目特有约束：LLM 并发 = 1 是**全局**的

用户硬要求「并发跑推理不合适」→ 所有用户的 LLM 任务**共用一条队列**。

**不处理的后果**：一个学生连问 20 个问题 → 队列占满 → **教师上传的抽取永远排不上**。

**必须做**：
1. `tasks` 表加 `priority`（`0=教师/系统` / `1=学生`）与 `user_id`
2. 队列按 **priority 优先**，同级 FIFO
3. 每用户**并发配额**（如学生同时最多 1 个 LLM 任务，教师 2 个）
4. 超配额 → `429 E_QUOTA` + 可读 hint（别静默排队到天荒地老）

---

## 6. 隔离必须在 **SQL 层**，不能只在路由层

**反例**（危险）：路由判了权限，但 repo 查询忘了 `where user_id=?` → 一个接口就能读到别人的笔记。

**要求**：
- `notes` / `conversations` 的 **repo 方法签名强制带 `userId`**（TS 类型层面就要求，不传编译不过）
- 面向学生的 `documents` 查询**必须**带 `review_status='published'`（在 repo 层拼进 SQL，不靠调用方）
- **测试必须包含跨用户访问的负例**（A 用户读 B 用户的笔记 → 404/403）

---

## 7. 认证

- **argon2id** 哈希（`argon2` npm 包）
- **httpOnly + SameSite=Lax + Secure（生产）** cookie，值 = 随机 token；库内存**哈希**
- 登录失败**统一文案**（不区分"用户不存在/密码错"），加**失败计数限流**
- `POST /api/v1/auth/login` `/logout` `/me`；`POST /api/v1/auth/password`
- **首个 admin 的引导**：环境变量 `COURSE_KB_BOOTSTRAP_ADMIN=用户名:初始密码`（只在无任何用户时生效），
  或 CLI `npm run create-admin` —— **不要**硬编码默认密码

---

## 8. 接口改动（新增）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/auth/login` | `{username,password}` → set-cookie |
| POST | `/api/v1/auth/logout` | 清 cookie |
| GET | `/api/v1/auth/me` | 当前用户 + 角色 + 课程 |
| GET/POST | `/api/v1/users` | admin only |
| GET/POST | `/api/v1/courses` | teacher/admin |
| POST | `/api/v1/courses/:id/members` | teacher/admin |
| POST | `/api/v1/documents/:id/review` | teacher：改 `review_status` |
| GET/POST | `/api/v1/notes` | 本人 only |
| GET | `/api/v1/audit` | admin/teacher |

**`/capabilities` 加一段**：`auth: { required: true, bootstrap: "已初始化|未初始化" }` —— UI 据此决定要不要显示登录页。

---

## 9. 验收

- [ ] 未登录访问受保护接口 → **401**（不是 500，也不是空数据）
- [ ] 学生访问 `draft` 文档 → **403/404**（**不是返回空列表冒充成功**）
- [ ] **学生看不到未发布内容**（repo 层强制，且**有负例测试**）
- [ ] A 用户读不到 B 用户的笔记/会话（**负例测试**）
- [ ] 教师能审核/发布；发布后学生可见
- [ ] `priority`: 学生任务不能饿死教师任务（**有测试**）
- [ ] 凭据不落日志、cookie 为 httpOnly
- [ ] 登录失败限流生效
- [ ] 现有 **218 个测试仍全绿**（不能因为加鉴权把老接口打进 401 —— 测试要带身份）
