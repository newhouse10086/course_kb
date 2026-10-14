# -*- coding: utf-8 -*-
"""pi RPC 侦察脚本 —— 验证全局 pi 能否真正跑通 RPC。

## 本脚本的存在意义：**避免假绿**

初版有两处会给出误导性结论，均由 pi-bridge 实测指出、此处已修正：

  1. **读取器**：`BufferedReader.read(n)` 会**阻塞到拿满 n 字节或 EOF**。
     对长连接 RPC 就是"看起来卡死"，最后 `stdin.close()` 才一次性吐出全部记录
     → 单轮 + close stdin 会**假绿**。
     ✓ 修正：用 `read1(65536)`（有一次底层 read 就返回）。
     并**加多轮测试**（不 close stdin），才能证明读取器真的流式。

  2. **启动方式**：Windows 上 `pi` 是 `.CMD` 包装器，`Popen(["pi",...])` → FileNotFoundError。
     `shell=True` 能跑，但本项目路径含**空格+中文**，需引号转义且有注入面。
     ✓ 修正：用 `shutil.which("pi")` 拿到的 **`.CMD` 全路径 + argv 列表**（实测可跑）。

## 运行
    python docs/evidence/probe_pi_rpc.py
"""
import json
import shutil
import subprocess
import sys
import threading
import time

LEAD = "==>"


def p(*a):
    print(*a)
    sys.stdout.flush()


class LineReader:
    """按字节读 stdout，只以 \\n 切帧。

    ⚠️ 两个关键点（都踩过）：
      · **不能用 readline** —— 它会把 U+2028/U+2029 当行分隔，而这两个字符
        在 JSON 字符串里**合法**，会导致错误切帧（pi 官方文档 P1）。
      · **不能用 read(n)** —— 会阻塞到 EOF，表现为"卡死"/假绿。
        用 read1(n)：有一次底层 read 就返回。
    """

    def __init__(self, stream, sink):
        self.stream = stream
        self.sink = sink          # list[bytes]
        self._buf = b""
        self._stop = False
        self.bytes_seen = 0

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while not self._stop:
            try:
                chunk = self.stream.read1(65536)      # ★ 不阻塞到 EOF
            except Exception:
                break
            if not chunk:
                break
            self.bytes_seen += len(chunk)
            self._buf += chunk
            while b"\n" in self._buf:                 # ★ 只按 \n 切
                line, self._buf = self._buf.split(b"\n", 1)
                if line.endswith(b"\r"):
                    line = line[:-1]
                if line.strip():
                    self.sink.append(line + b"\n")

    def stop(self):
        self._stop = True


def main():
    p("=" * 72)
    p("一、定位可执行文件（Windows: pi 是 .CMD 包装器）")
    p("=" * 72)
    pi_path = shutil.which("pi")
    p(f"  shutil.which('pi') = {pi_path}")
    if not pi_path:
        p("  ✗ 未找到 pi")
        return 1
    r = subprocess.run([pi_path, "--version"], capture_output=True, timeout=60)
    p(f"  {LEAD} [{pi_path}, '--version'] → rc={r.returncode} stdout={r.stdout!r}")
    p("  ⟹ 结论：.CMD 全路径 + argv 列表可用；**无需 shell=True**")

    p("")
    p("=" * 72)
    p("二、启动 RPC 并做**多轮**握手（不 close stdin，防假绿）")
    p("=" * 72)
    proc = subprocess.Popen([pi_path, "--mode", "rpc", "--no-session"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    out, err = [], []
    ro = LineReader(proc.stdout, out); ro.start()
    re_ = LineReader(proc.stderr, err); re_.start()

    t0 = time.time()
    deadline = time.time() + 10
    while time.time() < deadline and proc.poll() is None and not out:
        time.sleep(0.2)
    if proc.poll() is not None:
        p(f"  ✗ 进程启动即退出 rc={proc.returncode}")
        p(f"    stderr: {b''.join(err)[:400]!r}")
        return 1
    p(f"  进程存活 ✅（{time.time()-t0:.2f}s）")

    def send(obj):
        proc.stdin.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        proc.stdin.flush()

    def wait_for(cmd_id, timeout=15):
        dl = time.time() + timeout
        while time.time() < dl:
            for raw in list(out):
                try:
                    o = json.loads(raw.decode("utf-8"))
                except Exception:
                    continue
                if o.get("id") == cmd_id:
                    return o
            time.sleep(0.1)
        return None

    send({"id": "r1", "type": "get_state"})
    r1 = wait_for("r1")
    p(f"  第1轮 get_state: {'收到 ✅' if r1 else '✗ 超时'}  ({time.time()-t0:.2f}s)")
    if r1:
        p(f"    success={r1.get('success')}  command={r1.get('command')}")
        d = r1.get("data") or {}
        p("    data 字段（**实测，照抄别猜**）:")
        for k in sorted(d.keys()):
            v = d[k]
            vs = json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else repr(v)
            p(f"      {k} = {vs[:70]}")
        if "tools" not in d:
            p("    ⚠️ 注意：**没有 tools 字段**（1.0.2 实测）→ UI 的工具列表不能从这里取")

    out.clear()
    send({"id": "r2", "type": "get_state"})
    r2 = wait_for("r2")
    p("")
    p(f"  第2轮 get_state（stdin 未关闭）: "
      f"{'收到 ✅ 读取器是流式的' if r2 else '✗ 超时 —— 读取器可能阻塞到 EOF'}")
    p("  ⟹ 这一轮是**防假绿**的关键：若这里超时，说明读取器有 read() 类阻塞问题")

    p("")
    p("=" * 72)
    p("三、U+2028 切帧验证（pi 官方 P1）")
    p("=" * 72)
    tricky = "测试\u2028分隔符\u2029与段落符"
    out.clear()
    send({"id": "r3", "type": "prompt", "message": tricky})
    r3 = wait_for("r3", timeout=30)
    if r3:
        disp = (r3.get("data") or {}).get("disposition")
        p("  ✅ 收到响应（说明 U+2028/2029 未导致切帧错乱）")
        p(f"    success={r3.get('success')} disposition={disp!r}")
        p("    ⟹ disposition 只表示**已受理**；结束信号是 agent_settled")
    else:
        p("  ⚠️ 超时（可能是模型未配置/配额问题，**不一定是协议问题**）")
        p(f"     stderr 摘要: {b''.join(err)[:300]!r}")

    p("")
    p("=" * 72)
    p("结论")
    p("=" * 72)
    p("""  1. Windows 上 pi 是 .CMD → 用 shutil.which 的全路径 + argv 列表（无需 shell=True）
  2. 读 stdout 必须 read1(n)，**只按 \\n 切字节**
     —— readline 会把 U+2028/2029 当分隔（错切帧）
     —— read(n) 会阻塞到 EOF（假死/假绿）
  3. 命令带 id，响应回显 id → 按 id 关联，不按顺序
  4. prompt 响应 ≠ 完成；结束信号是 agent_settled
  5. 多轮（不 close stdin）测试是防假绿的必要手段
""")
    try:
        proc.stdin.close()
    except Exception:
        pass
    try:
        proc.kill()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
