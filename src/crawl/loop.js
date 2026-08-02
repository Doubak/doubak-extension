/**
 * 抓取主循环：把前面各块接成一条能真正跑起来的链路。
 *
 *   frontier → transport → classifier → session → bundle writer → frontier
 *
 * ## 一次捕获的处理顺序，以及为什么是这个顺序
 *
 * 1. **取页**——失败按错误类型分流（可重试 / 不可重试）
 * 2. **判定**——判内容不判状态码
 * 3. **写档案**——**无论判定是什么都写**，包括封锁页与登录页
 * 4. **会话复核**——检测账号切换（分类器看不出这个）
 * 5. **推进 frontier**——按判定决定条目状态
 * 6. **抽取下一页**——仅在 ok 时
 *
 * 第 3 步排在第 5 步之前是刻意的：**封锁页与登录页必须进档案**。真实旧档案
 * 里有两个登录页被按数据文件名写进了磁盘、没有任何标记，下游只会看到「文件
 * 在，里面 0 条」。我们要的是反过来——存下来，并且如实标注它是什么。存了才
 * 能在不重新抓取的前提下重训分类器。
 *
 * ## 循环随时可能被打断
 *
 * service worker 被杀是常态。每处理完一条就落盘（写入器本身保证），所以从
 * 任何一点断掉都等价于一次可恢复的空操作。
 */

import {
  classifyResponse,
  classifyAsset,
  RollingSize,
  profileForRoute,
  extractItemIds,
  extractItemTimes,
  extractClaimedCount,
  extractSubjectLinks,
  extractCoverImage,
} from './classifier.js';
import { SessionError } from './session.js';
import { TransportError } from './errors.js';
import { PermissionError } from './permissions.js';
import { classifyWriteError } from '../storage/quota.js';
import { RouteState } from './route-state.js';
import { MAX_NETWORK_RETRIES } from './frontier.js';
import { urlKey } from '../core/urlkey.js';
import { nowRfc3339, parseDoubanTimestamp } from '../core/time.js';

/**
 * 连续多少次网络层错误就判定「网络没了」。
 *
 * ## 这个数不能随手取
 *
 * 它**必须大于单个条目的重试预算**（`1 + MAX_NETWORK_RETRIES` = 3）。否则一个
 * 坏 URL 自己就能把整场抓取判成「网络断了」——那是把「这一页有问题」误读成
 * 「全世界都没了」，而两者的处置完全相反。
 *
 * 取两个条目的预算（6）：这是「不止一个 URL 出问题」所需的最小值。再大就是在
 * 白白多熬超时——网络真断了的时候，每多试一次就是 30 秒。
 */
export const MAX_CONSECUTIVE_NETWORK_ERRORS = (1 + MAX_NETWORK_RETRIES) * 2;

/**
 * @typedef {object} LoopDeps
 * @property {import('./frontier.js').Frontier} frontier
 * @property {import('./transport.js').Transport} transport
 * @property {import('../bundle/bundle-writer.js').BundleWriter} writer
 * @property {import('./session.js').SessionGuard} session
 * @property {import('./pacing.js').Pacer} pacer
 * @property {Map<string, object>} routes  routeKey → RouteDef
 * @property {(evt: object) => void} [onEvent]  进度/日志回调
 */

/**
 * @typedef {object} LoopResult
 * @property {number} captured
 * @property {number} failed
 * @property {string | null} stoppedBy  停机原因；null 表示队列跑空
 */

export class CrawlLoop {
  /**
   * @param {LoopDeps & {floors?: Map<string, string | null>}} deps
   *   `floors`：每条路线上次的水位线，作为本次的下界。没有就是首次全量。
   */
  constructor({
    frontier, transport, writer, session, pacer, routes, onEvent, floors,
    bypassGates = false, priorCounts = null, savedStates = null, floorSources = null,
  }) {
    this._frontier = frontier;
    this._transport = transport;
    this._writer = writer;
    this._session = session;
    this._pacer = pacer;
    this._routes = routes;
    this._emit = onEvent ?? (() => {});

    /**
     * 连续多少次网络层错误。用来判定「网络没了」——见 `_handleTransportError`。
     * 抓成功一条就清零。
     */
    this._consecutiveNetworkErrors = 0;

    /** @type {Map<string, RollingSize>} 每条路线的体积基线 */
    this._sizes = new Map();
    /** @type {Map<string, RouteState>} 每条路线的水位线与连续性 */
    this._states = new Map();
    /** @type {Map<string, string>} routeKey → 最后一次 capture_id，用于 parent 链 */
    this._lastCapture = new Map();
    this._floors = floors ?? new Map();
    /**
     * 每条路线的下界取自哪一份档案（规范 §5.5.1）。
     * @type {Map<string, string>}
     */
    this._floorSources = floorSources ?? new Map();
    /**
     * 恢复之前这份档案里已经抓了多少条。
     *
     * RouteState 活在内存里，而 service worker 随时被杀——一场几小时的抓取会跨越
     * 很多次死亡。不接上的话，界面上的「已抓」在每次恢复之后归零，实际显示的是
     * 「上次恢复以来抓了多少」，而用户看到的是「一共抓了多少」。
     *
     * 数字来自 `index.ndjson`，那是唯一权威的一份（写在档案里、每页落盘）。
     *
     * @type {Record<string, number>}
     */
    this._priorCounts = priorCounts ?? {};
    /**
     * checkpoint 里存下来的各路线状态。
     *
     * 不接回来的话，恢复之后每条路线都是崭新的——没有水位线、没有缺口、没走完，
     * 于是收尾时 `flushRouteEvidence()` 会把它们**全部**记成「aborted」。
     * 真实档案里 21 条路线全是这样，而它一次都没被打断过。
     *
     * @type {Record<string, object>}
     */
    this._savedStates = savedStates ?? {};

    // **马上把这些路线的状态建出来。**
    //
    // `stateFor()` 是懒的：一条路线要等到处理完一页才会出现在进度表里。恢复之后
    // 那意味着**整张表先空掉**，等抓到东西才一行行长回来——而恢复在崩溃路径上很
    // 频繁。用户看到的是「进度没了」。
    //
    // 有历史计数就说明这条线之前抓过，那它本来就该在表上。
    for (const routeKey of Object.keys(this._priorCounts)) this.stateFor(routeKey);
    for (const routeKey of Object.keys(this._savedStates)) this.stateFor(routeKey);

    // **门控也要重开。**
    //
    // `Frontier._openGates` 是每次新建都空的一个 Set，而门控**只在抓取过程中**
    // 被打开（前置路线跑完那一刻）。恢复之后没人重开它，于是所有 `gatedBy` 还在的
    // 条目一律取不出来——`hasReady()` 报 false，上层判定「跑完了」，然后**收尾并写
    // 下 `status: complete`**。
    //
    // 真实日志：
    //   04:55:08 capture interest.item …          ← 正在抓作品详情页
    //   04:55:06 paused
    //   （重新加载扩展，内存清零）
    //   05:01:03 resumed
    //   05:01:03 finished                          ← 几千个详情页就这么没了
    //
    // 不另存一份「哪些门开着」，而是**从恢复出来的路线状态重新推导**：门开不开的
    // 判据本来就是「前置路线 canAdvance」，而那个状态现在跟着 checkpoint 走了。
    // 多存一份就多一处会与真相分叉的地方。
    for (const routeKey of this._states.keys()) this._maybeOpenGate(routeKey);
    /**
     * 跳过抓取顺序的门控。**只给调试用**。
     *
     * 门控的意义是「不能拿最不可替代的东西去换最可替代的东西」——广播可静默删除，
     * 作品详情页随时能重抓。小范围试跑要验的恰恰是作品详情页那条路线，不该先花几小时
     * 把广播抓完，所以给一个显式的后门；而界面上必须说清它绕过了什么。
     */
    this._bypassGates = bypassGates;
  }

  /**
   * 取（或建）一条路线的推进状态。
   *
   * 这是完整性证据的攒集处——豆瓣的计数不可信，连续性证明是唯一的判据。
   *
   * @param {string} routeKey
   */
  stateFor(routeKey) {
    if (!this._states.has(routeKey)) {
      const route = this._routes.get(routeKey) ?? {};
      const opts = {
        routeKey,
        intent: route.intent ?? routeKey,
        enumeration: route.enumeration ?? 'bounded',
        floorTime: this._floors.get(routeKey) ?? null,
        floorFromBundleId: this._floorSources.get(routeKey) ?? null,
        priorCount: this._priorCounts[routeKey] ?? 0,
      };
      const saved = this._savedStates[routeKey];
      this._states.set(routeKey, saved ? RouteState.restore(opts, saved) : new RouteState(opts));
    }
    return this._states.get(routeKey);
  }

  /**
   * 一条路线到达终点时放开受它门控的条目。
   *
   * 条件是 `canAdvance`（连续、无缺口、有水位线）——也就是「这条线以上全都抓到了」
   * 真的成立。半途而废不算跑完，那时候放开门控等于把顺序保证白扔了。
   *
   * @param {string} routeKey
   */
  _maybeOpenGate(routeKey) {
    if (this._frontier.isGateOpen(routeKey)) return;
    const state = this._states.get(routeKey);
    if (!state?.canAdvance) return;
    // 这条路线上还有待抓的条目就不算跑完
    if (this._frontier.snapshot().some((it) => it.routeKey === routeKey && it.state === 'pending')) return;

    this._frontier.openGate(routeKey);
    this._emit({ type: 'gate_opened', routeKey });
  }

  /** 所有路线的推进状态，供收尾时写进 manifest。 */
  get routeStates() {
    return this._states;
  }

  /**
   * 收尾：把每条路线的连续性证明与覆盖率观测写进 manifest。
   *
   * **必须调用**——不调用的话产出的 bundle 里 coverage 与 crawl_state 都是空的，
   * 也就是没有任何完整性证据，下次也无从增量。
   *
   * @param {string} [completedAt]
   */
  flushRouteEvidence(completedAt = nowRfc3339()) {
    for (const state of this._states.values()) {
      this._settleUnfinished(state);
      this._noteMissingWatermark(state);
      this._writer.addCoverage(state.toCoverage());
      this._writer.addCrawlState(state.toCrawlState(this._writer.bundleId, completedAt));
    }
  }

  /**
   * 收尾时给还没有结论的路线定性。
   *
   * ## 不分页的路线：队列空了就是走完了
   *
   * 它没有「下一页」，也就永远等不到停滞检测或到达下界——而那是分页路线仅有的两个
   * 完成信号。原来一律记成「有 1 处缺口，原因：aborted」，真实档案里 6 条这样的
   * 路线（个人主页 + 5 个分类入口）全是如此，而它们其实**一次就抓全了**。
   *
   * ## 分页的路线：队列空了反而可疑
   *
   * 它本该靠停滞检测收尾。队列悄悄空掉说明「下一页」没入成队——最常见的原因是算出
   * 来的页码早就抓过、被去重挡掉了。那时候记一个**说得出原因**的缺口，而不是笼统的
   * 「aborted」：后者看起来像被风控打断，会把排查引向完全错误的方向。
   *
   * @param {import('./route-state.js').RouteState} state
   */
  /**
   * 收尾时看一眼：有没有哪条线**跑完了却没有水位线**。
   *
   * 那不是缺口（没有东西缺失），而是**能力上的退化**：`advanced` 永远是 false，
   * 这条线下次还是全量。界面上完全看不出来——连续性那一列照样是「✔ 已验证」。
   *
   * 只对**本该有时间**的路线报（判定描述里有 `timeAnchor` 的）。作品详情页、
   * 个人主页压根没有时间概念，那是设计如此，不是坏了。
   *
   * @param {import('./route-state.js').RouteState} state
   */
  _noteMissingWatermark(state) {
    const profile = profileForRoute(state.routeKey);
    if (!profile?.timeAnchor) return; // 本来就没有时间概念
    if (state.highWater) return;
    if (state.stall.uniqueCount === 0) return; // 一条都没抓到，那是另一回事

    this._emit({
      type: 'no_watermark',
      routeKey: state.routeKey,
      count: state.stall.uniqueCount,
      message: `这条线抓到了 ${state.stall.uniqueCount} 条，但一个时间都没解析出来——`
        + '于是水位线为空，下次抓取仍然只能全量重走。多半是豆瓣改了列表页上日期的写法。',
    });
  }

  _settleUnfinished(state) {
    if (state.contiguous || state._finished || state._stopped) return;

    const route = this._routes.get(state.routeKey) ?? {};
    const outstanding = this._frontier.hasOutstanding(state.routeKey);

    if (!route.pagination && !outstanding) {
      // 不分页 + 没有剩活 + 没有缺口 = 真的抓全了。
      //
      // 单页路线在抓完那一页时就已经标过了（见 `_fetchOne`）；这里兜住的是
      // **派生集合**（作品详情页）——它要等队列真的空了才算走完。
      if (state.gaps.length === 0) state.markFinished();
      return;
    }

    if (route.pagination && !outstanding) {
      // 一页都没读成过 ≠ 翻页走岔了。
      //
      // 前者是「这条线的第一页就不是 ok」——最常见的原因是这个分类这位用户压根没
      // 用过、或者豆瓣把它下线了。把它说成「下一页没能入队、大概是被去重挡掉了」
      // 是**编造一个错误的原因**，而这一行正是给人排查用的。
      if (state.stall.pagesObserved === 0) {
        state.markStopped('route_unavailable');
        state.gaps[state.gaps.length - 1].detail =
          '这条线一页都没读成过——第一页就不是正常内容。'
          + '可能是这个分类你没有用过、豆瓣把它下线了，或者那一页被拦了。'
          + '档案里存着那一页的原样，可以打开看看到底是什么。';
        return;
      }
      state.markStopped('next_page_not_queued');
      state.gaps[state.gaps.length - 1].detail =
        '这条线的队列空了，但从没到达停滞终止或下界——说明「下一页」没能入队，'
        + '最常见的原因是算出来的页码早就抓过、被去重挡掉了。'
        + '这不是被风控打断，是抓取自己走岔了。';
      return;
    }

    // 还有没做完的活，那就是真的被打断了
    state.markStopped('aborted');
  }

  /** @param {string} routeKey */
  _sizeFor(routeKey) {
    if (!this._sizes.has(routeKey)) this._sizes.set(routeKey, new RollingSize());
    return this._sizes.get(routeKey);
  }

  /**
   * 跑到队列空、被打断、或达到 maxItems。
   *
   * @param {object} [opts]
   * @param {number} [opts.maxItems]  便于测试与分批
   * @returns {Promise<LoopResult>}
   */
  async run({ maxItems = Infinity } = {}) {
    let captured = 0;
    let failed = 0;

    while (captured + failed < maxItems) {
      const item = this._frontier.next();
      if (!item) break;

      const outcome = await this._fetchOne(item);
      if (outcome === 'retry') continue;
      if (outcome === 'stop') break;
      if (outcome === 'failed') failed += 1;
      else captured += 1;
    }

    return {
      captured,
      failed,
      stoppedBy: this._frontier.stopped ? this._frontier.stopReason : null,
      // 未解决的失败。上层靠它决定这次抓取**不能**标成 complete——失败不调用
      // `stop()`，所以 `stoppedBy` 是 null，而「没有可跑的了」曾被当成干净跑完。
      //
      // 分开数是因为两者的处置权不同：有序路线上的失败会破坏水位线赖以成立的前提，
      // 只能重试；叶子失败可以由用户决定「就这样收尾」。
      unresolvedFailures: this._frontier.failedItems().length,
      unresolvedOrderedFailures: this._frontier.failedItems({ orderedOnly: true }).length,
      // 软封锁挡住的条目同样**不能当成跑完了**。只数失败的话，一整条路线全被
      // 挡住时队列取不出东西，上层会把它读成「干净跑完」然后收尾成 complete。
      awaitingHuman: this._frontier.awaitingHumanItems().length,
    };
  }

  /**
   * 处理单个条目。
   *
   * @param {object} item
   * @returns {Promise<'ok' | 'failed' | 'retry' | 'stop'>}
   */
  async _fetchOne(item) {
    const route = this._routes.get(item.routeKey) ?? {};
    const profile = profileForRoute(item.routeKey);

    // **只要为这条路线发过一次请求，它就必须出现在完整性证据里。**
    //
    // `stateFor()` 是懒的，而建状态的那几处（观测一页、记缺口、标停止）**都要求
    // 判定是 ok 或失败**。于是一条「唯一那页判成 gone/soft404」的路线走的是
    // `state = 'done'` 那条路，一个状态都没建——收尾时它从 coverage 与 crawl_state
    // 里**整条消失**，档案里看不出我们试过它。
    //
    // 那比写错原因更糟：错的原因至少还能被质疑，消失的路线没人会想起来去问。
    this.stateFor(item.routeKey);

    // ── 1. 取页
    let res;
    try {
      res = await this._transport.fetch(item.url, {
        // 条目自带的优先：派生出来的条目（封面图）各有各的来源页。
        referer: item.referer ?? route.referer,
        withCk: route.surface === 'api',
      });
    } catch (err) {
      return this._handleTransportError(item, err);
    }

    // ── 2. 判定
    const sizes = this._sizeFor(item.routeKey);
    const contentType = res.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1];

    let cls;
    if (route.surface === 'asset') {
      // 图片没有结构锚点，判定只能看 Content-Type 与字节数（规范 §6.6.1）。
      cls = classifyAsset({
        finalUrl: res.finalUrl,
        status: res.status,
        contentType,
        byteLength: res.body.length,
        body: res.body,
        bodyText: res.bodyText,
      });
    } else if (profile) {
      cls = classifyResponse({
        finalUrl: res.finalUrl,
        status: res.status,
        bodyText: res.bodyText,
        route: profile,
        sizeStats: sizes.stats(),
      });
    } else {
      // 没有判定描述的路线（比如作品详情页）只做最基本的判断
      cls = { verdict: res.status === 200 ? 'ok' : null, reasons: ['该路线没有判定描述'], itemCount: null };
    }

    // 图片的体积分布与页面完全不是一回事，混进同一个滚动统计会把两边都毁掉。
    // 而图片本来也用不上这条判据（`classifyAsset` 不看 sizeStats）。
    if (cls.verdict === 'ok' && route.surface !== 'asset') sizes.add(res.bodyText.length);

    // ── 3. 写档案（无论判定是什么）
    //
    // 封锁页与登录页必须进档案：存下来才能在不重新抓取的前提下重训分类器，
    // 而真实旧档案里恰恰是「存了但没标注」造成了静默的数据损坏。
    // ── 2b. 条目与时间：抽一次，两处用
    //
    // 翻页逻辑本来就要它们。顺手记进 index 是因为**算完扔掉就补不回来了**：
    // 事后想知道「第 7 页是哪段时间」，得把记录取出来解压再跑一遍选择器——而豆瓣
    // 改版之后那些选择器可能已经对不上了（这次就撞过一回）。
    //
    // 抽一次而不是抽两次：这是对一份 100 KB 的 HTML 跑正则。
    const items = profile
      ? { ids: extractItemIds(res.bodyText, profile), times: extractItemTimes(res.bodyText, profile) }
      : { ids: [], times: [] };

    // **抽得到条目、却一条时间都抽不到 —— 这是「抽取器坏了」的第二种样子。**
    //
    // 第一种（一个 ID 都抽不到）已经有自检了。这一种更隐蔽：翻页照常、连续性照常
    // ✔ 已验证、界面上什么都不异常——只有「已回溯到」是空的。而后果是
    // `high_water_time` 永远 null、`advanced` 永远 false，**这条线永远不能增量**。
    //
    // 书就是这么坏了很久的：列表页的日期后面跟着「读过」两个字，而模式要求日期
    // 紧接着 `<`，于是三条书的路线一条时间都抽不到。没有任何地方报过。
    if (profile?.timeAnchor && items.ids.length > 0 && items.times.length === 0) {
      this.stateFor(item.routeKey).noteTimeExtractionFailed(item.url);
    }

    // 写失败必须让**整场**抓取停下，不是只标这条路线失败然后继续。
    //
    // 写入器的契约是「每页都落盘」，这条契约一破，索引里的偏移量、连续性
    // 证明、captured 计数全都建立在假前提上。而后续的写大概率同样失败，每
    // 一次都可能在段尾留下撕裂的半条记录——停下来只需一次崩溃恢复就能修好，
    // 接着写下去是一路撕裂到用户放弃。
    let written;
    try {
      written = await this._writer.writeCapture({
        url: res.requestedUrl,
        finalUrl: res.finalUrl !== res.requestedUrl ? res.finalUrl : undefined,
        intent: route.intent ?? item.intent,
        routeKey: item.routeKey,
        surface: route.surface ?? 'html',
        verdict: cls.verdict ?? 'blocked', // 判不出来的也要留证，但不能标成 ok
        captureFidelity: this._transport.fidelity,
        httpStatus: res.status,
        headers: res.headers,
        contentType,
        body: res.body,
        kind: route.kind ?? 'data',
        parentCaptureId: item.enqueuedBy ?? this._lastCapture.get(item.routeKey) ?? null,
        cursor: item.cursor ?? null,
        // null 与 0 是两件事：null 是「这条路线没有条目概念」（个人主页），
        // 0 是「数过了，是空的」——而空页正是翻页终点的正常形态。
        itemCount: profile ? cls.itemCount : null,
        itemTimeRange: itemTimeRange(items.times),
        note: cls.verdict === null ? `判不出来：${cls.reasons.join('；')}` : undefined,
      });
    } catch (err) {
      const se = classifyWriteError(err);
      this.stateFor(item.routeKey).markStopped(se.reason);
      this._frontier.stop(se.reason);
      this._emit({ type: 'stopped', reason: se.reason, message: se.message, url: item.url });
      return 'stop';
    }
    // 连上了，计数清零。判据是「**连续**几次」——偶尔一次超时是正常的，
    // 网络断了才会一次接一次。
    this._consecutiveNetworkErrors = 0;

    this._lastCapture.set(item.routeKey, written.captureId);
    // 界面在两批之间没有 in_flight 条目可看，那时候要有个「刚抓完 X」顶上——
    // 否则那一行会时有时无地闪。
    this.lastUrl = res.finalUrl ?? res.requestedUrl;

    this._emit({
      type: 'capture',
      captureId: written.captureId,
      routeKey: item.routeKey,
      // **URL 要带上。** 界面上原来只显示「档案 xxx · 间隔 1 秒」，几小时里几乎一动不动，
      // 看不出它在动还是卡住了；日志里也只有 routeKey，事后没法回答「到底停在哪一页」。
      // 跟着重定向走完之后的那个才是真正抓到的东西。
      url: res.finalUrl ?? res.requestedUrl,
      verdict: cls.verdict,
      itemCount: cls.itemCount,
      reasons: cls.reasons,
    });

    // ── 4. 会话复核（分类器看不出账号切换）
    //
    // **图片跳过这一步。** 复核的做法是在响应里找导航栏上的登录状态与用户 ID，
    // 而图片没有导航栏——把一份 JPEG 的字节按 UTF-8 解出来去跑那几条正则，最好的
    // 情况是白跑（判成 `unknown` 直接返回），最坏的情况是**图片自己的字节里恰好
    // 出现了那几个模式**（EXIF、内嵌缩略图、任意元数据都可能带文本），于是一张
    // 图片把整场抓取判成账号被换掉然后停机。
    //
    // 一般化地说：**档案的内容不该被当成会话状态来读。** 页面是我们请求的东西，
    // 二进制载荷是别人给的字节。
    //
    // 真正的防线在别处：图片是从**刚刚复核过**的那张详情页上抽出来的，中间隔不了
    // 几秒；而图片响应本身若变成了 HTML 登录页，`classifyAsset` 已经判掉了。
    try {
      if (route.surface !== 'asset') this._session.verify(res.bodyText);
    } catch (err) {
      if (err instanceof SessionError) {
        // 被打断的路线不许推进水位线：已抓到的数据留在 WARC 里，但下次仍从
        // 旧下界重走。重复是免费的，空洞是永久且不可检测的。
        this.stateFor(item.routeKey).markStopped(err.reason);
        this._frontier.stop(err.reason);
        this._emit({ type: 'stopped', reason: err.reason, message: err.message, url: item.url });
        return 'stop';
      }
      throw err;
    }

    // ── 5. 推进 frontier
    const t = this._frontier.settle(item, cls.verdict, cls.reasons);

    if (t.state === 'awaiting_human') {
      // 软封锁：降速，且**不自动重试**。等人处理完、金丝雀确认之后再继续。
      this.stateFor(item.routeKey).markStopped(t.reason ?? 'blocked');
      const slowed = this._pacer.slowDown();
      this._emit({
        type: 'awaiting_human',
        reason: t.reason,
        intervalMs: slowed.intervalMs,
        cooldownMs: slowed.cooldownMs,
      });
      return 'failed';
    }
    if (t.stopRun) {
      this.stateFor(item.routeKey).markStopped(t.reason ?? 'terminal');
      this._emit({ type: 'stopped', reason: t.reason, url: item.url });
      return 'stop';
    }
    if (t.state === 'failed') {
      // 失败页阻塞该路线，且构成一处缺口——有缺口就不许推进水位线。
      this.stateFor(item.routeKey).recordGap(t.reason ?? 'failed', item.url);
      return 'failed';
    }

    // ── 6. 只有 ok 才继续翻页 / 派生新条目
    if (cls.verdict === 'ok') {
      // 叶子路线（没有分页的，比如作品详情页）不走 `observePage`，得在这里记一笔，
      // 否则它抓了几千页仍然显示「已抓 0」——而且只在出错时才出现在进度表上。
      if (!route.pagination) this.stateFor(item.routeKey).recordLeafCapture();
      this._enqueueNextPage(item, route, profile, res, written.captureId, items);
      this._enqueueSubjects(item, res, written.captureId);
      this._enqueueCover(item, res, written.captureId);

      // **单页路线抓到那一页就是走完了，当场标掉。**
      //
      // 判据是「有 entryUrl 且没有 pagination」：
      //
      // | 路线 | entryUrl | pagination | 是什么 |
      // |---|---|---|---|
      // | 个人主页 / 5 个分类入口 | 有 | 无 | **单页**——一页就是全部 |
      // | 广播 / 15 条标记列表 | 有 | 有 | 翻页，靠停滞检测或到达下界收尾 |
      // | 作品详情页 | 无 | 无 | **派生集合**——条目由列表页陆续入队 |
      //
      // 作品详情页必须排除：它的队列会**中途空掉**（列表页还没抓完，暂时没有新条目
      // 派生出来），那时标成走完了就是假的。
      //
      // 早先只在收尾时（`_settleUnfinished`）补这一刀，于是整场抓取期间那 6 条
      // 一直显示「进行中」——而它们在第一秒就抓完了。用户看到的是 6 行永远不动的
      // 「进行中」，合理地以为它们卡住了。
      if (route.entryUrl && !route.pagination) {
        const st = this.stateFor(item.routeKey);
        if (st.gaps.length === 0) st.markFinished();
      }
    }

    // ── 7. 这条路线跑到终点了？放开受它门控的条目。
    this._maybeOpenGate(item.routeKey);

    return 'ok';
  }

  /**
   * 取页失败的分流。
   *
   * 网络错误与超时可以重试；用户中止、以及**分不清的错误**一律不重试——
   * 把风控当网络错误去重试，代价是账号。
   */
  _handleTransportError(item, err) {
    const te = err instanceof TransportError ? err : null;

    // **连着几次都是网络层错误 = 网络没了，别再一条条熬超时。**
    //
    // 没有网络时每个请求都要熬满 30 秒才算失败，一批 25 条就是十几分钟；而预算
    // （22 秒）只在批与批之间检查，拦不住进行中的那一批。实测撞到过：电脑闲置、
    // 网络断开，一段推进跑了 **780 秒**（≈ 25 × 31 秒），期间心跳每 30 秒来一次、
    // 每次都只能说「上一段还在跑」。用户看到二十来行「未恢复」，像是彻底卡死。
    //
    // 网络断了是**全局状况**，不是这一条 URL 的问题——第 3 条还是同样的错，
    // 就没有任何理由再试第 4 条。停下来，记一个明确的原因，剩下的十几分钟省掉。
    // `network_down` 会自动恢复且不弹通知：用户什么都不用做，等着就好。
    if (te?.retryable) {
      this._consecutiveNetworkErrors += 1;
      if (this._consecutiveNetworkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS) {
        this.stateFor(item.routeKey).markStopped('network_down');
        this._frontier.stop('network_down');
        this._emit({
          type: 'stopped',
          reason: 'network_down',
          url: item.url,
          message:
            `连续 ${this._consecutiveNetworkErrors} 次请求都没能连上豆瓣，判定为网络中断。` +
            '已停下——不这么做的话，剩下的条目会一条条熬满超时，白耗十几分钟。',
        });
        return 'stop';
      }
    }

    if (te?.retryable) {
      const { willRetry } = this._frontier.settleNetworkError(item, te.message);
      this._emit({ type: 'retry', url: item.url, kind: te.kind, willRetry });
      if (!willRetry) {
        // **重试用尽也要留下痕迹。** 早先这条分支只是返回 'failed' 就完了：不记缺口，
        // 而叶子路线又从没走过 observePage，于是 `crawl_state` 与 `coverage` 双双为空
        // ——那一页的缺失在 manifest 里**完全不可检测**。
        //
        // 而 gaps 在规范里本来就是「必须显式记录，不得静默」。
        this.stateFor(item.routeKey).recordGap(
          'fetch_failed',
          `${item.url}：重试 ${item.attempts} 次仍失败（${te.message}）`,
        );
      }
      return willRetry ? 'retry' : 'failed';
    }

    if (te?.kind === 'aborted') {
      this._frontier.stop('user_paused');
      this._emit({ type: 'stopped', reason: 'user_paused', url: item.url });
      return 'stop';
    }

    // 站点权限被撤：**停止条件**，不是可重试错误。和会话失效同一档——
    // 重试一个永远不会自己好的问题，只会把几小时耗成一个查不出原因的失败。
    if (err instanceof PermissionError) {
      this.stateFor(item.routeKey).markStopped(err.reason);
      this._frontier.stop(err.reason);
      this._emit({ type: 'stopped', reason: err.reason, message: err.message, url: item.url });
      return 'stop';
    }

    // 分不清的错误：判失败并阻塞该路线，等人来看。
    // 异常本身的话要带上——否则失败列表里只剩一个 `unclassified`。
    this._frontier.settle(item, null, [String(err?.message ?? err)]);
    this.stateFor(item.routeKey).recordGap(
      'fetch_failed',
      `${item.url}：${String(err?.message ?? err)}`,
    );
    this._emit({ type: 'error', url: item.url, message: String(err?.message ?? err) });
    return 'failed';
  }

  /**
   * 从标记列表页派生作品详情页。
   *
   * ## 这条路线原本压根跑不起来
   *
   * `interest.item` 没有 `entryUrl`（所以永不入种子），也没有任何代码把作品 URL 放进
   * 队列——它有定义、有判定描述、有门控，但**从来没跑过一次**。这个函数是缺的那一环。
   *
   * ## 门控：等广播跑完
   *
   * 作品详情页占档案九成体积，但它是**最可替代的**——随时能重抓。而广播是可静默删除、
   * 删了就再也拿不回来的。所以不能拿最不可替代的东西去换最可替代的东西
   * （DESIGN F-03d/F-03k）。
   *
   * 实现上不是「门没开就丢掉」，而是**照样入队、由 frontier 挡住**。丢掉的话，一旦
   * 列表页在广播之前抓完（优先级排序保证了不会，但不该依赖那个），这些 URL 就再也不会
   * 被发现了。
   *
   * @param {object} item      刚抓完的那个列表页条目
   * @param {object} res
   * @param {string} captureId
   */
  _enqueueSubjects(item, res, captureId) {
    const def = this._routes.get(item.routeKey);
    // 只从标记列表页派生。作品详情页自己不派生（它没有列表），个人主页也不派生。
    if (!def || !item.routeKey.startsWith('interest.') || item.routeKey === 'interest.item') return;

    const target = this._routes.get('interest.item');
    if (!target) return; // includeCatalog:false

    let enqueued = 0;
    for (const url of extractSubjectLinks(res.bodyText)) {
      const ok = this._frontier.enqueue({
        url,
        urlKey: urlKey(url),
        routeKey: 'interest.item',
        intent: target.intent,
        enqueuedBy: captureId,
        // 叶子：条目之间没有先后关系，一个失败不该连带其余的。
        ordered: false,
        priority: target.priority,
        // 门控由 frontier 执行；`bypassGates` 是调试用的显式后门（见 CrawlLoop 构造）。
        gatedBy: this._bypassGates ? null : (target.requires?.[0] ?? null),
      });
      if (ok) enqueued += 1;
    }

    if (enqueued > 0) {
      this._emit({
        type: 'subjects_enqueued',
        routeKey: item.routeKey,
        count: enqueued,
        gated: !this._bypassGates && Boolean(target.requires?.length),
      });
    }
  }

  /**
   * 从作品详情页派生封面图。
   *
   * ## 为什么图片必须进档案
   *
   * 不抓的话，档案里每一页的封面都是一个指向 `doubanio.com` 的 URL——**这份备份要
   * 联网才能看**，而且是要豆瓣还在才能看。那正是这个项目存在的理由所要否定的东西
   * （DESIGN F-04e）。
   *
   * ## 只从作品详情页派生，不从列表页
   *
   * 列表页上的缩略图指向的是同一批作品，走详情页这一条路就够了；两边都抓等于把
   * 同一张封面存两个尺寸。**而广播页上那些 `view/status/small` 也是作品缩略图**，
   * 同理不在这里处理。
   *
   * 用户**自己上传**的图（相册、广播与日记正文内嵌）是另一回事：那是不可替代的，
   * 该进 `assets-*`，而且它们藏在一段 `<script>` 里的 JSON 中，不是 `<img src>`，
   * 需要另一个抽取器。目前**尚未实现**。
   *
   * @param {object} item      刚抓完的那个条目
   * @param {object} res
   * @param {string} captureId
   */
  _enqueueCover(item, res, captureId) {
    if (item.routeKey !== 'interest.item') return;
    const target = this._routes.get('asset.subject_cover');
    if (!target) return;

    const { url, reason } = extractCoverImage(res.bodyText);
    if (!url) {
      // **抽不到要留痕**，但要分清是哪一种抽不到：`placeholder` 是这个作品本来就
      // 没有海报（豆瓣显示占位图，实测 2916 个里有 7 个），什么都没坏；`not_found`
      // 是连容器都没有，多半意味着豆瓣改版了。
      //
      // 混成一句话的话，那几条正常情况会变成天天出现的噪音，而真正的改版信号会淹
      // 死在里面——几年后打开档案发现一片灰框时才知道。
      if (reason === 'not_found') {
        this._emit({ type: 'cover_not_found', routeKey: item.routeKey, url: item.url });
      }
      return;
    }

    const ok = this._frontier.enqueue({
      url,
      urlKey: urlKey(url),
      routeKey: 'asset.subject_cover',
      intent: target.intent,
      enqueuedBy: captureId,
      // 叶子：一张图取不到不该连累其他图。
      ordered: false,
      priority: target.priority,
      // **不设 gatedBy。** 它的门是它的来源：封面只可能从一张已经抓到的详情页上
      // 抽出来，而详情页自己是被门控的。再挂一道门只会让它永远等一个已经开了的闸。
      gatedBy: null,
      // Referer 要设成作品页——豆瓣的图片服务对着空 Referer 有时会给别的东西，
      // 而一个真实浏览器本来就会发这个头（见 transport.js）。
      referer: item.url,
    });
    if (ok) this._emit({ type: 'cover_enqueued', url, from: item.url });
  }

  /**
   * 抽取并入队下一页。
   *
   * 终止靠**停滞检测**——不是「本页没有新条目」，更不是「本页条目数少于
   * 槽位」。实测中列表中段会出现被审查抑制的空洞（第 7、14、17 页只渲染
   * 14、14、13 条，槽位 15），把短页当末页会把列表拦腰截断。
   */
  _enqueueNextPage(item, route, profile, res, captureId, items) {
    if (!route.entryUrl || !route.pagination) return;

    const state = this.stateFor(item.routeKey);
    const claimed = profile ? extractClaimedCount(res.bodyText, profile) : null;

    const { ids, times } = items;
    const progress = state.observePage({
      ids,
      times,
      claimed,
      captureId,
      observedAt: nowRfc3339(),
    });

    this._emit({
      type: 'page',
      routeKey: item.routeKey,
      newIds: progress.newIds,
      duplicates: progress.duplicates,
      total: state.stall.uniqueCount,
      highWater: state.highWater?.iso ?? null,
    });

    // 到达下界：增量抓取的正常终点。这是「干净走完」的一种，可以推进水位线。
    if (progress.reachedFloor) {
      state.markFinished();
      this._emit({
        type: 'route_finished',
        routeKey: item.routeKey,
        reason: 'reached_floor',
        highWater: state.highWater?.iso ?? null,
      });
      return;
    }

    // 停滞：另一种干净的终点。终止靠它，不靠「本页没有新条目」，更不靠
    // 「本页条目数少于槽位」——实测列表中段会有被审查抑制的空洞。
    if (progress.stalled) {
      state.markFinished();
      this._emit({
        type: 'route_finished',
        routeKey: item.routeKey,
        reason: 'stalled',
        highWater: state.highWater?.iso ?? null,
      });
      return;
    }

    const cur = item.cursor?.value ?? route.pagination.first;
    const nextValue = Number(cur) + route.pagination.step;
    const nextUrl = route.entryUrl({ offset: nextValue });

    this._frontier.enqueue({
      url: nextUrl,
      urlKey: urlKey(nextUrl),
      routeKey: item.routeKey,
      intent: route.intent ?? item.intent,
      enqueuedBy: captureId,
      cursor: { kind: route.pagination.kind, value: nextValue },
      // 走到这儿说明这条路线有分页，也就必然是有序的。
      ordered: true,
      // **优先级必须继承。**
      //
      // `Frontier.enqueue` 的默认值是 50，而广播是 10、标记列表是 40。种子是
      // 带着优先级入队的，翻页原先没带——于是广播第 2 页（50）输给了每一条
      // 标记列表的种子（40）。
      //
      // 后果不是「顺序稍微乱一点」，而是**整个优先级设计在第一页之后就失效了**：
      // 所有路线一律并列在 50，按入队顺序轮转，十几条线一起慢慢爬。而排序的
      // 全部意义在于「中途被打断时，先跑完的一定是最难补的」——广播是唯一
      // 可静默删除、删了就再也拿不回来的东西，它却成了最先被挤开的那条。
      //
      // 用 `item.priority` 兜底：恢复出来的条目也带着优先级，比再查一次路线表稳。
      priority: route.priority ?? item.priority,
    });
  }
}

/**
 * 这一页覆盖的时间区间。
 *
 * **原样保留**豆瓣给出的字符串，不解析成 ISO、不归一化时区——列表页不带时区，
 * 归一化就等于替它假定一个，而假定错了不可恢复（时区假定统一记在 manifest 里）。
 *
 * 但**排序**必须按解析后的毫秒，不能按字符串比大小：同一份列表里格式是混着来的
 * （「今天上午」与「2026-07-26 12:34:00」都出现过），字典序会给出错误的顺序。
 *
 * @param {string[]} times
 * @returns {{oldest: string | null, newest: string | null} | null}
 */
function itemTimeRange(times) {
  if (!times || times.length === 0) return null;

  /** @type {{ms: number, raw: string} | null} */
  let oldest = null;
  /** @type {{ms: number, raw: string} | null} */
  let newest = null;

  for (const raw of times) {
    let ms;
    try {
      ms = parseDoubanTimestamp(raw).epochMs;
    } catch {
      // 解析不了就不参与算区间。**这件事不会被静默丢掉**——同一页的时间解析失败
      // 由 RouteState 记成一处缺口（那才是它该管的地方），而有缺口就不许推进水位线。
      continue;
    }
    if (oldest === null || ms < oldest.ms) oldest = { ms, raw };
    if (newest === null || ms > newest.ms) newest = { ms, raw };
  }

  return oldest ? { oldest: oldest.raw, newest: newest.raw } : null;
}

