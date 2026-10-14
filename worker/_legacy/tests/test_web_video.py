"""video.html（视频课堂）headless Chrome 断言。

验收对应（F6）：
  · 字幕与视频同步（点字幕 → currentTime）
  · 文稿分章可折叠 + 全文总结
  · 思维导图可折叠（markmap 兼容 Markdown）
  · 幻灯片帧点击跳转（并如实标注"图片帧"，坑 11）
  · 虚拟滚动（3000 条字幕只渲染可视窗口）
  · ASR/ffmpeg 不可用 → 入口禁用 + 说明原因（坑 10，绝不假装可用）
运行：python -m pytest tests/test_web_video.py -q
"""

from __future__ import annotations

import json
import re

import pytest

from test_web_common import (
    WEB, dump_dom, jsonscript, tag_attrs, count, has, strip_tags, text_of, class_of, element_json,
    DOC_VIDEO,
    # 夹具复用（不能新增 conftest.py：写域限定 tests/test_web_*.py）
    web_server, degraded_server, meta,
)


def video_url(srv, selftest=True, simclock=True, t=0):
    q = [f"doc={DOC_VIDEO}", "selftest=1" if selftest else "", "simclock=1" if simclock else "",
         f"t={t}"]
    return f"{srv.base}/video.html?" + "&".join(x for x in q if x)


# ---------------------------------------------------------------- 静态结构

def test_video_shell_structure():
    html = (WEB / "video.html").read_text(encoding="utf-8")
    for needle in ['id="v-player"', 'id="v-subs"', 'id="v-transcript"', 'id="v-mindmap"',
                   'id="v-slides"', 'id="btn-reparse"', 'id="btn-slides"', 'id="asr-note"',
                   'id="v-seeklog"', 'assets/video-page.js']:
        assert needle in html, f"video.html 缺少 {needle}"
    assert not re.search(r'(src|href)="https?://', html), "video.html 引用了外部资源"
    body = strip_tags(html)
    assert "虚拟滚动" in body, "字幕区应说明使用虚拟滚动"


def test_virtual_scroll_is_handwritten():
    """F6：vue-virtual-scroller → 原生虚拟滚动（无构建链、零依赖）。"""
    vs = (WEB / "assets" / "vscroll.js").read_text(encoding="utf-8")
    assert "class VirtualList" in vs and "spacer" in vs and "overscan" in vs
    assert "import " not in vs, "vscroll 必须零依赖（不引任何库）"
    mm = (WEB / "assets" / "mindmap.js").read_text(encoding="utf-8")
    assert "parseMindmap" in mm and "markmap" in mm and "collapseAll" in mm
    assert "import " in mm and mm.count("from './util.js'") == 1, "mindmap 只允许依赖本地 util"


def test_capability_gates_declared():
    src = (WEB / "assets" / "video-page.js").read_text(encoding="utf-8")
    assert re.search(r"qs\('#btn-reparse'\)", src), "找不到重跑字幕入口"
    assert re.search(r"applyGate\(btn,\s*asr\.ok", src), "重跑字幕入口没有走 ASR 能力门控"
    assert re.search(r"applyGate\(qs\('#btn-slides'\),\s*ff\.ok", src), "抽帧入口没有走 ffmpeg 门控"
    api = (WEB / "assets" / "api.js").read_text(encoding="utf-8")
    assert "asr.available === true" in api and "pi.available === true" in api


# ---------------------------------------------------------------- 正常能力：实跑

@pytest.fixture(scope="module")
def dom(web_server):
    return dump_dom(video_url(web_server, simclock=True), virtual_time_budget=30000)


def test_video_report_counts(dom, meta):
    r = jsonscript(dom, "video-report")
    assert r, "缺少 #video-report"
    assert r["ok"] is True
    assert r["doc"] == DOC_VIDEO
    assert r["segments"] == meta["video"]["segments"] == 3000
    assert r["transcript"] == meta["video"]["chapters"] == 8
    assert r["slides"] == meta["video"]["slides"] == 12
    assert r["mindmap"] is True
    assert r["asr_available"] is True
    assert r["ffmpeg_available"] is True
    a = tag_attrs(dom, "v-meta")
    assert a["data-segments"] == "3000" and a["data-transcript"] == "8" and a["data-slides"] == "12"


def test_duration_and_chapters(dom):
    assert text_of(dom, "v-duration") == "01:00:00"
    assert count(dom, r'class="chapter[ "]') == 8, "文稿应分 8 章"
    assert count(dom, r'class="ch-goto"') == 8, "每章都要能定位到视频时间点"
    body = strip_tags(dom)
    assert "全文总结" in body


def test_mindmap_renders_collapsible_tree(dom):
    assert count(dom, r'class="mm-node') >= 10, "思维导图节点过少"
    assert count(dom, r'class="mm-toggle"') >= 5
    assert count(dom, r'class="mm-seek"') >= 5, "带时间锚的导图行应能给跳转按钮"
    assert 'data-pane="mindmap"' in dom


def test_slides_frames_clickable(dom):
    assert count(dom, r'class="slide-card') == 12
    assert count(dom, r'class="slide-card[^"]*" data-slide="\d+" data-at="\d+"') == 12
    body = strip_tags(dom)
    assert "图片帧" in body, "坑 11：必须说明这只是图片帧，不是可编辑 PPT"
    assert "不是可编辑 PPT" in body
    imgs = re.findall(r'<img src="([^"]+)"', dom)
    assert len(imgs) == 12 and all("/api/v1/" in u for u in imgs), imgs[:3]


def test_asr_available_so_no_gate(dom):
    assert tag_attrs(dom, "btn-reparse").get("disabled") is None, "ASR 可用时不该禁用重跑按钮"
    assert "hidden" in class_of(dom, "asr-note"), "ASR 可用时不该显示不可用提示"
    assert "hidden" in class_of(dom, "ffmpeg-note")


def test_reparse_submits_task_and_streams_progress(dom):
    """「生成字幕/重跑」不能是个摆设：要真提交任务并订阅 SSE 进度（契约 §6）。"""
    c = jsonscript(dom, "selftest-report")["checks"]
    assert c["reparse_gated"] is False, "ASR 可用时不该被门控"
    assert c["reparse_task_id"], f"没有提交任务：{c['reparse_status_text']}"
    assert c["reparse_progress"] == "42", f"SSE 进度帧没解析出来：{c['reparse_progress']}"
    assert c["reparse_ok"] is True, f"提交后的状态不对：{c}"
    assert c["reparse_done"] == "true", f"SSE done 帧没处理：{c['reparse_status_text']}"
    assert "tsk_" in text_of(dom, "v-task") and "完成" in text_of(dom, "v-task")


def test_selftest_all_green(dom, meta):
    r = jsonscript(dom, "selftest-report")
    assert r, "缺少 #selftest-report"
    c = r["checks"]
    assert r["ok"] is True, f"视频页自检未通过：{json.dumps(c, ensure_ascii=False)[:1200]}"
    assert c["subtitle_click_ok"] is True
    assert c["sync_ok"] is True, f"字幕不同步：{c.get('sync_active_index')} != {c.get('sync_target_index')}"
    assert c["chapter_toggle_ok"] is True
    assert c["mindmap_toggle_ok"] is True
    assert c["vscroll_ok"] is True


def test_subtitle_sync_values(dom):
    """字幕同步：时钟放到第 3 条（index=2）中间 → 高亮必须是它。"""
    c = jsonscript(dom, "selftest-report")["checks"]
    assert c["sync_target_index"] == 2
    assert c["sync_active_index"] == 2
    assert c["sync_active_dom"] is True, "可视窗口里的 .sub-row.active 不是那一条"
    # 夹具每条 1200ms，第 3 条 start=2400ms → 时钟落在 00:02 附近
    assert c["sync_target_start"] == 2400
    assert re.match(r"^00:0[0-9]", c["clock_text"]), c["clock_text"]


def test_subtitle_click_seeks_video(dom):
    c = jsonscript(dom, "selftest-report")["checks"]
    assert c["subtitle_click_ok"] is True
    assert c["subtitle_click_last"] == c["subtitle_click_start"], \
        f"点字幕后的 seek 目标不对：{c['subtitle_click_last']} vs {c['subtitle_click_start']}"
    log = element_json(dom, "v-seeklog")
    assert log, "#v-seeklog 没有记录 seek"
    kinds = [e["how"] for e in log]
    assert "subtitle" in kinds and "slide" in kinds and "mindmap" in kinds, kinds


def test_slide_and_mindmap_seek(dom):
    c = jsonscript(dom, "selftest-report")["checks"]
    assert c["slide_click_ok"] is True, "点幻灯片帧没有跳到对应时间"
    assert c["slide_hl"] is True
    assert c["mindmap_seek_ok"] in (True, None)


def test_virtual_scroll_windowed(dom, meta):
    """3000 条字幕：DOM 里只应有可视窗口的行（虚拟滚动生效）。"""
    c = jsonscript(dom, "selftest-report")["checks"]
    vs = c["vscroll"]
    assert vs["total"] == 3000
    assert 0 < vs["dom_rows"] < 200, f"没做虚拟滚动：DOM 里有 {vs['dom_rows']} 行"
    assert vs["spacer_height"] == 3000 * 42, f"占位高度不对：{vs['spacer_height']}"
    assert c["sub_virtual"] is True
    shift = c["vscroll_window_shift"]
    assert shift["after_first"] > shift["before_first"], "滚动后窗口没有移动"


# ---------------------------------------------------------------- 真媒体：字幕跳转 → video.currentTime

@pytest.fixture(scope="module")
def dom_media(web_server):
    """不用合成时钟：夹具用真实可解码媒体（静音 WAV）走 <video> 的真实跳转路径。"""
    return dump_dom(video_url(web_server, selftest=True, simclock=False, t=2400),
                    virtual_time_budget=30000)


def test_real_media_seek_sync(dom_media):
    """点字幕/幻灯片 → video.currentTime 真的被接受（不是只改了内部变量）。"""
    assert "duration=60000ms" in text_of(dom_media, "v-media-check") \
        or "ok=true" in text_of(dom_media, "v-media-check"), \
        f"媒体没有加载：{text_of(dom_media, 'v-media-check')}"
    c = jsonscript(dom_media, "selftest-report")["checks"]
    mc = c["media_check"]
    assert mc["available"] is True, "媒体元数据不可用"
    assert mc["duration_ms"] == 60000, f"媒体时长不对：{mc}"
    assert mc["media_ms"] is not None, "没有任何 seek 被媒体接受（video.currentTime 没变）"
    assert abs(mc["media_ms"] - min(mc["want_ms"], mc["duration_ms"] - 50)) <= 600, \
        f"媒体时间与目标差太多：{mc}"
    assert c["media_seek_ok"] is True
    assert "ok=true" in text_of(dom_media, "v-media-check")
    log = element_json(dom_media, "v-seeklog")
    assert [e["how"] for e in log][:2] == ["url", "selftest-clock"]
    assert log[0]["ms"] == 2400 and log[0]["media_ms"] == 2400


def test_simclock_mode_is_documented(dom):
    """合成时钟只用于无头验证，页面上必须写明它不影响真实播放路径。"""
    body = strip_tags(dom)
    assert "合成时钟" in body
    assert "无头环境" in body or "无媒体" in body
    assert "simclock" in body


# ---------------------------------------------------------------- 降级：ASR/ffmpeg 不可用

@pytest.fixture(scope="module")
def dom_degraded(degraded_server):
    return dump_dom(video_url(degraded_server, simclock=True), virtual_time_budget=25000)


def test_degraded_reparse_disabled_with_reason(dom_degraded):
    """坑 10：ASR 不可用 → 禁用入口 + 说明原因（不是点了才报错）。"""
    attrs = tag_attrs(dom_degraded, "btn-reparse")
    assert attrs.get("disabled") is not None, "ASR 不可用时重跑按钮必须 disabled"
    assert attrs.get("aria-disabled") == "true"
    reason = attrs.get("data-gate-reason", "")
    assert "faster-whisper" in reason, f"没有说明不可用的原因：{reason}"
    assert "不可用：" in dom_degraded, "缺少可见的说明文字（.gate-note）"
    body = strip_tags(dom_degraded)
    assert "ASR 不可用" in body
    assert "禁用" in body
    # 点了也不能假装提交成功
    r = jsonscript(dom_degraded, "selftest-report")
    assert r["checks"]["reparse_gated"] is True
    assert r["checks"]["reparse_task_id"] == ""
    assert "已禁用" in r["checks"]["reparse_status_text"]


def test_degraded_ffmpeg_gate(dom_degraded):
    attrs = tag_attrs(dom_degraded, "btn-slides")
    assert attrs.get("disabled") is not None, "ffmpeg 不可用时抽帧按钮必须 disabled"
    assert "ffmpeg not found" in attrs.get("data-gate-reason", "")
    assert "ffmpeg 不可用" in strip_tags(dom_degraded)


def test_degraded_no_fabricated_content(dom_degraded):
    """绝不假装成功：没有产物就如实说没有，且不留空白。"""
    r = jsonscript(dom_degraded, "video-report")
    assert r["ok"] is True
    assert r["segments"] == 0 and r["asr_available"] is False
    body = strip_tags(dom_degraded)
    assert "没有字幕" in body and "不生成假字幕" in body
    assert "后端未产出全文总结" in body or "后端未产出" in body
    assert "后端未产出思维导图" in body
    assert "抽取幻灯片帧" in body
    assert count(dom_degraded, r'class="sub-row"') == 0


def test_degraded_still_has_player_and_manual_paths(dom_degraded):
    """降级后仍可用：播放器 + 手动上传字幕的说明（F6 坑 10 的"仍可产出"清单）。"""
    assert 'id="v-player"' in dom_degraded
    body = strip_tags(dom_degraded)
    assert "手动上传字幕" in body
    assert count(dom_degraded, r'class="cap-chip off"') >= 2, "降级芯片要标红"
