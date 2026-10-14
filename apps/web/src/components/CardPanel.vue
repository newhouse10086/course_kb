<script setup lang="ts">
/**
 * 知识卡片（F2 五要素 + C8 原文跳转 + F5 卡片级迷你关系图）
 *
 * 字段全部来自契约 §2.3；`evidence_span` 是**可回溯锚点**：
 *   page → PDF `#page=N`；time → 视频 `currentTime`；slide → 幻灯片号
 * 能力门控：TTS 不可用时"朗读"按钮**禁用并在旁边写明原因**（PROVIDERS §7）。
 */
import { computed, ref } from 'vue'
import type { CapsModel } from '../api/capabilities'
import { cardSpan } from '../api/client'
import type { Card } from '../api/types'
import type { XrefIndex } from '../graph/subgraph'
import {
  KIND_ZH, LIFECYCLE_ZH, ROLE_ZH, USAGE_ZH, esc, fmtMs, fmtSpan, linkify, type NameIndex,
} from '../utils/text'
import EmbeddedGraph from './EmbeddedGraph.vue'
import XrefPanel from './XrefPanel.vue'

const props = defineProps<{
  card: Card
  docId: string
  docKind?: string
  index: NameIndex
  xrefs: XrefIndex
  cardsById: Map<string, Card>
  caps?: CapsModel | null
  active?: boolean
  /** 列表中的序号：只用于错峰淡入的 `--i`（与上面的 nameIndex 无关，别混用） */
  ordinal?: number
}>()
const emit = defineEmits<{ (e: 'goto', cardId: string): void }>()

const showMini = ref(false)
const span = computed(() => cardSpan(props.card))
const conf = computed(() => Number(props.card.confidence || 0))
const confClass = computed(() => (conf.value >= 0.8 ? '' : conf.value >= 0.5 ? 'low' : 'vlow'))

const ttsOk = computed(() => !!props.caps?.isAvailable('tts'))
const ttsReason = computed(() => props.caps?.reasonFor('tts') || 'TTS 能力未上报')

/** 右上角页码的短形态（视觉主角）：`p.1040` / `p.1040–1042` / `⏱ 12:34` / `帧 7` */
const pageLabel = computed(() => {
  const s = span.value
  if (!s || !s.kind) return 'p.—'
  if (s.kind === 'time') return `⏱ ${fmtMs(s.start)}`
  if (s.kind === 'slide') return `帧 ${s.start}`
  return s.end && s.end !== s.start ? `p.${s.start}–${s.end}` : `p.${s.start}`
})

const html = (text?: unknown) => linkify(text, { index: props.index, selfId: props.card.id, selfName: props.card.name })

/** 原文跳转（C8）：页码 / 时间戳必须可回溯 */
const source = computed(() => {
  const s = span.value
  if (!s || !s.kind) return { kind: 'none' as const, href: '', label: '原文位置缺失', note: '该卡片没有可回溯的 span' }
  if (s.kind === 'time') {
    return {
      kind: 'time' as const,
      href: `#/video?doc=${encodeURIComponent(props.docId)}&t=${s.start}`,
      label: `🎬 视频 ${fmtMs(s.start)}`,
      note: '跳到视频该时间点',
    }
  }
  const base = `/api/v1/documents/${encodeURIComponent(props.docId)}/file`
  const label = s.kind === 'page' ? `📖 原文 ${fmtSpan(s)}` : s.kind === 'slide' ? `📄 ${fmtSpan(s)}` : `📃 ${fmtSpan(s)}`
  return {
    kind: s.kind,
    href: s.kind === 'page' ? `${base}#page=${s.start}` : base,
    label,
    note: '在原始文件中定位（PDF 用 #page=N）',
  }
})
</script>

<template>
  <article
    class="kcard"
    :id="`card-${card.id}`"
    :data-card="card.id"
    :data-unit="card.unit_id || ''"
    :style="{ '--i': ordinal ?? 0 }"
    :class="{ hl: active }"
  >
    <header class="khead">
      <span class="kname">{{ card.name }}</span>
      <span class="kchips">
        <span v-if="card.kind" class="pill purple" data-chip="kind">{{ KIND_ZH[card.kind] || card.kind }}</span>
        <span v-if="card.usage_mode" class="pill orange">{{ USAGE_ZH[card.usage_mode] || card.usage_mode }}</span>
        <span v-if="card.operational_role" class="pill">{{ ROLE_ZH[card.operational_role] || card.operational_role }}</span>
      </span>
      <!-- ★ 页码是视觉主角：可点击、朱红、等宽（把"可核查性"变成美学符号） -->
      <a
        v-if="source.kind !== 'none'"
        class="page-ref"
        :href="source.href"
        :target="source.kind === 'time' ? '_self' : '_blank'"
        rel="noopener"
        :data-source-kind="source.kind"
        :data-source-value="span?.start ?? ''"
        :title="source.note"
      >{{ pageLabel }}</a>
      <span v-else class="page-ref" aria-disabled="true" data-source-kind="missing" :title="source.label">p.—</span>
      <button
        type="button"
        class="tts-btn"
        :disabled="!ttsOk"
        :data-gate-kind="ttsOk ? '' : 'tts'"
        :data-gate-reason="ttsOk ? '' : ttsReason"
        :title="ttsOk ? '朗读该知识点（TTS）' : `朗读不可用：${ttsReason}`"
      >🔊</button>
    </header>

    <div v-if="card.one_line" class="defrow">
      <div class="deflabel">是什么</div>
      <div class="deftext" v-html="html(card.one_line)" />
    </div>
    <div v-if="card.purpose" class="defrow">
      <div class="deflabel">能做什么</div>
      <div class="deftext" v-html="html(card.purpose)" />
    </div>
    <div v-if="card.example" class="defrow">
      <div class="deflabel">示例</div>
      <div class="deftext">
        <pre>{{ card.example }}</pre>
        <div v-if="card.example_explained" class="small muted" style="margin-top: 4px">
          <b>说明：</b><span v-html="html(card.example_explained)" />
        </div>
      </div>
    </div>
    <div v-if="card.prerequisites?.length" class="req">
      <b>前提：</b><span v-html="card.prerequisites.map((p) => html(p)).join('；')" />
    </div>
    <div v-if="card.cautions?.length" class="warn">
      <b>⚠ 注意：</b><span v-html="card.cautions.map((p) => html(p)).join('；')" />
    </div>
    <div v-if="card.lifecycle && card.lifecycle !== 'unknown'" class="req">
      <b>生效方式：</b>{{ LIFECYCLE_ZH[card.lifecycle] || card.lifecycle }}
    </div>

    <XrefPanel :card="card" :xrefs="xrefs" :cards-by-id="cardsById" @goto="(id) => emit('goto', id)" />

    <footer class="kfoot">
      <a
        v-if="source.kind !== 'none'"
        class="flink"
        :href="source.href"
        :target="source.kind === 'time' ? '_self' : '_blank'"
        rel="noopener"
        :data-source-kind="source.kind"
        :data-source-value="span?.start ?? ''"
        :title="source.note"
      >{{ source.label }}</a>
      <span v-else class="flink" aria-disabled="true" data-source-kind="missing" title="契约 §2.3 要求卡片有 evidence_span">
        {{ source.label }}
      </span>
      <button type="button" class="mini-toggle" :data-mini="card.id" @click="showMini = !showMini">
        {{ showMini ? '收起关系图' : '关系图' }}
      </button>
      <span class="conf" :class="confClass">置信度 {{ conf.toFixed(2) }} <i><b :style="{ width: `${Math.round(conf * 100)}%` }" /></i></span>
      <span v-if="card.evidence_quote" class="faint small evidence-quote" :title="card.evidence_quote">“{{ card.evidence_quote.slice(0, 60) }}{{ card.evidence_quote.length > 60 ? '…' : '' }}”</span>
    </footer>

    <div v-if="showMini" class="mini-host" :data-mini-host="card.id">
      <EmbeddedGraph
        mode="card"
        :doc-id="docId"
        :unit-id="card.unit_id || ''"
        :unit-ids="[]"
        :cards="[card]"
        :cards-by-id="cardsById"
        :xrefs="xrefs"
        :graph="{ nodes: [], edges: [] }"
        :active-card-id="card.id"
        :height="220"
        @goto-card="(id) => emit('goto', id)"
      />
    </div>
  </article>
</template>

<style scoped>
/* 朗读按钮保持"工具"体量：与页码同排，不抢视线 */
.tts-btn { padding: 0 7px; line-height: 1.5; }
.tts-btn:not(:disabled) { color: var(--accent-ink); border-color: var(--rule-strong); }
.evidence-quote { max-width: 46ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-body); }
.mini-host { margin-top: 8px; border-top: var(--hair) solid var(--rule); padding-top: 8px; }
</style>

