import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CrawlRunner, seedFrontier, DEFAULT_BATCH_SIZE } from '../src/crawl/runner.js';
import { RunStore } from '../src/crawl/run-store.js';
import { MemoryKvStore } from '../src/storage/kv-store.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { Frontier } from '../src/crawl/frontier.js';
import { CRASH_SENTINEL_REASON } from '../src/crawl/resume-policy.js';
import { buildRoutes, PRIORITY } from '../src/crawl/routes.js';
import { indexFilename } from '../src/core/ids.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// `_GLOBAL_NAV.USER_ID` 是数字 uid 的唯一来源——不是广播条目的 `data-uid`
// （那在作品详情页上是评论者的 ID）。见 src/crawl/session.js。
const NAV = `<li class="nav-user-account"><a href="/accounts/logout">退出</a>
<span>示例的账号</span></li><a href="https://www.douban.com/people/example/">主页</a>
<script>;window._GLOBAL_NAV = { USER_ID: "82160871" };</script>`;

/** 个人主页：必须能取到数字用户 ID。 */
const PROFILE = `<html><head><title>示例的账号</title></head><body>${NAV}
<div class="status-item" data-sid="1" data-uid="82160871">x</div></body></html>`;

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
    const body = enc.encode(respond(url, n++));
    return {
      status: 200,
      url,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };

  const runner = new CrawlRunner({
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
