# Python Worker —— CLI + 严格 JSONL 协议

> **架构 v2 定位**（`docs/ARCHITECTURE_V2.md` §3）：后端主体是 **TS/Node**，
> Python 只做「成熟库不可替代」的事：**PDF/PPTX/DOCX 解析**、**本地 ASR**、抽帧。
> 本文是 **worker ↔ Node 的调用契约**（唯一的跨语言接口）。

- 入口：`python -m worker.cli`
- 契约：`docs/ARCHITECTURE_V2.md` §3.1（事件格式）+ `docs/API_PROTOCOL.md`（数据模型/spans）
- 版本：`--version` → `worker 2.0.0`

---

## 1. 安装

```powershell
cd course-kb
python -m pip install -r worker/requirements.txt
python -m worker.cli --help        # 可用性自检（M0 验收项）
python -m worker.cli --list-jobs   # 机器可读的 job 清单
```

---

## 2. 调用方式

```text
spawn("python", ["-m", "worker.cli", "--job", "parse", "--in", "<json|path>"],
      { cwd: <course-kb 根> })
stdin:  同一个 JSON（可再写一遍 + "\n" 后关闭）
stdout: 严格 JSONL（一行一个 JSON）
stderr: 日志（**不是协议**）
```

三种入参来源 **都支持**（任一可用即可）：

| 传法 | 适用 |
|---|---|
| `--in '<内联 JSON>'` | 小 payload（**Windows argv 上限约 32KB**） |
| `--in <文件路径>` | 大 payload（推荐给 Node：先写临时文件） |
| stdin（缺省） | 大 payload（**推荐**，无长度限制） |

> ⚠️ **实测踩到**：把 `units` 数组（几十 KB）塞进 `--in` 会直接
> `WinError 206 文件名或扩展名太长` —— 这是 **OS 限制**，不是 worker 的问题。
> **大 payload 一律走 stdin 或 `--in <file>`**。

`job` 可写在 JSON 里，或用 `--job` 指定（`--job` 优先）。
嵌套的 `input` 会被摊平：`{"job":"asr","input":{"op":"probe"}}` ≡ `{"job":"asr","op":"probe"}`。

---

## 3. stdout 协议（**硬约束**）

一行一个 JSON，**行尾 `\n`**，5 种事件：

```json
{"type":"progress","stage":"parse","frac":0.42,"detail":{"page":1040}}
{"type":"log","level":"info","msg":"..."}
{"type":"unit","data":{...}}
{"type":"result","data":{...}}
{"type":"error","code":"E_PARSE","msg":"...","detail":"..."}
```

| # | 规则 | 为什么 |
|---|---|---|
| 1 | **帧内绝无裸换行**（`json.dumps` 自动转义） | 按 `0x0A` 切帧才可靠 |
| 2 | 输出 **纯 ASCII**（`ensure_ascii=True`，中文 → `\uXXXX`） | 任何读取器都不会被多字节字符坑到 |
| 3 | **成功必须发 `result` + exit 0**；只退出不发 `result` = 协议不完整 | 调用方要能区分"完成"与"崩了" |
| 4 | `frac` 是 **数字** ∈ [0,1]，`stage` 是 **字符串** | 否则整帧判坏 |
| 5 | **stdout 只走协议** | 外壳把任务期间的 `sys.stdout` 重定向到 stderr，第三方库 `print()` 不会污染协议 |
| 6 | **不要用 Node `readline`**（坑 T3）：`U+2028/U+2029` 在 JSON 串里合法 | 会被错切成 2 帧；按 `\n` 切**字节** |

**退出码**：

| code | 含义 |
|---|---|
| 0 | 成功（**可能带降级**，降级信息在 `result.data` 里，如 `degraded[]` / `ok:false` 的子字段） |
| 1 | 任务失败（已发 `error` 帧；含未知 job） |
| 2 | 入参错误（不是合法 JSON / 缺字段） |
| 130 | 被中断（SIGINT） |

---

## 4. job 一览

| job | 作用 | 归谁 |
|---|---|---|
| `parse` | 文件 → 层次化 units（PDF/PPTX/DOCX/TXT） | T-WORKER |
| `units` | 单元划分（递归下降 + 引言段 + 切窗，坑 5） | T-WORKER |
| `extract.plan` | 产出逐单元**提示词 + json_schema**（Node 自己调 LLM） | T-WORKER |
| `extract.convert` | 模型输出 → **校验并转成**卡片/实体/边 | T-WORKER |
| `extract` | units → 卡片 + 图谱（**worker 内**调 LLM，`llm` 配置从参数来） | T-WORKER |
| `xref` | 交叉引用（mention 假阳性过滤，坑 6/7） | T-WORKER |
| `index` | bigram 检索行（坑 15） | T-WORKER |
| `search` | 查询词 → bigram 词项 + FTS5 `MATCH` 表达式 | T-WORKER |
| `asr` | 本地 ASR：`op=probe` 真探测 / `op=transcribe` 转写 | T-WORKER（实现 T2） |
| `rollup.plan` / `rollup.convert` | S2 汇总（与 extract 同构：提示词 / 校验转换） | T-WORKER |
| `sandbox.*` | 学生 SQL 沙箱（8 个 job，见 §10） | T-WORKER |
| `video.*` | 视频管线整包转 `worker/video/job.py::run_job` | T2 video-pipeline |
| `ping` | 自检：返回版本 + job 列表 | T-WORKER |

---

## 5. LLM 归属：两种分工都支持（**推荐 A**）

架构 v2 §3：**LLM 调用不留在 worker**（provider 选择/凭据/成本归 Node）。

### (A) 推荐：Node 调模型，worker 管"提示词 + 枚举 + 转换"

```jsonc
// ① 取提示词与 schema（worker 不联网）
{"job":"extract.plan","units":[...],"source_name":"MySQL 26.7 Reference Manual"}
// → result.data = {schema:{...}, optional_fields:[...], pick:{...},
//                  items:[{key,unit_key,unit_ord,unit_id,title,span,chars,system,user}...]}

// ② Node 用 provider.completeJson(schema) 逐 item 调用（json_schema + strict，坑 4）

// ③ 把模型输出交回 worker 校验/转换
{"job":"extract.convert","doc_id":"doc_xxx","units":[...],
 "payloads":[{"key":"unt_x#page:1-4","data":{section,cards,entities,edges}}]}
// → result.data = {ok:true, error_count:0, cards:[...], entities:[...], edges:[...],
//                  sections:{...}, stats:{...}, errors:[...]}
```

### (A2) S2 汇总：`rollup.plan` / `rollup.convert`（与 extract 同构）

自底向上汇总**只做归纳**，所以它同样拆成"worker 出提示词 → Node 调模型 → worker 校验转换"，
提示词与 `section_role` 枚举**只有一份实现**（`worker/pipeline/rollup_core.py`）。

```jsonc
// ① 逐节点取提示词（nodes = 内部节点，子节点摘要已在 children 里）
{"job":"rollup.plan","nodes":[
  {"id":"unt_ch10","title":"Chapter 10 Optimization","level":1,
   "children":[{"title":"10.1 Optimization Overview","intro":"优化总览",
                "key_takeaways":["先测再调"],"n_cards":3}]}]}
// → {"order":"caller","schema":{...},          ← ★ 裸 schema（无 {name,schema} 包装）
//    "items":[{"key":"unt_ch10#node","node_id":"unt_ch10","title":...,"level":1,
//              "n_children":1,"has_self_intro":false,"system":"...","user":"..."}],
//    "nodes_total":1,"internal_nodes":1,"skipped_titles":[],"skipped_nodes":0}

// ② Node 侧：response_format = {type:"json_schema", json_schema:{name:"rollup", strict:true,
//    schema: plan.schema}}   ← 包装由调用方补，worker 只给裸 schema

// ③ 交回校验/转换
{"job":"rollup.convert","payloads":[{"key":"unt_ch10#node","data":{
   "intro":"...","why_important":"...","objectives":["..."],
   "key_takeaways":["..."],"section_role":"concept_intro"}}]}
// → {"ok":true,"error_count":0,"converted":1,
//    "rollups":{"unt_ch10":{"intro":...,"why_important":...,"objectives":[...],
//                           "key_takeaways":[...],"section_role":"concept_intro"}},
//    "errors":[]}
```

规则（与 `extract.*` 完全对齐）：

| 项 | 行为 |
|---|---|
| key 语法 | **`<node_id>#node`** —— 与抽取侧共用 `make_node_key()`/`parse_key()`（**没有第二套解析器**） |
| `schema` | **裸的**：只有 `type/properties/required/additionalProperties`，**没有** `{name, schema}` 包装 |
| `section_role` | **可选**（strict 下写成 `["string","null"]`）；空值→**不写该字段**；非枚举值→逐条报错 |
| 缺 `node_id`/key 不可解析 | 记 `E_ROLLUP_KEY` 并跳过该条 |
| 校验失败 | 记 `E_ROLLUP_SCHEMA` + 具体违规（`缺必填字段 'why_important'` / `'x' 不在枚举 [...]`） |
| `nodes` 入参 | `rollup.convert` **只读 `payloads`**（多传 `nodes` 被忽略，不报错） |
| 失败语义 | 部分成功 → `exit 0` + `ok:false` + `error_count>0`；**一条都没成功 → `exit 1`（`E_ROLLUP_KEY`）** |
| `skip_titles` | 同 `extract.plan`：正则数组，命中节点**连同子树**跳过，回报 `skipped_titles`/`skipped_nodes` |

#### 选项：`skip_titles`（显式跳过整棵子树）`n`n> ⚠️ 汇总节点的**处理顺序由调用方决定**（`order:"caller"`）：汇总必须"子节点已有摘要"才能做，
> 即按深度**从深到浅**传；worker 不猜顺序，也不替调用方做拓扑排序。



`items` 的顺序是 **文档顺序**（根节点按 `ord` 遍历 → 递归下降），
所以前几个 item 往往是**标题页 / 前言 / 版权页** —— 抽取它们当然抽不到 SQL 示例，
这不是缺陷（那几页本来就该是 `concept`/`other`、也本来没有示例）。

要让技术章节先出现，两种做法：

```jsonc
// ① worker 侧显式过滤（匹配的标题**连同子树**一起跳过，并如实回报）
{"job":"extract.plan","units":[...],
 "skip_titles":["^Preface","Legal Notices","^Chapter 1\\b"]}
// → result.data 额外含：order:"document", skipped_titles:[...], skipped_items:N, skipped_units:M

// ② 调用方自己按 items[].span.start / title / level 排序（worker 不动顺序）
```

* **默认不跳过任何东西** —— 不做隐式魔法；`parse` 只排除公认非内容章（索引/术语表，且记进 `meta.parse.skipped_roots`）。
* 只丢父节点会**让子节点变成孤儿**（在 picker 里被当成新根、还各生一段引言）→
  所以 `skip_titles` 丢弃的是**整棵子树**（实测踩过）。



```
<unit_id>#<span.kind>:<span.start>-<span.end>          例如  unt_837da438aead#page:1-4
```

* **只有一个实现**：`worker/pipeline/extract_core.py::make_key()` / `parse_key()`；
  两侧都调用它们，**不要各写一份**。* `key` 里含 `unit_id`；若 Node 在 plan 与 convert 之间换过 `doc_id`，
  仍可匹配 —— `convert` 会**逐级放宽**：
  `key` → `unit_key`（ord 派生，不含 doc_id）→ `unit_id` → **仅 span** (`page:1-4`)。
* `parse` 输出的 units 没有 `id`（UnitDraft 形状）→ worker 用
  `synth_unit_id(ord)`（**与 doc_id 无关**）补齐，保证两次独立调用拿到同一批 id。

> ⚠️ **实测踩过的坑**：早期 `key` 里嵌了"按 `doc_id` 派生的合成 id"，
> 于是 plan（未传 doc_id）与 convert（传了 `d1`）对不上 →
> **LLM 真花了额度抽出卡片，convert 全部丢弃，且 exit=0**。
> 现在的修法：①合成 id 与 doc_id 无关；②convert 有 span 兜底；③见下"失败要响"。

#### 失败要响（不许静默）

| 情况 | `data.ok` | `error_count` | 退出码 |
|---|---|---|---|
| 全部转换成功 | `true` | 0 | 0 |
| 部分成功（有 payload 对不上） | `false` | >0 | 0（**但 ok=false 必须被调用方看到**） |
| 有 payload 但**一个都没匹配上** | — | >0 | **1**（`E_PICK_KEY`） |

调用方**不要只看 `cards`**：`cards=0` + `ok=true` 才是"这篇确实没有知识点"。

好处：**提示词/封闭枚举/转换规则只有 worker 一份实现**（不会在 TS 里抄漂移），
而且 provider 凭据**不必下发子进程**。

### (B) 也可以：worker 内调 LLM（用于回归/离线批处理）

```jsonc
{"job":"extract","doc_id":"doc_xxx","units":[...],
 "llm":{"base_url":"https://.../v1","api_key":"...","model":"deepseek-v4.1-flash"},
 "checkpoint_file":"data/ckpt/doc_xxx.json","resume":true,"max_units":50}
```

- **凭据只走参数**（worker **不读 `.env`/环境变量**；`llm.py` 的 `LLMConfig` 是唯一入口）
- `api_key` **绝不进日志/事件**（日志里只出现 `api_key_set: true`）
- **并发 = 1**（硬要求：`LLMClient` 用全局锁串行化，`max_inflight` 恒为 1）
- 结构化输出强制 `json_schema` + `strict:true` + `additionalProperties:false`

---

## 6. job 详情

### 6.1 `parse`

```jsonc
// 入参
{"job":"parse","path":"D:/.../refman.pdf","stream_units":true,
 "max_pages":0,            // >0 只解析前 N 页（调试）
 "max_pages_per_unit":8,   // PDF：每个 unit 只存前 N 页正文（大章只留引言段）
 "kind":"pdf"}             // 可选：强制 adapter
```

```jsonc
// result.data
{"document":{"title":"...","kind":"pdf","page_count":6392,"lang":"en",
             "meta":{"parse":{"toc_entries":2545,"kept_nodes":2501,"skipped_nodes":44,
                              "skipped_roots":["Table of Contents","MySQL Glossary"],
                              "excluded_ranges":[[...]],"coverage_rate":1.0,
                              "synthetic_units":1,"mode":"toc",
                              "text_capped_units":50}}},
 "units":[{"ord":1,"title":"Chapter 1 General Information","level":1,"parent_ord":null,
           "span":{"kind":"page","start":31,"end":57},"text":"...","text_len":8421}],
 "stats":{"units":2502,"chars":...,"roots":...,"max_level":6,
          "parse_mode":"toc","skipped_nodes":44,"streamed_units":0}}
```

- 每个 unit 若 `stream_units=true` 会额外发一个 `{"type":"unit","data":{...}}` 帧（大文档流式入库）
- `span.kind ∈ page|slide|time|char`，**可回溯原文**（契约 §2.2）
- 非内容章（索引/术语表）**被排除但在 meta 里如实列出**（坑 3，不静默丢页）

### 6.2 `units`（坑 5）

```jsonc
{"job":"units","units":[...],"max_pages":8,"pages_total":6392,"excluded_ranges":[[11,12]]}
// → {"picked":[{ord,unit_id,title,level,kind,span,chars,text(截断)}...],
//    "stats":{"pages_total":..,"content_units":..,"coverage":1.0,"missing_count":0,
//             "n_picked":..,"n_section":..,"n_intro":..,"n_window":..}}
```

`coverage == 1.0 && missing_count == 0` 表示**没有任何内容被丢**。
单元划分规则：**递归下降 + 父节点引言段 + 大跨度切窗**（旧算法"跨度 > N 既不选也不下钻"会整片丢页，
`worker/pipeline/units.py::pick_units_legacy` 保留了旧算法专门做对照）。

### 6.3 `xref`（坑 6/7）

```jsonc
{"job":"xref","cards":[...],"units":[...],"entities":[...],"edges":[...]}
// → {"xrefs":[{from_card_id,to_card_id,rel,weight}...],
//    "stats":{"total":..,"typed":..,"mention":..,"also_in":..,"same_unit":..,
//             "noise_hits":{"use":1,"and":1},"self_refs_skipped":..}}
```

`rel ∈ typed|mention|also_in|same_unit`（顺序即优先级）。
mention 过滤规则**逐字照抄契约 §2.5**：`USE`/`AND` 等 NOISE 词被拒（实测不过滤会被引 198/183 次）。

### 6.4 `index` / `search`（坑 15）

```jsonc
{"job":"index","cards":[...],"units":[...]}
// → {"rows":[{"id":"card:crd_x","doc_id":..,"ref_id":..,"kind":"card",
//             "title":"聚簇索引","body_bi":"聚簇 簇索 索引 ..."}],"counts":{...}}

{"job":"search","q":"索引优化"}
// → {"terms":["索引","引优","优化"],"match_expr":"\"索引\" AND \"引优\" AND \"优化\""}
{"job":"search","mode":"bigram","texts":["索引优化"]}
// → {"bigrams":["索引 引优 优化"]}
```

- Node 侧用 `body_bi` 建 `fts5` 表，用 `match_expr` 执行 `WHERE search_fts MATCH ?`
- **`unicode61` 对中文 0 命中**（实测），所以必须存 bigram；`trigram` 会丢 2 字词
- ⚠️ **坑 16（跨语言提醒）**：FTS5 增量更新时，`'delete'` 指令必须传**旧行的全部列值**
  （v1 `_legacy/store/db.py::fts_upsert` 传了新值 → 旧词条不移除 → 静默脏索引）。
  worker 只产出索引行，不做 FTS DML；**更新逻辑在 TS 侧，务必按上述语义**。

### 6.5 `asr`（本地 ASR，诚实探测）

```jsonc
{"job":"asr","input":{"op":"probe","model":"tiny","compute_type":"int8","device":"cpu"}}
// → {"type":"result","data":{"ok":true,"model":"tiny","device":"cpu",
//                            "compute_type":"int8","requested_model":"tiny","degraded":false}}
// 加载失败 → {"ok":false,"reason":"模型未下载/加载失败…","code":"E_ASR_LOAD"}   ← 绝不假装 ok

{"job":"asr","input":{"op":"transcribe","audio_path":"...wav","model":"tiny",
                      "language":"zh","word_timestamps":true}}
// → {"segments":[{"i":0,"startMs":0,"endMs":1200,"text":"…","confidence":0.91}],
//    "language":"zh","model":"faster-whisper/tiny","durationMs":300002,
//    "chunks_total":1,"chunks_done":1,"chunks_resumed":0,"elapsedMs":12345}
```

- `probe` **真的加载一次模型**（不改状态、不产文本）；降级到链上其它模型时 `degraded:true` + `reason`
- `transcribe` 默认**分段 + 断点续跑**（`work_dir` / `resume` 可配）
- 长音频会发 `progress` 帧（`frac` 单调）

### 6.6 `video.*`

整包转交 `worker/video/job.py::run_job(payload, emit) -> int`（T2）：
`video.parse` / `video.caps` / `video.manual_subtitles`。
worker 外壳统一保证协议格式与退出码。

---

## 7. 断点续跑（C4/C5）

| 场景 | 断点文件 | 语义 |
|---|---|---|
| `extract` | `payload.checkpoint_file` | 每单元落盘；`resume:true` 跳过已完成单元；**原子替换**（先写 `.tmp` 再 `os.replace`） |
| `asr` | `<work_dir>/asr.ckpt.json` | 按音频指纹 + 分块；最长 1 小时的视频可中断续跑 |

断点键：`<unit_id>#<span.kind>:<start>-<end>`（同一单元被切成多个窗时各算一件）。

---

## 8. 保留的坑（**别退化**）

| # | 坑 | 落点 |
|---|---|---|
| 4 | `json_object` 不强制 enum | `pipeline/llm.py::strictify` + 重试；非法 kind 丢弃并计数 |
| 5 | 单元划分丢页 | `pipeline/units.py::pick_units`（递归下降 + 引言段 + 切窗） |
| 6 | mention 假阳性 | `pipeline/xref.py::mention_ok`（NOISE 集合逐字照抄契约） |
| 7 | 自引用 | `xref.is_self`（去尾部 `()` 再比） |
| 15 | 中文检索 0 命中 | `pipeline/search.py::to_bigram`（英文保持整词） |
| 16 | FTS5 增量更新留脏索引 | 见 §6.4（TS 侧执行 DML 时遵守） |
| T3 | JSONL 不能用 readline | 见 §3（纯 ASCII + 按 `\n` 切字节） |

---

## 9. 不做什么（边界）

- **不碰存储**：worker 不连课程知识库的 SQLite、不写数据库（TS 负责）
- **不读凭据**：LLM/云 ASR 凭据一律从 job 参数来（Node 下发）
- **不编排**：任务队列/SSE/重试策略在 Node；worker 只做一次"输入 → 输出"
- **不假装成功**：能力不足一律 `{ok:false, reason}` 或 `error` 帧（铁律 R3）

---

## 10. 学生 SQL 沙箱（`sandbox.*`）

契约：`docs/SETTINGS_AND_SANDBOX.md` §3 + **`docs/LAB_DB_DEPLOY.md`**（引擎抽象 / CRUD / 日志）。

**为什么执行放 worker**：`better-sqlite3` 是**同步**的 —— 学生在浏览器里跑
`WITH RECURSIVE` 死循环会**卡死 Node 事件循环**（`/health` 不再响应）。
所以每次执行都在**独立子进程**里，父进程用 `subprocess(timeout=)` + `kill()`
做**进程级硬超时**（三层：SQLite `progress_handler` → 子进程 deadline → **父进程 kill**）。

### 10.1 job 一览

| job | 入参 | 出参要点 |
|---|---|---|
| `sandbox.engines` | `{root?}` | 逐引擎**真探测**上报 + 日志源能力；不可用必给 `reason` + 文档章节 |
| `sandbox.datasets` | `{with_sql?}` | `sc` / `employees` / `orders`（含教学点与方言说明） |
| `sandbox.init` | `{user_id, session_id, dataset?, root?}` | 建/取会话；`created` 区分"新建/复用"；带 `schema` + `capabilities` |
| `sandbox.reset` | 同上 | **真 reset**：先 DROP 掉库里**所有**用户表，再重建数据集 |
| `sandbox.exec` | `{user_id, session_id, sql, multi?, max_rows?, timeout_ms?}` | `{columns, rows, rowCount, truncated, elapsedMs, affected?, ok, error?}` |
| `sandbox.schema` | `{user_id, session_id, with_text?}` | `{dialect, tables:[{name, columns:[{name,type,pk,notnull,fk}], rows}]}` |
| `sandbox.history` | `{user_id, session_id, limit?, request_user_id?}` | `[{at, sql, ok, error?, rowCount?, elapsedMs?}]`（**只读 + 隔离**） |
| `sandbox.logs` | `{…, limit?, since?, with_text?, request_user_id?}` | `{source, entries:[LogEntry], count, boundary?, text?}`（L1） |

### 10.2 安全（**每条都有负例测试**）

| 手段 | 实现 |
|---|---|
| **路径隔离** | 库只能是 `data/sandbox/<user>/<session>.sqlite3`；`resolve()` 后判前缀；id 仅允许字母数字下划线连字符汉字（挡 `..`、`/`、Windows 保留名） |
| **不信任客户端 `db_path`** | 引擎只用 `user_id`+`session_id` 推导路径；不一致 → `E_SANDBOX_PATH`（exit 2）；自省/日志同样过路径闸 |
| **单条语句** | 字符串/注释外的第二个 `;` → `E_SQL_MULTI` |
| **批次（事务实验）** | `multi:true` 时**逐条**过同一个闸（`BEGIN; UPDATE…; ROLLBACK;`） |
| **禁 `ATTACH`/`DETACH`** | 词法闸 + SQLite `set_authorizer`（两道） |
| **禁 `load_extension`** | 词法闸 + `enable_load_extension(False)` + authorizer |
| **PRAGMA 白名单** | 只放只读自省类；`writable_schema`/`temp_store_directory`/`journal_mode` 直接拒 |
| **其他引擎越权面** | `LOAD DATA`/`INTO OUTFILE`/`pg_read_file`/`COPY…PROGRAM`/`lo_import` 全拒（服务器类引擎接入后同样适用） |
| **外键固定开启** | 装 authorizer 之前 `PRAGMA foreign_keys=ON`（与 MySQL 对齐；学生不能关） |
| **行数/大小上限** | `max_rows`（默认 200，上限 5000）+ 库文件上限（超出 `ROLLBACK` + `E_SANDBOX_SIZE`） |
| **审计** | 每次执行（含**被闸拒绝**的）O_APPEND 到 `<session>.audit.jsonl`（进程被杀也不丢） |
| **日志隔离 + 脱敏** | `request_user_id` 必须等于会话所有者；所有文本过 `redact()` |

### 10.3 错误语义（Node 侧请注意）

* **学生 SQL 写错** → `sandbox.exec` 仍 **exit 0**，错误在 `data.error`（`ok:false`）。
  这是"这条 SQL 失败"，不是"job 失败" —— UI 要展示给学生。
* `data.error = {code, message, raw, hint, localReading, localMatched, killedBy?, hardKilled?}`
  * **`message` 是引擎原文一字不改**（`near "FROM": syntax error`、`no such table: student`）；
  * `localReading`/`hint` 是**本地确定性解读**（模型不可用时也能诚实降级）。
* **超时**：`E_SQL_TIMEOUT`；`killedBy: "progress"`（SQLite 层先中断）或 `"process"`
  （**父进程硬杀**，`hardKilled:true`）；两种情况都不阻塞后续执行。
  * 这条信息**也落进审计**：`sandbox.history` 的记录带 `killedBy`/`hardKilled`/`timeoutMs`，
    `sandbox.logs` 的 `entry.context` 同样带 —— S4 才能准确说"你的递归 CTE 是被超时
    停掉的，不是语法错"。**`hardKilled` 与 `killedBy` 恒自洽**（`progress` ⇒ `false`，
    `process` ⇒ `true`，有断言）。
  * 超时条目的 `hint` 是**确定性**文案（递归要有终止条件 + 先加 LIMIT 试小范围），
    不靠正则去匹配人话文本。
* **入参/路径类** → exit **2**（`E_SANDBOX_PATH` / `E_PAYLOAD`）；
  **引擎不可用** → exit **1** + `E_ENGINE_UNAVAILABLE`（reason 指向部署文档）。

### 10.4 引擎可插拔 + 日志源

* `DatabaseEngine`（`engine.py`）与 `LogSource`（`logs.py`）是**两个并列契约**，
  注册方式一致；**加引擎/日志源 = 注册一个对象**，上层不改（测试用"假引擎"证明）。
* 默认 **SQLite**（`embedded`，永远可用）；MySQL / PostgreSQL / openGauss
  **只做诚实降级**：`available:false` + 原因 + 指向 `docs/LAB_DB_DEPLOY.md` §4.x。
  配置读 `scripts/deploy-lab-db.sh` 写的 `.env`
  （`LAB_DB_ENGINE` / `LAB_DB_HOST` / `LAB_DB_PORT` / `LAB_DB_NAME` / `LAB_DB_USER`
  + `LAB_PG_PASSWORD` / `LAB_MYSQL_PASSWORD` / `LAB_OG_PASSWORD`）——
  **密码只判断"在不在"，绝不读取/落盘/进事件流**。
* 日志层次：SQLite **只有 L1**（引擎原文报错 + 我们的 audit_log）；
  **没有 L2/L3**（嵌入式引擎无实例视图、无日志文件）→ `boundary` 字段明确要求 agent
  「读不到引擎日志就如实说，不许假装看过」。
