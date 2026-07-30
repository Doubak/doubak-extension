/**
 * manifest.json 与代码必须说同一件事。
 *
 * 权限清单是**用户看到的那份承诺**：安装时的警告文字就是从它生成的。所以它
 * 多一条少一条都不是小事——多一条是要了用不上的权力，少一条是运行时突然失败。
 *
 * 而它是一个 JSON 文件，没人会去 review 它有没有跟代码对上。所以让测试对。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import { REQUIRED_ORIGINS } from '../src/crawl/permissions.js';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf-8'));

/**
 * 去掉注释。
 *
 * 必须的：这些文件的注释里**正需要**写「offscreen 拿不到 chrome.storage，所以
 * 改用 IndexedDB」，而一个只会字符串匹配的检查会把那句解释本身当成「用到了
 * chrome.storage」，然后要求声明一条其实不需要的权限。
 *
 * @param {string} src
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

/** 把 src/ 与 selftest/ 下所有 js 拼起来，用来查 API 到底有没有被调用。 */
async function allSource() {
  /** @param {URL} dir */
  async function walk(dir) {
    let out = '';
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) out += await walk(new URL(`${e.name}/`, dir));
      else if (e.name.endsWith('.js')) out += stripComments(await readFile(new URL(e.name, dir), 'utf-8'));
    }
    return out;
  }
  return (await walk(new URL('src/', root))) + (await walk(new URL('selftest/', root)));
}
const source = await allSource();

/**
 * 每个权限对应哪个 API。用来双向核对：声明了要用得上，用到了要声明。
 *
 * `unlimitedStorage` 没有对应的 API 调用——它只是解除配额，所以单独判。
 */
const PERMISSION_API = {
  storage: /chrome[?.]*\.storage\b/,
  alarms: /chrome[?.]*\.alarms\b/,
  tabs: /chrome[?.]*\.tabs\.(query|get|update|remove|captureVisibleTab|sendMessage)\b/,
  notifications: /chrome[?.]*\.notifications\b/,
  offscreen: /chrome[?.]*\.offscreen\b/,
  declarativeNetRequest: /chrome[?.]*\.declarativeNetRequest\b/,
  webRequest: /chrome[?.]*\.webRequest\.\w+\.addListener\b/,
  downloads: /chrome[?.]*\.downloads\b/,
  cookies: /chrome[?.]*\.cookies\b/,
  scripting: /chrome[?.]*\.scripting\b/,
};

describe('manifest 权限', () => {
  test('声明的每一条都真的用得上', () => {
    for (const perm of manifest.permissions) {
      if (perm === 'unlimitedStorage') continue; // 没有对应 API，见下一条
      const re = PERMISSION_API[perm];
      assert.ok(re, `声明了 ${perm}，但这条测试不知道它对应哪个 API——补上映射再说`);
      assert.ok(re.test(source), `声明了 ${perm} 却没有任何代码用它。多要的权限要删掉`);
    }
  });

  test('用到的每个受限 API 都声明了权限', () => {
    for (const [perm, re] of Object.entries(PERMISSION_API)) {
      if (!re.test(source)) continue;
      assert.ok(
        manifest.permissions.includes(perm),
        `代码里用了需要 ${perm} 权限的 API，但 manifest 没声明——运行时会静默失败`,
      );
    }
  });

  test('没有 tabs 权限：它会换来一句「读取你的浏览历史」', () => {
    // `chrome.tabs.create({url})` **不需要** tabs 权限——那条权限只管
    // url/title/favIconUrl 这些敏感字段。而它换来的安装警告是「读取你的浏览
    // 历史」，对一个主打「数据不离开本地」的扩展是致命的观感问题。
    assert.equal(manifest.permissions.includes('tabs'), false);
    // 反过来也钉一下：真要读 tab 的敏感字段了，上面那条双向核对会红。
  });

  test('没有 web_accessible_resources：那会把扩展 ID 泄给任意网站', () => {
    // WAR 只在「网页或内容脚本要加载我们的资源」时才需要。我们没有内容脚本，
    // 面板与自检页都是通过 chrome-extension:// 直接打开的，压根不需要它。
    //
    // 而声明了它的代价很实：任何网站都能探测那个资源能不能加载，从而**判断
    // 用户装没装豆备**。对这个项目的用户群来说，「装了一个豆瓣备份工具」本身
    // 就是一条不该外泄的信号。
    assert.equal('web_accessible_resources' in manifest, false);
  });

  test('host_permissions 与代码里的 REQUIRED_ORIGINS 一字不差', () => {
    // 两处对不上的后果是不对称的：manifest 多了是白要权限；代码里多了则会
    // 让权限检查永远判「缺权限」，一次抓取都开不起来。
    assert.deepEqual([...manifest.host_permissions].sort(), [...REQUIRED_ORIGINS].sort());
  });

  test('只走 https', () => {
    // 会话 cookie 会跟着请求走。http 明文是不能接受的。
    for (const h of manifest.host_permissions) {
      assert.match(h, /^https:\/\//, `${h} 不是 https`);
    }
  });

  test('没有 <all_urls> 之类的过宽授权', () => {
    for (const h of manifest.host_permissions) {
      assert.equal(/^\*:\/\/|<all_urls>|^https:\/\/\*\/\*$/.test(h), false, `${h} 太宽了`);
    }
  });

  test('service worker 是 module 类型', () => {
    // 整个项目是原生 ES 模块、零构建步骤。不写 type:module 的话 import 直接崩。
    assert.equal(manifest.background.type, 'module');
  });

  test('storage.sync 一个字都不许出现在实现里', () => {
    // 约 100 KB 硬上限，还会跨设备同步。拿它放档案数据是灾难。
    // 只允许出现在解释「为什么不能用」的注释里。
    const uses = source.split('\n').filter((l) => l.includes('storage.sync') && !/^\s*(\*|\/\/)/.test(l));
    assert.deepEqual(uses, []);
  });
});
