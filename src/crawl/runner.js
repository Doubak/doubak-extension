/**
 * 一次抓取的编排：开始、分批推进、收尾。
 *
 * 设计：DESIGN.md F-01e、F-10a~h
 *
 * ## 为什么要分批
 *
 * MV3 的 service worker 约 30 秒空闲就被杀，而一场抓取要跑几小时。所以循环
 * **不能一口气跑到底**——它必须能在任意一批之后干净地停下，并且停下的地方
 * 是可恢复的。
 *
 * 每批之后写一次 checkpoint。这样 worker 被杀最多丢掉「这一批里已经抓完但
 * 还没记进 checkpoint 的游标」——而那个损失是**幂等可修的**：捕获本身早就
 * 落盘了（写入器保证每页落盘），恢复时按 index 重建即可，最坏是重抓几页。
 *
 * 批的大小是个权衡：太大，被杀时白跑的多；太小，checkpoint 写得太频。
 *
 * ## 开工前必须先确认身份
 *
 * 不是形式主义：数字用户 ID 是档案的归属主键，而它**多数页面上取不到**，
 * 必须专门抓一次个人主页。顺带确认会话有效——未登录不仅看不到私密条目，
 * 请求频率上限也更低。
 */

import { BundleWriter } from '../bundle/bundle-writer.js';
import { CrawlLoop } from './loop.js';
import { Frontier } from './frontier.js';
import { SessionGuard, extractAccountHints, detectLoginState } from './session.js';
import { Pacer } from './pacing.js';
import { Transport } from './transport.js';
import { RequestGate } from './pacing.js';
import { buildRoutes } from './routes.js';
import { buildCheckpoint } from './run-store.js';
import { bundleDirName, newBundleId } from '../core/ids.js';
import { urlKey } from '../core/urlkey.js';
import { CRASH_SENTINEL_REASON } from './resume-policy.js';

/** 一批抓多少条。见文件开头的权衡说明。 */
export const DEFAULT_BATCH_SIZE = 25;

export class CrawlRunner {
  /**
   * @param {object} opts
   * @param {import('./run-store.js').RunStore} opts.runStore
   * @param {(dir: string) => Promise<import('../storage/file-store.js').FileStore>} opts.openBundle
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {() => Promise<string | null>} [opts.getCk]
   * @param {(evt: object) => void} [opts.onEvent]
   * @param {() => Date} [opts.now]
   * @param {number} [opts.batchSize]
   * @param {object} [opts.pacerOptions] 覆盖节奏参数。**仅用于测试**——
   *   真实抓取必须用默认值，那是按前代战绩定下来的（见 pacing.js）。
   */
  constructor({
    runStore, openBundle, fetchImpl, getCk, onEvent, now,
    batchSize = DEFAULT_BATCH_SIZE, pacerOptions,
  }) {
    this._runStore = runStore;
    this._openBundle = openBundle;
    this._fetchImpl = fetchImpl;
    this._getCk = getCk;
    this._emit = onEvent ?? (() => {});
    this._now = now ?? (() => new Date());
    this._batchSize = batchSize;
    this._pacerOptions = pacerOptions;

    /** @type {object | null} 当前这次抓取的全部部件 */
    this._run = null;

    // **整个 runner 共用一个闸门。**
    //
    // 间隔是「我们和豆瓣之间这条连接」的属性，不是某一次活动的属性。一次抓取由
    // 好几段活动组成——先确认身份，再开工；崩溃之后又是一次恢复——每段各建一个
    // 闸门的话，每段的第一个请求都不等待（`_lastFinishedAt` 是 null），于是身份
    // 确认那一发和开工探测那一发会**贴在一起**发出去。豆瓣看到的只有请求，它不
    // 关心我们内部把它们算作几段活动。
    //
    // Pacer 每段仍然可以换（它带着退避层级，要跟 checkpoint 走），换的时候计时
    // 与排队状态留在闸门里——见 `RequestGate.setPacer`。
    this._gate = new RequestGate({ pacer: new Pacer(this._pacerOptions) });
  }

  /**
   * 自动发现当前登录账号的用户名。
   *
   * 用户不该被要求手输用户名——他已经登录了，浏览器里就有答案。
   * `https://www.douban.com/mine/` 会跳转到 `/people/<username>/`。
   *
   * ## 先看页面内容，再看最终 URL
   *
   * 顺序是刻意的。最终 URL 靠的是跳转被正确跟随，而那件事**曾经悄悄失效过**：
   * `redirect: 'manual'` 在浏览器里返回 opaqueredirect（读不到 Location），
   * 于是最终 URL 停在跳转前的 `/mine/`，解析不出用户名，报出来的却是
   * 「请先登录豆瓣」——把人指向完全错误的方向。
   *
   * 页面**内容**里的个人主页链接不依赖任何跳转语义，是更硬的证据。所以以它
   * 为主，URL 只作补充。
   *
   * 还有一层好处：内容解析能顺带区分「跳转没成」与「真的没登录」，而这两件事
   * 的下一步动作完全不同。
   *
   * @returns {Promise<{username: string, finalUrl: string}>}
   */
  async discoverUsername() {
    // 走共享闸门：身份确认与随后的开工探测之间也要隔够间隔。
    const transport = new Transport({ gate: this._gate, fetchImpl: this._fetchImpl });

    const res = await transport.fetch('https://www.douban.com/mine/');

    // ① 页面内容里的 /people/<name>/ 链接。不依赖跳转语义。
    const hints = extractAccountHints(res.bodyText);
    if (hints.username) return { username: hints.username, finalUrl: res.finalUrl };

    // ② 退回到最终 URL。
    const m = /\/people\/([A-Za-z0-9_-]+)\/?/.exec(res.finalUrl);
    if (m && m[1] !== 'mine') return { username: m[1], finalUrl: res.finalUrl };

    // 两条都没成。三种情况的下一步动作完全不同，必须分开说——混成一句话会让
    // 用户去做没用的事（比如对着一个改版问题反复重新登录）。
    const state = detectLoginState(res.bodyText);
    if (state === 'logged_out') {
      throw new Error(
        '当前未登录豆瓣。请先在浏览器里登录再开始——未登录不仅看不到私密条目，' +
          '请求频率上限也更低。',
      );
    }
    if (state !== 'logged_in') {
      throw new Error(
        `无法确定登录状态：${res.finalUrl} 返回的页面认不出来（HTTP ${res.status}，` +
          `${res.bodyText.length} 字节）。可能是登录页或风控页。` +
          '请先在浏览器里打开豆瓣确认能正常访问。',
      );
    }
    throw new Error(
      `已登录，但没能从 ${res.finalUrl} 认出用户名（HTTP ${res.status}，` +
        `${res.bodyText.length} 字节）。豆瓣可能改版了——` +
        '可以打开调试页跑一次演练，确认其余环节是否正常。',
    );
  }

  get active() {
    return this._run !== null;
  }

  /**
   * 开一次新抓取。
   *
   * @param {object} opts
   * @param {string} opts.username
   * @param {string[]} [opts.mediums]
   * @param {boolean} [opts.includeCatalog]
   * @param {Map<string, string | null>} [opts.floors]  上次的水位线
   * @param {string[]} [opts.knownSubjectUrlKeys]  链上已经抓过的作品详情页。传了就
   *   不再抓一遍——那条路线占档案九成体积，而「增量」对它不成立（没有时间序）。
   *   **只能传作品详情页的 key**：列表页的 URL 每次都一样，喂进去会让这次一页都抓不成。
   * @param {(account: object) => Promise<object>} [opts.resolveFloors]  **在身份确认之后**
   *   挑下界。顺序是必须的：判据是数字用户 ID，而它只有 preflight 之后才知道。
   *   读档案不是 runner 的事，所以动作由调用方注入，这里只定顺序。
   *   显式传了 `floors`（小范围试跑）时不会调用它。
   * @param {Map<string, string>} [opts.floorSources]  每条路线的下界取自哪一份档案。
   *   与 `floors` 分开传是因为它们回答不同的问题：前者是「抓到哪儿为止」，后者是
   *   「这个下界凭什么」——后者要写进 manifest，好让「基准不在了」可检测（规范 §5.5）。
   * @param {string | null} [opts.previousBundleId]
   * @param {string[]} [opts.onlyRoutes]  只抓这几条路线。用于小范围试跑——
   *   挑一条**天然很小**的路线（比如舞台剧只有一两条），就能完整走完整个
   *   生命周期，包括干净终止与水位线推进。
   * @param {number} [opts.maxCaptures]  硬上限。这是**安全阀不是终止条件**：
   *   被它截断的抓取不算干净完成，水位线不会推进，产出的是不完整的档案。
   */
  async start({
    username, mediums, includeCatalog = true, floors, floorSources, previousBundleId = null,
    onlyRoutes = null, maxCaptures = null, bypassGates = false, resolveFloors = null,
    knownSubjectUrlKeys = null,
  }) {
    if (this._run) throw new Error('已有抓取在进行中');

    const pacer = this._gate.setPacer(new Pacer(this._pacerOptions)).pacer;
    const gate = this._gate;
    const transport = new Transport({ gate, fetchImpl: this._fetchImpl, getCk: this._getCk });

    // ── 开工前的身份确认。取不到数字 ID 就不能开始。
    const session = new SessionGuard();
    const profileUrl = `https://www.douban.com/people/${encodeURIComponent(username)}/`;
    const probe = await transport.fetch(profileUrl);

    // 不需要退路。数字 uid 取自**全局导航**（`_GLOBAL_NAV.USER_ID` 等），而全局
    // 导航是每张登录后页面都有的共享组件——包括作品详情页。
    //
    // 曾经想过「主页取不到就去广播页补一次」。不需要了，而且那条退路本身有个更深
    // 的问题：它默认「广播条目上的 data-uid 就是本人」，而在作品详情页上那是
    // **评论者**的 ID。见 session.js 里 UID_PATTERNS 的说明。
    const account = session.preflight(probe.bodyText);
    this._emit({ type: 'preflight', account });

    // ── 增量的下界，**在身份确认之后**才挑。
    //
    // 顺序是必须的：判据是数字用户 ID（档案的归属主键），而它只有 preflight 之后
    // 才知道。用用户名代替不行——用户名会改，而且「别人的档案不能当我的基准」这条
    // 判错的方向是**漏抓**，漏掉的东西事后无从发现。
    //
    // 挑的动作由调用方注入（它要读 OPFS，那不是 runner 的事），这里只定顺序。
    if (resolveFloors && !floors) {
      try {
        const inc = (await resolveFloors(account)) ?? {};
        floors = inc.floors;
        floorSources = inc.floorSources;
        previousBundleId = inc.previousBundleId ?? previousBundleId;
        knownSubjectUrlKeys = knownSubjectUrlKeys ?? inc.knownSubjectUrlKeys;
      } catch (err) {
        // 挑不出来就全量。**少抓不可接受，多抓只是慢。**
        this._emit({ type: 'incremental_failed', message: String(err?.message ?? err) });
      }
    }
    if (floors?.size) {
      this._emit({
        type: 'incremental',
        routes: [...floors.keys()],
        floors: Object.fromEntries(floors),
      });
    }

    const bundleId = newBundleId(this._now());
    const dir = bundleDirName(bundleId);
    const store = await this._openBundle(dir);

    const writer = new BundleWriter({
      store,
      bundleId,
      previousBundleId,
      account: {
        user_id: account.userId,
        username: account.username ?? username,
        profile_url: profileUrl,
      },
      producer: {
        name: 'doubak-extension',
        version: '0.0.1',
        user_agent: globalThis.navigator?.userAgent,
      },
      now: this._now,
    });

    let routeDefs = buildRoutes({ username, mediums, includeCatalog });
    if (onlyRoutes?.length) {
      const want = new Set(onlyRoutes);
      routeDefs = routeDefs.filter((r) => want.has(r.key));
      if (routeDefs.length === 0) throw new Error(`onlyRoutes 里没有一条已知路线：${onlyRoutes}`);
    }
    const routes = new Map(routeDefs.map((r) => [r.key, r]));

    const frontier = new Frontier();
    // **链上已经抓过的作品详情页不再抓一遍。**
    //
    // 那条路线占真实档案九成体积，而它的内容不像列表那样有时间序——「增量」这个
    // 概念对它不成立（规范 §5.5.5）。所以增量的做法是：**只抓这次列表里新出现的
    // 作品**，已经有的跳过。
    //
    // 只喂作品详情页的 url_key，**不能把列表页也喂进来**：列表页的 URL 每次都一样
    // （`collect?start=0`），喂进去会让这次一页都抓不成。
    //
    // 要重新抓一遍（比如想看评分变化）是**用户的决定**：界面上有单独的选项，
    // 那时不传这个集合。与 `acceptLeafGaps` 是同一个模式。
    if (knownSubjectUrlKeys?.length) {
      frontier.markCaptured(knownSubjectUrlKeys);
      this._emit({ type: 'subjects_skipped', count: knownSubjectUrlKeys.length });
    }
    seedFrontier(frontier, routeDefs);

    const loop = new CrawlLoop({
      frontier, transport, writer, session, pacer, routes,
      floors: floors ?? new Map(),
      floorSources: floorSources ?? new Map(),
      onEvent: this._emit,
      bypassGates,
    });

    this._run = {
      bundleId, dir, store, writer, frontier, loop, pacer, routes, session,
      maxCaptures, capturedSoFar: 0,
    };

    // 指针先落盘，再写崩溃哨兵——顺序反了的话，哨兵会无处可写。
    //
    // 指针里带上 username：恢复时要靠它重建路线表，而 checkpoint 里没有
    // 这个信息（那里只放推导不出来的抓取状态）。少了它，崩溃之后就恢复不了。
    //
    // **这两步失败必须把 `_run` 退回去。** 否则 `active` 一直是 true，此后每次
    // 「开始抓取」都被自己挡掉，报的是「已有抓取在进行中」——而真实原因是上一次
    // 根本没开成。用户面对的是一个既没在抓、又开不了新的死局，除了重装扩展没有
    // 出路。（这个坑真的踩过。）
    try {
      await this._runStore.setCurrentRun({
        bundleId, dir, username, mediums, includeCatalog, bypassGates,
        // 小范围试跑的上限也要跟着走。少了它，一次「最多抓 10 条」的调试跑在
        // 心跳恢复之后会变成一场全量抓取——而用户点的是「试一下」。
        maxCaptures,
      });
      await this._saveCheckpoint(CRASH_SENTINEL_REASON);
    } catch (err) {
      this._run = null;
      throw err;
    }

    this._emit({ type: 'started', bundleId, routes: routeDefs.length });
    return { bundleId, dir, account };
  }

  /**
   * 从 checkpoint 恢复一次未完成的抓取。
   *
   * @param {object} cp  checkpoint 内容
   * @param {object} [opts]
   * @param {string} [opts.username] 不给则用指针里记下的
   */
  async resume(cp, { username: overrideUser } = {}) {
    // **已经在内存里、只是停着** —— 这是「用户点了暂停又点继续」的情形。
    //
    // 早先这里直接抛（或被调用方以 `if (active) return` 跳过），于是「继续」什么也
    // 没做：frontier 还停着，下一批立刻返回 `stoppedBy: 'user_paused'`，上层看到停机
    // 原因又弹一次「需要你处理」。用户点继续，得到的是同一条通知。
    //
    // `active` 是「这次抓取还在内存里」，不是「正在发请求」——同一个混淆在界面上也
    // 咬过一次（docs/ui.md §4.4）。
    if (this._run) {
      const { wasStopped, resumed } = this._run.frontier.clearStop();
      if (!wasStopped) return { bundleId: this._run.bundleId, alreadyRunning: true };
      await this._saveCheckpoint(CRASH_SENTINEL_REASON);
      this._emit({ type: 'resumed', bundleId: this._run.bundleId, requeued: resumed });
      return { bundleId: this._run.bundleId, requeued: resumed };
    }

    const pointer = await this._runStore.getCurrentRun();
    if (!pointer?.dir) throw new Error('没有可恢复的抓取');

    const username = overrideUser ?? pointer.username;
    if (!username) throw new Error('指针里没有 username，无法重建路线表');

    const store = await this._openBundle(pointer.dir);
    const { recoverBundle } = await import('../bundle/recovery.js');

    // 先把磁盘修回自洽：崩溃可能留下撕裂的段尾或半行 index。
    const repair = await recoverBundle({ store, bundleId: pointer.bundleId });
    if (repair.repairs.length) this._emit({ type: 'repaired', repairs: repair.repairs });

    // 降速必须跟着恢复——不能因为崩了一次就回到原速。
    const pacer = this._gate.setPacer(Pacer.restore(cp.rate_state, this._pacerOptions)).pacer;
    const gate = this._gate;
    const transport = new Transport({ gate, fetchImpl: this._fetchImpl, getCk: this._getCk });

    const session = new SessionGuard();
    const profileUrl = `https://www.douban.com/people/${encodeURIComponent(username)}/`;
    const probe = await transport.fetch(profileUrl);
    session.preflight(probe.bodyText);

    const writer = new BundleWriter({
      store,
      bundleId: pointer.bundleId,
      account: { user_id: session.account.userId, username: session.account.username ?? username },
      startSeq: repair.lastSeq,
      resume: repair.resume,
      // **不传这个，被恢复过的抓取就永远收不了尾**：段的 record_count 从磁盘恢复了，
      // 而 index 的计数器从零开始，`finalize()` 的交叉核对必然失败。而一场几小时的
      // 抓取必然跨越很多次 worker 死亡，也就是说正常的完整抓取一次都收不了尾。
      indexStats: repair.indexStats,
      now: this._now,
    });

    // 路线表必须按**原来那次**的范围重建，否则恢复后会多抓或少抓路线。
    const routeDefs = buildRoutes({
      username,
      mediums: pointer.mediums,
      includeCatalog: pointer.includeCatalog ?? true,
    });
    const routes = new Map(routeDefs.map((r) => [r.key, r]));

    // 队列从 checkpoint 里的未完成条目重建；已完成的不在里面——那是 index
    // 的职责，重复记录会带来两个可能不一致的真相来源。
    const frontier = new Frontier();
    // **先给去重集合打底，再放条目回去。** 顺序要紧：打底用的是 index 里已经抓成功
    // 的 url_key，而 checkpoint 里的条目是**没抓成**的，两者不该互相覆盖。
    frontier.markCaptured(repair.capturedUrlKeys ?? []);
    for (const it of cp.frontier ?? []) {
      const def = routes.get(it.route_key);
      frontier.enqueue({
        url: it.url,
        // **要归一化。** 抓取循环入队时用的是 `urlKey(url)`，而 index 里存的也是
        // 归一化后的 `url_key`——恢复时直接拿原始 URL 当键，去重就跨不过这条边界。
        urlKey: urlKey(it.url),
        routeKey: it.route_key,
        intent: it.intent,
        enqueuedBy: it.enqueued_by ?? null,
        ordered: def ? (def.ordered ?? Boolean(def.pagination)) : true,
        priority: def?.priority ?? 50,
        gatedBy: it.gated_by ?? null,
        // **原样还原状态与已用次数。**
        //
        // 早先这里一律按「新条目」重建（pending、attempts 归零），于是 checkpoint 里
        // 写下的 `failed` 被静默丢弃——持久化了却不读，等于每次恢复都偷偷给一次新的
        // 重试预算。而恢复在崩溃路径上每 30 秒就可能发生一次：一个反复失败的页面会被
        // 无限地撞下去，如果那面墙是风控，代价是账号。
        //
        // 现在失败就是失败，重试**只能由人触发**（面板上的按钮 → `retryFailed()`）。
        // 那也让失败真的能被看见，而不是在下一次恢复里被抹掉。
        state: it.state === 'in_flight' ? 'pending' : (it.state ?? 'pending'),
        attempts: it.attempts ?? 0,
        // 游标：少了它，下一页会从第 1 页重新算（见 buildCheckpoint 里的说明）。
        // 旧 checkpoint 没记这个字段，所以要能从 URL 反推——不然一份升级前写下的
        // 半成品档案一恢复就从头重抓。
        cursor: it.cursor ?? cursorFromUrl(it.url, def),
      });
    }
    // 每条路线按 checkpoint 里的游标续上
    for (const r of cp.routes ?? []) {
      const def = routes.get(r.route_key);
      if (!def?.entryUrl || !r.cursor) continue;
      const url = def.entryUrl({ offset: r.cursor.value });
      frontier.enqueue({
        url, urlKey: urlKey(url), routeKey: r.route_key, intent: def.intent, cursor: r.cursor,
        ordered: def.ordered ?? Boolean(def.pagination),
        priority: def.priority ?? 50,
      });
    }

    const loop = new CrawlLoop({
      frontier, transport, writer, session, pacer, routes,
      onEvent: this._emit,
      bypassGates: Boolean(pointer.bypassGates),
      // 界面上的「已抓」要接着数，不能每次恢复都归零。数字来自 index——
      // 内存里的计数随 service worker 一起清零，index 不会。
      priorCounts: repair.capturedByRoute,
      // **连续性证明要接回来。** 不接的话，收尾时每条路线都会被记成「aborted」——
      // 而它可能一次都没被打断过。规范 §7.1。
      savedStates: Object.fromEntries((cp.routes ?? []).map((r) => [r.route_key, r])),
    });

    this._run = {
      bundleId: pointer.bundleId, dir: pointer.dir, store, writer, frontier, loop, pacer, routes, session,
      // **这两个字段少了会让抓取全速空转。**
      //
      // 少写 `maxCaptures` 的话它是 `undefined`，而下面那句判的是 `=== null`：
      // `Math.max(0, undefined - undefined)` → NaN → `maxItems` NaN →
      // `while (0 < NaN)` 直接为假 → 一个请求都不发；而 `hitCap` 也是假
      // （`NaN >= undefined`），于是 `done` 为假，驱动循环以每秒几十次的速度
      // 空转下去。日志里的样子：几百条 `batch`，一条 `capture` 都没有。
      //
      // 安全阀是**按会话**算的：`capturedSoFar` 没有持久化，所以恢复之后重新计数。
      // 对一个「调试用的兜底上限」来说这是可以接受的，但不能不写——见上。
      maxCaptures: pointer.maxCaptures ?? null,
      capturedSoFar: 0,
    };
    this._emit({ type: 'resumed', bundleId: pointer.bundleId, lastSeq: repair.lastSeq });
    return { bundleId: pointer.bundleId };
  }

  /**
   * 推进一批。
   *
   * @returns {Promise<{done: boolean, captured: number, failed: number, stoppedBy: string | null}>}
   */
  async runBatch() {
    if (!this._run) throw new Error('没有进行中的抓取');
    const { loop, frontier } = this._run;

    // 安全阀：剩余额度小于一批时，只跑剩下那么多。
    //
    // `Number.isFinite` 而不是 `=== null`：**一个 undefined 就能让整场抓取空转**。
    // `Math.max(0, undefined - undefined)` 是 NaN，`while (0 < NaN)` 直接为假，
    // 于是一批里一个请求都不发；而 NaN 又通不过 `hitCap` 的比较，`done` 保持为假，
    // 驱动循环便以每秒几十次的速度空转。这条在 `resume()` 漏写字段时真的发生过。
    const cap = this._run.maxCaptures;
    const remaining = Number.isFinite(cap)
      ? Math.max(0, cap - (this._run.capturedSoFar ?? 0))
      : Infinity;
    const r = await loop.run({ maxItems: Math.min(this._batchSize, remaining) });
    this._run.capturedSoFar += r.captured + r.failed;

    // 每批之后落一次 checkpoint。worker 被杀最多丢掉这一批的游标，而捕获
    // 本身早就落盘了，恢复时按 index 重建即可。
    const stopped = frontier.stopped;
    await this._saveCheckpoint(stopped ? frontier.stopReason : CRASH_SENTINEL_REASON);

    const hitCap = Number.isFinite(cap) && this._run.capturedSoFar >= cap;
    // 用 hasReady() 而不是 next()：后者会把条目标成 in_flight，拿它当判断用
    // 会白白消耗一个条目并让它永远卡住，进而堵死整条路线。
    const done = stopped || hitCap || !frontier.hasReady();

    // 被安全阀截断 ≠ 干净完成。如实说出来，否则用户会以为「跑完了」。
    this._emit({ type: 'batch', ...r, done, truncated: hitCap });
    return { ...r, done, truncated: hitCap };
  }

  /**
   * 收尾：写完整性证据与 manifest，清掉 checkpoint。
   *
   * @param {'complete' | 'aborted'} [status]
   */
  /**
   * 收尾。
   *
   * @param {'complete' | 'aborted'} [status]
   * @param {object} [opts]
   * @param {boolean} [opts.acceptLeafGaps]  用户看过之后决定「叶子条目就这样，收尾」。
   *   **只放开叶子失败**——有序路线上的失败会破坏「这条线以上全部已抓」这个前提，
   *   而水位线正建立在那上面，不是用户点一下就能免掉的。
   */
  async finish(status = 'complete', { acceptLeafGaps = false } = {}) {
    if (!this._run) throw new Error('没有进行中的抓取');
    const { loop, writer, frontier } = this._run;

    // **有未解决的失败就不许标 complete。**
    //
    // 失败不调用 `frontier.stop()`，所以 `stoppedBy` 是 null，于是「没有可跑的了」
    // 曾被上层当成干净跑完——档案被静默标成 complete，而 manifest 里一点痕迹都没有。
    // 那是这个项目最不能出的错：假的完整性声明。
    //
    // 规范允许「带着缺口 complete」（bundle/v1 §5.0），但那是**用户的决定**，不是
    // 代码的默认。所以要一个显式的 acceptLeafGaps。
    if (status === 'complete') {
      const ordered = frontier.failedItems({ orderedOnly: true });
      if (ordered.length > 0) {
        throw new Error(
          `有 ${ordered.length} 个分页条目抓不下来，不能标成「已完成」——跳过它们就` +
            '再也不能声称「这条线以上全都抓到了」，而水位线正建立在那句话上。' +
            `请先重试（第一个：${ordered[0].url}），或者把这次抓取标成中止。`,
        );
      }
      const leaves = frontier.failedItems();
      if (leaves.length > 0 && !acceptLeafGaps) {
        throw new Error(
          `有 ${leaves.length} 个条目抓不下来。可以重试，也可以确认「就这样收尾」——` +
            '后者会把每一处缺口如实写进 manifest（第一个：' +
            `${leaves[0].url}）。`,
        );
      }
    }

    // 必须先攒证据再 finalize——否则 manifest 里 coverage 与 crawl_state 都是空的，
    // 等于没有任何完整性依据。
    loop.flushRouteEvidence();
    const manifest = await writer.finalize({ status });

    if (status === 'complete') await this._runStore.clearCheckpoint();
    const bundleId = this._run.bundleId;
    this._run = null;

    this._emit({ type: 'finished', bundleId, status });
    return manifest;
  }

  /**
   * 把失败条目放回队列。**只能由人触发。**
   *
   * 自动重试一个反复失败的页面，在最坏情况下是每次心跳都去撞同一面墙——而如果那面墙
   * 是风控，代价是账号。所以这里没有任何自动调用者。
   *
   * @param {object} [opts]
   * @param {string} [opts.routeKey]
   * @returns {Promise<number>} 放回了几条
   */
  async retryFailed({ routeKey } = {}) {
    if (!this._run) throw new Error('没有进行中的抓取');
    const n = this._run.frontier.retryFailed({ routeKey });
    if (n > 0) await this._saveCheckpoint(CRASH_SENTINEL_REASON);
    this._emit({ type: 'retry_requested', count: n, routeKey: routeKey ?? null });
    return n;
  }

  /** 用户主动暂停。 */
  /**
   * 停下来，并把**真实原因**写进档案。
   *
   * 原因必须传进来而不是一律写 `user_paused`：权限被撤、账号被换也走这条路，
   * 而恢复策略对它们的处理完全不同（`user_paused` 等用户点继续，
   * `host_permission_lost` 要用户先去改设置）。写错原因等于把恢复决策带偏。
   *
   * @param {string} [reason]
   */
  async pause(reason = 'user_paused') {
    if (!this._run) return;

    // **先停 frontier，再落盘。** 顺序是刻意的：停 frontier 是纯内存操作，一定
    // 成功；落盘可能失败（配额、句柄冲突）。反过来的话，一次写失败会让「暂停」
    // 整个失败——而用户按暂停往往正是因为出了问题，此时最不该做的就是拒绝停下。
    this._run.frontier.stop(reason);

    try {
      await this._saveCheckpoint(reason);
    } catch (err) {
      // 落盘失败要说出来，但**不改变「已经停下了」这个事实**。下次唤醒会退回到
      // 崩溃哨兵那条路，那是保守且安全的。
      this._emit({
        type: 'paused',
        reason,
        checkpointSaved: false,
        message: `已停下，但 checkpoint 没写成：${err?.message ?? err}`,
      });
      return;
    }

    this._emit({ type: 'paused', reason, checkpointSaved: true });
  }

  /** 当前进度快照，供界面读取。 */
  status() {
    if (!this._run) return { active: false };
    const { bundleId, frontier, pacer, loop } = this._run;
    return {
      // `active` 意思是「这次抓取还在内存里，可以继续」——**不是**「正在发请求」。
      // 两者混为一谈的后果是：暂停之后界面依旧显示「正在抓取」，用户以为暂停按钮
      // 没生效，然后反复去点。所以另外报 `stopped` 与 `stoppedBy`。
      active: true,
      stopped: frontier.stopped,
      stoppedBy: frontier.stopped ? frontier.stopReason : null,
      // **正在抓哪一页。** 只显示「档案 xxx · 间隔 1 秒」的话，界面在几小时里几乎
      // 一动不动——看不出它到底在动还是卡住了。
      //
      // 两批之间没有 in_flight 条目，那时候退回「刚抓完的那一页」。少了这个退路，
      // 这一行会时有时无地闪——而「进度区每几秒闪一下」正是被报过来的老问题。
      // `currentActive` 让界面说对话：「正在抓」和「刚抓完」不是一回事。
      current: frontier.snapshot().find((it) => it.state === 'in_flight')?.url ?? loop.lastUrl ?? null,
      currentActive: frontier.snapshot().some((it) => it.state === 'in_flight'),
      // 抓不下来的条目。界面要能列出来，并区分「只能重试」与「可以就这样收尾」。
      failures: frontier.failedItems().map((it) => ({
        url: it.url,
        routeKey: it.routeKey,
        attempts: it.attempts,
        ordered: it.ordered,
        lastError: it.lastError ?? null,
      })),
      bundleId,
      counts: frontier.counts(),
      intervalMs: pacer.intervalMs,
      backoffLevel: pacer.level,
      routes: [...loop.routeStates.values()].map((s) => ({
        routeKey: s.routeKey,
        captured: s.capturedCount,
        // 界面上显示「已回溯到 X」而不是百分比——豆瓣的计数不可信，拿它当分母
        // 会给出一个看起来很可信的假数字。
        //
        // **进度是 `lowWater`（本次最旧的一条），不是 `highWater`。** 列表是
        // 新→旧，`highWater` 在第一页就定住了，拿它当进度会一动不动——看起来
        // 像卡住了。两个都报出去，名字直说各自是什么。
        oldestSeen: s.lowWater?.iso ?? null,
        newestSeen: s.highWater?.iso ?? null,
        // **界面上的「已回溯到」用这个，不用 `oldestSeen`。**
        //
        // 后者是全局最小值，一条离群的旧条目就能把它永久钉死——真实数据里第 10 页
        // 混着一条 2018 年的广播，从那一页起「已回溯到」再也不动，而抓取还有一大半
        // 没跑完。`progressTime` 取每页的中位数再累计取最小，离群值动不了它。
        // 见 `RouteState._advanceProgress()`。
        progressTime: s.progressTime?.iso ?? null,
        contiguous: s.contiguous,
      })),
    };
  }

  /** @param {string} reason */
  async _saveCheckpoint(reason) {
    const { bundleId, frontier, pacer, loop } = this._run;
    // **整个 RouteState 传下去，不要在这里挑字段。**
    //
    // 原来这里挑成 `{cursor, stall}`——够续上翻页，不够重建连续性证明。于是恢复
    // 之后每条路线都是崭新的：没有水位线、没走完、没被打断，收尾时被**全部**记成
    // 「aborted」。真实档案里 21 条路线全是这样，而它一次都没被打断过。
    // 顺带 `advanced` 永远是 false，增量抓取永远不可能。规范 §7.1。
    const routes = new Map(loop.routeStates);
    await this._runStore.saveCheckpoint(
      buildCheckpoint({ bundleId, frontier, pacer, routes, pauseReason: reason }),
    );
  }
}

/**
 * 从 URL 反推游标。
 *
 * 恢复时的兜底：checkpoint 里没记 `cursor` 的条目（升级前写下的那些）如果就这样
 * 放回队列，`_enqueueNextPage` 会按 `route.pagination.first` 从第一页重新数——
 * 于是抓完 `p=20` 之后去抓 `p=2`。真实日志里就是这样，而且后果比「多抓几页」严重：
 * 重抓的那些页全是重复条目，**停滞检测会把它当成「这条线走完了」**，于是广播只抓到
 * 第 20 页就被标成完成，然后去抓标记列表了。那是一次假的完整性声明。
 *
 * 反推是可靠的：URL 就是 `entryUrl({offset})` 生成的，参数名固定。
 *
 * @param {string} url
 * @param {object} [def]  路线定义
 * @returns {{kind: string, value: number} | null}
 */
export function cursorFromUrl(url, def) {
  const pg = def?.pagination;
  if (!pg) return null;
  let raw = null;
  try {
    const u = new URL(url);
    raw = u.searchParams.get(pg.kind === 'page' ? 'p' : 'start');
  } catch {
    return null;
  }
  if (raw === null) {
    // 入口页可能压根不带参数（第一页）。那就是起点。
    return { kind: pg.kind, value: pg.first };
  }
  const value = Number(raw);
  return Number.isFinite(value) ? { kind: pg.kind, value } : null;
}

/**
 * 按优先级把各路线的入口页放进队列。
 *
 * 前置依赖未满足的路线**不入队**——比如作品详情页要等广播抓完。不能拿最不可
 * 替代的东西去换最可替代的。
 *
 * @param {Frontier} frontier
 * @param {Array<object>} routeDefs
 */
export function seedFrontier(frontier, routeDefs) {
  let seeded = 0;
  for (const def of routeDefs) {
    if (def.requires?.length) continue; // 有前置依赖的等它满足了再说
    if (!def.entryUrl) continue;
    const url = def.entryUrl({ offset: def.pagination?.first ?? 0 });
    if (
      frontier.enqueue({
        url,
        // 与抓取循环、与 index 里的 `url_key` 用同一套归一化——三处必须一致，
        // 否则去重跨不过「种子 / 翻页 / 恢复」这三条边界。
        urlKey: urlKey(url),
        routeKey: def.key,
        intent: def.intent,
        cursor: def.pagination ? { kind: def.pagination.kind, value: def.pagination.first } : null,
        // 有分页就是有序：跳过抓不下来的第 7 页去抓第 8 页，就再也不能声称
        // 「第 7 页以上全都抓到了」，而水位线正建立在那句话上。
        // 没有分页的（作品详情页）是一个集合，条目之间互不相干。
        //
        // 路线可以显式覆盖——`interest.item` 就必须（它曾经带着一个错误的 pagination）。
        ordered: def.ordered ?? Boolean(def.pagination),
        priority: def.priority ?? 50,
      })
    ) {
      seeded += 1;
    }
  }
  return seeded;
}
