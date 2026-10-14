# apps/web —— Vue3 + Vite 前端

> 五个视图：**知识库（Wiki）/ 知识图谱 / 视频课堂 / pi 助教 / 文档管理**
> 契约：`docs/API_PROTOCOL.md`（REST §5 / SSE §6 / WebSocket §7.2）
> 设计：`docs/DESIGN_SYSTEM.md`（美学方向 =「数据库内部 / 工业技术手册」）

---

## 1. 跑起来

```powershell
cd "D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\course-kb\apps\web"
npm install
npm run dev            # Vite dev server；/api 已代理到 127.0.0.1:8787（后端应用）
npm run build          # 产物 dist/
npm run test:unit      # Vitest 单测（纯逻辑）
npm run test:e2e       # headless Chrome DOM 断言（会先 build）
npm run test:perf      # 真实体量的性能报告
npm test               # unit + e2e
```

后端没起也能看页面：`test/mock-server.mjs` 提供**契约 mock + 真实体量数据**
（2458 单元 / 360 卡片 / **1644 节点 481 边** / 3000 条字幕），e2e 全部基于它。

---

## 2. 设计系统落地（为什么长这样）

美学方向：**「数据库内部 / 工业技术手册」** —— 冷峻、精密、纸感、有编号文化。

| 决策 | 落地 |
|---|---|
| **纸与墨** | `--paper #f7f4ec`（暖纸，不是 `#f5f6f8` 冷灰）/ `--panel #fdfcf8`（纸白，不是纯白）；背景叠一条极淡横向规则线 + SVG 噪声颗粒 |
| **编号与页码** | 分隔靠 **1px 网格线**（`--rule`）而不是留白；卡片左 **2px 朱红竖条**；**右上角页码是视觉主角**（等宽、朱红、可点击跳原文） |
| **索引指针** | **朱红 `#b8332a` 是唯一强调色**，只用于"可跳转/当前项/缺失原因" |
| **字体** | 标题 **宋体衬线**（display）+ 正文黑体（body）+ 元数据/页码/标识符 **JetBrains Mono**（`@fontsource` 打包进项目，离线可用） |
| **层级** | 靠字号/字重/字体族区分，颜色只做辅助：正文 ≥7:1、元数据 ≥4.5:1（实测见 §5） |
| **动效** | 卡片**错峰淡入** `delay: calc(var(--i)*30ms)`；跳引用时朱红脉冲；全部 ≤300ms |
| **图谱画布** | 底色跟着主题走（亮 `#f2eee3` 纸 / 暗 `#16181d` 深墨），12 种 etype **降饱和**、靠明度+线型区分，朱红只留给选中/高亮 |

禁用清单（skill 点名）：Inter/Roboto/Arial/`system-ui` 作主字体、紫渐变、纯白面板、
大圆角（≥12px）、弥散阴影堆叠、均匀 13px 灰字 —— 一个都没用。

**暗色模式**（`<html data-theme="dark">`，右上角可切，`?theme=dark` 也可）同套 token 换值，
**不是只改亮色**：纸→深墨、墨→纸字、朱红提亮到 `#e0564a` 保证对比度。

---

## 3. 内嵌图谱（用户核心要求）

知识库页面**不是**只链到图谱页：它在**当前单元的卡片区之前**内嵌一个**局部子图**：

- 数据：`localSubgraph(graph, { unitIds, cardNames, focusId })` —— 种子 = 该单元的实体 + 该单元卡片名反查到的实体，再取**一跳邻居**；`data-seed-source` 会如实告诉你是哪种来源（`unit_ids` / `card_names` / `unit_ids+card_names`）。
- 交互：画布可拖拽/滚轮缩放/点节点；右侧 **节点 chips 可点击 → 跳转到对应卡片并高亮**（没有对应卡片的节点标灰且不可点，`data-no-card`）；边列表给出证据文本。
- 出口：「在完整图谱中打开 ↗」带 `doc/focus` 参数跳到 `/graph`。
- 兜底：`/graph` 没给 `unit_ids` 时自动改用卡片名反查（e2e 专门有一条用例断言这条回退路径）。

---

## 4. 测试与验证

### 4.0 一条命令的自证

```powershell
npm run typecheck   # vue-tsc：0 错
npm run build       # vite：✓ built
npm test            # Vitest 56/56 + headless Chrome DOM 断言 111/111
npm run test:perf   # 真实体量性能数字
python test/screenshots.py   # 10 张截图 + 对比度实测
```

### 4.1 为什么 e2e 驱动是 Python（**本机实测，不是偏好**）

| 试过的做法 | 结果 |
|---|---|
| Node `spawnSync` 拉 Chrome（`--dump-dom`） | ✗ Chrome 的 network service 建命名管道被拒（`拒绝访问 (0x5)`），**连本地 HTTP 都请求不到**，页面永不 load、dump 永不返回。`--no-sandbox` / `--single-process` / `--in-process-gpu` / detached+文件重定向 **全部无效** |
| `--dump-dom` + 挂起 `<img>` 推迟 load | ⚠️ 能出 DOM，但**占掉一个 HTTP 连接槽**（Chrome 每源 6 个），页面并行请求一多就互相等死 → "只渲染了一半"的假象 |
| **Python + CDP**（`test/cdp.py`，标准库手写 WebSocket） | ✅ 直接轮询页面的 ready 条件，不占连接、不看 load 事件，还能截图 |

所以：`test/cdp.py`（极小 CDP 客户端）+ `test/mock-server.mjs`（Node，仍是契约 mock）+ `test/chrome_dom.py`（断言）。`npm run test:e2e` 一条命令跑完。

### 4.2 断言方式

每个视图在干完活后把 `#wiki-report` / `#perf-report` / `#video-report` / `#chat-report` / `#docs-report`
写进 DOM，`?selftest=1` 时再跑一遍**真实交互**（点字幕、点节点、点交叉引用、点禁用入口、abort 对话），
把结果写进 `#selftest-report`。断言读这些 JSON 里的**具体值**（1644 / 481 / 66 / 13 / 42% / 30000ms …），
不是"非空"。DOM 结构（卡片数、etype 筛选框 12 个、虚拟滚动 DOM 行数、能力禁用与 reason 文案）另外直接断言。

---

## 5. 实测数字（本机）

**测试**：`npm test` = Vitest 单测 **56/56** + headless Chrome DOM 断言 **111/111**（`npm run test:e2e`）。

**图谱性能**（真实上游数据 1644 节点 / 481 边 / 66 flagged，headless Chromium，亮色）：

| 指标 | 实测 |
|---|---|
| 布局收敛 | 420 ticks / 210 帧 / **5.4 s** |
| 单步物理 | **3.1 ms/tick**（10 次基准 31.3ms） |
| 帧耗时 | p50 **7.7** ms · p95 **11.1** ms · max 18 ms · 205 个有效帧样本 |

**其它页面**：知识库 `performance.now()` 5.9 s（2458 单元 + 360 卡片 + 1644 节点 + 13 张卡片渲染）；
内嵌子图 30 节点/12 边（种子 21，来源 `unit_ids+card_names`，全部绘制）；视频页 3000 条字幕只用 **24 个 DOM 行**、占位高 126000px。

**对比度**（WCAG 2.1 实算，`python test/screenshots.py` 会打印）：

| 主题 | 正文 | 次级正文 | 元数据 | 朱红文字 |
|---|---|---|---|---|
| 亮 | 15.81:1 | 8.65:1 | 5.08:1 | 7.80:1 |
| 暗 | 14.27:1 | 8.48:1 | 5.13:1 | 6.65:1 |

**截图**：`test/screenshots/{wiki,graph,video,chat,docs}-{light,dark}.png`（10 张）。
截图前会做一次**真实交互**把空状态填满（对话页发一句真话走 WebSocket、视频页点一条字幕跳时间点），
不是往 DOM 里塞假数据。

---

## 6. 目录

```
apps/web/
├─ index.html  vite.config.ts  tsconfig.json  package.json
├─ src/
│  ├─ main.ts App.vue router.ts style.css        ← 设计系统 token 全在 style.css
│  ├─ views/    WikiIndex.vue Graph.vue Video.vue Chat.vue Docs.vue
│  ├─ components/ CardPanel(★页码) KnowledgeTree GraphCanvas EmbeddedGraph(★内嵌图谱)
│  │              VirtualList MindMap XrefPanel CapabilityBanner
│  ├─ api/      client.ts capabilities.ts sse.ts chat.ts types.ts
│  ├─ graph/    engine.ts(自绘力导向) physics.ts subgraph.ts palette.ts(★纸感配色)
│  ├─ composables/ useCaps.ts useCorpus.ts
│  └─ utils/    text.ts vscroll.ts markmap.ts report.ts
└─ test/  cdp.py chrome_dom.py screenshots.py mock-server.mjs screenshots/ unit/
```

---

## 7. 已知边界（如实说明）

- **Node 不能拉起可用的 headless Chrome**（见 §4.1）→ e2e/截图脚本是 Python；`npm test` 会调用 `python`。
- 中文用**系统**宋体/黑体（不打包 10MB+ CJK 字体，这是刻意取舍）；等宽字体是打包的。
- OCR 不可用是**正常降级**：视频仍出**图片帧 + 时间点**，页面明确写"图片帧"，绝不假装有文字。
- 合成时钟模式（`?simclock=1`）下 `media_check` 标 `skipped(simclock)` —— **N/A 不冒充通过**。
- 图谱页"可见边"过滤是**排他**语义：只看 flagged 时可见边全部为 flagged（e2e 断言 `flagged_not_ok === 0`）。
- 对话页 `set_model` 后端会回 `E_PI_CMD`（pi SDK 需要 Model 对象）→ 前端**不做模型下拉框**，只提供「新会话」。
