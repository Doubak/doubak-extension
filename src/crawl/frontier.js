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

/** 网络层错误的最大重试次数。只对网络错误有效，风控一律不重试。 */
export const MAX_NETWORK_RETRIES = 2;

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
 * 停滞检测。
 *
 * 终止条件是「连续 N 页无进展」，不是「本页无新条目」，更不是「本页条目数
 * 少于槽位」。
 *
 * 「无进展」的定义是**这一页没有带来任何新的条目 ID**。整页重复是正常的
 * （头部插入会把条目推向后面的页），所以要连续多页才算停滞。
 */
export class StallDetector {
  /** @param {number} [threshold] 连续多少页无进展才算停滞 */
  constructor(threshold = 3) {
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new Error(`threshold 必须是正整数: ${threshold}`);
    }
    this._threshold = threshold;
    this._consecutiveNoProgress = 0;
    /** @type {Set<string>} */
    this._seenIds = new Set();
    this._pages = 0;
  }

  /**
   * 记录一页的条目 ID。
   *
   * @param {string[]} ids 本页出现的条目 ID
   * @returns {{newIds: number, duplicates: number, stalled: boolean}}
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

    return {
      newIds,
      duplicates: ids.length - newIds,
      stalled: this._consecutiveNoProgress >= this._threshold,
    };
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
   * @returns {boolean} 是否真的入队了
   */
  enqueue({ url, urlKey, routeKey, intent, enqueuedBy = null, cursor = null, ordered = true, state = 'pending', attempts = 0 }) {
    if (this._stopped) return false;
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
      enqueuedBy,
      cursor,
    });
    return true;
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

    for (const it of this._items) {
      if (it.state === 'pending' && !blockedRoutes.has(it.routeKey)) {
        it.state = 'in_flight';
        it.attempts += 1;
        return it;
      }
    }
    return null;
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
   * 按判定结果推进条目状态。
   *
   * @param {FrontierItem} item
   * @param {string | null} verdict
   * @returns {{state: ItemState, stopRun: boolean, reason?: string}}
   */
  settle(item, verdict) {
    const t = transitionFor(verdict);
    item.state = t.state;
    if (t.reason) item.lastError = t.reason;
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
    return this._items.some((it) => it.state === 'pending' && !blocked.has(it.routeKey));
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
