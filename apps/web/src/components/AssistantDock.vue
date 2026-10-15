<script setup lang="ts">
/**
 * 全局 chat 小助手（用户明确需求："每个页面都要加一个 chat 小助手"）
 *
 * · **浮动入口**（右下角气泡）+ **抽屉**：不离开当前页面就能问
 * · 出现在**所有页面**（App.vue 全局挂载）
 * · ★ **带页面上下文**：抽屉顶部显示「正在参考：…」
 *     - 本地标签（我这一页在干什么）**立刻可见**
 *     - 服务端 `context` 帧解析出的**真实标题**到达后覆盖它（`Chat.vue` 内部显示）
 * · **与 `/chat` 整页共用同一个组件**（`<Chat embedded />`）—— 不写第二套
 * · **Lab 页**另有专用答疑面板（`/sandbox/ask`，SQL 纠错专用）；小助手仍可用，
 *   且会把 `session_id` 带上（Lead 裁定），让助教能直接看这位学生的 SQL 与报错
 */
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import Chat from '../views/Chat.vue'
import { assistantContext, assistantContextLabel } from '../composables/useAssistantContext'
import { useCaps } from '../composables/useCaps'

const route = useRoute()
const { caps } = useCaps()
const open = ref(false)

/**
 * ★ 助手入口（backend-api 接线）：**视频页用 `video`** → 系统提示词是视频助手提示词（含渲染契约）；
 *   其余页面用通用对话助手。⚠️ 是连接级参数 → 切页面时组件会以新入口重连。
 */
const assistantEntry = computed<'chat' | 'video'>(() => (route.path === '/video' ? 'video' : 'chat'))

const ctxKeys = computed(() => Object.keys(assistantContext.value || {}))
const hasCtx = computed(() => ctxKeys.value.length > 0)
/** 本地标签：立刻告诉用户"我这一页在参考什么"（服务端解析结果随后覆盖） */
const label = computed(() => assistantContextLabel.value || (hasCtx.value ? ctxKeys.value.join(', ') : ''))

/** 能力门控：pi 不可用 → 入口禁用并写明原因（契约 §7；探测中不阻塞） */
const capsPending = computed(() => !caps.value)
const piOk = computed(() => !!caps.value?.isAvailable('pi'))
const piReason = computed(() => caps.value?.reasonFor('pi') || 'pi 能力未上报')
const disabled = computed(() => !capsPending.value && !piOk.value)

function toggle() {
  if (disabled.value) { open.value = true; return }   // 打开也要能看到原因，而不是"点了没反应"
  open.value = !open.value
}
</script>

<template>
  <div class="assist" data-testid="assistant-dock" :data-open="open ? '1' : '0'" :data-page="route.path"
       :data-ctx-keys="ctxKeys.join(',')">
    <!-- 浮动入口（所有页面可见） -->
    <button
      type="button"
      class="assist-fab"
      data-testid="assistant-fab"
      :class="{ open }"
      :disabled="false"
      :title="disabled ? `pi 不可用：${piReason}` : '打开小助手（带当前页上下文）'"
      @click="toggle"
    >
      <span v-if="!open">💬 小助手</span>
      <span v-else>✕ 收起</span>
      <span v-if="hasCtx" class="assist-dot" data-testid="assistant-ctx-dot" title="已带当前页上下文"></span>
    </button>

    <!-- 抽屉 -->
    <section v-if="open" class="assist-drawer" data-testid="assistant-drawer">
      <header class="assist-head">
        <b>小助手</b>
        <span class="small faint">当前页 {{ route.path }}</span>
        <span v-if="label" class="pill" data-testid="assistant-ctx-label">正在参考：{{ label }}</span>
        <span v-else class="small faint" data-testid="assistant-ctx-none">（本页没有可带上下文）</span>
        <span class="right" />
        <button type="button" class="small" data-testid="assistant-close" @click="open = false">收起</button>
      </header>

      <!-- pi 不可用：入口禁用 + 原因（不是"点了才报错"） -->
      <div v-if="disabled" class="note bad" data-testid="assistant-gate">
        <b>小助手不可用</b>：pi 能力未就绪 —— {{ piReason }}
      </div>
      <div v-else-if="capsPending" class="note warn" data-testid="assistant-caps-pending">
        能力探测中（真探测较慢）：现在就可以问，失败会如实报错。
      </div>

      <!-- ★ 与 /chat 整页**共用同一个组件**（embedded 跳过页面级副作用） -->
      <div class="assist-body">
        <Chat embedded :context="assistantContext" :assistant="assistantEntry" title="小助手" :key="assistantEntry" />
      </div>
      <div class="small faint assist-foot">
        带上下文的问答：只传 id（文档/章节/沙箱会话），服务端解析成真实内容后再用 ——
        客户端传的东西不可信，所以这里**不传自由文本**。
        Lab 页的 SQL 纠错请用页面里的「答疑」面板（它走 `/sandbox/ask`，语义更专）。
      </div>
    </section>
  </div>
</template>

<style scoped>
.assist { position: fixed; right: 18px; bottom: 18px; z-index: 60; }
.assist-fab { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; cursor: pointer;
  background: var(--accent); color: #fff; border: var(--hair) solid var(--accent-ink); border-radius: var(--r-sm);
  font-size: 13px; font-weight: 600; box-shadow: 0 1px 0 var(--accent-ink); }
.assist-fab.open { background: var(--paper-2); color: var(--ink); border-color: var(--rule-strong); }
.assist-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); display: inline-block; }
.assist-drawer { position: absolute; right: 0; bottom: 46px; width: min(560px, calc(100vw - 36px));
  max-height: min(78vh, 720px); overflow: auto; background: var(--panel); border: var(--hair) solid var(--rule-strong);
  border-top: 2px solid var(--accent); padding: 10px 12px; }
.assist-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.assist-body { margin-top: 8px; }
.assist-foot { margin-top: 8px; padding-top: 6px; border-top: var(--hair) dotted var(--rule); }
</style>
