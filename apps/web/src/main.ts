import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
// 等宽字体打包进项目（离线可用、不走 CDN）—— 手册/元数据/页码/标识符都靠它承担"技术感"
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import './style.css'

/**
 * 主题：`?theme=dark|light`（测试/截图用）> localStorage > 跟随系统
 * 写进 `<html data-theme>`，CSS 变量与画布取色都读它。
 */
function resolveTheme(): 'light' | 'dark' {
  const q = new URLSearchParams(location.search)
  const h = location.hash || ''
  const i = h.indexOf('?')
  const hashQ = i >= 0 ? new URLSearchParams(h.slice(i + 1)) : null
  const want = (q.get('theme') || hashQ?.get('theme') || '').toLowerCase()
  if (want === 'dark' || want === 'light') {
    try { localStorage.setItem('coursekb-theme', want) } catch { /* ignore */ }
    return want
  }
  try {
    const saved = localStorage.getItem('coursekb-theme')
    if (saved === 'dark' || saved === 'light') return saved
  } catch { /* ignore */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
document.documentElement.dataset.theme = resolveTheme()

/**
 * 入口。`boot()` 时机由框架保证（FUNCTIONAL_SPEC 坑 9 在 Vue3 下自然消失）。
 *
 * 额外挂一个**错误收集器**：无头测试只能读 DOM，看不到 console；
 * 把运行时错误收集起来写进报告里，测试就能断言"有没有报错"（Vue 组件渲染抛错会保留旧 DOM，
 * 只看 DOM 会误判成"没渲染"）。
 */
const errors: Array<{ at: number; kind: string; msg: string }> = []
;(window as any).__APP_ERRORS__ = errors
window.addEventListener('error', (e) => errors.push({ at: Date.now(), kind: 'error', msg: String(e.message || e) }))
window.addEventListener('unhandledrejection', (e) => {
  const r: any = (e as PromiseRejectionEvent).reason
  errors.push({ at: Date.now(), kind: 'unhandledrejection', msg: String(r?.message || r) })
})
const app = createApp(App)
app.config.errorHandler = (err, _instance, info) => {
  errors.push({ at: Date.now(), kind: 'vue', msg: `${(err as Error)?.message || err} @ ${info}` })
}
app.use(router)

/**
 * ⚠️ 必须等 `router.isReady()` 再挂载。
 * 实测踩坑（headless 断言抓到的）：直接 mount 时初始 hash 路由还没解析完，组件里
 * `route.query` 是空的，App 的"自动选第一个文档"逻辑就用 `{query:{doc}}` 覆盖了地址 ——
 * 把 `unit` / `selftest` 等参数**全丢了**（页面于是只加载根节点、自检不跑）。
 */
router.isReady().then(() => app.mount('#app'))
