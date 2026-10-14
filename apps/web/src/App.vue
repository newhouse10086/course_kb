<script setup lang="ts">
/**
 * App 外壳：顶栏导航 + 能力横幅 + 路由出口 + 文档选择器
 *
 * 能力驱动渲染（PROVIDERS §7）：横幅列出每个 kind 的可用性与**不可用原因**；
 * 导航入口按能力禁用（pi 不可用 → 助教入口禁用并说明），绝不允许点了才报错。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CapabilityBanner from './components/CapabilityBanner.vue'
import { useCaps } from './composables/useCaps'
import { useDocuments } from './composables/useCorpus'
import { testBarrier } from './utils/report'

const route = useRoute()
const router = useRouter()
const { caps, error: capsError, reload } = useCaps()
const docsApi = useDocuments()
const apiBase = ref('')

/** 角色（RBAC §3）：只用来控制入口可见性；**权限判定永远在服务端** */
const roles = ref<string[]>([])
const perms = ref<string[]>([])
const isStaff = computed(() =>
  roles.value.includes('teacher') || roles.value.includes('admin')
  || perms.value.includes('settings:write') || perms.value.includes('settings:read'))
const roleLabel = computed(() => roles.value.join(', ') || '未上报')

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

async function boot() {
  testBarrier()          // 仅 ?barrier= 出现时生效（无头测试的同步屏障）
  try {
    const m = await import('./api/client')
    apiBase.value = m.API_BASE
  } catch { /* ignore */ }
  // 角色（读不到就如实视为"未上报"—— 不默认给教师权限）
  try {
    const m = await import('./api/client')
    const meInfo = await m.api.me()
    roles.value = meInfo.roles || []
    perms.value = meInfo.permissions || []
  } catch { /* 未登录 / 后端没这个接口 → 角色为空，设置入口不显示 */ }
  await docsApi.load()
  if (!activeDoc.value && docsApi.docs.value.length) {
    const first = docsApi.docs.value.find((d) => d.kind !== 'video' && d.status === 'ready') || docsApi.docs.value[0]
    void router.replace({ query: { ...route.query, doc: first.id } })
  }
}
onMounted(boot)
watch(() => docsApi.docs.value.length, () => { void boot })

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
    <button
      class="theme-toggle"
      type="button"
      data-testid="theme-toggle"
      :title="theme === 'dark' ? '切到亮色（手册纸）' : '切到暗色（深墨）'"
      @click="toggleTheme"
    >{{ theme === 'dark' ? '☾ 暗' : '☀ 亮' }}</button>
    <CapabilityBanner :caps="caps" compact />
    <span v-if="capsError" class="gate-note" data-testid="caps-error" :title="capsError">
      能力接口读取失败：{{ capsError }} <button type="button" @click="reload()">重试</button>
    </span>
  </header>

  <!--
  ⚠️ key 用 `route.path` 而不是 `route.fullPath`：
  App 首次进入会给地址补 `?doc=…`，若 key 含 query 就会**立刻重挂载视图** ——
  结果第一个实例会在第二个实例还没渲染时先写出 `#*-report`，
  无头驱动一见 report 就取 DOM，于是读到"空表格"（实测踩到，且是偶发）。
  只按 path 做 key：换文档不再重挂载，视图内部各自 watch `route.query.doc` 重新加载。
-->
  <RouterView :key="route.path" />
</template>

