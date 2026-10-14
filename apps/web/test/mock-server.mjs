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
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

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
  }
}

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
  const CFG = { strip_unit_ids: false, no_video_artifact: false, uploads: [] }
  let release = null
  const holdWaiters = []

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const p = u.pathname
    const q = u.searchParams
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
      if (api === '/_fixture/config') {
        for (const k of Object.keys(CFG)) if (q.has(k) && typeof CFG[k] === 'boolean') CFG[k] = ['1', 'true', 'yes'].includes(q.get(k))
        return json({ config: { ...CFG, uploads: CFG.uploads.length } })
      }
      if (api === '/_fixture/meta') return json({ degraded, meta: F.meta, config: CFG })

      // ---------- §5.1 ----------
      if (api === '/health') return json({ ok: true, version: '2.0.0-mock' })
      if (api === '/capabilities') return json(capabilitiesPayload(degraded))

      // ---------- §5.2 documents ----------
      if (api === '/documents' && req.method === 'GET') {
        let docs = [
          { id: DOC_PDF, title: 'MySQL 26.7 Reference Manual（上游真实产物 · mock）', kind: 'pdf', page_count: 6392, size_bytes: 44160000, lang: 'en', status: 'ready', created_at: 1760400000000, updated_at: 1760400000000, meta: { toc_entries: 2545, chapters: 42 } },
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
      let m = api.match(/^\/tasks\/([^/]+)(?:\/(.*))?$/)
      if (m) {
        const taskId = m[1]
        const rest = m[2] || ''
        if (rest === '') {
          return json({ id: taskId, doc_id: DOC_VIDEO, kind: 'asr', status: 'running', progress: 0.42, stage: '转写音频', detail: {}, error: null })
        }
        if (rest === 'events') {
          // ★ 必须 chunked：HTTP/1.1 无长度裸流会让 Chrome 的 EventSource 立刻 CLOSED（v1 实测）
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Transfer-Encoding': 'chunked',
          })
          const frames = [
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
      send({ type: 'ready', session_id: sessionId, model: 'deepseek-v4.1-flash', tools: ['read', 'bash'] })
      let timer = null
      const clear = () => { if (timer) { clearTimeout(timer); timer = null } }
      ws.on('message', (raw) => {
        let msg = {}
        try { msg = JSON.parse(String(raw)) } catch { return }
        if (msg.type === 'prompt' || msg.type === 'steer') {
          clear()
          const text = '聚簇索引把整行数据放在 B+ 树的叶子节点上，因此按主键范围扫描非常快；二级索引只存主键值，查询非索引列时要"回表"。'
          const chunks = msg.type === 'steer' ? ['（插话）', '好的，', '换个更短的例子。'] : text.match(/[\s\S]{1,6}/g)
          let i = 0
          // 真实 pi 会先流 thinking_delta（契约 §7.2 的第 9 种帧之一）→ mock 也要发，
          // 否则"思考过程可见"这条永远测不到
          send({ type: 'thinking_delta', delta: '先确认问题指向的机制：' })
          send({ type: 'thinking_delta', delta: '聚簇索引的叶子节点存整行。' })
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
