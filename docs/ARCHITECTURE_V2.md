# 架构 v2：TypeScript/Node 主体 + Python 媒体 worker + 可插拔模型 Provider

> **本文取代 v1 的「Python 后端」决策。** 变更原因与取舍见 §1。
> 版本 v2.0 ｜ 2026-10-14

---

## 1. 为什么改（诚实记录）

**v1 的决定**：后端用 Python + FastAPI，pi 走 RPC 子进程。
**理由（当时只写了一条）**：复用 `数据库课程智能体调研/tools/` 那套已验证的 Python 抽取管线。

**问题**：
1. pi 是 **TypeScript/Node**，集成本该用官方 **SDK（进程内）**；我选 RPC 是**用工程复杂度给选型打补丁**
2. 这个决定**写进了文档但没单独提出来确认** —— 用户提出质疑是对的
3. 用户明确要求 **Node.js 部署**，且参考文章是 **Vue3** 栈

**v2 的决定**（用户已确认）：

| 层 | 技术 | 理由 |
|---|---|---|
| **后端主体** | **TypeScript + Node** | 单 Node 部署；**pi 用官方 SDK 进程内集成**（不再需要 RPC 子进程管理） |
| **前端** | **Vue3 + Vite** | 对齐参考文章；组件化利于扩展 |
| **媒体/文档 worker** | **Python（子进程）** | 只保留「成熟库不可替代」的部分：ASR、PDF/PPTX/DOCX 解析 |
| **模型能力** | **可插拔 Provider**（§4） | 大概率走大厂 API；本地/云可切换 |

**关键收益**：pi 从 RPC 子进程 → **SDK 进程内**，省掉切帧/背压/子进程管理那一整套（v1 契约 §7 的绝大部分复杂度消失）。

---

## 2. 新目录结构

```
course-kb/
├─ AGENTS.md
├─ docs/                     ★ 契约（语言无关，全部复用）
│   ├─ ARCHITECTURE_V2.md    本文件
│   ├─ API_PROTOCOL.md       ← 需更新（§4 去掉 RPC 段，加 Provider 段）
│   ├─ PROVIDERS.md          ★ 新增：ASR/TTS/翻译/LLM/OCR provider 文档
│   ├─ FUNCTIONAL_SPEC.md    ← 保留，更新语言相关部分
│   └─ ...
├─ contracts/                ★ 共享契约（TS 类型 + JSON Schema）
│   ├─ schema/edge_types.json       ← 从 schema/ 迁入（封闭枚举）
│   ├─ schema/knowledge_card.json
│   └─ types/                       手写/生成的 TS 类型
├─ apps/
│   ├─ server/               ★ Node/TS 后端（Fastify）
│   │   ├─ package.json
│   │   ├─ tsconfig.json
│   │   └─ src/
│   │       ├─ index.ts            入口
│   │       ├─ config.ts           配置（含 provider 配置加载）
│   │       ├─ store/              SQLite（better-sqlite3）+ 迁移
│   │       ├─ routes/             REST + SSE
│   │       ├─ providers/          ★ 模型 provider 抽象与实现
│   │       │   ├─ types.ts        统一接口
│   │       │   ├─ registry.ts     注册表 + 降级链
│   │       │   ├─ llm/            openai-compatible / 各厂
│   │       │   ├─ asr/            local-worker / 阿里云 / 腾讯云 / OpenAI
│   │       │   ├─ tts/            阿里云 / 腾讯云 / OpenAI
│   │       │   ├─ translate/      LLM 翻译 / 专用 MT
│   │       │   └─ ocr/            百度 / 本地
│   │       ├─ agent/              ★ pi SDK 集成（进程内）
│   │       ├─ tasks/              任务队列 + 进度
│   │       └─ worker/             Python worker 调用器（子进程 + JSONL）
│   └─ web/                  ★ Vue3 + Vite 前端
│       ├─ package.json
│       ├─ vite.config.ts
│       └─ src/
│           ├─ main.ts
│           ├─ App.vue
│           ├─ views/              WikiIndex / Graph / Video / Chat / Docs
│           ├─ components/         卡片 / 树 / 图谱 / 虚拟滚动 / 思维导图
│           └─ api/                API 客户端（含 SSE）
├─ worker/                   ★ Python 媒体/文档 worker（CLI + JSONL）
│   ├─ requirements.txt
│   ├─ cli.py                      入口：读 JSON 参数 → 输出 JSONL 进度
│   ├─ adapters/                   ← 从 server/adapters/*.py 迁移（PDF/PPTX/DOCX/TXT）
│   ├─ video/                      ← 从 server/video/*.py 迁移（ASR/字幕/抽帧）
│   └─ README.md                   约定：输入/输出/进度协议
└─ data/                     运行期
```

**迁移映射（哪些留、哪些重写）**：

| v1 资产 | v2 去向 |
|---|---|
| `server/adapters/{pdf,slide,docx,text}.py` | → `worker/adapters/`（**保留**，成熟库） |
| `server/adapters/video.py` | → `worker/adapters/`（**保留**） |
| `server/video/**` | → `worker/video/`（**保留**，含已验证的 numpy ASR 解法） |
| `server/pipeline/{units,xref,search}.py` | → `worker/pipeline/`（**保留**：递归下降、假阳性过滤、bigram 都是验证过的） |
| `server/main.py`、`store/`、`pipeline/llm.py` | → **重写为 TS**（API/存储/编排属产品层） |
| `server/pi_bridge/**` | → **删除**，改用 **pi SDK** |
| `web/**`（原生 HTML/JS） | → **重写为 Vue3**（逻辑与交互可参考） |
| `docs/**`、`schema/**` | **全部复用** |
| `tests/**`（Python） | worker 部分保留，API 部分重写为 TS 测试 |

---

## 3. Python worker 的边界与协议

**只做「成熟库不可替代」的事**：

| 能力 | 为什么留 Python | 库 |
|---|---|---|
| PDF 解析（含 TOC 书签） | Node 生态弱 | PyMuPDF |
| PPTX / DOCX 解析 | python-pptx / python-docx 成熟 | 同上 |
| **本地 ASR** | faster-whisper 无 Node 等价 | faster-whisper |
| 视频抽帧/抽音频 | ffmpeg 两边都是 CLI（可归 Node） | ffmpeg |

**不留在 worker 的**：LLM 调用、翻译、TTS、云端 ASR —— 这些是**网络 API**，Node 直接调更自然（§4）。

### 3.1 Worker 调用协议（CLI + JSONL）

```
Node:  spawn("python", ["-m", "worker.cli", "--job", "parse", "--in", "<json>"], ...)
       stdin:  一个 JSON（任务参数）
       stdout: 一行一个 JSON（进度/结果），**严格 JSONL**
       stderr: 日志（非协议）
```

**事件格式**（与 v1 的 SSE 解耦，便于 worker 独立测试）：

```json
{"type":"progress","stage":"parse","frac":0.42,"detail":{"page":1040}}
{"type":"log","level":"info","msg":"..."}
{"type":"unit","data":{...}}          // 增量产出（可选，用于大文档流式入库）
{"type":"result","data":{...}}         // 最终结果
{"type":"error","code":"E_PARSE","msg":"...","detail":"..."}
```

⚠️ **同样的切帧教训**：只按 `\n` 切字节，**不要用 Node `readline`**（U+2028/2029 在 JSON 里合法）。

---

## 4. 可插拔模型 Provider（**新增核心设计**）

> 用户明确要求：ASR / TTS / 翻译等功能**大概率调用大厂 API**，文档要写好。

### 4.1 统一接口（TS）

```typescript
export type ProviderKind = 'llm' | 'asr' | 'tts' | 'translate' | 'ocr' | 'embedding';

export interface ProviderInfo {
  id: string;                 // 'aliyun-asr' | 'local-faster-whisper' | 'openai-llm'
  kind: ProviderKind;
  label: string;              // 中文显示名
  vendor: string;             // '阿里云' | '本地' | 'OpenAI'
  runtime: 'local' | 'cloud';
  configured: boolean;        // 凭据是否齐备
  available: boolean;         // ★ **真探测**结果，不是"配置了就算可用"
  reason?: string;            // 不可用原因（必须能让用户看懂）
  capabilities: Record<string, unknown>;
  pricing?: { unit: string; amount: number; currency: string; note?: string };
}

export interface AsrProvider {
  info: ProviderInfo;
  healthCheck(): Promise<{ ok: boolean; reason?: string }>;
  transcribe(req: AsrRequest, onEvent: (e: AsrEvent) => void): Promise<AsrResult>;
}
// TtsProvider / TranslateProvider / LlmProvider / OcrProvider 同构
```

### 4.2 选择策略与降级链

```typescript
type Policy = 'local-first' | 'cloud-first' | 'cost' | 'quality' | 'explicit';
registry.pick('asr', { policy: 'local-first', explicitId?: string });
registry.chain('asr', policy);   // 返回有序降级链
```

**硬要求**：
- 降级链**每一跳都要真探测**（`healthCheck`），不能只看配置
- 降级发生时要**如实上报**：`used_provider` + `degraded_from` + `reason`
- **全链失败** → 返回 `available:false` + 可读原因，**绝不假装成功**

### 4.3 配置格式（`config/providers.yaml`，凭据走环境变量）

```yaml
policy:
  asr: local-first        # local-first | cloud-first | cost | quality
  tts: cloud-first
  translate: cloud-first

providers:
  llm:
    - id: amr
      type: openai_compatible
      base_url: ${AMR_BASE}
      api_key: ${AMR_KEY}
      model: deepseek-v4.1-flash
      priority: 1
  asr:
    - id: local-fw
      type: local_worker            # → Python worker
      model: tiny
      priority: 1
    - id: aliyun-asr
      type: aliyun_nls
      access_key_id: ${ALIYUN_AK}
      access_key_secret: ${ALIYUN_SK}
      app_key: ${ALIYUN_APPKEY}
      priority: 2
  tts:
    - id: aliyun-tts
      type: aliyun_nls_tts
      access_key_id: ${ALIYUN_AK}
      access_key_secret: ${ALIYUN_SK}
      app_key: ${ALIYUN_APPKEY}
      voice: zhixiaobai
      priority: 1
  translate:
    - id: llm-mt
      type: llm                      # ★ 必须是 `llm`，**不是** `openai_compatible`
      # ⚠️ 勘误（2026-10-15，由 T-BACKEND 实测发现）：本示例原写 `openai_compatible`，与实现矛盾。
      #    provider 层**按 `type` 分派工厂**：
      #      type: openai_compatible → createOpenAiCompatible（info.kind 硬编码 'llm'）
      #      type: llm               → createTranslateProvider（info.kind = 'translate'）
      #    翻译 provider 若写成 `openai_compatible`，会被注册成**第二个 LLM provider** ——
      #    表现为 `/capabilities` 的 `providers.llm` 多一条、`translate` 少一条。
      #    实测：{llm:2,…,translate:1} → 修正后 {llm:1,…,translate:2}
      base_url: ${AMR_BASE}
      api_key: ${AMR_KEY}
      model: deepseek-v4.1-flash
      priority: 1
    - id: deepl
      type: deepl
      api_key: ${DEEPL_KEY}
      priority: 2
```

### 4.4 详细选型与接口差异

**见 [`PROVIDERS.md`](PROVIDERS.md)** —— 每个 kind 的候选厂商、接口差异、成本、配额、降级链、诚实降级要求。

### 4.5 能力上报

`GET /api/v1/capabilities` 必须**逐 provider** 上报：

```json
{
  "providers": {
    "asr": [
      {"id":"local-fw","label":"本地 faster-whisper","runtime":"local",
       "configured":true,"available":true,"capabilities":{"wordTimestamps":true},
       "pricing":{"unit":"hour","amount":0,"currency":"CNY","note":"本地 CPU"}},
      {"id":"aliyun-asr","label":"阿里云智能语音","runtime":"cloud",
       "configured":false,"available":false,
       "reason":"缺少 ALIYUN_AK / ALIYUN_SK / ALIYUN_APPKEY"}
    ]
  },
  "policy": {"asr":"local-first"}
}
```

> **这是「诚实接口」的落地**：UI 按 `available` 渲染，不可用的**禁用入口并显示 `reason`**。

---

## 5. pi 集成（v2：SDK 进程内）

```typescript
import { createAgentSession } from '@earendil-works/pi-coding-agent';

const { session } = await createAgentSession({
  cwd: COURSE_KB_ROOT,
  sessionManager: SessionManager.inMemory(),   // 或持久化
});
// 流式订阅 → 转 SSE/WebSocket 给前端
```

**收益**：省掉 v1 契约 §7 的 RPC 层（切帧/背压/子进程生命周期/三档降级）。

**保留的必要工作**：
- 事件 → 前端的**流式转发**（SSE 或 WS）
- **能力探测**：pi 可用性 + **模型可用性**要分开报（v1 教训：`pi.available=true` 但模型 403）
- **失败可见**：模型/凭据失败要有明确错误码与 `hint`，别让用户看到"空回复"
- **不转发 system 角色的 message_end**（v1 实测：会把系统提示词 + AGENTS.md 全文 11KB 推给浏览器）

**依赖**：`apps/server/package.json` 加 `@earendil-works/pi-coding-agent@^1.2.0`（npm 可达，已实测）。

---

## 6. 迁移里程碑

| # | 里程碑 | 验收 |
|---|---|---|
| **M0** | **结构就位** | 新目录 + `apps/server` `apps/web` 能 `npm install` + `npm run dev` 起空壳；`worker/cli.py --help` 可跑 |
| **M1** | **Worker 迁移** | Python worker 用 CLI+JSONL 产出 units/cards（**复用已验证代码**）；协议测试 |
| **M2** | **TS 后端骨架** | Fastify + better-sqlite3 + REST（documents/units/cards/graph/xrefs/search）+ SSE；契约测试 |
| **M3** | **Provider 层** | 6 类 provider 接口 + 注册表 + 降级链 + `/capabilities` 逐 provider 上报；**本机实测本地 ASR**；云 provider 至少有 1 个真跑通或如实报未配置 |
| **M4** | **Vue3 前端** | 知识库/图谱/视频/对话/文档 五视图；读 `/capabilities` **按能力渲染** |
| **M5** | **pi SDK 接入** | 流式对话 + 工具可见 + 可中断；系统提示词不外泄 |
| **M6** | **集成验收** | 端到端：上传 PDF → Wiki+图谱；上传视频 → 字幕+文稿+思维导图；对话可用（或有明确降级说明） |

---

## 7. 保留的教训（**跨语言有效**，务必带入 v2）

| # | 教训 | 在 v2 的落点 |
|---|---|---|
| 1 | **归一化别无条件剥离领域关键词** | worker 里保留 |
| 2 | 页码区间不嵌套**不是 bug** | worker 里保留 |
| 3 | **栈式建树**（层级+顺序），不用页码反推 | worker 里保留 |
| 4 | `json_object` **不强制 enum** → 必须 `json_schema` + `strict` | TS 侧同样适用 |
| 5 | **单元划分要递归下降 + 引言段**（否则整片丢页） | worker 里保留 |
| 6 | **mention 引用要过滤通用词**（USE/AND 曾误报 198/183 次） | worker 里保留 |
| 7 | 自引用要去尾部 `()` 再比较 | worker 里保留 |
| 8 | `file://` 下 fetch 被 CORS 拦 | v2 走 HTTP，问题消失 |
| 9 | `boot()` 要在 `DOMContentLoaded` 或脚本末尾 | Vue3 里由框架保证 |
| 10 | **能力不可用要如实降级** | **Provider 层强制** |
| 11 | 视频内 PPT 抽帧**只是图片**，不过度承诺 | worker 保留 |
| 12 | 切帧：**不能 readline**，只按 `\n` 切字节 | worker↔Node 的 JSONL 同样适用 |
| 13 | 完成信号要等**真正结束**（v1 是 `agent_settled`） | SDK 的 `prompt()` resolve 语义要核实 |
| 14 | 先订阅再发请求（否则漏事件） | TS 侧同样适用 |
| 15 | **中文检索必须 bigram**（FTS5 默认 0 命中） | Node 的 SQLite（better-sqlite3）同样适用 |

---

## 8. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| `better-sqlite3` 需原生编译 | 装机失败 | 备选 `node:sqlite`（Node 22+ 内置）；先实测 |
| pi SDK 依赖含原生模块（`quickjs-wasi` 等） | 安装失败 | 已实测 npm 可达；M0 先跑通 `npm install` |
| Python worker 与 Node 的进程管理 | 复杂度 | 统一 CLI+JSONL 协议 + 超时/取消/僵尸回收 |
| 云 API 凭据缺失 | provider 不可用 | **如实报 `configured:false` + reason**，UI 禁用 |
| Vue3 迁移工作量大 | 进度 | web/ 的交互逻辑与样式可参考，不是从零设计 |

---

## 9. 立即执行

1. **M0**：建结构 + 两个 `npm install` 跑通（**先验证 `better-sqlite3` 与 pi SDK 能装**）
2. 把 `server/{adapters,video,pipeline}` 的 Python 代码**搬到 `worker/`** 并加 `cli.py` 入口
3. 删 `server/pi_bridge/**`（改用 SDK）
4. 契约更新：`API_PROTOCOL.md` 去掉 §7 RPC 段 → 改为「pi SDK 集成」+「Provider」两段
5. 写 `PROVIDERS.md`
6. 派 teammate 并行（写域见 §2）
