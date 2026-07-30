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
 * | `chrome.storage` | **✗** | checkpoint 要经由 service worker 走一跳（`ProxyKvStore`） |
 * | `chrome.permissions` | **✗** | 传输层的权限兜底在这里查不了，会返回 `null`（「查不了」而不是「有权限」）。主动那道 `permissions.onRemoved` 在 service worker 里，仍然有效 |
 * | `chrome.notifications` | **✗** | 通知一律由 service worker 发 |
 * | `fetch`（带 host 权限与 cookie） | ✓ | 抓取靠它 |
 *
 * 「哪个上下文有哪个 API」是 MV3 里最容易踩空的一类知识，而踩空的样子往往是一句
 * 与真实原因毫无关系的错误信息。所以列在这里。
 */

import { CrawlRunner } from '../crawl/runner.js';
import { RunStore } from '../crawl/run-store.js';
import { driveWithinBudget } from '../crawl/driver.js';
import { MemoryKvStore } from '../storage/kv-store.js';
import { ProxyKvStore } from '../storage/proxy-kv-store.js';
import { WorkerFileStore } from '../storage/worker-file-store.js';
import { dryRunFetch } from '../crawl/dry-run.js';
import { OFFSCREEN_TARGET } from './protocol.js';
import { Exclusive } from '../crawl/exclusive.js';

// TODO(debug): 开发期日志。发布前连同所有调用一起删掉。
const DEBUG = true;
/** @param {...unknown} args */
function debugLog(...args) {
  if (DEBUG) console.log('[doubak/offscreen]', ...args);
}

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

/** @param {string} dir */
function openBundle(dir) {
  // readOnly:false —— 这是**唯一**一处写 OPFS 的地方。
  return Promise.resolve(new WorkerFileStore({ worker: getOpfsWorker(), dir, readOnly: false }));
}

/** @type {RunStore | null} */
let runStore = null;
function getRunStore() {
  // **不能**用 ChromeKvStore：offscreen document 拿不到 `chrome.storage`。
  // 它虽然是扩展页面，可用的扩展 API 却只有一小部分（`chrome.runtime` 在，
  // `chrome.storage` 不在）。所以经由 service worker 走一跳。
  //
  // 代价是每次读写多一条消息，而 checkpoint 一页写一次、内容是几百字节的小
  // JSON——和这条只认 JSON 的通道正好匹配。这与 WARC 记录完全相反，那才是抓取
  // 必须整条搬进来的原因。
  if (!runStore) runStore = new RunStore({ kv: new ProxyKvStore({ context: 'offscreen' }), openBundle });
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
  debugLog('事件', e.type, e.routeKey ?? e.reason ?? '');
  // 没有界面打开时 sendMessage 会 reject，那是正常的，不是错误。
  chrome.runtime.sendMessage({ type: 'crawl_event', event: e }).catch(() => {});
}

/**
 * 同一时刻只允许一件会发请求的事在跑。
 *
 * 这不是并发整洁问题而是**账号安全**问题：节奏闸门是按活动建的，两件活动各自
 * 遵守「1 秒一个请求」，合起来豆瓣看到的却是 2 秒 3 个。见 crawl/exclusive.js。
 *
 * 抓取全都在这一个 document 里跑，所以这一个锁就够——不需要跨上下文的协调。
 */
const lock = new Exclusive();

/** 正在推进的那一段，挡住同一件事的重入。 */
let driving = null;

async function drive() {
  // 心跳可能在上一段还没跑完时又来一次。这里返回**同一个** promise 而不是报错：
  // 重复唤醒是 MV3 的常态，不该被当成冲突。
  if (driving) return driving;
  driving = lock
    .run('抓取', () =>
      driveWithinBudget({
        runner: getRunner(),
        onEvent: (e) => debugLog('驱动', e.type),
      }))
    .finally(() => {
      driving = null;
    });
  return driving;
}

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
  // 上限只是防夹具写错导致死循环的兜底。
  for (let i = 0; i < 40; i++) {
    const b = await r.runBatch();
    captured += b.captured;
    failed += b.failed;
    stoppedBy = b.stoppedBy;
    if (b.done) break;
  }

  // status() 必须在 finish() 之前读——finish 会把 _run 清空。
  const st = r.status();
  const route = st?.routes?.find((x) => x.routeKey === 'broadcast.timeline');
  const advanced = route ? Boolean(route.contiguous && route.highWater) : null;

  // 中途停机的档案是 aborted，不是 complete。演练也不许在这一点上撒谎——
  // 这正是被演练验证的规则之一。
  await r.finish(stoppedBy ? 'aborted' : 'complete');

  return { captured, failed, stoppedBy, byVerdict, advanced };
}

/**
 * service worker 发来的命令。
 *
 * 只认 `target === TARGET` 的消息，其余一概不理——`chrome.runtime.sendMessage`
 * 是广播式的，popup、面板、offscreen 都会收到同一条。不加这个判别，三方会互相
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
            return r.start({ ...opts, username: who.username });
          });
          sendResponse({ ok: true, bundleId: started.bundleId, account: started.account });
          break;
        }

        case 'resume': {
          await lock.run('恢复抓取', async () => {
            const r = getRunner();
            if (!r.active) await r.resume(msg.checkpoint);
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
          await getRunner().pause();
          sendResponse({ ok: true });
          break;

        case 'finish':
          sendResponse({ ok: true, manifest: await getRunner().finish(msg.status) });
          break;

        case 'status':
          // 同样不加锁：读状态必须在抓取跑着的时候也能读到。
          sendResponse({ ok: true, status: getRunner().status(), busyWith: lock.holder });
          break;

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
      sendResponse({ ok: false, error: String(e?.message ?? e) });
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
