/**
 * 能力 composable：全局只拉一次 `/capabilities`（契约 §5.1 / PROVIDERS §7）
 * 失败不阻塞页面，但会把错误暴露给 UI 显示（而不是假装能力都在）。
 */
import { ref } from 'vue'
import { api } from '../api/client'
import { normalizeCapabilities, type CapsModel } from '../api/capabilities'

const caps = ref<CapsModel | null>(null)
const error = ref<string>('')
const loading = ref(false)
let promise: Promise<CapsModel | null> | null = null

async function load(force = false): Promise<CapsModel | null> {
  if (promise && !force) return promise
  loading.value = true
  error.value = ''
  promise = (async () => {
    try {
      // `refresh=1` = 强制重探（真后端 15s TTL 缓存；点"重新探测"时必须绕过缓存）
      const raw = await api.capabilities(force)
      caps.value = normalizeCapabilities(raw)
      return caps.value
    } catch (e) {
      error.value = (e as Error).message
      caps.value = null
      return null
    } finally {
      loading.value = false
    }
  })()
  return promise
}

export function useCaps() {
  if (!caps.value && !promise) void load()
  return { caps, error, loading, reload: () => load(true) }
}
