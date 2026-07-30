/**
 * 合成夹具：按真实旧档案里观察到的结构手工构造，**不含任何真人数据**。
 *
 * 真实档案是用户的个人数据（真实用户名、社交关系、观影记录、他人身份），
 * 不能进公开仓库。所以公开测试用合成夹具，只保留**结构**——标题格式、
 * 导航栏标志、条目容器的 class、风控文案。
 *
 * 每个夹具都标注了它对应真实档案里的哪一类页面，以及那类页面的实测体积，
 * 这样将来有人怀疑夹具失真时，知道该去核对什么。
 */

/**
 * 已登录的全局导航。
 *
 * `_GLOBAL_NAV.USER_ID` 这一段是**必须**的：数字 uid 就取自那里，而不是从广播
 * 条目的 `data-uid`。原因见 src/crawl/session.js 里 UID_PATTERNS 的说明——
 * 简版：`data-uid` 在作品详情页上是**评论者**的 ID，拿它当身份会让抓取在第一张
 * 详情页上误判「账号被换掉」然后停机。
 *
 * 早先的夹具只有 `data-uid`，那让整套测试对着一个真实页面上并不成立的假设跑。
 * 这里按 test/fixtures/profile-2026-07.html 的真实结构写。
 */
/**
 * 已登录的全局导航，按真实页面的结构写。
 *
 * `_GLOBAL_NAV.USER_ID` 那一段是**必须**的：数字 uid 就取自那里，而不是广播条目
 * 的 `data-uid`。原因见 src/crawl/session.js 里 UID_PATTERNS 的说明——简版：
 * `data-uid` 在作品详情页上是**评论者**的 ID，拿它当身份会让抓取在第一张详情页上
 * 误判「账号被换掉」然后停机。
 *
 * 早先的夹具只有 `data-uid`，于是整套测试对着一个在真实页面上并不成立的假设跑。
 * 校准依据：test/fixtures/profile-2026-07.html。
 */
const NAV_LOGGED_IN = `<div class="top-nav-info">
  <ul><li class="nav-user-account">
    <a href="https://accounts.douban.com/passport/setting/" class="bn-more"><span>示例用户的账号</span></a>
    <div class="more-items"><table><tbody>
      <tr><td><a href="https://www.douban.com/mine/">个人主页</a></td></tr>
      <tr><td><a href="https://www.douban.com/accounts/logout?source=main&ck=XXXX">退出</a></td></tr>
    </tbody></table></div>
  </li></ul>
</div>
<div class="global-nav-items"><ul>
  <li class="on"><a href="https://www.douban.com" data-moreurl-dict="{&quot;from&quot;:&quot;top-nav-click-main&quot;,&quot;uid&quot;:&quot;82160871&quot;}">豆瓣</a></li>
</ul></div>
<script>
  ;window._GLOBAL_NAV = {
    USER_ID: "82160871",
    UPLOAD_AUTH_TOKEN: "82160871:0000000000000000000000000000000000000000",
    DOUBAN_URL: "https://www.douban.com"
  };
</script>`;

/**
 * 把一张已登录页面改成「未登录但页面上有数据」的样子。
 *
 * 这是真实档案里最阴的一种：151 个页面就是这样——结构完整、条目是真的，只有
 * 导航栏露了馅。当成账号数据就是把公开视图（没有私密条目）冒充成完整列表。
 *
 * @param {string} html
 */
export function anonymizeWithLoginPrompt(html) {
  return `${stripLoginMarkers(html)}
<div id="db-global-nav"><a href="https://accounts.douban.com/passport/login" class="nav-login">登录/注册</a></div>`;
}

/**
 * 把一张已登录页面改成「会话在某个环节掉了」的样子。
 *
 * 集中在这里，而不是让每个测试自己写正则去抠夹具内部结构——那样夹具一改，测试
 * 会**静默地不再测它想测的东西**（strip 匹配不到，页面依旧是登录态，于是断言
 * 「应当判 login」的测试拿到了 ok）。这件事真的发生过。
 *
 * @param {string} html
 */
export function stripLoginMarkers(html) {
  return html
    .replace(/<div class="top-nav-info">[\s\S]*?<\/div>\s*<\/div>/, '')
    .replace(/<li class="nav-user-account">[\s\S]*?<\/li>/, '')
    .replace(/<script>[\s\S]*?_GLOBAL_NAV[\s\S]*?<\/script>/, '')
    .replace(/https:\/\/www\.douban\.com\/accounts\/logout[^"]*/g, '#')
    .replace(/\/accounts\/logout/g, '#');
}

/** @param {string} title @param {string} body @param {boolean} loggedIn */
function page(title, body, loggedIn = true) {
  return `<!DOCTYPE html>
<html lang="zh-CN" class="ua-windows ua-webkit">
<head><meta charset="utf-8"><title>
    ${title}
</title></head>
<body>
<div id="db-global-nav">${loggedIn ? NAV_LOGGED_IN : '<a href="/accounts/login">登录</a>'}</div>
${body}
</body></html>`;
}

/**
 * 个人页头。真实的广播页上一定有它——而它正是把广播时间线与**首页信息流**区分开
 * 的那个标志（后者同样有 `stream-items`）。
 *
 * 分类器改用结构性标志之后（不再看标题里的字，因为豆瓣把「我的广播」改成了
 * 「我的动态」），夹具也得照真实结构写。
 */
const PROFILE_HEADER = `<div id="db-usr-profile" class="clearfix">
  <div class="pic"><a href="https://www.douban.com/people/example/"><img src="https://img3.doubanio.com/icon/up82160871-12.jpg"></a></div>
  <div class="info"><h1>示例用户</h1></div>
</div>`;

/** @param {number} n */
function statusItems(n) {
  let out = PROFILE_HEADER + '<div class="stream-items">';
  for (let i = 0; i < n; i++) {
    out += `
    <div class="new-status status-wrapper" data-sid="${4600000000 + i}" data-uid="82160871">
      <div class="status-item" data-sid="${4600000000 + i}" data-uid="82160871"
           data-action="1" data-target-type="movie" data-object-kind="1002" data-object-id="${30000000 + i}">
        <span class="created_at" title="2026-07-2${i % 10} 12:34:0${i % 10}">7月2${i % 10}日</span>
        <div class="others"><div class="comments"><div class="comments-items"></div></div></div>
      </div>
    </div>`;
  }
  return out + '</div>';
}

export const fixtures = {
  /** 正常的广播列表页。真实档案里这类页面中位数约 98 KB。 */
  // 标题按 2026 实测写成「我的动态」——豆瓣把它从「我的广播」改过了，而分类器
  // 现在根本不看标题（见 classifier.js 的 frameAnchors 说明）。夹具照实写，是为了
  // 让「改名不影响判定」这件事在测试里真的被覆盖到。
  broadcastPage: page('我的动态', statusItems(20)),

  /**
   * 越界终止页：翻过了最后一页。
   *
   * **条目数为 0，但页面是完全正常的。** 真实档案里是 19240 字节，
   * 标题与用户导航都在。路线逻辑据此判断「这条线走完了」，而分类器必须
   * 判它为 ok——判成故障会让正常的翻页终点变成一次误报。
   */
  // 真实的越界终止页只是 `stream-items` **空着**，页面框架照旧完整——所以它仍然
  // 会被判成 ok。用条目数判定会把正常的翻页终点当成故障。
  broadcastEmptyPage: page('我的动态', `${PROFILE_HEADER}<div class="stream-items"></div>`),

  /**
   * 会话过期的登录页。
   *
   * 真实档案里出现过两个，被前代工具按数据文件名写进了磁盘，没有任何标记。
   * 它同样是 0 条目、HTTP 200，与上面那个终止页在「条目数」这个维度上
   * 完全一样——这正是必须靠页面框架而非条目数判定的原因。
   */
  loginPage: `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>
    登录豆瓣
</title></head>
<body>
  <div class="account-body">
    <form><input name="username"><input name="password">
    <div class="captcha-block">请输入验证码</div></form>
  </div>
</body></html>`,

  /** 风控拦截页。跳转到 sec.douban.com 之后看到的东西。 */
  securityChallengePage: `<!DOCTYPE html>
<html><head><title>豆瓣</title></head>
<body><p>有异常请求，请输入验证码后继续</p><img src="/captcha?id=xxx"></body></html>`,

  /** 无验证码的纯封锁页。 */
  blockedPage: `<!DOCTYPE html>
<html><head><title>豆瓣</title></head>
<body><p>访问过于频繁，请稍后再试</p></body></html>`,

  /** 用户/条目不存在。真实档案里前代靠「页面不存在」这个字符串识别。 */
  notFoundPage: page('豆瓣', '<div class="article"><h1>页面不存在</h1></div>'),

  /** 标记列表页，标题里带声明数量。 */
  interestListPage: page(
    '我看过的影视(1157)',
    '<h1>我看过的影视(1157)</h1><div class="grid-view">' +
      '<div class="item comment-item"><div class="info">条目一</div></div>'.repeat(15) +
      '</div>',
  ),

  /**
   * 2023-01 之前的旧版电影列表页：条目 class 是 `item` 而不是
   * `item comment-item`。真实档案里两年之内就漂移过一次，锚点必须能同时命中。
   */
  interestListPageOldMarkup: page(
    '我看过的电影(978)',
    '<h1>我看过的电影(978)</h1><div class="grid-view">' +
      '<div class="item"><div class="info">条目一</div></div>'.repeat(15) +
      '</div>',
  ),

  /** 结构上完全不像目标路线的页面（比如被跳到了首页）。 */
  unrelatedPage: page('豆瓣', '<div class="anonymous-nav">首页内容</div>'),
};
