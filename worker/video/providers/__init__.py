# -*- coding: utf-8 -*-
"""worker.video.providers —— **provider 注册表 / 策略 / 降级链**（``docs/PROVIDERS.md`` §4/§7/§9）。

.. warning::

   **事故说明（2026-10-15）**：本文件曾被误删 —— 清理临时文件时用了通配符 ``_*.py``，
   它**匹配到了 ``__init__.py``**；且 ``.gitignore`` 里有同样的 ``_*.py``，
   所以本文件**从未被 git 跟踪 → 无法从历史恢复**。

   **已穷尽找副本，确认没有**：git dangling blob（12 个全查）、``__pycache__``
   （只剩重建后 stub 的 .pyc）、回收站、临时目录。
   → 本文件是**事故后按测试重建**（``worker/tests/test_video_providers.py`` 605 行为唯一规格），
   **可能与原实现存在行为差异**；下表逐条标注了重建依据。
   ``.gitignore`` 已由 Lead 修好（``_*.py`` → ``_scratch_*.py``）。

   教训：① ``.gitignore`` 绝不要写 ``_*.py``（会匹配 ``__init__.py``）；
   ② 包标记/再导出文件必须入库，否则 clone 后 worker 直接坏掉；
   ③ 清理临时文件按**具体路径**删，不要按通配符删。

## 本模块负责四件事

1. **策略 → 降级链**（:data:`POLICIES` / :func:`chain`）：先试谁、再试谁
2. **注册表**（:func:`build_registry` / :func:`set_registry` / :func:`get_provider`）
3. **能力上报**（:func:`provider_infos` / :func:`provider_capabilities`）：``/capabilities`` 的 ``asr`` 段
4. **降级链执行**（:func:`transcribe_with_chain`）：每跳**真探测**，全链失败**如实报错**

## 三条铁律（PROVIDERS §0）

* **R1** ``configured``（凭据齐备）与 ``available``（**真探测**通过）**分开报**
* **R2** 降级链**每一跳都真探测**（``health_check()``）—— 只看配置会给**假绿**
* **R3** 全链失败 → 抛 :class:`AsrUnavailable`（**逐跳原因**）+ **绝不产出空字幕或编造文稿**

## 重建依据（每条语义都对应一个测试）

=================================  ==========================================================
语义                                 测试
=================================  ==========================================================
链顺序 / 无重复 / 只用已注册           ``test_every_policy_chain_starts_and_ends_sensibly``
未知策略 → ``ValueError``              ``test_unknown_policy_raises``
真实注册表里 ``local-fw`` 可用          ``test_real_registry_has_local_fw_available``
声明式云 provider 如实不可用            ``test_declared_cloud_providers_are_honestly_unavailable``
``get_provider`` 惰性读环境变量         ``test_declared_provider_configured_only_when_env_present``
能力上报**先 configured 再 health**      ``test_capability_report_skips_unconfigured_before_health``
``cloud-first`` 真降级到本地            ``test_cloud_first_falls_back_to_local_and_explains_every_hop``
全链不可用 → 逐跳原因                  ``test_capability_reason_lists_every_hop_when_nothing_works``
``health=False`` 不触发真探测           ``test_health_flag_controls_real_probing``
第一跳成功不调第二跳                   ``test_chain_uses_first_healthy_provider``
失败 → 降级并上报 ``degraded_from``      ``test_chain_degrades_to_next_provider_and_reports``
``config`` / ``health`` 关跳过          ``test_chain_skips_unconfigured_provider`` /
                                       ``test_chain_skips_unhealthy_provider``
能力不满足 → **跳过**（不产次品）        ``test_chain_skips_by_capability_not_by_downgrading_quality``
0 段 = 失败（不当成功）                ``test_chain_rejects_empty_result_and_continues``
全链失败 → 逐跳原因 + 不产假数据          ``test_all_providers_fail_raises_with_per_hop_reasons``
空注册表 → ``E_ASR_NO_PROVIDER``        ``test_chain_with_empty_registry_reports_clearly``
``explicit`` **不降级**                ``test_explicit_provider_does_not_fall_back``
=================================  ==========================================================
"""

from __future__ import annotations

import time
from typing import Any

from ..errors import AsrUnavailable
from .base import (
    AsrAttempt,
    AsrProvider,
    AsrRequest,
    AsrResponse,
    KINDS,
    ProviderError,
    ProviderInfo,
)
from .cloud import (
    CLOUD_CHUNK_MS,
    CLOUD_SPECS,
    DeclaredAsrProvider,
    OPENAI_MAX_BYTES,
    OpenAiAsrProvider,
    build_declared_providers,
    redact,
)
from .inline import (
    InlineTranscribeProvider,
)
from .local_fw import (
    LocalFasterWhisperProvider,
)

# ── 策略表（重建依据：test_every_policy_chain_starts_and_ends_sensibly 等）─────
#
# 口径：
# * 链成员**只能**是注册表里存在的 id（测试断言 ``set(chain) <= set(build_registry())``）
# * 顺序即语义：`cloud-first` **必须以 local-fw 收尾**，否则"云全不可用"时会报整体不可用，
#   而不是真降级到本地（``test_cloud_first_falls_back_to_local_and_explains_every_hop``）
POLICIES: dict[str, tuple[str, ...]] = {
    # 默认：本机零成本且已验证，失败再去云端
    "local-first": ("local-fw", "aliyun-asr", "openai-asr"),
    # 云端优先（质量/多语种），但**本地兜底必须在链尾**
    "cloud-first": ("aliyun-asr", "tencent-asr", "xfyun-asr", "openai-asr", "local-fw"),
    # 省钱：免费的本地在最前，付费云在后
    "cost": ("local-fw", "openai-asr", "aliyun-asr", "tencent-asr", "xfyun-asr"),
    # 质量优先：字级 + 中文强项在前（阿里云 > OpenAI > 本地）
    "quality": ("aliyun-asr", "openai-asr", "local-fw"),
}

#: 默认策略（与 Node 侧 ``config/providers.yaml`` 的 ``asr: local-first`` 对齐）
DEFAULT_POLICY = "local-first"


# ═══════════════════════════════════════════════════════════════════════
# 注册表
# ═══════════════════════════════════════════════════════════════════════

#: 注册表顺序（决定 ``providers[]`` 的展示顺序）
#
# ⚠️ **顺序是被测试钉住的**：``test_video_job.py::test_caps_job_matches_providers_doc_shape``
# 断言 ``["local-fw", "openai-asr", "aliyun-asr", "tencent-asr", "xfyun-asr"]`` ——
# 即"本地 → OpenAI 兼容（真实实现）→ 三家声明式云"。别按字母序"顺手整理"。
_REGISTRY_ORDER: tuple[str, ...] = (
    "local-fw",
    "openai-asr",
    "aliyun-asr",
    "tencent-asr",
    "xfyun-asr",
)


def build_registry() -> dict[str, AsrProvider]:
    """构造**真实**注册表：本地 faster-whisper + 3 家声明式云 + OpenAI 兼容。

    重建依据：``test_real_registry_has_local_fw_available``（本机真可用）、
    ``test_declared_cloud_providers_are_honestly_unavailable``（如实 false）、
    ``test_openai_provider_capabilities_declare_segment_level_only``（段级，不硬凑字级）。

    ⚠️ **惰性**：这里只构造对象，**不发网络、不加载模型**（真探测发生在
    :func:`provider_infos` / :func:`provider_capabilities` 的 ``health=True``）。
    """
    reg: dict[str, AsrProvider] = {}

    # 本地（默认 tiny/CPU；模型链/降级由 asr 引擎内部处理）
    reg["local-fw"] = LocalFasterWhisperProvider()

    # 云：三家只声明不实现（缺凭据/缺签名实现 → available 恒 false，如实报原因）
    reg.update(build_declared_providers())

    # OpenAI 兼容（真实实现：httpx；凭据来自 job 参数或环境变量）
    reg["openai-asr"] = OpenAiAsrProvider()

    return {pid: reg[pid] for pid in _REGISTRY_ORDER if pid in reg}


_override: dict[str, AsrProvider] | None = None
_built: dict[str, AsrProvider] | None = None


def get_registry() -> dict[str, AsrProvider]:
    """当前注册表（有覆盖用覆盖，否则用真实注册表，只构造一次）。"""
    global _built
    if _override is not None:
        return _override
    if _built is None:
        _built = build_registry()
    return _built


def set_registry(providers: dict[str, AsrProvider] | None) -> None:
    """替换当前注册表（``None`` = 还原成真实注册表）。

    重建依据：测试用 ``P.set_registry({...})`` 注入假 provider、``P.set_registry(None)`` 还原
    （``test_capability_reason_lists_every_hop_when_nothing_works`` 等 6 处）。

    ⚠️ 传进来的是**整份**注册表（**替换**而非合并）—— 测试给的是稀疏 dict，
    并期望链上"未注册"的那几跳被跳过，而不是回退去用真实 provider。
    """
    global _override
    _override = None if providers is None else dict(providers)


def get_provider(provider_id: str) -> AsrProvider | None:
    """按 id 取 provider（找不到返回 ``None``）。"""
    return get_registry().get(provider_id)


def _resolve(providers: dict[str, AsrProvider] | None) -> dict[str, AsrProvider]:
    """``transcribe_with_chain`` 的 ``providers`` 语义。

    ⚠️ ``{}`` 与 ``None`` **必须区分**：
    ``None`` = 用当前注册表；``{}`` = **显式空的注册表** → 报 ``E_ASR_NO_PROVIDER``
    （重建依据：``test_chain_with_empty_registry_reports_clearly``）。
    """
    return get_registry() if providers is None else dict(providers)


# ═══════════════════════════════════════════════════════════════════════
# 策略 → 链
# ═══════════════════════════════════════════════════════════════════════


def chain(policy: str = DEFAULT_POLICY) -> list[str]:
    """策略 → provider id 列表（**有序、无重复**）。

    :raises ValueError: 未知策略（消息里带可选值，便于排错）
    """
    if policy not in POLICIES:
        raise ValueError(f"未知策略: {policy}（可选：{', '.join(sorted(POLICIES))}）")
    seen: set[str] = set()
    out: list[str] = []
    for pid in POLICIES[policy]:
        if pid not in seen:
            seen.add(pid)
            out.append(pid)
    return out


# ═══════════════════════════════════════════════════════════════════════
# 能力上报
# ═══════════════════════════════════════════════════════════════════════


def _collect_infos(providers: dict[str, AsrProvider], *, health: bool) -> dict[str, ProviderInfo]:
    """收集每个 provider 的能力快照。

    ★ **顺序铁律：先 `configured`，再 `health`** ——
    没配凭据的 provider **不做**探测（省一次网络/一次模型加载），
    且**上报与真跑必须一致**：真跑时它在 ``config`` 关就被跳过；
    上报时若只做 ``health_check()``，一个"没配置但 health 假绿"的 provider
    会被报成可用 → **假绿**（重建依据：``test_capability_report_skips_unconfigured_before_health``）。

    ⚠️ ``health=True`` 时**显式调 ``p.health_check()``**（不是只把 ``health=True`` 透给
    ``info()``）：`AsrProvider.info(*, health=False)` 是可选实现，测试用的假 provider
    就**不**理会这个参数（重建依据：``test_health_flag_controls_real_probing``
    断言 ``health_calls >= 1``）。显式调用对真实 provider 同样只探测一次。
    """
    out: dict[str, ProviderInfo] = {}
    for pid, p in providers.items():
        info = p.info(health=False)
        if health and info.configured:
            try:
                ok, why = p.health_check()
            except Exception as exc:  # noqa: BLE001 —— 探测异常=不可用，不该冒泡打断上报
                ok, why = False, f"探测异常：{exc}"
            info.available = ok
            if not ok:
                # R3：不可用必须给可读原因（覆盖 provider 自己的"已配置"措辞）
                info.reason = why or "探测失败（未说明原因）"
        out[pid] = info
    return out


def provider_infos(*, health: bool = False) -> list[dict[str, Any]]:
    """所有 provider 的能力快照（``ProviderInfo.to_dict()`` 列表）。

    :param health: ``True`` 才**真探测**（``/capabilities`` 默认 false，不该打网络）
    """
    infos = _collect_infos(get_registry(), health=health)
    return [info.to_dict() for info in infos.values()]


def provider_capabilities(*, policy: str = DEFAULT_POLICY, health: bool = False) -> dict[str, Any]:
    """``/capabilities`` 的 ``asr`` 段（PROVIDERS §7 格式）。

    返回::

        {"available": bool, "engine": str, "reason": str, "policy": str,
         "chain": [id...], "providers": [info...], "wordTimestamps": bool}

    重建依据：
    * ``test_provider_capabilities_shape_matches_docs``（键集合 + ``engine=local-fw``）
    * ``test_capability_reason_lists_every_hop_when_nothing_works``（**逐跳**原因）
    * ``test_cloud_first_falls_back_to_local_and_explains_every_hop``（真降级）
    * ``test_health_flag_controls_real_probing``（``health=False`` 不探测）
    """
    providers = get_registry()
    infos = _collect_infos(providers, health=health)
    chain_ids = chain(policy)

    engine = ""
    hops: list[str] = []
    for pid in chain_ids:
        info = infos.get(pid)
        if info is None:
            # 链上有、注册表里没有 → 跳过（测试注入稀疏注册表就是这个场景）。
            # 不写进 hops：它没有"原因"可报，写了会污染逐跳说明。
            continue
        if info.available:
            engine = pid
            break
        hops.append(f"{pid}（{info.reason or '不可用（未说明原因）'}）")

    available = bool(engine)
    if available:
        first = next((pid for pid in chain_ids if pid in infos), "")
        reason = "" if engine == first else f"已降级：{'；'.join(hops)}"
        word_ts = bool(infos[engine].capabilities.get("wordTimestamps", False))
    else:
        reason = (
            "链上每一跳都不可用：" + "；".join(hops)
            if hops
            else f"策略 {policy} 的链在注册表里一个可用 provider 都没有"
        )
        word_ts = False

    return {
        "available": available,
        "engine": engine,
        "reason": reason,
        "policy": policy,
        "chain": list(chain_ids),
        "providers": [infos[pid].to_dict() for pid in infos],
        "wordTimestamps": word_ts,
    }


# ═══════════════════════════════════════════════════════════════════════
# 降级链执行（★ 主入口）
# ═══════════════════════════════════════════════════════════════════════


def _attempt(pid: str, ok: bool, stage: str, reason: str, t0: float, segments: int = 0) -> AsrAttempt:
    return AsrAttempt(
        provider=pid,
        ok=ok,
        stage=stage,
        reason=reason,
        elapsed_ms=int((time.perf_counter() - t0) * 1000),
        segments=segments,
    )


def transcribe_with_chain(
    req: AsrRequest,
    *,
    policy: str = DEFAULT_POLICY,
    explicit: str | None = None,
    providers: dict[str, AsrProvider] | None = None,
    use_health: bool = True,
) -> AsrResponse:
    """按策略跑降级链，返回带 ``attempts`` 的统一结果。

    :param explicit: 指定**唯一**一跳；失败即失败，**绝不偷偷换别家**
        （重建依据：``test_explicit_provider_does_not_fall_back``）
    :param use_health: ``False`` 跳过 ``health_check()``（测试打桩用；
        生产**不要**关 —— 那就退化成"只看配置"的假绿）
    :raises AsrUnavailable: 全链失败 / 指定的一跳不存在 / 注册表为空。
        错误码取**最后一跳**的码；``detail`` 里**逐跳原因** + 明确写"不产出字幕与文稿"。
    """
    registry = _resolve(providers)

    # ── 决定要跑哪几跳 ──
    if explicit:
        ids = [explicit]
    else:
        ids = [pid for pid in chain(policy) if pid in registry]

    if not ids:
        what = (
            f"策略 {policy} 的链 {chain(policy)} 与注册表 {sorted(registry)} 里**都不存在**"
            if not explicit
            else f"指定的 provider {explicit!r} 不存在（注册表：{sorted(registry)}）"
        )
        raise AsrUnavailable(
            f"没有可用的 ASR provider（{what}）",
            detail=what + "；此时**不产出字幕与文稿**（绝不编造）",
            code="E_ASR_NO_PROVIDER",
        )

    attempts: list[AsrAttempt] = []
    failures: list[tuple[str, str]] = []  # (provider, reason)

    for pid in ids:
        p = registry.get(pid)
        if p is None:
            # 链上有、注册表没有 → 跳过，**不计入 attempts**
            # （测试断言 attempts 精确等于 ["capability", "transcribe"] 这类序列，多一条就红）
            continue

        t0 = time.perf_counter()

        # ① config：凭据齐备？
        info = p.info(health=False)
        if not info.configured:
            why = info.reason or f"{pid} 未配置"
            attempts.append(_attempt(pid, False, "config", f"[config] {why}", t0))
            failures.append((pid, why))
            continue

        # ② health：**真探测**（R2）
        if use_health:
            try:
                ok, why = p.health_check()
            except Exception as exc:  # noqa: BLE001 —— 探测异常=不可用，不能冒泡打断整条链
                ok, why = False, f"探测异常：{exc}"
            if not ok:
                attempts.append(_attempt(pid, False, "health", f"[health] {why or '探测失败'}", t0))
                failures.append((pid, why or "探测失败"))
                continue

        # ③ capability：这一跳能不能满足请求（**硬要求**不满足就跳过，不产次品）
        try:
            supported, why = p.supports(req)
        except Exception as exc:  # noqa: BLE001
            supported, why = False, f"能力判定异常：{exc}"
        if not supported:
            attempts.append(_attempt(pid, False, "capability", f"[capability] {why}", t0))
            failures.append((pid, why))
            continue

        # ④ transcribe
        try:
            resp = p.transcribe(req)
        except ProviderError as exc:
            # 逐跳原因要带**错误码**（测试断言 reason.startswith("[E_ASR_LOAD]")）
            why = exc.msg if not exc.detail or exc.detail == exc.msg else f"{exc.msg}（{exc.detail}）"
            attempts.append(_attempt(pid, False, "transcribe", f"[{exc.code}] {why}", t0))
            failures.append((pid, why))
            continue
        except Exception as exc:  # noqa: BLE001
            # ⚠️ 必须保留异常的 **detail**（不只是 message）：
            #    runner 注入的 `transcribe_fn` 用 `AsrUnavailable(msg, detail=可读原因, code=...)`
            #    传真实原因，测试断言最终 `outcome.asr_reason` 里能看到它
            #    （``test_video_runner.py::test_pipeline_degrades_honestly_when_asr_unavailable``
            #    断言 "模型下不下来" 必须出现）。只取 `str(exc)` 会丢掉 detail。
            msg = getattr(exc, "message", None) or str(exc)
            detail = getattr(exc, "detail", "") or ""
            code = getattr(exc, "code", "") or "E_ASR_RUN"
            why = msg if not detail or detail == msg else f"{msg}（{detail}）"
            attempts.append(_attempt(pid, False, "transcribe", f"[{code}] {why}", t0))
            failures.append((pid, why))
            continue

        # ★ 0 段 = 失败（**绝不把空结果当成功**）→ 继续下一跳
        if not resp.segments:
            why = f"返回 0 段（provider={pid}）—— 空结果不算成功"
            attempts.append(_attempt(pid, False, "transcribe", f"[E_ASR_EMPTY] {why}", t0))
            failures.append((pid, why))
            continue

        attempts.append(_attempt(pid, True, "transcribe", "", t0, segments=len(resp.segments)))
        resp.attempts = attempts
        resp.used_provider = resp.used_provider or pid
        resp.provider = resp.provider or pid
        if failures:
            resp.degraded_from = failures[0][0]
            resp.reason = "；".join(f"{src}：{why}" for src, why in failures)
        else:
            resp.degraded_from = ""
            resp.reason = ""
        return resp

    # ── 全链失败（R3）──
    last_pid = attempts[-1].provider if attempts else (explicit or "unknown")
    # 最后一跳的**错误码**要透出来（测试断言 code == "E_ASR_HTTP"）
    last_code = "E_ASR_LOAD"
    raw = attempts[-1].reason if attempts else ""
    if raw.startswith("[") and "]" in raw:
        last_code = raw[1 : raw.index("]")]
    detail = (
        f"尝试 {len(attempts)} 跳（{'；'.join(f'{pid}：{why}' for pid, why in failures)}）；"
        "此时**不产出字幕与文稿**（绝不编造）"
    )
    raise AsrUnavailable(
        f"所有 ASR provider 都失败（尝试 {len(attempts)} 跳，最后 {last_pid}）",
        detail=detail,
        code=last_code,
    )


__all__ = [
    # 基类/DTO 再导出（历史：`worker.video.providers.X` 是公开路径）
    "AsrAttempt",
    "AsrProvider",
    "AsrRequest",
    "AsrResponse",
    "KINDS",
    "ProviderError",
    "ProviderInfo",
    # 具体实现（历史公开路径，别删 —— `test_video_job` 等可能按此导入）
    "LocalFasterWhisperProvider",
    "OpenAiAsrProvider",
    "DeclaredAsrProvider",
    "InlineTranscribeProvider",
    "CLOUD_SPECS",
    "CLOUD_CHUNK_MS",
    "OPENAI_MAX_BYTES",
    "build_declared_providers",
    "redact",
    # 策略与注册表
    "POLICIES",
    "DEFAULT_POLICY",
    "chain",
    "build_registry",
    "get_registry",
    "set_registry",
    "get_provider",
    # 能力上报
    "provider_infos",
    "provider_capabilities",
    # 降级链执行
    "transcribe_with_chain",
]
