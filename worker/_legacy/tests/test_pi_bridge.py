"""``server/pi_bridge`` 协议层单测 —— **不依赖真 pi、不依赖 LLM**。

用假 JSONL 字节流直接喂 ``PiRpcClient``，覆盖任务验收的四条关键测试：

1. **含 U+2028/U+2029 的记录不被错误切帧**（P1，最关键）
2. **乱序响应按 ``id`` 正确关联**（不按响应顺序）
3. **事件映射**：``text_delta`` / ``thinking_delta`` / ``tool_*`` / ``agent_settled``→``settled``
4. **持续读 stdout**（P2：消费者卡住也不阻塞读取；多轮不 close stdin 也能拿到响应）

外加 WS 端点（契约 §7.2）与诚实降级、会话回收/崩溃重启的测试。
"""

from __future__ import annotations

import json
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.pi_bridge.client import (  # noqa: E402
    ByteLineFramer,
    PiCommandError,
    PiProcessExited,
    PiRpcClient,
    PiTimeout,
)
from server.pi_bridge.events import (  # noqa: E402
    BRIDGE_EVENT_TYPES,
    E_LLM,
    E_PI_EXIT,
    E_PI_PROTOCOL,
    E_PI_UNAVAILABLE,
    PiEventMapper,
    extract_text,
    map_pi_event,
    make_error,
)
from server.pi_bridge.launcher import PiCli, PiLauncher  # noqa: E402
from server.pi_bridge.session import (  # noqa: E402
    PiSessionManager,
    validate_session_id,
)

# ---------------------------------------------------------------------------
# 测试替身：假流（假 pi 的基础）
# ---------------------------------------------------------------------------


def frame(obj: dict, *, ensure_ascii: bool = False) -> bytes:
    """把 dict 编成一条 JSONL 记录（默认**不转义**，便于构造裸 U+2028 的入站流）。"""
    return json.dumps(obj, ensure_ascii=ensure_ascii).encode("utf-8") + b"\n"


class FakeIn:
    """假 stdin：记录写出的命令，并可按命令触发自动应答。"""

    def __init__(self) -> None:
        self.commands: list[dict] = []
        self.raw_writes: list[bytes] = []
        self.closed = False
        self._buf = b""
        self.on_command = None

    def write(self, data: bytes) -> int:
        self.raw_writes.append(bytes(data))
        self._buf += data
        while b"\n" in self._buf:
            line, self._buf = self._buf.split(b"\n", 1)
            line = line.rstrip(b"\r")
            if not line:
                continue
            cmd = json.loads(line.decode("utf-8"))
            self.commands.append(cmd)
            if self.on_command is not None:
                self.on_command(cmd)
        return len(data)

    def flush(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True


class FakeOut:
    """假 stdout：``read1`` 语义（有数据立刻返回，没有就阻塞等）。

    ``read`` 也实现了，但会**计数**——测试用它来断言客户端确实走了 ``read1``。
    """

    def __init__(self, chunk_size: int = 65536) -> None:
        self._q: "queue.Queue[bytes]" = queue.Queue()
        self.chunk_size = chunk_size
        self.read1_calls = 0
        self.read_calls = 0

    def feed(self, data: bytes) -> None:
        for i in range(0, len(data), self.chunk_size):
            self._q.put(data[i : i + self.chunk_size])

    def eof(self) -> None:
        self._q.put(b"")

    def close(self) -> None:
        # 注入流没有真进程来关管道 → close 时主动 EOF，让 reader 线程立刻醒
        self._q.put(b"")

    def read1(self, n: int) -> bytes:
        self.read1_calls += 1
        try:
            return self._q.get(timeout=10)[:n]
        except queue.Empty:
            return b""

    def read(self, n: int) -> bytes:
        self.read_calls += 1
        return self.read1(n)


class FakeErr:
    """假 stderr（P3：只作诊断文本）。"""

    def __init__(self) -> None:
        self._q: "queue.Queue[bytes]" = queue.Queue()

    def feed(self, line: str) -> None:
        self._q.put((line + "\n").encode("utf-8"))

    def close(self) -> None:
        self._q.put(b"")

    def readline(self) -> bytes:
        try:
            return self._q.get(timeout=30)
        except queue.Empty:
            return b""


class FakePi:
    """**不启动进程**的假 pi：假流 + 自动应答命令 + 可脚本化事件注入。"""

    def __init__(self, state: dict | None = None, models: list | None = None) -> None:
        self.state = state if state is not None else DEFAULT_STATE
        self.models = models if models is not None else DEFAULT_MODELS
        self.prompt_disposition = "started"
        self.events_on_prompt: list[dict] = []
        self.generations: list[tuple[FakeIn, FakeOut]] = []
        self.requests: list[dict] = []
        #: False → 不自动应答，由测试手动 respond（验证乱序/超时/失败路径）
        self.auto_respond = True
        #: 可选钩子：``fn(cmd) -> bool``，返回 True 表示已处理（不自动应答）
        self.command_override = None
        self._new_generation()

    # ---- 代际（模拟重启：每次建 client 拿到全新管道）----
    def _new_generation(self) -> None:
        self.stdin = FakeIn()
        self.stdout = FakeOut()
        self.stderr = FakeErr()
        self.stdin.on_command = self._on_command
        self.generations.append((self.stdin, self.stdout))

    @property
    def gen(self) -> int:
        return len(self.generations)

    def _on_command(self, cmd: dict) -> None:
        self.requests.append(cmd)
        if self.command_override is not None and self.command_override(cmd):
            return
        if not self.auto_respond:
            return
        ctype = cmd.get("type")
        if ctype == "prompt":
            # ⚠️ 故意**先**发事件再回响应：验证"订阅先于 prompt"（坑 14）
            # 与"prompt 响应 ≠ 完成"（坑 13）。
            for record in self.events_on_prompt:
                self.emit(record)
        data = {
            "get_state": dict(self.state),
            "get_available_models": {"models": self.models},
            "get_messages": {"messages": []},
            "get_session_stats": {"sessionId": "s1", "totalMessages": 0},
            "prompt": {"disposition": self.prompt_disposition},
            "steer": {"disposition": "queued"},
            "follow_up": {"disposition": "queued"},
            "abort": {},
            "new_session": {"cancelled": False},
            "set_model": self.models[0] if self.models else {},
            "bash": {"output": "ok", "exitCode": 0, "cancelled": False, "truncated": False},
        }.get(ctype, {})
        self.respond(cmd.get("id"), ctype, data)

    def respond(self, cmd_id, command, data=None, *, success=True, error=None) -> None:
        rec = {"id": cmd_id, "type": "response", "command": command, "success": success}
        if error is not None:
            rec["error"] = error
        else:
            rec["data"] = data if data is not None else {}
        self.stdout.feed(frame(rec))

    def emit(self, record: dict) -> None:
        self.stdout.feed(frame(record))

    def emit_raw(self, payload: bytes) -> None:
        self.stdout.feed(payload)

    def client_factory(self, **kwargs) -> PiRpcClient:
        self._new_generation()
        accepted = {
            k: v
            for k, v in kwargs.items()
            if k in ("on_stderr", "on_exit", "request_timeout", "settled_timeout")
        }
        self.client_kwargs = kwargs
        return PiRpcClient(
            stdin=self.stdin, stdout=self.stdout, stderr=self.stderr, **accepted
        )


DEFAULT_STATE = {
    "model": {"id": "glm-5.2", "provider": "opencode-go", "contextWindow": 1000000},
    "thinkingLevel": "high",
    "isStreaming": False,
    "sessionId": "01a13a9c-fake",
    "sessionFile": "D:/course-kb/data/chat/2026-10-14T13-29-05-709Z_sess-1.jsonl",
    "messageCount": 0,
    "pendingMessageCount": 0,
}
DEFAULT_MODELS = [
    {"id": "glm-5.2", "provider": "opencode-go", "name": "GLM-5.2"},
    {"id": "minimax-m3", "provider": "opencode-go", "name": "MiniMax-M3"},
]

#: **本机实测**的 403 失败序列（真实 pi 1.0.2 + provider `opencode-go`）。
#: 参考 evidence：agent_start → message_end(stopReason=error) → auto_retry_start ×3 → agent_settled
PI_403_ROUND: list[dict] = [
    {"type": "agent_start"},
    {"type": "turn_start"},
    {"type": "message_start", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}},
    {"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}},
    {
        "type": "message_start",
        "message": {"role": "assistant", "content": [], "model": "glm-5.2", "stopReason": "error"},
    },
    {
        "type": "message_end",
        "message": {
            "role": "assistant",
            "content": [],
            "model": "glm-5.2",
            "provider": "opencode-go",
            "stopReason": "error",
            "errorMessage": "403: An active OpenCode Go subscription is required to use Go models.",
        },
    },
    {"type": "turn_end", "message": {"role": "assistant", "content": []}, "toolResults": []},
    {"type": "agent_end", "messages": [], "willRetry": True},
    {
        "type": "auto_retry_start",
        "attempt": 1,
        "maxAttempts": 3,
        "delayMs": 2000,
        "errorMessage": "403: An active OpenCode Go subscription is required to use Go models.",
    },
    {"type": "agent_start"},
    {"type": "agent_end", "messages": [], "willRetry": True},
    {"type": "auto_retry_start", "attempt": 2, "maxAttempts": 3, "delayMs": 4000,
     "errorMessage": "403: An active OpenCode Go subscription is required to use Go models."},
    {"type": "agent_start"},
    {"type": "agent_end", "messages": [], "willRetry": True},
    {"type": "auto_retry_start", "attempt": 3, "maxAttempts": 3, "delayMs": 8000,
     "errorMessage": "403: An active OpenCode Go subscription is required to use Go models."},
    {
        "type": "auto_retry_end",
        "success": False,
        "attempt": 3,
        "finalError": "403: An active OpenCode Go subscription is required to use Go models.",
    },
    # 实测：正常结束时**没有 aborted 字段**
    {"type": "agent_settled"},
]


def make_launcher(tmp_path: Path, *, help_text: str | None = None, **kwargs) -> PiLauncher:
    """造一个"B 档可用"的注入式 launcher（不会真起进程）。"""
    wrapper = tmp_path / "npm" / "pi.CMD"
    wrapper.parent.mkdir(parents=True, exist_ok=True)
    wrapper.write_text("@echo off\n", encoding="utf-8")
    help_ = help_text if help_text is not None else (
        "--mode <mode>\n--session-dir <dir>\n--session-id <id>\n--no-session\n"
    )

    def fake_run(argv, **kw):
        if "--version" in argv:
            return subprocess.CompletedProcess(argv, 0, stdout=b"1.0.2\n", stderr=b"")
        if "--help" in argv:
            return subprocess.CompletedProcess(argv, 0, stdout=help_.encode(), stderr=b"")
        return subprocess.CompletedProcess(argv, 0, stdout=b"", stderr=b"")

    return PiLauncher(
        project_root=tmp_path,
        pi_repo=tmp_path / "pi",
        which=lambda n: str(wrapper) if n == "pi" else None,
        run=fake_run,
        **kwargs,
    )


def new_client(fake: FakePi | None = None, **kwargs) -> tuple[PiRpcClient, FakePi]:
    fake = fake or FakePi()
    client = PiRpcClient(
        stdin=fake.stdin, stdout=fake.stdout, stderr=fake.stderr, **kwargs
    ).start()
    return client, fake


def wait_for(predicate, timeout: float = 5.0, interval: float = 0.01) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


# ===========================================================================
# 1) P1 切帧 —— 最关键测试
# ===========================================================================


class TestFramingU2028:
    """U+2028/U+2029 在 JSON 字符串里合法，**不是**记录边界（契约 P1）。"""

    def test_u2028_inside_json_string_is_not_a_boundary(self):
        payload = frame({"a": "x\u2028y"})  # 裸 U+2028，UTF-8 = e2 80 a8
        assert b"\xe2\x80\xa8" in payload  # 确认真的是裸字节，不是转义

        framer = ByteLineFramer()
        frames = framer.feed(payload)

        assert len(frames) == 1, "U+2028 被当成了记录边界（P1 回归）"
        assert json.loads(frames[0].decode("utf-8")) == {"a": "x\u2028y"}
        assert framer.pending() == b""

    def test_u2029_inside_json_string_is_not_a_boundary(self):
        payload = frame({"a": "x\u2029y"})
        assert b"\xe2\x80\xa9" in payload

        frames = ByteLineFramer().feed(payload)

        assert len(frames) == 1
        assert json.loads(frames[0].decode("utf-8")) == {"a": "x\u2029y"}

    def test_both_separators_with_other_records(self):
        """一帧里同时含 U+2028/U+2029，且前后还有正常记录。"""
        payload = (
            frame({"i": 1})
            + frame({"text": "第一段\u2028第二段\u2029第三段"})
            + frame({"i": 3})
        )
        frames = ByteLineFramer().feed(payload)

        assert len(frames) == 3
        assert [json.loads(f.decode("utf-8")) for f in frames] == [
            {"i": 1},
            {"text": "第一段\u2028第二段\u2029第三段"},
            {"i": 3},
        ]

    def test_a_line_reader_would_have_split_it(self):
        """反证：行读取器语义（``str.splitlines``）会把同一条记录切成 2 段。

        这保证上面的断言不是"永远为真"的空测试 —— 换成 readline 类读取器就会红。
        """
        payload = frame({"a": "x\u2028y"})
        text = payload.decode("utf-8").rstrip("\n")

        assert len(text.splitlines()) == 2, "splitlines 应当按 U+2028 切（模拟 node readline）"
        assert len(ByteLineFramer().feed(payload)) == 1

    def test_arbitrary_chunk_boundaries_never_corrupt_frames(self):
        """按 1..N 字节任意切分喂入，结果必须与一次性喂入完全一致。"""
        payload = (
            frame({"a": "x\u2028y\u2029z"})
            + frame({"emoji": "🚀 中文 \u2028 混合"})
            + frame({"n": 3})
        )
        expected = [json.loads(f.decode("utf-8")) for f in ByteLineFramer().feed(payload)]
        assert len(expected) == 3

        for step in range(1, 9):
            framer = ByteLineFramer()
            got = []
            for i in range(0, len(payload), step):
                got += framer.feed(payload[i : i + step])
            assert [json.loads(f.decode("utf-8")) for f in got] == expected, f"step={step}"
            assert framer.pending() == b""

    def test_crlf_and_empty_lines(self):
        framer = ByteLineFramer()
        frames = framer.feed(b'{"a":1}\r\n\n{"b":2}\n')

        assert [json.loads(f.decode()) for f in frames] == [{"a": 1}, {"b": 2}]

    def test_partial_frame_stays_buffered(self):
        framer = ByteLineFramer()
        assert framer.feed(b'{"a":12') == []
        assert framer.pending() == b'{"a":12'
        frames = framer.feed(b'3}\n')
        assert [json.loads(f.decode()) for f in frames] == [{"a": 123}]

    def test_client_frames_u2028_record_end_to_end(self):
        """整条链路：含 U+2028 的入站记录 → 事件被正确解析出**一条** delta。"""
        client, fake = new_client()
        events: list[dict] = []
        client.subscribe(events.append)

        fake.emit(
            {
                "type": "message_update",
                "assistantMessageEvent": {"type": "text_delta", "delta": "第一行\u2028第二行"},
            }
        )
        fake.emit({"type": "agent_settled"})

        assert wait_for(lambda: any(e["type"] == "settled" for e in events))
        deltas = [e for e in events if e["type"] == "text_delta"]
        assert len(deltas) == 1
        assert deltas[0]["delta"] == "第一行\u2028第二行"
        client.close()


# ===========================================================================
# 2) 按 id 关联（乱序）
# ===========================================================================


class TestResponseCorrelation:
    def test_responses_correlated_by_id_not_order(self):
        client, fake = new_client()
        fake.auto_respond = False  # 手工控制响应顺序
        p1 = client.send_command("get_state")
        p2 = client.send_command("get_available_models")
        p3 = client.send_command("bash", command="ls")

        ids = [p1.id, p2.id, p3.id]
        assert len(set(ids)) == 3, "命令 id 必须唯一"
        assert ids == ["req-1", "req-2", "req-3"]

        # 故意**倒序**回三条响应
        fake.respond(p3.id, "bash", {"output": "third"})
        fake.respond(p1.id, "get_state", {"sessionId": "first"})
        fake.respond(p2.id, "get_available_models", {"models": [{"id": "second"}]})

        assert client.await_response(p1)["data"] == {"sessionId": "first"}
        assert client.await_response(p2)["data"] == {"models": [{"id": "second"}]}
        assert client.await_response(p3)["data"] == {"output": "third"}
        client.close()

    def test_response_with_unknown_id_is_reported_not_crashing(self):
        client, fake = new_client()
        diags: list[str] = []
        client._on_stderr = diags.append
        errors: list[dict] = []
        client.subscribe(errors.append)

        fake.respond("never-sent-id", "get_state", {"x": 1})
        fake.emit({"type": "agent_settled"})

        assert wait_for(lambda: any(e["type"] == "settled" for e in errors))
        assert client.stats["unmatched_responses"] == 1
        # 未知 id 只是诊断信息，不产生 error 帧（避免噪音刷屏）
        assert not [e for e in errors if e["type"] == "error"]
        client.close()

    def test_response_without_id_is_reported_as_protocol_error(self):
        """rpc.md：JSON 解析失败时 pi 发**没有 id** 的 parse 响应。"""
        client, fake = new_client()
        events: list[dict] = []
        client.subscribe(events.append)

        fake.stdout.feed(
            frame(
                {
                    "type": "response",
                    "command": "parse",
                    "success": False,
                    "error": "Failed to parse command: Unexpected token",
                }
            )
        )

        assert wait_for(lambda: any(e["type"] == "error" for e in events))
        err = [e for e in events if e["type"] == "error"][0]
        assert err["code"] == E_PI_PROTOCOL
        assert "Unexpected token" in err["msg"]
        client.close()

    def test_failed_command_raises_with_error_text(self):
        client, fake = new_client()
        fake.auto_respond = False
        pending = client.send_command("set_model")
        fake.respond(pending.id, "set_model", success=False, error="Model not found: invalid/model")

        with pytest.raises(PiCommandError) as exc:
            client.await_response(pending)
        assert exc.value.command == "set_model"
        assert exc.value.error == "Model not found: invalid/model"
        client.close()

    def test_request_timeout(self):
        client, fake = new_client(request_timeout=0.4)
        fake.auto_respond = False  # 故意不回
        with pytest.raises(PiTimeout):
            client.request("get_state")
        client.close()

    def test_pending_is_failed_when_process_exits(self):
        client, fake = new_client()
        fake.auto_respond = False
        pending = client.send_command("get_state")
        fake.stdout.eof()  # 进程没了

        with pytest.raises(PiProcessExited):
            client.await_response(pending, timeout=5)
        assert client.exited is True
        client.close()


# ===========================================================================
# 3) P2 持续读 stdout
# ===========================================================================


class TestContinuousReading:
    def test_reader_uses_read1_not_read(self):
        """必须走 ``read1``：``read(n)`` 会阻塞到 n 字节或 EOF（本机实测的假死根源）。"""
        client, fake = new_client()
        fake.emit({"type": "agent_settled"})
        assert wait_for(lambda: client.stats["frames"] >= 1)

        assert client.reader_kind == "read1"
        assert fake.stdout.read1_calls >= 1
        assert fake.stdout.read_calls == 0, "客户端不应调用阻塞式 read(n)"
        client.close()

    def test_reader_kind_for_raw_pipe_is_os_read(self, tmp_path):
        """真进程 + ``bufsize=0`` 时 stdout 是 raw FileIO（**没有 read1**）。

        实测：``Popen(bufsize=0).stdout`` → ``FileIO``，``hasattr(read1) == False``。
        所以真实路径必须落到 ``os.read``（raw 读：返回当前可用字节，不等填满）。
        这条断言防止将来有人只写 ``read1`` 而在真进程上退回阻塞式 ``read``。
        """
        script = tmp_path / "silent.py"
        script.write_text(
            "import sys, json, time\n"
            "line = sys.stdin.readline()\n"
            "rec = json.loads(line)\n"
            "sys.stdout.write(json.dumps({'id': rec.get('id'), 'type': 'response',\n"
            "    'command': rec.get('type'), 'success': True, 'data': {}}) + chr(10))\n"
            "sys.stdout.flush()\n"
            "time.sleep(20)\n",
            encoding="utf-8",
        )
        client = PiRpcClient([sys.executable, str(script)], request_timeout=8.0).start()
        try:
            assert client.reader_kind == "os.read"
            t0 = time.monotonic()
            assert client.request_data("get_state") == {}
            assert time.monotonic() - t0 < 5.0  # 不能等子进程 20s 退出
        finally:
            client.close()

    def test_slow_subscriber_does_not_stall_stdout_reading(self):
        """消费者卡死时，reader 线程仍必须把 stdout 排空（P2 的本质）。"""
        client, fake = new_client()
        gate = threading.Event()
        seen: list[dict] = []

        def blocking_subscriber(event: dict) -> None:
            if not seen:
                gate.wait(10)  # 第一个事件就卡住 dispatch 线程
            seen.append(event)

        client.subscribe(blocking_subscriber)
        for i in range(300):
            fake.emit({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": str(i)}})

        # dispatch 线程被卡住，但 reader 必须已经把 300 条全部读完
        assert wait_for(lambda: client.stats["frames"] >= 300, timeout=5), client.stats
        assert len(seen) <= 1, "dispatch 线程本应被卡住"

        gate.set()
        assert wait_for(lambda: len(seen) == 300, timeout=10), len(seen)
        assert [e["delta"] for e in seen][:3] == ["0", "1", "2"]  # 顺序不乱
        client.close()

    def test_multi_round_without_closing_stdin(self, tmp_path):
        """**多轮不 close stdin**：真 OS 管道 + 真子进程。

        若读取器用 ``read(65536)``，第一轮响应会一直等到子进程退出才返回 →
        本测试超时失败。这就是本机实测踩过的坑（12s 0 条记录，close 后一次吐完）。
        """
        child = (
            "import sys, json\n"
            "while True:\n"
            "    line = sys.stdin.readline()\n"
            "    if not line:\n"
            "        break\n"
            "    rec = json.loads(line)\n"
            "    sys.stdout.write(json.dumps({'id': rec.get('id'), 'type': 'response',\n"
            "        'command': rec.get('type'), 'success': True,\n"
            "        'data': {'round': rec.get('type')}}) + '\\n')\n"
            "    sys.stdout.flush()\n"
        )
        script = tmp_path / "echo_pi.py"
        script.write_text(child, encoding="utf-8")

        client = PiRpcClient([sys.executable, str(script)], request_timeout=8.0).start()
        try:
            t0 = time.monotonic()
            first = client.request_data("get_state")
            first_elapsed = time.monotonic() - t0
            second = client.request_data("bash")

            assert first == {"round": "get_state"}
            assert second == {"round": "bash"}
            # stdin 从未关闭；若用阻塞式 read(n)，这里会等到 request_timeout
            assert first_elapsed < 5.0, f"第一轮耗时 {first_elapsed:.2f}s，读取器不是流式的"
            assert client.stats["responses"] == 2
        finally:
            client.close()

    def test_events_arriving_before_prompt_response_are_not_lost(self):
        """坑 14：快速完成的事件可能先于 prompt 响应到达，必须一条不丢。"""
        fake = FakePi()
        fake.events_on_prompt = [
            {"type": "agent_start"},
            {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "快"}},
            {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "完了"}},
            {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "快完了"}]}},
            {"type": "agent_settled"},
        ]
        client, _ = new_client(fake)
        events: list[dict] = []
        client.subscribe(events.append)  # 先订阅

        data, settled = client.submit_and_wait("hi", timeout=5)

        assert data["disposition"] == "started"
        assert settled is True
        assert [e["delta"] for e in events if e["type"] == "text_delta"] == ["快", "完了"]
        assert [e["type"] for e in events] == [
            "text_delta",
            "text_delta",
            "message_end",
            # auto_retry 未出现，message_end 的 stopReason 也不是 error → 无 error 帧
            "settled",
        ]
        client.close()


# ===========================================================================
# 4) P3 stderr 不是协议
# ===========================================================================


class TestStderrIsNotProtocol:
    def test_stderr_lines_never_become_events(self):
        client, fake = new_client()
        events: list[dict] = []
        diags: list[str] = []
        client.subscribe(events.append)
        client._on_stderr = diags.append

        # stderr 里塞一条"看起来像响应/事件"的 JSON —— 绝不能进事件流
        fake.stderr.feed('{"id":"fake","type":"response","command":"get_state","success":true}')
        fake.stderr.feed('{"type":"agent_settled"}')
        fake.stderr.feed("Warning: No project session found with id 'x'; creating a new session")
        assert wait_for(lambda: len(diags) >= 3)

        assert events == [], "stderr 被当成协议解析了（P3 回归）"
        assert client.settled() is False
        assert client.stats["events"] == 0
        lines = client.stderr_lines()
        assert any("Warning: No project session" in line for line in lines)
        client.close()

    def test_stderr_logged_for_diagnostics(self):
        client, fake = new_client()
        fake.stderr.feed("Warning: No project session found with id 'probe-real-run'")
        assert wait_for(lambda: client.stderr_lines())
        assert "probe-real-run" in client.stderr_lines()[0]
        client.close()


# ===========================================================================
# 事件映射（契约 §7.3）
# ===========================================================================


class TestEventMapping:
    def test_text_delta(self):
        assert map_pi_event(
            {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "聚簇"}}
        ) == [{"type": "text_delta", "delta": "聚簇"}]

    def test_thinking_delta(self):
        assert map_pi_event(
            {"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "delta": "先确认…"}}
        ) == [{"type": "thinking_delta", "delta": "先确认…"}]

    def test_tool_start(self):
        assert map_pi_event(
            {
                "type": "tool_execution_start",
                "toolCallId": "call_1",
                "toolName": "read",
                "args": {"path": "docs/AGENTS.md"},
            }
        ) == [{"type": "tool_start", "id": "call_1", "tool": "read", "args": {"path": "docs/AGENTS.md"}}]

    def test_tool_update_extracts_partial_text(self):
        event = map_pi_event(
            {
                "type": "tool_execution_update",
                "toolCallId": "call_1",
                "toolName": "bash",
                "partialResult": {"content": [{"type": "text", "text": "partial output"}], "details": {}},
            }
        )
        assert event[0]["type"] == "tool_update"
        assert event[0]["id"] == "call_1"
        assert event[0]["partial"] == "partial output"

    def test_tool_end_has_ok_and_duration(self):
        event = map_pi_event(
            {
                "type": "tool_execution_end",
                "toolCallId": "call_1",
                "toolName": "bash",
                "isError": False,
                "durationMs": 120,
                "result": {"content": [{"type": "text", "text": "done"}]},
            }
        )
        assert event == [
            {
                "type": "tool_end",
                "id": "call_1",
                "ok": True,
                "duration_ms": 120,
                "tool": "bash",
                "result_text": "done",
            }
        ]

    def test_tool_end_marks_error(self):
        event = map_pi_event(
            {"type": "tool_execution_end", "toolCallId": "c", "toolName": "bash", "isError": True}
        )
        assert event[0]["ok"] is False

    def test_agent_settled_maps_to_settled(self):
        assert map_pi_event({"type": "agent_settled"}) == [{"type": "settled", "aborted": False}]

    def test_agent_settled_without_aborted_field(self):
        """**实测**：pi 1.0.2 正常结束时是 ``{"type":"agent_settled"}``，没有 aborted 字段。"""
        record = {"type": "agent_settled"}
        assert "aborted" not in record
        assert map_pi_event(record)[0]["aborted"] is False  # 不许 KeyError / undefined

    def test_agent_settled_aborted_true(self):
        assert map_pi_event({"type": "agent_settled", "aborted": True}) == [
            {"type": "settled", "aborted": True}
        ]

    def test_message_end_passthrough_untouched(self):
        """实测：system 消息的 content 是空串，真提示词在 sections 里 → 必须原样透传。"""
        message = {
            "role": "system",
            "content": "",
            "sections": {"preamble": "You are an expert coding assistant", "tools": "<tools>…"},
        }
        event = map_pi_event({"type": "message_end", "message": message})
        assert event == [{"type": "message_end", "message": message}]
        assert event[0]["message"]["sections"]["preamble"].startswith("You are an expert")

    def test_agent_end_is_not_forwarded(self):
        """契约 §7.3：agent_end 不转发（否则重试场景 UI 会提前置空闲 3 次）。"""
        assert map_pi_event({"type": "agent_end", "messages": [], "willRetry": True}) == []

    def test_unmapped_and_unknown_events_are_dropped(self):
        for record in (
            {"type": "turn_start"},
            {"type": "turn_end", "message": {}},
            {"type": "message_start", "message": {}},
            {"type": "queue_update", "steering": [], "followUp": []},
            {"type": "entry_appended", "entry": {}},
            {"type": "compaction_start", "reason": "manual"},
            {"type": "brand_new_event_from_future_pi", "foo": 1},
            {},
            {"no_type": 1},
        ):
            assert map_pi_event(record) == [], record

    def test_non_text_assistant_message_events_are_dropped(self):
        """只有 text_delta / thinking_delta 直通；toolcall_delta 等不在此列（§7.3）。"""
        for sub in (
            {"type": "text_start", "contentIndex": 0},
            {"type": "text_end", "contentIndex": 0, "content": "done"},
            {"type": "toolcall_start", "contentIndex": 1, "id": "c1", "toolName": "read"},
            {"type": "toolcall_delta", "contentIndex": 1, "delta": "{}"},
            {"type": "toolcall_end", "contentIndex": 1, "toolCall": {}},
            {"type": "thinking_start", "contentIndex": 2},
            {"type": "done", "reason": "stop"},
        ):
            assert map_pi_event({"type": "message_update", "assistantMessageEvent": sub}) == []

    def test_empty_delta_is_dropped(self):
        assert map_pi_event(
            {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": ""}}
        ) == []

    def test_all_emitted_types_are_in_contract_set(self):
        """桥只发 §7.2 的 9 种帧，绝不发明新帧类型。"""
        records = [
            {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "a"}},
            {"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "delta": "b"}},
            {"type": "tool_execution_start", "toolCallId": "c", "toolName": "t"},
            {"type": "tool_execution_update", "toolCallId": "c", "partialResult": {"content": []}},
            {"type": "tool_execution_end", "toolCallId": "c", "isError": False},
            {"type": "message_end", "message": {}},
            {"type": "agent_settled"},
        ]
        emitted = {e["type"] for r in records for e in map_pi_event(r)}
        emitted |= {make_error(E_PI_EXIT, "x")["type"]}
        assert emitted <= BRIDGE_EVENT_TYPES
        assert emitted == {
            "text_delta",
            "thinking_delta",
            "tool_start",
            "tool_update",
            "tool_end",
            "message_end",
            "settled",
            "error",
        }

    def test_extract_text_fallbacks(self):
        assert extract_text({"content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]}) == "ab"
        assert extract_text({"content": [{"type": "image", "data": "xx"}]}) == '{"type": "image", "data": "xx"}'
        assert extract_text({"output": "raw"}) == "raw"
        assert extract_text("plain") == "plain"
        assert extract_text(None) == ""

    def test_bridge_events_are_json_serializable(self):
        """WS 要 ``send_json``：任何事件都必须能 JSON 序列化。"""
        for record in PI_403_ROUND:
            for event in map_pi_event(record):
                assert json.loads(json.dumps(event, ensure_ascii=False)) == event


class TestLlmFailureVisibility:
    """**真实 403 序列**必须让用户看懂"桥是好的，是模型侧失败"。"""

    def test_real_403_sequence_yields_exactly_one_e_llm_frame(self):
        mapper = PiEventMapper()
        events = [e for record in PI_403_ROUND for e in mapper.map(record)]

        errors = [e for e in events if e["type"] == "error"]
        assert len(errors) == 1, f"重试 3 次只应报 1 条错误，实际 {len(errors)} 条"
        err = errors[0]
        assert err["code"] == E_LLM  # 契约 §8 原有码：LLM 调用失败
        assert "403" in err["msg"] and "OpenCode Go subscription" in err["msg"]
        assert "模型/凭据侧" in err["hint"]  # 明确告诉用户"不是桥坏了"
        assert "3" in err["detail"]

        # 逐次重试不刷屏：pi 的原始字段不许泄漏进桥事件（只允许出现在 detail 文本里）
        raw_pi_keys = {"delayMs", "maxAttempts", "attempt", "errorMessage", "finalError", "willRetry"}
        assert not [e for e in events if raw_pi_keys & set(e)]
        assert {e["type"] for e in events} <= BRIDGE_EVENT_TYPES
        # settled 仍然只出现一次（一轮结束信号）
        assert len([e for e in events if e["type"] == "settled"]) == 1
        # agent_end 一条都没转发
        assert len([e for e in events if e["type"] == "message_end"]) == 2  # user + assistant

    def test_message_end_error_without_autoretry_reports_e_llm_at_round_end(self):
        """自动重试被关掉时，错误在 ``agent_settled`` 之前补报 —— 失败一定有解释。"""
        mapper = PiEventMapper()
        events = mapper.map(
            {
                "type": "message_end",
                "message": {"role": "assistant", "content": [], "stopReason": "error",
                            "errorMessage": "529 overloaded"},
            }
        )
        # 先暂存（因为实测里紧接着常常就是 auto_retry_start，立刻报会重复）
        assert [e["type"] for e in events] == ["message_end"]
        assert mapper.pending_error == "529 overloaded"

        tail = mapper.map({"type": "agent_settled"})
        assert [e["type"] for e in tail] == ["error", "settled"]
        assert tail[0]["code"] == E_LLM
        assert "529 overloaded" in tail[0]["msg"]
        assert mapper.pending_error is None

    def test_successful_autoretry_does_not_report_error(self):
        mapper = PiEventMapper()
        events: list[dict] = []
        events += mapper.map({"type": "auto_retry_start", "attempt": 1, "maxAttempts": 3,
                              "errorMessage": "529 overloaded"})
        events += mapper.map({"type": "auto_retry_end", "success": True, "attempt": 2})
        events += mapper.map({"type": "message_update",
                              "assistantMessageEvent": {"type": "text_delta", "delta": "答出来了"}})

        assert [e["type"] for e in events] == ["text_delta"]
        assert mapper.retrying is False

    def test_client_surfaces_llm_failure_end_to_end(self):
        """把真实失败序列喂进 client，用户应收到 error(E_LLM) + settled。"""
        client, fake = new_client()
        events: list[dict] = []
        client.subscribe(events.append)
        for record in PI_403_ROUND:
            fake.emit(record)

        assert wait_for(lambda: any(e["type"] == "settled" for e in events))
        errors = [e for e in events if e["type"] == "error"]
        assert [e["code"] for e in errors] == [E_LLM]
        assert client.settled() is True
        client.close()

    def test_real_abort_path_reports_actual_attempt_count(self):
        """**本机实测**的 abort 路径：pi 用 ``auto_retry_end(finalError="Retry cancelled")``
        取消重试，且 ``agent_settled`` **不带 aborted**。

        原实现的两处错：①attempts 取了计划值 3（其实只试了 1 次）；
        ②hint 说"已自动重试 3 次"，与"用户中断"的事实矛盾。
        """
        records = [
            {"type": "agent_start"},
            {"type": "auto_retry_start", "attempt": 1, "maxAttempts": 3, "delayMs": 2000,
             "errorMessage": "403: subscription required"},
            {"type": "auto_retry_end", "success": False, "finalError": "Retry cancelled"},
            {"type": "agent_settled"},
        ]
        mapper = PiEventMapper()
        events = [e for record in records for e in mapper.map(record)]

        errors = [e for e in events if e["type"] == "error"]
        assert len(errors) == 1
        assert errors[0]["code"] == E_LLM
        assert "Retry cancelled" in errors[0]["msg"]
        assert "attempts=1" in errors[0]["detail"], errors[0]["detail"]  # 不是 3
        assert "中断" in errors[0]["hint"]
        assert [e["type"] for e in events][-1] == "settled"
        assert events[-1]["aborted"] is False  # 映射层只能如实转；补标记在 WS 层（见下）


# ===========================================================================
# 畸形输入 / 韧性
# ===========================================================================


class TestMalformedInput:
    def test_malformed_json_reports_error_and_keeps_streaming(self):
        client, fake = new_client()
        events: list[dict] = []
        client.subscribe(events.append)

        fake.emit_raw(b'{"type":"message_update", broken\n')  # 坏帧
        fake.emit({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "还活着"}})
        fake.emit({"type": "agent_settled"})

        assert wait_for(lambda: any(e["type"] == "settled" for e in events))
        errors = [e for e in events if e["type"] == "error"]
        assert errors[0]["code"] == E_PI_PROTOCOL
        # 坏帧之后的记录必须照常处理（不能一坏就停）
        assert [e["delta"] for e in events if e["type"] == "text_delta"] == ["还活着"]
        assert client.stats["malformed"] == 1
        client.close()

    def test_non_object_json_record_is_reported(self):
        client, fake = new_client()
        events: list[dict] = []
        client.subscribe(events.append)
        fake.emit_raw(b'[1,2,3]\n')

        assert wait_for(lambda: any(e["type"] == "error" for e in events))
        assert events[0]["code"] == E_PI_PROTOCOL
        client.close()

    def test_subscriber_exception_does_not_kill_dispatch(self):
        client, fake = new_client()
        good: list[dict] = []

        def bad(_event: dict) -> None:
            raise RuntimeError("订阅者坏了")

        client.subscribe(bad)
        client.subscribe(good.append)
        fake.emit({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "x"}})
        fake.emit({"type": "agent_settled"})

        assert wait_for(lambda: any(e["type"] == "settled" for e in good))
        assert client.stats["subscriber_errors"] >= 1
        client.close()

    def test_write_to_closed_pi_raises_process_exited(self):
        client, fake = new_client()
        fake.stdout.eof()
        assert wait_for(lambda: client.exited)
        with pytest.raises(PiProcessExited):
            client.request("get_state")
        client.close()

    def test_commands_escape_u2028_outbound(self):
        """出站方向主动消除风险：U+2028 一律转义，我方字节里不出现裸分隔符。"""
        client, fake = new_client()
        client.send_command("prompt", message="前面\u2028后面\u2029结尾")

        assert fake.stdin.raw_writes, "命令没写出去"
        raw = fake.stdin.raw_writes[-1]
        assert b"\xe2\x80\xa8" not in raw and b"\xe2\x80\xa9" not in raw
        assert b"\\u2028" in raw and b"\\u2029" in raw
        # 语义不变：pi 侧解析回来还是原字符
        assert fake.stdin.commands[-1]["message"] == "前面\u2028后面\u2029结尾"
        client.close()


# ===========================================================================
# 会话管理
# ===========================================================================


class TestSessionManager:
    def _manager(self, tmp_path, fake: FakePi, **kwargs) -> PiSessionManager:
        return PiSessionManager(
            make_launcher(tmp_path),
            session_dir=tmp_path / "data" / "chat",
            client_factory=fake.client_factory,
            verify_deep=False,
            record_ready_timeout=5.0,
            **kwargs,
        )

    def test_session_id_validation_rejects_traversal(self):
        for bad in ("../etc/passwd", "a/b", "a b", "", "x" * 65, "会话", "a\\b", "a:b"):
            with pytest.raises(ValueError):
                validate_session_id(bad)
        assert validate_session_id("sess-1_ok.2") == "sess-1_ok.2"

    def test_create_builds_native_persistence_argv(self, tmp_path):
        fake = FakePi()
        manager = self._manager(tmp_path, fake)
        session = manager.create("sess-1")

        argv = fake.client_kwargs["argv"]
        assert argv[:3] == [str(tmp_path / "npm" / "pi.CMD"), "--mode", "rpc"]
        assert "--session-dir" in argv and "--session-id" in argv and "--name" in argv
        assert argv[argv.index("--session-id") + 1] == "sess-1"
        assert "--no-session" not in argv
        assert session.persistence == "native"
        assert session.ready["persistence"] == "native"
        assert session.ready["session_file"].endswith(".jsonl")
        assert session.ready["model"] == "glm-5.2"
        assert session.ready["tier"] == "B"
        assert session.ready["version"] == "1.0.2"
        # 桥侧 session_id 与 pi 自己的 sessionId 是两个层级，别混用
        assert session.ready["session_id"] == "sess-1"
        assert session.ready["pi_session_id"] == "01a13a9c-fake"
        manager.close_all()

    def test_persistence_falls_back_to_no_session_and_says_so(self, tmp_path):
        """CLI 不支持 --session-id/--session-dir → 自动回落，**且如实说明**（Lead 裁定）。"""
        fake = FakePi()
        manager = PiSessionManager(
            make_launcher(tmp_path, help_text="--mode <mode>\n--print\n"),
            session_dir=tmp_path / "data" / "chat",
            client_factory=fake.client_factory,
            verify_deep=False,
        )
        session = manager.create("sess-2")

        argv = fake.client_kwargs["argv"]
        assert "--no-session" in argv
        assert "--session-id" not in argv
        assert session.persistence == "ephemeral"
        assert session.ready["persistence"] == "ephemeral"
        assert "回落" in session.ready["persistence_reason"]
        manager.close_all()

    def test_persist_false_uses_no_session(self, tmp_path):
        fake = FakePi()
        manager = self._manager(tmp_path, fake, persist=False)
        session = manager.create("sess-3")
        assert "--no-session" in fake.client_kwargs["argv"]
        assert session.persistence == "ephemeral"
        manager.close_all()

    def test_tools_source_is_honest(self, tmp_path):
        """pi 1.0.2 的 get_state 没有 tools → 不许编造。"""
        fake = FakePi()
        manager = self._manager(tmp_path, fake)
        session = manager.create("sess-4")
        assert session.ready["tools"] == []
        assert session.ready["tools_source"] == "none"

        fake2 = FakePi()
        manager2 = self._manager(tmp_path, fake2, tools=["read", "grep"])
        session2 = manager2.create("sess-5")
        assert session2.ready["tools"] == ["read", "grep"]
        assert session2.ready["tools_source"] == "argv"
        assert "--tools" in fake2.client_kwargs["argv"]
        manager.close_all()
        manager2.close_all()

    def test_get_or_create_reuses_live_session(self, tmp_path):
        fake = FakePi()
        manager = self._manager(tmp_path, fake)
        first = manager.create("sess-6")
        second = manager.get_or_create("sess-6")
        assert first is second
        assert fake.gen == 2  # 只起了 1 个真 client（gen 1 是构造时的那一份）
        manager.close_all()

    def test_idle_reaping_closes_process(self, tmp_path):
        fake = FakePi()
        clock = [1000.0]
        manager = self._manager(tmp_path, fake, idle_ttl=1800.0, clock=lambda: clock[0])
        session = manager.create("sess-7")
        assert manager.reap_idle() == []  # 刚建，不该回收

        clock[0] += 1800.1
        assert manager.reap_idle() == ["sess-7"]
        assert manager.get("sess-7") is None
        assert fake.stdin.closed is True, "回收必须真的关掉 pi（stdin.close → 优雅停机）"
        assert session.alive() is False

    def test_no_reap_while_subscriber_attached(self, tmp_path):
        fake = FakePi()
        clock = [1000.0]
        manager = self._manager(tmp_path, fake, idle_ttl=1800.0, clock=lambda: clock[0])
        session = manager.create("sess-8")
        unsubscribe = session.subscribe(lambda _e: None)  # 模拟页面还开着

        clock[0] += 99999
        assert manager.reap_idle() == []
        assert manager.get("sess-8") is not None

        unsubscribe()
        assert manager.reap_idle() == ["sess-8"]
        manager.close_all()

    def test_crash_restarts_once_then_disables(self, tmp_path):
        """F7 验收：崩溃自动重启一次，再失败则禁用并说明。"""
        fake = FakePi()
        manager = self._manager(tmp_path, fake, max_restarts=1)
        session = manager.create("sess-9")
        events: list[dict] = []
        session.subscribe(events.append)

        # 第一次崩溃：stdout EOF → on_exit → 自动重启
        fake.stdout.eof()
        assert wait_for(lambda: fake.gen == 3, timeout=10), f"未重启：gen={fake.gen}"
        assert session.restarts == 1
        assert session.disabled is False
        assert session.alive() is True
        # 重启后必须重发 ready（restarted=True），UI 才知道连接恢复
        assert wait_for(lambda: any(e.get("type") == "ready" and e.get("restarted") for e in events))
        assert session.ready["restarted"] is True

        # 第二次崩溃：重启次数用尽 → 禁用
        fake.stdout.eof()
        assert wait_for(lambda: session.disabled, timeout=10)
        assert session.alive() is False
        assert "自动重启次数用尽" in session.disabled_reason
        assert [e["code"] for e in events if e["type"] == "error"].count(E_PI_UNAVAILABLE) >= 1
        manager.close_all()

    def test_restart_keeps_session_object_identity(self, tmp_path):
        """重启不能换掉 PiSession 对象 —— WS 端点持有它，换了就会一直用死掉的 client。"""
        fake = FakePi()
        manager = self._manager(tmp_path, fake, max_restarts=1)
        session = manager.create("sess-10")
        original_id = id(session)
        old_client = session.client

        fake.stdout.eof()
        assert wait_for(lambda: fake.gen == 3, timeout=10)

        assert id(manager.get("sess-10")) == original_id
        assert session.client is not old_client
        assert session.client.alive() is True
        # 重启后命令还能正常走（证明端点持有的对象仍然可用）
        assert session.client.request_data("get_state")["sessionId"] == "01a13a9c-fake"
        manager.close_all()

    def test_session_disabled_when_pi_unavailable(self, tmp_path):
        fake = FakePi()
        launcher = PiLauncher(
            project_root=tmp_path, pi_repo=tmp_path / "pi", which=lambda n: None
        )
        manager = PiSessionManager(
            launcher, client_factory=fake.client_factory, verify_deep=False
        )
        from server.pi_bridge.client import PiNotAvailable

        with pytest.raises(PiNotAvailable) as exc:
            manager.create("sess-11")
        assert "pi 不可用" in str(exc.value)
        assert fake.gen == 1  # 一次进程都没起

    def test_stats_reports_observability(self, tmp_path):
        fake = FakePi()
        manager = self._manager(tmp_path, fake)
        manager.create("sess-12")
        stats = manager.stats()
        assert stats["sessions"] == 1
        assert stats["alive"] == 1
        assert stats["detail"][0]["id"] == "sess-12"
        assert stats["detail"][0]["persistence"] == "native"
        assert stats["detail"][0]["session_file"].endswith(".jsonl")
        manager.close_all()


# ===========================================================================
# WebSocket 端点（契约 §7.2）
# ===========================================================================


class TestWebSocketEndpoint:
    def _app(self, tmp_path, fake: FakePi | None = None, *, available: bool = True, **manager_kw):
        from fastapi import FastAPI

        from server.pi_bridge import ws as ws_mod

        fake = fake or FakePi()
        launcher = (
            make_launcher(tmp_path)
            if available
            else PiLauncher(project_root=tmp_path, pi_repo=tmp_path / "pi", which=lambda n: None)
        )
        manager = PiSessionManager(
            launcher,
            session_dir=tmp_path / "data" / "chat",
            client_factory=fake.client_factory,
            verify_deep=False,
            record_ready_timeout=5.0,
            **manager_kw,
        )
        ws_mod.configure(manager=manager, launcher=launcher)
        app = FastAPI()
        assert ws_mod.mount(app) is True
        assert ws_mod.mount(app) is True  # 幂等
        assert ws_mod.app_routes_ok(app) is True
        return app, manager, fake, ws_mod

    def test_mount_registers_routes_idempotently(self, tmp_path):
        app, manager, _fake, ws_mod = self._app(tmp_path)
        paths = [getattr(r, "path", None) for r in app.routes]
        assert ws_mod.CHAT_PATH in paths
        assert ws_mod.CAPABILITIES_PATH in paths
        assert paths.count(ws_mod.CAPABILITIES_PATH) == 1  # 没被注册两次
        manager.close_all()

    def test_capabilities_http_endpoint_is_real_call_and_honest(self, tmp_path):
        from fastapi.testclient import TestClient

        app, manager, _fake, _ws = self._app(tmp_path)
        with TestClient(app) as client:
            response = client.get("/api/v1/pi/capabilities")
            assert response.status_code == 200
            payload = response.json()
        assert payload["available"] is True  # 真的探测了注入的 launcher
        assert payload["version"] == "1.0.2"
        assert payload["mode"] == "global"
        assert payload["tier"] == "B"
        assert payload["session_flags"] is True
        manager.close_all()

    def test_capabilities_http_reports_unavailable_honestly(self, tmp_path):
        from fastapi.testclient import TestClient

        app, manager, _fake, _ws = self._app(tmp_path, available=False)
        with TestClient(app) as client:
            payload = client.get("/api/v1/pi/capabilities").json()
        assert payload["available"] is False
        assert payload["mode"] == "none"
        assert payload["reason"].strip()
        assert payload["version"] is None
        manager.close_all()

    def test_ws_ready_then_prompt_streams_and_settles(self, tmp_path):
        """一条完整链路：ready → prompt → text_delta ×2 → tool_* → message_end → settled。"""
        from fastapi.testclient import TestClient

        fake = FakePi()
        fake.events_on_prompt = [
            {"type": "agent_start"},
            {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "聚簇"}},
            {"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "delta": "先确认"}},
            {
                "type": "tool_execution_start",
                "toolCallId": "call_1",
                "toolName": "read",
                "args": {"path": "docs/AGENTS.md"},
            },
            {
                "type": "tool_execution_update",
                "toolCallId": "call_1",
                "toolName": "read",
                "partialResult": {"content": [{"type": "text", "text": "读到一半"}]},
            },
            {
                "type": "tool_execution_end",
                "toolCallId": "call_1",
                "toolName": "read",
                "isError": False,
                "durationMs": 120,
                "result": {"content": [{"type": "text", "text": "文件内容"}]},
            },
            {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "索引"}},
            {
                "type": "message_end",
                "message": {"role": "assistant", "content": [{"type": "text", "text": "聚簇索引"}]},
            },
            {"type": "agent_end", "messages": [], "willRetry": False},
            {"type": "agent_settled"},
        ]
        app, manager, _fake, _ws = self._app(tmp_path, fake)

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/chat/ws-sess-1") as websocket:
                ready = websocket.receive_json()
                assert ready["type"] == "ready"
                assert ready["session_id"] == "ws-sess-1"
                assert ready["model"] == "glm-5.2"
                assert ready["persistence"] == "native"
                assert ready["tools"] == []
                assert ready["tools_source"] == "none"
                assert ready["tier"] == "B"

                websocket.send_json({"type": "prompt", "message": "解释一下聚簇索引"})

                frames = [websocket.receive_json() for _ in range(8)]
        assert [f["type"] for f in frames] == [
            "text_delta",
            "thinking_delta",
            "tool_start",
            "tool_update",
            "tool_end",
            "text_delta",
            "message_end",
            "settled",
        ]
        assert frames[0]["delta"] == "聚簇"
        assert frames[5]["delta"] == "索引"
        assert frames[2]["tool"] == "read" and frames[2]["args"] == {"path": "docs/AGENTS.md"}
        assert frames[3]["partial"] == "读到一半"
        assert frames[4]["ok"] is True and frames[4]["duration_ms"] == 120
        assert frames[7]["aborted"] is False
        assert "agent_start" not in [f["type"] for f in frames]
        manager.close_all()

    def test_ws_prompt_disposition_handled_gets_synthetic_settled(self, tmp_path):
        """rpc.md：``disposition=handled`` 时不会有 agent_settled，UI 不能永远卡在运行中。"""
        from fastapi.testclient import TestClient

        fake = FakePi()
        fake.prompt_disposition = "handled"
        app, manager, _fake, _ws = self._app(tmp_path, fake)

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/chat/ws-sess-2") as websocket:
                assert websocket.receive_json()["type"] == "ready"
                websocket.send_json({"type": "prompt", "message": "/some-command"})
                settled = websocket.receive_json()
        assert settled["type"] == "settled"
        assert settled["synthetic"] is True
        assert settled["disposition"] == "handled"
        manager.close_all()

    def test_ws_unavailable_reports_reason_and_closes(self, tmp_path):
        """pi 不可用：**如实**报原因并关闭，不假装能用。"""
        from fastapi.testclient import TestClient
        from starlette.websockets import WebSocketDisconnect

        app, manager, _fake, _ws = self._app(tmp_path, available=False)

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/chat/ws-sess-3") as websocket:
                error = websocket.receive_json()
                assert error["type"] == "error"
                assert error["code"] == E_PI_UNAVAILABLE
                assert "pi 不可用" in error["msg"]
                assert error["hint"]
                with pytest.raises(WebSocketDisconnect) as exc:
                    websocket.receive_json()
                assert exc.value.code == 1013
        manager.close_all()

    def test_ws_invalid_session_id_rejected(self, tmp_path):
        from fastapi.testclient import TestClient
        from starlette.websockets import WebSocketDisconnect

        app, manager, _fake, _ws = self._app(tmp_path)

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/chat/bad$id") as websocket:
                error = websocket.receive_json()
                assert error["code"] == "E_PI_SESSION_ID"
                with pytest.raises(WebSocketDisconnect) as exc:
                    websocket.receive_json()
                assert exc.value.code == 1008
        manager.close_all()

    def test_ws_steer_abort_and_set_model(self, tmp_path):
        from fastapi.testclient import TestClient

        fake = FakePi()
        app, manager, _fake, _ws = self._app(tmp_path, fake)

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/chat/ws-sess-4") as websocket:
                assert websocket.receive_json()["type"] == "ready"

                websocket.send_json({"type": "prompt", "message": "问题", "steer": True})
                fake.emit({"type": "agent_settled"})
                assert websocket.receive_json()["type"] == "settled"

                websocket.send_json({"type": "set_model", "model": "opencode-go/minimax-m3"})
                ready = websocket.receive_json()
                assert ready["type"] == "ready"

                websocket.send_json({"type": "new_session"})
                assert websocket.receive_json()["type"] == "ready"

                websocket.send_json({"type": "abort"})
                fake.emit({"type": "agent_settled", "aborted": True})
                settled = websocket.receive_json()
                assert settled["type"] == "settled" and settled["aborted"] is True

        types = [c["type"] for c in fake.requests]
        assert types.count("prompt") == 1
        assert "set_model" in types and "new_session" in types and "abort" in types
        # steer=True 的 prompt 仍走 prompt 命令（带 streamingBehavior），不是 steer 命令
        prompt_cmd = [c for c in fake.requests if c["type"] == "prompt"][0]
        assert prompt_cmd["message"] == "问题"
        manager.close_all()

    def test_ws_marks_settled_aborted_when_user_aborted(self, tmp_path):
        """**实测差距**：pi 在 abort 取消重试的路径下 ``agent_settled`` 不带 aborted。

        用户点了"停止"、进度也确实停了，UI 却不会显示"已中断"。
        桥侧知道是我们发的 abort，所以补标记（仅当 pi 没标时）。
        """
        from fastapi.testclient import TestClient

        fake = FakePi()
        app, manager, _fake, _ws = self._app(tmp_path, fake)

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/chat/ws-abort-1") as websocket:
                assert websocket.receive_json()["type"] == "ready"
                websocket.send_json({"type": "prompt", "message": "写一篇长文"})
                fake.emit({"type": "message_update",
                           "assistantMessageEvent": {"type": "text_delta", "delta": "开"}})
                assert websocket.receive_json()["type"] == "text_delta"

                websocket.send_json({"type": "abort"})
                # 确定性：等 abort 真的到达 pi（说明服务端已处理该消息、记账已置位）。
                # 不加这步的话，"settled 先于 abort 被处理"是测试自己造出来的竞态，
                # 真实场景里用户点停止必然在 pi 结束之前（有网络往返）。
                assert wait_for(lambda: any(c["type"] == "abort" for c in fake.requests), 5)
                # pi 实测：abort 之后是**没有 aborted 字段**的 agent_settled
                fake.emit({"type": "agent_settled"})
                settled = websocket.receive_json()

        assert settled["type"] == "settled"
        assert settled["aborted"] is True
        assert settled["abort_source"] == "client"
        manager.close_all()

    def test_ws_does_not_fake_aborted_without_abort_request(self, tmp_path):
        """没点停止就不许标"已中断"（补标记只在我们确实发过 abort 时生效）。"""
        from fastapi.testclient import TestClient

        fake = FakePi()
        app, manager, _fake, _ws = self._app(tmp_path, fake)

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/chat/ws-abort-2") as websocket:
                assert websocket.receive_json()["type"] == "ready"
                websocket.send_json({"type": "prompt", "message": "问题"})
                fake.emit({"type": "agent_settled"})
                settled = websocket.receive_json()
        assert settled["aborted"] is False
        assert "abort_source" not in settled
        manager.close_all()

    def test_ws_abort_flag_cleared_on_next_prompt(self, tmp_path):
        """上一轮的 abort 记账不能污染下一轮。"""
        from fastapi.testclient import TestClient

        fake = FakePi()
        app, manager, _fake, _ws = self._app(tmp_path, fake)

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/chat/ws-abort-3") as websocket:
                assert websocket.receive_json()["type"] == "ready"
                websocket.send_json({"type": "prompt", "message": "第一轮"})
                websocket.send_json({"type": "abort"})
                assert wait_for(lambda: any(c["type"] == "abort" for c in fake.requests), 5)
                fake.emit({"type": "agent_settled"})
                assert websocket.receive_json()["aborted"] is True

                websocket.send_json({"type": "prompt", "message": "第二轮"})
                assert wait_for(lambda: len([c for c in fake.requests if c["type"] == "prompt"]) == 2, 5)
                fake.emit({"type": "agent_settled"})
                second = websocket.receive_json()
        assert second["aborted"] is False
        assert "abort_source" not in second
        manager.close_all()

    def test_ws_failed_command_reports_error_frame(self, tmp_path):
        from fastapi.testclient import TestClient

        fake = FakePi()
        app, manager, _fake, _ws = self._app(tmp_path, fake)

        def fail_set_model(cmd: dict) -> bool:
            if cmd.get("type") == "set_model":
                fake.respond(cmd["id"], "set_model", success=False, error="Model not found: bad")
                return True
            return False

        fake.command_override = fail_set_model

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/chat/ws-sess-5") as websocket:
                assert websocket.receive_json()["type"] == "ready"
                websocket.send_json({"type": "set_model", "model": "bad"})
                error = websocket.receive_json()
        assert error["type"] == "error"
        assert error["code"] == "E_PI_CMD"
        assert "Model not found: bad" in error["msg"]
        manager.close_all()

    def test_ws_unknown_and_malformed_client_messages(self, tmp_path):
        from fastapi.testclient import TestClient

        fake = FakePi()
        app, manager, _fake, _ws = self._app(tmp_path, fake)

        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/chat/ws-sess-6") as websocket:
                assert websocket.receive_json()["type"] == "ready"

                websocket.send_text("not json at all")  # 静默忽略
                websocket.send_json({"type": "unknown_type"})
                error = websocket.receive_json()
                assert error["code"] == "E_PI_CMD"

                websocket.send_json({"type": "prompt"})  # 缺 message
                error2 = websocket.receive_json()
                assert error2["code"] == "E_PI_CMD"
                assert "message" in error2["msg"]
        manager.close_all()

    def test_ws_shares_one_pi_process_across_reconnects(self, tmp_path):
        """同一 session_id 重连复用同一 pi 进程（契约 §7.4）。"""
        from fastapi.testclient import TestClient

        fake = FakePi()
        app, manager, _fake, _ws = self._app(tmp_path, fake)

        with TestClient(app) as client:
            for _ in range(3):
                with client.websocket_connect("/api/v1/chat/ws-sess-7") as websocket:
                    assert websocket.receive_json()["session_id"] == "ws-sess-7"

        assert fake.gen == 2, f"重连不该重启 pi 进程（实际起了 {fake.gen - 1} 个）"
        assert manager.stats()["sessions"] == 1
        manager.close_all()


# ===========================================================================
# ws.mount 契约（给 T1）
# ===========================================================================


class TestMountContract:
    def test_mount_returns_true_and_never_raises_for_broken_app(self):
        from server.pi_bridge import ws as ws_mod

        class Broken:
            @property
            def state(self):
                raise RuntimeError("没有 state")

            def add_api_websocket_route(self, *a, **k):
                raise RuntimeError("挂不上")

            def add_api_route(self, *a, **k):
                raise RuntimeError("挂不上")

        # 挂不上时返回 False，但**不抛**（不能掀翻 T1 的启动）
        assert ws_mod.mount(Broken()) is False

    def test_pi_capabilities_never_raises(self, monkeypatch):
        from server.pi_bridge import ws as ws_mod

        def boom(*a, **k):
            raise RuntimeError("探测炸了")

        # 打 ws 模块自己持有的引用（它 from .launcher import pi_capabilities as _pi_capabilities）
        monkeypatch.setattr(ws_mod, "_pi_capabilities", boom)
        caps = ws_mod.pi_capabilities()
        assert caps["available"] is False
        assert "探测炸了" in caps["reason"]
        assert caps["mode"] == "none"

    def test_router_export_works_with_include_router(self, tmp_path):
        """备用接入方式：``app.include_router(ws.router)`` 也应可用。"""
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from server.pi_bridge import ws as ws_mod

        fake = FakePi()
        ws_mod.configure(
            manager=PiSessionManager(
                make_launcher(tmp_path),
                session_dir=tmp_path / "data" / "chat",
                client_factory=fake.client_factory,
                verify_deep=False,
            )
        )
        app = FastAPI()
        app.include_router(ws_mod.router)
        with TestClient(app) as client:
            assert client.get("/api/v1/pi/capabilities").json()["available"] is True
        ws_mod.get_manager().close_all()
