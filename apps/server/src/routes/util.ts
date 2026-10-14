/** 路由公共工具（错误 → 契约 §8 响应体；查询参数解析）。 */

import type { FastifyReply } from 'fastify';

import { ApiError, notFound } from '../store/errors.ts';

/** 统一错误响应：`{ error: { code, msg, detail?, hint? } }`（契约 §8）。 */
export function errorBody(err: unknown): { status: number; body: unknown } {
  if (err instanceof ApiError) {
    return { status: err.httpStatus, body: err.toBody() };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: { error: { code: 'E_INTERNAL', msg, hint: '服务内部错误；详情见服务端日志' } },
  };
}

export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const { status, body } = errorBody(err);
  return reply.code(status).send(body);
}

export function intParam(v: unknown, dflt: number, opts: { min?: number; max?: number } = {}): number {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  let out = Number.isFinite(n) ? n : dflt;
  if (opts.min !== undefined) out = Math.max(opts.min, out);
  if (opts.max !== undefined) out = Math.min(opts.max, out);
  return out;
}

export function strParam(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** `?offset&limit`（契约 §1.1：默认 limit=50，响应含 total）。 */
export function pageParams(query: Record<string, unknown>, dfltLimit = 50): { offset: number; limit: number } {
  return {
    offset: intParam(query.offset, 0, { min: 0 }),
    limit: intParam(query.limit, dfltLimit, { min: 1, max: 1000 }),
  };
}

export function requireDoc<T>(v: T | undefined, id: string, what = 'document'): T {
  if (v === undefined || v === null) throw notFound(what, id);
  return v;
}

/** Fastify 的 404（未匹配路由）也要是契约形状。 */
export const NOT_FOUND_JSON = { error: { code: 'E_NOTFOUND', msg: '接口不存在' } };

/** 支持的格式说明（`E_FORMAT` 的 detail 用；v1 测试断言 detail 里含 `.pdf`）。 */
export function supportedFormatsHint(exts: string[]): string {
  return `支持的格式：${exts.join(' ')}（新增格式只需实现 worker adapter，核心不改，契约 §4）`;
}
