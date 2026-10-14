#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""极简 Chrome DevTools Protocol 客户端（标准库实现，无第三方依赖）

为什么要自己写：
  · **Node 不能拉起可用的 Chrome**（本机实测：Chrome 的 network service 建命名管道被拒 →
    连本地 HTTP 都请求不到）。所以 e2e 必须由 Python 驱动。
  · Python 标准库没有 WebSocket 客户端，而 CDP 就是 WebSocket + JSON。

为什么不用 `--dump-dom` + `?barrier=`（我一开始的做法）：
  · `--dump-dom` 在 **load 事件**时取 DOM，而页面数据是 load 之后异步拉的 →
    我当时用「挂起一个 <img> 请求」把 load 推迟到渲染完成，但那**占掉一个 HTTP 连接槽**
    （Chrome 每源 6 个），页面并行请求一多就互相等死 → 表现是"页面只渲染了一半"。
  · CDP 可以直接**轮询 ready 条件**（`Runtime.evaluate`），既不占连接，也不依赖 load 事件，
    还能拿到真实时间下的 `performance.now()` 数字与截图。

提供：`Chrome`（启动/导航/求值/截图）、`evaluate`、`wait_for`、`outer_html`。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import socket
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def find_chrome() -> str | None:
    for c in CHROME_CANDIDATES:
        if Path(c).exists():
            return c
    return None


class WSError(RuntimeError):
    pass


class WebSocket:
    """只实现 CDP 需要的部分：文本帧、掩码客户端帧、>64KB 分片（截图 base64 会超）。"""

    def __init__(self, url: str, timeout: float = 30.0):
        u = urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port or 80), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        path = u.path + (f"?{u.query}" if u.query else "")
        req = (
            f"GET {path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        header = b""
        while b"\r\n\r\n" not in header:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WSError("WebSocket 握手失败：连接被关闭")
            header += chunk
        if b"101" not in header.split(b"\r\n")[0]:
            raise WSError(f"WebSocket 握手失败：{header.split(b'\r\n')[0]!r}")
        self._buf = header.split(b"\r\n\r\n", 1)[1]

    # ---- 帧 ----
    def send_text(self, text: str) -> None:
        payload = text.encode("utf-8")
        header = bytearray([0x81])                      # FIN + text
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < (1 << 16):
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def _read_exact(self, n: int) -> bytes:
        data = b""
        while len(data) < n:
            if self._buf:
                take = self._buf[: n - len(data)]
                self._buf = self._buf[len(take):]
                data += take
                continue
            chunk = self.sock.recv(max(4096, n - len(data)))
            if not chunk:
                raise WSError("连接关闭")
            self._buf += chunk
        return data

    def recv_text(self) -> str:
        while True:
            b0, b1 = self._read_exact(2)
            opcode = b0 & 0x0F
            masked = b1 & 0x80
            length = b1 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._read_exact(8))[0]
            mask = self._read_exact(4) if masked else b""
            payload = self._read_exact(length)
            if masked:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:
                raise WSError("服务端要求关闭")
            if opcode == 0x9:                            # ping → pong
                self.sock.sendall(b"\x8a\x80" + os.urandom(4))
                continue
            if opcode == 0x1:
                return payload.decode("utf-8", "replace")
            if opcode == 0xA:
                continue
            # 其它（二进制/续帧）忽略

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


class Chrome:
    """headless Chrome + CDP。用法：

    with Chrome() as ch:
        ch.navigate(url)
        ch.wait_for("!!document.getElementById('wiki-report')", timeout=60)
        html = ch.outer_html()
        ch.screenshot("wiki-light.png")
    """

    def __init__(self, chrome: str | None = None, width: int = 1440, height: int = 1000,
                 theme: str | None = None, extra_args: list[str] | None = None):
        self.chrome = chrome or find_chrome()
        if not self.chrome:
            raise RuntimeError("找不到 Chrome")
        self.profile = tempfile.mkdtemp(prefix="coursekb-cdp-")
        self.proc = subprocess.Popen(
            [
                self.chrome, "--headless=new", "--disable-gpu", "--no-first-run",
                "--no-default-browser-check", "--disable-extensions", "--mute-audio",
                "--disable-background-networking", "--autoplay-policy=no-user-gesture-required",
                "--remote-debugging-port=0", f"--user-data-dir={self.profile}",
                f"--window-size={width},{height}", "about:blank",
                *(extra_args or []),
            ],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.ws_url = self._read_devtools_url()
        self.ws = WebSocket(self.ws_url, timeout=60)
        self._id = 0
        self.width = width
        self.height = height
        # stderr 给的是 **browser** 级端点（没有 Page 域）→ 用 Target 附加到页面 target
        self.session_id = self._attach_page()
        self.call("Page.enable")
        self.call("Runtime.enable")
        if theme:
            self.set_theme(theme)

    def _attach_page(self) -> str:
        deadline = time.time() + 20
        while time.time() < deadline:
            targets = self.call("Target.getTargets").get("targetInfos", [])
            page = next((t for t in targets if t.get("type") == "page"), None)
            if page:
                r = self.call("Target.attachToTarget", {"targetId": page["targetId"], "flatten": True})
                return r["sessionId"]
            time.sleep(0.2)
        raise RuntimeError("没有可附加的页面 target")

    # ---- 生命周期 ----
    def _read_devtools_url(self, timeout: float = 40.0) -> str:
        deadline = time.time() + timeout
        buf = b""
        import threading
        lines: list[str] = []

        def reader():
            for raw in self.proc.stderr:                  # type: ignore[union-attr]
                lines.append(raw.decode("utf-8", "replace"))
        threading.Thread(target=reader, daemon=True).start()
        while time.time() < deadline:
            for line in list(lines):
                m = re.search(r"DevTools listening on (ws://\S+)", line)
                if m:
                    return m.group(1)
            if self.proc.poll() is not None:
                raise RuntimeError(f"Chrome 退出（code={self.proc.returncode}）")
            time.sleep(0.1)
        raise RuntimeError(f"未拿到 DevTools 地址；stderr={''.join(lines)[-800:]!r}")

    def close(self) -> None:
        try:
            self.ws.close()
        except Exception:
            pass
        try:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
        import shutil
        shutil.rmtree(self.profile, ignore_errors=True)

    def __enter__(self) -> "Chrome":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ---- CDP ----
    def call(self, method: str, params: dict | None = None, timeout: float = 60.0):
        self._id += 1
        mid = self._id
        payload: dict = {"id": mid, "method": method, "params": params or {}}
        if getattr(self, "session_id", None):
            payload["sessionId"] = self.session_id
        self.ws.send_text(json.dumps(payload))
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = self.ws.recv_text()
            try:
                data = json.loads(msg)
            except json.JSONDecodeError:
                continue
            if data.get("id") == mid:
                if "error" in data:
                    raise RuntimeError(f"CDP {method} 失败：{data['error']}")
                return data.get("result", {})
        raise TimeoutError(f"CDP {method} 超时")

    def evaluate(self, expression: str, await_promise: bool = False, timeout: float = 60.0):
        r = self.call("Runtime.evaluate", {
            "expression": expression, "returnByValue": True, "awaitPromise": await_promise,
        }, timeout=timeout)
        if "exceptionDetails" in r:
            raise RuntimeError(f"页面求值异常：{r['exceptionDetails'].get('text')} {expression[:80]}")
        return r.get("result", {}).get("value")

    def navigate(self, url: str, timeout: float = 90.0) -> None:
        self.call("Page.navigate", {"url": url}, timeout=timeout)
        # 等 document.readyState 至少 interactive
        self.wait_for("document.readyState !== 'loading'", timeout=timeout, interval=0.05)

    def wait_for(self, expression: str, timeout: float = 60.0, interval: float = 0.15):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                last = self.evaluate(expression)
            except RuntimeError as e:
                last = f"err: {e}"
            if last:
                return last
            time.sleep(interval)
        raise TimeoutError(f"等待条件超时：{expression}（最后值 {last!r}）")

    def outer_html(self) -> str:
        return self.evaluate("document.documentElement.outerHTML") or ""

    def screenshot(self, path: str, full_page: bool = True) -> None:
        params = {"format": "png"}
        if full_page:
            params["captureBeyondViewport"] = True
        r = self.call("Page.captureScreenshot", params, timeout=120)
        Path(path).write_bytes(base64.b64decode(r["data"]))

    def set_theme(self, theme: str) -> None:
        """'dark' / 'light' —— 写进 localStorage，保证导航后仍然生效。

        ⚠️ 在 `about:blank`（不透明源）上 `localStorage` 会抛异常 → 必须包 try/catch；
        页面 URL 上还会再带一次 `?theme=`（应用启动时读取），双保险。
        """
        self.evaluate(
            "try { localStorage.setItem('coursekb-theme', %s) } catch (e) {}"
            "document.documentElement.dataset.theme = %s;"
            % (json.dumps(theme), json.dumps(theme))
        )


if __name__ == "__main__":                                # 自检
    sys.stdout.reconfigure(encoding="utf-8")
    with Chrome() as ch:
        ch.navigate("data:text/html,<h1 id=x>cdp ok</h1>")
        print("evaluate:", ch.evaluate("document.getElementById('x').textContent"))
        print("ws:", ch.ws_url[:60])
