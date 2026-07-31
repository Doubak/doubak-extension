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
 * ## 默认 1 秒，依据是前代的实际战绩
 *
 * 唯一能确定豆瓣真实限额的办法是撞上去，而那正是要不惜代价避免的事。所以
 * 默认值不来自实测，而来自一个**语义可比的先例**：
 *
 * 前代实现 `its-my-data/doubak` 用的是 1 秒间隔，而且——这一点核对过源码——
 * 它的三处 `time.Sleep` **全都是从响应回来之后才开始睡**（两处在 `OnResponse`
 * 里，一处在阻塞式 `Visit` 之前），也就是说它本来就是 finish-to-start。
 *
 * 那份实现在同一个账号上跑了 20 个批次、横跨两年，没有被封。样本仍然很小，
 * 但它是**语义完全一致、目标站点相同、账号相同**的先例，比凭空猜一个数字
 * 有依据得多。
 *
 * 而我们在同样的 1 秒之上还多了三重它没有的保护：
 *
 * 1. **抖动**——不形成规整的请求节律
 * 2. **退避且只增不减**——踩到边界就永久降速（前代完全没有退避）
 * 3. **软封锁不重试，停下来等人**——前代遇到封锁会继续往下跑
 *
 * 所以这里是「与一个有战绩的先例同速，但更谨慎」，不是「比它更激进」。
 *
 * 另外：已登录会话的限额更高，但**不能**因此加速——会话随时可能掉，掉了
 * 之后按已登录的节奏继续跑，等于拿更严的配额去撞（见 session.js）。
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

/**
 * 默认基础间隔，从**上一次请求结束**算起。
 *
 * 与前代实现同速（它同样是 finish-to-start 1 秒），但我们额外有抖动、退避与
 * 软封锁停机。理由见文件开头。
 */
export const DEFAULT_INTERVAL_MS = 1000;

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
 *
 * ## 间隔从「上一次请求**结束**」算起
 *
 * 两种算法差别不大，但在最要紧的那种情况下方向相反：
 *
 * | 上次请求耗时 | 从开始算（start-to-start） | 从结束算（本实现） |
 * |---|---|---|
 * | 0.3 秒 | 再等 2.7 秒 | 再等 3 秒 |
 * | 2.5 秒 | 再等 0.5 秒 | 再等 3 秒 |
 * | **29 秒**（接近超时） | **再等 0 秒** | 再等 3 秒 |
 *
 * 从开始算的话，**响应越慢，我们催得越紧**。而响应变慢恰恰是「服务端在限流
 * 或者扛不住」最直接的信号——此时维持原压力正好是反的。
 *
 * 从结束算则天然顺着这个信号走：对方慢下来，我们自动跟着慢下来。代价是响应
 * 快时整体慢一点（3.0 秒变 3.3 秒），对一个以账号安全优先的工具来说完全值得。
 *
 * 另一个好处是这条保证容易讲清楚：**我们的两次请求之间，总有至少 N 秒的安静。**
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
    /** @type {number | null} 上一次请求【结束】的时刻 */
    this._lastFinishedAt = null;
    /** @type {Promise<void>} 串行化用的尾链 */
    this._tail = Promise.resolve();
  }

  /**
   * 换一个 Pacer，**保留计时与排队状态**。
   *
   * 间隔是「我们和豆瓣之间这条连接」的属性，不是某一次活动的属性。而一次抓取
   * 由好几段活动组成：先确认身份，再开工；崩溃之后又是一次恢复。每段各建一个
   * 闸门的话，每段的**第一个请求都不等待**（`_lastFinishedAt` 是 null），于是
   *
   *   身份确认的请求 ──0 毫秒──> 开工前的探测请求
   *
   * 两个请求贴在一起发出去。不是并发，但同样违反「1 秒一个」——而豆瓣看到的
   * 只有请求，它不关心我们内部把它们算作几段活动。
   *
   * Pacer 必须能换，是因为它带着退避层级，而那个要跟着 checkpoint 走
   * （`Pacer.restore`）。计时状态不能跟着换，理由如上。
   *
   * @param {Pacer} pacer
   */
  setPacer(pacer) {
    this._pacer = pacer;
    return this;
  }

  /** 当前的 Pacer。恢复时要把它的状态写进 checkpoint。 */
  get pacer() {
    return this._pacer;
  }

  /**
   * 排队、等待、执行一次请求。
   *
   * **这是唯一的入口**：不提供「先拿许可、稍后自己发」的用法，因为那样就无法
   * 知道请求何时结束，间隔也就没法从结束算起。把执行包进来，计时才有保证。
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<{result: T, waitedMs: number}>}
   */
  async run(fn) {
    const run = this._tail.then(async () => {
      const target = this._pacer.nextDelayMs();
      const wait =
        this._lastFinishedAt === null
          ? 0
          : Math.max(0, target - (this._now() - this._lastFinishedAt));
      if (wait > 0) await this._sleep(wait);

      try {
        const result = await fn();
        return { result, waitedMs: wait };
      } finally {
        // 无论成功失败都从「结束」重新计时——失败的请求同样占用了对方的资源，
        // 何况失败往往正是对方不高兴的表现。
        this._lastFinishedAt = this._now();
      }
    });
    // 吞掉异常，避免一次失败把整条尾链毒死
    this._tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
