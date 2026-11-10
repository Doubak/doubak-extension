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
import { exportBundle, fileStoreSink } from '../src/bundle/exporter.js';
import { importBundle, readBundleMeta } from '../src/bundle/importer.js';
import { parse } from '../src/vendor/parser/parse.js';
import { project } from '../src/vendor/site-generator/projection.js';
import { buildPages } from '../src/vendor/site-generator/pages.js';
import { buildNeodbNdjson } from '../src/vendor/export-adapters/targets/neodb-ndjson.js';

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
const review = `<html>${nav}<h1><span property="v:summary">可访问影评</span></h1>
<div class="main-bd" id="review-1234567-content"><div id="link-report-1234567">
<div class="review-content" data-url="${nextUrl}">可访问的影评正文</div></div></div></html>`;
function harness(status = 403, { errorBody, errorFinalUrl } = {}) {
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
        body = errorBody ?? html.replace('USER_ID: "REDACTED_UID"', 'USER_ID: "222"'); code = status;
      } else if (request === url || request === nextUrl) body = review.replaceAll('1234567', /review\/(\d+)/.exec(request)[1]);
      return { status: code, url: request === url && !allowed ? errorFinalUrl ?? request : request,
        headers: new Headers({ 'content-type': 'text/html' }),
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
  assert.equal(runner.status().failures.find(item => item.url === url).attempts, 1,
    '响应已经保存，不能仍显示尝试过 0 次');
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

test('权限恢复的成功响应已提交、checkpoint 未更新：不重抓，清除旧权限缺口', async () => {
  const h = harness(); let runner = h.makeRunner();
  await start(runner); await until(runner, batch => batch.done);
  h.allow();
  await runner.retryFailed();
  const before = await h.runStore.loadCheckpoint();
  assert.ok(before.routes.some(route => route.gaps.some(gap => gap.url === url)));
  await runner.runBatch();
  runner = h.makeRunner(); await runner.resume(before);
  await until(runner, batch => batch.done);
  assert.equal(h.calls.filter(u => u === url).length, 2, '已提交成功响应不能再请求');
  const manifest = await runner.finish();
  assert.ok(!manifest.crawl_state.find(route => route.route_key === 'review.item').gaps.some(gap => gap.url === url),
    '成功事实必须消除旧 checkpoint 中该 URL 的权限缺口');
  assert.equal(manifest.counts.by_verdict.denied, 1, '旧失败捕获仍须保留');
});

for (const scenario of [
  { name: '普通 403', status: 403, errorBody: '<html>Forbidden</html>', verdict: 'blocked' },
  { name: 'HTTP 429', status: 429, verdict: 'blocked' },
  { name: 'HTTP 418', status: 418, verdict: 'blocked' },
  { name: '风控域', status: 200, errorFinalUrl: 'https://sec.douban.com/', verdict: 'blocked' },
  { name: '验证码', status: 200, errorBody: '<html>请输入验证码</html>', verdict: 'challenge' },
]) test(`${scenario.name} 在实际抓取链路仍停机、降速，禁止继续其他影评或带缺口收尾`, async () => {
  const h = harness(scenario.status, scenario); const runner = h.makeRunner();
  await start(runner);
  const batch = await until(runner, () => h.calls.includes(url));
  assert.equal(batch.stoppedBy, scenario.verdict);
  assert.ok(!h.calls.includes(nextUrl));
  const cp = await h.runStore.loadCheckpoint();
  assert.equal(cp.frontier.find(item => item.url === url).state, 'awaiting_human');
  assert.equal(cp.rate_state.backoff_level, 1);
  await runner.runBatch();
  assert.equal(h.calls.filter(u => u === url).length, 1, '不自动重试');
  await assert.rejects(runner.finish('complete', { acceptLeafGaps: true }), /软封锁/);
});

test('权限页上的操作者切换仍须停止全场，不能被局部失败处理掩盖', async () => {
  const h = harness(403, { errorBody: html.replace('USER_ID: "REDACTED_UID"', 'USER_ID: "333"') });
  const runner = h.makeRunner(); await start(runner);
  const batch = await until(runner, () => h.calls.includes(url));
  assert.equal(batch.stoppedBy, 'operator_switched');
  assert.ok(!h.calls.includes(nextUrl));
});

test('含 denied 的真实产出可原样导出再导入，解析和网站不会混入错误页', async () => {
  const h = harness(); const runner = h.makeRunner();
  await start(runner); await until(runner, batch => batch.done);
  const manifest = await runner.finish('complete', { acceptLeafGaps: true });
  const store = [...h.dirs.values()][0];
  const exported = new MemoryFileStore(), imported = new MemoryFileStore();
  assert.equal((await exportBundle({ store, sink: fileStoreSink(exported) })).verified, true);
  assert.deepEqual((await readBundleMeta(exported, `doubak-bundle-${manifest.bundle_id}`)).fatal, []);
  assert.equal((await importBundle({ source: exported, dest: imported })).verified, true);
  for (const name of await store.list()) assert.deepEqual(await imported.read(name), await store.read(name), name);
  const reader = new BundleReader({ store: imported, bundleId: manifest.bundle_id });
  const rows = await reader.index();
  const source = { manifest, bundleId: manifest.bundle_id, status: manifest.status,
    crawlState: new Map(manifest.crawl_state.map(route => [route.route_key, route])),
    coverage: new Map(), close() {},
    payload: async row => {
      assert.notEqual(row.verdict, 'denied', '拒绝页不应被内容解析器读取');
      return (await reader.readEntry(row)).bodyText;
    } };
  const result = await parse([{ ...source, index: rows }]);
  const baseline = await parse([{ ...source, index: rows.filter(row => row.verdict !== 'denied') }]);
  assert.equal(result.longform.length, 1, '不能以空输出冒充解析成功');
  assert.deepEqual(result.longform, baseline.longform);
  assert.equal(result.stats.skipped['verdict:denied'], 1);
  assert.deepEqual(result.warnings, baseline.warnings);
  assert.deepEqual(buildPages(project(result)), buildPages(project(baseline)));
  assert.deepEqual(buildNeodbNdjson(result), buildNeodbNdjson(baseline));
  assert.doesNotMatch(JSON.stringify(buildPages(project(result))), /你没有权限访问这个页面/);
});
