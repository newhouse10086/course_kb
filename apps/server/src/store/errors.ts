/**
 * 错误码（契约 `docs/API_PROTOCOL.md` §8 + §7.3.1 ⚠️8 的扩展码）。
 *
 * 响应体形状（契约 §8）：
 * ```json
 * { "error": { "code": "E_ASR_LOAD", "msg": "...", "detail": "…", "hint": "…" } }
 * ```
 */

export const ERROR_HTTP = {
  E_NOFILE: 400,
  E_FORMAT: 415,
  E_TOOBIG: 413,
  E_NOTFOUND: 404,
  E_PARSE: 422,
  E_LLM: 502,
  E_LLM_SCHEMA: 502,
  E_ASR_LOAD: 503,
  E_FFMPEG: 500,
  E_PI_EXIT: 502,
  E_PI_TIMEOUT: 504,
  E_BUSY: 429,
  // ── ⚠️8 扩展码（契约 §7.3.1）：区分「命令失败」与「进程退出」，避免误导排查方向 ──
  E_PI_CMD: 502,
  E_PI_PROTOCOL: 502,
  E_PI_UNAVAILABLE: 503,
  E_PI_SESSION_ID: 400,
  // ── v2 新增：Python worker 子进程层（契约 §3.1 协议；v1 无 CLI worker，故无对应码）──
  E_WORKER: 500,
  E_WORKER_PROTOCOL: 502,
  E_WORKER_TIMEOUT: 504,
  E_WORKER_EXIT: 502,
  E_WORKER_UNAVAILABLE: 503,
  // ── RBAC（docs/RBAC.md §4/§5/§7/§9）：这套码由 RBAC 文档定义，不是自造 ──
  E_UNAUTHENTICATED: 401,
  E_FORBIDDEN: 403,
  E_ACCOUNT_DISABLED: 403,
  E_QUOTA: 429,
  E_RATELIMIT: 429,
  E_CONFLICT: 409,
  // ── 内部 ──
  E_INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP;

export interface ErrorBody {
  error: {
    code: ErrorCode;
    msg: string;
    detail?: string;
    hint?: string;
  };
}

/**
 * 业务异常。`msg` 面向用户、`detail` 面向排查、`hint` 面向"怎么办"。
 * ⚠️ 三者都**不得包含凭据**（构造前请过 `redact()`）。
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly detail: string | undefined;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, msg: string, opts: { detail?: string; hint?: string; cause?: unknown } = {}) {
    super(msg);
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus = ERROR_HTTP[code];
    this.detail = opts.detail;
    this.hint = opts.hint;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }

  toBody(): ErrorBody {
    const error: ErrorBody['error'] = { code: this.code, msg: this.message };
    if (this.detail !== undefined) error.detail = this.detail;
    if (this.hint !== undefined) error.hint = this.hint;
    return { error };
  }
}

export function notFound(what: string, id: string): ApiError {
  return new ApiError('E_NOTFOUND', `${what} 不存在：${id}`, {
    detail: `${what} id = ${id}`,
    hint: '确认 id 是否正确；文档可能已被删除',
  });
}
