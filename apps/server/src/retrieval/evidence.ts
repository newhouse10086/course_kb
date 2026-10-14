/**
 * ★ 规则 1 的**唯一收口点**：`RetrievedItem.evidence` 必填。
 *
 * > 没有可回溯锚点（页码/毫秒）的条目**不许进上下文**。
 * > 这是本产品"可核查"的根基，也是相对通用 AI 的差异化。
 *
 * ## 为什么必须"收口"而不是"各 retriever 自己记得填"
 * 三个 retriever 各自写 `if (!evidence) continue` 时，
 * 只要有一个忘了，就会**静默**把无锚点内容喂给 LLM —— 而且**看起来完全正常**。
 * 所以本模块提供单一函数，所有 retriever 的出口都必须过它，
 * 且**丢弃计数必须上报**（`dropped_no_evidence`）而不是吞掉。
 *
 * ⚠️ 与坑 16 / 坑 10 同类的教训：**"看起来成功"的 bug 比崩溃危险**。
 */

import type { RetrievedItem, RetrievedItemDraft } from './types.ts';
import { hasEvidence } from './types.ts';

export interface EnforceResult {
  items: RetrievedItem[];
  /** 因为缺锚点被丢弃的条数（**诚实计数**；>0 时调用方应写进 `reason`） */
  dropped: number;
}

/**
 * 过滤无锚点条目 + 截断到 `limit`。
 *
 * 顺序要紧：**先过滤再截断**。反过来的话，一个没锚点的高分条目会先占掉名额、
 * 再被丢掉 → 实际返回条数少于 limit（调用方以为"只有这么多"）。
 */
export function enforceEvidence(drafts: RetrievedItemDraft[], limit: number): EnforceResult {
  let dropped = 0;
  const kept: RetrievedItem[] = [];
  for (const d of drafts) {
    if (!hasEvidence(d)) {
      dropped += 1;
      continue;
    }
    kept.push(d);
    if (kept.length >= Math.max(1, Math.trunc(limit))) break;
  }
  return { items: kept, dropped };
}

/** 仅判定 + 计数（用在"先探后取"的场合，如 kg 的边 → 条目前置检查）。 */
export function isUsable(draft: RetrievedItemDraft): boolean {
  return hasEvidence(draft);
}
