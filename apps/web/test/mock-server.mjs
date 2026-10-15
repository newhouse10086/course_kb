/**
 * 契约 mock server（无头 DOM 断言 + 前端开发用）
 *
 * 为什么不是"几行假 JSON"：数据来自上游**冻结产物**
 *   ../数据库课程智能体调研/data/refman_extract/tree.json        （2458 单元层次树）
 *   ../数据库课程智能体调研/data/refman_v2/_ckpt_v2.json        （360 张知识卡片）
 *   ../数据库课程智能体调研/data/refman_extract/graph_view.json （**1644 节点 / 481 边**）
 * 转成契约 §2/§5 的形状后提供 —— 于是页面上跑的是真实体量。
 *
 * 覆盖能力：
 *   · REST §5（documents/outline/units/cards/xrefs/graph/cards/search/capabilities）
 *   · SSE §6（chunked；**必须 chunked**：HTTP/1.1 无长度裸流 Chrome 的 EventSource 直接 CLOSED）
 *   · WebSocket §7.2（ready / text_delta / tool_start|update|end / message_end / settled）
 *   · Provider 能力 §7（providers 逐 kind；degraded 模式模拟云端凭据缺失）
 *
 * ⚠️ 仅测试/开发用：文件名就叫 mock-server，不参与生产构建。
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { DATASETS, SandboxDb, sandboxError } from './sandbox-mock.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = path.resolve(__dirname, '..')
const DIST = path.join(WEB_ROOT, 'dist')
const UPSTREAM = path.resolve(WEB_ROOT, '..', '..', '..', '数据库课程智能体调研', 'data')
const TREE_JSON = path.join(UPSTREAM, 'refman_extract', 'tree.json')
const GRAPH_JSON = path.join(UPSTREAM, 'refman_extract', 'graph_view.json')
const CKPT_JSON = path.join(UPSTREAM, 'refman_v2', '_ckpt_v2.json')

export const DOC_PDF = 'doc_refman00001'
export const DOC_VIDEO = 'doc_video00001'
export const WIKI_UNIT = 'unt_0131'          // 5.3.1 Creating and Selecting a Database（13 张卡片）
export const WIKI_UNIT_CARDS = 13
export const WIKI_UNIT_TITLE = '5.3.1 Creating and Selecting a Database'

const NOISE = new Set(['use', 'and', 'or', 'not', 'in', 'is', 'as', 'on', 'to', 'by', 'if', 'for',
  'all', 'any', 'set', 'key', 'desc', 'path', 'date', 'char', 'time', 'text', 'blob', 'view',
  'index', 'table', 'value', 'name', 'type', 'user', 'host', 'port', 'file', 'test', 'data', 'event'])
const IDENT_RE = /[\u4e00-\u9fff()[\].\-_@#$%]/
const uid = (i) => `unt_${String(Number(i)).padStart(4, '0')}`

function layerOf(type) {
  if (['product', 'feature', 'table'].includes(type)) return 'L2'
  if (['business', 'role'].includes(type)) return 'L3'
  if (['concept', 'mechanism', 'problem', 'misconception', 'station'].includes(type)) return 'L1'
  if (type === 'regulation') return 'L0'
  return ''
}

let FIXTURE = null
export function buildFixture() {
  if (FIXTURE) return FIXTURE
  const tree = JSON.parse(fs.readFileSync(TREE_JSON, 'utf8'))
  const graph = JSON.parse(fs.readFileSync(GRAPH_JSON, 'utf8'))
  const ckpt = JSON.parse(fs.readFileSync(CKPT_JSON, 'utf8'))
  const nodes = tree.nodes || {}

  // ---- units / outline ----
  const units = new Map()
  for (const [key, n] of Object.entries(nodes)) {
    if (key === '__GENERAL__') continue
    units.set(uid(key), {
      id: uid(key), doc_id: DOC_PDF, order: Number(key) || 0, title: n.title || '',
      level: n.lvl || 1, parent_id: n.parent && nodes[n.parent] ? uid(n.parent) : null,
      span: { kind: 'page', start: Number(n.pg || 0), end: Number(n.end || n.pg || 0) },
      children: (n.children || []).filter((c) => nodes[c]).map(uid),
      entities: (n.entities || []).map((e) => String(e.id)),
    })
  }

  // ---- cards ----
  const cards = []
  const secOf = new Map()
  const byUnitSection = new Map()
  for (const sec of ckpt.sections || []) {
    const meta = sec._meta || {}
    const unitId = meta.node_i != null ? uid(meta.node_i) : null
    const s = sec.section || {}
    const list = []
    for (const c of sec.cards || []) {
      const id = `crd_${String(cards.length + 1).padStart(4, '0')}`
      const page = Number(c.evidence_page || meta.pg || 0)
      const card = {
        id, doc_id: DOC_PDF, unit_id: unitId,
        name: c.name || '', kind: c.kind || 'other',
        one_line: c.one_line || '', purpose: c.purpose || '',
        usage_mode: c.usage_mode || 'unknown', operational_role: c.operational_role || 'unknown',
        lifecycle: c.lifecycle || 'unknown',
        example: c.example ?? null, example_explained: c.example_explained ?? null,
        prerequisites: c.prerequisites || [], cautions: c.cautions || [],
        evidence_quote: c.evidence_quote || '',
        evidence_span: { kind: 'page', start: page, end: page },
        confidence: Number(c.confidence || 0),
        name_key: String(c.name || '').trim().toLowerCase(),
      }
      cards.push(card)
      list.push(card)
      secOf.set(id, unitId)
    }
    if (unitId && units.has(unitId)) {
      const u = units.get(unitId)
      u.intro = s.section_summary || ''
      u.objectives = s.learning_objectives || []
      u.key_takeaways = s.key_takeaways || []
      u.section_role = s.section_role || ''
    }
    if (unitId) byUnitSection.set(unitId, list)
  }

  // ---- xrefs ----
  const byKey = new Map()
  for (const c of cards) {
    const k = c.name_key
    if (!k) continue
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(c)
  }
  const textOf = (c) => [c.name, c.one_line, c.purpose, c.example || '', c.example_explained || '',
    c.evidence_quote || '', (c.cautions || []).join(' '), (c.prerequisites || []).join(' ')].join(' ')
  const texts = new Map(cards.map((c) => [c.id, textOf(c)]))
  const xrefs = []
  const seen = new Set()
  const push = (from, to, rel) => {
    if (!from || !to || from === to) return
    const k = `${from}|${to}|${rel}`
    if (seen.has(k)) return
    seen.add(k)
    xrefs.push({ from_card_id: from, to_card_id: to, rel, weight: 1 })
  }
  let mention = 0, alsoIn = 0, sameUnit = 0
  for (const a of cards) {
    const body = texts.get(a.id)
    let per = 0
    for (const b of cards) {                       // 契约 §2.5 的过滤规则（与前端 xref 同口径）
      if (a.id === b.id) continue
      const nm = (b.name || '').trim()
      if (!nm) continue
      const low = nm.toLowerCase()
      if (low.replace(/\(\)$/, '') === (a.name || '').trim().toLowerCase().replace(/\(\)$/, '')) continue  // 坑 7
      let hit
      if (IDENT_RE.test(nm)) hit = body.includes(nm)
      else if (NOISE.has(low)) hit = false                                                                  // 坑 6
      else if (low.length < 6 || low.includes(' ')) hit = /^[\x00-\x7F]+$/.test(nm) && body.includes(nm.toUpperCase())
      else hit = body.toLowerCase().includes(low)
      if (hit) { push(a.id, b.id, 'mention'); mention++; if (++per >= 60) break }
    }
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (secOf.get(group[i].id) !== secOf.get(group[j].id)) {
          push(group[i].id, group[j].id, 'also_in'); push(group[j].id, group[i].id, 'also_in'); alsoIn += 2
        }
      }
    }
  }
  for (const list of byUnitSection.values()) {
    const ordered = list.slice().sort((a, b) => a.id.localeCompare(b.id))
    for (let i = 0; i < ordered.length; i++) {
      for (const b of ordered.slice(i + 1, i + 5)) {
        push(ordered[i].id, b.id, 'same_unit'); push(b.id, ordered[i].id, 'same_unit'); sameUnit += 2
      }
    }
  }

  // ---- graph ----
  const entityUnit = new Map()
  for (const [ent, home] of Object.entries(tree.entity_home || {})) {
    if (home !== '__GENERAL__' && nodes[home]) entityUnit.set(String(ent), uid(home))
  }
  for (const [key, n] of Object.entries(nodes)) {
    if (key === '__GENERAL__') continue
    for (const e of (n.entities || [])) if (!entityUnit.has(String(e.id))) entityUnit.set(String(e.id), uid(key))
  }
  const degree = new Map()
  for (const e of graph.edges || []) {
    degree.set(e.src, (degree.get(e.src) || 0) + 1)
    degree.set(e.dst, (degree.get(e.dst) || 0) + 1)
  }
  const gNodes = (graph.nodes || []).map((n) => ({
    id: String(n.id), name: n.name || String(n.id), name_zh: n.zh || '',
    type: n.type || '', layer: layerOf(n.type || ''), degree: degree.get(n.id) || 0,
    unit_ids: entityUnit.has(String(n.id)) ? [entityUnit.get(String(n.id))] : [],
  }))
  let flagged = 0
  const gEdges = (graph.edges || []).map((e, i) => {
    const pages = e.pages || [0]
    const flag = e.verified === false || i % 11 === 0
    if (flag) flagged++
    return {
      id: `edg_${String(i + 1).padStart(4, '0')}`, src: String(e.src), dst: String(e.dst),
      etype: e.etype, evidence: e.evidence || '',
      span: { kind: 'page', start: Number(pages[0]), end: Number(pages[pages.length - 1]) },
      confidence: Number(e.confidence || 0), flagged: flag,
    }
  })

  // typed：图谱两端实体名能对上卡片名
  const cardByName = new Map()
  for (const c of cards) if (!cardByName.has(c.name_key)) cardByName.set(c.name_key, c.id)
  const entCard = new Map()
  for (const n of gNodes) {
    for (const nm of [n.name, n.name_zh]) {
      const cid = cardByName.get(String(nm || '').trim().toLowerCase())
      if (cid) { entCard.set(n.id, cid); break }
    }
  }
  let typed = 0
  for (const e of gEdges) {
    const a = entCard.get(e.src), b = entCard.get(e.dst)
    if (a && b && a !== b) { push(a, b, 'typed'); typed++ }
  }

  const nCards = new Map()
  for (const c of cards) nCards.set(c.unit_id, (nCards.get(c.unit_id) || 0) + 1)
  const outlineNodes = {}
  for (const [id, u] of units) {
    outlineNodes[id] = {
      id, title: u.title, level: u.level, span: u.span, children: u.children,
      n_cards: nCards.get(id) || 0, n_units: u.children.length,
      intro: u.intro || `本节包含 ${u.children.length} 个子节。`,
      why: u.why || '',
      objectives: u.objectives || [], key_takeaways: u.key_takeaways || [], section_role: u.section_role || '',
    }
  }
  const roots = (tree.roots || []).filter((r) => r !== '__GENERAL__' && nodes[r]).map(uid)

  // ---- video（合成夹具：真实产物由 worker 产出） ----
  const DUR = 3_600_000
  const SEG = 3000
  const segments = Array.from({ length: SEG }, (_, i) => {
    const start = Math.round((i * DUR) / SEG)
    return {
      i, start, end: start + Math.round(DUR / SEG) - 60,
      text: `第 ${i + 1} 段：这一节讲索引的选择性与回表代价，示例 SELECT * FROM t WHERE k = ${i};（夹具合成文本）`,
      confidence: Number((0.86 + (i % 12) / 100).toFixed(3)),
    }
  })
  const chapterTitles = ['索引基础', 'B+ 树结构', '聚簇与二级索引', '回表与覆盖索引', 'EXPLAIN 解读', '执行计划与代价', '索引失效场景', '调优实战']
  const transcript = Array.from({ length: 8 }, (_, c) => {
    const start = Math.round((c * DUR) / 8)
    const end = c === 7 ? DUR : Math.round(((c + 1) * DUR) / 8)
    return {
      title: `第 ${c + 1} 章 ${chapterTitles[c]}`, start, end,
      text: `本章（${Math.round(start / 1000)}s–${Math.round(end / 1000)}s）讲解……（夹具合成文稿，长度受限）`,
      summary: `本章小结：${['索引的选择性如何影响查询', 'B+ 树叶节点与页分裂', '聚簇索引与二级索引的差别', '回表代价与覆盖索引的收益', 'EXPLAIN 各列的含义', '优化器如何估算代价', '哪些写法会让索引失效', '一次真实的慢查询调优'][c]}。`,
    }
  })
  const mindmap = {
    format: 'markmap',
    content: ['# 索引与执行计划（夹具合成思维导图）',
      '## 一、索引基础 (00:00:00)', '- 选择性与基数', '- 最左前缀',
      '## 二、B+ 树结构 (00:07:30)', '- 叶节点与页分裂', '- 三层树能存多少行',
      '## 三、聚簇与二级索引 (00:15:00)', '- 聚簇索引即数据', '- 二级索引回表',
      '## 四、覆盖索引 (00:22:30)', '- 回表代价', '- 索引下推',
      '## 五、EXPLAIN (00:30:00)', '- type / key / rows', '- Extra 里的 Using index',
      '## 六、索引失效 (00:45:00)', '- 函数包列', '- 隐式类型转换',
      '## 七、调优实战 (00:52:30)', '- 慢查询定位', '- 改写 SQL'].join('\n'),
  }
  const slides = Array.from({ length: 12 }, (_, i) => ({
    index: i + 1, at_ms: 30_000 + i * 260_000,
    image: `/api/v1/documents/${DOC_VIDEO}/video/slides/${i + 1}/image`,
    ocr_text: `第 ${i + 1} 帧 OCR 文本（夹具）`,
    title: `幻灯片 ${i + 1}`,
  }))

  FIXTURE = {
    tree, graph, ckpt,
    units, outlineNodes, roots, cards, xrefs, gNodes, gEdges,
    video: {
      id: 'vid_0001', doc_id: DOC_VIDEO, duration_ms: DUR,
      asr_model: 'faster-whisper/base', asr_lang: 'zh',
      segments, subtitles: { srt: 'data/artifacts/vid_0001/subtitle.srt', vtt: 'data/artifacts/vid_0001/subtitle.vtt' },
      transcript, mindmap, slides,
      summary: '（夹具合成全文总结）本讲围绕索引的选择性、B+ 树结构、回表代价与 EXPLAIN 解读展开，给出索引失效的典型写法与一次慢查询调优的完整过程。',
    },
    meta: {
      units: Object.keys(outlineNodes).length, cards: cards.length, roots: roots.length,
      graph_nodes: gNodes.length, graph_edges: gEdges.length, flagged_edges: flagged,
      xrefs: { total: xrefs.length, typed, mention, also_in: alsoIn, same_unit: sameUnit },
      wiki_unit: WIKI_UNIT, wiki_unit_cards: WIKI_UNIT_CARDS,
      video: { segments: SEG, chapters: transcript.length, slides: slides.length },
    },
  }
  return FIXTURE
}

/* ---------------- capabilities ---------------- */

export function capabilitiesPayload(degraded = false) {
  if (degraded) {
    // 模拟：云端凭据缺失 + 本地模型不可用 + 无 OCR（**各能力独立**）
    return {
      version: '2.0.0-mock',
      adapters: ['text'],
      providers: {
        llm: [{ id: 'amr', label: 'AMR LLM', vendor: 'AMR', runtime: 'cloud', configured: false, available: false, reason: '缺少 AMR_KEY（在 course-kb/.env 配置）' }],
        asr: [
          { id: 'local-fw', label: '本地 faster-whisper', vendor: '本地', runtime: 'local', configured: false, available: false, reason: 'faster-whisper 未安装（pip install faster-whisper）' },
          { id: 'aliyun-asr', label: '阿里云智能语音', vendor: '阿里云', runtime: 'cloud', configured: false, available: false, reason: '缺少 ALIYUN_AK / ALIYUN_SK / ALIYUN_APPKEY（在 course-kb/.env 配置）' },
        ],
        tts: [{ id: 'aliyun-tts', label: '阿里云语音合成', vendor: '阿里云', runtime: 'cloud', configured: false, available: false, reason: '缺少 ALIYUN_AK / ALIYUN_SK / ALIYUN_APPKEY' }],
        translate: [{ id: 'llm-mt', label: 'LLM 翻译（术语表）', runtime: 'cloud', configured: true, available: false, reason: 'LLM 配额耗尽（HTTP 402），reset_at 2026-10-14T15:44:45Z' }],
        ocr: [{ id: 'baidu-ocr', label: '百度 OCR', runtime: 'cloud', configured: false, available: false, reason: '缺少 BAIDU_OCR_KEY' }],
      },
      policy: { asr: 'local-first', tts: 'cloud-first', translate: 'cloud-first' },
      pi: { available: false, reason: 'pi SDK 未安装（npm i @earendil-works/pi-coding-agent）' },
      ffmpeg: { available: false, version: '', reason: 'ffmpeg not found on PATH' },
      // 降级下沙箱**如实上报不可用**（含原因 + 部署文档指向）。
      // 注意不能"整个 sandbox 段都没有" —— 那前端只能显示"后端没上报"，
      // 而这里的事实是"引擎起不来"（两种降级要分清）
      sandbox: {
        available: false,
        engines: [
          { id: 'sqlite', label: 'SQLite（进程内）', available: false, dialect: 'SQLite 3.x',
            reason: 'worker/sandbox 未就绪：Python 沙箱执行器未安装（pip install -r worker/requirements.txt 后重试）',
            doc: 'docs/LAB_DB_DEPLOY.md §6' },
          { id: 'mysql', label: 'MySQL 8.0 容器', available: false, dialect: 'MySQL 8.0',
            reason: '未安装 Docker', doc: 'docs/LAB_DB_DEPLOY.md §2.1' },
        ],
        limits: { maxRows: 200, timeoutMs: 3000, maxDbBytes: 20971520 },
      },
    }
  }
  return {
    version: '2.0.0-mock',
    adapters: ['pdf', 'pptx', 'docx', 'text', 'video'],
    providers: {
      llm: [{ id: 'amr', label: 'AMR LLM（deepseek-v4.1-flash）', vendor: 'AMR', runtime: 'cloud', configured: true, available: true, capabilities: { jsonSchema: true }, pricing: { unit: 'token', amount: 0, currency: 'CNY' } }],
      asr: [
        { id: 'local-fw', label: '本地 faster-whisper', vendor: '本地', runtime: 'local', configured: true, available: true, capabilities: { wordTimestamps: true, rtf: 2.0 }, pricing: { unit: 'hour', amount: 0, currency: 'CNY', note: '本地 CPU' } },
        { id: 'aliyun-asr', label: '阿里云智能语音', vendor: '阿里云', runtime: 'cloud', configured: false, available: false, reason: '缺少 ALIYUN_AK / ALIYUN_SK / ALIYUN_APPKEY（在 course-kb/.env 配置）' },
      ],
      tts: [{ id: 'aliyun-tts', label: '阿里云语音合成', vendor: '阿里云', runtime: 'cloud', configured: true, available: true, capabilities: { voices: ['zhixiaobai'] } }],
      translate: [{ id: 'llm-mt', label: 'LLM 翻译（术语表）', runtime: 'cloud', configured: true, available: true, capabilities: { glossary: true, keepIdentifiers: true } }],
      ocr: [{ id: 'baidu-ocr', label: '百度 OCR', runtime: 'cloud', configured: false, available: false, reason: '缺少 BAIDU_OCR_KEY（可选能力：不可用时视频只出帧图+时间点）' }],
    },
    policy: { asr: 'local-first', tts: 'cloud-first', translate: 'cloud-first' },
    pi: { available: true, version: '1.2.0', mode: 'sdk' },
    ffmpeg: { available: true, version: 'N-124868' },
    // 真后端 15s TTL 缓存（backend-api 2026-10-15 实测 17079ms → 7ms）：如实标注，不假装实时
    cached: true, cached_age_ms: 6, cache_ttl_ms: 15000,
    /**
     * ★ `/capabilities.chat_modes`（backend-api 实测）：**服务端权威清单** ——
     * 前端只读它，**不按 user.roles 推断**（本轮已因"按预期形状读"吃过亏）。
     * 模式是**会话级**的（工具集在建会话时确定）→ 切模式要 `?mode=` 重连。
     */
    // ⚠️ 这里**不能引用 CFG** —— `capabilitiesPayload()` 在模块顶层，而 CFG 在 WS 处理函数作用域内
    //    （第一版引用 CFG.agent_roles → `CFG is not defined` → 500 → 整个练习台被门控，实测踩到）
    chat_modes: {
      modes: ['chat', 'agent'], default: 'chat',
      tools: { chat: [], agent: ['kb_search', 'kb_get'] },
      allowed_roles: { agent: (globalThis.__MOCK_CFG__?.agent_roles) || ['admin', 'teacher', 'student'] },
      kb: { available: true, readonly: true, scoped_by: 'userId' },
      note: '模式是会话级的：请用 ?mode=agent 连接；未知 mode → 明确报错',
    },
    retrieval: {
      modes: ['none', 'wiki', 'kg', 'rag'], default: 'none',
      summary: {
        any_available: true, any_data: !(globalThis.__MOCK_CFG__?.empty_kb), empty_kb: !!(globalThis.__MOCK_CFG__?.empty_kb),
        hint: '检索能力已就绪，但知识库当前为空（未抽取）→ 先上传资料并跑抽取，否则任何检索都必然 0 命中',
      },
    },
    sandbox: {
      available: true,
      defaultEngine: 'sqlite',
      // 诚实标注（真后端 backend-api 2026-10-15 加的）：跨调用事务不支持 —— 每次 execute 独立进程
      transactions_cross_call: false,
      transactions_note: '跨调用事务不支持：每次 execute 独立进程（硬超时强杀 + 学生间隔离的安全前提，有意设计）。事务实验请用 multi:true 单次执行。',
      engines: [
        { id: 'sqlite', label: 'SQLite（进程内）', available: true, dialect: 'SQLite 3.x' },
        { id: 'mysql', label: 'MySQL 8.0 容器', available: false, dialect: 'MySQL 8.0', reason: '未安装 Docker（见 docs/LAB_DB_DEPLOY.md §2.1）', doc: 'docs/LAB_DB_DEPLOY.md §2.1' },
      ],
      limits: { maxRows: 200, timeoutMs: 3000, maxDbBytes: 20971520 },
    },
  }
}

/* ---------------- 模型设置（docs/SETTINGS_AND_SANDBOX.md §2） ---------------- */

/** 端点实测只有 8 个 LLM（见文档 §0）；这里如实列出，并给真探测式的延迟 */
const MODELS = [
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', provider: 'amr', available: true, latencyMs: 3800, probe: 'live', contextWindow: 131072 },
  { id: 'deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash (0731)', provider: 'amr', available: true, latencyMs: 4100, probe: 'live', contextWindow: 131072 },
  { id: 'glm-5.2', label: 'GLM 5.2', provider: 'amr', available: true, latencyMs: 2600, probe: 'live', contextWindow: 131072 },
  { id: 'glm-5.3', label: 'GLM 5.3', provider: 'amr', available: true, latencyMs: 2400, probe: 'live', contextWindow: 131072 },
  { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash', provider: 'amr', available: true, latencyMs: 1500, probe: 'live', contextWindow: 131072 },
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', provider: 'amr', available: true, latencyMs: 5200, probe: 'live', contextWindow: 262144 },
  { id: 'kimi-k3', label: 'Kimi K3', provider: 'amr', available: true, latencyMs: 6100, probe: 'live', contextWindow: 262144 },
  { id: 'minimax-m3', label: 'MiniMax M3', provider: 'amr', available: false, latencyMs: null, probe: 'live', reason: '探测失败：HTTP 503（模型维护中）' },
]

/** 探测失败模型（用来验证"切到坏模型要回滚"）：切到它 → 502 + 保持原模型 */
const BROKEN_MODELS = new Set(['minimax-m3'])

export function settingsPayload(state) {
  return {
    $schema: './settings.schema.json',
    version: 1,
    source: state.settingsSource,               // 'file' | 'default'
    llm: {
      active: state.activeModel,
      fallbacks: ['glm-5.3', 'kimi-k3'],
      temperature: 0,
      maxTokens: 16384,                          // ★ 含推理预算（实测 8 字用 54 reasoning token）
      structured: { jsonSchemaStrict: true },
      concurrency: 1,                            // ★ 只读：系统约束，配置调高会被忽略
      concurrencyLocked: true,
      concurrencyNote: '固定=1（系统约束，用户硬要求）：配置文件里调高会被忽略',
    },
    asr: { active: 'local-fw', model: 'tiny', fallbacks: ['aliyun-asr'] },
    tts: { active: null },
    translate: { active: 'llm-mt', glossaryMode: 'inject', keepIdentifiers: true },
    sandbox: state.sandbox,
    quota: { student: { concurrentLlmTasks: 1, dailyLlmCalls: 200 }, teacher: { concurrentLlmTasks: 2, dailyLlmCalls: 2000 } },
    hotReload: { watch: true, debounceMs: 500 },
    switchedFrom: state.switchedFrom,
    switchedAt: state.switchedAt,
  }
}

/** 数据集元信息：从建表脚本抽出表名 */
function splitTables(schemaSql) {
  return (String(schemaSql).match(/CREATE\s+TABLE\s+([A-Za-z_][\w]*)/gi) || []).map((s) => s.replace(/CREATE\s+TABLE\s+/i, ''))
}

/** 方言差异（诚实标注：SQLite ≠ MySQL） */
const DIALECT_NOTES = [
  { sqlite: 'AUTOINCREMENT', mysql: 'AUTO_INCREMENT', note: '自增列的写法不同' },
  { sqlite: 'TEXT / INTEGER', mysql: 'VARCHAR / INT', note: '类型名不同（SQLite 是动态类型）' },
  { sqlite: 'PRAGMA table_info(t)', mysql: 'DESCRIBE t', note: '看表结构的命令不同' },
  { sqlite: '无存储过程 / 无权限体系', mysql: 'PROCEDURE / GRANT', note: '这两类实验在 SQLite 上做不了（见 §6 对照表）' },
  { sqlite: '窗口函数需 ≥3.25', mysql: '8.0 起支持', note: '版本门槛不同' },
]

/* ---------------- 其它素材 ---------------- */

let WAV = null
function silentWav(seconds = 60, rate = 8000) {
  if (WAV) return WAV
  const dataLen = rate * seconds * 2
  const buf = Buffer.alloc(44 + dataLen)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataLen, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)        // PCM
  buf.writeUInt16LE(1, 22)        // mono
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataLen, 40)
  WAV = buf
  return WAV
}
const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex')
const MINIMAL_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')

/* ---------------- server ---------------- */

export function startMockServer({ degraded = false, port = 0, dist = DIST } = {}) {
  const F = buildFixture()
  let CONV_SEQ = 0
  /** ★ 会话消息表（模拟 pi 的落盘转录）：重连同一 sessionId 时用 `history` 帧下发 */
  const SESSION_MSGS = new Map()
  /** ★ 记录 reparse 调用次数：用于断言"禁用状态下点击**不发请求**" */
  let REPARSE_CALLS = 0
  /** ★ 视频目录夹具（collections 契约）；`can_manage` 由**夹具角色**决定（模拟服务端计算） */
  const COLLECTIONS_FIXTURE = () => {
    const teacher = (globalThis.__MOCK_CFG__?.role || 'teacher') === 'teacher'
    return [
      { id: 'col_0001', name: '第 5 讲 索引与执行计划', description: '合成夹具数据', owner_id: 'usr_mock',
        visibility: 'class', review_status: 'approved', sort_order: 1, created_at: 1760400000000, updated_at: 1760400001000,
        published: true, can_manage: teacher, video_count: 1 },
      { id: 'col_0002', name: '第 6 讲 事务与锁', description: null, owner_id: 'usr_other',
        visibility: 'class', review_status: 'pending', sort_order: 2, created_at: 1760400002000, updated_at: 1760400002000,
        published: false, can_manage: false, video_count: 0 },
    ]
  }
  let AI_PARSE_CALLS = 0
  /** ★ 新建的目录（夹具静态列表之外，模拟"服务端真的存了"） */
  const CREATED_COLLECTIONS = []
  /** ★ 会话命名夹具：`title_source` 由**服务端**给（default/user/ai）；含调用计数供断言 */
  let RENAME_CALLS = 0
  let GEN_CALLS = 0
  const TITLE_STATE = new Map([
    ['cnv_mock0001', { title: '新问答', title_source: 'default' }],
    ['cnv_mock0002', { title: 'B+ 树节点分裂的代价', title_source: 'ai' }],
  ])
  const CFG = { strip_unit_ids: false, no_video_artifact: false, uploads: [], role: 'teacher', running_llm: true,
    /** 检索帧用哪种模式（none/wiki/kg/rag）；kg_hit=1 时 kg 才有命中（默认 kg = 查了 0 命中） */
    retrieval: 'wiki', kg_hit: false,
    /** agent 模式允许的角色（服务端权威；默认 admin+teacher，student 只给 chat） */
    agent_roles: ['admin', 'teacher'],
    /** 知识库为空（agent 必然 0 命中 → 前端要如实提示"先上传并抽取"） */
    empty_kb: false,
    /** 助手回答用"含公式/代码/未闭合围栏"的样例（e2e ?rich=1） */
    rich_answer: false,
    /** 连接后是否发 `history` 帧（夹具 ?history=1） */
    history: false,
    /** ★ 抽取可用性三态夹具（?avail=detecting|unavailable）—— pi-bridge 的 ready/detecting/unavailable */
    avail_state: '',
    /** 视频目录接口"未实现"注入（夹具 ?collections_missing=1） */
    collections_missing: false,
    /** 重命名失败注入（夹具 ?rename_fail=1）：验证"乐观更新失败 → 回滚 + 如实提示" */
    rename_fail: false,
    /** 会话登记失败注入（夹具 ?conv_fail=1）：验证"登记失败 → 输入禁用 + 可读提示" */
    conv_fail: false }
  globalThis.__MOCK_CFG__ = CFG   // capabilitiesPayload() 在顶层，靠它读到 fixture 开关
  /** 模型/设置/sandbox 的运行期状态（真后端在 settings.json + SQLite 里） */
  const STATE = {
    activeModel: 'deepseek-v4.1-flash',
    switchedFrom: null,
    switchedAt: null,
    settingsSource: 'file',
    runningLlmTask: true,            // 默认"批量推理运行中" → 设置页必须走"终止并切换"
    running: { taskId: 'tsk_rollup0001', kind: 'rollup', done: 137, total: 368, model: 'deepseek-v4.1-flash' },
    sandbox: {
      enabled: !degraded,
      engine: degrading() ? 'none' : 'sqlite',
      engines: [
        {
          id: 'sqlite', label: 'SQLite（进程内，本机已装）', available: !degraded, dialect: 'SQLite 3.x',
          reason: degraded ? 'worker/sandbox 未就绪：Python 沙箱执行器未安装（pip install -r worker/requirements.txt 后重试）' : '',
          doc: 'docs/LAB_DB_DEPLOY.md §6',
        },
        {
          id: 'mysql', label: 'MySQL 8.0 容器', available: false, dialect: 'MySQL 8.0',
          reason: '未安装 Docker：本机无法起 MySQL 容器（见 docs/LAB_DB_DEPLOY.md §2.1）',
          doc: 'docs/LAB_DB_DEPLOY.md §2.1',
        },
        {
          id: 'postgres', label: 'PostgreSQL 16 容器', available: false, dialect: 'PostgreSQL 16',
          reason: '未安装 Docker', doc: 'docs/LAB_DB_DEPLOY.md §2.2',
        },
      ],
      limits: { maxRows: 200, timeoutMs: 3000, maxDbBytes: 20971520 },
      allowWrites: true, resetPolicy: 'per_session',
    },
    session: null,
    lastSql: [],
    audit: [],
  }
  function degrading() { return degraded }

  const DATASET = DATASETS[0]
  let release = null
  const holdWaiters = []

  // ★ 必须 async：JSON 端点要 `await readJson(req)` 收请求体（mock 是裸 http server，没有 req.body）
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const p = u.pathname
    const q = u.searchParams
      /** ★ 收 JSON body（mock 是裸 http server，**没有** `req.body`） */
      const readJson = (r) => new Promise((resolve) => {
        const chunks = []
        r.on('data', (c) => chunks.push(c))
        r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve({}) } })
      })

    const json = (obj, status = 200) => {
      const body = Buffer.from(JSON.stringify(obj), 'utf8')
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
      res.end(body)
    }
    const err = (status, code, msg, hint = '') => json({ error: { code, msg, detail: '', hint } }, status)
    const bytes = (data, ctype, status = 200, extra = {}) => {
      res.writeHead(status, { 'Content-Type': ctype, 'Content-Length': data.length, 'Accept-Ranges': 'bytes', ...extra })
      res.end(data)
    }
    const ranged = (data, ctype) => {
      const rng = req.headers.range
      if (!rng || !rng.startsWith('bytes=')) return bytes(data, ctype)
      const [a, b] = rng.slice(6).split(',')[0].split('-')
      const start = Math.max(0, a ? Number(a) : 0)
      const end = Math.min(data.length - 1, b ? Number(b) : data.length - 1)
      const chunk = data.subarray(start, end + 1)
      res.writeHead(206, {
        'Content-Type': ctype, 'Content-Length': chunk.length, 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${data.length}`,
      })
      res.end(chunk)
    }
    const listOf = (arr, key) => ({ total: arr.length, offset: 0, limit: arr.length, [key]: arr })

    try {
      // ---------- 静态（dist） ----------
      if (!p.startsWith('/api/')) {
        let rel = p === '/' ? 'index.html' : p.replace(/^\//, '')
        let file = path.join(dist, rel)
        if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          file = path.join(dist, 'index.html')       // hash 路由：SPA 兜底
        }
        if (!fs.existsSync(file)) return err(404, 'E_NOTFOUND', 'dist 不存在，先 npm run build')
        const ext = path.extname(file)
        const ctype = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream'
        return bytes(fs.readFileSync(file), ctype)
      }

      const api = p.slice('/api/v1'.length)

      // ---------- 无头同步屏障 ----------
      if (api === '/_fixture/hold') {
        const done = () => { release = null; if (!res.writableEnded) bytes(PNG_1PX, 'image/png') }
        if (release) return done()
        holdWaiters.push(done)
        setTimeout(() => { if (holdWaiters.includes(done)) { holdWaiters.splice(holdWaiters.indexOf(done), 1); done() } }, 90_000)
        return
      }
      if (api === '/_fixture/release') {
        release = true
        const ws = holdWaiters.splice(0)
        ws.forEach((f) => f())
        return json({ released: true })
      }
      // ★ 会话列表：**真实接口是 `GET /conversations`**（Lead 实测 /chat/sessions 不存在 → 404）
    // ★ 重新解析（202 契约）；`/_fixture/reparse_calls` 暴露调用次数给 e2e
    if (api === '/_fixture/reparse_calls') return json({ calls: REPARSE_CALLS })
    if (api === '/_fixture/ai_parse_calls') return json({ calls: AI_PARSE_CALLS })
    if (api === '/_fixture/title_calls') return json({ rename: RENAME_CALLS, generate: GEN_CALLS })
    // ★ 重命名（PATCH /conversations/:id {title}）→ 服务端返回 title_source:'user'
    if (/^\/conversations\/[^/]+$/.test(api) && req.method === 'PATCH') {
      RENAME_CALLS += 1
      const id = api.split('/')[2]
      const body = await readJson(req)
      if (CFG.rename_fail) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { code: 'E_MOCK', msg: '重命名失败（夹具注入）' } }))
      }
      const cur = TITLE_STATE.get(id) || { title: '新问答', title_source: 'default' }
      const next = { title: String(body.title || '').slice(0, 80), title_source: 'user' }
      TITLE_STATE.set(id, next)
      return json({ conversation: { id, ...next, doc_id: null, created_at: Date.now() } })
    }
    // ★ AI 生成名字（POST /conversations/:id/title/generate）；已由用户命名 → 409 E_TITLE_USER_SET
    if (/^\/conversations\/[^/]+\/title\/generate$/.test(api) && req.method === 'POST') {
      GEN_CALLS += 1
      const id = api.split('/')[2]
      const cur = TITLE_STATE.get(id) || { title: '新问答', title_source: 'default' }
      if (cur.title_source === 'user') {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { code: 'E_TITLE_USER_SET', msg: '会话已由用户手动命名，不覆盖' } }))
      }
      const next = { title: 'AI 起名：聚簇索引与回表代价', title_source: 'ai' }
      TITLE_STATE.set(id, next)
      return json({ conversation: { id, ...next, doc_id: null, created_at: Date.now() } })
    }
    // ★ 视频目录（collections 契约）
    if (api === '/collections' && req.method === 'GET') {
      if (globalThis.__MOCK_CFG__?.collections_missing) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { code: 'E_NOTFOUND', msg: '接口尚未实现（夹具注入）' } }))
      }
      /**
       * ⚠️ `can_manage` 必须**按当前请求者的角色重算**（服务端语义）：
       *   我第一版让"新建的目录"带着创建时的 `can_manage: true` 留在内存里 →
       *   下一个用例切成学生角色后**仍然看得到教师入口**（夹具状态泄漏，与 conv_fail 那次同族）。
       */
      const role = globalThis.__MOCK_CFG__?.role || 'teacher'
      const list = [...COLLECTIONS_FIXTURE(),
        ...CREATED_COLLECTIONS.map((c) => ({ ...c, can_manage: role === 'teacher' }))]
      return json({ total: list.length, collections: list })
    }
    if (api === '/collections' && req.method === 'POST') {
      const body = await readJson(req)
      if ((globalThis.__MOCK_CFG__?.role || 'teacher') !== 'teacher') {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { code: 'E_FORBIDDEN', msg: '只有教师可以建目录' } }))
      }
      const created = { id: `col_new_${Math.random().toString(16).slice(2, 8)}`, name: body.name,
        owner_id: 'usr_mock', visibility: body.visibility || 'class', review_status: 'draft',
        published: false, can_manage: true, video_count: 0, created_at: Date.now(), updated_at: Date.now() }
      CREATED_COLLECTIONS.push(created)   // ★ 新建的要真的进列表（否则"创建后列表增加"不可验）
      return json({ collection: created }, 201)
    }
    if (/^\/collections\/[^/]+\/videos$/.test(api)) {
      const cid = api.split('/')[2]
      const videos = cid === 'col_0001'
        ? [
            { id: DOC_VIDEO, title: '第 5 讲 索引与执行计划（合成夹具数据）', kind: 'video', collection_id: cid,
              duration_ms: 1_800_000, size_bytes: 1024 * 1024,
              parse_state: 'done', parse_reason: null,
              ai_parse: { available: true, reason: null, llm_model: 'deepseek-v4.1-flash',
                cost_note: '解析会消耗 LLM 额度（约 1 讲一次）。', estimated_llm_calls: 42 } },
            { id: 'doc_video_raw_0002', title: '第 5 讲 原始录像（未解析）', kind: 'video', collection_id: cid,
              parse_state: 'none', parse_reason: '还没有解析过',
              ai_parse: { available: false, reason: 'ASR 能力不可用：缺少 faster-whisper（见 /capabilities）',
                llm_model: 'deepseek-v4.1-flash', cost_note: '解析会消耗 LLM 额度。', estimated_llm_calls: 38 } },
          ]
        : []
      return json({ total: videos.length, videos })
    }
    // ★ 触发 AI 解析（POST /tasks {kind:'video_parse'}）
    if (api === '/tasks' && req.method === 'POST') {
      void (await readJson(req))   // 收掉请求体（避免 keep-alive 下污染下一个请求）
      AI_PARSE_CALLS += 1
      return json({ task_id: 'tsk_aiparse_mock', status: 'queued' }, 202)
    }
    if (/^\/documents\/[^/]+\/reparse$/.test(api) && req.method === 'POST') {
      REPARSE_CALLS += 1
      return json({
        document_id: api.split('/')[2], task_id: 'tsk_reparse_mock', status: 'queued',
        events_url: '/api/v1/tasks/tsk_reparse_mock/events', needs_ocr: true,
        est_minutes: [65, 87],
        cost_note: '重跑会重新解析并在完成后自动抽取（抽取会消耗 LLM 额度）。',
      }, 202)
    }
    if (api === '/conversations' && req.method === 'GET') {
      return json({
        total: 2, offset: 0, limit: 50,
        conversations: [
          { id: 'cnv_mock0001', title: TITLE_STATE.get('cnv_mock0001').title,
            title_source: TITLE_STATE.get('cnv_mock0001').title_source, doc_id: null, created_at: Date.now() - 3600_000 },
          { id: 'cnv_mock0002', title: TITLE_STATE.get('cnv_mock0002').title,
            title_source: TITLE_STATE.get('cnv_mock0002').title_source, doc_id: null, created_at: Date.now() - 86_400_000 },
        ],
      })
    }
    // ★ 登记会话（安全修复后的**唯一合法入口**）：返回服务端签发的 id
    if (api === '/conversations' && req.method === 'POST' && CFG.conv_fail) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { code: 'E_UNAVAILABLE', msg: '会话登记服务不可用（夹具注入）' } }))
    }
    if (api === '/conversations' && req.method === 'POST') {
      CONV_SEQ += 1
      const id = `cnv_mock${String(CONV_SEQ).padStart(4, '0')}${Math.random().toString(16).slice(2, 6)}`
      return json({ conversation: { id, user_id: 'usr_mock', doc_id: null, title: '新会话', created_at: Date.now() } }, 201)
    }
    // 老别名（保留 404 语义，验证前端优先走 /conversations）
    if (api === '/chat/sessions') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { code: 'E_NOTFOUND', msg: '接口不存在' } }))
    }
    if (api === '/_fixture/config') {
        for (const k of Object.keys(CFG)) if (q.has(k) && typeof CFG[k] === 'boolean') CFG[k] = ['1', 'true', 'yes'].includes(q.get(k))
        if (q.has('role')) CFG.role = q.get('role')
        if (q.has('maxrows')) { STATE.sandbox.limits.maxRows = Math.max(1, Number(q.get('maxrows')) || 200); if (STATE.db) STATE.db.maxRows = STATE.sandbox.limits.maxRows }
        if (q.has('retrieval')) CFG.retrieval = q.get('retrieval')
        if (q.has('agent_roles')) CFG.agent_roles = String(q.get('agent_roles')).split(',').filter(Boolean)
        if (q.has('empty_kb')) CFG.empty_kb = ['1', 'true'].includes(q.get('empty_kb'))
        if (q.has('rich')) CFG.rich_answer = ['1', 'true'].includes(q.get('rich'))
        if (q.has('history')) CFG.history = ['1', 'true'].includes(q.get('history'))
        if (q.has('conv_fail')) CFG.conv_fail = ['1', 'true'].includes(q.get('conv_fail'))
        if (q.has('collections_missing')) CFG.collections_missing = ['1', 'true'].includes(q.get('collections_missing'))
        if (q.has('rename_fail')) CFG.rename_fail = ['1', 'true'].includes(q.get('rename_fail'))
        if (q.has('avail')) CFG.avail_state = String(q.get('avail') || '')
    // ⚠️ mock 里有**两个** server（normal/degraded），各自有自己的 CFG；而 WS 处理函数读的是
    //    `globalThis.__MOCK_CFG__`（谁后创建谁覆盖）→ 夹具必须**顺手把自己这份发布出去**，
    //    否则"给 normal 设的开关"会被 degraded 的 CFG 覆盖（实测：history 帧发不出来）
    globalThis.__MOCK_CFG__ = CFG
        if (q.has('kg_hit')) CFG.kg_hit = ['1', 'true'].includes(q.get('kg_hit'))
        if (q.has('running_llm')) { CFG.running_llm = ['1', 'true', 'yes'].includes(q.get('running_llm')); STATE.runningLlmTask = CFG.running_llm }
        return json({ config: { ...CFG, uploads: CFG.uploads.length } })
      }
      if (api === '/_fixture/meta') return json({ degraded, meta: F.meta, config: CFG })

      // ---------- §5.1 ----------
      if (api === '/health') return json({ ok: true, version: '2.0.0-mock' })
      if (api === '/capabilities') return json(capabilitiesPayload(degraded))

      // ---------- 身份（RBAC §3；前端用它决定"设置"入口是否可见） ----------
      if (api === '/auth/me') {
        const role = q.get('role') || CFG.role || 'teacher'
        return json({
          user: { id: 'usr_0001', username: role === 'student' ? 'student01' : 'teacher01', display_name: role === 'student' ? '学生账号' : '王老师' },
          roles: [role], authRequired: true,
          permissions: role === 'student'
            ? ['documents:read', 'sandbox:use', 'notes:own']
            : ['documents:read', 'documents:write', 'settings:read', 'settings:write', 'sandbox:use', 'users:manage'],
        })
      }

      // ---------- 模型列表（SETTINGS §2：每个模型要给 available + 真探测延迟） ----------
      if (api === '/models') {
        return json({
          models: MODELS.map((m) => (degraded ? { ...m, available: false, latencyMs: null, reason: 'LLM 端点不可达（mock degraded）' } : m)),
          activeModel: STATE.activeModel,
          switchedFrom: STATE.switchedFrom,
          switchedAt: STATE.switchedAt,
          concurrency: 1,
          concurrencyLocked: true,
          probe: { at: Date.now(), cached: false },
        })
      }

      // ---------- 设置（只读脱敏；PUT 需要 admin） ----------
      if (api === '/settings' && req.method === 'GET') return json(settingsPayload(STATE))
      if (api === '/settings' && req.method === 'PUT') {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        return req.on('end', () => {
          let body = {}
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* ignore */ }
          // ★ concurrency 只读：调高一律忽略并如实说明（不许静默生效）
          const ignored = []
          if (body?.llm?.concurrency != null && Number(body.llm.concurrency) !== 1) {
            ignored.push({ field: 'llm.concurrency', requested: body.llm.concurrency, applied: 1, reason: '固定=1（系统约束）' })
          }
          if (body?.llm?.active) {
            const m = MODELS.find((x) => x.id === body.llm.active)
            if (!m) return err(400, 'E_SETTINGS_INVALID', `未知模型：${body.llm.active}`, '用 /api/v1/models 的 id')
            if (!m.available) return err(400, 'E_MODEL_UNAVAILABLE', `模型 ${m.id} 探测不可用：${m.reason || ''}`, '先修端点或换模型')
            STATE.activeModel = m.id
          }
          if (body?.sandbox?.limits?.maxRows) STATE.sandbox.limits.maxRows = Math.min(2000, Number(body.sandbox.limits.maxRows))
          STATE.audit.push({ at: Date.now(), action: 'settings_update', ignored })
          json({ ok: true, settings: settingsPayload(STATE), ignored, source: STATE.settingsSource })
        })
      }

      // ---------- 模型热切换（SETTINGS §2 状态机） ----------
      if (api === '/settings/llm/switch' && req.method === 'POST') {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        return req.on('end', () => {
          let body = {}
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* ignore */ }
          const target = MODELS.find((m) => m.id === body.model)
          const mode = String(body.mode || 'drain')
          if (!target) return err(400, 'E_SETTINGS_INVALID', `未知模型：${body.model}`)
          if (mode === 'now' && STATE.runningLlmTask) {
            return err(409, 'E_MODEL_BUSY', `有批量推理在跑（${STATE.running.kind} ${STATE.running.done}/${STATE.running.total}），不能直接热切`,
              '用 mode:"drain" 等当前单元跑完，或 mode:"abort" 保存断点后终止并续推',
              { running: STATE.running, activeModel: STATE.activeModel })
          }
          // 真探测：切到坏模型 → 502 + 回滚（绝不把系统留在"配了个坏模型"的状态）
          if (BROKEN_MODELS.has(target.id) || !target.available) {
            const from = STATE.activeModel
            STATE.audit.push({ at: Date.now(), action: 'model_switch', from, to: target.id, result: 'probe_failed' })
            return err(502, 'E_MODEL_PROBE', `新模型 ${target.id} 健康探测失败：${target.reason || 'HTTP 503'}`,
              `已回滚到 ${from}（activeModel 未变）`,
              { activeModel: from, rolledBack: true, probe: { model: target.id, ok: false } })
          }
          const from = STATE.activeModel
          const checkpoint = { done: STATE.running.done, total: STATE.running.total, taskId: STATE.running.taskId }
          if (mode === 'abort') {
            STATE.runningLlmTask = false
            STATE.running = { ...STATE.running, done: checkpoint.done, total: checkpoint.total }
          } else if (mode === 'drain') {
            STATE.runningLlmTask = false
          }
          STATE.activeModel = target.id
          STATE.switchedFrom = from
          STATE.switchedAt = Date.now()
          STATE.audit.push({ at: Date.now(), action: 'model_switch', from, to: target.id, mode, result: 'ok' })
          json({
            ok: true, mode, from, to: target.id,
            checkpoint,
            resume: { state: mode === 'now' ? 'idle' : 'resuming', from_checkpoint: checkpoint.done, total: checkpoint.total },
            probe: { model: target.id, ok: true, latencyMs: target.latencyMs, at: Date.now() },
            activeModel: STATE.activeModel, switchedFrom: STATE.switchedFrom, switchedAt: STATE.switchedAt,
          })
        })
      }

      // ---------- 学生虚拟数据库沙箱（SETTINGS §3） ----------
      // 真形状：`{default, datasets:[{id,label,description,tables,teachingPoints,dialectNotes}]}`
      // 真后端 `GET /settings/llm`：切换相关的只读视图（switchedFrom/switchedAt/busy 在这里，不在 /models）
      if (api === '/settings/llm' && req.method === 'GET') {
        return json({
          activeModel: STATE.activeModel,
          fallbacks: MODELS.filter((x) => x.fallback).map((x) => x.id),
          concurrency: 1,
          switchedFrom: STATE.switchedFrom ?? null,
          switchedAt: STATE.switchedAt ?? null,
          busy: STATE.runningLlmTask
            ? { busy: true, runningLlm: [STATE.running.kind], runningAll: 1, pending: 0, llmKinds: ['extract', 'rollup', 'translate'], source: 'queue.runningSummary' }
            : { busy: false, runningLlm: [], runningAll: 0, pending: 0, llmKinds: ['extract', 'rollup', 'translate'], source: 'queue.runningSummary' },
        })
      }

      if (api === '/sandbox/datasets') {
        return json({
          default: DATASET.id,
          datasets: DATASETS.map(({ id, label, note, description, schema, seed, tables, teachingPoints, dialectNotes }) => ({
            id, label, description: description || note || '', tables: tables || splitTables(schema),
            teachingPoints: teachingPoints || [], dialectNotes: dialectNotes || [],
          })),
        })
      }

      if (api === '/sandbox/session' && req.method === 'POST') {
        if (degraded) return err(503, 'E_SANDBOX_UNAVAILABLE', STATE.sandbox.engines[0].reason, '见 docs/LAB_DB_DEPLOY.md')
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        return req.on('end', () => {
          let body = {}
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* ignore */ }
          const ds = DATASETS.find((d) => d.id === body.dataset) || DATASET
          const db = new SandboxDb(ds.schema, ds.seed)
          STATE.db = db
          STATE.dataset = ds.id
          STATE.session = { sessionId: `sbx_${ds.id}_${Math.random().toString(36).slice(2, 8)}`, user: 'student01', engine: 'sqlite', dialect: 'SQLite 3.x' }
          const tables = db.snapshot()
          // 真形状：`{sessionId,engine,dataset,created,dbBytes,schema:{dialect,tables:[{name,columns:[{name,…}],rows}]},limits}`
          // `tables` 是我早期自造字段 —— 保留它只为兼容旧断言，前端已改为读 schema.tables
          json({ sessionId: STATE.session.sessionId, engine: 'sqlite', dataset: ds.id, created: true,
            dbBytes: 20480,
            schema: { dialect: 'sqlite', tables: tables.map((x) => ({
              name: x.name, rows: x.rowCount,
              columns: x.columns.map((c) => ({ name: c, type: 'TEXT' })),
            })) },
            tables, limits: STATE.sandbox.limits,
            dialectNotes: ds.dialectNotes?.length ? ds.dialectNotes : DIALECT_NOTES })
        })
      }

      if (api === '/sandbox/execute' && req.method === 'POST') {
        if (degraded) return err(503, 'E_SANDBOX_UNAVAILABLE', STATE.sandbox.engines[0].reason)
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        return req.on('end', () => {
          let body = {}
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* ignore */ }
          if (!STATE.db) return err(409, 'E_SANDBOX_NO_SESSION', '还没有沙箱会话：先 POST /sandbox/session')
          const sql = String(body.sql || '')
          // ⚠️ sandboxError 把 code 放在 `e.sandbox.code`（真后端形状），不是 `e.code`
          const killExtra = (e) => ((e.sandbox?.code ?? e.code) === 'E_SQL_TIMEOUT'
            ? { killedBy: 'progress', hardKilled: false } : {})
          try {
            // 整批执行（multi:true）：同一次进程内跑完所有语句 —— 事务（BEGIN/COMMIT/ROLLBACK）才有意义
            const r = body.multi === true
              ? STATE.db.executeMulti(sql, { maxRows: STATE.sandbox.limits.maxRows })
              : STATE.db.execute(sql, { maxRows: STATE.sandbox.limits.maxRows })
            STATE.lastSql.unshift({ sql, at: Date.now(), ok: true, rowCount: r.rowCount, elapsedMs: r.elapsedMs })
            STATE.audit.push({ at: Date.now(), action: 'sandbox_execute', sql: sql.slice(0, 200), ok: true })
            json({ ...r, ok: r.ok !== false, sessionId: STATE.session.sessionId, engine: 'sqlite',
              statementKind: r.statementKind || null, hints: [],
              schema: { dialect: 'sqlite', tables: STATE.db.snapshot().map((x) => ({
                name: x.name, rows: x.rowCount, columns: x.columns.map((c) => ({ name: c, type: 'TEXT' })),
              })) },
              limits: STATE.sandbox.limits })
          } catch (e) {
            STATE.lastSql.unshift({ sql, at: Date.now(), ok: false, error: e.message })
            STATE.audit.push({ at: Date.now(), action: 'sandbox_execute', sql: sql.slice(0, 200), ok: false, code: e.code })
            // ★ 真形状：HTTP 200 + ok:false + error（分类器对象：code/raw/message/hint/localReading/who/who_label/who_source）
            const errObj = e.sandbox || { code: e.code || 'E_SQL_SYNTAX', raw: e.message, message: e.message,
              hint: '', localReading: e.message, localMatched: false, who: 'system', who_label: '系统侧问题', who_source: 'fallback' }
            json({ ok: false, columns: [], rows: [], rowCount: 0, elapsedMs: 0, truncated: false,
              sessionId: STATE.session.sessionId, engine: 'sqlite', statementKind: null,
              error: errObj, ...killExtra(e) })
          }
        })
      }

      if (api === '/sandbox/reset' && req.method === 'POST') {
        if (degraded) return err(503, 'E_SANDBOX_UNAVAILABLE', STATE.sandbox.engines[0].reason)
        const chunks2 = []
        req.on('data', (c) => chunks2.push(c))
        return req.on('end', () => {
          let body = {}
          try { body = JSON.parse(Buffer.concat(chunks2).toString('utf8') || '{}') } catch { /* ignore */ }
          const ds = DATASETS.find((d) => d.id === (body.dataset || STATE.dataset)) || DATASET
          STATE.db = new SandboxDb(ds.schema, ds.seed)
          STATE.dataset = ds.id
          const snap = STATE.db.snapshot()
          // 真形状：`{sessionId, reset:true, engine, schema}`（**没有 tables 顶层字段**）
          return json({ sessionId: STATE.session?.sessionId, reset: true, engine: 'sqlite', dataset: ds.id,
            schema: { dialect: 'sqlite', tables: snap.map((x) => ({ name: x.name, rows: x.rowCount,
              columns: x.columns.map((c) => ({ name: c, type: 'TEXT' })) })) } })
        })
      }

      if (api === '/sandbox/history') {
        return json({ sessionId: STATE.session?.sessionId, entries: STATE.lastSql.slice(0, 30).map((e) => ({
          at: e.at, sql: e.sql, ok: e.ok, error: e.error || null, rowCount: e.rowCount ?? 0, elapsedMs: e.elapsedMs ?? 0,
          kind: String(e.sql).trim().split(/\s+/)[0].toUpperCase(),
        })) })
      }
      if (api === '/sandbox/schema') {
        const snap = STATE.db ? STATE.db.snapshot() : []
        return json({ sessionId: STATE.session?.sessionId, dialect: 'sqlite', tables: snap.map((x) => ({
          name: x.name, rows: x.rowCount, columns: x.columns.map((c) => ({ name: c, type: 'TEXT' })),
        })) })
      }

      // ---------- ★ AI 答疑（SETTINGS §3：先问后引 + 必须引用知识库卡片） ----------
      if (api === '/sandbox/ask' && req.method === 'POST') {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        return req.on('end', () => {
          let body = {}
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* ignore */ }
          const sql = String(body.sql || '')
          const errMsg = String(body.error || '')
          const question = String(body.question || '')
          // 引用：把 SQL 里出现的标识符去知识库里捞（用 mock 的卡片名做真实检索）
          const tokens = (sql.match(/[A-Za-z_][\w]{2,}/g) || []).map((s) => s.toLowerCase())
          const cited = F.cards.filter((c) => tokens.some((t) => (c.name || '').toLowerCase().includes(t))).slice(0, 3)
          const hits = cited.length ? cited : F.cards.slice(0, 2)
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Transfer-Encoding': 'chunked' })
          const send = (event, data) => {
            const buf = Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, 'utf8')
            res.write(`${buf.length.toString(16)}\r\n`)
            res.write(buf)
            res.write('\r\n')
          }
          // ★ 真后端帧名：open / frame / done（frame 里是 pi 消息信封；backend-api 2026-10-15 实测）
          send('open', { sessionId: String(body.sessionId || ''), user: 'student01' })
          send('frame', { type: 'message_end', message: { role: 'user', content: [{ type: 'text',
            text: ['【日志可用性】', '日志情况：**读不到**该实例的引擎日志（原因：服务端未配置数据库日志源（logSource 未接入））。', '',
              '【学生的 SQL】' + sql, '【报错】' + errMsg, '【问题】' + question].join('\n') }] } })
          const answer = [
            '先别急着要答案 —— 按"先问后引"来：\n',
            errMsg
              ? `① 你这句的报错是 \`${errMsg}\`。它属于**"对象不存在"**这一类（不是语法错），先确认表名/列名拼写。\n`
              : '① 这句能跑通，但结果可能不是你要的：先确认 WHERE 的过滤条件对应的是哪一列。\n',
            '② 再想一步：你要的是"哪些行？"还是"每组的汇总？"—— 后者要 GROUP BY，漏了它就会得到逐行的重复值。\n',
            '③ 提示（不给完整答案）：`FROM` 后面的表名要和你 reset 出来的 schema 完全一致；查一列前先用 `PRAGMA table_info(表名)` 看看列名。\n',
            `④ 依据：${hits.map((c) => `[[card:${c.id}]]`).join('')}`,
          ].join('')
          let i = 0
          const step = () => {
            if (i >= answer.length) {
              send('frame', { type: 'settled', aborted: false })
              // done 带**全文 + citations**；citationMode 如实说明引用为何缺失（真后端同名字段）
              send('done', { ok: true, text: answer, citationMode: hits.length ? 'cited' : 'missing',
                citations: hits.map((c) => ({ card_id: c.id, name: c.name, unit_id: c.unit_id })) })
              res.end('0\r\n\r\n')
              return
            }
            send('frame', { type: 'text_delta', delta: answer.slice(i, i + 10) })
            i += 10
            setTimeout(step, 25)
          }
          step()
        })
      }

      // ---------- §5.2 documents ----------
      if (api === '/documents' && req.method === 'GET') {
        let docs = [
          { id: DOC_PDF, title: 'MySQL 26.7 Reference Manual（上游真实产物 · mock）', kind: 'pdf', page_count: 6392, size_bytes: 44160000, lang: 'en', status: 'ready', created_at: 1760400000000, updated_at: 1760400000000,
            // ★ 抽取状态夹具：`done_empty` = **跑完了但零卡片**（绝不能被显示成"成功"）；
            //   `needs_confirm` + 估算（**次数 + 时长都要有**，用户真正感受到的痛是"要等 3–7 小时"）
            meta: { toc_entries: 2545, chapters: 42, extract_status: 'done_empty', needs_confirm: true,
              ...(globalThis.__MOCK_CFG__?.avail_state === 'detecting'
                ? { extract_availability: 'detecting', extract_note: '正在检测模型可用性…已等待 12s' } : {}),
              ...(globalThis.__MOCK_CFG__?.avail_state === 'unavailable'
                ? { extract_availability: 'unavailable', extract_availability_reason: 'LLM 不可用：amr 返回 403（凭据无效）' } : {}),
              extract_estimate: { llm_calls: 2523, duration_human: '3–7 小时' },
              extract_progress: { done: 340, total: 2523 } } },
          { id: DOC_VIDEO, title: '第 5 讲 索引与执行计划（合成夹具数据）', kind: 'video', page_count: 0, size_bytes: 1024 * 1024, lang: 'zh', status: 'ready', created_at: 1760400001000, updated_at: 1760400001000, meta: { fixture: true } },
        ]
        if (q.get('kind')) docs = docs.filter((d) => d.kind === q.get('kind'))
        return json({ total: docs.length, offset: 0, limit: 50, documents: docs })
      }
      if (api === '/documents' && req.method === 'POST') {
        // 上传：读掉 body（multipart），返回 202 + task
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        return req.on('end', () => {
          const id = `doc_up${String(CFG.uploads.length + 1).padStart(8, '0')}`
          CFG.uploads.push({ id, size: Buffer.concat(chunks).length })
          json({ document_id: id, task_id: 'tsk_upload0001', status: 'uploading', events_url: '/api/v1/tasks/tsk_upload0001/events' }, 202)
        })
      }

      // ---------- §5.6 tasks ----------
      // 列表（真后端有 `GET /tasks`；设置页用它判断"有没有在跑的 LLM 任务"）
      if (api === '/tasks' && req.method === 'GET') {
        const list = STATE.runningLlmTask
          ? [{ id: STATE.running.taskId, doc_id: DOC_PDF, kind: STATE.running.kind, status: 'running',
              progress: STATE.running.total ? STATE.running.done / STATE.running.total : 0,
              stage: `汇总单元引言 ${STATE.running.done}/${STATE.running.total}`,
              detail: { kind: STATE.running.kind, done: STATE.running.done, total: STATE.running.total, model: STATE.activeModel },
              error: null }]
          : []
        return json({ total: list.length, tasks: list })
      }
      if (api === '/auth/logout' && req.method === 'POST') return json({ ok: true })
      let m = api.match(/^\/tasks\/([^/]+)(?:\/(.*))?$/)
      if (m) {
        const taskId = m[1]
        const rest = m[2] || ''
        if (rest === '') {
          if (taskId === 'tsk_rollup0001') {
            // 设置页要显示 done/total（切换时也要拿它当断点）→ detail 必须给真实数字
            return json({ id: taskId, kind: 'rollup', status: 'running', progress: 0.372, stage: '汇总单元引言',
              detail: { kind: 'rollup', done: STATE.running.done, total: STATE.running.total, model: STATE.activeModel }, error: null })
          }
          return json({ id: taskId, doc_id: DOC_VIDEO, kind: 'asr', status: 'running', progress: 0.42, stage: '转写音频', detail: {}, error: null })
        }
        if (rest === 'events') {
          // ★ 必须 chunked：HTTP/1.1 无长度裸流会让 Chrome 的 EventSource 立刻 CLOSED（v1 实测）
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Transfer-Encoding': 'chunked',
          })
          /**
           * ★ 重新解析任务（`tsk_reparse_mock`）**保持 running**：
           *   真实的 reparse 要 65–87 分钟 → mock 里"立刻 done"会让**提交时的代价文案**一闪而过，
           *   断言只能看到"完成"（我第一版就是这样假失败的）。
           *   → 只发 progress 帧、不发 done，忠实模拟长任务（也顺便让"进度可见"可断言）。
           */
          const frames = taskId === 'tsk_reparse_mock'
            ? [
                `event: progress\ndata: ${JSON.stringify({ task_id: taskId, progress: 0.05, stage: 'OCR 逐页识别（1/434）', done: 1, total: 434 })}\n\n`,
                ': keepalive\n\n',
              ]
            : [
                `event: progress\ndata: ${JSON.stringify({ task_id: taskId, progress: 0.42, stage: '转写音频', done: 42, total: 100 })}\n\n`,
                ': keepalive\n\n',
                `event: log\ndata: ${JSON.stringify({ task_id: taskId, level: 'info', msg: 'mock：分章与思维导图' })}\n\n`,
                `event: done\ndata: ${JSON.stringify({ task_id: taskId, status: 'done', elapsed_ms: 1200 })}\n\n`,
              ]
          let i = 0
          const write = () => {
            if (i >= frames.length) { res.end('0\r\n\r\n'); return }
            const buf = Buffer.from(frames[i], 'utf8')
            res.write(`${buf.length.toString(16)}\r\n`)
            res.write(buf)
            res.write('\r\n')
            i++
            setTimeout(write, i === 1 ? 150 : 120)
          }
          write()
          return
        }
        if (rest === 'cancel') return json({ ok: true })
      }

      // ---------- documents/{id}/... ----------
      m = api.match(/^\/documents\/([^/]+)(?:\/(.*))?$/)
      if (m) {
        const docId = m[1]
        const rest = m[2] || ''
        if (rest === '') {
          const doc = docId === DOC_VIDEO
            ? { id: DOC_VIDEO, title: '第 5 讲 索引与执行计划（合成夹具数据）', kind: 'video', status: 'ready', page_count: 0 }
            : { id: DOC_PDF, title: 'MySQL 26.7 Reference Manual（mock）', kind: 'pdf', status: 'ready', page_count: 6392 }
          return json(doc)
        }
        if (rest === 'outline') return json({ document_id: docId, roots: F.roots, nodes: F.outlineNodes })
        if (rest === 'units') return json(listOf([...F.units.values()], 'units'))
        if (rest === 'cards') {
          const off = Number(q.get('offset') || 0)
          const lim = Number(q.get('limit') || 50)
          return json({ total: F.cards.length, offset: off, limit: lim, cards: F.cards.slice(off, off + lim) })
        }
        if (rest === 'xrefs') return json(listOf(F.xrefs, 'xrefs'))
        if (rest === 'graph') {
          const nodes = CFG.strip_unit_ids ? F.gNodes.map(({ unit_ids, ...n }) => n) : F.gNodes
          return json({
            document_id: docId, nodes, edges: F.gEdges,
            stats: { nodes: nodes.length, edges: F.gEdges.length, types: 12, verify_rate: 0.9501 },
          })
        }
        if (rest === 'file') return bytes(MINIMAL_PDF, 'application/pdf')
        if (rest === 'stream') return ranged(silentWav(60), 'audio/wav')
        if (docId === DOC_VIDEO) {
          if (rest === 'video') {
            if (degraded && CFG.no_video_artifact) {
              return json({ ...F.video, asr_model: '', segments: [], transcript: [], mindmap: { format: '', content: '' }, slides: [], summary: '' })
            }
            if (degraded) {
              // degraded 默认：没有转写产物（ASR 不可用），但有帧图（ffmpeg 可用是另一条独立能力）
              return json({ ...F.video, asr_model: '', segments: [], transcript: [], mindmap: { format: '', content: '' }, summary: '' })
            }
            return json(F.video)
          }
          if (rest === 'video/transcript') return json(listOf(degraded ? [] : F.video.transcript, 'items'))
          if (rest === 'video/mindmap') return json(degraded ? { format: '', content: '' } : F.video.mindmap)
          if (rest === 'video/slides') return json(listOf(F.video.slides, 'items'))
          if (/^video\/slides\/\d+\/image$/.test(rest)) return bytes(PNG_1PX, 'image/png')
          if (rest.startsWith('video/subtitle')) {
            const fmt = q.get('fmt') || 'vtt'
            const lines = fmt === 'vtt' ? ['WEBVTT', ''] : []
            for (const s of F.video.segments.slice(0, 200)) {
              const ts = (ms) => new Date(ms).toISOString().slice(11, 23)
              lines.push(fmt === 'vtt' ? `${ts(s.start)} --> ${ts(s.end)}` : `${lines.length + 1}\n${ts(s.start).replace('.', ',')} --> ${ts(s.end).replace('.', ',')}`)
              lines.push(s.text, '')
            }
            return bytes(Buffer.from(lines.join('\n'), 'utf8'), fmt === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8')
          }
        }
        if (rest === 'video/reparse' && req.method === 'POST') {
          if (degraded) return err(503, 'E_ASR_LOAD', 'faster-whisper 未安装（mock degraded）', '可改用云 ASR')
          req.resume()
          return json({ task_id: 'tsk_reparse0001', status: 'queued' })
        }
      }

      // ---------- §5.3 cards ----------
      m = api.match(/^\/cards\/([^/]+)(?:\/(.*))?$/)
      if (m) {
        const cid = m[1]
        const rest = m[2] || ''
        const card = F.cards.find((c) => c.id === cid)
        if (!card) return err(404, 'E_NOTFOUND', `card ${cid}`)
        const out = F.xrefs.filter((x) => x.from_card_id === cid).map((x) => ({ id: x.to_card_id, name: F.cards.find((c) => c.id === x.to_card_id)?.name || '', rel: x.rel }))
        const back = F.xrefs.filter((x) => x.to_card_id === cid).map((x) => ({ id: x.from_card_id, name: F.cards.find((c) => c.id === x.from_card_id)?.name || '', rel: x.rel }))
        if (rest === 'xrefs') return json(listOf(out, 'items'))
        if (rest === 'backlinks') return json(listOf(back, 'items'))
        const unit = F.units.get(card.unit_id)
        return json({
          card, unit: { id: card.unit_id, title: unit?.title || '' },
          source: { kind: 'pdf', file: `${DOC_PDF}/original.pdf`, page: card.evidence_span.start, url: `/api/v1/documents/${DOC_PDF}/file#page=${card.evidence_span.start}` },
          xrefs: out, backlinks: back,
        })
      }

      // ---------- §5.4 search ----------
      if (api === '/search') {
        const qq = String(q.get('q') || '').toLowerCase()
        const hits = []
        if (qq) {
          for (const c of F.cards) {
            const blob = `${c.name} ${c.one_line} ${c.purpose}`.toLowerCase()
            if (blob.includes(qq)) hits.push({ kind: 'card', ref_id: c.id, title: c.name, snippet: `…${c.one_line.slice(0, 60)}…`, score: 8.2, doc_id: DOC_PDF })
            if (hits.length >= 20) break
          }
          if (!hits.length) {
            for (const [id, u] of F.units) {
              if ((u.title || '').toLowerCase().includes(qq)) { hits.push({ kind: 'unit', ref_id: id, title: u.title, snippet: u.title, score: 2.0, doc_id: DOC_PDF }) }
              if (hits.length >= 20) break
            }
          }
        }
        return json({ q: q.get('q') || '', total: hits.length, hits })
      }
      if (api === '/search/suggest') {
        const qq = String(q.get('q') || '').toLowerCase()
        return json({ q: q.get('q') || '', suggestions: F.cards.filter((c) => c.name.toLowerCase().includes(qq)).slice(0, 10).map((c) => c.name) })
      }

      return err(404, 'E_NOTFOUND', `no route: ${api}`)
    } catch (e) {
      try { err(500, 'E_MOCK', `mock error: ${e.message}`) } catch { /* ignore */ }
    }
  })

  // ---------- §7.2 对话 WebSocket ----------
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (!u.pathname.startsWith('/api/v1/chat/')) { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const sessionId = u.pathname.split('/').pop()
      const send = (obj) => { try { ws.send(JSON.stringify(obj)) } catch { /* ignore */ } }
      // ★ 模式是**连接级**参数（backend-api 实测：pi 把 mode 编进会话 key，工具集建会话时确定）
      const rawMode = u.searchParams.get('mode')
      const connMode = rawMode === null || rawMode === '' ? 'chat' : rawMode
      if (!['chat', 'agent'].includes(connMode)) {
        // 未知 mode → 建连即拒（不静默降级），并 close(1008)
        send({ type: 'error', code: 'E_BADREQUEST', msg: `未知的对话模式："${connMode}"`,
          hint: "mode 只接受 'chat' | 'agent'；缺省 = 'chat'。模式是会话级的，请用 ?mode=… 重连" })
        try { ws.close(1008, 'bad mode') } catch { /* ignore */ }
        return
      }
      // ★ 助手入口（backend-api 接线）：决定**系统提示词**；非法值**建连即拒**（不静默降级）
      const rawAssistant = u.searchParams.get('assistant')
      const assistant = rawAssistant === null || rawAssistant === '' ? 'chat' : rawAssistant
      if (!['chat', 'video'].includes(assistant)) {
        send({ type: 'error', code: 'E_BADREQUEST', msg: `未知的助手入口："${assistant}"`,
          hint: "assistant 只接受 'chat' | 'video'；缺省 = 'chat'。请用 ?assistant=… 重连" })
        try { ws.close(1008, 'bad assistant') } catch { /* ignore */ }
        return
      }
      const isAgent = connMode === 'agent'
      /**
       * ★ 第 12 种帧 `history`（真实语义）：**同一 sessionId 重连**时，若盘上有转录 → 下发。
       *   mock 用内存 map 模拟；夹具 `?history=1` 则强制注入一段示例历史（供专门用例）。
       */
      const prior = SESSION_MSGS.get(sessionId) || []
      if (globalThis.__MOCK_CFG__?.history) {
        // 夹具优先（专门用例要断言"历史里的 markdown 表格也渲染"）
        send({ type: 'history', truncated: false, messages: [
          { role: 'user', text: '上一轮我问了什么？', ts: Date.now() - 120_000 },
          { role: 'assistant', text: '## 上次的结论\n\n| 项 | 值 |\n|---|---|\n| 聚簇索引 | **整行数据** |', ts: Date.now() - 119_000 },
        ] })
      } else if (prior.length) {
        send({ type: 'history', truncated: false, messages: prior })
      }
      // ★ pi-bridge 契约：`ready.reason` 决定"该不该清空消息"；`connect` → 不清
      send({ type: 'ready', session_id: sessionId, reason: 'connect', model: 'deepseek-v4.1-flash', mode: 'sdk', agent_mode: connMode,
        tools: isAgent ? ['kb_search', 'kb_get'] : [],
        tools_source: isAgent ? 'kb-readonly' : 'disabled-by-role',
        assistant, system_prompt: assistant === 'video' ? 'VIDEO_ASSISTANT_SYSTEM_PROMPT(+RENDER_CONTRACT)' : 'CHAT_ASSISTANT_SYSTEM_PROMPT(+RENDER_CONTRACT)' })
      let timer = null
      const clear = () => { if (timer) { clearTimeout(timer); timer = null } }
      ws.on('message', (raw) => {
        let msg = {}
        try { msg = JSON.parse(String(raw)) } catch { return }
        if (msg.type === 'prompt' || msg.type === 'steer') {
          clear()
          // 契约：`message`（不是 text）+ 可选 mode/retrieval/context
          const frameMode = msg.mode === undefined ? connMode : String(msg.mode)
          const retr = String(msg.retrieval || 'none')
          const ctx = (msg.context && typeof msg.context === 'object') ? msg.context : {}
          if (msg.type === 'prompt' && frameMode !== connMode) {
            // 帧里 mode 与连接不一致 → 报错且**不转发**（否则会按错模式跑）
            send({ type: 'error', code: 'E_BADREQUEST', msg: `帧里的 mode="${frameMode}" 与连接模式 "${connMode}" 不一致`,
              hint: `模式是会话级的：请用 ?mode=${frameMode} 重连` })
            send({ type: 'settled', aborted: false })
            return
          }
          const agentMode = isAgent
          // 第 11 种帧：服务端**实际用了**哪些上下文（resolved 是服务端解析出的真实标题）
          const dropped = []
          const resolved = {}
          if (ctx.doc_id) resolved.doc_title = 'MySQL 26.7 Reference Manual（上游真实产物 · mock）'
          else dropped.push({ field: 'doc_id', value: '', reason: '未提供' })
          if (ctx.unit_id) {
            const u = F.units.get(String(ctx.unit_id))
            if (u) resolved.unit_title = u.title
            else dropped.push({ field: 'unit_id', value: String(ctx.unit_id), reason: '未找到或无权访问' })
          }
          send({ type: 'context', used: ctx, resolved, dropped, note: '' })
          /**
           * ★ 助手回答（mock）：**故意包含公式 / 代码块 / 未闭合围栏 / 中文 \text{}** ——
           * 用来断言前端富文本渲染（KaTeX 成功与失败、代码块容错、转义安全）。
           */
          const text = CFG.rich_answer
            ? [
              // ★ 用户实测反馈的原样场景：标题 / 表格 / 粗体 / 列表 —— 以前全是 `##` 和 `|` 纯文本
              '## 一、聚簇索引 vs 二级索引（快速回顾）',
              '',
              '| 对比项 | 聚簇索引 | 二级索引 |',
              '|---|---|---|',
              '| 叶子节点存什么 | **整行数据** | **索引列值 + 主键值** |',
              '| 是否需要回表 | 不需要 | 查询非索引列时**要回表** |',
              '',
              '记一句话：**二级索引的叶子节点上挂着主键，主键再指向聚簇索引的行。**',
              '',
              '### 要点',
              '- 聚簇索引：`PRIMARY KEY` 默认就是它',
              '- 二级索引：叶子节点只存主键值',
              '  - 所以非覆盖查询要回表',
              '1. 先看执行计划 `EXPLAIN`',
              '2. 再看是否走覆盖索引',
              '',
              '> 注意：回表代价 = 随机 I/O，行数多时非常明显。',
              '',
              '参考 [MySQL 手册](https://dev.mysql.com/doc/) 与 [本节卡片](#/wiki?doc=doc_refman00001&unit=unt_0001)。',
              '',
              '---',
              '',
              '聚簇索引把整行数据放在 B+ 树的叶子节点上。',
              '',
              '行内公式：$O(\\log n)$；块级公式：',
              '$$T(n) = \\sum_{i=1}^{n} \\log i = \\Theta(n \\log n)$$',
              '中文混排：$\\text{聚簇索引} \\to \\text{回表}$',
              '坏公式（KaTeX 必失败）：$\\frac{1}{$',
              '',
              '```sql',
              'SELECT * FROM students WHERE id = 1;',
              '```',
              '',
              '未标语言的代码块（**不该被猜成某种语言**）：',
              '```',
              'SELECT 1;',
              '```',
              '',
              '含 HTML 的代码块（注入安全断言用）：',
              '```sql',
              'SELECT \'<script>alert(1)</script>\' AS x;',
              '```',
              '',
              '未闭合围栏（模型漏了结尾的 ```）：',
              '```python',
              'print("hello")',
            ].join('\n')
            : '聚簇索引把整行数据放在 B+ 树的叶子节点上，因此按主键范围扫描非常快；二级索引只存主键值，查询非索引列时要"回表"。'
          const chunks = msg.type === 'steer' ? ['（插话）', '好的，', '换个更短的例子。'] : text.match(/[\s\S]{1,6}/g)
          let i = 0
          // 真实 pi 会先流 thinking_delta（契约 §7.2 的第 9 种帧之一）→ mock 也要发，
          // 否则"思考过程可见"这条永远测不到
          send({ type: 'thinking_delta', delta: '先确认问题指向的机制：' })
          send({ type: 'thinking_delta', delta: '聚簇索引的叶子节点存整行。' })
          /**
           * ★ 检索模式帧（契约 §4）—— 字段与 pi-bridge 真机实测**逐字段一致**：
           *   {type,mode,status,available,hits,elapsedMs,why[],reason,sources[{kind,ref_id,title,score}]}
           * status ∈ none|ok|empty|unavailable|error（**判色以 status 为准**）
           */
          const rmode = String(retr !== 'none' ? retr : (CFG.retrieval || 'wiki'))
          const RFRAMES = {
            none: { status: 'none', available: true, hits: 0, elapsedMs: null,
              why: ['用户选择了不使用知识库检索（none）'], reason: '', sources: [] },
            wiki: { status: 'ok', available: true, hits: 2, elapsedMs: 1240,
              why: ['bigram 命中「聚簇索引」', 'DEPENDS_ON 1 跳：索引 → B+树'], reason: '',
              sources: [{ kind: 'unit', ref_id: 'unt_0001', title: '3.1 聚簇索引', score: 27.8 },
                { kind: 'card', ref_id: 'crd_0042', title: 'B+ 树与索引', score: 12.1 }] },
            kg: CFG.kg_hit
              ? { status: 'ok', available: true, hits: 1, elapsedMs: 6200, why: ['DEPENDS_ON 1 跳：索引 → B+树'],
                  reason: '', sources: [{ kind: 'entity', ref_id: 'ent_index', title: '索引', score: 1 }] }
              : { status: 'empty', available: true, hits: 0, elapsedMs: 6200,
                  why: ['图谱可用，但没有可遍历的边类型（edges 为空）'], reason: '', sources: [] },
            rag: { status: 'unavailable', available: false, hits: 0, elapsedMs: 0,
              why: ['rag 检索不可用：未配置 embedding provider（providers.embedding 为空）'],
              reason: '未配置 embedding provider（providers.embedding 为空）', sources: [] },
          }
          send({ type: 'retrieval', mode: rmode, ...(RFRAMES[rmode] || RFRAMES.wiki) })
          // ★ agent 模式：真的"去翻知识库"（kb_search → kb_get ×1），chat 模式不调工具
          if (agentMode && msg.type === 'prompt') {
            send({ type: 'tool_start', id: 'kb_1', tool: 'kb_search', args: { query: '聚簇索引', limit: 5 } })
            send({ type: 'tool_update', id: 'kb_1', partial: '命中 2 条：3.1 聚簇索引 / 3.2 覆盖索引' })
            send({ type: 'tool_end', id: 'kb_1', tool: 'kb_search', ok: true, duration_ms: 18,
              result_text: '命中 2 条：3.1 聚簇索引（unt_0001）/ 3.2 覆盖索引（unt_0002）' })
            send({ type: 'tool_start', id: 'kb_2', tool: 'kb_get', args: { ref_id: 'unt_0001' } })
            send({ type: 'tool_end', id: 'kb_2', tool: 'kb_get', ok: true, duration_ms: 9,
              result_text: '已读取单元 unt_0001《3.1 聚簇索引》原文（截断显示，正文不下发）' })
          }
          const step = () => {
            if (i < chunks.length) {
              send({ type: 'text_delta', delta: chunks[i++] })
              timer = setTimeout(step, 12)
              return
            }
            if (msg.type === 'prompt') {
              send({ type: 'tool_start', id: 'call_1', tool: 'read', args: { path: 'wiki_v2/5.3.md' } })
              timer = setTimeout(() => {
                send({ type: 'tool_update', id: 'call_1', partial: '5.3.1 创建并选择数据库…' })
                timer = setTimeout(() => {
                  send({ type: 'tool_end', id: 'call_1', ok: true, duration_ms: 37 })
                  send({ type: 'message_end', message: { role: 'assistant', text } })
            // ★ 落"转录"：同一会话重连时用 history 恢复（模拟 pi 的 JSONL）
            const arr = SESSION_MSGS.get(sessionId) || []
            arr.push({ role: 'user', text: String(msg.message || ''), ts: Date.now() - 1000 })
            arr.push({ role: 'assistant', text, ts: Date.now() })
            SESSION_MSGS.set(sessionId, arr)
                  send({ type: 'settled', aborted: false })
                }, 60)
              }, 80)
            } else {
              send({ type: 'settled', aborted: false })
            }
          }
          step()
        } else if (msg.type === 'abort') {
          clear()
          send({ type: 'settled', aborted: true, abort_source: 'client' })
        } else if (msg.type === 'new_session') {
          send({ type: 'ready', session_id: `${sessionId}-new`, model: 'deepseek-v4.1-flash', tools: ['read'] })
        } else if (msg.type === 'set_model') {
          send({ type: 'ready', session_id: sessionId, model: msg.model, tools: ['read'] })
        }
      })
    })
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      resolve({
        server, wss, degraded, cfg: CFG,
        port: actual,
        base: `http://127.0.0.1:${actual}`,
        close: () => new Promise((r) => { try { wss.close() } catch { /* ignore */ } server.close(() => r()) }),
      })
    })
  })
}

export const meta = () => buildFixture().meta

/* ---------------- 真后端代理（同源托管 dist + /api 转发） ----------------
 * 为什么需要它：真后端在 8787 只提供 `/api/v1/*`，**不托管前端 dist**；
 * 浏览器要同源访问（httpOnly cookie 才自然生效）→ 起一个"同源前端 + /api 反代"的小服务。
 * 用法：`node test/mock-server.mjs --proxy http://127.0.0.1:8799 --port-file <path>`
 * 行为：静态走 dist/；`/api/*` 原样转发（保留 Set-Cookie / chunked / SSE 流），不注入任何假数据。
 */
export function startProxyServer({ target, port = 0, dist = DIST } = {}) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (!u.pathname.startsWith('/api/')) {
      let rel = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\//, '')
      let file = path.join(dist, rel)
      if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html')
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('dist 不存在，先 npm run build') }
      const ext = path.extname(file)
      const ctype = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' }[ext] || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'no-store' })
      return res.end(fs.readFileSync(file))
    }
    // ---- /api/* 转发（含 SSE：不缓冲、直接 pipe） ----
    const t = new URL(target)
    const up = http.request({
      host: t.hostname, port: t.port, path: req.url, method: req.method, headers: { ...req.headers, host: `${t.hostname}:${t.port}` },
    }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers)
      ur.pipe(res)
    })
    up.on('error', (e) => { try { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'E_PROXY', msg: String(e.message) } })) } catch { /* ignore */ } })
    req.pipe(up)
  })
  /**
   * ★ WebSocket 升级也要转发 —— 否则 `/api/v1/chat/{session}` 永远连不上（`ws-state` 卡在 connecting）。
   * 我第一版只写了 HTTP 转发：真后端的对话 WS 走这里，实测"页面看着正常但一条帧都收不到"。
   * 做法：把原始 socket 直接接到后端的 TCP 端口上（升级握手是 HTTP，之后是双向字节流）。
   */
  server.on('upgrade', (req, socket, head) => {
    const t = new URL(target)
    const up = net.connect(Number(t.port) || 80, t.hostname, () => {
      // 把原始请求行/头原样发给后端（含 Cookie —— 鉴权就靠它）
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n`)
      for (let i = 0; i < req.rawHeaders.length; i += 2) up.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`)
      up.write('\r\n')
      if (head && head.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    const kill = () => { try { socket.destroy() } catch { /* ignore */ } try { up.destroy() } catch { /* ignore */ } }
    up.on('error', kill)
    socket.on('error', kill)
    socket.on('close', () => { try { up.destroy() } catch { /* ignore */ } })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      resolve({
        server, target, port: actual, base: `http://127.0.0.1:${actual}`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

/* ---------------- CLI：给 e2e 驱动用 ----------------
 * `node test/mock-server.mjs --port-file <path>` → 起 normal + degraded 两个实例，
 * 把端口与夹具 meta 写进文件，然后常驻（由驱动进程 terminate）。
 *
 * 为什么 e2e 驱动是 Python 而不是 Node：本机实测 **Node 作为父进程时 Chrome 起不来**
 * （Chrome 的 network service 进程创建命名管道被拒绝 → 连本地 HTTP 都请求不到；
 *  同一个 Chrome 由 Python `subprocess` 拉起则 0.8s 正常返回 DOM）。
 * mock server 仍是 Node（本文件），只是 Chrome 由 Python 拉起 —— 见 test/chrome_dom.py 头部说明。
 */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const idx = process.argv.indexOf('--port-file')
  const portFile = idx >= 0 ? process.argv[idx + 1] : null
  const proxyIdx = process.argv.indexOf('--proxy')
  if (proxyIdx >= 0) {
    // 真后端模式：只起"同源前端 + /api 反代"，**不注入任何假数据**
    const proxy = await startProxyServer({ target: process.argv[proxyIdx + 1] })
    const payload = { real: proxy.port, target: proxy.target, mode: 'proxy' }
    if (portFile) fs.writeFileSync(portFile, JSON.stringify(payload), 'utf8')
    else console.log(JSON.stringify(payload))
    const stopProxy = async () => { await proxy.close(); process.exit(0) }
    process.on('SIGTERM', stopProxy)
    process.on('SIGINT', stopProxy)
    setInterval(() => {}, 1 << 30)
  } else {
    const normal = await startMockServer()
    const degraded = await startMockServer({ degraded: true })
    const payload = { normal: normal.port, degraded: degraded.port, meta: meta(), docs: { pdf: DOC_PDF, video: DOC_VIDEO, unit: WIKI_UNIT } }
    if (portFile) fs.writeFileSync(portFile, JSON.stringify(payload), 'utf8')
    else console.log(JSON.stringify(payload))
    const stop = async () => { await normal.close(); await degraded.close(); process.exit(0) }
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
    setInterval(() => {}, 1 << 30)
  }
}







