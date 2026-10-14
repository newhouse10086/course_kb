/**
 * 语料 composable：围绕一个 document 把 Wiki/Graph 需要的全部数据拉齐并建索引
 *   outline（层次树）+ cards（全量，分页拉完）+ xrefs（一次拉全）+ graph（按需）
 * 这些都是"索引基础"：交叉引用、内嵌图谱、卡片名反查都依赖它们，所以一次拉全比按需请求更省。
 */
import { computed, ref, shallowRef } from 'vue'
import { api, loadAllCards, loadAllXrefs } from '../api/client'
import { buildNameIndex, nameKey } from '../utils/text'
import { buildXrefIndex, normalizeGraph, type GEdge, type GNode, type XrefIndex } from '../graph/subgraph'
import type { Card, DocumentInfo, GraphData, Outline, Xref } from '../api/types'

export function useCorpus() {
  const loading = ref(false)
  const error = ref('')
  const docId = ref<string | null>(null)
  const outline = ref<Outline | null>(null)
  const cards = ref<Card[]>([])
  const graph = shallowRef<GraphData | null>(null)
  const xrefsRaw = ref<Xref[]>([])
  const loadedAt = ref(0)

  const cardsById = computed(() => new Map(cards.value.map((c) => [c.id, c])))
  const nameIndex = computed(() => buildNameIndex(cards.value))
  const xrefs = computed<XrefIndex>(() => buildXrefIndex(xrefsRaw.value, cardsById.value))
  const normalized = computed(() => normalizeGraph(graph.value?.nodes as never, graph.value?.edges as never))
  const gNodes = computed<GNode[]>(() => normalized.value.nodes)
  const gEdges = computed<GEdge[]>(() => normalized.value.edges)
  const units = computed(() => {
    const m = new Map<string, { id: string; title: string; level: number; children: string[] }>()
    for (const [id, n] of Object.entries(outline.value?.nodes || {})) {
      m.set(id, { id, title: n.title, level: n.level, children: n.children || [] })
    }
    return m
  })
  const parentOf = computed(() => {
    const m = new Map<string, string>()
    for (const [pid, n] of Object.entries(outline.value?.nodes || {})) {
      for (const c of n.children || []) m.set(c, pid)
    }
    return m
  })
  const cardsOfUnit = (unitId: string) => cards.value.filter((c) => (c.unit_id || '') === unitId)
  const cardByName = (name: string) => {
    const k = nameKey(name)
    const id = nameIndex.value.byKey.get(k)
    return id ? cardsById.value.get(id) || null : null
  }
  const breadcrumb = (unitId: string): string[] => {
    const chain: string[] = []
    let cur: string | undefined = unitId
    let guard = 0
    while (cur && guard++ < 40) {
      chain.unshift(cur)
      cur = parentOf.value.get(cur)
    }
    return chain
  }

  async function load(id: string, opts: { withGraph?: boolean } = {}) {
    loading.value = true
    error.value = ''
    docId.value = id
    try {
      outline.value = await api.outline(id)
      const all = await loadAllCards(id)
      cards.value = all
      try {
        xrefsRaw.value = await loadAllXrefs(id)
      } catch {
        xrefsRaw.value = []          // 交叉引用失败不阻塞浏览（但页面会显示"暂无引用"）
      }
      if (opts.withGraph !== false) {
        try {
          graph.value = await api.graph(id)
        } catch {
          graph.value = { nodes: [], edges: [], stats: {} }
        }
      }
      loadedAt.value = Date.now()
      return true
    } catch (e) {
      error.value = (e as Error).message
      return false
    } finally {
      loading.value = false
    }
  }

  /** 换文档时清空（避免上一份数据与新数据混在一起） */
  function reset() {
    outline.value = null
    cards.value = []
    graph.value = null
    xrefsRaw.value = []
    error.value = ''
    docId.value = null
  }

  return {
    loading, error, docId, outline, cards, cardsById, nameIndex, xrefs, xrefsRaw,
    graph, gNodes, gEdges, units, parentOf, breadcrumb, cardsOfUnit, cardByName, load, reset,
  }
}

/** 文档列表 composable（多个视图共用） */
export function useDocuments() {
  const docs = ref<DocumentInfo[]>([])
  const loading = ref(false)
  const error = ref('')
  async function load(kind?: string) {
    loading.value = true
    error.value = ''
    try {
      const page = await api.documents({ limit: 200, kind })
      const list: DocumentInfo[] = Array.isArray((page as any).items) ? (page as any).items
        : Array.isArray((page as any).documents) ? (page as any).documents
          : Array.isArray(page) ? (page as unknown as DocumentInfo[]) : []
      docs.value = list
      return list
    } catch (e) {
      error.value = (e as Error).message
      docs.value = []
      return []
    } finally {
      loading.value = false
    }
  }
  return { docs, loading, error, load }
}
