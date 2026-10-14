/**
 * 文本与展示工具（纯函数，可被 Vitest 直接单测）
 *
 * 交叉引用的两条已验证规则（FUNCTIONAL_SPEC 坑 6/7）在这里落地：
 *   · 坑 6：mention 假阳性 —— 通用词（use/and/…）不内链；短名必须全大写出现
 *   · 坑 7：自引用 —— 去掉尾部 `()` 再比较（TIMESTAMPDIFF() vs TIMESTAMPDIFF）
 */
import type { Card, Span } from '../api/types'

export function esc(s: unknown): string {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

export function escRe(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 契约 §3：name_key = 小写 + 去空格（前端与后端同口径，避免两套匹配） */
export function nameKey(s: unknown): string {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ')
}

export function fmtMs(ms: number | null | undefined): string {
  const t = Math.max(0, Math.round(Number(ms) || 0))
  const s = Math.floor(t / 1000)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`
}

export function fmtSpan(span?: Span | null): string {
  if (!span) return ''
  switch (span.kind) {
    case 'page': return span.start === span.end ? `p${span.start}` : `p${span.start}–${span.end}`
    case 'slide': return span.start === span.end ? `幻灯片 ${span.start}` : `幻灯片 ${span.start}–${span.end}`
    case 'time': return `${fmtMs(span.start)}–${fmtMs(span.end)}`
    case 'char': return `字符 ${span.start}–${span.end}`
    default: return `${span.kind} ${span.start}–${span.end}`
  }
}

export function fmtBytes(n?: number): string {
  const v = Number(n || 0)
  if (!v) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let x = v
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++ }
  return `${x.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/* ---------------- 分类中文名（22 种 kind / usage_mode / operational_role / lifecycle） ---------------- */

export const KIND_ZH: Record<string, string> = {
  sql_statement: 'SQL 语句', sql_clause: 'SQL 子句', function: '函数', operator: '运算符',
  data_type: '数据类型', system_variable: '系统变量', status_variable: '状态变量',
  command_line_option: '命令行选项', client_program: '客户端程序', server_program: '服务端程序',
  utility_program: '工具程序', storage_engine: '存储引擎', plugin: '插件', component: '组件',
  log_sink: '日志接收器', log_filter: '日志过滤器', table: '表', schema_object: '模式对象',
  concept: '概念', mechanism: '机制', file: '文件', protocol: '协议', other: '其他',
}
export const USAGE_ZH: Record<string, string> = {
  user_invoked: '用户主动调用', server_automatic: '服务器自动', both: '两者皆可',
  internal: '内部使用', unknown: '未知',
}
export const ROLE_ZH: Record<string, string> = {
  feature: '功能', maintenance: '维护', performance: '性能', security: '安全', diagnostics: '诊断',
  replication: '复制', storage: '存储', configuration: '配置', unknown: '未知',
}
export const LIFECYCLE_ZH: Record<string, string> = {
  install_then_use: '先安装后使用', set_runtime: '运行时设置（重启失效）', set_persistent: '持久化设置',
  option_file: '配置文件', builtin: '内置', unknown: '未知',
}
export const SECTION_ROLE_ZH: Record<string, string> = {
  concept_intro: '概念介绍', how_to: '操作指南', reference: '参考手册', troubleshooting: '排错',
  best_practice: '最佳实践', internals: '内部原理', comparison: '对比', unknown: '未知',
}
export const REL_ZH: Record<string, string> = {
  typed: '类型化关系（图谱边）', mention: '正文提到', also_in: '还出现在', same_unit: '同单元知识点',
}

export const zh = (map: Record<string, string>, k?: string, fallback = ''): string =>
  (k && (map[k] || k)) || fallback || (k || '')

/* ---------------- 正文内链（F4） ---------------- */

/** 契约 §2.5 的 NOISE 集合：这些词在英文原文里是普通单词，链它会满屏噪音 */
export const LINK_NOISE = new Set([
  'use', 'and', 'or', 'not', 'in', 'is', 'as', 'on', 'to', 'by', 'if', 'for',
  'all', 'any', 'set', 'key', 'desc', 'path', 'date', 'char', 'time', 'text', 'blob', 'view',
  'index', 'table', 'value', 'name', 'type', 'user', 'host', 'port', 'file', 'test', 'data', 'event',
])

export interface NameIndexItem { key: string; raw: string; id: string }
export interface NameIndex { byKey: Map<string, string>; display: Map<string, string>; list: NameIndexItem[] }

export function buildNameIndex(cards: Card[]): NameIndex {
  const byKey = new Map<string, string>()
  const display = new Map<string, string>()
  const list: NameIndexItem[] = []
  for (const c of cards || []) {
    const k = nameKey(c.name)
    if (!k) continue
    if (!byKey.has(k)) byKey.set(k, c.id)
    display.set(k, c.name)
    list.push({ key: k, raw: c.name, id: c.id })
  }
  // 长名优先：否则 "CREATE TABLE" 会先被 "CREATE" 命中
  list.sort((a, b) => b.raw.length - a.raw.length)
  return { byKey, display, list }
}

/** 是否为「标识符样式」名字（含中文或符号）→ 允许直接内链 */
export function isIdentifier(raw: string): boolean {
  return /[\u4e00-\u9fff()[\].\-_@#$%]/.test(String(raw || ''))
}

/**
 * 正文 → 带内链的 HTML。返回字符串（调用方用 v-html 渲染，内容已转义）。
 * 只链接**其它**卡片；通用词与自引用一律跳过。
 */
export function linkify(text: unknown, opts: { index?: NameIndex; selfId?: string; selfName?: string } = {}): string {
  let s = esc(text)
  const index = opts.index
  if (!index || !index.list.length) return s
  const selfKey = opts.selfId ? nameKey(opts.selfName || '') : ''
  const selfBare = selfKey ? selfKey.replace(/\(\)$/, '') : null
  const done = new Set<string>()

  for (const it of index.list) {
    const k = it.key
    if (done.has(k)) continue
    if (opts.selfId && index.byKey.get(k) === opts.selfId) continue      // 自己
    if (selfBare && k.replace(/\(\)$/, '') === selfBare) continue        // 坑 7
    if (LINK_NOISE.has(k)) continue                                      // 坑 6
    const targetId = index.byKey.get(k)
    if (!targetId) continue
    const raw = it.raw
    const escRaw = esc(raw)
    const ident = isIdentifier(raw)
    if (s.indexOf(escRaw) < 0) {
      if (ident) continue
      const up = raw.toUpperCase()
      if (up === raw) continue
      const reUp = new RegExp(`(^|[^\\w>])${escRe(esc(up))}(?![\\w<])`, 'g')
      let hit = false
      s = s.replace(reUp, (_m, p1: string) => { hit = true; return p1 + anchor(targetId, up, raw) })
      if (hit) done.add(k)
      continue
    }
    if (!ident && (k.length < 6 || k.indexOf(' ') > 0)) {
      // 规则 3：短名/含空格必须**全大写**出现才链，否则是普通单词
      const up = raw.toUpperCase()
      const reUp = new RegExp(`(^|[^\\w>])${escRe(esc(up))}(?![\\w<])`, 'g')
      let hit = false
      s = s.replace(reUp, (_m, p1: string) => { hit = true; return p1 + anchor(targetId, up, raw) })
      if (hit) done.add(k)
      continue
    }
    const re = new RegExp(`(^|[^\\w>])${escRe(escRaw)}(?![\\w<])`, 'g')
    let hit = false
    s = s.replace(re, (_m, p1: string) => { hit = true; return p1 + anchor(targetId, raw, raw) })
    if (hit) done.add(k)
  }
  return s
}

function anchor(cardId: string, label: string, title: string): string {
  return `<a class="inner" href="#card-${esc(cardId)}" data-goto-card="${esc(cardId)}" `
    + `title="跳转到：${esc(title)}">${esc(label)}</a>`
}
