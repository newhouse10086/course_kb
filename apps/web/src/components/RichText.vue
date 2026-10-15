<script setup lang="ts">
/**
 * 富文本渲染组件（公式 / 代码块 / 普通文本）—— 用户需求：AI 生成内容要**渲染好**
 *
 * 安全：**模型输出先 esc() 再拼我们的标签**（不用通用 markdown 库，避免 v-html 注入面）。
 * 诚实：
 *   · KaTeX 解析失败 → 显示原文 + 「公式渲染失败」（**不静默**）
 *   · 代码围栏未闭合 → 照样按代码块渲染 + 标注（**不整段崩成纯文本**）
 *   · 模型用了 `\(…\)` / `\[…\]` → 渲染但标注"契约要求 $…$"
 */
import { computed, ref } from 'vue'
import { splitBlocks, richStats } from '../utils/rich'

const props = withDefaults(defineProps<{
  text: string
  /** 是否显示统计（调试/e2e 用） */
  stats?: boolean
  /** 长代码折叠阈值（行） */
  foldLines?: number
}>(), { stats: false, foldLines: 24 })

const blocks = computed(() => splitBlocks(props.text || ''))
const st = computed(() => richStats(blocks.value))
const copied = ref('')

async function copy(code: string) {
  try {
    await navigator.clipboard.writeText(code)
    copied.value = code
    setTimeout(() => { if (copied.value === code) copied.value = '' }, 1200)
  } catch {
    copied.value = ''   // 剪贴板不可用（无头/权限）→ 不假装成功
  }
}
</script>

<template>
  <div class="rich" data-testid="rich-text"
       :data-blocks="st.blocks" :data-code="st.code" :data-unclosed="st.unclosed"
       :data-math="st.math" :data-math-fail="st.mathFail">
    <template v-for="(b, i) in blocks" :key="i">
      <!-- 代码块：语言标签 + 复制 + 长代码折叠 + **未闭合如实标注** -->
      <div v-if="b.kind === 'code'" class="code-block" data-testid="code-block"
           :data-lang="b.lang || ''" :data-unclosed="b.unclosed ? '1' : '0'">
        <div class="code-head">
          <span class="pill" :class="b.lang ? 'blue' : 'warn'" data-testid="code-lang">{{ b.lang || '未标语言' }}</span>
          <span v-if="b.unclosed" class="small warn-text" data-testid="code-unclosed">
            ⚠ 代码围栏未闭合（模型漏了结尾的 ```）—— 已按代码块渲染到最后
          </span>
          <span class="right" />
          <button type="button" class="small" data-testid="code-copy" @click="copy(b.text)">
            {{ copied === b.text ? '已复制' : '复制' }}
          </button>
        </div>
        <!-- ⚠️ 只在**长代码**时套 <details>：短代码也套会渲染出浏览器默认的"详情"折叠标（实测截图里看到） -->
        <details v-if="b.text.split('\n').length > foldLines">
          <summary class="small faint">共 {{ b.text.split('\n').length }} 行 —— 点击展开/折叠</summary>
          <pre class="code" :data-lines="b.text.split('\n').length"><code>{{ b.text }}</code></pre>
        </details>
        <pre v-else class="code" :data-lines="b.text.split('\n').length"><code>{{ b.text }}</code></pre>
      </div>
      <!-- 富文本（公式已渲染成 KaTeX HTML；其余已转义） -->
      <div v-else class="rich-html" v-html="b.text" />
    </template>
    <div v-if="stats" class="small faint" data-testid="rich-stats">
      块 {{ st.blocks }} · 代码 {{ st.code }}（未闭合 {{ st.unclosed }}）· 公式 {{ st.math }}（失败 {{ st.mathFail }}）
    </div>
  </div>
</template>

<style scoped>
.rich { line-height: 1.7; }
.code-block { margin: 6px 0; border: var(--hair) solid var(--rule-strong); background: var(--paper-2); }
.code-head { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-bottom: var(--hair) solid var(--rule); }
.code { margin: 0; padding: 8px 10px; overflow: auto; font-family: var(--mono); font-size: 12.5px; line-height: 1.55; }
.warn-text { color: var(--warn); }
.rich-html :deep(.math-ok) { display: inline-block; }
.rich-html :deep(.math-ok[data-display="1"]) { display: block; margin: 8px 0; text-align: center; }
.rich-html :deep(.math-fail) { display: inline-block; border-bottom: 1px dashed var(--warn); }
.rich-html :deep(.math-fail code) { color: var(--ink-2); }
.rich-html :deep(.math-fail-note) { color: var(--warn); font-style: normal; font-size: 12px; margin-left: 4px; }
</style>
