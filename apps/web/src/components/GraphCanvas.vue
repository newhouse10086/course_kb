<script setup lang="ts">
/**
 * 通用图谱画布（自绘，零第三方图库）
 *
 * 只做三件事：把数据交给 GraphEngine、把引擎事件转成 Vue 事件、把性能统计暴露出去
 * （`data-*` 属性 + expose 的 stats() —— 无头测试断言 canvas 内容看不到，只能断言这些）。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { GraphEngine, type EngineEdge, type EngineNode, type EngineOptions, type EngineStats } from '../graph/engine'
import type { GEdge, GNode } from '../graph/subgraph'

const props = withDefaults(defineProps<{
  nodes: GNode[]
  edges: GEdge[]
  height?: number
  labels?: 'auto' | 'all' | 'none'
  colorBy?: 'type' | 'layer'
  labelMinDegree?: number
  maxLabels?: number
  maxTicks?: number
  focusId?: string | null
  autostart?: boolean
}>(), {
  height: 420, labels: 'auto', colorBy: 'type', labelMinDegree: 3, maxLabels: 140,
  maxTicks: 420, focusId: null, autostart: true,
})

const emit = defineEmits<{
  (e: 'node-click', n: EngineNode): void
  (e: 'edge-click', e2: EngineEdge): void
  (e: 'background'): void
  (e: 'settled', s: EngineStats): void
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
const engine = shallowRef<GraphEngine | null>(null)
const stats = ref<EngineStats | null>(null)

let ro: ResizeObserver | null = null

function build() {
  if (!canvas.value) return
  engine.value?.destroy()
  const opts: EngineOptions = {
    height: props.height,
    labels: props.labels,
    colorBy: props.colorBy,
    labelMinDegree: props.labelMinDegree,
    maxLabels: props.maxLabels,
    maxTicks: props.maxTicks,
    onNodeClick: (n) => emit('node-click', n),
    onEdgeClick: (e) => emit('edge-click', e),
    onBackground: () => emit('background'),
    onSettled: (s) => { stats.value = s; emit('settled', s) },
  }
  const g = new GraphEngine(canvas.value, opts)
  g.setData(props.nodes, props.edges)
  if (props.autostart) g.start()
  g.zoomToFit()
  engine.value = g
  stats.value = g.stats()
  // ⚠️ 挂载瞬间 flex 版式可能还没算出宽度（clientWidth=0）→ 画布画出来是空的。
  //    双保险：本帧结束再量一次 + ResizeObserver 跟着容器走。
  requestAnimationFrame(() => { g.resize(); g.zoomToFit(); g.repaint() })
}

onMounted(() => {
  build()
  window.addEventListener('resize', onResize)
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => onResize())
    if (canvas.value?.parentElement) ro.observe(canvas.value.parentElement)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  ro?.disconnect()
  ro = null
  engine.value?.destroy()
})

function onResize() {
  engine.value?.resize()
  engine.value?.zoomToFit()
  engine.value?.repaint()
}

/**
 * 只在**数据引用真的换了**时重建。
 * ⚠️ 写成 `watch(() => [props.nodes, props.edges], ...)` 是错的：每次求值都返回**新数组**，
 *    Vue 的 `hasChanged` 永远为真 → 每次渲染都重建引擎（实测表现：布局只跑 2 tick、画布空白）。
 */
watch([() => props.nodes, () => props.edges], () => { build() })
watch(() => props.focusId, (id) => {
  if (id && engine.value) { engine.value.select(id); engine.value.centerOn(id) }
})

defineExpose({
  engine,
  stats,
  relayout: () => { engine.value?.relayout(); engine.value?.start() },
  fit: () => engine.value?.zoomToFit(),
  select: (id: string | null) => engine.value?.select(id),
  centerOn: (id: string) => engine.value?.centerOn(id),
  setFilter: (f: Parameters<GraphEngine['setFilter']>[0]) => engine.value?.setFilter(f),
  benchTicks: (n?: number) => engine.value?.benchTicks(n),
})
</script>

<template>
  <div class="canvas-wrap" :data-nodes="nodes.length" :data-edges="edges.length">
    <canvas
      ref="canvas"
      class="graph-canvas"
      :data-drawn="stats?.drawn_nodes ?? 0"
      :data-ticks="stats?.ticks ?? 0"
      :data-frame-p50="stats?.frame_ms_p50 ?? ''"
    />
  </div>
</template>

<style scoped>
.canvas-wrap { position: relative; width: 100%; background: var(--canvas-bg); border-radius: var(--r-sm); overflow: hidden; }
.graph-canvas { display: block; width: 100%; }
</style>

