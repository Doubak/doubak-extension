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
 * @property {RegExp} [urlAnchor]      最终 URL 必须匹配。**不依赖 markup，因此不受
 *   改版影响**，是最稳的一条：改版能改标题与 class，改不了「你请求的资源是什么」。
 * @property {RegExp[]} [anyFrameAnchors]  内容区块，**至少中一个**即可。用于
 *   作品详情页：那类页面会合法地缺少区块（豆瓣会关掉某些条目的评分），要求全中会把
 *   好页面判成故障。与 `frameAnchors` 二选一。
 * @property {RegExp[]} [frameAnchors]  页面框架标志。**缺一不可**——它们在，
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

  // ── 0. 空响应不是页面
  //
  // 通用规则，与路线无关。**0 字节的 HTTP 200 不是数据。**
  //
  // 这条来自实测：旧档案里 6341 个作品详情页中有 **7 个是 0 字节**，全在同一天
  // （2023-12-18），被前代工具当数据留在了磁盘上，没有任何标记。而当时的判定逻辑
  // 就是「HTTP 200 即成功」——那正是这里要挡掉的东西。
  //
  // 判 null 而不是某种失败：我们不知道它为什么空（连接断了？被掐了？），
  // 而「判不出来」本来就是这套系统里唯一诚实的答案。
  if (!bodyText || bodyText.length === 0) {
    reasons.push('响应体为空——0 字节的 200 不是页面');
    return { verdict: null, reasons, itemCount };
  }

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
  // 两种语义，按路线选：
  //
  // - `frameAnchors`（**缺一不可**）——用于形态固定的列表页。少一个就说明不是这条
  //   路线的页面。
  // - `anyFrameAnchors`（**至少中一个**）——用于作品详情页。那类页面会合法地缺少
  //   区块（豆瓣会关掉某些条目的评分），要求全中会把好页面判成故障。
  //
  // 两者都能挡住封锁页与错误页：那些页面一个区块都不会有。
  if (route.anyFrameAnchors) {
    const hit = route.anyFrameAnchors.some((re) => re.test(bodyText));
    if (!hit) {
      reasons.push(
        `一个内容区块都没有（试过 ${route.anyFrameAnchors.map((re) => re.source).join('、')}）` +
          '——URL 与登录状态都正常，所以最可能是豆瓣改版了。这一页已如实存进档案，' +
          '可据此重新校准标志，不必重抓。',
      );
      return { verdict: null, reasons, itemCount };
    }
    reasons.push('内容区块存在');
    return finish(reasons, itemCount, bodyText, sizeStats);
  }

  const missing = (route.frameAnchors ?? []).filter((re) => !re.test(bodyText));
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

  return finish(reasons, itemCount, bodyText, sizeStats);
}

/**
 * 判定为 ok 之前的最后两笔记录。两种框架语义（全中 / 任一）共用。
 *
 * ## 7. 体积异常只作为警示，不单独定罪
 *
 * 体积能区分正常页与封锁页（实测：广播正常页中位数约 98 KB，登录页 16 KB；作品详情页
 * 中位数 120 KB，soft404 是 17 KB），但上面的信号已经更直接。这里只在框架齐全却异常小
 * 的时候留个记录，用于事后发现「豆瓣换了新的封锁形态」。
 *
 * @param {string[]} reasons
 * @param {number | null} itemCount
 * @param {string} bodyText
 * @param {{count: number, median: number} | null} sizeStats
 */
function finish(reasons, itemCount, bodyText, sizeStats) {
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
  /**
   * 个人主页与各分类入口页。
   *
   * ## 只认与版式无关的标志
   *
   * **个人主页是用户可自定义的**：有人有「我看过的影视」区块，有人没有；顺序、
   * 显示哪些模块都能改。所以判定绝不能依赖任何分类区块的存在——否则一个把电影
   * 模块关掉的用户，页面明明抓到了，却会被判成故障。
   *
   * 拿一份真实档案的 6 张页面量过（个人主页 + 5 个分类入口，含 `location/people`
   * 那个最不一样的舞台剧入口），下面这些标志**每一张都有**：
   *
   *     _GLOBAL_NAV、USER_ID、db-global-nav、nav-user-account、db-usr-profile
   *
   * 而「我看过的影视」这类区块**只出现在个人主页上**——那正是可自定义的部分。
   *
   * 取 `db-usr-profile`：它是「某人的个人页」这个外壳，装的是头像与用户名，
   * 不是那些可增可减的模块。
   *
   * ## 为什么必须有一份判定描述
   *
   * 没有的话走的是兜底分支——`status === 200` 就算 `ok`。而**豆瓣的封锁页返回的
   * 就是 200**。个人主页又是一次抓取里的第一张页面，于是最该被拦住的那一刻反而
   * 完全没有拦截：封锁页会被存成 `ok`，路线被标成「连续 ✔」，产出一份假的完整性
   * 声明。
   *
   * 判错方向的代价是不对称的：判不出来只是多存一页待复核，判成 ok 是永久的谎。
   */
  'profile.page': {
    urlAnchor: /douban\.com\/(?:location\/)?people\//,
    // 一个就够，但**缺一不可**：这是「这确实是某人的个人页」的证据。
    frameAnchors: [/id="db-usr-profile"/],
    // 没有条目、没有时间、没有声明数量——这几张页面只为身份与存档而抓。
    claimedCount: null,
  },

  /**
   * 作品详情页。**占真实档案九成体积，也是抓取的最后一个阶段。**
   *
   * ## 为什么必须有这份描述
   *
   * 在此之前 `profileForRoute('interest.item')` 返回 `null`，于是判定退回到
   * 「HTTP 200 就是 ok」——而那正是这套系统开篇就否掉的做法（豆瓣用 200 送封锁页）。
   *
   * 后果不对称：这条路线是**数千次请求**，且排在几小时抓取的最后，也就是最可能撞上
   * 限流的时候。一次软封锁会让几千页被标成 `ok` 写进档案，而档案的全部价值就建立在
   * 「标着 ok 的就是真数据」之上。
   *
   * ## 为什么要分变体
   *
   * 因为**没有一个 markup 标志跨得过所有媒介**。拿旧档案 6341 个作品详情页量过：
   *
   * | 标志 | movie | game | music | book | drama |
   * |---|---|---|---|---|---|
   * | `id="interest_sectl"` | ✔ | ✔ | ✔ | ✔ | ✗ |
   * | `id="mainpic"` / `id="info"` | ✔ | ✗ | ✔ | ✔ | ✗ |
   * | `v:itemreviewed` | ✔ | ✗ | ✗ | ✔ | ✗ |
   * | `og:url` | ✔ | ✗ | ✔ | ✔ | ✗ |
   *
   * 而全都命中的那几个（`id="wrapper"`、`id="content"`、`<h1>`）在**每一张**豆瓣页面
   * 上都有，认不出「这是作品详情页」，等于没检查。
   *
   * 舞台剧压根是另一套应用（`/location/drama/`），所以它是自己的变体。
   *
   * ## 命中率是排除掉「已经能判出来的失败」之后测的
   *
   * 第一次测出来是 397/400，差的 3 个是 2 个空文件与 1 个 soft404——它们**本该**不
   * 匹配，而且在走到框架检查之前就已经被判掉了（空响应见 §0，soft404 见文案标志）。
   * 排除之后 movie/game/music/book 合计 **1056 个样本，100% 命中**。
   */
  'interest.item': {
    /**
     * 最终 URL 必须还是某个媒介的作品页。**不依赖 markup，因此不受改版影响**——
     * 改版能改 class，改不了「你请求的资源是什么」。
     *
     * 它挡的是被跳走：跳回首页、跳到登录页、跳到 `sec.douban.com`。
     */
    urlAnchor:
      /(?:movie|book|music)\.douban\.com\/subject\/\d+|www\.douban\.com\/(?:game|app)\/\d+|www\.douban\.com\/location\/drama\/\d+/,

    /**
     * 内容区块 —— **至少中一个**（`anyFrameAnchors`，不是「缺一不可」）。
     *
     * ## 为什么这条路线的语义必须是「任一」
     *
     * 因为**作品页会合法地缺少区块**。实测撞到的那个：
     *
     *     2017年中央电视台春节联欢晚会 —— 88 KB 的正常页面，
     *     有 v:itemreviewed / mainpic / info，但**没有评分控件**
     *     （豆瓣把这个条目的评分关了）
     *
     * 用「缺一不可」的话，这类页面会被判成「认不出来」然后停机——而它完完全全是
     * 一张好页面。对一个专门在意审查痕迹的项目来说，把「评分被关掉」当成故障尤其
     * 荒谬：那正是最该完整存下来的东西。
     *
     * 「任一」仍然足够严：封锁页与错误页**一个区块都不会有**。而 `urlAnchor` 已经
     * 保证了我们在正确的资源上，所以这里只需要回答一个问题——**内容渲染出来了吗**。
     *
     * ## 每个媒介至少被两条标志覆盖（除舞台剧）
     *
     * 拿旧档案 6341 个作品详情页量的（已排除空文件、soft404、未登录页）：
     *
     * | 标志 | movie | book | music | game | drama |
     * |---|---|---|---|---|---|
     * | `id="interest_sectl"` | ✔ | ✔ | ✔ | ✔ | ✗ |
     * | `id="mainpic"` | ✔ | ✔ | ✔ | ✗ | ✗ |
     * | `<div id="info"` | ✔ | ✔ | ✔ | ✗ | ✗ |
     * | `id="comments"` | ✗ | ✗ | ✗ | ✔ | ✗ |
     * | `drama-info` | ✗ | ✗ | ✗ | ✗ | ✔ |
     *
     * 全部 100%。四个媒介各有至少两条独立标志，所以任一条被改掉都还剩一条。
     *
     * ⚠ **舞台剧只有一条，而且没有校准**：旧档案里 3 个舞台剧详情页**全部**是未登录
     * 状态下抓的，所以手上没有任何一张登录态的样本。`drama-info` 取自那 3 页的内容
     * 区块（内容部分与登录无关，所以大概率成立），但这是全套标志里唯一没有可信样本
     * 的一条。失败方向是安全的（判 null 然后停），且报错会说出缺的是哪个。
     */
    anyFrameAnchors: [
      /id="interest_sectl"/,
      /id="mainpic"/,
      /<div id="info"/,
      /id="comments"/,
      /drama-info/,
    ],

    // 作品详情页没有「条目」概念，也没有分页与声明数量。
    itemAnchor: undefined,
    claimedCount: null,
  },
  'interest.list': {
    // 列表页的标题形如「我看过的影视(1157)」
    frameAnchors: [/<h1>\s*[^<]*\(\d+\)\s*<\/h1>/],
    // 2023-12 起电影条目的 class 变成了 item comment-item，
    // 所以按「class 包含 item」匹配而不是等值匹配
    itemAnchor: /class="item[ "]|class="subject-item"|class="common-item"/,
    /**
     * 条目指向作品页，作品 id 是稳定的去重键。
     *
     * **必须覆盖全部媒介的 URL 形态。** 原来只写 `/subject/(\d+)/`——那漏掉了游戏
     * （`/game/N`）、应用（`/app/N`）与舞台剧（`/location/drama/N`）。
     *
     * 漏掉的后果远不止「进度显示 0」：
     *
     * | 依赖 id 的东西 | 抽不到 id 时 |
     * |---|---|
     * | 跨页去重 | 失效 |
     * | **停滞检测** | **失效——而它是翻页的终止条件** |
     * | `captured_count` | 恒为 0，coverage 差值恒等于 −claimed |
     *
     * 最严重的是停滞检测：它靠「本页有没有新 id」判断有没有进展。抽不到 id 就等于
     * 每页都「没有进展」，于是**第 3 页就停**——然后因为没有缺口，`contiguous` 报
     * true。实测过一次真实的舞台剧抓取：3 条全抓到了，但 coverage 写着
     * 「声称 3 / 抓到 0 / 差值 −3 / 连续性 ✔ 已验证」。
     *
     * 对 89 页的电影列表，那就是**第 3 页截断 + 声称已验证**。
     */
    idAnchor:
      /(?:\/subject\/|douban\.com\/(?:game|app)\/|\/location\/drama\/)(\d+)/g,
    /**
     * 每条的标记日期，形如 `<span class="date">2025-05-05</span>`。
     *
     * 原来这条路线**根本没有 timeAnchor**，于是水位线永远是 null、`canAdvance` 永远
     * 是 false——增量抓取对标记列表压根不可能，每次都得从头重走。
     *
     * 注意它只有日期没有时刻：那不是页面截断，是豆瓣本来就只公开到天。
     * `parseDoubanTimestamp` 会补零点并把 `precision` 标成 `'day'`，而 `raw` 保留原样。
     */
    timeAnchor: /class="date"[^>]*>\s*([\d-]{8,10})\s*</g,
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
  // 个人主页与各分类入口页共用一份。见 `profile.page` 上的说明。
  if (routeKey === 'profile.overview' || routeKey.startsWith('profile.category_entry.')) {
    return ROUTE_PROFILES['profile.page'];
  }
  return null;
}

/**
 * 各媒介作品详情页的绝对 URL。
 *
 * 每个媒介的路径都不一样，所以只能列举：
 *
 *     movie/book/music → https://<m>.douban.com/subject/<id>/
 *     game/app         → https://www.douban.com/<kind>/<id>/
 *     drama            → https://www.douban.com/location/drama/<id>/
 */
const SUBJECT_LINK =
  /https?:\/\/(?:movie|book|music)\.douban\.com\/subject\/\d+\/?|https?:\/\/www\.douban\.com\/(?:game|app)\/\d+\/?|https?:\/\/www\.douban\.com\/location\/drama\/\d+\/?/g;

/**
 * 从标记列表页抽出作品详情页的 URL。
 *
 * ## 为什么整页扫而不是先框定条目区域
 *
 * 因为实测证明整页扫是准的，而且**比数条目更准**。拿旧档案 400 个标记列表页量过：
 * 抽出 5805 条链接，每页的唯一链接数与该页槽位数一致。有 108 个页面「链接数 ≠ 条目数」
 * ——全是游戏列表页，那里 `class="item"` 这个条目选择器多算了 2 个，而链接数始终是 15。
 *
 * 也就是说列表页上**没有游离的作品链接**（没有「喜欢这部电影的人也喜欢」那类推荐区）。
 * 一旦哪天有了，这个函数会开始多抽——那时候去重会兜住一部分，但真正的防线是
 * `interest.item` 自己的 `urlAnchor` 与判定：抓到不该抓的页面也会被如实记录，
 * 而不是静默混进档案。
 *
 * @param {string} html
 * @returns {string[]} 去重后的绝对 URL
 */
export function extractSubjectLinks(html) {
  if (typeof html !== 'string') return [];
  SUBJECT_LINK.lastIndex = 0;
  return [...new Set(html.match(SUBJECT_LINK) ?? [])];
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
  const seen = new Set();
  let m;
  while ((m = re.exec(bodyText)) !== null) {
    // **按首次出现去重。**
    //
    // 同一个条目在页面上会出现多次：舞台剧列表里每部剧有图片链接与标题链接两处，
    // 真实页面上 3 部剧抽出 6 个 id。
    //
    // 不去重的后果不是「数多了」——停滞检测用 Set，计数本来就不受影响。真正坏掉的是
    // **与时间的配对**：`observePage` 把 `ids[i]` 和 `times[i]` 当成同一条目，
    // 而 3 个时间对上 6 个 id，`highWaterIds` 就记成了别的条目。那份 id 清单是下次
    // 增量在水位线边界上去重用的，记错会导致边界上重抓或漏抓。
    //
    // 同一张列表页上两个不同条目不可能共用一个作品 id（不能把同一部电影标记两次），
    // 广播的 `data-sid` 也是每条唯一，所以页内去重是安全的。
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
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
