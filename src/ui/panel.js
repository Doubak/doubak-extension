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
import { SCENARIOS } from '../crawl/dry-run.js';
import { WorkerFileStore } from '../storage/worker-file-store.js';
import { exportBundle, directorySink } from '../bundle/exporter.js';
import { bundleDirName, bundleIdFromDirName } from '../core/ids.js';

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
  if (btn.dataset.tab === 'debug') loadDebug();
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

/** 当前正在看的档案。 */
let currentBundleId = null;

/**
 * 读 OPFS 的专用 Worker。
 *
 * 窗口里读不了 OPFS——`createSyncAccessHandle()` 只在 Worker 里可用。而选
 * 目录、往用户盘上写又只有窗口能做。两边的限制恰好互斥，所以档案页必然是
 * 跨这条边界的：Worker 读、窗口写，中间按块传。
 *
 * @type {Worker | null}
 */
let opfsWorker = null;
function getOpfsWorker() {
  if (!opfsWorker) {
    opfsWorker = new Worker(chrome.runtime.getURL('src/storage/opfs-worker.js'), {
      type: 'module',
    });
  }
  return opfsWorker;
}

async function loadArchive() {
  // 抓取跑完之后 checkpoint 与指针都不再指向那份档案——所以不能只看状态，
  // 得直接去 OPFS 里数目录。否则「跑完了」恰好等于「再也导不出来」。
  let dirs = [];
  try {
    dirs = await WorkerFileStore.listBundleDirs(getOpfsWorker());
  } catch (e) {
    $('archive-summary').className = 'card err';
    $('archive-summary').textContent = `读不出存储：${e.message}`;
    return;
  }

  const active = lastStatus?.runner?.bundleId ?? lastStatus?.checkpoint?.bundle_id ?? null;
  const ids = dirs.map(bundleIdFromDirName).filter(Boolean);

  renderBundlePicker(ids, active);
  if (ids.length === 0) {
    currentBundleId = null;
    $('archive-summary').className = 'muted';
    $('archive-summary').textContent = '还没有档案。开始一次抓取之后这里会显示内容。';
    setArchiveButtons(false);
    $('captures').className = 'muted';
    $('captures').textContent = '选一个档案后显示';
    return;
  }

  await openBundle(currentBundleId && ids.includes(currentBundleId)
    ? currentBundleId
    : (active ?? ids[0]));
}

/** @param {string[]} ids @param {string | null} active */
function renderBundlePicker(ids, active) {
  const el = $('bundle-pick');
  el.replaceChildren();
  if (ids.length <= 1) return;

  const label = document.createElement('span');
  label.className = 'muted';
  label.style.marginRight = '8px';
  label.textContent = '档案';
  const sel = document.createElement('select');
  sel.style.font = 'inherit';
  for (const id of ids) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = id === active ? `${id}（进行中）` : id;
    o.selected = id === (currentBundleId ?? active ?? ids[0]);
    sel.append(o);
  }
  sel.onchange = () => openBundle(sel.value);
  el.append(label, sel);
}

/** @param {boolean} on */
function setArchiveButtons(on) {
  $('export').disabled = !on;
  $('verify').disabled = !on;
}

/** @param {string} bundleId */
async function openBundle(bundleId) {
  currentBundleId = bundleId;
  const summaryEl = $('archive-summary');
  $('export-result').replaceChildren();
  $('verify-result').replaceChildren();

  try {
    const store = new WorkerFileStore({ worker: getOpfsWorker(), dir: bundleDirName(bundleId) });
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
          ['捕获条数', String(s.captures)],
          ['体积', bytes(s.totalBytes)],
          ['判定分布', Object.entries(s.byVerdict).map(([k, v]) => `${VERDICT_NAMES[k] ?? k} ${v}`).join(' · ')],
        ],
      ),
    );
    setArchiveButtons(true);
    renderCoverage(s.coverage, s.crawlState);
    renderCaptures();
  } catch (e) {
    summaryEl.className = 'card err';
    summaryEl.textContent = `读不出这个档案：${e.message}`;
    // 读不出摘要不代表导不出去——字节还在，照样该让用户把它搬走。
    setArchiveButtons(true);
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

// ── 导出 ────────────────────────────────────────────────────

$('export').addEventListener('click', async () => {
  const el = $('export-result');
  const bundleId = currentBundleId;
  if (!bundleId) return;

  if (typeof window.showDirectoryPicker !== 'function') {
    el.className = 'card err';
    el.textContent = '这个浏览器不支持选择文件夹（File System Access API）。请用 Chrome 或 Edge。';
    return;
  }

  /** @type {FileSystemDirectoryHandle} */
  let dir;
  try {
    dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'doubak-export' });
  } catch {
    return; // 用户取消了，什么都不用说
  }

  const store = new WorkerFileStore({ worker: getOpfsWorker(), dir: bundleDirName(bundleId) });
  const sink = directorySink(dir);
  const run = (overwrite) => exportBundle({
    store, sink, overwrite,
    onProgress: (p) => {
      el.className = 'card run';
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
      // 这里的百分比是**字节数**，不是「抓了多少」——分母是本地文件的真实
      // 大小，可信；豆瓣的计数不可信，两者不是一回事。
      el.textContent =
        `${p.phase === 'copy' ? '正在复制' : '正在校验'} ${p.file}` +
        `（${p.fileIndex + 1}/${p.files}）${pct}%`;
    },
  });

  try {
    let r;
    try {
      r = await run(false);
    } catch (e) {
      if (e.code !== 'destination_not_empty') throw e;
      // 覆盖是不可撤销的，必须用户点头。文件选择器里随手点中的可能是文档目录。
      if (!confirm(`${e.message}\n\n继续会覆盖同名文件，且没有回收站。确定吗？`)) {
        el.className = 'card idle';
        el.textContent = '已取消，什么都没写。';
        return;
      }
      r = await run(true);
    }
    showExportResult(r);
  } catch (e) {
    el.className = 'card err';
    el.textContent = `导出失败：${e.message}`;
  }
});

/** @param {object} r */
function showExportResult(r) {
  const el = $('export-result');
  el.replaceChildren();
  const b = document.createElement('b');

  if (r.problems.length) {
    el.className = 'card err';
    b.textContent = `导出有问题：${r.problems.length} 个文件没对上`;
    el.append(b, document.createTextNode(
      r.problems.map((p) => `${p.name}（${p.reason}）`).join('；') +
      '。这一份别拿来当备份——原档案还在扩展里，请换个位置重导。',
    ));
    return;
  }

  el.className = 'card good';
  if (r.verified) {
    // 只有这一句能说「已校验」：回读了目的地、逐个对上了 manifest 里的摘要。
    b.textContent = `已导出并校验：${r.files.length} 个文件，${bytes(r.bytes)}`;
    el.append(b, document.createTextNode(
      '每个文件都从你选的文件夹里重新读了一遍，字节数与 manifest 里声明的 SHA-256 全部一致。' +
      '现在可以安全地删掉扩展里那一份了。',
    ));
  } else {
    // 只验了字节数就别说「已校验」——那正是这个项目一直在躲的假安心。
    b.textContent = `已导出：${r.files.length} 个文件，${bytes(r.bytes)}（只验了字节数）`;
    el.append(b, document.createTextNode(
      '这次抓取还没收尾，没有 manifest，所以只核对了每个文件的字节数，没有摘要可对。' +
      '抓取完成后重导一次才能做完整校验。',
    ));
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


// ── 调试 ────────────────────────────────────────────────────

let debugLoaded = false;

/**
 * 一行「标题 + 说明 + 按钮」。
 *
 * @param {string} label @param {string} why @param {() => void} onClick
 */
function actionRow(label, why, onClick) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:12px;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--line)';
  const b = document.createElement('button');
  b.className = 'act';
  b.textContent = label;
  b.style.flex = '0 0 auto';
  b.onclick = onClick;
  const note = document.createElement('span');
  note.className = 'muted';
  note.style.fontSize = '12px';
  note.textContent = why;
  row.append(b, note);
  return row;
}

async function loadDebug() {
  if (debugLoaded) return;
  debugLoaded = true;

  // 演练剧本：每一个都对准一条**必须走对**的路径。
  const el = $('scenarios');
  el.replaceChildren();
  for (const [key, s] of Object.entries(SCENARIOS)) {
    el.append(actionRow(s.title, s.expect, () => runDryRun(key)));
  }

  // 小范围试跑
  const sc = $('scoped');
  sc.replaceChildren();
  const opts = [
    ['最近 7 天的广播', { days: 7 },
      '到达下界后干净终止 → 水位线推进。这也是每次增量抓取的正常形态'],
    ['最近 30 天的广播', { days: 30 }, '同上，范围大一点'],
    ['舞台剧 · 看过（整条路线）', { routes: ['interest.drama.collect'] },
      '天然就很小的一条路线，能完整走完整个生命周期而不必截断'],
    ['最多 10 条（安全阀）', { maxCaptures: 10 },
      '人为截断 → 不算完成，水位线不推进，产出的是不完整的档案'],
  ];
  for (const [label, cfg, why] of opts) sc.append(actionRow(label, why, () => startScoped(cfg)));

  // 环境自检
  const env = $('env');
  const rows = [
    ['OPFS', navigator.storage?.getDirectory ? '可用' : '不可用（致命）'],
    ['CompressionStream', typeof CompressionStream === 'function' ? '可用' : '不可用（致命）'],
    ['File System Access', typeof window.showDirectoryPicker === 'function' ? '可用' : '不可用（导不出档案）'],
  ];
  if (navigator.storage?.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    rows.push(['存储', `已用 ${bytes(usage ?? 0)} / 配额 ${bytes(quota ?? 0)}`]);
  }
  // 不显示 persist()：它在扩展里恒为 false，是预期行为而不是风险信号，
  // 保护来自 unlimitedStorage 权限。摆出来只会制造假的不确定性。
  env.replaceChildren(table(['项', '值'], rows));
}

/** @param {string} key */
async function runDryRun(key) {
  const el = $('dryrun-result');
  el.className = 'card idle';
  el.textContent = `正在演练「${SCENARIOS[key].title}」…（不发出任何网络请求）`;

  const r = await send({ type: 'dryRun', scenario: key });
  if (!r?.ok) {
    el.className = 'card err';
    el.textContent = `演练失败：${r?.error ?? ''}`;
    return;
  }

  const d = r.result;
  el.className = 'card good';
  el.replaceChildren();
  const b = document.createElement('b');
  b.textContent = `演练完成：${SCENARIOS[key].title}`;
  el.append(b);
  el.append(
    table(
      ['项', '结果'],
      [
        ['写入档案', `${d.captured} 条`],
        ['失败', String(d.failed)],
        ['停机原因', d.stoppedBy ?? '（没有，走到终点）'],
        ['判定分布',
          Object.entries(d.byVerdict ?? {})
            .map(([k, v]) => `${VERDICT_NAMES[k] ?? (k === 'unclassified' ? '判不出来' : k)} ${v}`)
            .join(' · ') || '—'],
        ['水位线是否推进', d.advanced === null ? '—' : d.advanced ? '是' : '否'],
      ],
    ),
  );
  const why = document.createElement('div');
  why.className = 'muted';
  why.style.fontSize = '12px';
  why.textContent = `预期：${SCENARIOS[key].expect}`;
  el.append(why);
}

/** @param {object} cfg */
async function startScoped(cfg) {
  const r = await send({ type: 'start', scope: cfg });
  if (!r?.ok) {
    alert(`无法开始：${r?.error ?? ''}`);
    return;
  }
  // 跳回概览——试跑跟真实抓取一样，要在同一个地方观察。
  for (const b of $('tabs').querySelectorAll('button')) {
    const on = b.dataset.tab === 'overview';
    b.setAttribute('aria-selected', String(on));
    $(`tab-${b.dataset.tab}`).hidden = !on;
  }
  refresh();
}

$('selftest').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('selftest/index.html') });
});
