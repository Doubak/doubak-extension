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
 *
 * ## 持有者可能永远不返回
 *
 * 原来只在 `finally` 里放锁，那挡住了「抛异常」，**没挡住「永远不结算」**。
 * 实测撞到过：抓取跑着的时候合上电脑睡眠，醒来之后
 *
 *     心跳出错 已经有「抓取」在进行中（93990 秒前开始）
 *
 * ——26 小时。持有者那一段 `await` 再也没回来（睡眠期间 worker 线程或计时器
 * 被冻住的路径不止一条），于是锁**永久被占**。后果不是「慢一点」：此后每一次
 * 心跳、每一次「继续」、每一次「开始」全部被拒，而拒绝理由看起来还很合理。
 * 用户看到的是「点继续没反应」，唯一的出路是重装/重载扩展。
 *
 * 所以持有者必须**持续证明自己活着**（`touch()`），久不吭声就判定为死了、
 * 允许抢占。判据用「多久没吭声」而不是「持有了多久」：一次合法的抓取本来就
 * 可能持有十几分钟（一批 25 个请求，每个最坏 30 秒超时），但它**每抓一页都会
 * 吭一声**。
 *
 * 抢占之后老持有者万一活过来：它的 `finally` **不会**误放新持有者的锁（靠代号
 * 分辨）。而请求频率也不会翻倍——同一个 offscreen 里所有抓取共用一个
 * `RequestGate`，闸门那一层的并发恒为 1。
 */

/**
 * 多久没吭声就算死了。
 *
 * 下界由**一次合法的静默**决定：单个请求最坏 30 秒超时，加上写盘与退避，
 * 一两分钟内没有任何动静是可能的。取 5 分钟，留足余量——判早了会真的造成
 * 两条流叠加，那比多等几分钟严重得多。
 */
export const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

export class Exclusive {
  /**
   * @param {object} [opts]
   * @param {number} [opts.staleAfterMs]
   * @param {() => number} [opts.now]
   * @param {(info: {name: string, silentMs: number}) => void} [opts.onPreempt]
   *   抢占时的回调。**必须说出来**：静默地夺锁等于把一次异常变成看不见的事。
   */
  constructor({ staleAfterMs = DEFAULT_STALE_AFTER_MS, now = () => Date.now(), onPreempt } = {}) {
    /** @type {{name: string, since: number, beat: number, gen: number} | null} */
    this._held = null;
    this._staleAfterMs = staleAfterMs;
    this._now = now;
    this._onPreempt = onPreempt;
    this._gen = 0;
  }

  /** 现在被谁占着；没被占则为 null。 */
  get holder() {
    return this._held?.name ?? null;
  }

  get busy() {
    return this._held !== null;
  }

  /** 持有者已经多久没吭声（毫秒）。没被占则为 0。 */
  get silentMs() {
    return this._held ? this._now() - this._held.beat : 0;
  }

  /** 持有者是不是已经判定为死了。 */
  get stale() {
    return this._held !== null && this.silentMs > this._staleAfterMs;
  }

  /**
   * 「我还活着」。
   *
   * 持有者在**每次真的干了点什么**的时候调（每抓一页、每跑完一批）。不调的
   * 唯一后果就是被判定为死掉然后被抢占，所以宁可多调。
   */
  touch() {
    if (this._held) this._held.beat = this._now();
  }

  /**
   * 拿着锁跑一件事。已被占用且持有者还活着，则立刻抛。
   *
   * @template T
   * @param {string} name  给人看的名字，会出现在拒绝信息里
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(name, fn) {
    if (this._held && !this.stale) {
      const secs = Math.round((this._now() - this._held.since) / 1000);
      throw new Error(
        `已经有「${this._held.name}」在进行中（${secs} 秒前开始）。` +
          '同一时刻只能跑一件——两条请求流叠加会让实际请求频率翻倍，可能导致账号被限制。',
      );
    }
    if (this._held) {
      // 抢占。老持有者的 `finally` 会看代号，不会误放新锁。
      this._onPreempt?.({ name: this._held.name, silentMs: this.silentMs });
    }

    const gen = ++this._gen;
    this._held = { name, since: this._now(), beat: this._now(), gen };
    try {
      return await fn();
    } finally {
      // 必须在 finally 里放。抛异常时不放锁，等于一次失败就把整个扩展锁死到
      // 下次重启——而抓取里出错是常态。
      //
      // **但只放自己那一把。** 被抢占过的老持有者晚一步醒过来时，这里若无条件
      // 清掉 `_held`，放掉的是**新持有者**的锁——于是真的出现两条并行的流，
      // 正好是这个类存在的理由。
      if (this._held?.gen === gen) this._held = null;
    }
  }
}
