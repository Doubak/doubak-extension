/**
 * Firefox 那条路：**后台事件页自己就是宿主**。
 *
 * ## 为什么这里什么都不用建
 *
 * offscreen document 存在的理由是 Chrome 的后台是个 **service worker**：那里没有
 * DOM，也起不了专用 Worker，而 `createSyncAccessHandle()` 只在专用 Worker 里可用。
 *
 * Firefox 的 MV3 后台是一个**事件页**——一个真的页面。实测（2026-09-09，
 * Firefox 155，见 `docs/firefox.md`）：`document` / `window` / `Worker` 都在，
 * 从它起的专用 Worker 里写入读回逐字节相符，共享的 FileStore 契约 20 条全过。
 *
 * 所以这条路**少一层，不是多一层**：没有文档要建，没有消息要发，
 * `callHost` 就是调那个函数。
 *
 * ## 为什么仍然走 `handleOp`，而不是各写一份
 *
 * `handleOp` 是那条 switch 的唯一实现，两个宿主共用。抄一份到这里，「一条流水线，
 * 两个宿主」就在这儿断了——而断了是静默的：两边都能跑，只是有一天开始给出不同的
 * 答案。这个仓库为同一个形状付过好几次学费（`sync-vendor`、删掉再重标、
 * `buildMarkdown` 少了私密过滤）。
 *
 * ## 静态 import，不是动态
 *
 * 这个文件本身是被 `host.js` **动态**引进来的，也就是说它只在挑中 Firefox 这条
 * 路时才加载。到了这一步，把整条抓取链拉进当前上下文正是我们要的——事件页就是
 * 它该跑的地方。
 */

import { handleOp } from '../offscreen/offscreen.js';

/**
 * 什么都不用建：我们已经在宿主里了。
 *
 * 保留这个函数是为了让两个实现形状一致——调用方不该知道自己在哪个浏览器上。
 */
export async function ensureHost() {}

/** 我们就在这儿，永远在。 */
export async function hasHost() {
  return true;
}

/**
 * 直接调，一条消息都不发。
 *
 * 注意**没有** JSON 边界：`Map` 不会被拍平，`Uint8Array` 不会变成
 * `{"0":1,…}`。这不代表可以往里塞字节——那条约束在 `host.js` 上，两个宿主共用；
 * 只在一边成立的约束，等于没有约束。
 *
 * @param {object} msg
 */
export async function callHost(msg) {
  return handleOp(msg);
}
