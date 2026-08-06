/**
 * 作品详情页那条路线。
 *
 * ## 它在这之前压根跑不起来
 *
 * `interest.item` 有定义、有判定描述、有门控，但：
 *
 * - 没有 `entryUrl` → `seedFrontier` 直接跳过它
 * - 没有任何代码把作品 URL 放进队列
 *
 * 于是这条**占真实档案九成体积**的路线，从来没抓过一个页面。
 *
 * 而它还带着一个错误的 `pagination`（作品页不分页），那让 `ordered` 推导把它判成有序
 * ——一个作品页失败会连带堵死其余的，正好是「叶子失败不该连带」那条规则要保护的路线。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { extractSubjectLinks } from '../src/crawl/classifier.js';
import { buildRoutes } from '../src/crawl/routes.js';
import { Frontier } from '../src/crawl/frontier.js';
import { seedFrontier } from '../src/crawl/runner.js';
import { PRIORITY } from '../src/crawl/routes.js';

describe('从列表页抽作品链接', () => {
  test('五种媒介的 URL 形态都认得', () => {
    const html = `
      <a href="https://movie.douban.com/subject/1292052/">x</a>
      <a href="https://book.douban.com/subject/1084336/">x</a>
      <a href="https://music.douban.com/subject/1406522/">x</a>
      <a href="https://www.douban.com/game/10437501/">x</a>
      <a href="https://www.douban.com/app/26835723/">x</a>
      <a href="https://www.douban.com/location/drama/24750414/">x</a>`;
    assert.equal(extractSubjectLinks(html).length, 6);
  });

  test('去重', () => {
    const html = '<a href="https://movie.douban.com/subject/1/">a</a>'.repeat(5);
    assert.equal(extractSubjectLinks(html).length, 1);
  });

  test('不把列表页/个人页当作品页', () => {
    const html = `
      <a href="https://www.douban.com/people/mewcatcher/statuses">x</a>
      <a href="https://movie.douban.com/mine?status=collect">x</a>
      <a href="https://www.douban.com/">x</a>`;
    assert.deepEqual(extractSubjectLinks(html), []);
  });

  test('对着真实列表页：抽出的条数等于槽位数', () => {
    // 旧档案 400 个列表页共抽出 5805 条，每页唯一链接数与槽位数一致。也就是列表页上
    // 没有游离的作品链接（没有「喜欢这部电影的人也喜欢」那类推荐区）。
    const base = '/home/mewx/codes/mewx.github.io-Generator/data/doubak/collector';
    for (const [f, n] of [
      ['20221226.1045_movie_watched_l0-15.html', 15],
      ['20221227.0905_game_played_l0-15.html', 15],
    ]) {
      let html;
      try {
        html = readFileSync(`${base}/${f}`, 'utf-8');
      } catch {
        return; // 旧档案不在这台机器上，跳过
      }
      assert.equal(extractSubjectLinks(html).length, n, f);
    }
  });
});

describe('短评正文里的作品链接不算条目', () => {
  /**
   * 上面那条「列表页上没有游离的作品链接」的测量是对的，但它漏了一种来源：**用户
   * 自己在短评里贴的链接**。真实档案 `20260806` 里就有一条——读书「想读」列表第 1 页
   * 抽出 16 条链接却只有 15 个槽位，多的那条是一部**电影**：
   *
   *     《在这世界的角落》（书 27141473）想读 2026-07-31
   *        短评：为什么电影条目被删了？？？https://movie.douban.com/subject/11611021/
   *
   * 后果两层：每次增量白跑一次恒定 404 的请求；以及 `coverage` 被污染成
   * 「声称 82 / 抓到 83 / 差 +1」——而 `delta` 是「豆瓣是不是在藏东西」的唯一证据。
   */

  // 下面几段都是从真实档案的 WARC 里原样取出来的，不是手写的近似。
  const BOOK_ITEM = `
<li class="subject-item">
  <div class="pic">
    <a class="nbg" href="https://book.douban.com/subject/27141473/"><img src="x"></a>
  </div>
  <div class="info">
    <h2><a href="https://book.douban.com/subject/27141473/" title="在这世界的角落">在这世界的角落</a></h2>
    <div class="short-note">
      <div><span class="date">2026-07-31 想读</span></div>
      <p class="comment comment-item" data-cid="4904793097">
        为什么电影条目被删了？？？https://movie.douban.com/subject/11611021/
      </p>
    </div>
  </div>
</li>`;

  test('书：短评里的电影链接不进队列，条目本身照抽', () => {
    assert.deepEqual(extractSubjectLinks(BOOK_ITEM), [
      'https://book.douban.com/subject/27141473/',
    ]);
  });

  test('电影/音乐：短评在 <span class="comment"> 里', () => {
    const html = `
      <div class="item comment-item" data-cid="1">
        <div class="pic"><a href="https://movie.douban.com/subject/1292052/" class="nbg"><img></a></div>
        <span class="comment">跟 https://movie.douban.com/subject/999999/ 是同一个班底</span>
      </div>`;
    assert.deepEqual(extractSubjectLinks(html), ['https://movie.douban.com/subject/1292052/']);
  });

  test('**不许把 `item comment-item` 当成短评抹掉**', () => {
    // 这是这个改动唯一危险的失败方向。电影与音乐列表上，`comment-item` 是**条目外壳
    // 本身**（`class="item comment-item"`）——按 `comment-item` 抹会把整个条目连同它的
    // 作品链接一起抹掉。那是静默漏抓，比多抽一条严重得多：多抽会在 coverage 上留下
    // 正的 delta，漏抓什么痕迹都不留。
    const html = `
      <div class="item comment-item" data-cid="1">
        <a href="https://movie.douban.com/subject/1292052/" class="nbg"><img></a>
      </div>
      <div class="item comment-item" data-cid="2">
        <a href="https://movie.douban.com/subject/1291546/" class="nbg"><img></a>
      </div>`;
    assert.equal(extractSubjectLinks(html).length, 2);
  });

  test('抹的是正文，不是整页——短评后面的条目照抽', () => {
    const html = `${BOOK_ITEM}
      <li class="subject-item">
        <a class="nbg" href="https://book.douban.com/subject/1084336/"><img></a>
      </li>`;
    assert.deepEqual(extractSubjectLinks(html).sort(), [
      'https://book.douban.com/subject/1084336/',
      'https://book.douban.com/subject/27141473/',
    ]);
  });
});

describe('路线定义', () => {
  const routes = buildRoutes({ username: 'x', includeCatalog: true });
  const item = routes.find((r) => r.key === 'interest.item');

  test('作品详情页没有 pagination', () => {
    // 它不分页。原来写着 `pagination: { kind: 'page', ... }`，而那有实际后果：
    // `ordered` 由「有没有 pagination」推导，于是这条路线被判成有序。
    assert.equal(item.pagination, undefined);
  });

  test('明确标成叶子（ordered:false）', () => {
    // 一个电影页抓不下来，与另外 1332 个无关。连带堵死的后果是一页失败葬送九成档案。
    assert.equal(item.ordered, false);
  });

  test('受广播门控，且排在最后', () => {
    assert.deepEqual(item.requires, ['broadcast.timeline']);
    assert.equal(item.priority, PRIORITY.CATALOG);
    const bc = routes.find((r) => r.key === 'broadcast.timeline');
    assert.ok(bc.priority < item.priority, '广播必须排在作品详情页之前');
  });

  test('没有 entryUrl，所以不会被播种 —— URL 只能从列表页派生', () => {
    assert.equal(item.entryUrl, undefined);
    const f = new Frontier();
    seedFrontier(f, routes);
    assert.equal(f.snapshot().some((i) => i.routeKey === 'interest.item'), false);
  });
});

describe('抓取顺序：严格按优先级，不按入队顺序', () => {
  test('后来追加的高优先级条目仍然先抓', () => {
    // 早先是「取第一个 pending」。种子按优先级插入，看起来等价——但翻页会把后续页面
    // **追加到队尾**：广播第 2 页排在所有标记列表种子之后，于是广播与列表交错抓。
    // 而设计要求「中途被打断时，先跑完的一定是最难补的」，交错正好抹掉那个保证。
    const f = new Frontier();
    f.enqueue({ url: 'https://x/list1', urlKey: 'l1', routeKey: 'interest.movie.collect', intent: 'i', priority: PRIORITY.INTERESTS });
    f.enqueue({ url: 'https://x/bc1', urlKey: 'b1', routeKey: 'broadcast.timeline', intent: 'i', priority: PRIORITY.BROADCAST });

    // 广播第 1 页先抓（优先级更高）
    const a = f.next();
    assert.equal(a.routeKey, 'broadcast.timeline');
    f.settle(a, 'ok');

    // 翻页：第 2 页追加到队尾
    f.enqueue({ url: 'https://x/bc2', urlKey: 'b2', routeKey: 'broadcast.timeline', intent: 'i', priority: PRIORITY.BROADCAST });

    const b = f.next();
    assert.equal(b.routeKey, 'broadcast.timeline', '广播第 2 页必须先于标记列表');
  });

  test('同优先级内先进先出 —— 分页必须按页序', () => {
    const f = new Frontier();
    for (const n of [1, 2, 3]) {
      f.enqueue({ url: `https://x/p${n}`, urlKey: `p${n}`, routeKey: 'r', intent: 'i', priority: 10 });
    }
    assert.equal(f.next().url.endsWith('p1'), true);
  });
});

describe('门控：作品详情页要等广播跑完', () => {
  function gated() {
    const f = new Frontier();
    f.enqueue({ url: 'https://x/bc1', urlKey: 'b1', routeKey: 'broadcast.timeline', intent: 'i', priority: PRIORITY.BROADCAST });
    f.enqueue({
      url: 'https://movie.douban.com/subject/1/', urlKey: 's1', routeKey: 'interest.item',
      intent: 'i', priority: PRIORITY.CATALOG, ordered: false, gatedBy: 'broadcast.timeline',
    });
    return f;
  }

  test('门没开时取不到被门控的条目', () => {
    const f = gated();
    const a = f.next();
    assert.equal(a.routeKey, 'broadcast.timeline');
    f.settle(a, 'ok');
    assert.equal(f.next(), null, '广播还没跑完，作品页不该开始');
  });

  test('被门控的条目不算「有活可干」，但也不算不存在', () => {
    // 上层要能区分「真的跑完了」与「只是前置还没完成」——后者绝不是 done。
    const f = gated();
    f.settle(f.next(), 'ok');
    assert.equal(f.hasReady(), false);
    assert.equal(f.gatedCount(), 1, '要能数出来还有多少被挡着');
  });

  test('开门之后才轮到', () => {
    const f = gated();
    f.settle(f.next(), 'ok');
    f.openGate('broadcast.timeline');
    assert.equal(f.hasReady(), true);
    assert.equal(f.gatedCount(), 0);
    assert.equal(f.next().routeKey, 'interest.item');
  });

  test('门控**照样入队**，不是「门没开就丢掉」', () => {
    // 丢掉的话，一旦列表页在广播之前抓完，这些 URL 就再也不会被发现了。
    const f = gated();
    assert.equal(f.snapshot().filter((i) => i.routeKey === 'interest.item').length, 1);
  });
});

describe('端到端：列表页派生出作品详情页', () => {
  test('抓完列表页之后，作品详情页真的被抓到了', async () => {
    const { CrawlLoop } = await import('../src/crawl/loop.js');
    const { SessionGuard } = await import('../src/crawl/session.js');
    const { Pacer, RequestGate } = await import('../src/crawl/pacing.js');
    const { Transport } = await import('../src/crawl/transport.js');
    const { BundleWriter } = await import('../src/bundle/bundle-writer.js');
    const { MemoryFileStore } = await import('../src/storage/file-store.js');
    const { fixtures } = await import('./helpers/fixtures.js');

    const enc = new TextEncoder();
    const store = new MemoryFileStore();
    const writer = new BundleWriter({ store, account: { user_id: '82160871', username: 'example' } });

    // 列表页上挂两个作品链接
    const LIST = fixtures.interestListPage.replace(
      '</body>',
      '<a href="https://www.douban.com/location/drama/34912679/">A</a>' +
      '<a href="https://www.douban.com/location/drama/10944608/">B</a></body>',
    );
    // 作品详情页：**导航栏必须与列表页一致**，否则会被判成换了账号
    // （那是 verify() 在正常工作，不是 bug——但夹具得自洽）
    const SUBJ = LIST.replace(/<div class="stream-items">[\s\S]*?<\/div>/, '')
      .replace('</body>', '<div id="mainpic"></div></body>');

    const routeDefs = buildRoutes({ username: 'example', mediums: ['drama'], includeCatalog: true })
      .filter((r) => r.key === 'interest.drama.collect' || r.key === 'interest.item');
    const f = new Frontier();
    seedFrontier(f, routeDefs);

    const transport = new Transport({
      gate: new RequestGate({ pacer: new Pacer({ intervalMs: 1, jitterRatio: 0 }) }),
      fetchImpl: async (url) => {
        const body = url.includes('/location/drama/') && !url.includes('collect') ? SUBJ : LIST;
        const b = enc.encode(body);
        return {
          status: 200, url,
          headers: new Headers({ 'content-type': 'text/html' }),
          arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
        };
      },
    });
    const session = new SessionGuard();
    session.preflight(LIST);

    /** @type {object[]} */
    const events = [];
    const loop = new CrawlLoop({
      frontier: f, transport, writer, session,
      pacer: new Pacer({ intervalMs: 1, jitterRatio: 0 }),
      routes: new Map(routeDefs.map((r) => [r.key, r])),
      onEvent: (e) => events.push(e),
      // 调试后门：正常抓取里作品详情页要等广播跑完
      bypassGates: true,
    });

    await loop.run({ maxItems: 6 });

    const derived = events.filter((e) => e.type === 'subjects_enqueued');
    assert.equal(derived.length > 0, true, '列表页应当派生出作品链接');
    assert.equal(derived[0].count, 2);
    assert.equal(derived[0].gated, false, 'bypassGates 时不该再挂门控');

    const captured = events.filter((e) => e.type === 'capture' && e.routeKey === 'interest.item');
    assert.ok(captured.length > 0, '作品详情页必须真的被抓到 —— 这条路线以前从没跑过');
    assert.equal(captured[0].verdict, 'ok');
  });

  test('不开后门时，派生出来的条目带着门控', async () => {
    const { CrawlLoop } = await import('../src/crawl/loop.js');
    const { SessionGuard } = await import('../src/crawl/session.js');
    const { Pacer, RequestGate } = await import('../src/crawl/pacing.js');
    const { Transport } = await import('../src/crawl/transport.js');
    const { BundleWriter } = await import('../src/bundle/bundle-writer.js');
    const { MemoryFileStore } = await import('../src/storage/file-store.js');
    const { fixtures } = await import('./helpers/fixtures.js');

    const enc = new TextEncoder();
    const LIST = fixtures.interestListPage.replace(
      '</body>', '<a href="https://www.douban.com/location/drama/34912679/">A</a></body>',
    );
    const routeDefs = buildRoutes({ username: 'example', mediums: ['drama'], includeCatalog: true })
      .filter((r) => r.key === 'interest.drama.collect' || r.key === 'interest.item');
    const f = new Frontier();
    seedFrontier(f, routeDefs);

    const transport = new Transport({
      gate: new RequestGate({ pacer: new Pacer({ intervalMs: 1, jitterRatio: 0 }) }),
      fetchImpl: async (url) => {
        const b = enc.encode(LIST);
        return {
          status: 200, url, headers: new Headers({ 'content-type': 'text/html' }),
          arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
        };
      },
    });
    const session = new SessionGuard();
    session.preflight(LIST);
    const loop = new CrawlLoop({
      frontier: f, transport, writer: new BundleWriter({
        store: new MemoryFileStore(), account: { user_id: '82160871', username: 'example' },
      }), session,
      pacer: new Pacer({ intervalMs: 1, jitterRatio: 0 }),
      routes: new Map(routeDefs.map((r) => [r.key, r])),
      onEvent: () => {},
    });

    await loop.run({ maxItems: 4 });

    const subj = f.snapshot().filter((i) => i.routeKey === 'interest.item');
    assert.ok(subj.length > 0, '照样要入队 —— 丢掉的话这些 URL 再也不会被发现');
    assert.equal(subj[0].gatedBy, 'broadcast.timeline');
    assert.ok(f.gatedCount() > 0, '而且要能数出来还有多少被挡着');
  });
});
