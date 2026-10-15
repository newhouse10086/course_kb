/**
 * 敏感信息脱敏（**硬要求**：密钥扫描会 grep 日志文件）。
 *
 * ## 为什么单独一个文件
 * 脱敏是"**说了必须真的生效**"那类要求（坑 21/24）：提示词/注释里写着"已脱敏"没用，
 * 必须能用**构造带假密钥的请求 → grep 日志**来证明。所以判据（路径表 + URL 清洗 +
 * 递归脱敏）集中在这里，并配 `findSensitiveLeaks()` 供测试直接断言。
 */

/** 需要打码的字段名（不区分大小写、可作子串匹配用） */
export const SENSITIVE_KEY_PATTERNS = [
  'password',
  'passwd',
  'token',
  'authorization',
  'cookie',
  'api_key',
  'apikey',
  'api-key',
  'secret',
  'access_key',
  'private_key',
  'credential',
  'session_id', // ⚠️ 会话 id 是"能连上别人会话"的凭据（见会话归属），不进日志
];

/**
 * pino `redact.paths`：**结构化日志的字段路径**（Fastify 的 req/res 对象）。
 *
 * ⚠️ 只列路径是不够的（只治"直接打对象"的情形）：请求体里的密钥要**我们自己不发**，
 * URL 里的密钥要 `sanitizeUrl` 清 —— 三层一起才算"不记敏感信息"。
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.token',
  'req.body.api_key',
  'body.password',
  'password',
  'token',
  'api_key',
  'apiKey',
  'authorization',
  'secret',
  '*.password',
  '*.token',
  '*.api_key',
  '*.authorization',
  '*.secret',
  '*.apiKey',
];

export const REDACT_CENSOR = '[REDACTED]';

/** URL 查询串里这些键的值要被替换（**键名保留**，便于排障时知道"用了哪个参数"） */
export const SENSITIVE_QUERY_KEYS = [
  'token',
  'access_token',
  'refresh_token',
  'key',
  'api_key',
  'apikey',
  'password',
  'passwd',
  'secret',
  'code',
  'session',
  'session_id',
];

/** 值看起来像密钥吗（兜底：万一键名没在名单里，密码学随机串也拦一道） */
export function looksLikeSecret(value: string): boolean {
  const v = value.trim();
  if (v.length < 16) return false;
  // ★ 含空白/路径分隔符的一律**不算密钥**：否则会把 Windows 路径与
  //   `data/logs/app-2026-10-15.log` 这种**运维最需要看的**值打成 [REDACTED]。
  //   真机实测：不排除路径时，启动行里的 root/db/logFile **全被打码** → 日志失去排障价值。
  if (/[\s\\/]/.test(v)) return false;
  // 形如 sk-/ghp-/xoxb- 的常见密钥前缀
  if (/^(sk|pk|rk|ghp|gho|xox[baprs])[-_]/i.test(v)) return true;
  if (/^eyJ[A-Za-z0-9_-]{10,}/.test(v)) return true; // JWT
  if (/^[0-9a-f]{32,}$/i.test(v)) return true; // 十六进制密钥
  const hasUpper = /[A-Z]/.test(v);
  const hasLower = /[a-z]/.test(v);
  const hasDigit = /\d/.test(v);
  const hasSymbol = /[^A-Za-z0-9]/.test(v);
  return hasUpper && hasLower && hasDigit && hasSymbol;
}

/**
 * 清洗 URL：**丢掉敏感查询参数的值**（保留路径与其它参数）。
 *
 * ⚠️ Fastify 默认的 req 序列化会记完整 `url`（含查询串）——
 * 所以"不记 token"必须在这里做，而不是靠 pino 的 redact（它只看字段路径）。
 */
export function sanitizeUrl(rawUrl: string): string {
  const s = typeof rawUrl === 'string' ? rawUrl : '';
  const qIdx = s.indexOf('?');
  if (qIdx < 0) return s;
  const base = s.slice(0, qIdx);
  const query = s.slice(qIdx + 1);
  if (query === '') return `${base}?`;
  const cleaned = query
    .split('&')
    .map((pair) => {
      if (pair === '') return pair;
      const eq = pair.indexOf('=');
      const rawKey = eq < 0 ? pair : pair.slice(0, eq);
      const rawValue = eq < 0 ? '' : pair.slice(eq + 1);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        /* 保持原样 */
      }
      const lower = key.toLowerCase();
      const sensitive = SENSITIVE_QUERY_KEYS.includes(lower) || SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
      if (!sensitive) {
        // 键名不敏感但值像密钥 → 也打码（兜底）
        if (rawValue !== '' && looksLikeSecret(decodeURIComponentSafe(rawValue))) {
          return `${rawKey}=${REDACT_CENSOR}`;
        }
        return pair;
      }
      return eq < 0 ? rawKey : `${rawKey}=${REDACT_CENSOR}`;
    })
    .join('&');
  return `${base}?${cleaned}`;
}

function decodeURIComponentSafe(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** 递归脱敏任意值（我们自己要打的结构化对象用；pino 的 redact 只覆盖 req/res） */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (typeof value !== 'object') return String(value);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p))) {
      out[k] = REDACT_CENSOR;
      continue;
    }
    if (typeof v === 'string') {
      if (looksLikeSecret(v)) {
        out[k] = REDACT_CENSOR;
        continue;
      }
      // ★ 长得像 URL/带查询串的字符串 → **清洗查询串**（保留可读性，只打码敏感参数值）。
      //   ⚠️ 原实现只靠"整串像密钥"来兜底：`?token=sk-…` 恰好因"高熵"被整段打码（**碰巧**不漏），
      //   而我把路径误判修掉之后，这个 URL 就直接漏了 —— **碰巧对的地方一旦修错就会真漏**。
      if (v.includes('?')) {
        out[k] = sanitizeUrl(v);
        continue;
      }
      out[k] = v;
      continue;
    }
    out[k] = redactDeep(v, depth + 1);
  }
  return out;
}

/**
 * 在一段日志文本里找敏感串（测试与**出口自检**用）。
 *
 * 用法：把"绝不该出现的东西"（如测试用的假密钥）逐一传进来，返回命中的那些。
 */
export function findSensitiveLeaks(text: string, secrets: readonly string[]): string[] {
  const blob = typeof text === 'string' ? text : '';
  return secrets.filter((s) => typeof s === 'string' && s.length >= 6 && blob.includes(s));
}
