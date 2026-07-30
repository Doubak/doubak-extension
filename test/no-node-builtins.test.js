/**
 * 浏览器要加载的东西里不许出现 `node:` 内置模块。
 *
 * ## 为什么值得一条专门的测试
 *
 * 因为**它的失败信息是空的**。
 *
 * `import 'node:assert'` 在浏览器里会让整个模块加载失败。如果那是一个 module
 * Worker，失败以 `ErrorEvent` 的形式抛出来，而那个事件上**什么有用信息都没有**——
 * 自检页只能显示：
 *
 * ```
 * Worker 出错：undefined
 * ```
 *
 * 没有文件名、没有行号、没有原因。这件事真的发生过：往
 * `test/helpers/kv-store-contract.js` 里加了一行 `import assert from
 * 'node:assert/strict'`，那个文件同时被 Node 测试和浏览器自检引用，于是整个自检
 * Worker 挂掉，而唯一的线索是 `undefined`。代价是一整轮往返。
 *
 * Node 那侧永远不会红——那里 `node:assert` 当然能用。所以只能在源码层面拦。
 *
 * ## 拦的范围
 *
 * `src/` 全部（扩展代码，只跑在浏览器里），加上 `selftest/` 及其**传递依赖**——
 * 后者是关键：出问题的文件在 `test/helpers/` 下，只扫 `selftest/` 目录扫不到它。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

/** @param {string} rel */
const read = (rel) => readFile(new URL(rel, root), 'utf-8');

/** @param {string} dir @param {string} prefix */
async function walk(dir, prefix) {
  /** @type {string[]} */
  const out = [];
  for (const e of await readdir(new URL(dir, root), { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...(await walk(`${dir}${e.name}/`, `${prefix}${e.name}/`)));
    else if (e.name.endsWith('.js')) out.push(`${prefix}${e.name}`);
  }
  return out;
}

/** 抽出一个文件的 import 说明符。 */
function importsOf(src) {
  return [...src.matchAll(/(?:^|\s)(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/**
 * 从若干入口出发，把**传递闭包**里的所有本地文件收齐。
 *
 * 只跟相对路径：`node:` 与裸包名不是文件，跟不下去（也正是要报告的东西）。
 *
 * @param {string[]} entries  相对仓库根
 */
async function closureFrom(entries) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const queue = [...entries];

  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);

    let src;
    try {
      src = await read(rel);
    } catch {
      continue; // 引到了不存在的文件，交给别的检查去管
    }
    for (const spec of importsOf(src)) {
      if (!spec.startsWith('.')) continue;
      queue.push(new URL(spec, new URL(rel, root)).pathname.slice(root.pathname.length));
    }
  }
  return [...seen];
}

describe('浏览器加载的代码里不许有 node: 内置模块', () => {
  test('src/ 全部干净', async () => {
    // 扩展代码只跑在浏览器里。这里出现 `node:` 一定是错的。
    for (const f of await walk('src/', 'src/')) {
      for (const spec of importsOf(await read(f))) {
        assert.equal(
          spec.startsWith('node:'),
          false,
          `${f} 引了 ${spec} —— 浏览器里加载不了，而失败信息会是空的`,
        );
      }
    }
  });

  test('selftest/ 及其传递依赖全部干净', async () => {
    // **传递闭包**是关键：出问题的那次，违规文件在 test/helpers/ 下，
    // 只扫 selftest/ 目录根本扫不到。
    const entries = await walk('selftest/', 'selftest/');
    const closure = await closureFrom(entries);

    // 起码要跟出目录之外的东西，否则这条测试等于只扫了 selftest/
    assert.ok(
      closure.some((f) => f.startsWith('test/helpers/')),
      '闭包没跟进 test/helpers/ —— 这条测试没在做它该做的事',
    );

    for (const f of closure) {
      for (const spec of importsOf(await read(f))) {
        assert.equal(
          spec.startsWith('node:'),
          false,
          `${f} 引了 ${spec}，而它被 selftest 加载 —— Worker 会挂掉，且报不出原因`,
        );
      }
    }
  });

  test('共享契约文件自带断言，不依赖任何 import', async () => {
    // 它们同时被 Node 测试与浏览器自检引用，所以只能自给自足。
    for (const f of ['test/helpers/file-store-contract.js', 'test/helpers/kv-store-contract.js']) {
      const src = await read(f);
      assert.deepEqual(importsOf(src), [], `${f} 不该有任何 import —— 它要在浏览器里也能加载`);
      // 自带断言，而不是静默通过
      assert.match(src, /throw new Error/, `${f} 里没有任何断言？`);
    }
  });
});
