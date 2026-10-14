# 模型 Provider 文档（ASR / TTS / 翻译 / LLM / OCR）

> **前提**：模型相关能力**大概率调用大厂 API**。因此所有能力都做成**可插拔 Provider**：
> 本地 / 云端可切换，配置驱动，**能力如实上报，失败如实降级**。
>
> 配套：[ARCHITECTURE_V2.md §4](ARCHITECTURE_V2.md) ｜ [API_PROTOCOL.md](API_PROTOCOL.md)
> 版本 v1.0 ｜ 2026-10-14

---

## 0. 三条铁律

| # | 铁律 | 原因 |
|---|---|---|
| **R1** | **`configured` 与 `available` 必须分开报** | 有凭据 ≠ 能用（可能欠费/被墙/模型下线）。v1 实测：pi `available=true` 但模型返回 403 |
| **R2** | **降级链每一跳都要真探测**（healthCheck），不能只看配置 | 只看配置会给**假绿** |
| **R3** | **全链失败要如实报错 + 可读原因，绝不假装成功** | 编造字幕/译文比失败更糟 |

**降级上报字段**（每次调用都要带）：
```json
{ "used_provider": "aliyun-asr", "degraded_from": "local-fw", "reason": "本地模型加载失败", "cost": {...} }
```

---

## 1. 统一接口

```typescript
export type ProviderKind = 'llm' | 'asr' | 'tts' | 'translate' | 'ocr' | 'embedding';

export interface ProviderInfo {
  id: string;                     // 'aliyun-asr' | 'local-fw'
  kind: ProviderKind;
  label: string;                  // 中文显示名，给 UI 用
  vendor: string;                 // '阿里云' | '本地' | 'OpenAI'
  runtime: 'local' | 'cloud';
  configured: boolean;            // 凭据齐备？
  available: boolean;             // ★ 真探测通过？
  reason?: string;                // 不可用时**必须**给可读原因
  capabilities: Record<string, unknown>;
  pricing?: { unit: string; amount: number; currency: string; note?: string };
  limits?: { maxSizeBytes?: number; maxDurationSec?: number; rpm?: number };
}

export interface Provider {
  info: ProviderInfo;
  healthCheck(): Promise<{ ok: boolean; reason?: string }>;
}
```

**选择策略**：

```typescript
type Policy = 'local-first' | 'cloud-first' | 'cost' | 'quality' | 'explicit';
```

---

## 2. ASR（语音转文字）

### 2.1 候选

| Provider | id | runtime | 中文 | 字级时间戳 | 成本 | 备注 |
|---|---|---|---|---|---|---|
| **本地 faster-whisper** | `local-fw` | local | ✅ | ✅ | **0** | **本机已跑通**（见 §2.3） |
| 阿里云智能语音交互 | `aliyun-asr` | cloud | ✅ | ✅ | 按时长 | 需 AK/SK/AppKey；录音文件识别是**异步任务制** |
| 腾讯云语音识别 | `tencent-asr` | cloud | ✅ | ✅ | 按时长 | 需 SecretId/SecretKey；一句话/录音文件两套 |
| 讯飞听见 | `xfyun-asr` | cloud | ✅ | ✅ | 按时长 | 需 APPID/APIKey/APISecret |
| 火山引擎 | `volc-asr` | cloud | ✅ | ✅ | 按时长 | — |
| OpenAI Whisper API | `openai-asr` | cloud | ✅ | 段级 | $0.006/min | **无字级时间戳**（只有段） |
| Deepgram / AssemblyAI | `deepgram-asr` | cloud | 一般 | ✅ | 按时长 | 英文强，中文一般 |

### 2.2 接口差异（**必须在实现里抹平**）

| 差异点 | 本地 fw | 阿里云 | 腾讯云 | OpenAI |
|---|---|---|---|---|
| **调用模式** | 同步 | **异步任务**（提交→轮询→取结果） | 同步/异步两种 | 同步 |
| 输入 | 16k mono WAV | OSS URL 或本地音频 | base64 或 URL | ≤25MB 文件 |
| 时间戳 | 词级 | 词级 | 词级 | **仅段级** |
| 语言参数 | `language` | `Format`/模型 | `EngSerViceType` | `language` |
| 结果结构 | segments[]/words[] | `Result.Sentences[]` | `Result.Sentence[]` | `segments[]` |

**统一后的内部结构**（与 v1 契约 §2.7 一致）：
```typescript
interface AsrSegment { i: number; startMs: number; endMs: number; text: string;
                       confidence?: number; words?: { w: string; startMs: number; endMs: number }[] }
```

### 2.3 ⚠️ 本地 ASR 的**已验证**事实（Lead 实测，别重踩）

| 事实 | 值 |
|---|---|
| 环境 | `faster-whisper 1.2.1` / `ctranslate2 4.8.3` / `av 19.0.1` / CPU int8 |
| 模型 | `tiny` 已缓存（74.6MB），**无需联网** |
| **必踩的坑** | **传文件路径会炸**：`av.open(..., metadata_errors=...)` 在 av 19.0.1 不存在 → `TypeError` |
| **解法** | **传 numpy float32 数组**，跳过 PyAV：`ffmpeg(16k mono PCM) → wave 模块读 → float32 → transcribe()` |
| **真实性能** | **RTF ≈ 2x**（真实中文人声：5 分钟音频 → 128s 转写）→ **1 小时课程 ≈ 25–30 分钟** |
| ⚠️ 反例 | 5 秒**纯正弦波**曾测出 9x —— **那是假象**（无人声，模型提前结束），**不能用来估时长** |
| 模型下载 | HF 下载**慢且会卡**（实测 base 卡在 2.5MB）；对策：默认 tiny，加超时+降级，可配 `HF_ENDPOINT` 镜像 |

### 2.4 降级链建议

```
local-first:  local-fw → aliyun-asr → openai-asr → 失败(如实报)
cloud-first:  aliyun-asr → local-fw → 失败
cost:         local-fw → (最便宜的云) → 失败
```

**注意**：本地与云的**能力不等价**（云可能不支持字级时间戳、或有大小上限）。降级时要**检查能力是否满足本次请求**，不满足就继续下一跳。

---

## 3. TTS（文字转语音）

> ⚠️ **这是本项目新增能力**（后续用于：知识点朗读、字幕配音、无障碍）。

### 3.1 候选

| Provider | id | 中文音色 | 流式 | 成本 | 备注 |
|---|---|---|---|---|---|
| 阿里云语音合成 | `aliyun-tts` | ✅ 丰富 | ✅ | 按字符 | 需 AK/SK/AppKey |
| 腾讯云 TTS | `tencent-tts` | ✅ | ✅ | 按字符 | — |
| 讯飞在线合成 | `xfyun-tts` | ✅ 丰富 | ✅ | 按字符 | — |
| 火山引擎 TTS | `volc-tts` | ✅ | ✅ | 按字符 | — |
| Azure TTS | `azure-tts` | ✅ | ✅ | 按月/字符 | SSML 支持好，多语言 |
| OpenAI TTS | `openai-tts` | 一般 | ✅ | 按字符 | 中文音色弱于国内厂商 |
| **本地（可选）** | `local-tts` | — | — | 0 | Windows SAPI（**已用于测试音频合成**）；Linux 可 espeak/Piper |

### 3.2 接口差异

| 差异 | 说明 |
|---|---|
| 输出格式 | mp3 / wav / pcm；部分只给 URL（需再下载） |
| 音色参数 | 各厂命名不同（`voice` / `VoiceType` / `vcn` / `voiceName`）→ **统一为 `voice`，在 provider 内映射** |
| 语速/音调 | 有的用百分比，有的用 SSML → **统一为 `rate`(-100..100) / `pitch`(-100..100)** |
| 长文本 | 多数有**单次字符上限**（如 300/1024 字）→ **必须自动分段合成再拼接** |
| SSML | 支持程度不一 → **不假设支持**，纯文本路径必须可用 |

### 3.3 ⚠️ 必须处理

- **单次长度上限** → 自动分段（按句子边界切，**不要切在词中间**）
- **拼接后的音画同步** → 若用于配音，需返回**每段的时间轴**
- **缓存** → 同一段文本重复合成要命中缓存（省钱且稳定）
- **本地 SAPI 的定位**：仅作**开发/测试**用（音质不适合交付），生产走云

---

## 4. 翻译

### 4.1 候选

| Provider | id | 术语表 | 成本 | 备注 |
|---|---|---|---|---|
| **LLM（复用现有凭据）** | `llm-mt` | ✅ **可控** | 按 token | **本项目已验证**：414 实体名 + 300 证据句，术语表注入保证一致 |
| DeepL | `deepl` | ✅ 有限 | 按字符 | 质量高；**中文技术术语一致性弱于带术语表的 LLM** |
| 阿里云机器翻译 | `aliyun-mt` | ✅ | 按字符 | — |
| 腾讯云 TMT | `tencent-mt` | ✅ | 按字符 | — |
| 百度翻译 | `baidu-mt` | ✅ | 按字符 | — |
| Google Translate | `google-mt` | ❌ | 按字符 | 需出网 |

### 4.2 ⚠️ 本项目的**特定要求**（来自 v1 实测）

| 要求 | 说明 |
|---|---|
| **术语表必须注入** | v1 的 `TERMS`（60+ 数据库术语）。**不注入会把 `index` 译成"指标"、`view` 译成"看法"** |
| **标识符保留英文** | `InnoDB`/`SELECT`/`sql_mode` 不译 —— 译了**就无法检索** |
| **证据句要"不意译"** | 证据是**可核查的引用**，意译会失去可回溯性 |
| **中英并存** | 页面标题中文 + 英文小字；证据中文译文 + 英文原文进附录 |
| **实测** | 414 实体名：**56% 译中文 / 44% 保留英文**（其中 71% 是标识符）→ **这是领域特征，不是失败** |

**LLM 翻译的提示词**已在 `数据库课程智能体调研/product/PROMPTS.md` §5（逐字可复用）。

---

## 5. LLM

| Provider | id | 备注 |
|---|---|---|
| AMR（OpenAI 兼容） | `amr` | 本项目现有凭据，`deepseek-v4.1-flash` |
| 其他 OpenAI 兼容端点 | `openai-compatible` | 通用实现，换 base_url/key/model 即可 |
| pi 内置 provider | （pi 侧） | pi 自己有 provider 体系，**与我们的 LLM provider 是两套**，不要混 |

**⚠️ 本项目对 LLM 的硬要求**：
- **并发 = 1**（用户明确要求）
- **结构化输出必须 `json_schema` + `strict:true`**（`json_object` 不强制 enum，实测模型输出过 `"etype":"常用实现"`）
- **边类型/kind 只能来自 `contracts/schema/*.json`**（封闭枚举，不许发明）
- **长任务要断点**（v1 一次 52 分钟没断点差点全丢）
- **凭据状态要区分** `configured` / `available`（v1 实测：额度耗尽返回 402，`reset_at` 有明确时间）

---

## 6. OCR（可选，用于视频内幻灯片）

| Provider | id | runtime | 备注 |
|---|---|---|---|
| 百度 OCR | `baidu-ocr` | cloud | 通用文字识别，中文强 |
| 阿里云 OCR | `aliyun-ocr` | cloud | — |
| 腾讯云 OCR | `tencent-ocr` | cloud | — |
| 本地 PaddleOCR | `local-paddle` | local | 需装 paddlepaddle（较重） |
| 本地 Tesseract | `local-tess` | local | 中文需额外语言包，精度一般 |

**⚠️ 产品预期管理（v1 教训）**：视频里"抽出的 PPT"**是图片帧，不是可编辑 PPT**。
- 有 OCR → 出 `ocr_text`
- 无 OCR → **只出帧图 + 时间点**，UI 标注**"图片帧"**
- **绝不承诺**还原版式/动画/可编辑

---

## 7. `/api/v1/capabilities` 响应要求

```json
{
  "providers": {
    "asr": [
      { "id":"local-fw", "label":"本地 faster-whisper", "vendor":"本地", "runtime":"local",
        "configured":true, "available":true,
        "capabilities":{"wordTimestamps":true,"languages":["zh","en"]},
        "pricing":{"unit":"hour","amount":0,"currency":"CNY","note":"本地 CPU，RTF≈2x"} },
      { "id":"aliyun-asr", "label":"阿里云智能语音", "vendor":"阿里云", "runtime":"cloud",
        "configured":false, "available":false,
        "reason":"缺少 ALIYUN_AK / ALIYUN_SK / ALIYUN_APPKEY（在 config/providers.yaml 配置）" }
    ],
    "tts": [],
    "translate": [
      { "id":"llm-mt", "label":"LLM 翻译（术语表）", "runtime":"cloud",
        "configured":true, "available":false,
        "reason":"LLM 配额耗尽（HTTP 402），reset_at 2026-10-14T15:44:45Z" }
    ]
  },
  "policy": { "asr":"local-first", "tts":"cloud-first", "translate":"cloud-first" }
}
```

**UI 必须按 `available` 渲染**：
- `available:true` → 正常入口
- `available:false` → **禁用入口，并把 `reason` 显示给用户**（例如"缺凭据，去配置 XX"）
- **不允许**点了才报错

---

## 8. 凭据管理

| 规则 | 说明 |
|---|---|
| 凭据只从**环境变量**读 | `config/providers.yaml` 里写 `${ALIYUN_AK}` 占位 |
| `.env` 必须 **gitignore** | 已有 `.gitignore` 覆盖 |
| **`/capabilities` 不回显凭据** | 只报 `configured` 布尔与**缺哪个变量名** |
| 日志**不得打印凭据** | 实现时统一走一个 `redact()` |
| 前端**不下发凭据** | 所有云调用在**服务端**发起 |

**现有凭据**（`course-kb/.env`）：
```
AMR_BASE=https://amr-link.open-design.ai/v1
AMR_KEY=<略>
LLM_MODEL=deepseek-v4.1-flash
```

---

## 9. 验收（每个 provider 都要满足）

- [ ] `ProviderInfo` 字段齐备，`configured` / `available` **分开且真实**
- [ ] `healthCheck()` 是**真探测**（真发一次最小请求），不是只看配置
- [ ] 不可用时 `reason` **人能看懂**（说明缺什么/为什么/怎么办）
- [ ] `capabilities` 如实（不支持字级时间戳就报 false，**别硬凑**）
- [ ] 降级链可配（`policy`），且**降级时上报 `degraded_from` + `reason`**
- [ ] 全链失败 → **明确错误码 + 不产出假数据**
- [ ] 长输入有**分段处理**（TTS 字符上限、ASR 大小上限）
- [ ] 凭据**不落日志、不下发前端**
- [ ] 有**缓存**（同一输入不重复计费）
- [ ] 单测：**假 provider** 覆盖成功/失败/降级/超时四条路径
