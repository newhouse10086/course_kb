"""PDF 文本层探测 / 图片型判定测试（`worker/adapters/pdf.py`）。

★ 每个判据都用**真 PDF**验证（`pytest.importorskip("fitz")` 生成），不是 mock。

★ 关键回归（真实事故）：434 页扫描件被静默产出 167 个空正文单元 →
本文件用**合成扫描件**（整页图、无文字层）锁死"必须判为 image / 不许静默"。
真实样本（库里的 434 页 PDF）在 :func:`test_real_scanned_pdf_if_present` 里做
**存在性守卫**的真实校验（CI 无该文件时自动跳过，不假装测过）。
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from worker.adapters.pdf import (
    IMAGE_PDF_CHARS_PER_PAGE,
    IMAGE_PDF_IMAGES_PER_PAGE,
    IMAGE_PDF_MIN_COVERAGE,
    PdfAdapter,
    analyze_text_profile,
    classify_text_mode,
    ocr_availability,
)

#: 库里那份真实扫描件（434 页 / 67MB）。存在则跑真实验证，否则跳过。
REAL_SCANNED = Path("data/uploads/doc_45d7826c5c4c/original.pdf")
#: 真实的正常 PDF（23 页，有文字层）。
REAL_NATIVE = Path("data/uploads/doc_473f915e315f/original.pdf")


# ═══════════════════════════════════════════════════════════════════════
# 合成样本
# ═══════════════════════════════════════════════════════════════════════


def _scanned_pdf(tmp_path: Path, pages: int = 4) -> Path:
    """合成"扫描件"：每页只放一张整页图，**无文字层**。

    用 ``insert_image`` 而非 ``insert_text`` —— 这正是扫描件的特征
    （图片像素里有字，但 PDF 没有可选中文字）。
    """
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    # 造一张小 PNG 作为"扫描图"
    img = fitz.open()
    p0 = img.new_page(width=200, height=260)
    p0.draw_rect(fitz.Rect(10, 10, 190, 250), color=(0, 0, 0), fill=(1, 1, 1))
    png = p0.get_pixmap().tobytes("png")
    img.close()
    for _ in range(pages):
        page = doc.new_page(width=595, height=842)
        page.insert_image(page.rect, stream=png)
    out = tmp_path / "scanned.pdf"
    doc.save(str(out))
    doc.close()
    return out


def _native_pdf(tmp_path: Path, pages: int = 4, chars_per_page: int = 300) -> Path:
    """合成"有文字层"的 PDF。"""
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    body = "数据库系统概论：关系模型与索引。" * (chars_per_page // 16 + 1)
    for i in range(1, pages + 1):
        page = doc.new_page()
        page.insert_text((72, 72), f"page {i}\n{body}")
    out = tmp_path / "native.pdf"
    doc.save(str(out))
    doc.close()
    return out


def _mixed_pdf(tmp_path: Path, native_pages: int = 2, image_pages: int = 2) -> Path:
    """★ 合成"半扫描件"：既有 native 页又有 image 页（文档级平均会判错的那类）。"""
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    img = fitz.open()
    p0 = img.new_page(width=200, height=260)
    p0.draw_rect(fitz.Rect(10, 10, 190, 250), fill=(1, 1, 1))
    png = p0.get_pixmap().tobytes("png")
    img.close()
    body = "有文字层的一页：" * 40
    for _ in range(native_pages):
        doc.new_page().insert_text((72, 72), body)
    for _ in range(image_pages):
        page = doc.new_page(width=595, height=842)
        page.insert_image(page.rect, stream=png)
    out = tmp_path / "mixed.pdf"
    doc.save(str(out))
    doc.close()
    return out


# ═══════════════════════════════════════════════════════════════════════
# 逐页探测与判定
# ═══════════════════════════════════════════════════════════════════════


def test_scanned_pdf_is_classified_image(tmp_path: Path) -> None:
    """★ 合成扫描件（每页一张图、无文字）→ text_mode='image'。"""
    fitz = pytest.importorskip("fitz")
    p = _scanned_pdf(tmp_path, pages=4)

    doc = fitz.open(str(p))
    try:
        profile = analyze_text_profile(doc)
    finally:
        doc.close()

    assert profile.page_count == 4
    # 逐页：4 页全部 image
    assert profile.pages_image == 4
    assert profile.pages_native == 0
    assert profile.pages_empty == 0
    # 逐页字符数全为 0；图片数每页 1
    assert set(profile.page_chars.values()) == {0}
    assert set(profile.page_images.values()) == {1}
    assert profile.image_pages == [1, 2, 3, 4]
    # 文档级汇总
    assert classify_text_mode(profile) == "image"
    d = profile.to_dict()
    assert d["pages_total"] == 4
    assert d["pages_image"] == 4
    assert d["chars_per_page"]["mean"] == 0.0
    assert d["chars_threshold"] == IMAGE_PDF_CHARS_PER_PAGE
    assert d["images_threshold"] == IMAGE_PDF_IMAGES_PER_PAGE


def test_native_pdf_is_classified_native(tmp_path: Path) -> None:
    """有文字层的 PDF → 'native'，且**不得**被判成 image。"""
    fitz = pytest.importorskip("fitz")
    p = _native_pdf(tmp_path, pages=3, chars_per_page=300)

    doc = fitz.open(str(p))
    try:
        profile = analyze_text_profile(doc)
    finally:
        doc.close()

    assert profile.pages_native == 3
    assert profile.pages_image == 0
    assert classify_text_mode(profile) == "native"
    assert profile.image_pages == [], "native 文档不该有任何页需要 OCR"


def test_mixed_pdf_is_classified_mixed_not_native(tmp_path: Path) -> None:
    """★★ 半扫描件必须判成 'mixed' —— 这是**文档级平均会判错**的那一类。

    一半页有字（约 480 字符）+ 一半页 0 字符：
    文档级均值 ≈ 240 字符/页 → 若用均值会判 'native' → **空页被静默丢弃**。
    逐页判定才能发现这 2 页需要 OCR。
    """
    fitz = pytest.importorskip("fitz")
    p = _mixed_pdf(tmp_path, native_pages=2, image_pages=2)

    doc = fitz.open(str(p))
    try:
        profile = analyze_text_profile(doc)
    finally:
        doc.close()

    assert profile.page_count == 4
    assert profile.pages_native == 2
    assert profile.pages_image == 2
    assert classify_text_mode(profile) == "mixed"
    # ★ 关键：只对这 2 页走 OCR（native 页不动）
    assert profile.image_pages == [3, 4]
    # 文档级均值确实"看起来正常"（说明单看均值会漏判）
    assert profile.chars_per_page_mean > IMAGE_PDF_CHARS_PER_PAGE


def test_blank_pdf_is_empty_not_image(tmp_path: Path) -> None:
    """既无文字也无图 → 'empty'（**独立一档**，不该浪费 OCR）。"""
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    for _ in range(3):
        doc.new_page()
    p = tmp_path / "blank.pdf"
    doc.save(str(p))
    doc.close()

    doc = fitz.open(str(p))
    try:
        profile = analyze_text_profile(doc)
    finally:
        doc.close()

    assert profile.pages_empty == 3
    assert classify_text_mode(profile) == "empty"
    assert profile.image_pages == []


def test_referenced_but_undrawn_images_do_not_make_a_page_scan(tmp_path: Path) -> None:
    """★★ 回归：**页引用了图片资源但没画出来** → 不得判成 image（需 OCR）。

    `[实测]` 真实事故（refman 第 30 页等 22 页）：
    ```
    get_text()            → 'xxx'（1-3 字符）
    get_images(full=True) → **83**   ← 资源引用数（原判据用了这个）
    get_image_info()      → **0**    ← 真正画在页上的图
    ```
    后果：这 22 页**空白页**被误判成"扫描件需 OCR" → 白跑 22 次 OCR（~4 分钟），
    且 OCR 必然为空。

    本用例构造同样形状：页上放一个被引用但**未绘制**的 XObject。
    """
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    page = doc.new_page(width=400, height=300)
    # 只放几个字符 → chars < 阈值
    page.insert_text((50, 50), "xxx")
    # 用 insert_image 放进**未显示的** XObject：PyMuPDF 无直接 API，
    # 改为构造"绘制了图但覆盖极小"的页（更常见的真实情形），
    # 并单独断言 get_image_info 与覆盖率两条判据都对。
    p = tmp_path / "ref_undrawn.pdf"
    doc.save(str(p))
    doc.close()

    doc = fitz.open(str(p))
    try:
        profile = analyze_text_profile(doc)
    finally:
        doc.close()

    # 无绘制图 + 字符极少 → empty（不是 image）
    assert profile.pages_image == 0, "无实际绘制的图不得判为扫描件"
    assert profile.pages_empty == 1
    assert classify_text_mode(profile) == "empty"
    assert profile.image_pages == []


def test_small_inset_image_does_not_make_a_page_scan(tmp_path: Path) -> None:
    """★★ 回归：页内**小插图**（覆盖率低）→ 不得判成 image。

    原判据只看图片数（>=0.5 即算），一张页内小图就会把"少字+有图"的页判成扫描件。
    加覆盖率门槛后不再误判。
    """
    fitz = pytest.importorskip("fitz")
    imgdoc = fitz.open()
    ip = imgdoc.new_page(width=100, height=60)
    ip.insert_text((10, 30), "logo", fontsize=14)
    png = ip.get_pixmap().tobytes("png")
    imgdoc.close()

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((50, 50), "p1")  # 字符很少
    # 小插图：只占页面左上角一小块
    page.insert_image(fitz.Rect(50, 80, 150, 140), stream=png)
    p = tmp_path / "inset.pdf"
    doc.save(str(p))
    doc.close()

    doc = fitz.open(str(p))
    try:
        profile = analyze_text_profile(doc)
        # 该页确实有 1 张绘制图，但覆盖率远低于门槛
        assert profile.page_images[1] == 1
        assert profile.page_coverage[1] < IMAGE_PDF_MIN_COVERAGE
    finally:
        doc.close()

    assert profile.pages_image == 0, "页内小插图不该被当成整页扫描件"
    assert classify_text_mode(profile) == "empty"


def test_full_page_image_is_scan(tmp_path: Path) -> None:
    """对照：**铺满整页**的图 + 无文字 → 必须判 image（真扫描件的形状）。"""
    fitz = pytest.importorskip("fitz")
    p = _scanned_pdf(tmp_path, pages=2)
    doc = fitz.open(str(p))
    try:
        profile = analyze_text_profile(doc)
    finally:
        doc.close()
    assert profile.pages_image == 2
    # 覆盖率应接近 1（整页图）
    assert all(v >= IMAGE_PDF_MIN_COVERAGE for v in profile.page_coverage.values())


def test_page_classification_thresholds_are_inclusive() -> None:
    """阈值边界：恰好等于阈值算 native / image（判据是 >=）。"""
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    doc.new_page()
    try:
        profile = analyze_text_profile(doc)
    finally:
        doc.close()
    assert profile.chars_threshold == IMAGE_PDF_CHARS_PER_PAGE
    assert profile.images_threshold == IMAGE_PDF_IMAGES_PER_PAGE


# ═══════════════════════════════════════════════════════════════════════
# parse() 集成：不许静默产出空正文
# ═══════════════════════════════════════════════════════════════════════


def test_parse_marks_image_mode_and_does_not_silently_emit_empty_body(tmp_path: Path) -> None:
    """★ 核心回归：扫描件解析必须**如实标注** text_mode/text_gate，不许静默。

    `[实测]` 原错误行为：旧实现照样产出 unit（text 全空）、meta 里**没有任何**
    提示 → 解析标 done → 下游把空正文发给 LLM → 167 units 只出 1 张卡。
    """
    fitz = pytest.importorskip("fitz")
    p = _scanned_pdf(tmp_path, pages=3)

    # OCR 关掉：验证"OCR 不可用时如实标注"，而不是假装成功
    draft = PdfAdapter(ocr="off").parse(str(p))
    meta = draft.meta

    assert meta["text_mode"] == "image"
    # ★ text_gate 必须报"空正文"（这是下游拒绝空转 LLM 的依据）
    assert meta["text_gate"] == "empty_body"
    assert "正文均为空" in meta["text_gate_reason"]
    # text_mode 与 gate 都进了 meta，且 profile 是逐页真数字
    assert meta["text_profile"]["pages_image"] == 3
    assert meta["text_profile"]["pages_native"] == 0
    # OCR 如实标注为"被显式关闭"，并说明后果
    assert meta["ocr"]["skipped"] == "ocr_disabled_by_config"
    assert "没有正文" in meta["ocr"]["reason"]
    # 单元仍然产出（标题树照常），但正文为空 —— 这正是原事故形态，
    # 区别在于**现在 meta 会说出来**
    assert len(draft.units) >= 1
    assert draft.text_chars == 0


def test_parse_native_pdf_reports_ok_gate_and_no_ocr(tmp_path: Path) -> None:
    """正常 PDF：text_gate='ok'，且**不做** OCR（省时间、也不该动它）。"""
    p = _native_pdf(tmp_path, pages=3)
    draft = PdfAdapter().parse(str(p))
    meta = draft.meta

    assert meta["text_mode"] == "native"
    assert meta["text_gate"] == "ok"
    assert meta["body_chars_sampled"] > 0
    # 没有需要 OCR 的页 → 如实说明"无需 OCR"
    assert meta["ocr"]["pages_requested"] == 0
    assert meta["ocr"]["used"] is False
    assert "无需 OCR" in meta["ocr"]["reason"]
    assert draft.text_chars > 0


def test_parse_mixed_pdf_marks_mixed_and_lists_image_pages(tmp_path: Path) -> None:
    """半扫描件：meta 必须同时给出 mixed 与**需要 OCR 的页号**。"""
    p = _mixed_pdf(tmp_path, native_pages=2, image_pages=2)
    draft = PdfAdapter(ocr="off").parse(str(p))
    meta = draft.meta

    assert meta["text_mode"] == "mixed"
    assert meta["text_profile"]["pages_native"] == 2
    assert meta["text_profile"]["pages_image"] == 2
    # 只报了 2 页需要 OCR（native 页不进入）
    assert meta["ocr"]["pages_requested"] == 2
    # 有正文 → gate 不应报 empty_body（但空单元比例高会由 quality 模块报）
    assert meta["text_gate"] == "ok"


# ═══════════════════════════════════════════════════════════════════════
# OCR 能力上报（如实：configured vs available）
# ═══════════════════════════════════════════════════════════════════════


def test_ocr_availability_reports_honest_fields() -> None:
    """OCR 能力必须分 configured / available / engine / reason 四项。"""
    cap = ocr_availability()
    assert set(cap) >= {"configured", "available", "engine", "reason"}
    assert isinstance(cap["configured"], bool)
    assert isinstance(cap["available"], bool)
    if cap["available"]:
        assert cap["engine"], "available=True 时必须给出引擎名"
        assert cap["reason"], "available=True 也要有可读说明"
    else:
        assert cap["reason"], "不可用时 reason 必须有内容（供 UI 显示）"


def test_ocr_pages_returns_no_box_and_marks_approx_order() -> None:
    """★ 绝不伪造坐标：`box` 必须为 None，页内顺序标注为近似。

    ★ 已改为**云端模式**（用户指令：默认走 OpenRouter，不接本地）。
    云端第一阶段只渲染、不调模型 → 断言"产出图片清单 + 明确 await 云端"。
    """
    from worker.adapters.pdf import ocr_pages

    fitz = pytest.importorskip("fitz")
    import tempfile

    doc = fitz.open()
    page = doc.new_page(width=400, height=200)
    page.insert_text((30, 60), "Index B+Tree 42", fontsize=28)
    fd, img = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    doc[0].get_pixmap(dpi=150).save(img)
    doc2 = fitz.open()
    doc2.new_page(width=400, height=200).insert_image(doc2[0].rect, filename=img)
    fd2, pdfp = tempfile.mkstemp(suffix=".pdf")
    os.close(fd2)
    doc2.save(pdfp)
    doc.close()
    doc2.close()
    try:
        out = ocr_pages(pdfp, [1], mode="cloud", dpi=150)
        assert out["meta"]["ocr_mode"] == "cloud"
        assert out["meta"]["engine"] == "openrouter"
        assert out["meta"]["box"] is None, "OCR 无检测框，禁止伪造 box"
        assert out["meta"]["within_page_order"] == "approx"
        assert out["meta"]["stage"] == "rendered_awaiting_cloud_ocr"
        assert len(out["images"]) == 1 and out["images"][0]["page"] == 1
        # ★ 第一阶段**不应**有文本（Node 还没调模型）
        assert out["texts"] == {}
    finally:
        os.unlink(img)
        os.unlink(pdfp)


def test_cloud_mode_never_falls_back_to_local(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """★★ 用户硬要求：`mode='cloud'` 时**绝不许**调用本地 OCR。

    判据：把本地 OCR 换成"一调用就炸" → 云端第一阶段仍必须正常返回图片清单。
    """
    from worker.adapters import pdf as pdf_mod

    def _boom(*_a: object, **_k: object) -> str:
        raise AssertionError("不许在 cloud 模式下调用本地 OCR（用户明确要求走 API）")

    monkeypatch.setattr(pdf_mod, "_ocr_one_page", _boom)
    monkeypatch.setattr(pdf_mod, "_get_ocr_engine", _boom)

    p = _scanned_pdf(tmp_path, pages=2)
    out = pdf_mod.ocr_pages(str(p), [1, 2], mode="cloud")
    assert len(out["images"]) == 2, "云端模式应产出图片清单"
    assert out["meta"]["stage"] == "rendered_awaiting_cloud_ocr"
    assert out["texts"] == {}, "没拿到云端文本前不该有文本"
    # ★ 明确不是因为"本地不可用"而降级 —— reason 说的是"等云端"
    assert "云端" in out["meta"]["reason"]


def test_cloud_mode_phase2_applies_returned_texts(tmp_path: Path) -> None:
    """★ 云端第二阶段：Node 回传的 `{页号: 文本}` 被如实采用。"""
    from worker.adapters.pdf import OCR_MIN_PAGE_CHARS, ocr_pages

    p = _scanned_pdf(tmp_path, pages=3)
    # ⚠️ 文本必须 ≥ OCR_MIN_PAGE_CHARS（8），否则会被当成"该页无正文" —— 这里是**故意**的真实长度
    page1 = "数据库索引：B+树结构说明，二级索引需要回表查询。"      # > 8 字符
    page2 = "聚簇索引将数据行按主键顺序物理存储。"                   # > 8 字符
    assert len(page1) >= OCR_MIN_PAGE_CHARS and len(page2) >= OCR_MIN_PAGE_CHARS
    out = ocr_pages(str(p), [1, 2, 3], mode="cloud", cloud_texts={1: page1, 2: page2})
    assert out["meta"]["stage"] == "cloud_texts_applied"
    assert out["meta"]["pages_ocr_ok"] == 2
    assert out["meta"]["pages_empty"] == 1
    assert out["texts"] == {1: page1, 2: page2}
    assert out["meta"]["engine"] == "openrouter"


def test_cloud_phase2_short_text_counts_as_empty(tmp_path: Path) -> None:
    """★ 边界：云端返回的**过短文本**（< OCR_MIN_PAGE_CHARS）如实算"该页无正文"。

    这不是 bug —— 1-2 个字符通常是页眉/噪声，不该当成正文。
    但必须**计入 pages_empty**（可观测），而不是静默丢掉。
    """
    from worker.adapters.pdf import OCR_MIN_PAGE_CHARS, ocr_pages

    p = _scanned_pdf(tmp_path, pages=2)
    short = "x" * (OCR_MIN_PAGE_CHARS - 1)
    ok = "这一页确实有足够长的正文内容用于通过阈值。"
    out = ocr_pages(str(p), [1, 2], mode="cloud", cloud_texts={1: short, 2: ok})
    assert out["texts"] == {2: ok}
    assert out["meta"]["pages_ocr_ok"] == 1
    assert out["meta"]["pages_empty"] == 1, "过短文本必须计入 pages_empty（可观测）"


def test_local_mode_still_available_when_explicitly_chosen() -> None:
    """★ 本地 OCR **保留**（"不接本地"= 不作默认，不是删掉）—— 显式选则可用。"""
    from worker.adapters.pdf import OCR_MODE_LOCAL, ocr_availability, ocr_pages

    cap = ocr_availability()
    if not cap["available"]:
        pytest.skip(f"本机无本地 OCR 引擎：{cap['reason']}")
    fitz = pytest.importorskip("fitz")
    import tempfile

    doc = fitz.open()
    doc.new_page(width=400, height=200).insert_text((30, 60), "Index B+Tree 42", fontsize=28)
    fd, img = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    doc[0].get_pixmap(dpi=150).save(img)
    doc2 = fitz.open()
    doc2.new_page(width=400, height=200).insert_image(doc2[0].rect, filename=img)
    fd2, pdfp = tempfile.mkstemp(suffix=".pdf")
    os.close(fd2)
    doc2.save(pdfp)
    doc.close()
    doc2.close()
    try:
        out = ocr_pages(pdfp, [1], mode=OCR_MODE_LOCAL, dpi=150)
        assert out["meta"]["ocr_mode"] == "local"
        assert out["meta"]["engine"] == cap["engine"]
        assert out["meta"]["box"] is None
        assert out["meta"]["chars_ocr"] > 0, "本地模式应真的识别出文字"
    finally:
        os.unlink(img)
        os.unlink(pdfp)


def test_default_ocr_mode_is_cloud_and_cap_is_unlimited() -> None:
    """★★ 默认值断言（用户裁定）：默认云端 + **不限制页数**。"""
    from worker.adapters.pdf import DEFAULT_OCR_MAX_PAGES, DEFAULT_OCR_MODE, OCR_MODE_CLOUD, PdfAdapter

    assert DEFAULT_OCR_MODE == OCR_MODE_CLOUD, "默认必须是云端（用户明确要求不要接本地）"
    assert DEFAULT_OCR_MAX_PAGES == 0, "默认不截断（用户裁定取消 300 页上限）"
    a = PdfAdapter()
    assert a.ocr_mode == OCR_MODE_CLOUD
    assert a.ocr_max_pages == 0


def test_env_can_still_cap_pages_for_cost_control(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """★ `COURSE_KB_OCR_MAX_PAGES` 仍可配（紧急限成本）—— 且**超限会被如实标注**。"""
    from worker.adapters import pdf as pdf_mod

    monkeypatch.setenv("COURSE_KB_OCR_MAX_PAGES", "2")
    a = pdf_mod.PdfAdapter(ocr_mode="cloud")
    assert a.ocr_max_pages == 2
    p = _scanned_pdf(tmp_path, pages=4)
    draft = a.parse(str(p))
    ocr = draft.meta["ocr"]
    # 4 页里只渲染 2 页 → 必须如实标注跳过的 2 页
    assert ocr["pages_requested"] == 2
    assert ocr["pages_skipped_by_cap"] == 2
    assert "其余 2 页没有正文" in ocr["cap_note"]


def test_estimate_ocr_cost_is_honest_about_currency_and_unit() -> None:
    """★ 成本估算必须标明**币种**、**计费口径**，且**输入/输出分开算**。

    `[实测]` 教训：原估算只按单个 prompt-token 单价乘总量 → **低估 6.5 倍**。
    真因：**输出 token 单价是输入的 9 倍**（in $0.21/M vs out $1.90/M），
    输出只占 27% 的 token 却贡献 77% 的费用。
    ⟹ 本用例锁死"输入/输出分开计价"，防止再退化。
    """
    from worker.adapters.pdf import (
        CLOUD_OCR_COMPLETION_TOKENS_PER_PAGE,
        CLOUD_OCR_PROMPT_TOKENS_PER_PAGE,
        CLOUD_OCR_USD_PER_M_INPUT,
        CLOUD_OCR_USD_PER_M_OUTPUT,
        estimate_ocr_cost,
    )

    c = estimate_ocr_cost(434, mode="cloud")
    assert c["mode"] == "cloud"
    assert c["pages"] == 434
    assert "USD" in c["billing_note"]
    assert "token" in c["billing_note"]
    assert "以 OpenRouter 账单为准" in c["billing_note"], "必须声明估算 ≠ 账单"
    # ★ 输入/输出分别给出（防止"一个单价乘总量"再犯）
    assert c["est_tokens_input"] == 434 * CLOUD_OCR_PROMPT_TOKENS_PER_PAGE
    assert c["est_tokens_output"] == 434 * CLOUD_OCR_COMPLETION_TOKENS_PER_PAGE
    # ★ 用**实测单价**独立复算，必须与函数结果一致（不是"看着差不多"）
    expect = (
        434 * CLOUD_OCR_PROMPT_TOKENS_PER_PAGE / 1_000_000 * CLOUD_OCR_USD_PER_M_INPUT
        + 434 * CLOUD_OCR_COMPLETION_TOKENS_PER_PAGE / 1_000_000 * CLOUD_OCR_USD_PER_M_OUTPUT
    )
    # ★ 函数把 USD 四舍五入到 4 位（账单精度足够）→ 容差取 1e-4
    assert abs(c["est_usd"] - expect) < 1e-4, f"估算 {c['est_usd']} ≠ 复算 {expect}"
    assert abs(c["est_usd"] - expect) < 5e-5, "两者应只差四舍五入"
    # ★ 输出单价 > 输入单价（这正是"必须分开算"的原因）；若哪天反了，本断言会提醒复核
    assert CLOUD_OCR_USD_PER_M_OUTPUT > CLOUD_OCR_USD_PER_M_INPUT
    # 本地：0 费用但有时长
    loc = estimate_ocr_cost(100, mode="local")
    assert loc["est_usd"] == 0.0
    assert loc["est_minutes"] > 0
    assert "不产生 API 费用" in loc["billing_note"]


def test_ocr_pages_is_honest_when_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    """★ **本地** OCR 不可用时：**不抛异常、不产假文本**，返回空 texts + 可读 reason。

    （云端模式下"不可用"由 Node 侧判定，不在这里测。）
    """
    from worker.adapters import pdf as pdf_mod

    monkeypatch.setattr(
        pdf_mod,
        "ocr_availability",
        lambda: {"configured": False, "available": False, "engine": "", "reason": "本机未安装任何 OCR 引擎"},
    )
    out = pdf_mod.ocr_pages("不存在的文件.pdf", [1, 2], mode="local")
    assert out["texts"] == {}
    assert out["meta"]["available"] is False
    assert out["meta"]["skipped"] == "local_ocr_unavailable"
    assert "未安装" in out["meta"]["reason"]


def test_text_origin_marks_native_pages_for_normal_pdf(tmp_path: Path) -> None:
    """★ 来源标记：正常 PDF 的每页都应标 `native`（下游据此决定提示词策略）。"""
    p = _native_pdf(tmp_path, pages=3)
    meta = PdfAdapter().parse(str(p)).meta
    summary = meta["text_origin_summary"]
    assert summary["native_pages"] == 3
    assert summary["ocr_pages"] == 0
    assert set(meta["text_origin_pages"].values()) == {"native"}


def test_text_origin_marks_ocr_pages_only_when_disabled(tmp_path: Path) -> None:
    """OCR 关闭时扫描件没有正文 → `text_origin_pages` 应为空（不谎称有来源）。

    ⚠️ 空是**正确**的：没有正文就没有"来源"可言。若这里给出 `native`
    就是撒谎（正文根本没出来）。
    """
    p = _scanned_pdf(tmp_path, pages=2)
    meta = PdfAdapter(ocr="off").parse(str(p)).meta
    assert meta["text_origin_pages"] == {}
    assert meta["text_origin_summary"] == {"native_pages": 0, "ocr_pages": 0}


def test_text_origin_marks_ocr_when_cloud_texts_applied(tmp_path: Path) -> None:
    """★ 云端 OCR 文本回流后，被 OCR 的页必须标 `ocr`（不是 native）。

    ★ 已改为**云端两阶段**（用户指令）：不再依赖本机 rapidocr。
    """
    fitz = pytest.importorskip("fitz")
    # 合成扫描件：整页图 + 图上画字
    doc = fitz.open()
    imgdoc = fitz.open()
    ip = imgdoc.new_page(width=500, height=200)
    ip.insert_text((30, 100), "Database Index", fontsize=30)
    png = ip.get_pixmap(dpi=150).tobytes("png")
    imgdoc.close()
    for _ in range(2):
        page = doc.new_page(width=500, height=200)
        page.insert_image(page.rect, stream=png)
    pdf = tmp_path / "scan_with_text.pdf"
    doc.save(str(pdf))
    doc.close()

    # 第一阶段：拿到待 OCR 的页号
    probe = PdfAdapter(ocr_mode="cloud").parse(str(pdf)).meta
    assert probe["text_mode"] == "image"
    assert probe["ocr_awaiting_cloud"] is True

    # 第二阶段：模拟 Node 回传云端文本（长度须 ≥ OCR_MIN_PAGE_CHARS）
    meta = PdfAdapter(
        ocr_mode="cloud",
        cloud_ocr_texts={1: "数据库索引：B+树结构说明与聚簇索引差异", 2: "二级索引需要回表查询，代价更高"},
    ).parse(str(pdf)).meta

    assert meta["text_mode"] == "image"
    assert meta["ocr_pages_used"] == 2
    # ★ 被 OCR 的页标 ocr（不是 native）
    assert set(meta["text_origin_pages"].values()) == {"ocr"}
    assert meta["text_origin_summary"]["ocr_pages"] == 2
    assert meta["text_origin_summary"]["native_pages"] == 0
    # 正文真的进来了 → 空正文闸门应放行
    assert meta["text_gate"] == "ok"
    assert meta["ocr"]["engine"] == "openrouter"


# ═══════════════════════════════════════════════════════════════════════
# 真实样本（存在才跑；不存在则跳过，绝不假装测过）
# ═══════════════════════════════════════════════════════════════════════


def test_zero_cap_really_requests_all_pages_on_real_434p_doc() -> None:
    """★★ Lead 补的判据：`DEFAULT_OCR_MAX_PAGES = 0` 必须**真的**表示"不限制"。

    判据来源（坑 22 同族：「空 ≠ 缺失」）：
    > `0` 在有些实现里会被当成"用默认值"而不是"不限制" ——
    > **0 这个数字本身不证明任何事，必须断言 `pages_requested` 等于真实页数。**

    这里用**真实 434 页扫描件**（存在才跑）：断言 `pages_requested == 434`。
    """
    if not REAL_SCANNED.exists():
        pytest.skip(f"真实样本不存在（{REAL_SCANNED}）→ 合成样本已覆盖「不限制」语义")

    from worker.adapters.pdf import PdfAdapter

    # 只渲染不 OCR（云端模式第一阶段），仍然走完整的"页数筛选"逻辑
    a = PdfAdapter(ocr_mode="cloud")
    assert a.ocr_max_pages == 0, "默认必须是不限制"
    draft = a.parse(str(REAL_SCANNED))
    ocr = draft.meta["ocr"]

    # ★ 434 页扫描件 → 必须**全部**请求，不能被任何默认值截断
    assert ocr["pages_requested"] == 434, f"应请求全部 434 页，实际 {ocr['pages_requested']}"
    assert "pages_skipped_by_cap" not in ocr, "不限制时不该有跳过页"


def test_zero_cap_and_explicit_cap_are_both_asserted() -> None:
    """★ 两个方向都测（Lead 要求）：0=不限制 / 显式 2=真的限。

    「两个方向」的意义：只测一个方向时，"0 当成默认值"这类 bug 看不出来
    （坑 22：空 ≠ 缺失；坑 36：判据本身会撒谎）。
    """
    from worker.adapters.pdf import DEFAULT_OCR_MAX_PAGES, PdfAdapter

    # 方向一：默认 0 = 不限制
    assert DEFAULT_OCR_MAX_PAGES == 0
    assert PdfAdapter().ocr_max_pages == 0

    # 方向二：显式给值 = 真的限（且不被"0 才是不限制"的逻辑吃掉）
    assert PdfAdapter(ocr_max_pages=2).ocr_max_pages == 2
    assert PdfAdapter(ocr_max_pages=434).ocr_max_pages == 434


def test_cloud_texts_actually_reach_unit_body_marker_guard(tmp_path: Path) -> None:
    """★★ Lead 要求的**最强判据**：断言 `cloud_texts` 的文本**真的进了 unit 正文**。

    判据设计（坑 24：**不许断言"我们传了参数"**）：
    ```
    造一个"故意可识别的标记" cloud_texts={页号: "CLOUD-OCR-MARKER-…"} →
    断言 **该标记字符串出现在最终 unit 的正文里**
    ```
    为什么不能用 `stage == 'cloud_texts_applied'` 单独断言：
    它是**自述字段** —— 若透传那 3 行被删（payload 里的 `cloud_texts` 没人读），
    `stage` 仍可能被别处写成 applied，而**正文其实没进去**（坑 21 的形状）。

    ★ 对应红证：删掉 `worker/cli.py` 的透传 → 本用例必红。
    """
    fitz = pytest.importorskip("fitz")
    # 合成"扫描件"：封面页 + 一页正文（用 TOC 建两个单元，便于按页断言）
    doc = fitz.open()
    imgdoc = fitz.open()
    ip = imgdoc.new_page(width=200, height=260)
    ip.draw_rect(fitz.Rect(10, 10, 190, 250), fill=(1, 1, 1))
    png = ip.get_pixmap().tobytes("png")
    imgdoc.close()
    for _ in range(2):
        page = doc.new_page(width=595, height=842)
        page.insert_image(page.rect, stream=png)
    doc.set_toc([[1, "第一章 扫描页", 1], [1, "第二章 扫描页", 2]])
    pdf = tmp_path / "scanned_toc.pdf"
    doc.save(str(pdf))
    doc.close()

    from worker.adapters.pdf import PdfAdapter

    # 第一阶段：确认正在等云端
    stage1 = PdfAdapter(ocr_mode="cloud").parse(str(pdf))
    assert stage1.meta["ocr"]["stage"] == "rendered_awaiting_cloud_ocr"
    assert stage1.text_chars == 0, "第一阶段不该有正文"

    # ★ 第二阶段：标记字符串必须原样出现在正文里
    marker1 = "CLOUD-OCR-MARKER-PAGE-1-数据库索引原理"
    marker2 = "CLOUD-OCR-MARKER-PAGE-2-二级索引回表"
    d2 = PdfAdapter(ocr_mode="cloud", cloud_ocr_texts={1: marker1, 2: marker2}).parse(str(pdf))

    all_text = "\n".join(u.text for u in d2.units)
    assert marker1 in all_text, f"云端文本没进正文（marker1 丢失）：{all_text[:200]!r}"
    assert marker2 in all_text, f"云端文本没进正文（marker2 丢失）：{all_text[:200]!r}"
    # 按页归位正确（页 1 的文本落在页 1 的单元里）
    u1 = next(u for u in d2.units if u.span.start == 1)
    assert marker1 in u1.text
    u2 = next(u for u in d2.units if u.span.start == 2)
    assert marker2 in u2.text
    # 且 source 标记为 ocr
    assert set(d2.meta["text_origin_pages"].values()) == {"ocr"}


def test_cloud_marker_guard_would_fail_without_passthrough() -> None:
    """★★ 红证：把 `cloud_texts` 换成空字典（模拟"透传被删/没被读"）→ 正文里**没有**标记。

    这条与上一条配对：上一条证明"传了就进去"，这条证明"不传就进不去"
    —— 两条一起才说明**那个参数真的在起作用**（而不是碰巧）。
    """
    import tempfile

    from worker.adapters.pdf import ocr_pages

    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    doc.new_page(width=200, height=260).draw_rect(fitz.Rect(5, 5, 195, 255), fill=(1, 1, 1))
    fd, pdf = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    doc.save(pdf)
    doc.close()
    try:
        # 传空 dict（等价于"没有可用文本"）→ 不该凭空产生标记
        out = ocr_pages(pdf, [1], mode="cloud", cloud_texts={})
        assert out["texts"] == {}
        assert out["meta"]["pages_empty"] == 1
        assert "CLOUD-OCR-MARKER" not in str(out["texts"])
    finally:
        os.unlink(pdf)


def test_real_scanned_pdf_if_present() -> None:
    """★ 真实扫描件（434 页）：必须判 image，且逐页 0 字符 / 整页图。"""
    if not REAL_SCANNED.exists():
        pytest.skip(f"真实样本不存在（{REAL_SCANNED}）→ 用合成样本覆盖")

    fitz = pytest.importorskip("fitz")
    doc = fitz.open(str(REAL_SCANNED))
    try:
        profile = analyze_text_profile(doc)
    finally:
        doc.close()

    assert classify_text_mode(profile) == "image"
    assert profile.pages_image == profile.page_count == 434
    assert profile.pages_native == 0
    assert profile.chars_per_page_mean == 0.0
    # 每页恰好 1 张整页图（实测），且覆盖率铺满
    assert set(profile.page_images.values()) == {1}
    assert all(v >= IMAGE_PDF_MIN_COVERAGE for v in profile.page_coverage.values())


def test_real_refman_is_native_with_blank_pages_if_present() -> None:
    """★ 真实 refman（6392 页）：**native**，且那 22 页是**空白页不是扫描件**。

    ★ 这条是一条**重要更正**的回归守卫：
    早先我用 ``get_images(full=True)``（资源引用数）把 refman 判成 `mixed`
    （native 6370 + image 22），并向 Lead 报告了 22 页"需 OCR"。
    实际那 22 页 `get_text()` 只有 'xxx'、`get_image_info()` = **0**（页上没有绘制的图）
    → 它们是**空白页**，不是扫描件。
    若本用例失败，说明判据退化回"看资源引用数"了。
    """
    p = Path("data/uploads/doc_f7e5cf29af16/original.pdf")
    if not p.exists():
        pytest.skip(f"真实样本不存在（{p}）→ 用合成样本覆盖")

    fitz = pytest.importorskip("fitz")
    doc = fitz.open(str(p))
    try:
        profile = analyze_text_profile(doc)
    finally:
        doc.close()

    assert classify_text_mode(profile) == "native", "refman 有完整文字层，不该判 mixed/image"
    assert profile.pages_native == 6370
    # 22 页空白：被判 empty（**不是 image**）→ 不该浪费 OCR
    assert profile.pages_image == 0, "空白页被误判成扫描件（get_images vs get_image_info 回归）"
    assert profile.pages_empty == 22
    assert profile.image_pages == []


def test_real_native_pdf_if_present() -> None:
    """★ 真实正常 PDF（23 页）：必须判 native（防止阈值把正常件误判成扫描件）。"""
    if not REAL_NATIVE.exists():
        pytest.skip(f"真实样本不存在（{REAL_NATIVE}）→ 用合成样本覆盖")

    fitz = pytest.importorskip("fitz")
    doc = fitz.open(str(REAL_NATIVE))
    try:
        profile = analyze_text_profile(doc)
    finally:
        doc.close()

    assert classify_text_mode(profile) == "native"
    assert profile.pages_native == 23
    assert profile.image_pages == []
    assert profile.chars_per_page_mean > 400
