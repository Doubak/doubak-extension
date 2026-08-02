/**
 * 崩溃恢复丢派生：捕获每页落盘，checkpoint 每批才落。
 *
 * 中间那个窗口里，一张已经抓到的页面已经进了 index，而它**派生出来的活**——
 * 下一页链接、列表页上的作品链接、作品页上的封面图——只活在内存队列里。worker
 * 被杀，那些派生条目就没了；而恢复时 index 会把这张页面标成「抓过了」，于是它
 * 不会被重取，派生也就永远不会再发生。
 *
 * **没有任何地方记下这件事。** 覆盖率上只是一个偏小的数字——正是这个项目最怕的
 * 那种：永久且不可检测。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { replayableCaptures, derivesWork, MAX_REPLAY } from '../src/crawl/replay.js';
import { CrawlRunner } from '../src/crawl/runner.js';
import { RunStore } from '../src/crawl/run-store.js';
import { MemoryKvStore } from '../src/storage/kv-store.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { indexFilename } from '../src/core/ids.js';
import { Frontier } from '../src/crawl/frontier.js';
import { buildCheckpoint } from '../src/crawl/run-store.js';
import { Pacer } from '../src/crawl/pacing.js';
import { readFileSync } from 'node:fs';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('哪些捕获值得重抓', () => {
  const routes = new Map([
    ['broadcast.timeline', { key: 'broadcast.timeline', pagination: { kind: 'page' } }],
    ['interest.movie.collect', { key: 'interest.movie.collect', pagination: { kind: 'start' } }],
    ['interest.item', { key: 'interest.item' }],
    ['asset.subject_cover', { key: 'asset.subject_cover' }],
    ['profile.overview', { key: 'profile.overview' }],
  ]);
  const routeOf = (k) => routes.get(k);

  test('会派生的才重抓', () => {
    assert.equal(derivesWork(routes.get('broadcast.timeline')), true, '分页 → 派生下一页');
    assert.equal(derivesWork(routes.get('interest.movie.collect')), true, '列表 → 派生作品链接');
    assert.equal(derivesWork(routes.get('interest.item')), true, '详情页 → 派生封面图');
  });

  test('**不会派生的不重抓** —— 多余的请求是要用账号安全去付的', () => {
    // 重抓一张封面图或一张个人主页不会产出任何新东西。这个项目里，白发的请求
    // 不是「浪费一点带宽」，是往风控上多撞一次。
    assert.equal(derivesWork(routes.get('asset.subject_cover')), false);
    assert.equal(derivesWork(routes.get('profile.overview')), false);
    assert.equal(derivesWork(undefined), false, '认不出的路线不重抓');
  });

  test('只挑 checkpoint 之后写下的那几条', () => {
    const captures = [1, 2, 3, 4, 5].map((seq) => ({
      seq, url: `https://movie.douban.com/subject/${seq}/`,
      urlKey: `k${seq}`, routeKey: 'interest.item', intent: 'interest.item',
    }));
    const r = replayableCaptures({ captures, sinceSeq: 3, routeOf });
    assert.deepEqual(r.items.map((c) => c.urlKey).sort(), ['k4', 'k5']);
  });

  test('checkpoint 见过的一条都不碰', () => {
    const captures = [1, 2, 3].map((seq) => ({
      seq, url: `u${seq}`, urlKey: `k${seq}`, routeKey: 'interest.item', intent: 'x',
    }));
    assert.deepEqual(replayableCaptures({ captures, sinceSeq: 3, routeOf }).items, []);
  });

  test('没有 last_capture_id 时（还没落过 checkpoint）全都算', () => {
    const captures = [{ seq: 1, url: 'u', urlKey: 'k', routeKey: 'interest.item', intent: 'x' }];
    assert.equal(replayableCaptures({ captures, sinceSeq: 0, routeOf }).items.length, 1);
  });

  test('截断有上限，而且**必须报出来**', () => {
    // 连着崩好几次、每次都没活到写 checkpoint 时，待重抓的会堆起来。不限量地
    // 重抓几百页正是撞上风控的样子，而风控的代价是账号。所以截断——但截掉的
    // 那部分派生是真丢了，不能让它变成覆盖率上一个说不清来历的小数字。
    const captures = Array.from({ length: MAX_REPLAY + 25 }, (_, i) => ({
      seq: i + 1, url: `u${i}`, urlKey: `k${i}`, routeKey: 'interest.item', intent: 'x',
    }));
    const r = replayableCaptures({ captures, sinceSeq: 0, routeOf });
    assert.equal(r.items.length, MAX_REPLAY);
    assert.equal(r.truncated, 25);
  });

  test('要截断时留下的是最近的那些', () => {
    // 最近的那批才是被打断的那一批，也就是派生真正丢掉的地方。
    const captures = Array.from({ length: MAX_REPLAY + 10 }, (_, i) => ({
      seq: i + 1, url: `u${i}`, urlKey: `k${i}`, routeKey: 'interest.item', intent: 'x',
    }));
    const keys = new Set(replayableCaptures({ captures, sinceSeq: 0, routeOf }).items.map((c) => c.urlKey));
    assert.ok(keys.has(`k${MAX_REPLAY + 9}`), '最新的那条必须在');
    assert.ok(!keys.has('k0'), '最旧的那条应当被截掉');
  });

  test('空输入不炸', () => {
    assert.deepEqual(replayableCaptures({ captures: [], sinceSeq: 0, routeOf }).items, []);
    assert.deepEqual(replayableCaptures({ captures: undefined, sinceSeq: 0, routeOf }).items, []);
  });
});

// ── 端到端：真的杀一次，看图还在不在 ──────────────────────────────────

const NAV = `<li class="nav-user-account"><a href="/accounts/logout">退出</a>
<span>示例的账号</span></li><a href="https://www.douban.com/people/example/">主页</a>
<script>;window._GLOBAL_NAV = { USER_ID: "82160871" };</script>`;

const PROFILE = `<html><head><title>示例的账号</title></head><body>${NAV}
<div id="db-usr-profile"><div class="info"><h1>示例</h1></div></div></body></html>`;

const SUBJECT_IDS = [1, 2, 3, 4, 5, 6];

function dramaList() {
  const items = SUBJECT_IDS.map(
    (i) => `<div class="item"><a href="https://www.douban.com/location/drama/${i}/">剧 ${i}</a>
      <span class="date">2026-07-2${i}</span></div>`,
  ).join('');
  return `<html><head><title>示例 看过的舞台剧</title></head><body>${NAV}
<div id="db-usr-profile"><div class="info"><h1>示例</h1></div></div>
<div id="content"><h1>示例看过的舞台剧(6)</h1>${items}</div></body></html>`;
}

function subjectPage(i) {
  return `<html><head><title>剧 ${i} (豆瓣)</title></head><body>${NAV}
<div id="wrapper"><div id="content"><h1>剧 ${i}</h1>
<div class="pic"><img src="https://img1.doubanio.com/pview/drama_subject_poster/m/public/p${i}.jpg"></div>
<div class="drama-info"></div></div></div></body></html>`;
}

function pageFor(url) {
  if (url.endsWith('/people/example/')) return PROFILE;
  const m = /\/drama\/(\d+)\//.exec(url);
  if (m) return subjectPage(m[1]);
  return dramaList();
}

function harness(batchSize, { imageStatus = 200 } = {}) {
  const kv = new MemoryKvStore();
  /** @type {Map<string, MemoryFileStore>} */
  const dirs = new Map();
  const openBundle = async (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, new MemoryFileStore());
    return dirs.get(dir);
  };
  const runStore = new RunStore({ kv, openBundle });
  const events = [];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const isImage = url.includes('doubanio.com');
    const body = isImage ? new Uint8Array([0xff, 0xd8, 1, 2, 3]) : enc.encode(pageFor(url));
    return {
      status: isImage ? imageStatus : 200,
      url,
      headers: new Headers({ 'content-type': isImage ? 'image/jpeg' : 'text/html; charset=utf-8' }),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  const runner = new CrawlRunner({
    runStore, openBundle, fetchImpl, batchSize,
    now: () => new Date('2026-08-01T10:15:00Z'),
    pacerOptions: { intervalMs: 1, jitterRatio: 0 },
    onEvent: (e) => events.push(e),
  });
  return { runner, runStore, dirs, events, calls };
}

const SCOPE = {
  username: 'example', mediums: ['drama'], includeCatalog: true,
  onlyRoutes: ['interest.drama.collect', 'interest.item', 'asset.subject_cover'],
  bypassGates: true,
};

async function readIndex(dirs) {
  for (const [dir, store] of dirs) {
    const name = indexFilename(dir.replace('doubak-bundle-', ''));
    if (await store.exists(name)) {
      return dec.decode(await store.read(name)).trimEnd().split('\n').filter(Boolean)
        .map((l) => JSON.parse(l));
    }
  }
  return [];
}

async function drain(runner, max = 20) {
  for (let i = 0; i < max; i++) {
    const { done } = await runner.runBatch();
    if (done) return;
  }
}

describe('checkpoint 必须记下「我见过到哪一条」', () => {
  test('last_capture_id 不能是 null', async () => {
    // 这个字段在 checkpoint 的形状里一直都有，`buildCheckpoint` 也收，但**从来
    // 没人往里填**——于是真实档案里它恒为 null。
    //
    // 单独看没什么后果（没人读它）。可一旦有人开始读，null 的含义是「一条都没
    // 见过」，于是恢复时会把整份 index 都当成「checkpoint 没见过的」，把能派生的
    // 页面统统重抓一遍——几百个多余请求，而多余的请求要用账号安全去付。
    const { runner, runStore } = harness(3);
    await runner.start(SCOPE);
    await runner.runBatch();

    const cp = await runStore.loadCheckpoint();
    assert.ok(cp.last_capture_id, 'checkpoint 没记 last_capture_id');
    assert.match(cp.last_capture_id, /^\d{8}T\d{6}Z-[0-9a-f]{6}#\d{6,}$/);
  });

  test('记的是**写成了**的那条，不是分配到的那个号', async () => {
    // 序号先分配后写盘，所以分配了却没写成是正常的（空洞就是这么来的）。
    // checkpoint 要回答的是「index 里到此为止有什么」，用分配号会多算一条。
    const { runner, runStore, dirs } = harness(3);
    await runner.start(SCOPE);
    await runner.runBatch();

    const cp = await runStore.loadCheckpoint();
    const idx = await readIndex(dirs);
    assert.equal(cp.last_capture_id, idx.at(-1).capture_id);
  });
});

describe('失败的原因必须挺过一次恢复', () => {
  test('checkpoint 存了 last_error，恢复之后还在', () => {
    // 失败条目**恰恰是最需要跨越恢复留存的东西**：它们会一直躺在队列里等人处理，
    // 而人来看它们的时候往往已经隔了一次重启。
    //
    // 真实症状：139 个抓不下来的封面，前 123 个（恢复之前失败的）原因全没了，
    // 界面上那一列整列是「—」，于是「为什么抓不下来」在界面上无解。
    const f = new Frontier();
    f.enqueue({ url: 'https://img1.doubanio.com/x.jpg', urlKey: 'k', routeKey: 'asset.subject_cover', intent: 'i', ordered: false });
    f.settle(f.next(), null, ['Content-Type 不是图片：text/plain']);

    const cp = JSON.parse(JSON.stringify(buildCheckpoint({
      bundleId: '20260801T000000Z-aaaaaa', frontier: f, pacer: new Pacer({}),
      routes: new Map(), lastCaptureId: null, pauseReason: 'user_paused',
    })));
    assert.match(cp.frontier[0].last_error, /text\/plain/, 'checkpoint 里丢了失败原因');

    // 读回来那一侧是白名单，漏一个字段不会报错，只会静默地少一样东西。
    const src = readFileSync(new URL('../src/crawl/runner.js', import.meta.url), 'utf-8');
    assert.match(src, /lastError: it\.last_error/, 'resume() 没把 last_error 读回来');
  });
});

describe('一批中途被杀，派生出来的封面图不能就此消失', () => {
  test('不中断时：6 个作品，6 张封面（基线）', async () => {
    const { runner, dirs } = harness(50);
    await runner.start(SCOPE);
    await drain(runner);

    const idx = await readIndex(dirs);
    assert.equal(idx.filter((e) => e.route_key === 'interest.item' && e.verdict === 'ok').length, 6);
    assert.equal(idx.filter((e) => e.route_key === 'asset.subject_cover').length, 6);
  });

  test('**中途被杀之后，每个作品仍然有它的封面**', async () => {
    const { runner, runStore, dirs, events } = harness(3);
    await runner.start(SCOPE);

    // 跑几批，中途留下一份**落后的** checkpoint —— 这就是「被杀」的形状：
    // 页面已经写进 index，而 checkpoint 还停在更早的位置。
    let stale = null;
    for (let i = 0; i < 4; i++) {
      if (i === 2) stale = JSON.parse(JSON.stringify(await runStore.loadCheckpoint()));
      const { done } = await runner.runBatch();
      if (done) break;
    }

    // 内存里的一切随 worker 一起没了，只剩那份落后的 checkpoint。
    runner._run = null;
    await runner.resume(stale);
    await drain(runner);

    const idx = await readIndex(dirs);
    const pages = idx.filter((e) => e.route_key === 'interest.item' && e.verdict === 'ok');
    const covers = idx.filter((e) => e.route_key === 'asset.subject_cover');

    const withPage = new Set(pages.map((e) => /\/drama\/(\d+)\//.exec(e.url)?.[1]));
    const withCover = new Set(covers.map((e) => /\/p(\d+)\.jpg/.exec(e.url)?.[1]));
    const orphan = [...withPage].filter((i) => !withCover.has(i));

    assert.equal(withPage.size, 6, '6 个作品都该抓到详情页');
    assert.deepEqual(orphan, [], `有页无图的作品：${JSON.stringify(orphan)}`);

    // 重抓这件事必须留痕，而不是悄悄多几个请求。
    assert.ok(
      events.some((e) => e.type === 'replayed_derivations' && e.count > 0),
      '没有报告重抓',
    );
  });

  test('**checkpoint 里连影子都没有的那些，也要救回来**', async () => {
    // 上一条里，那些页面其实是由 checkpoint 自己的待抓条目带回来的——`markCaptured`
    // 不再把它们挡掉，它们就自己回来了。
    //
    // 但那只是**当前路线拓扑的巧合**：作品详情页是在列表页阶段就全部入队的，所以
    // 崩溃时它们多半还躺在 checkpoint 里。一旦有哪条路线在**同一批**里既派生又抓完
    // （比如翻页链接，或者以后新加的什么），那个条目在 checkpoint 里就一点痕迹都
    // 没有——那时候只剩重抓这一条路。
    //
    // 这里就把那种情形造出来：把 checkpoint 的队列清空，只留 index。
    const { runner, runStore, dirs, events } = harness(3);
    await runner.start(SCOPE);
    let stale = null;
    for (let i = 0; i < 4; i++) {
      if (i === 2) stale = JSON.parse(JSON.stringify(await runStore.loadCheckpoint()));
      const { done } = await runner.runBatch();
      if (done) break;
    }
    // 「这些是 checkpoint 之后才派生出来的」——它在队列里没有任何记录。
    stale.frontier = [];

    runner._run = null;
    await runner.resume(stale);
    await drain(runner);

    const idx = await readIndex(dirs);
    const withPage = new Set(
      idx.filter((e) => e.route_key === 'interest.item' && e.verdict === 'ok')
        .map((e) => /\/drama\/(\d+)\//.exec(e.url)?.[1]),
    );
    const withCover = new Set(
      idx.filter((e) => e.route_key === 'asset.subject_cover')
        .map((e) => /\/p(\d+)\.jpg/.exec(e.url)?.[1]),
    );
    const orphan = [...withPage].filter((i) => !withCover.has(i));
    assert.deepEqual(orphan, [], `有页无图的作品：${JSON.stringify(orphan)}`);
    assert.ok(events.some((e) => e.type === 'replayed_derivations' && e.count > 0));
  });

  test('重抓的是页面，不是封面图本身', async () => {
    // 重抓一张封面不产出任何新东西，纯粹白发一次请求。
    const { runner, runStore, events } = harness(3);
    await runner.start(SCOPE);
    let stale = null;
    for (let i = 0; i < 4; i++) {
      if (i === 2) stale = JSON.parse(JSON.stringify(await runStore.loadCheckpoint()));
      const { done } = await runner.runBatch();
      if (done) break;
    }
    runner._run = null;
    await runner.resume(stale);

    const queued = runner._run.frontier.snapshot()
      .filter((it) => it.state === 'pending')
      .map((it) => it.routeKey);
    assert.equal(
      queued.includes('asset.subject_cover'), false,
      '不该把已经抓到的封面图重新排进队',
    );
    assert.ok(events.some((e) => e.type === 'replayed_derivations'));
  });
});

describe('被豆瓣挡住的条目不能当成「跑完了」', () => {
  /**
   * 这是 418 那件事的连锁后果，也是最危险的一环。
   *
   * 软封锁的条目状态是 `awaiting_human`，**不是 `failed`**。而「还有没有没解决的
   * 东西」原来只数 `failedItems()`——于是一整条路线全被挡住时，队列里取不出任何
   * 东西，上层读到的是「没有可跑的了」，然后**自动收尾成 complete**。
   *
   * 实测差点撞上：豆瓣对图片请求一律回 418，2900 张封面会全部进 awaiting_human。
   * 那样产出的是一份声称「已完成」、却整条路线没抓到的档案——这个项目最不能
   * 出的错：假的完整性声明。
   */
  /**
   * 让图片全部返回 418 —— 这就是真实发生的事。走完整条链路：
   * 分类器判 blocked → frontier 转 awaiting_human → 收尾时的守卫。
   */
  async function crawlWithTeapotImages() {
    const h = harness(50, { imageStatus: 418 });
    await h.runner.start(SCOPE);
    await drain(h.runner);
    return h;
  }

  test('**第一个 418 就停手**，不是一路撞过去', async () => {
    // 这是整件事最要紧的一条。原来 418 判成「判不出来」，于是每一张都记一次失败
    // 然后接着抓下一张——豆瓣说了 123 次「不」，我们一次都没听懂，还打算再说
    // 2900 次。而在软封锁上继续请求，正是把限流升级成封号的标准路径。
    //
    // 现在第一张就转成 awaiting_human，那条路线随即被挡住，其余的原地不动。
    const { runner, calls } = await crawlWithTeapotImages();
    const covers = runner._run.frontier.snapshot().filter((x) => x.routeKey === 'asset.subject_cover');
    assert.ok(covers.length > 1, '排进队的封面不足两张，这个用例验不到东西');

    const waiting = covers.filter((x) => x.state === 'awaiting_human');
    const pending = covers.filter((x) => x.state === 'pending');
    assert.equal(waiting.length, 1, '不该有第二张被送出去撞墙');
    assert.equal(pending.length, covers.length - 1, '其余的应当原地不动');

    const imageCalls = calls.filter((u) => u.includes('doubanio.com'));
    assert.equal(imageCalls.length, 1, `发了 ${imageCalls.length} 次图片请求，应当只有 1 次`);
  });

  test('finish("complete") 必须拒绝', async () => {
    const { runner } = await crawlWithTeapotImages();
    await assert.rejects(() => runner.finish('complete'), /挡住|软封锁/);
  });

  test('**「就这样收尾」也不给开口子**', async () => {
    // 与失败不同：失败是「试过了，不行」，可以由用户决定记成缺口收尾。而软封锁
    // 是豆瓣正在拒绝我们——那时候该等、该降速，不该把它记成一个既成事实。
    const { runner } = await crawlWithTeapotImages();
    await assert.rejects(() => runner.finish('complete', { acceptLeafGaps: true }), /挡住|软封锁/);
  });

  test('中止照样可以 —— 用户总得有办法结束', async () => {
    const { runner } = await crawlWithTeapotImages();
    const m = await runner.finish('aborted');
    assert.equal(m.status, 'aborted');
  });

  test('状态里数得出来，上层才有可能不误判', async () => {
    const { runner } = await crawlWithTeapotImages();
    const b = await runner.runBatch();
    assert.ok(b.awaitingHuman > 0, 'runBatch 没报出被挡住的条数');
  });
});
