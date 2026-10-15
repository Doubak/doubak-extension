import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CrawlRunner } from '../src/crawl/runner.js';
import { RunStore, ScheduleStore } from '../src/crawl/run-store.js';
import { MemoryKvStore } from '../src/storage/kv-store.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { TEST_PRODUCER_VERSION } from './helpers/producer.js';

function page(uid) {
  return `<html><title>账号 ${uid}</title><li class="nav-user-account"><span>昵称 ${uid}的账号</span></li>
    <script>window._GLOBAL_NAV = { USER_ID: "${uid}" };</script>
    <a href="https://www.douban.com/people/original/">主页</a>
    <div id="db-usr-profile"><h1>昵称 ${uid}</h1></div></html>`;
}

function harness() {
  const kv = new MemoryKvStore();
  const dirs = new Map();
  const calls = [];
  let uid = '111';
  const openBundle = async (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, new MemoryFileStore());
    return dirs.get(dir);
  };
  const runStore = new RunStore({ kv, openBundle });
  const makeRunner = () => new CrawlRunner({
    runStore, openBundle, producerVersion: TEST_PRODUCER_VERSION,
    pacerOptions: { intervalMs: 1, jitterRatio: 0 },
    fetchImpl: async (url) => {
      calls.push(url);
      return { status: 200, url, headers: new Headers(), arrayBuffer: async () => new TextEncoder().encode(page(uid)).buffer };
    },
  });
  return { kv, dirs, calls, runStore, makeRunner, switchTo: (id) => { uid = id; } };
}

const options = { username: 'original', onlyRoutes: ['profile.overview'], mediums: [], includeCatalog: false };

for (const cold of [false, true]) {
  test(`${cold ? '冷' : '热'}恢复拒绝当前登录 B，原 UID、断点和捕获保持 A`, async () => {
    const h = harness();
    const a = h.makeRunner();
    const started = await a.start(options);
    await a.runBatch();
    await a.pause();
    const cp = await h.runStore.loadCheckpoint();
    assert.equal(cp.run_context.account.userId, '111');
    assert.equal((await new ScheduleStore({ kv: h.kv }).loadCheckpoint()).run_context.account.userId, '111');
    const store = h.dirs.get(started.dir);
    const before = await store.read(`index-${started.bundleId}.ndjson`);
    h.switchTo('222');
    const r = cold ? h.makeRunner() : a;
    await assert.rejects(() => r.resume(cp), { reason: 'account_switched' });
    assert.equal((await h.runStore.getCurrentRun()).runContext.account.userId, '111');
    assert.equal((await h.runStore.loadCheckpoint()).run_context.account.userId, '111');
    assert.deepEqual(await store.read(`index-${started.bundleId}.ndjson`), before);
    h.switchTo('111');
    await r.resume(await h.runStore.loadCheckpoint());
    assert.equal(r.status().targetAccount.userId, '111');
    const manifest = await r.finish('complete');
    assert.equal(manifest.account.user_id, '111');
    assert.equal(manifest.account.nickname, '昵称 111');
    assert.equal(manifest.account.profile_url, 'https://www.douban.com/people/original/');
  });
}

test('冷恢复保留原 onlyRoutes，不扩大为完整范围', async () => {
  const h = harness();
  const a = h.makeRunner();
  await a.start(options);
  await a.pause();
  const b = h.makeRunner();
  await b.resume(await h.runStore.loadCheckpoint());
  assert.deepEqual([...b._run.routes.keys()], ['profile.overview']);
});

test('断点属于其他 bundle 时，恢复在网络请求与磁盘修复之前拒绝', async () => {
  const h = harness();
  await h.makeRunner().start(options);
  const cp = await h.runStore.loadCheckpoint();
  const calls = h.calls.length;
  await assert.rejects(() => h.makeRunner().resume({ ...cp, bundle_id: 'other' }), { reason: 'resume_identity_mismatch' });
  assert.equal(h.calls.length, calls);
});

test('指针与 portable 断点身份不一致时拒绝恢复', async () => {
  const h = harness();
  await h.makeRunner().start(options);
  const cp = await h.runStore.loadCheckpoint();
  cp.run_context.account.userId = '222';
  await assert.rejects(() => h.makeRunner().resume(cp), { reason: 'resume_identity_mismatch' });
});

test('恢复不接受覆盖 username，另一个 runner 也不能抢占暂停任务', async () => {
  const h = harness();
  const a = h.makeRunner();
  await a.start(options);
  await a.pause();
  const cp = await h.runStore.loadCheckpoint();
  for (const r of [a, h.makeRunner()]) {
    await assert.rejects(() => r.resume(cp, { username: 'different' }), { reason: 'resume_identity_mismatch' });
  }
  const calls = h.calls.length;
  await assert.rejects(() => h.makeRunner().start({ ...options, username: 'different' }), /已有抓取/);
  assert.equal(h.calls.length, calls);
});

test('旧本人断点从已归档主页补 UID，仍拒绝 B 且可由 A 继续', async () => {
  const h = harness();
  const a = h.makeRunner();
  await a.start(options);
  await a.runBatch();
  await a.pause();
  const pointer = await h.runStore.getCurrentRun();
  delete pointer.runContext;
  await h.runStore.setCurrentRun(pointer);
  const cp = await h.runStore.loadCheckpoint();
  delete cp.run_context;
  await h.runStore.saveCheckpoint(cp);
  h.switchTo('222');
  await assert.rejects(() => h.makeRunner().resume(cp), { reason: 'account_switched' });
  h.switchTo('111');
  const r = h.makeRunner();
  await r.resume(cp);
  assert.equal(r.status().targetAccount.userId, '111');
});

test('旧断点没有原 UID 证据时不能借当前 Cookie 猜身份', async () => {
  const h = harness();
  await h.makeRunner().start(options);
  const pointer = await h.runStore.getCurrentRun();
  delete pointer.runContext;
  await h.runStore.setCurrentRun(pointer);
  const cp = await h.runStore.loadCheckpoint();
  delete cp.run_context;
  const calls = h.calls.length;
  await assert.rejects(() => h.makeRunner().resume(cp), { reason: 'resume_identity_missing' });
  assert.equal(h.calls.length, calls);
});

test('离线装载原 A 的冷断点可以中止，切到 B 无需请求豆瓣', async () => {
  const h = harness();
  const a = h.makeRunner();
  await a.start(options);
  await a.runBatch();
  await a.pause();
  h.switchTo('222');
  const calls = h.calls.length;
  const r = h.makeRunner();
  await r.resume(await h.runStore.loadCheckpoint(), { loadOnly: true });
  assert.equal(r.status().stopped, true);
  const manifest = await r.abort();
  assert.equal(h.calls.length, calls);
  assert.equal(manifest.account.user_id, '111');
  assert.equal(manifest.status, 'aborted');
  assert.equal(await h.runStore.getCurrentRun(), undefined);
});

test('损坏的冷断点与跨 bundle 的 last_capture_id 在请求网络前拒绝', async () => {
  const h = harness();
  await h.makeRunner().start(options);
  const cp = await h.runStore.loadCheckpoint();
  const calls = h.calls.length;
  for (const invalid of [{ ...cp, pause_reason: 'checkpoint_unreadable' }, { ...cp, frontier: null },
    { ...cp, last_capture_id: '20260101T000000Z-aaaaaa#000001' }]) {
    await assert.rejects(() => h.makeRunner().resume(invalid), { reason: 'resume_checkpoint_invalid' });
  }
  assert.equal(h.calls.length, calls);
});
