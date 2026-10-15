# 多类型资料的解析与抽取（MULTIFORMAT）

> 版本 **v1.0** ｜ 2026-10-15 ｜ 写域：`worker/**` ｜ 对应任务 task-13
> 用户原话（2026-10-15）：
> > **之前的 bug 是一方面吧，现在看来，抽取也可能抽取出来一些 bug。**
> > **因为资料可能是图片型 pdf，可能是 word，markdown。**
> > **请设计的可以接受不同类型数据，解析，抽取**

---

## 0. 证据标注约定（全文强制）

| 标记 | 含义 |
|---|---|
| **`[实测]`** | 本机对**真实文件/真实库**跑出来的数字，可复现 |
| **`[实测-外部]`** | 其他 teammate 已核实的事实，注明来源 |
| **`[假设]`** | 设计选择，未证明。**必须写明如何证伪** |
| **`[未验证]`** | 没样本/没跑过 —— **不得当作已验证** |

---

## 1. 先回答用户：为什么"显示可用，抽取结果在哪"

### 1.1 根因（`[实测]`，零额度查清）

用户上传《数据库系统概论 第5版》（434 页 / 67.45 MB），看到的状态是
**parse done ✅ / 167 个单元 ✅ / 然后只抽出 1 张卡片**。

**证据链（三步，每步都可复现）**：

**① 库里的铁证 —— 那份文档 167 个单元的正文合计 `0` 字符**

| 文档 | units | `text_len>0` 的 unit 数 | 正文总字符 |
|---|---|---|---|
| `doc_45d7826c5c4c`（扫描教材 434 页） | 167 | **0** | **0** |
| `doc_f7e5cf29af16`（refman 6392 页） | 2523 | 2523 | 20,008,670 |
| `doc_473f915e315f`（知识点总结 23 页） | 3 | 3 | 15,388 |

**② 直接用 PyMuPDF 复核该 PDF —— 它是纯扫描件**

| 样本 | 字符/页（均值） | 图片/页（均值） | 判定 |
|---|---|---|---|
| 扫描教材 434 页 | **0** | **1.00（恒定）** | **纯图片扫描件** |
| 知识点总结 23 页 | 648 | 0.07 | 正常（有文字层）|
| refman 6392 页 | 5764 | 83 | 正常（有文字层）|

**③ 失败链条闭环**
```
PyMuPDF get_text() → 每页空串
  → adapter 忠实产出 167 个 unit，但 text 全为空
  → 抽取把【空正文】发给 LLM
  → amr「返回空内容」/「返回非 JSON」/ HTTP 400
     「This response_format type is unavailable now」
  → 167 个单元只出 1 张卡，而任务报「完成」、文档报 `ready`
```

### 1.2 为什么这个 bug 特别危险

它属于本项目反复强调的「**看起来成功**」那一类
（`AGENTS.md` §3.2：*如果一个 bug 的表现是"看起来成功"，它比崩溃危险得多*）：

- `parse` 状态 = `done`、单元数 = 167 —— **所有表面指标都正常**
- meta 里**没有任何**提示说"这份资料没有文字层"
- 下游只能得到"LLM 调用全部失败"这个**表象**，把排查方向引向 LLM（而 LLM 是无辜的）

`[实测]` 印证：`backend-api` 的 `extract_max_tokens.test.ts` 把 `completeJson` 换成
**永不失败**的 spy（LLM 完全不在链路里），**抽取任务仍然 failed**
⟹ 排除 LLM，问题钉在**解析层**。这与 1.1 的结论一致。

### 1.3 修法总览（本次交付）

| 层 | 改动 | 文件 |
|---|---|---|
| 解析 | 逐页文本层探测 + `text_mode` 判定 + 按页 OCR | `worker/adapters/pdf.py` |
| 解析 | Markdown 围栏感知 + CJK 假标题修复 | `worker/adapters/text.py` |
| 抽取 | **质量闸门**：把"抽不出东西"变成可断言的字段 | `worker/pipeline/quality.py` |

---

## 2. 三类输入的难点与现状（逐条回答 lead 的问题）

### 2.1 图片型 PDF（扫描件）

| 项 | 内容 |
|---|---|
| **难点** | PyMuPDF **抽不出文字** → 必须走 OCR |
| **现状** | ✅ 已修：逐页判定 + 按页 OCR（本地 rapidocr，**零额度**） |
| **`[实测]` 效果** | 434 页扫描件：`text_mode=image`；OCR 后 39/40 页识别出 **31,133 字符**真实教材正文 |

**问题 1：怎么识别？** → **逐页判定**，不用文档级平均。判据（`worker/adapters/pdf.py`）：
```python
# 单页判定（三条判据，缺一不可）
chars  >= IMAGE_PDF_CHARS_PER_PAGE (20)                    → 'native'
images >= IMAGE_PDF_IMAGES_PER_PAGE (0.5)                  → 候选
  且  coverage >= IMAGE_PDF_MIN_COVERAGE (0.5)             → 'image'（整页图才算扫描件）
否则                                                        → 'empty'

# 文档级汇总
既有 native 又有 image → 'mixed'   ← "半扫描件"
只有 image            → 'image'
只有 native           → 'native'
两者皆无              → 'empty'
```

#### ★★ `[实测]` 一个我自己踩的假阳性（值得单列）

**原错误写法**：用 `page.get_images(full=True)` 数图片。

`get_images()` 返回的是**页引用的 XObject 资源**，**不保证被绘制出来**。实测反例：

| 页 | `get_text()` | `get_images(full=True)` | `get_image_info()` | 真相 |
|---|---|---|---|---|
| refman p30 | `'xxx'`（3 字符） | **83** | **0** | **空白页**（页眉线 + "xxx"） |
| 扫描教材 p30 | `''` | 1 | 1 | 真扫描页 |

⟹ 仅凭"图片数"会把 refman 的 **22 页空白页**误判成"扫描件需 OCR" →
白跑 22 次 OCR（~4 分钟）且必然为空。
**修法**：① 用 `get_image_info()`（**实际绘制**的图）；
② 要求图片**基本铺满页面**（`coverage >= 0.5`），排除页内小插图。

**错误结论的传染（诚实记录）**：我据此向 Lead 报告过"refman 是 `mixed`，22 页需 OCR"——
**那是错的**。修正后 refman 是 **`native`（6370 页）+ 22 页空白**。
已加回归测试 `test_real_refman_is_native_with_blank_pages_if_present` 钉死这一点。

★★ **教训**：`get_images` vs `get_image_info` 的差别**不会报错**，只会让"少数派"的判定整体偏一类
—— 与"文档级平均抹掉少数派"是**同一形状的问题**（都是把局部真实状态压平）。
**判据要基于"实际发生的事"（绘制了没有），不是"结构上引用了什么"。**

★★ **为什么必须逐页**（lead 指出，我原设计错了）：
```
半扫描件：一半页 600 字 + 一半页 0 字 → 文档级均值 300 字/页 → 判 'native'
        → 那一半空页【静默丢弃】，永远不进 OCR
```
逐页判定让这种情形**天然被覆盖**（只对 image 页 OCR），**且不需要额外样本校准**。

### 2.2 Word（.docx）

| 项 | 内容 |
|---|---|
| **难点** | python-docx 只给段落，**丢标题层级 / 表格结构** |
| **现状** | ✅ **实测：表格没丢、层级正确**（`worker/tests/test_docx_parse.py` 11 用例，用真 `.docx`） |

**`[实测]` 逐条回答"丢什么"**：

| 担心丢的 | 实测结果 |
|---|---|
| **表格结构** | ✅ **没丢**。adapter 按 `body` 的 XML 子元素顺序遍历（`w:p`/`w:tbl` 交替），表格转成 `字段 \| 类型 \| 含义` 行 |
| **表格位置** | ✅ **不错位**。表格落在**它前面的那个小节**里，没有错位到文末 |
| **标题层级** | ✅ `Heading 1/2/3` → level 1/2/3，父子树正确 |
| **无 Heading 样式时** | ✅ 退回字符窗口（不把整篇当一个 unit） |

★ **但实测挖出了 2 个真 bug**（都属"能跑但内容是错的"）：

#### bug 4：docx 的**编号兜底缺少标点护栏** → 60 个假标题

`[实测]` 原错误写法（`docx.py::_heading_level`）：
```python
if text and len(text) <= 90:
    return level_from_numbering(text)     # ← 没有"标题不得以句末标点结尾"的护栏
```
后果：任何以"第 N 章/段/步"开头、以句号结尾的**普通段落**都被判成 level=1 标题。
实测：一份 60 段的纯文字 Word → `mode='headings'` + **60 个假单元**（本该走 `windows`）。

★★ **这是「双保险同时失效」的第二个实例**（第一个见 §3 bug 2）：
编号识别逻辑在 `text.py` **有**护栏、在 `docx.py` **没有** →
**看起来两条路都做了编号识别，实际只有一条有护栏**。
**修法**：抽出共用的 `text.py::is_title_like()`，**两处都调它** —— 一处实现不会漂移。

#### bug 5：窗口边界**从词/数字中间切开** → 正文静默损坏

`[实测]` 原错误写法（`text.py::fixed_windows`）：
```python
nl = snap_newline.find("\n", end)        # 只**向后**找换行
if nl != -1 and nl - end < size // 3:
    end = nl
```
当 `end` 落在一段中间、而其后很久才有换行时 → 不吸附 → **从词中间切**。
实测：2000 字符窗口把 `第 60 段` 切成 `第 6` + `0 段`，两个单元各拿半截数字。
**影响面**：所有走"固定窗口切分"的格式（TXT / MD / DOCX 无标题时）。
**修法**：向后找不到"足够近"的换行时**退而向前**找 —— 让窗口稍短，而不是切坏词。

★ 这 3 条（bug 1/2 + bug 4/5）的共同形状：**都不报错，只是内容/结构错了**。

### 2.3 Markdown

| 项 | 内容 |
|---|---|
| **难点** | **本身就是结构化的** —— 别当纯文本重新猜层级 |
| **现状** | ✅ **已有支持**：`text.py::_MD_HEADING = ^(#{1,6})\s+(.+)$` 直接映射 `#` 数 → level；`.md/.markdown` 已在 `TextAdapter.extensions` |
| **但** | ★ 原来有 **2 个真 bug**（见 §3），已修 |

**问题 3：Markdown 层级怎么映射？** → **`#` 数直接映射 level**（已实现），
**不走通用划分**；仅在"整篇无标题"时才退回窗口切分（`mode='windows'`）。

**一个遗留的诚实说明**：`.md` 在 `apps/server` 的 `EXT_TO_KIND` 里映射成 `kind='text'`
（那是 backend-api 的写域）。Markdown 语义比纯文本强，理想上应有独立的 `kind='markdown'`；
但**这不影响解析正确性**（adapter 按扩展名路由，已正确）→ 只影响展示/统计分类。
`[假设]` 是否需要独立 kind 取决于前端分类展示的需求，**待定**。

---

## 3. 本次修复的 3 个真 bug（都属"能跑但结构是错的"）

### bug 1：代码围栏内的 `#` 注释被当成标题

`[实测]` 复现（修复前）：
```
输入: # 数据库索引 / ```sql ... # 也不是标题 ... ``` / ## 聚簇索引 ...
产出: **6 个单元**（应为 3 个），且 `## 聚簇索引` 被挂到假标题 `也不是标题` 之下（parent=3）
```
**危害**：假标题的 level 会参与 `build_parents` 的父子推断，**把真正的小节挂错位置** → 整棵层次树错乱。

**修法**：加围栏感知（照 CommonMark）：
- 围栏 = 3 个以上连续 `` ` `` 或 `~`（可带语言后缀）
- **关闭围栏须同类且不短于开启者**（```` ```` ```` 开的不能被 ` ``` ` 关闭）

### bug 2：中文正文行被 `.isupper()` 误判成"全大写标题"

`[实测]` 复现（**一行即可**）：
```python
'索引把随机 IO 变成顺序 IO。下面是建索引的 SQL：'.isupper()   # → True  ★
```
**根因是两条判据同时失效**：
1. `str.isupper()` 对**无大小写的字符（中文）返回 True** —— 整行只有 `IO`/`SQL` 有大小写且都大写
2. 尾字符排除表**只有半角 `:`，漏了全角 `：`**

**修法**：① 含 CJK 的行**不走**"全大写"判据；② 排除表补全角 `：！？`。
**反例测试**：纯英文 `DATABASE SYSTEMS` **仍是标题**（不矫枉过正）。

#### ★ 这一条的**形状**比它本身更值得记：「双保险同时失效」

```
第一道防线: 排除"以标点结尾的行"   → 假设"中文行会以半角标点结尾"  ❌ 中文用全角
第二道防线: 要求"全大写才当标题"   → 假设"中文行不会被判成全大写"  ❌ isupper() 对 CJK 返回 True
```
**两道防线各自看起来都合理，但它们的漏洞指向同一个方向**：
都隐含假设"中文会以某种方式被排除在外"。于是**看起来有两道防线，实际只有一道**。

⟹ **判据**：设计多重防线时，要问的不是"我有几道防线"，
而是 **"它们的失效条件是否相关？"** 若相关，"多道"只是心理安慰。

★ 与 `AGENTS.md` 坑 21（自述字段与实际值不同源，双向撒谎）/ 坑 24（死旋钮）**同族** ——
都属**「上报的东西必须是真的」**。本坑的变体是：**「看起来有多重保护」不等于「真的有多重保护」**。

### bug 3（性能）：OCR 引擎每页重建

`[实测]` **新建 `RapidOCR()` = 13.9s，复用 = 9.0s**（省 ~35%）。
原实现（同 `worker/video/slides.py::ocr_image`）**每页都新建** → 434 页就是 434 次模型初始化。
**修法**：在本文件内加引擎缓存（**不改 `worker/video/**`**，那是 video-pipeline 的写域）。

---

## 4. ★ OCR 接入设计（回答 lead 的问题 2）

### 4.1 核心判断：**按页 OCR 让坐标变得不必要**

`openrouter_ocr.ts` 与本机 rapidocr 都**没有检测框**（视觉 OCR 输出自由文本）。
我们的纪律是 **绝不伪造 `box`**。那么问题来了：没有坐标，**页码回溯怎么办？**

> **答案：因为正在 OCR 的是第几页，是【我们】决定的，不是 OCR 告诉我们的。**

所以把该页 OCR 结果直接作为 `span=(page, 第几页, 第几页)` 的正文即可：

| 能力 | 无坐标的影响 |
|---|---|
| **页码回溯** | ✅ **完全不受影响**（页号由我们掌握） |
| **单元划分** | ✅ 沿用**同一套** TOC 树 + 页区间 |
| **页内**阅读顺序/分栏 | ⚠️ **近似**（视觉模型按行输出）→ 如实记 `ocr.within_page_order='approx'` |
| **页内定位**（"这句话在页面哪个位置"） | ❌ 做不到（无坐标）→ 如实不承诺 |

`[实测]` OCR 出来的正文按页归属正确（`p30` 是"1.2 数据模型"段、`p31` 是同一节的续页）。

### 4.2 OCR 结果**照常走原管线**（不另起支线）

```
图片型 PDF 页 → 渲染 200 DPI → OCR → 该页文本
                                    ↓
                        并入 page_text 缓存（与 native 页同一份 cache）
                                    ↓
                    同一套 _toc_nodes / _window_nodes 建树
                                    ↓
                          同一套抽取管线（不改）
```
**理由**：两条支线必然漂移，而"页区间 → 单元"这套已在 refman（2523 units）上验证过。

### 4.3 能力如实上报（坑 10）

`meta.ocr` 字段（**`configured` 与 `available` 分开**）：

```jsonc
{
  "configured": true,        // 引擎清单可读
  "available": true,         // 真能跑（tesseract 还需 exe 存在）
  "engine": "rapidocr",
  "reason": "OCR 可用（rapidocr）…",
  "pages_requested": 40,
  "pages_ocr_ok": 39,
  "pages_empty": 1,
  "dpi": 200,
  "within_page_order": "approx",   // ★ 如实
  "box": null,                     // ★ 绝不伪造坐标
  "chars_ocr": 31133,
  "pages_skipped_by_cap": 134,     // ★ 因上限未 OCR 的页，如实标注
  "cap": 300,
  "cap_note": "共 434 页为扫描图，按上限（300）只 OCR 了 300 页，其余 134 页没有正文…"
}
```

**OCR 不可用时**：`available=false` + 可读 `reason`，**不抛异常、不产假文本**，
`text_gate='empty_body'` 如实标注 → 上层据此拒绝进入 LLM 空转。

### 4.4 吞吐限制（`[实测]`，必须知情）

| DPI | 图大小 | 渲染 | OCR | 共 | 字符数 |
|---|---|---|---|---|---|
| 100 | 362 KB | 0.09s | 8.78s | **8.9s** | 1057 |
| 150 | 719 KB | 0.20s | 10.51s | 10.7s | 1062 |
| 200 | 1176 KB | 0.30s | 11.63s | 11.9s | 1061 |

⟹ **耗时由模型推理决定，与图大小几乎无关**（降 DPI 只省 25%，字符数不变）。

**★ 稳态速率（20 页连续样本，摊薄引擎初始化与首调预热）：** `[实测]`
```
20 页 OCR = 255.9s → **12.79 s/页**（chars_ocr=18,576，pages_ok=20/20）
  300 页（默认上限） ≈ **64 分钟**
  434 页（全量）     ≈ **92 分钟**
  refman 22 页       ≈ **4.7 分钟**   ← mixed 文档的真实成本
```
⚠️ **单页/3 页短样本会低估**（含一次性初始化）——
用 **20 页连续样本**得到的 12.79s/页才是可信规划值。

**另一项零成本开销**：逐页文本层探测（434 页全量）只需 **0.4s**（`get_text` 很快）——
所以"先探测、再决定要不要 OCR"这个策略本身**几乎是免费的**。

#### ★★ 最大的优化不是调阈值，而是"只 OCR 需要 OCR 的页"

| 文档 | 需 OCR 的页 | 预计耗时 |
|---|---|---|
| 纯扫描件 434 页 | **434** | ~70-92 分钟 |
| refman 6392 页 | **0**（6370 页有文字层 + 22 页空白） | **0 分钟** ← 完全不需要 OCR |

⟹ **"只 OCR 需要 OCR 的页"本身就可能是最大的优化** ——
它把"文档规模"与"OCR 规模"**解耦**：6392 页的手册一页都不用 OCR。

⚠️ **一个反直觉的实测结果**：我原以为 refman 有 22 页"需 OCR"（见 §2.1 的假阳性），
修掉判据后**连那 22 页也不需要**（它们是空白页）。
**这说明"需 OCR 的页数"必须靠准判据算，不能靠直觉估。**

#### ★ OCR 必须走**后台任务 + 进度上报**（lead 裁定，2026-10-15）

**「同步等一次上传跑完」这个交互模型本身是错的** —— 不是阈值该调。

- 我们已经**有** `tasks` 表 + `progress`/SSE 进度（契约 §6）
- 用户不该"等 65 分钟"，应该看到 **"已 OCR 120/434 页"**，完成时收到通知
- ⟹ **任务编排在 `apps/server/**`（backend-api 写域）**，本文件只提供 worker 侧能力：
  - `PdfAdapter(ocr_max_pages=N)` 限制单次页数
  - `ocr_pages(..., on_progress=...)` 上报 `已 OCR idx/total 页`
  - `meta.ocr.pages_skipped_by_cap` 如实标注未 OCR 的页
- **默认上限** `COURSE_KB_OCR_MAX_PAGES=300`（≈45 分钟），可配置；**超限如实标注**

#### 云 OCR 作为**可选路径**（本轮不做，但接口已留）

`[实测-外部]` `apps/server/src/providers/openrouter_ocr.ts` 已实现云端 OCR
（`z-ai/glm-5.3-flash` 主、`google/gemini-2.5-flash-lite` 备；`google/gemma-3-4b-it` **已禁用**，
实测会编造原文没有的文字），且**同样如实不伪造 `box`** —— 与本地路径同一纪律。

| | 本地 `rapidocr_onnxruntime` | 云 `openrouter_ocr` |
|---|---|---|
| 成本 | **零额度** | 按图计费 |
| 速度 | ~9-12s/页（CPU） | 网络往返（可能更快） |
| 依赖 | 本机 python 包 | 需 `OPENROUTER_API_KEY` |
| 坐标 | 无（本路径 `box=None`） | 无（如实不伪造） |
| **本轮选择** | ✅ **采用**（用户明确在意成本） | ⏸ 保留为可选 |

⟹ 切换点应是**配置**而非代码分支（与 `docs/PROVIDERS.md` 的可插拔纪律一致）。
**本轮未接**：需要 `backend-api` 在路由层按配置选择 OCR 来源；已作为需求转给他。

---

## 5. 抽取质量闸门（回答 lead 的问题 5）

### 5.1 为什么光修解析不够

修好解析只解决"扫描件"这一种情况。**"抽不出东西"本身必须可被机器发现** ——
否则下次换个原因（模型抖动、schema 不匹配、单元划分错），用户还是看到
「显示可用，抽取结果在哪」。

### 5.2 判据（`worker/pipeline/quality.py`，顺序 = 先根因后表象）

| 代号 | 判据 | 指向的层 |
|---|---|---|
| `empty_body` | `units>0 且 text_chars==0` | **解析层**（或 OCR 未覆盖） |
| `mostly_empty_units` | 空正文单元占比 ≥ 50% | 解析层（半扫描件） |
| `no_cards` | `units>=5 且 cards==0 且 text_chars>0` | **抽取层** |
| `low_yield` | `cards/units < 0.02` | 抽取层 |
| `no_entities` | `cards>0 且 entities==0` | 实体抽取 |
| `no_edges` | `cards>=3 且 edges==0` | 关系抽取 |

**顺序有意设计成"先根因"**：报告里第一条 suspect 直接指向排查方向。

### 5.3 `[实测]` 对真实事故的输出

```jsonc
{ "ok": false,
  "suspects": ["empty_body", "low_yield"],
  "reasons": {
    "empty_body": "167 个单元正文合计 **0 字符**；该 PDF 为**扫描件**（逐页无文字层，只有整页图） ⟹ 抽取无从下手（**不是**抽取器的问题）",
    "low_yield": "卡片/单元 = 1/167 = 0.0060 < 0.02（正常教材约 0.3~3）"
  },
  "metrics": { "units_total":167, "units_empty":167, "empty_ratio":1.0, "cards_per_unit":0.006, "text_mode":"image" } }
```
正常文档（refman 规模）→ `ok=true, suspects=[]`（**不误报**）。
**只诊断、不改数据**（有断言证明输入对象未被改动）。

### 5.4 阈值都是 `[假设]`，必须诚实标注

| 常量 | 值 | 依据 | 状态 |
|---|---|---|---|
| `IMAGE_PDF_CHARS_PER_PAGE` | 20 | 3 份真样本（0 / 648 / 5764）分开得很好 | `[假设]` **样本仅 3 份** |
| `IMAGE_PDF_IMAGES_PER_PAGE` | 0.5 | 扫描件每页 1 图 | `[假设]` |
| `LOW_YIELD_CARDS_PER_UNIT` | 0.02 | 保守取值（正常约 0.3~3） | `[假设]` **未用真教材校准** |
| `EMPTY_TEXT_RATIO_SUSPECT` | 0.5 | 半数以上为空显然异常 | `[假设]` |
| `MIN_UNITS_FOR_YIELD_CHECK` | 5 | 小文档本就可能无知识点 | `[假设]` |

**怎么证伪**：拿 10+ 份真实教材（含半扫描件、纯图讲义）跑一遍，
看是否有"正常件被判异常"或"异常件漏报"。**在拿到更多样本前，这些数字不得写进论文。**

---

## 6. 抽取提示词要不要按类型分化？（回答 lead 的问题 4）

**判断：不做"按类型分身"，做"按来源标注 + 一条通用约束"。**

**理由**：4 种类型 × 提示词分身 = **4 份真相**，必然漂移
（这正是本项目最忌讳的，见 `PROVIDERS.md` §0 与 lead 的裁定）。

**做法**：
1. unit 上带 `text_origin ∈ {native, ocr, asr}`
   - ✅ **adapter 层已实现**（本任务范围内，不跨写域）：
     `meta.text_origin_pages = {"30": "ocr", "1": "native", …}` +
     `meta.text_origin_summary = {native_pages, ocr_pages}`
   - ⚠️ **放在 `meta` 而非新增 `UnitDraft` 字段**：`base.py` 是**冻结契约**
     （`AGENTS.md` §2：新增格式只实现接口，**不改核心**）。
     `meta` 是契约明确的"格式特有信息、核心管线不读"通道 → 加字段不破坏任何现有调用方。
2. 提示词加**一条**约束：
   > 若正文含 OCR 识别噪声，只在证据充分时抽取，`confidence` 相应下调；
   > **不得用常识补全看不清的内容**。
3. **再配一条机器可校验的**（★ 这条比提示词重要）：
   `text_origin='ocr'` 时，`evidence_quote` 必须能在**该 unit 正文里逐字找到**
   —— **把"提示词要求"变成"可断言的事实"**。

⚠️ **落地阻塞**：第 2、3 条要改 `worker/pipeline/extract_core.py`（提示词与校验的唯一实现处），
**那是 `backend-core` 的写域** —— 已由 Lead 裁定走协调流程（不直接改）。
**第 1 条（adapter 层来源标记）已落地**，不依赖他。

---

## 7. ★ 未验证项（不得当作已验证）

| # | 项 | 状态 |
|---|---|---|
| 1 | **"半扫描件"真实样本** | ❌ **没有**。`mixed` 判据用**合成样本**测过（`test_pdf_textmode.py`），但**未在真实半扫描件上验证** |
| 2 | **docx 表格** | ✅ **已实测验证**（真 `.docx`，11 用例）—— 表格没丢、位置不错位、层级正确 |
| 3 | **阈值校准样本量** | 仅 **3 份**真 PDF（1 扫描 + 2 正常）→ 阈值是 `[假设]` |
| 4 | **OCR 在真实扫描件上的端到端抽取效果** | ⚠️ 只验证到"OCR 出正文"（31,133 字符）；**"能否抽出正确卡片"未验证**（需跑 LLM，额度/时间未投入） |
| 5 | ★ **OCR 中文错字率（TER）** | ❌ **未测**。目视有错字（如"帕·半结构化"应为"半结构化"）→ **必测**，见下方说明 |
| 6 | **`.md` 是否该有独立 `kind`** | 待定（不影响解析，只影响分类展示） |
| 7 | **`text_origin` 消费方** | adapter 侧**已完成**（`meta.text_origin_pages`）；下游由 `backend-core` 的 quote audit 消费（`worker/README.md` §5） |
| 8 | **PDF 重新解析入口** | ❌ **不存在**（只有 `video/reparse`）→ 用户无法让 OCR 修复生效，需 backend-api 加 `POST /documents/:id/reparse` |

★ **第 5 条的澄清（`[实测-外部]`，backend-core 实测）**：
我原先担心"OCR 错字会让逐字校验大量假失败" —— **经他与我的独立核实，这个担心不成立**：
校验对象是**我们喂给模型的那段正文**（`unit.text` 就是 OCR 结果），
所以模型**照抄含错字的正文照样匹配**（`exact`）。
真正不匹配的是模型**自己改写了**（"顺手修正"错字）—— 那正是要抓的行为。
唯一的 OCR 相关假失败来源是**空白/换行差异**，已用"只归一空白、不动任何字符"消除。

⟹ **仍需测 TER**，但目的不是"防假失败"，而是：
**OCR 错字会让抽出的知识本身带错字**（学生看到错的术语）→ 这是**内容质量**问题，不是校验问题。

---

## 8. 复现方式（每条结论都可复现）

```powershell
cd "D:\temp临时脚本\26-10-13 数据库数据仓库课程优化\course-kb"

# ① 文本层画像 + 逐页判定（真样本）
python -c "import sys;sys.path.insert(0,'.');import fitz,json;from worker.adapters.pdf import analyze_text_profile,classify_text_mode as c;d=fitz.open(r'data\uploads\doc_45d7826c5c4c\original.pdf');p=analyze_text_profile(d);print(c(p),json.dumps(p.to_dict()))"

# ② OCR 一页（真样本，零额度）
python -c "import sys;sys.path.insert(0,'.');from worker.adapters.pdf import ocr_pages;import json;r=ocr_pages(r'data\uploads\doc_45d7826c5c4c\original.pdf',[30]);print(r['meta']);print(list(r['texts'].values())[0][:200])"

# ③ 抽取质量闸门（真实事故数字）
python -c "import sys;sys.path.insert(0,'.');from worker.pipeline.quality import *;import json;print(json.dumps(evaluate_quality(QualityInput(units_total=167,units_with_text=0,text_chars=0,cards=1,entities=1,edges=0,text_mode='image')).to_dict(),ensure_ascii=False,indent=1))"

# ④ 测试
python -m pytest worker/tests/test_pdf_textmode.py worker/tests/test_markdown_parse.py worker/tests/test_extract_quality.py -q
```

---

## 9. 交付清单

| 文件 | 内容 |
|---|---|
| `worker/adapters/pdf.py` | 逐页文本层探测、`text_mode` 判定（native/image/mixed/empty）、按页 OCR（缓存引擎）、`text_gate` 空正文闸门、OCR 页数上限与如实标注、`meta.text_origin_pages` 来源标记 |
| `worker/adapters/text.py` | Markdown 围栏感知（修 bug 1）、CJK 假标题修复（修 bug 2）、共用 `is_title_like()`、窗口边界吸附修复（修 bug 5） |
| `worker/adapters/docx.py` | 编号兜底补标点护栏（修 bug 4）、改用共用 `is_title_like()` |
| `worker/pipeline/quality.py` | 抽取质量闸门（6 条判据，先根因后表象） |
| `worker/tests/test_pdf_textmode.py` | 20 用例（含真实 434 页 + 真实 refman 更正回归） |
| `worker/tests/test_markdown_parse.py` | 11 用例（含 2 个 bug 回归 + 反例） |
| `worker/tests/test_extract_quality.py` | 12 用例（含真实事故回归） |
| `worker/tests/test_docx_parse.py` | 11 用例（真 `.docx`；表格不丢/不错位 + 2 个 bug 回归 + 反例） |
| `worker/tools_smoke_multiformat.py` | 零额度冒烟脚本（三份真样本的判定/OCR 速率/预计耗时） |
| `worker/MULTIFORMAT.md` | 本文件 |

**LLM 调用次数：0**（诊断 / 探测 / OCR / 测试全部零额度；OCR 走本地 `rapidocr_onnxruntime`）。

**测试总计**：`python -m pytest worker/tests -q` → **570 passed, 2 skipped**（无回归）。
