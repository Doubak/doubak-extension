/**
 * url_key —— 供去重使用的归一化 URL。
 *
 * 规范：doubak-data-specs/bundle/v1/SPEC.md §6.1
 *
 * **原始 URL 是事实，url_key 是索引。两者并存，索引不覆盖事实。**
 *
 * 捕获时对 `url` 不做任何归一化（跟踪参数照留，它们本来就是当时那个页面的
 * 一部分）。但去重不能用原始 URL，否则 `_spm_id` 一变就当成一个新页面。
 *
 * 剥离规则带版本号（`url_key_rules`）。将来发现新的跟踪参数，可以对存量
 * 重算 url_key，而 `url` 永远不动。
 */

export const URL_KEY_RULES_VERSION = 'v1';

/**
 * 要剥掉的查询参数。
 *
 * **保守原则**：只剥「确定纯属跟踪」的参数。剥错一个有语义的参数，会把
 * 两个不同的页面合并成一个——那是不可检测的数据损失，比多留几个跟踪参数
 * 糟糕得多。
 *
 * 所以 `start` / `sort` / `p` / `type` / `status` / `action` 这些一律保留，
 * 它们决定了页面内容。
 *
 * 名单来源：一份真实旧档案（2022-12 至 2024-08）里实际出现过的参数，
 * 外加通用的 utm_*。
 */
const TRACKING_PARAMS = new Set([
  '_spm_id', // 豆瓣的点位追踪，出现在广播固定链接上
  '_dtcc',   // 同上
  '_i',      // 旧版跟踪参数
  'dcs',     // read./market. 子域的营销参数
  'dcm',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',

  // ck 是 Rexxar API 的 CSRF 令牌，跟着会话走。同一个接口在不同会话下
  // ck 不同，若不剥掉，跨会话的同一请求会被当成两个不同的 URL。
  //
  // TODO(待定): 存进 `url` 的原始 URL 是否也该把 ck 抹掉？它是会话相关的
  // 令牌，归档价值为零，而 bundle 是要导出、甚至可能公开的。这与「捕获时
  // 不做归一化」有张力，需要在 spec 里明确。见 DESIGN.md 待决问题。
  'ck',
]);

/**
 * 生成 url_key。
 *
 * 做四件事，仅此四件：
 * 1. scheme 与 host 转小写（它们本来就大小写不敏感）
 * 2. 剥掉已知跟踪参数
 * 3. 查询参数按名字排序（参数顺序不改变页面内容）
 * 4. 丢掉 fragment（`#...` 从不发给服务器）
 *
 * 刻意【不】做的事：不动路径大小写（豆瓣路径大小写敏感）、不加不减尾斜杠
 * （`/people/x` 与 `/people/x/` 在豆瓣上可能是两个不同的响应，合并它们
 * 是有风险的猜测）。
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function urlKey(rawUrl) {
  const u = new URL(rawUrl); // 非法 URL 直接抛，调用方应当先判定

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';

  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.has(k));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);

  return u.toString();
}

/**
 * 这个参数名会被 url_key 剥掉吗？（供测试与调试用）
 * @param {string} name
 */
export function isTrackingParam(name) {
  return TRACKING_PARAMS.has(name);
}
