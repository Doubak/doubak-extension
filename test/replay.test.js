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

function harness(batchSize) {
  const kv = new MemoryKvStore();
  /** @type {Map<string, MemoryFileStore>} */
  const dirs = new Map();
  const openBundle = async (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, new MemoryFileStore());
    return dirs.get(dir);
  };
  const runStore = new RunStore({ kv, openBundle });
  const events = [];
  const fetchImpl = async (url) => {
    const isImage = url.includes('doubanio.com');
    const body = isImage ? new Uint8Array([0xff, 0xd8, 1, 2, 3]) : enc.encode(pageFor(url));
    return {
      status: 200,
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
  return { runner, runStore, dirs, events };
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
