# 功能实现（Functional Spec）

> 每个功能：**怎么做 / 用什么 / 验收标准 / 已知坑**
> 版本 v1.0 ｜ 2026-10-14 ｜ 配套 `DEV_PLAN.md`（架构）与 `API_PROTOCOL.md`（契约）

---

## 目录

1. [F1 多文档支持](#f1-多文档支持)
2. [F2 知识抽取管线](#f2-知识抽取管线)
3. [F3 全层级摘要](#f3-全层级摘要)
4. [F4 交叉引用](#f4-交叉引用)
5. [F5 图谱可视化](#f5-图谱可视化)
6. [F6 视频网课智能解析](#f6-视频网课智能解析)
7. [F7 pi AI 助教接入](#f7-pi-ai-助教接入)
8. [F8 中文检索](#f8-中文检索)
9. [附：依赖清单](#附依赖清单)

---

## F1 多文档支持

**目标**：MySQL 手册只是样例；新增格式**只写 adapter，不改核心**。

### 实现

```
server/adapters/base.py      ← 契约（DocumentAdapter）
server/adapters/registry.py  ← 注册表
server/adapters/pdf.py       ← PDF
server/adapters/slide.py     ← PPTX
server/adapters/docx.py      ← Word
server/adapters/video.py     ← 视频
server/adapters/text.py      ← 纯文本
```

### 各格式的切分策略

| 格式 | 切分依据 | span | 库 | 要点 |
|---|---|---|---|---|
| **PDF** | TOC 小节 | `page` | PyMuPDF | **栈式建树**（见坑1）；无 TOC 时降级为固定页窗 |
| **PPTX** | 每张幻灯片 | `slide` | python-pptx | 标题取 `slide.shapes.title`；备注也要抽 |
| **DOCX** | 标题层级 | `char` | python-docx | 按 `Heading N` 样式切 |
| **Video** | ASR 段落 + 场景 | `time` | ffmpeg + ASR | 见 F6 |
| **Text** | 空行/标题 | `char` | 内置 | — |

### ⚠️ 坑1：PDF 建树必须用「层级+顺序」栈式算法

```python
# ✗ 错误：用页码区间反推父子
#    症状：层级跳跃（L2→L4）、编号矛盾（6.5 下挂 6.4.3）
# ✓ 正确：TOC 自带 lvl 字段 → 栈
def build_parents(nodes):
    stack = []
    for n in nodes:
        while stack and stack[-1]["lvl"] >= n["lvl"]:
            stack.pop()
        if stack:
            n["parent"] = stack[-1]["i"]; stack[-1]["children"].append(n["i"])
            if n["lvl"] > stack[-1]["lvl"] + 1:      # TOC 自身跳级 → 规整
                n["lvl_orig"] = n["lvl"]; n["lvl"] = stack[-1]["lvl"] + 1
        stack.append(n)
```

### ⚠️ 坑2：页码区间**不嵌套**不是 bug

实测 TOC 里 **3.4%** 的父子对页码不嵌套（`end` 计算对同级小节失效）。
**不要"修"它**，也不要用它当正确性断言。

### ⚠️ 坑3：跳过非内容章

书后索引、目录、术语表要排除。实测 MySQL 手册 **969 页**属此类（索引 796 页）。

### 验收

- [ ] 新增一个 `TextAdapter` 不触碰 `server/` 其他文件（用 `git diff --stat` 证明）
- [ ] 每个 adapter 对样例文件产出 ≥1 个 unit，且 `span` 可回溯
- [ ] `GET /api/v1/capabilities` 的 `adapters` 列表与实际一致

---

## F2 知识抽取管线

**目标**：Unit → 知识卡片（22 种 kind）。

### 实现

复用 `../数据库课程智能体调研/tools/extract_v2.py` 的**已验证设计**，去掉 MySQL 硬编码：

| 已验证的做法 | 值 |
|---|---|
| 模型 | `deepseek-v4.1-flash` |
| **并发** | **1**（用户硬要求） |
| `temperature` | 0.0 |
| 结构化输出 | `json_schema` + **`strict: true`** |
| 切块 | **按 TOC 小节**（不是固定页数） |
| 页数上限 | `MAX_PAGES_PER_UNIT = 8` |
| 断点 | 每 unit 落盘 |

### ⚠️ 坑4：`json_object` 模式**不强制 enum**

实测：模型输出了 `"etype": "常用实现"`（不在 12 种枚举内，且是中文）。

```python
# ✓ 唯一可靠
response_format={"type":"json_schema",
                 "json_schema":{"name":"...","strict":True,"schema":{...}}}
# schema 里每个 object 必须： "additionalProperties": False + 完整 "required"
```

### ⚠️ 坑5：单元划分的丢页 bug

```python
# ✗ 错误：跨度 > N 的节点既不选、也不下钻 → 整片丢页
if span <= N: 选它
# 实测：N=8 时漏掉 1874 个节点，含 Chapter 8 Security 的 616 页

# ✓ 正确：递归下降 + 父节点引言段
def pick_units(node, N=8):
    kids = children(node)
    if kids and kids[0].pg > node.pg:                       # ① 引言段
        yield {"kind":"intro", "pg":node.pg, "end":kids[0].pg, "node":node}
    if not kids or (node.end - node.pg) <= N:               # ② 叶子或够小
        if node.end > node.pg:
            yield {"kind":"section", "pg":node.pg, "end":node.end, "node":node}
        return
    for c in kids:                                          # ③ 下钻
        yield from pick_units(c, N)
```

### 提示词

**System**（逐字见 `../数据库课程智能体调研/product/PROMPTS.md` §3）：

关键设计：**给反例**（✗/✓ 对照）、**明确读者**、**诚实原则**（原文没说的填 `unknown`）、
`confidence` 让模型表达不确定。

### 验收

- [ ] 必填字段缺失 = 0（自动审计）
- [ ] `kind` 多样性 > 10（实测达 17 种）
- [ ] `one_line` 无同义反复（自动检测：短且含自身名）
- [ ] 示例覆盖率 > 50%（实测 76%，且示例**逐字来自原文**）

---

## F3 全层级摘要

**目标**：**所有层级**（含中上层、含无知识点的节点）都有「本节讲什么 + 为什么重要」。

### 为什么必须改管线（用户指出）

> "为所有层级生成节介绍摘要这件事也要做，但**本质上应当改推理的 pipeline 才能实现**"

### 设计：S2 自底向上汇总

```
顺序：按层级从深到浅（L6 → L1）

对每个内部节点 k：
  输入 = k 自身的引言段原文（若 >0 页）
       + 每个子节点 c 的 {title, intro, key_takeaways[:3], n_cards}
  一次 LLM 调用 → {intro, why_important, objectives[], key_takeaways[], section_role}
  落盘 → 供其父节点使用
```

**为什么自底向上**：中间层的"这章讲什么"**不该重读原文**（昂贵且易不一致），
而由**已抽好的子节点摘要合并** —— 与人类写综述的方式一致，且**可追溯**。

**实测调用量**：内部节点 **368** 个 → 368 × 12s ≈ **1.23 h**（批量 5/次 → 0.3 h）。
**只需 368 次**（不是全部 2459 次）—— 叶子摘要已在 S1 顺带产出。

### ⚠️ 反直觉结论：全量跑反而更省

| 路线 | 额外成本 |
|---|---|
| A. 全量 S1 + S2 汇总 | 叶子摘要在 S1 **顺带产出** |
| B. 只跑一部分 + 未抽节点单独补 intro | **2061 个未抽叶子 × 6.8s ≈ 3.9 h**（逐个读原文） |

**⟹ 若"所有层级都要摘要"，应全量跑 S1。摘要必须是一等产出。**

### 过渡方案（已实现）

在 S2 落地前，用**手写覆盖层**先看效果：
`data/refman_v2/manual_intros.json`（167 条）+ `manual_intros_l3.json`（36 条），
**优先级高于 LLM 生成层**。

### 验收

- [ ] 可见节点 **100%** 有 `intro`（实测当前 L1/L2 = 100%，L3 = 30%）
- [ ] 内部节点的 `intro` **可追溯到子节点**（不含幻觉）→ 抽样人工核对
- [ ] 无知识点节点**也有** intro

---

## F4 交叉引用

**目标**：Wiki 的本质是**页面互相引用**。

### 四路来源

| rel | 数量（MySQL 样例实测） | 来源 |
|---|---|---|
| `typed` | 17 | 图谱类型化边 |
| `mention` | **330** | 正文提及其他知识点 |
| `also_in` | **185** | 跨单元复现 |
| `same_unit` | — | 同单元其他卡片 |

**合计 532 条 / 230 张卡片有引用**。

### ⚠️ 坑6：mention 的假阳性（**必须过滤**）

不过滤时实测：`USE` 被引用 **198** 次、`AND` **183** 次 —— 因为它们在英文原文里是**普通单词**。

```
过滤规则：
  1. 含中文 或 含符号 ( ) [ ] . - _ @ # $ %  → 标识符，允许
  2. 在 NOISE 集合（use/and/or/not/in/is/as/on/to/by/if/for/all/any/set/key/
     desc/path/date/char/time/text/blob/view/index/table/value/name/type/user/
     host/port/file/test/data/event）→ 拒绝
  3. 长度 < 6 或含空格 → 必须**以全大写代码形式**出现，否则拒绝
  4. 其余允许

效果：783 → 274（丢弃 566 假阳性）；USE/AND → 0
```

### ⚠️ 坑7：自引用

`TIMESTAMPDIFF()` 的正文提到 `TIMESTAMPDIFF` —— 要去尾部 `()` 后比较：

```python
if tgt.rstrip("()") == src.rstrip("()"): continue
```

### 渲染

- **正文内链**：知识点名 → 蓝色虚线链接，点击跳转 + **高亮闪烁定位**
- **引用区**：三组标签（类型化 / 正文提到 / 还出现在）
- **反链（backlinks）**：wiki 的精髓，`GET /cards/{id}/backlinks`

### 验收

- [ ] 无自引用（自动断言）
- [ ] 无通用词引用（`USE`/`AND` 计数 = 0）
- [ ] 点击引用能**跨单元**跳转（同单元跳转标题不变，属正确行为）
- [ ] 有引用的卡片占比 > 50%（实测 64%）

---

## F5 图谱可视化

**需求**（用户）："我希望你会把 **LLM wiki 的图谱**也可以进行可视化"

**⟹ 不只是独立图谱页，还要在 Wiki 页内嵌图谱。**

### 实现

| 位置 | 形态 | 交互 |
|---|---|---|
| `graph.html` | 全屏力导向图 | 拖拽 / 缩放 / 按边类型筛选 / 点击看证据 |
| **Wiki 页内嵌** | **局部子图**（当前单元的知识点 + 一跳邻居） | 点击节点 → 跳到该卡片 |
| 卡片内 | 迷你关系图（该卡片的关系） | — |

### 技术

**自绘 SVG/Canvas，不引入第三方图库**（现有 `refman_graph.html` 已验证可行）：

- 力导向布局：简单弹簧-电荷模型，`requestAnimationFrame` 迭代
- 节点大小 ∝ `degree`
- 节点颜色 ∝ `layer` 或 `type`
- 边颜色 ∝ `etype`（12 色）
- **`flagged` 边用虚线**（因果可疑，只标记不删除）

### ⚠️ 坑8：数据必须内联或经 API

`file://` 下 `fetch` 被 CORS 拦。若页面走 `http://` 则无此问题 —— **推荐走 API**。

### ⚠️ 坑9：页面 JS 初始化时机

`boot()` 必须在 `DOMContentLoaded` 或脚本末尾调用（曾因提前调用报 `Cannot read properties of undefined`）。

### 验收

- [ ] `graph.html` 渲染 ≥1000 节点不卡（实测 1644 节点 / 481 边可行）
- [ ] Wiki 页内嵌子图可点击跳转
- [ ] `flagged` 边视觉可辨
- [ ] headless Chrome 断言 DOM（不是"看着像对"）

---

## F6 视频网课智能解析

**参考**：用户给的掘金文章（Vue3 + ffmpeg.wasm + FunASR + Kimi）

### ⚠️ 方案必须调整（本机环境实测）

| 文章方案 | 本机情况 | 我们的选择 |
|---|---|---|
| ffmpeg.**wasm**（浏览器内） | ✅ 可行但内存受限 | **服务端 ffmpeg**（已装 N-124868），大文件更稳 |
| **FunASR + Docker** | ❌ **Docker 未安装** | **faster-whisper**（pip 可装、CPU 可跑，PyPI ✅ 可达） |
| Kimi API 做分析 | — | **复用现有 LLM API**（`deepseek-v4.1-flash`） |
| vue-virtual-scroller | — | 原生**虚拟滚动**（避免构建链） |

**文章的价值仍在于流程设计**：抽音频 → ASR（带字级时间戳）→ 文稿/分章 → 摘要 → 思维导图。我们保留流程，替换实现。

### 流水线

```
上传视频
  │
  ├─ S1 抽音频      ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 -c:a pcm_s16le out.wav
  │                 （16kHz 单声道：ASR 标准输入；先转 wav 避免解码兼容问题）
  │
  ├─ S2 ASR 转写    faster-whisper（word_timestamps=True）
  │                 → segments[{start_ms, end_ms, text, confidence}]
  │                 断点：每 N 段落盘
  │
  ├─ S3 字幕        segments → SRT / VTT（时间轴 + 换行合并）
  │
  ├─ S4 文稿分段    LLM：把 segments 按语义分章（≤8 章，可配）
  │                 输出 [{title, start_ms, end_ms, text, summary}]
  │                 ⚠️ 用 json_schema 强制结构
  │
  ├─ S5 全文总结    LLM：整篇摘要 + 要点
  │
  ├─ S6 思维导图    LLM → Markdown 大纲（兼容 markmap 格式）
  │                 前端渲染为可折叠树
  │
  └─ S7 幻灯片抽取  ffmpeg 场景切换检测抽帧
                    -vf "select='gt(scene,0.4)',showinfo" -vsync vfr frames/%04d.jpg
                    → 可选 OCR（如可用），否则仅出帧图 + 时间点
```

### 关键参数

| 项 | 值 | 理由 |
|---|---|---|
| 音频格式 | **16kHz / 单声道 / PCM s16le** | Whisper 系列的标准输入 |
| ASR 模型 | `tiny` → `base` → `small`（按可用性降级） | CPU 无 CUDA，模型越大越慢 |
| `word_timestamps` | `True` | 字幕要**字级**时间戳 |
| 场景检测阈值 | `0.4` | 经验值；太低会抽出大量碎帧 |
| 分章上限 | 8 | 太多章反而不好读 |
| **长视频** | 必须**分段转写 + 断点** | 1 小时视频转写可能 10+ 分钟 |

### ⚠️ 坑10：ASR 可能不可用 → **必须如实降级**

`/capabilities` 的 `asr.available=false` 时：
- UI **禁用**"生成字幕"按钮，并说明原因
- **仍可**产出：视频播放器 + 时间轴 + 幻灯片帧 + 手动上传字幕
- **绝不允许**：假装成功、产出空字幕、或编造文稿

### ⚠️ 坑11：不要把"视频内 PPT"过度承诺成"PPT 解析"

场景抽帧得到的是**图片**，不是可编辑 PPT。
- 有 OCR 时：出 `ocr_text`
- 无 OCR 时：**只出帧图 + 时间点**，并标注"图片帧"
- **不承诺**还原版式/动画/可编辑

### 验收

- [ ] 上传 5 分钟视频 → 产出 SRT/VTT（时间轴单调递增，无重叠）
- [ ] 文稿分章的时间轴**覆盖全片**且**不越界**
- [ ] 思维导图可折叠渲染
- [ ] 幻灯片帧有对应时间点，点击可跳转视频
- [ ] ASR 不可用时 `/capabilities` 如实返回 `false`，UI 禁用入口
- [ ] 长任务有断点，中断后 `--resume` 可续
- [ ] 字幕与视频**同步**（点字幕跳转 `video.currentTime`）

---

## F7 pi AI 助教接入

**需求**（用户）："git 下来 pi，pi 作为一个需求点，接到本项目的 UI 里"

### 实现：RPC 子进程

```
浏览器 ──WebSocket──► server/pi_bridge ──JSONL(stdin/stdout)──► pi --mode rpc
```

**为什么 RPC 而非 SDK**：我们的后端是 Python，pi SDK 只支持 Node/Bun；
RPC 是**语言无关**的 JSONL 协议，且子进程崩溃不影响服务。

### ⚠️ 坑12：pi RPC 的三个硬约束（官方文档明确）

| # | 约束 | 后果 |
|---|---|---|
| **P1** | **不能用 `readline`**（或任何把 `U+2028`/`U+2029` 当行分隔的读取器） | 这两个字符在 JSON 字符串里合法 → **错误切帧**。按 `\n` 切**字节流** |
| **P2** | **必须持续读 stdout** | pi 遵守背压，客户端不读 → **进程卡死** |
| **P3** | stdout 只走协议，**日志走 stderr**，不要把 stderr 当协议解析 | 解析会崩 |

### ⚠️ 坑13：`prompt` 响应 ≠ 完成

`{"type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}`
只说明**已受理**。必须等 **`agent_settled`** 才认为本轮结束
（`agent_end` 之后还可能有重试 / 压缩 / 排队消息）。

### ⚠️ 坑14：流式订阅要在 prompt **之前**

```python
# ✗ 先 prompt 再订阅 → 可能漏掉快速完成的事件
# ✓ 先订阅，再 prompt
bus.subscribe(handler)
send({"type":"prompt","message":...})
```

### 助教的产品化设计

不只是聊天框 —— 让它**能引用知识库**：

| 能力 | 实现 |
|---|---|
| 知识问答 | prompt 里注入当前文档/卡片的上下文（作为 system 或前置消息） |
| 跳转原文 | 让 pi 返回 `[[card:crd_0001]]` 形式的引用，前端渲染为可点链接 |
| 工具调用可见 | 转发 `tool_start`/`tool_update`/`tool_end`，UI 显示"正在读 xx 文件" |
| 可中断 | UI 有"停止"按钮 → `abort` |
| 会话持久 | 历史存 `data/chat/{session_id}.jsonl`（pi 原生 session 格式） |

### 降级路径（三档）

| 档 | 条件 | 行为 |
|---|---|---|
| A | `../pi` 已 build（`dist/cli.js` 存在） | `node <dist/cli.js> --mode rpc` |
| B | 全局装了 `@earendil-works/pi-coding-agent` | `pi --mode rpc` |
| C | 都不行 | `/capabilities` 返回 `pi.available=false`，**UI 禁用对话入口并说明原因** |

> **不要求构建**：探测 A→B，任一可用即可；都不可用则**如实降级**（不许假装能用）。

### 验收

- [ ] 发消息 → **逐字流式**输出（不是一次性出完）
- [ ] 工具调用在 UI 可见（工具名 + 参数 + 结果 + 耗时）
- [ ] "停止"按钮能中断（`abort`）
- [ ] 收到 `settled` 才置为"空闲"
- [ ] pi 进程崩溃后**自动重启一次**，再失败则禁用并提示
- [ ] 空闲 30 分钟回收子进程
- [ ] 未用 `readline`；stdout 持续读取（代码审查 + 运行验证）

---

## F8 中文检索

### ⚠️ 坑15：SQLite FTS5 默认 tokenizer 对中文 **0 命中**

| 方案 | 实测结果 |
|---|---|
| `unicode61`（默认） | **0 命中**（中文不分词） |
| `trigram` | 丢失 **2 字词** |
| **bigram 预处理** | **8/8 命中** ✅ |

```python
def to_bigram(s: str) -> str:
    """中文切 bigram，英文保持整词。'索引优化' → '索引 引优 优化'"""
```

**⟹ 必须自建 bigram，不能用开源默认方案。**
这正是「build index 的过程要适合数据库领域」的落点。

### 验收

- [ ] 检索「索引」有结果（默认 tokenizer 下为 0，可对比证明）
- [ ] 检索 2 字词（如「事务」）有结果
- [ ] 检索英文标识符（`sql_mode`）有结果

---

## 附：依赖清单

### Python（`requirements.txt`）

| 包 | 用途 | 本机状态 |
|---|---|---|
| `fastapi`, `uvicorn[standard]` | Web 服务 + SSE | 需装 |
| `python-multipart` | 文件上传 | 需装 |
| `pymupdf` | PDF 解析 | ✅ 已装 |
| `python-pptx` | PPTX 解析 | ✅ 已装 |
| `python-docx` | DOCX 解析 | ✅ 已装 |
| `openai` | LLM 调用 | ✅ 已装 |
| **`faster-whisper`** | ASR | ❌ **需装**（PyPI ✅ 可达） |
| `pytest`, `httpx` | 测试 | 需装 |

### 系统

| 工具 | 用途 | 状态 |
|---|---|---|
| **ffmpeg** | 抽音频 / 抽帧 / 转码 | ✅ N-124868 |
| Node ≥22.19 | pi | ✅ v24.15.0 |

### ❌ 明确不可用

| 工具 | 原因 | 影响 |
|---|---|---|
| **Docker** | 未安装 | 文章的 FunASR-Docker 方案**不可用** → 改 faster-whisper |

---

## 附：全部已踩的坑（速查）

| # | 坑 | 一句话对策 |
|---|---|---|
| 1 | PDF 建树 | **栈式**（层级+顺序），不用页码反推 |
| 2 | 页码不嵌套 | **不是 bug**，别修，别当断言 |
| 3 | 非内容章 | 索引/目录/术语表要排除（MySQL 有 969 页） |
| 4 | `json_object` | **不强制 enum** → 必须 `json_schema`+`strict` |
| 5 | 单元划分丢页 | **递归下降 + 引言段** |
| 6 | mention 假阳性 | **过滤通用词**（USE/AND…），783→274 |
| 7 | 自引用 | 去尾部 `()` 后比较 |
| 8 | `file://` CORS | 数据内联，或走 http API |
| 9 | `boot()` 时机 | `DOMContentLoaded` 或脚本末尾 |
| 10 | ASR 不可用 | **如实降级**，绝不假装成功 |
| 11 | 视频内 PPT | 只是**帧图**，不过度承诺 |
| 12 | pi `readline` | 按 `\n` 切**字节流**；持续读 stdout；stderr 非协议 |
| 13 | pi 完成信号 | 等 **`agent_settled`**，不是 `prompt` 响应 |
| 14 | 流式订阅时机 | **先订阅再 prompt** |
| 15 | 中文检索 | 自建 **bigram**（默认 tokenizer 0 命中） |
