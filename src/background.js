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
 *
 * 闹钟是其中唯一一个「我们死了它还在」的东西——这正是自恢复而不是手动重触发
 * 的关键。
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
import { ChromeKvStore } from './storage/kv-store.js';
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
        case 'start': {
          const r = getRunner();
          if (r.active) throw new Error('已有抓取在进行中');
          // 用户不该被要求手输用户名——他已经登录了，浏览器里就有答案。
          const { username } = await r.discoverUsername();
          const started = await r.start({ username });
          await getSupervisor().startRun({ bundle_id: started.bundleId });
          void drive(); // 不等它，立刻答复界面
          sendResponse({ ok: true, ...started });
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
