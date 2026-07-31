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
    this._running = false;
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
    // **这里不能置 `_running`。**
    //
    // 那个标志的含义是「有一段推进正在飞」，而 `startRun()` 不推进——真正推进的是
    // 紧随其后由 background 直接调用的 `drive()`，它走的不是这条路，也就没人会来清。
    // 于是标志一直是 true，此后每一次心跳都在这里掉头返回「已经在跑了」，抓取
    // **在第一段之后就停住**。
    //
    // 真实日志：一次「推进结果 …captured:25…」，然后十几次「心跳 → 未恢复」，
    // 直到用户重新加载扩展把内存清零。
    //
    // 上一次修的是 `tick()` 里忘了在 finally 清；这是同一个标志的另一个写入点，
    // 而它压根就不该写。并发防护本来就有三层，都不依赖它：`Exclusive` 全局互斥、
    // offscreen 的 `driving` 复用同一个 promise、以及 tick 自己的这个检查。
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
    this._running = false;
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
    this._running = false;
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

    if (this._running) {
      // **有一段推进正在飞**，不要再开一段。worker 会被反复唤醒（心跳、启动检查、
      // 界面命令），两段并行推进会让同一个 frontier 被两个循环消费。
      return { acted: false, decision };
    }

    this._running = true;
    try {
      await this._hooks.onResume();
    } finally {
      // **必须在 finally 里清。**
      //
      // 早先只有 `pauseRun()` / `finishRun()` 会把它清掉——而一段推进的**正常**结局
      // 是「预算用完了，还没抓完」，那两个都不会被调用。于是 `_running` 永远是 true，
      // 此后每一次心跳都直接返回「已经在跑了」，**抓取就此停住**。
      //
      // 真实日志里的样子：一次「推进结果 …captured:25…」，然后连续十几次
      // 「心跳 → 未恢复」。抓取只在 service worker 被杀、内存清零之后才会再走一段。
      this._running = false;
    }
    return { acted: true, decision };
  }

  get running() {
    return this._running;
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
