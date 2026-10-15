/**
 * 落盘 + 轮转（**不引重依赖**）：按天命名 + 单文件上限 + 保留 N 天。
 *
 * ## 设计取舍（写清楚，免得后人"优化"掉）
 * - **同步 append**（`appendFileSync`）而不是 `createWriteStream`：
 *   日志量小（单机课程系统），换来的是"**写回磁盘就一定能读到**" ——
 *   异步流在崩溃/测试里会留缓冲，正是"看起来写了其实没有"那一类。
 * - **不引 `pino-roll`/`rotating-file-stream`**（新增依赖要有理由；这里的轮转策略 30 行就能自证）
 * - 轮转判据：① 日期变了 → 新文件；② 当前文件超过 `maxBytes` → 同一天内加序号 `.N`
 * - 清理：文件名里的日期早于 `today - retentionDays` → 删除（解析不出日期的**不删**，避免误删）
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface RotateOptions {
  dir: string;
  /** 单文件上限（字节），默认 50MB */
  maxBytes?: number;
  /** 保留天数，默认 14 */
  retentionDays?: number;
  /** 文件名前缀（默认 `app`） */
  prefix?: string;
  /** 便于测试注入假时间 */
  now?: () => Date;
  onDiagnostic?: (message: string) => void;
}

export interface RotatingFileStream {
  /** 写一行（自动补 `\n`） */
  write(line: string): void;
  /** 当前文件绝对路径 */
  currentFile(): string;
  /** 目录下所有本前缀的日志文件（绝对路径，按名排序） */
  listFiles(): string[];
  /** 本文件已写字节数（测试断言用） */
  size(): number;
  close(): void;
}

export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_RETENTION_DAYS = 14;

function dateStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function createRotatingFileStream(opts: RotateOptions): RotatingFileStream {
  const prefix = opts.prefix ?? 'app';
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const now = opts.now ?? ((): Date => new Date());
  const diag = opts.onDiagnostic ?? ((): void => {});
  const nameRe = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?\\.log$`);

  mkdirSync(opts.dir, { recursive: true });
  let file = '';
  let bytes = 0;

  const pickFile = (day: string): string => {
    const base = join(opts.dir, `${prefix}-${day}.log`);
    if (existsSync(base) && statSync(base).size >= maxBytes) {
      // 同一天内已超上限 → 找下一个序号（`.1`、`.2`…）
      for (let i = 1; i < 10_000; i += 1) {
        const candidate = join(opts.dir, `${prefix}-${day}.${i}.log`);
        if (!existsSync(candidate)) return candidate;
        if (statSync(candidate).size < maxBytes) return candidate;
      }
    }
    return base;
  };

  const openFor = (day: string): void => {
    file = pickFile(day);
    bytes = existsSync(file) ? statSync(file).size : 0;
  };

  const prune = (today: Date): void => {
    const cutoff = new Date(today.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const cutoffStamp = dateStamp(cutoff);
    let removed = 0;
    for (const name of readdirSync(opts.dir)) {
      const m = nameRe.exec(name);
      if (!m) continue; // 解析不出日期的**不删**（可能是运维手放的文件）
      const day = m[1] as string;
      if (day < cutoffStamp) {
        try {
          unlinkSync(join(opts.dir, name));
          removed += 1;
        } catch (err) {
          diag(`清理旧日志失败：${name}：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (removed > 0) diag(`已清理 ${removed} 个超过 ${retentionDays} 天的日志文件`);
  };

  const ensureCurrent = (): void => {
    const today = now();
    const day = dateStamp(today);
    const expected = file === '' ? '' : file.slice(file.lastIndexOf(`${prefix}-`) + prefix.length + 1, file.lastIndexOf(`${prefix}-`) + prefix.length + 11);
    // 日期变了（或首次）→ 换文件；同一天超上限 → 换序号
    if (file === '' || expected !== day) {
      openFor(day);
      prune(today);
      return;
    }
    if (bytes >= maxBytes) openFor(day);
  };

  return {
    write(line: string): void {
      const text = line.endsWith('\n') ? line : `${line}\n`;
      try {
        ensureCurrent();
        appendFileSync(file, text, 'utf8');
        bytes += Buffer.byteLength(text, 'utf8');
      } catch (err) {
        // 日志写不进去**不能**把服务带崩，但也不能静默 → 降到 stderr
        process.stderr.write(`[logging] 写日志失败（${file}）：${err instanceof Error ? err.message : String(err)}\n`);
      }
    },
    currentFile(): string {
      if (file === '') ensureCurrent();
      return file;
    },
    listFiles(): string[] {
      try {
        return readdirSync(opts.dir)
          .filter((n) => nameRe.test(n))
          .sort()
          .map((n) => join(opts.dir, n));
      } catch {
        return [];
      }
    },
    size(): number {
      return bytes;
    },
    close(): void {
      /* 同步写入，无缓冲需要 flush */
    },
  };
}
