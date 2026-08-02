/**
 * 给图片请求补上 `Referer`。
 *
 * ## 为什么需要
 *
 * 豆瓣的图片域名有**防盗链**：不带 `Referer` 去取一张封面，拿回来的是
 *
 *     HTTP 418 I'm a teapot
 *     content-type: image/jpeg
 *     content-length: 13
 *
 * 13 个字节，还标着 `image/jpeg`。实测确认过：直接在浏览器地址栏打开同一个
 * 图片 URL（那样也不带 Referer）得到的是一模一样的 418。
 *
 * 也就是说，**没有 Referer 就一张图都取不到**。而档案里没有图，就是「备份必须
 * 联网才能看」——这个项目要否定的正是这件事。
 *
 * ## 为什么不能直接在 fetch 里设
 *
 * `Referer` 是 fetch 的**禁改头**，代码里设了也会被丢掉。唯一的途径是
 * `declarativeNetRequest` 的 `modifyHeaders`。
 *
 * `transport.js` 一直按「发一个 `X-Override-Referer`，由 DNR 规则改写成
 * `Referer`」来写，注释也这么说——**但 manifest 里从来没有过 declarativeNetRequest
 * 权限，也从来没有过规则文件**。整套机制自始至终是空的：每一个请求都不带 Referer
 * 发出去，而在此之前抓的全是 douban.com 的页面（不查防盗链），所以一直没暴露。
 * 抓图片是第一次踩到。
 *
 * ## 为什么是一条静态规则，而不是每个请求一条
 *
 * DNR 规则里的头部值是**静态**的，没法把 `X-Override-Referer` 的值搬到 `Referer`
 * 上去。要做到「每张图带上它所在的那个作品页」，就得在每次请求前后各调一次
 * `updateSessionRules`——2900 张图就是 5800 次调用，还得靠闸门保证并发恒为 1
 * 才不会串。
 *
 * 而防盗链检查的是**来源站点**，不是具体哪一页。所以一条静态规则就够：所有
 * 发往豆瓣图片域的请求都带上 `https://www.douban.com/`。这不是伪造——那些图片
 * 本来就是从豆瓣页面上引用的，我们也确实是从豆瓣页面上读到这些 URL 的。
 *
 * ## 只改我们自己发的请求
 *
 * `tabIds: [-1]` 把规则限定在**不属于任何标签页**的请求上，也就是扩展自己发的。
 * 用户正常浏览豆瓣时的图片请求不受影响——改用户自己的流量是越界的，而且会让
 * 「这个扩展做了什么」变得不可预测。
 *
 * 这也是用会话规则（`updateSessionRules`）而不是静态规则文件的原因：`tabIds`
 * 只有会话规则支持。
 */

/** 规则 ID。固定值，方便每次启动时先删后加，避免重复堆积。 */
export const REFERER_RULE_ID = 1;

/** 图片域。与 manifest 的 host_permissions 一致。 */
export const IMAGE_HOST_FILTER = '||doubanio.com';

/** 补上的 Referer。见文件开头：防盗链看的是站点，不是具体页面。 */
export const REFERER_VALUE = 'https://www.douban.com/';

/**
 * 规则本身。单独导出，便于在 Node 里断言它的形状——这套规则装不上或者装错了，
 * 症状是「一张图都抓不到」，而那个症状看起来完全不像权限或规则的问题。
 */
export function refererRule() {
  return {
    id: REFERER_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Referer', operation: 'set', value: REFERER_VALUE },
        // 顺手把内部标记头去掉。它对豆瓣毫无意义，而发一个非标准头出去等于
        // 主动给自己贴一个「我不是浏览器」的标签——与「不伪造身份、也不留
        // 多余指纹」是同一条原则。
        { header: 'X-Override-Referer', operation: 'remove' },
      ],
    },
    condition: {
      urlFilter: IMAGE_HOST_FILTER,
      resourceTypes: ['xmlhttprequest'],
      // 只管扩展自己发的请求，不碰用户在标签页里的正常浏览。
      tabIds: [-1],
    },
  };
}

/**
 * 装上规则。**每次 service worker 启动都要调**——会话规则活不过浏览器重启，
 * 而 service worker 本来就会被反复叫醒，正好是个合适的挂载点。
 *
 * 失败不抛：装不上的后果是图片抓不到（会被判成 blocked 并停下来等人），而不是
 * 整个扩展起不来。但**必须报出来**——否则用户会对着一堆 418 完全摸不着头脑。
 *
 * @param {object} [deps]
 * @param {any} [deps.dnr]  注入 chrome.declarativeNetRequest，测试用
 * @param {(msg: string, err?: unknown) => void} [deps.onError]
 * @returns {Promise<boolean>} 装上了没有
 */
export async function installRefererRule({ dnr, onError } = {}) {
  const api = dnr ?? globalThis.chrome?.declarativeNetRequest;
  if (!api?.updateSessionRules) {
    onError?.(
      '浏览器没有提供 declarativeNetRequest.updateSessionRules，无法为图片请求补上 Referer。' +
        '豆瓣图片域有防盗链，没有 Referer 会一律返回 418，封面图将一张都抓不到。',
    );
    return false;
  }
  try {
    await api.updateSessionRules({
      // 先删后加：service worker 会被反复叫醒，不先删会撞「规则 ID 已存在」。
      removeRuleIds: [REFERER_RULE_ID],
      addRules: [refererRule()],
    });
    return true;
  } catch (err) {
    onError?.('为图片请求补 Referer 的规则没装上，封面图会全部返回 418。', err);
    return false;
  }
}
