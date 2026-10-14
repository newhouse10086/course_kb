# web/ —— 课程知识平台前端（T3 写域）

> 无构建链：原生 HTML / CSS / ES module，**直接可跑**；数据全部经同源 HTTP API（`/api/v1`）。
> 最后更新：2026-10-14

## 页面

| 页面 | 内容 | 契约来源 |
|---|---|---|
| `index.html` | 知识库浏览：层次树（`–` 徽章 = 无内容节点）+ 概括区（intro/why/学习目标/要点）+ 知识点卡片（五要素）+ **交叉引用/反链** + 原文跳转 + 中文检索 + **内嵌局部图谱** | §5.2 `/outline` `/cards` `/xrefs` `/graph`、§5.3、§5.4 |
| `graph.html` | 全屏自绘力导向图：12 种 etype 筛选（12 色）/ 分层 / 最小 degree / flagged 虚线 / 点击看证据 / 深链 `?focus=<ent_id>` | §5.2 `/graph`、§2.4 |
| `video.html` | 视频课堂：播放器 + 字幕同步 + 文稿分章 + 全文总结 + 思维导图（markmap→可折叠树）+ 幻灯片帧 + **虚拟滚动** | §2.7、§5.5 |
| `chat.html` | AI 助教（**T4 pi-bridge 的写域**，本页只做入口链接与能力门控） | §7 |

## 打开方式

```powershell
# 后端（T1）
python -m uvicorn server.main:app --port 8787

# 浏览器直接访问（页面与 API 同源）
http://127.0.0.1:8787/index.html
```

⚠️ **不要用 `file://` 双击打开**：一是 ES module 在 `file://` 下被 CORS 拦（坑 8），
二是数据必须走 API。页面若拿不到后端会显示明确的错误横幅并说明怎么启动，而不是留白。

## 共用组件（`assets/`）

| 文件 | 职责 |
|---|---|
| `util.js` | 转义 / URL 参数 / 时间与 span 格式化 / `name_key` 规范化 / DOM 报告落盘 / 画布适配 / **无头测试同步屏障** |
| `api.js` | REST 客户端（契约 §5 字段唯一权威）+ `/capabilities` 归一化 + `renderCapChips` / `applyGate`（**能力不可用 → 禁用入口 + 说明原因**） |
| `graph-core.js` | **自绘力导向引擎**（Barnes-Hut 四叉树 + 弹簧 + 退火，Canvas 2D，零第三方库）、12 etype 配色、`localSubgraph` / `cardNeighborhood` |
| `xref.js` | 交叉引用：`linkify`（正文内链，含坑 6 假阳性过滤 / 坑 7 自引用）+ `xrefHTML`（类型化/正文提到/还出现在/反链）+ 事件委托 |
| `vscroll.js` | 原生虚拟滚动（固定行高 + 窗口化渲染） |
| `mindmap.js` | markmap 兼容 Markdown → 可折叠树（含 `(mm:ss)` 时间锚 → 跳转按钮） |

## 页面结构

- `assets/wiki.js` → `index.html`
- `assets/graph-page.js` → `graph.html`
- `assets/video-page.js` → `video.html`

三页都在脚本末尾 / `DOMContentLoaded` 调 `boot()`（**坑 9**：曾因提前调用报
`Cannot read properties of undefined`），并把统计结果写进
`#boot-report` / `#perf-report` / `#video-report` / `#selftest-report`，
供 headless Chrome 断言（canvas 上的图看不进 DOM，必须落成可断言的数据）。

## 测试

```powershell
python -m pytest tests/test_web_index.py tests/test_web_graph.py tests/test_web_video.py -q
```

`tests/test_web_common.py` 是夹具：起一个**真 HTTP 服务**，把上游冻结产物
（`tree.json` / `_ckpt_v2.json` / `graph_view.json`）转成契约形状后提供，
于是页面跑的是真实体量（**2458 单元 / 360 卡片 / 1644 节点 / 481 边 / 3000 条字幕**）。
夹具还提供两个降级场景：`degraded_server`（ASR/pi/ffmpeg/LLM 全不可用）与
`strip_unit_ids`（模拟 T1 没给 `/graph` 的 `unit_ids`）。

## 仅测试用的两个钩子（生产不传参数则完全不生效）

| 参数 | 作用 |
|---|---|
| `?barrier=<url>` | 注入一个挂起的 `<img>`，把 load 事件推迟到页面渲染完成 → `--dump-dom` 能在**真实时间**下拿到 DOM。（用 `--virtual-time-budget` 时 `performance.now()` 在同步执行期间不前进，性能数字会全变 0，实测踩过） |
| `?selftest=1` | 页面用**真实 MouseEvent** 跑一遍跳转链路（内嵌图谱节点点击、跨节引用、字幕跳转、折叠、筛选…），结果写进 `#selftest-report` |
| `?simclock=1&t=<ms>` | 无媒体/无头环境下的合成时钟（真实播放路径不变，只是替换取时间的来源），seek 记录写进 `#v-seeklog` |
