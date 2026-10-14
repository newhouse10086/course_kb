/**
 * 配色表 —— 封闭枚举见 contracts/schema/edge_types.json（**不许发明**）
 * 12 种 etype / 12 种实体类型 / 4 个层（L0–L3）
 *
 * 设计系统（docs/DESIGN_SYSTEM.md §5）：画布也要"纸感 + 单一强调色"——
 * 所有颜色**降饱和**，边的区分靠**明度 + 线型**，不再用 12 种高饱和彩虹色；
 * 朱红家族只留给"可跳转/当前选中"。
 */
export interface Palette {
  bg: string
  ink: string
  edge: Record<string, string>
  type: Record<string, string>
  layer: Record<string, string>
  flag: string
  label: string
  labelBg: string
  select: string
  nodeStroke: string
}

/** 12 种 etype（亮色）：同一墨色系的 12 个明度/色相微差 */
const EDGE_LIGHT: Record<string, string> = {
  DEPENDS_ON: '#8a8170',
  PART_OF: '#a89e88',
  REALIZES: '#7a6f8a',
  IMPLEMENTS: '#5f7a6a',
  CONTRASTS_WITH: '#a8763a',
  INSTANCE_OF: '#a8543f',
  SCHEMA_PATTERN: '#4f6b8a',
  USED_IN_ROLE: '#4f7d7a',
  GOVERNED_BY: '#8a6a2a',
  HISTORICAL_ORIGIN: '#7a5f86',
  COMMON_MISCONCEPTION: '#a8443c',
  ASSESSED_BY: '#6f6a60',
}

const EDGE_DARK: Record<string, string> = {
  DEPENDS_ON: '#9a9384',
  PART_OF: '#7d766a',
  REALIZES: '#9b8fb0',
  IMPLEMENTS: '#7fa892',
  CONTRASTS_WITH: '#c99a5e',
  INSTANCE_OF: '#c4766a',
  SCHEMA_PATTERN: '#7d9ac0',
  USED_IN_ROLE: '#79b0ac',
  GOVERNED_BY: '#c0a066',
  HISTORICAL_ORIGIN: '#a98cb5',
  COMMON_MISCONCEPTION: '#d0776d',
  ASSESSED_BY: '#9a948a',
}

/** 实体类型（亮色）：低饱和，与卡片/图例一致 */
const TYPE_LIGHT: Record<string, string> = {
  concept: '#4f6b8a', mechanism: '#4f7d7a', product: '#5f7a6a', feature: '#6b7d52',
  business: '#9a6a1f', table: '#8a6a2a', role: '#7a5f86', regulation: '#8a6a8a',
  problem: '#a8443c', misconception: '#a8543f', assessment: '#6f6a60', station: '#8a8170',
  self: '#b8332a',
}
const TYPE_DARK: Record<string, string> = {
  concept: '#7d9ac0', mechanism: '#79b0ac', product: '#7fa892', feature: '#93a878',
  business: '#c99a5e', table: '#c0a066', role: '#a98cb5', regulation: '#b98fb8',
  problem: '#d0776d', misconception: '#c4766a', assessment: '#9a948a', station: '#9a9384',
  self: '#e0564a',
}

export function palette(theme: 'light' | 'dark'): Palette {
  const dark = theme === 'dark'
  return {
    bg: dark ? '#16181d' : '#f2eee3',
    ink: dark ? '#cfc9bd' : '#3a352c',
    edge: dark ? EDGE_DARK : EDGE_LIGHT,
    type: dark ? TYPE_DARK : TYPE_LIGHT,
    layer: dark
      ? { L0: '#a98cb5', L1: '#7d9ac0', L2: '#7fa892', L3: '#c99a5e', '': '#9a9384' }
      : { L0: '#7a5f86', L1: '#4f6b8a', L2: '#5f7a6a', L3: '#9a6a1f', '': '#8a8170' },
    flag: dark ? '#e0564a' : '#b8332a',
    label: dark ? '#d8d3c8' : '#2a2620',
    labelBg: dark ? 'rgba(20,22,26,.78)' : 'rgba(247,244,236,.82)',
    select: dark ? '#f0a89e' : '#b8332a',
    nodeStroke: dark ? '#14161a' : '#fbf9f4',
  }
}

/** 兼容旧调用（导出常量仍可用；实际渲染走 `palette(theme)`） */
export const ETYPE_COLORS = EDGE_LIGHT
export const TYPE_COLORS = TYPE_LIGHT
export const LAYER_COLORS: Record<string, string> = {
  L0: '#7a5f86', L1: '#4f6b8a', L2: '#5f7a6a', L3: '#9a6a1f', '': '#8a8170',
}

export const ETYPE_ZH: Record<string, string> = {
  DEPENDS_ON: '前置依赖', PART_OF: '组成归属', REALIZES: '实现原理', IMPLEMENTS: '具体实现',
  CONTRASTS_WITH: '对比辨析', INSTANCE_OF: '业务实例', SCHEMA_PATTERN: '表设计模式',
  USED_IN_ROLE: '岗位用途', GOVERNED_BY: '合规约束', HISTORICAL_ORIGIN: '历史来由',
  COMMON_MISCONCEPTION: '常见误解', ASSESSED_BY: '考核方式',
}
export const TYPE_ZH: Record<string, string> = {
  concept: '概念', mechanism: '机制', product: '产品', feature: '产品特性', business: '业务场景',
  table: '表设计', role: '岗位', regulation: '法规', problem: '问题', misconception: '常见误解',
  assessment: '考核', station: '生命周期站点', self: '本卡片',
}
export const LAYER_ZH: Record<string, string> = {
  L0: 'L0 思想层', L1: 'L1 机制层', L2: 'L2 实现层', L3: 'L3 领域层', '': '未分层',
}

/** 颜色查找必须有兜底：缺键会把 undefined 打进画布，整块渲染失效（v1 踩过） */
export function colorOf(map: Record<string, string>, key: string | undefined, fallback = '#8a8170'): string {
  return (key && map[key]) || fallback
}
export const etypeColor = (e?: string) => colorOf(EDGE_LIGHT, e)
export const typeColor = (t?: string) => colorOf(TYPE_LIGHT, t)
export const layerColor = (l?: string) => colorOf(LAYER_COLORS, l)
export const etypeZh = (e?: string) => (e ? ETYPE_ZH[e] || e : '')
export const typeZh = (t?: string) => (t ? TYPE_ZH[t] || t : '')
export const layerZh = (l?: string) => (l != null ? LAYER_ZH[l] || l : '')

export function inferLayer(type?: string): string {
  switch (type) {
    case 'product': case 'feature': case 'table': return 'L2'
    case 'business': case 'role': return 'L3'
    case 'concept': case 'mechanism': case 'problem': case 'misconception': case 'station': return 'L1'
    case 'regulation': return 'L0'
    default: return ''
  }
}

/** 当前主题（`<html data-theme>`；测试/截图可用 `?theme=` 覆盖） */
export function currentTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export interface LegendItem { kind: 'dot' | 'line'; color: string; label: string; dashed?: boolean }
