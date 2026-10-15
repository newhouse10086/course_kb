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
└─ data/                  运行期
```

> ⚠️ **v1 前端 `web/`（原生 HTML/JS）已于本轮删除** —— 已被 `apps/web`（Vue3）完全取代。
> **删除依据**：① v2 服务端**没挂它**（连它自己推荐的 URL 都是死链）；
> ② 它的配色是 `docs/DESIGN_SYSTEM.md` **点名的反例**（`#fff` 面板 / `#2f5fd0` 蓝）——
> 与 v2 是**两套视觉语言**；③ `apps/web` 是它的功能超集（逐文件核对）。
> **历史保留**：`git show 78798a3:web/<path>` 可取回。
> ★ 删除前**先搬走了 `chat.html` 的 4 条行为**（其中"1013/1008 关闭码不再重连"是**真 bug**）——
> **"先问再删"捞回了东西，不是流程冗余。**

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
| **21** | ★★ **自述字段（`*_source` / `*_status` / `*_warning`）与实际生效值不同源 → 它会在两个方向上都撒谎** | **判据：实际值（如 `ready.tools`）是唯一真相；自述字段只是标签。** 必须加**同源断言**：`tools_source='kb-readonly'` → `tools` 必须含 KB 工具；`='disabled-by-role'` → `tools` 必须 `=== []`；**反向**：`tools` 非空 → `source` 不许是"已关闭"。<br>**实证（同一 bug 的三个实例，都真实发生）**：<br>· `tools_source:'none'` 但实际拿到 4 个危险工具 → **说关了其实开着**（🔴 安全事故：学生能执行 shell）<br>· `tools_source:'kb-readonly'` 但 `tools:[]` → **说开了其实关着**（功能失效，模型直接说"没有这两个工具"）<br>· **`context` 帧回报 `used/resolved`（"用了"），但解析出的标题根本没拼进 prompt** → 问"我在看哪一章"，模型答"我读不到你的浏览状态"（**说用了其实没用**）<br>⚠️ **后两个只有真 WS 端到端能抓到** —— 单元测试与 `/capabilities` 断言**全绿**。<br>**推广**："同源"不止 `tools_source` —— **任何 `used` / `resolved` / `x_available` / `x_enabled` 都要有"真的用上了"的证据**（如：断言它**真的出现在发给模型的这一轮消息里**）。<br>与坑 19（缓存冻住实时字段）、`available`/`dataReady` 正交、`interim` 缺字段**同族**：**都是"上报的东西必须是真的"**。 |
| **22** | ★★ **`空` ≠ `缺失`** —— `x or y or []` 把**有意义的空列表**当成"没有值" | **判"缺失"必须用 `is None`**，不能用真假值。<br>**实证**：`hints or result.get("hints") or []` —— **空列表是有意义的**（"该方言没有提示"），`or` 把它当缺失 → 回落到子进程按 SQLite 算的提示 → **反向误导又回来了**（真 MySQL 上 `NOW()` 本来就正确，却给了"改用 SQLite 写法"的建议）。<br>同族：`interim` 缺字段被当假值 · `tools_source` 缺字段被当"已关闭"。**"没有这个说法"和"明确说是空"语义不同。** |
| **26** | ★★ **Windows 上 `npm start` + `terminate()` 漏杀 node 子进程 → "新实例"其实是旧进程** | **`npm start` 会先起一个 npm 包装进程，`terminate()` 杀掉的是它，真正的 `node` 子进程存活并继续监听端口。**<br>**实证**：`npm start` → LISTENING；`srv.terminate()` → **仍 LISTENING（PID 39316 存活）**；按端口 `Stop-Process` 才真停。<br>⚠️ **后果极隐蔽**：你以为起了"干净的新实例"，**请求其实打到上一次留下的旧进程** ——<br>实测踩到：新实例首次登录报 `429 failures=5`，**看起来像"限流跨进程累计的 bug"**，<br>真相是旧进程里攒着**你自己刚才的 4 次错口令**。<br>**对策**：**收尾时按端口补杀**（`kill_port_owner`），不要只 `terminate()`；<br>起实例后**断言端口归属**（PID 与刚启动的一致），否则"新实例"是假设不是事实。<br>★ 与坑 19/21 同族：**"我以为的环境"与"真实的环境"不一致**。 |
| **25** | ★★ **Vite 构建通过 ≠ 页面能渲染** —— `<script setup>` 顶层 `await import()` 会让组件变成 **async setup**，整页渲染不出来 | **`<script setup>` 里禁止顶层 `await`**（除 `<Suspense>` 包裹）；改**静态导入**。<br>**实证**：`Chat.vue` 用了顶层 `await import()` → `vue-tsc` **0 错**、`vite build` **通过**，但 e2e **直接 timed out**（页面空白）。改静态导入后 DOM 断言 243/243。<br>**判据**：**构建期检查（tsc/build）覆盖不了运行期渲染** —— 与坑 19/21「不走真实路径就测不出」同族。<br>**必须用 headless DOM 断言真实渲染**，不能只靠 typecheck/build。 |
| **24** | ★★ **"死旋钮"：配置项被文档/类型承诺可配，代码却从不读它** | **比"没有这个配置"更坏** —— 运维按注释配了**以为生效了**，实际撞硬编码默认值。<br>**实证**：`providers/llm/openai_compatible.ts` 硬编码 `setTimeout(…, 120_000)`；<br>而 `types.ts` 注释写"其它可选参数（如 `timeoutMs`）"，但 `extra` **只读了 `maxContextTokens`** → **`timeoutMs` 是死旋钮**。<br>**同族**：`ExtractDocumentRequest.maxTokens` **只有声明、没有调用方** → 抽取恒用 4096（**声明 ≠ 生效**）。<br>**判据**：**"能配"和"真的会生效"是两件事** —— 与"能读/真的读到"（坑 21）同族。<br>**修法**：要么让它**真的生效**（并断言**请求体里的值**，不是断言"我们传了参数"），要么**删掉那句承诺**。**不许留着"承诺但不生效"。**<br>⚠️ **排查手段**：给一个**极小值**看是否立刻触发 → 证明它真的被读。 |
| **23** | ★ **本机 `bash` 是 WSL，而 Windows→WSL 不自动透传环境变量**（只透传 `WSLENV` 里列的） | 从 Windows 侧用 `env=X bash script.sh` 注入的变量**到不了 Linux 侧** → 脚本报"没有 TTY/读不到变量"，**看起来像脚本的 bug**。<br>**验法**：改成在 bash 内部设置 —— `X=值 bash script.sh`（在 WSL 命令行里），或先 `export WSLENV=...`。<br>**本机实测**：`C:\WINDOWS\system32\bash.EXE`；同一脚本从 Python 注入密码 → 报错；在 bash 内部设置 → 立刻正常。**任何人从 Windows 侧验 shell 脚本都会踩到。** |
| **27** | ★★ **"全量替换"式写入 + FK `ON DELETE CASCADE` = 每次重跑都**静默清空下游数据** | **替换类操作只删"消失的行"**，不要 `DELETE` 全部再插回。**判据：删掉的是"不再存在"的，不是"要重写的"。**<br>**实证（reparse 清空卡片，用户"越修越糟"）**：`repo.replaceUnits` 第一行 `DELETE FROM units WHERE doc_id=?`，而 `cards.unit_id REFERENCES units(id) ON DELETE CASCADE` → **每次解析都删光该文档全部卡片**（含 **reparse 成功** 的情况）。<br>★ **级联发生在 DELETE 那一刻**，**随后用同一个 id 重新 INSERT 也救不回来**：`① cards=1 → ② DELETE units 后 cards=0 → ③ 重插同 id 后 cards=0` ⟹ **"让 id 稳定"单独不够**（我第一版据此判断，被实测推翻），必须**不删**。<br>★ **另一条边界**：`drafts` 为空（解析产不出单元 = **失败**）→ **一个都不许删**（否则 stale=全部 → 删库）；**失败不清库**，与"零产出不覆盖旧产物"同一原则。<br>**配套**：id 必须**确定性/可复用**（否则"仍在的单元"认不出来）；复用判据 = `(ord, span)` + **正文相同**（正文变了 → 换 id → 该单元卡片重抽，**这是对的**）。<br>⚠️ **同类隐患**：`notes.unit_id` 是**纯 TEXT 无 FK** → 单元被替换后旧笔记**悬空引用**（可观测：笔记指向不存在的单元）。本次**未动** notes（不在授权内），记录在案。 |
| **28** | ★★ **"取第一个"在列表里经常不是你要的那一个**（同一个形状**一轮内踩两次**） | **判据：从列表里取元素时，必须按"你要的那个东西"限定，不能靠"第一个"。**<br>**实证 1（对话页）**：`history` 帧恢复后，`document.querySelector('[data-testid="assistant-text"]')` 取到的是**历史那条**助手消息（不是刚生成的那条）→ 富文本/公式/表格断言**全红假失败**。<br>**实证 2（文档页）**：重解析代价断言读了**表格第一行**（第一行是 video，`page_count=0`）→ 显示"页数未知"→ 假失败；实际要断言的是 PDF 那行。<br>**实证 3（同名 testid）**：`current-session` 在**抽屉与整页各有一个**，页面级 `querySelector` 在**抽屉打开时可能读到另一个实例**的节点 —— 当时"通过"**只是因为抽屉是 `v-if` 关闭态**（"碰巧对"）。<br>**修法（三例一致）**：① 按**目标**限定作用域（`[data-reparse="<doc>"]` 所在行 / `!e.closest('[data-testid="assistant-drawer"]')`）② 或明确取**最后一条**（`Array.from(...).pop()`）③ **并加"反例用例"**：让两个候选**同时存在**（如打开抽屉），断言仍读到正确那个 —— 否则就是"关着才过"。<br>★ 与坑 21 同族：**"读到的"≠"你以为读到的"**；**"各自存在"≠"关系正确"**。 |
| **29** | ★ **确定性失败 ≠ 抖动** —— 同一个失败**连跑三次都在同一条**，先怀疑代码，别去查机器 | **判据：连续复现同一断言/同一行 → 是代码问题；随机在不同用例间跳 → 才是环境/时序。**<br>**实证**：e2e 里 `ROW`（按文档限定选择器的字符串）**定义在使用点之后** → `UnboundLocalError: cannot access local variable 'ROW'`，**连跑 3 次都是同一条**；而同文件里真正的抖动（`308/0 · 307/1 · 307/1`）**失败项固定但计数在跳** —— 两者形状不同、修法也不同（前者改作用域，后者改成显式 `wait_for`）。<br>★ **配套**：把"连跑 2–3 次"作为**新断言的交付要求** —— 一次通过可能是侥幸（我们刚吃过"308/308 其实在抖"）。 |
| **30** | ★★ **用 `as never` / `as unknown as` 把类型错按下去 → `tsc` 0 错、`npm test` 全绿，但 `npm start` 直接崩** | **判据：凡是绕过类型的地方，都必须有"真启动"验证**（真的起进程 + 打一次 `/health`）—— **typecheck 0 错 ≠ 能跑**，与坑 25（Vite 构建通过 ≠ 页面能渲染）同族。<br>**实证（日志任务）**：`Fastify({ logController: {disableRequestLogging:true} })` 传了**普通对象**，为压掉 TS 重载报错加了 `as never` → **tsc 0 错**，但运行期 `FastifyError: logController option must be an instance of LogController, got 'object'` ⟹ **8787 起不来、用户后端断了**（Lead 实测发现）。<br>★ **正确修法**：① 传 `LogController` **实例**（`new LogController({…})`）；② 或**直接删掉该选项**（FSTDEP023 就是它引起的，而请求日志本来就是要的）；③ 类型用**显式交叉类型**（`FastifyServerOptions & { logController?: unknown }`）—— 不要 `as never`。<br>★★ **但最该记的是流程**：`test/logging_http.test.ts` 里**本来就有 `buildApp()` + `app.listen()`** —— **改完跑一次测试就会红**；作者改完**只跑了 `tsc`** → "类型层全绿、运行期直接崩"。<br>**⟹ 教训：用断言绕过类型后，`npm test` 必须跑（它含真启动路径）；只跑 `tsc` 等于没验证。**<br>★ 同类附带：删掉该选项后 Fastify **默认请求日志会把 `req.raw`/`res.raw` 整个 dump** —— 一次请求 **5.7KB**（≈17KB/请求；90 秒 83.8KB），且**查询串里的 token 原样落盘**（实测假密钥出现 2 次）。**"默认日志"也可能是泄漏源**：判据 = 单条请求行 ≤300 字节 + 日志里 grep 不到 `"raw":` / `set-cookie` / `?token=`。 |
| **31** | ★★ **共享工作区里“同时刻跑测试”会拿到半保存状态** —— 多套齐红，**看起来像你的回归** | **判据：先看是不是语法错，再看文件归属。** 症状组合 = 多套齐红 + `ERR_INVALID_TYPESCRIPT_SYNTAX` + **自己的套件也红** ⟹ 大概率是**别人正在保存**（半保存状态），不是你的逻辑错。<br>**实证（backend-core）**：`src/index.ts` 23:43:12 存了一版坏的（`logController`，即坑 30）→ 三套齐红（`E_UNAUTHENTICATED` / `ERR_INVALID_TYPESCRIPT_SYNTAX`）→ **我自己的套件同时也在红** → 23:44:08 修好后**五套全绿**；auth 源码自 01:30 未动 → 排除自己。<br>**配套**：改动者尽量**原子落盘**；验证者先 `node -e import('./src/index.ts')` 试装载再判红。★ 与坑 26/19/21 同族：**“我以为的环境”与“真实的环境”不一致**。 |
| **32** | ★ **服务启动后的第一次抽取会白等 ~68 秒**（UI 显示“运行中”，用户以为卡死）—— **待办，未做** | **真因**：`handlers.ts::runExtraction` 第一步 `await availability()` → `resolveExtractorAvailability()` → `extractor.available()` → `providers.capabilities({ deep: true })` = **一次真 LLM 探测**（进程内缓存）。<br>**实测证据**：任务 719ms 就 `running`，但**第一次 `completeJson` 在 67,986ms**；worker `extract.plan` = 0.6s、Node `runner.raw(extract.plan)` = 613ms ⟹ **不是 worker/plan 慢**。<br>**候选**：A 启动时异步预热（不阻塞首个请求）· B 抽取路径用轻量判据（配置齐 + 上次探测结果），**但不许假装可用**（坑 10）· C 如实显示“正在检测模型可用性（首次约 1 分钟）”。**倾向 A**。<br>**判据**：启动后第一次抽取的**首个 LLM 调用延迟 ≤ 2s**。<br>**测试含义**：任何跑真抽取的测试都会被拖慢 → 注入抽取器 + 桩掉 `resolveExtractorAvailability`（实测 30–70s → **2.5s**）。 |
| **33** | ★★ **provider/协议层的“文档承诺”不是保证** —— 改行为前**先用最小样例探一次真端点** | **判据：改 provider/协议层行为前，先发一次最小请求验证端点的真实能力。**<br>**实证（本轮）**：文档/惯例说 `json_schema` + `strict:true` 必强制；实测同一端点：**裸 schema + strict:true → 200（strict 被忽略）**，而**真 strict schema → 400**（`This response_format type is unavailable now`）。<br>★★ **若直接按“补 strictify”改代码 → 每一次抽取都会 400（全量打挂）**；**先用最小样例探一次就拦住了**。<br>**配套**：能力上报（如 `structuredOutput`）**不许无条件 true** —— 必须来自**真探测/真调用结果**（坑 10 + 坑 24 合体：“能配”≠“真的生效”）。<br>**同族**：坑 24（死旋钮）· 坑 21（抓了但没上报 = 等于没抓）。 |
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
