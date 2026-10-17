/**
 * Chrome 那条路：service worker 起一个 offscreen document，Worker 起在它里面。
 *
 * **两个安装包都静态加载此模块，只有 Chrome 会调用它**（`host.js` 按能力选宿主）。
 * Firefox 没有 `chrome.offscreen`，它的后台本来就是页面，见 `host-page.js`。
 *
 * 为什么抓取跑在 offscreen 里，见 `src/offscreen/offscreen.js` 开头。简版：
 * service worker 不是专用 Worker，`createSyncAccessHandle()` 用不了，所以它
 * 写不了 OPFS；而把字节转发过去也不行，`chrome.runtime.sendMessage` 只认 JSON。
 */

import { OFFSCREEN_TARGET } from '../offscreen/protocol.js';

export const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/** 同时只能存在一个 offscreen document，所以建之前必须先查。 */
let creating = null;

/**
 * 确保 offscreen document 存在。
 *
 * 可以放心重复调用：**每次唤醒都调一次**才是对的用法。service worker 死了以后
 * 内存里什么都不剩，所以「我上次建过了」这个念头本身就不可靠——只能每次都问
 * 浏览器。
 */
export async function ensureHost() {
  // 并发保护：闹钟、界面命令、启动检查可能同时走到这里，而重复
  // createDocument 会抛「Only a single offscreen document may be created」。
  if (creating) return creating;
  creating = (async () => {
    try {
      if (!(await hasHost())) await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        // WORKERS：我们要的就是在里面起一个专用 Worker 来写 OPFS。
        reasons: [chrome.offscreen.Reason?.WORKERS ?? 'WORKERS'],
        justification:
          '抓取与写档案需要专用 Worker（OPFS 的 createSyncAccessHandle 只在专用 Worker 中可用），' +
          '而 service worker 无法承载。',
      });
    } catch (e) {
      // 竞态下另一个调用可能刚好建完了。那不是错误。
      if (!/single offscreen document/i.test(String(e?.message ?? e))) throw e;
    }
    // getContexts/createDocument 只证明文档已建，ES module 可能还没注册监听器。
    // 只重试无副作用的 ping；start 等写命令永远只发一次。
    await waitForHost();
  })();
  try { await creating; } finally { creating = null; }
}

/** 等消息监听器就绪；只重试无副作用的握手。 */
async function waitForHost() {
  const attempts = 40;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { if ((await callHost({ op: 'ping' }))?.ok) return; } catch { /* 模块仍在启动 */ }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('抓取组件未能就绪。请在扩展管理页重新加载豆备，再刷新面板；已有档案会保留。');
}

/** @returns {Promise<boolean>} */
export async function hasHost() {
  // getContexts 是权威答案。用 ping 试探是不行的——offscreen 正在启动时
  // ping 会失败，于是我们会去建第二个，然后撞上「只能有一个」。
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    return ctx.length > 0;
  }
  // 老一点的 Chrome 没有 getContexts。退回到 ping，并接受它偶尔误判。
  return callHost({ op: 'ping' }).then((r) => Boolean(r?.ok), () => false);
}

/**
 * 往 offscreen 发一条命令。
 *
 * **绝不传字节**：这条通道只认 JSON，`Uint8Array` 过去会变成
 * `{"0":1,"1":2,…}`。整条抓取链之所以搬进 offscreen，就是为了让字节根本不用
 * 过这条界。
 *
 * @param {object} msg
 */
export function callHost(msg) {
  return chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, ...msg });
}
