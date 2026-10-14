/* ==========================================================================
   mindmap.js —— markmap 兼容 Markdown 大纲 → 可折叠树（无第三方库，F6-S6）
   --------------------------------------------------------------------------
   后端 /video/mindmap 返回 {format:"markmap", content:"# 索引\n## B+树\n- ..."}
   这里只做「Markdown 大纲 → 树 → 可折叠 DOM」，不引 markmap 依赖（无构建链）。
   额外：行内出现 mm:ss / hh:mm:ss 时自动加「跳转」小按钮（点它 seek 视频）。
   ========================================================================== */

import { esc, fmtMs } from './util.js';

/** 把 markmap 风格 Markdown 解析成树。支持 "#" 标题、"-"/"*"/"+" 列表、按缩进嵌套。
 *  （注意：注释里不能出现 "斜杠+星号" 序列，否则会提前结束块注释 —— 踩过一次。）*/
export function parseMindmap(md) {
  const lines = String(md || '').split(/\r?\n/);
  const root = { text: '', level: -1, children: [], at: null };
  const stack = [root];
  let seen = 0;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indent = (raw.match(/^[\t ]*/) || [''])[0].replace(/\t/g, '  ').length;
    let text = raw.trim();
    let level;
    const h = text.match(/^(#{1,6})\s+(.*)$/);
    const li = text.match(/^[-*+]\s+(.*)$/);
    if (h) { level = h[1].length * 2; text = h[2].trim(); }
    else if (li) { level = indent + 2; text = li[1].trim(); }
    else if (/^\d+[.)]\s+/.test(text)) { level = indent + 2; text = text.replace(/^\d+[.)]\s+/, ''); }
    else continue;                              // 非大纲行（如说明文字）忽略
    const node = { text, level, children: [], at: extractTime(text) };
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1];
    parent.children.push(node);
    stack.push(node);
    seen++;
  }
  return { root, count: seen };
}

/** 从行内提取时间锚：`(01:23)` `[01:23:45]` `@83s` `@1200ms` → 毫秒。 */
export function extractTime(text) {
  let m = text.match(/[[(]\s*(\d{1,2}):(\d{2}):(\d{2})\s*[\])]/);
  if (m) return ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000;
  m = text.match(/[[(]\s*(\d{1,2}):(\d{2})\s*[\])]/);
  if (m) return ((+m[1]) * 60 + (+m[2])) * 1000;
  m = text.match(/@\s*(\d+)\s*ms\b/i);
  if (m) return +m[1];
  m = text.match(/@\s*(\d+)\s*s\b/i);
  if (m) return (+m[1]) * 1000;
  return null;
}

/**
 * 渲染成可折叠树。
 * @param {HTMLElement} mount
 * @param {{root:object}} parsed
 * @param {object} o {onSeek(ms), maxDepth, collapsedFrom}
 * @returns {{collapseAll(v:boolean):void, nodeCount:number, collapsed:boolean}}
 */
export function renderMindmap(mount, parsed, o) {
  const opts = Object.assign({ maxDepth: 9, collapsedFrom: 3, onSeek: null }, o || {});
  mount.innerHTML = '';
  let nodeCount = 0;

  function build(node, depth) {
    const kids = node.children || [];
    const wrap = document.createElement('div');
    wrap.className = 'mm-node mm-l' + Math.min(6, depth);
    if (kids.length && depth >= opts.collapsedFrom) wrap.classList.add('collapsed');

    const head = document.createElement('div');
    head.className = 'mm-head';
    const tgl = document.createElement('span');
    tgl.className = 'mm-toggle';
    tgl.textContent = kids.length ? (wrap.classList.contains('collapsed') ? '▸' : '▾') : '·';
    tgl.setAttribute('role', 'button');
    tgl.setAttribute('aria-label', kids.length ? '折叠/展开' : '叶子节点');
    if (kids.length) {
      tgl.addEventListener('click', () => {
        wrap.classList.toggle('collapsed');
        tgl.textContent = wrap.classList.contains('collapsed') ? '▸' : '▾';
      });
    }
    head.appendChild(tgl);

    const label = document.createElement('span');
    label.className = 'mm-text';
    label.innerHTML = esc(node.text);
    head.appendChild(label);

    if (node.at != null && opts.onSeek) {
      const btn = document.createElement('button');
      btn.className = 'mm-seek';
      btn.type = 'button';
      btn.dataset.at = String(node.at);
      btn.textContent = '▶ ' + fmtMs(node.at);
      btn.title = '跳到视频该时间点';
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); opts.onSeek(node.at); });
      head.appendChild(btn);
    }
    wrap.appendChild(head);
    nodeCount++;

    if (kids.length) {
      const box = document.createElement('div');
      box.className = 'mm-children';
      kids.forEach((k) => box.appendChild(build(k, depth + 1)));
      wrap.appendChild(box);
    }
    return wrap;
  }

  (parsed.root.children || []).forEach((c) => mount.appendChild(build(c, 1)));

  const api = {
    nodeCount,
    collapsed: false,
    collapseAll(v) {
      api.collapsed = !!v;
      mount.querySelectorAll('.mm-node').forEach((el) => {
        const hasKids = !!el.querySelector(':scope > .mm-children');
        if (!hasKids) return;
        el.classList.toggle('collapsed', !!v);
        const tg = el.querySelector(':scope > .mm-head > .mm-toggle');
        if (tg) tg.textContent = v ? '▸' : '▾';
      });
    },
  };
  return api;
}
