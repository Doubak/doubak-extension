/**
 * 「查看内容」：从点开到看见自己写的字，整条路走一遍。
 *
 * ## 为什么这一组要用**真的 gzip 过的 WARC**
 *
 * 档案页那组测试的段文件是字面量 `'aaaa'`——对「翻看捕获」够用（它只读 index），
 * 但内容这一块要**真的把字节取出来解压再抽取**。拿假字节测，`readEntry` 会抛，
 * 而那条路径上的错误是被吞掉计入「没能解析出内容」的，于是测试看着绿、功能没验着。
 *
 * 所以这里老老实实用 `buildWarcRecord` + `gzipMember` 造一段真的。
 *
 * ## 判据是「自己写的字出现在页面上」
 *
 * 这一页存在的理由不是「列出条目」，是**让人确认抓到的确实是自己的东西**。所以
 * 断言盯的是那句短评本身，不是条数。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeDom, readRepoFile } from './helpers/fake-dom.js';
import { fakeOpfsWorker, seedBundle } from './helpers/fake-opfs-worker.js';
import { buildWarcRecord, buildHttpResponseBlock, gzipMember } from '../src/core/warc.js';
import { bundleIdTime } from '../src/core/ids.js';

const ID = '20260801T005010Z-3eef52';
const UID = '1000001';
/** 用户自己写的那句话。整组测试真正盯着的就是它。 */
const MY_COMMENT = '这部片子救了我那个夏天';

/**
 * 一页只有一条广播的时间线，带正文。
 *
 * **结构照解析器那边的测试写**（`doubak-data-parser/test/broadcast.test.js`），
 * 那是对着真实字节校准过的：`div.new-status.status-wrapper` + `data-sid` +
 * `data-uid` + `span.created_at[title]` + `blockquote > p`。
 *
 * 第一版是**照着印象自己编的**（`div.status-item` 套 `div.status-saying`），
 * 抽取器一条都认不出来——而这正是这个仓库反复栽的那个跟头：凭想象写选择器。
 * 用例这一侧也一样，编出来的夹具只会验证当初的想象。
 */
function broadcastPage() {
  return `<html><head><title>我的动态</title></head><body>
<div id="db-global-nav"><a href="https://www.douban.com/people/mewx/">mewx</a></div>
<div id="db-usr-profile"><div class="info"><h1>mewx</h1></div></div>
<div class="stream-items">
  <div class="new-status status-wrapper" data-sid="900001" data-uid="${UID}">
    <a class="lnk-people">mewx</a> 看过
    <span class="created_at" title="2026-07-26 12:34:00">7月26日</span>
    <blockquote><p>${MY_COMMENT}</p></blockquote>
    <div data-target-type="movie" data-object-id="36838707"></div>
  </div>
</div></body></html>`;
}

/** 造一份**真的**能被 readEntry 读开的档案。 */
async function realBundle() {
  const body = new TextEncoder().encode(broadcastPage());
  const block = buildHttpResponseBlock({
    statusLine: 'HTTP/1.1 200 OK',
    headers: [['Content-Type', 'text/html; charset=utf-8']],
    body,
  });
  const record = buildWarcRecord({
    type: 'response',
    recordId: 'urn:uuid:11111111-1111-4111-8111-111111111111',
    date: new Date('2026-08-01T01:00:00Z'),
    targetUri: 'https://www.douban.com/people/mewx/statuses',
    block,
  });
  const member = await gzipMember(record);
  const segment = `pages-${ID}-00001.warc.gz`;

  return {
    'manifest.json': JSON.stringify({
      bundle_id: ID,
      status: 'complete',
      created_at: bundleIdTime(ID).toISOString(),
      completed_at: '2026-08-01T02:00:00Z',
      previous_bundle_id: null,
      // 广播抽取要靠它滤掉转发进来的别人的广播。
      account: { user_id: UID, username: 'mewx' },
      segments: [{ filename: segment, bytes: member.length }],
      index: { filename: `index-${ID}.ndjson`, line_count: 1 },
      crawl_state: [],
      coverage: [],
    }),
    [`index-${ID}.ndjson`]: `${JSON.stringify({
      capture_id: `${ID}#000001`,
      route_key: 'broadcast.timeline',
      intent: 'broadcast.timeline',
      url: 'https://www.douban.com/people/mewx/statuses',
      url_key: 'douban.com/people/mewx/statuses',
      observed_at: '2026-08-01T01:00:00Z',
      verdict: 'ok',
      offset: 0,
      length: member.length,
      segment,
    })}\n`,
    [segment]: member,
  };
}

async function openWithContent() {
  const worker = fakeOpfsWorker();
  const store = await seedBundle(worker, `doubak-bundle-${ID}`, await realBundle());

  // 数一数段文件被读了几次。**「有没有解析」要看有没有真去读字节**，
  // 而不是看界面上有没有字——假 DOM 不从 HTML 里带初始文本，那条判据是假的。
  const segRead = { n: 0 };
  const origRead = store.read.bind(store);
  store.read = (name, ...rest) => {
    if (String(name).startsWith('pages-')) segRead.n += 1;
    return origRead(name, ...rest);
  };

  const html = await readRepoFile('src/ui/panel.html');
  const dom = await installFakeDom({
    html,
    onMessage: (msg) => {
      if (msg.type === 'status') return { ok: true, running: false, checkpoint: null, runner: { active: false } };
      if (msg.type === 'preflight') {
        return { ok: true, permissions: { granted: true, missing: [] }, storage: null, incremental: null };
      }
      if (msg.type === 'exportRecords') return { ok: true, exportedAt: {} };
      return { ok: true };
    },
    extra: {
      Worker: function FakeWorkerCtor() { return worker; },
      navigator: { storage: { estimate: async () => ({ usage: 0, quota: 100e9 }) } },
    },
  });

  await import(`../src/ui/panel.js?t=${Date.now()}${Math.random()}`);
  await settle(dom);
  dom.byId.get('tabs').dispatch('click', {
    target: { closest: () => ({ dataset: { tab: 'archive' } }) },
  });
  await settle(dom);
  return { dom, worker, segRead };
}

/** 等到界面不再变化。理由与 ui-import 那组相同：这条路径没有可观测的完成信号。 */
async function settle(dom, { timeoutMs = 5000 } = {}) {
  const snap = () => [
    dom.byId.get('content-list')?.textContent ?? '',
    dom.byId.get('captures')?.textContent ?? '',
    dom.byId.get('archive-summary')?.textContent ?? '',
  ].join('|');
  let last = null; let stable = 0;
  const t0 = Date.now();
  for (;;) {
    const now = snap();
    stable = now === last ? stable + 1 : 0;
    last = now;
    if (stable >= 2) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('等太久，界面还在动');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('查看内容（真的跑一遍）', () => {
  test('**点开之后能看见自己写的那句话**', async () => {
    const { dom } = await openWithContent();
    try {
      const btn = dom.byId.get('content-toggle');
      assert.equal(dom.byId.get('content-section').hidden, true, '默认该收着');

      btn.dispatch('click', {});
      await settle(dom);

      assert.equal(dom.byId.get('content-section').hidden, false);
      assert.equal(btn.getAttribute('aria-selected'), 'true');
      // 这一页存在的全部理由。
      assert.match(dom.byId.get('content-list').textContent, new RegExp(MY_COMMENT),
        '解析出来了，但自己写的那句话没显示出来 —— 那这一页就没有意义了');
    } finally {
      dom.restore();
    }
  });

  test('**互斥**：点内容会把捕获收起来', async () => {
    const { dom } = await openWithContent();
    try {
      dom.byId.get('captures-toggle').dispatch('click', {});
      await settle(dom);
      assert.equal(dom.byId.get('captures-section').hidden, false);

      dom.byId.get('content-toggle').dispatch('click', {});
      await settle(dom);
      assert.equal(dom.byId.get('captures-section').hidden, true, '两块同时摊开会把这一页撑爆');
      assert.equal(dom.byId.get('content-section').hidden, false);
      assert.equal(dom.byId.get('captures-toggle').getAttribute('aria-selected'), 'false');
    } finally {
      dom.restore();
    }
  });

  test('再点一下收起来，两块都不显示', async () => {
    // 「都不选」是合法状态：这一页已经很满，而展开内容要花解析的时间。
    const { dom } = await openWithContent();
    try {
      const btn = dom.byId.get('content-toggle');
      btn.dispatch('click', {});
      await settle(dom);
      btn.dispatch('click', {});
      await settle(dom);
      assert.equal(dom.byId.get('content-section').hidden, true);
      assert.equal(btn.getAttribute('aria-selected'), 'false');
      assert.equal(btn.getAttribute('title'), null, '收起来之后不该还挂着「再点一下收起」');
    } finally {
      dom.restore();
    }
  });

  test('**收着的时候一个字节都不解析**', async () => {
    // 展开才付钱。点一份档案就顺手解析一遍的话，翻档案会变得很卡，
    // 而多数时候用户只是想看看它多大、导出过没有。
    const { dom, segRead } = await openWithContent();
    try {
      assert.equal(segRead.n, 0, '还没点开就已经去读段文件了');

      dom.byId.get('content-toggle').dispatch('click', {});
      await settle(dom);
      // 点开之后才读——这一半同样要验，否则「一直是 0」也能让上一条绿。
      assert.ok(segRead.n > 0, '点开了却没去读段文件，那上面那条断言就没有意义');
    } finally {
      dom.restore();
    }
  });
});
