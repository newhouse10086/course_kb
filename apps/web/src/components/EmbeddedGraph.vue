<script setup lang="ts">
/**
 * ★ Wiki 页内嵌图谱（用户核心要求："我希望你会把 LLM wiki 的图谱也可以进行可视化"）
 *
 * 形态：**当前单元的局部子图** = 单元内实体（`node.unit_ids` 命中） + 一跳邻居，
 * 画在页面内的 canvas 上，右侧同时给出可点击的节点清单（键盘可达、也能被无头测试断言）。
 *
 * 两个兜底（防后端实现与契约不一致时页面直接空掉）：
 *   · `/graph` 没给 `unit_ids` → 用**本单元卡片名反查实体**作为种子（seed_source=card_names）
 *   · 实体没有同名卡片 → 节点仍显示，但标记 `data-no-card`，不跳转到不存在的卡片
 */
import { computed, ref, watch } from 'vue'
import type { Card, GraphData } from '../api/types'
import { cardNeighborhood, localSubgraph, type XrefIndex } from '../graph/subgraph'
import { ETYPE_COLORS, etypeColor, etypeZh, typeColor, typeZh } from '../graph/palette'
import { nameKey, esc } from '../utils/text'
import GraphCanvas from './GraphCanvas.vue'

const props = defineProps<{
  docId: string
  unitId: string
  unitIds: string[]
  title?: string
  cards: Card[]
  cardsById: Map<string, Card>
  xrefs: XrefIndex
  graph: GraphData | null
  activeCardId?: string | null
  /** 'unit' = 当前单元局部子图；'card' = 卡片级迷你关系图 */
  mode?: 'unit' | 'card'
  height?: number
}>()

const emit = defineEmits<{ (e: 'goto-card', cardId: string): void }>()

const collapsed = ref(false)
const canvasRef = ref<InstanceType<typeof GraphCanvas> | null>(null)
const lastStats = ref<Record<string, number | string | null> | null>(null)

/** 实体名 → 卡片（name / name_zh 两种口径，规范化与后端 name_key 一致） */
const entityToCard = computed(() => {
  const m = new Map<string, Card>()
  const byKey = new Map<string, Card>()
  for (const c of props.cardsById.values()) {
    const k = nameKey(c.name)
    if (k && !byKey.has(k)) byKey.set(k, c)
  }
  for (const n of props.graph?.nodes || []) {
    for (const nm of [n.name, n.name_zh]) {
      const k = nameKey(nm || '')
      const c = k ? byKey.get(k) : undefined
      if (c) { m.set(String(n.id), c); break }
    }
  }
  return m
})

const sub = computed(() => {
  if (props.mode === 'card') {
    const cid = props.activeCardId || props.cards[0]?.id
    if (!cid) return { nodes: [], edges: [], seed_count: 0, seed_source: 'none' as const }
    return cardNeighborhood(cid, props.xrefs, props.cardsById, 26)
  }
  const seedIds = props.cards.map((c) => findEntityId(c)).filter(Boolean) as string[]
  const focusId = props.activeCardId ? findEntityId(props.cardsById.get(props.activeCardId) as Card) : null
  return localSubgraph(
    { nodes: props.graph?.nodes || [], edges: props.graph?.edges || [] },
    { unitIds: props.unitIds, seedIds, focusId, hops: 1, maxNodes: 160 },
  )
})

function findEntityId(card: Card | undefined | null): string | null {
  if (!card) return null
  const k = nameKey(card.name)
  for (const [id, c] of entityToCard.value) if (c.id === card.id) return id
  for (const n of props.graph?.nodes || []) {
    if (nameKey(n.name) === k || nameKey(n.name_zh || '') === k) return String(n.id)
  }
  return null
}

const mappedCount = computed(() => sub.value.nodes.filter((n) => entityToCard.value.has(n.id)).length)
const flaggedCount = computed(() => sub.value.edges.filter((e) => e.flagged).length)
const legend = computed(() => {
  const items: Array<{ kind: 'dot' | 'line'; color: string; label: string; dashed?: boolean }> = []
  for (const t of new Set(sub.value.nodes.map((n) => n.type).filter(Boolean))) {
    items.push({ kind: 'dot', color: typeColor(t), label: typeZh(t) })
  }
  for (const e of new Set(sub.value.edges.map((e) => e.etype).filter(Boolean))) {
    items.push({ kind: 'line', color: etypeColor(e), label: etypeZh(e) })
  }
  if (flaggedCount.value) items.push({ kind: 'line', color: '#ffffff', label: 'flagged（因果可疑，虚线只标记不删除）', dashed: true })
  return items
})

const fullGraphHref = computed(() => {
  const q = new URLSearchParams({ doc: props.docId, unit: props.unitId })
  const first = sub.value.nodes.find((n) => entityToCard.value.has(n.id))
  if (first) q.set('focus', first.id)
  return `#/graph?${q.toString()}`
})

function nodeLabel(id: string, name: string, nameZh: string) {
  return nameZh || name
}

function onNodeClick(n: { id: string }) {
  const card = entityToCard.value.get(n.id)
  if (card) emit('goto-card', card.id)
}

watch(() => [props.unitId, props.activeCardId, props.graph], () => { lastStats.value = null })
</script>

<template>
  <section
    class="graph-panel"
    id="embedded-graph"
    data-testid="embedded-graph"
    data-kind="wiki-embedded"
    :data-mode="mode || 'unit'"
    :data-nodes="sub.nodes.length"
    :data-edges="sub.edges.length"
    :data-seed-source="sub.seed_source"
    :data-seed-count="sub.seed_count"
    :data-flagged="flaggedCount"
    :data-mapped="mappedCount"
  >
    <header class="gp-head">
      <b>{{ mode === 'card' ? '关系图（该卡片的一跳引用）' : '本单元知识图谱（内嵌局部子图）' }}</b>
      <span class="small muted" data-testid="embedded-counts">
        {{ sub.nodes.length }} 节点 / {{ sub.edges.length }} 边
        <template v-if="mode !== 'card'">（{{ sub.seed_count }} 个种子 + 一跳邻居<span v-if="sub.seed_source === 'card_names'">，种子来自卡片名反查</span>）</template>
      </span>
      <span class="right" />
      <button type="button" @click="canvasRef?.relayout()">重新布局</button>
      <button type="button" @click="canvasRef?.fit()">适应画布</button>
      <a class="nav-link" :href="fullGraphHref" target="_blank" rel="noopener" data-testid="open-full-graph">在完整图谱中打开 ↗</a>
      <button type="button" data-testid="embedded-toggle" @click="collapsed = !collapsed">{{ collapsed ? '展开' : '折叠' }}</button>
    </header>

    <div v-show="!collapsed" class="gp-body">
      <div class="gp-canvas">
        <GraphCanvas
          v-if="sub.nodes.length"
          ref="canvasRef"
          :nodes="sub.nodes"
          :edges="sub.edges"
          :height="height || 300"
          labels="auto"
          :label-min-degree="1"
          :max-labels="28"
          :max-ticks="260"
          :focus-id="activeCardId ? findEntityId(cardsById.get(activeCardId)) : null"
          @node-click="onNodeClick"
          @settled="(s) => (lastStats = { ticks: s.ticks, frames: s.frames, p50: s.frame_ms_p50 })"
        />
        <div v-else class="loading" style="color: #c9d3e0">
          本单元暂无图谱实体<br />
          <span class="small">（单元 {{ unitId }} 没有抽取到实体；这不是渲染失败）</span>
        </div>
      </div>

      <div class="gp-side">
        <div class="small muted">节点（点击跳到对应卡片；灰色 = 该实体暂无知识卡片）</div>
        <div class="node-chips" data-testid="embedded-nodes">
          <template v-for="n in sub.nodes.slice().sort((a, b) => b.degree - a.degree)" :key="n.id">
            <a
              v-if="entityToCard.get(n.id)"
              class="node-chip"
              :href="`#card-${entityToCard.get(n.id)!.id}`"
              :data-node-id="n.id"
              :data-goto-card="entityToCard.get(n.id)!.id"
              :class="{ hl: activeCardId && entityToCard.get(n.id)!.id === activeCardId }"
              :title="`${n.name} → 卡片《${entityToCard.get(n.id)!.name}》`"
              @click.prevent="emit('goto-card', entityToCard.get(n.id)!.id)"
            >
              <i :style="{ background: typeColor(n.type) }" />{{ nodeLabel(n.id, n.name, n.name_zh) }}
              <span class="faint">{{ n.degree }}</span>
            </a>
            <span
              v-else
              class="node-chip"
              data-no-card="1"
              :data-node-id="n.id"
              :title="`${n.name}（图谱里有这个实体，但还没有同名知识卡片）`"
            >
              <i :style="{ background: typeColor(n.type) }" />{{ nodeLabel(n.id, n.name, n.name_zh) }}
              <span class="faint">{{ n.degree }}</span>
            </span>
          </template>
          <span v-if="!sub.nodes.length" class="faint small">（无节点）</span>
        </div>

        <div class="small muted" style="margin-top: 10px">边（etype · 证据）</div>
        <div class="edge-list" data-testid="embedded-edges">
          <div v-for="(e, i) in sub.edges.slice(0, 40)" :key="e.id + i" class="edge-row" :data-etype="e.etype">
            <span class="etype" :style="{ borderColor: etypeColor(e.etype) }">{{ etypeZh(e.etype) }}</span>
            <span class="small">{{ e.src }} → {{ e.dst }}</span>
            <span v-if="e.flagged" class="pill bad tiny" data-flagged="1">flagged</span>
            <div v-if="e.evidence" class="evidence">{{ e.evidence.slice(0, 160) }}</div>
          </div>
          <span v-if="!sub.edges.length" class="faint small">（无边）</span>
        </div>
      </div>
    </div>

    <div v-show="!collapsed" class="gp-legend" data-testid="embedded-legend">
      <span v-for="(it, i) in legend" :key="i" class="legend-item">
        <i v-if="it.kind === 'dot'" class="legend-dot" :style="{ background: it.color }" />
        <i v-else class="legend-line" :class="{ dashed: it.dashed }" :style="{ borderTopColor: it.color }" />
        {{ it.label }}
      </span>
      <span v-if="!legend.length" class="faint small">（本子图没有实体/边）</span>
    </div>
  </section>
</template>

<style scoped>
.gp-canvas { flex: 1 1 auto; min-width: 0; }
.edge-list { max-height: 320px; overflow: auto; }
</style>

