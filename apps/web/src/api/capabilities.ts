/**
 * 能力模型 —— 权威：docs/PROVIDERS.md §7 + docs/ARCHITECTURE_V2.md §4.5
 *
 * 三条铁律（文档 §0）在**前端**的落点：
 *   R1 `configured` 与 `available` **分开看**：有凭据 ≠ 能用 → UI 只认 `available`
 *   R2 降级链每一跳都要真探测的结果 → 我们按链**顺序**取第一个 available 的 provider
 *   R3 全链失败 → **禁用入口 + 把 reason 原文显示给用户**（不允许点了才报错）
 *
 * 兼容两种上报形状：
 *   v2（providers 段）：{ providers: { asr: [ProviderInfo...], tts: [...], ... }, policy: {...} }
 *   v1（扁平段）：      { asr: {available,engine,reason}, llm: {configured,model}, pi: {...}, ffmpeg: {...} }
 * 后端实现与契约不一致时，**不迁就**也**不崩**：缺什么就报"未上报"，仍禁用入口。
 */

export type CapKind = 'llm' | 'asr' | 'tts' | 'translate' | 'ocr' | 'embedding' | 'pi' | 'ffmpeg'

export const CAP_LABEL: Record<CapKind, string> = {
  llm: 'LLM（抽取 / 问答）',
  asr: 'ASR 语音转文字',
  tts: 'TTS 语音合成',
  translate: '翻译',
  ocr: 'OCR 文字识别',
  embedding: '向量嵌入',
  pi: 'pi 助教',
  ffmpeg: 'ffmpeg',
}

/** provider 一条链上的一个候选（PROVIDERS.md §1 ProviderInfo 的前端子集） */
export interface CapEntry {
  id: string
  kind: CapKind
  label: string
  vendor?: string
  runtime?: 'local' | 'cloud'
  configured: boolean
  available: boolean
  reason?: string
  capabilities?: Record<string, unknown>
  pricing?: { unit?: string; amount?: number; currency?: string; note?: string }
  limits?: Record<string, unknown>
}

export interface CapsModel {
  /** kind → 降级链（顺序即优先级） */
  chain: Record<string, CapEntry[]>
  policy: Record<string, string>
  adapters: string[]
  raw: unknown
  /** 链上是否有可用的（R2：available 才是真可用） */
  isAvailable: (kind: CapKind | string) => boolean
  /** 链上第一个可用的 provider（真正会被用的那个） */
  primary: (kind: CapKind | string) => CapEntry | undefined
  /** 不可用时给用户看的**可读原因**（优先用后端 reason 原文） */
  reasonFor: (kind: CapKind | string) => string
  /** 某个具体 provider */
  find: (kind: CapKind | string, id: string) => CapEntry | undefined
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function toEntry(kind: CapKind, raw: any, index: number): CapEntry {
  const id = String(raw?.id || raw?.provider_id || `${kind}-${index}`)
  const available = asBool(raw?.available) ?? asBool(raw?.ok) ?? (asBool(raw?.configured) === true && raw?.reason ? false : asBool(raw?.configured) === true)
  return {
    id,
    kind,
    label: String(raw?.label || raw?.engine || raw?.model || id),
    vendor: raw?.vendor ? String(raw.vendor) : undefined,
    runtime: raw?.runtime === 'local' || raw?.runtime === 'cloud' ? raw.runtime : undefined,
    configured: asBool(raw?.configured) ?? false,
    available: available === true,
    reason: raw?.reason ? String(raw.reason) : undefined,
    capabilities: raw?.capabilities || undefined,
    pricing: raw?.pricing || undefined,
    limits: raw?.limits || undefined,
  }
}

/** v1 扁平段 → provider 条目（保持"诚实"：没有 available 就是不可用） */
const FLAT_SPECS: Array<{ key: string; kind: CapKind; label: (r: any) => string }> = [
  { key: 'asr', kind: 'asr', label: (r) => `ASR ${r?.engine || ''}`.trim() },
  { key: 'tts', kind: 'tts', label: (r) => `TTS ${r?.engine || ''}`.trim() },
  { key: 'translate', kind: 'translate', label: (r) => `${r?.engine || 'translation'}` },
  { key: 'ocr', kind: 'ocr', label: (r) => `${r?.engine || 'ocr'}` },
  { key: 'embedding', kind: 'embedding', label: (r) => `${r?.engine || 'embedding'}` },
  { key: 'llm', kind: 'llm', label: (r) => `${r?.model || 'LLM'}` },
  { key: 'pi', kind: 'pi', label: (r) => `pi ${r?.version || ''}`.trim() },
  { key: 'ffmpeg', kind: 'ffmpeg', label: (r) => `ffmpeg ${r?.version || ''}`.trim() },
]

const V2_KINDS: CapKind[] = ['llm', 'asr', 'tts', 'translate', 'ocr', 'embedding', 'pi', 'ffmpeg']

export function normalizeCapabilities(raw: unknown): CapsModel {
  const r: any = raw || {}
  const chain: Record<string, CapEntry[]> = {}

  // ① v2：providers 逐 kind 上报
  const providers = r.providers
  if (providers && typeof providers === 'object') {
    for (const [kind, list] of Object.entries<any>(providers)) {
      if (Array.isArray(list)) chain[kind] = list.map((p, i) => toEntry(kind as CapKind, p, i))
    }
  }

  // ② v1 兜底：扁平段（只补 v2 没给的 kind）
  for (const spec of FLAT_SPECS) {
    const seg = r[spec.key]
    if (!seg || typeof seg !== 'object') continue
    if (chain[spec.kind]?.length) continue
    // 有些实现会把顶层写成数组（等价于 providers 的一条链）→ 按链处理，别把 reason 丢了
    if (Array.isArray(seg)) {
      chain[spec.kind] = seg.map((p, i) => toEntry(spec.kind, p, i))
      continue
    }
    const configured = asBool(seg.configured) ?? (spec.key === 'ffmpeg' || spec.key === 'pi' || spec.key === 'asr')
    chain[spec.kind] = [{
      id: `legacy-${spec.key}`,
      kind: spec.kind,
      label: spec.label(seg) || spec.kind,
      vendor: seg.vendor ? String(seg.vendor) : undefined,
      runtime: seg.runtime,
      configured,
      available: asBool(seg.available) === true,
      reason: seg.reason ? String(seg.reason) : (asBool(seg.available) === true ? undefined : '后端未说明不可用原因（请检查 /capabilities）'),
      capabilities: seg.capabilities || (seg.models ? { models: seg.models } : undefined),
      pricing: seg.pricing,
    }]
  }

  // ③ policy：v2 直接给；否则按链推断（local 在前的为 local-first）
  const policy: Record<string, string> = {}
  if (r.policy && typeof r.policy === 'object') {
    for (const [k, v] of Object.entries<any>(r.policy)) policy[k] = String(v)
  }
  for (const kind of Object.keys(chain)) {
    if (policy[kind]) continue
    const first = chain[kind]?.[0]
    policy[kind] = first?.runtime === 'cloud' ? 'cloud-first' : 'local-first'
  }

  // ④ 未上报的 kind 也要有一条"未上报"，UI 才不至于默认"能用"
  for (const kind of V2_KINDS) {
    if (!chain[kind]) {
      chain[kind] = [{
        id: `unreported-${kind}`, kind: kind as CapKind, label: kind, configured: false, available: false,
        reason: `/capabilities 未上报 ${kind} 能力（契约 §5.1 / PROVIDERS §7）`,
      }]
    }
  }

  const model: CapsModel = {
    chain,
    policy,
    adapters: Array.isArray(r.adapters) ? r.adapters.map(String) : [],
    raw,
    isAvailable: (kind) => (chain[kind] || []).some((e) => e.available),
    primary: (kind) => (chain[kind] || []).find((e) => e.available),
    reasonFor: (kind) => {
      const list = chain[kind] || []
      if (list.some((e) => e.available)) return ''
      if (!list.length) return '后端未上报该能力'
      // 展示链上**第一个**候选的原因（通常就是首选 provider），没有就说明整条链
      const first = list[0]
      return first.reason
        || list.map((e) => `${e.id}: 不可用`).join('；')
    },
    find: (kind, id) => (chain[kind] || []).find((e) => e.id === id),
  }
  return model
}

/** 能力横幅用的行（不可用的必须能一眼看到原因） */
export interface CapsBannerRow {
  kind: CapKind | string
  label: string
  available: boolean
  configured: boolean
  used?: string
  reason: string
}

export function bannerRows(m: CapsModel): CapsBannerRow[] {
  const kinds: CapKind[] = ['llm', 'asr', 'tts', 'translate', 'ocr', 'pi', 'ffmpeg']
  return kinds.map((kind) => {
    const primary = m.primary(kind)
    return {
      kind,
      label: CAP_LABEL[kind] || kind,
      available: !!primary,
      configured: (m.chain[kind] || []).some((e) => e.configured),
      used: primary ? `${primary.label}${primary.runtime ? `（${primary.runtime === 'local' ? '本地' : '云端'}）` : ''}` : undefined,
      reason: m.reasonFor(kind),
    }
  })
}

/** 门控文案：禁用时显示的东西（**不要**"点了才报错） */
export function gateText(m: CapsModel, kind: CapKind | string, action: string): string {
  const reason = m.reasonFor(kind)
  return `${action}不可用：${reason}`
}
