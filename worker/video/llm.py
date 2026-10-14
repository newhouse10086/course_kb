"""worker 侧的 LLM 调用（**配置由 Node 层下发，worker 不读凭据**）。

v2 架构下 provider 策略归 Node 层（``docs/ARCHITECTURE_V2.md`` §3/§4），
所以 worker **不再自己读 ``.env``**：job 参数里带 ``llm: {base_url, api_key, model}``，
本模块把它变成 ``(prompt, schema) -> dict`` 回调给 :mod:`worker.video.transcript` 用。

## 硬要求（踩过的坑）

1. **``json_schema`` + ``strict: true``**（坑 4）：``json_object`` 模式不强制字段，
   实测模型会漏字段 / 输出 ``"etype":"常用实现"`` 这种枚举外值
2. **并发 = 1**（用户硬要求）：这里用一把模块级锁，**不是**"靠调用方自觉"
3. **失败不许编造**：调用失败 → 抛 :class:`TextModelUnavailable`，
   由 :mod:`worker.video.transcript` 如实降级为**机械分节**（标题如实标"分节 N"）
4. **凭据不落日志**：错误信息统一过 :func:`worker.video.providers.cloud.redact`
"""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Callable

from .errors import TextModelUnavailable
from .providers.cloud import redact

log = logging.getLogger(__name__)

#: ★ 并发=1：全局互斥锁（进程内串行调用 LLM）
_LLM_LOCK = threading.Lock()
#: 结构化输出重试次数（模型偶尔不守 schema）
DEFAULT_ATTEMPTS = 3


def make_text_model(
    cfg: dict[str, Any] | None,
    *,
    timeout_s: float = 120.0,
    attempts: int = DEFAULT_ATTEMPTS,
    transport: Any = None,
    system: str = "你是课程内容编辑；只输出符合给定 JSON schema 的内容，不要解释。",
) -> tuple[Callable[[str, dict], dict] | None, str]:
    """``job.llm`` 配置 → ``(caller, reason)``。

    :param cfg: ``{"base_url","api_key","model"}``；缺任一 → ``(None, reason)``
    :return: ``(caller 或 None, 不可用原因)``
    """
    cfg = cfg or {}
    base_url = str(cfg.get("base_url") or "").strip()
    api_key = str(cfg.get("api_key") or "").strip()
    model = str(cfg.get("model") or "").strip()
    missing = [k for k, v in (("base_url", base_url), ("api_key", api_key), ("model", model)) if not v]
    if missing:
        return None, (
            "worker 不再自行读凭据（v2：provider 策略归 Node 层）；"
            "job 参数 llm 缺字段：" + "、".join(missing)
        )

    def call(prompt: str, schema: dict) -> dict:
        import httpx

        url = f"{base_url.rstrip('/')}/chat/completions"
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.0,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "out", "strict": True, "schema": schema},
            },
        }
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        last: Exception | None = None
        with _LLM_LOCK:  # ★ 并发=1
            for attempt in range(1, max(1, attempts) + 1):
                try:
                    kwargs: dict[str, Any] = {"timeout": timeout_s}
                    if transport is not None:
                        kwargs["transport"] = transport
                    with httpx.Client(**kwargs) as client:
                        resp = client.post(url, headers=headers, json=body)
                    if resp.status_code >= 400:
                        raise TextModelUnavailable(
                            f"LLM 返回 HTTP {resp.status_code}",
                            detail=redact(resp.text[:300], [api_key]),
                            code="E_LLM_HTTP",
                        )
                    payload = resp.json()
                    content = (payload.get("choices") or [{}])[0].get("message", {}).get("content", "")
                    data = json.loads(content or "{}")
                    if not isinstance(data, dict):
                        raise ValueError(f"模型输出不是 JSON 对象：{type(data).__name__}")
                    return data
                except TextModelUnavailable:
                    raise  # 额度/鉴权类错误重试没意义（实测 402 会一直 402）
                except Exception as exc:  # noqa: BLE001
                    last = exc
                    log.warning("LLM 第 %d/%d 次失败：%s", attempt, attempts, redact(str(exc), [api_key]))
                    if attempt < attempts:
                        time.sleep(0.5 * attempt)
        raise TextModelUnavailable(
            f"LLM 调用失败（重试 {attempts} 次）：{last}",
            detail=f"{type(last).__name__}: {redact(str(last), [api_key])}",
            code="E_LLM",
        )

    call.model = model  # type: ignore[attr-defined]
    return call, ""


__all__ = ["make_text_model", "DEFAULT_ATTEMPTS"]
