/**
 * 「详细日志」这个开关。
 *
 * **默认关，但不删。** 那批 debugLog 的战绩——睡眠后锁被占住 26 小时、123 张封面
 * 全是 418、「像是跑了好几个实例」其实是并发保护在工作——每一条都是用户把控制台
 * 贴过来才定位到的。删掉等于在见到真实用户的那一刻关掉唯一的远程诊断通道。
 */

import { IdbKvStore } from '../../storage/idb-kv-store.js';
import { loadDebugFlag, setDebugFlag, debugEnabled } from '../../core/debug-log.js';
import { $ } from './shared.js';
import { setActionError } from './overview.js';

//
// **默认关，但不删。** 那批 debugLog 原来标着「发布前删」，而回头看它的战绩——
// 睡眠后锁被占住 26 小时、123 张封面全是 418、「像是跑了好几个实例」其实是并发
// 保护在工作——每一条都是用户把控制台贴过来才定位到的。删掉等于在见到真实用户的
// 那一刻关掉唯一的远程诊断通道。详见 core/debug-log.js。
//
// **惰性构造。** `new IdbKvStore()` 在拿不到 IndexedDB 时会抛（那是对的——抓取状态
// 必须能持久化）。但面板在模块顶层构造它，就等于让一个排查用的开关有本事把整个
// 面板炸掉：`refresh()` 一次都跑不起来，用户看到的是空白页。
/** @type {IdbKvStore | null} */
let debugKv = null;
function getDebugKv() {
  if (!debugKv) debugKv = new IdbKvStore();
  return debugKv;
}

function renderDebugState() {
  if (!$('toggle-debug')) return;
  const on = debugEnabled();
  $('toggle-debug').textContent = on ? '关掉详细日志' : '打开详细日志';
  $('debug-state').textContent = on
    // 说清「哪里看」与「什么时候生效」：另外两个上下文要等下次启动，而 service
    // worker 约 30 秒就重启一次。不说的话用户会以为开关没生效。
    ? '已开启。可在扩展的 Service Worker 与 Offscreen 控制台中查看带有 [doubak] 前缀的输出；'
      + '正在进行的抓取将在下一轮心跳（约半分钟内）后开始输出。'
    : '已关闭。此为默认状态，控制台保持清爽。';
}


// 读失败就保持关着并如实显示——这个开关坏掉不该影响任何别的东西。

/**
 * 绑开关，并读一次当前状态。
 *
 * **读失败就保持关着并如实显示**——这个开关坏掉不该影响任何别的东西。
 */
export function initDebugToggle() {
  $('toggle-debug')?.addEventListener('click', async () => {
    try {
      await setDebugFlag(getDebugKv(), !debugEnabled());
    } catch (err) {
      setActionError('存不下这个开关', String(err?.message ?? err));
      return;
    }
    renderDebugState();
  });

  void (async () => {
    try {
      await loadDebugFlag(getDebugKv());
    } catch { /* 保持默认的关 */ }
    renderDebugState();
  })();
}
