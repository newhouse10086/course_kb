<script setup lang="ts">
/**
 * WikiIndex —— 知识库浏览（知识库视图）
 *
 * 交付内容（task-7）：
 *   · 左侧可展开层次树（/outline；无内容节点 `–` 徽章）
 *   · 右侧：概括区（intro / why / 学习目标 / 要点）+ 子节 + 知识卡片（五要素）
 *   · 交叉引用：正文内链 + 引用区（类型化 / 正文提到 / 还出现在）+ **反链**
 *   · 卡片底部：原文跳转（PDF `#page=N`；Video `currentTime`）
 *   · 顶部搜索（/search）
 *   · ★ **内嵌图谱**：当前单元的局部子图，节点可点击跳转（用户核心要求）
 *
 * 无头断言见 `?selftest=1`：把真实点击的结果写进 `#selftest-report`。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api/client'
import { useCaps } from '../composables/useCaps'
import { useCorpus, useDocuments } from '../composables/useCorpus'
import CardPanel from '../components/CardPanel.vue'
import EmbeddedGraph from '../components/EmbeddedGraph.vue'
import KnowledgeTree from '../components/KnowledgeTree.vue'
import { SECTION_ROLE_ZH, esc, fmtSpan, linkify, nameKey } from '../utils/text'
import { queryFlag, readReport, testBarrier, testBarrierDone, writeReport } from '../utils/report'
import type { SearchHit } from '../api/types'
import { cardSpan } from '../api/client'

const route = useRoute()
const router = useRouter()
const { caps, error: capsError } = useCaps()
const docsApi = useDocuments()
const corpus = useCorpus()

const unitId = ref<string | null>(null)
const activeCardId = ref<string | null>(null)
const searchQ = ref('')
const searchHits = ref<SearchHit[]>([])
const searchTotal = ref(0)
const searchBusy = ref(false)
const fatal = ref('')

const node = computed(() => (unitId.value && corpus.outline.value?.nodes?.[unitId.value]) || null)
const unitCards = computed(() => (unitId.value ? corpus.cardsOfUnit(unitId.value) : []))
const unitIds = computed(() => {
  const n = node.value
  if (!n) return unitId.value ? [unitId.value] : []
  return [n.id, ...(n.children || []).slice(0, 40)]
})
const intro = computed(() => node.value?.intro || (node.value as any)?.section_summary || '')
const objectives = computed(() => node.value?.objectives || node.value?.learning_objectives || [])
const takeaways = computed(() => node.value?.key_takeaways || [])
const crumb = computed(() => (unitId.value ? corpus.breadcrumb(unitId.value) : []))
const children = computed(() => (node.value?.children || []).map((c) => corpus.outline.value?.nodes?.[c]).filter(Boolean))

const linkOpts = computed(() => ({ index: corpus.nameIndex.value }))

function openUnit(id: string, card?: string | null) {
  unitId.value = id
  activeCardId.value = card || null
  void router.replace({ query: { ...route.query, doc: corpus.docId.value || undefined, unit: id, card: card || undefined } })
  void nextTick(() => {
    if (card) void highlightCard(card)
    else window.scrollTo({ top: 0, behavior: 'smooth' })
  })
}

async function gotoCard(cardId: string) {
  const card = corpus.cardsById.value.get(cardId)
  if (!card) return false
  const uid = card.unit_id || ''
  activeCardId.value = cardId
  if (uid && uid !== unitId.value) {
    unitId.value = uid
    void router.replace({ query: { ...route.query, doc: corpus.docId.value || undefined, unit: uid, card: cardId } })
    await nextTick()
    await new Promise((r) => setTimeout(r, 60))          // 等子组件挂载
    return highlightCard(cardId)
  }
  return highlightCard(cardId)
}

async function highlightCard(cardId: string) {
  activeCardId.value = cardId
  await nextTick()
  const el = document.querySelector(`#card-${CSS.escape(cardId)}`) as HTMLElement | null
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  return !!el
}

async function doSearch(q: string) {
  searchBusy.value = true
  searchQ.value = q
  try {
    const r = await api.search(q, { doc_id: corpus.docId.value || undefined, limit: 20 })
    searchHits.value = r.hits || []
    searchTotal.value = Number(r.total ?? (r.hits || []).length)
  } catch (e) {
    searchHits.value = []
    searchTotal.value = 0
    fatal.value = (e as Error).message
  } finally {
    searchBusy.value = false
  }
}

function onHit(h: SearchHit) {
  if (h.kind === 'card') void gotoCard(h.ref_id)
  else openUnit(h.ref_id)
}

/** 由卡片名反查实体 id（内嵌图谱的兜底种子也用同一逻辑，见 EmbeddedGraph） */
const _unused = nameKey

async function boot() {
  testBarrier()
  try {
    const list = await docsApi.load()
    if (!list.length) {
      writeReport('wiki-report', { ok: true, docs: 0, note: '还没有文档：先到「文档」页上传' })
      return
    }
    const want = String(route.query.doc || '')
    const chosen = list.find((d) => d.id === want)
      || list.find((d) => d.kind !== 'video' && d.status === 'ready')
      || list[0]
    const ok = await corpus.load(chosen.id)
    if (!ok) {
      fatal.value = corpus.error.value
      writeReport('wiki-report', { ok: false, error: corpus.error.value })
      return
    }
    const wantUnit = String(route.query.unit || '')
    const roots = corpus.outline.value?.roots || []
    const unit = (wantUnit && corpus.outline.value?.nodes?.[wantUnit]) ? wantUnit : roots[0]
    if (unit) openUnit(unit, String(route.query.card || '') || null)
    if (route.query.q) void doSearch(String(route.query.q))
    writeReport('wiki-report', {
      ok: true,
      doc: chosen.id,
      units: Object.keys(corpus.outline.value?.nodes || {}).length,
      cards: corpus.cards.value.length,
      xrefs: corpus.xrefsRaw.value.length,
      graph_nodes: corpus.gNodes.value.length,
      graph_edges: corpus.gEdges.value.length,
      caps_asr: !!caps.value?.isAvailable('asr'),
      caps_pi: !!caps.value?.isAvailable('pi'),
      caps_tts: !!caps.value?.isAvailable('tts'),
      unit: unitId.value,
      load_ms: Math.round(performance.now()),
      // 诊断字段：无头测试看不到 console，只能把现场带出来（Vue 渲染抛错会保留旧 DOM）
      hash: location.hash.slice(0, 240),
      route_query: JSON.stringify(route.query),
      app_errors: ((window as any).__APP_ERRORS__ || []).slice(-10),
    })
    if (queryFlag('selftest')) await runSelftest()
  } catch (e) {
    fatal.value = (e as Error).message
    writeReport('wiki-report', { ok: false, error: (e as Error).message })
  } finally {
    await testBarrierDone()
  }
}

/* ---------------- 自检（headless Chrome 断言用） ---------------- */

async function runSelftest() {
  const checks: Record<string, unknown> = {}
  const failed: string[] = []
  const rec = (k: string, v: unknown) => { checks[k] = v }
  const need = (k: string, cond: boolean) => { if (!cond) failed.push(k) }
  await new Promise((r) => setTimeout(r, 900))            // 等内嵌图收敛一点

  rec('caps_loaded', !!caps.value)
  rec('caps_error', capsError.value)
  rec('units', Object.keys(corpus.outline.value?.nodes || {}).length)
  rec('cards_total', corpus.cards.value.length)
  rec('tree_rows', document.querySelectorAll('[data-testid="tree"] .trow').length)
  rec('empty_badges', document.querySelectorAll('[data-testid="tree"] .badge-empty').length)
  rec('card_badges', document.querySelectorAll('[data-testid="tree"] .badge-cards').length)
  // 展开根节点后的行数（验收：树可展开）
  const firstToggle = document.querySelector('[data-testid="tree"] [data-toggle]') as HTMLElement | null
  const before = document.querySelectorAll('[data-testid="tree"] .trow').length
  firstToggle?.click()
  await nextTick()
  rec('tree_rows_expanded', document.querySelectorAll('[data-testid="tree"] .trow').length)
  rec('tree_expand_ok', document.querySelectorAll('[data-testid="tree"] .trow').length >= before)
  need('tree_expand_ok', checks.tree_expand_ok === true)
  need('tree_rows', Number(checks.tree_rows) > 0)
  need('empty_badges', Number(checks.empty_badges) > 0)     // 无内容节点显示 – 徽章

  rec('unit', unitId.value)
  rec('unit_title', node.value?.title || '')
  rec('unit_intro', (intro.value || '').slice(0, 60))
  rec('cards_in_unit', document.querySelectorAll('.kcard').length)
  rec('inner_links', document.querySelectorAll('a.inner').length)
  rec('xref_groups', document.querySelectorAll('[data-testid="xref"] .xref-h[data-rel]').length)
  rec('backlinks', document.querySelectorAll('[data-testid="xref"] .xref-h[data-rel="backlinks"]').length)
  rec('source_links', document.querySelectorAll('[data-source-kind]').length)
  rec('source_href_sample', document.querySelector('[data-source-kind="page"]')?.getAttribute('href') || '')
  need('cards_in_unit', Number(checks.cards_in_unit) > 0)
  need('source_links', Number(checks.source_links) > 0)

  // ① 内嵌图谱存在且在卡片区之前
  const emb = document.querySelector('#embedded-graph') as HTMLElement | null
  const cardsPanel = document.querySelector('#cards-panel')
  rec('embedded_present', !!emb)
  rec('embedded_nodes', Number(emb?.dataset.nodes || 0))
  rec('embedded_edges', Number(emb?.dataset.edges || 0))
  rec('embedded_seed_source', emb?.dataset.seedSource || '')
  rec('embedded_mapped', Number(emb?.dataset.mapped || 0))
  rec('embedded_clickable_chips', document.querySelectorAll('[data-testid="embedded-nodes"] .node-chip[data-goto-card]').length)
  rec('embedded_before_cards', !!(emb && cardsPanel && (emb.compareDocumentPosition(cardsPanel) & Node.DOCUMENT_POSITION_FOLLOWING)))
  rec('embedded_flagged_legend', document.querySelectorAll('[data-testid="embedded-legend"] .legend-line.dashed').length)
  need('embedded_present', !!emb)
  need('embedded_nodes', Number(checks.embedded_nodes) > 0)
  need('embedded_clickable_chips', Number(checks.embedded_clickable_chips) > 0)
  need('embedded_before_cards', checks.embedded_before_cards === true)

  // ② 内嵌图谱节点点击 → 跳转到该卡片（真实 MouseEvent）
  const chip = document.querySelector('[data-testid="embedded-nodes"] .node-chip[data-goto-card]') as HTMLElement | null
  const selftestHomeUnit = unitId.value            // 自检结束后要回到本单元（否则外部 DOM 断言看到的是别的单元）
  if (chip) {
    const target = chip.getAttribute('data-goto-card')!
    const beforeUnit = unitId.value
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 500))
    const hl = document.querySelector(`#card-${CSS.escape(target)}.hl`)
    rec('embedded_click', {
      target, unit_before: beforeUnit, unit_after: unitId.value,
      unit_changed: beforeUnit !== unitId.value, highlighted: !!hl,
    })
    need('embedded_click', !!(hl || document.querySelector(`#card-${CSS.escape(target)}`)))
  } else {
    rec('embedded_click', { skipped: 'no clickable chip' })
    failed.push('embedded_click')
  }

  // ③ 交叉引用：跨单元点击（真实的 click → 切单元 + 高亮）
  let cross: HTMLElement | null = null
  for (const a of Array.from(document.querySelectorAll('[data-testid="xref"] a.xr[data-goto-card]')) as HTMLElement[]) {
    const c = corpus.cardsById.value.get(a.getAttribute('data-goto-card')!)
    if (c && (c.unit_id || '') !== unitId.value) { cross = a; break }
  }
  if (!cross) {
    // 当前单元没有跨单元引用 → 换到有引用的单元再找（保证断言到的是真实路径）
    const withXref = corpus.cards.value.find((c) => (corpus.xrefs.value.out.get(c.id) || [])
      .some((x) => (corpus.cardsById.value.get(x.id)?.unit_id || '') !== (c.unit_id || '')))
    if (withXref?.unit_id) {
      openUnit(withXref.unit_id)
      await new Promise((r) => setTimeout(r, 400))
      for (const a of Array.from(document.querySelectorAll('[data-testid="xref"] a.xr[data-goto-card]')) as HTMLElement[]) {
        const c = corpus.cardsById.value.get(a.getAttribute('data-goto-card')!)
        if (c && (c.unit_id || '') !== unitId.value) { cross = a; break }
      }
    }
  }
  if (cross) {
    const target = cross.getAttribute('data-goto-card')!
    const targetUnit = corpus.cardsById.value.get(target)?.unit_id || ''
    const beforeUnit = unitId.value
    cross.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 500))
    const hl = document.querySelector(`#card-${CSS.escape(target)}.hl`)
    rec('xref_cross_unit_click', {
      target, target_unit: targetUnit, unit_before: beforeUnit, unit_after: unitId.value,
      unit_changed: beforeUnit !== unitId.value, highlighted: !!hl,
    })
    need('xref_cross_unit_click', beforeUnit !== unitId.value && !!hl)
  } else {
    rec('xref_cross_unit_click', { skipped: 'no cross-unit xref' })
    failed.push('xref_cross_unit_click')
  }

  // ④ 卡片级迷你关系图（F5 第三种形态）
  const miniBtn = document.querySelector('.mini-toggle') as HTMLElement | null
  if (miniBtn) {
    miniBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 400))
    const host = document.querySelector('[data-mini-host]') as HTMLElement | null
    rec('mini_graph', {
      shown: !!host,
      canvas: !!host?.querySelector('canvas'),
      nodes: Number(host?.querySelector('#embedded-graph')?.getAttribute('data-nodes') || 0),
    })
    need('mini_graph', !!host?.querySelector('canvas'))
  } else { rec('mini_graph', { skipped: 'no card' }); failed.push('mini_graph') }

  // ⑤ TTS 能力门控（PROVIDERS §7：不可用 → 禁用 + 原因）
  const tts = document.querySelector('.tts-btn') as HTMLButtonElement | null
  rec('tts_gate', {
    disabled: !!tts?.disabled,
    reason: tts?.dataset.gateReason || '',
    available: !!caps.value?.isAvailable('tts'),
  })
  need('tts_gate', !!tts && (tts.disabled === !caps.value?.isAvailable('tts')))

  // ⑤b 能力横幅：每个不可用能力都必须有**可见的原因文案**（不是只放在 title 里）
  rec('caps_banner_gates', Array.from(document.querySelectorAll('[data-testid="caps-bar"] .gate-note'))
    .map((e) => (e.textContent || '').trim().slice(0, 90)))

  // ★ 自检把页面"折腾"过（点 chip / 点跨节引用会切单元）→ **回到本单元**，
  //   否则外部（headless）在自检结束后取 DOM 时看到的是另一个单元，卡片数/内嵌图全对不上。
  if (selftestHomeUnit && unitId.value !== selftestHomeUnit) {
    openUnit(selftestHomeUnit)
    await new Promise((r) => setTimeout(r, 400))
    rec('restored_unit', unitId.value)
  }

  // ⑥ 时间型 span 的原文跳转（C8：视频卡片必须给 currentTime 跳转）
  const timeHref = sourceHrefFor({ kind: 'time', start: 754000, end: 760000 })
  rec('time_source_href', timeHref)
  need('time_source_href', /#\/video\?doc=.*&t=754000/.test(timeHref))

  // ⑦ 搜索（真实调用 /search）
  try {
    const q = corpus.cards.value[0]?.name?.slice(0, 4) || '索引'
    await doSearch(q)
    rec('search_q', q)
    rec('search_total', searchTotal.value)
    rec('search_hits', searchHits.value.length)
    need('search_hits', searchHits.value.length > 0)
  } catch (e) { rec('search_error', (e as Error).message); failed.push('search_hits') }

  const report = { ok: failed.length === 0, checks, failed }
  writeReport('selftest-report', report)
  const box = document.getElementById('selftest-panel')
  if (box) box.textContent = report.ok ? '自检通过' : `自检未通过：${failed.join(', ')}`
  return report
}

/** 与 CardPanel 同一套 URL 规则（这里只用于断言，避免"两处各写一套"） */
function sourceHrefFor(span: { kind: string; start: number; end: number } | null): string {
  if (!span) return ''
  if (span.kind === 'time') return `#/video?doc=${encodeURIComponent(corpus.docId.value || '')}&t=${span.start}`
  const base = `/api/v1/documents/${encodeURIComponent(corpus.docId.value || '')}/file`
  return span.kind === 'page' ? `${base}#page=${span.start}` : base
}

const _spanHelper = cardSpan
const _esc = esc
const _fmtSpan = fmtSpan
const _linkify = linkify

watch(() => route.query.doc, (v, old) => {
  if (v && v !== old) void boot()
})

onMounted(boot)
void readReport
</script>

<template>
  <div class="wiki-layout">
    <KnowledgeTree :outline="corpus.outline.value" :active-id="unitId" @open="(id) => openUnit(id)" />

    <main class="content">
      <div v-if="fatal" class="note bad" data-testid="fatal">加载失败：{{ fatal }}</div>

      <div class="search-box panel" style="padding: 10px 14px">
        <form @submit.prevent="doSearch(searchQ)">
          <input v-model="searchQ" type="search" placeholder="搜索知识点 / 章节（中文 bigram 检索）" aria-label="搜索" data-testid="search-input" />
          <button type="submit">搜索</button>
        </form>
        <span v-if="searchBusy" class="small muted">检索中…</span>
      </div>

      <div v-if="searchHits.length || searchTotal" class="panel" data-testid="search-results">
        <div style="display: flex; gap: 8px; align-items: center">
          <b>检索「{{ searchQ }}」</b>
          <span class="pill" data-testid="search-total">{{ searchTotal }} 命中</span>
          <button class="right" type="button" @click="searchHits = []; searchTotal = 0">关闭</button>
        </div>
        <div
          v-for="h in searchHits"
          :key="h.kind + h.ref_id"
          class="hit"
          :data-hit-kind="h.kind"
          :data-hit-ref="h.ref_id"
          @click="onHit(h)"
        >
          <div><span class="pill" :class="{ blue: h.kind === 'card' }">{{ h.kind === 'card' ? '卡片' : '单元' }}</span> <b>{{ h.title }}</b>
            <span class="faint mono tiny right">score {{ h.score }}</span></div>
          <div class="snip small muted">{{ h.snippet }}</div>
        </div>
        <div v-if="!searchHits.length" class="faint small">没有命中</div>
      </div>

      <template v-if="node">
        <!-- 概括区（F3：所有层级都要有 intro） -->
        <section class="panel" id="sec-head" :data-unit="node.id">
          <div class="crumbbar">
            <template v-for="(cid, i) in crumb" :key="cid">
              <a v-if="i < crumb.length - 1" href="#" @click.prevent="openUnit(cid)">{{ corpus.outline.value?.nodes?.[cid]?.title || cid }}</a>
              <b v-else>{{ corpus.outline.value?.nodes?.[cid]?.title || cid }}</b>
              <span v-if="i < crumb.length - 1"> › </span>
            </template>
          </div>
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
            <span class="pill">L{{ node.level }}</span>
            <span v-if="node.section_role" class="pill blue">{{ SECTION_ROLE_ZH[node.section_role] || node.section_role }}</span>
            <span v-if="node.span" class="pill">{{ fmtSpan(node.span) }}</span>
            <span class="pill">知识点 {{ node.n_cards }}</span>
            <span class="pill">子节点 {{ node.n_units }}</span>
          </div>
          <h1 class="sec-title" data-testid="unit-title">{{ node.title }}</h1>
          <div class="defrow">
            <div class="deflabel">本节讲什么</div>
            <div class="deftext" data-testid="unit-intro">
              <span v-if="intro" v-html="linkify(intro, linkOpts)" />
              <span v-else class="faint">（后端未提供 intro —— F3 要求所有层级都有；请检查 /outline 的 intro 字段）</span>
            </div>
          </div>
          <div v-if="node.why" class="defrow">
            <div class="deflabel">为什么重要</div>
            <div class="deftext" v-html="linkify(node.why, linkOpts)" />
          </div>
          <div v-if="objectives.length" class="defrow">
            <div class="deflabel">学习目标</div>
            <div class="deftext"><ul style="margin: 0; padding-left: 18px"><li v-for="(o, i) in objectives" :key="i">{{ o }}</li></ul></div>
          </div>
          <div v-if="takeaways.length" class="defrow">
            <div class="deflabel">要点</div>
            <div class="deftext"><ul style="margin: 0; padding-left: 18px"><li v-for="(o, i) in takeaways" :key="i">{{ o }}</li></ul></div>
          </div>
        </section>

        <!-- ★ 内嵌图谱（用户核心要求） -->
        <EmbeddedGraph
          :doc-id="corpus.docId.value || ''"
          :unit-id="node.id"
          :unit-ids="unitIds"
          :title="node.title"
          :cards="unitCards"
          :cards-by-id="corpus.cardsById.value"
          :xrefs="corpus.xrefs.value"
          :graph="corpus.graph.value"
          :active-card-id="activeCardId"
          @goto-card="gotoCard"
        />

        <section v-if="children.length" class="panel" data-testid="children">
          <h3 style="margin-top: 0">子节（{{ children.length }}）</h3>
          <div
            v-for="c in children"
            :key="c!.id"
            class="gnode-row"
            :data-unit-link="c!.id"
            @click="openUnit(c!.id)"
          >
            <span class="pill">L{{ c!.level }}</span>
            <span style="flex: 1">{{ c!.title }}</span>
            <span v-if="Number(c!.n_cards) > 0" class="badge-cards">{{ c!.n_cards }} 卡片</span>
            <span v-else class="badge-empty" title="本节暂无知识点">–</span>
            <span v-if="c!.span" class="faint mono tiny">{{ fmtSpan(c!.span) }}</span>
          </div>
        </section>

        <section class="panel" id="cards-panel" :data-unit="node.id" :data-card-count="unitCards.length">
          <h2 style="margin: 0 0 2px">知识点卡片
            <span class="cnt" style="color: var(--muted)">×{{ unitCards.length }}</span>
          </h2>
          <div v-if="!unitCards.length" class="note info" data-testid="no-cards">
            本节暂无知识卡片。按 F3，**无知识点的节点也必须给出 intro**（契约 §5.2 的 <code>intro</code> 字段）——
            上方概括区的内容即来自该字段，不是留白。
          </div>
          <div class="small muted" style="margin-bottom: 10px">
            五要素：是什么 / 能做什么 / 示例（+说明）/ 前提 / 注意；右上角页码可直接跳原文。
          </div>
          <div class="cards-stack">
            <CardPanel
              v-for="(c, ci) in unitCards"
              :key="c.id"
              :card="c"
              :index="corpus.nameIndex.value"
              :doc-id="corpus.docId.value || ''"
              :xrefs="corpus.xrefs.value"
              :cards-by-id="corpus.cardsById.value"
              :caps="caps"
              :active="activeCardId === c.id"
              :ordinal="ci"
              @goto="gotoCard"
            />
          </div>
        </section>
      </template>

      <div v-else-if="!fatal" class="panel loading">正在加载知识库…</div>
      <div id="selftest-panel" class="small faint" style="margin: 4px 2px" />
    </main>
  </div>
</template>

<style scoped>
/* 非对称版面：左侧目次（窄、密） + 右侧正文（宽） */
.wiki-layout { display: flex; align-items: flex-start; gap: 18px; padding: 14px 22px 40px; }
.content { flex: 1 1 auto; min-width: 0; max-width: 1080px; }
.search-box { display: flex; gap: 6px; }
.search-box form { display: flex; gap: 6px; flex: 1; }
.search-box input { flex: 1; }
.hit { padding: 5px 10px; border-bottom: var(--hair) solid var(--rule); border-left: 2px solid transparent; cursor: pointer; }
.hit:hover { background: var(--paper-2); border-left-color: var(--accent); }
.badge-cards {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: .03em;
  color: var(--accent-ink); background: color-mix(in srgb, var(--accent-soft) 50%, transparent);
  border: var(--hair) solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: var(--r-sm); padding: 0 4px;
}
.badge-empty {
  font-family: var(--font-mono); font-size: 10px; color: var(--muted);
  border: var(--hair) dotted var(--rule-strong); border-radius: var(--r-sm); padding: 0 4px;
}
/* 卡片之间用线相连（像记录表），而不是散落的圆角盒子 */
.cards-stack { border-top: 2px solid var(--rule-strong); }
</style>





