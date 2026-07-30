/**
 * IdbKvStore 在 Node 里能测到的那一部分。
 *
 * **说清覆盖边界**：Node 没有 IndexedDB，所以这里测的是参数校验与「API 不在时
 * 明确失败」。真正要紧的事务语义（等 `transaction.oncomplete` 而不是
 * `request.onsuccess`）只能在浏览器里验——见 `selftest/worker.js` 的
 * `runIdbKv()`，那里跑的是完整的 KvStore 契约加一条「换个实例也读得到」。
 *
 * 把这条边界写下来，是因为一个看起来有测试的模块最容易被当成测过了。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { IdbKvStore, DB_NAME, STORE_NAME } from '../src/storage/idb-kv-store.js';

describe('IdbKvStore', () => {
  test('IndexedDB 不可用时立刻抛，不静默降级', async () => {
    // 静默降级成内存实现是最坏的选择：抓取看起来一切正常，直到被杀一次，
    // 然后几小时的进度凭空消失，而且没有任何错误可查。
    assert.throws(() => new IdbKvStore({ idb: null }), /IndexedDB 不可用/);
    assert.throws(() => new IdbKvStore({ idb: undefined }), /IndexedDB 不可用/);
  });

  test('键必须是非空字符串，且三个方法的失败形态一致（都 reject）', async () => {
    // 同一个类里两种失败形态（一个同步抛、两个 reject）是纯粹的陷阱——调用方
    // 全都在 await。
    const store = new IdbKvStore({ idb: /** @type {any} */ ({ open: () => {} }) });
    for (const bad of ['', null, undefined, 0, {}]) {
      await assert.rejects(() => store.get(/** @type {any} */ (bad)), /非空字符串/);
      await assert.rejects(() => store.set(/** @type {any} */ (bad), 1), /非空字符串/);
      await assert.rejects(() => store.remove(/** @type {any} */ (bad)), /非空字符串/);
    }
  });

  test('库名与 store 名是导出的常量', () => {
    // service worker 与 offscreen 必须指向**同一个**库。两边各写一个字面量的话，
    // 写错一个字符就变成各写各的——恢复永远找不到东西，而且不会报错。
    assert.equal(typeof DB_NAME, 'string');
    assert.equal(typeof STORE_NAME, 'string');
    assert.ok(DB_NAME.length > 0 && STORE_NAME.length > 0);
  });

  test('打开失败时把 IndexedDB 的错误带出来', async () => {
    const store = new IdbKvStore({
      idb: /** @type {any} */ ({
        open() {
          const req = { onerror: null, onsuccess: null, onupgradeneeded: null, error: new Error('磁盘满了') };
          // 模拟异步失败
          setTimeout(() => req.onerror?.(), 0);
          return req;
        },
      }),
    });
    await assert.rejects(() => store.get('k'), /磁盘满了/);
  });

  test('升级被别的页面阻塞时说清楚该做什么', async () => {
    // 「无声地挂着」是这里最糟的行为：界面永远停在「正在读取…」。
    const store = new IdbKvStore({
      idb: /** @type {any} */ ({
        open() {
          const req = { onerror: null, onsuccess: null, onupgradeneeded: null, onblocked: null };
          setTimeout(() => req.onblocked?.(), 0);
          return req;
        },
      }),
    });
    await assert.rejects(() => store.get('k'), /关掉其它豆备页面/);
  });

  test('事务语义只在浏览器里验 —— 这里明确不覆盖', async () => {
    // 这条测试不测行为，它测的是**我们知道自己没测什么**。
    const selftest = await (await import('node:fs/promises')).readFile(
      new URL('../selftest/worker.js', import.meta.url), 'utf-8');
    assert.match(selftest, /runIdbKv/, 'selftest 里必须有 IndexedDB 的真实覆盖');
    assert.match(selftest, /kvStoreContract/, '要跑同一份 KvStore 契约');

    const src = await (await import('node:fs/promises')).readFile(
      new URL('../src/storage/idb-kv-store.js', import.meta.url), 'utf-8');
    // 等 oncomplete 而不是 onsuccess —— 后者早于真正提交
    assert.match(src, /tx\.oncomplete/);
    assert.match(src, /tx\.onabort/);
  });
});
