/**
 * 日志页。
 */

import {
  shouldLog, formatEntry, formatLogText, MAX_ENTRIES, MAX_FETCH_ENTRIES,
} from '../../crawl/event-log.js';
import { $, send, eventNote } from './shared.js';

/**
 * 日志页。
 *
 * 事件由 offscreen 落进 IndexedDB（见 crawl/event-log.js），这里只负责读与显示。
 * 原来是个内存数组，只记面板打开期间的事件、一刷新就没——而界面上却写着「仅本地保留…
 * 导出前请自行脱敏」，同时暗示了「存下来了」和「有导出」，两个都不存在。
 */
let logRows = [];

export async function loadLog() {
  const el = $('log');
  el.className = 'muted';
  el.textContent = '正在读取…';

  const r = await send({ type: 'readLog' });
  logRows = r?.ok ? r.rows : [];
  renderLog();
}

export function renderLog() {
  const el = $('log');
  el.className = '';
  el.replaceChildren();

  if (logRows.length === 0) {
    el.className = 'muted';
    el.textContent = '还没有事件。这里记抓过的 URL（最近 200 条）以及重试、停机、错误这类事件（最近 1000 条）——完整的抓取记录在档案的 index.ndjson 里。';
  } else {
    for (const r of logRows) {
      const d = document.createElement('div');
      const bits = [r.at?.slice(0, 19).replace('T', ' '), r.type, r.routeKey, r.verdict, r.reason, r.url, r.message];
      d.textContent = bits.filter(Boolean).join('  ·  ');
      // 少数几种事件用户会问「这是什么」——把人话补一行。其余原样：内部类型名
      // 对排查有用，胡乱翻译反而让人对不上代码。
      const note = eventNote(r);
      if (note) {
        const n = document.createElement('div');
        n.className = 'muted';
        n.className = n.className ? `${n.className} indent` : 'indent';
        n.textContent = note;
        d.append(n);
      }
      el.append(d);
    }
  }

  const acts = $('log-actions');
  acts.replaceChildren();

  const copy = document.createElement('button');
  copy.className = 'act';
  copy.textContent = '复制日志';
  copy.disabled = logRows.length === 0;
  copy.onclick = async () => {
    const text = formatLogText(logRows);
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = '已复制 ✔';
      setTimeout(() => { copy.textContent = '复制日志'; }, 1500);
    } catch {
      // 剪贴板可能被策略挡住。**必须有退路**——「复制失败」而没有别的办法，
      // 等于这个功能不存在（自检页那边踩过同一个坑）。
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.rows = 16;
      ta.className = 'codebox';
      acts.append(ta);
      ta.select();
    }
  };

  const clear = document.createElement('button');
  clear.className = 'act';
  clear.textContent = '清空';
  clear.disabled = logRows.length === 0;
  clear.onclick = async () => {
    if (!confirm('清空日志？诊断记录会丢掉，但不影响任何已抓到的数据。')) return;
    await send({ type: 'clearLog' });
    loadLog();
  };

  acts.append(copy, clear);
}

/** 订阅实时事件，让**正在看**日志页的用户不必等下一次读取。 */
export function initLog() {
  chrome.runtime.onMessage?.addListener((msg) => {
    if (msg?.type !== 'crawl_event') return;
    // 事件的落盘在 offscreen 那边做（那样不依赖面板开着）。这里只是让**正在看**日志页的
    // 用户即时看到，不必等下一次读取。
    if (!shouldLog(msg.event)) return;
    logRows.unshift(formatEntry(msg.event, new Date().toISOString()));
    if (logRows.length > MAX_ENTRIES + MAX_FETCH_ENTRIES) logRows.pop();
    const tab = $('tabs').querySelector('button[data-tab="log"]');
    if (tab?.getAttribute('aria-selected') === 'true') renderLog();
  });
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
export function resetLog() {
  logRows = [];
}
