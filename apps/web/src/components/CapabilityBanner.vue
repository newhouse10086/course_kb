<script setup lang="ts">
/**
 * 能力横幅 —— 权威：docs/PROVIDERS.md §7
 *
 * 硬要求：`available:false` → **禁用入口 + 把 reason 显示给用户**，不允许"点了才报错"。
 * 这里把每个 kind 的状态摆出来（含**链上真正会用的那个 provider**），
 * 不可用的**永远**带原因文案；各能力互相独立（ASR 挂了不影响 TTS/翻译/LLM）。
 */
import { computed, ref } from 'vue'
import type { CapsModel } from '../api/capabilities'
import { bannerRows } from '../api/capabilities'

const props = defineProps<{ caps: CapsModel | null; compact?: boolean }>()
const open = ref(false)
const rows = computed(() => (props.caps ? bannerRows(props.caps) : []))
const downRows = computed(() => rows.value.filter((r) => !r.available))
</script>

<template>
  <div class="caps-bar" data-testid="caps-bar">
    <div class="caps-chips">
      <span
        v-for="r in rows"
        :key="r.kind"
        class="cap-chip"
        :class="{ ok: r.available, off: !r.available }"
        :data-cap="r.kind"
        :data-available="r.available ? 'true' : 'false'"
        :title="r.available ? `将使用：${r.used}` : `不可用：${r.reason}`"
      >
        <i />{{ r.label }} {{ r.available ? '可用' : '不可用' }}
      </span>
      <button v-if="downRows.length" class="cap-more" type="button" @click="open = !open">
        {{ open ? '收起' : `${downRows.length} 项能力不可用，原因 ▸` }}
      </button>
    </div>

    <!-- 不可用的原因必须能**直接读到**（不是藏在 title 里，也不需要用户先点开）：
         compact 显示第一条 + 折叠其余；非 compact 全部列出 -->
    <ul v-if="downRows.length" class="caps-reasons">
      <li
        v-for="r in (compact && !open ? downRows.slice(0, 1) : downRows)"
        :key="r.kind"
        class="gate-note"
        :data-gate-kind="r.kind"
      >
        <b>{{ r.label }} 不可用</b>：{{ r.reason }}
        <span v-if="r.configured" class="faint">（凭据已配置，但探测未通过）</span>
        <span v-else class="faint">（未配置）</span>
      </li>
      <li v-if="compact && !open && downRows.length > 1" class="faint small">
        另有 {{ downRows.length - 1 }} 项不可用（点上方按钮展开）
      </li>
    </ul>
    <div v-if="props.caps?.adapters?.length" class="caps-adapters small faint">
      适配器：{{ props.caps?.adapters?.join(' / ') }}
    </div>
  </div>
</template>

<style scoped>
.caps-bar { display: flex; flex-direction: column; gap: 3px; align-items: flex-start; }
.caps-chips { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.cap-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 0 6px;
  border: 1px solid var(--rule-strong);
  border-radius: var(--r-sm);                 /* 小圆角，不是胶囊 */
  background: var(--panel);
  color: var(--ink-2);
  cursor: help;
  white-space: nowrap;
}
.cap-chip i { width: 6px; height: 6px; display: inline-block; border-radius: 50%; background: var(--muted); }
.cap-chip.ok i { background: var(--ok); }
.cap-chip.off { border-color: var(--accent); color: var(--accent-ink); background: color-mix(in srgb, var(--accent-soft) 45%, transparent); }
.cap-chip.off i { background: var(--accent); }
.cap-more { padding: 0 7px; }
.caps-reasons { list-style: none; margin: 2px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.caps-adapters { margin-top: 2px; }
.caps-adapters { margin-top: 2px; }
</style>


