import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CrawlRunner, seedFrontier, DEFAULT_BATCH_SIZE } from '../src/crawl/runner.js';
import { RunStore } from '../src/crawl/run-store.js';
import { MemoryKvStore } from '../src/storage/kv-store.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { Frontier } from '../src/crawl/frontier.js';
import { buildRoutes } from '../src/crawl/routes.js';
import { indexFilename } from '../src/core/ids.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const NAV = `<li class="nav-user-account"><a href="/accounts/logout">退出</a>
<span>示例的账号</span></li><a href="https://www.douban.com/people/example/">主页</a>`;

/** 个人主页：必须能取到数字用户 ID。 */
const PROFILE = `<html><head><title>示例的账号</title></head><body>${NAV}
<div class="status-item" data-sid="1" data-uid="82160871">x</div></body></html>`;

function bcPage(n, from = 0) {
  let items = '';
  for (let i = 0; i < n; i++) {
    items += `<div class="status-item" data-sid="${from + i}" data-uid="82160871">
      <span class="created_at" title="2026-07-2${i % 9} 1${i % 9}:00:00">x</span></div>`;
  }
  return `<html><head><title>\n示例的广播\n</title></head><body>${NAV}${items}</body></html>`;
}

const LOGIN = `<html><head><title>\n登录豆瓣\n</title></head><body>验证码</body></html>`;

/**
 * @param {(url: string, n: number) => string} respond  按 URL 与调用序号给页面
 */
function harness(respond, { batchSize = 5 } = {}) {
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
    // 测试里不要真的按 1 秒节奏等——真实抓取必须用默认值
    pacerOptions: { intervalMs: 1, jitterRatio: 0 },
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
    assert.ok(bc.highWater, '要有「已回溯到」这个信息');
    assert.match(bc.highWater, /\+08:00$/);
    assert.ok(!('percent' in bc), '不提供百分比');
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

describe('个人主页没有数字 uid 时的退路', () => {
  /** 一张登录态正常、但**没有任何 uid 线索**的主页。 */
  const NO_UID = `<html><head><title>示例的账号</title></head><body>
<li class="nav-user-account"><a href="/accounts/logout">退出</a><span>示例的账号</span></li>
<a href="https://www.douban.com/people/example/">主页</a>
</body></html>`;

  test('退到广播页取 uid，抓取照样开得起来', async () => {
    // 个人主页上不一定有广播条目，而 data-uid 最常见的落脚处正是广播条目。
    // 真实旧档案里 7353 个广播列表页全都带 data-uid，所以那一页是可靠的退路。
    const { runner, calls, events } = harness((url) =>
      url.includes('statuses') ? bcPage(20) : NO_UID);

    const r = await runner.start({ username: 'example', includeCatalog: false });

    assert.equal(r.account.userId, '82160871');
    assert.ok(calls.some((u) => u.includes('statuses')), '该去广播页补一次');
    assert.ok(events.some((e) => e.type === 'uid_fallback'), '走了退路要留痕');
  });

  test('两处都没有才失败，且报错里说了两处都试过', async () => {
    // **不放松要求**：uid 是档案的归属主键，取不到就不能开始。退路只是多试一处，
    // 不是降低标准。
    const { runner } = harness(() => NO_UID);
    await assert.rejects(() => runner.start({ username: 'example', includeCatalog: false }), (e) => {
      assert.equal(e.reason, 'missing_user_id');
      assert.match(e.message, /此前还试过/);
      return true;
    });
  });

  test('主页上有 uid 时不发那次多余的请求', async () => {
    // 退路只在必要时走——每个请求都算账。
    const { runner, calls } = harness(() => PROFILE);
    await runner.start({ username: 'example', includeCatalog: false });
    assert.equal(calls.filter((u) => u.includes('statuses')).length, 0);
  });
});
