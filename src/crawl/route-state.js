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
 *
 * ## `highWater` 不是进度，别拿它当进度显示
 *
 * 它是**下次抓取的下界**，而不是「这次走到哪儿了」。因为列表是新→旧，第一页就把它
 * 定住了，之后**永远不动**——界面上原来用它显示「已回溯到 X」，于是抓了十页那个
 * 日期一动不动，看起来像卡住了。（真的被当成 bug 报过。）
 *
 * 表示进度的是另一头：`lowWater`，**本次见过的最旧一条**。每往回翻一页它就往前走
 * 一点，那才是「已回溯到」这句话的意思。
 *
 * 两者都留着，因为它们回答的是两个不同的问题：
 *
 * | | 是什么 | 谁要看 |
 * |---|---|---|
 * | `highWater` | 本次最新的一条 | 下次抓取（当下界） |
 * | `lowWater` | 本次最旧的一条 | 用户（当进度） |
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
    /**
     * 本次见过的**最旧**一条。这才是给人看的进度——见文件开头。
     * @type {{iso: string, raw: string, epochMs: number} | null}
     */
    this.lowWater = null;
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

      // 另一头：本次见过的最旧一条。它是**进度**，每往回翻一页就前进一点。
      // 同样不假设顺序，取最小值。
      if (!this.lowWater || parsed.epochMs < this.lowWater.epochMs) {
        this.lowWater = { iso: parsed.iso, raw: parsed.raw, epochMs: parsed.epochMs };
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

  /**
   * 正常走到了终点：停滞检测触发，或到达下界。
   *
   * ## 一个都没看见时，「走到终点」不是证据
   *
   * 停滞检测靠「本页有没有新 id」判断有没有进展。**抽不到 id 就等于没有停滞检测**——
   * 每页都算「没有进展」，于是第 3 页就触发终止，而因为没有缺口，`contiguous` 报 true。
   *
   * 这真的发生过：`interest.list` 的 `idAnchor` 只写了 `/subject/N`，漏了舞台剧的
   * `/location/drama/N`。一次真实抓取把 3 条全抓到了，coverage 却写着
   * 「声称 3 / 抓到 0 / 差值 −3 / **连续性 ✔ 已验证**」。对 89 页的电影列表，那就是
   * 第 3 页截断 + 声称已验证。
   *
   * 所以这里加一道自检：抓过页面、而且页面自己声称有条目，却一个 id 都没观测到——
   * 那不是「列表是空的」，那是**抽取器坏了**。记成缺口，让它挡住水位线并显示出来。
   *
   * 判据用 `claimed > 0` 而不是「抓过页面」：空列表（claimed 0、0 条目）是完全正常的，
   * 而且那时 `contiguous` 确实成立。
   */
  markFinished() {
    this._finished = true;

    if ((this.claimed?.count ?? 0) > 0 && this.capturedCount === 0) {
      this.recordGap(
        'no_items_observed',
        `页面声称有 ${this.claimed.count} 条，但一个条目 ID 都没抽到——` +
          '停滞检测靠 ID 判断进展，抽不到就等于没有终止条件，「跑完了」不成立。' +
          '最可能是豆瓣改版或这条路线的 idAnchor 不匹配。',
      );
    }
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
