import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, readRepoFile } from './helpers/fake-dom.js';
import { fakeOpfsWorker, seedBundle } from './helpers/fake-opfs-worker.js';

let nonce = 0;
const settle = () => new Promise((r) => setTimeout(r, 15));

async function panel({ pendingSession = null, status = null, bundles = true, extraSources = [], extraBundles = [] } = {}) {
  const worker = fakeOpfsWorker();
  if (bundles) {
    for (const [uid, nickname, id, scope] of [['111', '我的昵称', '20261001T000000Z-aaaaaa'], ['222', '朋友昵称', '20261002T000000Z-bbbbbb'], ...extraSources]) {
      await seedBundle(worker, `doubak-bundle-${id}`, {
        'manifest.json': JSON.stringify({ bundle_id: id, account: { user_id: uid, username: uid, nickname },
          status: 'complete', crawl_scope: scope ?? { visibility: uid === '111' ? 'self' : 'public', operator_mode: 'authenticated', operator_user_id: '111' },
          created_at: '2026-10-01T00:00:00Z', segments: [], index: { line_count: 0 },
          coverage: [], crawl_state: [{ route_key: 'broadcast.timeline', advanced: true, contiguous: true, high_water_time: '2026-10-01T00:00:00Z', gaps: [], enumeration: 'bounded' }] }),
        [`index-${id}.ndjson`]: '',
      });
    }
  }
  for (const [dir, files] of extraBundles) {
    await seedBundle(worker, dir, files);
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
  dom.worker = worker;
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

test('覆盖率只有一种来源时无需筛选，按账号请求具体链，档案页按 UID 分组', async () => {
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
    assert.equal(dom.byId.get('coverage-accounts').querySelectorAll('select').length, 1);
    assert.match(dom.byId.get('chain').textContent, /本人登录时备份/);
    const select = dom.byId.get('coverage-accounts').querySelector('select');
    select.value = '222'; select.dispatch('change'); await settle();
    assert.equal(dom.sent.findLast((m) => m.type === 'chain').bundleId, '20261002T000000Z-bbbbbb');
    assert.equal(dom.byId.get('coverage-accounts').querySelectorAll('select').length, 1);
    assert.match(dom.byId.get('chain').textContent, /公开页面备份 · 登录账号 UID 111/);
    assert.doesNotMatch(dom.byId.get('coverage-accounts').textContent, /视图|视角/);
    await archive.loadArchive();
    assert.match(dom.byId.get('bundle-pick').textContent, /我的昵称（UID 111）/);
    assert.match(dom.byId.get('bundle-pick').textContent, /朋友昵称（UID 222）/);
  } finally { dom.restore(); }
});


test('同一账号默认展示全部来源的独立链，筛选不串账号；单份对账保留来源和档案标识', async () => {
  const ids = ['20261001T000000Z-aaaaaa', '20261003T000000Z-cccccc', '20261004T000000Z-dddddd'];
  const dom = await panel({ extraSources: [
    ['111', '我的昵称', ids[1], { visibility: 'public', operator_mode: 'anonymous' }],
    ['111', '我的昵称', ids[2], { visibility: 'public', operator_mode: 'authenticated', operator_user_id: '333' }],
  ] });
  try {
    const archive = await import('../src/ui/panel/archive.js');
    archive.selectSummaryBundle(ids[0]);
    const coverage = await import('../src/ui/panel/coverage.js');
    const original = dom.chrome.runtime.sendMessage;
    dom.chrome.runtime.sendMessage = (msg, cb) => msg.type === 'chain'
      ? (dom.sent.push(msg), cb({ ok: true, chain: { routes: [], bundles: [], holes: [], others: [] } })) : original(msg, cb);
    await coverage.loadCoverage();
    assert.deepEqual(dom.sent.filter((m) => m.type === 'chain').map((m) => m.bundleId).sort(), ids);
    const box = dom.byId.get('coverage-accounts');
    assert.equal(box.querySelectorAll('select').length, 2);
    assert.match(box.textContent, /全部来源/);
    for (const label of ['本人登录时备份', '公开页面备份 · 未登录', '公开页面备份 · 登录账号 UID 333']) {
      assert.ok(dom.byId.get('chain').textContent.includes(label));
    }
    const filter = box.querySelectorAll('select')[1];
    dom.sent.length = 0;
    filter.value = 'public:anonymous'; filter.dispatch('change'); await settle();
    assert.deepEqual(dom.sent.filter((m) => m.type === 'chain').map((m) => m.bundleId), [ids[1]]);
    assert.doesNotMatch(dom.byId.get('chain').textContent, /本人登录时备份|登录账号 UID 333/);
    const one = dom.byId.get('coverage-view').querySelectorAll('button')[1];
    one.onclick(); await settle();
    assert.match(dom.byId.get('coverage').textContent, /公开页面备份 · 未登录/);
    assert.ok(dom.byId.get('coverage').textContent.includes(ids[1]));
    assert.equal(dom.byId.get('chain').textContent, '');
    // 切到只有一种来源的账号后，不继承上一账号的匿名筛选。
    const account = box.querySelector('select');
    account.value = '222'; account.dispatch('change'); await settle();
    assert.equal(box.querySelectorAll('select').length, 1);
    assert.match(dom.byId.get('coverage').textContent, /公开页面备份 · 登录账号 UID 111/);
    assert.doesNotMatch(dom.byId.get('coverage').textContent, /未登录|UID 333/);
    // 返回原账号时恢复全部来源；每份数据仍带独立档案标识。
    const back = box.querySelector('select');
    back.value = '111'; back.dispatch('change'); await settle();
    for (const id of ids) assert.ok(dom.byId.get('coverage').textContent.includes(id));
    dom.byId.get('coverage-view').querySelector('button').onclick(); await settle();
  } finally { dom.restore(); }
});

test('覆盖率快速切换账号时旧链答复不覆盖新账号，清空档案后清除旧筛选', async () => {
  const dom = await panel();
  try {
    const archive = await import('../src/ui/panel/archive.js');
    archive.selectSummaryBundle('20261001T000000Z-aaaaaa');
    const coverage = await import('../src/ui/panel/coverage.js');
    const original = dom.chrome.runtime.sendMessage;
    let reply;
    const empty = { ok: true, chain: { routes: [], bundles: [], holes: [], others: [] } };
    dom.chrome.runtime.sendMessage = (msg, cb) => {
      if (msg.type !== 'chain') return original(msg, cb);
      if (msg.bundleId === '20261001T000000Z-aaaaaa') reply = () => cb(empty);
      else cb(empty);
    };
    const first = coverage.loadCoverage();
    await settle();
    const select = dom.byId.get('coverage-accounts').querySelector('select');
    select.value = '222'; select.dispatch('change'); await settle();
    reply(); await first;
    assert.match(dom.byId.get('chain').textContent, /公开页面备份 · 登录账号 UID 111/);
    assert.doesNotMatch(dom.byId.get('chain').textContent, /本人登录时备份/);
    const shared = await import('../src/ui/panel/shared.js');
    (await shared.scanBundleDirs()).length = 0;
    archive.invalidateBundles([]);
    await coverage.loadCoverage();
    assert.match(dom.byId.get('coverage').textContent, /暂无档案/);
    assert.equal(dom.byId.get('coverage-accounts').hidden, true);
    assert.equal(dom.byId.get('coverage-accounts').textContent, '');
    assert.equal(dom.byId.get('chain').textContent, '');
  } finally { dom.restore(); }
});

test('在抓取进行中（最新档案无 manifest）时，覆盖率页显示已归档账号覆盖率并允许切换账号', async () => {
  const activeId = '20261015T000000Z-abcdef';
  const dom = await panel({
    status: {
      ok: true,
      runner: { active: true, bundleId: activeId, targetAccount: { userId: '111', username: '111', displayName: '我的昵称' } },
      checkpoint: null,
    },
    extraBundles: [
      [`doubak-bundle-${activeId}`, {
        [`index-${activeId}.ndjson`]: '',
        'checkpoint.json': JSON.stringify({
          bundle_id: activeId,
          run_context: { account: { userId: '111', username: '111', displayName: '我的昵称' } },
        }),
      }],
    ],
  });
  try {
    const coverage = await import('../src/ui/panel/coverage.js');
    const original = dom.chrome.runtime.sendMessage;
    dom.chrome.runtime.sendMessage = (msg, cb) => msg.type === 'chain'
      ? (dom.sent.push(msg), cb({ ok: true, chain: { routes: [{ name: '广播', span: '1..10', bundles: 1, verdict: '✔ 已验证' }], bundles: [{ bundleId: msg.bundleId }], holes: [], others: [] } }))
      : original(msg, cb);

    await coverage.loadCoverage();

    // 覆盖率账号选择框可见，包含两个已收尾的账号
    assert.equal(dom.byId.get('coverage-accounts').hidden, false);
    const select = dom.byId.get('coverage-accounts').querySelector('select');
    assert.ok(select);
    assert.equal(select.querySelectorAll('option').length, 2);
    assert.equal(select.value, '111');

    // 默认展示正在抓取账号 UID 111 已收尾的链，且提示抓取正在进行中
    const lastChain = dom.sent.findLast((m) => m.type === 'chain');
    assert.equal(lastChain.bundleId, '20261001T000000Z-aaaaaa');
    assert.doesNotMatch(dom.byId.get('chain').textContent, /备份来源待确认/);
    assert.doesNotMatch(dom.byId.get('chain').textContent, /暂无已收尾的档案/);
    assert.match(dom.byId.get('chain').textContent, /本人登录时备份/);
    assert.match(dom.byId.get('chain').textContent, /本次抓取正在进行中/);

    // 切换到另一个账号 UID 222（未在抓取该账号，不展示进行中提示）
    select.value = '222';
    select.dispatch('change');
    await settle();
    assert.equal(dom.sent.findLast((m) => m.type === 'chain').bundleId, '20261002T000000Z-bbbbbb');
    assert.match(dom.byId.get('chain').textContent, /公开页面备份 · 登录账号 UID 111/);
    assert.doesNotMatch(dom.byId.get('chain').textContent, /本次抓取正在进行中/);
  } finally { dom.restore(); }
});

test('仅有未收尾的抓取档案时，覆盖率页提示尚未收尾而非空链或来源待确认', async () => {
  const activeId = '20261015T000000Z-abcdef';
  const dom = await panel({
    bundles: false,
    status: {
      ok: true,
      runner: { active: true, bundleId: activeId, targetAccount: { userId: '111', username: '111', displayName: '我的昵称' } },
      checkpoint: null,
    },
    extraBundles: [
      [`doubak-bundle-${activeId}`, {
        [`index-${activeId}.ndjson`]: '',
        'checkpoint.json': JSON.stringify({
          bundle_id: activeId,
          run_context: { account: { userId: '111', username: '111', displayName: '我的昵称' } },
        }),
      }],
    ],
  });
  try {
    const coverage = await import('../src/ui/panel/coverage.js');
    await coverage.loadCoverage();
    assert.equal(dom.byId.get('coverage-accounts').hidden, true);
    assert.doesNotMatch(dom.byId.get('coverage').textContent, /备份来源待确认/);
    assert.doesNotMatch(dom.byId.get('chain').textContent, /暂无已收尾的档案/);
    assert.match(dom.byId.get('coverage').textContent, /本次抓取尚未收尾——覆盖率证据在收尾时生成，目前尚不可用。/);
  } finally { dom.restore(); }
});

for (const cold of [false, true]) {
  test(`覆盖率如实显示${cold ? '冷断点' : '内存任务'}暂停状态`, async () => {
    const account = { userId: '111', username: '111' };
    const dom = await panel({ status: {
      ok: true,
      runner: cold ? { active: false } : { active: true, stopped: true, targetAccount: account },
      checkpoint: cold ? { run_context: { account }, pause_reason: 'challenge' } : null,
    } });
    try {
      const archive = await import('../src/ui/panel/archive.js');
      archive.selectSummaryBundle('20261001T000000Z-aaaaaa');
      const original = dom.chrome.runtime.sendMessage;
      dom.chrome.runtime.sendMessage = (msg, cb) => msg.type === 'chain'
        ? cb({ ok: true, chain: { routes: [], bundles: [], holes: [], others: [] } }) : original(msg, cb);
      await (await import('../src/ui/panel/coverage.js')).loadCoverage();
      assert.match(dom.byId.get('chain').textContent, /本次抓取已暂停/);
      assert.doesNotMatch(dom.byId.get('chain').textContent, /本次抓取正在进行中/);
    } finally { dom.restore(); }
  });
}

test('所选账号消失后，不能把剩下唯一账号当成导出目标', async () => {
  const dom = await panel();
  try {
    const formats = await import('../src/ui/panel/formats.js');
    await formats.loadFormats();
    dom.byId.get('formats-accounts').querySelectorAll('button')
      .find((b) => b.textContent.includes('UID 222')).dispatch('click');
    const remaining = [{ bundleId: 'a', manifest: { account: { user_id: '111' } } }];
    assert.throws(() => formats.entriesFor(remaining), /重新选择导出账号/);
    assert.throws(() => formats.entriesFor([{ bundleId: 'orphan', manifest: null }]), /重新选择导出账号/);
    assert.deepEqual(formats.entriesFor(remaining, '111'), remaining);
  } finally { dom.restore(); }
});

test('单账号也锁定 UID，但不影响单账号导出目录命名', async () => {
  const dom = await panel({ bundles: false, extraSources: [], extraBundles: [
    ['doubak-bundle-20261001T000000Z-aaaaaa', {
      'manifest.json': JSON.stringify({ account: { user_id: '111' } }),
      'index-20261001T000000Z-aaaaaa.ndjson': '',
    }],
  ] });
  try {
    const formats = await import('../src/ui/panel/formats.js');
    await formats.loadFormats();
    assert.throws(() => formats.entriesFor([{ bundleId: 'b', manifest: { account: { user_id: '222' } } }]), /重新选择导出账号/);
  } finally { dom.restore(); }
});

test('扫描和文件夹选择期间重复点击不启动第二项，也不能切换导出账号', async () => {
  const dom = await panel();
  let cancel;
  let pickers = 0;
  try {
    const formats = await import('../src/ui/panel/formats.js');
    await formats.loadFormats();
    const buttons = dom.byId.get('formats-accounts').querySelectorAll('button');
    buttons.find((b) => b.textContent.includes('UID 222')).dispatch('click');
    window.showDirectoryPicker = () => { pickers++; return new Promise((_, reject) => { cancel = reject; }); };
    dom.byId.get('export-canonical').dispatch('click');
    dom.byId.get('export-markdown').dispatch('click');
    buttons.find((b) => b.textContent.includes('UID 111')).dispatch('click');
    assert.equal(dom.byId.get('export-canonical').disabled, true);
    await settle();
    assert.equal(pickers, 1);
    const entries = await (await import('../src/ui/panel/shared.js')).scanBundleDirs();
    assert.equal(formats.entriesFor(entries)[0].manifest.account.user_id, '222');
    cancel(new Error('cancelled'));
    await settle();
    assert.equal(dom.byId.get('export-canonical').disabled, false);
  } finally { cancel?.(new Error('cancelled')); dom.restore(); }
});
