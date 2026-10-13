import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, readRepoFile } from './helpers/fake-dom.js';
import { fakeOpfsWorker, seedBundle } from './helpers/fake-opfs-worker.js';

let nonce = 0;
const settle = () => new Promise((r) => setTimeout(r, 15));

async function panel({ pendingSession = null, status = null, bundles = true } = {}) {
  const worker = fakeOpfsWorker();
  if (bundles) {
    for (const [uid, nickname, id] of [['111', '我的昵称', '20261001T000000Z-aaaaaa'], ['222', '朋友昵称', '20261002T000000Z-bbbbbb']]) {
      await seedBundle(worker, `doubak-bundle-${id}`, {
        'manifest.json': JSON.stringify({ bundle_id: id, account: { user_id: uid, username: uid, nickname },
          status: 'complete', crawl_scope: { visibility: uid === '111' ? 'self' : 'public', operator_mode: 'authenticated', operator_user_id: '111' },
          created_at: '2026-10-01T00:00:00Z', segments: [], index: { line_count: 0 },
          coverage: [], crawl_state: [{ route_key: 'broadcast.timeline', advanced: true, contiguous: true, high_water_time: '2026-10-01T00:00:00Z', gaps: [], enumeration: 'bounded' }] }),
        [`index-${id}.ndjson`]: '',
      });
    }
  }
  const session = { state: 'logged_in', account: { userId: '111', displayName: '我的昵称' } };
  const dom = await installFakeDom({ html: await readRepoFile('src/ui/panel.html'), extra: { Worker: class { constructor() { return worker; } } },
    onMessage: (msg) => {
      if (msg.type === 'status') return status ?? { ok: true, runner: { active: false }, checkpoint: null };
      if (msg.type === 'detectSession') return pendingSession ?? { ok: true, session };
      if (msg.type === 'probeTarget') return { ok: true, target: { account: { userId: '222', username: '222', displayName: '朋友昵称' }, visibility: 'public', operatorMode: 'authenticated', operatorUserId: '111' } };
      if (msg.type === 'preflight') return { ok: true, permissions: null, storage: null, incremental: null };
      return { ok: true };
    },
  });
  // 假 DOM 从 HTML 取 id；checked 属性在真实浏览器中由 HTML 初始值提供。
  dom.byId.get('public-lightweight').checked = true;
  dom.byId.get('public-covers').checked = true;
  await import(`../src/ui/panel.js?accounts=${++nonce}`);
  await settle();
  return dom;
}

test('会话探测在飞时空输入可立即开始；提示更新不覆盖用户输入，轮询不重新探测', async () => {
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const dom = await panel({ pendingSession: pending, bundles: false });
  try {
    assert.equal(dom.byId.get('actions').querySelector('button').disabled, false);
    const input = dom.byId.get('target-account');
    assert.equal(input.value, 'https://www.douban.com/people/');
    assert.equal(dom.byId.get('probe-target').hidden, true);
    input.value = ''; input.dispatch('input');
    assert.equal(dom.byId.get('actions').querySelector('button').disabled, false);
    assert.equal(dom.byId.get('probe-target').hidden, true);
    input.value = '正在输入';
    input.dispatch('input');
    resolve({ ok: true, session: { state: 'logged_in', account: { userId: '111', displayName: '我的昵称' } } });
    await settle();
    assert.equal(input.value, '正在输入');
    for (let i = 0; i < 4; i++) await dom.tick();
    assert.equal(dom.sent.filter((m) => m.type === 'detectSession').length, 1);
    assert.match(dom.byId.get('operator-session').textContent, /我的昵称/);
  } finally { dom.restore(); }
});

test('查看账号有加载与重试反馈，重复 Enter 不发请求，旧答复不能确认新输入', async () => {
  const dom = await panel({ bundles: false });
  try {
    const input = dom.byId.get('target-account');
    const button = dom.byId.get('probe-target');
    const replies = [];
    const original = dom.chrome.runtime.sendMessage;
    dom.chrome.runtime.sendMessage = (msg, cb) => msg.type === 'probeTarget'
      ? replies.push(cb) : original(msg, cb);
    input.value = '222'; input.dispatch('input');
    assert.equal(button.hidden, false);
    assert.equal(button.textContent, '查看账号');
    button.dispatch('click');
    assert.equal(button.textContent, '正在查看…');
    assert.equal(button.disabled, true);
    input.dispatch('keydown', { key: 'Enter', preventDefault() {} });
    assert.equal(replies.length, 1);
    replies[0]({ ok: false, error: '网络不可用' }); await settle();
    assert.equal(button.textContent, '重试查看');
    assert.equal(button.disabled, false);
    assert.match(dom.byId.get('target-preview').textContent, /网络不可用/);
    button.dispatch('click');
    input.value = '333'; input.dispatch('input');
    replies[1]({ ok: true, target: { account: { userId: '222', username: '222', displayName: '旧账号' }, visibility: 'public', operatorMode: 'anonymous' } });
    await settle();
    assert.equal(button.textContent, '查看账号');
    assert.equal(dom.byId.get('actions').querySelector('button').disabled, true);
    assert.equal(dom.byId.get('target-preview').hidden, true);
    assert.equal(dom.sent.some((m) => m.type === 'start'), false);
  } finally { dom.restore(); }
});

test('本地气泡按 UID 选择，探测后显示明确目标并将公开轻量选项传到后台', async () => {
  const dom = await panel();
  try {
    const chips = dom.byId.get('target-accounts').querySelectorAll('button');
    assert.equal(chips.length, 2);
    assert.match(chips.find((b) => b.dataset.uid === '111').textContent, /自己的账号/);
    assert.doesNotMatch(chips.find((b) => b.dataset.uid === '222').textContent, /自己的账号|他人账号/);
    assert.equal(dom.byId.has('refresh-session'), false);
    assert.equal(dom.byId.has('target-accounts-datalist'), false);
    chips.find((b) => b.dataset.uid === '222').dispatch('click');
    await settle();
    assert.equal(dom.byId.get('target-account').value, '222');
    assert.equal(chips.find((b) => b.dataset.uid === '222').getAttribute('aria-selected'), 'true');
    assert.equal(dom.byId.get('public-options').hidden, false);
    assert.match(dom.byId.get('target-preview').textContent, /1 条路线可接续/);
    const start = dom.byId.get('actions').querySelector('button');
    assert.match(start.textContent, /为【朋友昵称】开始增量抓取/);
    await start.onclick();
    await settle();
    assert.deepEqual(dom.sent.find((m) => m.type === 'start').target,
      { input: '222', userId: '222', operatorUserId: '111', includeCatalog: false, includeCovers: true });
  } finally { dom.restore(); }
});

test('冷断点显示原目标与原操作者，锁定输入；继续消息不携带 UI 里另一个账号', async () => {
  const context = { account: { userId: '222', username: '222', displayName: '朋友昵称' }, visibility: 'public', operatorMode: 'authenticated', operatorUserId: '111' };
  const dom = await panel({ status: { ok: true, runner: { active: false }, checkpoint: { bundle_id: '20261002T000000Z-bbbbbb', pause_reason: 'user_paused', run_context: context } } });
  try {
    assert.equal(dom.byId.get('target-controls').disabled, true);
    assert.match(dom.byId.get('run-identity').textContent, /朋友昵称（UID 222）/);
    assert.match(dom.byId.get('run-identity').textContent, /操作者：UID 111/);
    dom.byId.get('target-account').value = '333';
    await dom.byId.get('actions').querySelector('button').onclick();
    await settle();
    assert.deepEqual(dom.sent.find((m) => m.type === 'resume'), { type: 'resume' });
  } finally { dom.restore(); }
});

test('多账号导出必须选择；未知归属不跟着其他账号混入派生数据', async () => {
  const dom = await panel();
  try {
    const formats = await import('../src/ui/panel/formats.js');
    await formats.loadFormats();
    assert.equal(dom.byId.get('formats-accounts').hidden, false);
    assert.equal(dom.byId.get('export-canonical').disabled, true);
    const buttons = dom.byId.get('formats-accounts').querySelectorAll('button');
    assert.ok(buttons.every((b) => b.getAttribute('aria-selected') === 'false'));
    buttons.find((b) => b.textContent.includes('UID 222')).dispatch('click');
    assert.equal(dom.byId.get('export-canonical').disabled, false);
    const shared = await import('../src/ui/panel/shared.js');
    shared.invalidateBundleScan();
    const scans = await Promise.all(Array.from({ length: 8 }, () => shared.scanBundleDirs()));
    assert.ok(scans.every((scan) => scan === scans[0]), '概览和导出并发加载共享同一次本地扫描');
    const entries = await shared.scanBundleDirs();
    const selected = formats.entriesFor([...entries, { bundleId: 'unknown', manifest: null }]);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].manifest.account.user_id, '222');
  } finally { dom.restore(); }
});

test('完整主页网址包含跟踪参数也能探测；单账号导出仍显示账号', async () => {
  const dom = await panel({ bundles: false });
  try {
    const input = dom.byId.get('target-account');
    for (const url of ['https://www.douban.com/people/mewcatcher/?_i=1898892Pm_7AxF', 'https://www.douban.com/people/mewcatcher/']) {
      input.value = url; input.dispatch('input');
      dom.byId.get('probe-target').dispatch('click'); await settle();
      assert.equal(dom.sent.findLast((m) => m.type === 'probeTarget').input, 'mewcatcher');
      assert.equal(input.value, url);
    }
    const shared = await import('../src/ui/panel/shared.js');
    const entries = await shared.scanBundleDirs();
    entries.push({ bundleId: 'single', manifest: { account: { user_id: '111', nickname: '唯一账号' } } });
    const formats = await import('../src/ui/panel/formats.js');
    await formats.loadFormats();
    assert.equal(dom.byId.get('formats-accounts').hidden, false);
    assert.match(dom.byId.get('formats-accounts').textContent, /唯一账号/);
    assert.equal(dom.byId.get('formats-accounts').querySelector('button').getAttribute('aria-pressed'), 'true');
    assert.equal(dom.byId.get('export-canonical').disabled, false);
  } finally { dom.restore(); }
});

test('覆盖率按选择的账号与视角请求具体链，档案页按 UID 分组', async () => {
  const dom = await panel();
  try {
    const archive = await import('../src/ui/panel/archive.js');
    archive.selectSummaryBundle('20261001T000000Z-aaaaaa');
    const coverage = await import('../src/ui/panel/coverage.js');
    // 链答复需真实的空结构，其他消息仍复用原假后台。
    const original = dom.chrome.runtime.sendMessage;
    dom.chrome.runtime.sendMessage = (msg, cb) => msg.type === 'chain'
      ? (dom.sent.push(msg), cb({ ok: true, chain: { routes: [], bundles: [], holes: [], others: [] } })) : original(msg, cb);
    await coverage.loadCoverage();
    assert.equal(dom.sent.findLast((m) => m.type === 'chain').bundleId, '20261001T000000Z-aaaaaa');
    const select = dom.byId.get('coverage-accounts').querySelector('select');
    select.value = '222'; select.dispatch('change'); await settle();
    assert.equal(dom.sent.findLast((m) => m.type === 'chain').bundleId, '20261002T000000Z-bbbbbb');
    await archive.loadArchive();
    assert.match(dom.byId.get('bundle-pick').textContent, /我的昵称（UID 111）/);
    assert.match(dom.byId.get('bundle-pick').textContent, /朋友昵称（UID 222）/);
  } finally { dom.restore(); }
});
