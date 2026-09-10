/**
 * 宿主怎么挑出来的 —— 这一条是**跑**出来的，不是读源码读出来的。
 *
 * `test/offscreen-contract.test.js` 从源码上钉住了「谁静态引、谁动态引」，那是
 * 必要的（`import()` 与 `from` 长得像，运行时后果相反）。但它答不了第三格：
 * **既没有 offscreen、又跑在 service worker 里的时候，说了句什么。**
 *
 * 那一格是 `Doubak/doubak-extension#12` 的落点。1.4.0 在安卓 Edge 上抛的是
 *
 * ```
 * import() is disallowed on ServiceWorkerGlobalScope by the HTML specification.
 * ```
 *
 * 一句**完全正确**的话，指向一条修不好的路——用户只会去重装扩展。这个仓库为
 * 同一个形状付过两次学费（#12 那句「无法判断登录状态」本身就是第一次），所以
 * 这句替代的话要有测试看着：它必须说出「这个浏览器跑不了」和「去哪儿报」，
 * 而且**不许**把人指回登录或者重装。
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 每次都要一份**全新**的模块。
 *
 * `host.js` 把挑中的宿主缓存在 `picked` 里——那正是它该做的（后台每次唤醒都会
 * 调 `ensureHost()`），但也意味着一份模块只能测一格。
 */
let fresh = 0;
const loadHost = () => import(`../src/runtime/host.js?fresh=${fresh++}`);

describe('抓取宿主怎么挑（#12）', () => {
  afterEach(() => {
    delete (/** @type {any} */ (globalThis)).chrome;
    delete (/** @type {any} */ (globalThis)).browser;
    delete (/** @type {any} */ (globalThis)).ServiceWorkerGlobalScope;
  });

  test('有 offscreen 就用它 —— 而且不经过 import()', async () => {
    // 这一格在 Node 里跑得起来，恰恰证明了它是静态引的：动态 `import()` 在
    // Node 里也能跑，所以「跑通了」本身不算证据，但它与源码那条检查合起来算。
    let created = 0;
    (/** @type {any} */ (globalThis)).chrome = {
      offscreen: {
        createDocument: async () => { created += 1; },
        Reason: { WORKERS: 'WORKERS' },
      },
      runtime: {
        getContexts: async () => [],
        getURL: (/** @type {string} */ p) => `chrome-extension://x/${p}`,
      },
    };

    const { ensureHost } = await loadHost();
    await ensureHost();
    assert.equal(created, 1, '挑中的不是 offscreen 那条路');
  });

  test('没有 offscreen 又在 service worker 里：说清楚，别丢一句规范', async () => {
    (/** @type {any} */ (globalThis)).chrome = { runtime: {} };
    // `globalThis instanceof ServiceWorkerGlobalScope` —— Node 里没有这个类，
    // 用 hasInstance 造一个等价的判定，比伪造一个全局对象轻。
    (/** @type {any} */ (globalThis)).ServiceWorkerGlobalScope = {
      [Symbol.hasInstance]: (/** @type {unknown} */ x) => x === globalThis,
    };

    const { ensureHost } = await loadHost();
    await assert.rejects(ensureHost(), (/** @type {any} */ err) => {
      const m = String(err.message);
      assert.match(m, /service worker/, '要说出这台浏览器缺的是什么');
      assert.match(m, /issues/, '要给出下一步——加一种宿主就是加一个实现文件');
      // **反向也要钉，而且要钉本体不是代理。** 第一版写的是「消息里不许出现
      // 『登录』二字」——它当场把自己判红了，因为这句话**正需要**说「不是登录
      // 问题」。禁一个词禁的是字面，要的却是「别把人送回那条修不好的路」，
      // 而做到这件事最好的办法恰恰是把那条路点名否掉。
      assert.match(m, /不是登录问题/, '#12 的教训：要主动挡掉「再登录一次」那条路');
      assert.equal(/import\(\)/.test(m), false, '别把规范原文丢给用户');
      return true;
    });
  });

  test('事件页那条路不在这儿判 —— 它由源码那条检查钉住', () => {
    // 说明为什么上面只有两格：第三格要真的加载 `host-page.js`，而它会把
    // `offscreen.js` 拉进来——那个文件一加载就注册监听器、起 Worker，在 Node
    // 里根本走不到。所以它归 offscreen-contract.test.js 的静态图管。
    //
    // 写成一条会通过的测试而不是一句注释，是因为注释会在下一个人补这一格时
    // 被跳过，而一条命名清楚的测试会让他先读到「为什么不在这儿」。
    assert.ok(true);
  });
});
