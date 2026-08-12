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
import { bundleIdFromDirName } from '../../core/ids.js';

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
  // 下面三条 `*_skipped` 是这个日志里**唯一**能看见「没做什么」的地方。
  // 跳过不产生任何捕获行，所以不写在这儿的话，用户手上没有第二个办法知道它发生过
  // ——而「它是不是漏抓了」恰恰是这个工具最该回答清楚的问题。
  if (e.type === 'subjects_skipped') {
    return `跳过了 ${e.count} 个已经抓过的作品详情页。想重新抓一遍的话，`
      + '开抓前选「增量抓取，并重新抓取可以编辑的内容」。';
  }
  if (e.type === 'subjects_refresh') {
    return `把 ${e.count} 个作品详情页排进了队，会重新抓一遍。`;
  }
  if (e.type === 'longform_skipped') {
    return `跳过了 ${e.count} 篇已经抓过的日记/影评正文。`
      + '它们是可以编辑的，想看看改没改过的话，开抓前选'
      + '「增量抓取，并重新抓取可以编辑的内容」。';
  }
  if (e.type === 'longform_refresh') {
    return `把 ${e.count} 篇日记/影评正文排进了队，会重新抓一遍。`;
  }
  if (e.type === 'assets_skipped') {
    // **要说明它为什么不是一个选项**，否则下一个问题必然是「那我怎么重抓图」。
    return `跳过了 ${e.count} 张已经抓到的图。图片地址是内容地址——同一个地址重抓`
      + '拿回来的是同一批字节，改了图会换成新地址，所以这一档没有「重抓」的选项。'
      + '要重建一份自足的档案请选「全量抓取」。';
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
 * 把 OPFS 里每份档案的文件清单与 manifest 读一遍。
 *
 * ## 为什么是一处而不是两处
 *
 * 档案清单与存储占用原来各扫一遍：一个为了「哪一份、什么时候抓的、多少条」，
 * 一个为了「多大、导出过没有」。两遍读的是同一批目录、同一批文件大小，而档案
 * 页与存储页合成一页之后，那就是**打开一次页面扫两遍盘**——8 份档案 7000 多个
 * 文件，每个都要一次 `size()` 往返 Worker。
 *
 * 更要紧的是第二个理由：两处扫描就是两处要各自记得失效。删掉一份档案之后忘了
 * 让其中一处失效，界面上就会同时出现「7 份」和「8 份」，而没有任何东西会报错。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]  抓完、删完、导入完之后要用
 * @returns {Promise<Array<{bundleId: string, dir: string,
 *   files: Array<{name: string, bytes: number}>, manifest: object | null}>>}
 */
let bundleScan = null;
export async function scanBundleDirs({ force = false } = {}) {
  if (bundleScan && !force) return bundleScan;

  const worker = getOpfsWorker();
  const dirNames = await WorkerFileStore.listBundleDirs(worker);
  const out = [];
  for (const dir of dirNames) {
    const bundleId = bundleIdFromDirName(dir);
    if (!bundleId) continue;
    const store = new WorkerFileStore({ worker, dir });
    const files = [];
    for (const name of await store.list()) files.push({ name, bytes: await store.size(name) });

    // 读不出 manifest 的档案**照样列出来**——那种恰恰最需要能被选中（用户要去看
     // 它出了什么事）。因元数据缺失而让它从列表里消失是最糟的处理。
    let manifest = null;
    try {
      manifest = JSON.parse(new TextDecoder().decode(await store.read('manifest.json')));
    } catch { /* 没收尾，或者坏了。两种都由调用方按 null 处理 */ }

    out.push({ bundleId, dir, files, manifest });
  }
  bundleScan = out;
  return out;
}

export function invalidateBundleScan() {
  bundleScan = null;
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
/**
 * 存储变了。
 *
 * **连目录扫描一起作废**，因为「存储变了」的每一种发生方式都会改变目录清单：
 * 抓完一次多一个目录、导入多几个、删除少几个。只清用量不清扫描的话，档案页左边
 * 那份清单里就**看不见刚抓完的那一份**——而那正是用户此刻要去导出的东西。
 */
export const invalidateStorageUsage = () => { storageUsage = []; bundleScan = null; };

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

/**
 * 把这一层的模块级状态清回「刚打开面板」的样子。
 *
 * ## 为什么连 Worker 句柄也要清
 *
 * 各页都有自己的 `reset*()`，理由是「模块被加载 = 面板被打开」这个等号在拆分之后
 * 不再成立。但**底座自己也有状态**，而它当时漏了：`opfsWorker` 一旦建起来就一直
 * 挂在这里，`bundleScan` 同理。
 *
 * 生产环境里那没关系（一个页面一个 Worker，本来就该复用）。而在测试里，它意味着
 * 第二次打开面板拿到的是**上一次那个 Worker**——于是断言看到的是上一个用例的档案。
 * 实测就是这样：一个「一份档案都没有」的用例，读出来「1 份 · 401 B」。
 *
 * 那不只是测试的麻烦：一份没人负责清的模块级句柄，本身就是「这段状态归谁」说不清
 * 的信号，而拆分正是为了让这件事说得清。
 */
export function resetShared() {
  opfsWorker = null;
  bundleScan = null;
  storageUsage = [];
  lastStatus = null;
}
