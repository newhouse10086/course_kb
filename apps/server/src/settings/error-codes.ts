/**
 * 本模块用到的契约错误码（**声明式引用，不另建错误体系**）。
 *
 * `E_MODEL_BUSY`(409) / `E_MODEL_PROBE`(502) 已由 `backend-api` 加进
 * `src/store/errors.ts::ERROR_HTTP` —— 所以这里**只做类型收窄**，
 * 抛出时一律用 `new ApiError(code, msg, { detail, hint })`（唯一错误体系）。
 *
 * ⚠️ 历史：本模块曾有一个 `ContractApiError` 子类（在 `ERROR_HTTP` 还没有这两个码时
 * 用 `Object.defineProperty` 覆写 `code`/`httpStatus` 顶上）。码补齐后**已删除** ——
 * 两份错误体系必然在状态码/形状/脱敏上漂移。
 */

import type { ErrorCode } from '../store/errors.ts';

/** 设置/模型切换相关的契约码（取值即 `ErrorCode` 的子集，编译期保证不会写错字）。 */
export const SETTINGS_ERROR_CODES = ['E_MODEL_BUSY', 'E_MODEL_PROBE', 'E_BADREQUEST', 'E_UNAUTHENTICATED', 'E_FORBIDDEN'] as const;

export type SettingsErrorCode = (typeof SETTINGS_ERROR_CODES)[number];

/** 编译期断言：上面每个码都必须在 `ERROR_HTTP` 里存在（写错会在这里报 TS 错）。 */
const _assertCodesExist: readonly ErrorCode[] = SETTINGS_ERROR_CODES;
void _assertCodesExist;
