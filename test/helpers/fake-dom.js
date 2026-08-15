/**
 * 一个刚够跑起界面脚本的假 DOM。
 *
 * ## 为什么值得写
 *
 * `src/ui/*.js` 一直是整个项目里唯一**没有任何执行覆盖**的部分——它们要 DOM，
 * 而 Node 里没有。于是它们只被 `node --check` 看过一眼，也就是只验了语法。
 *
 * 代价是实打实的。最近两个用户可见的故障都出在这里，而且都是语法完全正确的：
 *
 * 1. `preflightShown is not defined` —— 改 `renderRoutes` 时，替换区间连带把
 *    `showPreflight` 和它的变量一起删掉了，只留下引用。
 * 2. 预检结果写进了 `#routes`，与 `renderRoutes` 抢同一个容器。
 *
 * 两个都会在**第一次 `refresh()`** 时暴露。所以这个假 DOM 不追求完整，只追求
 * 一件事：**让界面脚本真的跑起来，并把 refresh 走一遍。**
 *
 * ## 刻意不做的
 *
 * 不实现布局、样式、事件冒泡、真正的选择器引擎。那些是浏览器的事，在这里做只会
 * 得到一个假的确信。`querySelectorAll` 只认界面代码实际用到的那几种形状——多认
 * 一种就多一处「测试里能过、浏览器里不行」的可能。
 *
 * DOM 元素的 id 从对应的 HTML 里**真的解析出来**：脚本里 `$('不存在的 id')` 会
 * 拿到 `null` 然后立刻炸，而那正是要抓的一类 bug。
 */

import { readFile, readdir } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';

class FakeElement {
  /** @param {string} tag */
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    /** @type {FakeElement | null} `remove()` 要靠它把自己摘下来。 */
    this.parentNode = null;
    this.dataset = {};
    this.style = { cssText: '', setProperty() {} };
    this.className = '';
    this._text = '';
    this.hidden = false;
    this.disabled = false;
    this.onclick = null;
    this.onchange = null;
    this.attributes = {};
    this.listeners = {};
    // 用一个捕获的局部变量，不要 `this._el`：箭头函数不重绑 `this`，所以那样
    // 写出来的 `this` 是元素本身，而元素上并没有 `_el`。
    const self = this;
    this.classList = {
      add: (c) => { self.className = `${self.className} ${c}`.trim(); },
      remove: (c) => {
        self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' ');
      },
      contains: (c) => self.className.split(/\s+/).includes(c),
    };
  }

  get textContent() {
    return this._text || this.children.map((c) => c.textContent).join('');
  }

  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }

  append(...nodes) {
    for (const n of nodes) {
      n.parentNode = this;
      this.children.push(n);
    }
  }

  appendChild(n) {
    n.parentNode = this;
    this.children.push(n);
    return n;
  }

  replaceChildren(...nodes) {
    this._text = '';
    for (const c of this.children) if (c.parentNode === this) c.parentNode = null;
    for (const n of nodes) n.parentNode = this;
    this.children = nodes;
  }

  /**
   * **真的从父节点上摘下来。**
   *
   * 原来只置了一个 `_removed` 标志，谁都没读——于是 `remove()` 之后节点还挂在
   * 树上，`textContent` 里照样有它。真实 DOM 不是这样，而这种「假的假 DOM」比
   * 没有测试更坏：它让一条真实存在的 bug 在测试里显得已经修好了。
   */
  remove() {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this.parentNode = null;
  }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }

  getAttribute(k) {
    return this.attributes[k] ?? null;
  }

  /**
   * 真实元素有这个方法，这里原来没有——于是面板里一句 `removeAttribute` 就让
   * **整条渲染路径**抛错，而页面上显示的是「读不出这个档案」。
   *
   * 这类缺口的坏处不在于少个方法，在于**报错报到了别处**：看起来像档案坏了。
   */
  removeAttribute(k) {
    delete this.attributes[k];
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  /** 只支持界面代码实际用到的形状。见文件开头。 */
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children ?? []) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }

  closest(sel) {
    return matches(this, sel) ? this : null;
  }

  /** 触发一个已注册的监听器。测试用来模拟点击。 */
  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
}

/** @param {FakeElement} el @param {string} sel */
function matches(el, sel) {
  // `.cls`。组件层（components.js）用类名找元素，所以这一种也得认。
  // **只支持单个类名**，不支持 `.a .b` 这种组合——多认一种就多一处
  // 「测试里能过、浏览器里不行」的可能。
  if (/^\.[\w-]+$/.test(sel)) {
    if (!el.className) return false;
    return String(el.className).split(/\s+/).includes(sel.slice(1));
  }
  // `tag[data-x]`
  const attr = /^(\w+)\[([\w-]+)\]$/.exec(sel);
  if (attr) {
    const key = dataKey(attr[2]);
    return el.tagName === attr[1].toUpperCase() && el.dataset[key] !== undefined;
  }
  // `[data-x="y"]`，可带标签名前缀。界面用它找「表格下面那行小字」。
  const eq = /^(\w*)\[([\w-]+)=["']?([^"'\]]*)["']?\]$/.exec(sel);
  if (eq) {
    // 文本节点没有 tagName / dataset。不带标签名前缀的选择器会走到这里，
    // 所以要先挡住——真实 DOM 里 querySelector 本来就只看元素。
    if (!el.dataset) return false;
    if (eq[1] && el.tagName !== eq[1].toUpperCase()) return false;
    return el.dataset[dataKey(eq[2])] === eq[3];
  }
  return el.tagName === sel.toUpperCase();
}

/** `data-role` → `role`，并把连字符转成驼峰，与真实 `dataset` 一致。 */
function dataKey(name) {
  return name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

class FakeTextNode {
  constructor(text) {
    this._text = String(text);
    this.children = [];
  }
  get textContent() {
    return this._text;
  }
}

/**
 * 装好一套假的浏览器全局，返回收拾现场的函数。
 *
 * @param {object} opts
 * @param {string} opts.html  对应的 HTML，用来抽出真实存在的 id
 * @param {(msg: object) => any} [opts.onMessage]  扮演 service worker
 * @param {object} [opts.extra]  额外的全局
 */
export async function installFakeDom({ html, onMessage = () => ({ ok: true }), extra = {} }) {
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

  /** @type {Map<string, FakeElement>} */
  const byId = new Map();
  for (const id of ids) {
    // 标签名尽量取对：`renderRoutes` 会往 `#routes` 里放 <table>，而
    // `querySelector('table')` 得找得到它。
    const el = new FakeElement('div');
    el.id = id;
    byId.set(id, el);
  }

  const saved = {};
  /**
   * 有些全局（`navigator`）在 Node 里是只有 getter 的存取器属性，直接赋值会抛。
   * 所以走 `defineProperty`，并把原本的描述符原样收好以便还原。
   */
  const set = (k, v) => {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k) ?? null;
    Object.defineProperty(globalThis, k, {
      value: v, writable: true, configurable: true, enumerable: true,
    });
  };

  const document = {
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (t) => new FakeTextNode(t),
    hidden: false,
  };

  /** @type {object[]} */
  const sent = [];
  const chrome = {
    runtime: {
      sendMessage: (msg, cb) => {
        sent.push(msg);
        const r = onMessage(msg);
        // 界面用的是回调式；没有回调就当 promise 式。
        if (typeof cb === 'function') {
          Promise.resolve(r).then(cb);
          return undefined;
        }
        return Promise.resolve(r);
      },
      getURL: (p) => `chrome-extension://fake/${p}`,
      onMessage: { addListener: () => {} },
      lastError: undefined,
    },
    tabs: { create: async () => {} },
  };

  set('document', document);
  set('chrome', chrome);
  set('window', { showDirectoryPicker: undefined, ...(extra.window ?? {}) });
  set('navigator', {
    storage: { estimate: async () => ({ usage: 0, quota: 100e9 }) },
    ...(extra.navigator ?? {}),
  });
  // 默认是个空壳：不发消息、不答复。**够用是因为大多数测试根本不碰存储**，而一个
  // 会答复的假 Worker 要拖进整个 OPFS RPC。碰存储的那几条自己传一个进来
  // （`helpers/fake-opfs-worker.js`）——不传的话 `WorkerFileStore` 的 Promise 永远
  // 不落地，测试会挂住而不是失败，那比失败难查得多。
  set('Worker', extra.Worker ?? class {
    constructor() { this.postMessage = () => {}; }
    addEventListener() {}
  });
  set('alert', () => {});
  set('confirm', () => false);
  // 界面会起一个 2 秒轮询。测试里不让它自己跑（那会让断言与时间赛跑），
  // 但把回调收下来——「第二次刷新」正是要靠它手动触发。
  /** @type {Function[]} */
  const timers = [];
  set('setInterval', (fn) => {
    timers.push(fn);
    return timers.length;
  });

  return {
    byId,
    sent,
    document,
    chrome,
    /** 手动跑一次界面的轮询回调，等它落定。 */
    async tick() {
      for (const fn of timers) await fn();
      await new Promise((r) => setTimeout(r, 5));
    },
    restore() {
      for (const [k, desc] of Object.entries(saved)) {
        if (desc) Object.defineProperty(globalThis, k, desc);
        else delete globalThis[k];
      }
    },
  };
}

/** @param {string} rel 相对仓库根 */
export function readRepoFile(rel) {
  return readFile(new URL(`../../${rel}`, import.meta.url), 'utf-8');
}

/**
 * 面板的**全部源码**：壳加它底下那十个模块，拼成一段。
 *
 * 面板从一个 3034 行的文件拆成了 `panel.js` + `panel/*.js`，而这些断言问的是
 * 「面板里有没有这段逻辑」，不是「它在哪个文件里」。写死某一个文件会把断言绑在
 * 当前这一种拆法上——那样每挪一个函数就要改一片测试，而那恰好是拆分想避免的事。
 */
export async function readPanelSource() {
  const dir = new URL('../../src/ui/panel/', import.meta.url);
  const names = (await readdir(dir)).filter((f) => f.endsWith('.js')).sort();
  const parts = await Promise.all([
    readFile(new URL('../../src/ui/panel.js', import.meta.url), 'utf-8'),
    ...names.map((f) => readFile(new URL(f, dir), 'utf-8')),
  ]);
  return parts.join('\n');
}

/** `readPanelSource()` 的同步版：`describe` 体里没法 await。 */
export function readPanelSourceSync() {
  const dir = new URL('../../src/ui/panel/', import.meta.url);
  const names = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  return [
    readFileSync(new URL('../../src/ui/panel.js', import.meta.url), 'utf-8'),
    ...names.map((f) => readFileSync(new URL(f, dir), 'utf-8')),
  ].join('\n');
}
