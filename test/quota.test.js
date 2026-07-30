import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyWriteError, preflightStorage, StorageError,
  QUOTA, WRITE_FAILED, TYPICAL_ARCHIVE_BYTES, HEADROOM_FACTOR,
} from '../src/storage/quota.js';
import { CrawlLoop } from '../src/crawl/loop.js';
import { Frontier } from '../src/crawl/frontier.js';
import { SessionGuard } from '../src/crawl/session.js';
import { Pacer, RequestGate } from '../src/crawl/pacing.js';
import { Transport } from '../src/crawl/transport.js';
import { buildRoutes } from '../src/crawl/routes.js';
import { seedFrontier } from '../src/crawl/runner.js';

describe('写入失败的归类', () => {
  test('各种形态的配额耗尽都要认出来', () => {
    // 认漏了就会把「磁盘满了」显示成「未知错误」，而这两句话对用户的意义
    // 完全不同：前者知道该去导出或清理，后者只能干瞪眼。
    const cases = [
      Object.assign(new Error('x'), { name: 'QuotaExceededError' }),
      Object.assign(new Error('x'), { code: 22 }),                  // legacy DOMException
      new Error('The quota has been exceeded.'),
      new Error('device storage full'),
      new Error('磁盘空间不足'),
    ];
    for (const e of cases) {
      assert.equal(classifyWriteError(e).reason, QUOTA, `没认出来：${e.name} / ${e.message}`);
    }
  });

  test('其它写失败归 write_failed，不冒充配额问题', () => {
    const e = classifyWriteError(new Error('NotReadableError: 文件句柄没了'));
    assert.equal(e.reason, WRITE_FAILED);
    assert.match(e.message, /写入档案失败/);
  });

  test('已经是 StorageError 就原样返回，不套两层', () => {
    const e = new StorageError(QUOTA, '原本的说明');
    assert.equal(classifyWriteError(e), e);
  });
});

describe('开抓前的空间预检', () => {
  test('够用', async () => {
    const r = await preflightStorage({
      storage: { estimate: async () => ({ usage: 0, quota: 100e9 }) },
    });
    assert.equal(r.enough, true);
    assert.equal(r.available, 100e9);
  });

  test('不够用时报出差多少', async () => {
    const r = await preflightStorage({
      storage: { estimate: async () => ({ usage: 900e6, quota: 1e9 }) },
    });
    assert.equal(r.enough, false);
    assert.equal(r.available, 100e6);
    assert.equal(r.need, TYPICAL_ARCHIVE_BYTES * HEADROOM_FACTOR);
  });

  test('按含目录页的真实体量估，不按列表页', async () => {
    // 只按列表页估会给出一个乐观得离谱的数字，然后用户在抓了几小时之后撞墙。
    // 真实档案 782 MB，其中目录页占 90.3%。
    assert.ok(TYPICAL_ARCHIVE_BYTES >= 700 * 1024 * 1024);
    assert.ok(HEADROOM_FACTOR > 1, '要留余量：撞线的代价远大于多提醒一次');
  });

  test('API 不可用 / quota 为 0 → null，不是「够用」', async () => {
    // 「查不了」和「够用」是两件事。混为一谈就等于悄悄取消了这项检查。
    assert.equal(await preflightStorage({ storage: {} }), null);
    assert.equal(await preflightStorage({ storage: { estimate: async () => ({ quota: 0 }) } }), null);
    assert.equal(
      await preflightStorage({ storage: { estimate: async () => { throw new Error('x'); } } }),
      null,
    );
  });
});

describe('写失败让整场抓取停下', () => {
  /** 一个写到第 n 次就抛的写入器替身。 */
  function writerThatFailsAt(n, err) {
    let calls = 0;
    return {
      bundleId: '20260730-000000-abcd',
      coverage: [],
      crawlStates: [],
      async writeCapture() {
        calls += 1;
        if (calls >= n) throw err;
        return { captureId: `#00000${calls}` };
      },
      addCoverage(c) { this.coverage.push(c); },
      addCrawlState(c) { this.crawlStates.push(c); },
      get calls() { return calls; },
    };
  }

  const NAV = `<li class="nav-user-account"><a href="/accounts/logout">退出</a>
<span>示例的账号</span></li><a href="https://www.douban.com/people/example/">主页</a>
<script>;window._GLOBAL_NAV = { USER_ID: "82160871" };</script>`;

  function page(n) {
    let items = '';
    for (let i = 0; i < n; i++) {
      items += `<div class="status-item" data-sid="${i}" data-uid="82160871">
        <span class="created_at" title="2026-07-2${i % 9} 10:00:00">x</span></div>`;
    }
    return `<html><head><title>\n我的动态\n</title></head><body>${NAV}
<div id="db-usr-profile"><div class="info"><h1>示例</h1></div></div>
<div class="stream-items">${items}</div></body></html>`;
  }

  function harness(writer) {
    const routeDefs = buildRoutes({ username: 'example', includeCatalog: false })
      .filter((r) => r.key === 'broadcast.timeline');
    const frontier = new Frontier();
    seedFrontier(frontier, routeDefs);

    const enc = new TextEncoder();
    const transport = new Transport({
      gate: new RequestGate({ pacer: new Pacer({ intervalMs: 1, jitterRatio: 0 }) }),
      fetchImpl: async (url) => {
        const body = enc.encode(page(20));
        return {
          status: 200, url,
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        };
      },
    });

    // 会话守卫要先 preflight 才肯复核——身份确认是开工的前置条件。
    const session = new SessionGuard();
    session.preflight(
      `<html><head><title>示例的账号</title></head><body>${NAV}` +
        '<div class="status-item" data-sid="1" data-uid="82160871">x</div></body></html>',
    );

    const events = [];
    const loop = new CrawlLoop({
      frontier, transport, writer, session,
      pacer: new Pacer({ intervalMs: 1, jitterRatio: 0 }),
      routes: new Map(routeDefs.map((r) => [r.key, r])),
      onEvent: (e) => events.push(e),
    });
    return { loop, frontier, events };
  }

  test('配额耗尽 → 整场停下，停机原因是 quota', async () => {
    const writer = writerThatFailsAt(2, Object.assign(new Error('x'), { name: 'QuotaExceededError' }));
    const { loop, frontier } = harness(writer);

    const r = await loop.run({ maxItems: 10 });

    assert.equal(r.stoppedBy, QUOTA);
    assert.equal(frontier.stopped, true);
    // 停下来只需一次崩溃恢复就能修好；接着写下去是一路撕裂到用户放弃。
    assert.equal(writer.calls, 2, '不该在失败之后继续尝试写');
  });

  test('其它写失败 → 同样整场停下，原因是 write_failed', async () => {
    const writer = writerThatFailsAt(1, new Error('段文件句柄没了'));
    const { loop, frontier, events } = harness(writer);

    const r = await loop.run({ maxItems: 10 });

    assert.equal(r.stoppedBy, WRITE_FAILED);
    assert.equal(frontier.stopReason, WRITE_FAILED);
    const stopped = events.find((e) => e.type === 'stopped');
    assert.match(stopped.message, /写入档案失败/);
  });

  test('写失败的路线不许推进水位线', async () => {
    // 写没成功，就不知道那一页到底进档案了没有。这种情况下推进水位线，
    // 等于宣布「这条线上面全都抓到了」——而那可能是假的。
    const writer = writerThatFailsAt(2, new Error('boom'));
    const { loop } = harness(writer);
    await loop.run({ maxItems: 10 });

    loop.flushRouteEvidence('2026-07-30T00:00:00Z');
    const cs = writer.crawlStates[0];
    assert.equal(cs.advanced, false);
    // 水位线本身照样报告——它是一条有用的观测。advanced=false 只是告诉下游
    // 「别拿它当下次的下界」。
    assert.notEqual(cs.high_water_time, undefined);
  });
});
