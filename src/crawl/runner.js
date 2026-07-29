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
import { SessionGuard } from './session.js';
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
   * `https://www.douban.com/mine/` 会跳转到 `/people/<username>/`，
   * 而传输层本来就跟随跳转并记下最终 URL。
   *
   * @returns {Promise<{username: string, finalUrl: string}>}
   */
  async discoverUsername() {
    const pacer = new Pacer(this._pacerOptions);
    const gate = new RequestGate({ pacer });
    const transport = new Transport({ gate, fetchImpl: this._fetchImpl });

    const res = await transport.fetch('https://www.douban.com/mine/');
    const m = /\/people\/([A-Za-z0-9_-]+)\/?/.exec(res.finalUrl);
    if (!m || m[1] === 'mine') {
      // 跳转没落到个人主页上——最可能的原因是没登录。
      throw new Error(
        '无法确定当前账号。请先在浏览器里登录豆瓣——未登录不仅看不到私密条目，' +
          '请求频率上限也更低。',
      );
    }
    return { username: m[1], finalUrl: res.finalUrl };
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
   */
  async start({ username, mediums, includeCatalog = true, floors, previousBundleId = null }) {
    if (this._run) throw new Error('已有抓取在进行中');

    const pacer = new Pacer(this._pacerOptions);
    const gate = new RequestGate({ pacer });
    const transport = new Transport({ gate, fetchImpl: this._fetchImpl, getCk: this._getCk });

    // ── 开工前的身份确认。取不到数字 ID 就不能开始。
    const session = new SessionGuard();
    const profileUrl = `https://www.douban.com/people/${encodeURIComponent(username)}/`;
    const probe = await transport.fetch(profileUrl);
    const account = session.preflight(probe.bodyText);
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

    const routeDefs = buildRoutes({ username, mediums, includeCatalog });
    const routes = new Map(routeDefs.map((r) => [r.key, r]));

    const frontier = new Frontier();
    seedFrontier(frontier, routeDefs);

    const loop = new CrawlLoop({
      frontier, transport, writer, session, pacer, routes,
      floors: floors ?? new Map(),
      onEvent: this._emit,
    });

    this._run = { bundleId, dir, store, writer, frontier, loop, pacer, routes, session };

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

    const r = await loop.run({ maxItems: this._batchSize });

    // 每批之后落一次 checkpoint。worker 被杀最多丢掉这一批的游标，而捕获
    // 本身早就落盘了，恢复时按 index 重建即可。
    const stopped = frontier.stopped;
    await this._saveCheckpoint(stopped ? frontier.stopReason : CRASH_SENTINEL_REASON);

    // 用 hasReady() 而不是 next()：后者会把条目标成 in_flight，拿它当判断用
    // 会白白消耗一个条目并让它永远卡住，进而堵死整条路线。
    const done = stopped || !frontier.hasReady();
    this._emit({ type: 'batch', ...r, done });
    return { ...r, done };
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
