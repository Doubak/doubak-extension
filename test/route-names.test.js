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
import { readPanelSourceSync } from './helpers/fake-dom.js';
import assert from 'node:assert/strict';

import { routeName, hasRouteName, contiguityLabel } from '../src/ui/route-names.js';
import { buildRoutes, MEDIUMS } from '../src/crawl/routes.js';
import { readFile } from 'node:fs/promises';

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

describe('「连续性」那一列：进行中 ≠ 未验证', () => {
  /**
   * 真实档案里有这么一行：作品详情页因为一次**误判**的 `account_switched` 留下了
   * 缺口，于是永远不连续。抓取早就结束了，界面却写着「进行中」——等于让人一直等
   * 一件已经结束的事。
   */

  test('连续就是已验证，不管跑没跑完', () => {
    assert.equal(contiguityLabel({ contiguous: true, settled: false }), '✔ 已验证');
    assert.equal(contiguityLabel({ contiguous: true, settled: true }), '✔ 已验证');
  });

  test('还在跑 → 进行中', () => {
    assert.equal(contiguityLabel({ contiguous: false, settled: false }), '进行中');
  });

  test('抓完了有缺口 → 说结论「有 N 处缺口」，不说「未验证」', () => {
    // 「未验证」听起来像**我们的代码没查**，而其实查了，结论就是有缺口。
    // 这一列说的是档案怎么样，不是我们对自己的信心。
    assert.equal(
      contiguityLabel({ contiguous: false, settled: true, gaps: [{ reason: 'account_switched' }] }),
      '有 1 处缺口',
    );
    assert.equal(
      contiguityLabel({ contiguous: false, settled: true, gaps: [{}, {}, {}] }),
      '有 3 处缺口',
    );
  });

  test('**绝不写「已验证 · 有缺口」** —— 那是自相矛盾的', () => {
    // 「已验证」在这个项目里有确切含义：连续性证明成立。有缺口时它不成立。
    // 两个词并排放，读快一点就会看成「验证通过」——而假的完整性声明是这个项目
    // 最不能出的错。
    const s = contiguityLabel({ contiguous: false, settled: true, gaps: [{ reason: 'x' }] });
    assert.equal(s.includes('已验证'), false);
    assert.equal(s.includes('✔'), false);
  });

  test('抓完了、不连续、也没记缺口 → 「没走完」', () => {
    // 那不是缺口（没有断），是这条线压根没走到终点。别硬说成有洞。
    assert.equal(contiguityLabel({ contiguous: false, settled: true, gaps: [] }), '没走完');
  });

  test('覆盖率页与进度表用同一套说法', async () => {
    // 同一件事在两个页面上说成两样，用户会以为是两件事。
    const panel = readPanelSourceSync();
    assert.equal(
      panel.includes('连续性未验证'), false,
      '覆盖率页还在用自己那套措辞',
    );
    // 两处都走同一个函数
    assert.ok((panel.match(/contiguityLabel\(/g) ?? []).length >= 2);
  });

  test('抓完的档案里绝不会写「进行中」', () => {
    for (const gaps of [[], [{ reason: 'x' }]]) {
      assert.equal(
        contiguityLabel({ contiguous: false, settled: true, gaps }).includes('进行中'),
        false,
      );
    }
  });
});
