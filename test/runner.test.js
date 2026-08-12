import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CrawlRunner, seedFrontier, DEFAULT_BATCH_SIZE } from '../src/crawl/runner.js';
import { RunStore } from '../src/crawl/run-store.js';
import { MemoryKvStore } from '../src/storage/kv-store.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { Frontier } from '../src/crawl/frontier.js';
import { urlKey } from '../src/core/urlkey.js';
import { CRASH_SENTINEL_REASON } from '../src/crawl/resume-policy.js';
import { summarizeBundles } from '../src/storage/storage-usage.js';
import { buildRoutes, PRIORITY } from '../src/crawl/routes.js';
import { indexFilename } from '../src/core/ids.js';
import { TEST_PRODUCER_VERSION } from './helpers/producer.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// `_GLOBAL_NAV.USER_ID` 是数字 uid 的唯一来源——不是广播条目的 `data-uid`
// （那在作品详情页上是评论者的 ID）。见 src/crawl/session.js。
const NAV = `<li class="nav-user-account"><a href="/accounts/logout">退出</a>
<span>示例的账号</span></li><a href="https://www.douban.com/people/example/">主页</a>
<script>;window._GLOBAL_NAV = { USER_ID: "82160871" };</script>`;

/**
 * 个人主页：必须能取到数字用户 ID。
 *
 * `id="db-usr-profile"` 是「某人的个人页」这个外壳，真实页面上一定有（拿一份真实
 * 档案的 6 张页面量过，个人主页与 5 个分类入口全都有）。判定描述靠它区分真页面与
 * 封锁页——而豆瓣的封锁页返回的是 200，光看状态码是拦不住的。
 *
 * 注意它装的是头像与用户名，**不是**「我看过的影视」那种可增可减的模块：个人主页
 * 是用户可自定义的，判定绝不能依赖任何分类区块的存在。
 */
const PROFILE = `<html><head><title>示例的账号</title></head><body>${NAV}
<div id="db-usr-profile"><div class="info"><h1>示例</h1></div></div>
<div class="status-item" data-sid="1" data-uid="82160871">x</div></body></html>`;

/**
 * 空的日记列表页。
 *
 * 一条都没有的时候，页面框架照样在——这正是判定必须靠框架而不是条目数的理由。
 * 结构按 downloads/notes.html 那份真实页面写：`<h1>我的日记</h1>` **没有** `(N)`，
 * 声明数量整页都找不到。
 */
const NOTES_EMPTY = `<html><head><title>我的日记</title></head><body>${NAV}
<h1>我的日记</h1><div class="note-list"></div></body></html>`;

/**
 * 空的评论列表页。
 *
 * 与日记的关键差别：这一页**有**声明数量（`<h1>我的评论(0)</h1>`）。
 * 结构按 downloads/reviews.html 那份真实页面写。
 */
const REVIEWS_EMPTY = `<html><head><title>我的评论(0)</title></head><body>${NAV}
<h1>我的评论(0)</h1><div class="review-list chart "></div></body></html>`;

/** 长文那两条路线的空页，其余情况返回 null。 */
function longformEmpty(url) {
  if (url.includes('/notes?')) return NOTES_EMPTY;
  if (url.includes('/reviews?')) return REVIEWS_EMPTY;
  return null;
}

function bcPage(n, from = 0) {
  let items = '';
  for (let i = 0; i < n; i++) {
    items += `<div class="status-item" data-sid="${from + i}" data-uid="82160871">
      <span class="created_at" title="2026-07-2${i % 9} 1${i % 9}:00:00">x</span></div>`;
  }
  // 标题按 2026 实测写成「我的动态」；框架标志靠 db-usr-profile + stream-items。
  return `<html><head><title>\n我的动态\n</title></head><body>${NAV}
<div id="db-usr-profile"><div class="info"><h1>示例</h1></div></div>
<div class="stream-items">${items}</div></body></html>`;
}

const LOGIN = `<html><head><title>\n登录豆瓣\n</title></head><body>验证码</body></html>`;

/**
 * @param {(url: string, n: number) => string} respond  按 URL 与调用序号给页面
 */
function harness(respond, { batchSize = 5, pacerOptions } = {}) {
  const kv = new MemoryKvStore();
  /** @type {Map<string, MemoryFileStore>} */
  const dirs = new Map();
  const openBundle = async (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, new MemoryFileStore());
    return dirs.get(dir);
  };
  const runStore = new RunStore({ kv, openBundle });

  let n = 0;
  const calls = [];
  const events = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    // 应答器可以返回字符串，也可以返回 `{status, body}`——后者用于测非 200
    // 的情形（分类不存在、被下线）。
    const r = respond(url, n++);
    const status = typeof r === 'object' && r !== null ? (r.status ?? 200) : 200;
    const body = enc.encode(typeof r === 'object' && r !== null ? (r.body ?? '') : r);
    return {
      status,
      url,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };

  const runner = new CrawlRunner({ producerVersion: TEST_PRODUCER_VERSION,
    runStore, openBundle, fetchImpl, batchSize,
    now: () => new Date('2026-07-29T10:15:00Z'),
    // 测试里不要真的按 1 秒节奏等——真实抓取必须用默认值。
    // 要验节奏本身的测试可以覆盖它（那时候等待是被测对象，不是开销）。
    pacerOptions: pacerOptions ?? { intervalMs: 1, jitterRatio: 0 },
    onEvent: (e) => events.push(e),
  });
  return { runner, runStore, kv, dirs, calls, events, openBundle };
}

/**
 * 只抓广播的应答器。
 *
 * 按 URL 里的页码给页面，**不按调用序号**——preflight 与 profile 路线各会占
 * 掉一次调用，用序号索引会整体错位（这个坑踩过一次）。
 */
function broadcastOnly(pages) {
  return (url) => {
    if (url.endsWith('/people/example/')) return PROFILE;
    // 长文那两条路线的框架标志与广播页不一样，给广播页会被判成「框架不全」——
    // 那是判定在正确工作，不是它该测的东西。
    const lf = longformEmpty(url);
    if (lf) return lf;
    if (!url.includes('statuses')) return bcPage(0); // 其他路线直接给空页
    const m = /[?&]p=(\d+)/.exec(url);
    const page = m ? Number(m[1]) : 1;
    return pages[Math.min(page - 1, pages.length - 1)];
  };
}

describe('开工前必须确认身份', () => {
  test('取到数字用户 ID 才开始', async () => {
    // 数字 ID 是档案的归属主键，而它多数页面上取不到，必须专门抓个人主页。
    const { runner, events } = harness(broadcastOnly([bcPage(0)]));
    const r = await runner.start({ username: 'example', includeCatalog: false });

    assert.equal(r.account.userId, '82160871');
    assert.ok(events.some((e) => e.type === 'preflight'));
  });

  test('未登录就拒绝开始', async () => {
    const { runner } = harness(() => LOGIN);
    await assert.rejects(() => runner.start({ username: 'example' }), /登录|会话/);
  });

  test('身份确认失败时不会留下半个 bundle', async () => {
    const { runner, kv, dirs } = harness(() => LOGIN);
    await assert.rejects(() => runner.start({ username: 'example' }));
    assert.equal(await kv.get('doubak.currentRun'), undefined, '不该留下指针');
    assert.equal(dirs.size, 0, '不该建目录');
  });
});

describe('分批推进', () => {
  test('一批最多跑 batchSize 条', async () => {
    const pages = [bcPage(20, 0), bcPage(20, 20), bcPage(20, 40), bcPage(20, 60), bcPage(20, 80)];
    const { runner } = harness(broadcastOnly(pages), { batchSize: 3 });
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });

    const b = await runner.runBatch();
    assert.ok(b.captured + b.failed <= 3, `一批不该超过 3 条，实际 ${b.captured + b.failed}`);
  });

  test('每批之后都落一次 checkpoint', async () => {
    // worker 被杀最多丢掉这一批的游标，而捕获本身早就落盘了。
    const { runner, runStore } = harness(broadcastOnly([bcPage(20, 0), bcPage(0)]), { batchSize: 2 });
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.runBatch();

    const cp = await runStore.loadCheckpoint();
    assert.ok(cp, 'checkpoint 必须在');
    assert.ok(cp.rate_state, '降速状态要跟着走');
  });

  test('队列跑空时报 done', async () => {
    const { runner } = harness(broadcastOnly([bcPage(0)]), { batchSize: 50 });
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });

    let done = false;
    for (let i = 0; i < 10 && !done; i++) ({ done } = await runner.runBatch());
    assert.equal(done, true);
  });

  test('小范围试跑的上限跟着恢复走 —— 否则「试一下」会变成全量抓取', async () => {
    const { runner, runStore } = harness(
      broadcastOnly([bcPage(20, 0), bcPage(20, 20), bcPage(20, 40), bcPage(0)]), { batchSize: 2 },
    );
    await runner.start({
      username: 'example', mediums: [], includeCatalog: false, maxCaptures: 3,
    });
    const pointer = await runStore.getCurrentRun();
    assert.equal(pointer.maxCaptures, 3, '上限必须写进指针 —— 恢复时只有它读得到');

    const cp = await runStore.loadCheckpoint();
    runner._run = null;
    await runner.resume(cp);
    assert.equal(runner._run.maxCaptures, 3);
  });

  test('默认批大小是个有限值', () => {
    assert.ok(DEFAULT_BATCH_SIZE > 0 && DEFAULT_BATCH_SIZE <= 100);
  });
});

describe('崩溃哨兵', () => {
  test('开工就写下 crash 哨兵', async () => {
    // worker 被杀时没机会写任何东西，所以反过来：先假定会崩。
    const { runner, runStore } = harness(broadcastOnly([bcPage(0)]));
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });

    const cp = await runStore.loadCheckpoint();
    assert.equal(cp.pause_reason, 'crash');
  });

  test('用户暂停会改写哨兵', async () => {
    const { runner, runStore } = harness(broadcastOnly([bcPage(20, 0)]));
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.pause();

    assert.equal((await runStore.loadCheckpoint()).pause_reason, 'user_paused');
  });

  test('指针先落盘再写哨兵 —— 顺序反了哨兵会无处可写', async () => {
    const { runner, kv } = harness(broadcastOnly([bcPage(0)]));
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    assert.ok(await kv.get('doubak.currentRun'));
  });
});

describe('收尾', () => {
  test('finish 会先攒完整性证据再写 manifest', async () => {
    // 不先 flush 的话 manifest 里 coverage 与 crawl_state 都是空的，
    // 等于没有任何完整性依据。
    const { runner, dirs } = harness(
      broadcastOnly([bcPage(20, 0), bcPage(0), bcPage(0), bcPage(0)]),
      { batchSize: 50 },
    );
    const { dir } = await runner.start({ username: 'example', mediums: [], includeCatalog: false });

    let done = false;
    for (let i = 0; i < 10 && !done; i++) ({ done } = await runner.runBatch());
    const manifest = await runner.finish();

    assert.ok(manifest.crawl_state.length > 0, '必须有连续性证明');
    assert.ok(manifest.coverage.length > 0, '必须有覆盖率观测');
    assert.equal(manifest.status, 'complete');
    assert.ok(await dirs.get(dir).exists('manifest.json'));
  });

  test('干净结束后 checkpoint 被清掉', async () => {
    // 规范要求已完成的 bundle 不该再有 checkpoint——它的存在意味着没抓完。
    const { runner, runStore, dirs } = harness(broadcastOnly([bcPage(0)]), { batchSize: 50 });
    const { dir } = await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.runBatch();
    await runner.finish();

    assert.equal(await runStore.loadCheckpoint(), null);
    assert.equal(await dirs.get(dir).exists('checkpoint.json'), false);
  });

  test('aborted 收尾保留 checkpoint', async () => {
    const { runner, runStore } = harness(broadcastOnly([bcPage(20, 0)]), { batchSize: 1 });
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.runBatch();
    await runner.finish('aborted');

    assert.ok(await runStore.loadCheckpoint(), '没抓完的档案要留着 checkpoint 才能续');
  });
});

describe('进度快照供界面读取', () => {
  test('显示已回溯到的时间，而不是百分比', async () => {
    // 豆瓣的计数不可信，拿它当分母会给出一个看起来很可信的假数字。
    const { runner } = harness(broadcastOnly([bcPage(20, 0), bcPage(0)]), { batchSize: 50 });
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.runBatch();

    const s = runner.status();
    assert.equal(s.active, true);
    const bc = s.routes.find((r) => r.routeKey === 'broadcast.timeline');
    // 「已回溯到」用的是 `oldestSeen`（本次最旧的一条）。水位线（最新那条）在第
    // 一页就定住了，拿它当进度会一动不动——那正是被当成 bug 报过来的现象。
    assert.ok(bc.oldestSeen, '要有「已回溯到」这个信息');
    assert.match(bc.oldestSeen, /\+08:00$/);
    assert.ok(bc.newestSeen, '水位线也要报出来（下次抓取的下界）');
    assert.ok(bc.oldestSeen <= bc.newestSeen, '最旧不该晚于最新');
    assert.ok(!('percent' in bc), '不提供百分比');
  });

  test('报出正在抓的那一页 —— 界面上除此之外几小时不变', async () => {
    const { runner } = harness(broadcastOnly([bcPage(20, 0), bcPage(0)]), { batchSize: 50 });
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.runBatch();

    const s = runner.status();
    // 两批之间没有 in_flight 条目，这时候退回「刚抓完的那一页」——少了这个退路，
    // 界面上那一行会时有时无地闪。
    assert.ok(s.current, '要能说出抓到哪儿了');
    assert.match(s.current, /^https:\/\/www\.douban\.com\//);
    assert.equal(s.currentActive, false, '不在飞就别说「正在抓」');
  });

  test('抓取事件里带 URL —— 日志里只有 routeKey 的话，事后回答不了「停在哪一页」', async () => {
    const { runner, events } = harness(broadcastOnly([bcPage(20, 0), bcPage(0)]), {
      batchSize: 50,
    });
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.runBatch();

    const caps = events.filter((e) => e.type === 'capture');
    assert.ok(caps.length > 0);
    for (const c of caps) assert.match(c.url ?? '', /^https:\/\//, 'capture 事件必须带 url');
  });

  test('没有进行中的抓取时报 active:false', () => {
    const { runner } = harness(() => PROFILE);
    assert.deepEqual(runner.status(), { active: false });
  });

  test('展示当前节奏与退避层级', async () => {
    const { runner } = harness(broadcastOnly([bcPage(0)]));
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    const s = runner.status();
    assert.ok(s.intervalMs > 0);
    assert.equal(s.backoffLevel, 0);
  });
});

describe('暂停 → 继续', () => {
  test('继续之后真的能接着抓 —— 这是个报上来的 bug', async () => {
    // 症状：点暂停，再点继续，弹出来的是一条「需要你处理：user_paused」的通知。
    //
    // 两处叠加：① `resume()` 见到 `active` 就当成「已经在跑了」直接返回；
    // ② frontier 还停着，于是下一批立刻又返回同一个停机原因，上层照着它再弹一次。
    // 用户点继续，得到的是同一条通知，永远出不去。
    const { runner } = harness(broadcastOnly([bcPage(20, 0), bcPage(20, 20), bcPage(0)]), {
      batchSize: 2,
    });
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.runBatch();

    await runner.pause('user_paused');
    const stopped = await runner.runBatch();
    assert.equal(stopped.stoppedBy, 'user_paused', '暂停之后确实不再抓');

    const r = await runner.resume(null);
    assert.equal(r.alreadyRunning, undefined, '不该被当成「已经在跑了」跳过');

    const after = await runner.runBatch();
    assert.equal(after.stoppedBy ?? null, null, '继续之后不该还报着同一个停机原因');
    assert.ok(after.captured > 0, '继续之后必须真的抓到东西');
  });

  test('从 checkpoint 恢复之后不会全速空转 —— 这是那 500 行 batch 日志的真凶', async () => {
    // `resume()` 漏写了 `maxCaptures` / `capturedSoFar`，于是：
    //
    //   remaining = Math.max(0, undefined - undefined)  → NaN
    //   maxItems  = Math.min(25, NaN)                   → NaN
    //   while (0 < NaN)                                 → 假，一个请求都不发
    //   hitCap    = undefined !== null && NaN >= undefined → 假
    //   done      = 假 → 驱动循环以每秒几十次空转下去
    //
    // 豆瓣那边什么都看不到（一个请求都没发），所以不会有外力把它撞停。
    const { runner, runStore, calls } = harness(
      broadcastOnly([bcPage(20, 0), bcPage(20, 20), bcPage(0)]), { batchSize: 2 },
    );
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.runBatch();
    await runner.pause('user_paused');

    // 模拟 worker 被杀：丢掉内存里的这一场，只留磁盘上的 checkpoint
    const cp = await runStore.loadCheckpoint();
    runner._run = null;
    const before = calls.length;
    await runner.resume(cp);

    const b = await runner.runBatch();
    assert.ok(Number.isFinite(b.captured), 'captured 不能是 NaN');
    assert.ok(calls.length > before + 1, '恢复之后必须真的发请求，而不是空转');
    assert.ok(b.captured > 0 || b.done, '一批要么抓到东西，要么说自己跑完了');
  });

  test('恢复之后「已抓」接着数，不归零', async () => {
    // 一场几小时的抓取会跨越很多次 service worker 死亡。RouteState 活在内存里，
    // 不接上的话界面显示的是「上次恢复以来抓了多少」，而用户读到的是「一共」。
    //
    // 起点取自 index.ndjson——那是唯一权威的一份（写在档案里、每页落盘）。
    const { runner, runStore } = harness(
      broadcastOnly([bcPage(20, 0), bcPage(20, 20), bcPage(20, 40), bcPage(0)]), { batchSize: 2 },
    );
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.runBatch();
    const before = runner.status().routes.find((r) => r.routeKey === 'broadcast.timeline').captured;
    assert.ok(before > 0, '崩溃前就该有数');

    const cp = await runStore.loadCheckpoint();
    runner._run = null; // worker 被杀
    await runner.resume(cp);

    const after = runner.status().routes.find((r) => r.routeKey === 'broadcast.timeline')?.captured;
    assert.equal(after, before, `恢复之后归零了：${before} → ${after}`);
  });

  test('暂停再继续，不许跳过当前这条路线的后续页', async () => {
    // 报上来的日志：
    //   04:46:16 paused
    //   04:46:18 capture interest.game.collect start=120  ← 在飞的那一页抓完了
    //   04:46:22 resumed
    //   04:46:22 capture interest.game.do    start=0      ← 直接换线了
    //
    // 暂停的语义是「当前这一页抓完就停」，所以那次「抓完了 → 入队下一页」发生在
    // 停机标志已经立起来之后——而 `enqueue()` 当时会挡掉它，一声不响。于是
    // **每按一次暂停，当前那条路线就被截断一次**。
    // **必须在一页「正在飞」的时候按暂停。** 批与批之间按是复现不出来的：那时
    // 没有在飞的条目，也就不会有「抓完了 → 入队下一页」这一步。
    const seen = [];
    let runnerRef = null;
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (!url.includes('statuses')) return bcPage(0);
      seen.push(url);
      const p = Number(/[?&]p=(\d+)/.exec(url)?.[1] ?? 1);
      // 抓第 2 页的**过程中**用户按了暂停
      if (p === 2) runnerRef?._run?.frontier.stop('user_paused');
      return bcPage(20, (p - 1) * 20); // 一直有下一页
    }, { batchSize: 1 });
    runnerRef = runner;

    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    for (let i = 0; i < 10 && !runner._run.frontier.stopped; i++) await runner.runBatch();
    assert.ok(runner._run.frontier.stopped, '得先真的进入暂停状态');
    const lastBefore = Math.max(...seen.map((u) => Number(/[?&]p=(\d+)/.exec(u)?.[1] ?? 1)));

    await runner.resume(null);
    const mark = seen.length;
    await runner.runBatch();

    const after = seen.slice(mark).map((u) => Number(/[?&]p=(\d+)/.exec(u)?.[1] ?? 1));
    assert.ok(after.length > 0, '继续之后广播该接着翻，实际一页都没抓');
    assert.ok(
      Math.max(...after) > lastBefore,
      `继续之后没有接着往后翻：暂停前到 p=${lastBefore}，之后抓的是 ${after}`,
    );
  });

  test('暂停时在飞那一页的下一页必须留在队里', async () => {
    // 直接钉住机制：在飞的那一页抓完时停机标志已经立起来了，它的下一页照样要入队。
    let runnerRef = null;
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (!url.includes('statuses')) return bcPage(0);
      const p = Number(/[?&]p=(\d+)/.exec(url)?.[1] ?? 1);
      if (p === 2) runnerRef?._run?.frontier.stop('user_paused');
      return bcPage(20, (p - 1) * 20);
    }, { batchSize: 1 });
    runnerRef = runner;

    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    for (let i = 0; i < 10 && !runner._run.frontier.stopped; i++) await runner.runBatch();

    const pending = runner._run.frontier.snapshot()
      .filter((it) => it.routeKey === 'broadcast.timeline' && it.state === 'pending');
    assert.ok(pending.length > 0, '暂停把这条线的下一页吞了');
    assert.equal(pending[0].cursor?.value, 3, '留下的该是第 3 页');
  });

  test('恢复之后门控要重开 —— 否则几千个作品详情页就这么没了', async () => {
    // 报上来的日志：
    //   04:55:08 capture interest.item …   ← 正在抓作品详情页
    //   04:55:06 paused
    //   （重新加载扩展，内存清零）
    //   05:01:03 resumed
    //   05:01:03 finished                   ← 立刻「跑完了」
    //
    // `Frontier._openGates` 每次新建都是空的，而门控只在抓取过程中被打开（前置
    // 路线跑完那一刻）。恢复之后没人重开，于是所有还带着 `gatedBy` 的条目一律取
    // 不出来——`hasReady()` 报 false，上层判定「跑完了」，然后收尾写下
    // `status: complete`。
    const listPage = `<html><head><title>我看过的影视(2)</title></head><body>${NAV}
<div id="db-usr-profile"></div><h1>我看过的影视(2)</h1><div class="grid-view">
<div class="item"><a href="https://movie.douban.com/subject/1001/">甲</a>
<span class="date">2025-01-01</span></div>
<div class="item"><a href="https://movie.douban.com/subject/1002/">乙</a>
<span class="date">2024-01-01</span></div>
</div></body></html>`;
    const subjectPage = `<html><body>${NAV}<div id="mainpic"></div><div id="info"></div></body></html>`;

    const { runner, runStore } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (url.includes('statuses')) {
        // 第 1 页有内容（这样才有水位线），之后空页 → 停滞终止 → 门控打开
        const p = Number(/[?&]p=(\d+)/.exec(url)?.[1] ?? 1);
        return p === 1 ? bcPage(20, 0) : bcPage(0);
      }
      if (url.includes('/subject/')) return subjectPage;
      return listPage;
    }, { batchSize: 2 });

    await runner.start({ username: 'example', mediums: ['movie'], includeCatalog: true });

    // 跑到「只剩被门控挡着的作品详情页」——那正是用户按下暂停时的样子
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      const pend = runner._run.frontier.snapshot().filter((it) => it.state === 'pending');
      if (pend.length > 0 && pend.every((it) => it.routeKey === 'interest.item')) {
        ready = true;
        break;
      }
      if ((await runner.runBatch()).done) break;
    }
    assert.ok(ready, '得先跑到「只剩作品详情页」，这条测试才有意义');
    assert.equal(runner._run.frontier.isGateOpen('broadcast.timeline'), true, '门这时该是开的');

    // 模拟「重新加载扩展」：内存清零，只剩磁盘上的 checkpoint
    const cp = await runStore.loadCheckpoint();
    assert.ok(cp.frontier.some((f) => f.gated_by), 'checkpoint 里应当有带门控的条目');
    runner._run = null;
    await runner.resume(cp);

    assert.equal(
      runner._run.frontier.isGateOpen('broadcast.timeline'), true,
      '恢复之后门没重开——所有作品详情页就此取不出来',
    );
    // 真正的判据是**抓到了东西**。`done` 在这里会是 true——夹具只有两个作品详情页，
    // 一批（batchSize 2）就抓完了，那是对的。坏掉时的样子是 `captured: 0` 外加
    // 立刻 done：一页没抓就宣布跑完。
    const b = await runner.runBatch();
    assert.ok(b.captured > 0, `恢复之后一页都没抓就宣布跑完了：${JSON.stringify(b)}`);
  });

  test('本来就在跑的时候继续 → 报 alreadyRunning，不重开一场', async () => {
    const { runner } = harness(broadcastOnly([bcPage(20, 0), bcPage(0)]), { batchSize: 50 });
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });

    const r = await runner.resume(null);
    assert.equal(r.alreadyRunning, true);
  });

  test('继续时重写崩溃哨兵 —— 否则心跳会拿旧的 user_paused 拦住自恢复', async () => {
    // checkpoint 里的 pause_reason 是心跳唯一的判据。停在 user_paused 上的话，
    // worker 被杀之后心跳会认定「用户不想跑」，再也不来了。
    const { runner, runStore } = harness(broadcastOnly([bcPage(20, 0), bcPage(0)]), {
      batchSize: 2,
    });
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.runBatch();
    await runner.pause('user_paused');
    assert.equal((await runStore.loadCheckpoint()).pause_reason, 'user_paused');

    await runner.resume(null);
    assert.equal((await runStore.loadCheckpoint()).pause_reason, CRASH_SENTINEL_REASON);
  });
});

describe('入队时尊重前置依赖', () => {
  test('有前置依赖的路线不入队', async () => {
    // 作品详情页要等广播抓完——不能拿最不可替代的换最可替代的。
    const frontier = new Frontier();
    const defs = buildRoutes({ username: 'example', includeCatalog: true });
    seedFrontier(frontier, defs);

    const snapshot = frontier.snapshot();
    assert.ok(snapshot.some((i) => i.routeKey === 'broadcast.timeline'), '广播要入队');
    assert.ok(
      !snapshot.some((i) => i.routeKey === 'interest.item'),
      '作品详情页有前置依赖，不该现在入队',
    );
  });

  test('同一 URL 不重复入队', async () => {
    const frontier = new Frontier();
    const defs = buildRoutes({ username: 'example' });
    const first = seedFrontier(frontier, defs);
    const second = seedFrontier(frontier, defs);
    assert.ok(first > 0);
    assert.equal(second, 0, '第二次全是重复');
  });
});

describe('不允许并发两次抓取', () => {
  test('已有抓取在进行时拒绝再开', async () => {
    const { runner } = harness(broadcastOnly([bcPage(0)]));
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await assert.rejects(() => runner.start({ username: 'example' }), /已有抓取/);
  });

  test('没有进行中的抓取时不能推进或收尾', async () => {
    const { runner } = harness(() => PROFILE);
    await assert.rejects(() => runner.runBatch(), /没有进行中/);
    await assert.rejects(() => runner.finish(), /没有进行中/);
  });
});

describe('产出的档案内容正确', () => {
  test('index 里每条都有必填字段', async () => {
    const { runner, dirs } = harness(
      broadcastOnly([bcPage(20, 0), bcPage(0), bcPage(0), bcPage(0)]),
      { batchSize: 50 },
    );
    const { dir, bundleId } = await runner.start({
      username: 'example', mediums: [], includeCatalog: false,
    });
    let done = false;
    for (let i = 0; i < 10 && !done; i++) ({ done } = await runner.runBatch());
    await runner.finish();

    const text = dec.decode(await dirs.get(dir).read(indexFilename(bundleId)));
    const entries = text.trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.ok(entries.length > 0);
    for (const e of entries) {
      for (const f of ['capture_id', 'intent', 'surface', 'verdict', 'capture_fidelity', 'observed_at']) {
        assert.ok(e[f], `缺少 ${f}`);
      }
    }
  });
});

describe('恢复要能自足 —— 指针里带够信息', () => {
  test('username 与抓取范围记在指针里', async () => {
    // checkpoint 里只放「推导不出来的抓取状态」，不含 username；少了它
    // 崩溃之后就重建不出路线表，也就恢复不了。
    const { runner, kv } = harness(broadcastOnly([bcPage(0)]));
    await runner.start({ username: 'example', mediums: ['movie'], includeCatalog: false });

    const p = await kv.get('doubak.currentRun');
    assert.equal(p.username, 'example');
    assert.deepEqual(p.mediums, ['movie']);
    assert.equal(p.includeCatalog, false);
  });

  test('恢复时按原来的范围重建路线，不多不少', async () => {
    const { runner, runStore } = harness(broadcastOnly([bcPage(20, 0), bcPage(0)]), { batchSize: 2 });
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.runBatch();
    await runner.pause();

    const cp = await runStore.loadCheckpoint();
    runner._run = null; // 模拟 worker 被杀

    await runner.resume(cp); // 不传 username，靠指针
    const s = runner.status();
    assert.equal(s.active, true);
    assert.equal(s.bundleId, cp.bundle_id, '续的是同一个 bundle');
  });

  test('指针里没有 username 时明确报错', async () => {
    const { runner, runStore, kv } = harness(broadcastOnly([bcPage(0)]));
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    const cp = await runStore.loadCheckpoint();
    const p = await kv.get('doubak.currentRun');
    delete p.username;
    await kv.set('doubak.currentRun', p);
    runner._run = null;

    await assert.rejects(() => runner.resume(cp), /username/);
  });
});

describe('自动发现账号，不让用户手输用户名', () => {
  test('从 /mine/ 落地页的内容里取用户名', async () => {
    // 用户已经登录了，浏览器里就有答案，不该再问他一遍。
    //
    // 以**页面内容**为主而不是最终 URL：URL 靠的是跳转被正确跟随，而那件事
    // 曾经悄悄失效过（redirect:'manual' 在浏览器里给 opaqueredirect，读不到
    // Location，最终 URL 停在跳转前的 /mine/，报出来的却是「请先登录」）。
    const page = PROFILE.replace(/people\/example/g, 'people/mewcatcher');
    const { runner } = harness(() => page);
    runner._fetchImpl = async (url) => {
      if (url.endsWith('/mine/')) {
        return {
          status: 302, url,
          headers: new Headers({ location: 'https://www.douban.com/people/mewcatcher/' }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      const b = new TextEncoder().encode(page);
      return {
        status: 200, url,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
      };
    };

    const { username } = await runner.discoverUsername();
    assert.equal(username, 'mewcatcher');
  });

  test('跳转没跟上（最终 URL 还停在 /mine/）也能从内容里认出来', async () => {
    // 这正是那个 bug 的形状：跳转没被跟随，最终 URL 是 /mine/。只要落地页的
    // 内容是对的，就不该失败——更不该报「请先登录」。
    const page = PROFILE.replace(/people\/example/g, 'people/mewcatcher');
    const { runner } = harness(() => page);
    const b = new TextEncoder().encode(page);
    runner._fetchImpl = async () => ({
      status: 200,
      url: 'https://www.douban.com/mine/', // 没跟上，停在跳转前
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    });

    const { username } = await runner.discoverUsername();
    assert.equal(username, 'mewcatcher');
  });

  test('跳转没落到个人主页 → 提示先登录', async () => {
    const { runner } = harness(() => LOGIN);
    runner._fetchImpl = async (url) => ({
      status: 200, url: 'https://accounts.douban.com/passport/login',
      headers: new Headers({ 'content-type': 'text/html' }),
      arrayBuffer: async () => new TextEncoder().encode(LOGIN).buffer,
    });
    await assert.rejects(() => runner.discoverUsername(), /先.*登录|无法确定/);
  });
});

describe('小范围试跑：自然终止 vs 人为截断', () => {
  test('只抓指定路线', async () => {
    // 挑一条天然很小的路线（真实档案里舞台剧只有一两条），就能完整走完
    // 整个生命周期，包括干净终止与水位线推进。
    const { runner } = harness(broadcastOnly([bcPage(0)]));
    await runner.start({
      username: 'example',
      onlyRoutes: ['broadcast.timeline'],
    });
    const s = runner.status();
    assert.ok(s.active);
  });

  test('onlyRoutes 里没有已知路线时明确报错', async () => {
    const { runner } = harness(broadcastOnly([bcPage(0)]));
    await assert.rejects(
      () => runner.start({ username: 'example', onlyRoutes: ['不存在的路线'] }),
      /没有一条已知路线/,
    );
  });

  test('maxCaptures 是安全阀，会如实标注为截断', async () => {
    // 被它截断的抓取不算干净完成——如实说出来，否则用户会以为「跑完了」。
    const pages = Array.from({ length: 20 }, (_, i) => bcPage(20, i * 20));
    const { runner } = harness(broadcastOnly(pages), { batchSize: 2 });
    await runner.start({
      username: 'example', mediums: [], includeCatalog: false,
      onlyRoutes: ['broadcast.timeline'], maxCaptures: 3,
    });

    let last;
    for (let i = 0; i < 5; i++) {
      last = await runner.runBatch();
      if (last.done) break;
    }
    assert.equal(last.done, true);
    assert.equal(last.truncated, true, '必须标明是被截断的');
  });

  test('被截断的抓取不推进水位线', async () => {
    // 人为截断不是干净完成。水位线一旦错误推进，下次增量会从错的位置开始。
    const pages = Array.from({ length: 20 }, (_, i) => bcPage(20, i * 20));
    const { runner } = harness(broadcastOnly(pages), { batchSize: 2 });
    await runner.start({
      username: 'example', mediums: [], includeCatalog: false,
      onlyRoutes: ['broadcast.timeline'], maxCaptures: 3,
    });
    let done = false;
    for (let i = 0; i < 5 && !done; i++) ({ done } = await runner.runBatch());

    const manifest = await runner.finish('aborted');
    const cs = manifest.crawl_state.find((c) => c.route_key === 'broadcast.timeline');
    assert.equal(cs.advanced, false, '截断绝不能推进水位线');
  });

  test('自然终止的小范围抓取【会】推进水位线', async () => {
    // 这是与截断的关键区别：走到终点就是干净完成，哪怕只有一页。
    const { runner } = harness(broadcastOnly([bcPage(20, 0), bcPage(0), bcPage(0), bcPage(0)]), {
      batchSize: 50,
    });
    await runner.start({
      username: 'example', mediums: [], includeCatalog: false,
      onlyRoutes: ['broadcast.timeline'],
    });
    let done = false;
    for (let i = 0; i < 10 && !done; i++) ({ done } = await runner.runBatch());

    const manifest = await runner.finish();
    const cs = manifest.crawl_state.find((c) => c.route_key === 'broadcast.timeline');
    assert.equal(cs.advanced, true, '自然终止是干净完成');
  });
});

describe('身份确认对着真实页面', () => {
  const real = readFileSync(new URL('./fixtures/profile-2026-07.html', import.meta.url), 'utf-8');

  test('真实个人主页 —— 一个请求就够，不需要任何退路', async () => {
    // 曾经有过一条退路：「主页取不到 uid 就去广播页补一次」。删掉了，因为 uid
    // 现在取自**全局导航**，而全局导航每张登录后页面都有。
    //
    // 那条退路本身还有个更深的问题：它默认「广播条目上的 data-uid 就是本人」，
    // 而在作品详情页上那是**评论者**的 ID。
    const { runner, calls } = harness(() => real);

    const r = await runner.start({ username: 'mewcatcher', includeCatalog: false });

    assert.equal(r.account.userId, '82160871');
    assert.equal(r.account.username, 'mewcatcher');
    assert.equal(calls.length, 1, '身份确认只该发一个请求');
    assert.ok(calls[0].includes('/people/mewcatcher/'));
  });

  test('全局导航被抹掉 → 明确失败，不去别处猜', async () => {
    // 取错比取不到糟糕得多：取不到是开不了工，取错是把档案挂在别人名下。
    // 把四个取证点全部抹掉：两段脚本 + 导航项的埋点属性。
    const stripped = real
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/data-moreurl-dict="[^"]*"/g, '');
    const { runner, calls } = harness(() => stripped);

    await assert.rejects(() => runner.start({ username: 'mewcatcher', includeCatalog: false }), (e) => {
      assert.equal(e.reason, 'missing_user_id');
      return true;
    });
    assert.equal(calls.length, 1, '失败了也不该再去别的页面碰运气');
  });
});

describe('开工失败不许留下半开的状态', () => {
  test('落盘失败 → active 退回 false，还能再试', async () => {
    // 不退的话 `active` 永远是 true，此后每次「开始抓取」都被自己挡掉，报的是
    // 「已有抓取在进行中」——而真实原因是上一次根本没开成。用户面对的是一个
    // 既没在抓、又开不了新的死局，除了重装扩展没有出路。这个坑真的踩过。
    const { runner, runStore } = harness(() => PROFILE);

    let fail = true;
    const orig = runStore.setCurrentRun.bind(runStore);
    runStore.setCurrentRun = async (p) => {
      if (fail) throw new Error('存储坏了');
      return orig(p);
    };

    await assert.rejects(() => runner.start({ username: 'example', includeCatalog: false }), /存储坏了/);
    assert.equal(runner.active, false, 'active 没退回去 —— 之后再也开不了工');

    // 修好之后照样能开
    fail = false;
    const r = await runner.start({ username: 'example', includeCatalog: false });
    assert.ok(r.bundleId);
    assert.equal(runner.active, true);
  });

  test('checkpoint 写失败也一样退回', async () => {
    const { runner, runStore } = harness(() => PROFILE);
    runStore.saveCheckpoint = async () => { throw new Error('写不进去'); };

    await assert.rejects(() => runner.start({ username: 'example', includeCatalog: false }), /写不进去/);
    assert.equal(runner.active, false);
  });

  test('身份确认失败不留状态（它发生在 _run 被设之前）', async () => {
    const { runner } = harness(() => '<html><body>认不出来</body></html>');
    await assert.rejects(() => runner.start({ username: 'example', includeCatalog: false }));
    assert.equal(runner.active, false);
  });
});

describe('暂停', () => {
  test('停下来之后 status 报 stopped —— active 不等于「正在发请求」', async () => {
    // 两者混为一谈的后果：暂停之后界面依旧显示「正在抓取」，用户以为按钮没生效，
    // 然后反复去点。
    const { runner } = harness(broadcastOnly([bcPage(20)]));
    await runner.start({ username: 'example', includeCatalog: false });

    assert.equal(runner.status().stopped, false);
    await runner.pause();

    const st = runner.status();
    assert.equal(st.active, true, '还在内存里，可以继续');
    assert.equal(st.stopped, true, '但已经不发请求了');
    assert.equal(st.stoppedBy, 'user_paused');
  });

  test('原因会被带下去 —— 不同原因的恢复方式完全不同', async () => {
    // 一律写 user_paused 的话，「权限被撤」会被当成「用户自己暂停的」，
    // 于是界面告诉他点「继续」——而权限没改回来，继续必然再失败。
    const { runner } = harness(broadcastOnly([bcPage(20)]));
    await runner.start({ username: 'example', includeCatalog: false });
    await runner.pause('host_permission_lost');
    assert.equal(runner.status().stoppedBy, 'host_permission_lost');
  });

  test('checkpoint 写失败**不**让暂停失败', async () => {
    // 用户按暂停往往正是因为出了问题（比如写盘一直在报错）。此时最不该做的就是
    // 拒绝停下——那会让他只能去关浏览器。
    const { runner, runStore, events } = harness(broadcastOnly([bcPage(20)]));
    await runner.start({ username: 'example', includeCatalog: false });

    runStore.saveCheckpoint = async () => { throw new Error('盘满了'); };
    await assert.doesNotReject(() => runner.pause());

    assert.equal(runner.status().stopped, true, '不管落盘成不成，都已经停了');
    const paused = events.filter((e) => e.type === 'paused').at(-1);
    assert.equal(paused.checkpointSaved, false);
    assert.match(paused.message, /盘满了/, '失败原因要说出来，不能悄悄吞掉');
  });

  test('落盘成功时明确标出来', async () => {
    const { runner, events } = harness(broadcastOnly([bcPage(20)]));
    await runner.start({ username: 'example', includeCatalog: false });
    await runner.pause();
    assert.equal(events.filter((e) => e.type === 'paused').at(-1).checkpointSaved, true);
  });
});

describe('并发恒为 1 —— 豆瓣同一时刻只会看到我们的一个请求', () => {
  /**
   * 这一组是**结果导向**的：不检查内部有几把锁、几个闸门，只检查从豆瓣那一侧
   * 看过去是什么样。把账号搞封是不可接受的结果，而对方唯一能观察到的就是
   * 「同一时刻有几个请求在飞」和「两个请求隔多久」。
   */

  /** 记下每一刻在飞的请求数。 */
  function tracking(respond) {
    let inFlight = 0;
    let maxInFlight = 0;
    const order = [];
    const wrap = (url, n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(url);
      return respond(url, n);
    };
    return { wrap, peak: () => maxInFlight, order, release: () => { inFlight -= 1; } };
  }

  test('列表页与作品详情页交给同一个循环，不会同时在飞', async () => {
    // 作品详情页是由列表页**派生**的：抓完一页列表，把里面的条目入队，
    // 然后由同一个 frontier / 同一个循环挨个取。没有第二条执行路径。
    const t = tracking(broadcastOnly([bcPage(20, 0), bcPage(20, 20), bcPage(0)]));
    const { runner } = harness((url, n) => {
      const body = t.wrap(url, n);
      t.release();
      return body;
    }, { batchSize: 50 });

    await runner.start({ username: 'example', mediums: [], includeCatalog: true });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;

    assert.equal(t.peak(), 1, '同一时刻只能有一个请求在飞');
  });

  test('同一条路线上永远只有一个页面在飞 —— frontier 的 in_flight 会挡住整条线', async () => {
    const { runner } = harness(broadcastOnly([bcPage(20, 0), bcPage(0)]), { batchSize: 50 });
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });

    const f = runner._run.frontier;
    const a = f.next();
    assert.ok(a);
    assert.equal(a.state, 'in_flight');
    // 同一条路线的下一页取不出来——哪怕它已经 pending
    const others = f.snapshot().filter((it) => it.routeKey === a.routeKey && it.state === 'pending');
    if (others.length) {
      const b = f.next();
      assert.notEqual(b?.routeKey, a.routeKey, '同一条路线不许并发');
    }
  });

  test('身份确认与开工探测之间也要隔够间隔', async () => {
    // 这两段活动早先各建一个闸门，而闸门的**第一个**请求是不等待的
    // （`_lastFinishedAt` 是 null）。于是这两发贴在一起发出去——不是并发，
    // 但同样违反「1 秒一个」。豆瓣看到的只有请求，它不关心我们内部把它们
    // 算作几段活动。
    const INTERVAL = 40;
    const at = [];
    const base = broadcastOnly([bcPage(0)]);
    const { runner } = harness((url, n) => {
      at.push(Date.now());
      return base(url, n);
    }, { batchSize: 5, pacerOptions: { intervalMs: INTERVAL, jitterRatio: 0 } });

    const who = await runner.discoverUsername();
    await runner.start({ username: who.username, mediums: [], includeCatalog: false });

    assert.ok(at.length >= 2, '至少发了身份确认与开工探测两发');
    // 用真实时钟测真实等待。差一点点是调度抖动，留 5ms 余量。
    assert.ok(
      at[1] - at[0] >= INTERVAL - 5,
      `两发之间只隔了 ${at[1] - at[0]}ms，应当 ≥ ${INTERVAL}ms —— 它们贴在一起发出去了`,
    );
  });
});

describe('抓取顺序：先跑完最难补的那条', () => {
  /**
   * 设计里的排序是 广播 → 长文 → 图片 → 标记列表 → 作品详情页，理由是
   * 「中途被打断时，先跑完的一定是最难补的」。广播是唯一可静默删除、删了就
   * 再也拿不回来的东西。
   *
   * 报上来的现象是：广播抓了 40 条还在「进行中」，电影、音乐、书、游戏、
   * 舞台剧十几条线**同时**在推进。
   */

  test('广播没跑完之前不碰标记列表', async () => {
    const seen = [];
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      seen.push(url);
      if (url.includes('statuses')) {
        const p = Number(/[?&]p=(\d+)/.exec(url)?.[1] ?? 1);
        return p <= 4 ? bcPage(20, (p - 1) * 20) : bcPage(0);
      }
      return bcPage(0);
    }, { batchSize: 3 });

    await runner.start({ username: 'example', mediums: ['movie', 'book'], includeCatalog: false });
    for (let i = 0; i < 30; i++) if ((await runner.runBatch()).done) break;

    const firstInterest = seen.findIndex((u) => u.includes('/interest') || u.includes('/collect'));
    const lastBroadcast = seen.findLastIndex((u) => u.includes('statuses'));
    if (firstInterest >= 0) {
      assert.ok(
        lastBroadcast < firstInterest,
        `广播还没抓完就去抓标记列表了：最后一页广播在第 ${lastBroadcast} 个请求，`
          + `第一个标记列表在第 ${firstInterest} 个`,
      );
    }
  });

  test('翻出来的下一页继承路线优先级 —— 不继承的话第 2 页就掉到队尾了', async () => {
    // 这是上面那个现象的成因：`enqueue` 的 priority 默认值是 50，而
    // 广播是 10、标记列表是 40。种子是带优先级入队的，**翻页却没带**，
    // 于是广播第 2 页（50）输给了每一条标记列表的种子（40）。
    //
    // 后果不只是顺序乱：整个优先级设计就此失效——第一页之后，所有路线
    // 一律并列在 50，按入队顺序轮转。用户看到的就是十几条线一起慢慢爬。
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      return url.includes('statuses') ? bcPage(20, 0) : bcPage(0);
    }, { batchSize: 1 });

    await runner.start({ username: 'example', mediums: ['movie'], includeCatalog: false });

    // 一直跑到广播第 2 页真的入队为止。**不能只跑一批就断言**：优先级 0 的
    // 身份路线排在前面，那时候找到的还是广播的种子（它当然带着正确的优先级），
    // 于是测试会假通过——这条测试自己先踩过一次。
    const f = runner._run.frontier;
    const page2 = () => f.snapshot().find(
      (it) => it.routeKey === 'broadcast.timeline' && it.cursor?.value === 2,
    );
    for (let i = 0; i < 15 && !page2(); i++) await runner.runBatch();

    const p2 = page2();
    assert.ok(p2, '广播第 2 页应当已入队');
    assert.equal(p2.priority, PRIORITY.BROADCAST, '第 2 页必须和第 1 页同一优先级');
  });

  test('派生的作品详情页也继承 —— 它必须留在最后', async () => {
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      return bcPage(0);
    }, { batchSize: 1 });
    await runner.start({ username: 'example', mediums: [], includeCatalog: true });
    const f = runner._run.frontier;
    for (const it of f.snapshot()) {
      if (it.routeKey === 'interest.item') assert.equal(it.priority, PRIORITY.CATALOG);
    }
  });
});

describe('被恢复过的抓取必须收得了尾', () => {
  test('崩溃 → 恢复 → 收尾，不报「段与索引已失去对应关系」', async () => {
    // 报上来的原样：
    //
    //   data-20260730T131755Z-74f5dc-00001.warc.gz: record_count 为 219，
    //   但 index 中指向本段的行数为 0。段与索引已失去对应关系。
    //
    // 而那份 index 文件里**确实有 219 行**指向那一段。坏的不是档案，是
    // `IndexWriter` 压根没有恢复路径：段那边从磁盘恢复了 record_count，
    // index 这边三个计数器从零开始，收尾时交叉核对必然失败。
    //
    // 影响面是「全部」：一场几小时的抓取必然跨越很多次 service worker 死亡，
    // 也就是说**正常的完整抓取一次都收不了尾**。
    const { runner, runStore } = harness(
      broadcastOnly([bcPage(20, 0), bcPage(20, 20), bcPage(20, 40), bcPage(0)]), { batchSize: 2 },
    );
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.runBatch();

    const cp = await runStore.loadCheckpoint();
    runner._run = null; // worker 被杀
    await runner.resume(cp);
    for (let i = 0; i < 30; i++) if ((await runner.runBatch()).done) break;

    const manifest = await runner.finish('complete');
    assert.ok(manifest, '收尾必须成功');

    // 交叉核对真的成立：每段的 record_count == index 里指向它的行数
    const store = [...dirsOf(runner)][0];
    void store;
    const total = manifest.segments.reduce((n, s) => n + s.record_count, 0);
    assert.equal(manifest.index.line_count, total, 'index 行数必须等于所有段的记录数之和');
    assert.ok(total > 1, '要真的跨过了崩溃点，否则这条测试没测到东西');
  });

  test('恢复之后 manifest 的计数含崩溃之前那些', async () => {
    // `counts.by_verdict` 之类同样是内存累加。只算恢复之后那段的话，manifest
    // 会说这份档案比它实际小得多。
    const { runner, runStore } = harness(
      broadcastOnly([bcPage(20, 0), bcPage(20, 20), bcPage(0)]), { batchSize: 2 },
    );
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.runBatch();
    const cp = await runStore.loadCheckpoint();
    runner._run = null;
    await runner.resume(cp);
    for (let i = 0; i < 30; i++) if ((await runner.runBatch()).done) break;

    const manifest = await runner.finish('complete');
    const okCount = manifest.counts?.by_verdict?.ok ?? 0;
    assert.ok(okCount >= 2, `by_verdict.ok 只有 ${okCount}，崩溃之前那些没算进来`);
  });
});

/** 取出 harness 里的档案目录（只用于上面那条测试的可读性）。 */
function dirsOf(runner) {
  return [runner?._run?.store].filter(Boolean);
}

describe('规范 §7.1：恢复之后的 manifest 必须与「一次跑完」的一致', () => {
  /**
   * 报上来的样子：一份 status=complete 的档案，21 条路线**全部**写着
   *
   *     有 1 处缺口。原因：aborted。
   *
   * 而那次抓取一次都没被风控打断过——只是中途崩过、恢复过。
   *
   * 成因：checkpoint 的 `routes[]` 只存了游标（够续上翻页），没存连续性证明。
   * 恢复之后每条路线都是崭新的：没有水位线、没走完、没被打断，于是收尾时
   * `flushRouteEvidence()` 把它们全部记成 aborted。
   *
   * 后果不只是难看：`advanced` 永远是 false，**增量抓取永远不可能**。
   */

  /**
   * 时间**逐页递减**的广播页。
   *
   * 共用的 `bcPage()` 在每页上重复同样的 9 个时间戳，那会让「水位线活过崩溃」这条
   * 测试假通过：无论从哪一页开始重算，最新时间都一样。水位线是**跨页**的量，
   * 测它就必须让页与页的时间真的不同。
   *
   * @param {number} page  1 起
   */
  function descendingPage(page, n = 20) {
    let items = '';
    for (let i = 0; i < n; i++) {
      const day = 28 - (page - 1) * 2 - (i % 2);
      const hour = 20 - (i % 10);
      items += `<div class="status-item" data-sid="${page * 100 + i}" data-uid="82160871">`
        + `<span class="created_at" title="2026-07-${String(day).padStart(2, '0')} `
        + `${String(hour).padStart(2, '0')}:00:00">x</span></div>`;
    }
    return `<html><head><title>\n我的动态\n</title></head><body>${NAV}
<div id="db-usr-profile"><div class="info"><h1>示例</h1></div></div>
<div class="stream-items">${items}</div></body></html>`;
  }

  /** 跑一场完整抓取，返回 manifest。`crashAfter` 批之后模拟 worker 被杀。 */
  async function crawl({ crashAfter = null } = {}) {
    const { runner, runStore } = harness(
      broadcastOnly([descendingPage(1), descendingPage(2), descendingPage(3), bcPage(0)]),
      { batchSize: 1 },
    );
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });

    let n = 0;
    for (let i = 0; i < 40; i++) {
      const b = await runner.runBatch();
      n += 1;
      if (b.done) break;
      if (crashAfter && n === crashAfter) {
        const cp = await runStore.loadCheckpoint();
        runner._run = null; // worker 被杀
        await runner.resume(cp);
      }
    }
    return runner.finish('complete');
  }

  test('崩过一次也不该冒出 aborted 缺口', async () => {
    const m = await crawl({ crashAfter: 2 });
    const bc = m.crawl_state.find((r) => r.route_key === 'broadcast.timeline');
    assert.ok(bc, '广播那条要在');
    assert.deepEqual(bc.gaps, [], `凭空多出缺口：${JSON.stringify(bc.gaps)}`);
  });

  test('水位线要活过崩溃 —— 否则增量永远不可能', async () => {
    const m = await crawl({ crashAfter: 2 });
    const bc = m.crawl_state.find((r) => r.route_key === 'broadcast.timeline');
    assert.ok(bc.high_water_time, 'high_water_time 是 null，下次就没有下界可用');
    assert.equal(bc.contiguous, true);
    assert.equal(bc.advanced, true, 'advanced=false 意味着这次抓取推不进水位线');
  });

  test('「已回溯到」也要活过崩溃', async () => {
    const m = await crawl({ crashAfter: 2 });
    const bc = m.crawl_state.find((r) => r.route_key === 'broadcast.timeline');
    assert.ok(bc.low_water_time, 'low_water_time 是界面上「已回溯到」那一列');
  });

  test('逐字段比对：崩过的那份与没崩的那份一致', async () => {
    // 这是规范 §7.1 写下的判据本身。
    const clean = await crawl();
    const crashed = await crawl({ crashAfter: 2 });

    const strip = (m) => m.crawl_state.map((r) => ({
      route_key: r.route_key,
      high_water_time: r.high_water_time,
      high_water_raw: r.high_water_raw,
      low_water_time: r.low_water_time,
      contiguous: r.contiguous,
      advanced: r.advanced,
      gaps: r.gaps,
    })).sort((a, b) => (a.route_key < b.route_key ? -1 : 1));

    assert.deepEqual(strip(crashed), strip(clean));
  });

  test('覆盖率的实抓数也一致，不因崩溃而少算或多算', async () => {
    const clean = await crawl();
    const crashed = await crawl({ crashAfter: 2 });
    const cov = (m) => Object.fromEntries(m.coverage.map((c) => [c.route_key, c.captured_count]));
    assert.deepEqual(cov(crashed), cov(clean));
  });

  test('真被打断的时候，aborted 还是要如实记 —— 别把这条测试反过来满足', async () => {
    const { runner } = harness(
      broadcastOnly([bcPage(20, 0), bcPage(20, 20), bcPage(0)]), { batchSize: 1 },
    );
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.runBatch();
    await runner.runBatch();

    const m = await runner.finish('aborted');
    const bc = m.crawl_state.find((r) => r.route_key === 'broadcast.timeline');
    assert.ok(bc.gaps.length > 0, '真没跑完就该记缺口');
    assert.equal(bc.advanced, false, '没跑完绝不许推进水位线');
  });
});

describe('恢复之后不许倒着翻页 —— 那会伪造出一次「跑完了」', () => {
  /**
   * 报上来的日志（广播）：
   *
   *     02:02:12  p=20      ← 恢复后的第一页，对的
   *     02:02:14  p=2       ← ？？
   *     02:02:17  p=3
   *     ...       p=19
   *     02:02:59  interest.book.collect   ← 广播根本没抓完就换线了
   *
   * 两步：① checkpoint 里的条目没记 `cursor`，于是「下一页」按
   * `route.pagination.first` 从第 1 页重新数——抓完 p=20 之后去抓 p=2。
   * ② p=2…p=19 全是重复条目，**停滞检测把它当成「这条线走完了」**，于是广播被
   * `markFinished()`、水位线推进、门控放开、去抓标记列表。
   *
   * ② 才是真正严重的那一半：一次**假的完整性声明**。
   */

  /** 一场跑到第 N 页的广播抓取，返回 checkpoint 与 runner。 */
  async function crawlThenCrash(stopAfterBatches) {
    const seen = [];
    const { runner, runStore } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (!url.includes('statuses')) return bcPage(0);
      seen.push(url);
      const p = Number(/[?&]p=(\d+)/.exec(url)?.[1] ?? 1);
      // 每页 20 条**互不重复**的条目，一直有下一页
      return bcPage(20, (p - 1) * 20);
    }, { batchSize: 1 });

    await runner.start({ username: 'example', mediums: ['book'], includeCatalog: false });
    for (let i = 0; i < stopAfterBatches; i++) await runner.runBatch();
    return { runner, runStore, seen };
  }

  test('checkpoint 里的条目带着游标 —— 这是「下一页」唯一的依据', async () => {
    const { runStore, seen } = await crawlThenCrash(8);
    const lastBefore = Number(/[?&]p=(\d+)/.exec(seen.at(-1))?.[1] ?? 1);
    assert.ok(lastBefore >= 3, `崩溃前该抓到第 3 页以后，实际到 p=${lastBefore}`);

    const cp = await runStore.loadCheckpoint();
    const pending = cp.frontier.find((it) => it.url.includes('statuses'));
    assert.ok(pending, '广播那条应当还有未抓的页留在 checkpoint 里');
    assert.ok(pending.cursor, '没有 cursor，下一页就会从第 1 页重新数');
    assert.equal(pending.cursor.value, lastBefore + 1);
  });

  test('恢复之后队列里那条也带着游标', async () => {
    const { runner, runStore, seen } = await crawlThenCrash(8);
    const lastBefore = Number(/[?&]p=(\d+)/.exec(seen.at(-1))?.[1] ?? 1);
    const cp = await runStore.loadCheckpoint();
    runner._run = null;
    await runner.resume(cp);

    const it = runner._run.frontier.snapshot()
      .find((x) => x.routeKey === 'broadcast.timeline' && x.state === 'pending');
    assert.ok(it?.cursor, '恢复之后游标丢了');
    assert.equal(it.cursor.value, lastBefore + 1);
  });

  test('旧 checkpoint 没记 cursor → 从 URL 反推', async () => {
    // 升级之前写下的半成品档案必须还能救——不然用户手上那份只能从头重抓。
    const { runner, runStore, seen } = await crawlThenCrash(8);
    const lastBefore = Number(/[?&]p=(\d+)/.exec(seen.at(-1))?.[1] ?? 1);

    const cp = await runStore.loadCheckpoint();
    for (const it of cp.frontier) delete it.cursor; // 模拟旧格式
    runner._run = null;
    await runner.resume(cp);

    const it = runner._run.frontier.snapshot()
      .find((x) => x.routeKey === 'broadcast.timeline' && x.state === 'pending');
    assert.ok(it?.cursor, '反推失败，下一页会从第 1 页重新数');
    assert.equal(it.cursor.value, lastBefore + 1);
  });

  test('恢复之后去重集合认识已经抓成功的页面', async () => {
    const { runner, runStore, seen } = await crawlThenCrash(8);
    const already = seen[1]; // 抓过的某一页
    const cp = await runStore.loadCheckpoint();
    runner._run = null;
    await runner.resume(cp);

    const ok = runner._run.frontier.enqueue({
      url: already, urlKey: urlKey(already), routeKey: 'broadcast.timeline',
      intent: 'broadcast.timeline', ordered: true, priority: 10,
    });
    assert.equal(ok, false, '已经抓成功的页面被重新排进队列了');
  });

  test('端到端：恢复之后一页都不重抓，也不倒着翻', async () => {
    const { runner, runStore, seen } = await crawlThenCrash(8);
    const lastBefore = Number(/[?&]p=(\d+)/.exec(seen.at(-1))?.[1] ?? 1);
    const before = new Set(seen);

    const cp = await runStore.loadCheckpoint();
    runner._run = null;
    await runner.resume(cp);
    const mark = seen.length;
    for (let i = 0; i < 5; i++) await runner.runBatch();

    const after = seen.slice(mark);
    assert.ok(after.length > 0, '恢复之后要接着抓');
    for (const u of after) {
      assert.equal(before.has(u), false, `重抓了已经抓过的 ${u}`);
      const p = Number(/[?&]p=(\d+)/.exec(u)?.[1] ?? 1);
      assert.ok(p > lastBefore, `倒回去抓了 p=${p}（崩溃前已经到 p=${lastBefore}）`);
    }
  });

  test('广播没走完就不许放开作品详情页的门控', async () => {
    // 假停滞的连锁后果：广播被标成完成 → 门控放开 → 去抓最可替代的东西，
    // 而最不可替代的那条线还剩一大半。
    const { runner, runStore } = await crawlThenCrash(8);
    const cp = await runStore.loadCheckpoint();
    runner._run = null;
    await runner.resume(cp);
    for (let i = 0; i < 6; i++) await runner.runBatch();

    const st = runner._run.loop.routeStates.get('broadcast.timeline');
    assert.equal(st._finished, false, '广播还有下一页，不该被标成走完了');
    assert.equal(st.contiguous, false);
  });
});

describe('单页路线也要能「走完」', () => {
  /**
   * 真实档案里 6 条路线（个人主页 + 5 个分类入口）全都写着
   *
   *     有 1 处缺口。原因：aborted。
   *
   * 而它们**一次就抓全了**——那些页面本来就只有一页。
   *
   * 成因：路线定义里写着 `pagination: {kind:'page', step:1, first:1}`，而
   * `entryUrl` 压根不收 offset。分页路线只能靠**停滞检测**或**到达下界**才算走完，
   * 这两件事在一张不翻页的页面上永远不会发生。
   */

  test('个人主页与分类入口抓完就是走完了', async () => {
    const { runner } = harness(broadcastOnly([bcPage(0)]), { batchSize: 50 });
    await runner.start({ username: 'example', mediums: ['movie'], includeCatalog: false });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;

    // 这个夹具不给标记列表页，那条线会失败——**无所谓**：连续性证明是逐路线的，
    // 整场抓取中止不代表每条路线都没跑完。这条测试要的正是这个区分。
    const m = await runner.finish('aborted');
    for (const key of ['profile.overview', 'profile.category_entry.movie']) {
      const cs = m.crawl_state.find((r) => r.route_key === key);
      assert.ok(cs, `${key} 应当在 crawl_state 里`);
      assert.deepEqual(cs.gaps, [], `${key} 凭空多出缺口：${JSON.stringify(cs.gaps)}`);
      assert.equal(cs.contiguous, true, `${key} 抓全了却没被标成连续`);
    }
  });

  test('抓完那一页就当场标成走完 —— 不用等收尾', async () => {
    // 报上来的：整场抓取期间那 6 条一直显示「进行中」，而它们在第一秒就抓完了。
    // 用户看到 6 行永远不动的「进行中」，合理地以为卡住了。
    //
    // 早先只在收尾时补这一刀（`_settleUnfinished`），抓取期间没人标。
    const { runner } = harness(broadcastOnly([bcPage(20, 0), bcPage(20, 20), bcPage(0)]), {
      batchSize: 3,
    });
    await runner.start({ username: 'example', mediums: ['movie'], includeCatalog: false });

    // 只跑几批——**远没到收尾**
    for (let i = 0; i < 3; i++) await runner.runBatch();

    const s = runner.status();
    for (const key of ['profile.overview', 'profile.category_entry.movie']) {
      const r = s.routes.find((x) => x.routeKey === key);
      assert.ok(r, `${key} 该在进度表里`);
      assert.equal(r.captured, 1);
      assert.equal(r.contiguous, true, `${key} 抓完了却还显示「进行中」`);
    }
  });

  test('「单页」判据是 entryUrl + 没有 pagination —— 作品详情页不在其中', () => {
    // 直接钉住这条分类规则本身。
    //
    // 作品详情页必须排除：它是**派生集合**，条目由列表页陆续入队，队列中途空掉
    // 是正常的——那时标成走完了就是假的完整性声明。今天的优先级排序（列表 40、
    // 详情页 90）让这一幕暂时撞不上，但那是**排序的副作用，不是这条规则的保证**，
    // 排序一改就会撞上。所以判据本身要被钉死。
    const defs = buildRoutes({ username: 'example', includeCatalog: true });
    const single = defs.filter((d) => d.entryUrl && !d.pagination).map((d) => d.key).sort();

    assert.deepEqual(single, [
      'profile.category_entry.book', 'profile.category_entry.drama',
      'profile.category_entry.game', 'profile.category_entry.movie',
      'profile.category_entry.music', 'profile.overview',
    ]);
    assert.equal(single.includes('interest.item'), false, '派生集合不是单页路线');

    const item = defs.find((d) => d.key === 'interest.item');
    assert.equal(item.entryUrl, undefined, '作品详情页一旦有了 entryUrl，就会被误判成单页');
  });

  test('它们的路线定义里不该再有 pagination', () => {
    // 那个字段是假的：`entryUrl` 不收 offset，写了也翻不了页。
    const defs = buildRoutes({ username: 'example', includeCatalog: true });
    for (const d of defs) {
      if (d.key === 'profile.overview' || d.key.startsWith('profile.category_entry.')) {
        assert.equal(d.pagination, undefined, `${d.key} 还带着假的 pagination`);
      }
    }
  });

  test('分页路线的队列悄悄空掉 → 说得出原因的缺口，不是笼统的 aborted', async () => {
    // 「aborted」看起来像被风控打断，会把排查引向完全错误的方向。真实成因通常是
    // 算出来的下一页早就抓过、被去重挡掉了。
    //
    // batchSize 1 + 只跑一批：广播刚抓完第 1 页，第 2 页还在队里、还没停滞终止。
    const { runner } = harness(broadcastOnly([bcPage(20, 0), bcPage(20, 20)]), { batchSize: 1 });
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    for (let i = 0; i < 10; i++) {
      await runner.runBatch();
      const st = runner._run.loop.routeStates.get('broadcast.timeline');
      if (st && !st._finished) break;
    }

    // 手动把广播的队列清空，模拟「下一页没入成队」。
    // `snapshot()` 给的是副本，改它没用——要走真实的 API。
    const f = runner._run.frontier;
    let cleared = 0;
    for (let i = 0; i < 20; i++) {
      const it = f.next();
      if (!it) break;
      f.settle(it, 'ok');
      if (it.routeKey === 'broadcast.timeline') cleared += 1;
    }
    assert.ok(cleared > 0, '得先有待抓的页，这条测试才有意义');
    assert.equal(f.hasOutstanding('broadcast.timeline'), false);

    const m = await runner.finish('aborted');
    const cs = m.crawl_state.find((r) => r.route_key === 'broadcast.timeline');
    assert.equal(cs.gaps.length, 1);
    assert.equal(cs.gaps[0].reason, 'next_page_not_queued');
    assert.match(cs.gaps[0].detail ?? '', /去重|入队/);
    assert.equal(cs.advanced, false, '走岔了就绝不许推进水位线');
  });

  test('一页都没读成过 → 说「这条线读不到」，不是「翻页走岔了」', async () => {
    // 最常见的成因：这个分类这位用户压根没用过，或者豆瓣把它下线了。
    // 说成「下一页没能入队、大概是被去重挡掉了」等于**编造一个错误的原因**，
    // 而这一行正是给人排查用的。
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (url.includes('music.douban.com')) return { status: 404, body: '<html>没有这个页面</html>' };
      return bcPage(0);
    }, { batchSize: 50 });
    await runner.start({ username: 'example', mediums: ['music'], includeCatalog: false });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;

    const m = await runner.finish('aborted');
    const cs = m.crawl_state.find((r) => r.route_key === 'interest.music.collect');
    assert.ok(cs, '发过请求的路线必须出现在完整性证据里，不能整条消失');
    const reasons = cs.gaps.map((g) => g.reason);
    assert.equal(reasons.includes('next_page_not_queued'), false, '别把「读不到」说成「走岔了」');
    assert.ok(reasons.includes('route_unavailable'), `实际：${JSON.stringify(cs.gaps)}`);
    assert.match(cs.gaps.find((g) => g.reason === 'route_unavailable').detail ?? '', /没有用过|下线|拦/);
    assert.equal(cs.advanced, false, '读不到就绝不许推进水位线');
  });

  test('真的被打断（还有活没干完）仍然记 aborted', async () => {
    const { runner } = harness(broadcastOnly([bcPage(20, 0), bcPage(20, 20)]), { batchSize: 1 });
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.runBatch();
    await runner.runBatch();

    const m = await runner.finish('aborted');
    const cs = m.crawl_state.find((r) => r.route_key === 'broadcast.timeline');
    assert.equal(cs.gaps[0].reason, 'aborted');
  });
});

describe('增量：下界真的省下了重抓', () => {
  /**
   * 这是整件事的验收条件。水位线一直算得出来、也写进了 manifest，但**没有代码把它
   * 读回来当下界**——于是每次都是全量。这几条测试守住「读回来了」。
   *
   * 判错的方向必须是**多抓**：少抓漏掉的东西事后无从发现。
   */

  /** 广播页：时间逐页递减，一直有下一页。 */
  function page(pageNo, n = 20) {
    let items = '';
    for (let i = 0; i < n; i++) {
      const day = 28 - (pageNo - 1) * 2 - (i % 2);
      items += `<div class="status-item" data-sid="${pageNo * 100 + i}" data-uid="82160871">`
        + `<span class="created_at" title="2026-07-${String(day).padStart(2, '0')} `
        + `${String(20 - (i % 10)).padStart(2, '0')}:00:00">x</span></div>`;
    }
    return `<html><head><title>\n我的动态\n</title></head><body>${NAV}
<div id="db-usr-profile"></div><div class="stream-items">${items}</div></body></html>`;
  }

  test('下界之下的页面不再抓', async () => {
    const seen = [];
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (!url.includes('statuses')) return bcPage(0);
      seen.push(url);
      const p = Number(/[?&]p=(\d+)/.exec(url)?.[1] ?? 1);
      return page(p);
    }, { batchSize: 50 });

    // 下界定在第 2 页那一带：第 3 页往后就该停
    await runner.start({
      username: 'example', mediums: [], includeCatalog: false,
      floors: new Map([['broadcast.timeline', '2026-07-25T00:00:00+08:00']]),
    });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;

    const pages = seen.map((u) => Number(/[?&]p=(\d+)/.exec(u)?.[1] ?? 1));
    assert.ok(pages.length > 0);
    assert.ok(pages.length < 10, `到了下界还在往下翻：抓了 ${pages.length} 页`);
  });

  test('链上抓过的作品详情页不再抓一遍', async () => {
    // 那条路线占真实档案九成体积，而「增量」对它不成立（没有时间序）。所以做法是
    // 只抓这次列表里**新出现的**作品。
    const seen = [];
    const listPage = `<html><head><title>我看过的影视(2)</title></head><body>${NAV}
<div id="db-usr-profile"></div><h1>我看过的影视(2)</h1><div class="grid-view">
<div class="item"><a href="https://movie.douban.com/subject/1001/">甲</a>
<span class="date">2025-01-01</span></div>
<div class="item"><a href="https://movie.douban.com/subject/1002/">乙</a>
<span class="date">2024-01-01</span></div>
</div></body></html>`;
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (url.includes('statuses')) return bcPage(0);
      if (url.includes('/subject/')) { seen.push(url); return `<html><body>${NAV}<div id="mainpic"></div><div id="info"></div></body></html>`; }
      return listPage;
    }, { batchSize: 50 });

    await runner.start({
      username: 'example', mediums: ['movie'], includeCatalog: true, bypassGates: true,
      knownSubjectUrlKeys: ['https://movie.douban.com/subject/1001/'],
    });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;

    assert.equal(seen.some((u) => u.includes('/1001/')), false, '已经抓过的不该再抓');
    assert.ok(seen.some((u) => u.includes('/1002/')), '新出现的必须抓');
  });

  test('「重抓作品详情页」要把已知的直接排进队 —— 不能指望从列表页派生', async () => {
    // 作品详情页由列表页上的链接派生，而**增量模式下列表页只抓到下界为止**。
    // 只是「不跳过已有的」的话，能重抓的只有最新那几页上的十几个，而这个选项
    // 承诺的是全部。说到做不到比没有这个选项更糟。
    const seen = [];
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (url.includes('statuses')) return bcPage(0);
      if (url.includes('/subject/')) { seen.push(url); return `<html><body>${NAV}<div id="mainpic"></div><div id="info"></div></body></html>`; }
      // 列表页这次一条新的都没有（增量的常态）
      return `<html><head><title>我看过的影视(0)</title></head><body>${NAV}
<div id="db-usr-profile"></div><h1>我看过的影视(0)</h1><div class="grid-view"></div></body></html>`;
    }, { batchSize: 50 });

    await runner.start({
      username: 'example', mediums: ['movie'], includeCatalog: true, bypassGates: true,
      refreshSubjectUrls: [
        'https://movie.douban.com/subject/1001/',
        'https://movie.douban.com/subject/1002/',
      ],
    });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;

    assert.ok(seen.some((u) => u.includes('/1001/')), '列表页派生不出来的那些也要抓');
    assert.ok(seen.some((u) => u.includes('/1002/')));
  });

  test('重抓的作品详情页仍然受门控 —— 不能拿最不可替代的换最可替代的', async () => {
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      return bcPage(0);
    }, { batchSize: 1 });
    await runner.start({
      username: 'example', mediums: [], includeCatalog: true,
      refreshSubjectUrls: ['https://movie.douban.com/subject/1001/'],
    });
    const it = runner._run.frontier.snapshot().find((x) => x.routeKey === 'interest.item');
    assert.ok(it, '该排进队了');
    assert.equal(it.gatedBy, 'broadcast.timeline', '还是要等广播抓完');
  });

  test('不传就照旧全抓 —— 「重抓作品详情页」那个选项靠的就是这个', async () => {
    const seen = [];
    const listPage = `<html><head><title>我看过的影视(1)</title></head><body>${NAV}
<div id="db-usr-profile"></div><h1>我看过的影视(1)</h1><div class="grid-view">
<div class="item"><a href="https://movie.douban.com/subject/1001/">甲</a>
<span class="date">2025-01-01</span></div>
</div></body></html>`;
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (url.includes('statuses')) return bcPage(0);
      if (url.includes('/subject/')) { seen.push(url); return `<html><body>${NAV}<div id="mainpic"></div><div id="info"></div></body></html>`; }
      return listPage;
    }, { batchSize: 50 });

    await runner.start({
      username: 'example', mediums: ['movie'], includeCatalog: true, bypassGates: true,
    });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;
    assert.ok(seen.some((u) => u.includes('/1001/')));
  });

  /**
   * 一页广播，带一张本人上传的图。
   *
   * 这一页就是这次改动的现场：增量**必须**重读最新那几页广播（不然发现不了新
   * 条目），于是页面上的图每趟都被重新派生一遍。
   */
  const bcWithPhoto = (photoUrl) => `<html><head><title>\n我的动态\n</title></head><body>${NAV}
<div id="db-usr-profile"><div class="info"><h1>示例</h1></div></div>
<div class="stream-items">
<div class="status-item" data-sid="1" data-uid="82160871">
  <span class="created_at" title="2026-07-20 10:00:00">x</span></div>
<div class="new-status status-wrapper" data-uid="82160871">
  <div class="pics-wrapper"><script>var photos = [{"image":{"raw":{"url":"${photoUrl}"}}}];</script></div>
</div>
</div></body></html>`;

  const PHOTO = 'https://img1.doubanio.com/view/status/raw/public/p742324445.jpg';

  /**
   * 一页日记列表，上面挂着一篇。
   *
   * **结构照 `classifier.js` 里 `note.list` 的锚点写**——`note-item` / `note-title` /
   * `note-date` 一个都不能少。少一个，正文页根本不会被派生出来，于是「跳过了」这条
   * 判据就在**没有东西可跳**的情况下绿掉。这份 fixture 的第一版正是这样：反向验证
   * （把 markCaptured 那行关掉）时测试照样绿，才发现它一直什么都没测。
   */
  const notesWith = (noteUrl) => `<html><head><title>我的日记</title></head><body>${NAV}
<div id="db-usr-profile"></div><h1>我的日记</h1>
<div class="note-list"><div class="note-item">
<div class="note-title"><a href="${noteUrl}">一篇</a></div>
<span class="note-date">2026-07-01 10:00:00</span>
</div></div></body></html>`;

  test('**已经抓到的图不再抓一遍** —— 图片地址是内容地址，重抓拿回来的是同一批字节', async () => {
    // 这是真踩到的：一次增量重抓了 11 张已有的图（0.77 MB），其中 3 张已经被抓过
    // 三遍。作品详情页有跳过名单，图没有——而图恰恰是**派生**出来的，派生这条路
    // 上从来没有过「我是不是已经有了」这道判断。
    const seen = [];
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (url.includes('.jpg')) { seen.push(url); return 'JPEGBYTES'; }
      return bcWithPhoto(PHOTO);
    }, { batchSize: 50 });

    await runner.start({
      username: 'example', mediums: [], includeCatalog: false, bypassGates: true,
      knownAssetUrlKeys: [PHOTO],
    });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;

    assert.deepEqual(seen, [], '这张图档案里已经有了，不该再抓');
  });

  test('不传跳过名单就照抓 —— 反面判据，免得上一条永远绿', async () => {
    // 上一条只断言「没抓」。抽取器要是根本没认出这张图，它也会绿——而那时真正的
    // 结论是「测试没测到东西」。所以同一页、同一个 harness，再跑一次不带名单的。
    const seen = [];
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (url.includes('.jpg')) { seen.push(url); return 'JPEGBYTES'; }
      return bcWithPhoto(PHOTO);
    }, { batchSize: 50 });

    await runner.start({
      username: 'example', mediums: [], includeCatalog: false, bypassGates: true,
    });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;

    assert.deepEqual(seen, [PHOTO], '不给名单就该老老实实抓一遍');
  });

  test('**跳过名单不许把存量补抓也一起挡掉**', async () => {
    // 补抓算的正是「档案里欠着的那些图」，所以它给出的 URL 按定义就不在名单里。
    // 但两者都走 frontier，顺序也挨着——把名单写宽一点（比如连失败的行也收进去、
    // 或者干脆按路线名整条挡掉），补抓就会一声不吭地停摆。而补抓停摆是这套设计里
    // 最贵的静默失败：它是「抽取器的 bug 可以事后修复」这句话的**唯一**兑现方式。
    const seen = [];
    const OLD = 'https://img9.doubanio.com/view/status/raw/public/p000001.jpg';
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (url.includes('.jpg')) { seen.push(url); return 'JPEGBYTES'; }
      return bcWithPhoto(PHOTO);
    }, { batchSize: 50 });

    await runner.start({
      username: 'example', mediums: [], includeCatalog: false, bypassGates: true,
      // 这一张页面上那张，已经有了
      knownAssetUrlKeys: [PHOTO],
      // 这一张是从旧档案里已经存下来的页面上算出来的，还欠着
      backlogAssets: [{
        url: OLD,
        routeKey: 'asset.status_photo',
        parentCaptureId: '20260801T005010Z-3eef52#000046',
        referer: 'https://www.douban.com/people/example/statuses',
      }],
    });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;

    assert.deepEqual(seen, [OLD], '欠着的那张要补，已经有的那张不该重抓');
  });

  test('**长文正文默认跳过，因为增量假定什么都没变**', async () => {
    const seen = [];
    const NOTE = 'https://www.douban.com/note/872015292/';
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (url.includes('/note/')) { seen.push(url); return `<html><body>${NAV}<div id="link-report"></div></body></html>`; }
      if (url.includes('/notes')) return notesWith(NOTE);
      return bcPage(0);
    }, { batchSize: 50 });

    await runner.start({
      username: 'example', mediums: [], includeCatalog: false, bypassGates: true,
      knownLongformUrlKeys: [NOTE],
    });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;

    assert.deepEqual(seen, [], '这一篇抓过了，增量下不该再抓');
  });

  test('不传就照旧抓 —— 反面判据，证明这一篇本来是派生得出来的', async () => {
    // 没有这一条，上面那条在「列表页压根没派生出正文页」时也会绿——而那正是它的
    // 第一版发生的事。
    const seen = [];
    const NOTE = 'https://www.douban.com/note/872015292/';
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (url.includes('/note/')) { seen.push(url); return `<html><body>${NAV}<div id="link-report"></div></body></html>`; }
      if (url.includes('/notes')) return notesWith(NOTE);
      return bcPage(0);
    }, { batchSize: 50 });

    await runner.start({
      username: 'example', mediums: [], includeCatalog: false, bypassGates: true,
    });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;

    assert.deepEqual(seen, [NOTE], '不给名单就该照旧抓正文页');
  });

  test('「重抓可以编辑的内容」要把长文**直接排进队** —— 列表只抓到下界为止', async () => {
    // 与作品详情页同一个理由：日记正文由列表派生，而增量下列表只抓到下界为止，
    // 能派生出来的只有最近写的那几篇。只做「不跳过已有的」，这个选项就只重抓了
    // 几篇，而界面上写的是全部。**说到做不到比没有这个选项更糟。**
    const seen = [];
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (url.includes('/note/') || url.includes('/topic/') || url.includes('/review/')) {
        seen.push(url);
        return `<html><body>${NAV}<div id="link-report"></div></body></html>`;
      }
      return bcPage(0);
    }, { batchSize: 50 });

    await runner.start({
      username: 'example', mediums: [], includeCatalog: false, bypassGates: true,
      refreshLongform: [
        { url: 'https://www.douban.com/note/872015292/', routeKey: 'note.item' },
        // **`/topic/` 形状的也是日记。** 实测一个真实账号 3 篇日记里就有一篇是它。
        { url: 'https://www.douban.com/topic/496284296/', routeKey: 'note.item' },
        { url: 'https://www.douban.com/review/8381069/', routeKey: 'review.item' },
      ],
    });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;

    assert.equal(seen.length, 3, '三篇都该重抓，一篇都不许靠列表派生');
  });

  test('重抓的长文排回**索引行里写的**那条路线，不按 URL 形状猜', async () => {
    // `/topic/` 形状的日记按形状猜会被排进 review.item——判定描述、优先级、门控
    // 全不一样，而且不报错。所以 routeKey 是跟着 URL 一起传进来的。
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      return bcPage(0);
    }, { batchSize: 1 });
    await runner.start({
      username: 'example', mediums: [], includeCatalog: false,
      refreshLongform: [
        { url: 'https://www.douban.com/topic/496284296/', routeKey: 'note.item' },
        { url: 'https://www.douban.com/review/8381069/', routeKey: 'review.item' },
      ],
    });
    const q = runner._run.frontier.snapshot();
    const byUrl = Object.fromEntries(q.map((x) => [x.url, x.routeKey]));
    assert.equal(byUrl['https://www.douban.com/topic/496284296/'], 'note.item');
    assert.equal(byUrl['https://www.douban.com/review/8381069/'], 'review.item');
  });

  test('这次不抓的路线，重抓名单里的也不排 —— 排了也没有判定描述', async () => {
    // `onlyRoutes` 裁掉了长文那条路线时，硬排进去的条目没有对应的路线定义，
    // 抓回来无从判定。与存量补抓同一条兜底。
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      return bcPage(0);
    }, { batchSize: 1 });
    await runner.start({
      username: 'example', mediums: [], includeCatalog: false,
      onlyRoutes: ['broadcast.timeline'],
      refreshLongform: [{ url: 'https://www.douban.com/note/1/', routeKey: 'note.item' }],
    });
    const q = runner._run.frontier.snapshot();
    assert.equal(q.some((x) => x.routeKey === 'note.item'), false);
  });

  test('没有下界时照旧全量 —— 判错的方向必须是多抓', async () => {
    const seen = [];
    const { runner } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (!url.includes('statuses')) return bcPage(0);
      seen.push(url);
      const p = Number(/[?&]p=(\d+)/.exec(url)?.[1] ?? 1);
      return p <= 6 ? page(p) : bcPage(0);
    }, { batchSize: 50 });

    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    for (let i = 0; i < 30; i++) if ((await runner.runBatch()).done) break;
    assert.ok(seen.length >= 6, `没有下界就该一直抓到底，实际只抓了 ${seen.length} 页`);
  });

  test('下界写进 manifest，并记下它取自哪一份', async () => {
    // 规范 §5.5.1：不能用顶层的 previous_bundle_id 代替——下界是按路线选的。
    const { runner } = harness(broadcastOnly([bcPage(20, 0), bcPage(0)]), { batchSize: 50 });
    await runner.start({
      username: 'example', mediums: [], includeCatalog: false,
      floors: new Map([['broadcast.timeline', '2026-07-01T00:00:00+08:00']]),
      floorSources: new Map([['broadcast.timeline', '20260701T000000Z-aaaaaa']]),
    });
    for (let i = 0; i < 10; i++) if ((await runner.runBatch()).done) break;

    const m = await runner.finish('aborted');
    const cs = m.crawl_state.find((r) => r.route_key === 'broadcast.timeline');
    assert.equal(cs.floor_time, '2026-07-01T00:00:00+08:00');
    assert.equal(cs.floor_from_bundle_id, '20260701T000000Z-aaaaaa');
  });

  test('下界在**身份确认之后**才挑 —— 判据是数字 uid', async () => {
    // 顺序是必须的：账号是档案的归属主键，而它只有 preflight 之后才知道。
    // 用用户名代替不行（会改），而「别人的档案当了我的基准」判错的方向是漏抓。
    let sawAccount = null;
    const { runner } = harness(broadcastOnly([bcPage(0)]), { batchSize: 5 });
    await runner.start({
      username: 'example', mediums: [], includeCatalog: false,
      resolveFloors: async (account) => {
        sawAccount = account;
        return {};
      },
    });
    assert.ok(sawAccount?.userId, `回调没拿到账号：${JSON.stringify(sawAccount)}`);
    assert.equal(sawAccount.userId, '82160871');
  });

  test('显式给了 floors（小范围试跑）就不再回调', async () => {
    let called = false;
    const { runner } = harness(broadcastOnly([bcPage(0)]), { batchSize: 5 });
    await runner.start({
      username: 'example', mediums: [], includeCatalog: false,
      floors: new Map([['broadcast.timeline', '2026-07-01T00:00:00+08:00']]),
      resolveFloors: async () => { called = true; return {}; },
    });
    assert.equal(called, false, '调试用的下界被增量覆盖了');
  });

  test('挑下界失败 → 退回全量，不让一次抓取因此开不了工', async () => {
    const seen = [];
    const { runner, events } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (!url.includes('statuses')) return bcPage(0);
      seen.push(url);
      const p = Number(/[?&]p=(\d+)/.exec(url)?.[1] ?? 1);
      return p <= 3 ? page(p) : bcPage(0);
    }, { batchSize: 50 });

    await runner.start({
      username: 'example', mediums: [], includeCatalog: false,
      resolveFloors: async () => { throw new Error('OPFS 读不了'); },
    });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;

    assert.ok(seen.length >= 3, '挑下界失败之后没有退回全量');
    assert.ok(events.some((e) => e.type === 'incremental_failed'), '失败要说出来，不能静默');
  });
});

describe('静默退化要被报出来 —— 书就是这么坏了很久的', () => {
  /**
   * 「抽得到条目、抽不到时间」是最隐蔽的一类坏法：翻页照常、连续性照常
   * ✔ 已验证、界面上什么都不异常——只有「已回溯到」是空的。而后果是
   * `high_water_time` 永远 null、`advanced` 永远 false，**这条线永远不能增量**。
   *
   * 书的列表页日期后面跟着「读过」两个字，而模式要求日期紧接着 `<`，于是三条书的
   * 路线一条时间都抽不到。坏了很久，没有任何地方报过。
   */

  /** 有条目链接、但**一个日期都没有**的列表页。 */
  const noDates = (nav) => `<html><head><title>我看过的影视(2)</title></head><body>${nav}
<div id="db-usr-profile"></div><h1>我看过的影视(2)</h1><div class="grid-view">
<div class="item"><a href="https://movie.douban.com/subject/1001/">甲</a></div>
<div class="item"><a href="https://movie.douban.com/subject/1002/">乙</a></div>
</div></body></html>`;

  function crawlWithoutDates() {
    return harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (url.includes('statuses')) return bcPage(0);
      if (url.includes('/subject/')) return `<html><body>${NAV}<div id="mainpic"></div><div id="info"></div></body></html>`;
      return noDates(NAV);
    }, { batchSize: 50 });
  }

  test('抓到条目却一个时间都没有 → RouteState 记下来', async () => {
    const { runner } = crawlWithoutDates();
    await runner.start({ username: 'example', mediums: ['movie'], includeCatalog: false });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;

    const st = runner._run.loop.routeStates.get('interest.movie.collect');
    assert.ok(st, '该有这条路线的状态');
    assert.ok(st.timeExtractionFailed, '抽不到时间这件事没被记下来');
  });

  test('收尾时报 no_watermark —— 说清「下次仍然只能全量重走」', async () => {
    const { runner, events } = crawlWithoutDates();
    await runner.start({ username: 'example', mediums: ['movie'], includeCatalog: false });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;
    await runner.finish('aborted');

    const e = events.find((x) => x.type === 'no_watermark' && x.routeKey === 'interest.movie.collect');
    assert.ok(e, `没有报出来。收到的事件类型：${[...new Set(events.map((x) => x.type))]}`);
    assert.match(e.message, /全量/, '要说清后果');
  });

  test('本来就没有时间概念的路线**不报** —— 那是设计如此，不是坏了', async () => {
    const { runner, events } = crawlWithoutDates();
    await runner.start({ username: 'example', mediums: ['movie'], includeCatalog: false });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;
    await runner.finish('aborted');

    for (const key of ['profile.overview', 'profile.category_entry.movie']) {
      assert.equal(
        events.some((x) => x.type === 'no_watermark' && x.routeKey === key), false,
        `${key} 压根没有时间概念，不该报`,
      );
    }
  });

  test('时间抽得到就不报', async () => {
    const withDates = (nav) => `<html><head><title>我看过的影视(2)</title></head><body>${nav}
<div id="db-usr-profile"></div><h1>我看过的影视(2)</h1><div class="grid-view">
<div class="item"><a href="https://movie.douban.com/subject/1001/">甲</a>
<span class="date">2025-01-01</span></div>
</div></body></html>`;
    const { runner, events } = harness((url) => {
      if (url.endsWith('/people/example/')) return PROFILE;
      if (url.includes('statuses')) return bcPage(0);
      if (url.includes('/subject/')) return `<html><body>${NAV}<div id="mainpic"></div><div id="info"></div></body></html>`;
      return withDates(NAV);
    }, { batchSize: 50 });

    await runner.start({ username: 'example', mediums: ['movie'], includeCatalog: false });
    for (let i = 0; i < 20; i++) if ((await runner.runBatch()).done) break;
    await runner.finish('aborted');

    assert.equal(
      events.some((x) => x.type === 'no_watermark' && x.routeKey === 'interest.movie.collect'),
      false,
    );
  });
});

describe('中止：让一次抓取到此为止，并且能删掉', () => {
  /**
   * 暂停是「等会儿接着抓」——档案还在写、指针还指着它，所以**删不掉**。
   * 存储页原来那句「先暂停或等它结束」是句错话：暂停之后它依旧删不掉。
   *
   * 中止是「这次到此为止」：收尾成 aborted、放开指针，之后它就是一份普通的
   * 已收尾档案。
   */

  async function halfCrawled() {
    const { runner, runStore } = harness(
      broadcastOnly([bcPage(20, 0), bcPage(20, 20), bcPage(20, 40)]), { batchSize: 1 },
    );
    await runner.start({ username: 'example', mediums: [], includeCatalog: false });
    await runner.runBatch();
    await runner.runBatch();
    return { runner, runStore };
  }

  test('中止之后写出 manifest，状态是 aborted', async () => {
    const { runner } = await halfCrawled();
    const m = await runner.abort();
    assert.equal(m.status, 'aborted');
    assert.equal(runner.active, false, '不再是「进行中的抓取」');
  });

  test('已经抓到的都留在档案里 —— 不可逆的是这次抓取，不是数据', async () => {
    const { runner } = await halfCrawled();
    const m = await runner.abort();
    const total = m.segments.reduce((n, s) => n + s.record_count, 0);
    assert.ok(total > 0, '抓到的记录必须还在');
    assert.equal(m.index.line_count, total);
  });

  test('缺口如实记着 —— 中止不是「跑完了」', async () => {
    const { runner } = await halfCrawled();
    const m = await runner.abort();
    const bc = m.crawl_state.find((r) => r.route_key === 'broadcast.timeline');
    assert.ok(bc.gaps.length > 0, '半途中止就该有缺口');
    assert.equal(bc.advanced, false, '绝不许推进水位线');
  });

  test('**放开指针** —— 于是这份档案可以删了', async () => {
    const { runner, runStore } = await halfCrawled();
    assert.ok(await runStore.getCurrentRun(), '中止前它是「正在抓的那份」');
    await runner.abort();
    assert.equal(await runStore.getCurrentRun(), undefined, '中止后不该再有当前抓取');
  });

  test('checkpoint.json **留在档案里** —— 规范 §3.1 要求 aborted 必须带', async () => {
    // 那样一份半成品搬到另一台机器上还能接着抓。清掉的只是我们自己的指针。
    const { runner, runStore } = await halfCrawled();
    const dir = (await runStore.getCurrentRun()).dir;
    await runner.abort();
    const store = await runner._openBundle(dir);
    assert.equal(await store.exists('checkpoint.json'), true);
  });

  test('没有进行中的抓取时中止会报错，不是静默成功', async () => {
    const { runner } = harness(broadcastOnly([bcPage(0)]));
    await assert.rejects(() => runner.abort(), /没有进行中的抓取/);
  });
});

describe('中止之后的档案能删 —— 这是中止的全部意义', () => {
  test('summarizeBundles 里它不再是 active', () => {
    // `deletable` 只看「是不是正在抓的那份」。中止放开了指针，于是
    // `activeBundleId` 不再是它。
    const dirs = [{ bundleId: 'B1', dir: 'doubak-bundle-B1', files: [{ name: 'manifest.json', bytes: 10 }] }];
    const before = summarizeBundles({ dirs, activeBundleId: 'B1' });
    assert.equal(before[0].deletable, false);
    assert.match(before[0].blockedReason, /中止/, '要告诉用户怎么才能删');

    const after = summarizeBundles({ dirs, activeBundleId: null });
    assert.equal(after[0].deletable, true);
  });

  test('没收尾的档案（没有 manifest）照样能删', () => {
    // 中止会写 manifest，但历史遗留的半成品可能没有。它们也该能删掉。
    const dirs = [{ bundleId: 'B1', dir: 'doubak-bundle-B1', files: [{ name: 'index-B1.ndjson', bytes: 10 }] }];
    const u = summarizeBundles({ dirs, activeBundleId: null })[0];
    assert.equal(u.hasManifest, false);
    assert.equal(u.deletable, true, '半成品也是用户的档案，该能删');
  });

  test('不能只说「先暂停」—— 暂停之后它依旧删不掉', () => {
    const dirs = [{ bundleId: 'B1', dir: 'd', files: [] }];
    const reason = summarizeBundles({ dirs, activeBundleId: 'B1' })[0].blockedReason;
    assert.equal(/^这份正在抓，先暂停或等它结束$/.test(reason), false);
  });
});

describe('「重抓作品详情页」排进来的条目没有 parent', () => {
  /**
   * 那些 URL 来自**旧档案的索引**，不是从这一次的任何一张页面上派生出来的。所以
   * 它们的 `parent_capture_id` 事实上就是 null。
   *
   * 而 loop 的兜底是 `item.enqueuedBy ?? this._lastCapture.get(routeKey) ?? null`
   * ——不显式传的话，parent 会落到**同路线上刚抓完的那一条**，也就是另一个作品详情页。
   *
   * 实测：一份真实档案里 2925 条作品详情页，**2921 条的 parent 指向另一条作品详情页**，
   * 串成一条毫无意义的链。而 parent 存在的理由是「整张抓取图可以离线重建，连续性证明
   * 因而可被第三方独立验证」（规范 §6.2）——**一条伪造的边比没有边更糟**：没有边只是
   * 缺信息，伪造的边会让重建出来的图是错的。
   */
  test('parent 必须是 null，不许串成链', async () => {
    const src = readFileSync(new URL('../src/crawl/runner.js', import.meta.url), 'utf-8');
    const block = src.slice(src.indexOf('if (refreshSubjectUrls?.length)'));
    assert.match(block.slice(0, 1400), /enqueuedBy: null/);
  });

  test('**翻页仍然要走兜底** —— 第 2 页确实是第 1 页派生的', async () => {
    // 修法不能是「一律不兜底」：那会把翻页的 parent 也抹成 null，而那条边是真的。
    // 判据是 `enqueuedBy === null`（显式说没有）与 undefined（没传）的区别。
    const src = readFileSync(new URL('../src/crawl/loop.js', import.meta.url), 'utf-8');
    assert.match(src, /item\.enqueuedBy === null/);
    assert.match(src, /this\._lastCapture\.get\(item\.routeKey\)/);
  });
});
