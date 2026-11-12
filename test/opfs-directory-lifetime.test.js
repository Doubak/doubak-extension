import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveOpfsRpc } from '../src/storage/opfs-rpc.js';

// Real RPC dispatcher and OpfsFileStore, with filesystem handles that become stale on deletion.
test('#35 read worker reopens replaced directories and never recreates missing archives', async () => {
  const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const prevSelf = globalThis.self;
  const dirs = new Map([['bundle', ['old.ndjson']]]);
  const creates = [];
  const missing = () => new DOMException('Entry not found', 'NotFoundError');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: {
    getDirectory: async () => ({ getDirectoryHandle: async (name, { create }) => {
      creates.push(create);
      if (!dirs.has(name)) {
        if (!create) throw missing();
        dirs.set(name, []);
      }
      const generation = dirs.get(name);
      return { async *keys() {
        if (generation !== dirs.get(name)) throw missing();
        yield* generation;
      } };
    } }),
  } } });
  let result;
  globalThis.self = { postMessage: message => { result = message; } };
  try {
    serveOpfsRpc({ allowWrites: false });
    const list = async () => { await self.onmessage({ data: { id: 1, dir: 'bundle', op: 'list' } }); return result; };
    assert.deepEqual((await list()).result, ['old.ndjson']);
    dirs.set('bundle', ['replacement.ndjson']);
    assert.deepEqual((await list()).result, ['replacement.ndjson']);
    dirs.delete('bundle');
    assert.equal((await list()).errorName, 'NotFoundError');
    assert.equal(dirs.has('bundle'), false);
    assert.deepEqual(creates, [false, false, false]);
    dirs.set('bundle', ['restored.ndjson']);
    assert.deepEqual((await list()).result, ['restored.ndjson']);
  } finally {
    if (prevNavigator) Object.defineProperty(globalThis, 'navigator', prevNavigator); else delete globalThis.navigator;
    if (prevSelf === undefined) delete globalThis.self; else globalThis.self = prevSelf;
  }
});

for (const mode of ['transient', 'persistent', 'permission']) {
  test(`#35 bundle scan handles ${mode} read failures without hiding them`, async () => {
    const { installFakeDom, readRepoFile } = await import('./helpers/fake-dom.js');
    const { fakeOpfsWorker, seedBundle } = await import('./helpers/fake-opfs-worker.js');
    const shared = await import('../src/ui/panel/shared.js');
    const worker = fakeOpfsWorker();
    const id = '20261112T000000Z-aaaaaa';
    const store = await seedBundle(worker, `doubak-bundle-${id}`, { 'manifest.json': JSON.stringify({ bundle_id: id }) });
    const list = store.list.bind(store);
    let attempts = 0;
    store.list = async () => {
      attempts++;
      if (mode !== 'transient' || attempts === 1) {
        throw new DOMException('read failure', mode === 'permission' ? 'NotAllowedError' : 'NotFoundError');
      }
      return list();
    };
    const dom = await installFakeDom({ html: await readRepoFile('src/ui/panel.html'), extra: {
      Worker: class { constructor() { return worker; } },
    } });
    try {
      shared.resetShared();
      if (mode === 'transient') {
        assert.equal((await shared.scanBundleDirs())[0].bundleId, id);
        assert.equal(attempts, 2);
      } else {
        await assert.rejects(shared.scanBundleDirs(), { name: mode === 'permission' ? 'NotAllowedError' : 'NotFoundError' });
        assert.equal(attempts, mode === 'permission' ? 1 : 2);
        store.list = list;
        assert.equal((await shared.scanBundleDirs())[0].bundleId, id, 'failed scans must not poison the cache');
      }
    } finally { shared.resetShared(); dom.restore(); }
  });
}
