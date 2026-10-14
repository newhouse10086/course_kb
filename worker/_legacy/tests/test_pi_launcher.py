"""``server/pi_bridge/launcher.py`` 单测：**三档降级** + 诚实能力探测。

不依赖真 pi：``which`` / ``run`` / 文件树全部注入。
关键断言点（任务验收）：

* A 档：``../pi/packages/coding-agent/dist/cli.js`` 存在 → ``node <cli> --mode rpc``
* B 档：全局 ``pi`` 存在（Windows 上是 ``pi.CMD``）→ ``<全路径> --mode rpc``
* C 档：都不行 → ``available=False`` + **非空 reason**（不许假装可用）
* A 档文件存在但**没有 node** → 必须降级，不许硬上
* ``--version`` 跑不通 → 该档判不可用，继续降级
* 深度握手（``probe(deep=True)``）失败 → 判不可用（"命令在但启动即退"）
* ``capabilities()`` **任何情况下都不抛**
* 持久化 flag 探测失败 → 按**不支持**处理（拿不准就不承诺持久化）
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:  # 允许直接 `python -m pytest tests/...`
    sys.path.insert(0, str(ROOT))

from server.pi_bridge.launcher import (  # noqa: E402
    MODE_GLOBAL,
    MODE_NONE,
    MODE_SOURCE,
    TIER_GLOBAL,
    TIER_NONE,
    TIER_SOURCE,
    PiLauncher,
)

HELP_WITH_SESSION_FLAGS = """\
Usage: pi [options] [messages...]
  --mode <mode>          Output mode: text (default), json, or rpc
  --session <path|id>    Use specific session file or partial UUID
  --session-id <id>      Use exact project session ID, creating it if missing
  --session-dir <dir>    Directory for session storage and lookup
  --no-session           Don't save session (ephemeral)
"""

HELP_WITHOUT_SESSION_FLAGS = """\
Usage: pi [options] [messages...]
  --mode <mode>          Output mode: text (default), json, or rpc
  --print, -p            Non-interactive mode
"""


def fake_run_factory(
    *,
    version: str | None = "1.0.2",
    help_text: str = HELP_WITH_SESSION_FLAGS,
    version_rc: int = 0,
    calls: list | None = None,
):
    """伪造 ``subprocess.run``：按 argv 区分 ``--version`` / ``--help``。"""

    def fake_run(argv, **kwargs):
        if calls is not None:
            calls.append(list(argv))
        if "--version" in argv:
            return subprocess.CompletedProcess(
                argv, version_rc, stdout=(version + "\n").encode() if version else b"", stderr=b""
            )
        if "--help" in argv:
            return subprocess.CompletedProcess(argv, 0, stdout=help_text.encode(), stderr=b"")
        return subprocess.CompletedProcess(argv, 0, stdout=b"", stderr=b"")

    return fake_run


def make_source_repo(tmp_path: Path, *, build: bool = True) -> Path:
    """造一个假的 pi 源码仓库（可选是否已 build）。"""
    repo = tmp_path / "pi"
    cli = repo / "packages" / "coding-agent" / "dist" / "cli.js"
    if build:
        cli.parent.mkdir(parents=True, exist_ok=True)
        cli.write_text("// fake built cli\n", encoding="utf-8")
    return repo


def make_global_pi(tmp_path: Path, name: str = "pi.CMD") -> Path:
    """造一个假的全局 pi 包装器。"""
    wrapper = tmp_path / "npm" / name
    wrapper.parent.mkdir(parents=True, exist_ok=True)
    wrapper.write_text("@echo off\n", encoding="utf-8")
    return wrapper


# ---------------------------------------------------------------------------
# A 档
# ---------------------------------------------------------------------------


def test_tier_a_source_build_uses_node_and_rpc_mode(tmp_path):
    repo = make_source_repo(tmp_path, build=True)
    node = r"C:\Program Files\nodejs\node.exe"
    launcher = PiLauncher(
        project_root=tmp_path,
        pi_repo=repo,
        which=lambda n: node if n == "node" else None,
        run=fake_run_factory(),
    )
    cli = launcher.probe()

    assert cli.tier == TIER_SOURCE
    assert cli.mode == MODE_SOURCE
    assert cli.available is True
    assert cli.version == "1.0.2"
    assert cli.launch_style == "node-script"
    # 精确断言 argv，不是"非空"
    assert cli.rpc_argv() == [
        node,
        str(repo / "packages" / "coding-agent" / "dist" / "cli.js"),
        "--mode",
        "rpc",
    ]
    assert cli.rpc_argv(["--no-session"])[-1] == "--no-session"
    assert Path(cli.cli_path).name == "cli.js"


def test_tier_a_without_node_degrades_to_b(tmp_path):
    """dist/cli.js 在但没有 node → A 档事实上不可用，必须降级（不许硬上）。"""
    repo = make_source_repo(tmp_path, build=True)
    wrapper = make_global_pi(tmp_path)
    launcher = PiLauncher(
        project_root=tmp_path,
        pi_repo=repo,
        which=lambda n: str(wrapper) if n == "pi" else None,  # 没有 node
        run=fake_run_factory(),
    )
    cli = launcher.probe()

    assert cli.tier == TIER_GLOBAL
    assert cli.mode == MODE_GLOBAL
    assert cli.argv_prefix == (str(wrapper),)


# ---------------------------------------------------------------------------
# B 档（本机实际路径）
# ---------------------------------------------------------------------------


def test_tier_b_global_cmd_wrapper_full_path(tmp_path):
    wrapper = make_global_pi(tmp_path, name="pi.CMD")
    launcher = PiLauncher(
        project_root=tmp_path,
        pi_repo=tmp_path / "pi",  # 未 build
        which=lambda n: str(wrapper) if n == "pi" else None,
        run=fake_run_factory(version="1.0.2"),
    )
    cli = launcher.probe()

    assert cli.tier == TIER_GLOBAL
    assert cli.mode == MODE_GLOBAL
    assert cli.version == "1.0.2"
    assert cli.launch_style == "cmd-wrapper"
    # Windows 关键点：必须是 .CMD 的**全路径**，不能是裸 "pi"
    # （裸 "pi" 走 CreateProcess 会 FileNotFoundError，本机实测踩到）
    assert cli.argv_prefix == (str(wrapper),)
    assert cli.argv_prefix[0] != "pi"
    assert cli.rpc_argv(["--no-session"]) == [
        str(wrapper),
        "--mode",
        "rpc",
        "--no-session",
    ]


def test_tier_b_falls_back_to_node_bundle_when_wrapper_missing(tmp_path):
    """没有包装器时，用 node 直接跑 npm 包里的 bundle（1.0.2 实测布局）。"""
    wrapper = make_global_pi(tmp_path, name="pi.CMD")
    bundle = wrapper.parent / "node_modules" / "@earendil-works" / "pi-coding-agent" / "dist" / "bundle" / "cli.js"
    bundle.parent.mkdir(parents=True, exist_ok=True)
    bundle.write_text("// bundle\n", encoding="utf-8")

    def which(name: str) -> str | None:
        if name == "pi":
            return str(wrapper)
        if name == "node":
            return "node.exe"
        return None

    launcher = PiLauncher(
        project_root=tmp_path, pi_repo=tmp_path / "pi", which=which, run=fake_run_factory()
    )
    candidates = launcher._global_candidates()

    assert [c.launch_style for c in candidates] == ["cmd-wrapper", "node-bundle"]
    assert candidates[1].argv_prefix == ("node.exe", str(bundle))


def test_prefer_global_flag_reverses_order(tmp_path):
    repo = make_source_repo(tmp_path, build=True)
    wrapper = make_global_pi(tmp_path)

    def which(name: str) -> str | None:
        if name == "node":
            return "node.exe"
        if name == "pi":
            return str(wrapper)
        return None

    auto = PiLauncher(project_root=tmp_path, pi_repo=repo, which=which, run=fake_run_factory())
    assert auto.probe().tier == TIER_SOURCE

    prefer_global = PiLauncher(
        project_root=tmp_path,
        pi_repo=repo,
        which=which,
        run=fake_run_factory(),
        prefer="global",
    )
    assert prefer_global.probe().tier == TIER_GLOBAL
    assert prefer_global.probe().mode == MODE_GLOBAL


# ---------------------------------------------------------------------------
# C 档（诚实降级）
# ---------------------------------------------------------------------------


def test_tier_c_when_nothing_available(tmp_path):
    launcher = PiLauncher(
        project_root=tmp_path,
        pi_repo=tmp_path / "pi",
        which=lambda n: None,
        run=fake_run_factory(),
    )
    cli = launcher.probe()

    assert cli.tier == TIER_NONE
    assert cli.mode == MODE_NONE
    assert cli.available is False
    assert cli.argv_prefix == ()
    # 必须给出**具体原因**，不能是空串（UI 要显示"为什么禁用"）
    assert "pi 不可用" in cli.reason
    assert "A 档" in cli.reason and "B 档" in cli.reason
    assert len(cli.rejected) == 2
    assert cli.rejected[0][0] == TIER_SOURCE

    caps = launcher.capabilities()
    assert caps["available"] is False
    assert caps["version"] is None
    assert caps["mode"] == MODE_NONE
    assert caps["tier"] == TIER_NONE
    assert caps["reason"]


def test_version_probe_failure_rejects_tier(tmp_path):
    """``--version`` 跑不通 → 该档不可用（文件存在不等于能执行）。"""
    wrapper = make_global_pi(tmp_path)
    launcher = PiLauncher(
        project_root=tmp_path,
        pi_repo=tmp_path / "pi",
        which=lambda n: str(wrapper) if n == "pi" else None,
        run=fake_run_factory(version=None, version_rc=127),
    )
    cli = launcher.probe()

    assert cli.available is False
    assert cli.tier == TIER_NONE
    assert any("退出码 127" in reason for _tier, reason in cli.rejected)


def test_exec_spawn_exception_is_swallowed_into_degradation(tmp_path):
    """spawn 抛 OSError（如 Windows 上把 .cmd 当 exe 跑）→ 降级，不抛给上层。"""
    wrapper = make_global_pi(tmp_path)

    def boom(argv, **kwargs):
        raise OSError(193, "not a valid Win32 application")

    launcher = PiLauncher(
        project_root=tmp_path,
        pi_repo=tmp_path / "pi",
        which=lambda n: str(wrapper) if n == "pi" else None,
        run=boom,
    )
    caps = launcher.capabilities()

    assert caps["available"] is False
    assert "启动失败" in caps["reason"]
    assert "OSError" in caps["reason"]


def test_capabilities_never_raises_even_if_which_explodes(tmp_path):
    """``capabilities()`` 是诚实接口，探测内部崩了也必须返回结构完整的 dict、不抛。"""

    def which_boom(name: str):
        raise RuntimeError("which 坏了")

    launcher = PiLauncher(project_root=tmp_path, pi_repo=tmp_path / "pi", which=which_boom)
    caps = launcher.capabilities()

    assert caps["available"] is False
    assert caps["mode"] == MODE_NONE
    assert "which 坏了" in caps["reason"]
    # 契约 §5.1 要求的三个字段必须都在
    assert set(caps) >= {"available", "version", "mode"}


def test_force_unavailable_switch_is_honest(tmp_path):
    """``PI_BRIDGE_FORCE_UNAVAILABLE=1`` 只报不可用，不伪造可用（用于验证 UI 禁用路径）。"""
    repo = make_source_repo(tmp_path, build=True)
    launcher = PiLauncher(
        project_root=tmp_path,
        pi_repo=repo,
        env={"PI_BRIDGE_FORCE_UNAVAILABLE": "1"},
        which=lambda n: "node.exe" if n == "node" else None,
        run=fake_run_factory(),
    )
    cli = launcher.probe()

    assert cli.available is False
    assert "PI_BRIDGE_FORCE_UNAVAILABLE" in cli.reason


# ---------------------------------------------------------------------------
# 深度握手（"命令在但启动即退"）
# ---------------------------------------------------------------------------


def test_deep_probe_rejects_tier_whose_rpc_handshake_fails(tmp_path, monkeypatch):
    """``--version`` 通过但 RPC 握手失败 → 该档判不可用，继续降级到 C。"""
    wrapper = make_global_pi(tmp_path)
    launcher = PiLauncher(
        project_root=tmp_path,
        pi_repo=tmp_path / "pi",
        which=lambda n: str(wrapper) if n == "pi" else None,
        run=fake_run_factory(),
    )
    monkeypatch.setattr(
        PiLauncher,
        "verify_rpc",
        lambda self, cand, timeout=None: (False, "pi 启动后立即退出（rc=1）"),
    )
    cli = launcher.probe(deep=True)

    assert cli.available is False
    assert cli.tier == TIER_NONE
    assert any("RPC 握手失败" in reason for _t, reason in cli.rejected)


def test_deep_probe_accepts_verified_tier(tmp_path, monkeypatch):
    wrapper = make_global_pi(tmp_path)
    launcher = PiLauncher(
        project_root=tmp_path,
        pi_repo=tmp_path / "pi",
        which=lambda n: str(wrapper) if n == "pi" else None,
        run=fake_run_factory(),
    )
    monkeypatch.setattr(
        PiLauncher, "verify_rpc", lambda self, cand, timeout=None: (True, "get_state ok")
    )
    cli = launcher.probe(deep=True)

    assert cli.available is True
    assert cli.rpc_verified is True


def test_verify_rpc_against_fake_python_child(tmp_path):
    """``verify_rpc`` 用真进程验证：这不是 pi，但证明握手**真的会**发 get_state 并等响应。

    也顺带守住读取器语义：若用阻塞式 ``read(n)``，这个测试会因为子进程一直不退出而超时失败。
    """
    script = (
        "import sys, json\n"
        "line = sys.stdin.readline()\n"
        "rec = json.loads(line)\n"
        "print(json.dumps({'id': rec.get('id'), 'type': 'response', 'command': 'get_state',\n"
        "                  'success': True, 'data': {'sessionId': 'fake-session-1'}}), flush=True)\n"
        "import time; time.sleep(30)\n"
    )
    wrapper = tmp_path / "fake-pi.py"
    wrapper.write_text(script, encoding="utf-8")

    launcher = PiLauncher(
        project_root=tmp_path,
        pi_repo=tmp_path / "pi",
        which=lambda n: None,
        run=fake_run_factory(),
        source_candidates=("fake-pi.py",),
        probe_timeout=10,
        verify_timeout=15,
    )
    cand = launcher._source_candidate()
    assert cand is None  # 没有 node → 不认 A 档

    # 直接构造一个候选（argv = python fake-pi.py）
    from server.pi_bridge.launcher import PiCli

    cand = PiCli(
        tier=TIER_SOURCE,
        mode=MODE_SOURCE,
        argv_prefix=(sys.executable, str(wrapper)),
        cli_path=str(wrapper),
        version="fake",
        available=True,
        launch_style="node-script",
    )
    ok, detail = launcher.verify_rpc(cand, timeout=20)
    assert ok is True, detail
    assert "fake-session-1" in detail


# ---------------------------------------------------------------------------
# 会话持久化 flag 探测
# ---------------------------------------------------------------------------


def test_session_flags_supported(tmp_path):
    wrapper = make_global_pi(tmp_path)
    launcher = PiLauncher(
        project_root=tmp_path,
        pi_repo=tmp_path / "pi",
        which=lambda n: str(wrapper) if n == "pi" else None,
        run=fake_run_factory(help_text=HELP_WITH_SESSION_FLAGS),
    )
    assert launcher.supports_session_flags() is True


def test_session_flags_missing_means_no_persistence(tmp_path):
    """拿不准就不承诺持久化：help 里没有 → 判不支持。"""
    wrapper = make_global_pi(tmp_path)
    launcher = PiLauncher(
        project_root=tmp_path,
        pi_repo=tmp_path / "pi",
        which=lambda n: str(wrapper) if n == "pi" else None,
        run=fake_run_factory(help_text=HELP_WITHOUT_SESSION_FLAGS),
    )
    assert launcher.supports_session_flags() is False
    assert launcher.capabilities()["session_flags"] is False


def test_help_probe_exception_means_no_persistence(tmp_path):
    wrapper = make_global_pi(tmp_path)

    def run(argv, **kwargs):
        if "--help" in argv:
            raise OSError("help 跑不动")
        return subprocess.CompletedProcess(argv, 0, stdout=b"1.0.2\n", stderr=b"")

    launcher = PiLauncher(
        project_root=tmp_path,
        pi_repo=tmp_path / "pi",
        which=lambda n: str(wrapper) if n == "pi" else None,
        run=run,
    )
    assert launcher.supports_session_flags() is False


# ---------------------------------------------------------------------------
# 缓存与无副作用
# ---------------------------------------------------------------------------


def test_probe_cached_and_invalidate(tmp_path):
    calls: list = []
    wrapper = make_global_pi(tmp_path)
    launcher = PiLauncher(
        project_root=tmp_path,
        pi_repo=tmp_path / "pi",
        which=lambda n: str(wrapper) if n == "pi" else None,
        run=fake_run_factory(calls=calls),
    )
    launcher.probe()
    first = len(calls)
    assert first >= 1
    launcher.probe()
    assert len(calls) == first  # 命中缓存，不再起子进程
    launcher.invalidate()
    launcher.probe()
    assert len(calls) > first


def test_import_has_no_side_effects(tmp_path):
    """import 这些模块不得 spawn 任何进程（T1 要在 main.py 里 import 它）。

    用**独立子进程**验证，避免污染本进程的模块状态（原写法在本进程里
    ``del sys.modules[...]`` 再 import，会让 ``PiLauncher`` 类出现两份身份，
    反而把后面的测试搞坏 —— 这类"测试互相影响"比被测 bug 更难查）。
    """
    code = (
        "import sys, subprocess\n"
        "class BoomPopen:\n"
        "    def __init__(self, *a, **k):\n"
        "        raise AssertionError('import 阶段 spawn 了进程: %r' % (a,))\n"
        "subprocess.Popen = BoomPopen\n"
        "sys.path.insert(0, sys.argv[1])\n"
        "import server.pi_bridge\n"
        "import server.pi_bridge.client, server.pi_bridge.events\n"
        "import server.pi_bridge.launcher, server.pi_bridge.session\n"
        "import server.pi_bridge.ws\n"
        "launcher = server.pi_bridge.launcher\n"
        "assert launcher.default_launcher() is launcher.default_launcher(), '默认实例不是单例'\n"
        "assert server.pi_bridge.launcher.PiLauncher is server.pi_bridge.PiLauncher\n"
        "print('IMPORT_OK')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code, str(ROOT)],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(ROOT),
    )
    assert result.returncode == 0, result.stderr
    assert "IMPORT_OK" in result.stdout


def test_capabilities_payload_shape_matches_contract(tmp_path):
    """契约 §5.1 要求 ``pi`` 至少含 available/version/mode，且 available 必须如实。"""
    wrapper = make_global_pi(tmp_path)
    launcher = PiLauncher(
        project_root=tmp_path,
        pi_repo=tmp_path / "pi",
        which=lambda n: str(wrapper) if n == "pi" else None,
        run=fake_run_factory(version="1.0.2"),
    )
    caps = launcher.capabilities(deep=False)

    assert caps["available"] is True
    assert caps["version"] == "1.0.2"
    assert caps["mode"] == MODE_GLOBAL
    assert caps["cli_path"] == str(wrapper)
    assert caps["session_flags"] is True
    # 可 JSON 序列化（要直接进 HTTP 响应）
    assert json.loads(json.dumps(caps))["mode"] == MODE_GLOBAL


def test_real_environment_probe_is_self_consistent():
    """真实环境探测必须**自洽**（不断言具体档位，避免机器相关而脆弱）。

    可用 ⇒ argv 非空且 mode 不是 none；不可用 ⇒ 必须给出非空 reason。
    """
    launcher = PiLauncher()  # 真实 project_root / 真实 PATH
    caps = launcher.capabilities()

    if caps["available"]:
        assert caps["mode"] in (MODE_SOURCE, MODE_GLOBAL)
        assert caps["cli_path"]
        assert caps["tier"] in (TIER_SOURCE, TIER_GLOBAL)
        cli = launcher.probe()
        assert cli.argv_prefix, "可用却没有启动 argv"
        assert "rpc" in cli.rpc_argv()
    else:
        assert caps["mode"] == MODE_NONE
        assert caps["reason"].strip()
        assert caps["version"] is None
