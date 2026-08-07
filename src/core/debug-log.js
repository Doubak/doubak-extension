/**
 * 详细日志开关。
 *
 * ## 为什么不是「发布前删掉」
 *
 * `background.js` 与 `offscreen.js` 里那三十来行 `debugLog` 原来标着
 * `TODO(debug): 发布前删`。真到了要处理它的时候，回头看这批日志的战绩：
 *
 * | 查出来的问题 | 靠的是哪句 |
 * |---|---|
 * | 合盖睡眠后锁被永久占住 26 小时 | `心跳出错 已经有「抓取」在进行中（93990 秒前开始）` |
 * | 123 张封面全是 418 | `capture · asset.subject_cover` 连着刷 |
 * | 「像是同时跑了好几个实例」其实是并发保护在工作 | `已经有「抓取」在进行中（6 秒前开始）` |
 * | 一次推进空转 780 秒 | 时间戳之间的空档 |
 *
 * 每一条都是用户把控制台贴过来才定位到的。**删掉它们等于在扩展即将见到真实用户的
 * 那一刻，把唯一的远程诊断通道关掉。**
 *
 * 所以那个 TODO 的正确解法不是删，是**默认关掉、需要时能打开**：发布版控制台干净，
 * 用户报问题时打开开关重现一次，日志就回来了。
 *
 * ## 开关存在 IndexedDB
 *
 * 不能用 `chrome.storage`——offscreen document 拿不到它（见 offscreen.js 开头那张
 * API 表）。而 IndexedDB 在 service worker、offscreen、面板三处都是普通 DOM API，
 * 同源同库，谁都不需要求谁。这和抓取状态存哪儿是同一个理由。
 *
 * ## 读不到就当关着
 *
 * 失败方向是安全的：最坏情况是「用户打开了开关但没生效」，用户会再点一次。反过来
 * （读不到就当开着）会让发布版无条件刷日志，那才是这个开关要避免的事。
 */

/** IndexedDB 里的键名。三个上下文共用同一个。 */
export const DEBUG_LOG_KEY = 'doubak.debugLog';

/**
 * 当前是否输出。
 *
 * 是模块级变量而不是每次去读 IndexedDB：日志调用在热路径上（每抓一页几次），
 * 而异步读会把 `debugLog()` 变成 async，那会污染每一个调用点。
 */
let enabled = false;

/**
 * 造一个带前缀的日志函数。
 *
 * 前缀区分上下文——`[doubak]` 是 service worker，`[doubak/offscreen]` 是 offscreen。
 * 两边的日志混在同一个控制台里，没有前缀就分不清是谁说的。
 *
 * @param {string} prefix
 * @returns {(...args: unknown[]) => void}
 */
export function makeDebugLog(prefix) {
  return (...args) => {
    if (enabled) console.log(prefix, ...args);
  };
}

/**
 * 从存储里读开关。**启动时调用一次。**
 *
 * @param {{get: (k: string) => Promise<unknown>}} kv
 * @returns {Promise<boolean>}
 */
export async function loadDebugFlag(kv) {
  try {
    enabled = (await kv.get(DEBUG_LOG_KEY)) === true;
  } catch {
    // 读不到就当关着。见文件开头。
    enabled = false;
  }
  return enabled;
}

/**
 * 写开关，并让本上下文立刻生效。
 *
 * 另外两个上下文要等下次启动——service worker 约 30 秒就会重启一次，offscreen 会
 * 跟着下一次抓取重建，所以实际上不用等多久。为此加一套跨上下文广播不值得：
 * 这是个排查用的开关，不是功能。
 *
 * @param {{set: (k: string, v: unknown) => Promise<unknown>}} kv
 * @param {boolean} on
 */
export async function setDebugFlag(kv, on) {
  enabled = on === true;
  await kv.set(DEBUG_LOG_KEY, enabled);
  return enabled;
}

/** 只读当前状态，供界面显示。 */
export function debugEnabled() {
  return enabled;
}
