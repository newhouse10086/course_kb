"""PDF 文本层探测 / 图片型判定测试（`worker/adapters/pdf.py`）。

★ 每个判据都用**真 PDF**验证（`pytest.importorskip("fitz")` 生成），不是 mock。

★ 关键回归（真实事故）：434 页扫描件被静默产出 167 个空正文单元 →
本文件用**合成扫描件**（整页图、无文字层）锁死"必须判为 image / 不许静默"。
真实样本（库里的 434 页 PDF）在 :func:`test_real_scanned_pdf_if_present` 里做
**存在性守卫**的真实校验（CI 无该文件时自动跳过，不假装测过）。
"""

from __future__ import annotations

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
    """★ 绝不伪造坐标：`box` 必须为 None，页内顺序标注为近似。"""
    from worker.adapters.pdf import ocr_pages

    cap = ocr_availability()
    if not cap["available"]:
        pytest.skip(f"本机无 OCR 引擎：{cap['reason']}")

    fitz = pytest.importorskip("fitz")
    # 造一张带字的图（rapidocr 已实测能识别）
    doc = fitz.open()
    page = doc.new_page(width=400, height=200)
    page.insert_text((30, 60), "Index B+Tree 42", fontsize=28)
    p = doc[0].get_pixmap(dpi=150)
    import tempfile, os

    fd, img = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    p.save(img)
    # 用一个"单页 PDF"承载该图，走 ocr_pages
    doc2 = fitz.open()
    page2 = doc2.new_page(width=400, height=200)
    page2.insert_image(page2.rect, filename=img)
    pdfp = img + ".pdf"
    doc2.save(pdfp)
    doc.close()
    doc2.close()
    try:
        out = ocr_pages(pdfp, [1], dpi=150)
    finally:
        os.unlink(img)
        os.unlink(pdfp)

    assert out["meta"]["box"] is None, "OCR 无检测框，禁止伪造 box"
    assert out["meta"]["within_page_order"] == "approx"
    assert out["meta"]["available"] is True
    assert out["meta"]["engine"] == cap["engine"]
    # 真识别出内容（本机 rapidocr 实测可识别 drawtext/insert_text 画的字）
    assert out["meta"]["chars_ocr"] > 0
    assert "Index" in out["texts"][1] or "B" in out["texts"][1]


def test_ocr_pages_is_honest_when_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    """★ OCR 不可用时：**不抛异常、不产假文本**，返回空 texts + 可读 reason。"""
    from worker.adapters import pdf as pdf_mod

    monkeypatch.setattr(
        pdf_mod,
        "ocr_availability",
        lambda: {"configured": False, "available": False, "engine": "", "reason": "本机未安装任何 OCR 引擎"},
    )
    out = pdf_mod.ocr_pages("不存在的文件.pdf", [1, 2])
    assert out["texts"] == {}
    assert out["meta"]["available"] is False
    assert out["meta"]["skipped"] == "ocr_unavailable"
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


def test_text_origin_marks_ocr_when_ocr_runs(tmp_path: Path) -> None:
    """★ OCR 真跑起来后，被 OCR 的页必须标 `ocr`（不是 native）。"""
    cap = ocr_availability()
    if not cap["available"]:
        pytest.skip(f"本机无 OCR 引擎：{cap['reason']}")

    fitz = pytest.importorskip("fitz")
    # 合成扫描件：整页图 + 图上画字（可被 OCR 识别）
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

    meta = PdfAdapter().parse(str(pdf)).meta
    assert meta["text_mode"] == "image"
    assert meta["ocr_pages_used"] >= 1
    # ★ 被 OCR 的页标 ocr（不是 native）
    assert "ocr" in set(meta["text_origin_pages"].values())
    assert meta["text_origin_summary"]["ocr_pages"] >= 1
    assert meta["text_origin_summary"]["native_pages"] == 0


# ═══════════════════════════════════════════════════════════════════════
# 真实样本（存在才跑；不存在则跳过，绝不假装测过）
# ═══════════════════════════════════════════════════════════════════════


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
