<script setup lang="ts">
/**
 * 层次树 —— 数据来自 `/documents/{id}/outline`（契约 §5.2）
 *
 * 要点：
 * · **懒展开**：一次只建一层 DOM（样例 2458 个单元也不卡）
 * · **无内容节点显示 `–` 徽章**（验收项）；有卡片显示 `N 卡片`
 * · 过滤时切成扁平列表（含祖先路径），避免在几千节点里挖
 */
import { computed, ref, watch } from 'vue'
import type { Outline, OutlineNode } from '../api/types'
import { fmtSpan } from '../utils/text'

const props = defineProps<{ outline: Outline | null; activeId?: string | null }>()
const emit = defineEmits<{ (e: 'open', unitId: string): void }>()

const expanded = ref<Set<string>>(new Set())
const filter = ref('')
const mounted = ref(false)

watch(() => props.outline, () => {
  expanded.value = new Set()
  mounted.value = true
}, { immediate: true })

// 自动展开到当前节点（打开深链时用）
watch(() => props.activeId, (id) => {
  if (!id || !props.outline) return
  const chain = breadcrumb(id)
  chain.slice(0, -1).forEach((a) => expanded.value.add(a))
  expanded.value = new Set(expanded.value)
}, { immediate: true })

const nodes = computed<Record<string, OutlineNode>>(() => props.outline?.nodes || {})
const roots = computed(() => (props.outline?.roots || []).filter((r) => nodes.value[r]))

function node(id: string): OutlineNode | null { return nodes.value[id] || null }

function breadcrumb(id: string): string[] {
  const parentOf = new Map<string, string>()
  for (const [pid, n] of Object.entries(nodes.value)) {
    for (const c of n.children || []) parentOf.set(c, pid)
  }
  const chain: string[] = []
  let cur: string | undefined = id
  let guard = 0
  while (cur && guard++ < 40) {
    chain.unshift(cur)
    cur = parentOf.get(cur)
  }
  return chain
}

function toggle(id: string) {
  const s = new Set(expanded.value)
  if (s.has(id)) s.delete(id); else s.add(id)
  expanded.value = s
}

function isExpanded(id: string) { return expanded.value.has(id) }

function expandAllVisible() {
  const s = new Set(expanded.value)
  // 只展开"可见根 + 一层"，避免一键展开 2458 节点
  for (const r of roots.value) { s.add(r); for (const c of node(r)?.children || []) s.add(c) }
  expanded.value = s
}

function collapseAll() { expanded.value = new Set() }

const flatMatches = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return null
  const hits: Array<{ id: string; n: OutlineNode; path: string }> = []
  for (const [id, n] of Object.entries(nodes.value)) {
    if ((n.title || '').toLowerCase().includes(q)) {
      hits.push({ id, n, path: breadcrumb(id).slice(0, -1).map((a) => node(a)?.title || a).join(' › ') })
      if (hits.length >= 300) break
    }
  }
  return hits
})

const rows = computed(() => {
  const out: Array<{ id: string; n: OutlineNode; depth: number }> = []
  const walk = (id: string, depth: number) => {
    const n = node(id)
    if (!n) return
    out.push({ id, n, depth })
    if (isExpanded(id)) for (const c of n.children || []) walk(c, depth + 1)
  }
  roots.value.forEach((r) => walk(r, 0))
  return out
})

function badgeText(n: OutlineNode): string {
  const cards = Number(n.n_cards || 0)
  if (cards > 0) return `${cards} 卡片`
  return '–'        // 验收：无内容节点显示 – 徽章
}
</script>

<template>
  <aside class="sidebar" data-testid="tree">
    <div class="tree-tools">
      <input v-model="filter" type="text" placeholder="过滤章节…" aria-label="过滤章节" />
      <button type="button" @click="expandAllVisible">展开</button>
      <button type="button" @click="collapseAll">收起</button>
    </div>

    <div v-if="flatMatches" class="tree-flat">
      <div class="small muted" style="padding: 4px 6px">匹配 {{ flatMatches.length }} 个节点</div>
      <div
        v-for="m in flatMatches"
        :key="m.id"
        class="trow"
        :class="{ active: m.id === activeId }"
        :data-unit="m.id"
        :title="m.n.title"
        @click="emit('open', m.id)"
      >
        <span class="tw" />
        <span class="tt">{{ m.n.title }}</span>
        <span class="badge" :class="Number(m.n.n_cards) > 0 ? 'badge-cards' : 'badge-empty'">{{ badgeText(m.n) }}</span>
      </div>
    </div>

    <nav v-else class="tree">
      <div
        v-for="row in rows"
        :key="row.id"
        class="trow"
        :class="{ active: row.id === activeId }"
        :data-unit="row.id"
        :data-depth="row.depth"
        :style="{ paddingLeft: 6 + row.depth * 12 + 'px' }"
        :title="row.n.title"
        @click="emit('open', row.id)"
      >
        <span
          class="tw"
          :data-toggle="row.id"
          @click.stop="toggle(row.id)"
        >{{ (row.n.children || []).length ? (isExpanded(row.id) ? '▾' : '▸') : '' }}</span>
        <span class="tt">{{ row.n.title }}</span>
        <span class="badge" :class="Number(row.n.n_cards) > 0 ? 'badge-cards' : 'badge-empty'">{{ badgeText(row.n) }}</span>
        <span v-if="row.n.span" class="tpg">{{ fmtSpan(row.n.span) }}</span>
      </div>
      <div v-if="!rows.length" class="loading">目录为空或还在加载…</div>
    </nav>
  </aside>
</template>

<style scoped>
/* 目录 = 手册的"目次页"：密排行 + 细引导线 + 页码右对齐（mono） */
.sidebar {
  flex: 0 0 var(--sidebar-w);
  max-height: calc(100vh - 132px);
  overflow: auto;
  background: var(--panel);
  border: var(--hair) solid var(--rule);
  border-top: 2px solid var(--rule-strong);
  border-radius: var(--r-sm);
  padding: 8px 8px 12px;
  position: sticky;
  top: calc(var(--topbar-h) + 12px);
}
.tree-tools { display: flex; gap: 4px; margin-bottom: 8px; }
.tree-tools input { flex: 1; min-width: 0; }
.tree-tools button { padding: 3px 8px; }

.trow {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 6px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1.5;
  border-left: 2px solid transparent;
}
.trow:hover { background: var(--paper-2); border-left-color: var(--rule-strong); }
.trow.active {
  background: var(--accent-soft);
  border-left-color: var(--accent);
  color: var(--accent-ink);
  font-weight: 700;
}
.trow[data-depth="1"] { border-left-color: color-mix(in srgb, var(--rule) 80%, transparent); }
.trow .tw { width: 12px; flex: 0 0 12px; color: var(--muted); text-align: center; user-select: none; font-size: 10px; }
.trow .tt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trow .tpg { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .03em; color: var(--muted); }

.badge {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: .03em;
  padding: 0 4px;
  border-radius: var(--r-sm);
  white-space: nowrap;
  border: var(--hair) solid var(--rule-strong);
  background: var(--panel);
  color: var(--ink-2);
}
.badge-cards { color: var(--accent-ink); border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: color-mix(in srgb, var(--accent-soft) 50%, transparent); }
.badge-empty { color: var(--muted); border-style: dotted; background: transparent; }
.tree-flat .trow { border-bottom: var(--hair) solid var(--rule); }
</style>
