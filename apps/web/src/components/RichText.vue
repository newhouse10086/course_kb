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
import { highlightCode } from '../utils/highlight'

const props = withDefaults(defineProps<{
  text: string
  /** 是否显示统计（调试/e2e 用） */
  stats?: boolean
  /** 长代码折叠阈值（行） */
  foldLines?: number
}>(), { stats: false, foldLines: 24 })

const blocks = computed(() => splitBlocks(props.text || ''))
/**
 * ★ 代码高亮（Lead 裁定）：**按需语言**（sql/python/js/bash/json/xml）· 同步 · 未标语言**不高亮**。
 *   高亮只作用于**代码内容**；未闭合围栏仍由 `splitBlocks()` 容错（互不影响）。
 */
const codeHtml = computed(() => blocks.value.map((b) => (b.kind === 'code'
  ? highlightCode(b.text, b.lang || '')
  : { html: '', hl: false, reason: '' })))
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
          <span class="pill" :class="b.lang ? (codeHtml[i].hl ? 'blue' : 'warn') : 'warn'" data-testid="code-lang"
                :data-hl="codeHtml[i].hl ? '1' : '0'">{{ b.lang || '未标语言' }}</span>
          <!-- ★ 高亮状态如实标注：没高亮要说清是"未标语言"还是"未注册该语言"，别让人以为高亮坏了 -->
          <span v-if="!codeHtml[i].hl" class="small faint" data-testid="code-no-hl">{{ codeHtml[i].reason }}</span>
          <span v-else class="small faint" data-testid="code-hl-ok">已高亮（{{ b.lang }}）</span>
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
          <pre class="code" :data-lines="b.text.split('\n').length"><code v-html="codeHtml[i].html" /></pre>
        </details>
        <pre v-else class="code" :data-lines="b.text.split('\n').length"><code v-html="codeHtml[i].html" /></pre>
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
/* ★ 高亮配色**走设计 token**（不引入 highlight.js 自带主题 —— v1 的教训就是"自带一套配色"）
   只覆盖我们需要的少量 token：关键字/字符串/注释/数字/内置/属性 */
.code :deep(.hljs-keyword), .code :deep(.hljs-selector-tag), .code :deep(.hljs-literal) { color: var(--accent); font-weight: 600; }
.code :deep(.hljs-string), .code :deep(.hljs-meta-string) { color: #2f6b4f; }
.code :deep(.hljs-comment), .code :deep(.hljs-quote) { color: var(--ink-3); font-style: italic; }
.code :deep(.hljs-number), .code :deep(.hljs-symbol) { color: #7a4b9c; }
.code :deep(.hljs-built_in), .code :deep(.hljs-type) { color: var(--ink-2); font-weight: 600; }
.code :deep(.hljs-attr), .code :deep(.hljs-attribute) { color: var(--ink-2); }
.code :deep(.hljs-title), .code :deep(.hljs-function) { color: var(--ink); font-weight: 600; }

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
