# scripts/ —— 运维与部署脚本

> 这些脚本**只做部署与自检**，不改应用代码。契约见 `docs/LAB_DB_DEPLOY.md`。

---

## `deploy-lab-db.sh` —— 实验数据库引擎一键部署

```bash
./scripts/deploy-lab-db.sh sqlite                # 零部署（默认引擎）
./scripts/deploy-lab-db.sh postgres              # PostgreSQL 17
./scripts/deploy-lab-db.sh mysql                 # MySQL 8.4
./scripts/deploy-lab-db.sh opengauss             # ⚠️ Ubuntu 上会如实拒绝（见下）

./scripts/deploy-lab-db.sh postgres --dry-run    # 只打印将要执行的命令（含 SQL），不做改动
./scripts/deploy-lab-db.sh postgres --check      # 不安装，只对已部署的引擎做连通性自检
./scripts/deploy-lab-db.sh postgres --help
```

### 它做什么（六步）

1. **安装**（sqlite 跳过）→ **启动服务 + 开机自启**
2. **建/更新非超管实验账号** `labadmin`（PG: `LOGIN+CREATEDB`；MySQL: **只授 `CREATE,DROP`**）
   * 为什么 MySQL 不写 `REVOKE SUPER,FILE,PROCESS`：我们从未授过这些权限，而 MySQL 对
     "撤一个不存在的授权"会报 `ERROR 1147` —— 全新账号上**必然报错**，日志里的红字很容易被
     误当成部署失败。正确做法是**只授需要的 + 由自检断言没有危险权限**（见下）。
3. **放行本机 TCP 密码登录**（PG 的 `pg_hba.conf` 加一行，**幂等**：已存在就不重复插入）
4. **写 `.env`**（密码；`chmod 600`；**只改自己的键，不动其它内容**）
5. **打印 `settings.json` 该填什么**（`sandbox.engines.<id>`，用 `passwordEnv` 指向变量名，**不含密码值**）
6. ★ **末尾真连一次并打印结果** —— 不是"安装完成"就结束

### 密码（**不提供默认值**）

| 引擎 | 环境变量（= `settings.json` 的 `passwordEnv`） |
|---|---|
| postgres | `LAB_PG_PASSWORD` |
| mysql | `LAB_MYSQL_PASSWORD` |
| opengauss | `LAB_OG_PASSWORD` |
| sqlite | 不需要 |

```bash
LAB_PG_PASSWORD='Lab-Pass_2026#x' ./scripts/deploy-lab-db.sh postgres
```

* 不给就用**交互式输入**（不回显、二次确认）
* **非交互且无环境变量 → 直接报错退出**（不会替你编一个默认密码；安全红线 §7）
* 约束：≥ 8 字符，且**只允许**字母、数字与 `._@#%+=-`
  （白名单理由：密码要安全通过 shell / SQL 字面量 / 日志打码三处，黑名单永远漏 —— 实测 `$`、反引号、反斜杠、引号、以及通配符 `*?[` 都会出问题）
* `--dry-run` **不索要密码**，命令与 SQL 里用占位符代替

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功（含"已是最新，无需改动"） |
| 1 | 执行失败 |
| 2 | 用法错误（缺参数 / 未知引擎 / 密码不合规） |
| 3 | 平台不支持（如 Ubuntu 上的 openGauss） |
| 4 | ★ **自检失败**（部署了但连不上 —— 如实失败，并打印排查指引） |

### openGauss：为什么"拒绝"而不是"假装能装"

openGauss 官方只提供 **openEuler/CentOS 的离线包**（tar.gz + 交互式 `install.sh`），
不在 apt/dnf 源里；Ubuntu 上需自行编译。脚本因此：

* **Ubuntu/Debian** → 打印原因 + 三条可行路径，退出码 `3`
* **CentOS/Rocky** → 说明为何仍不自动化（包不在源里、需交互式安装、依赖多），给出逐步指令
* 平台判断**早于索要密码**（不能先要口令再说"这平台不支持"）

装好之后用 `--check` 做真实自检（`gsql`）：
```bash
./scripts/deploy-lab-db.sh opengauss --check --host 127.0.0.1 --port 5432
```

### 与 `docs/LAB_DB_DEPLOY.md` §4.3 的一处**有意差异**

文档里有 `ALTER USER 'root'@'localhost' IDENTIFIED WITH caching_sha2_password BY '...'`。
本脚本**默认不改 root 的认证方式**：Ubuntu 的 MySQL 初始是 `auth_socket`，改成密码认证会让
`sudo mysql`（本脚本建号用的通道）失效，且有**锁死用户**的风险 —— 而我们的目的只是
"建一个非超管实验账号"。需要按文档做时显式加 `--set-root-password`。

### 自检到底验了什么

| 引擎 | 自检内容 |
|---|---|
| sqlite | 真建表 → 插入 → 更新 → **回读断言值** → 删表（`sqlite3` CLI；没有则用 `python3` 标准库，两者都是真连接） |
| postgres | `psql -c 'select 1'` → 返回 `1` 才算过；另查 `rolsuper`（**必须非超管**）、`rolcreatedb`、`version()` |
| mysql | `mysql -e 'select 1'` → 返回 `1`；另查 `SHOW GRANTS` 并断言**没有** `SUPER/FILE/PROCESS/ALL PRIVILEGES` |
| opengauss | `gsql -c 'select version();'`（缺客户端时**如实失败**，不做假判断） |

失败时打印该引擎的**排查指引**（服务是否起来、端口是否在听、认证规则、账号是否存在），
并提示 `./scripts/deploy-lab-db.sh <engine> --check` 可重试。

---

## 环境假设与限制（**如实声明**）

* 脚本面向 **Linux**（Ubuntu/Debian 与 CentOS/Rocky/openEuler 两套包管理器）。Windows 上建议在 WSL 里跑。
* **需要 root/sudo** 才能安装与建号；`--check` 与 `--dry-run` **不需要**。无免密 sudo 且非交互时会**直接报错**（不会挂着等输入）。
* 无 systemd 的环境（容器/WSL）会退回 `service <name> start`；PG 另补 `pg_ctlcluster`。
* 可用 `LAB_DB_ENV_FILE=/path/to/.env` 把凭据写到别处（默认写仓库根的 `.env`）。

## 已验证 / 未验证（**本机实测，诚实标注**）

* ✅ Ubuntu 24.04（WSL2）实测通过：`bash -n` 语法、`--help`、8 类参数校验、
  **sqlite 分支真跑（含幂等）**、openGauss 拒绝路径、postgres/mysql 的 `--dry-run`
  （含 SQL 打印）、密码策略（7 种非法字符被拒 / 2 种合法被接受）、
  未部署引擎的 `--check` 如实失败（退出码 4）、`.env` 写入的 12 项断言
  （保留其它键、无重复键、chmod 600、重复写不增行）
* ❌ **未端到端验证**：postgres/mysql 的**真实安装与真连**（本机没有免密 sudo、也没装这两个引擎）。
  那两条路径的命令逐字抄自 `docs/LAB_DB_DEPLOY.md` §4.2/§4.3；
  请先在真 Ubuntu 上跑 `--dry-run` 复核命令，再去掉 `--dry-run` 执行。
* ❌ **未验证**：openEuler 上的 openGauss 流程（本机没有该平台）。
