/**
 * 导入，从点按钮到字节落进 OPFS，整条走一遍。
 *
 * ## 为什么不满足于「核心逻辑测过了」
 *
 * `importer.test.js` 验的是判断（认不认得出、该不该导），`opfs-rpc.test.js` 验的是
 * 那条写入边界。两者都通过，导入仍然可能一个字节都写不进去——中间还隔着好几层
 * 只在浏览器里存在的东西：目录选择器、`chrome.runtime.getURL` 起 Worker、
 * `WorkerFileStore` 那条消息通道、以及**面板到底有没有把这几样接对**。
 *
 * 这一层历来是这个项目出错最多的地方，而且错法都一样：语法合法、单元测试全绿、
 * 用户一点就炸。所以这里假到 `showDirectoryPicker` 为止，其余全用真的。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeDom, readRepoFile } from './helpers/fake-dom.js';
import { fakeOpfsWorker, seedBundle } from './helpers/fake-opfs-worker.js';
import { sha256Hex } from '../src/core/digest.js';

let cacheBust = 0;
const ID = '20260801T005010Z-3eef52';
const enc = new TextEncoder();

/** 用户磁盘上那份档案的内容。段文件的摘要是真的，所以回读校验那一趟是真的在验。 */
async function exportedBundle(id = ID, { userId = '1000001', payload = 'WARC/1.1 fake payload' } = {}) {
  const seg = `pages-${id}-00001.warc.gz`;
  const body = enc.encode(payload);
  return {
    [seg]: body,
    [`index-${id}.ndjson`]: enc.encode('{"capture_id":"x"}\n'),
    'manifest.json': enc.encode(JSON.stringify({
      bundle_id: id,
      status: 'complete',
      created_at: '2026-08-01T00:50:10Z',
      completed_at: '2026-08-01T02:00:00Z',
      previous_bundle_id: null,
      account: { user_id: userId, username: userId === '1000001' ? 'mewx' : '别人' },
      segments: [{ filename: seg, bytes: body.length, sha256: await sha256Hex(body) }],
      index: { filename: `index-${id}.ndjson` },
      crawl_state: [],
      coverage: [],
    })),
  };
}

/** 一个假的 `FileSystemDirectoryHandle`，只实现导入真正用到的那几样。 */
function fakeDir(name, files = {}, subdirs = {}) {
  return {
    name,
    kind: 'directory',
    async *entries() {
      for (const [n, body] of Object.entries(files)) {
        yield [n, {
          kind: 'file',
          async getFile() {
            const bytes = typeof body === 'string' ? enc.encode(body) : body;
            return {
              size: bytes.length,
              slice: (a, b) => ({ arrayBuffer: async () => bytes.slice(a, b).buffer }),
              arrayBuffer: async () => bytes.buffer,
            };
          },
        }];
      }
      for (const [n, d] of Object.entries(subdirs)) yield [n, d];
    },
    async getFileHandle(n) {
      if (!(n in files)) { const e = new Error('没有'); e.name = 'NotFoundError'; throw e; }
      for await (const [name2, h] of this.entries()) if (name2 === n) return h;
      throw new Error('没有');
    },
  };
}

/**
 * 装好面板，把「导入档案…」点下去。
 *
 * @param {object} opts
 * @param {object} opts.picked            用户选中的那个目录
 * @param {Record<string, object>} [opts.have]  OPFS 里已经有的
 * @param {boolean} [opts.confirmed]      确认框点确定还是取消
 */
async function clickImport({ picked, have = {}, confirmed = true }) {
  const worker = fakeOpfsWorker({ allowWrites: true, importOnly: true });
  for (const [dir, files] of Object.entries(have)) await seedBundle(worker, dir, files);

  const html = await readRepoFile('src/ui/panel.html');
  /** @type {string[]} */
  const asked = [];
  const dom = await installFakeDom({
    html,
    onMessage: (msg) => {
      if (msg.type === 'status') return { ok: true, running: false, checkpoint: null, runner: { active: false } };
      if (msg.type === 'preflight') return { ok: true, permissions: { granted: true, missing: [] }, storage: null };
      if (msg.type === 'exportRecords') return { ok: true, exportedAt: {} };
      return { ok: true };
    },
    extra: {
      Worker: function FakeWorkerCtor() { return worker; },
      window: { showDirectoryPicker: async () => picked },
      navigator: { storage: { estimate: async () => ({ usage: 0, quota: 100e9 }) } },
    },
  });
  // 确认框：记下问了什么，然后按参数答复。**问了什么本身就是断言对象**——
  // 「将要发生什么」必须在写之前说清楚。
  Object.defineProperty(globalThis, 'confirm', {
    value: (text) => { asked.push(text); return confirmed; },
    writable: true, configurable: true,
  });

  await import(`../src/ui/panel.js?t=${++cacheBust}`);
  await new Promise((r) => setTimeout(r, 5));
  dom.byId.get('import').dispatch('click', {});
  await new Promise((r) => setTimeout(r, 60));

  return { dom, worker, asked, result: () => dom.byId.get('import-result').textContent };
}

describe('导入（从点按钮到字节落盘）', () => {
  test('**一份导出的档案能整份搬回来**，而且逐个核对过摘要', async () => {
    const files = await exportedBundle();
    const { dom, worker, result } = await clickImport({
      picked: fakeDir('备份', {}, { [`doubak-bundle-${ID}`]: fakeDir(`doubak-bundle-${ID}`, files) }),
    });
    try {
      assert.match(result(), /已导入并校验通过/, result());
      const store = worker.dirs.get(`doubak-bundle-${ID}`);
      assert.ok(store, 'OPFS 里没有出现这份档案的目录');
      assert.deepEqual((await store.list()).sort(), Object.keys(files).sort());
      for (const [name, body] of Object.entries(files)) {
        assert.deepEqual(await store.read(name), body, `${name} 字节对不上`);
      }

      // **导完之后它得立刻出现在档案清单里。**
      //
      // 这一条不是锦上添花：目录名必须正好是 `doubak-bundle-<编号>`，因为增量抓取
      // 挑下界时是**枚举 OPFS 目录**再逐个读 manifest 的（offscreen.js），
      // 而 `bundleIdFromDirName` 认不出的目录会被整个跳过。名字差一点，字节全在，
      // 而下一次抓取照样退回全量 —— 那正是导入要解决的问题本身。
      assert.match(dom.byId.get('storage').textContent, /1 份/, '导入的档案没进档案清单');
      assert.match(dom.byId.get('archive-summary').textContent, new RegExp(ID));
    } finally {
      dom.restore();
    }
  });

  test('用户选中档案目录**本身**也认', async () => {
    // 「选中它，或者选中它的上一级」两种都得工作 —— 用户不会去想我们期望哪一种。
    const files = await exportedBundle();
    const { dom, worker, result } = await clickImport({
      picked: fakeDir(`doubak-bundle-${ID}`, files),
    });
    try {
      assert.match(result(), /已导入并校验通过/, result());
      assert.ok(worker.dirs.get(`doubak-bundle-${ID}`));
    } finally {
      dom.restore();
    }
  });

  test('**确认之前一个字节都没写**，而且确认框说清了将要发生什么', async () => {
    const files = await exportedBundle();
    const { dom, worker, asked } = await clickImport({
      picked: fakeDir(`doubak-bundle-${ID}`, files),
      confirmed: false,
    });
    try {
      assert.equal(worker.dirs.has(`doubak-bundle-${ID}`), false, '用户点了取消，却已经写进去了');
      assert.equal(asked.length, 1);
      assert.match(asked[0], /导入 1 份档案/);
      assert.match(asked[0], /不会改动扩展里已有的任何档案/);
    } finally {
      dom.restore();
    }
  });

  test('**已经有了就跳过**，不重来一遍', async () => {
    const files = await exportedBundle();
    const { dom, asked, result } = await clickImport({
      picked: fakeDir(`doubak-bundle-${ID}`, files),
      have: { [`doubak-bundle-${ID}`]: files },
    });
    try {
      assert.match(result(), /已经有了/);
      assert.deepEqual(asked, [], '没什么要导的时候不该再弹确认框');
    } finally {
      dom.restore();
    }
  });

  test('**同编号但内容不同：拒绝，而且原来那份一个字节没动**', async () => {
    const mine = await exportedBundle();
    // 内容不同的**另一份**，manifest 自己是自洽的 —— 否则拒绝的理由会变成
    // 「字节数与 manifest 对不上」，验的就不是「同编号撞车」这件事了。
    const theirs = await exportedBundle(ID, { payload: 'WARC/1.1 完全不一样的另一份内容' });
    const { dom, worker, result } = await clickImport({
      picked: fakeDir(`doubak-bundle-${ID}`, theirs),
      have: { [`doubak-bundle-${ID}`]: mine },
    });
    try {
      assert.match(result(), /编号撞了/);
      assert.deepEqual(
        await worker.dirs.get(`doubak-bundle-${ID}`).read(`pages-${ID}-00001.warc.gz`),
        mine[`pages-${ID}-00001.warc.gz`],
        '已有档案的字节被覆盖了',
      );
    } finally {
      dom.restore();
    }
  });

  test('**段文件缺失的目录不导**，并说出缺的是哪一个', async () => {
    const files = await exportedBundle();
    delete files[`pages-${ID}-00001.warc.gz`];
    const { dom, worker, result } = await clickImport({
      picked: fakeDir(`doubak-bundle-${ID}`, files),
    });
    try {
      assert.match(result(), /不能导/);
      assert.match(result(), /pages-.*00001\.warc\.gz/);
      assert.equal(worker.dirs.has(`doubak-bundle-${ID}`), false, '坏档案被导进去了');
    } finally {
      dom.restore();
    }
  });

  test('选中的文件夹里没有档案时，说的是**怎么办**', async () => {
    const { dom, result } = await clickImport({
      picked: fakeDir('下载', { '照片.jpg': 'x' }),
    });
    try {
      assert.match(result(), /没有找到档案/);
      assert.match(result(), /doubak-bundle/, '要说出该选哪个文件夹');
    } finally {
      dom.restore();
    }
  });

  test('**一批里坏的那份被拒，好的那份照导**', async () => {
    const good = await exportedBundle(ID);
    const OTHER = '20260804T084014Z-627045';
    const bad = await exportedBundle(OTHER);
    delete bad[`pages-${OTHER}-00001.warc.gz`];

    const { dom, worker, result } = await clickImport({
      picked: fakeDir('备份', {}, {
        [`doubak-bundle-${ID}`]: fakeDir(`doubak-bundle-${ID}`, good),
        [`doubak-bundle-${OTHER}`]: fakeDir(`doubak-bundle-${OTHER}`, bad),
      }),
    });
    try {
      assert.ok(worker.dirs.get(`doubak-bundle-${ID}`), '好的那份没导进来');
      assert.equal(worker.dirs.has(`doubak-bundle-${OTHER}`), false, '坏的那份导进来了');
      assert.match(result(), /1 份档案已导入/);
    } finally {
      dom.restore();
    }
  });

  test('**同一份档案在两个文件夹里出现：只导一次**', async () => {
    const files = await exportedBundle();
    const { dom, asked, result } = await clickImport({
      picked: fakeDir('备份', {}, {
        a: fakeDir('a', {}, { [`doubak-bundle-${ID}`]: fakeDir(`doubak-bundle-${ID}`, files) }),
        b: fakeDir('b', {}, { '解压出来的 (1)': fakeDir('解压出来的 (1)', files) }),
      }),
    });
    try {
      assert.match(asked[0], /导入 1 份档案/, '同一份档案被算了两次');
      // **导完之后「为什么没导」还得留在屏幕上** —— 用户选了两个文件夹，
      // 只说「导入了 1 份」会让他以为漏了。
      assert.match(result(), /重复/);
    } finally {
      dom.restore();
    }
  });

  test('**另一个账号的默认不导**，并且先问一句', async () => {
    const mine = await exportedBundle(ID);
    const OTHER = '20260804T084014Z-627045';
    const theirs = await exportedBundle(OTHER, { userId: '2000002' });
    const { dom, worker, asked, result } = await clickImport({
      picked: fakeDir(`doubak-bundle-${OTHER}`, theirs),
      have: { [`doubak-bundle-${ID}`]: mine },
      confirmed: false, // 「要导别的账号吗」→ 不要
    });
    try {
      assert.match(result(), /别的账号/);
      assert.match(asked[0], /另一个豆瓣账号/);
      assert.match(asked[0], /解析器会拒绝整个目录/, '要说清代价，不是只说「不建议」');
      assert.equal(worker.dirs.has(`doubak-bundle-${OTHER}`), false);
    } finally {
      dom.restore();
    }
  });

  test('**空间不够就不开工**，而不是写到一半失败', async () => {
    const files = await exportedBundle();
    const worker = fakeOpfsWorker({ allowWrites: true, importOnly: true });
    const html = await readRepoFile('src/ui/panel.html');
    const dom = await installFakeDom({
      html,
      onMessage: (msg) => {
        if (msg.type === 'status') return { ok: true, running: false, checkpoint: null, runner: { active: false } };
        if (msg.type === 'preflight') return { ok: true, permissions: { granted: true, missing: [] }, storage: null };
        if (msg.type === 'exportRecords') return { ok: true, exportedAt: {} };
        return { ok: true };
      },
      extra: {
        Worker: function FakeWorkerCtor() { return worker; },
        window: { showDirectoryPicker: async () => fakeDir(`doubak-bundle-${ID}`, files) },
        // 配额几乎满了
        navigator: { storage: { estimate: async () => ({ usage: 100e9 - 10, quota: 100e9 }) } },
      },
    });
    try {
      await import(`../src/ui/panel.js?t=${++cacheBust}`);
      await new Promise((r) => setTimeout(r, 5));
      dom.byId.get('import').dispatch('click', {});
      await new Promise((r) => setTimeout(r, 40));

      assert.match(dom.byId.get('import-result').textContent, /空间不够/);
      assert.equal(worker.dirs.has(`doubak-bundle-${ID}`), false);
    } finally {
      dom.restore();
    }
  });
});
