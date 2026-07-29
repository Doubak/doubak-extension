/**
 * 完整面板（docs/ui.md 的 U2/U4/U5）。
 *
 * popup 只够「瞄一眼」；长任务的观察、覆盖率对账、档案预览都在这里——popup
 * 一失焦就关，放不下这些。
 *
 * ## 三条约束
 *
 * **① 只读状态、只发命令。** 抓取状态全在 service worker 那边，这里每次都
 * 重新读，绝不自己改。
 *
 * **② 进度不用百分比。** 豆瓣的计数不可信，拿它当分母会给出一个看起来特别
 * 可信的假数字。有时间边界的路线显示「已回溯到某日」。
 *
 * **③ 预览只读档案，不建缓存。** 档案本身就是真相；再存一份派生状态就会有
 * 两个可能不一致的来源。
 */

import { BundleReader } from '../bundle/bundle-reader.js';
import { OpfsFileStore } from '../storage/opfs-store.js';
import { bundleDirName } from '../core/ids.js';

const $ = (id) => document.getElementById(id);

/** @param {object} msg */
function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) =>
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r),
    );
  });
}

/** 界面上不出现内部术语。 */
const ROUTE_NAMES = {
  'broadcast.timeline': '广播',
  'profile.overview': '个人主页',
  'interest.movie.collect': '电影 · 看过',
  'interest.movie.wish': '电影 · 想看',
  'interest.movie.do': '电影 · 在看',
  'interest.book.collect': '书 · 读过',
  'interest.book.wish': '书 · 想读',
  'interest.book.do': '书 · 在读',
  'interest.music.collect': '音乐 · 听过',
  'interest.game.collect': '游戏 · 玩过',
  'interest.drama.collect': '舞台剧 · 看过',
  'interest.item': '作品详情页',
};
const routeName = (k) => ROUTE_NAMES[k] ?? k;

const VERDICT_NAMES = {
  ok: '正常',
  blocked: '被限制',
  challenge: '要验证',
  login: '未登录',
  gone: '已不存在',
  soft404: '页面不存在',
};

/** @param {number} n */
function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 建一个表格。 */
function table(headers, rows) {
  const t = document.createElement('table');
  const thead = document.createElement('tr');
  for (const h of headers) {
    const th = document.createElement('th');
    if (typeof h === 'object') {
      th.textContent = h.text;
      if (h.num) th.className = 'num';
    } else th.textContent = h;
    thead.append(th);
  }
  t.append(thead);
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      if (cell && typeof cell === 'object') {
        td.textContent = cell.text;
        if (cell.num) td.className = 'num';
        if (cell.muted) td.classList.add('muted');
      } else td.textContent = cell ?? '';
      tr.append(td);
    }
    t.append(tr);
  }
  return t;
}

// ── 标签页切换 ───────────────────────────────────────────────

$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  for (const b of $('tabs').querySelectorAll('button')) {
    const on = b === btn;
    b.setAttribute('aria-selected', String(on));
    $(`tab-${b.dataset.tab}`).hidden = !on;
  }
  if (btn.dataset.tab === 'archive') loadArchive();
});

// ── 概览 ────────────────────────────────────────────────────

const PAUSE_COPY = {
  challenge: ['warn', '豆瓣要求验证', '请在新标签页里完成验证，完成后回来点继续。插件和你共用登录状态。', '我验证好了，继续'],
  blocked: ['warn', '豆瓣暂时限制了访问', '已经停下来了，不会自动重试——继续请求可能导致账号被限制。建议等待 30 分钟以上。', '现在试试'],
  session_expired: ['warn', '登录状态已失效', '这不是错误，抓取已安全停下，进度都在。请重新登录豆瓣后继续。', '我登录好了，继续'],
  account_switched: ['err', '账号变了', '一个档案只能属于一个账号。请切回原来的账号，或另开一次抓取。', null],
  quota: ['err', '存储空间不足', '需要先导出或清理再继续。', null],
  user_paused: ['idle', '已暂停', '进度都在，随时可以继续。', '继续'],
  crash: ['run', '正在从断点恢复', '上次被意外中断，没有数据丢失。', null],
};

/** @param {string} cls @param {string} title @param {string} [why] */
function setState(cls, title, why = '') {
  const el = $('state');
  el.className = `card ${cls}`;
  el.replaceChildren();
  const b = document.createElement('b');
  b.textContent = title;
  el.append(b);
  if (why) el.append(document.createTextNode(why));
}

/** @param {Array<[string, () => void]>} buttons */
function setActions(buttons) {
  const el = $('actions');
  el.replaceChildren();
  for (const [label, fn] of buttons) {
    const b = document.createElement('button');
    b.className = 'act';
    b.textContent = label;
    b.onclick = fn;
    el.append(b);
  }
}

let lastStatus = null;

async function refresh() {
  const s = await send({ type: 'status' });
  lastStatus = s;

  if (!s?.ok) {
    setState('err', '连不上后台', s?.error ?? '');
    setActions([['重试', refresh]]);
    return;
  }

  if (s.runner?.active) {
    const r = s.runner;
    setState('run', '正在抓取', `档案 ${r.bundleId} · 当前间隔 ${(r.intervalMs / 1000).toFixed(1)} 秒` +
      (r.backoffLevel ? `（已降速 ${r.backoffLevel} 级）` : ''));
    setActions([['暂停', async () => { await send({ type: 'pause' }); refresh(); }]]);
    renderRoutes(r.routes ?? []);
    return;
  }

  if (s.checkpoint) {
    const [cls, title, why, action] = PAUSE_COPY[s.checkpoint.pause_reason] ??
      ['warn', '抓取已停下', `原因：${s.checkpoint.pause_reason}`, '继续'];
    setState(cls, title, why);
    setActions(action ? [[action, async () => { await send({ type: 'resume' }); refresh(); }]] : []);
    renderRoutes([]);
    return;
  }

  setState('idle', '没有进行中的抓取', '请求全部来自你自己的浏览器和 IP。cookie 不会发送到任何地方。');
  setActions([['开始抓取', async () => {
    setState('run', '正在确认账号…');
    const r = await send({ type: 'start' });
    if (!r?.ok) setState('err', '无法开始', r?.error ?? '');
    refresh();
  }]]);
  renderRoutes([]);
}

/** @param {Array<object>} routes */
function renderRoutes(routes) {
  const el = $('routes');
  el.replaceChildren();
  if (!routes.length) {
    el.className = 'muted';
    el.textContent = '还没有开始';
    return;
  }
  el.className = '';
  el.append(
    table(
      ['路线', { text: '已抓', num: true }, '已回溯到', '连续性'],
      routes.map((r) => [
        routeName(r.routeKey),
        { text: String(r.captured), num: true },
        // 进度用「已回溯到某日」而不是百分比——那个是真的
        r.highWater ? r.highWater.slice(0, 10) : { text: '—', muted: true },
        r.contiguous ? '✔ 已验证' : { text: '进行中', muted: true },
      ]),
    ),
  );
}

// ── 覆盖率 ──────────────────────────────────────────────────

/** @param {object[]} coverage @param {object[]} crawlState */
function renderCoverage(coverage, crawlState) {
  const el = $('coverage');
  el.replaceChildren();
  if (!coverage?.length) {
    el.className = 'muted';
    el.textContent = '还没有数据——跑完一条路线之后才会有。';
    return;
  }
  el.className = '';

  const csByRoute = new Map((crawlState ?? []).map((c) => [c.route_key, c]));
  el.append(
    table(
      ['路线', { text: '豆瓣声称', num: true }, { text: '实际抓到', num: true }, { text: '差值', num: true }, '连续性'],
      coverage.map((c) => {
        const cs = csByRoute.get(c.route_key);
        return [
          routeName(c.route_key),
          // null 与 0 是两件事，界面上也必须分开
          c.claimed_count === null ? { text: '—', muted: true, num: true } : { text: String(c.claimed_count), num: true },
          { text: String(c.captured_count), num: true },
          // 差值不用红色、不加感叹号、不写「缺失」——它不是错误
          c.delta === null ? { text: '—', muted: true, num: true } : { text: c.delta > 0 ? `+${c.delta}` : String(c.delta), num: true },
          cs ? (cs.contiguous ? '✔ 已验证' : '未验证') : { text: '—', muted: true },
        ];
      }),
    ),
  );

  // 差值非零时给出最可能的解释，免得用户以为是插件的 bug
  const odd = coverage.filter((c) => c.delta !== null && c.delta !== 0);
  if (odd.length) {
    const p = document.createElement('div');
    p.className = 'hint';
    p.textContent =
      '有差值的路线通常意味着有条目被豆瓣隐藏了——它的计数器知道这些条目存在，' +
      '但列表里不显示。你的备份本身是不是连续的，看「连续性」那一列。';
    el.append(p);
  }

  // 缺口要说出来，不能只显示一个叉
  for (const cs of crawlState ?? []) {
    if (!cs.gaps?.length) continue;
    const g = document.createElement('div');
    g.className = 'card warn';
    const b = document.createElement('b');
    b.textContent = `${routeName(cs.route_key)} · 连续性未验证`;
    g.append(b, document.createTextNode(
      `有 ${cs.gaps.length} 处缺口（${cs.gaps.map((x) => x.reason).join('、')}）。` +
      `这段区间的内容可能不完整，下次抓取会从上次的下界重走。`,
    ));
    el.append(g);
  }
}

// ── 档案预览 ────────────────────────────────────────────────

/** @type {BundleReader | null} */
let reader = null;
/** @type {object[]} */
let entries = [];

async function loadArchive() {
  const summaryEl = $('archive-summary');
  const bundleId = lastStatus?.runner?.bundleId ?? lastStatus?.checkpoint?.bundle_id;

  if (!bundleId) {
    summaryEl.className = 'muted';
    summaryEl.textContent = '还没有档案。开始一次抓取之后这里会显示内容。';
    return;
  }

  try {
    const store = await OpfsFileStore.open(bundleDirName(bundleId));
    reader = new BundleReader({ store, bundleId });
    const s = await reader.summary();
    entries = await reader.index();

    summaryEl.className = '';
    summaryEl.replaceChildren(
      table(
        ['项', '值'],
        [
          ['档案编号', s.bundleId],
          ['账号', `${s.account?.username ?? ''}（${s.account?.user_id ?? ''}）`],
          ['状态', s.status === 'complete' ? '已完成' : '进行中'],
          ['捕获条数', { text: String(s.captures), num: false }],
          ['体积', bytes(s.totalBytes)],
          ['判定分布', Object.entries(s.byVerdict).map(([k, v]) => `${VERDICT_NAMES[k] ?? k} ${v}`).join(' · ')],
        ],
      ),
    );
    renderCoverage(s.coverage, s.crawlState);
    renderCaptures();
  } catch (e) {
    summaryEl.className = 'card err';
    summaryEl.textContent = `读不出这个档案：${e.message}`;
  }
}

function renderCaptures() {
  const el = $('captures');
  el.replaceChildren();
  el.className = '';
  if (!entries.length) {
    el.className = 'muted';
    el.textContent = '这个档案里还没有捕获';
    return;
  }
  for (const e of entries.slice(0, 500)) {
    const row = document.createElement('div');
    row.dataset.id = e.capture_id;
    const left = document.createElement('span');
    left.textContent = routeName(e.route_key);
    const right = document.createElement('span');
    right.className = 'v';
    right.textContent = VERDICT_NAMES[e.verdict] ?? e.verdict;
    row.append(left, right);
    row.onclick = () => showCapture(e);
    el.append(row);
  }
  if (entries.length > 500) {
    const more = document.createElement('div');
    more.className = 'muted';
    more.textContent = `另有 ${entries.length - 500} 条未列出`;
    el.append(more);
  }
}

/** @param {object} entry */
async function showCapture(entry) {
  for (const d of $('captures').querySelectorAll('div[data-id]')) {
    d.setAttribute('aria-selected', String(d.dataset.id === entry.capture_id));
  }

  const el = $('preview');
  el.className = '';
  el.replaceChildren(document.createTextNode('正在读取…'));

  try {
    const r = await reader.readEntry(entry);
    el.replaceChildren();

    el.append(
      table(
        ['项', '值'],
        [
          ['URL', entry.url],
          ...(entry.final_url ? [['跟随跳转后', entry.final_url]] : []),
          ['判定', VERDICT_NAMES[entry.verdict] ?? entry.verdict],
          ['抓取原因', entry.intent],
          ['保真度', entry.capture_fidelity],
          ['抓取时间', entry.observed_at],
          ['所在段', `${entry.segment} @${entry.offset}+${entry.length}`],
        ],
      ),
    );

    const ct = (entry.content_type ?? '').toLowerCase();
    if (ct.startsWith('image/')) {
      // 图片直接显示。用 blob URL，不往 DOM 里塞 data URI。
      const img = document.createElement('img');
      img.src = URL.createObjectURL(new Blob([r.body], { type: entry.content_type }));
      img.onload = () => URL.revokeObjectURL(img.src);
      el.append(img);
    } else {
      // HTML 与 JSON 都以**源码**显示，不渲染。
      //
      // 这是刻意的：渲染存档下来的豆瓣页面会让它去加载外部资源，既破坏
      // 「离线可读」的前提，也把第三方请求带回来了——而这个项目的整个立场
      // 就是不依赖外部服务。
      const pre = document.createElement('pre');
      pre.textContent = r.bodyText.slice(0, 200_000);
      el.append(pre);
      if (r.bodyText.length > 200_000) {
        const note = document.createElement('div');
        note.className = 'muted';
        note.textContent = `（只显示前 200 KB，共 ${bytes(r.body.length)}）`;
        el.append(note);
      }
    }
  } catch (e) {
    el.className = 'card err';
    el.textContent = `读不出这条捕获：${e.message}`;
  }
}

$('verify').addEventListener('click', async () => {
  if (!reader) return;
  const el = $('verify-result');
  el.className = 'card idle';
  el.textContent = '正在逐条取出并解压…';

  try {
    const v = await reader.verify();
    if (v.problems.length === 0) {
      el.className = 'card good';
      el.replaceChildren();
      const b = document.createElement('b');
      b.textContent = `${v.checked} 条全部读得通`;
      el.append(b, document.createTextNode(
        '索引里的每一条都能按偏移量从段文件里取出来并解压。这份档案是自洽的。',
      ));
    } else {
      el.className = 'card err';
      el.textContent =
        `${v.problems.length} / ${v.checked} 条读不出来：` +
        v.problems.slice(0, 5).map((p) => `${p.captureId}（${p.error}）`).join('；');
    }
  } catch (e) {
    el.className = 'card err';
    el.textContent = `验证失败：${e.message}`;
  }
});

// ── 日志 ────────────────────────────────────────────────────

const logLines = [];
/** @param {string} text */
function addLog(text) {
  logLines.unshift(`${new Date().toLocaleTimeString()}  ${text}`);
  if (logLines.length > 500) logLines.pop();
  const el = $('log');
  el.replaceChildren();
  for (const l of logLines) {
    const d = document.createElement('div');
    d.textContent = l;
    el.append(d);
  }
}

chrome.runtime.onMessage?.addListener((msg) => {
  if (msg?.type === 'crawl_event') addLog(`${msg.event.type} ${msg.event.routeKey ?? msg.event.reason ?? ''}`);
});

refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 2000);
