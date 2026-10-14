/**
 * 任务事件总线（契约 `docs/API_PROTOCOL.md` §6 —— SSE 进度流）。
 *
 * 契约要求（**逐条落实，每条都有测试**）：
 * 1. `event:` 后跟事件名，`data:` 是**单行 JSON**（不含裸换行）
 * 2. 每 **15 秒**发一次 `: keepalive` 注释帧防超时
 * 3. 任务结束（`done`/`failed`/`cancelled`）后服务端**主动关闭**
 * 4. 客户端断线重连用 **`Last-Event-ID`**，服务端**从断点续推**
 *
 * 设计要点：每个任务维护一个**有界的帧缓冲**（默认 2000 帧）+ 单调递增的 `id`。
 * 重连时先重放 `id > Last-Event-ID` 的缓冲帧，再接实时流 —— 这样"断线期间的事件不丢"。
 *
 * ⚠️ 订阅顺序陷阱（坑 14 的同源问题）：必须**先注册订阅者再重放**，
 * 否则重放期间新产生的事件会被漏掉。反过来（先重放再注册）则会漏帧。
 */

export interface SseFrame {
  id: number;
  event: string;
  data: Record<string, unknown>;
}

/** keepalive 帧的伪事件名；路由层把它渲染成 `: keepalive` 注释行。 */
export const KEEPALIVE_EVENT = ':keepalive';

export interface SseSubscribeOptions {
  /** `Last-Event-ID`：只推 `id > fromId` 的帧。null/undefined = 从头重放。 */
  fromId?: number | null;
  onFrame: (frame: SseFrame) => void;
  /** 任务终结时调用一次（路由层据此 `reply.raw.end()`）。 */
  onClose?: () => void;
  /** 覆盖 keepalive 间隔（契约 §6 默认 15000ms）。 */
  keepaliveMs?: number;
}

interface TaskChannel {
  nextId: number;
  buffered: SseFrame[];
  subscribers: Set<Subscriber>;
  finished: boolean;
}

interface Subscriber {
  onFrame: (frame: SseFrame) => void;
  onClose: (() => void) | undefined;
  timer: NodeJS.Timeout | null;
  closed: boolean;
}

export interface TaskEventBusOptions {
  maxBufferedPerTask?: number;
  defaultKeepaliveMs?: number;
}

export class TaskEventBus {
  private readonly channels = new Map<string, TaskChannel>();
  private readonly maxBuffered: number;
  private readonly defaultKeepaliveMs: number;

  constructor(opts: TaskEventBusOptions = {}) {
    this.maxBuffered = Math.max(1, opts.maxBufferedPerTask ?? 2000);
    this.defaultKeepaliveMs = Math.max(1, opts.defaultKeepaliveMs ?? 15_000);
  }

  private channel(taskId: string): TaskChannel {
    let ch = this.channels.get(taskId);
    if (!ch) {
      ch = { nextId: 1, buffered: [], subscribers: new Set(), finished: false };
      this.channels.set(taskId, ch);
    }
    return ch;
  }

  /** 发一帧。返回带 `id` 的帧（**已写入缓冲**）。任务终结后只入缓冲不推送。 */
  publish(taskId: string, event: string, data: Record<string, unknown>): SseFrame {
    const ch = this.channel(taskId);
    const frame: SseFrame = { id: ch.nextId, event, data };
    ch.nextId += 1;
    ch.buffered.push(frame);
    // 有界缓冲：超限丢**最旧**的（`nextId` 仍单调，重连方从现存最旧帧开始拿）
    if (ch.buffered.length > this.maxBuffered) {
      ch.buffered.splice(0, ch.buffered.length - this.maxBuffered);
    }
    if (!ch.finished) {
      for (const sub of [...ch.subscribers]) {
        if (sub.closed) continue;
        try {
          sub.onFrame(frame);
        } catch {
          /* 单个订阅者出错不能影响其他订阅者 */
        }
      }
    }
    return frame;
  }

  /**
   * 订阅。返回 unsubscribe。
   *
   * 顺序：**先注册 → 再重放缓冲**（这样重放期间新 publish 的帧不会被漏，最多是顺序上
   * 排在重放帧之后，而它本来 id 更大，天然在后）。
   */
  subscribe(taskId: string, opts: SseSubscribeOptions): () => void {
    const ch = this.channel(taskId);
    const sub: Subscriber = {
      onFrame: opts.onFrame,
      onClose: opts.onClose,
      timer: null,
      closed: false,
    };

    // 先注册（坑 14：先订阅再发请求）
    if (opts.onClose) {
      if (ch.finished) {
        // 已终结：不注册订阅者，只重放历史后立刻 onClose
        this.replay(ch, opts.fromId ?? null, opts.onFrame);
        opts.onClose();
        return () => {};
      }
      ch.subscribers.add(sub);
    } else {
      ch.subscribers.add(sub);
    }

    // 再重放
    this.replay(ch, opts.fromId ?? null, opts.onFrame);

    // keepalive
    const ms = Math.max(1, opts.keepaliveMs ?? this.defaultKeepaliveMs);
    sub.timer = setInterval(() => {
      if (sub.closed) return;
      const frame: SseFrame = { id: ch.nextId - 1, event: KEEPALIVE_EVENT, data: {} };
      try {
        sub.onFrame(frame);
      } catch {
        /* 忽略 */
      }
    }, ms);
    sub.timer.unref?.();

    return () => {
      sub.closed = true;
      if (sub.timer) clearInterval(sub.timer);
      sub.timer = null;
      ch.subscribers.delete(sub);
    };
  }

  private replay(ch: TaskChannel, fromId: number | null, onFrame: (f: SseFrame) => void): void {
    for (const f of ch.buffered) {
      if (fromId !== null && f.id <= fromId) continue;
      try {
        onFrame(f);
      } catch {
        /* 重放期间单个回调出错不中断其余帧 */
      }
    }
  }

  hasSubscribers(taskId: string): boolean {
    const ch = this.channels.get(taskId);
    if (!ch) return false;
    return [...ch.subscribers].some((s) => !s.closed);
  }

  subscriberCount(taskId: string): number {
    const ch = this.channels.get(taskId);
    if (!ch) return 0;
    return [...ch.subscribers].filter((s) => !s.closed).length;
  }

  buffered(taskId: string): SseFrame[] {
    return [...(this.channels.get(taskId)?.buffered ?? [])];
  }

  lastEventId(taskId: string): number {
    const ch = this.channels.get(taskId);
    return ch ? ch.nextId - 1 : 0;
  }

  isFinished(taskId: string): boolean {
    return this.channels.get(taskId)?.finished ?? false;
  }

  /** 任务终结：通知所有订阅者关闭，并清 keepalive；之后 publish 只入缓冲。 */
  finish(taskId: string): void {
    const ch = this.channel(taskId);
    if (ch.finished) return;
    ch.finished = true;
    const subs = [...ch.subscribers];
    ch.subscribers.clear();
    for (const sub of subs) {
      sub.closed = true;
      if (sub.timer) clearInterval(sub.timer);
      sub.timer = null;
      try {
        sub.onClose?.();
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 释放内存（任务删除/过期）。 */
  forget(taskId: string): void {
    const ch = this.channels.get(taskId);
    if (!ch) return;
    this.finish(taskId);
    this.channels.delete(taskId);
  }
}

/**
 * 把任意值序列化成 **SSE 安全的单行 JSON**。
 *
 * ⚠️ 实测（Node v24.15.0）：`JSON.stringify` 会转义 `\n`，但**不会**转义
 * `U+2028`(LINE SEPARATOR) / `U+2029`(PARAGRAPH SEPARATOR) —— 它们会**原样输出**。
 * 原错误写法：`data: ${JSON.stringify(frame.data)}`（遇到含 U+2028 的模型输出/文件名时，
 * 帧里就带上了"某些读取器认作换行"的字符，把"单行 JSON"的保证打穿）。
 *
 * 处理方式与契约 §7.3.1 的 P1 一致：**主动消除**，而不是指望下游容忍。
 */
export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * 把一帧渲染成 SSE 文本（契约 §6）。
 *
 * - keepalive → `: keepalive\n\n`（注释帧，不产生事件）
 * - 普通帧 → `id: N\nevent: X\ndata: <单行 JSON>\n\n`
 *
 * ⚠️ **不要**手写模板拼 JSON：一律走 `safeJsonStringify`（见其注释里的实测结论）。
 */
export function formatSseFrame(frame: SseFrame): string {
  if (frame.event === KEEPALIVE_EVENT) return ': keepalive\n\n';
  const data = safeJsonStringify(frame.data);
  return `id: ${frame.id}\nevent: ${frame.event}\ndata: ${data}\n\n`;
}
