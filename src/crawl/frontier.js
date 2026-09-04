/**
 * frontier：抓取队列与状态机。
 *
 * 设计：DESIGN.md F-03c/e/f/g/h、§5
 *
 * ## 状态机
 *
 * ```
 * pending ──▶ in_flight ──┬─▶ done
 *                         ├─▶ failed ─────▶ pending（有限重试，仅限网络层错误）
 *                         ├─▶ awaiting_human ──▶ pending（金丝雀通过后，降速）
 *                         └─▶ terminal_stop（会话失效 / 账号切换 → 整场停机）
 * ```
 *
 * ## 三条容易做反的规矩
 *
 * **① 失败页不跳过。** 失败的条目保持未完成并**阻塞该路线推进**。跳过就
 * 破坏了「这条线以上全部已抓」这个不变量——而那个不变量正是连续性证明的
 * 基础，也是唯一的完整性依据。
 *
 * **② 软封锁不重试。** `blocked` / `challenge` 转 `awaiting_human`，等人来
 * 处理。在软封锁上重试正是把限流升级成封号的标准路径。只有网络层错误
 * （连接失败、超时）才允许有限重试。
 *
 * **③ 终止靠停滞检测，不靠「本页没有新条目」。** 整页重复是正常现象；
 * 实测中列表中段还会出现被审查抑制的空洞（第 7、14、17 页只渲染 14、14、
 * 13 条，槽位 15）。把「短页」当「末页」会把列表拦腰截断。
 */

/** @typedef {'pending' | 'in_flight' | 'done' | 'failed' | 'awaiting_human' | 'terminal_stop'} ItemState */

/**
 * 网络层错误的最大重试次数。只对网络错误有效，风控一律不重试。
 *
 * ## 为什么是 10 而不是 2
 *
 * 原来是 2（一共请求 3 次）。实测撞到过一次：一张封面图的连接把响应头发回来了、
 * body 却再也不来，三次都熬满 30 秒超时，那一页就此进了失败列表。而重试**本来
 * 就只对网络层错误开放**——豆瓣根本没答复，多试几次既不会加重风控暴露，也不会
 * 把限流升级成封号（那条路属于 `awaiting_human`，永远不走这里）。
 *
 * 所以这个数的代价不是账号安全，只是时间：一个真的死掉的 URL 现在要耗
 * `11 × 30 秒超时 + 10 × 10 秒退避` ≈ 6 分钟才认输。换来的是网络抖一下、
 * 某个 CDN 分片抽风的时候不再留下一处**永久的**缺口——档案是冻结的，
 * 少抓的那一页事后补不回来，而多等 6 分钟隔天就忘了。
 *
 * 与它成对的还有两个数，改这里必须一起看：
 * - `loop.js` 的 `RETRY_BACKOFF_MS`（两次之间等多久）
 * - `loop.js` 的 `MAX_CONSECUTIVE_NETWORK_ERRORS`（它由这个数推导，见那边的说明）
 */
export const MAX_NETWORK_RETRIES = 10;

/**
 * 一个 frontier 条目。
 *
 * @typedef {object} FrontierItem
 * @property {string} url
 * @property {string} routeKey
 * @property {string} intent
 * @property {ItemState} state
 * @property {number} attempts
 * @property {boolean} ordered  这条路线的条目之间**有先后关系**吗（分页列表有，
 *   叶子条目没有）。决定一个失败条目要不要连带堵住同路线的其它条目。
 * @property {number} priority  越小越先抓。见 `next()` 里的说明。
 * @property {string | null} gatedBy  必须等这条路线先跑完（`requires`）。
 * @property {string | null} enqueuedBy  产生这个 URL 的那次捕获
 * @property {object | null} cursor
 * @property {string} [lastError]
 */

/**
 * 把响应判定映射成条目的下一个状态。
 *
 * 这张表是抓取安全的核心：**判定错了方向，代价是账号**。
 *
 * @param {string | null} verdict  null = 分类器判不出来
 * @returns {{state: ItemState, retryable: boolean, stopRun: boolean, reason?: string}}
 */
export function transitionFor(verdict) {
  switch (verdict) {
    case 'ok':
      return { state: 'done', retryable: false, stopRun: false };

    case 'gone':
    case 'soft404':
      // 目标确实没了。记录下来，继续走——这不是故障。
      return { state: 'done', retryable: false, stopRun: false };

    case 'blocked':
    case 'challenge':
      // 【绝不重试】。等人来处理，恢复前先用金丝雀确认，然后降速。
      return {
        state: 'awaiting_human',
        retryable: false,
        stopRun: false,
        reason: verdict,
      };

    case 'login':
      // 会话失效是【停止条件】：继续抓会拿到公开视图，而且未登录的频率
      // 上限更低，撞限流的风险更高。
      return { state: 'terminal_stop', retryable: false, stopRun: true, reason: 'session_expired' };

    case null:
      // 判不出来 = 失败。「大概没事」是这套系统里最危险的一句话。
      return { state: 'failed', retryable: false, stopRun: false, reason: 'unclassified' };

    default:
      // 未知 verdict 必须当作不可信，不得当作 ok。
      return { state: 'failed', retryable: false, stopRun: false, reason: 'unknown_verdict' };
  }
}

/**
 * 连续多少页**一条都没有**就算走到头了。
 *
 * 与上面那个阈值分开，因为两件事的证据强度不一样：
 *
 * - 「整页都是重复」是**正常现象**——头部插入会把条目推向后面的页，所以要连续
 *   3 页才敢下结论；
 * - 「整页一条都没有」在列表中段说不通。实测的审查抑制是**部分**的（游戏/玩过
 *   声称 293、渲染 288，第 7、14、17 页渲染 14/14/13 条），从没见过整页为空。
 *
 * 那为什么不是 1？因为「从没见过」是从**一个账号**上看到的，而这个项目在
 * 「从手上的样本推出一个封闭集合」这件事上已经错过四次。取 2：一页空还继续走，
 * 连着两页空才收——多花一个请求，换掉「万一中段真有整页为空就静默截断」那个
 * 不可恢复的结果。
 *
 * 实测的浪费：8 条的游戏列表会请求 start=15 / 30 / 45（三页全空，第三页才
 * 触发那个阈值 3）。这条把它收到两个。
 */
export const EMPTY_PAGE_THRESHOLD = 2;

/**
 * 停滞检测。
 *
 * 终止条件是「连续 N 页无进展」，不是「本页无新条目」，更不是「本页条目数
 * 少于槽位」。
 *
 * 「无进展」的定义是**这一页没有带来任何新的条目 ID**。整页重复是正常的
 * （头部插入会把条目推向后面的页），所以要连续多页才算停滞。
 *
 * **空页另算**，见 `EMPTY_PAGE_THRESHOLD`。
 */
export class StallDetector {
  /** @param {number} [threshold] 连续多少页无进展才算停滞 */
  constructor(threshold = 3) {
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new Error(`threshold 必须是正整数: ${threshold}`);
    }
    this._threshold = threshold;
    this._consecutiveNoProgress = 0;
    /** 连续多少页**一条都没有**。与上面那个分开数，见 `EMPTY_PAGE_THRESHOLD`。 */
    this._consecutiveEmpty = 0;
    /** @type {Set<string>} */
    this._seenIds = new Set();
    this._pages = 0;
  }

  /**
   * 记录一页的条目 ID。
   *
   * @param {string[]} ids 本页出现的条目 ID
   * @returns {{newIds: number, duplicates: number, stalled: boolean, emptyRun: number}}
   */
  observePage(ids) {
    this._pages += 1;
    let newIds = 0;
    for (const id of ids) {
      if (!this._seenIds.has(id)) {
        this._seenIds.add(id);
        newIds += 1;
      }
    }

    if (newIds === 0) this._consecutiveNoProgress += 1;
    else this._consecutiveNoProgress = 0;

    // **数的是「这一页有没有条目」，不是「有没有新条目」。** 整页重复的页面不是
    // 空页——它恰恰证明列表还在，只是这一段已经读过了。
    if (ids.length === 0) this._consecutiveEmpty += 1;
    else this._consecutiveEmpty = 0;

    return {
      newIds,
      duplicates: ids.length - newIds,
      stalled: this._consecutiveNoProgress >= this._threshold
        || this._consecutiveEmpty >= EMPTY_PAGE_THRESHOLD,
      emptyRun: this._consecutiveEmpty,
    };
  }

  /**
   * 交出全部状态，供 checkpoint 保存。
   *
   * **必须包含 `seenIds`。** 不交的话，恢复之后重抓的那一页会被整页当成新条目：
   * 停滞计数归零、`items_seen` 虚高。而停滞检测是分页路线唯一的终止条件。
   */
  serialize() {
    return {
      threshold: this._threshold,
      consecutiveNoProgress: this._consecutiveNoProgress,
      // **空页计数也要存。** 不存的话它在每次恢复之后归零，而 service worker 一场
      // 抓取要死很多次——于是「连着两页空」永远凑不满，这条判据形同虚设。
      // 与 `seenIds` 是同一个道理，那次踩过。
      consecutiveEmpty: this._consecutiveEmpty,
      seenIds: [...this._seenIds],
      pages: this._pages,
    };
  }

  /** @param {ReturnType<StallDetector['serialize']>} s */
  static restore(s) {
    const d = new StallDetector(s?.threshold ?? 3);
    d._consecutiveNoProgress = s?.consecutiveNoProgress ?? 0;
    d._consecutiveEmpty = s?.consecutiveEmpty ?? 0;
    d._seenIds = new Set(s?.seenIds ?? []);
    d._pages = s?.pages ?? 0;
    return d;
  }

  get uniqueCount() {
    return this._seenIds.size;
  }

  get pagesObserved() {
    return this._pages;
  }

  get consecutiveNoProgress() {
    return this._consecutiveNoProgress;
  }

  /** 这个 ID 见过吗？用于跨页去重。 */
  hasSeen(id) {
    return this._seenIds.has(id);
  }
}

/**
 * 一条路线的推进状态。
 *
 * 关键职责：判断这条路线能不能**干净地完成**——只有干净完成才允许推进
 * 水位线（advanced=true）。
 */
export class RouteProgress {
  /**
   * @param {object} opts
   * @param {string} opts.routeKey
   * @param {'bounded' | 'full'} opts.enumeration
   * @param {number} [opts.stallThreshold]
   */
  constructor({ routeKey, enumeration, stallThreshold = 3 }) {
    this.routeKey = routeKey;
    this.enumeration = enumeration;
    this.stall = new StallDetector(stallThreshold);

    /** @type {Array<{reason: string, detail?: string}>} */
    this.gaps = [];
    this._finishedCleanly = false;
    this._stopped = false;
  }

  /** 记一处缺口。有缺口就不许推进水位线。 */
  recordGap(reason, detail) {
    this.gaps.push({ reason, ...(detail ? { detail } : {}) });
  }

  /** 正常走到了终点（停滞检测或到达下界）。 */
  markFinished() {
    this._finishedCleanly = true;
  }

  /** 被打断：风控、会话失效、用户放弃。 */
  markStopped(reason) {
    this._stopped = true;
    this.recordGap(reason ?? 'aborted');
  }

  /**
   * 连续性是否成立。
   *
   * 要求：走到了终点、没有缺口、没有被打断。
   */
  get contiguous() {
    return this._finishedCleanly && this.gaps.length === 0 && !this._stopped;
  }

  /**
   * 水位线能不能推进。
   *
   * **核心不变量**：中途暂停、被风控打断、用户放弃——一律不推进。已抓到的
   * 数据照样留在 WARC 里，但下次仍从旧下界重走。重复是免费的，空洞是永久
   * 且不可检测的。
   */
  get canAdvance() {
    return this.contiguous;
  }
}

/**
 * frontier 队列。
 *
 * 内存里的部分只是视图——真正的权威是持久化层（IndexedDB / checkpoint）。
 * 这个类刻意做成纯逻辑，不碰任何浏览器 API，因此可以完全在 Node 里测。
 */
export class Frontier {
  constructor() {
    /** @type {FrontierItem[]} */
    this._items = [];
    /** @type {Set<string>} 已入队的 url_key，用于去重 */
    this._enqueued = new Set();
    this._stopped = false;
    /** @type {string | null} */
    this._stopReason = null;
    /** 已经放开的门控（前置路线跑完了）。 @type {Set<string>} */
    this._openGates = new Set();
  }

  /**
   * 入队。已经入过队的 url_key 不重复添加。
   *
   * @param {object} item
   * @param {string} item.url
   * @param {string} item.urlKey  去重用的归一化 URL
   * @param {string} item.routeKey
   * @param {string} item.intent
   * @param {string | null} [item.enqueuedBy]
   * @param {object | null} [item.cursor]
   * ## 停机**不**挡入队
   *
   * 挡的是 `next()`：停机之后一个条目都不再发出去。而入队只是**记下「还有这一页
   * 没抓」**——把这个记录丢掉，等于凭空制造一个洞。
   *
   * 这不是理论问题。暂停的语义是「当前这一页抓完就停」，于是必然有一次
   * 「抓完了 → 入队下一页」发生在停机标志已经立起来之后：
   *
   *     04:46:16  paused（用户点了暂停）
   *     04:46:18  capture interest.game.collect start=120   ← 在飞的那一页抓完了
   *               → 入队 start=135 —— **被这里挡掉，一声不响**
   *     04:46:22  resumed
   *     04:46:22  capture interest.game.do start=0          ← 直接跳到下一条线了
   *
   * 于是**每按一次暂停，当前那条路线就被截断一次**。而它悄悄发生：`enqueue()`
   * 返回 false，`_enqueueNextPage()` 不看返回值。
   *
   * 反过来，允许入队没有坏处：停机期间 `next()` 本来就不发东西，这些条目要么在
   * 恢复后被消费，要么原样写进 checkpoint——而「原样写进 checkpoint」正是对的，
   * 它们确实还没抓。
   *
   * @returns {boolean} 是否真的入队了（false 只意味着**重复**）
   */
  enqueue({
    url, urlKey, routeKey, intent, enqueuedBy = null, cursor = null,
    ordered = true, state = 'pending', attempts = 0, priority = 50, gatedBy = null,
    referer = null, lastError,
  }) {
    if (this._enqueued.has(urlKey)) return false;

    this._enqueued.add(urlKey);
    this._items.push({
      url,
      urlKey,
      routeKey,
      intent,
      // 恢复时要按 checkpoint 里的状态原样重建，所以这两个可传入。
      // 默认值是「新入队的条目」。
      state,
      attempts,
      ordered,
      priority,
      gatedBy,
      enqueuedBy,
      cursor,
      // 大部分条目的 Referer 由路线定义给（一条路线一个值）。派生条目不行：
      // 一张封面的 Referer 是**它所在的那个作品页**，每条都不一样，只能跟着条目走。
      // 放进 _items 就自动进 checkpoint（snapshot 是整份展开的），恢复后不会丢。
      referer,
      // 恢复失败条目时带回来的原因。新入队的条目没有，那就别写这个键——
      // 写成 undefined 会让 JSON 里凭空多一个字段又消失，形状不稳定。
      ...(lastError === undefined ? {} : { lastError }),
    });
    return true;
  }

  /**
   * 这条路线还有没有没做完的活（pending / in_flight / failed / awaiting_human）。
   *
   * 用来判断**不分页**的路线走完了没有：它没有「下一页」，也就永远等不到停滞检测，
   * 队列空了就是走完了。
   *
   * @param {string} routeKey
   */
  hasOutstanding(routeKey) {
    return this._items.some(
      (it) => it.routeKey === routeKey && it.state !== 'done' && it.state !== 'terminal_stop',
    );
  }

  /**
   * 把「已经抓成功过」的 url_key 记进去重集合，但**不入队**。
   *
   * ## 为什么需要
   *
   * checkpoint 只保留未完成的条目（已完成的在 index 里，重复记录会带来两个可能
   * 不一致的真相来源）。代价是恢复之后去重集合不认识任何抓完的页面——**任何把旧
   * 页码算回来的 bug 都会变成真实的重抓**。
   *
   * 真实日志：恢复之后抓完 `p=20`，接着去抓 `p=2`、`p=3`……一路重抓到 `p=19`。
   * 而后果比「多抓十几页」严重得多：那些页全是重复条目，**停滞检测把它当成
   * 「这条线走完了」**，于是广播被标成完成、去抓标记列表了——一次假的完整性声明。
   *
   * 只认 `verdict === 'ok'` 的：被封锁、被挑战的页面本来就该重抓。
   *
   * @param {Iterable<string>} urlKeys
   */
  markCaptured(urlKeys) {
    for (const k of urlKeys) this._enqueued.add(k);
  }

  /**
   * 取下一个可抓的条目。
   *
   * `in_flight`、`awaiting_human`、以及**有序路线上**的 `failed` 会阻塞整条路线。
   * 详见 `_blockedRoutes()`——那里说明了为什么叶子路线不该被连带。
   *
   * @returns {FrontierItem | null}
   */
  next() {
    if (this._stopped) return null;

    const blockedRoutes = this._blockedRoutes();

    // **严格按优先级取，而不是按入队顺序。**
    //
    // 早先是「取第一个 pending」。那看起来等价——种子是按优先级插入的——但翻页会把
    // 后续页面**追加到队尾**：广播第 2 页排在所有标记列表种子之后。于是广播与列表
    // 交错抓，而设计要求的恰好相反：
    //
    //   广播 → 长文 → 图片 → 标记列表 → 作品详情页
    //   「中途被打断时，先跑完的一定是最难补的」
    //
    // 交错的后果是一次中断让所有路线都半途而废，那正好抹掉了排序的全部意义。
    // 而广播是唯一「可静默删除、删了就再也拿不回来」的东西。
    //
    // 同优先级内保持入队顺序（先进先出）：分页必须按页序走。
    // 同优先级内优先继续**已经开工**的那条路线（深度优先），见 `_startedRoutes()`。
    const started = this._startedRoutes();
    const rank = (it) => (started.has(it.routeKey) ? 0 : 1);

    let best = null;
    for (const it of this._items) {
      if (it.state !== 'pending') continue;
      if (blockedRoutes.has(it.routeKey)) continue;
      if (it.gatedBy && !this._openGates.has(it.gatedBy)) continue;
      if (!best) { best = it; continue; }
      if (it.priority !== best.priority) {
        if (it.priority < best.priority) best = it;
      } else if (rank(it) < rank(best)) {
        // 同优先级：先跑完手上这条。同一条路线内部仍是先进先出——分页必须按页序走。
        best = it;
      }
    }
    if (!best) return null;

    best.state = 'in_flight';
    best.attempts += 1;
    return best;
  }

  /**
   * 前置路线跑完了，放开受它门控的条目。
   *
   * 门控的意义是抓取**顺序**，不是依赖关系：作品详情页占九成体积，但它是最可替代的
   * （随时能重抓），所以不能拿最不可替代的东西去换它。
   *
   * @param {string} routeKey
   */
  openGate(routeKey) {
    this._openGates.add(routeKey);
  }

  /** @param {string} routeKey */
  isGateOpen(routeKey) {
    return this._openGates.has(routeKey);
  }

  /**
   * 哪些路线现在不许再取条目。
   *
   * ## 为什么「失败」要连带堵住整条路线 —— 以及为什么只对**有序**路线
   *
   * 分页列表是有序的：跳过抓不下来的第 7 页去抓第 8 页，就再也不能声称
   * 「第 7 页以上全都抓到了」，而水位线正是建立在那句话上。所以有序路线上的失败
   * 必须把整条线停住。
   *
   * **但叶子条目之间没有先后关系。** 作品详情页是一个集合，不是一条链——一个电影页
   * 抓不下来，与另外 1332 个电影页毫无关系。把整条路线堵掉的后果是：
   * **一页失败葬送九成档案**（作品详情页占真实档案 90.3% 的体积）。
   *
   * 这个 bug 真实存在过：造一个永远失败的电影页，三个条目里第一个成功、第二个失败、
   * 第三个**永远停在 pending**，而 `hasReady()` 返回 false 让上层以为跑完了。
   *
   * `in_flight` 与 `awaiting_human` 不分有序与否，一律连带：
   * 前者是并发控制（同路线并发恒为 1），后者是风控——那时候整条线都该停。
   */
  _blockedRoutes() {
    /** @type {Set<string>} */
    const blocked = new Set();
    for (const it of this._items) {
      if (it.state === 'in_flight' || it.state === 'awaiting_human') {
        blocked.add(it.routeKey);
      } else if (it.state === 'failed' && it.ordered) {
        blocked.add(it.routeKey);
      }
    }
    return blocked;
  }

  /**
   * 已经开过工的路线（有条目跑完了）。
   *
   * 用来在**同优先级内**做深度优先：先把手上这条列表跑完，再开下一条。
   *
   * 15 条标记列表优先级完全一样，按入队顺序轮转的话，翻页会把第 2 页追加到队尾，
   * 于是每条线各抓一页、再各抓一页……**十五条列表一起慢慢爬**。中途一停，得到的
   * 是十五份半截列表——每一份都不完整，每一份的连续性都证明不了，覆盖率那一页
   * 全是「进行中」。
   *
   * 一条一条跑完则相反：停下来的时候，跑完的那几条是**真的跑完了**，可以验证、
   * 可以推进水位线、下次可以增量。这跟路线族之间的排序是同一条道理，只是尺度更小。
   */
  _startedRoutes() {
    /** @type {Set<string>} */
    const started = new Set();
    for (const it of this._items) {
      if (it.state === 'done') started.add(it.routeKey);
    }
    return started;
  }

  /**
   * 按判定结果推进条目状态。
   *
   * ## `reasons` 必须带上
   *
   * 分类器每次判定都会给出一串**具体理由**（「Content-Type 不是图片：text/html」、
   * 「缺少 2 个页面框架标志（…）」），而这里原来只记下 `transitionFor` 给的那个
   * 分类码。于是失败列表里一百多行全写着 `unclassified`——用户看到的是
   *
   *     123 个页面抓不下来 … 错误：unclassified
   *
   * 一个既不能行动、也不能报告的字符串。而分类器当时**明明知道**为什么，只是
   * 在这一行里被扔掉了。这与项目「响亮地失败」的立场是矛盾的：判不出来已经够坏，
   * 判不出来还不说为什么，等于让人对着几千页去猜。
   *
   * @param {FrontierItem} item
   * @param {string | null} verdict
   * @param {string[]} [reasons]  分类器给出的具体理由
   * @returns {{state: ItemState, stopRun: boolean, reason?: string}}
   */
  settle(item, verdict, reasons) {
    const t = transitionFor(verdict);
    item.state = t.state;
    if (t.reason) {
      // 分类码在前（可以按它筛、按它统计），人看的理由在后。
      item.lastError = reasons?.length ? `${t.reason}：${reasons.join('；')}` : t.reason;
    }
    if (t.stopRun) this.stop(t.reason ?? 'terminal');
    return t;
  }

  /**
   * 网络层错误：允许有限重试。
   *
   * **只有网络错误走这里**。风控相关的一律不重试——那是把限流升级成封号的
   * 标准路径。
   *
   * @param {FrontierItem} item
   * @param {string} message
   * @returns {{willRetry: boolean}}
   */
  settleNetworkError(item, message) {
    item.lastError = message;
    if (item.attempts <= MAX_NETWORK_RETRIES) {
      item.state = 'pending';
      return { willRetry: true };
    }
    item.state = 'failed';
    return { willRetry: false };
  }

  /**
   * 解除停机状态。
   *
   * `stop()` 之后 frontier 就不再交出任何条目——那是对的（暂停、风控、掉登录都该立刻
   * 停住）。但**没有任何地方能把它清回去**，于是「继续」按钮在 runner 还活着的情况下
   * 什么也做不了：`run()` 立刻返回 `stoppedBy: 'user_paused'`，上层看到停机原因又弹一次
   * 「需要你处理」。用户点继续，得到的是同一条通知。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.resumeHuman]  同时把 `awaiting_human` 的条目放回队列。
   *   默认 true——会走到「继续」的路径本来就意味着人已经处理过了。
   * @returns {{wasStopped: boolean, resumed: number}}
   */
  clearStop({ resumeHuman = true } = {}) {
    const wasStopped = this._stopped;
    this._stopped = false;
    this._stopReason = null;
    const resumed = resumeHuman ? this.resumeAfterHuman() : 0;
    return { wasStopped, resumed };
  }

  /**
   * 人工处理完毕，把等待中的条目放回队列。
   *
   * 调用方**必须**先用金丝雀确认风控已解除，并降速之后再恢复。
   */
  resumeAfterHuman() {
    let resumed = 0;
    for (const it of this._items) {
      if (it.state === 'awaiting_human') {
        it.state = 'pending';
        resumed += 1;
      }
    }
    return resumed;
  }

  /** 整场停机。 */
  stop(reason) {
    this._stopped = true;
    this._stopReason = reason;
    for (const it of this._items) {
      if (it.state === 'in_flight') it.state = 'pending';
    }
  }

  get stopped() {
    return this._stopped;
  }

  get stopReason() {
    return this._stopReason;
  }

  /**
   * 还有没有可以立即抓的条目。
   *
   * **不改变任何状态**——这是与 `next()` 的关键区别。`next()` 会把取出的条目
   * 标成 in_flight，拿它当「还有活吗」的判断用，会白白消耗掉一个条目并让它
   * 永远卡在 in_flight，进而**堵死整条路线**。
   */
  hasReady() {
    const blocked = this._blockedRoutes();
    return this._items.some(
      (it) => it.state === 'pending'
        && !blocked.has(it.routeKey)
        && (!it.gatedBy || this._openGates.has(it.gatedBy)),
    );
  }

  /**
   * 被门控挡住、还没轮到的条目数。
   *
   * 上层要靠它区分「真的跑完了」与「只是前置还没完成」——后者绝不是 done。
   */
  gatedCount() {
    return this._items.filter(
      (it) => it.state === 'pending' && it.gatedBy && !this._openGates.has(it.gatedBy),
    ).length;
  }

  /**
   * 未解决的失败条目。
   *
   * 上层靠它决定这次抓取**不能**标成 `complete`：失败不调用 `stop()`，所以
   * `stoppedBy` 是 null，而「没有可跑的了」曾被当成干净跑完——于是档案被静默标成
   * complete，而 manifest 里一点痕迹都没有。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.orderedOnly]  只数有序路线上的。叶子失败可以由用户决定
   *   「就这样收尾」，有序失败不行（那会破坏水位线赖以成立的前提）。
   */
  failedItems({ orderedOnly = false } = {}) {
    return this._items.filter((it) => it.state === 'failed' && (!orderedOnly || it.ordered));
  }

  /**
   * 卡在「等人处理」的条目（软封锁：blocked / challenge）。
   *
   * **与 `failedItems()` 是两回事，不能合并。** 失败是「试过了，不行」，等人是
   * 「豆瓣让我们别再试了」——后者的正确反应是停下来降速，而不是记一笔然后接着抓。
   *
   * 但对**上层**来说两者有一个共同点：**都不能当成跑完了**。而这一点原来只有
   * `failedItems()` 数得到，于是一整条路线全被软封锁挡住时，队列里取不出东西
   * → 「没有可跑的了」→ 自动收尾成 complete。那是这个项目最不能出的错：假的
   * 完整性声明。
   */
  awaitingHumanItems() {
    return this._items.filter((it) => it.state === 'awaiting_human');
  }

  /**
   * 把失败条目放回队列，给一次新机会。
   *
   * **只能由人触发。** 自动重试一个反复失败的页面，在最坏情况下是每次心跳都去撞一次
   * 同一面墙——而如果那面墙是风控，代价是账号。
   *
   * @param {object} [opts]
   * @param {string} [opts.routeKey]  只重试这条路线的
   * @returns {number} 放回了几条
   */
  retryFailed({ routeKey } = {}) {
    let n = 0;
    for (const it of this._items) {
      if (it.state !== 'failed') continue;
      if (routeKey && it.routeKey !== routeKey) continue;
      it.state = 'pending';
      it.attempts = 0; // 新机会就是新预算
      n += 1;
    }
    return n;
  }

  /** 某条路线上还有没有未解决的条目（失败、等待人工、待抓、在途）。 */
  hasUnresolved(routeKey) {
    return this._items.some(
      (it) =>
        it.routeKey === routeKey &&
        it.state !== 'done',
    );
  }

  /** @returns {Record<ItemState, number>} */
  counts() {
    /** @type {any} */
    const out = { pending: 0, in_flight: 0, done: 0, failed: 0, awaiting_human: 0, terminal_stop: 0 };
    for (const it of this._items) out[it.state] += 1;
    return out;
  }

  /** 快照，供持久化。 */
  snapshot() {
    return this._items.map((it) => ({ ...it }));
  }

  /** 从快照恢复（崩溃续抓）。在途的条目回到待抓——它们没写完。 */
  static restore(items) {
    const f = new Frontier();
    for (const it of items) {
      f._items.push({ ...it, state: it.state === 'in_flight' ? 'pending' : it.state });
      f._enqueued.add(it.urlKey);
    }
    return f;
  }
}
