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

const NAV_LOGGED_IN = `
<div class="nav-user-account">
  <a href="https://www.douban.com/people/00000000/" class="bn-more"><span>示例用户</span></a>
</div>`;

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

/** @param {number} n */
function statusItems(n) {
  let out = '<div class="stream-items">';
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
  broadcastPage: page('示例用户的广播', statusItems(20)),

  /**
   * 越界终止页：翻过了最后一页。
   *
   * **条目数为 0，但页面是完全正常的。** 真实档案里是 19240 字节，
   * 标题与用户导航都在。路线逻辑据此判断「这条线走完了」，而分类器必须
   * 判它为 ok——判成故障会让正常的翻页终点变成一次误报。
   */
  broadcastEmptyPage: page('示例用户的广播', '<div class="stream-items"></div>'),

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
