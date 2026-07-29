import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkHostAccess, requestHostAccess, permissionErrorIfLost,
  PermissionError, REQUIRED_ORIGINS, HOST_PERMISSION_LOST,
} from '../src/crawl/permissions.js';
import { decideResume } from '../src/crawl/resume-policy.js';
import { Transport } from '../src/crawl/transport.js';
import { Pacer, RequestGate } from '../src/crawl/pacing.js';

/** @param {(o: string) => boolean} grant */
function fakePermissions(grant) {
  return {
    calls: [],
    async contains({ origins }) {
      this.calls.push(origins[0]);
      return origins.every(grant);
    },
    async request({ origins }) {
      this.requested = origins;
      return true;
    },
  };
}

describe('站点权限', () => {
  test('全都有 → granted', async () => {
    const r = await checkHostAccess({ permissions: fakePermissions(() => true) });
    assert.deepEqual(r, { granted: true, missing: [] });
  });

  test('少一个 → 报出少的是哪个', async () => {
    const r = await checkHostAccess({
      permissions: fakePermissions((o) => o.includes('douban.com') && !o.includes('doubanio')),
    });
    assert.equal(r.granted, false);
    assert.deepEqual(r.missing, ['https://*.doubanio.com/*']);
  });

  test('逐个查，不合并成一次', async () => {
    // 合并查只能得到一个布尔，说不出缺的是哪个源。而图片域与主站缺哪个，
    // 对用户的意义完全不同。
    const api = fakePermissions(() => true);
    await checkHostAccess({ permissions: api });
    assert.deepEqual(api.calls, REQUIRED_ORIGINS);
  });

  test('API 不可用返回 null，不是 true', async () => {
    // 「查不了」和「有权限」是两件事。把前者当后者，就等于在测试环境里悄悄
    // 关掉了这条检查——而那正是这个 bug 第一次被漏掉的方式。
    assert.equal(await checkHostAccess({ permissions: {} }), null);
    assert.equal(await checkHostAccess({ permissions: undefined }), null);
  });

  test('contains() 自己抛了也返回 null', async () => {
    const api = { contains: async () => { throw new Error('boom'); } };
    assert.equal(await checkHostAccess({ permissions: api }), null);
  });

  test('permissionErrorIfLost：有权限或查不了都返回 null', async () => {
    assert.equal(await permissionErrorIfLost({ permissions: fakePermissions(() => true) }), null);
    assert.equal(await permissionErrorIfLost({ permissions: {} }), null);
  });

  test('permissionErrorIfLost：没权限时给出可执行的下一步', async () => {
    const e = await permissionErrorIfLost({ permissions: fakePermissions(() => false) });
    assert.ok(e instanceof PermissionError);
    assert.equal(e.reason, HOST_PERMISSION_LOST);
    assert.equal(e.missing.length, 2);
    // 文案要说做什么，不是只报一个错误码
    assert.match(e.message, /扩展设置/);
  });

  test('requestHostAccess 在不支持的浏览器上明确抛', async () => {
    await assert.rejects(() => requestHostAccess({ permissions: {} }), /不支持/);
  });
});

describe('权限丢失不能被当成网络错误', () => {
  /** @param {any} permissions */
  function transportThatFails(permissions) {
    return new Transport({
      gate: new RequestGate({ pacer: new Pacer({ intervalMs: 1, jitterRatio: 0 }) }),
      // 权限被撤之后浏览器 fetch 抛的就是 TypeError，与网络故障完全同形
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
      permissions,
    });
  }

  test('权限还在 → 判成可重试的网络错误', async () => {
    const t = transportThatFails(fakePermissions(() => true));
    await assert.rejects(() => t.fetch('https://www.douban.com/'), (e) => {
      assert.equal(e.name, 'TransportError');
      assert.equal(e.kind, 'network');
      assert.equal(e.retryable, true);
      return true;
    });
  });

  test('权限没了 → 判成不可重试的权限错误', async () => {
    // 这是整条链上最要紧的一处分叉。判成网络错误的话，会一遍遍重试一个永远
    // 不会自己好的问题，用户看到的是「网络怎么这么差」，几小时就这么没了。
    const t = transportThatFails(fakePermissions(() => false));
    await assert.rejects(() => t.fetch('https://www.douban.com/'), (e) => {
      assert.ok(e instanceof PermissionError);
      assert.equal(e.reason, HOST_PERMISSION_LOST);
      return true;
    });
  });

  test('查不了权限 → 保持原来的网络错误判定，不凭空升级', async () => {
    // 没有 chrome.permissions 的环境（比如 Node 测试）里，不该把每个网络
    // 抖动都说成权限问题。
    const t = transportThatFails(undefined);
    await assert.rejects(() => t.fetch('https://www.douban.com/'), (e) => {
      assert.equal(e.kind, 'network');
      return true;
    });
  });

  test('只在失败之后才查权限，成功的请求一次都不查', async () => {
    // 每页都查一遍权限，是给一件极少发生的事付常态开销。
    const api = fakePermissions(() => true);
    const t = new Transport({
      gate: new RequestGate({ pacer: new Pacer({ intervalMs: 1, jitterRatio: 0 }) }),
      fetchImpl: async (url) => ({
        status: 200,
        url,
        headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
      permissions: api,
    });

    await t.fetch('https://www.douban.com/');
    assert.deepEqual(api.calls, [], '成功路径上不该查权限');
  });
});

describe('权限丢失的恢复策略', () => {
  test('不自动恢复', async () => {
    // 和风控不同：这里不是等一等就好。权限得用户去改，而重新授权必须发生在
    // 用户手势里，后台自己发起不了。
    const d = decideResume({ pause_reason: HOST_PERMISSION_LOST });
    assert.equal(d.resume, false);
    assert.equal(d.userVisible, true);
    assert.match(d.reason, /权限/);
  });

  test('账号切换与写入失败也都不自动恢复', () => {
    for (const reason of ['account_switched', 'write_failed', 'quota']) {
      const d = decideResume({ pause_reason: reason });
      assert.equal(d.resume, false, `${reason} 不该自动恢复`);
      assert.equal(d.userVisible, true, `${reason} 必须告诉用户`);
      // 落到「未知原因」分支的话文案会是「未知的停止原因（…）」——那说明
      // 这个原因忘了登记，而不是策略写对了
      assert.equal(/未知的停止原因/.test(d.reason), false, `${reason} 没在策略表里登记`);
    }
  });
});
