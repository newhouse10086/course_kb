# 实验数据库引擎：抽象接口 + 部署接入指南

> 用户要求：**默认用 SQLite**（零部署、可增删查改、能立刻做实验）；
> **不要**默认 MySQL 这种不能一键部署的；但**留好接口**，
> 并写清「**在空白的 Ubuntu/CentOS 上快速部署 MySQL / openGauss / PostgreSQL，运行并接入，然后供用户选择**」。
> 版本 v1.0 ｜ 2026-10-15

---

## 1. 设计原则

| 原则 | 说明 |
|---|---|
| **默认零部署** | 开箱即用 = **SQLite**。学生打开就能建表、插数、查询、改删 —— **完整 CRUD**，不是只读演示 |
| **引擎可插拔** | 通过 **`DatabaseEngine` 接口**抽象；换引擎 = 加一个 adapter + 一条配置，**不改上层** |
| **能力如实上报** | 每个引擎报 `available` / `reason` / `dialect` —— **不可用就禁用入口并说明**（与本项目一贯原则一致） |
| **方言诚实** | SQLite 与 MySQL/PG 语法有差异 → **UI 必须标注当前方言**，并给常见差异提示 |

---

## 2. `DatabaseEngine` 接口（★ 唯一契约）

```ts
export interface EngineInfo {
  id: string;                    // 'sqlite' | 'mysql' | 'postgres' | 'opengauss'
  label: string;                 // 'SQLite（内置，零部署）'
  dialect: string;               // 'sqlite' | 'mysql' | 'postgres'
  runtime: 'embedded' | 'server';
  available: boolean;            // ★ 真探测结果，不是"配置了就算"
  reason?: string;               // 不可用时**必须**给可读原因
  capabilities: {
    crud: true;                  // 增删查改
    ddl: boolean;                // 建表/改表
    transactions: boolean;
    procedures: boolean;         // 存储过程（PG/MySQL 有，SQLite 无）
    maxRowsDefault: number;
  };
  /** 连接信息（**脱敏**，不含密码） */
  target: { host?: string; port?: number; database?: string };
}

export interface ExecRequest {
  sessionId: string;
  sql: string;
  maxRows?: number;
  timeoutMs?: number;
}
export interface ExecResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;              // 受影响/返回行数
  elapsedMs: number;
  /** DDL/DML 的受影响行数（INSERT/UPDATE/DELETE） */
  affected?: number;
  error?: { code: string; message: string; position?: number };
}

export interface DatabaseEngine {
  info: EngineInfo;
  /** 真探测：SQLite 试开库；服务器类引擎真连一次 */
  healthCheck(): Promise<{ ok: boolean; reason?: string }>;
  /** ★ 一个学生一个逻辑沙箱；服务器类引擎映射到独立 database/schema */
  ensureSession(userId: string, sessionId: string, datasetId?: string): Promise<void>;
  exec(req: ExecRequest): Promise<ExecResult>;
  resetSession(userId: string, sessionId: string): Promise<void>;
  listDatasets(): Promise<DatasetInfo[]>;
  dispose(): Promise<void>;
}
```

**注册表**：`apps/server/src/sandbox/engines/registry.ts`
```ts
register(new SqliteEngine(cfg));      // 默认，永远可用
// 以下按配置启用（未配置 → 不进注册表 → /capabilities 不列它）
if (cfg.mysql?.enabled)     register(new MysqlEngine(cfg.mysql));
if (cfg.postgres?.enabled)  register(new PostgresEngine(cfg.postgres));
if (cfg.opengauss?.enabled) register(new OpenGaussEngine(cfg.opengauss));
```
**选择策略**：学生选引擎 → `PUT /api/v1/sandbox/session` `{engine}`；
未选 → 用 `settings.json` 的 `sandbox.defaultEngine`（默认 `sqlite`）。

**⚠️ 服务器类引擎的隔离**：
- **不复用 root**，为每个学生建**独立 database**（`lab_u_<uid>_<sid>`）+ 独立账号（最小权限）
- 或退一步：共享实例 + 独立 schema + 账号只能访问自己 schema
- **绝不**让学生共用同一个 database

---

## 3. 配置（`config/settings.json` 片段）

```jsonc
"sandbox": {
  "enabled": true,
  "defaultEngine": "sqlite",          // ★ 默认零部署
  "limits": { "maxRows": 200, "timeoutMs": 3000 },
  "allowWrites": true,                // ★ 允许增删查改（实验需要）
  "engines": {
    "sqlite":   { "enabled": true, "dir": "data/sandbox" },
    "mysql":    { "enabled": false, "host": "127.0.0.1", "port": 3306,
                  "adminUser": "root", "passwordEnv": "LAB_MYSQL_PASSWORD",
                  "dialectHint": true },
    "postgres": { "enabled": false, "host": "127.0.0.1", "port": 5432,
                  "adminUser": "postgres", "passwordEnv": "LAB_PG_PASSWORD" },
    "opengauss":{ "enabled": false, "host": "127.0.0.1", "port": 5432,
                  "adminUser": "gaussdb", "passwordEnv": "LAB_OG_PASSWORD" }
  }
}
```
**密码只从环境变量**（`passwordEnv` 指向变量名）—— **绝不写进 settings.json**。

---

## 4. 部署指南（空白 Ubuntu / CentOS）

> 目标：**一条命令级**把引擎跑起来，然后在 `settings.json` 里 `enabled: true` 即可被系统发现。

### 4.1 SQLite —— **无需部署**（默认引擎）
无需安装，系统内置。学生开箱即用，**支持完整 CRUD**。
局限（UI 需标注）：无存储过程、无用户/权限体系、类型系统宽松、`AUTOINCREMENT` ≠ `AUTO_INCREMENT`。

---

### 4.2 PostgreSQL 17（Ubuntu 22.04/24.04）

```bash
# ── 安装（官方 PGDG 源）──
sudo apt update && sudo apt install -y curl ca-certificates
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
  https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt update && sudo apt install -y postgresql-17

# ── 启动 + 开机自启 ──
sudo systemctl enable --now postgresql
sudo systemctl status postgresql --no-pager

# ── 建实验用管理员（**不要用 postgres 超级用户直连**）──
sudo -u postgres psql -c "CREATE ROLE labadmin LOGIN PASSWORD '改我' CREATEDB;"

# ── 允许本机 TCP 密码登录 ──
#   /etc/postgresql/17/main/pg_hba.conf 加：
#     host  all  labadmin  127.0.0.1/32  scram-sha-256
sudo sed -i '1i host all labadmin 127.0.0.1/32 scram-sha-256' \
  /etc/postgresql/17/main/pg_hba.conf
sudo -u postgres psql -c "ALTER SYSTEM SET listen_addresses='127.0.0.1';"
sudo systemctl restart postgresql

# ── 验证 ──
PGPASSWORD='改我' psql -h 127.0.0.1 -U labadmin -d postgres -c 'select version();'
```
**CentOS/Rocky 9**：`sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm && sudo dnf -qy module disable postgresql && sudo dnf install -y postgresql17-server && sudo /usr/pgsql-17/bin/postgresql-17-setup initdb && sudo systemctl enable --now postgresql-17`

---

### 4.3 MySQL 8.4 LTS（Ubuntu）

```bash
# ── 安装 ──
sudo apt update && sudo apt install -y mysql-server
sudo systemctl enable --now mysql
sudo systemctl status mysql --no-pager

# ── 安全初始化（**非交互，供脚本化**）──
sudo mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH caching_sha2_password BY '改我';"
sudo mysql -e "CREATE USER 'labadmin'@'127.0.0.1' IDENTIFIED BY '改我';"
sudo mysql -e "GRANT CREATE, DROP ON *.* TO 'labadmin'@'127.0.0.1';"
# 注意：给学生用的账号**不给 SUPER/FILE**，且只授自己能建的库

# ── 验证 ──
mysql -h 127.0.0.1 -u labadmin -p -e 'select version();'
```
**CentOS/Rocky 9**：`sudo dnf install -y mysql-server && sudo systemctl enable --now mysqld`
⚠️ **Oracle 版 vs MariaDB**：CentOS 的 `mysql-server` 可能是 MariaDB —— 语法基本兼容但**版本号与特性不同**，UI 的方言提示要按实际探测结果报。

---

### 4.4 openGauss 6.0（openEuler / CentOS）

⚠️ **现实提醒**：openGauss 官方**主推 openEuler**，在 Ubuntu 上**没有官方包**（需自行编译，不推荐）。
CentOS/Rocky 上可跑但依赖较多。**建议在 openEuler 容器/虚拟机上部署**。

```bash
# ── 前置（CentOS/Rocky 9 / openEuler 22.03）──
sudo dnf install -y libaio-devel readline-devel zlib-devel openssl-devel \
  bzip2 flex bison ncurses-devel glibc-devel pam-devel libffi-devel python3-devel

# ── 下载企业版/社区版安装包（需在 openGauss 官网获取，非 apt/dnf 源）──
#   https://opengauss.org/zh/download/   选 openEuler/CentOS x86_64 的极简版
tar -zxf openGauss-*-CentOS-64bit.tar.gz
# ── 以非 root 用户安装 ──
sudo useradd -m omm && sudo passwd omm
sudo -iu omm
cd /home/omm && ./install.sh -w '改我'    # 交互式，或用 -f 配置文件静默安装

# ── 启动 ──
gs_om -t start
gs_om -t status --detail

# ── 建实验账号 ──
gsql -d postgres -p 5432 -c "CREATE USER labadmin WITH PASSWORD '改我' CREATEDB;"

# ── 验证 ──
gsql -d postgres -p 5432 -U labadmin -W '改我' -c 'select version();'
```
**接入注意**：openGauss 协议**兼容 PostgreSQL**（`pg` 驱动可连，端口默认 5432），
但**方言有差异**（如 `AUTO_INCREMENT` 不支持、`SERIAL` 支持、部分 PG 扩展缺失）→ 方言探测要独立成 `opengauss`。

---

### 4.5 一键脚本（建议交付物）
```bash
# scripts/deploy-lab-db.sh  —— 幂等、可重复执行
./scripts/deploy-lab-db.sh postgres     # 或 mysql | opengauss
# 行为：装 → 起 → 建 labadmin → 写 .env（密码）→ 打印 settings.json 该填什么 → 自检连通
```
**要求**：脚本末尾**必须真跑一次连接测试**并打印结果；失败要**如实报错**（不是"安装完成"就结束）。

---

## 5. 系统如何"发现"引擎

1. 启动时读 `settings.json` 的 `sandbox.engines`
2. **对 `enabled: true` 的引擎做真探测**（真连一次）→ 得到 `available` + `reason`
3. `GET /api/v1/capabilities` 的 `sandbox.engines` 段**逐引擎如实上报**：
```jsonc
{ "sandbox": { "enabled": true, "defaultEngine": "sqlite", "engines": [
  { "id":"sqlite","label":"SQLite（内置，零部署）","dialect":"sqlite","runtime":"embedded",
    "available":true,"capabilities":{"crud":true,"ddl":true,"transactions":true,"procedures":false} },
  { "id":"postgres","label":"PostgreSQL 17","dialect":"postgres","runtime":"server",
    "available":false,"reason":"连接失败：ECONNREFUSED 127.0.0.1:5432（服务未启动？见 docs/LAB_DB_DEPLOY.md §4.2）",
    "target":{"host":"127.0.0.1","port":5432} }
]}}
```
4. **UI 按 `available` 渲染**：不可用的引擎**禁用 + 显示 reason + 指向部署文档章节**

---

## 6. 学生实验能力（**完整 CRUD，这是重点**）

| 操作 | SQLite | PG/MySQL/openGauss | 说明 |
|---|---|---|---|
| 建表 / 改表 / 删表 | ✅ | ✅ | DDL |
| 插入 / 更新 / 删除 | ✅ | ✅ | **增删改** |
| 查询（含 JOIN/子查询/聚合/窗口） | ✅（窗口函数 3.25+ 支持） | ✅ | 查 |
| 事务 / 回滚 | ✅ | ✅ | `BEGIN…ROLLBACK` |
| 视图 / 索引 / 触发器 | 视图索引✅ 触发器✅ | ✅ | |
| 存储过程 | ❌ | ✅ | **差异要在 UI 标注** |
| 权限/角色演练 | ❌ | ✅ | 用实验账号（非超管）可演示 GRANT |

**每个数据集带 `reset`**：一键回到初始 schema，学生搞坏了可恢复。

---

## 7. 安全红线（**任一不满足就不许上线**）

1. **绝不共用库**：每学生独立库（SQLite 文件 / PG database / MySQL schema）
2. **实验账号不是超管**：不给 `SUPER`/`FILE`/`PROCESS`；只授自己能建的库
3. **禁危险语句**：`ATTACH`(SQLite) / `LOAD DATA LOCAL INFILE`(MySQL) / `COPY FROM PROGRAM`(PG) /
   多语句拼接 → **统一在 SQL 闸里拒**
4. **资源硬限**：`maxRows` + **进程级硬超时**（`better-sqlite3` 同步 → 会卡死事件循环，必须独立进程）
5. **库大小上限**：超出拒绝写入
6. **审计**：学生的每次执行记 `audit_log`（教学场景需要，也是滥用追溯）

---

## 8. ★ 数据库日志接入（agent 错误分析的前提）

> 用户要求：**agent 要能获取数据库日志**；**即使后面添加其他部署的数据库，agent 也要能读日志**，
> 这样才能**对用户的错误进行指导分析**。

### 8.1 三层日志来源（**必须分层，因为可移植性差异极大**）

| 层 | 内容 | 怎么拿 | 可移植性 |
|---|---|---|---|
| **L1 会话诊断** | `SHOW WARNINGS` / `SHOW ERRORS` / 上一条语句的影响行数 / 执行计划 | **纯 SQL** | ★ **最可移植** —— 所有引擎都有（SQLite 用 `sqlite3_errmsg` + `EXPLAIN QUERY PLAN`） |
| **L2 实例统计** | 活动连接、慢查询、锁等待、InnoDB/PG 内部状态 | SQL（`pg_stat_activity` / `performance_schema` / `SHOW ENGINE INNODB STATUS`） | 中 —— 各引擎差异大，但**不需要文件访问** |
| **L3 引擎日志文件** | error log / slow query log | **读文件** | 差 —— 需路径 + 权限，**远程部署基本拿不到** |

**设计取向**：**L1 为主、L2 为辅、L3 可选**。
理由：L1/L2 只靠**一条 SQL** 就能拿到，**远程部署也适用**；L3 依赖运维把日志路径暴露给我们，
在"用户自己部署的数据库"场景下**大概率不可用** —— 所以 L3 必须**可降级**，拿不到就如实说。

### 8.2 `LogSource` 接口（与 `DatabaseEngine` 并列）

```ts
export interface LogSourceInfo {
  id: string;                   // 'sqlite' | 'mysql' | 'postgres' | 'opengauss'
  layers: ('L1'|'L2'|'L3')[];   // ★ 实际能提供到哪一层（**如实声明**）
  available: boolean;
  reason?: string;              // 不可用时给可读原因（如"未配置日志路径"）
  note?: string;                // 如"远程实例只能提供 L1/L2"
}

export interface DbLogEntry {
  at?: number;
  level: 'error' | 'warning' | 'info';
  source: 'L1'|'L2'|'L3';
  /** ⚠️ 必须已过滤到**该学生自己的**语句；不许泄露他人 SQL */
  sessionId?: string;
  sql?: string;
  code?: string;                // 如 ER_NO_SUCH_TABLE / 42P01
  message: string;
  hint?: string;                // 引擎自带的建议（PG 的 DETAIL/HINT 很有用）
  context?: Record<string, unknown>;
}

export interface LogSource {
  info(): LogSourceInfo;
  /** 拉取该会话相关的日志（**已做隔离过滤**） */
  fetch(req: {
    sessionId: string;
    userId: string;
    since?: number;
    limit?: number;
    layers?: ('L1'|'L2'|'L3')[];
  }): Promise<DbLogEntry[]>;
  /** L3：配置日志路径。**未配置 → L3 不声明** */
  configure?(cfg: { errorLogPath?: string; slowLogPath?: string }): void;
}
```

**注册方式与引擎一致**：`apps/server/src/sandbox/logs/registry.ts`，按 `settings.json` 的 `sandbox.engines[<id>]`
启用；引擎不可用时其日志源**也不可用**（如实报）。

### 8.3 各引擎的具体取法（**照着实现**）

| 引擎 | L1 会话诊断 | L2 实例统计 | L3 文件 |
|---|---|---|---|
| **SQLite** | 捕获 `sqlite3_errmsg` 原文 + `EXPLAIN QUERY PLAN` 输出 + **我们自己的 `audit_log`（每次执行的 SQL 与错误）** | ❌（无） | ❌（无文件日志）<br>→ **L1 就是主来源**，且我们**已天然拥有** |
| **MySQL** | `SHOW WARNINGS` / `SHOW ERRORS` / `SHOW COUNT(*) WARNINGS`；`diagnostics_area` 里还可能有 `MYSQL_ERRNO` | `SHOW ENGINE INNODB STATUS`、`performance_schema.events_statements_history`（**按 `THREAD_ID` 过滤到本人会话**）、`SHOW PROCESSLIST` | `/var/log/mysql/error.log`、slow log（**需运维配置并授权**） |
| **PostgreSQL** | `GET DIAGNOSTICS`、`SQLSTATE`、`DETAIL`/`HINT` 字段（**PG 的报错信息最有用**）；`pg_stat_statements` | `pg_stat_activity`（**按 `pid`/`application_name` 过滤到本人**）、`pg_locks` | `$PGDATA/log/*.csv`（或 `logging_collector` 输出目录） |
| **openGauss** | 同 PG（协议兼容） | 同 PG + `gs_stat_activity` | `$GAUSSDATA/pg_log/` |

**★ 关键点**：
- MySQL 的 `performance_schema` / PG 的 `pg_stat_activity` **默认能看到别人的会话** →
  **必须按当前学生的 `sessionId`/`THREAD_ID`/`pid` 过滤**，否则**一个学生能读到别人的 SQL**（越权）。
- **每个学生的沙箱会话要有可识别的 `application_name`（PG）/ `program_name`（MySQL）**，
  形如 `coursekb:u_<uid>:s_<sid>` —— 这是**过滤的依据**，必须在 `ensureSession` 时就设好。

### 8.4 接入 agent（这是这条需求的目的）

```
POST /api/v1/sandbox/ask
  { sessionId, sql?, rawError?, question? }
  ↓
组装上下文（★ 顺序即优先级，超长按此裁剪）：
  1. 【最近的报错】L1：引擎原始报错 + code + hint（**最有用，必须带**）
  2. 【最近执行的 SQL】该会话最近 N 条（来自 audit_log，**只含本人**）
  3. 【沙箱 schema】当前库的表结构（让模型知道"没有这张表"是为什么）
  4. 【L2 摘要】锁等待/慢查询（仅在报错疑似超时/锁冲突时带）
  5. 【L3 片段】error log 里**属于本人会话**的行（有就带，没有就跳过）
  6. 【知识库检索】/search 命中卡片 → `[[card:crd_xxx]]`（**答疑要能落到手册原文**）
  ↓
pi agent（含上述上下文）→ SSE 流式
```

**提示词硬要求**（教学场景）：
- **先归类问题**：语法错 / 对象不存在 / 类型不匹配 / 约束冲突 / 权限不足 / 锁超时 / 逻辑错（能跑但结果不对）
- **再给提示**，**不直接贴正确答案**（直接给答案对教学无效）
- **必须引用知识库卡片**（`[[card:...]]`），让学生能跳原文
- **日志读不到时要如实说**："我暂时读不到该实例的引擎日志（原因：X），下面的分析仅基于你的报错与 SQL"
  —— **绝不允许**在没读到日志时假装看过

### 8.5 安全（日志比数据更敏感）

1. **只读** —— 日志源**只提供读接口**，不给任何写/清理能力
2. **隔离** —— 输出前必须过滤到本人会话；**要有负例测试**（A 学生看不到 B 学生的 SQL 日志）
3. **脱敏** —— 日志里可能有连接串、密码、路径 → 过 `redact()`
4. **长度限制** —— 单次拉取 `limit` 上限（默认 200 行），提示词里**只放摘要 + 关键行**
5. **审计** —— agent 读日志这个动作本身也要记 `audit_log`（`action="log_read"`）

### 8.6 验收

- [ ] **SQLite 的 L1 可用**：学生报错后，agent 能拿到**引擎原文报错 + 上一条 SQL**
- [ ] 引擎重配（如切到 PG）后，**日志源随之切换**，agent 不用改代码
- [ ] **L3 拿不到时如实降级**：`layers` 不含 `L3`，且 agent 回复里**明确说明"读不到引擎日志"**
- [ ] **隔离负例**：A 学生**看不到** B 学生的 SQL/日志（真跑）
- [ ] 日志里的**密码/连接串被脱敏**
- [ ] 答疑回复**引用了知识库卡片**且可跳转原文
- [ ] 远程实例（无 L3）场景下，答疑**仍然可用**（靠 L1+L2+知识库）

---

## 9. 验收

- [ ] SQLite 开箱即用：**能建表、插数、查询、更新、删除**（真跑一遍 CRUD 的测试）
- [ ] 学生可选引擎；未启用/不可用的引擎**禁用 + 显示可读 reason + 指向文档章节**
- [ ] 引擎抽象：**加一个引擎 = 加 adapter + 配置**，不改上层（用"假引擎"测注册表）
- [ ] 隔离负例：**A 学生读不到 B 的库**（真跑）
- [ ] 危险语句被拒：`ATTACH` / `load_extension` / 多语句（**负例测试**）
- [ ] **死循环查询被硬超时杀掉，且 `/health` 仍 200**（不阻塞服务）
- [ ] 部署脚本在**空白系统**上可跑，且末尾**真连一次**并如实报结果
