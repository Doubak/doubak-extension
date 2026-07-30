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

  // ── 6a. 最终 URL 还是不是这条路线
  //
  // 放在框架检查之前，因为它**不依赖任何 markup**，因此也不会被改版影响。
  // 它挡的是「被跳走了」：首页信息流同样有 `stream-items`，单看 markup 会认错。
  if (route.urlAnchor && !route.urlAnchor.test(finalUrl)) {
    reasons.push(`最终 URL 不像这条路线：${finalUrl}`);
    return { verdict: null, reasons, itemCount };
  }
  if (route.urlAnchor) reasons.push('最终 URL 仍是这条路线');

  // ── 6b. 页面框架必须齐全
  //
  // 这是区分「越界终止页」与「出了别的问题」的关键：终止页条目数为 0，
  // 但框架是完整的。用条目数判定会把正常的翻页终点当成故障。
  //
  // 走到这里 URL 已经对了、登录状态也在，所以框架标志缺失基本只有一个含义：
  // **豆瓣改版了**。判 null（安全），并在原因里说清缺的是哪一个。
  const missing = route.frameAnchors.filter((re) => !re.test(bodyText));
  if (missing.length > 0) {
    // **把缺的是什么说出来。** 只说「缺少 1 个」的话，事后只能对着一份 100 KB 的
    // HTML 猜是哪一个不匹配了——而豆瓣改版正是这条路径最常见的触发原因，那时候
    // 需要的恰好是「哪个标志没了」。
    reasons.push(
      `缺少 ${missing.length} 个页面框架标志（${missing.map((re) => re.source).join('、')}）——` +
        'URL 与登录状态都正常，所以最可能是豆瓣改版了。这一页已如实存进档案，' +
        '可据此重新校准标志，不必重抓。',
    );
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
    /**
     * 最终 URL 必须还是这条路线。**这是最强的一条，因为它不依赖任何 markup。**
     *
     * 豆瓣改不动它：我们请求 `/people/<user>/statuses`，跟完跳转之后还在那儿，
     * 那这就是那一页。改版能改标题、能改 class，改不了「你请求的资源是什么」。
     *
     * 它挡的是另一类事：被跳到首页、被跳到登录页、被跳到 `sec.douban.com`。
     * 那些情况下页面里可能照样有 `stream-items`（首页信息流就有），单看 markup
     * 会认错。
     */
    urlAnchor: /\/people\/[^/]+\/statuses(\?|$)/,

    /**
     * 框架标志按**结构**来认，不按标题里的字。
     *
     * 原来用的是 `<title>…广播</title>`。它在 2022 年的真实档案上是对的
     * （标题就是「我的广播」），但豆瓣在那之后把它**改成了「我的动态」**——于是
     * 2026 年真跑第一页就判不出来，一条都没抓到。
     *
     * 教训不是「把新标题也加上」，而是**别拿显示文字当结构标志**：标题会改名、
     * 会本地化、会做 A/B。而这两个页面版本的结构一模一样：
     *
     * | | 2022 档案 | 2026 实测 |
     * |---|---|---|
     * | `<title>` | 我的广播 | **我的动态** |
     * | `class="stream-items"` | ✓ | ✓ |
     * | `id="db-usr-profile"` | ✓ | ✓ |
     * | `<div class="status-item"` | ✓ | ✓ |
     *
     * 两个标志一起用，是为了不把**首页信息流**也认成这条路线——那里同样有
     * `stream-items`，但没有 `db-usr-profile`（个人页头）。
     *
     * ## 这两个是拿 403 页真实数据挑出来的
     *
     * 旧档案里 2022-12 → 2024-08 共 403 个广播页：
     *
     * | 标志 | 命中 |
     * |---|---|
     * | `class="stream-items"` | **401 / 403** |
     * | `id="db-usr-profile"` | **401 / 403** |
     * | `<title>…广播` | 401 / 403（而 2026 年归零） |
     *
     * 缺的那 2 个是 15529 字节的登录页——它们**应该**不匹配，而且在走到这一步
     * 之前就已经被登录状态判掉了。
     *
     * 真实的越界终止页（p116，19590 字节）两个标志**都还在**，只是 `stream-items`
     * 里空着。所以它照旧判 ok，而不是被当成故障——这正是「不能用条目数判定」的
     * 那条规则要保住的东西。
     *
     * 也就是说：这两个标志与标题一样稳，但它们**活过了那次改名**。
     */
    frameAnchors: [/class="stream-items"/, /id="db-usr-profile"/],
    itemAnchor: /<div class="status-item"/,
    // 广播条目自带稳定 ID，用于跨页去重与停滞检测
    idAnchor: /data-sid="(\d+)"/g,
    // 声明数量：广播没有可信的总数，故为 null
    claimedCount: null,
    // 每条广播都带完整绝对时间（可见文本才是省略形式）：
    //   <span class="created_at" title="2026-07-26 12:34:00">7月26日</span>
    // 水位线就是从这里取的——不带时区，解析时必须显式记录假定时区。
    timeAnchor: /class="created_at"[^>]*title="([^"]+)"/g,
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
 * 抽出本页所有条目的原始时间字符串。
 *
 * 只做抽取，**不做解析也不做转换**——原始字符串要原样保留，解析与时区假定
 * 交给 core/time.js。豆瓣页面上的时间不带时区，静默转换会让海外时区的用户
 * 得到整体偏移数小时的水位线。
 *
 * @param {string} bodyText
 * @param {RouteProfile} route
 * @returns {string[]} 页面上出现的顺序（豆瓣列表是新→旧，所以第一个最新）
 */
export function extractItemTimes(bodyText, route) {
  if (!route?.timeAnchor) return [];
  const re = new RegExp(route.timeAnchor.source, 'g');
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
