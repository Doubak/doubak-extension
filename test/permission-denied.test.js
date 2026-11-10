import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyResponse, ROUTE_PROFILES } from '../src/crawl/classifier.js';
import { CrawlRunner } from '../src/crawl/runner.js';
import { RunStore } from '../src/crawl/run-store.js';
import { MemoryKvStore } from '../src/storage/kv-store.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { BundleReader } from '../src/bundle/bundle-reader.js';
import { TEST_PRODUCER_VERSION } from './helpers/producer.js';
import { indexFilename } from '../src/core/ids.js';
import { verdictName } from '../src/ui/panel/shared.js';
import { Frontier } from '../src/crawl/frontier.js';

const html = readFileSync(new URL('./fixtures/review-permission-denied.html', import.meta.url), 'utf8');
const url = 'https://movie.douban.com/review/7575457/';
const classify = (over = {}) => classifyResponse({ bodyText: html, status: 403, finalUrl: url,
  visibility: 'public', route: ROUTE_PROFILES['review.item'], ...over });

for (const visibility of ['self', 'public']) for (const status of [200, 403]) {
  test(`真实影评权限页：${visibility} / HTTP ${status} → denied`, () => {
    const result = classify({ status, visibility });
    assert.equal(result.verdict, 'denied');
    assert.match(result.reasons.join(' '), /权限/);
  });
}

test('风控状态、验证域和登录页优先，不能借权限模板放行', () => {
  for (const status of [418, 429]) assert.equal(classify({ status }).verdict, 'blocked');
  assert.equal(classify({ status: 503 }).reason, 'server_error');
  assert.equal(classify({ finalUrl: 'https://sec.douban.com/c' }).verdict, 'blocked');
  assert.equal(classify({ bodyText: html.replace('没有访问权限</title>', '登录豆瓣</title>') }).verdict, 'login');
  assert.equal(classify({ bodyText: html.replace('你没有权限访问这个页面。', '访问过于频繁') }).verdict, 'blocked');
  assert.equal(classify({ status: 200, bodyText: html.replace('你没有权限访问这个页面。', '请输入验证码') }).verdict, 'challenge');
});

test('只有真实错误页结构与支持的路线同时满足才识别权限拒绝', () => {
  for (const bodyText of [
    '<title>没有访问权限</title>',
    html.replace('douban_error.gif', 'other.gif'),
    html.replace('你没有权限访问这个页面。', '请登录后重试'),
    html.replace('没有访问权限</title>', '影评</title>'),
    `<script>${html}</script>`, `<!--${html}-->`,
    '<html><title>影评</title><p>你没有权限访问这个页面。</p></html>',
  ]) assert.notEqual(classify({ bodyText }).verdict, 'denied');
  for (const finalUrl of ['https://movie.douban.com/review/7575457/comments',
    'https://movie.douban.com/subject/1/', 'https://example.com/review/7575457/']) {
    assert.equal(classify({ finalUrl }).verdict, 'blocked');
  }
  assert.equal(classify({ route: ROUTE_PROFILES['review.list'] }).verdict, 'blocked');
});

test('正常影评可以引用完整拒绝文案，内容框架存在时不能判成 denied', () => {
  const bodyText = html.replace('</body>', '<div class="review-content">这是正文引用的错误页</div></body>');
  assert.equal(classify({ status: 200, bodyText }).verdict, 'ok');
  assert.equal(classify({ status: 403, bodyText }).verdict, 'blocked');
});

test('denied 只释放独立条目；有序分页依然不能越过缺口', () => {
  for (const ordered of [false, true]) {
    const frontier = new Frontier();
    for (const key of ['first', 'next']) frontier.enqueue({ url: key, urlKey: key,
      routeKey: 'test', intent: 'test', ordered });
    const transition = frontier.settle(frontier.next(), 'denied', ['没有权限']);
    assert.equal(transition.state, 'failed');
    assert.equal(transition.retryable, false);
    assert.equal(frontier.stopped, false);
    assert.equal(frontier.next()?.url ?? null, ordered ? null : 'next');
  }
});

const nav = '<li class="nav-user-account">操作者</li><script>window._GLOBAL_NAV={USER_ID:"222"};</script>';
const profile = `<html><title>目标</title>${nav}<div id="db-usr-profile"><div class="pic"><img src="https://img1.doubanio.com/icon/up111-1.jpg"></div><div class="info"><h1>目标</h1></div></div></html>`;
const nextUrl = 'https://movie.douban.com/review/1234567/';
const review = `<html>${nav}<div class="review-content">可访问影评</div></html>`;
function harness(status = 403) {
  const dirs = new Map(), calls = [];
  let allowed = false;
  const openBundle = async dir => {
    if (!dirs.has(dir)) dirs.set(dir, new MemoryFileStore());
    return dirs.get(dir);
  };
  const runStore = new RunStore({ kv: new MemoryKvStore(), openBundle });
  const makeRunner = () => new CrawlRunner({ runStore, openBundle, producerVersion: TEST_PRODUCER_VERSION,
    pacerOptions: { intervalMs: 1, jitterRatio: 0 }, batchSize: 1,
    fetchImpl: async request => {
      calls.push(request);
      let body = profile, code = 200;
      if (request.includes('/reviews?')) {
        const items = request.endsWith('start=0') ? [url, nextUrl].map((u, i) => `<div class="main review-item" id="${i + 1}"><h2><a href="${u}">影评</a></h2><span class="main-meta">2026-11-01</span></div>`).join('') : '';
        body = `<html>${nav}<h1>评论(2)</h1><div class="review-list">${items}</div></html>`;
      } else if (request === url && !allowed) {
        body = html.replace('USER_ID: "REDACTED_UID"', 'USER_ID: "222"'); code = status;
      } else if (request === url || request === nextUrl) body = review;
      return { status: code, url: request, headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => new TextEncoder().encode(body).buffer };
    },
  });
  return { runStore, dirs, calls, makeRunner, allow: () => { allowed = true; } };
}
const start = runner => runner.start({ targetInput: 'target', targetUserId: '111', operatorUserId: '222',
  onlyRoutes: ['review.list', 'review.item'], includeCatalog: false, includeCovers: false });
async function until(runner, predicate) {
  for (let i = 0; i < 20; i++) {
    const batch = await runner.runBatch();
    if (predicate(batch)) return batch;
    assert.equal(batch.stoppedBy, null, '权限拒绝不得引发整场风控暂停');
  }
  assert.fail('未在有限批次内达到预期状态');
}

for (const status of [200, 403]) test(`HTTP ${status} 失败保留原文，冷恢复不重试，其他影评继续，收尾保留缺口`, async () => {
  const h = harness(status);
  let runner = h.makeRunner();
  await start(runner);
  await until(runner, () => h.calls.includes(url));
  assert.equal(runner.status().stoppedBy, null);
  const cp = await h.runStore.loadCheckpoint();
  assert.equal(cp.frontier.find(it => it.url === url).state, 'failed');
  runner = h.makeRunner();
  await runner.resume(cp);
  await until(runner, batch => batch.done);
  assert.equal(h.calls.filter(u => u === url).length, 1);
  assert.equal(h.calls.filter(u => u === nextUrl).length, 1);
  await assert.rejects(runner.finish(), /收尾/);
  const manifest = await runner.finish('complete', { acceptLeafGaps: true });
  const state = manifest.crawl_state.find(s => s.route_key === 'review.item');
  assert.equal(state.advanced, false);
  assert.equal(state.contiguous, false);
  assert.ok(state.gaps.some(g => g.url === url && g.reason === 'access_denied'));
  assert.equal(manifest.counts.by_verdict.denied, 1);
  const reader = new BundleReader({ store: [...h.dirs.values()][0], bundleId: manifest.bundle_id });
  const denied = (await reader.index()).find(row => row.verdict === 'denied');
  assert.equal(denied.http_status, status);
  assert.equal(verdictName(denied), '无权访问');
  assert.match((await reader.readEntry(denied)).bodyText, /你没有权限访问这个页面/);
});

for (const missing of [false, true]) test(`denied 已写入但未记入 checkpoint（条目${missing ? '不在' : '在'}旧队列）：恢复失败与缺口，不重新请求`, async () => {
  const h = harness();
  let runner = h.makeRunner();
  await start(runner);
  let before;
  for (let i = 0; i < 20 && !h.calls.includes(url); i++) {
    before = await h.runStore.loadCheckpoint();
    await runner.runBatch();
  }
  assert.ok(h.calls.includes(url));
  if (missing) before.frontier = before.frontier.filter(item => item.url !== url);
  runner = h.makeRunner();
  await runner.resume(before);
  await until(runner, batch => batch.done);
  assert.equal(h.calls.filter(u => u === url).length, 1);
  const manifest = await runner.finish('complete', { acceptLeafGaps: true });
  assert.ok(manifest.crawl_state.find(s => s.route_key === 'review.item').gaps.some(g => g.url === url));
});

test('旧版 blocked 断点继续一次后识别 denied；之后普通冷恢复不再反复重试', async () => {
  const h = harness();
  let runner = h.makeRunner();
  await start(runner);
  await until(runner, () => h.calls.includes(url));
  const cp = await h.runStore.loadCheckpoint();
  // 构造 v1.6.0 的持久化状态：相同响应当时写为 blocked，队列等待人工。
  const item = cp.frontier.find(it => it.url === url);
  item.state = 'awaiting_human'; item.last_error = 'blocked：HTTP 403';
  const store = [...h.dirs.values()][0];
  const index = indexFilename(cp.bundle_id);
  const rows = new TextDecoder().decode(await store.read(index)).trim().split('\n').map(JSON.parse);
  for (const row of rows) if (row.url === url) row.verdict = 'blocked';
  await store.replace(index, new TextEncoder().encode(rows.map(JSON.stringify).join('\n') + '\n'));
  runner = h.makeRunner(); await runner.resume(cp);
  await until(runner, () => h.calls.filter(u => u === url).length === 2);
  const restored = h.makeRunner(); await restored.resume(await h.runStore.loadCheckpoint());
  await until(restored, batch => batch.done);
  assert.equal(h.calls.filter(u => u === url).length, 2);
  assert.equal(h.calls.filter(u => u === nextUrl).length, 1);
  const manifest = await restored.finish('complete', { acceptLeafGaps: true });
  assert.equal(manifest.counts.by_verdict.blocked, 1, '旧失败记录原样保留');
  assert.equal(manifest.counts.by_verdict.denied, 1);
});

test('权限恢复后的显式重试可成功，并清除此 URL 的缺口', async () => {
  const h = harness(); let runner = h.makeRunner();
  await start(runner); await until(runner, batch => batch.done);
  h.allow();
  assert.equal(await runner.retryFailed(), 1);
  runner = h.makeRunner();
  await runner.resume(await h.runStore.loadCheckpoint());
  await until(runner, batch => batch.done);
  const manifest = await runner.finish();
  assert.equal(h.calls.filter(u => u === url).length, 2);
  assert.ok(!manifest.crawl_state.find(s => s.route_key === 'review.item').gaps.some(g => g.url === url));
});
