import { createRouter, createWebHashHistory } from 'vue-router'

/**
 * 路由：七个视图（ARCHITECTURE_V2 §2 / M4；`/lab` 与 `/settings` 为 2026-10-15 新增）
 * 用 **hash 模式**：静态托管（后端同源托管 dist/、或 mock server）时不需要任何
 * 服务端 rewrite，深链 `#/wiki?doc=..&unit=..&card=..` 直接可用。
 */
export const routes = [
  { path: '/', redirect: '/wiki' },
  { path: '/login', name: 'login', component: () => import('./views/Login.vue') },
  { path: '/wiki', name: 'wiki', component: () => import('./views/WikiIndex.vue') },
  { path: '/graph', name: 'graph', component: () => import('./views/Graph.vue') },
  { path: '/video', name: 'video', component: () => import('./views/Video.vue') },
  { path: '/chat', name: 'chat', component: () => import('./views/Chat.vue') },
  { path: '/docs', name: 'docs', component: () => import('./views/Docs.vue') },
  { path: '/lab', name: 'lab', component: () => import('./views/Lab.vue') },
  { path: '/settings', name: 'settings', component: () => import('./views/Settings.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/wiki' },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

