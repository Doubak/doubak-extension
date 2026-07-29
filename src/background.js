/**
 * MV3 service worker 入口。
 *
 * 设计：DESIGN.md F-10a~h
 *
 * ## 这个文件唯一的职责：接线
 *
 * 真正的逻辑都在 `src/crawl/` 与 `src/bundle/` 里，且都不碰浏览器专有 API，
 * 因此可以完全在 Node 里测。这里只做浏览器那一侧的连接：把事件接到监管器上。
 *
 * ## 为什么这些事件是这几个
 *
 * service worker 约 30 秒空闲就被杀，一场几小时的抓取会被杀几十上百次。
 * 它自己没有办法「保持运行」，只能靠**别人来叫醒**。能叫醒它的只有事件：
 *
 * | 事件 | 什么时候来 |
 * |---|---|
 * | `alarms.onAlarm` | 心跳。**跨 worker 生命周期与浏览器重启存活**，系统休眠期间挂起、醒来补发 |
 * | `runtime.onStartup` | 浏览器启动 |
 * | `runtime.onInstalled` | 安装或更新 |
 * | `runtime.onMessage` | 界面点了按钮 |
 * | `permissions.onRemoved` | 用户在扩展设置里收回了站点访问权限 |
 *
 * 闹钟是其中唯一一个「我们死了它还在」的东西——这正是自恢复而不是手动重触发
 * 的关键。
 *
 * ## ⚠️ 已知缺口：这里的 OPFS 写入在真实浏览器里还跑不通
 *
 * `OpfsFileStore` 靠 `createSyncAccessHandle()`，而它**只在专用 Worker 里
 * 可用**——窗口没有，**service worker 也没有**。所以下面这条
 * `OpfsFileStore.open(dir)` 目前只在 Node 测试里成立（那里用的是
 * `MemoryFileStore`）。
 *
 * 修法是 DESIGN.md F-10 已经定下的形状：service worker 负责调度与生命周期，
 * 实际的 OPFS 写入交给一个 **offscreen document** 里的**专用 Worker**。
 * service worker 随时会被杀，offscreen document 不会，这本来也是选它的理由。
 *
 * 需要：manifest 加 `offscreen` 权限、一个 offscreen 页面、把
 * `openBundle` 换成一个跨到那边的 RPC。窗口侧的对应实现已经有了
 * （`src/storage/worker-file-store.js`），协议可以直接复用。
 *
 * 在那之前，抓取只能在 Node 测试与演练里验证，不能装进浏览器真跑。
 * `test/execution-context.test.js` 钉着这段说明，免得这个缺口被忘掉。
 *
 * ## 醒来不等于接着抓
 *
 * `Supervisor.tick()` 会先问恢复策略：只有**意外中断**才自动继续；风控、
 * 验证码、会话失效、用户暂停一律等人。醒来就重试一个软封锁，正是把限流升级
 * 成封号的路径。
 */

import { Supervisor, ALARM_NAME } from './crawl/supervisor.js';
import { RunStore } from './crawl/run-store.js';
import { CrawlRunner } from './crawl/runner.js';
import { driveWithinBudget } from './crawl/driver.js';
import { ChromeKvStore, MemoryKvStore } from './storage/kv-store.js';
import { dryRunFetch } from './crawl/dry-run.js';
import { checkHostAccess, HOST_PERMISSION_LOST } from './crawl/permissions.js';
import { preflightStorage } from './storage/quota.js';
import { OpfsFileStore } from './storage/opfs-store.js';

// TODO(debug): 开发期日志。发布前把 debugLog 与所有调用一起删掉。
const DEBUG = true;
/** @param {...unknown} args */
function debugLog(...args) {
  if (DEBUG) console.log('[doubak]', ...args);
}

/** @type {Supervisor | null} */
let supervisor = null;
/** @type {CrawlRunner | null} */
let runner = null;
/** 正在推进的那一段，避免同一次唤醒里重入。 */
let driving = null;

/** 惰性构造 runner。与 supervisor 同理：worker 每次拉起都是全新的。 */
function getRunner() {
  if (runner) return runner;
  runner = new CrawlRunner({
    runStore: getRunStore(),
    openBundle: (dir) => OpfsFileStore.open(dir),
    onEvent: (e) => debugLog('事件', e.type, e.routeKey ?? e.reason ?? ''),
  });
  return runner;
}

/** @type {RunStore | null} */
let runStore = null;
function getRunStore() {
  if (!runStore) {
    runStore = new RunStore({
      kv: new ChromeKvStore(),
      openBundle: (dir) => OpfsFileStore.open(dir),
    });
  }
  return runStore;
}

/**
 * 推进一段有界的抓取。
 *
 * 用 `driving` 挡住重入：心跳、界面命令、启动检查都可能同时调到这里，而
 * 两段并行推进会让同一个 frontier 被两个循环消费。
 */
async function drive() {
  if (driving) return driving;
  driving = (async () => {
    try {
      const r = await driveWithinBudget({
        runner: getRunner(),
        onEvent: (e) => debugLog('驱动', e.type),
      });
      debugLog('推进结果', JSON.stringify(r));
      if (r.done && !r.stoppedBy) {
        await getRunner().finish('complete');
        await getSupervisor().finishRun();
      }
      return r;
    } finally {
      driving = null;
    }
  })();
  return driving;
}

/**
 * 把界面上的「小范围试跑」翻译成 runner 的参数。
 *
 * 两类选项在性质上完全不同，界面上也必须分开说：
 *
 * - `days` → **下界**。走到那一天就是**干净终止**，跟每一次增量抓取的正常
 *   形态一模一样，水位线照常推进。
 * - `maxCaptures` → **安全阀**。到量就砍断，不是终止条件；水位线不推进，
 *   产出的是残缺档案。
 *
 * @param {{days?: number, maxCaptures?: number, routes?: string[]} | undefined} scope
 */
function scopeToOptions(scope) {
  if (!scope) return {};
  const routes = scope.routes ?? ['broadcast.timeline'];
  /** @type {Record<string, unknown>} */
  const opts = { onlyRoutes: routes };
  if (scope.days) {
    const floor = new Date(Date.now() - scope.days * 86_400_000).toISOString();
    opts.floors = new Map(routes.map((k) => [k, floor]));
  }
  if (scope.maxCaptures) opts.maxCaptures = scope.maxCaptures;
  return opts;
}

/**
 * 跑一次演练：真实的链路，**零网络请求**。
 *
 * 用独立的内存 KV，而不是真的那份——演练绝不能覆盖掉一次真实抓取的指针，
 * 否则「调试一下」就把用户几小时的进度弄丢了。档案本身照样写进真 OPFS，
 * 那正是要验的东西。
 *
 * @param {string} scenario
 */
async function runDryRun(scenario) {
  if (getRunner().active) throw new Error('有真实抓取在进行中，先暂停再演练');

  /** @type {Record<string, number>} */
  const byVerdict = {};

  const runner = new CrawlRunner({
    runStore: new RunStore({
      kv: new MemoryKvStore(),
      openBundle: (dir) => OpfsFileStore.open(dir),
    }),
    openBundle: (dir) => OpfsFileStore.open(dir),
    fetchImpl: dryRunFetch(scenario),
    onEvent: (e) => {
      debugLog('演练', e.type, e.routeKey ?? e.reason ?? '');
      if (e.type === 'capture') {
        // 判不出来是 null，而 null 恰恰是最该被看见的一种结果——
        // 给它一个名字，别让它在计数里消失。
        const k = e.verdict ?? 'unclassified';
        byVerdict[k] = (byVerdict[k] ?? 0) + 1;
      }
    },
    // 演练不碰豆瓣，没有降速的理由；用真实节奏只会让人干等几分钟。
    // 但 Pacer 不接受 0（那会让「有节奏」这件事本身可以被关掉），所以取 1ms。
    pacerOptions: { intervalMs: 1, jitterRatio: 0 },
  });

  await runner.start({
    username: 'dryrun',
    onlyRoutes: ['broadcast.timeline'],
    includeCatalog: false,
  });

  // 有界推进，直到跑完或停机。上限只是防夹具写错导致死循环的兜底。
  let captured = 0;
  let failed = 0;
  let stoppedBy = null;
  for (let i = 0; i < 40; i++) {
    const b = await runner.runBatch();
    captured += b.captured;
    failed += b.failed;
    stoppedBy = b.stoppedBy;
    if (b.done) break;
  }

  // status() 必须在 finish() 之前读——finish 会把 _run 清空。
  const st = runner.status();
  const route = st?.routes?.find((r) => r.routeKey === 'broadcast.timeline');
  const advanced = route ? Boolean(route.contiguous && route.highWater) : null;

  // 中途停机的档案是 aborted，不是 complete。演练也不许在这一点上撒谎——
  // 这正是被演练验证的那条规则之一。
  await runner.finish(stoppedBy ? 'aborted' : 'complete');

  return { captured, failed, stoppedBy, byVerdict, advanced };
}

/**
 * 惰性构造监管器。
 *
 * worker 每次被拉起来都是全新的：模块顶层的变量没了，内存里什么都不剩。
 * 所以不能在顶层「初始化一次」，而要每次用的时候确保它在——**内存里不留
 * 唯一副本**，状态全在存储里。
 */
function getSupervisor() {
  if (supervisor) return supervisor;

  supervisor = new Supervisor({
    store: getRunStore(),
    alarms: globalThis.chrome?.alarms,
    hooks: {
      onResume: async () => {
        const r = getRunner();
        if (!r.active) {
          const cp = await getRunStore().loadCheckpoint();
          if (!cp) return;
          await r.resume(cp);
        }
        await drive();
      },
      onBlocked: async (decision) => {
        debugLog('不自动恢复：', decision.reason);
        await notify(decision.reason);
      },
    },
  });
  return supervisor;
}

/**
 * 需要人工介入时把用户叫回来。
 *
 * 标题直接写要做什么，而不是「Doubak 遇到问题」——用户需要的是下一步动作，
 * 不是一个错误码（docs/ui.md §5）。
 *
 * @param {string} message
 */
async function notify(message) {
  const chrome = globalThis.chrome;
  try {
    await chrome?.action?.setBadgeText?.({ text: '!' });
    await chrome?.action?.setBadgeBackgroundColor?.({ color: '#d93025' });
    await chrome?.action?.setTitle?.({ title: `豆备：${message}` });
  } catch (e) {
    debugLog('设置角标失败', e);
  }
}

/**
 * 用户收回了站点访问权限。
 *
 * Chrome 允许在任何时刻把站点访问改成「点击时」，不需要重装、也不会先问我们。
 * 一场几小时的抓取跨过这种改动是完全现实的。
 *
 * 必须在这里**主动停下**，而不是等下一次 fetch 失败：那一次失败抛的是
 * `TypeError`，和网络故障长得一模一样。传输层里有兜底判断（见
 * crawl/permissions.js），但兜底意味着已经白发了一次请求、白等了一轮重试。
 */
globalThis.chrome?.permissions?.onRemoved?.addListener(async (removed) => {
  debugLog('权限被收回', JSON.stringify(removed));
  try {
    const r = await checkHostAccess();
    if (r && !r.granted && getRunner().active) {
      await getRunner().pause();
      await getSupervisor().pauseRun(HOST_PERMISSION_LOST);
      await notify('没有访问豆瓣的权限了，请在扩展设置里重新授权');
    }
  } catch (e) {
    debugLog('处理权限收回时出错', e);
  }
});

/** 心跳。这是自恢复的主路径。 */
globalThis.chrome?.alarms?.onAlarm?.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  try {
    const r = await getSupervisor().tick();
    debugLog('心跳', r.acted ? '→ 已恢复' : `→ 未恢复：${r.decision.reason}`);
  } catch (e) {
    // 心跳里抛异常会让这一次唤醒白费。记下来，等下一次闹钟再试——
    // 闹钟是周期性的，所以一次失败不是终局。
    debugLog('心跳出错', e);
  }
});

/** 浏览器启动：上次可能是关机中断的。 */
globalThis.chrome?.runtime?.onStartup?.addListener(async () => {
  debugLog('浏览器启动');
  try {
    await getSupervisor().tick();
  } catch (e) {
    debugLog('启动检查出错', e);
  }
});

/** 安装或更新：同样要检查有没有没抓完的。 */
globalThis.chrome?.runtime?.onInstalled?.addListener(async (details) => {
  debugLog('onInstalled', details?.reason);
  try {
    await getSupervisor().tick();
  } catch (e) {
    debugLog('安装后检查出错', e);
  }
});

/**
 * 界面发来的命令。
 *
 * 界面**只读状态、只发命令**，不直接改抓取状态（docs/ui.md §8）。
 */
globalThis.chrome?.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'status': {
          const sup = getSupervisor();
          const cp = await getRunStore().loadCheckpoint();
          sendResponse({
            ok: true,
            running: sup.running,
            checkpoint: cp,
            runner: getRunner().status(),
          });
          break;
        }
        case 'preflight': {
          // 界面在开抓前问一次。两项都可能返回 null——那是「查不了」，不是
          // 「没问题」，界面必须照实显示。
          sendResponse({
            ok: true,
            permissions: await checkHostAccess(),
            storage: await preflightStorage(),
          });
          break;
        }
        case 'start': {
          const r = getRunner();
          if (r.active) throw new Error('已有抓取在进行中');

          // 权限没了就别开始——第一页就会失败，而失败的样子像网络问题。
          const perm = await checkHostAccess();
          if (perm && !perm.granted) {
            throw new Error(
              `豆备没有访问 ${perm.missing.join('、')} 的权限。` +
                '请在浏览器的扩展设置里把站点访问权限改回「在所有网站上」。',
            );
          }
          // 用户不该被要求手输用户名——他已经登录了，浏览器里就有答案。
          const { username } = await r.discoverUsername();
          const started = await r.start({ username, ...scopeToOptions(msg?.scope) });
          await getSupervisor().startRun({ bundle_id: started.bundleId });
          void drive(); // 不等它，立刻答复界面
          sendResponse({ ok: true, ...started });
          break;
        }
        case 'dryRun': {
          sendResponse({ ok: true, result: await runDryRun(msg?.scenario) });
          break;
        }
        case 'resume': {
          const cp = await getRunStore().loadCheckpoint();
          if (!cp) throw new Error('没有可恢复的抓取');
          const r = getRunner();
          if (!r.active) await r.resume(cp);
          void drive();
          sendResponse({ ok: true });
          break;
        }
        case 'tick': {
          sendResponse({ ok: true, result: await getSupervisor().tick() });
          break;
        }
        case 'pause': {
          await getRunner().pause();
          await getSupervisor().pauseRun('user_paused');
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: `未知命令: ${msg?.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
  })();
  // 返回 true 表示会异步答复——不返回的话 sendResponse 会失效。
  return true;
});

debugLog('service worker 已启动', new Date().toISOString());
