/**
 * 生命周期监管：让抓取在 service worker 被杀之后自己回来。
 *
 * 设计：DESIGN.md F-10a/b/c
 *
 * ## MV3 的现实
 *
 * service worker 约 30 秒空闲就被杀，系统休眠、进程崩溃、浏览器重启也都会
 * 让它没。对一场几小时的抓取，这不是异常情况，而是**常态**——一次抓取过程中
 * 会被杀掉几十上百次。
 *
 * 所以设计目标不是「别被杀」，而是：
 *
 * > **被杀掉必须等价于一次可恢复的空操作。**
 *
 * 做到这一点靠两件事：每抓完一页就落盘（内存里不留唯一副本），以及一个能把
 * worker 叫醒的心跳。
 *
 * ## 心跳用 chrome.alarms，不用 setTimeout
 *
 * `setTimeout` 活在 worker 的内存里，worker 一死它就没了。`chrome.alarms`
 * 由浏览器持有，**跨 worker 生命周期存活，也跨浏览器重启存活**，系统休眠
 * 期间挂起、醒来后补发。
 *
 * 这就是「自恢复」而不是「手动重新触发」的关键：闹钟是唯一一个我们死了它
 * 还在的东西。
 *
 * ## 醒来之后不一定接着抓
 *
 * 见 resume-policy.js：只有**意外中断**才自动继续；风控、验证码、会话失效、
 * 用户暂停一律等人。醒来就重试一个软封锁，正是把限流升级成封号的路径。
 */

import { decideResume, CRASH_SENTINEL_REASON } from './resume-policy.js';

/** 心跳周期。MV3 的最小周期是 30 秒。 */
export const HEARTBEAT_PERIOD_MINUTES = 0.5;

export const ALARM_NAME = 'doubak-heartbeat';

/**
 * 抓取运行状态的持久化载体。
 *
 * 刻意做成接口注入：真实实现写 IndexedDB，测试用内存实现。
 * 监管逻辑本身不碰任何浏览器 API，因此可以完全在 Node 里测。
 *
 * @typedef {object} RunStore
 * @property {() => Promise<object | null>} loadCheckpoint
 * @property {(cp: object) => Promise<void>} saveCheckpoint
 * @property {() => Promise<void>} clearCheckpoint
 */

/**
 * @typedef {object} SupervisorHooks
 * @property {() => Promise<void>} onResume      真正开始/继续抓取
 * @property {(d: object) => Promise<void>} [onBlocked]  不恢复时的通知
 */

export class Supervisor {
  /**
   * @param {object} opts
   * @param {RunStore} opts.store
   * @param {SupervisorHooks} opts.hooks
   * @param {object} [opts.alarms]  chrome.alarms 的注入点
   * @param {() => number} [opts.now]
   */
  constructor({ store, hooks, alarms, now = () => Date.now() }) {
    this._store = store;
    this._hooks = hooks;
    this._alarms = alarms ?? null;
    this._now = now;
  }

  /**
   * 开始一次抓取。
   *
   * **先写一个 `crash` 的 checkpoint 再开工**——这是崩溃检测的全部机制：
   * 正常暂停或结束时会改写它，所以「它还是 crash」本身就是崩溃的证据。
   * worker 被杀时没有机会写任何东西，指望它临终留言是不现实的。
   *
   * @param {object} initial  初始 checkpoint 内容（bundle_id、frontier 等）
   */
  async startRun(initial) {
    await this._store.saveCheckpoint({
      ...initial,
      pause_reason: CRASH_SENTINEL_REASON,
      paused_at: new Date(this._now()).toISOString(),
    });
    await this._ensureHeartbeat();
    // 这里**什么内存标志都不置**。「现在有没有一段推进在飞」不是这个进程知道的事
    // ——推进跑在 offscreen 里，而 service worker 每 30 秒就被杀一次。曾经有过一个
    // `_running` 标志，它连着出过三次事，最后被删掉了；理由见 `tick()`。
  }

  /**
   * 记录一次刻意的停止。
   *
   * 与 startRun 的哨兵相对：把原因改写成真实原因，于是下次醒来时
   * resume-policy 就知道这不是崩溃。
   *
   * @param {string} reason
   * @param {object} [extra]  比如 rate_state
   */
  async pauseRun(reason, extra = {}) {
    const cp = (await this._store.loadCheckpoint()) ?? {};
    await this._store.saveCheckpoint({
      ...cp,
      ...extra,
      pause_reason: reason,
      paused_at: new Date(this._now()).toISOString(),
    });
  }

  /**
   * 用户点了「继续」：把停机原因**改回崩溃哨兵**。
   *
   * 少了这一步会有两个后果，都被报上来过：
   *
   * 1. **通知每 30 秒再弹一次。** 心跳唯一的判据就是 `pause_reason`。它还写着
   *    `user_paused`（`autoResume: false`、`userVisible: true`），于是每一次心跳都
   *    判定「不恢复」并再弹一条「需要你处理：你手动暂停了抓取」——而用户刚刚点的
   *    正是继续。
   * 2. **worker 一被杀就再也不回来了。** 心跳会认定用户不想跑，不再自恢复。
   *
   * 改回哨兵是对的：从这一刻起，「醒来时原因还是它」的含义又变回了「我们没来得及
   * 改写它，也就是崩了」。
   *
   * @param {object} [extra]
   */
  async resumeRun(extra = {}) {
    const cp = await this._store.loadCheckpoint();
    if (!cp) return false;
    await this._store.saveCheckpoint({
      ...cp,
      ...extra,
      pause_reason: CRASH_SENTINEL_REASON,
      paused_at: new Date(this._now()).toISOString(),
    });
    await this._ensureHeartbeat();
    return true;
  }

  /** 抓取干净地结束了：清掉 checkpoint 并停掉心跳。 */
  async finishRun() {
    await this._store.clearCheckpoint();
    await this._clearHeartbeat();
  }

  /**
   * 心跳触发时调用。也用于 `onStartup` 与扩展被重新拉起时。
   *
   * **幂等**：连续调用多次不会重复开工。worker 可能因为各种事件被反复唤醒，
   * 每次都要能安全地跑一遍。
   *
   * @returns {Promise<{acted: boolean, decision: object}>}
   */
  async tick() {
    const cp = await this._store.loadCheckpoint();
    const decision = decideResume(cp, { now: this._now() });

    if (!cp) {
      // 没有未完成的抓取，心跳就没必要继续了
      await this._clearHeartbeat();
      return { acted: false, decision };
    }

    // 有未完成的抓取，心跳必须在——哪怕现在不恢复（比如在等冷却），
    // 也要保证以后还能被叫醒。
    await this._ensureHeartbeat();

    if (!decision.resume) {
      if (decision.userVisible && this._hooks.onBlocked) {
        await this._hooks.onBlocked(decision);
      }
      return { acted: false, decision };
    }

    // **这里没有「已经在跑了吗」的内存标志。**
    //
    // 曾经有过一个 `_running`，它连着出了三次事，一次比一次贵：`startRun()` 置了
    // 它却没人清；`tick()` 忘了在 finally 里清；最后是这一次——`onResume()` 里那个
    // `await` **永远没有回来**（offscreen 里的一段推进卡死了），于是标志永久为真。
    //
    // 真实日志：两次「推进结果 …captured:25…」，然后 **282 次**「心跳 → 未恢复」，
    // 整整 8494 秒。
    //
    // 前两次都被当成「忘了清」修掉了，但根子不在清没清干净，而在**这个进程根本
    // 无权回答这个问题**：推进跑在 offscreen 里，而这里是一个每 30 秒就被杀一次、
    // 内存随时清零的 service worker。它手上那个布尔量描述的是别人的状态。
    //
    // 更糟的是这个标志挡住了什么。卡死本来有救：`Exclusive` 会在持有者 5 分钟
    // 不吭声后判它死、允许抢占，而抢占的入口正是 `onResume()` 里那句
    // `withOffscreen({ op: 'resume' })`。标志一挡，**心跳连问都没问过锁**——
    // 那 282 次唤醒一次都没走到自救机制跟前。
    //
    // 一道防线，只有在它保护的那件事没发生时才够得着，就等于没有。
    //
    // 所以判断交给知道答案的那一层。锁被一段活着的推进占着时抛 `busy`，闹钟那边
    // 认这个码、记一句「上一段还在跑，跳过」；持有者已判死时它会抢占并接着抓。
    // 两种情形都比一个猜出来的布尔量准。
    await this._hooks.onResume();
    return { acted: true, decision };
  }

  async _ensureHeartbeat() {
    if (!this._alarms) return;
    const existing = await this._alarms.get?.(ALARM_NAME);
    if (existing) return;
    await this._alarms.create(ALARM_NAME, { periodInMinutes: HEARTBEAT_PERIOD_MINUTES });
  }

  async _clearHeartbeat() {
    if (!this._alarms) return;
    await this._alarms.clear?.(ALARM_NAME);
  }
}
