/**
 * 本人的长文：日记与评论。
 *
 * ## 这两条路线此前一条都没抓过
 *
 * CLAUDE.md 把抓取顺序按「补不回来的程度」排：广播 → **本人长文** → 本人上传的图 →
 * 标记列表 → 作品详情页。而真实档案里排第 4、5 的早就抓完了，排第 2 的一个字节都没有。
 *
 * 原因是 `buildUnverifiedApiRoutes()` 定义了四条 Rexxar 接口路线、还有测试，
 * **但生产代码里从来没被调用过**——它是死代码。而且它自己的注释就写着「URL 抄自 tofu，
 * 未经核对，Rexxar 是未公开接口，随时可能变」。
 *
 * 这里改走普通 HTML 页面：入口 URL 是从真实档案的个人主页上读出来的，判定锚点是对着
 * 真实页面量出来的。
 *
 * ## 两条路线不是同一种东西
 *
 * | | 日记 | 评论 |
 * |---|---|---|
 * | 声明数量 | **没有**（`<h1>我的日记</h1>`） | 有（`<h1>我的评论(2)</h1>`） |
 * | 条目 id | 得从标题锚上取 | **就在容器上** |
 * | 第三方内容 | 侧栏有 6 篇别人的日记 | 整页只有本人 |
 *
 * 日记那条没有第二个信号可以对账，完整性**只能**靠连续性证明——这也是下面那条
 * 「不许扫到侧栏」的测试为什么重要：多抽一条会污染 `captured_count`，而那边没有
 * `claimed_count` 能把它比出来。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  profileForRoute,
  classifyResponse,
  extractItemIds,
  extractItemTimes,
  extractClaimedCount,
} from '../src/crawl/classifier.js';
import { buildRoutes, PRIORITY } from '../src/crawl/routes.js';
import { routeName } from '../src/ui/route-names.js';

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf-8');
const NOTES = () => fixture('notes-list.html');
const REVIEWS = () => fixture('reviews-list.html');

const classify = (key, html, url) =>
  classifyResponse({
    finalUrl: url,
    status: 200,
    bodyText: html,
    route: profileForRoute(key),
    sizeStats: null,
  });

describe('日记列表', () => {
  const URL_ = 'https://www.douban.com/people/mewcatcher/notes?start=0';

  test('判定通过，条目数对得上', () => {
    const cls = classify('note.list', NOTES(), URL_);
    assert.equal(cls.verdict, 'ok');
    assert.equal(cls.itemCount, 2);
  });

  test('**侧栏里别人的日记一篇都不许抽**', () => {
    // 真实页面的「最近回应过的日记」列着 6 篇他人的，今天全被包在
    // `link2/?url=…%2Fnote%2FN%2F` 里做了百分号编码，所以整页扫 `/note/(\d+)/`
    // 恰好碰不到——那是**运气**，不是设计。
    //
    // 夹具里第三条故意没套那层外壳（见 fixtures/notes-list.html 里的说明），
    // 这样「锚在 note-title 上」才真的有东西可守：换成整页扫，这条就会变红。
    //
    // 多抽的代价在这条路线上格外贵：日记列表没有声明数量，`captured_count` 被污染
    // 之后没有任何东西能把它比出来。
    const ids = extractItemIds(NOTES(), profileForRoute('note.list'));
    assert.deepEqual(ids, ['872015292', '868128497']);
    assert.ok(NOTES().includes('/note/700000003/'), '压力样本没了，这条测试就是空的');
  });

  test('时间是完整时刻，且与条目一一对应', () => {
    // 不像标记列表只有日期。顺序必须和 ids 一致——observePage 把 ids[i] 与 times[i]
    // 当成同一条目，错位会让 highWaterIds 记成别的条目。
    const times = extractItemTimes(NOTES(), profileForRoute('note.list'));
    assert.deepEqual(times, ['2025-04-14 18:47:50', '2024-11-27 05:41:10']);
  });

  test('**没有声明数量，就如实报没有**', () => {
    // 整页找不出一个 `(N)`。编一个出来（比如拿条目数充数）会让 coverage 上出现
    // 一个「声称 2 / 抓到 2 / 差 0」的假证据——那正是这份规范刻意要避免的东西。
    assert.equal(extractClaimedCount(NOTES(), profileForRoute('note.list')), null);
  });

  test('框架不全就不判 ok —— 哪怕状态码是 200', () => {
    const cls = classify('note.list', '<html><body>被拦了</body></html>', URL_);
    assert.notEqual(cls.verdict, 'ok');
  });

  test('被跳到别处也不认', () => {
    const cls = classify('note.list', NOTES(), 'https://www.douban.com/');
    assert.notEqual(cls.verdict, 'ok');
  });
});

describe('评论列表', () => {
  const URL_ = 'https://www.douban.com/people/mewcatcher/reviews?start=0';

  test('判定通过，条目数对得上', () => {
    const cls = classify('review.list', REVIEWS(), URL_);
    assert.equal(cls.verdict, 'ok');
    assert.equal(cls.itemCount, 2);
  });

  test('条目 id 取自容器本身', () => {
    assert.deepEqual(extractItemIds(REVIEWS(), profileForRoute('review.list')), [
      '8381069', '7500205',
    ]);
  });

  test('有声明数量，读出来', () => {
    const claimed = extractClaimedCount(REVIEWS(), profileForRoute('review.list'));
    assert.equal(claimed.count, 2);
    assert.match(claimed.raw, /我的评论\(2\)/);
  });

  test('时间与条目一一对应', () => {
    assert.deepEqual(extractItemTimes(REVIEWS(), profileForRoute('review.list')), [
      '2017-02-24 16:15:24', '2015-06-14 21:57:18',
    ]);
  });
});

describe('路线定义', () => {
  const routes = buildRoutes({ username: 'mewcatcher', includeCatalog: true });
  const note = routes.find((r) => r.key === 'note.list');
  const review = routes.find((r) => r.key === 'review.list');

  test('两条都在，而且走 HTML 不走 Rexxar', () => {
    // buildUnverifiedApiRoutes 那四条是死代码，且入口是未公开的移动端接口。
    for (const r of [note, review]) {
      assert.equal(r.surface, 'html');
      assert.equal(r.source, 'archive', 'source 不是 archive 就说明 URL 没经过核对');
      assert.match(r.entryUrl({ offset: 0 }), /^https:\/\/www\.douban\.com\/people\/mewcatcher\//);
      assert.doesNotMatch(r.entryUrl({ offset: 0 }), /rexxar|m\.douban\.com/);
    }
  });

  test('入口 URL 与真实页面一致', () => {
    assert.equal(note.entryUrl({ offset: 0 }),
      'https://www.douban.com/people/mewcatcher/notes?start=0');
    assert.equal(review.entryUrl({ offset: 30 }),
      'https://www.douban.com/people/mewcatcher/reviews?start=30');
  });

  test('优先级：广播之后，标记列表之前', () => {
    const at = (k) => routes.find((r) => r.key === k).priority;
    for (const r of [note, review]) {
      assert.equal(r.priority, PRIORITY.LONGFORM);
      assert.ok(r.priority > at('broadcast.timeline'));
      assert.ok(r.priority < at('interest.movie.collect'));
    }
  });

  test('**步长取本页条数，不写死一个每页几条**', () => {
    // 手上那份真实页面只有 2 条、一页装下、翻页器根本没出现，所以每页装几条是未知的。
    // 写死猜大了会跨过中间的条目静默漏抓，而日记连声明数量都没有，漏了发现不了。
    for (const r of [note, review]) {
      assert.equal(r.pagination.step, 'items');
      assert.equal(r.pagination.kind, 'start');
      assert.equal(r.pagination.first, 0);
    }
  });

  test('界面上有中文名，不露内部标识', () => {
    assert.equal(routeName('note.list'), '日记');
    assert.match(routeName('review.list'), /评论/);
  });

  test('用户名会被转义', () => {
    const odd = buildRoutes({ username: 'a b/c', includeCatalog: false })
      .find((r) => r.key === 'note.list');
    assert.equal(odd.entryUrl({ offset: 0 }),
      'https://www.douban.com/people/a%20b%2Fc/notes?start=0');
  });
});
