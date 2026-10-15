"""PDF 适配器（span = ``page``，切分依据 = TOC 小节）。

三个必须遵守的坑（FUNCTIONAL_SPEC 坑 1/2/3）：

* **坑 1**：建树必须用「层级 + 顺序」**栈式算法**（抄 `build_tree.py::build_parents`）。
  ✗ 曾经的错误写法：用页码区间反推父子 → 层级跳跃、``6.5`` 下挂 ``6.4.3``。
* **坑 2**：页码区间**不嵌套不是 bug**（实测 3.4% 的父子对如此）——不修、不当断言。
* **坑 3**：书后索引/目录/术语表要排除（MySQL 手册 969 页属此类）——
  但**必须如实记进 meta**，不能静默丢页。

文本策略：每个 unit 只存**前 ``MAX_PAGES_PER_UNIT`` 页**的正文。
理由：递归下降的抽取单元（pipeline/units.py）只会选跨度 ≤ 8 页的节点，
所以被选的单元文本是**完整**的；上层大章只需引言段（F3 的输入），
这样既避免把 616 页塞进一条记录，也不丢内容（下钻会重新取到）。

★★ **图片型（扫描）PDF —— 本适配器最危险的坑（实测踩到）**

`[实测]` 用户上传的《数据库系统概论 第5版》（434 页 / 67.45 MB）：
```
PyMuPDF get_text() → 每页 0 字符（抽样 15 页：均值 0 / 中位 0 / max 0）
get_images(full=True) → 每页恰好 1 张整页图
```
⟹ 它是**纯扫描件**。而**旧实现对此完全无感**：它照样产出 167 个 unit，
   只是 `text` 全为空串，解析状态照样 `done`。

**后果（这才是最严重的）**：抽取阶段把**空正文**发给 LLM →
`amr 返回空内容` / `返回非 JSON` / HTTP 400 `response_format type is unavailable`
→ 167 个单元**只抽出 1 张卡片**，而**任务报"完成"、文档报 `ready`**。
这是典型的「看起来成功」：从 `parse done` + `167 units` 完全看不出问题。

**本文件的修法**：
1. :func:`analyze_text_profile` 逐页测「字符数 / 图片数」，如实写进 ``meta.text_profile``；
2. ``chars_per_page < IMAGE_PDF_CHARS_PER_PAGE``（默认 20）且图片占比高 → ``text_mode='image'``；
3. ``text_mode='image'`` 时**按页 OCR**（见 :func:`ocr_pages`）——**有 OCR 就补正文，没有就如实标注**，
   绝不静默产出空正文；
4. ``meta.ocr`` 如实报 ``configured`` / ``available`` / ``reason``（铁律 R1/R3）。

**为什么"按页 OCR"能保住页码回溯（关键设计判断）**：
OCR 输出的是**自由文本，没有检测框**（与 `openrouter_ocr.ts` 同一条纪律：**绝不伪造 ``box``**）。
但我们**本来就知道正在 OCR 的是第几页** —— 所以把该页 OCR 结果直接作为
``span=(page, 第几页, 第几页)`` 的正文即可：
* **页码回溯完全不受影响**（不需要坐标）
* 单元划分沿用**同一套** TOC 树 + 页区间（不另起一条支线）
* 唯一损失：**页内**阅读顺序/分栏可能不准 → 如实记 ``ocr.within_page_order='approx'``
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from worker.adapters.base import (
    DocDraft,
    DocumentAdapter,
    ParseError,
    ProgressFn,
    Span,
    UnitDraft,
    report,
)
from worker.adapters.registry import register
from worker.adapters.text import (
    build_parents,
    clean_text,
    guess_lang,
    RawNode,
)

log = logging.getLogger(__name__)

#: 抽取单元页数上限（已验证常量，不要重新发明）
MAX_PAGES_PER_UNIT = 8

# ── 图片型（扫描）PDF 判定 ─────────────────────────────────────────────
#: 判定为"无文字层"的**每页平均字符数**上限。
#:
#: `[实测]` 校准依据（本机 3 份真样本）：
#:   纯扫描教材  字符/页 均值 = 0     ← 必须判为 image
#:   知识点总结  字符/页 均值 = 648   ← 必须判为 native
#:   refman     字符/页 均值 = 5764  ← 必须判为 native
#: 取 20 是"留足余量但不误判"：正常 PDF 哪怕只有一行页眉也不止 20 字符/页；
#: 而扫描件即便混入极少量可选中文字（如扫描软件加的页码层）也不会到 20。
#: ⚠️ `[假设]` 样本只有 3 份，**待更多样本复核**（尤其"半扫描件"）：
#:    见 `worker/MULTIFORMAT.md` §7 未验证项。
IMAGE_PDF_CHARS_PER_PAGE = 20.0

#: 判定为图片型的**每页平均图片数**下限（扫描件通常每页 1 张整页图）。
IMAGE_PDF_IMAGES_PER_PAGE = 0.5

#: ★ `image` 判据还要求**最大那张图基本铺满页面**。
#:
#: `[实测]` 为什么需要它：refman 的空白页（正文只有 "xxx"）用
#: ``get_images(full=True)`` 数出 **83** 张"图"（其实是页引用的 XObject 资源，
#: 并未绘制）→ 仅凭图片数会把 **22 页空白页**误判成"扫描件需 OCR"。
#: 改用 ``get_image_info()``（实际绘制）后这些页为 0 张图；再加覆盖率门槛，
#: 可进一步区分"整页扫描图"（覆盖 ~100%）与"页内小插图"。
IMAGE_PDF_MIN_COVERAGE = 0.5

#: 判定时抽样多少页（避免对 6392 页手册逐页统计）。
#: 取前 N 页**等距抽样**：只抽前几页会把"封面+版权页无文字"误判成整本扫描件。
TEXT_PROFILE_SAMPLE_PAGES = 24

#: OCR 渲染 DPI。`[实测]` 200 DPI 下 rapidocr 对中文教材正文识别良好
#: （第 30 页 1061 字符、第 60 页 684 字符，正文可读）。
OCR_RENDER_DPI = 200

#: 单页 OCR 后**少于**该字符数 → 视为"该页无正文"（纯图/空白页），如实不计入。
OCR_MIN_PAGE_CHARS = 8

#: 图片型 PDF 最多 OCR 多少页（0 = 不限）。防"上传 1000 页扫描件把 worker 跑死"。
#: 上限可用环境变量 ``COURSE_KB_OCR_MAX_PAGES`` 覆盖。
#:
#: `[实测]` 为什么必须设上限：CPU ONNX 推理 **~9 秒/页**（200 DPI，本机无 GPU）。
#: 图片型 PDF 最多 OCR 多少页。**0 = 不限制（默认）**。
#:
#: ## ★★ 用户裁定（2026-10-16）：取消上限
#: > **"要取消啊，肯定要取消的，真正投入生产，这是为了教育事业，投资肯定要在合理范围内大力的"**
#:
#: ⟹ **默认 0 = 全部页都 OCR**（434 页就 434 页）。
#: `COURSE_KB_OCR_MAX_PAGES` **保留可配** —— 留给"紧急限成本"的场景。
#:
#: ⚠️ **历史**：本项原为 `300`，理由是"434 页本地 OCR ≈ 65 分钟，超出容忍度"。
#: 那个理由在**本地 CPU OCR**（~9-12s/页）下成立；改走**云端 OpenRouter**
#: （`[实测-外部]` 3.8-5.5s/页）后工时大幅下降，且用户明确"投资要大力"。
#: ⟹ **不许再用"省钱/省时"当理由做静默截断**；
#:    成本要**摆到用户面前让他决定**（见 `estimate_ocr_cost`），而不是替他省。
DEFAULT_OCR_MAX_PAGES = 0

#: OCR 引擎实现选择（**默认云端，用户指令**）。
#:
#: ## ★★ 用户指令（2026-10-16）
#: > **"openrouter的ocr模型用的是什么模型？这里不要接本地的模型，这里的处理和视频接的语音转文字模型一个方案"**
#:
#: ⟹ **默认必须是云端 OpenRouter**，**不许静默降级回本地 rapidocr**。
#:
#: ## 两种实现（**同一入口，显式选择**）
#: | 值 | 行为 | 谁调 OpenRouter |
#: |---|---|---|
#: | `'cloud'`（**默认**）| worker 只**渲染**页 → 图；由 **Node 调 OpenRouter** 后回传文本 | `providers/openrouter_ocr.ts`（**唯一一处实现**）|
#: | `'local'` | worker 自己调本地 rapidocr | —（显式选才走）|
#: | `'off'` | 不 OCR，如实标注 | — |
#:
#: ## 为什么 `cloud` 是"两阶段"而不是 worker 自己发 HTTP
#: `AGENTS.md §0`：**Node 是编排者，Python 是计算器**。
#: 若 worker 自己用 Python 调 OpenRouter，就会出现**第二套 OCR 实现**
#: （第二份提示词/模型名/降级链）—— 正是坑 27「两条路径 = 两套真相」的形状。
#: 两阶段做法：worker 渲染（PyMuPDF 是 Python 的活）+ Node 调 API（provider 在 Node）
#: ⟹ **OpenRouter 调用只存在一处**。
OCR_MODE_CLOUD = "cloud"
OCR_MODE_LOCAL = "local"
OCR_MODE_OFF = "off"

#: 默认 OCR 模式 —— **云端**（用户指令）。
DEFAULT_OCR_MODE = OCR_MODE_CLOUD

#: 云端 OCR 的**预计单页耗时（秒）**，用于诚实的耗时/成本预估。
#: ⚠️ `[实测-外部]` Lead 实测：glm-5.3-flash **3821ms/页**、gemini-2.5-flash-lite **5460ms/页**。
#: 本值取较快档 + 网络余量，仅用于**预估提示**；真实耗时由实测更新。
CLOUD_OCR_SECS_PER_PAGE_EST = 3.82

#: 云端 OCR **每页 token 的实测值**（用于计费估算）。
#:
#: ★★ `[实测]` 本机真端点探测（2026-10-16，`qwen/qwen3-vl-235b-a22b-instruct`，
#: 真实教材页 = 434 页扫描件第 30 页，150 DPI → 166KB JPEG）：
#: ```
#: prompt_tokens  = 1457 / 页
#: completion_tokens = 533 / 页
#: ```
#: ⚠️ **原估算错了 6.5 倍**：我原来只按 2000 prompt tokens × $0.0001/1K 算 → $0.0002/页。
#: 真实成本是 **$0.00132/页** —— 因为**输出 token 单价是输入的 9 倍**
#: （in $0.21/M vs out $1.90/M），**输出占比 27% 却贡献 77% 的费用**。
#: ⟹ 教训：**算 token 成本必须把输入与输出分开**，不能只按一个单价乘总量。
CLOUD_OCR_PROMPT_TOKENS_PER_PAGE = 1457
CLOUD_OCR_COMPLETION_TOKENS_PER_PAGE = 533

#: 模型单价（USD / 1M tokens）—— `[实测-外部]` OpenRouter 模型 API 报价。
#: 默认对应主模型 `qwen/qwen3-vl-235b-a22b-instruct`（in $0.21/M · out $1.90/M）。
CLOUD_OCR_USD_PER_M_INPUT = 0.21
CLOUD_OCR_USD_PER_M_OUTPUT = 1.90


def estimate_ocr_cost(pages: int, *, mode: str = OCR_MODE_CLOUD) -> dict:
    """OCR 的**耗时与计费估算**（估算值，如实标明口径）。

    为什么要它：用户说"投资要在合理范围内大力的" ⟹
    **不是替他把页数砍掉，而是把成本摆出来让他自己决定**。
    """
    pages = max(0, int(pages))
    if mode == OCR_MODE_LOCAL:
        return {
            "mode": "local",
            "pages": pages,
            "est_seconds": pages * 12.8,      # `[实测]` 20 页连续样本 12.79s/页
            "est_minutes": round(pages * 12.8 / 60, 1),
            "est_usd": 0.0,
            "billing_note": "本地 OCR：不产生 API 费用，但占用 CPU（~12.8 秒/页）。",
        }
    tokens_in = pages * CLOUD_OCR_PROMPT_TOKENS_PER_PAGE
    tokens_out = pages * CLOUD_OCR_COMPLETION_TOKENS_PER_PAGE
    # ★ 输入/输出**分开算**（单价差 9 倍；只按一个单价乘总量会低估 6.5 倍 —— 见常量注释）
    usd = tokens_in / 1_000_000 * CLOUD_OCR_USD_PER_M_INPUT + tokens_out / 1_000_000 * CLOUD_OCR_USD_PER_M_OUTPUT
    secs = pages * CLOUD_OCR_SECS_PER_PAGE_EST
    return {
        "mode": "cloud",
        "pages": pages,
        "est_seconds": round(secs, 1),
        "est_minutes": round(secs / 60, 1),
        # ⚠️ 口径写清楚：按**图片 token**计费（输入+输出分开），不是按次
        "est_usd": round(usd, 4),
        "est_tokens_input": tokens_in,
        "est_tokens_output": tokens_out,
        "billing_note": (
            f"云端 OCR（OpenRouter 视觉模型）：按 **token** 计费（输入+输出分开算）——"
            f"实测 **{CLOUD_OCR_PROMPT_TOKENS_PER_PAGE} in + {CLOUD_OCR_COMPLETION_TOKENS_PER_PAGE} out** tokens/页；"
            f"单价 in ${CLOUD_OCR_USD_PER_M_INPUT}/M · out ${CLOUD_OCR_USD_PER_M_OUTPUT}/M；"
            f"{pages} 页 ≈ **${usd:.4f}**（USD，估算；**以 OpenRouter 账单为准**）"
        ),
        "time_note": f"约 {CLOUD_OCR_SECS_PER_PAGE_EST}s/页（实测档）→ {pages} 页约 {round(secs / 60, 1)} 分钟",
    }


#: OCR 引擎实例缓存（**仅 `mode='local'` 用**）。
#:
#: `[实测]` **每次新建 `RapidOCR()` 要 13.9s，复用只要 9.0s**（省 ~35%）。
#: 原错误写法（我第一版就是）：跟 `worker/video/slides.py::ocr_image` 一样
#: **每页都 `RapidOCR()`** —— 对 434 页就是 434 次模型初始化。
#: ⚠️ `worker/video/**` 是 video-pipeline 的写域，我不改它；
#:    这里在本文件内自带缓存引擎（同样的引擎清单，不同的生命周期管理）。
_OCR_ENGINE_CACHE: dict[str, object] = {}


def _get_ocr_engine(engine: str):
    """取（并缓存）OCR 引擎实例；同一进程内只初始化一次。"""
    if engine in _OCR_ENGINE_CACHE:
        return _OCR_ENGINE_CACHE[engine]
    inst = None
    if engine == "rapidocr":
        from rapidocr_onnxruntime import RapidOCR  # type: ignore

        inst = RapidOCR()
    elif engine == "easyocr":
        import easyocr  # type: ignore

        inst = easyocr.Reader(["ch_sim", "en"])
    elif engine == "paddleocr":
        from paddleocr import PaddleOCR  # type: ignore

        inst = PaddleOCR(use_angle_cls=True, lang="ch", show_log=False)
    elif engine == "tesseract":
        inst = "tesseract"  # 无状态，只需记住引擎名
    _OCR_ENGINE_CACHE[engine] = inst
    return inst


def _ocr_one_page(engine: str, image_path: str) -> str:
    """用**缓存实例**对单张图 OCR；失败返回空串（不抛、不编造）。"""
    try:
        inst = _get_ocr_engine(engine)
        if engine == "tesseract":
            import pytesseract  # type: ignore
            from PIL import Image  # type: ignore

            with Image.open(image_path) as img:
                return str(pytesseract.image_to_string(img, lang="chi_sim+eng")).strip()
        if engine == "rapidocr":
            result, _ = inst(image_path)  # type: ignore[operator]
            return "\n".join(line[1] for line in (result or [])).strip()
        if engine == "easyocr":
            return "\n".join(inst.readtext(image_path, detail=0)).strip()  # type: ignore[union-attr]
        if engine == "paddleocr":
            res = inst.ocr(image_path, cls=True)  # type: ignore[union-attr]
            lines: list[str] = []
            for page in res or []:
                for item in page or []:
                    try:
                        lines.append(str(item[1][0]))
                    except (IndexError, TypeError):
                        continue
            return "\n".join(lines).strip()
    except Exception as exc:  # noqa: BLE001 - OCR 失败不该毁掉整条流水线
        log.warning("OCR 失败（%s，%s）：%s", image_path, engine, exc)
    return ""

#: 非内容章标题（坑 3）。匹配前先去掉编号与空白。
#:
#: ⚠️ 只匹配**兜底附录类**的索引/术语表，**不能**匹配所有含 index 的标题：
#:    第一版写成 ``^.*\bindex(es)?$`` → 把 "17.5.3 Adaptive Hash Index"、
#:    "22.3.3.6 Create and Drop Indexes"、"10.3 Optimization and Indexes"
#:    这些**真正的正文小节**整片删掉了（实测误删 44 节点 / 37 页）。
#:    现在只认「Index / Indexes」或「Appendix X Indexes」这种独立成章的形态。
_SKIP_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^(table of contents|contents|目录|目次)$", re.I),
    re.compile(r"^(index|indexes|appendix\s+[a-z]\s+indexes?)$", re.I),
    re.compile(r"^.*\bglossary$", re.I),  # "MySQL Glossary"
    re.compile(r"^(bibliography|references|colophon|索引|术语表|参考文献)$", re.I),
)

#: 编号前缀：``7.4.2.6 Rule-Based…`` / ``Chapter 7 xxx`` / ``第 3 章 xxx``
_NUM_PREFIX = re.compile(
    r"^(?:\d+(?:\.\d+)*|\d+(?:\.\d+)*\.|[A-Z]\.|chapter\s+\d+|第\s*\d+\s*章)\s*[.:、]?\s+",
    re.I,
)


def normalize_title(title: str) -> str:
    """去掉编号前缀与空白，便于匹配（保留原样用于展示）。"""
    t = (title or "").replace("\xa0", " ").strip()
    for _ in range(3):  # "1.2.3 4.2 Title" 这种多重编号
        new = _NUM_PREFIX.sub("", t)
        if new == t:
            break
        t = new
    return re.sub(r"\s+", " ", t).strip()


def is_non_content(title: str) -> bool:
    t = normalize_title(title)
    return any(p.match(t) for p in _SKIP_PATTERNS)


def extra_skip_patterns() -> tuple[re.Pattern[str], ...]:
    """``COURSE_KB_PDF_SKIP`` 加分号分隔的额外正则（资料相关的索引章等）。"""
    raw = os.environ.get("COURSE_KB_PDF_SKIP", "").strip()
    if not raw:
        return ()
    out = []
    for part in raw.split(";"):
        part = part.strip()
        if part:
            try:
                out.append(re.compile(part, re.I))
            except re.error:
                continue
    return tuple(out)


# ═══════════════════════════════════════════════════════════════════════
# 文本层探测（图片型 PDF 判定）
# ═══════════════════════════════════════════════════════════════════════


@dataclass
class TextProfile:
    """**逐页**「字符数 / 图片数」实测画像 —— 数字来自真页面，不是估计。

    ★★ 为什么必须是**逐页**而不是文档级平均（lead 指出的关键，我原设计错了）：

    ```
    半扫描件: 一半页有字(600 字/页) + 一半页 0 字
              → 文档级均值 300 字/页 → 判成 native
              → 那一半空页【静默丢】，永远不进 OCR
    ```
    ⟹ **文档级平均阈值对"半扫描件"必然失效**。逐页判定让这种情形天然被覆盖
    （只对 image 页走 OCR，native 页照旧），**且不需要额外的"半扫描件"样本来校准**。

    :param page_chars: 页号 → 字符数（**全量**，不是抽样）
    :param page_images: 页号 → 图片数（全量）
    """

    #: 页号 → 该页字符数（1-based；全量页）
    page_chars: dict[int, int]
    #: 页号 → 该页图片数（1-based；全量页；**实际绘制**的图，非资源引用）
    page_images: dict[int, int]
    page_count: int
    #: 页号 → 最大图片覆盖率（0~1），用于区分"整页扫描图"与"页内插图"
    page_coverage: dict[int, float] = field(default_factory=dict)
    #: 判定用的字符阈值（存档，便于事后复核判据）
    chars_threshold: float = IMAGE_PDF_CHARS_PER_PAGE
    #: 判定用的图片阈值
    images_threshold: float = IMAGE_PDF_IMAGES_PER_PAGE
    #: 判定用的覆盖率阈值
    coverage_threshold: float = IMAGE_PDF_MIN_COVERAGE
    #: 逐页判定结果：页号 → 'native' | 'image' | 'empty'
    page_modes: dict[int, str] = field(default_factory=dict)

    # ── 统计（都基于**全量**页）────────────────────────────────────
    @property
    def pages_native(self) -> int:
        return sum(1 for m in self.page_modes.values() if m == "native")

    @property
    def pages_image(self) -> int:
        return sum(1 for m in self.page_modes.values() if m == "image")

    @property
    def pages_empty(self) -> int:
        return sum(1 for m in self.page_modes.values() if m == "empty")

    @property
    def image_pages(self) -> list[int]:
        """需要 OCR 的页号（有序）。"""
        return sorted(p for p, m in self.page_modes.items() if m == "image")

    @property
    def chars_per_page_mean(self) -> float:
        vals = list(self.page_chars.values())
        return (sum(vals) / len(vals)) if vals else 0.0

    @property
    def chars_per_page_median(self) -> float:
        vals = sorted(self.page_chars.values())
        if not vals:
            return 0.0
        n = len(vals)
        mid = n // 2
        return float(vals[mid]) if n % 2 else (vals[mid - 1] + vals[mid]) / 2.0

    def to_dict(self) -> dict:
        vals = sorted(self.page_chars.values())
        return {
            "pages_total": self.page_count,
            "pages_native": self.pages_native,
            "pages_image": self.pages_image,
            "pages_empty": self.pages_empty,
            "chars_per_page": {
                "mean": round(self.chars_per_page_mean, 2),
                "median": round(self.chars_per_page_median, 2),
                "max": (vals[-1] if vals else 0),
                "min": (vals[0] if vals else 0),
            },
            "chars_threshold": self.chars_threshold,
            "images_threshold": self.images_threshold,
            "coverage_threshold": self.coverage_threshold,
        }


def analyze_text_profile(doc, *, max_pages: int = 0) -> TextProfile:
    """**逐页**测字符数/图片数 + 逐页判 mode（``doc`` 是已打开的 ``fitz.Document``）。

    ⚠️ 遍历**全量页**而不是抽样：抽样会漏掉"少数几页是扫描图"的情况，
    而那正是我们最需要发现的（半扫描件）。代价是一次 ``get_text``/页 ——
    对 6392 页的手册实测可接受（本函数只在解析时跑一次）。
    ``max_pages`` >0 时只测前 N 页（与 ``PdfAdapter.max_pages`` 一致的窗口语义）。
    """
    total = int(doc.page_count)
    limit = min(total, max_pages) if max_pages and max_pages > 0 else total
    page_chars: dict[int, int] = {}
    page_images: dict[int, int] = {}
    page_coverage: dict[int, float] = {}
    page_modes: dict[int, str] = {}
    for pg in range(1, limit + 1):
        try:
            page = doc[pg - 1]
            chars = len((page.get_text("text") or "").strip())
            # ★ 用"实际绘制在页上的图"（get_image_info），不是"页引用的资源"（get_images）
            #    —— 见 _page_image_stats 的实测教训（refman 空白页 83 vs 0）
            images, coverage = _page_image_stats(page)
        except Exception:  # noqa: BLE001 - 单页坏不该毁整篇
            chars, images, coverage = 0, 0, 0.0
        page_chars[pg] = chars
        page_images[pg] = images
        page_coverage[pg] = coverage
        page_modes[pg] = _classify_page(chars, images, coverage)
    return TextProfile(
        page_chars=page_chars,
        page_images=page_images,
        page_count=total,
        page_coverage=page_coverage,
        page_modes=page_modes,
    )


def _classify_page(chars: int, images: int, coverage: float = 0.0) -> str:
    """单页判定：``native``（有文字层）/ ``image``（扫描图，需 OCR）/ ``empty``（都没）。

    ``image`` 还要求**图片基本铺满页面**（``coverage >= IMAGE_PDF_MIN_COVERAGE``）——
    见 :func:`_page_image_stats` 的实测教训：只在页内放一张小插图、页上又没几个字，
    不该被当成"扫描件需要 OCR"。
    """
    if chars >= IMAGE_PDF_CHARS_PER_PAGE:
        return "native"
    if images >= IMAGE_PDF_IMAGES_PER_PAGE and coverage >= IMAGE_PDF_MIN_COVERAGE:
        return "image"
    return "empty"


def _page_image_stats(page) -> tuple[int, float]:
    """页上**实际显示**的图片数与最大覆盖率。

    ★★ 这里踩过一个真坑（`[实测]`），值得写清楚：

    **原错误写法**：用 ``page.get_images(full=True)`` 数图片。

    但 ``get_images()`` 返回的是**页引用的 XObject 资源**，**不保证被画出来**。
    实测反例（refman 第 30 页，一张**空白页**，正文只有 "xxx"）：
    ```
    get_text()        → 'xxx'（1 个字符）
    get_images(full=True) → **83**     ← 资源引用数
    get_image_info()      → **0**      ← 真正显示在页上的图
    ```
    后果：该页 `chars=3 < 20` 且 `images=83 >= 0.5` → 被误判为 **`image`（需 OCR）**。
    refman 有 **22 页**是这种空白页 → 22 次白跑 OCR（每次 ~9-12s，约 4 分钟），
    且 OCR 结果必然为空（页面本来就没内容），却会被记成 `pages_empty`。

    **正确判据**：用 ``get_image_info()``（**实际绘制**在页上的图），
    并返回最大覆盖率供调用方进一步区分"整页扫描图"与"页内插图"。
    """
    try:
        infos = page.get_image_info()
    except Exception:  # noqa: BLE001 - 老版本 PyMuPDF 无此 API 时退化为 0
        return 0, 0.0
    n = len(infos)
    area = float(page.rect.width) * float(page.rect.height)
    best = 0.0
    if area > 0:
        for im in infos:
            bbox = im.get("bbox")
            if not bbox or len(bbox) < 4:
                continue
            w = max(0.0, float(bbox[2]) - float(bbox[0]))
            h = max(0.0, float(bbox[3]) - float(bbox[1]))
            best = max(best, (w * h) / area)
    return n, best


def classify_text_mode(profile: TextProfile) -> str:
    """文档级汇总：``native`` | ``image`` | ``mixed`` | ``empty``。

    ``mixed`` = **既有 native 页又有 image 页** —— 这就是"半扫描件"，
    **必须独立成一档并如实上报**（否则用户看不出"部分页需要 OCR"）。
    """
    n_native, n_image = profile.pages_native, profile.pages_image
    if n_image and n_native:
        return "mixed"
    if n_image:
        return "image"
    if n_native:
        return "native"
    return "empty"


# ═══════════════════════════════════════════════════════════════════════
# OCR（按页；能力如实上报，绝不伪造坐标）
# ═══════════════════════════════════════════════════════════════════════


def ocr_availability() -> dict:
    """OCR 引擎能力探测 —— **如实**（``configured`` 与 ``available`` 分开）。

    复用 ``worker/video/slides.py`` 的引擎清单，**不另写一份**（避免两套真相）。
    ``configured`` = 相关 python 包在；``available`` = 真能跑（tesseract 需 exe 存在）。
    """
    try:
        from worker.video.slides import ocr_availability as _video_ocr_availability
    except Exception as exc:  # noqa: BLE001 - video 模块缺失不该让 PDF OCR 一起崩
        return {
            "configured": False,
            "available": False,
            "engine": "",
            "reason": f"OCR 探测不可用：{type(exc).__name__}: {exc}",
        }
    cap = _video_ocr_availability()
    return {
        "configured": True,  # 引擎清单可读 = 我们"配了"探测
        "available": bool(cap.get("available")),
        "engine": str(cap.get("engine") or ""),
        "reason": str(cap.get("reason") or ""),
    }


def ocr_pages(
    path: str,
    pages: Iterable[int],
    *,
    mode: str = DEFAULT_OCR_MODE,
    dpi: int = OCR_RENDER_DPI,
    on_progress: ProgressFn | None = None,
    max_pages: int = 0,
    base_frac: float = 0.0,
    span_frac: float = 1.0,
    out_dir: str = "",
    cloud_texts: dict[int, str] | None = None,
) -> dict:
    """按页 OCR：返回 ``{页号: 该页识别文本}`` + 如实的 meta。

    ## 两种模式（`mode`，**默认 `'cloud'`** —— 用户指令）
    * **`'cloud'`（默认）**：worker **只渲染**，**不调任何模型**。
      返回 ``images``（页→图路径），由 **Node 调 OpenRouter**（唯一实现处）。
      若调用方已把 Node 的 OCR 结果通过 ``cloud_texts`` 传回（第二阶段），
      则本函数直接把文本填进 ``texts``。
    * **`'local'`**：worker 自己调本地 rapidocr（**仅显式选择时**）。

    ## ★★ 硬约束
    * **不许静默降级回本地**：`mode='cloud'` 且拿不到云端文本时，
      **如实标注** `skipped='cloud_ocr_not_provided'` + 可读 reason，
      **绝不偷偷用 rapidocr**（那会违背用户指令，且让 `ocr_engine` 自述失真 —— 坑 21）。
    * **绝不伪造坐标**：不返回 `box`；页内顺序标 `approx`。
    * 与 `_OCR_ENGINE_CACHE` 同源 —— 本地引擎只在 `mode='local'` 时才初始化。
    """
    page_list = [int(p) for p in pages]
    if max_pages and max_pages > 0:
        page_list = page_list[:max_pages]

    out: dict[int, str] = {}
    cost = estimate_ocr_cost(len(page_list), mode=mode)
    meta: dict = {
        "ocr_mode": mode,
        "pages_requested": len(page_list),
        "pages_ocr_ok": 0,
        "pages_empty": 0,
        "dpi": dpi,
        # 如实：LLM 型 OCR 无检测框，页内顺序是"近似"
        "within_page_order": "approx",
        "box": None,
        "cost_estimate": cost,
    }

    if not page_list:
        meta["reason"] = "没有需要 OCR 的页"
        meta["chars_ocr"] = 0
        return {"texts": out, "meta": meta, "images": []}

    # ── 云端模式：渲染 → 交给 Node（唯一 OpenRouter 实现处）──────────────
    if mode == OCR_MODE_CLOUD:
        meta["engine"] = "openrouter"

        # ★ 第二阶段**不需要**图片文件：cloud_texts 以**页号**为键，
        #   而页号由我们自己掌握 ⟹ **跳过渲染**，省掉一整趟 434 页的渲染开销。
        if cloud_texts is not None:
            meta["stage"] = "cloud_texts_applied"
            meta["available"] = True
            meta["configured"] = True
            meta["pages_rendered"] = 0
            for pg in page_list:
                txt = (cloud_texts.get(pg) or "").strip()
                if len(txt) >= OCR_MIN_PAGE_CHARS:
                    out[pg] = txt
                    meta["pages_ocr_ok"] += 1
                else:
                    meta["pages_empty"] += 1
            meta["chars_ocr"] = sum(len(t) for t in out.values())
            if meta["pages_ocr_ok"] == 0:
                meta["reason"] = (
                    f"云端 OCR 对 {len(page_list)} 页均未返回可用文字（每页 < {OCR_MIN_PAGE_CHARS} 字符）"
                    f"→ 这些页可能确实没有文字"
                )
            return {"texts": out, "meta": meta, "images": []}

        render_dir = out_dir or os.path.join(tempfile.gettempdir(), f"pdfocr_{os.getpid()}_{int(time.time())}")
        rendered = render_pages_to_images(
            path, page_list, render_dir,
            dpi=dpi, on_progress=on_progress, max_pages=max_pages,
        )
        meta["renderer"] = rendered["meta"].get("renderer")
        meta["pages_rendered"] = rendered["meta"].get("pages_rendered", 0)
        meta["pages_render_failed"] = rendered["meta"].get("pages_failed", 0)
        images = rendered["images"]

        # ★ 第一阶段结束：等 Node 调 OpenRouter 后回传。
        #    **绝不**在这里 fallback 到本地 —— 如实说明"文本尚未提供"。
        meta["available"] = True          # 云端通道可用（凭据/模型由 Node 判定）
        meta["configured"] = True
        meta["stage"] = "rendered_awaiting_cloud_ocr"
        meta["reason"] = (
            f"已渲染 {len(images)} 页待云端 OCR；"
            f"由 Node 的 providers.recognize() 调用 OpenRouter（{cost['billing_note']}）"
        )
        return {"texts": out, "meta": meta, "images": images}

    # ── 本地模式（**仅显式选择**）────────────────────────────────────────
    cap = ocr_availability()
    meta.update({"configured": cap["configured"], "available": cap["available"],
                 "engine": cap["engine"], "reason": cap["reason"]})
    if not cap["available"]:
        meta["skipped"] = "local_ocr_unavailable"
        return {"texts": out, "meta": meta, "images": []}

    try:
        import fitz
    except ImportError as exc:  # pragma: no cover
        meta["available"] = False
        meta["reason"] = f"PyMuPDF 不可用：{exc}"
        return {"texts": out, "meta": meta, "images": []}

    doc = fitz.open(str(path))
    try:
        engine = str(cap.get("engine") or "")
        # 预初始化引擎（把一次性的模型加载成本从"每页"降到"每篇"）
        try:
            _get_ocr_engine(engine)
        except Exception as exc:  # noqa: BLE001
            meta["available"] = False
            meta["reason"] = f"OCR 引擎初始化失败（{engine}）：{type(exc).__name__}: {exc}"
            return {"texts": out, "meta": meta, "images": []}

        for idx, pg in enumerate(page_list, 1):
            tmp_png = ""
            try:
                page = doc[pg - 1]
                pix = page.get_pixmap(dpi=int(dpi))
                # 用临时文件：rapidocr 的 API 接受路径（与 video 侧同一调用形态）
                fd, tmp_png = tempfile.mkstemp(suffix=".png", prefix="pgocr_")
                os.close(fd)
                pix.save(tmp_png)
                text = _ocr_one_page(engine, tmp_png)
            except Exception as exc:  # noqa: BLE001 - 单页 OCR 失败不该毁整篇
                log.warning("第 %s 页 OCR 失败：%s", pg, exc)
                text = ""
            finally:
                if tmp_png:
                    try:
                        os.unlink(tmp_png)
                    except OSError:
                        pass

            text = (text or "").strip()
            if len(text) >= OCR_MIN_PAGE_CHARS:
                out[pg] = text
                meta["pages_ocr_ok"] += 1
            else:
                meta["pages_empty"] += 1
            if on_progress:
                report(
                    on_progress,
                    base_frac + span_frac * (idx / max(1, len(page_list))),
                    f"OCR 第 {pg} 页（{idx}/{len(page_list)}）",
                )
    finally:
        doc.close()

    meta["chars_ocr"] = sum(len(t) for t in out.values())
    if meta["pages_ocr_ok"] == 0 and page_list:
        meta["reason"] = (
            f"OCR 可用（{cap['engine']}）但对 {len(page_list)} 页均未识别出文字"
            f"（每页 < {OCR_MIN_PAGE_CHARS} 字符）→ 该 PDF 可能是空白页/纯图无文字"
        )
    return {"texts": out, "meta": meta, "images": []}


def render_pages_to_images(
    path: str,
    pages: Iterable[int],
    out_dir: str,
    *,
    dpi: int = OCR_RENDER_DPI,
    on_progress: ProgressFn | None = None,
    max_pages: int = 0,
) -> dict:
    """把指定页渲染成 PNG 文件（**云端 OCR 的第一阶段**）。

    为什么拆出这一步：`AGENTS.md §0`「**Node 是编排者，Python 是计算器**」——
    渲染 PDF 页是 PyMuPDF（Python）的活，而**调用 OpenRouter 必须只有一处**
    （`apps/server/src/providers/openrouter_ocr.ts`）。
    两阶段为此：worker 渲染 → Node 调 API → 文本回流建单元。

    :return: ``{"images": [{"page": 1, "path": "..."}, ...], "meta": {...}}``
        ⚠️ `meta` **不谎称已 OCR**：这里只渲染，`ocr_engine` 由 Node 回填。
    """
    try:
        import fitz
    except ImportError as exc:  # pragma: no cover
        return {"images": [], "meta": {"available": False, "reason": f"PyMuPDF 不可用：{exc}"}}

    page_list = [int(p) for p in pages]
    if max_pages and max_pages > 0:
        page_list = page_list[:max_pages]
    os.makedirs(out_dir, exist_ok=True)

    images: list[dict] = []
    meta: dict = {
        "renderer": "pymupdf",
        "dpi": dpi,
        "pages_requested": len(page_list),
        "pages_rendered": 0,
        "pages_failed": 0,
        # 如实：**没有坐标**（视觉 LLM OCR 无检测框）
        "box": None,
        "within_page_order": "approx",
    }
    if not page_list:
        meta["reason"] = "没有需要渲染的页"
        return {"images": images, "meta": meta}

    doc = fitz.open(str(path))
    try:
        for idx, pg in enumerate(page_list, 1):
            out_png = os.path.join(out_dir, f"page_{pg:06d}.png")
            try:
                page = doc[pg - 1]
                pix = page.get_pixmap(dpi=int(dpi))
                pix.save(out_png)
                images.append({"page": pg, "path": out_png})
                meta["pages_rendered"] += 1
            except Exception as exc:  # noqa: BLE001 - 单页渲染失败不该毁整篇
                log.warning("第 %s 页渲染失败：%s", pg, exc)
                meta["pages_failed"] += 1
            if on_progress:
                report(on_progress, idx / max(1, len(page_list)), f"渲染第 {pg} 页（{idx}/{len(page_list)}）")
    finally:
        doc.close()

    meta["out_dir"] = out_dir
    return {"images": images, "meta": meta}


def _env_ocr_max_pages() -> int:
    """``COURSE_KB_OCR_MAX_PAGES`` 覆盖 OCR 页数上限。

    **默认 0 = 不限制**（用户裁定取消上限）。
    环境变量设为正整数时启用限流（**紧急限成本**用）；
    设为 ``0`` 或非法值 → 不限制。
    """
    raw = os.environ.get("COURSE_KB_OCR_MAX_PAGES", "").strip()
    if raw:
        try:
            v = int(raw)
            if v > 0:
                return v
        except ValueError:
            pass
    return DEFAULT_OCR_MAX_PAGES


@register
class PdfAdapter(DocumentAdapter):
    """PDF：TOC 小节 → 层次树；无 TOC 时降级为固定页窗。"""

    kind = "pdf"
    extensions = (".pdf",)

    def __init__(
        self,
        *,
        max_pages_per_unit: int = MAX_PAGES_PER_UNIT,
        max_pages: int = 0,
        ocr: str = "auto",
        ocr_mode: str = DEFAULT_OCR_MODE,
        ocr_dpi: int = OCR_RENDER_DPI,
        ocr_max_pages: int = 0,
        cloud_ocr_texts: dict[int, str] | None = None,
    ):
        self.max_pages_per_unit = max(1, int(max_pages_per_unit))
        #: >0 时只解析前 N 页（调试/测试用；0 = 全篇）
        self.max_pages = max(0, int(max_pages))
        #: 旧开关：``auto`` | ``off``（**保留兼容**；`off` 等价于 `ocr_mode='off'`）
        self.ocr = ocr if ocr in ("auto", "off") else "auto"
        #: ★ OCR 模式：``cloud``（默认，用户指令）| ``local`` | ``off``
        self.ocr_mode = ocr_mode if ocr_mode in (OCR_MODE_CLOUD, OCR_MODE_LOCAL, OCR_MODE_OFF) else DEFAULT_OCR_MODE
        if self.ocr == "off":
            self.ocr_mode = OCR_MODE_OFF
        self.ocr_dpi = max(72, int(ocr_dpi))
        #: OCR 页数上限；0 = **不限制**（用户裁定取消上限）。
        #: ``COURSE_KB_OCR_MAX_PAGES`` 可覆盖（紧急限成本用）。
        self.ocr_max_pages = max(0, int(ocr_max_pages)) or _env_ocr_max_pages()
        #: ★ 云端模式第二阶段：Node 已 OCR 好的 ``{页号: 文本}``（None = 第一阶段）
        self.cloud_ocr_texts = cloud_ocr_texts

    def can_handle(self, path: str) -> bool:
        if Path(path).suffix.lower() in self.extensions:
            return True
        # 扩展名不可信时的魔数兜底（上传文件可能被改名）
        try:
            with open(path, "rb") as fh:
                return fh.read(5) == b"%PDF-"
        except OSError:
            return False

    # ── 解析 ────────────────────────────────────────────────────────
    def parse(self, path: str, *, on_progress: ProgressFn | None = None) -> DocDraft:
        p = Path(path)
        if not p.exists():
            raise ParseError(f"文件不存在：{path}")
        try:
            import fitz  # PyMuPDF
        except ImportError as exc:  # pragma: no cover
            raise ParseError(f"PyMuPDF 不可用：{exc}") from exc

        report(on_progress, 0.02, "打开 PDF")
        try:
            doc = fitz.open(str(p))
        except Exception as exc:
            raise ParseError(f"无法打开 PDF：{exc}") from exc

        try:
            total_pages = int(doc.page_count)
            limit = min(total_pages, self.max_pages) if self.max_pages else total_pages
            toc = doc.get_toc(simple=True) or []
            report(on_progress, 0.06, f"读目录（{len(toc)} 项 / {total_pages} 页）")

            cache: dict[int, str] = {}

            def page_text(pg: int) -> str:
                if pg not in cache:
                    try:
                        cache[pg] = doc[pg - 1].get_text("text") or ""
                    except Exception:  # noqa: BLE001 - 单页坏不该毁整篇
                        cache[pg] = ""
                return cache[pg]

            meta: dict = {
                "toc_entries": len(toc),
                "pages_total": total_pages,
                "pages_parsed": limit,
                "text_policy": f"每个 unit 仅存前 {self.max_pages_per_unit} 页正文",
            }

            # ── ★ 文本层探测（逐页）：图片型 PDF 的判定与新正文来源 ──────────
            # 原错误写法：不探测、直接 get_text() → 扫描件产出**全空正文**的 unit，
            #            解析仍标 done，下游 LLM 收到空串 → 167 units 只出 1 张卡。
            profile = analyze_text_profile(doc, max_pages=self.max_pages)
            text_mode = classify_text_mode(profile)
            meta["text_profile"] = profile.to_dict()
            meta["text_mode"] = text_mode
            report(
                on_progress,
                0.10,
                f"文本层探测：{text_mode}（native {profile.pages_native} / image {profile.pages_image} / "
                f"empty {profile.pages_empty} 页）",
            )

            # 需要 OCR 的页：**只对逐页判定为 image 的页**做
            # （半扫描件天然被覆盖；native 页不动，不浪费）
            ocr_pages_list = [p for p in profile.image_pages if p <= limit]
            ocr_result = {"texts": {}, "meta": {}}
            if ocr_pages_list:
                max_ocr = self.ocr_max_pages
                skipped_by_cap = 0
                if max_ocr and max_ocr > 0 and len(ocr_pages_list) > max_ocr:
                    skipped_by_cap = len(ocr_pages_list) - max_ocr
                    ocr_pages_list = ocr_pages_list[:max_ocr]
                # 默认**自动** OCR；显式关闭时也不静默 —— 下面是如实标注
                if self.ocr == "off":
                    ocr_result = {
                        "texts": {},
                        "meta": {
                            **ocr_availability(),
                            "skipped": "ocr_disabled_by_config",
                            "pages_requested": len(ocr_pages_list),
                            "reason": (
                                f"检测到 {len(ocr_pages_list)} 页为扫描图，但 OCR 被显式关闭"
                                f"（PdfAdapter(ocr='off')）→ 这些页**没有正文**，"
                                f"不应期望从中抽出卡片"
                            ),
                        },
                    }
                else:
                    ocr_result = ocr_pages(
                        str(p),
                        ocr_pages_list,
                        mode=self.ocr_mode,
                        dpi=self.ocr_dpi,
                        on_progress=on_progress,
                        max_pages=max_ocr,
                        base_frac=0.10,
                        span_frac=0.25,
                        # ★ 云端模式下：调用方（Node）已把 OCR 文本按页回传时，直接用它
                        **({"cloud_texts": self.cloud_ocr_texts} if self.cloud_ocr_texts is not None else {}),
                    )
                meta["ocr"] = ocr_result["meta"]
                # ★ 云端模式第一阶段：把"待 OCR 的页图清单"交给调用方（Node）
                #   —— 只有一处 OpenRouter 实现（providers/openrouter_ocr.ts）
                if ocr_result.get("images"):
                    meta["ocr_images"] = ocr_result["images"]
                    meta["ocr_awaiting_cloud"] = bool(
                        ocr_result["meta"].get("stage") == "rendered_awaiting_cloud_ocr"
                    )
                # ★ 如实标注"因上限而未 OCR 的页" —— 绝不假装全篇都 OCR 过
                if skipped_by_cap:
                    meta["ocr"]["pages_skipped_by_cap"] = skipped_by_cap
                    meta["ocr"]["cap"] = max_ocr
                    meta["ocr"]["cap_note"] = (
                        f"共 {len(profile.image_pages)} 页为扫描图，按上限（{max_ocr}）只 OCR 了 "
                        f"{len(ocr_pages_list)} 页，**其余 {skipped_by_cap} 页没有正文**"
                        f"（CPU OCR ≈9s/页；可用 COURSE_KB_OCR_MAX_PAGES 调高，或换 GPU/云 OCR）"
                    )
                # 把 OCR 文本并入页文本缓存 → **同一套建树/抽取管线**自动用上
                for pg, txt in ocr_result["texts"].items():
                    cache[pg] = txt
                meta["ocr_chars"] = int(ocr_result["meta"].get("chars_ocr") or 0)
                meta["ocr_pages_used"] = len(ocr_result["texts"])
            else:
                meta["ocr"] = {
                    **ocr_availability(),
                    "used": False,
                    "pages_requested": 0,
                    "reason": "该 PDF 每页都有文字层，无需 OCR",
                }

            # 探测后重新计算"整篇是否有正文" —— 这决定了后续会不会空转 LLM
            probe_pages = [pg for pg in range(1, limit + 1)]
            total_body_chars = sum(len(page_text(pg).strip()) for pg in probe_pages[:200])
            meta["body_chars_sampled"] = total_body_chars
            meta["body_chars_sampled_pages"] = min(200, len(probe_pages))

            # ── ★ 逐页 text_origin（来源标记）───────────────────────────            # 本页正文是"原生文字层"还是"OCR 识别出来的"？—— 下游据此做**诊断与前端标注**。
            #
            # ⚠️ **提示词不按它分化**（只加一条通用约束，见 `worker/MULTIFORMAT.md` §6）——
            #    `text_origin` **不是提示词开关**，4 种类型 × 提示词分身 = 4 份真相必然漂移。
            #
            # ⚠️ 关于"逐字校验"：`evidence_quote` 是否与正文逐字一致，**由
            #    `worker/pipeline/extract_core.py` 的 quote audit 判定**（五分类
            #    exact/normalized/rewritten/fabricated/missing，见 `worker/README.md` §5，
            #    由 backend-core 实现）。本文件**不**做该校验，只提供来源标记。
            #    ★ 实测要点：OCR **错字不会**造成假失败 —— 模型照抄含错字的正文照样匹配；
            #      真正不匹配的是模型"顺手修正"了错字（那正是要抓的行为）。
            #
            # ⚠️ 放在 `meta` 而不是新增 `UnitDraft` 字段：`base.py` 是**冻结契约**
            #    （AGENTS.md §2：新增格式只实现接口，不改核心）。`meta` 是明确的
            #    "格式特有信息、核心管线不读"的通道 → 加字段不破坏任何现有调用方。
            #    下游（`extract.plan`）按 unit 的 span 覆盖页求交推导 unit 级来源。
            ocr_page_set = set(ocr_result["texts"].keys())
            meta["text_origin_pages"] = {
                str(pg): ("ocr" if pg in ocr_page_set else "native")
                for pg in range(1, limit + 1)
                if page_text(pg).strip()
            }
            meta["text_origin_summary"] = {
                "native_pages": sum(1 for v in meta["text_origin_pages"].values() if v == "native"),
                "ocr_pages": sum(1 for v in meta["text_origin_pages"].values() if v == "ocr"),
            }

            if total_body_chars == 0:
                # ★ 这是**闸门**：正文为空时不该继续"看起来成功"地往下走。
                #   不抛 ParseError（解析本身没坏），而是**如实标注**，
                #   由上层（任务/抽取）据此拒绝进入 LLM 空转。
                meta["text_gate"] = "empty_body"
                meta["text_gate_reason"] = (
                    f"前 {meta['body_chars_sampled_pages']} 页正文均为空（text_mode={text_mode}，"
                    f"OCR {'可用' if ocr_result['meta'].get('available') else '不可用'}）"
                    f"→ 无法抽取；该资料需先提供文字层或可用的 OCR"
                )
                report(on_progress, 0.36, "⚠️ 正文为空：如实标注，不进入抽取")
            else:
                meta["text_gate"] = "ok"

            if toc:
                nodes, skip_meta, excluded = self._toc_nodes(
                    toc, total_pages, limit, page_text, on_progress
                )
                meta.update(skip_meta)
                # 被排除的非内容章（索引/术语表）**不当作"未编入目录"**再补回来
                nodes = self._add_uncovered(nodes, total_pages, limit, page_text, excluded)
                meta["synthetic_units"] = sum(1 for n in nodes if getattr(n, "_synthetic", False))
                covered_pages = self._coverage(nodes)
                meta["coverage_pages"] = covered_pages
                meta["excluded_pages"] = len(excluded)
                meta["content_pages"] = limit - len(excluded)
                # ⚠️ 夹到 ≤1：节点的 end 语义是"到下一个同级条目的前一页"，
                #    与被排除区间的边界页可能重叠 1 页 → 曾算出 1.0013 这种 >1 的值
                meta["coverage_rate"] = min(
                    1.0, round(covered_pages / max(1, limit - len(excluded)), 4)
                )
                mode = "toc"
            else:
                nodes = self._window_nodes(limit, page_text, on_progress)
                meta["coverage_pages"] = self._coverage(nodes)
                meta["synthetic_units"] = 0
                mode = "fixed_windows"
                report(on_progress, 0.6, f"无 TOC，按 {self.max_pages_per_unit} 页窗口切分")

            units = [
                UnitDraft(
                    ord=int(getattr(n, "_ord")),
                    title=n.title,
                    level=max(1, n.lvl),
                    span=Span("page", n.start, n.end),
                    text=n.text,
                    parent_ord=(int(getattr(n, "_parent_ord")) if getattr(n, "_parent_ord", None) is not None else None),
                )
                for n in nodes
            ]
            sample = "\n".join(n.title for n in nodes[:200])
            draft = DocDraft(
                title=(doc.metadata or {}).get("title") or p.stem,
                kind=self.kind,
                units=units,
                meta={**meta, "mode": mode, "depth": max((n.lvl for n in nodes), default=0)},
                page_count=total_pages,
                lang=guess_lang(sample + " " + (page_text(1) if limit else "")),
            )
            meta_conflict = self._check_text_cap(draft)
            draft.meta["text_capped_units"] = meta_conflict
            report(on_progress, 0.98, f"完成（{len(units)} 个单元）")
            return draft
        finally:
            doc.close()

    # ── TOC → 树 ────────────────────────────────────────────────────
    def _toc_nodes(
        self,
        toc: list,
        total_pages: int,
        limit: int,
        page_text,
        on_progress: ProgressFn | None,
    ) -> tuple[list[RawNode], dict, set[int]]:
        raw: list[RawNode] = []
        for i, entry in enumerate(toc):
            try:
                lvl, title, pg = int(entry[0]), str(entry[1]), int(entry[2])
            except (IndexError, TypeError, ValueError):
                continue
            pg = max(1, min(pg, total_pages))
            if pg > limit:
                # 超出本次解析窗口（COURSE_KB_PDF_MAX_PAGES）的条目直接不参与，
                # 否则它们的 start 会落在窗口外，把覆盖率算成 > 解析页数
                continue
            raw.append(
                RawNode(
                    i=len(raw),
                    lvl=max(1, lvl),
                    # PyMuPDF 的 TOC 标题含 \xa0（不换行空格），统一成普通空格
                    title=title.replace("\xa0", " ").strip(),
                    start=pg,
                )
            )

        # 计算 end：下一个 lvl <= 自己的条目（且页码更靠后）就是边界，否则到末页
        # 用 next.start - 1（不含）而不是 next.start：否则相邻小节在边界页重叠，
        # 覆盖率与"被排除页"会同时把该页算两遍（实测 coverage 11 / excluded 2 重叠）。
        for k, n in enumerate(raw):
            n.end = limit
            for j in range(k + 1, len(raw)):
                if raw[j].lvl <= n.lvl and raw[j].start > n.start:
                    n.end = min(limit, raw[j].start - 1)
                    break
            n.end = max(n.start, n.end)

        raw = build_parents(raw)

        # 非内容章：自身或**祖先**命中 → 整棵子树排除（坑 3）
        extra = extra_skip_patterns()
        def skipped(title: str) -> bool:
            t = normalize_title(title)
            return is_non_content(title) or any(pat.match(t) for pat in extra)

        drop: set[int] = set()
        for n in raw:
            anc: list[int | None] = []
            cur: RawNode | None = n
            while cur is not None:
                anc.append(cur.i)
                cur = raw[cur.parent] if cur.parent is not None else None
            if any(skipped(raw[a].title) for a in anc):
                drop.add(n.i)

        kept = [n for n in raw if n.i not in drop]
        for n in kept:
            n.children = [c for c in (n.children or []) if c not in drop]
            if n.parent is not None and n.parent in drop:
                n.parent = None
        # 被排除的页数：只数「被丢弃子树的根」（父的 end 已覆盖子孙）
        skipped_roots = [i for i in drop if raw[i].parent is None or raw[i].parent not in drop]
        skipped_pages = sum(raw[i].end - raw[i].start + 1 for i in skipped_roots)
        excluded: set[int] = set()
        excluded_ranges: list[list[int]] = []
        for i in skipped_roots:
            s, e = raw[i].start, min(raw[i].end, limit)
            excluded.update(range(s, e + 1))
            excluded_ranges.append([s, e])

        # ord 重排（1..N），parent 下标 → 新下标
        index_map = {n.i: k for k, n in enumerate(kept)}
        for k, n in enumerate(kept):
            n._ord = k + 1  # type: ignore[attr-defined]
            n._parent_ord = (index_map[n.parent] + 1) if n.parent in index_map else None  # type: ignore[attr-defined]
            n.text = self._node_text(n, page_text)

        # ⚠️ 坑 2：**不做**「把子节点 end 夹到父 end 内」的"修复"。
        #    TOC 里 3.4% 的父子对页码不嵌套（end 对同级失效），这是原始数据特性。
        #    夹住会造成真实丢页（夹掉的页既不在子节点也不在父节点），
        #    而覆盖率的正确算法是取并集（_coverage），不是假设嵌套成立。

        report(on_progress, 0.45, f"建树：保留 {len(kept)} / {len(raw)} 个 TOC 节点")
        return kept, {
            "toc_nodes": len(raw),
            "kept_nodes": len(kept),
            "skipped_nodes": len(drop),
            "skipped_pages": skipped_pages,
            "skipped_roots": [raw[i].title for i in skipped_roots][:20],
            # 供抽取管线扣除（避免把"主动排除的索引章"算成"漏页"）
            "excluded_ranges": excluded_ranges,
        }, excluded

    def _node_text(self, n: RawNode, page_text) -> str:
        """节点正文 = 前 ``max_pages_per_unit`` 页（大章只取引言段）。"""
        last = min(n.end, n.start + self.max_pages_per_unit - 1)
        parts = [page_text(pg) for pg in range(n.start, last + 1)]
        return clean_text("\n".join(parts))

    def _window_nodes(self, limit: int, page_text, on_progress: ProgressFn | None) -> list[RawNode]:
        """无 TOC 的降级：固定页窗（每窗 ≤ ``max_pages_per_unit`` 页）。"""
        nodes: list[RawNode] = []
        step = self.max_pages_per_unit
        k = 0
        for start in range(1, limit + 1, step):
            end = min(limit, start + step - 1)
            txt = clean_text("\n".join(page_text(pg) for pg in range(start, end + 1)))
            first_line = next((ln.strip() for ln in txt.split("\n") if ln.strip()), "")
            nodes.append(
                RawNode(
                    i=k,
                    lvl=1,
                    title=first_line[:70] or f"p.{start}–{end}",
                    start=start,
                    end=end,
                    text=txt,
                )
            )
            nodes[k]._ord = k + 1  # type: ignore[attr-defined]
            nodes[k]._parent_ord = None  # type: ignore[attr-defined]
            k += 1
            if k % 20 == 0:
                report(on_progress, 0.1 + 0.5 * end / max(1, limit), f"切分 p.{start}")
        return nodes

    def _add_uncovered(
        self,
        nodes: list[RawNode],
        total_pages: int,
        limit: int,
        page_text,
        excluded: set[int] | None = None,
    ) -> list[RawNode]:
        """补上 TOC 未覆盖的页（防"整片丢页"，与坑 5 同源的洁癖）。

        TOC 之外的页通常是封面/版权/插图页；**不静默丢**，生成一个 L1 合成单元。
        ``excluded`` 里的页属于**主动排除的非内容章**（索引/术语表），不补回来。
        """
        excluded = excluded or set()
        covered = set(excluded)
        for n in nodes:
            covered.update(range(n.start, min(n.end, limit) + 1))
        out = list(nodes)
        k = len(out)
        pg = 1
        while pg <= limit:
            if pg in covered:
                pg += 1
                continue
            start = pg
            while pg <= limit and pg not in covered:
                pg += 1
            end = pg - 1
            txt = clean_text(
                "\n".join(
                    page_text(p) for p in range(start, min(end, start + self.max_pages_per_unit - 1) + 1)
                )
            )
            node = RawNode(i=k, lvl=1, title=f"未编入目录 p.{start}–{end}", start=start, end=end, text=txt)
            node._ord = k + 1  # type: ignore[attr-defined]
            node._parent_ord = None  # type: ignore[attr-defined]
            node._synthetic = True  # type: ignore[attr-defined]
            out.append(node)
            k += 1
        return out

    @staticmethod
    def _coverage(nodes: list[RawNode]) -> int:
        pages: set[int] = set()
        for n in nodes:
            pages.update(range(n.start, n.end + 1))
        return len(pages)

    def _check_text_cap(self, draft: DocDraft) -> int:
        """统计被截断正文的 unit 数（如实告知：上层章只存了引言段）。"""
        n = 0
        for u in draft.units:
            if u.span.end - u.span.start + 1 > self.max_pages_per_unit:
                n += 1
        return n

    def probe(self, path: str) -> dict:
        try:
            import fitz

            d = fitz.open(str(path))
            try:
                return {"pages": d.page_count, "toc_entries": len(d.get_toc(simple=True) or [])}
            finally:
                d.close()
        except Exception:  # noqa: BLE001
            return {}


class PdfTextProvider:
    """按页码回源取正文（给 pipeline.units 用）。

    为什么需要它：adapter 只把每个 unit 的**前 8 页**存进库（避免 616 页的章
    撑爆一条记录），而"引言段本身 > 8 页"时抽取管线仍需完整文本 —— 那就回源读。
    页文本带缓存，一次解析只读每页一次。
    """

    def __init__(self, path: str):
        import fitz

        self._doc = fitz.open(str(path))
        self._cache: dict[int, str] = {}

    def text(self, span) -> str:
        if getattr(span, "kind", "") != "page":
            return ""
        parts: list[str] = []
        for pg in range(int(span.start), int(span.end) + 1):
            if pg not in self._cache:
                try:
                    self._cache[pg] = self._doc[pg - 1].get_text("text") or ""
                except Exception:  # noqa: BLE001
                    self._cache[pg] = ""
            parts.append(self._cache[pg])
        return clean_text("\n".join(parts))

    def close(self) -> None:
        try:
            self._doc.close()
        except Exception:  # noqa: BLE001
            pass

    def __enter__(self) -> "PdfTextProvider":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def text_provider_for(path: str):
    """按扩展名给一个回源取文本的 provider（只有 PDF 需要）。"""
    if Path(path).suffix.lower() == ".pdf":
        try:
            return PdfTextProvider(path)
        except Exception:  # noqa: BLE001
            return None
    return None
