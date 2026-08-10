/**
 * 概览页：状态、进度、路线表、开始/暂停/继续。
 *
 * 面板上唯一**会自己动**的一页——每两秒重读一次状态（见 panel.js 的启动那一段）。
 */

import { BundleReader } from '../../bundle/bundle-reader.js';
import { WorkerFileStore } from '../../storage/worker-file-store.js';
import { bundleDirName, bundleIdFromDirName } from '../../core/ids.js';
import { routeName, contiguityLabel } from '../route-names.js';
import { renderStatus, statusCard, button as mkButton } from '../components.js';
import {
  $, send, bytes, table, BUSY_COPY, getOpfsWorker, invalidateStorageUsage,
  getLastStatus, setLastStatus,
} from './shared.js';
import { loadArchive, invalidateSummary } from './archive.js';
import { loadCoverage } from './coverage.js';

const PAUSE_COPY = {
  challenge: ['warn', '豆瓣要求验证', '请在新标签页中完成验证，完成后返回并点击「继续」。插件与浏览器共用登录状态。', '我验证好了，继续'],
  blocked: ['warn', '豆瓣暂时限制了访问', '抓取已停止，且不会自动重试：继续请求可能导致账号受限。建议等待 30 分钟以上再继续。', '现在试试'],
  session_expired: ['warn', '登录状态已失效', '这不是错误，抓取已安全停止，进度均已保留。请重新登录豆瓣后继续。', '我登录好了，继续'],
  // 这两条原来一个按钮都不给，于是界面成了死路：用户按提示做完了该做的事
  // （切回账号 / 清出空间），却没有任何地方能告诉豆备「我弄好了」——只能重装扩展。
  //
  // 「继续」不等于自动重试：它由**人**触发，而恢复策略里这两条依旧是
  // `autoResume: false`，心跳绝不会自己来。
  account_switched: [
    'err',
    '账号变了',
    '一个档案只能归属于一个账号。请切换回原账号后继续，或另行发起一次抓取。'
      + '（若你并未切换过账号，则多半是豆备判断有误：日志中该条记录会写明是在抓取哪一页时作出的判断。）',
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
    '这不是错误，抓取已安全停止，进度均已保留。请在浏览器的扩展设置中将站点访问权限改回「在所有网站上」。',
    '我改好了，继续',
  ],
  failures_pending: [
    'warn',
    '有几个页面抓不下来',
    '其余部分均已抓取完成。以下列出未能抓取的页面：可以重试，也可以确认按现状收尾。',
    null, // 动作在下面的失败清单里，不用这里的通用按钮
  ],
  write_failed: [
    'err',
    '写入档案时出错',
    '抓取已停止，以免损坏既有数据。继续之前会先自动修复段文件尾部。',
    '我知道了，继续',
  ],
  finalize_failed: [
    'err',
    '收尾失败',
    '已抓取的每一页均已落盘，档案中的数据是完整的，仅最后写入 manifest 的步骤失败。'
      + '请在「日志」标签页复制日志以便反馈；升级插件后再次点击「继续」通常即可完成收尾。',
    '再试一次收尾',
  ],
  driver_stalled: [
    'err',
    '抓取空转了',
    '连续多批未取得任何进展，抓取已停止。这是插件自身的问题，并非豆瓣的限制。'
      + '已抓取的内容均在档案中且未受损坏。请在「日志」标签页复制日志以便反馈。',
    '再试一次',
  ],
  network_down: [
    'warn',
    '连不上豆瓣',
    '网络似乎断了。抓取已停下，进度都在——网络恢复之后会自动继续，你不需要做什么。',
    '现在试试',
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
  for (const [label, fn, kind] of buttons) {
    const b = document.createElement('button');
    // 第三个元素是**样式**：不可逆的动作要看起来不一样（用边框而不是填充色，
    // 填充的红按钮在一排里反而最抢眼，会把人往那儿引）。
    b.className = kind === 'danger' ? 'act danger' : 'act';
    b.textContent = label;
    b.onclick = fn;
    el.append(b);
  }
}


/**
 * 操作失败的提示。
 *
 * ## 为什么不能用 `setState()`
 *
 * 状态卡由 `refresh()` 画，而 `refresh()` **每 2 秒被轮询调用一次**。于是任何写
 * 进状态卡的错误信息，最多活两秒就被下一轮按后台状态重画掉。
 *
 * 用户看到的正是这个：点一下按钮 → 闪出点什么 → 回到原样。而这整个排查过程里
 * 有好几轮浪费在这上面——「点了没反应」和「报了错但你没看见」在屏幕上完全一样，
 * 却指向完全不同的原因。
 *
 * 所以操作类的错误有自己的一块地方，**轮询不碰它**。清掉它的只有两件事：用户
 * 自己关掉，或者下一次操作成功了。
 *
 * @type {{title: string, detail: string} | null}
 */
let actionError = null;

/** @param {string} title @param {string} detail */
export function setActionError(title, detail) {
  actionError = { title, detail };
  renderNotice();
}

function clearActionError() {
  if (!actionError) return;
  actionError = null;
  renderNotice();
}

function renderNotice() {
  const el = $('notice');
  if (!el) return;
  if (!actionError) {
    el.replaceChildren();
    return;
  }
  const card = document.createElement('div');
  card.className = 'card err';
  const b = document.createElement('b');
  b.textContent = actionError.title;
  card.append(b);
  card.append(document.createTextNode(actionError.detail));
  const close = document.createElement('button');
  close.className = 'act';
  close.textContent = '知道了';
  close.onclick = clearActionError;
  card.append(close);
  el.replaceChildren(card);
}

export async function refresh() {
  const s = await send({ type: 'status' });
  setLastStatus(s);

  if (!s?.ok) {
    setState('err', '连不上后台', s?.error ?? '');
    setActions([['重试', refresh]]);
    return;
  }

  // **忙碌状态要在所有分支之前判。**
  //
  // 原来它只在空闲分支里——于是「有 checkpoint、正在恢复」时按下继续，界面照旧
  // 渲染「抓取已停下」，什么都不变，直到几秒后恢复真的完成。用户看到的是「点了
  // 没反应，等了五秒忽然全出来了」。
  //
  // 恢复本身就慢（修段尾 + 确认登录状态，都是真请求），所以这几秒必须有交代。
  const busy = s.busyWith ?? pendingCommand;
  if (busy && !s.runner?.active) {
    const [title, why] = BUSY_COPY[busy] ?? ['正在处理…', ''];
    setState('run', title, why);
    setActions([]);
    return;
  }

  if (s.runner?.active || s.checkpoint) {
    // 离开空闲态：把预检结果收掉，下次回到空闲再查一次（那时空间已经变了）。
    if (preflightShown) {
      preflightShown = false;
      $('preflight').replaceChildren();
    }
    // 上一次的结果让位给**正在进行**的这一次。
    //
    // 只在 runner 真的活着时才让位：只有 checkpoint（offscreen 还没起来）时，
    // 进度只能从上一份档案的 crawl_state 来——那时清掉标志会让它每两秒重读一次
    // OPFS，而且中间那一瞬是空的，表格会闪。
    if (s.runner?.active) lastRunShown = false;
    // 抓取正在写档案：摘要随时在变，缓存不能留。
    invalidateSummary();
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
      setActions([
        ...(action ? [[action, resumeCrawl]] : []),
        // **只要有抓不下来的条目就摆出来，不管是哪种停法。**
        //
        // 原来只在没有「继续」时才给（failures_pending），理由是「决定在失败清单
        // 里」。但那张表有一百多行，顶端只剩「中止」就成了死路；而在**暂停**状态
        // 下它更隐蔽——「继续」看起来什么都能解决，实际上它**不会重试失败条目**
        // （重试刻意只能由人触发，见 frontier.retryFailed）。于是用户会一路点
        // 「继续」，而那几十个页面永远留在原地。
        ...failureActions(r.failures),
        // 停下来之后**尤其**需要这个：不想接着抓的话，只有中止才能把这份档案
        // 放开（暂停不行——它还挂在「正在抓的那份」上，删不掉）。
        ['中止这次抓取', () => abortCrawl(r.bundleId), 'danger'],
      ]);
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
    setActions([
      ['暂停', async () => {
        // 立刻给反馈。一批最长 22 秒，期间不给任何回应的话按钮看起来就是坏的。
        setState('idle', '正在暂停…', '当前这一页抓完就停，不会丢东西。');
        await send({ type: 'pause' });
        refresh();
      }],
      ['中止', () => abortCrawl(r.bundleId), 'danger'],
    ]);
    renderRoutes(r.routes ?? []);
    return;
  }

  if (s.checkpoint) {
    const [cls, title, why, action] = PAUSE_COPY[s.checkpoint.pause_reason] ??
      ['warn', '抓取已停下', `原因：${s.checkpoint.pause_reason}`, '继续'];
    setState(cls, title, why);
    setActions([
      ...(action ? [[action, resumeCrawl]] : []),
      // **没有「继续」时也必须有出路。**
      //
      // `failures_pending` 刻意不给「继续」，因为该做的决定是「重试」还是
      // 「就这样收尾」。而在这条分支里（offscreen 被回收了，只剩 checkpoint）
      // 失败清单**根本不渲染**——于是整个界面只剩一个「中止这次抓取」：用户唯一
      // 能做的事，是把一次跑了几小时、只差几个页面的抓取扔掉。
      //
      // 这两个动作会先把抓取从 checkpoint 装回内存（见 background 的
      // `ensureRunLoaded`），所以在这里点得动。
      ...(action || s.checkpoint.pause_reason !== 'failures_pending'
        ? []
        : [['重试抓不下来的页面', retryFailures], ['就这样收尾', () => finishWithGaps()]]),
      // **这里也要能中止。** 刚打开插件时 offscreen 还没起来，只有 checkpoint——
      // 而那正是用户最可能想说「这次不抓了」的时刻。
      ['中止这次抓取', () => abortCrawl(s.checkpoint.bundle_id), 'danger'],
    ]);
    // 进度表交给「上一次的结果」：这时候没有 runner，但档案里的 crawl_state 有。
    // 空着一片什么都不说，比显示上一次的结果糟糕。
    if (!lastRunShown) {
      lastRunShown = true;
      renderRoutes([]);
      void showLastRun();
    }
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
  setState('idle', '没有进行中的抓取', '所有请求均来自你本机的浏览器与 IP，cookie 不会发送至任何第三方。');
  // **不清空进度表。** 抓完之后立刻变回「还没有开始」，等于把刚跑完那一次的结果扔了
  // ——而那正是用户此刻最想看的东西。改成显示上一份档案的 crawl_state：那是
  // **权威记录**（写在 manifest 里），比内存里的快照更可信。
  if (!lastRunShown) {
    lastRunShown = true;
    // 刚从「抓取中」回到空闲：档案刚收尾，缓存里可能还是没有 manifest 的那一版。
    invalidateSummary();
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
        setActionError('无法开始', r?.error ?? '后台没有给出原因。');
        return;
      }
      clearActionError();
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
    note.className = note.className ? `${note.className} small` : 'small';
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
export async function refreshOpenTab() {
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
 * 中止这次抓取。
 *
 * ## 为什么要单独一个动作
 *
 * 暂停是「等会儿接着抓」——档案还在写、指针还指着它，所以**删不掉**。而存储页
 * 那句「这份正在抓，先暂停或等它结束」是句错话：暂停之后它依旧删不掉。
 *
 * 中止是「这次到此为止」：收尾成 `aborted`（如实带上缺口），放开指针。之后它就是
 * 一份普通的已收尾档案——能看、能导出、能删。
 *
 * ## 确认要说清不可逆的是什么
 *
 * **不是数据**——已经抓到的每一页都留在档案里。不可逆的是**这次抓取**：之后不能
 * 再继续，要接着抓只能重新开一次（而增量会让重开便宜很多）。
 *
 * 把这两件事说反了，用户要么不敢按，要么按了之后才发现丢了进度。
 *
 * @param {string} bundleId
 */
/**
 * 重试全部失败条目。顶部动作行与失败清单共用。
 *
 * ## 出错就停在错误上，**不要接着 refresh()**
 *
 * 原来是 `if (!r.ok) setState('err', …); refresh();`——`refresh()` 无条件跟在
 * 后面，它按后台状态重画整块，于是刚写上去的错误信息**当场被抹掉**。用户看到的
 * 是「闪了一下，又回到原样」，而真正的原因刚被自己擦掉了。
 *
 * 这与「继续」按钮那次是同一个毛病，我在刚写的这个函数里又犯了一遍。
 *
 * ## 「一条都没重试」也要说
 *
 * 后台返回 `count: 0` 时原来什么都不做。而这跟成功长得一模一样：按钮按下去、
 * 界面回到原样、一个请求都没发。得说出来它是**哪一种**没发生。
 */
async function retryFailures() {
  const r = await send({ type: 'retryFailed' });
  if (!r?.ok) {
    // **别把不相干的问题挂在这次操作头上。** 「重试失败：当前未登录豆瓣」看起来
    // 像重试功能坏了，而实际发生的是会话过期——界面里本来就有一块专门处理它的。
    // 后台已经把整场抓取的状态改成了对应原因，刷一下就会切到那个界面去。
    if (r?.reason) {
      const [, title] = PAUSE_COPY[r.reason] ?? [];
      setActionError(title ?? '抓取已停下', r.error ?? '');
      refresh();
      return;
    }
    setActionError('重试失败', r?.error ?? '后台没有给出原因。');
    return;
  }
  if (!r.count) {
    setActionError(
      '没有可重试的条目',
      r.loaded === false
        ? '这次抓取已经不在内存里，也没有可恢复的存档点——它可能已经收尾或被中止了。'
        // **不要在这里让用户去按「继续」。** `failures_pending` 状态下压根没有那个
        // 按钮（其余部分都抓完了，没有什么可继续的），指过去就是条死路。
        : '队列里没有处于「失败」状态的条目。若这些页面是被豆瓣挡住的（软封锁），'
          + '那不算失败——它们会等到下一次抓取再试，现在重试只会更快撞上限流。',
    );
    return;
  }
  clearActionError();
  refresh();
}

/**
 * 带着已知缺口收尾。
 *
 * **确认在这里做，不在调用方。** 原来只有失败清单里那个按钮弹确认，于是任何
 * 别处调它都会静默地把档案定稿——而这是一个会写进 manifest、影响下次水位线的
 * 决定。放在函数里，就不存在「某个入口忘了确认」这回事。
 *
 * @param {Array<object>} [leaves]  拿得到清单就列出来给人看；拿不到就说得笼统些
 */
async function finishWithGaps(leaves) {
  const lines = leaves?.length
    ? [
      `确认收尾？${leaves.length} 个页面会作为已知缺口记进档案。`,
      '',
      ...leaves.slice(0, 8).map((f) => `· ${f.url}`),
      leaves.length > 8 ? `…另有 ${leaves.length - 8} 个` : '',
    ]
    : ['确认收尾？抓不下来的页面会作为已知缺口记进档案。'];
  lines.push(
    '',
    '档案会标成「已完成」，但每一处缺口都会如实写进 manifest，',
    '受影响路线的水位线不会推进——下次抓取仍会从旧下界重走。',
  );
  if (!confirm(lines.filter(Boolean).join('\n'))) return;

  const r = await send({ type: 'finishWithGaps' });
  if (!r?.ok) {
    setActionError('收尾失败', r?.error ?? '后台没有给出原因。');
    return;
  }
  refresh();
}

/**
 * 停下来之后，顶部那一行该给哪些按钮。
 *
 * ## 为什么不能只靠下面那张失败清单
 *
 * `failures_pending` 这个状态**刻意不给「继续」按钮**——该做的决定是「重试」还是
 * 「就这样收尾」，而那两个按钮在失败清单里。道理是对的，可结果是：屏幕顶端只剩
 * 一个「中止这次抓取」，而真正该点的东西在一百多行表格的**下面**。
 *
 * 用户的原话是「继续按钮没了，只剩中止」——也就是说，从顶端看这就是一条死路。
 * 一个只提供「放弃」的界面，会把人推向放弃。
 *
 * 所以把同样的两个动作也放到顶部。它们指向同一个函数，不是另一套逻辑。
 *
 * @param {Array<object>} failures
 * @returns {Array<[string, () => void] | [string, () => void, string]>}
 */
function failureActions(failures) {
  if (!failures?.length) return [];
  const ordered = failures.filter((f) => f.ordered);
  /**
   * **按钮上要写「继续」，因为它真的会继续。**
   *
   * `retryFailed` 把失败条目翻回 pending 之后会调 `drive()`——也就是说它不只重试
   * 这几个，而是把整场抓取推下去。原来只写「重试这 N 个」，用户（重载扩展之后）
   * 会以为还得先找一个「继续」按钮；而在**暂停**状态下更糟：那里「继续」与「重试」
   * 并排摆着，标签不说的话看不出后者也会继续。
   *
   * 顺序是「继续」在前：意外的那一半应该先说。
   */
  /** @type {Array<any>} */
  const acts = [[`继续，并重试这 ${failures.length} 个`, retryFailures]];
  // 有分页失败就不给「就这样收尾」：跳过它等于免掉水位线赖以成立的前提，
  // 那不是用户能授权的事。与失败清单里的判断保持一致。
  if (!ordered.length) acts.push(['就这样收尾', () => finishWithGaps(failures)]);
  return acts;
}

/**
 * 「继续」。
 *
 * ## 失败必须说出来
 *
 * 这两处原来是 `await send({ type: 'resume' })` 然后 `refresh()`——**返回值一眼
 * 都没看**。而 `send()` 从不抛异常，它把失败包成 `{ok:false, error}` 返回。于是
 * 后台拒绝恢复时（比如上一段抓取卡死、锁没放），界面上**什么都不会发生**：
 * 按钮按下去、刷新一遍、还是原样。用户唯一能得到的信息是「点了没反应」，而
 * 真正的原因就在那个被丢掉的 `error` 字段里。
 *
 * 「开始」和「中止」都查了 `r.ok`，只有「继续」没查——这类不一致最容易漏，
 * 因为它不报错，只是安静。
 */
async function resumeCrawl() {
  // 恢复要好几秒（修段尾 + 确认登录状态，都是真请求），先给个兜底状态——
  // 否则点下去到几秒后之间界面一动不动，看起来像没反应。
  pendingCommand = '恢复抓取';
  refresh();
  let r;
  try {
    r = await send({ type: 'resume' });
  } finally {
    pendingCommand = null;
  }
  if (!r?.ok) {
    setActionError('无法继续', r?.error ?? '后台没有给出原因。');
    return;
  }
  clearActionError();
  refresh();
}

async function abortCrawl(bundleId) {
  const st = await send({ type: 'status' });
  const r = st?.runner ?? {};
  const done = r.counts?.done ?? 0;

  const lines = [
    `中止抓取（档案 ${bundleId}）？`,
    '',
    `已抓取的 ${done} 项将全部保留，可正常查看与导出。`,
    '',
    '但本次抓取将无法继续——如需接着抓，只能重新发起一次。',
    '（下一次为增量抓取，仅抓取新增部分，不会从头开始。）',
    '',
    '中止后，该档案即可删除。',
  ];
  if (!confirm(lines.join('\n'))) return;

  setState('idle', '正在中止…', '当前这一页抓完就停，然后写出档案。');
  const res = await send({ type: 'abort' });
  if (!res?.ok) setActionError('中止失败', res?.error ?? '后台没有给出原因。');
  // 存储与档案页都变了
  invalidateSummary();
  invalidateStorageUsage();
  refresh();
  await refreshOpenTab();
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
    ['incremental', '增量抓取（推荐）',
      '接续上次的进度：列表仅抓取新增部分，作品详情页仅抓取本次新出现的条目。耗时最短。'],
    ['full', '全量抓取',
      '视同从未抓取过，将重新建立一份基准档案。适用于上次抓取存在缺口或结果不可信的情形。'],
    ['refresh-subjects', '增量抓取，并重新抓取全部作品详情页',
      '列表仍仅抓取新增部分，但会重新抓取每一个作品详情页，用于获取评分、短评等'
      + '可变内容的最新版本。该路线占档案约九成体积，耗时显著增加。'],
  ]);

  for (const [key, label, why] of opts) {
    const row = document.createElement('label');
    row.className = 'stack-row';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'crawl-mode';
    radio.checked = crawlMode === key;
    radio.onchange = () => { crawlMode = key; renderCrawlMode(); refresh(); };
    const b = document.createElement('b');

    b.textContent = ` ${label} `;
    const note = document.createElement('span');
    note.className = 'muted';
    note.className = note.className ? `${note.className} small` : 'small';
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
    return '全量抓取（已选择）：视同从未抓取过，将重新建立一份基准档案';
  }
  const n = inc?.routes?.length ?? 0;
  const subjects = crawlMode === 'refresh-subjects'
    ? '作品详情页将全部重新抓取（已选择）'
    : '作品详情页仅抓取本次新出现的条目';
  if (n === 0) {
    return `全量抓取（自最新一直抓取至最早）：尚无可供接续的档案，或上次抓取未完成。${subjects}`;
  }
  return `增量抓取：${n} 条路线可接续上次的进度（仅抓取新增部分），其余路线仍从最新开始。${subjects}`;
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

  // **先说「为什么」，再列「哪些」。**
  //
  // 139 行里前 30 行长得一模一样，那张表回答不了唯一要紧的问题：它们是**同一个**
  // 原因还是一百多个原因？前者说明有个系统性的毛病该修，后者说明是零星的网络抖动
  // ——两者的下一步动作完全不同，而逐行去读是看不出来的。
  //
  // 实测就栽在这儿：123 个封面全军覆没，界面上只能看到 30 行相同的 URL。
  const byReason = new Map();
  for (const f of failures) {
    const k = f.lastError ?? '（没有记下原因）';
    byReason.set(k, (byReason.get(k) ?? 0) + 1);
  }
  if (byReason.size > 0) {
    const why = document.createElement('div');
    why.className = 'card';
    const t = document.createElement('b');
    t.textContent = byReason.size === 1 ? '失败原因（全部相同）' : `失败原因（${byReason.size} 种）`;
    why.append(t);
    const ul = document.createElement('ul');
    for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      const li = document.createElement('li');
      li.textContent = `${n} 个 · ${reason}`;
      ul.append(li);
    }
    why.append(ul);
    el.append(why);
  }

  el.append(table(
    ['页面', '路线', { text: '试过', num: true }, '错误'],
    // **最近失败的排前面。** 原来取数组前 30 个，而队列是按入队顺序排的——于是
    // 表上永远是最早那批，刚刚发生的失败一个都看不见。而人来看这张表，通常正是
    // 因为刚刚又失败了一批。
    failures.slice(-30).reverse().map((f) => [
      { text: f.url.replace(/^https?:\/\//, ''), muted: false },
      routeName(f.routeKey) + (f.ordered ? '（分页）' : ''),
      { text: String(f.attempts), num: true },
      { text: f.lastError ?? '—', muted: true },
    ]),
  ));
  if (failures.length > 30) {
    const more = document.createElement('div');
    more.className = 'muted';
    more.textContent = `另有 ${failures.length - 30} 个较早的未列出（上表按最近失败排序）`;
    el.append(more);
  }

  const acts = document.createElement('div');
  const retry = document.createElement('button');
  retry.className = 'act';
  // 与顶部那个按钮同一句话——它们调的是同一个动作，措辞不同会让人以为是两件事。
  retry.textContent = `继续，并重试这 ${failures.length} 个`;
  retry.onclick = async () => {
    retry.disabled = true;
    retry.textContent = '正在重试…';
    await retryFailures();
  };
  acts.append(retry);

  // **只有全是叶子失败时才给这个按钮。** 有分页失败还放开它，等于让用户点一下就
  // 免掉水位线赖以成立的前提——那不是他能授权的事。
  if (!ordered.length) {
    const accept = document.createElement('button');
    accept.className = 'act';
    accept.textContent = '就这样收尾';
    accept.onclick = async () => {
      accept.disabled = true;
      await finishWithGaps(leaves);
      accept.disabled = false;
    };
    acts.append(accept);
  }
  el.append(acts);
}

/**
 * 把这一页的视图状态清回「刚打开面板」的样子。
 *
 * 拆分之前这件事是**隐式**的：整个面板就是一个模块，模块被加载 = 面板被打开，
 * 于是模块级变量天然是新的。拆成十个模块之后这个等号不再成立——壳可以重新跑，
 * 而各页的模块实例还在，上一次的 `preflightShown` 之类会跟着留下来。
 *
 * 所以现在由 `panel.js` 的启动段显式调用。生产环境里它每次都作用在全新的状态上，
 * 是个空操作；而测试里同一个进程要反复开面板，靠的就是它。
 */
export function resetOverview() {
  preflightShown = false;
  lastRunShown = false;
  pendingCommand = null;
  actionError = null;
  setLastStatus(null);
  routeRows.clear();
}
