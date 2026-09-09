/**
 * 手机浏览器上把请求改成桌面版的那条规则。
 *
 * ## 为什么它值得单独测
 *
 * 装不上的症状是「**一页都抓不成**」，而用户看到的那句话是「无法判断登录状态」
 * ——指向的方向完全是错的（`Doubak/doubak-extension#12` 的报告人因此回帖说
 * 「豆瓣网站正常登录的」，他说得对）。
 *
 * 而这套东西在 Node 里跑不到（要真的 chrome API，也要一台手机），所以两件事必须
 * 能单独断言：**从哪些 UA 推得出桌面 UA**，以及**规则的形状**。
 *
 * 下面这张 UA 表里每一行都是 2026-09-09 对着真实豆瓣量出来的，不是推的。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  desktopUserAgent,
  desktopUaRule,
  installDesktopUaRule,
  looksMobile,
  DESKTOP_UA_RULE_ID,
} from '../src/crawl/desktop-ua.js';
import { REFERER_RULE_ID } from '../src/crawl/referer-rule.js';

/** 实测过的 UA。`want` 为 null = 这个形状我们不动。 */
const EDGE_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/151.0.0.0 Mobile Safari/537.36 EdgA/151.0.0.0';
const EDGE_ANDROID_DESKTOP =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/151.0.0.0 Safari/537.36 EdgA/151.0.0.0';

describe('从真实 UA 推桌面 UA', () => {
  test('安卓 Chromium：去掉 Mobile 这个词（#12 报告人的设备）', () => {
    // 实测：带这个词 → m.douban.com；去掉 → www.douban.com。
    assert.equal(desktopUserAgent(EDGE_ANDROID)?.userAgent, EDGE_ANDROID_DESKTOP);
  });

  test('推出来的必须是**安卓平板上真实存在**的那个 UA，不是编的桌面 UA', () => {
    // 这是整条规则站得住的理由：规范明令「生产者不得伪造 UA」，理由是伪造出的 UA
    // 与 TLS 指纹不一致、反而更容易被风控盯上。删掉一个词得到的是同一个浏览器、
    // 同一个系统，处处一致；换成 (X11; Linux x86_64) 就正好撞在那句话上。
    const out = desktopUserAgent(EDGE_ANDROID).userAgent;
    assert.match(out, /Android 14/, '系统必须还是安卓');
    assert.match(out, /EdgA\/151/, '浏览器必须还是同一个');
    assert.equal(out.replace(' Mobile', ''), out, '不该还留着手机标记');
    // 与原串的差别**只能**是那一个词。
    assert.equal(EDGE_ANDROID.replace(' Mobile', ''), out);
  });

  test('**Firefox 安卓一律不动** —— 那上面没有一个满足不变量的 UA', () => {
    // 一度写过一条 `Mobile; ` 判据。删掉确实能拿到桌面版（量过），但得到的
    // `(Android 14; rv:141.0)` 是任何 Firefox 都不会发的 UA——而 Firefox 安卓的
    // 两种真实形态**都**被跳到手机版：
    //
    //     (Android 14; Mobile; rv:…) → m      (Android 14; Tablet; rv:…) → m
    //     (X11; Linux x86_64; rv:…)  → www    ← 只有货真价实的桌面 UA 行
    //
    // 也就是说这个方案在 Firefox 上**不成立**，不是少写了一行。在安卓上发桌面 UA
    // 就是「安卓的 TLS 指纹配 Linux 桌面的 UA」，正是规范那句禁令针对的东西。
    for (const ua of [
      'Mozilla/5.0 (Android 14; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0',
      'Mozilla/5.0 (Android 14; Tablet; rv:141.0) Gecko/141.0 Firefox/141.0',
    ]) {
      assert.equal(desktopUserAgent(ua), null, ua);
    }
  });

  test('Firefox 桌面本来就拿得到桌面版，更不该动', () => {
    assert.equal(
      desktopUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0'),
      null,
    );
  });

  test('桌面浏览器一律不动', () => {
    for (const ua of [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    ]) {
      assert.equal(desktopUserAgent(ua), null, ua);
      assert.equal(looksMobile(ua), false, ua);
    }
  });

  test('安卓平板本来就没有那个词 —— 不动，因为它本来就能拿到桌面版', () => {
    // 实测过：平板 UA 直接就得到 www.douban.com。
    const tablet =
      'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/151.0.0.0 Safari/537.36';
    assert.equal(desktopUserAgent(tablet), null);
  });

  test('**认不出的手机形状宁可不动，也不编一个 UA 出来**', () => {
    // iOS Safari 的 `Mobile/15E148` 实测也会被跳到手机版，但它是个带版本号的
    // 整体，删掉得不到任何真实存在的 UA。认它就得编，而编 UA 正是规范禁止的那件事
    // ——那条禁令的理由（指纹不一致更容易被风控识别）在这里一字不差地成立。
    //
    // 代价照说：iOS 上这个扩展仍然不能用，而用户会看到一句**说得出原因**的话。
    const ios =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
      + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    assert.equal(desktopUserAgent(ios), null);
  });

  test('空的、非字符串的 UA 不抛', () => {
    for (const bad of ['', null, undefined, 42, {}]) {
      assert.equal(desktopUserAgent(/** @type {any} */ (bad)), null);
      assert.equal(looksMobile(/** @type {any} */ (bad)), false);
    }
  });

  test('删完还认得出手机标记的话，一律不动', () => {
    // 防的是「删了一个还剩一个」——那说明这个形状不是我们以为的那个，
    // 而发一个没量过的 UA 出去比不支持这台设备糟糕得多。
    const twice =
      'Mozilla/5.0 (Linux; Android 14; X) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Mobile Safari/537.36';
    assert.equal(desktopUserAgent(twice), null);
  });
});

describe('规则的形状', () => {
  const rule = desktopUaRule(EDGE_ANDROID_DESKTOP);

  test('设的是 User-Agent', () => {
    const h = rule.action.requestHeaders.find((x) => x.header === 'User-Agent');
    assert.ok(h, '没有设置 User-Agent');
    assert.equal(h.operation, 'set');
    assert.equal(h.value, EDGE_ANDROID_DESKTOP);
  });

  test('**只作用于扩展自己发的请求**', () => {
    // `tabIds: [-1]` = 不属于任何标签页的请求。少了它，用户自己在手机上逛豆瓣
    // 也会被推到桌面版——而他在手机上多半**就是想要**手机版。改用户自己的流量
    // 是越界的。这也是 #12 里「请求桌面版网站」那个开关帮不上忙的原因：
    // 那个开关按标签页生效，而抓取跑在离屏文档里。
    assert.deepEqual(rule.condition.tabIds, [-1]);
  });

  test('匹配豆瓣的页面域', () => {
    assert.match(rule.condition.urlFilter, /douban\.com/);
  });

  test('规则 ID 与 Referer 那条不撞', () => {
    // 撞了的话后装的那条会顶掉先装的，症状是「封面图全 418」或者「一页都抓不成」，
    // 两个都不像规则冲突。
    assert.notEqual(DESKTOP_UA_RULE_ID, REFERER_RULE_ID);
  });
});

describe('安装', () => {
  test('桌面浏览器上**一个 chrome API 都不碰**', async () => {
    // 这是这条改动的安全边界：今天能正常工作的每一个用户，发出去的 UA 与之前
    // 逐字节相同。所以不是「装一条什么都不改的规则」，是压根不装。
    let called = 0;
    const r = await installDesktopUaRule({
      dnr: { updateSessionRules: async () => { called += 1; } },
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/151.0.0.0 Safari/537.36',
    });
    assert.equal(called, 0);
    assert.equal(r.installed, false);
    assert.equal(r.sentUserAgent, null);
  });

  test('手机浏览器上先删后加 —— worker 会被反复叫醒', async () => {
    /** @type {any} */
    let got = null;
    const r = await installDesktopUaRule({
      dnr: { updateSessionRules: async (a) => { got = a; } },
      userAgent: EDGE_ANDROID,
    });
    assert.equal(r.installed, true);
    assert.equal(r.sentUserAgent, EDGE_ANDROID_DESKTOP);
    assert.deepEqual(got.removeRuleIds, [DESKTOP_UA_RULE_ID]);
    assert.equal(got.addRules[0].action.requestHeaders[0].value, EDGE_ANDROID_DESKTOP);
  });

  test('装不上要**报出来**，但不抛', async () => {
    const errs = [];
    const r = await installDesktopUaRule({
      dnr: { updateSessionRules: async () => { throw new Error('nope'); } },
      userAgent: EDGE_ANDROID,
      onError: (m) => errs.push(m),
    });
    assert.equal(r.installed, false);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /m\.douban\.com/);
  });

  test('浏览器没有这个 API 时也不抛，但要说清后果', async () => {
    const errs = [];
    const r = await installDesktopUaRule({
      dnr: {}, userAgent: EDGE_ANDROID, onError: (m) => errs.push(m),
    });
    assert.equal(r.installed, false);
    assert.match(errs[0], /一页都抓不成/);
  });

  test('认出是手机但不认识形状时，理由要说得出来', async () => {
    const r = await installDesktopUaRule({
      dnr: { updateSessionRules: async () => {} },
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; X) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Mobile Safari/537.36',
    });
    assert.equal(r.installed, false);
    assert.match(r.reason, /不猜/);
  });
});

describe('接线', () => {
  test('service worker 每次醒来都装一遍', () => {
    const src = readFileSync(new URL('../src/background.js', import.meta.url), 'utf-8');
    assert.match(src, /ensureDesktopUaRule\(\)/);
  });

  test('manifest 里有对应权限', () => {
    const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf-8'));
    assert.ok(
      m.permissions.includes('declarativeNetRequestWithHostAccess'),
      '没有这个权限就改不了请求头',
    );
  });
});
