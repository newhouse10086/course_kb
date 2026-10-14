/** ID 生成（契约 §1.1：`<前缀>_<12位随机>`，如 `doc_a1b2c3d4e5f6`）。 */

import crypto from 'node:crypto';

const HEX = '0123456789abcdef';

/** `<prefix>_` + 12 位十六进制（6 字节随机）。 */
export function newId(prefix: string): string {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (const b of bytes) {
    out += HEX[b >> 4] as string;
    out += HEX[b & 0x0f] as string;
  }
  return `${prefix}_${out}`;
}

export const newDocId = (): string => newId('doc');
export const newTaskId = (): string => newId('tsk');
export const newUnitId = (): string => newId('unt');
export const newCardId = (): string => newId('crd');
export const newEntityId = (): string => newId('ent');
export const newEdgeId = (): string => newId('edg');
// RBAC（docs/RBAC.md §3）
export const newUserId = (): string => newId('usr');
export const newCourseId = (): string => newId('crs');
export const newNoteId = (): string => newId('not');
export const newConversationId = (): string => newId('cnv');
export const newAuditId = (): string => newId('aud');

/** 顺序 id（单元/卡片在 worker 结果里的稳定编号，便于断点续跑定位）。 */
export function seqId(prefix: string, n: number): string {
  return `${prefix}_${String(n).padStart(4, '0')}`;
}

/**
 * 规范化名（契约 §3 `cards.name_key`：小写 + 去空格）→ 交叉引用/实体归并的键。
 * 只做这两件事（契约字面），**不剥离领域关键词**（坑 1：曾因过度归一化丢语义）。
 */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '');
}
