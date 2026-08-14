/**
 * 抓取的真正执行者。
 *
 * 设计：DESIGN.md F-10a/d
 *
 * ## 为什么抓取跑在这里，而不是 service worker 里
 *
 * 一句话：**字节过不去。**
 *
 * OPFS 的原地写入只能用 `createSyncAccessHandle()`，而它只在**专用 Worker**
 * 里可用——service worker 不是专用 Worker。所以 service worker 自己写不了档案，
 * 必须把写操作转发给某个能起专用 Worker 的上下文。
 *
 * 转发就要过界，而两条通道的能力差得很远：
 *
 * | 通道 | 能传 `Uint8Array` 吗 |
 * |---|---|
 * | `chrome.runtime.sendMessage`（SW ↔ offscreen） | **不能**，只认 JSON。字节会变成 `{"0":1,"1":2,…}` |
 * | `Worker.postMessage`（offscreen ↔ 专用 Worker） | 能，结构化克隆，还能转移所有权不复制 |
 *
 * 如果只把「写文件」这一步搬过来，每条 WARC 记录都要在 SW ↔ offscreen 之间过
 * 一次 JSON——几十万条记录、几百 MB，全部走 base64 或者数组字面量。那不是慢，
 * 是荒谬。
 *
 * 所以**整条抓取链**搬进来：fetch、分类、WARC 组装、gzip、落盘全在这一侧，
 * 字节一步都不跨那条只认 JSON 的通道。service worker 退回它唯一擅长的事——
 * **拿着闹钟**。
 *
 * ## 分工
 *
 * | | service worker | offscreen document |
 * |---|---|---|
 * | 闹钟心跳、跨重启存活 | ✓ | ✗（它自己起不来） |
 * | 决定该不该恢复 | ✓ | |
 * | fetch、判定、写档案 | ✗（写不了） | ✓ |
 * | 被浏览器随时杀掉 | 约 30 秒空闲 | 相对稳定，但不保证 |
 *
 * service worker 起不来 offscreen 以外的任何长命上下文，而 offscreen 拿不到
 * 跨浏览器重启的唤醒。两边都不完整，合起来才够。
 *
 * ## 它被关掉也不要紧
 *
 * offscreen document 比 service worker 稳，但不保证不死。而这**与设计一致**：
 * 每写一页就落一次 checkpoint，所以被关掉等价于一次可恢复的空操作。下一次闹钟
 * 会把它重新拉起来并从断点继续——和 service worker 被杀走的是同一条路。
 *
 * 换句话说，这里没有引入新的失败模式，只是把已有的那个搬了个地方。
 *
 * ## 这里能用哪些 chrome API
 *
 * offscreen document 虽然是扩展页面，可用的扩展 API 却只有一小部分：
 *
 * | API | 在这里 | 后果 |
 * |---|---|---|
 * | `chrome.runtime`（消息、getURL） | ✓ | 命令与事件都靠它 |
 * | `chrome.storage` | **✗** | 所以抓取状态存 IndexedDB（`IdbKvStore`），那是普通 DOM API，不是 `chrome.*` |
 * | `chrome.permissions` | **✗** | 传输层的权限兜底在这里查不了，会返回 `null`（「查不了」而不是「有权限」）。主动那道 `permissions.onRemoved` 在 service worker 里，仍然有效 |
 * | `chrome.notifications` | **✗** | 通知一律由 service worker 发 |
 * | `chrome.runtime.getManifest()` | **✗** | 官方原话是「只暴露 `chrome.runtime` 的**消息** API」，它不在其中。版本号改为直接 `fetch` 那个文件（`core/version.js`） |
 * | `fetch`（带 host 权限与 cookie） | ✓ | 抓取靠它 |
 *
 * 「哪个上下文有哪个 API」是 MV3 里最容易踩空的一类知识，而踩空的样子往往是一句
 * 与真实原因毫无关系的错误信息。所以列在这里。
 *
 * **这张表现在是可执行的**：`test/offscreen-contract.test.js` 顺着这个文件的 import
 * 图，把每个 `chrome.<命名空间>.<成员>` 调用点对照白名单查一遍。加这条测试的直接
 * 原因是 `getManifest` 那一行——它在面板里是好的，在 node 测试里根本不走，
 * 于是一路进了主干，装上之后一按「开始抓取」就抛。光写在注释里的规则挡不住这个。
 */

import { CrawlRunner } from '../crawl/runner.js';
import { RunStore } from '../crawl/run-store.js';
import { createDrive, driveWithinBudget } from '../crawl/driver.js';
import { MemoryKvStore } from '../storage/kv-store.js';
import { IdbKvStore } from '../storage/idb-kv-store.js';
import { appendEvent } from '../crawl/event-log.js';
import { WorkerFileStore } from '../storage/worker-file-store.js';
import { dryRunFetch } from '../crawl/dry-run.js';
import { OFFSCREEN_TARGET } from './protocol.js';
import { BundleReader } from '../bundle/bundle-reader.js';
import { bundleIdFromDirName, bundleDirName } from '../core/ids.js';
import { makeDebugLog, loadDebugFlag } from '../core/debug-log.js';
import { backlogFromIndex, capturedAssets } from '../crawl/backlog.js';
import {
  chainEntryFromManifest, pickFloors, floorsFor, newestFirst, renamedBundles,
  chainCoverage, findChainHoles, diffAgainstChain, splitChains, bundlesForAccount,
  chainOf,
} from '../crawl/chain.js';
import { CRAWL_MODES } from '../crawl/crawl-modes.js';
import {
  emptyKnownCaptures, addKnownCaptures, knownCaptureLists,
} from '../crawl/known-captures.js';

// 详细日志。默认关，见 core/debug-log.js。前缀要与 service worker 区分开——
// 两边的日志混在同一个控制台里，没有前缀就分不清是谁说的。
const debugLog = makeDebugLog('[doubak/offscreen]');

/**
 * 落盘用的专用 Worker。
 *
 * 惰性建、建了就留着——每次抓取都重开一个 Worker 是白付启动开销，而这个页面
 * 本来就是为了长命才存在的。
 *
 * @type {Worker | null}
 */
let opfsWorker = null;
function getOpfsWorker() {
  if (!opfsWorker) {
    opfsWorker = new Worker(chrome.runtime.getURL('src/storage/opfs-rw-worker.js'), {
      type: 'module',
    });
  }
  return opfsWorker;
}

/**
 * 增量抓取：从既有档案里挑每条路线的下界。
 *
 * 规范 §5.5，判断逻辑全在 `src/crawl/chain.js`（纯函数，可测）。这里只负责把
 * manifest 读进来。
 *
 * **由 runner 在身份确认之后回调**：判据是数字用户 ID（档案的归属主键），而它只有
 * preflight 之后才知道。
 *
 * **读不出来就退回全量。** 少抓是不可接受的，多抓只是慢——所以这一路上任何一处
 * 出问题（目录没了、manifest 坏了、账号对不上），结论都是「没有下界」。
 *
 * @param {{userId: string | null}} account  preflight 确认的账号
 * @returns {Promise<{floors?: Map<string, string>, floorSources?: Map<string, string>, previousBundleId?: string | null}>}
 */
/**
 * **这个账号名下所有档案里**已经抓成功的东西，按「重抓有没有意义」分三档。
 *
 * ## 为什么是「所有档案」，不是「这条链」
 *
 * 第一版按链算，那是错的，而且错得很贵：链回答的是**时间连续性**——「从今天往回
 * 一直到 X 没有断」。而这里要回答的是另一个问题：**这一页我是不是已经有了**。
 * 有就不必再抓。那与它是哪一次抓的、属不属于同一条链，一点关系都没有。
 *
 * 按链算的后果在真实使用里立刻就出来了：`previous_bundle_id` 为 null 的档案各自
 * 成链，于是「最新那条链」常常只有一份档案——如果那一份恰好是刚跑了一小段的增量
 * （比如只抓到 18 个详情页），那么**此前几千个详情页全都不认识了**，下一次增量把
 * 它们重抓一遍。用户看到的是「我只加了一本想读的书，它却在抓游戏」。
 *
 * ## 分档规则不在这里
 *
 * 三档怎么分、为什么图那一档没有「重抓」这个选项，全在 `crawl/known-captures.js`
 * ——那是个纯函数，能在 node 里真的跑一遍。这里只做接线：开目录、读索引、
 * 一份读不出来就跳过那一份。与 `backlog.js` 是同一个分层理由。
 *
 * @param {import('../crawl/chain.js').ChainEntry[]} entries  同一个账号的全部档案
 * @returns {Promise<{subjects: string[], longform: Array<{url: string, routeKey: string}>, assets: string[]}>}
 */
async function knownCaptures(entries) {
  const acc = emptyKnownCaptures();
  for (const e of entries) {
    try {
      const store = new WorkerFileStore({ worker: getOpfsWorker(), dir: bundleDirName(e.bundleId) });
      const reader = new BundleReader({ store, bundleId: e.bundleId });
      addKnownCaptures(acc, await reader.index());
    } catch (err) {
      // 读不出来就当没有——**多抓不可接受的相反面**：这里漏认只会让它多抓一遍，
      // 而那是安全的方向。
      debugLog('读不出这份索引，里面的东西会重抓', e.bundleId, err);
    }
  }
  return knownCaptureLists(acc);
}

/**
 * 从已经存下来的广播页里补算出当时没抓的附图。
 *
 * ## 为什么需要
 *
 * `asset.status_photo` 是从广播页派生的，而广播是增量路线——下次只取回水位线以上的
 * 新页面。**水位线以下那些永远不会再被请求**，于是在这条路线存在之前发布的广播，
 * 它们的附图就此成为死角（实测 121 张，分布在 22 张老广播页上）。
 *
 * 但那些页面的字节就在档案里。所以补的办法是**重算**，不是重抓：121 个图片请求，
 * 零个页面请求。对比重设水位线全量重走（175 个页面请求 + 把广播的连续性证明推倒重来）。
 *
 * ## 与 `knownSubjects` 是一对
 *
 * 同样按**账号**取而不按链取（图片没有时间序，链对它毫无意义），同样跳过读不出来的
 * 档案。区别只在于：那个算「哪些已经有了」，这个算「哪些一直欠着」。
 *
 * 真正的逻辑在 `crawl/backlog.js`，是纯函数、能拿真实档案的数据测。这里只做接线：
 * 开目录、读索引、把解压动作注进去。
 *
 * @param {import('../crawl/chain.js').ChainEntry[]} entries  同一个账号的全部档案
 * @param {string} ownerUserId
 * @returns {Promise<import('../crawl/backlog.js').BacklogItem[]>}
 */
async function backlogAssets(entries, ownerUserId) {
  if (!ownerUserId) return [];

  /** @type {Array<{reader: object, rows: object[]}>} */
  const opened = [];
  /** @type {Set<string>} */
  const have = new Set();

  for (const e of entries) {
    try {
      const store = new WorkerFileStore({ worker: getOpfsWorker(), dir: bundleDirName(e.bundleId) });
      const reader = new BundleReader({ store, bundleId: e.bundleId });
      const rows = await reader.index();
      opened.push({ reader, rows });
      // 先把「已经抓到的」全部收齐，再去算欠的——否则先扫到的那份档案会把后面
      // 档案里已经抓过的图重新排一遍。
      for (const u of capturedAssets(rows)) have.add(u);
    } catch (err) {
      // 读不出来就当没有。**失败方向是安全的**：漏认只会让这次少补几张，而这一步
      // 每次抓取都跑，下次还会再算。抛出去则会让整场抓取起不来。
      debugLog('读不出这份索引，存量图这次不补', e.bundleId, err);
    }
  }

  /** @type {import('../crawl/backlog.js').BacklogItem[]} */
  const all = [];
  let pages = 0;
  for (const { reader, rows } of opened) {
    const { items, pagesRead } = await backlogFromIndex({
      indexRows: rows,
      readPayload: async (row) => (await reader.readEntry(row)).bodyText,
      ownerUserId,
      alreadyHave: new Set([...have, ...all.map((x) => x.url)]),
      // 改版告警必须往外传：离线跑和在线跑是同一个抽取器，
      // 「认出了容器却一张没抽到」在哪边发生都是同一件事。
      onWarn: (evt) => relayEvent(evt),
    });
    all.push(...items);
    pages += pagesRead;
  }

  if (all.length > 0 || pages > 0) {
    debugLog(`存量补抓：读了 ${pages} 张已存的广播页，算出 ${all.length} 张还没抓的图`);
  }
  return all;
}

async function readChainEntries() {
  const dirs = await WorkerFileStore.listBundleDirs(getOpfsWorker());
  /** @type {import('../crawl/chain.js').ChainEntry[]} */
  const entries = [];
  for (const dir of dirs) {
    const id = bundleIdFromDirName(dir);
    if (!id) continue;
    try {
      const store = new WorkerFileStore({ worker: getOpfsWorker(), dir });
      const reader = new BundleReader({ store, bundleId: id });
      // 没收尾的没有 manifest，也就没有连续性证明——它不能当基准。
      if (!(await reader.hasManifest())) continue;
      entries.push(chainEntryFromManifest(await reader.manifest()));
    } catch (e) {
      debugLog('读不出这份档案，跳过', dir, e);
    }
  }
  return entries;
}

/**
 * 挑增量的下界，并顺带准备几样锦上添花的东西。
 *
 * ## 「退回全量」不是免费的
 *
 * 这段代码原来整个包在一个 try 里：下界挑好了，但后面 `knownSubjects` 或
 * `backlogAssets` 任何一处抛了，就一起退回全量。**实测代价**：一次本该几分钟的
 * 增量变成 4 小时、5880 条捕获的全量，而且——
 *
 * **产出的档案永久地宣称自己是一条链的起点。** `previous_bundle_id` 写成 null
 * 之后没法补：档案是不可逆那一步的产物，跑过就冻结了。于是链在那里断掉，
 * 而后来的人只看到「这里有一次全量」，看不出它本该接在谁后面。
 *
 * 所以现在分开：**下界一旦挑出来就不许再被丢掉**，后面每一样各自兜底。
 * 少一个 backlog 只是这一趟少补几张图（下一趟还会补），而退回全量是几小时
 * 加一处不可逆的元数据损失——两者不是一个量级。
 *
 * ## 退回全量时必须说出来
 *
 * 原来是**完全静默**的：`incrementalOptions` 内部 catch 掉、返回 `{}`，
 * runner 那边看到的是一次「成功但没有下界」的调用，于是既不报
 * `incremental_failed` 也不报 `incremental`。用户看到的现象是「我选了增量，
 * 它跑了四个小时」，而界面上没有任何一句话解释为什么。
 *
 * @param {{userId?: string|null, username?: string|null}} account
 * @param {string} mode
 */
async function incrementalOptions(account, mode = 'incremental') {
  /** 退回全量时，**一定要说清是为什么**。 */
  const fallback = (reason, message) => {
    debugLog('增量：退回全量', reason, message ?? '');
    relayEvent({ type: 'incremental_skipped', reason, message: message ?? null });
    return {};
  };

  let entries;
  try {
    entries = await readChainEntries();
  } catch (e) {
    return fallback('read_failed', String(e?.message ?? e));
  }
  if (entries.length === 0) return fallback('no_bundles');

  // **账号必须对得上。** 别人的档案不能给你当基准：那会让你以为某段时间已经
  // 抓过了，而实际上抓的是别人的。数字 uid 是档案的归属主键。
  const me = {
    accountUserId: account?.userId ?? null,
    accountUsername: account?.username ?? null,
  };

  let picks;
  try {
    picks = pickFloors(entries, me);
  } catch (e) {
    return fallback('pick_failed', String(e?.message ?? e));
  }

  // **改名要说给用户听。** 它会让一次抓取从增量退回全量，而用户看到的现象是
  // 「明明抓过了，怎么又从头来」——不解释的话那看起来就是个 bug。
  try {
    const renamed = renamedBundles(entries, me);
    if (renamed.length) {
      relayEvent({
        type: 'incremental_rebased',
        reason: 'renamed',
        was: renamed[0].was,
        now: me.accountUsername,
        count: renamed.length,
      });
    }
  } catch { /* 只是解释性的提示，失败不该影响这次抓取 */ }

  if (picks.size === 0) return fallback('no_floors');

  debugLog('增量：', [...picks].map(([k, v]) => `${k}←${v.fromBundleId}`).join(' '));
  const newest = newestFirst(entries)[0];

  // ── 到这里下界已经定了，下面每一样都是**锦上添花，各自兜底**。
  const mine = bundlesForAccount(entries, me);

  /** @type {{subjects: string[], longform: Array<{url: string, routeKey: string}>, assets: string[]}} */
  let known = { subjects: [], longform: [], assets: [] };
  try {
    // **按账号取，不按链取。** 「这一页我是不是已经有了」与它属于哪条链无关。
    known = await knownCaptures(mine);
  } catch (e) {
    // 失败的方向是安全的：不知道哪些抓过 = 这一趟三档全抓一遍。
    // 慢，但不丢东西，而且下界还在——这一趟仍然是增量。
    relayEvent({ type: 'incremental_degraded', part: 'known_captures', message: String(e?.message ?? e) });
  }

  let backlog = null;
  try {
    // 存量补抓（规范 §6.2.1）。只在增量路径上有意义：没有下界 = 全量 =
    // 广播会从头重走 = 图现场就派生出来了。
    backlog = await backlogAssets(mine, me.accountUserId);
  } catch (e) {
    // 少补几张图。**下一趟还会补**——backlog 每次抓取都跑，这正是它的设计目的。
    relayEvent({ type: 'incremental_degraded', part: 'backlog', message: String(e?.message ?? e) });
  }

  // 「重抓可变内容」这个模式管两档：作品详情页与长文正文。两档都**不跳过已有的**，
  // 并且把它们直接排进队——只做前者的话，能重抓的只有最新几页列表上派生出来的
  // 那十几个，而选项承诺的是全部。**说到做不到比没有这个选项更糟。**
  const refresh = mode === CRAWL_MODES.REFRESH;

  return {
    floors: floorsFor(picks),
    floorSources: new Map([...picks].map(([k, v]) => [k, v.fromBundleId])),
    previousBundleId: newest?.bundleId ?? null,
    knownSubjectUrlKeys: refresh ? [] : known.subjects,
    refreshSubjectUrls: refresh ? known.subjects : null,
    knownLongformUrlKeys: refresh ? [] : known.longform.map((x) => x.url),
    refreshLongform: refresh ? known.longform : null,
    // **图这一档不跟着模式走，两种增量下都跳过。** 重抓一张已有的图拿回来的必然是
    // 同一批字节（图片地址是内容地址），所以「要不要重抓」在这里根本不是一个选择。
    // 全量不走这条路径（见消息处理里的 `mode === 'full'`）：那是明说要重建一份
    // 自足的基准档案，跳过任何东西都会让它名不副实。
    knownAssetUrlKeys: known.assets,
    backlogAssets: backlog,
  };
}

/** @param {string} dir */
function openBundle(dir) {
  // readOnly:false —— 这是**唯一**一处写 OPFS 的地方。
  return Promise.resolve(new WorkerFileStore({ worker: getOpfsWorker(), dir, readOnly: false }));
}

/** @type {RunStore | null} */
let runStore = null;
function getRunStore() {
  // 用 IndexedDB，**不是** `chrome.storage`（这里拿不到它），也**不是**借道
  // service worker（那会形成一个请求/响应环：SW 正在 await 我们的响应，我们又去
  // await 它。见 idb-kv-store.js 开头）。
  //
  // IndexedDB 在这三种上下文里都能直接用，同源同库，谁都不需要求谁。而且这本来
  // 就是设计里写的（DESIGN.md F-10b）。
  if (!runStore) {
    const kv = new IdbKvStore();
    void loadDebugFlag(kv); // 开关与抓取状态同库，见 core/debug-log.js
    runStore = new RunStore({ kv, openBundle });
  }
  return runStore;
}

/** @type {CrawlRunner | null} */
let runner = null;
function getRunner() {
  if (runner) return runner;
  runner = new CrawlRunner({
    runStore: getRunStore(),
    openBundle,
    onEvent: relayEvent,
  });
  return runner;
}

/**
 * 把抓取事件转给界面。
 *
 * 只转**结构化的小对象**，不转字节——这条通道只认 JSON（见文件开头）。
 *
 * @param {object} e
 */
function relayEvent(e) {
  // **「我还活着」。** 互斥锁靠这个区分「跑得久」和「卡死了」——不吭声超过阈值
  // 就会被抢占。抓取每抓一页都会走到这儿，所以正常情况下永远不会被判死；而真的
  // 卡在某个永不返回的 await 上时，事件也就随之停了。见 crawl/exclusive.js。
  lock.touch();

  debugLog('事件', e.type, e.routeKey ?? e.reason ?? '');
  // 没有界面打开时 sendMessage 会 reject，那是正常的，不是错误。
  chrome.runtime.sendMessage({ type: 'crawl_event', event: e }).catch(() => {});

  // **落盘。** 面板里那个日志原来只是内存数组，一刷新就没了——而排查问题时最想要的
  // 恰好是「上次那次抓取在哪一步停下的」。
  //
  // 只记 index.ndjson 里没有的事件（重试、停机、门控、错误）：成功的捕获那边已经逐条
  // 记了，而且更权威。抄一遍只会把真正稀少的信号淹掉。
  void appendEvent(new IdbKvStore(), e).catch((err) => debugLog('日志写入失败', err));
}

/**
 * 同一时刻只允许一件会发请求的事在跑。
 *
 * 这不是并发整洁问题而是**账号安全**问题：节奏闸门是按活动建的，两件活动各自
 * 遵守「1 秒一个请求」，合起来豆瓣看到的却是 2 秒 3 个。见 crawl/exclusive.js。
 *
 * 抓取全都在这一个 document 里跑，所以这一个锁就够——不需要跨上下文的协调。
 */
const { drive, lock } = createDrive({
  run: ({ stillMine }) => driveWithinBudget({
    runner: getRunner(),
    // 被判死并抢占之后，这一圈在下一个批次边界自己退出——否则它和接管它的那一段
    // 会同时消费一个 frontier。见 driver.js 里那段说明。
    stillMine,
    onEvent: (e) => {
      lock.touch();
      debugLog('驱动', e.type);
    },
  }),
  onPreempt: ({ name, silentMs }) => {
    // 抢占意味着上一段真的卡死了。**必须留下痕迹**——静默夺锁会把「抓取卡了
    // 20 分钟」变成一件谁也不知道发生过的事。
    const msg =
      `上一段「${name}」已经 ${Math.round(silentMs / 1000)} 秒没有任何动静，` +
      '判定为卡死并接管。（常见诱因：抓取途中让电脑睡眠。已抓到的内容都在档案里。）';
    debugLog('抢占', msg);
    relayEvent({ type: 'preempted', reason: 'stale_holder', message: msg, silentMs });
  },
});

/**
 * 演练：真实链路、零网络请求。
 *
 * 用独立的内存 KV，绝不覆盖真实抓取的指针——「调试一下」把用户几小时的进度
 * 弄丢是不可接受的。档案照写进真 OPFS，那正是要验的东西。
 *
 * @param {string} scenario
 */
async function runDryRun(scenario) {
  if (getRunner().active) throw new Error('有真实抓取在进行中，先暂停再演练');

  /** @type {Record<string, number>} */
  const byVerdict = {};

  const r = new CrawlRunner({
    runStore: new RunStore({ kv: new MemoryKvStore(), openBundle }),
    openBundle,
    fetchImpl: dryRunFetch(scenario),
    onEvent: (e) => {
      relayEvent(e);
      if (e.type === 'capture') {
        // 判不出来是 null，而 null 恰恰是最该被看见的一种结果——给它一个名字，
        // 别让它在计数里消失。
        const k = e.verdict ?? 'unclassified';
        byVerdict[k] = (byVerdict[k] ?? 0) + 1;
      }
    },
    // 演练不碰豆瓣，没有降速的理由。Pacer 不接受 0（那会让「有节奏」这件事
    // 本身可以被关掉），所以取 1ms。
    pacerOptions: { intervalMs: 1, jitterRatio: 0 },
  });

  await r.start({ username: 'dryrun', onlyRoutes: ['broadcast.timeline'], includeCatalog: false });

  let captured = 0;
  let failed = 0;
  let stoppedBy = null;
  let unresolved = 0;
  // 上限只是防夹具写错导致死循环的兜底。
  for (let i = 0; i < 40; i++) {
    const b = await r.runBatch();
    captured += b.captured;
    failed += b.failed;
    stoppedBy = b.stoppedBy;
    unresolved = (b.unresolvedFailures ?? 0) + (b.awaitingHuman ?? 0);
    if (b.done) break;
  }

  // status() 必须在 finish() 之前读——finish 会把 _run 清空。
  const st = r.status();
  const route = st?.routes?.find((x) => x.routeKey === 'broadcast.timeline');
  // 「水位线能不能推进」看的是 `newestSeen`（本次最新的一条），**不是**进度。
  // 进度是 `oldestSeen`，那是给人看的。
  const advanced = route ? Boolean(route.contiguous && route.newestSeen) : null;

  // 中途停机、还有抓不下来的条目、**或者被软封锁挡住的条目**，都不是 complete。
  // 演练也不许在这一点上撒谎——这正是被演练验证的规则之一。
  //
  // 软封锁那一类原来没算进来：它们的状态是 awaiting_human 而不是 failed，于是
  // 一个 blocked 的剧本会「干净跑完」并标成 complete——而那正是这个剧本要验证
  // 不会发生的事。
  await r.finish(stoppedBy || unresolved ? 'aborted' : 'complete');

  return { captured, failed, stoppedBy, unresolved, byVerdict, advanced };
}

/**
 * service worker 发来的命令。
 *
 * 只认 `target === TARGET` 的消息，其余一概不理——`chrome.runtime.sendMessage`
 * 是广播式的，面板、自检页、offscreen 都会收到同一条。不加这个判别，三方会互相
 * 抢答，而先答的那个赢。
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== OFFSCREEN_TARGET) return; // 不返回 true，把答复权留给别人
  (async () => {
    try {
      switch (msg.op) {
        case 'ping':
          sendResponse({ ok: true });
          break;

        case 'start': {
          // 身份确认与开工必须是**一个**临界区。分成两条消息的话，两个「开始
          // 抓取」会各自发一次身份确认请求，然后其中一个才在 start 处失败——
          // 那一次多出来的请求已经发出去了。
          const started = await lock.run('开始抓取', async () => {
            const r = getRunner();
            if (r.active) throw new Error('已有抓取在进行中');
            const opts = reviveScope(msg.options);
            // 用户不该被要求手输用户名——他已经登录了，浏览器里就有答案。
            const who = opts.username ? { username: opts.username } : await r.discoverUsername();
            // 全量是**用户明说的**，那就一个下界都不挑——当作从来没抓过。
            if (msg.mode === CRAWL_MODES.FULL) {
              return r.start({ ...opts, username: who.username });
            }
            // 增量：从既有档案里挑下界。**在身份确认之后**才挑（判据是数字 uid），
            // 所以交给 runner 在正确的时刻回调。小范围试跑自带 floors，那时不会调用。
            return r.start({
              ...opts,
              username: who.username,
              resolveFloors: (account) => incrementalOptions(account, msg.mode),
            });
          });
          sendResponse({ ok: true, bundleId: started.bundleId, account: started.account });
          break;
        }

        case 'resume': {
          await lock.run('恢复抓取', async () => {
            const r = getRunner();
            if (r.active) {
              // 已经在内存里，但**可能停着**（用户点过暂停）。交给 runner 去判断：
              // 停着就清掉停机状态并把等待人工的条目放回队列；本来就在跑就是空操作。
              //
              // 早先这里 `if (r.active) return` 直接跳过，于是「继续」什么也没做。
              await r.resume(null);
              return;
            }
            // **自己读档案里的 checkpoint。** service worker 读不了 OPFS，它手上
            // 只有一份三个字段的调度摘要——拿那个去 resume 会丢掉游标与 frontier。
            const cp = await getRunStore().loadCheckpoint();
            if (!cp) throw new Error('档案里没有 checkpoint，无从恢复');
            await r.resume(cp);
          });
          sendResponse({ ok: true });
          break;
        }

        case 'drive':
          sendResponse({ ok: true, result: await drive() });
          break;

        case 'pause':
          // **刻意不加锁。** 加了的话「暂停」会在一段 22 秒的批次期间失灵，而
          // 用户按暂停往往正是因为他看到了不对的东西。pause 只是给 frontier
          // 立一个标志，不发请求。
          await getRunner().pause(msg.reason);
          sendResponse({ ok: true });
          break;

        case 'abort':
          // 中止：收尾成 aborted 并放开指针，之后这份档案就能删了。
          // **不加锁**：它要在抓取正跑着的时候也能按下去，跟暂停同理。
          sendResponse({ ok: true, manifest: await getRunner().abort() });
          break;

        case 'finish':
          sendResponse({
            ok: true,
            manifest: await getRunner().finish(msg.status, {
              acceptLeafGaps: Boolean(msg.acceptLeafGaps),
            }),
          });
          break;

        case 'retryFailed':
          // 不加锁：它只是把 frontier 里的状态改回 pending，不发请求。
          // 真正的抓取由随后的 drive() 推进，那一步是有锁的。
          sendResponse({ ok: true, count: await getRunner().retryFailed({ routeKey: msg.routeKey }) });
          break;

        case 'chain': {
          // 覆盖率页「合起来」那个视角。只读档案、不发请求，所以不加锁。
          //
          // **先分链。** 一堆档案不等于一条链：`previous_bundle_id` 为 null 的那些
          // 各自是一条链的起点（增量做出来之前的每一次抓取都是独立全量）。全当成
          // 一条会让档案数虚高，而且任何一份的缺口都会污染全部。
          const entries = await readChainEntries();
          const chains = splitChains(entries);
          // 指定了档案就给**它所在的那条链**（导出整条链、以及在档案页上看链时要用）；
          // 没指定就给最新那条（覆盖率页的默认视角）。
          const head = msg.bundleId
            ? chainOf(entries, msg.bundleId)
            : (chains[0] ?? []);
          const cov = chainCoverage(head);
          sendResponse({
            ok: true,
            chain: {
              bundles: head.map((e) => ({
                bundleId: e.bundleId,
                completedAt: e.completedAt,
                previousBundleId: e.previousBundleId,
                username: e.accountUsername,
              })),
              routes: [...cov].map(([routeKey, v]) => ({ routeKey, ...v })),
              holes: findChainHoles(head),
              // 不在这条链上的那些。**要说出来**：用户手上可能有好几次独立的全量，
              // 而界面只讲最新那条链——不提的话看起来像档案丢了。
              others: chains
                .filter((c) => c[0]?.bundleId !== head[0]?.bundleId)
                .map((c) => ({ head: c[0]?.bundleId, size: c.length })),
            },
          });
          break;
        }

        case 'chainDiff': {
          // 档案页：这一份里哪些是新增的、哪些又抓了一次，以及跨链的版本历史。
          //
          // **只读 index，不解压任何记录。** 一份真实档案 3347 条，解压是几秒钟的
          // 事；而这两个问题的答案全在 index 里。
          const slices = [];
          for (const dir of await WorkerFileStore.listBundleDirs(getOpfsWorker())) {
            const id = bundleIdFromDirName(dir);
            if (!id) continue;
            try {
              const store = new WorkerFileStore({ worker: getOpfsWorker(), dir });
              const reader = new BundleReader({ store, bundleId: id });
              const m = (await reader.hasManifest()) ? await reader.manifest() : null;
              slices.push({
                bundleId: id,
                completedAt: m?.completed_at ?? null,
                entries: (await reader.index()).map((e) => ({
                  url_key: e.url_key,
                  capture_id: e.capture_id,
                  observed_at: e.observed_at,
                  verdict: e.verdict,
                })),
              });
            } catch (e) {
              debugLog('读不出这份索引，跳过', dir, e);
            }
          }
          const cur = slices.find((s) => s.bundleId === msg.bundleId);
          if (!cur) {
            sendResponse({ ok: true, diff: { repeated: [], versionCount: 0 } });
            break;
          }

          // **只跟同一条链上的比。**
          //
          // 「新增 / 已抓取多次」问的是「这一份相对上一份多了什么」——那是**增量**
          // 的语义，只在链内成立。拿它跟不相干的全量档案比，会把每一张列表页都
          // 标成「已抓取多次」（那些 URL 每次全量都会抓），技术上没说错，但毫无
          // 意义：几次独立的全量本来就是各自完整的快照，不是彼此的增量。
          //
          // 于是一份**基准档案**（没有上游）看到的应当是：什么都不标。
          //
          // 注意这与「这一页我是不是已经有了」正好相反，那个按账号跨链算——
          // 两个问题，两种范围。
          const entries = await readChainEntries();
          const chainIds = new Set(chainOf(entries, msg.bundleId).map((e) => e.bundleId));
          const d = diffAgainstChain(cur, slices.filter((s) => chainIds.has(s.bundleId)));
          sendResponse({
            ok: true,
            // **只回个数。** 早先回的是截断到 200 条的清单，而界面拿那个清单的长度
            // 当总数显示——于是永远写着「200 个」，那是截断后的长度，不是真实数量。
            // 而界面本来也只需要个数（清单几百行，没人看）。
            diff: { repeated: d.repeated, versionCount: d.versions.length },
          });
          break;
        }

        case 'peekIncremental': {
          // 开抓**之前**看一眼有没有可用的基准，纯粹为了界面上那一行。
          //
          // 这里拿不到数字 uid（还没 preflight），所以**不按账号过滤**——于是它可能
          // 比真实结果乐观。措辞因此写成「有没有可用的基准」而不是「这次一定增量」。
          // 不加锁：只读档案，不发请求。
          try {
            const entries = await readChainEntries();
            const picks = pickFloors(entries);
            sendResponse({
              ok: true,
              result: {
                routes: [...picks.keys()],
                bundles: entries.length,
              },
            });
          } catch {
            sendResponse({ ok: true, result: null });
          }
          break;
        }

        case 'status':
          // 同样不加锁：读状态必须在抓取跑着的时候也能读到。
          sendResponse({ ok: true, status: getRunner().status(), busyWith: lock.holder });
          break;

        case 'deleteBundle': {
          // 删除走**这条唯一的写入路径**，而不是让面板的只读 Worker 破例。
          // 理由不只是洁癖：安全检查需要「现在在抓哪一份」这个知识，而它只在这里。
          const { bundleId, dir } = msg;
          const st = getRunner().status();
          if (st.active && st.bundleId === bundleId) {
            throw new Error(
              `档案 ${bundleId} 正在抓，不能删。删了它，写入器下一次落盘就会往一个` +
                '不存在的目录里写——请先暂停或等它结束。',
            );
          }
          // 经由**可写的那个** Worker 删。offscreen 自己不 import OpfsFileStore：
          // 那条边界（只有专用 Worker 直接碰 OPFS）有测试钉着，而且它挡住了
          // 「反正 destroy 用不到 sync handle，破例一次也行」这种滑坡。
          await WorkerFileStore.destroy(getOpfsWorker(), dir);
          debugLog('已删除档案目录', dir);
          sendResponse({ ok: true });
          break;
        }

        case 'dryRun':
          // 演练不发网络请求，但会和抓取抢 frontier / 写入器状态，所以照样要锁。
          sendResponse({
            ok: true,
            result: await lock.run('演练', () => runDryRun(msg.scenario)),
          });
          break;

        default:
          sendResponse({ ok: false, error: `offscreen 不认识的命令：${msg.op}` });
      }
    } catch (e) {
      // **错误码要一起过界。**
      //
      // 原来只送 `error` 字符串，于是 `SessionError('session_expired')` 到了另一边
      // 就只是一句话。上层无从分辨「这次操作本身失败了」与「会话失效了，整场都得
      // 停」——而这两件事该走的界面完全不同。
      //
      // 真实症状：用户点「重试抓不下来的页面」，屏幕上出现
      // 「重试失败：当前未登录豆瓣」——看起来像重试功能坏了，实际是会话过期，
      // 而界面里本来就有一块专门处理它的（「我登录好了，继续」）。
      sendResponse({
        ok: false,
        error: String(e?.message ?? e),
        reason: typeof e?.reason === 'string' ? e.reason : null,
      });
    }
  })();
  return true;
});

/**
 * `floors` 是个 `Map`，而这条通道只认 JSON —— Map 过来会变成 `{}`。
 *
 * 所以 service worker 那边把它拆成数组对，这里装回去。这类「结构在边界上被
 * 静默拍平」的问题不会报错，只会让下界变成空的，于是一次本该到某天为止的
 * 增量抓取变成全量重抓。
 *
 * @param {object} options
 */
function reviveScope(options = {}) {
  const o = { ...options };
  if (Array.isArray(o.floors)) o.floors = new Map(o.floors);
  return o;
}

debugLog('offscreen 已就绪', new Date().toISOString());
