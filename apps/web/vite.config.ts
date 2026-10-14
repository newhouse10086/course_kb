import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * Vite 配置（T-FRONTEND 写域：apps/web/**）
 *
 * · dev server 把 /api 代理到后端 127.0.0.1:8787，**避免跨域**（契约 C6/坑 8 的 v2 解法）
 * · 生产构建产物 dist/ 由后端或 mock server 同源托管（前端永远用相对 /api/v1）
 * · Vitest 复用同一份配置：纯逻辑测试跑 node 环境，组件测试按文件头 `@vitest-environment jsdom`
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
  test: {
    include: ['test/unit/**/*.spec.ts'],
    environment: 'node',
    reporters: 'default',
  },
})
