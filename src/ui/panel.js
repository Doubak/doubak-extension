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
import { summarizeBundles, checkDeletable, totalBytes, hasUnexported } from '../storage/storage-usage.js';
import { captureTitle, captureSubtitle } from './capture-label.js';
import { shouldLog, formatEntry, formatLogText } from '../crawl/event-log.js';
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

/** 档案状态。界面上不出现 `in_progress` 这种内部标识。 */
const STATUS_NAMES = {
  complete: '已完成',
  in_progress: '进行中（还没收尾）',
  aborted: '中途停下',
};

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
  // 覆盖率原来**没有自己的加载**——它只是 `openBundle()` 的副作用，所以第一次直接点
  // 进来是空白的（要先去过档案页才有东西）。空白看起来像「正在加载」，而它其实什么
  // 都不会发生。
  if (btn.dataset.tab === 'coverage') loadCoverage();
  if (btn.dataset.tab === 'log') loadLog();
});

// ── 概览 ────────────────────────────────────────────────────

const PAUSE_COPY = {
  challenge: ['warn', '豆瓣要求验证', '请在新标签页里完成验证，完成后回来点继续。插件和你共用登录状态。', '我验证好了，继续'],
  blocked: ['warn', '豆瓣暂时限制了访问', '已经停下来了，不会自动重试——继续请求可能导致账号被限制。建议等待 30 分钟以上。', '现在试试'],
  session_expired: ['warn', '登录状态已失效', '这不是错误，抓取已安全停下，进度都在。请重新登录豆瓣后继续。', '我登录好了，继续'],
  account_switched: ['err', '账号变了', '一个档案只能属于一个账号。请切回原来的账号，或另开一次抓取。', null],
  quota: ['err', '存储空间不足', '需要先导出或清理再继续。已经抓到的都还在。', null],
  host_permission_lost: [
    'err',
    '豆备没有访问豆瓣的权限了',
    '这不是错误，抓取已安全停下，进度都在。请在浏览器的扩展设置里把站点访问权限改回「在所有网站上」。',
    '我改好了，继续',
  ],
  failures_pending: [
    'warn',
    '有几个页面抓不下来',
    '其余部分都抓完了。下面列出是哪几页——可以重试，也可以确认「就这样收尾」。',
    null, // 动作在下面的失败清单里，不用这里的通用按钮
  ],
  write_failed: [
    'err',
    '写入档案时出错',
    '已经停下来了，以免损坏已有数据。继续之前会先自动修复段文件尾部。',
    '我知道了，继续',
  ],
  user_paused: ['idle', '已暂停', '进度都在，随时可以继续。', '继续'],
  crash: ['run', '正在从断点恢复', '上次被意外中断，没有数据丢失。', null],
};

/**
 * 状态卡片。**内容没变就一个字节都不动 DOM**——它每 2 秒被调一次。
 *
 * @param {string} cls @param {string} title @param {string} [why]
 */
function setState(cls, title, why = '') {
  const el = $('state');
  const key = `${cls}\u0000${title}\u0000${why}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;

  el.className = `card ${cls}`;
  el.replaceChildren();
  const b = document.createElement('b');
  b.textContent = title;
  el.append(b);
  if (why) el.append(document.createTextNode(why));
}

/**
 * 操作按钮。标签没变就不重建——重建会打断按下态，也会让焦点丢掉。
 *
 * @param {Array<[string, () => void]>} buttons
 */
function setActions(buttons) {
  const el = $('actions');
  const key = buttons.map(([l]) => l).join('\u0000');
  if (el.dataset.key === key) {
    // 标签一样，但回调可能捕获了新的状态，所以只换 onclick。
    const bs = el.querySelectorAll('button');
    buttons.forEach(([, fn], i) => { if (bs[i]) bs[i].onclick = fn; });
    return;
  }
  el.dataset.key = key;
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

  if (s.runner?.active || s.checkpoint) {
    // 离开空闲态：把预检结果收掉，下次回到空闲再查一次（那时空间已经变了）。
    if (preflightShown) {
      preflightShown = false;
      $('preflight').replaceChildren();
    }
    // 上一次的结果也让位给正在进行的这一次
    lastRunShown = false;
  }

  if (s.runner?.active) {
    const r = s.runner;

    // `active` 是「这次抓取还在内存里」，**不是**「正在发请求」。停下来之后仍然
    // active（那样才能继续），所以必须分开显示——否则暂停之后界面还写着
    // 「正在抓取」，用户会以为按钮没生效然后反复去点。
    if (r.stopped) {
      const [cls, title, why, action] = PAUSE_COPY[r.stoppedBy] ??
        ['warn', '抓取已停下', `原因：${r.stoppedBy}`, '继续'];
      setState(cls, title, why);
      setActions(action ? [[action, async () => { await send({ type: 'resume' }); refresh(); }]] : []);
      renderFailures(r.failures ?? []);
      renderRoutes(r.routes ?? []);
      return;
    }

    setState('run', '正在抓取', `档案 ${r.bundleId} · 当前间隔 ${(r.intervalMs / 1000).toFixed(1)} 秒` +
      (r.backoffLevel ? `（已降速 ${r.backoffLevel} 级）` : ''));
    renderFailures(r.failures ?? []);
    setActions([['暂停', async () => {
      // 立刻给反馈。一批最长 22 秒，期间不给任何回应的话按钮看起来就是坏的。
      setState('idle', '正在暂停…', '当前这一页抓完就停，不会丢东西。');
      await send({ type: 'pause' });
      refresh();
    }]]);
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

  renderFailures([]);
  setState('idle', '没有进行中的抓取', '请求全部来自你自己的浏览器和 IP。cookie 不会发送到任何地方。');
  // **不清空进度表。** 抓完之后立刻变回「还没有开始」，等于把刚跑完那一次的结果扔了
  // ——而那正是用户此刻最想看的东西。改成显示上一份档案的 crawl_state：那是
  // **权威记录**（写在 manifest 里），比内存里的快照更可信。
  if (!lastRunShown) {
    lastRunShown = true;
    void showLastRun();
  }
  // 只在**进入**空闲态时查一次。权限和剩余空间不会每两秒变一次，而每两秒重画
  // 一次这块，就是用户看到的那种闪动。
  if (!preflightShown) {
    preflightShown = true;
    void showPreflight();
  }
  setActions([['开始抓取', async () => {
    setState('run', '正在确认账号…');
    const r = await send({ type: 'start' });
    if (!r?.ok) setState('err', '无法开始', r?.error ?? '');
    refresh();
  }]]);
  renderRoutes([]);
}

/**
 * 各路线进度。
 *
 * ## 为什么不能每次都重建整张表
 *
 * 这个函数每 2 秒被调一次。`replaceChildren()` 会把所有 `<tr>` 扔掉重建，于是
 * 每两秒：文字选中被清掉、滚动位置可能跳、浏览器重排整张表——看上去就是在
 * 「闪」。而实际变化通常只有一两个数字。
 *
 * 所以按 routeKey 复用行，只写**值真的变了**的那个单元格。连
 * `textContent` 都不无谓赋值：赋一次相同的值也会让浏览器认为节点脏了。
 *
 * 这不只是观感问题。一个持续几小时的界面上，闪动会让人不敢去读它，而这一页
 * 恰恰是抓取期间唯一的观察窗口。
 *
 * @param {Array<object>} routes
 */
function renderRoutes(routes) {
  const el = $('routes');

  if (!routes.length) {
    // 空态与表格是两种结构，这时才需要真的重建。
    if (el.dataset.mode !== 'empty') {
      el.dataset.mode = 'empty';
      el.className = 'muted';
      el.replaceChildren(document.createTextNode('还没有开始'));
      routeRows.clear();
    }
    return;
  }

  if (el.dataset.mode !== 'table') {
    el.dataset.mode = 'table';
    el.className = '';
    const tbl = document.createElement('table');
    tbl.id = 'routes-table';
    const head = document.createElement('tr');
    for (const h of ['路线', '已抓', '已回溯到', '连续性']) {
      const th = document.createElement('th');
      th.textContent = h;
      if (h === '已抓') th.className = 'num';
      head.append(th);
    }
    tbl.append(head);
    el.replaceChildren(tbl);
    routeRows.clear();
  }

  const tbl = el.querySelector('table');
  const seen = new Set();

  for (const r of routes) {
    seen.add(r.routeKey);
    let row = routeRows.get(r.routeKey);
    if (!row) {
      const tr = document.createElement('tr');
      const cells = [];
      for (let i = 0; i < 4; i++) {
        const td = document.createElement('td');
        if (i === 1) td.className = 'num';
        tr.append(td);
        cells.push(td);
      }
      cells[0].textContent = routeName(r.routeKey); // 名字不会变，只写一次
      tbl.append(tr);
      row = { tr, cells };
      routeRows.set(r.routeKey, row);
    }

    setCell(row.cells[1], String(r.captured));
    // 进度用「已回溯到某日」而不是百分比——豆瓣的计数不可信，拿它当分母会给出
    // 一个看起来特别可信的假数字。
    //
    // 用 `oldestSeen`（本次最旧的一条）。原来用的是水位线（最新的一条），而列表
    // 是新→旧，那个值在第一页就定住了——抓了十页日期一动不动，看起来像卡住了。
    setCell(row.cells[2], r.oldestSeen ? r.oldestSeen.slice(0, 10) : '—', !r.oldestSeen);
    setCell(row.cells[3], r.contiguous ? '✔ 已验证' : '进行中', !r.contiguous);
  }

  // 路线只会新增不会消失，但恢复到另一次抓取时整套 key 会换。
  for (const [key, row] of routeRows) {
    if (!seen.has(key)) {
      row.tr.remove();
      routeRows.delete(key);
    }
  }
}

/** @type {Map<string, {tr: HTMLElement, cells: HTMLElement[]}>} */
const routeRows = new Map();

/**
 * 只在值真的变了时写 DOM。
 *
 * 赋一次相同的 textContent 也会让浏览器认为节点脏了，所以这个判断不是
 * 微优化——它就是「不闪」的实现方式。
 *
 * @param {HTMLElement} td @param {string} text @param {boolean} [muted]
 */
function setCell(td, text, muted = false) {
  if (td.textContent !== text) td.textContent = text;
  const cls = muted ? 'muted' : '';
  const want = td.classList.contains('num') ? `num ${cls}`.trim() : cls;
  if (td.className !== want) td.className = want;
}

/**
 * 只在**进入**空闲态时查一次，不是每 2 秒查一次。
 *
 * 权限和剩余空间不会每两秒变一次，而每两秒重画一块就是用户看到的那种闪动。
 */
let preflightShown = false;
let lastRunShown = false;

/**
 * 空闲时显示**上一次**抓取的结果。
 *
 * 数据取自最新那份档案的 `manifest.crawl_state` + `coverage`——那是权威记录，
 * 而不是内存里的快照。抓完之后 runner 就清空了，只看内存的话进度表会立刻变回
 * 「还没有开始」，把刚跑完的结果扔掉。
 */
async function showLastRun() {
  try {
    const dirs = await WorkerFileStore.listBundleDirs(getOpfsWorker());
    const id = dirs.map(bundleIdFromDirName).find(Boolean);
    if (!id) return;

    const store = new WorkerFileStore({ worker: getOpfsWorker(), dir: bundleDirName(id) });
    const reader = new BundleReader({ store, bundleId: id });
    const s = await reader.summary();
    if (!s.hasManifest) return; // 没收尾的没有 crawl_state

    const byRoute = new Map((s.coverage ?? []).map((c) => [c.route_key, c]));
    const rows = (s.crawlState ?? []).map((cs) => ({
      routeKey: cs.route_key,
      captured: byRoute.get(cs.route_key)?.captured_count ?? 0,
      // 「已回溯到」用最旧那一端。规范 §5.4.1.1 之前只存了上界，所以旧档案这里是 null。
      oldestSeen: cs.low_water_time ?? null,
      newestSeen: cs.high_water_time ?? null,
      contiguous: cs.contiguous,
    }));
    if (rows.length === 0) return;

    renderRoutes(rows);
    const note = document.createElement('div');
    note.className = 'muted';
    note.style.fontSize = '12px';
    note.textContent = `以上是上一次抓取（档案 ${id}）的结果，来自它的 manifest。`;
    $('routes').append(note);
  } catch {
    // 读不出来就维持「还没有开始」。这只是个便利显示，不该让概览页报错。
  }
}

/**
 * 开抓前的预检：权限够不够、空间够不够。
 *
 * 空间要按**含目录页**的体量估。只按列表页估会给出一个乐观得离谱的数字，然后
 * 用户在抓了几小时之后撞墙——预检的全部意义就是把那次撞墙提前到开工前。
 *
 * 两项都可能返回 null，那是「查不了」而不是「没问题」，界面照实说。
 */
async function showPreflight() {
  const el = $('preflight');
  const r = await send({ type: 'preflight' });
  if (!r?.ok) return;

  /** @type {Array<[string, string]>} */
  const rows = [];
  if (r.permissions === null) rows.push(['站点权限', '查不了（浏览器不支持权限查询）']);
  else if (r.permissions.granted) rows.push(['站点权限', '✔ 可以访问豆瓣']);
  else rows.push(['站点权限', `✗ 缺少 ${r.permissions.missing.join('、')}`]);

  if (r.storage === null) rows.push(['存储空间', '查不了（浏览器不肯说配额）']);
  else if (r.storage.enough) {
    rows.push(['存储空间', `✔ 可用 ${bytes(r.storage.available)}（预计需要约 ${bytes(r.storage.need)}）`]);
  } else {
    rows.push(['存储空间', `✗ 只剩 ${bytes(r.storage.available)}，预计需要约 ${bytes(r.storage.need)}`]);
  }

  // **说清这次是全量还是增量。** 用户问过一次「这是增量吗」——那说明界面上看不出来，
  // 而这件事影响的是他要等多久、以及会不会重复抓已经有的东西。
  //
  // 现在的答案是：**永远是全量**。水位线机制齐全（每次抓取都会算出来并写进 manifest），
  // 但没有任何代码把上一份档案的水位线读回来当下界。不说的话，用户很容易以为
  // 「跑过一次了，下次会快」。
  rows.push([
    '这次抓取的范围',
    '全量（从最新一直抓到最早）—— 增量还没接上，所以已经抓过的会再抓一遍',
  ]);

  el.className = '';
  el.replaceChildren(table(['开抓前检查', '结果'], rows));

  const bad = (r.permissions && !r.permissions.granted) || (r.storage && !r.storage.enough);
  if (!bad) return;

  const warn = document.createElement('div');
  warn.className = 'card warn';
  const b = document.createElement('b');
  b.textContent = '现在开始可能会中途停下';
  warn.append(b, document.createTextNode(
    r.permissions && !r.permissions.granted
      ? '请在浏览器的扩展设置里把站点访问权限改回「在所有网站上」。'
      : '空间可能不够。已经抓到的不会丢，但抓到一半停下来还得再来一次——建议先清理或导出。',
  ));
  el.append(warn);
}

/**
 * 抓不下来的条目。
 *
 * ## 为什么这块必须存在
 *
 * 失败原来是**看不见**的：它不调用 `frontier.stop()`，所以状态里没有停机原因；
 * 而「没有可跑的了」曾被上层当成干净跑完，于是档案被静默标成 `complete`，
 * manifest 里一点痕迹都没有。
 *
 * 现在跑不动了就停在这儿等人，而这块就是那个「等人」的界面。
 *
 * ## 两种失败的处置权不同
 *
 * | | 能不能「就这样收尾」 | 为什么 |
 * |---|---|---|
 * | 分页条目（广播第 7 页、看过第 3 页） | **不能** | 跳过它就再也不能声称「这条线以上全都抓到了」，而水位线正建立在那句话上 |
 * | 叶子条目（某一个作品详情页） | **能** | 条目之间没有先后关系，一个电影页与另外 1332 个无关 |
 *
 * 「就这样收尾」会把每一处缺口如实写进 manifest，且该路线 `advanced=false`
 * （规范 bundle/v1 §5.0 明确允许这种组合）。
 *
 * @param {Array<object>} failures
 */
function renderFailures(failures) {
  const el = $('failures');
  if (!failures?.length) {
    if (el.dataset.mode !== 'empty') {
      el.dataset.mode = 'empty';
      el.replaceChildren();
    }
    return;
  }
  el.dataset.mode = 'list';
  el.replaceChildren();

  const ordered = failures.filter((f) => f.ordered);
  const leaves = failures.filter((f) => !f.ordered);

  const card = document.createElement('div');
  card.className = 'card warn';
  const b = document.createElement('b');
  b.textContent = `${failures.length} 个页面抓不下来`;
  card.append(b);
  card.append(document.createTextNode(
    ordered.length
      ? `其中 ${ordered.length} 个是分页条目——跳过它们就再也不能声称「这条线以上全都` +
        '抓到了」，所以只能重试，不能就这样收尾。'
      : '都是单个作品页，条目之间互不相干。可以重试，也可以确认就这样收尾。',
  ));
  el.append(card);

  el.append(table(
    ['页面', '路线', { text: '试过', num: true }, '错误'],
    failures.slice(0, 30).map((f) => [
      { text: f.url.replace(/^https?:\/\//, ''), muted: false },
      routeName(f.routeKey) + (f.ordered ? '（分页）' : ''),
      { text: String(f.attempts), num: true },
      { text: f.lastError ?? '—', muted: true },
    ]),
  ));
  if (failures.length > 30) {
    const more = document.createElement('div');
    more.className = 'muted';
    more.textContent = `另有 ${failures.length - 30} 个未列出`;
    el.append(more);
  }

  const acts = document.createElement('div');
  const retry = document.createElement('button');
  retry.className = 'act';
  retry.textContent = `重试这 ${failures.length} 个`;
  retry.onclick = async () => {
    retry.disabled = true;
    retry.textContent = '正在重试…';
    const r = await send({ type: 'retryFailed' });
    if (!r?.ok) alert(`重试失败：${r?.error ?? ''}`);
    refresh();
  };
  acts.append(retry);

  // **只有全是叶子失败时才给这个按钮。** 有分页失败还放开它，等于让用户点一下就
  // 免掉水位线赖以成立的前提——那不是他能授权的事。
  if (!ordered.length) {
    const accept = document.createElement('button');
    accept.className = 'act';
    accept.textContent = '就这样收尾';
    accept.onclick = async () => {
      const lines = [
        `确认收尾？${leaves.length} 个页面会作为已知缺口记进档案。`,
        '',
        ...leaves.slice(0, 8).map((f) => `· ${f.url}`),
        leaves.length > 8 ? `…另有 ${leaves.length - 8} 个` : '',
        '',
        '档案会标成「已完成」，但每一处缺口都会如实写进 manifest，',
        '受影响路线的水位线不会推进——下次抓取仍会从旧下界重走。',
      ].filter(Boolean);
      if (!confirm(lines.join('\n'))) return;
      accept.disabled = true;
      const r = await send({ type: 'finishWithGaps' });
      if (!r?.ok) alert(`收尾失败：${r?.error ?? ''}`);
      refresh();
    };
    acts.append(accept);
  }
  el.append(acts);
}

// ── 覆盖率 ──────────────────────────────────────────────────

/**
 * 覆盖率页自己去读档案。
 *
 * 读 OPFS 要经过 Worker，是异步的——所以必须先说「正在读取」。空白会被当成加载中，
 * 而空白其实意味着什么都不会发生。
 */
async function loadCoverage() {
  const el = $('coverage');
  el.className = 'muted';
  el.textContent = '正在读取档案…';

  try {
    const dirs = await WorkerFileStore.listBundleDirs(getOpfsWorker());
    const id = currentBundleId ?? dirs.map(bundleIdFromDirName).find(Boolean);
    if (!id) {
      el.className = 'muted';
      el.textContent = '还没有档案。开始一次抓取之后这里会显示对账结果。';
      return;
    }
    const store = new WorkerFileStore({ worker: getOpfsWorker(), dir: bundleDirName(id) });
    const s = await new BundleReader({ store, bundleId: id }).summary();
    if (!s.hasManifest) {
      el.className = 'muted';
      el.textContent = '这次抓取还没收尾——覆盖率证据是收尾时才攒的，现在还没有。';
      return;
    }
    renderCoverage(s.coverage, s.crawlState);
  } catch (e) {
    el.className = 'card err';
    el.textContent = `读不出来：${e.message}`;
  }
}

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
      `有 ${cs.gaps.length} 处缺口。` +
      (cs.gaps.some((x) => x.reason === 'no_items_observed')
        ? '其中有一处是「页面声称有条目，但一个都没抽到」——那通常意味着豆瓣改版了，' +
          '抓取的终止判断因此失效。这一页已经如实存进档案，可据此重新校准。'
        : `原因：${cs.gaps.map((x) => x.reason).join('、')}。` +
          '这段区间的内容可能不完整，下次抓取会从上次的下界重走。'),
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
          ['账号', s.account
            ? `${s.account.username ?? ''}（${s.account.user_id ?? ''}）`
            : { text: '要等收尾时写进 manifest', muted: true }],
          ['状态', STATUS_NAMES[s.status] ?? s.status],
          ['捕获条数', String(s.captures)],
          // 没有 manifest 时体积是从 index 累加的下界（段文件里还有 gzip 头尾），
          // 说清楚它是估的——否则界面只能猜着说。
          ['体积', s.totalBytesExact ? bytes(s.totalBytes) : `约 ${bytes(s.totalBytes)}（不含压缩头尾）`],
          ['判定分布', Object.entries(s.byVerdict).map(([k, v]) => `${VERDICT_NAMES[k] ?? k} ${v}`).join(' · ') || '—'],
        ],
      ),
    );

    // 进行中的档案要主动解释一句。**「还没收尾」不是「坏了」**——它没有
    // manifest，所以校验只能验字节数、覆盖率证据也还没攒。不说清楚的话，用户看到
    // 一堆空字段会以为几小时的抓取白费了。
    if (!s.hasManifest) {
      const note = document.createElement('div');
      note.className = 'card idle';
      const b = document.createElement('b');
      b.textContent = '这次抓取还没收尾';
      note.append(b, document.createTextNode(
        'manifest.json 是收尾时写的，所以账号、体积、覆盖率证据现在还没有——' +
        '这不表示档案坏了。已经抓到的每一页都已落盘，现在导出也导得出来，' +
        '只是校验只能核对字节数（没有摘要可对）。抓完之后重看这一页就完整了。',
      ));
      summaryEl.append(note);
    }
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

/**
 * 捕获列表。
 *
 * ## 为什么每行要说这么多
 *
 * 原来一行只有路线名与判定，于是列表长成一串「广播 正常 / 广播 正常 / 广播 正常」
 * ——除了顺序之外什么信息都没有，而档案页存在的意义恰恰是**在档案里找东西**。
 *
 * 现在每行给四样，都是不解压任何记录就能拿到的（全在 index 里）：
 *
 * | | 从哪来 | 回答什么 |
 * |---|---|---|
 * | 路线 · 第几页 | `route_key` / `cursor` | 这是哪条线的第几页 |
 * | 条目数 | `item_count` | 这一页有多少条（0 是终点的正常形态） |
 * | 时间区间 | `item_time_range` | **这一页是哪段时间** ← 找东西时的第一个问题 |
 * | 判定 · 体积 | `verdict` / `length` | 正常吗、多大 |
 *
 * 时间区间是这次专门为此加进规范的可选字段（bundle/v1 §6.1.2）：抓取时本来就算过，
 * 扔掉之后再想知道就得把记录取出来解压、再跑一遍选择器——而豆瓣改版之后那些选择器
 * 可能已经对不上了。
 */
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

    const main = document.createElement('div');
    main.className = 'cap-main';

    const left = document.createElement('span');
    left.textContent = captureTitle(e, routeName);
    const right = document.createElement('span');
    right.className = 'v';
    // 判定只在**不是 ok** 的时候才显示。一整列「正常」是纯噪音，而那正好淹没了
    // 真正要看见的那几行。
    right.textContent = e.verdict === 'ok'
      ? bytes(e.length ?? 0)
      : `${VERDICT_NAMES[e.verdict] ?? e.verdict} · ${bytes(e.length ?? 0)}`;
    if (e.verdict !== 'ok') right.classList.add('warn-text');
    main.append(left, right);

    const sub = document.createElement('div');
    sub.className = 'cap-sub';
    sub.textContent = captureSubtitle(e);

    row.append(main, sub);
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
    // 记一笔「导出过了」。派生状态，丢了不影响档案本身——只影响删除确认框说得多重。
    // 只在**校验通过**时记：没验过就说「已导出」，等于给了一个我们没资格给的保证。
    if (r.problems.length === 0) {
      await send({ type: 'markExported', bundleId, at: new Date().toISOString() });
    }
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

/**
 * 日志页。
 *
 * 事件由 offscreen 落进 IndexedDB（见 crawl/event-log.js），这里只负责读与显示。
 * 原来是个内存数组，只记面板打开期间的事件、一刷新就没——而界面上却写着「仅本地保留…
 * 导出前请自行脱敏」，同时暗示了「存下来了」和「有导出」，两个都不存在。
 */
let logRows = [];

async function loadLog() {
  const el = $('log');
  el.className = 'muted';
  el.textContent = '正在读取…';

  const r = await send({ type: 'readLog' });
  logRows = r?.ok ? r.rows : [];
  renderLog();
}

function renderLog() {
  const el = $('log');
  el.className = '';
  el.replaceChildren();

  if (logRows.length === 0) {
    el.className = 'muted';
    el.textContent = '还没有事件。这里只记重试、停机、错误这类——正常抓完的页面在档案的 index 里。';
  } else {
    for (const r of logRows) {
      const d = document.createElement('div');
      const bits = [r.at?.slice(0, 19).replace('T', ' '), r.type, r.routeKey, r.reason, r.url, r.message];
      d.textContent = bits.filter(Boolean).join('  ·  ');
      el.append(d);
    }
  }

  const acts = $('log-actions');
  acts.replaceChildren();

  const copy = document.createElement('button');
  copy.className = 'act';
  copy.textContent = '复制日志';
  copy.disabled = logRows.length === 0;
  copy.onclick = async () => {
    const text = formatLogText(logRows);
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = '已复制 ✔';
      setTimeout(() => { copy.textContent = '复制日志'; }, 1500);
    } catch {
      // 剪贴板可能被策略挡住。**必须有退路**——「复制失败」而没有别的办法，
      // 等于这个功能不存在（自检页那边踩过同一个坑）。
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.rows = 16;
      ta.style.width = '100%';
      ta.style.font = '12px ui-monospace, monospace';
      acts.append(ta);
      ta.select();
    }
  };

  const clear = document.createElement('button');
  clear.className = 'act';
  clear.textContent = '清空';
  clear.disabled = logRows.length === 0;
  clear.onclick = async () => {
    if (!confirm('清空日志？诊断记录会丢掉，但不影响任何已抓到的数据。')) return;
    await send({ type: 'clearLog' });
    loadLog();
  };

  acts.append(copy, clear);
}

chrome.runtime.onMessage?.addListener((msg) => {
  if (msg?.type !== 'crawl_event') return;
  // 事件的落盘在 offscreen 那边做（那样不依赖面板开着）。这里只是让**正在看**日志页的
  // 用户即时看到，不必等下一次读取。
  if (!shouldLog(msg.event)) return;
  logRows.unshift(formatEntry(msg.event, new Date().toISOString()));
  if (logRows.length > 500) logRows.pop();
  const tab = $('tabs').querySelector('button[data-tab="log"]');
  if (tab?.getAttribute('aria-selected') === 'true') renderLog();
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
    ['作品详情页（约 12 次请求）',
      { routes: ['interest.drama.collect', 'interest.item'], maxCaptures: 12, bypassGates: true },
      '先抓一页舞台剧列表，再抓它上面的作品详情页 —— 那条路线占真实档案九成体积，' +
      '但在全量抓取里排在最后，几小时之后才轮到。这里几十次请求就能验完'],
  ];
  for (const [label, cfg, why] of opts) sc.append(actionRow(label, why, () => startScoped(cfg)));

  // 绕过门控这件事必须说出来，而不是藏在按钮说明里
  const gateNote = document.createElement('div');
  gateNote.className = 'card idle';
  const gb = document.createElement('b');
  gb.textContent = '作品详情页那一项会绕过抓取顺序';
  gateNote.append(gb, document.createTextNode(
    '正常抓取里，作品详情页要等广播抓完才开始——广播可以被静默删除，删了就再也拿不' +
    '回来；而作品详情页随时能重抓。不能拿最不可替代的东西去换最可替代的。' +
    '这一项为了几十次请求就能验完那条路线，显式跳过了这个顺序，所以它只适合调试。',
  ));
  sc.append(gateNote);

  await loadStorage();

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

// ── 存储管理 ────────────────────────────────────────────────

/** @type {import('../storage/storage-usage.js').BundleUsage[]} */
let storageUsage = [];

/**
 * 列出所有档案，标出体积与导出状态。
 *
 * 列表本身是**只读**的，所以走面板自己的只读 Worker，不必把 offscreen 拉起来。
 * 删除才需要它（那是唯一的写入路径）。
 */
async function loadStorage() {
  const el = $('storage');
  el.className = 'muted';
  el.textContent = '正在统计…';

  try {
    const worker = getOpfsWorker();
    const dirNames = await WorkerFileStore.listBundleDirs(worker);

    /** @type {Array<{bundleId: string, dir: string, files: Array<{name: string, bytes: number}>}>} */
    const dirs = [];
    for (const dir of dirNames) {
      const bundleId = bundleIdFromDirName(dir);
      if (!bundleId) continue;
      const store = new WorkerFileStore({ worker, dir });
      const names = await store.list();
      const files = [];
      for (const name of names) files.push({ name, bytes: await store.size(name) });
      dirs.push({ bundleId, dir, files });
    }

    const ids = dirs.map((d) => d.bundleId);
    const rec = await send({ type: 'exportRecords', bundleIds: ids });
    const active = lastStatus?.runner?.active ? lastStatus.runner.bundleId : null;

    storageUsage = summarizeBundles({
      dirs,
      activeBundleId: active,
      exportedAt: rec?.exportedAt ?? {},
      // 记录读不出来时不许显示成「未导出」——那是替用户下一个我们没资格下的判断。
      exportRecordsUsable: Boolean(rec?.ok),
    });

    renderStorage();
  } catch (e) {
    el.className = 'card err';
    el.textContent = `统计不出来：${e.message}`;
  }
}

const EXPORT_STATE_TEXT = {
  exported: (at) => `✔ 已导出（${at.slice(0, 16).replace('T', ' ')}）`,
  not_exported: () => '未导出 —— 这是唯一的副本',
  unknown: () => '不确定（本机没有导出记录）',
};

function renderStorage() {
  const el = $('storage');
  el.replaceChildren();

  if (storageUsage.length === 0) {
    el.className = 'muted';
    el.textContent = '存储里没有档案。';
    $('storage-actions').replaceChildren();
    return;
  }

  el.className = '';
  el.append(
    table(
      ['档案', { text: '体积', num: true }, { text: '文件', num: true }, '状态', '导出', ''],
      storageUsage.map((u) => [
        u.bundleId,
        { text: bytes(u.bytes), num: true },
        { text: String(u.files), num: true },
        u.active ? '正在抓' : (u.hasManifest ? '已完成' : '未收尾'),
        {
          text: EXPORT_STATE_TEXT[u.exportState](u.exportedAt ?? ''),
          muted: u.exportState === 'exported',
        },
        '',
      ]),
    ),
  );

  // 给每行补删除按钮
  const rows = el.querySelectorAll('tr');
  storageUsage.forEach((u, i) => {
    const cell = rows[i + 1]?.lastElementChild;
    if (!cell) return;
    const b = document.createElement('button');
    b.className = 'act';
    b.textContent = '删除';
    b.disabled = !u.deletable;
    b.title = u.blockedReason ?? '';
    b.onclick = () => deleteBundle(u.bundleId);
    cell.replaceChildren(b);
    // 灰掉的按钮看起来像 bug，所以把原因也写出来。
    if (!u.deletable && u.blockedReason) {
      const why = document.createElement('span');
      why.className = 'muted';
      why.style.fontSize = '12px';
      why.textContent = u.blockedReason;
      cell.append(why);
    }
  });

  const acts = $('storage-actions');
  acts.replaceChildren();
  const all = document.createElement('button');
  all.className = 'act';
  all.textContent = `清空全部（${storageUsage.length} 份 · ${bytes(totalBytes(storageUsage))}）`;
  all.onclick = deleteAll;
  const note = document.createElement('span');
  note.className = 'muted';
  note.style.fontSize = '12px';
  note.textContent = hasUnexported(storageUsage)
    ? '有档案没导出过 —— 清空之后不可能找回来'
    : '所有档案都导出过了';
  acts.append(all, note);
}

/** @param {string} bundleId */
async function deleteBundle(bundleId) {
  // 界面上那个确认框是给人看的，`checkDeletable` 是给代码守的。**两者都要有**——
  // 用户可能点得很快。
  const check = checkDeletable(storageUsage, bundleId);
  if (!check.ok) {
    setStorageResult('err', check.error);
    return;
  }
  const u = check.target;

  // 确认框要把**要失去的具体东西**说出来：哪一份、多大、导出过没有。
  // 一句「确定删除吗？」等于什么都没说。
  const lines = [
    `删除档案 ${u.bundleId}？`,
    `${bytes(u.bytes)} · ${u.files} 个文件 · ${u.hasManifest ? '已完成' : '未收尾'}`,
    '',
    u.exportState === 'exported'
      ? `你在 ${u.exportedAt.slice(0, 16).replace('T', ' ')} 导出过它。`
      : '⚠ 没有导出记录 —— 浏览器里这一份可能是唯一的副本。',
    '',
    '删除不可逆，没有回收站。',
  ];
  if (!confirm(lines.join('\n'))) return;

  setStorageResult('idle', `正在删除 ${u.bundleId}…`);
  const r = await send({ type: 'deleteBundle', bundleId: u.bundleId, dir: u.dir });
  if (!r?.ok) {
    setStorageResult('err', `删不掉：${r?.error ?? ''}`);
    return;
  }
  setStorageResult('good', `已删除 ${u.bundleId}（释放 ${bytes(u.bytes)}）`);
  // 档案页可能正指着刚删掉的那份
  if (currentBundleId === u.bundleId) currentBundleId = null;
  await loadStorage();
}

async function deleteAll() {
  const deletable = storageUsage.filter((u) => u.deletable);
  const blocked = storageUsage.filter((u) => !u.deletable);
  if (deletable.length === 0) {
    setStorageResult('err', '没有可删的档案' + (blocked.length ? '（正在抓的那份不能删）' : ''));
    return;
  }

  const unexported = deletable.filter((u) => u.exportState !== 'exported');
  const lines = [
    `清空 ${deletable.length} 份档案，共 ${bytes(totalBytes(deletable))}？`,
    '',
    ...deletable.map((u) => `· ${u.bundleId} ${bytes(u.bytes)}`),
    '',
  ];
  if (unexported.length) {
    lines.push(`⚠ 其中 ${unexported.length} 份没有导出记录，可能是唯一的副本。`, '');
  }
  if (blocked.length) lines.push(`（${blocked.length} 份正在抓，会保留）`, '');
  lines.push('删除不可逆，没有回收站。');
  if (!confirm(lines.join('\n'))) return;

  // 逐个删而不是一把梭：一份失败不该让其余的也不删，而且要说清哪些成了。
  const failed = [];
  for (const u of deletable) {
    setStorageResult('idle', `正在删除 ${u.bundleId}…`);
    const r = await send({ type: 'deleteBundle', bundleId: u.bundleId, dir: u.dir });
    if (!r?.ok) failed.push(`${u.bundleId}（${r?.error ?? ''}）`);
  }

  currentBundleId = null;
  if (failed.length) setStorageResult('err', `有 ${failed.length} 份删不掉：${failed.join('；')}`);
  else setStorageResult('good', `已清空 ${deletable.length} 份档案`);
  await loadStorage();
}

/** @param {string} cls @param {string} text */
function setStorageResult(cls, text) {
  const el = $('storage-result');
  el.className = `card ${cls}`;
  el.textContent = text;
}

$('selftest').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('selftest/index.html') });
});
