/**
 * 富文本渲染（**模型输出是不可信输入** —— 先转义，再只加我们自己生成的标记）
 *
 * 用户实测反馈（2026-10-15）：**Markdown 没渲染** —— 学生看到一堆 `##` 和 `|`。
 * 所以这里补全**基础 markdown**：
 *   标题 `#`–`######` · **表格** · `**粗体**`/`*斜体*` · 有序/无序列表 · 引用 `>` · 链接 · 分割线 · 行内 `code`
 * 加上原有的 **公式（KaTeX）** 与 **代码块（围栏 + 未闭合容错）**。
 *
 * 安全模型（不引通用 markdown 库、不做裸 v-html）：
 *   ① **整段文本先 `esc()`**（`<script>` → `&lt;script&gt;`）
 *   ② 只把**我们自己生成的标签**拼进去；`**`/`|` 这些标记在转义后仍然可识别
 *   ③ 链接**白名单协议**（http/https/mailto/#）—— `javascript:` 一律当普通文本
 *   ④ 公式用 KaTeX（`trust:false`），失败**如实显示原文 + 原因**（不静默）
 */
import katex from 'katex'
import { esc } from './text'

export interface RichBlock {
  kind: 'code' | 'html'
  /** 代码块语言（可能为空 —— 模型忘了标） */
  lang?: string
  /** code：原文（未转义）；html：已转义/已渲染的安全 HTML */
  text: string
  /** 未闭合的代码围栏（模型漏了结尾的 ```）—— UI 要如实标注 */
  unclosed?: boolean
}

/** 模型可能用 `\(...\)` / `\[...\]`（我们要求 `$...$`，但要识别出来并**如实提示**） */
const ALT_INLINE = /\\\(([\s\S]+?)\\\)/g
const ALT_BLOCK = /\\\[([\s\S]+?)\\\]/g

/* ───────────────────────── 块级解析 ───────────────────────── */

/**
 * 把一段文本切成"代码块 / 富文本块"。
 * ★ **未闭合围栏容错**：出现 ``` 之后没有结尾 → 按代码块渲染到结尾（**不是整段崩成纯文本**）。
 * ★ 富文本部分再按 **markdown 块**（标题/表格/列表/引用/分割线/段落）切分。
 */
export function splitBlocks(src: string): RichBlock[] {
  const out: RichBlock[] = []
  const lines = String(src ?? '').split('\n')
  let buf: string[] = []
  let fence: { lang: string; body: string[] } | null = null

  const flushText = () => {
    if (buf.length) {
      for (const html of renderBlocks(buf)) out.push({ kind: 'html', text: html })
      buf = []
    }
  }

  for (const line of lines) {
    const m = /^\s*```\s*([A-Za-z0-9+#-]*)\s*$/.exec(line)
    if (fence && m) {
      out.push({ kind: 'code', lang: fence.lang, text: fence.body.join('\n') })
      fence = null
      continue
    }
    if (!fence && m) {
      flushText()
      fence = { lang: (m[1] || '').toLowerCase(), body: [] }
      continue
    }
    if (fence) fence.body.push(line)
    else buf.push(line)
  }
  if (fence) {
    // ⚠️ 未闭合：照样按代码块渲染（并标注），否则会整段退化成纯文本
    out.push({ kind: 'code', lang: fence.lang, text: fence.body.join('\n'), unclosed: true })
  }
  flushText()
  return out
}

/** markdown 块解析（输入是**原始文本**，内部逐块 `renderInline` 转义） */
export function renderBlocks(lines: string[]): string[] {
  const out: string[] = []
  let i = 0
  const isBlank = (s: string) => /^\s*$/.test(s)

  while (i < lines.length) {
    const line = lines[i]

    if (isBlank(line)) { i++; continue }

    // ① 分割线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr class="md-hr">'); i++; continue }

    // ② 标题 # … ######
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      const lvl = h[1].length
      out.push(`<h${lvl} class="md-h${lvl}" data-md="h${lvl}">${renderInline(h[2])}</h${lvl}>`)
      i++
      continue
    }

    // ③ 表格：`| a | b |` + 分隔行
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (s: string) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const head = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++ }
      const th = head.map((c) => `<th>${renderInline(c)}</th>`).join('')
      const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')
      out.push(`<table class="md-table" data-md="table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`)
      continue
    }

    // ④ 引用 >
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      out.push(`<blockquote class="md-quote" data-md="quote">${body.map((b) => renderInline(b)).join('<br>')}</blockquote>`)
      continue
    }

    // ⑤ 列表（无序 / 有序，支持一层缩进）
    const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      const ordered = !!ol
      const items: string[] = []
      while (i < lines.length) {
        const m = ordered ? /^(\s*)(\d+)[.)]\s+(.*)$/.exec(lines[i]) : /^(\s*)[-*+]\s+(.*)$/.exec(lines[i])
        if (!m) break
        const indent = m[1].length
        const text = ordered ? m[3] : m[2]
        items.push(`<li${indent >= 2 ? ' class="md-li-2"' : ''}>${renderInline(text)}</li>`)
        i++
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag} class="md-list" data-md="list">${items.join('')}</${tag}>`)
      continue
    }

    // ⑥ 段落（连续非空行合并，行内换行保留 <br>）
    const para: string[] = []
    while (i < lines.length && !isBlank(lines[i])
      && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
      && !/^\s{0,3}#{1,6}\s+/.test(lines[i])
      && !/^\s*>/.test(lines[i])
      && !/^\s*\|/.test(lines[i])
      && !/^(\s*)[-*+]\s+/.test(lines[i])
      && !/^(\s*)(\d+)[.)]\s+/.test(lines[i])) {
      para.push(lines[i]); i++
    }
    if (para.length) out.push(`<p class="md-p">${para.map((x) => renderInline(x)).join('<br>')}</p>`)
    else i++   // 保险：避免死循环
  }
  return out
}

/* ───────────────────────── 行内渲染 ───────────────────────── */

/** 行内：`$$…$$`（块级）/ `$…$`（行内）/ 粗体 / 斜体 / 行内 code / 链接 —— 全部先转义 */
export function renderInline(text: string): string {
  // ① 先整体转义（模型输出不可信）
  let s = esc(text)

  // ② 把"受保护的片段"（公式 / 行内 code / 链接）抽成占位符，避免被 ** / * 规则误伤
  const hold: string[] = []
  const keep = (html: string) => { hold.push(html); return `\u0000${hold.length - 1}\u0000` }

  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => keep(renderMath(tex, true)))
  s = s.replace(/\$([^\n$]+?)\$/g, (_m, tex: string) => keep(renderMath(tex, false)))
  s = s.replace(ALT_BLOCK, (_m, tex: string) => keep(renderMath(tex, true, '用了 \\[…\\]（契约要求 $$…$$）')))
  s = s.replace(ALT_INLINE, (_m, tex: string) => keep(renderMath(tex, false, '用了 \\(…\\)（契约要求 $…$）')))
  s = s.replace(/`([^`\n]+?)`/g, (_m, code: string) => keep(`<code class="md-code">${code}</code>`))

  // ③ 链接（**白名单协议**：javascript: 等一律当普通文本）
  s = s.replace(/\[([^\]\n]+?)\]\(([^)\s]+?)\)/g, (m, label: string, href: string) => {
    const h = href.replace(/&amp;/g, '&')
    if (!/^(https?:\/\/|mailto:|#|\/)/i.test(h)) return m
    return keep(`<a class="md-a" href="${esc(h)}" target="_blank" rel="noopener noreferrer">${label}</a>`)
  })

  // ④ 粗体 / 斜体（先 ** 再 *；要求两侧不是空白，避免误伤乘号）
  s = s.replace(/\*\*([^\s*][\s\S]*?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[\s（(])\*([^\s*][^*\n]*?)\*(?=[\s）)。，,.]|$)/g, '$1<em>$2</em>')

  // ⑤ 还原受保护片段
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => hold[Number(n)] ?? '')
  return s
}

/** 单条公式：成功 → KaTeX HTML；失败 → **原文 + 明确标记**（不静默吞掉） */
export function renderMath(tex: string, display: boolean, warn = ''): string {
  const raw = tex.trim()
  try {
    const html = katex.renderToString(raw, {
      displayMode: display,
      throwOnError: true,          // ★ 失败要能捕获 → 走下面的如实分支
      strict: false,               // 允许中文 \text{} 等
      trust: false,                // 不允许 \htmlClass/\href 之类的信任扩展
      output: 'html',
    })
    return `<span class="math-ok" data-math="1" data-display="${display ? 1 : 0}">${html}</span>`
  } catch (e) {
    const why = (e as Error).message || '解析失败'
    return `<span class="math-fail" data-math="0" data-math-error="1" title="${esc(why)}">`
      + `<code>${esc(tex)}</code><em class="math-fail-note">公式渲染失败：${esc(why)}</em>`
      + (warn ? `<em class="math-fail-note">（${esc(warn)}）</em>` : '')
      + '</span>'
  }
}

/** 供 e2e 断言：这段富文本里有没有公式/代码/失败/**markdown 结构** */
export function richStats(blocks: RichBlock[]) {
  const html = blocks.filter((b) => b.kind === 'html').map((b) => b.text).join('')
  const count = (re: RegExp) => (html.match(re) || []).length
  return {
    blocks: blocks.length,
    code: blocks.filter((b) => b.kind === 'code').length,
    unclosed: blocks.filter((b) => b.unclosed).length,
    math: count(/data-math="1"/g),
    mathFail: count(/data-math-error="1"/g),
    // ★ 用户实测反馈的判据：标题/表格/粗体**真的变成了标签**（不是 `##` / `|` 纯文本）
    headings: count(/<h[1-6][\s>]/g),
    h2: count(/<h2[\s>]/g),
    table: count(/<table[\s>]/g),
    strong: count(/<strong>/g),
    list: count(/<ul[\s>]|<ol[\s>]/g),
    quote: count(/<blockquote[\s>]/g),
    link: count(/<a class="md-a"/g),
  }
}
