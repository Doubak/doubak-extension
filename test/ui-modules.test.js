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
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'src/ui/panel';
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.js')).sort();

/** 去掉注释与字符串——里面的东西不是代码。 */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
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
Element HTMLElement Node Event CustomEvent DOMParser
isNaN isFinite parseInt parseFloat encodeURIComponent decodeURIComponent escape unescape
if for while switch return typeof instanceof new delete void do else try catch finally
throw yield await async function class const let var of in super this
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
      // 调用位置的名字。前面是 `.` 的是成员访问，不算。
      for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = m[2];
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
