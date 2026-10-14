/**
 * 口令哈希（`docs/RBAC.md` §7：**argon2id**）。
 *
 * 实测（本机 Node v24.15.0 + `argon2` npm 原生预编译包）：
 * ```
 * hash('secret-pw-123') → 前缀 $argon2id$   verify 正确口令 → true / 错误口令 → false
 * ```
 */

import argon2 from 'argon2';

/** argon2id 参数。内存/时间成本取 OWASP 推荐区间下限（本机 CLI 场景够用且不拖慢测试）。 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/** 哈希口令 → `$argon2id$...` 字符串（含随机 salt，同一口令两次结果不同）。 */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

/**
 * 校验口令。**永不抛**：哈希串损坏/为空时返回 false
 * （否则一个坏行会让登录接口 500，把"凭据错误"泄露成"服务器错误"）。
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  if (!hash || !plain) return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/** 口令强度下限（太短直接拒绝，避免 `COURSE_KB_BOOTSTRAP_ADMIN=a:1`）。 */
export const MIN_PASSWORD_LENGTH = 8;

export function passwordProblem(plain: string): string | null {
  if (!plain || plain.length < MIN_PASSWORD_LENGTH) {
    return `口令至少 ${MIN_PASSWORD_LENGTH} 位`;
  }
  return null;
}

/** 是否为合法的 argon2id 哈希串（诊断/自检用；不泄露内容）。 */
export function isArgon2idHash(value: string): boolean {
  return typeof value === 'string' && value.startsWith('$argon2id$');
}
