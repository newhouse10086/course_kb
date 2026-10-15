# AGENTS.md —— 课程知识平台

> 面向**在本工程工作的 AI 或人**。开工前必读 §1 与 §3。
> 最后更新：2026-10-14

---

## 0. 一句话

把**任意课程资料**（PDF / PPT / 视频）编译成**知识库 + 知识图谱 + 视频文稿**，并挂一个 **pi** AI 助教。

MySQL 手册只是**第一份样例**，不是特例 —— 新增格式**只写 adapter，不改核心**。

**技术栈（v2，2026-10-14 架构调整）**：

| 层 | 技术 | 说明 |
|---|---|---|
| **后端主体** | **TypeScript + Node** | Fastify；**pi 用官方 SDK 进程内集成** |
| **前端** | **Vue3 + Vite** | 对齐参考文章 |
| **媒体/文档 worker** | **Python 子进程** | 只保留成熟库不可替代的部分（ASR / PDF / PPTX / DOCX） |
| **模型能力** | **可插拔 Provider** | ASR/TTS/翻译/LLM/OCR **大概率走大厂 API** |

> ⚠️ **v1 曾用 Python+FastAPI 后端、pi 走 RPC —— 已废弃。**
> 变更原因与取舍见 `docs/ARCHITECTURE_V2.md` §1。

---

## 1. 开工三步

```powershell
cd "D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\course-kb"

# 1. 读契约（唯一权威，实现与它不一致就是 bug）
#    docs/ARCHITECTURE_V2.md  ★ 架构与迁移（先读这个）
#    docs/API_PROTOCOL.md     接口契约
#    docs/PROVIDERS.md        ★ ASR/TTS/翻译/LLM/OCR provider 设计
#    docs/FUNCTIONAL_SPEC.md  功能实现 + 15 个坑

# 2. 装依赖
cd apps/server ; npm install
cd ../web     ; npm install
cd ../..      ; python -m pip install -r worker/requirements.txt

# 3. 起服务
cd apps/server ; npm run dev      # → http://127.0.0.1:8787/api/v1/health
cd apps/web    ; npm run dev      # → Vite dev server
```

---

## 2. 目录与写域

```
course-kb/
├─ AGENTS.md              ← 本文件
├─ docs/                  ★ 契约（只读，Lead 维护）
│   ├─ ARCHITECTURE_V2.md    ★ 架构 v2（TS主体 + Python worker + Provider）
│   ├─ API_PROTOCOL.md       接口契约
│   ├─ PROVIDERS.md          ★ provider 设计
│   └─ FUNCTIONAL_SPEC.md    功能实现 + 坑
├─ contracts/             ★ 共享契约（TS 类型 + JSON Schema）
│   └─ schema/{edge_types,knowledge_card}.json   封闭枚举，不许发明
├─ apps/
│   ├─ server/            【T-BACKEND / T-PROVIDERS / T-AGENT】
│   │   ├─ package.json  (Fastify + better-sqlite3 + pi SDK)
│   │   ├─ src/
│   │   │   ├─ index.ts  config.ts
│   │   │   ├─ store/            SQLite + 迁移
│   │   │   ├─ routes/           REST + SSE
│   │   │   ├─ providers/        ★ 模型 provider（T-PROVIDERS）
│   │   │   ├─ agent/            ★ pi SDK 集成（T-AGENT）
│   │   │   ├─ tasks/            任务队列
│   │   │   └─ worker/           Python worker 调用器（JSONL）
│   │   └─ test/
│   └─ web/               【T-FRONTEND】Vue3 + Vite
│       ├─ package.json  vite.config.ts
│       └─ src/
│           ├─ main.ts  App.vue
│           ├─ views/       WikiIndex / Graph / Video / Chat / Docs
│           ├─ components/  卡片 / 树 / 图谱 / 虚拟滚动 / 思维导图
│           └─ api/         API 客户端（含 SSE）
├─ worker/                【T-WORKER】Python 媒体/文档 worker
│   ├─ cli.py             ★ 入口：读 JSON 参数 → 输出 **JSONL 进度**
│   ├─ adapters/          PDF/PPTX/DOCX/TXT（PyMuPDF / python-pptx / python-docx）
│   ├─ video/             ASR/字幕/抽帧（faster-whisper）
│   ├─ pipeline/          units/xref/search（**已验证的算法，别重写**）
│   ├─ models/            Python 数据模型
│   └─ tests/
├─ web/                   ⚠️ v1 原生 HTML/JS，**将被 Vue3 取代**（参考用）
└─ data/                  运行期
```

### 写域规则（**硬约束**）

1. **只写自己写域内的文件**。要改别人的 → 先在群里说，等对方确认。
2. `docs/**` 与 `contracts/**` 是 **Lead 维护**，其他人**只读**。
3. 依赖顺序：**T-WORKER 先交付 `worker/cli.py` 的 JSONL 协议**，T-BACKEND 的调用器才能定型。
4. 跨层接口以 `docs/` 契约为**唯一权威**。

---

## 3. ⚠️ 坑清单（**每个都踩过，改代码前必读**）

### 3.1 TypeScript 侧（v2 新增，**Lead 实测踩到**）

| # | 坑 | 对策 |
|---|---|---|
| **T1** | **Node strip-only TS 模式不支持参数属性** → `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported in strip-only mode` | `constructor(public readonly x: T)` **禁用**；要显式声明字段再赋值 |
| **T2** | 同上，**不支持** `enum` / `namespace` / 装饰器 / `import x = require()` | 用 union 类型 + `as const` 数组替代 enum（与 pi 自身 "erasable TS syntax only" 一致） |
| **T3** | worker↔Node 的 JSONL **不能用 `readline`** | U+2028/2029 在 JSON 串里合法会**错切帧**；只按 `\n` 切字节 |

> **好消息**：因为约束是"可擦除语法"，**不需要 tsx/ts-node** ——
> `node --test test/xxx.test.ts` 直接跑 TS（实测 39/39 通过）。

### 3.2 通用（v1 继承，**跨语言有效**）

完整版见 `docs/FUNCTIONAL_SPEC.md` 附录，此处给**最容易犯的 6 个**：

| # | 坑 | 对策 |
|---|---|---|
| 4 | `json_object` 模式**不强制 enum**（实测模型输出 `"etype":"常用实现"`） | 必须 `json_schema` + **`strict:true`** + `additionalProperties:false` |
| 5 | 单元划分：跨度 > N 的节点不下钻 → **整片丢页**（实测漏 1874 节点） | **递归下降 + 补父节点引言段** |
| 6 | mention 引用假阳性：`USE` 被引 198 次、`AND` 183 次 | **过滤通用词**（规则见契约 §2.5） |
| 13 | pi 的 `prompt` 响应 **≠ 完成** | 等**真正的结束信号**（v1 是 `agent_settled`） |
| 15 | SQLite FTS5 默认 tokenizer 对中文 **0 命中** | 自建 **bigram**（better-sqlite3 同样适用）。**实测对照**：同一段中文正文 `unicode61`→**0 命中**、`bigram`→**2 命中** |
| **16** | **FTS5 增量更新会留脏索引**（`'delete'` 指令传了**新值**而非**旧值** → 旧词条不移除 → **搜得到已删除的内容**，且**不报错**） | 更新时必须：**先取旧行的全部列值 → 用旧值执行 `'delete'` → 再插入新值**。v1 `worker/_legacy/store/db.py::fts_upsert` 有此 bug（由 T-BACKEND 实测抓出） |
| **17** | **`JSON.stringify` 不转义 `U+2028`/`U+2029`**（Node 24 实测）→ 打穿 SSE 契约 §6「`data:` 是单行 JSON」的保证 | **主动转义**（同 §7.3.1 P1 思路）+ 断言 `data:` 里出现 `\u2028` |
| **18** | **argv 有大小上限**（Windows ~32KB）→ 大 payload 塞 `--in <json>` 会 `ENAMETOOLONG`；**本机小样本跑得过、真实规模必炸** | **> 8KB 的 payload 走 stdin**（显式 `--in -`）。阈值留余量（路径含中文 + 编码放大 + Windows 版本差异） |
| **19** | ★ **缓存静默破坏「承诺实时」的字段语义**（而且**测试可能仍绿**） | **加缓存前逐个字段问：它承诺的是「实时」还是「快照」？** 把必须实时的做成**显式白名单**（如 `REALTIME_FIELDS`），缓存只作用于其余字段。<br>**本坑一轮内踩了 3 次**（`auth.bootstrap` / `settings.activeModel` / `retrieval.dataReady`）—— 靠"记得改"不可靠，白名单的价值是**迫使新增字段时做一次显式决定**。<br>⚠️ **为什么最隐蔽**：`auth.bootstrap` 有实时性回归测试 → **红了被抓住**；而 `dataReady` 的测试**直接调检索层、不经过路由缓存** → **全绿**。⟹ **「承诺实时」的字段一旦被缓存，其测试若不走真实 HTTP 就不会失败。**<br>**必需测试形态**：同一进程内 `GET`（预热缓存）→ **写入数据** → 立刻再 `GET`（命中缓存）→ 断言字段**已变新值**。 |
| **20** | ★★ **用 PowerShell 文本管线改源码 → 中文注释整份变乱码**（`Get-Content \| Set-Content` 按 ANSI/带 BOM 重写，UTF-8 中文必坏） | **源码批量替换禁止走 PowerShell 文本管线**：用 `edit`/`write` 工具，或 Node/Python 的**显式 UTF-8 读写**。<br>⚠️ **它不会立刻报错** —— 文件写"成功"了，直到下一次 `node --test` 才炸，**而且报的是 `SyntaxError`（中文字符串里的引号被破坏）→ 极易误判成代码逻辑问题**。<br>**本坑一轮内被两个不同的人各踩一次**（`backend-api` 改 `capabilities.ts`、`kg-rag-architect` 改测试文件），两人都靠 `git checkout HEAD -- <file>` 恢复后用 `edit` 重做。 |
| **21** | ★★ **自述字段（`*_source` / `*_status` / `*_warning`）与实际生效值不同源 → 它会在两个方向上都撒谎** | **判据：实际值（如 `ready.tools`）是唯一真相；自述字段只是标签。** 必须加**同源断言**：`tools_source='kb-readonly'` → `tools` 必须含 KB 工具；`='disabled-by-role'` → `tools` 必须 `=== []`；**反向**：`tools` 非空 → `source` 不许是"已关闭"。<br>**实证（同一 bug 的两个方向）**：<br>· `tools_source:'none'` 但实际拿到 4 个危险工具 → **说关了其实开着**（🔴 安全事故：学生能执行 shell）<br>· `tools_source:'kb-readonly'` 但 `tools:[]` → **说开了其实关着**（功能失效，模型直接说"没有这两个工具"）<br>⚠️ **第二个只有真 WS 端到端能抓到** —— 单元测试与 `/capabilities` 断言**全绿**。<br>与坑 19（缓存冻住实时字段）、`available`/`dataReady` 正交、`interim` 缺字段**同族**：**都是"上报的东西必须是真的"**。 |
| 10 | 能力不可用**假装可用** | **Provider 层强制**：`configured` vs `available` 分开 + 可读 `reason` |

> **坑 12 / 17 / 18 是同一类**：本机能跑，**放大到真实数据就静默或直接失败**。
> 同类还有：**"数字对但结论撒谎"**（`contrast` 在 `unicode61>0` 时说"unicode61 为 0"）、
> **"不报错但输出是假的"**（FTS5 脏索引、`E_PICK_KEY` 静默丢卡片、假绿的能力探测）。
> **判据**：如果一个 bug 的表现是"看起来成功"，它比崩溃危险得多。

---

## 4. 环境事实（本机实测）

| 项 | 状态 |
|---|---|
| Node v24.15.0 | ✅ pi 需 ≥22.19 |
| Python 3.14.4 | ⚠️ 部分包可能不兼容 |
| **ffmpeg N-124868** | ✅ |
| torch 2.12.1+cpu | ✅ 无 CUDA |
| PyMuPDF / python-pptx / python-docx | ✅ 已装 |
| **Docker** | ❌ **未安装** → 文章的 FunASR-Docker 方案**不可用** |
| faster-whisper | ❌ 需 `pip install`（PyPI ✅ 可达） |
| pi 源码 | ✅ `../pi`（1913 文件，11 包） |
| GitHub | ✅ |

**⟹ ASR 决策：放弃 FunASR（需 Docker），用 faster-whisper（CPU 可跑）。**

---

## 5. 上游资产（**优先复用，别重造**）

`../数据库课程智能体调研/` 有经过验证的资产：

| 资产 | 复用方式 |
|---|---|
| 栈式建树算法 | 抄 `tools/build_tree.py::build_parents` |
| 卡片抽取管线 | 抄 `tools/extract_v2.py` 的 schema + 提示词（去掉 MySQL 硬编码） |
| 交叉引用引擎 | 抄 `tools/build_wiki_v2.py` 的 `mention_ok` 过滤规则 |
| 翻译管线（术语表） | 抄 `tools/translate_wiki.py` |
| 图谱页自绘 | 参考 `product/prototype/refman_graph.html` |
| **11 个坑 + 权威裁定** | 读 `../数据库课程智能体调研/AGENTS.md` |
| **提示词全集** | 读 `../数据库课程智能体调研/product/PROMPTS.md` |

**已验证的常量，不要重新发明**：
`SPAN_THRESHOLD=3` ｜ `MAX_PAGES_PER_UNIT=8` ｜ `MIN_DEGREE_FOR_PAGE=2` ｜ **并发=1**

---

## 6. pi（`../pi`）

| 项 | 值 |
|---|---|
| 仓库 | `earendil-works/pi`（MIT） |
| 版本 | 1.2.0（npm 包 `@earendil-works/pi-coding-agent`，已实测可达） |
| Node | ≥22.19 |
| 关键文档 | `../pi/packages/coding-agent/docs/` 下的 **`sdk.md`**、`message-types.md`、`session-format.md` |
| 全局已装 | `pi` v1.0.2（`C:\Users\19149\AppData\Roaming\npm\pi.CMD`） |

### v2：**用官方 SDK 进程内集成**（不是 RPC）

```ts
import { createAgentSession } from '@earendil-works/pi-coding-agent';
```

> ⚠️ **v1 曾用 RPC 子进程（`pi --mode rpc`）—— 已废弃。**
> 原因：pi 是 TypeScript，SDK 才是正路；RPC 那层（切帧/背压/子进程管理/三档降级）是**用工程复杂度给选型打补丁**。
> 但 **v1 RPC 实测挖出的教训仍然有效**（见 §3.2 坑 13、以及契约 §7.3.1）：
> - **结束信号要等真正的结束**（别把"已受理"当成"已完成"）—— **SDK 的 `prompt()` resolve 语义必须现场核实**
> - **不把系统提示词下发给浏览器**（v1 实测：直通会把 pi 的 system prompt + 本项目 AGENTS.md 全文 **11KB** 推给前端）
> - **`pi.available`（桥可用）与 `model.available`（模型可用）必须分开报**（v1 实测过"桥正常但模型 403"）

**⚠️ 不要修改 `../pi`**（第三方仓库）。
**降级**：SDK 不可用时 `/capabilities` 返回 `pi.available=false` + 可读 `reason`，UI 禁用对话入口并说明原因。

---

## 7. 质量门（交付前自证）

- [ ] `python -m pytest tests/ -q` 全绿（自己写域内）
- [ ] HTTP 接口有**真实调用**测试，不是 mock
- [ ] 长任务有**断点**，中断可续
- [ ] 测试**断言具体值**，**不许只断言非空**（历史上"非空"断言放过了真 bug）
- [ ] 页面改动用 headless Chrome 断言 DOM
- [ ] 新增依赖写入 `requirements.txt` 并说明理由
- [ ] 修的每个 bug 在注释里**记下原错误写法**

---

## 8. 禁止

- ❌ 发明 `schema/` 之外的边类型 / kind
- ❌ 并发调 LLM（**并发=1**，用户硬要求）
- ❌ 修改 `../pi` 与 `../数据库课程智能体调研/`
- ❌ 能力不可用时**假装可用** —— 必须如实降级
- ❌ 把模型输出当事实 —— 必须有原文引用支撑
- ❌ `git add -A` / `git reset --hard`
