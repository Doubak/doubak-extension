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
import { ScheduleStore } from './crawl/run-store.js';
import { IdbKvStore } from './storage/idb-kv-store.js';
import { checkHostAccess, HOST_PERMISSION_LOST } from './crawl/permissions.js';
import { FAILURES_PENDING, FINALIZE_FAILED } from './crawl/resume-policy.js';
import { readLog, clearLog } from './crawl/event-log.js';
import { preflightStorage } from './storage/quota.js';
import { exportedKey } from './storage/storage-usage.js';
import { ensureOffscreen, withOffscreen, serializeScope } from './offscreen/host.js';
import {
  notifyNeedsAction, notifyDone, clearAttention, wireNotificationClicks, openPanel,
} from './ui/notify.js';

// TODO(debug): 开发期日志。发布前把 debugLog 与所有调用一起删掉。
const DEBUG = true;
/** @param {...unknown} args */
function debugLog(...args) {
  if (DEBUG) console.log('[doubak]', ...args);
}

/** @type {Supervisor | null} */
let supervisor = null;
/** @type {ScheduleStore | null} */
let runStore = null;
/** @type {IdbKvStore | null} */
let kv = null;

/**
 * 抓取状态存 IndexedDB，**不是** `chrome.storage.local`。
 *
 * 原因是一个架构性的死结：offscreen document 拿不到 `chrome.storage`，而让它借道
 * 这里会形成请求/响应环——service worker 正 await offscreen 的「开始抓取」响应，
 * offscreen 又 await service worker 帮它写 checkpoint。详见
 * `src/storage/idb-kv-store.js` 开头。
 *
 * IndexedDB 是普通 DOM/Worker API，两个上下文都能直接用、看到同一份数据。这也
 * 正是设计里写的（DESIGN.md F-10b）。
 */
function getKv() {
  if (!kv) kv = new IdbKvStore();
  return kv;
}

/**
 * 调度状态。**只读写 IDB 指针，不碰档案。**
 *
 * service worker 读不了 OPFS（`createSyncAccessHandle` 只在专用 Worker 里可用），
 * 而完整的 checkpoint 是 bundle 目录里的一个文件。所以这里用 `ScheduleStore`，
 * 它只看 `RunStore` 镜像进指针的那三个调度字段（停机原因、时间、退避层级）。
 *
 * 第一版给 SW 一个完整的 `RunStore` 加一个会抛的 `openBundle`。那只是把「静默
 * 不可用」变成「响亮不可用」——「开始抓取」照样直接失败，因为 `loadCheckpoint()`
 * 本来就要开档案。分工必须按**需要的数据量**来分，而不是靠一句报错提醒自己。
 */
function getRunStore() {
  if (!runStore) runStore = new ScheduleStore({ kv: getKv() });
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
        // **不把 checkpoint 传过去。** 这里拿到的只是调度摘要（三个字段），
        // 而 `runner.resume()` 要的是全本（游标、frontier、退避）。全本在档案里，
        // 而只有 offscreen 读得了档案——让它自己去读。
        //
        // 每次都先确保 offscreen 在：「我上次建过了」这个念头在 service worker
        // 里本身就不可靠，它的内存随时清零。
        await withOffscreen({ op: 'resume' });
        await drive();
      },
      onBlocked: async (decision) => {
        debugLog('不自动恢复：', decision.reason);
        // 传 kv 才会去重。心跳每 30 秒来一次，不去重的话同一件事会每半分钟弹一遍，
        // 而它还带 requireInteraction 不会自己消失——用户会去关掉通知权限，
        // 然后连真正要紧的那条也收不到。
        if (decision.userVisible) await notifyNeedsAction(decision.pauseReason ?? decision.reason, { kv: getKv() });
      },
    },
  });
  return supervisor;
}

/** 推进一段有界的抓取，跑完就收尾。 */
async function drive() {
  const r = await withOffscreen({ op: 'drive' });
  debugLog('推进结果', JSON.stringify(r.result));

  if (r.result.done && !r.result.stoppedBy && !r.result.unresolvedFailures) {
    // **收尾失败不能变成无限重试。**
    //
    // 报上来过一次：`IndexWriter` 没有恢复路径，于是收尾时段与索引对不上并抛错。
    // 那个异常从这里一路冒到 `onResume`，没有人接——心跳每 30 秒来一次，每次都
    // 走到同一处抛同一个错，控制台里刷「心跳出错」，而界面上**什么都不显示**：
    // 用户看到的是一个既不继续也不结束、也不说为什么的抓取。
    //
    // 抓到的数据本身没事（都落盘了），坏的只是收尾这一步。所以：停下来、
    // 写进调度镜像（心跳据此不再自动重试）、并且把话说给用户听。
    try {
      await withOffscreen({ op: 'finish', status: 'complete' });
    } catch (err) {
      debugLog('收尾失败', err);
      await getSupervisor().pauseRun(FINALIZE_FAILED, { last_error: String(err?.message ?? err) });
      await notifyNeedsAction(FINALIZE_FAILED, { kv: getKv() });
      return { ...r.result, stoppedBy: FINALIZE_FAILED, finalizeError: String(err?.message ?? err) };
    }
    await getSupervisor().finishRun();
    await notifyDone(r.result, { kv: getKv() });
  } else if (r.result.done && r.result.unresolvedFailures) {
    // 跑不动了，但**不是**干净跑完：有抓不下来的条目。
    //
    // 绝不自动标 complete——那是假的完整性声明，而这个项目最不能出的就是这个错。
    // 也不自动重试：反复撞同一面墙，如果那面墙是风控，代价是账号。
    // 交给用户：面板上会列出这些条目，可以重试，也可以确认「就这样收尾」。
    await getSupervisor().pauseRun(FAILURES_PENDING);
    await notifyNeedsAction(FAILURES_PENDING, { kv: getKv() });
  } else if (r.result.stoppedBy) {
    // 把真实原因记进调度镜像，否则心跳会一直把它当崩溃哨兵去自动恢复——
    // 而「醒来就重试一个软封锁」正是把限流升级成封号的路径。
    await getSupervisor().pauseRun(r.result.stoppedBy);
    await notifyNeedsAction(r.result.stoppedBy, { kv: getKv() });
  }
  return r.result;
}

wireNotificationClicks();

/**
 * 点工具栏图标 → 开面板。
 *
 * 这里原来挂的是一个 popup：状态、开始/暂停，外加一个「完整面板」按钮。它是个多余的
 * 中间层——**真正要看的东西一个都放不下**（日志、覆盖率、档案预览、失败页面），
 * 而且 popup 一失焦就关，长任务根本没法在里面盯。实际用法一直是「点图标、再点一下
 * 进面板」，那就直接去面板。
 *
 * 注意：只有在 manifest 里**没有** `default_popup` 时 `onClicked` 才会触发。
 */
globalThis.chrome?.action?.onClicked?.addListener(async () => {
  try {
    await openPanel();
  } catch (e) {
    debugLog('打开面板失败', e);
  }
});

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
    await withOffscreen({ op: 'pause', reason: HOST_PERMISSION_LOST }).catch(() => {}); // 它可能已经关了
    await getSupervisor().pauseRun(HOST_PERMISSION_LOST);
    await notifyNeedsAction(HOST_PERMISSION_LOST, { kv: getKv() });
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

          // 已经有没抓完的？那就别偷偷另起一个——新档案会把指针改掉，旧的那份
          // 从此没人再碰，用户却以为「继续抓」了。
          const existing = await getRunStore().loadCheckpoint();
          if (existing) {
            throw new Error(
              `还有一次没抓完的抓取（档案 ${existing.bundle_id}）。` +
                '请先「继续」把它跑完，或者在档案页确认之后再开始新的。',
            );
          }

          await ensureOffscreen();
          // 身份确认在 offscreen 那侧与 start 一起做——它们必须是一个临界区，
          // 否则两个「开始抓取」会各自发一次身份确认请求。
          const started = await withOffscreen({
            op: 'start',
            options: serializeScope(scopeToOptions(msg?.scope)),
          });
          await getSupervisor().startRun({ bundle_id: started.bundleId });
          await clearAttention({ kv: getKv() });
          void drive(); // 不等它，立刻答复界面
          sendResponse({ ok: true, bundleId: started.bundleId, account: started.account });
          break;
        }

        case 'resume': {
          const cp = await getRunStore().loadCheckpoint();
          if (!cp) throw new Error('没有可恢复的抓取');
          // 全本 checkpoint 在档案里，offscreen 自己读（见上面 onResume 的说明）。
          await withOffscreen({ op: 'resume' });
          // **调度镜像也要改回哨兵。** 它还写着 user_paused 的话，心跳每 30 秒就会
          // 再弹一条「需要你处理：你手动暂停了抓取」——而用户刚点的正是继续。
          await getSupervisor().resumeRun();
          await clearAttention({ kv: getKv() });
          void drive();
          sendResponse({ ok: true });
          break;
        }

        case 'pause':
          // 原因要带过去：档案里的 checkpoint 由 offscreen 写，而**那份才是**
          // 恢复时真正被读的。SW 这边的 `pauseRun` 只更新调度镜像。
          await withOffscreen({ op: 'pause', reason: 'user_paused' });
          await getSupervisor().pauseRun('user_paused');
          sendResponse({ ok: true });
          break;

        case 'tick':
          sendResponse({ ok: true, result: await getSupervisor().tick() });
          break;

        case 'readLog':
          sendResponse({ ok: true, rows: await readLog(getKv()) });
          break;

        case 'clearLog':
          await clearLog(getKv());
          sendResponse({ ok: true });
          break;

        case 'retryFailed': {
          const r = await withOffscreen({ op: 'retryFailed', routeKey: msg.routeKey });
          if (r.count > 0) {
            await clearAttention({ kv: getKv() });
            void drive();
          }
          sendResponse({ ok: true, count: r.count });
          break;
        }

        case 'finishWithGaps': {
          // 用户看过失败清单之后决定「就这样收尾」。规范允许带着缺口 complete
          // （bundle/v1 §5.0），前提是每处缺口都如实记录、且该路线 advanced=false。
          await withOffscreen({ op: 'finish', status: 'complete', acceptLeafGaps: true });
          await getSupervisor().finishRun();
          await clearAttention({ kv: getKv() });
          sendResponse({ ok: true });
          break;
        }

        case 'deleteBundle': {
          // 删除是**不可逆**的，所以后台这一侧也守一道，不只靠界面上的确认框：
          // 用户可能点得很快，而消息也可能是从别处发来的。真正的检查在 offscreen
          // 那边（只有它知道现在在抓哪一份）。
          if (!msg.bundleId || !msg.dir) throw new Error('缺少 bundleId 或 dir');
          await withOffscreen({ op: 'deleteBundle', bundleId: msg.bundleId, dir: msg.dir });
          // 删掉的正好是指针指向的那一份 → 指针成了悬空的，一起清掉。
          const cur = await getRunStore().loadCheckpoint();
          if (cur?.bundle_id === msg.bundleId) await getRunStore().clearCheckpoint();
          await getKv().remove(exportedKey(msg.bundleId));
          sendResponse({ ok: true });
          break;
        }

        case 'markExported': {
          // 导出成功后由面板记一笔。**派生状态**——丢了不影响档案本身，只影响
          // 删除确认框说得多重。
          await getKv().set(exportedKey(msg.bundleId), msg.at ?? new Date().toISOString());
          sendResponse({ ok: true });
          break;
        }

        case 'exportRecords': {
          /** @type {Record<string, string>} */
          const out = {};
          for (const id of msg.bundleIds ?? []) {
            const at = await getKv().get(exportedKey(id));
            if (at) out[id] = /** @type {string} */ (at);
          }
          sendResponse({ ok: true, exportedAt: out });
          break;
        }

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
 * `bypassGates` 只给调试用：作品详情页正常要等广播抓完（不能拿最不可替代的东西去换
 * 最可替代的），而小范围试跑要验的恰恰是那条路线，不该先花几小时抓广播。界面上必须
 * 说清它绕过了什么。
 *
 * @param {{days?: number, maxCaptures?: number, routes?: string[], bypassGates?: boolean} | undefined} scope
 */
function scopeToOptions(scope) {
  if (!scope) return {};
  const routes = scope.routes ?? ['broadcast.timeline'];
  /** @type {Record<string, unknown>} */
  const opts = { onlyRoutes: routes };
  if (scope.bypassGates) opts.bypassGates = true;
  if (scope.days) {
    const floor = new Date(Date.now() - scope.days * 86_400_000).toISOString();
    opts.floors = new Map(routes.map((k) => [k, floor]));
  }
  if (scope.maxCaptures) opts.maxCaptures = scope.maxCaptures;
  return opts;
}

debugLog('service worker 已启动', new Date().toISOString());
