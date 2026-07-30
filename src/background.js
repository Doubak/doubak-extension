/**
 * MV3 service worker 入口 —— **只做调度，不碰数据**。
 *
 * 设计：DESIGN.md F-10a~h
 *
 * ## 它为什么只剩调度
 *
 * 抓取本体（fetch、判定、WARC 组装、落盘）搬进了 offscreen document。原因见
 * `src/offscreen/offscreen.js` 开头，简版：OPFS 的原地写入只能在**专用
 * Worker** 里做，而 service worker 不是专用 Worker；把字节转发过去也不行，
 * `chrome.runtime.sendMessage` 只认 JSON。
 *
 * | | service worker | offscreen document |
 * |---|---|---|
 * | 闹钟心跳、跨浏览器重启存活 | ✓ | ✗ |
 * | 决定该不该恢复 | ✓ | |
 * | fetch、判定、写档案 | ✗ | ✓ |
 *
 * 两边都不完整：service worker 拿不到长命上下文，offscreen 拿不到跨重启的
 * 唤醒。合起来才够。
 *
 * ## 为什么是这几个事件
 *
 * service worker 约 30 秒空闲就被杀，一场几小时的抓取会被杀几十上百次。它自己
 * 没办法「保持运行」，只能靠**别人来叫醒**：
 *
 * | 事件 | 什么时候来 |
 * |---|---|
 * | `alarms.onAlarm` | 心跳。**跨 worker 生命周期与浏览器重启存活**，系统休眠期间挂起、醒来补发 |
 * | `runtime.onStartup` | 浏览器启动 |
 * | `runtime.onInstalled` | 安装或更新 |
 * | `runtime.onMessage` | 界面点了按钮 |
 * | `permissions.onRemoved` | 用户收回了站点访问权限 |
 *
 * 闹钟是其中唯一一个「我们死了它还在」的东西——这正是自恢复而不是手动重触发
 * 的关键。
 *
 * ## 醒来不等于接着抓
 *
 * `Supervisor.tick()` 会先问恢复策略：只有**意外中断**才自动继续；风控、
 * 验证码、会话失效、权限被撤、配额、用户暂停一律等人。醒来就重试一个软封锁，
 * 正是把限流升级成封号的路径。
 */

import { Supervisor, ALARM_NAME } from './crawl/supervisor.js';
import { RunStore } from './crawl/run-store.js';
import { ChromeKvStore } from './storage/kv-store.js';
import { KV_MESSAGE, handleKvMessage } from './storage/proxy-kv-store.js';
import { checkHostAccess, HOST_PERMISSION_LOST } from './crawl/permissions.js';
import { preflightStorage } from './storage/quota.js';
import { ensureOffscreen, withOffscreen, serializeScope } from './offscreen/host.js';
import { notifyNeedsAction, notifyDone, clearAttention, wireNotificationClicks } from './ui/notify.js';

// TODO(debug): 开发期日志。发布前把 debugLog 与所有调用一起删掉。
const DEBUG = true;
/** @param {...unknown} args */
function debugLog(...args) {
  if (DEBUG) console.log('[doubak]', ...args);
}

/** @type {Supervisor | null} */
let supervisor = null;
/** @type {RunStore | null} */
let runStore = null;
/** @type {ChromeKvStore | null} */
let kv = null;

/**
 * `chrome.storage` 在整个扩展里**只有这一处**真的被碰。
 *
 * offscreen document 拿不到它（见 `src/offscreen/offscreen.js` 的 API 表），
 * 所以那一侧的读写都经由 `ProxyKvStore` 转到这里。把它收敛成一处，就少一整类
 * 「在这里能用、在那里不能用」的意外。
 */
function getKv() {
  if (!kv) kv = new ChromeKvStore();
  return kv;
}

/**
 * service worker 侧的 RunStore **只读 checkpoint**。
 *
 * 它用不上 `openBundle`——那是 offscreen 的事。这里给一个会抛的实现而不是
 * `undefined`：万一哪天有人在 service worker 里试图开 bundle，要在第一次调用
 * 就响亮地失败，而不是拿到一个「createSyncAccessHandle 不可用」的困惑错误。
 */
function getRunStore() {
  if (!runStore) {
    runStore = new RunStore({
      kv: getKv(),
      openBundle: () => {
        throw new Error(
          'service worker 里不能开 bundle：createSyncAccessHandle 只在专用 Worker 中可用。' +
            '档案读写都在 offscreen document 那一侧。',
        );
      },
    });
  }
  return runStore;
}

/**
 * 惰性构造监管器。
 *
 * worker 每次被拉起来都是全新的：模块顶层的变量没了，内存里什么都不剩。所以
 * 不能在顶层「初始化一次」，而要每次用的时候确保它在——**内存里不留唯一副本**，
 * 状态全在存储里。
 */
function getSupervisor() {
  if (supervisor) return supervisor;

  supervisor = new Supervisor({
    store: getRunStore(),
    alarms: globalThis.chrome?.alarms,
    hooks: {
      onResume: async () => {
        const cp = await getRunStore().loadCheckpoint();
        if (!cp) return;
        // 每次都先确保 offscreen 在——「我上次建过了」这个念头在 service
        // worker 里本身就不可靠，它的内存随时清零。
        await withOffscreen({ op: 'resume', checkpoint: cp });
        await drive();
      },
      onBlocked: async (decision) => {
        debugLog('不自动恢复：', decision.reason);
        if (decision.userVisible) await notifyNeedsAction(decision.reason);
      },
    },
  });
  return supervisor;
}

/** 推进一段有界的抓取，跑完就收尾。 */
async function drive() {
  const r = await withOffscreen({ op: 'drive' });
  debugLog('推进结果', JSON.stringify(r.result));

  if (r.result.done && !r.result.stoppedBy) {
    await withOffscreen({ op: 'finish', status: 'complete' });
    await getSupervisor().finishRun();
    await notifyDone(r.result);
  } else if (r.result.stoppedBy) {
    await notifyNeedsAction(r.result.stoppedBy);
  }
  return r.result;
}

wireNotificationClicks();

/** 心跳。这是自恢复的主路径。 */
globalThis.chrome?.alarms?.onAlarm?.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  try {
    const r = await getSupervisor().tick();
    debugLog('心跳', r.acted ? '→ 已恢复' : `→ 未恢复：${r.decision.reason}`);
  } catch (e) {
    // 心跳里抛异常会让这一次唤醒白费。记下来，等下一次闹钟再试——闹钟是
    // 周期性的，所以一次失败不是终局。
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
 * 用户收回了站点访问权限。
 *
 * Chrome 允许在任何时刻把站点访问改成「点击时」，不需要重装、也不会先问我们。
 * 一场几小时的抓取跨过这种改动完全现实。
 *
 * 必须在这里**主动停下**，而不是等下一次 fetch 失败：那一次失败抛的是
 * `TypeError`，和网络故障长得一模一样。传输层里有兜底判断（见
 * `crawl/permissions.js`），但兜底意味着已经白发了一次请求、白等了一轮重试。
 */
globalThis.chrome?.permissions?.onRemoved?.addListener(async (removed) => {
  debugLog('权限被收回', JSON.stringify(removed));
  try {
    const r = await checkHostAccess();
    if (!r || r.granted) return;
    await withOffscreen({ op: 'pause' }).catch(() => {}); // 它可能已经关了
    await getSupervisor().pauseRun(HOST_PERMISSION_LOST);
    await notifyNeedsAction(HOST_PERMISSION_LOST);
  } catch (e) {
    debugLog('处理权限收回时出错', e);
  }
});

/**
 * 界面发来的命令。
 *
 * 界面**只读状态、只发命令**，不直接改抓取状态（docs/ui.md §8）。
 */
globalThis.chrome?.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
  // 发给 offscreen 的消息不归我管。`sendMessage` 是广播式的，不加这个判别，
  // 我会抢在 offscreen 之前用「未知命令」把它答掉。
  if (msg?.target) return;
  // offscreen 转发给界面的抓取事件也不是命令。
  if (msg?.type === 'crawl_event') return;

  // offscreen 借道读写 chrome.storage。单独处理是因为它**不带 `target`**——
  // 带了就会被 offscreen 自己的监听器抢走，而它正是这条消息的发起方。
  if (msg?.type === KV_MESSAGE) {
    handleKvMessage(msg, getKv()).then(sendResponse);
    return true;
  }

  (async () => {
    try {
      switch (msg?.type) {
        case 'status': {
          const sup = getSupervisor();
          const cp = await getRunStore().loadCheckpoint();
          // offscreen 不在就**不去建**——只是看一眼状态，没必要为此把它拉起来。
          const st = await withOffscreen({ op: 'status' }).catch(() => null);
          sendResponse({
            ok: true,
            running: sup.running,
            checkpoint: cp,
            runner: st?.status ?? { active: false },
          });
          break;
        }

        case 'preflight':
          // 两项都可能是 null——那是「查不了」，不是「没问题」，界面照实显示。
          sendResponse({
            ok: true,
            permissions: await checkHostAccess(),
            storage: await preflightStorage(),
          });
          break;

        case 'start': {
          // 权限没了就别开始——第一页就会失败，而失败的样子像网络问题。
          const perm = await checkHostAccess();
          if (perm && !perm.granted) {
            throw new Error(
              `豆备没有访问 ${perm.missing.join('、')} 的权限。` +
                '请在浏览器的扩展设置里把站点访问权限改回「在所有网站上」。',
            );
          }

          await ensureOffscreen();
          // 用户不该被要求手输用户名——他已经登录了，浏览器里就有答案。
          const who = await withOffscreen({ op: 'discoverUsername' });
          const started = await withOffscreen({
            op: 'start',
            options: serializeScope({ username: who.username, ...scopeToOptions(msg?.scope) }),
          });
          await getSupervisor().startRun({ bundle_id: started.bundleId });
          await clearAttention();
          void drive(); // 不等它，立刻答复界面
          sendResponse({ ok: true, bundleId: started.bundleId, account: started.account });
          break;
        }

        case 'resume': {
          const cp = await getRunStore().loadCheckpoint();
          if (!cp) throw new Error('没有可恢复的抓取');
          await withOffscreen({ op: 'resume', checkpoint: cp });
          await clearAttention();
          void drive();
          sendResponse({ ok: true });
          break;
        }

        case 'pause':
          await withOffscreen({ op: 'pause' });
          await getSupervisor().pauseRun('user_paused');
          sendResponse({ ok: true });
          break;

        case 'tick':
          sendResponse({ ok: true, result: await getSupervisor().tick() });
          break;

        case 'dryRun': {
          const r = await withOffscreen({ op: 'dryRun', scenario: msg.scenario });
          sendResponse({ ok: true, result: r.result });
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

/**
 * 把界面上的「小范围试跑」翻译成 runner 的参数。
 *
 * 两类选项在性质上完全不同，界面上也必须分开说：
 *
 * - `days` → **下界**。走到那一天就是**干净终止**，跟每一次增量抓取的正常形态
 *   一模一样，水位线照常推进。
 * - `maxCaptures` → **安全阀**。到量就砍断，不是终止条件；水位线不推进，产出的
 *   是残缺档案。
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

debugLog('service worker 已启动', new Date().toISOString());
