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

let cacheBust = 0;
const ID = '20260801T005010Z-3eef52';
const OLDER = '20260731T043423Z-d40c1d';

/** 一份长得像真档案的目录。 */
function bundleFiles(id, { previous = null } = {}) {
  return {
    'manifest.json': JSON.stringify({
      bundle_id: id,
      status: 'complete',
      created_at: '2026-08-01T00:50:10Z',
      completed_at: '2026-08-01T02:00:00Z',
      previous_bundle_id: previous,
      account: { user_id: '1000001', username: 'mewx' },
      segments: [{ filename: `pages-${id}-00001.warc.gz`, bytes: 4 }],
      index: { filename: `index-${id}.ndjson`, line_count: 1 },
      crawl_state: [],
      coverage: [],
    }),
    [`index-${id}.ndjson`]: '',
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
