/**
 * 时间处理。
 *
 * 规范：doubak-data-specs/bundle/v1/SPEC.md §7.2
 *
 * 三条铁律：
 * 1. 写出去的时间戳一律 RFC 3339 且【带显式时区偏移】，禁止裸时间。
 * 2. 豆瓣页面上的时间不带时区，解析时必须记录所假定的时区，且
 *    【原始字符串永远保留】。绝不静默转换。
 * 3. occurred_at / recorded_at / observed_at 是三件不同的事，永不合并。
 */

/**
 * 豆瓣服务端时区假定：北京时间 UTC+8。
 *
 * 这是【假定】不是事实——页面上的 `title="2026-07-26 12:34:00"` 不带任何
 * 时区标记。之所以敢用一个固定偏移量而不去查时区库：中国自 1991 年起不再
 * 实行夏令时，而豆瓣 2005 年才上线，因此其全部时间戳都落在恒定 UTC+8 的
 * 区间内。
 *
 * 万一这个假定被推翻，原始字符串还在，可以对存量重新解析。
 */
export const DOUBAN_TZ = 'Asia/Shanghai';
export const DOUBAN_TZ_OFFSET_MINUTES = 8 * 60;

const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 豆瓣的裸时间：`2026-07-26 12:34:00`，也接受用 T 分隔、省略秒。
 *
 * **也接受只有日期**（`2025-05-05`）——标记列表页上每条的标记日期就只有日期，
 * 没有时刻。那不是页面截断，是豆瓣本来就只公开到天。
 */
const DOUBAN_NAIVE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** @param {string} s */
export function isRfc3339WithOffset(s) {
  return typeof s === 'string' && RFC3339_RE.test(s);
}

/**
 * @param {number} offsetMinutes
 * @returns {string} 形如 `+08:00` / `Z`
 */
function formatOffset(offsetMinutes) {
  if (offsetMinutes === 0) return 'Z';
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const p = (n) => String(n).padStart(2, '0');
  return `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

/**
 * 把一个时刻格式化成带显式偏移的 RFC 3339。
 *
 * @param {Date} date
 * @param {number} [offsetMinutes] 默认用本机时区
 * @returns {string}
 */
export function toRfc3339(date, offsetMinutes = -date.getTimezoneOffset()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('无效的 Date');
  }
  // 把时刻平移到目标时区的「墙上时间」，再贴上偏移量标签。
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
    `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}` +
    formatOffset(offsetMinutes)
  );
}

/** 现在时刻，带本机时区偏移。用于 observed_at（爬虫看见的时间）。 */
export function nowRfc3339() {
  return toRfc3339(new Date());
}

/**
 * 解析豆瓣页面上的裸时间。
 *
 * **不做转换，只做标注**：`2026-07-26 12:34:00` 直接变成
 * `2026-07-26T12:34:00+08:00`——墙上时间一个数字都没动，只是补上了它
 * 本来就隐含的偏移量。这样海外时区的用户跑抓取也不会让水位线偏移。
 *
 * ## 只有日期时补 00:00:00，但**标出精度**
 *
 * 标记列表页上每条只给日期（`2025-05-05`）。补成 `T00:00:00+08:00` 是为了能比较，
 * 但那个 `00:00:00` **是我们填的，不是豆瓣说的**——所以返回值带 `precision`，
 * 而 `raw` 永远保留页面上的原样字符串。
 *
 * 为什么这件事必须标出来：水位线用**闭区间**比较（`<=`），日精度的下界意味着
 * 「那一天整天重走一遍」。那是安全的（重复免费，空洞永久），但前提是下游知道这是
 * 日精度而不是把 `00:00:00` 当成真的时刻。
 *
 * @param {string} raw 页面上的原样字符串
 * @param {number} [offsetMinutes]
 * @returns {{ raw: string, iso: string, epochMs: number, tz: string, precision: 'second' | 'day' }}
 */
export function parseDoubanTimestamp(raw, offsetMinutes = DOUBAN_TZ_OFFSET_MINUTES) {
  if (typeof raw !== 'string') throw new Error('时间字符串必须是 string');
  const trimmed = raw.trim();
  const m = DOUBAN_NAIVE_RE.exec(trimmed);
  if (!m) throw new Error(`无法解析的豆瓣时间: ${JSON.stringify(raw)}`);

  const [, y, mo, d, h, mi, s = '00'] = m;
  // 只有日期时补零点。**这个零点是我们填的**，所以下面要标出精度。
  const hasTime = h !== undefined;
  const iso = `${y}-${mo}-${d}T${hasTime ? h : '00'}:${hasTime ? mi : '00'}:${
    hasTime ? s : '00'
  }${formatOffset(offsetMinutes)}`;
  const epochMs =
    Date.UTC(
      Number(y), Number(mo) - 1, Number(d),
      hasTime ? Number(h) : 0, hasTime ? Number(mi) : 0, hasTime ? Number(s) : 0,
    ) - offsetMinutes * 60_000;

  if (Number.isNaN(epochMs)) throw new Error(`时间越界: ${JSON.stringify(raw)}`);

  // 回读校验：拒绝 2026-02-31 这种「格式对但日期不存在」的输入。
  // JS 的 Date.UTC 会把它悄悄滚到 3 月 3 日，那正是我们不想要的静默行为。
  if (toRfc3339(new Date(epochMs), offsetMinutes) !== iso) {
    throw new Error(`日期不存在: ${JSON.stringify(raw)}`);
  }

  return { raw: trimmed, iso, epochMs, tz: DOUBAN_TZ, precision: hasTime ? 'second' : 'day' };
}

/**
 * 水位线比较：判断某条目是否已经到达或越过下界。
 *
 * 用【闭区间】——宁可重复，不可遗漏（DESIGN.md §3.2）。
 *
 * @param {number} itemEpochMs
 * @param {number | null} floorEpochMs null 表示无下界，一直抓到最早
 * @returns {boolean} true 表示已经抓到下界，可以停了
 */
export function hasReachedFloor(itemEpochMs, floorEpochMs) {
  if (floorEpochMs === null) return false;
  return itemEpochMs <= floorEpochMs;
}
