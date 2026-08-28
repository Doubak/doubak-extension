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
/** 链上更早的那一份。用来验「只看选中的这一份」。 */
const OLDER = '20260731T043423Z-d40c1d';
const UID = '1000001';
/** 用户自己写的那句话。整组测试真正盯着的就是它。 */
const MY_COMMENT = '这部片子救了我那个夏天';
/** 只在上游那一份里出现的话。它出现在页面上就说明读串了。 */
const OLD_COMMENT = '这句话只在上一份档案里';
const DOULIST_TITLE = '游戏购买小账本';
/** 广播指向的那部作品。要认的正是它，而不是「看过」。 */
const SUBJECT_TITLE = '欢迎来龙餐馆';

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
function broadcastPage(text = MY_COMMENT) {
  return `<html><head><title>我的动态</title></head><body>
<div id="db-global-nav"><a href="https://www.douban.com/people/mewx/">mewx</a></div>
<div id="db-usr-profile"><div class="info"><h1>mewx</h1></div></div>
<div class="stream-items">
  <div class="new-status status-wrapper" data-sid="900001" data-uid="${UID}">
    <a class="lnk-people">mewx</a> 看过
    <span class="created_at" title="2026-07-26 12:34:00">7月26日</span>
    <blockquote><p>${text}</p></blockquote>
    ${subjectCard(SUBJECT_TITLE)}
    <div data-target-type="movie" data-object-id="36838707"></div>
  </div>
</div></body></html>`;
}

/**
 * 广播下面那张作品卡。
 *
 * **从真实档案里抄的**（`20260814T223824Z-4b82f3` 的广播页），不是照印象编的：
 * `div.block.block-subject` → `div.content` → `div.title` → 里面那个 `<a>`。
 * 抽取器只认链接文字——条目被豆瓣移除时这里是一段没有链接的「未知条目」，
 * 那是占位符，占位符不是内容。
 */
function subjectCard(title) {
  return '<div class="bd movie"><div class="block block-subject">'
    + '<div class="pic"><a href="https://movie.douban.com/subject/35811064/" class="media">'
    + '<img src="https://img3.doubanio.com/view/status/small/public/x.jpg"></a></div>'
    + '<div class="content"><div class="title">'
    + `<a href="https://movie.douban.com/subject/35811064/" target="_blank">${title}</a>`
    + '</div></div></div></div>';
}

/**
 * 一份豆列的一页。
 *
 * **结构照 `test/vendor.test.js` 里那份写**——容器上 `id` 在 `class`
 * 前面，真实页面就是这样，而抽取器的切片正是从 `<div` 开始的。那一份已经跑通过
 * 抽取器，所以不是凭想象编的。
 *
 * @param {{title: string, comment?: string}[]} items
 * @param {number} start  这一页从第几条起（豆列翻页写在 `?start=` 里）
 */
function doulistPage(items, start = 0) {
  const rows = items.map((it, i) => `<div id="77034${start + i}" class="doulist-item" >`
    + `<a data-id="3023${start + i}" data-cate="3114"`
    + ` data-url="https://www.douban.com/subject/3023${start + i}/"`
    + ` data-title="${it.title}" class="lnk-doulist-add"></a>`
    + (it.comment ? `<blockquote class="comment"><span>评语：</span>${it.comment}</blockquote>` : '')
    + '</div>').join('');
  return `<html><body><div id="doulist-info"><h1>${DOULIST_TITLE}</h1>`
    + `<div class="doulist-about">我的信仰值有多少</div></div>${rows}</body></html>`;
}

/**
 * 造一份**真的**能被 readEntry 读开的档案。
 *
 * 一页一条 gzip member 首尾相接——这正是段文件的真实形状，index 里的
 * `offset`/`length` 也就必须一页页累加。
 *
 * @param {{intent: string, url: string, html: string}[]} pages
 * @param {{id?: string, previous?: string|null}} [opts]
 */
async function bundleFrom(pages, { id = ID, previous = null } = {}) {
  const segment = `pages-${id}-00001.warc.gz`;
  const members = [];
  const lines = [];
  let offset = 0;

  for (const [i, page] of pages.entries()) {
    const block = buildHttpResponseBlock({
      statusLine: 'HTTP/1.1 200 OK',
      headers: [['Content-Type', 'text/html; charset=utf-8']],
      body: new TextEncoder().encode(page.html),
    });
    const member = await gzipMember(buildWarcRecord({
      type: 'response',
      recordId: `urn:uuid:11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
      date: new Date('2026-08-01T01:00:00Z'),
      targetUri: page.url,
      block,
    }));
    lines.push(JSON.stringify({
      capture_id: `${id}#${String(i + 1).padStart(6, '0')}`,
      route_key: page.intent,
      intent: page.intent,
      url: page.url,
      url_key: page.url.replace(/^https:\/\//, ''),
      observed_at: '2026-08-01T01:00:00Z',
      verdict: 'ok',
      offset,
      length: member.length,
      segment,
    }));
    members.push(member);
    offset += member.length;
  }

  const bytes = new Uint8Array(offset);
  let at = 0;
  for (const m of members) { bytes.set(m, at); at += m.length; }

  return {
    'manifest.json': JSON.stringify({
      bundle_id: id,
      status: 'complete',
      created_at: bundleIdTime(id).toISOString(),
      completed_at: '2026-08-01T02:00:00Z',
      previous_bundle_id: previous,
      // 广播抽取要靠它滤掉转发进来的别人的广播。
      account: { user_id: UID, username: 'mewx' },
      segments: [{ filename: segment, bytes: bytes.length }],
      index: { filename: `index-${id}.ndjson`, line_count: pages.length },
      crawl_state: [],
      coverage: [],
    }),
    [`index-${id}.ndjson`]: `${lines.join('\n')}\n`,
    [segment]: bytes,
  };
}

/** n 张一模一样的广播页。 */
function realBundle(pages = 1, { id = ID, text = MY_COMMENT, previous = null } = {}) {
  return bundleFrom(
    Array.from({ length: pages }, (_, i) => ({
      intent: 'broadcast.timeline',
      url: `https://www.douban.com/people/mewx/statuses?p=${i + 1}`,
      html: broadcastPage(text),
    })),
    { id, previous },
  );
}

/**
 * @param {object} [o]
 * @param {number} [o.pages]
 * @param {boolean} [o.withOlder]  再放一份上游档案（用来验「只看这一份，不看整条链」）
 * @param {object[]} [o.files]  直接给一份档案的文件表，用来测广播以外的路线
 */
async function openWithContent({ pages = 1, withOlder = false, files = null } = {}) {
  const worker = fakeOpfsWorker();
  if (withOlder) {
    await seedBundle(worker, `doubak-bundle-${OLDER}`,
      await realBundle(1, { id: OLDER, text: OLD_COMMENT }));
  }
  const store = await seedBundle(worker, `doubak-bundle-${ID}`,
    files ?? await realBundle(pages, { previous: withOlder ? OLDER : null }));

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

/**
 * 等到界面不再变化。理由与 ui-import 那组相同：这条路径没有可观测的完成信号。
 *
 * **「不再变化」不等于「做完了」**，而这里有一处真实的例外：解析期间界面上一直写着
 * 「正在解析 广播…」，一个字都不变。31 页那条用例因此拿到了占位文字就返回，
 * 报的却是「children[0] 是 undefined」——离真正的原因很远。
 *
 * 那句占位文字**就是**完成信号的反面，所以直接认它：还写着就继续等。
 */
async function settle(dom, { timeoutMs = 5000 } = {}) {
  const snap = () => [
    dom.byId.get('content-list')?.textContent ?? '',
    dom.byId.get('captures')?.textContent ?? '',
    dom.byId.get('preview')?.textContent ?? '',
    dom.byId.get('archive-summary')?.textContent ?? '',
  ].join('|');
  let last = null; let stable = 0;
  const t0 = Date.now();
  for (;;) {
    const now = snap();
    const working = now.startsWith('正在解析');
    stable = (now === last && !working) ? stable + 1 : 0;
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

  test('**广播这一行的标题是作品名，不是「看过」**', async () => {
    // 报上来的现象：一列「想看 / 想看 / 想看 / 玩过」——除了顺序之外什么都没说，
    // 而人要认的恰恰是想看的**是哪一部**。动作退到下面那行，与时间、星级并列。
    const { dom } = await openWithContent();
    try {
      dom.byId.get('content-toggle').dispatch('click', {});
      await settle(dom);

      const row = dom.byId.get('content-list').querySelectorAll('.content-item')[0];
      assert.ok(row, '一条都没画出来');
      assert.equal(row.querySelector('.t').textContent, SUBJECT_TITLE, '标题不是作品名');
      assert.match(row.querySelector('.m').textContent, /看过/, '动作要退到第二行，不是丢掉');
      assert.match(row.querySelector('.m').textContent, /2026-07-26/);
    } finally {
      dom.restore();
    }
  });

  test('**互斥**：点内容会把捕获收起来', async () => {
    const { dom } = await openWithContent();
    try {
      // 捕获默认就开着，不用先点。
      assert.equal(dom.byId.get('captures-section').hidden, false, '前提：捕获是开着的');

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

  test('**页数写明单位，条数在解析完之后才报**', async () => {
    // 报上来的现象：类别按钮写着「广播（173）标记（244）」，读起来像是 173 条广播
    // ——而那 173 是**页数**，一份真档案里那些页装着好几千条。index 里现成有的就是
    // 页数，条数非解析不可知，所以两个数各归各位、各带各的说法。
    const { dom } = await openWithContent({ pages: 2 });
    try {
      dom.byId.get('content-toggle').dispatch('click', {});
      await settle(dom);

      assert.match(dom.byId.get('content-kinds').textContent, /广播（2 页）/,
        '这个数是页数，不带单位会被读成条数');

      const list = dom.byId.get('content-list');
      // 抽查的范围要在**清单最上面**：缀在末尾的话，滚到底才知道自己看的不是全部。
      assert.match(list.children[0].className, /content-scope/, '范围那句话不在第一行');
      assert.match(list.children[0].textContent, /解析了全部 2 页，列出 2 条/);
    } finally {
      dom.restore();
    }
  });

  test('**超过上限时说清楚只解析了前几页**', async () => {
    // 31 页真的造出来跑一遍，而不是断言一句文案：上限那条分支要真的走到，
    // 才谈得上验证它说的数对不对。
    const { dom, segRead } = await openWithContent({ pages: 31 });
    try {
      dom.byId.get('content-toggle').dispatch('click', {});
      await settle(dom);

      const scope = dom.byId.get('content-list').children[0];
      assert.match(scope.textContent, /解析了前 30 页（共 31 页），列出 30 条/);
      assert.match(scope.textContent, /抽查/, '要说清这不是完整阅读');
      // 而且**真的只解析了 30 页**：多出来的那一页一个字节都没取。
      // 数的是段文件的取值次数（`readEntry` 按 offset/length 取一段，不是整段文件）。
      assert.equal(segRead.n, 30, '上限只写在文案里，实际还是把 31 页都解析了');
    } finally {
      dom.restore();
    }
  });

  test('**一份豆列的三页拼成一条，不是三条**', async () => {
    // 报上来的现象：豆列那一栏「内容重复了」。其实不是重复——一份豆列每页 25 条，
    // 而这里**一页画一行**，于是同一份豆列出现好几次，条数还各不相同（25 / 25 / 8），
    // 末尾那几页甚至是 0 条。读起来像重复，也像三份同名的豆列，两种读法都不对。
    //
    // 别的路线没有这个问题：一页标记列表里的十五个标记本来就是十五条记录，页与页
    // 之间没有关系。**豆列是唯一一个「一条记录横跨几页」的**。
    const base = 'https://www.douban.com/doulist/45473911/';
    const files = await bundleFrom([
      { intent: 'doulist.item', url: base, html: doulistPage([{ title: '巫师3', comment: 'A$23.99' }], 0) },
      {
        intent: 'doulist.item',
        url: `${base}?start=25`,
        html: doulistPage([{ title: '塞伯利亚' }, { title: '围攻', comment: '夏促 ¥18' }], 25),
      },
      // 末页空的：翻页的正常终点，它不该在界面上变成一份「0 个条目」的豆列。
      { intent: 'doulist.item', url: `${base}?start=50`, html: doulistPage([], 50) },
    ]);

    const { dom } = await openWithContent({ files });
    try {
      dom.byId.get('content-toggle').dispatch('click', {});
      await settle(dom);

      const items = dom.byId.get('content-list').querySelectorAll('.content-item');
      assert.equal(items.length, 1, `一份豆列画成了 ${items.length} 行`);
      assert.match(items[0].textContent, new RegExp(`${DOULIST_TITLE}`));
      // **没写评语的条目也要列出来。** 只列有评语的那些，会让一份从没写过评语的
      // 豆列（实测 6 份里有 3 份）在这一页上只剩标题和两个数字，看着像没解析出来
      // ——而站点那边把条目都渲染了。选了哪些本身就是用户编的。
      assert.match(items[0].textContent, /塞伯利亚/, '没有评语的条目被丢掉了');
      assert.match(items[0].textContent, /围攻：夏促 ¥18/, '有评语的要跟在标题后面');
      // 「由 2 页拼成」不是 3：末尾那页是空的，它属于抓取过程，不属于这份豆列。
      // 实测一份只有 1 个条目的豆列后面跟着两页空的（没有翻页器，只能靠要一页
      // 拿回空的才知道到头），写成「由 3 页拼成」会让人以为那是一份三页的豆列。
      assert.match(items[0].textContent, /3 个条目 · 2 条评语 · 由 2 页拼成/);
      // 顺序是内容的一部分：按 start 升序拼，不按抓取顺序。
      assert.ok(items[0].textContent.indexOf('巫师3') < items[0].textContent.indexOf('围攻'),
        '页序错了 —— 用户排过的清单，换了次序就是改了内容');

      assert.match(dom.byId.get('content-list').children[0].textContent, /解析了全部 3 页，列出 1 条/);
    } finally {
      dom.restore();
    }
  });

  test('**原文预览的元信息是一栏，不是两列表格**', async () => {
    // 两列在四百来点宽的地方两头一起塌：名字被挤成一字一行（「抓取原因」竖排成
    // 四行），值那一列还是不够宽，URL 与段文件名直接被切掉——切掉不是出现滚动条，
    // 是静静地少了字。「翻看捕获」挪进右栏之后正是这个宽度。
    const { dom } = await openWithContent();
    try {
      dom.byId.get('captures-toggle').dispatch('click', {});
      await settle(dom);
      const row = dom.byId.get('captures').querySelectorAll('div[data-id]')[0];
      assert.ok(row, '前提：捕获列表里要有一行可点');
      // 那一行挂的是 `onclick`（一行一个处理器），不是委托到列表上的监听器，
      // 所以这里直接调它——`dispatch('click')` 走的是 addEventListener 那一路。
      assert.equal(typeof row.onclick, 'function', '这一行根本没绑点击');
      row.onclick();
      await settle(dom);

      const preview = dom.byId.get('preview');
      assert.equal(preview.querySelectorAll('table').length, 0, '又变回两列表格了');
      const dl = preview.querySelector('dl');
      assert.ok(dl, '元信息没画出来');
      assert.match(dl.textContent, /所在段/);
      assert.match(dl.textContent, /douban\.com/, 'URL 要完整地在里面');
    } finally {
      dom.restore();
    }
  });

  test('**只看选中的这一份，不看整条链**', async () => {
    // 页面上那句说明写着「范围仅限当前选中的这一份档案」。它现在成立是因为
    // `BundleReader.index()` 读的就是一个目录里的一个 index 文件——**成立得有点
    // 顺手**，而顺手成立的事没有任何东西拦着它以后不成立。
    //
    // 所以放一份上游进去：它只有一句别的话，一旦出现在页面上就是读串了链。
    const { dom } = await openWithContent({ withOlder: true });
    try {
      // 前提：那一份**真的在存储里**。不验的话，夹具没造出来也会让下面全绿。
      assert.equal(dom.byId.get('bundle-pick').querySelectorAll('.picker-row').length, 2,
        '上游那一份没被放进去，这条判据就什么都没验');

      dom.byId.get('content-toggle').dispatch('click', {});
      await settle(dom);

      const list = dom.byId.get('content-list').textContent;
      assert.match(list, new RegExp(MY_COMMENT), '前提：选中的这一份要读得出来');
      assert.equal(list.includes(OLD_COMMENT), false,
        '上一份档案的内容混进来了 —— 那句「范围仅限当前选中的这一份」就成了假话');
      assert.match(dom.byId.get('content-kinds').textContent, /广播（1 页）/,
        '页数把整条链算进去了');
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
