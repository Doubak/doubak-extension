/**
 * 给图片请求补 Referer 的那条规则。
 *
 * ## 为什么它值得单独测
 *
 * 这套东西装不上或者装错了，症状是「**一张封面图都抓不到**」——而那个症状看起来
 * 完全不像权限或规则的问题：日志里只有一串 418。实测就这么绕了两轮。
 *
 * 而它又恰恰是**在 Node 里跑不到**的那类代码（要真的 chrome API），所以规则的
 * 形状必须能单独断言。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  refererRule,
  installRefererRule,
  REFERER_RULE_ID,
  REFERER_VALUE,
} from '../src/crawl/referer-rule.js';

describe('规则的形状', () => {
  const rule = refererRule();

  test('设的是 Referer', () => {
    // 豆瓣图片域有防盗链：不带 Referer 一律返回 418（13 字节，还标着 image/jpeg）。
    const h = rule.action.requestHeaders.find((x) => x.header === 'Referer');
    assert.ok(h, '没有设置 Referer');
    assert.equal(h.operation, 'set');
    assert.match(h.value, /^https:\/\/[a-z.]*douban\.com\//);
  });

  test('**只作用于扩展自己发的请求**', () => {
    // `tabIds: [-1]` = 不属于任何标签页的请求。少了它，用户在标签页里正常浏览
    // 豆瓣时的图片请求也会被改——改用户自己的流量是越界的，而且会让「这个扩展
    // 到底做了什么」变得不可预测。
    assert.deepEqual(rule.condition.tabIds, [-1]);
  });

  test('只匹配豆瓣的图片域', () => {
    assert.match(rule.condition.urlFilter, /doubanio\.com/);
    assert.deepEqual(rule.condition.resourceTypes, ['xmlhttprequest']);
  });

  test('顺手去掉内部标记头', () => {
    // `X-Override-Referer` 对豆瓣毫无意义，而发一个非标准头出去等于主动给自己
    // 贴一个「我不是浏览器」的标签——与「不伪造身份、也不留多余指纹」是同一条原则。
    const h = rule.action.requestHeaders.find((x) => x.header === 'X-Override-Referer');
    assert.ok(h);
    assert.equal(h.operation, 'remove');
  });
});

describe('装规则', () => {
  test('先删后加 —— worker 会被反复叫醒', async () => {
    // 不先删会撞「规则 ID 已存在」，而那个异常发生在启动路径上，很容易被吞掉。
    const calls = [];
    const ok = await installRefererRule({
      dnr: { updateSessionRules: async (x) => { calls.push(x); } },
    });
    assert.equal(ok, true);
    assert.deepEqual(calls[0].removeRuleIds, [REFERER_RULE_ID]);
    assert.equal(calls[0].addRules[0].id, REFERER_RULE_ID);
  });

  test('装不上要**报出来**，但不抛', async () => {
    // 后果是封面图全部 418（会被判成 blocked 然后停下来等人），而不是整个扩展
    // 起不来。但不说出来的话，用户会对着一堆 418 完全摸不着头脑。
    const errs = [];
    const ok = await installRefererRule({
      dnr: { updateSessionRules: async () => { throw new Error('nope'); } },
      onError: (msg) => errs.push(msg),
    });
    assert.equal(ok, false);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /418/, '错误信息里要说清症状，否则没人能把两件事联系起来');
  });

  test('浏览器根本没有这个 API 时也不抛', async () => {
    const errs = [];
    assert.equal(await installRefererRule({ dnr: {}, onError: (m) => errs.push(m) }), false);
    assert.equal(errs.length, 1);
  });
});

describe('接线', () => {
  const bg = readFileSync(new URL('../src/background.js', import.meta.url), 'utf-8');

  test('service worker 每次醒来都装一遍', () => {
    // 它是会话规则，活不过浏览器重启；而 service worker 本来就会被反复叫醒，
    // 正好是个合适的挂载点。装规则是幂等的，宁可多装。
    assert.match(bg, /installRefererRule/);
    assert.match(bg, /void ensureRefererRule\(\)/, '模块加载时就该装一次');
  });

  test('manifest 里有对应权限', () => {
    const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf-8'));
    assert.ok(
      m.permissions.includes('declarativeNetRequestWithHostAccess'),
      'DNR 权限没声明，规则装不上，封面图会全部 418',
    );
  });

  test('Referer 指向的是真实的豆瓣站点', () => {
    // 这不是伪造：那些图片本来就是从豆瓣页面上引用的，我们也确实是从豆瓣页面上
    // 读到这些 URL 的。但值必须是个真站点，不能是编出来的。
    assert.equal(REFERER_VALUE, 'https://www.douban.com/');
  });
});
