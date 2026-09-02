/**
 * **`_locales` 的契约——由这份测试执行，因为破坏它的每一种方式都不在本地显形。**
 *
 * `manifest.json` 里的名字、短名、说明和图标提示都写成了 `__MSG_键名__`，真正的字
 * 在 `_locales/<语言>/messages.json` 里。这样做只有一个理由：**Chrome 应用商店的
 * 标题和摘要取自 manifest，控制台里改不了**，而分语言的商店页是按扩展带了哪些
 * `_locales/<语言>` 目录开出来的。繁体不是简体的变体——「備份」和「备份」是两个
 * 完全不同的字串，搜不到彼此。
 *
 * 三种破坏方式，一种都不会在 `npm test` 之外的地方报错：
 *
 * 1. **少一个语言目录里的某个键。** Chrome 悄悄回退到 `default_locale`，于是英文
 *    商店页上出现一行中文标题。没有报错，只有一个看起来像发错了的页面。
 * 2. **`_locales` 没进打包白名单。** `tools/package.mjs` 的 `collect()` 只在名单里
 *    的路径**不存在**时才抛；名单里压根没有的目录它不看。于是本地一切正常，包传上去
 *    Chrome **整个拒绝加载**——而那时名字已经改了，上一版还在线上。
 * 3. **超长。** name 上限 75、description 上限 132（Chrome 官方文档）。超了不是
 *    截断，是提交被拒。中文一个字算一个字符，英文一个字母也算一个，所以英文那份最紧。
 *
 * 这与 `offscreen-contract.test.js` 是同一类检查：出问题的上下文（真实浏览器、
 * 商店审核）本地进不去，所以判据只能是静态的，而且**必须断言自己确实扫到了东西**。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = join(ROOT, '_locales');

/** Chrome 的硬上限，见 manifest 的 name / description 文档。 */
const LIMITS = { extName: 75, extDescription: 132 };

/** 少于这个数就是扫描坏了，而不是真的只剩这么点。 */
const MIN_LOCALES = 3;
const MIN_KEYS = 4;

const manifestRaw = readFileSync(join(ROOT, 'manifest.json'), 'utf-8');
const manifest = JSON.parse(manifestRaw);
const locales = readdirSync(LOCALES).filter((d) => !d.startsWith('.')).sort();
const messages = Object.fromEntries(
  locales.map((l) => [l, JSON.parse(readFileSync(join(LOCALES, l, 'messages.json'), 'utf-8'))]),
);

describe('_locales', () => {
  test('扫到的语言和键都不该少于下限 —— 否则这一整份测试是空转的', () => {
    assert.ok(locales.length >= MIN_LOCALES,
      `只找到 ${locales.length} 个语言目录，少于 ${MIN_LOCALES}：是扫描坏了，不是真的少了`);
    for (const [l, m] of Object.entries(messages)) {
      assert.ok(Object.keys(m).length >= MIN_KEYS, `${l} 只有 ${Object.keys(m).length} 个键`);
    }
  });

  test('manifest 里每一个 __MSG__ 引用，在**每一个**语言里都得有', () => {
    const refs = [...manifestRaw.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((m) => m[1]);
    assert.ok(refs.length > 0, 'manifest 里一个 __MSG__ 都没有：本地化被摘掉了？');
    for (const key of new Set(refs)) {
      for (const [l, m] of Object.entries(messages)) {
        assert.ok(m[key]?.message, `${l} 缺 ${key} —— Chrome 会回退到 ${manifest.default_locale}，`
          + '于是英文商店页上出现一行中文，而且不报错');
      }
    }
  });

  test('各语言的键集完全一致', () => {
    const [first, ...rest] = locales;
    const want = Object.keys(messages[first]).sort();
    for (const l of rest) {
      assert.deepEqual(Object.keys(messages[l]).sort(), want, `${l} 与 ${first} 的键集对不上`);
    }
  });

  test('default_locale 指的目录必须真的在', () => {
    assert.ok(manifest.default_locale, 'manifest 里没有 default_locale，但用了 __MSG__');
    assert.ok(existsSync(join(LOCALES, manifest.default_locale)),
      `default_locale 是 ${manifest.default_locale}，但 _locales 下没有这个目录`);
  });

  test('**可本地化的字段必须还是 __MSG__** —— 写死一个就等于关掉分语言的标题', () => {
    // 这是最容易在合并冲突里被「修好」的一处：写死之后本地一切正常，商店页也照开，
    // 只是繁体和英文那两页的标题变成了简体中文——而那正是开这两页的唯一理由。
    const localizable = {
      name: manifest.name,
      short_name: manifest.short_name,
      description: manifest.description,
      'action.default_title': manifest.action?.default_title,
    };
    for (const [field, value] of Object.entries(localizable)) {
      assert.match(String(value), /^__MSG_[A-Za-z0-9_]+__$/,
        `manifest.${field} 写死成了 ${JSON.stringify(value)}：`
        + '商店标题取自 manifest，写死之后每种语言都是同一个字串');
    }
  });

  test('长度不超 Chrome 的上限 —— 超了是提交被拒，不是截断', () => {
    for (const [l, m] of Object.entries(messages)) {
      for (const [key, max] of Object.entries(LIMITS)) {
        // 缺键由上面那条测试点名；这里不让它崩成 TypeError，否则报出来的原因是错的。
        const msg = m[key]?.message;
        if (msg === undefined) continue;
        assert.ok(msg.length <= max, `${l} 的 ${key} 有 ${msg.length} 个字符，上限 ${max}`);
      }
    }
  });

  test('每条都要写 description —— 它是给翻译的人看的，这里也是写下「为什么这么写」的地方', () => {
    for (const [l, m] of Object.entries(messages)) {
      for (const [key, v] of Object.entries(m)) {
        assert.ok(v.description?.trim(), `${l} 的 ${key} 没有 description`);
      }
    }
  });

  test('**`_locales` 必须在打包白名单里** —— 漏了的话 Chrome 整个不加载', () => {
    const pkg = readFileSync(join(ROOT, 'tools/package.mjs'), 'utf-8');
    const include = pkg.match(/const INCLUDE = \[([\s\S]*?)\]/);
    assert.ok(include, "package.mjs 里找不到 INCLUDE —— 白名单被改名了，这条检查已经空转");
    assert.ok(/'_locales'/.test(include[1]),
      '_locales 不在 INCLUDE 里：collect() 只在名单里的路径不存在时才抛，'
      + '名单里没有的目录它根本不看，所以本地全绿、上传被拒');
  });
});
