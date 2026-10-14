/**
 * 虚拟滚动（FUNCTIONAL_SPEC F6：vue-virtual-scroller → 原生实现，避免额外依赖）
 *
 * 纯函数在这里，DOM 绑定在 components/VirtualList.vue —— 这样窗口计算能被单测直接断言。
 * 3 000 条字幕一次性建 DOM 会明显卡顿，窗口化后 DOM 行数固定在 ~30 行。
 */

export interface WindowResult {
  first: number          // 首行索引（含 overscan）
  last: number           // 末行索引（含 overscan）
  offsetY: number        // 窗口整体偏移
  totalHeight: number    // 占位高度
  count: number          // 实际渲染行数
}

export function computeWindow(
  total: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 8,
): WindowResult {
  const totalHeight = Math.max(0, total * rowHeight)
  if (total <= 0 || rowHeight <= 0) {
    return { first: 0, last: -1, offsetY: 0, totalHeight: 0, count: 0 }
  }
  const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const visibleCount = Math.ceil((viewportHeight || 0) / rowHeight) + 1
  const first = Math.max(0, firstVisible - overscan)
  const last = Math.min(total - 1, firstVisible + visibleCount + overscan - 1)
  return {
    first,
    last,
    offsetY: first * rowHeight,
    totalHeight,
    count: last >= first ? last - first + 1 : 0,
  }
}

/** 让某一行进入视口时该滚动到哪里（居中可选） */
export function scrollTopForIndex(index: number, rowHeight: number, viewportHeight: number, center = false): number {
  const top = index * rowHeight
  if (center) return Math.max(0, top - (viewportHeight - rowHeight) / 2)
  return Math.max(0, top)
}
