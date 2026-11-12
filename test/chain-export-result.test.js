import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, readRepoFile } from './helpers/fake-dom.js';
import { renderChainExportResult } from '../src/ui/panel/export.js';

for (const kind of ['zip', 'verified', 'unverified']) {
  test(`整条链导出按实际校验能力报告：${kind}`, async () => {
    const dom = await installFakeDom({ html: await readRepoFile('src/ui/panel.html') });
    try {
      const result = { bytes: 30, problems: [], verified: kind === 'verified' };
      const el = dom.byId.get('export-result');
      renderChainExportResult(el, [{ bundleId: 'a', result }], kind === 'zip' ? { name: 'a.zip', bytes: 50 } : null);
      if (kind === 'verified') assert.match(el.textContent, /校验通过/);
      else {
        assert.doesNotMatch(el.textContent, /校验通过/);
        assert.match(el.textContent, kind === 'zip' ? /未回读校验/ : /仅核对字节数/);
      }
    } finally { dom.restore(); }
  });
}

test('ZIP 收尾失败不登记已导出；等待链信息时切换账号不改下载文件名', async () => {
  const { fakeOpfsWorker, seedBundle } = await import('./helpers/fake-opfs-worker.js');
  const { resetShared } = await import('../src/ui/panel/shared.js');
  const { selectSummaryBundle } = await import('../src/ui/panel/archive.js');
  const { initExport } = await import('../src/ui/panel/export.js');
  const worker = fakeOpfsWorker();
  const id = '20261001T000000Z-aaaaaa';
  await seedBundle(worker, `doubak-bundle-${id}`, {
    'manifest.json': JSON.stringify({ bundle_id: id, account: { user_id: '111' }, segments: [], index: { filename: `index-${id}.ndjson` } }),
    [`index-${id}.ndjson`]: '',
  });
  let resolveChain;
  const pending = new Promise((resolve) => { resolveChain = resolve; });
  const names = [];
  const dom = await installFakeDom({
    html: await readRepoFile('src/ui/panel.html'),
    onMessage: (msg) => msg.type === 'chain' ? pending : { ok: true },
    extra: {
      Worker: class { constructor() { return worker; } },
      navigator: { storage: { getDirectory: async () => ({
        removeEntry: async () => {},
        getDirectoryHandle: async () => ({ values: async function* () {}, getFileHandle: async (name) => {
          names.push(name);
          return {
            createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }),
            getFile: async () => { throw new Error('simulated final file failure'); },
          };
        } }),
      }) } },
    },
  });
  try {
    resetShared();
    globalThis.confirm = () => true;
    selectSummaryBundle(id);
    initExport();
    const button = dom.byId.get('export-chain');
    button.dispatch('click');
    button.dispatch('click');
    selectSummaryBundle('20261002T000000Z-bbbbbb');
    resolveChain({ ok: true, chain: { bundles: [{ bundleId: id }] } });
    const deadline = Date.now() + 5000;
    while (!dom.byId.get('export-result').textContent.includes('打包失败')) {
      assert.ok(Date.now() < deadline, '没有收到收尾失败结果');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(names, [`doubak-archive-${id}-整条链.zip`]);
    assert.equal(dom.sent.filter((m) => m.type === 'chain').length, 1);
    assert.equal(dom.sent.filter((m) => m.type === 'markExported').length, 0);
  } finally { resetShared(); dom.restore(); }
});

test('#35 chain ZIP stops on the first write failure, aborts and never marks any bundle exported', async () => {
  const { fakeOpfsWorker, seedBundle } = await import('./helpers/fake-opfs-worker.js');
  const shared = await import('../src/ui/panel/shared.js');
  const { selectSummaryBundle } = await import('../src/ui/panel/archive.js');
  const { initExport } = await import('../src/ui/panel/export.js');
  const worker = fakeOpfsWorker();
  const ids = ['20261001T000000Z-aaaaaa', '20260901T000000Z-bbbbbb'];
  let secondReads = 0, writes = 0, closes = 0, aborts = 0;
  for (const [i, id] of ids.entries()) {
    const store = await seedBundle(worker, `doubak-bundle-${id}`, {
      'manifest.json': JSON.stringify({ bundle_id: id, segments: [], index: { filename: `index-${id}.ndjson` } }),
      [`index-${id}.ndjson`]: '',
    });
    if (i) { const read = store.read.bind(store); store.read = (...args) => { secondReads++; return read(...args); }; }
  }
  const dom = await installFakeDom({
    html: await readRepoFile('src/ui/panel.html'),
    onMessage: msg => msg.type === 'chain' ? { ok: true, chain: { bundles: ids.map(bundleId => ({ bundleId })) } } : { ok: true },
    extra: {
      Worker: class { constructor() { return worker; } },
      navigator: { storage: { getDirectory: async () => ({
        removeEntry: async () => {},
        getDirectoryHandle: async () => ({
          values: async function* () {},
          getFileHandle: async () => ({ createWritable: async () => ({
            write: async () => { writes++; throw new DOMException('Quota exceeded', 'QuotaExceededError'); },
            close: async () => { closes++; },
            abort: async () => { aborts++; },
          }) }),
        }),
      }) } },
    },
  });
  try {
    shared.resetShared(); globalThis.confirm = () => true;
    selectSummaryBundle(ids[0]); initExport();
    dom.byId.get('export-chain').dispatch('click');
    const deadline = Date.now() + 2000;
    while (!dom.byId.get('export-result').textContent.includes('打包空间不足')) {
      assert.ok(Date.now() < deadline, dom.byId.get('export-result').textContent);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(writes, 1);
    assert.equal(closes, 0);
    assert.equal(aborts, 1);
    assert.equal(secondReads, 0);
    assert.equal(dom.sent.filter(m => m.type === 'markExported').length, 0);
    assert.match(dom.byId.get('export-result').textContent, /清理 ZIP 中转文件/);
  } finally { shared.resetShared(); dom.restore(); }
});
