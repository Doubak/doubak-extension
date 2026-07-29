/**
 * 单条路线的推进状态：水位线、连续性、覆盖率。
 *
 * 设计：DESIGN.md §3.2/3.3、F-02c/d
 * 规范：doubak-data-specs/bundle/v1/SPEC.md §5.3/5.4
 *
 * ## 这里产出的是**唯一**的完整性证据
 *
 * 豆瓣的计数不可信（审查前后统计口径不一），所以「抓到的条数等于页面声称的
 * 条数」推不出「档案完整」。完整性只能来自抓取过程自身的结构化证明：**从最新
 * 一条连续无缺口地走到了预定的下界**。
 *
 * 这个类负责攒出那份证明，以及攒出「豆瓣当时声称了什么」这个观测记录——后者
 * 不是判据，但事后不可恢复，且差值有取证价值。
 *
 * ## 两个边界
 *
 * - **下界 `floorTime`**：往回抓到哪儿为止。首次抓取为 null（抓到最早），
 *   增量抓取取上次的水位线。比较用**闭区间**：宁可重复，不可遗漏。
 * - **上界 `highWaterTime`**：本次抓到的最新一条。豆瓣列表是新→旧，所以
 *   它就是第一页的第一条。跑完之后成为下次的下界。
 */

import { parseDoubanTimestamp, hasReachedFloor } from '../core/time.js';
import { StallDetector } from './frontier.js';
import { coverageEntry, crawlStateEntry } from '../bundle/manifest-builder.js';

export class RouteState {
  /**
   * @param {object} opts
   * @param {string} opts.routeKey
   * @param {string} opts.intent
   * @param {'bounded' | 'full'} opts.enumeration
   * @param {string | null} [opts.floorTime]      上次的水位线（RFC3339）
   * @param {number} [opts.stallThreshold]
   */
  constructor({ routeKey, intent, enumeration, floorTime = null, stallThreshold = 3 }) {
    this.routeKey = routeKey;
    this.intent = intent;
    this.enumeration = enumeration;
    this.stall = new StallDetector(stallThreshold);

    this.floorTime = floorTime;
    this._floorEpochMs = floorTime ? Date.parse(floorTime) : null;

    /** @type {{iso: string, raw: string, epochMs: number} | null} 本次见过的最新时间 */
    this.highWater = null;
    /** @type {string[]} 处于水位线那一刻的条目 ID，同秒多条时用于去重 */
    this.highWaterIds = [];

    /** @type {{count: number, raw: string, captureId: string, observedAt: string} | null} */
    this.claimed = null;
    this.capturedCount = 0;

    /** @type {Array<{reason: string, detail?: string}>} */
    this.gaps = [];
    this._finished = false;
    this._stopped = false;
    /** @type {object | null} */
    this.cursor = null;
  }

  /**
   * 记录一页的观测结果。
   *
   * @param {object} page
   * @param {string[]} page.ids       本页条目 ID，页面出现顺序
   * @param {string[]} [page.times]   本页条目的原始时间字符串，与 ids 同序
   * @param {{count: number, raw: string} | null} [page.claimed]
   * @param {string} page.captureId
   * @param {string} page.observedAt
   * @returns {{newIds: number, duplicates: number, stalled: boolean, reachedFloor: boolean}}
   */
  observePage({ ids, times = [], claimed = null, captureId, observedAt }) {
    const progress = this.stall.observePage(ids);
    this.capturedCount += progress.newIds;

    // 声明数量只记**第一次**读到的。实测每张列表页上都有这个数字，逐页复读
    // 能发现抓取过程中总数变了；但写进 coverage 的应当是开始时的那一个，
    // 否则「声称」与「实抓」比的就不是同一时刻的东西了。
    if (claimed && !this.claimed) {
      this.claimed = { ...claimed, captureId, observedAt };
    }

    let reachedFloor = false;
    for (const [i, raw] of times.entries()) {
      let parsed;
      try {
        parsed = parseDoubanTimestamp(raw);
      } catch {
        // 解析不了的时间不能当作「没有时间」而静默跳过——它可能意味着豆瓣
        // 换了格式，而水位线一旦算错，下次增量就会从错误的位置开始。
        this.recordGap('unparsable_time', `无法解析的时间：${raw}`);
        continue;
      }

      // 水位线是本次见过的最新一条。列表是新→旧，正常情况下第一页第一条
      // 就是它，但不假设顺序——取最大值更稳。
      if (!this.highWater || parsed.epochMs > this.highWater.epochMs) {
        this.highWater = { iso: parsed.iso, raw: parsed.raw, epochMs: parsed.epochMs };
        this.highWaterIds = [ids[i]].filter(Boolean);
      } else if (this.highWater && parsed.epochMs === this.highWater.epochMs) {
        // 同一秒可能有多条，全都记下来供下次去重
        if (ids[i] && !this.highWaterIds.includes(ids[i])) this.highWaterIds.push(ids[i]);
      }

      // 闭区间比较：正好等于下界也算到达。用严格小于会漏掉边界上那一秒的条目。
      if (hasReachedFloor(parsed.epochMs, this._floorEpochMs)) reachedFloor = true;
    }

    return { ...progress, reachedFloor };
  }

  /** 记一处缺口。有缺口就不许推进水位线。 */
  recordGap(reason, detail) {
    this.gaps.push({ reason, ...(detail ? { detail } : {}) });
  }

  /** 正常走到了终点：停滞检测触发，或到达下界。 */
  markFinished() {
    this._finished = true;
  }

  /** 被打断：风控、会话失效、用户放弃。 */
  markStopped(reason) {
    this._stopped = true;
    this.recordGap(reason ?? 'aborted');
  }

  /** 连续性是否成立：走到了终点、没有缺口、没有被打断。 */
  get contiguous() {
    return this._finished && this.gaps.length === 0 && !this._stopped;
  }

  /**
   * 水位线能不能推进。
   *
   * **核心不变量**：中途暂停、被风控打断、用户放弃——一律不推进。已抓到的
   * 数据照样留在 WARC 里，但下次仍从旧下界重走。重复是免费的，空洞是永久
   * 且不可检测的。
   */
  get canAdvance() {
    return this.contiguous && this.highWater !== null;
  }

  /**
   * 产出写进 manifest 的抓取存档信息。
   *
   * @param {string} bundleId
   * @param {string} [completedAt]
   */
  toCrawlState(bundleId, completedAt = null) {
    const advanced = this.canAdvance;
    return crawlStateEntry({
      routeKey: this.routeKey,
      intent: this.intent,
      // 不许推进时**仍然报告本次见到的水位线**，但 advanced=false 告诉下游
      // 「别拿它当下次的下界」。把它抹成 null 会丢掉一条有用的观测。
      highWaterTime: this.highWater?.iso ?? null,
      highWaterRaw: this.highWater?.raw ?? null,
      highWaterIds: this.highWaterIds,
      floorTime: this.floorTime,
      enumeration: this.enumeration,
      contiguous: this.contiguous,
      gaps: this.gaps,
      advanced,
      completedAt,
      bundleId,
    });
  }

  /**
   * 产出写进 manifest 的覆盖率观测。
   *
   * 注意它**不是完整性判据**——差值是线索不是判决。
   */
  toCoverage() {
    return coverageEntry({
      routeKey: this.routeKey,
      intent: this.intent,
      // 取不到就是 null。null 与 0 是严格不同的两件事。
      claimedCount: this.claimed?.count ?? null,
      claimedRaw: this.claimed?.raw ?? null,
      claimedSource: this.claimed?.captureId ?? null,
      claimedObservedAt: this.claimed?.observedAt ?? null,
      capturedCount: this.capturedCount,
    });
  }
}
