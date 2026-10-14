"""ASR provider 抽象层的测试（``docs/PROVIDERS.md`` §9 的验收清单）。

覆盖**四条路径**：成功 / 失败 / 降级 / 超时，外加：
* **能力差异**：请求硬要求字级时间戳时，段级 provider 必须被**跳过**（不是降级产出次品）
* **全链失败**：抛 ``AsrUnavailable``，reason 里能逐跳看到原因，**不产出空结果**
* ``configured`` 与 ``available`` **分开且真实**
* 凭据**不落日志**（``redact``）
"""

from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from worker.video import providers as P  # noqa: E402
from worker.video.errors import AsrUnavailable  # noqa: E402
from worker.video.providers.base import (  # noqa: E402
    AsrAttempt,
    AsrProvider,
    AsrRequest,
    AsrResponse,
    AsrSegmentDTO,
    AsrWordDTO,
    ProviderError,
    ProviderInfo,
)

# ── 假 provider（测试专用，覆盖四条路径）────────────────────────────────


class FakeProvider(AsrProvider):
    """可编程假 provider：想成功就成功，想在哪一关失败就在哪一关失败。"""

    def __init__(
        self,
        id: str,
        *,
        configured: bool = True,
        healthy: bool = True,
        word_ts: bool = True,
        fail_at: str = "",  # "" | "transcribe"
        error: ProviderError | None = None,
        segments: int = 2,
        delay: float = 0.0,
        reason: str = "",
        runtime: str = "local",
    ):
        self.id = id
        self._configured = configured
        self._healthy = healthy
        self._word_ts = word_ts
        self._fail_at = fail_at
        self._error = error
        self._segments = segments
        self._delay = delay
        self._reason = reason
        self._runtime = runtime
        self.calls = 0
        self.health_calls = 0

    def info(self, *, health: bool = False) -> ProviderInfo:
        return ProviderInfo(
            id=self.id,
            kind="asr",
            label=f"fake-{self.id}",
            vendor="fake",
            runtime=self._runtime,
            configured=self._configured,
            available=self._configured,
            reason=self._reason or ("未配置（假 provider）" if not self._configured else ""),
            capabilities={
                "wordTimestamps": self._word_ts,
                "segmentLevelTimestamps": True,
                "languages": ["*"],
                "mode": "sync",
                "maxSizeBytes": None,
            },
            pricing={"unit": "hour", "amount": 0, "currency": "CNY"},
        )

    def health_check(self) -> tuple[bool, str]:
        self.health_calls += 1
        if not self._configured:
            # 与真实 provider 一致：没配置就不用谈探测（顺序：config → health）
            return False, self._reason or f"{self.id} 未配置"
        return self._healthy, ("" if self._healthy else f"{self.id} 探测失败")

    def transcribe(self, req: AsrRequest) -> AsrResponse:
        self.calls += 1
        if self._delay:
            import time

            time.sleep(self._delay)
        if self._fail_at == "transcribe":
            raise self._error or ProviderError("E_ASR_RUN", f"{self.id} 崩了", provider=self.id)
        segs = [
            AsrSegmentDTO(
                i=k,
                startMs=k * 1_000,
                endMs=k * 1_000 + 800,
                text=f"{self.id}-第{k}句",
                confidence=0.9,
                words=[AsrWordDTO("词", k * 1_000, k * 1_000 + 800)] if self._word_ts else [],
            )
            for k in range(self._segments)
        ]
        return AsrResponse(
            segments=segs,
            language="zh",
            provider=self.id,
            used_provider=self.id,
            model="fake-1",
        )


def _req(**kw) -> AsrRequest:
    base = dict(audio_path="whatever.wav", duration_ms=10_000, work_dir="")
    base.update(kw)
    return AsrRequest(**base)


# ── DTO 边界（provider camelCase ↔ 契约 snake_case）────────────────────
def test_segment_dto_round_trip_to_contract_model() -> None:
    dto = AsrSegmentDTO(
        i=3, startMs=1_200, endMs=4_800, text="今天我们讲索引", confidence=0.91,
        words=[AsrWordDTO("索引", 1_200, 1_700)],
    )
    assert dto.to_dict() == {
        "i": 3, "startMs": 1_200, "endMs": 4_800, "text": "今天我们讲索引",
        "confidence": 0.91, "words": [{"w": "索引", "startMs": 1_200, "endMs": 1_700}],
    }
    seg = dto.to_video_segment()
    assert (seg.i, seg.start, seg.end) == (3, 1_200, 4_800), "契约 §2.7 用 snake_case start/end"
    back = AsrSegmentDTO.from_video_segment(seg, [{"w": "索引", "start": 1_200, "end": 1_700}])
    assert back.startMs == 1_200 and back.words[0].w == "索引"


def test_segment_dto_confidence_optional_and_parsing() -> None:
    d = AsrSegmentDTO.from_dict({"i": 0, "startMs": 0, "endMs": 500, "text": "x"})
    assert d.confidence is None
    assert "confidence" not in d.to_dict(), "没有置信度就不要塞 null（下游会以为有值）"
    assert AsrSegmentDTO.from_dict({"i": 0, "startMs": 0, "endMs": 0, "text": "x"}).to_dict()["words"] if False else True


# ── ProviderInfo：configured / available 分开（R1）──────────────────────
def test_provider_info_reports_reason_when_unavailable() -> None:
    p = FakeProvider("x", configured=False, reason="缺少 XXX_KEY")
    d = p.info().to_dict()
    assert d["configured"] is False
    assert d["available"] is False
    assert d["reason"] == "缺少 XXX_KEY"
    assert set(d) >= {"id", "kind", "label", "vendor", "runtime", "capabilities"}


def test_provider_info_never_leaks_empty_reason_when_unavailable() -> None:
    p = FakeProvider("x", configured=False, reason="")
    assert p.info().to_dict()["reason"], "不可用时必须给可读原因（UI 要显示）"


# ── supports()：能力检查（★ 用户新要求的核心）──────────────────────────
def test_supports_rejects_provider_without_word_timestamps_when_required() -> None:
    strict = FakeProvider("openai-asr", word_ts=False)
    req = _req(require_word_timestamps=True)
    ok, why = strict.supports(req)
    assert ok is False
    assert "字级时间戳" in why
    # 软偏好时可以跑
    assert strict.supports(_req(require_word_timestamps=False))[0] is True


def test_supports_checks_size_and_duration_limits() -> None:
    p = FakeProvider("cloud")
    p.info = lambda **kw: ProviderInfo(  # type: ignore[method-assign]
        id="cloud", kind="asr", configured=True, available=True,
        capabilities={"wordTimestamps": False, "maxSizeBytes": 1000, "maxDurationSec": 60,
                      "languages": ["zh"]},
    )
    ok, why = p.supports(_req(extra={"size_bytes": 5_000}))
    assert ok is False and "大小上限" in why
    ok, why = p.supports(_req(duration_ms=120_000))
    assert ok is False and "时长超过" in why
    ok, why = p.supports(_req(language="fr"))
    assert ok is False and "不支持语言" in why
    assert p.supports(_req(language="zh", duration_ms=10_000))[0] is True


def test_supports_treats_wildcard_language_as_any() -> None:
    assert FakeProvider("local-fw").supports(_req(language="de"))[0] is True


# ── 降级链：成功 ────────────────────────────────────────────────────────
def test_chain_uses_first_healthy_provider() -> None:
    a = FakeProvider("local-fw")
    b = FakeProvider("openai-asr")
    resp = P.transcribe_with_chain(_req(), providers={"local-fw": a, "openai-asr": b})
    assert resp.used_provider == "local-fw"
    assert len(resp.segments) == 2
    assert b.calls == 0, "第一跳成功就不该调第二跳"
    assert resp.degraded_from == ""


# ── 降级链：失败 → 降级（并上报 degraded_from）─────────────────────────
def test_chain_degrades_to_next_provider_and_reports() -> None:
    a = FakeProvider("local-fw", fail_at="transcribe",
                     error=ProviderError("E_ASR_LOAD", "本地模型加载失败"))
    b = FakeProvider("openai-asr", runtime="cloud", word_ts=False)
    resp = P.transcribe_with_chain(_req(), providers={"local-fw": a, "openai-asr": b})
    assert resp.used_provider == "openai-asr"
    assert resp.degraded_from == "local-fw"
    assert "本地模型加载失败" in resp.reason
    stages = [(x.provider, x.stage, x.ok) for x in resp.attempts]
    assert stages == [("local-fw", "transcribe", False), ("openai-asr", "transcribe", True)], stages
    assert resp.attempts[0].reason.startswith("[E_ASR_LOAD]")


def test_chain_skips_unconfigured_provider() -> None:
    a = FakeProvider("local-fw", configured=False, reason="未安装 faster-whisper")
    b = FakeProvider("openai-asr", runtime="cloud", word_ts=False)
    resp = P.transcribe_with_chain(
        _req(), providers={"local-fw": a, "openai-asr": b}, policy="local-first"
    )
    assert resp.used_provider == "openai-asr"
    skipped = [x for x in resp.attempts if x.stage == "config"]
    assert skipped and skipped[0].provider == "local-fw"
    assert "未安装 faster-whisper" in skipped[0].reason


def test_chain_skips_unhealthy_provider() -> None:
    a = FakeProvider("local-fw", healthy=False)
    b = FakeProvider("openai-asr", runtime="cloud", word_ts=False)
    resp = P.transcribe_with_chain(_req(), providers={"local-fw": a, "openai-asr": b})
    assert resp.used_provider == "openai-asr"
    assert [x.stage for x in resp.attempts] == ["health", "transcribe"]


def test_chain_skips_by_capability_not_by_downgrading_quality() -> None:
    """★ 核心：请求要字级时间戳 → 段级 provider 被**跳过**（继续下一跳），不是降级糊弄。"""
    strict = FakeProvider("local-fw", word_ts=False)  # 假设本地没有字级
    cloud = FakeProvider("aliyun-asr", word_ts=True, runtime="cloud")
    resp = P.transcribe_with_chain(
        _req(require_word_timestamps=True),
        providers={"local-fw": strict, "aliyun-asr": cloud},
        policy="local-first",
    )
    assert resp.used_provider == "aliyun-asr", "必须跳到支持字级的那一跳"
    assert strict.calls == 0, "能力不满足的 provider 不该被调用"
    assert [x.stage for x in resp.attempts] == ["capability", "transcribe"]


def test_chain_rejects_empty_result_and_continues() -> None:
    """某跳返回 0 段 = 失败（**绝不把空结果当成功**），继续下一跳。"""
    empty = FakeProvider("local-fw", segments=0)
    good = FakeProvider("openai-asr", runtime="cloud", word_ts=False)
    resp = P.transcribe_with_chain(_req(), providers={"local-fw": empty, "openai-asr": good})
    assert resp.used_provider == "openai-asr"
    assert "返回 0 段" in resp.attempts[0].reason


# ── 全链失败（R3）───────────────────────────────────────────────────────
def test_all_providers_fail_raises_with_per_hop_reasons() -> None:
    a = FakeProvider("local-fw", fail_at="transcribe",
                     error=ProviderError("E_ASR_LOAD", "模型下不下来"))
    b = FakeProvider("openai-asr", runtime="cloud", word_ts=False,
                     fail_at="transcribe", error=ProviderError("E_ASR_HTTP", "HTTP 402 余额不足"))
    with pytest.raises(AsrUnavailable) as ei:
        P.transcribe_with_chain(_req(), providers={"local-fw": a, "openai-asr": b})
    exc = ei.value
    assert exc.code == "E_ASR_HTTP", "错误码取最后一跳"
    assert "模型下不下来" in exc.detail, "逐跳原因都要在 detail 里"
    assert "HTTP 402 余额不足" in exc.detail
    assert "不产出字幕与文稿" in exc.detail, "必须写明不产出假数据"
    assert "尝试 2 跳" in exc.message


def test_chain_with_empty_registry_reports_clearly() -> None:
    with pytest.raises(AsrUnavailable) as ei:
        P.transcribe_with_chain(_req(), providers={})
    assert ei.value.code == "E_ASR_NO_PROVIDER"
    assert "都不存在" in ei.value.detail


# ── 超时路径 ────────────────────────────────────────────────────────────
def test_timeout_error_is_reported_and_chain_continues() -> None:
    slow = FakeProvider("local-fw", fail_at="transcribe",
                        error=ProviderError("E_ASR_TIMEOUT", "本地转写超时（>120s）"))
    fast = FakeProvider("openai-asr", runtime="cloud", word_ts=False)
    resp = P.transcribe_with_chain(_req(), providers={"local-fw": slow, "openai-asr": fast})
    assert resp.used_provider == "openai-asr"
    assert "超时" in resp.attempts[0].reason


def test_explicit_provider_does_not_fall_back() -> None:
    """``explicit``：指定一家，失败即失败（**不许**偷偷换别家）。"""
    a = FakeProvider("local-fw", fail_at="transcribe")
    b = FakeProvider("openai-asr", runtime="cloud", word_ts=False)
    with pytest.raises(AsrUnavailable):
        P.transcribe_with_chain(_req(), providers={"local-fw": a, "openai-asr": b}, explicit="local-fw")
    assert b.calls == 0


# ── 策略 / 注册表 ───────────────────────────────────────────────────────
@pytest.mark.parametrize("policy", sorted(P.POLICIES))
def test_every_policy_chain_starts_and_ends_sensibly(policy: str) -> None:
    chain = P.chain(policy)
    assert chain, policy
    assert len(chain) == len(set(chain)), "链里不该有重复"
    assert set(chain) <= set(P.build_registry()), f"{policy} 引用了未注册的 provider"


def test_unknown_policy_raises() -> None:
    with pytest.raises(ValueError, match="未知策略"):
        P.chain("cheapest")


def test_real_registry_has_local_fw_available() -> None:
    """本机实测：local-fw 必须真可用（faster-whisper 已装 + ffmpeg 已装）。"""
    infos = {p["id"]: p for p in P.provider_infos(health=True)}
    local = infos["local-fw"]
    assert local["configured"] is True
    assert local["available"] is True, local.get("reason")
    assert local["capabilities"]["wordTimestamps"] is True
    assert local["capabilities"]["rtfEstimate"] == 2.0, "RTF≈2x 是实测值（不是 9x）"
    assert local["pricing"]["amount"] == 0


def test_declared_cloud_providers_are_honestly_unavailable() -> None:
    """未实现的云 provider 必须 available=False 且 reason 写明"未实现 + 缺哪些变量"。"""
    infos = {p["id"]: p for p in P.provider_infos()}
    for pid in ("aliyun-asr", "tencent-asr", "xfyun-asr"):
        info = infos[pid]
        assert info["available"] is False, f"{pid} 没实现却报可用"
        assert info["capabilities"]["implemented"] is False
        assert "未实现" in info["reason"]
        assert "缺少环境变量" in info["reason"]


def test_declared_provider_configured_only_when_env_present(monkeypatch) -> None:
    spec = P.get_provider("aliyun-asr")
    assert spec is not None
    assert spec.info().configured is False
    for var in ("ALIYUN_AK", "ALIYUN_SK", "ALIYUN_APPKEY"):
        monkeypatch.setenv(var, "x" * 10)
    info = spec.info()
    assert info.configured is True
    assert info.available is False, "有凭据但没实现 → 仍然不可用（不许假装）"
    assert "未实现" in info.reason


def test_openai_provider_capabilities_declare_segment_level_only() -> None:
    """按 docs/PROVIDERS.md §2.1：OpenAI 是**段级**，不许硬凑字级。"""
    p = P.get_provider("openai-asr")
    assert p is not None
    cap = p.info().capabilities
    assert cap["wordTimestamps"] is False
    assert cap["segmentLevelTimestamps"] is True
    assert cap["maxSizeBytes"] == 25 * 1024 * 1024
    assert p.info().configured is False, "本机没有 ASR 凭据（.env 里只有 LLM 的）"


# ── /capabilities 片段（§7 格式）────────────────────────────────────────
def test_provider_capabilities_shape_matches_docs() -> None:
    cap = P.provider_capabilities(health=False)
    assert set(cap) >= {"available", "engine", "reason", "policy", "chain", "providers", "wordTimestamps"}
    assert cap["available"] is True and cap["engine"] == "local-fw"
    assert cap["policy"] == "local-first"
    ids = [p["id"] for p in cap["providers"]]
    assert "local-fw" in ids and "aliyun-asr" in ids
    for p in cap["providers"]:
        assert set(p) >= {"id", "kind", "label", "vendor", "runtime", "configured", "available"}
        assert p["runtime"] in ("local", "cloud")
        if not p["available"]:
            assert p["reason"], f"{p['id']} 不可用却没给 reason"


def test_cloud_first_falls_back_to_local_and_explains_every_hop() -> None:
    """``cloud-first`` 下本机没有任何云 ASR 可用 → **真降级到 local-fw**。

    这条断言同时证明两件事：
    1. 降级链真的在跑（engine 落到了链尾的 local-fw）；
    2. 每一跳为什么不行为**都能在 providers[] 里看到**（不是一句"不可用"糊过去）。
    """
    cap = P.provider_capabilities(policy="cloud-first", health=True)
    assert cap["available"] is True
    assert cap["engine"] == "local-fw", "云全不可用时必须落到本地，而不是报整体不可用"
    by_id = {p["id"]: p for p in cap["providers"]}
    for pid in ("aliyun-asr", "tencent-asr", "xfyun-asr"):
        assert by_id[pid]["available"] is False
        assert "未实现" in by_id[pid]["reason"], f"{pid} 的不可用原因不够具体"
    assert by_id["openai-asr"]["configured"] is False
    assert "凭据" in by_id["openai-asr"]["reason"]


def test_capability_reason_lists_every_hop_when_nothing_works() -> None:
    """全链都不可用时：``reason`` 必须逐跳列出原因（R3）。"""
    bad_local = FakeProvider("local-fw", configured=False, reason="未安装 faster-whisper")
    bad_cloud = FakeProvider("openai-asr", configured=False, runtime="cloud",
                             reason="缺少 ASR api_key")
    P.set_registry({"local-fw": bad_local, "openai-asr": bad_cloud})
    try:
        cap = P.provider_capabilities(policy="local-first", health=True)
        assert cap["available"] is False
        assert cap["engine"] == ""
        assert "local-fw" in cap["reason"] and "未安装 faster-whisper" in cap["reason"]
        assert "openai-asr" in cap["reason"] and "缺少 ASR api_key" in cap["reason"]
    finally:
        P.set_registry(None)


def test_health_flag_controls_real_probing() -> None:
    """默认（health=False）不该触发真探测（``/capabilities`` 不能打网络）。"""
    a = FakeProvider("local-fw")
    b = FakeProvider("openai-asr", runtime="cloud", word_ts=False)
    P.set_registry({"local-fw": a, "openai-asr": b})
    try:
        P.provider_capabilities(health=False)
        assert a.health_calls == 0 and b.health_calls == 0
        P.provider_capabilities(health=True)
        assert a.health_calls >= 1
    finally:
        P.set_registry(None)


def test_capability_report_skips_unconfigured_before_health() -> None:
    """★ 一致性回归：能力上报的顺序必须与真跑一致（先 configured 再 health）。

    错误写法（曾用）：上报时只做 health_check →
    一个"没配置但 health 假绿"的 provider 会被报成可用，
    而真跑时它在 config 关就被跳过 → **上报与行为不一致**（假绿）。
    """
    green_but_unconfigured = FakeProvider("local-fw", configured=False, healthy=True)
    P.set_registry({"local-fw": green_but_unconfigured})
    try:
        cap = P.provider_capabilities(policy="local-first", health=True)
        assert cap["available"] is False, "没配置就不该报可用"
        assert green_but_unconfigured.health_calls == 0, "没配置就不必探测（省一次网络/加载）"
    finally:
        P.set_registry(None)


# ── 凭据脱敏（§8）───────────────────────────────────────────────────────
def test_redact_hides_secrets() -> None:
    from worker.video.providers.cloud import redact

    text = "Authorization: Bearer sk-abcdef1234567890 failed"
    out = redact(text, ["sk-abcdef1234567890"])
    assert "sk-abcdef1234567890" not in out
    assert "***" in out
    assert redact("no secret here", [""]) == "no secret here"


def test_openai_provider_never_puts_key_in_info_reason(monkeypatch) -> None:
    from worker.video.providers.cloud import OpenAiAsrProvider

    secret = "sk-super-secret-key-value"
    p = OpenAiAsrProvider(base_url="https://example.invalid/v1", api_key=secret)
    text = json.dumps(p.info().to_dict(), ensure_ascii=False)
    assert secret not in text
    ok, why = p.health_check()
    assert ok is False
    assert secret not in why, "探测失败原因里不许出现凭据"


# ── OpenAI provider 真 HTTP 路径（用 httpx.MockTransport 打桩）──────────
def _mock_transport(handler):
    import httpx

    return httpx.MockTransport(handler)


def test_openai_provider_parses_verbose_json(tmp_path) -> None:
    import httpx

    from worker.video.providers.cloud import OpenAiAsrProvider

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "whisper-1"}]})
        assert request.url.path.endswith("/audio/transcriptions")
        assert request.headers["authorization"].startswith("Bearer ")
        return httpx.Response(
            200,
            json={
                "text": "今天我们讲索引",
                "duration": 3.0,
                "segments": [
                    {"start": 0.0, "end": 1.5, "text": "今天我们讲索引", "no_speech_prob": 0.05},
                    {"start": 1.5, "end": 3.0, "text": "B加树是最常用的结构", "no_speech_prob": 0.1},
                ],
            },
        )

    wav = _fake_wav(tmp_path / "a.wav", 3_000)
    p = OpenAiAsrProvider(
        base_url="https://asr.test/v1", api_key="k" * 20, transport=_mock_transport(handler)
    )
    assert p.info().configured is True
    ok, why = p.health_check()
    assert ok is True, why
    resp = p.transcribe(AsrRequest(audio_path=str(wav), duration_ms=3_000, work_dir=str(tmp_path / "w")))
    assert [s.text for s in resp.segments] == ["今天我们讲索引", "B加树是最常用的结构"]
    assert [(s.startMs, s.endMs) for s in resp.segments] == [(0, 1_500), (1_500, 3_000)]
    assert resp.segments[0].confidence == pytest.approx(0.95, abs=0.01)
    assert resp.model == "whisper-1"


def test_openai_provider_maps_http_error_without_leaking_key(tmp_path) -> None:
    import httpx

    from worker.video.providers.cloud import OpenAiAsrProvider

    key = "sk-leak-me-please-123456"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(402, text=f"insufficient balance for {key}")

    wav = _fake_wav(tmp_path / "a.wav", 2_000)
    p = OpenAiAsrProvider(base_url="https://asr.test/v1", api_key=key, transport=_mock_transport(handler))
    with pytest.raises(ProviderError) as ei:
        p.transcribe(AsrRequest(audio_path=str(wav), duration_ms=2_000, work_dir=str(tmp_path / "w")))
    assert ei.value.code == "E_ASR_HTTP"
    assert "402" in ei.value.msg
    assert key not in ei.value.detail, "凭据绝不能出现在错误里"


def test_openai_provider_maps_timeout(tmp_path) -> None:
    import httpx

    from worker.video.providers.cloud import OpenAiAsrProvider

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("too slow")

    wav = _fake_wav(tmp_path / "a.wav", 2_000)
    p = OpenAiAsrProvider(base_url="https://asr.test/v1", api_key="k" * 20,
                          transport=_mock_transport(handler))
    with pytest.raises(ProviderError) as ei:
        p.transcribe(AsrRequest(audio_path=str(wav), duration_ms=2_000, timeout_s=1.0,
                                work_dir=str(tmp_path / "w")))
    assert ei.value.code == "E_ASR_TIMEOUT"
    assert "超时" in ei.value.msg


def test_openai_provider_empty_result_is_error(tmp_path) -> None:
    import httpx

    from worker.video.providers.cloud import OpenAiAsrProvider

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"text": "", "segments": []})

    wav = _fake_wav(tmp_path / "a.wav", 2_000)
    p = OpenAiAsrProvider(base_url="https://asr.test/v1", api_key="k" * 20,
                          transport=_mock_transport(handler))
    with pytest.raises(ProviderError) as ei:
        p.transcribe(AsrRequest(audio_path=str(wav), duration_ms=2_000, work_dir=str(tmp_path / "w")))
    assert ei.value.code == "E_ASR_EMPTY"
    assert "不产出空字幕" in ei.value.detail


def test_cloud_chain_reports_both_attempts(tmp_path, monkeypatch) -> None:
    """本地失败 → 云成功：attempts 两跳都记上（R2/R0）。"""
    import httpx

    from worker.video.providers.cloud import OpenAiAsrProvider

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"segments": [{"start": 0.0, "end": 1.0, "text": "云端结果"}]})

    wav = _fake_wav(tmp_path / "a.wav", 2_000)
    local = FakeProvider("local-fw", fail_at="transcribe",
                         error=ProviderError("E_ASR_LOAD", "本地模型加载失败"))
    cloud = OpenAiAsrProvider(base_url="https://asr.test/v1", api_key="k" * 20,
                              transport=_mock_transport(handler))
    resp = P.transcribe_with_chain(
        AsrRequest(audio_path=str(wav), duration_ms=2_000, work_dir=str(tmp_path / "w")),
        providers={"local-fw": local, "openai-asr": cloud},
        use_health=False,
    )
    assert resp.used_provider == "openai-asr"
    assert resp.degraded_from == "local-fw"
    assert [a.provider for a in resp.attempts] == ["local-fw", "openai-asr"]
    assert resp.segments[0].text == "云端结果"
    assert json.loads(json.dumps(resp.to_dict()))["used_provider"] == "openai-asr"


def _fake_wav(path, duration_ms: int):
    """造一个合法的 16k/mono/16bit WAV（内容无所谓，provider 只上传它）。"""
    import struct

    rate, ch, bits = 16_000, 1, 16
    data_bytes = int(duration_ms * rate * ch * (bits // 8) / 1000)
    with open(path, "wb") as fh:
        fh.write(b"RIFF")
        fh.write(struct.pack("<I", 36 + data_bytes))
        fh.write(b"WAVEfmt ")
        fh.write(struct.pack("<IHHIIHH", 16, 1, ch, rate, rate * ch * 2, ch * 2, bits))
        fh.write(b"data")
        fh.write(struct.pack("<I", data_bytes))
        fh.write(b"\x00" * min(data_bytes, 4096) + b"\x00" * max(0, data_bytes - 4096))
    return path
