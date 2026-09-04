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
   * @param {number} [opts.priorCount]  恢复之前这条线已经抓了多少条（来自 index）
   */
  constructor({
    routeKey, intent, enumeration, floorTime = null, stallThreshold = 3, priorCount = 0,
    floorFromBundleId = null,
  }) {
    this.routeKey = routeKey;
    this.intent = intent;
    this.enumeration = enumeration;
    this.stall = new StallDetector(stallThreshold);

    this.floorTime = floorTime;
    /**
     * 这个下界取自哪一份档案。规范 §5.5.1。
     *
     * 记它是为了让「基准不在了」**可检测**：校验方按路线核对
     * `floor_time == 上一份的 high_water_time`，且那一份在场。
     * @type {string | null}
     */
    this.floorFromBundleId = floorFromBundleId;
    this._floorEpochMs = floorTime ? Date.parse(floorTime) : null;

    /** @type {{iso: string, raw: string, epochMs: number} | null} 本次见过的最新时间 */
    this.highWater = null;
    /**
     * 本次见过的**最旧**一条。这才是给人看的进度——见文件开头。
     * @type {{iso: string, raw: string, epochMs: number} | null}
     */
    this.lowWater = null;
    /**
     * 给人看的**进度**：抓到哪一段时间了。
     *
     * 与 `lowWater`（全局最小值）分开，因为一条离群的旧条目就能把后者永久钉死。
     * 见 `_advanceProgress()`。
     * @type {{iso: string, raw: string, epochMs: number} | null}
     */
    this.progressTime = null;
    /** @type {string[]} 处于水位线那一刻的条目 ID，同秒多条时用于去重 */
    this.highWaterIds = [];

    /** @type {{count: number, raw: string, captureId: string, observedAt: string} | null} */
    this.claimed = null;
    /**
     * 这条线一共抓了多少条目——**含恢复之前的**。
     *
     * 从 0 起算的话，界面上的「已抓」每次崩溃恢复都归零；而一场几小时的抓取会跨越
     * 很多次 service worker 死亡，于是那个数字显示的是「上次恢复以来」，用户读到
     * 的却是「一共」。起点由 index 提供（唯一权威的一份）。
     */
    this.capturedCount = priorCount;
    /** 起点。判断「本次会话有没有推进」时要减掉它。 */
    this.priorCount = priorCount;
    /** 本次会话抽到过多少个条目 ID（含重复）。见 `observePage` 与 `markFinished`。 */
    this._idsSeenThisSession = 0;
    /** @type {string | null} 第一个「抽得到条目、抽不到时间」的页面 */
    this._timeExtractionFailedAt = null;

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
    // **本次会话到底抽到过 ID 没有**，新的旧的都算。
    //
    // 下面 `markFinished()` 那道自检要的是这个，不是 `capturedCount`：
    //
    // - `capturedCount` 现在含恢复之前的数（否则界面上的「已抓」每次恢复都归零），
    //   拿它判就等于恢复之后自检永远沉默；
    // - 只数 `newIds` 也不对——一条恢复之后只读到重复页的路线，`newIds` 合法地
    //   是 0，那会误报「抽取器坏了」。
    //
    // 抽到过 ID（哪怕全是重复的）就说明抽取器在工作。
    this._idsSeenThisSession += progress.newIds + progress.duplicates;

    // 声明数量只记**第一次**读到的。实测每张列表页上都有这个数字，逐页复读
    // 能发现抓取过程中总数变了；但写进 coverage 的应当是开始时的那一个，
    // 否则「声称」与「实抓」比的就不是同一时刻的东西了。
    if (claimed && !this.claimed) {
      this.claimed = { ...claimed, captureId, observedAt };
    }

    let reachedFloor = false;
    /** @type {Array<{iso: string, raw: string, epochMs: number}>} 本页解析成功的时间 */
    const parsedTimes = [];
    for (const [i, raw] of times.entries()) {
      // **「这条没有日期」不是错误。** `extractItemPairs` 把 id 与时间成对返回，
      // 时间那一格允许为 null——实测 2098 个电影标记里有 8 个本来就没有日期。
      //
      // 记成 `unparsable_time` 缺口的话，那 8 条会让整条 movie.collect 永远无法推进
      // 水位线（有缺口就不许推进），也就是**这条线永远不能增量**。而它们并没有坏。
      //
      // 与下面那条「解析不了」要分开：那一种是有字符串但读不懂，多半是豆瓣换了格式。
      if (raw === null || raw === undefined || raw === '') continue;

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

      // 另一头：本次见过的**最旧一条**。这是一句关于档案的事实
      // （「这份档案往回覆盖到了哪儿」），进 manifest。同样不假设顺序，取最小值。
      //
      // **它不适合当进度看**——见下面 `progressTime`。
      if (!this.lowWater || parsed.epochMs < this.lowWater.epochMs) {
        this.lowWater = { iso: parsed.iso, raw: parsed.raw, epochMs: parsed.epochMs };
      }

      parsedTimes.push(parsed);

      // 闭区间比较：正好等于下界也算到达。用严格小于会漏掉边界上那一秒的条目。
      if (hasReachedFloor(parsed.epochMs, this._floorEpochMs)) reachedFloor = true;
    }

    this._advanceProgress(parsedTimes);

    return { ...progress, reachedFloor };
  }

  /**
   * 推进给人看的**进度**：`progressTime`。
   *
   * ## 为什么不能直接用 `lowWater`
   *
   * `lowWater` 是全局最小值，而**一条离群的旧条目就能把它永久钉死**。真实数据里
   * 就有：一份 20 页的广播列表严格新→旧，唯独第 10 页里混着一条 2018 年的：
   *
   *     第 9 页  → 2025-12-09
   *     第 10 页 → 2018-08-18   ← 离群
   *     第 11 页 → 2025-08-29
   *
   * 从第 10 页起，界面上的「已回溯到」就一直是 2018-08-18，**再也不动**——而抓取
   * 还有一大半没跑完。用户看到的是一个卡住的进度，并且合理地怀疑抓取本身卡住了。
   *
   * 那个值本身没说谎（我们确实抓到了一条 2018 的），只是它回答的不是「抓到哪儿了」。
   *
   * ## 用每页的中位数
   *
   * 一条离群值动不了中位数，而页与页之间的中位数仍然稳定递减。再对它取累计最小值，
   * 保证进度**只往前不回头**——进度条来回跳比不动更让人不安。
   *
   * `lowWater` 保持原样进 manifest：抓完之后「这份档案往回覆盖到 X」正是那个全局
   * 最小值，那时它是对的。两个量回答两个问题，不该合成一个。
   *
   * @param {Array<{iso: string, raw: string, epochMs: number}>} times  本页**已解析**的时间
   */
  _advanceProgress(times) {
    // 用主循环解析好的结果，不在这里重新解析：`parseDoubanTimestamp` 解析不了会抛，
    // 而「解析不了」有它自己的处置（记缺口），不该在这儿被吞掉或炸掉。
    const parsed = times.filter((t) => t && Number.isFinite(t.epochMs));
    if (parsed.length === 0) return;

    parsed.sort((a, b) => a.epochMs - b.epochMs);
    const mid = parsed[Math.floor(parsed.length / 2)];

    if (!this.progressTime || mid.epochMs < this.progressTime.epochMs) {
      this.progressTime = { iso: mid.iso, raw: mid.raw, epochMs: mid.epochMs };
    }
  }

  /**
   * 这一页抽到了条目、却一条时间都没抽到。
   *
   * **不记成缺口**：数据没缺，缺的是「这条线能不能增量」这个能力。记成缺口会让
   * `contiguous` 变成 false，而那是在说「这段区间可能不完整」——不实。
   *
   * 只记一次：一条线上每一页都会这样，重复报没有意义。
   *
   * @param {string} url
   */
  noteTimeExtractionFailed(url) {
    if (this._timeExtractionFailedAt) return;
    this._timeExtractionFailedAt = url;
  }

  /** 有没有出现过「抽得到条目、抽不到时间」。 */
  get timeExtractionFailed() {
    return this._timeExtractionFailedAt ?? null;
  }

  /**
   * 记一处缺口。有缺口就不许推进水位线。
   *
   * `url` 是**结构化的那一份**。`detail` 是给人看的一句话（里面往往也含着 URL），
   * 而 `url` 供 `resolveGap()` 精确比对。不能拿 detail 做子串匹配：两条 URL 可以
   * 互为前缀，而这里判错的方向是**悄悄抹掉一处真缺口**——最不能出的那种错。
   * 不是所有缺口都有 URL（`aborted`、`no_items_observed` 就没有），没有的那些
   * 也就永远不会被下面那个方法碰到，这正是想要的。
   */
  recordGap(reason, detail, url) {
    this.gaps.push({ reason, ...(detail ? { detail } : {}), ...(url ? { url } : {}) });
  }

  /**
   * 这处缺口被**我们自己后来的证据**推翻了：同一个 URL 真的抓下来了。
   *
   * 实测的漏洞（2026-09-03 的一次全量抓取）：一张广播配图三次都超时，于是记下
   * 「重试 3 次仍失败」；用户点了「重试」，这一次**成功了**，索引里躺着那条
   * `verdict: ok`、542163 字节的捕获——而 manifest 里那处缺口原样留着，
   * 于是这条路线的 `contiguous` 永久是 false。**档案是全的，声明是错的。**
   *
   * 缺口是只增不减的，这在别处都对（中途停下、抽取器坏了，都不该被后来的成功
   * 冲掉），唯独「这一页抓不下来」不是：它是一句关于**某一个 URL** 的断言，
   * 而同一个 URL 的一次成功捕获正好把它证伪。
   *
   * 方向也值得说清楚：抹掉缺口等于**放宽**完整性声明，所以判据必须严——只认
   * 完全相同的 URL，且只在本次抓取内。上一份档案里的缺口是冻住的，不去动它，
   * 那份档案当时确实没抓到。
   *
   * @param {string} url
   * @returns {number}  抹掉了几处
   */
  resolveGap(url) {
    if (!url) return 0;
    const before = this.gaps.length;
    this.gaps = this.gaps.filter((g) => g.url !== url);
    return before - this.gaps.length;
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

    if ((this.claimed?.count ?? 0) > 0 && this._idsSeenThisSession === 0) {
      this.recordGap(
        'no_items_observed',
        `页面声称有 ${this.claimed.count} 条，但一个条目 ID 都没抽到——` +
          '停滞检测靠 ID 判断进展，抽不到就等于没有终止条件，「跑完了」不成立。' +
          '最可能是豆瓣改版或这条路线的 idAnchor 不匹配。',
      );
    }
  }

  /**
   * 记一次**叶子**捕获（作品详情页这类没有分页的路线）。
   *
   * 分页路线走 `observePage()`，那里按抽到的条目 ID 计数。叶子路线没有条目列表，
   * 一次捕获就是一个条目。
   *
   * 不记的话，成功的叶子捕获**不碰任何状态**——于是「作品详情页」这一行在抓了
   * 几千页之后仍然显示「已抓 0」，而且它只在**出错**时才会出现在表上（失败会
   * 记缺口，从而建出状态）。一条只在坏掉时才现身、且永远写着 0 的进度行，比没有
   * 这一行更糟。
   */
  recordLeafCapture() {
    this.capturedCount += 1;
    this._idsSeenThisSession += 1;
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
   * 交出全部状态，供 checkpoint 保存。
   *
   * ## 为什么整条状态都要存
   *
   * 连续性证明是这个项目唯一的完整性依据，而它是**跨越整场抓取**攒出来的。
   * 这个对象活在内存里，而 MV3 的 service worker 每 30 秒空闲就被杀——一场几小时的
   * 抓取必然跨越很多次死亡。
   *
   * 不存的后果是**静默的**：抓取照常跑完，manifest 照常写出来，只是里面每一条路线
   * 都写着「被打断、未验证、不许推进水位线」。真实档案里就是这样：21 条路线全是
   * 「有 1 处缺口，原因：aborted」，而实际上一次都没被打断过。
   *
   * 判据：**恢复之后产出的 manifest，必须与「一次不间断跑完」产出的那份一致。**
   */
  serialize() {
    return {
      // **下界必须交还。**
      //
      // 它不是「开抓时算一次就用完」的参数，而是这条路线状态的一部分：`enumeration`
      // 报 full 还是 bounded 完全取决于它（见 `effectiveEnumeration`）。
      //
      // 丢了会怎样，实测过一份真实档案（20260807T083529Z-0fb09c）：用户跑的是
      // 「增量 + 重抓作品详情页」，中途重载了扩展再继续。恢复之后每条路线的下界都成了
      // null，于是 manifest 写出来的是
      //
      //     interest.book.wish  enumeration=full  advanced=true  声称 82 / 抓到 15
      //
      // 每条列表只走了一页——那对增量是对的——**却声称自己完整枚举了整份列表**。
      // 按 canonical/INGESTION.md §3，这个组合给下游的是 whole_route 权限，也就是
      // 有资格断定那 67 本书被删了。
      //
      // 这是这份规范里最不能出的那种错：**假的完整性声明**，而且它是恢复一次就
      // 悄悄发生的。缺口那一行的注释说的是同一件事，这里是它的另一半。
      floor_time: this.floorTime,
      floor_from_bundle_id: this.floorFromBundleId,
      high_water_time: this.highWater?.iso ?? null,
      high_water_raw: this.highWater?.raw ?? null,
      high_water_ids: this.highWaterIds,
      low_water_time: this.lowWater?.iso ?? null,
      low_water_raw: this.lowWater?.raw ?? null,
      progress_time: this.progressTime?.iso ?? null,
      progress_raw: this.progressTime?.raw ?? null,
      claimed: this.claimed,
      captured_count: this.capturedCount,
      // **缺口一定要交还。** 丢了就等于恢复之后重新声称自己是连续的——
      // 这是这份规范里最不能出的那种错：假的完整性声明。
      gaps: this.gaps,
      finished: this._finished,
      stopped: this._stopped,
      cursor: this.cursor,
      stall: this.stall.serialize(),
      items_seen: this.stall.uniqueCount,
      stall_counter: this.stall.consecutiveNoProgress,
    };
  }

  /**
   * 从 checkpoint 里的状态恢复。
   *
   * @param {object} opts  与构造函数相同
   * @param {ReturnType<RouteState['serialize']>} saved
   */
  static restore(opts, saved) {
    const s = new RouteState(opts);
    if (!saved) return s;

    // 存档点里的下界优先于调用方传进来的。恢复时调用方通常什么都不知道
    // （`resolveFloors` 只在开抓时跑一次），所以这里才是权威。
    if (saved.floor_time !== undefined) {
      s.floorTime = saved.floor_time;
      s._floorEpochMs = saved.floor_time ? Date.parse(saved.floor_time) : null;
    }
    if (saved.floor_from_bundle_id !== undefined) s.floorFromBundleId = saved.floor_from_bundle_id;

    const mark = (iso, raw) => (iso ? { iso, raw: raw ?? iso, epochMs: Date.parse(iso) } : null);
    s.highWater = mark(saved.high_water_time, saved.high_water_raw);
    s.lowWater = mark(saved.low_water_time, saved.low_water_raw);
    s.progressTime = mark(saved.progress_time, saved.progress_raw);
    s.highWaterIds = saved.high_water_ids ?? [];
    s.claimed = saved.claimed ?? null;
    // 计数以 checkpoint 为准；它比从 index 汇总更精确（index 里没有「唯一条目」的概念）。
    if (typeof saved.captured_count === 'number') s.capturedCount = saved.captured_count;
    s.gaps = saved.gaps ? [...saved.gaps] : [];
    s._finished = Boolean(saved.finished);
    s._stopped = Boolean(saved.stopped);
    s.cursor = saved.cursor ?? null;
    if (saved.stall) s.stall = StallDetector.restore(saved.stall);
    // `_idsSeenThisSession` **刻意不恢复**：它问的是「本次会话抽到过 ID 没有」，
    // 那是抽取器坏没坏的判据，按会话算才有意义。
    return s;
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
   * 写进 manifest 的那个 `enumeration`。**不是**路线定义上的那个。
   *
   * 路线定义里的是静态常量：标记列表写死 `'full'`，注释的理由是「整份列表从头走到
   * 尾，所以『上次有这次没有』是有意义的信号」。那句话只对**首次**全量成立——链上
   * 一旦有了下界，这条线读到下界就停，下界以下这次压根没看。
   *
   * 两者不对账的后果在真实档案里发生过（`20260806` 那份，12 条路线）：
   *
   *     interest.movie.collect   claimed=1336  captured=15  enumeration="full"
   *
   * 下游拿它和首次全量做差，会得出「用户删了 1321 条看过」。规范 §5.4.3 说的正是
   * 这个方向：「静默地把没删的当成删了，而且事后无从发现」。
   *
   * 保守方向是 `bounded`——多报一次 bounded 只是少一个删除信号，多报一次 full 是
   * 凭空捏造删除。所以只看有没有下界，不去分辨「这次其实碰巧走完了整份」。
   *
   * @returns {'full' | 'bounded'}
   */
  get effectiveEnumeration() {
    return this.floorTime ? 'bounded' : this.enumeration;
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
      lowWaterTime: this.lowWater?.iso ?? null,
      lowWaterRaw: this.lowWater?.raw ?? null,
      floorTime: this.floorTime,
      floorFromBundleId: this.floorFromBundleId,
      enumeration: this.effectiveEnumeration,
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
