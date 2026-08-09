/**
 * **offscreen document 里能用哪些 `chrome.*`——由这份测试执行，不再只是一段注释。**
 *
 * `src/offscreen/offscreen.js` 开头一直有一张表写着这条规则（`chrome.storage` ✗、
 * `chrome.permissions` ✗、`chrome.notifications` ✗、`chrome.runtime` ✓）。表是对的，
 * 但没有任何东西执行它——于是 `core/version.js` 里一句
 * `chrome.runtime.getManifest().version` 照样进了主干：
 *
 * - 面板里试是好的（面板是普通扩展页面，扩展 API 全都有）；
 * - `npm test` 是绿的（node:test 里连 `chrome` 都没有，那条路径根本不走）；
 * - 装上之后一按「开始抓取」就抛「拿不到 manifest.json 里的版本号」，**抓不了任何东西**。
 *
 * Chrome 的原话是 “only the chrome.runtime messaging APIs are exposed to the offscreen
 * document”。`getManifest` 不在其中。
 *
 * 这类 bug 的形状是固定的：**上下文能力差异，只在真浏览器里显形**。所以判据也只能是
 * 静态的——顺着 offscreen 的 import 图，把每个 `chrome.<命名空间>.<成员>` 调用点
 * 对照白名单查一遍。白名单之外的一律算违约，包括「看起来应该有」的那些。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

/**
 * offscreen document 里确实存在的 `chrome.*` 成员。
 *
 * 消息那几个是官方保证的。`getURL` 不是消息 API，但它**实测可用**——存档 Worker 就是
 * `new Worker(chrome.runtime.getURL('src/storage/opfs-rw-worker.js'))` 起来的，而档案
 * 确实写出来了。这条是「测出来的」，不是「推出来的」，所以单独列在这里并注明来源。
 *
 * 往这张表里加东西之前：**先在真浏览器的 offscreen 里验一次**。加错的代价不是报错，
 * 是一次装上才发现、且看起来毫无关联的失败。
 */
const ALLOWED = new Set([
  'chrome.runtime.sendMessage',
  'chrome.runtime.onMessage',
  'chrome.runtime.connect',
  'chrome.runtime.onConnect',
  'chrome.runtime.lastError',
  'chrome.runtime.id',
  'chrome.runtime.getURL',
]);

const ENTRY = 'src/offscreen/offscreen.js';

/**
 * 去掉块注释与行注释，**但保留行数**——报出来的 `文件:行号` 要能直接点开。
 * 块注释换成等量的换行，不是一个空格。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 再去掉字符串字面量——注释与文档里写着 `chrome.storage` 的地方不是调用点。
 *
 * **只用来找 `chrome.*`，不能用来找 import**：import 的路径本身就是字符串，
 * 一起抹掉的话 import 图会退化成只有入口一个文件，而那会让下面的检查全绿。
 */
function code(text) {
  return stripComments(text)
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/**
 * 从入口出发，顺着相对 import 收集所有可达模块。
 *
 * 只跟相对路径：这个项目零依赖，`import` 里不会出现别的东西。
 *
 * @returns {string[]} 仓库相对路径
 */
function reachableFrom(entry) {
  const seen = new Set();
  const queue = [normalize(entry)];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      queue.push(normalize(join(dirname(file), spec)));
    }
    // 动态 import 也算
    for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (m[1].startsWith('.')) queue.push(normalize(join(dirname(file), m[1])));
    }
  }
  return [...seen];
}

describe('offscreen document 的能力契约', () => {
  const modules = reachableFrom(ENTRY);

  test('import 图确实走通了 —— 判据不能是「一个文件都没查」', () => {
    // 这条挡的是最难看的失败方式：正则改坏了、入口改名了，于是一个模块都收集不到，
    // 下面那条测试自动变绿。绿得毫无理由的测试比没有测试更糟。
    assert.ok(modules.length > 20, `只从 ${ENTRY} 找到 ${modules.length} 个模块，不对`);
    assert.ok(modules.includes(normalize('src/crawl/runner.js')));
    assert.ok(modules.includes(normalize('src/core/version.js')));
  });

  test('**offscreen 可达的代码里，不许出现白名单以外的 `chrome.*`**', () => {
    /** @type {string[]} */
    const offenders = [];
    for (const file of modules) {
      const lines = code(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/\bchrome\s*\??\.\s*(\w+)\s*\??\.\s*(\w+)/g)) {
          const api = `chrome.${m[1]}.${m[2]}`;
          if (!ALLOWED.has(api)) offenders.push(`${file}:${i + 1}  ${api}`);
        }
      });
    }
    assert.deepEqual(
      offenders, [],
      'offscreen document 只暴露 chrome.runtime 的消息 API（外加实测可用的 getURL）。'
      + '这些调用在面板里是好的、在 node 测试里根本不走，装上之后才炸——'
      + '实测过一次：core/version.js 用了 chrome.runtime.getManifest()，于是抓取一步都开不了',
    );
  });

  test('白名单本身对得上 offscreen.js 开头那张表', () => {
    // 表和白名单是同一条规则的两个副本。副本会漂移，所以这里把它们钉在一起：
    // 表里判 ✗ 的命名空间，白名单里一个成员都不许有。
    const doc = readFileSync(ENTRY, 'utf8');
    for (const ns of ['storage', 'permissions', 'notifications']) {
      assert.match(doc, new RegExp(`chrome\\.${ns}[^|]*\\|\\s*\\*\\*✗\\*\\*`),
        `offscreen.js 开头那张表该写着 chrome.${ns} 不可用`);
      assert.ok(
        [...ALLOWED].every((a) => !a.startsWith(`chrome.${ns}.`)),
        `白名单里出现了 chrome.${ns}.*，与那张表矛盾`,
      );
    }
  });
});

describe('service worker 那一侧', () => {
  test('通知只在 service worker 里发 —— offscreen 发不了', () => {
    // 这条是上面那张表里「通知一律由 service worker 发」的另一半：光禁止不够，
    // 还得确认真有一个够得着 chrome.notifications 的地方在发。
    const notify = readFileSync('src/ui/notify.js', 'utf8');
    assert.match(notify, /chrome\.notifications\.create/);
    assert.ok(
      !reachableFrom(ENTRY).includes(normalize('src/ui/notify.js')),
      'ui/notify.js 被 offscreen 拉进去了 —— 它用的 chrome.notifications 在那里不存在',
    );
    assert.ok(
      reachableFrom('src/background.js').includes(normalize('src/ui/notify.js')),
      'service worker 够不着 notify.js 的话，就没人发得了通知',
    );
  });
});
