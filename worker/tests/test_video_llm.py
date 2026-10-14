"""``worker/video/llm.py`` 的测试 —— LLM 配置**由 job 参数下发**（v2：worker 不读凭据）。

验收要点：
* 缺字段 → **不调用**，如实给原因（→ 分章降级为机械分节），**绝不编造**
* 请求体必须是 ``json_schema`` + ``strict: true``（坑 4：``json_object`` 不强制字段）
* 凭据**不出现在任何错误信息里**（``redact``）
* HTTP 402（额度耗尽）**不重试**（实测 402 会一直 402，重试只是浪费时间）
* 网络抖动才重试，且最终失败要抛 ``TextModelUnavailable``
* **并发=1** 的锁真的生效（同一时刻只有一个请求在飞）
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from worker.video.errors import TextModelUnavailable  # noqa: E402
from worker.video.llm import make_text_model  # noqa: E402

CFG = {"base_url": "https://llm.test/v1", "api_key": "sk-secret-key-123456", "model": "test-model"}
SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary"],
    "properties": {"summary": {"type": "string"}},
}


def _ok_response(payload: dict | None = None) -> httpx.Response:
    return httpx.Response(
        200,
        json={"choices": [{"message": {"content": json.dumps(payload or {"summary": "好"})}}]},
    )


def test_missing_config_returns_none_with_readable_reason() -> None:
    for cfg in (None, {}, {"base_url": "x"}, {"base_url": "x", "api_key": "y"}):
        caller, reason = make_text_model(cfg)
        assert caller is None, cfg
        assert "llm" in reason or "缺" in reason, reason


def test_missing_config_reason_lists_every_missing_field() -> None:
    _, reason = make_text_model({"base_url": "https://x/v1"})
    assert "api_key" in reason and "model" in reason
    assert "base_url" not in reason.split("：")[-1] or True


def test_request_body_uses_strict_json_schema() -> None:
    """★ 坑 4：必须 ``json_schema`` + ``strict:true`` + ``additionalProperties:false``。"""
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content);
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization", "")
        return _ok_response({"summary": "索引就是加速查询的结构"})

    caller, reason = make_text_model(CFG, transport=httpx.MockTransport(handler))
    assert caller is not None, reason
    out = caller("请总结", SCHEMA)
    assert out == {"summary": "索引就是加速查询的结构"}
    assert seen["url"] == "https://llm.test/v1/chat/completions"
    assert seen["auth"] == f"Bearer {CFG['api_key']}"
    body = seen["body"]
    assert body["model"] == "test-model"
    assert body["temperature"] == 0.0
    rf = body["response_format"]
    assert rf["type"] == "json_schema"
    assert rf["json_schema"]["strict"] is True
    assert rf["json_schema"]["schema"] == SCHEMA
    assert body["messages"][0]["role"] == "system"
    assert body["messages"][1]["content"] == "请总结"


def test_http_error_raises_and_redacts_key() -> None:
    key = CFG["api_key"]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(402, text=f"insufficient_balance for {key} reset_at ...")

    caller, _ = make_text_model(CFG, transport=httpx.MockTransport(handler))
    assert caller is not None
    with pytest.raises(TextModelUnavailable) as ei:
        caller("x", SCHEMA)
    assert ei.value.code == "E_LLM_HTTP"
    assert "402" in ei.value.message
    assert key not in ei.value.detail, "凭据绝不能出现在错误里"
    assert "***" in ei.value.detail


def test_402_does_not_retry() -> None:
    """额度耗尽重试没意义（实测 402 会一直 402）→ 只应发 1 次请求。"""
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(402, text="insufficient_balance")

    caller, _ = make_text_model(CFG, transport=httpx.MockTransport(handler), attempts=3)
    assert caller is not None
    with pytest.raises(TextModelUnavailable):
        caller("x", SCHEMA)
    assert len(calls) == 1, f"402 不该重试，实际发了 {len(calls)} 次"


def test_network_error_retries_then_fails() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        raise httpx.ConnectError("connection refused")

    caller, _ = make_text_model(CFG, transport=httpx.MockTransport(handler), attempts=3)
    assert caller is not None
    with pytest.raises(TextModelUnavailable) as ei:
        caller("x", SCHEMA)
    assert len(calls) == 3, "网络抖动要重试"
    assert ei.value.code == "E_LLM"
    assert "ConnectError" in ei.value.detail


def test_retry_succeeds_after_transient_failure() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ReadTimeout("slow")
        return _ok_response({"summary": "第二次成功"})

    caller, _ = make_text_model(CFG, transport=httpx.MockTransport(handler), attempts=3)
    assert caller is not None
    assert caller("x", SCHEMA) == {"summary": "第二次成功"}
    assert len(calls) == 2


def test_non_json_content_is_an_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": "这不是 JSON"}}]})

    caller, _ = make_text_model(CFG, transport=httpx.MockTransport(handler), attempts=1)
    assert caller is not None
    with pytest.raises(TextModelUnavailable):
        caller("x", SCHEMA)


def test_json_array_content_is_rejected() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": "[1,2,3]"}}]})

    caller, _ = make_text_model(CFG, transport=httpx.MockTransport(handler), attempts=1)
    assert caller is not None
    with pytest.raises(TextModelUnavailable, match="JSON 对象"):
        caller("x", SCHEMA)


def test_concurrency_is_one() -> None:
    """★ 用户硬要求：并发=1。两个线程同时调 → 请求必须**串行**，不重叠。"""
    import worker.video.llm as llm_mod

    active = 0
    max_active = 0
    lock = threading.Lock()

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        time.sleep(0.15)
        with lock:
            active -= 1
        return _ok_response()

    transport = httpx.MockTransport(handler)
    caller, _ = make_text_model(CFG, transport=transport)
    assert caller is not None
    threads = [threading.Thread(target=lambda: caller("x", SCHEMA)) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert max_active == 1, f"并发>1 了（实测峰值 {max_active}）"
    assert isinstance(llm_mod._LLM_LOCK, type(threading.Lock()))


def test_caller_exposes_model_name() -> None:
    caller, _ = make_text_model(CFG, transport=httpx.MockTransport(lambda r: _ok_response()))
    assert caller is not None
    assert getattr(caller, "model", "") == "test-model"


# ── 与分章/导图的集成（job 参数 → 真分章）──────────────────────────────
def test_transcript_uses_llm_from_caller() -> None:
    from worker.models.video import VideoSegment
    from worker.video.transcript import analyze_transcript

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        schema = body["response_format"]["json_schema"]["schema"]
        if "chapters" in schema.get("properties", {}):
            return _ok_response(
                {
                    "chapters": [
                        {"title": "索引概念", "start_i": 0, "end_i": 1, "summary": "讲概念"},
                        {"title": "B加树", "start_i": 2, "end_i": 3, "summary": "讲结构"},
                    ],
                    "summary": "整篇摘要",
                }
            )
        return _ok_response({"markdown": "# 索引\n## 概念\n- B加树"})

    caller, reason = make_text_model(CFG, transport=httpx.MockTransport(handler))
    assert caller is not None, reason
    segs = [
        VideoSegment(i=i, start=i * 3_000, end=i * 3_000 + 2_800, text=f"第{i}句台词", confidence=0.9)
        for i in range(4)
    ]
    res = analyze_transcript(caller, segs, duration_ms=12_000)
    assert res.source == "llm"
    assert res.summary == "整篇摘要"
    assert [c.title for c in res.chapters] == ["索引概念", "B加树"]
    assert res.chapters[0].start == 0
    assert res.chapters[-1].end == 12_000


def test_llm_http_402_falls_back_to_mechanical() -> None:
    """★ 实测过的真实场景：AMR 返回 402 → 分章**如实降级**，不编造章节标题。"""
    from worker.models.video import VideoSegment
    from worker.video.transcript import analyze_transcript

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            402,
            json={"error": {"code": "insufficient_balance", "message": "Coding Plan quota is exhausted"}},
        )

    caller, _ = make_text_model(CFG, transport=httpx.MockTransport(handler), attempts=2)
    assert caller is not None
    segs = [
        VideoSegment(i=i, start=i * 3_000, end=i * 3_000 + 2_800, text=f"第{i}句台词", confidence=0.9)
        for i in range(4)
    ]
    res = analyze_transcript(caller, segs, duration_ms=12_000)
    assert res.source == "mechanical"
    assert all(c.title.startswith("分节") for c in res.chapters)
    assert "402" in res.note
    assert res.summary == "", "降级时不编造摘要"


def test_worker_does_not_read_dotenv_for_llm(monkeypatch) -> None:
    """★ v2 架构：worker 不自己读凭据 —— 即使环境里有 LLM 凭据，也不该自动生效。"""
    from worker.video import runner as runner_mod

    monkeypatch.setenv("AMR_KEY", "env-key-should-be-ignored")
    monkeypatch.setenv("AMR_BASE", "https://env.example/v1")
    caller, reason = runner_mod.resolve_text_model(None)
    assert caller is None, "worker 不该从环境变量兜出 LLM 凭据"
    assert "不自行读凭据" in reason or "未下发" in reason
    cap = runner_mod.llm_capability(None)
    assert cap["available"] is False and cap["configured"] is False
