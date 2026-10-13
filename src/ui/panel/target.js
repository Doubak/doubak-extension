/** 目标控件只保存待提交的意图；运行中的目标由后台断点决定。 */
import { $, send, scanBundleDirs } from './shared.js';
import { groupByAccount } from './formats.js';
import { normalizeTarget } from '../../crawl/target-account.js';
import { chainEntryFromManifest, pickFloors, newestForAccount } from '../../crawl/chain.js';

let mountedInput = null;
let lastScan = null;
let confirmed = null;
let lookupState = 'idle';
let session = null;
let groups = [];
let generation = 0;
let locked = false;
let runContext = null;
let changed = () => {};

const nameOf = (account) => account.displayName || account.nickname || account.username || account.userId;
const PROFILE_PREFIX = 'https://www.douban.com/people/';
const targetValue = () => {
  const value = $('target-account')?.value.trim() ?? '';
  return value === PROFILE_PREFIX ? '' : value;
};
const setText = (element, value) => { if (element.textContent !== value) element.textContent = value; };

function paintLookup() {
  const hasTarget = Boolean(targetValue());
  const button = $('probe-target');
  button.hidden = !hasTarget;
  button.disabled = locked || !hasTarget || lookupState === 'loading';
  for (const chip of $('target-accounts').querySelectorAll('button')) chip.disabled = locked || lookupState === 'loading';
  setText(button, { idle: '查看账号', loading: '正在查看…', ready: '重新查看', error: '重试查看' }[lookupState]);
  setText($('target-help'), !hasTarget
    ? '留空或只保留网址前缀，直接点击「开始抓取」备份已登录账号。'
    : lookupState === 'ready'
      ? '核对下方账号和备份选项，再点击「开始抓取」。'
      : '先查看昵称和可备份范围，确认后再开始抓取。也可以按 Enter 查看。');
}

function baselineFor(target) {
  const entries = (lastScan ?? []).filter((e) => e.manifest).map((e) => chainEntryFromManifest(e.manifest));
  const me = { accountUserId: target.account.userId, accountUsername: target.account.username,
    visibility: target.visibility, operatorMode: target.operatorMode, operatorUserId: target.operatorUserId };
  return { routes: pickFloors(entries, me).size, head: newestForAccount(entries, me) };
}

function paintSession() {
  const account = session?.account;
  setText($('operator-session'), locked && runContext
    ? `本次抓取的原操作者：${runContext.operatorMode === 'anonymous' ? '匿名访客' : `UID ${runContext.operatorUserId}`}。继续时将实时核对登录状态。`
    : account?.userId
    ? `已检测到当前登录：${nameOf(account)}（UID ${account.userId}）`
    : session?.state === 'logged_out' ? '当前未登录。可输入目标账号归档公开数据。' : '留空即可备份我的账号，开始时会核对登录状态。');
  for (const button of $('target-accounts').querySelectorAll('button')) {
    const group = groups.find((g) => g.userId === button.dataset.uid);
    setText(button, `${nameOf(group)}（UID ${group.userId}）${group.userId === account?.userId ? ' · 自己的账号' : ''} · ${group.entries.length} 份档案`);
  }
}

async function detectSession(force = false) {
  const mounted = mountedInput;
  try {
    const result = await send({ type: 'detectSession', force });
    if (mounted !== mountedInput) return;
    if (result?.ok) session = result.session;
  } catch { /* 提示探测失败不能阻止留空备份本人；权威握手仍会核对 */ }
  if (typeof document !== 'undefined' && $('operator-session')) paintSession();
}

function markSelected(uid = null) {
  for (const button of $('target-accounts').querySelectorAll('button')) {
    button.setAttribute('aria-selected', String(button.dataset.uid === uid));
    button.setAttribute('aria-pressed', String(button.dataset.uid === uid));
  }
}

function renderConfirmedPreview() {
  if (!confirmed) return;
  const { account, visibility, operatorMode, operatorUserId } = confirmed;
  const local = groups.find((g) => g.userId === account.userId);
  const baseline = baselineFor(confirmed);
  const preview = $('target-preview');
  preview.hidden = false;
  preview.className = 'card tone-ok';
  preview.textContent = `${visibility === 'self' ? '已匹配当前登录账号，备份本人视图' : '已识别公开目标'}：${nameOf(account)}（UID ${account.userId}，域名 ${account.username}）。`
    + (visibility === 'public' ? `操作者：${operatorMode === 'anonymous' ? '匿名访客' : `已登录账号 UID ${operatorUserId}`}。` : '')
    + (baseline.routes ? `本地基准 ${baseline.head.bundleId}，${baseline.routes} 条路线可接续，仅抓新增部分。`
      : local ? `本地有 ${local.entries.length} 份档案；当前域名与视角没有可接续的水位线，将建立全量基准。` : '将建立此账号的全量基准。');
  $('public-options').hidden = visibility !== 'public';
}

export async function probeTarget(expectedUid = null) {
  const value = targetValue();
  if (locked || !value.trim() || lookupState === 'loading') return;
  const token = ++generation;
  confirmed = null;
  lookupState = 'loading';
  const preview = $('target-preview');
  preview.hidden = false;
  preview.className = 'card tone-busy';
  preview.textContent = '正在读取账号信息与可备份范围…';
  paintLookup();
  changed();
  try {
    const input = normalizeTarget(value);
    const result = await send({ type: 'probeTarget', input, targetUserId: expectedUid });
    if (token !== generation) return;
    if (locked) { lookupState = 'idle'; return; }
    if (!result?.ok) throw new Error(result?.error ?? '后台未能确认目标');
    confirmed = { ...result.target, input: value };
    lookupState = 'ready';
    markSelected(confirmed.account.userId);
    renderConfirmedPreview();
  } catch (err) {
    if (token !== generation) return;
    lookupState = 'error';
    preview.className = 'card tone-error';
    preview.textContent = `无法读取账号：${err.message}`;
  } finally {
    if (token === generation) {
      paintLookup();
      changed();
    }
  }
}

export function initTargetControls(onChange) {
  changed = onChange;
  const input = $('target-account');
  if (!input || mountedInput === input) return;
  mountedInput = input;
  input.value = PROFILE_PREFIX;
  confirmed = null;
  lookupState = 'idle';
  session = null;
  groups = [];
  lastScan = null;
  generation++;
  $('target-account').addEventListener('input', () => {
    generation++;
    confirmed = null;
    lookupState = 'idle';
    markSelected();
    $('public-options').hidden = true;
    $('target-preview').className = 'card tone-idle';
    $('target-preview').hidden = true;
    paintLookup();
    changed();
  });
  $('target-account').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void probeTarget(); }
  });
  $('probe-target').addEventListener('click', () => { void probeTarget(); });
  globalThis.chrome?.runtime?.onMessage?.addListener((message) => {
    if (message.type !== 'sessionHintsInvalidated' || mountedInput !== input || locked) return;
    confirmed = null;
    lookupState = 'idle';
    generation++;
    if (targetValue()) {
      $('target-preview').hidden = false;
      $('target-preview').className = 'card tone-idle';
      $('target-preview').textContent = '登录状态已变化，请重新查看账号，确认可备份范围后开始。';
    }
    $('public-options').hidden = true;
    paintLookup();
    changed();
    void detectSession(true);
  });
  // 只在挂载时探测，2 秒状态轮询绝不请求会话。
  paintLookup();
  void detectSession();
  void loadAccounts();
}

async function loadAccounts() {
  const mounted = mountedInput;
  try {
    const entries = await scanBundleDirs();
    if (mounted !== mountedInput || entries === lastScan || typeof document === 'undefined') return;
    groups = groupByAccount(entries).groups;
    const box = $('target-accounts');
    box.className = 'btn-row';
    box.replaceChildren();
    box.hidden = !groups.length;
    for (const group of groups) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'act';
      button.dataset.uid = group.userId;
      button.setAttribute('aria-selected', 'false');
      button.addEventListener('click', () => {
        if (locked || lookupState === 'loading') return;
        $('target-account').value = group.userId;
        markSelected(group.userId);
        void probeTarget(group.userId);
      });
      box.append(button);
    }
    paintSession();
    lastScan = entries;
    markSelected(confirmed?.account.userId ?? null);
    renderConfirmedPreview();
    changed();
  } catch (err) {
    // 本地清单不可用仍能输入目标；不能把读取失败显示成「没有已有账号」。
    const box = $('target-accounts');
    if (mounted !== mountedInput || !box) return;
    box.hidden = false;
    box.className = 'small muted';
    setText(box, `本地账号暂时无法读取：${err.message}`);
  }
}

export function updateTargetControls(context, isLocked) {
  const wasLocked = locked;
  locked = isLocked;
  runContext = context;
  if (!$('target-controls')) return;
  $('target-controls').disabled = locked;
  paintLookup();
  paintSession();
  if (wasLocked && !locked) void detectSession(true);
  if (!locked) void loadAccounts();
  for (const input of $('crawl-mode').querySelectorAll('input')) input.disabled = locked;
  const run = $('run-identity');
  run.hidden = !context;
  if (context) setText(run, `本次目标：${nameOf(context.account)}（UID ${context.account.userId}）· ${context.visibility === 'public' ? '公开视图' : '本人视图'} · 操作者：${context.operatorMode === 'anonymous' ? '匿名访客' : `UID ${context.operatorUserId}` }。继续只恢复此目标。`);
}

export function targetIntent(mode) {
  const input = targetValue();
  if (!input) return { ready: true, label: '开始抓取', target: null };
  if (!confirmed || confirmed.input.trim() !== input) return { ready: false,
    label: lookupState === 'loading' ? '正在查看账号…' : '查看账号后即可开始抓取', target: null };
  const { account, visibility, operatorUserId } = confirmed;
  const incremental = mode !== 'full' && baselineFor(confirmed).routes > 0;
  return {
    ready: true,
    label: `为【${nameOf(account)}】开始${incremental ? '增量抓取' : visibility === 'public' ? '抓取公开数据' : '抓取'}`,
    target: { input, userId: account.userId, operatorUserId,
      includeCatalog: visibility === 'self' || !$('public-lightweight').checked,
      includeCovers: visibility === 'self' || $('public-covers').checked },
  };
}
