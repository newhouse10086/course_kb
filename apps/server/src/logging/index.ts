/**
 * 应用日志：**落盘**（JSON Lines）+ 轮转 + 脱敏 + 级别可配。
 *
 * ## 缺口（用户要求补的就是这个）
 * 改动前：`index.ts` 里 `logger: false` → **Fastify 完全不记**；运行日志只进 stdout/终端，
 * **关掉终端就没了**。落盘的只有"结果"（`audit_log` 表 / `tasks` 表 / `data/chat/*.jsonl` /
 * sandbox 审计），**过程**（HTTP 请求、异常堆栈、worker stderr、启动信息）全丢 ——
 * 诊断时只能反查数据库，**能定位"结果"，定位不了"过程"**。
 *
 * ## 接入点（只加 hook，不改业务）
 * - `Fastify({ logger: {...}, disableRequestLogging: true })` + 一个 `onResponse` hook
 *   → 请求行含 method/path/status/耗时/用户 id
 * - `setErrorHandler` 里补一条 `error`（带 `err.stack`）
 * - `onStderr`（worker 子进程）→ 限速 + 截断后落盘
 * - `uncaughtException` / `unhandledRejection` → 落盘
 *
 * ## 安全（会做密钥扫描）
 * 三层一起：① pino `redact.paths`（req/res 结构字段）② `sanitizeUrl`（**查询串里的 token**）
 * ③ `redactDeep`（我们自己要打的对象）。任何一层单独都不够。
 */

import pino from 'pino';
import { join } from 'node:path';

import { REDACT_CENSOR, REDACT_PATHS, redactDeep, sanitizeUrl } from './redact.ts';
import {
  createRotatingFileStream,
  DEFAULT_MAX_BYTES,
  DEFAULT_RETENTION_DAYS,
  type RotatingFileStream,
} from './rotate.ts';

export { createRotatingFileStream, DEFAULT_MAX_BYTES, DEFAULT_RETENTION_DAYS } from './rotate.ts';
export * from './redact.ts';

export interface AppLoggingOptions {
  /** 日志目录（默认 `<root>/data/logs`） */
  dir: string;
  /** 级别：trace|debug|info|warn|error|fatal（默认 info） */
  level?: string;
  maxBytes?: number;
  retentionDays?: number;
  /** 同时写 stdout（默认 true：容器/终端仍能看到） */
  stdout?: boolean;
  /** ★ 仅供"红证"注入：设为 false 会**故意关掉脱敏**（用于证明测试真的能抓到泄漏） */
  redactEnabled?: boolean;
  /** 便于测试注入假时间/自定义流 */
  stream?: RotatingFileStream;
  now?: () => Date;
  onDiagnostic?: (message: string) => void;
}

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

/** 归一化级别（非法值 → info，并如实告知；不做"静默接受非法值"） */
export function normalizeLogLevel(raw: string | undefined): { level: string; warning?: string } {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return { level: 'info' };
  if ((LEVELS as readonly string[]).includes(v)) return { level: v };
  return { level: 'info', warning: `COURSE_KB_LOG_LEVEL='${raw}' 不是合法级别（${LEVELS.join('|')}）→ 回落到 info` };
}

export interface AppLogging {
  /** 交给 Fastify：`Fastify({ logger: logging.fastifyOptions, disableRequestLogging: true })` */
  fastifyOptions: {
    level: string;
    redact: { paths: string[]; censor: string } | undefined;
    serializers: Record<string, (value: unknown) => unknown>;
    stream: { write: (chunk: string) => void };
  };
  /** 日志文件绝对路径（启动时打印，运维要知道去哪找） */
  file: string;
  dir: string;
  level: string;
  /** 自检：把内容写进日志（启动信息用它，保证"日志文件里一定有启动行"） */
  writeLine(obj: Record<string, unknown>, msg: string): void;
  /**
   * ★ 分级写入（**级别 env 才有可观测的效果** —— 坑 24：若只有 `writeLine` 恒 info，
   * 那 `COURSE_KB_LOG_LEVEL=debug` 就是个死旋钮）。
   */
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  /** worker stderr → 落盘（限速 + 截断） */
  logWorkerStderr(line: string): void;
  /** 统计（测试/诊断用） */
  stats(): { lines: number; workerLines: number; workerDropped: number; file: string; size: number };
  close(): void;
}

/**
 * worker stderr 限速器：**每条最多 500 字**；**每秒最多 20 行**，超了计数丢弃并周期性汇报。
 * （worker 可能刷几万行 traceback，不限速会把日志文件打满、把有用信息挤掉。）
 */
export function createRateLimiter(opts: { maxPerSecond?: number; maxChars?: number } = {}): {
  allow(): boolean;
  /** 返回截断后的文本 */
  truncate(line: string): string;
  dropped(): number;
} {
  const maxPerSecond = opts.maxPerSecond ?? 20;
  const maxChars = opts.maxChars ?? 500;
  let windowStart = Date.now();
  let count = 0;
  let droppedCount = 0;
  return {
    allow(): boolean {
      const nowMs = Date.now();
      if (nowMs - windowStart >= 1000) {
        windowStart = nowMs;
        count = 0;
      }
      count += 1;
      if (count > maxPerSecond) {
        droppedCount += 1;
        return false;
      }
      return true;
    },
    truncate(line: string): string {
      const s = typeof line === 'string' ? line : String(line);
      return s.length > maxChars ? `${s.slice(0, maxChars)}…（已截断，原 ${s.length} 字）` : s;
    },
    dropped(): number {
      return droppedCount;
    },
  };
}

export function createAppLogging(opts: AppLoggingOptions): AppLogging {
  const { level, warning } = normalizeLogLevel(opts.level);
  const stream = opts.stream ?? createRotatingFileStream({
    dir: opts.dir,
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    ...(opts.retentionDays !== undefined ? { retentionDays: opts.retentionDays } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.onDiagnostic ? { onDiagnostic: opts.onDiagnostic } : {}),
  });
  if (warning) opts.onDiagnostic?.(warning);

  const redactEnabled = opts.redactEnabled !== false;
  const limiter = createRateLimiter();
  let lines = 0;
  let workerLines = 0;

  // 日志用 pino 构造（拿到级别过滤 + redact + 结构化），**出口是我们自己的落盘流**
  const destinations: { write: (chunk: string) => void }[] = [{ write: (chunk: string) => { stream.write(chunk); lines += 1; } }];
  if (opts.stdout !== false) destinations.push({ write: (chunk: string) => { process.stdout.write(chunk); } });

  const multi = pino.multistream(destinations.map((d) => ({ stream: d, level })), { dedupe: false });
  const logger = pino(
    {
      level,
      base: { pid: process.pid, app: 'course-kb' },
      timestamp: pino.stdTimeFunctions.isoTime,
      ...(redactEnabled ? { redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR, remove: false } } : {}),
      serializers: {
        // ★ 请求对象：**url 要清洗查询串**（Fastify 默认序列化会带上 token）
        req(value: unknown): unknown {
          const r = (value ?? {}) as { method?: unknown; url?: unknown; remoteAddress?: unknown; user?: unknown; headers?: unknown };
          const user = (r.user ?? {}) as { id?: unknown };
          return {
            method: typeof r.method === 'string' ? r.method : undefined,
            url: typeof r.url === 'string' ? sanitizeUrl(r.url) : undefined,
            remoteAddress: typeof r.remoteAddress === 'string' ? r.remoteAddress : undefined,
            userId: typeof user.id === 'string' ? user.id : null,
          };
        },
        res(value: unknown): unknown {
          const r = (value ?? {}) as { statusCode?: unknown };
          return { statusCode: typeof r.statusCode === 'number' ? r.statusCode : undefined };
        },
        err(value: unknown): unknown {
          const e = (value ?? {}) as { message?: unknown; stack?: unknown; code?: unknown; name?: unknown };
          return {
            type: typeof e.name === 'string' ? e.name : 'Error',
            message: typeof e.message === 'string' ? e.message : undefined,
            ...(typeof e.code === 'string' ? { code: e.code } : {}),
            // ★ 最缺的就是堆栈
            stack: typeof e.stack === 'string' ? e.stack : undefined,
          };
        },
      },
    },
    multi,
  );

  return {
    fastifyOptions: {
      level,
      ...(redactEnabled ? { redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR } } : { redact: undefined }),
      serializers: {
        req: (value: unknown): unknown => (logger as unknown as { serializers?: Record<string, (v: unknown) => unknown> }).serializers?.req?.(value) ?? value,
        res: (value: unknown): unknown => (logger as unknown as { serializers?: Record<string, (v: unknown) => unknown> }).serializers?.res?.(value) ?? value,
      },
      stream: { write: (chunk: string): void => { stream.write(chunk); lines += 1; } },
    },
    file: stream.currentFile(),
    dir: opts.dir,
    level,
    // 我们自己打的对象也过一道脱敏（pino redact 只覆盖它认识的路径）
    // ⚠️ `redactEnabled:false` 必须**同时**关掉这一层，否则"红证"是假的
    //   （注入失效后密钥仍不出现 → 证明不了检测有效，见 test/logging.test.ts 的红证用例）
    writeLine(obj: Record<string, unknown>, msg: string): void {
      logger.info((redactEnabled ? redactDeep(obj) : obj) as Record<string, unknown>, msg);
    },
    debug(obj: Record<string, unknown>, msg: string): void {
      logger.debug((redactEnabled ? redactDeep(obj) : obj) as Record<string, unknown>, msg);
    },
    info(obj: Record<string, unknown>, msg: string): void {
      logger.info((redactEnabled ? redactDeep(obj) : obj) as Record<string, unknown>, msg);
    },
    warn(obj: Record<string, unknown>, msg: string): void {
      logger.warn((redactEnabled ? redactDeep(obj) : obj) as Record<string, unknown>, msg);
    },
    error(obj: Record<string, unknown>, msg: string): void {
      logger.error((redactEnabled ? redactDeep(obj) : obj) as Record<string, unknown>, msg);
    },
    logWorkerStderr(line: string): void {
      if (!limiter.allow()) return;
      workerLines += 1;
      logger.warn({ source: 'worker', line: limiter.truncate(line) }, 'worker stderr');
    },
    stats(): { lines: number; workerLines: number; workerDropped: number; file: string; size: number } {
      return { lines, workerLines, workerDropped: limiter.dropped(), file: stream.currentFile(), size: stream.size() };
    },
    close(): void {
      stream.close();
      void multi;
    },
  };
}

/** 默认日志目录（`<root>/data/logs`） */
export function defaultLogDir(root: string): string {
  return join(root, 'data', 'logs');
}
