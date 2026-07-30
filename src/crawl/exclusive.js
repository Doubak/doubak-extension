/**
 * 互斥锁：同一时刻只允许一件会发请求的事在跑。
 *
 * ## 为什么这是账号安全问题，不是并发整洁问题
 *
 * 节奏控制（`Pacer` / `RequestGate`）是**按活动**建的：一次抓取一个闸门、
 * `discoverUsername` 又一个、演练又一个。所以两件活动同时跑的时候，各自都遵守
 * 「1 秒一个请求」，合起来却是 **2 秒 3 个**——而豆瓣看到的是后者。
 *
 * 把账号搞封是不可接受的结果，不是可容忍的风险。所以这件事必须用结构挡住，
 * 而不是靠「用户不会那么点」。真实的触发路径都很平常：
 *
 * | 怎么发生 | 后果 |
 * |---|---|
 * | 面板开了两个标签页，两边都点了「开始抓取」 | 两条请求流 |
 * | 抓取跑着，去调试页点了「小范围试跑」 | 两条请求流 |
 * | 抓取跑着，点了演练 | 演练不发请求，但会和抓取抢 frontier / 写入器状态 |
 * | 心跳唤醒时上一段还没跑完 | 同一个 frontier 被两个循环消费 |
 *
 * ## 拒绝，不排队
 *
 * 排队意味着第二件事会在用户不知道的时候自己开始跑——而它可能是十几分钟以后。
 * 对一个「每个请求都算账」的工具来说，静默地延后启动比直接说「已经有一个在跑」
 * 糟糕得多。
 *
 * 所以 `run()` 在锁被占时**立刻拒绝**，并说清楚是被谁占着。
 *
 * ## 为什么不是每个操作都要锁
 *
 * `pause`、`status` 必须能在抓取跑着的时候进去——否则「暂停」按钮会在一段
 * 22 秒的批次期间失灵，而用户按暂停往往正是因为他看到了不对的东西。锁只圈住
 * **会发请求或会动抓取状态**的操作。
 */

export class Exclusive {
  constructor() {
    /** @type {{name: string, since: number} | null} */
    this._held = null;
  }

  /** 现在被谁占着；没被占则为 null。 */
  get holder() {
    return this._held?.name ?? null;
  }

  get busy() {
    return this._held !== null;
  }

  /**
   * 拿着锁跑一件事。已被占用则立刻抛。
   *
   * @template T
   * @param {string} name  给人看的名字，会出现在拒绝信息里
   * @param {() => Promise<T>} fn
   * @param {() => number} [now]
   * @returns {Promise<T>}
   */
  async run(name, fn, now = () => Date.now()) {
    if (this._held) {
      const secs = Math.round((now() - this._held.since) / 1000);
      throw new Error(
        `已经有「${this._held.name}」在进行中（${secs} 秒前开始）。` +
          '同一时刻只能跑一件——两条请求流叠加会让实际请求频率翻倍，可能导致账号被限制。',
      );
    }

    this._held = { name, since: now() };
    try {
      return await fn();
    } finally {
      // 必须在 finally 里放。抛异常时不放锁，等于一次失败就把整个扩展锁死到
      // 下次重启——而抓取里出错是常态。
      this._held = null;
    }
  }
}
