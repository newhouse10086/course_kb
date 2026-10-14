/**
 * 无头验证的**结果落盘**（headless Chrome 只能读 DOM，读不到 canvas 与内存状态）
 *
 * 用法：视图在 `?selftest=1` 时把"我干了什么、结果是什么"写进
 * `<script type="application/json" id="xxx-report">`，测试脚本断言里面的**具体值**。
 * 这不是给用户看的功能，但它是"不是看着像对"的唯一可核查手段。
 */

export interface SelftestReport {
  ok: boolean
  checks: Record<string, unknown>
  failed: string[]
}

export function writeReport(id: string, obj: unknown): void {
  if (typeof document === 'undefined') return
  let el = document.getElementById(id) as HTMLScriptElement | null
  if (!el) {
    el = document.createElement('script')
    el.type = 'application/json'
    el.id = id
    el.className = 'report-json'
    document.body.appendChild(el)
  }
  el.textContent = JSON.stringify(obj)
}

export function readReport<T = unknown>(id: string): T | null {
  if (typeof document === 'undefined') return null
  const el = document.getElementById(id)
  if (!el || !el.textContent?.trim()) return null
  try { return JSON.parse(el.textContent) as T } catch { return null }
}

/** 测试用的同步屏障：把 load 事件推迟到页面干完活（真实时间下量性能才可信） */
let barrierUrl: string | null = null

export function testBarrier(): string | null {
  const b = urlParams().get('barrier')
  if (!b || typeof document === 'undefined') return null
  barrierUrl = b
  const img = document.createElement('img')
  img.id = 'test-barrier'
  img.alt = ''
  img.style.display = 'none'
  img.src = `${b}${b.includes('?') ? '&' : '?'}t=${Date.now()}`
  document.body.appendChild(img)
  return b
}

export async function testBarrierDone(): Promise<void> {
  if (!barrierUrl) return
  const url = barrierUrl.replace(/\/hold\b/, '/release')
  barrierUrl = null
  try { await fetch(url, { cache: 'no-store' }) } catch { /* 夹具不可用时忽略 */ }
}

export function queryFlag(name: string): boolean {
  return urlParams().get(name) === '1'
}

export function queryValue(name: string): string | null {
  return urlParams().get(name)
}

/**
 * 统一取参数：**同时看 `location.search` 与 hash 里的 query**。
 * 为什么：路由用 hash 模式（静态托管免 rewrite），深链参数都在 `#/wiki?doc=..&unit=..` 里；
 * 测试/联调参数（`selftest` / `t` / `barrier` / `api`）也会一并带在同一个 hash 上 ——
 * 两处都取，避免"参数写对了却不生效"（v1 曾因只读 search 而踩过）。
 */
export function urlParams(): URLSearchParams {
  if (typeof location === 'undefined') return new URLSearchParams()
  const p = new URLSearchParams(location.search)
  const h = location.hash || ''
  const i = h.indexOf('?')
  if (i >= 0) {
    const hp = new URLSearchParams(h.slice(i + 1))
    for (const [k, v] of hp) if (!p.has(k)) p.set(k, v)
  }
  return p
}
