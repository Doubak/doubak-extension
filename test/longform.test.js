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
  extractDetailLinks,
  extractItemPairs,
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

describe('正文页 —— 列表页上的是截断摘要，全文只在这里', () => {
  const NOTE = () => fixture('note-detail.html');
  const REVIEW = () => fixture('review-detail.html');

  test('日记正文页判定通过', () => {
    const cls = classify('note.item', NOTE(), 'https://www.douban.com/note/872015292/');
    assert.equal(cls.verdict, 'ok');
  });

  test('评论正文页判定通过', () => {
    const cls = classify('review.item', REVIEW(), 'https://www.douban.com/review/8381069/');
    assert.equal(cls.verdict, 'ok');
  });

  test('**全文在 HTML 里，不是懒加载**', () => {
    // 这是接这条路线的全部理由。要是全文也走接口拉，抓正文页就白抓了，得另想办法。
    assert.match(NOTE(), /今天发现豆瓣终于可以绑定海外手机号了/);
    assert.match(REVIEW(), /玩了Open Beta大概10个小时/);
  });

  test('**页面上没有任何第三方内容**', () => {
    // 量出来的，不是假设：`#comments` 是空的，回应由前端调 Rexxar 接口在渲染时拉。
    // 整页唯一的 people 链接是作者本人。
    //
    // 这一条决定了发布到 GitHub Pages 时要不要过滤，也印证了 CLAUDE.md 里
    // 「不抓他人回应」那条在正文页上同样成立——不是靠我们躲，是豆瓣本来就没渲染。
    for (const html of [NOTE(), REVIEW()]) {
      const comments = /id="comments"[^>]*>([\s\S]*?)<\/div>/.exec(html);
      assert.equal(comments[1].trim(), '', '回应被渲染进 HTML 了，第三方内容会跟着进档案');
      const people = [...html.matchAll(/douban\.com\/people\/([\w-]+)\//g)].map((m) => m[1]);
      assert.deepEqual([...new Set(people)], ['mewcatcher']);
    }
  });

  test('封锁页不会因为「有个 div」就判成 ok', () => {
    for (const key of ['note.item', 'review.item']) {
      const cls = classify(key, '<html><body>访问过于频繁，请稍后再试</body></html>',
        `https://www.douban.com/${key.split('.')[0]}/1/`);
      assert.notEqual(cls.verdict, 'ok');
    }
  });

  test('urlAnchor 只认路径不认 host —— 影评可能在 movie.douban.com', () => {
    // 手上两条样本都是**游戏**评论，走 www。影评的 host 很可能不一样，
    // 认死 www 会把真页面判成「被跳走了」。
    const cls = classify('review.item', REVIEW(), 'https://movie.douban.com/review/9999999/');
    assert.equal(cls.verdict, 'ok');
  });
});

describe('日记有不止一种 URL 形状', () => {
  /**
   * 实测一张真实的日记列表页上三条并存：
   *
   *     /topic/496284296/    2026-08-07 16:25:36
   *     /note/872015292/     2025-04-14 18:47:50
   *     /note/868128497/     2024-11-27 05:41:10
   *
   * **不是豆瓣改版**——两种形状同时存在，发日记时用哪个编辑器就得到哪一种。
   * 错在写选择器时手上只有两篇、恰好都是 `/note/`，于是从 n=2 推出了一个封闭集合。
   *
   * 只认一种的后果是**整条被丢掉**：那条日记有时间没有 id，`extractItemPairs`
   * 连带把它的时间也丢了，于是水位线不推进、正文页不派生——而列表页上明明有三条。
   */
  const listPage = (hrefs) => `<html><head><title>我的日记</title></head><body>
    <li class="nav-user-account"><a href="/accounts/logout">退出</a></li>
    <h1>我的日记</h1><div class="note-list">${hrefs.map((h, i) => `
      <div class="note-item"><div class="note-header">
        <h3 class="note-title"><a title="t" href="${h}">t</a></h3>
        <div class="note-info"><span class="note-date">2026-08-0${i + 1} 10:00:00</span></div>
      </div></div>`).join('')}</div></body></html>`;

  test('**两种形状都要抽到**', () => {
    const html = listPage([
      'https://www.douban.com/topic/496284296/?_spm_id=ODIx',
      'https://www.douban.com/note/872015292/',
    ]);
    const p = profileForRoute('note.list');
    const r = extractItemPairs(html, p);
    assert.deepEqual(r.ids, ['496284296', '872015292']);
    assert.equal(r.idless, 0, '有一条抽不到 id —— 它的时间会跟着一起丢');
    assert.deepEqual(extractDetailLinks(html, p), [
      'https://www.douban.com/topic/496284296/',
      'https://www.douban.com/note/872015292/',
    ]);
  });

  test('派生出的 URL 不带查询串', () => {
    // 列表页上的链接挂着 `?_spm_id=…` 追踪参数。带着它去抓会让 url_key 每次都不同，
    // 跨档案去重随之失效。
    const html = listPage(['https://www.douban.com/topic/496284296/?_spm_id=ODIx']);
    assert.deepEqual(extractDetailLinks(html, profileForRoute('note.list')),
      ['https://www.douban.com/topic/496284296/']);
  });
});

describe('从列表页派生正文页', () => {
  test('**URL 取页面上的 href，不拿 id 去拼**', () => {
    // 拼出来的是我们的猜测，页面上的是豆瓣的事实。今天两者恰好一样，但评论那条
    // 几乎肯定不是：样本全是游戏评论走 www，影评多半在 movie.douban.com。
    // 拼错会得到一整批 404，而且看起来像「豆瓣把它们都删了」。
    assert.deepEqual(extractDetailLinks(NOTES(), profileForRoute('note.list')), [
      'https://www.douban.com/note/872015292/',
      'https://www.douban.com/note/868128497/',
    ]);
    assert.deepEqual(extractDetailLinks(REVIEWS(), profileForRoute('review.list')), [
      'https://www.douban.com/review/8381069/',
      'https://www.douban.com/review/7500205/',
    ]);
  });

  test('侧栏里别人的日记同样不许派生', () => {
    const urls = extractDetailLinks(NOTES(), profileForRoute('note.list'));
    assert.ok(!urls.some((u) => /70000000\d/.test(u)), `抽到了别人的日记：${urls.join(' ')}`);
  });

  test('没有 detailLink 的路线返回空，不报错', () => {
    assert.deepEqual(extractDetailLinks(NOTES(), profileForRoute('interest.movie.collect')), []);
    assert.deepEqual(extractDetailLinks(null, profileForRoute('note.list')), []);
  });

  test('正文页是叶子，没有分页', () => {
    // 有 pagination 会让 `ordered` 推导把它判成有序，于是一篇取不到会堵死其余的。
    const routes = buildRoutes({ username: 'x', includeCatalog: false });
    for (const k of ['note.item', 'review.item']) {
      const r = routes.find((x) => x.key === k);
      assert.equal(r.pagination, undefined);
      assert.equal(r.ordered, false);
      assert.equal(r.entryUrl, undefined, '正文页没有入口 URL，只能从列表页派生');
      assert.ok(routeName(k) !== k, '界面上会露出内部标识');
    }
  });
});

describe('成对抽取 —— id 与时间必须结构上对齐', () => {
  /**
   * `observePage` 把 `ids[i]` 与 `times[i]` 当成同一个条目。而两个独立的整页扫描
   * **没有任何机制保证它们等长**。真实档案里两个方向都发生了：
   *
   * | 路线 | 容器 | id | 时间 | 原因 |
   * |---|---|---|---|---|
   * | `interest.book.wish` | 15 | **16** | 15 | 用户短评里贴了一个电影链接 |
   * | `interest.game.collect` | 17 | **14** | 15 | 作品被删的孤儿抽不到 id |
   *
   * 前者让 `captured_count` 虚高、`coverage.delta` 假报 +1；后者让 `high_water_ids`
   * 记成别的条目，下次增量在边界上可能漏抓。
   */

  const P = () => profileForRoute('interest.movie.collect');

  const item = (inner) => `<div class="item comment-item">${inner}</div>`;

  test('**短评里贴的链接不会挤进 id 列表**', () => {
    // 条目自己的链接总在最前面（`<div class="pic"><a href=…>`），短评在后面。
    const html = item(`<div class="pic"><a href="https://book.douban.com/subject/111/"></a></div>
       <span class="date">2026-07-31</span>
       <span class="comment">为什么电影条目被删了？？？https://movie.douban.com/subject/999/</span>`);
    const r = extractItemPairs(html, P());
    assert.deepEqual(r.ids, ['111']);
    assert.deepEqual(r.times, ['2026-07-31']);
  });

  test('**长度永远相等**，时间那一格可以是 null', () => {
    // 实测 2098 个电影标记里有 8 个本来就没有日期。丢掉它们会少算，
    // 记成缺口会让整条路线永远不能推进水位线。
    const html = item('<a href="https://movie.douban.com/subject/1/"></a>')
      + item('<a href="https://movie.douban.com/subject/2/"></a><span class="date">2026-01-02</span>');
    const r = extractItemPairs(html, P());
    assert.equal(r.ids.length, r.times.length);
    assert.deepEqual(r.ids, ['1', '2']);
    assert.deepEqual(r.times, [null, '2026-01-02']);
  });

  test('有时间却抽不到 id —— 计进 idless，好报警', () => {
    const html = item('<span class="date">2026-01-01</span>')
      + item('<a href="https://movie.douban.com/subject/2/"></a><span class="date">2026-01-02</span>');
    const r = extractItemPairs(html, P());
    assert.equal(r.idless, 1);
    assert.deepEqual(r.ids, ['2'], '认不出的那条不许拿别人的时间凑数');
  });

  test('没 id 也没时间的容器静静丢掉 —— 那是模板不是条目', () => {
    // itemAnchor 在游戏页上会多匹配约 100 个 `<div class="item item-tags">`，
    // 那是编辑表单的 JS 模板。不需要为它单独写排除规则。
    const html = item('<label for="tags">标签</label>')
      + item('<a href="https://movie.douban.com/subject/2/"></a><span class="date">2026-01-02</span>');
    const r = extractItemPairs(html, P());
    assert.equal(r.containers, 2);
    assert.equal(r.idless, 0);
    assert.deepEqual(r.ids, ['2']);
  });

  test('**作品被删的游戏，id 从删除按钮上取回来**', () => {
    // 豆瓣删掉作品条目时用户的标记不会跟着删：列表上留下「未知游戏」，配占位图，
    // 连 <a> 都没有。而评分、标签、短评全都还在——那才是最该留住的部分。
    // id 在 `data-url="/j/ilmen/thing/N/interest"` 上，实测 601 条游戏标记全都有。
    const p = profileForRoute('interest.game.collect');
    const html = `<div class="common-item"><div class="title">未知游戏</div>
      <span class="rating-star allstar40"></span><span class="date">2025-07-19</span>
      <a class="js-remove-collect" data-url="/j/ilmen/thing/37364867/interest">删除</a></div>`;
    const r = extractItemPairs(html, p);
    assert.deepEqual(r.ids, ['37364867']);
    assert.deepEqual(r.times, ['2025-07-19']);
    assert.equal(r.idless, 0);
  });
});

describe('对着真实档案：每种媒介都要与声称数量吻合', () => {
  const DL = '/home/mewx/downloads/20260806/doubak-bundle-20260801T005010Z-3eef52';

  test('五种媒介，抽出的条目数 = 豆瓣声称的条数', async (t) => {
    const { existsSync, readdirSync, readFileSync } = await import('node:fs');
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    const { gunzipSync } = await import('node:zlib');

    const rows = readFileSync(`${DL}/${readdirSync(DL).find((f) => f.startsWith('index-'))}`, 'utf-8')
      .trimEnd().split('\n').map((l) => JSON.parse(l));
    /** @type {Record<string, Buffer>} */
    const segs = {};
    const body = (r) => {
      segs[r.segment] ??= readFileSync(`${DL}/${r.segment}`);
      const raw = gunzipSync(segs[r.segment].subarray(r.offset, r.offset + r.length));
      const h = raw.indexOf('\r\n\r\n');
      const len = Number(/^Content-Length: (\d+)$/m.exec(raw.subarray(0, h).toString())[1]);
      const b = raw.subarray(h + 4, h + 4 + len);
      return b.subarray(b.indexOf('\r\n\r\n') + 4).toString('utf-8');
    };

    const got = {};
    let idless = 0, mismatched = 0;
    for (const r of rows) {
      if (!r.intent?.startsWith('interest.list')) continue;
      const med = r.intent.split('.')[2];
      const p = extractItemPairs(body(r), profileForRoute(r.route_key));
      got[med] = (got[med] ?? 0) + p.ids.length;
      idless += p.idless;
      if (p.ids.length !== p.times.length) mismatched += 1;
    }

    // 豆瓣自己在 <h1> 里声称的数字（coverage.claimed_count 的来源）。
    // 抽出来的条目数与它逐媒介吻合，是「抽取器跟得上页面」最直接的证据。
    assert.deepEqual(got, { movie: 2098, book: 145, music: 84, game: 601, drama: 5 });
    assert.equal(idless, 0, '有条目有时间却抽不到 id');
    assert.equal(mismatched, 0, 'ids 与 times 长度不等 —— 按下标配对就会错位');
  });
});
