import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { classifyResponse, RollingSize, ROUTE_PROFILES, profileForRoute, extractItemIds, extractItemTimes } from '../src/crawl/classifier.js';
import { fixtures, stripLoginMarkers, anonymizeWithLoginPrompt } from './helpers/fixtures.js';

const BROADCAST_URL = 'https://www.douban.com/people/82160871/statuses?p=1';

/** @param {object} over */
function classify(over) {
  return classifyResponse({
    finalUrl: BROADCAST_URL,
    status: 200,
    bodyText: fixtures.broadcastPage,
    route: ROUTE_PROFILES['broadcast.timeline'],
    ...over,
  });
}

describe('最难的一组：两个都是 0 条目的页面', () => {
  // 真实档案里这两种页面都是 HTTP 200、都是 0 条目，前代工具把登录页
  // 按数据文件名写进了磁盘且没有任何标记。分对它们是分类器存在的理由。

  test('越界终止页判为 ok —— 它只是空的，不是坏的', () => {
    const r = classify({ bodyText: fixtures.broadcastEmptyPage });
    assert.equal(r.verdict, 'ok');
    assert.equal(r.itemCount, 0);
    assert.ok(
      r.reasons.some((x) => x.includes('翻过了最后一页')),
      '应当提示条目数为 0 交由路线逻辑判断',
    );
  });

  test('会话过期的登录页判为 login —— 整场停机', () => {
    const r = classify({ bodyText: fixtures.loginPage });
    assert.equal(r.verdict, 'login');
    assert.equal(r.itemCount, 0);
  });

  test('两者条目数相同，却必须得到不同的判定', () => {
    const terminator = classify({ bodyText: fixtures.broadcastEmptyPage });
    const login = classify({ bodyText: fixtures.loginPage });

    assert.equal(terminator.itemCount, login.itemCount, '前提：条目数确实一样');
    assert.notEqual(terminator.verdict, login.verdict, '结论：判定必须不同');
    assert.equal(terminator.verdict, 'ok');
    assert.equal(login.verdict, 'login');
  });
});

describe('风控', () => {
  test('跳转到 sec.douban.com 且有验证码 → challenge', () => {
    const r = classify({
      finalUrl: 'https://sec.douban.com/b?r=https%3A%2F%2Fwww.douban.com%2F',
      bodyText: fixtures.securityChallengePage,
    });
    assert.equal(r.verdict, 'challenge');
    assert.ok(r.reasons.some((x) => x.includes('sec.douban.com')));
  });

  test('跳转到风控域名但没有验证码 → blocked', () => {
    const r = classify({
      finalUrl: 'https://sec.douban.com/b?r=x',
      bodyText: '<html><body>请稍后再试</body></html>',
    });
    assert.equal(r.verdict, 'blocked');
  });

  test('以 200 返回的风控文案也能识破', () => {
    // 豆瓣以 HTTP 200 返回封锁页——只看状态码等于完全没有检测。
    const challenge = classify({ bodyText: fixtures.securityChallengePage });
    assert.equal(challenge.verdict, 'challenge');

    const blocked = classify({ bodyText: fixtures.blockedPage });
    assert.equal(blocked.verdict, 'blocked');
  });

  test('429 与 403 判为 blocked', () => {
    assert.equal(classify({ status: 429 }).verdict, 'blocked');
    assert.equal(classify({ status: 403 }).verdict, 'blocked');
  });
});

describe('不存在', () => {
  test('HTTP 404 → gone', () => {
    assert.equal(classify({ status: 404 }).verdict, 'gone');
  });

  test('以 200 返回的「页面不存在」→ soft404', () => {
    // 单独一个取值而不是并入 gone：它与封锁页的区分容易出错，分开计数
    // 便于事后核查。
    const r = classify({ bodyText: fixtures.notFoundPage });
    assert.equal(r.verdict, 'soft404');
  });
});

describe('会话状态', () => {
  test('导航栏没有登录状态 → login', () => {
    // 页面既不是登录页也没有风控提示，但会话在某个环节掉了——此时页面上的
    // 内容不代表这个账号，不能当数据存。
    // 用集中的 stripLoginMarkers，而不是在这里手写正则去抠夹具内部结构——
    // 夹具一改，手写的正则会匹配不到，于是这条测试静默地不再测它想测的东西。
    const anonymous = stripLoginMarkers(fixtures.broadcastPage);
    const r = classify({ bodyText: anonymous });
    assert.equal(r.verdict, 'login');
    assert.ok(r.reasons.some((x) => x.includes('没有登录状态')));
  });

  test('有登录状态则继续往下判', () => {
    const r = classify({});
    assert.equal(r.verdict, 'ok');
    assert.ok(r.reasons.some((x) => x.includes('存在登录状态')));
  });
});

describe('判不出来必须返回 null', () => {
  // 「大概没事」是这套系统里最危险的一句话。调用方拿到 null 必须停下。

  test('页面框架对不上 → null', () => {
    const r = classify({ bodyText: fixtures.unrelatedPage });
    assert.equal(r.verdict, null);
    assert.ok(r.reasons.some((x) => x.includes('页面框架')));
  });

  test('未预期的状态码 → null', () => {
    assert.equal(classify({ status: 302 }).verdict, null);
    assert.equal(classify({ status: 418 }).verdict, null);
  });

  test('5xx → null（交给上层按可重试的网络错误处理，不是封锁）', () => {
    const r = classify({ status: 503 });
    assert.equal(r.verdict, null);
    assert.ok(r.reasons.some((x) => x.includes('503')));
  });

  test('finalUrl 无法解析 → null', () => {
    assert.equal(classify({ finalUrl: '乱码' }).verdict, null);
  });

  test('null 与 ok 是两回事，不能混用', () => {
    const unknown = classify({ bodyText: fixtures.unrelatedPage });
    assert.notEqual(unknown.verdict, 'ok');
    assert.equal(unknown.verdict, null);
  });
});

describe('文案匹配要容忍空白', () => {
  test('标题跨行也能识别', () => {
    // 真实页面里 <title> 与内容之间有换行和缩进。前代那种精确匹配
    // `<title>登录豆瓣</title>` 的写法在真实档案上就会漏。
    const withNewlines = '<html><head><title>\n    登录豆瓣\n</title></head><body></body></html>';
    assert.equal(classify({ bodyText: withNewlines }).verdict, 'login');
  });
});

describe('标记列表路线', () => {
  const route = ROUTE_PROFILES['interest.list'];

  test('新版 markup（item comment-item）', () => {
    const r = classifyResponse({
      finalUrl: 'https://movie.douban.com/people/x/collect?start=0',
      status: 200,
      bodyText: fixtures.interestListPage,
      route,
    });
    assert.equal(r.verdict, 'ok');
    assert.equal(r.itemCount, 15);
  });

  test('旧版 markup（item）也能命中 —— 两年内漂移过一次', () => {
    // 真实档案里 2023-01 与 2023-12 的电影列表页条目 class 不同。
    // 锚点按「class 包含 item」匹配，两个年代都要能数对。
    const r = classifyResponse({
      finalUrl: 'https://movie.douban.com/people/x/collect?start=0',
      status: 200,
      bodyText: fixtures.interestListPageOldMarkup,
      route,
    });
    assert.equal(r.verdict, 'ok');
    assert.equal(r.itemCount, 15);
  });
});

describe('体积异常只作警示，不单独定罪', () => {
  test('样本足够且明显偏小时留下记录，但仍判 ok', () => {
    const rolling = new RollingSize();
    for (let i = 0; i < 10; i++) rolling.add(98000);

    const small = fixtures.broadcastEmptyPage;
    const r = classify({ bodyText: small, sizeStats: rolling.stats() });

    assert.equal(r.verdict, 'ok', '框架齐全就仍然是 ok');
    assert.ok(
      r.reasons.some((x) => x.includes('异常小')),
      '但要留下记录，便于发现豆瓣换了新的封锁形态',
    );
  });

  test('样本太少时不做体积判断', () => {
    const rolling = new RollingSize();
    rolling.add(98000);
    const r = classify({ bodyText: fixtures.broadcastEmptyPage, sizeStats: rolling.stats() });
    assert.ok(!r.reasons.some((x) => x.includes('异常小')));
  });
});

describe('滚动体积分布', () => {
  test('中位数', () => {
    const r = new RollingSize();
    for (const n of [10, 20, 30]) r.add(n);
    assert.equal(r.stats().median, 20);
    r.add(40);
    assert.equal(r.stats().median, 25, '偶数个取中间两个的平均');
  });

  test('只保留最近的样本 —— 豆瓣改版后基线要跟得上', () => {
    const r = new RollingSize(4);
    for (const n of [1, 1, 1, 1]) r.add(n);
    for (const n of [100, 100, 100, 100]) r.add(n);
    assert.equal(r.stats().median, 100, '旧样本应当被挤出去');
    assert.equal(r.stats().count, 4);
  });

  test('没有样本时返回 null', () => {
    assert.equal(new RollingSize().stats(), null);
  });
});

describe('判定依据可追溯', () => {
  test('每次判定都带 reasons', () => {
    for (const body of [
      fixtures.broadcastPage,
      fixtures.loginPage,
      fixtures.blockedPage,
      fixtures.unrelatedPage,
    ]) {
      const r = classify({ bodyText: body });
      assert.ok(r.reasons.length > 0, '排查与事后重训都要靠它');
    }
  });
});

describe('未登录但页面上有数据 —— 真实档案里 151 个页面就是这样', () => {
  // 豆瓣的公开列表对匿名访问者照常显示，所以前代工具在会话失效的情况下
  // 照样拿到了数据、照样存了盘，没有任何标记。这类页面必须判为 login：
  // 公开视图里没有私密条目，它不代表这个账号。

  test('有内容但导航栏是登录入口 → login', () => {
    const anonymousWithData = anonymizeWithLoginPrompt(fixtures.interestListPage);

    const r = classifyResponse({
      finalUrl: 'https://www.douban.com/people/x/games?action=collect',
      status: 200,
      bodyText: anonymousWithData,
      route: ROUTE_PROFILES['interest.list'],
    });

    assert.equal(r.verdict, 'login', '有数据也不行——那是公开视图');
    assert.ok(r.itemCount > 0, '前提：页面上确实有条目');
    assert.ok(r.reasons.some((x) => x.includes('公开视图')));
  });

  test('/accounts/logout 也算已登录标志', () => {
    const withLogoutOnly = fixtures.broadcastPage
      .replace('class="nav-user-account"', 'class="something-else"')
      .replace('</body>', '<a href="/accounts/logout">退出</a></body>');
    assert.equal(classify({ bodyText: withLogoutOnly }).verdict, 'ok');
  });
});

describe('对着真实页面校准（2026-07）', () => {
  const real = readFileSync(new URL('./fixtures/broadcast-2026-07.html', import.meta.url), 'utf-8');

  test('真实的广播页判 ok —— 标题叫「我的动态」也一样', () => {
    // 这是那次实际失败的复现。分类器原来靠 `<title>…广播</title>` 认这条路线，
    // 而豆瓣把标题从「我的广播」改成了「我的动态」——于是真跑第一页就判不出来，
    // 一条都没抓到，报出来的只有一句「缺少 1 个页面框架标志」。
    const r = classifyResponse({
      finalUrl: 'https://www.douban.com/people/mewcatcher/statuses?p=1',
      status: 200,
      bodyText: real,
      route: ROUTE_PROFILES['broadcast.timeline'],
    });

    assert.equal(r.verdict, 'ok', `判成了 ${r.verdict}：${r.reasons.join('；')}`);
    assert.ok(r.itemCount > 0);
  });

  test('标题里根本没有「广播」二字 —— 别再拿它当标志', () => {
    // 先去掉 HTML 注释，再看。夹具顶部那段说明里**引用了旧的标志本身**
    // （`<title>…广播</title>`），不去掉的话第一个匹配到的是注释里那个。
    // 浏览器看到的也是去掉注释之后的内容，所以这么比才对。
    const markup = real.replace(/<!--[\s\S]*?-->/g, '');
    assert.match(markup, /<title>\s*我的动态\s*<\/title>/);
    const title = /<title>[\s\S]*?<\/title>/.exec(markup)[0];
    assert.equal(title.includes('广播'), false);
  });

  test('时间与 ID 照样抽得出来', () => {
    // 水位线与去重都靠它们。标志换了不该影响这两样。
    const p = ROUTE_PROFILES['broadcast.timeline'];
    assert.ok([...real.matchAll(p.idAnchor)].length > 0, '取不到 data-sid');
    assert.ok([...real.matchAll(p.timeAnchor)].length > 0, '取不到 created_at');
  });
});

describe('最终 URL 是最强的一条标志 —— 它不依赖 markup', () => {
  const real = readFileSync(new URL('./fixtures/broadcast-2026-07.html', import.meta.url), 'utf-8');
  const route = ROUTE_PROFILES['broadcast.timeline'];

  test('被跳到首页 → 判不出来，即使页面里有 stream-items', () => {
    // 首页信息流同样有 `stream-items`。单看 markup 会把它认成广播时间线，
    // 然后把别人的动态当成自己的档案写进去。
    const r = classifyResponse({
      finalUrl: 'https://www.douban.com/',
      status: 200,
      bodyText: real,
      route,
    });
    assert.equal(r.verdict, null);
    assert.ok(r.reasons.some((x) => x.includes('最终 URL 不像这条路线')));
  });

  test('URL 对了会明确记一笔，方便事后复盘', () => {
    const r = classifyResponse({
      finalUrl: 'https://www.douban.com/people/mewcatcher/statuses?p=3',
      status: 200,
      bodyText: real,
      route,
    });
    assert.ok(r.reasons.some((x) => x.includes('最终 URL 仍是这条路线')));
  });

  test('改版（框架标志没了）判 null，并说清缺的是哪一个', () => {
    // 只说「缺少 1 个」的话，事后只能对着一份 100 KB 的 HTML 猜是哪一个——
    // 而改版正是这条路径最常见的触发原因，那时候要的恰好是「哪个标志没了」。
    const drifted = real.replace(/id="db-usr-profile"/, 'id="db-user-header"');
    const r = classifyResponse({
      finalUrl: 'https://www.douban.com/people/mewcatcher/statuses?p=1',
      status: 200,
      bodyText: drifted,
      route,
    });

    assert.equal(r.verdict, null, '认不出来就不能判 ok');
    const why = r.reasons.join('；');
    assert.match(why, /db-usr-profile/, '要说出缺的是哪一个');
    assert.match(why, /改版/, '要指出最可能的原因');
    assert.match(why, /不必重抓/, '要说清这一页已经存下来了');
  });
});

describe('作品详情页 —— 占档案九成体积的那条路线', () => {
  const route = ROUTE_PROFILES['interest.item'];
  const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf-8');
  const MOVIE_URL = 'https://movie.douban.com/subject/26729145/';
  const GAME_URL = 'https://www.douban.com/game/20002850/';

  test('这条路线**必须**有判定描述', () => {
    // 在此之前 profileForRoute('interest.item') 返回 null，于是判定退回到
    // 「HTTP 200 就是 ok」——而豆瓣用 200 送封锁页。这条路线是数千次请求、排在几小时
    // 抓取的最后，也就是最可能撞上限流的时候。一次软封锁会让几千页被标成 ok。
    assert.ok(profileForRoute('interest.item'), '没有判定描述等于只看状态码');
  });

  test('评分被关掉的作品页仍然判 ok', () => {
    // 2017 央视春晚：88 KB 的正常页面，豆瓣关掉了它的评分，所以没有 interest_sectl。
    // 用「缺一不可」的话它会被判成故障然后停机——而它完完全全是一张好页面。
    // 对一个专门在意审查痕迹的项目来说，把「评分被关掉」当成故障尤其荒谬。
    const body = fx('subject-movie-rating-disabled.html');
    assert.equal(/id="interest_sectl"/.test(body.replace(/<!--[\s\S]*?-->/, '')), false,
      '前提：这张页面确实没有评分控件');

    const r = classifyResponse({ finalUrl: MOVIE_URL, status: 200, bodyText: body, route });
    assert.equal(r.verdict, 'ok', r.reasons.join('；'));
  });

  test('游戏页与影视页没有共同的内容区块，两者都要判 ok', () => {
    // 游戏页没有 mainpic、没有 <div id="info"、没有 v:itemreviewed。一套「缺一不可」
    // 的标志不可能同时覆盖两者。
    for (const [name, url] of [
      ['subject-game.html', GAME_URL],
      ['subject-movie-rating-disabled.html', MOVIE_URL],
    ]) {
      const r = classifyResponse({ finalUrl: url, status: 200, bodyText: fx(name), route });
      assert.equal(r.verdict, 'ok', `${name}: ${r.reasons.join('；')}`);
    }
  });

  test('一个内容区块都没有 → 判不出来，并说清试过哪些', () => {
    // 封锁页与错误页一个区块都不会有。而报错要能让人重新校准——这条路线的标志
    // 是拿 6341 个真实页面量出来的，重新校准也得靠真实页面。
    const nav = fx('subject-game.html').match(/<div id="db-global-nav"[\s\S]*?<\/script>/)[0];
    const blocked = `<html><head><title>豆瓣</title></head><body>${nav}
<div id="content"><p>有异常请求，请稍后再试</p></div></body></html>`;

    const r = classifyResponse({ finalUrl: MOVIE_URL, status: 200, bodyText: blocked, route });
    assert.equal(r.verdict, 'blocked', '这一条应当先被风控文案判掉');

    // 去掉风控文案，只剩「什么区块都没有」
    const bare = blocked.replace('有异常请求，请稍后再试', '一段无害的文字');
    const r2 = classifyResponse({ finalUrl: MOVIE_URL, status: 200, bodyText: bare, route });
    assert.equal(r2.verdict, null, '认不出来就绝不能判 ok');
    const why = r2.reasons.join('；');
    assert.match(why, /一个内容区块都没有/);
    assert.match(why, /interest_sectl/, '要说出试过哪些标志');
    assert.match(why, /改版/);
    assert.match(why, /不必重抓/);
  });

  test('被跳到别处 → 判不出来，即使页面内容完好', () => {
    // urlAnchor 不依赖 markup，所以改版影响不到它。
    const r = classifyResponse({
      finalUrl: 'https://www.douban.com/',
      status: 200,
      bodyText: fx('subject-movie-rating-disabled.html'),
      route,
    });
    assert.equal(r.verdict, null);
    assert.ok(r.reasons.some((x) => x.includes('最终 URL 不像这条路线')));
  });

  test('五个媒介的 URL 都认得', () => {
    for (const url of [
      'https://movie.douban.com/subject/1292052/',
      'https://book.douban.com/subject/1084336/',
      'https://music.douban.com/subject/1406522/',
      'https://www.douban.com/game/10437501/',
      'https://www.douban.com/app/26835723/',
      'https://www.douban.com/location/drama/24750414/',
    ]) {
      assert.ok(route.urlAnchor.test(url), url);
    }
    // 而列表页与个人页不该被认成作品页
    for (const url of [
      'https://www.douban.com/people/mewcatcher/statuses',
      'https://movie.douban.com/mine?status=collect',
      'https://www.douban.com/',
    ]) {
      assert.equal(route.urlAnchor.test(url), false, url);
    }
  });

  test('作品页没有条目概念 → itemCount 是 null，不是 0', () => {
    // null 是「这条路线没有条目概念」，0 是「数过了，是空的」。混起来会让
    // 「0 条」这个翻页终点信号在作品页上凭空出现。
    const r = classifyResponse({
      finalUrl: MOVIE_URL, status: 200,
      bodyText: fx('subject-movie-rating-disabled.html'), route,
    });
    assert.equal(r.itemCount, null);
  });
});

describe('空响应不是页面 —— 与路线无关', () => {
  test('0 字节的 200 判不出来，绝不是 ok', () => {
    // 旧档案里 6341 个作品详情页中有 7 个是 0 字节，全在同一天，被前代当数据留在了
    // 磁盘上、没有任何标记。当时的逻辑就是「HTTP 200 即成功」。
    for (const routeKey of ['broadcast.timeline', 'interest.item', 'interest.movie.collect']) {
      const r = classifyResponse({
        finalUrl: 'https://movie.douban.com/subject/1/',
        status: 200,
        bodyText: '',
        route: profileForRoute(routeKey) ?? ROUTE_PROFILES['interest.item'],
      });
      assert.equal(r.verdict, null, routeKey);
      assert.ok(r.reasons.some((x) => x.includes('0 字节')), routeKey);
    }
  });
});

describe('标记列表页：ID 与时间必须覆盖全部媒介', () => {
  const p = ROUTE_PROFILES['interest.list'];

  test('五种媒介的作品链接都能抽出 ID', () => {
    // 原来只写 `/subject/(\d+)/`，漏掉游戏（/game/N）、应用（/app/N）、
    // 舞台剧（/location/drama/N）。漏掉的后果远不止「进度显示 0」：
    // 停滞检测靠 ID 判断进展，抽不到就等于没有终止条件。
    const html = `
      <a href="https://movie.douban.com/subject/1292052/">x</a>
      <a href="https://book.douban.com/subject/1084336/">x</a>
      <a href="https://music.douban.com/subject/1406522/">x</a>
      <a href="https://www.douban.com/game/10437501/">x</a>
      <a href="https://www.douban.com/app/26835723/">x</a>
      <a href="https://www.douban.com/location/drama/24750414/">x</a>`;
    assert.deepEqual(extractItemIds(html, p), [
      '1292052', '1084336', '1406522', '10437501', '26835723', '24750414',
    ]);
  });

  test('同一条目出现多次只算一次，且保持首次出现的顺序', () => {
    // 列表里每个条目有图片链接与标题链接两处。不去重的话 3 部剧抽出 6 个 ID，
    // 而 `observePage` 把 `ids[i]` 与 `times[i]` 当成同一条目——3 个时间对上 6 个 ID，
    // `highWaterIds` 就记成了别的条目。那份清单是下次增量在边界上去重用的。
    const html = `
      <a href="/location/drama/34912679/"><img></a><a href="/location/drama/34912679/">标题</a>
      <a href="/location/drama/10944608/"><img></a><a href="/location/drama/10944608/">标题</a>`;
    assert.deepEqual(extractItemIds(html, p), ['34912679', '10944608']);
  });

  test('标记日期抽得出来 —— 这条路线原来根本没有 timeAnchor', () => {
    // 没有 timeAnchor 意味着水位线永远是 null、canAdvance 永远 false，
    // 增量抓取对标记列表压根不可能。
    const html = '<span class="date">2025-05-05</span><span class="date">2023-11-29</span>';
    assert.deepEqual(extractItemTimes(html, p), ['2025-05-05', '2023-11-29']);
  });

  test('对着真实的舞台剧列表页：3 个 ID、3 个日期、一一对上', async () => {
    // 这是那次报告的原始数据。
    const { gunzipSync, constants } = await import('node:zlib');
    const { readFileSync } = await import('node:fs');
    let body;
    try {
      const raw = readFileSync('/home/mewx/downloads/data-20260730T130118Z-a60b6a-00001.warc.gz');
      const rec = gunzipSync(raw, { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8');
      body = rec.split('\r\n\r\n').slice(2).join('\r\n\r\n');
    } catch {
      return; // 那份 dump 不在这台机器上
    }
    const ids = extractItemIds(body, p);
    const times = extractItemTimes(body, p);
    assert.equal(ids.length, 3);
    assert.equal(times.length, 3);
    assert.deepEqual(ids, ['34912679', '10944608', '35999593']);
  });
});
