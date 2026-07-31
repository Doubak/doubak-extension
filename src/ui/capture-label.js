/**
 * 捕获列表里每一行怎么写。
 *
 * ## 为什么单独一个纯函数模块
 *
 * 它要回答的是「这一行到底在说什么时间」，而那件事**很容易悄悄说错**：index 里有两类
 * 时间，含义完全不同——
 *
 * | 字段 | 是什么 | 回答的问题 |
 * |---|---|---|
 * | `item_time_range` | 这一页**内容**覆盖的时间区间 | 这一页是哪段时间的东西 |
 * | `observed_at` | **抓取**这一页的时刻 | 什么时候抓的 |
 *
 * 混起来的后果是：用户以为看到的是「第 7 页是 7 月中旬的广播」，实际上看到的是
 * 「这一页是今天抓的」——而后者对一次抓取里的每一行都几乎一样，等于没有信息。
 *
 * 埋在面板里的时候这条逻辑没法测，也就没法发现它在旧档案上退化成了什么。抽出来。
 */

/** 只取日期那一段。列表里精确到秒是噪音——**内容时间**才这样。 */
function day(s) {
  return s ? String(s).slice(0, 10) : '?';
}

/**
 * 抓取时刻要精确到秒。
 *
 * 理由与内容时间相反：一次抓取里几十行的**日期**全都一样，只有秒能把它们区分开。
 * 既然这一行只剩这个信息可说，那就说得有用一点。
 *
 * @param {string | null | undefined} s  RFC3339
 */
function secondsOf(s) {
  if (!s) return '?';
  // 2026-07-30T20:42:53+10:00 → 2026-07-30 20:42:53
  return String(s).slice(0, 19).replace('T', ' ');
}

/**
 * 「广播 · 第 7 页」
 *
 * @param {object} e  index 条目
 * @param {(routeKey: string) => string} routeName
 */
export function captureTitle(e, routeName) {
  const c = e.cursor;
  /** @type {string | null} */
  let where = null;
  if (c?.value != null) {
    if (c.kind === 'page') where = `第 ${c.value} 页`;
    // offset 游标是「从第 N 条开始」，不是页码。写成「第 N 页」会差一个数量级
    // （步长 15 的列表里，offset 105 是第 8 页）。
    else if (c.kind === 'start' || c.kind === 'offset') where = `第 ${c.value} 条起`;
  }
  // 没有游标的（作品详情页）从 URL 上认。见 `subjectLabel`。
  if (!where) where = subjectLabel(e.url);
  return [routeName(e.route_key), where].filter(Boolean).join(' · ');
}

/** URL 里认得出的媒介。路径形状见 classifier.js 的 `SUBJECT_LINK`。 */
const SUBJECT_PATTERNS = [
  [/movie\.douban\.com\/subject\/(\d+)/, '电影'],
  [/book\.douban\.com\/subject\/(\d+)/, '书'],
  [/music\.douban\.com\/subject\/(\d+)/, '音乐'],
  [/douban\.com\/location\/drama\/(\d+)/, '舞台剧'],
  [/douban\.com\/game\/(\d+)/, '游戏'],
  [/douban\.com\/app\/(\d+)/, '应用'],
];

/**
 * 从作品详情页的 URL 上认出「哪一部」。
 *
 * 作品详情页没有游标，于是捕获列表里几千行**长得一模一样**——全是「作品详情页」，
 * 排在一起，没有任何一行能被认出来。而这一页的用处正是「找某一条记录」。
 *
 * URL 里本来就有媒介与 ID（`movie.douban.com/subject/1292052/`），那是**免费的**：
 * index 里已经存着 URL，不用解压任何东西。
 *
 * 标题当然更好看，但它不在 index 里——而且**也不该在**：bundle 是个容器，
 * 「requires knowing nothing about Douban's semantics」，标题是豆瓣的语义，
 * 归 canonical 管。真要看标题，点开那一行就是（预览会把记录解压出来）。
 *
 * @param {string | undefined} url
 * @returns {string | null}
 */
export function subjectLabel(url) {
  if (!url) return null;
  for (const [re, medium] of SUBJECT_PATTERNS) {
    const m = re.exec(url);
    if (m) return `${medium} ${m[1]}`;
  }
  return null;
}

/**
 * 「20 条 · 2026-07-12 → 2026-07-18」
 *
 * 三种情况，三种说法：
 *
 * 1. **有内容时间** → 说内容时间。这是用户在档案里找东西时真正想要的。
 * 2. **没有内容时间，但这条路线本来就没有**（作品详情页是单个条目，没有区间）
 *    → 说抓取时刻，精确到秒。
 * 3. **旧档案：这两个字段是后来才加进规范的** → 说清「这份档案没有记录内容时间」，
 *    而不是拿抓取时刻冒充。前者是一句实话，后者会让人以为第 7 页的广播是今天发的。
 *
 * @param {object} e
 */
export function captureSubtitle(e) {
  /** @type {string[]} */
  const bits = [];

  // null 与 0 不能显示成一样：null 是「这条路线没有条目概念」，
  // 0 是「数过了，是空的」——而空页正是翻页终点的正常形态，那是有用的信息。
  if (e.item_count === 0) bits.push('0 条（到这儿就没有了）');
  else if (typeof e.item_count === 'number') bits.push(`${e.item_count} 条`);

  const r = e.item_time_range;
  if (r?.oldest || r?.newest) {
    const o = day(r.oldest);
    const n = day(r.newest);
    bits.push(o === n ? o : `${o} → ${n}`);
    return bits.join(' · ');
  }

  // 走到这里就是没有内容时间。**不能拿抓取时刻冒充它**，得说清是哪一种。
  const stamp = secondsOf(e.observed_at);
  if (hasItemFields(e)) {
    // 这条记录是新格式写的，只是这一页没有条目时间——作品详情页就是这样。
    bits.push(`抓于 ${stamp}`);
  } else {
    // 旧档案：写它的时候规范里还没有这两个字段。
    bits.push(`抓于 ${stamp}（这份档案没有记录内容时间）`);
  }
  return bits.join(' · ');
}

/**
 * 这条记录是不是「知道条目时间这回事」的格式写的。
 *
 * `item_count` 与 `item_time_range` 是后加的可选字段（bundle/v1 §6.1.2）。**两个都缺**
 * 说明这份档案早于那次改动；只缺区间说明这一页本来就没有条目时间。
 *
 * 这个区分不是吹毛求疵：前者是「我们当时没记」，后者是「本来就没有」。把前者说成后者，
 * 等于替一份旧档案担保它其实没担保过的东西。
 *
 * @param {object} e
 */
function hasItemFields(e) {
  return 'item_count' in e || 'item_time_range' in e;
}
