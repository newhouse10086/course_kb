# 课程知识平台 · 开发文档

> **产品**：Course Knowledge Platform（课程知识平台）
> **定位**：把任意课程资料（文档 / 幻灯片 / 视频网课）编译成**可读的知识库** + **可对话的 AI 助教**
> **基线**：MySQL 手册知识库已验证（见 `../数据库课程智能体调研/`），本工程把它**产品化 + 泛化 + 加视频**
> 版本 v1.0 ｜ 2026-10-14

---

## 0. 一句话与边界

**做什么**：用户丢进 PDF / PPT / 视频，平台产出 → 层次化中文 Wiki + 知识图谱可视化 + 字幕文稿 + 思维导图，并挂一个 **pi**（AI agent）当助教。

**不做什么**：不做通用网盘；不做视频转码分发；不替代 LMS。

---

## 1. 需求（用户原话 → 可验收条目）

| # | 用户要求 | 可验收标准 |
|---|---|---|
| R1 | "mysql 只是普通文档的一份样例，还有很多别的文档" | **文档适配器可插拔**：新增一种格式只写一个 adapter，不改核心 |
| R2 | "希望把 LLM wiki 的图谱也进行可视化" | Wiki 页内**内嵌知识图谱**（节点=知识点，边=12 种类型），可点击跳转 |
| R3 | "git 下来 pi，接到本项目的 UI 里" | pi 通过 **RPC** 接入，UI 内可对话、可见工具调用、可中断 |
| R4 | "写开发文档、接口协议、功能实现" | 本文件 + `API_PROTOCOL.md` + `FUNCTIONAL_SPEC.md` |
| R5 | "调用子 agent 一起开发" | 4 个 teammate，**写域不重叠**（见 §7） |
| R6 | "类似百度网盘智能解析：视频网课 → 音频转文字 → 字幕/文稿/PPT/思维导图" | 视频上传后自动产出 4 类产物，见 `FUNCTIONAL_SPEC.md` §3 |

---

## 2. 现状盘点（可复用的资产）

`../数据库课程智能体调研/` 已有**经过实测验证**的资产：

| 资产 | 规模 | 可复用度 |
|---|---|---|
| 层次树构建（栈式算法） | 2459 节点 | **直接复用**（已是通用算法） |
| 知识卡片 schema | 22 种 kind + 定性字段 | **直接复用** |
| 知识图谱 schema | 12 种边类型（封闭枚举） | **直接复用** |
| 交叉引用引擎 | 532 条 / 假阳性过滤规则 | **直接复用** |
| 中英翻译管线 | 术语表 + 断点 | **直接复用** |
| 可视化页面 | wiki_v2 / wiki_tree / graph | **重构为工程版** |
| 文档抽取管线 | `extract_v2.py` | **泛化**（去掉 MySQL 硬编码） |

**已验证的关键常量**（不要重新发明）：

- `SPAN_THRESHOLD = 3`（跨 ≥3 章 → 通用概念）
- `MAX_PAGES_PER_UNIT = 8`（单元页数上限）
- `MIN_DEGREE_FOR_PAGE = 2`（建页阈值，避免空壳页）
- 并发 **1**（用户明确要求）
- `json_schema` + `strict: true`（`json_object` 不强制 enum）

---

## 3. 环境事实（本机实测，写代码前必读）

| 项 | 状态 | 影响 |
|---|---|---|
| Node | **v24.15.0** | ✅ pi 需要 ≥22.19 |
| pnpm / npm | 11.23.0 / 可用 | ✅ |
| Python | 3.14.4 | ⚠️ 部分包可能不兼容 |
| **ffmpeg** | ✅ N-124868 | ✅ 视频抽音频可用 |
| **Docker** | ❌ **未安装** | ⚠️ **参考文章的 FunASR-Docker 方案不可用** |
| torch | 2.12.1+cpu | ✅ 但无 CUDA |
| onnxruntime | ✅ | ✅ |
| faster-whisper / funasr | ❌ 未安装 | 需 `pip install`（PyPI ✅ 可达） |
| python-pptx / python-docx | ✅ | ✅ PPT/Word 解析可用 |
| PyMuPDF (fitz) | ✅ | ✅ PDF 解析可用 |
| GitHub 直连 | ✅（曾短暂中断） | pi 已 clone 到 `../pi` |
| PyPI | ✅ | 可装依赖 |

**⟹ 视频 ASR 方案决策**：放弃 FunASR（需 Docker），改用 **faster-whisper**（CPU 可跑，pip 可装）。

---

## 4. 架构

```
┌─────────────────────────── Web UI（浏览器）───────────────────────────┐
│  知识库浏览  │  图谱可视化  │  视频课堂  │  AI 助教(pi)  │  文档管理   │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ HTTP + SSE（流式）
┌───────────────────────────────▼───────────────────────────────────────┐
│                    Server（Python · FastAPI）                          │
│  ┌─────────────┬──────────────┬──────────────┬─────────────────────┐  │
│  │ REST API    │ SSE 事件流    │ 任务队列      │ pi RPC 桥           │  │
│  └─────────────┴──────────────┴──────────────┴─────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │              统一文档管线（Adapter 可插拔）                       │  │
│  │  PdfAdapter │ SlideAdapter │ VideoAdapter │ EpubAdapter │ WebAdapter│
│  └─────────────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │  知识层：Document → Unit → Card / Entity / Edge → Wiki / Graph    │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │  存储：SQLite（文档/单元/卡片/边/任务/会话）+ 文件系统（媒体）      │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ JSONL over stdin/stdout
                    ┌───────────▼───────────┐
                    │   pi（子进程，RPC）    │
                    │  ../pi                │
                    └───────────────────────┘
```

### 4.1 为什么 pi 用 RPC 而不是 SDK

| | SDK | **RPC** |
|---|---|---|
| 跨语言 | ❌ 仅 Node/Bun | ✅ **JSONL 与语言无关** |
| 我们后端 | Python（复用现有管线） | ✅ **Python 可直接驱动** |
| 隔离 | 同进程 | ✅ 子进程崩溃不影响服务 |
| UI 需求 | — | ✅ 天然匹配流式事件 |

**结论：RPC**。SDK 留给未来「Node 单体」方案。

### 4.2 统一文档模型（**泛化的核心**）

```python
Document                      # 一份资料
  id, title, kind(pdf|pptx|video|epub|web), source_path, meta
  └─ Unit[]                   # 切分单元（按格式不同而不同）
       # PDF   → 小节（TOC 节点）
       # PPTX  → 幻灯片
       # Video → 时间片（按 ASR 段落）
       id, order, title, span, text
       └─ Card[]              # 知识卡片（22 种 kind）
       └─ Entity[]            # 图谱实体
       └─ Edge[]              # 图谱边（12 种类型）
  └─ Outline[]                # 层次树（栈式算法，与格式无关）
```

**关键**：`Document → Unit → Card/Entity/Edge → Wiki/Graph` 这条链**与输入格式无关**。
新增格式 = 新增一个 adapter 把文件变成 `Unit[]`。

---

## 5. 目录结构（写域边界）

```
course-kb/
├─ AGENTS.md                 ← 工程引导
├─ docs/
│   ├─ DEV_PLAN.md           ← 本文件
│   ├─ API_PROTOCOL.md       ← 接口协议（REST / SSE / pi RPC）
│   └─ FUNCTIONAL_SPEC.md    ← 功能实现
├─ server/                   ← 【T1 backend-core】+【T2 video-pipeline】
│   ├─ main.py               FastAPI 入口
│   ├─ config.py
│   ├─ store/                SQLite + 迁移
│   ├─ models/               数据模型（Document/Unit/Card/Entity/Edge）
│   ├─ adapters/
│   │   ├─ base.py           ★ Adapter 抽象基类（契约）
│   │   ├─ pdf.py            PDF（复用现有管线的泛化版）
│   │   ├─ slide.py          PPTX
│   │   ├─ video.py          ★ 视频（T2 负责）
│   │   └─ registry.py       适配器注册表
│   ├─ pipeline/             LLM 管线（抽取/汇总/翻译）
│   ├─ video/                ★ 视频解析（T2 负责）
│   │   ├─ audio.py          ffmpeg 抽音频
│   │   ├─ asr.py            faster-whisper 转写
│   │   ├─ subtitle.py       SRT/VTT 生成
│   │   ├─ transcript.py     文稿分段
│   │   ├─ slides.py         视频内幻灯片抽取
│   │   └─ mindmap.py        思维导图生成
│   └─ pi_bridge/            ★ pi RPC 桥（T4 负责）
├─ web/                      ★ 【T3 web-ui】
│   ├─ index.html            知识库浏览
│   ├─ graph.html            图谱可视化
│   ├─ video.html            视频课堂
│   ├─ chat.html             AI 助教
│   └─ assets/
├─ tests/
└─ data/                     运行期数据（SQLite / 上传文件 / 媒体）
```

---

## 6. 里程碑

| # | 里程碑 | 验收 | 负责 |
|---|---|---|---|
| **M1** | **骨架可跑** | `uvicorn` 起来，`GET /api/health` 返回 ok，SQLite 建表成功 | T1 |
| **M2** | **PDF 端到端** | 上传 PDF → 产出 Wiki + Graph（复用 MySQL 管线的泛化版） | T1 |
| **M3** | **视频端到端** | 上传视频 → 字幕 + 文稿 + 时间轴 + 思维导图 | T2 |
| **M4** | **pi 可对话** | UI 里发消息 → pi 流式回答 → 工具调用可见 → 可中断 | T4 |
| **M5** | **可视化** | Wiki 页内嵌图谱；节点可点跳转 | T3 |
| **M6** | **集成验收** | 端到端跑通 + 全部测试绿 | Lead |

---

## 7. 并行开发：写域划分（**不重叠**）

| Teammate | 写域（独占） | 交付物 |
|---|---|---|
| **T1 backend-core** | `server/main.py`, `server/config.py`, `server/store/**`, `server/models/**`, `server/adapters/{base,pdf,slide,registry}.py`, `server/pipeline/**` | M1 + M2 |
| **T2 video-pipeline** | `server/video/**`, `server/adapters/video.py`, `tests/test_video_*.py` | M3 |
| **T3 web-ui** | `web/**`, `tests/test_web_*.py` | M5 |
| **T4 pi-bridge** | `server/pi_bridge/**`, `web/chat.html`（**仅此文件**） | M4 |

**冲突规避规则**：
1. T1 必须先交付 `server/adapters/base.py` 与 `server/models/**`（**契约**），T2 才能开工 → 用**任务依赖**表达
2. T3 的 `web/chat.html` 归 T4，T3 不碰
3. 任何人要改**别人写域**的文件，先在群里说明
4. 所有接口以 `docs/API_PROTOCOL.md` 为**唯一权威**，不一致就是 bug

---

## 8. 技术决策（含理由）

| 决策 | 选择 | 理由 |
|---|---|---|
| 后端语言 | **Python + FastAPI** | 复用已验证的管线（Python），pi 用 RPC 与语言无关 |
| 前端 | **原生 HTML/JS（单文件优先）** | 与现有产物一致；无需构建链；`file://` 亦可演示 |
| 存储 | **SQLite** | 已验证 FTS5 中文检索可用（bigram 方案）；零运维 |
| 中文检索 | **bigram 预处理 + FTS5** | 实测：`unicode61`=0 命中，`trigram` 丢 2 字词，bigram=8/8 |
| ASR | **faster-whisper（CPU）** | Docker 不可用 → 放弃 FunASR；faster-whisper pip 可装、CPU 能跑 |
| 图谱可视化 | **自绘 SVG/Canvas（无第三方库）** | 现有 `refman_graph.html` 已自绘力导向图，复用 |
| pi 接入 | **RPC 子进程** | 见 §4.1 |
| 任务模型 | **后台任务 + SSE 推送进度** | 视频解析耗时长，UI 必须可见进度 |

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **faster-whisper 装不上 / 模型下载慢** | M3 阻塞 | 先用 `tiny`/`base` 模型验证链路；允许降级为「只出时间轴不出文字」，并**如实标注** |
| 视频内幻灯片抽取准确率未知 | PPT 产物质量 | 先用 ffmpeg **场景切换检测**抽帧；**不做 PPT 还原的过度承诺** |
| Python 3.14 兼容性 | 依赖装不上 | 优先选纯 Python 依赖；必要时用 `uv` 建 3.12 venv（已验证可行） |
| pi RPC 需**构建后**才能跑 | M4 阻塞 | `../pi` 是源码仓库；需 `npm install && npm run build`（**仅当用户授权时**），或直接用 npm 包 `@earendil-works/pi-coding-agent` |
| 大文件上传 | 服务不稳定 | 分片上传 + 后台处理 + 断点 |
| 长任务中断 | 丢工作 | **每步落盘**（现有管线的断点模式） |

---

## 10. 质量门（每个 teammate 必须自证）

- [ ] `python -m pytest tests/ -q` 全绿（自己写域内）
- [ ] 所有 HTTP 接口有**真实调用**的测试，不是 mock
- [ ] 长任务有**断点**，中断后可续
- [ ] 无「只断言非空」的测试 —— **必须断言具体值**
- [ ] 页面改动用 headless Chrome 验证 DOM（不是"看着像对"）
- [ ] 新增依赖写入 `requirements.txt` 并说明理由
- [ ] 修改的每个 bug 在注释里**记下原错误写法**

---

## 11. 建议阅读顺序

1. 本文件（架构与边界）
2. `API_PROTOCOL.md`（**契约**，写代码前必读）
3. `FUNCTIONAL_SPEC.md`（每个功能怎么做）
4. `../数据库课程智能体调研/AGENTS.md`（**已有资产与 11 个坑**）
5. `../数据库课程智能体调研/product/WIKI_BUILD_GUIDE.md`（管线细节）
6. `../pi/packages/coding-agent/docs/rpc.md`（pi RPC 协议）
