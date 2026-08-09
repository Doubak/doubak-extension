/**
 * 依赖方向。
 *
 * ## 这一条回答的问题是：改界面会不会弄坏抓取？
 *
 * 答案是「不会」，但**光靠约定的『不会』不值钱**——它只在每个人都记得的时候成立。
 * 这里把它变成机器检查的：
 *
 *   界面（src/ui）  →  可以用下面几层
 *   抓取 / 档案 / 存储 / 核心  →  **一个字都不许提界面**
 *
 * 方向一旦反过来，抓取就会因为界面的改动而变——而抓取是不可逆的那一步，
 * 它出的错没法靠重跑修好（`docs/DESIGN.md`、CLAUDE.md 都把这条列在最前面）。
 *
 * ## 为什么不是「跑一遍抓取看看还行不行」
 *
 * 那种测试有，而且很多（loop / runner / frontier / classifier / route-state
 * 各自成套）。但它们证明的是「今天的抓取代码对」，不是「界面动不了它」。
 * 真正让人敢改界面的是**依赖方向**：界面根本进不到那几层里去。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** @returns {string[]} src 下所有 .js 的相对路径 */
function allSources(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) allSources(p, out);
    else if (name.endsWith('.js')) out.push(relative(SRC, p));
  }
  return out;
}

/** 这个文件 import 了哪些路径。 */
function importsOf(rel) {
  const text = readFileSync(join(SRC, rel), 'utf-8');
  return [...text.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

describe('依赖方向', () => {
  /** 不可逆那一侧。它们出的错没法靠重跑修好。 */
  const CORE = ['crawl', 'bundle', 'core', 'storage', 'offscreen'];

  test('**抓取那几层一个字都不许提界面**', () => {
    const offenders = [];
    for (const rel of allSources()) {
      const layer = rel.split('/')[0];
      if (!CORE.includes(layer)) continue;
      for (const spec of importsOf(rel)) {
        if (/(^|\/)ui\//.test(spec)) offenders.push(`${rel} → ${spec}`);
      }
    }
    assert.deepEqual(offenders, [],
      `这些地方让抓取依赖了界面：\n${offenders.join('\n')}\n`
      + '方向反了之后，改一次界面就可能弄坏不可逆的那一步。');
  });

  test('界面用抓取层时，只能用不发请求的那些', () => {
    // 面板确实 import 了 crawl 里的两个模块（演练场景、事件日志的文案）。
    // 那是可以的——**只要它们是纯的**。一旦界面能顺着 import 摸到会发请求的
    // 东西，「打开面板」就可能变成「发起一次请求」。
    const impure = [];
    for (const spec of importsOf('ui/panel.js')) {
      const m = /^\.\.\/(crawl|bundle|offscreen)\/(.+)$/.exec(spec);
      if (!m) continue;
      const text = readFileSync(join(SRC, m[1], m[2]), 'utf-8');
      // 顶层的 fetch / chrome API 才算——写在函数里、由后台调用的不算。
      if (/\bfetch\s*\(/.test(text)) impure.push(`${spec}（含 fetch）`);
    }
    assert.deepEqual(impure, [],
      `面板顺着这些 import 摸到了会发请求的代码：\n${impure.join('\n')}`);
  });

  test('公共层不许反过来依赖上层', () => {
    // core / storage 是最底下两层。它们去 import crawl 的话，
    // 「这一层能不能单独测」就没了，而它们恰恰是被所有人用的。
    const offenders = [];
    for (const rel of allSources()) {
      const layer = rel.split('/')[0];
      if (layer !== 'core' && layer !== 'storage') continue;
      for (const spec of importsOf(rel)) {
        if (/(^|\/)(crawl|ui|offscreen)\//.test(spec)) offenders.push(`${rel} → ${spec}`);
      }
    }
    assert.deepEqual(offenders, [], `底层反过来依赖了上层：\n${offenders.join('\n')}`);
  });

  test('**这个检查本身不许是空的**', () => {
    // 目录改了名、或者正则写错了，上面三条会全部「通过」而其实一个文件都没看。
    const files = allSources();
    assert.ok(files.length > 40, `只扫到 ${files.length} 个源文件，像是路径不对`);
    const layers = new Set(files.map((f) => f.split('/')[0]));
    for (const l of [...CORE, 'ui']) {
      assert.ok(layers.has(l), `没扫到 ${l}/ 这一层`);
    }
    // 而且确实解析出了 import
    assert.ok(importsOf('ui/panel.js').length > 5, 'panel.js 的 import 没解析出来');
  });
});
