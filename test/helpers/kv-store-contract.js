/**
 * KvStore 的共享契约。
 *
 * 现在有三个实现，而上层（`RunStore`）只认接口——它不该知道自己写在内存里、
 * 写在 `chrome.storage` 里，还是隔着一跳消息写在别的上下文里：
 *
 * | 实现 | 在哪 |
 * |---|---|
 * | `MemoryKvStore` | 测试与演练 |
 * | `ChromeKvStore` | service worker（唯一真的碰 chrome.storage 的地方） |
 * | `ProxyKvStore` | offscreen document，借道 service worker |
 *
 * 三者行为必须一致。最容易分叉的是**边界值**：取不存在的键、存 `null`、存
 * `false`——它们都可能被某个实现悄悄折成 `undefined`，而 checkpoint 里恰好
 * 用得到「明确的 null」。
 */

import assert from 'node:assert/strict';

/** @param {() => import('../../src/storage/kv-store.js').KvStore} make */
export async function kvStoreContract(make) {
  {
    const kv = make();
    assert.equal(await kv.get('从来没写过'), undefined, '不存在的键该给 undefined');
  }

  {
    const kv = make();
    // checkpoint 里用得到「明确的 null」与 false，它们不能被折成 undefined
    for (const v of [null, false, 0, '', [], {}]) {
      await kv.set('k', v);
      assert.deepEqual(await kv.get('k'), v, `${JSON.stringify(v)} 没有原样存回来`);
    }
  }

  {
    const kv = make();
    await kv.set('k', { nested: { arr: [1, '2', null] } });
    assert.deepEqual(await kv.get('k'), { nested: { arr: [1, '2', null] } });
  }

  {
    const kv = make();
    await kv.set('k', 1);
    await kv.set('k', 2);
    assert.equal(await kv.get('k'), 2, 'set 该覆盖');
  }

  {
    const kv = make();
    await kv.set('a', 1);
    await kv.set('b', 2);
    await kv.remove('a');
    assert.equal(await kv.get('a'), undefined);
    assert.equal(await kv.get('b'), 2, 'remove 不该碰别的键');
  }

  {
    const kv = make();
    // 删不存在的键要静默通过——恢复流程里会无条件清一次 checkpoint
    await kv.remove('从来没写过');
  }
}
