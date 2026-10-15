# VERIFICATION.md —— 验收交接手册（**验收方从这里开始，不要依赖对话历史**）

> 目的：**让验收可以"换人"而不"丢结论"**。
> 任何验收方（人或 AI）**只需读本文件 + 它指向的产物**，就能独立复现全部结论。
> **不要**在对话历史里找状态 —— 那是不可靠且昂贵的（每轮重复计费，且会跟着实现方的假设走）。
>
> 最后更新：2026-10-15

---

## 0. 一句话原则

> **验收方的上下文应该"小"而不是"全"。**
> 小上下文 + 明确范围 + 只看证据 = 更好的验收。
> 带着和实现方一样庞大的上下文 → **不再是"独立"的**，会跟着实现方的假设走。

**所以**：本文件 + 产物文件 = 你的全部上下文。**其余一律不要读。**

---

## 1. 可复现的验收脚本（跑一条命令就能复现结论）

| 脚本 | 作用 | 产出 |
|---|---|---|
| `tools/verify_system.py`（71.6 KB） | **系统验收：91 项 / 12 组**（health · capabilities · auth · rbac · rbac-security · pipeline · sandbox · sandbox-security · sandbox-http · search · settings · security · static） | `data/verify/system_verification.json` |
| `tools/probe_extraction_quality.py`（40.2 KB） | **抽取质量诊断**：证据逐字率 · kind 多样性 · 页码可回溯性 | `data/probe/extraction_quality_report.json` |
| `tools/verify_cn_search.py` | 中文 bigram 端到端（坑 15：unicode61 对中文 0 命中） | stdout |
| `tools/precommit_secret_scan.py` | 提交前密钥扫描（读 `.env` 黑名单，**自身不含凭据**） | stdout |

**跑法**（隔离实例，见 §2）：
```bash
python -X utf8 tools/verify_system.py --live      # 复用运行中实例
python -X utf8 tools/verify_system.py             # 自己起隔离实例
```

**当前基线**：`verify_system.py` → **91 项 / 0 失败**（12 组）· `probe_extraction_quality.py` → 见报告

---

## 2. ★ 起隔离实例（**三个变量都要设，漏一个就污染生产**）

```bash
COURSE_KB_DATA_DIR=<临时目录>          # dataDir：db / uploads / artifacts / checkpoints / pi-agent
COURSE_KB_DB=<临时目录>/t.sqlite3      # 可选，显式指定库文件
COURSE_KB_PORT=8801                    # 别用 8787/8799（别人的实例）
COURSE_KB_ROOT=<临时目录>              # ★ root：settings/providers/.env 都从这读
COURSE_KB_SETTINGS_FILE=<临时目录>/settings.json   # ★ 只换 settings 一个文件
```

**两个"隔离"变量的区别（都有效，选一个）**：
| 变量 | 隔离范围 | 何时用 |
|---|---|---|
| `COURSE_KB_ROOT` | **整个 root**（`config/settings.json` + `config/providers.yaml` + `.env`） | **更彻底**，推荐 |
| `COURSE_KB_SETTINGS_FILE` | **只换 settings.json 一个文件** | 只想改 settings 时 |

⚠️ **`config/settings.json` 不在 `dataDir` 里** —— 只设 `COURSE_KB_DATA_DIR` 会**与别人共用 settings**
（历史上"谁把 `active` 改成 glm-5.3 / kimi-k3"就是这么来的）。

---

## 3. ★ 模型与成本约束（**验收方必须遵守**）

```
用户要求：只能用 deepseek-v4.1-flash 测试 —— kimi 太贵
```
**`config/settings.json` 的真值必须是**：
```jsonc
"llm": {
  "active": "deepseek-v4.1-flash",
  "fallbacks": ["deepseek-v4-flash-0731", "glm-5.3-flash"]   // ★ 兜底链也必须低价
}
```
★ **`settings.llm.active` 是"唯一真相源"，会覆盖 `providers.yaml` 的 `model: ${LLM_MODEL}`** ——
**只改 `.env` 不生效**。

**跑真机前必做**：
1. **断言** `active === 'deepseek-v4.1-flash'` 且主模型与兜底链**都不含 kimi** → 不满足就**不跑并上报**（**不自己改配置**）
2. **跑之前先清场**：`Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='python.exe'"`
   —— **确认没有别人在调 LLM**（有队友进程时 LLM 会 ~120s 超时，**那会白花额度**）
3. **报告写明：用了哪个模型 + 几次调用**

**已知成本陷阱（不要重复踩）**：
| 陷阱 | 说明 |
|---|---|
| `/models` **逐个真探测** | **8 次 LLM 调用/请求**（有 60s TTL 缓存；`?deep=1` 或过期即 8 次真调用） |
| `model_switch` 用 `force: true` | 每次切换 = **1 次强制真探测** + 回滚探测 |
| ★ **`agent` 模式的工具循环** | 一轮可能 **3–5 次** LLM 调用（`kb_search` → `kb_get` → 生成）—— **反复跑真问题会成倍烧钱** |
| 免费模型池 | OpenRouter 免费池是**共享池**，会被上游 429；**不可依赖** |

---

## 4. 已知**未验证项**（如实清单 —— 验收方应优先验这些）

| 项 | 为什么没验 | 怎么验 | 风险 |
|---|---|---|---|
| **MySQL / PostgreSQL / openGauss 真连真跑** | 本机无 DB、无 Docker | `LAB_MYSQL_PASSWORD='…' bash scripts/deploy-lab-db.sh mysql -y` → 再 `sandbox.exec {"engine":"mysql"}` 期望 `engine:"mysql"` | **高** |
| **危险语句负例在 server 引擎上** | 同上 | 装好后跑 `worker/README.md §10.2` 那批 → 期望 `E_SQL_FORBIDDEN`/`E_SQL_MULTI`（**不是** `E_ENGINE_UNAVAILABLE`） | 中 |
| **`now`/`abort` 在「有运行中任务」时的行为** | 需真任务 | 上传→触发 extract→运行中切模型：`now` 期望 **409 `E_MODEL_BUSY`**（✅ 已验）；`drain` 期望 200 + `state:"timeout"`（✅ 已验）；**`abort` 的断点续推链路未验** | 中 |
| **`citationMode: 'cited'` 分支** | 需真抽取产生卡片（花额度） | 小文档 extract → cards>0 → 问卡片里确实有的问题 → 期望 `cited` + 引用逐字可回溯；反问知识库没有的 → 回到 `missing` | 中 |
| **`context` 的「模型级」确认** | 未耗额度重跑 | 同一轮问"我在看哪一章" → 期望模型**真的说出** `resolved` 里的章节名（机制已被单测钉住，**模型是否真的用上未实测**） | 中 |
| **真·无 ffmpeg 的端到端** | 本机构造不出（`find_ffmpeg` 顺序 env→which→常见目录） | 藏起 PATH 与 `C:\tools\ffmpeg` 后跑视频管线 → 期望 `E_FFMPEG_MISSING` + 可读 detail（现只有注入式证据） | 低 |
| **`progress.detail` 恒空** | 设计缺口（runner 回调传人话阶段串而非结构体） | 要补需改内部回调签名 → **Lead 裁定本轮不做 API 手术** | 低 |
| **多引擎沙箱** | 只测 sqlite | 见上面两条 | 中 |

---

## 5. 关键历史发现（**验收方需要知道，否则会重复踩**）

### 🔴 CRITICAL（已修，需防回归）
- **学生能通过 agent 执行任意 shell / 读任意文件**
  根因：`tools` 没被传下去 → pi 用**默认全集**；而 `tools_source` 标成 `'none'`（自相矛盾）
  修法：管理器默认**显式传 `tools: []`**；危险工具需**两道显式开关**；`agent` 模式只给 `kb_search`/`kb_get`

### 坑 21 家族（"上报的东西必须是真的"）—— **已出现 4 个实例**
```
① tools_source:'none'        但实际有 4 个危险工具 → 说关了其实开着（安全事故）
② tools_source:'kb-readonly' 但实际 tools:[]       → 说开了其实关着（功能失效）
③ context 帧说 used 但没拼进 prompt                → 说用了其实没用
④ 注释承诺 timeoutMs 可配，代码从不读               → 说能配其实不能（坑 24"死旋钮"）
```
★ **②③ 只有真 WS 端到端能抓到** —— 单元测试与 `/capabilities` 断言**全绿**。

### 其它已修的真 bug
- 跨调用事务**假回滚**（报 ok 但数据已提交）→ 改为**诚实拒绝** + 同批 `multi:true` 真回滚/真提交
- `/models` **全假绿**（8/8 报 available 但 content 全空，推理模型吃光 `max_tokens`）
- agent SSE **漏转义 U+2028** → 静默丢事件
- **stdin 编码**：`sys.stdin.read()` 按 GBK 解码 → 坑 18 推荐的"大 payload 走 stdin"路径在中文下一直是坏的
- `_emit_ready` 用了生产 `Emitter` **没有的** `.ready()` → **整条管线跑完、产物全落盘，却在最后"上报"崩**
- `<script setup>` 顶层 `await import()` → async setup → **整页渲染不出来**（`vue-tsc`/`vite build` 全绿）
- 缓存冻住"承诺实时"的字段（`auth.bootstrap` / `settings.activeModel` / `retrieval.dataReady`）

### 验收方法教训（**这些比 bug 更值钱**）
1. **"看起来成功"的 bug 比崩溃危险得多** —— 判据：如果一个 bug 的表现是"看起来成功"，优先查它
2. ★ **"不走真实路径就测不出"** —— 多个 bug 的单测与断言**全绿**，只有真 HTTP / 真 WS 能抓到
3. **守卫要自证能红** —— 故意改回旧实现，看测试是否变红（否则不知道守卫是否有效）
4. **不忠实的测试替身会把"上报与生效不一致"伪装成正常**（fake 恒报 `tools: []` → 假象与 bug 共存也不报错）
5. **空 ≠ 缺失** —— `x or y or []` 把有意义的空列表当"没有值"；判缺失用 `is None`
6. ★ **报缺陷前先怀疑自己的工具** —— 已发生多次"grep 命中其实是注释"、"测试夹具默认值掩盖 bug"、
   "探针用拉丁标记测中文 bigram 检索"
7. **删代码前先问 owner** —— 删 v1 `web/` 前问了两个 owner，**捞回 4 条行为（含一个真 bug：非法 session id 无限重连）**

---

## 6. 写域与产物归属

| 产物 | 归属 |
|---|---|
| `tools/verify_system.py` · `tools/probe_extraction_quality.py` · `data/verify/**` · `data/probe/**` | 验收方 |
| `docs/**` · `contracts/**` | **Lead 独占** |
| `apps/server/src/agent/**` | pi-bridge |
| `apps/server/src/providers/**` · `routes/**` · `store/**` · `tasks/**` | backend-api |
| `apps/web/**` | web-ui |
| `worker/**` | backend-core / video-pipeline |

**规则**：只写自己写域内的文件；要改别人的 → 先 `send_message` 给 owner 并等确认。
**发现 bug 报给 owner，不要自己跨域改。**

---

## 7. 验收方的最小工作流

```
1. 读本文件（只有本文件）
2. 起隔离实例（§2 的四个变量）
3. ★ 断言模型配置（§3）—— **不满足就不跑**（`active` 必须 `deepseek-v4.1-flash`，
   且主模型与**兜底链**都不含 kimi）。**这一步必须做，不许跳**
   ★ 踩过：验收方复制 `settings.json` 时其真值还是 `kimi-k3`，**没先断言就起实例** ——
     结果侥幸没烧 kimi（agent 走了 `.env` 路径），**但流程是错的**。**结果侥幸 ≠ 流程正确。**
4. 清场（确认没别人在调 LLM）—— 有队友进程时 LLM 会 ~120s 超时，**白花额度**
5. 跑 tools/verify_system.py --live  → 91 项
6. 优先验 §4 的未验证项（**按"风险 ÷ 成本"排序**：高风险 + 零额度 的先做）
7. 报告：数字 + 新发现（附复现命令）+ 未验证项（如实）
8. ★ 发现真 bug → 报 owner；**不要启动长期探针**（会持续烧钱且失控）
```

**★ 最后一条很重要**：**探针跑完就停**。历史上出现过"探针在后台反复跑真实问题、
每轮 agent 模式产生 3–5 次 LLM 调用、累计烧掉 263 次调用"的事故。

**★ 第 3 步为什么单独重复**：约束写在 §3 里**不够** ——
**工作流清单才是被照着执行的东西**。踩坑的那次就是因为"§3 读过，但 §7 没写"。
