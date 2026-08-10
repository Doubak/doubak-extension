/**
 * 面板各页共用的那一小把东西：取 DOM、发命令、格式化、几张「界面上怎么说」的表。
 *
 * **它不认识任何一个标签页。** 依赖方向是单向的：各页都 import 它，它谁也不 import。
 * 这条一破，拆分就白做了——那时它只是换了个名字的 panel.js。
 * `test/ui-modules.test.js` 守着这一条。
 */

import { NOT_PART_OF_BUNDLE, inspectDestination } from '../../bundle/exporter.js';
import { routeName } from '../route-names.js';
import { WorkerFileStore } from '../../storage/worker-file-store.js';

export const $ = (id) => document.getElementById(id);

/** @param {object} msg */
export function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) =>
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r),
    );
  });
}

/** 界面上不出现内部术语。 */

/** 档案状态。界面上不出现 `in_progress` 这种内部标识。 */
export const STATUS_NAMES = {
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
export function eventNote(e) {
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
  if (e.type === 'backlog_queued') {
    // **这个数字必须露出来。** 增量抓取的心理预期是「只抓新增的」，突然多出上百个
    // 请求，不解释的话看起来像跑飞了。而这些请求恰恰是最该发的那批。
    return `从已经存下来的旧页面里算出 ${e.count} 张以前没抓的图（你自己上传的），`
      + '这次一并补上。它们的来源页不需要重抓。';
  }
  if (e.type === 'extractor_stale') {
    // **这是豆瓣改版的第一个征兆。** 两个独立信号对不上：条目容器说这页有 N 条，
    // 而按 URL 形状抽却一条都没有。不说的话它是安静的——停滞检测会判「没进展」然后
    // 停在第 3 页，而 contiguous 还报 ✔ 已验证。
    const what = e.missing === 'ids' ? '条目' : '时间';
    return `${routeName(e.routeKey)}：这一页看得见 ${e.containerCount} 个条目，`
      + `却一个${what}都抽不出来——多半是豆瓣改了页面结构。页面本身已经原样存进档案，`
      + '改好抽取器重跑就能补回来，不用重抓。';
  }
  if (e.type === 'backlog_unresolved') {
    return `一条旧广播里认出了配图容器，却一张都取不出来（${e.count} 处）——`
      + '多半是豆瓣改了页面结构。这一页已经在档案里，改好抽取器后下次会自动补上。';
  }
  return null;
}

export const GAP_REASONS = {
  aborted: '抓取中途停下了，这条线还有没抓完的页',
  fetch_failed: '有页面反复抓不下来',
  blocked: '被豆瓣限制了',
  challenge: '豆瓣要求验证',
  session_expired: '登录状态失效了',
  user_paused: '你手动暂停了',
  user_aborted: '你中止了这次抓取',
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
export const BUSY_COPY = {
  开始抓取: ['正在确认账号…', '要先抓一次个人主页取到数字用户 ID，并确认登录状态。这一步也走正常的请求节奏，可能要几秒。'],
  恢复抓取: ['正在恢复…', '要先修好上次没写完的段尾，再确认登录状态还在。'],
  演练: ['正在演练…', '零网络请求，只走一遍真实链路。'],
  抓取: ['正在抓取…', ''],
};

export const VERDICT_NAMES = {
  ok: '正常',
  blocked: '被限制',
  challenge: '要验证',
  login: '未登录',
  gone: '已不存在',
  soft404: '页面不存在',
};

/**
 * 一条捕获该显示成什么。
 *
 * ## 为什么不能直接查 `VERDICT_NAMES[verdict]`
 *
 * 规范的 `verdict` 是封闭词表，里面**没有「判不出来」这个取值**。而抓取时判不出来
 * 的响应必须留证、又绝不能标成 ok，于是写入时用了 `cls.verdict ?? 'blocked'`
 * （见 loop.js）——真相退到了 `note` 里，写着「判不出来：一个内容区块都没有…」。
 *
 * 保守方向是对的，但**界面照抄 verdict 就把两件很不一样的事说成了同一件**：
 *
 *   被限制    豆瓣主动拒绝了 → 该等一等，再抓可能撞限流
 *   判不出来  页面拿到了，只是我们不认识 → 多半是选择器该校准了，重抓没用
 *
 * 用户看到「被限制」会去等、去重试；而真正该做的是改抽取器。实测撞到过：一篇
 * `/topic/` 日记因为没有对应的框架标志判不出来，界面上却写着「被限制」。
 *
 * @param {{verdict?: string, note?: string}} e
 */
export function verdictName(e) {
  if (e?.verdict === 'unknown' || e?.note?.startsWith('判不出来')) {
    // 原因决定该怎么办，所以能说就说出来（bundle/1.2 起 index 里有 verdict_reason；
    // 更早的档案只有 note，读 note 兜底——两种都要认，档案是冻结的）。
    const why = REASON_NAMES[e?.verdict_reason];
    return why ? `判不出来 · ${why}` : '判不出来';
  }
  return VERDICT_NAMES[e?.verdict] ?? e?.verdict ?? '判不出来';
}

/**
 * `verdict_reason` → 一句人话，**说的是「该怎么办」而不是「哪里不对」**。
 *
 * 用户看到判定之后要做决定，而决定只有三种：等一等重抓、改抽取器、先看一眼。
 * 原因分类就是按这个分的（规范 §6.3.1 的 remedy_classes）。
 */
const REASON_NAMES = {
  empty_body: '空响应，可以重抓',
  server_error: '豆瓣出错了，可以重抓',
  frame_anchors_missing: '页面结构变了，重抓没用',
  not_an_image: '拿到的不是图片，重抓没用',
  url_drifted: '被跳到别处了',
  unexpected_status: '没见过的状态码',
  malformed_url: '地址解析不了',
};

/**
 * 上次导出到哪儿了。
 *
 * 只为了**把话说准**：「已经有 12 个文件，覆盖吗」和「12 个已经完整、还差 8 个，
 * 只补这 8 个」是完全不同的两句话，而后者才是实情。前者会让人以为要重来一遍。
 *
 * @param {{store: object, sink: object}} opts
 */
export async function countAlreadyExported({ store, sink }) {
  const all = await store.list();
  const files = all.filter((f) => !NOT_PART_OF_BUNDLE.has(f));
  let expected = new Map();
  try {
    const manifest = JSON.parse(new TextDecoder().decode(await store.read('manifest.json')));
    for (const seg of manifest.segments ?? []) {
      if (seg.filename && seg.sha256) expected.set(seg.filename, seg.sha256);
    }
    if (manifest.index?.filename && manifest.index?.sha256) {
      expected.set(manifest.index.filename, manifest.index.sha256);
    }
  } catch { expected = new Map(); }

  const got = await inspectDestination({ store, sink, files, expected });
  let ok = 0; let okBytes = 0;
  for (const v of got.values()) if (v.ok) { ok += 1; okBytes += v.bytes; }
  return { ok, okBytes, total: files.length, missing: files.length - ok };
}

/** @param {number} n */
export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 建一个表格。 */
export function table(headers, rows) {
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

/*
 * 读 OPFS 的那个 Worker，**整个面板共用一个**。
 *
 * 它本来长在档案页里，而导出页、存储页、概览页都伸手去拿——那是「这段代码其实
 * 不属于那一页」的信号。放这里之后依赖方向才是干净的：三页各自 import 它，
 * 而不是 import 档案页。
 */
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
export function getOpfsWorker() {
  if (!opfsWorker) {
    opfsWorker = new Worker(chrome.runtime.getURL('src/storage/opfs-worker.js'), {
      type: 'module',
    });
  }
  return opfsWorker;
}

/**
 * 存储用量的缓存。
 *
 * **存储页渲染它，而概览页与导出页只是让它失效**——三页都在动的东西不属于其中任何
 * 一页。放回哪一页都会造出一条反向依赖：实测把它留在存储页，就出现了
 * `overview → storage → overview` 的环，而拆分本来就是为了让「谁依赖谁」说得清。
 * @type {object[]}
 */
let storageUsage = [];
export const getStorageUsage = () => storageUsage;
/** @param {object[]} rows */
export const setStorageUsage = (rows) => { storageUsage = rows; };
export const invalidateStorageUsage = () => { storageUsage = []; };

/**
 * 后端最近一次报的抓取状态。
 *
 * 概览页每两秒刷新它，而档案页与存储页读它——「这一份是不是正在被写」决定了能不能
 * 删、能不能导。**三页都要，同样不属于其中任何一页**：留在概览页会造出
 * `archive → overview → archive` 的环（实测）。
 * @type {object | null}
 */
let lastStatus = null;
export const getLastStatus = () => lastStatus;
/** @param {object | null} s */
export const setLastStatus = (s) => { lastStatus = s; };
