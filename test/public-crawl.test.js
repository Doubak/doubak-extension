import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeTarget, inspectTarget, assertTargetResponse } from '../src/crawl/target-account.js';
import { CrawlRunner } from '../src/crawl/runner.js';
import { RunStore } from '../src/crawl/run-store.js';
import { MemoryKvStore } from '../src/storage/kv-store.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { chainEntryFromManifest, pickFloors, bundlesForAccount, chainOf, findChainHoles, newestForAccount } from '../src/crawl/chain.js';
import { BundleReader } from '../src/bundle/bundle-reader.js';
import { TEST_PRODUCER_VERSION } from './helpers/producer.js';

const nav = (operator) => operator ? `<li class="nav-user-account"><span>操作者的账号</span></li><script>window._GLOBAL_NAV={USER_ID: "${operator}"};</script>` : '<li class="nav-login">登录</li>';
const profile = (target, operator) => `<html><title>目标</title>${nav(operator)}
  <img src="https://img1.doubanio.com/icon/up999-1.jpg" alt="访客">
  <div id="db-usr-profile"><div class="pic"><img src="https://img1.doubanio.com/icon/up${target}-1.jpg" alt="目标昵称"></div>
  <div class="info"><h1>目标 &amp; 昵称<span>编辑</span></h1></div></div></html>`;
const probe = (target, operator, slug = 'target') => ({ status: 200, finalUrl: `https://www.douban.com/people/${slug}/`, bodyText: profile(target, operator) });
const contactCaptchaProfile = readFileSync(new URL('./fixtures/profile-public-contact-captcha.html', import.meta.url), 'utf8');

test('带 _dtcc 参数的正常公开主页：关注弹窗脚本不能误报验证码', () => {
  const url = 'https://www.douban.com/people/38258402/?_dtcc=1';
  const input = normalizeTarget(url);
  assert.equal(input, '38258402');
  const target = inspectTarget({ status: 200, finalUrl: url, bodyText: contactCaptchaProfile }, input);
  assert.equal(target.account.userId, input);
  assert.equal(target.operatorMode, 'anonymous');
  assert.equal(target.visibility, 'public');
  assert.doesNotThrow(() => assertTargetResponse({ ...probe('111', null), bodyText: profile('111', null) + '<p>我的简介提到了验证码和 captcha</p>' }));
});

test('实际验证码页面或表单仍拦截，不能因为包含主页框架就放行', () => {
  for (const bodyText of [
    '<html><title>请输入验证码</title><body>继续访问前请验证</body></html>',
    '<html><body>请输入验证码</body></html>',
    profile('111', null) + '<form><input name="captcha-solution" type="text"></form>',
    profile('111', null) + "<iframe src='/captcha/challenge'></iframe>",
  ]) assert.throws(() => assertTargetResponse({ status: 200, finalUrl: 'https://www.douban.com/people/111/', bodyText }), { reason: 'challenge' });
  assert.throws(() => assertTargetResponse({ status: 403, finalUrl: 'https://www.douban.com/people/111/', bodyText: contactCaptchaProfile }), { reason: 'blocked' });
  assert.throws(() => assertTargetResponse({ status: 200, finalUrl: 'https://sec.douban.com/', bodyText: contactCaptchaProfile }), { reason: 'blocked' });
});

test('目标输入只接受豆瓣主页、slug 或 UID，拒绝外域、子路径与凭据 URL', () => {
  for (const input of ['target', '111', 'https://www.douban.com/people/target/', 'https://douban.com/people/target/']) assert.equal(normalizeTarget(input), input.includes('https:') ? 'target' : input);
  for (const input of ['https://evil.test/people/111/', 'https://www.douban.com/people/111/statuses', 'http://www.douban.com/people/111/', 'https://u:p@www.douban.com/people/111/', 'mine', 'a/b']) assert.throws(() => normalizeTarget(input), { reason: 'invalid_target' });
});

test('第三方昵称与 UID 来自目标资料区块，绝不采用操作者导航或访客头像', () => {
  const result = inspectTarget(probe('111', '222'), 'target');
  assert.equal(result.account.userId, '111');
  assert.equal(result.account.displayName, '目标 & 昵称');
  assert.equal(result.operatorUserId, '222');
  assert.equal(result.visibility, 'public');
});

test('实际本人主页的 RSS 是 slug 时，仍以局部头像取得正确 UID', () => {
  const html = readFileSync(new URL('./fixtures/profile-2026-07.html', import.meta.url), 'utf8');
  const result = inspectTarget({ status: 200, finalUrl: 'https://www.douban.com/people/mewcatcher/', bodyText: html }, 'mewcatcher');
  assert.equal(result.account.userId, '82160871');
  assert.equal(result.account.displayName, 'MewX');
  assert.equal(result.visibility, 'self');
});

test('数字输入重定向绑定最新域名，但数字证据冲突或目标变化时拒绝', () => {
  assert.equal(inspectTarget(probe('111', '222', 'new_slug'), '111').account.username, 'new_slug');
  assert.throws(() => inspectTarget(probe('333', '222'), '111'), { reason: 'target_changed' });
  assert.throws(() => inspectTarget(probe('111', '222'), 'target', { targetUserId: '333' }), { reason: 'target_changed' });
});

function harness({ responseHtml = null } = {}) {
  const kv = new MemoryKvStore();
  const dirs = new Map();
  const calls = [];
  let target = '111', operator = '222', slug = 'target', privacy = false;
  const openBundle = async (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, new MemoryFileStore());
    return dirs.get(dir);
  };
  const runStore = new RunStore({ kv, openBundle });
  const makeRunner = () => new CrawlRunner({ runStore, openBundle, producerVersion: TEST_PRODUCER_VERSION,
    pacerOptions: { intervalMs: 1, jitterRatio: 0 }, batchSize: 1,
    fetchImpl: async (url) => {
      calls.push(url);
      const finalUrl = url.includes('statuses') ? url : `https://www.douban.com/people/${slug}/`;
      const body = privacy && url.includes('statuses') ? `<html>${nav(operator)}<div id="db-usr-profile"></div><div class="stream-items"><div class="people-truncation-hint">由于用户的设置，无法查看更多内容</div></div><span data-total-page="9223372036854775807">1</span><a href="?p=2">后页</a></html>` : profile(target, operator);
      return { status: 200, url: finalUrl, headers: new Headers(), arrayBuffer: async () => new TextEncoder().encode(responseHtml ?? body).buffer };
    },
  });
  return { dirs, calls, runStore, makeRunner, set: (data) => {
    if ('target' in data) target = data.target;
    if ('operator' in data) operator = data.operator;
    if ('slug' in data) slug = data.slug;
    if ('privacy' in data) privacy = data.privacy;
  } };
}

const options = { targetInput: 'target', targetUserId: '111', operatorUserId: '222', onlyRoutes: ['profile.overview'] };

test('公开主页含备用验证码脚本时，查看、开始与冷恢复均成功', async () => {
  const h = harness({ responseHtml: contactCaptchaProfile });
  h.set({ target: '38258402', operator: null, slug: '38258402' });
  const runner = h.makeRunner();
  const target = await runner.probeTarget('https://www.douban.com/people/38258402/?_dtcc=1');
  assert.equal(target.account.userId, '38258402');
  await runner.start({ targetInput: '38258402', targetUserId: '38258402', operatorUserId: null, onlyRoutes: ['profile.overview'] });
  await runner.pause();
  const resumed = h.makeRunner();
  await resumed.resume(await h.runStore.loadCheckpoint());
  const manifest = await resumed.abort();
  assert.equal(manifest.account.user_id, '38258402');
  assert.equal(manifest.crawl_scope.operator_mode, 'anonymous');
});

for (const cold of [false, true]) {
  test(`${cold ? '冷' : '热'}公开恢复保留目标 A 和原操作者 B，拒绝 C、退出登录与 slug 被抢注`, async () => {
    const h = harness();
    const a = h.makeRunner();
    await a.start(options);
    await a.pause();
    const r = cold ? h.makeRunner() : a;
    for (const [change, reason] of [[{ operator: '333' }, 'operator_switched'], [{ operator: null }, 'operator_session_lost'], [{ operator: '222', target: '444' }, 'target_changed']]) {
      h.set(change);
      await assert.rejects(async () => r.resume(await h.runStore.loadCheckpoint()), { reason });
      assert.equal((await h.runStore.loadCheckpoint()).run_context.account.userId, '111');
    }
    h.set({ operator: '222', target: '111' });
    await r.resume(await h.runStore.loadCheckpoint());
    const manifest = await r.abort();
    assert.equal(manifest.account.user_id, '111');
    assert.equal(manifest.account.nickname, '目标 & 昵称');
    assert.deepEqual(manifest.crawl_scope, { visibility: 'public', operator_mode: 'authenticated', operator_user_id: '222', skip_catalog: true });
  });
}

test('匿名公开断点不能恢复成登录视图，恢复原匿名状态后继续', async () => {
  const h = harness(); h.set({ operator: null });
  const a = h.makeRunner();
  await a.start({ ...options, operatorUserId: null });
  await a.pause();
  h.set({ operator: '222' });
  const r = h.makeRunner();
  await assert.rejects(async () => r.resume(await h.runStore.loadCheckpoint()), { reason: 'operator_switched' });
  h.set({ operator: null });
  await r.resume(await h.runStore.loadCheckpoint());
  await r.runBatch();
  const manifest = await r.finish('complete');
  assert.equal(manifest.crawl_scope.operator_mode, 'anonymous');
  const reader = new BundleReader({ store: [...h.dirs.values()][0], bundleId: manifest.bundle_id });
  assert.equal((await reader.index())[0].verdict, 'ok');
});

test('公开轻量化过滤 owner-only 路线，冷恢复不扩大范围与 catalog 开关', async () => {
  const h = harness();
  const a = h.makeRunner();
  await a.start({ ...options, onlyRoutes: null, includeCovers: false });
  await a.pause();
  const keys = [...a._run.routes.keys()];
  for (const key of ['group.publish', 'group.item', 'interest.item', 'asset.subject_cover']) assert.equal(keys.includes(key), false);
  const pointer = await h.runStore.getCurrentRun();
  await h.runStore.setCurrentRun({ ...pointer, username: 'other-account', includeCatalog: true, includeCovers: true, onlyRoutes: null });
  const r = h.makeRunner();
  await r.resume(await h.runStore.loadCheckpoint());
  assert.deepEqual([...r._run.routes.keys()], keys);
  const manifest = await r.finish('aborted');
  assert.equal(manifest.account.username, 'target');
  assert.equal(manifest.account.profile_url, 'https://www.douban.com/people/target/');
});

test('启动握手拒绝旧 Preflight UID，无目录与运行指针副作用', async () => {
  const h = harness(); h.set({ target: '333' });
  await assert.rejects(() => h.makeRunner().start(options), { reason: 'target_changed' });
  assert.equal(h.dirs.size, 0);
  assert.equal(await h.runStore.getCurrentRun(), undefined);
});

test('同 UID 改域名后不继续旧队列；操作账号切换的响应保留为不可摄取捕获', async () => {
  const h = harness();
  const a = h.makeRunner();
  const start = await a.start(options);
  await a.pause();
  h.set({ slug: 'new_slug' });
  await assert.rejects(async () => h.makeRunner().resume(await h.runStore.loadCheckpoint()), { reason: 'target_changed' });
  h.set({ slug: 'target', operator: '333' });
  // 从已在内存里的运行任务逐页检查，不能把操作者 C 的响应写成 ok。
  a._run.frontier.clearStop();
  const result = await a.runBatch();
  assert.equal(result.stoppedBy, 'operator_switched');
  const reader = new BundleReader({ store: h.dirs.get(start.dir), bundleId: start.bundleId });
  assert.equal((await reader.index())[0].verdict, 'unknown');
});

test('广播隐私截断熔断翻页，绝不请求 ?p=2，也不推进水位线', async () => {
  const h = harness(); h.set({ privacy: true });
  const r = h.makeRunner();
  await r.start({ ...options, onlyRoutes: ['broadcast.timeline'] });
  const result = await r.runBatch();
  assert.equal(result.done, true);
  assert.equal(h.calls.some((url) => url.includes('p=2')), false);
  const manifest = await r.finish('complete');
  assert.equal(manifest.crawl_state[0].advanced, false);
  assert.equal(manifest.crawl_state[0].contiguous, false);
  assert.equal(manifest.crawl_state[0].gaps[0].reason, 'user_privacy_settings');
});

test('同一 UID 的本人、公开匿名和公开登录基准隔离；跨账号 previous 与下界不能构成链', () => {
  const row = { route_key: 'broadcast.timeline', advanced: true, high_water_time: '2026-01-01T00:00:00Z' };
  const entries = ['self', 'public:anonymous', 'public:authenticated'].map((scope, i) => {
    const [visibility, operator_mode = 'authenticated'] = scope.split(':');
    return chainEntryFromManifest({ bundle_id: `B${i}`, account: { user_id: '111', username: 'target' }, crawl_scope: { visibility, operator_mode, operator_user_id: operator_mode === 'authenticated' ? '222' : null }, crawl_state: [row] });
  });
  for (const entry of entries) {
    const me = { accountUserId: '111', accountUsername: 'target', visibility: entry.visibility, operatorMode: entry.operatorMode, operatorUserId: entry.operatorUserId };
    assert.deepEqual(bundlesForAccount(entries, me).map((e) => e.bundleId), [entry.bundleId]);
    assert.equal(pickFloors(entries, me).get(row.route_key).fromBundleId, entry.bundleId);
  }
  const bad = { ...entries[0], bundleId: 'BAD', accountUserId: '222', previousBundleId: 'B0', crawlState: [{ ...row, floor_time: row.high_water_time, floor_from_bundle_id: 'B0' }] };
  assert.deepEqual(chainOf([...entries, bad], 'BAD').map((e) => e.bundleId), ['BAD']);
  assert.equal(findChainHoles([...entries, bad])[0].kind, 'mismatch');
});

test('同目标的公开登录基准也必须匹配操作者 UID，旧档案缺失操作者证据时重建全量', () => {
  const entries = [
    { bundleId: 'A', accountUserId: '111', visibility: 'public', operatorMode: 'authenticated', operatorUserId: '222', crawlState: [{ route_key: 'broadcast.timeline', advanced: true, high_water_time: '2026-01-01T00:00:00Z' }] },
    { bundleId: 'B', accountUserId: '111', visibility: 'public', operatorMode: 'authenticated', operatorUserId: '333', crawlState: [] },
    { bundleId: 'legacy', accountUserId: '111', visibility: 'public', operatorMode: 'authenticated', crawlState: [] },
  ];
  const me = { accountUserId: '111', visibility: 'public', operatorMode: 'authenticated', operatorUserId: '222' };
  assert.deepEqual(bundlesForAccount(entries, me).map((e) => e.bundleId), ['A']);
  assert.equal(pickFloors(entries, me).get('broadcast.timeline').fromBundleId, 'A');
  assert.equal(pickFloors(entries, { ...me, operatorUserId: '444' }).size, 0);
});

test('上游取目标最新档案，全库最新的 B 和公开视图不能成为 A 本人增量的 previous', () => {
  const entries = [
    { bundleId: '20261001T000000Z-aaaaaa', accountUserId: '111', accountUsername: 'target', visibility: 'self' },
    { bundleId: '20261003T000000Z-bbbbbb', accountUserId: '222', accountUsername: 'other', visibility: 'self' },
    { bundleId: '20261002T000000Z-cccccc', accountUserId: '111', accountUsername: 'target', visibility: 'public' },
  ];
  assert.equal(newestForAccount(entries, { accountUserId: '111', accountUsername: 'target' }).bundleId, entries[0].bundleId);
  assert.equal(newestForAccount(entries, {}), null);
});


const aliasProfile = () => profile('111', '111').replace(
  '<img src="https://img1.doubanio.com/icon/up111-1.jpg" alt="目标昵称">',
  '<a href="https://www.douban.com/people/owner/"><img src="https://img1.doubanio.com/icon/up111-1.jpg" alt="目标昵称"></a>',
);

test('数字主页没有重定向时，域名取目标头像链接，不取访客或操作者', () => {
  for (const slug of ['111', 'owner']) {
    const result = inspectTarget({ status: 200, finalUrl: `https://www.douban.com/people/${slug}/`, bodyText: aliasProfile() }, slug);
    assert.equal(result.account.username, 'owner');
    assert.equal(result.account.userId, '111');
  }
  const publicHtml = aliasProfile().replace('USER_ID: "111"', 'USER_ID: "222"');
  assert.equal(inspectTarget({ status: 200, finalUrl: 'https://www.douban.com/people/111/', bodyText: publicHtml }, '111').account.username, 'owner');
  assert.throws(() => inspectTarget({ status: 200, finalUrl: 'https://www.douban.com/people/111/', bodyText: aliasProfile().replace('/people/owner/', '/people/222/') }, '111'), { reason: 'target_changed' });
});

for (const explicit of [false, true]) {
  test(`${explicit ? '网址输入' : '默认检测'}以数字地址访问也选回原域名的增量基准`, async () => {
    const h = harness({ responseHtml: aliasProfile() }); h.set({ target: '111', operator: '111', slug: '111' });
    const runner = h.makeRunner();
    const entries = [chainEntryFromManifest({ bundle_id: '20261011T000000Z-aaaaaa', account: { user_id: '111', username: 'owner' },
      crawl_state: [{ route_key: 'broadcast.timeline', advanced: true, high_water_time: '2026-10-11T00:00:00+08:00' }] })];
    let picked;
    await runner.start({ ...(explicit ? { targetInput: 'https://www.douban.com/people/111/' } : { username: '111' }),
      onlyRoutes: ['profile.overview'], includeCatalog: false,
      resolveFloors: (account) => {
        picked = pickFloors(entries, { accountUserId: account.userId, accountUsername: account.username });
        return { floors: new Map([...picked].map(([k, v]) => [k, v.floorTime])), previousBundleId: newestForAccount(entries, { accountUserId: account.userId, accountUsername: account.username })?.bundleId };
      },
    });
    assert.equal(picked.size, 1);
    await runner.pause();
    await h.makeRunner().resume(await h.runStore.loadCheckpoint());
    const cp = await h.runStore.loadCheckpoint();
    assert.equal(cp.run_context.account.username, 'owner');
    assert.equal((await h.runStore.getCurrentRun()).previousBundleId, '20261011T000000Z-aaaaaa');
  });
}

for (const cold of [false, true]) {
  test(`${cold ? '冷' : '热'}恢复旧数字域名断点时不改任务地址`, async () => {
    const h = harness(); h.set({ target: '111', operator: '111', slug: '111' });
    const runner = h.makeRunner();
    await runner.start({ targetInput: '111', onlyRoutes: ['profile.overview'], includeCatalog: false });
    await runner.pause();
    const resumed = cold ? h.makeRunner() : runner;
    resumed._fetchImpl = async (url) => ({ status: 200, url, headers: new Headers(), arrayBuffer: async () => new TextEncoder().encode(aliasProfile()).buffer });
    await resumed.resume(await h.runStore.loadCheckpoint());
    assert.equal(resumed.status().targetAccount.username, '111');
    assert.equal((await h.runStore.loadCheckpoint()).run_context.account.username, '111');
  });
}
