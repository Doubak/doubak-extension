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
 * ## 两个环，分开限额
 *
 * | 环 | 记什么 | 上限 |
 * |---|---|---|
 * | 事件 | 重试、停机、错误、门控、暂停——**稀疏且要紧** | 500 |
 * | 抓取 | 抓了哪个 URL、判定是什么——**每页一条** | 200 |
 *
 * 分开是因为它们的密度差着两个数量级。一次全量抓取有几千页，混在一个 500 条的环里，
 * **翻页记录会把真正要紧的信号全部挤出去**——而那几条（为什么停的、哪一页反复失败）
 * 正是事后唯一能查的东西。
 *
 * 抓取那一环的上限更小也是刻意的：它回答的是「刚才在干什么」，那是个**近期**问题。
 * 完整的抓取记录在 `index.ndjson` 里，写在档案中、每页落盘、带着判定与偏移量——那才是
 * 权威版本，这里只是给活人看的近期窗口。
 *
 * ## 都是环形，丢最老的
 *
 * 日志是诊断用的，不是档案——它没有「不可再生」的性质，所以宁可丢最老的也不要无界增长。
 * 真正不可再生的东西都在 WARC 里。
 */

/** 稀疏事件（重试、停机、错误）在 KV 里的键。 */
export const LOG_KEY = 'doubak.eventLog';
/** 抓取记录（每页一条）的键。与上面**分开限额**，见文件开头。 */
export const FETCH_LOG_KEY = 'doubak.fetchLog';

/** 稀疏事件最多留多少条。 */
export const MAX_ENTRIES = 500;
/** 抓取记录最多留多少条。它回答的是「刚才在干什么」，是个近期问题。 */
export const MAX_FETCH_ENTRIES = 200;

/**
 * 每页一条、进抓取环的事件。
 *
 * `page` 不记：它是翻页进度，与 `capture` 一一对应，记两遍没有意义。
 */
const FETCH_TYPES = new Set(['capture']);

/** 完全不记的：`page` 与 `capture` 重复。 */
const SKIP = new Set(['page']);

/** @param {object} e */
export function shouldLog(e) {
  return Boolean(e?.type) && !SKIP.has(e.type);
}

/** 这条该进哪个环。 @param {object} e */
export function isFetchEvent(e) {
  return FETCH_TYPES.has(e?.type);
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
    ...(e.verdict ? { verdict: e.verdict } : {}),
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
export async function appendEvent(kv, e, { at = new Date().toISOString(), max } = {}) {
  if (!shouldLog(e)) return;
  const fetchy = isFetchEvent(e);
  const key = fetchy ? FETCH_LOG_KEY : LOG_KEY;
  const cap = max ?? (fetchy ? MAX_FETCH_ENTRIES : MAX_ENTRIES);

  const prev = /** @type {object[]} */ ((await kv.get(key)) ?? []);
  const next = [...prev, formatEntry(e, at)];
  // 从头切，保留最近的 cap 条
  await kv.set(key, next.length > cap ? next.slice(next.length - cap) : next);
}

/**
 * 读回全部日志，**最新在前**。
 *
 * @param {import('../storage/kv-store.js').KvStore} kv
 * @returns {Promise<object[]>}
 */
export async function readLog(kv) {
  const events = /** @type {object[]} */ ((await kv.get(LOG_KEY)) ?? []);
  const fetches = /** @type {object[]} */ ((await kv.get(FETCH_LOG_KEY)) ?? []);
  // 两个环合并按时间排。分开存是为了不让翻页记录挤掉要紧的事件，但**看的时候是一条
  // 时间线**——「停在哪一步」这个问题要的正是前后文。
  return [...events, ...fetches].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** @param {import('../storage/kv-store.js').KvStore} kv */
export async function clearLog(kv) {
  await kv.remove(LOG_KEY);
  await kv.remove(FETCH_LOG_KEY);
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
    const bits = [r.at, r.type, r.routeKey, r.verdict, r.reason, r.url, r.message].filter(Boolean);
    lines.push(bits.join('  ·  '));
  }
  return lines.join('\n');
}
