<script setup lang="ts">
/**
 * 虚拟滚动（F6：3 000 条字幕只渲染可视窗口的行）
 *
 * 窗口计算在 utils/vscroll.ts（纯函数，被 Vitest 直接断言），这里只做 DOM 绑定：
 * 固定行高 + 绝对定位 + 顶部占位撑开滚动条。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { computeWindow, scrollTopForIndex } from '../utils/vscroll'

const props = withDefaults(defineProps<{
  items: unknown[]
  rowHeight?: number
  overscan?: number
  activeIndex?: number
  /** 自动跟随（跟随播放位置滚动）；用户手动滚动后由父级置 false */
  autoFollow?: boolean
  emptyText?: string
}>(), { rowHeight: 42, overscan: 10, activeIndex: -1, autoFollow: true, emptyText: '（空）' })

const emit = defineEmits<{ (e: 'row-click', index: number): void; (e: 'user-scroll'): void }>()

const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportH = ref(400)

const win = computed(() => computeWindow(props.items.length, props.rowHeight, scrollTop.value, viewportH.value, props.overscan))
const visible = computed(() =>
  props.items.slice(win.value.first, win.value.last + 1).map((item, i) => ({ item, index: win.value.first + i })))

function onScroll() {
  const el = scroller.value
  if (!el) return
  scrollTop.value = el.scrollTop
}

function measure() {
  const el = scroller.value
  if (el) viewportH.value = el.clientHeight || 400
}

onMounted(() => { measure(); window.addEventListener('resize', measure) })

watch(() => props.activeIndex, (i) => {
  if (i == null || i < 0 || !props.autoFollow) return
  const el = scroller.value
  if (!el) return
  const top = scrollTopForIndex(i, props.rowHeight, viewportH.value, true)
  const rowTop = i * props.rowHeight
  const need = rowTop < el.scrollTop || rowTop + props.rowHeight > el.scrollTop + viewportH.value
  if (need) {
    el.scrollTop = top
    scrollTop.value = top
  }
})

defineExpose({
  scrollToIndex(i: number, center = false) {
    const el = scroller.value
    if (!el) return
    el.scrollTop = scrollTopForIndex(i, props.rowHeight, viewportH.value, center)
    scrollTop.value = el.scrollTop
  },
  window: win,
  element: () => scroller.value,
})
</script>

<template>
  <div
    ref="scroller"
    class="vscroll"
    data-testid="vscroll"
    :data-total="items.length"
    :data-dom-rows="visible.length"
    :data-row-height="rowHeight"
    @scroll.passive="onScroll"
    @wheel.passive="emit('user-scroll')"
    @touchstart.passive="emit('user-scroll')"
  >
    <div class="vscroll-spacer" :style="{ height: win.totalHeight + 'px' }">
      <div class="vscroll-window" :style="{ transform: `translateY(${win.offsetY}px)` }">
        <div
          v-for="v in visible"
          :key="v.index"
          class="vscroll-row"
          :class="{ active: v.index === activeIndex }"
          :data-index="v.index"
          :data-start="(v.item as any)?.start ?? ''"
          :style="{ height: rowHeight + 'px' }"
          @click="emit('row-click', v.index)"
        >
          <slot :item="v.item" :index="v.index" />
        </div>
      </div>
    </div>
    <div v-if="!items.length" class="loading">{{ emptyText }}</div>
  </div>
</template>

<style scoped>
/* 字幕表 = 手册的"行号栏"：细线分隔 + 当前行左侧朱红竖条（高度必须与 rowHeight 一致） */
.vscroll { height: 60vh; min-height: 320px; overflow: auto; border: var(--hair) solid var(--rule);
  border-top: 2px solid var(--rule-strong); border-radius: var(--r-sm); background: var(--panel); position: relative; }
.vscroll-spacer { position: relative; width: 100%; }
.vscroll-window { position: absolute; top: 0; left: 0; right: 0; }
.vscroll-row { display: flex; align-items: center; gap: 8px; padding: 0 10px;
  border-bottom: var(--hair) solid var(--rule); border-left: 2px solid transparent;
  cursor: pointer; overflow: hidden; font-size: 13px; box-sizing: border-box; }
.vscroll-row:hover { background: var(--paper-2); }
.vscroll-row.active { background: color-mix(in srgb, var(--accent-soft) 60%, var(--panel));
  border-left-color: var(--accent); font-weight: 600; }
</style>

