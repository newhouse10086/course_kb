/**
 * 会话与 Cookie（`docs/RBAC.md` §7）。
 *
 * 设计（**库里只存哈希**）：
 * - cookie 值 = 32 字节随机 token（base64url，客户端持有）
 * - `sessions.id` = `sha256(token)`（**数据库泄露也无法直接冒用会话**）
 * - `httpOnly` + `SameSite=Lax` + `Path=/`；`Secure` 仅在生产开启
 *   （本机 HTTP 下开 Secure 会让 cookie 发不出去 —— 那是"看起来更安全、实际登录不了"的坑）
 *
 * ⚠️ 令牌比较走**哈希后查主键**，不做字符串比较 —— 天然免时序侧信道。
 */

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'ckb_session';

export interface CookiePolicy {
  /** 会话有效期（ms） */
  ttlMs: number;
  /** 生产环境为 true；本机 HTTP 必须 false，否则浏览器不回传 cookie */
  secure: boolean;
  cookieName?: string;
  /** 反向代理下可能是 /course-kb 之类 */
  path?: string;
}

/** 生成会话令牌（客户端持有）。 */
export function newSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** 令牌 → 库存主键（sha256 hex）。 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 解析 Cookie 头，取指定 cookie（不依赖第三方包）。 */
export function readCookie(header: string | undefined, name: string = SESSION_COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

/** `Set-Cookie`：下发会话。 */
export function buildSessionCookie(token: string, policy: CookiePolicy): string {
  const name = policy.cookieName ?? SESSION_COOKIE;
  const path = policy.path ?? '/';
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(policy.ttlMs / 1000))}`,
  ];
  if (policy.secure) parts.push('Secure');
  return parts.join('; ');
}

/** `Set-Cookie`：清除会话（logout）。必须与下发时的属性一致，否则清不掉。 */
export function buildClearCookie(policy: CookiePolicy): string {
  const name = policy.cookieName ?? SESSION_COOKIE;
  const path = policy.path ?? '/';
  const parts = [`${name}=`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (policy.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * 登录失败限流（内存计数，**按 username + IP**）。
 *
 * 为什么必须有：本机工具也不能让人无限撞口令（尤其 admin）。
 * 实现取"滑动窗口 + 计数"，超限返回 429 与 `retry_after_s`。
 */
export interface RateLimitOptions {
  maxFailures?: number;
  windowMs?: number;
}

interface Bucket {
  count: number;
  firstAt: number;
}

export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxFailures: number;
  private readonly windowMs: number;

  constructor(opts: RateLimitOptions = {}) {
    this.maxFailures = Math.max(1, opts.maxFailures ?? 5);
    this.windowMs = Math.max(1000, opts.windowMs ?? 15 * 60 * 1000);
  }

  private key(username: string, ip: string): string {
    return `${username.toLowerCase()}\u0000${ip}`;
  }

  /** 还能不能试（不改变计数）。 */
  check(username: string, ip: string, now = Date.now()): { allowed: boolean; retryAfterS: number; failures: number } {
    const b = this.buckets.get(this.key(username, ip));
    if (!b || now - b.firstAt > this.windowMs) return { allowed: true, retryAfterS: 0, failures: 0 };
    if (b.count >= this.maxFailures) {
      return {
        allowed: false,
        retryAfterS: Math.max(1, Math.ceil((b.firstAt + this.windowMs - now) / 1000)),
        failures: b.count,
      };
    }
    return { allowed: true, retryAfterS: 0, failures: b.count };
  }

  /** 记一次失败。 */
  fail(username: string, ip: string, now = Date.now()): { failures: number; retryAfterS: number } {
    const k = this.key(username, ip);
    const b = this.buckets.get(k);
    if (!b || now - b.firstAt > this.windowMs) {
      this.buckets.set(k, { count: 1, firstAt: now });
      return { failures: 1, retryAfterS: 0 };
    }
    b.count += 1;
    return {
      failures: b.count,
      retryAfterS: b.count >= this.maxFailures ? Math.max(1, Math.ceil((b.firstAt + this.windowMs - now) / 1000)) : 0,
    };
  }

  /** 登录成功 → 清掉该 key 的计数。 */
  reset(username: string, ip: string): void {
    this.buckets.delete(this.key(username, ip));
  }

  /** 清理过期桶（避免长期运行内存无界）。 */
  sweep(now = Date.now()): number {
    let n = 0;
    for (const [k, b] of this.buckets) {
      if (now - b.firstAt > this.windowMs) {
        this.buckets.delete(k);
        n += 1;
      }
    }
    return n;
  }
}

/** 日志脱敏：**cookie / 口令 / token 绝不落日志**。 */
export function redactAuthText(text: string): string {
  return text
    .replace(/(ckb_session=)[A-Za-z0-9_\-%]+/gi, '$1<redacted>')
    .replace(/("password"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2')
    .replace(/("token"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1<redacted>');
}
