import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyResponse, profileForRoute, extractItemIds, extractDetailLinks } from '../src/crawl/classifier.js';
import { CrawlRunner } from '../src/crawl/runner.js';
import { RunStore } from '../src/crawl/run-store.js';
import { MemoryKvStore } from '../src/storage/kv-store.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { BundleReader } from '../src/bundle/bundle-reader.js';
import { TEST_PRODUCER_VERSION } from './helpers/producer.js';

const empty = readFileSync(new URL('./fixtures/notes-public-empty.html', import.meta.url), 'utf8');
const one = readFileSync(new URL('./fixtures/notes-public-one.html', import.meta.url), 'utf8');
const url = 'https://www.douban.com/people/target/notes?start=0';
const route = profileForRoute('note.list');
const classify = (bodyText, options = {}) => classifyResponse({ bodyText, finalUrl: url,
  status: 200, route, visibility: 'public', ...options });

for (const [name, html, count] of [['空列表', empty, 0], ['一条日记', one, 1]]) {
  test(`第三方真实页面结构：${name}，允许昵称标题`, () => {
    const result = classify(html);
    assert.equal(result.verdict, 'ok', result.reasons.join('; '));
    assert.equal(result.itemCount, count);
    assert.deepEqual(extractItemIds(html, route), count ? ['900000001'] : []);
    assert.deepEqual(extractDetailLinks(html, route), count ? ['https://www.douban.com/topic/900000001/'] : []);
    assert.equal(classify(html.replace(/<li class="nav-user-account">.*?<\/script>/s,
      '<li class="nav-login">登录</li>')).verdict, 'ok', '同样支持匿名公开页面');
  });
}

test('空列表不能靠标题或缺少条目推断：截断、框架缺失、额外正文都拒绝', () => {
  for (const html of [
    empty.slice(0, empty.indexOf('<div class="aside">')),
    empty.replace('id="db-usr-profile"', 'id="unknown-profile"'),
    empty.replace('的日记', '的相册').replace('的日记', '的相册'),
    empty.replace(/<a href="\/feed\/people\/target\/notes">.*?<\/a>/s, ''),
    empty.replace('</ul>', '</ul><div class="new-note-list">未识别的条目</div>'),
    empty.replace(/(<\/div>\s*)(<div class="aside">)/, '<p>暂时无法加载日记</p>$1$2'),
    one.replace('class="note-list"', 'class="new-note-list"'),
  ]) assert.notEqual(classify(html).verdict, 'ok', html);
});

test('登录、风控、错误状态和路线跳转仍优先于空列表框架', () => {
  assert.equal(classify(empty.replace('<title>示例用户的日记</title>', '<title>登录豆瓣</title>')).verdict, 'login');
  assert.notEqual(classify(empty + '<p>请输入验证码</p>').verdict, 'ok');
  assert.notEqual(classify(empty, { status: 403 }).verdict, 'ok');
  assert.notEqual(classify(empty, { status: 500 }).verdict, 'ok');
  assert.notEqual(classify(empty, { finalUrl: 'https://sec.douban.com/' }).verdict, 'ok');
  assert.notEqual(classify(empty, { finalUrl: 'https://www.douban.com/people/target/photos' }).verdict, 'ok');
  assert.notEqual(classify(empty, { finalUrl: 'https://www.douban.com/people/target/notes-other' }).verdict, 'ok');
});

function harness(pages) {
  const dirs = new Map(), calls = [];
  const openBundle = async dir => {
    if (!dirs.has(dir)) dirs.set(dir, new MemoryFileStore());
    return dirs.get(dir);
  };
  const runStore = new RunStore({ kv: new MemoryKvStore(), openBundle });
  let now = 0;
  const makeRunner = () => {
    const runner = new CrawlRunner({ runStore, openBundle, producerVersion: TEST_PRODUCER_VERSION,
      pacerOptions: { intervalMs: 1, jitterRatio: 0 }, batchSize: 1,
      fetchImpl: async requested => {
        calls.push(requested);
        const isList = requested.includes('/notes?');
        const body = isList ? pages.shift() : empty;
        assert.equal(typeof body, 'string', `意外请求 ${requested}`);
        return { status: 200, url: requested, headers: new Headers({ 'content-type': 'text/html' }),
          arrayBuffer: async () => new TextEncoder().encode(body).buffer };
      },
    });
    runner._gate._now = () => now;
    runner._gate._sleep = async ms => { now += ms; };
    return runner;
  };
  return { dirs, calls, runStore, makeRunner };
}
const options = { targetInput: 'target', targetUserId: '111', operatorUserId: '222',
  onlyRoutes: ['note.list'], includeCatalog: false, includeCovers: false };

for (const cold of [false, true]) {
  test(`公开空日记${cold ? '冷恢复后' : '首次抓取'}正常结束，保留目标账号和连续性`, async () => {
    const h = harness([empty]);
    let r = h.makeRunner();
    await r.start(options);
    if (cold) {
      await r.pause();
      r = h.makeRunner();
      await r.resume(await h.runStore.loadCheckpoint());
    }
    await r.runBatch();
    assert.deepEqual(r.status().failures, []);
    assert.equal(h.calls.filter(u => u.includes('/notes?')).length, 1);
    const state = r._run.loop.routeStates.get('note.list');
    assert.equal(state.contiguous, true);
    assert.equal(state.capturedCount, 0);
    const manifest = await r.finish('complete');
    assert.equal(manifest.account.user_id, '111');
    assert.equal(manifest.crawl_scope.operator_user_id, '222');
    const reader = new BundleReader({ store: [...h.dirs.values()][0], bundleId: manifest.bundle_id });
    assert.equal((await reader.index()).find(row => row.intent === 'note.list').verdict, 'ok');
  });
}

test('非空第三方日记分页按实取条数推进，冷恢复后在无容器空页结束', async () => {
  const h = harness([one, empty]);
  let r = h.makeRunner();
  await r.start(options);
  await r.runBatch();
  assert.deepEqual(r.status().failures, []);
  assert.equal(r._run.loop.routeStates.get('note.list').capturedCount, 1);
  await r.pause();
  r = h.makeRunner();
  await r.resume(await h.runStore.loadCheckpoint());
  await r.runBatch();
  assert.deepEqual(h.calls.filter(u => u.includes('/notes?')).map(u => new URL(u).searchParams.get('start')), ['0', '1']);
  assert.equal(r._run.loop.routeStates.get('note.list').contiguous, true);
  const manifest = await r.finish('complete');
  const coverage = manifest.coverage.find(row => row.route_key === 'note.list');
  assert.equal(coverage.captured_count, 1);
  assert.equal(coverage.claimed_count, null, '不能凭公开可见条数臆造声明总数');
});

test('旧版本未识别的失败分页：冷恢复不跳过，显式重试后才可完整收尾', async () => {
  const h = harness([empty, empty]);
  let r = h.makeRunner();
  await r.start(options);
  // 重现旧版分类器只认「我的日记」和 note-list 的失败，再用当前规则冷恢复。
  const original = route.frameAnchors;
  try {
    route.frameAnchors = [/<h1>\s*我的日记\s*<\/h1>/, /class="note-list"/];
    await r.runBatch();
  } finally {
    route.frameAnchors = original;
  }
  assert.equal(r.status().failures.length, 1);
  await r.pause();
  r = h.makeRunner();
  await r.resume(await h.runStore.loadCheckpoint());
  assert.equal(r.status().failures.length, 1);
  await assert.rejects(r.finish('complete'));
  assert.equal(await r.retryFailed({ routeKey: 'note.list' }), 1);
  await r.runBatch();
  assert.deepEqual(r.status().failures, []);
  assert.equal(r._run.loop.routeStates.get('note.list').contiguous, true);
  const manifest = await r.finish('complete');
  const reader = new BundleReader({ store: [...h.dirs.values()][0], bundleId: manifest.bundle_id });
  const rows = (await reader.index()).filter(row => row.intent === 'note.list');
  assert.deepEqual(rows.map(row => row.verdict), ['unknown', 'ok'], '原始失败捕获保留，成功重试追加');
});
