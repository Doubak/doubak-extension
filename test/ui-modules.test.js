/**
 * 面板拆成十个模块之后，守两件 `node --check` 看不出来的事。
 *
 * ## 为什么需要这份
 *
 * 面板是**浏览器代码**，测试里跑不起来。而拆文件最典型的错——某个函数用到的名字
 * 留在了原文件里、新文件没 import——语法是合法的，`node --check` 全绿，
 * 一直要到用户点开那个标签页才抛 ReferenceError。
 *
 * 这类错还特别容易漏：拆分本身「看起来没改任何逻辑」，于是人也不会去逐个点一遍。
 *
 * ## 两条判据
 *
 * **① 用到的名字必须真的在作用域里。** 本地声明、import 进来的、或者浏览器全局，
 * 三者之一。
 *
 * **② 依赖方向是单向的。** `shared` 谁也不 import，`archive` 只 import shared，
 * 以此类推。这条一破，拆分就白做了——那时它只是摊成十个文件的 panel.js，
 * 而「改导出会不会碰到抓取状态」又变回只能靠通读回答的问题。
 *
 * ## 判据①原来只看「后面跟着括号」的名字，于是漏了一条真的
 *
 * 第一版把引用位置写成 `/([A-Za-z_$][\w$]*)\s*\(/`——**只认函数调用**。而拆分漏掉的
 * 引用完全可以不是调用：
 *
 *     $('delete-this').addEventListener('click', async () => {
 *       if (!currentBundleId) return;          ← 没 import，也不是调用
 *
 * 存储页从档案页搬走了「删除这一份」，却没把 `currentBundleId` 一起带过来。语法合法、
 * 这份测试全绿、`npm test` 全绿——而用户点那个按钮时抛 ReferenceError。**恰好是这份
 * 测试存在的理由，却从它的判据缝里漏了过去。**
 *
 * 所以现在扫的是**全部引用位置**，代价是要把「看起来像标识符但其实不是引用」的几种
 * 形状挡掉：成员访问（`a.b`）、对象字面量的键（`{ b: 1 }`）、标签。挡漏了会造出假
 * 失败，而假失败会让人学会忽略这份测试——那比没有测试更糟。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'src/ui/panel';
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.js')).sort();

/**
 * 去掉注释、字符串、模板串与正则字面量——里面的东西不是代码。
 *
 * ## 为什么这里必须是扫描器，不能是几个 replace
 *
 * 第一版是四条正则，三种形状从缝里漏了出来，每一种都变成一条**假失败**：
 *
 * | 源码 | 漏出来的「名字」 |
 * |---|---|
 * | `` `豆备${m.version ? ` v${m.version}` : ''}` `` | `v` —— 模板串里嵌模板串，正则在内层那个反引号就收工了 |
 * | `/^https?:\/\//` | `https` —— 正则字面量根本没被认出来 |
 *
 * 假失败会让人学会忽略这份测试，那比没有测试更糟。而这三种形状在真实代码里都不
 * 罕见，靠「再加一条正则」补不完——它们是**嵌套**的，而正则不认嵌套。
 *
 * 逐字符走一遍就没有这个问题：模板串带一个 `${}` 深度栈，正则用「前一个有意义的
 * 字符」来和除号区分。换行保留，报错时行号才对得上。
 */
function code(text) {
  let out = '';
  let i = 0;
  /** `${}` 里还能再出现模板串，所以要记深度。 */
  const tmpl = [];
  /** 前一个非空白的输出字符，用来判断 `/` 是正则还是除号。 */
  let prev = '';
  const keep = (c) => { out += c; if (!/\s/.test(c)) prev = c; };
  const blank = (s) => { out += s.replace(/[^\n]/g, ' '); };

  while (i < text.length) {
    const c = text[i];
    const two = text.slice(i, i + 2);

    if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(text.slice(i, stop));
      i = stop;
    } else if (two === '//') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      blank(text.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'") {
      i = skipQuoted(text, i, c, keep);
    } else if (c === '`') {
      tmpl.push(0);
      keep('`');
      i = skipTemplate(text, i + 1, tmpl, keep, blank);
    } else if (c === '}' && tmpl.length && tmpl[tmpl.length - 1] === 0) {
      // `${…}` 收口，回到模板串的文本部分
      keep('}');
      i = skipTemplate(text, i + 1, tmpl, keep, blank);
    } else if (c === '/' && startsRegex(prev)) {
      i = skipRegex(text, i, keep);
    } else {
      if (c === '{' && tmpl.length) tmpl[tmpl.length - 1] += 1;
      if (c === '}' && tmpl.length && tmpl[tmpl.length - 1] > 0) tmpl[tmpl.length - 1] -= 1;
      keep(c);
      i += 1;
    }
  }
  return out;
}

/** `/` 前面是这些的时候它开一个正则，否则是除号。 */
function startsRegex(prev) {
  return prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev);
}

/** @returns {number} 引号串结束后的下标 */
function skipQuoted(text, i, quote, keep) {
  keep(quote);
  let j = i + 1;
  while (j < text.length && text[j] !== quote) {
    if (text[j] === '\\') j += 1;
    if (text[j] === '\n') break; // 未闭合，别把整个文件吞掉
    j += 1;
  }
  keep(quote);
  return j + 1;
}

/**
 * 从模板串的文本部分往下走，走到 `${` 或收尾的反引号。
 *
 * `${` 里面是**普通代码**，要交回主循环；栈顶记着「这层里还有几个没配对的 `{`」，
 * 好让主循环知道哪个 `}` 是回到文本、哪个只是普通花括号。
 */
function skipTemplate(text, i, tmpl, keep, blank) {
  let j = i;
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue; }
    if (text[j] === '`') { blank(text.slice(i, j)); keep('`'); tmpl.pop(); return j + 1; }
    if (text.slice(j, j + 2) === '${') { blank(text.slice(i, j)); keep('$'); keep('{'); return j + 2; }
    j += 1;
  }
  blank(text.slice(i, j));
  tmpl.pop();
  return j;
}

/** @returns {number} 正则字面量结束后的下标 */
function skipRegex(text, i, keep) {
  let j = i + 1;
  let inClass = false;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') break; // 未闭合，多半判错了；当除号处理
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { j += 1; break; }
    j += 1;
  }
  while (j < text.length && /[a-z]/.test(text[j])) j += 1; // 标志位
  keep('/');
  return j;
}

/**
 * 这个文件里所有「已经在作用域里」的名字。
 *
 * **宁可多收，不可少收**：漏收一个会造出一条假的失败，而假失败会让人学会忽略这份
 * 测试——那比没有测试更糟。所以任何位置的声明、参数、解构都算。
 */
function bound(src) {
  const out = new Set();
  const add = (s) => { for (const x of s.split(/[\s,{}[\]:]+/)) if (/^[A-Za-z_$][\w$]*$/.test(x)) out.add(x); };
  for (const m of src.matchAll(/^\s*import\s+\{([^}]*)\}/gm)) add(m[1].replace(/\bas\b/g, ' '));
  for (const m of src.matchAll(/^\s*import\s+(\w+)\s+from/gm)) out.add(m[1]);
  for (const m of src.matchAll(/(?:^|\s)(?:const|let|var)\s+([\w$]+|\{[^}]*\}|\[[^\]]*\])/g)) add(m[1]);
  for (const m of src.matchAll(/(?:async\s+)?function\s*\*?\s*([\w$]*)\s*\(([^)]*)\)/g)) { if (m[1]) out.add(m[1]); add(m[2]); }
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) add(m[1]);
  for (const m of src.matchAll(/([\w$]+)\s*=>/g)) out.add(m[1]);
  for (const m of src.matchAll(/catch\s*\(([^)]*)\)/g)) add(m[1]);
  for (const m of src.matchAll(/for\s*\(\s*(?:const|let|var)\s+(\[[^\]]*\]|\{[^}]*\}|[\w$]+)/g)) add(m[1]);
  return out;
}

/**
 * 这个文件里所有**引用**了的名字。
 *
 * 判据是反过来的：先当每个标识符都是引用，再把三种「长得像引用但不是」的挡掉。
 * 这个方向是刻意的——漏挡一种会造出假失败（吵，但看得见），而漏认一种引用会让
 * 真正的 ReferenceError 溜过去（静默，只在用户点那个按钮时才炸）。
 *
 * @param {string} src 已经去掉注释与字符串的源码
 */
function referenced(src) {
  const out = new Set();
  for (const m of src.matchAll(/([.?]?)\s*\b([A-Za-z_$][\w$]*)\b\s*(:?)/g)) {
    const [, before, name, colon] = m;

    // ① 成员访问：`a.b`、`a?.b`。`b` 是属性名，不是作用域里的名字。
    if (before === '.') continue;

    // ② 对象字面量的键与解构的重命名：`{ b: 1 }`、`{ b: x } = y`、`case 'a': `。
    //    要与三元的中项区分开——`cond ? b : c` 里的 `b` 是**引用**，只是后面
    //    恰好也跟着冒号。判据是往前看：键的前面是 `{` 或 `,`，三元的前面是 `?`。
    if (colon === ':') {
      const prev = src.slice(0, m.index).replace(/\s+$/, '').slice(-1);
      if (prev === '{' || prev === ',') continue;
    }
    out.add(name);
  }
  return out;
}

/** 浏览器 / 语言自带的。用到没列进来的会报出来——那时把它加上，而不是把判据关掉。 */
const GLOBALS = new Set(`
document window chrome console navigator location history performance
setTimeout setInterval clearTimeout clearInterval queueMicrotask requestAnimationFrame
alert confirm prompt fetch structuredClone
Promise Object Array String Number Boolean Math JSON Date Map Set WeakMap WeakSet
Error TypeError RangeError URL URLSearchParams Blob File FileReader
RegExp Symbol Proxy Reflect BigInt Intl Infinity NaN undefined globalThis
Uint8Array Int8Array Uint16Array Uint32Array Float32Array Float64Array ArrayBuffer DataView
TextEncoder TextDecoder AbortController Worker Response Request Headers
CompressionStream DecompressionStream crypto indexedDB caches
Element HTMLElement Node Event CustomEvent DOMParser
isNaN isFinite parseInt parseFloat encodeURIComponent decodeURIComponent escape unescape
if for while switch case default break continue return typeof instanceof new delete void
do else try catch finally throw yield await async function class const let var of in
super this import export from as static get set extends null true false with debugger
`.trim().split(/\s+/));

describe('面板模块', () => {
  test('模块是有的 —— 空目录不该悄悄算通过', () => {
    // 目录改名或路径写错时，下面的循环一个文件都不跑，而报告仍然全绿。
    assert.ok(FILES.length >= 8, `只找到 ${FILES.length} 个模块`);
    assert.ok(FILES.includes('shared.js'));
  });

  for (const f of FILES) {
    test(`${f}：**用到的名字都在作用域里**`, () => {
      const src = code(readFileSync(join(DIR, f), 'utf-8'));
      const known = bound(src);
      const missing = new Set();
      for (const name of referenced(src)) {
        if (!known.has(name) && !GLOBALS.has(name)) missing.add(name);
      }
      assert.deepEqual(
        [...missing], [],
        `${f} 里用到了没有在作用域里的名字。拆文件最典型的错就是这个：`
        + '语法合法、node --check 全绿，一直要到用户点开那个标签页才抛 ReferenceError',
      );
    });
  }

  test('**依赖方向是单向的** —— shared 谁也不 import，不许有环', () => {
    /** @type {Map<string, string[]>} */
    const deps = new Map();
    for (const f of FILES) {
      const src = readFileSync(join(DIR, f), 'utf-8');
      deps.set(f, [...src.matchAll(/from '\.\/([\w-]+\.js)'/g)].map((m) => m[1]));
    }
    assert.deepEqual(deps.get('shared.js'), [],
      'shared.js import 了同目录的东西 —— 它是底座，谁也不该认识');

    // 有环就说明「谁依赖谁」已经说不清了，而那正是拆分要消灭的状态。
    const seen = new Set(); const stack = new Set();
    const walk = (n, path) => {
      if (stack.has(n)) assert.fail(`依赖成环：${[...path, n].join(' → ')}`);
      if (seen.has(n)) return;
      seen.add(n); stack.add(n);
      for (const d of deps.get(n) ?? []) walk(d, [...path, n]);
      stack.delete(n);
    };
    for (const f of FILES) walk(f, []);
  });

  test('**panel.js 只剩一层壳** —— 它不该再长回三千行', () => {
    // 拆之前是 3034 行。壳里只有：模块文档、import、标签页切换、启动那几行。
    const lines = readFileSync('src/ui/panel.js', 'utf-8').split('\n').length;
    assert.ok(lines < 150, `panel.js 现在 ${lines} 行`);
  });
});
