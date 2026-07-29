/**
 * 响应分类器：判定一个响应可不可信。
 *
 * 规范：doubak-data-specs/bundle/v1/vocabularies/verdict.json
 * 设计：DESIGN.md F-05
 *
 * ## 为什么不能只看状态码
 *
 * **豆瓣以 HTTP 200 返回封锁页。** 只看状态码等于完全没有检测。
 *
 * ## 最难的一组：两个都是「0 条目」的页面
 *
 * 真实旧档案里有两种页面，条目数都是 0，在文件层面几乎无法区分：
 *
 * | | 越界终止页 | 会话过期的登录页 |
 * |---|---|---|
 * | 条目数 | 0 | 0 |
 * | HTTP 状态 | 200 | 200 |
 * | 体积 | 19240 字节 | 16199 字节 |
 * | 标题 | 我的广播 | 登录豆瓣 |
 * | 导航栏用户名 | 有 | 无 |
 * | 该怎么办 | 正常结束这条路线 | **整场停机** |
 *
 * 前代工具把登录页按数据文件名写进了磁盘，没有任何标记——下游只会看到
 * 「文件在，里面 0 条」。这就是 verdict 必须逐条捕获的最强论据。
 *
 * 所以判定的主力信号是**页面框架**（标题、导航栏用户名），而不是条目数。
 * 条目数交给路线逻辑（停滞检测）去解释。
 *
 * ## 判不出来就是失败
 *
 * 本模块返回 `verdict: null` 表示「判不出来」。调用方**必须**当作失败并
 * 停下，不得当作 ok。「大概没事」是这套系统里最危险的一句话。
 */

/** 豆瓣的风控域名。跳到这里就是被拦了。 */
const SEC_HOST = 'sec.douban.com';

/**
 * 页面文案特征。
 *
 * 都来自真实旧档案里实际出现过的字符串，不是凭印象写的。注意匹配要容忍
 * 空白——真实页面里 `<title>` 与内容之间有换行和缩进，前代那种精确匹配
 * `<title>登录豆瓣</title>` 的写法在别处就会漏。
 */
const MARKERS = {
  loginTitle: /<title>\s*登录豆瓣\s*<\/title>/,
  pageNotFound: /页面不存在/,
  captcha: /验证码|captcha/i,
  abnormalRequest: /有异常请求|请输入验证码|访问过于频繁/,
};

/**
 * 一条路线的判定描述。
 *
 * @typedef {object} RouteProfile
 * @property {RegExp[]} frameAnchors  页面框架标志。**缺一不可**——它们在，
 *   才说明这确实是这条路线的页面。空列表页也有框架，所以框架而非条目数
 *   才是判定依据。
 * @property {RegExp} [itemAnchor]    单个条目的标志。只用于计数，不参与判定。
 * @property {RegExp} [userNav]       导航栏中登录状态的标志。
 */

/**
 * 导航栏里的登录状态标志。
 *
 * 两个标志任一即可：`nav-user-account`（用户菜单）或 `/accounts/logout`
 * （退出链接）。实测在广播页与标记列表页上两者同时出现，取并集是为了对
 * 改版更耐受。
 */
const DEFAULT_USER_NAV = /nav-user-account|\/accounts\/logout/;

/**
 * 未登录的正向标志：导航栏里出现「登录」入口。
 *
 * 这比「找不到用户菜单」更直接——找不到可能只是改版换了 class，而登录入口
 * 出现就是明确的未登录。
 *
 * 这个信号不是假想出来的：真实旧档案里有 **151 个页面**是在未登录状态下
 * 抓的（整个 20230127 批次的电影与游戏、两个批次的舞台剧与音乐）。豆瓣的
 * 公开列表对匿名访问者照常显示，所以前代工具照样拿到了数据、照样存了盘，
 * 没有任何标记。
 *
 * 未登录抓到的页面**不能当作这个账号的数据**：私密条目不会出现在公开视图里。
 */
const LOGIN_LINK = /"nav-login"|class="nav-login"/;

/**
 * @typedef {object} Classification
 * @property {string | null} verdict  null = 判不出来，调用方必须当作失败
 * @property {string[]} reasons       判定依据，便于排查与事后重训
 * @property {number | null} itemCount
 */

/**
 * @param {object} input
 * @param {string} input.finalUrl   跟随跳转之后的最终 URL
 * @param {number} input.status
 * @param {string} input.bodyText   已解码的响应体
 * @param {RouteProfile} input.route
 * @param {{median: number, count: number} | null} [input.sizeStats]
 *   该路线的滚动体积分布。样本太少时传 null。
 * @returns {Classification}
 */
export function classifyResponse({ finalUrl, status, bodyText, route, sizeStats = null }) {
  /** @type {string[]} */
  const reasons = [];
  const itemCount = route.itemAnchor ? countMatches(bodyText, route.itemAnchor) : null;

  // ── 1. 跳转到风控域名：最明确的信号，优先于一切
  let host = '';
  try {
    host = new URL(finalUrl).host;
  } catch {
    reasons.push('finalUrl 无法解析');
    return { verdict: null, reasons, itemCount };
  }
  if (host === SEC_HOST || host.endsWith(`.${SEC_HOST}`)) {
    reasons.push(`跳转到风控域名 ${host}`);
    // 带验证码的是可由人解决的挑战；否则按封锁处理，两者都不得自动重试。
    return {
      verdict: MARKERS.captcha.test(bodyText) ? 'challenge' : 'blocked',
      reasons,
      itemCount,
    };
  }

  // ── 2. 登录页：会话已失效，这是【停止条件】而不是可重试错误
  if (MARKERS.loginTitle.test(bodyText)) {
    reasons.push('标题是「登录豆瓣」——会话已失效');
    return { verdict: 'login', reasons, itemCount };
  }

  // ── 3. HTTP 层面的明确信号
  if (status === 404) {
    reasons.push('HTTP 404');
    return { verdict: 'gone', reasons, itemCount };
  }
  if (status === 403) {
    reasons.push('HTTP 403');
    return { verdict: 'blocked', reasons, itemCount };
  }
  if (status === 429) {
    reasons.push('HTTP 429——请求过于频繁');
    return { verdict: 'blocked', reasons, itemCount };
  }
  if (status >= 500) {
    // 服务端错误不是封锁，但也不能当成数据。交给上层按可重试的网络错误处理。
    reasons.push(`HTTP ${status}`);
    return { verdict: null, reasons, itemCount };
  }
  if (status !== 200) {
    reasons.push(`未预期的 HTTP ${status}`);
    return { verdict: null, reasons, itemCount };
  }

  // ── 4. 以 200 返回的异常页
  if (MARKERS.abnormalRequest.test(bodyText)) {
    reasons.push('页面含风控提示文案');
    return { verdict: MARKERS.captcha.test(bodyText) ? 'challenge' : 'blocked', reasons, itemCount };
  }
  if (MARKERS.pageNotFound.test(bodyText)) {
    reasons.push('页面含「页面不存在」');
    return { verdict: 'soft404', reasons, itemCount };
  }

  // ── 5. 会话是否还在
  //
  // 走到这里页面既不是登录页也没有风控提示，但如果导航栏里已经没有登录
  // 状态，说明会话在某个环节掉了——此时页面上的内容不代表这个账号。
  const userNav = route.userNav ?? DEFAULT_USER_NAV;
  const loggedIn = userNav.test(bodyText);
  if (!loggedIn) {
    // 页面上可能照样有数据——豆瓣的公开列表对匿名访问者正常显示。但那是
    // 公开视图，私密条目不在里面，不能当作这个账号的数据。
    const explicit = LOGIN_LINK.test(bodyText) ? '（导航栏出现登录入口）' : '';
    reasons.push(
      `导航栏中没有登录状态${explicit}——页面即使有内容也只是公开视图，不代表这个账号`,
    );
    return { verdict: 'login', reasons, itemCount };
  }
  reasons.push('导航栏中存在登录状态');

  // ── 6. 页面框架必须齐全
  //
  // 这是区分「越界终止页」与「出了别的问题」的关键：终止页条目数为 0，
  // 但框架是完整的。用条目数判定会把正常的翻页终点当成故障。
  const missing = route.frameAnchors.filter((re) => !re.test(bodyText));
  if (missing.length > 0) {
    reasons.push(`缺少 ${missing.length} 个页面框架标志——不像是这条路线的页面`);
    return { verdict: null, reasons, itemCount };
  }
  reasons.push('页面框架完整');

  // ── 7. 体积异常只作为警示，不单独定罪
  //
  // 体积能区分正常页与封锁页（实测：广播正常页中位数约 98 KB，登录页
  // 16 KB），但上面的信号已经更直接。这里只在框架齐全却异常小的时候留个记录，
  // 用于事后发现「豆瓣换了新的封锁形态」。
  if (sizeStats && sizeStats.count >= 8) {
    const ratio = bodyText.length / sizeStats.median;
    if (ratio < 0.25) {
      reasons.push(
        `体积仅为该路线中位数的 ${(ratio * 100).toFixed(0)}%——框架齐全但异常小，值得留意`,
      );
    }
  }

  if (itemCount === 0) reasons.push('条目数为 0——可能是翻过了最后一页，由路线逻辑判断');

  return { verdict: 'ok', reasons, itemCount };
}

/** @param {string} text @param {RegExp} re */
function countMatches(text, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let n = 0;
  while (g.exec(text) !== null) n += 1;
  return n;
}

/**
 * 滚动体积分布。
 *
 * 用于给分类器提供「这条路线的页面通常多大」。刻意只记最近若干个样本：
 * 豆瓣改版会让页面整体变大或变小，用全历史会让基线迟迟跟不上。
 */
export class RollingSize {
  /** @param {number} [window] */
  constructor(window = 32) {
    this._window = window;
    /** @type {number[]} */
    this._samples = [];
  }

  /** @param {number} size */
  add(size) {
    this._samples.push(size);
    if (this._samples.length > this._window) this._samples.shift();
  }

  /** @returns {{median: number, count: number} | null} */
  stats() {
    if (this._samples.length === 0) return null;
    const sorted = [...this._samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    return { median, count: sorted.length };
  }
}

/**
 * 已知路线的判定描述。
 *
 * 锚点取自真实旧档案里实际出现的 markup。注意 `frameAnchors` 用的是页面
 * 框架而非条目——空列表页也必须能被判为 ok。
 */
export const ROUTE_PROFILES = {
  'broadcast.timeline': {
    // 真实终止页（0 条广播）仍然带着这个标题与用户导航
    frameAnchors: [/<title>\s*[^<]*广播\s*<\/title>/],
    itemAnchor: /<div class="status-item"/,
    // 广播条目自带稳定 ID，用于跨页去重与停滞检测
    idAnchor: /data-sid="(\d+)"/g,
    // 声明数量：广播没有可信的总数，故为 null
    claimedCount: null,
  },
  'interest.list': {
    // 列表页的标题形如「我看过的影视(1157)」
    frameAnchors: [/<h1>\s*[^<]*\(\d+\)\s*<\/h1>/],
    // 2023-12 起电影条目的 class 变成了 item comment-item，
    // 所以按「class 包含 item」匹配而不是等值匹配
    itemAnchor: /class="item[ "]|class="subject-item"|class="common-item"/,
    // 条目指向作品页，subject id 是稳定的去重键
    idAnchor: /\/subject\/(\d+)\//g,
    // 实测：每一张列表页上都有声明数量，不只入口页——可以逐页复读，
    // 从而发现抓取过程中总数发生了变化
    claimedCount: /<h1>\s*([^<]*?)\((\d+)\)\s*<\/h1>/,
  },
};

/**
 * 按路线 key 找判定描述。
 *
 * 路线 key 形如 `interest.movie.collect`，而判定描述是按**族**组织的
 * （`interest.list`）——同一族的页面结构相同，没必要为每个 medium/status
 * 各写一份。
 *
 * @param {string} routeKey
 * @returns {RouteProfile | null}
 */
export function profileForRoute(routeKey) {
  if (ROUTE_PROFILES[routeKey]) return ROUTE_PROFILES[routeKey];
  if (routeKey.startsWith('interest.') && routeKey !== 'interest.item') {
    return ROUTE_PROFILES['interest.list'];
  }
  return null;
}

/**
 * 抽出本页所有条目 ID，供跨页去重与停滞检测。
 *
 * 这属于「为了推进抓取而必须做的结构抽取」——只进 frontier，不构成 bundle
 * 的数据模型。语义解析仍然是 parser 的事。
 *
 * @param {string} bodyText
 * @param {RouteProfile} route
 * @returns {string[]}
 */
export function extractItemIds(bodyText, route) {
  if (!route?.idAnchor) return [];
  const re = new RegExp(route.idAnchor.source, 'g');
  /** @type {string[]} */
  const out = [];
  let m;
  while ((m = re.exec(bodyText)) !== null) out.push(m[1]);
  return out;
}

/**
 * 读出页面声称的条目数量。
 *
 * **它不是完整性判据**——豆瓣的计数有时统计于审查之前、有时之后。记它是因为
 * 事后不可恢复，且差值有取证价值。
 *
 * @param {string} bodyText
 * @param {RouteProfile} route
 * @returns {{count: number, raw: string} | null}
 */
export function extractClaimedCount(bodyText, route) {
  if (!route?.claimedCount) return null;
  const m = route.claimedCount.exec(bodyText);
  if (!m) return null;
  return { count: Number(m[2]), raw: m[0] };
}
