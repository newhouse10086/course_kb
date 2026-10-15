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

### 2.1 ★ 输入编码：三条路径都**显式 UTF-8**（不看语言环境）

| 路径 | 实现 | 说明 |
|---|---|---|
| `--in '<内联 JSON>'`（argv） | Python 在 Windows 用宽字符 API 取 argv | 中文安全 |
| `--in <文件>` | `worker/stdio.py::read_text_file` | **按 BOM 判编码**，无 BOM 则 UTF-8 **strict** |
| stdin（大 payload 的推荐通道，坑 18） | `worker/stdio.py::read_stdin_text`（读 `sys.stdin.buffer`） | **绝不**用 `sys.stdin.read()` |

**为什么必须显式**：`sys.stdin.read()` 按**语言环境编码**解码 —— Windows 中文机是 **GBK**。
于是"我们推荐的 stdin 大 payload 通道"在中文内容下**必然乱码**，而且**看起来成功**：
坏字节被解成 `任?` / `?务`，JSON 照样能解析 → 一路写进库。
实测对照（同一份 UTF-8 字节喂 stdin）：

```
默认（GBK 解码）          terms = ['任?', '?务']      ← 静默错
PYTHONIOENCODING=utf-8   terms = ['任务']            ← 对
```

**`errors=` 策略：`strict`（不是 `replace`）** —— 这是有意的取舍：

* `replace` 把坏字节变成 `?`/U+FFFD **而不报错**。若坏字节落在 JSON 字符串值里，
  `json.loads` **照样成功** → 内容被悄悄改坏、零信号（正是上面那个 bug 的表现）。
* 若坏字节落在 JSON 结构里，报的是"JSON 语法错"，把**编码问题**误诊成**格式问题**，排查方向全错。
* 编码错误几乎总是上游真的错了（非 UTF-8 写入 / 流被截断 / 二次编码）→
  **明确失败 + 指出第几字节**才可修。

所以坏字节 → `E_PAYLOAD`（退出码 2）+ 精确信息：

```jsonc
{"type":"error","code":"E_PAYLOAD",
 "msg":"stdin 不是合法 UTF-8：第 21 字节起解码失败（invalid continuation byte）—— 常见原因：上游用系统默认编码写的（Windows 中文机是 GBK），或字节流被截断",
 "detail":"坏字节：b'\\xc8\\xce'（hex c8ce）；总长度 26 字节。修法：以 UTF-8 写入（Node 用 Buffer.from(json,'utf8')…）"}
```

**BOM**：按 BOM 判编码（`utf-8-sig` / `utf-16-le` / `utf-16-be` / `utf-32-*`）——
Windows 编辑器与 `Set-Content -Encoding Unicode` 常写 BOM。
**无 BOM 的 UTF-16 不做猜测**（猜编码会引入更隐蔽的错误）→ 明确失败并提示。
（实现细节：用显式 codec 解 UTF-16 时 BOM 会留在文本里变成 U+FEFF、`json.loads` 会报
"Unexpected UTF-8 BOM" → `stdio.decode_payload_bytes` 统一剥一次。）

**stderr**：`main()` 调 `stdio.configure_stdio_utf8()` 把日志流设为 UTF-8
（`errors="backslashreplace"`：日志宁可出现转义也不能因编码崩）。**stdout 不动** ——
协议输出是 `sys.stdout.buffer` 的纯 ASCII 字节（见 §3）。

> ⚠️ **测试必须造敌意环境**：历史上这个 bug 之所以长期没被发现，是因为开发机的 shell
> 设了 `PYTHONIOENCODING=utf-8` → 测试进程继承它 → 在"恰好正确"的环境里全绿。
> `worker/tests/test_cli.py::_hostile_env()` 现在**清掉** `PYTHONIOENCODING`/`PYTHONUTF8`
> 并设 `PYTHONUTF8=0`，全量套件在该环境下也必须全绿（实测 499 passed）。
> 同一类 bug 还有**第二处**：`worker/sandbox/runner.py` 也从 stdin 读 payload ——
> 已一并修为显式 UTF-8（`test_runner_stdin_is_explicit_utf8` 在敌意环境下直连 runner 验证）。

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

#### ★ `status` / `warnings`：把"成功但零产出"与"失败"分开

`extract` / `extract.convert` 的 `result.data` 里除了 `ok`/`error_count` 还有：

| `status` | 含义 | `ok` | 退出码 |
|---|---|---|---|
| `done` | 有卡片产出 | true | 0 |
| **`done_empty`** | **全部成功但一张卡都没有** —— 内容不足（模型合理地只返回 `section`） | true | 0 |
| `partial` | 有失败也有成功 | false | 0 |
| `failed` | 全失败（含"一个 payload 都没匹配上"） | false | 1 |

`done_empty` **不是错误**（模型拒绝抽取可以是对的：原文只有一句定义式陈述），
但它**必须**与"抽取失败""管线丢卡"在返回值上区分 —— 否则前端只能把空知识库
当正常完成展示，用户分不清"内容太少"和"系统坏了"（polysemy-prober 独立验收抓到）。

配套的 `warnings[]`（`done_empty` 时必有）：

```jsonc
{"code":"W_NO_CARDS", "unit_id":"unt_…", "title":"索引简介", "span":{...},
 "cards_key":"missing",     // missing=模型主动省略该键（内容不足）；empty=给了空数组
 "model_note":"本节只有一句定义式陈述……不足以支撑任何操作层面的结论。",
 "msg":"模型返回的 section 合法，但**没有产出任何卡片**（`cards` 键缺失 …）；模型说明：…"}
```
`model_note` 直接取自模型的 `section_summary` —— 它往往正好解释了
"为什么抽不出知识点"，前端可直接显示给用户。

> ⚠️ **两条路径的差异**（别混淆）：
> * **B：worker 内调 LLM**（`extract`）—— strict schema **要求** `cards` 键，
>   模型省略它 → 重试 3 次 → **失败**（`status:"failed"`）。本来就响。
> * **A：Node 调模型**（`extract.plan` → `extract.convert`）—— 模型输出未经 strict
>   校验就回传 → 第一版**静默**；现在 `status:"done_empty"` + `warnings`。
> * `stats.units_no_cards` 计数这类单元，便于看"是整篇内容少还是个别的少"。

#### ★ LLM 错误码：把"推理吃光预算 / 上游过载 / 输出不合规"分开

契约 §0 明确要求「`content` 为空但 `reasoning_content` 非空 → **显式报错**，不许当成功」。
推理模型的 reasoning token **计入输出预算**（实测：8 字回复用掉 54 个推理 token），
所以预算太小时 `content` 为空、`finish_reason=length` —— **只判 HTTP 200 就会假绿**。

| 错误码 | 触发 | 处置 |
|---|---|---|
| `E_LLM` | 未配置凭据 / 4xx（401/402/403/404/429） | 配置或等额度；`402` 会触发抽取**中断**（`E_LLM_ABORT`） |
| **`E_LLM_EMPTY_CONTENT`** | `content` 为空（空白也算）——**不算成功** | `detail` 带 `finish_reason`/tokens/`reasoning_chars`；**提高 `max_tokens`**（结构化抽取 ≥2000，探测 ≥500） |
| **`E_LLM_BAD_JSON`** | 输出不是 JSON（可能被截断） | 看 `finish_reason=length` → 提高预算；否则查提示词 |
| **`E_LLM_UPSTREAM`** | 上游 5xx / 网络故障（`retryable=true`） | **重试即可**；`detail` 保留 `HTTP 503` + body 片段（如 `Service Overload`） |
| `E_LLM_SCHEMA` | JSON 合法但字段/枚举不合规（重试后仍错） | 改 schema/提示词；`detail` 列出违规项 |

> 这些检查在 `_call` 里做 → **真 HTTP 与注入 transport 两条路径都覆盖**
> （第一版只在 `_http_call` 里查，注入替身会绕过）。
> 顺带一个教训：我第一次重构 `_call` 时**多留了一份定义**，把"并发=1 的锁"覆盖掉了 ——
> 是既有的 `test_llm_serialises_calls_under_threads`（断言 `max_inflight == 1`）当场抓住的。

**输出预算必须显式给**（`LLMConfig.max_tokens` 默认 8192；Node 传 `maxTokens` 即采纳，
`settings.json` 里是 16384）：推理 token **计入** `max_tokens`，省略它就是让 provider 的默认值
决定"能不能出内容"。判据是 **`content` 是否为空**，**不是** `finish_reason`
（实测 `length` 会出现但不保证总出现 → 只能当线索，所以原因描述写"很可能"而不下断言）。

> 真端点回归（`.env` 现指向推理端点 `llm-api.x-aio.com`）：`extract` 1 个单元 → **8 张卡片**、
> `status:"done"`、24.3s、`llm_calls:1` —— 显式预算下推理模型的结构化抽取正常。

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

#### ★ 证据逐字校验（`evidence_quote` / `evidence_text` 必须能在正文里找到）

**改前的事实**：本项目**没有**任何逐字校验 —— "必须逐字摘录"只是提示词里的一句话，
模型不照做没人知道（wiki-architect 的协调请求基于"已有校验"的假设，实际并不存在）。
现在它是**可断言的事实**：

| 判据 | 含义 | 是否可回溯 |
|---|---|---|
| `exact` | 引用是正文的**连续子串** | ✅ |
| `normalized` | 只在**空白/换行**上不同（PDF 抽文本会插换行） | ✅ |
| `rewritten` | 找不到，但与正文某段**高度重合**（≥0.6）→ 疑似**改写/润色** | ❌ |
| `fabricated` | 找不到，且无明显重合 → 疑似**编造** | ❌ |
| `missing` | `evidence_quote` 为空 | ❌ |

* **只归一空白，不动任何字符** —— 这是与"OCR/抽文本"有关的**唯一**假失败来源，已消除。
* 改写/编造用 `difflib` 的**全部匹配块之和**判定（只看最长块会把改写误判成编造）。
* **只告警，不丢卡片**：卡片内容可能仍然正确，丢掉 = 信息永久消失。调用方拿到的是
  `stats.quoteAudit[]`（逐条 `cardId/kind/similarity/textOrigin`）+ `warnings[]`
  （`W_EVIDENCE_NOT_VERBATIM`）+ `stats.cards_evidence_ok/bad`。
  若将来要求"证据不可回溯就不入库"，改 `record_quote_audit` 一行即可（但必须同时改统计口径）。

**★ 关于 OCR 的关键澄清**（与请求方的假设相反）：
校验对象是**我们喂给模型的那段正文**（`unit.text`）—— OCR 单元的 `unit.text` **就是** OCR 结果。
所以 **OCR 的错字不会造成"引用找不到"**：模型照着含错字的正文逐字抄，照样匹配（`exact`）。
真正会不匹配的是**模型自己改写了**（如"顺手修正"错字、翻译、压缩）——
而那正是提示词禁止的行为。实测（`worker/tests/test_pipeline.py`）：

```
OCR 正文 "索引是加速查绚的数据结构"（绚 = OCR 错字）
  模型照抄 "索引是加速查绚的数据结构"  → ok=True, kind=exact     ← OCR 不造成假失败
  模型"修正" "索引是加速查询的数据结构" → ok=False, kind=rewritten, sim=0.92  ← 被抓到
```

#### `text_origin`（来源标记）：**Node 只需转发 meta，worker 自己推导**

```jsonc
// 输入（可选，两者都可省）：extract / extract.plan / extract.convert
{"text_origin_pages": {"30": "ocr", "1": "native"},   // = documents.meta.text_origin_pages，原样转发
 "text_origin": "ocr"}                                 // 文档级兜底（整份扫描件）

// 输出：
//  · plan items[] 每项带 "text_origin": "ocr" | "native" | "mixed" | ""
//  · stats.quoteAudit[] 每条带 "textOrigin"
//  · 警告文案里会写明"该单元正文来自 OCR（更应逐字抄，不要修正）"
```
worker 按 **unit span 覆盖的页** 与逐页表求交：全 ocr → `ocr`，全 native → `native`，
混合 → `mixed`，拿不到 → `""`（**不猜、不编造**）。
**提示词用的是"一条通用约束"**（不按资料类型分身）→ `text_origin` **不是提示词开关**，
它是**诊断与前端标注**用的。

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
| `sandbox.exec` | `{user_id, session_id, sql, multi?, max_rows?, timeout_ms?}` | `{columns, rows, rowCount, truncated, elapsedMs, affected?, ok, error?}`；`multi:true` 时 `statements[]` 逐条回报；事务见 §10.1.1 |
| `sandbox.schema` | `{user_id, session_id, with_text?}` | `{dialect, tables:[{name, columns:[{name,type,pk,notnull,fk}], rows}]}` |
| `sandbox.history` | `{user_id, session_id, limit?, request_user_id?}` | `[{at, sql, ok, error?, rowCount?, elapsedMs?}]`（**只读 + 隔离**） |
| `sandbox.logs` | `{…, limit?, since?, with_text?, request_user_id?}` | `{source, entries:[LogEntry], count, boundary?, text?}`（L1） |

### 10.1.1 ★ 事务：**同一次执行内可用，跨调用不支持**（如实说明，别当成 bug 去"修"）

```jsonc
// ✅ 正确用法：整批语句放**同一次**请求（multi:true）—— 同进程同连接，语义完全正确
{"job":"sandbox.exec","sql":"BEGIN; INSERT INTO students(sid,sname) VALUES(555,'x'); ROLLBACK;",
 "multi":true, ...}
//   ROLLBACK 版：行数**不变**；COMMIT 版：行数 **+1**（两条都有测试）

// ❌ 跨调用（单发）会**被明确拒绝**，而不是假成功
{"job":"sandbox.exec","sql":"BEGIN"}       // → ok:false, error.code="E_SQL_UNSUPPORTED"
{"job":"sandbox.exec","sql":"ROLLBACK"}    // → 同上（不会出现"no transaction is active"这种底层错）
```

**为什么不做跨调用事务**（架构取舍，不是没做）：
每次执行都是**独立进程 + 独立连接**，这是**两条安全属性的前提** ——
① **硬超时能真杀**（`WITH RECURSIVE` 死循环不拖死服务）；② **学生之间天然隔离**（无共享连接状态）。
为了一个语法糖引入会话级长连接，等于**拿两条安全属性换一个便利**。→ 不换。

**原 bug（backend-api 独立复现）**：单发 `BEGIN` 报 `ok:true`、`INSERT` 报 `ok:true`、
随后 `ROLLBACK` 报 `cannot rollback - no transaction is active`，**而数据已被提交**
（期望 1 行、实际 2 行）—— "看起来成功"的最坏形态。现在单发即拒：

```jsonc
{"ok":false, "txUnsupported":true,
 "error":{"code":"E_SQL_UNSUPPORTED",
   "message":"沙箱每次执行都是独立进程，事务状态无法跨调用保留 → 单发的 BEGIN 不会生效（后续语句会被立即提交）",
   "localReading":"沙箱不支持**跨调用**事务（不是你的 SQL 写错了，也不是语法错）",
   "hint":"做事务实验请把整批语句放进**同一次**请求：{\"sql\":\"BEGIN; INSERT …; ROLLBACK;\",\"multi\":true}（已实测可用）；或用 sandbox.reset 恢复初始数据",
   "who":"rules"}}
```
`who:"rules"` = **规则限制，不是学生的错**（与 S4 的责任方枚举一致）。
`/capabilities` 也如实上报（**不再是裸 bool**）：

```jsonc
"capabilities": {"crud":true, "ddl":true, "procedures":false, "maxRowsDefault":200,
  "transactions": {"same_call":true, "cross_call":false, "batch_param":"multi",
    "note":"事务需在**同一次执行内**完成（每次 execute 独立进程 —— 这是硬超时强杀与学生隔离的前提）"}}
```

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

## 11. 多引擎沙箱：**已验证 / 未验证**清单（如实交付的一部分）

> 本机事实：**没有 MySQL / PostgreSQL / openGauss**，**没有 Docker**（不装）。
> 所以「未验证」里**能验的部分已全部验掉**（契约层、错误路径、脚本自检），
> 真连真跑的部分**列成可照做的步骤** —— 运维照着跑就能验，而不是只看到"未验证"四个字。

### 11.1 已在本机验证（真跑，不是推断）

| # | 项目 | 判据（实测） |
|---|---|---|
| 1 | 引擎注册表如实上报 | `sandbox.engines` → mysql/postgres/opengauss `available:false` + reason 指向 `docs/LAB_DB_DEPLOY.md §4.x`；sqlite `available:true` |
| 2 | **未安装引擎不静默回退** | 三引擎 `sandbox.exec` → **exit 1 + `E_ENGINE_UNAVAILABLE`**；且沙箱目录**没有产生任何文件**（回退的物理证据） |
| 3 | 方言标注与实际引擎一致 | `sandbox.init/schema/exec` 均报 `engine:"sqlite"` + `dialect:"sqlite"`；`schema` 指定 postgres → `E_ENGINE_UNAVAILABLE`（不拿 sqlite 的 schema 冒充） |
| 4 | 凭据如实报缺失、**绝不回显** | 设 `LAB_PG_PASSWORD=<秘密>` 跑 → 输出里**搜不到该值**；缺密码时 reason 点名 `LAB_MYSQL_PASSWORD` |
| 5 | 日志层能力如实 | `logSources`: sqlite `layers:["L1"]`、available；三 server 引擎 `layers:[]` + reason |
| 6 | 可插拔性（**结构断言**） | 核心模块（exec/guard/schema/datasets/history/errmsg）**零** `engine == "..."` 分支；新增引擎只需 `register_engine()`（测试断言 `register_engine` 只接受一个对象） |
| 7 | 结果里的 `engine` 标签**不硬编码** | 改前 `exec.py` 4 处写死 `"sqlite"`（接 MySQL 后标签会撒谎）→ 现在由引擎实例透传，测试直接断言 `execute(..., engine_id="mysql")` 返回 `engine:"mysql"` |
| 8 | 部署脚本语法 | `bash -n scripts/deploy-lab-db.sh` → **exit 0** |
| 9 | 部署脚本 `--dry-run` | sqlite/mysql/postgres → exit 0（打印 `[dry-run]` 命令，密码打码 `'***'`）；**opengauss → exit 3**（Ubuntu 上明确拒绝 + 理由） |
| 10 | 部署脚本 `--check` 真自检 | sqlite → **exit 0**，真建表/插入/更新/回读/删除 + 报真实版本 3.45.1；mysql/postgres（有凭据、无客户端）→ **exit 4** `找不到 mysql/psql 客户端` |
| 11 | 缺凭据 / 缺 TTY 的错误路径 | 无 TTY → exit 2 + `请改用：LAB_MYSQL_PASSWORD='...' ./scripts/deploy-lab-db.sh mysql` |
| 12 | **缺 sudo / 缺包管理器** | 无 sudo → exit **1** + `需要 root 权限，但没有 sudo 命令。请以 root 身份运行；或加 --check 只做自检`；无 apt/dnf → exit **3** + `本机既没有 apt-get 也没有 dnf/yum…请按 docs/LAB_DB_DEPLOY.md §4 手工安装` |
| 13 | 幂等性设计 | 代码证据：`CREATE USER IF NOT EXISTS`/`CREATE TABLE IF NOT EXISTS`、`pg_roles` 存在性检查 + `RAISE NOTICE '已存在 → 已更新密码与权限（幂等）'`、`pg_hba.conf` 行级 `grep -qF` 跳过、`.env` **upsert 不动其它键**、安装步骤 `已装则 apt/dnf 直接跳过`；脚本头声明"重复跑不报错、不重复建号" |
| 14 | 退出码语义 | `EXIT_OK=0 / EXIT_FAIL=1 / EXIT_USAGE=2 / EXIT_UNSUPPORTED=3 / EXIT_SELFCHECK=4`（实测各分支与常量一致） |

### 11.2 未验证清单（**照做就能验**）

| 项目 | 为什么本机验不了 | 在有 DB 的机器上怎么验（具体命令） | 风险 |
|---|---|---|---|
| MySQL 真实执行（CRUD/事务/权限） | 本机无 MySQL；不装 Docker、不改系统 | `LAB_MYSQL_PASSWORD='…' bash scripts/deploy-lab-db.sh mysql -y`（末尾自检须 exit 0）→ 再 `python -m worker.cli --job sandbox.exec --in '{"engine":"mysql","user_id":"u1","session_id":"s1","sql":"SELECT 1 AS x"}'` → 期望 `engine:"mysql"`、`ok:true` | **高** |
| PostgreSQL 真实执行 | 同上 | `LAB_PG_PASSWORD='…' bash scripts/deploy-lab-db.sh postgres -y` → `sandbox.schema`/`sandbox.exec` 同断言（`engine:"postgres"`） | **高** |
| openGauss 真实执行 | 官方只支持 openEuler/CentOS；本机 Ubuntu + WSL | 在 openEuler 虚机/容器里 `bash scripts/deploy-lab-db.sh opengauss --check --host <host> --port 5432`；再跑同一批 `sandbox.exec` | 中 |
| 服务器引擎上的**危险语句负例**（ATTACH / `load_extension` / 多语句 / GRANT） | 无 DB → 现在只会得到 `E_ENGINE_UNAVAILABLE`，**验不到**闸在真引擎上的行为 | 装好后跑 §10.2 那批负例 → 期望 `E_SQL_FORBIDDEN` / `E_SQL_MULTI`（**不是** `E_ENGINE_UNAVAILABLE`） | 中 |
| 方言差异（`AUTO_INCREMENT` / `NOW()` / `LIMIT` 写法）的**引擎原生报错文案** | 无 DB（`hints` 的反向误导**已在 worker 侧修掉并断言**：`dialect_hints(sql, target_dialect)` 只对 sqlite 目标给 SQLite 建议） | 用 MySQL 方言 SQL 打 `sandbox.exec`（engine=mysql）→ 期望引擎**原生**错误文案（不是 SQLite 语法错），且 `hints == []` | 中 |
| 跨调用事务拒绝在 server 引擎上同样生效 | 无 DB（逻辑在 `exec.py`，与引擎无关，但未在真 server 引擎上跑过） | 装好后单发 `{"engine":"mysql","sql":"BEGIN"}` → 期望 `E_SQL_UNSUPPORTED` + `who:"rules"` | 低 |
| L2/L3 日志（slow log / `pg_stat_statements`） | adapter 未接入 + 无 DB | 按 `docs/LAB_DB_DEPLOY.md §8` 接 adapter → `sandbox.logs` 期望 `layers` 含 L2/L3、`status:"ok"`；`boundary` 不再说"该引擎没有 L2/L3" | 中 |
| `--check` 的**真连通**（客户端在 + 服务在跑） | 本机无客户端 → 现在只验到"找不到客户端"这一层 | 装好后 `bash scripts/deploy-lab-db.sh mysql --check` → 期望 **exit 0** + 真查询回读（不是只看客户端存在） | 中 |
| 部署脚本在 debian / rocky / openEuler 各分支的真安装 | 本机只有 WSL Ubuntu，且**不该改系统** | 目标发行版上先 `--dry-run` 核对命令 → 再真跑 → 期望 exit 0 且末尾自检通过（幂等：再跑一次输出一致） | 中 |
| Node/TS 侧 `/capabilities.sandbox` 端到端 | `apps/server/**` 属 T-BACKEND 写域 | 由 backend-api 在真 HTTP 上验（worker 层字段已验：见 11.1 第 1/5 条） | 低 |

### 11.3 结论（一句话）

**契约层与错误路径：已验证**（14 项真跑）。
**真连真跑：未验证**（10 项，逐项给了可执行命令）。
没有任何一项是"看起来成功"—— 未安装引擎一律 `E_ENGINE_UNAVAILABLE`、缺客户端一律 exit 4、缺 sudo/包管理器一律 exit 1/3，**全部如实失败**。

