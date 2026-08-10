/**
 * 存量补抓：从已经存下来的页面里补算出当时没抓的资源。
 *
 * ## 它要解决的死角
 *
 * `asset.status_photo` 是**从广播页派生**的，而广播是增量路线——下次抓取只取回
 * 水位线以上的新页面。水位线以下那些**永远不会再被请求**，于是在这条路线存在之前
 * 发布的广播，它们的附图就此成为死角。
 *
 * 实测一份真实档案：121 张本人上传的图，分布在 22 张老广播页上，一张都下不来。
 *
 * 而那 22 张页面的字节就在档案里，图片 URL 写在它们的 HTML 正文中。所以这不是
 * 「重新抓取」的问题，是「把已有捕获再算一遍」的问题。
 *
 * ## 这一组测试的两半
 *
 * 前半用合成数据钉住行为（归属过滤、去重、失败方向、跨档案 parent），后半直接
 * 对着 `~/downloads` 里的真实档案跑——**真实档案不在的机器上自动跳过**，与
 * `subject-route.test.js` 里那条是同一个做法。
 */

import { test, describe } from 'node:test';
import { readPanelSourceSync } from './helpers/fake-dom.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { backlogFromIndex, capturedAssets } from '../src/crawl/backlog.js';

const OWNER = '82160871';

/** 一条广播页的索引行。 */
const bcRow = (seq, bundle = '20260801T005010Z-3eef52') => ({
  capture_id: `${bundle}#${String(seq).padStart(6, '0')}`,
  route_key: 'broadcast.timeline',
  verdict: 'ok',
  url: `https://www.douban.com/people/mewcatcher/statuses?p=${seq}`,
});

/** 一页带图的广播 HTML。 */
const page = (uid, ...names) => `<div class="new-status status-wrapper" data-uid="${uid}">
  <div class="pics-wrapper"><script>var photos = [${names
    .map((n) => `{"image": {"large": {"url": "https://img1.doubanio.com/view/status/l/public/${n}.jpg"}}}`)
    .join(',')}];</script></div>
</div>`;

/** @param {Record<string, string>} pages  capture_id → html */
const reader = (pages) => async (row) => {
  if (!(row.capture_id in pages)) throw new Error(`没有这条：${row.capture_id}`);
  return pages[row.capture_id];
};

describe('从已存的广播页算出欠账', () => {
  test('算出来的每一条都带着来源与 referer', async () => {
    const rows = [bcRow(1)];
    const { items, pagesRead } = await backlogFromIndex({
      indexRows: rows,
      readPayload: reader({ [rows[0].capture_id]: page(OWNER, 'aaa') }),
      ownerUserId: OWNER,
    });

    assert.equal(pagesRead, 1);
    assert.deepEqual(items, [{
      url: 'https://img1.doubanio.com/view/status/l/public/aaa.jpg',
      routeKey: 'asset.status_photo',
      // **跨档案的 parent**（规范 §6.2.1）。把这个 URL 放进队列的那次捕获，
      // 客观上就发生在旧档案里；写 null 等于宣称它凭空冒出来。
      parentCaptureId: '20260801T005010Z-3eef52#000001',
      // 豆瓣的图片服务认这个头（没有它会收到 418，实测过 123 次）。
      referer: 'https://www.douban.com/people/mewcatcher/statuses?p=1',
    }]);
  });

  test('**转发进来的图不补** —— 和在线那条路是同一个判据', async () => {
    const rows = [bcRow(1), bcRow(2)];
    const { items, skippedOthers } = await backlogFromIndex({
      indexRows: rows,
      readPayload: reader({
        [rows[0].capture_id]: page(OWNER, 'mine'),
        [rows[1].capture_id]: page('99999', 'theirs'),
      }),
      ownerUserId: OWNER,
    });
    assert.equal(items.length, 1);
    assert.match(items[0].url, /mine/);
    assert.equal(skippedOthers, 1);
  });

  test('拿不到主人是谁就直接拒绝', async () => {
    // 不知道是谁的却往 assets-* 里写东西，等于把「谁的」这个判断悄悄跳过。
    await assert.rejects(
      () => backlogFromIndex({ indexRows: [], readPayload: reader({}), ownerUserId: '' }),
      /ownerUserId/,
    );
  });

  test('已经抓到的不再补', async () => {
    const rows = [bcRow(1)];
    const { items } = await backlogFromIndex({
      indexRows: rows,
      readPayload: reader({ [rows[0].capture_id]: page(OWNER, 'aaa', 'bbb') }),
      ownerUserId: OWNER,
      alreadyHave: new Set(['https://img1.doubanio.com/view/status/l/public/aaa.jpg']),
    });
    assert.equal(items.length, 1);
    assert.match(items[0].url, /bbb/);
  });

  test('同一张图出现在多页上只补一次', async () => {
    // 广播列表是 head-insert，同一条广播会在相邻两次抓取的页面上各出现一次。
    const rows = [bcRow(1), bcRow(2)];
    const { items } = await backlogFromIndex({
      indexRows: rows,
      readPayload: reader({
        [rows[0].capture_id]: page(OWNER, 'dup'),
        [rows[1].capture_id]: page(OWNER, 'dup'),
      }),
      ownerUserId: OWNER,
    });
    assert.equal(items.length, 1);
  });

  test('只看广播页，只看判定为 ok 的', async () => {
    // 封锁页与登录页**也在档案里**（那是刻意的），但页面上没有真内容。
    const rows = [
      { ...bcRow(1), verdict: 'blocked' },
      { ...bcRow(2), route_key: 'interest.movie.collect' },
      bcRow(3),
    ];
    const { items, pagesRead } = await backlogFromIndex({
      indexRows: rows,
      readPayload: reader({ [rows[2].capture_id]: page(OWNER, 'ok') }),
      ownerUserId: OWNER,
    });
    assert.equal(pagesRead, 1, '不该去读封锁页和列表页');
    assert.equal(items.length, 1);
  });

  test('**读不出来就跳过，不许把整场抓取带崩**', async () => {
    // 失败方向是安全的：漏认只会让这次少补几张，而这一步每次抓取都跑，下次还会再算。
    const rows = [bcRow(1), bcRow(2)];
    const warns = [];
    const { items } = await backlogFromIndex({
      indexRows: rows,
      readPayload: reader({ [rows[1].capture_id]: page(OWNER, 'good') }), // 第 1 条读不出来
      ownerUserId: OWNER,
      onWarn: (e) => warns.push(e),
    });
    assert.equal(items.length, 1);
    assert.equal(warns.filter((w) => w.type === 'backlog_unreadable').length, 1);
  });

  test('**改版告警要照报** —— 离线跑和在线跑是同一个抽取器', async () => {
    // 容器在、一张都没抽到 = 豆瓣改结构了。静默跳过等于宣布「这一页没有图」，
    // 而那是不可检测的丢失。
    const rows = [bcRow(1)];
    const warns = [];
    await backlogFromIndex({
      indexRows: rows,
      readPayload: reader({
        [rows[0].capture_id]: `<div class="new-status status-wrapper" data-uid="${OWNER}">
          <div class="pics-wrapper"><script>var pics = [];</script></div></div>`,
      }),
      ownerUserId: OWNER,
      onWarn: (e) => warns.push(e),
    });
    assert.equal(warns.filter((w) => w.type === 'backlog_unresolved').length, 1);
  });
});

describe('已经抓到的怎么算', () => {
  test('只认 verdict=ok 的资源行', () => {
    const have = capturedAssets([
      { route_key: 'asset.status_photo', verdict: 'ok', url: 'a' },
      { route_key: 'asset.status_photo', verdict: 'blocked', url: 'b' },
      { route_key: 'asset.subject_cover', verdict: 'ok', url: 'c' },
      { route_key: 'broadcast.timeline', verdict: 'ok', url: 'd' },
    ]);
    assert.deepEqual([...have], ['a']);
  });

  test('**按 url 比，不按 url_key**', () => {
    // 图片 URL 上的 `?imageView2/...` 是尺寸参数。归一化掉会把两个不同尺寸当成
    // 同一张，而这里问的恰恰是「这个确切的字节流有没有」。
    const rows = [{
      route_key: 'asset.status_photo', verdict: 'ok',
      url: 'https://x.doubanio.com/view/photo/large/public/p1.jpg?imageView2/2/q/80',
      url_key: 'https://x.doubanio.com/view/photo/large/public/p1.jpg',
    }];
    assert.ok(capturedAssets(rows).has(rows[0].url));
    assert.ok(!capturedAssets(rows).has(rows[0].url_key));
  });
});

describe('对着真实档案跑', () => {
  /**
   * 这一组要证明的是**这一步真的能把那 121 张找出来**——合成夹具证明不了这个，
   * 因为它证明的是我自己写的假设。
   */
  const DL = '/home/mewx/downloads/20260806';

  /** 读一份真实档案的索引与载荷。旧档案不在这台机器上就返回 null。 */
  function openReal(dir) {
    if (!existsSync(`${DL}/${dir}`)) return null;
    const idxName = readdirSync(`${DL}/${dir}`).find((f) => f.startsWith('index-'));
    if (!idxName) return null;
    const rows = readFileSync(`${DL}/${dir}/${idxName}`, 'utf-8')
      .trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { rows, dir };
  }

  test('把真实档案里欠的图全找出来，一张别人的都不带', async (t) => {
    const bundles = ['doubak-bundle-20260801T005010Z-3eef52',
      'doubak-bundle-20260804T084014Z-627045',
      'doubak-bundle-20260806T083926Z-f72157',
      'doubak-bundle-20260806T131620Z-354a1d'].map(openReal).filter(Boolean);
    if (bundles.length === 0) return t.skip('真实档案不在这台机器上');

    const { gunzipSync } = await import('node:zlib');
    /** 按 offset 解压一条 WARC 记录，取出 HTTP 正文。 */
    const payloadOf = (dir) => async (row) => {
      const fd = readFileSync(`${DL}/${dir}/${row.segment}`);
      const raw = gunzipSync(fd.subarray(row.offset, row.offset + row.length));
      const head = raw.indexOf('\r\n\r\n');
      const len = Number(/^Content-Length: (\d+)$/m.exec(raw.subarray(0, head).toString())[1]);
      const block = raw.subarray(head + 4, head + 4 + len);
      return block.subarray(block.indexOf('\r\n\r\n') + 4).toString('utf-8');
    };

    /** @type {any[]} */
    const all = [];
    const warns = [];
    let pages = 0;
    for (const b of bundles) {
      const { items, pagesRead } = await backlogFromIndex({
        indexRows: b.rows,
        readPayload: payloadOf(b.dir),
        ownerUserId: OWNER,
        alreadyHave: new Set(all.map((x) => x.url)),
        onWarn: (e) => warns.push(e),
      });
      all.push(...items);
      pages += pagesRead;
    }

    // 实测值。变了就说明抽取器或档案变了——两者都该被看见。
    assert.equal(all.length, 121, `算出 ${all.length} 张，实测应为 121`);
    assert.ok(pages >= 170, `只读了 ${pages} 张广播页`);
    assert.equal(warns.filter((w) => w.type === 'backlog_unresolved').length, 0,
      '真实档案上报了改版告警');

    // 每一条都得能追溯回它出自哪次捕获，而且那次捕获在别的档案里。
    for (const it of all) {
      assert.match(it.parentCaptureId, /^\d{8}T\d{6}Z-[0-9a-f]{6}#\d{6}$/);
      assert.match(it.referer, /\/statuses\?p=\d+$/);
      assert.equal(it.routeKey, 'asset.status_photo');
    }
    // 全是本人上传的原图，一张缩略版都没有。
    for (const it of all) {
      assert.doesNotMatch(it.url, /\/(small|medium|ismall)\//, it.url);
    }
  });

  test('这些图确实一张都还没抓到 —— 所以补抓不是白跑', async (t) => {
    const b = openReal('doubak-bundle-20260806T131620Z-354a1d');
    if (!b) return t.skip('真实档案不在这台机器上');
    assert.equal(capturedAssets(b.rows).size, 0,
      '最新那份档案里已经有图了，那这条测试的前提就不成立了');
  });
});

describe('接线：runner 与 offscreen', () => {
  test('runner 把补抓项排进队，并把来源传成 enqueuedBy', async () => {
    // **必须显式传 enqueuedBy。** loop 里的兜底是
    // `item.enqueuedBy ?? this._lastCapture.get(routeKey) ?? null`——不传的话
    // parent 会落到同路线上随便一次捕获，比 null 还糟：那是伪造的来源，
    // 而且会污染离线重建出来的抓取图。
    const src = readFileSync(new URL('../src/crawl/runner.js', import.meta.url), 'utf-8');
    const block = src.slice(src.indexOf('if (backlogAssets?.length)'));
    assert.ok(block.length > 0, 'runner 里没有排队那一段');
    assert.match(block.slice(0, 1200), /enqueuedBy: it\.parentCaptureId/);
    assert.match(block.slice(0, 1200), /referer: it\.referer/);
    assert.match(block.slice(0, 1200), /gatedBy: null/);
    assert.match(block.slice(0, 1200), /type: 'backlog_queued'/);
  });

  test('offscreen 按**账号**取档案，不按链', async () => {
    // 与 knownSubjects 同一个理由：图片没有时间序，链对它毫无意义。按链算的话，
    // previous_bundle_id 为 null 的档案各自成链，存量图会直接失踪。
    const src = readFileSync(new URL('../src/offscreen/offscreen.js', import.meta.url), 'utf-8');
    // 同上：断言性质，不钉死那一行的写法。
    assert.match(src, /const mine = bundlesWithKnownSubjects\(entries, me\)/);
    assert.match(src, /backlogAssets\(mine, me\.accountUserId\)/);
    assert.equal(src.includes('backlogAssets(chainOf('), false, '别按链取');
  });

  test('offscreen 读不出档案时不抛，只跳过', async () => {
    const src = readFileSync(new URL('../src/offscreen/offscreen.js', import.meta.url), 'utf-8');
    const fn = src.slice(src.indexOf('async function backlogAssets'));
    assert.match(fn.slice(0, 2000), /catch \(err\)/);
    assert.match(fn.slice(0, 2000), /存量图这次不补/);
  });

  test('界面上要说清这些请求是哪来的', () => {
    // panel.js 里的 describeEvent 没有导出、也离不开 document，所以只能断言源码
    // ——与 ui.test.js 里那一批是同一个做法。（真要测得动，得像 route-names.js
    // 那样把文案逻辑抽成单独模块；那是另一件事。）
    const src = readPanelSourceSync();
    const at = src.indexOf("e.type === 'backlog_queued'");
    assert.ok(at > 0, '面板里没有处理 backlog_queued');
    const msg = src.slice(at, at + 400);
    // 增量的心理预期是「只抓新增的」，突然多出上百个请求，不解释就像跑飞了。
    assert.match(msg, /\$\{e\.count\}/);
    assert.match(msg, /存下来的旧页面/);
    assert.match(msg, /不需要重抓/);
    assert.ok(src.includes("e.type === 'backlog_unresolved'"), '改版告警没有对应文案');
  });
});
