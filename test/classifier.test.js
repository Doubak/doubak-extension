import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classifyResponse, RollingSize, ROUTE_PROFILES } from '../src/crawl/classifier.js';
import { fixtures } from './helpers/fixtures.js';

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
    const anonymous = fixtures.broadcastPage.replace(/<div class="nav-user-account">[\s\S]*?<\/div>/, '');
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
    const anonymousWithData = fixtures.interestListPage
      .replace(/<div class="nav-user-account">[\s\S]*?<\/div>/, '<a href="/accounts/login" class="nav-login">登录</a>');

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
