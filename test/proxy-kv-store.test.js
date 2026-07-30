/**
 * offscreen 借道 service worker 读写 chrome.storage。
 *
 * 这一层只收发消息，没有任何浏览器专有 API，所以拿一个假的 `send` 就能完整测——
 * 包括那些在浏览器里最难查的失败：service worker 没答复、答复了但报错、消息压根
 * 没送到。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ProxyKvStore, handleKvMessage, KV_MESSAGE } from '../src/storage/proxy-kv-store.js';
import { MemoryKvStore } from '../src/storage/kv-store.js';
import { kvStoreContract } from './helpers/kv-store-contract.js';

/** 把消息真的转给一个内存 KV，模拟 service worker 那一侧。 */
function wired(kv = new MemoryKvStore()) {
  const seen = [];
  const store = new ProxyKvStore({
    send: async (msg) => {
      seen.push(msg);
      return handleKvMessage(msg, kv);
    },
  });
  return { store, kv, seen };
}

describe('ProxyKvStore', () => {
  test('读写删都转发过去，值原样往返', async () => {
    const { store, kv } = wired();

    await store.set('a', { n: 1, s: '中文' });
    assert.deepEqual(await store.get('a'), { n: 1, s: '中文' });
    assert.deepEqual(await kv.get('a'), { n: 1, s: '中文' });

    await store.remove('a');
    assert.equal(await store.get('a'), undefined);
  });

  test('取不存在的键给 undefined，不抛', async () => {
    // checkpoint 不存在是**正常状态**（没有未完成的抓取），不是错误。
    const { store } = wired();
    assert.equal(await store.get('没有这个键'), undefined);
  });

  test('消息带 type 但**不带 target**', async () => {
    // 带 target 就会被 offscreen 自己的消息监听器抢走——而它正是这条消息的
    // 发起方，于是请求发出去、答复被自己吃掉，永远等不到回音。
    const { store, seen } = wired();
    await store.set('k', 1);
    assert.equal(seen[0].type, KV_MESSAGE);
    assert.equal('target' in seen[0], false);
  });

  test('service worker 没答复 → 说清楚是没答复，不说存储坏了', async () => {
    // 这比「存储坏了」更可能（SW 里没人处理这条消息），也更值得直说——否则会有
    // 人去查配额。
    const store = new ProxyKvStore({ send: async () => undefined, context: 'offscreen' });
    await assert.rejects(() => store.get('k'), /offscreen.*没有答复/);
  });

  test('消息发不出去 → 错误里带上上下文', async () => {
    // 「chrome.storage.local 不可用」当初就是因为没有上下文而把人指错方向：
    // 那句话在 service worker 里根本不可能出现，所以第一反应是去查权限配置。
    const store = new ProxyKvStore({
      send: async () => { throw new Error('Receiving end does not exist'); },
      context: 'offscreen',
    });
    await assert.rejects(() => store.get('k'), (e) => {
      assert.match(e.message, /offscreen/);
      assert.match(e.message, /Receiving end does not exist/);
      return true;
    });
  });

  test('service worker 那侧出错 → 原因带回来', async () => {
    const store = new ProxyKvStore({
      send: async (msg) => handleKvMessage(msg, {
        get: async () => { throw new Error('QUOTA_BYTES quota exceeded'); },
        set: async () => {},
        remove: async () => {},
      }),
    });
    await assert.rejects(() => store.get('k'), /QUOTA_BYTES/);
  });

  test('未知操作被拒绝', async () => {
    const r = await handleKvMessage({ op: '把 checkpoint 发出去' }, new MemoryKvStore());
    assert.equal(r.ok, false);
    assert.match(r.error, /未知的存储操作/);
  });

  test('满足 KvStore 契约', async () => {
    // 与 MemoryKvStore / ChromeKvStore 同一份契约——上层（RunStore）只认接口，
    // 不该知道自己写在哪里、隔着几跳消息。
    await kvStoreContract(() => wired().store);
  });
});
