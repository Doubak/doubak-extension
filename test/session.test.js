import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  detectLoginState,
  extractAccountHints,
  describeMismatch,
  SessionGuard,
  SessionError,
} from '../src/crawl/session.js';

/**
 * 按真实页面的导航栏结构构造（校准依据 test/fixtures/profile-2026-07.html）。
 *
 * 数字 uid 放在 `_GLOBAL_NAV.USER_ID` 里，**不是**广播条目的 `data-uid`。
 * 早先的夹具只有后者，于是整套测试对着一个真实页面上并不成立的假设跑——而那个
 * 假设一旦当真，抓取会在第一张作品详情页上把评论者的 ID 当成本人然后误判
 * 「账号被换掉」。见 src/crawl/session.js 里 UID_PATTERNS 的说明。
 */
function loggedInPage({ display = '示例', username = 'example_user', uid = '10000001' } = {}) {
  return `<!DOCTYPE html><html><head><title>示例</title></head><body>
<div id="db-global-nav"><div class="bd"><div class="top-nav-info">
  <li class="nav-user-account">
    <a href="https://accounts.douban.com/passport/setting/" class="bn-more">
      <span>${display}的账号</span>
    </a>
    <div class="more-items"><a href="https://www.douban.com/mine/">个人主页</a></div>
  </li>
  <a href="https://www.douban.com/people/${username}/">我的主页</a>
</div></div></div>
<script>
  ;window._GLOBAL_NAV = { USER_ID: "${uid}", DOUBAN_URL: "https://www.douban.com" };
</script>
<div class="status-item" data-sid="1" data-uid="99999999">内容（这条的 data-uid 刻意与本人不同：真实页面上它可能是别人的）</div>
</body></html>`;
}

/** 未登录页：导航栏是登录入口，但页面上照样可能有数据。 */
function loggedOutPage({ withData = false } = {}) {
  return `<!DOCTYPE html><html><head><title>示例</title></head><body>
<div id="db-global-nav"><div class="bd"><div class="top-nav-info">
  <a href="https://accounts.douban.com/passport/login?source=main" class="nav-login">登录/注册</a>
</div></div></div>
${withData ? '<div class="common-item">游戏一</div>'.repeat(15) : ''}
</body></html>`;
}

describe('登录状态判定', () => {
  test('已登录', () => {
    assert.equal(detectLoginState(loggedInPage()), 'logged_in');
  });

  test('未登录', () => {
    assert.equal(detectLoginState(loggedOutPage()), 'logged_out');
  });

  test('未登录但页面上有数据 —— 仍然是未登录', () => {
    // 真实档案里 151 个页面就是这样：豆瓣的公开列表对匿名访问者照常显示，
    // 页面看起来完全正常。
    assert.equal(detectLoginState(loggedOutPage({ withData: true })), 'logged_out');
  });

  test('两个标志都没有时返回 unknown，不猜', () => {
    // 接口响应本来就没有导航栏，不能当成掉登录。
    assert.equal(detectLoginState('{"total":1234}'), 'unknown');
    assert.equal(detectLoginState(''), 'unknown');
    assert.equal(detectLoginState(null), 'unknown');
  });

  test('/accounts/logout 也算已登录', () => {
    const html = '<html><body><a href="/accounts/logout">退出</a></body></html>';
    assert.equal(detectLoginState(html), 'logged_in');
  });
});

describe('账号身份抽取', () => {
  test('取出数字 ID、用户名、昵称', () => {
    const h = extractAccountHints(loggedInPage({ display: '小明', username: 'xiaoming', uid: '82160871' }));
    assert.equal(h.userId, '82160871');
    assert.equal(h.username, 'xiaoming');
    assert.equal(h.displayName, '小明');
  });

  test('/people/mine/ 不是用户名', () => {
    const html = `<a href="https://www.douban.com/people/mine/">x</a>
                  <a href="https://www.douban.com/people/real_name/">y</a>`;
    assert.equal(extractAccountHints(html).username, 'real_name');
  });

  test('取不到就是 null，不猜', () => {
    // 抹掉全局导航的初始化脚本，uid 就该没了——那是唯一的来源。
    // （页面上残留的 `data-uid` 刻意不算：它可能是别人的。）
    const noUid = loggedInPage().replace(/<script>[\s\S]*?<\/script>/, '');
    assert.equal(extractAccountHints(noUid).userId, null);

    const empty = extractAccountHints('<html></html>');
    assert.deepEqual(empty, { userId: null, username: null, displayName: null });
  });
});

describe('preflight：开抓前的身份确认', () => {
  test('确认身份并记住', () => {
    const g = new SessionGuard();
    const acc = g.preflight(loggedInPage({ uid: '82160871', username: 'mewcatcher' }));
    assert.equal(acc.userId, '82160871');
    assert.equal(g.state, 'logged_in');
    assert.equal(g.account.username, 'mewcatcher');
  });

  test('未登录时拒绝开始，并说明频率上限的理由', () => {
    const g = new SessionGuard();
    try {
      g.preflight(loggedOutPage());
      assert.fail('本应抛错');
    } catch (e) {
      assert.ok(e instanceof SessionError);
      assert.equal(e.reason, 'session_expired');
      assert.match(e.message, /频率上限/, '要告诉用户未登录不只是数据不全');
    }
  });

  test('取不到数字 ID 时拒绝开始 —— 它是档案的归属主键', () => {
    const g = new SessionGuard();
    // 抹掉全局导航的初始化脚本：那是 uid 唯一的来源。
    const noUid = loggedInPage().replace(/<script>[\s\S]*?<\/script>/, '');
    assert.throws(() => g.preflight(noUid), /数字用户 ID/);
  });

  test('状态未知时也拒绝开始', () => {
    const g = new SessionGuard();
    assert.throws(() => g.preflight('<html></html>'), /无法判断登录状态/);
  });
});

describe('verify：每页的廉价复核', () => {
  /** @returns {SessionGuard} */
  function ready() {
    const g = new SessionGuard();
    g.preflight(loggedInPage({ uid: '82160871', username: 'mewcatcher', display: 'MewX' }));
    return g;
  }

  test('同一账号的页面通过', () => {
    const g = ready();
    assert.doesNotThrow(() =>
      g.verify(loggedInPage({ uid: '82160871', username: 'mewcatcher', display: 'MewX' })),
    );
  });

  test('掉登录 → session_expired，且是停止条件', () => {
    const g = ready();
    try {
      g.verify(loggedOutPage({ withData: true }));
      assert.fail('本应抛错');
    } catch (e) {
      assert.equal(e.reason, 'session_expired');
      assert.match(e.message, /停止条件/);
      assert.match(e.message, /公开视图/);
      assert.match(e.message, /频率上限/);
    }
  });

  test('换了账号 → account_switched，立即停止', () => {
    // 一个 bundle 只能属于一个账号，混进别人的数据是不可逆的污染。
    const g = ready();
    try {
      g.verify(loggedInPage({ uid: '99999999', username: 'someone_else', display: '别人' }));
      assert.fail('本应抛错');
    } catch (e) {
      assert.equal(e.reason, 'account_switched');
      assert.match(e.message, /不可逆/);
    }
  });

  test('只有用户名变了也算换账号', () => {
    const g = ready();
    const other = loggedInPage({ uid: '82160871', username: 'renamed', display: 'MewX' });
    assert.throws(() => g.verify(other), /用户名/);
  });

  test('接口响应（没有导航栏）不当作掉登录', () => {
    // 移动端接口的 JSON 里本来就没有导航栏，不能因此判定会话失效。
    const g = ready();
    assert.doesNotThrow(() => g.verify('{"total":1234,"interests":[]}'));
  });

  test('页面上取不到某个字段时不算不一致', () => {
    // 不能因为「这页没有 ID」就判定换了账号。接口响应、以及个别没有全局导航脚本
    // 的页面都会这样。
    const g = ready();
    const noUid = loggedInPage({ username: 'mewcatcher', display: 'MewX' })
      .replace(/<script>[\s\S]*?<\/script>/, '');
    assert.doesNotThrow(() => g.verify(noUid));
  });

  test('页面上残留别人的 data-uid 也不算换账号', () => {
    // 这是 verify 最容易误报的地方：作品详情页上的评论者 ID。误报的代价是
    // **整场停机**，而且是在一张完全正常的页面上。
    const g = ready();
    const withOthers = loggedInPage({ uid: '82160871', username: 'mewcatcher', display: 'MewX' })
      .replace('</body>', '<div class="status-item" data-uid="154611037">别人的评论</div></body>');
    assert.doesNotThrow(() => g.verify(withOthers));
  });

  test('没 preflight 就 verify 是用法错误', () => {
    assert.throws(() => new SessionGuard().verify(loggedInPage()), /尚未 preflight/);
  });
});

describe('身份比对', () => {
  const base = { userId: '1', username: 'a', displayName: '甲' };

  test('全一致返回 null', () => {
    assert.equal(describeMismatch(base, { ...base }), null);
  });

  test('只在两边都有值时比较', () => {
    assert.equal(describeMismatch(base, { userId: null, username: null, displayName: null }), null);
    assert.equal(describeMismatch(base, { userId: null, username: 'a', displayName: null }), null);
  });

  test('数字 ID 优先报出', () => {
    const m = describeMismatch(base, { userId: '2', username: 'b', displayName: '乙' });
    assert.match(m, /数字 ID 1 → 2/);
  });

  test('昵称变化也报', () => {
    const m = describeMismatch(base, { userId: '1', username: 'a', displayName: '乙' });
    assert.match(m, /昵称/);
  });
});

describe('数字 uid 的取证点', () => {
  const real = readFileSync(new URL('./fixtures/profile-2026-07.html', import.meta.url), 'utf-8');

  test('真实的个人主页 —— 三个身份字段全都取得出来', () => {
    // 这条是整组测试的地基：夹具是 2026-07-30 从真实页面取的，不是构造的。
    // 之前 uid 藏在哪里全靠猜，猜错的表现是「开始抓取」直接失败，而报出来的
    // 原因还指向错误的方向（「请确认这是个人主页」）。
    const h = extractAccountHints(real);
    assert.equal(h.userId, '82160871');
    assert.equal(h.username, 'mewcatcher');
    assert.equal(h.displayName, 'MewX');
    assert.equal(detectLoginState(real), 'logged_in');
  });

  test('四个取证点各自都能单独工作', () => {
    // 全都在**全局导航**里——那是每张登录后页面都有的共享组件，包括作品详情页。
    // 这正是它们可靠的原因。
    const cases = [
      ['_GLOBAL_NAV.USER_ID', '<script>;window._GLOBAL_NAV = { USER_ID: "82160871" };</script>'],
      ['UPLOAD_AUTH_TOKEN', '<script>var x = { UPLOAD_AUTH_TOKEN: "82160871:abcdef" };</script>'],
      ['piwik setUserId', "<script>_paq.push(['setUserId', '82160871']);</script>"],
      ['data-moreurl-dict（HTML 实体转义过）',
        '<a data-moreurl-dict="{&quot;from&quot;:&quot;top-nav&quot;,&quot;uid&quot;:&quot;82160871&quot;}">豆瓣</a>'],
    ];
    for (const [name, html] of cases) {
      assert.equal(extractAccountHints(html).userId, '82160871', name);
    }
  });

  test('data-moreurl-dict 必须按转义后的样子匹配', () => {
    // 那个属性值在 HTML 源码里是 `&quot;uid&quot;:&quot;123&quot;`。照 `"uid":"123"`
    // 去找，一个都匹配不到——而这种错不会报警，只会让取证点静默失效。
    assert.equal(extractAccountHints('<a data-moreurl-dict=\'{"uid":"82160871"}\'>').userId, null);
    assert.equal(
      extractAccountHints('<a data-moreurl-dict="{&quot;uid&quot;:&quot;82160871&quot;}">').userId,
      '82160871',
    );
  });

  test('**不**从广播条目的 data-uid 取', () => {
    // 这是整件事里最要紧的一条。`data-uid` 在个人主页上是本人，在**作品详情页**
    // 上是评论者——而 `verify()` 会拿这个 ID 在每一页上比对，不一致就判
    // `account_switched` 并整场停机。
    //
    // 所以一个「有时取到别人 ID」的取证点，会让抓取在第一张作品详情页上假装
    // 账号被换掉然后停下。取错比取不到糟糕得多。
    assert.equal(extractAccountHints('<div class="status-item" data-uid="99999999">x</div>').userId, null);
  });

  test('**不**从头像 URL 取', () => {
    // 同理：「我的关注」一段里全是别人的头像（`icon/up154611037-2.jpg`），
    // 而在作品详情页上第一个头像更可能是别人的。
    assert.equal(extractAccountHints('<img src="https://img1.doubanio.com/icon/up154611037-2.jpg">').userId, null);
  });

  test('**不**从数字形式的 /people/<id>/ 链接取', () => {
    // 它可以指向任何人。真实主页上「我的关注」里就有一串。
    assert.equal(extractAccountHints('<a href="https://www.douban.com/people/154611037/">别人</a>').userId, null);
  });

  test('真实主页里有别人的 ID，但取出来的仍然是本人', () => {
    // 端到端地钉住上面那几条：往真实夹具里塞进一堆别人的痕迹，结果不许变。
    const polluted = real.replace('</body>', `
      <div class="status-item" data-uid="154611037">别人的广播</div>
      <img src="https://img1.doubanio.com/icon/up272752938-9.jpg">
      <a href="https://www.douban.com/people/140685615/">别人</a>
      </body>`);
    assert.equal(extractAccountHints(polluted).userId, '82160871');
  });

  test('一个取证点都没有就是 null，不猜', () => {
    assert.equal(extractAccountHints('<html><body>什么都没有</body></html>').userId, null);
  });

  test('取不到 uid 的报错与「没登录」分开，并带上诊断信息', () => {
    // 混成「请重新登录」会让用户反复登录去修一个改版问题。
    const guard = new SessionGuard();
    const html = `<li class="nav-user-account"><a href="/accounts/logout">退出</a>
<span>某人的账号</span></li><a href="https://www.douban.com/people/someone/">主页</a>`;

    assert.throws(() => guard.preflight(html), (e) => {
      assert.equal(e.reason, 'missing_user_id');
      assert.notEqual(e.reason, 'session_expired');
      assert.match(e.message, /someone/);
      assert.match(e.message, /某人/);
      assert.match(e.message, /字节/);
      return true;
    });
  });

  test('每页复核在真实主页上通过', () => {
    // verify() 跑在每一页上。用真实页面确认它不会误报。
    const guard = new SessionGuard();
    guard.preflight(real);
    guard.verify(real); // 不抛即通过
  });
});
