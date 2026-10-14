<script setup lang="ts">
/**
 * Graph —— 全屏知识图谱（F5）
 *   · 自绘力导向（components/GraphCanvas + graph/engine，零第三方图库）
 *   · 12 种 etype 筛选（12 色，来自 contracts/schema/edge_types.json 的封闭枚举）
 *   · flagged 边**虚线**（只标记不删除）
 *   · 节点大小 ∝ degree；点击节点看它的边与证据
 *   · `?focus=<ent_id>` 深链定位；`?selftest=1` 把真实筛选/点击结果写进报告
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useCaps } from '../composables/useCaps'
import { useCorpus, useDocuments } from '../composables/useCorpus'
import GraphCanvas from '../components/GraphCanvas.vue'
import { ETYPE_COLORS, ETYPE_ZH, LAYER_ZH, etypeColor, etypeZh, typeColor, typeZh } from '../graph/palette'
import { esc, fmtSpan } from '../utils/text'
import { queryFlag, queryValue, testBarrier, testBarrierDone, writeReport } from '../utils/report'
import type { GEdge, GNode } from '../graph/subgraph'
import type { Span } from '../api/types'
import type { EngineStats } from '../graph/engine'

const route = useRoute()
const { caps, error: capsError } = useCaps()
const docsApi = useDocuments()
const corpus = useCorpus()
const canvasRef = ref<InstanceType<typeof GraphCanvas> | null>(null)

const onEtypes = ref<Set<string>>(new Set(Object.keys(ETYPE_COLORS)))
const layer = ref('')
const minDegree = ref(0)
const flaggedOnly = ref(false)
const colorBy = ref<'type' | 'layer'>('type')
const labels = ref<'auto' | 'all' | 'none'>('auto')
const nodeQuery = ref('')
const focusId = ref<string | null>(queryValue('focus'))
const detailId = ref<string | null>(focusId.value)
const selectedEdge = ref<GEdge | null>(null)
const settleText = ref('—')
const fatal = ref('')
const perf = ref<Record<string, unknown> | null>(null)

const ALL_ETYPES = Object.keys(ETYPE_COLORS)
const counts = computed(() => {
  const c: Record<string, number> = {}
  for (const e of corpus.gEdges.value) {
    c[e.etype] = (c[e.etype] || 0) + 1
    if (e.flagged) c[`${e.etype}:flagged`] = (c[`${e.etype}:flagged`] || 0) + 1
  }
  return c
})
const flaggedCount = computed(() => corpus.gEdges.value.filter((e) => e.flagged).length)
const visibleStats = computed(() => {
  // ⚠️ `defineExpose` 暴露的 ref 在父组件侧**自动解包**：拿到的是值本身，不是 Ref。
  //    （第一版写成 `canvasRef.value?.stats.value` → 永远 undefined，性能与自检全错）
  const stats = canvasRef.value?.stats as unknown as
    { visible_nodes: number; visible_edges: number } | undefined
  return stats || {
    visible_nodes: corpus.gNodes.value.length,
    visible_edges: corpus.gEdges.value.length,
    flagged_edges: flaggedCount.value,
  }
})
const filteredNodes = computed(() => {
  const q = nodeQuery.value.trim().toLowerCase()
  return corpus.gNodes.value
    .filter((n) => !q || (n.name || '').toLowerCase().includes(q) || (n.name_zh || '').toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
    .sort((a, b) => b.degree - a.degree)
})
const topNodes = computed(() => corpus.gNodes.value.slice().sort((a, b) => b.degree - a.degree).slice(0, 60))
const detail = computed<GNode | null>(() => (detailId.value ? corpus.gNodes.value.find((n) => n.id === detailId.value) || null : null))
const outEdges = computed(() => (detailId.value ? corpus.gEdges.value.filter((e) => e.src === detailId.value) : []))
const inEdges = computed(() => (detailId.value ? corpus.gEdges.value.filter((e) => e.dst === detailId.value) : []))

function applyFilters() {
  canvasRef.value?.setFilter({
    etypes: onEtypes.value.size === ALL_ETYPES.length ? null : Array.from(onEtypes.value),
    layers: layer.value ? [layer.value] : null,
    minDegree: minDegree.value,
    flaggedOnly: flaggedOnly.value,
    colorBy: colorBy.value,
    labels: labels.value,
  })
}
function toggleEtype(k: string, on: boolean) {
  const s = new Set(onEtypes.value)
  if (on) s.add(k); else s.delete(k)
  onEtypes.value = s
  applyFilters()
}
function focusNode(id: string) {
  detailId.value = id
  focusId.value = id
  canvasRef.value?.select(id)
  canvasRef.value?.centerOn(id)
}
function showEdge(e: GEdge) { selectedEdge.value = e }
function edgeHref(e: GEdge): string {
  if (!e.span) return ''
  if (e.span.kind === 'page') return `/api/v1/documents/${encodeURIComponent(corpus.docId.value || '')}/file#page=${e.span.start}`
  if (e.span.kind === 'time') return `#/video?doc=${encodeURIComponent(corpus.docId.value || '')}&t=${e.span.start}`
  return ''
}

/** 图谱边的 span 只保证有 kind/start/end（契约允许扩展）→ 显示前收敛成 Span 类型 */
function spanOf(s: { kind: string; start: number; end: number }): Span {
  return { kind: s.kind as Span['kind'], start: s.start, end: s.end }
}

function buildPerf(phase: string, extra: Record<string, unknown> = {}) {
  const cv = canvasRef.value
  if (!cv?.engine) return null
  const s = (cv.stats as unknown as EngineStats) || cv.engine.stats()
  let bench: { n: number; total_ms: number; per_tick_ms: number } | null = null
  try { bench = cv.benchTicks(10) ?? null } catch { bench = null }
  const report = {
    ...s,
    bench,
    avg_frame_ms: s.frames ? Math.round((s.elapsed_ms / s.frames) * 100) / 100 : null,
    phase,
    doc: corpus.docId.value,
    ...extra,
  }
  perf.value = report as unknown as Record<string, unknown>
  writeReport('perf-report', report)
  settleText.value = `布局：${s.ticks} ticks / ${s.frames} 帧 / ${s.elapsed_ms} ms · 帧中位 ${s.frame_ms_p50 ?? '—'} ms · 物理 ${bench?.per_tick_ms ?? '—'} ms/tick`
  return report
}

async function waitSettle(maxMs = 20000) {
  const t0 = performance.now()
  while (canvasRef.value?.engine?.isRunning && performance.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 120))
  }
  return Math.round(performance.now() - t0)
}

async function boot() {
  testBarrier()
  try {
    const list = await docsApi.load()
    if (!list.length) {
      writeReport('perf-report', { error: 'no documents' })
      return
    }
    const want = String(route.query.doc || '')
    const chosen = list.find((d) => d.id === want) || list.find((d) => d.kind !== 'video' && d.status === 'ready') || list[0]
    const ok = await corpus.load(chosen.id)
    if (!ok) { fatal.value = corpus.error.value; writeReport('perf-report', { error: corpus.error.value }); return }
    await nextTick()
    applyFilters()
    if (focusId.value) focusNode(focusId.value)
    setTimeout(() => buildPerf('first'), 1200)
    if (queryFlag('selftest')) await runSelftest()
  } catch (e) {
    fatal.value = (e as Error).message
    writeReport('perf-report', { error: (e as Error).message })
  } finally {
    await testBarrierDone()
  }
}

/* ---------------- 自检 ---------------- */

async function runSelftest() {
  const checks: Record<string, unknown> = {}
  const failed: string[] = []
  const rec = (k: string, v: unknown) => { checks[k] = v }
  const need = (k: string, cond: boolean) => { if (!cond) failed.push(k) }

  await waitSettle(25000)
  // ⚠️ 每次都用当前引擎：GraphCanvas 的数据/尺寸变化会重建引擎，捕获一次的旧实例可见集会对不上
  const engNow = () => canvasRef.value?.engine
  const eng = engNow()
  const s = eng?.stats()
  rec('caps_loaded', !!caps.value)
  rec('caps_error', capsError.value)
  rec('nodes', s?.nodes ?? 0)
  rec('edges', s?.edges ?? 0)
  rec('flagged_edges', s?.flagged_edges ?? 0)
  rec('etype_checkboxes', document.querySelectorAll('[data-testid="etype-filters"] input[type=checkbox]').length)
  rec('legend_dashed_flagged', document.querySelectorAll('[data-testid="graph-legend"] .legend-line.dashed').length)
  rec('radius_monotonic', (() => {
    const ns = corpus.gNodes.value.slice().sort((a, b) => a.degree - b.degree)
    if (ns.length < 2) return false
    const r0 = eng ? (eng.byId(ns[0].id)?.r ?? 0) : 0
    const r1 = eng ? (eng.byId(ns[ns.length - 1].id)?.r ?? 0) : 0
    return r1 > r0
  })())
  need('nodes', Number(checks.nodes) > 0)
  need('etype_checkboxes', checks.etype_checkboxes === 12)
  need('legend_dashed_flagged', Number(checks.legend_dashed_flagged) > 0)
  need('radius_monotonic', checks.radius_monotonic === true)

  // 按 etype 筛选：可见边数必须**恰好等于**该类型条数
  const firstEtype = ALL_ETYPES.find((k) => (counts.value[k] || 0) > 0)
  if (firstEtype && eng) {
    const expect = counts.value[firstEtype] || 0
    ;(document.querySelector(`[data-etype-box="${firstEtype}"]`) as HTMLInputElement)!.checked = true
    ALL_ETYPES.filter((k) => k !== firstEtype).forEach((k) => {
      const box = document.querySelector(`[data-etype-box="${k}"]`) as HTMLInputElement | null
      if (box) box.checked = false
    })
    toggleEtype(firstEtype, true)
    onEtypes.value = new Set([firstEtype])
    applyFilters()
    await new Promise((r) => setTimeout(r, 150))
    rec('filter_etype', firstEtype)
    rec('filter_visible_edges', engNow()!.visibleEdges.length)
    rec('filter_expect_edges', expect)
    const fEng = engNow()!
    rec('filter_visible_etypes', Array.from(new Set(fEng.visibleEdges.map((e) => e.etype))).slice(0, 6))
    rec('filter_total_edges', fEng.edges.length)
    need('filter', fEng.visibleEdges.length === expect && expect > 0 && fEng.visibleEdges.every((e) => e.etype === firstEtype))
    onEtypes.value = new Set(ALL_ETYPES)
    ALL_ETYPES.forEach((k) => {
      const box = document.querySelector(`[data-etype-box="${k}"]`) as HTMLInputElement | null
      if (box) box.checked = true
    })
    applyFilters()
  }

  // flagged 只看：可见边必须**全部** flagged，且条数等于 flagged 总数
  if (eng) {
    flaggedOnly.value = true
    applyFilters()
    await new Promise((r) => setTimeout(r, 120))
    rec('flagged_only_visible', engNow()!.visibleEdges.length)
    const gEng = engNow()!
    rec('flagged_not_ok', gEng.visibleEdges.filter((e) => !e.flagged).length)
    rec('flagged_total_flagged', flaggedCount.value)
    need('flagged_only', gEng.visibleEdges.length === flaggedCount.value && gEng.visibleEdges.every((e) => e.flagged))
    flaggedOnly.value = false
    applyFilters()
  }

  // 点击节点（走真实事件链路：DOM 列表 click → focusNode）
  const row = document.querySelector('[data-testid="node-list"] .gnode-row') as HTMLElement | null
  if (row) {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 150))
    rec('node_click_id', detailId.value)
    need('node_click', !!detailId.value)
    // 点击边 → 证据
    const erow = document.querySelector('[data-testid="detail-edges"] .edge-row') as HTMLElement | null
    if (erow) {
      erow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 120))
      rec('edge_evidence', {
        shown: !!selectedEdge.value,
        type: selectedEdge.value?.etype || '',
        evidence: (selectedEdge.value?.evidence || '').slice(0, 80),
      })
      need('edge_evidence', !!selectedEdge.value)
    } else { rec('edge_evidence', { skipped: 'node has no edges' }) }
  } else { failed.push('node_click') }

  const p = buildPerf('selftest') as any
  rec('perf', {
    nodes: p?.nodes, edges: p?.edges, ticks: p?.ticks, frames: p?.frames, elapsed_ms: p?.elapsed_ms,
    frame_ms_p50: p?.frame_ms_p50, frame_ms_p95: p?.frame_ms_p95, tick_ms: p?.bench?.per_tick_ms,
    settled: p?.settled, frame_samples: p?.frame_samples,
  })
  need('perf', !!(p && p.settled && p.bench?.per_tick_ms > 0 && p.frame_ms_p50 != null && p.frame_ms_p50 < 25
    && p.bench.per_tick_ms < 25 && p.frame_samples >= 20))

  const report = { ok: failed.length === 0, checks, failed }
  writeReport('selftest-report', report)
  const box = document.getElementById('selftest-panel')
  if (box) box.textContent = report.ok ? '自检通过' : `自检未通过：${failed.join(', ')}`
  return report
}

onMounted(boot)
// 换文档不重挂载（见 App.vue 的 RouterView key 说明）→ 自己监听 query.doc 重新加载
watch(() => route.query.doc, (v, old) => { if (v && v !== old) void boot() })
const _esc = esc
void _esc
</script>

<template>
  <div class="graph-view">
    <div class="g-head">
      <h1 class="sec-title" data-testid="graph-title">
        知识图谱
        <span class="cnt" style="color: var(--muted)">
          {{ corpus.gNodes.value.length }} 节点 · {{ corpus.gEdges.value.length }} 边
        </span>
      </h1>
      <div class="small muted" style="margin-bottom: 8px">
        自绘力导向（零第三方图库）· 点节点看边、点边看**原文证据** · flagged 边为虚线，只标记不删除
      </div>
    </div>
    <div class="gc-bar">
      <input v-model="nodeQuery" type="text" placeholder="找节点（名字 / id）" aria-label="找节点" data-testid="node-filter" />
      <label class="small">分层
        <select v-model="layer" data-testid="layer-select" @change="applyFilters">
          <option value="">全部层</option>
          <option v-for="l in ['L0', 'L1', 'L2', 'L3']" :key="l" :value="l">{{ LAYER_ZH[l] }}</option>
        </select>
      </label>
      <label class="small">着色
        <select v-model="colorBy" data-testid="colorby" @change="applyFilters">
          <option value="type">按实体类型</option>
          <option value="layer">按 L0–L3 层</option>
        </select>
      </label>
      <label class="small">标签
        <select v-model="labels" data-testid="labels" @change="applyFilters">
          <option value="auto">自动（重要的才标）</option>
          <option value="all">全部</option>
          <option value="none">不显示</option>
        </select>
      </label>
      <label class="small">最小 degree
        <input v-model.number="minDegree" type="range" min="0" max="20" step="1" data-testid="mindeg" @input="applyFilters" />
      </label>
      <label class="small etype-check"><input v-model="flaggedOnly" type="checkbox" data-testid="flagged-only" @change="applyFilters" /> 只看 flagged 边</label>
      <button type="button" @click="canvasRef?.relayout()">重新布局</button>
      <button type="button" @click="canvasRef?.fit()">适应画布</button>
      <span class="small muted" data-testid="settle">{{ settleText }}</span>
    </div>

    <div class="etype-filters" data-testid="etype-filters">
      <label v-for="k in ALL_ETYPES" :key="k" class="etype-check" :data-etype="k" :title="ETYPE_ZH[k]">
        <input
          type="checkbox"
          :checked="onEtypes.has(k)"
          :data-etype-box="k"
          @change="toggleEtype(k, ($event.target as HTMLInputElement).checked)"
        />
        <i :style="{ borderTopColor: etypeColor(k) }" />{{ k }}
        <span class="cnt">{{ counts[k] || 0 }}<template v-if="counts[`${k}:flagged`]"> · flagged {{ counts[`${k}:flagged`] }}</template></span>
      </label>
    </div>

    <div v-if="fatal" class="note bad" style="margin: 0 20px" data-testid="fatal">图谱加载失败：{{ fatal }}</div>

    <div class="g-main">
      <div class="gp-canvas-wrap" style="flex: 1 1 auto">
        <GraphCanvas
          ref="canvasRef"
          :nodes="corpus.gNodes.value"
          :edges="corpus.gEdges.value"
          :height="560"
          :labels="labels"
          :color-by="colorBy"
          :max-labels="140"
          :label-min-degree="3"
          :focus-id="focusId"
          @node-click="(n) => focusNode(n.id)"
          @edge-click="showEdge"
          @settled="() => buildPerf('settled')"
        />
      </div>

      <aside class="gp-side" data-testid="detail-panel">
        <div class="small muted">节点详情 / 证据（点画布或下面列表）</div>
        <div v-if="detail" :data-node-id="detail.id" :data-node-name="detail.name">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px">
            <i class="legend-dot" :style="{ background: typeColor(detail.type) }" />
            <b>{{ detail.name_zh || detail.name }}</b>
            <span class="pill">{{ typeZh(detail.type) }}</span>
            <span class="pill">{{ LAYER_ZH[detail.layer] || detail.layer || '未分层' }}</span>
          </div>
          <div class="faint mono small">{{ detail.name }}</div>
          <dl class="kv">
            <dt>degree</dt><dd class="mono">{{ detail.degree }}</dd>
            <dt>入边 / 出边</dt><dd class="mono">{{ inEdges.length }} / {{ outEdges.length }}</dd>
            <dt>单元</dt><dd class="mono small">{{ (detail.unit_ids || []).join(', ') || '—' }}</dd>
          </dl>
          <a v-if="detail.unit_ids?.length" class="flink" :href="`#/wiki?doc=${encodeURIComponent(corpus.docId.value || '')}&unit=${encodeURIComponent(detail.unit_ids[0])}`">📚 在知识库中打开该单元</a>

          <div class="small muted" style="margin: 12px 0 4px">出边（{{ outEdges.length }}）</div>
          <div data-testid="detail-edges">
            <div v-for="e in outEdges" :key="e.id" class="edge-row" :data-edge-id="e.id" :data-etype="e.etype" @click="showEdge(e)">
              <span class="etype" :style="{ borderColor: etypeColor(e.etype) }">{{ etypeZh(e.etype) }} → {{ e.dst }}</span>
              <span v-if="e.flagged" class="pill bad tiny">flagged</span>
            </div>
            <span v-if="!outEdges.length" class="faint small">（无）</span>
          </div>
          <div class="small muted" style="margin: 12px 0 4px">入边（{{ inEdges.length }}）</div>
          <div>
            <div v-for="e in inEdges" :key="e.id" class="edge-row" :data-etype="e.etype" @click="showEdge(e)">
              <span class="etype" :style="{ borderColor: etypeColor(e.etype) }">{{ etypeZh(e.etype) }} ← {{ e.src }}</span>
            </div>
            <span v-if="!inEdges.length" class="faint small">（无）</span>
          </div>
        </div>
        <div v-else class="detail-empty">点击画布中的节点（或右侧列表）查看它的边与证据。</div>

        <div v-if="selectedEdge" class="panel" style="padding: 10px; margin-top: 10px" data-testid="edge-evidence">
          <b>{{ etypeZh(selectedEdge.etype) }}</b> <span class="mono small">{{ selectedEdge.etype }}</span>
          <span v-if="selectedEdge.flagged" class="pill bad tiny" data-flagged="1">flagged（虚线标记）</span>
          <div class="evidence">{{ selectedEdge.evidence || '（无证据文本）' }}</div>
          <div class="small faint">
            置信度 {{ selectedEdge.confidence }}
            <template v-if="selectedEdge.span"> · 位置 {{ fmtSpan(spanOf(selectedEdge.span)) }}</template>
            <template v-if="edgeHref(selectedEdge)"> · <a class="flink" :href="edgeHref(selectedEdge)">原文/视频定位 ↗</a></template>
          </div>
        </div>

        <div class="small muted" style="margin-top: 12px">节点列表（按 degree）</div>
        <div data-testid="node-list">
          <div v-for="n in (nodeQuery ? filteredNodes.slice(0, 60) : topNodes)" :key="n.id" class="gnode-row" :data-node-id="n.id" @click="focusNode(n.id)">
            <i class="legend-dot" :style="{ background: typeColor(n.type) }" />
            <span style="flex: 1">{{ n.name_zh || n.name }}</span>
            <span class="faint mono tiny">deg {{ n.degree }}</span>
          </div>
          <div v-if="nodeQuery && !filteredNodes.length" class="faint small">无匹配节点</div>
        </div>
      </aside>
    </div>

    <div class="gp-legend" data-testid="graph-legend">
      <span v-for="k in ALL_ETYPES" :key="k" class="legend-item">
        <i class="legend-line" :style="{ borderTopColor: etypeColor(k) }" />{{ k }} {{ ETYPE_ZH[k] }}
      </span>
      <span class="legend-item"><i class="legend-line dashed" :style="{ borderTopColor: 'var(--accent)' }" />flagged 边（虚线，只标记不删除）</span>
      <span v-if="visibleStats" class="small muted">
        可见 {{ visibleStats.visible_nodes }} 节点 / {{ visibleStats.visible_edges }} 边 · flagged {{ flaggedCount }}
      </span>
      <span class="small faint" id="selftest-panel" />
    </div>
  </div>
</template>
<style scoped>
/* 图谱页：标题像手册章节，工具条是"仪表条"（细线 + 纸白） */
.graph-view { padding: 14px 22px 24px; }
.g-head { padding: 0 0 0 0; }
.gc-bar { margin: 0; border: var(--hair) solid var(--rule); border-top: 2px solid var(--rule-strong); border-bottom: none; }
.etype-filters { border: var(--hair) solid var(--rule); border-bottom: none; }
.g-main { border: var(--hair) solid var(--rule); border-bottom: none; }
.gp-legend { border: var(--hair) solid var(--rule); }
</style>








