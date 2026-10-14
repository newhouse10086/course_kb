<script setup lang="ts">
/**
 * 交叉引用区 + 反链（FUNCTIONAL_SPEC F4：wiki 的本质是页面互相引用）
 *
 * 四路来源（契约 §2.5，顺序即优先级）：typed / mention / also_in / same_unit，
 * 外加**反链**（谁引用了我）—— 后者是 wiki 的精髓，单列一组。
 * 点击交给父级处理（跨单元跳转 + 高亮定位）。
 */
import { computed } from 'vue'
import type { Card } from '../api/types'
import type { XrefIndex } from '../graph/subgraph'
import { REL_ZH } from '../utils/text'

const props = defineProps<{
  card: Card
  xrefs: XrefIndex
  cardsById: Map<string, Card>
  limit?: number
}>()
const emit = defineEmits<{ (e: 'goto', cardId: string): void }>()

const ORDER = ['typed', 'mention', 'also_in', 'same_unit'] as const

const outGroups = computed(() => {
  const out = props.xrefs.out.get(props.card.id) || []
  const groups: Array<{ rel: string; items: typeof out }> = []
  for (const rel of ORDER) {
    const items = out.filter((x) => x.rel === rel)
    if (items.length) groups.push({ rel, items })
  }
  for (const x of out) {
    if (!ORDER.includes(x.rel as any)) {
      const g = groups.find((gg) => gg.rel === x.rel)
      if (g) g.items.push(x)
      else groups.push({ rel: x.rel, items: [x] })
    }
  }
  return groups
})

const backlinks = computed(() => props.xrefs.in.get(props.card.id) || [])
const nameOf = (id: string) => props.cardsById.get(id)?.name || id
const cap = (arr: any[]) => arr.slice(0, props.limit || 60)
</script>

<template>
  <div class="xref" :data-card="card.id" data-testid="xref">
    <template v-for="g in outGroups" :key="g.rel">
      <div class="xref-h" :data-rel="g.rel">{{ REL_ZH[g.rel] || g.rel }}（{{ g.items.length }}）</div>
      <div class="xref-list">
        <a
          v-for="x in cap(g.items)"
          :key="g.rel + x.id"
          class="xr"
          :class="g.rel"
          :href="`#card-${x.id}`"
          :data-goto-card="x.id"
          :data-rel="g.rel"
          :title="`${REL_ZH[g.rel] || g.rel}：${nameOf(x.id)}`"
          @click.prevent="emit('goto', x.id)"
        >{{ nameOf(x.id) }}</a>
      </div>
    </template>

    <template v-if="backlinks.length">
      <div class="xref-h" data-rel="backlinks">反链 · 谁引用了我（{{ backlinks.length }}）</div>
      <div class="xref-list">
        <a
          v-for="x in cap(backlinks)"
          :key="'back' + x.id + x.rel"
          class="xr back"
          :href="`#card-${x.id}`"
          :data-goto-card="x.id"
          data-rel="backlink"
          :title="`被引用于：${nameOf(x.id)}（${REL_ZH[x.rel] || x.rel}）`"
          @click.prevent="emit('goto', x.id)"
        >← {{ nameOf(x.id) }} <span class="t">{{ REL_ZH[x.rel] || x.rel }}</span></a>
      </div>
    </template>

    <div v-if="!outGroups.length && !backlinks.length" class="faint small">（本卡片暂无引用）</div>
  </div>
</template>
