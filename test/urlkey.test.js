import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { urlKey, isTrackingParam, URL_KEY_RULES_VERSION } from '../src/core/urlkey.js';

describe('url_key', () => {
  test('剥掉真实档案里见过的跟踪参数', () => {
    // 用户给出的真实广播固定链接就长这样。
    const raw =
      'https://www.douban.com/people/82160871/status/9351468114/?_spm_id=ODIxNjA4NzE&_dtcc=1';
    assert.equal(urlKey(raw), 'https://www.douban.com/people/82160871/status/9351468114/');
  });

  test('同一条广播带不同跟踪参数时，归一化到同一个键', () => {
    // 这正是 url_key 存在的理由：不剥的话，同一条广播在不同页面上出现
    // 就会被当成两个不同的页面，去重失效。
    const a = urlKey('https://www.douban.com/people/x/status/1/?_spm_id=AAA');
    const b = urlKey('https://www.douban.com/people/x/status/1/?_spm_id=BBB&_dtcc=1');
    const c = urlKey('https://www.douban.com/people/x/status/1/');
    assert.equal(a, b);
    assert.equal(b, c);
  });

  test('保留决定页面内容的参数', () => {
    // 剥错一个有语义的参数，会把两个不同的页面合并成一个 ——
    // 那是不可检测的数据损失。
    const collect = urlKey(
      'https://movie.douban.com/people/x/collect?start=15&sort=time&mode=grid',
    );
    const wish = urlKey('https://movie.douban.com/people/x/wish?start=15&sort=time&mode=grid');
    assert.notEqual(collect, wish);
    assert.match(collect, /start=15/);
    assert.match(collect, /sort=time/);
    assert.match(collect, /mode=grid/);
  });

  test('不同分页不会被合并', () => {
    const p1 = urlKey('https://www.douban.com/people/x/statuses?p=1');
    const p2 = urlKey('https://www.douban.com/people/x/statuses?p=2');
    assert.notEqual(p1, p2);
  });

  test('剥掉 Rexxar 的 ck 令牌 —— 它跟着会话走', () => {
    const s1 = urlKey('https://m.douban.com/rexxar/api/v2/user/1/interests?ck=AAAA&count=50');
    const s2 = urlKey('https://m.douban.com/rexxar/api/v2/user/1/interests?ck=BBBB&count=50');
    assert.equal(s1, s2, '跨会话的同一请求必须归一化到同一个键');
    assert.doesNotMatch(s1, /ck=/);
    assert.match(s1, /count=50/);
  });

  test('参数顺序不影响结果', () => {
    const a = urlKey('https://movie.douban.com/people/x/collect?start=0&sort=time');
    const b = urlKey('https://movie.douban.com/people/x/collect?sort=time&start=0');
    assert.equal(a, b);
  });

  test('scheme 与 host 转小写，路径大小写保留', () => {
    // 豆瓣的路径是大小写敏感的，动它就是在猜。
    const k = urlKey('HTTPS://WWW.Douban.COM/People/MewX/');
    assert.ok(k.startsWith('https://www.douban.com/'));
    assert.match(k, /People\/MewX\//);
  });

  test('丢掉 fragment —— 它从不发给服务器', () => {
    assert.equal(
      urlKey('https://www.douban.com/people/x/#anchor'),
      'https://www.douban.com/people/x/',
    );
  });

  test('不擅自增删尾斜杠', () => {
    // /people/x 与 /people/x/ 在豆瓣上可能是两个不同的响应，
    // 合并它们是有风险的猜测。
    assert.notEqual(
      urlKey('https://www.douban.com/people/x'),
      urlKey('https://www.douban.com/people/x/'),
    );
  });

  test('utm_* 与营销参数被剥掉', () => {
    assert.equal(
      urlKey('https://market.douban.com/book?utm_source=douban&utm_medium=pc_web&biz_type=book'),
      'https://market.douban.com/book?biz_type=book',
    );
  });

  test('幂等', () => {
    const raw = 'https://www.douban.com/people/x/status/1/?_spm_id=A&b=2&a=1';
    assert.equal(urlKey(urlKey(raw)), urlKey(raw));
  });

  test('非法 URL 直接抛', () => {
    assert.throws(() => urlKey('不是个 URL'));
    assert.throws(() => urlKey(''));
  });

  test('保留中文等非 ASCII 参数值', () => {
    const k = urlKey('https://www.douban.com/search?q=%E7%94%B5%E5%BD%B1');
    assert.match(k, /q=/);
  });
});

describe('规则版本', () => {
  test('带版本号，便于将来对存量重算', () => {
    assert.equal(URL_KEY_RULES_VERSION, 'v1');
  });

  test('跟踪参数名单可查', () => {
    assert.ok(isTrackingParam('_spm_id'));
    assert.ok(isTrackingParam('ck'));
    assert.equal(isTrackingParam('start'), false);
    assert.equal(isTrackingParam('sort'), false);
  });
});
