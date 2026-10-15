"""LLM 客户端（契约 C1/C2/C3 + §8 错误码）。

硬要求（用户明确）：
* **并发 = 1** —— 这里不是"建议"，是 :class:`threading.Lock` 强制的；同时记录
  ``max_inflight``，测试可断言"确实串行"。
* 结构化输出必须 ``response_format={"type":"json_schema", "json_schema":{...,"strict":True}}``，
  且 schema 里**每个 object** 都是 ``additionalProperties: false`` + 完整 ``required``。
  ✗ ``json_object`` 模式**不强制 enum**：实测模型输出过 ``"etype": "常用实现"``（不在 12 种里）。
* 输出不合 schema → 重试（默认共 3 次尝试）；仍失败 → ``E_LLM_SCHEMA``。
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx

from worker.config import DEFAULT_MODEL, Settings, get_settings
from worker.models.schema_enums import card_kinds, edge_types, entity_types

log = logging.getLogger(__name__)

#: 错误码（契约 §8）
E_LLM = "E_LLM"
E_LLM_SCHEMA = "E_LLM_SCHEMA"
#: 空内容（含"推理吃光预算"）—— 契约 §0 明确要求：**不许当成功**
#: （推理模型的 reasoning token 计入输出预算：实测 8 字回复用掉 54 推理 token）
E_LLM_EMPTY_CONTENT = "E_LLM_EMPTY_CONTENT"
#: 内容不是 JSON（可能被截断）—— 与"JSON 但字段不合规"分开，处置不同
E_LLM_BAD_JSON = "E_LLM_BAD_JSON"
#: 上游 5xx / 网络故障（**可重试**）—— 与"输出不合规"分开
E_LLM_UPSTREAM = "E_LLM_UPSTREAM"


class LLMError(Exception):
    """LLM 调用失败（REST 层映射为 502 + 契约错误码）。"""

    def __init__(self, code: str, msg: str, *, detail: str = "", hint: str = ""):
        super().__init__(msg)
        self.code = code
        self.msg = msg
        self.detail = detail
        self.hint = hint

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code, "msg": self.msg, "detail": self.detail, "hint": self.hint}


class LLMSchemaError(LLMError):
    def __init__(self, msg: str, *, detail: str = "", hint: str = ""):
        super().__init__(E_LLM_SCHEMA, msg, detail=detail, hint=hint)


@dataclass
class LLMResult:
    data: dict[str, Any]
    raw: str = ""
    attempts: int = 1
    model: str = ""
    elapsed_ms: int = 0


# ═══════════════════════════════════════════════════════════════════════
# strict json_schema 工具
# ═══════════════════════════════════════════════════════════════════════
def strictify(schema: dict[str, Any], *, optional: set[str] | None = None) -> dict[str, Any]:
    """把 schema 变成 OpenAI ``strict: true`` 能接受的形态。

    规则（strict 模式的硬性要求，踩过坑）：
    1. 每个 ``object`` 都要 ``additionalProperties: false``（否则模型能自由加字段）；
    2. ``required`` 必须列出**所有** ``properties``；
    3. 因此"可选字段"只能写成**可空类型**：``{"type": ["string","null"]}``，并允许 ``null``。

    ``optional`` 是**按字段名全局生效**的（不是只在根层）：
    卡片字段 ``example`` 出现在 ``cards[].items`` 里，如果只在根层替换，
    嵌套对象仍会把"可空"字段当成必填字符串（实测踩过）。
    """
    optional = optional or set()

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(x) for x in node]
        if not isinstance(node, dict):
            return node
        out: dict[str, Any] = {}
        for k, v in node.items():
            out[k] = walk(v)
        if out.get("type") == "object" or "properties" in out:
            props: dict[str, Any] = out.get("properties", {}) or {}
            new_props: dict[str, Any] = {}
            for name, sub in props.items():
                sub2 = walk(sub)
                if name in optional and "type" in sub2:
                    t = sub2["type"]
                    if isinstance(t, str) and t != "null":
                        sub2["type"] = [t, "null"]
                    elif isinstance(t, list) and "null" not in t:
                        sub2["type"] = [*t, "null"]
                new_props[name] = sub2
            out["properties"] = new_props
            out["additionalProperties"] = False
            out["required"] = list(new_props.keys())
        return out

    return walk(schema)


# ═══════════════════════════════════════════════════════════════════════
# 极简 JSON Schema 校验（够用即可，不引第三方）
# ═══════════════════════════════════════════════════════════════════════
def validate_against_schema(data: Any, schema: dict[str, Any], path: str = "$") -> list[str]:
    """返回违规列表（空 = 通过）。支持 type/required/enum/items/properties/additionalProperties。"""
    errs: list[str] = []

    def type_ok(value: Any, t: str) -> bool:
        if t == "string":
            return isinstance(value, str)
        if t == "integer":
            return isinstance(value, int) and not isinstance(value, bool)
        if t == "number":
            return isinstance(value, (int, float)) and not isinstance(value, bool)
        if t == "boolean":
            return isinstance(value, bool)
        if t == "array":
            return isinstance(value, list)
        if t == "object":
            return isinstance(value, dict)
        if t == "null":
            return value is None
        return True

    def check(value: Any, sch: dict[str, Any], p: str) -> None:
        if not isinstance(sch, dict):
            return
        t = sch.get("type")
        if t is not None:
            allowed = t if isinstance(t, list) else [t]
            if not any(type_ok(value, a) for a in allowed):
                errs.append(f"{p}: 类型应为 {allowed}，实际 {type(value).__name__}")
                return
        if "enum" in sch and value not in sch["enum"]:
            # ★ 可空字段（strict 模式下 optional 会写成 ["T","null"] 且仍在 required 里）
            #   值 None 是合法的 → 不能拿去比 enum（实测：section_role=null 被误报）
            if value is not None or "null" not in (allowed if isinstance(t, list) else [t or ""]):
                errs.append(f"{p}: {value!r} 不在枚举 {sch['enum']} 内")
        if sch.get("type") == "object" or "properties" in sch:
            if not isinstance(value, dict):
                return
            props = sch.get("properties", {}) or {}
            for req in sch.get("required", []) or []:
                if req not in value:
                    errs.append(f"{p}: 缺必填字段 {req!r}")
            if sch.get("additionalProperties") is False:
                for k in value:
                    if k not in props:
                        errs.append(f"{p}: 出现未定义字段 {k!r}（additionalProperties=false）")
            for k, v in value.items():
                if k in props:
                    check(v, props[k], f"{p}.{k}")
        if sch.get("type") == "array" and isinstance(value, list) and "items" in sch:
            for i, item in enumerate(value):
                check(item, sch["items"], f"{p}[{i}]")

    check(data, schema, path)
    return errs


# ═══════════════════════════════════════════════════════════════════════
# 客户端
# ═══════════════════════════════════════════════════════════════════════
Transport = Callable[[dict[str, Any]], dict[str, Any]]


@dataclass
class LLMConfig:
    """LLM 连接配置（★ v2：**由 job 参数传入**，worker 不读环境变量）。

    为什么：架构 v2 §3/§4 —— provider 选择、凭据、成本统计归 Node 层。
    worker 只是"按给定配置调用"，因此同一份抽取逻辑可以被不同的
    provider/模型复用，也不会把 key 写进 worker 的日志。

    ⚠️ ``api_key`` 绝不出现在日志/事件里；需要打印时用 :meth:`redacted`。
    """

    base_url: str = ""
    api_key: str = ""
    model: str = DEFAULT_MODEL
    temperature: float = 0.0
    max_retries: int = 2
    timeout_s: float = 120.0
    #: ★ 输出预算。**推理模型的 reasoning token 计入 `max_tokens`**（实测：8 个 token 会被
    #: 推理全部吃掉 → `content` 为空、`finish_reason=length`）。不显式给预算 = 把"能不能
    #: 出内容"交给 provider 默认值（可能很小）→ 结构化抽取默认 8192（够推理 + JSON）。
    max_tokens: int = 8192
    #: ★ 用户硬要求：并发 = 1（不是"可调参数"）
    concurrency: int = 1
    #: 额外透传（如 provider id / 组织 id），worker 不解释
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.api_key)

    @property
    def mode(self) -> str:
        return "openai_compatible" if self.configured else "none"

    @property
    def reason(self) -> str:
        if self.configured:
            return ""
        return (
            "缺少 LLM 配置：job 参数里必须给 llm.base_url 与 llm.api_key"
            "（凭据由 Node 层下发，worker 不读环境变量）"
        )

    def redacted(self) -> dict[str, Any]:
        """给日志/事件用的安全形态（**不含 key**）。"""
        return {
            "base_url": self.base_url,
            "api_key_set": bool(self.api_key),
            "model": self.model,
            "temperature": self.temperature,
            "concurrency": self.concurrency,
            **({"extra": dict(self.extra)} if self.extra else {}),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None, *, default_model: str = DEFAULT_MODEL) -> "LLMConfig":
        d = dict(d or {})
        known = {"base_url", "api_key", "model", "temperature", "max_retries",
                 "timeout_s", "concurrency", "extra", "max_tokens", "maxTokens"}
        extra = dict(d.get("extra") or {})
        extra.update({k: v for k, v in d.items() if k not in known})
        return cls(
            base_url=str(d.get("base_url") or d.get("baseUrl") or "").strip(),
            api_key=str(d.get("api_key") or d.get("apiKey") or "").strip(),
            model=str(d.get("model") or default_model),
            temperature=float(d.get("temperature") or 0.0),
            max_retries=int(d.get("max_retries") or 2),
            timeout_s=float(d.get("timeout_s") or 120.0),
            # 输出预算：Node 传 maxTokens/max_tokens 就用它（settings.json 里是 16384），
            # 没传则用默认 8192 —— **绝不省略**，因为推理 token 计入预算
            max_tokens=int(d.get("max_tokens") or d.get("maxTokens") or 8192),
            # 并发固定 1：即便调用方传了别的值也不采纳（用户硬要求）
            concurrency=1,
            extra=extra,
        )

    @classmethod
    def from_settings(cls, s: Settings) -> "LLMConfig":
        """v1 兼容路径（FastAPI 时代从环境变量读）。"""
        return cls(
            base_url=s.llm_base_url,
            api_key=s.llm_api_key,
            model=s.llm_model,
            temperature=s.llm_temperature,
            max_retries=s.llm_max_retries,
            timeout_s=s.llm_timeout_s,
        )


@dataclass
class LLMStatus:
    """能力快照（供 ``/capabilities`` 的诚实接口使用）。"""

    configured: bool = False
    available: bool = False
    model: str = ""
    mode: str = "none"
    reason: str = ""
    checked_at: int = 0
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d = {
            "configured": self.configured,
            "available": self.available,
            "model": self.model,
            "mode": self.mode,
            "reason": self.reason,
        }
        d.update(self.extra)
        return d


class LLMClient:
    """OpenAI 兼容客户端（并发=1）。"""

    #: 覆盖率阈值：低于此值说明模型在瞎编（调用方自行判断怎么用）
    def __init__(
        self,
        settings: Settings | None = None,
        *,
        transport: Transport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        config: LLMConfig | None = None,
    ):
        self.settings = settings or get_settings()
        # ★ v2：config 由 job 参数构造；未给时才回落到环境变量（v1 兼容）
        self.cfg = config or LLMConfig.from_settings(self.settings)
        self._transport = transport
        self._sleep = sleep
        #: ★ 并发=1：全局互斥锁（不是信号量>1，也不是"靠自觉"）
        self._lock = threading.Lock()
        self._inflight = 0
        self._max_inflight = 0
        self.calls = 0
        #: 实际 chat 调用的结果（比 /models 探测更权威）：
        #: None=还没调过；True=成功过；False=上次失败（402/401/…）
        self._chat_ok: bool | None = None
        self._chat_error: str = ""
        #: 最近一次响应的诊断元信息（finish_reason / tokens / reasoning 长度）——
        #: 用来区分"推理吃光预算 / 上游过载 / 输出不合规"（三者处置不同）
        self._last_meta: dict[str, Any] = {}
        self.status_ = LLMStatus(
            configured=self.cfg.configured,
            model=self.cfg.model,
            mode=self.cfg.mode,
            reason=self.cfg.reason,
            # ★ checked_at=0 → 第一次问状态时会真的去探测（否则 available 永远是 False）
            checked_at=0,
        )

    # ── 能力 ────────────────────────────────────────────────────────
    @property
    def configured(self) -> bool:
        return self.cfg.configured

    @property
    def available(self) -> bool:
        return bool(self.status_.configured and self.status_.available)

    @property
    def max_inflight(self) -> int:
        """历史最大并发（测试断言 == 1，证明真的串行）。"""
        return self._max_inflight

    def status(self, *, probe: bool = False) -> dict[str, Any]:
        if probe or not self.status_.checked_at:
            try:
                self.probe()
            except LLMError as exc:  # 探测失败也要如实返回
                log.info("LLM 探测失败：%s", exc.msg)
        # 实际调用结果优先于 /models 探测：/models 可能返回 200 但对话仍 402（额度）
        if self._chat_ok is False:
            self.status_.available = False
            self.status_.reason = self._chat_error or self.status_.reason
            self.status_.extra["availability_source"] = "last_chat_call_failed"
        elif self._chat_ok is True:
            self.status_.available = True
            self.status_.reason = ""
            self.status_.extra["availability_source"] = "last_chat_call_ok"
        else:
            self.status_.extra.setdefault("availability_source", "models_endpoint")
        return self.status_.to_dict()

    def probe(self, *, force: bool = False, ttl_s: float = 60.0) -> LLMStatus:
        """探测可用性（``GET /models``，不消耗 token）。

        为什么不用一次 chat 调用来探测：那会烧额度，而且额度耗尽时（402）
        探测本身也会失败 —— 需要的正是"能否调通"这个答案。
        """
        now = int(time.time() * 1000)
        if not force and self.status_.checked_at and now - self.status_.checked_at < ttl_s * 1000:
            return self.status_
        st = LLMStatus(
            configured=self.cfg.configured,
            model=self.cfg.model,
            mode=self.cfg.mode,
            checked_at=now,
        )
        if not self.configured:
            st.reason = self.cfg.reason
            self.status_ = st
            return st
        if self._transport is not None:
            st.available = True
            st.reason = "使用注入的 transport（测试替身，未联网）"
            self.status_ = st
            return st
        url = self.cfg.base_url.rstrip("/") + "/models"
        try:
            with httpx.Client(**self._http_client_kwargs()) as client:
                resp = client.get(url, headers=self._headers())
            if resp.status_code == 200:
                st.available = True
                try:
                    ids = [m.get("id") for m in resp.json().get("data", [])]
                    st.extra["models"] = [m for m in ids if m][:50]
                except Exception:  # noqa: BLE001
                    pass
            else:
                st.available = False
                st.reason = self._reason_from_http(resp)
                st.extra["http_status"] = resp.status_code
        except Exception as exc:  # noqa: BLE001 - 网络异常也是"不可用"
            st.available = False
            st.reason = f"探测失败：{type(exc).__name__}: {exc}"
        self.status_ = st
        return st

    @staticmethod
    def _reason_from_http(resp: httpx.Response) -> str:
        body = ""
        try:
            body = resp.text[:400]
        except Exception:  # noqa: BLE001
            pass
        code = ""
        reset = ""
        try:
            j = resp.json()
            code = str(j.get("error", {}).get("code") or j.get("code") or "")
            reset = str(j.get("reset_at") or j.get("error", {}).get("reset_at") or "")
        except Exception:  # noqa: BLE001
            pass
        parts = [f"HTTP {resp.status_code}"]
        if code:
            parts.append(code)
        if reset:
            parts.append(f"reset_at={reset}")
        if body and not code:
            parts.append(body.replace("\n", " ")[:200])
        return "；".join(parts)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.cfg.api_key}",
            "Content-Type": "application/json",
        }

    def _http_client_kwargs(self) -> dict[str, Any]:
        """httpx 客户端参数。

        ★ 本地端点必须**绕过环境代理**：实测本机 stub/本地 provider（127.0.0.1）
        会被 `HTTP_PROXY` 接管并返回 **502**，表现为"LLM 直接失败"，
        排查成本极高。外部端点仍照常用环境代理（企业网常需要）。
        """
        url = self.cfg.base_url or ""
        is_local = any(h in url for h in ("127.0.0.1", "localhost", "0.0.0.0", "[::1]"))
        return {"timeout": self.cfg.timeout_s, "trust_env": not is_local}

    # ── 调用 ────────────────────────────────────────────────────────
    def complete_json(
        self,
        *,
        system: str,
        user: str,
        schema: dict[str, Any],
        name: str = "out",
        optional: set[str] | None = None,
        max_attempts: int | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> LLMResult:
        """按 ``json_schema`` + ``strict`` 要结构化输出，并校验（不合法就重试）。"""
        strict_schema = strictify(schema, optional=optional)
        attempts = max_attempts or (1 + max(0, self.cfg.max_retries))
        last_err: Exception | None = None
        prompt_user = user
        for attempt in range(1, attempts + 1):
            payload = self._payload(
                system=system,
                user=prompt_user,
                schema=strict_schema,
                name=name,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            started = time.time()
            raw = self._call(payload)
            data = _extract_json(raw)
            errs = validate_against_schema(data, strict_schema) if data is not None else ["无法解析出 JSON"]
            if not errs:
                return LLMResult(
                    data=data,
                    raw=raw,
                    attempts=attempt,
                    model=self.cfg.model,
                    elapsed_ms=int((time.time() - started) * 1000),
                )
            last_err = LLMSchemaError(
                "模型输出不符合 schema",
                detail="; ".join(errs[:8]),
                hint="已自动重试；若持续失败请检查 schema 是否过严",
            )
            log.warning("第 %d/%d 次输出不合 schema：%s", attempt, attempts, errs[:4])
            # 把违规项回灌给模型，明确要求修正（比"再试一次"有效）
            prompt_user = (
                user
                + "\n\n【上一次输出不合法，必须修正】\n"
                + "\n".join(f"- {e}" for e in errs[:8])
                + "\n请只输出符合 schema 的 JSON。"
            )
            if attempt < attempts:
                self._sleep(0.5 * attempt)
        # ★ 末次输出**根本不是 JSON** → 独立错误码 + 响应诊断：
        #   "被截断 / 空内容" 与 "JSON 但不合 schema" 的处置完全不同
        #   （polysemy-prober 实测：上游 503 与"返回非 JSON"被表达成同一个 E_LLM，运维无法分辨）
        if isinstance(last_err, LLMSchemaError) and "无法解析出 JSON" in (last_err.detail or ""):
            meta = self._last_meta or {}
            raise LLMError(
                E_LLM_BAD_JSON,
                "模型输出不是合法 JSON（可能被截断）",
                detail=(f"finish_reason={meta.get('finish_reason')} "
                        f"content_chars={meta.get('content_chars')} "
                        f"completion_tokens={meta.get('completion_tokens')} "
                        f"reasoning_chars={meta.get('reasoning_chars')}；尝试 {attempts} 次"),
                hint="若 finish_reason=length 说明输出被截断 → 提高 max_tokens；"
                     "否则检查提示词是否明确要求纯 JSON 输出",
            )
        raise last_err or LLMSchemaError("结构化输出失败")

    def complete_text(
        self,
        *,
        system: str,
        user: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> str:
        """纯文本输出（摘要/思维导图这类不需要严格 schema 的场景）。"""
        payload = self._payload(
            system=system,
            user=user,
            schema=None,
            name="",
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return self._call(payload)

    def _payload(
        self,
        *,
        system: str,
        user: str,
        schema: dict[str, Any] | None,
        name: str,
        temperature: float | None,
        max_tokens: int | None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.cfg.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": self.cfg.temperature if temperature is None else temperature,
            "stream": False,
        }
        # ★ 永远显式给预算：调用方 > 配置默认（推理 token 计入预算，不能靠 provider 默认值）
        budget = int(max_tokens or self.cfg.max_tokens or 0)
        if budget > 0:
            payload["max_tokens"] = budget
        if schema is not None:
            # ★ 唯一可靠的结构化输出方式（契约 C2）
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": name or "out", "strict": True, "schema": schema},
            }
        return payload

    def _call(self, payload: dict[str, Any]) -> str:
        """真正发请求（**持锁串行** = 并发 1），并统一做"空内容不算成功"检查。"""
        if not self.configured:
            raise LLMError(
                E_LLM,
                "未配置 LLM 凭据",
                detail=self.cfg.reason,
                hint="设置 AMR_KEY / AMR_BASE（或 OPENAI_API_KEY / OPENAI_BASE_URL）",
            )
        with self._lock:  # ★ 并发=1
            self._inflight += 1
            self._max_inflight = max(self._max_inflight, self._inflight)
            try:
                self.calls += 1
                raw = (self._transport(payload) if self._transport is not None
                       else self._http_call(payload))
                return self._ensure_content(raw, payload)
            finally:
                self._inflight -= 1

    def _ensure_content(self, raw: Any, payload: dict[str, Any]) -> str:
        """★ 空内容**不算成功**（契约 §0：content 空而 reasoning 非空必须显式报错）。

        两个关键点：
        1. 检查放在 :meth:`_call` 里 → **HTTP 与注入 transport 两条路径都覆盖**。
           第一版只在 ``_http_call`` 里查 → 注入替身的调用会绕过（我自己的测试抓到的隐患）。
        2. 报错要能区分"预算被推理吃光"与"模型就是返回了空"——
           推理模型（如 deepseek-v4.1-flash）的 reasoning token **计入输出预算**，
           实测 8 个 token 会被推理全部吃掉、``finish_reason=length``、``content`` 为空。
           （polysemy-prober 在 Node 侧实测到同一现象；只判 HTTP 200 会**假绿**。）
        """
        text = str(raw or "")
        if text.strip():
            return text
        meta = self._last_meta or {}
        # ⚠️ 措辞用"很可能"：`finish_reason=length` 与 reasoning 长度只是**线索**，
        #    不保证总出现（Lead 实测：8 token 时出现了 length，但不能依赖它）
        #    → **判据只看 content 是否为空**，原因描述保持概率化，别断言因果。
        why = ("很可能推理 token 吃光了输出预算" if meta.get("reasoning_chars")
               else "模型返回了空内容")
        raise LLMError(
            E_LLM_EMPTY_CONTENT,
            f"模型没有输出内容（{why}）",
            detail=(f"finish_reason={meta.get('finish_reason')} "
                    f"completion_tokens={meta.get('completion_tokens')} "
                    f"reasoning_chars={meta.get('reasoning_chars')} "
                    f"max_tokens={payload.get('max_tokens')}"),
            hint=("提高 max_tokens（推理 token 计入输出预算：实测 8 会被推理全部吃掉；"
                  "结构化抽取建议 ≥2000，探测至少 ≥500）"),
        )

    def _http_call(self, payload: dict[str, Any]) -> str:
        url = self.cfg.base_url.rstrip("/") + "/chat/completions"
        last_exc: Exception | None = None
        for attempt in range(1, 3):  # 网络抖动重试（与 schema 重试独立）
            try:
                with httpx.Client(**self._http_client_kwargs()) as client:
                    resp = client.post(url, headers=self._headers(), json=payload)
                if resp.status_code == 200:
                    body = resp.json()
                    try:
                        message = body["choices"][0]["message"]
                        choice = body["choices"][0]
                        content = message.get("content") or ""
                    except (KeyError, IndexError, TypeError) as exc:
                        raise LLMError(
                            E_LLM, "响应结构异常", detail=json.dumps(body)[:400]
                        ) from exc
                    # ★ 记录本次响应的诊断信息：S4/运维要靠它区分
                    #   "推理吃光预算" vs "上游过载" vs "输出不合规"（三者的处置完全不同）
                    self._last_meta = self._response_meta(choice, message, body)
                    self._chat_ok = True
                    self._chat_error = ""
                    self.status_.available = True
                    self.status_.reason = ""
                    self.status_.checked_at = int(time.time() * 1000)
                    return content
                # 4xx 一般不重试（额度/凭据问题重试没用）
                reason = self._reason_from_http(resp)
                self._chat_ok = False
                self._chat_error = reason
                self.status_.available = False
                self.status_.reason = reason
                self.status_.checked_at = int(time.time() * 1000)
                self.status_.extra["availability_source"] = "last_chat_call_failed"
                if resp.status_code in (401, 402, 403, 404, 429) or resp.status_code < 500:
                    raise LLMError(
                        E_LLM,
                        f"LLM 返回 HTTP {resp.status_code}",
                        detail=reason,
                        hint="402/额度不足需等额度重置；401 检查 key；404 检查 base_url 是否带 /v1",
                    )
                # ★ 5xx：**上游故障**（如 503 Service Overload）—— 与"输出不合规"是两回事，
                #   用独立错误码 + retryable，运维一眼能分辨（polysemy-prober 实测踩到）
                last_exc = LLMError(
                    E_LLM_UPSTREAM,
                    f"上游返回 HTTP {resp.status_code}",
                    detail=reason,
                    hint="上游瞬时故障，重试即可；持续失败请查 provider 状态页",
                )
                setattr(last_exc, "retryable", True)
            except httpx.HTTPError as exc:
                last_exc = LLMError(E_LLM_UPSTREAM, f"网络错误：{exc}",
                                    detail=type(exc).__name__)
                setattr(last_exc, "retryable", True)
            if attempt < 2:
                self._sleep(1.0 * attempt)
        raise last_exc or LLMError(E_LLM, "LLM 调用失败")

    @staticmethod
    def _response_meta(choice: dict[str, Any], message: dict[str, Any],
                       body: dict[str, Any]) -> dict[str, Any]:
        """把响应里**对诊断有用**的字段摘出来（不含正文，避免把模型输出写进日志）。"""
        usage = body.get("usage") or {}
        reasoning = message.get("reasoning_content") or message.get("reasoning") or ""
        return {
            "finish_reason": choice.get("finish_reason"),
            "content_chars": len(message.get("content") or ""),
            "reasoning_chars": len(reasoning) if isinstance(reasoning, str) else 0,
            "completion_tokens": usage.get("completion_tokens"),
            "reasoning_tokens": (usage.get("completion_tokens_details") or {}).get(
                "reasoning_tokens"),
            "prompt_tokens": usage.get("prompt_tokens"),
        }

    # ── 指标 ────────────────────────────────────────────────────────
    def metrics(self) -> dict[str, Any]:
        return {
            "calls": self.calls,
            "max_inflight": self._max_inflight,
            "concurrency_limit": 1,
            "serial_ok": self._max_inflight <= 1,
            "model": self.cfg.model,
            "transport": "injected" if self._transport is not None else "http",
        }


def _extract_json(raw: str) -> dict[str, Any] | None:
    """从模型输出里取出 JSON 对象（容忍 ```json 围栏与前后废话）。"""
    if not raw:
        return None
    text = raw.strip()
    fence = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        pass
    # 退一步：找第一个 { 到最后一个 }
    i, j = text.find("{"), text.rfind("}")
    if i != -1 and j > i:
        try:
            obj = json.loads(text[i : j + 1])
            return obj if isinstance(obj, dict) else None
        except json.JSONDecodeError:
            return None
    return None


def enum_guard_notes() -> dict[str, list[str]]:
    """给提示词用的封闭枚举（永远从 schema/ 读，不硬编码）。"""
    return {
        "kind": list(card_kinds()),
        "etype": list(edge_types()),
        "entity_type": list(entity_types()),
    }
