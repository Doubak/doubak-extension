import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectLoginState,
  extractAccountHints,
  describeMismatch,
  SessionGuard,
  SessionError,
} from '../src/crawl/session.js';

/**
 * 按真实档案里的导航栏结构构造，不含真人数据。
 * 已登录页的实测形态：`<li class="nav-user-account">` + `<span>昵称的账号</span>`。
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
<div class="status-item" data-sid="1" data-uid="${uid}">内容</div>
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
    // 数字 ID 多数页面上没有——实测标记列表页就没有 data-uid。
    const noUid = loggedInPage().replace(/ data-uid="\d+"/, '');
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
    const noUid = loggedInPage().replace(/ data-uid="\d+"/, '');
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
    // 标记列表页没有 data-uid，不能因为「这页没有 ID」就判定换了账号。
    const g = ready();
    const noUid = loggedInPage({ username: 'mewcatcher', display: 'MewX' }).replace(
      / data-uid="\d+"/,
      '',
    );
    assert.doesNotThrow(() => g.verify(noUid));
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

describe('数字 uid 的多路取证', () => {
  test('data-uid（广播条目上）', () => {
    const html = '<div class="status-item" data-uid="82160871">x</div>';
    assert.equal(extractAccountHints(html).userId, '82160871');
  });

  test('头像 URL —— 个人主页上不一定有广播条目，但一定有自己的头像', () => {
    // 一开始只找 data-uid，而那**只在广播条目上**。个人主页上可能压根没有任何
    // 广播条目，于是「开始抓取」报「页面上取不到数字用户 ID」。真实旧档案里的
    // 广播列表页全都有 data-uid，那让人误以为它到处都有。
    for (const url of [
      'https://img1.doubanio.com/icon/u82160871-3.jpg',
      'https://img9.doubanio.com/icon/up82160871-8.jpg',
    ]) {
      assert.equal(extractAccountHints(`<img src="${url}">`).userId, '82160871', url);
    }
  });

  test('数字形式的个人主页链接', () => {
    assert.equal(
      extractAccountHints('<a href="https://www.douban.com/people/82160871/">我</a>').userId,
      '82160871',
    );
  });

  test('查询参数与内嵌 JSON', () => {
    assert.equal(extractAccountHints('<a href="/x?uid=82160871&p=2">').userId, '82160871');
    assert.equal(extractAccountHints('<script>var d={"uid":82160871}</script>').userId, '82160871');
    assert.equal(extractAccountHints('<script>var d={"uid":"82160871"}</script>').userId, '82160871');
  });

  test('优先级：data-uid 与头像都在时取 data-uid', () => {
    // 顺序有意义——靠前的更可能是本人的 ID。
    const html = '<img src="/icon/u111-1.jpg"><div data-uid="222"></div>';
    assert.equal(extractAccountHints(html).userId, '222');
  });

  test('一个都没有就是 null，不猜', () => {
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
      // 报错要带上已经找到了什么，否则无从判断是没登录还是改版
      assert.match(e.message, /someone/);
      assert.match(e.message, /某人/);
      assert.match(e.message, /字节/);
      return true;
    });
  });

  test('退路的失败说明会被一起带出来', () => {
    // 主页与广播页都试过了，报错里得看得出两处都试了。
    const guard = new SessionGuard();
    const html = '<li class="nav-user-account"><a href="/accounts/logout">退出</a></li>';
    assert.throws(() => guard.preflight(html, { fallbackFrom: '主页上也没有' }), /此前还试过.*主页上也没有/);
  });
});
