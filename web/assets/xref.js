/* ==========================================================================
   xref.js —— 交叉引用渲染（FUNCTIONAL_SPEC F4）
   --------------------------------------------------------------------------
   Wiki 的本质是页面互相引用：
     · 正文内链：知识点名 → 蓝色虚线链接，点击跳转 + 高亮定位
     · 引用区：类型化 / 正文提到 / 还出现在 / 同单元
     · 反链 backlinks：wiki 的精髓
   抄自 ../数据库课程智能体调研/product/prototype/wiki_v2.html 的 linkify + xrefHTML，
   含坑 6（mention 假阳性过滤）与坑 7（自引用去尾部 ()）两条已验证规则。
   ========================================================================== */

import { esc, escRe, nameKey } from './util.js';

export const REL_ZH = {
  typed: '类型化关系（图谱边）',
  mention: '正文提到',
  also_in: '还出现在',
  same_unit: '同单元知识点',
};
export const REL_CLS = { typed: 'typed', mention: '', also_in: 'also_in', same_unit: 'same_unit' };

/** 契约 §2.5 的 NOISE 集合：这些词在英文原文里是普通单词，链它会满屏噪音。 */
export const LINK_NOISE = new Set([
  'use', 'and', 'or', 'not', 'in', 'is', 'as', 'on', 'to', 'by', 'if', 'for',
  'all', 'any', 'set', 'key', 'desc', 'path', 'date', 'char', 'time', 'text', 'blob', 'view',
  'index', 'table', 'value', 'name', 'type', 'user', 'host', 'port', 'file', 'test', 'data', 'event',
]);

/** 是否为「标识符样式」的名字（含中文或符号）→ 允许直接内链。 */
export function isIdentifier(raw) {
  return /[\u4e00-\u9fff()\[\].\-_@#$%]/.test(String(raw || ''));
}

/**
 * 引用索引：/{doc}/xrefs 一次拉全，省掉 N 次 /cards/{id} 详情请求。
 * @returns {{out: Map<string, Array>, in: Map<string, Array>}}
 */
export function buildXrefIndex(xrefs, cardsById) {
  const out = new Map();
  const inn = new Map();
  const name = (id) => {
    const c = cardsById && cardsById.get(id);
    return c ? c.name : id;
  };
  for (const x of (xrefs || [])) {
    const from = x.from_card_id || x.from;
    const to = x.to_card_id || x.to;
    if (!from || !to || from === to) continue;                    // 坑 7：字面自引用直接丢
    const rel = x.rel || 'mention';
    if (!out.has(from)) out.set(from, []);
    if (!inn.has(to)) inn.set(to, []);
    out.get(from).push({ id: to, rel, weight: Number(x.weight || 1), name: name(to) });
    inn.get(to).push({ id: from, rel, weight: Number(x.weight || 1), name: name(from) });
  }
  return { out, in: inn };
}

/** 由卡片列表建「名字 → 卡片」索引（linkify 与服务端 name_key 同口径）。 */
export function buildNameIndex(cards) {
  const byKey = new Map();
  const display = new Map();
  const list = [];
  for (const c of (cards || [])) {
    const k = nameKey(c.name);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, c.id);
    display.set(k, c.name);
    list.push({ key: k, raw: c.name, id: c.id });
  }
  // 长名优先：否则 "CREATE TABLE" 会先被 "CREATE" 命中
  list.sort((a, b) => b.raw.length - a.raw.length);
  return { byKey, display, list };
}

/**
 * 正文 → 带内链的 HTML。
 * @param {string} text
 * @param {object} o {selfId, selfKey, index:{byKey,display,list}}
 */
export function linkify(text, o) {
  const opts = o || {};
  let s = esc(text == null ? '' : text);
  if (!opts.index || !opts.index.list || !opts.index.list.length) return s;
  const selfKey = opts.selfKey != null ? opts.selfKey : nameKey(opts.selfName || '');
  const selfBare = selfKey ? selfKey.replace(/\(\)$/, '') : null;
  const already = new Set();
  for (const it of opts.index.list) {
    const k = it.key;
    if (k === selfKey) continue;
    if (selfBare && k.replace(/\(\)$/, '') === selfBare) continue;   // 坑 7：TIMESTAMPDIFF() vs TIMESTAMPDIFF
    if (LINK_NOISE.has(k)) continue;                                 // 坑 6
    if (already.has(k)) continue;
    const targetId = opts.index.byKey.get(k);
    if (!targetId || targetId === opts.selfId) continue;
    const raw = it.raw;
    const escRaw = esc(raw);
    if (s.indexOf(escRaw) < 0) {
      // 短名/含空格且原文出现全大写代码形式 → 也链（如 "select" 卡片在正文里写作 SELECT）
      if (isIdentifier(raw)) continue;
      const up = raw.toUpperCase();
      if (up === raw || s.toUpperCase().indexOf(esc(up)) < 0) continue;
      const reUp = new RegExp('(^|[^\\w>])' + escRe(esc(up)) + '(?![\\w<])', 'g');
      let hit = false;
      s = s.replace(reUp, (m, p1) => { hit = true; return p1 + anchor(targetId, up, raw); });
      if (hit) already.add(k);
      continue;
    }
    const ident = isIdentifier(raw);
    if (!ident && (k.length < 6 || k.indexOf(' ') > 0)) {
      // 规则 3：短名/含空格必须**全大写**出现才链，否则是普通单词
      const up = raw.toUpperCase();
      const reUp = new RegExp('(^|[^\\w>])' + escRe(esc(up)) + '(?![\\w<])', 'g');
      let hit = false;
      s = s.replace(reUp, (m, p1) => { hit = true; return p1 + anchor(targetId, up, raw); });
      if (hit) already.add(k);
      continue;
    }
    const re = new RegExp('(^|[^\\w>])' + escRe(escRaw) + '(?![\\w<])', 'g');
    let hit = false;
    s = s.replace(re, (m, p1) => { hit = true; return p1 + anchor(targetId, raw, raw); });
    if (hit) already.add(k);
  }
  return s;
}

function anchor(cardId, label, title) {
  return `<a class="inner" href="#card-${esc(cardId)}" data-goto-card="${esc(cardId)}" title="跳转到：${esc(title)}">${esc(label)}</a>`;
}

/**
 * 引用区 + 反链区 HTML。
 * @param {object} card 卡片（契约 §2.3）
 * @param {object} index buildXrefIndex 结果
 * @param {object} cardsById Map
 */
export function xrefHTML(card, index, cardsById, opts) {
  const o = opts || {};
  const out = (index && index.out.get(card.id)) || [];
  const back = (index && index.in.get(card.id)) || [];
  const groups = { typed: [], mention: [], also_in: [], same_unit: [] };
  for (const x of out) (groups[x.rel] || (groups[x.rel] = [])).push(x);
  const nm = (id) => {
    const c = cardsById && cardsById.get(id);
    return c ? c.name : id;
  };
  let h = '<div class="xref" data-card="' + esc(card.id) + '">';
  let any = false;
  const order = ['typed', 'mention', 'also_in', 'same_unit'];
  const keys = order.concat(Object.keys(groups).filter((k) => order.indexOf(k) < 0));
  for (const rel of keys) {
    const arr = groups[rel] || [];
    if (!arr.length) continue;
    any = true;
    h += `<div class="xref-h" data-rel="${esc(rel)}">${esc(REL_ZH[rel] || rel)}（${arr.length}）</div><div class="xref-list">`;
    for (const x of arr.slice(0, o.limit || 60)) {
      h += `<a class="xr ${REL_CLS[rel] || ''}" href="#card-${esc(x.id)}" data-goto-card="${esc(x.id)}" data-rel="${esc(rel)}" title="${esc(REL_ZH[rel] || rel)}">${esc(nm(x.id))}</a>`;
    }
    h += '</div>';
  }
  if (back.length) {
    any = true;
    h += `<div class="xref-h" data-rel="backlinks">反链 · 谁引用了我（${back.length}）</div><div class="xref-list">`;
    for (const x of back.slice(0, o.limit || 60)) {
      h += `<a class="xr back" href="#card-${esc(x.id)}" data-goto-card="${esc(x.id)}" data-rel="backlink" title="被引用于：${esc(nm(x.id))}">← ${esc(nm(x.id))} <span class="t">${esc(REL_ZH[x.rel] || x.rel)}</span></a>`;
    }
    h += '</div>';
  }
  h += '</div>';
  return any ? h : '<div class="xref"><div class="xref-h">交叉引用</div><div class="faint small">（本卡片暂无引用）</div></div>';
}

/** 事件委托：点内链/引用 → 交给页面处理跨单元跳转 + 高亮。 */
export function bindGoto(root, handler) {
  root.addEventListener('click', (ev) => {
    const el = ev.target && ev.target.closest ? ev.target.closest('[data-goto-card]') : null;
    if (!el) return;
    const id = el.getAttribute('data-goto-card');
    if (!id) return;
    ev.preventDefault();
    handler(id, el);
  });
}
