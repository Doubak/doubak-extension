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
  RollingSize,
  profileForRoute,
  extractItemIds,
  extractItemTimes,
  extractClaimedCount,
} from './classifier.js';
import { SessionError } from './session.js';
import { TransportError } from './errors.js';
import { RouteState } from './route-state.js';
import { urlKey } from '../core/urlkey.js';
import { nowRfc3339 } from '../core/time.js';

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
  constructor({ frontier, transport, writer, session, pacer, routes, onEvent, floors }) {
    this._frontier = frontier;
    this._transport = transport;
    this._writer = writer;
    this._session = session;
    this._pacer = pacer;
    this._routes = routes;
    this._emit = onEvent ?? (() => {});

    /** @type {Map<string, RollingSize>} 每条路线的体积基线 */
    this._sizes = new Map();
    /** @type {Map<string, RouteState>} 每条路线的水位线与连续性 */
    this._states = new Map();
    /** @type {Map<string, string>} routeKey → 最后一次 capture_id，用于 parent 链 */
    this._lastCapture = new Map();
    this._floors = floors ?? new Map();
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
      this._states.set(
        routeKey,
        new RouteState({
          routeKey,
          intent: route.intent ?? routeKey,
          enumeration: route.enumeration ?? 'bounded',
          floorTime: this._floors.get(routeKey) ?? null,
        }),
      );
    }
    return this._states.get(routeKey);
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
      // 还没结束的路线记为被打断——不许推进水位线。
      if (!state.contiguous && !state._finished && !state._stopped) {
        state.markStopped('aborted');
      }
      this._writer.addCoverage(state.toCoverage());
      this._writer.addCrawlState(state.toCrawlState(this._writer.bundleId, completedAt));
    }
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

    // ── 1. 取页
    let res;
    try {
      res = await this._transport.fetch(item.url, {
        referer: route.referer,
        withCk: route.surface === 'api',
      });
    } catch (err) {
      return this._handleTransportError(item, err);
    }

    // ── 2. 判定
    const sizes = this._sizeFor(item.routeKey);
    const cls = profile
      ? classifyResponse({
          finalUrl: res.finalUrl,
          status: res.status,
          bodyText: res.bodyText,
          route: profile,
          sizeStats: sizes.stats(),
        })
      : // 没有判定描述的路线（比如作品详情页）只做最基本的判断
        { verdict: res.status === 200 ? 'ok' : null, reasons: ['该路线没有判定描述'], itemCount: null };

    if (cls.verdict === 'ok') sizes.add(res.bodyText.length);

    // ── 3. 写档案（无论判定是什么）
    //
    // 封锁页与登录页必须进档案：存下来才能在不重新抓取的前提下重训分类器，
    // 而真实旧档案里恰恰是「存了但没标注」造成了静默的数据损坏。
    const written = await this._writer.writeCapture({
      url: res.requestedUrl,
      finalUrl: res.finalUrl !== res.requestedUrl ? res.finalUrl : undefined,
      intent: route.intent ?? item.intent,
      routeKey: item.routeKey,
      surface: route.surface ?? 'html',
      verdict: cls.verdict ?? 'blocked', // 判不出来的也要留证，但不能标成 ok
      captureFidelity: this._transport.fidelity,
      httpStatus: res.status,
      headers: res.headers,
      contentType: res.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1],
      body: res.body,
      kind: route.kind ?? 'data',
      parentCaptureId: item.enqueuedBy ?? this._lastCapture.get(item.routeKey) ?? null,
      cursor: item.cursor ?? null,
      note: cls.verdict === null ? `判不出来：${cls.reasons.join('；')}` : undefined,
    });
    this._lastCapture.set(item.routeKey, written.captureId);

    this._emit({
      type: 'capture',
      captureId: written.captureId,
      routeKey: item.routeKey,
      verdict: cls.verdict,
      itemCount: cls.itemCount,
      reasons: cls.reasons,
    });

    // ── 4. 会话复核（分类器看不出账号切换）
    try {
      this._session.verify(res.bodyText);
    } catch (err) {
      if (err instanceof SessionError) {
        // 被打断的路线不许推进水位线：已抓到的数据留在 WARC 里，但下次仍从
        // 旧下界重走。重复是免费的，空洞是永久且不可检测的。
        this.stateFor(item.routeKey).markStopped(err.reason);
        this._frontier.stop(err.reason);
        this._emit({ type: 'stopped', reason: err.reason, message: err.message });
        return 'stop';
      }
      throw err;
    }

    // ── 5. 推进 frontier
    const t = this._frontier.settle(item, cls.verdict);

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
      this._emit({ type: 'stopped', reason: t.reason });
      return 'stop';
    }
    if (t.state === 'failed') {
      // 失败页阻塞该路线，且构成一处缺口——有缺口就不许推进水位线。
      this.stateFor(item.routeKey).recordGap(t.reason ?? 'failed', item.url);
      return 'failed';
    }

    // ── 6. 只有 ok 才继续翻页
    if (cls.verdict === 'ok') {
      this._enqueueNextPage(item, route, profile, res, written.captureId);
    }
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

    if (te?.retryable) {
      const { willRetry } = this._frontier.settleNetworkError(item, te.message);
      this._emit({ type: 'retry', url: item.url, kind: te.kind, willRetry });
      return willRetry ? 'retry' : 'failed';
    }

    if (te?.kind === 'aborted') {
      this._frontier.stop('user_paused');
      this._emit({ type: 'stopped', reason: 'user_paused' });
      return 'stop';
    }

    // 分不清的错误：判失败并阻塞该路线，等人来看。
    this._frontier.settle(item, null);
    this._emit({ type: 'error', url: item.url, message: String(err?.message ?? err) });
    return 'failed';
  }

  /**
   * 抽取并入队下一页。
   *
   * 终止靠**停滞检测**——不是「本页没有新条目」，更不是「本页条目数少于
   * 槽位」。实测中列表中段会出现被审查抑制的空洞（第 7、14、17 页只渲染
   * 14、14、13 条，槽位 15），把短页当末页会把列表拦腰截断。
   */
  _enqueueNextPage(item, route, profile, res, captureId) {
    if (!route.entryUrl || !route.pagination) return;

    const state = this.stateFor(item.routeKey);
    const ids = profile ? extractItemIds(res.bodyText, profile) : [];
    const times = profile ? extractItemTimes(res.bodyText, profile) : [];
    const claimed = profile ? extractClaimedCount(res.bodyText, profile) : null;

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
    });
  }
}
