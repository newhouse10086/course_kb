<script setup lang="ts">
/**
 * App 外壳：顶栏导航 + 能力横幅 + 路由出口 + 文档选择器
 *
 * 能力驱动渲染（PROVIDERS §7）：横幅列出每个 kind 的可用性与**不可用原因**；
 * 导航入口按能力禁用（pi 不可用 → 助教入口禁用并说明），绝不允许点了才报错。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AssistantDock from './components/AssistantDock.vue'
import CapabilityBanner from './components/CapabilityBanner.vue'
import { useCaps } from './composables/useCaps'
import { useDocuments } from './composables/useCorpus'
import { testBarrier } from './utils/report'

const route = useRoute()
const router = useRouter()
const { caps, error: capsError, reload } = useCaps()
const docsApi = useDocuments()
const apiBase = ref('')
const capsReprobing = ref(false)

/**
 * 身份（RBAC §3）：只用来控制入口可见性；**权限判定永远在服务端**。
 * ⚠️ 真后端的形状是 `{user:{roles:[...]}, can:"..."}`（实测），不是 `{roles:[],permissions:[]}` ——
 *    两边都读，缺一个也不会把教师误判成学生。
 */
const me = ref<{ user?: { id: string; username: string; display_name?: string; roles?: string[] }; roles?: string[]; permissions?: string[]; can?: string } | null>(null)
const authRequired = ref<boolean | null>(null)
const roles = computed<string[]>(() => me.value?.user?.roles || me.value?.roles || [])
const perms = computed<string[]>(() => me.value?.permissions || [])
const isStaff = computed(() =>
  roles.value.includes('teacher') || roles.value.includes('admin')
  || perms.value.includes('settings:write') || perms.value.includes('settings:read'))
const roleLabel = computed(() => roles.value.join(', ') || '未上报')
const userLabel = computed(() => me.value?.user?.display_name || me.value?.user?.username || '')
const showLogin = computed(() => authRequired.value === true && !me.value?.user)
const capsPending = computed(() => !caps.value && !capsError.value)
/**
 * 能力数据"年龄"（真后端 15s TTL 缓存：`cached`/`cached_age_ms`/`cache_ttl_ms`）
 * ⚠️ 缓存不改变语义：15s 内就是**同一份真探测结果**（backend-api 明确）→ 如实标注年龄即可，别当"数据不可信"
 */
const capsAge = computed(() => {
  const raw = (caps.value?.raw || {}) as any
  if (raw.cached !== true) return ''
  const ms = Number(raw.cached_age_ms)
  return Number.isFinite(ms) ? `更新于 ${(ms / 1000).toFixed(0)} 秒前` : '来自缓存'
})
async function reprobeCaps() {
  capsReprobing.value = true
  try { await reload(true) } finally { capsReprobing.value = false }
}

const navItems = computed(() => [
  { to: '/wiki', label: '知识库', enabled: true, reason: '' },
  { to: '/graph', label: '知识图谱', enabled: true, reason: '' },
  { to: '/video', label: '视频课堂', enabled: true, reason: '' },
  { to: '/chat', label: 'AI 助教', enabled: !!caps.value?.isAvailable('pi'), reason: caps.value?.reasonFor('pi') || '' },
  { to: '/lab', label: 'SQL 练习台', enabled: true, reason: '' },
  { to: '/docs', label: '文档', enabled: true, reason: '' },
  // 设置页只对教师/管理员开放（学生进去也只会看到"需要教师角色"的说明）
  { to: '/settings', label: '模型设置', enabled: isStaff.value, reason: `需要教师/管理员角色（当前：${roleLabel.value}）` },
])

const activeDoc = computed(() => String(route.query.doc || ''))

/** 从 /capabilities 的 auth 段同步"要不要登录"（caps 后到也要能补上） */
function syncAuthRequired() {
  const req = (caps.value?.raw as any)?.auth?.required
  authRequired.value = typeof req === 'boolean' ? req : null
}

async function loadMe() {
  const m = await import('./api/client')
  try {
    me.value = await m.api.me()
    // 401 时 me() 抛错并触发跳登录；这里不吞
  } catch (e) {
    const err = e as { code?: string }
    me.value = null
    if (err?.code === 'E_UNAUTHENTICATED' && route.path !== '/login') {
      void router.replace({ path: '/login', query: { next: route.fullPath } })
    }
  }
}

async function boot() {
  testBarrier()          // 仅 ?barrier= 出现时生效（无头测试的同步屏障）
  try {
    const m = await import('./api/client')
    apiBase.value = m.API_BASE
    // 401 → 跳登录（真后端 auth.required=true；mock 下不会触发）
    m.setUnauthenticatedHandler((detail) => {
      // 401 本身就是"这台后端要登录"的**最快信号**：
      // 真后端 /capabilities 实测要 7–8.4s（每次调用都真探测）→ 不能等它来决定要不要显示登录入口
      authRequired.value = true
      if (route.path === '/login') return
      void router.replace({ path: '/login', query: { next: route.fullPath, hint: detail.slice(0, 120) } })
    })
  } catch { /* ignore */ }
  // 能力接口是白名单（未登录也能读）→ 用它判断"这台后端要不要登录"
  syncAuthRequired()
  await loadMe()
  await docsApi.load()
  if (!activeDoc.value && docsApi.docs.value.length) {
    const first = docsApi.docs.value.find((d) => d.kind !== 'video' && d.status === 'ready') || docsApi.docs.value[0]
    void router.replace({ query: { ...route.query, doc: first.id } })
  }
}
onMounted(boot)
watch(() => docsApi.docs.value.length, () => { void boot })
/**
 * ⚠️ caps 是异步拉的：`boot()` 里读一次 `caps.value` 时它常常还是 null →
 *    `authRequired` 永远是 null → **登录入口/退出按钮都不显示**（对着真后端实测踩到）。
 *    必须跟着 caps 变化同步。
 */
watch(caps, syncAuthRequired, { immediate: true })
watch(() => route.fullPath, () => { void loadMe() })

async function doLogout() {
  try { const m = await import('./api/client'); await m.api.logout() } catch { /* 退出失败也要清本地状态 */ }
  me.value = null
  void router.replace({ path: '/login', query: { next: route.fullPath } })
}

function onDocChange(id: string) {
  void router.replace({ query: { ...route.query, doc: id } })
}

/** 主题切换：写 `<html data-theme>` + localStorage（画布取色也会跟着重画） */
const theme = ref<'light' | 'dark'>((document.documentElement.dataset.theme as 'light' | 'dark') || 'light')
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme.value
  try { localStorage.setItem('coursekb-theme', theme.value) } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('coursekb-theme-change', { detail: theme.value }))
}
</script>

<template>
  <header class="topbar">
    <div>
      <div class="brand">课程知识平台</div>
      <div class="brand-sub">
        <span data-testid="api-base">{{ apiBase }}</span>
        <span v-if="docsApi.docs.value.length"> · {{ docsApi.docs.value.length }} 个文档</span>
      </div>
    </div>

    <nav class="nav-links">
      <template v-for="n in navItems" :key="n.to">
        <RouterLink
          v-if="n.enabled"
          class="nav-link"
          :class="{ active: route.path === n.to }"
          :to="{ path: n.to, query: route.query }"
          :data-nav="n.to"
        >{{ n.label }}</RouterLink>
        <span
          v-else
          class="nav-link disabled"
          :data-nav="n.to"
          aria-disabled="true"
          :data-gate-reason="n.reason"
          :title="`${n.label}不可用：${n.reason}`"
        >{{ n.label }}（不可用）</span>
      </template>
    </nav>

    <select
      v-if="docsApi.docs.value.length"
      :value="activeDoc"
      data-testid="doc-select"
      title="选择文档"
      @change="onDocChange(($event.target as HTMLSelectElement).value)"
    >
      <option v-for="d in docsApi.docs.value" :key="d.id" :value="d.id">{{ d.title }}（{{ d.kind }}）</option>
    </select>

    <span class="right" />

    <!-- 身份：后端要求登录时显示；未登录给"登录"入口（登录态由浏览器自动携带，前端不保存凭据） -->
    <span v-if="authRequired === true" class="authbox" data-testid="auth-box" :data-required="authRequired">
      <template v-if="me?.user">
        <span class="meta">{{ userLabel }}</span>
        <span class="pill">{{ roleLabel }}</span>
        <button type="button" data-testid="do-logout" @click="doLogout">退出</button>
      </template>
      <RouterLink v-else class="nav-link" data-testid="do-login" :to="{ path: '/login', query: { next: route.fullPath } }">登录</RouterLink>
    </span>

    <button
      class="theme-toggle"
      type="button"
      data-testid="theme-toggle"
      :title="theme === 'dark' ? '切到亮色（手册纸）' : '切到暗色（深墨）'"
      @click="toggleTheme"
    >{{ theme === 'dark' ? '☾ 暗' : '☀ 亮' }}</button>
    <!-- 能力接口慢时如实显示"加载中"（真后端实测 7–8.4s：每次调用都做真探测） -->
    <span v-if="capsPending" class="meta faint" data-testid="caps-loading">能力接口加载中…（真探测较慢）</span>
    <span v-else-if="capsAge" class="meta faint" data-testid="caps-age">{{ capsAge }}</span>
    <button v-if="caps" type="button" class="small" data-testid="caps-reprobe" :disabled="capsReprobing"
            @click="reprobeCaps()">{{ capsReprobing ? '探测中…' : '重新探测' }}</button>
    <CapabilityBanner :caps="caps" compact />
    <span v-if="capsError" class="gate-note" data-testid="caps-error" :title="capsError">
      能力接口读取失败：{{ capsError }} <button type="button" @click="reload()">重试</button>
    </span>
  </header>

  <!-- 未登录提示条（不阻塞页面：能力横幅与 /health 是白名单，用户能先看清这是什么平台）
       ⚠️ 文案面向学生/教师：**不写 httpOnly/cookie/token/401 这些给开发者看的词**（用户实测反馈） -->
  <div v-if="showLogin" class="gate-note loginbar" data-testid="login-bar">
    未登录：请先
    <RouterLink :to="{ path: '/login', query: { next: route.fullPath } }">登录</RouterLink>
    后继续使用。
  </div>

  <!--
  ⚠️ key 用 `route.path` 而不是 `route.fullPath`：
  App 首次进入会给地址补 `?doc=…`，若 key 含 query 就会**立刻重挂载视图** ——
  结果第一个实例会在第二个实例还没渲染时先写出 `#*-report`，
  无头驱动一见 report 就取 DOM，于是读到"空表格"（实测踩到，且是偶发）。
  只按 path 做 key：换文档不再重挂载，视图内部各自 watch `route.query.doc` 重新加载。
-->
  <RouterView :key="route.path" />

  <!-- ★ 全局 chat 小助手（用户需求："每个页面都要加一个 chat 小助手"）：
       浮动入口 + 抽屉，带当前页上下文；与 /chat 整页共用同一个组件 -->
  <AssistantDock />
</template>






