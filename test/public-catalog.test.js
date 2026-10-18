import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CrawlRunner } from '../src/crawl/runner.js';
import { RunStore } from '../src/crawl/run-store.js';
import { MemoryKvStore } from '../src/storage/kv-store.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { BundleReader } from '../src/bundle/bundle-reader.js';
import { SessionGuard } from '../src/crawl/session.js';
import { TEST_PRODUCER_VERSION } from './helpers/producer.js';

const nav = id => id ? `<li class="nav-user-account">账号</li><script>window._GLOBAL_NAV={USER_ID:"${id}"};</script>` : '<li class="nav-login">登录</li>';
const profile = (target, actor) => `<html>${nav(actor)}<div id="db-usr-profile"><div class="pic"><img src="https://img1.doubanio.com/icon/up${target}-1.jpg"></div><div class="info"><h1>目标</h1></div></div></html>`;
const urls = ['https://movie.douban.com/subject/123/', 'https://book.douban.com/subject/123/',
  'https://music.douban.com/subject/123/', 'https://www.douban.com/game/123/', 'https://www.douban.com/location/drama/123/'];

function harness({ target = '111', actor = '222', contaminated = false, pow = false } = {}) {
  const dirs = new Map(), calls = [];
  const openBundle = async dir => { if (!dirs.has(dir)) dirs.set(dir, new MemoryFileStore()); return dirs.get(dir); };
  const runStore = new RunStore({ kv: new MemoryKvStore(), openBundle });
  let now = 0;
  const makeRunner = () => {
    const runner = new CrawlRunner({ runStore, openBundle, producerVersion: TEST_PRODUCER_VERSION,
      pacerOptions: { intervalMs: 1, jitterRatio: 0 }, batchSize: 20,
      fetchImpl: async (url, init) => {
        calls.push({ url, init, at: now });
        if (pow && urls.includes(url)) {
          const body = readFileSync(new URL('./fixtures/sec-pow.html', import.meta.url), 'utf8');
          return { status: 200, url: 'https://sec.douban.com/c', headers: new Headers(),
            arrayBuffer: async () => new TextEncoder().encode(body).buffer };
        }
        if (pow && init.method === 'POST') {
          const body = `<html>${nav(actor)}<div id="info">PRIVATE-OPERATOR-REVIEW</div></html>`;
          return { status: 200, url: urls[0], headers: new Headers(),
            arrayBuffer: async () => new TextEncoder().encode(body).buffer };
        }
        const catalog = urls.includes(url);
        const body = catalog ? `<html>${nav(contaminated || init.credentials !== 'omit' ? actor : null)}<div id="info">目录</div></html>` : profile(target, actor);
        return { status: 200, url, headers: new Headers({ 'content-type': 'text/html' }), arrayBuffer: async () => new TextEncoder().encode(body).buffer };
      },
    });
    // 与生产使用同一个 RequestGate，只把时钟替换为确定性时钟，避免测试真实睡眠。
    runner._gate._now = () => now;
    runner._gate._sleep = async ms => { now += ms; };
    return runner;
  };
  return { calls, dirs, runStore, makeRunner };
}

for (const cold of [false, true]) {
  test(`公开目录${cold ? '冷恢复旧队列' : '首次抓取'}：五种媒介不携带凭据，账号页仍用操作者会话`, async () => {
    const h = harness();
    let r = h.makeRunner();
    await r.start({ targetInput: '111', targetUserId: '111', operatorUserId: '222', includeCatalog: true,
      includeCovers: false, onlyRoutes: ['profile.overview', 'interest.item'] });
    for (const url of urls) r._run.frontier.enqueue({ url, urlKey: url, routeKey: 'interest.item', intent: 'interest.item', priority: 999, ordered: false });
    if (cold) {
      await r.pause();
      const cp = await h.runStore.loadCheckpoint();
      r = h.makeRunner();
      await r.resume(cp);
    }
    await r.runBatch();
    const manifest = await r.finish('complete');
    assert.equal(manifest.account.user_id, '111');
    assert.equal(manifest.crawl_scope.operator_user_id, '222');
    const catalog = h.calls.filter(c => urls.includes(c.url));
    assert.equal(catalog.length, 5);
    for (const c of catalog) {
      assert.equal(c.init.credentials, 'omit');
      assert.equal(c.init.cache, 'no-store');
      assert.ok(c.at - h.calls[h.calls.indexOf(c) - 1].at >= 5000);
    }
    for (const c of h.calls.filter(c => !urls.includes(c.url))) assert.equal(c.init.credentials, 'include');
    const reader = new BundleReader({ store: [...h.dirs.values()][0], bundleId: manifest.bundle_id });
    const rows = (await reader.index()).filter(row => row.intent === 'interest.item');
    assert.equal(rows.length, 5);
    assert.ok(rows.every(row => row.verdict === 'ok' && row.note.includes('不携带登录凭据')));
  });
}

test('本人目录抓取保留本人登录视图', async () => {
  const h = harness({ target: '222' }), r = h.makeRunner();
  await r.start({ targetInput: '222', targetUserId: '222', operatorUserId: '222', onlyRoutes: ['interest.item'], includeCatalog: true });
  r._run.frontier.enqueue({ url: urls[0], urlKey: urls[0], routeKey: 'interest.item', intent: 'interest.item', ordered: false });
  await r.runBatch();
  assert.equal(h.calls.at(-1).init.credentials, 'include');
  assert.equal((await r.finish('complete')).crawl_scope.visibility, 'self');
});

test('无凭据目录返回登录者页面时留为 unknown，不能被解析器摄取', async () => {
  const h = harness({ contaminated: true }), r = h.makeRunner();
  await r.start({ targetInput: '111', targetUserId: '111', operatorUserId: '222', onlyRoutes: ['interest.item'], includeCatalog: true });
  r._run.frontier.enqueue({ url: urls[0], urlKey: urls[0], routeKey: 'interest.item', intent: 'interest.item', ordered: false });
  await r.runBatch();
  assert.equal(r.status().stoppedBy, 'operator_switched');
  const manifest = await r.abort();
  const reader = new BundleReader({ store: [...h.dirs.values()][0], bundleId: manifest.bundle_id });
  assert.equal((await reader.index()).find(row => row.intent === 'interest.item').verdict, 'unknown');
});

test('匿名目录豁免只作用于该响应，下一账号页仍拒绝操作者退出或换号', () => {
  const session = new SessionGuard({ visibility: 'public', operatorMode: 'authenticated', operatorUserId: '222' });
  session.bindTarget({ userId: '111', username: '111' });
  session.verify(nav(null), urls[0], { anonymousCatalog: true });
  assert.throws(() => session.verify(profile('111', null), 'https://www.douban.com/people/111/'), { reason: 'operator_session_lost' });
  assert.throws(() => session.verify(profile('111', '333'), 'https://www.douban.com/people/111/'), { reason: 'operator_switched' });
  assert.doesNotThrow(() => session.verify(profile('111', '222'), 'https://www.douban.com/people/111/'));
});

for (const cold of [false, true]) {
  test(`公开目录 PoW ${cold ? '冷恢复' : '首次抓取'}：自动求解 PoW 并成功捕获详情，安全隔离仅摄取客观元数据`, async () => {
    const h = harness({ pow: true });
    let r = h.makeRunner();
    await r.start({ targetInput: '111', targetUserId: '111', operatorUserId: '222',
      onlyRoutes: ['interest.item'], includeCatalog: true });
    r._run.frontier.enqueue({ url: urls[0], urlKey: urls[0], routeKey: 'interest.item', intent: 'interest.item', ordered: false });
    if (cold) {
      await r.pause();
      const cp = await h.runStore.loadCheckpoint();
      r = h.makeRunner();
      await r.resume(cp);
    }
    await r.runBatch();
    assert.equal(r.status().stoppedBy, null);
    assert.equal(h.calls.filter(c => c.init.method === 'POST').length, 1);
    const catalog = h.calls.filter(c => urls.includes(c.url));
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].init.credentials, 'omit');
    assert.equal(catalog[0].init.cache, 'no-store');
    const manifest = await r.abort();
    const reader = new BundleReader({ store: [...h.dirs.values()][0], bundleId: manifest.bundle_id });
    const row = (await reader.index()).find(row => row.intent === 'interest.item');
    assert.equal(row.verdict, 'ok');
    const capture = await reader.readEntry(row);
    assert.match(capture.bodyText, /PRIVATE-OPERATOR-REVIEW/);
    assert.match(row.note, /通过客户端算力证明（PoW）获取/);
  });
}

test('未标记 powSolved 的匿名目录请求仍严禁操作者登录态混入', () => {
  const session = new SessionGuard({ visibility: 'public', operatorMode: 'authenticated', operatorUserId: '222' });
  session.bindTarget({ userId: '111', username: '111' });
  assert.throws(() => session.verify(nav('222'), urls[0], { anonymousCatalog: true, powSolved: false }),
    { reason: 'operator_switched' });
  assert.doesNotThrow(() => session.verify(nav('222'), urls[0], { anonymousCatalog: true, powSolved: true }));
});
