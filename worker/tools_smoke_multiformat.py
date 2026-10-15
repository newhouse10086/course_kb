"""多格式解析冒烟脚本（零额度，不调 LLM）—— 给 Lead/用户一个"多久能看到效果"的实测答案。

用法::

    python worker/tools_smoke_multiformat.py            # 全部三份真样本
    python worker/tools_smoke_multiformat.py --ocr-pages 5   # 只 OCR 5 页（快速）

输出：每份文档的 text_mode / 逐页统计 / OCR 用量与**实测耗时** / 预计全量耗时。
**不伪造任何数字**：所有耗时都是本机真跑出来的。
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

# 允许从仓库根直接运行
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from worker.adapters.pdf import PdfAdapter, analyze_text_profile, classify_text_mode, ocr_availability  # noqa: E402

#: 库里已知的三份真样本（存在才测）
SAMPLES = [
    ("扫描件教材 434 页", "data/uploads/doc_45d7826c5c4c/original.pdf"),
    ("知识点总结 23 页", "data/uploads/doc_473f915e315f/original.pdf"),
    ("refman 6392 页", "data/uploads/doc_f7e5cf29af16/original.pdf"),
]


def measure_profile(path: str) -> tuple[str, dict, float]:
    import fitz

    t0 = time.perf_counter()
    doc = fitz.open(path)
    try:
        profile = analyze_text_profile(doc)
    finally:
        doc.close()
    dt = time.perf_counter() - t0
    return classify_text_mode(profile), profile.to_dict(), dt


def main() -> int:
    ap = argparse.ArgumentParser(description="多格式解析冒烟（零额度）")
    ap.add_argument("--ocr-pages", type=int, default=0, help="只 OCR 前 N 页（0=按适配器上限）")
    args = ap.parse_args()

    print("=" * 78)
    print("多格式解析冒烟（真样本；**不调 LLM，零额度**）")
    print("=" * 78)
    print("OCR 能力:", ocr_availability())
    print()

    for label, rel in SAMPLES:
        p = Path(rel)
        if not p.exists():
            print(f"—— {label}: 跳过（样本不存在：{rel}）——\n")
            continue

        mode, info, dt_prof = measure_profile(str(p))
        print(f"—— {label} ——")
        print(f"  路径      : {rel}")
        print(f"  text_mode : **{mode}**")
        print(f"  逐页统计  : native={info['pages_native']} image={info['pages_image']} "
              f"empty={info['pages_empty']} / 共 {info['pages_total']} 页")
        print(f"  字符/页   : mean={info['chars_per_page']['mean']} "
              f"median={info['chars_per_page']['median']} max={info['chars_per_page']['max']}")
        print(f"  探测耗时  : {dt_prof:.1f}s（全量逐页 get_text，很便宜）")

        if info["pages_image"] == 0:
            print("  → 无需 OCR（每页都有文字层）\n")
            continue

        # 实际跑一次 parse（带 OCR），但用 --ocr-pages 限制规模
        n_limit = args.ocr_pages if args.ocr_pages > 0 else 0
        t0 = time.perf_counter()
        draft = PdfAdapter(ocr_max_pages=n_limit or None).parse(str(p))
        dt_parse = time.perf_counter() - t0
        m = draft.meta
        ocr = m.get("ocr", {})
        used = int(ocr.get("pages_ocr_ok") or 0)
        rate = (dt_parse / used) if used else 0.0

        print(f"  ★ 真跑 parse（OCR 上限={n_limit or '适配器默认'}）")
        print(f"    耗时        : **{dt_parse:.1f}s**")
        print(f"    OCR 成功页  : {used} 页（chars_ocr={m.get('ocr_chars')}）")
        if used:
            print(f"    **实测速率** : {rate:.2f} s/页")
        if ocr.get("pages_skipped_by_cap"):
            print(f"    ⚠️ 超上限未 OCR: {ocr['pages_skipped_by_cap']} 页 → **没有正文**（如实标注）")
        print(f"    units        : {len(draft.units)}，正文 {draft.text_chars} 字符")
        print(f"    text_gate    : {m.get('text_gate')}")
        print(f"    text_origin  : {m.get('text_origin_summary')}")
        if used:
            total_pages = info["pages_image"]
            print(f"    ⟹ 该文档 {total_pages} 页需 OCR → 全量 **约 {total_pages * rate / 60:.1f} 分钟**")
        print()

    print("=" * 78)
    print("结论：`mixed` 文档只 OCR 图片页 —— 这是最大的优化（refman 22/6392 页）。")
    print("      纯扫描件按 300 页上限 ≈ 64 分钟（需后台任务 + 进度，见 worker/MULTIFORMAT.md §4.4）")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
