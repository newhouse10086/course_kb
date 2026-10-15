# 系统设置 · 模型热切换 · 学生虚拟数据库

> 用户 2026-10-15 新增需求。**核查结论：这三样此前都没做**（实测 `settings.json` 不存在、无热切换代码、无 SQL 沙箱）。
> 版本 v1.0

---

## 0. 新 LLM 端点（已配置并实测）

`course-kb/.env`：
```
AMR_BASE=https://llm-api.x-aio.com/v1
AMR_KEY=sk-REPLACE_ME
LLM_MODEL=deepseek-v4.1-flash
```
**实测**：可用，3.8s。**该端点只有 8 个 LLM**：
`deepseek-v4-flash-0731 · deepseek-v4.1-flash · glm-5.2 · glm-5.3 · glm-5.3-flash · kimi-k2.7-code · kimi-k3 · minimax-m3`
→ **无 ASR / TTS / OCR / embedding**（那些要另配 provider）。

### ⚠️ 重要：这是**推理模型**，推理 token 计入输出预算
实测一个 8 字回复用了 **54 个 reasoning token**，输出在 `reasoning_content`。
我第一次用 `max_tokens=20` → **20 个 token 全被推理吃掉 → `content` 为空**（看起来像"模型没答"）。
**后果**：`max_tokens` 必须**包含推理预算**，否则会静默拿到空内容。
结合 `polysemy-prober` 的发现（服务端**不遵守** `max_tokens`、截断不触发 `finish_reason=length`）：
→ **抽取管线的 `max_tokens` 要显著调高**，并对"`content` 为空但 `reasoning_content` 非空"**显式报错**，不许当成功。

---

## 1. `settings.json` —— 运维可在文件系统改的 AI 配置

**位置**：`course-kb/config/settings.json`（与 `providers.yaml` 并存）
**分工**：
- `settings.json` → **运行期可改**（模型选择、策略、配额、开关）—— 教师/运维改
- `providers.yaml` → **部署期**（provider 清单与凭据引用）—— 运维改
- `.env` → **只放凭据**（永不进 settings.json）

```jsonc
{
  "$schema": "./settings.schema.json",
  "version": 1,
  "llm": {
    "active": "deepseek-v4.1-flash",       // ★ 当前生效模型（热切换改这个）
    "fallbacks": ["glm-5.3", "kimi-k3"],
    "temperature": 0,
    "maxTokens": 16384,                    // ★ 必须含推理预算（实测 8 字用 54 推理 token）
    "structured": { "jsonSchemaStrict": true },
    "concurrency": 1                       // ★ 用户硬要求，**不允许**通过设置调高
  },
  "asr": { "active": "local-fw", "model": "tiny", "fallbacks": ["aliyun-asr"] },
  "tts": { "active": null },
  "translate": { "active": "llm-mt", "glossaryMode": "inject", "keepIdentifiers": true },
  "sandbox": {
    "enabled": true, "engine": "sqlite",
    "limits": { "maxRows": 200, "timeoutMs": 3000, "maxDbBytes": 20971520 },
    "allowWrites": true, "resetPolicy": "per_session"
  },
  "quota": { "student": { "concurrentLlmTasks": 1, "dailyLlmCalls": 200 },
             "teacher": { "concurrentLlmTasks": 2, "dailyLlmCalls": 2000 } },
  "hotReload": { "watch": true, "debounceMs": 500 }
}
```

**要求**：
- **`concurrency` 不可被配置改成 >1**（用户硬要求）—— 代码层面忽略该字段的调高
- 启动时**校验**（zod 或手写），非法配置**拒绝启动并给可读原因**，不要静默用默认值
- 文件**缺失**→ 用内置默认并**如实上报** `settings.source="default"`
- `GET /api/v1/settings` 只读（**脱敏**，不回显凭据）；`PUT` 仅 admin
- **绝不把凭据写进 settings.json**

---

## 2. 模型热切换（教师后台设置页）

### 状态机（用户明确要求）
```
[空闲] ──切换──> 立即生效
[批量推理运行中] ──切换──> 拒绝直接热切
       │
       ├─ 提示："导出进度并终止当前推理？"（候选：终止 / 取消）
       └─ 终止 → 保存断点(checkpoint) → 加载新 provider → **从断点续推**
```

**实现要点**：
1. `POST /api/v1/settings/llm/switch` `{model, mode}`：
   - `mode:"now"` → 仅当**无运行中的 LLM 任务**时允许
   - `mode:"drain"` → 停止领取新任务，等当前单元跑完再切（**推荐默认**）
   - `mode:"abort"` → **保存断点 + 终止 + 切换 + 续推**（用户描述的路径）
2. **断点必须可续**：`extract` 的 `checkpoint_file` 已就绪（backend-core 交付），
   `rollup` 也要落盘。切换后 `resume` 从已完成单元之后继续，**不重复计费**
3. **切换要可观测**：`/capabilities` 与任务 detail 报 `activeModel` / `switchedAt` / `switchedFrom`
4. **切换后要做健康探测**（真发一次最小请求）—— 新模型不通就**回滚到旧的**并如实报错，别把系统留在"配了个坏模型"的状态
5. 审计：`audit_log` 记 `action="model_switch"`，含 from/to/who

### 前端「模型设置」页（教师/admin）
- 模型下拉（来自 `/api/v1/models`，即 provider 的可用模型列表）
- **运行中时按钮变为"终止并切换"** + 显示当前进度（`done/total`）
- 切换后显示断点续推状态
- 每个模型显示 `available` + 延迟（真探测结果）
- **开关/保存要二次确认**（误切会中断全班长任务）

---

## 3. ★ 学生虚拟数据库（**此前完全未实现**）

### 目标
学生在浏览器里**直接练 SQL**，并且 **AI 助教能看懂他写的 SQL 和报错**来答疑。

### 引擎选择
| 方案 | 优点 | 缺点 |
|---|---|---|
| **SQLite（选它）** | 零依赖、已在项目里（better-sqlite3）、**进程内快** | 语法与 MySQL 有差异 |
| MySQL 容器 | 与课程一致 | 需 Docker（**本机没有**）→ 不可用 |
| PGlite（WASM PG） | 浏览器内跑 | 语法是 PG，且体积大 |

→ **SQLite 为主**，并在 UI 上**明确标注方言差异**（诚实：不要让学生以为 SQLite 语法等同 MySQL）。
可选：SQL 文本做**方言提示**（如 `AUTO_INCREMENT` 在 SQLite 是 `AUTOINCREMENT`）。

### ★ 安全（这是最危险的部分，必须做对）
学生在浏览器执行**任意 SQL** → 这是**代码执行面**。

**硬要求**：
1. **每个学生独立库文件**（`data/sandbox/{userId}/{sessionId}.sqlite3`）——**绝不共用一个库**
2. **只读挂载？不行** —— 学生要建表插入。但必须：
   - **禁止 `ATTACH`**（否则能读写别的库文件）
   - **禁止 `PRAGMA` 白名单外的一切**（如 `writable_schema`、`temp_store_directory`）
   - **SQLite 的 `sqlite_master` 可控，但 `load_extension` 必须关**（`enable_load_extension(false)`）
   - **禁止多语句拼接**（防注入式逃逸）：只允许**单条语句**（或显式分隔且逐条校验）
   - **只允许 `SELECT/INSERT/UPDATE/DELETE/CREATE/DROP/ALTER` 于沙箱库**
3. **资源限制**（SQLite 没有真正的语句超时）：
   - `better-sqlite3` 是**同步**的 → **长查询会阻塞 Node 事件循环**
   - → **必须在 worker 进程（Python）或 `Worker` 线程里执行**，并**硬超时杀进程**
   - `maxRows` 限制返回行数（`LIMIT` 包一层或流式截断）
   - 库文件大小上限（超出拒绝写入）
4. **`resetPolicy`**：每次会话/每次练习重置，避免学生把库搞坏影响下次

### 接口
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/sandbox/session` | 建/取学生沙箱会话 → `{sessionId, schema}` |
| POST | `/api/v1/sandbox/execute` | `{sessionId, sql}` → `{columns, rows, rowCount, elapsedMs, error?}` |
| POST | `/api/v1/sandbox/reset` | 重置到初始 schema |
| GET | `/api/v1/sandbox/datasets` | 可选数据集（课程预设，如"学生-课程-成绩"表） |
| POST | `/api/v1/sandbox/ask` | ★ **把 SQL + 报错交给 AI 助教答疑** |

**预置数据集**：数据库课程需要经典 schema —— `students / courses / enrollments(sc,grade)`（就是课程里的样例）、
`employees(id,name,mgr_id,salary)`（自连接/递归）、`orders/order_items`（聚合/窗口）。
**每个数据集带 CREATE + INSERT 脚本**，学生可 `reset` 回到初始态。

### ★ AI 助教答疑的接入（用户明确要求"接入的 agent 助手分析答疑"）
```
POST /api/v1/sandbox/ask
{ sessionId, sql, error?, question? }
→ 组装上下文：{ 学生 SQL, 报错信息, 沙箱 schema, 最近 N 条执行的 SQL, 课程知识图谱检索结果 }
→ pi agent（复用 src/agent/）+ 知识库检索（复用 /search）
→ 流式返回（SSE）
```
**关键设计**：
- **不要把答案直接给学生**（教学无效）→ 提示词要求**先问后引**：先指出错在哪一类问题，再给**提示**而非完整答案
- **必须引用知识库**（`[[card:crd_xxx]]`）—— 与本项目"可核查"原则一致，且能跳到原文
- **能看见学生的报错**是核心价值（学生最常卡在"看不懂报错"）

### 3.9 ⚠️ ★ **已知安全缺口：server 引擎（MySQL/PG）缺少第二道防线**（**未验证，如实披露**）

**这是独立验收（静态核查）发现的真实缺口，不是推测**：

```
guard.py:6-7     "这是**第一道**闸（第二道在 SQLite 的 `set_authorizer`，见 runner.py）"
                 → ★ **`set_authorizer` 是 SQLite 专属**，MySQL/PG 上没有等价物
guard.py:43-50   词法闸覆盖：LOAD DATA / INTO OUTFILE / INTO DUMPFILE / COPY / PROGRAM /
                 PG_READ_FILE / PG_LS_DIR / LO_IMPORT / DBLINK …
engine.py:46-49  TRANSACTIONS_SERVER = { same_call: True, cross_call: False }   ← 与 sqlite 同一套假设
```

**缺口的确切含义**：
> 本项目对 SQLite 做了**两道防线** —— 词法闸（给人看得懂的原因）+ **`set_authorizer`（漏网也执行不了）**。
> **而 MySQL/PG 只有第一道。** 即：**词法闸被绕过时，server 引擎上没有任何兜底。**
>
> §3 的红线（禁 `LOAD DATA LOCAL INFILE` / `COPY FROM PROGRAM` / `INTO OUTFILE` / `pg_read_file`）
> **目前只在 SQLite 上被真正验证过** —— server 引擎上它们是"**只靠正则挡**"的状态。

**风险等级：高**（若某天部署了 MySQL/PG 并启用，学生的"危险语句"防护会**只剩一层**）
**但当前不可利用**：本机未装 MySQL/PG/openGauss（`available:false`），**引擎根本起不来**。

**本机为什么验不了**：`docker` ❌ · `mysql` 客户端 ❌ · `psql` 客户端 ❌ —— **三者全无**。

**在装了 DB 的机器上怎么验**（零 LLM 额度）：
```bash
# 1. 装并启用引擎
LAB_MYSQL_PASSWORD='…' bash scripts/deploy-lab-db.sh mysql -y
# 2. 只打 /sandbox/execute，不需要 LLM
curl -X POST .../sandbox/execute -d '{"engine":"mysql","sql":"LOAD DATA LOCAL INFILE ..."}'
#    期望：E_SQL_FORBIDDEN（词法闸生效）
# 3. ★ 关键：验证"绕过词法闸"时的行为（这才是缺口所在）
#    用拼接/大小写/注释等手段构造词法闸漏网的语句 → 观察是否真的执行
#    SQLite 上这一步会被 set_authorizer 拦住；MySQL/PG 上**预期拦不住**
```

**建议的处置（二选一，需产品决策）**：
- **(a) 补第二道防线**：MySQL 用只读账号 + `secure_file_priv=''` + 禁 `FILE` 权限；
  PG 用受限角色（无 `pg_read_server_files` / 无 superuser）+ `SECURITY DEFINER` 审查
- **(b) 默认禁用 server 引擎**，直到第二道防线到位（当前它们本来就是 `available:false`，**等于已经在 (b)**）

★ **诚实原则**：本缺口**已披露在文档里**，且 `/capabilities` 对 server 引擎如实报 `available:false` ——
**没有"假装安全"**。但**运维若自行启用 MySQL/PG，必须知道第二道防线是空的**。

---

## 4. 交付拆分

| # | 交付 | 写域 |
|---|---|---|
| **S1** | `settings.json` + 加载/校验/热重载 + `GET/PUT /api/v1/settings` | `apps/server/src/{settings,config}*` |
| **S2** | 模型热切换（3 种 mode + 断点续推 + 回滚 + 审计） | `apps/server/src/{settings,tasks,routes}*` |
| **S3** | 虚拟数据库沙箱（隔离/限额/数据集 + `/sandbox/*`） | `apps/server/src/sandbox/**` + `worker/sandbox/**` |
| **S4** | AI 答疑（sandbox ask，接 pi + 知识库检索） | `apps/server/src/sandbox/ask.ts` + `src/agent/**` 协作 |
| **S5** | 前端：模型设置页 + SQL 练习台 + 答疑面板 | `apps/web/**` |

## 5. 验收
- [ ] `settings.json` 改了**不用重启**即生效（`watch`）；非法配置**拒绝并给可读原因**
- [ ] **`concurrency` 无法被配置调高**（传 8 仍为 1，有测试）
- [ ] 热切换：空闲时立即生效；**运行中必须走"终止→切换→续推"**且**断点不丢**
- [ ] 切换后新模型不通 → **回滚**并如实报错
- [ ] `max_tokens` 含推理预算；**`content` 空但 `reasoning_content` 非空 → 显式报错**（不许当成功）
- [ ] 沙箱：**两学生库互相隔离**（负例测试）；`ATTACH`/`load_extension`/多语句**被拒**
- [ ] 沙箱：**长查询不阻塞服务**（真跑一个 `WITH RECURSIVE` 死循环 → 超时被杀，`/health` 仍 200）
- [ ] 答疑：**引用知识库卡片**且可跳转原文
- [ ] 现有 **218 测试仍全绿**；`tsc --noEmit` exit 0
