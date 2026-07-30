/**
 * service worker ↔ offscreen document 之间的协议常量。
 *
 * 单独一个文件，是为了让两边都能引它而**不会把对方整个模块拉进来**：
 * `offscreen.js` 一加载就会起 Worker、注册消息监听器；那些副作用绝不能在
 * service worker 里发生。
 */

/**
 * 消息的收件人。
 *
 * `chrome.runtime.sendMessage` 是广播式的——面板、自检页、offscreen 会收到同一条
 * 消息。不带收件人的话它们会互相抢答，而先答的那个赢，表现出来是随机失败。
 */
export const OFFSCREEN_TARGET = 'offscreen';
