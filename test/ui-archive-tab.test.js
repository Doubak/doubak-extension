/**
 * 档案页**真的跑一遍**——带一个会答复的假 OPFS Worker。
 *
 * ## 为什么非要执行不可
 *
 * 面板里凡是碰存储的那几块，此前一次都没被执行过：`WorkerFileStore` 发消息出去等
 * 答复，而假 DOM 里的 `Worker` 是个空壳，那个 Promise 永远不落地。于是它们只被
 * `node --check` 看过语法。
 *
 * 代价刚刚兑现过一次。存储页里有这么一行：
 *
 *     setStorageUsage(summarizeBundles)({ dirs, … })
 *
 * 括号打错了位置。语法合法；`test/ui-modules.test.js` 的作用域检查也发现不了——
 * 它是「调用一次调用的结果」，名字一个都没少。真实后果是**整页打不开**，一直显示
 * 「统计不出来：setStorageUsage(...) is not a function」。
 *
 * 这类错只有一种抓法：把它跑起来，然后看屏幕上写了什么。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeDom, readRepoFile } from './helpers/fake-dom.js';
import { fakeOpfsWorker, seedBundle } from './helpers/fake-opfs-worker.js';
import { bundleIdTime } from '../src/core/ids.js';

let cacheBust = 0;
const ID = '20260801T005010Z-3eef52';
const OLDER = '20260731T043423Z-d40c1d';

/** 一份长得像真档案的目录。 */
function bundleFiles(id, { previous = null } = {}) {
  return {
    'manifest.json': JSON.stringify({
      bundle_id: id,
      status: 'complete',
      // **每一份用自己的时刻**：写死同一个的话，任何按时间排序的判据都是假绿的。
      created_at: bundleIdTime(id).toISOString(),
      completed_at: '2026-08-01T02:00:00Z',
      previous_bundle_id: previous,
      account: { user_id: '1000001', username: 'mewx' },
      segments: [{ filename: `pages-${id}-00001.warc.gz`, bytes: 4 }],
      index: { filename: `index-${id}.ndjson`, line_count: 1 },
      crawl_state: [],
      coverage: [],
    }),
    // **索引里要真有一行。** 空索引会让「翻看捕获」变灰，于是点击测试点的是空气
    // ——而假 DOM 不认 disabled，那种测试会一路绿到底。
    [`index-${id}.ndjson`]: `${JSON.stringify({
      capture_id: `${id}#000001`,
      route_key: 'broadcast.timeline',
      url: 'https://www.douban.com/people/mewx/statuses',
      url_key: 'douban.com/people/mewx/statuses',
      observed_at: '2026-08-01T01:00:00Z',
      verdict: 'ok',
      length: 4,
      segment: `pages-${id}-00001.warc.gz`,
    })}\n`,
    [`pages-${id}-00001.warc.gz`]: 'aaaa',
  };
}

/**
 * 装好面板，切到档案页，等它读完。
 *
 * @param {object} [opts]
 * @param {Record<string, object>} [opts.bundles]  目录名 → 文件表
 * @param {(msg: object) => any} [opts.onMessage]
 */
async function openArchiveTab({ bundles = {}, onMessage } = {}) {
  const worker = fakeOpfsWorker();
  for (const [dir, files] of Object.entries(bundles)) await seedBundle(worker, dir, files);

  const html = await readRepoFile('src/ui/panel.html');
  const dom = await installFakeDom({
    html,
    onMessage: onMessage ?? ((msg) => {
      if (msg.type === 'status') {
        return { ok: true, running: false, checkpoint: null, runner: { active: false } };
      }
      if (msg.type === 'preflight') {
        return {
          ok: true,
          permissions: { granted: true, missing: [] },
          storage: { usage: 0, quota: 100e9, available: 100e9, need: 1.2e9, enough: true },
        };
      }
      if (msg.type === 'exportRecords') return { ok: true, exportedAt: {} };
      return { ok: true };
    }),
    // 面板里每个 `new Worker(...)` 都拿到同一个假货 —— 与真实情况一致
    // （`getOpfsWorker()` 本来就是全页共用一个）。
    extra: { Worker: function FakeWorkerCtor() { return worker; } },
  });

  await import(`../src/ui/panel.js?t=${++cacheBust}`);
  await new Promise((r) => setTimeout(r, 5));

  // 点「档案」
  dom.byId.get('tabs').dispatch('click', {
    target: { closest: () => ({ dataset: { tab: 'archive' } }) },
  });
  await new Promise((r) => setTimeout(r, 20));
  return { dom, worker };
}

describe('档案页（真的跑一遍）', () => {
  test('**占用那一行真的画出来了** —— 而不是「统计不出来：…」', async () => {
    const { dom } = await openArchiveTab({
      bundles: { [`doubak-bundle-${ID}`]: bundleFiles(ID) },
    });
    try {
      const t = dom.byId.get('storage').textContent;
      assert.equal(/统计不出来/.test(t), false, `存储那一行报了错：${t}`);
      assert.match(t, /1 份/);
      assert.match(t, /没有导出记录/, '「未导出」必须显眼 —— 那是「删了就没了」的意思');
    } finally {
      dom.restore();
    }
  });

  test('导出过的就不再吓唬人', async () => {
    const { dom } = await openArchiveTab({
      bundles: { [`doubak-bundle-${ID}`]: bundleFiles(ID) },
      onMessage: (msg) => {
        if (msg.type === 'status') return { ok: true, running: false, checkpoint: null, runner: { active: false } };
        if (msg.type === 'preflight') return { ok: true, permissions: { granted: true, missing: [] }, storage: null };
        if (msg.type === 'exportRecords') return { ok: true, exportedAt: { [ID]: '2026-08-02T10:00:00Z' } };
        return { ok: true };
      },
    });
    try {
      assert.match(dom.byId.get('storage').textContent, /全部导出过/);
    } finally {
      dom.restore();
    }
  });

  test('一份档案都没有时，说的是**下一步**，不是一句「空」', async () => {
    const { dom } = await openArchiveTab();
    try {
      const t = dom.byId.get('storage').textContent;
      assert.match(t, /导入/, '空列表要指向导入 —— 换过机器的用户打开这页时看到的就是这里');
      assert.equal(dom.byId.get('delete-all').disabled, true, '没东西可删时按钮该是灰的');
    } finally {
      dom.restore();
    }
  });

  test('档案摘要与选择器都读出来了', async () => {
    const { dom } = await openArchiveTab({
      bundles: {
        [`doubak-bundle-${ID}`]: bundleFiles(ID, { previous: OLDER }),
        [`doubak-bundle-${OLDER}`]: bundleFiles(OLDER),
      },
    });
    try {
      assert.match(dom.byId.get('archive-summary').textContent, new RegExp(ID));
      assert.match(dom.byId.get('archive-summary').textContent, /mewx/);
      // 增量那张卡要出现，而且说的是它自己的上游
      assert.match(dom.byId.get('archive-incremental').textContent, new RegExp(OLDER));
      // 两份以上才画选择器
      assert.match(dom.byId.get('bundle-pick').textContent, /3eef52/);
    } finally {
      dom.restore();
    }
  });

  test('**左边清单要标出现在开着的是哪一份**', async () => {
    // 画列表发生在**决定开哪一份之前**：那时 `currentBundleId` 还是 null，于是
    // 整张列表一行都不高亮，而右边已经显示着某一份的内容。用户看到的是
    // 「右边有东西，左边看不出是哪一行」——点回那一行还没有任何反应（它本来就是
    // 当前那份），于是像坏了。
    const { dom } = await openArchiveTab({
      bundles: {
        [`doubak-bundle-${ID}`]: bundleFiles(ID),
        [`doubak-bundle-${OLDER}`]: bundleFiles(OLDER),
      },
    });
    try {
      const rows = dom.byId.get('bundle-pick').querySelectorAll('.picker-row');
      assert.equal(rows.length, 2, '两份档案该画出两行');
      const on = rows.filter((r) => r.getAttribute('aria-selected') === 'true');
      assert.equal(on.length, 1, `高亮的行有 ${on.length} 行，该正好 1 行`);
      assert.equal(on[0].dataset.id, ID, '高亮的该是右边正在显示的那一份（最新的）');
    } finally {
      dom.restore();
    }
  });

  test('**正在抓的那一份要排在最上面** —— 它没有 manifest，也就没有时间', async () => {
    // 报上来的现象：抓取跑着的时候，上面那行写「17 份 · 462.7 MB」，而左边清单里
    // 找不到正在抓的那一份。看起来像清单没刷新——**清单其实是新的**。
    //
    // manifest 是收尾时才写的，所以进行中的那一份读不出 `created_at`，排序键成了
    // 空字符串，比任何真实时间都小，于是它沉到十七行的最底下；当时侧栏还是 70vh
    // 带滚动的，它就落在看不见的地方。而右边默认打开的偏偏就是它。
    //
    // 侧栏后来不滚了（见 panel.css），但**这条判据照旧要留**：顺序本身就是错的，
    // 「看得见」只是把它从「找不到」降成「要多滚一会儿」。
    const { dom } = await openArchiveTab({
      bundles: {
        // 新的那一份还在抓：只有段文件与索引，没有 manifest
        [`doubak-bundle-${ID}`]: {
          [`index-${ID}.ndjson`]: '',
          [`pages-${ID}-00001.warc.gz`]: 'aaaa',
        },
        [`doubak-bundle-${OLDER}`]: bundleFiles(OLDER),
      },
    });
    try {
      const rows = dom.byId.get('bundle-pick').querySelectorAll('.picker-row');
      assert.deepEqual(rows.map((r) => r.dataset.id), [ID, OLDER],
        '正在抓的那一份沉底了 —— 用户会以为清单没刷新');
      assert.equal(/时间不详/.test(rows[0].textContent), false,
        'bundle_id 的前缀就是创建时刻，没有理由说「不详」');
    } finally {
      dom.restore();
    }
  });

  test('**正在抓的增量不许被标成「全量」** —— 那不是缺一个值，是一句错话', async () => {
    // 报上来的现象：开了一次增量，档案页那一行写着「全量 · 进行中」。
    // `previous_bundle_id` 写在 manifest 里，而 manifest 要到收尾才写，于是
    // 「读不出来」和「没有上游」被合成了同一个假值。这一行恰恰是用户开完增量之后
    // 最会盯着看的那一行。
    const PREV = '20260731T043423Z-d40c1d';
    const { dom } = await openArchiveTab({
      bundles: {
        [`doubak-bundle-${ID}`]: {
          [`index-${ID}.ndjson`]: '',
          [`pages-${ID}-00001.warc.gz`]: 'aaaa',
        },
        [`doubak-bundle-${PREV}`]: bundleFiles(PREV),
      },
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return {
            ok: true, running: true, checkpoint: null,
            runner: { active: true, bundleId: ID, previousBundleId: PREV },
          };
        }
        if (msg.type === 'preflight') return { ok: true, permissions: { granted: true, missing: [] }, storage: null };
        if (msg.type === 'exportRecords') return { ok: true, exportedAt: {} };
        return { ok: true };
      },
    });
    try {
      const row = dom.byId.get('bundle-pick').querySelectorAll('.picker-row')
        .find((r) => r.dataset.id === ID);
      assert.ok(row, '正在抓的那一份不在清单里');
      assert.equal(/全量/.test(row.textContent), false, '一次增量被标成了全量');
      assert.match(row.textContent, /增量/);
      assert.match(row.textContent, /进行中/);
    } finally {
      dom.restore();
    }
  });

  test('runner 还没起来时说「还不知道」，不假装是全量', async () => {
    // 只有 checkpoint（offscreen 还没拉起来）时上游确实无从得知。那时候要说
    // 「还不知道」——把未知说成已知，正是这一整条判据在防的事。
    const { dom } = await openArchiveTab({
      bundles: {
        [`doubak-bundle-${ID}`]: {
          [`index-${ID}.ndjson`]: '',
          [`pages-${ID}-00001.warc.gz`]: 'aaaa',
        },
        [`doubak-bundle-${OLDER}`]: bundleFiles(OLDER),
      },
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return {
            ok: true, running: false,
            checkpoint: { bundle_id: ID, pause_reason: 'crash_sentinel' },
            runner: { active: false },
          };
        }
        if (msg.type === 'preflight') return { ok: true, permissions: { granted: true, missing: [] }, storage: null };
        if (msg.type === 'exportRecords') return { ok: true, exportedAt: {} };
        return { ok: true };
      },
    });
    try {
      const row = dom.byId.get('bundle-pick').querySelectorAll('.picker-row')
        .find((r) => r.dataset.id === ID);
      assert.match(row.textContent, /还不知道/);
      assert.equal(/全量/.test(row.textContent), false);
    } finally {
      dom.restore();
    }
  });

  test('**带时区偏移的时间不能按字符串比** —— 真实 manifest 就是这么写的', async () => {
    // 实测一份真档案：`created_at: "2026-08-02T22:48:02+10:00"`。按字符串比，
    // 它会被判成晚于同一天的 `13:00:00Z`——而它其实早 12 分钟。换台机器、换个
    // 时区、或者跨一次夏令时，这张列表的顺序就会悄悄错乱，而没有任何东西会报错。
    const EARLY = '20260802T124802Z-aaaaaa';   // 真实时刻更早
    const LATE = '20260802T130000Z-bbbbbb';
    const withAt = (id, at) => {
      const f = bundleFiles(id);
      const m = JSON.parse(f['manifest.json']);
      m.created_at = at;
      f['manifest.json'] = JSON.stringify(m);
      return f;
    };
    const { dom } = await openArchiveTab({
      bundles: {
        [`doubak-bundle-${EARLY}`]: withAt(EARLY, '2026-08-02T22:48:02+10:00'),
        [`doubak-bundle-${LATE}`]: withAt(LATE, '2026-08-02T13:00:00Z'),
      },
    });
    try {
      const rows = dom.byId.get('bundle-pick').querySelectorAll('.picker-row');
      assert.deepEqual(rows.map((r) => r.dataset.id), [LATE, EARLY],
        '+10:00 那一份被字符串比较顶到了前面');
    } finally {
      dom.restore();
    }
  });

  test('点另一份，高亮跟着走 —— 点击那条路径根本不重画列表', async () => {
    const { dom } = await openArchiveTab({
      bundles: {
        [`doubak-bundle-${ID}`]: bundleFiles(ID),
        [`doubak-bundle-${OLDER}`]: bundleFiles(OLDER),
      },
    });
    try {
      const rows = dom.byId.get('bundle-pick').querySelectorAll('.picker-row');
      const other = rows.find((r) => r.dataset.id === OLDER);
      assert.ok(other, '找不到另一份那一行');
      other.dispatch('click', {});
      await new Promise((r) => setTimeout(r, 20));

      const on = rows.filter((r) => r.getAttribute('aria-selected') === 'true');
      assert.deepEqual(on.map((r) => r.dataset.id), [OLDER], '高亮没跟着点击走');
      assert.match(dom.byId.get('archive-summary').textContent, new RegExp(OLDER),
        '右边也该换成刚点的那一份');
    } finally {
      dom.restore();
    }
  });

  test('**刚抓完的那一份要能在档案页看见** —— 判据是数据，不是「什么时候该重扫」', async () => {
    // 报上来的现象：抓完弹了「完成」，覆盖率页已经写着「合起来 4 份档案」，
    // 而档案页左边只有 3 份——也就是刚抓完的那一份**导不出来**，而导出正是此刻
    // 唯一该做的事。两页对同一批档案给出不同的数字，比两页都过期更糟。
    //
    // 成因是缺了一次作废：中止那条路径把目录扫描一起清掉，正常跑完只清了摘要。
    // 修法不去枚举「什么时候该重扫」（抓完、导入、删除、面板藏起来又回来——漏一种
    // 就少一次刷新），而是问缓存认不认识最新那一份。
    const { dom } = await openArchiveTab({
      bundles: { [`doubak-bundle-${ID}`]: bundleFiles(ID) },
    });
    try {
      const { bundleScanKnows } = await import('../src/ui/panel/shared.js');
      assert.equal(bundleScanKnows(ID), true, '缓存里明明有这一份');
      assert.equal(
        bundleScanKnows('20260812T121552Z-b10d6c'), false,
        '刚抓完的那一份不在缓存里 —— 这正是要被认出来的「过期」',
      );
    } finally {
      dom.restore();
    }
  });

  test('没有缓存时不算过期 —— 下一次扫描本来就是新的', async () => {
    // 反面判据。返回 false 的话，面板一开就会白扫一遍，而那是这一页最贵的动作。
    const { resetShared, bundleScanKnows } = await import('../src/ui/panel/shared.js');
    resetShared();
    assert.equal(bundleScanKnows('20260812T121552Z-b10d6c'), true);
  });

  test('**重扫按钮要真的重扫** —— 不是拿同一份缓存再画一遍', async () => {
    // 判据是「按之前扫描不到的东西，按之后要看得见」。渲染一遍同样的数据也能让
    // 按钮看起来「响应了」，而那恰恰是最坏的一种：用户按下去、界面动了一下、
    // 数字没变，于是他不知道是没刷新还是真的没变。
    const { dom, worker } = await openArchiveTab({
      bundles: { [`doubak-bundle-${OLDER}`]: bundleFiles(OLDER) },
    });
    try {
      assert.equal(dom.byId.get('bundle-pick').querySelectorAll('.picker-row').length, 0,
        '只有一份时不画选择器');
      assert.match(dom.byId.get('storage').textContent, /1 份/);

      // 面板背后多出一份（另一个上下文写的、导入的、或者我们漏了一种失效时机）
      await seedBundle(worker, `doubak-bundle-${ID}`, bundleFiles(ID));

      dom.byId.get('rescan').dispatch('click', {});
      await new Promise((r) => setTimeout(r, 30));

      assert.match(dom.byId.get('storage').textContent, /2 份/, '占用那行没重算');
      const rows = dom.byId.get('bundle-pick').querySelectorAll('.picker-row');
      assert.deepEqual(rows.map((r) => r.dataset.id), [ID, OLDER], '清单没重扫');
    } finally {
      dom.restore();
    }
  });

  test('**捕获检查器默认收起来** —— 一页里三个滚动条，两个属于同一件事', async () => {
    // 这一页原来有三张各自能滚的列表：档案清单、捕获列表、原文预览。后两张说的是
    // 同一件事（逐条核对字节），而那是规范承诺第三方可以走的路径——重要，但不是
    // 每天要做的事。日常路径是「挑一份、看它有多少、导出去」。
    const { dom } = await openArchiveTab({
      bundles: { [`doubak-bundle-${ID}`]: bundleFiles(ID) },
    });
    try {
      // 两块**都**默认收着。这一对小标签允许「都不选」，与顶上那排主标签不同：
      // 这一页已经很满，而「查看内容」一展开就要解析，点一下档案就白干一次活。
      assert.equal(dom.byId.get('captures-section').hidden, true, '捕获默认该是收起来的');
      assert.equal(dom.byId.get('content-section').hidden, true, '内容默认也该是收起来的');
      const btn = dom.byId.get('captures-toggle');
      // 做成标签之后判据是 aria-selected（互斥），不再是 aria-expanded（各开各的）。
      assert.equal(btn.getAttribute('aria-selected'), 'false');
      assert.equal(dom.byId.get('content-toggle').getAttribute('aria-selected'), 'false');
      // **收起来也要能被数出来**：条数不写在按钮上的话，「这份有多少条」就只能靠
      // 展开一次才知道，而那正是这个按钮想省掉的动作。
      assert.match(btn.textContent, /翻看捕获/);
    } finally {
      dom.restore();
    }
  });

  test('展开之后才画捕获列表 —— 收起来的东西不该继续付钱', async () => {
    const { dom } = await openArchiveTab({
      bundles: { [`doubak-bundle-${ID}`]: bundleFiles(ID) },
    });
    try {
      const btn = dom.byId.get('captures-toggle');
      assert.equal(dom.byId.get('captures').querySelectorAll('div[data-id]').length, 0,
        '收起来时不该已经把行画出来了');

      btn.dispatch('click', {});
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(dom.byId.get('captures-section').hidden, false);
      assert.equal(btn.getAttribute('aria-selected'), 'true');
      // 标签的名字不跟着状态变（那是按钮的做法，标签靠选中态说话）。但「再点一下
      // 能收起来」是标签通常没有的行为，所以那句话挪到了 title 上。
      assert.match(btn.textContent, /翻看捕获/);
      assert.equal(btn.getAttribute('title'), '再点一下收起');
      assert.equal(dom.byId.get('captures').querySelectorAll('div[data-id]').length, 1,
        '展开了却没画');

      // **互斥**：开着捕获时，内容那一块必须是收着的。
      assert.equal(dom.byId.get('content-section').hidden, true);
      assert.equal(dom.byId.get('content-toggle').getAttribute('aria-selected'), 'false');
    } finally {
      dom.restore();
    }
  });

  test('**「豆瓣上已经没有了」不跟着收起来** —— 那是整份档案里最不可替代的东西', async () => {
    // 它原来长在 `renderCaptures()` 里，而那个函数其实在做三件互不相干的事：画捕获
    // 列表、列出消失的条目、算链上的差异。把整个函数收到按钮后面，就会连带把
    // 「已删除条目」也藏起来——那时它只剩「判定分布」里的一个数字，而 panel.html
    // 里那条注释写的正是它不该只以一个数字出现。
    const files = bundleFiles(ID);
    files[`index-${ID}.ndjson`] += `${JSON.stringify({
      capture_id: `${ID}#000002`,
      route_key: 'interest.item',
      url: 'https://movie.douban.com/subject/1234567/',
      url_key: 'movie.douban.com/subject/1234567',
      observed_at: '2026-08-01T01:00:01Z',
      verdict: 'gone',
      length: 4,
      segment: `pages-${ID}-00001.warc.gz`,
    })}\n`;
    const { dom } = await openArchiveTab({ bundles: { [`doubak-bundle-${ID}`]: files } });
    try {
      assert.equal(dom.byId.get('captures-section').hidden, true, '前提：捕获列表是收起来的');
      assert.match(dom.byId.get('vanished').textContent, /已经没有了/,
        '收起捕获列表把「已删除」一起藏了');
    } finally {
      dom.restore();
    }
  });

  /**
   * 一条没抓成的捕获。**用 `blocked` + `note` 写「判不出来」**，因为规范里的
   * `verdict` 是封闭词表、没有这个取值，写入时用的正是 `cls.verdict ?? 'blocked'`
   * （见 loop.js），真相退在 `note` 里。照 verdict 编一个词表外的值，测的就是一种
   * 档案里不会出现的形状。
   */
  function failedEntry(id, n) {
    return `${JSON.stringify({
      capture_id: `${id}#0001${String(n).padStart(2, '0')}`,
      route_key: 'note.item',
      url: `https://www.douban.com/topic/4962842${n}/`,
      url_key: `douban.com/topic/4962842${n}`,
      observed_at: '2026-08-07T18:35:50Z',
      verdict: 'blocked',
      note: '判不出来：一个内容区块都没有',
      length: 4,
      segment: `pages-${id}-00001.warc.gz`,
    })}\n`;
  }

  /** 一条豆瓣上已经删掉的。 */
  function goneEntry(id, n = 0) {
    return `${JSON.stringify({
      capture_id: `${id}#0000${String(90 + n).padStart(2, '0')}`,
      route_key: 'interest.item',
      url: `https://movie.douban.com/subject/123456${n}/`,
      url_key: `movie.douban.com/subject/123456${n}`,
      observed_at: '2026-08-01T01:00:01Z',
      verdict: 'gone',
      length: 4,
      segment: `pages-${id}-00001.warc.gz`,
    })}\n`;
  }

  test('**两类分开折，条数与分类留在折叠标题上**', async () => {
    // 报上来的现象：一条路线的抽取规则对不上，几十条「判不出来」一次涌进来，
    // 同一个网址还因为重试出现好几遍，把下面的东西全推出屏幕；八条 gone 也一样。
    //
    // 折可以，但**折起来的必须只是清单**：反对的从来是「只剩一个数字、没有任何
    // 地方说得出是哪 8 条」，而标题写着条数、点一下就摊开，说得出。
    //
    // 两块仍然分开，因为它们是两回事：`gone` 是豆瓣上已经没有的东西，别处查不到；
    // 「判不出来」是这次抓取的过程留下的痕迹，页面还在，改了抽取器重抓就有。
    const files = bundleFiles(ID);
    for (let i = 0; i < 8; i += 1) files[`index-${ID}.ndjson`] += goneEntry(ID, i);
    for (let i = 0; i < 12; i += 1) files[`index-${ID}.ndjson`] += failedEntry(ID, i);

    const { dom } = await openArchiveTab({ bundles: { [`doubak-bundle-${ID}`]: files } });
    try {
      const vanished = dom.byId.get('vanished');
      const folds = vanished.querySelectorAll('details');
      assert.equal(folds.length, 2, '两类该是两块，混成一张表就分不出轻重了');

      const [goneFold, failFold] = folds;
      assert.match(goneFold.querySelector('summary').textContent, /有 8 条在豆瓣上已经没有了/);
      assert.equal(goneFold.open, false, '八条已经算长了');
      assert.equal(goneFold.querySelectorAll('.cap').length, 8, '点开要看得见是哪 8 条');

      assert.match(failFold.querySelector('summary').textContent, /12 条没能正常抓到/);
      assert.match(failFold.querySelector('summary').textContent, /判不出来 12/,
        '折叠标题上要说清是哪一类');
      assert.equal(failFold.open, false);
      assert.equal(failFold.querySelectorAll('.cap').length, 12);

      // 两句话都在，而且都在折叠**标题**上——收起来时也看得见。
      assert.match(vanished.textContent, /已经没有了/);
    } finally {
      dom.restore();
    }
  });

  test('只有两三条时直接摊开 —— 折叠是为了治「长」', async () => {
    // 三行并不长。为它折一次只是让人多点一下鼠标，而多点一下正是这一块想省掉的。
    const files = bundleFiles(ID);
    for (let i = 0; i < 3; i += 1) files[`index-${ID}.ndjson`] += failedEntry(ID, i);

    const { dom } = await openArchiveTab({ bundles: { [`doubak-bundle-${ID}`]: files } });
    try {
      const fold = dom.byId.get('vanished').querySelector('details');
      assert.ok(fold, '连折叠块都没画出来');
      assert.equal(fold.open, true);
    } finally {
      dom.restore();
    }
  });

  test('**换一份档案不把展开状态收回去**', async () => {
    // 逐条核对的人一定会连着看好几份。每换一份都收回去，就等于每换一份都要再点
    // 一次——而那是这一页上最不该有的那种摩擦：用户已经明确表达过他要看这个。
    const { dom } = await openArchiveTab({
      bundles: {
        [`doubak-bundle-${ID}`]: bundleFiles(ID),
        [`doubak-bundle-${OLDER}`]: bundleFiles(OLDER),
      },
    });
    try {
      dom.byId.get('captures-toggle').dispatch('click', {});
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(dom.byId.get('captures-section').hidden, false);

      const rows = dom.byId.get('bundle-pick').querySelectorAll('.picker-row');
      rows.find((r) => r.dataset.id === OLDER).dispatch('click', {});
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(dom.byId.get('captures-section').hidden, false, '换一份就收回去了');
    } finally {
      dom.restore();
    }
  });

  test('**总占用把两份加起来**，不是只报选中的那一份', async () => {
    const { dom } = await openArchiveTab({
      bundles: {
        [`doubak-bundle-${ID}`]: bundleFiles(ID),
        [`doubak-bundle-${OLDER}`]: bundleFiles(OLDER),
      },
    });
    try {
      assert.match(dom.byId.get('storage').textContent, /2 份/);
      assert.match(dom.byId.get('delete-all').textContent, /清空全部（2 份/);
    } finally {
      dom.restore();
    }
  });
});
