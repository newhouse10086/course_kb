/**
 * 代码高亮（highlight.js **按需注册**，不是全语言包）
 *
 * 选型理由（Lead 裁定 2026-10-15）：
 *   · **只注册 6 种语言** —— `import hljs from 'highlight.js'` 是全语言包（几百 KB），不用
 *   · **同步 API**（`hljs.highlight`）—— ★ 不引入异步：我们刚踩过"顶层 await → async setup → 整页白屏"（坑 25）
 *   · **纯前端、离线可用**
 *
 * 安全：`hljs.highlight()` 的输出是**转义过的**（`<script>` 会变成 `&lt;script&gt;`）；
 *   我们仍然断言"代码块路径里没有真的 script 元素"。
 */
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import xml from 'highlight.js/lib/languages/xml'

/** 只注册我们课程场景需要的语言（少一个语言少一份体积） */
const LANGS: Record<string, string> = {
  sql: 'sql', mysql: 'sql', sqlite: 'sql',
  python: 'python', py: 'python',
  javascript: 'javascript', js: 'javascript', ts: 'javascript', typescript: 'javascript',
  bash: 'bash', sh: 'bash', shell: 'bash',
  json: 'json',
  xml: 'xml', html: 'xml',
}
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('python', python)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('xml', xml)

export const SUPPORTED_LANGS = Object.keys(LANGS)

/**
 * 高亮一段代码。
 * ★ **未标语言 / 语言不支持 → 不高亮**（返回纯转义文本）—— 不猜语言（Lead 硬要求 3）。
 * ★ 未闭合围栏由 `splitBlocks()` 处理，这里只负责"代码内容"（Lead 硬要求 1）。
 */
export function highlightCode(code: string, lang: string): { html: string; hl: boolean; reason: string } {
  const key = LANGS[String(lang || '').toLowerCase()]
  if (!key) {
    return { html: escapeHtml(code), hl: false, reason: lang ? `未注册该语言（${lang}）→ 不高亮` : '未标语言 → 不高亮' }
  }
  try {
    // 同步、无网络；输出已转义
    return { html: hljs.highlight(code, { language: key, ignoreIllegals: true }).value, hl: true, reason: '' }
  } catch (e) {
    // 高亮失败**不许影响内容**：退回纯转义文本，并如实说明
    return { html: escapeHtml(code), hl: false, reason: `高亮失败：${(e as Error).message}` }
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
