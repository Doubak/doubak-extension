/**
 * 抓取事件日志：存得住、读得回来。
 *
 * 设计：DESIGN.md F-11d
 *
 * ## 为什么原来的不算日志
 *
 * 面板里那个 `logLines` 是个内存数组：只记录**面板打开期间**收到的事件，一刷新就没了。
 * 而界面上写着「仅本地保留，不会发送到任何地方。导出前请自行脱敏」——那句话同时暗示了
 * 「存下来了」和「有导出」，两个都不存在。
 *
 * 而这段时间排查问题时，最想要的恰好是「上次那次抓取到底在哪一步停下的」。
 *
 * ## 只记 index.ndjson 里没有的东西
 *
 * **每一次成功的捕获已经被记录了**——那就是 `index.ndjson`，而且它写在档案里、每页落盘、
 * 带着判定与偏移量。日志再抄一遍只会得到两份可能不一致的记录，而且把真正稀少的信号
 * （重试、停机、门控放开、错误）淹掉。
 *
 * 所以这里**不记 capture 事件**。剩下的都是稀疏事件，一次抓取里也就几十条，写起来毫无
 * 压力。
 *
 * ## 有上限，丢最老的
 *
 * 环形缓冲，默认 500 条。日志是诊断用的，不是档案——它没有「不可再生」的性质，所以宁可
 * 丢最老的也不要无界增长。真正不可再生的东西都在 WARC 里。
 */

/** 日志在 KV 里的键。 */
export const LOG_KEY = 'doubak.eventLog';

/** 最多留多少条。 */
export const MAX_ENTRIES = 500;

/**
 * 不进日志的事件类型。
 *
 * `capture` —— `index.ndjson` 已经逐条记了，而且更权威（带偏移量与摘要）。
 * `page` —— 每页一条翻页进度，同样是 index 能推导的，而且量大。
 */
const SKIP = new Set(['capture', 'page']);

/** @param {object} e */
export function shouldLog(e) {
  return Boolean(e?.type) && !SKIP.has(e.type);
}

/**
 * 把事件压成一行。
 *
 * 只留人看得懂的字段，**不留整个事件对象**：里面可能有大段 HTML 或错误栈，而日志有条数
 * 上限没有字节上限，一条超大记录会把有用的挤掉。
 *
 * @param {object} e
 * @param {string} at  ISO 时间
 */
export function formatEntry(e, at) {
  return {
    at,
    type: e.type,
    ...(e.routeKey ? { routeKey: e.routeKey } : {}),
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.url ? { url: String(e.url).slice(0, 300) } : {}),
    // 错误信息要留，但要截断——它是排查的主要线索，也是最容易超长的字段。
    ...(e.message ? { message: String(e.message).slice(0, 500) } : {}),
    ...(typeof e.count === 'number' ? { count: e.count } : {}),
  };
}

/**
 * 追加一条。满了就丢最老的。
 *
 * @param {import('../storage/kv-store.js').KvStore} kv
 * @param {object} e
 * @param {object} [opts]
 * @param {string} [opts.at]
 * @param {number} [opts.max]
 */
export async function appendEvent(kv, e, { at = new Date().toISOString(), max = MAX_ENTRIES } = {}) {
  if (!shouldLog(e)) return;
  const prev = /** @type {object[]} */ ((await kv.get(LOG_KEY)) ?? []);
  const next = [...prev, formatEntry(e, at)];
  // 从头切，保留最近的 max 条
  await kv.set(LOG_KEY, next.length > max ? next.slice(next.length - max) : next);
}

/**
 * 读回全部日志，**最新在前**。
 *
 * @param {import('../storage/kv-store.js').KvStore} kv
 * @returns {Promise<object[]>}
 */
export async function readLog(kv) {
  const rows = /** @type {object[]} */ ((await kv.get(LOG_KEY)) ?? []);
  return [...rows].reverse();
}

/** @param {import('../storage/kv-store.js').KvStore} kv */
export async function clearLog(kv) {
  await kv.remove(LOG_KEY);
}

/**
 * 渲染成可复制的纯文本。
 *
 * **里面有 URL 与用户名。** 界面上必须在复制/导出旁边说这件事——它是本地诊断工具，
 * 不是可以随手贴到公开地方的东西。
 *
 * @param {object[]} rows  最新在前
 */
export function formatLogText(rows) {
  const lines = ['豆备抓取日志', `导出时间：${new Date().toISOString()}`, `${rows.length} 条`, ''];
  lines.push('注意：下面含有 URL 与用户名，贴出去之前请自行脱敏。', '');
  for (const r of rows) {
    const bits = [r.at, r.type, r.routeKey, r.reason, r.url, r.message].filter(Boolean);
    lines.push(bits.join('  ·  '));
  }
  return lines.join('\n');
}
