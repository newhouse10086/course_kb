/**
 * 富文本渲染（**模型输出是不可信输入** —— 先转义，再只加我们自己生成的标记）
 *
 * 用户需求（视频 AI 助手）：生成内容里会有**公式 / 代码块 / 思维导图**，前端要渲染好。
 *
 * 为什么不用通用 markdown 库：
 *   · 模型输出直接进 `v-html` 是 **XSS 面**（我们一路上在修注入类问题）；
 *   · 我们只需要三类：**公式（KaTeX）/ 代码块（语言标签 + 复制 + 未闭合容错）/ 普通文本**。
 *     → 自己做一个**白名单渲染器**：**先 esc() 转义全部输入**，再拼我们自己的标签。
 *
 * ⚠️ 公式渲染失败**不许静默**：KaTeX 抛错时**显示原文 + 明确标记"公式渲染失败"** ——
 *    学生看到空白会以为内容丢了（"看起来成功"比崩溃更危险）。
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

/**
 * 把一段文本切成"代码块 / 富文本"两类。
 * ★ **未闭合围栏容错**：出现 ``` 之后没有结尾 → 按代码块渲染到结尾（**不是整段崩成纯文本**）。
 */
export function splitBlocks(src: string): RichBlock[] {
  const out: RichBlock[] = []
  const lines = String(src ?? '').split('\n')
  let buf: string[] = []
  let fence: { lang: string; body: string[] } | null = null

  const flushText = () => {
    if (buf.length) {
      out.push({ kind: 'html', text: renderInline(buf.join('\n')) })
      buf = []
    }
  }

  for (const line of lines) {
    const m = /^\s*```\s*([A-Za-z0-9+#-]*)\s*$/.exec(line)
    if (fence && m) {
      // 收尾围栏
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

/** 行内：`$$…$$`（块级，独占一行）/ `$…$`（行内）/ 其它文本 —— 全部先转义 */
export function renderInline(text: string): string {
  // ① 先整体转义（模型输出不可信）
  let s = esc(text)
  // ② 块级公式 $$…$$（可能跨行）
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => renderMath(tex, true))
  // ③ 行内公式 $…$（不跨行；避免把价格 "$5" 之类误判 → 要求内部不含空白结尾）
  s = s.replace(/\$([^\n$]+?)\$/g, (_m, tex: string) => renderMath(tex, false))
  // ④ 模型用了 \(…\) / \[…\]（我们要求 $…$）→ 也渲染，但**如实标注"应使用 $…$"**
  s = s.replace(ALT_BLOCK, (_m, tex: string) => renderMath(tex, true, '用了 \\[…\\]（契约要求 $$…$$）'))
  s = s.replace(ALT_INLINE, (_m, tex: string) => renderMath(tex, false, '用了 \\(…\\)（契约要求 $…$）'))
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

/** 供 e2e 断言：这段富文本里有没有公式/代码/失败 */
export function richStats(blocks: RichBlock[]) {
  return {
    blocks: blocks.length,
    code: blocks.filter((b) => b.kind === 'code').length,
    unclosed: blocks.filter((b) => b.unclosed).length,
    math: blocks.reduce((n, b) => n + (b.text.match(/data-math="1"/g) || []).length, 0),
    mathFail: blocks.reduce((n, b) => n + (b.text.match(/data-math-error="1"/g) || []).length, 0),
  }
}
