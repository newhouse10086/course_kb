/**
 * JSONL 字节级分帧（坑 12 —— **绝不使用 Node `readline`**）。
 *
 * ⚠️ 为什么不能用 `readline`（本机 Node v24.15.0 **实测**，不是转述）：
 * ```text
 * 输入字节:  {"a":"x\u2028y"}\n{"b":2}\n          ← \u2028 是 JSON 字符串里的合法字符
 * readline:  ['{"a":"x', 'y"}', '{"b":2}']        ← 被 U+2028 错切成 3 帧，前两帧 JSON.parse 直接失败
 * 按 \n 切字节: 2 帧，全部解析成功
 * ```
 * U+2028(LINE SEPARATOR) / U+2029(PARAGRAPH SEPARATOR) 在 JSON 字符串里**合法**，
 * 而 readline 把它们当行分隔符 → **错切帧**。
 *
 * 本模块只做一件事：**按字节 0x0A 切**，切完再按 UTF-8 解码。
 * 因为 0x0A 不可能出现在任何多字节 UTF-8 序列的续字节里，所以分帧不会切断字符。
 *
 * 与 pi RPC 的 P1 约束同源（契约 §7.1）；v1 已因此踩过坑，v2 的 worker↔Node 同样适用。
 */

export interface FramerOptions {
  /** 单帧上限（防 worker 永不换行导致内存无界增长）。默认 64 MiB。 */
  maxFrameBytes?: number;
}

export class FrameTooLargeError extends Error {
  readonly limitBytes: number;
  constructor(limitBytes: number) {
    super(`JSONL 单帧超过上限 ${limitBytes} 字节（worker 可能没有输出换行，或协议不对）`);
    this.name = 'FrameTooLargeError';
    this.limitBytes = limitBytes;
  }
}

/**
 * 增量分帧器：喂字节，吐**完整行**（已解码字符串）。
 *
 * 用法（必须持续读 stdout，见 P2 的背压教训）：
 * ```ts
 * const framer = new JsonlFramer();
 * child.stdout.on('data', (chunk: Buffer) => { for (const line of framer.push(chunk)) handle(line); });
 * child.stdout.on('end', () => { for (const line of framer.flush()) handle(line); });
 * ```
 */
export class JsonlFramer {
  private buf: Buffer = Buffer.alloc(0);
  private readonly maxFrameBytes: number;

  constructor(opts: FramerOptions = {}) {
    this.maxFrameBytes = opts.maxFrameBytes ?? 64 * 1024 * 1024;
  }

  /** 喂一段字节，返回其中**完整**的行（不含 `\n`）。 */
  push(chunk: Buffer | string): string[] {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.buf = this.buf.length === 0 ? bytes : Buffer.concat([this.buf, bytes]);

    const out: string[] = [];
    let start = 0;
    for (;;) {
      // ★ 只找字节 0x0A，不用 readline，不把 U+2028/U+2029 当分隔符
      const nl = this.buf.indexOf(0x0a, start);
      if (nl === -1) break;
      out.push(decodeLine(this.buf.subarray(start, nl)));
      start = nl + 1;
    }
    if (start > 0) this.buf = this.buf.subarray(start);
    if (this.buf.length > this.maxFrameBytes) throw new FrameTooLargeError(this.maxFrameBytes);
    return out;
  }

  /** 流结束时调用：把没有以 `\n` 结尾的残留当作最后一帧（非空才返回）。 */
  flush(): string[] {
    if (this.buf.length === 0) return [];
    const line = decodeLine(this.buf);
    this.buf = Buffer.alloc(0);
    return line.trim() ? [line] : [];
  }

  /** 未消费的字节数（调试/测试用）。 */
  get pendingBytes(): number {
    return this.buf.length;
  }
}

/** 去掉行尾 `\r`（兼容 CRLF 写入的 worker），再按 UTF-8 解码。 */
function decodeLine(bytes: Buffer): string {
  if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) {
    bytes = bytes.subarray(0, bytes.length - 1);
  }
  return bytes.toString('utf8');
}

/**
 * 逐行解析 JSONL：坏行**不静默丢弃** —— 回调 `onBadLine`，由调用方计入 `badFrames` 并如实上报
 * （契约 §8 `E_WORKER_PROTOCOL`）。
 */
export function parseJsonl(
  chunk: Buffer | string,
  framer: JsonlFramer,
  onBadLine?: (line: string, err: unknown) => void,
): { value: unknown; line: string }[] {
  const out: { value: unknown; line: string }[] = [];
  for (const line of framer.push(chunk)) {
    if (!line.trim()) continue;
    try {
      out.push({ value: JSON.parse(line) as unknown, line });
    } catch (err) {
      onBadLine?.(line, err);
    }
  }
  return out;
}
