# -*- coding: utf-8 -*-
"""外部输入的**显式解码**（argv / 文件 / stdin 三条路径）。

## 为什么需要这个模块（真 bug，不是理论问题）

本项目为绕开 Windows argv 32KB 上限，规定**大 payload 走 stdin**（AGENTS.md 坑 18）。
但第一版的 ``sys.stdin.read()`` 在 Windows 上按**语言环境编码**（本机 GBK）解码 ——
于是"我们推荐的那条路径"在**中文内容下必然乱码**：

```
同一份 UTF-8 字节喂 stdin：
  默认（GBK 解码）            terms = ['任?', '?务']   ← 静默错
  PYTHONIOENCODING=utf-8     terms = ['任务']         ← 对
```

更糟的是它**看起来成功**：坏字节被解成"任?"这种字符，JSON 依然能解析，
于是一路写到库里。所以本模块只做一件事：**不依赖语言环境，显式解码，坏了就明确报错**。

## errors 策略：**strict**（不是 replace）—— 理由

`errors="replace"` 会把坏字节变成 ``?``（或 U+FFFD）**而不报错**：
* 若坏字节落在 JSON 字符串值里 → ``json.loads`` **照样成功** → 内容被静默改坏、无任何信号；
* 若落在 JSON 结构里 → 报的是"JSON 语法错"，把**编码问题**误诊成**格式问题**（排查方向全错）。

而编码错误几乎总是**上游真的错了**（用非 UTF-8 写 stdin、流被截断、文本被二次编码），
明确失败并指出"第几字节不是合法 UTF-8"才是可修的。→ 选 **strict** + 可读错误。

## BOM：顺手识别（不靠猜）

Windows 上的编辑器/PowerShell 常写 BOM：``Set-Content -Encoding Unicode`` 就是 UTF-16LE。
所以按 BOM 判断编码（utf-8-sig / utf-16-le / utf-16-be），**没有 BOM 才按 UTF-8 strict 解**。
这不是"猜编码"——BOM 是文件自己声明的。
"""

from __future__ import annotations

from pathlib import Path

#: 各 BOM 前缀 → 编码
_BOMS: tuple[tuple[bytes, str], ...] = (
    (b"\xef\xbb\xbf", "utf-8-sig"),
    (b"\xff\xfe\x00\x00", "utf-32-le"),
    (b"\x00\x00\xfe\xff", "utf-32-be"),
    (b"\xff\xfe", "utf-16-le"),
    (b"\xfe\xff", "utf-16-be"),
)

#: 出错时最多展示多少字节的上下文
_ERROR_SNIPPET_BYTES = 16


class PayloadEncodingError(ValueError):
    """输入不是合法 UTF-8（或 BOM 声明的编码解不开）。

    上层应映射成 ``E_PAYLOAD`` + 退出码 2：**这是调用方的写法问题，重试无用**。
    """

    code = "E_PAYLOAD"

    def __init__(self, msg: str, *, detail: str = ""):
        super().__init__(msg)
        self.msg = msg
        self.detail = detail


def decode_payload_bytes(data: bytes, *, source: str = "stdin") -> str:
    """把输入字节解成文本：**按 BOM 判编码，否则 UTF-8 strict**。"""
    raw = data or b""
    for bom, encoding in _BOMS:
        if raw.startswith(bom):
            try:
                text = raw.decode(encoding)
            except UnicodeDecodeError as exc:
                raise PayloadEncodingError(
                    f"{source} 的 BOM 声明为 {encoding}，但解码失败：{exc}",
                    detail=f"前 {_ERROR_SNIPPET_BYTES} 字节：{raw[:_ERROR_SNIPPET_BYTES]!r}",
                ) from exc
            # ⚠️ 用显式 codec（`utf-16-le`）解码时 BOM 会**留在文本里**（U+FEFF），
            #    而 `json.loads` 见到它会直接报 "Unexpected UTF-8 BOM"。
            #    `utf-8-sig` 会自动去掉，`utf-16-le` 不会 → 统一在这里剥一次。
            return text[1:] if text.startswith("\ufeff") else text
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        bad = raw[exc.start:exc.start + _ERROR_SNIPPET_BYTES]
        raise PayloadEncodingError(
            (f"{source} 不是合法 UTF-8：第 {exc.start} 字节起解码失败"
             f"（{exc.reason}）—— 常见原因：上游用系统默认编码写的（Windows 中文机是 GBK），"
             "或字节流被截断"),
            detail=(f"坏字节：{bad!r}（hex {bad.hex()}）；"
                    f"总长度 {len(raw)} 字节。"
                    "修法：以 UTF-8 写入（Node 用 Buffer.from(json,'utf8')；"
                    "Python 用 .encode('utf-8')；PowerShell 用 Out-File -Encoding utf8）"),
        ) from exc


def read_stdin_text(*, source: str = "stdin") -> str:
    """读 stdin（**字节级 + 显式解码**，不看语言环境）。

    注意：不用 ``sys.stdin.read()`` —— 它按 locale 解码（Windows 中文机 = GBK）。
    用 ``sys.stdin.buffer.read()`` 拿原始字节再显式解码。
    """
    import sys

    try:
        buf = getattr(sys.stdin, "buffer", None)
        if buf is None:                      # 已被替换成文本流（测试替身）
            return sys.stdin.read()          # type: ignore[no-any-return]
        return decode_payload_bytes(buf.read(), source=source)
    except PayloadEncodingError:
        raise
    except (OSError, ValueError) as exc:     # 读不到 stdin（无重定向等）
        raise PayloadEncodingError(f"读取 {source} 失败：{type(exc).__name__}: {exc}") from exc


def read_text_file(path: str | Path, *, source: str | None = None) -> str:
    """读文本文件（BOM 识别 + UTF-8 strict），失败给可读原因。"""
    p = Path(path)
    label = source or str(p)
    try:
        return decode_payload_bytes(p.read_bytes(), source=label)
    except PayloadEncodingError:
        raise
    except OSError as exc:
        raise PayloadEncodingError(f"读取 {label} 失败：{exc}") from exc


def configure_stdio_utf8() -> None:
    """把 **stderr** 调成 UTF-8（日志可读且不会因编码崩）。

    stdout **不动**：协议输出走 ``sys.stdout.buffer`` 的纯 ASCII 字节（见 cli.Emitter），
    与文本层编码无关。这里是"日志可读性"的加固，不是协议的一部分。
    """
    import sys

    for stream_name in ("stderr",):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                # errors="backslashreplace"：日志宁可出现 \uXXXX 转义也不能崩
                reconfigure(encoding="utf-8", errors="backslashreplace")
            except (ValueError, OSError):
                pass
