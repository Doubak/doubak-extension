/**
 * 自检页的两条约束 —— 用源码钉住，因为它在 Node 里跑不到。
 *
 * ## 为什么需要
 *
 * `selftest/` 是这个项目里覆盖面最尴尬的一块：**它会随扩展发布**
 * （`tools/package.mjs` 的 INCLUDE 里有它，调试页有个按钮真的会打开它），
 * 但**没有任何 Node 测试或 CI 作业进入过它**。于是它可以静默腐坏很久。
 *
 * 实测的两处腐坏，都是 2026-09-09 才被人手动点开才发现的：
 *
 * - **`new BundleWriter({...})` 少了 `producer`。** `bundle-writer.js` 从
 *   `ce1c10e`（2026-08-09）起要求它，那次提交改了 **11 个 test 文件**、新增了
 *   `test/helpers/producer.js`，**`selftest/` 一个都没动**。此后 115 次提交，
 *   自检页一直在第 51 项上中断，而中断点后面正是它存在的理由——
 *   「完整的 bundle 写入与崩溃恢复」，Node 测不到的那部分。
 * - **发出去的包里，自检页的 Worker 在加载时就死了。** 它 import 了
 *   `../test/helpers/*`，而 `test/` 整个不进包。本地一切正常，因为开发时载入的是
 *   仓库根目录，`test/` 就在旁边——**这个 bug 只在打好的包里存在，而那正是用户拿到的**。
 *
 * 两条都不是「逻辑写错了」，是**接线断了而没人走那条线**。所以检查也只能是静态的。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = new URL('../', import.meta.url);
const ROOT = dirname(fileURLToPath(new URL('package.json', root)));

/** @param {string} rel */
const read = (rel) => readFileSync(new URL(rel, root), 'utf-8');

/** 去掉注释再查——注释里正需要解释这些规则本身。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

const selftestFiles = readdirSync(new URL('selftest/', root)).filter((f) => f.endsWith('.js'));

describe('自检页：写档案必须给 producer', () => {
  test('扫得到 selftest 的 js', () => {
    // 正则坏掉时这条测试会变成一个空循环，然后**永远绿**。
    assert.ok(selftestFiles.length > 0, '没找到 selftest 的 js，这组测试失去了意义');
  });

  test('每一处 new BundleWriter 都带 producer', () => {
    let seen = 0;
    for (const f of selftestFiles) {
      const src = stripComments(read(`selftest/${f}`));
      // 从 `new BundleWriter({` 起到配对的 `})` 为止。这些调用点都是多行对象
      // 字面量，所以按括号配平切，不按行数猜。
      for (let at = src.indexOf('new BundleWriter('); at >= 0; at = src.indexOf('new BundleWriter(', at + 1)) {
        seen += 1;
        let depth = 0;
        let end = at;
        for (let i = src.indexOf('(', at); i < src.length; i++) {
          if (src[i] === '(') depth += 1;
          else if (src[i] === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
        }
        const call = src.slice(at, end + 1);
        assert.match(
          call,
          /\bproducer\b/,
          `selftest/${f} 里有一处 new BundleWriter 没传 producer —— `
          + '自检会在那里中断，而它后面正是 Node 测不到的那部分',
        );
      }
    }
    assert.ok(seen >= 2, `只找到 ${seen} 处 new BundleWriter，判据多半是坏的`);
  });

  test('**不许用测试里那个假版本号**，要走真实的 extensionVersion', () => {
    // 自检页存在的理由是「在真实浏览器里走真实路径」。塞一个常量进去，
    // 这一段就成了假路径——而 `extensionVersion()` 自己就出过事（第一版用
    // `chrome.runtime.getManifest()`，面板里好好的，装上之后每次抓取第一下就失败）。
    const src = read('selftest/worker.js');
    assert.match(src, /extensionVersion/, '自检该走真实的版本号来源');
    assert.doesNotMatch(
      stripComments(src),
      /TEST_PRODUCER/,
      '自检不该用测试常量顶替真实版本号',
    );
  });
});

describe('自检页：发出去的包里也得能跑', () => {
  /**
   * **问打包脚本本身要清单，不要在这儿重算一遍。**
   *
   * 第一版是照着 `package.mjs` 的源码重建了一份「哪些会进包」的模型，而它
   * **不可能失败**：模型读的是名单里的字符串，而同样两个路径在守卫的白名单里也
   * 写着一遍，所以把它们从 `INCLUDE` 里删掉照样全绿。突变验出来的，正是这个文件
   * 开头说的那种「接线断了而没人走那条线」——只不过这次断在测试自己身上。
   *
   * `tools/package.mjs --list` 是现成的（`test/version.test.js` 已经这么用），
   * 它吐的是**真的会被打进 zip 的那份清单**，没有中间模型可漂。
   */
  const listFiles = () => {
    let out;
    try {
      out = execFileSync('node', ['tools/package.mjs', '--list'], { encoding: 'utf8', cwd: ROOT });
    } catch (e) {
      assert.fail(`打包脚本自己就没通过：\n${e.stderr || e.message}`);
    }
    return out.split('\n').filter((l) => l && !l.includes('个文件'));
  };

  test('selftest 引的每一个相对模块，真的都在包里', () => {
    const shipped = new Set(listFiles());
    assert.ok(shipped.size > 50, `清单只有 ${shipped.size} 个文件，多半没取到`);

    let checked = 0;
    for (const f of selftestFiles) {
      const src = stripComments(read(`selftest/${f}`));
      for (const m of src.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)) {
        const rel = m[1];
        const abs = join(ROOT, 'selftest', rel);
        const fromRoot = abs.slice(ROOT.length + 1).split('\\').join('/');
        checked += 1;
        assert.ok(
          shipped.has(fromRoot),
          `selftest/${f} 引了 ${rel}（即 ${fromRoot}），但它不在打包清单里。`
          + '发出去的包里这个 import 会失败，自检页的 Worker 在加载时就死——'
          + '而本地永远看不出来，因为开发时载入的是仓库根目录。',
        );
      }
    }
    assert.ok(checked >= 5, `只查了 ${checked} 个 import，判据多半是坏的`);
  });
});
