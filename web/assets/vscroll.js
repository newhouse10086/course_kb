/* ==========================================================================
   vscroll.js —— 原生虚拟滚动（无第三方库，见 F6「vue-virtual-scroller → 原生虚拟滚动」）
   --------------------------------------------------------------------------
   长文稿可能几千条（1 小时视频 ≈ 1200+ 段；多了能到上万），
   一次性建 DOM 会卡死渲染 —— 只渲染可视窗口 ± overscan 行。
   行高固定：字幕/文稿行都是等高的两行以内文本，测高会引入抖动。
   ========================================================================== */

export class VirtualList {
  /**
   * @param {HTMLElement} container 滚动容器（需 CSS: position 相对 + overflow auto）
   * @param {object} o {rowHeight, overscan, renderRow(item, index)->HTMLElement|string, emptyText}
   */
  constructor(container, o) {
    this.container = container;
    this.opts = Object.assign({ rowHeight: 34, overscan: 8, renderRow: null, emptyText: '（空）' }, o || {});
    this.items = [];
    this.spacer = document.createElement('div');
    this.spacer.className = 'vs-spacer';
    this.win = document.createElement('div');
    this.win.className = 'vs-window';
    this.spacer.appendChild(this.win);
    container.innerHTML = '';
    container.appendChild(this.spacer);
    this._onScroll = () => this.render();
    container.addEventListener('scroll', this._onScroll, { passive: true });
    this._first = -1;
    this._last = -1;
    this.activeIndex = -1;
    this._suspended = 0;
  }

  static destroy(list) {
    if (!list) return;
    list.container.removeEventListener('scroll', list._onScroll);
  }

  setItems(items, keepScroll) {
    this.items = items || [];
    this.spacer.style.height = (this.items.length * this.opts.rowHeight) + 'px';
    this._first = -1; this._last = -1;
    this.win.innerHTML = '';
    if (!keepScroll) this.container.scrollTop = 0;
    this.render();
    return this;
  }

  render() {
    const rh = this.opts.rowHeight;
    const n = this.items.length;
    this.spacer.style.height = (n * rh) + 'px';
    if (!n) {
      const idx = this.items.length;
      void idx;
      if (!this.win.querySelector('.vs-empty')) {
        this.win.innerHTML = `<div class="loading vs-empty">${this.opts.emptyText}</div>`;
      }
      return;
    }
    const top = this.container.scrollTop;
    const h = this.container.clientHeight || 400;
    let first = Math.max(0, Math.floor(top / rh) - this.opts.overscan);
    let last = Math.min(n - 1, Math.ceil((top + h) / rh) + this.opts.overscan);
    if (first === this._first && last === this._last && this.win.childElementCount) return;
    this._first = first; this._last = last;
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
      const el = this._makeRow(this.items[i], i);
      el.style.position = 'absolute';
      el.style.top = (i * rh) + 'px';
      el.style.left = '0';
      el.style.right = '0';
      el.style.height = rh + 'px';
      el.dataset.index = String(i);
      frag.appendChild(el);
    }
    this.win.innerHTML = '';
    this.win.appendChild(frag);
    this._rendered = { first, last };
  }

  _makeRow(item, i) {
    const r = this.opts.renderRow ? this.opts.renderRow(item, i) : String(item);
    if (typeof r === 'string') {
      const d = document.createElement('div');
      d.innerHTML = r;
      return d.firstElementChild || d;
    }
    return r;
  }

  /** 滚动到某行（虚拟滚动下不能靠 scrollIntoView，得算 offsetTop）。 */
  scrollToIndex(i, center) {
    const rh = this.opts.rowHeight;
    const h = this.container.clientHeight || 400;
    const target = Math.max(0, (i * rh) - (center ? (h - rh) / 2 : 0));
    this.container.scrollTop = target;
    this.render();
    return this;
  }

  setActive(i, autoScroll) {
    const prev = this.activeIndex;
    this.activeIndex = i;
    // 只改可视窗口里的行；窗口外的行下次渲染时按 activeIndex 着色
    this.win.querySelectorAll('[data-index]').forEach((el) => {
      const k = Number(el.dataset.index);
      const on = k === i;
      if (el.classList.contains('active') !== on) el.classList.toggle('active', on);
    });
    if (autoScroll && i >= 0 && i !== prev) {
      const rh = this.opts.rowHeight;
      const top = this.container.scrollTop, h = this.container.clientHeight || 400;
      const rowTop = i * rh, rowBottom = rowTop + rh;
      if (rowTop < top) this.scrollToIndex(i);
      else if (rowBottom > top + h) this.scrollToIndex(i, true);
      else this.render();
    }
    return this;
  }

  /** 程序化滚动期间暂停自动跟随（用户手动滚动时不抢滚动条）。 */
  suspend(ms) {
    this._suspended = Date.now() + (ms || 3000);
    return this;
  }
  get suspended() { return Date.now() < this._suspended; }
}
