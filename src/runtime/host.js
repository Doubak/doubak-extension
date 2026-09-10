/**
 * 抓取跑在哪儿：**按能力挑一个宿主**。
 *
 * ## 为什么需要这一层
 *
 * 抓取不能跑在后台脚本自己身上，判据是两条硬的：
 *
 * - OPFS 的原地读写 `createSyncAccessHandle()` **只在专用 Worker 里可用**；
 * - 字节**过不了** `chrome.runtime.sendMessage`（那条通道只认 JSON，
 *   `Uint8Array` 过去会变成 `{"0":1,…}`）。
 *
 * 所以后台必须能起一个专用 Worker。而**它能不能起，各浏览器不一样**：
 *
 * | | 后台是什么 | 能直接起 Worker 吗 | 于是 |
 * |---|---|---|---|
 * | Chrome / Edge | service worker | ❌ | 先开一个 offscreen document，Worker 起在它里面 |
 * | Firefox | 事件**页** | ✅ | **不需要 offscreen**，直接起 —— 少一层，不是多一层 |
 *
 * Firefox 那一格是实测的（2026-09-09，Firefox 155，见 `docs/firefox.md`）：
 * 事件页里 `document` / `window` / `Worker` 都在，从它起的专用 Worker 里
 * `createSyncAccessHandle()` 写入读回逐字节相符，共享的 FileStore 契约 20 条全过。
 *
 * ## 判据是**能力**，不是浏览器名字
 *
 * `typeof api.offscreen?.createDocument === 'function'`。按 UA 或者按
 * 「有没有 browser 这个全局」去挑，都会在某天静默走错分支，而走错的症状是
 * **抓取根本起不来**——那是这个扩展唯一的不可逆步骤的入口。
 *
 * ## 两条分支的加载方式**必须不一样**（`#12`，2026-09-10）
 *
 * 1.4.0 里两条都写成动态 `import()`，于是安卓 Edge 上一按开始就是：
 *
 * ```
 * import() is disallowed on ServiceWorkerGlobalScope by the HTML specification.
 * ```
 *
 * **规范就是这么写的**（w3c/ServiceWorker#1356）。桌面 Chrome / Edge 给扩展的
 * service worker 开了口子，安卓 Edge 没有——也就是说 1.4.0 让 **Chrome 那条路
 * 也依赖一个规范明文禁止的特性**才走得通，只是桌面上看不出来。1.3.6 能跑正是
 * 因为它写的是静态 import。
 *
 * 所以两条分支分开处理，理由各自成立：
 *
 * - **Chrome 那条静态引**。`host-offscreen.js` 只引 `protocol.js`（一堆常量，
 *   零副作用），拉进 service worker 没有任何代价——这也是 1.3.6 的写法。
 * - **Firefox 那条动态引**。`host-page.js` 会把整条抓取链拉进当前上下文
 *   （它就是要在这儿跑），静态引的话 Chrome 的 service worker 会连
 *   `offscreen.js` 一起拖进来，而那个文件一加载就注册监听器、起 Worker。
 *   而 Firefox 的后台是**事件页**，`import()` 在那里本来就是允许的——
 *   这条禁令只管 service worker。
 *
 * 一般化的那句：**一个上下文放行了规范禁止的东西，不等于那条路是通的。**
 * 判据要按规范写，而不是按手边那个浏览器的宽容度写。
 *
 * ## 留给第三个宿主的位置
 *
 * `pickHost()` 是一张表，不是一个 `if`。将来要加的两种都已经看得见形状：
 * 移动版浏览器，以及万一 Firefox 的事件页扛不住几小时的抓取时的退路——把抓取放进
 * 面板标签页（标签页开着就活着，而整套架构本来就是每页写检查点、可恢复的）。
 * 加一个宿主 = 加一个实现文件 + 表里加一行，不该动这里的任何调用方。
 */

import * as offscreenHost from './host-offscreen.js';

/** @typedef {{ensureHost(): Promise<void>, hasHost(): Promise<boolean>, callHost(msg: object): Promise<any>}} HostImpl */

/** @type {Promise<HostImpl> | null} */
let picked = null;

/** 我们是不是正跑在一个 service worker 里。 */
function inServiceWorker() {
  return typeof ServiceWorkerGlobalScope !== 'undefined'
    && globalThis instanceof ServiceWorkerGlobalScope;
}

/** 挑中的实现。**Chrome 那条是静态引的，见文件头。** */
async function pickHost() {
  const api = globalThis.browser ?? globalThis.chrome;
  if (typeof api?.offscreen?.createDocument === 'function') return offscreenHost;

  // 既没有 offscreen，又跑在 service worker 里：事件页那条路在这儿走不通
  // （没有 document、没有 Worker），而且去 `import()` 它只会撞上上面那条禁令。
  //
  // **这一条要说得比那句规范错误有用。** #12 的教训就是「一句正确的话指向了
  // 完全错误的下一步」——用户看到 `import() is disallowed…` 只会去重装扩展。
  if (inServiceWorker()) {
    throw new Error(
      '这个浏览器上跑不了抓取：它的后台是 service worker，却没有 offscreen document，'
      + '而档案必须写在专用 Worker 里（OPFS 的 createSyncAccessHandle 只在那儿可用）。\n'
      + '不是登录问题，也不是重装能解决的。请到 '
      + 'https://github.com/Doubak/doubak-extension/issues 报一声，'
      + '带上浏览器名字和版本号——加一种宿主就是加一个实现文件。',
    );
  }

  return import('./host-page.js');
}

/** @returns {Promise<HostImpl>} */
function host() {
  picked ??= pickHost();
  return picked;
}

/**
 * 确保宿主在。
 *
 * 可以放心重复调用：**每次唤醒都调一次**才是对的用法。后台脚本死了以后内存里
 * 什么都不剩，所以「我上次建过了」这个念头本身就不可靠——只能每次都问浏览器。
 */
export async function ensureHost() {
  return (await host()).ensureHost();
}

/** @returns {Promise<boolean>} */
export async function hasHost() {
  return (await host()).hasHost();
}

/**
 * 往宿主发一条命令。
 *
 * **绝不传字节。** Chrome 那条路上这是一条 JSON 通道；Firefox 那条路上虽然是
 * 直接调函数，字节照样不该从这儿过——整条抓取链搬进宿主，就是为了让字节根本不用
 * 过这条界。两个宿主共用同一条约束，才不会有一天只在其中一边成立。
 *
 * @param {object} msg
 */
export async function callHost(msg) {
  return (await host()).callHost(msg);
}

/**
 * 确保在，然后发命令，并把出错还原成异常。
 *
 * @param {object} msg
 */
export async function withHost(msg) {
  await ensureHost();
  const r = await callHost(msg);
  if (!r) throw new Error('抓取宿主没有答复——它可能刚被关掉，下一次心跳会重建');
  if (!r.ok) {
    // 错误码要带过来。丢了它，上层只能拿字符串去猜——而「会话失效」与「这次操作
    // 失败了」该走的路完全不同。
    const err = new Error(r.error ?? '抓取宿主报了一个没有说明的错误');
    if (r.reason) /** @type {any} */ (err).reason = r.reason;
    throw err;
  }
  return r;
}

export { serializeScope } from './serialize-scope.js';
