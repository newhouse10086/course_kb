/**
 * markmap 兼容 Markdown 大纲 → 树（FUNCTIONAL_SPEC F6-S6）
 * 后端 `/video/mindmap` 给 `{format:"markmap", content:"# 标题\n## 小节\n- 要点"}`，
 * 前端自己解析成可折叠树（不引 markmap / d3 依赖）。
 *
 * 额外能力：行内出现 `(mm:ss)` / `[hh:mm:ss]` / `@83s` / `@1200ms` → 时间锚，
 * 界面上给一个"▶ 跳到该时间点"按钮。
 */

export interface MindNode {
  text: string
  level: number
  at: number | null
  children: MindNode[]
}

export interface MindTree {
  root: MindNode
  count: number
  maxDepth: number
}

export function extractTime(text: string): number | null {
  let m = text.match(/[[(]\s*(\d{1,2}):(\d{2}):(\d{2})\s*[\])]/)
  if (m && Number(m[3]) < 60) return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000
  m = text.match(/[[(]\s*(\d{1,2}):(\d{2})\s*[\])]/)
  // 秒必须 < 60：`(99:99)` 这种明显是别的数字（版本号/页码），不能当成 6039 秒
  if (m && Number(m[2]) < 60) return (Number(m[1]) * 60 + Number(m[2])) * 1000
  m = text.match(/@\s*(\d+)\s*ms\b/i)
  if (m) return Number(m[1])
  m = text.match(/@\s*(\d+)\s*s\b/i)
  if (m) return Number(m[1]) * 1000
  return null
}

export function parseMindmap(md: string | null | undefined): MindTree {
  const root: MindNode = { text: '', level: -1, at: null, children: [] }
  const stack: MindNode[] = [root]
  /**
   * 子弹头（`-`）单独维护一条栈：
   * 真实 markmap 里 `-` 常常**零缩进**直接跟在 `##` 章节下面，也可能**带缩进**做子层级。
   * 只用 `indent + 2` 算 level 会两种都出错（零缩进挂到根上 / 缩进层级与标题层级撞车）。
   * 规则：父 = 比当前缩进浅的最近一个子弹头，否则 = 最近的标题；同级连续条目互为兄弟。
   */
  const bullets: Array<{ indent: number; node: MindNode }> = []
  let count = 0
  const push = (parent: MindNode, text: string): MindNode => {
    const node: MindNode = { text, level: parent.level + 1, at: extractTime(text), children: [] }
    parent.children.push(node)
    count++
    return node
  }
  for (const rawLine of String(md || '').split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    const indent = (rawLine.match(/^[\t ]*/)?.[0] || '').replace(/\t/g, '  ').length
    const text = rawLine.trim()
    const h = text.match(/^(#{1,6})\s+(.*)$/)
    const li = text.match(/^[-*+]\s+(.*)$/)
    if (h) {
      const level = h[1].length * 2
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop()
      const node = push(stack[stack.length - 1], h[2].trim())
      node.level = level
      stack.push(node)
      bullets.length = 0                       // 标题开启新的一段结构
    } else if (li) {
      while (bullets.length && bullets[bullets.length - 1].indent >= indent) bullets.pop()
      const parent = bullets.length ? bullets[bullets.length - 1].node : stack[stack.length - 1]
      const node = push(parent, li[1].trim())
      bullets.push({ indent, node })
    } else if (/^\d+[.)]\s+/.test(text)) {
      while (bullets.length && bullets[bullets.length - 1].indent >= indent) bullets.pop()
      const parent = bullets.length ? bullets[bullets.length - 1].node : stack[stack.length - 1]
      const node = push(parent, text.replace(/^\d+[.)]\s+/, ''))
      bullets.push({ indent, node })
    } else continue                            // 非大纲行（说明文字）忽略
  }
  const depthOf = (n: MindNode): number =>
    n.children.length ? 1 + Math.max(...n.children.map(depthOf)) : 0
  return { root, count, maxDepth: depthOf(root) }
}

/** 折叠状态集合（给"全部展开/折叠"用；组件里维护 reactive 版本） */
export function allNodeIds(tree: MindTree): string[] {
  const ids: string[] = []
  const walk = (n: MindNode, path: string) => {
    n.children.forEach((c, i) => {
      const id = `${path}/${i}`
      ids.push(id)
      walk(c, id)
    })
  }
  walk(tree.root, '')
  return ids
}
