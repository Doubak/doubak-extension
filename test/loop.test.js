import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CrawlLoop } from '../src/crawl/loop.js';
import { Frontier } from '../src/crawl/frontier.js';
import { Transport } from '../src/crawl/transport.js';
import { Pacer, RequestGate } from '../src/crawl/pacing.js';
import { SessionGuard } from '../src/crawl/session.js';
import { BundleWriter } from '../src/bundle/bundle-writer.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { buildRoutes } from '../src/crawl/routes.js';
import { indexFilename } from '../src/core/ids.js';
import { TransportError } from '../src/crawl/errors.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// 数字 uid 取自 `_GLOBAL_NAV.USER_ID`，不是广播条目的 `data-uid`——后者在作品
// 详情页上是评论者的 ID。见 src/crawl/session.js 里 UID_PATTERNS 的说明。
const NAV = `<li class="nav-user-account"><a href="/accounts/logout">退出</a>
<span>示例的账号</span></li><a href="https://www.douban.com/people/example/">主页</a>
<script>;window._GLOBAL_NAV = { USER_ID: "10001" };</script>`;

/** 一页广播，n 条，ID 从 from 开始。 */
function broadcastPage(n, from = 0) {
  let items = '';
  for (let i = 0; i < n; i++) {
    items += `<div class="status-item" data-sid="${from + i}" data-uid="10001">
      <span class="created_at" title="2026-07-2${i % 9} 12:00:00">x</span></div>`;
  }
  return `<html><head><title>
    示例的广播
</title></head><body>${NAV}<div id="db-usr-profile"><div class="info"><h1>示例</h1></div></div>
<div class="stream-items">${items}</div></body></html>`;
}

const LOGIN_PAGE = `<html><head><title>
    登录豆瓣
</title></head><body>请输入验证码</body></html>`;

const BLOCKED_PAGE = `<html><head><title>豆瓣</title></head><body>访问过于频繁，请稍后再试</body></html>`;

/**
 * 搭一套完整链路，HTTP 层用脚本驱动。
 * @param {Array<{status?: number, body?: string, headers?: Record<string,string>}>} script
 */
async function harness(script, { maxSegmentBytes } = {}) {
  let now = 0;
  const store = new MemoryFileStore();
  const events = [];

  const pacer = new Pacer({ intervalMs: 1, jitterRatio: 0 });
  const gate = new RequestGate({ pacer, now: () => now, sleep: async (ms) => { now += ms; } });

  let i = 0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const s = script[Math.min(i++, script.length - 1)] ?? {};
    const bytes = enc.encode(s.body ?? broadcastPage(0));
    return {
      status: s.status ?? 200,
      url,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8', ...(s.headers ?? {}) }),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };

  const transport = new Transport({ gate, fetchImpl, now: () => now });
  const writer = new BundleWriter({
    store,
    account: { user_id: '10001', username: 'example' },
    now: () => new Date(1750000000000 + now),
    ...(maxSegmentBytes ? { maxSegmentBytes } : {}),
  });

  const session = new SessionGuard();
  session.preflight(broadcastPage(1));

  const frontier = new Frontier();
  const routeDefs = buildRoutes({ username: 'example', includeCatalog: false });
  const routes = new Map(routeDefs.map((r) => [r.key, r]));

  const bc = routes.get('broadcast.timeline');
  frontier.enqueue({
    url: bc.entryUrl({ offset: 1 }),
    urlKey: bc.entryUrl({ offset: 1 }),
    routeKey: 'broadcast.timeline',
    intent: 'broadcast.timeline',
    cursor: { kind: 'page', value: 1 },
  });

  const loop = new CrawlLoop({
    frontier, transport, writer, session, pacer, routes,
    onEvent: (e) => events.push(e),
  });

  return { loop, frontier, store, writer, events, calls, pacer, session };
}

async function readIndex(store, bundleId) {
  const name = indexFilename(bundleId);
  if (!(await store.exists(name))) return [];
  return dec.decode(await store.read(name)).trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('正常抓取', () => {
  test('翻页直到停滞，每页都写进档案', async () => {
    const { loop, store, writer } = await harness([
      { body: broadcastPage(20, 0) },
      { body: broadcastPage(20, 20) },
      { body: broadcastPage(20, 40) },
      { body: broadcastPage(0) }, // 越界终止页
      { body: broadcastPage(0) },
      { body: broadcastPage(0) },
    ]);

    const r = await loop.run({ maxItems: 10 });
    const entries = await readIndex(store, writer.bundleId);

    assert.ok(r.captured >= 4, `应当抓了多页，实际 ${r.captured}`);
    assert.equal(r.stoppedBy, null, '正常跑完不该是被停机');
    assert.equal(entries.length, r.captured + r.failed);
    for (const e of entries) assert.equal(e.verdict, 'ok');
  });

  test('空的终止页判为 ok，不是故障', async () => {
    // 越界终止页与登录页条目数都是 0，必须分对。
    const { loop, store, writer } = await harness([{ body: broadcastPage(0) }]);
    await loop.run({ maxItems: 1 });
    const [entry] = await readIndex(store, writer.bundleId);
    assert.equal(entry.verdict, 'ok');
  });

  test('连续三页无新条目才停 —— 整页重复是正常的', async () => {
    // 头部插入会把条目推向后面的页，重复是设计所要的方向。
    const { loop, events } = await harness([
      { body: broadcastPage(20, 0) },
      { body: broadcastPage(20, 0) }, // 全重复
      { body: broadcastPage(20, 0) },
      { body: broadcastPage(20, 0) },
    ]);
    await loop.run({ maxItems: 6 });

    const finished = events.find((e) => e.type === 'route_finished');
    assert.ok(finished, '应当因停滞而结束这条路线');
    assert.equal(finished.reason, 'stalled');

    const pages = events.filter((e) => e.type === 'page');
    assert.ok(pages.length >= 3, '不该第一页重复就停');
    assert.equal(pages[1].duplicates, 20, '重复要被记下来');
  });

  test('翻页游标递增', async () => {
    const { loop, calls } = await harness([
      { body: broadcastPage(20, 0) },
      { body: broadcastPage(20, 20) },
      { body: broadcastPage(0) },
      { body: broadcastPage(0) },
      { body: broadcastPage(0) },
    ]);
    await loop.run({ maxItems: 5 });
    assert.match(calls[0].url, /\?p=1$/);
    assert.match(calls[1].url, /\?p=2$/);
  });
});

describe('封锁页与登录页必须进档案', () => {
  // 真实旧档案里有两个登录页被按数据文件名写进磁盘、没有任何标记，
  // 下游只会看到「文件在，里面 0 条」。我们要反过来：存下来并如实标注。

  test('封锁页被写入且标为 blocked', async () => {
    const { loop, store, writer } = await harness([
      { body: broadcastPage(20, 0) },
      { body: BLOCKED_PAGE },
    ]);
    await loop.run({ maxItems: 3 });

    const entries = await readIndex(store, writer.bundleId);
    const blocked = entries.find((e) => e.verdict === 'blocked');
    assert.ok(blocked, '封锁页必须留证');
    assert.ok(blocked.content_sha256, '内容确实写下来了');
  });

  test('登录页被写入且标为 login，然后停机', async () => {
    const { loop, store, writer, frontier } = await harness([
      { body: broadcastPage(20, 0) },
      { body: LOGIN_PAGE },
    ]);
    const r = await loop.run({ maxItems: 5 });

    const entries = await readIndex(store, writer.bundleId);
    assert.ok(entries.some((e) => e.verdict === 'login'), '登录页必须留证');
    assert.equal(frontier.stopped, true);
    assert.ok(r.stoppedBy, '会话失效是停止条件');
  });

  test('判不出来的页面也留证，但绝不标成 ok', async () => {
    // 注意构造：必须【登录状态还在】但页面框架对不上，才是真正的「判不出来」。
    // 没有导航栏的页面会先命中 login 规则——那是另一回事。
    const { loop, store, writer } = await harness([
      { body: `<html><head><title>豆瓣</title></head><body>${NAV}<div>不认识的页面</div></body></html>` },
    ]);
    await loop.run({ maxItems: 1 });

    const [entry] = await readIndex(store, writer.bundleId);
    assert.notEqual(entry.verdict, 'ok', '「大概没事」是最危险的一句话');
    assert.match(entry.note ?? '', /判不出来/);
  });
});

describe('软封锁：降速并等人，绝不重试', () => {
  test('遇到封锁后降速', async () => {
    const { loop, pacer, events } = await harness([
      { body: broadcastPage(20, 0) },
      { body: BLOCKED_PAGE },
    ]);
    const before = pacer.intervalMs;
    await loop.run({ maxItems: 3 });

    assert.ok(pacer.intervalMs > before, '踩到边界就要降速');
    assert.ok(events.some((e) => e.type === 'awaiting_human'));
  });

  test('封锁之后该路线被阻塞，不会继续抓', async () => {
    const { loop, frontier } = await harness([
      { body: broadcastPage(20, 0) },
      { body: BLOCKED_PAGE },
      { body: broadcastPage(20, 40) },
    ]);
    await loop.run({ maxItems: 10 });
    assert.equal(frontier.next(), null, '等人处理期间不该继续抓这条线');
  });
});

describe('网络错误可重试，风控不可', () => {
  test('网络错误重试后成功', async () => {
    let n = 0;
    const store = new MemoryFileStore();
    void store;
    const h = await harness([{ body: broadcastPage(20, 0) }]);
    // 换掉 transport 的 fetch：前两次抛网络错误，第三次成功
    h.loop._transport = {
      fidelity: 'decoded_body+filtered_headers',
      fetch: async (url) => {
        if (n++ < 2) throw new TransportError('network', '连接失败');
        return {
          requestedUrl: url, finalUrl: url, redirectChain: [], status: 200,
          headers: [['content-type', 'text/html']],
          body: enc.encode(broadcastPage(0)),
          bodyText: broadcastPage(0),
          fidelity: 'decoded_body+filtered_headers', elapsedMs: 1,
        };
      },
    };

    const r = await h.loop.run({ maxItems: 1 });

    // 前两次抛错各触发一次重试，第三次成功。注意 maxItems 只数「成功或失败」，
    // 重试不计入——所以这里限 1 条也能走完三次 fetch。
    const retries = h.events.filter((e) => e.type === 'retry');
    assert.equal(retries.length, 2, '重试了两次');
    assert.ok(retries.every((e) => e.willRetry), '两次都还愿意再试');
    assert.equal(n, 3, '第三次才成功');
    assert.equal(r.captured, 1, '最终成功');
  });

  test('重试用尽后判失败', async () => {
    const h = await harness([{ body: broadcastPage(0) }]);
    h.loop._transport = {
      fidelity: 'decoded_body+filtered_headers',
      fetch: async () => {
        throw new TransportError('network', '一直失败');
      },
    };

    const r = await h.loop.run({ maxItems: 10 });
    assert.equal(r.failed, 1);
    assert.equal(r.captured, 0);
  });

  test('不可重试的错误直接判失败，不重试', async () => {
    let n = 0;
    const h = await harness([{ body: broadcastPage(0) }]);
    h.loop._transport = {
      fidelity: 'decoded_body+filtered_headers',
      fetch: async () => {
        n++;
        throw new TransportError('unknown', '没见过的错误');
      },
    };

    await h.loop.run({ maxItems: 5 });
    assert.equal(n, 1, '分不清的错误只试一次——把风控当网络错误重试的代价是账号');
  });

  test('用户中止导致停机', async () => {
    const h = await harness([{ body: broadcastPage(0) }]);
    h.loop._transport = {
      fidelity: 'decoded_body+filtered_headers',
      fetch: async () => {
        throw new TransportError('aborted', '用户暂停');
      },
    };

    const r = await h.loop.run({ maxItems: 5 });
    assert.equal(r.stoppedBy, 'user_paused');
  });
});

describe('provenance', () => {
  test('index 里有 parent_capture_id 链', async () => {
    const { loop, store, writer } = await harness([
      { body: broadcastPage(20, 0) },
      { body: broadcastPage(20, 20) },
      { body: broadcastPage(0) },
      { body: broadcastPage(0) },
      { body: broadcastPage(0) },
    ]);
    await loop.run({ maxItems: 5 });

    const entries = await readIndex(store, writer.bundleId);
    assert.equal(entries[0].parent_capture_id, null, '第一条是根');
    assert.equal(entries[1].parent_capture_id, entries[0].capture_id, '第二页由第一页带出');
  });

  test('cursor 被记下来，页面可复现', async () => {
    const { loop, store, writer } = await harness([
      { body: broadcastPage(20, 0) },
      { body: broadcastPage(0) },
      { body: broadcastPage(0) },
      { body: broadcastPage(0) },
    ]);
    await loop.run({ maxItems: 4 });
    const entries = await readIndex(store, writer.bundleId);
    assert.deepEqual(entries[0].cursor, { kind: 'page', value: 1 });
    assert.deepEqual(entries[1].cursor, { kind: 'page', value: 2 });
  });
});

describe('完整性证据：跑完一条路线要产出连续性证明与覆盖率', () => {
  // 这是整个设计的落点。豆瓣的计数不可信，所以完整性只能来自抓取过程自身的
  // 结构化证明。不产出它，bundle 里就没有任何完整性依据，也无从增量。

  test('干净跑完 → advanced=true，水位线可用于下次', async () => {
    const { loop, writer } = await harness([
      { body: broadcastPage(20, 0) },
      { body: broadcastPage(20, 20) },
      { body: broadcastPage(0) },
      { body: broadcastPage(0) },
      { body: broadcastPage(0) },
    ]);
    await loop.run({ maxItems: 6 });
    loop.flushRouteEvidence();
    const manifest = await writer.finalize();

    const cs = manifest.crawl_state.find((c) => c.route_key === 'broadcast.timeline');
    assert.ok(cs, '必须产出 crawl_state');
    assert.equal(cs.contiguous, true);
    assert.equal(cs.advanced, true, '干净跑完才允许推进水位线');
    assert.match(cs.high_water_time, /^\d{4}-\d{2}-\d{2}T.*\+08:00$/, '带显式时区偏移');
    assert.ok(cs.high_water_raw, '原始字符串也要留');
    assert.equal(cs.enumeration, 'bounded', '广播只走到下界，下游不得推断删除');
  });

  test('被风控打断 → advanced=false，下次仍从旧下界重走', async () => {
    // 重复是免费的，空洞是永久且不可检测的。
    const { loop, writer } = await harness([
      { body: broadcastPage(20, 0) },
      { body: BLOCKED_PAGE },
    ]);
    await loop.run({ maxItems: 3 });
    loop.flushRouteEvidence();
    const manifest = await writer.finalize();

    const cs = manifest.crawl_state.find((c) => c.route_key === 'broadcast.timeline');
    assert.equal(cs.advanced, false, '被打断绝不许推进水位线');
    assert.ok(cs.gaps.length > 0, '缺口要显式记录');
    assert.ok(cs.high_water_time, '但仍如实报告见到的水位线');
  });

  test('中途没跑完就收尾 → 记为被打断', async () => {
    const { loop, writer } = await harness([
      { body: broadcastPage(20, 0) },
      { body: broadcastPage(20, 20) },
    ]);
    await loop.run({ maxItems: 1 }); // 只跑一页就停
    loop.flushRouteEvidence();
    const manifest = await writer.finalize();

    const cs = manifest.crawl_state.find((c) => c.route_key === 'broadcast.timeline');
    assert.equal(cs.advanced, false, '没跑完就不算数');
  });

  test('广播的 coverage：声称数量为 null，不是 0', async () => {
    // null = 不知道，0 = 确实没有。界面上也必须分开显示。
    const { loop, writer } = await harness([
      { body: broadcastPage(20, 0) },
      { body: broadcastPage(0) },
      { body: broadcastPage(0) },
      { body: broadcastPage(0) },
    ]);
    await loop.run({ maxItems: 5 });
    loop.flushRouteEvidence();
    const manifest = await writer.finalize();

    const cov = manifest.coverage.find((c) => c.route_key === 'broadcast.timeline');
    assert.equal(cov.claimed_count, null);
    assert.equal(cov.delta, null);
    assert.ok(cov.captured_count > 0, '实抓数量照样要记');
  });

  test('到达下界就干净结束 —— 增量抓取的正常终点', async () => {
    const { loop, writer, events } = await harness([
      { body: broadcastPage(20, 0) },
    ]);
    // 把下界设在第一页内容之后：第一页就会触发 reachedFloor
    loop._floors.set('broadcast.timeline', '2026-07-30T00:00:00+08:00');
    await loop.run({ maxItems: 3 });
    loop.flushRouteEvidence();

    const finished = events.find((e) => e.type === 'route_finished');
    assert.equal(finished?.reason, 'reached_floor');

    const manifest = await writer.finalize();
    const cs = manifest.crawl_state.find((c) => c.route_key === 'broadcast.timeline');
    assert.equal(cs.advanced, true, '到达下界是干净完成的一种');
    assert.equal(cs.floor_time, '2026-07-30T00:00:00+08:00');
  });
});

describe('index 里记下条目数与时间区间', () => {
  test('条目数与时间区间都写进 index', async () => {
    // 抓取时本来就算过（判定要用），扔掉之后再想知道就得把记录取出来解压、
    // 再跑一遍选择器——而豆瓣改版之后那些选择器可能已经对不上了。这次就撞过一回。
    const { loop, writer, store } = await harness([{ body: broadcastPage(20) }, { body: broadcastPage(0) }]);
    await loop.run({ maxItems: 2 });

    const lines = new TextDecoder()
      .decode(await store.read(indexFilename(writer.bundleId)))
      .trim().split('\n').map((l) => JSON.parse(l));

    const first = lines[0];
    assert.equal(first.item_count, 20);
    assert.ok(first.item_time_range, '要有时间区间');
    assert.ok(first.item_time_range.oldest);
    assert.ok(first.item_time_range.newest);
  });

  test('时间区间原样保留豆瓣给出的形式，不归一化时区', async () => {
    // 列表页不带时区，归一化就等于替它假定一个，而假定错了不可恢复。
    const { loop, writer, store } = await harness([{ body: broadcastPage(20) }, { body: broadcastPage(0) }]);
    await loop.run({ maxItems: 1 });

    const line = JSON.parse(
      new TextDecoder().decode(await store.read(indexFilename(writer.bundleId))).trim().split('\n')[0],
    );
    // 夹具里的时间形如 2026-07-2X 12:00:00 —— 原样，没有 Z、没有 +08:00
    assert.match(line.item_time_range.oldest, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('区间按解析后的时间取，不按字符串比大小', async () => {
    // 同一份列表里格式是混着来的（「今天上午」与绝对时间都出现过），字典序会给出
    // 错误的顺序。
    const { loop, writer, store } = await harness([{ body: broadcastPage(20) }, { body: broadcastPage(0) }]);
    await loop.run({ maxItems: 1 });

    const line = JSON.parse(
      new TextDecoder().decode(await store.read(indexFilename(writer.bundleId))).trim().split('\n')[0],
    );
    const { parseDoubanTimestamp } = await import('../src/crawl/../core/time.js');
    const o = parseDoubanTimestamp(line.item_time_range.oldest).epochMs;
    const n = parseDoubanTimestamp(line.item_time_range.newest).epochMs;
    assert.ok(o <= n, 'oldest 不该晚于 newest');
  });

  test('0 条的终止页记 0，不是 null —— 两者含义不同', async () => {
    // null 是「这条路线没有条目概念」，0 是「数过了，是空的」——而空页正是翻页
    // 终点的正常形态，那是有用的信息。
    const { loop, writer, store } = await harness([{ body: broadcastPage(0) }, { body: broadcastPage(0) }]);
    await loop.run({ maxItems: 1 });

    const line = JSON.parse(
      new TextDecoder().decode(await store.read(indexFilename(writer.bundleId))).trim().split('\n')[0],
    );
    assert.equal(line.item_count, 0);
    assert.notEqual(line.item_count, null);
    assert.equal(line.item_time_range, null, '没有条目就没有区间');
  });

  test('只扫一遍 HTML —— 判定、水位线、index 共用同一次抽取', async () => {
    // 这是对一份 100 KB 的 HTML 跑正则，抽两遍没有理由。
    const src = await (await import('node:fs/promises')).readFile(
      new URL('../src/crawl/loop.js', import.meta.url), 'utf-8');
    assert.equal((src.match(/extractItemTimes\(/g) ?? []).length, 1);
    assert.equal((src.match(/extractItemIds\(/g) ?? []).length, 1);
  });
});

describe('停机事件要说清是哪一页触发的', () => {
  test('日志里那一行必须带 URL', () => {
    // 报上来的：日志写着「stopped · account_switched · 账号发生了变化…」，
    // 但**没说是抓哪一页时判断的**。而那正是排查的第一个问题——这次的答案是
    // 「一张作品详情页，页面上第一个 /people/ 链接是短评作者的」。
    const src = readFileSync(new URL('../src/crawl/loop.js', import.meta.url), 'utf-8');
    const emits = [...src.matchAll(/_emit\(\{\s*type: 'stopped'[^}]*\}/g)].map((m) => m[0]);
    assert.ok(emits.length >= 4, `没找到几处停机事件：${emits.length}`);
    for (const e of emits) {
      assert.match(e, /url:/, `这处停机事件没带 URL：${e}`);
    }
  });
});
