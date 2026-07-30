/**
 * KvStore 的共享契约。
 *
 * 两个实现，而上层（`RunStore`）只认接口——它不该知道自己写在内存里还是写在
 * IndexedDB 里：
 *
 * | 实现 | 在哪 |
 * |---|---|
 * | `MemoryKvStore` | 测试与演练 |
 * | `IdbKvStore` | service worker 与 offscreen document（**同一个库**） |
 *
 * 两者行为必须一致。最容易分叉的是**边界值**：取不存在的键、存 `null`、存
 * `false`——它们都可能被某个实现悄悄折成 `undefined`，而 checkpoint 里恰好
 * 用得到「明确的 null」。
 */

/*
 * **不许 import `node:` 任何东西。**
 *
 * 这个文件同时被两边用：Node 的 `node:test`，以及**浏览器里的 selftest**。
 * `import 'node:assert'` 在 Worker 里会让整个模块加载失败，而失败的样子是
 * `ErrorEvent` 上什么信息都没有——自检页只能显示「Worker 出错：undefined」。
 *
 * 这件事真的发生过，代价是一整轮往返。所以这里自带断言，
 * 和 `file-store-contract.js` 一样。`test/no-node-builtins.test.js` 钉着这条。
 */

/** @param {unknown} a @param {unknown} b @param {string} msg */
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
}

/** 结构相等。契约里存的都是 JSON 能表达的值，所以按序列化比就够。 */
function deepEq(a, b, msg) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg}（期望 ${sb}，实际 ${sa}）`);
}

/** @param {() => import('../../src/storage/kv-store.js').KvStore} make */
export async function kvStoreContract(make) {
  {
    const kv = make();
    eq(await kv.get('从来没写过'), undefined, '不存在的键该给 undefined');
  }

  {
    const kv = make();
    // checkpoint 里用得到「明确的 null」与 false，它们不能被折成 undefined
    for (const v of [null, false, 0, '', [], {}]) {
      await kv.set('k', v);
      deepEq(await kv.get('k'), v, `${JSON.stringify(v)} 没有原样存回来`);
    }
  }

  {
    const kv = make();
    await kv.set('k', { nested: { arr: [1, '2', null] } });
    deepEq(await kv.get('k'), { nested: { arr: [1, '2', null] } }, '嵌套结构没有原样存回来');
  }

  {
    const kv = make();
    await kv.set('k', 1);
    await kv.set('k', 2);
    eq(await kv.get('k'), 2, 'set 该覆盖');
  }

  {
    const kv = make();
    await kv.set('a', 1);
    await kv.set('b', 2);
    await kv.remove('a');
    eq(await kv.get('a'), undefined, 'remove 之后该取不到');
    eq(await kv.get('b'), 2, 'remove 不该碰别的键');
  }

  {
    const kv = make();
    // 删不存在的键要静默通过——恢复流程里会无条件清一次 checkpoint
    await kv.remove('从来没写过');
  }
}
