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
    const pacer = new Pacer(this._pacerOptions);
    const gate = new RequestGate({ pacer });
    const transport = new Transport({ gate, fetchImpl: this._fetchImpl });

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
   * @param {string | null} [opts.previousBundleId]
   * @param {string[]} [opts.onlyRoutes]  只抓这几条路线。用于小范围试跑——
   *   挑一条**天然很小**的路线（比如舞台剧只有一两条），就能完整走完整个
   *   生命周期，包括干净终止与水位线推进。
   * @param {number} [opts.maxCaptures]  硬上限。这是**安全阀不是终止条件**：
   *   被它截断的抓取不算干净完成，水位线不会推进，产出的是不完整的档案。
   */
  async start({
    username, mediums, includeCatalog = true, floors, previousBundleId = null,
    onlyRoutes = null, maxCaptures = null,
  }) {
    if (this._run) throw new Error('已有抓取在进行中');

    const pacer = new Pacer(this._pacerOptions);
    const gate = new RequestGate({ pacer });
    const transport = new Transport({ gate, fetchImpl: this._fetchImpl, getCk: this._getCk });

    // ── 开工前的身份确认。取不到数字 ID 就不能开始。
    const session = new SessionGuard();
    const profileUrl = `https://www.douban.com/people/${encodeURIComponent(username)}/`;
    const probe = await transport.fetch(profileUrl);

    // 个人主页上不一定有数字 uid（它最常见的落脚处是广播条目的 `data-uid`，而
    // 主页上可能压根没有广播条目）。所以留一条退路：去广播列表页再取一次。
    //
    // 那一页**一定**有——真实旧档案里 7353 个广播列表页全都带 `data-uid`。
    // 代价是多一个请求，只在必要时发；而取不到 uid 就完全开不了工。
    let account;
    try {
      account = session.preflight(probe.bodyText);
    } catch (err) {
      if (err.reason !== 'missing_user_id') throw err;
      this._emit({ type: 'uid_fallback', from: profileUrl });
      const alt = await transport.fetch(`${profileUrl}statuses`);
      // 用主页判登录态、用广播页补 uid：两张页面拼一份身份。**不放松要求**——
      // 补不到照样抛，只是错误信息里会说两处都试过了。
      account = session.preflight(alt.bodyText, { fallbackFrom: err.message });
    }
    this._emit({ type: 'preflight', account });

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
    seedFrontier(frontier, routeDefs);

    const loop = new CrawlLoop({
      frontier, transport, writer, session, pacer, routes,
      floors: floors ?? new Map(),
      onEvent: this._emit,
    });

    this._run = {
      bundleId, dir, store, writer, frontier, loop, pacer, routes, session,
      maxCaptures, capturedSoFar: 0,
    };

    // 指针先落盘，再写崩溃哨兵——顺序反了的话，哨兵会无处可写。
    //
    // 指针里带上 username：恢复时要靠它重建路线表，而 checkpoint 里没有
    // 这个信息（那里只放推导不出来的抓取状态）。少了它，崩溃之后就恢复不了。
    await this._runStore.setCurrentRun({ bundleId, dir, username, mediums, includeCatalog });
    await this._saveCheckpoint(CRASH_SENTINEL_REASON);

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
    if (this._run) throw new Error('已有抓取在进行中');

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
    const pacer = Pacer.restore(cp.rate_state, this._pacerOptions);
    const gate = new RequestGate({ pacer });
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
    for (const it of cp.frontier ?? []) {
      frontier.enqueue({
        url: it.url,
        urlKey: it.url,
        routeKey: it.route_key,
        intent: it.intent,
        enqueuedBy: it.enqueued_by ?? null,
      });
    }
    // 每条路线按 checkpoint 里的游标续上
    for (const r of cp.routes ?? []) {
      const def = routes.get(r.route_key);
      if (!def?.entryUrl || !r.cursor) continue;
      const url = def.entryUrl({ offset: r.cursor.value });
      frontier.enqueue({
        url, urlKey: url, routeKey: r.route_key, intent: def.intent, cursor: r.cursor,
      });
    }

    const loop = new CrawlLoop({
      frontier, transport, writer, session, pacer, routes,
      onEvent: this._emit,
    });

    this._run = {
      bundleId: pointer.bundleId, dir: pointer.dir, store, writer, frontier, loop, pacer, routes, session,
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
    const remaining =
      this._run.maxCaptures === null
        ? Infinity
        : Math.max(0, this._run.maxCaptures - this._run.capturedSoFar);
    const r = await loop.run({ maxItems: Math.min(this._batchSize, remaining) });
    this._run.capturedSoFar += r.captured + r.failed;

    // 每批之后落一次 checkpoint。worker 被杀最多丢掉这一批的游标，而捕获
    // 本身早就落盘了，恢复时按 index 重建即可。
    const stopped = frontier.stopped;
    await this._saveCheckpoint(stopped ? frontier.stopReason : CRASH_SENTINEL_REASON);

    const hitCap =
      this._run.maxCaptures !== null && this._run.capturedSoFar >= this._run.maxCaptures;
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
  async finish(status = 'complete') {
    if (!this._run) throw new Error('没有进行中的抓取');
    const { loop, writer } = this._run;

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

  /** 用户主动暂停。 */
  async pause() {
    if (!this._run) return;
    this._run.frontier.stop('user_paused');
    await this._saveCheckpoint('user_paused');
    this._emit({ type: 'paused' });
  }

  /** 当前进度快照，供界面读取。 */
  status() {
    if (!this._run) return { active: false };
    const { bundleId, frontier, pacer, loop } = this._run;
    return {
      active: true,
      bundleId,
      counts: frontier.counts(),
      intervalMs: pacer.intervalMs,
      backoffLevel: pacer.level,
      routes: [...loop.routeStates.values()].map((s) => ({
        routeKey: s.routeKey,
        captured: s.capturedCount,
        // 界面上显示「已回溯到 X」而不是百分比——豆瓣的计数不可信，
        // 拿它当分母会给出一个看起来很可信的假数字。
        highWater: s.highWater?.iso ?? null,
        contiguous: s.contiguous,
      })),
    };
  }

  /** @param {string} reason */
  async _saveCheckpoint(reason) {
    const { bundleId, frontier, pacer, loop } = this._run;
    const routes = new Map(
      [...loop.routeStates.entries()].map(([k, s]) => [k, { cursor: s.cursor, stall: s.stall }]),
    );
    await this._runStore.saveCheckpoint(
      buildCheckpoint({ bundleId, frontier, pacer, routes, pauseReason: reason }),
    );
  }
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
        urlKey: url,
        routeKey: def.key,
        intent: def.intent,
        cursor: def.pagination ? { kind: def.pagination.kind, value: def.pagination.first } : null,
      })
    ) {
      seeded += 1;
    }
  }
  return seeded;
}
