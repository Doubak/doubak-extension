import { exportBundle, fileStoreSink } from '../src/bundle/exporter.js';
import { readBundleMeta, importBundle } from '../src/bundle/importer.js';
import { parse } from '../src/vendor/parser/parse.js';
import { project } from '../src/vendor/site-generator/projection.js';
import { buildPages } from '../src/vendor/site-generator/pages.js';
import { buildNeodbNdjson } from '../src/vendor/export-adapters/targets/neodb-ndjson.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CrawlRunner } from '../src/crawl/runner.js';
import { RunStore, checkpointFailures } from '../src/crawl/run-store.js';
import { MemoryKvStore } from '../src/storage/kv-store.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { BundleReader } from '../src/bundle/bundle-reader.js';
import { snapshotTasks, DETAIL, COMMENTS } from '../src/crawl/broadcast-snapshots.js';
import { urlKey } from '../src/core/urlkey.js';
const json = readFileSync(new URL('./fixtures/broadcast-snapshots/comments.json', import.meta.url), 'utf8');
const nav = '<li class="nav-user-account"><a href="https://www.douban.com/people/example/">主页</a></li><script>var _GLOBAL_NAV={USER_ID:"111"};</script>';
const profile = `${nav}<div id="db-usr-profile"><h1>示例</h1></div>`;
const card = '<div class="new-status status-wrapper" data-sid="123" data-uid="111"><div class="status-item" data-sid="123" data-uid="111"><span class="created_at" title="2026-10-28 10:00:00">昨天</span><a class="btn-action-reply" data-count="3" href="https://www.douban.com/people/111/status/123/">3回应</a></div></div>';
const detail = `${nav}${card.replace('status-wrapper"', 'status-wrapper from-detail"')}<div id="comments"></div>`;
const timeline = `${profile}<div class="stream-items">${card}</div>`;
const empty = `${profile}<div class="stream-items"></div>`;
const account = { userId: '111', username: 'example' };
const tasks = snapshotTasks(card, account, '20261001T000000Z-aaaaaa#000001', 'https://www.douban.com/people/example/statuses?p=9');
const options = { username: 'example', mediums: [], includeCatalog: false,
  onlyRoutes: ['broadcast.timeline', DETAIL, COMMENTS], broadcastReplySnapshot: true };
function harness({ apiStatus = 200, list = timeline } = {}) {
  const dirs = new Map();
  const openBundle = async dir => { if (!dirs.has(dir)) dirs.set(dir, new MemoryFileStore()); return dirs.get(dir); };
  const runStore = new RunStore({ kv: new MemoryKvStore(), openBundle });
  const calls = [];
  const events = [];
  let ckReads = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const api = url.includes('/rexxar/');
    const body = api ? json : /\/status\/123\//.test(url) ? detail
      : /statuses\?p=1$/.test(url) ? list : url.includes('/statuses?') ? empty : profile;
    const bytes = new TextEncoder().encode(body);
    return { url, status: api ? apiStatus : 200,
      headers: new Headers({ 'content-type': api ? 'application/json' : 'text/html' }),
      arrayBuffer: async () => bytes.buffer };
  };
  const make = () => new CrawlRunner({ producerVersion: 'test', runStore, openBundle, fetchImpl,
    getCk: async () => { ckReads++; return 'NEVER_ATTACH'; }, batchSize: 1, onEvent: e => events.push(e),
    pacerOptions: { intervalMs: 1, jitterRatio: 0 } });
  return { runner: make(), make, runStore, openBundle, calls, events, ckReads: () => ckReads };
}
async function drain(runner) { for (let i = 0; i < 15; i++) { const r = await runner.runBatch(); if (r.done) return r; } throw new Error('unbounded requests'); }
const snapshotCalls = calls => calls.filter(x => /\/status\/123\/|\/rexxar\//.test(x.url));

test('captures one raw first page and independent HTML, no ck, pagination, nested replies or assets', async () => {
  const h = harness(); const started = await h.runner.start(options);
  assert.equal((await drain(h.runner)).stoppedBy, null);
  assert.equal(snapshotCalls(h.calls).length, 2);
  const api = h.calls.find(c => c.url.includes('/rexxar/'));
  assert.equal(new URL(api.url).searchParams.get('ck'), null);
  assert.equal(h.ckReads(), 0, 'read-only snapshot must not even read ck');
  assert.equal(api.init.credentials, 'include');
  assert.equal(new URL(api.url).searchParams.get('start'), '0');
  const store = await h.openBundle(started.dir);
  const reader = new BundleReader({ store, bundleId: started.bundleId });
  const rows = await reader.index();
  const saved = rows.filter(r => [DETAIL, COMMENTS].includes(r.route_key));
  assert.equal(saved.length, 2); assert.ok(saved.every(r => r.verdict === 'ok' && r.parent_capture_id));
  assert.equal((await reader.readEntry(saved.find(r => r.route_key === COMMENTS))).bodyText, json);
  const cp = await h.runStore.loadCheckpoint();
  assert.equal(cp.run_context.options.broadcastReplySnapshot, true);
  await h.runner.finish();
  const manifest = JSON.parse(new TextDecoder().decode(await store.read('manifest.json')));
  assert.equal(manifest.crawl_scope.broadcast_reply_snapshot, true);
  const exported = new MemoryFileStore();
  assert.equal((await exportBundle({ store, sink: fileStoreSink(exported) })).verified, true);
  const meta = await readBundleMeta(exported, `doubak-bundle-${started.bundleId}`);
  assert.deepEqual(meta.fatal, []);
  const imported = new MemoryFileStore();
  assert.equal((await importBundle({ source: exported, dest: imported })).verified, true);
  assert.deepEqual(await imported.read('manifest.json'), await store.read('manifest.json'));
  assert.ok(!(await imported.list()).some(name => /discussion|replies/.test(name)));
  const importedReader = new BundleReader({ store: imported, bundleId: started.bundleId });
  const importedRows = await importedReader.index();
  assert.equal((await importedReader.readEntry(importedRows.find(r => r.route_key === COMMENTS))).bodyText, json);
  const source = { bundleId: started.bundleId, status: 'complete', manifest,
    crawlState: new Map(manifest.crawl_state.map(r => [r.route_key, r])), coverage: new Map(), close() {},
    payload: async row => (await importedReader.readEntry(row)).bodyText };
  const parsed = await parse([{ ...source, index: importedRows }]);
  const baseline = await parse([{ ...source, index: importedRows.filter(r => ![DETAIL, COMMENTS].includes(r.intent)) }]);
  const site = buildPages(project(parsed));
  assert.deepEqual(site, buildPages(project(baseline)), 'pages and search must be unchanged');
  assert.deepEqual(buildNeodbNdjson(parsed), buildNeodbNdjson(baseline), 'platform export must be unchanged');
  assert.doesNotMatch(JSON.stringify(site), /第三方文字|楼中楼预览|u222\.jpg/);
  assert.equal(parsed.stats.rawOnlyCaptures.length, 2);

  for (const r of manifest.crawl_state.filter(r => [DETAIL, COMMENTS].includes(r.route_key))) {
    assert.equal(r.enumeration, 'bounded'); assert.equal(r.advanced, false);
  }
});

test('off means no requests or historical scan, full ignores historical resolver', async () => {
  for (const [enabled, mode] of [[false, 'incremental'], [true, 'full']]) {
    const h = harness();
    await h.runner.start({ ...options, broadcastReplySnapshot: enabled, mode,
      resolveSnapshots: () => { throw new Error('must not scan'); } });
    await drain(h.runner);
    assert.equal(snapshotCalls(h.calls).length, enabled ? 2 : 0);
    assert.ok(!h.events.some(e => e.part === 'broadcast_snapshots'));
  }
});

test('historical backlog without floors: API refresh does not re-read successful detail HTML', async () => {
  const h = harness({ list: empty });
  await h.runner.start({ ...options, mode: 'refresh-editable', resolveFloors: async () => ({}),
    resolveSnapshots: async () => ({ items: [tasks.items[1]], known: [urlKey(tasks.items[0].url)] }) });
  await drain(h.runner);
  assert.deepEqual(snapshotCalls(h.calls).map(c => new URL(c.url).pathname), ['/rexxar/api/v2/status/123/comments']);
});

test('resume keeps the frozen opt-in, successful HTML is not fetched again', async () => {
  const h = harness(); await h.runner.start(options);
  for (let n = 0; n < 8 && !h.calls.some(c => /\/people\/111\/status\/123\//.test(c.url)); n++) await h.runner.runBatch();
  const cp = await h.runStore.loadCheckpoint();
  assert.ok(cp.frontier.some(it => it.route_key === COMMENTS));
  const resumed = h.make(); await resumed.resume(cp);
  await drain(resumed);
  assert.equal(h.calls.filter(c => /\/people\/111\/status\/123\//.test(c.url)).length, 1);
  assert.equal(h.calls.filter(c => c.url.includes('/rexxar/')).length, 1);
});

test('blocked API is captured, pauses and cannot advance; snapshot failures stay leaves', async () => {
  const h = harness({ apiStatus: 403 }); const started = await h.runner.start(options);
  const result = await drain(h.runner);
  assert.equal(result.stoppedBy, 'blocked');
  const rows = await new BundleReader({ store: await h.openBundle(started.dir), bundleId: started.bundleId }).index();
  assert.equal(rows.find(r => r.route_key === COMMENTS).verdict, 'blocked');
  const cp = await h.runStore.loadCheckpoint();
  const failed = { ...cp, frontier: cp.frontier.map(it => ({ ...it, state: 'failed' })) };
  assert.equal(checkpointFailures(failed).find(it => it.routeKey === COMMENTS).ordered, false);
});

test('legacy opt-out checkpoint cannot gain a snapshot task through resume', async () => {
  const h = harness(); await h.runner.start({ ...options, broadcastReplySnapshot: false });
  const cp = await h.runStore.loadCheckpoint();
  cp.frontier.push({ route_key: COMMENTS, intent: COMMENTS, url: tasks.items[1].url, state: 'pending' });
  const resumed = h.make(); const before = h.calls.length;
  await assert.rejects(resumed.resume(cp), /未授权/);
  assert.equal(h.calls.length, before);
});

for (const crashPoint of ['list-written', 'api-written']) {
  test(`crash window ${crashPoint}: committed raw bytes survive stale checkpoint without losing descendants`, async () => {
    const h = harness(); const started = await h.runner.start({ ...options, mode: 'full' });
    let oldCheckpoint = await h.runStore.loadCheckpoint();
    if (crashPoint === 'list-written') {
      await h.runner.runBatch();
    } else {
      for (let i = 0; i < 8 && !h.calls.some(c => /\/people\/111\/status\/123\//.test(c.url)); i++) await h.runner.runBatch();
      oldCheckpoint = await h.runStore.loadCheckpoint();
      await h.runner.runBatch(); // API WARC and index are committed, emulate missing checkpoint write below.
    }
    await h.runStore.saveCheckpoint(oldCheckpoint);
    const resumed = h.make(); await resumed.resume(oldCheckpoint);
    await drain(resumed);
    assert.equal(h.calls.filter(c => c.url.includes('/rexxar/')).length, 1);
    assert.equal(h.calls.filter(c => /\/people\/111\/status\/123\//.test(c.url)).length, 1);
    await resumed.finish();
    const reader = new BundleReader({ store: await h.openBundle(started.dir), bundleId: started.bundleId });
    assert.equal((await reader.index()).filter(r => r.route_key === COMMENTS && r.verdict === 'ok').length, 1);
  });
}
