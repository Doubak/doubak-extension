/**
 * 完整面板（docs/ui.md 的 U2/U4/U5）。
 *
 * **这是唯一的界面。** 曾经还有一个 popup 负责「瞄一眼」，但它一失焦就关，
 * 恰好与「盯着一个跑几小时的任务」相反，日志、覆盖率、档案预览也一个都放不下。
 * 拆掉了——点工具栏图标直接开这一页（docs/ui.md §1.1）。
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
import { captureTitle, captureSubtitle, subjectLabel } from './capture-label.js';
import {
  shouldLog, formatEntry, formatLogText, MAX_ENTRIES, MAX_FETCH_ENTRIES,
} from '../crawl/event-log.js';
import { routeName, contiguityLabel } from './route-names.js';
import { chainRow, chainHeadline, holeText } from './chain-label.js';
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


/** 档案状态。界面上不出现 `in_progress` 这种内部标识。 */
const STATUS_NAMES = {
  complete: '已完成',
  in_progress: '进行中（还没收尾）',
  aborted: '中途停下',
};

/**
 * 缺口原因的中文说法。
 *
 * 这一行原来直接把内部标识打在屏幕上（`aborted`、`fetch_failed`）——界面上不出现
 * 内部术语是这个项目的明规矩，而这里恰恰是最需要说人话的地方：用户看到「连续性
 * 未验证」时唯一想知道的就是「为什么」。
 */
/**
 * 抓取事件在日志里怎么说人话。
 *
 * 只翻译那些**用户会问「这是什么」**的。其余的原样显示——内部类型名对排查有用，
 * 而胡乱翻译反而让人对不上代码。
 *
 * @param {object} e
 * @returns {string | null}
 */
function eventNote(e) {
  if (e.type === 'incremental_rebased' && e.reason === 'renamed') {
    return `豆瓣用户名从「${e.was}」改成了「${e.now}」，所以这次要重新抓一份完整的基准。`
      + '不是出错——每条路线的网址里都嵌着用户名，改名之后新旧档案的网址对不上，'
      + '接着抓会让两边拼不起来。这一次之后就又能增量了。';
  }
  if (e.type === 'incremental' && e.routes?.length) {
    return `${e.routes.length} 条路线接着上次抓（只抓新增的部分）。`;
  }
  if (e.type === 'incremental_failed') {
    return '没能读出上次的进度，这次按全量抓。已经有的会再抓一遍，但不会漏。';
  }
  if (e.type === 'no_watermark') {
    return e.message ?? '这条线抓完了却没有水位线，下次仍然只能全量重走。';
  }
  if (e.type === 'subjects_skipped') {
    return `跳过了 ${e.count} 个已经抓过的作品详情页。想重新抓一遍的话，`
      + '开抓前选「增量 + 重抓作品详情页」。';
  }
  if (e.type === 'subjects_refresh') {
    return `把 ${e.count} 个作品详情页排进了队，会重新抓一遍。`;
  }
  return null;
}

const GAP_REASONS = {
  aborted: '抓取中途停下了，这条线还有没抓完的页',
  fetch_failed: '有页面反复抓不下来',
  blocked: '被豆瓣限制了',
  challenge: '豆瓣要求验证',
  session_expired: '登录状态失效了',
  user_paused: '你手动暂停了',
  write_failed: '写入档案时出错',
  next_page_not_queued: '抓取自己走岔了：「下一页」没能入队',
  route_unavailable: '这条线一页都没读成过',
  no_items_observed: '页面声称有条目，但一个都没抽到',
};

/**
 * 后端正在做的那件事 → 界面上说什么。
 *
 * 键是全局互斥锁的持有者名字（`Exclusive` 的 `holder`）。这些状态**没有 runner
 * 也没有 checkpoint**——开工要先确认账号，那是两次真实请求、要过节奏闸门，可能
 * 好几秒。照着「有没有 runner」渲染的话，那几秒里只能说「没有进行中的抓取」，
 * 而用户刚点了开始。
 *
 * 值：[标题, 说明]。
 */
const BUSY_COPY = {
  开始抓取: ['正在确认账号…', '要先抓一次个人主页取到数字用户 ID，并确认登录状态。这一步也走正常的请求节奏，可能要几秒。'],
  恢复抓取: ['正在恢复…', '要先修好上次没写完的段尾，再确认登录状态还在。'],
  演练: ['正在演练…', '零网络请求，只走一遍真实链路。'],
  抓取: ['正在抓取…', ''],
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
  // 存储从调试页搬出来了：删档案是**日常操作**，不是调试操作。调试页里全是会改变
  // 抓取行为的东西（演练、绕过门控、小范围试跑），把一件日常操作摆在那儿，等于
  // 训练用户往那儿去找东西。
  if (btn.dataset.tab === 'storage') loadStorage();
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
  // 这两条原来一个按钮都不给，于是界面成了死路：用户按提示做完了该做的事
  // （切回账号 / 清出空间），却没有任何地方能告诉豆备「我弄好了」——只能重装扩展。
  //
  // 「继续」不等于自动重试：它由**人**触发，而恢复策略里这两条依旧是
  // `autoResume: false`，心跳绝不会自己来。
  account_switched: [
    'err',
    '账号变了',
    '一个档案只能属于一个账号。请切回原来的账号再继续，或者另开一次抓取。'
      + '（如果你根本没换过账号，那多半是豆备认错了——日志里那一行会写明是抓哪一页时判断的。）',
    '我切回来了，继续',
  ],
  quota: [
    'err',
    '存储空间不足',
    '需要先导出或清理再继续。已经抓到的都还在。',
    '我清出空间了，继续',
  ],
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
  finalize_failed: [
    'err',
    '收尾失败',
    '抓到的每一页都已经落盘，档案里的数据是完整的——坏的只是最后写 manifest 那一步。'
      + '请到「日志」标签复制日志反馈；升级插件之后再点一次「继续」通常就能收尾。',
    '再试一次收尾',
  ],
  driver_stalled: [
    'err',
    '抓取空转了',
    '连着几批什么都没推进，已经停下来了——这是插件自己的问题，不是豆瓣拦了你。'
      + '已抓到的都在档案里，没有损坏。请到「日志」标签复制日志反馈。',
    '再试一次',
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
    // 抓取正在写档案：摘要随时在变，缓存不能留。
    summaryCache = null;
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
      setActions(action ? [[action, async () => {
        // 恢复同样要好几秒（修段尾 + 确认登录状态），同样先给个兜底状态。
        pendingCommand = '恢复抓取';
        refresh();
        try {
          await send({ type: 'resume' });
        } finally {
          pendingCommand = null;
        }
        refresh();
      }]] : []);
      renderFailures(r.failures ?? []);
      renderRoutes(r.routes ?? []);
      return;
    }

    // 正在抓哪一页要写出来：只有档案编号与间隔的话，界面在几小时里几乎一动不动，
    // 看不出它到底在动还是卡住了。URL 太长，去掉协议头。
    const where = r.current
      ? `\n${r.currentActive ? '正在抓' : '刚抓完'} ${r.current.replace(/^https?:\/\//, '')}`
      : '';
    setState('run', '正在抓取', `档案 ${r.bundleId} · 当前间隔 ${(r.intervalMs / 1000).toFixed(1)} 秒` +
      (r.backoffLevel ? `（已降速 ${r.backoffLevel} 级）` : '') + where);
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
    setActions(action ? [[action, async () => {
        // 恢复同样要好几秒（修段尾 + 确认登录状态），同样先给个兜底状态。
        pendingCommand = '恢复抓取';
        refresh();
        try {
          await send({ type: 'resume' });
        } finally {
          pendingCommand = null;
        }
        refresh();
      }]] : []);
    renderRoutes([]);
    return;
  }

  renderFailures([]);

  // **后端正在忙，只是还没有 runner。**
  //
  // 开工要先确认账号（两次真实请求，过节奏闸门，好几秒）。这段时间既没有 runner
  // 也没有 checkpoint，照着状态渲染就只能说「没有进行中的抓取」——而用户刚点了开始。
  //
  // 早先的做法是点下去先本地 `setState('run', '正在确认账号…')`，但那是**界面自己
  // 编的状态**：两秒一次的轮询读到真实状态之后立刻把它盖掉，于是画面在
  // 「正在确认账号…」→「没有进行中的抓取」→（很久之后）「正在抓取」之间跳。
  // 它也活不过面板刷新——换个标签页回来就什么都看不到了。
  //
  // 现在这个状态由**做事的那一端**报出来（全局互斥锁的持有者），界面只是读它。
  const busy = s.busyWith ?? pendingCommand;
  if (busy) {
    const [title, why] = BUSY_COPY[busy] ?? ['正在处理…', ''];
    setState('run', title, why);
    setActions([]); // 这时候不给「开始抓取」——按了也只会撞上互斥锁
    return;
  }

  setState('idle', '没有进行中的抓取', '请求全部来自你自己的浏览器和 IP。cookie 不会发送到任何地方。');
  // **不清空进度表。** 抓完之后立刻变回「还没有开始」，等于把刚跑完那一次的结果扔了
  // ——而那正是用户此刻最想看的东西。改成显示上一份档案的 crawl_state：那是
  // **权威记录**（写在 manifest 里），比内存里的快照更可信。
  if (!lastRunShown) {
    lastRunShown = true;
    // 刚从「抓取中」回到空闲：档案刚收尾，缓存里可能还是没有 manifest 的那一版。
    summaryCache = null;
    // 先清一次：可能还留着上一个状态（抓取中）的表。
    renderRoutes([]);
    void showLastRun();
  }
  // 只在**进入**空闲态时查一次。权限和剩余空间不会每两秒变一次，而每两秒重画
  // 一次这块，就是用户看到的那种闪动。
  if (!preflightShown) {
    preflightShown = true;
    void showPreflight();
  }
  renderCrawlMode();
  setActions([['开始抓取', async () => {
    // `pendingCommand` 只是**开口那一小段**的兜底：从点下去到 offscreen 真正拿到
    // 锁之间（可能还要先把 offscreen 建起来），后端还报不出 `busyWith`。
    // 一旦它报得出来，就以它为准——见上面 `busy` 那一行。
    pendingCommand = '开始抓取';
    refresh();
    try {
      const r = await send({ type: 'start', mode: crawlMode });
      if (!r?.ok) {
        pendingCommand = null;
        setState('err', '无法开始', r?.error ?? '');
        return;
      }
    } finally {
      pendingCommand = null;
    }
    refresh();
  }]]);

  // **空闲态下这张表归 `showLastRun()` 管，这里不许再动它。**
  //
  // 原来这儿无条件 `renderRoutes([])`。第一次进空闲时它先清空，随后异步的
  // `showLastRun()` 把上一次的结果填上——看起来是对的；但刷新每两秒来一次，
  // 而 `lastRunShown` 已经是 true，`showLastRun()` 不再跑，这一句却照常执行，
  // **于是刚显示出来的表在几秒后被抹掉**。
  //
  // 用户看到的正是这个：打开插件先看到完整的上次结果，几秒后整块空了。
}

/**
 * 表格下面那行小字（「以上是上一次抓取…」）。
 *
 * **必须由 `renderRoutes()` 统一管**。原来是 `showLastRun()` 自己往 `#routes` 上
 * `append` 一个 div——而 `renderRoutes()` 为了不闪，只在**模式变化**时才
 * `replaceChildren`，同模式下只改单元格。于是新抓取开始、表格从「上一次的结果」
 * 换成实时数据时，那行小字**原封不动地留在下面**，对着一份完全不同的档案说
 * 「以上是上一次抓取（档案 …d8e1b2）的结果」。
 *
 * 关掉标签页再打开就恢复正常——因为那时 `dataset.mode` 是空的，走了重建那条路。
 * 「刷新一下就好」正是这类残留最典型的样子。
 *
 * @param {string} text  空字符串表示清掉
 */
function setRoutesNote(text) {
  const el = $('routes');
  let note = el.querySelector('[data-role="routes-note"]');
  if (!text) {
    note?.remove();
    return;
  }
  if (!note) {
    note = document.createElement('div');
    note.dataset.role = 'routes-note';
    note.className = 'muted';
    note.style.fontSize = '12px';
    el.append(note);
  }
  if (note.textContent !== text) note.textContent = text;
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
 * @param {string} [note]  表格下面那行小字。**不传就清掉**——见下。
 */
function renderRoutes(routes, note = '') {
  const el = $('routes');

  if (!routes.length) {
    // 空态与表格是两种结构，这时才需要真的重建。
    if (el.dataset.mode !== 'empty') {
      el.dataset.mode = 'empty';
      el.className = 'muted';
      el.replaceChildren(document.createTextNode('还没有开始'));
      routeRows.clear();
    }
    setRoutesNote(note);
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
    // 优先用 `progressTime`，退回 `oldestSeen`。
    //
    // 原来用的是水位线（最新的一条），而列表是新→旧，那个值在第一页就定住了——
    // 抓了十页日期一动不动，看起来像卡住了。改用「本次最旧的一条」之后，撞上了
    // 第二个坑：**一条离群的旧条目就能把它永久钉死**。真实数据里第 10 页混着一条
    // 2018 年的广播，从那一页起这一列再也不动，而抓取还有一大半没跑完。
    //
    // `progressTime` 取每页的中位数再累计取最小：离群值动不了中位数，而它仍然
    // 只往前不回头。抓完的档案则用 `oldestSeen`——那时「这份档案往回覆盖到 X」
    // 正是全局最小值，问的是另一个问题。
    const at = r.progressTime ?? r.oldestSeen;
    setCell(row.cells[2], at ? at.slice(0, 10) : '—', !at);
    setCell(row.cells[3], contiguityLabel(r), !r.contiguous);
  }

  setRoutesNote(note);

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
 * 面板刚发出去、后端还没来得及报出来的那条命令。
 *
 * **只是开口那一小段的兜底**：从点下去到 offscreen 真正拿到互斥锁之间（可能还要先
 * 把 offscreen 建起来），`busyWith` 还是 null。一旦后端报得出来就以后端为准——
 * 界面自己编的状态活不过刷新，也会被轮询盖掉。
 *
 * @type {string | null}
 */
let pendingCommand = null;

/**
 * 重新渲染**当前打开的那个标签页**。
 *
 * 存储变化之后必须做这件事：用户可能正停在覆盖率或档案页上，而那两页的内容刚刚失效。
 * 只作废缓存不重画的话，他会盯着一份已经被删掉的档案的数字。
 */
async function refreshOpenTab() {
  const on = [...$('tabs').querySelectorAll('button')]
    .find((b) => b.getAttribute('aria-selected') === 'true')?.dataset.tab;
  if (on === 'coverage') await loadCoverage();
  else if (on === 'archive') await loadArchive();
}

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
      // 这份档案已经收尾了：不连续就是**没验证通过**，不是「还在跑」。
      settled: true,
      gaps: cs.gaps ?? [],
    }));
    if (rows.length === 0) return;

    renderRoutes(rows, `以上是上一次抓取（档案 ${id}）的结果，来自它的 manifest。`);
  } catch {
    // 读不出来就维持「还没有开始」。这只是个便利显示，不该让概览页报错。
  }
}

/**
 * 这次要怎么抓。
 *
 * **默认增量，但必须能选。** 用户可能想重建一份基准（上一次有缺口、或者不信任它），
 * 也可能想重新抓一遍作品详情页看看评分变了没有。默认帮他省时间，但不替他做决定。
 *
 * @type {'incremental' | 'full' | 'refresh-subjects'}
 */
let crawlMode = 'incremental';

/** 抓取方式的三个选项。 */
function renderCrawlMode() {
  const el = $('crawl-mode');
  el.replaceChildren();

  const opts = /** @type {const} */ ([
    ['incremental', '增量（推荐）',
      '接着上次抓：列表只抓新增的部分，作品详情页只抓这次新出现的。最快。'],
    ['full', '全量重抓',
      '当作从来没抓过。上一次有缺口、或者你不信任它的时候用——会重新打一份基准。'],
    ['refresh-subjects', '增量 + 重抓作品详情页',
      '列表照旧只抓新增的，但**每个作品详情页都重抓一遍**：评分、短评这些会变的东西'
      + '想拿到新版本时用。那条路线占档案九成体积，会慢很多。'],
  ]);

  for (const [key, label, why] of opts) {
    const row = document.createElement('label');
    row.style.display = 'block';
    row.style.margin = '4px 0';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'crawl-mode';
    radio.checked = crawlMode === key;
    radio.onchange = () => { crawlMode = key; renderCrawlMode(); refresh(); };
    const b = document.createElement('b');
    b.style.display = 'inline';
    b.textContent = ` ${label} `;
    const note = document.createElement('span');
    note.className = 'muted';
    note.style.fontSize = '12px';
    note.textContent = why;
    row.append(radio, b, note);
    el.append(row);
  }
}

/**
 * 开抓前那一行「这次抓取的范围」。
 *
 * **措辞要保守。** 下界是在身份确认之后才挑的（判据是数字用户 ID，那时才知道），
 * 而这一页在开工之前——所以这里说的是「有没有可用的基准」，不是「这次一定增量」。
 * 许一个可能兑现不了的承诺，比说得含糊糟糕。
 *
 * @param {{routes?: string[], oldest?: string | null} | null | undefined} inc
 */
function scopeText(inc) {
  if (crawlMode === 'full') {
    return '全量（你选的）—— 当作从来没抓过，会重新打一份基准';
  }
  const n = inc?.routes?.length ?? 0;
  const subjects = crawlMode === 'refresh-subjects'
    ? '作品详情页**全部重抓**（你选的）'
    : '作品详情页只抓这次新出现的';
  if (n === 0) {
    return `全量（从最新一直抓到最早）—— 还没有可以接着抓的档案，或者上一次没跑完。${subjects}`;
  }
  return `增量：${n} 条路线可以接着上次抓（只抓新增的部分）；其余的仍然从头走。${subjects}`;
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
  // 而这件事影响的是他要等多久。
  //
  // 但这里**只能说个大概**：下界是在身份确认之后才挑的（判据是数字 uid，那时才知道），
  // 而这一页在开工之前。所以说的是「有没有可用的基准」，不是「这次一定增量」。
  // 宁可说得保守，也不要许一个可能兑现不了的承诺。
  rows.push(['这次抓取的范围', scopeText(r.incremental)]);

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
/**
 * 覆盖率页看的是哪个视角。
 *
 * 增量之后，**单份档案的「实抓」不再有完整性含义**——它可能只有 3 条新的。
 * 完整性是整条**链**的属性，所以默认看合起来。
 *
 * @type {'chain' | 'one'}
 */
let coverageView = 'chain';

async function loadCoverage() {
  const el = $('coverage');
  el.className = 'muted';
  el.textContent = '正在读取档案…';
  delete el.dataset.stale;

  try {
    const cur = await loadBundleSummary();
    if (!cur) {
      $('coverage-view').replaceChildren();
      $('chain').replaceChildren();
      el.className = 'muted';
      el.textContent = '还没有档案。开始一次抓取之后这里会显示对账结果。';
      return;
    }

    renderCoverageSwitch();

    if (coverageView === 'chain') {
      $('coverage').replaceChildren();
      await renderChain();
      return;
    }

    $('chain').replaceChildren();
    if (!cur.summary.hasManifest) {
      el.className = 'muted';
      el.textContent = '这次抓取还没收尾——覆盖率证据是收尾时才攒的，现在还没有。';
      return;
    }
    renderCoverage(cur.summary.coverage, cur.summary.crawlState, cur.id);
  } catch (e) {
    el.className = 'card err';
    el.textContent = `读不出来：${e.message}`;
  }
}

/** 「合起来 / 这一份」的切换。 */
function renderCoverageSwitch() {
  const el = $('coverage-view');
  el.replaceChildren();
  for (const [key, label, why] of /** @type {const} */ ([
    ['chain', '合起来', '整条链覆盖到哪儿 —— 完整性是链的属性'],
    ['one', '这一份', '这一次抓取自己做了什么'],
  ])) {
    const b = document.createElement('button');
    b.className = 'act';
    b.textContent = label;
    b.title = why;
    b.disabled = coverageView === key;
    b.onclick = () => { coverageView = key; loadCoverage(); };
    el.append(b);
  }
}

/**
 * 「合起来」：整条链覆盖到哪儿。
 *
 * **主角是连续区间，不是数字。** 刻意不算「合起来一共抓了多少」再跟豆瓣声称的比：
 * 下界是闭区间、档案之间必然重叠，那个数只会误导；而这一页存在的全部理由就是
 * 「计数不能证明完整性，连续性才能」。
 */
async function renderChain() {
  const el = $('chain');
  el.className = 'muted';
  el.textContent = '正在读所有档案…';

  const r = await send({ type: 'chain' });
  if (!r?.ok) {
    el.className = 'card err';
    el.textContent = `读不出来：${r?.error ?? ''}`;
    return;
  }
  const { routes, bundles, holes, others } = r.chain;
  el.className = '';
  el.replaceChildren();

  if (!routes.length) {
    el.className = 'muted';
    el.textContent = '还没有收尾的档案。';
    return;
  }

  const head = document.createElement('div');
  head.className = 'card idle';
  const hb = document.createElement('b');
  hb.textContent = chainHeadline(bundles);
  head.append(hb, document.createTextNode(bundles.map((b) => b.bundleId).join(' ← ')));
  el.append(head);

  el.append(table(
    ['路线', '覆盖区间', '跨几份', '连续性'],
    routes.map(chainRow).map((r) => [
      r.name,
      r.span ?? { text: r.spanNote, muted: true },
      String(r.bundles),
      r.verdict,
    ]),
  ));

  // 不在这条链上的档案要说出来：用户手上可能有好几次独立的全量，而这一页只讲
  // 最新那一条链——不提的话看起来像档案丢了。
  if (others?.length) {
    const c = document.createElement('div');
    c.className = 'card idle';
    const b = document.createElement('b');
    b.textContent = `另外还有 ${others.length} 组档案，不在这条链上`;
    c.append(b, document.createTextNode(
      `${others.map((o) => o.head).join('、')} —— 它们是各自独立的抓取（没有接在别人后面），`
      + '所以不能合起来算连续。增量做出来之前的每一次抓取都是这样。',
    ));
    el.append(c);
  }

  // 链断了要**明说**，而且不能因此把在场的那几份说成无效。
  for (const h of holes) {
    const c = document.createElement('div');
    c.className = 'card warn';
    const b = document.createElement('b');
    b.textContent = holeText(h);
    c.append(b, document.createTextNode(h.detail));
    el.append(c);
  }
}

/** @param {object[]} coverage @param {object[]} crawlState @param {string} [bundleId] */
function renderCoverage(coverage, crawlState, bundleId) {
  const el = $('coverage');
  el.replaceChildren();

  // 说清这是**哪一份**档案的对账。档案页有个下拉可以切换，不写出来的话两页对不上时
  // 没人知道自己在看什么。
  if (bundleId) {
    const which = document.createElement('div');
    which.className = 'muted';
    which.style.fontSize = '12px';
    which.textContent = `档案 ${bundleId}`;
    el.append(which);
  }

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
    // 与进度表用同一套说法：说结论（有几处缺口），不说「未验证」——后者听起来像
    // 我们的代码没查，而其实查了。见 `contiguityLabel`。
    b.textContent = `${routeName(cs.route_key)} · ${contiguityLabel({
      contiguous: cs.contiguous, settled: true, gaps: cs.gaps,
    })}`;
    // 说人话，并且**把 detail 带出来**——写 detail 的地方正是那些「原因一个词说
    // 不清」的情形（比如「下一页没能入队」），而那句话原本只存在档案里没人看得到。
    const lines = [`有 ${cs.gaps.length} 处缺口。`];
    if (cs.gaps.some((x) => x.reason === 'no_items_observed')) {
      lines.push(
        '其中有一处是「页面声称有条目，但一个都没抽到」——那通常意味着豆瓣改版了，'
        + '抓取的终止判断因此失效。这一页已经如实存进档案，可据此重新校准。',
      );
    } else {
      const why = [...new Set(cs.gaps.map((x) => GAP_REASONS[x.reason] ?? x.reason))];
      lines.push(`原因：${why.join('；')}。`);
      const detail = cs.gaps.find((x) => x.detail)?.detail;
      if (detail) lines.push(detail);
      lines.push('这段区间的内容可能不完整，下次抓取会从上次的下界重走。');
    }
    g.append(b, document.createTextNode(lines.join('')));
    el.append(g);
  }
}

// ── 档案预览 ────────────────────────────────────────────────

/** @type {BundleReader | null} */
let reader = null;
/** @type {object[]} */
let entries = [];

/**
 * 当前在看哪份档案，以及它的摘要缓存。
 *
 * ## 为什么要一个共同的所有者
 *
 * 覆盖率原来有**两条渲染路径**：档案页 `openBundle()` 的副作用，以及覆盖率页自己的
 * 加载器。两个真相来源，于是：
 *
 * - 没去过档案页时，覆盖率页看到的和档案页可能不是同一份档案
 * - 删掉档案之后，`currentBundleId` 还指着一个已经不存在的目录
 * - 抓完一次之后，缓存没人让它失效
 *
 * 现在只有这里一处知道「在看哪份、它的摘要是什么」，两个标签页都从这里读；任何会改变
 * 存储的动作都调 `invalidateBundles()`。
 */
let currentBundleId = null;
/** @type {{id: string, summary: object} | null} 摘要缓存，避免两个标签页各读一次 */
let summaryCache = null;

/**
 * 存储变了：删了档案、抓完一次、清空。
 *
 * 缓存作废，并且**如果当前选中的那份已经不在了就取消选中**——不取消的话，下一次读取
 * 会去开一个不存在的目录然后报「读不出来」，而真实情况只是它被删了。
 *
 * @param {string[]} [remainingIds]  还剩哪些；不给就只作废缓存
 */
function invalidateBundles(remainingIds) {
  summaryCache = null;
  if (remainingIds && currentBundleId && !remainingIds.includes(currentBundleId)) {
    currentBundleId = null;
  }
  // 已经渲染出来的内容立刻标记为过期，免得用户看着旧数字以为还在
  for (const id of ['coverage', 'archive-summary', 'captures']) {
    const el = $(id);
    if (el) el.dataset.stale = '1';
  }
}

/**
 * 读当前档案的摘要。**两个标签页共用这一处**。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]
 * @returns {Promise<{id: string, summary: object} | null>}  没有档案时返回 null
 */
async function loadBundleSummary({ force = false } = {}) {
  const dirs = await WorkerFileStore.listBundleDirs(getOpfsWorker());
  const ids = dirs.map(bundleIdFromDirName).filter(Boolean);

  // 选中的那份没了（被删了）就退回最新的一份
  if (currentBundleId && !ids.includes(currentBundleId)) currentBundleId = null;
  const id = currentBundleId ?? ids[0];
  if (!id) {
    summaryCache = null;
    return null;
  }

  if (!force && summaryCache?.id === id) return summaryCache;

  const store = new WorkerFileStore({ worker: getOpfsWorker(), dir: bundleDirName(id) });
  const summary = await new BundleReader({ store, bundleId: id }).summary();
  summaryCache = { id, summary };
  return summaryCache;
}

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
  $('delete-this').disabled = !on;
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
    const cur = await loadBundleSummary({ force: true });
    const s = cur?.summary ?? (await reader.summary());
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
    // **全量还是增量**，说在摘要里。增量档案的「捕获条数」看起来会小得离谱
  // （只有新增的那些），不说清的话像是抓漏了。
  if (s.previousBundleId) {
    const c = document.createElement('div');
    c.className = 'card idle';
    const b = document.createElement('b');
    b.textContent = '这是一次增量抓取';
    c.append(b, document.createTextNode(
      `接在档案 ${s.previousBundleId} 后面 —— 只抓了上次之后新增的部分。`
      + '所以「捕获条数」比全量那次小是正常的；完整性要看覆盖率页的「合起来」。',
    ));
    summaryEl.after(c);
  }

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
    // **不在这里渲染覆盖率。** 那会是第二条路径，也就是第二个真相来源——覆盖率页
    // 自己有加载器，切过去时会从同一处读。
    renderCaptures();
  } catch (e) {
    summaryEl.className = 'card err';
    summaryEl.textContent = `读不出这个档案：${e.message}`;
    // 读不出摘要不代表导不出去——字节还在，照样该让用户把它搬走。
    setArchiveButtons(true);
  }
}

/**
 * 这一份在链上的位置、哪些是新增的、以及跨链的版本历史。
 *
 * 增量档案里混着两种东西：这次新出现的条目，和边界上被重抓的那几条（下界比较是
 * 闭区间，宁可重复不可遗漏）。捕获列表里它们长得一模一样，而用户想知道的恰恰是
 * 「这次到底新得到了什么」。
 *
 * **只读 index，不解压任何记录**——这两个问题的答案全在 index 里。
 */
async function loadChainDiff() {
  const el = $('archive-chain');
  const vEl = $('versions');
  el.replaceChildren();
  vEl.replaceChildren();
  if (!currentBundleId) return;

  const r = await send({ type: 'chainDiff', bundleId: currentBundleId });
  if (!r?.ok || !r.diff) return;
  // 用户可能在这期间切了档案
  if (!currentBundleId) return;

  const repeated = new Set(r.diff.repeated ?? []);
  if (repeated.size) {
    const c = document.createElement('div');
    c.className = 'card idle';
    const b = document.createElement('b');
    const fresh = entries.length - repeated.size;
    b.textContent = `这一份里 ${fresh} 条是新增的，${repeated.size} 条是又抓了一次`;
    c.append(b, document.createTextNode(
      '「又抓了一次」是正常的：增量的下界按闭区间比较（宁可重复，不可遗漏），'
      + '所以边界那一段会重叠。同一个网址的多次捕获**不是重复数据，是版本**。',
    ));
    el.append(c);
    // 就地给列表补标
    markRepeated(repeated);
  }

  renderVersions(r.diff.versions ?? [], r.diff.truncated);
}

/** 给捕获列表里「又抓了一次」的那些行补一个标记。 */
function markRepeated(repeated) {
  for (const [i, e] of entries.slice(0, 500).entries()) {
    if (!repeated.has(e.url_key)) continue;
    const row = $('captures').children[i];
    const tag = row?.querySelector?.('span');
    if (tag && !tag.textContent.includes('又抓')) tag.textContent += '　·　又抓了一次';
  }
}

/**
 * 版本历史：同一个网址在链上被抓到过几次。
 *
 * **这不是重复数据，是版本**——评分变了、短评改了、条目被删了。这正是「有意保留
 * 不同版本」的兑现处，也是 canonical 的 revision 模型的原料。
 */
function renderVersions(versions, truncated) {
  const el = $('versions');
  if (!versions.length) return;

  const head = document.createElement('div');
  head.className = 'card idle';
  const b = document.createElement('b');
  b.textContent = `${versions.length} 个网址在链上有多个版本${truncated ? '（只列前 200 个）' : ''}`;
  head.append(b, document.createTextNode(
    '同一个网址在不同时间抓到的内容可能不一样——评分变了、短评改了、条目被删了。'
    + '这些版本都留着，那正是备份的意义。',
  ));
  el.append(head);

  const list = document.createElement('div');
  list.className = 'caps';
  for (const v of versions.slice(0, 50)) {
    const row = document.createElement('div');
    row.className = 'cap';
    const left = document.createElement('span');
    left.textContent = subjectLabel(v.urlKey) ?? v.urlKey;
    const right = document.createElement('span');
    right.className = 'v';
    right.textContent = `${v.versions.length} 个版本`;
    row.append(left, right);

    const when = document.createElement('div');
    when.className = 'muted';
    when.style.fontSize = '12px';
    when.textContent = v.versions
      .map((x) => String(x.observedAt ?? '').slice(0, 10))
      .join(' · ');
    row.append(when);
    list.append(row);
  }
  el.append(list);
}

/**
 * 「豆瓣上已经没有了」的那几条，单独列出来。
 *
 * ## 为什么值得占一块地方
 *
 * 这是**整份档案里最不可替代的信息**。一份 3347 条的真实档案里有 8 条 `gone`——
 * 那 8 部电影豆瓣已经删了，网上再也查不到，而你的档案里存着它们当时的样子。
 * 这正是这个项目存在的理由本身。
 *
 * 而它原来只以「判定分布：正常 3339 · 已不存在 8」这一个数字出现，**没有任何地方
 * 说得出是哪 8 条**。捕获列表里能看到，但要在 3347 行里翻。
 *
 * 顺带也列 `blocked` / `challenge` / 判不出来的：它们是风控留下的痕迹，同样稀少
 * 同样要紧。
 */
function renderVanished() {
  const el = $('vanished');
  if (!el) return;
  el.replaceChildren();

  const bad = entries.filter((e) => e.verdict !== 'ok');
  if (bad.length === 0) return;

  const card = document.createElement('div');
  card.className = 'card warn';
  const b = document.createElement('b');
  const goneCount = bad.filter((e) => e.verdict === 'gone').length;
  b.textContent = goneCount
    ? `有 ${goneCount} 条在豆瓣上已经没有了`
    : `有 ${bad.length} 条不是正常抓到的`;
  card.append(b, document.createTextNode(
    goneCount
      ? '豆瓣已经删除了这些条目，网上再也查不到——而档案里存着它们当时的样子。'
        + '这正是备份的意义所在。'
      : '这些页面没有正常抓到，原样存在档案里，可以打开看看到底是什么。',
  ));
  el.append(card);

  const list = document.createElement('div');
  list.className = 'caps';
  for (const e of bad) {
    const row = document.createElement('div');
    row.className = 'cap';
    const left = document.createElement('span');
    left.textContent = captureTitle(e, routeName);
    const right = document.createElement('span');
    right.className = 'v warn-text';
    right.textContent = VERDICT_NAMES[e.verdict] ?? (e.verdict ?? '判不出来');
    row.append(left, right);

    const url = document.createElement('div');
    url.className = 'muted';
    url.style.fontSize = '12px';
    url.style.wordBreak = 'break-all';
    url.textContent = `${e.url} · 抓于 ${String(e.observed_at ?? '').slice(0, 19).replace('T', ' ')}`;
    row.append(url);
    list.append(row);
  }
  el.append(list);
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
  // 「已经没有了」的那几条单独列一块。**捕获列表只渲染前 500 行**，而真实档案有
  // 3347 条——那 8 条 gone 排在后面，在列表里根本画不出来。
  renderVanished();
  // 链上的差异（新增 / 又抓了一次）与版本历史。异步，拿到之后就地补标。
  void loadChainDiff();

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
    el.textContent = '还没有事件。这里记抓过的 URL（最近 200 条）以及重试、停机、错误这类事件（最近 1000 条）——完整的抓取记录在档案的 index.ndjson 里。';
  } else {
    for (const r of logRows) {
      const d = document.createElement('div');
      const bits = [r.at?.slice(0, 19).replace('T', ' '), r.type, r.routeKey, r.verdict, r.reason, r.url, r.message];
      d.textContent = bits.filter(Boolean).join('  ·  ');
      // 少数几种事件用户会问「这是什么」——把人话补一行。其余原样：内部类型名
      // 对排查有用，胡乱翻译反而让人对不上代码。
      const note = eventNote(r);
      if (note) {
        const n = document.createElement('div');
        n.className = 'muted';
        n.style.paddingLeft = '16px';
        n.textContent = note;
        d.append(n);
      }
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
  if (logRows.length > MAX_ENTRIES + MAX_FETCH_ENTRIES) logRows.pop();
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
/**
 * 删一份档案。
 *
 * `report` 让调用方决定把结果写到哪儿：存储页写自己的结果区，档案页写自己的——
 * 否则从档案页删完之后，成功/失败的消息会出现在一个用户看不见的标签页里。
 *
 * @param {string} bundleId
 * @param {object} [opts]
 * @param {(cls: string, text: string) => void} [opts.report]
 * @returns {Promise<boolean>} 是否真的删掉了
 */
async function deleteBundle(bundleId, { report = setStorageResult } = {}) {
  // 存储页可能还没打开过，`storageUsage` 是空的——而确认框要说出「多大、导出过
  // 没有」，那些都在里面。先读一次。
  if (!storageUsage.length) await loadStorage();

  // 界面上那个确认框是给人看的，`checkDeletable` 是给代码守的。**两者都要有**——
  // 用户可能点得很快。
  const check = checkDeletable(storageUsage, bundleId);
  if (!check.ok) {
    report('err', check.error);
    return false;
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
  if (!confirm(lines.join('\n'))) return false;

  report('idle', `正在删除 ${u.bundleId}…`);
  const r = await send({ type: 'deleteBundle', bundleId: u.bundleId, dir: u.dir });
  if (!r?.ok) {
    report('err', `删不掉：${r?.error ?? ''}`);
    return false;
  }
  report('good', `已删除 ${u.bundleId}（释放 ${bytes(u.bytes)}）`);
  // 存储变了：作废缓存，并且如果当前选中的那份就是被删的那个，取消选中。
  // 不取消的话，下一次读取会去开一个不存在的目录然后报「读不出来」，
  // 而真实情况只是它被删了。
  invalidateBundles(storageUsage.filter((x) => x.bundleId !== u.bundleId).map((x) => x.bundleId));
  await loadStorage();
  await refreshOpenTab();
  return true;
}

// 档案页的「删除这一份」。
//
// 放在这里是因为**这里才有上下文**：你刚看过它有多少条、多大、导出过没有。
// 存储页那份是批量视角，两个都要——而删档案本来就不该只能在调试页里做。
$('delete-this').addEventListener('click', async () => {
  if (!currentBundleId) return;
  const gone = await deleteBundle(currentBundleId, {
    report: (cls, text) => {
      const el = $('export-result');
      el.className = `card ${cls}`;
      el.textContent = text;
    },
  });
  if (!gone) return;
  // 删掉的正是当前打开的这一份：清空视图，别让用户对着一份不存在的档案的数字看。
  currentBundleId = null;
  entries = [];
  $('archive-summary').replaceChildren();
  $('vanished').replaceChildren();
  setArchiveButtons(false);
  await loadArchive();
});

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

  invalidateBundles(blocked.map((x) => x.bundleId));
  if (failed.length) setStorageResult('err', `有 ${failed.length} 份删不掉：${failed.join('；')}`);
  else setStorageResult('good', `已清空 ${deletable.length} 份档案`);
  await loadStorage();
  await refreshOpenTab();
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
