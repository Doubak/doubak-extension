/**
 * 节奏控制：请求间隔、抖动、退避。
 *
 * 设计：DESIGN.md F-04b、F-06d
 *
 * ## 立场
 *
 * 把用户的豆瓣账号搞封是**不可接受的结果，不是可容忍的风险**。对流散用户来说，
 * 注册手机号早已停用、短信验证过不去，一次封禁就是永久失去他们本来要抢救的
 * 那份数据。所以这里的默认值一律偏保守，宁可慢。
 *
 * ## 我们不知道豆瓣的真实限额，也不能去试
 *
 * 唯一能确定限额的办法是撞上去，而那正是要不惜代价避免的事。所以默认值是
 * **有理由的保守猜测**，不是实测结论：
 *
 * - 前代实现与 tofu 都用 1 秒固定间隔，且都没被封过（样本极小，不能当依据）
 * - 我们默认 3 秒并带抖动，比它们更慢
 * - 已登录会话的限额更高，但**不能**因此加速：会话随时可能掉，而掉了之后
 *   按已登录的节奏继续跑，等于拿更严的配额去撞（见 session.js）
 *
 * 这些值必须可调，且真实抓取后要按观察到的情况回头修正。
 *
 * ## 降速之后不自动恢复
 *
 * 退避层级**只增不减**。理由：一次软封锁说明我们已经踩到了边界，而边界在
 * 哪儿我们并不知道；自动恢复原速等于假设「刚才那次是偶然」，那是没有依据的
 * 乐观。层级跨会话保留（写进 checkpoint），所以关掉浏览器再回来也不会偷偷
 * 变快。
 */

/** 默认基础间隔。保守猜测，不是实测值。 */
export const DEFAULT_INTERVAL_MS = 3000;

/** 抖动幅度：±30%。避免形成过于规整的请求节律。 */
export const DEFAULT_JITTER_RATIO = 0.3;

/** 每次软封锁把间隔乘以这个系数。 */
export const BACKOFF_FACTOR = 2;

/** 间隔上限。再慢就没有实用价值了，此时应当让用户改天再来。 */
export const MAX_INTERVAL_MS = 60_000;

/**
 * 软封锁之后建议的冷却时间。
 *
 * 这不是「等这么久就一定好了」——豆瓣不会告诉我们限制何时解除。它是给用户的
 * 建议值，界面上会写成「建议等待 30 分钟以上再继续」。
 */
export const COOLDOWN_MS = [30 * 60_000, 60 * 60_000, 4 * 60 * 60_000];

export class Pacer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.intervalMs]   基础间隔
   * @param {number} [opts.jitterRatio]  抖动比例，0 表示不抖
   * @param {number} [opts.backoffLevel] 恢复时传入已有层级
   * @param {() => number} [opts.random] 便于测试注入
   */
  constructor({
    intervalMs = DEFAULT_INTERVAL_MS,
    jitterRatio = DEFAULT_JITTER_RATIO,
    backoffLevel = 0,
    random = Math.random,
  } = {}) {
    if (!(intervalMs > 0)) throw new Error(`intervalMs 必须为正: ${intervalMs}`);
    if (jitterRatio < 0 || jitterRatio >= 1) {
      throw new Error(`jitterRatio 必须在 [0, 1) 内: ${jitterRatio}`);
    }
    if (!Number.isInteger(backoffLevel) || backoffLevel < 0) {
      throw new Error(`backoffLevel 必须是 >=0 的整数: ${backoffLevel}`);
    }

    this._base = intervalMs;
    this._jitter = jitterRatio;
    this._level = backoffLevel;
    this._random = random;
  }

  /** 当前退避层级。只增不减。 */
  get level() {
    return this._level;
  }

  /** 当前的有效间隔（未加抖动）。 */
  get intervalMs() {
    return Math.min(this._base * BACKOFF_FACTOR ** this._level, MAX_INTERVAL_MS);
  }

  /** 是否已经退到最慢——此时应当建议用户改天再来。 */
  get atMaxInterval() {
    return this.intervalMs >= MAX_INTERVAL_MS;
  }

  /**
   * 下一次请求前应当等待多久。
   *
   * 带抖动：避免形成规整的请求节律。抖动是对称的，因此**长期均值仍等于
   * 基础间隔**——抖动不是用来偷偷加速的。
   *
   * @returns {number} 毫秒
   */
  nextDelayMs() {
    const base = this.intervalMs;
    if (this._jitter === 0) return base;
    // random() ∈ [0,1) → 系数 ∈ [1-j, 1+j)
    const factor = 1 - this._jitter + this._random() * this._jitter * 2;
    return Math.round(base * factor);
  }

  /**
   * 记一次软封锁：降速。
   *
   * **只增不减。** 没有对应的 speedUp()——那是刻意的。
   *
   * @returns {{level: number, intervalMs: number, cooldownMs: number}}
   */
  slowDown() {
    this._level += 1;
    return {
      level: this._level,
      intervalMs: this.intervalMs,
      cooldownMs: this.recommendedCooldownMs(),
    };
  }

  /**
   * 软封锁后建议的冷却时长。
   *
   * 随层级递增：第一次半小时，第二次一小时，之后四小时。豆瓣不会告诉我们
   * 限制何时解除，所以这是建议不是保证。
   */
  recommendedCooldownMs() {
    if (this._level === 0) return 0;
    return COOLDOWN_MS[Math.min(this._level - 1, COOLDOWN_MS.length - 1)];
  }

  /** 写进 checkpoint 的状态。降速这件事必须跨会话保留。 */
  serialize() {
    return { interval_ms: this._base, backoff_level: this._level };
  }

  /**
   * 从 checkpoint 恢复。
   *
   * 恢复后**不会**回到原速——这正是把 backoff_level 写进 checkpoint 的意义。
   *
   * @param {{interval_ms?: number, backoff_level?: number}} state
   * @param {object} [opts]
   */
  static restore(state, opts = {}) {
    return new Pacer({
      intervalMs: state?.interval_ms ?? DEFAULT_INTERVAL_MS,
      backoffLevel: state?.backoff_level ?? 0,
      ...opts,
    });
  }
}

/**
 * 请求闸门：保证同域并发恒为 1，且两次请求之间隔够时间。
 *
 * 并发 1 没有例外。抓取是个能跑几小时的后台任务，多开几路省下的时间对用户
 * 没有意义，换来的却是成倍的风控暴露。
 */
export class RequestGate {
  /**
   * @param {object} opts
   * @param {Pacer} opts.pacer
   * @param {(ms: number) => Promise<void>} [opts.sleep]
   * @param {() => number} [opts.now]
   */
  constructor({ pacer, sleep, now = () => Date.now() }) {
    this._pacer = pacer;
    this._now = now;
    this._sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    // 用 null 而不是 0 当「还没发过请求」的哨兵：0 是一个合法的时间戳，
    // 拿它当哨兵在注入时钟的测试里会直接撞上（真实 Date.now() 撞不上，
    // 于是这类 bug 会一路潜伏到某天换了时间源才爆）。
    /** @type {number | null} */
    this._lastRequestAt = null;
    /** @type {Promise<void>} 串行化用的尾链 */
    this._tail = Promise.resolve();
  }

  /**
   * 排队等待一个可以发请求的时机。
   *
   * 调用方拿到返回值之后再发请求。并发由这里串行化——同时调用多次也会
   * 一个接一个地放行。
   *
   * @returns {Promise<{waitedMs: number}>}
   */
  async acquire() {
    const run = this._tail.then(async () => {
      const target = this._pacer.nextDelayMs();
      const wait =
        this._lastRequestAt === null
          ? 0
          : Math.max(0, target - (this._now() - this._lastRequestAt));
      if (wait > 0) await this._sleep(wait);
      this._lastRequestAt = this._now();
      return { waitedMs: wait };
    });
    // 吞掉异常，避免一次失败把整条尾链毒死
    this._tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
