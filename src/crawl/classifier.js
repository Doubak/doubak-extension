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
 * 豆瓣拒绝请求时用的状态码。
 *
 * `418 I'm a teapot` 本是一个愚人节笑话（RFC 2324），豆瓣把它当成「我不想理你」
 * 来用——这是它多年来的既定做法，广为人知。
 *
 * ## 为什么必须专门认出它
 *
 * 实测：抓封面图时连续收到 **123 个 418**，而 418 不在任何一条判定分支里，于是
 * 一路走到「判不出来」——记一次失败，然后**若无其事地去抓下一张**。也就是说
 * 豆瓣说了 123 次「不」，我们一次都没听懂，还打算再说 2900 次。
 *
 * 这正是 CLAUDE.md 里那句话描述的情形：**在软封锁上重试，是把限流升级成封号的
 * 标准路径**。判成 `blocked` 之后走的是「停下来等人 + 降速」，那才是对的反应。
 *
 * 响应体是 13 字节、还标着 `content-type: image/jpeg`——所以光看 Content-Type
 * 也认不出来，必须看状态码。
 */
const TEAPOT = 418;
const TEAPOT_REASON =
  'HTTP 418——豆瓣用这个状态码表示拒绝服务（防盗链或反爬）。' +
  '这不是「判不出来」，是明确的拒绝，继续请求只会让情况更糟。';

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
  if (status === TEAPOT) {
    reasons.push(TEAPOT_REASON);
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
  /**
   * 日记列表 `www.douban.com/people/<user>/notes`。
   *
   * 全部锚点都是对着一份真实页面量出来的，不是照别的路线套的。三处与标记列表不同：
   *
   * **① 没有声明数量。** 标题就是 `<h1>我的日记</h1>`，没有 `(N)`——整页找不出第二个
   * 带数字的括号。所以 `claimedCount: null`：这条路线的完整性**只能**靠连续性证明，
   * 没有第二个信号可以对账。（评论列表有，是 `<h1>我的评论(2)</h1>`。）
   *
   * **② 页面上有别人的日记。** 侧栏「最近回应过的日记」列着 6 篇他人的，藏在
   * `link2/?url=…` 里做了百分号编码。今天扫 `/note/(\d+)/` 恰好碰不到它们——但那是
   * **运气**，不是设计。所以 `idAnchor` 锚在 `note-title` 上，且不允许跨过 `<a>` 标签
   * （`[^>]*` 里不含 `>`），只认条目自己的那个链接。
   *
   * 这与 `extractSubjectLinks` 的「整页扫更准」是相反的结论，而两边都对：那边实测
   * 400 页没有游离链接，这边实测一页就有 6 条。判据是量出来的，不是选定的风格。
   *
   * **③ 时间是完整时刻。** `2025-04-14 18:47:50`，不像标记列表只有日期。
   */
  'note.list': {
    urlAnchor: /\/people\/[^/]+\/notes/,
    frameAnchors: [/<h1>\s*我的日记\s*<\/h1>/, /class="note-list"/],
    itemAnchor: /class="note-item"/,
    idAnchor: /class="note-title"[^>]*>\s*<a[^>]*href="https:\/\/www\.douban\.com\/note\/(\d+)\//g,
    timeAnchor: /class="note-date">\s*([\d-]{10}[^<]*)/g,
    claimedCount: null,
    // 正文页的 URL **原样取自页面**，不拿 id 拼。见 `extractDetailLinks`。
    detailLink: /class="note-title"[^>]*>\s*<a[^>]*href="(https:\/\/[^"]*\/note\/\d+\/?)"/g,
  },
  /**
   * 评论（影评/书评/游戏评论）列表 `www.douban.com/people/<user>/reviews`。
   *
   * 比日记干净：整页只有本人一个 `people/` 链接，没有任何第三方板块，而且**条目 id
   * 就在容器上**（`<div class="main review-item" id="8381069">`），不需要开窗口去找。
   *
   * 有声明数量，形式与标记列表一致（`<h1>我的评论(2)</h1>`），所以复用同一个模式。
   */
  'review.list': {
    urlAnchor: /\/people\/[^/]+\/reviews/,
    frameAnchors: [/<h1>\s*[^<]*\(\d+\)\s*<\/h1>/, /class="review-list/],
    itemAnchor: /class="main review-item"/,
    idAnchor: /class="main review-item" id="(\d+)"/g,
    timeAnchor: /class="main-meta">\s*([\d-]{10}[^<]*)/g,
    claimedCount: /<h1>\s*([^<]*?)\((\d+)\)\s*<\/h1>/,
    detailLink: /<h2><a href="(https:\/\/[^"]*\/review\/\d+\/?)"/g,
  },
  /**
   * 日记正文页 `www.douban.com/note/<id>/`。
   *
   * 列表页上的 `note-body` 是**截断的摘要**（真实页面上以 `number=xxx...` 结尾），
   * 全文只在这里。所以长文这一档不接上正文页等于没做。
   *
   * ## 页面上没有任何第三方内容
   *
   * 量过：`<div id="comments" class="comment-list"></div>` 是**空的**——回应由前端
   * 调 Rexxar 接口在渲染时拉，不在 HTML 里。整页唯一的 `people/` 链接是作者本人。
   *
   * 这和广播列表页是同一个结论（CLAUDE.md 里「他人回应」那一条），所以抓正文页
   * 不会顺手把别人的话存进档案。这一点必须是**量出来的**而不是假设的，因为它决定了
   * 发布到 GitHub Pages 时要不要过滤。
   *
   * ## 用 anyFrameAnchors 而不是 frameAnchors
   *
   * 与作品详情页同理：手上只有一份真实样本，而豆瓣对不同形态的日记很可能有不同模板。
   * 要求全中会把好页面判成故障；这三个标志封锁页与错误页一个都不会有，够用了。
   */
  'note.item': {
    urlAnchor: /\/note\/\d+/,
    anyFrameAnchors: [/class="note-container"/, /id="note-\d+"/, /class="note-header/],
    itemAnchor: undefined,
    claimedCount: null,
  },
  /**
   * 评论正文页 `www.douban.com/review/<id>/`。
   *
   * 同样量过：`#comments` 是空的，整页唯一的 `people/` 链接是作者本人。
   *
   * `anyFrameAnchors` 在这条上尤其必要——手上两条样本**都是游戏评论**，而影评与书评
   * 多半是另一套模板（连 host 都可能是 `movie.douban.com`）。所以 `urlAnchor` 只认
   * 路径不认 host，框架标志也只要求中一个。
   */
  'review.item': {
    urlAnchor: /\/review\/\d+/,
    anyFrameAnchors: [
      /class="review-content/,
      /id="review-\d+-content"/,
      /class="main-bd"/,
    ],
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
    /**
     * 每条的标记日期。
     *
     * **日期后面可能还跟着状态词**，所以不能要求它紧接着 `</span>`：
     *
     *     电影/游戏/音乐   <span class="date">2024-02-18</span>
     *     书              <span class="date">2024-02-18\n      读过</span>
     *
     * 原来的模式写的是 `([\d-]{8,10})\s*<`，那个末尾的 `<` 让**三条书的路线一条
     * 时间都抽不到**——`已回溯到` 永远是空的，`high_water_time` 永远是 null，
     * `advanced` 永远是 false，于是**书从来就没能增量过**，每次都全量重走。
     *
     * 拿一份真实档案的 14 条标记列表逐条量过：去掉那个 `<` 之后，书 0→15 条，
     * 其余各路线一条不多一条不少。
     */
    timeAnchor: /class="date"[^>]*>\s*([\d-]{8,10})/g,
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
  return [...new Set(stripUserComments(html).match(SUBJECT_LINK) ?? [])];
}

/**
 * 用户自己写的短评正文——**扫作品链接之前必须先抹掉这一段**。
 *
 * 上面那段注释说「一旦哪天列表页上出现游离的作品链接，这个函数会开始多抽」。它出现
 * 了，而且来源不是推荐区，是用户自己：
 *
 *     《在这世界的角落》（书 27141473）  想读  2026-07-31
 *        短评：为什么电影条目被删了？？？https://movie.douban.com/subject/11611021/
 *
 * 于是读书「想读」列表第 1 页上抽出 16 条链接、只有 15 个槽位，那条**电影** URL 被
 * 当成一个待抓的作品排进了队列。后果有两层：
 *
 * | | |
 * |---|---|
 * | 每次增量都白跑一次请求 | 那部电影确实被豆瓣删了，恒定 404 |
 * | `coverage` 被污染 | `book.wish` 写成「声称 82 / 抓到 83 / 差 **+1**」 |
 *
 * 第二层更要命：`delta` 是「豆瓣是不是在藏东西」的唯一证据，而这个 +1 是我们自己
 * 数出来的假信号。
 *
 * ## 为什么按 class 抹，而且必须认「独立的 comment」
 *
 * 短评容器各媒介不同，实测三种形态：
 *
 *     书            <p class="comment comment-item" data-cid="…">…</p>
 *     电影/音乐/游戏  <span class="comment">…</span>
 *
 * 而 `comment-item` 在电影与音乐列表上是**条目外壳本身**（`class="item comment-item"`）
 * ——按 `comment-item` 抹会把整个条目连同它的作品链接一起抹掉，那是静默漏抓，比多抽
 * 严重得多。所以判据是「class 列表里有独立的 `comment` 这个词」：`item comment-item`
 * 不含独立的 `comment`，`comment comment-item` 与 `comment` 含。
 *
 * 只抹标签之间的正文，标签本身留着——这个函数的产出只喂给正则扫描，不进档案。
 *
 * @param {string} html
 * @returns {string} 短评正文被清空后的 HTML
 */
function stripUserComments(html) {
  return html.replace(
    /<(p|span)\b[^>]*\bclass="([^"]*)"[^>]*>[\s\S]*?<\/\1>/gi,
    (whole, tag, cls) => (/(?:^|\s)comment(?:\s|$)/.test(cls) ? `<${tag}></${tag}>` : whole),
  );
}

/**
 * 作品详情页上的封面图。
 *
 * ## 只取一张，而且是「主图」那一张
 *
 * 一个作品详情页上有 20~40 个 doubanio 图片 URL：推荐区的其他作品封面、评论者
 * 头像、界面雪碧图。它们要么是别人的东西、要么根本不是内容。**全抓下来是 30 倍
 * 的体积换不到东西**，而其中的头像还是第三方内容——按项目的取舍，别人的头像本来
 * 就在跳过之列。
 *
 * 所以判据是**位置**而不是「长得像不像封面」：
 *
 * | 媒介 | 标记 |
 * |---|---|
 * | 书 / 电影 / 音乐 | `id="mainpic"` 容器里的第一个 `<img>` |
 * | 游戏 | 没有 `#mainpic`，用 `class="pic"` 容器里的第一个 `<img>` |
 *
 * 游戏那条是实测出来的：`www.douban.com/game/N/` 用的是另一套模板。**不能退回到
 * 「页面上第一个 doubanio 图片」**——游戏页上第一个恰好是界面雪碧图
 * （`/f/shire/.../pics/new_menu.gif`），那样每个游戏都会存下一张同样的小图标。
 *
 * ## 抽不到就说抽不到，但要分清是哪一种抽不到
 *
 * 两种情况长得一样、含义完全相反：
 *
 * - **`placeholder`**：豆瓣自己显示的占位图（页面上写着「上传海报图片」）。这个
 *   作品**本来就没有封面**，什么都没坏。实测 2916 个作品详情页里有 7 个是这样。
 * - **`not_found`**：连容器都没找到。这多半意味着**豆瓣改版了**，是要报警的那种。
 *
 * 混成一个「没找到封面」，那 7 条正常情况就会变成天天出现的噪音，而真正的改版
 * 信号会淹死在里面。
 *
 * 无论哪种都**不猜**：猜一张回来会静默地把错误的图片存进档案。
 *
 * @param {string} html
 * @returns {{url: string | null, reason: 'ok' | 'placeholder' | 'not_found'}}
 */
export function extractCoverImage(html) {
  if (typeof html !== 'string') return { url: null, reason: 'not_found' };
  let sawContainer = false;
  for (const container of [/id="mainpic"/, /class="[^"]*\bpic\b[^"]*"/]) {
    const at = container.exec(html);
    if (!at) continue;
    sawContainer = true;
    // 只在容器后面一小段里找，避免跨过容器边界抓到下一块的图。
    const window = html.slice(at.index, at.index + 800);
    const img = /<img[^>]+src="(https:\/\/[^"]+)"/i.exec(window);
    if (!img) continue;
    if (isCatalogImage(img[1])) return { url: img[1], reason: 'ok' };
    // 容器在、图也在，但那张图是豆瓣的静态资源 —— 占位图就长这样。
    if (PLACEHOLDER_IMAGE.test(img[1])) return { url: null, reason: 'placeholder' };
  }
  return { url: null, reason: sawContainer ? 'placeholder' : 'not_found' };
}

/**
 * 从列表页抽出正文页的 URL。
 *
 * ## 为什么取页面上的 href，而不是拿 id 去拼
 *
 * 拼出来的 URL 是我们的猜测，页面上的是豆瓣的事实。这两者今天恰好一样
 * （`https://www.douban.com/note/<id>/`），但评论那条几乎肯定不是：手上两条样本
 * **都是游戏评论**，走 `www.douban.com`；影评的 host 很可能是 `movie.douban.com`。
 * 拼错了会得到一整批 404，而且看起来像「豆瓣把它们都删了」。
 *
 * 与 `extractSubjectLinks` 一样锚在条目容器上，不整页扫——日记列表页的侧栏
 * 「最近回应过的日记」列着别人的日记（实测 6 篇）。
 *
 * @param {string} html
 * @param {RouteProfile | null} profile
 * @returns {string[]} 去重后的绝对 URL，页面出现顺序
 */
export function extractDetailLinks(html, profile) {
  if (typeof html !== 'string' || !profile?.detailLink) return [];
  const re = new RegExp(profile.detailLink.source, 'g');
  /** @type {Set<string>} */
  const out = new Set();
  let m;
  while ((m = re.exec(html)) !== null) out.add(m[1]);
  return [...out];
}

/**
 * 广播里**用户自己上传**的图片。
 *
 * ## 为什么这一条和封面完全不是一回事
 *
 * 封面是目录数据：豆瓣还在就能重抓，归 `catalog-*`，一条 `rm` 就能整批丢掉。
 * 这里这些是**用户自己拍的、自己传的**，删了就没了，归 `assets-*`，属于 CLAUDE.md
 * 里说的「两样神圣的东西」那一类。判据是**谁上传的**，不是长什么样（规范 §6.6.2）。
 *
 * 而广播本身「发布后不可编辑、可静默删除」——图跟着广播一起消失，且删除不留痕迹。
 * 所以这是整份档案里最不可替代的一批字节。
 *
 * ## 它们不在 `<img src>` 里
 *
 * 图由前端 JS 渲染，源数据是一段 `<script>` 里的 JSON 字面量：
 *
 *     var photos = [{"image": {"large": {"url": "…/view/status/l/public/x.jpg",
 *                                        "width": 2146, "height": 722},
 *                              "normal": {"url": "…/view/status/medium/public/x.jpg", …},
 *                              "is_animated": false}}, …];
 *
 * 所以扫 `<img>` 一张都拿不到——这正是 `loop.js` 里那句「需要另一个抽取器」。
 *
 * ## **只要本人的**，转发进来的一概不要
 *
 * 这是这个函数里最要紧的一条。实测 175 张广播页上共 149 个附图条目，其中
 * **30 个属于别人**——转发别人的广播时，那条广播连同附图一起渲染在自己的时间线上。
 *
 * 判据是外层 `status-wrapper` 上的 `data-uid`。转发**不是**嵌套结构：豆瓣把原作者的
 * 广播整个渲染成一个顶层 wrapper，`data-uid` 就是原作者，旁边加一个
 * `<span class="reshared_by">…转发</span>`。所以对着 wrapper 比 uid 是准的。
 *
 * 为什么必须拦住：这些图要进 `assets-*`，而那是「删了就没了、永不丢弃」的那一层。
 * 把别人的照片混进去，既让「assets 里都是本人不可替代的东西」这条判断失效，也和
 * 项目对第三方内容的立场相悖（CLAUDE.md：默认不发布他人内容）。
 *
 * ## 取原件：`raw` 优先，没有才退 `large`
 *
 * 三种附图形态实测同时存在于同一份档案：
 *
 * | 形态 | 出处 | 原件在哪 | 实测（本人的） |
 * |---|---|---|---|
 * | `var photos` JSON，`image.large` | 广播直接附图 | `large`（无 `raw` 字段） | 111 |
 * | `var photos` JSON，`image.raw` 为空串 | 讨论/小组话题附图 | `large`（`raw.url === ""`） | 36 |
 * | `data-raw-src` 属性 | 老版单图广播 | `data-raw-src` | 2 |
 *
 * `normal` / `medium` / `ismall` / `small` 都是同一张图的缩略版，一律不取——存下来
 * 只是把每张图存两遍，而缩略版没有任何原件没有的信息。也**不拿缩略版顶替原件**：
 * 宁可如实报缺，也不静默地把一张缩水的图当成原件存进档案，事后无从分辨。
 *
 * URL 原样保留，包括 `?imageView2/...` 这类尺寸参数——CLAUDE.md：抓取时不做归一化。
 *
 * @param {string} html
 * @param {object} opts
 * @param {string} opts.ownerUserId  档案主人的数字 ID（manifest 里的 `account.user_id`）
 * @returns {{urls: string[], skippedOthers: number, unresolved: number}}
 *   - `skippedOthers`：转发进来的、属于别人的附图个数。正常值不为 0。
 *   - `unresolved`：认出了附图条目却取不到原件 URL 的个数。**非 0 说明豆瓣改了结构**，
 *     必须报出来——静默返回空数组等于宣布「这一页没有图」，那是不可检测的丢失。
 */
export function extractStatusPhotos(html, { ownerUserId }) {
  if (typeof html !== 'string') return { urls: [], skippedOthers: 0, unresolved: 0 };
  if (!ownerUserId) throw new Error('extractStatusPhotos 需要 ownerUserId，否则会把别人的图也存下来');

  /** @type {Set<string>} */
  const urls = new Set();
  let skippedOthers = 0;
  let unresolved = 0;

  for (const { uid, html: chunk } of statusWrappers(html)) {
    const mine = uid === String(ownerUserId);
    const before = urls.size;

    // 新版：一段 `<script>` 里的 JSON 字面量。只截到 `];` 为止——整段 script 后面
    // 还有别的语句，连着一起喂给 JSON.parse 必然失败，而那会把「有图但解析不了」
    // 变成「没有图」。
    for (const m of chunk.matchAll(/var\s+photos\s*=\s*(\[[\s\S]*?\])\s*;/g)) {
      /** @type {any[]} */
      let list;
      try {
        list = JSON.parse(m[1]);
      } catch {
        unresolved += 1;
        continue;
      }
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (!mine) { skippedOthers += 1; continue; }
        const raw = entry?.image?.raw?.url;
        const large = entry?.image?.large?.url;
        const pick = typeof raw === 'string' && raw ? raw : large;
        if (typeof pick === 'string' && isDoubanioImage(pick)) urls.add(pick);
        else unresolved += 1;
      }
    }

    // 老版：原件挂在 `data-raw-src` 上。旁边的 `data-median-src`（`/l/`）与
    // `data-small-src`（`/ismall/`）是缩略版，不要。
    for (const m of chunk.matchAll(/data-raw-src="(https:\/\/[^"]+)"/g)) {
      if (!mine) { skippedOthers += 1; continue; }
      if (isDoubanioImage(m[1])) urls.add(m[1]);
      else unresolved += 1;
    }

    // ── 独立的第二个信号：**这条广播有没有附图容器**
    //
    // 上面两条抽取路径都靠具体写法（`var photos =`、`data-raw-src=`）。豆瓣哪天换了
    // 变量名或改成别的渲染方式，两条都会**一声不吭地返回空**——而「这一页没有图」
    // 和「这一页的图我们不认识了」在数据上完全一样，事后无从分辨。
    //
    // 容器的 class 是另一套标记，不随 JSON 的写法变。实测 175 张广播页上，带容器的
    // wrapper 与抽得到图的 wrapper **都是 33 个，一一对应**，没有一个只有其一。所以
    // 只要容器在而一张都没抽到，就是结构变了，必须报出来。
    if (mine && urls.size === before && PHOTO_CONTAINER.test(chunk)) unresolved += 1;
  }

  return { urls: [...urls], skippedOthers, unresolved };
}

/**
 * 广播附图容器的 class。两种形态各一个：
 *
 *     新版  <div class="pics-wrapper">            里面是 `var photos` 那段 script
 *     老版  <div class="attachments-saying attachments-pic">   里面是 data-raw-src
 */
const PHOTO_CONTAINER = /pics-wrapper|attachments-pic/;

/**
 * 把广播页切成一条条广播，并带上它的 `data-uid`。
 *
 * 切片而不是整页扫，是为了让「这张图是谁的」有个可靠的判据——整页扫的话，本人的图
 * 与转发来的图混在一起，没有任何办法分开。
 *
 * @param {string} html
 * @returns {Array<{uid: string, html: string}>}
 */
function statusWrappers(html) {
  const marks = [...html.matchAll(/<div class="new-status status-wrapper[^"]*"[^>]*>/g)];
  return marks.map((m, i) => ({
    uid: /data-uid="(\d+)"/.exec(m[0])?.[1] ?? '',
    html: html.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : undefined),
  }));
}

/** @param {string} url 是不是一个 doubanio 上的图片 URL（尺寸参数可以带着） */
function isDoubanioImage(url) {
  if (!/^https:\/\/[a-z0-9.]*doubanio\.com\//i.test(url)) return false;
  return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url);
}

/**
 * 「这个作品没有海报」时豆瓣塞进来的那张图。
 *
 * 走 `/cuphead/`（新版界面的静态资源目录），所以 `isCatalogImage` 本来就会挡掉它
 * ——这里只是为了把「没有海报」与「找不到海报」区分开。
 */
const PLACEHOLDER_IMAGE = /\/(cuphead|f)\//i;

/**
 * 这个 URL 值不值得作为目录图片存下来。
 *
 * 挡掉的是界面资源：雪碧图、图标、字体、CSS 里引的东西。它们不是内容，而且每页
 * 都一样——存下来只是把同一张 `new_menu.gif` 复制几千遍。
 *
 * @param {string} url
 */
function isCatalogImage(url) {
  if (!/^https:\/\/[a-z0-9.]*doubanio\.com\//i.test(url)) return false;
  // /f/ 是前端静态资源，/cuphead/ 是新版界面的静态资源，/icon/ 是用户头像。
  if (/\/(f|cuphead)\/|\/icon\//i.test(url)) return false;
  return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url);
}

/**
 * 常见图片格式的开头几个字节。
 *
 * **判内容，不判标签。** 这是这个项目的一贯立场（豆瓣以 HTTP 200 送封锁页，
 * 所以状态码不算数），而 `Content-Type` 同样只是个标签：CDN 把 `.jpg` 标成
 * `application/octet-stream`、或者干脆不给这个头，都是常事。只认标签的话，
 * 一张完好的 JPEG 会被判成「抓不下来」，而它的字节明明就在档案里。
 *
 * @param {Uint8Array} b
 */
function looksLikeImage(b) {
  if (!b || b.length < 12) return false;
  const at = (i) => b[i];
  // JPEG
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return true;
  // PNG
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return true;
  // GIF87a / GIF89a
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return true;
  // RIFF....WEBP
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
      && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return true;
  // BMP
  if (at(0) === 0x42 && at(1) === 0x4d) return true;
  return false;
}

/**
 * 图片响应的判定。
 *
 * ## 为什么不能复用 classifyResponse
 *
 * 那套判定的核心是**结构锚点**——页面里有没有该有的东西。图片没有结构，把一份
 * JPEG 的字节当文本去跑那些正则，得到的判断没有意义。
 *
 * 收窄成规范 §6.6.1 的两条：是图片，且载荷非空。
 *
 * ## 「是图片」按字节认，不只按 Content-Type
 *
 * 第一版只认 `Content-Type: image/*`。那是在**判标签而不是判内容**——正好是这个
 * 项目一贯反对的做法（豆瓣以 200 送封锁页，所以状态码不算数；同理，头也只是头）。
 * CDN 把 `.jpg` 标成 `application/octet-stream`、或者压根不给这个头，都是常事，
 * 而那时候一张完好的 JPEG 会被判成「抓不下来」——字节明明已经在档案里了。
 *
 * 反过来**不放松**的是那条要紧的：拿回来的是 HTML 就绝不算成功。那条防的是
 * 封锁页伪装成图片，与标签宽松与否无关。
 *
 * ## 收到 HTML 是最要紧的那种情况
 *
 * 豆瓣以 HTTP 200 返回封锁页是这个项目反复处理的既有事实，图片请求没有理由被
 * 豁免。请求一张 JPEG 却收到 `text/html`，几乎必然是封锁页或登录页穿着图片 URL
 * 的外衣回来了——**那时候必须走 HTML 那套判定**，否则档案里会多出一堆标着 ok、
 * 内容却是「有异常请求」的「图片」。
 *
 * @param {object} input
 * @param {string} input.finalUrl
 * @param {number} input.status
 * @param {string | null | undefined} input.contentType
 * @param {number} input.byteLength
 * @param {Uint8Array} [input.body]  原始字节。Content-Type 靠不住时按它认
 * @param {string} [input.bodyText]  只在收到 HTML 时用得上
 * @returns {Classification}
 */
export function classifyAsset({ finalUrl, status, contentType, byteLength, body, bodyText = '' }) {
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();

  // 收到网页 → 交给 HTML 那套判定，它认得封锁页与登录页。
  if (ct.startsWith('text/html')) {
    const cls = classifyResponse({
      finalUrl,
      status,
      bodyText,
      route: { frameAnchors: [] },
    });
    return {
      ...cls,
      // 就算 HTML 那套说不出问题，也**不能**判 ok：我们要的是图片，拿回来的是网页。
      verdict: cls.verdict === 'ok' ? null : cls.verdict,
      reasons: [...cls.reasons, '请求图片却收到 text/html'],
    };
  }

  /** @type {string[]} */
  const reasons = [];
  if (status !== 200) {
    // 418 是豆瓣说「不」，不是「判不出来」。判错的代价是继续往墙上撞几千次。
    if (status === TEAPOT) {
      reasons.push(TEAPOT_REASON);
      return { verdict: 'blocked', reasons, itemCount: null };
    }
    reasons.push(`HTTP ${status}`);
    return { verdict: status === 404 ? 'gone' : status === 403 ? 'blocked' : null, reasons, itemCount: null };
  }
  if (byteLength === 0) {
    reasons.push('载荷为零长度——0 字节的 200 不是图片');
    return { verdict: null, reasons, itemCount: null };
  }
  if (!ct.startsWith('image/')) {
    // 标签不说是图片时，问字节。头缺失、或者 CDN 标成 application/octet-stream
    // 都是常事，而那时候把一张完好的 JPEG 判成失败，是在拿标签否定内容。
    if (looksLikeImage(body)) {
      reasons.push(`Content-Type 是 ${ct || '（缺失）'}，但字节是图片——按内容算数`);
      return { verdict: 'ok', reasons, itemCount: null };
    }
    reasons.push(
      `既不是图片的 Content-Type（${ct || '缺失'}），字节开头也不像任何已知图片格式`,
    );
    return { verdict: null, reasons, itemCount: null };
  }
  reasons.push(`${ct}，${byteLength} 字节`);
  return { verdict: 'ok', reasons, itemCount: null };
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
