# 数据库与数据仓库 · AI 教学知识平台

把**任意课程资料**（PDF / PPT / Word / Markdown / 视频）编译成
**知识库 + 知识图谱 + 视频文稿**，并挂一个 AI 助教。

> MySQL 手册只是**第一份样例**，不是特例 —— 新增格式**只写 adapter，不改核心**。

**技术栈**：TypeScript + Node（Fastify，后端主体）· Vue 3 + Vite（前端）·
Python 子进程（媒体/文档 worker）· 可插拔模型 Provider（LLM / ASR / TTS / OCR / 翻译）

---

## 1. 快速开始（访问路径）

| 服务 | 地址 | 说明 |
|---|---|---|
| **前端** | **http://localhost:5173** | ★ **必须用 `localhost`**（Vite 只绑 IPv6 `::1`；用 `127.0.0.1` 会连不上） |
| **后端 API** | http://127.0.0.1:8787/api/v1 | Fastify |
| 健康检查 | http://127.0.0.1:8787/api/v1/health | 无需登录 |
| 能力快照 | http://127.0.0.1:8787/api/v1/capabilities | 需登录；★ **冷调用约 30 秒**（真探测各 provider），之后走 5 分钟缓存 |

**页面路由**（前端是 SPA，用 **hash 路由**，共 8 个视图）：

| 路径 | 页面 | 能做什么 |
|---|---|---|
| `http://localhost:5173/` | — | 自动跳转到 `/wiki` |
| `http://localhost:5173/#/login` | 登录 | 三账号登录 |
| `http://localhost:5173/#/wiki` | **Wiki 知识库** | 看卡片、层级树、交叉引用（支持深链 `?doc=..&unit=..&card=..`） |
| `http://localhost:5173/#/graph` | **知识图谱** | 边类型可视化、多跳浏览 |
| `http://localhost:5173/#/docs` | **文档管理** | 上传文档、看解析/抽取状态、**重新解析** |
| `http://localhost:5173/#/video` | **视频课堂** | ★ **新建课程系列目录**、上传视频、AI 解析 |
| `http://localhost:5173/#/chat` | **AI 对话** | 聊天 / Agent 模式、右侧常驻小助手 |
| `http://localhost:5173/#/lab` | **虚拟数据库实验** | ★ 学生写 SQL（内置 SQLite，零部署）· 隔离 + 只读/超时保护 |
| `http://localhost:5173/#/settings` | 设置 | 模型热切换（教师/管理员） |

> 未匹配的路径会**重定向到 `/wiki`**（不会白屏）。

---

## 2. 测试账号（★ **仅用于本机测试环境**）

| 角色 | 用户名 | 密码 | 权限概要 |
|---|---|---|---|
| **教师** | `teacher` | `Teacher2026lab` | 上传资料、建课程目录、发起解析/抽取、切换模型 |
| **学生** | `student` | `Student2026lab` | 只读知识库；可用 AI 答疑；**看不到别人的资料** |
| **管理员** | `admin` | `Admin2026lab` | 全部权限 + 用户/审核管理 |

> ⚠️ **安全提示**
> - 这三个口令是**本机开发/演示用的弱口令**，**不要用于任何对外部署**。
> - 首次管理员由环境变量 `COURSE_KB_BOOTSTRAP_ADMIN=用户名:初始口令` 创建，
>   **仅当库里零用户时生效**（之后重启不会重置口令）。
> - 真实凭据（模型 API Key 等）**只放 `.env`**，`.env` 已 gitignore，**不进仓库**。
> - 对外部署前请：改掉这三个口令、启用 HTTPS、限制 CORS。

---

## 3. 启动方式

### 前置

```powershell
cd "D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\course-kb"

# 依赖（只需一次）
cd apps/server ; npm install
cd ../web     ; npm install
cd ../..      ; python -m pip install -r worker/requirements.txt
```

### 起服务

```powershell
# ① 后端（http://127.0.0.1:8787）
cd apps/server
npm run dev          # node --watch src/index.ts（改代码自动重启）
# 或 npm start       # node src/index.ts（★ 推荐用于验收：不会被"半保存状态"撞崩）

# ② 前端（http://localhost:5173）
cd apps/web
npm run dev          # vite
```

### 环境变量（都有默认值，通常不用设）

| 变量 | 默认 | 说明 |
|---|---|---|
| `COURSE_KB_PORT` | `8787` | 后端端口 |
| `COURSE_KB_HOST` | `127.0.0.1` | 监听地址 |
| `COURSE_KB_ROOT` | 自动向上找 | 项目根 |
| `COURSE_KB_DATA_DIR` | `<root>/data` | 运行期数据目录 |
| `COURSE_KB_DB` | `<data>/course_kb.sqlite3` | SQLite 路径 |
| `COURSE_KB_LOG_DIR` | `<data>/logs` | 落盘日志目录 |
| `COURSE_KB_LOG_LEVEL` | `info` | 日志级别 |
| `COURSE_KB_BOOTSTRAP_ADMIN` | 无 | `用户名:初始口令`（仅零用户时生效） |
| `COURSE_KB_LLM_CONCURRENCY` | `1` | LLM 并发（上限 4；**非法值拒绝启动**） |
| `COURSE_KB_OCR_MAX_PAGES` | `0` | OCR 页数上限，`0` = **不限制** |
| `COURSE_KB_AUTO_EXTRACT_MAX_UNITS` | `100` | 超过则**先问再抽**（不是静默少抽） |
| `COURSE_KB_TASK_STALE_MS` | `1800000` | 任务判死阈值（30 分钟，心跳续命） |

---

## 4. 试用顺序（建议）

```
① Wiki 页 (#/wiki)      → 直接看已有卡片（最快看到成果）
② 图谱页 (#/graph)      → 看知识图谱
③ 视频页 (#/video)      → 新建课程系列目录 + 上传视频
④ 对话页 (#/chat)       → 聊天 / 抽屉小助手（抽屉与整页各用各的会话）
⑤ 实验页 (#/lab)        → 学生写 SQL（内置 SQLite，零部署）
⑥ 文档页 (#/docs)       → 上传小文档 → 解析 → 抽取（会先显示代价）
⑦ 大扫描件             → 434 页教材可完整跑（云端 OCR 约 9 分钟，不再截断）
```

**★ 关于"花费"**：所有会花钱的操作都会**先显示代价**（估时 + 费用区间 + 调用次数），
**不会无声消费**。抽取超过阈值时会**停下来问**。

---

## 5. 当前能力状态（本机实测）

| 能力 | 状态 |
|---|---|
| 文档解析（PDF/PPTX/DOCX/MD/TXT） | ✅ 含扫描件 OCR |
| **OCR** | ✅ 走 **OpenRouter**（国产 `qwen/qwen3-vl-235b` 主 / `30b` 备）；★ **不使用本地模型** |
| 卡片抽取 | ✅ 含**结构化输出降级链**（strict → lenient → 如实报错） |
| 知识图谱 / 交叉引用 | ✅ 12 种边类型 · 23 种卡片 · 12 种实体 |
| 中文检索 | ✅ 自建 bigram FTS5（默认 tokenizer 对中文 0 命中） |
| **AI 对话 / 答疑** | ✅ chat / agent 双模式 · 知识库只读工具 · **每个页面都有小助手** |
| **视频 ASR** | ✅ 走 **OpenRouter**（`voxtral-small`，**$0.00612/分钟**）；★ **不使用本地模型** |
| **虚拟数据库沙箱** | ✅ SQLite 内置（零部署）· MySQL/PostgreSQL/openGauss **未接入** |
| **课程系列目录** | ✅ 教师建目录 + 上传视频 · 学生只读 |
| **会话命名** | ✅ 手动重命名 + AI 起名（★ **AI 绝不覆盖你手动设的名字**） |
| 落盘日志 | ✅ `data/logs/app-YYYY-MM-DD.log`（按天 + 大小轮转 + 脱敏） |
| 任务看门狗 | ✅ 运行期周期扫描（worker 卡死会判死并放行队列） |

---

## 6. 已知限制（如实列出）

- **未做 HTTPS/TLS、备份恢复、系统服务化（systemd）、CI** —— 仅适合本机/内网演示。
- **沙箱只支持 SQLite**：MySQL / PostgreSQL / openGauss 的 adapter **未接入**（无 Docker 环境）。
- **`/capabilities` 冷调用约 30 秒**（真探测所有 provider）；之后 5 分钟缓存。
- **ASR 是块级时间戳**（约 30 秒/块），**不是词级** —— 接口里如实标注，不谎报。
- **`notes.card_id` / `notes.unit_id` 无外键**：单元/卡片被替换后旧笔记可能悬空引用。
- **`progress.detail` 在运行期查 REST 拿不到**（只在任务结束时写入；SSE 帧里有 `done/total`）。
- **每用户并发任务配额 = 2**：连传第 3 个视频会 `429 E_QUOTA`（有意保护，非缺陷）。
- **测试与开发共用一个库**：`COURSE_KB_DB` 在部分测试路径下**不生效**，测试可能写进开发库。

---

## 7. 目录结构

```
course-kb/
├─ AGENTS.md              ★ 开工必读（写域规则 + 坑清单 37 条，每条都有实测证据）
├─ docs/                  ★ 契约（架构 / 接口 / Provider / 检索 / RBAC / 沙箱 …）
├─ contracts/             ★ 共享契约（TS 类型 + JSON Schema，封闭枚举）
├─ config/
│   ├─ providers.yaml     模型 Provider 配置（★ 凭据只写 ${占位}，真值在 .env）
│   └─ settings.json      运行期设置（可热切换模型）
├─ apps/
│   ├─ server/            TypeScript 后端（Fastify + better-sqlite3 + pi SDK）
│   └─ web/               Vue 3 前端（Vite）
├─ worker/                Python worker（PDF/PPTX/DOCX 解析 · ASR · 分块）
├─ tools/                 运维/验收脚本（含密钥扫描 precommit_secret_scan.py）
└─ data/                  运行期（SQLite · 上传件 · 日志 · 验收证据）★ 已 gitignore
```

---

## 8. 测试与验收

```powershell
# 后端（约 800 条，含真启动路径）
cd apps/server ; npm test

# 前端
cd apps/web ; npm test          # 单测 + DOM 断言（headless Chrome）

# Python worker
python -m pytest worker/tests -q

# 类型检查
cd apps/server ; npx tsc --noEmit

# ★ 提交前密钥扫描（必须 exit 0）
python tools/precommit_secret_scan.py
```

**验收脚本**（`tools/`，零 LLM）：
- `_lead_acceptance.py` —— 端到端 31 条判据（health / 三账号 / 目录 / 对照组 / 会话命名 / 并发 / OCR / 卡片 / 看门狗）
- `verify_system.py` · `verify_cn_search.py` —— 系统与中文检索核对

---

## 9. 文档索引

| 文档 | 内容 |
|---|---|
| `AGENTS.md` | ★ 开工必读：写域规则 + **37 条坑清单**（每条都有实测证据） |
| `docs/ARCHITECTURE_V2.md` | 架构（TS 主体 + Python worker + Provider）与迁移决策 |
| `docs/API_PROTOCOL.md` | REST + SSE 接口契约 |
| `docs/PROVIDERS.md` | LLM / ASR / TTS / OCR / 翻译 provider 设计 |
| `docs/RETRIEVAL.md` | 检索层（none / wiki / kg / rag 四模式） |
| `docs/RBAC.md` | 权限模型 |
| `docs/SETTINGS_AND_SANDBOX.md` | 设置热切换 + 虚拟数据库沙箱 |
| `docs/SESSION_NAMING.md` | 会话命名契约（★ AI 不许覆盖用户命名） |
| `docs/DESIGN_SYSTEM.md` | 视觉规范（纸白 + 朱红） |
| `docs/VERIFICATION.md` | 验收工作流与判据 |

---

## 10. 一条贯穿全项目的判据

> **如果一个 bug 的表现是"看起来成功"，它比崩溃危险得多。**

本项目的坑清单里，多数条目属于这一类：
空卡片被当成成功、假绿的能力探测、自述字段与实际生效值不同源、
配置写了但从不被读（死旋钮）、测试绿在错误的一侧……

**因此所有"能力/状态/代价"上报都要求同源** ——
**实际值才是真相，自述字段只是标签。**
