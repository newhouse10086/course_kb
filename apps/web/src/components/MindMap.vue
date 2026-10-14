<script setup lang="ts">
/**
 * 思维导图（F6-S6）：markmap 兼容 Markdown → 可折叠树
 * 解析在 utils/markmap.ts（纯函数），这里只做渲染与折叠状态。
 * 行内带时间锚（`(01:23)` / `@83s`）时给"▶ 跳到该时间点"按钮 → 与播放器联动。
 */
import { computed, ref, watch } from 'vue'
import { parseMindmap, type MindNode } from '../utils/markmap'
import { esc, fmtMs } from '../utils/text'

const props = defineProps<{ markdown: string | null | undefined; defaultCollapsedFrom?: number }>()
const emit = defineEmits<{ (e: 'seek', ms: number): void }>()

const tree = computed(() => parseMindmap(props.markdown || ''))
const collapsed = ref<Set<string>>(new Set())

function rebuildCollapsed() {
  const s = new Set<string>()
  const from = props.defaultCollapsedFrom ?? 3
  const walk = (n: MindNode, depth: number, path: string) => {
    n.children.forEach((c, i) => {
      const id = `${path}/${i}`
      if (depth >= from) s.add(id)
      walk(c, depth + 1, id)
    })
  }
  walk(tree.value.root, 1, '')
  collapsed.value = s
}
watch(tree, rebuildCollapsed, { immediate: true })

function toggle(id: string) {
  const s = new Set(collapsed.value)
  if (s.has(id)) s.delete(id); else s.add(id)
  collapsed.value = s
}

function expandAll() { collapsed.value = new Set() }
function collapseAll() {
  const s = new Set<string>()
  const walk = (n: MindNode, path: string) => {
    n.children.forEach((c, i) => {
      const id = `${path}/${i}`
      if (c.children.length) s.add(id)
      walk(c, id)
    })
  }
  walk(tree.value.root, '')
  collapsed.value = s
}

defineExpose({ expandAll, collapseAll, nodeCount: computed(() => tree.value.count), collapsedCount: computed(() => collapsed.value.size) })
</script>

<template>
  <div class="mindmap" data-testid="mindmap" :data-nodes="tree.count" :data-collapsed="collapsed.size">
    <div v-if="!tree.count" class="note warn">后端未产出思维导图（<code>/video/mindmap</code> 为空）。按 F6-S6 应由 LLM 生成 markmap 大纲；此处如实留空，不编造结构。</div>
    <template v-else>
      <div class="mm-toolbar">
        <button type="button" data-testid="mm-expand" @click="expandAll">全部展开</button>
        <button type="button" data-testid="mm-collapse" @click="collapseAll">全部折叠</button>
        <span class="faint small">{{ tree.count }} 节点 · 最大深度 {{ tree.maxDepth }}</span>
      </div>
      <div class="mm-tree">
        <template v-for="(n, i) in tree.root.children" :key="i">
          <div class="mm-node mm-l1" :class="{ collapsed: collapsed.has(`/${i}`) }">
            <div class="mm-head">
              <span class="mm-toggle" role="button" :data-testid="`mm-toggle-${i}`" @click="toggle(`/${i}`)">{{ n.children.length ? (collapsed.has(`/${i}`) ? '▸' : '▾') : '·' }}</span>
              <span class="mm-text" v-html="esc(n.text)" />
              <button v-if="n.at != null" class="mm-seek" type="button" :data-at="n.at" @click="emit('seek', n.at!)">▶ {{ fmtMs(n.at) }}</button>
            </div>
            <div class="mm-children">
              <template v-for="(c, j) in n.children" :key="j">
                <div class="mm-node mm-l2" :class="{ collapsed: collapsed.has(`/${i}/${j}`) }">
                  <div class="mm-head">
                    <span class="mm-toggle" role="button" @click="toggle(`/${i}/${j}`)">{{ c.children.length ? (collapsed.has(`/${i}/${j}`) ? '▸' : '▾') : '·' }}</span>
                    <span class="mm-text" v-html="esc(c.text)" />
                    <button v-if="c.at != null" class="mm-seek" type="button" :data-at="c.at" @click="emit('seek', c.at!)">▶ {{ fmtMs(c.at) }}</button>
                  </div>
                  <div class="mm-children">
                    <div v-for="(d, k) in c.children" :key="k" class="mm-node mm-l3">
                      <div class="mm-head">
                        <span class="mm-toggle">·</span>
                        <span class="mm-text" v-html="esc(d.text)" />
                        <button v-if="d.at != null" class="mm-seek" type="button" :data-at="d.at" @click="emit('seek', d.at!)">▶ {{ fmtMs(d.at) }}</button>
                      </div>
                    </div>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 思维导图：**线的层级 + 缩进**表达结构，不用彩色盒子（§7.4） */
.mm-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.mm-tree { font-size: 13.5px; }
.mm-node { margin-left: 14px; border-left: var(--hair) solid var(--rule); padding-left: 8px; }
.mm-node.collapsed > .mm-children { display: none; }
.mm-head { display: flex; align-items: flex-start; gap: 5px; padding: 1px 0; }
.mm-toggle {
  width: 14px; flex: 0 0 14px; cursor: pointer; color: var(--muted);
  user-select: none; text-align: center; font-family: var(--font-mono); font-size: 10px;
}
.mm-l1 > .mm-head { font-family: var(--font-display); font-weight: 700; font-size: 15px; }
.mm-l1 { border-left: 2px solid var(--rule-strong); }
.mm-l2 > .mm-head { font-weight: 600; }
.mm-seek {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: .04em;
  padding: 0 6px; border: var(--hair) solid var(--rule-strong); border-radius: var(--r-sm);
  background: var(--panel); color: var(--accent-ink); cursor: pointer;
}
.mm-seek:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent-soft) 50%, transparent); }
</style>

