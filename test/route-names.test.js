/**
 * 界面上不许出现内部路线标识。
 *
 * 报上来的样子：
 *
 * ```
 * 舞台剧 · 看过         0    —    进行中
 * interest.drama.wish   0    —    进行中
 * 游戏 · 玩过          15    2023-08-13
 * interest.game.do     14    2019-11-16
 * ```
 *
 * 五条漏网：`interest.drama.wish`、`interest.game.do`、`interest.game.wish`、
 * `interest.music.do`、`interest.music.wish`——都是 15 条标记列表里不那么常用的
 * 状态，也正是手写名字表时想不起来的那几个。
 *
 * 路线是**生成**的（媒介 × 状态），名字原来是手抄的。这条测试把两边钉在一起：
 * `buildRoutes()` 吐出来的每一个 key 都必须有中文名。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { routeName, hasRouteName } from '../src/ui/route-names.js';
import { buildRoutes, MEDIUMS } from '../src/crawl/routes.js';

describe('每一条真实路线都有中文名', () => {
  test('全量抓取里没有一条露出内部标识', () => {
    const routes = buildRoutes({ username: 'example', includeCatalog: true });
    const naked = routes.map((r) => r.key).filter((k) => !hasRouteName(k));
    assert.deepEqual(naked, [], `这些路线在界面上会显示成内部标识：${naked.join('、')}`);
  });

  test('逐条媒介单独抓时也一样', () => {
    for (const medium of MEDIUMS) {
      const routes = buildRoutes({ username: 'example', mediums: [medium], includeCatalog: true });
      const naked = routes.map((r) => r.key).filter((k) => !hasRouteName(k));
      assert.deepEqual(naked, [], `${medium}：${naked.join('、')}`);
    }
  });

  test('名字里不含点号分隔的内部标识', () => {
    for (const r of buildRoutes({ username: 'example', includeCatalog: true })) {
      assert.equal(/^[a-z_]+\./.test(routeName(r.key)), false, r.key);
    }
  });
});

describe('状态词跟着媒介走', () => {
  test('书是「读过」，不是「看过」', () => {
    assert.equal(routeName('interest.book.collect'), '书 · 读过');
    assert.equal(routeName('interest.book.do'), '书 · 在读');
    assert.equal(routeName('interest.book.wish'), '书 · 想读');
  });

  test('音乐是「听过」，游戏是「玩过」', () => {
    assert.equal(routeName('interest.music.collect'), '音乐 · 听过');
    assert.equal(routeName('interest.music.do'), '音乐 · 在听');
    assert.equal(routeName('interest.game.do'), '游戏 · 在玩');
    assert.equal(routeName('interest.game.wish'), '游戏 · 想玩');
  });

  test('那五条漏网的现在都有名字了', () => {
    // 这几个是照着报上来的截图列的。
    for (const k of [
      'interest.drama.wish', 'interest.game.do', 'interest.game.wish',
      'interest.music.do', 'interest.music.wish',
    ]) {
      assert.ok(hasRouteName(k), k);
    }
  });
});

describe('认不出来的原样返回', () => {
  test('不编一个「未知路线」出来', () => {
    // 丑是能被看见的 bug，「未知路线」则彻底断了线索——而这一行本来是给人
    // 排查用的。
    assert.equal(routeName('something.new'), 'something.new');
    assert.equal(hasRouteName('something.new'), false);
  });

  test('媒介认识但状态不认识 → 不硬拼', () => {
    assert.equal(routeName('interest.movie.borrowed'), 'interest.movie.borrowed');
  });
});
