"""后台任务 + SSE 进度流（契约 §2.6 / §5.6 / §6）。

设计要点：
* **任务串行执行**（一个 worker 线程）—— 与 LLM 并发=1 一致，也避免两个解析同时抢 CPU。
* 事件既是**实时推送**（订阅队列）也是**可重放日志**（``Last-Event-ID`` 续推，契约 §6）。
* SSE 帧格式严格照契约：``event: <名称>`` + ``data: <单行 JSON>``；
  每 15 秒一个 ``: keepalive`` 注释帧；任务终态后**主动关闭**。
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Iterator

from worker.config import Settings, get_settings
from worker.models import Task, id_for, now_ms
# ⚠️ v2：worker 不依赖任何 store（SQLite 归 TS 层）。
# 这里只做**类型注解**引用，运行期不 import legacy store；
# legacy（FastAPI + SQLite）路径的函数体内会自行延迟导入。
if TYPE_CHECKING:  # pragma: no cover
    from worker._legacy.store.repo import Repo

log = logging.getLogger(__name__)

#: 终态（到达后 SSE 关闭）
TERMINAL = {"done", "failed", "cancelled"}


@dataclass
class Event:
    id: int
    event: str
    data: dict[str, Any]

    def frame(self) -> str:
        """SSE 帧（data 必须是**单行 JSON**，契约 §6）。"""
        payload = json.dumps(self.data, ensure_ascii=False, separators=(",", ":"))
        return f"id: {self.id}\nevent: {self.event}\ndata: {payload}\n\n"


class TaskBus:
    """任务事件总线（内存，进程内）。"""

    def __init__(self, *, keep_events: int = 500):
        self._events: dict[str, list[Event]] = {}
        self._subs: dict[str, list[queue.Queue]] = {}
        self._seq: dict[str, int] = {}
        self._lock = threading.RLock()
        self._keep = keep_events

    # ── 发布 ────────────────────────────────────────────────────────
    def publish(self, task_id: str, event: str, data: dict[str, Any]) -> Event:
        with self._lock:
            nid = self._seq.get(task_id, 0) + 1
            self._seq[task_id] = nid
            ev = Event(id=nid, event=event, data=data)
            lst = self._events.setdefault(task_id, [])
            lst.append(ev)
            if len(lst) > self._keep:
                del lst[: len(lst) - self._keep]
            subs = list(self._subs.get(task_id, []))
        for q in subs:
            try:
                q.put_nowait(ev)
            except queue.Full:  # pragma: no cover - 订阅者太慢
                pass
        return ev

    # ── 订阅 ────────────────────────────────────────────────────────
    def subscribe(self, task_id: str) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=1000)
        with self._lock:
            self._subs.setdefault(task_id, []).append(q)
        return q

    def unsubscribe(self, task_id: str, q: queue.Queue) -> None:
        with self._lock:
            lst = self._subs.get(task_id, [])
            if q in lst:
                lst.remove(q)

    def history(self, task_id: str, after_id: int = 0) -> list[Event]:
        with self._lock:
            return [e for e in self._events.get(task_id, []) if e.id > after_id]

    def last_id(self, task_id: str) -> int:
        with self._lock:
            return self._seq.get(task_id, 0)

    def is_terminal(self, task_id: str) -> bool:
        with self._lock:
            for e in reversed(self._events.get(task_id, [])):
                if e.event in ("done", "failed"):
                    return True
        return False

    def clear(self, task_id: str) -> None:
        with self._lock:
            self._events.pop(task_id, None)
            self._seq.pop(task_id, None)


class TaskContext:
    """交给 job 函数的句柄：更新进度 / 记日志 / 发产物。"""

    def __init__(
        self,
        task: Task,
        bus: TaskBus,
        repo: Repo,
        *,
        cancel_event: threading.Event,
        settings: Settings,
    ):
        self.task = task
        self.bus = bus
        self.repo = repo
        self.settings = settings
        self.cancel_event = cancel_event
        self.artifacts: list[dict[str, Any]] = []

    @property
    def cancelled(self) -> bool:
        return self.cancel_event.is_set()

    def update(
        self, progress: float, stage: str = "", detail: dict[str, Any] | None = None
    ) -> None:
        """上报进度（同时落库 + 推 SSE）。"""
        if self.cancelled:
            raise TaskCancelled()
        prog = max(0.0, min(1.0, float(progress)))
        self.repo.update_task(self.task.id, status="running", progress=prog, stage=stage,
                              detail=detail)
        self.bus.publish(
            self.task.id,
            "progress",
            {
                "task_id": self.task.id,
                "progress": round(prog, 4),
                "stage": stage,
                "done": (detail or {}).get("done"),
                "total": (detail or {}).get("total"),
                **(detail or {}),
            },
        )

    def progress_fn(self, base: float = 0.0, span: float = 1.0, label: str = ""):
        """给 adapter/pipeline 用的 ``on_progress(frac, stage)`` 适配器。"""

        def _cb(frac: float, stage: str) -> None:
            self.update(base + span * max(0.0, min(1.0, frac)), f"{label}{stage}".strip())

        return _cb

    def log(self, msg: str, level: str = "info") -> None:
        self.bus.publish(
            self.task.id, "log", {"task_id": self.task.id, "level": level, "msg": msg}
        )

    def artifact(self, kind: str, url: str, **extra: Any) -> None:
        payload = {"task_id": self.task.id, "kind": kind, "url": url, **extra}
        self.artifacts.append(payload)
        self.bus.publish(self.task.id, "artifact", payload)

    def check_cancel(self) -> None:
        if self.cancelled:
            raise TaskCancelled()


class TaskCancelled(Exception):
    """任务被取消（→ status=cancelled）。"""


JobFn = Callable[[TaskContext], dict[str, Any]]


class TaskRunner:
    """单线程任务执行器（顺序跑，符合"并发=1"的整体约定）。"""

    def __init__(self, repo: Repo, bus: TaskBus | None = None, settings: Settings | None = None):
        self.repo = repo
        self.bus = bus or TaskBus()
        self.settings = settings or get_settings()
        self._jobs: dict[str, JobFn] = {}
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._cancels: dict[str, threading.Event] = {}
        self._thread: threading.Thread | None = None
        self._lock = threading.RLock()
        self.started_tasks: list[str] = []

    # ── 注册 ────────────────────────────────────────────────────────
    def register(self, kind: str, fn: JobFn) -> None:
        self._jobs[kind] = fn

    def registered(self) -> list[str]:
        return sorted(self._jobs)

    # ── 生命周期 ────────────────────────────────────────────────────
    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._thread = threading.Thread(target=self._loop, name="task-runner", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._queue.put(None)
        t = self._thread
        if t and t.is_alive():
            t.join(timeout=5.0)
        self._thread = None

    # ── 提交 ────────────────────────────────────────────────────────
    def submit(self, kind: str, doc_id: str | None) -> Task:
        if kind not in self._jobs:
            raise KeyError(f"未注册的任务类型：{kind}")
        task = Task(id=id_for("task"), doc_id=doc_id, kind=kind, status="queued")
        self.repo.create_task(task)
        self._cancels[task.id] = threading.Event()
        self.started_tasks.append(task.id)
        self.bus.publish(task.id, "queued", {"task_id": task.id, "kind": kind, "status": "queued"})
        self.start()
        self._queue.put(task.id)
        return task

    def cancel(self, task_id: str) -> Task | None:
        ev = self._cancels.get(task_id)
        if ev:
            ev.set()
        task = self.repo.cancel_task(task_id)
        if task:
            self.bus.publish(task.id, "cancelled", {"task_id": task.id, "status": "cancelled"})
        return task

    # ── worker ─────────────────────────────────────────────────────
    def _loop(self) -> None:
        while True:
            task_id = self._queue.get()
            if task_id is None:
                return
            self._run_one(task_id)

    def _run_one(self, task_id: str) -> None:
        task = self.repo.get_task(task_id)
        if task is None:
            return
        cancel = self._cancels.get(task_id) or threading.Event()
        ctx = TaskContext(task, self.bus, self.repo, cancel_event=cancel, settings=self.settings)
        started = now_ms()
        self.repo.update_task(task_id, status="running", progress=0.0, stage="开始")
        try:
            fn = self._jobs[task.kind]
            detail = fn(ctx) or {}
            if ctx.cancelled:
                raise TaskCancelled()
            self.repo.update_task(
                task_id, status="done", progress=1.0, stage="完成",
                detail=detail, finished_at=now_ms(),
            )
            self.bus.publish(
                task_id,
                "done",
                {
                    "task_id": task_id,
                    "status": "done",
                    "elapsed_ms": now_ms() - started,
                    **(detail or {}),
                },
            )
        except TaskCancelled:
            self.repo.update_task(
                task_id, status="cancelled", stage="已取消", finished_at=now_ms()
            )
            self.bus.publish(task_id, "done", {"task_id": task_id, "status": "cancelled",
                                              "elapsed_ms": now_ms() - started})
        except Exception as exc:  # noqa: BLE001 - 任何失败都要让 UI 知道
            code = getattr(exc, "code", type(exc).__name__)
            msg = getattr(exc, "msg", None) or str(exc)
            log.exception("任务 %s 失败", task_id)
            self.repo.update_task(
                task_id,
                status="failed",
                error=f"{code}: {msg}",
                stage="失败",
                finished_at=now_ms(),
            )
            self.bus.publish(
                task_id,
                "failed",
                {"task_id": task_id, "error": msg, "code": code,
                 "elapsed_ms": now_ms() - started},
            )
        finally:
            self._cancels.pop(task_id, None)


# ═══════════════════════════════════════════════════════════════════════
# SSE
# ═══════════════════════════════════════════════════════════════════════
def sse_frames(
    bus: TaskBus,
    task_id: str,
    *,
    last_event_id: int = 0,
    poll_interval: float = 0.3,
    keepalive: float = 15.0,
    timeout_s: float = 3600.0,
    is_terminal: Callable[[], bool] | None = None,
) -> Iterator[str]:
    """生成 SSE 帧序列（同步生成器；FastAPI 的 StreamingResponse 直接吃）。

    顺序：先补发 ``id > last_event_id`` 的历史事件（断线重连续推），
    再等新事件；每 ``keepalive`` 秒发一个 ``: keepalive`` 注释帧；
    任务终态（``done``/``failed``/``cancelled``）后结束生成器 → 服务端主动关闭。
    """
    sent = int(last_event_id)
    last_beat = time.time()
    started = time.time()
    for ev in bus.history(task_id, sent):
        sent = max(sent, ev.id)
        yield ev.frame()
        if ev.event in ("done", "failed"):
            return
    while True:
        if is_terminal and is_terminal():
            # 兜底：终态已落库但事件丢了
            for ev in bus.history(task_id, sent):
                sent = max(sent, ev.id)
                yield ev.frame()
            return
        if time.time() - started > timeout_s:
            yield f": timeout after {timeout_s:.0f}s\n\n"
            return
        new = bus.history(task_id, sent)
        if new:
            for ev in new:
                sent = max(sent, ev.id)
                yield ev.frame()
                if ev.event in ("done", "failed"):
                    return
            last_beat = time.time()
            continue
        if time.time() - last_beat >= keepalive:
            last_beat = time.time()
            yield ": keepalive\n\n"
        time.sleep(poll_interval)


# 兼容别名（main.py 里按 async 版本用）
def parse_sse_last_id(header_value: str | None) -> int:
    try:
        return int(header_value or 0)
    except (TypeError, ValueError):
        return 0


def sse_response_payload(bus: TaskBus, task_id: str) -> dict[str, Any]:
    """调试用：把当前事件流拍平成 JSON（测试断言事件序列）。"""
    return {
        "task_id": task_id,
        "last_id": bus.last_id(task_id),
        "events": [{"id": e.id, "event": e.event, "data": e.data} for e in bus.history(task_id)],
    }
